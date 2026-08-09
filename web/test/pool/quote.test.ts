import { encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'
import { poolQuoteStateFrom } from '@/components/token/usePoolQuote'
import { MEASURED_ROUTER_SELECTORS, ROUTER_ERROR_ABI } from '@/lib/routerAbi'

/**
 * ==========================================================================
 *  THE INVERSION: A SUCCESSFUL QUOTE ARRIVES AS AN ERROR.
 * ==========================================================================
 *
 * `ArcpadRouter.quote*` runs the REAL swap through the REAL hook inside
 * `unlock` and reverts with `QuoteResult(amountIn, amountOut)` before settling.
 * So for this one call:
 *
 *   `data`  is ALWAYS undefined -- a hook reading it shows nothing, forever,
 *           and looks like a loading state.
 *   `error` is USUALLY NOT a failure -- reporting it paints every working
 *           quote red.
 *
 * `poolQuoteStateFrom` is the only place that inversion happens, and it went
 * UNTESTED in the first draft of this suite: a mutation that deleted the
 * `decodeQuoteResult` call -- turning every successful quote into a failure --
 * SURVIVED the whole pool suite. The panel test could not see it because the
 * panel is handed a `PoolQuoteState` as a prop. This file is that hole closed.
 */

const quoteRevert = (amountIn: bigint, amountOut: bigint) =>
  encodeErrorResult({
    abi: ROUTER_ERROR_ABI,
    errorName: 'QuoteResult',
    args: [amountIn, amountOut],
  } as Parameters<typeof encodeErrorResult>[0])

describe('a QuoteResult revert is the SUCCESS path', () => {
  it('raw revert bytes become an `ok` state carrying both legs', () => {
    const state = poolQuoteStateFrom({
      enabled: true,
      isPending: false,
      error: { cause: { data: quoteRevert(1_000_000n, 17_000_000_000_000_000_000n) } },
    })
    expect(state.kind).toBe('ok')
    if (state.kind !== 'ok') return
    expect(state.amountIn).toBe(1_000_000n)
    expect(state.amountOut).toBe(17_000_000_000_000_000_000n)
  })

  it('a viem-decoded revert becomes the same `ok` state', () => {
    const state = poolQuoteStateFrom({
      enabled: true,
      isPending: false,
      error: { cause: { data: { errorName: 'QuoteResult', args: [1n, 2n] } } },
    })
    expect(state).toEqual({ kind: 'ok', amountIn: 1n, amountOut: 2n })
  })

  it('IT IS NEVER REPORTED AS A FAILURE, even though it is on the error ABI', () => {
    // `QuoteResult` IS an entry on the router's error surface, so a decoder
    // that ran `decodePoolSwapError` first would name it and the panel would
    // draw a working quote as a fault. Order matters, and this is the assertion
    // that pins it.
    const state = poolQuoteStateFrom({
      enabled: true,
      isPending: false,
      error: { cause: { data: quoteRevert(5n, 6n) } },
    })
    expect(state.kind).not.toBe('failed')
  })
})

describe('a real revert is a real failure', () => {
  it('PoolNotInitialized -- the state of every token today -- is `failed`, code no-pool', () => {
    const state = poolQuoteStateFrom({
      enabled: true,
      isPending: false,
      error: { cause: { data: MEASURED_ROUTER_SELECTORS.PoolNotInitialized } },
    })
    expect(state.kind).toBe('failed')
    if (state.kind !== 'failed') return
    expect(state.failure.code).toBe('no-pool')
    expect(state.failure.tone).not.toBe('error')
  })

  it('BaseIsQuote -- USDC handed in as the base -- is `failed` and IS an error', () => {
    const state = poolQuoteStateFrom({
      enabled: true,
      isPending: false,
      error: { cause: { data: MEASURED_ROUTER_SELECTORS.BaseIsQuote } },
    })
    expect(state.kind).toBe('failed')
    if (state.kind !== 'failed') return
    expect(state.failure.code).toBe('bad-token')
  })

  /**
   * A 68-BYTE REVERT THAT IS NOT A QUOTE.
   *
   * `LegSignsUnexpected(int256,int256)` is the only other 68-byte revert on this
   * surface -- the same shape the contract's own mutation campaign found to be
   * the single thing separating `_decodeQuote`'s selector check from dead
   * weight. A decoder matching on LENGTH would report a refused dust sell as
   * "you receive -1".
   */
  it('LegSignsUnexpected is a failure, not a quote of the same byte length', () => {
    const legs = encodeErrorResult({
      abi: ROUTER_ERROR_ABI,
      errorName: 'LegSignsUnexpected',
      args: [56n, -1_000_000_000_000_000_000_000n],
    } as Parameters<typeof encodeErrorResult>[0])
    expect(legs.length).toBe(quoteRevert(1n, 2n).length)
    const state = poolQuoteStateFrom({
      enabled: true,
      isPending: false,
      error: { cause: { data: legs } },
    })
    expect(state.kind).toBe('failed')
    if (state.kind !== 'failed') return
    expect(state.failure.code).toBe('dust')
  })
})

describe('the states with no error at all', () => {
  it('disabled is `idle` -- an empty field is not a loading spinner', () => {
    expect(poolQuoteStateFrom({ enabled: false, isPending: true, error: null })).toEqual({
      kind: 'idle',
    })
  })

  it('in flight is `loading`', () => {
    expect(poolQuoteStateFrom({ enabled: true, isPending: true, error: null })).toEqual({
      kind: 'loading',
    })
  })

  /**
   * NO ERROR AND NOT PENDING MEANS THE CALL RETURNED -- WHICH THIS ENTRYPOINT
   * CANNOT DO.
   *
   * The router raises `QuoteDidNotRevert()` if its own `unlock` ever returns, so
   * a plain success can only mean the configured address is not an
   * `ArcpadRouter`. Falling back to `loading` would spin forever and read as a
   * slow RPC.
   */
  it('a plain success is a CONFIGURATION FAULT, not an eternal loading state', () => {
    const state = poolQuoteStateFrom({ enabled: true, isPending: false, error: null })
    expect(state.kind).toBe('failed')
    if (state.kind !== 'failed') return
    expect(`${state.failure.title} ${state.failure.body}`).toMatch(/returned instead of reverting/i)
  })
})
