/**
 * THE FAILURE DICTIONARY -- STRUCTURE.
 *
 * This task builds the SHAPE: the key format, the `UNREACHABLE_BY_CONSTRUCTION`
 * list with a one-line justification per member, and a provisional one-line
 * title for every reachable cell. Task 14 replaces the titles with the text
 * users actually read and adds `REACHABLE_BY_ACTION`; the completeness gate is
 * written here, the two-dimensional cell gate is written there.
 *
 * THE KEY IS `(action, errorName)`, NOT the error alone, and that is forced by
 * a measurement rather than a preference: a revert selector is four bytes of
 * `keccak(signature)` and carries NO layer. `CurveMath.ZeroAmount()` and
 * `FeeEscrow.ZeroAmount()` are the same `0x1f2a2005`. What separates them is
 * what the user was doing, which the caller knows and the wire does not.
 *
 * The other half of the same point: A PROPERTY COVERED ON ONE ENTRYPOINT IS
 * NOT COVERED ON THE OTHERS. `CurveComplete` means three different sentences
 * depending on whether the user was spending, buying an exact amount, or
 * selling, and the curve has three entrypoints.
 */

export type ArcpadAction =
  'launch' | 'approve' | 'buyExactQuoteIn' | 'buyExactTokensOut' | 'sellExactTokensIn' | 'claim'

export const ARCPAD_ACTIONS = [
  'launch',
  'approve',
  'buyExactQuoteIn',
  'buyExactTokensOut',
  'sellExactTokensIn',
  'claim',
] as const satisfies readonly ArcpadAction[]

/**
 * `contract` -- the contract said no for a reason about this trade.
 * `library`  -- `CurveMath` said no; the arithmetic itself refused.
 * `token`    -- the ERC-20 said no (allowance, balance).
 * `wallet`   -- the user's wallet said no, or the user did.
 * `network`  -- transport; nothing about the trade is known.
 * `operator` -- a configuration fault. The user cannot do anything about it,
 *               and pretending otherwise wastes their gas.
 * `unknown`  -- nothing matched. The raw error is kept and shown.
 */
export type ArcpadFailureKind =
  'contract' | 'library' | 'token' | 'wallet' | 'network' | 'operator' | 'unknown'

export type FailureEntry = {
  readonly kind: ArcpadFailureKind
  /** PROVISIONAL. Task 14 owns the wording. */
  readonly title: string
  readonly retryable: boolean
}

export type FailureKey = `${ArcpadAction}:${string}`

const contract = (title: string, retryable = false): FailureEntry => ({
  kind: 'contract',
  title,
  retryable,
})
const library = (title: string): FailureEntry => ({ kind: 'library', title, retryable: false })
const token = (title: string): FailureEntry => ({ kind: 'token', title, retryable: false })
const operator = (title: string): FailureEntry => ({ kind: 'operator', title, retryable: false })

/**
 * Every (action, errorName) cell the frontend can be handed.
 *
 * `kind: 'operator'` is not a nicety. Leaving a configuration fault in
 * `unknown` means the day a path we believed unreachable IS reached passes in
 * silence; naming it means somebody sees it.
 */
