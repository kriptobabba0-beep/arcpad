import { USDC_VIEW_SCALE } from '@arcpad/shared/browser'

/**
 * ARC'TA GAZ, HARCANAN VARLIGIN KENDISIYLE ODENIR.
 *
 * Native varlik USDC'dir. Yani bakiyenin TAMAMINI harcayan bir MAX her
 * seferinde basarisiz olur: islem ucreti icin geriye hicbir sey kalmaz ve
 * cuzdan `InsufficientFunds` doner. Ayrilan pay bu yuzden bir suslemenin
 * degil, MAX'in calismasinin sarti.
 *
 * ×3/2 EMNIYET MARJI BU DOSYADA VE YALNIZCA BURADA. Iki yerde iki marj
 * olsaydi biri degistiginde oteki sessizce eski kalirdi -- ve fark, MAX'in
 * calistigi ile calismadigi arasindaki fark olurdu. `useGasReserve` bu
 * fonksiyonu cagirir, kendi carpanini yazmaz.
 *
 * MARJ NEDEN GEREKLI: `estimateGas` imzalanacak isleme degil, SU ANKI duruma
 * bakar. Kullanici imzalayana kadar curve'un rezervleri degisir (Arc blok
 * suresi ~350 ms), yeni bir depo yazimi acilabilir ve `maxFeePerGas` bir
 * sonraki blokta yukselebilir. Marj bu ucunun toplamini karsilar.
 *
 * SIHIRLI BIR SABIT KONMAZ. Arc'in gaz fiyati bu plandan dogrulanamayan bir
 * seydir; tahmin BASARISIZ olursa `null` doner ve MAX ile yuzde kisayollari
 * DEVRE DISI kalir. Uydurulmus bir rezerv, olculmemis bir sayiyi kullanicinin
 * parasi uzerinde denemek olurdu.
 */

/** `× 3 / 2`. Pay ve payda ayri sabitler: bigint aritmetiginde 1.5 yoktur. */
export const GAS_SAFETY_NUMERATOR = 3n
export const GAS_SAFETY_DENOMINATOR = 2n

/**
 * `estimateGas × maxFeePerGas × 3/2`, wei cinsinden.
 *
 * Carpma BOLMEDEN once yapilir: `(g / 2n) * m * 3n` kucuk `g` degerlerinde
 * tabani atar ve rezervi oldugundan kucuk gosterir -- yani MAX'i yeniden
 * kirar.
 */
export function gasReserveFrom(gasEstimate: bigint, maxFeePerGas: bigint): bigint {
  if (gasEstimate < 0n || maxFeePerGas < 0n) {
    throw new RangeError(
      `gasReserveFrom: negatif girdi (gasEstimate=${gasEstimate}, maxFeePerGas=${maxFeePerGas})`,
    )
  }
  return (gasEstimate * maxFeePerGas * GAS_SAFETY_NUMERATOR) / GAS_SAFETY_DENOMINATOR
}

/**
 * Harcanabilir bakiye. Brief'in tek satiri, degistirilmeden:
 *
 *   `balance > gasReserve ? balance - gasReserve : 0n`
 *
 * `reserve === null` -> tahmin basarisiz oldu ve harcanabilir tutar
 * BILINMIYOR. `balance`'a dusmek burada en pahali hata olurdu: kullanici MAX'a
 * basar, islem gaz icin para bulamaz ve para gitmemis olsa da imza ve bekleme
 * bosa gider. Bilinmeyen bir sayi, yanlis bir sayidan iyidir.
 */
export function spendableFrom(balanceWei: bigint, reserveWei: bigint | null): bigint | null {
  if (reserveWei === null) return null
  if (balanceWei < 0n) throw new RangeError(`spendableFrom: negatif bakiye (${balanceWei})`)
  return balanceWei > reserveWei ? balanceWei - reserveWei : 0n
}

/**
 * Bir wei tutarini girdi alaninin tasiyabilecegi tutara indirir: ALTI ondalik,
 * ASAGI.
 *
 * `parseUsdcAmount` altidan fazla ondalik kabul etmez, yani kisayolun urettigi
 * metin once alana yazilip sonra reddedilirse kullanici kendi bastigi dugmenin
 * hata verdigini gorur. Yon ASAGI: yukari yuvarlanmis bir MAX, `spendable`'i
 * bir mikro-USDC asar ve ayrilan payi tam o kadar yer.
 */
export function quantiseToInput(wei: bigint): bigint {
  if (wei < 0n) throw new RangeError(`quantiseToInput: negatif tutar (${wei})`)
  return (wei / USDC_VIEW_SCALE) * USDC_VIEW_SCALE
}

export const SHORTCUT_PERCENTS = [25, 50, 75, 100] as const
export type ShortcutPercent = (typeof SHORTCUT_PERCENTS)[number]

/**
 * `25% · 50% · 75% · MAX` -- HEPSI `spendable` UZERINDEN.
 *
 * `balance` uzerinden hesaplanan bir %100 gaz payini yok sayar; ama %25 de
 * yok sayar, yalnizca daha kucuk bir olcekte: bakiyenin dortte biri gaz
 * payindan kucukse islem yine kurulamaz. Bu yuzden yuzdenin TABANI degisir,
 * yuzdenin kendisi degil.
 */
export function shortcutAmount(spendable: bigint | null, percent: ShortcutPercent): bigint | null {
  if (spendable === null) return null
  return quantiseToInput((spendable * BigInt(percent)) / 100n)
}

/**
 * DOES AN ABSOLUTE MONEY CHIP FIT? -- THE SAME RULE MAX USES, FROM THE SAME
 * PLACE.
 *
 * A `$500` chip and MAX must not disagree. They cannot, because they are the
 * same comparison against the same `spendable`: MAX fills
 * `quantiseToInput(spendable)` and a chip is offered only while it is `<=
 * spendable`. `web/test/trade/gas.test.ts` pins the boundary in both
 * directions rather than trusting the sentence.
 *
 * `spendable === null` -> the gas estimate failed and NOTHING is offered, for
 * exactly the reason the percentages are disabled in that state: an amount that
 * leaves no room for gas is an amount that cannot be sent.
 *
 * Note this takes `spendable`, never `balance`. That is the whole point -- on
 * Arc gas is paid in the asset being spent, so a chip sized against the raw
 * balance is a chip that cannot pay for itself.
 */
export function chipFits(spendable: bigint | null, chipWei: bigint): boolean {
  if (chipWei < 0n) throw new RangeError(`chipFits: negatif tutar (${chipWei})`)
  if (spendable === null) return false
  return chipWei <= spendable
}
