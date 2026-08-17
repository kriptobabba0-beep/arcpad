import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeToErc20, parseUsdcAmount, USDC_VIEW_SCALE } from '@arcpad/shared/browser'
import { describe, expect, it } from 'vitest'
import {
  isQuantised,
  QUOTE_UNIT_SCALE,
  quoteDustWei,
  quoteUnitsFromWei,
  quoteWeiFromUnits,
} from '@/lib/quoteUnits'

/**
 * ============ THE 6-DECIMAL BOUNDARY LIVES IN ONE FILE ============
 *
 * `ArcpadRouter` has no `1e12` in it by construction: both pool legs are
 * ERC-20-denominated. The rest of this app is 18-decimal. So the seam that the
 * contracts do not have lands in `web/`, and this file is the executable form
 * of "in exactly one place".
 *
 * NO RUNTIME CHECK ON THIS CHAIN CAN SEE A 1e12 ERROR. A balance 1e12 times too
 * small and a small balance look identical at run time, which is why the
 * defence is structural (one file) and measured (a source scan with a control)
 * rather than an assertion about a value.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')

/** The one file allowed to convert. */
const SEAM = join('lib', 'quoteUnits.ts')

/**
 * Everything on the pool path. Listed rather than globbed on purpose: a glob
 * that stopped matching would shrink the scanned set silently and the gate
 * would pass by measuring nothing.
 */
const POOL_PATH_FILES = [
  join('lib', 'routerAbi.ts'),
  join('lib', 'poolOutcome.ts'),
  join('components', 'token', 'poolPlan.ts'),
  join('components', 'token', 'PoolTradePanel.tsx'),
  join('components', 'token', 'usePoolQuote.ts'),
  join('components', 'token', 'usePoolTrade.ts'),
  join('components', 'token', 'useTokenBalance.ts'),
  join('components', 'token', 'venue.ts'),
  join('components', 'token', 'TradeSurface.tsx'),
  join('components', 'token', 'PriceHistoryChart.tsx'),
  // On the pool path without a pool-ish name: it draws a 6-decimal approval.
  join('components', 'token', 'ApproveStep.tsx'),
]

/**
 * Any way of writing the scale. `1e12`, `10 ** 12`, the digits, and the two
 * shared helpers -- because "grep for 1e12" would miss `10n ** 12n` and a
 * direct `nativeToErc20` import, and both are conversions.
 */
const CONVERSION_PATTERNS: readonly [string, RegExp][] = [
  ['decimal literal', /\b1_?0{12}\b|\b1e12\b/],
  ['power form', /10n?\s*\*\*\s*(BigInt\()?12n?/],
  ['grouped literal', /1(_000){4}n?/],
  ['shared helper', /\b(nativeToErc20|erc20ToNative)\b/],
  ['shared constant', /\bUSDC_VIEW_SCALE\b/],
]

function read(relPath: string): string {
  return readFileSync(join(WEB, relPath), 'utf8')
}

/** Comments do not convert anything; the rule is about CODE. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('the seam is in one file, and the scan that says so is not vacuous', () => {
  it('CONTROL: the seam file itself converts, so the patterns really match something', () => {
    // Without this the regexes could all be broken and every assertion below
    // would pass by finding nothing anywhere.
    const seam = stripComments(read(SEAM))
    const hits = CONVERSION_PATTERNS.filter(([, pattern]) => pattern.test(seam)).map(
      ([name]) => name,
    )
    expect(
      hits,
      'the seam file must contain a conversion for this gate to mean anything',
    ).toContain('shared helper')
    expect(hits).toContain('shared constant')
  })

  it('no other file on the pool path converts between the two views', () => {
    for (const file of POOL_PATH_FILES) {
      const source = stripComments(read(file))
      for (const [label, pattern] of CONVERSION_PATTERNS) {
        expect(
          pattern.test(source),
          `${file} carries a ${label} conversion. The 6-decimal boundary belongs in ${SEAM}; a ` +
            'second copy is a 1e12 error nothing at run time can see.',
        ).toBe(false)
      }
    }
  })

  it('the scanned set is the whole pool path -- no file added itself out of the gate', () => {
    /*
     * REACH, ASSERTED AS A FILE LIST rather than inferred. A hand-written list
     * that fell behind the directory would keep passing while the new file went
     * unscanned -- the same hole the indexer's deletion gate had, closed the
     * same way.
     */
    const dirs = [join('lib'), join('components', 'token')]
    const found: string[] = []
    for (const dir of dirs) {
      for (const name of readdirSync(join(WEB, dir))) {
        const full = join(WEB, dir, name)
        if (!statSync(full).isFile()) continue
        if (!/^(pool|Pool|router|useRouter|usePool|venue|TradeSurface|PriceHistory)/.test(name)) {
          continue
        }
        found.push(relative(WEB, full))
      }
    }
    for (const file of found) {
      expect(
        [...POOL_PATH_FILES, SEAM],
        `${file} looks like pool-path code but is not in the scanned list`,
      ).toContain(file)
    }
    expect(found.length).toBeGreaterThanOrEqual(7)
  })
})

