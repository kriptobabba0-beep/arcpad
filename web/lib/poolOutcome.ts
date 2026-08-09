import { InsufficientFundsError } from 'viem'
import type { FailureTone } from '@/components/errors/failureCopy'
import { describe, findError, isTransportFailure, isUserRejection } from './decodeRevert'
import { POOL_SWAP_ERROR_ABI, poolRevertName } from './routerAbi'

/**
 * ============ WHAT A FAILED POOL SWAP MEANS TO A USER ============
 *
 * A THIRD DICTIONARY, NOT A SEVENTH `ArcpadAction`, for exactly the reason
 * `lib/graduationOutcome.ts` records for the second one: `FAILURE_TABLE` is
 * keyed on `ArcpadAction` and gated by `test/errors/reconcile.test.ts`, which
 * derives each action's error surface BY SCANNING THE SOLIDITY SOURCES and
 * requires every derived name to exist in `ARCPAD_ERROR_ABI`. A pool swap
 * crosses `ArcpadRouter`, `PoolManager`, `ArcpadHook` and two ERC-20s, and
 * none of the first three is in that barrel. So the six curve actions keep
 * their gate untouched and the pool gets its own surface with its own
 * completeness check (`test/pool/abi.test.ts`).
 *
 * ============ THE TWO DISTINCTIONS THE FILE TURNS ON ============
 *
 * 1. `PoolNotInitialized()` IS NOT A FAULT TODAY -- it is the state of every
 *    arcpad token on every chain. MEASURED 2026-08-09 by `eth_call` against the
 *    live router: both production tokens answer `0x486aa307`. Nothing has
 *    graduated; the production factory's `graduationTarget` is `0x0`
 *    deliberately. Painting that red would report a healthy system as broken,
 *    every day, exactly as `GraduationTargetUnset` would have.
 *
 * 2. AN ALLOWANCE SHORTFALL ARRIVES IN TWO DIFFERENT WIRE SHAPES, one per leg.
 *    MEASURED against the LIVE USDC at `0x3600…0000`: it is a Circle FiatToken
 *    and reverts `Error(string) "ERC20: transfer amount exceeds allowance"`.
 *    `LaunchToken` is an OpenZeppelin ERC-20 and reverts
 *    `ERC20InsufficientAllowance(address,uint256,uint256)`. Same cause, same
 *    remedy, two decoders -- and a surface that handled only the custom error
 *    would tell a buyer "the chain refused this transaction" with no mention of
 *    the Approve button they are two seconds away from pressing. That is this
 *    repository's recurring failure mode with a wire format standing in for an
 *    entrypoint.
 */

export type PoolFailureCode =
  | 'no-pool'
  | 'not-approved'
  | 'insufficient-balance'
  | 'slippage'
  | 'deadline'
  | 'dust'
  | 'partial-fill'
  | 'bad-token'
  | 'amount'
  | 'rejected'
  | 'funds'
  | 'network'
  | 'operator'
  | 'unknown'

