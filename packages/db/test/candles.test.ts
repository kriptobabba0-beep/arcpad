import { beforeEach, describe, expect, it } from 'vitest'
import { getTokenOverview, getVolumeSplit, listCandles } from '../src/queries'
import { putDeployment } from '../src/deployment'
import { replayRange } from '../src/apply'
import { pool, resetSchema } from './setup'
import { ALICE, DEPLOYMENT, GENESIS, hashFor, RANGE, RANGE_TO, TOKEN } from './fixtures'

/**
 * ============================================================================
 *  MUMLAR VE HACIM AYRIMI
 * ============================================================================
 *
 * Iki sorgu, iki ekran parcasi: mum grafigi ve altindaki yesil/kirmizi cubuk.
 * Asagidaki ILK test hepsinden onemlidir ve digerleri onun etrafinda durur:
 * grafigin son mumu ile sayfanin ustundeki FDV rakami AYNI SAYI olmak
 * zorundadir. Iki farkli ifadeden gelselerdi bir gun ayrisirlardi ve hangisinin
 * dogru oldugunu kimse bilemezdi -- bir launchpad'de bu, bir kullanicinin
 * grafige bakip baska bir fiyattan islem yapmasi demektir.
 */
describe('listCandles', () => {
  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), GENESIS)
  })

  it('SON MUMUN KAPANISI, sayfanin ustundeki FDV ile AYNI SAYIDIR', async () => {
    const candles = await listCandles(pool, TOKEN, { bucketSeconds: 3_600 })
    // `getTokenOverview` SARMALANMIS doner (`{ rows, indexer }`): satirin
    // yanina indexer'in tazeligini koyar, cunku bu sayfadaki her rakam o
    // tazelige baglidir.
    const overview = (await getTokenOverview(pool, TOKEN)).rows

    expect(candles.length).toBeGreaterThan(0)
    expect(overview).not.toBeNull()
    // `market_cap_wei` mulDiv(Vq, N, Vt) ve mum da ayni ifadeden gelir. Bu
    // esitlik bir tercih degil, iki ekran parcasinin ayni gercegi soylemesi.
    expect(candles[candles.length - 1]!.closeWei).toBe(overview!.marketCapWei)
  })

  it('acilis ve kapanis SIRAYA gore, yuksek/dusuk ise uc degerler', async () => {
    const [candle] = await listCandles(pool, TOKEN, { bucketSeconds: 86_400 })
    expect(candle).toBeDefined()
    // Fixture'in ucu de ayni gunde: tek mum, ve icinde en az bir alis bir satis.
    expect(candle!.trades).toBe(3)
    expect(candle!.highWei).toBeGreaterThanOrEqual(candle!.openWei)
    expect(candle!.highWei).toBeGreaterThanOrEqual(candle!.closeWei)
    expect(candle!.lowWei).toBeLessThanOrEqual(candle!.openWei)
    expect(candle!.lowWei).toBeLessThanOrEqual(candle!.closeWei)
    // ACILIS min/max DEGIL: bir satis fiyati dusurur, yani acilis ile dusuk
    // ayni olsaydi sira degil buyukluk kullanilmis olurdu.
    expect(candle!.openWei).not.toBe(candle!.lowWei)
  })

  it('ESKIDEN YENIYE doner -- bir grafik soldan saga cizer', async () => {
    const candles = await listCandles(pool, TOKEN, { bucketSeconds: 1 })
    const times = candles.map((c) => c.bucket.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('KOVA SINIRI UTC epoch tabanlidir, sunucunun saat dilimi degil', async () => {
    const candles = await listCandles(pool, TOKEN, { bucketSeconds: 3_600 })
    for (const candle of candles) {
      const epoch = Math.floor(candle.bucket.getTime() / 1_000)
      // Saatlik kovalar tam saate oturur. `date_trunc('hour')` da bunu yapardi
      // ama bes dakikalik dilimde YAPMAZDI; ayni ifade her dilimde calisir.
      expect(epoch % 3_600).toBe(0)
    }
  })

  it('hacim, mumdaki islemlerin quote toplamidir', async () => {
    const [candle] = await listCandles(pool, TOKEN, { bucketSeconds: 86_400 })
    const split = await getVolumeSplit(pool, TOKEN)
    expect(candle!.volumeWei).toBe(split.volumeWei)
  })

  it('islemi olmayan bir token BOS liste verir, sifir dolu mum degil', async () => {
    // "Hic islem olmadi" ile "hepsi sifirdi" ayni sey degildir, ve bir grafik
    // ikincisini duz bir cizgi olarak cizerdi.
    const candles = await listCandles(pool, '0x00000000000000000000000000000000000000ff')
    expect(candles).toEqual([])
  })
})

describe('getVolumeSplit', () => {
  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), GENESIS)
  })

  it('alis ve satis AYRI sayilir ve toplamlari toplam hacmi verir', async () => {
    const split = await getVolumeSplit(pool, TOKEN)
    expect(split.buys + split.sells).toBe(3)
    expect(split.buys).toBe(2)
    expect(split.sells).toBe(1)
    expect(split.buyVolumeWei + split.sellVolumeWei).toBe(split.volumeWei)
  })

  it('cuzdanlar YONE gore sayilir -- hem alan hem satan iki tarafta da vardir', async () => {
    const split = await getVolumeSplit(pool, TOKEN)
    /*
     * Fixture'da ALICE hem ALDI hem SATTI, BOB yalnizca aldi. Yani:
     *   alan cuzdan   2  (ALICE, BOB)
     *   satan cuzdan  1  (ALICE)
     *   AYRI cuzdan   2  (ALICE, BOB)
     *
     * Iki tarafin toplami (3) ayri cuzdan sayisindan (2) BUYUKTUR ve olmasi
     * gereken de budur: ALICE her iki tarafta da sayilir. Ekran da boyle
     * sunar, cunku soru "kac kisi vardi" degil "her yonde kac cuzdan vardi".
     */
    expect(split.buyers).toBe(2)
    expect(split.sellers).toBe(1)
    const distinct = await pool.query<{ n: string }>(
      'SELECT count(DISTINCT trader)::text AS n FROM trades WHERE token = $1',
      [TOKEN.toLowerCase()],
    )
    expect(Number(distinct.rows[0]!.n)).toBe(2)
    expect(split.buyers + split.sellers).toBeGreaterThan(Number(distinct.rows[0]!.n))
  })

  it('PENCERE VERILMEZSE BUTUN GECMIS -- sifir bos bir pencere olurdu', async () => {
    const all = await getVolumeSplit(pool, TOKEN)
    const windowed = await getVolumeSplit(pool, TOKEN, { sinceSeconds: 86_400 * 3_650 })
    expect(all.volumeWei).toBe(windowed.volumeWei)
    expect(all.volumeWei).toBeGreaterThan(0n)
  })

  it('islemi olmayan token: her alan SIFIR, ve hicbiri undefined degil', async () => {
    const split = await getVolumeSplit(pool, '0x00000000000000000000000000000000000000ff')
    expect(split).toEqual({
      volumeWei: 0n,
      buys: 0,
      sells: 0,
      buyers: 0,
      sellers: 0,
      buyVolumeWei: 0n,
      sellVolumeWei: 0n,
    })
  })

  it('ALICE gercekten her iki yonde de islem yapti (anti-vakum)', async () => {
    const { rows } = await pool.query<{ is_buy: boolean }>(
      'SELECT is_buy FROM trades WHERE token = $1 AND trader = $2',
      [TOKEN.toLowerCase(), ALICE.toLowerCase()],
    )
    expect(rows.some((r) => r.is_buy)).toBe(true)
    expect(rows.some((r) => !r.is_buy)).toBe(true)
  })
})
