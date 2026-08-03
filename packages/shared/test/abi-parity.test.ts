import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bondingCurveAbi,
  curveMathErrorsAbi,
  feeEscrowAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '../src/abi/index'

/**
 * THE ABI IS COMPARED AGAINST THE COMPILED OUTPUT, IN BOTH DIRECTIONS.
 *
 * A test that only asks "is everything I expected still there" cannot see an
 * ADDED function, and an added function is the whole point: it is how a
 * contract change reaches production without the frontend noticing. The
 * comparison is therefore a full deep-equal over normalised entries.
 *
 * `internalType` is dropped (it is a Solidity-side annotation with no
 * behaviour). Everything else is kept -- `stateMutability`, `outputs`, and
 * `indexed` in particular. Faz 1c measured that `claim(address) external ->
 * external payable` and dropping `indexed` from `Trade.trader` both left
 * 245/245 green under a name-set comparison, and the second one silently
 * empties every indexer filter.
 *
 * This file is NOT in `pnpm test`. It needs `contracts/out/`, which needs
 * Foundry, and `pnpm -r test` has to run on machines without it. It runs in
 * its own CI job through `test:abi`, and the selection-gap gate at the bottom
 * asserts that job exists.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const ARTIFACTS = {
  LaunchFactory: 'contracts/out/LaunchFactory.sol/LaunchFactory.json',
  BondingCurve: 'contracts/out/BondingCurve.sol/BondingCurve.json',
  LaunchToken: 'contracts/out/LaunchToken.sol/LaunchToken.json',
  FeeEscrow: 'contracts/out/FeeEscrow.sol/FeeEscrow.json',
  CurveMath: 'contracts/out/CurveMath.sol/CurveMath.json',
} as const

/** The hand-distributed side. `CurveMath` carries error entries only. */
const DISTRIBUTED: Record<keyof typeof ARTIFACTS, readonly unknown[]> = {
  LaunchFactory: launchFactoryAbi,
  BondingCurve: bondingCurveAbi,
  LaunchToken: launchTokenAbi,
  FeeEscrow: feeEscrowAbi,
  CurveMath: curveMathErrorsAbi,
}

type AbiEntry = { type: string; name?: string; inputs?: { type: string }[] }

function stripInternalType(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripInternalType)
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'internalType') continue
      out[k] = stripInternalType(v)
    }
    return out
  }
  return node
}

const rank: Record<string, number> = {
  constructor: 0,
  receive: 1,
  fallback: 2,
  function: 3,
  event: 4,
  error: 5,
}

function sortKey(entry: AbiEntry): string {
  return [
    rank[entry.type] ?? 9,
    entry.name ?? '',
    (entry.inputs ?? []).map((i) => i.type).join(','),
  ].join(' ')
}

function normalise(abi: readonly unknown[]): unknown[] {
  return (stripInternalType(abi) as AbiEntry[])
    .slice()
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
}

describe('the distributed ABI matches the compiled output', () => {
  it.each(Object.entries(ARTIFACTS))('%s', (name, relative) => {
    const artifact = join(REPO_ROOT, relative)
    // A MISSING ARTIFACT FAILS. It does not skip: a skipped check reads
    // exactly like a passing one in a CI summary, and the whole point of the
    // dedicated `test:abi` job is that this check actually runs somewhere.
    if (!existsSync(artifact)) {
      throw new Error(`${relative} is missing. Run first: forge build --root contracts`)
    }
    const compiled = JSON.parse(readFileSync(artifact, 'utf8')).abi as unknown[]
    const expected =
      name === 'CurveMath' ? compiled.filter((e) => (e as AbiEntry).type === 'error') : compiled
    expect(normalise(DISTRIBUTED[name as keyof typeof ARTIFACTS])).toEqual(normalise(expected))
  })

  /**
   * ANTI-VACUITY. If `normalise` ever started returning `[]` -- a bad path, a
   * failed parse swallowed somewhere -- every case above would compare `[]`
   * with `[]` and pass. These counts were read off the artifacts, once.
   */
  it('the comparison is not comparing two empty arrays', () => {
    expect(normalise(launchFactoryAbi)).toHaveLength(51)
    expect(normalise(bondingCurveAbi)).toHaveLength(57)
    expect(normalise(launchTokenAbi)).toHaveLength(28)
    expect(normalise(feeEscrowAbi)).toHaveLength(10)
    expect(normalise(curveMathErrorsAbi)).toHaveLength(5)
  })

  /**
   * THE PROPERTIES THAT A NAME-SET COMPARISON CANNOT SEE, asserted directly so
   * a future rewrite of `normalise` cannot quietly drop them.
   */
  it('keeps stateMutability, outputs and indexed', () => {
    const claim = feeEscrowAbi.find((e) => e.type === 'function' && e.name === 'claim')
    expect(claim).toMatchObject({ stateMutability: 'nonpayable' })

    const buy = bondingCurveAbi.find((e) => e.type === 'function' && e.name === 'buyExactQuoteIn')
    expect(buy).toMatchObject({ stateMutability: 'payable' })

    const complete = bondingCurveAbi.find((e) => e.type === 'function' && e.name === 'complete')
    expect(complete).toMatchObject({ outputs: [{ name: '', type: 'bool' }] })

    const events = bondingCurveAbi.filter((e) => e.type === 'event')
    expect(events.length).toBeGreaterThan(0)
    const indexedSomewhere = events.some((e) =>
      (e as unknown as { inputs: readonly { indexed?: boolean }[] }).inputs.some(
        (i) => i.indexed === true,
      ),
    )
    expect(indexedSomewhere).toBe(true)
  })
})

