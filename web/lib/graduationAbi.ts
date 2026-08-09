import { ARCPAD_ERROR_ABI, type ArcpadAbiError } from '@arcpad/shared/browser'

/**
 * ============ THE GRADUATION CALL, AND WHY ITS ABI LIVES HERE ============
 *
 * The user-facing graduation action is `ArcpadLocker.graduate(address curve)`.
 * `ArcpadLocker` is NOT one of the five contracts `@arcpad/shared` distributes,
 * and it deliberately stays that way: `packages/shared/test/abi-parity.test.ts`
 * deep-compares every distributed ABI against `contracts/out/**` and runs in its
 * own Foundry-bearing CI job, so adding a sixth unit means changing a shared
 * package AND its parity gate AND running `forge`. `keeper/src/graduate/abi.ts`
 * declined that same change for that same reason and hand-wrote a minimal ABI;
 * this is the web-side twin of that decision, and `test/token/graduation.test.ts`
 * compares it against the compiled artifact whenever one is on disk.
 *
 * TWO ABIs, BECAUSE THE CALL CROSSES TWO CONTRACTS.
 *
 *   `ARCPAD_LOCKER_ABI`      what we CALL. Function + the locker's own errors.
 *   `GRADUATION_ERROR_ABI`   what we DECODE. The locker's errors PLUS the
 *                            curve's graduation errors, because
 *                            `locker.graduate()` calls `curve.graduate()` and a
 *                            revert from the inner call arrives at the wallet
 *                            with the INNER contract's selector.
 *
 * The curve half is not retyped: it is filtered out of `ARCPAD_ERROR_ABI` by
 * name, so if `BondingCurve`'s distributed ABI ever changes shape this follows
 * it instead of silently disagreeing with it.
 */

/**
 * The curve-side errors reachable through `graduate()`.
 *
 * `TokenTransferFailed` is deliberately absent: `LaunchToken` is an OZ ERC-20,
 * which reverts on failure and never returns `false`, so the `if (!transfer(…))`
 * branch in `BondingCurve.graduate()` is unreachable with this token. That is
 * the same justification `web/lib/failureTable.ts` already carries for it, and
 * `BondingCurve.sol`'s own NatSpec states it in as many words.
 */
export const CURVE_GRADUATION_ERROR_NAMES = [
  'NotComplete',
  'AlreadyGraduated',
  'GraduationTargetUnset',
  'NotGraduationTarget',
  'GraduationPayoutFailed',
] as const

/**
 * `ArcpadLocker`'s own errors, plus the two OpenZeppelin ones its `SafeERC20`
 * and `Address` helpers can raise.
 *
 * `FailedInnerCall` is not padding: the keeper's fork proof measured exactly it
 * (`0x1425ea42`) when the locker ran against a forked Arc, raised inside live
 * USDC on reaching the `0x1800` native-asset precompile. A user pressing this
 * button behind a proxying RPC can see the same shape.
 */
export const LOCKER_ERROR_ABI = [
  { type: 'error', name: 'CurveNotFromFactory', inputs: [] },
  { type: 'error', name: 'NotPoolManager', inputs: [] },
  { type: 'error', name: 'PoolPriceMismatch', inputs: [] },
  { type: 'error', name: 'PositionNotSeeded', inputs: [] },
  { type: 'error', name: 'SeedShortfall', inputs: [] },
  { type: 'error', name: 'UnexpectedCredit', inputs: [] },
  { type: 'error', name: 'ZeroLiquidity', inputs: [] },
  // `GraduationMath`, reached from `graduate()`: pool key, price, seeding.
  { type: 'error', name: 'BaseIsQuote', inputs: [] },
  { type: 'error', name: 'PriceOutOfRange', inputs: [] },
  { type: 'error', name: 'ZeroBase', inputs: [] },
  { type: 'error', name: 'ZeroReserves', inputs: [] },
  // OpenZeppelin helpers used by the seeding leg.
  { type: 'error', name: 'AddressEmptyCode', inputs: [{ name: 'target', type: 'address' }] },
  {
    type: 'error',
    name: 'AddressInsufficientBalance',
    inputs: [{ name: 'account', type: 'address' }],
  },
  { type: 'error', name: 'FailedInnerCall', inputs: [] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
] as const satisfies readonly ArcpadAbiError[]

export const ARCPAD_LOCKER_ABI = [
  {
    type: 'function',
    name: 'graduate',
    inputs: [{ name: 'curve', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  ...LOCKER_ERROR_ABI,
] as const

const CURVE_NAMES: readonly string[] = CURVE_GRADUATION_ERROR_NAMES

/** The curve's graduation errors, taken FROM the distributed ABI, not retyped. */
export const CURVE_GRADUATION_ERROR_ABI: readonly ArcpadAbiError[] = ARCPAD_ERROR_ABI.filter(
  (entry) => CURVE_NAMES.includes(entry.name),
)

/** Everything a `graduate(curve)` revert can carry, for `decodeErrorResult`. */
export const GRADUATION_ERROR_ABI: readonly ArcpadAbiError[] = [
  ...LOCKER_ERROR_ABI,
  ...CURVE_GRADUATION_ERROR_ABI,
]

/**
 * SELECTORS MEASURED SOMEWHERE ELSE, PINNED HERE.
 *
 * Derivation alone would be silent about a typo: a misspelled name derives a
 * different selector, throws nothing, and turns a real revert into "we do not
 * have text for this". So the two selectors the keeper read OFF THE LIVE CHAIN
 * on 2026-08-09 (`keeper/src/graduate/outcome.ts`, `MEASURED_SELECTORS`) and the
 * one its fork proof produced are pinned, and `graduation.test.ts` re-derives
 * them from the ABI above and compares. Two sources, one comparison.
 */
export const MEASURED_GRADUATION_SELECTORS = {
  /** Live `eth_call` against the production locker + the completed smoke curve. */
  GraduationTargetUnset: '0xfe30fa5b',
  /** Live `eth_call` against the production locker + the open e2e curve. */
  NotComplete: '0x0701727f',
  /** Raised inside live USDC on a forked Arc; the keeper's local-chain proof. */
  FailedInnerCall: '0x1425ea42',
} as const
