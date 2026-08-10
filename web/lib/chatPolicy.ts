/**
 * ==========================================================================
 *  GOVDE POLITIKASI: LINK YASAGI VE METIN SINIRLARI
 * ==========================================================================
 *
 * Spec'in risk tablosu chat kotuye kullanimina UC karsi-onlem yazar ve ucunu
 * BIRLIKTE yazar: holder-gate + link yasagi + gonderi anindaki bakiye kaydi.
 * Bu dosya ikincisidir. Digerlerinin nerede oldugu: kapi `app/api/chat/route.ts`
 * ile `chat_messages.balance_tok > 0`, kayit ise `balance_tok` sutunu.
 *
 * ==========================================================================
 *  REDDEDILIR, SOYULMAZ -- VE BU BIR TERCIH DEGIL
 * ==========================================================================
 *
 * "Link'i temizleyip mesaji yayinla" ilk akla gelen davranistir ve BU URUNDE
 * IMKANSIZDIR: govde IMZALANMIS metnin parcasidir (`lib/chatMessage.ts`).
 * Tek bir karakterini degistirmek, satirla birlikte saklanan imzayi o govdeye
 * ait OLMAYAN bir imza yapar -- yani satirin kendi delili cope gider ve
 * "yazar bunu yazdi" cumlesi bir daha dogrulanamaz.
 *
 * Dolayisiyla iki secenek vardi: (a) imzayi soyulmus govde uzerinde istemek --
 * kullanicinin ONAYLADIGI metinden BASKA bir metnin saklanmasi demek olurdu,
 * yani cuzdan ekraninda goruleni degil sunucunun urettigini imzalatmak; ya da
 * (b) reddetmek. (b) secildi ve arayuz reddi GONDERMEDEN ONCE gosterir, yani
 * kullanici cuzdan penceresine bile ugramaz.
 *
 * ==========================================================================
 *  YASAGIN ERISIMI: NE DURDURUR, NE DURDURMAZ
 * ==========================================================================
 *
 * DURDURUR: sema tasiyan her sey (`https://`, `ipfs://`, `hxxp://`), `www.`
 * onekleri, ve tanidik bir TLD tasiyan host'lar -- parantezli
 * ("example[.]com"), bosluklu ("example dot com"), sifir genislikli
 * karakterlerle bolunmus ve tam-genislik noktali halleri dahil. `t.me/...`
 * ozellikle dahildir.
 *
 * DURDURMAZ, ve bunlarin her biri `test/chat/link-ban.test.ts` icinde
 * CALISTIRILARAK gosteriliyor (yani "durdurmaz" da bir olcumdur, bir tahmin
 * degil):
 *   - listede olmayan bir TLD (`example.quest`)
 *   - TLD'nin kendisinde homoglif (Kiril "com")
 *   - harflerin arasina bosluk konmasi ("e x a m p l e . c o m")
 *   - kodlanmis bir URL (base64)
 *   - hic link icermeyen spam ("BUY NOW 1000x")
 *   - "beni DM'den ekle" gibi zincir disina isaret eden ama URL olmayan metin
 *
 * Yani bu yasak spam'i BITIRMEZ; MALIYETINI yukseltir ve tiklanabilir kimlik
 * avini zorlastirir. Spam'in gercek bedeli holder-gate'te: yazmak icin once
 * token almak gerekir, ve alinan pozisyon her mesajin yaninda GORUNUR.
 *
 * ==========================================================================
 *  HASSASIYET/DUYARLILIK TERCIHI: HASSASIYET
 * ==========================================================================
 *
 * Yanlis pozitif KULLANICIYA carpar (mesru bir cumle reddedilir); yanlis
 * negatif bir mesaj spam olarak gecer ve zaten paraya mal olmus bir yazarin
 * tek mesajidir. Bu yuzden TLD listesi bir ALLOWLIST'tir, genel bir
 * nokta+harf deseni degil: o desen "harika.bu arada" gibi noktadan sonra
 * bosluk unutulmus HER cumleyi link sayardi.
 *
 * ==========================================================================
 *  ASCII-DISI HER KARAKTER `String.fromCodePoint` ILE KURULUR
 * ==========================================================================
 *
 * Bu dosyanin regex'leri kod noktalarini SAYIYLA yazar ve desenleri calisma
 * zamaninda birlestirir. Gerekce olculdu: bir regex LITERALI icine konan
 * sifir genislikli karakterler eslint'i `no-irregular-whitespace` ve
 * `no-misleading-character-class` ile kirar, ve dosyanin ICINDE gorunmez
 * olurlar -- yani bir gozden geciren orada ne oldugunu OKUYAMAZ. Sayilar hem
 * lint'ten gecer hem de okunur.
 */

