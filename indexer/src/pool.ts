import type { Address, Hex } from 'viem'
import { encodeAbiParameters, keccak256 } from 'viem'
import { USDC_ERC20_ADDRESS } from '@arcpad/shared'

/**
 * MEZUNIYETTEN SONRAKI VENUE: UNISWAP V4 HAVUZU.
 *
 * Bu dosya IKI soruyu cevaplar ve baska hicbir sey yapmaz (depolama yok, RPC
 * yok, veritabani yok):
 *
 *   1. "Bu havuz BIZIM MI?"  -> `poolIdFor(token, hook)`
 *   2. "Bu `Swap` BIZIM BIRIMLERIMIZDE NE?" -> `impliedReserves`, ve
 *      `quoteUnitsToWei`.
 *
 * IKINCISI BIRINCISINDEN DAHA TEHLIKELI. Yanlis bir havuz kimligi HICBIR log
 * getirmez -- gurultulu bir bosluk. Yanlis bir birim donusumu ise makul
 * gorunen ve 10^6 kat kaymis bir fiyat gecmisi uretir; hicbir CHECK, hicbir
 * tip ve hicbir test bunu goremez, cunku 10^12 kat buyuk bir sayi tamamen
 * gecerlidir. `GraduationMath.sol`un ust yorumu ayni uc sessiz hatayi
 * kontrat tarafinda sayiyor; bu dosya onun indexer tarafindaki ikizidir ve
 * SABITLER ORADAN, degerle degil ADLA eslesir.
 */

// ---------------------------------------------------------------------------
// `GraduationMath.sol`in kanonik havuz sabitleri
// ---------------------------------------------------------------------------

/**
 * Havuzun quote bacagi: Arc'in ERC-20 USDC arayuzu, `address(0)` DEGIL.
 *
 * `@arcpad/shared`dan ITHAL EDILIYOR, ikinci bir literal yazilmiyor --
 * `arc.ts`in acilisindaki ayni karar. `GraduationMath.QUOTE` ile ayni adres
 * olmasi `pool.test.ts`te kaynak metinden okunarak iddia edilir.
 */
export const POOL_QUOTE_CURRENCY = USDC_ERC20_ADDRESS.toLowerCase() as Address

/** `GraduationMath.POOL_FEE`. SIFIR: ucreti havuz degil HOOK tahsil eder. */
export const POOL_FEE = 0

/** `GraduationMath.TICK_SPACING`. */
export const POOL_TICK_SPACING = 60

/** `GraduationMath.SQRT_LOWER` -- `TickMath.getSqrtPriceAtTick(-887220)`. */
export const SQRT_LOWER = 4306310044n

/** `GraduationMath.SQRT_UPPER` -- `TickMath.getSqrtPriceAtTick(887220)`. */
export const SQRT_UPPER = 1457652066949847389969617340386294118487833376468n

/**
 * `GraduationMath.QUOTE_SCALE`. 1 ERC-20 birimi = 10^12 wei.
 *
 * BU SATIRIN OLMADIGI BIR YOL SESSIZCE YANLISTIR. Havuzun quote bacagi 6
 * decimal'lik ERC-20 gorunumudur; `trades.quote_amount_wei` ise 18 decimal
 * native gorunumdur -- egri tarafindaki her satirin tasidigi gorunum. Donusum
 * YAPILMAZSA mezuniyetten sonraki her islem 10^12 kat KUCUK gorunur ve
 * "fiyat gecmisi kopmaz" iddiasi tam da kopmanin en sinsi biciminde ihlal
 * edilir: gecmis kopmaz, YANLIS devam eder.
 */
export const QUOTE_SCALE = 10n ** 12n

const Q96 = 1n << 96n

/**
 * 6 decimal ERC-20 birimi -> 18 decimal native wei. `GraduationMath.quoteWei`in
 * ta kendisi ve TEK YONLU kullanilir: havuz tarafindan gelen her miktar bu
 * fonksiyondan gecer.
 *
 * TERSI (`quoteUnits`, wei -> birim) BURADA YOKTUR ve olmamali: o yon TABANA
 * yuvarlar, yani kayipli. Indexer'in hicbir yolu wei'den birime inmez.
 */
