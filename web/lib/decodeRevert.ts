import { ARCPAD_ERROR_ABI } from '@arcpad/shared/browser'
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
} from 'viem'
import {
  type ArcpadAction,
  type ArcpadFailureKind,
  failureFor,
  REACHABLE_THROUGH_GRADUATION,
  UNREACHABLE_BY_CONSTRUCTION,
} from './failureTable'

export type { ArcpadAction, ArcpadFailureKind } from './failureTable'

export type ArcpadFailure = {
  kind: ArcpadFailureKind
  action: ArcpadAction
  /** 'CurveComplete', 'NetTooSmall', 'UserRejected', ... */
  name: string
  /** Decoded custom-error arguments, e.g. `ERC20InsufficientAllowance`'s three. */
  args?: readonly unknown[]
  /** One line the user sees. */
  title: string
  /** What happened. */
  detail: string
  /** What they can do, when there is something. */
  remedy?: string
  retryable: boolean
  /** NEVER lost. The copy button shows this. */
  raw: unknown
}

/**
 * THE ORDER OF THE BRANCHES IS THE DESIGN, and every step has a reason.
 *
 * 1. WALLET REJECTION FIRST. It is not an error, it is a decision. A red box
 *    tells a user that the thing they deliberately did was wrong.
 * 2. Custom error data -- the `ContractFunctionRevertedError` path.
 * 3. STRING revert. Arc rejects at the client level with plain strings like
 *    "Zero address not allowed", not with a selector, and so does the runtime
 *    blocklist. Without this branch both Arc-specific refusals read as
 *    "unknown error".
 * 4. EMPTY revert data. Sending value to non-payable `launch`, a CREATE2
 *    collision, and out-of-gas all land here indistinguishably. The message
 *    does NOT guess: it says the chain refused without giving a reason.
 * 5. Insufficient funds. On Arc gas is paid in the very asset being spent, so
 *    the message names the two line items separately.
 * 6. Transport. `retryable: true`.
 * 7. Unknown -- and this branch is never silent. Swallowing an unrecognised
 *    selector is the same thing as never having seen it.
 */
export function decodeArcpadError(error: unknown, ctx: { action: ArcpadAction }): ArcpadFailure {
  const { action } = ctx
  const base = (
    fields: Partial<ArcpadFailure> & Pick<ArcpadFailure, 'kind' | 'name' | 'title' | 'detail'>,
  ): ArcpadFailure => ({
    action,
    retryable: false,
    raw: error,
    ...fields,
  })

  // 1 -- the user said no.
  if (isUserRejection(error)) {
    return base({
      kind: 'wallet',
      name: 'UserRejected',
      title: 'Transaction cancelled',
      detail: 'You rejected the request in your wallet. Nothing was sent and nothing was spent.',
      remedy: 'Try again when you are ready.',
    })
  }

  // 2 -- a custom error with data.
  const reverted = findError(error, ContractFunctionRevertedError)
  const data = reverted?.data ?? decodeRawRevertData(error)
  if (data?.errorName) {
    return fromErrorName(action, data.errorName, data.args, error)
  }

  // 3 -- a string revert. `require(..., "reason")` and Arc's client-level
  //      refusals both arrive this way.
  const reason = stringRevertReason(error)
  if (reason !== undefined) {
    return base({
      kind: 'contract',
      name: 'Revert',
      title: 'The chain refused this transaction',
      detail: reason,
    })
  }

  // 4 -- reverted with NO data at all.
  if (isEmptyRevert(error)) {
    return base({
      kind: 'contract',
      name: 'EmptyRevert',
      title: 'The chain refused this transaction and gave no reason',
      detail:
        'The call reverted without returning any data. Sending value to a non-payable function, ' +
        'a CREATE2 address collision and running out of gas all look exactly like this from ' +
        'outside, so this message does not guess which one it was.',
      remedy: 'Open the transaction in the explorer for the trace.',
    })
  }

  // 5 -- not enough funds. On Arc the gas asset IS the asset being spent.
  if (findError(error, InsufficientFundsError) !== undefined) {
    return base({
      kind: 'wallet',
      name: 'InsufficientFunds',
      title: 'Not enough USDC',
      detail:
        'Your wallet cannot cover this transaction. On Arc, gas is paid in USDC too, so the ' +
        'trade amount and the gas come out of the same balance and must both fit.',
      remedy: 'Lower the amount, or top up, leaving room for gas.',
    })
  }

  // 6 -- transport.
  if (isTransportFailure(error)) {
    return base({
      kind: 'network',
      name: 'NetworkError',
      title: 'The network did not answer',
      detail:
        'The request to the Arc RPC failed or timed out. The transaction may or may not have been sent.',
      remedy: 'Check the explorer before retrying, then try again.',
      retryable: true,
    })
  }

  // 7 -- unknown, and LOUD about it.
  return base({
    kind: 'unknown',
    name: 'Unknown',
    title: 'Something went wrong',
    detail: describe(error),
    remedy: 'Copy the details below and send them to us.',
  })
}