/** Semadaki `length(body) BETWEEN 1 AND 500` ile AYNI sayi. */
export const CHAT_BODY_MAX_CHARS = 500
/** Semadaki `octet_length(body) <= 1000` ile AYNI sayi. */
export const CHAT_BODY_MAX_BYTES = 1000

/**
 * TLD, HER ZAMAN LINK SAYILAN LISTE.
 *
 * Icinde INGILIZCE KELIME OLAN hicbir sey yok, ve sebebi olculdu:
 * "harika.it was great" gibi noktadan sonra boslugu unutulmus bir cumle, `it`
 * bu listede olsaydi link sayilirdi. O kelimeler `TLD_NEEDS_PATH`te.
 */
const TLD_ALWAYS = new Set([
  'com', 'net', 'org', 'io', 'co', 'xyz', 'gg', 'app', 'dev', 'ai', 'link', 'click', 'top',
  'site', 'online', 'live', 'info', 'biz', 'vip', 'wtf', 'lol', 'art', 'bio', 'one', 'page',
  'wiki', 'zip', 'mov', 'fun', 'cash', 'finance', 'exchange', 'capital', 'money', 'pro',
  'tech', 'space', 'store', 'shop', 'club', 'cc', 'tv', 'ly', 'sh', 'gd', 'tk', 'ml', 'ga',
  'cf', 'pw', 'ru', 'cn', 'uk', 'eu', 'au', 'ca', 'fr', 'jp', 'kr', 'br', 'nl', 'ch', 'se',
  'pl', 'cz', 'tr', 'ir', 'de', 'es', 'pt', 'fi', 'dk', 'gr', 'hu', 'ro', 'ua', 'kz', 'la',
  'li', 'lu', 'mx', 'ar', 'cl', 'il', 'sa', 'ae', 'hk', 'sg', 'tw', 'th', 'vn', 'ph', 'nz',
  'za', 'ng', 'ke', 'network', 'markets', 'trade', 'fyi', 'lat',
])

/**
 * TLD, YALNIZCA BIR YOL (`/`) YA DA PORT (`:`) VARSA LINK.
 *
 * Hepsi INGILIZCE KELIME. Tek baslarina bir link olduklarini soylemek,
 * "sattim.it bana kaldi" gibi cumleleri reddetmek olurdu; `t.me/joinchat`
 * ise yol tasidigi icin yakalanir.
 */
const TLD_NEEDS_PATH = new Set([
  'it', 'is', 'in', 'at', 'to', 'be', 'me', 'so', 'us', 'no', 'do', 'my', 'am', 'by', 'as',
  'id', 'im',
])

/**
 * TEK BASINA YETEN HOST'LAR. `TLD_NEEDS_PATH` bir kural, bu liste onun
 * bilerek acilmis delikleri: `t.me` kripto spam'inin en yaygin hedefidir ve
 * "t.me" dizesinin mesru bir Ingilizce cumlede gecmesi mumkun degildir.
 */
const HOST_ALWAYS = new Set(['t.me', 'bit.do', 'x.co'])

const cp = String.fromCodePoint

/**
 * SIFIR GENISLIKLI KARAKTERLER -- link'i bolmenin en ucuz yolu.
 *
 * U+200B ZWSP - U+200C ZWNJ - U+200D ZWJ - U+2060 WORD JOINER - U+FEFF BOM
 *
 * SILINIRLER, REDDEDILMEZLER: U+200D emoji dizilerinin (aile, meslek)
 * tasiyicisidir ve U+200C Farsca/Arapca metinde GEREKLIDIR. Ikisini de
 * yasaklamak mesru govdeleri kirardi. Tespit icin silinir, GOVDEDE KALIR.
 */
