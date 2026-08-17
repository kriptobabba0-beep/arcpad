import { readdirSync, readFileSync } from 'node:fs'
import type { AbiEvent, Address, Hex } from 'viem'
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import { bondingCurveAbi } from '@arcpad/shared/browser'
import type { DecodedEvent, RawLog, RpcClient } from '../src/logs'
import { createPacer, decodeAll, fetchRange } from '../src/logs'
import {
  ARCPAD_HOOK_SWAP_FEE_COLLECTED_EVENT,
  POOL_MANAGER_INITIALIZE_EVENT,
  POOL_MANAGER_SWAP_EVENT,
} from '../src/pool-events.generated'

/**
 * FIXTURE YUKLEYICI.
 *
 * Iki KAYNAK, ikisi de GERCEK YURUTMEDEN:
 *
 *   `contracts/fixtures/*.json`        Foundry, `vm.recordLogs()` (Task 4).
 *                                      EIP-7708 loglari YOKTUR -- Foundry
 *                                      standart bir EVM kosar.
 *   `contracts/fixtures/arc-live/`     Canli Arc testnet, `eth_getTransaction-
 *                                      Receipt` ciktisi AYNEN. 7708 loglari
 *                                      VARDIR.
 *
 * Ikisi de bu takimin URETMEDIGI bayttir. Elle yazilmis bir fixture, bu
 * depoda daha once tam olarak sunu yapti: sentetik makbuz `"CALL"` +
 * `additionalContracts` dolu modelledi, forge ise `"CREATE2"` + BOS yaziyordu.
 * Fixture gercekten daha comertti ve arizayi ilk gercek makbuz buldu.
 *
 * YUKLEYICININ URETTIGI TEK SEY, yerel fixture'larda EKSIK OLAN cerceve
 * alanlaridir: `transactionHash` (Foundry bir tx hash'i kaydetmiyor) ve
 * `blockNumber`/`blockTimestamp`in yeniden temellendirilmesi (butun yerel
 * fixture'lar blok 1'dedir, yani ust uste konduklarinda `event_seq` cakisir).
 * Bunlar COZUCUNUN OKUMADIGI alanlardir -- cozucu `address`, `topics`, `data`
 * uzerinde calisir ve o uc alan fixture'dan AYNEN gelir.
 */

const FIXTURE_DIR = new URL('../../contracts/fixtures/', import.meta.url)

export interface FixtureLog {
  logIndex: number
  address: string
  topics: Hex[]
  data: Hex
}

export interface FixtureFile {
  scenario: string
  source: string
  nativeTransferLogsOmitted: boolean
  chainId: number
  blockNumber: number
  blockTimestamp: number
  logs: FixtureLog[]
}

/** Diskteki senaryo adlari. ELLE YAZILMIS BIR LISTE DEGIL: yeni bir fixture
 *  dosyasi eklendigi anda senaryo kumesi testi kirilir ve o fixture'i
 *  kullanan bir test yazmaya ZORLAR. */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}

export function loadFixtureFile(name: string): FixtureFile {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8')) as FixtureFile
}

export interface RebaseOptions {
  /** Fixture'in loglarini bu bloga tasi. Varsayilan: dosyadaki blok. */
  block?: bigint
  /** Blok zamani (saniye). Varsayilan: dosyadaki `blockTimestamp`. */
  timestamp?: bigint
  /** Sentetik tx hash. Varsayilan: senaryo adindan turetilir. */
  txHash?: Hex
  /** `blockTimestamp` alanini DUSUR -- yedek yolu tetiklemek icin. */
  stripTimestamp?: boolean
}

function syntheticTxHash(name: string): Hex {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `0x${hash.toString(16).padStart(64, '0')}`
}

