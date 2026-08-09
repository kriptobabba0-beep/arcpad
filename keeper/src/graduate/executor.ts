import type { Address, Hex } from 'viem'
import { formatUsdc } from '@arcpad/shared'
import type { AlertLevel, AlertThrottle } from '../alert'
import {
  asAddress,
  type ChainReader,
  type CursorStore,
  type CurveSlotState,
  pendingGraduations,
  scanCurveStates,
  scanFactoryLogs,
  ZERO_ADDRESS,
} from '../watch/graduationWindow'
import { FACTORY_ABI } from './abi'
import { type CurveLocks, isLockRefusal } from './lock'
import {
  chainErrorClassification,
  CHAIN_ERRORS_BEFORE_PAGE,
  type Classification,
  classifyRevert,
  type GraduationCode,
} from './outcome'
import type { QuarantineStore } from './state'

/**
 * ============ GRADUATION YURUTUCUSU ============
 *
 * NE OLDUGU. `BondingCurve` esigi GECEN ISLEMIN ICINDE tamamlanir
 * (`_settleBuy`, `complete = true`, `emit Completed`) ve orada durur. Havuzu
 * acan sey ayri bir cagridir: `ArcpadLocker.graduate(curve)`. O cagri
 * IZINSIZDIR -- kanoniklik kontrolunden baska kapisi yoktur -- ama ZINCIRDE
 * ONU KENDILIGINDEN YAPAN HICBIR SEY YOKTUR. Bu dosya onu yapan seydir.
 *
 * ============ BU BIRINCIL YOL MUDUR, YEDEK MI ============
 *
 * Spec keeper'i "otomatik graduation basarisiz olursa manuel iter" diye
 * tarif eder. OLCULDU: OTOMATIK GRADUATION DIYE BIR SEY YOK. Depoda
 * `graduate(` cagiran tek bir calisma-zamani satiri bile yoktur (web, indexer,
 * keeper, scripts -- hicbiri islem YAYINLAMAZ; web'in tek yazma yolu
 * kullanicinin cuzdanidir ve `launch`/`buy`/`sell`/`approve`den ibarettir).
 * Curve'un kendisi de yapamaz: `graduate()` `msg.sender == graduationTarget`
 * ister, yani tamamlayan alicinin islemi icinde curve'un kendini mezun etmesi
 * ancak curve locker'i cagirmasiyla olurdu -- ve `BondingCurve`in creation
 * code'u DONDURULMUSTUR. Yani "otomatik" yol yalnizca yazilmamis degil,
 * yazilamaz.
 *
 * DURUST MIMARI SUDUR: bu yurutucu BIRINCIL yoldur; YEDEK, cagrinin
 * IZINSIZ olmasidir -- keeper olduyse bir kullanici, bir searcher ya da
 * arayuzun kendisi ayni cagriyi yapabilir. Bu yuzden yurutucunun kapali
 * olmasi bir para kaybi degil bir GECIKMEDIR, ve bu ayrimi kaybetmemek icin
 * her gecis bekleyen kumeyi ADIYLA raporlar.
 *
 * ============ KESIF: OLAY DEGIL, SLOT ============
 *
 * Kume `Launched` loglarindan kurulur (imlec kalicidir, yalnizca BUYUR) ama
 * KARAR her curve'un `complete()`/`graduated()` SLOTUNDAN verilir. Sonucu
 * gorev tanimindaki sorunun cevabidir: KEEPER KAPALIYKEN TAMAMLANAN BIR
 * CURVE'E NE OLUR? Hicbir sey kaybolmaz. `Completed` olayini kacirmis olmak
 * onemsizdir, cunku kimse onu dinlemiyor; `complete` bir kez `true` olur ve
 * asla geri donmez, dolayisiyla acilistan sonraki ILK basarili gecis onu
 * gorur. `Completed`e abone olan bir tasarim ise tam tersini yapardi: kacan
 * olay kalici bir korluk olurdu ve onu kapatmak icin YINE ayni slot taramasi
 * gerekirdi.
 */

