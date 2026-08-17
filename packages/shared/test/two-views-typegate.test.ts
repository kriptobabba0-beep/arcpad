import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
 * THE TWO-VIEWS RULE, ENFORCED BY THE COMPILER -- AND MEASURED.
 *
 * `balance.ts` claims that making the two USDC views OBJECTS (rather than
 * branded bigints) is what makes summing them a compile error. That claim is
 * only worth the comment if something runs the compiler, so this does: it
 * writes three tiny programs and runs `tsc --noEmit` on each.
 *
 * The control program exists because a harness that always fails proves
 * nothing. If the compile of a NON-summing program stopped succeeding, the
 * "summing fails" cases would still pass and would mean nothing at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK_DIR = join(HERE, '.typegate')
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript')), '..', 'bin', 'tsc')

type CompileResult = { exitCode: number; output: string }

function compile(name: string, source: string): CompileResult {
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
  // Extends the SAME base config the package compiles under, so the gate
  // cannot pass because of a laxer flag set than production uses.
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

const IMPORTS = "import { erc20Usdc, nativeUsdc } from '../../src/balance'\n"

describe('summing the two USDC views does not compile', () => {
  // CONTROL. Without this, every assertion below could be satisfied by a
  // broken harness (wrong tsc path, unresolvable import, bad tsconfig).
  it('CONTROL: the same imports, without a sum, compile clean', () => {
    const result = compile(
      'control',
      `${IMPORTS}
const native = nativeUsdc(100n * 10n ** 18n)
const erc20 = erc20Usdc(100n * 10n ** 6n)
export const both = { wei: native.wei, units: erc20.units }
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })

  // NOTE: the fixture must contain no suppression directive. An earlier draft
  // carried a comment SAYING that `@ts-expect-error` was not used -- writing
  // the token is using it, so tsc suppressed the very diagnostic under test
  // and this case passed with exit 0. It was caught only by running it.
  it('adding a native view to an ERC-20 view is TS2365', () => {
    const result = compile(
      'sum',
      `${IMPORTS}
const native = nativeUsdc(100n * 10n ** 18n)
const erc20 = erc20Usdc(100n * 10n ** 6n)
export const total = native + erc20
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('TS2365')
    expect(result.output).toContain("Operator '+' cannot be applied")
    // The diagnostic must name BOTH views, so the person who hits it learns
    // which two things they tried to add.
    expect(result.output).toContain('NativeUsdc')
    expect(result.output).toContain('Erc20Usdc')
  })

  /**
   * THE SHAPE `web/lib/balance.ts` HANDS TO COMPONENTS.
   *
   * A balance carried as `{ wei: bigint; units: bigint }` lets `b.wei +
   * b.units` compile, and the runtime check CANNOT cover for it: adding the
   * ERC-20 view into the native one moves `wei` by less than one truncation
   * quantum for any balance below 1e6 USDC, so `unifyUsdcViews` sees nothing
   * (measured in `web/test/balance.test.ts`). Carrying the two OBJECT views
   * instead makes the same mistake a compile error, and this is the test that
   * says so by compiling it.
   */
  it('the balance VIEW shape refuses to add its two fields', () => {
    const result = compile(
      'balanceview',
      `${IMPORTS}
import type { Erc20Usdc, NativeUsdc } from '../../src/balance'
type UsdcBalanceView = { readonly native: NativeUsdc; readonly erc20: Erc20Usdc }
const view: UsdcBalanceView = { native: nativeUsdc(100n * 10n ** 18n), erc20: erc20Usdc(100n * 10n ** 6n) }
export const total = view.native + view.erc20
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('TS2365')
  })

  /**
   * THE CONTROL FOR THAT CHOICE: the FLAT shape compiles the sum clean. This
   * is not a nicety -- it is the measurement that rules out flattening, and if
   * a future TypeScript starts rejecting it the comment above becomes false.
   */
  it('records WHY the shape is not flattened: two bigint fields still add', () => {
    const result = compile(
      'flatbalance',
      `type FlatBalance = { readonly wei: bigint; readonly units: bigint }
declare const b: FlatBalance
export const total = b.wei + b.units
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })

  /**
   * THE LIMIT OF THE OBJECT SHAPE, COMPILED RATHER THAN GUESSED.
   *
   * Review found the claim above stated more absolutely than it holds. Two
   * paths still compile, and both are recorded here so nobody has to
   * rediscover them:
   *
   *   1. unwrapping both views by hand and adding the bigints, and
   *   2. `unifyUsdcViews` itself, whose return type IS the flat shape --
   *      exported from `browser.ts` and therefore reachable by any caller.
   *
   * These are CONTROLS, not failures: they are the reason the structural
   * defence is the single `useBalance` seam (enforced by eslint, executed in
   * `web/test/balance.test.ts`) rather than the type. If either of these ever
   * STOPS compiling, the comments in `web/lib/balance.ts` naming them as open
   * have become false and should be rewritten, not deleted.
   */
  it('CONTROL: unwrapping both views by hand and adding them COMPILES', () => {
    const result = compile(
      'unwrapped',
      `${IMPORTS}
import type { Erc20Usdc, NativeUsdc } from '../../src/balance'
type View = { readonly native: NativeUsdc; readonly erc20: Erc20Usdc }
const view: View = { native: nativeUsdc(100n * 10n ** 18n), erc20: erc20Usdc(100n * 10n ** 6n) }
export const total = view.native.wei + view.erc20.units
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })

  it('CONTROL: unifyUsdcViews returns the FLAT shape, and its fields add', () => {
    const result = compile(
      'unified',
      `${IMPORTS}
import { unifyUsdcViews } from '../../src/balance'
const one = unifyUsdcViews(nativeUsdc(100n * 10n ** 18n), erc20Usdc(100n * 10n ** 6n))
export const total = one.wei + one.units
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })
  it('assigning one view where the other is expected does not compile either', () => {
    const result = compile(
      'assign',
      `${IMPORTS}
import type { NativeUsdc } from '../../src/balance'

const erc20 = erc20Usdc(100n * 10n ** 6n)
export const wrong: NativeUsdc = erc20
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('Erc20Usdc')
  })

  /**
   * THE MEASUREMENT THAT PICKED THE DESIGN.
   *
   * Branding a bigint (`bigint & {brand}`) is the obvious way to type a unit,
   * and it DOES NOT WORK: an intersection with `bigint` is still BigIntLike,
   * so `+` is allowed and the 1e12 mistake compiles clean. If a future
   * TypeScript starts rejecting it, this test goes red -- and at that point
   * the comment in `balance.ts` explaining why the views are objects has
   * become false and should be rewritten, not deleted.
   */
  it('records WHY the views are objects: branded bigints still add', () => {
    const result = compile(
      'branded',
      `declare const nb: unique symbol
declare const eb: unique symbol
type BrandedNative = bigint & { readonly [nb]: true }
type BrandedErc20 = bigint & { readonly [eb]: true }
declare const a: BrandedNative
declare const b: BrandedErc20
export const total = a + b
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })
})