export function rawLogs(name: string, opts: RebaseOptions = {}): RawLog[] {
  const file = loadFixtureFile(name)
  const block = opts.block ?? BigInt(file.blockNumber)
  const timestamp = opts.timestamp ?? BigInt(file.blockTimestamp)
  const txHash = opts.txHash ?? syntheticTxHash(name)
  return file.logs.map((log) => {
    const out: RawLog = {
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: `0x${block.toString(16)}`,
      logIndex: `0x${log.logIndex.toString(16)}`,
      transactionHash: txHash,
      removed: false,
    }
    if (!opts.stripTimestamp) out.blockTimestamp = `0x${timestamp.toString(16)}`
    return out
  })
}

/**
 * Cozulmus olaylar. RPC'ye HIC DOKUNMAZ ve dokunamaz: gecirilen istemci her
 * cagrida patlar. Yani "fixture'in butun timestamp'leri logun ICINDE" iddiasi
 * bu yukleyicinin her kullaniminda otomatik olarak olculur.
 */
export async function fixtureEvents(
  name: string,
  opts: RebaseOptions = {},
): Promise<DecodedEvent[]> {
  const logs = rawLogs(name, opts)
  const block = opts.block ?? BigInt(loadFixtureFile(name).blockNumber)
  return decodeAll(NO_RPC, logs, block, block, createPacer())
}

export const NO_RPC: RpcClient = {
  request(args) {
    throw new Error(`fixture yolu RPC cagirdi: ${args.method}`)
  },
}

export interface LoadedFixture {
  name: string
  logs: RawLog[]
  events: DecodedEvent[]
}

