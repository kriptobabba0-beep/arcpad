import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * ==========================================================================
 *  BESLENEMEYEN BIR DAL DUSEMEZ.
 * ==========================================================================
 *
 * OLCUM (2026-08-09). `resolveLifecycle`in ucuncu dali -- `graduated` --
 * `components/token/lifecycle.ts` icinde vardi, `LifecycleNotice` onu
 * ciziyordu, ve `test/token/token-page.test.tsx` elle kurdugu bir nesne ile
 * `{complete:true, graduated:true}` gecirip "Graduated" gordugu icin YESILDI.
 * Ayni anda `app/token/[address]/page.tsx` soyle cagiriyordu:
 *
 *     resolveLifecycle({ complete: overview.complete })
 *
 * `overview.graduated` HIC OKUNMUYORDU -- oysa `packages/db/src/queries.ts`
 * satiri onu tasiyor ve NatSpec'i `complete` ile `graduated`in neden ayri
 * durumlar oldugunu ozellikle anlatiyor. Yani mezun olan ilk token, arkasinda
 * canli bir havuzla, sonsuza kadar "Curve complete" cizilecekti ve HICBIR test
 * kirmizi olmayacakti. Bu deponun en sik kusuru, bir kez daha: bir ozelligin
 * BILESEN uzerinde kapatilmasi, onun GIRIS NOKTASINDA kapatildigi anlamina
 * gelmez.
 *
 * BU DOSYA IKI FARKLI SEYI OLCER, VE IKISI DE GEREKLI:
 *
 *   1. ALANI ATLAMAK DERLENMEZ. `graduated` artik zorunlu bir parametre.
 *      Iddia edilmiyor, `tsc` KOSTURULUYOR (`typecheck.test.ts` ile ayni
 *      bicim), cunku bir derleme-zamani iddiasi araci calistirmadan hicbir
 *      seydir.
 *
 *   2. CAGRI YERLERI GERCEK BIR ALAN BESLIYOR. Tip, `graduated: false` yazip
 *      gecmeyi de kabul eder -- yani (1) tek basina ayni sessiz ekrani geri
 *      getirebilir, yalnizca daha gorunur bir satirla. Kaynak taramasi her
 *      cagri yerinin bir DEGER okudugunu ister, sabit degil.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')
const REPO_ROOT = join(WEB, '..')
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
/** `web/tsconfig.json`'in `exclude`'unda: kasitli hata GERCEK kosuya girmez. */
const CONTROL_DIR = join(HERE, '..', '.lifecycle')

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

/** `resolveLifecycle({ ... })` cagrisinin ARGUMAN metnini cikarir. */
export function callArguments(source: string, callee: string): string[] {
  const found: string[] = []
  const needle = `${callee}(`
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at === -1) break
    let depth = 0
    let i = at + needle.length - 1
    for (; i < source.length; i += 1) {
      const c = source[i]
      if (c === '(') depth += 1
      else if (c === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    found.push(source.slice(at + needle.length, i))
    from = i
  }
  return found
}

const CALL_SITES = [
  'app/token/[address]/page.tsx',
  // Yeni bir cagri yeri eklenirse BURAYA da eklenmeli; asagidaki kapi, taranan
  // dosyalarda bulunan cagri SAYISINI da olcer, yani sessizce eksilemez.
] as const

