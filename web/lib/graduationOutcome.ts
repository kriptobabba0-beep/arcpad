import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  InsufficientFundsError,
} from 'viem'
import type { FailureTone } from '@/components/errors/failureCopy'
import {
  describe,
  findError,
  findRevertData,
  isTransportFailure,
  isUserRejection,
} from './decodeRevert'
import { GRADUATION_ERROR_ABI } from './graduationAbi'

/**
 * ============ WHAT A FAILED `graduate(curve)` MEANS TO A USER ============
 *
 * A SECOND DICTIONARY, NOT A SEVENTH `ArcpadAction`, and the reason is the
 * gate rather than taste. `test/errors/reconcile.test.ts` derives the error
 * surface BY SCANNING THE SOLIDITY SOURCES along each action's call path and
 * requires (a) the declared surface to equal what the sources derive, in both
 * directions, and (b) every derived name to exist in `ARCPAD_ERROR_ABI`. A
 * truthful `CALL_PATH.graduate` is
 *
 *     ArcpadLocker.graduate -> BondingCurve.graduate
 *                           -> GraduationMath.{poolKey,sqrtPriceX96,seedLiquidity}
 *                           -> PoolManager.{initialize,modifyLiquidity}
 *                           -> ArcpadLocker.unlockCallback   (a CALLBACK: the
 *                              gate's static "is this hop really called" check
 *                              cannot see it at all)
 *
 * and it derives a dozen names -- `CurveNotFromFactory`, `ZeroLiquidity`,
 * `SeedShortfall`, `PriceOutOfRange`, the v4 core errors -- that are NOT in
 * `ARCPAD_ERROR_ABI`, because that barrel covers exactly the five parity-gated
 * units. Getting them in means editing `packages/shared`, its
 * `abi-parity.test.ts`, and running `forge`. So the six trade/launch/claim
 * actions keep their gate untouched, and graduation gets its own surface with
 * its own completeness check (`test/token/graduation.test.ts`), which is what
 * keeps this from being the eleventh "covered on one entrypoint, assumed on the
 * rest".
 *
 * ============ THE ONE DISTINCTION THE WHOLE FILE TURNS ON ============
 *
 * `AlreadyGraduated()` IS NOT AN ERROR. `ArcpadLocker.graduate` is
 * permissionless by design, so the keeper -- or another user, or a searcher --
 * winning the race is the mechanism WORKING. Rendering it in red would teach a
 * user that the fallback is broken at the exact moment it proved unnecessary.
 * `keeper/src/graduate/outcome.ts` makes the identical call for the identical
 * reason (`level: 'ok'`, `pageable: false`), and the two files should keep
 * agreeing.
 *
 * The mirror of that: `GraduationTargetUnset()` is not a fault either, it is
 * "not yet". It is the PRODUCTION FACTORY'S DELIBERATE STATE TODAY. The panel
 * never lets a user reach it -- it does not render a button when the target is
 * zero -- but the copy exists because a target can be un-set between the read
 * and the signature.
 */

export type GraduationCode =
  | 'already-graduated'
  | 'target-unset'
  | 'not-the-target'
  | 'not-complete'
  | 'not-canonical'
  | 'payout-rejected'
  | 'pool-step-failed'
  | 'rejected'
  | 'funds'
  | 'network'
  | 'unknown'

export type GraduationOutcome = {
  readonly code: GraduationCode
  /** The ABI name when there was one, else a synthetic label. */
  readonly name: string
  readonly tone: FailureTone
  readonly title: string
  readonly body: string
  /** ALWAYS non-empty. When there is nothing to do, it says so. */
  readonly remedy: string
  readonly retryable: boolean
  /** `unknown` only: the raw error is shown and can be copied. */
  readonly showRaw: boolean
  readonly raw: unknown
}

type Entry = Omit<GraduationOutcome, 'name' | 'showRaw' | 'raw'>

/**
 * EVERY NAME `GRADUATION_ERROR_ABI` CARRIES HAS A ROW. There is no `default`
 * branch inside the table: a name that falls off it reaches `unknownNamed`,
 * which says the site has no text for it rather than inventing one --
 * fail-closed, exactly as the keeper's classifier does.
 */
