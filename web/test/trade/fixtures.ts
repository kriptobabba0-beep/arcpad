import {
  asTok,
  asWei,
  type CurveProfile,
  type CurveState,
  type FeeBps,
} from '@arcpad/shared/browser'

/**
 * AL-SAT PANELININ VEKTORLERI.
 *
 * `web/test/fixtures/readModel.ts` OKUMA MODELININ satirlarini tasiyor
 * (`TokenOverview`, `TradeRow`); panel veritabanina hic bakmiyor ve
 * `CurveState` ile calisiyor, yani buradaki fixture'lar o dosyanin kopyasi
 * degil BASKA BIR SEY.
 *
 * Sayilarin hepsi ya zincirde olculdu ya elle turetildi ve kaynagi yaninda
 * yaziyor. Hesaplanmis bir fixture olsaydi -- planlayiciyi cagirip sonucunu
 * beklenen deger yapmak gibi -- planlayicidaki bir hata testi de ayni yone
 * kaydirir ve test yesil kalirdi.
 */

/**
 * TESTNET PROFILI, zincirdeki `LaunchFactory`'nin immutable'larindan
 * (`web/lib/profile.ts` bunlari `VIRTUAL_TOKEN_RESERVES` / `VIRTUAL_QUOTE_RESERVES`
 * / `SALE_SUPPLY` olarak okur):
 *   T = 1.073e27   V = 4.292e18   S = 7.931e26
 */
export const TESTNET_PROFILE: CurveProfile = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292n * 10n ** 15n,
  saleSupply: 793_100_000n * 10n ** 18n,
}

/** `BondingCurve.PROTOCOL_FEE_BPS` / `CREATOR_FEE_BPS`, bu dagitimda 95 / 30. */
export const FEES: FeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n }

/** Ucret rejiminin ust ucu. `==` iddiasi bu noktada %25 vakada YANLIS olur. */
export const EXTREME_FEES: FeeBps = { protocolFeeBps: 5000n, creatorFeeBps: 5000n }

export const CREATOR = '0x00000000000000000000000000000000000000dd'
export const ZERO_CREATOR = '0x0000000000000000000000000000000000000000'
export const TRADER = '0x00000000000000000000000000000000000000cc'
export const CURVE = '0x00000000000000000000000000000000000000bb'
export const TOKEN = '0x00000000000000000000000000000000000000aa'

/**
 * TAZE BIR TESTNET CURVE -- hic islem gormemis.
 *
 * `rT = S` ve `rQ = 0`; sanal rezervler profilin kendisi. Acilis fiyati
 * `mulDiv(V, 1e18, T) = 4_000_000_000` wei/token, yani `0.0₈4`.
 */
export const FRESH: CurveState = {
  virtualTokenReserves: TESTNET_PROFILE.virtualTokenReserves,
  virtualQuoteReserves: TESTNET_PROFILE.virtualQuoteReserves,
  realTokenReserves: asTok(TESTNET_PROFILE.saleSupply),
  realQuoteReserves: asWei(0n),
  complete: false,
  creator: CREATOR,
}

/** Acilis fiyati. Elle turetildi: `4.292e18 × 1e18 / 1.073e27`. */
export const FRESH_PRICE_WEI = 4_000_000_000n

/** Ayni curve, creator'i SIFIR: creator payi hic alinmaz ve KATLANMAZ. */
export const FRESH_NO_CREATOR: CurveState = { ...FRESH, creator: ZERO_CREATOR }

/**
 * 1 USDC'lik bir alimdan SONRAKI durum -- `readModel.ts`'in `CLIMBING`
 * fixture'iyla ayni an, `CurveState` gorunumunde.
 */
export const CLIMBED: CurveState = {
  virtualTokenReserves: 872_276_046_879_238_259_473_675_895n,
  virtualQuoteReserves: 5_279_654_320_987_654_320n,
  realTokenReserves: asTok(592_376_046_879_238_259_473_675_895n),
  realQuoteReserves: asWei(987_654_320_987_654_320n),
  complete: false,
  creator: CREATOR,
}

/**
 * 1,000000 USDC BUTCELI BIR `buyExactQuoteIn`, TAZE CURVE'DE -- K2'nin olculmus
 * vektoru. Panelin dokum satirlarinin tamami bu sayilarin uzerinde duruyor.
 */
