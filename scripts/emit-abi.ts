/**
 * ============================================================================
 *  DAGITILAN ABI'LERI DERLENMIS ARTIFACT'LERDEN YENIDEN URETIR
 * ============================================================================
 *
 * NICIN VAR. `packages/shared/src/abi/*.ts` dosyalarinin basinda "EMITTED
 * from the `forge build` artifact ... DO NOT hand-edit. Re-emit and let the
 * parity test judge the result." yaziyordu -- ama YENIDEN URETECEK BIR SEY
 * YOKTU. Talimat bir insana veriliyordu, ve olculdu ki insan onu kacirir:
 * buyback nesli `LaunchFactory`ye 20 ABI girdisi ekledi (`launchWithBuyback`,
 * `buybackPolicy`, `BuybackUnavailable`, ...) ve dagitilan kopya 51 girdide
 * kaldi. Parite kapisi bunu YAKALADI -- ama kapinin gorevi kusuru bulmaktir,
 * onarmak degil; onaracak arac yoksa kapi yalnizca kirmizi kalir.
 *
 * KAPININ YERINI ALMAZ, ONU BESLER. `packages/shared/test/abi-parity.test.ts`
 * hala TEK OTORITEDIR ve IKI YONDE karsilastirir. Bu betik yalnizca kapinin
 * kabul edecegi bicimi URETIR; dogru olup olmadigina yine kapi karar verir.
 *
 * `--check` MODU VARDI VE KALDIRILDI -- SEBEBI OLCULDU. Metin karsilastirmasi
 * yapiyordu, ama uretilen dosyalar sonradan `prettier`dan gecer (`pnpm run
 * fmt`). Sonuc: icerik DOGRUYKEN ve `test:abi` YESILKEN `--check` bes dosyayi
 * "ayrismis" ilan ediyordu. Ikinci ve DAHA ZAYIF bir dogruluk kaynagi, hicbir
 * kaynak olmamasindan kotudur: CI'da kalici kirmizi uretir ve insanlara
 * kirmiziyi yoksaymayi ogretir -- bu depoda iki kez olculmus bir ariza sekli.
 *
 * DOGRU KAPI TEKTIR:  pnpm --filter @arcpad/shared test:abi
 *
 * BICIM KAPIDAN KOPYALANMAZ, KAPIYLA AYNI OLMAK ZORUNDADIR. `normalise`in
 * yaptigi iki sey burada birebir tekrarlanir:
 *   1. `internalType` HER DERINLIKTE dusurulur (tuple bilesenlerinde de).
 *   2. Girdiler `(type-rank, name, input-types)` uclusune gore siralanir.
 * Ucuncu bir kural YOKTUR ve eklenmemelidir: iki taraf ayrisirsa kapi
 * kirmizi olur, ki dogrusu budur.
 *
 * KULLANIM:
 *   forge build --root contracts          # once artifact'ler
 *   pnpm tsx scripts/emit-abi.ts               # yazar
 *   pnpm run fmt                               # depo bicimine sokar
 *   pnpm --filter @arcpad/shared test:abi      # KAPI: dogru mu?
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Hangi artifact hangi dosyayi besler, ve `errorsOnly` NEDEN VAR.
 *
 * `CurveMath` bir kutuphanedir; dagitilan kopyasi YALNIZCA hata girdilerini
 * tasir cunku cozucunun ondan tek ihtiyaci selector'lardir. Parite testi de
 * ayni filtreyi uygular (`name === 'CurveMath' ? compiled.filter(...)`), yani
 * bu alan bir tercih degil O TESTIN AYNASIDIR.
 */
const TARGETS = [
  {
    artifact: 'contracts/out/LaunchFactory.sol/LaunchFactory.json',
    out: 'packages/shared/src/abi/launchFactory.ts',
    constName: 'launchFactoryAbi',
    errorsOnly: false,
  },
  {
    artifact: 'contracts/out/BondingCurve.sol/BondingCurve.json',
    out: 'packages/shared/src/abi/bondingCurve.ts',
    constName: 'bondingCurveAbi',
    errorsOnly: false,
  },
  {
    artifact: 'contracts/out/LaunchToken.sol/LaunchToken.json',
    out: 'packages/shared/src/abi/launchToken.ts',
    constName: 'launchTokenAbi',
    errorsOnly: false,
  },
  {
    artifact: 'contracts/out/FeeEscrow.sol/FeeEscrow.json',
    out: 'packages/shared/src/abi/feeEscrow.ts',
    constName: 'feeEscrowAbi',
    errorsOnly: false,
  },
  {
    artifact: 'contracts/out/BuybackTreasury.sol/BuybackTreasury.json',
    out: 'packages/shared/src/abi/buybackTreasury.ts',
    constName: 'buybackTreasuryAbi',
    errorsOnly: false,
  },
  {
    artifact: 'contracts/out/BuybackVestingVault.sol/BuybackVestingVault.json',
    out: 'packages/shared/src/abi/buybackVestingVault.ts',
    constName: 'buybackVestingVaultAbi',
    errorsOnly: false,
  },
  {
    artifact: 'contracts/out/CurveMath.sol/CurveMath.json',
    out: 'packages/shared/src/abi/curveMath.ts',
    constName: 'curveMathErrorsAbi',
    errorsOnly: true,
  },
] as const