/**
 * The `(action, errorName)` lookup. An error that is in the ABI but not in the
 * table is reported as `operator` with its name intact rather than as
 * `unknown` -- if a path we listed as unreachable is actually reached, that day
 * must not pass in silence.
 */
function fromErrorName(
  action: ArcpadAction,
  errorName: string,
  args: readonly unknown[] | undefined,
  raw: unknown,
): ArcpadFailure {
  const entry = failureFor(action, errorName)
  if (entry) {
    return {
      kind: entry.kind,
      action,
      name: errorName,
      ...(args && args.length > 0 ? { args } : {}),
      title: entry.title,
      detail: `The contract refused this ${action} with ${errorName}().`,
      retryable: entry.retryable,
      raw,
    }
  }

  /*
   * THE GRADUATION GROUP IS CHECKED FIRST, AND IT IS NOT A NICETY.
   *
   * These five are on `UNREACHABLE_BY_CONSTRUCTION` because none of the six
   * ACTIONS can produce them -- but the frontend does now call `graduate()`
   * through a different surface. Without this branch, `AlreadyGraduated()`
   * arriving here would read "a path that was believed impossible", and
   * `AlreadyGraduated` is the BENIGN case: the keeper (or anyone) won a race
   * that is permissionless on purpose. Saying "impossible" about the mechanism
   * working is how a healthy system gets reported as broken.
   *
   * Reaching this branch still means something is wrong -- a graduation error
   * surfaced on a trade -- so it stays `operator`. It just names the right
   * cause, and points at the surface that owns the copy.
   */
  if (REACHABLE_THROUGH_GRADUATION.includes(errorName)) {
    return {
      kind: 'operator',
      action,
      name: errorName,
      ...(args && args.length > 0 ? { args } : {}),
      title: 'This is a graduation error, and this was not a graduation',
      detail:
        `${errorName}() belongs to graduate(), which has its own surface ` +
        `(lib/graduationOutcome.ts). Receiving it from a ${action} means this page sent the ` +
        'wrong call, not that anything on chain is broken.',
      remedy: 'Nothing you can change will help. Please report this.',
      retryable: false,
      raw,
    }
  }

  const listedUnreachable = UNREACHABLE_BY_CONSTRUCTION.includes(errorName)
  return {
    kind: 'operator',
    action,
    name: errorName,
    ...(args && args.length > 0 ? { args } : {}),
    title: listedUnreachable
      ? 'This transaction hit a path that was believed impossible'
      : 'This transaction was refused for a reason the site does not have text for',
    detail: listedUnreachable
      ? `${errorName}() is listed as unreachable by construction and was reached anyway during ${action}. ` +
        'That is a fault in the deployment, not in what you did.'
      : `The contract refused this ${action} with ${errorName}(), which has no entry for this action.`,
    remedy: 'Nothing you can change will help. Please report this.',
    retryable: false,
    raw,
  }
}

