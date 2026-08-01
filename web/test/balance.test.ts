import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { UsdcViewError, nativeToErc20 } from '@arcpad/shared/browser'
import { composeUsdcBalance } from '../lib/balance'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * THE SUMMING TEST.
 *
 * A wallet holding 100 USDC reads `100e18` natively and `100e6` through the
 * ERC-20 contract -- measured on the live deployer. That is ONE fund seen
 * twice. This file fails if anything adds the two readings together, and it
 * fails by RUNNING the sum, not by asserting that nobody would.
 */
describe('the two views of one USDC balance are never summed', () => {
  const WEI = 100n * 10n ** 18n
  const UNITS = 100n * 10n ** 6n

  it('composes one balance from the native reading', () => {
    const view = composeUsdcBalance(WEI)
    expect(view.native).toEqual({ view: 'native_wei', wei: WEI })
    expect(view.erc20).toEqual({ view: 'erc20_units', units: UNITS })
    expect(view.display).toBe('100.000000')
    // Supplying the ERC-20 view explicitly must agree, not add.
    expect(composeUsdcBalance(WEI, UNITS).native.wei).toBe(WEI)
    expect(nativeToErc20(WEI)).toBe(UNITS)
  })

  it('a doubled ERC-20 row is REFUSED by name', () => {
    expect(() => composeUsdcBalance(WEI, UNITS + nativeToErc20(WEI))).toThrow(UsdcViewError)
    expect(() => composeUsdcBalance(WEI, UNITS + 1n)).toThrow(/two views of ONE fund/)
  })

  /**
   * THE MEASURED LIMIT OF THE RUNTIME CHECK -- and the reason the type gate,
   * not this check, is what actually stops the sum.
   *
   * `unifyUsdcViews` tests `units == floor(wei / 1e12)`. Adding `units` INTO
   * `wei` moves `wei` by less than one quantum unless `units >= 1e12`, i.e.
   * unless the balance is at least ONE MILLION USDC. Below that the sum is
   * arithmetically invisible to the check. Measured, both sides of the edge:
   *
   *   999_999 USDC -> units 999_999_000_000, floor((wei+units)/1e12) unchanged
   *   1_000_000 USDC -> units 1_000_000_000_000, floor bumps by exactly 1
   */
  it('CANNOT see the sum below one million USDC, and CAN at one million', () => {
    const at = (usdc: bigint) => {
      const wei = usdc * 10n ** 18n
      const units = nativeToErc20(wei)
      return { wei, units, summed: wei + units }
    }

    const below = at(999_999n)
    expect(nativeToErc20(below.summed)).toBe(below.units) // invisible
    expect(() => composeUsdcBalance(below.summed, below.units)).not.toThrow()

    const edge = at(1_000_000n)
    expect(nativeToErc20(edge.summed)).toBe(edge.units + 1n) // visible
    expect(() => composeUsdcBalance(edge.summed, edge.units)).toThrow(UsdcViewError)
  })

  /**
   * AND THE DISPLAY IS BLIND TOO. Six decimals of `100e18 + 100e6` still reads
   * `100.000000`: the error sits twelve orders of magnitude below the last
   * digit anybody looks at. No range check, no eyeball and no screenshot
   * review catches this -- which is why the defence is (1) one import seam,
   * enforced by the linter below, and (2) two OBJECT views that the compiler
   * refuses to add.
   */
  it('the display is BLIND to the 1e12 error', () => {
    const summed = WEI + UNITS
    expect(summed).not.toBe(WEI) // different money...
    expect(composeUsdcBalance(summed).display).toBe('100.000000') // ...same string
    expect(composeUsdcBalance(WEI).display).toBe('100.000000')
  })

  it('refuses a negative native reading rather than truncating toward zero', () => {
    expect(() => composeUsdcBalance(-1n)).toThrow(UsdcViewError)
  })
})

/**
 * THE LINT RULE, EXECUTED.
 *
 * `eslint.config.js` claims that only `web/lib/balance.ts` may import
 * `useBalance`. A claim about a lint rule is worth nothing until the linter
 * runs, so this runs it -- through `--stdin-filename`, so no fixture file is
 * left behind for `tsc` or `next build` to trip over.
 */
