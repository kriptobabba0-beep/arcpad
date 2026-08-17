import { beforeAll, describe, expect, it } from 'vitest'

import { applyLaunch } from '../src/apply'
import type { LaunchEvent } from '../src/apply'
import { putDeployment } from '../src/deployment'
import { toHexBytes } from '../src/hex'
import { SORTS, type SortKey } from '../src/queries'
import { toSeq } from '../src/seq'
import { addr, DEPLOYMENT, hash32 } from './fixtures'
import { pool, resetSchema } from './setup'

/**
 * ============================================================================
 *  BINLERCE TOKEN -- SIRALAMA BIR INDEKSTEN MI GELIYOR, YOKSA HER SAYFA
 *  YUKLENISINDE TABLONUN TAMAMI MI SIRALANIYOR?
 * ============================================================================
 *
 * NICIN BU TEST VAR. Explore'un her sekmesi `token_overview`u bir
 * `ORDER BY ... LIMIT 24` ile okur. Yedi tokenle her sirali sorgu hizlidir --
 * `paging.test.ts` yedi tokenle kosar ve HAKLI OLARAK baska bir sey olcer
 * (sinirdaki `OFFSET`, `count(*)`, ifadenin gecerli SQL olmasi). Ama "hizli"
 * ile "OLCEKLENIR" ayni sey degildir: indekssiz bir siralama yedi satirda
 * gorunmez, on binde her istegi tabloyu tarayip siralamaya zorlar. Binlerce
 * kullanicinin ayni anda gezindigi bir platformda ilk coken sey budur.
 *
 * ============ OLCULEN SEY LATENCY DEGIL, PLANIN SEKLI ============
 *
 * Bir sure butcesi (`< 250ms`) makineye baglidir: CI kosucusu yavaslar, test
 * kirmizi olur, kimse bir sey ogrenmez. Bunun yerine PLAN okunur: siralama
 * anahtari bir indeksten geliyorsa Postgres SIRALI BIR INDEKS TARAMASI yapar
 * ve planda **`Sort` dugumu OLMAZ**. Gelmiyorsa mutlaka bir `Sort` vardir --
 * ve o `Sort`, `LIMIT` ne kadar kucuk olursa olsun, ONCE butun satirlari
 * uretmek zorundadir.
 *
 * Bu iddia makineden, kosucu hizindan ve satir sayisindan BAGIMSIZDIR. Ve
 * yeterince satir olmadan da anlamsizdir: kucuk tablolarda planlayici zaten
 * sirali taramayi secmez, o yuzden tohumlanan sayi indeks secimini MESRU
 * kilacak kadar buyuk olmali.
 */

/** Planlayicinin indeksi seri taramaya tercih etmesi icin yeterli satir. */
const TOKENS = 3_000

/** Explore'un sayfa boyu. Bir `Sort` bundan fazlasini islerse maliyet TOKEN
 *  SAYISIYLA buyur -- iddia tam olarak bu. `listTokens`in varsayilani 50, ama
 *  Explore 24 ile cagirir; olculen sey urunun kullandigi sayidir. */
const PAGE = 24

const T0 = new Date('2026-08-17T00:00:00.000Z')

function launch(i: number): LaunchEvent {
  const block = 60_000_000n + BigInt(i)
  const name = `SCALE${i}`
  const symbol = `S${i}`
  const uri = `ipfs://scale-${i}`
  return {
    kind: 'launch',
    eventSeq: toSeq(block, 0),
    blockNumber: block,
    logIndex: 0,
    txHash: hash32(0x5ca10000 + i),
    blockTime: new Date(T0.getTime() + i * 1_000),
    token: addr(0x100000 + i),
    curve: addr(0x200000 + i),
    creator: addr(0xc4ea),
    name,
    symbol,
    uri,
    nameHex: toHexBytes(name),
    symbolHex: toHexBytes(symbol),
    uriHex: toHexBytes(uri),
    salt: hash32(0x5a170000 + i),
    virtualTokenReservesTok: DEPLOYMENT.virtualTokenReservesTok,
    virtualQuoteReservesWei: DEPLOYMENT.virtualQuoteReservesWei,
    realTokenReservesTok: DEPLOYMENT.saleSupplyTok,
    realQuoteReservesWei: 0n,
  }
}