const ZERO_WIDTH_CODES = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]
const ZERO_WIDTH = new RegExp(ZERO_WIDTH_CODES.map((code) => cp(code)).join('|'), 'g')

/**
 * NOKTA GIBI OKUNAN KARAKTERLER.
 * U+3002 ideografik - U+FF0E tam genislik - U+FF61 yarim genislik -
 * U+00B7 orta nokta - U+2024 tek nokta lideri
 */
const DOT_LOOKALIKE_CODES = [0x3002, 0xff0e, 0xff61, 0x00b7, 0x2024]
const DOT_LOOKALIKE = new RegExp(DOT_LOOKALIKE_CODES.map((code) => cp(code)).join('|'), 'g')

/** `[.]`, `(dot)`, `{ . }` ve benzerleri. */
const BRACKETED_DOT = /[[({<]\s*(?:dot|d0t|punto|nokta|\.)\s*[\])}>]/gi

/** Bosluklu "dot". BILINEN BIR YANLIS POZITIF URETIR -- bkz. testler. */
const SPACED_DOT = /\s+(?:dot|nokta)\s+/gi

/** `hxxp://`, `h**ps://`, `hXXps://`. */
const MANGLED_SCHEME = /\bh[x*]{2}(s?):\/\//gi

/** Herhangi bir sema. `mailto:` gibi `//` tasimayanlar ayrica asagida. */
const ANY_SCHEME = /\b[a-z][a-z0-9+.-]{0,15}:\/\//

/** `mailto:` ve `tel:` -- `//` tasimazlar ama yine zincir disina goturur. */
const BARE_SCHEME = /\b(?:mailto|tel|sms|bitcoin|ethereum):[^\s]/i

const WWW_PREFIX = /(?:^|[^a-z0-9])www\./

/**
 * `label.tld`, ve etiketin ONUNDE bir kelime karakteri OLMAMALI.
 *
 * `(?![a-z])` TLD'nin ARDINDAN harf gelmesini yasaklar: "merhaba.company"
 * icinde TLD `company`dir, `co` degil -- yani listede olmayan bir uzantiyi
 * listedeki bir onekle karistirmak MUMKUN DEGILDIR. Bu lookahead olmadan
 * "hello.computer" bir link sayilirdi.
 */
const HOSTLIKE = /(?:^|[^a-z0-9@._-])([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z]{2,24})(?![a-z])/g

/** Tespit ICIN normalize edilmis metin. SAKLANAN GOVDE ASLA BU DEGILDIR. */
export function normaliseForLinkScan(body: string): string {
  return body
    .toLowerCase()
    .replace(ZERO_WIDTH, '')
    .replace(MANGLED_SCHEME, 'http$1://')
    .replace(DOT_LOOKALIKE, '.')
    .replace(BRACKETED_DOT, '.')
    .replace(SPACED_DOT, '.')
}

/**
 * Govdede bir link varsa YAKALANAN METNI, yoksa `null` dondurur.
 *
 * Metni dondurmesi kasitli: arayuz kullaniciya "su parca link gibi gorunuyor"
 * diyebilir. Bir boolean, kullaniciyi kendi cumlesinde link aramaya birakirdi.
 */
export function findLink(body: string): string | null {
  const text = normaliseForLinkScan(body)

  const scheme = ANY_SCHEME.exec(text)
  if (scheme !== null) return scheme[0]
  const bare = BARE_SCHEME.exec(text)
  if (bare !== null) return bare[0]
  const www = WWW_PREFIX.exec(text)
  if (www !== null) return 'www.'

  HOSTLIKE.lastIndex = 0
  let match: RegExpExecArray | null = HOSTLIKE.exec(text)
  while (match !== null) {
    const label = match[1] ?? ''
    const tld = match[2] ?? ''
    const host = `${label}.${tld}`
    // `match.index` etiketten ONCEKI karakteri de kapsayabilir; yolun varligi
    // icin eslesmenin BITTIGI yere bakilir.
    const after = text.slice(match.index + match[0].length)
    const hasPath = after.startsWith('/') || /^:\d/.test(after)

    if (HOST_ALWAYS.has(host)) return host
    if (TLD_ALWAYS.has(tld)) return host
    if (TLD_NEEDS_PATH.has(tld) && hasPath) return host
    match = HOSTLIKE.exec(text)
  }
  return null
}