export type SimulateResult =
  | { ok: true }
  | { ok: false; revertData: string | null; detail: string }

export type ReceiptSummary = {
  status: 'success' | 'reverted'
  blockNumber: bigint
  gasUsed: bigint
  transactionHash: Hex
}

/**
 * YAZMA YUZEYI, DAR VE KARARSIZ. `ChainReader` ile ayni gerekce: yurutucu
 * gercek bir viem cuzdanina degil UC cagriya baglanir, boylece canli bir RPC
 * ve bir OZEL ANAHTAR olmadan test edilebilir. Tek gercek uygulama
 * `chain.ts`tedir ve icinde KARAR yoktur.
 */
export interface GraduationWriter {
  /** Imzalayan hesap. Sayfada gorunur; kuru kosuda da bilinir. */
  readonly account: Address
  /** `eth_call`, BLOGA SABITLENMIS. Yayindan hemen once. */
  simulate(curve: Address, blockNumber: bigint): Promise<SimulateResult>
  send(curve: Address): Promise<Hex>
  wait(hash: Hex): Promise<ReceiptSummary>
}

export type CurveOutcome = {
  curve: Address
  code: GraduationCode | 'locked-elsewhere' | 'quarantined'
  level: AlertLevel
  transactionHash?: Hex
  gasUsed?: bigint
  detail: string
}

export type PassSummary = {
  head: bigint
  /** Fabrikanin `graduationTarget()` slotu, bu blokta. */
  target: Address
  /** Hedef bizim locker'imiz mi. `false` ise HICBIR curve'e dokunulmaz. */
  armed: boolean
  /** Log taramasi basa vardi mi. `false` ise bekleyen kume EKSIKTIR. */
  caughtUp: boolean
  knownCurves: number
  pending: CurveSlotState[]
  pendingQuoteWei: bigint
  outcomes: CurveOutcome[]
  /** Bu gecis en az bir islem YAYINLADI mi. */
  broadcast: number
}

export interface GraduatorDeps {
  client: ChainReader
  writer: GraduationWriter
  factory: Address
  locker: Address
  startBlock: bigint
  store?: CursorStore
  quarantine: QuarantineStore
  locks: CurveLocks
  alert: (level: AlertLevel, key: string, message: string) => void
  /**
   * KURU KOSU VARSAYILANDIR VE OYLE KALMALIDIR. `config.ts`in kendi kurali:
   * "yanlis yapilandirilmis bir keeper'in sessizce imzalamaya baslamasi, hic
   * calismamasindan cok daha pahalidir."
   */
  dryRun: boolean
  /** Bir gecisde en fazla kac curve denenir. */
  maxPerPass?: number
  chunk?: bigint
  maxChunksPerPoll?: number
  nowMs?: () => number
  throttle?: AlertThrottle
  /** Ust uste zincir arizasi sayaci; gecisler ARASINDA yasar. */
  chainErrors?: { fail(): number; succeed(): void }
}

export const DEFAULT_MAX_PER_PASS = 4

/**
 * BIR GECIS. Dongu `graduate.ts`in.
 *
 * ASLA REJECT ETMEZ -- `runWatcher` ile ayni sozlesme ve ayni gerekce: bir
 * gecisi firlatarak biten bir yurutucu, dongunun ustunde bir `catch`
 * unutuldugu anda TAMAMEN susar.
 */
