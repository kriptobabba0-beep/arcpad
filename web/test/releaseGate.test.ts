import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertNoEscapeHatch,
  ESCAPE_HATCH,
  EscapeHatchPresent,
  GATE_STEPS,
  judgeOpenCells,
  OPEN_CELLS,
  REQUIRED_STEPS,
} from '@/lib/releaseGate'

/**
 * THE GATE'S OWN GATE.
 *
 * Two shapes have already bitten this project and both are the same mistake:
 * a check that is satisfied by something other than the thing it guards. A CI
 * gate matched a COMMENT rather than a `run:` line and survived its command
 * being replaced with `true`; a completeness check iterated a subset and was
 * vacuous for one action.
 *
 * So every assertion below is written to FAIL WHEN THE THING IT GUARDS IS
 * REMOVED, and the ones that could be satisfied trivially carry an explicit
 * control that proves they are not.
 *
 * This file never RUNS the gate. It reads its rules. Running it here would put
 * a four-minute build inside `pnpm --filter @arcpad/web test` and, worse, would
 * recurse: the gate's `test` step runs this file.
 */

const REPO_ROOT = join(process.cwd(), '..')

/**
 * Every command a `run:` step in a workflow actually executes.
 *
 * COMMENTS CANNOT SATISFY IT, and that is measured below rather than assumed:
 * this workflow mentions several of these commands in prose, which is exactly
 * how the earlier gate came to survive its own removal.
 */
function runCommands(workflow: string): string[] {
  const commands: string[] = []
  const lines = workflow.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^\s*#/.test(line)) continue
    const single = /^\s*(?:-\s+)?run:\s*(\S.*?)\s*$/.exec(line)
    if (single?.[1] === undefined) continue
    if (single[1] === '|' || single[1] === '>-' || single[1] === '|-') {
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
  return commands
}

const workflow = (): string => readFileSync(join(REPO_ROOT, '.github/workflows/node.yml'), 'utf8')

describe('the escape hatch cannot survive a release', () => {
  it('refuses when the variable is set', () => {
    expect(() => assertNoEscapeHatch({ [ESCAPE_HATCH]: '1' })).toThrow(EscapeHatchPresent)
    // Presence, not truthiness: a shell shaped like the harness's is still a
    // shell shaped like the harness's.
    expect(() => assertNoEscapeHatch({ [ESCAPE_HATCH]: '0' })).toThrow(EscapeHatchPresent)
  })

  it('accepts an unset variable and an explicitly CLEARED one', () => {
    expect(() => assertNoEscapeHatch({})).not.toThrow()
    // `{ ...env, VAR: '' }` is how a parent process clears an inherited
    // variable, and the e2e harness does exactly that for `DATABASE_URL`.
    expect(() => assertNoEscapeHatch({ [ESCAPE_HATCH]: '' })).not.toThrow()
  })

  it('the harness really does set the variable this refuses — the two sides agree', () => {
    // WITHOUT THIS, the refusal above guards a string nothing produces. The
    // point of the hatch is that ONE place sets it and the gate rejects it;
    // if the harness renamed it, this test says so instead of the gate
    // silently guarding nothing.
    const setup = readFileSync(join(process.cwd(), 'e2e/global-setup.ts'), 'utf8')
    expect(setup).toContain(ESCAPE_HATCH)
    const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8')
    expect(config).toContain(ESCAPE_HATCH)
  })
})

describe('the gate contains every required step', () => {
  it('every required id is present', () => {
    const have = new Set(GATE_STEPS.map((step) => step.id))
    const missing = REQUIRED_STEPS.filter((id) => !have.has(id))
    expect(missing, `the gate lost required steps: ${missing.join(', ')}`).toEqual([])
  })

  it('the requirement list is checked in the direction that can FAIL', () => {
    /*
     * THE ANTI-VACUITY CONTROL.
     *
     * Iterating `GATE_STEPS` and asserting each one is "required" passes for a
     * gate with one step. The requirement must be the OUTER loop, and this
     * proves the check would notice a removal by removing one.
     */
    const pretendRemoved = GATE_STEPS.filter((step) => step.id !== 'build')
    const have = new Set(pretendRemoved.map((step) => step.id))
    const missing = REQUIRED_STEPS.filter((id) => !have.has(id))
    expect(missing, 'dropping a step must be detectable').toEqual(['build'])
  })

  it('every step names a real pnpm script, and every step says why it exists', () => {
    const web = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const step of GATE_STEPS) {
      expect(step.why.length, `${step.id} has no stated reason`).toBeGreaterThan(30)

      const filtered = /^pnpm --filter @arcpad\/web (\S+)/.exec(step.run)
      const rootRun = /^pnpm run (\S+)$/.exec(step.run)
      const recursive = /^pnpm -r (\S+)$/.exec(step.run)
      if (filtered?.[1] !== undefined) {
        expect(web.scripts[filtered[1]], `web has no "${filtered[1]}" script`).toBeDefined()
      } else if (rootRun?.[1] !== undefined) {
        expect(root.scripts[rootRun[1]], `the root has no "${rootRun[1]}" script`).toBeDefined()
      } else if (recursive?.[1] !== undefined) {
        expect(web.scripts[recursive[1]], `web has no "${recursive[1]}" script`).toBeDefined()
      } else {
        throw new Error(`${step.id} runs "${step.run}", which this check cannot verify`)
      }
    }
  })

  it('the gate NEVER contains an e2e step — a gate that needs anvil is a gate CI cannot run', () => {
    // The browser legs are their own CI jobs with their own toolchain. Folding
    // them in here would make the release gate unrunnable on a machine with no
    // Foundry, which is every machine a release is cut from.
    for (const step of GATE_STEPS) {
      expect(step.run).not.toContain('playwright')
      expect(step.run).not.toContain('e2e')
    }
  })
})

