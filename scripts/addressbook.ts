#!/usr/bin/env tsx
/**
 * Adres defterini URETIR -- elle yazilmaz.
 *
 *   pnpm addressbook --chain 5042002
 *   pnpm addressbook --chain 31337          # prova: cevrimdisi, fixture'i yeniden uretir
 *
 * Girdi: forge'un broadcast makbuzu + CANLI `eth_call`lar + `git rev-parse HEAD`.
 * Cikti: contracts/deploy/addresses.<chainId>.json
 *
 * URETTIGINI KENDI YUKLEYICISINDEN GECIRIR ve dogrulama duserse FIRLATIR.
 * Kendi yukleyicisinin reddedecegi bir dosya uretebilen bir jenerator,
 * jeneratorsuz halden daha kotudur.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Address,
  createPublicClient,
  getAddress,
  getCreate2Address,
  type Hex,
  http,
  keccak256,
  parseAbi,
} from 'viem'
import {
  AddressBookError,
  addressBookPath,
  CREATE2_FACTORY,
  DEFAULT_BOOK_DIR,
  ESCROW_SALT,
  FACTORY_SALT,
  loadAddressBook,
} from '../packages/shared/src/addresses'
import {
  chainKeyFor,
  isProfileName,
  type ProfileName,
  readProfiles,
  REPO_ROOT,
} from '../packages/shared/src/profiles'

const TESTDATA_DIR = join(REPO_ROOT, 'contracts', 'deploy', 'testdata')

/** Prova zinciri. Canli bir 31337 YOKTUR, o yuzden girdileri checked-in'dir. */
const REHEARSAL_CHAIN = 31337

// CHAIN_KEYS BURADA DEGIL. Bu dosya baginin UCUNCU kopyasini tasiyordu ve
// hicbir sey onu `Profiles.sol` ile karsilastirmiyordu: buradaki bir yazim
// hatasi, defterin icine sonradan tertemiz yuklenen yanlis bir anahtar
// yazardi (inceleme bulgusu I-4). Artik `@arcpad/shared` uzerinden gelir --
// yukleyicinin dogruladigi TAM OLARAK ayni tablo.

const PROFILE_FOR_CHAIN: Record<number, ProfileName> = {
  5042002: 'testnet',
  31337: 'testnet',
}

const FACTORY_ABI = parseAbi([
  'function escrow() view returns (address)',
  'function governor() view returns (address)',
  'function protocolTreasury() view returns (address)',
  'function graduationTarget() view returns (address)',
  'function VIRTUAL_TOKEN_RESERVES() view returns (uint256)',
  'function VIRTUAL_QUOTE_RESERVES() view returns (uint256)',
  'function SALE_SUPPLY() view returns (uint256)',
])

/** Zincirden okunan ve defterin dogrulanmasinda kullanilan degerler. */
type ChainReads = {
  escrow: Address
  governor: Address
  protocolTreasury: Address
  graduationTarget: Address
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  saleSupply: bigint
  totalSupply: bigint
}

type Deployed = { address: Address; block: bigint; txHash: Hex; initcodeHash: Hex }

type Receipt = { escrow: Deployed; factory: Deployed }

// ---------------------------------------------------------------
// forge broadcast receipt
// ---------------------------------------------------------------

type ForgeTx = {
  hash: Hex
  transactionType: string
  transaction: { to?: string | null; input?: Hex; data?: Hex }
  additionalContracts?: Array<{ transactionType: string; address: string; initCode?: Hex }>
}
type ForgeReceipt = { transactionHash: Hex; blockNumber: string; status?: string }

/**
 * Makbuzu okur ve HER ADRESI YENIDEN TURETIR.
 *
 * Islemler SIRAYA GORE ayirt EDILMEZ; her cagrinin calldata'sindaki ILK 32
 * BAYT olan SALT'a gore ayirt edilir. Siraya guvenmek, script'in bugunku
 * sirasini gorunmez bir varsayim haline getirirdi.
 *
 * Turetilen `CREATE2(deployer, salt, keccak256(initcode))` adresi, makbuzun
 * yaratildigini soyledigi adrese EsIT OLMAK ZORUNDADIR. Degilse jenerator
 * durur: yeniden turetemedigi bir adresi deftere yazamaz.
 */
