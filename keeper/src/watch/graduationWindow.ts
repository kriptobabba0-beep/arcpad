import { readFileSync, writeFileSync } from 'node:fs'
import { formatUsdc } from '@arcpad/shared'
import { type Address, getAddress, isAddress } from 'viem'
import {
  type AlertLevel,
  type Liveness,
  maxSeverity,
  type Severity,
  severityToLevel,
} from '../alert'

/**
 * GRADUATION PENCERESI IZLEYICISI.
 *
 * `LaunchFactory`in governor'i graduation hedefini UC GUNLUK bir gecikmeyle
 * yeniden isaretleyebilir. Bu yetkinin somut buyuklugu olculdu: ele gecirilmis
 * bir governor, TAMAMLANMIS HER CURVE'UN raise'inin tamamini alabilir --
 * kendi kontrolundeki bir hedefi onerir, uc gunu bekler, indirir, sonra hepsini
 * `graduate()` eder. `graduate()` hedefi CAGRI ANINDA cozer, yani cagri
 * indiginde kime isaret ediliyorsa odeme ona gider.
 *
 * GECIKMENIN TEK CARESI, pencere icinde bekleyen graduation'lari BOSALTAN
 * kamudur -- ve bu, birinin IZLEMESINI gerektirir. Bu dosya o "biri"dir.
 *
 * SALDIRININ EN KESKIN HALI ve bu izleyicinin yakalamak ZORUNDA oldugu sey:
 * HENUZ HICBIR LAUNCH TAMAMLANMAMISKEN oner. Bosaltilacak bir sey yoktur,
 * kimse itiraz etmez. Pencerenin gecmesine izin ver -- INISI bekleyen
 * gozlemciler onerinin dusuruldugu sonucuna varir. Cok sonra, curve'ler
 * tamamlandiginda geri don ve tek islemde indir-ve-bosalt. Hirsizlik anindaki
 * ihbar suresi SIFIRDIR. Sozlesme tarafinda pencere `[eta, eta + DELAY]`
 * araligina baglanarak kapatildi, ama SURENIN DOLMASI ANCAK BIRI PENCERE
 * ICINDE FARK EDERSE ISE YARAR.
 *
 * Bunun buradaki dogrudan karsiligi sudur: `classify` seviyeyi belirlerken
 * MARUZIYETE BAKMAZ. Bos bir kumeye karsi yapilan oneri zararsiz DEGIL,
 * tehlikeli olandir; maruziyet yalnizca mesaji zenginlestirir.
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/**
 * MINIMUM ABI, elle yazildi ve kaynagi 26ce330:contracts/src/LaunchFactory.sol.
 *
 * `contracts/out/` derlenmis artifact'lerinden okumuyoruz: keeper'in testleri
 * derleyici gerektirmemelidir ve derlenmis agac baska bir surecin cikti
 * dizinidir. Bedeli, elle yazilmis bir yuzeyin sozlesmeden AYRISABILECEK
 * olmasidir; bunun mercii zincir ustunde kosan drill'dir (bkz. drill.ts) ve
 * Solidity tarafinda `Surface.t.sol`.
 */
