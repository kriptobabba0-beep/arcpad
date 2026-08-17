import { beforeEach, describe, expect, it } from 'vitest'

import { applyLaunch, applyTrade, setCursor } from '../src/apply'
import type { LaunchEvent } from '../src/apply'
import { putDeployment } from '../src/deployment'
import { toHexBytes } from '../src/hex'
import { listTokens, SORTS } from '../src/queries'
import { toSeq } from '../src/seq'
import { addr, BUY, DEPLOYMENT, hash32, hashFor, PROFILE } from './fixtures'
import { pool, resetSchema } from './setup'

/**
 * ==========================================================================
 *  NUMARALI SAYFA (`OFFSET`), TOPLAM SAYIM, VE `nearGraduation` SIRASI.
 * ==========================================================================
 *
 * Ucu de urunun "All launches" bolumu icin indi ve ucu de GERCEK Postgres'e
 * karsi olculmeli: `OFFSET`in sinirdaki davranisi, `count(*)`in sayfa
 * parametrelerinden BAGIMSIZ olmasi ve `search_key(progress_ppm, created_seq)`
 * ifadesinin gecerli SQL olmasi -- ucu de bir birim testinin goremeyecegi
 * seyler. Ozellikle sonuncusu: yanlis yazilmis bir `ORDER BY`, ancak
 * calistirilinca patlar.
 */
const COUNT = 7
const T0 = new Date('2026-07-30T12:00:00.000Z')

function launch(i: number): LaunchEvent {
  const block = 54_600_000n + BigInt(i)
  const name = `PAG${i}`
  return {
    kind: 'launch',
    eventSeq: toSeq(block, 0),
    blockNumber: block,
    logIndex: 0,
    txHash: hash32(0x9a600000 + i),
    blockTime: T0,
    token: addr(0x9a60 + i),
    curve: addr(0xca60 + i),
    creator: addr(0xc4ea),
    name,
    symbol: name,
    uri: `ipfs://pag${i}`,
    nameHex: toHexBytes(name),
    symbolHex: toHexBytes(name),
    uriHex: toHexBytes(`ipfs://pag${i}`),
    salt: hash32(0x5a600000 + i),
    virtualTokenReservesTok: PROFILE.virtualTokenReservesTok,
    virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei,
    realTokenReservesTok: PROFILE.saleSupplyTok,
    realQuoteReservesWei: 0n,
  }
}

describe('listTokens -- numarali sayfa', () => {
  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    for (let i = 0; i < COUNT; i += 1) await applyLaunch(pool, launch(i))
    await setCursor(pool, 54_600_100n, hashFor(54_600_100n), 54_600_100n)
  })

  it('`offset` sayfayi KAYDIRIR, ve ardisik sayfalar ortusmez', async () => {
    const p1 = await listTokens(pool, { sort: 'newest', limit: 3, offset: 0 })
    const p2 = await listTokens(pool, { sort: 'newest', limit: 3, offset: 3 })
    const p3 = await listTokens(pool, { sort: 'newest', limit: 3, offset: 6 })

    expect(p1.rows).toHaveLength(3)
    expect(p2.rows).toHaveLength(3)
    expect(p3.rows).toHaveLength(1)

    const all = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.token)
    expect(new Set(all).size).toBe(COUNT)
  })

  it('son sayfanin otesindeki bir `offset` BOS doner, hata degil', async () => {
    const page = await listTokens(pool, { sort: 'newest', limit: 3, offset: 900 })
    expect(page.rows).toEqual([])
  })

  /*
   * TOPLAM SAYIM SAYFA PARAMETRELERINDEN BAGIMSIZDIR.
   *
   * Ilk yazimda `count(*)` ile sayfa sorgusu AYNI parametre dizisini
   * paylasiyordu; `LIMIT`/`OFFSET` o diziye eklendiginde sayim sessizce
   * sayfaya baglanabilirdi. Asagidaki iki iddia birlikte o hatayi tutar:
   * toplam, `limit` degistiginde DE `offset` degistiginde DE ayni kalmali.
   */
  it('`withTotal` filtreye uyan TUM satirlari sayar -- sayfayi degil', async () => {
    const first = await listTokens(pool, { sort: 'newest', limit: 2, withTotal: true })
    expect(first.rows).toHaveLength(2)
    expect(first.total).toBe(COUNT)

    const later = await listTokens(pool, { sort: 'newest', limit: 2, offset: 4, withTotal: true })
    expect(later.total).toBe(COUNT)

    const wide = await listTokens(pool, { sort: 'newest', limit: 50, withTotal: true })
    expect(wide.total).toBe(COUNT)
  })

  it('`withTotal` istenmediginde alan HIC gelmez -- `undefined` "sayilmadi"dir', async () => {
    const page = await listTokens(pool, { sort: 'newest', limit: 2 })
    expect(page.total).toBeUndefined()
  })

  it('toplam sayim YAS PENCERESINE uyar', async () => {
    // Butun fikstur ayni gunde acildi; 1 gunluk pencere hepsini kapsar.
    const inWindow = await listTokens(pool, {
      sort: 'newest',
      limit: 2,
      ageDays: 3650,
      withTotal: true,
    })
    expect(inWindow.total).toBe(COUNT)
  })

  /*
   * IKI SAYFALAMA GARANTISI KARISTIRILAMAZ, VE SESSIZCE BIRI SECILMEZ.
   *
   * `cursor` "su anahtardan sonrasi"dir ve araya giren yazimlardan
   * etkilenmez; `offset` "bastan N satir atla"dir ve canli bir siralama
   * anahtarinda satir tekrarlatir. Ikisini birden alip birini sessizce
   * yok saymak, cagiran tarafin HANGI garantiyi aldigini bilmemesi demektir.
   */
  it('`cursor` ve `offset` BIRLIKTE verilirse REDDEDER', async () => {
    await expect(
      listTokens(pool, { sort: 'newest', limit: 2, cursor: 1n, offset: 2 }),
    ).rejects.toThrow(/cannot be combined/i)
  })

  it.each([
    ['negatif', -1],
    ['ondalik', 1.5],
  ])('%s bir `offset` REDDEDILIR', async (_label, bad) => {
    await expect(listTokens(pool, { sort: 'newest', limit: 2, offset: bad })).rejects.toThrow(
      RangeError,
    )
  })
})