describe('the workflow really runs what these tests assert', () => {
  it('the extractor finds real steps and NOT the prose around them', () => {
    const commands = runCommands(workflow())
    expect(commands.length).toBeGreaterThan(5)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    for (const command of commands) expect(command.startsWith('#')).toBe(false)
  })

  it('the extractor is NOT satisfied by a comment — measured, not assumed', () => {
    /*
     * The exact mutant that beat the first version of this shape: the command
     * replaced with `true`, the words still present in a comment above it.
     */
    const mutated = workflow().replace(
      /^(\s*)run: pnpm --filter @arcpad\/web e2e:local\s*$/m,
      '$1run: true',
    )
    expect(mutated, 'the mutation must have applied for this control to mean anything').not.toBe(
      workflow(),
    )
    expect(runCommands(mutated)).not.toContain('pnpm --filter @arcpad/web e2e:local')
  })

  it('a CI job runs the local end-to-end leg, after building the contracts', () => {
    const commands = runCommands(workflow())
    expect(commands).toContain('pnpm --filter @arcpad/web e2e:local')
    expect(commands).toContain('pnpm --filter @arcpad/web e2e:audit')
    expect(commands).toContain('forge build --root contracts')
    // Order: the harness deploys the COMPILED bytecode, so a build that ran
    // afterwards would leave it deploying a stale or absent tree.
    expect(commands.indexOf('forge build --root contracts')).toBeLessThan(
      commands.indexOf('pnpm --filter @arcpad/web e2e:local'),
    )
  })

  it('nothing in the workflow can turn a failure green', () => {
    /*
     * Phase 0 recorded a job-level `continue-on-error` that showed a failing
     * job as green. The rule is absolute in this phase, so it is checked over
     * the whole file -- but over the DIRECTIVES, not the text. Substring-
     * matching the file was the first version and it failed on the comment
     * three lines above, which is the same mistake in miniature: a check that
     * cannot tell prose from configuration.
     */
    const directives = workflow()
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /^\s*continue-on-error\s*:/.test(line))
    expect(directives, `continue-on-error found:\n${directives.join('\n')}`).toEqual([])
  })

  it('the continue-on-error detector actually fires — the control', () => {
    // Without this, "no continue-on-error" is also satisfied by a filter that
    // matches nothing at all, which is what the first version effectively was.
    const mutated = workflow().replace(
      /^(\s*)runs-on: ubuntu-latest$/m,
      '$1runs-on: ubuntu-latest\n$1continue-on-error: true',
    )
    expect(mutated).not.toBe(workflow())
    const found = mutated
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /^\s*continue-on-error\s*:/.test(line))
    expect(found.length).toBe(1)
  })

  it('the release gate itself is run by CI', () => {
    expect(runCommands(workflow())).toContain('pnpm --filter @arcpad/web release-gate')
  })
})

describe('declared open cells', () => {
  it('the search 503 is DECLARED, not discovered', () => {
    const cell = OPEN_CELLS.find((entry) => entry.id === 'search-503')
    expect(cell, '`/api/search` answering 503 must be a named allowance').toBeDefined()
    expect(cell!.why.length).toBeGreaterThan(80)
  })

  it('a cell stays open while its reason holds, and EXPIRES when it stops', () => {
    // The reason: `@arcpad/db` does not export `searchTokens` at HEAD.
    const open = judgeOpenCells(() => 'export { listTokens } from "./queries"')
    expect(open.every((verdict) => !verdict.expired)).toBe(true)

    // THE CONTROL, and the half that matters: the day the other track commits
    // `searchTokens`, this allowance must stop being granted.
    const closed = judgeOpenCells(() => 'export { listTokens, searchTokens } from "./queries"')
    expect(closed.some((verdict) => verdict.expired)).toBe(true)
  })

  it('an unreadable witness EXPIRES the cell rather than granting it', () => {
    // A witness that moved is a reason nobody can check. An allowance nobody
    // can check is the thing this mechanism exists to prevent.
    const gone = judgeOpenCells(() => null)
    expect(gone.every((verdict) => verdict.expired)).toBe(true)
  })

  it('every cell names a witness that EXISTS at HEAD right now', () => {
    // Otherwise the previous test is the only thing keeping a typo honest, and
    // it would report every cell as expired for the wrong reason.
    for (const cell of OPEN_CELLS) {
      const content = execFileSync('git', ['show', `HEAD:${cell.witness}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      expect(content.length, `${cell.witness} is empty at HEAD`).toBeGreaterThan(0)
    }
  })

  it('the shim the cell describes is still the one in the code', () => {
    // A cell that describes a shim somebody already deleted is a stale note,
    // and a stale note is indistinguishable from a lie.
    const boundary = readFileSync(
      join(process.cwd(), 'components/search/searchBoundary.ts'),
      'utf8',
    )
    expect(boundary).toContain("reason: 'unavailable'")
  })
})