export const quoteUnitsToWei = (units: bigint): bigint => units * QUOTE_SCALE

// ---------------------------------------------------------------------------
// Havuz kimligi
// ---------------------------------------------------------------------------

/**
 * Token `currency0` mi. HESAPLANIR, VARSAYILMAZ.
 *
 * `GraduationMath.poolKey`in ayni satiri: `PoolManager` kati
 * `currency0 < currency1` uygular ve USDC `0x3600...`ta oturur, yani launch
 * token'larinin yaklasik %21'i (0x36/0x100) USDC'nin ALTINA duser. "Token her
 * zaman currency1" diye yazilmis bir kod her bes havuzdan birinde YANLIS
 * anahtar uretir -- ve yanlis anahtar `PoolId`yi degistirdigi icin o havuzun
 * butun `Swap`leri SESSIZCE dusurulurdu.
 *
 * IKI DAL DA CANLI ZINCIRDE VAR (olculdu 2026-08-09, uretim factory'sinin iki
 * curve'u): `0x085C926e...21b3 < 0x3600...` DOGRU, `0x637aF6af...199A`
 * YANLIS. Yani bu dal `pool.test.ts`te gercek adreslerle iki yonlu egzersiz
 * edilir, uydurulmus adreslerle degil.
 */
export function baseIsCurrency0(token: Address): boolean {
  return token.toLowerCase() < POOL_QUOTE_CURRENCY
}

export interface PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

/** Bir launch tokeni icin arcpad'in KANONIK `PoolKey`i. */
export function poolKeyFor(token: Address, hook: Address): PoolKey {
  const base = token.toLowerCase() as Address
  const baseFirst = baseIsCurrency0(base)
  return {
    currency0: baseFirst ? base : POOL_QUOTE_CURRENCY,
    currency1: baseFirst ? POOL_QUOTE_CURRENCY : base,
    fee: POOL_FEE,
    tickSpacing: POOL_TICK_SPACING,
    hooks: hook.toLowerCase() as Address,
  }
}

/**
 * `PoolId` = `keccak256(abi.encode(poolKey))`.
 *
 * `PoolIdLibrary.toId` BELLEK UZERINDEN hasher (`keccak256(poolKey, 0xa0)`),
 * yani struct'in BES KELIMESI. `abi.encode`un ciktisi o bes kelimenin
 * AYNISIDIR -- `uint24`/`int24` sag hizali sifir dolgulu, adresler sag hizali
 * -- ve `tickSpacing` POZITIF oldugu icin isaret genisletmesi de fark
 * yaratmaz. Denklik `pool.test.ts`te kontratin kendi sabitleriyle uretilmis
 * bir vektor uzerinde iddia edilir.
 *
 * NEDEN BU, "HOOK ADRESINE BAKMAK" DEGIL: `PoolManager` zincirdeki HER havuzu
 * tasir ve `Swap` logu HOOK ADRESINI TASIMAZ (yalnizca `id` ve `sender`).
 * Hook'a gore suzmek, once `Initialize` loglarini -- ki `hooks` alani
 * INDEKSLI DEGILDIR, yani sunucu tarafinda suzulemez -- filtresiz cekmek
 * demekti. Turetme ise SIFIR ek istekle, sunucu tarafinda `topic1` uzerinde
 * suzer ve kimlik bir hash oldugu icin carpisma uretilemez.
 */
export function poolIdFor(token: Address, hook: Address): Hex {
  const key = poolKeyFor(token, hook)
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  )
}

// ---------------------------------------------------------------------------
// `Swap` -> bizim birimlerimiz
// ---------------------------------------------------------------------------