export async function loadAllFixtures(): Promise<LoadedFixture[]> {
  const out: LoadedFixture[] = []
  for (const [index, name] of fixtureNames().entries()) {
    // Her senaryo AYRI bir bloga temellendirilir; hepsi dosyada blok 1'dedir
    // ve ust uste konduklarinda `event_seq` cakisirdi.
    const block = BigInt(54_661_437 + index)
    out.push({
      name,
      logs: rawLogs(name, { block }),
      events: await fixtureEvents(name, { block }),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Canli Arc makbuzlari
// ---------------------------------------------------------------------------

export interface SmokeReceipt {
  scenario: string
  transactionHash: Hex
  blockNumber: Hex
  to: string
  status: Hex
  logs: RawLog[]
}

export interface SmokeFile {
  source: string
  chainId: number
  nativeTransferEmitter: string
  receipts: SmokeReceipt[]
}

export function loadSmoke(): SmokeFile {
  return JSON.parse(
    readFileSync(new URL('arc-live/smoke-receipts.json', FIXTURE_DIR), 'utf8'),
  ) as SmokeFile
}

/** Canli smoke'un butun loglari, tek dizi, gercek blok/logIndex sirasinda. */
export function smokeLogs(): RawLog[] {
  return loadSmoke()
    .receipts.flatMap((r) => r.logs)
    .sort((a, b) => {
      const ab = BigInt(a.blockNumber)
      const bb = BigInt(b.blockNumber)
      if (ab !== bb) return ab < bb ? -1 : 1
      return Number(BigInt(a.logIndex) - BigInt(b.logIndex))
    })
}

/**
 * Bir adrese GIREN native tutar, Arc'in EIP-7708 loglarindan toplanir.
 *
 * Bu, zincirin kendi bakiye hareketidir: `0xfff...ffe` her native hareket
 * icin bir `Transfer` yayar, yani bir adresin aldigi toplam, o loglarin
 * toplamidir. Indexer bu loglari BILEREK gormez (yasakli yayinci); burada
 * yalnizca testin ZINCIR TARAFINI olcmesi icin kullaniliyor.
 */
export function nativeValueInto(logs: readonly RawLog[], address: string): bigint {
  const target = address.toLowerCase()
  let total = 0n
  for (const log of logs) {
    if (log.address.toLowerCase() !== '0xfffffffffffffffffffffffffffffffffffffffe') continue
    if (log.topics[0] !== TRANSFER_TOPIC0) continue
    if (`0x${log.topics[2]?.slice(26) ?? ''}`.toLowerCase() !== target) continue
    total += BigInt(log.data)
  }
  return total
}

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * ESCROW'A BAGIS: karsiliginda `Deposited` OLMAYAN bir native hareket.
 *
 * Zincirde bu `USDC.transfer(escrow, x)`tir; `FeeEscrow`'un NatSpec'i (kisit
 * 1) basarili oldugunu ve `receive()`in HIC calismadigini kaydediyor -- yani
 * para girer, defter bunu HIC duymaz, ve o para TALEP EDILEMEZ.
 *
 * Yuk gercek bir 7708 logundan alinir; yalnizca `to` ve tutar degisir.
 */
export function donationLog(
  to: string,
  amountWei: bigint,
  block: bigint,
  logIndex: number,
): RawLog {
  const template = smokeLogs().find(
    (l) => l.address.toLowerCase() === '0xfffffffffffffffffffffffffffffffffffffffe',
  )
  if (template === undefined) throw new Error('canli makbuzda 7708 logu yok')
  return {
    ...template,
    topics: [
      template.topics[0]!,
      template.topics[1]!,
      `0x${'0'.repeat(24)}${to.slice(2).toLowerCase()}`,
    ],
    data: `0x${amountWei.toString(16).padStart(64, '0')}`,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
  }
}

// ---------------------------------------------------------------------------
// FIXTURE'I OLMAYAN OLAYLAR
// ---------------------------------------------------------------------------

/**
 * GERCEK BIR YURUTME LOGU HENUZ URETILEMEYEN OLAYLAR, ADIYLA VE SEBEBIYLE.
 *
 * TEK BIR LISTE, iki test dosyasi tarafindan okunur (`topics.test.ts` ve
 * `logs.test.ts`). Ikisine ayri ayri yazilsaydi, biri kapatilip oteki
 * kapatilmadiginda ikisi de yesil kalirdi -- muafiyetin kendisi bir bosluga
 * donusurdu.
 *
 * `graduated`: `contracts/fixtures/*.json` YALNIZCA `make fixtures` ile
 * uretilir ve o `forge` ister; bu izlek `forge` kosamaz. Zincirden almak da
 * mumkun degil -- `graduate()` yalnizca `graduationTarget`in KENDISI
 * tarafindan cagrilabilir (`BondingCurve.sol:889`) ve o hedef uretimde sifir,
 * provada `0x…dEaD`. Yerine konan kapi: imza + indeksleme DERLENMIS ABI'den
 * dogrulanir ve cozucu, viem'in ABI cozucusune karsi diferansiyel test edilir.
 */
export const AWAITING_FIXTURE: Readonly<Record<string, string>> = Object.freeze({
  graduated:
    'make fixtures forge ister; zincirde graduate() yalnizca hedefin kendisi tarafindan cagrilabilir',
  // ============ HAVUZ KATMANI: HENUZ HICBIR HAVUZ YOK ============
  //
  // Uc olayin da fixture'i AYNI TEK OLGUYA baglidir ve o olgu bir zaman
  // penceresidir: uretim factory'sinin `graduationTarget`i BILEREK `0x0` ve
  // ilk gercek mezuniyet 2026-08-11T23:01:51Z'de acilan pencerede olur. Havuz
  // ancak `ArcpadLocker.graduate()` calistiginda ACILIR (`initialize` +
  // `modifyLiquidity`, tek islemde), yani `Swap`, `Initialize` ve
  // `SwapFeeCollected` icin gercek bir yurutme logu BUGUN URETILEMEZ --
  // zincirde de, `make fixtures` ile de (bu izlek `forge` kosamaz).
  //
  // YERINE KONAN KAPI, `graduated`inkiyle AYNI SEKILDE ve AYNI GUCTE:
  //   - imzalar `src/pool-events.generated.ts`ten dogrulanir -- o dosya
  //     `contracts/out/**`in COMMIT'LENMIS ozetidir ve `sync-pool-events`
  //     onu her uretiste `topic0`lara karsi tutar;
  //   - cozucu, viem'in ABI cozucusune karsi DIFERANSIYEL test edilir;
  //   - ve `constructedSwapLog` ailesi yuku ABI'den KODLAR, elle yazmaz.
  //
  // KAYBEDILEN SEY ADIYLA YAZILI OLSUN: gercek bir yurutmenin uretecegi
  // MIKTAR VE SIRA. Ozellikle `SwapFeeCollected`in `Swap`e gore ONCE mi SONRA
  // mi geldigi -- hook'un iki dali -- burada VARSAYIMA gore kuruluyor
  // (`ArcpadHook._beforeSwap`/`_afterSwap` okunarak), olculerek degil.
  poolSwap:
    'zincirde henuz hicbir havuz acilmadi (graduationTarget = 0x0); make fixtures forge ister',
  poolInitialize:
    'zincirde henuz hicbir havuz acilmadi (graduationTarget = 0x0); make fixtures forge ister',
  poolFee:
    'zincirde henuz hicbir havuz acilmadi (graduationTarget = 0x0); make fixtures forge ister',
})

/**
 * `contracts/fixtures/` ALTINDAKI HER JSON'DA gecen her `topics[0]`.
 *
 * `fixtureNames()` YALNIZCA UST DIZINI okur ve bu, `AWAITING_FIXTURE`in kendi
 * kendini silmeye zorlayan kapisinda BIR DELIKTI: `graduated` icin gecerli
 * degildi (o `make fixtures`la gelir, yani ust dizine), ama HAVUZ olaylari
 * icin tam tersi -- ilk gercek `Swap` bu depoya CANLI BIR MAKBUZ olarak,
 * `arc-live/` altina gelir. Ust dizine bakan bir kapi o gun sessizce yesil
 * kalirdi ve muafiyet, kapandigini kimsenin fark etmedigi bir bosluga
 * donusurdu.
 *
 * Tarama SEKILDEN BAGIMSIZDIR: iki fixture bicimi (`{logs: [...]}` ve
 * `{receipts: [{logs: [...]}]}`) farkli oldugu icin, uc yeni bicim daha
 * eklenebilsin diye `topics` alani tasiyan HER nesne aranir.
 */
export function allFixtureTopics(): Set<string> {
  const out = new Set<string>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const topics = record['topics']
    if (Array.isArray(topics) && typeof topics[0] === 'string') out.add(topics[0])
    for (const value of Object.values(record)) visit(value)
  }
  for (const file of fixtureJsonFiles()) {
    visit(JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), 'utf8')) as unknown)
  }
  return out
}

