import { describe, expect, it } from 'vitest'
import {
  CHAT_BODY_MAX_BYTES,
  CHAT_BODY_MAX_CHARS,
  checkChatBody,
  findLink,
  normaliseForLinkScan,
} from '@/lib/chatPolicy'

/**
 * ==========================================================================
 *  LINK YASAGININ ERISIMI OLCULUR, IDDIA EDILMEZ
 * ==========================================================================
 *
 * Bu deponun kaydettigi ariza kiplerinden biri "erisimi olculmemis ozellik".
 * Bir link yasagi tam olarak o sinifa dusmeye elverisli: bir regex yazip
 * "linkleri engelliyor" demek kolaydir, ne engelledigi ve ne engellemedigi
 * ise ancak bir KORPUS uzerinde kosturularak bilinir.
 *
 * Bu dosya UC kume tasir ve ucu de gerekli:
 *   POZITIF  -- engellenmesi gerekenler, hepsi engelleniyor
 *   NEGATIF  -- mesru chat cumleleri, hicbiri engellenmiyor
 *   KACANLAR -- engellenmedigi BILINEN ve KABUL EDILEN bicimler
 *
 * Ucuncu kume en degerlisidir: bir yasagin sinirini yazmak degil,
 * CALISTIRMAK. Bir gun biri o kaciklardan birini kapatirsa test kirilir ve
 * kapatan kisi bu listeyi guncellemek zorunda kalir -- yani sinir hep guncel
 * kalir.
 */

const BLOCKED = [
  'https://evil.example.com',
  'http://evil.com/claim',
  'ipfs://bafybeigd/airdrop',
  'HTTPS://EVIL.COM',
  'hxxps://evil.com',
  'h**ps://evil.com',
  'go to www.evil.com now',
  'claim at evil.com',
  'claim at evil.com/free',
  'evil[.]com',
  'evil(dot)com',
  'evil dot com',
  'evil．com',
  'evil。com',
  't.me/arcpad_airdrop',
  'join t.me/somechannel for alpha',
  'discord.gg/abcdef',
  'bit.ly/3xyz',
  'cutt.ly/abc',
  'free-airdrop.xyz',
  'my-token.finance',
  'presale.click',
  'x.com/someone/status/1',
  'mailto:steal@evil.com',
  'DM me: t.me/scammer',
  'check pump.fun',
  'airdrop.top',
  'nft.store',
  'wallet-connect.app',
  'verify.live',
  'a.tk',
  'claim.ml',
  'chat here → discord.gg/x',
]

/**
 * MESRU CHAT CUMLELERI. Cogu ozellikle SECILDI: noktadan sonra bosluk
 * unutulmus cumleler, ondalik sayilar, adresler ve kisaltmalar -- yani genel
 * bir `\.[a-z]{2,}` deseninin YANLIS POZITIF verecegi tam yerler.
 */
const ALLOWED = [
  'gm',
  'lfg 🚀',
  'this is going to 100x',
  'i bought 3.5 usdc worth',
  'price is 0.000042 per token',
  'my address is 0x1bd93613a7BC470a739D9615cdc65e535d958fab',
  'curve is at 25.3% of graduation',
  'sold half.it was a good exit',
  'nice.me too',
  'yes.at last',
  'ok.in a minute',
  'i sold.to be fair it was early',
  'wow.is this real',
  'e.g. a bonding curve',
  'i.e. the reserves',
  'etc. and so on',
  'the dev is based',
  'who is the dev.anyone know',
  'hello.computer says no',
  'read the docs.company policy is fine',
  'fee is 0.95% protocol and 0.30% creator',
  'MIN_GRADUATION_RAISE is 12.161433 USDC',
  'graduated at block 55.870.261',
  'i am holding',
  'no thanks',
  'buy the dip',
  'ser wen moon',
]

/**
 * KACANLAR. Her biri BUGUN gecer, ve gecmesi KABUL EDILMIS bir maliyettir.
 * Gerekce `lib/chatPolicy.ts`in basinda: yanlis pozitif kullaniciya carpar,
 * yanlis negatif ise zaten paraya mal olmus bir holder'in tek mesajidir.
 */