/** Tam sayi karekoku, tabana yuvarlar (Newton). `Math.sqrt` 2^53'te biter. */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError('isqrt: negatif')
  if (value < 2n) return value
  let x = value
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + value / x) / 2n
  }
  return x
}

export interface ImpliedReserves {
  /** Fiyat CIFTININ token bacagi, 18 decimal token tabani. */
  virtualTokenReservesTok: bigint
  /** Fiyat CIFTININ quote bacagi, 18 decimal NATIVE wei. */
  virtualQuoteReservesWei: bigint
  /** Aralik ICI likiditenin gercek token miktari. */
  realTokenReservesTok: bigint
  /** Aralik ICI likiditenin gercek quote miktari, 18 decimal native wei. */
  realQuoteReservesWei: bigint
}

/**
 * ============ `Swap`IN DORT REZERVI, VE NEDEN UYDURULMUS DEGILLER ============
 *
 * `trades` tablosu dort rezerv sutununu NOT NULL tasir ve okuma katmani fiyati
 * ONLARDAN turetir (`web/components/token/TradesTable.tsx:126`,
 * `CurveChart.tsx:93` -- ikisi de `priceWeiPerToken(vQ, vT)` = `vQ*1e18/vT`).
 * Bir havuz satirinin bu sutunlari BOS birakmasi ya da egrinin DONMUS kapanis
 * rezervlerini tasimasi, "fiyat gecmisi mezuniyette kopmaz" iddiasini iki
 * ayri sekilde yalanlardi: birincisinde grafik mezuniyette KESILIR,
 * ikincisinde son egri fiyati sonsuza kadar CANLI gibi tekrarlanir.
 *
 * V4'te HAM REZERV OKUNAMAZ -- `PoolManager`in USDC bakiyesi BUTUN havuzlarin
 * toplamidir ve bu, V3'ten en onemli mimari ayrimdir (`ArcpadHook._marketCap`
 * ayni olguyu ayni sozlerle kaydeder). Kullanilabilir tek durum `Swap`in
 * KENDI tasidigi `sqrtPriceX96` ve `liquidity`dir, ve o ikisi havuzun
 * rezervlerini TAM OLARAK belirler:
 *
 *   sanal (sabit-carpim esdegeri)   amount0 = L·2^96 / sqrtP
 *                                   amount1 = L·sqrtP / 2^96
 *   gercek (tam aralik pozisyon)    amount0 = L·2^96·(sqrtU−sqrtP)/(sqrtP·sqrtU)
 *                                   amount1 = L·(sqrtP−sqrtL)/2^96
 *
 * Sanal cift ORANI TAM verir: `amount1/amount0 = (sqrtP/2^96)^2`, yani havuzun
 * fiyatinin ta kendisi. `quote` bacagi 10^12 ile wei'ye cikarildiginda
 * `vQ_wei/vT_tok` egrinin `virtualQuoteReserves/virtualTokenReserves`i ile AYNI
 * BUYUKLUKTEDIR -- ve dikis noktasinda AYNI SAYIDIR:
 *
 *   OLCULDU (canli egri profili, mezuniyet anindaki kapanis durumu):
 *     egriden      vQ/vT            = 58_783_256_052 wei/token
 *     havuzdan     (L, sqrtP)'den   = 58_783_256_039 wei/token
 *   Fark 13 wei, bagil 2.2e-10, ve TAMAMI `GraduationMath.sqrtPriceX96`in
 *   kendi `floor(sqrt(...))`undan gelir -- yani kontratin ACIKCA yazili
 *   yuvarlama yonunden. Bu sayi (58_783_256_052) `ArcpadHook._marketCap`in
 *   NatSpec'inde de gecer; iki bagimsiz turetme ayni yere varir.
 *
 * YUVARLAMA YONU TABANDIR, dortunde de: `LiquidityAmounts` ve
 * `GraduationMath` de asagi yuvarlar. Karisik yon, tek bir invariant icin iki
 * tanim demekti.
 *
 * SIFIR REZERV BIR HATADIR, SIFIR DEGERI DEGIL. `vT = 0` yazmak, okuma
 * katmaninda `vQ*1e18/0n` -- yani bir `RangeError` -- uretir ve token
 * sayfasini komple dusurur. Esik OLCULDU: tohumlanan likidite `L = 5.016e16`
 * ile `vT` ancak `sqrtP > L·2^96 = 3.97e45` iken tabana sifirlanir, bugunku
 * acilis `sqrtP`si ise `1.92e19` -- yani fiyatin 4.3e52 KAT artmasi gerekir.
 * `L` asla azalmaz (locker'in pozisyonu KALICIDIR; `modifyLiquidity`yi
 * negatif delta ile cagiran kod HIC YAZILMAMISTIR), yani esik ancak YUKARI
 * gider. Ulasildiginda dogru davranis durmaktir: yazilabilecek her deger bir
 * yalan olurdu.
 */