/**
 * `nearGraduation` -- GRADUATION'A EN YAKIN ONCE.
 *
 * Siralama ifadesi `search_key(progress_ppm::numeric, created_seq)`; bir
 * dizgeyi okumak onun ne dondurdugunu OLCMEZ, o yuzden burada gercekten
 * farkli ilerlemelere sahip iki curve uretilip SIRA olculuyor.
 */
describe('listTokens -- nearGraduation', () => {
  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    for (let i = 0; i < 3; i += 1) await applyLaunch(pool, launch(i))
    // Ikinci token'a bir alim: ilerlemesi digerlerinin ONUNE gecer.
    await applyTrade(pool, {
      ...BUY,
      eventSeq: toSeq(54_600_050n, 0),
      blockNumber: 54_600_050n,
      token: addr(0x9a60 + 1),
      curve: addr(0xca60 + 1),
    })
    await setCursor(pool, 54_600_100n, hashFor(54_600_100n), 54_600_100n)
  })

  it('ifade GECERLI SQL -- ve sira ILERLEMEYE gore azalir', async () => {
    const page = await listTokens(pool, { sort: 'nearGraduation', limit: 10 })
    expect(page.rows.length).toBe(3)

    const ppms = page.rows.map((r) => r.progressPpm)
    expect([...ppms]).toEqual([...ppms].sort((a, b) => b - a))
    // Alim alan token EN USTTE: ilerlemesi sifirdan buyuk, otekiler sifir.
    expect(page.rows[0]!.token).toBe(addr(0x9a60 + 1).toLowerCase())
    expect(page.rows[0]!.progressPpm).toBeGreaterThan(0)
  })

  it('ESIT ilerlemeli satirlar KAYBOLMAZ -- anahtar paketlenmis oldugu icin', async () => {
    // Ikisi de sifir ilerlemeli; ciplak bir imlecle ikincisi elenirdi.
    const seen: string[] = []
    let cursor: bigint | null = null
    for (let i = 0; i < 10; i += 1) {
      const page = await listTokens(pool, {
        sort: 'nearGraduation',
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      })
      if (page.rows.length === 0) break
      seen.push(page.rows[0]!.token)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(new Set(seen).size).toBe(3)
  })

  it('`SORTS` anahtari ZAMANA gore siralamaz', () => {
    // Bu deponun kalici kurali: siralama `_seq` ya da paketlenmis miktar
    // uzerindedir, `created_at` gibi bir zaman kolonu uzerinde ASLA -- olculdu,
    // ardisik blok ciftlerinin %49'u ayni timestamp'i tasiyor.
    expect(SORTS.nearGraduation.key).not.toMatch(/_at\b/)
    expect(SORTS.nearGraduation.key).toContain('search_key')
  })
})