export async function runGraduationPass(deps: GraduatorDeps): Promise<PassSummary> {
  const nowMs = deps.nowMs ?? Date.now
  const at = nowMs()
  const activeKeys = new Set<string>()
  const emit = (level: AlertLevel, key: string, message: string): void => {
    activeKeys.add(key)
    if (deps.throttle === undefined || deps.throttle.shouldEmit(key, at)) {
      deps.alert(level, key, message)
    }
  }
  const empty = (head: bigint, target: Address, armed: boolean): PassSummary => ({
    head,
    target,
    armed,
    caughtUp: false,
    knownCurves: 0,
    pending: [],
    pendingQuoteWei: 0n,
    outcomes: [],
    broadcast: 0,
  })

  let head: bigint
  let target: Address
  try {
    const block = await deps.client.getBlock()
    head = block.number
    const raw = await deps.client.readContract({
      address: deps.factory,
      abi: FACTORY_ABI,
      functionName: 'graduationTarget',
      blockNumber: head,
    })
    target = asAddress(raw, `${deps.factory}.graduationTarget()`)
  } catch (error) {
    const consecutive = deps.chainErrors?.fail() ?? CHAIN_ERRORS_BEFORE_PAGE
    const classification = chainErrorClassification(describe(error), consecutive)
    emit(
      classification.level,
      'graduator-state-read-failed',
      `graduator-state-read-failed: the factory's graduationTarget could not be read, so this pass did NOTHING and the pending set is UNKNOWN (not zero): ${classification.reason}`,
    )
    deps.throttle?.sweep(activeKeys)
    return empty(0n, ZERO_ADDRESS, false)
  }

  // ============ SILAHLANMA KAPISI, HER SEYDEN ONCE ============
  //
  // UC DURUM, VE UCUNUN CEVABI FARKLI:
  //
  //   0x0                -> platform hedefini henuz atamadi. UYANDIRMAZ.
  //                         Uretim fabrikasinda BUGUN boyle ve boyle KALMALI.
  //   == bizim locker    -> is basi.
  //   baska bir adres    -> bu keeper HICBIR SEYI mezun edemez. SAYFA.
  //
  // Ucuncu dal pencere izleyicisinin `graduation-target-off-allowlist`
  // bulgusuyla ORTUSMEZ: o bulgu hedefin IZIN LISTESINDE olup olmadigina
  // bakar, buradaki ise BIZIM locker olup olmadigina. Izin listesinde olan
  // AMA bizim olmayan bir hedef (ornegin locker yeniden deploy edildi ve
  // keeper eski adresle kaldi) orada SESSIZDIR ve burada sayfadir.
  const armed = target.toLowerCase() === deps.locker.toLowerCase()
  if (!armed && target !== ZERO_ADDRESS) {
    emit(
      'page',
      `graduation-target-is-not-our-locker|${target}`,
      `graduation-target-is-not-our-locker: the factory at ${deps.factory} points graduationTarget at ${target}, but this executor is configured with ${deps.locker}. Every completed curve now pays out through that other address and THIS KEEPER CAN GRADUATE NOTHING. No curve was touched this pass. Either the locker was redeployed and the keeper was not repointed, or governance moved the target -- the graduation-window watcher owns the allowlist question; this one owns "the fallback is dead".`,
    )
  }

  // ============ KESIF ============
  let curves: Address[] = []
  let caughtUp = false
  try {
    const scanOpts: Parameters<typeof scanFactoryLogs>[3] = {
      head,
      maxChunks: deps.maxChunksPerPoll ?? 1,
    }
    if (deps.store !== undefined) scanOpts.store = deps.store
    if (deps.chunk !== undefined) scanOpts.chunk = deps.chunk
    const scan = await scanFactoryLogs(deps.client, deps.factory, deps.startBlock, scanOpts)
    curves = scan.curves
    caughtUp = scan.caughtUp
  } catch (error) {
    const consecutive = deps.chainErrors?.fail() ?? CHAIN_ERRORS_BEFORE_PAGE
    const classification = chainErrorClassification(describe(error), consecutive)
    emit(
      classification.level,
      'graduator-scan-failed',
      `graduator-scan-failed: the Launched scan failed, so the set of curves this executor knows about is INCOMPLETE and no graduation was attempted this pass: ${classification.reason}`,
    )
    deps.throttle?.sweep(activeKeys)
    return empty(head, target, armed)
  }

  let states: CurveSlotState[]
  try {
    states = await scanCurveStates(deps.client, curves, head)
  } catch (error) {
    const consecutive = deps.chainErrors?.fail() ?? CHAIN_ERRORS_BEFORE_PAGE
    const classification = chainErrorClassification(describe(error), consecutive)
    emit(
      classification.level,
      'graduator-curve-read-failed',
      `graduator-curve-read-failed: a curve's complete()/graduated() slots could not be read, so the pending set is UNKNOWN (not zero) and nothing was attempted: ${classification.reason}`,
    )
    deps.throttle?.sweep(activeKeys)
    return empty(head, target, armed)
  }
  deps.chainErrors?.succeed()

  const pending = pendingGraduations(states)
  const pendingQuoteWei = pending.reduce((sum, state) => sum + (state.realQuoteWei ?? 0n), 0n)
  const summary: PassSummary = {
    head,
    target,
    armed,
    caughtUp,
    knownCurves: curves.length,
    pending,
    pendingQuoteWei,
    outcomes: [],
    broadcast: 0,
  }

  const backlog = `${pending.length} completed-but-ungraduated curve(s) holding ${formatUsdc(pendingQuoteWei)} USDC (${pendingQuoteWei} wei)${caughtUp ? '' : ' -- LOWER BOUND, the Launched scan has not caught up'}`

  // ============ SILAHLI DEGILSE: BEKLE, SAYFA CIKARMA ============
  if (!armed) {
    if (pending.length > 0) {
      emit(
        'ok',
        target === ZERO_ADDRESS ? 'graduation-waiting-for-target' : 'graduation-blocked-wrong-target',
        target === ZERO_ADDRESS
          ? `graduation-waiting-for-target: ${backlog} are waiting, and the factory's graduationTarget is still 0x0. BondingCurve.graduate() reverts GraduationTargetUnset() for all of them. This is the production factory's DELIBERATE state today -- it is not an incident, nothing is lost, and the moment a target is applied this executor graduates the backlog. Recorded at OK so a platform that has not armed its target cannot wear the pager out.`
          : `graduation-blocked-wrong-target: ${backlog} cannot be graduated by this executor; see the page above.`,
      )
    }
    deps.throttle?.sweep(activeKeys)
    return summary
  }

  // ============ SILAHLI: SIRAYLA DENE ============
  const maxPerPass = deps.maxPerPass ?? DEFAULT_MAX_PER_PASS
  let attempted = 0
  for (const state of pending) {
    if (attempted >= maxPerPass) break
    const curve = state.curve

    const heldEntry = deps.quarantine.entry(curve)
    if (heldEntry !== undefined && deps.quarantine.isHeld(curve, at)) {
      summary.outcomes.push({
        curve,
        code: 'quarantined',
        level: 'ok',
        detail: `held until ${new Date(heldEntry.untilMs).toISOString()} after ${heldEntry.attempts} attempt(s): ${heldEntry.code}${heldEntry.errorName === null ? '' : ` (${heldEntry.errorName})`}. It is still counted in the backlog above; it is only not retried.`,
      })
      continue
    }

    const lock = deps.locks.acquire(curve, at)
    if (isLockRefusal(lock)) {
      summary.outcomes.push({ curve, code: 'locked-elsewhere', level: 'ok', detail: lock.detail })
      continue
    }
    if (lock.stolen) {
      emit(
        'ok',
        `graduation-lock-stolen|${curve}`,
        `graduation-lock-stolen: the lock at ${lock.path} had expired and was taken over. Whatever held it did not release it -- a killed executor is the normal cause. If this repeats for the same curve, two executors are fighting and one of them should be stopped.`,
      )
    }

    attempted += 1
    try {
      const outcome = await attemptOne(deps, state, head, at, emit)
      summary.outcomes.push(outcome)
      if (outcome.transactionHash !== undefined) summary.broadcast += 1
    } finally {
      lock.release()
    }
  }

  if (pending.length > attempted) {
    summary.outcomes.push({
      curve: ZERO_ADDRESS,
      code: 'quarantined',
      level: 'ok',
      detail: `${pending.length - attempted} pending curve(s) were not attempted this pass (per-pass budget ${maxPerPass}, quarantine, or another executor's lock). They stay in the backlog and are retried on the next pass.`,
    })
  }

  deps.throttle?.sweep(activeKeys)
  return summary
}