export const FAILURE_TABLE: Readonly<Record<FailureKey, FailureEntry>> = {
  // ---- launch -----------------------------------------------------------
  'launch:EmptyName': contract('A name is required'),
  'launch:EmptySymbol': contract('A symbol is required'),
  'launch:NameTooLong': contract('That name is longer than 32 bytes'),
  'launch:SymbolTooLong': contract('That symbol is longer than 13 bytes'),
  'launch:UriTooLong': contract('That metadata URI is longer than 200 bytes'),
  'launch:DegenerateProfile': operator(
    'This launchpad is misconfigured: the curve profile is degenerate',
  ),
  'launch:EscrowHasNoCode': operator('This launchpad is misconfigured: the fee escrow has no code'),
  'launch:EscrowIsNotAFeeEscrow': operator(
    'This launchpad is misconfigured: the escrow is not a FeeEscrow',
  ),
  'launch:GovernorIsTheEscrow': operator(
    'This launchpad is misconfigured: governor and escrow are the same address',
  ),
  'launch:TreasuryIsTheEscrow': operator(
    'This launchpad is misconfigured: treasury and escrow are the same address',
  ),
  'launch:ZeroEscrowAddress': operator(
    'This launchpad is misconfigured: the escrow address is zero',
  ),
  'launch:ZeroGovernorAddress': operator(
    'This launchpad is misconfigured: the governor address is zero',
  ),
  'launch:ZeroTreasuryAddress': operator(
    'This launchpad is misconfigured: the treasury address is zero',
  ),
  'launch:GraduationRaiseTooSmall': operator(
    'This launchpad is misconfigured: the graduation raise is below the floor',
  ),
  'launch:SaleAndSeedExceedSupply': operator(
    'This launchpad is misconfigured: sale plus seed exceeds the supply',
  ),
  'launch:SaleAndSeedStrandSupply': operator(
    'This launchpad is misconfigured: sale plus seed strands supply',
  ),
  'launch:ZeroEscrow': operator('This launch is misconfigured: the curve was given a zero escrow'),
  'launch:ZeroSaleSupply': operator('This launch is misconfigured: the sale supply is zero'),
  'launch:ZeroVirtualQuoteReserves': operator(
    'This launch is misconfigured: virtual quote reserves are zero',
  ),
  'launch:ZeroVirtualTokenReserves': operator(
    'This launch is misconfigured: virtual token reserves are zero',
  ),
  'launch:SaleSupplyNotBelowTokenReserves': operator(
    'This launch is misconfigured: sale supply is not below token reserves',
  ),
  'launch:NotFactory': operator(
    'This launch is misconfigured: the curve was bound by something other than the factory',
  ),
  'launch:AlreadyBound': operator(
    'This launch is misconfigured: the curve is already bound to a token',
  ),
  'launch:ZeroToken': operator(
    'This launch is misconfigured: the curve was bound to the zero address',
  ),
  'launch:TokenDoesNotPointBack': operator(
    'This launch is misconfigured: the token does not point back at its curve',
  ),
  'launch:TokenBalanceBelowSaleAndSeed': operator(
    'This launch is misconfigured: the curve holds less than sale plus seed',
  ),
  'launch:ZeroReserve': operator('This launchpad is misconfigured: a curve reserve is zero'),

  // ---- approve ----------------------------------------------------------
  'approve:ERC20InvalidApprover': token('That approval came from an invalid address'),
  'approve:ERC20InvalidSpender': token('That approval names an invalid spender'),

  // ---- buyExactQuoteIn --------------------------------------------------
  'buyExactQuoteIn:CurveComplete': contract('This curve has sold out; it no longer trades here'),
  'buyExactQuoteIn:ZeroQuoteIn': contract('Enter an amount to spend'),
  'buyExactQuoteIn:NetTooSmall': library('That amount is too small to buy anything'),
  'buyExactQuoteIn:SlippageExceeded': contract('The price moved past your limit', true),
  'buyExactQuoteIn:RefundFailed': contract('The change could not be returned to your wallet'),
  'buyExactQuoteIn:PayoutFailed': contract('A fee payment failed'),
  'buyExactQuoteIn:NotBound': operator('This launch is not finished; its curve has no token yet'),
  'buyExactQuoteIn:ZeroReserve': operator('This curve is misconfigured: a reserve is zero'),
  'buyExactQuoteIn:InvalidBps': operator('This curve is misconfigured: a fee rate is out of range'),
  'buyExactQuoteIn:ZeroAmount': operator('A zero fee deposit was attempted'),

  // ---- buyExactTokensOut ------------------------------------------------
  'buyExactTokensOut:CurveComplete': contract('This curve has sold out; it no longer trades here'),
  'buyExactTokensOut:ZeroTokensOut': contract('Enter a number of tokens to buy'),
  'buyExactTokensOut:NotEnoughTokensToBuy': contract('The curve does not hold that many tokens'),
  'buyExactTokensOut:SlippageExceeded': contract('The price moved past your limit', true),
  'buyExactTokensOut:RefundFailed': contract('The change could not be returned to your wallet'),
  'buyExactTokensOut:PayoutFailed': contract('A fee payment failed'),
  'buyExactTokensOut:NotBound': operator('This launch is not finished; its curve has no token yet'),
  'buyExactTokensOut:ZeroReserve': operator('This curve is misconfigured: a reserve is zero'),
  'buyExactTokensOut:InvalidBps': operator(
    'This curve is misconfigured: a fee rate is out of range',
  ),
  'buyExactTokensOut:ZeroAmount': operator('A zero fee deposit was attempted'),

  // ---- sellExactTokensIn ------------------------------------------------
  'sellExactTokensIn:CurveComplete': contract('This curve has sold out; it no longer trades here'),
  'sellExactTokensIn:ZeroTokensIn': contract('Enter a number of tokens to sell'),
  'sellExactTokensIn:ProceedsTooSmall': contract('That sale is too small to cover its own fees'),
  'sellExactTokensIn:SlippageExceeded': contract('The price moved past your limit', true),
  'sellExactTokensIn:PayoutFailed': contract('The payout to your wallet failed'),
  'sellExactTokensIn:ERC20InsufficientAllowance': token(
    'The curve is not approved to move that many tokens',
  ),
  'sellExactTokensIn:ERC20InsufficientBalance': token('You do not hold that many tokens'),
  'sellExactTokensIn:ERC20InvalidSender': token('That transfer came from an invalid address'),
  'sellExactTokensIn:ERC20InvalidReceiver': token('That transfer names an invalid recipient'),
  'sellExactTokensIn:NotBound': operator('This launch is not finished; its curve has no token yet'),
  'sellExactTokensIn:ZeroReserve': operator('This curve is misconfigured: a reserve is zero'),
  'sellExactTokensIn:InvalidBps': operator(
    'This curve is misconfigured: a fee rate is out of range',
  ),
  'sellExactTokensIn:ZeroAmount': operator('A zero fee deposit was attempted'),

  // ---- claim ------------------------------------------------------------
  'claim:NothingToClaim': contract('There is nothing to claim'),
  'claim:TransferFailed': contract('The claim payout failed'),
  'claim:ZeroRecipient': operator('The escrow was asked to pay the zero address'),
}

