/**
 * THE RELEASE GATE'S RULES, SEPARATED FROM ITS SHELL.
 *
 * `scripts/release-gate.ts` spawns processes; this file decides WHAT must run,
 * WHAT is allowed to be missing, and WHEN an allowance has expired. That split
 * exists so the rules can be tested without a four-minute build, and so the
 * tests cannot accidentally re-enter the gate.
 *
 * =========================================================================
 *  THE RULING: THE GATE FAILS ON ERRORS OUTSIDE THE RELEASING TRACK'S FILES.
 * =========================================================================
 *
 * The question came up because three tracks share this checkout and each one
 * leaves type or lint errors in files it owns. The answer is yes, and for four
 * reasons, in order of weight:
 *
 *   1. A RELEASE SHIPS THE REPOSITORY, NOT A DIFF. `pnpm -r typecheck` is what
 *      CI runs and what a `next build` reproduces; a gate scoped to one
 *      track's files would report green for a tree that CI reports red on. A
 *      gate whose verdict disagrees with the thing being shipped is measuring
 *      something nobody ships.
 *
 *   2. "WHOSE FILE IS IT" IS NOT A PROPERTY THE TOOLCHAIN CAN SEE. Every
 *      implementation of that filter -- a path allowlist, git blame, the
 *      changed-file set -- is a SECOND source of truth that drifts from the
 *      first. The gate's integrity comes from having one authority.
 *
 *   3. IT IS THE EXACT SHAPE THIS PROJECT HAS ALREADY BEEN BITTEN BY TWICE: a
 *      CI gate that matched a COMMENT rather than a `run:` line and so survived
 *      its command being replaced with `true`, and a completeness check that
 *      iterated a subset and was vacuous for one action. A per-track filter is
 *      that shape -- coverage that depends on a list nobody re-derives.
 *
 *   4. THE COST IS BOUNDED AND CORRECTLY PLACED. A dozen type errors in three
 *      test files is a short fix for whoever wrote them, and a gate that NAMES
 *      them is how that fix gets scheduled instead of inherited.
 *
 * What the gate does instead of exempting them is ATTRIBUTE them: the report
 * prints which package and which files failed, so a red gate is actionable
 * rather than merely red. Attribution never changes the verdict.
 *
 * The one concession is in the other direction and it is deliberate: the
 * end-to-end harness may set `ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK` so that a
 * browser leg can exist while another track's test file is mid-flight. THIS
 * GATE REFUSES TO RUN AT ALL when that variable is present -- the browser leg
 * tolerates, the release gate does not.
 */

export const ESCAPE_HATCH = 'ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK'

export class EscapeHatchPresent extends Error {
  constructor(value: string) {
    super(
      `${ESCAPE_HATCH}=${value} is set. That variable exists so the end-to-end ` +
        'harness can build a server while another track is mid-flight; a release ' +
        'gate that honoured it would be certifying a build whose type errors were ' +
        'stepped over. Unset it and run again.',
    )
    this.name = 'EscapeHatchPresent'
  }
}

/**
 * REFUSES ON PRESENCE, NOT ON TRUTHINESS.
 *
 * `ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK=0` still means somebody's shell is shaped
 * like the harness's, and the harness sets it to `'1'`. An empty string is the
 * one exception because that is how a parent process CLEARS a variable it
 * inherited (`{ ...env, VAR: '' }`), which is exactly what the harness does
 * for `DATABASE_URL`.
 */
export function assertNoEscapeHatch(env: Record<string, string | undefined>): void {
  const value = env[ESCAPE_HATCH]
  if (value === undefined || value === '') return
  throw new EscapeHatchPresent(value)
}

export type GateStep = {
  /** Stable id. `REQUIRED_STEPS` is written in terms of these. */
  readonly id: string
  /** The pnpm script invocation, exactly as a human would type it. */
  readonly run: string
  /** Why a release is not allowed to proceed without it. */
  readonly why: string
}

/**
 * WHAT A RELEASE MUST SURVIVE, IN ORDER.
 *
 * The order is not cosmetic: the cheap, fast refusals come first so that a
 * formatting slip does not cost a four-minute build to discover, and the build
 * runs last because it is the only step that consumes the others' output.
 */