/**
 * TARAMANIN ERISIMI, AYRICA OLCULEBILSIN DIYE.
 *
 * `allFixtureTopics()`in IC ICE DIZINLERE indigini ICERIKTEN ispatlamak BUGUN
 * MUMKUN DEGIL: olculdu (2026-08-09), `arc-live/`in topic kumesi ust dizinin
 * ALT KUMESI -- ikisi de tam olarak ayni yedi `topic0`i tasiyor. Yani "derin
 * tarama daha cok sey buluyor" diye yazilmis bir iddia bugun VAKUMDA gecer ve
 * yarin, tam da kapanmasi gereken gun, hicbir sey soylemezdi.
 *
 * Bu yuzden erisim DOSYA LISTESI olarak olculur -- `rpc-errors.test.ts`in
 * "taranan kaynak kumesi eski elle yazilmis listeyi KAPSAR" kapisinin aynisi.
 */
export function fixtureJsonFiles(): string[] {
  const out: string[] = []
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(new URL(prefix, FIXTURE_DIR), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.json')) out.push(`${prefix}${entry.name}`)
    }
  }
  walk('')
  return out.sort()
}

/**
 * KURULMUS (URETILMEMIS) bir `Graduated` logu. ADI BUNU SOYLUYOR.
 *
 * BU BIR FIXTURE DEGILDIR ve `contracts/fixtures/` altina KONMAZ: o dizindeki
 * her bayt `vm.recordLogs()` ciktisidir ve elle yazilmis bir yuk oraya
 * girseydi, "fixture kontrattan sapamaz" iddiasi sessizce yalan olurdu.
 *
 * Yuk yine de bu takimin UYDURDUGU bir sekil DEGILDIR: topic'ler ve data,
 * `packages/shared/src/abi/bondingCurve.ts`teki ABI girisinden viem ile
 * kodlanir -- `abi-parity` CI is'inin gercek bir `forge build` ciktisiyla iki
 * yonlu karsilastirdigi tek kopya. Yani sekil derleyiciden gelir, degerler
 * cagirandan.
 */
