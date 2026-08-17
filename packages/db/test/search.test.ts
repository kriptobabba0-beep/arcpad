import { beforeAll, describe, expect, it } from 'vitest'
import {
  encodeHolderCursor,
  likePattern,
  listHolders,
  parseHolderCursor,
  SEARCH_SORT_KEYS,
  type SearchSortKey,
  searchTokens,
} from '../src/queries'
import { applyLaunch, applyTransfer, setCursor } from '../src/apply'
import { putDeployment } from '../src/deployment'
import type { LaunchEvent } from '../src/apply'
import type { Address } from '../src/hex'
import { toHexBytes } from '../src/hex'
import { toSeq } from '../src/seq'
import { pool, resetSchema } from './setup'
import { addr, CURVE, DEPLOYMENT, hash32, hashFor, PROFILE, TOKEN } from './fixtures'

/**
 * ARAMA VE SAYFALAMA.
 *
 * BU DOSYANIN OLCTUGU TEK SEY: siralama anahtarinin TAM olmasi. Bir sayfalama
 * hatasi kullaniciya "ayni token iki kez cikiyor" ya da -- daha kotusu, cunku
 * gorunmez -- "aradigim token hicbir sayfada yok" diye ulasir.
 *
 * Her iddianin yaninda bir NEGATIF KONTROL var: ayni sayfalama, TIE-BREAK'SIZ
 * bir anahtarla kosturulur ve GERCEKTEN kirildigi gosterilir. Aksi halde
 * "sayfalama tekrar etmedi" ifadesi, tekrarin hic mumkun olmadigi bir veri
 * kumesinde de dogru olurdu -- yani hicbir sey olcmezdi.
 */

const CREATOR = addr(0xc4ea)
const T0 = new Date('2026-07-30T12:00:00.000Z')

/** Ayni profille acilan bir launch; yalnizca ad, sembol ve kimlik degisir. */
function launch(i: number, name: string, symbol: string): LaunchEvent {
  const block = 54_400_000n + BigInt(i)
  return {
    kind: 'launch',
    eventSeq: toSeq(block, 0),
    blockNumber: block,
    logIndex: 0,
    txHash: hash32(0xda7a0000 + i),
    // AYNI TIMESTAMP. Arc'ta ardisik bloklarin %49,0'i boyledir; siralama
    // hicbir yerde zamana dokunmadigi icin bu testleri etkilemez -- ve tam da
    // bu yuzden fixture onu tasir.
    blockTime: T0,
    token: addr(0x70000 + i),
    curve: addr(0xc0000 + i),
    creator: CREATOR,
    name,
    symbol,
    uri: `ipfs://bafy${i}`,
    nameHex: toHexBytes(name),
    symbolHex: toHexBytes(symbol),
    uriHex: toHexBytes(`ipfs://bafy${i}`),
    salt: hash32(0x5a170000 + i),
    virtualTokenReservesTok: PROFILE.virtualTokenReservesTok,
    virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei,
    realTokenReservesTok: PROFILE.saleSupplyTok,
    realQuoteReservesWei: 0n,
  }
}

/**
 * ALTI AD, UC AYRI SKOR.
 *
 * Bu kume keyfi degil OLCULMUS: `similarity(ad, 'smoke')` bu alti ad icin
 * yalnizca UC ayri deger dondurur (asagidaki ilk test bunu sorgular ve
 * sabitler). Yani "similarity tekrar eder" bir varsayim degil, bu dosyanin
 * uzerinde kosan veri.
 */
const NAMES: ReadonlyArray<[string, string]> = [
  ['SMOKE', 'SMK'],
  ['Smokey', 'SMKY'],
  ['SMOKESCREEN', 'SMKS'],
  ['SMOKED', 'SMKD'],
  ['SMOKER', 'SMKR'],
  ['SMOKES', 'SMKE'],
]

async function seedLaunches(): Promise<void> {
  await putDeployment(pool, DEPLOYMENT)
  for (const [i, [name, symbol]] of NAMES.entries()) {
    await applyLaunch(pool, launch(i, name, symbol))
  }
  await setCursor(pool, 54_400_100n, hashFor(54_400_100n), 54_400_100n)
}

