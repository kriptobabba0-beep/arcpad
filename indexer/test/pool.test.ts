import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { USDC_ERC20_ADDRESS } from '@arcpad/shared'
import {
  baseIsCurrency0,
  impliedReserves,
  isqrt,
  POOL_FEE,
  POOL_QUOTE_CURRENCY,
  POOL_TICK_SPACING,
  PoolPriceUnrepresentable,
  poolIdFor,
  poolKeyFor,
  QUOTE_SCALE,
  quoteUnitsToWei,
  SQRT_LOWER,
  SQRT_UPPER,
} from '../src/pool'

/**
 * HAVUZ TURETMESI VE BIRIM DONUSUMU.
 *
 * Bu dosyanin olctugu sey bir davranis degil BIR ESLESMEDIR: indexer'in havuz
 * sabitleri ile `GraduationMath.sol`un sabitlerinin AYNI SAYILAR olmasi. Bir
 * kopyanin dogru oldugunu kendi icinde tutarli olmasindan cikaramayiz -- bu
 * deponun kaydettigi kural: "bir sabit disaridan kopyalandiginda, TUM
 * TRANSKRIPSIYONUN yanlis yerden geldigini ne yakalar" diye sorulmali.
 *
 * Cevap: KAYNAK METNIN KENDISI. `contracts/src/` COMMIT'LIDIR (ve
 * `contracts/out/` degildir), yani bu kapi `forge` olmayan bir CI'da da kosar.
 */
const GRADUATION_MATH = readFileSync(
  new URL('../../contracts/src/libraries/GraduationMath.sol', import.meta.url),
  'utf8',
)

function solidityConstant(name: string): string {
  const m = new RegExp(`constant ${name} = ([^;]+);`).exec(GRADUATION_MATH)
  if (m?.[1] === undefined) throw new Error(`GraduationMath.sol icinde ${name} yok`)
  return m[1].trim()
}

describe('havuz sabitleri GraduationMath.sol ile ayni', () => {
  // ANTI-VAKUM: cikarici gercekten okuyor mu? Bulamayan bir cikarici, her
  // "esit" iddiasini kendi hatasiyla dogrularadi.
  it('cikarici GERCEKTEN kaynaktan okur', () => {
    expect(GRADUATION_MATH.length).toBeGreaterThan(1000)
    expect(() => solidityConstant('YOK_BOYLE_BIR_SABIT')).toThrow(/GraduationMath/)
  })

  it('QUOTE, POOL_FEE, TICK_SPACING ve tick sinirlari ortusur', () => {
    expect(solidityConstant('QUOTE').toLowerCase()).toBe(POOL_QUOTE_CURRENCY)
    expect(solidityConstant('POOL_FEE')).toBe(String(POOL_FEE))
    expect(solidityConstant('TICK_SPACING')).toBe(String(POOL_TICK_SPACING))
    expect(solidityConstant('SQRT_LOWER')).toBe(SQRT_LOWER.toString())
    expect(solidityConstant('SQRT_UPPER')).toBe(SQRT_UPPER.toString())
    // `1e12` Solidity'de bilimsel gosterimle yazili; sayiya cevrilerek tutulur.
    expect(solidityConstant('QUOTE_SCALE')).toBe('1e12')
    expect(QUOTE_SCALE).toBe(10n ** 12n)
  })

  // Ve quote adresi `@arcpad/shared`in tek kopyasindan gelir, ikinci bir
  // literalden degil.
  it('quote adresi paylasilan sabitin ta kendisidir', () => {
    expect(POOL_QUOTE_CURRENCY).toBe(USDC_ERC20_ADDRESS.toLowerCase())
  })
})

/**
 * CANLI ZINCIRDEN OKUNMUS IKI TOKEN, VE IKISI SIRALAMANIN IKI YANINDA.
 *
 * Uydurma adresler kullanmak, "token her zaman currency1" varsayimini test
 * eden bir testin kendisinin de o varsayimi tasimasi riskini getirirdi.
 * Bunlar uretim factory'sinin GERCEK iki curve'unun tokenlari (adres kitabi
 * ve HANDOFF'tan) ve `0x085C…` USDC'nin ALTINDA, `0x637a…` USTUNDE.
 */
const LIVE_TOKEN_BELOW_QUOTE = '0x085c926e24ed64bb045e67d26d9e76e5730c21b3' as Address
const LIVE_TOKEN_ABOVE_QUOTE = '0x637af6afd61bb182c5843895d1e8e6fb5f56199a' as Address
const LIVE_HOOK = '0xd95198cd806b736c8ececffc23976b59f565e0cc' as Address

