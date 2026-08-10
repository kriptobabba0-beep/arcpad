import { describe, expect, it } from 'vitest'
import {
  chipFits,
  GAS_SAFETY_DENOMINATOR,
  GAS_SAFETY_NUMERATOR,
  gasReserveFrom,
  quantiseToInput,
  maxAmount,
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

/**
 * MAX, ve ARTIK TEK KONTROL. `25% · 50% · 75%` kaldirildi: bir bakiyenin
 * dortte biri kullanicinin zaten ekranda gordugu bir figur uzerinde kendi
 * yapabilecegi bir bolme islemidir. MAX'i vazgecilmez yapan sey ise
 * kullanicinin GOREMEDIGI bir sayiyi tasimasi -- islem basina olculen gaz payi.
 */
describe('MAX', () => {
  const BALANCE = 1_000_000_000_000_000_000n
  const RESERVE = 300_000_000_000_000n

  it('is strictly smaller than the balance whenever gas costs anything', () => {
    // BU, "spendable yerine balance" MUTANTININ OLDUGU YER. `balance`
    // uzerinden hesaplanan bir MAX bakiyenin TAMAMINI yazar ve bu iddia
    // kirilir.
    const spendable = spendableFrom(BALANCE, RESERVE)
    const max = maxAmount(spendable)
    expect(max).not.toBeNull()
    expect(max as bigint).toBeLessThan(BALANCE)
    expect(max).toBe(999_700_000_000_000_000n)
  })

  it('leaves the reserve behind exactly, not approximately', () => {
    const spendable = spendableFrom(BALANCE, RESERVE) as bigint
    expect(BALANCE - (maxAmount(spendable) as bigint)).toBe(RESERVE)
  })

  it('never produces an amount the input field would reject', () => {
    // Alan alti ondalikla sinirli (`parseUsdcAmount`). Kuantalanmamis bir MAX
    // once alana yazilir sonra reddedilir: kullanici kendi bastigi dugmenin
    // hata verdigini gorur.
    const odd = spendableFrom(1_000_000_000_000_000_001n, 1n)
    expect((maxAmount(odd) as bigint) % 1_000_000_000_000n).toBe(0n)
  })

  it('is disabled -- null, not zero -- when there is no estimate', () => {
    // Sifir donmek "harcayacak paran yok" demek olurdu; `null` "olculemedi"
    // der ve dugmeyi KAPATIR.
    expect(maxAmount(null)).toBeNull()
  })

  it('rounds the quantum DOWN', () => {
    expect(quantiseToInput(1_999_999_999_999n)).toBe(1_000_000_000_000n)
    expect(quantiseToInput(999_999_999_999n)).toBe(0n)
  })
})

/**
 * ==========================================================================
 *  THE MONEY CHIPS AND MAX MUST NOT DISAGREE
 * ==========================================================================
 *
 * `chipFits` and `maxAmount` are the two things that put a number in the
 * amount field, and on Arc both are bounded by the same fact: gas is paid in
 * the asset being spent. A chip sized against `balance` while MAX is sized
 * against `spendable` is the exact defect this file was opened for, one scale
 * up -- and it is invisible until the user has signed.
 */
describe('chipFits agrees with MAX at the boundary', () => {
  const BALANCE = 1_000_000_000_000_000_000n
  const RESERVE = 300_000_000_000_000n

  it('offers a chip worth exactly the spendable balance, and refuses one wei more', () => {
    const spendable = spendableFrom(BALANCE, RESERVE) as bigint
    expect(chipFits(spendable, spendable)).toBe(true)
    expect(chipFits(spendable, spendable + 1n)).toBe(false)
  })

  it('refuses a chip worth the WHOLE balance -- the mutant that ignores the reserve', () => {
    // Someone holding exactly $1 must not be offered a $1 chip: the reserve is
    // inside that dollar. This is the coordinator's `$500` case in miniature.
    const spendable = spendableFrom(BALANCE, RESERVE) as bigint
    expect(chipFits(spendable, BALANCE)).toBe(false)
    // ...and `balance` in place of `spendable` would pass it.
    expect(chipFits(BALANCE, BALANCE)).toBe(true)
  })

  it('never offers a chip that MAX could not also fill', () => {
    // MAX quantises DOWN to the field's six decimals. A chip that fits must
    // therefore also sit at or below what MAX would write, or the two controls
    // would contradict each other on the same screen.
    const spendable = spendableFrom(BALANCE, RESERVE) as bigint
    const max = maxAmount(spendable) as bigint
    for (const usdc of [1n, 25n, 100n, 500n]) {
      const chip = usdc * 1_000_000_000_000_000_000n
      if (chipFits(spendable, chip)) expect(chip).toBeLessThanOrEqual(max)
    }
  })

  it('offers nothing at all when the estimate failed, exactly as MAX does', () => {
    expect(chipFits(null, 1n)).toBe(false)
    expect(chipFits(null, 0n)).toBe(false)
    expect(maxAmount(null)).toBeNull()
  })

  it('refuses a negative chip rather than offering it', () => {
    expect(() => chipFits(1n, -1n)).toThrow(RangeError)
  })
})
