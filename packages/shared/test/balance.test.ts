import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  assertErc20Callable,
  assertNotUsdcNativeSwap,
  erc20Usdc,
  isNativeSentinel,
  isUsdcErc20,
  NATIVE_SENTINELS,
  nativeUsdc,
  readUsdcBalance,
  unifyUsdcViews,
  type UsdcBalanceSource,
  UsdcViewError,
} from '../src/balance'
import { USDC_ERC20_ADDRESS } from '../src/chain'
import { erc20ToNative } from '../src/usdc'

const ACCOUNT = '0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6' as Address

/** The FeeEscrow balance measured on Arc testnet: 0.152069146725900635 USDC. */
const ESCROW_WEI = 152069146725900635n
const ESCROW_UNITS = 152069n

function expectViewError(fn: () => unknown, kind: UsdcViewError['kind']): UsdcViewError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(UsdcViewError)
    expect((error as UsdcViewError).kind).toBe(kind)
    return error as UsdcViewError
  }
  throw new Error(`expected a UsdcViewError of kind "${kind}", but nothing was thrown`)
}

describe('the two views are ONE balance', () => {
  it('collapses agreeing views into a single balance', () => {
    const balance = unifyUsdcViews(nativeUsdc(ESCROW_WEI), erc20Usdc(ESCROW_UNITS))
    expect(balance).toEqual({ wei: ESCROW_WEI, units: ESCROW_UNITS })
  })

  it('collapses the round 100 USDC case measured on the deployer', () => {
    expect(unifyUsdcViews(nativeUsdc(100n * 10n ** 18n), erc20Usdc(100n * 10n ** 6n))).toEqual({
      wei: 100n * 10n ** 18n,
      units: 100n * 10n ** 6n,
    })
  })

  // THE RULE, AS A FAILING TEST RATHER THAN A COMMENT.
  //
  // A caller that adds the two views -- the exact mistake the rule exists to
  // prevent -- produces a native figure that is the true balance plus
  // 1e12 * units. Feeding that back in is refused, by name.
  it('REFUSES a native figure that is the sum of the two views', () => {
    const summed = ESCROW_WEI + erc20ToNative(ESCROW_UNITS)
    const error = expectViewError(
      () => unifyUsdcViews(nativeUsdc(summed), erc20Usdc(ESCROW_UNITS)),
      'views_disagree',
    )
    expect(error.message).toContain('two views of ONE fund')
  })

  it('REFUSES an ERC-20 figure that is the sum of the two views', () => {
    const summed = ESCROW_UNITS + ESCROW_WEI
    expectViewError(
      () => unifyUsdcViews(nativeUsdc(ESCROW_WEI), erc20Usdc(summed)),
      'views_disagree',
    )
  })

  // The single most likely scaling slip: treating the native figure as if it
  // were already in the ERC-20 view, or the reverse.
  it('REFUSES a 1e12 scaling slip in either direction', () => {
    expectViewError(
      () => unifyUsdcViews(nativeUsdc(ESCROW_WEI), erc20Usdc(ESCROW_WEI)),
      'views_disagree',
    )
    expectViewError(
      () => unifyUsdcViews(nativeUsdc(ESCROW_UNITS), erc20Usdc(ESCROW_UNITS)),
      'views_disagree',
    )
  })

  it('accepts sub-micro-USDC dust by truncating, not by rounding up', () => {
    // 1 wei of native dust is invisible to the ERC-20 view.
    expect(unifyUsdcViews(nativeUsdc(1n), erc20Usdc(0n))).toEqual({ wei: 1n, units: 0n })
    expectViewError(() => unifyUsdcViews(nativeUsdc(1n), erc20Usdc(1n)), 'views_disagree')
  })

  it('rejects a negative reading in either view', () => {
    expectViewError(() => nativeUsdc(-1n), 'negative')
    expectViewError(() => erc20Usdc(-1n), 'negative')
  })
})

