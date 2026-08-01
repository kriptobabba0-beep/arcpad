import { readdirSync, readFileSync } from 'node:fs'
import type { Address, Hex } from 'viem'
import type { DecodedEvent, RawLog, RpcClient } from '../src/logs'
import { createPacer, decodeAll, fetchRange } from '../src/logs'

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
    { factory: LIVE.factory, escrow: LIVE.escrow, curves: new Set(), tokens: new Set() },
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