/**
 * Errors that EXIST in the ABI and cannot arrive here. A LIST, not a comment,
 * and every member carries its one-line reason -- because "we thought it was
 * unreachable" is exactly the belief that needs a place to be wrong out loud.
 */
export const UNREACHABLE_BY_CONSTRUCTION: readonly string[] = [
  // `LaunchToken` is OZ ERC-20: transfers REVERT on failure and never return
  // `false`, so the `if (!transfer(...))` branch cannot be taken.
  'TokenTransferFailed',
  // `launch` passes `msg.sender` as the creator; it cannot be the zero address.
  'ZeroCreator',
  // The three below are phase 2's fee-schedule guards, and every one of them
  // reverts inside `LaunchFactory`'s CONSTRUCTOR, not inside `launch`. A
  // deployed factory cannot return them: either the deploy succeeded, or there
  // is no factory to call. Measured the same way as the eleven constructor
  // guards already listed -- the `revert` sites sit between `constructor(` and
  // its closing brace.
  'ZeroFeeSchedule',
  'FeeScheduleHasNoCode',
  'ProfileNotSeedable',
  // The factory passes the curve it has just deployed.
  'ZeroCurve',
  // `tokensOut > realTokenReserves` returns `NotEnoughTokensToBuy()` first, so
  // `CurveMath` never sees `tokensOut >= tokenReserve`.
  'InsufficientTokenReserve',
  // The five below live in `graduate()`, which this frontend never calls --
  // the keeper does.
  'NotComplete',
  'AlreadyGraduated',
  'GraduationTargetUnset',
  'NotGraduationTarget',
  'GraduationPayoutFailed',
  // The five below live in the factory's governance entrypoints, which this
  // frontend never calls.
  'NotGovernor',
  'ZeroGraduationTarget',
  'NoPendingGraduationTarget',
  'GraduationTargetDelayNotElapsed',
  'GraduationTargetProposalExpired',
]

/** The error name half of a `(action, errorName)` key. */
export function errorNameOf(key: string): string {
  return key.slice(key.indexOf(':') + 1)
}

export function failureFor(action: ArcpadAction, errorName: string): FailureEntry | undefined {
  return FAILURE_TABLE[`${action}:${errorName}`]
}