/** Bir sayfalamayi sonuna kadar surer ve gorulen her token'i sirayla toplar. */
async function pageThrough(
  sort: SearchSortKey,
  q: string,
  limit: number,
): Promise<{ seen: string[]; pages: number }> {
  const seen: string[] = []
  let cursor: bigint | null = null
  let pages = 0
  while (pages < 50) {
    const page = await searchTokens(pool, q, { sort, cursor, limit })
    pages += 1
    seen.push(...page.rows.map((r) => r.token))
    if (page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return { seen, pages }
}

describe('arama: siralama anahtari TAM MI', () => {
  beforeAll(async () => {
    await resetSchema()
    await seedLaunches()
  })

  it('OLCUM: similarity TEKRAR EDER, paketlenmis anahtar ETMEZ', async () => {
    const { rows } = await pool.query<{
      n: string
      distinct_sim: string
      distinct_rank: string
      distinct_key: string
    }>(
      `SELECT count(*)::text AS n,
              count(DISTINCT similarity(name, 'smoke'))::text          AS distinct_sim,
              count(DISTINCT search_rank(name, symbol, 'smoke'))::text AS distinct_rank,
              count(DISTINCT search_key(search_rank(name, symbol, 'smoke')::numeric,
                                        created_seq))::text            AS distinct_key
         FROM launches`,
    )
    const r = rows[0]!
    // ALTI SATIR, UC SKOR. Bu, "tie-break sart" cumlesinin kanitidir.
    expect(r.n).toBe('6')
    expect(Number(r.distinct_sim)).toBeLessThan(6)
    expect(Number(r.distinct_rank)).toBeLessThan(6)
    // VE PAKETLENMIS ANAHTAR ALTI FARKLI DEGER. Siralama TAMDIR.
    expect(r.distinct_key).toBe('6')
  })

  it('paketleme BIREBIRDIR: rank ayni olsa da anahtar farklidir', async () => {
    // Ayni rank'i tasiyan satirlarin anahtarlari, `created_seq` FARKI kadar
    // ayrisir -- yani sira, rank esitliginde `created_seq`e duser ve orada
    // ASLA esitlik yoktur (`launches.created_seq` UNIQUE).
    const { rows } = await pool.query<{ rank: number; n: string; keys: string }>(
      `SELECT search_rank(name, symbol, 'smoke') AS rank, count(*)::text AS n,
              count(DISTINCT search_key(search_rank(name, symbol, 'smoke')::numeric,
                                        created_seq))::text AS keys
         FROM launches GROUP BY 1 HAVING count(*) > 1`,
    )
    // En az bir rank grubu BIRDEN COK satir tasiyor -- yani test bos degil.
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.keys).toBe(row.n)
  })

  it('keyset sayfalama HICBIR satiri tekrarlamaz ve HICBIRINI atlamaz', async () => {
    const { seen, pages } = await pageThrough('relevance', 'smoke', 2)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(NAMES.length)
    // GERCEKTEN SAYFALANDI. Tek sayfada biten bir gezinti bu testi bos
    // gecirirdi: sayfalama hatalari yalnizca SINIRDA olur.
    expect(pages).toBeGreaterThan(1)
  })

  it('NEGATIF KONTROL: tie-break DUSURULURSE sayfalama GERCEKTEN kirilir', async () => {
    // Sevk brief'i "tie-break sart, suslemesi degil" diyor. Bu, o cumleyi
    // CALISTIRARAK olcer: ayni sayfalama, anahtari YALNIZCA similarity olan
    // bir sorguyla surulur. Iddia edilen sey "kirilabilir"; olculen sey
    // gercekten kirildigi.
    const limit = 2
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 50; page += 1) {
      // `rows` ACIKCA tiplenir, ve sebebi tip sistemi: `cursor` asagida
      // `rows`tan atanir, yani `cursor`un daraltilmis tipini hesaplamak
      // `rows`u -- dolayisiyla bu cagrinin kendisini -- gerektirir ve `tsc`
      // bunu DONGUSEL cikarim sayar (TS7022). Bildirilmis bir tip zinciri
      // koparir; calisma zamaninda hicbir sey degismez.
      const { rows }: { rows: { token: string; k: string }[] } = await pool.query<{
        token: string
        k: string
      }>(
        `SELECT token, similarity(name, 'smoke')::text AS k
           FROM launches
          WHERE ($1::real IS NULL OR similarity(name, 'smoke') < $1::real)
          ORDER BY similarity(name, 'smoke') DESC
          LIMIT ${limit}`,
        [cursor],
      )
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.token))
      if (rows.length < limit) break
      cursor = rows[rows.length - 1]!.k
    }
    // ESIT ANAHTAR = ATLANAN SATIR. `<` esitleri toptan atar, `<=` ise onlari
    // sonsuza kadar tekrarlar; ikisi de HATALIDIR ve ikisi de "sayfalama
    // calisiyor" gibi gorunur.
    //
    // OLCULEN SAYI: alti satirin yalnizca UCU gorunur. Ilk sayfa SMOKE (1,0)
    // ve 0,625'lilerden KEYFI birini verir; imlec 0,625 olur ve `< 0,625`
    // geri kalan UC satiri birden atar. Yani "eksik sayfa" degil, KALICI
    // OLARAK ULASILAMAZ dort satir.
    expect(seen.length).toBe(3)
    // VE SORGU CALISTI -- sifir satir donmus olsaydi bu test yanlis sebeple
    // gecerdi.
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('NEGATIF KONTROL: `<=` ile ayni anahtar sonsuza kadar TEKRARLAR', async () => {
    const { rows: first } = await pool.query<{ token: string; k: string }>(
      `SELECT token, similarity(name, 'smoke')::text AS k FROM launches
        ORDER BY similarity(name, 'smoke') DESC LIMIT 2`,
    )
    const k = first[first.length - 1]!.k
    const { rows: again } = await pool.query<{ token: string }>(
      `SELECT token FROM launches WHERE similarity(name, 'smoke') <= $1::real
        ORDER BY similarity(name, 'smoke') DESC LIMIT 2`,
      [k],
    )
    // ILK SAYFANIN SON SATIRI IKINCI SAYFADA DA VAR.
    expect(again.map((r) => r.token)).toContain(first[first.length - 1]!.token)
  })

  it('TAM ESLESME once gelir', async () => {
    const page = await searchTokens(pool, 'smoke', { sort: 'relevance', limit: 10 })
    expect(page.rows[0]?.name).toBe('SMOKE')
  })

  it('kisa ON EK, `%` operatorunun KACIRDIGI satiri da bulur', async () => {
    // OLCUM: similarity('SMOKESCREEN','smo') = 0,231 -- varsayilan 0,3
    // esiginin ALTINDA. Yalnizca `%` kullanan bir suzgec o token'i HIC
    // gostermezdi; alt dizge yolu onu getirir.
    const { rows: below } = await pool.query<{ ok: boolean }>(
      `SELECT (similarity('SMOKESCREEN', 'smo') < 0.3) AS ok`,
    )
    expect(below[0]?.ok).toBe(true)
    const page = await searchTokens(pool, 'smo', { sort: 'relevance', limit: 10 })
    expect(page.rows.map((r) => r.name)).toContain('SMOKESCREEN')
  })

  it('`%` ve `_` JOKER DEGIL, HARFTIR', async () => {
    expect(likePattern('%')).toBe('%\\%%')
    expect(likePattern('a_b')).toBe('%a\\_b%')
    expect(likePattern('c:\\x')).toBe('%c:\\\\x%')
    // Tek bir `%` yazan kullanici BUTUN tokenlari degil, HICBIRINI gorur --
    // cunku hicbir adin icinde `%` yok.
    const wildcard = await searchTokens(pool, '%', { sort: 'relevance', limit: 50 })
    expect(wildcard.rows).toHaveLength(0)
    const underscore = await searchTokens(pool, '_', { sort: 'relevance', limit: 50 })
    expect(underscore.rows).toHaveLength(0)
    // KACISLANMAMIS HALI NE YAPARDI: dogrudan olculuyor.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM launches WHERE name ILIKE '%' || '%' || '%'`,
    )
    expect(rows[0]!.n).toBe(String(NAMES.length))
  })

  it('BOS sorgu `newest`e dejenere olur -- ozel bir dal YOK', async () => {
    const relevance = await searchTokens(pool, '', { sort: 'relevance', limit: 50 })
    const newest = await searchTokens(pool, '', { sort: 'newest', limit: 50 })
    expect(relevance.rows.map((r) => r.token)).toEqual(newest.rows.map((r) => r.token))
    // Ve sebebi: bos sorguda her satirin rank'i SIFIRDIR.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM launches WHERE search_rank(name, symbol, '') <> 0`,
    )
    expect(rows[0]!.n).toBe('0')
  })

  it('SEMBOL de aranir, ad kadar', async () => {
    const page = await searchTokens(pool, 'SMKY', { sort: 'relevance', limit: 10 })
    expect(page.rows[0]?.symbol).toBe('SMKY')
  })

  it('kisa sayfa `nextCursor: null` verir', async () => {
    const page = await searchTokens(pool, 'smoke', { sort: 'relevance', limit: 50 })
    expect(page.rows.length).toBeLessThan(50)
    expect(page.nextCursor).toBeNull()
  })

  it('tazelik satirlarla BIRLIKTE doner', async () => {
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '1 hour'")
    const page = await searchTokens(pool, 'smoke', { limit: 5 })
    expect(page.indexer.stale).toBe(true)
    await setCursor(pool, 54_400_101n, hashFor(54_400_101n), 54_400_101n)
    expect((await searchTokens(pool, 'smoke', { limit: 5 })).indexer.stale).toBe(false)
  })

  it('ageDays bir PENCEREDIR, siralama degil', async () => {
    expect((await searchTokens(pool, 'smoke', { ageDays: 3650, limit: 50 })).rows).toHaveLength(
      NAMES.length,
    )
    await pool.query("UPDATE launches SET created_at = now() - interval '40 days'")
    expect((await searchTokens(pool, 'smoke', { ageDays: 7, limit: 50 })).rows).toHaveLength(0)
    expect((await searchTokens(pool, 'smoke', { ageDays: 90, limit: 50 })).rows).toHaveLength(
      NAMES.length,
    )
    await pool.query('UPDATE launches SET created_at = $1', [T0])
  })
})

