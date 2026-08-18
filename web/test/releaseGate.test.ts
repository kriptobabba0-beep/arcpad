import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertNoEscapeHatch,
  ESCAPE_HATCH,
  EscapeHatchPresent,
  GATE_STEPS,
  judgeOpenCells,
  type OpenCell,
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
      /*
       * SINIR GIRINTIDIR, "en az iki bosluk" DEGIL.
       *
       * OLCULDU (2026-08-18): bu dal bugune kadar HIC KOSMAMISTI -- node.yml'de
       * `run: |` sayisi sifirdi, yani burasi olu koddu. Ilk blok eklendigi anda
       * cikarici 31 komut yerine 402 topladi, 158'i yorum: eski kural sonraki
       * ISIN BASLIGINDA durmuyordu, cunku `  b:` de "en az iki bosluk"
       * girintilidir. Govde, `run:`in KENDI girintisinden fazla girintili
       * satirlardir -- YAML bunu boyle tanimlar.
       *
       * IKINCI KOPYA: ayni cikarici `packages/shared/test/abi-parity.test.ts`
       * icinde de durur ve ayni gun ayni kusurla kirildi. Birini degistiren
       * otekini de degistirmeli.
       */
      const runIndent = (/^(\s*)/.exec(line)?.[1] ?? '').length
      for (let j = i + 1; j < lines.length; j += 1) {
        const body = lines[j] ?? ''
        if (body.trim() === '') continue
        const indent = (/^(\s*)/.exec(body)?.[1] ?? '').length
        if (indent <= runIndent) break
        // Bir yorum komut DEGILDIR. Govdedeki `#` satirlarini komut saymak,
        // "bu adim gercekten X kosuyor mu" sorusunu bir metin aramasina
        // indirger -- ve asagidaki mutant kontrolu tam da onu reddediyor.
        if (body.trim().startsWith('#')) continue
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

/**
 * ============================================================================
 *  UC KAPI, UC AYRI AD -- YOKSA DAL KORUMASI SAHTE OLUR
 * ============================================================================
 *
 * OLCULDU (2026-08-18): uc is akisinin toplayici isi de `gate` adiniyordu, ve
 * GitHub check adini o addan turetir. Ayni commit uzerinde `gate` adli IKI
 * check goruldu. Zorunlu check olarak `gate` secilseydi, hangi is akisinin
 * kapisinin beklendigi belirsiz kalirdi -- ve "bir tanesi gecti" yeterli
 * sayilabilirdi. Kapi gibi gorunen ama kapi olmayan bir sey.
 *
 * Adlar bu yuzden benzersiz. Test onlari SABIT tutar: biri geri degistirilirse
 * koruma sessizce zayiflardi, ve sessizce zayiflayan bir koruma bu deponun
 * tekrar tekrar odedigi seydir.
 */
describe('her is akisinin kapisi BENZERSIZ bir ad tasir', () => {
  const GATES: readonly (readonly [string, string])[] = [
    ['node.yml', 'node-gate'],
    ['contracts.yml', 'contracts-gate'],
    ['slither.yml', 'static-analysis-gate'],
  ]

  it('uc kapi da beklenen adi tasir', () => {
    for (const [file, name] of GATES) {
      const text = readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8')
      expect(text, `${file} bir \`gate\` isi tasimali`).toMatch(/^ {2}gate:$/m)
      expect(text, `${file} kapisinin adi "${name}" olmali`).toContain(`name: ${name}`)
    }
  })

  it('adlar birbirinden FARKLI -- ayirt edici kontrol', () => {
    // Uc dosya da ayni adi tasisaydi ustteki test yine gecerdi; ayirt eden sey
    // budur.
    const names = GATES.map(([, name]) => name)
    expect(new Set(names).size, 'iki kapi ayni adi tasiyor').toBe(names.length)
  })

  it('kapi `if: always()` olmadan bir kapi DEGILDIR', () => {
    // Bu satir olmasa is akisi atlandiginda kapi da atlanir ve zorunlu check
    // hic rapor vermezdi -- yani PR sonsuza kadar beklerdi.
    for (const [file] of GATES) {
      const text = readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8')
      expect(text, `${file} kapisi kosulsuz kosmali`).toContain('if: always()')
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

  /*
   * ==========================================================================
   *  BLOK `run:` DALI, ILK KEZ GERCEKTEN KOSUYOR
   * ==========================================================================
   *
   * OLCULDU (2026-08-18): bu is akisinda `run: |` HIC YOKTU -- sayisi sifirdi.
   * Yani `runCommands`in cok satirli dali OLU KODDU ve kusuru gorunmuyordu:
   * govdenin nerede bittigini GIRINTIYLE degil, "en az iki bosluk" kuralyla
   * ariyordu, ve YAML'de sonraki isin basligi da en az iki bosluk girintilidir.
   * Ilk blok eklendigi anda cikarici 31 komut yerine 402 topladi, 158'i yorum.
   *
   * Bu, bu deponun tekrar tekrar odedigi sinifin ta kendisi: tamamlanmis,
   * kapili ve HIC CAGRILMAYAN bir katman. Asagidaki uc test o dali uretim
   * verisiyle surer, ki bir daha sessizce cürümesin.
   */
  it('BLOK dali gercekten kosar ve govdeden komut cikarir', () => {
    const commands = runCommands(workflow())
    // `gate` isinin govdesinden gelen gercek bir komut. Blok dali hic
    // calismasaydi bu satir listede OLMAZDI.
    expect(commands, 'blok `run:` govdesi hic okunmamis').toContain('set -eu')
  })

  it('govde SONRAKI ISE TASMAZ -- sinir girintidir, "iki bosluk" degil', () => {
    const yaml = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: |',
      '          echo icerde',
      '  b:',
      '    steps:',
      '      - run: echo disarda',
    ].join('\n')
    const commands = runCommands(yaml)
    expect(commands).toContain('echo icerde')
    // AYIRT EDICI: eski surum burada `b:` ve `steps:` satirlarini da komut
    // sanardi, cunku ikisi de iki bosluktan fazla girintili.
    expect(commands, 'govde sonraki ise tasti').not.toContain('b:')
    expect(commands).not.toContain('steps:')
    expect(commands).toContain('echo disarda')
  })

  it('govdedeki shell yorumu KOMUT DEGILDIR', () => {
    const yaml = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: |',
      '          # bir yorum',
      '          echo ger',
    ].join('\n')
    const commands = runCommands(yaml)
    expect(commands).toContain('echo ger')
    expect(
      commands.some((c) => c.startsWith('#')),
      'yorum komut sayildi',
    ).toBe(false)
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
  /**
   * THE LIST IS EMPTY TODAY, SO THE MECHANISM IS TESTED AGAINST A SYNTHETIC
   * CELL RATHER THAN AGAINST THE LIST.
   *
   * `search-503` was the only entry and it EXPIRED for real when `c035a88`
   * committed `searchTokens`; the gate said so, the route was wired and the
   * cell was deleted. Rewriting these tests to iterate `OPEN_CELLS` would have
   * made all three pass vacuously the moment the list emptied -- the exact
   * shape of the completeness check that was vacuous for one action earlier in
   * this project. So the reader is the input, and the cell is a fixture.
   */
  const cell = (): OpenCell => ({
    id: 'fixture',
    what: 'a thing that is missing',
    why: 'a stated reason long enough to be a reason and not a shrug, with a named owner',
    witness: 'packages/db/src/index.ts',
    closedBy: (headContent) => /\bsearchTokens\b/.test(headContent),
  })

  it('a cell stays open while its reason holds, and EXPIRES when it stops', () => {
    const open = judgeOpenCells(() => 'export { listTokens } from "./queries"', [cell()])
    expect(open.every((verdict) => !verdict.expired)).toBe(true)

    // THE HALF THAT MATTERS: the day the witness satisfies the closing
    // condition, the allowance must stop being granted.
    const closed = judgeOpenCells(
      () => 'export { listTokens, searchTokens } from "./queries"',
      [cell()],
    )
    expect(closed.some((verdict) => verdict.expired)).toBe(true)
  })

  it('an unreadable witness EXPIRES the cell rather than granting it', () => {
    // A witness that moved is a reason nobody can check, and an allowance
    // nobody can check is the thing this mechanism exists to prevent.
    const gone = judgeOpenCells(() => null, [cell()])
    expect(gone.every((verdict) => verdict.expired)).toBe(true)
  })

  it('every DECLARED cell names a witness that exists at HEAD, and states a reason', () => {
    // Vacuous while the list is empty, and deliberately kept: the day a cell is
    // added, a typo in its witness must be caught here rather than reported as
    // an expiry for the wrong reason.
    for (const entry of OPEN_CELLS) {
      expect(entry.why.length, `${entry.id} is granted without a reason`).toBeGreaterThan(80)
      const content = execFileSync('git', ['show', `HEAD:${entry.witness}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      expect(content.length, `${entry.witness} is empty at HEAD`).toBeGreaterThan(0)
    }
  })

  it('the search stub is GONE, and the route reads the real query', () => {
    /*
     * THE CELL'S CLOSURE, ASSERTED AS CODE RATHER THAN AS A DELETED COMMENT.
     *
     * Deleting an allowance is only honest if the thing it excused is actually
     * gone. `components/search/searchBoundary.ts` returned `unavailable` for
     * every query; both halves are checked, because a route that still
     * imported a deleted module would not compile but a route that imported a
     * NEW stub would.
     */
    expect(existsSync(join(process.cwd(), 'components/search/searchBoundary.ts'))).toBe(false)
    const route = readFileSync(join(process.cwd(), 'app/api/search/route.ts'), 'utf8')
    expect(route).toContain("from '@/lib/read'")
    const read = readFileSync(join(process.cwd(), 'lib/read.ts'), 'utf8')
    expect(read).toContain('searchTokens')

    /*
     * THE CURSOR CHECK LIVES IN `test/search/route.test.tsx`, NOT HERE, AND
     * THE FIRST ATTEMPT IS WHY.
     *
     * This test originally asserted that `lib/read.ts` contains no
     * `Number(cursor)`. It failed -- on the DOC COMMENT four lines above the
     * code, which explains why `Number(cursor)` is wrong. A source-text scan
     * that cannot tell prose from code is the same defect as the CI gate that
     * matched a comment, committed by the person who wrote the test warning
     * about it. The property is behavioural, so it is measured behaviourally:
     * a 38-digit cursor survives the URL round trip and a 98-digit one does
     * not.
     */
  })
})