export const GRADUATION_COPY: Readonly<Record<string, Entry>> = {
  // ---- not faults ---------------------------------------------------------
  AlreadyGraduated: {
    code: 'already-graduated',
    // NEUTRAL. Nothing went wrong; somebody else got there first.
    tone: 'neutral',
    title: 'Already graduated.',
    body: 'Someone else sent this first — the keeper, or another holder. Graduation is open to anyone on purpose, so this is the design working rather than a failure. Your wallet spent nothing beyond gas, and the pool is open.',
    remedy: 'Reload the page to see the graduated state.',
    retryable: false,
  },
  GraduationTargetUnset: {
    code: 'target-unset',
    tone: 'warn',
    title: 'This launchpad has not armed graduation yet.',
    body: "The factory's graduation target is still the zero address, so the curve refuses to graduate to anyone. Nothing is lost while it waits: the sale proceeds and the pool's token supply stay in the curve until a target is set.",
    remedy: 'There is nothing to do from here. It will work once the target is set.',
    retryable: true,
  },

  // ---- the state moved under us ------------------------------------------
  NotComplete: {
    code: 'not-complete',
    tone: 'warn',
    title: 'This curve is still trading.',
    body: 'The curve reported that its sale supply is not sold out, so it cannot graduate yet. The page may have been read a moment before a sell reopened it.',
    remedy: 'Reload the page.',
    retryable: true,
  },
  NotGraduationTarget: {
    code: 'not-the-target',
    tone: 'error',
    title: 'The launchpad points somewhere else.',
    body: "The factory's graduation target is not the contract this page called. That normally means governance re-pointed it between the read and the signature.",
    remedy: 'Reload the page; it re-reads the target from the factory every time.',
    retryable: true,
  },
  CurveNotFromFactory: {
    code: 'not-canonical',
    tone: 'error',
    title: 'This curve does not belong to that launchpad.',
    body: 'The graduation target refused the call because the factory it is bound to does not know this token. The page and the target disagree about which deployment they are on.',
    remedy: 'Nothing you can change will help. Please report this.',
    retryable: false,
  },

  // ---- genuinely broken; retrying cannot fix it --------------------------
  GraduationPayoutFailed: {
    code: 'payout-rejected',
    tone: 'error',
    title: 'The curve could not pay the graduation target.',
    body: 'The native USDC leg from the curve to the target returned false. On Arc the cause of this is the node-level blocklist behind the 0x1800 precompile refusing the recipient. Retrying does not change it — the target has to stop being refused.',
    remedy: 'Nothing you can change will help. Please report this.',
    retryable: false,
  },
} as const

/**
 * THE POOL STEP. Seven names, ONE sentence, and that is a decision.
 *
 * Every one of these means the same thing to the person who pressed the
 * button -- the payout was taken and the pool could not be opened, and no
 * amount of retrying or reconfiguring on their side changes it. Writing seven
 * near-identical paragraphs would be seven places for the wording to drift
 * while saying nothing extra. The NAME is still shown, so the report a user
 * sends is exact.
 */
const POOL_STEP_NAMES = [
  'ZeroLiquidity',
  'SeedShortfall',
  'UnexpectedCredit',
  'PoolPriceMismatch',
  'PositionNotSeeded',
  'NotPoolManager',
  'ZeroBase',
  'BaseIsQuote',
  'ZeroReserves',
  'PriceOutOfRange',
  'AddressEmptyCode',
  'AddressInsufficientBalance',
  'FailedInnerCall',
  'SafeERC20FailedOperation',
] as const

function poolStep(name: string): Entry {
  return {
    code: 'pool-step-failed',
    tone: 'error',
    title: 'The pool could not be opened.',
    body: `Graduation is one transaction — take the payout, open the pool, seed it — and it reverted inside the pool step with ${name}(). Because it is atomic, nothing moved: the curve still holds the proceeds and is still ungraduated.`,
    remedy: 'Nothing you can change will help. Please report this, with the name above.',
    retryable: false,
  }
}