/**
 * MIKTAR ANAHTARLARI DA TEKRAR EDER -- ve en kotu yerde.
 *
 * Hic islem gormemis her token AYNI acilis market cap'ine sahiptir (bu
 * profilde altisi da BIREBIR ayni), yani `market_cap_wei DESC` bu kumede
 * TAMAMEN kararsizdir. Explore'un `listTokens`i bugun tam olarak boyle
 * sayfaliyor; arama tarafi paketlenmis anahtarla sayfalar.
 */
describe('arama: miktar anahtarlari da paketlenir', () => {
  beforeAll(async () => {
    await resetSchema()
    await seedLaunches()
  })

  it('OLCUM: alti token, TEK bir market cap degeri', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(DISTINCT market_cap_wei)::text AS n FROM token_overview',
    )
    expect(rows[0]!.n).toBe('1')
  })

  it('marketCap sayfalamasi yine de HICBIR satiri tekrarlamaz', async () => {
    const { seen } = await pageThrough('marketCap', 'smoke', 2)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(NAMES.length)
  })

  it('volume sayfalamasi da (hepsi SIFIR hacimli)', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(DISTINCT volume_24h_wei)::text AS n FROM token_overview',
    )
    expect(rows[0]!.n).toBe('1')
    const { seen } = await pageThrough('volume', 'smoke', 2)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(NAMES.length)
  })

  it('`_seq` anahtarlari PAKETLENMEZ -- zaten birebirdirler', async () => {
    for (const sort of ['newest', 'oldest', 'recentBuys'] as const) {
      expect(SEARCH_SORT_KEYS).toContain(sort)
    }
    const { seen } = await pageThrough('newest', 'smoke', 2)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(NAMES.length)
    const oldest = await pageThrough('oldest', 'smoke', 2)
    expect(oldest.seen).toEqual([...seen].reverse())
  })

  it('recentBuys hic alim gormemis token u GOSTERMEZ', async () => {
    const page = await searchTokens(pool, 'smoke', { sort: 'recentBuys', limit: 50 })
    expect(page.rows).toHaveLength(0)
  })
})

