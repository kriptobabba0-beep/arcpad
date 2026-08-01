import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { TokAmount, TradePlan, WeiUsdc } from '../src/trade'

/**
 * EACH CASE SPAWNS A REAL `tsc`, which costs seconds -- and there are now TWO
 * files in this package that do it, so they contend for the same cores under
 * vitest's default parallelism. MEASURED: adding the second file pushed cases
 * in BOTH files past the 5s default and turned a green suite red for a reason
 * that had nothing to do with the types. The budget is PER FILE: every other
 * test in this package keeps the strict default.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * THE `_wei` / `_tok` SUFFIX CONTRACT, AS A TYPE.
 *
 * Phase 3 enforces it in the database with a schema gate on column names,
 * BECAUSE NO RUNTIME CHECK CAN SEE A 1e12 ERROR. Both views are 1e18-scaled
 * here too -- a native USDC amount and a launch token amount are the same
 * magnitude and the same JavaScript type -- so a swapped argument is invisible
 * at every layer including the chain.
 *
 * WHAT THE BRAND DOES AND DOES NOT BUY, measured rather than assumed:
 *   - ASSIGNING one where the other is expected: COMPILE ERROR. This is the
 *     mistake that actually happens (an argument in the wrong position), and it
 *     is closed.
 *   - ADDING them: STILL COMPILES. `bigint & {...}` is an intersection with
 *     `bigint`, so it is BigIntLike and `+` is allowed. That is the same
 *     measurement `two-views-typegate.test.ts` records for the USDC views, and
 *     it is why summing is closed by CARRYING the two USDC views as objects
 *     rather than by branding them.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK_DIR = join(HERE, '.tradetypes')
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript')), '..', 'bin', 'tsc')

function compile(name: string, source: string): { exitCode: number; output: string } {
  const file = join(WORK_DIR, `${name}.ts`)
  writeFileSync(file, source, 'utf8')
  try {
    const stdout = execFileSync(process.execPath, [TSC, '--project', WORK_DIR], {
      encoding: 'utf8',
      cwd: WORK_DIR,
    })
    return { exitCode: 0, output: stdout }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { exitCode: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  } finally {
    rmSync(file, { force: true })
  }
}

beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true })
  // The SAME base config the package compiles under, so the gate cannot pass
  // because of a laxer flag set than production uses.
  writeFileSync(
    join(WORK_DIR, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../../../tsconfig.base.json',
        compilerOptions: { noEmit: true },
        include: ['*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  )
})

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true })
})

const IMPORTS = "import { asTok, asWei } from '../../src/trade'\n"

describe('WeiUsdc and TokAmount are not interchangeable', () => {
  it('they are distinct types, and the plan fields carry the right one', () => {
    expectTypeOf<WeiUsdc>().not.toEqualTypeOf<TokAmount>()
    expectTypeOf<TradePlan['tokens']>().toEqualTypeOf<TokAmount>()
    expectTypeOf<TradePlan['value']>().toEqualTypeOf<WeiUsdc>()
    expectTypeOf<TradePlan['curveAmount']>().toEqualTypeOf<WeiUsdc>()
    expectTypeOf<TradePlan['protocolFee']>().toEqualTypeOf<WeiUsdc>()
    expectTypeOf<TradePlan['creatorFee']>().toEqualTypeOf<WeiUsdc>()
    expectTypeOf<TradePlan['refund']>().toEqualTypeOf<WeiUsdc>()
  })

  // CONTROL. Without it every case below could be satisfied by a broken
  // harness -- wrong tsc path, unresolvable import, bad tsconfig.
  it('CONTROL: the same imports, used correctly, compile clean', () => {
    const result = compile(
      'control',
      `${IMPORTS}
import type { TokAmount, WeiUsdc } from '../../src/trade'
export const wei: WeiUsdc = asWei(10n ** 18n)
export const tok: TokAmount = asTok(10n ** 18n)
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })

  it('passing a token amount where wei is expected does not compile', () => {
    const result = compile(
      'swapped',
      `${IMPORTS}
import type { WeiUsdc } from '../../src/trade'
export const wrong: WeiUsdc = asTok(10n ** 18n)
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('TS2322')
    // The diagnostic has to NAME both views, or the person who hits it has to
    // guess which two things they mixed.
    expect(result.output).toContain('nativeUsdcWei')
    expect(result.output).toContain('launchTokenBase')
  })

  it('and the other direction does not compile either', () => {
    const result = compile(
      'swappedback',
      `${IMPORTS}
import type { TokAmount } from '../../src/trade'

export const wrong: TokAmount = asWei(10n ** 18n)
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('TS2322')
  })

  it('a plan field cannot be assigned to the other view', () => {
    const result = compile(
      'planfield',
      `import type { TokAmount, TradePlan } from '../../src/trade'
declare const plan: TradePlan
export const wrong: TokAmount = plan.value
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('TS2322')
  })

  /**
   * THE HONEST LIMIT, RECORDED RATHER THAN HIDDEN.
   *
   * A brand does not stop `+`. If a future TypeScript starts rejecting this,
   * the comment at the top of `trade.ts` explaining the brand's reach has
   * become false and should be rewritten -- not deleted.
   */
  it('records WHY the brand is not the whole defence: the two still ADD', () => {
    const result = compile(
      'stilladds',
      `${IMPORTS}
export const total = asWei(1n) + asTok(1n)
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })

  it('a plain bigint cannot be passed where a view is expected', () => {
    const result = compile(
      'plainbigint',
      `import type { WeiUsdc } from '../../src/trade'
export const wrong: WeiUsdc = 10n ** 18n
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('TS2322')
  })
})
