import { describe, expect, it } from 'vitest'
import {
  GAS_SAFETY_DENOMINATOR,
  GAS_SAFETY_NUMERATOR,
  gasReserveFrom,
  quantiseToInput,
  shortcutAmount,
  SHORTCUT_PERCENTS,
  spendableFrom,
} from '@/components/token/gas'

/**
 * GAZ PAYI. ARC'TA GAZ, HARCANAN VARLIGIN KENDISIYLE ODENIR.
 *
 * Bu dosyanin varlik sebebi tek bir mutant: `spendable` yerine `balance`
 * kullanmak. O mutant ekranda hicbir sey degistirmez -- MAX yine bir sayi
 * yazar, dokum yine cizilir, buton yine "Buy DIFF" der -- ve yalnizca
 * kullanici imzaladiktan sonra, gaz icin para kalmadigi icin patlar. Yani
 * bilesen testiyle degil ARITMETIKLE yakalanmasi gerekir.
 */

describe('gasReserveFrom', () => {
  it('is gas x fee x 3/2', () => {
    // 100_000 birim x 2 gwei = 2e14 wei; ×3/2 = 3e14.
    expect(gasReserveFrom(100_000n, 2_000_000_000n)).toBe(300_000_000_000_000n)
  })

  it('multiplies before it divides', () => {
    // Tek bir gaz birimi ve tek bir wei fiyat: `(1/2)*1*3` sifir verirdi,
    // dogru sira `(1*1*3)/2 = 1`. Rezervi tabana atan bir sadelestirme
    // kucuk degerlerde payi TAMAMEN kaldirir.
    expect(gasReserveFrom(1n, 1n)).toBe(1n)
    expect(GAS_SAFETY_NUMERATOR).toBe(3n)
    expect(GAS_SAFETY_DENOMINATOR).toBe(2n)
  })

  it('refuses negative inputs rather than returning a negative reserve', () => {
    expect(() => gasReserveFrom(-1n, 1n)).toThrow(RangeError)
    expect(() => gasReserveFrom(1n, -1n)).toThrow(RangeError)
  })
})

describe('spendableFrom', () => {
  const RESERVE = 300_000_000_000_000n

  it('leaves the reserve behind', () => {
    expect(spendableFrom(1_000_000_000_000_000_000n, RESERVE)).toBe(999_700_000_000_000_000n)
  })

  it('is zero -- not negative -- when the balance is exactly the transaction cost', () => {
    // Brief'in vakasi: bakiye TAM OLARAK islem maliyetine esit. `balance -
    // reserve` bir tabanla sinirlanmasaydi bir sonraki adimda negatif bir
    // tutar bicimlendirilirdi ve `formatUsdcAmount` `RangeError` atardi.
    expect(spendableFrom(RESERVE, RESERVE)).toBe(0n)
    expect(spendableFrom(RESERVE - 1n, RESERVE)).toBe(0n)
  })

  it('is UNKNOWN, not the full balance, when the estimate failed', () => {
    // Tahmin yoksa `balance`'a dusmek en pahali hata olurdu: MAX calisir
    // gorunur ve her seferinde `InsufficientFunds` alir.
    expect(spendableFrom(1_000_000_000_000_000_000n, null)).toBeNull()
  })
})

describe('the shortcuts', () => {
  const BALANCE = 1_000_000_000_000_000_000n
  const RESERVE = 300_000_000_000_000n

  it('MAX is strictly smaller than the balance whenever gas costs anything', () => {
    // BU, "spendable yerine balance" MUTANTININ OLDUGU YER. `balance`
    // uzerinden hesaplanan bir MAX bakiyenin TAMAMINI yazar ve bu iddia
    // kirilir.
    const spendable = spendableFrom(BALANCE, RESERVE)
    const max = shortcutAmount(spendable, 100)
    expect(max).not.toBeNull()
    expect(max as bigint).toBeLessThan(BALANCE)
    expect(max).toBe(999_700_000_000_000_000n)
  })

  it('divides the spendable balance, not the raw balance, at every step', () => {
    const spendable = spendableFrom(BALANCE, RESERVE)
    for (const percent of SHORTCUT_PERCENTS) {
      const amount = shortcutAmount(spendable, percent) as bigint
      expect(amount).toBeLessThanOrEqual((BALANCE * BigInt(percent)) / 100n)
    }
    // %25 bile bakiyenin dortte birinden KUCUK: taban degisiyor, yuzde degil.
    expect(shortcutAmount(spendable, 25)).toBe(249_925_000_000_000_000n)
  })

  it('never produces an amount the input field would reject', () => {
    // Alan alti ondalikla sinirli (`parseUsdcAmount`). Kuantalanmamis bir MAX
    // once alana yazilir sonra reddedilir: kullanici kendi bastigi dugmenin
    // hata verdigini gorur.
    const odd = spendableFrom(1_000_000_000_000_000_001n, 1n)
    for (const percent of SHORTCUT_PERCENTS) {
      const amount = shortcutAmount(odd, percent) as bigint
      expect(amount % 1_000_000_000_000n).toBe(0n)
    }
  })

  it('is disabled -- null, not zero -- when there is no estimate', () => {
    // Sifir donmek "harcayacak paran yok" demek olurdu; `null` "olculemedi"
    // der ve dugmeleri KAPATIR.
    for (const percent of SHORTCUT_PERCENTS) {
      expect(shortcutAmount(null, percent)).toBeNull()
    }
  })

  it('rounds the quantum DOWN', () => {
    expect(quantiseToInput(1_999_999_999_999n)).toBe(1_000_000_000_000n)
    expect(quantiseToInput(999_999_999_999n)).toBe(0n)
  })
})