export function graduationCopyFor(name: string): Entry | undefined {
  const listed = GRADUATION_COPY[name]
  if (listed !== undefined) return listed
  return (POOL_STEP_NAMES as readonly string[]).includes(name) ? poolStep(name) : undefined
}

/** Every name this dictionary answers for. The completeness gate reads it. */
export function graduationCoveredNames(): readonly string[] {
  return [...Object.keys(GRADUATION_COPY), ...POOL_STEP_NAMES].sort()
}

/**
 * THE BRANCH ORDER IS THE SAME AS `decodeArcpadError`'S, and deliberately so:
 * a user must not get one vocabulary for a rejected trade and another for a
 * rejected graduation. What differs is only the dictionary in the middle.
 */
export function decodeGraduationError(error: unknown): GraduationOutcome {
  const base = (entry: Entry, name: string, showRaw = false): GraduationOutcome => ({
    ...entry,
    name,
    showRaw,
    raw: error,
  })

  // 1 -- the user said no. Not an error; a decision.
  if (isUserRejection(error)) {
    return base(
      {
        code: 'rejected',
        tone: 'neutral',
        title: 'Cancelled.',
        body: 'You rejected the request in your wallet. Nothing was sent and nothing was spent.',
        remedy: 'Press Graduate again when you are ready.',
        retryable: true,
      },
      'UserRejected',
    )
  }

  // 2 -- a named revert, from either contract in the call.
  const name = revertName(error)
  if (name !== undefined) {
    const entry = graduationCopyFor(name)
    if (entry !== undefined) return base(entry, name)
    return base(
      {
        code: 'unknown',
        tone: 'error',
        title: 'Graduation was refused for a reason this site has no text for.',
        body: `The call reverted with ${name}(), which is not on the graduation error surface. That is a gap in this interface, not something you did.`,
        remedy: 'Please report this, with the name above.',
        retryable: false,
      },
      name,
      true,
    )
  }

  // 3 -- not enough USDC. On Arc gas comes out of the asset itself, and this
  //      call sends no value, so it is purely a gas shortfall.
  if (findError(error, InsufficientFundsError) !== undefined) {
    return base(
      {
        code: 'funds',
        tone: 'warn',
        title: 'Not enough USDC for gas.',
        body: 'Graduation sends no value of its own, but on Arc gas is paid in USDC and your wallet cannot cover it.',
        remedy: 'Top up and try again — or simply wait: the keeper pays for this itself.',
        retryable: true,
      },
      'InsufficientFunds',
    )
  }

  // 4 -- transport.
  if (isTransportFailure(error)) {
    return base(
      {
        code: 'network',
        tone: 'warn',
        title: 'The network did not answer.',
        body: 'The request to the Arc RPC failed or timed out. The transaction may or may not have been sent.',
        remedy: 'Check the explorer before retrying.',
        retryable: true,
      },
      'NetworkError',
    )
  }

  // 5 -- unknown, and loud about it.
  return base(
    {
      code: 'unknown',
      tone: 'error',
      title: 'Something went wrong.',
      body: describe(error),
      remedy: 'Copy the details below and send them to us.',
      retryable: false,
    },
    'Unknown',
    true,
  )
}

/**
 * The error NAME, from viem's decoded form or from raw data.
 *
 * The raw branch matters more here than on the trade paths: the revert can come
 * from `BondingCurve` while the call was made against `ArcpadLocker`, so a
 * client that decodes with only the called contract's ABI hands back
 * undecodable data. `GRADUATION_ERROR_ABI` carries both halves.
 */
function revertName(error: unknown): string | undefined {
  const reverted = findError(error, ContractFunctionRevertedError)
  if (reverted?.data?.errorName !== undefined) return reverted.data.errorName
  if (error instanceof BaseError) {
    /* fall through to the raw scan below */
  }
  const raw = findRevertData(error)
  if (raw === undefined || raw === '0x' || raw.length < 10) return undefined
  try {
    return decodeErrorResult({ abi: GRADUATION_ERROR_ABI, data: raw as `0x${string}` }).errorName
  } catch {
    return undefined
  }
}
