import { AsyncLocalStorage } from 'node:async_hooks'
import type { Address, Hex } from 'viem'
import { hexToString } from 'viem'
import { toSeq } from '@arcpad/db'
import {
  ADDRESS_FILTER_CHUNK,
  isForbiddenEmitter,
  KIND_BY_TOPIC0,
  TOPIC0,
  type EventKind,
} from './arc'

/**
 * CEKME KATMANI.
 *
 * Bu dosyanin tek isi sudur: bir blok araligindan, arcpad'e AIT olan loglari,
 * SIRALI ve COZULMUS olarak getirmek. "arcpad'e ait" olmanin birinci yarisi
 * burada, RPC tarafinda, `address` filtresiyle kurulur; ikinci yarisi Task
 * 6'nin CREATE2 turetmesidir.
 *
 * VERITABANINA GUVENMIYORUZ. Sema, `token_transfers.token` ve `holders.token`
 * uzerindeki yabanci anahtarla EIP-7708 loglarini reddeder ve
 * `0x3600...0000`'i bir CHECK ile disari atar. Bu yapisal savunma DURUYOR ama
 * BU KATMANIN GEREKCESI DEGIL: hic cekilmemesi gereken bir seyi veritabaninin
 * yakalamasina birakmak, duvari veri yolunun EN SONUNA koymak olurdu.
 */

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------

/**
 * `eth_getLogs`'un HAM yaniti. viem'in `Log` tipi DEGILDIR ve bilerek oyle:
 *
 * - Alanlar onaltiliktir (`0x...`), cunku RPC oyle dondurur.
 * - `blockTimestamp` viem'in `Log` tipinde YOKTUR ama Arc'ta HER logda vardir
 *   (olculdu: "blockTimestamp":"0x6a6a7f0a"). Calisma zamaninda var olan bir
 *   alani tip sistemi bilmiyorsa, o alan sessizce kullanilmaz hale gelir ve
 *   blok basina bir ek istege duseriz.
 */
export interface RawLog {
  address: string
  topics: readonly Hex[]
  data: Hex
  blockNumber: Hex
  logIndex: Hex
  transactionHash: Hex
  blockTimestamp?: Hex
  removed?: boolean
}

/** Bir logun kimligi ve zamani. Butun cozulmus olaylar bunu tasir. */
export interface LogRef {
  /** `block_number << 20 | log_index`. Tek anahtar, tek sira. */
  seq: bigint
  blockNumber: bigint
  logIndex: number
  txHash: Hex
  blockTime: Date
}

export interface LaunchedEvent extends LogRef {
  kind: 'launched'
  /** Logu yayan factory. Provenance'in birinci yarisi budur. */
  factory: Address
  token: Address
  curve: Address
  creator: Address
  name: string
  symbol: string
  uri: string
  /**
   * ZINCIRDEKI HAM BAYTLAR. `name`'den TURETILMEZ ve turetilemez:
   * `hexToString` gecersiz UTF-8 dizilerini U+FFFD yapar, geri kodlamak baska
   * baytlar verir, ve token kimligi CREATE2 ile HAM baytlardan turer.
   */
  nameHex: Hex
  symbolHex: Hex
  uriHex: Hex
  salt: Hex
  /**
   * LOGUN KENDISI, cozulmemis.
   *
   * `rejected_launches` reddedilen bir launch'i YALNIZCA onaltilik olarak
   * saklar (`raw_addr`, `raw_topics_hex`, `raw_data_hex`) ve bunlar cozulmus
   * alanlardan YENIDEN KURULAMAZ -- kurulabilseydi tablonun varlik sebebi
   * ortadan kalkardi. Bu yuzden ham log, reddi yazan katmana kadar tasinir.
   */
  rawTopics: readonly Hex[]
  rawData: Hex
}

export interface TradeEvent extends LogRef {
  kind: 'trade'
  /**
   * `Trade` TOKEN ADRESINI TASIMAZ. Kimlik `log.address` = curve adresidir;
   * curve->token eslemesi YALNIZCA `Launched`'dan gelir. Iki fazli cekisin iki
   * sebebinden biri budur.
   */
  curve: Address
  trader: Address
  /**
   * YON. `Trade` TEK bir olaydir ve bu bayrak INDEKSLI DEGILDIR -- yani yonu
   * bir topic'ten SUZEMEYIZ. Alim ve satimi ayri topic'lerle ayirmaya calisan
   * bir cekme yolu ikisini de kacirir.
   */
  isBuy: boolean
  tokenAmountTok: bigint
  quoteAmountWei: bigint
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
}

export interface CompletedEvent extends LogRef {
  kind: 'completed'
  curve: Address
  token: Address
  realQuoteReservesWei: bigint
  poolSeedSupplyTok: bigint
}

export interface DepositedEvent extends LogRef {
  kind: 'deposited'
  escrow: Address
  recipient: Address
  /** Yatiran curve. Ucretin hangi launch'tan geldigi YALNIZCA buradan bilinir. */
  from: Address
  amountWei: bigint
}