describe('PoolKey ve PoolId turetmesi', () => {
  it('siralama HESAPLANIR ve iki dal da CANLI adreslerle egzersiz edilir', () => {
    expect(baseIsCurrency0(LIVE_TOKEN_BELOW_QUOTE)).toBe(true)
    expect(baseIsCurrency0(LIVE_TOKEN_ABOVE_QUOTE)).toBe(false)

    const below = poolKeyFor(LIVE_TOKEN_BELOW_QUOTE, LIVE_HOOK)
    expect(below.currency0).toBe(LIVE_TOKEN_BELOW_QUOTE)
    expect(below.currency1).toBe(POOL_QUOTE_CURRENCY)

    const above = poolKeyFor(LIVE_TOKEN_ABOVE_QUOTE, LIVE_HOOK)
    expect(above.currency0).toBe(POOL_QUOTE_CURRENCY)
    expect(above.currency1).toBe(LIVE_TOKEN_ABOVE_QUOTE)

    // `PoolManager` KATI `currency0 < currency1` uygular; her iki anahtarin da
    // bunu sagladigi olculur, varsayilmaz.
    for (const key of [below, above]) expect(key.currency0 < key.currency1).toBe(true)
  })

  /**
   * PINLENMIS VEKTORLER. Turetme bir hash oldugu icin yanlisligi hicbir zaman
   * revert etmez -- sonsuza kadar BOS doner. Degerler burada sabitlenmistir ki
   * `abi.encode` sirasi/tipleri hakkindaki bir degisiklik SESSIZ kalmasin.
   *
   * NASIL DOGRULANIR (bu takimin uydurmadigi kismi): `assertDerivedPoolKey`
   * ayni turetmeyi zincirin `Initialize` logunun BES ALANINA karsi tutar; ilk
   * gercek havuz acildiginda o kapi bu vektoru ya dogrular ya yikar.
   */
  it('pinlenmis PoolId vektorleri', () => {
    expect(poolIdFor(LIVE_TOKEN_BELOW_QUOTE, LIVE_HOOK)).toBe(
      '0xd115565bbe4f0235c12c06a3ff9005d029d0884b3c74c6ca7b3df843a02c162b',
    )
    expect(poolIdFor(LIVE_TOKEN_ABOVE_QUOTE, LIVE_HOOK)).toBe(
      '0x07248f221087f55da9a2a2434bb1dfcc025123975e81ac7d5d79d35c2f55c18a',
    )
  })

  it('hook adresi kimlige GIRER -- baska bir hook baska bir havuzdur', () => {
    const other = '0xdd2bb76fa6cf00d9d413559de6337db1875fe0cc' as Address // prova hook'u
    expect(poolIdFor(LIVE_TOKEN_BELOW_QUOTE, other)).not.toBe(
      poolIdFor(LIVE_TOKEN_BELOW_QUOTE, LIVE_HOOK),
    )
  })

  it('buyuk harfli giris ayni kimligi verir', () => {
    expect(poolIdFor(LIVE_TOKEN_BELOW_QUOTE.toUpperCase() as Address, LIVE_HOOK)).toBe(
      poolIdFor(LIVE_TOKEN_BELOW_QUOTE, LIVE_HOOK),
    )
  })
})

// ---------------------------------------------------------------------------
// DIKIS NOKTASI -- egrinin kapanis fiyati ile havuzun acilis fiyati
// ---------------------------------------------------------------------------

/**
 * Canli egri profilinin MEZUNIYET ANINDAKI kapanis durumu.
 * `V + R` ve `vT0 - S`; ikisi de `AGENT-CONTEXT.md`nin olculmus sabitlerinden.
 */
const V = 4292n * 10n ** 15n
const R = 12_161_433_369_060_378_706n
const VT0 = 1073n * 10n ** 24n
const S = 793_100_000n * 10n ** 18n
const CLOSING_QUOTE_WEI = V + R
const CLOSING_TOKEN_TOK = VT0 - S
const SEED_BASE = 206_886_011_183_597_390_493_942_218n
const SEED_QUOTE_UNITS = 12_161_433n

const Q96 = 1n << 96n
const Q192 = 1n << 192n

/**
 * `GraduationMath.sqrtPriceX96`in TS ikizi. TEST GIRDISI URETIR, test edilen
 * kodun isini YAPMAZ: `impliedReserves`in girdisi zincirden gelen bir
 * `sqrtPriceX96`tir ve zincir yokken onu uretmenin baska yolu yok. Iddia bu
 * fonksiyon hakkinda DEGIL, `impliedReserves`in onu tersine cevirebilmesi
 * hakkinda.
 */
function closingSqrtPriceX96(tokenIsCurrency0: boolean): bigint {
  const scaled = CLOSING_TOKEN_TOK * QUOTE_SCALE
  return isqrt(
    tokenIsCurrency0 ? (CLOSING_QUOTE_WEI * Q192) / scaled : (scaled * Q192) / CLOSING_QUOTE_WEI,
  )
}

