/**
 * THE BROWSER-SAFE HALF OF THIS PACKAGE.
 *
 * The main barrel (`index.ts`) re-exports `addresses.ts` and `profiles.ts`,
 * and both of those `import { readFileSync } from 'node:fs'` at module scope.
 * A client component that imports the barrel therefore drags `node:fs` into
 * the browser chunk, and Turbopack refuses it:
 *
 *   the chunking context (unknown) does not support external modules
 *   (request: node:fs)
 *
 * That was not hypothetical -- `pnpm --filter @arcpad/web build` failed
 * exactly that way, through `providers.tsx -> lib/wagmi.ts ->
 * '@arcpad/shared'`, before this entry point existed.
 *
 * Tree-shaking is NOT the fix here. Whether a bundler drops an unused module
 * with a bare `node:` import depends on side-effect analysis, which is a
 * heuristic; a second entry point is a guarantee. Anything reachable from a
 * `'use client'` file imports `@arcpad/shared/browser`, and anything that
 * needs the address book or `profiles.toml` is server-side by construction.
 *
 * Every module re-exported below must depend on `viem` and nothing else from
 * Node. `test/browser-entry.test.ts` measures that rather than trusting it.
 */
export {
  ARCPAD_ERROR_ABI,
  ARCPAD_ERROR_NAMES,
  type ArcpadAbiError,
  bondingCurveAbi,
  curveMathErrorsAbi,
  errorSelector,
  feeEscrowAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from './abi/index'
export {
  type CorrectedNet,
  correctedNetQuoteIn,
  type CurveErrorName,
  CurveMathError,
  type CurveProfile,
  feeOn,
  graduationRaise,
  marketCap,
  netQuoteInBeforeCorrection,
  poolSeedSupply,
  priceWeiPerToken,
  progressPpm,
  quoteBuyCost,
  quoteBuyTokensOut,
  quoteSellProceeds,
} from './curve'
export {
  asTok,
  asWei,
  type CurveState,
  type FeeBps,
  netProceedsOf,
  planBuyExactQuoteIn,
  planBuyExactTokensOut,
  planSellExactTokensIn,
  resolveSellForNet,
  type SellForNetResult,
  type TokAmount,
  totalSpentOf,
  TRADE_ACTIONS,
  type TradeAction,
  type TradePlan,
  TradePlanError,
  type TradePlanErrorName,
  type WeiUsdc,
} from './trade'
export {
  assertErc20Callable,
  assertNotUsdcNativeSwap,
  type Erc20Usdc,
  erc20Usdc,
  isNativeSentinel,
  isUsdcErc20,
  NATIVE_SENTINELS,
  type NativeUsdc,
  nativeUsdc,
  readUsdcBalance,
  unifyUsdcViews,
  type UsdcBalance,
  type UsdcBalanceSource,
  UsdcViewError,
  type UsdcViewErrorKind,
} from './balance'
export {
  ARC_CHAINS,
  ARC_TESTNET_CHAIN_ID,
  type ArcChain,
  type ArcChainConfig,
  arcTestnet,
  buildArcChain,
  getArcChain,
  MULTICALL3_ADDRESS,
  USDC_ERC20_ADDRESS,
} from './chain'
export { assertArcChain, type ChainIdSource, createArcClient } from './client'
export {
  checkMetadataText,
  type MetadataCheck,
  type MetadataField,
  METADATA_LIMITS,
  normaliseMetadataText,
  sanitiseForDisplay,
  truncateToBytes,
  utf8ByteLength,
} from './text'
export {
  ERC20_USDC_DECIMALS,
  erc20ToNative,
  formatPriceWeiPerToken,
  formatTokenAmount,
  formatUsdc,
  formatUsdcAmount,
  formatUsdcCompact,
  NATIVE_USDC_DECIMALS,
  nativeToErc20,
  type ParsedUsdcAmount,
  type ParseReason,
  parseUsdcAmount,
  type Rounding,
  USDC_VIEW_SCALE,
} from './usdc'
