import type { CurveProfile, CurveState, FeeBps } from '@arcpad/shared'
import { asTok, asWei } from '@arcpad/shared'
import { MULTICALL3_ADDRESS } from '@arcpad/shared'
import { parseAbi } from 'viem'
import type { BatchReadCall, ChainReader } from '../watch/graduationWindow'
import { DEFAULT_CURVE_BATCH_SUBCALLS } from '../watch/graduationWindow'
import { type OrderShapeInput, scanCost, type ScanCost, shapeOf } from './scan'
import { type PoolQuoteReader, poolTriggerVerdict, type TriggerVerdict, triggerVerdict } from './trigger'

/**
 * ==========================================================================
 *  BIR GECIS. VE BU GECIS HICBIR SEY YAYINLAMAZ.
 * ==========================================================================
 *
 * GRADUATION YURUTUCUSUYLE ARASINDAKI FARK, BU FAZIN TAMAMIDIR.
 * `graduate/executor.ts` bir ISLEM GONDERIR: `graduate()` izinsizdir, yani
 * keeper onu KENDI adina cagirabilir ve sonuc herkes icin ayni olur. Emirlerde
 * boyle bir giris noktasi YOKTUR ve bu OLCULDU
 * (`test/localchain/custodyProof.ts`, 21/21, canli kontratlar, Arc fork'u):
 * curve alimlari `msg.sender`i kredilendirir, curve satimlari `msg.sender`den
 * ceker ve `msg.sender`e oder, router'in `payer`i `msg.sender`den yazilir ve
 * bir parametre DEGILDIR. Kontratlar donduruldugu icin bu bir eksik degil bir
 * SINIRDIR.
 *
 * Dolayisiyla bu gecisin urunu bir islem degil, IKI VERITABANI GECISIDIR:
 *
 *   1. TETIKLEME  -- "su blokta zincir bu emri kabul ederdi" (spec §8, gorev 1
 *                    -- "tetiklenen emirleri zincire gonderir" kismi HARIC, ve
 *                    o kismin neden yapilamadigi yukarida.)
 *   2. SURE ASIMI -- suresi gecmis emirleri kapatir (spec §8, gorev 4).
 *
 * Doldurma islemi SAHIBIN cuzdanindan cikar ve emrin KENDI slipaj sinirini
 * tasir, yani bu gecisin bir hatasi kullaniciya PARA KAYBETTIREMEZ -- yalnizca
 * yanlis bir "hazir" isareti gosterebilir, ve o isaret bir dugmeye
 * donusmeden once arayuz kendi canli kotasini alir.
 *
 * ==========================================================================
 *  OKUMA SIRASI: TEK BLOK, TEK PARCALAMA
 * ==========================================================================
 *
 * Butun okumalar TEK bir blok numarasina sabitlenir ve tek bir parcalama
 * uzerinden gider. Iki ayri `eth_call`in Arc'ta AYNI ANIN GOZLEMI OLMADIGI bu
 * depoda iki kez yanlis bulgu uretti (~350 ms blok suresi); bir emir icin bunun
 * somut sonucu su olurdu: rezervler bir bloktan, sahibin bakiyesi baska bir
 * bloktan okunur ve emir hicbir zaman var olmamis bir durum icin tetiklenir.
 */

const CURVE_SLOT_ABI = parseAbi([
  'function complete() view returns (bool)',
  'function graduated() view returns (bool)',
  'function virtualQuoteReserves() view returns (uint256)',
  'function virtualTokenReserves() view returns (uint256)',
  'function realTokenReserves() view returns (uint256)',
  'function realQuoteReserves() view returns (uint256)',
])
const CURVE_CONST_ABI = parseAbi([
  'function creator() view returns (address)',
  'function PROTOCOL_FEE_BPS() view returns (uint256)',
  'function CREATOR_FEE_BPS() view returns (uint256)',
])
const TOKEN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const MULTICALL_ABI = parseAbi(['function getEthBalance(address) view returns (uint256)'])

/** Bir geciste okunan, curve basina degismeyen degerler. Sonsuza kadar onbellek. */
export type CurveConstants = { readonly creator: string; readonly fees: FeeBps }

