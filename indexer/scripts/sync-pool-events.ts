import { readFileSync, writeFileSync } from 'node:fs'
import { toEventSelector } from 'viem'

/**
 * `indexer/src/pool-events.generated.ts` URETICISI.
 *
 * `sync-launch-token.ts` ile AYNI GEREKCE, farkli bir yuk: `contracts/out/`
 * .gitignore'dadir (satir 8) ve Node CI'si `forge build` KOSMAZ, yani
 * artifact'i calisma zamaninda okuyan bir modul CI'da ve uretimde COKERDI.
 * Uretilmis dosya COMMIT'LENIR ve `topics.test.ts` elle yazilmis
 * `EVENT_SIGNATURES` girislerini ONA karsi tutar.
 *
 * NICIN `packages/shared/src/abi/*` DEGIL: o kopya `abi-parity` CI is'inde
 * artifact'in TAMAMIYLA iki yonlu karsilastirilir, yani oraya konan bir
 * `PoolManager` girisi TAM ABI olmak zorundadir (52 giris) ve `ARCPAD_ERROR_ABI`
 * uzerinden frontend'in hata sozlugune de sizardi -- `web/lib/failureTable.ts`
 * bugun tam olarak o kumeye gore yazilmis durumda. Indexer'in ihtiyaci UC
 * OLAYDIR; uc olayi kopyalamak icin bes yeni hata sinifini uretim hata
 * sozlugune sokmak yanlis takas olurdu.
 *
 *   pnpm --filter @arcpad/indexer sync-pool-events
 */

interface AbiInput {
  name: string
  type: string
  indexed?: boolean
  internalType?: string
}
interface AbiEntry {
  type: string
  name?: string
  inputs?: AbiInput[]
  anonymous?: boolean
}

const OUT = new URL('../../contracts/out/', import.meta.url)
const TARGET = new URL('../src/pool-events.generated.ts', import.meta.url)

/**
 * Cikarilan olaylar ve OLCULMUS `topic0`lari.
 *
 * Selector BURADA da iddia edilir, dosyanin uretildigi anda: bir gun baska bir
 * artifact okunursa (yanlis yol, bayat `out/`) uretici cikarttigi seyin ne
 * oldugunu SOYLEMEDEN yazardi. `Swap`in degeri Uniswap V4'un kanonik
 * `PoolManager`ininkiyle aynidir -- hook izinleri havuz kimligini degistirir,
 * OLAY IMZASINI degil.
 */
const WANTED = [
  {
    artifact: 'PoolManager.sol/PoolManager.json',
    contract: 'PoolManager',
    event: 'Swap',
    topic0: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  },
  {
    artifact: 'PoolManager.sol/PoolManager.json',
    contract: 'PoolManager',
    event: 'Initialize',
    topic0: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  },
  {
    artifact: 'ArcpadHook.sol/ArcpadHook.json',
    contract: 'ArcpadHook',
    event: 'SwapFeeCollected',
    topic0: '0x13141cbe3fc6a8f0f93e6aecd7386b6dc458eb176619df202f67bb953cc5b083',
  },
] as const

const entries: { contract: string; event: string; abi: AbiEntry }[] = []

for (const want of WANTED) {
  const path = new URL(want.artifact, OUT)
  const abi = (JSON.parse(readFileSync(path, 'utf8') as string) as { abi: AbiEntry[] }).abi
  const entry = abi.find((e) => e.type === 'event' && e.name === want.event)
  if (entry === undefined) throw new Error(`${want.artifact} icinde ${want.event} olayi yok`)
  const inputs = entry.inputs ?? []
  // `internalType` DUSURULUR: bir Solidity anotasyonudur, tel uzerinde yoktur.
  // `indexed` KALIR -- `abi-parity`nin olctugu sey tam olarak buydu: bir
  // `indexed` bayragini dusurmek her indexer filtresini SESSIZCE bosaltir.
  const stripped: AbiEntry = {
    type: 'event',
    name: entry.name as string,
    inputs: inputs.map((i) => ({ name: i.name, type: i.type, indexed: i.indexed === true })),
    anonymous: false,
  }
  const signature = `${want.event}(${inputs.map((i) => i.type).join(',')})`
  const selector = toEventSelector(signature)
  if (selector !== want.topic0) {
    throw new Error(`${want.event} topic0 ${selector}, ${want.topic0} bekleniyordu`)
  }
  entries.push({ contract: want.contract, event: want.event, abi: stripped })
}

/**
 * PRETTIER'IN YAZACAGI BICIM, DOGRUDAN URETILIR.
 *
 * `JSON.stringify` cift tirnak ve tirnakli anahtar uretir; `pnpm fmt:check`
 * onu reddeder. Uretilen dosyayi sonradan `prettier --write`ten gecirmek de
 * cozum DEGIL: bir sonraki `sync` yeniden JSON bicimini yazar ve dosya
 * "uretilmis haliyle ayni degil" durumuna duser -- yani ureticinin
 * dogrulanabilirligi kaybolur.
 */
function literal(node: unknown, indent: string): string {
  if (Array.isArray(node)) {
    if (node.length === 0) return '[]'
    const inner = node.map((item) => `${indent}  ${literal(item, `${indent}  `)},`).join('\n')
    return `[\n${inner}\n${indent}]`
  }
  if (node !== null && typeof node === 'object') {
    const inner = Object.entries(node as Record<string, unknown>)
      .map(([key, value]) => `${indent}  ${key}: ${literal(value, `${indent}  `)},`)
      .join('\n')
    return `{\n${inner}\n${indent}}`
  }
  return typeof node === 'string' ? `'${node}'` : String(node)
}

const body = entries
  .map(({ contract, event, abi }) => {
    const constant = `${contract === 'PoolManager' ? 'POOL_MANAGER' : 'ARCPAD_HOOK'}_${event
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toUpperCase()}_EVENT`
    return [
      `/** \`${contract}\`in \`${event}\` olayi, derlenmis ABI'den AYNEN. */`,
      `export const ${constant} = ${literal(abi, '')} as const satisfies AbiEvent`,
      '',
    ].join('\n')
  })
  .join('\n')

writeFileSync(
  TARGET,
  [
    '// URETILMISTIR -- elle duzenlemeyin.',
    '//   pnpm --filter @arcpad/indexer sync-pool-events',
    '// Kaynak: contracts/out/PoolManager.sol/PoolManager.json,',
    '//         contracts/out/ArcpadHook.sol/ArcpadHook.json',
    "import type { AbiEvent } from 'viem'",
    '',
    body,
  ].join('\n'),
)

console.log(`pool-events.generated.ts yazildi: ${entries.map((e) => e.event).join(', ')}`)