export const ONE_USDC = 1_000_000_000_000_000_000n
export const ONE_USDC_CURVE_AMOUNT = 987_654_320_987_654_320n
export const ONE_USDC_PROTOCOL_FEE = 9_382_716_049_382_717n
export const ONE_USDC_CREATOR_FEE = 2_962_962_962_962_963n
/** `floor((net-1)·T/(V+net-1))`. `packages/shared/test/curve.test.ts`'te sabit. */
export const ONE_USDC_TOKENS = 200_723_953_120_761_740_526_324_105n
/** `floor(tokens × 9900 / 10_000)`, %1 slipaj -- model testinin ACIKCA gectigi. */
export const ONE_USDC_MIN_TOKENS = 198_716_713_589_554_123_121_060_863n
/**
 * `floor(tokens × 9750 / 10_000)`, %2.5 slipaj -- panelin VARSAYILANI
 * (`DEFAULT_SLIP_BPS`).
 *
 * IKISI AYRI SABIT, ve olmasi gereken de bu: model testi toleransi acikca
 * gecer (bir formul dogrulanir), panel testi ise HICBIR SEY gecmez ve
 * varsayilanin ne oldugunu olcer. Tek sabit olsaydi varsayilan degistiginde
 * formul testi de sessizce yeni degere uyarlanir, yani varsayilani koruyan
 * kapi kalmazdi.
 */
export const ONE_USDC_MIN_TOKENS_AUTO = 195_705_854_292_742_697_013_166_002n

/** `CLIMBED`'in fiyati. Elle turetildi: `mulDiv(vQ, 1e18, vT)`. */
export const CLIMBED_PRICE_WEI = 6_052_733_351n

/**
 * GIDIS-DONUS, OLCULDU. `ONE_USDC_TOKENS` tokeni `CLIMBED`'e geri satmak:
 *   proceeds 987_654_320_987_654_319  (alimda odenen curve tutarindan BIR EKSIK)
 *   net      975_308_641_975_308_639
 * yani 1,000000 USDC ile alip hemen satan kullanici 0,975308 USDC alir; kayip
 * 24_691_358_024_691_361 wei = %2,4691. Panelin satis dokumundeki cumle bu.
 */
export const ROUND_TRIP_NET = 975_308_641_975_308_639n
export const ROUND_TRIP_LOSS = ONE_USDC - ROUND_TRIP_NET

export const COMPLETED: CurveState = {
  ...CLIMBED,
  realTokenReserves: asTok(0n),
  complete: true,
}

/**
 * ==========================================================================
 *  THE PRODUCTION PROFILE. NOT A MADE-UP ONE -- THE REAL OTHER PROFILE.
 * ==========================================================================
 *
 * This began life as an invented "deep" fixture and turned out to be the
 * PRODUCTION profile exactly: testnet and production differ in `V` and ONLY in
 * `V`, by exactly 1000. `profileDigest` of the triple below equals the pinned
 * `PROFILE_DIGESTS.production`, and `model.test.ts` asserts that rather than
 * leaving this comment to be believed.
 *
 * IT EXISTS HERE BECAUSE THE MONEY-CHIP LADDER IS PER PROFILE:
 *   testnet     $1  ·  $5  ·  $10
 *   production  $25 · $100 · $500
 *
 * and a ladder tested on only one profile is a ladder tested once. The numbers
 * that make the two ladders right are the same factor of 1000: a testnet curve
 * absorbs 12.161433 USDC in total and a production curve 12_161.43, measured
 * against the live curve `0x53Bba88F...44c9` on 2026-08-10.
 */
export const PRODUCTION_PROFILE: CurveProfile = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292n * 10n ** 18n,
  saleSupply: 793_100_000n * 10n ** 18n,
}

export const PRODUCTION_FRESH: CurveState = {
  virtualTokenReserves: PRODUCTION_PROFILE.virtualTokenReserves,
  virtualQuoteReserves: PRODUCTION_PROFILE.virtualQuoteReserves,
  realTokenReserves: asTok(PRODUCTION_PROFILE.saleSupply),
  realQuoteReserves: asWei(0n),
  complete: false,
  creator: CREATOR,
}

/** Half the sale supply -- enough for the $500 sell chip to resolve on a fresh production curve. */
export const PRODUCTION_HOLDING = PRODUCTION_PROFILE.saleSupply / 2n