export function constructedGraduatedLog(args: {
  curve: Address
  token: Address
  to: Address
  baseAmountTok: bigint
  quoteAmountWei: bigint
  block: bigint
  logIndex: number
  timestamp?: bigint
  txHash?: Hex
}): RawLog {
  const event = (bondingCurveAbi as unknown as AbiEvent[]).find(
    (e) => e.type === 'event' && e.name === 'Graduated',
  )
  if (event === undefined) throw new Error('derlenmis ABI de Graduated yok')
  // `encodeEventTopics` `(Hex | Hex[] | null)[]` doner cunku BIR FILTRE de
  // kodlayabilir (bir topic'e birden cok deger, ya da "her sey"). Burada iki
  // arguman da TEK bir adres, yani sonuc duz `Hex[]`tir -- ve bu VARSAYILMAZ,
  // OLCULUR: sekli bozuk bir topic dizisi cozucuyu sessizce baska bir yola
  // sokardi.
  const encoded = encodeEventTopics({
    abi: [event],
    eventName: 'Graduated',
    args: { token: args.token, to: args.to },
  })
  const topics = encoded.map((t) => {
    if (typeof t !== 'string') throw new Error(`beklenmeyen topic sekli: ${JSON.stringify(t)}`)
    return t
  })
  const data = encodeAbiParameters(
    event.inputs.filter((i) => i.indexed !== true),
    [args.baseAmountTok, args.quoteAmountWei],
  )
  return {
    address: args.curve,
    topics,
    data,
    blockNumber: `0x${args.block.toString(16)}`,
    logIndex: `0x${args.logIndex.toString(16)}`,
    transactionHash: args.txHash ?? syntheticTxHash('graduate'),
    blockTimestamp: `0x${(args.timestamp ?? 1_780_000_000n).toString(16)}`,
    removed: false,
  }
}

/**
 * ============ KURULMUS (URETILMEMIS) HAVUZ LOGLARI ============
 *
 * `constructedGraduatedLog` ile AYNI SOZLESME: yuk bu takimin UYDURDUGU bir
 * sekil DEGILDIR -- topic'ler ve `data`, `src/pool-events.generated.ts`teki
 * ABI girisinden viem ile kodlanir, ve o dosya `contracts/out/**`tan
 * `sync-pool-events` ile uretilir. Yani SEKIL derleyiciden gelir, DEGERLER
 * cagirandan. `contracts/fixtures/` altina KONMAZLAR.
 */
function constructedLog(
  event: AbiEvent,
  args: Record<string, unknown>,
  frame: { address: Address; block: bigint; logIndex: number; timestamp?: bigint; txHash?: Hex },
): RawLog {
  const encoded = encodeEventTopics({ abi: [event], eventName: event.name, args })
  const topics = encoded.map((t) => {
    if (typeof t !== 'string') throw new Error(`beklenmeyen topic sekli: ${JSON.stringify(t)}`)
    return t
  })
  const unindexed = event.inputs.filter((i) => i.indexed !== true)
  const data = encodeAbiParameters(
    unindexed,
    unindexed.map((i) => args[i.name as string]),
  )
  return {
    address: frame.address,
    topics,
    data,
    blockNumber: `0x${frame.block.toString(16)}`,
    logIndex: `0x${frame.logIndex.toString(16)}`,
    transactionHash: frame.txHash ?? syntheticTxHash('pool'),
    blockTimestamp: `0x${(frame.timestamp ?? 1_780_000_000n).toString(16)}`,
    removed: false,
  }
}

