import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ==========================================================================
 *  NOTHING IN `web/` MAY SUM THE PER-LAUNCH BREAKDOWN.
 * ==========================================================================
 *
 * `packages/db`'s `listCreatorEarningsByLaunch` carries a warning written for
 * its first caller, and this track is that caller. Both of its JOINs are
 * INNER, so two real classes of deposit are dropped:
 *
 *   - the SHARED escrow's prefix (36 496 595 214 216 153 wei, measured on
 *     chain 2026-08-09): `FeeEscrow` is keyed by RECIPIENT and Phase 2 reused
 *     Phase 1's escrow, so deposits from the superseded factory's curves have
 *     no `launches` row;
 *   - EVERY POOL FEE: `ArcpadHook` deposits it, so `Deposited.from` is the
 *     hook, not a curve.
 *
 * `sum(byLaunch)` is therefore SMALLER than `FeeEscrow.owed() + claimed`, and
 * a screen that printed it as "your earnings" would understate a creator's
 * money. The type already makes that hard -- `CreatorEarnings` has no field
 * equal to that sum -- but a `reduce` is four tokens away, and "hard" is not
 * "impossible".
 *
 * SO THIS IS A GATE, NOT A COMMENT. It reads the source of every file under
 * `web/` and fails if any of them folds an earnings array.
 *
 * ============ AND THE GATE'S OWN REACH IS MEASURED, NOT ASSUMED ============
 *
 * A source scan that matches nothing passes vacuously and looks identical to
 * one that matches nothing because the code is clean. The last test below
 * feeds the SAME detector a string containing exactly the forbidden shape and
 * requires it to fire -- and a second string that is legitimately different
 * (summing fee parts on a trade row) and requires it NOT to.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')

const SKIP = new Set(['node_modules', '.next', 'test-results', 'playwright-report', '.git'])

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sources(full, acc)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) acc.push(full)
  }
  return acc
}

/**
 * THE DETECTOR: a fold over anything named after the launch breakdown.
 *
 * It matches `byLaunch.reduce(`, `earnings.byLaunch.reduce(`,
 * `creatorEarnings.reduce(` and the `for (… of byLaunch)`-with-`+=` shape.
 * Deliberately NOT a general ban on `reduce`: this file sums fee parts, day
 * volumes and bar heights elsewhere and all of those are correct.
 */
export function summingViolations(source: string): string[] {
  const found: string[] = []
  const folds = /\b(?:\w*\.)?(byLaunch|creatorEarnings|earningsByLaunch)\s*\.\s*reduce\s*\(/g
  for (const m of source.matchAll(folds)) found.push(m[0])

  // The loop shape. `for (const x of byLaunch)` followed, within the next few
  // lines, by a `+=` accumulation.
  const loops = /for\s*\([^)]*\bof\s+(?:\w*\.)?(byLaunch|creatorEarnings)\b[^)]*\)([\s\S]{0,200})/g
  for (const m of source.matchAll(loops)) {
    if (/\+=|\+\s*=/.test(m[2] ?? '')) found.push(m[0].slice(0, 60))
  }
  return found
}

/**
 * THE GATE CAUGHT ITSELF ON ITS FIRST RUN, AND THAT IS RECORDED RATHER THAN
 * QUIETLY PATCHED.
 *
 * This file has to CONTAIN the forbidden shape -- twice, in the negative
 * control -- or its reach is unmeasured. So the scan skips exactly one file:
 * this one. `ordering.test.ts` in `packages/db` hit the identical problem (its
 * first version was broken by the comment EXPLAINING the rule) and the lesson
 * is the same: the exemption must be ONE named file, and the test below proves
 * it is the only one.
 */
const SELF = join(WEB, 'test', 'profile', 'earnings-total.test.ts')

describe('the earnings total is never re-derived in web/', () => {
  it('no source file folds the per-launch breakdown into a total', () => {
    const files = sources(WEB)
    // NON-VACUOUS BY CONSTRUCTION: if the walk finds nothing, the loop below
    // proves nothing.
    expect(files.length).toBeGreaterThan(50)
    // THE EXEMPTION IS EXACTLY ONE FILE AND IT IS ON DISK. A stale path would
    // silently exempt nothing -- or, worse, a renamed file would exempt itself
    // by accident.
    expect(files.filter((f) => f === SELF)).toHaveLength(1)

    const offenders: string[] = []
    for (const file of files) {
      if (file === SELF) continue
      const violations = summingViolations(readFileSync(file, 'utf8'))
      if (violations.length > 0) offenders.push(`${relative(WEB, file)}: ${violations.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  /**
   * AND THE EXEMPTED FILE IS ITSELF DIRTY -- i.e. the exemption is load-bearing.
   *
   * If this file stopped containing the forbidden shape, the negative control
   * below would have stopped testing anything, and nothing else would say so.
   */
  it('the one exempted file is the one that must contain the forbidden shape', () => {
    expect(summingViolations(readFileSync(SELF, 'utf8')).length).toBeGreaterThan(0)
  })

  /**
   * AND THE FILES THAT MATTER ACTUALLY MENTION `byLaunch`.
   *
   * Without this, the gate above would stay green in a world where the
   * breakdown was never rendered at all -- i.e. it would be measuring the
   * absence of the feature rather than the correctness of it.
   */
  it('the panel really does render the breakdown it is forbidden to sum', () => {
    const panel = readFileSync(join(WEB, 'components/profile/EarningsPanel.tsx'), 'utf8')
    expect(panel).toMatch(/byLaunch\.map\(/)
    expect(panel).toMatch(/depositedTotalWei/)
    expect(panel).toMatch(/unattributedWei/)
  })

  /**
   * THE PAGE FORWARDS THE OBJECT WHOLE.
   *
   * `<EarningsPanel earnings={earnings} />` and nothing else. A call site that
   * spread it (`{...earnings}`) or rebuilt it would put the pairing of rows and
   * total back into the page's hands, which is where it goes wrong.
   */
  it('the profile page passes one object, not loose numbers', () => {
    const page = readFileSync(join(WEB, 'app/profile/[address]/page.tsx'), 'utf8')
    expect(page).toMatch(/<EarningsPanel\s+earnings=\{earnings\}>/)
    expect(page).not.toMatch(/<EarningsPanel[^>]*\{\.\.\./)
    // And the claim panel is fed a READ address, not a literal.
    expect(page).toMatch(/<ClaimPanel\s+recipient=\{account\}\s*\/>/)
  })

  /**
   * ============ THE GATE FIRES ON THE REAL SHAPE, AND ONLY ON IT ============
   *
   * Measured rather than assumed. Without this the regex could match nothing
   * at all and the suite would be just as green.
   */
  it('NEGATIVE CONTROL: the detector catches a fold and spares a legitimate one', () => {
    expect(
      summingViolations('const total = earnings.byLaunch.reduce((a, r) => a + r.earnedWei, 0n)'),
    ).toHaveLength(1)
    expect(
      summingViolations('let t = 0n\nfor (const row of byLaunch) { t += row.earnedWei }'),
    ).toHaveLength(1)

    // Summing the two FEE PARTS of one trade is correct and stays legal: they
    // are two independent ceilings on one row, not a breakdown of a ledger.
    expect(
      summingViolations('<Money native={row.protocolFeeWei + row.creatorFeeWei} rounding="up" />'),
    ).toEqual([])
    // As does folding a day series.
    expect(summingViolations('days.reduce((a, d) => a + d.volumeWei, 0n)')).toEqual([])
  })
})