type AbiEntry = { type: string; name?: string; inputs?: { type: string }[] }

/** `abi-parity.test.ts::stripInternalType` ile AYNI. */
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

/** `abi-parity.test.ts::rank` ile AYNI. */
const rank: Record<string, number> = {
  constructor: 0,
  receive: 1,
  fallback: 2,
  function: 3,
  event: 4,
  error: 5,
}

/** `abi-parity.test.ts::sortKey` ile AYNI. */
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

/**
 * Basligi KORUR, govdeyi degistirir.
 *
 * Bu dosyalarin ust yorumlari elle yazilmis ve OLCUMLERI kaydediyor ("Faz 1c
 * measured that `claim(address) external -> external payable` ... left 245/245
 * green"). Onlari her uretimde silmek, betigin depodan bilgi SILMESI olurdu.
 * Bu yuzden `export const <ad> = [` satirindan itibarasi yeniden yazilir,
 * oncesi oldugu gibi tasinir.
 */
function render(existing: string, constName: string, abi: readonly unknown[]): string {
  const marker = `export const ${constName} = [`
  const at = existing.indexOf(marker)
  if (at === -1) {
    throw new Error(`${constName}: '${marker}' bulunamadi -- baslik korunamaz, elle bakilmali.`)
  }
  const header = existing.slice(0, at)
  const body = JSON.stringify(abi, null, 2)
    // JSON cift tirnak kullanir; depo tek tirnak ve sondaki virgul ile
    // bicimlendirilmis. `prettier` sonrasi zaten normalize eder, ama uretilen
    // dosyanin ONCE de gecerli TypeScript olmasi gerekir.
    .replace(/"([^"\\]*)":/g, '$1:')
    .replace(/"/g, "'")
  return `${header}export const ${constName} = ${body} as const\n`
}

function main(): void {
  let drift = 0

  for (const t of TARGETS) {
    const artifactPath = join(REPO_ROOT, t.artifact)
    // EKSIK ARTIFACT ATLANMAZ, DUSER -- parite testindeki ayni gerekce:
    // atlanan bir adim CI ozetinde gecen bir adim gibi okunur.
    if (!existsSync(artifactPath)) {
      throw new Error(`${t.artifact} yok. Once: forge build --root contracts`)
    }
    const compiled = JSON.parse(readFileSync(artifactPath, 'utf8')).abi as unknown[]
    const selected = t.errorsOnly
      ? compiled.filter((e) => (e as AbiEntry).type === 'error')
      : compiled

    const outPath = join(REPO_ROOT, t.out)
    const existing = readFileSync(outPath, 'utf8')
    const next = render(existing, t.constName, normalise(selected))

    if (existing === next) {
      console.log(`  ok    ${t.out} (${selected.length} girdi)`)
      continue
    }
    drift += 1
    writeFileSync(outPath, next)
    console.log(`  yazildi ${t.out} (${selected.length} girdi)`)
  }

  // SONRAKI IKI ADIM YAZDIRILIR, CUNKU BU BETIK TEK BASINA HICBIR SEY
  // KANITLAMAZ: uretilen dosya once depo bicimine sokulur, sonra kapiya
  // sorulur. Kapinin adini burada tasimak, "calistirdim, yesil sanirim"
  // arasindaki bosluga tam olarak denk gelir.
  console.log(
    drift === 0
      ? '\nABI dosyalari degismedi.'
      : `\n${drift} ABI dosyasi yazildi. SIMDI:\n` +
          '  pnpm run fmt\n' +
          '  pnpm --filter @arcpad/shared test:abi   <- KAPI budur',
  )
}

main()