export function constructedSwapLog(args: {
  poolManager: Address
  poolId: Hex
  sender: Address
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  liquidity: bigint
  tick?: number
  fee?: number
  block: bigint
  logIndex: number
  timestamp?: bigint
  txHash?: Hex
}): RawLog {
  return constructedLog(
    POOL_MANAGER_SWAP_EVENT,
    {
      id: args.poolId,
      sender: args.sender,
      amount0: args.amount0,
      amount1: args.amount1,
      sqrtPriceX96: args.sqrtPriceX96,
      liquidity: args.liquidity,
      tick: args.tick ?? 0,
      // SIFIR, cunku `GraduationMath.POOL_FEE` sifirdir. Varsayilani sifir
      // yapmak, testlerin "havuz ucreti sifir" olgusunu her cagrida tekrar
      // yazmasini gereksiz kilar; sifir OLMAYAN hal ayrica test edilir.
      fee: args.fee ?? 0,
    },
    { ...args, address: args.poolManager },
  )
}

export function constructedPoolInitializeLog(args: {
  poolManager: Address
  poolId: Hex
  currency0: Address
  currency1: Address
  fee?: number
  tickSpacing?: number
  hooks: Address
  sqrtPriceX96: bigint
  tick?: number
  block: bigint
  logIndex: number
  timestamp?: bigint
  txHash?: Hex
}): RawLog {
  return constructedLog(
    POOL_MANAGER_INITIALIZE_EVENT,
    {
      id: args.poolId,
      currency0: args.currency0,
      currency1: args.currency1,
      fee: args.fee ?? 0,
      tickSpacing: args.tickSpacing ?? 60,
      hooks: args.hooks,
      sqrtPriceX96: args.sqrtPriceX96,
      tick: args.tick ?? 0,
    },
    { ...args, address: args.poolManager },
  )
}

export function constructedSwapFeeCollectedLog(args: {
  hook: Address
  poolId: Hex
  protocolFeeUnits: bigint
  creatorFeeUnits: bigint
  block: bigint
  logIndex: number
  timestamp?: bigint
  txHash?: Hex
}): RawLog {
  return constructedLog(
    ARCPAD_HOOK_SWAP_FEE_COLLECTED_EVENT,
    {
      id: args.poolId,
      protocolFee: args.protocolFeeUnits,
      creatorFee: args.creatorFeeUnits,
    },
    { ...args, address: args.hook },
  )
}

/** Canli smoke'un OLCULMUS adresleri. Adres kitabindan degil, makbuzdan. */
export const LIVE = {
  factory: '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439' as Address,
  token: '0x1bd93613a7bc470a739d9615cdc65e535d958fab' as Address,
  curve: '0x7938be340a14a12f94a83aea246d9d2566324c9c' as Address,
  escrow: '0xeed4431ead3e27f16d97f677a9c4c1a963df8dc6' as Address,
} as const

/**
 * CANLI smoke'un butun olaylari, cekme katmanindan GECEREK.
 *
 * Uygulama testleri olay nesnelerini ELLE KURMAZ; cozucunun ciktisini alir.
 * Elle kurmak, uygulayiciyi cozucunun yapmadigi bir sekle karsi test etmek
 * olurdu -- yani gecen ama hicbir sey ispatlamayan bir test.
 */
export async function liveDecodedEvents(): Promise<DecodedEvent[]> {
  const logs = smokeLogs()
  const first = BigInt(logs[0]!.blockNumber)
  const last = BigInt(logs[logs.length - 1]!.blockNumber)
  return fetchRange(
    new FakeNode(logs),
    {
      factory: LIVE.factory,
      escrow: LIVE.escrow,
      curves: new Set(),
      tokens: new Set(),
      curveToToken: new Map(),
      pools: new Map(),
      buyback: null,
    },
    first,
    last,
  )
}

// ---------------------------------------------------------------------------
// Sahte dugum
// ---------------------------------------------------------------------------