export function readBroadcast(path: string): Receipt {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    transactions: ForgeTx[]
    receipts: ForgeReceipt[]
  }
  const blocks = new Map<string, bigint>()
  for (const r of raw.receipts) {
    if (r.status !== undefined && BigInt(r.status) !== 1n) {
      throw new Error(
        `broadcast: transaction ${r.transactionHash} has non-success status ${r.status}`,
      )
    }
    blocks.set(r.transactionHash.toLowerCase(), BigInt(r.blockNumber))
  }

  const found = new Map<Hex, Deployed>()
  for (const tx of raw.transactions) {
    const to = tx.transaction.to
    if (!to || getAddress(to) !== CREATE2_FACTORY) continue

    const input = (tx.transaction.input ?? tx.transaction.data) as Hex | undefined
    if (!input)
      throw new Error(`broadcast: call to the CREATE2 deployer with no calldata (${tx.hash})`)

    const salt = `0x${input.slice(2, 66)}` as Hex
    const initcode = `0x${input.slice(66)}` as Hex
    if (salt !== ESCROW_SALT && salt !== FACTORY_SALT) continue

    const initcodeHash = keccak256(initcode)
    const derived = getCreate2Address({ from: CREATE2_FACTORY, salt, bytecodeHash: initcodeHash })

    const created = tx.additionalContracts?.find((c) => c.transactionType === 'CREATE2')
    if (!created) throw new Error(`broadcast: no CREATE2 result recorded for ${tx.hash}`)
    if (getAddress(created.address) !== derived) {
      throw new Error(
        `broadcast: receipt says ${getAddress(created.address)} was created, but ` +
          `CREATE2(${CREATE2_FACTORY}, ${salt}, ${initcodeHash}) derives ${derived}`,
      )
    }

    const block = blocks.get(tx.hash.toLowerCase())
    if (block === undefined) throw new Error(`broadcast: no receipt for transaction ${tx.hash}`)

    found.set(salt, { address: derived, block, txHash: tx.hash, initcodeHash })
  }

  const escrow = found.get(ESCROW_SALT)
  const factory = found.get(FACTORY_SALT)
  if (!escrow) throw new Error(`broadcast: no FeeEscrow deployment (salt ${ESCROW_SALT})`)
  if (!factory) throw new Error(`broadcast: no LaunchFactory deployment (salt ${FACTORY_SALT})`)
  return { escrow, factory }
}

// ---------------------------------------------------------------
// the book itself
// ---------------------------------------------------------------

/**
 * SERI HALE GETIRME BURADA TEK BIR YERDE. Alan SIRASI sabittir, girinti iki
 * bosluktur ve dosya bir satirsonuyla biter -- yani ayni girdi HER ZAMAN ayni
 * BAYTLARI verir ve `git diff` gercek degisikligi gosterir, bicim gurultusunu
 * degil.
 */
export function serializeAddressBook(book: Record<string, unknown>): string {
  return `${JSON.stringify(book, null, 2)}\n`
}