export interface ClaimedEvent extends LogRef {
  kind: 'claimed'
  escrow: Address
  recipient: Address
  amountWei: bigint
}

export interface TransferEvent extends LogRef {
  kind: 'transfer'
  token: Address
  from: Address
  to: Address
  amountTok: bigint
}

export type DecodedEvent =
  LaunchedEvent | TradeEvent | CompletedEvent | DepositedEvent | ClaimedEvent | TransferEvent

/**
 * Izlenen adresler. `curves` ve `tokens` KUME'dir cunku her aralikta buyurler
 * (Faz 1.5) ve uyelik sorgusu sicak yoldadir.
 */
export interface WatchSet {
  factory: Address
  escrow: Address
  curves: ReadonlySet<Address>
  tokens: ReadonlySet<Address>
}

/** Minimal RPC yuzeyi. viem'in `PublicClient`'i bunu KARSILAR. */
export interface RpcClient {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Hatalar
// ---------------------------------------------------------------------------

/**
 * EIP-7708 DUVARININ KENDISI.
 *
 * BU HATAYA DUSMEK, adres filtresinin dustugu anlamina gelir. Sessizce
 * atlamak tuzagi geri getirirdi: `0xfff...ffe` 18 decimal NATIVE USDC
 * hareketini, `0x3600...0000` ise AYNI hareketin 6 decimal gorunumunu yayar
 * (olculdu, ayni tx'te logIndex 0 ve 1). Ikisi de LaunchToken bakiyesi
 * DEGILDIR ve ikisi de bir holder deltasi olarak uygulanirsa bakiye
 * bozulur.
 */
export class ForbiddenEmitter extends Error {
  constructor(readonly emitter: string) {
    super(
      `ForbiddenEmitter: ${emitter} bir sistem emitter'i; adres filtresi dusmus. ` +
        `Bu log bir LaunchToken hareketi DEGILDIR (EIP-7708).`,
    )
    this.name = 'ForbiddenEmitter'
  }
}

/** Yanit (blockNumber, logIndex) sirasinda GELMEDI. */
export class UnorderedLogs extends Error {
  constructor(
    readonly previous: bigint,
    readonly current: bigint,
  ) {
    super(`UnorderedLogs: event_seq ${current} <= onceki ${previous}`)
    this.name = 'UnorderedLogs'
  }
}

/** Istenen araligin DISINDA bir log geldi. */
export class LogOutOfRange extends Error {
  constructor(
    readonly blockNumber: bigint,
    readonly from: bigint,
    readonly to: bigint,
  ) {
    super(`LogOutOfRange: blok ${blockNumber}, istenen aralik ${from}-${to}`)
    this.name = 'LogOutOfRange'
  }
}

/**
 * `removed: true`. Arc'ta reorg YOKTUR (deterministik finality, ~350ms);
 * boyle bir log gormek RPC'nin Arc olmadiginin kanitidir -- yok saymak degil,
 * DURMAK gerekir.
 */
export class RemovedLog extends Error {
  constructor(readonly blockNumber: bigint) {
    super(`RemovedLog: blok ${blockNumber} icin removed=true geldi; Arc'ta reorg yoktur`)
    this.name = 'RemovedLog'
  }
}

/** Ne logda ne de blokta `timestamp` var. Zamansiz bir olay yazilamaz. */
export class MissingTimestamp extends Error {
  constructor(readonly blockNumber: bigint) {
    super(`MissingTimestamp: blok ${blockNumber} icin ne logda ne blokta timestamp var`)
    this.name = 'MissingTimestamp'
  }
}

/**
 * TEK BIR BLOK sonuc sinirini asiyor. Blok bolme burada TUKENIR; geriye adres
 * filtresini bolmek kalir. Yol yazilmistir cunku "burada duruyoruz" demek, bir
 * gun sessizce sonsuz donmek demektir.
 */
export class SingleBlockTooLarge extends Error {
  constructor(readonly blockNumber: bigint) {
    super(
      `SingleBlockTooLarge: blok ${blockNumber} tek basina sonuc sinirini asiyor; ` +
        `blok bolme tukendi, adres filtresini bolmek gerekir`,
    )
    this.name = 'SingleBlockTooLarge'
  }
}

/** Bolme derinligi tukendi: RPC her seferinde reddediyor ve aralik kuculmuyor. */
export class SplitDepthExceeded extends Error {
  constructor(
    readonly from: bigint,
    readonly to: bigint,
  ) {
    super(`SplitDepthExceeded: ${from}-${to} araligi bolunmeye devam ediyor`)
    this.name = 'SplitDepthExceeded'
  }
}

/**
 * Logun sekli imzasiyla ortusmuyor (topic sayisi, `data` uzunlugu, ya da bir
 * dizge offset'i `data`nin disini gosteriyor).
 *
 * BRIEF'TE YOKTUR, EKLENDI. Gerekce: `forged.json` bir sahtecinin GERCEK
 * `topic0` ile log yayabildigini gosteriyor. Sekli kontrol etmeyen bir cozucu
 * kisa bir `data`dan sifir okur ve YANLIS BIR SAYIYI sessizce ureticiye verir
 * -- yani kullaniciya yanlis bir rakam gosterir. Kisa okumanin kendisi bir
 * hata olmali.
 */
export class MalformedLog extends Error {
  constructor(
    readonly kind: EventKind,
    reason: string,
  ) {
    super(`MalformedLog(${kind}): ${reason}`)
    this.name = 'MalformedLog'
  }
}

// ---------------------------------------------------------------------------
// Pacing -- "es zamanli VE ardisik" ikisi de sinirli
// ---------------------------------------------------------------------------

export interface Pacer {
  run<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * Arc hem ES ZAMANLI hem ARDISIK istekleri hizlandirinca reddediyor (olculdu:
 * `eth_call`larda). Bu yuzden cekme katmani `Promise.all` YAZAR ama gercekten
 * paralel KOSMAZ: dort sorgu da bu kuyruktan gecer.
 *
 * Varsayilan `concurrency: 1`: bir aralikta dort sorgu var ve hepsi ayni
 * dugume gidiyor; paralellik kazanci ~0, red riski gercek.
 * `minIntervalMs` istekler ARASINA en az bir bosluk koyar -- ardisik hiz
 * siniri icin gereken sey budur ve es zamanlilik siniri onu VERMEZ.
 */
export function createPacer(opts?: { concurrency?: number; minIntervalMs?: number }): Pacer {
  const concurrency = Math.max(1, opts?.concurrency ?? 1)
  const minIntervalMs = Math.max(0, opts?.minIntervalMs ?? 0)
  let active = 0
  let lastStart = 0
  const queue: (() => void)[] = []

  const release = (): void => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }

  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const start = (): void => {
        active += 1
        const wait = Math.max(0, lastStart + minIntervalMs - Date.now())
        // ARALIK, ISTEGIN GERCEKTEN BASLADIGI ANDAN olculur -- PLANLANDIGI
        // andan degil.
        //
        // Onceki hali `lastStart = Date.now() + wait` yaziyordu, yani slotu
        // ILERIDE bir zamana rezerve ediyordu. Zamanlayici gec atesledigi ya
        // da olay dongusu takildigi anda o rezervasyon GECMISTE kalir ve
        // sirada bekleyen istekler `wait = 0` hesaplayip PATLAMA halinde
        // cikar. Arc hem es zamanli hem ARDISIK istekleri sinirladigi icin
        // bu, hiz sinirina tosladigimiz tam an olurdu; testte ise gecici bir
        // takilmadan sonra kirilan bir olcum olarak gorunur (yuk altinda
        // flake).
        const begin = (): void => {
          lastStart = Date.now()
          resolve()
        }
        if (wait === 0) begin()
        else setTimeout(begin, wait)
      }
      if (active < concurrency) start()
      else queue.push(start)
    })

  /**
   * IC ICE `run` KILITLENIR VE SESSIZ ASILIR -- BU YUZDEN YASAK.
   *
   * OLCULDU: canli entegrasyon testinin ilk hali istemciyi `pacer.run(...)`
   * ile sarmalayip AYNI pacer'i indexer'a da veriyordu. `concurrency: 1` iken
   * dis `run` tek slotu tutar, ic `run` ayni slotu bekler ve hicbiri
   * ilerlemez. Hicbir hata cikmaz: surec ASILIR. `beforeAll` iki kez 300
   * saniyede timeout oldu ve sebep ancak vitest'in disinda gorundu.
   *
   * Bir bayrak yetiyor cunku bu havuz TEK bir olay dongusunde, tek yonlu bir
   * cagri zincirinde kullaniliyor: `run` icinden yapilan her cagri, o `run`
   * bitmeden calisir. Kilitlenmeyi bir HATAYA cevirmek, onu bes dakikalik bir
   * sessizlikten bir satirlik teshise indirir.
   */
  // `AsyncLocalStorage` SART: duz bir bayrak ES ZAMANLI cagrilari da ic ice
  // sanardi. `fetchRange` uc sorguyu `Promise.all` ile baslatir; ilki slotu
  // alip beklerken ikincisi `run`a girer ve bir bayrak onu -- yanlislikla --
  // ic ice sayardi. Olculdu: bayrakli hal suite'te 20 testi kirdi. Depolama,
  // yalnizca AYNI async zincirindeki cagrilari isaretler.
  const nesting = new AsyncLocalStorage<true>()

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (nesting.getStore() === true) {
        throw new Error(
          'Pacer.run ic ice cagrildi: bu KILITLENIR (concurrency=1, dis cagri slotu tutar). ' +
            'Ya istemciyi sarmalayin YA DA pacer i gecirin -- ikisini birden degil.',
        )
      }
      await acquire()
      try {
        return await nesting.run(true, fn)
      } finally {
        release()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// RPC hata taksonomisi
// ---------------------------------------------------------------------------

/**
 * Arc'in `eth_getLogs`'unun UC ayri ret sekli vardir ve ucu de OLCULDU:
 *   -32012 "requested range too large"                    (span 50.000)
 *   -32614 "eth_getLogs is limited to a 10,000 range"     (span 100.000)
 *   -32602 "query exceeds max results 20000, retry with the range A-B"
 *
 * Tek bir kodu yakalayan bir retry, obur ikisinde imleci ilerletmeden sonsuz
 * doner. -32602 DOGRU ARALIGI KENDISI SOYLER, bu yuzden once o ayristirilir.
 */
const RANGE_ERROR_CODES = new Set([-32602, -32012, -32614])
const SUGGESTED = /retry with the range (\d+)-(\d+)/

/** Bolme derinligi tavani. 1.000 bloktan tek bloga 10 seviye yeter; 32 boldur. */
const MAX_SPLIT_DEPTH = 32

export interface RpcErrorShape {
  code?: number
  /** HTTP durum kodu -- transport bildiriyorsa. viem `HttpRequestError.status`. */
  status?: number
  /**
   * YALNIZCA SUNUCUNUN URETTIGI METIN. Siniflandirma BUNUN uzerinde yapilir.
   *
   * `message` (asagida) viem'in BICIMLENDIRDIGI bloktur ve icinde
   * `URL: <rpcUrl>` ile `Request body: {...}` GECER -- yani BIZIM gonderdigimiz
   * seyler. Onun uzerinde desen aramak, kendi konfigurasyonumuzu siniflandirma
   * girdisine cevirir. OLCULDU (2026-08-04, canli): Arc'in RPC'si
   * `https://rpc.testnet.arc.network` adresinde ve `isTransient`'in
   * `/network/i` deseni ADRESIN KENDISINE tutuyordu, boylece BUTUN hatalar --
   * `-32601 method not supported`, `-32602 invalid params`, `3 execution
   * reverted` dahil -- GECICI sayiliyordu. Dosyanin yazili varsayilani
   * ("bilinmeyen hata KALICIDIR") uretimde TERSINE donmustu.
   *
   * Duz bir transport (`{code, message}`) `details`/`shortMessage` tasimaz;
   * o durumda `message`'a duseriz, cunku orada `message` ZATEN sunucunun
   * metnidir.
   */
  details: string
  /** Bicimlendirilmis tam metin -- YALNIZCA GUNLUKLEME icin. */
  message: string
}

/**
 * viem hatayi sarar (`RpcRequestError` -> `.cause`), duz bir transport ise
 * `{code, message}` firlatir. Ikisini de okumak zorundayiz: yalnizca birini
 * okuyan bir ayristirici, obur tarafta HER retry'i kacirir ve o zaman hata
 * yukari kacar.
 */
export function asRpcError(error: unknown): RpcErrorShape {
  let code: number | undefined
  let status: number | undefined
  const messages: string[] = []
  const details: string[] = []
  let node: unknown = error
  for (let depth = 0; node !== null && node !== undefined && depth < 10; depth += 1) {
    const obj = node as Record<string, unknown>
    if (code === undefined && typeof obj['code'] === 'number') code = obj['code']
    if (status === undefined && typeof obj['status'] === 'number') status = obj['status']
    for (const key of ['details', 'shortMessage']) {
      const v = obj[key]
      if (typeof v === 'string') details.push(v)
    }
    const message = obj['message']
    if (typeof message === 'string') messages.push(message)
    node = obj['cause']
  }
  const shape: RpcErrorShape = {
    message: [...messages, ...details].join(' | '),
    // viem'de `details` VAR; duz transport'ta yok ve orada `message` sunucunun
    // kendi metnidir.
    details: (details.length > 0 ? details : messages).join(' | '),
  }
  if (code !== undefined) shape.code = code
  if (status !== undefined) shape.status = status
  return shape
}

export interface GetLogsParams {
  from: bigint
  to: bigint
  address?: readonly Address[] | Address
  topics?: readonly (Hex | Hex[])[]
}

function toFilter(p: GetLogsParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    fromBlock: `0x${p.from.toString(16)}`,
    toBlock: `0x${p.to.toString(16)}`,
  }
  // `address` YOKSA ALAN DA YOKTUR ve bu bilerek boyle: `undefined` bir alan
  // bazi transport'larda `null` olarak serilesir ve `null` "filtre yok"
  // demektir. Cagiranin filtre GECIRDIGINI saniyorken filtresiz sorulmasi tam
  // olarak EIP-7708 tuzagidir.
  if (p.address !== undefined) filter['address'] = p.address
  if (p.topics !== undefined) filter['topics'] = p.topics
  return filter
}

