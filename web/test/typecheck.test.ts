import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * ==========================================================================
 *  VITEST YESILKEN `tsc` KIRMIZI OLAMAZ -- ARTIK.
 * ==========================================================================
 *
 * VITEST TIP DENETLEMEZ. esbuild ile ceviri yapar ve tipleri ATAR; bir
 * fixture, uydugunu iddia ettigi tipten AYRISABILIR ve 664 testin hepsi yesil
 * kalir. Bu varsayimsal degil, OLCULDU: `fe98203`'te HEAD'de
 * `npx tsc -p web --noEmit` ON DORT hata veriyordu -- `TradeRow`'un iki rezerv
 * alani bir fixture'da hic yoktu, bir birlesim daraltilmadan okunuyordu, bir
 * `Log[]` makbuzun `Log<bigint, number, false>[]`'ine atanamiyordu ve bir e2e
 * karsilastirmasi hicbir zaman dogru olamazdi (TS2367) -- ve
 * `pnpm --filter @arcpad/web test` ayni anda 44 dosya / 664 test YESIL diyordu.
 * Iki cumle de dogruydu. Bunu gorunur kilan hicbir sey yoktu.
 *
 * Bu onemsiz bir duzenlilik meselesi degil: `lib/releaseGate.ts` bir surumun
 * DEPO GENELINDE typecheck hatasi olmadan gecmesi gerektigine hukmediyor ve
 * bunu track'e gore muaf tutmayi acikca reddediyor. Yani o on dort hata
 * dururken HEAD kendi surum kapisindan gecemiyordu -- ama bunu gormek icin
 * kapinin tamamini (fmt + lint + typecheck + test + build) kosmak gerekiyordu.
 *
 * BU DOSYA IDDIA ETMIYOR, DERLEYICIYI KOSUYOR. `test/read-types.test.ts` ve
 * `test/balance.test.ts` ayni bicimde: bir derleme-zamani ya da lint-zamani
 * iddiasi, araci CALISTIRMADAN once hicbir sey degildir.
 *
 * MALIYET, OLCULDU: bu makinede tam (artimsiz olmayan) bir kosu ~11 sn.
 * `--incremental false` BILEREK: `web/tsconfig.tsbuildinfo` paylasilan bir
 * dosya ve baska bir surec (next build, editor) onu ayni anda yazabilir;
 * bayat ya da yaris halindeki bir tsbuildinfo'nun verecegi cevap "temiz"
 * olurdu, ve sessizce yesile donen bir kapi hic olmayan kapidan beterdir.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
const REPO_ROOT = join(WEB, '..')
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
/** `web/tsconfig.json`'in `exclude`'unda: kontrol dosyasi GERCEK kosuya girmez. */
const CONTROL_DIR = join(HERE, '.typecheck')

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

type Diagnostic = { readonly file: string; readonly line: number; readonly code: string }

/** `path/to/file.ts(12,34): error TS2322: ...` -- devam satirlari girintilidir. */
const DIAGNOSTIC = /^(.+?)\((\d+),\d+\): error (TS\d+):/

function parse(output: string): Diagnostic[] {
  return output
    .split(/\r?\n/)
    .map((line) => DIAGNOSTIC.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      file: (match[1] ?? '').replace(/\\/g, '/'),
      line: Number(match[2]),
      code: match[3] ?? '',
    }))
}