// --------------------------------------------------------------------------
// Shape probing. viem wraps errors in layers; every helper walks the chain.
//
// EXPORTED, AND FOR ONE REASON: `lib/graduationOutcome.ts` decodes a SECOND
// error surface (`ArcpadLocker.graduate`, whose errors are not in
// `ARCPAD_ERROR_ABI` -- see `lib/graduationAbi.ts`). It needs the same layer
// walking and must not grow a second copy of it: two implementations of "find
// the revert data inside viem's wrappers" would drift, and the one that drifts
// is the one nobody is looking at. The classification stays separate; the
// probing is shared.
// --------------------------------------------------------------------------

type ErrorCtor<T> = new (...args: never[]) => T

/** Walks `cause` and viem's `walk()` looking for a specific error class. */
export function findError<T>(error: unknown, ctor: ErrorCtor<T>): T | undefined {
  if (error instanceof BaseError) {
    const found = error.walk((e) => e instanceof ctor)
    if (found instanceof ctor) return found
  }
  let current: unknown = error
  for (let depth = 0; depth < 10 && current != null; depth += 1) {
    if (current instanceof ctor) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** EIP-1193 code 4001 is a rejection even when it is not a viem error class. */
export function isUserRejection(error: unknown): boolean {
  if (findError(error, UserRejectedRequestError) !== undefined) return true
  let current: unknown = error
  for (let depth = 0; depth < 10 && current != null; depth += 1) {
    if ((current as { code?: unknown }).code === 4001) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Some paths hand back raw revert data rather than a decoded
 * `ContractFunctionRevertedError` (an `eth_call` through a bare transport, for
 * one). Decoding it here means those paths are not silently 'unknown'.
 */
function decodeRawRevertData(
  error: unknown,
): { errorName: string; args?: readonly unknown[] } | undefined {
  const raw = findRevertData(error)
  if (raw === undefined || raw === '0x' || raw.length < 10) return undefined
  try {
    const decoded = decodeErrorResult({ abi: ARCPAD_ERROR_ABI, data: raw as `0x${string}` })
    return { errorName: decoded.errorName, ...(decoded.args ? { args: decoded.args } : {}) }
  } catch {
    return undefined
  }
}

export function findRevertData(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 10 && current != null; depth += 1) {
    const candidate = current as { data?: unknown }
    if (typeof candidate.data === 'string' && candidate.data.startsWith('0x')) return candidate.data
    if (
      candidate.data !== null &&
      typeof candidate.data === 'object' &&
      typeof (candidate.data as { data?: unknown }).data === 'string'
    ) {
      return (candidate.data as { data: string }).data
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

function stringRevertReason(error: unknown): string | undefined {
  const reverted = findError(error, ContractFunctionRevertedError)
  if (typeof reverted?.reason === 'string' && reverted.reason.length > 0) return reverted.reason
  let current: unknown = error
  for (let depth = 0; depth < 10 && current != null; depth += 1) {
    const reason = (current as { reason?: unknown }).reason
    if (typeof reason === 'string' && reason.length > 0) return reason
    // Arc's client-level refusals arrive as a message with no selector.
    const message = (current as { message?: unknown }).message
    if (typeof message === 'string' && /execution reverted:\s*(.+)/.test(message)) {
      return (/execution reverted:\s*(.+)/.exec(message) as RegExpExecArray)[1]?.trim()
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

export function isEmptyRevert(error: unknown): boolean {
  const reverted = findError(error, ContractFunctionRevertedError)
  if (reverted !== undefined && reverted.data === undefined && reverted.reason === undefined)
    return true
  return findRevertData(error) === '0x'
}

export function isTransportFailure(error: unknown): boolean {
  if (findError(error, HttpRequestError) !== undefined) return true
  if (findError(error, TimeoutError) !== undefined) return true
  let current: unknown = error
  for (let depth = 0; depth < 10 && current != null; depth += 1) {
    const status = (current as { status?: unknown }).status
    if (status === 429 || status === 503) return true
    const message = (current as { message?: unknown }).message
    if (
      typeof message === 'string' &&
      /rate limit|too many requests|fetch failed|ECONNRESET/i.test(message)
    ) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