/**
 * `eth_getLogs` + bolme. Donen dizi (blockNumber, logIndex) sirasindadir ve
 * bu KONTROL EDILIR: yanitin sirali geldigi OLCULDU, ama holder deltalari
 * siraya bagimlidir ve sirayi varsaymak "kimsenin yazmadigi bir sebeple gecen
 * test"in ta kendisidir.
 */
export async function getLogs(
  client: RpcClient,
  params: GetLogsParams,
  pacer: Pacer,
  depth = 0,
): Promise<RawLog[]> {
  if (params.to < params.from) return []
  let raw: RawLog[]
  try {
    raw = (await pacer.run(() =>
      client.request({ method: 'eth_getLogs', params: [toFilter(params)] }),
    )) as RawLog[]
  } catch (error) {
    const { code, details } = asRpcError(error)
    if (code !== undefined && RANGE_ERROR_CODES.has(code)) {
      if (depth >= MAX_SPLIT_DEPTH) throw new SplitDepthExceeded(params.from, params.to)
      if (code === -32602) {
        // ONERI, SUNUCUNUN METNINDE aranir -- bicimlendirilmis blokta DEGIL.
        // O blok `Request body`'yi de tasir, yani BIZIM gonderdigimiz araligi;
        // orada arama yapmak sunucunun onerisiyle kendi sorgumuzu ayirt
        // edememek demektir.
        const m = SUGGESTED.exec(details)
        if (m?.[2] !== undefined) {
          const suggested = BigInt(m[2])
          // ONERIYI YALNIZCA ARALIGI GERCEKTEN KUCULTUYORSA kullaniriz.
          // Brief bunu kosulsuz yaziyor ve o hali bir sonsuz dongudur: `B >=
          // to` oneren bir sunucuda `splitAt` ayni araligi tekrar sorar,
          // tekrar reddedilir, ve imlec HIC ilerlemez. Kosul olculmus bir
          // arizadan degil, olcunun kendi bicimindendir -- "A-B" bir tavsiye,
          // bir garanti degil.
          if (suggested >= params.from && suggested < params.to) {
            return splitAt(client, params, suggested, pacer, depth + 1)
          }
        }
      }
      if (params.to === params.from) throw new SingleBlockTooLarge(params.from)
      return splitAt(client, params, params.from + (params.to - params.from) / 2n, pacer, depth + 1)
    }
    throw error
  }
  assertResponseOrdered(raw)
  return raw
}