function runTsc(args: readonly string[]): { exitCode: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [TSC, ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    return { exitCode: 0, output: stdout }
  } catch (error) {
    // tsc, TANI URETTIGINDE cikis kodunu sifirdan farkli yapar -- bu dosyanin
    // gozlemek icin var oldugu durum. Tanilar hala stdout'ta.
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { exitCode: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** Kapinin kendisi. `pnpm --filter @arcpad/web typecheck` ile AYNI cagri. */
function typecheckWeb(): { exitCode: number; output: string } {
  return runTsc(['--project', WEB, '--noEmit', '--incremental', 'false', '--pretty', 'false'])
}

function attribute(diagnostics: readonly Diagnostic[]): string {
  const byFile = new Map<string, Diagnostic[]>()
  for (const d of diagnostics) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d])
  return [...byFile]
    .map(([file, list]) => `  ${file}: ${list.map((d) => `${d.line} ${d.code}`).join(', ')}`)
    .join('\n')
}

describe('the web project typechecks, and the suite REFUSES to be green without it', () => {
  it('`tsc --project web --noEmit` reports NOTHING', () => {
    const { exitCode, output } = typecheckWeb()
    const diagnostics = parse(output)
    // Once dosya bazinda atfet: kirmizi bir kapi, yalnizca kirmizi degil
    // UYGULANABILIR olmali (`lib/releaseGate.ts`'in ayni gerekcesi).
    expect(attribute(diagnostics)).toBe('')
    expect(diagnostics).toEqual([])
    expect(exitCode, `tsc cikis kodu ${exitCode}:\n${output}`).toBe(0)
  })

  /**
   * KAPSAM IDDIASI -- VE VACUITY'NIN KAPANDIGI YER.
   *
   * On dort hatanin hepsi `web/test/` ve `web/e2e/` icindeydi. Bu iki agaci
   * `include`'dan dusuren ya da `exclude`'a ekleyen bir tsconfig degisikligi,
   * yukaridaki testi SONSUZA KADAR yesil yapardi ve hicbir sey ses cikarmazdi.
   * `--showConfig` cozulmus dosya listesini basar; iddia o listenin uzerinde.
   */
  it('the checked file set INCLUDES web/test and web/e2e', () => {
    const { exitCode, output } = runTsc(['--project', WEB, '--showConfig'])
    expect(exitCode).toBe(0)
    const config = JSON.parse(output) as { files?: string[] }
    const files = (config.files ?? []).map((f) => f.replace(/\\/g, '/'))

    expect(files).toContain('./test/fixtures/readModel.ts')
    expect(files).toContain('./e2e/arc/two-view-balance.spec.ts')
    expect(files).toContain('./test/trade/receipt.test.ts')
    // Tek tek dosya adlari yeniden adlandirilabilir; agaclarin KENDISI de
    // sayilir, boylece "hepsini disla" biciminde bir degisiklik de duser.
    expect(files.filter((f) => f.startsWith('./test/')).length).toBeGreaterThan(20)
    expect(files.filter((f) => f.startsWith('./e2e/')).length).toBeGreaterThan(3)
  })

  /**
   * CONTROL. Bu olmadan bozuk bir kosum (yanlis tsc yolu, cozulmeyen proje,
   * yutulan cikis kodu) yukaridaki iddialari da tatmin ederdi ve kapi hicbir
   * sey olcmezdi -- `read-types.test.ts` ve `balance.test.ts` ayni nedenle
   * kendi kontrollerini tasiyor.
   *
   * Kontrol vakasi, KACAN HATANIN SINIFI: uydugunu iddia ettigi tipten zorunlu
   * bir alani eksik birakan bir fixture. Web projesinin `exclude`'unda duran
   * ayri bir dizinde derlenir, yani gercek kosuya asla karismaz.
   *
   * KOD SABITLENMIYOR, SINIF SABITLENIYOR: ayni kusur TS'te iki ad tasiyor --
   * kacan hata `TradeRow` (bir takma ad) icin TS2322 idi, buradaki dogrudan
   * nesne degismezi icin TS2741. Tek bir koda kilitlenen bir kontrol, TS bir
   * surumde digerini secmeye basladiginda SESSIZCE vacuous olurdu; iddia bu
   * yuzden EKSIK ALANIN ADI uzerinde.
   */
  it('CONTROL: the runner turns RED on the exact defect that escaped', () => {
    const { exitCode, output } = runTsc([
      '--project',
      CONTROL_DIR,
      '--noEmit',
      '--incremental',
      'false',
      '--pretty',
      'false',
    ])
    const diagnostics = parse(output)
    expect(exitCode).not.toBe(0)
    const MISSING_PROPERTY = ['TS2322', 'TS2741']
    expect(diagnostics.filter((d) => MISSING_PROPERTY.includes(d.code)).length).toBeGreaterThan(0)
    expect(diagnostics[0]?.file).toMatch(/drifted-fixture\.ts$/)
    // Kusurun KENDISI: eksik olan alanin adi tanida geciyor.
    expect(output).toContain('realQuoteReservesWei')
  })
})

beforeAll(() => {
  mkdirSync(CONTROL_DIR, { recursive: true })
  writeFileSync(
    join(CONTROL_DIR, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../../tsconfig.base.json',
        compilerOptions: { noEmit: true },
        include: ['*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(
    join(CONTROL_DIR, 'drifted-fixture.ts'),
    [
      '// `realQuoteReservesWei` eksik -- kacan hatanin ayni sekli (TS2322).',
      'type Row = { readonly quoteAmountWei: bigint; readonly realQuoteReservesWei: bigint }',
      'export const ROW: Row = { quoteAmountWei: 987_654_320_987_654_320n }',
      '',
    ].join('\n'),
    'utf8',
  )
})

afterAll(() => {
  rmSync(CONTROL_DIR, { recursive: true, force: true })
})
