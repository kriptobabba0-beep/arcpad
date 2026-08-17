import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  listTokens,
  listTrades,
  SEARCH_SORT_KEYS,
  searchSortExpression,
  SORTS,
} from '../src/queries'
import { putDeployment } from '../src/deployment'
import type { LaunchEvent } from '../src/apply'
import { applyLaunch, applyTrade, replayRange, setCursor } from '../src/apply'
import { toHexBytes } from '../src/hex'
import { toSeq } from '../src/seq'
import { pool, resetSchema } from './setup'
import { addr, BUY, DEPLOYMENT, hash32, hashFor, PROFILE, RANGE, RANGE_TO, TOKEN } from './fixtures'

const SOURCE = readFileSync(new URL('../src/queries.ts', import.meta.url), 'utf8')

/**
 * ==========================================================================
 *  KAPI ARTIK `src/` IN TAMAMINI TARAR, TEK BIR DOSYAYI DEGIL.
 * ==========================================================================
 *
 * Onceki hali YALNIZCA `queries.ts`i okuyordu, ve o dosyanin adi kapinin
 * icine yaziliydi. Yani kural "hicbir sorgu zamana gore siralamaz" DEGIL,
 * "`queries.ts` icindeki hicbir sorgu zamana gore siralamaz" idi -- ve ikisi
 * arasindaki fark tam olarak bu deponun en sik kusurudur: BIR GIRIS
 * NOKTASINDA KANITLANMIS bir ozellik HEPSINDE kanitlanmis gibi okunur.
 *
 * Faz 6 o farki somut yapti: `chat_messages`in sorgulari yeni bir dosyaya
 * (`src/chat.ts`) indi ve eski kapi onlara HIC BAKMAZDI. Chat satirlarinin
 * `event_seq`i olmadigi icin de tam olarak `created_at`e gore siralanmaya en
 * acik sorgular onlar.
 *
 * Dosya listesi DISKTEN gelir, elle yazilan bir listeden degil: yeni bir
 * `src/*.ts` eklemek onu kendiliginden kapsama sokar ve kapiyi guncellemeyi
 * unutmak MUMKUN DEGILDIR.
 */
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))
const SRC_FILES = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort()
const SRC = SRC_FILES.map((f) => ({
  file: f,
  text: readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'),
}))

/**
 * KAPI KODA BAKAR, YORUMA DEGIL.
 *
 * Ilk hali yorumlari da tariyordu ve KENDI GEREKCESINI yakaladi: dosyanin
 * basindaki "`ORDER BY last_buy_at DESC` siralamanin yarisini tanimsiz
 * birakir" cumlesi kapiyi kirdi. Kurali ACIKLAYAN metnin kurali ihlal etmis
 * sayilmasi, kapiyi kuralin kendisini yazilamaz hale getirecek kadar
 * genisletirdi -- yani yanlis tarafta bir hata. Yorumlar soyuluyor; SQL
 * dizgeleri (ters tirnakli sablonlar) DURUYOR, cunku kapinin bakmasi gereken
 * yer tam olarak orasi.
 */