describe('the relation is truncation, and its asymmetry is the point', () => {
  it('units -> wei is EXACT and wei -> units TRUNCATES', () => {
    expect(quoteWeiFromUnits(1_000_000n)).toBe(1_000_000n * QUOTE_UNIT_SCALE)
    expect(quoteUnitsFromWei(1_000_000n * QUOTE_UNIT_SCALE)).toBe(1_000_000n)
    // The dust case: one wei below the quantum is ZERO units, not one.
    expect(quoteUnitsFromWei(QUOTE_UNIT_SCALE - 1n)).toBe(0n)
    expect(quoteUnitsFromWei(QUOTE_UNIT_SCALE + 999n)).toBe(1n)
  })

  /**
   * RE-MEASURED 2026-08-09 against the live deployer, AFTER the router shipped.
   * The multiplication form is the one AGENT-CONTEXT warns about, and it is
   * FALSE here -- as it is for any account that has ever paid for gas.
   */
  it('the live reading satisfies floor(wei/1e12) and NOT units*1e12', () => {
    const units = 74_516_800n
    const wei = 74_516_800_457_331_780_981n
    expect(quoteUnitsFromWei(wei)).toBe(units)
    expect(quoteWeiFromUnits(units)).not.toBe(wei)
    expect(quoteDustWei(wei)).toBe(457_331_780_981n)
    expect(isQuantised(wei)).toBe(false)
  })

  it('the seam delegates to the shared helpers rather than re-deriving them', () => {
    // Two implementations of one rule is how a rounding difference is born.
    for (const wei of [0n, 1n, 999_999_999_999n, 10n ** 24n + 7n]) {
      expect(quoteUnitsFromWei(wei)).toBe(nativeToErc20(wei))
    }
    expect(QUOTE_UNIT_SCALE).toBe(USDC_VIEW_SCALE)
  })

  it('a negative native amount is refused rather than silently truncated toward zero', () => {
    // BigInt division truncates toward zero, so "rounds down" is FALSE for
    // negatives -- the shared helper refuses instead, and so must this one.
    expect(() => quoteUnitsFromWei(-1n)).toThrow(RangeError)
  })
})

describe('THE TRUNCATION IS UNREACHABLE ON A TYPED AMOUNT, AND THAT IS MEASURED', () => {
  /**
   * `parseUsdcAmount` quantises to six decimals BEFORE returning native wei, so
   * every amount a user can type is already an exact multiple of the scale.
   * The truncating direction therefore only ever bites a BALANCE -- which is
   * why the panel's MAX shortcut quantises and the field does not need to.
   *
   * This is run over the parser rather than asserted about it: a change to the
   * parser's quantisation would make the claim false, and only an executed
   * check would notice.
   */
  it('every amount the parser accepts converts losslessly', () => {
    const inputs = [
      '0.000001',
      '1',
      '1.5',
      '12.161433',
      '0.123456',
      '999999999.999999',
      '.5',
      '7.000000',
    ]
    for (const text of inputs) {
      const parsed = parseUsdcAmount(text)
      expect(parsed.ok, `${text} should parse`).toBe(true)
      if (!parsed.ok) continue
      expect(isQuantised(parsed.value), `${text} is not on the 1e12 grid`).toBe(true)
      expect(quoteWeiFromUnits(quoteUnitsFromWei(parsed.value))).toBe(parsed.value)
    }
  })

  it('CONTROL: the parser REFUSES a seventh decimal, which is what makes that true', () => {
    // If the parser ever accepted finer input, the claim above would be false
    // and this is the assertion that would go red first.
    const parsed = parseUsdcAmount('0.0000001')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toBe('tooManyDecimals')
  })
})
