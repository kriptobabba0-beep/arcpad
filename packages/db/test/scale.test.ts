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
          ORDER BY ${key} ${desc ? 'DESC' : 'ASC'} LIMIT 24`
}

async function planOf(sql: string): Promise<string> {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)
  return rows.map((r) => r['QUERY PLAN']).join('\n')
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
  it.each(Object.keys(SORTS) as SortKey[])(
    '%s siralamasi bir INDEKSTEN gelir (planda `Sort` yok)',
    async (sort) => {
      const plan = await planOf(pageSql(sort))
      expect(
        plan,
        `"${sort}" siralamasi tabloyu siraliyor -- ${TOKENS} satirda bu her sayfa ` +
          `yuklenisinde odenir ve token sayisiyla buyur. Plan:\n${plan}`,
      ).not.toMatch(/\bSort\b/)
    },
  )
})