/**
 * HOLDER SAYFALAMA.
 *
 * Bakiyeler tekrar eder ve en cok kuyrukta tekrar eder. Buradaki kume onu
 * BILEREK kotu yapiyor: alti holder, HEPSI ayni bakiyede.
 */
describe('holders: iki parcali imlec', () => {
  const HOLDERS = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66].map((n) => addr(n))
  const EQUAL = 1_000n * 10n ** 18n

  beforeAll(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await applyLaunch(pool, {
      ...launch(0, 'HOLD', 'HLD'),
      token: TOKEN,
      curve: CURVE,
    })
    // Arz curve'e basilir; sonra HERKESE AYNI miktar gider. Gercek yazici
    // kullaniliyor -- bakiyeler elle INSERT edilseydi, `listHolders`in
    // uzerinde kostugu satirlar uretimde olusanlarla ayni sekilde
    // olustuklarini GOSTERMEZDI.
    await applyTransfer(pool, {
      kind: 'transfer',
      eventSeq: toSeq(54_400_001n, 0),
      blockNumber: 54_400_001n,
      logIndex: 0,
      txHash: hash32(0xbeef),
      blockTime: T0,
      token: TOKEN,
      from: addr(0),
      to: CURVE,
      amountTok: PROFILE.totalSupplyTok,
    })
    for (const [i, holder] of HOLDERS.entries()) {
      await applyTransfer(pool, {
        kind: 'transfer',
        eventSeq: toSeq(54_400_002n + BigInt(i), 0),
        blockNumber: 54_400_002n + BigInt(i),
        logIndex: 0,
        txHash: hash32(0xbeef1 + i),
        blockTime: T0,
        token: TOKEN,
        from: CURVE,
        to: holder as Address,
        amountTok: EQUAL,
      })
    }
    await setCursor(pool, 54_400_100n, hashFor(54_400_100n), 54_400_100n)
  })

  it('OLCUM: alti holder, TEK bir bakiye degeri', async () => {
    const rows = await listHolders(pool, TOKEN, { limit: 50 })
    expect(rows).toHaveLength(HOLDERS.length)
    expect(new Set(rows.map((r) => r.balanceTok.toString())).size).toBe(1)
  })

  it('sayfalama HICBIR holder i tekrarlamaz, HICBIRINI atlamaz', async () => {
    const seen: string[] = []
    let after = null as ReturnType<typeof parseHolderCursor>
    for (let page = 0; page < 50; page += 1) {
      const rows = await listHolders(pool, TOKEN, { after, limit: 1 })
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.holder))
      after = parseHolderCursor(encodeHolderCursor(rows[rows.length - 1]!))
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(HOLDERS.length)
    // VE SIRA KARARLIDIR: esit bakiyede adres artan.
    expect(seen).toEqual([...seen].sort())
  })

  it('NEGATIF KONTROL: yalnizca bakiyeye dayanan imlec GERCEKTEN kirilir', async () => {
    // Ikinci anahtar OLMADAN, `balance_tok < imlec` esitlerin TAMAMINI atar:
    // ilk sayfadan sonra liste biter, oysa bes holder daha var.
    const { rows: first } = await pool.query<{ holder: string; balance_tok: string }>(
      `SELECT holder, balance_tok::text AS balance_tok FROM holders h
        JOIN curve_state c ON c.token = h.token
       WHERE h.token = $1 AND h.balance_tok > 0 AND h.holder <> c.curve
       ORDER BY h.balance_tok DESC, h.holder ASC LIMIT 1`,
      [TOKEN],
    )
    const { rows: second } = await pool.query<{ holder: string }>(
      `SELECT holder FROM holders h JOIN curve_state c ON c.token = h.token
        WHERE h.token = $1 AND h.balance_tok > 0 AND h.holder <> c.curve
          AND h.balance_tok < $2::numeric
        ORDER BY h.balance_tok DESC, h.holder ASC LIMIT 1`,
      [TOKEN, first[0]!.balance_tok],
    )
    expect(second).toHaveLength(0)
    // Oysa gercekten BES holder daha var.
    const real = await listHolders(pool, TOKEN, {
      after: parseHolderCursor(`${first[0]!.balance_tok}:${first[0]!.holder}`),
      limit: 50,
    })
    expect(real).toHaveLength(HOLDERS.length - 1)
  })

  it('curve HER SAYFADA haric tutulur', async () => {
    const seen: string[] = []
    let after = null as ReturnType<typeof parseHolderCursor>
    for (let page = 0; page < 50; page += 1) {
      const rows = await listHolders(pool, TOKEN, { after, limit: 2 })
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.holder))
      after = parseHolderCursor(encodeHolderCursor(rows[rows.length - 1]!))
    }
    expect(seen).not.toContain(CURVE)
    // Curve GERCEKTEN bir satir olarak duruyor ve EN BUYUK bakiyeyi tasiyor --
    // yani filtre calisiyor, veri eksik degil.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT balance_tok::text AS n FROM holders WHERE holder = $1',
      [CURVE],
    )
    expect(BigInt(rows[0]!.n)).toBeGreaterThan(EQUAL)
  })

  it('imlec yuvarlagi: kodla, coz, ayni', async () => {
    const cursor = { balanceTok: 12345678901234567890n, holder: addr(0xabc) }
    expect(parseHolderCursor(encodeHolderCursor(cursor))).toEqual(cursor)
  })

  it('BOZUK imlec ILK SAYFADIR, hata degil', async () => {
    for (const bad of [
      '',
      'x',
      '12',
      '12:0xZZ',
      ':0x' + '0'.repeat(40),
      '-1:0x' + '0'.repeat(40),
    ]) {
      expect(parseHolderCursor(bad)).toBeNull()
    }
    expect(parseHolderCursor(null)).toBeNull()
    expect(parseHolderCursor(undefined)).toBeNull()
    // Ve bozuk bir imlec listeyi BASTAN verir -- 500 degil.
    const rows = await listHolders(pool, TOKEN, { after: parseHolderCursor('x'), limit: 50 })
    expect(rows).toHaveLength(HOLDERS.length)
  })

  it('imlec BUYUK HARFLI adresle de kodlanir (veritabani kucuk harf tutar)', async () => {
    const encoded = encodeHolderCursor({ balanceTok: 1n, holder: '0xABCDEF' + '0'.repeat(34) })
    expect(encoded).toBe(`1:0xabcdef${'0'.repeat(34)}`)
  })
})

