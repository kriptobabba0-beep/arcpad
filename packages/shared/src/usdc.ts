export const NATIVE_USDC_DECIMALS = 18 as const
export const ERC20_USDC_DECIMALS = 6 as const

/**
 * The scale between the two views of ONE fund: `1e18` native == `1e6` ERC-20.
 *
 * Exported because every quantisation in the UI is a multiple of it, and a
 * call site that writes `10n ** 12n` inline is a call site that can be wrong
 * by a factor of ten without anything noticing.
 */
export const USDC_VIEW_SCALE = 10n ** BigInt(NATIVE_USDC_DECIMALS - ERC20_USDC_DECIMALS)

const VIEW_SCALE = USDC_VIEW_SCALE
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

// --------------------------------------------------------------------------
// Input: quantisation
// --------------------------------------------------------------------------

export type ParseReason = 'empty' | 'negative' | 'notANumber' | 'exponent' | 'tooManyDecimals'

export type ParsedUsdcAmount = { ok: true; value: bigint } | { ok: false; reason: ParseReason }

/** `123`, `123.45`, `.45` -- and nothing else. No sign, no exponent, no separator. */
const DECIMAL_TEXT = /^(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * Turns what the user typed into native (18-decimal) wei, but QUANTISES to six
 * decimals first: `parseUnits(text, 6)` and then `erc20ToNative`.
 *
 * WHY SIX. The ERC-20 view cannot represent anything below one micro-USDC, so
 * an input finer than six decimals cannot be echoed back to the screen -- the
 * user watches what they typed disappear. The second and harder reason is that
 * quantisation makes two revert classes STRUCTURALLY unreachable: the smallest
 * accepted input is `0.000001` USDC == `1e12` wei, while `NetTooSmall` tops out
 * at 3 wei and `ProceedsTooSmall` at a token floor of ~4.96e8. Both sit far
 * below the quantum.
 *
 * Rejection does NOT throw. A form field shows a message, not a stack trace, so
 * the reason is a value: `{ ok: false, reason }`.
 *
 * The reasons are ordered, and the order is the message quality:
 *   empty            -- nothing typed yet; the field is not "wrong", it is blank
 *   negative         -- a leading `-`; you cannot spend negative money
 *   exponent         -- `1e3`; valid JS, not valid money entry
 *   notANumber       -- `1,5`, `NaN`, `Infinity`, `0x10`, `abc`
 *   tooManyDecimals  -- shape is fine, precision is not
 */
export function parseUsdcAmount(text: string): ParsedUsdcAmount {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  if (trimmed.startsWith('-')) return { ok: false, reason: 'negative' }
  // Checked BEFORE the shape test so `1e3` gets its own reason rather than the
  // generic one -- "use 1000" is actionable, "not a number" is not.
  if (/[eE]/.test(trimmed)) return { ok: false, reason: 'exponent' }
  if (!DECIMAL_TEXT.test(trimmed)) return { ok: false, reason: 'notANumber' }

  const dot = trimmed.indexOf('.')
  const fractionDigits = dot === -1 ? 0 : trimmed.length - dot - 1
  if (fractionDigits > ERC20_USDC_DECIMALS) return { ok: false, reason: 'tooManyDecimals' }

  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot)
  const fraction = dot === -1 ? '' : trimmed.slice(dot + 1)
  const units =
    BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(ERC20_USDC_DECIMALS) +
    BigInt(fraction.padEnd(ERC20_USDC_DECIMALS, '0') || '0')

  return { ok: true, value: erc20ToNative(units) }
}

// --------------------------------------------------------------------------
// Output: directional formatting
// --------------------------------------------------------------------------

export type Rounding = 'down' | 'up'

/** Groups the integer part in threes. en-US, fixed: see CONTRIBUTING.md. */
function group(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i
    out += digits[i]
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += ','
  }
  return out
}