/**
 * `queries.ts`in KENDI ifadesiyle bir sayfa sorgusu kurar.
 *
 * Anahtar `SORTS`tan OKUNUR, buraya kopyalanmaz -- kopyalasaydi bir siralama
 * degistiginde bu test yesil kalirdi ve olcum, olctugunu sandigi seyi
 * olcmezdi. `listTokens`in urettigi SQL ile ayni sekil.
 */
function pageSql(sort: SortKey): string {
  const { key, desc } = SORTS[sort]
  const where = sort === 'recentBuys' ? 'WHERE last_buy_seq IS NOT NULL' : ''
  return `SELECT *, (${key})::text AS cursor_key FROM token_overview
          ${where}
          ORDER BY ${key} ${desc ? 'DESC' : 'ASC'} LIMIT ${PAGE}`
}

async function planOf(sql: string): Promise<string> {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)
  return rows.map((r) => r['QUERY PLAN']).join('\n')
}

type PlanNode = {
  'Node Type': string
  'Actual Rows'?: number
  Plans?: PlanNode[]
}

/**
 * `EXPLAIN (ANALYZE, FORMAT JSON)` -- ve NICIN metin plani yetmiyor.
 *
 * Metin planinda "`Sort` var mi" diye bakmak KABA bir olcuttur: kucuk bir
 * `Sort` (ornegin 24 satirlik bir birlestirme) zararsizdir, tabloyu bastan
 * sona siralayan bir `Sort` ise her sayfa yuklenisinde token sayisi kadar is
 * demektir. Ikisini ayiran sey dugumun ISLEDIGI SATIR SAYISIDIR.
 *
 * Bu, makineden ve kosucu hizindan BAGIMSIZ bir olcumdur -- bir sure butcesi
 * degildir. CI kosucusu yavaslarsa sayi degismez.
 */
async function analyze(sql: string): Promise<PlanNode> {
  const { rows } = await pool.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
  )
  const plan = rows[0]?.['QUERY PLAN']?.[0]?.Plan
  if (plan === undefined) throw new Error('EXPLAIN JSON plani okunamadi')
  return plan
}

function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node)
  for (const child of node.Plans ?? []) walk(child, visit)
}

/**
 * Bir `Sort` dugumune GIREN en fazla satir sayisi. `Sort` yoksa sifir.
 *
 * ============ `Actual Rows` DUGUMUN CIKTISIDIR, GIRDISI DEGIL ============
 *
 * ILK SURUM `Sort` dugumunun kendi `Actual Rows`unu okudu ve YANLIS OLCTU.
 * CI gosterdi: `marketCap` planinda iki `Sort` dugumu VAR ama ikisinin de
 * `Actual Rows`u **24**. Sebep Postgres'in `top-N heapsort`u -- 3.000 satiri
 * OKUR, yalnizca 24'unu VERIR. Yani "en genis Sort 24" sonucu, tabloyu bastan
 * sona siralayan bir plani MASUM gosteriyordu.
 *
 * Olculmesi gereken sey siralamaya GIREN satir sayisidir ve o, dugumun
 * COCUGUNUN `Actual Rows`udur. Bu duzeltmeden sonra iddia gercekten
 * "tabloyu siraliyor mu" sorusunu sorar.
 *
 * Metrik hala makineden bagimsizdir: bir satir sayisi, bir sure degil.
 */
function widestSortInput(plan: PlanNode): number {
  let widest = 0
  walk(plan, (node) => {
    if (node['Node Type'] !== 'Sort') return
    for (const child of node.Plans ?? []) {
      widest = Math.max(widest, child['Actual Rows'] ?? 0)
    }
  })
  return widest
}