/**
 * TEK BIR CURVE. SIRA BAGLAYICIDIR:
 *   1. SIMULE ET -- yayindan hemen once, BLOGA SABITLENMIS.
 *   2. Kuru kosuysa BURADA DUR.
 *   3. YAYINLA, makbuzu bekle.
 *   4. GERI OKU. Makbuzun `status: success`i YETMEZ.
 *
 * (4) IHMAL EDILEBILIR GORUNUR VE DEGILDIR. Bir makbuz "islem revert etmedi"
 * der; "curve mezun oldu" DEMEZ. `ArcpadLocker.graduate`in kendi kodu ayni
 * dersi tasiyor: havuz fiyatini YEREL degiskenden degil `PoolManager`in kendi
 * durumundan geri okur, cunku "dogru hesapladi, BASKASINI gecirdi" mutanti
 * yerel degiskene bakan bir kontrolde GORUNMEZ.
 */
async function attemptOne(
  deps: GraduatorDeps,
  state: CurveSlotState,
  head: bigint,
  at: number,
  emit: (level: AlertLevel, key: string, message: string) => void,
): Promise<CurveOutcome> {
  const curve = state.curve
  const raise = `${formatUsdc(state.realQuoteWei ?? 0n)} USDC (${state.realQuoteWei ?? 0n} wei)`

  let simulation: SimulateResult
  try {
    simulation = await deps.writer.simulate(curve, head)
  } catch (error) {
    const consecutive = deps.chainErrors?.fail() ?? CHAIN_ERRORS_BEFORE_PAGE
    const classification = chainErrorClassification(describe(error), consecutive)
    emit(classification.level, `graduation-simulate-error|${curve}`, `${curve}: ${classification.reason}`)
    return { curve, code: 'chain-error', level: classification.level, detail: classification.reason }
  }

  if (!simulation.ok) {
    const classification = classifyRevert(simulation.revertData)
    return applyClassification(deps, curve, classification, at, emit, `${classification.reason} [${simulation.detail}]`)
  }

  if (deps.dryRun) {
    emit(
      'ok',
      `graduation-would-send|${curve}`,
      `graduation-would-send: locker.graduate(${curve}) SIMULATES GREEN at block ${head} for ${raise}, and KEEPER_DRY_RUN is on, so nothing was broadcast. Set KEEPER_DRY_RUN=false to let this executor land it.`,
    )
    return {
      curve,
      code: 'would-graduate',
      level: 'ok',
      detail: `simulated green at block ${head}; not broadcast (dry run). Raise ${raise}.`,
    }
  }

  let hash: Hex
  try {
    hash = await deps.writer.send(curve)
  } catch (error) {
    const consecutive = deps.chainErrors?.fail() ?? CHAIN_ERRORS_BEFORE_PAGE
    const classification = chainErrorClassification(describe(error), consecutive)
    emit(classification.level, `graduation-send-failed|${curve}`, `${curve}: the transaction could not be broadcast even though it simulated green. ${classification.reason}`)
    return { curve, code: 'chain-error', level: classification.level, detail: classification.reason }
  }

  let receipt: ReceiptSummary
  try {
    receipt = await deps.writer.wait(hash)
  } catch (error) {
    // YAYINLANDI AMA MAKBUZ ALINAMADI. Bu bir SAYFADIR ve karantina DEGILDIR:
    // islem inmis olabilir. Bir sonraki gecis slotu okur ve zaten mezunsa
    // curve kumeden kendiliginden duser.
    emit(
      'page',
      `graduation-receipt-unknown|${curve}`,
      `graduation-receipt-unknown: locker.graduate(${curve}) was BROADCAST as ${hash} but its receipt could not be read. The transaction may or may not have landed; the next pass reads graduated() and will resolve it. Do not re-send by hand before checking that: ${describe(error)}`,
    )
    return { curve, code: 'chain-error', level: 'page', transactionHash: hash, detail: describe(error) }
  }

  if (receipt.status === 'reverted') {
    emit(
      'page',
      `graduation-reverted-on-chain|${curve}`,
      `graduation-reverted-on-chain: locker.graduate(${curve}) simulated green at block ${head} but REVERTED on chain in ${hash} (block ${receipt.blockNumber}, ${receipt.gasUsed} gas burned). Something changed between the simulation and the mine -- the most likely cause is another party graduating it first, which is legitimate; the next pass reads graduated() and settles it.`,
    )
    return {
      curve,
      code: 'unknown-revert',
      level: 'page',
      transactionHash: hash,
      gasUsed: receipt.gasUsed,
      detail: `reverted on chain in ${hash}`,
    }
  }

  // ============ GERI OKUMA. MAKBUZ YETMEZ. ============
  let after: CurveSlotState[]
  try {
    after = await scanCurveStates(deps.client, [curve], receipt.blockNumber)
  } catch (error) {
    emit(
      'page',
      `graduation-readback-failed|${curve}`,
      `graduation-readback-failed: ${hash} succeeded but graduated() could not be re-read at block ${receipt.blockNumber}, so this executor cannot claim the curve graduated: ${describe(error)}`,
    )
    return { curve, code: 'chain-error', level: 'page', transactionHash: hash, gasUsed: receipt.gasUsed, detail: describe(error) }
  }

  const graduated = after[0]?.graduated === true
  if (!graduated) {
    emit(
      'page',
      `graduation-did-not-latch|${curve}`,
      `graduation-did-not-latch: ${hash} succeeded at block ${receipt.blockNumber} but ${curve}.graduated() still reads false. A successful receipt is not a graduation; something answered the call without latching the curve. Do not retry blindly.`,
    )
    return { curve, code: 'unknown-revert', level: 'page', transactionHash: hash, gasUsed: receipt.gasUsed, detail: 'receipt succeeded but graduated() is still false' }
  }

  deps.quarantine.clear(curve)
  emit(
    'ok',
    `graduation-landed|${curve}`,
    `graduation-landed: ${curve} graduated in ${hash} at block ${receipt.blockNumber} for ${raise}, ${receipt.gasUsed} gas, signer ${deps.writer.account}. graduated() re-read as true at that block.`,
  )
  return {
    curve,
    code: 'graduated',
    level: 'ok',
    transactionHash: hash,
    gasUsed: receipt.gasUsed,
    detail: `graduated in ${hash} at block ${receipt.blockNumber}`,
  }
}

