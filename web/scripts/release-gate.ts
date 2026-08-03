import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  assertNoEscapeHatch,
  EscapeHatchPresent,
  GATE_STEPS,
  judgeOpenCells,
  REQUIRED_STEPS,
} from '../lib/releaseGate'

/**
 * `pnpm --filter @arcpad/web release-gate`
 *
 * The shell around `lib/releaseGate.ts`. It spawns the steps, prints an
 * attribution for whatever failed, and rules on the declared open cells.
 * Everything worth testing is in the library; this file is the part that
 * cannot be tested without spending four minutes, so it holds no decisions.
 *
 * EXIT CODES
 *   0  ship it
 *   1  a step failed
 *   2  the escape hatch was set — the gate refused to run at all
 *   3  a declared open cell has expired: the reason it was open no longer holds
 */

const REPO_ROOT = resolve(process.cwd(), '..')

function line(text = ''): void {
  process.stdout.write(`${text}\n`)
}

/** The content of a path AT HEAD. `null` when git or the path cannot answer. */
function readHead(path: string): string | null {
  const result = spawnSync('git', ['show', `HEAD:${path}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // A repository with a hook that writes to stderr must not poison the read.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout
}

function runStep(run: string): { ok: boolean; output: string } {
  const [command, ...args] = run.split(' ')
  const result = spawnSync(
    command === 'pnpm' && process.platform === 'win32' ? 'pnpm.cmd' : command!,
    args,
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        // BELT AND BRACES. `assertNoEscapeHatch` already refused above; deleting
        // it from the child environment means a step cannot inherit it from a
        // shell profile either.
        ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK: '',
        NEXT_TELEMETRY_DISABLED: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { ok: result.status === 0, output }
}

/**
 * Names the files a failed step complained about.
 *
 * ATTRIBUTION, NEVER EXEMPTION. The gate's verdict does not consult this; it
 * exists so that a red gate is actionable rather than merely red, and so the
 * ruling ("we fail on other tracks' errors too") comes with the courtesy of
 * saying whose they are.
 */
function attribute(output: string): string[] {
  const files = new Set<string>()
  for (const raw of output.split('\n')) {
    const tsc = /^([^\s(]+\.tsx?)\(\d+,\d+\): error TS/.exec(raw.trim())
    if (tsc?.[1] !== undefined) files.add(tsc[1])
    const eslint = /^([A-Za-z]:[\\/][^\s]+\.tsx?)$/.exec(raw.trim())
    if (eslint?.[1] !== undefined) files.add(eslint[1])
    const prettier = /^\[warn\]\s+(\S+)$/.exec(raw.trim())
    if (prettier?.[1] !== undefined) files.add(prettier[1])
  }
  return [...files]
}

function main(): number {
  try {
    assertNoEscapeHatch(process.env as Record<string, string | undefined>)
  } catch (error) {
    if (error instanceof EscapeHatchPresent) {
      process.stderr.write(`REFUSED ${error.message}\n`)
      return 2
    }
    throw error
  }

  // The requirement is checked against the implementation, in the direction
  // that can fail: a step dropped from `GATE_STEPS` is caught HERE as well as
  // in `web/test/releaseGate.test.ts`, so a release cannot be certified by a
  // gate that quietly lost a step.
  const have = new Set(GATE_STEPS.map((step) => step.id))
  const missing = REQUIRED_STEPS.filter((id) => !have.has(id))
  if (missing.length > 0) {
    process.stderr.write(`REFUSED the gate is missing required steps: ${missing.join(', ')}\n`)
    return 2
  }

  line('release gate')
  line('============')
  let failed = false
  for (const step of GATE_STEPS) {
    process.stdout.write(`  ${step.id.padEnd(10)} ${step.run} ... `)
    const started = Date.now()
    const { ok, output } = runStep(step.run)
    const seconds = ((Date.now() - started) / 1_000).toFixed(1)
    line(ok ? `ok (${seconds}s)` : `FAIL (${seconds}s)`)
    if (!ok) {
      failed = true
      line()
      line(`  why this step exists: ${step.why}`)
      const files = attribute(output)
      if (files.length > 0) {
        line('  files named by the failure:')
        for (const file of files) line(`    ${file}`)
        line(
          '  (attribution only — the gate fails on these whoever wrote them; see the ruling ' +
            'in web/lib/releaseGate.ts)',
        )
      }
      line()
      line(output.trimEnd())
      line()
      // The remaining steps still run: one report naming every problem beats
      // five runs each naming one.
    }
  }

  line()
  line('declared open cells')
  line('-------------------')
  let expired = false
  for (const verdict of judgeOpenCells(readHead)) {
    line(`  ${verdict.expired ? 'EXPIRED' : 'open   '} ${verdict.cell.id}: ${verdict.cell.what}`)
    line(`          ${verdict.detail}`)
    if (verdict.expired) expired = true
  }
  if (judgeOpenCells(readHead).length === 0) line('  (none)')

  line()
  if (failed) {
    line('VERDICT: do not release — a gate step failed.')
    return 1
  }
  if (expired) {
    line('VERDICT: do not release — an allowance outlived its reason.')
    return 3
  }
  line('VERDICT: green.')
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(
    `FAIL release gate crashed: ${error instanceof Error ? error.stack : String(error)}\n`,
  )
  process.exitCode = 1
}
