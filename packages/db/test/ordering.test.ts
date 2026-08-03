import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  listTokens,
  listTrades,
  SEARCH_SORT_KEYS,
  searchSortExpression,
  SORTS,
} from '../src/queries'
import { putDeployment } from '../src/deployment'
import { applyTrade, replayRange } from '../src/apply'
import { toSeq } from '../src/seq'
import { pool, resetSchema } from './setup'
import { BUY, DEPLOYMENT, hashFor, RANGE, RANGE_TO, TOKEN } from './fixtures'

const SOURCE = readFileSync(new URL('../src/queries.ts', import.meta.url), 'utf8')

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
  it('hicbir sorgu bir zaman kolonuna gore siralamaz', () => {
    const clauses = [...CODE.matchAll(/order\s+by\s+([^;`)]+)/gi)].map((m) => m[1] ?? '')
    // Bos kumeyi gecmesini onler: "hepsi temiz" sifir ifade uzerinde de
    // dogrudur ve o hali bir sey OLCMEZDI.
    expect(clauses.length).toBeGreaterThan(0)
    for (const clause of clauses) expect(clause).not.toMatch(/_at\b/)
  })

  it('SORTS in her ifadesi bir _seq ya da miktar anahtaridir', () => {
    for (const [name, expression] of Object.entries(SORTS)) {
      expect(expression, name).toMatch(/^(last_buy_seq|created_seq|market_cap_wei|volume_24h_wei) /)
      expect(expression, name).not.toMatch(/_at\b/)
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

  it('MIKTAR anahtarlarinin HEPSI paketlenmistir (ciplak kolon YOK)', () => {
    // `SORTS`ta `market_cap_wei DESC` CIPLAKTIR ve bu bilerek boyle birakildi
    // (imleci baska bir izin sahibinin dosyasinda yeniden turetiliyor);
    // aramada ayni kolon paketlenmis olmak ZORUNDA. Iki tarafin farkli
    // olmasi kaza degil, ve fark burada YAZILI.
    for (const name of ['marketCap', 'volume', 'relevance'] as const) {
      expect(searchSortExpression(name).key, name).toMatch(/^search_key\(/)
    }
    expect(SORTS.marketCap).toBe('market_cap_wei DESC')
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
    expect(CODE).toContain('const order = SORTS[sort]')
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