export function buildAddressBook(args: {
  chainId: number
  receipt: Receipt
  reads: ChainReads
  commit: string
  smokeToken: Address | null
  smokeCurve: Address | null
}): Record<string, unknown> {
  const { chainId, receipt, reads, commit } = args

  const chainKey = chainKeyFor(chainId)
  const profile = PROFILE_FOR_CHAIN[chainId]
  if (!profile || !isProfileName(profile)) {
    throw new Error(
      `chain ${chainId} is not registered; add it to Profiles.sol first, in a reviewed commit`,
    )
  }

  // Zincirin SOYLEDIGI ile profil DOSYASININ soyledigi ayrisamaz.
  const expected = readProfiles()[profile]
  for (const key of ['virtualTokenReserves', 'virtualQuoteReserves', 'saleSupply'] as const) {
    if (reads[key] !== expected[key]) {
      throw new Error(
        `chain reports ${key}=${reads[key]} but profile "${profile}" says ${expected[key]}`,
      )
    }
  }
  if (reads.escrow !== receipt.escrow.address) {
    throw new Error(
      `the deployed factory points at escrow ${reads.escrow}, not ${receipt.escrow.address}`,
    )
  }

  const startBlock =
    receipt.escrow.block < receipt.factory.block ? receipt.escrow.block : receipt.factory.block

  return {
    chainId,
    chainKey,
    profile,
    virtualTokenReserves: reads.virtualTokenReserves.toString(),
    virtualQuoteReserves: reads.virtualQuoteReserves.toString(),
    saleSupply: reads.saleSupply.toString(),
    totalSupply: reads.totalSupply.toString(),
    launchFactory: receipt.factory.address,
    feeEscrow: receipt.escrow.address,
    governor: reads.governor,
    protocolTreasury: reads.protocolTreasury,
    graduationTarget: reads.graduationTarget,
    feeEscrowBlock: receipt.escrow.block.toString(),
    launchFactoryBlock: receipt.factory.block.toString(),
    startBlock: startBlock.toString(),
    deployTx: receipt.factory.txHash,
    escrowInitcodeHash: receipt.escrow.initcodeHash,
    factoryInitcodeHash: receipt.factory.initcodeHash,
    commit,
    smokeToken: args.smokeToken,
    smokeCurve: args.smokeCurve,
  }
}