/** Renders a scaled integer as a fixed-point string. Pure string work. */
function renderFixed(units: bigint, fractionDigits: number): string {
  const digits = units.toString().padStart(fractionDigits + 1, '0')
  const cut = digits.length - fractionDigits
  const whole = group(digits.slice(0, cut))
  if (fractionDigits === 0) return whole
  return `${whole}.${digits.slice(cut)}`
}

/**
 * Rescales `native` (18 decimals) down to `fractionDigits` decimals in the
 * chosen direction. This is the ONE place a direction is applied.
 */
function quantise(native: bigint, fractionDigits: number, rounding: Rounding): bigint {
  const scale = 10n ** BigInt(NATIVE_USDC_DECIMALS - fractionDigits)
  const floored = native / scale
  if (rounding === 'down') return floored
  return native % scale === 0n ? floored : floored + 1n
}

/**
 * Turns an 18-decimal native amount into a six-decimal string. THE DIRECTION IS
 * A REQUIRED ARGUMENT AND HAS NO DEFAULT:
 *   'down' -> a balance, a credit, an amount RECEIVED. Never shows money that
 *             is not there.
 *   'up'   -> a cost, an amount owed, an upper bound. Never shows less than
 *             what will be paid.
 * Entirely bigint arithmetic; there is no `Number` path.
 *
 * `maxFractionDigits` is capped at six on purpose. The seventh decimal exists
 * in the native view and in NO other view of the same fund -- printing it shows
 * a figure the ERC-20 view, the wallet, and the explorer all disagree with.
 */
export function formatUsdcAmount(
  native: bigint,
  opts: { rounding: Rounding; maxFractionDigits?: number },
): string {
  if (native < 0n) throw new RangeError('formatUsdcAmount: native amount cannot be negative')
  const fractionDigits = opts.maxFractionDigits ?? ERC20_USDC_DECIMALS
  if (
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > ERC20_USDC_DECIMALS
  ) {
    throw new RangeError(
      `formatUsdcAmount: maxFractionDigits must be an integer in [0, ${ERC20_USDC_DECIMALS}], got ${fractionDigits}`,
    )
  }
  return renderFixed(quantise(native, fractionDigits, opts.rounding), fractionDigits)
}

const COMPACT_UNITS = [
  { suffix: 'B', threshold: 10n ** 9n },
  { suffix: 'M', threshold: 10n ** 6n },
  { suffix: 'K', threshold: 10n ** 3n },
] as const

/**
 * Market-cap formatting: `$57.53M`, `$4.00`. Rounds DOWN -- a market cap is a
 * figure about money that exists.
 *
 * Two regimes, and the boundary is one thousand USDC:
 *   below  -> exactly two decimals. These are dollars and cents, and `$4.00`
 *             reads as a price where `$4.000` reads as a measurement.
 *   at/above -> four significant digits with a K/M/B suffix, so the column
 *             width is stable no matter how far a launch runs.
 * `$4.00` is not an arbitrary example: it is the opening market cap of every
 * sanctioned profile (`LaunchFactory.MIN_OPENING_MARKET_CAP == 4e18`).
 */
export function formatUsdcCompact(native: bigint): string {
  if (native < 0n) throw new RangeError('formatUsdcCompact: native amount cannot be negative')
  for (const { suffix, threshold } of COMPACT_UNITS) {
    const divisor = threshold * NATIVE_SCALE
    if (native < divisor) continue
    // Mantissa lives in [1, 1000): four significant digits means 3, 2 or 1
    // decimals depending on how many digits sit left of the point.
    const mantissaWhole = native / divisor
    const decimals = mantissaWhole < 10n ? 3 : mantissaWhole < 100n ? 2 : 1
    const scaled = (native * 10n ** BigInt(decimals)) / divisor
    return `$${renderFixed(scaled, decimals)}${suffix}`
  }
  return `$${formatUsdcAmount(native, { rounding: 'down', maxFractionDigits: 2 })}`
}

/**
 * A launch token amount (`_tok`, 18-decimal base units) at six decimals,
 * rounded DOWN. Same direction rule as a balance: it is what you hold.
 */
