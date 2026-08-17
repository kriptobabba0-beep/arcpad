import { parseAbi } from 'viem'

/**
 * ============ SUPURME YOLUNUN ABI'SI -- DAR TUTULUR ============
 *
 * `graduate/abi.ts` ile ayni kural: yalnizca BU yolun cagirdigi uyeler. Genis
 * bir ABI, bir gun cagrilmayacak bir fonksiyonu cagrilabilir gosterir ve
 * yazarin "bunu da kullanabilirim" demesini kolaylastirir -- oysa anahtarcinin
 * yuzeyi kucuk olmali.
 */

export const TREASURY_ABI = parseAbi([
  // --- karar girdileri --------------------------------------------------
  'function spendable(address token) view returns (uint256)',
  'function sweepIsPermissionless(address token) view returns (bool)',
  'function pendingQuote(address token) view returns (uint256)',
  'function lastSweepAt(address token) view returns (uint256)',
  'function MIN_SWEEP_WEI() view returns (uint256)',
  'function SWEEP_GRACE() view returns (uint256)',
  // --- zincir pini ------------------------------------------------------
  'function factory() view returns (address)',
  'function vault() view returns (address)',
  // --- eylem ------------------------------------------------------------
  'function sweep(address token, uint256 minTokensOut, uint256 deadline)',
  // --- kesfin tek kaynagi ----------------------------------------------
  'event BuybackAccrued(address indexed token, address indexed venue, uint256 quoteAmount, uint256 pending)',
  // --- HAVUZ MERCIININ MIKTAR KANALI -----------------------------------
  //
  // `SlippageTooHigh` bir hata DEGIL, bir DONUS KANALIDIR -- `ArcpadRouter`in
  // `QuoteResult`i ile ayni desen. `minTokensOut = type(uint256).max` ile
  // yapilan bir `eth_call` havuzun GERCEKTEN verecegi miktari `got` alaninda
  // geri getirir. Mezuniyet sonrasinda baska bir yolu yoktur: emilen tutar
  // fiyat sinirina kadar gecilen tick'lerdeki likiditeye baglidir ve ancak
  // swap KOSTURULARAK bilinir (`BuybackTreasury.spendable`in NatSpec'i bunu
  // aynen soyluyor).
  'error SlippageTooHigh(uint256 got, uint256 minTokensOut)',
  'error NotKeeper()',
  'error NothingPending()',
  'error DeadlinePassed()',
])

/** Egrinin, merci secimi ve teklif icin okunan uyeleri. */
export const CURVE_ABI = parseAbi([
  'function graduated() view returns (bool)',
  'function complete() view returns (bool)',
  'function creator() view returns (address)',
  'function virtualQuoteReserves() view returns (uint256)',
  'function virtualTokenReserves() view returns (uint256)',
  'function realTokenReserves() view returns (uint256)',
  'function realQuoteReserves() view returns (uint256)',
])

export const TOKEN_ABI = parseAbi(['function curve() view returns (address)'])

export const FACTORY_ABI = parseAbi([
  'function buybackTreasury() view returns (address)',
  'function buybackKeeper() view returns (address)',
  'function feeScheduleOf(address token) view returns (address)',
])

export const FEE_SCHEDULE_ABI = parseAbi([
  'function marketCap(uint256 quoteRaw, uint256 baseRaw) pure returns (uint256)',
  'function tierFor(uint256 marketCapUnits) pure returns (uint256 protocolBps, uint256 creatorBps)',
])
