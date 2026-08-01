import type { HolderRow, TokenOverview, TradeRow } from '@/components/read/types'

/**
 * FIXTURE'LAR SABITLENMIS SATIRLARDIR, HESAPLANMIS DEGIL.
 *
 * Hesaplanmis bir fixture, bilesenin kullandigi aritmetigin AYNISINI kullanir;
 * o aritmetikteki bir hata testi de ayni yone kaydirir ve test yesil kalir.
 * "Iddia dogru ve onu dogru yapan sey ortuk" sinifinin ta kendisi.
 *
 * Asagidaki her sayi ya zincirde OLCULDU ya da elle turetildi. Kaynagi
 * yaninda yaziyor.
 */

/** Zincirde su an duran launch. Faktori `launchCount` = 1. */
export const SMOKE: TokenOverview = {
  token: '0x1bd93613a7bc470a739d9615cdc65e535d958fab',
  curve: '0x7938be340a14a12f94a83aea246d9d2566324c9c',
  name: 'Smoke',
  symbol: 'SMOKE',
  uri: 'ipfs://smoke',
  // HAM baytlar. Gosterim metninden TURETILEMEZ (pgSafeText coka-birdir) ve
  // kanoniklik yalnizca bunlardan dogrulanabilir.
  name_hex: '0x536d6f6b65',
  symbol_hex: '0x534d4f4b45',
  uri_hex: '0x697066733a2f2f736d6f6b65',
  salt: `0x${'00'.repeat(32)}`,
  launch_creator: '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439',
  fee_creator: '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439',

  // OLCULDU (zincirden, 2026-08-01):
  //   INITIAL_VIRTUAL_TOKEN_RESERVES 1.073e27, virtualTokenReserves 2.799e26
  //   INITIAL_REAL_TOKEN_RESERVES    7.931e26, realTokenReserves    0
  //   INITIAL_VIRTUAL_QUOTE_RESERVES 4.292e18, realQuoteReserves    12161433369060378714
  virtual_token_reserves_tok: '279900000000000000000000000',
  virtual_quote_reserves_wei: '16453433369060378714',
  real_token_reserves_tok: '0',
  real_quote_reserves_wei: '12161433369060378714',

  complete: true,
  completed_seq: '4194304',
  // OLCULDU: poolSeedSupply. `T - S` DEGILDIR -- aradaki fark
  // 13_988_816_402_609_506_057_782 tabani, yani 13.988,816 token kalici olarak
  // kilitli. Iki nicelik karistirilmamali.
  pool_seed_supply_tok: '206886011183597390493942218',

  market_cap_wei: '58783256052377201521',
  price_wei_per_token: '58783256052',
  // Curve tamamlandi: ilerleme 100%.
  progress_ppm: 1_000_000,
  // K3: R testnet. `R = V·S/(T-S)` -- bu formul GERCEKTEN `T - S` kullanir.
  graduation_raise_wei: '12161433369060378706',

  holder_count: 1,
  volume_total_wei: '12161433369060378714',
  volume_24h_wei: '0',
  ath_market_cap_wei: '58783256052377201521',
  trade_count: 1,
  buy_count: 1,
  last_trade_seq: '4194304',
  last_buy_seq: '4194304',
  last_trade_at: '2026-07-31T12:00:00.000Z',
  last_buy_at: '2026-07-31T12:00:00.000Z',
  created_seq: '4194300',
  created_at: '2026-07-31T11:59:00.000Z',
}

/**
 * Tirmanmakta olan bir curve. `progress_ppm` ELLE turetildi:
 *   1e6 - ceil(kalan * 1e6 / S), S = 793_100_000e18
 * kalan = 592_376_046_879_238_259_473_675_895
 *   ceil(592376046879238259473675895 * 1e6 / 793100000e18) = 746_913
 *   1e6 - 746913 = 253_087
 */
export const CLIMBING: TokenOverview = {
  ...SMOKE,
  token: '0x00000000000000000000000000000000000000aa',
  curve: '0x00000000000000000000000000000000000000bb',
  name: 'Diff',
  symbol: 'DIFF',
  uri: 'ipfs://diff',
  name_hex: '0x44696666',
  symbol_hex: '0x44494646',
  uri_hex: '0x697066733a2f2f64696666',
  virtual_quote_reserves_wei: '5279654320987654320',
  virtual_token_reserves_tok: '872276046879238259473675895',
  real_token_reserves_tok: '592376046879238259473675895',
  real_quote_reserves_wei: '987654320987654320',
  complete: false,
  completed_seq: null,
  pool_seed_supply_tok: null,
  // Elle turetildi: mulDiv(Vq, 1e27, Vt)
  market_cap_wei: '6052733351875009052',
  // Elle turetildi: mulDiv(Vq, 1e18, Vt)
  price_wei_per_token: '6052733351',
  progress_ppm: 253_087,
  holder_count: 1,
  trade_count: 1,
  buy_count: 1,
}

/** Bir alim. Ucretler K2'nin olculmus 1 USDC vektorunden. */
export const BUY_ONE_USDC: TradeRow = {
  event_seq: '4194304',
  block_number: '1000',
  log_index: 0,
  tx_hash: `0x${'11'.repeat(32)}`,
  block_time: '2026-07-31T12:00:00.000Z',
  token: CLIMBING.token,
  curve: CLIMBING.curve,
  trader: '0x00000000000000000000000000000000000000cc',
  is_buy: true,
  token_amount_tok: '164000000000000000000000',
  // Curve tutari. Cuzdandan cikan tutar bu DEGILDIR.
  quote_amount_wei: '987654320987654320',
  protocol_fee_wei: '9382716049382717',
  creator_fee_wei: '2962962962962963',
  virtual_token_reserves_tok: CLIMBING.virtual_token_reserves_tok,
  virtual_quote_reserves_wei: CLIMBING.virtual_quote_reserves_wei,
  real_token_reserves_tok: CLIMBING.real_token_reserves_tok,
  real_quote_reserves_wei: CLIMBING.real_quote_reserves_wei,
  source: 'curve',
  is_dev: false,
}

/** Ayni buyuklukte bir satim. Ucret ciktidan DUSULUR. */
export const SELL_ONE_USDC: TradeRow = {
  ...BUY_ONE_USDC,
  event_seq: '4194305',
  log_index: 1,
  is_buy: false,
}

export const HOLDER: HolderRow = {
  token: CLIMBING.token,
  holder: '0x00000000000000000000000000000000000000cc',
  balance_tok: '164000000000000000000000',
  last_seq: '4194304',
}