/**
 * 008'IN SEMAYA YAPTIKLARI.
 *
 * Adlandirma kapisi SUTUNLARI okur. Bir extension SUTUN GETIRSEYDI, kapinin
 * `EXPECTED_INVENTORY` kumesi degisir ve bu commit "kapiyi genisleten" bir
 * commit olurdu. Getirmedigi IDDIA EDILMIYOR, OLCULUYOR.
 */
describe('migration 008', () => {
  beforeAll(resetSchema)

  it('pg_trgm KURULU ve `public` icinde', async () => {
    const { rows } = await pool.query<{ v: string; s: string }>(
      `SELECT e.extversion AS v, n.nspname AS s FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'`,
    )
    expect(rows[0]?.s).toBe('public')
    expect(rows[0]?.v).toMatch(/^\d+\.\d+$/)
  })

  it('extension SIFIR sutun getirir -- adlandirma kapisi HIC oynamaz', async () => {
    // Extension'a AIT olup da sutun tasiyan bir iliski var mi? Cevap sifir
    // olmali; olmasaydi `naming.test.ts`in envanteri degisirdi ve bu commit
    // yeni bir sonek bildirmek zorunda kalirdi.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_depend d
         JOIN pg_extension e ON e.oid = d.refobjid AND e.extname = 'pg_trgm'
         JOIN pg_class c ON c.oid = d.objid
        WHERE d.refclassid = 'pg_extension'::regclass
          AND c.relkind = ANY ('{r,p,v,m,f}')`,
    )
    expect(rows[0]!.n).toBe('0')
    // Ve extension GERCEKTEN bir seyler getirdi (fonksiyonlar) -- yani
    // yukaridaki sifir, "extension yok" demek degil.
    const { rows: fns } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_depend d
         JOIN pg_extension e ON e.oid = d.refobjid AND e.extname = 'pg_trgm'
        WHERE d.refclassid = 'pg_extension'::regclass AND d.classid = 'pg_proc'::regclass`,
    )
    expect(Number(fns[0]!.n)).toBeGreaterThan(20)
  })

  it('holder sayfalama indeksi VAR ve siranin kendisidir', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'holders_token_balance_idx'`,
    )
    expect(rows[0]?.def).toMatch(/balance_tok DESC, holder\)?/)
    expect(rows[0]?.def).toMatch(/WHERE \(balance_tok > \(0\)::numeric\)/)
  })

  it('trigram indeksleri PLANDA kullanilabilir (olu agirlik degil)', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      for (const predicate of [`name ILIKE '%smo%'`, `name % 'smoke'`]) {
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) SELECT token FROM launches WHERE ${predicate}`,
        )
        const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
        expect(plan, predicate).toContain('launches_name_trgm_idx')
      }
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  // ---------------------------------------------------------------
  // PAKETLEMENIN ON KOSULLARI YAZMA ZAMANINDA ZORLANIR.
  //
  // `anahtar = miktar * 2^63 + created_seq` yalnizca miktar NEGATIF DEGILSE ve
  // `created_seq` [0, 2^63) araligindaysa BIREBIRDIR. Bunlari "olamaz" diye
  // gecmek, yazilmamis bir on kosul olurdu -- tam olarak bu projenin ariza
  // kipi 3'u. Uc kisit da CALISTIRILARAK sinaniyor.
  // ---------------------------------------------------------------
  const rejects: [string, string, string][] = [
    [
      'launches.created_seq NEGATIF olamaz',
      `INSERT INTO launches (token,curve,launch_creator,name,symbol,uri,name_hex,symbol_hex,
         uri_hex,salt,created_seq,created_at,tx_hash)
       VALUES ('0x${'1'.repeat(40)}','0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','n','s','u',
               '0x6e','0x73','0x75','0x${'0'.repeat(64)}',-1,now(),'0x${'0'.repeat(64)}')`,
      'launches_created_seq_is_nonnegative',
    ],
    [
      'curve_state rezervleri NEGATIF olamaz',
      `UPDATE curve_state SET real_quote_reserves_wei = -1`,
      'curve_state_reserves_are_nonnegative',
    ],
    [
      'token_stats miktarlari NEGATIF olamaz',
      `UPDATE token_stats SET volume_24h_wei = -1`,
      'token_stats_amounts_are_nonnegative',
    ],
  ]
  for (const [what, sql, constraint] of rejects) {
    it(what, async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // UPDATE'lerin bos kumede gecmemesi icin once bir launch kurulur.
        await putDeployment(client, DEPLOYMENT)
        await applyLaunch(client, launch(0, 'CHECKED', 'CHK'))
        const error = await client.query(sql).then(
          () => null,
          (e: Error & { constraint?: string }) => e,
        )
        expect(error, what).not.toBeNull()
        expect(error?.constraint).toBe(constraint)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })
  }
})