/**
 * POSTGRES'IN `text`INE GIREMEYEN VE EKRANI KANDIRAN KOD BIRIMLERI.
 *
 * `packages/db`nin `pgSafeText`i BURADA KULLANILAMAZ: o TEMIZLER, ve govde
 * imzalidir. Yani ayni tehlike ayni yerde durur ama karsiligi farklidir --
 * REDDETME. Reddedilmezse `INSERT` Postgres'te patlar ve kullanici bir 400
 * yerine 503 gorur.
 *
 * KAPSAM, kod noktasiyla:
 *   0000-0008, 000B-001F, 007F-009F  C0/C1 kontrol -- 0A (\n) ve 09 (\t) HARIC.
 *                                    U+0000'i Postgres `text` KABUL ETMEZ
 *                                    ("null character not permitted").
 *   202A-202E                        bidi OVERRIDE -- metni GORSEL olarak ters cevirir
 *   2066-2069                        bidi ISOLATE  -- ayni sinif
 *   tek basina vekil (surrogate)     gecersiz UTF-8. JSON.parse ile bir POST
 *                                    govdesinden GERCEKTEN ulasilabilir.
 */
const HOSTILE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]
const HIGH_SURROGATE = `${cp(0xd800)}-${cp(0xdbff)}`
const LOW_SURROGATE = `${cp(0xdc00)}-${cp(0xdfff)}`
const HOSTILE_CODE_UNITS = new RegExp(
  [
    `[${HOSTILE_RANGES.map(([from, to]) => `${cp(from)}-${cp(to)}`).join('')}]`,
    `[${HIGH_SURROGATE}](?![${LOW_SURROGATE}])`,
    `(?<![${HIGH_SURROGATE}])[${LOW_SURROGATE}]`,
  ].join('|'),
)

export type ChatBodyRejection =
  | 'empty'
  | 'tooLong'
  | 'tooManyBytes'
  | 'hostileCharacters'
  | 'link'

export type ChatBodyVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ChatBodyRejection; readonly detail?: string }

/**
 * SIRA ONEMLIDIR VE UCUZDAN PAHALIYA GIDER: uzunluk -> karakter kumesi ->
 * link taramasi. Hepsi SAF; hicbiri ag ya da veritabani gormez, yani bu
 * fonksiyon POST rotasinda IMZA DOGRULAMASINDAN once cagrilabilir ve
 * cagrilir.
 */
export function checkChatBody(body: string): ChatBodyVerdict {
  if (body.trim() === '') return { ok: false, reason: 'empty' }
  // `[...body]` KOD NOKTASI sayar; `body.length` KOD BIRIMI sayar. Semadaki
  // `length()` kod noktasi sayar, yani `.length` kullanmak bir emoji'yi iki
  // karakter sayar ve uygulama ile sema AYRISIRDI.
  if ([...body].length > CHAT_BODY_MAX_CHARS) return { ok: false, reason: 'tooLong' }
  if (new TextEncoder().encode(body).length > CHAT_BODY_MAX_BYTES) {
    return { ok: false, reason: 'tooManyBytes' }
  }
  if (HOSTILE_CODE_UNITS.test(body)) return { ok: false, reason: 'hostileCharacters' }
  const link = findLink(body)
  if (link !== null) return { ok: false, reason: 'link', detail: link }
  return { ok: true }
}

/** Arayuzun gosterdigi cumleler. Rota ile panel AYNI metni kullanir. */
export const CHAT_REJECTION_COPY: Record<ChatBodyRejection, string> = {
  empty: 'Write something first.',
  tooLong: `Messages are at most ${CHAT_BODY_MAX_CHARS} characters.`,
  tooManyBytes: `That message is too large - ${CHAT_BODY_MAX_BYTES} bytes is the limit.`,
  hostileCharacters: 'That message contains characters we cannot store.',
  link: 'Links are not allowed in token chat.',
}
