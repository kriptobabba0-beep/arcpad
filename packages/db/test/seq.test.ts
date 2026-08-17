import { describe, expect, it } from 'vitest'
import { fromSeq, MAX_BLOCK_NUMBER, MAX_LOG_INDEX, MAX_SEQ, toSeq } from '../src/seq'

describe('toSeq / fromSeq', () => {
  it('olculmus bir logu tam olarak kodlar', () => {
    // Arc blok 54.325.469, logIndex 1 (0x3600...0000'in 6 decimal logu).
    //
    // PLANIN SAYISI YANLISTI. Plan (Task 3, Adim 1) 56_954_651_115_521
    // diyordu; dogru deger 54_325_469 * 2^20 + 1 = 56_964_382_982_145'tir.
    // Planin sayisi 54_316_187. bloga ve logIndex 1_015_809'a cozuluyor --
    // yani iyi bicimli ama BASKA bir log. Testin cakilmasi bunu gosterdi;
    // okuyarak gorulemezdi.
    expect(toSeq(54_325_469n, 1)).toBe(56_964_382_982_145n)
    expect(fromSeq(56_964_382_982_145n)).toEqual({ blockNumber: 54_325_469n, logIndex: 1 })
  })

  it('ardisik bloklarin alanlari cakismaz', () => {
    expect(toSeq(1n, MAX_LOG_INDEX)).toBe(2_097_151n)
    expect(toSeq(2n, 0)).toBe(2_097_152n)
    expect(toSeq(2n, 0)).toBeGreaterThan(toSeq(1n, MAX_LOG_INDEX))
  })

  it('tavani asan logIndex i reddeder', () => {
    expect(() => toSeq(1n, 1_048_576)).toThrow(RangeError)
  })

  it('tam sinirdaki logIndex i KABUL eder', () => {
    // Bir asagisi gecmeli; yoksa yukaridaki test bir kapali-araligi da
    // gecerdi ve kimse fark etmezdi.
    expect(toSeq(1n, MAX_LOG_INDEX)).toBe(2_097_151n)
  })

  it('tamsayi olmayan ve negatif logIndex i reddeder', () => {
    expect(() => toSeq(1n, -1)).toThrow(RangeError)
    expect(() => toSeq(1n, 1.5)).toThrow(RangeError)
    expect(() => toSeq(1n, Number.NaN)).toThrow(RangeError)
  })

  it('negatif blockNumber i reddeder', () => {
    expect(() => toSeq(-1n, 0)).toThrow(RangeError)
  })

  it('kodlama Postgres bigint alanini TAM OLARAK doldurur', () => {
    // PLANIN IKINCI HATASI. Plan `toBeLessThan(2n ** 63n - 1n)` diyordu; deger
    // bu tavana ESITTIR, altinda degil:
    //   (2^43 - 1) << 20 | (2^20 - 1) = 2^63 - 2^20 + 2^20 - 1 = 2^63 - 1
    // Yani `toBeLessThan` cakardi. Esitlik daha guclu bir ifade zaten:
    // kodlama int8 alanini tam doldurur, ne tasar ne bosluk birakir.
    expect(toSeq(MAX_BLOCK_NUMBER, MAX_LOG_INDEX)).toBe(MAX_SEQ)
    expect(MAX_SEQ).toBe(2n ** 63n - 1n)
    expect(MAX_BLOCK_NUMBER).toBe(2n ** 43n - 1n)
    // Bir blok fazlasi TASAR; sinirin ustunde OLDUGU boyle gosterilir.
    expect(toSeq(MAX_BLOCK_NUMBER + 1n, 0)).toBeGreaterThan(MAX_SEQ)
  })

  it('350ms blok suresiyle tavan ~97.600 yil sonradir', () => {
    const years = (Number(MAX_BLOCK_NUMBER) * 0.35) / (365.25 * 24 * 3600)
    expect(Math.round(years / 100) * 100).toBe(97_600)
  })

  // KAPSAM OLCULUR: yukaridakiler tek tek noktalar. Bu, sinirlarin ETRAFINI
  // deterministik olarak tarar -- 4 blok x 5 logIndex x her ikisinin de sinir
  // degerleri.
  it('sinir civarindaki butun aile icin round-trip ve siki siralama tutar', () => {
    const blocks = [0n, 1n, 2n, 54_325_469n, MAX_BLOCK_NUMBER - 1n, MAX_BLOCK_NUMBER]
    const indexes = [0, 1, 2, MAX_LOG_INDEX - 1, MAX_LOG_INDEX]
    const seqs: bigint[] = []
    let cases = 0

    for (const b of blocks) {
      for (const l of indexes) {
        cases++
        const s = toSeq(b, l)
        // 1. Round-trip kayipsiz.
        expect(fromSeq(s)).toEqual({ blockNumber: b, logIndex: l })
        // 2. Alan tavanini asmaz.
        expect(s).toBeLessThanOrEqual(MAX_SEQ)
        seqs.push(s)
      }
    }

    expect(cases).toBe(30)
    // 3. Cakisma yok.
    expect(new Set(seqs.map(String)).size).toBe(30)
    // 4. Siralama (blok, logIndex) sozluk sirasiyla AYNI. Bu, `event_seq DESC`
    //    indekslerinin zincir sirasi oldugu iddiasinin tamamidir.
    const sorted = [...seqs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    expect(seqs).toEqual(sorted)
  })
})
