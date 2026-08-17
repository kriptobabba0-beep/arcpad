import { writeFileSync, readFileSync } from 'node:fs'
import { keccak256 } from 'viem'

/**
 * `indexer/src/launch-token.generated.ts` URETICISI.
 *
 * SINIR NOTU -- bunun normal evi `packages/shared/scripts/sync-artifacts.ts`
 * (plan Task 1) ve o paket baska bir ajanin elinde; Task 1 henuz inmedi. Task 1
 * indigi gun bu script SILINIR ve `admit.ts` sabiti `@arcpad/shared`'dan alir.
 *
 * NICIN URETILMIS BIR DOSYA VE NICIN COMMIT'LENIYOR: `contracts/out/`
 * .gitignore'da (satir 8). Node CI'si `forge build` KOSMAZ, yani artifact'i
 * calisma zamaninda okuyan bir `admit.ts` CI'da ve uretimde COKERDI. Ayni
 * sebeple bu dosyanin "artifact ile ayni mi" kapisi da CI'da kosamaz --
 * onun yerine kapi GERCEK ZINCIRDIR: `admit.test.ts` bu creationCode'un
 * CANLI Arc'taki launch'in token adresini yeniden urettigini iddia eder
 * (0x1bd93613...fab, factory 0x0d75a4ff...439). Bayat bir creationCode o
 * testi kirar.
 *
 *   pnpm --filter @arcpad/indexer sync-launch-token
 */

const ARTIFACT = new URL('../../contracts/out/LaunchToken.sol/LaunchToken.json', import.meta.url)
const TARGET = new URL('../src/launch-token.generated.ts', import.meta.url)

interface Artifact {
  bytecode: { object: `0x${string}`; linkReferences?: Record<string, unknown> }
}

const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Artifact
const code = artifact.bytecode.object

// (1) Link referansi YOKTUR -> creationCode kendi kendine yeterlidir.
if (Object.keys(artifact.bytecode.linkReferences ?? {}).length !== 0) {
  throw new Error('LaunchToken link referansi tasiyor: creationCode sabit degil')
}
// (2) Olculmus boyut. Sessiz bir kucuIme "yanlis artifact okundu" demektir.
const size = (code.length - 2) / 2
if (size !== 3598) throw new Error(`LaunchToken creationCode ${size} bayt, 3598 bekleniyordu`)
const hash = keccak256(code)
if (hash !== '0x3c7ca45505c038e707c0384e4c5861f15aace17f85486470a42737142f966fe4') {
  throw new Error(`LaunchToken creationCode hash'i degismis: ${hash}`)
}

writeFileSync(
  TARGET,
  [
    '// URETILMISTIR -- elle duzenlemeyin.',
    '//   pnpm --filter @arcpad/indexer sync-launch-token',
    '// Kaynak: contracts/out/LaunchToken.sol/LaunchToken.json (bytecode.object)',
    "import type { Hex } from 'viem'",
    '',
    '/** `LaunchToken` creationCode. CREATE2 turetmesinin girdisi. */',
    `export const LAUNCH_TOKEN_CREATION_CODE: Hex =`,
    `  '${code}'`,
    '',
    '/** `keccak256(creationCode)`. Olculdu; degisirse butun launch adresleri kayar. */',
    `export const LAUNCH_TOKEN_CREATION_CODE_HASH: Hex =`,
    `  '${hash}'`,
    '',
    '/** Bayt cinsinden boyut. Sessiz bir kucuIme "yanlis artifact" demektir. */',
    `export const LAUNCH_TOKEN_CREATION_CODE_SIZE = ${size}`,
    '',
  ].join('\n'),
)

console.log(`launch-token.generated.ts yazildi: ${size} bayt, ${hash}`)