describe('readUsdcBalance', () => {
  function fixedSource(wei: bigint, units: bigint): UsdcBalanceSource & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      async readNativeWei() {
        calls.push('native')
        return wei
      },
      async readErc20Units() {
        calls.push('erc20')
        return units
      },
    }
  }

  it('returns ONE balance from two agreeing reads', async () => {
    const source = fixedSource(ESCROW_WEI, ESCROW_UNITS)
    await expect(readUsdcBalance(source, ACCOUNT)).resolves.toEqual({
      wei: ESCROW_WEI,
      units: ESCROW_UNITS,
    })
    expect(source.calls).toEqual(['native', 'erc20'])
  })

  // Arc's block time is ~350ms, so two sequential reads are NOT one
  // observation. A disagreement is retried with the read order REVERSED --
  // a block boundary does not survive that, a scaling mistake does.
  it('retries in the reversed order when the first pair disagrees, and settles', async () => {
    const calls: string[] = []
    let nativeReads = 0
    const source: UsdcBalanceSource = {
      async readNativeWei() {
        calls.push('native')
        nativeReads += 1
        // First read straddles a block: the fund arrived between the calls.
        return nativeReads === 1 ? 0n : ESCROW_WEI
      },
      async readErc20Units() {
        calls.push('erc20')
        return ESCROW_UNITS
      },
    }
    await expect(readUsdcBalance(source, ACCOUNT)).resolves.toEqual({
      wei: ESCROW_WEI,
      units: ESCROW_UNITS,
    })
    expect(calls).toEqual(['native', 'erc20', 'erc20', 'native'])
  })

  it('still refuses when the disagreement survives the reversed read', async () => {
    const source = fixedSource(ESCROW_WEI, ESCROW_WEI)
    await expect(readUsdcBalance(source, ACCOUNT)).rejects.toThrow(/two views of ONE fund/)
  })

  // The failure mode this whole module exists for, expressed end to end: a
  // source that has already summed the views somewhere upstream.
  it('refuses a source that has already summed the two views', async () => {
    const source = fixedSource(ESCROW_WEI + erc20ToNative(ESCROW_UNITS), ESCROW_UNITS)
    await expect(readUsdcBalance(source, ACCOUNT)).rejects.toThrow(UsdcViewError)
  })
})

describe('native sentinels are not contracts', () => {
  it('recognises both sentinels, case-insensitively', () => {
    expect(isNativeSentinel('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe(true)
    expect(isNativeSentinel('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')).toBe(true)
    expect(isNativeSentinel('0x0000000000000000000000000000000000000000')).toBe(true)
    expect(isNativeSentinel(USDC_ERC20_ADDRESS)).toBe(false)
    expect(isNativeSentinel('not-an-address')).toBe(false)
  })

  it('refuses an ERC-20 metadata call against either sentinel', () => {
    for (const sentinel of NATIVE_SENTINELS) {
      const error = expectViewError(() => assertErc20Callable(sentinel), 'native_sentinel')
      expect(error.message).toContain('decimals()')
    }
  })

  it('lets a real ERC-20 through, checksummed', () => {
    expect(assertErc20Callable(USDC_ERC20_ADDRESS.toLowerCase())).toBe(
      '0x3600000000000000000000000000000000000000',
    )
  })

  it('recognises the USDC ERC-20 view by address', () => {
    expect(isUsdcErc20(USDC_ERC20_ADDRESS)).toBe(true)
    expect(isUsdcErc20('0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439')).toBe(false)
  })
})

describe('USDC <-> native is not a swap', () => {
  const OTHER = '0x1bd93613a7BC470a739D9615cdc65e535d958fab'

  it('refuses both directions between the native sentinel and the ERC-20 view', () => {
    for (const sentinel of NATIVE_SENTINELS) {
      expectViewError(
        () => assertNotUsdcNativeSwap(sentinel, USDC_ERC20_ADDRESS),
        'same_asset_swap',
      )
      expectViewError(
        () => assertNotUsdcNativeSwap(USDC_ERC20_ADDRESS, sentinel),
        'same_asset_swap',
      )
    }
  })

  it('refuses either side against itself', () => {
    expectViewError(
      () => assertNotUsdcNativeSwap(USDC_ERC20_ADDRESS, USDC_ERC20_ADDRESS),
      'same_asset_swap',
    )
    expectViewError(
      () => assertNotUsdcNativeSwap(NATIVE_SENTINELS[0], NATIVE_SENTINELS[1]),
      'same_asset_swap',
    )
  })

  it('lets a real pair through', () => {
    expect(() => assertNotUsdcNativeSwap(USDC_ERC20_ADDRESS, OTHER)).not.toThrow()
    expect(() => assertNotUsdcNativeSwap(NATIVE_SENTINELS[0], OTHER)).not.toThrow()
    expect(() => assertNotUsdcNativeSwap(OTHER, USDC_ERC20_ADDRESS)).not.toThrow()
  })
})
