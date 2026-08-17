import { beforeAll, describe, expect, it } from 'vitest'

import { applyLaunch, applyTrade } from '../src/apply'
import type { LaunchEvent, TradeEvent } from '../src/apply'
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
 * `launch(i)`nin curve'unde bir ALIM.
 *
 * MIKTAR `i` ILE DEGISIR, ve bu kasitli: sabit bir miktar butun satirlara ayni
 * `volume_24h_wei` ve `market_cap_wei`i yazardi, yani `volume`/`marketCap`
 * planlari TAMAMEN ESIT degerler uzerinde olculurdu. Esitlik altinda paketlenmis
 * anahtar `created_seq`e yozlasir ve olcum, gercek bir dagilimda ne olacagini
 * SOYLEMEZ. Modulo ile sinirli tutulur (`% 97`), yoksa 3.000. tokenin rezervi
 * satis arzini asardi.
 */
function trade(i: number): TradeEvent {
  const block = 60_000_000n + BigInt(i)
  const step = BigInt((i % 97) + 1)
  const tokens = step * 1_000_000n * 10n ** 18n
  const quote = step * 28_000_000_000_000n
  return {
    kind: 'trade',
    // logIndex 1: launch AYNI blokta logIndex 0'da, yani `event_seq` cakismaz.
    eventSeq: toSeq(block, 1),
    blockNumber: block,
    logIndex: 1,
    txHash: hash32(0x7ade0000 + i),
    blockTime: new Date(T0.getTime() + i * 1_000 + 500),
    token: addr(0x100000 + i),
    curve: addr(0x200000 + i),
    trader: addr(0xa11ce),
    isBuy: true,
    tokenAmountTok: tokens,
    quoteAmountWei: quote,
    protocolFeeWei: quote / 80n,
    creatorFeeWei: quote / 250n,
    virtualTokenReservesTok: DEPLOYMENT.virtualTokenReservesTok - tokens,
    virtualQuoteReservesWei: DEPLOYMENT.virtualQuoteReservesWei + quote,
    realTokenReservesTok: DEPLOYMENT.saleSupplyTok - tokens,
    realQuoteReservesWei: quote,
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
      /*
       * ============ ISLEMLER DE TOHUMLANIR, VE BU BIR DUZELTMEDIR ============
       *
       * ONCEKI HALI YALNIZCA LAUNCH TOHUMLUYORDU VE `recentBuys` OLCUMU BOSTU.
       *
       * O siralamanin sorgusu `WHERE last_buy_seq IS NOT NULL` suzer (bkz.
       * `pageSql`). Hic islem yoksa `last_buy_seq` her satirda NULL'dur, yani
       * sorgu SIFIR satir dondurur -- ve "hicbir `Sort` bir sayfadan fazlasini
       * islemez" iddiasi BOS KUMEDE bedava gecer. Kapi aylarca dogru sebeple
       * gecmis gibi gorundu.
       *
       * OLCUMLE YAKALANDI, okumayla degil: `pg_stat_user_indexes` uzerinde
       * `token_stats_last_buy_idx` **sifir tarama** gosterdi -- oysa `recentBuys`
       * `Sort=0` veriyordu. Bir siralamanin indeksten gelmesi ama indeksin hic
       * taranmamasi celiskidir, ve celiskiyi coozen sey sorgunun bos donmesiydi.
       *
       * ALTIDA BIRINE islem verilir: 500 satirda `last_buy_seq` dolu olur --
       * planlayicinin indeksi secmesini MESRU kilacak kadar cok, ve "hic islem
       * gormemis token" dalini korumaya yetecek kadar az. Yan etkisi de
       * iyilestirmedir: `volume_24h_wei` ve `market_cap_wei` artik DEGISIR, yani
       * `volume`/`marketCap` planlari tamamen esit degerler uzerinde degil
       * gercekci bir dagilim uzerinde olculur.
       */
      for (let i = 0; i < TOKENS; i += 6) await applyTrade(client, trade(i))
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

  /**
   * `recentBuys` OLCUMUNUN ON KOSULU: sorgu GERCEKTEN satir donduruyor.
   *
   * Bu iddia olmadan asagidaki `Sort` olcumu bos kumede gecerdi -- ve tam olarak
   * oyle geciyordu. Bir olcumun on kosulu, olcumun kendisi kadar onemlidir.
   */
  it('`recentBuys` sorgusu BOS DONMUYOR -- yoksa plan olcumu vakumda gecer', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM token_overview WHERE last_buy_seq IS NOT NULL',
    )
    const n = Number(rows[0]?.n)
    expect(n, '`last_buy_seq` dolu satir olmali, yoksa `recentBuys` hicbir sey olcmez').toBe(
      Math.ceil(TOKENS / 6),
    )
  })

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
  /**
   * ============ RAPOR INDEKS ADLARINI DA YAZAR, VE BU BIR DUZELTMEDIR ============
   *
   * Onceki hali yalnizca `Sort=N` basiyordu ve o sayi TEK BASINA yetersizdir:
   * `Sort=0`, "siralama bir indeksten geldi" demek de olabilir, "sorgu SIFIR
   * satir dondurdu" demek de. Ikisi ayni satiri uretir.
   *
   * VE IKINCISI GERCEKTEN OLDU: `recentBuys` hic islem tohumlanmadigi icin bos
   * donuyordu ve `Sort=0` bedava geciyordu (bkz. `beforeAll`). Indeks adlarini
   * basmak o durumu ANINDA ele verir -- bos bir sonucta hicbir indeks gorunmez.
   *
   * Yani bu satir bir susleme degil, olcumun KENDISININ kanitidir.
   */
  it('siralama planlari VE kullanilan indeksler kayda gecer', async () => {
    const lines: string[] = []
    for (const sort of Object.keys(SORTS) as SortKey[]) {
      const plan = await planOf(pageSql(sort))
      const sorts = (plan.match(/\bSort\b/g) ?? []).length
      // `EXPLAIN`in metin cikti bicimi: "Index Scan using <ad> on <tablo>".
      const used = [...plan.matchAll(/using ([a-z0-9_]+)/g)].map((m) => m[1])
      const uniq = [...new Set(used)]
      lines.push(
        `${sort.padEnd(16)} Sort=${sorts}  indeks=${uniq.length === 0 ? '(YOK)' : uniq.join(',')}`,
      )
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
    'nearGraduation',
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
   * ============ ACIK BORC KALMADI, VE KAPI BUNU SABITLER ============
   *
   * Burada bir "hala siraliyor" testi VARDI ve gorevini yapti: `marketCap` ile
   * `nearGraduation`i olculmus borc olarak kirmizi tuttu, ve ikisi de
   * duzeltilince kirilip "EXPECTED_INDEXED'e tasi" dedi. Artik listeleyecek borc
   * olmadigi icin yerini DAHA GUCLU bir iddia aldi.
   *
   * NICIN BU IDDIA: `EXPECTED_INDEXED` elle yazilan bir listedir. Yarin `SORTS`a
   * yeni bir siralama eklenirse, o siralama bu listeye eklenmedigi surece hicbir
   * test ondan HABERDAR OLMAZ -- yani indekssiz bir siralama sessizce urune
   * girer. Kapsamin kendisi olculursa bu mumkun degildir: yeni anahtar ya
   * listeye girer (ve indeks iddiasi onun icin de kosar) ya da bu test duser.
   *
   * `SORTS`tan OKUNUR, sayi YAZILMAZ: "alti" yazmak, altinci eklendiginde
   * guncellenmesi gereken ikinci bir yer olurdu.
   */
  it('HER `SORTS` anahtari indeks iddiasinin KAPSAMINDA -- kapsam olculur', () => {
    const all = Object.keys(SORTS) as SortKey[]
    const missing = all.filter((k) => !EXPECTED_INDEXED.includes(k))
    expect(
      missing,
      `bu siralamalar hicbir iddianin kapsaminda degil: ${missing.join(', ')}. ` +
        'Ya indeksten geldiklerini gosterip `EXPECTED_INDEXED`e ekle, ya da ' +
        'olculmus borc olarak ayri bir iddia yaz -- kapsamsiz birakma.',
    ).toEqual([])
    // Ve liste UYDURULMUS anahtar tasimaz (yeniden adlandirma sonrasi artik).
    expect(EXPECTED_INDEXED.filter((k) => !all.includes(k))).toEqual([])
  })

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
