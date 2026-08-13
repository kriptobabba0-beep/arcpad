import { describe, expect, it } from 'vitest'
import { fillCandleGaps } from '@/lib/read'
import type { CandleRow } from '@/lib/read'

/**
 * ============================================================================
 *  MUM DIZISININ INSASI
 * ============================================================================
 *
 * UC AYRI KUSUR BU FONKSIYONDAN CIKTI ve hicbiri bir tip hatasi degildi --
 * ucu de "cizim dogru ama YANLIS SEYI cizyor" turundendi:
 *
 *   1. Her mum bir DOJI'ydi. Acilis, kovadaki ilk islemden aliniyordu; oysa
 *      bir mumun acilisi BIR ONCEKI KOVANIN KAPANISIDIR.
 *   2. Sekiz mum grafigin yedide birine sikisiyordu.
 *   3. Sessiz bir tokende kuyruk dolgusu, gercek mumlarin HEPSINI tavanin
 *      disina itiyordu ve grafik dumduz bir cizgi oluyordu.
 *
 * Ucu de yalnizca uretimde, GOZLE goruldu. Bu dosya onlari geri gelemez
 * kiliyor.
 */

const USDC = 10n ** 18n
const T0 = Date.UTC(2026, 7, 13, 12, 0, 0)
const FIVE_MIN = 300

function candle(minuteOffset: number, close: bigint, trades = 2): CandleRow {
  return {
    bucket: new Date(T0 + minuteOffset * 60_000),
    openWei: close,
    highWei: close,
    lowWei: close,
    closeWei: close,
    volumeWei: trades === 0 ? 0n : USDC,
    trades,
  }
}

/** Gercek islem tasiyan mumlar -- dolgudan ayirt etmenin tek yolu. */
const real = (rows: readonly CandleRow[]): CandleRow[] => rows.filter((c) => c.trades > 0)