describe(`token_overview, ${TOKENS} token`, () => {
  beforeAll(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    /*
     * TEK ISLEMDE TOHUMLAMA. Uc bin `applyLaunch` ayri ayri islenirse test
     * dakikalar surer; hepsi tek transaction'da ise saniyeler. `applyLaunch`
     * bir `Queryable` alir, yani bir client de gecer.
     */
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < TOKENS; i += 1) await applyLaunch(client, launch(i))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    // Planlayici istatistik olmadan dogru secim yapamaz; `ANALYZE` bu testin
    // on kosulu, bir suslemesi degil.
    await pool.query('ANALYZE')
  }, 300_000)

  it('tohumlama gercekten uc bin satir uretti', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM token_overview',
    )
    expect(Number(rows[0]?.n)).toBe(TOKENS)
  })

  /**
   * HER SIRALAMANIN PLANI KAYDA GECER -- GECSE DE GECMESE DE.
   *
   * Bir esik yalnizca kirildiginda gorunuyorsa, ilk kirildiginda YUKSELTILIR.
   * Bu yuzden yedi siralamanin plan sekli her kosuda basilir ve iddia ayri
   * durur.
   */
  it('yedi siralamanin PLAN SEKLI kayda gecer', async () => {
    const lines: string[] = []
    for (const sort of Object.keys(SORTS) as SortKey[]) {
      const plan = await planOf(pageSql(sort))
      const sorts = (plan.match(/\bSort\b/g) ?? []).length
      lines.push(`${sort.padEnd(16)} Sort=${sorts}`)
    }
    console.warn(`[scale] token_overview siralama planlari:\n  ${lines.join('\n  ')}`)
    expect(lines).toHaveLength(Object.keys(SORTS).length)
  })

  /**
   * ============ ASIL IDDIA ============
   *
   * Siralama anahtari indeksten geliyorsa plan `Sort` ICERMEZ. Iceriyorsa
   * `LIMIT 24` bir sey kurtarmaz: `Sort` once butun satirlari uretir, yani
   * maliyet TOKEN SAYISIYLA buyur ve her sayfa yuklenisinde odenir.
   */
  /**
   * ============ HANGI SIRALAMALARIN INDEKSTEN GELMESI BEKLENIR ============
   *
   * `marketCap` ve `nearGraduation` BU LISTEDE YOK, ve bu bir gevsetme degil
   * OLCULMUS bir kayittir (`017_sort_keys.sql` §ACIK BIRAKILANLAR):
   *
   *   * `marketCap` -- BIR URUN KARARI bekliyor, bakim isi degil. `ts.market_
   *     cap_wei` mezuniyetten SONRA havuz fiyatini izler (`apply/pool.ts`),
   *     view ise egriden hesaplar ve egri mezuniyette DONAR -- yani ikisi
   *     bayatliktan degil TASARIMDAN ayrisir. View'i `ts`e baglamak mezun
   *     tokenlerin GOSTERILEN market cap'ini degistirirdi; denendi, dokuz test
   *     dustu ve o testler bugunku anlami kodluyordu.
   *   * `nearGraduation` -- COZULEBILIR: `progress_ppm` `curve_state` x
   *     `deployment`ten hesaplanir ve `token_stats`te bir evi yok, ama `_ppm`
   *     zaten bildirilmis bir sonek ve bakim noktasi `applyTrade`in MEVCUT
   *     `st` CTE'sidir. AYRI bir CTE olmaz: Postgres tek ifadede ayni satiri
   *     iki kez guncellemeyi desteklemez, ikinci etki sessizce kaybolur.
   *
   * IKISI DE `it.each`TEN CIKARILMADI, `EXPECTED_INDEXED`E EKLENMEDI: plan
   * sekilleri yukarida HER KOSUDA basilir, yani ikisinin `Sort=2` oldugu
   * gorunur kalir. Kirmizi bir kapi degil, GORUNUR bir borc.
   *
   * `volume` BU LISTEDE, VE BIR KEZ HAKSIZ YERE CIKARILMISTI: geri alinma
   * sebebi bir e2e testinin dusmesiydi, ama o test Explore'un OKUMADIGI bir
   * `?sort=` parametresini suruyordu -- hata bu degisiklikten degil, silinmis
   * bir URL sozlesmesinden geliyordu. `test/sort-keys.test.ts` artik dayandigi
   * esitligi burada, arayuzden bagimsiz olarak zorluyor.
   */
  const EXPECTED_INDEXED: readonly SortKey[] = [
    'recentBuys',
    'newest',
    'oldest',
    'volume',
    'marketCap',
  ]

  it.each(EXPECTED_INDEXED)(
    '%s: hicbir `Sort` dugumu bir SAYFADAN fazlasini islemez',
    async (sort) => {
      const plan = await analyze(pageSql(sort))
      const widest = widestSortInput(plan)
      expect(
        widest,
        `"${sort}" siralamasinda bir \`Sort\` dugumu ${widest} satir isledi (sayfa 24). ` +
          `${TOKENS} satirda bu, LIMIT ne kadar kucuk olursa olsun HER sayfa ` +
          'yuklenisinde odenir ve token sayisiyla buyur -- siralama anahtari bir ' +
          'indeksten GELMIYOR demektir.',
      ).toBeLessThanOrEqual(PAGE)
    },
  )

  /**
   * ============ EXPLORE'UN GERCEK ISTEK MALIYETI: SAYFA **VE** SAYIM ============
   *
   * `app/(explore)/page.tsx` `withTotal: true` gecer, cunku numarali sayfalayici
   * kac sayfa cizecegini bilmek zorunda. Yani her istek IKI sorgu kosar ve
   * ikincisi `count(*) FROM token_overview` -- BES TABLONUN JOIN'I uzerinde.
   *
   * Ve bu istek basina bir kez DEGIL: `LiveRefresh` gorunur her sekmede on
   * saniyede bir `router.refresh()` cagirir, yani sayim gorunur kullanici
   * basina 10 saniyede bir tekrarlanir. (Arka plan sekmeleri bedava --
   * `document.hidden` iken zamanlayici durur.)
   *
   * Bu test sayimi YASAKLAMAZ: urun onu istiyor. Olctugu sey, sayimin
   * SIRALAMA yapmadigi -- yani sayfa sorgusunun ustune ikinci bir tam siralama
   * BINMEDIGI. Maliyetin kendisi (kac satir taranir) rapora yazilir, cunku
   * yalnizca kirildiginda gorunen bir sayi, ilk kirildiginda yukseltilir.
   */
  /**
   * ACIK BORC OLCULUR, VARSAYILMAZ.
   *
   * `marketCap` ve `nearGraduation` bugun tabloyu siraliyor. Bu test o
   * durumu SABITLER: biri duzeltilirse test kirilir ve `EXPECTED_INDEXED`e
   * tasinmasi gerektigini SOYLER. Aksi halde bir duzeltme sessizce olculmemis
   * kalirdi -- ve bu depo tam olarak o sinifi tekrar tekrar odedi.
   */
  it.each(['nearGraduation'] as SortKey[])(
    '%s HALA tabloyu siraliyor -- acik borc, ve olculuyor',
    async (sort) => {
      const widest = widestSortInput(await analyze(pageSql(sort)))
      expect(
        widest,
        `"${sort}" artik siralamiyor. Bu IYI haber: EXPECTED_INDEXED'e tasi ve ` + 'bu satiri sil.',
      ).toBeGreaterThan(PAGE)
    },
  )

  it('numarali sayfalayicinin `count(*)`i SIRALAMA yapmaz', async () => {
    const plan = await analyze('SELECT count(*)::text AS n FROM token_overview')
    const widest = widestSortInput(plan)
    console.warn(
      `[scale] count(*) FROM token_overview @ ${TOKENS} satir: ` +
        `kok dugum ${plan['Node Type']}, Sort'a giren ${widest}`,
    )
    expect(
      widest,
      `sayim ${widest} satiri siralamaya soktu -- bir \`count(*)\` siralama YAPMAMALI.`,
    ).toBe(0)
  })
})
