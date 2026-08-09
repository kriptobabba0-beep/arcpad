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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  type AddressBook,
  AddressBookError,
  addressBookPath,
  CREATE2_FACTORY,
  DEFAULT_BOOK_DIR,
  ARCPAD_HOOK_SALT,
  ESCROW_SALT,
  FACTORY_SALT,
  FEE_SCHEDULE_SALT,
  loadAddressBook,
  LOCKER_SALT,
  POOL_MANAGER_SALT,
  resolveSmokePair,
  ROUTER_SALT,
  webEnvBlock,
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
  'function isCanonical(address token) view returns (bool)',
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

/**
 * `escrow` NULL OLABILIR VE BU BIR GEVSETME DEGIL, OLCULMUS BIR ARIZANIN
 * DUZELTMESIDIR.
 *
 * Task 7 Arc testnet'te KOSTU ve `Deploy.s.sol` UC degil IKI islem gonderdi:
 * `FeeEscrow` zaten canliydi (`0xEEd4431e...`, 152.069.146.725.900.635 wei) ve
 * `deployIfAbsent` onu ATLADI -- yeniden kullanim kolunun tam olarak yapmasi
 * gereken sey. Sonucu su oldu: bu jenerator `broadcast: no FeeEscrow
 * deployment` ile DURDU ve `pnpm addressbook --chain 5042002` Task 7'den sonra
 * HIC KOSAMADI (olculdu).
 *
 * Yani escrow'u koruyan kol, escrow'u KAYDEDEN araci kirdi. Bu deponun
 * defalarca adlandirdigi kip: bir sinifin duzeltmesi o sinifin yeni bir
 * ornegini icerir.
 */
type Receipt = { escrow: Deployed | null; factory: Deployed; bySalt: Map<Hex, Deployed> }

// ---------------------------------------------------------------
// forge broadcast receipt
// ---------------------------------------------------------------

type ForgeTx = {
  hash: Hex
  transactionType: string
  contractAddress?: string | null
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
/** `readBroadcast`in FACTORY ISTEMEYEN ikizi: `DeployPool` makbuzu bir
 *  `LaunchFactory` yayinlamaz. Ortak govde `collectDeployments`tir. */
export function readDeployments(path: string): Map<Hex, Deployed> {
  return collectDeployments(path)
}

function collectDeployments(path: string): Map<Hex, Deployed> {
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
    // TUZ SUZGECI KALKTI. Onceki hal YALNIZCA escrow ve factory'yi
    // topluyordu; `FeeSchedule` ayni makbuzda duruyordu ve gorulmuyordu,
    // havuz katmani ise BASKA bir makbuzda. Hepsini toplamak, cagiranin
    // hangi tuzu istedigine karar vermesini saglar.

    const initcodeHash = keccak256(initcode)
    const derived = getCreate2Address({ from: CREATE2_FACTORY, salt, bytecodeHash: initcodeHash })

    // FORGE IKI SEKILDEN BIRINI YAZAR VE BUNU OLCEREK OGRENDIK. Sentetik
    // fixture `transactionType: "CALL"` + `additionalContracts[0].address`
    // varsayiyordu; GERCEK yayin makbuzu `transactionType: "CREATE2"` yazar,
    // yaratilan adresi `transactions[].contractAddress`e koyar ve
    // `additionalContracts`i BOS birakir. Fixture gercekten daha comertti --
    // tam olarak bu deponun tekrar tekrar yakaladigi sinif -- ve jenerator
    // ilk gercek makbuzda "no CREATE2 result recorded" ile durdu.
    //
    // ASIL DOGRULAMA ZATEN TURETMEDIR: CREATE2 deterministiktir, yani
    // `derived` makbuzun ne dedigine BAGLI DEGILDIR. Makbuzun kaydettigi adres
    // bir CAPRAZ KONTROLDUR; varsa uyusmak ZORUNDADIR, yoksa turetme tek
    // basina yeterlidir ve zincir okumalari (escrow/governor/...) yanlis bir
    // adreste zaten patlar.
    const recorded =
      tx.contractAddress ??
      tx.additionalContracts?.find((c) => c.transactionType === 'CREATE2')?.address
    if (recorded !== undefined && recorded !== null && getAddress(recorded) !== derived) {
      throw new Error(
        `broadcast: receipt says ${getAddress(recorded)} was created, but ` +
          `CREATE2(${CREATE2_FACTORY}, ${salt}, ${initcodeHash}) derives ${derived}`,
      )
    }

    const block = blocks.get(tx.hash.toLowerCase())
    if (block === undefined) throw new Error(`broadcast: no receipt for transaction ${tx.hash}`)

    found.set(salt, { address: derived, block, txHash: tx.hash, initcodeHash })
  }

  return found
}