function codeOf(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

const CODE = codeOf(SOURCE)

/**
 * SIRALAMA ZAMANA GORE YAPILMAZ -- ve bu kural bir yorumda dursa unutulur.
 *
 * OLCUM (Arc testnet, 553 ardisik finalized cift): ciftlerin %49,0'i AYNI
 * timestamp'i tasiyor, sifiri geriliyor. Yani `ORDER BY ..._at DESC`
 * siralamanin YARISINI tanimsiz birakir; Postgres esit anahtarlar icin sira
 * garanti etmez ve plan degistiginde sira da degisir.
 */
describe('siralama kapisi', () => {
  it('hicbir sorgu bir zaman kolonuna gore siralamaz -- src/ IN TAMAMINDA', () => {
    let total = 0
    for (const { file, text } of SRC) {
      const clauses = [...codeOf(text).matchAll(/order\s+by\s+([^;`)]+)/gi)].map((m) => m[1] ?? '')
      total += clauses.length
      for (const clause of clauses) expect(clause, `${file}: ${clause}`).not.toMatch(/_at\b/)
    }
    // Bos kumeyi gecmesini onler: "hepsi temiz" sifir ifade uzerinde de
    // dogrudur ve o hali bir sey OLCMEZDI.
    expect(total).toBeGreaterThan(0)
  })

  /**
   * KAPININ ERISIMI OLCULUR, VARSAYILMAZ.
   *
   * "src/ in tamamini tariyorum" cumlesi, taramanin `queries.ts` disinda bir
   * dosyada GERCEKTEN bir `ORDER BY` gordugu gosterilmedikce bir iddiadir.
   * Faz 6'nin `chat.ts`i o ikinci dosyadir ve chat satirlarinin `event_seq`i
   * OLMADIGI icin en riskli olan da odur.
   */
  it('tarama `queries.ts` DISINDA da ORDER BY goruyor', () => {
    const withOrderBy = SRC.filter(({ text }) => /order\s+by/i.test(codeOf(text))).map(
      (s) => s.file,
    )
    expect(withOrderBy).toContain('queries.ts')
    expect(withOrderBy).toContain('chat.ts')
    expect(withOrderBy.length).toBeGreaterThan(1)
  })

  it('NEGATIF KONTROL: chat.ts `created_at`e gore siralarsa kapi kirilir', () => {
    const chat = SRC.find((s) => s.file === 'chat.ts')
    expect(chat).toBeDefined()
    const mutated = codeOf(
      /*
       * `LIMIT $3` DAHIL, VE BU BIR DUZELTME: `ORDER BY m.message_seq DESC`
       * dizesi `chat.ts`te ILK once bir YORUM icinde geciyor (kurali aciklayan
       * paragrafta). `String.replace` bir dizeyle YALNIZCA ILK esleseni
       * degistirir, yani mutasyon yorumu bozuyor, `codeOf` onu zaten soyuyor
       * ve negatif kontrol "hicbir sey degismedi" diyerek DUSUYORDU -- kapinin
       * kendisini olcen bir testin, kendi mutasyonunu ulasilmayan bir yere
       * uygulamasi.
       */
      (chat as { text: string }).text.replace(
        'ORDER BY m.message_seq DESC LIMIT $3',
        'ORDER BY m.created_at DESC LIMIT $3',
      ),
    )
    expect(mutated).not.toBe(codeOf((chat as { text: string }).text))
    const clauses = [...mutated.matchAll(/order\s+by\s+([^;`)]+)/gi)].map((m) => m[1] ?? '')
    expect(clauses.some((c) => /_at\b/.test(c))).toBe(true)
  })

  it('SORTS in her ifadesi bir _seq ya da paketlenmis miktar anahtaridir', () => {
    for (const [name, { key }] of Object.entries(SORTS)) {
      const packed = key.startsWith('search_key(') && key.includes('created_seq')
      const seqOnly = /^(last_buy_seq|created_seq)$/.test(key)
      expect(packed || seqOnly, `${name}: ${key}`).toBe(true)
      expect(key, name).not.toMatch(/_at\b/)
    }
  })

  // KAPININ KENDISI OLCULUR: `_at`e gore siralayan bir kaynak metin bu testi
  // GERCEKTEN kirar. Aksi halde regex'in hicbir seyi yakalamadigi bir dunyada
  // da yesil kalirdi.
  it('NEGATIF KONTROL: _at e gore siralayan bir metin kapiyi kirar', () => {
    const mutated = codeOf(
      SOURCE.replace('ORDER BY t.event_seq DESC', 'ORDER BY t.block_time DESC'),
    )
    expect(mutated).not.toBe(CODE)
    const clauses = [...mutated.matchAll(/order\s+by\s+([^;`)]+)/gi)].map((m) => m[1] ?? '')
    expect(clauses.some((c) => /_time\b|_at\b/.test(c))).toBe(true)
  })

  /**
   * ARAMANIN ANAHTARLARI TAM OLMAK ZORUNDA -- VE BU BIR KAPI, YORUM DEGIL.
   *
   * `_seq` anahtarlari ZATEN birebirdir (her biri tek bir olayin `event_seq`i).
   * MIKTAR anahtarlari degildir ve tekrarlari OLCULDU: hic islem gormemis her
   * token'in market cap'i BIREBIR aynidir, 24 saattir islem gormemis her
   * token'in hacmi `0`dir, ve `similarity` alti gercekci ad uzerinde yalnizca
   * UC ayri deger uretir. Bu yuzden kural: bir arama anahtari ya bir `_seq`
   * kolonudur ya da `search_key(..., created_seq)` ile PAKETLENMISTIR.
   *
   * Kapi ifadenin METNINI okur. `search_key` cagrisini bir anahtardan
   * dusurmek -- yani ariza kipini geri getirmek -- bu testi KIRAR.
   */
  it('her arama anahtari ya bir _seq kolonudur ya PAKETLENMISTIR', () => {
    expect(SEARCH_SORT_KEYS.length).toBeGreaterThan(0)
    for (const name of SEARCH_SORT_KEYS) {
      const { key } = searchSortExpression(name)
      expect(key, name).not.toMatch(/_at\b/)
      const packed = key.startsWith('search_key(') && key.includes('o.created_seq')
      const seqOnly = /^o\.(last_buy_seq|created_seq)$/.test(key)
      expect(packed || seqOnly, `${name}: ${key}`).toBe(true)
    }
  })

  it('MIKTAR anahtarlarinin HEPSI paketlenmistir -- IKI TARAFTA DA', () => {
    for (const name of ['marketCap', 'volume', 'relevance'] as const) {
      expect(searchSortExpression(name).key, name).toMatch(/^search_key\(/)
    }
    // ARTIK EXPLORE TARAFINDA DA. Once `market_cap_wei DESC` ciplakti ve
    // asagidaki "Explore sayfalamasi" bloku kaybi alti tokenin dordu olarak
    // OLCTU; iki taraf artik ayni anahtari kullaniyor.
    expect(SORTS.marketCap.key).toBe('search_key(market_cap_wei, created_seq)')
    expect(SORTS.volume.key).toBe('search_key(volume_24h_wei, created_seq)')
  })

  it('NEGATIF KONTROL: paketleme dusurulurse kapi GERCEKTEN kirilir', () => {
    // Kapinin kendisi olculur: `search_key(...)` yerine ciplak kolonu koyan
    // bir ifade, yukaridaki iddiadan GECEMEZ.
    const mutated = 'o.market_cap_wei'
    const packed = mutated.startsWith('search_key(') && mutated.includes('o.created_seq')
    const seqOnly = /^o\.(last_buy_seq|created_seq)$/.test(mutated)
    expect(packed || seqOnly).toBe(false)
  })

  it('siralama ifadesi kullanici girdisinden BIRLESTIRILMEZ', () => {
    // `SORTS` sabit bir nesnedir ve `sort` onun anahtarlariyla sinirlidir.
    // Kaynakta `ORDER BY ${...}` yalnizca o nesneden gelen bir degerle olusur.
    const interpolations = [...CODE.matchAll(/ORDER BY \$\{([^}]+)\}/g)].map((m) => m[1])
    expect(interpolations.length).toBeGreaterThan(0)
    for (const expr of interpolations) expect(expr).toBe('order')
    expect(CODE).toContain('const { key, desc } = SORTS[sort]')
  })
})

/**
 * ZAMANIN NEDEN YETMEDIGI, VERIYLE.
 *
 * Arc'ta ardisik iki blogun AYNI timestamp'i tasimasi olagandir; fixture bunu
 * zaten taklit ediyor (`BUY` ile `MINT` ayni `T0`i tasir). Asagidaki testler
 * ayni ANI paylasan iki islemin `event_seq` ile KESIN, `block_time` ile
 * KARARSIZ siralandigini gosterir.
 */
describe('esit timestamp, kesin sira', () => {
  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
  })

  it('AYNI timestamp li iki ticaret event_seq ile kesin siralanir', async () => {
    // Ayni blok zamani, FARKLI log indeksleri -- Arc'ta rutin.
    const sameTime = { ...BUY, blockTime: BUY.blockTime }
    await applyTrade(pool, {
      ...sameTime,
      eventSeq: toSeq(BUY.blockNumber, 40),
      logIndex: 40,
      txHash: hashFor(40n),
    })
    await applyTrade(pool, {
      ...sameTime,
      eventSeq: toSeq(BUY.blockNumber, 41),
      logIndex: 41,
      txHash: hashFor(41n),
    })

    const trades = await listTrades(pool, TOKEN, { limit: 200 })
    const seqs = trades.map((t) => t.eventSeq)
    expect(seqs).toEqual([...seqs].sort((a, b) => (a > b ? -1 : 1)))

    // AYNI zamani tasiyan satirlar GERCEKTEN var -- yani bu test bos bir
    // kumede gecmiyor.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT block_time FROM trades GROUP BY block_time HAVING count(*) > 1) x`,
    )
    expect(Number(rows[0]!.n)).toBeGreaterThan(0)
  })

  it('keyset sayfalama esit zamanlarda bile satir TEKRARLAMAZ', async () => {
    for (const i of [40, 41, 42, 43]) {
      await applyTrade(pool, {
        ...BUY,
        eventSeq: toSeq(BUY.blockNumber, i),
        logIndex: i,
        txHash: hashFor(BigInt(i)),
      })
    }
    const seen: bigint[] = []
    let cursor: bigint | null = null
    for (let page = 0; page < 20; page += 1) {
      const rows: Awaited<ReturnType<typeof listTrades>> = await listTrades(pool, TOKEN, {
        cursor,
        limit: 2,
      })
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.eventSeq))
      cursor = rows[rows.length - 1]!.eventSeq
    }
    expect(new Set(seen).size).toBe(seen.length)
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM trades')
    expect(seen.length).toBe(Number(rows[0]!.n))
  })

  it('listTokens da _seq imleciyle sayfalar', async () => {
    const page = await listTokens(pool, { sort: 'newest', limit: 1 })
    expect(page.rows).toHaveLength(1)
    // Imlec bir `_seq`tir, bir zaman degil.
    expect(typeof page.rows[0]!.createdSeq).toBe('bigint')
  })
})

/**
 * EXPLORE'UN SAYFALAMASI, OLCULEREK -- BIR DIZGEYE BAKARAK DEGIL.
 *
 * Yukaridaki "MIKTAR anahtarlarinin HEPSI paketlenmistir" testi `SORTS.marketCap`
 * dizgesini INCELIYOR ve farki YAZIYOR; ama bir dizgeyi okumak, o dizgenin
 * kullaniciya ne yaptigini OLCMEZ. Bu depodaki her ciddi kusur CALISTIRARAK
 * bulundu, ve bu da oyle bulunmali.
 *
 * OLCULEN SENARYO GERCEKTIR: `web/app/(explore)/page.tsx` `readTokenList`i
 * `limit: 24` ile cagirir, `web/lib/read.ts` bir sonraki imleci SON SATIRIN
 * `marketCapWei`inden TURETIR, ve HIC ISLEM GORMEMIS her token AYNI acilis
 * market cap'ini tasir (testnet profilinde tam `4e18`, `admit` onu boyle
 * yazar). Yani ilk sayfanin son satiriyla ayni cap'e sahip HER token
 * `market_cap_wei < $cursor` kosuluyla ELENIR ve HICBIR SAYFADA gorunmez.
 *
 * DUZELTME INDI, VE IKI PARCASI AYRILAMAZ: `SORTS` artik
 * `search_key(market_cap_wei, created_seq)` kullaniyor VE `listTokens` imleci
 * SORGUDAN donduruyor. Yalnizca birincisini yapmak canli sayfayi DAHA da
 * bozardi (`search_key(cap, seq) < 4e18` ciplak bir imlecle bugunkunden AZ
 * satir dondurur), yalnizca ikincisini yapmak hicbir sey degistirmezdi.
 *
 * Asagidaki testler once ESKI kaybi ayni veri uzerinde YENIDEN URETIR (ciplak
 * kolon + cagiran tarafinda turetilen imlec, elle yazilmis SQL ile), sonra
 * uretim yolunun ayni alti satiri EKSIKSIZ gezdigini olcer. Birincisi olmadan
 * ikincisi, veri tekrar etmedigi icin de gecebilirdi.
 */
describe('Explore sayfalamasi -- esit market cap', () => {
  const CREATOR = addr(0xc4ea)
  const T0 = new Date('2026-07-30T12:00:00.000Z')
  const COUNT = 6

  function launch(i: number): LaunchEvent {
    const block = 54_500_000n + BigInt(i)
    const name = `TIE${i}`
    return {
      kind: 'launch',
      eventSeq: toSeq(block, 0),
      blockNumber: block,
      logIndex: 0,
      txHash: hash32(0x71e00000 + i),
      blockTime: T0,
      token: addr(0x71e0 + i),
      curve: addr(0xc1e0 + i),
      creator: CREATOR,
      name,
      symbol: name,
      uri: `ipfs://tie${i}`,
      nameHex: toHexBytes(name),
      symbolHex: toHexBytes(name),
      uriHex: toHexBytes(`ipfs://tie${i}`),
      salt: hash32(0x5a1e0000 + i),
      virtualTokenReservesTok: PROFILE.virtualTokenReservesTok,
      virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei,
      realTokenReservesTok: PROFILE.saleSupplyTok,
      realQuoteReservesWei: 0n,
    }
  }

  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    for (let i = 0; i < COUNT; i += 1) await applyLaunch(pool, launch(i))
    await setCursor(pool, 54_500_100n, hashFor(54_500_100n), 54_500_100n)
  })

  /** Once: kume GERCEKTEN esit anahtarli mi? Degilse asagisi hicbir sey olcmez. */
  it('hic islem gormemis alti token TEK bir market cap degeri tasir', async () => {
    const { rows } = await pool.query<{ n: string; cap: string }>(
      'SELECT count(*)::text AS n, market_cap_wei::text AS cap FROM token_overview GROUP BY 2',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.n).toBe(String(COUNT))
    expect(BigInt(rows[0]!.cap)).toBeGreaterThan(0n)
  })

  /**
   * ESKI YOL, ELLE: ciplak kolon + cagiran tarafinda turetilen imlec. Uretim
   * kodunda artik YOK; burada duruyor cunku duzeltmenin GERI ALDIGI seyin ayni
   * veri uzerinde olculmesi gerekiyor.
   */
  async function pageWithBareColumnCursor(column: string, limit: number): Promise<string[]> {
    const seen: string[] = []
    let cursor: bigint | null = null
    for (let page = 0; page < 20; page += 1) {
      const params: unknown[] = []
      let where = ''
      if (cursor !== null) {
        params.push(cursor.toString())
        where = `WHERE ${column} < $1::numeric`
      }
      params.push(limit)
      const { rows } = await pool.query<{ token: string; key: string }>(
        `SELECT token, ${column}::text AS key FROM token_overview ${where}
          ORDER BY ${column} DESC LIMIT $${params.length}`,
        params,
      )
      seen.push(...rows.map((r) => r.token))
      if (rows.length < limit) break
      cursor = BigInt(rows[rows.length - 1]!.key)
    }
    return seen
  }

  it('NEGATIF KONTROL: ciplak market_cap_wei alti tokenin IKISINE ulasir', async () => {
    const seen = await pageWithBareColumnCursor('market_cap_wei', 2)
    // Ilk sayfa iki satir verir; imlec `4e18` olur ve ikinci sayfanin kosulu
    // `market_cap_wei < 4e18` ALTI TOKENIN HEPSINI eler.
    expect(seen).toHaveLength(2)
    // KALICI KAYIP: dort token hicbir sayfada gorunmezdi.
    expect(COUNT - seen.length).toBe(4)
  })

  it('NEGATIF KONTROL: ciplak volume_24h_wei ilk sayfadan SONRA hicbir sey vermez', async () => {
    // Hicbiri 24 saatte islem gormedi, yani hepsinin hacmi `0`. Imlec `0`
    // olunca kosul `volume_24h_wei < 0` olur -- BOS KUME, ve `0` sinirin
    // kendisi oldugu icin bu bir "kisa sayfa" degil, KALICI bir kesilmedir.
    expect(await pageWithBareColumnCursor('volume_24h_wei', 2)).toHaveLength(2)
  })

  /** URETIM YOLU: imlec `listTokens`in DONDURDUGU anahtardir. */
  async function pageWithReturnedCursor(sort: 'marketCap' | 'volume', limit: number) {
    const seen: string[] = []
    const keys: bigint[] = []
    let cursor: bigint | null = null
    for (let page = 0; page < 20; page += 1) {
      const { rows, nextCursor } = await listTokens(pool, { sort, limit, cursor })
      seen.push(...rows.map((r) => r.token))
      if (nextCursor === null) break
      keys.push(nextCursor)
      cursor = nextCursor
    }
    return { seen, keys }
  }

  it('marketCap sayfalamasi artik ALTI tokenin HEPSINE ulasir', async () => {
    const { seen, keys } = await pageWithReturnedCursor('marketCap', 2)
    expect(new Set(seen).size).toBe(COUNT)
    expect(seen).toHaveLength(COUNT)
    // Imlec PAKETLENMIS bir anahtardir, ham market cap DEGIL: `4e18 * 2^63`
    // mertebesinde, yani `Number`a sigmaz -- `read.ts` onu dizge olarak tasir.
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  })

  it('volume sayfalamasi artik ALTI tokenin HEPSINE ulasir', async () => {
    const { seen } = await pageWithReturnedCursor('volume', 2)
    expect(new Set(seen).size).toBe(COUNT)
    expect(seen).toHaveLength(COUNT)
  })

  it('kisa sayfada nextCursor NULL dur -- son sayfa boyle bilinir', async () => {
    const { rows, nextCursor } = await listTokens(pool, { sort: 'marketCap', limit: 50 })
    expect(rows).toHaveLength(COUNT)
    expect(nextCursor).toBeNull()
  })

  it('_seq siralamalarinin imleci de SORGUDAN doner', async () => {
    const { rows, nextCursor } = await listTokens(pool, { sort: 'newest', limit: 2 })
    expect(rows).toHaveLength(2)
    expect(nextCursor).toBe(rows[1]!.createdSeq)
  })
})