/** `pass` icin gereken emir alanlari. `@arcpad/db`nin satirini DARALTIR. */
export type PassOrder = {
  readonly orderSeq: bigint
  readonly token: string
  readonly ownerAddr: string
  readonly isBuy: boolean
  readonly amount: bigint
  readonly minOut: bigint
  readonly expiresAt: Date
  readonly status: 'open' | 'triggered'
}

/**
 * VERITABANI PORTU. Gercek uygulamasi `@arcpad/db`dir; testler bunu bellekte
 * doldurur.
 *
 * `markTriggered` ve `expireDue` BOOLEAN/LISTE doner, `void` DEGIL: bir gecis
 * "kac emir gercekten degisti" sorusunu sormak zorunda kalsin diye. Kaybedilen
 * bir yaris (kullanici ayni anda iptal etti) SESSIZ olamaz.
 */
export type OrderStore = {
  listLive: (limit: number) => Promise<readonly PassOrder[]>
  markTriggered: (orderSeq: bigint, blockNumber: bigint) => Promise<boolean>
  expireDue: (asOf: Date) => Promise<readonly bigint[]>
}

/** Bir token'in curve adresi. Emirler token'a, zincir okumalari curve'e bakar. */
export type CurveLookup = (token: string) => Promise<string | null>

export type OrderPassDeps = {
  client: ChainReader
  store: OrderStore
  curveOf: CurveLookup
  profile: CurveProfile
  /** Curve basina immutable degerler. Cagirandan gelir, yani GECISLER ARASI yasar. */
  constants?: Map<string, CurveConstants>
  /** Havuz mekani. Verilmezse havuz emirleri DEGERLENDIRILMEZ ve SAYILIR. */
  poolQuote?: PoolQuoteReader
  /** Bir gecisin emir tavani. Asilan is bir sonraki gecise kalir. */
  maxOrdersPerPass?: number
  batchSubcalls?: number
  alert?: (level: 'info' | 'warn' | 'page', key: string, message: string) => void
}

export type OrderPassSummary = {
  readonly blockNumber: bigint
  readonly scanned: number
  readonly triggered: readonly bigint[]
  readonly expired: readonly bigint[]
  readonly verdicts: Readonly<Record<TriggerVerdict['kind'], number>>
  /** Havuz mekaninda olup degerlendirilemeyen emirler (kota okuyucusu yok). */
  readonly poolUnevaluated: number
  readonly cost: ScanCost
}

export const DEFAULT_MAX_ORDERS_PER_PASS = 2_000

