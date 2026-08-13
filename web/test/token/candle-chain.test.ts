import { describe, expect, it } from 'vitest'
import { chainCandles } from '@/lib/read'
import type { CandleRow } from '@/lib/read'

/**
 * ============================================================================
 *  MUM DIZISININ INSASI
 * ============================================================================
 *
 * UC AYRI KUSUR BU KODDAN CIKTI ve hicbiri bir tip hatasi degildi -- ucu de
 * "cizim dogru ama YANLIS SEYI ciziyor" turundendi:
 *
 *   1. Her mum bir DOJI'ydi. Acilis, kovadaki ilk islemden aliniyordu; oysa
 *      bir mumun acilisi BIR ONCEKI KOVANIN KAPANISIDIR.
 *   2. Sekiz mum grafigin yedide birine sikismisti.
 *   3. Bos kova dolgusu, gercek mumlari ekranin bir kosesine itiyordu: dun 40
 *      dakika, bugun 2 dakika islem gormus bir tokende 240 noktanin 235'i
 *      ARADAKI SESSIZLIKTI.
 *
 * Ucu de yalnizca uretimde, GOZLE goruldu -- ve ucuncusu, ikincisinin
 * duzeltilmis sanildigi bir noktadan sonra. Bu dosya onlari geri gelemez
 * kiliyor.
 */

const USDC = 10n ** 18n
const T0 = Date.UTC(2026, 7, 13, 12, 0, 0)

function candle(minuteOffset: number, close: bigint): CandleRow {
  return {
    bucket: new Date(T0 + minuteOffset * 60_000),
    openWei: close,
    highWei: close,
    lowWei: close,
    closeWei: close,
    volumeWei: USDC,
    trades: 2,
  }
}

describe('chainCandles', () => {
  it('BOS GECMIS bos kalir -- uydurulmus bir mum uydurulmus bir fiyattir', () => {
    expect(chainCandles([])).toEqual([])
  })

  it('ACILIS, BIR ONCEKININ KAPANISIDIR -- yoksa her mum sifir yukseklikte', () => {
    const rows = chainCandles([candle(0, 4n * USDC), candle(5, 5n * USDC), candle(10, 3n * USDC)])
    expect(rows[1]?.openWei, 'the second candle did not open where the first closed').toBe(
      4n * USDC,
    )
    expect(rows[2]?.openWei).toBe(5n * USDC)
    // Ve govde SIFIR DEGIL: biri yukselen, digeri dusen bir mum.
    expect(rows[1]!.closeWei > rows[1]!.openWei).toBe(true)
    expect(rows[2]!.closeWei < rows[2]!.openWei).toBe(true)
  })

  it('ILK MUM ZINCIRLENMEZ -- oncesinde bir kapanis yok', () => {
    const rows = chainCandles([candle(0, 4n * USDC), candle(5, 9n * USDC)])
    expect(rows[0]?.openWei).toBe(4n * USDC)
  })

  it('ZINCIRLEME FITILI DE GENISLETIR -- govdesi fitilini asan mum tutarsizdir', () => {
    const rows = chainCandles([candle(0, 10n * USDC), candle(5, 2n * USDC)])
    expect(rows[1]?.highWei, 'the wick does not cover the body').toBe(10n * USDC)
    expect(rows[1]?.lowWei).toBe(2n * USDC)
  })

  it('BOSLUK DOLDURULMAZ -- sessizlik genislik kaplamaz', () => {
    /*
     * KUSUR 3. `lightweight-charts` zamani surekli bir eksen olarak degil,
     * sirali bir NOKTA DIZISI olarak cizer; her mum esit yuva alir ve kendi
     * damgasiyla etiketlenir. Doldurmak, bes gercek mumu 240 kovalik bir
     * seridin ucuna sikistirmaktan baska bir sey yapmiyordu.
     */
    const rows = chainCandles([candle(0, 4n * USDC), candle(60 * 24, 6n * USDC)])
    expect(rows, 'empty buckets came back').toHaveLength(2)
    // Ve zincirleme, aradaki bosluga ragmen calisir.
    expect(rows[1]?.openWei).toBe(4n * USDC)
  })

  it('SIRA KORUNUR -- damgalar artan kalmali, yoksa kutuphane ATAR', () => {
    /*
     * `lightweight-charts` artan zaman ister; bozuk bir sira "data must be
     * asc ordered by time" ile GRAFIGIN TAMAMINI dusurur.
     */
    const rows = chainCandles([candle(0, USDC), candle(5, USDC), candle(10, USDC)])
    const times = rows.map((r) => r.bucket.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('TAVAN EN YENILERI TUTAR -- bir fiyat grafiginde onemli olan sagdir', () => {
    const many = Array.from({ length: 400 }, (_, i) => candle(i * 5, (1n + BigInt(i)) * USDC))
    const rows = chainCandles(many)
    expect(rows).toHaveLength(240)
    expect(rows[rows.length - 1]?.closeWei).toBe(400n * USDC)
  })

  it('GIRDI DEGISTIRILMEZ -- cagiran ayni diziyi baska bir yerde de okuyor', () => {
    const input = [candle(0, 4n * USDC), candle(5, 9n * USDC)]
    chainCandles(input)
    expect(input[1]?.openWei, 'the caller\u2019s array was mutated').toBe(9n * USDC)
  })
})
