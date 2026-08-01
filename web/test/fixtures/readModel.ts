import type {
  HolderRow,
  IndexerStatus,
  ReadResult,
  TokenOverview,
  TradeRow,
} from '@/components/read/types'

/**
 * FIXTURE'LAR SABITLENMIS SATIRLARDIR, HESAPLANMIS DEGIL.
 *
 * Hesaplanmis bir fixture, bilesenin kullandigi aritmetigin AYNISINI kullanir;
 * o aritmetikteki bir hata testi de ayni yone kaydirir ve test yesil kalir --
 * "iddia dogru ve onu dogru yapan sey ortuk" sinifinin ta kendisi.
 *
 * Asagidaki her sayi ya zincirde OLCULDU ya da elle turetildi; kaynagi
 * yaninda yaziyor.
 *
 * TIPLER FAZ 3'UN TIPLERIDIR: `bigint` ve `Date`, dize degil. Dizelerle
 * yazilmis bir fixture, gercekte olmayan bir donusum adimini test etmis olurdu.
 *
 * NOT: `token_overview` view'i `name_hex`/`symbol_hex`/`uri_hex`/`salt`
 * sutunlarini DISARI VERMIYOR. Yani kanoniklik istemci tarafinda ham
 * baytlardan YENIDEN TURETILEMEZ ve tek yol zincirdeki `isCanonical`'dir
 * (`verifyCanonical`). Bu bir eksiklik degil, nerede dogrulandiginin kaydi.
 */

/** Zincirde su an duran launch. Factory `launchCount` = 1. */
export const SMOKE: TokenOverview = {
  token: '0x1bd93613a7bc470a739d9615cdc65e535d958fab',
  curve: '0x7938be340a14a12f94a83aea246d9d2566324c9c',
  name: 'Smoke',
  symbol: 'SMOKE',
  uri: 'ipfs://smoke',
  launchCreator: '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439',
  feeCreator: '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439',

  // OLCULDU (zincirden, 2026-08-01):
  //   INITIAL_VIRTUAL_TOKEN_RESERVES 1.073e27, virtualTokenReserves 2.799e26
  //   INITIAL_REAL_TOKEN_RESERVES    7.931e26, realTokenReserves    0
  //   INITIAL_VIRTUAL_QUOTE_RESERVES 4.292e18, realQuoteReserves    12161433369060378714
  virtualTokenReservesTok: 279_900_000_000_000_000_000_000_000n,
  virtualQuoteReservesWei: 16_453_433_369_060_378_714n,
  realTokenReservesTok: 0n,
  realQuoteReservesWei: 12_161_433_369_060_378_714n,

  complete: true,
  completedSeq: 4_194_304n,
  // OLCULDU: poolSeedSupply. `T - S` DEGILDIR -- aradaki fark
  // 13_988_816_402_609_506_057_782 taban, yani 13.988,816 token kalici kilitli.
  poolSeedSupplyTok: 206_886_011_183_597_390_493_942_218n,

  marketCapWei: 58_783_256_052_377_201_521n,
  priceWeiPerTok: 58_783_256_052n,
  progressPpm: 1_000_000,
  // K3: R testnet. `R = V*S/(T-S)` -- BU formul gercekten `T - S` kullanir.
  graduationRaiseWei: 12_161_433_369_060_378_706n,

  holderCount: 1,
  volumeTotalWei: 12_161_433_369_060_378_714n,
  volume24hWei: 0n,
  athMarketCapWei: 58_783_256_052_377_201_521n,
  tradeCount: 1,
  buyCount: 1,
  lastTradeSeq: 4_194_304n,
  lastBuySeq: 4_194_304n,
  lastTradeAt: new Date('2026-07-31T12:00:00.000Z'),
  lastBuyAt: new Date('2026-07-31T12:00:00.000Z'),
  createdSeq: 4_194_300n,
  createdAt: new Date('2026-07-31T11:59:00.000Z'),
}

/**
 * Tirmanmakta olan bir curve. `progressPpm` ELLE turetildi:
 *   1e6 - ceil(kalan * 1e6 / S),  S = 793_100_000e18
 *   kalan = 592_376_046_879_238_259_473_675_895
 *   ceil(592376046879238259473675895 * 1e6 / 793100000e18) = 746_913
 *   1e6 - 746_913 = 253_087
 */