function applyClassification(
  deps: GraduatorDeps,
  curve: Address,
  classification: Classification,
  at: number,
  emit: (level: AlertLevel, key: string, message: string) => void,
  detail: string,
): CurveOutcome {
  if (classification.code === 'already-graduated') {
    // BIR ARIZA DEGIL. Cagrinin IZINSIZ olmasi tam olarak bunun icindir.
    deps.quarantine.clear(curve)
    emit(
      'ok',
      `graduation-already|${curve}`,
      `graduation-already: ${curve} was already graduated when this executor got to it -- another party won the race and this keeper spent NO gas, because the simulation caught it before any broadcast. ${classification.reason}`,
    )
    return { curve, code: classification.code, level: 'ok', detail }
  }

  if (classification.disposition === 'quarantine') {
    const entry = deps.quarantine.hold(curve, classification, at)
    emit(
      classification.pageable ? classification.level : 'ok',
      `graduation-${classification.code}|${curve}|${classification.selector ?? 'nodata'}`,
      `graduation-${classification.code}: ${curve} -- ${detail} Quarantined until ${new Date(entry.untilMs).toISOString()} (attempt ${entry.attempts}) so this does not page on every pass; it stays IN the backlog figure and is retried once after that.`,
    )
    return { curve, code: classification.code, level: classification.level, detail }
  }

  emit(
    classification.pageable ? classification.level : 'ok',
    `graduation-${classification.code}|${curve}|${classification.selector ?? 'nodata'}`,
    `graduation-${classification.code}: ${curve} -- ${detail}`,
  )
  return { curve, code: classification.code, level: classification.level, detail }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
