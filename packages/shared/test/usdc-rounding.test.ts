import { describe, expect, it } from 'vitest'
import { formatUsdc, formatUsdcAmount, nativeToErc20 } from '../src/usdc'

/**
 * THE MEASURED DIVERGENCE THAT JUSTIFIES A SECOND FORMATTER.
 *
 * `formatUsdc` goes through `Intl.NumberFormat`, which rounds HALF UP. For a
 * balance that is the wrong direction: it shows money that the ERC-20 view of
 * the same fund says is not there. This file is the record that the two
 * formatters disagree, and on which side each one sits.
 *
 * Every literal below was derived by hand (divide by 1e12, keep or bump the
 * last digit) and NOT by calling the function under test.
 */
describe('Intl rounds half up; a balance must not', () => {
  it('formatUsdc rounds a balance up, formatUsdcAmount does not', () => {
    // 5e11 wei is exactly half a micro-USDC. The ERC-20 view of that same fund
    // reads ZERO.
    expect(nativeToErc20(500_000_000_000n)).toBe(0n)
    expect(formatUsdc(500_000_000_000n, { maxFractionDigits: 6 })).toBe('0.000001') // old path
    expect(formatUsdcAmount(500_000_000_000n, { rounding: 'down' })).toBe('0.000000') // new path
    expect(formatUsdcAmount(500_000_000_000n, { rounding: 'up' })).toBe('0.000001') // cost direction
  })

  /**
   * K1, IN ONE LINE THAT RUNS: what the screen says and what the ERC-20 view
   * says are the same number. If they ever stop agreeing, the site is showing
   * a balance that the wallet, the explorer and the token contract all deny.
   */
  it("the 'down' direction always shows exactly nativeToErc20", () => {
    for (const v of [0n, 1n, 999_999_999_999n, 1_000_000_000_000n, 12_161_433_369_060_378_706n]) {
      const shown = formatUsdcAmount(v, { rounding: 'down' }).replace(/[,.]/g, '')
      expect(BigInt(shown)).toBe(nativeToErc20(v))
    }
  })

  /**
   * The pinned table. First column is a real number from this deployment, not
   * a round figure: these are the amounts the UI will actually print.
   */
  it.each([
    // native wei                      down            up              what it is
    [12_161_433_369_060_378_706n, '12.161433', '12.161434'], // testnet graduation raise R
    [12_313_451_286_173_633_442n, '12.313451', '12.313452'], // R + fees: the full curve
    [975_308_641_975_308_639n, '0.975308', '0.975309'], // net after a 1 USDC round trip
    [9_382_716_049_382_717n, '0.009382', '0.009383'], // protocol share of a 1 USDC buy
    [2_962_962_962_962_963n, '0.002962', '0.002963'], // creator share of the same buy
  ])('%s formats down as %s and up as %s', (native, down, up) => {
    expect(formatUsdcAmount(native, { rounding: 'down' })).toBe(down)
    expect(formatUsdcAmount(native, { rounding: 'up' })).toBe(up)
  })

  it('an exact multiple of the quantum does not get bumped by the up direction', () => {
    // The `up` rule is ceil, not floor+1. Without the remainder check every
    // exact amount would be overstated by one micro-USDC forever.
    expect(formatUsdcAmount(1_000_000_000_000n, { rounding: 'up' })).toBe('0.000001')
    expect(formatUsdcAmount(1_000_000_000_000_000_000n, { rounding: 'up' })).toBe('1.000000')
  })

  it('rounds in the requested direction at coarser precision too', () => {
    // 1.9999995 USDC. A balance must never read 2.
    expect(
      formatUsdcAmount(1_999_999_500_000_000_000n, { rounding: 'down', maxFractionDigits: 2 }),
    ).toBe('1.99')
    expect(
      formatUsdcAmount(1_999_999_500_000_000_000n, { rounding: 'up', maxFractionDigits: 2 }),
    ).toBe('2.00')
    expect(
      formatUsdcAmount(1_999_999_500_000_000_000n, { rounding: 'down', maxFractionDigits: 0 }),
    ).toBe('1')
    expect(
      formatUsdcAmount(1_999_999_500_000_000_000n, { rounding: 'up', maxFractionDigits: 0 }),
    ).toBe('2')
  })

  it('refuses to print a seventh decimal', () => {
    // The seventh decimal exists in the native view and in no other view of
    // the same fund. Printing it is printing a figure every other reader of
    // that balance disagrees with.
    expect(() => formatUsdcAmount(1n, { rounding: 'down', maxFractionDigits: 7 })).toThrow(
      RangeError,
    )
  })

  it('refuses a negative amount instead of truncating toward zero', () => {
    expect(() => formatUsdcAmount(-1n, { rounding: 'down' })).toThrow(RangeError)
  })
})