export const FACTORY_WATCH_ABI = [
  {
    type: 'function',
    name: 'pendingGraduationTarget',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'pendingGraduationTargetEta',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'graduationTarget',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'protocolTreasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'GRADUATION_TARGET_DELAY',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'launchCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'applyGraduationTarget',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  { type: 'error', name: 'GraduationTargetProposalExpired', inputs: [] },
  { type: 'error', name: 'GraduationTargetDelayNotElapsed', inputs: [] },
  { type: 'error', name: 'NoPendingGraduationTarget', inputs: [] },
  {
    type: 'event',
    name: 'Launched',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'curve', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
      { name: 'uri', type: 'string', indexed: false },
      { name: 'salt', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'GraduationTargetProposed',
    inputs: [
      { name: 'target', type: 'address', indexed: true },
      { name: 'eta', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'GraduationTargetChanged',
    inputs: [
      { name: 'previous', type: 'address', indexed: true },
      { name: 'current', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ProtocolTreasuryChanged',
    inputs: [
      { name: 'previous', type: 'address', indexed: true },
      { name: 'current', type: 'address', indexed: true },
    ],
  },
] as const

export const CURVE_WATCH_ABI = [
  {
    type: 'function',
    name: 'complete',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'graduated',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'realQuoteReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Completed',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'realQuoteReserves', type: 'uint256', indexed: false },
      { name: 'poolSeedSupply', type: 'uint256', indexed: false },
    ],
  },
] as const

const LAUNCHED_EVENT = FACTORY_WATCH_ABI.find(
  (
    entry,
  ): entry is Extract<(typeof FACTORY_WATCH_ABI)[number], { type: 'event'; name: 'Launched' }> =>
    entry.type === 'event' && entry.name === 'Launched',
)

// ---------------------------------------------------------------
// Zincir okuyucusu -- DAR ARAYUZ, viem'in kendisi degil
// ---------------------------------------------------------------

/**
 * `packages/shared`'daki `ChainIdSource` ile ayni desen ve ayni gerekce:
 * izleyiciyi gercek bir viem `PublicClient`a degil, ihtiyaci olan UC cagriya
 * baglamak, canli bir RPC olmadan SENTETIK bir zincirle test edilebilmesini
 * saglar. `chainReader.ts` icindeki `viemChainReader` bu arayuzun tek gercek
 * uygulamasidir ve SAF DELEGASYONDUR -- icinde karar yoktur, cunku depoda test
 * edilmeyen tek izleyici kodu odur.
 */
export interface ReadCall {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  blockNumber: bigint
}

export interface LogQuery {
  address: Address
  event: unknown
  fromBlock: bigint
  toBlock: bigint
}

export type HeadBlock = { number: bigint; timestamp: bigint }

export interface ChainReader {
  getBlock(): Promise<HeadBlock>
  readContract(call: ReadCall): Promise<unknown>
  getLogs(query: LogQuery): Promise<ReadonlyArray<{ args?: Record<string, unknown> }>>
}

// ---------------------------------------------------------------
// Pencere
// ---------------------------------------------------------------

export type WindowPhase = 'none' | 'armed' | 'open' | 'expired'

/**
 * `delaySeconds`, `blockNumber`, `launchCount` ve `protocolTreasury` alanlari
 * gorev tanimindaki dorde EKLENMISTIR; hicbiri kaldirilmadi. Gerekceleri
 * `readWindowState`in NatSpec'inde ve `runWatcher`da.
 */
export type WindowState = {
  pendingTarget: Address
  pendingEta: bigint
  currentTarget: Address
  protocolTreasury: Address
  nowSeconds: bigint
  opensAt: bigint
  expiresAt: bigint
  phase: WindowPhase
  delaySeconds: bigint
  blockNumber: bigint
  launchCount: bigint
}

/**
 * Pencere aritmetigi, TEK YERDE ve zincirden okunan gecikmeyle.
 *
 * `259200` sabitini buraya yazmak, farkli bir gecikmeyle deploy edilmis bir
 * factory karsisinda izleyicinin pencereyi SESSIZCE kisaltmasi demek olurdu.
 *
 * IKI SINIR DA KAPSAYICIDIR ve bu sozlesmeden gelir:
 * `applyGraduationTarget` `block.timestamp < eta` ve
 * `block.timestamp > eta + DELAY` ile reddeder -- yani her iki ucta da
 * ISLEM HALA INEBILIR. Bir ucta bir birim kayan izleyici, rota'ya yanlis
 * sey soyler.
 */
export function computeWindow(
  pendingTarget: Address,
  pendingEta: bigint,
  delaySeconds: bigint,
  nowSeconds: bigint,
): { opensAt: bigint; expiresAt: bigint; phase: WindowPhase } {
  if (pendingTarget === ZERO_ADDRESS) {
    return { opensAt: 0n, expiresAt: 0n, phase: 'none' }
  }
  const opensAt = pendingEta
  const expiresAt = pendingEta + delaySeconds
  if (nowSeconds < opensAt) return { opensAt, expiresAt, phase: 'armed' }
  if (nowSeconds > expiresAt) return { opensAt, expiresAt, phase: 'expired' }
  return { opensAt, expiresAt, phase: 'open' }
}

/**
 * SLOTLARI HER POLL OKUR, log gormus olmaya GUVENMEZ.
 *
 * Bir RPC bir log araligini dusurebilir, bir reorg onu gorulmemis kilabilir,
 * keeper bir bosluk asilarak yeniden baslatilabilir. Slot mevcut durum
 * hakkinda YALAN SOYLEYEMEZ. Faz 1c bir topic'e guvenmenin bedelini olctu:
 * bir olay parametresinden `indexed` kaldirmak tek kelimelik bir duzenlemedir
 * ve her `getLogs` filtresini sessizce bos donduren bir sonuca varir.
 *
 * ALTI OKUMANIN ALTISI DA AYNI BLOK NUMARASINA SABITLENIR. "latest"e karsi
 * arka arkaya yapilan alti `eth_call`, bir blok sinirini kesebilir ve tutarsiz
 * bir goruntu uretir -- ornegin `pendingGraduationTarget` inisten ONCE,
 * `graduationTarget` inisten SONRA okunur ve izleyici hem bekleyen bir oneri
 * hem de degismemis bir hedef gorur. Multicall3 yerine blok sabitlemeyi
 * seciyoruz cunku ek bir kontrat bagimliligi getirmez.
 */
export async function readWindowState(client: ChainReader, factory: Address): Promise<WindowState> {
  const head = await client.getBlock()
  const at = head.number

  const read = (functionName: string): Promise<unknown> =>
    client.readContract({ address: factory, abi: FACTORY_WATCH_ABI, functionName, blockNumber: at })

  const [pendingRaw, etaRaw, currentRaw, treasuryRaw, delayRaw, launchCountRaw] = await Promise.all(
    [
      read('pendingGraduationTarget'),
      read('pendingGraduationTargetEta'),
      read('graduationTarget'),
      read('protocolTreasury'),
      read('GRADUATION_TARGET_DELAY'),
      read('launchCount'),
    ],
  )

  const pendingTarget = asAddress(pendingRaw, 'pendingGraduationTarget')
  const pendingEta = asBigint(etaRaw, 'pendingGraduationTargetEta')
  const delaySeconds = asBigint(delayRaw, 'GRADUATION_TARGET_DELAY')
  const nowSeconds = head.timestamp

  const { opensAt, expiresAt, phase } = computeWindow(
    pendingTarget,
    pendingEta,
    delaySeconds,
    nowSeconds,
  )

  return {
    pendingTarget,
    pendingEta,
    currentTarget: asAddress(currentRaw, 'graduationTarget'),
    protocolTreasury: asAddress(treasuryRaw, 'protocolTreasury'),
    nowSeconds,
    opensAt,
    expiresAt,
    phase,
    delaySeconds,
    blockNumber: at,
    launchCount: asBigint(launchCountRaw, 'launchCount'),
  }
}

// ---------------------------------------------------------------
// Siniflandirma
// ---------------------------------------------------------------

export type Allowlist = {
  graduationTargets: readonly Address[]
  treasuries: readonly Address[]
}

export type FindingCode =
  | 'no-pending-target'
  | 'pending-target-allowlisted'
  | 'pending-target-not-allowlisted'
  | 'pending-target-not-allowlisted-expired'
  | 'graduation-target-off-allowlist'
  | 'protocol-treasury-off-allowlist'

export type Classification = {
  level: AlertLevel
  severity: Severity
  reason: string
  findings: FindingCode[]
  /**
   * "Soyleyecek hicbir sey yok" -- yalnizca kalp atisi. Bunun AYRI bir alan
   * olmasinin sebebi, `level === 'ok'`in iki farkli seyi ortmesidir: "bekleyen
   * bir oneri var ve beklendigi gibi" (kayda gecmeli) ile "hicbir sey yok"
   * (gecmemeli).
   */
  quiet: boolean
}

/** `exposure()` gorev tanimindaki iki alani dondurur; `complete` runWatcher'in ekidir. */
export type ExposureReport = { count: number; totalQuoteWei: bigint; complete: boolean }

/**
 * UC BAGIMSIZ KONTROL, HER CAGRIDA UCU BIRDEN.
 *
 * Erken donus YOKTUR ve olmamasi kasitlidir: bu depoda on bir kez olculen
 * hata sekli, bir ozelligin BIR giris noktasinda kapatilip TUMUNDE kapali
 * sayilmasidir. Ucu de her seferinde degerlendirilir, bulgular birikir ve
 * `severity` en yukseklerine esitlenir; boylece "hedef indi" bulgusu
 * "hazine degisti" bulgusunu maskeleyemez.
 *
 * MARUZIYET SEVIYEYE GIRMEZ. `exposure` yalnizca mesaji zenginlestirir --
 * sifir tamamlanmis curve varken yapilan oneri de tam olarak ayni sekilde
 * sayfa cikarir. Kapatilan saldiri tam olarak "bos kumeye karsi oner"dir.
 */
export function classify(
  state: WindowState,
  allowlist: Allowlist,
  exposure?: ExposureReport,
): Classification {
  const findings: FindingCode[] = []
  const parts: string[] = []
  let severity: Severity = 'none'

  const exposureText = renderExposure(exposure)
  const windowText = `opensAt=${renderTime(state.opensAt)} expiresAt=${renderTime(state.expiresAt)} phase=${state.phase} chainNow=${renderTime(state.nowSeconds)}`

  // (1) INMIS DEGISIKLIK. Once bakilir cunku en yuksek siddeti tasir ve
  //     runbook'ta AYRI bir dala gider: bosaltacak pencere KALMAMISTIR.
  if (
    state.currentTarget !== ZERO_ADDRESS &&
    !isAllowed(state.currentTarget, allowlist.graduationTargets)
  ) {
    findings.push('graduation-target-off-allowlist')
    severity = maxSeverity(severity, 'critical')
    parts.push(
      `graduationTarget is ${state.currentTarget}, which is NOT on the allowlist -- THE CHANGE HAS ALREADY LANDED AND THE DRAIN WINDOW IS OVER; every completed curve now pays out to that address on graduate(). ${exposureText}`,
    )
  }

  // (2) BEKLEYEN ONERI.
  if (state.pendingTarget === ZERO_ADDRESS) {
    findings.push('no-pending-target')
  } else if (isAllowed(state.pendingTarget, allowlist.graduationTargets)) {
    findings.push('pending-target-allowlisted')
    severity = maxSeverity(severity, 'notice')
    parts.push(
      `pendingGraduationTarget is ${state.pendingTarget}, which IS on the allowlist. ${windowText} ${exposureText}`,
    )
  } else if (state.phase === 'expired') {
    // SURESI GECMIS ONERI ATILDIR: `applyGraduationTarget` artik
    // `GraduationTargetProposalExpired()` ile reddeder, yani inemez. Sayfa
    // CIKARMAZ -- ama sessizce de gecilmez: ayni governor yeniden onerebilir
    // ve bu, ele gecirilmis bir governor'in kaydidir.
    findings.push('pending-target-not-allowlisted-expired')
    severity = maxSeverity(severity, 'notice')
    parts.push(
      `pendingGraduationTarget is ${state.pendingTarget}, which is NOT on the allowlist, but the proposal EXPIRED at ${renderTime(state.expiresAt)} and applyGraduationTarget() now reverts GraduationTargetProposalExpired(). Inert, but it is evidence: the same governor can re-propose. ${windowText}`,
    )
  } else {
    findings.push('pending-target-not-allowlisted')
    severity = maxSeverity(severity, 'page')
    parts.push(
      `pendingGraduationTarget is ${state.pendingTarget}, which is NOT on the allowlist. ${windowText} ${exposureText} -- applyGraduationTarget() is PERMISSIONLESS, so anyone including the proposer can land it the moment the window opens.`,
    )
  }

  // (3) HAZINE. GECIKMESIZDIR, yani bu her zaman POST-HOC bir alarmdir.
  if (
    state.protocolTreasury !== ZERO_ADDRESS &&
    !isAllowed(state.protocolTreasury, allowlist.treasuries)
  ) {
    findings.push('protocol-treasury-off-allowlist')
    severity = maxSeverity(severity, 'page')
    parts.push(
      `protocolTreasury is ${state.protocolTreasury}, which is NOT on the allowlist. setProtocolTreasury has NO DELAY by design, so this alert is always after the fact; there is no window to act inside.`,
    )
  }

  const quiet = severity === 'none'
  return {
    level: severityToLevel(severity),
    severity,
    reason: quiet
      ? `no pending graduation target; graduationTarget=${state.currentTarget} protocolTreasury=${state.protocolTreasury} block=${state.blockNumber}`
      : `${parts.join(' | ')} [block=${state.blockNumber} factoryDelay=${state.delaySeconds}s]`,
    findings,
    quiet,
  }
}

function isAllowed(candidate: Address, allowed: readonly Address[]): boolean {
  const needle = candidate.toLowerCase()
  return allowed.some((entry) => entry.toLowerCase() === needle)
}

function renderExposure(exposure: ExposureReport | undefined): string {
  if (exposure === undefined) {
    return 'exposure=UNMEASURED (the curve scan did not complete; treat the amount at risk as unknown, not zero)'
  }
  const bound = exposure.complete ? 'exact' : 'LOWER BOUND -- the log scan was incomplete'
  return `exposure=${exposure.count} completed-but-ungraduated curve(s), ${formatUsdc(exposure.totalQuoteWei)} USDC (${exposure.totalQuoteWei} wei, ${bound})`
}

/** ISO-8601, UTC. Locale'e dusen bir bicimlendirici bir sayfada okunamaz. */
function renderTime(seconds: bigint): string {
  if (seconds === 0n) return '0(unset)'
  return `${seconds}(${new Date(Number(seconds) * 1000).toISOString()})`
}

// ---------------------------------------------------------------
// Curve kumesi -- Faz 1d'de loglardan, Faz 3'ten sonra @arcpad/db'den
// ---------------------------------------------------------------

export class LogScanError extends Error {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  constructor(fromBlock: bigint, toBlock: bigint, cause: unknown) {
    super(
      `Launched log scan failed over [${fromBlock}, ${toBlock}]: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'LogScanError'
    this.fromBlock = fromBlock
    this.toBlock = toBlock
  }
}

export type Cursor = { lastScannedBlock: bigint; curves: Address[] }

export interface CursorStore {
  read(): Cursor | null
  write(cursor: Cursor): void
}

/** Yeniden baslatma genesis'ten yeniden taramasin diye. `keeper/.cursor`. */
export function fileCursorStore(path: string): CursorStore {
  return {
    read(): Cursor | null {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return null
      }
      const parsed = JSON.parse(raw) as { lastScannedBlock?: unknown; curves?: unknown }
      if (typeof parsed.lastScannedBlock !== 'string' || !Array.isArray(parsed.curves)) {
        throw new Error(`${path} is not a keeper cursor; refusing to guess`)
      }
      return {
        lastScannedBlock: BigInt(parsed.lastScannedBlock),
        curves: parsed.curves.map((entry, i) => asAddress(entry, `${path}.curves[${i}]`)),
      }
    },
    write(cursor: Cursor): void {
      writeFileSync(
        path,
        `${JSON.stringify({ lastScannedBlock: cursor.lastScannedBlock.toString(), curves: cursor.curves }, null, 2)}\n`,
        'utf8',
      )
    },
  }
}

export const DEFAULT_LOG_SCAN_CHUNK = 10_000n

/**
 * KURUM ICI INDEXER OLMADIGI ICIN CURVE KUMESI LOGLARDAN GELIR.
 *
 * MARUZIYETI EKSIK BILDIREN BIR SAYFA, HIC SAYFA CIKARMAMAKTAN DAHA KOTUDUR:
 * "3 curve, 36 USDC risk altinda" diyen bir sayfa, gercek sayi 30 iken
 * rota'yi yanlis bir karara goturur. Bu yuzden bir RPC aralik hatasi KISA BIR
 * LISTEYE DEGIL, `LogScanError`a cevrilir; `runWatcher` onu sayfa sayar.
 *
 * Faz 3'ten sonra govde `@arcpad/db` sorgusuyla degisir, imza aynen kalir.
 */
export async function knownCurves(
  client: ChainReader,
  factory: Address,
  startBlock: bigint,
  opts?: { store?: CursorStore; head?: bigint; chunk?: bigint },
): Promise<Address[]> {
  if (LAUNCHED_EVENT === undefined) throw new Error('Launched event missing from FACTORY_WATCH_ABI')

  const head = opts?.head ?? (await client.getBlock()).number
  const chunk = opts?.chunk ?? DEFAULT_LOG_SCAN_CHUNK
  if (chunk <= 0n) throw new Error(`log scan chunk must be positive, got ${chunk}`)

  const store = opts?.store
  const cursor = store?.read() ?? null

  // IMLEC BASLIGIN ILERISINDEYSE DURUR. Bu ya bir reorg ya da yanlis zincire
  // isaret eden bir RPC'dir; iki durumda da imlecin "taradim" dedigi araliga
  // guvenmek, hic taranmamis bloklari taranmis saymak olurdu.
  if (cursor !== null && cursor.lastScannedBlock > head) {
    throw new LogScanError(
      cursor.lastScannedBlock,
      head,
      new Error(`cursor is ahead of the chain head (${cursor.lastScannedBlock} > ${head})`),
    )
  }

  const seen = new Set<Address>(cursor?.curves ?? [])
  let from = cursor === null ? startBlock : cursor.lastScannedBlock + 1n
  if (from < startBlock) from = startBlock

  while (from <= head) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n
    let logs: ReadonlyArray<{ args?: Record<string, unknown> }>
    try {
      logs = await client.getLogs({
        address: factory,
        event: LAUNCHED_EVENT,
        fromBlock: from,
        toBlock: to,
      })
    } catch (cause) {
      // IMLEC YAZILMAZ. Basarili on eki kaydetmek hizli olurdu ama bir sonraki
      // kosuya "bu araligi taradim" demenin yollarindan biri de yarim yazilmis
      // bir imlectir; yeniden taramak ucuz, eksik taramak degil.
      throw new LogScanError(from, to, cause)
    }
    for (const log of logs) {
      const curve = log.args?.['curve']
      if (curve === undefined) {
        throw new LogScanError(from, to, new Error('a Launched log carried no `curve` argument'))
      }
      seen.add(asAddress(curve, 'Launched.curve'))
    }
    from = to + 1n
  }

  const curves = [...seen].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
  store?.write({ lastScannedBlock: head, curves })
  return curves
}

/**
 * TAMAMLANMIS AMA MEZUN EDILMEMIS curve'ler ve `realQuoteReserves` toplami.
 *
 * Bir okuma hatasi YUTULMAZ. Tek bir curve okunamadiginda "0 say ve devam et"
 * demek, tam olarak `knownCurves`in reddettigi eksik bildirimi arka kapidan
 * geri getirirdi.
 */
export async function exposure(
  client: ChainReader,
  curves: readonly Address[],
  blockNumber: bigint,
): Promise<{ count: number; totalQuoteWei: bigint }> {
  let count = 0
  let totalQuoteWei = 0n

  for (const curve of curves) {
    const read = (functionName: string): Promise<unknown> =>
      client.readContract({ address: curve, abi: CURVE_WATCH_ABI, functionName, blockNumber })
    const [completeRaw, graduatedRaw, reservesRaw] = await Promise.all([
      read('complete'),
      read('graduated'),
      read('realQuoteReserves'),
    ])
    const complete = asBoolean(completeRaw, `${curve}.complete`)
    const graduated = asBoolean(graduatedRaw, `${curve}.graduated`)
    if (complete && !graduated) {
      count += 1
      totalQuoteWei += asBigint(reservesRaw, `${curve}.realQuoteReserves`)
    }
  }

  return { count, totalQuoteWei }
}

// ---------------------------------------------------------------
// Tek poll
// ---------------------------------------------------------------

export interface WatcherDeps {
  client: ChainReader
  factory: Address
  startBlock: bigint
  allowlist: Allowlist
  alert: (level: AlertLevel, message: string) => void
  heartbeat: () => void
  liveness?: Liveness
  store?: CursorStore
  chunk?: bigint
  nowMs?: () => number
}

/**
 * BIR POLL. Dongu `index.ts`in.
 *
 * ASLA REJECT ETMEZ. Poll'u firlatarak biten bir izleyici, dongunun ustunde
 * bir `catch` unutuldugu anda TAMAMEN susar; bunun yerine her hata bir sayfaya
 * cevrilir ve -- en az onun kadar onemlisi -- KALP ATISI YAYILMAZ. Kalp atisi
 * "bir poll bastan sona tamamlandi" demektir, "fonksiyon dondu" degil. Iki
 * poll boyunca eksik kalan kalp atisi kanaryayi tetikler; boylece alarm
 * yolunun kendisi bozulsa bile sessizlik gorunur olur.
 *
 * SIRA KASITLIDIR: pencere siniflandirmasi curve taramasinin BASARISINA BAGLI
 * DEGILDIR. Loglar dusse bile slotlardan okunan pencere yine siniflandirilir
 * ve gerekiyorsa sayfa cikar -- yalnizca maruziyet "UNMEASURED" olur. Bir
 * ozelligi tek bir yola bagli birakmak, bu depoda sekiz kez tekrarlanan
 * hatanin ta kendisidir.
 */
export async function runWatcher(deps: WatcherDeps): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now
  const at = nowMs()

  let state: WindowState
  try {
    state = await readWindowState(deps.client, deps.factory)
  } catch (error) {
    deps.alert(
      'page',
      `watcher-state-read-failed: the factory's storage-backed getters could not be read, so the graduation window is UNKNOWN this poll: ${describe(error)}`,
    )
    return
  }

  deps.liveness?.observeHead(state.blockNumber, at)

  let curves: Address[] = []
  let scanOk = true
  try {
    const scanOpts: { store?: CursorStore; head: bigint; chunk?: bigint } = {
      head: state.blockNumber,
    }
    if (deps.store !== undefined) scanOpts.store = deps.store
    if (deps.chunk !== undefined) scanOpts.chunk = deps.chunk
    curves = await knownCurves(deps.client, deps.factory, deps.startBlock, scanOpts)
  } catch (error) {
    scanOk = false
    deps.alert(
      'page',
      `log-scan-failed: the Launched scan threw rather than returning a short list, so the exposure below is NOT a number: ${describe(error)}`,
    )
  }

  // SLOT, LOGU DOGRULAR. `launchCount` her `launch()`ta bir artar ve her
  // `launch()` tam olarak bir `Launched` yayar (26ce330 LaunchFactory.launch),
  // yani slot log sayisinin TAM bir kehanetidir. Bir log akisinin sessizce
  // dusmesinin baska hicbir yerel tespiti yoktur -- "hicbir launch olmamis"
  // ile "loglar gelmiyor" yalnizca burada ayrisir.
  const countMatches = scanOk && BigInt(curves.length) === state.launchCount
  if (scanOk && !countMatches) {
    deps.alert(
      'page',
      `log-scan-incomplete: the Launched scan returned ${curves.length} curve(s) but the factory's launchCount slot says ${state.launchCount} at block ${state.blockNumber}. The log path is under-reporting; every exposure number below is a LOWER BOUND.`,
    )
  }

  // TARAMA COKTUYSE MARUZIYET HIC OLCULMEZ.
  //
  // Bu satirin bir onceki hali `exposure(client, [], block)` cagiriyordu ve
  // BASARIYLA `{count: 0, totalQuoteWei: 0}` donuyordu -- yani log yolu
  // coktugu icin bos kalan liste, sayfaya "0 curve, 0.00 USDC" diye TAM BIR
  // OLCUM olarak yaziliyordu. Tam olarak `knownCurves`in kisa liste dondurmeyi
  // reddederek engelledigi eksik bildirim, arka kapidan geri gelmisti.
  // Testle bulundu, okumayla degil.
  let measured: { count: number; totalQuoteWei: bigint } | undefined
  if (scanOk) {
    try {
      measured = await exposure(deps.client, curves, state.blockNumber)
    } catch (error) {
      deps.alert('page', `exposure-read-failed: a curve could not be read: ${describe(error)}`)
    }
  }

  const report: ExposureReport | undefined =
    measured === undefined ? undefined : { ...measured, complete: countMatches }

  const classification = classify(state, deps.allowlist, report)
  if (!classification.quiet) deps.alert(classification.level, classification.reason)

  // KALP ATISI YALNIZCA HER SEY YURUDUYSE. Yarim bir poll'a atis vermek,
  // kanaryayi bosaltirdi.
  if (scanOk && countMatches && measured !== undefined) {
    deps.heartbeat()
    deps.liveness?.pollSucceeded(at)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

// ---------------------------------------------------------------
// Tip daraltma -- her biri ALANI ADIYLA firlatir
// ---------------------------------------------------------------

export function asAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new TypeError(`${field}: expected an address, got ${JSON.stringify(value)}`)
  }
  return getAddress(value)
}

function asBigint(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${field}: expected a bigint, got ${JSON.stringify(String(value))}`)
  }
  return value
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field}: expected a boolean, got ${JSON.stringify(String(value))}`)
  }
  return value
}