describe('the lifecycle branches are FED, not merely implemented', () => {
  it('every resolveLifecycle call site passes a READ value for graduated', () => {
    let calls = 0
    for (const relative of CALL_SITES) {
      const source = readFileSync(join(WEB, relative), 'utf8')
      const args = callArguments(source, 'resolveLifecycle')
      expect(args.length, `${relative} calls resolveLifecycle nowhere`).toBeGreaterThan(0)
      for (const arg of args) {
        expect(arg, `${relative}: a call omits graduated`).toMatch(/\bgraduated\s*:/)
        /*
         * VE SABIT DEGIL. `graduated: false` derlenir ve dali tam olarak eskisi
         * gibi olu birakir -- tipin kapatamadigi delik budur. Deger bir alan
         * okumasi olmali (`overview.graduated`, `chain.graduated`, ...).
         */
        const value = /\bgraduated\s*:\s*([^,\n}]+)/.exec(arg)?.[1]?.trim() ?? ''
        expect(value, `${relative}: graduated is hardcoded as ${value}`).not.toMatch(
          /^(true|false)$/,
        )
        expect(value, `${relative}: graduated must read a field`).toMatch(/\.graduated$/)
        calls += 1
      }
    }
    // ANTI-VACUITY: sayfanin IKI dali var (indexer satiri ve zincirden cizim).
    // Biri silinirse ya da tarama bozulursa bu duser.
    expect(calls, 'both page branches must resolve a lifecycle').toBe(2)
  })

  it('the chain-drawn branch actually READS graduated() from the curve', () => {
    // `chain.graduated` bir alan okumasi olabilir ve alan yine de sabit
    // doldurulmus olabilir. `readChainToken` onu multicall'da ISTEMELIDIR.
    const source = readFileSync(join(WEB, 'lib', 'chainToken.ts'), 'utf8')
    const batches = callArguments(source, 'publicClient.multicall')
    // IKI toplu cagri var (token, sonra curve) ve DOGRU olani secilmeli: ilkini
    // almak bu kapiyi sessizce vacuous yapardi -- ilk denemede tam olarak oyle
    // oldu ve `LaunchToken` okumalarina bakip "graduated yok" dedi.
    expect(batches.length, 'chainToken.ts no longer batches its reads').toBe(2)
    const curveBatch = batches.filter((batch) => batch.includes('bondingCurveAbi'))
    expect(curveBatch, 'exactly one batch reads the curve').toHaveLength(1)
    expect(curveBatch[0], 'graduated() is not among the curve reads').toContain("'graduated'")
    expect(curveBatch[0], 'complete() must still be read too').toContain("'complete'")
  })

  it('CONTROL: omitting graduated is a COMPILE ERROR, and the class is TS2345', () => {
    const { exitCode, output } = runTsc()
    expect(exitCode, `tsc accepted a call with no graduated:\n${output}`).not.toBe(0)
    expect(output).toContain('TS2345')
    expect(output).toContain("Property 'graduated' is missing")
    // Ve kontrol dosyasinin KENDISI hakkinda -- baska bir dosyanin hatasini
    // saymak, kapiyi baskasinin kusuruna baglardi.
    expect(output).toMatch(/omits-graduated\.ts\(\d+,\d+\): error TS2345/)
  })

  it('CONTROL: the same call WITH graduated compiles clean', () => {
    // Kontrolun kendi kontrolu: yukaridaki kirmizi, `resolveLifecycle`in hic
    // cozulmemesi gibi bir sebepten de gelebilirdi. Bu vaka onu eler.
    writeControl({ omit: false })
    const { exitCode, output } = runTsc()
    expect(exitCode, output).toBe(0)
    writeControl({ omit: true })
  })
})

function runTsc(): { exitCode: number; output: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [TSC, '--project', CONTROL_DIR, '--noEmit', '--incremental', 'false', '--pretty', 'false'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    )
    return { exitCode: 0, output: stdout }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { exitCode: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function writeControl({ omit }: { omit: boolean }): void {
  writeFileSync(
    join(CONTROL_DIR, 'omits-graduated.ts'),
    [
      "import { resolveLifecycle } from '../../components/token/lifecycle'",
      `export const L = resolveLifecycle({ complete: true${omit ? '' : ', graduated: false'} })`,
      '',
    ].join('\n'),
    'utf8',
  )
}

beforeAll(() => {
  mkdirSync(CONTROL_DIR, { recursive: true })
  writeFileSync(
    join(CONTROL_DIR, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../../tsconfig.base.json',
        compilerOptions: { noEmit: true },
        include: ['*.ts', '../../components/token/lifecycle.ts'],
      },
      null,
      2,
    ),
    'utf8',
  )
  writeControl({ omit: true })
})

afterAll(() => {
  rmSync(CONTROL_DIR, { recursive: true, force: true })
})