async function splitAt(
  client: RpcClient,
  params: GetLogsParams,
  mid: bigint,
  pacer: Pacer,
  depth: number,
): Promise<RawLog[]> {
  const left = await getLogs(client, { ...params, to: mid }, pacer, depth)
  const right = await getLogs(client, { ...params, from: mid + 1n }, pacer, depth)
  return [...left, ...right]
}

/**
 * YANIT ICI SIRA. Bu, RPC'nin iddiasini olcen tek yerdir: dort sorgunun
 * BIRLESIMI zaten sirali degildir ve `fetchRange` onu kendisi siralar, yani
 * birlesim uzerindeki kontrol RPC hakkinda hicbir sey soylemezdi.
 */
function assertResponseOrdered(raw: readonly RawLog[]): void {
  let prev: bigint | undefined
  for (const log of raw) {
    const seq = toSeq(BigInt(log.blockNumber), Number(BigInt(log.logIndex)))
    if (prev !== undefined && seq <= prev) throw new UnorderedLogs(prev, seq)
    prev = seq
  }
}

/**
 * Adres listesini `ADDRESS_FILTER_CHUNK`'luk parcalara boler. BOS LISTE HIC
 * SORULMAZ: `address: []` bazi dugumlerde "filtre yok" demektir ve o an
 * EIP-7708'in butun loglarini geri getirir. Ilk aralikta `tokens` bos oldugu
 * icin bu yol GERCEKTEN kosulur.
 */
