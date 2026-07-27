export const NATIVE_USDC_DECIMALS = 18 as const
export const ERC20_USDC_DECIMALS = 6 as const

/** Iki gorunum arasindaki olcek farki: 1e18 native = 1e6 ERC-20. */
const VIEW_SCALE = 10n ** BigInt(NATIVE_USDC_DECIMALS - ERC20_USDC_DECIMALS)
const NATIVE_SCALE = 10n ** BigInt(NATIVE_USDC_DECIMALS)

/**
 * 18 decimal native gorunumu 6 decimal ERC-20 gorunumune indirir.
 * Asagi yuvarlar: ERC-20 arayuzu mikro-USDC altini gosteremez ve yukari
 * yuvarlamak var olmayan bakiye uydurmak olurdu.
 *
 * Girdi alani negatif olmayan bakiyelerle sinirlidir -- Arc'ta bir bakiye
 * asla negatif olamaz. Bu garanti sadece negatif olmayan girdide gecerlidir:
 * BigInt bolme sifira dogru keser (-Infinity'ye degil), yani negatif girdide
 * "asagi yuvarlama" iddiasi yanlis olurdu. Bu yuzden negatif girdi
 * sessizce yanlis sonuc uretmek yerine reddedilir.
 */
export function nativeToErc20(native: bigint): bigint {
  if (native < 0n) {
    throw new RangeError('nativeToErc20: native bakiye negatif olamaz')
  }
  return native / VIEW_SCALE
}

/** 6 decimal ERC-20 gorunumu 18 decimal native gorunume cikarir. Kayipsizdir. */
export function erc20ToNative(erc20: bigint): bigint {
  return erc20 * VIEW_SCALE
}

const FORMATTERS = new Map<number, Intl.NumberFormat>()

function formatterFor(maxFractionDigits: number): Intl.NumberFormat {
  let formatter = FORMATTERS.get(maxFractionDigits)
  if (!formatter) {
    // Locale ACIKCA sabitlenmistir. Sabitlenmezse ayni dize bir kullanici
    // icin "bin iki yuz otuz dort", digeri icin "bir virgul iki uc dort"
    // okunur; para soz konusuyken bu kabul edilemez.
    formatter = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: Math.min(2, maxFractionDigits),
      maximumFractionDigits: maxFractionDigits,
    })
    FORMATTERS.set(maxFractionDigits, formatter)
  }
  return formatter
}

/**
 * 18 decimal native USDC miktarini goruntulenebilir bir dizeye cevirir.
 * Number'a cevirmeden once bigint aritmetigiyle tam (whole) ve kesir
 * (fraction) kismina ayirir: whole kismi her gerceci miktar icin tamdir.
 * Kesir kismi yine de Number'a cevrilir, bu yuzden IEEE-754 double
 * hassasiyetiyle sinirlidir (~15 anlamli basamak) -- bu, kod tabanindaki
 * her maxFractionDigits degeri icin (en fazla 7) fazlasiyla yeterlidir,
 * ancak native degerin en dusuk basamaklari cok yuksek maxFractionDigits
 * degerlerinde kaybolabilir. Bu, goruntuleme icin kabul edilebilir bir
 * odundur; zincir uzeri muhasebe bu fonksiyona dayanmamalidir.
 */
export function formatUsdc(native: bigint, opts?: { maxFractionDigits?: number }): string {
  const maxFractionDigits = opts?.maxFractionDigits ?? 2
  const whole = native / NATIVE_SCALE
  const fraction = native % NATIVE_SCALE

  const asNumber = Number(whole) + Number(fraction) / Number(NATIVE_SCALE)
  return formatterFor(maxFractionDigits).format(asNumber)
}