export function formatTokenAmount(tok: bigint): string {
  if (tok < 0n) throw new RangeError('formatTokenAmount: token amount cannot be negative')
  return renderFixed(quantise(tok, ERC20_USDC_DECIMALS, 'down'), ERC20_USDC_DECIMALS)
}

const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉'

function subscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUBSCRIPTS[Number(d)] as string)
    .join('')
}

/** How many leading zeros to collapse before the subscript form pays for itself. */
const ZERO_RUN_THRESHOLD = 3
const PRICE_SIGNIFICANT_DIGITS = 4

/**
 * A price in native wei per WHOLE token, printed with its zero run compressed:
 * `4_000_000_000` -> `0.0₈4`, `4_000_000_000_000` -> `0.0₅4`.
 *
 * Early-curve prices are around `4e-9` USDC per token, which written out is
 * eleven characters of zeros; every one of them is a chance to misread the
 * magnitude by a factor of ten. The subscript says the count instead of
 * drawing it. Below `ZERO_RUN_THRESHOLD` zeros the plain form is clearer and
 * is used.
 */
export function formatPriceWeiPerToken(weiPerWholeToken: bigint): string {
  if (weiPerWholeToken < 0n) {
    throw new RangeError('formatPriceWeiPerToken: price cannot be negative')
  }
  if (weiPerWholeToken === 0n) return '0'

  const whole = weiPerWholeToken / NATIVE_SCALE
  if (whole > 0n) {
    // At or above 1 USDC per token there is no zero run to compress.
    return formatUsdcAmount(weiPerWholeToken, { rounding: 'down', maxFractionDigits: 6 })
  }

  const fraction = (weiPerWholeToken % NATIVE_SCALE).toString().padStart(NATIVE_USDC_DECIMALS, '0')
  let zeros = 0
  while (zeros < fraction.length && fraction[zeros] === '0') zeros += 1

  const rest = fraction.slice(zeros).slice(0, PRICE_SIGNIFICANT_DIGITS).replace(/0+$/, '')
  const digits = rest === '' ? '0' : rest

  if (zeros < ZERO_RUN_THRESHOLD) return `0.${'0'.repeat(zeros)}${digits}`
  return `0.0${subscript(zeros)}${digits}`
}

// --------------------------------------------------------------------------
// The legacy formatter
// --------------------------------------------------------------------------

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
 *
 * NOT FOR BALANCES -- use `formatUsdcAmount(..., { rounding: 'down' })`.
 * `Intl` rounds half UP, so this function shows `0.000001` USDC for `5e11`
 * wei, an amount whose ERC-20 view is exactly zero. For a balance that is
 * money that is not there; for a cost it is money the user is not asked for.
 * The divergence is pinned in `test/usdc-rounding.test.ts`.
 *
 * Kept because Faz 0's tests pin it and `web/app/page.tsx` still calls it.
 * When Task 8 rewrites that page the call disappears and this function lives
 * on only through its own test.
 *
 * Number'a cevirmeden once bigint aritmetigiyle tam (whole) ve kesir
 * (fraction) kismina ayirir: whole kismi her gerceci miktar icin tamdir.
 * Kesir kismi yine de Number'a cevrilir, bu yuzden IEEE-754 double
 * hassasiyetiyle sinirlidir (~15 anlamli basamak).
 */
export function formatUsdc(native: bigint, opts?: { maxFractionDigits?: number }): string {
  const maxFractionDigits = opts?.maxFractionDigits ?? 2
  const whole = native / NATIVE_SCALE
  const fraction = native % NATIVE_SCALE

  const asNumber = Number(whole) + Number(fraction) / Number(NATIVE_SCALE)
  return formatterFor(maxFractionDigits).format(asNumber)
}