export function readBroadcast(path: string): Receipt {
  const found = collectDeployments(path)
  const factory = found.get(FACTORY_SALT)
  // FACTORY HALA ZORUNLUDUR: bu makbuz onu yayinlamadiysa okunan makbuz
  // yanlis makbuzdur. Escrow oyle DEGILDIR -- yeniden kullanilmis olabilir.
  if (!factory) throw new Error(`broadcast: no LaunchFactory deployment (salt ${FACTORY_SALT})`)
  return { escrow: found.get(ESCROW_SALT) ?? null, factory, bySalt: found }
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

/** Escrow'un deftere yazilan UC gercegi. `Deployed`in aksine `txHash`
 *  TASIMAZ ve tasiyamaz: yeniden kullanilmis bir escrow'un deploy islemi BU
 *  yayinin icinde degildir, gecmis bir yayinin icindedir. Var olmayan bir
 *  alani tasimamak, onu uydurmaktan iyidir. */
export type EscrowFacts = { address: Address; block: bigint; initcodeHash: Hex }

/** Faz 2'nin havuz katmani + `FeeSchedule`. */
export type PoolAddresses = {
  feeSchedule: Address
  poolManager: Address
  arcpadHook: Address
  arcpadLocker: Address
}

/**
 * Router'in deftere yazilan IKI gercegi. `EscrowFacts` gibi `block` ya da
 * `txHash` TASIMAZ ve tasiyamaz: onceki defterden tasindiginda o yayin bu
 * makbuzun icinde degildir. `initcodeHash` ise TASINIR, cunku ADRESI
 * YENIDEN TURETEN sey odur -- havuz uclusunun sahip olmadigi sey.
 */
export type RouterFacts = { address: Address; initcodeHash: Hex }

/**
 * Onceki defter. Yeniden kullanilan escrow'un ve (bu zincirde `DeployPool`
 * makbuzu yoksa) havuz katmaninin TEK kaynagidir.
 *
 * HAM okunur, `loadAddressBook` ile DEGIL, ve sebebi tam olarak bu commit'tir:
 * yukleyici artik dort yeni alani ZORUNLU tutuyor, yani onlari HENUZ
 * tasimayan bir defter yuklenemez -- ve jeneratorun onlari yazabilmesi icin
 * once o defteri okumasi gerekir. Yukleyiciden gecirmek, jeneratoru kendi
 * ciktisina bagimli hale getirirdi.
 */
function readPreviousBook(chainId: number, dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(addressBookPath(chainId, dir), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

/**
 * Escrow: bu yayindan, ya da onceki defterden TASINMIS.
 *
 * TASIMA YOLU BEDAVA DEGILDIR. Adres, ONCEKI DEFTERIN kaydettigi initcode
 * hash'inden YENIDEN TURETILIR ve turetme tutmazsa durur -- yani tasinan sey
 * "bir adres" degil, "kendi initcode'undan turedigi kanitlanmis bir adres".
 * `buildAddressBook` ayrica canli factory'nin `escrow()`u ile esitler.
 */
export function resolveEscrow(
  receipt: Receipt,
  previous: Record<string, unknown> | null,
): EscrowFacts {
  if (receipt.escrow) {
    return {
      address: receipt.escrow.address,
      block: receipt.escrow.block,
      initcodeHash: receipt.escrow.initcodeHash,
    }
  }
  if (!previous) {
    throw new Error(
      'broadcast has no FeeEscrow deployment and there is no previous book to carry it from. ' +
        'If this is a first deploy on a new chain, the escrow must be in the broadcast.',
    )
  }
  const recorded = previous.feeEscrow
  const hash = previous.escrowInitcodeHash
  const block = previous.feeEscrowBlock
  if (typeof recorded !== 'string' || typeof hash !== 'string' || typeof block !== 'string') {
    throw new Error('previous book is missing feeEscrow / escrowInitcodeHash / feeEscrowBlock')
  }
  const derived = getCreate2Address({
    from: CREATE2_FACTORY,
    salt: ESCROW_SALT,
    bytecodeHash: hash as Hex,
  })
  if (derived !== getAddress(recorded)) {
    throw new Error(
      `previous book records escrow ${getAddress(recorded)} but its own ` +
        `escrowInitcodeHash derives ${derived}`,
    )
  }
  return { address: derived, block: BigInt(block), initcodeHash: hash as Hex }
}

/**
 * Havuz katmani: `DeployPool` makbuzundan, ya da onceki defterden.
 *
 * Havuz uclusunun defterde bir initcode hash'i YOKTUR, dolayisiyla escrow gibi
 * yeniden turetilemezler. Makbuz varsa adres ORADAN gelir -- ve `readBroadcast`
 * onu zaten CREATE2'den yeniden turetmis, makbuzun kaydettigiyle esitlemistir.
 */
export function resolvePool(
  poolReceiptPath: string | null,
  previous: Record<string, unknown> | null,
  feeScheduleFromDeploy: Deployed | undefined,
): PoolAddresses {
  const fromPrevious = (field: string): Address => {
    const v = previous?.[field]
    if (typeof v !== 'string') {
      throw new Error(
        `cannot determine ${field}: no DeployPool broadcast and the previous book has no ${field}`,
      )
    }
    return getAddress(v)
  }

  // `readDeployments`, `readBroadcast`in FACTORY ISTEMEYEN halidir: havuz
  // makbuzu bir `LaunchFactory` yayinlamaz, dolayisiyla `readBroadcast` orada
  // her zaman duserdi. Adresler yine CREATE2'den yeniden turetilir.
  const pool: Map<Hex, Deployed> | null = poolReceiptPath ? readDeployments(poolReceiptPath) : null

  const pick = (salt: Hex, field: string): Address => {
    const d = pool?.get(salt)
    return d ? d.address : fromPrevious(field)
  }

  return {
    feeSchedule: feeScheduleFromDeploy
      ? feeScheduleFromDeploy.address
      : fromPrevious('feeSchedule'),
    poolManager: pick(POOL_MANAGER_SALT, 'poolManager'),
    arcpadHook: pick(ARCPAD_HOOK_SALT, 'arcpadHook'),
    arcpadLocker: pick(LOCKER_SALT, 'arcpadLocker'),
  }
}

/**
 * Router: `DeployRouter` makbuzundan, ya da onceki defterden TASINMIS.
 *
 * TASIMA YOLU `resolveEscrow`INKI GIBIDIR, `resolvePool`INKI GIBI DEGIL --
 * ve fark tam olarak defterin `routerInitcodeHash` tasimasidir. Havuz uclusu
 * icin tasima "adresi kopyala"dir; burada adres onceki defterin KENDI
 * kaydettigi hash'ten CREATE2 ile YENIDEN TURETILIR ve tutmazsa durur. Yani
 * tasinan sey "bir adres" degil, "kendi initcode'undan turedigi kanitlanmis
 * bir adres".
 *
 * MAKBUZ YOLU DA TURETMEDIR: `collectDeployments` her adresi calldata'daki
 * salt ve initcode'dan yeniden turetip makbuzun kaydettigiyle esitler, yani
 * SIRAYA hicbir yerde guvenilmez.
 */
export function resolveRouter(
  routerReceiptPath: string | null,
  previous: Record<string, unknown> | null,
): RouterFacts {
  if (routerReceiptPath) {
    const deployed = readDeployments(routerReceiptPath).get(ROUTER_SALT)
    if (!deployed) {
      throw new Error(
        `${routerReceiptPath} has no ArcpadRouter deployment (salt ${ROUTER_SALT}). ` +
          'The receipt read is the wrong receipt.',
      )
    }
    return { address: deployed.address, initcodeHash: deployed.initcodeHash }
  }

  const recorded = previous?.arcpadRouter
  const hash = previous?.routerInitcodeHash
  if (typeof recorded !== 'string' || typeof hash !== 'string') {
    throw new Error(
      'cannot determine arcpadRouter: no DeployRouter broadcast and the previous book has no ' +
        'arcpadRouter / routerInitcodeHash. The order on a new chain is Deploy -> DeployPool -> ' +
        'DeployRouter -> addressbook; the router is REQUIRED because a pool nobody can trade ' +
        'against is not a working deployment.',
    )
  }
  const derived = getCreate2Address({
    from: CREATE2_FACTORY,
    salt: ROUTER_SALT,
    bytecodeHash: hash as Hex,
  })
  if (derived !== getAddress(recorded)) {
    throw new Error(
      `previous book records arcpadRouter ${getAddress(recorded)} but its own ` +
        `routerInitcodeHash derives ${derived}`,
    )
  }
  return { address: derived, initcodeHash: hash as Hex }
}

export function buildAddressBook(args: {
  chainId: number
  receipt: Receipt
  reads: ChainReads
  commit: string
  smokeToken: Address | null
  smokeCurve: Address | null
  escrow: EscrowFacts
  pool: PoolAddresses
  router: RouterFacts
}): Record<string, unknown> {
  const { chainId, receipt, reads, commit, escrow, pool, router } = args

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
  // ZINCIR SON SOZU SOYLER. Escrow ister bu yayindan gelsin ister onceki
  // defterden TASINSIN, canli factory'nin `escrow()`u ile ayni olmak
  // ZORUNDADIR -- tasima yolunu guvenli kilan tek satir budur.
  if (reads.escrow !== escrow.address) {
    throw new Error(`the deployed factory points at escrow ${reads.escrow}, not ${escrow.address}`)
  }

  const startBlock = escrow.block < receipt.factory.block ? escrow.block : receipt.factory.block

  return {
    chainId,
    chainKey,
    profile,
    virtualTokenReserves: reads.virtualTokenReserves.toString(),
    virtualQuoteReserves: reads.virtualQuoteReserves.toString(),
    saleSupply: reads.saleSupply.toString(),
    totalSupply: reads.totalSupply.toString(),
    launchFactory: receipt.factory.address,
    feeEscrow: escrow.address,
    governor: reads.governor,
    protocolTreasury: reads.protocolTreasury,
    graduationTarget: reads.graduationTarget,
    // SIRA SEMAYLA AYNI. `addresses.schema.json` `additionalProperties: false`
    // tasir ve artik BIR TEST onu gercek defterlerle karsilastiriyor; buradaki
    // bir eksik alan orada kirmizi olur.
    feeSchedule: pool.feeSchedule,
    poolManager: pool.poolManager,
    arcpadHook: pool.arcpadHook,
    arcpadLocker: pool.arcpadLocker,
    arcpadRouter: router.address,
    feeEscrowBlock: escrow.block.toString(),
    launchFactoryBlock: receipt.factory.block.toString(),
    startBlock: startBlock.toString(),
    deployTx: receipt.factory.txHash,
    escrowInitcodeHash: escrow.initcodeHash,
    factoryInitcodeHash: receipt.factory.initcodeHash,
    routerInitcodeHash: router.initcodeHash,
    commit,
    smokeToken: args.smokeToken,
    smokeCurve: args.smokeCurve,
  }
}

/**
 * ENV BLOGU ARTIK BURADA URETILMIYOR.
 *
 * Alti satir `@arcpad/shared`'in `webEnvBlock`unda ve `assertEnvMatchesBook`
 * ile AYNI tablodan turuyor. Burada duran elle yazilmis kopya ucuncu bir
 * listeydi ve hicbir sey onu denetciyle karsilastirmiyordu.
 */

/**
 * DEFTERI KENDISI BULUR: `contracts/deploy/addresses.<chainId>.json`.
 *
 * `--env-only` yolunun `--chain` istememesinin sebebi budur -- is akisina
 * yazilan her literal (bir adres, ama bir chain id de) defterin ustunden
 * atlayan bir kopyadir ve `indexer-live.yml` tam olarak boyle bayat bir
 * factory adresi tasiyordu. SIFIR ya da BIRDEN COK defter varsa DURUR: ikisi
 * de "hangi zincir" sorusunun cevapsiz oldugu haldir ve birini secmek
 * tahmindir.
 */
export function discoverChainId(dir: string = DEFAULT_BOOK_DIR): number {
  const found = readdirSync(dir)
    .map((f) => /^addresses\.(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
  if (found.length === 0) throw new Error(`no addresses.<chainId>.json under ${dir}`)
  if (found.length > 1) {
    throw new Error(
      `${dir} holds ${found.length} address books (${found.join(', ')}); pass --chain to choose`,
    )
  }
  return found[0] as number
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

/**
 * Ciftin ZINCIRDEKI karsiligi. `resolveSmokePair` yalnizca defterlerin ne
 * dedigini bilir; bu fonksiyon zincirin ne dedigini sorar ve ikisi ayrilirsa
 * DURUR. `resolveEscrow`in "turetme tutmazsa dur"unun turetilemeyen bir alan
 * icin karsiligidir.
 */
export async function assertSmokePairMatchesChain(
  rpcUrl: string,
  factory: Address,
  token: Address,
  curve: Address,
): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  const canonical = (await client.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'isCanonical',
    args: [token],
  })) as boolean
  if (!canonical) {
    throw new Error(
      `smokeToken ${token} is NOT canonical on factory ${factory}. It is the residue of a ` +
        'different (superseded) factory and must not be carried into this book.',
    )
  }
  await new Promise((r) => setTimeout(r, 1500))
  const curveToken = (await client.readContract({
    address: curve,
    abi: parseAbi(['function token() view returns (address)']),
    functionName: 'token',
  })) as Address
  if (getAddress(curveToken) !== getAddress(token)) {
    throw new Error(
      `smokeCurve ${curve} reports token() = ${curveToken}, but the book names ${token}. ` +
        'The pair does not describe one launch.',
    )
  }
}

/**
 * ROUTER'IN ZINCIRDEKI KIMLIGI, VE HASH'IN GOREMEDIGI SEY.
 *
 * `routerInitcodeHash` "bu adres kendi initcode'undan turedi" der ve orada
 * DURUR: keccak tek yonludur, yani o initcode'un ICINDE hangi `PoolManager`
 * ve hangi hook'un gomulu oldugunu defterden hicbir sekilde okunamaz. Router'
 * in kimligi ise TAM OLARAK o iki `immutable`dir.
 *
 * Bu iki `eth_call` bosluğu kapatir: zincirdeki router'in `poolManager()` ve
 * `hook()`u, AYNI DEFTERIN havuz katmanini gostermek zorundadir. Yakaladigi
 * sey gercek ve ucuzdur: superseded bir yigindan tasinmis ya da baska bir
 * hook'a baglanmis bir router, defterin geri kalaniyla tutarli gorunur ve
 * hicbir offline kontrol onu goremez.
 *
 * BEDELI: iki `eth_call` ve ~3 saniye, DEPLOYMENT BASINA BIR KEZ. `escrow()`
 * karsilastirmasinin ("ZINCIR SON SOZU SOYLER") router icin karsiligidir --
 * ve `buildAddressBook`in icine DEGIL, `assertSmokePairMatchesChain` gibi
 * CANLI YOLA konur: prova zincirinde canli bir dugum yoktur ve
 * `chainreads.31337.json`e "defterin kendi degerini soyleyen" sentetik iki
 * alan eklemek, hicbir sey olcmeyen ama olcuyormus gibi duran bir kontrol
 * olurdu.
 */
export async function assertRouterMatchesBook(
  rpcUrl: string,
  router: Address,
  poolManager: Address,
  hook: Address,
): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  const abi = parseAbi([
    'function poolManager() view returns (address)',
    'function hook() view returns (address)',
  ])
  const onChainPoolManager = (await client.readContract({
    address: router,
    abi,
    functionName: 'poolManager',
  })) as Address
  if (getAddress(onChainPoolManager) !== poolManager) {
    throw new Error(
      `arcpadRouter ${router} reports poolManager() = ${getAddress(onChainPoolManager)}, but the ` +
        `book names ${poolManager}. The router belongs to a different pool layer.`,
    )
  }
  await new Promise((r) => setTimeout(r, 1500))
  const onChainHook = (await client.readContract({
    address: router,
    abi,
    functionName: 'hook',
  })) as Address
  if (getAddress(onChainHook) !== hook) {
    throw new Error(
      `arcpadRouter ${router} reports hook() = ${getAddress(onChainHook)}, but the book names ` +
        `${hook}. The router would build PoolKeys arcpad's pools do not answer to.`,
    )
  }
}

async function readFromChain(
  rpcUrl: string,
  factory: Address,
  token: Address | null,
): Promise<ChainReads> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  // ARC TESTNET RPC'SI DAR BIR HIZ SINIRI UYGULUYOR ve bu olculdu: once
  // `Promise.all` ile yedi es zamanli okuma, sonra ARDISIK okumalar bile
  // "request limit reached" ile dondu. Okumalar arasina kucuk bir bekleme
  // konuyor. Bu betik deployment basina BIR KEZ calisir; birkac saniye
  // hicbir sey degil, yarim yazilmis bir adres defteri ise her seydir.
  const pause = () => new Promise((r) => setTimeout(r, 1500))
  // `functionName` ABI'DEN TURETILIR, `string` DEGIL. Gevsek hali `scripts/`
  // hicbir tsc programina girmedigi icin gorunmuyordu; bir yazim hatasi
  // derlemeden gecer, calisma aninda duserdi. Simdi ABI'de olmayan bir ad
  // derlenmez.
  type FactoryView = Extract<(typeof FACTORY_ABI)[number], { type: 'function' }>['name']
  const read = async <T>(functionName: FactoryView): Promise<T> => {
    const out = (await client.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName,
    })) as T
    await pause()
    return out
  }

  // SIRAYLA, `Promise.all` ILE DEGIL. Yedi okumayi ayni anda gondermek Arc
  // testnet RPC'sinde "request limit reached" ile doner (olculdu: jenerator
  // ilk gercek kosuda VIRTUAL_QUOTE_RESERVES uzerinde durdu). Bu betik saniyede
  // bir kez degil, deployment basina bir kez calisir; paralellik hicbir sey
  // kazandirmiyor, tek bir hiz sinirina carpmak ise her seyi kaybettiriyor.
  const escrow = await read<Address>('escrow')
  const governor = await read<Address>('governor')
  const protocolTreasury = await read<Address>('protocolTreasury')
  const graduationTarget = await read<Address>('graduationTarget')
  const t = await read<bigint>('VIRTUAL_TOKEN_RESERVES')
  const v = await read<bigint>('VIRTUAL_QUOTE_RESERVES')
  const s = await read<bigint>('SALE_SUPPLY')

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

  // ---------------------------------------------------------------
  // `--env-only`: ZINCIRE DOKUNMAZ, DOSYA YAZMAZ, YALNIZCA BASAR.
  //
  // CI'in kullandigi mod budur (`... --env-only >> "$GITHUB_ENV"`). Uc sey
  // BILEREK yok: RPC (defter zaten commit'li), broadcast makbuzu (yeniden
  // deploy etmiyoruz) ve `git rev-parse` (calisma agacini okumuyoruz). Ama
  // dogrulama TAM: `loadAddressBook` her adresi kendi initcode hash'inden
  // CREATE2 ile yeniden turetir, takma adlari reddeder, profil digest'ini ve
  // `expected-governance.json` ile capraz kontrolu kosar. Yani bozuk bir
  // defter CI'i YESIL BIRAKMAZ, adimi dusurur.
  // ---------------------------------------------------------------
  const envOnly = args.get('env-only') === 'true'
  const chainRawForEnv = args.get('chain')
  if (envOnly) {
    const dir = args.get('out-dir') ?? DEFAULT_BOOK_DIR
    const chainId =
      chainRawForEnv && chainRawForEnv !== 'true' ? Number(chainRawForEnv) : discoverChainId(dir)
    const book: AddressBook = loadAddressBook(chainId, dir)
    process.stdout.write(`${webEnvBlock(book)}\n`)
    return
  }

  const chainRaw = chainRawForEnv
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
  const previous = readPreviousBook(chainId, outDir)
  const escrow = resolveEscrow(receipt, previous)

  // HAVUZ MAKBUZU AYRI BIR SCRIPT'IN CIKTISIDIR. Yoksa (prova zinciri, ya da
  // havuz katmani henuz inmemis bir zincir) adresler onceki defterden gelir ve
  // ikisi de yoksa jenerator ADIYLA durur -- sessizce eksik alan YAZMAZ,
  // cunku yukleyici onu zaten reddederdi ve teshis burada daha ucuzdur.
  const poolReceiptPath = rehearsal
    ? null
    : join(
        REPO_ROOT,
        'contracts',
        'broadcast',
        'DeployPool.s.sol',
        String(chainId),
        'run-latest.json',
      )
  const pool = resolvePool(
    poolReceiptPath && existsSync(poolReceiptPath) ? poolReceiptPath : null,
    previous,
    receipt.bySalt.get(FEE_SCHEDULE_SALT),
  )

  // ROUTER MAKBUZU UCUNCU BIR SCRIPT'IN CIKTISIDIR (`DeployRouter.s.sol`).
  // `DeployPool`unkiyle ayni sekil: varsa adres ORADAN, yoksa onceki
  // defterden -- ama havuzunkinin aksine TURETILEREK.
  const routerReceiptPath = rehearsal
    ? null
    : join(
        REPO_ROOT,
        'contracts',
        'broadcast',
        'DeployRouter.s.sol',
        String(chainId),
        'run-latest.json',
      )
  const router = resolveRouter(
    routerReceiptPath && existsSync(routerReceiptPath) ? routerReceiptPath : null,
    previous,
  )

  // CIFT, ZINCIR OKUMASINDAN ONCE cozulur: `readFromChain` `TOTAL_SUPPLY()`i
  // ondan okur, dolayisiyla tasinan bir cift ciplak bir yeniden uretimi de
  // MUMKUN KILAR -- eskiden `--smoke-token` gecmek zorunluydu.
  const argAddress = (name: string): Address | null => {
    const v = args.get(name)
    return v && v !== 'true' ? getAddress(v) : null
  }
  const smoke = resolveSmokePair(
    argAddress('smoke-token'),
    argAddress('smoke-curve'),
    previous,
    receipt.factory.address,
  )
  process.stderr.write(`smoke pair: ${smoke.source}\n`)

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
    reads = await readFromChain(rpcUrl, receipt.factory.address, smoke.smokeToken)
    // TASIMA YOLUNU GUVENLI KILAN SATIR. Escrow'unki "kendi initcode'undan
    // turedigi KANITLANMIS bir adres"ti; smoke cifti turetilemedigi icin
    // karsiligi ZINCIRE SORMAKTIR. Bir yeniden uretim, superseded bir cifti
    // sessizce tasiyamaz: burada durur.
    if (smoke.smokeToken && smoke.smokeCurve) {
      await assertSmokePairMatchesChain(
        rpcUrl,
        receipt.factory.address,
        smoke.smokeToken,
        smoke.smokeCurve,
      )
    }
    // ROUTER'IN IKI `immutable`I, ZINCIRDEN. Turetme "adres kendi
    // initcode'undan geldi" der; bu, "o initcode BU defterin havuz katmanina
    // baglandi" der -- ve ikincisini hicbir offline kontrol soyleyemez.
    await assertRouterMatchesBook(rpcUrl, router.address, pool.poolManager, pool.arcpadHook)
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  }

  const book = buildAddressBook({
    chainId,
    receipt,
    reads,
    commit,
    smokeToken: smoke.smokeToken,
    smokeCurve: smoke.smokeCurve,
    escrow,
    pool,
    router,
  })

  writeFileSync(outPath, serializeAddressBook(book), 'utf8')

  // KENDI YUKLEYICISINDEN GECIR. Bu satir olmadan jenerator, yukleyicisinin
  // reddedecegi bir dosya uretebilirdi.
  let loaded: AddressBook
  try {
    loaded = loadAddressBook(chainId, outDir)
  } catch (error) {
    const field = error instanceof AddressBookError ? ` (field: ${error.field})` : ''
    throw new Error(`the generated book fails its own loader${field}: ${(error as Error).message}`)
  }

  // BASILAN BLOK, YUKLENMIS DEFTERDEN. Yeni yazilmis `book` kaydindan degil:
  // ikisi ayni olmali ve yukleyiciden GECMIS olan, gecmemis olandan her zaman
  // daha iyi bir kaynaktir.
  process.stdout.write(`wrote ${outPath}\n\n${webEnvBlock(loaded)}\n`)
}

// GIRIS NOKTASI KORUMASI. Bu satirlar olmadan `main()` IMPORT ANINDA kosuyordu,
// yani dosya "test icin" fonksiyon export ediyor ama import EDILEMIYORDU: onu
// import eden her test bir jenerator kosusu tetiklerdi. Jeneratorun testsiz
// olmasinin sebebi bir eksiklik degil, yazildigi haliyle TEST EDILEMEZ
// olmasiydi -- ve testsiz kalan sey de tam olarak smoke ciftini dusuren daldi.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 1
  })
}
