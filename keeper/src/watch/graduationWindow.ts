import { readFileSync, writeFileSync } from 'node:fs'
import { formatUsdc } from '@arcpad/shared'
import { type Address, getAddress, isAddress } from 'viem'
import {
  type AlertLevel,
  type AlertThrottle,
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
  // Siniflandirmada okunmaz; yalnizca acilistaki
  // `assertFactoryMatchesGovernance` pini icin.
  {
    type: 'function',
    name: 'governor',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
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
  // `Completed` OLAYI BILEREK BURADA DEGILDIR ve yoklugu bir eksiklik degil bir
  // karardir. Gorev tanimi Adim 1'de onu sayar; ama izleyici zaten BILINEN HER
  // CURVE'UN `complete()` SLOTUNU HER POLL OKUR (bkz. `exposure`), ve slot
  // logdan KESINLIKLE DAHA GUNCELDIR: log gecmisi verir, slot bugunu. Bu tek
  // olay icin ikisi CAKISIR -- log'un slotun bilmedigi hicbir seyi yoktur,
  // cunku `complete` bir kez true olur ve asla geri donmez. Governance
  // olaylarinda durum TERSIDIR (asagi bkz.) ve orada loglar GERCEKTEN
  // sorgulanir. Olu bir ABI girdisi birakmak, bir sonraki okuyucuya canli
  // sanacagi bir sey birakmak olurdu; o yuzden silindi.
] as const

function eventNamed(abi: readonly unknown[], name: string): unknown {
  const found = (abi as ReadonlyArray<{ type?: string; name?: string }>).find(
    (entry) => entry.type === 'event' && entry.name === name,
  )
  if (found === undefined) throw new Error(`event ${name} missing from the watch ABI`)
  return found
}

const LAUNCHED_EVENT = eventNamed(FACTORY_WATCH_ABI, 'Launched')

/**
 * GECMIS YARISI. Slotlar mevcut durum hakkinda yalan soyleyemez ama BIR
 * ONERININ YAPILIP UZERINE YAZILDIGINI DE SOYLEYEMEZ -- ve gorev tanimindaki
 * "hem slot hem log" gerekcesinin tam olarak bu yarisi ilk turda eksikti.
 *
 * Somut kor nokta olculdu: dusman bir hedef onerilir, iner, uc gun sonra
 * mesru bir oneriyle degistirilir. Sonrasinda `graduationTarget` izin
 * listesindedir ve `pendingGraduationTarget` sifirdir -- SLOTLAR TERTEMIZ
 * OKUNUR ve izleyici `quiet` siniflandirir. Olan biteni tasiyan tek yerel
 * kayit `GraduationTargetChanged`tir. Yeniden baslatma da ayni sekilde kordur,
 * cunku butun durum slottan turetilir.
 */
const GOVERNANCE_EVENTS = [
  eventNamed(FACTORY_WATCH_ABI, 'GraduationTargetProposed'),
  eventNamed(FACTORY_WATCH_ABI, 'GraduationTargetChanged'),
  eventNamed(FACTORY_WATCH_ABI, 'ProtocolTreasuryChanged'),
] as const

const SCAN_EVENTS = [LAUNCHED_EVENT, ...GOVERNANCE_EVENTS] as const

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

/** `events` COGULDUR: tek bir taramada dort olay birden cekilir. */
export interface LogQuery {
  address: Address
  events: readonly unknown[]
  fromBlock: bigint
  toBlock: bigint
}

export type ObservedLog = { eventName?: string; args?: Record<string, unknown> }

export type HeadBlock = { number: bigint; timestamp: bigint }

export interface ChainReader {
  getBlock(): Promise<HeadBlock>
  readContract(call: ReadCall): Promise<unknown>
  getLogs(query: LogQuery): Promise<ReadonlyArray<ObservedLog>>
}

// ---------------------------------------------------------------
// Pencere
// ---------------------------------------------------------------

export type WindowPhase = 'none' | 'armed' | 'open' | 'expired'

/**
 * PENCERE GIRDILERININ GUVENILIRLIGI.
 *
 * `phase === 'expired'`, dusman bir hedef icin TEK sessiz daldir ve ona
 * zincirin verdigi iki sayiyla varilir: `head.timestamp` ve
 * `GRADUATION_TARGET_DELAY()`. Ikisi de dogrulanmadan kullanildiginda,
 * pencereyi KISALTAN her hata sessizlik uretir. Bu bayrak o iki sayinin
 * denetimidir ve `classify` onu gordugunde `expired` indirimini REDDEDER.
 */
export type WindowTrust = { trusted: boolean; reasons: string[] }

/**
 * `delaySeconds`, `blockNumber`, `launchCount`, `protocolTreasury` ve `trust`
 * alanlari gorev tanimindaki dorde EKLENMISTIR; hicbiri kaldirilmadi.
 * Gerekceleri `readWindowState`in NatSpec'inde ve `runWatcher`da.
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
  trust: WindowTrust
}

/**
 * ICINDE HAREKET EDILEMEYEN BIR PENCERE, PENCERE DEGILDIR.
 *
 * Taban runbook'un kendi sayisindan okunur, secilmez: rota'nin kabul suresi
 * 30 dakikadir, uzerine imza toplama payi. Bir saatin altindaki her gecikme,
 * ilan suresi olarak islevsizdir -- ve `delaySeconds === 0` ozel olarak
 * OLUMCULDUR, cunku `expiresAt === opensAt` yapar ve her oneri bir saniye
 * sonra `expired`, yani SESSIZ olur.
 */
export const MIN_ACTIONABLE_DELAY_SECONDS = 3_600n

/** Zincir saatiyle yerel saat arasinda tolere edilen fark. */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS = 900n

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
 *
 * OKUNAN IKI SAYI AYRICA DENETLENIR. `assertArcChain` zincir kimligini korur;
 * SAATI hicbir sey korumuyordu. Tamamen dusman bir RPC zaten her seyi
 * yalanlayabilir (dogrudan iyi hedefi dondurebilir), yani mesele saldirgan
 * kabiliyeti degil: MASUM kayma -- suruklenmis bir testnet node'u, bir
 * fork/replay ucu, yanlis kurulmus bir saat -- tek kontrolu sessizce devre disi
 * birakabiliyordu, hem de kalp atisi akmaya devam ederken.
 */
export async function readWindowState(
  client: ChainReader,
  factory: Address,
  opts?: {
    nowMs?: () => number
    skewToleranceSeconds?: bigint
    minDelaySeconds?: bigint
  },
): Promise<WindowState> {
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

  const minDelay = opts?.minDelaySeconds ?? MIN_ACTIONABLE_DELAY_SECONDS
  const tolerance = opts?.skewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS
  const wallSeconds = BigInt(Math.trunc((opts?.nowMs ?? Date.now)() / 1000))
  const skew = nowSeconds - wallSeconds
  const reasons: string[] = []
  if (delaySeconds < minDelay) {
    reasons.push(
      `GRADUATION_TARGET_DELAY() reported ${delaySeconds}s, below the ${minDelay}s floor -- a window nobody can act inside is not a window, and 0 makes every proposal expire one second after it opens`,
    )
  }
  if (skew > tolerance || -skew > tolerance) {
    reasons.push(
      `chain time ${nowSeconds} is ${skew > 0n ? skew : -skew}s ${skew > 0n ? 'ahead of' : 'behind'} local time ${wallSeconds} (tolerance ${tolerance}s) -- the phase is computed from chain time`,
    )
  }

  return {
    pendingTarget,
    pendingEta,
    currentTarget: asAddress(currentRaw, 'graduationTarget'),
    protocolTreasury: asAddress(treasuryRaw, 'protocolTreasury'),
    trust: { trusted: reasons.length === 0, reasons },
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
  /**
   * `expected-governance.json`in bildirdigi governor. SINIFLANDIRMADA
   * KULLANILMAZ; `assertFactoryMatchesGovernance`in DEFTERDEN BAGIMSIZ
   * dayanagidir.
   */
  governor: Address
}

/**
 * PIN'IN CIKTISI, VE `runWatcher`IN FACTORY ALANININ TIPI.
 *
 * NEDEN BIR TIP, NEDEN BIR YORUM DEGIL. Olculdu (round 4, round 7'de aynen
 * yeniden uretildi): `index.ts`teki pin cagrisini SILMEK, `await`ini
 * DUSURMEK ve onu `poll()`dan SONRAYA ALMAK -- ucu de typecheck'ten geciyor,
 * ucu de 179 birim testinin TAMAMINI gecirtiyordu. Yani tek savunma hatti ile
 * "yeniden yonlendirilmis defter" arasinda duran sey, bir SIRALAMA
 * ALISKANLIGIYDI: kimsenin bozmamayi hatirlamasi gereken bir satir sirasi.
 *
 * `PinnedFactory`, o siralamayi bir VERI BAGIMLILIGINA cevirir. `runWatcher`
 * artik `Address` degil bu jetonu ister, ve jetonu uretebilen tek yer
 * `assertFactoryMatchesGovernance`tir. Uc mutasyonun ucu de artik DERLENMEZ:
 *
 *   cagri silinirse      -> `pinned` tanimsiz            (TS2304)
 *   `await` dusurulurse  -> `Promise<PinnedFactory>`     (TS2345)
 *   `poll()`dan sonraya  -> bildiriminden once kullanim  (TS2448)
 *
 * MARKA GERCEK BIR `Symbol`DUR, yalnizca `declare`li bir tip degil: `index.ts`
 * `tsx` altinda kosar ve `tsx` TIP DENETLEMEZ, yani tip tarafi tek basina
 * CALISMA ANINDA hicbir sey ifade etmezdi. `PIN_MARK` disari VERILMEZ, o
 * yuzden bu modulun disinda hicbir yerde -- testler dahil -- bir jeton
 * uydurulamaz; testler de jetonu gercek fonksiyondan alir.
 */
const PIN_MARK = Symbol('arcpad.keeper.pinnedFactory')

export type PinnedFactory = {
  readonly address: Address
  /** Zincirin bildirdigi governor. Jeton, KIME karsi pinlendigini tasir. */
  readonly governor: Address
  readonly [PIN_MARK]: true
}

/**
 * Jetonu ACAR, ve acarken MARKAYI CALISMA ANINDA dogrular.
 *
 * Tip tarafi derleme aninda yeterlidir; bu, `tsx`in tip denetlemeden kosan
 * uretim yolu icin ayni kapiyi calisma aninda kurar. Bir `undefined` ya da bir
 * `Promise` buraya geldiginde SESSIZCE `undefined` bir adrese cozulmez --
 * ADIYLA duser.
 */
export function pinnedAddress(pinned: PinnedFactory): Address {
  const mark = (pinned as { [PIN_MARK]?: unknown } | null | undefined)?.[PIN_MARK]
  if (mark !== true) {
    throw new Error(
      'the factory handed to the watcher was never pinned: only assertFactoryMatchesGovernance() produces a PinnedFactory, and it must be awaited BEFORE the watcher starts. A watcher pointed at an unpinned factory is silent about the right one.',
    )
  }
  return pinned.address
}

/**
 * DEFTERDEN BAGIMSIZ PIN. Baslangicta bir kez.
 *
 * Adres defterinin DIZINI env'e acilinca (`KEEPER_ADDRESS_BOOK_DIR`) factory
 * artik sabit yollu, commit'li bir dosyayla capraz kontrol edilemez hale
 * geldi: `assertEnvAgrees`in iki tarafi da ayni env-secili dosyadan geliyor.
 * Bu fonksiyon ucuncu, BAGIMSIZ bir kaynak getirir -- ZINCIRIN KENDISI --
 * ve onu AYRI yollu governance dosyasina baglar:
 *
 *     defter der ki: factory F
 *     zincir der ki: F.governor() == G
 *     governance dosyasi der ki: governor G olmali
 *
 * Kodu olmayan bir adres de burada duser -- `eth_call` bos doner ve
 * `asAddress` ALANI ADIYLA firlatir.
 *
 * BU PIN NE KADAR GUCLU: OLCULDU, VE ONCEKI IDDIA FAZLA GUCLUYDU.
 *
 * Burada "bayat bir tatbikat dizini BASKA bir gercek factory'yi gosterirse o
 * factory'nin governor'i tutmaz ve izleyici BASLAMAZ" yaziyordu. 2026-08-01'de
 * canli zincire karsi denendi ve TUTMADI: bu projenin kendi tatbikat
 * factory'si `0xfed991C6B9AD7144Df3d670c6b9EcF3620ac6eA5` uretim factory'siyle
 * AYNI governor Safe'ini bildirir, dolayisiyla pin ONA KARSI DA GECER. Yani
 * pin, "yanlis factory" durumunu degil yalnizca "yanlis GOVERNOR" durumunu
 * yakalar; ayni governor tarafindan deploy edilmis her kardes factory pinin
 * altindan gecer -- ve gercek yanlis-yapilandirma senaryosu tam olarak odur.
 *
 * ONU GERCEKTEN DURDURAN SEY BASKA BIR DOSYADIR: `packages/shared`in
 * `parseAddressBook`i, `launchFactory`in `CREATE2(0x4e59...56C, FACTORY_SALT,
 * factoryInitcodeHash)`ten TUREDIGINI dogrular. Ayni denemede yonlendirilmis
 * defter tam olarak orada, ALANI ADIYLA reddedildi:
 *
 *   AddressBookError launchFactory: is 0xfed991C6... but CREATE2(...) derives
 *   0x0d75a4fF...
 *
 * Bunun iki sonucu var ve ikisi de kayda gecmelidir. (1) Yonlendirme tehlikesi
 * SANILANDAN DAHA SIKI kapali -- kanonik CREATE2 adresinde OLMAYAN hicbir
 * factory'ye defter uzerinden isaret edilemez. (2) Bu pin o kapatmanin
 * SEBEBI DEGILDIR, yani `parseAddressBook` degisirse buradaki koruma
 * kendiliginden bosalir. Yukaridaki `loadWatcherConfig` yorumunda "beni
 * kurtaran sey benim savunmam degil, baska bir ajanin dosyasi" diye yazilan
 * sey, olculdugunde BURASI icin de dogru cikti.
 */
export async function assertFactoryMatchesGovernance(
  client: ChainReader,
  factory: Address,
  allowlist: Allowlist,
): Promise<PinnedFactory> {
  const head = await client.getBlock()
  const raw = await client.readContract({
    address: factory,
    abi: FACTORY_WATCH_ABI,
    functionName: 'governor',
    blockNumber: head.number,
  })
  const onChain = asAddress(raw, `${factory}.governor()`)
  if (onChain.toLowerCase() !== allowlist.governor.toLowerCase()) {
    throw new Error(
      `the factory at ${factory} reports governor ${onChain}, but expected-governance.json says ${allowlist.governor}. Either the address book points at a different factory than the governance file describes -- the shape a stale KEEPER_ADDRESS_BOOK_DIR produces -- or the governor was rotated without updating the file. Refusing to start: a watcher pointed at the wrong factory is silent about the right one.`,
    )
  }
  // JETON YALNIZCA BURADA URETILIR. `runWatcher`in factory alani bu tiptir,
  // yani pin ADIMI ATLANAMAZ -- atlanirsa derlenmez.
  return { address: factory, governor: onChain, [PIN_MARK]: true }
}

export type FindingCode =
  | 'no-pending-target'
  | 'pending-target-allowlisted'
  | 'pending-target-not-allowlisted'
  | 'pending-target-not-allowlisted-expired'
  | 'graduation-target-off-allowlist'
  | 'protocol-treasury-off-allowlist'
  | 'window-inputs-untrusted'
  | 'historic-target-landed-off-allowlist'
  | 'historic-proposal-off-allowlist'
  | 'historic-treasury-off-allowlist'

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
  /**
   * TEKRAR BASTIRMA ANAHTARI. DURUMDAN turer, MESAJDAN degil: mesaj zaman
   * damgasi tasir ve asla tekrar etmez, yani mesaja gore dedup HICBIR SEYI
   * bastirmazdi. Anahtar bulgulari ve ilgili adresleri tasir, boylece FARKLI
   * bir dusman hedef ANINDA yeni bir sayfa cikarir.
   */
  key: string
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
  history?: GovernanceHistory,
): Classification {
  const findings: FindingCode[] = []
  const parts: string[] = []
  let severity: Severity = 'none'

  const exposureText = renderExposure(exposure)
  const windowText = `opensAt=${renderTime(state.opensAt)} expiresAt=${renderTime(state.expiresAt)} phase=${state.phase} chainNow=${renderTime(state.nowSeconds)}`

  // (0) GIRDILERE GUVENILIYOR MU. Once bakilir cunku (2)'nin SESSIZ dalini
  //     kapatan sey budur.
  if (!state.trust.trusted) {
    findings.push('window-inputs-untrusted')
    severity = maxSeverity(severity, 'page')
    parts.push(
      `WINDOW INPUTS CANNOT BE TRUSTED, so the expiry downgrade is refused and every non-allowlisted target below pages regardless of phase: ${state.trust.reasons.join('; ')}`,
    )
  }

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
  } else if (state.phase === 'expired' && state.trust.trusted) {
    // SURESI GECMIS ONERI ATILDIR: `applyGraduationTarget` artik
    // `GraduationTargetProposalExpired()` ile reddeder, yani inemez. Sayfa
    // CIKARMAZ -- ama sessizce de gecilmez: ayni governor yeniden onerebilir
    // ve bu, ele gecirilmis bir governor'in kaydidir.
    //
    // `state.trust.trusted` KOSULU ZORUNLUDUR ve olculerek eklendi: bu, dusman
    // bir hedefin sayfa cikarmadigi TEK daldir, ve ona zincirin dogrulanmamis
    // saatiyle varilir. One kaymis bir zaman damgasi TAZE bir oneriyi buraya
    // dusuruyordu -- sifir sayfa, kalp atisi akiyor, iki blok dedektoru de
    // sessiz. Guvenilmeyen bir saatte indirimi reddetmek, yanlislikla
    // sayfa cikarmayi yanlislikla susmaya TERCIH ETMEKTIR.
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

  // (4) GECMIS. Slotlar bugunu soyler; loglar OLAN BITENI. Buradaki adresler
  //     su an hicbir slotta GORUNMEYENLERDIR -- gorunenleri (1) ve (3) zaten
  //     rapor etti, iki kez saymanin anlami yok.
  if (history !== undefined) {
    const landed = offAllowlist(history.landedTargets, allowlist.graduationTargets, [
      state.currentTarget,
    ])
    if (landed.length > 0) {
      findings.push('historic-target-landed-off-allowlist')
      severity = maxSeverity(severity, 'page')
      parts.push(
        `GraduationTargetChanged shows the pointer WAS held by ${landed.join(', ')}, none of which are on the allowlist, even though the CURRENT target reads clean. Any curve that completed while it was held could have been graduated to it. The slots cannot show this; only the log can.`,
      )
    }

    // `currentTarget` DE ELENIR: (1) onu zaten rapor etti. Elenmeseydi ayni
    // adres hem "su an isaretli" hem "gecmiste onerilmis" diye iki kez
    // gorunurdu ve sayfa kendini tekrar ederdi.
    const proposed = offAllowlist(history.proposedTargets, allowlist.graduationTargets, [
      state.pendingTarget,
      state.currentTarget,
      ...landed,
    ])
    if (proposed.length > 0) {
      findings.push('historic-proposal-off-allowlist')
      severity = maxSeverity(severity, 'notice')
      parts.push(
        `GraduationTargetProposed shows ${proposed.join(', ')} was proposed and never landed (overwritten or expired). Inert now, but it is the day-0 attack's footprint and the slots have already forgotten it.`,
      )
    }

    const treasuries = offAllowlist(history.treasuries, allowlist.treasuries, [
      state.protocolTreasury,
    ])
    if (treasuries.length > 0) {
      findings.push('historic-treasury-off-allowlist')
      severity = maxSeverity(severity, 'page')
      parts.push(
        `ProtocolTreasuryChanged shows the fee recipient WAS ${treasuries.join(', ')}, not on the allowlist, though it reads clean now. Fees accrued during that period remain claimable by it.`,
      )
    }
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
    key: [
      'classify',
      severity,
      ...findings,
      state.pendingTarget,
      state.currentTarget,
      state.protocolTreasury,
    ].join('|'),
  }
}

/** `pool` icinde izin listesinde OLMAYAN ve `alreadyReported` icinde bulunmayanlar. */
function offAllowlist(
  pool: readonly Address[],
  allowed: readonly Address[],
  alreadyReported: readonly Address[],
): Address[] {
  const skip = new Set(alreadyReported.map((entry) => entry.toLowerCase()))
  return pool.filter(
    (entry) =>
      entry !== ZERO_ADDRESS && !isAllowed(entry, allowed) && !skip.has(entry.toLowerCase()),
  )
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

/** ECMA-262: `Date` -8.64e15..8.64e15 ms disini temsil edemez. */
const MAX_RENDERABLE_SECONDS = 8_640_000_000_000n

/**
 * ISO-8601, UTC. Locale'e dusen bir bicimlendirici bir sayfada okunamaz.
 *
 * ARALIK DISI GIRDI FIRLATMAZ. Onceki hal `new Date(...).toISOString()`i
 * korumasiz cagiriyordu ve `RangeError: Invalid time value` atiyordu; cagiran
 * `classify` her `try`in DISINDA oldugu icin o poll SIFIR alarm yayiyor,
 * `index.ts`te ise dongu KALICI olarak oluyordu -- yani bir bicimlendirme
 * ayrintisi, izleyicinin bagisik olmasi gereken tam o arizayi uretiyordu.
 * Zincirden gelen bir sayinin bir bicimlendiriciyi patlatabilmesi tek basina
 * yeterli sebeptir; `runWatcher`daki `try` bu duzeltmenin YEDEGIDIR, YERINE
 * GECMEZ.
 */
function renderTime(seconds: bigint): string {
  if (seconds === 0n) return '0(unset)'
  if (seconds < 0n || seconds > MAX_RENDERABLE_SECONDS) return `${seconds}(out-of-range)`
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

/** Governance olaylarindan kurulan GECMIS. Bkz. `GOVERNANCE_EVENTS`. */
export type GovernanceHistory = {
  proposedTargets: Address[]
  landedTargets: Address[]
  treasuries: Address[]
}

export type Cursor = { lastScannedBlock: bigint; curves: Address[]; history: GovernanceHistory }

export interface CursorStore {
  read(): Cursor | null
  write(cursor: Cursor): void
}

/**
 * IMLECIN KIME AIT OLDUGU. Dosya yolu bir KIMLIK DEGILDIR.
 *
 * Faz 2 `LaunchFactory`ye bir `feeSchedule` yapici argumani ekliyor, yani
 * initcode -- ve onunla birlikte CREATE2 adresi -- degisecek. Defter yeni
 * adresi tasiyacak, keeper onu KOD DEGISIKLIGI OLMADAN izleyecek; ama imlec
 * dosyasinin yolu `keeper/.cursor` OLARAK KALIR. Kimliksiz bir imlecte bunun
 * sonucu sessiz degil ama yanlistir ve UC AYRI SEKILDE bozar:
 *
 *   1. `curves` ESKI factory'nin curve'lerini tasir. `exposure()` onlari YENI
 *      factory'nin riski gibi toplar.
 *   2. `history` eski factory'nin oneri/hazine kayitlarini tasir, yani
 *      `historic-*` bulgulari yeni factory'ye karsi surekli ates eder.
 *   3. EN KOTUSU: `lastScannedBlock` eski taramanindir. Yeni factory'nin
 *      `startBlock`i ondan KUCUKSE (baska bir kardes factory'yi izlemeye
 *      gecmek tam olarak bu sekildir) `from = lastScannedBlock + 1` o araligi
 *      ATLAR -- ve `if (from < startBlock) from = startBlock` yalnizca YUKARI
 *      cekebilir, asagi cekemez. `launchCount` orakli SADECE `Launched`i
 *      kapsar; atlanan aralikta kalan uc governance olayi SESSIZCE kaybolur,
 *      ki o uc akis round 1'de tam da bu korluk icin eklenmisti.
 *
 * Bu yuzden kimlik ZORUNLU bir argumandir: her imlec kurulumu, hangi factory
 * icin oldugunu SOYLEMEK ZORUNDADIR. Uyusmayan bir imlec YOK sayilir (bastan
 * tarama), REDDEDILMEZ -- baslamayan bir izleyici, yanlis imlecli bir
 * izleyiciden daha kotudur.
 */
export type CursorIdentity = { chainId: number; factory: Address; startBlock: bigint }

/**
 * SURUM ALANI VARDIR VE GEREKLIDIR. Imlec artik governance gecmisini ve
 * kimligini de tasir; eski sekildeki bir dosyayi "gecmis bos" diye okumak,
 * YENIDEN BASLATMANIN gercek bir uzlasmayi UNUTMASI demek olurdu. Tanimadigi
 * surumu YOK sayar (null doner, bastan tarar) -- tam bir yeniden tarama
 * ucuzdur, eksik bir gecmis degil. Gecerli JSON ama imlec hic degilse yine de
 * FIRLATIR: "tahmin etme" kurali korunur.
 *
 * 2 -> 3: kimlik alanlari eklendi. Surum artisi, bugun diskte duran kimliksiz
 * v2 dosyalarinin da (hangi factory'ye ait olduklari BILINEMEZ) yok
 * sayilmasini saglar.
 */
const CURSOR_VERSION = 3

/**
 * Yeniden baslatma genesis'ten yeniden taramasin diye. `keeper/.cursor`.
 *
 * @param identity Bkz. `CursorIdentity`. Uyusmazsa imlec YOK sayilir.
 * @param onReset  Yok sayma SESSIZ OLMAZ: cagiran taraf bunu alarm akisina
 *                 baglar. Sayfa DEGIL -- redeploy'da beklenen ve kendini
 *                 iyilestiren bir olaydir -- ama kayda gecmelidir, cunku
 *                 "maruziyet neden bir anda sifira dustu" sorusunun cevabi
 *                 budur.
 */
export function fileCursorStore(
  path: string,
  identity: CursorIdentity,
  onReset?: (reason: string) => void,
): CursorStore {
  return {
    read(): Cursor | null {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return null
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed['lastScannedBlock'] !== 'string' || !Array.isArray(parsed['curves'])) {
        throw new Error(`${path} is not a keeper cursor; refusing to guess`)
      }
      if (parsed['version'] !== CURSOR_VERSION) return null
      const history = parsed['history'] as Record<string, unknown> | undefined
      if (typeof history !== 'object' || history === null) return null

      const mismatch = identityMismatch(parsed, identity)
      if (mismatch !== null) {
        onReset?.(
          `${path} was built for ${mismatch}, so it is being ignored and the log scan restarts from block ${identity.startBlock}. This is expected after a factory redeploy; the exposure figure rebuilds over the next few polls.`,
        )
        return null
      }

      return {
        lastScannedBlock: BigInt(parsed['lastScannedBlock']),
        curves: (parsed['curves'] as unknown[]).map((entry, i) =>
          asAddress(entry, `${path}.curves[${i}]`),
        ),
        history: {
          proposedTargets: readAddressList(history['proposedTargets'], `${path}.proposedTargets`),
          landedTargets: readAddressList(history['landedTargets'], `${path}.landedTargets`),
          treasuries: readAddressList(history['treasuries'], `${path}.treasuries`),
        },
      }
    },
    write(cursor: Cursor): void {
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            version: CURSOR_VERSION,
            chainId: identity.chainId,
            factory: identity.factory,
            startBlock: identity.startBlock.toString(),
            lastScannedBlock: cursor.lastScannedBlock.toString(),
            curves: cursor.curves,
            history: cursor.history,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    },
  }
}

/** Uyusmayan ALANI ADIYLA anlatir; `null` ise imlec bu izleyiciye aittir. */
function identityMismatch(
  parsed: Record<string, unknown>,
  identity: CursorIdentity,
): string | null {
  const factory = parsed['factory']
  if (typeof factory !== 'string' || getAddress(factory) !== identity.factory) {
    return `factory ${typeof factory === 'string' ? factory : JSON.stringify(factory)}, not ${identity.factory}`
  }
  if (parsed['chainId'] !== identity.chainId) {
    return `chainId ${JSON.stringify(parsed['chainId'])}, not ${identity.chainId}`
  }
  if (
    typeof parsed['startBlock'] !== 'string' ||
    BigInt(parsed['startBlock']) !== identity.startBlock
  ) {
    return `startBlock ${JSON.stringify(parsed['startBlock'])}, not ${identity.startBlock}`
  }
  return null
}

function readAddressList(value: unknown, field: string): Address[] {
  if (!Array.isArray(value)) return []
  return value.map((entry, i) => asAddress(entry, `${field}[${i}]`))
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
  return (await scanFactoryLogs(client, factory, startBlock, opts)).curves
}

/**
 * TEK GECISTE DORT OLAY: `Launched` + uc governance olayi.
 *
 * Ayni blok araliklari zaten yuruniyor; ayri bir tarama ikinci bir imlec,
 * ikinci bir hata yolu ve iki taramanin AYRISABILECEGI bir pencere yaratirdi.
 */
export async function scanFactoryLogs(
  client: ChainReader,
  factory: Address,
  startBlock: bigint,
  opts?: { store?: CursorStore; head?: bigint; chunk?: bigint },
): Promise<{ curves: Address[]; history: GovernanceHistory }> {
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
  const proposed = new Set<Address>(cursor?.history.proposedTargets ?? [])
  const landed = new Set<Address>(cursor?.history.landedTargets ?? [])
  const treasuries = new Set<Address>(cursor?.history.treasuries ?? [])

  let from = cursor === null ? startBlock : cursor.lastScannedBlock + 1n
  if (from < startBlock) from = startBlock

  const sorted = (set: Set<Address>): Address[] =>
    [...set].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
  const snapshot = (lastScannedBlock: bigint): Cursor => ({
    lastScannedBlock,
    curves: sorted(seen),
    history: {
      proposedTargets: sorted(proposed),
      landedTargets: sorted(landed),
      treasuries: sorted(treasuries),
    },
  })

  while (from <= head) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n
    let logs: ReadonlyArray<ObservedLog>
    try {
      logs = await client.getLogs({
        address: factory,
        events: SCAN_EVENTS,
        fromBlock: from,
        toBlock: to,
      })
    } catch (cause) {
      // BASARILI ON EK KAYDEDILIR, VE BU ONCEKI KARARIN TERSIDIR.
      //
      // Onceki hal hicbir sey yazmiyordu, gerekcesi "yarim yazilmis bir imlec
      // bir sonraki kosuya 'bu araligi taradim' der"di. O gerekce, kaydedilen
      // aralik GERCEKTEN taranmis oldugu icin gecerli degil: `from` DUSEN
      // parcanin baslangicidir, dolayisiyla `from - 1` son BASARILI blogudur ve
      // taranmamis tek bir blok bile "tarandi" diye kaydedilmez.
      //
      // KARSI TARAFI OLCULDU, canli Arc testnet'e karsi, 2026-08-03:
      //
      //   startBlock 54519071, head ~55182283 -> 10.000'lik 67 parca.
      //   14 denemelik geri cekilme butcesi 15. parcada tukendi
      //   (`Request exceeds defined limit / rate limit exceeded`), tarama
      //   FIRLATTI, imlec YAZILMADI, ve bir sonraki poll BIRINCI PARCADAN
      //   basladi. Yani tarama HICBIR ZAMAN ilerlemez: kalp atisi HIC
      //   yayilmaz (`runWatcher` basarisiz poll'da atmaz), maruziyet kalici
      //   olarak UNMEASURED kalir, ve haftalik tatbikat "there was no
      //   watcher" der -- CALISAN ve dogru sayfa cikaran bir izleyici icin.
      //   Olculdu: 45 saniyelik canli kosumda 2 sayfa, SIFIR kalp atisi.
      //
      // Bu tam olarak Faz 2 redeploy'unun uretecegi durumdur: yeni factory =
      // yeni `startBlock` = SOGUK imlec = tam aralik taramasi.
      //
      // Bir sey KAYDEDILMEZ: `from === startBlock` iken, yani hicbir parca
      // tamamlanmamisken. O halde yazilacak ilerleme de yoktur.
      if (from > startBlock) store?.write(snapshot(from - 1n))
      throw new LogScanError(from, to, cause)
    }
    for (const log of logs) {
      const take = (field: string, into: Set<Address>, label: string): void => {
        const value = log.args?.[field]
        if (value === undefined) {
          throw new LogScanError(from, to, new Error(`a ${label} log carried no \`${field}\``))
        }
        into.add(asAddress(value, `${label}.${field}`))
      }
      switch (log.eventName) {
        case 'GraduationTargetProposed':
          take('target', proposed, 'GraduationTargetProposed')
          break
        case 'GraduationTargetChanged':
          take('current', landed, 'GraduationTargetChanged')
          break
        case 'ProtocolTreasuryChanged':
          take('current', treasuries, 'ProtocolTreasuryChanged')
          break
        // `eventName` YOKSA `Launched` VARSAYILIR ve bu bilincli: tek-olayli
        // eski sekli konusan bir okuyucu (ve testlerdeki sade sahteler) hala
        // curve kumesini besler. Governance olaylari adlarini ZORUNLU kilar --
        // adsiz bir log onlara sessizce yazilamaz.
        default:
          take('curve', seen, 'Launched')
      }
    }
    from = to + 1n
  }

  const complete = snapshot(head)
  store?.write(complete)
  return { curves: complete.curves, history: complete.history }
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
  /**
   * `Address` DEGIL. Bkz. `PinnedFactory`: izleyici, zincire karsi pinlenmemis
   * bir factory'ye karsi kosturulamaz -- ne derleme aninda ne calisma aninda.
   */
  factory: PinnedFactory
  startBlock: bigint
  allowlist: Allowlist
  alert: (level: AlertLevel, message: string) => void
  heartbeat: () => void
  liveness?: Liveness
  store?: CursorStore
  chunk?: bigint
  nowMs?: () => number
  /** Bkz. `createThrottle`. Verilmezse HER bulgu HER poll yayilir. */
  throttle?: AlertThrottle
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
  // TEK ISTISNA, VE BILINCLI. Bu fonksiyonun "ASLA REJECT ETMEZ" sozu ZINCIR
  // GOZLEMLERI icindir: bir RPC hatasi sayfaya cevrilir, dongu yasar. Bu satir
  // bir gozlem degil, bir KULLANIM HATASIDIR -- pinlenmemis bir factory'ye
  // karsi kosan izleyici, izlemesi gereken seyi izlemiyordur. Onun dogru
  // sonucu sayfa DEGIL, BASLAMAMAKTIR; sessizce dogru sayfalar cikarip yanlis
  // factory'yi izlemek, bu izleyicinin var olma sebebinin tam tersidir.
  const factory = pinnedAddress(deps.factory)
  const nowMs = deps.nowMs ?? Date.now
  const at = nowMs()
  const activeKeys = new Set<string>()

  const emit = (level: AlertLevel, key: string, message: string): void => {
    activeKeys.add(key)
    if (deps.throttle === undefined || deps.throttle.shouldEmit(key, at)) deps.alert(level, message)
  }

  let state: WindowState
  try {
    state = await readWindowState(deps.client, factory, { nowMs })
  } catch (error) {
    emit(
      'page',
      'watcher-state-read-failed',
      `watcher-state-read-failed: the factory's storage-backed getters could not be read, so the graduation window is UNKNOWN this poll: ${describe(error)}`,
    )
    deps.throttle?.sweep(activeKeys)
    return
  }

  deps.liveness?.observeHead(state.blockNumber, at)
  deps.liveness?.observeChainTime(state.nowSeconds, at)

  let curves: Address[] = []
  let history: GovernanceHistory | undefined
  let scanOk = true
  try {
    const scanOpts: { store?: CursorStore; head: bigint; chunk?: bigint } = {
      head: state.blockNumber,
    }
    if (deps.store !== undefined) scanOpts.store = deps.store
    if (deps.chunk !== undefined) scanOpts.chunk = deps.chunk
    const scan = await scanFactoryLogs(deps.client, factory, deps.startBlock, scanOpts)
    curves = scan.curves
    history = scan.history
  } catch (error) {
    scanOk = false
    emit(
      'page',
      'log-scan-failed',
      `log-scan-failed: the factory log scan threw rather than returning a short list, so the exposure below is NOT a number and the governance history is UNKNOWN: ${describe(error)}`,
    )
  }

  // SLOT, LOGU DOGRULAR. `launchCount` her `launch()`ta bir artar ve her
  // `launch()` tam olarak bir `Launched` yayar (26ce330 LaunchFactory.launch),
  // yani slot log sayisinin TAM bir kehanetidir. Bir log akisinin sessizce
  // dusmesinin baska hicbir yerel tespiti yoktur -- "hicbir launch olmamis"
  // ile "loglar gelmiyor" yalnizca burada ayrisir.
  //
  // KARSILASTIRMA IKI YONLUDUR VE MESAJ DA OYLE. Onceki hal her uyusmazliga
  // "under-reporting / LOWER BOUND" diyordu; fazla-sayma yonunde bu TERSTIR ve
  // caresi de farklidir. Fazla sayma reorg'a ugramis bir `Launched`in imlecte
  // KALMASIYLA olur -- imlec yalnizca ekler, silmez -- ya da `startBlock`
  // yanlissa. Ikisinin de caresi `keeper/.cursor` dosyasini SILMEKTIR ve mesaj
  // bunu SOYLER, cunku bu durum yapiskan: her poll sayfa, sifir kalp atisi.
  const scanned = BigInt(curves.length)
  const countMatches = scanOk && scanned === state.launchCount
  if (scanOk && !countMatches) {
    const over = scanned > state.launchCount
    emit(
      'page',
      `log-scan-${over ? 'over' : 'under'}-reporting`,
      `log-scan-incomplete: the Launched scan returned ${curves.length} curve(s) but the factory's launchCount slot says ${state.launchCount} at block ${state.blockNumber}. The log path is ${over ? 'OVER-reporting -- the cursor is holding a curve the chain no longer has (a reorged-out Launched, or a startBlock that does not match this chain). Remedy: stop the keeper and delete the cursor file so the scan rebuilds from startBlock' : 'UNDER-reporting -- every exposure number below is a LOWER BOUND'}.`,
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
      emit(
        'page',
        'exposure-read-failed',
        `exposure-read-failed: a curve could not be read: ${describe(error)}`,
      )
    }
  }

  const report: ExposureReport | undefined =
    measured === undefined ? undefined : { ...measured, complete: countMatches }

  // SINIFLANDIRMA DA KORUMA ALTINDA, ve bu bir kemer-ve-askidan ibaret degil.
  //
  // Onceki hal `classify`i her `try`in DISINDA cagiriyordu ve fonksiyonun
  // "ASLA REJECT ETMEZ" sozu bu yuzden YANLISTI: `renderTime` icindeki
  // `new Date(...).toISOString()` `RangeError` atiyor, poll SIFIR alarmla
  // dusuyor, ve `index.ts`te yeniden zamanlama `await`ten SONRA oldugu icin
  // DONGU KALICI OLARAK OLUYORDU. Yani bir bicimlendirme ayrintisi, izleyicinin
  // bagisik olmasi gereken tam o arizayi uretiyordu. `renderTime` ayrica
  // duzeltildi; bu `try` onun YEDEGI, YERINE GECENI DEGIL -- bir sonraki
  // bicimlendirici de ayni sekilde patlayabilir ve o zaman da bir sayfa cikmali.
  let classified = false
  try {
    const classification = classify(state, deps.allowlist, report, history)
    if (!classification.quiet) emit(classification.level, classification.key, classification.reason)
    classified = true
  } catch (error) {
    emit(
      'page',
      'classify-threw',
      `classify-threw: the window could not be classified, so the raw state is reported instead -- pendingTarget=${state.pendingTarget} pendingEta=${state.pendingEta} currentTarget=${state.currentTarget} protocolTreasury=${state.protocolTreasury} chainNow=${state.nowSeconds} delay=${state.delaySeconds} block=${state.blockNumber}: ${describe(error)}`,
    )
  }

  // KALP ATISI YALNIZCA HER SEY YURUDUYSE -- SINIFLANDIRMA DAHIL. Yarim bir
  // poll'a atis vermek, kanaryayi bosaltirdi; ve siniflandiramamis bir poll
  // "tamamlanmis" degildir, cunku bu fonksiyonun BUTUN isi odur.
  if (scanOk && countMatches && measured !== undefined && classified) {
    deps.heartbeat()
    deps.liveness?.pollSucceeded(at)
  }

  deps.throttle?.sweep(activeKeys)
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