/**
 * ============================================================================
 *  KISA TOKEN MIKTARI: `11.00M`, `20.0K`, `848.57M`, `654`
 * ============================================================================
 *
 * `formatTokenAmount` ALTI ONDALIK yazar ve bir BAKIYE icin dogrudur -- bir
 * kullanici tam olarak neye sahip oldugunu gorebilmeli. Bir KOTA satirinda
 * ("su kadar alacaksin") ayni bicim gorsel kirlilik uretiyor:
 *
 *     ~ 11,000,000.000000 LOCKED     <- alti sifir hicbir sey soylemiyor
 *     ~ 20,000.000000 LOCKED
 *
 * Bu fonksiyon ayni sayilari `11.00M` ve `20.0K` yazar. Kayip ondalik bilincli:
 * bir kota ZATEN yaklasiktir (satirin basinda `~` var) ve zincire giden sey bu
 * metin degil `minTokensOut` argumanidir. TAM deger islem tablosunda durur.
 *
 * DORT ANLAMLI BASAMAK, `formatUsdcCompact` ile AYNI kural: kolon genisligi
 * launch ne kadar buyurse buyusun sabit kalir.
 *
 * BINDEN KUCUKLER TAM SAYI: `654`, `41`. Ondalik eklemek onlari bir OLCUM gibi
 * gosterirdi; bir token adedi bir sayimdir.
 */
export function formatTokenCompact(tok: bigint): string {
  if (tok < 0n) throw new RangeError('formatTokenCompact: token amount cannot be negative')
  const whole = tok / NATIVE_SCALE
  for (const { suffix, threshold } of COMPACT_UNITS) {
    if (whole < threshold) continue
    /*
     * DORT ANLAMLI BASAMAK -- `formatUsdcCompact` ile AYNI kural.
     *
     * Mantis [1, 1000) araliginda yasar; noktanin solunda kac basamak varsa
     * sagina o kadar az dusulur (1.235M / 11.00M / 111.0M). Ikinci bir kural
     * yazmak, ayni sayfada bir tutarin ve bir token adedinin farkli
     * cozunurlukte gorunmesi demek olurdu.
     */
    const mantissa = whole / threshold
    const decimals = mantissa < 10n ? 3 : mantissa < 100n ? 2 : 1
    const scaled = (whole * 10n ** BigInt(decimals)) / threshold
    return `${renderFixed(scaled, decimals)}${suffix}`
  }
  /*
   * BINDEN AZI KISALTILMAZ. `999` -> `0.99K` bir sayiyi okunmaz yapardi, ve
   * bir tokenden azi (`0.5`) `0.0K` olarak SIFIR gorunurdu -- kullanicinin
   * elinde duran seyi yok saymak.
   */
  if (whole > 0n) return whole.toLocaleString('en-US')
  return formatTokenAmount(tok)
}

/**
 * KOTA SATIRLARI ICIN USDC: gereksiz sifirlar YOK.
 *
 * `formatUsdcAmount(..., { maxFractionDigits: 6 })` bir BAKIYE icin dogrudur.
 * Bir "You pay" satirinda ise `5,000.000000 USDC` uretiyor ve o alti sifir
 * hicbir sey soylemiyor -- kullanicinin sordugu sey "ne kadar odeyecegim",
 * cevabi "bes bin".
 *
 * ONDALIK, BUYUKLUGE GORE: bir dolarin altinda alti basamak (0.002569 gercek
 * bir tutardir), ustunde iki (5,000.00). Sondaki sifirlar atilir, yani
 * `5,000` ve `0.25` cikar -- ama `5,000.5` de `5,000.50` degil `5,000.5`
 * olur, cunku bu bir fiyat etiketi degil bir miktar.
 *
 * YUVARLAMA YONU CAGIRANDA KALIR: "odeyeceksin" YUKARI, "alacaksin" ASAGI.
 * Bu deponun en eski kurali ve bir kisayol icin bozulmaz.
 */
export function formatUsdcQuote(native: bigint, rounding: Rounding): string {
  if (native < 0n) throw new RangeError('formatUsdcQuote: amount cannot be negative')
  const decimals = native < NATIVE_SCALE ? 6 : 2
  const text = formatUsdcAmount(native, { rounding, maxFractionDigits: decimals })
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}
