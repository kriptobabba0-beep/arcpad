import { ARCPAD_ERROR_ABI, type ArcpadAbiError } from '@arcpad/shared/browser'
import { decodeErrorResult } from 'viem'
import { findRevertData } from './decodeRevert'

/**
 * ============ THE POOL SURFACE, AND WHY ITS ABI LIVES HERE ============
 *
 * After graduation a token trades in a Uniswap v4 pool, and **an EOA cannot
 * reach that pool at all**: `PoolManager.swap` is `onlyWhenUnlocked`, only
 * `unlock` opens the lock, and `unlock` calls back into `msg.sender` -- so a
 * swap requires a CONTRACT that holds the callback. Arc has no Universal
 * Router. `ArcpadRouter` is that contract, and it is the only way in.
 *
 * `ArcpadRouter` is NOT one of the five units `@arcpad/shared` distributes, and
 * it stays that way for the reason `lib/graduationAbi.ts` already records:
 * `packages/shared/test/abi-parity.test.ts` deep-compares every distributed ABI
 * against `contracts/out/**` in its own Foundry-bearing CI job, so a sixth unit
 * means changing a shared package AND its parity gate AND running `forge`.
 * `keeper/src/graduate/abi.ts` and `lib/graduationAbi.ts` both declined that;
 * this is the third instance of the same decision, and `test/pool/abi.test.ts`
 * compares this file against the compiled artifact whenever one is on disk.
 *
 * ============ TWO ERROR SETS, BECAUSE A SWAP CROSSES FOUR CONTRACTS ============
 *
 *   `ROUTER_ERROR_ABI`   what `ArcpadRouter` itself declares. Parity-checked
 *                        against the artifact in BOTH directions.
 *   `POOL_BUBBLED_ERROR_ABI`
 *                        what arrives at the wallet from INSIDE the call:
 *                        `PoolManager`, `ArcpadHook`, and the two ERC-20s.
 *                        A router cannot declare these and viem cannot decode
 *                        them without being told, so a swap that failed for
 *                        the single most likely reason would read as "something
 *                        went wrong".
 *
 * The ERC-20 half is not retyped: it is filtered out of `ARCPAD_ERROR_ABI` by
 * name, so if `LaunchToken`'s distributed ABI changes shape this follows it.
 *
 * ============ AND ONE OF THEM IS NOT A CUSTOM ERROR AT ALL ============
 *
 * MEASURED 2026-08-09 by `eth_call` against the LIVE USDC at `0x3600…0000`,
 * with the live router as `msg.sender` and no allowance:
 *
 *     transferFrom(0xe92c64C4…, router, 1)
 *       -> 0x08c379a0…  Error(string) "ERC20: transfer amount exceeds allowance"
 *
 * Arc's USDC is a Circle FiatToken, not an OpenZeppelin ERC-20. **The buy leg's
 * allowance failure is a STRING revert; the sell leg's is
 * `ERC20InsufficientAllowance(address,uint256,uint256)`, a custom error**, because
 * the sell leg moves `LaunchToken`, which IS OpenZeppelin. Two legs, two wire
 * shapes, one user-visible cause -- the exact shape of this repo's recurring
 * "covered on one entrypoint reads as covered on all". `lib/poolOutcome.ts`
 * recognises both and `test/pool/abi.test.ts` pins the measured string.
 */

// --------------------------------------------------------------------------
// The router's own surface
// --------------------------------------------------------------------------

/**
 * `ArcpadRouter`'s declared errors -- all sixteen, in the artifact's order.
 *
 * `QuoteResult` is on this list and is NOT a failure: the quoter runs the real
 * swap through the real hook inside `unlock` and REVERTS with the answer, so
 * this "error" is the quote's return channel. See `decodeQuoteResult`.
 */