export async function runOrderPass(deps: OrderPassDeps): Promise<OrderPassSummary> {
  const alert = deps.alert ?? ((): void => {})
  const constants = deps.constants ?? new Map<string, CurveConstants>()
  const batchSubcalls = deps.batchSubcalls ?? DEFAULT_CURVE_BATCH_SUBCALLS
  const maxOrders = deps.maxOrdersPerPass ?? DEFAULT_MAX_ORDERS_PER_PASS

  // --- BLOK ONCE. Butun okumalar buna sabitlenir. ---
  const head = await deps.client.getBlock()

  // --- SURE ASIMI ILK. ---
  // ZAMAN ZINCIRDEN ALINIR, `Date.now()`tan DEGIL. Bir emrin suresi
  // kullanicinin gordugu zincir zamanina gore dolmali; sunucunun saati
  // kaydiginda emirlerin erken ya da gec olmesi, hicbir yerde gorunmeyen bir
  // hata olurdu. `expiresAt` ile `block.timestamp` ayni saat ailesindendir.
  const chainNow = new Date(Number(head.timestamp) * 1000)
  const expired = await deps.store.expireDue(chainNow)
  if (expired.length > 0) {
    alert('info', 'orders-expired', `orders-expired count=${expired.length}`)
  }

  const live = await deps.store.listLive(maxOrders)
  if (live.length >= maxOrders) {
    // TAVANA DAYANMAK BIR ARIZA DEGIL, AMA SESSIZ OLMAMALI: kalan emirler bir
    // sonraki gecise kalir, yani gecikme buyur ve bunu goren tek sey bu satir.
    alert('warn', 'orders-pass-saturated', `orders-pass-saturated cap=${maxOrders}`)
  }

  // --- MEKAN COZUMU: token -> curve, ve curve yoksa emir degerlendirilemez ---
  const shaped: (OrderShapeInput & { order: PassOrder })[] = []
  const unknownTokens = new Set<string>()
  for (const order of live) {
    const curve = await deps.curveOf(order.token)
    if (curve === null) {
      unknownTokens.add(order.token)
      continue
    }
    // MEKAN `graduated`DAN GELIR ve o bir SLOT OKUMASIDIR, yani burada henuz
    // bilinmiyor. Once hepsi curve varsayilir, slotlar okunduktan sonra mezun
    // olanlar havuza tasinir. Ters sira (once mekan, sonra okuma) mekani
    // bilmek icin bir okuma daha isterdi.
    shaped.push({ order, token: order.token, curve, ownerAddr: order.ownerAddr, isBuy: order.isBuy, venue: 'curve' })
  }
  if (unknownTokens.size > 0) {
    alert('warn', 'orders-unknown-token', `orders-unknown-token count=${unknownTokens.size}`)
  }

  const shape = shapeOf(shaped, new Set(constants.keys()))

  // --- TEK PARCALAMA: slotlar + immutable'lar + fonlama okumalari ---
  const calls: BatchReadCall[] = []
  for (const curve of shape.curveList) {
    for (const functionName of [
      'complete',
      'graduated',
      'virtualQuoteReserves',
      'virtualTokenReserves',
      'realTokenReserves',
      'realQuoteReserves',
    ] as const) {
      calls.push({ address: curve as `0x${string}`, abi: CURVE_SLOT_ABI, functionName })
    }
  }
  const coldCurves = shape.curveList.filter((c) => !constants.has(c))
  for (const curve of coldCurves) {
    for (const functionName of ['creator', 'PROTOCOL_FEE_BPS', 'CREATOR_FEE_BPS'] as const) {
      calls.push({ address: curve as `0x${string}`, abi: CURVE_CONST_ABI, functionName })
    }
  }
  for (const owner of shape.nativeOwners) {
    calls.push({
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL_ABI,
      functionName: 'getEthBalance',
      args: [owner as `0x${string}`],
    })
  }
  for (const { token, owner } of shape.tokenHolders) {
    calls.push({
      address: token as `0x${string}`,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`],
    })
  }

  const values = await readBatched(deps.client, calls, head.number, batchSubcalls)

  // --- COZUMLEME. Sira YUKARIDAKI SIRANIN AYNISI olmak ZORUNDA. ---
  let cursor = 0
  const slots = new Map<string, { state: CurveState; graduated: boolean }>()
  for (const curve of shape.curveList) {
    const complete = values[cursor] as boolean
    const graduated = values[cursor + 1] as boolean
    const vQ = values[cursor + 2] as bigint
    const vT = values[cursor + 3] as bigint
    const rT = values[cursor + 4] as bigint
    const rQ = values[cursor + 5] as bigint
    cursor += 6
    slots.set(curve, {
      graduated,
      state: {
        complete,
        virtualQuoteReserves: vQ,
        virtualTokenReserves: vT,
        realTokenReserves: asTok(rT),
        realQuoteReserves: asWei(rQ),
        // `creator` asagida doldurulur; onbellekten ya da bu parcadan.
        creator: '0x0000000000000000000000000000000000000000',
      },
    })
  }
  for (const curve of coldCurves) {
    const creator = values[cursor] as string
    const protocolFeeBps = values[cursor + 1] as bigint
    const creatorFeeBps = values[cursor + 2] as bigint
    cursor += 3
    constants.set(curve, { creator, fees: { protocolFeeBps, creatorFeeBps } })
  }
  const nativeBalances = new Map<string, bigint>()
  for (const owner of shape.nativeOwners) {
    nativeBalances.set(owner, values[cursor] as bigint)
    cursor += 1
  }
  const tokenBalances = new Map<string, bigint>()
  for (const { token, owner } of shape.tokenHolders) {
    tokenBalances.set(`${token}|${owner}`, values[cursor] as bigint)
    cursor += 1
  }
  /* c8 ignore next 4 -- `readBatched` uzunlugu zaten dogruluyor */
  if (cursor !== values.length) {
    throw new Error(
      `the order pass decoded ${cursor} of ${values.length} sub-call results. Refusing to use them: ` +
        'a misaligned decode reads one curve\'s reserves as another\'s, which looks like ordinary values.',
    )
  }

  // --- DEGERLENDIRME ---
  const verdicts: Record<TriggerVerdict['kind'], number> = {
    triggered: 0,
    notYet: 0,
    stalled: 0,
    unfillable: 0,
    underfunded: 0,
  }
  const triggered: bigint[] = []
  let poolUnevaluated = 0

  for (const entry of shaped) {
    const slot = slots.get(entry.curve)
    /* c8 ignore next -- her curve yukarida yazildi */
    if (slot === undefined) continue
    const consts = constants.get(entry.curve)
    /* c8 ignore next -- her curve ya onbellekte ya bu parcada */
    if (consts === undefined) continue

    const held = entry.order.isBuy
      ? (nativeBalances.get(entry.order.ownerAddr) ?? null)
      : (tokenBalances.get(`${entry.order.token}|${entry.order.ownerAddr}`) ?? null)
    const input = {
      isBuy: entry.order.isBuy,
      amount: entry.order.amount,
      minOut: entry.order.minOut,
      held,
    }

    let verdict: TriggerVerdict
    if (slot.graduated) {
      if (deps.poolQuote === undefined) {
        poolUnevaluated += 1
        continue
      }
      verdict = await poolTriggerVerdict(input, entry.order.token, deps.poolQuote)
    } else {
      verdict = triggerVerdict(input, { ...slot.state, creator: consts.creator }, deps.profile, consts.fees)
    }

    verdicts[verdict.kind] += 1
    if (verdict.kind !== 'triggered') continue
    // ZATEN `triggered` OLAN BIR EMRE TEKRAR YAZILMAZ: `markTriggered`
    // yalnizca `open`dan gecirir ve `false` doner. Yine de cagriyi hic
    // yapmamak, her geciste her tetiklenmis emir icin bir UPDATE atmaktan
    // ucuzdur -- ve bu ayrimi `status` tasiyor.
    if (entry.order.status === 'triggered') continue
    const changed = await deps.store.markTriggered(entry.order.orderSeq, head.number)
    if (changed) triggered.push(entry.order.orderSeq)
  }

  if (poolUnevaluated > 0) {
    alert(
      'warn',
      'orders-pool-unevaluated',
      `orders-pool-unevaluated count=${poolUnevaluated} -- no pool quote reader is configured`,
    )
  }

  return {
    blockNumber: head.number,
    scanned: shaped.length,
    triggered,
    expired,
    verdicts,
    poolUnevaluated,
    cost: scanCost(shape, batchSubcalls),
  }
}

/**
 * PARCALARI ARDISIK YAYAR ve her parcanin uzunlugunu DOGRULAR.
 *
 * `scanCurveStates`in aynisi ve ayni gerekceyle: kisa donen bir parca
 * sonrasindaki HER okumayi bir kaydirir -- bir emrin `minOut`u baska bir
 * emrin rezervine karsi degerlendirilir ve sonuc tamamen olagan gorunur.
 * `Promise.all` KULLANILMAZ: Arc es zamanli `eth_call`lari sinirlar.
 */
async function readBatched(
  client: ChainReader,
  calls: readonly BatchReadCall[],
  blockNumber: bigint,
  width: number,
): Promise<unknown[]> {
  if (calls.length === 0) return []
  const readContractBatch = client.readContractBatch
  if (readContractBatch === undefined) {
    throw new Error(
      'the order pass needs a batching reader: N orders as N sequential eth_calls is the cost this ' +
        'design exists to avoid. See scan.ts for the measurement.',
    )
  }
  const out: unknown[] = []
  for (let offset = 0; offset < calls.length; offset += width) {
    const chunk = calls.slice(offset, offset + width)
    const results = await readContractBatch.call(client, chunk, blockNumber)
    if (results.length !== chunk.length) {
      throw new Error(
        `the batched order read returned ${results.length} results for ${chunk.length} sub-calls at ` +
          `block ${blockNumber}. Refusing to use them: a short batch shifts every following read by ` +
          'one, which reads as ordinary values.',
      )
    }
    out.push(...results)
  }
  return out
}