export const GATE_STEPS: readonly GateStep[] = [
  {
    id: 'format',
    run: 'pnpm run fmt:check',
    why: 'A formatting diff in a release commit hides the real change in review.',
  },
  {
    id: 'lint',
    run: 'pnpm run lint',
    why:
      'The `useBalance` seam is a LINT rule, not a type. Skipping lint would let a ' +
      'second balance read into `web/` and there is no runtime check that can see a ' +
      '1e12 error on Arc.',
  },
  {
    id: 'typecheck',
    run: 'pnpm -r typecheck',
    why:
      'Repository-wide, deliberately. See the ruling at the top of this file: a gate ' +
      'scoped to one track reports green for a tree CI reports red on.',
  },
  {
    id: 'test',
    run: 'pnpm --filter @arcpad/web test',
    why: 'The unit and component suites. Fast, and they carry the arithmetic claims.',
  },
  {
    id: 'build',
    run: 'pnpm --filter @arcpad/web build',
    why:
      'The artefact itself. It type-checks the whole tsconfig project a second time, ' +
      'and it is the step the escape hatch was invented to weaken — which is why this ' +
      'gate refuses to run with the hatch set.',
  },
]

/**
 * The set a gate MUST contain, written independently of what it does contain.
 *
 * ITERATING `GATE_STEPS` TO CHECK `GATE_STEPS` IS THE VACUOUS SHAPE. A
 * completeness check earlier in this project iterated the declared subset and
 * was therefore satisfied for an action it never covered. This list is the
 * requirement; the one above is the implementation; the test compares them in
 * the direction that can fail.
 */
export const REQUIRED_STEPS = ['format', 'lint', 'typecheck', 'test', 'build'] as const

export type OpenCell = {
  readonly id: string
  /** What is missing, in one line. */
  readonly what: string
  /** Why it is acceptable that it is missing TODAY. */
  readonly why: string
  /**
   * The file whose content at HEAD decides whether the reason still holds.
   *
   * AT HEAD, NOT IN THE WORKING TREE, and that distinction is the whole
   * mechanism. Another track's in-flight edit must NOT close a cell -- their
   * work is not shipped until it is committed, and a cell that closed on an
   * uncommitted file would demand wiring against an API that does not exist
   * for anyone else.
   */
  readonly witness: string
  /** True when the reason has EXPIRED and the cell must be closed. */
  closedBy(headContent: string): boolean
}

export const OPEN_CELLS: readonly OpenCell[] = [
  {
    id: 'search-503',
    what: '`/api/search` answers 503 for any text query; only the pasted-address path works.',
    why:
      'The text search needs `searchTokens` from `@arcpad/db` (pg_trgm, migration 008, ' +
      '`SORTS.relevance`) and that package belongs to another track. ' +
      '`web/components/search/searchBoundary.ts` returns `unavailable` on purpose: an ' +
      'empty result list would tell the user there is nothing to find, which is a ' +
      'different and false statement. The modal draws an explicit "search is ' +
      'unavailable" message.',
    witness: 'packages/db/src/index.ts',
    closedBy: (headContent) => /\bsearchTokens\b/.test(headContent),
  },
]

export type CellVerdict = {
  readonly cell: OpenCell
  readonly expired: boolean
  readonly detail: string
}

/**
 * Rules on every declared cell. A cell whose witness cannot be read is EXPIRED
 * -- a witness that has moved or been deleted is a reason nobody can check any
 * more, and an uncheckable allowance is the thing this mechanism exists to
 * prevent.
 */
export function judgeOpenCells(readHead: (path: string) => string | null): CellVerdict[] {
  return OPEN_CELLS.map((cell) => {
    const content = readHead(cell.witness)
    if (content === null) {
      return {
        cell,
        expired: true,
        detail:
          `the witness ${cell.witness} could not be read at HEAD, so the reason for this ` +
          'allowance can no longer be checked',
      }
    }
    const expired = cell.closedBy(content)
    return {
      cell,
      expired,
      detail: expired
        ? `${cell.witness} at HEAD now satisfies this cell's closing condition — wire it up ` +
          'and delete the cell'
        : 'still open for the stated reason',
    }
  })
}