export async function getLogsChunked(
  client: RpcClient,
  addresses: readonly Address[],
  topics: readonly (Hex | Hex[])[],
  from: bigint,
  to: bigint,
  pacer: Pacer,
  chunkSize: number = ADDRESS_FILTER_CHUNK,
): Promise<RawLog[]> {
  if (addresses.length === 0) return []
  const out: RawLog[] = []
  for (let i = 0; i < addresses.length; i += chunkSize) {
    out.push(
      ...(await getLogs(
        client,
        { from, to, address: addresses.slice(i, i + chunkSize), topics },
        pacer,
      )),
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Cozucu
// ---------------------------------------------------------------------------

const WORD = 64

function word(data: Hex, index: number): Hex {
  return `0x${data.slice(2 + index * WORD, 2 + (index + 1) * WORD)}`
}

function wordCount(data: Hex): number {
  return Math.floor((data.length - 2) / WORD)
}

function uint(data: Hex, index: number): bigint {
  return BigInt(word(data, index))
}

function addressFrom(topic: Hex): Address {
  return `0x${topic.slice(-40)}`.toLowerCase() as Address
}

function addressOf(log: RawLog): Address {
  return log.address.toLowerCase() as Address
}

/**
 * `data` icindeki bir `string`in HAM baytlari.
 *
 * `hexToString`'e verilip geri kodlanamaz: gecersiz UTF-8 sessizce U+FFFD
 * olur ve CREATE2 turetmesi baska bir adres uretir. Dilim BURADA, cozulmeden
 * once alinir.
 */
function dynamicBytes(kind: EventKind, data: Hex, headIndex: number): Hex {
  const words = wordCount(data)
  const offset = uint(data, headIndex)
  if (offset % 32n !== 0n || offset / 32n >= BigInt(words)) {
    throw new MalformedLog(kind, `dizge offset'i data disinda: ${offset}`)
  }
  const lengthWord = Number(offset / 32n)
  const length = uint(data, lengthWord)
  const startHex = 2 + (lengthWord + 1) * WORD
  const endHex = startHex + Number(length) * 2
  if (length > BigInt(data.length) || endHex > data.length) {
    throw new MalformedLog(kind, `dizge uzunlugu data disinda: ${length}`)
  }
  return `0x${data.slice(startHex, endHex)}`
}

function expect(kind: EventKind, log: RawLog, topics: number, words: number): void {
  if (log.topics.length !== topics) {
    throw new MalformedLog(kind, `${topics} topic bekleniyordu, ${log.topics.length} geldi`)
  }
  if (wordCount(log.data) < words) {
    throw new MalformedLog(kind, `data ${words} kelime olmali, ${wordCount(log.data)} kelime geldi`)
  }
}

function decodeLaunched(log: RawLog, ref: LogRef): LaunchedEvent {
  expect('launched', log, 4, 4)
  const nameHex = dynamicBytes('launched', log.data, 0)
  const symbolHex = dynamicBytes('launched', log.data, 1)
  const uriHex = dynamicBytes('launched', log.data, 2)
  return {
    kind: 'launched',
    ...ref,
    factory: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    curve: addressFrom(log.topics[2] as Hex),
    creator: addressFrom(log.topics[3] as Hex),
    name: hexToString(nameHex),
    symbol: hexToString(symbolHex),
    uri: hexToString(uriHex),
    nameHex,
    symbolHex,
    uriHex,
    salt: word(log.data, 3),
    rawTopics: log.topics,
    rawData: log.data,
  }
}

function decodeTrade(log: RawLog, ref: LogRef): TradeEvent {
  expect('trade', log, 2, 9)
  return {
    kind: 'trade',
    ...ref,
    curve: addressOf(log),
    trader: addressFrom(log.topics[1] as Hex),
    // `bool` bir kelimedir ve SIFIR DEGILSE dogrudur. `=== 1n` yazmak,
    // ABI'nin garanti etmedigi bir seye guvenmek olurdu.
    isBuy: uint(log.data, 0) !== 0n,
    tokenAmountTok: uint(log.data, 1),
    quoteAmountWei: uint(log.data, 2),
    protocolFeeWei: uint(log.data, 3),
    creatorFeeWei: uint(log.data, 4),
    virtualTokenReservesTok: uint(log.data, 5),
    virtualQuoteReservesWei: uint(log.data, 6),
    realTokenReservesTok: uint(log.data, 7),
    realQuoteReservesWei: uint(log.data, 8),
  }
}

function decodeCompleted(log: RawLog, ref: LogRef): CompletedEvent {
  expect('completed', log, 2, 2)
  return {
    kind: 'completed',
    ...ref,
    curve: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    realQuoteReservesWei: uint(log.data, 0),
    poolSeedSupplyTok: uint(log.data, 1),
  }
}

function decodeDeposited(log: RawLog, ref: LogRef): DepositedEvent {
  expect('deposited', log, 3, 1)
  return {
    kind: 'deposited',
    ...ref,
    escrow: addressOf(log),
    recipient: addressFrom(log.topics[1] as Hex),
    from: addressFrom(log.topics[2] as Hex),
    amountWei: uint(log.data, 0),
  }
}

function decodeClaimed(log: RawLog, ref: LogRef): ClaimedEvent {
  expect('claimed', log, 2, 1)
  return {
    kind: 'claimed',
    ...ref,
    escrow: addressOf(log),
    recipient: addressFrom(log.topics[1] as Hex),
    amountWei: uint(log.data, 0),
  }
}

function decodeTransfer(log: RawLog, ref: LogRef): TransferEvent {
  // EIP-7708 DUVARI. Bkz. `ForbiddenEmitter`.
  if (isForbiddenEmitter(log.address)) throw new ForbiddenEmitter(log.address.toLowerCase())
  expect('transfer', log, 3, 1)
  return {
    kind: 'transfer',
    ...ref,
    token: addressOf(log),
    from: addressFrom(log.topics[1] as Hex),
    to: addressFrom(log.topics[2] as Hex),
    amountTok: uint(log.data, 0),
  }
}

/**
 * Olay adi -> cozucu. Kapsam testi bu nesnenin ANAHTARLARINI kullanir: bir
 * olay eklenip cozucusu yazilmadiginda, ya da cozucu yazilip hicbir fixture
 * onu egzersiz etmediginde test kirilir.
 */
export const DECODERS: Readonly<Record<EventKind, (log: RawLog, ref: LogRef) => DecodedEvent>> =
  Object.freeze({
    launched: decodeLaunched,
    trade: decodeTrade,
    completed: decodeCompleted,
    deposited: decodeDeposited,
    claimed: decodeClaimed,
    transfer: decodeTransfer,
  })

// ---------------------------------------------------------------------------
// fetchRange
// ---------------------------------------------------------------------------

export interface FetchOptions {
  pacer?: Pacer
  addressChunk?: number
  /**
   * `blockTimestamp` eksik oldugunda cagrilir. SESSIZ DUSMEK YASAK: o yol blok
   * basina bir ek istek demektir ve sessiz bir performans ucurumu bir hatadan
   * daha kotudur -- kimse aramaz.
   */
  onTimestampFallback?: (blocks: readonly bigint[]) => void
}

function defaultTimestampWarning(blocks: readonly bigint[]): void {
  console.warn(
    `[indexer] eth_getLogs ${blocks.length} blok icin blockTimestamp DONDURMEDI; ` +
      `blok basina bir ek eth_getBlockByNumber cagrisina dusuluyor. ` +
      `Arc'ta bu alan olculmustu (ornek "0x6a6a7f0a") -- RPC degismis olabilir.`,
  )
}

/**
 * Bir blok araligindaki butun arcpad olaylari, `event_seq`'e gore SIRALI.
 *
 * IKI FAZLIDIR VE TEK FAZLI BIR TASARIMIN GERCEK HATASINI KAPATIR: tek fazli
 * bir cekiste `Transfer` sorgusu `address: knownTokens` ile suzulur; bir launch
 * AYNI ARALIKTA oldugunda token adresi henuz `knownTokens`'te degildir, yani o
 * launch'in mint `Transfer`'i HIC CEKILMEZ -- ve imlec ilerledigi icin bir daha
 * da cekilmez. Kayip kalicidir ve `SUM(holders.balance_tok) = 1e27` iddiasini
 * kalici olarak kirar.
 *
 * Siranin ZORUNLU oldugu OLCULDU: `launch()` mint `Transfer`'ini `Launched`'DAN
 * ONCE yayar -- `contracts/fixtures/launch.json`'da `Transfer` logIndex 0,
 * `Launched` logIndex 1; canli zincirde de ayni (smoke-receipts.json, launch).
 */
export async function fetchRange(
  client: RpcClient,
  watch: WatchSet,
  from: bigint,
  to: bigint,
  options: FetchOptions = {},
): Promise<DecodedEvent[]> {
  const pacer = options.pacer ?? createPacer()
  const chunk = options.addressChunk ?? ADDRESS_FILTER_CHUNK

  // FAZ 1: provenance kokunun kendisi. YALNIZCA factory adresinden.
  // Baska bir adresten gelen bir `Launched` HIC CEKILMEZ -- adres filtresi
  // ingest yolunun butun provenance kontrolunun BIRINCI yarisidir (ikincisi
  // Task 6'nin CREATE2 turetmesi).
  const launched = await getLogs(
    client,
    { from, to, address: watch.factory, topics: [TOPIC0.launched] },
    pacer,
  )

  // FAZ 1.5: izleme kumesini AYNI ARALIK icinde buyut.
  const curves = new Set<Address>(watch.curves)
  const tokens = new Set<Address>(watch.tokens)
  for (const log of launched) {
    if (log.topics.length < 3) continue // sekil kontrolu cozucude; burada atlamak yeter
    tokens.add(addressFrom(log.topics[1] as Hex))
    curves.add(addressFrom(log.topics[2] as Hex))
  }

  // FAZ 2: geri kalan her sey, GUNCELLENMIS kumeyle. Uc sorgu da havuzdan
  // gecer (bkz. `createPacer`), yani `Promise.all` es zamanlilik ISTEMEZ --
  // yalnizca sirayi cagirana birakir.
  const [curveLogs, escrowLogs, transferLogs] = await Promise.all([
    // `Trade`/`Completed` topic0'lari arcpad'e ozgudur AMA adres filtresi yine
    // de ZORUNLUDUR: herkes ayni imzayi tasiyan bir olay YAYABILIR (bkz.
    // `contracts/fixtures/forged.json` -- gercek `topic0`, sahte yayinci).
    // Filtre olmadan sahte bir `Trade` gercek bir islem gibi girerdi.
    getLogsChunked(client, [...curves], [[TOPIC0.trade, TOPIC0.completed]], from, to, pacer, chunk),
    getLogs(
      client,
      { from, to, address: watch.escrow, topics: [[TOPIC0.deposited, TOPIC0.claimed]] },
      pacer,
    ),
    // EIP-7708 DUVARI: `Transfer` ASLA adres filtresi olmadan sorulmaz.
    // Filtresiz sorgunun olculen hacmi 11.692 log / 1.000 blok ve icinde her
    // native hareket var.
    getLogsChunked(client, [...tokens], [TOPIC0.transfer], from, to, pacer, chunk),
  ])

  return decodeAll(
    client,
    [...launched, ...curveLogs, ...escrowLogs, ...transferLogs],
    from,
    to,
    pacer,
    options,
  )
}

/**
 * SERT IDDIALAR + cozme. Dordu de indexer'in davranisinin bagli oldugu,
 * olculmus ama hicbir yerde yazili olmayan olgulardir; varsayimi kontrole
 * cevirmek onlari yazili hale getirir.
 */
export async function decodeAll(
  client: RpcClient,
  raw: readonly RawLog[],
  from: bigint,
  to: bigint,
  pacer: Pacer,
  options: FetchOptions = {},
): Promise<DecodedEvent[]> {
  const missing: bigint[] = []
  const seen = new Set<string>()

  interface Prepared {
    log: RawLog
    kind: EventKind
    seq: bigint
    blockNumber: bigint
    logIndex: number
  }
  const prepared: Prepared[] = []

  for (const log of raw) {
    // (1) Arc'ta reorg YOKTUR.
    const blockNumber = BigInt(log.blockNumber)
    if (log.removed === true) throw new RemovedLog(blockNumber)

    // (2) Log istenen araligin ICINDE olmali. Disinda bir log, ya filtrenin
    //     uygulanmadigini ya RPC'nin kendi finalized'inin onunde oldugunu
    //     gosterir; ikisi de imleci bozar.
    if (blockNumber < from || blockNumber > to) throw new LogOutOfRange(blockNumber, from, to)

    const topic0 = log.topics[0]
    const kind = topic0 === undefined ? undefined : KIND_BY_TOPIC0.get(topic0)
    // Bilinmeyen bir topic0 SESSIZCE atlanmaz degil -- atlanir, ama yalnizca
    // filtrelerimizin ISTEMEDIGI bir sey oldugu icin: dort sorgunun dordu de
    // topic filtresi tasir, yani buraya bilinmeyen bir topic0 gelmesi RPC'nin
    // filtreyi uygulamadigi anlamina gelir. Ayni sinifta bir ariza olan
    // "adres filtresi dusmus" durumu `ForbiddenEmitter` ile yakalanir; burada
    // atlamak, cozulemeyen bir logu olay saymamaktir.
    if (kind === undefined) continue

    // (3) `blockTimestamp` her logda VAR (olculdu: "blockTimestamp":"0x6a6a7f0a").
    if (log.blockTimestamp === undefined) missing.push(blockNumber)

    const logIndex = Number(BigInt(log.logIndex))
    const seq = toSeq(blockNumber, logIndex)
    const key = `${blockNumber}:${logIndex}`
    // AYNI log iki sorgudan da gelirse iki kez uygulanirdi. Bugun mumkun
    // degil (filtreler ayrik) ama "bugun mumkun degil" bir kontrol degildir.
    if (seen.has(key)) throw new UnorderedLogs(seq, seq)
    seen.add(key)
    prepared.push({ log, kind, seq, blockNumber, logIndex })
  }

  const timestamps = await resolveTimestamps(client, missing, pacer, options)

  // Dort sorgunun BIRLESIMI sirali degildir; siralama BURADA yapilir.
  prepared.sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1))

  const out: DecodedEvent[] = []
  let prev: bigint | undefined
  for (const p of prepared) {
    // (4) SIRA. Holder deltalari siraya BAGIMLIDIR.
    if (prev !== undefined && p.seq <= prev) throw new UnorderedLogs(prev, p.seq)
    prev = p.seq

    const raw = p.log.blockTimestamp
    const seconds = raw === undefined ? timestamps.get(p.blockNumber) : BigInt(raw)
    if (seconds === undefined) throw new MissingTimestamp(p.blockNumber)

    out.push(
      DECODERS[p.kind](p.log, {
        seq: p.seq,
        blockNumber: p.blockNumber,
        logIndex: p.logIndex,
        txHash: p.log.transactionHash,
        blockTime: new Date(Number(seconds) * 1000),
      }),
    )
  }
  return out
}

/** Eksik timestamp'ler icin blok basina BIR ek cagri -- ve bir uyari. */
async function resolveTimestamps(
  client: RpcClient,
  missing: readonly bigint[],
  pacer: Pacer,
  options: FetchOptions,
): Promise<Map<bigint, bigint>> {
  const out = new Map<bigint, bigint>()
  if (missing.length === 0) return out
  const distinct = [...new Set(missing)]
  ;(options.onTimestampFallback ?? defaultTimestampWarning)(distinct)
  for (const blockNumber of distinct) {
    const block = (await pacer.run(() =>
      client.request({
        method: 'eth_getBlockByNumber',
        params: [`0x${blockNumber.toString(16)}`, false],
      }),
    )) as { timestamp?: Hex } | null
    if (block?.timestamp === undefined) throw new MissingTimestamp(blockNumber)
    out.set(blockNumber, BigInt(block.timestamp))
  }
  return out
}