export function envBlock(book: Record<string, unknown>): string {
  return [
    `NEXT_PUBLIC_ARC_CHAIN_ID=${book.chainId as number}`,
    `NEXT_PUBLIC_ARCPAD_FACTORY=${book.launchFactory as string}`,
    `NEXT_PUBLIC_ARCPAD_ESCROW=${book.feeEscrow as string}`,
    `ARC_FACTORY_ADDRESS=${book.launchFactory as string}`,
    `ARC_ESCROW_ADDRESS=${book.feeEscrow as string}`,
    `ARC_START_BLOCK=${book.startBlock as string}`,
  ].join('\n')
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

async function readFromChain(
  rpcUrl: string,
  factory: Address,
  token: Address | null,
): Promise<ChainReads> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  const read = <T>(functionName: string) =>
    client.readContract({ address: factory, abi: FACTORY_ABI, functionName }) as Promise<T>

  const [escrow, governor, protocolTreasury, graduationTarget, t, v, s] = await Promise.all([
    read<Address>('escrow'),
    read<Address>('governor'),
    read<Address>('protocolTreasury'),
    read<Address>('graduationTarget'),
    read<bigint>('VIRTUAL_TOKEN_RESERVES'),
    read<bigint>('VIRTUAL_QUOTE_RESERVES'),
    read<bigint>('SALE_SUPPLY'),
  ])

  // `totalSupply` bir SABITTEN KOPYALANMAZ; deployment'in gercekten mint
  // ettigi bir token'dan okunur. Boyle bir token henuz yoksa (Task 7 oncesi)
  // bunu SOYLEYIP durur -- sessizce 1e27 yazmaz.
  if (!token) {
    throw new Error(
      'no smoke token to read TOTAL_SUPPLY() from. Pass --smoke-token <address> once Task 7 has launched one; ' +
        'this value is deliberately NOT copied from a constant.',
    )
  }
  const totalSupply = (await client.readContract({
    address: token,
    abi: parseAbi(['function TOTAL_SUPPLY() view returns (uint256)']),
    functionName: 'TOTAL_SUPPLY',
  })) as bigint

  return {
    escrow: getAddress(escrow),
    governor: getAddress(governor),
    protocolTreasury: getAddress(protocolTreasury),
    graduationTarget: getAddress(graduationTarget),
    virtualTokenReserves: t,
    virtualQuoteReserves: v,
    saleSupply: s,
    totalSupply,
  }
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined || !a.startsWith('--')) continue
    const next = argv[i + 1]
    out.set(a.slice(2), next !== undefined && !next.startsWith('--') ? next : 'true')
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const chainRaw = args.get('chain')
  if (!chainRaw || chainRaw === 'true') throw new Error('usage: pnpm addressbook --chain <chainId>')
  const chainId = Number(chainRaw)

  const rehearsal = chainId === REHEARSAL_CHAIN
  const receiptPath =
    args.get('receipt') ??
    (rehearsal
      ? join(TESTDATA_DIR, 'broadcast.31337.json')
      : join(
          REPO_ROOT,
          'contracts',
          'broadcast',
          'Deploy.s.sol',
          String(chainId),
          'run-latest.json',
        ))

  const outDir = args.get('out-dir') ?? (rehearsal ? TESTDATA_DIR : DEFAULT_BOOK_DIR)
  const outPath = addressBookPath(chainId, outDir)

  const receipt = readBroadcast(receiptPath)

  let reads: ChainReads
  let commit: string
  if (rehearsal) {
    // PROVA ZINCIRI CEVRIMDISIDIR VE OLMAK ZORUNDADIR: canli bir 31337 yok.
    // Zincir okumalari ve commit checked-in bir dosyadan gelir, boylece
    // yeniden uretim BAYT BAYT AYNI olur; canli bir kaynak kullanilsaydi
    // `commit` her commit'te degisir ve fixture asla sabitlenemezdi.
    const fixture = JSON.parse(
      readFileSync(join(TESTDATA_DIR, 'chainreads.31337.json'), 'utf8'),
    ) as Record<string, string>
    reads = {
      escrow: getAddress(fixture.escrow as string),
      governor: getAddress(fixture.governor as string),
      protocolTreasury: getAddress(fixture.protocolTreasury as string),
      graduationTarget: getAddress(fixture.graduationTarget as string),
      virtualTokenReserves: BigInt(fixture.virtualTokenReserves as string),
      virtualQuoteReserves: BigInt(fixture.virtualQuoteReserves as string),
      saleSupply: BigInt(fixture.saleSupply as string),
      totalSupply: BigInt(fixture.totalSupply as string),
    }
    commit = fixture.commit as string
  } else {
    const rpcUrl = args.get('rpc-url') ?? process.env.ARC_RPC_URL
    if (!rpcUrl) throw new Error('no --rpc-url and no ARC_RPC_URL')
    const smoke = args.get('smoke-token')
    reads = await readFromChain(
      rpcUrl,
      receipt.factory.address,
      smoke && smoke !== 'true' ? getAddress(smoke) : null,
    )
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  }

  const smokeTokenArg = args.get('smoke-token')
  const smokeCurveArg = args.get('smoke-curve')
  const book = buildAddressBook({
    chainId,
    receipt,
    reads,
    commit,
    smokeToken: smokeTokenArg && smokeTokenArg !== 'true' ? getAddress(smokeTokenArg) : null,
    smokeCurve: smokeCurveArg && smokeCurveArg !== 'true' ? getAddress(smokeCurveArg) : null,
  })

  writeFileSync(outPath, serializeAddressBook(book), 'utf8')

  // KENDI YUKLEYICISINDEN GECIR. Bu satir olmadan jenerator, yukleyicisinin
  // reddedecegi bir dosya uretebilirdi.
  try {
    loadAddressBook(chainId, outDir)
  } catch (error) {
    const field = error instanceof AddressBookError ? ` (field: ${error.field})` : ''
    throw new Error(`the generated book fails its own loader${field}: ${(error as Error).message}`)
  }

  process.stdout.write(`wrote ${outPath}\n\n${envBlock(book)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exitCode = 1
})