export type PoolFailure = {
  readonly code: PoolFailureCode
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

type Entry = Omit<PoolFailure, 'name' | 'showRaw' | 'raw'>

const operator = (title: string, body: string): Entry => ({
  code: 'operator',
  tone: 'error',
  title,
  body,
  remedy: 'Nothing you can change will help. Please report this, with the name above.',
  retryable: false,
})

/**
 * EVERY NAME `POOL_SWAP_ERROR_ABI` CARRIES HAS A ROW. There is no `default`
 * inside the table: a name that falls off it reaches the `unknown` branch,
 * which says the site has no text for it rather than inventing one.
 */
export const POOL_SWAP_COPY: Readonly<Record<string, Entry>> = {
  // ---- not faults --------------------------------------------------------
  PoolNotInitialized: {
    code: 'no-pool',
    tone: 'warn',
    title: 'This token has no pool yet.',
    body:
      'The pool is opened by graduation, and this token has not graduated. Nothing is wrong and ' +
      'nothing is stuck: the sale proceeds and the pool’s token supply stay in the curve until ' +
      'someone sends the graduation transaction.',
    remedy: 'There is nothing to do from here. Trading opens when the pool does.',
    retryable: true,
  },
  QuoteResult: {
    // Reachable ONLY if a caller hands a successful quote to the failure
    // decoder. Naming it beats "no text for this", which would be a lie about
    // the most benign outcome the surface has.
    code: 'operator',
    tone: 'error',
    title: 'A quote was read as a failure.',
    body:
      'QuoteResult() is how the router RETURNS a quote — it reverts with the answer on purpose. ' +
      'Seeing it here means this page decoded a successful quote with the wrong decoder.',
    remedy: 'Nothing you can change will help. Please report this.',
    retryable: false,
  },

  // ---- the user's own position ------------------------------------------
  ERC20InsufficientAllowance: {
    code: 'not-approved',
    tone: 'warn',
    title: 'The router is not approved to move that much.',
    body:
      'A pool swap pulls your funds with transferFrom, so the router needs an ERC-20 allowance ' +
      'first. Yours is smaller than this trade needs — most often because the price moved and ' +
      'the trade now needs more than you approved.',
    remedy: 'Press Approve and then swap again.',
    retryable: true,
  },
  ERC20InsufficientBalance: {
    code: 'insufficient-balance',
    tone: 'warn',
    title: 'You do not hold that much.',
    body: 'The transfer was refused because the balance is smaller than the amount this swap needs.',
    remedy: 'Lower the amount and try again.',
    retryable: true,
  },
  ERC20InvalidReceiver: operator(
    'The swap named an invalid recipient.',
    'The token refused the transfer because the recipient address is not one it will accept.',
  ),
  ERC20InvalidSender: operator(
    'The swap named an invalid sender.',
    'The token refused the transfer because the sender address is not one it will accept.',
  ),

  // ---- the price moved ---------------------------------------------------
  TooLittleReceived: {
    code: 'slippage',
    tone: 'warn',
    title: 'The price moved past your limit.',
    body:
      'The swap would have delivered less than the minimum you set, so the router refused it and ' +
      'nothing moved. This is the slippage guard doing its job.',
    remedy: 'Try again, or raise your slippage tolerance.',
    retryable: true,
  },
  TooMuchRequested: {
    code: 'slippage',
    tone: 'warn',
    title: 'The price moved past your limit.',
    body:
      'The swap would have cost more than the maximum you set, so the router refused it and ' +
      'nothing moved. This is the slippage guard doing its job.',
    remedy: 'Try again, or raise your slippage tolerance.',
    retryable: true,
  },
  DeadlinePassed: {
    code: 'deadline',
    tone: 'warn',
    title: 'This trade expired before it was mined.',
    body:
      'Every pool swap carries a deadline so a transaction that sits unmined cannot execute later ' +
      'at a price you never saw. This one arrived after its deadline and nothing moved. If it ' +
      'happens instantly and repeatedly, your computer’s clock is ahead of the chain’s.',
    remedy: 'Try again.',
    retryable: true,
  },

  // ---- the trade itself is not representable -----------------------------
  LegSignsUnexpected: {
    code: 'dust',
    tone: 'warn',
    title: 'That amount is too small to trade here.',
    body:
      'The fee is rounded up on each of its two parts, so for a trade this small the fee can ' +
      'exceed the whole output — you would pay on both sides. The router refuses such a swap ' +
      'rather than settling it.',
    remedy: 'Raise the amount and try again.',
    retryable: true,
  },
  PartialFill: {
    code: 'partial-fill',
    tone: 'warn',
    title: 'The pool cannot fill an order this size.',
    body:
      'A v4 pool fills partially and silently once it reaches the price limit. The router refuses ' +
      'that instead: you get the amount you asked for, or nothing. Nothing moved.',
    remedy: 'Lower the amount and try again.',
    retryable: true,
  },
  SwapAmountCannotBeZero: {
    code: 'amount',
    tone: 'warn',
    title: 'Enter an amount above zero.',
    body: 'The pool refuses a swap with a zero amount.',
    remedy: 'Enter an amount and try again.',
    retryable: true,
  },
  AmountOutOfRange: {
    code: 'amount',
    tone: 'warn',
    title: 'That amount is out of range.',
    body:
      'The router bounds every amount to what the pool’s own accounting can hold. Anything ' +
      'larger cannot be represented, so it is refused rather than silently wrapped.',
    remedy: 'Enter a smaller amount.',
    retryable: true,
  },

  // ---- the token is not one this router can reach ------------------------
  BaseIsQuote: {
    code: 'bad-token',
    tone: 'error',
    title: 'That address is the quote asset, not a token.',
    body:
      'The pool key is derived from the token and USDC, so USDC itself cannot be the base. There ' +
      'is no such pool and the router made no call to that address.',
    remedy: 'Open a launch token’s page instead.',
    retryable: false,
  },
  ZeroBase: {
    code: 'bad-token',
    tone: 'error',
    title: 'That address is the zero address.',
    body: 'There is no pool for the zero address and the router made no call to it.',
    remedy: 'Open a launch token’s page instead.',
    retryable: false,
  },
  ZeroRecipient: operator(
    'The swap named the zero address as recipient.',
    'The router refuses to deliver a swap to the zero address. This page should never construct ' +
      'such a call.',
  ),

  // ---- deployment / wiring faults ---------------------------------------
  NotPoolManager: operator(
    'The router’s callback was entered by the wrong contract.',
    'unlockCallback accepts only the PoolManager the router was deployed against. Reaching it ' +
      'from anywhere else means this page is pointed at a router that is not wired to this pool.',
  ),
  ManagerLocked: operator(
    'The pool manager refused the swap.',
    'ManagerLocked() means the swap ran outside an unlock, which the router cannot do by ' +
      'construction. This points at a wiring fault, not at anything you did.',
  ),
  AlreadyUnlocked: operator(
    'The pool manager was already unlocked.',
    'The router opened an unlock inside one that was already open, which it cannot do by ' +
      'construction.',
  ),
  CurrencyNotSettled: operator(
    'The swap left an unsettled balance.',
    'The pool manager refuses to close an unlock with a non-zero delta. The router settles both ' +
      'legs in the same callback, so this points at a wiring fault.',
  ),
  QuoteDidNotRevert: operator(
    'The quoter returned instead of reverting.',
    'The quote path is meant to revert with its answer. A plain return means the router at this ' +
      'address is not the ArcpadRouter this page expects.',
  ),
  HookNotImplemented: operator(
    'The pool’s hook refused a callback it does not implement.',
    'The hook attached to this pool is not the arcpad hook this router derives its key from.',
  ),
  InvalidBps: operator(
    'This pool’s fee schedule is out of range.',
    'The hook read a fee rate outside the range it accepts, so no swap can settle.',
  ),
  QuoteLegMissing: operator(
    'The pool’s key does not carry the quote asset.',
    'The hook refuses a pool whose currencies do not include USDC. Such a pool cannot exist ' +
      'under arcpad’s graduation path.',
  ),
  ZeroCurrency: operator(
    'The pool’s key carries the zero address.',
    'The hook refuses a pool with a zero currency. Such a pool cannot exist under arcpad’s ' +
      'graduation path.',
  ),
  ZeroReserves: operator(
    'The pool reports no reserves.',
    'The hook could not price this pool because a reserve read as zero.',
  ),
  AddressEmptyCode: operator(
    'A contract the swap needs has no code.',
    'One of the addresses the router called is not a contract on this chain.',
  ),
  AddressInsufficientBalance: operator(
    'A transfer inside the swap ran short.',
    'A helper reported an insufficient balance while moving funds inside the swap.',
  ),
  FailedInnerCall: operator(
    'A call inside the swap failed without a reason.',
    'An inner call reverted with no data. On Arc this shape has been seen when USDC reached the ' +
      'native-asset precompile through a proxying RPC.',
  ),
  SafeERC20FailedOperation: operator(
    'A token operation inside the swap failed.',
    'One of the two ERC-20s refused an operation without a decodable reason.',
  ),
}

export function poolCopyFor(name: string): Entry | undefined {
  return POOL_SWAP_COPY[name]
}

/** Every name this dictionary answers for. The completeness gate reads it. */
export function poolCoveredNames(): readonly string[] {
  return Object.keys(POOL_SWAP_COPY).sort()
}

/**
 * The USDC leg's allowance shortfall, recognised BY STRING.
 *
 * Not a heuristic: the exact text was read off the live contract. The match is
 * deliberately loose on case and surrounding text because a proxy upgrade can
 * reword it, and the WRONG failure here (falling through to "the chain refused
 * this transaction") is strictly worse than a slightly wide match -- the user
 * is one button away from the fix and would not be told.
 */
export function isUsdcAllowanceString(text: string): boolean {
  return /exceeds allowance|insufficient allowance|transfer amount exceeds/i.test(text)
}

function stringReason(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 12 && current != null; depth += 1) {
    const reason = (current as { reason?: unknown }).reason
    if (typeof reason === 'string' && reason.length > 0) return reason
    const short = (current as { shortMessage?: unknown }).shortMessage
    if (typeof short === 'string' && /revert/i.test(short)) return short
    const message = (current as { message?: unknown }).message
    if (typeof message === 'string' && /execution reverted:\s*(.+)/.test(message)) {
      return (/execution reverted:\s*(.+)/.exec(message) as RegExpExecArray)[1]?.trim()
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * THE BRANCH ORDER IS THE SAME AS `decodeArcpadError`'S AND
 * `decodeGraduationError`'S, deliberately: a user must not learn one vocabulary
 * for a curve trade and another for a pool trade. Only the dictionary differs.
 */
export function decodePoolSwapError(error: unknown): PoolFailure {
  const base = (entry: Entry, name: string, showRaw = false): PoolFailure => ({
    ...entry,
    name,
    showRaw,
    raw: error,
  })

  // 1 -- the user said no. A decision, not an error.
  if (isUserRejection(error)) {
    return base(
      {
        code: 'rejected',
        tone: 'neutral',
        title: 'Cancelled.',
        body: 'You rejected the request in your wallet. Nothing was sent and nothing was spent.',
        remedy: 'Try again when you are ready.',
        retryable: true,
      },
      'UserRejected',
    )
  }

  // 2 -- a named revert, from any of the four contracts in the call.
  const name = poolRevertName(error)
  if (name !== undefined) {
    const entry = poolCopyFor(name)
    if (entry !== undefined) return base(entry, name)
    return base(
      {
        code: 'unknown',
        tone: 'error',
        title: 'This swap was refused for a reason this site has no text for.',
        body: `The call reverted with ${name}(), which is not on the pool error surface. That is a gap in this interface, not something you did.`,
        remedy: 'Please report this, with the name above.',
        retryable: false,
      },
      name,
      true,
    )
  }

  // 3 -- A STRING REVERT, WHICH IS HOW THE BUY LEG FAILS. Live USDC is a
  //      Circle FiatToken; its allowance refusal carries no selector at all.
  const reason = stringReason(error)
  if (reason !== undefined) {
    if (isUsdcAllowanceString(reason)) {
      return base(
        {
          ...(POOL_SWAP_COPY['ERC20InsufficientAllowance'] as Entry),
          body:
            'A pool buy pulls USDC with transferFrom, so the router needs an allowance first. ' +
            `USDC refused it: “${reason}”. On Arc USDC is a Circle FiatToken, so this arrives as ` +
            'plain text rather than a typed error — it is the same cause as an unapproved sell.',
        },
        'USDCAllowance',
      )
    }
    return base(
      {
        code: 'unknown',
        tone: 'error',
        title: 'The chain refused this swap.',
        body: reason,
        remedy: 'Please report this if it keeps happening.',
        retryable: false,
      },
      'Revert',
      true,
    )
  }

  // 4 -- not enough USDC. On Arc, gas comes out of the very asset being spent.
  if (findError(error, InsufficientFundsError) !== undefined) {
    return base(
      {
        code: 'funds',
        tone: 'warn',
        title: 'Not enough USDC.',
        body:
          'Your wallet cannot cover this transaction. On Arc gas is paid in USDC too, so a buy ' +
          'and its gas come out of the same balance and must both fit.',
        remedy: 'Lower the amount, or top up, leaving room for gas.',
        retryable: true,
      },
      'InsufficientFunds',
    )
  }

  // 5 -- transport.
  if (isTransportFailure(error)) {
    return base(
      {
        code: 'network',
        tone: 'warn',
        title: 'The network did not answer.',
        body: 'The request to the Arc RPC failed or timed out. The swap may or may not have been sent.',
        remedy: 'Check the explorer before retrying.',
        retryable: true,
      },
      'NetworkError',
    )
  }

  // 6 -- unknown, and LOUD about it.
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

/** Names on the ABI, for the completeness gate. */
export function poolErrorAbiNames(): readonly string[] {
  return POOL_SWAP_ERROR_ABI.map((entry) => entry.name).sort()
}