export const ROUTER_ERROR_ABI = [
  { type: 'error', name: 'AddressEmptyCode', inputs: [{ name: 'target', type: 'address' }] },
  {
    type: 'error',
    name: 'AddressInsufficientBalance',
    inputs: [{ name: 'account', type: 'address' }],
  },
  { type: 'error', name: 'AmountOutOfRange', inputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'error', name: 'BaseIsQuote', inputs: [] },
  {
    type: 'error',
    name: 'DeadlinePassed',
    inputs: [
      { name: 'deadline', type: 'uint256' },
      { name: 'nowTimestamp', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'FailedInnerCall', inputs: [] },
  {
    type: 'error',
    name: 'LegSignsUnexpected',
    inputs: [
      { name: 'inDelta', type: 'int256' },
      { name: 'outDelta', type: 'int256' },
    ],
  },
  { type: 'error', name: 'NotPoolManager', inputs: [] },
  {
    type: 'error',
    name: 'PartialFill',
    inputs: [
      { name: 'requested', type: 'int256' },
      { name: 'filled', type: 'int256' },
    ],
  },
  { type: 'error', name: 'QuoteDidNotRevert', inputs: [] },
  {
    type: 'error',
    name: 'QuoteResult',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOut', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  {
    type: 'error',
    name: 'TooLittleReceived',
    inputs: [
      { name: 'got', type: 'uint256' },
      { name: 'min', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'TooMuchRequested',
    inputs: [
      { name: 'paid', type: 'uint256' },
      { name: 'max', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'ZeroBase', inputs: [] },
  { type: 'error', name: 'ZeroRecipient', inputs: [] },
] as const satisfies readonly ArcpadAbiError[]

/** The ERC-20 names reachable through a swap, TAKEN from the distributed ABI. */
export const SWAP_ERC20_ERROR_NAMES = [
  'ERC20InsufficientAllowance',
  'ERC20InsufficientBalance',
  'ERC20InvalidReceiver',
  'ERC20InvalidSender',
] as const

const ERC20_NAMES: readonly string[] = SWAP_ERC20_ERROR_NAMES

/**
 * What can revert INSIDE a router call without the router declaring it.
 *
 * `PoolManager`: `PoolNotInitialized` is the state of EVERY arcpad token today
 * -- measured live on 2026-08-09, `quoteBuyExactIn` against both production
 * curves' tokens returned `0x486aa307` -- and `SwapAmountCannotBeZero`,
 * `CurrencyNotSettled` and `ManagerLocked` are the three the callback path can
 * still raise. `ArcpadHook`: the pool-side guards. The remaining v4 errors
 * (`TickSpacingTooLarge`, `ProtocolFeeTooLarge`, …) belong to `initialize` and
 * governance, which no swap reaches.
 */
export const POOL_BUBBLED_ERROR_ABI: readonly ArcpadAbiError[] = [
  // ---- Uniswap v4 `PoolManager` -----------------------------------------
  { type: 'error', name: 'PoolNotInitialized', inputs: [] },
  { type: 'error', name: 'SwapAmountCannotBeZero', inputs: [] },
  { type: 'error', name: 'CurrencyNotSettled', inputs: [] },
  { type: 'error', name: 'ManagerLocked', inputs: [] },
  { type: 'error', name: 'AlreadyUnlocked', inputs: [] },
  // ---- `ArcpadHook` ------------------------------------------------------
  { type: 'error', name: 'HookNotImplemented', inputs: [] },
  { type: 'error', name: 'InvalidBps', inputs: [] },
  { type: 'error', name: 'QuoteLegMissing', inputs: [] },
  { type: 'error', name: 'ZeroCurrency', inputs: [] },
  { type: 'error', name: 'ZeroReserves', inputs: [] },
  // ---- the two ERC-20s, from the distributed ABI -------------------------
  ...ARCPAD_ERROR_ABI.filter((entry) => ERC20_NAMES.includes(entry.name)),
]

/** Everything a swap or a quote can revert with. */
export const POOL_SWAP_ERROR_ABI: readonly ArcpadAbiError[] = [
  ...ROUTER_ERROR_ABI,
  ...POOL_BUBBLED_ERROR_ABI,
]

/**
 * THE FOUR SWAP SHAPES. Units are readable from the parameter names and that is
 * the contract's own decision: `quote*` is 6-decimal ERC-20 USDC, `tokens*` is
 * 18-decimal token wei. A single `swap(bool buy, …)` entrypoint would have
 * erased the distinction from the interface.
 */
export const ROUTER_SWAP_FUNCTIONS = [
  'buyExactIn',
  'buyExactOut',
  'sellExactIn',
  'sellExactOut',
] as const
export type RouterSwapFn = (typeof ROUTER_SWAP_FUNCTIONS)[number]

export const ROUTER_QUOTE_FUNCTIONS = [
  'quoteBuyExactIn',
  'quoteBuyExactOut',
  'quoteSellExactIn',
  'quoteSellExactOut',
] as const
export type RouterQuoteFn = (typeof ROUTER_QUOTE_FUNCTIONS)[number]

const swapFn = (name: RouterSwapFn, a: string, b: string, out: string) =>
  ({
    type: 'function',
    name,
    inputs: [
      { name: 'token', type: 'address' },
      { name: a, type: 'uint256' },
      { name: b, type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: out, type: 'uint256' }],
    stateMutability: 'nonpayable',
  }) as const

/**
 * `nonpayable`, not `view`, AND THAT IS LOAD-BEARING. A v4 price is only
 * knowable by running the swap: the pool fee is zero and `ArcpadHook` takes its
 * cut through `beforeSwap`/`afterSwap` return deltas, so any off-chain
 * re-derivation of the AMM curve cannot see the fee and would quote the user a
 * number they will not get. These four run the REAL swap through the REAL hook
 * inside `unlock` and revert with the result, so an `eth_call` is a quote and
 * `quote == realized` is asserted in the contract's own suite for 4 shapes x 2
 * currency orderings.
 */
const quoteFn = (name: RouterQuoteFn, a: string, out: string) =>
  ({
    type: 'function',
    name,
    inputs: [
      { name: 'token', type: 'address' },
      { name: a, type: 'uint256' },
    ],
    outputs: [{ name: out, type: 'uint256' }],
    stateMutability: 'nonpayable',
  }) as const

export const ARCPAD_ROUTER_ABI = [
  swapFn('buyExactIn', 'quoteIn', 'minTokensOut', 'tokensOut'),
  swapFn('buyExactOut', 'tokensOut', 'maxQuoteIn', 'quoteIn'),
  swapFn('sellExactIn', 'tokensIn', 'minQuoteOut', 'quoteOut'),
  swapFn('sellExactOut', 'quoteOut', 'maxTokensIn', 'tokensIn'),
  quoteFn('quoteBuyExactIn', 'quoteIn', 'tokensOut'),
  quoteFn('quoteBuyExactOut', 'tokensOut', 'quoteIn'),
  quoteFn('quoteSellExactIn', 'tokensIn', 'quoteOut'),
  quoteFn('quoteSellExactOut', 'quoteOut', 'tokensIn'),
  {
    type: 'function',
    name: 'poolManager',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'hook',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'RouterSwap',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      // NOT indexed -- the same choice `BondingCurve.Trade` made for `isBuy`.
      // Filtering on it through topics returns SILENTLY EMPTY.
      { name: 'buy', type: 'bool', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  ...POOL_SWAP_ERROR_ABI,
] as const

/**
 * SELECTORS AND ONE STRING, MEASURED SOMEWHERE ELSE, PINNED HERE.
 *
 * Derivation alone is silent about a typo: a misspelled name derives a
 * different selector, throws nothing, and turns a real revert into "we have no
 * text for this". Everything below was read off the LIVE Arc testnet node on
 * 2026-08-09 by `eth_call` against the deployed router `0x6D9f4270…`;
 * `test/pool/abi.test.ts` re-derives each from the ABI above and compares.
 */
export const MEASURED_ROUTER_SELECTORS = {
  /**
   * `quoteBuyExactIn(token, 1_000_000)` against BOTH production tokens
   * (`0x085C926e…`, `0x637aF6af…`). This is the state of every arcpad token
   * today, and the panel's "no pool yet" branch is keyed on exactly this.
   */
  PoolNotInitialized: '0x486aa307',
  /**
   * `quoteSellExactIn(0x3600…0000, 1)` -- USDC handed in as the BASE token.
   * `GraduationMath.poolKey` refuses `base == QUOTE`, so a user who pastes the
   * quote asset's address never reaches a pool.
   */
  BaseIsQuote: '0x340508eb',
  QuoteResult: '0xc5590f44',
  DeadlinePassed: '0x83f2ba20',
  TooLittleReceived: '0x4e86d23a',
  TooMuchRequested: '0x79cb628f',
} as const

/**
 * Arc's live USDC is a Circle FiatToken and reverts with `Error(string)`.
 * MEASURED against `0x3600…0000` with the live router as spender and no
 * allowance; the exact bytes were `0x08c379a0` + this string.
 */
export const MEASURED_USDC_ALLOWANCE_REVERT = 'ERC20: transfer amount exceeds allowance'

// --------------------------------------------------------------------------
// The quote's return channel
// --------------------------------------------------------------------------

export type PoolQuoteResult = {
  /** Buy: 6-decimal USDC units. Sell: 18-decimal token wei. */
  readonly amountIn: bigint
  /** Buy: 18-decimal token wei. Sell: 6-decimal USDC units. */
  readonly amountOut: bigint
}

/**
 * A SUCCESSFUL QUOTE ARRIVES AS A REVERT, and this is the only place that fact
 * is decoded.
 *
 * `null` means "this revert was NOT a quote" -- a real failure, which the
 * caller must then hand to `decodePoolSwapError`. Returning a zero pair instead
 * would render "you receive 0" for a pool that does not exist.
 *
 * BOTH SHAPES ARE HANDLED because both occur: wagmi's `simulateContract` hands
 * back a decoded `ContractFunctionRevertedError` when the ABI knows the error,
 * and a bare transport hands back raw hex. The second path is not
 * belt-and-braces -- `findRevertData` is the only one that works when the error
 * crossed a serialisation boundary.
 */
export function decodeQuoteResult(error: unknown): PoolQuoteResult | null {
  const named = (error as { data?: { errorName?: unknown; args?: unknown } } | null)?.data
  const fromCause = revertedArgs(error)
  const direct =
    named !== undefined && named !== null && named.errorName === 'QuoteResult'
      ? (named.args as readonly unknown[] | undefined)
      : undefined
  const args = direct ?? fromCause
  if (args === undefined || args.length < 2) return null
  const [amountIn, amountOut] = args
  if (typeof amountIn !== 'bigint' || typeof amountOut !== 'bigint') return null
  return { amountIn, amountOut }
}

function revertedArgs(error: unknown): readonly unknown[] | undefined {
  // Walk viem's wrappers for a decoded revert first...
  let current: unknown = error
  for (let depth = 0; depth < 12 && current != null; depth += 1) {
    const data = (current as { data?: { errorName?: unknown; args?: unknown } }).data
    if (data !== null && typeof data === 'object' && data.errorName === 'QuoteResult') {
      return data.args as readonly unknown[]
    }
    current = (current as { cause?: unknown }).cause
  }
  // ...then fall back to raw bytes.
  //
  // ONE GUARD, NOT TWO, AND THE SECOND WAS MEASURED TO BE DEAD. This path used
  // to check `raw.startsWith(QuoteResult selector)` BEFORE decoding and then
  // check `decoded.errorName` after. Mutation testing killed neither: removing
  // either one alone left the other covering it, so each read as tested while
  // being individually removable. That is the same shape the contract's own
  // campaign found in `_decodeQuote`, and two mutually-masking guards are worse
  // than one live guard -- the surviving one is never exercised alone, so
  // nobody learns which one actually decides.
  //
  // The NAME check is the one kept, because it is the one that means something:
  // `LegSignsUnexpected(int256,int256)` is the same 68 bytes as a quote and
  // decodes to two perfectly good integers. A decoder that let it through would
  // report a refused dust sell as "you receive -1".
  const raw = findRevertData(error)
  if (raw === undefined || raw.length < 10) return undefined
  try {
    const decoded = decodeErrorResult({
      abi: ROUTER_ERROR_ABI,
      data: raw as `0x${string}`,
    })
    return decoded.errorName === 'QuoteResult' ? decoded.args : undefined
  } catch {
    return undefined
  }
}

/**
 * The revert NAME behind any pool failure, or `undefined` when the wire carried
 * a string (live USDC) or nothing at all. Shared by `lib/poolOutcome.ts`.
 */
export function poolRevertName(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 12 && current != null; depth += 1) {
    const name = (current as { data?: { errorName?: unknown } }).data
    if (name !== null && typeof name === 'object' && typeof name.errorName === 'string') {
      return name.errorName
    }
    current = (current as { cause?: unknown }).cause
  }
  const raw = findRevertData(error)
  if (raw === undefined || raw === '0x' || raw.length < 10) return undefined
  try {
    return decodeErrorResult({ abi: POOL_SWAP_ERROR_ABI, data: raw as `0x${string}` }).errorName
  } catch {
    return undefined
  }
}