export interface FakeNodeOptions {
  /**
   * ADRES FILTRESINI YOK SAY. Deliverable'in olcumu budur: `Transfer`
   * sorgusundan `address` parametresi dustugunde ne olur.
   */
  ignoreAddressFilter?: boolean
  /** Bu sayidan fazla log donecekse RPC hatasi firlat. */
  maxResults?: number
  /** `maxResults` asildiginda kullanilacak kod. */
  errorCode?: number
  /** Loglardan `blockTimestamp`i dusur. */
  stripTimestamps?: boolean
  /** Yaniti TERS cevir -- sira iddiasini olcmek icin. */
  reverse?: boolean
  /** Butun loglara `removed: true` koy. */
  removed?: boolean
  /** `eth_getBlockByNumber` icin blok basina timestamp. */
  blockTimestamps?: ReadonlyMap<bigint, bigint>
}

export interface RecordedRequest {
  method: string
  params: unknown
}

/**
 * BIR DUGUMU taklit eder, INDEXER'I DEGIL.
 *
 * Sinir bilincli: bu sahte `eth_getLogs`in SUZME anlamini uygular (adres +
 * topic + aralik) cunku o dugumun isidir. Cozme, siralama, iddialar ve filtre
 * KURMA isi test edilen kodun uzerinde kalir -- sahte onlarin hicbirini
 * yapmaz. (Bu deponun bes ariza kipinden besincisi tam olarak burada olusur:
 * gercek kodun kendi isini yapan bir sahte.)
 */
export class FakeNode implements RpcClient {
  readonly requests: RecordedRequest[] = []

  constructor(
    private readonly logs: readonly RawLog[],
    private readonly options: FakeNodeOptions = {},
  ) {}

  /** `eth_getLogs` cagrilarinin filtreleri, geldigi sirada. */
  get logFilters(): Record<string, unknown>[] {
    return this.requests
      .filter((r) => r.method === 'eth_getLogs')
      .map((r) => (r.params as Record<string, unknown>[])[0] as Record<string, unknown>)
  }

  async request(args: { method: string; params?: unknown }): Promise<unknown> {
    this.requests.push({ method: args.method, params: args.params })
    if (args.method === 'eth_getBlockByNumber') {
      const [tag] = args.params as [Hex, boolean]
      const ts = this.options.blockTimestamps?.get(BigInt(tag))
      return ts === undefined ? null : { number: tag, timestamp: `0x${ts.toString(16)}` }
    }
    if (args.method !== 'eth_getLogs') throw new Error(`beklenmeyen metod: ${args.method}`)

    const [filter] = args.params as [Record<string, unknown>]
    const from = BigInt(filter['fromBlock'] as Hex)
    const to = BigInt(filter['toBlock'] as Hex)
    const address = filter['address']
    const wanted =
      address === undefined || this.options.ignoreAddressFilter === true
        ? null
        : new Set(
            (Array.isArray(address) ? (address as string[]) : [address as string]).map((a) =>
              a.toLowerCase(),
            ),
          )
    const topics = filter['topics'] as (Hex | Hex[])[] | undefined

    let hits = this.logs.filter((log) => {
      const block = BigInt(log.blockNumber)
      if (block < from || block > to) return false
      if (wanted !== null && !wanted.has(log.address.toLowerCase())) return false
      if (topics !== undefined) {
        for (const [i, want] of topics.entries()) {
          if (want === undefined || want === null) continue
          const have = log.topics[i]
          const list = Array.isArray(want) ? want : [want]
          if (have === undefined || !list.includes(have)) return false
        }
      }
      return true
    })

    const max = this.options.maxResults
    if (max !== undefined && hits.length > max) {
      const code = this.options.errorCode ?? -32602
      const message =
        code === -32602
          ? `query exceeds max results ${max}, retry with the range ${from}-${from + (to - from) / 2n}`
          : code === -32012
            ? 'requested range too large'
            : 'eth_getLogs is limited to a 10,000 range'
      throw Object.assign(new Error(message), { code })
    }

    if (this.options.stripTimestamps === true) {
      hits = hits.map((log) => {
        const copy: RawLog = { ...log }
        delete copy.blockTimestamp
        return copy
      })
    }
    if (this.options.removed === true) hits = hits.map((log) => ({ ...log, removed: true }))
    if (this.options.reverse === true) hits = [...hits].reverse()
    return hits
  }
}