describe('fillCandleGaps', () => {
  it('BOS GECMIS bos kalir -- uydurulmus bir mum bir fiyat uydurmaktir', () => {
    expect(fillCandleGaps([], FIVE_MIN, new Date(T0))).toEqual([])
  })

  it('ACILIS, BIR ONCEKININ KAPANISIDIR -- yoksa her mum sifir yukseklikte', () => {
    /*
     * KUSUR 1. `listCandles` tek islemli bir kovada acilis ve kapanis olarak
     * AYNI degeri verir (islemden SONRAKI market cap). Zincirleme olmadan
     * fiyat 4.00'dan 5.53'e giderken bunu gosteren TEK BIR govde yoktu.
     */
    const rows = fillCandleGaps(
      [candle(0, 4n * USDC), candle(5, 5n * USDC), candle(10, 3n * USDC)],
      FIVE_MIN,
      new Date(T0 + 10 * 60_000),
    )
    expect(rows[1]?.openWei, 'the second candle did not open where the first closed').toBe(
      4n * USDC,
    )
    expect(rows[2]?.openWei).toBe(5n * USDC)
    // Ve govde SIFIR DEGIL: yukselen bir mum, dusen bir mum.
    expect(rows[1]!.closeWei > rows[1]!.openWei).toBe(true)
    expect(rows[2]!.closeWei < rows[2]!.openWei).toBe(true)
  })

  it('ZINCIRLEME FITILI DE GENISLETIR -- govdesi fitilini asan mum tutarsizdir', () => {
    /*
     * Yeni acilis kovanin kendi uc degerlerinin DISINDA kalabilir. Yuksek ve
     * dusuk genisletilmezse mum kendi govdesini tasan bir kutu olarak cizilir.
     */
    const rows = fillCandleGaps(
      [candle(0, 10n * USDC), candle(5, 2n * USDC)],
      FIVE_MIN,
      new Date(T0 + 5 * 60_000),
    )
    expect(rows[1]?.highWei, 'the wick does not cover the body').toBe(10n * USDC)
    expect(rows[1]?.lowWei).toBe(2n * USDC)
  })

  it('ARADAKI BOSLUK DUZ doldurulur -- eksende zaman atlamaz', () => {
    const rows = fillCandleGaps(
      [candle(0, 4n * USDC), candle(20, 6n * USDC)],
      FIVE_MIN,
      new Date(T0 + 20 * 60_000),
    )
    // 0, 5, 10, 15, 20 -> ikisi gercek, ucu dolgu.
    expect(rows).toHaveLength(5)
    expect(real(rows)).toHaveLength(2)
    // Dolgu mumlarinin hacmi SIFIR: bir hacim uydurmak bir islem uydurmaktir.
    expect(rows[1]?.volumeWei).toBe(0n)
    expect(rows[1]?.closeWei).toBe(4n * USDC)
  })

  it('SESSIZLIK VERIYI EKRANDAN ITEMEZ -- kusurun kendisi buydu', () => {
    /*
     * KUSUR 3, uretimde olculdu: son islemden 35 saat sonra, 5 dakikalik
     * kovalarla kuyruk 429 bos kova uretiyordu. 240'lik tavan EN YENILERI
     * tuttugu icin gercek mumlarin hepsi kirpiliyor, grafik dumduz bir cizgi
     * oluyordu -- ve kullanici hakli olarak "grafik bozuk" diyordu.
     */
    const trades = [candle(0, 4n * USDC), candle(5, 5n * USDC), candle(10, 6n * USDC)]
    // Son islemden 35 saat sonrasi.
    const muchLater = new Date(T0 + 10 * 60_000 + 35 * 3_600_000)
    const rows = fillCandleGaps(trades, FIVE_MIN, muchLater)

    expect(real(rows), 'the real candles were cropped away').toHaveLength(3)
    expect(rows.length).toBeLessThanOrEqual(240)
  })

  it('KUYRUK GENISLIGIN DORTTE BIRINI GECMEZ -- yoksa mumlar sikisir', () => {
    /*
     * KUSUR 2'nin ayni kokten hali. Veri kirpilmasa bile, 16 gercek mumu 240
     * kovalik bir seridin %6'sina sikistirmak onlari OKUNAMAZ yapardi.
     */
    const trades = Array.from({ length: 12 }, (_, i) => candle(i * 5, (4n + BigInt(i)) * USDC))
    const rows = fillCandleGaps(trades, FIVE_MIN, new Date(T0 + 55 * 60_000 + 20 * 3_600_000))
    const filler = rows.length - real(rows).length
    expect(filler / rows.length, 'flat filler took over the chart').toBeLessThanOrEqual(0.25)
  })

  it('HAREKETLI BIR TOKENDE kuyruk simdiye kadar gider -- sinir devreye girmez', () => {
    /*
     * Sinir yalnizca sessiz tokenlerde is gorur. Islem goren bir tokende sag
     * kenar SIMDI olmali; aksi halde canli bir sayfa gecmisi gosterir.
     */
    const trades = Array.from({ length: 20 }, (_, i) => candle(i * 5, (4n + BigInt(i)) * USDC))
    // Son islemden 10 dakika sonra: iki kovalik bir kuyruk.
    const now = new Date(T0 + 95 * 60_000 + 10 * 60_000)
    const rows = fillCandleGaps(trades, FIVE_MIN, now)
    const last = rows[rows.length - 1]!
    expect(last.bucket.getTime()).toBe(Math.floor(now.getTime() / 300_000) * 300_000)
  })

  it('TAVAN EN YENILERI TUTAR -- bir fiyat grafiginde onemli olan sagdir', () => {
    const many = Array.from({ length: 400 }, (_, i) => candle(i * 5, (1n + BigInt(i)) * USDC))
    const rows = fillCandleGaps(many, FIVE_MIN, new Date(T0 + 399 * 5 * 60_000))
    expect(rows).toHaveLength(240)
    expect(rows[rows.length - 1]?.closeWei).toBe(400n * USDC)
  })
})