/** `LiquidityAmounts.getLiquidityForAmounts`in tam aralik hali. Ayni gerekce. */
function seedLiquidity(sqrtP: bigint, amount0: bigint, amount1: bigint): bigint {
  const l0 = (((amount0 * sqrtP) / Q96) * SQRT_UPPER) / (SQRT_UPPER - sqrtP)
  const l1 = (amount1 * Q96) / (sqrtP - SQRT_LOWER)
  return l0 < l1 ? l0 : l1
}

const priceWeiPerTok = (quoteWei: bigint, tokenTok: bigint): bigint =>
  (quoteWei * 10n ** 18n) / tokenTok

describe('havuzun turetilmis rezervleri', () => {
  /**
   * ASIL IDDIA: DIKIS NOKTASINDA FIYAT KOPMAZ.
   *
   * Egrinin son fiyati `vQ/vT`; havuzun ilk fiyati `impliedReserves`in
   * verdigi ciftten AYNI FORMULLE hesaplanir. Ikisi 13 wei -- bagil 2.2e-10 --
   * farkla ortusur ve farkin TAMAMI `GraduationMath.sqrtPriceX96`in kendi
   * `floor(sqrt(...))`undan gelir.
   *
   * Bu sayi (58_783_256_052) `ArcpadHook._marketCap`in NatSpec'inde de gecer;
   * yani iki BAGIMSIZ turetme ayni yere variyor.
   */
  it.each([true, false])('dikis noktasinda fiyat ortusur (tokenIsCurrency0=%s)', (first) => {
    const sqrtP = closingSqrtPriceX96(first)
    const [a0, a1] = first ? [SEED_BASE, SEED_QUOTE_UNITS] : [SEED_QUOTE_UNITS, SEED_BASE]
    const liquidity = seedLiquidity(sqrtP, a0, a1)

    const reserves = impliedReserves(sqrtP, liquidity, first)
    const fromPool = priceWeiPerTok(
      reserves.virtualQuoteReservesWei,
      reserves.virtualTokenReservesTok,
    )
    const fromCurve = priceWeiPerTok(CLOSING_QUOTE_WEI, CLOSING_TOKEN_TOK)

    expect(fromCurve).toBe(58_783_256_052n)
    expect(fromPool).toBe(58_783_256_039n)
    // Bagil fark 1e-9'un altinda. MUTLAK bir esitlik iddia etmek YANLIS
    // olurdu: `sqrtPriceX96` tanimi geregi asagi yuvarlar.
    const diff = fromCurve - fromPool
    expect(diff * 1_000_000_000n < fromCurve).toBe(true)
  })

  /**
   * SIRALAMA TASINMAZSA FIYAT TERSE DONER, VE HICBIR SEY REVERT ETMEZ.
   * Bu, `GraduationMath`in ust yorumunun sayd
   * igi uc sessiz hatadan biri.
   */
  it('bayrak tasinmazsa fiyat TERSE doner', () => {
    const sqrtP = closingSqrtPriceX96(true)
    const liquidity = seedLiquidity(sqrtP, SEED_BASE, SEED_QUOTE_UNITS)
    const right = impliedReserves(sqrtP, liquidity, true)
    const wrong = impliedReserves(sqrtP, liquidity, false)
    const rightPrice = priceWeiPerTok(right.virtualQuoteReservesWei, right.virtualTokenReservesTok)
    const wrongPrice = priceWeiPerTok(wrong.virtualQuoteReservesWei, wrong.virtualTokenReservesTok)
    expect(rightPrice).toBe(58_783_256_039n)
    // Ters bayrak makul gorunen ama on dokuz buyukluk mertebesi kaymis bir
    // fiyat verir -- yani bir CHECK'in yakalayabilecegi hicbir sey yok.
    expect(wrongPrice).not.toBe(rightPrice)
    expect(wrongPrice > rightPrice * 10n ** 18n).toBe(true)
  })

  it('quote bacagi 10^12 ile wei ye cikarilir -- 6 decimal yazilmaz', () => {
    const sqrtP = closingSqrtPriceX96(true)
    const liquidity = seedLiquidity(sqrtP, SEED_BASE, SEED_QUOTE_UNITS)
    const reserves = impliedReserves(sqrtP, liquidity, true)
    // Tohumlanan quote 12_161_433 BIRIMDIR; sutun 18 decimal wei tasir.
    expect(reserves.virtualQuoteReservesWei).toBe(12_161_433n * QUOTE_SCALE)
    expect(quoteUnitsToWei(1n)).toBe(1_000_000_000_000n)
  })

  /**
   * OLCUM, VE ILK YAZILAN IDDIA YANLISTI.
   *
   * "Tam aralik pozisyonun gercek miktarlari sanal ciftten KUCUKTUR" diye
   * yazilmisti; olculdugunde TOKEN bacaginda ESIT cikti. Sebep aritmetik:
   * `real0 = virtual0 * (sqrtU - sqrtP)/sqrtU` ve acilis fiyatinda
   * `sqrtP/sqrtU = 1.3e-29`, yani carpan 1'den `1e-29` kadar kucuk -- 27
   * basamakli bir sayida taban yuvarlamasinin GORDUGU bir fark degil. Quote
   * bacaginda ise `(sqrtP - sqrtL)/sqrtP = 1 - 2.2e-10` ve 8 basamakli bir
   * sayida o da gorunmez.
   *
   * Yani DOGRU iddia "<=", ve tasidigi bilgi sudur: BU FIYATTA tam aralik
   * pozisyon sabit-carpim havuzundan AYIRT EDILEMEZ. Fark ancak fiyat
   * araligin ucuna yaklastiginda gorunur, ve o zaman da `real` bacak dogru
   * olani soyler.
   */
  it('gercek rezervler tam aralik pozisyonun miktarlaridir (<= sanal)', () => {
    const sqrtP = closingSqrtPriceX96(true)
    const liquidity = seedLiquidity(sqrtP, SEED_BASE, SEED_QUOTE_UNITS)
    const r = impliedReserves(sqrtP, liquidity, true)
    expect(r.realTokenReservesTok).toBeLessThanOrEqual(r.virtualTokenReservesTok)
    expect(r.realQuoteReservesWei).toBeLessThanOrEqual(r.virtualQuoteReservesWei)
    // Ve tohumlanan miktarlarla ayni buyukluktedir.
    expect(r.realTokenReservesTok > (SEED_BASE * 9n) / 10n).toBe(true)

    // ARALIK UCUNDA FARK GERCEKTEN ACILIR -- yani `real` bacak olu bir kopya
    // degil. Ama BU LIKIDITEYLE gosterilemez, ve o da bir olcum: tohum
    // likiditesiyle sifirlanma esigi (`L*2^96 = 3.97e45`) `SQRT_UPPER`IN
    // ALTINDA kaliyor, yani aralik ucuna yaklasan her fiyat once
    // `PoolPriceUnrepresentable`a carpiyor. Ayrimin gorunur oldugu bolge daha
    // BUYUK likidite gerektirir -- ve ucuncu taraflar bu havuza likidite
    // EKLEYEBILIR (hook'un `beforeAddLiquidity` bayragi yoktur), yani bu
    // bolge ulasilabilir.
    const deep = 10n ** 40n
    const nearTop = impliedReserves(SQRT_UPPER / 2n, deep, true)
    expect(nearTop.realTokenReservesTok).toBeLessThan(nearTop.virtualTokenReservesTok)
    // Yariya duser: `(sqrtU - sqrtU/2)/sqrtU = 1/2`.
    expect(nearTop.realTokenReservesTok).toBe(nearTop.virtualTokenReservesTok / 2n)
  })

  it('sifir likidite ya da sifir fiyat KABUL EDILMEZ', () => {
    expect(() => impliedReserves(0n, 1n, true)).toThrow(PoolPriceUnrepresentable)
    expect(() => impliedReserves(1n, 0n, true)).toThrow(PoolPriceUnrepresentable)
  })

  /**
   * ESIGIN ULASILABILIRLIGI OLCULUR, VARSAYILMAZ. `vT` ancak
   * `sqrtP > L * 2^96` iken tabana sifirlanir; tohum likiditesiyle bu
   * `3.97e45`tir ve acilis `sqrtP`si `1.92e19`. Yani sinif ULASILABILIR ama
   * bugunku degerlerle DEGIL -- ve bu ayrim yazili olmali, cunku "imkansiz"
   * demek yanlis olurdu.
   */
  it('sanal rezerv tabana sifirlanirsa DURULUR (ve esik olculur)', () => {
    const sqrtP = closingSqrtPriceX96(true)
    const liquidity = seedLiquidity(sqrtP, SEED_BASE, SEED_QUOTE_UNITS)
    const threshold = liquidity * Q96
    expect(sqrtP).toBeLessThan(threshold)
    // Esigin USTUNDE gercekten atiyor.
    expect(() => impliedReserves(threshold + 1n, liquidity, true)).toThrow(PoolPriceUnrepresentable)
    // Ve esigin ALTINDA atmiyor -- kelepce vakumda degil.
    expect(() => impliedReserves(threshold, liquidity, true)).not.toThrow()
  })

  it('isqrt tam sayidir ve tabana yuvarlar', () => {
    expect(isqrt(0n)).toBe(0n)
    expect(isqrt(1n)).toBe(1n)
    expect(isqrt(8n)).toBe(2n)
    expect(isqrt(9n)).toBe(3n)
    expect(isqrt(Q192)).toBe(Q96)
    expect(() => isqrt(-1n)).toThrow(RangeError)
  })
})
