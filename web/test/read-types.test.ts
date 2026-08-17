import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * "IMPOSSIBLE TO READ A VALUE WITHOUT LEARNING ITS FRESHNESS" IS A COMPILE-TIME
 * CLAIM, so it is checked by running the compiler.
 *
 * Lagging-but-present is the dangerous state: absent data draws an honest box,
 * while a four-minute-old price rendered as live looks perfect and costs the
 * user money. A `stale: boolean` sitting next to `data` does not prevent that
 * -- `const { data } = result` compiles and reads like correct code. So the
 * stale branch carries `staleData` instead, and `result.data` simply does not
 * exist until the caller has narrowed.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK_DIR = join(HERE, '.readtypes')
const REPO_ROOT = join(HERE, '..', '..')
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

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
  writeFileSync(
    join(WORK_DIR, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../../tsconfig.base.json',
        compilerOptions: { noEmit: true, skipLibCheck: true },
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

// Declared locally rather than imported: importing `../lib/read` would pull in
// `@arcpad/db` and `pg`, and this gate is about the SHAPE, which is reproduced
// here exactly. `read.test.ts` covers the runtime half against the real type.
const SHAPE = `type IndexerStatus = { stale: boolean; stalenessSeconds: number | null }
type ReadResult<T> =
  | { readonly ok: true; readonly stale: false; readonly data: T; readonly indexer: IndexerStatus }
  | { readonly ok: true; readonly stale: true; readonly staleData: T; readonly indexer: IndexerStatus }
  | { readonly ok: false; readonly reason: 'unavailable' | 'notFound'; readonly indexer: IndexerStatus | null }
declare const result: ReadResult<number[]>
`

describe('a value cannot be read without learning its freshness', () => {
  // CONTROL. Without it, a broken harness (bad tsc path, bad tsconfig) would
  // satisfy every "does not compile" case below and mean nothing.
  it('CONTROL: narrowing BOTH ok and stale compiles clean', () => {
    const result = compile(
      'control',
      `${SHAPE}
export const rows = result.ok ? (result.stale ? result.staleData : result.data) : []
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })

  it('reading `.data` after narrowing ONLY `ok` does not compile', () => {
    const result = compile(
      'okonly',
      `${SHAPE}
export const rows = result.ok ? result.data : []
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('2339') // Property 'data' does not exist
    expect(result.output).toContain('data')
  })

  it('destructuring `data` off the result does not compile either', () => {
    // The exact shape the obvious design permits: `const { data } = result`
    // compiles when `stale` is a sibling boolean, and it is invisible in review.
    const result = compile(
      'destructure',
      `${SHAPE}
const { data } = result as Extract<ReadResult<number[]>, { ok: true }>
export const rows = data
`,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('2339')
  })

  /**
   * THE MEASUREMENT THAT PICKED THE DESIGN. With `stale` as a sibling boolean,
   * ignoring it compiles CLEAN -- which is why that shape was rejected. If a
   * future TypeScript starts rejecting it, the comment in `read.ts` explaining
   * the choice has become false and should be rewritten, not deleted.
   */
  it('records WHY: a sibling `stale` boolean lets the value be read regardless', () => {
    const result = compile(
      'sibling',
      `type IndexerStatus = { stale: boolean }
type Naive<T> =
  | { ok: true; stale: boolean; data: T; indexer: IndexerStatus }
  | { ok: false; reason: 'unavailable' }
declare const r: Naive<number[]>
export const rows = r.ok ? r.data : []
`,
    )
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  })

  it('the failure branch carries no value at all', () => {
    const result = compile(
      'failure',
      `${SHAPE}
export const rows = !result.ok ? result.staleData : []
`,
    )
    expect(result.exitCode).not.toBe(0)
  })
})