const KNOWN_MISSES: readonly (readonly [string, string])[] = [
  ['example.quest', 'TLD listede degil -- liste bir ALLOWLIST, genel desen degil'],
  ['example.сom', 'TLD Kiril "с" ile yazilmis; desen ASCII harf ariyor'],
  ['e x a m p l e . c o m', 'harflerin arasina bosluk konmus'],
  ['aHR0cHM6Ly9ldmlsLmNvbQ==', 'base64 kodlanmis URL'],
  ['BUY NOW 1000x GUARANTEED', 'link icermeyen spam -- yasak spam yasagi degil'],
  ['dm me on telegram', 'zincir disina isaret eder ama URL degil'],
  ['search for arcpad on twitter', 'ayni sinif'],
]

describe('link yasagi -- POZITIF kume', () => {
  it.each(BLOCKED)('engellenir: %s', (body) => {
    expect(findLink(body), body).not.toBeNull()
    const verdict = checkChatBody(body)
    expect(verdict.ok, body).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('link')
  })

  it('kume BOS DEGIL -- "hepsi gecti" sifir ornek uzerinde de dogrudur', () => {
    expect(BLOCKED.length).toBeGreaterThan(30)
  })
})

describe('link yasagi -- NEGATIF kume (yanlis pozitif yok)', () => {
  it.each(ALLOWED)('gecer: %s', (body) => {
    expect(findLink(body), body).toBeNull()
    expect(checkChatBody(body).ok, body).toBe(true)
  })

  /**
   * BU IKISI KAPININ VAR OLMA BICIMINI OLCUYOR.
   *
   * "sold half.it was a good exit" ve "hello.computer says no" tam olarak
   * genel bir `\.[a-z]{2,}` deseninin yakalayacagi cumleler. Ilki `it`in
   * `TLD_NEEDS_PATH`te olmasi sayesinde, ikincisi `(?![a-z])` lookahead'i
   * sayesinde geciyor -- yani ikisi de kapinin AYRI bir tasarim kararini
   * olcuyor ve o karar dusurulurse test kirilir.
   */
  it('NEGATIF KONTROL: genel `\\.[a-z]{2,}` deseni bu cumleleri YAKALARDI', () => {
    const naive = /\.[a-z]{2,}/
    expect(naive.test('sold half.it was a good exit')).toBe(true)
    expect(naive.test('hello.computer says no')).toBe(true)
    // ...ve gercek kapi yakalamiyor. Iki iddia birlikte "kapi genel desenden
    // DAHA DAR" cumlesini olcer.
    expect(findLink('sold half.it was a good exit')).toBeNull()
    expect(findLink('hello.computer says no')).toBeNull()
  })

  it('`t.me` YOL ILE yakalanir, `x.it` YOLSUZ yakalanmaz', () => {
    // `me` ve `it` ayni kumede (`TLD_NEEDS_PATH`). Fark yolun kendisi --
    // `t.me` ayrica `HOST_ALWAYS` listesinde oldugu icin yolsuz da yakalanir.
    expect(findLink('t.me/x')).toBe('t.me')
    expect(findLink('t.me')).toBe('t.me')
    expect(findLink('x.it/free')).toBe('x.it')
    expect(findLink('x.it')).toBeNull()
  })
})

describe('link yasagi -- BILINEN KACAKLAR (olculur, gizlenmez)', () => {
  it.each(KNOWN_MISSES)('KACIYOR: %s (%s)', (body) => {
    expect(findLink(body), body).toBeNull()
    expect(checkChatBody(body).ok, body).toBe(true)
  })
})

describe('link yasagi -- BILINEN YANLIS POZITIF', () => {
  /**
   * BOSLUKLU "dot" NORMALIZASYONUNUN BEDELI, ve BILEREK odeniyor.
   *
   * "example dot com" spam'de yaygin; "the dot com boom" ise bir ifade. Ayni
   * normalizasyon ikisini de "."e cevirir, yani ikincisi REDDEDILIR. Alternatif
   * -- bosluklu "dot"u hic normalize etmemek -- en ucuz ve en yaygin gizleme
   * yontemini acik birakirdi.
   *
   * Bedel yazili ve OLCULUYOR, yani bir gun biri bunu duzeltmeye kalkarsa
   * neyi kaybedecegini gorur.
   */
  it('"the dot com boom" REDDEDILIR', () => {
    expect(findLink('remember the dot com boom')).not.toBeNull()
    // Ve kacisi belli: bosluksuz yazmak gecer.
    expect(findLink('remember the dotcom boom')).toBeNull()
  })
})