export const CLIMBING: TokenOverview = {
  ...SMOKE,
  token: '0x00000000000000000000000000000000000000aa',
  curve: '0x00000000000000000000000000000000000000bb',
  name: 'Diff',
  symbol: 'DIFF',
  uri: 'ipfs://diff',
  virtualQuoteReservesWei: 5_279_654_320_987_654_320n,
  virtualTokenReservesTok: 872_276_046_879_238_259_473_675_895n,
  realTokenReservesTok: 592_376_046_879_238_259_473_675_895n,
  realQuoteReservesWei: 987_654_320_987_654_320n,
  complete: false,
  completedSeq: null,
  poolSeedSupplyTok: null,
  // Elle turetildi: mulDiv(Vq, 1e27, Vt)
  marketCapWei: 6_052_733_351_875_009_052n,
  // Elle turetildi: mulDiv(Vq, 1e18, Vt)
  priceWeiPerTok: 6_052_733_351n,
  progressPpm: 253_087,
  holderCount: 1,
  tradeCount: 1,
  buyCount: 1,
}

/** Bir alim. Ucretler K2'nin olculmus 1 USDC vektorunden. */
export const BUY_ONE_USDC: TradeRow = {
  eventSeq: 4_194_304n,
  txHash: `0x${'11'.repeat(32)}`,
  blockTime: new Date('2026-07-31T12:00:00.000Z'),
  trader: '0x00000000000000000000000000000000000000cc',
  isBuy: true,
  tokenAmountTok: 164_000_000_000_000_000_000_000n,
  // CURVE tutari. Cuzdandan cikan tutar bu DEGILDIR.
  quoteAmountWei: 987_654_320_987_654_320n,
  protocolFeeWei: 9_382_716_049_382_717n,
  creatorFeeWei: 2_962_962_962_962_963n,
  virtualTokenReservesTok: CLIMBING.virtualTokenReservesTok,
  virtualQuoteReservesWei: CLIMBING.virtualQuoteReservesWei,
  isDev: false,
}

/** Ayni buyuklukte bir satim. Ucret ciktidan DUSULUR. */
export const SELL_ONE_USDC: TradeRow = {
  ...BUY_ONE_USDC,
  eventSeq: 4_194_305n,
  isBuy: false,
}

export const HOLDER: HolderRow = {
  holder: '0x00000000000000000000000000000000000000cc',
  balanceTok: 164_000_000_000_000_000_000_000n,
}

/**
 * INDEXER TAZELIGI, IKI DURUM.
 *
 * Faz 3 her okumaya `IndexerStatus` iliştirir ve `stale` esigi
 * `DEFAULT_STALE_AFTER_SECONDS = 30`'dur. Gerekcesi Arc'in blok suresi:
 * ~350 ms, ve dongu bos aralikta bile imleci ilerletir, yani saglikli bir
 * indexer'da `updatedAt` saniyeler icinde tazelenir. 30 sn gecici bir RPC
 * yavaslamasini alarma cevirmeyecek kadar genis, bir DURAKLAMAYI kullanicidan
 * gizlemeyecek kadar dardir.
 */
export const LIVE_INDEXER: IndexerStatus = {
  lastBlock: 4n,
  lastBlockHash: `0x${'ab'.repeat(32)}`,
  updatedAt: new Date('2026-07-31T12:00:02.000Z'),
  stalenessSeconds: 2,
  stale: false,
}

/** 15 dakika geride. Veri VAR ama GUNCEL DEGIL -- en pahali durum. */
export const STALE_INDEXER: IndexerStatus = {
  lastBlock: 4n,
  lastBlockHash: `0x${'ab'.repeat(32)}`,
  updatedAt: new Date('2026-07-31T11:45:00.000Z'),
  stalenessSeconds: 900,
  stale: true,
}

/** Basarili bir okuma. Tazelik ZORUNLU ALAN oldugu icin varsayilanla gelir. */
export function ok<T>(data: T, indexer: IndexerStatus = LIVE_INDEXER): ReadResult<T> {
  // Bayatlik AYRI BIR DAL: alan adi da degisir (`staleData`), yani bir cagiran
  // bayat dali unuttugunda derleme kirilir.
  return indexer.stale
    ? { ok: true, stale: true, staleData: data, indexer }
    : { ok: true, stale: false, data, indexer }
}