function lint(source: string, asFile: string): { ruleId: string | null; message: string }[] {
  // `process.execPath` + the JS entry point, NOT `npx`: Node refuses to spawn
  // a `.cmd` without a shell (EINVAL) on Windows, and a shell would change the
  // quoting rules for the file name being probed.
  const eslintBin = join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
  let stdout: string
  try {
    stdout = execFileSync(
      process.execPath,
      [eslintBin, '--stdin', '--stdin-filename', asFile, '--format', 'json'],
      { cwd: REPO_ROOT, input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
  } catch (error) {
    // ESLint exits non-zero WHENEVER it reports an error, which is the case
    // this file exists to observe. The JSON is still on stdout.
    const e = error as { status?: number; stdout?: string; stderr?: string }
    if (typeof e.stdout !== 'string' || e.stdout.trim() === '') {
      throw new Error(`eslint failed to run: status=${e.status} stderr=${e.stderr ?? ''}`)
    }
    stdout = e.stdout
  }
  const [result] = JSON.parse(stdout) as {
    messages: { ruleId: string | null; message: string }[]
  }[]
  return result?.messages ?? []
}

const IMPORTS_USE_BALANCE = "import { useBalance } from 'wagmi'\nexport const x = useBalance\n"
const IMPORTS_DEVCHAIN = [
  "import { startAnvil } from '@arcpad/shared/devchain'",
  'export const x = startAnvil',
  '',
].join(String.fromCharCode(10))

describe('only web/lib/balance.ts may import useBalance', () => {
  it('importing it from a hook is an error, and the message says why', () => {
    const messages = lint(IMPORTS_USE_BALANCE, 'web/hooks/useSomething.ts')
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports')
    expect(restricted).toHaveLength(1)
    expect(restricted[0]?.message).toContain('two views of ONE fund')
  })

  it('importing it from a component is an error too', () => {
    const messages = lint(IMPORTS_USE_BALANCE, 'web/components/Balance.tsx')
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toHaveLength(1)
  })

  /**
   * CONTROL. Without it, a misconfigured harness (wrong cwd, unresolved
   * config, a rule that fires on everything) would satisfy the cases above and
   * mean nothing.
   */
  it('CONTROL: the same import from web/lib/balance.ts is allowed', () => {
    const messages = lint(IMPORTS_USE_BALANCE, 'web/lib/balance.ts')
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toEqual([])
  })

  it('CONTROL: an unrelated wagmi import is allowed anywhere', () => {
    const messages = lint(
      "import { useConnection } from 'wagmi'\nexport const x = useConnection\n",
      'web/hooks/useSomething.ts',
    )
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toEqual([])
  })

  it.each([
    ['useAccount', 'useConnection'],
    ['useAccountEffect', 'useConnectionEffect'],
  ])('%s is restricted and points at %s', (deprecated, replacement) => {
    const messages = lint(
      `import { ${deprecated} } from 'wagmi'\nexport const x = ${deprecated}\n`,
      'web/hooks/useSomething.ts',
    )
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports')
    expect(restricted).toHaveLength(1)
    expect(restricted[0]?.message).toContain(replacement)
  })

  /**
   * THE COMPOSITION GATE.
   *
   * MEASURED: eslint flat config does NOT merge two `rules` entries for the
   * same rule -- the last matching block REPLACES the earlier one. A devchain
   * restriction added in its own block BEFORE the wagmi block was silently
   * erased for every file under `web/app/**` and `web/components/**`, and
   * reported nothing while looking configured. Both restrictions are asserted
   * on the SAME file set so neither can vanish again.
   */
  it('a component gets BOTH restrictions, not just the last block', () => {
    const devchain = lint(IMPORTS_DEVCHAIN, 'web/components/Foo.tsx').filter(
      (m) => m.ruleId === 'no-restricted-imports',
    )
    expect(devchain).toHaveLength(1)
    expect(devchain[0]?.message).toContain('anvil')

    const wagmi = lint(IMPORTS_USE_BALANCE, 'web/components/Foo.tsx').filter(
      (m) => m.ruleId === 'no-restricted-imports',
    )
    expect(wagmi).toHaveLength(1)
    expect(wagmi[0]?.message).toContain('two views of ONE fund')
  })

  it('CONTROL: web/lib may still import the devchain harness', () => {
    const messages = lint(IMPORTS_DEVCHAIN, 'web/lib/foo.ts')
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toEqual([])
  })

  it('the real tree has exactly one importer of useBalance', () => {
    // Walks the working tree rather than the git index, so an uncommitted
    // second importer is caught the moment it is written.
    const roots = ['app', 'components', 'hooks', 'lib', 'scripts']
    const files: string[] = []
    for (const root of roots) {
      const dir = join(REPO_ROOT, 'web', root)
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
        files.push(join(entry.parentPath ?? dir, entry.name))
      }
    }
    expect(files.length).toBeGreaterThan(3) // anti-vacuity: the walk found real files
    const importers = files
      .filter((f) => /import[^;]*\buseBalance\b[^;]*from\s+'wagmi'/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'))
    expect(importers).toEqual(['web/lib/balance.ts'])
  })
})