describe('normalizasyon SAKLANAN GOVDEYI DEGISTIRMEZ', () => {
  /**
   * REDDEDILIR, SOYULMAZ -- ve bu bir slogan degil, bir zorunluluk: govde
   * IMZALANMIS metnin parcasi. `normaliseForLinkScan` yalnizca TESPIT icin
   * calisir ve dondurdugu sey hicbir yere yazilmaz.
   */
  it('tespit metni ile govde AYRI seylerdir', () => {
    const body = 'Evil[.]COM 🚀'
    expect(normaliseForLinkScan(body)).toContain('evil.com')
    // `checkChatBody` govdeyi DONDURMEZ; degistirilmis bir govde uretecek bir
    // API YOKTUR. Tip duzeyinde: `ChatBodyVerdict`in basarili dalinda `body`
    // alani yoktur.
    const verdict = checkChatBody(body)
    expect(verdict.ok).toBe(false)
    expect(Object.keys(verdict)).not.toContain('body')
  })

  it('sifir genislikli karakterler TESPITTE silinir, GOVDEDE kalir', () => {
    const split = 'evi​l.com'
    expect(findLink(split)).not.toBeNull()
    // Ve bir emoji ZWJ dizisi REDDEDILMEZ: ZWJ (U+200D) mesru.
    expect(checkChatBody('👨‍👩‍👧 gm').ok).toBe(true)
  })
})

describe('govde sinirlari -- semadaki sayilarla AYNI', () => {
  it('sinirlar migration 013 ile ayni', () => {
    expect(CHAT_BODY_MAX_CHARS).toBe(500)
    expect(CHAT_BODY_MAX_BYTES).toBe(1000)
  })

  it('KOD NOKTASI sayar, kod BIRIMI degil', () => {
    // 500 emoji = 500 kod noktasi ama 1000 kod BIRIMI. `.length` kullanan bir
    // uygulama bunu 1000 sayar ve semadan (`length()`, kod noktasi) AYRISIRDI.
    const emoji = '🚀'.repeat(500)
    expect(emoji.length).toBe(1000)
    expect([...emoji]).toHaveLength(500)
    // Karakter kapisindan gecer, BAYT kapisindan duser (2000 > 1000).
    const verdict = checkChatBody(emoji)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('tooManyBytes')
  })

  it('501 karakter `tooLong`, 500 gecer', () => {
    expect(checkChatBody('a'.repeat(500)).ok).toBe(true)
    const verdict = checkChatBody('a'.repeat(501))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('tooLong')
  })

  it('BOS ve yalnizca-bosluk reddedilir', () => {
    for (const body of ['', '   ', '\n\n', '\t']) {
      const verdict = checkChatBody(body)
      expect(verdict.ok, JSON.stringify(body)).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toBe('empty')
    }
  })
})

describe('Postgres`in `text`ine giremeyen karakterler REDDEDILIR', () => {
  /**
   * `pgSafeText` BURADA KULLANILAMAZ: o TEMIZLER ve govde imzalidir. Ayni
   * tehlike, farkli care.
   *
   * ULASILABILIRLIK OLCULDU: `JSON.parse('"\\ud800"')` tek basina kalan bir
   * vekil uretir, yani bu girdi bir POST govdesinden GERCEKTEN gelebilir. Bu
   * kontrol olmasaydi `INSERT` Postgres'te patlar ve kullanici 400 yerine 503
   * gorurdu.
   */
  it('U+0000 ve tek basina vekil reddedilir -- ve JSON`dan gelebilirler', () => {
    const nul = JSON.parse('"a\\u0000b"') as string
    const lone = JSON.parse('"a\\ud800b"') as string
    expect(nul).toHaveLength(3)
    expect(lone).toHaveLength(3)
    for (const body of [nul, lone]) {
      const verdict = checkChatBody(body)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toBe('hostileCharacters')
    }
  })

  it('bidi override reddedilir -- metni GORSEL olarak ters cevirir', () => {
    const verdict = checkChatBody('sell ‮ ton eb')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('hostileCharacters')
  })

  it('satir sonu ve sekme MESRUDUR', () => {
    expect(checkChatBody('line one\nline two').ok).toBe(true)
    expect(checkChatBody('a\tb').ok).toBe(true)
  })
})
