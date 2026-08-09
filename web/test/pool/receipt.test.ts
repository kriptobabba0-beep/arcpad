import { encodeEventTopics, encodeAbiParameters, type TransactionReceipt } from 'viem'
import { describe, expect, it } from 'vitest'
import { realisedFromRouterReceipt } from '@/components/token/usePoolTrade'
import { quoteWeiFromUnits } from '@/lib/quoteUnits'
import { ARCPAD_ROUTER_ABI } from '@/lib/routerAbi'
import { TOKEN, TRADER } from '../trade/fixtures'

/**
 * ==========================================================================
 *  REALISED AMOUNTS COME FROM `RouterSwap`, AND ITS TWO LEGS SWAP MEANING.
 * ==========================================================================
 *
 * On a BUY, `amountIn` is USDC (6-decimal) and `amountOut` is tokens
 * (18-decimal). On a SELL they are the other way round. Reading the same leg on
 * both directions reports a token count as a price -- a 1e12-ish error with no
 * runtime signature at all, on the one screen that tells a user what they
 * actually got.
 *
 * `PoolTradeForm` receives `realised` as a PROP, so the panel's own tests
 * cannot see this function. That is the same hole `poolQuoteStateFrom` had, and
 * it is closed the same way.
 */

const ROUTER = '0x6d9f42706c7e7bf3d2ad3123ca7397da6f0bb7cd' as const

/**
 * A real `RouterSwap` log, encoded from the ABI rather than hand-written.
 *
 * `buy` is NOT indexed -- the same choice `BondingCurve.Trade` made for
 * `isBuy` -- so it lives in `data` with the two amounts, and a filter written
 * against it through topics returns silently empty.
 */
type MinedLog = TransactionReceipt['logs'][number]

function routerSwapLog(input: {
  buy: boolean
  amountIn: bigint
  amountOut: bigint
  address?: string
}): MinedLog {
  const topics = encodeEventTopics({
    abi: ARCPAD_ROUTER_ABI,
    eventName: 'RouterSwap',
    args: { token: TOKEN, payer: TRADER, recipient: TRADER },
  })
  return {
    address: (input.address ?? ROUTER) as `0x${string}`,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    data: encodeAbiParameters(
      [{ type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [input.buy, input.amountIn, input.amountOut],
    ),
    blockNumber: 61n,
    blockHash: `0x${'11'.repeat(32)}`,
    logIndex: 0,
    transactionHash: `0x${'cd'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as MinedLog
}

const RECEIPT = (logs: MinedLog[]) => ({ logs, transactionHash: `0x${'cd'.repeat(32)}` as const })

describe('the two legs swap meaning with the direction', () => {
  it('a BUY: amountIn is USDC units, amountOut is token wei', () => {
    const realised = realisedFromRouterReceipt(
      RECEIPT([routerSwapLog({ buy: true, amountIn: 1_000_000n, amountOut: 17n * 10n ** 18n })]),
      ROUTER,
    )
    expect(realised).not.toBeNull()
    expect(realised?.buy).toBe(true)
    expect(realised?.tokensTok).toBe(17n * 10n ** 18n)
    // Raised into the 18-decimal view every `<Money native>` on this site draws.
    expect(realised?.quoteWei).toBe(quoteWeiFromUnits(1_000_000n))
    expect(realised?.quoteWei).toBe(1_000_000_000_000_000_000n)
  })

  it('a SELL: amountIn is token wei, amountOut is USDC units', () => {
    const realised = realisedFromRouterReceipt(
      RECEIPT([routerSwapLog({ buy: false, amountIn: 500n * 10n ** 18n, amountOut: 987_654n })]),
      ROUTER,
    )
    expect(realised?.buy).toBe(false)
    expect(realised?.tokensTok).toBe(500n * 10n ** 18n)
    expect(realised?.quoteWei).toBe(987_654_000_000_000_000n)
  })

  /**
   * THE MUTANT THIS KILLS: reading `amountIn` as the quote on both directions.
   * On a sell that reports 500 tokens as 500e18 USDC -- a receipt that says the
   * user received five hundred million USDC.
   */
  it('a sell does NOT report its token leg as the USDC leg', () => {
    const sell = realisedFromRouterReceipt(
      RECEIPT([routerSwapLog({ buy: false, amountIn: 500n * 10n ** 18n, amountOut: 987_654n })]),
      ROUTER,
    )
    expect(sell?.quoteWei).not.toBe(quoteWeiFromUnits(500n * 10n ** 18n))
    expect(sell?.quoteWei).toBeLessThan(10n ** 18n)
  })
})

describe('the log has to be OURS', () => {
  it('a RouterSwap from a different router is ignored', () => {
    // A receipt can carry logs from any contract. Reading someone else's router
    // would show a stranger's amounts as the user's own.
    const realised = realisedFromRouterReceipt(
      RECEIPT([
        routerSwapLog({
          buy: true,
          amountIn: 1n,
          amountOut: 1n,
          address: '0x00000000000000000000000000000000000000ff',
        }),
      ]),
      ROUTER,
    )
    expect(realised).toBeNull()
  })

  it('a receipt with no RouterSwap at all is null, not a zero trade', () => {
    // `null` draws no receipt; a zero trade would tell the user they got
    // nothing for their money.
    expect(realisedFromRouterReceipt(RECEIPT([]), ROUTER)).toBeNull()
  })

  it('the address match is case-insensitive, because checksums differ on the wire', () => {
    const realised = realisedFromRouterReceipt(
      RECEIPT([
        routerSwapLog({
          buy: true,
          amountIn: 1_000_000n,
          amountOut: 1n,
          address: '0x6D9f42706C7E7bF3D2Ad3123ca7397DA6F0bB7cd',
        }),
      ]),
      ROUTER,
    )
    expect(realised).not.toBeNull()
  })
})