/**
 * THE SELECTION-GAP GATE.
 *
 * This file is excluded from `pnpm test` on purpose, and the price of that is
 * the risk that it never runs anywhere at all. So it asserts its own CI job
 * exists. The gap this closes is in test SELECTION, not in coverage.
 *
 * IT IS MATCHED STRUCTURALLY -- against the set of `run:` COMMANDS extracted
 * from the workflow -- and not by searching the file text.
 *
 * MEASURED: the first draft asserted the bare substring `test:abi` and
 * SURVIVED a mutant that replaced the actual command with `true`, because the
 * explanatory comment above the job contains those words too. Matching `'run:
 * <cmd>'` as a substring fixed that one, but it leaves the same SHAPE in
 * place: this workflow also mentions `pnpm -r test` inside a comment, so a
 * future gate written that way would pass on prose again. Extracting the
 * commands removes the shape rather than the instance.
 */

/** Every command a `run:` step actually executes, one per entry. */
function runCommands(workflow: string): string[] {
  const commands: string[] = []
  const lines = workflow.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    // A comment line can never be a step, whatever it says.
    if (/^\s*#/.test(line)) continue
    const single = /^\s*(?:-\s+)?run:\s*(\S.*?)\s*$/.exec(line)
    if (single?.[1] !== undefined) {
      if (single[1] === '|' || single[1] === '>-' || single[1] === '|-') {
        // Block scalar: take the indented lines that follow.
        for (let j = i + 1; j < lines.length; j += 1) {
          const body = lines[j] ?? ''
          if (body.trim() === '') continue
          if (!/^\s{2,}\S/.test(body)) break
          commands.push(body.trim())
        }
        continue
      }
      commands.push(single[1])
    }
  }
  return commands
}

describe('this file is actually run somewhere', () => {
  const workflow = () => readFileSync(join(REPO_ROOT, '.github/workflows/node.yml'), 'utf8')

  it('the extractor finds real steps and NOT the prose around them', () => {
    // Anti-vacuity, and the control that makes the two assertions below mean
    // something: an extractor returning everything, or nothing, would satisfy
    // a containment check just as happily.
    const commands = runCommands(workflow())
    expect(commands.length).toBeGreaterThan(5)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    // `pnpm -r test` appears in a COMMENT in this workflow as well as in a
    // step. The extractor must find the step and must not be satisfiable by
    // the comment, so every extracted entry has to look like a command.
    for (const command of commands) {
      expect(command.startsWith('#')).toBe(false)
    }
  })

  it('a CI job RUNS test:abi, after building the contracts', () => {
    const commands = runCommands(workflow())
    expect(commands).toContain('pnpm --filter @arcpad/shared test:abi')
    expect(commands).toContain('forge build --root contracts')
    // Order matters: the parity test reads `contracts/out/`, so a build that
    // ran afterwards would leave it comparing against a stale or absent tree.
    expect(commands.indexOf('forge build --root contracts')).toBeLessThan(
      commands.indexOf('pnpm --filter @arcpad/shared test:abi'),
    )
  })

  it('the package declares the script that job calls', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/shared/package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:abi']).toBeDefined()
    // And it is NOT folded into `test`: `pnpm -r test` must stay runnable
    // without Foundry.
    expect(pkg.scripts.test).not.toContain('abi')
  })
})
