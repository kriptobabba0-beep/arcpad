import type { CreatorEarnings, PositionRow, TraderTradeRow } from '@arcpad/db'

/**
 * ================== THE THREE TOTALS ARE DELIBERATELY DIFFERENT ==============
 *
 * A fixture where `sum(byLaunch) === attributedWei === depositedTotalWei`
 * cannot tell a correct panel from one that sums the rows: every assertion
 * passes either way. So this fixture is built so the three numbers DIVERGE, and
 * the divergence is the real one measured on chain.
 *
 *   sum(byLaunch)      = 3.000000 + 2.000000 = 5.000000 USDC
 *   attributedWei      = the same 5.000000     (nothing is truncated)
 *   depositedTotalWei  = 5.000000 + 36 496 595 214 216 153 wei
 *
 * That last term is the SHARED ESCROW'S PREFIX, measured on Arc testnet
 * 2026-08-09: `FeeEscrow` is keyed by RECIPIENT and Phase 2 reused Phase 1's
 * escrow, so the ledger holds deposits from the superseded factory's curves,
 * which have no `launches` row and are therefore dropped by
 * `listCreatorEarningsByLaunch`'s two INNER joins.
 *
 * A panel that printed `sum(byLaunch)` as "earned" would show 5.000000 where
 * the escrow owes 5.036496 -- and every test that only checked "a number is
 * rendered" would stay green.
 */

export const PREFIX_DEPOSIT_WEI = 36_496_595_214_216_153n

const LAUNCH_A = '0x1bd93613a7bc470a739d9615cdc65e535d958fab'
const LAUNCH_B = '0x085c926e24ed64bb045e67d26d9e76e5730c21b3'

export const ATTRIBUTED_A_WEI = 3_000_000_000_000_000_000n
export const ATTRIBUTED_B_WEI = 2_000_000_000_000_000_000n
export const ATTRIBUTED_WEI = ATTRIBUTED_A_WEI + ATTRIBUTED_B_WEI
export const DEPOSITED_WEI = ATTRIBUTED_WEI + PREFIX_DEPOSIT_WEI
export const CLAIMED_WEI = 1_000_000_000_000_000_000n

export const CREATOR = '0xe92c64c4f36216ea773f2622f6d5f8530ae92fd2'

/** The shape `packages/db` returns. Typed, so a field rename breaks the build. */
export const EARNINGS: CreatorEarnings = {
  recipient: CREATOR,
  byLaunch: [
    { token: LAUNCH_A, symbol: 'SMOKE', earnedWei: ATTRIBUTED_A_WEI },
    { token: LAUNCH_B, symbol: 'E2E', earnedWei: ATTRIBUTED_B_WEI },
  ],
  byLaunchTruncated: false,
  attributedWei: ATTRIBUTED_WEI,
  unattributedWei: PREFIX_DEPOSIT_WEI,
  depositedTotalWei: DEPOSITED_WEI,
  claimedTotalWei: CLAIMED_WEI,
  claimableWei: DEPOSITED_WEI - CLAIMED_WEI,
  ledgerMissing: false,
}

/** An address the escrow has never paid: the state a fresh wallet is in. */
export const NO_EARNINGS: CreatorEarnings = {
  recipient: CREATOR,
  byLaunch: [],
  byLaunchTruncated: false,
  attributedWei: 0n,
  unattributedWei: 0n,
  depositedTotalWei: 0n,
  claimedTotalWei: 0n,
  claimableWei: 0n,
  ledgerMissing: true,
}

export const POSITIONS: readonly PositionRow[] = [
  {
    token: LAUNCH_A,
    symbol: 'SMOKE',
    name: 'Smoke',
    balanceTok: 600_000n * 10n ** 18n,
    priceWeiPerTok: 4_000_000_000n,
    // floor(600_000e18 * 4e9 / 1e18) = 2.4e15 wei
    valueWei: 2_400_000_000_000_000n,
    complete: true,
    graduated: false,
  },
  {
    token: LAUNCH_B,
    symbol: 'E2E',
    name: 'E2E fixture',
    balanceTok: 1_000n * 10n ** 18n,
    priceWeiPerTok: 4_000_000_000n,
    valueWei: 4_000_000_000_000n,
    complete: false,
    graduated: false,
  },
]

export const TRADES: readonly TraderTradeRow[] = [
  {
    eventSeq: 58_712_064n,
    txHash: `0x${'a1'.repeat(32)}`,
    blockTime: new Date('2026-08-09T10:00:00.000Z'),
    token: LAUNCH_B,
    symbol: 'E2E',
    isBuy: true,
    tokenAmountTok: 12_345n * 10n ** 18n,
    quoteAmountWei: 1_000_000_000_000_000n,
    protocolFeeWei: 9_500_000_000_000n,
    creatorFeeWei: 3_000_000_000_000n,
    source: 'curve',
  },
  {
    eventSeq: 58_712_000n,
    txHash: `0x${'b2'.repeat(32)}`,
    blockTime: new Date('2026-08-09T09:00:00.000Z'),
    token: LAUNCH_A,
    symbol: 'SMOKE',
    isBuy: false,
    tokenAmountTok: 400_000n * 10n ** 18n,
    quoteAmountWei: 11_000_000_000_000_000n,
    protocolFeeWei: 104_500_000_000_000n,
    creatorFeeWei: 33_000_000_000_000n,
    source: 'curve',
  },
]