export class PoolPriceUnrepresentable extends Error {
  constructor(
    readonly sqrtPriceX96: bigint,
    readonly liquidity: bigint,
  ) {
    super(
      `PoolPriceUnrepresentable: sqrtPriceX96=${sqrtPriceX96} ve liquidity=${liquidity} ile ` +
        `havuzun sanal rezervlerinden biri tabana SIFIRLANIYOR. Bu, havuzun fiilen tek ` +
        `bacakli oldugu anlamina gelir; sifir bir rezerv yazmak okuma katmaninda ` +
        `bolme hatasi uretirdi. Olculmus esik: tohum likiditesiyle fiyatin ~4.3e52 kat ` +
        `artmasi gerekir.`,
    )
    this.name = 'PoolPriceUnrepresentable'
  }
}

/**
 * Havuzun `Swap` sonrasi durumunu `trades`in dort rezerv sutununa cevirir.
 *
 * @param sqrtPriceX96 `Swap.sqrtPriceX96` -- swap SONRASI.
 * @param liquidity `Swap.liquidity` -- swap SONRASI, aralik ici toplam.
 * @param tokenIsCurrency0 `baseIsCurrency0(token)`. Tasinmazsa fiyat TERSINE
 *        doner ve hicbir kontrol bunu goremez.
 */
export function impliedReserves(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  tokenIsCurrency0: boolean,
): ImpliedReserves {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) {
    throw new PoolPriceUnrepresentable(sqrtPriceX96, liquidity)
  }
  const virtual0 = (liquidity * Q96) / sqrtPriceX96
  const virtual1 = (liquidity * sqrtPriceX96) / Q96

  // TAM ARALIK POZISYONUN GERCEK MIKTARLARI. `sqrtP` aralik disina cikamaz
  // (tam aralik) ama kelepce yine de duruyor: disari cikmis bir `sqrtP` ile
  // cikarma ALTTAN TASAR ve `bigint` bunu sessizce NEGATIF bir sayi yapar.
  const clamped =
    sqrtPriceX96 < SQRT_LOWER ? SQRT_LOWER : sqrtPriceX96 > SQRT_UPPER ? SQRT_UPPER : sqrtPriceX96
  const real0 = (liquidity * Q96 * (SQRT_UPPER - clamped)) / (clamped * SQRT_UPPER)
  const real1 = (liquidity * (clamped - SQRT_LOWER)) / Q96

  const virtualTokenReservesTok = tokenIsCurrency0 ? virtual0 : virtual1
  const virtualQuoteUnits = tokenIsCurrency0 ? virtual1 : virtual0
  if (virtualTokenReservesTok === 0n || virtualQuoteUnits === 0n) {
    throw new PoolPriceUnrepresentable(sqrtPriceX96, liquidity)
  }
  return {
    virtualTokenReservesTok,
    virtualQuoteReservesWei: quoteUnitsToWei(virtualQuoteUnits),
    realTokenReservesTok: tokenIsCurrency0 ? real0 : real1,
    realQuoteReservesWei: quoteUnitsToWei(tokenIsCurrency0 ? real1 : real0),
  }
}
