import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, getAddress } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import {
  alert as emitAlert,
  type AlertEvent,
  type AlertLevel,
  consoleSink,
  createLiveness,
  createThrottle,
  fileSink,
  heartbeat as emitHeartbeat,
  multiSink,
} from '../src/alert'
import { parseGovernanceAllowlist } from '../src/config'
import { type AlertSinkQuery, drillExpiry, drillObserve, fileAlertSink } from '../src/drill'
import {
  type Allowlist,
  type ChainReader,
  classify,
  computeWindow,
  type CursorIdentity,
  type CursorStore,
  exposure,
  fileCursorStore,
  isRangeTooLarge,
  knownCurves,
  LogScanError,
  assertFactoryMatchesGovernance,
  type PinnedFactory,
  pinnedAddress,
  readWindowState,
  runWatcher,
  scanFactoryLogs,
  type WindowState,
  ZERO_ADDRESS,
} from '../src/watch/graduationWindow'

// ---------------------------------------------------------------
// Sentetik zincir
// ---------------------------------------------------------------

const addr = (tail: string): Address => getAddress(`0x${tail.padStart(40, '0')}`)

const FACTORY = addr('fac7')
const GOOD_TARGET = addr('600d')
const EVIL_TARGET = addr('dead')
const TREASURY = addr('7ea5')
const EVIL_TREASURY = addr('bad7')
const CURVE_A = addr('c0a')
const CURVE_B = addr('c0b')
const CURVE_C = addr('c0c')
/** Faz 2'nin yeni `LaunchFactory`si gibi: AYNI zincir, BASKA adres. */
const FACTORY_2 = addr('fac8')

/**
 * Imlec kimligi ZORUNLU bir argumandir (bkz. `CursorIdentity`), yani her
 * kurulum hangi factory icin oldugunu SOYLEMEK ZORUNDADIR. Testler icin
 * varsayilan kimlik; ayrismayi test edenler acikca ezer.
 */
const CHAIN_ID = 5_042_002
const cursorAt = (
  path: string,
  identity?: Partial<CursorIdentity>,
  onReset?: (reason: string) => void,
): CursorStore =>
  fileCursorStore(
    path,
    { chainId: CHAIN_ID, factory: FACTORY, startBlock: 1n, ...identity },
    onReset,
  )

/** 2026-06-01T00:26:40Z. Gercekci bir unix zamani; ISO ciktisi okunabilir olsun diye. */
const NOW = 1_780_000_000n
/**
 * Sentetik zincirin saatiyle AYNI ANI gosteren yerel saat. Testlerin
 * varsayilani KAYMASIZ olmalidir; kaymayi test eden testler bunu acikca ezer.
 */
const NOW_MS = Number(NOW) * 1000
const localClock = (seconds: bigint) => (): number => Number(seconds) * 1000
const DELAY = 259_200n // 3 days -- SOZLESMEDEN OKUNUR, burada yalnizca fixture degeri

type CurveFixture = { complete: boolean; graduated: boolean; realQuoteReserves: bigint }

type Fixture = {
  blockNumber?: bigint
  timestamp?: bigint
  pendingTarget?: Address
  pendingEta?: bigint
  currentTarget?: Address
  protocolTreasury?: Address
  delay?: bigint
  /** Belirtilmezse `launched.length`. Ayri verilebilmesi log/slot ayrismasini test etmek icindir. */
  launchCount?: bigint
  launched?: Array<{ block: bigint; curve: Address }>
  /** Governance olay gecmisi -- slotlarin unuttugu yari. */
  governanceLogs?: Array<{ block: bigint; eventName: string; args: Record<string, unknown> }>
  /** Yerel duvar saati; zincir saati kaymasini test etmek icin. */
  nowMs?: () => number
  curves?: Record<string, CurveFixture>
  /** Log taramasinin RPC hatasi atmasi. */
  failLogs?: boolean
  /**
   * `failLogs`in mesaji. Varsayilani bir BOYUT hatasidir, yani kucultme
   * dalindan gecer -- aralikla ILGISIZ bir hatayi test etmek isteyen bunu
   * acikca verir.
   */
  failLogsMessage?: string
  /**
   * Log taramasinin YALNIZCA bu blogu iceren parcadan itibaren dusmesi.
   * Canli sekil budur: ilk N parca gecer, sonra hiz siniri butceyi tuketir.
   */
  failLogsFrom?: bigint
  /** Log taramasinin SESSIZCE bos donmesi -- dusmus bir abonelik. */
  dropLogs?: boolean
  /**
   * Saglayicinin KALICI aralik siniri: bu genislikten genis her `getLogs`
   * `-32012 requested range too large` ile duser. Beklemek COZMEZ.
   */
  rangeLimit?: bigint
  /** Slot okumalarinin atmasi. */
  failReads?: boolean
  /** Belirli bir curve okumasinin atmasi. */
  failCurveReads?: boolean
}

type SyntheticChain = ChainReader & {
  /** Her `readContract` cagrisinin sabitlendigi blok numaralari. */
  readBlocks: bigint[]
  logQueries: Array<{ event: string; fromBlock: bigint; toBlock: bigint }>
}

function syntheticChain(fixture: Fixture = {}): SyntheticChain {
  const launched = fixture.launched ?? []
  const curves = fixture.curves ?? {}
  const blockNumber = fixture.blockNumber ?? 1_000n
  const readBlocks: bigint[] = []
  const logQueries: Array<{ event: string; fromBlock: bigint; toBlock: bigint }> = []

  const factoryValues: Record<string, unknown> = {
    pendingGraduationTarget: fixture.pendingTarget ?? ZERO_ADDRESS,
    pendingGraduationTargetEta: fixture.pendingEta ?? 0n,
    graduationTarget: fixture.currentTarget ?? ZERO_ADDRESS,
    protocolTreasury: fixture.protocolTreasury ?? TREASURY,
    GRADUATION_TARGET_DELAY: fixture.delay ?? DELAY,
    launchCount: fixture.launchCount ?? BigInt(launched.length),
  }

  return {
    readBlocks,
    logQueries,
    getBlock() {
      return Promise.resolve({ number: blockNumber, timestamp: fixture.timestamp ?? NOW })
    },
    readContract(call) {
      readBlocks.push(call.blockNumber)
      if (call.address === FACTORY) {
        if (fixture.failReads)
          return Promise.reject(new Error('eth_call reverted: node is unhappy'))
        const value = factoryValues[call.functionName]
        if (value === undefined)
          return Promise.reject(new Error(`no fixture for ${call.functionName}`))
        return Promise.resolve(value)
      }
      if (fixture.failCurveReads) return Promise.reject(new Error('eth_call timed out'))
      const curve = curves[call.address.toLowerCase()]
      if (curve === undefined)
        return Promise.reject(new Error(`no fixture for curve ${call.address}`))
      if (call.functionName === 'complete') return Promise.resolve(curve.complete)
      if (call.functionName === 'graduated') return Promise.resolve(curve.graduated)
      if (call.functionName === 'realQuoteReserves') return Promise.resolve(curve.realQuoteReserves)
      return Promise.reject(new Error(`no fixture for ${call.functionName}`))
    },
    getLogs(query) {
      const names = (query.events as Array<{ name?: string }>).map((e) => e.name ?? '?')
      logQueries.push({
        event: names.join('+'),
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
      })
      if (fixture.failLogs) {
        return Promise.reject(
          new Error(fixture.failLogsMessage ?? 'query returned more than 10000 results'),
        )
      }
      if (fixture.failLogsFrom !== undefined && query.toBlock >= fixture.failLogsFrom) {
        return Promise.reject(new Error('rate limit exceeded'))
      }
      if (
        fixture.rangeLimit !== undefined &&
        query.toBlock - query.fromBlock + 1n > fixture.rangeLimit
      ) {
        // Arc'in olculen sekli: sayisal kod + metin, ikisi birlikte.
        return Promise.reject(
          Object.assign(new Error('requested range too large'), { code: -32012 }),
        )
      }
      if (fixture.dropLogs) return Promise.resolve([])
      const inRange = <T extends { block: bigint }>(entry: T): boolean =>
        entry.block >= query.fromBlock && entry.block <= query.toBlock
      return Promise.resolve([
        ...launched.filter(inRange).map((entry) => ({ args: { curve: entry.curve } })),
        ...(fixture.governanceLogs ?? [])
          .filter(inRange)
          .map((entry) => ({ eventName: entry.eventName, args: entry.args })),
      ])
    },
  }
}

function curveSet(entries: Array<[Address, CurveFixture]>): Record<string, CurveFixture> {
  return Object.fromEntries(entries.map(([address, fixture]) => [address.toLowerCase(), fixture]))
}

const ALLOW_GOOD: Allowlist = {
  graduationTargets: [GOOD_TARGET],
  treasuries: [TREASURY],
  governor: addr('601'),
}
const ALLOW_EMPTY: Allowlist = {
  graduationTargets: [],
  treasuries: [TREASURY],
  governor: addr('601'),
}

/** Yalnizca `governor()` cevaplayan zincir; pin jetonunu uretmek icin. */
const governorChain = (governor: unknown): ChainReader => ({
  getBlock: () => Promise.resolve({ number: 10n, timestamp: NOW }),
  readContract: (call) =>
    call.functionName === 'governor'
      ? Promise.resolve(governor)
      : Promise.reject(new Error('unexpected call')),
  getLogs: () => Promise.resolve([]),
})

/**
 * TESTLERDEKI JETON DA GERCEK FONKSIYONDAN GELIR.
 *
 * `PinnedFactory`nin markasi (`PIN_MARK`) DISARI VERILMEZ, yani burada bir
 * jeton UYDURULAMAZ; tek yol `assertFactoryMatchesGovernance`i gercekten
 * cagirmaktir. Bu bilincli: bu depoda tekrar tekrar olculen ariza, testin
 * test ettigi kodu ATLAYAN bir yoldan iddia etmesidir (M23/M24/M30). Sahte
 * bir jeton uretici, tam olarak onun bir ornegi olurdu.
 */
const PINNED: PinnedFactory = await assertFactoryMatchesGovernance(
  governorChain(ALLOW_GOOD.governor),
  FACTORY,
  ALLOW_GOOD,
)

/** Alarm lavabosu -- her seyi tutar, boylece SESSIZLIK de olculebilir. */
function recorder(): {
  events: AlertEvent[]
  alert: (level: AlertLevel, message: string) => void
  heartbeat: () => void
  pages: () => string[]
  oks: () => string[]
  beats: () => number
} {
  const events: AlertEvent[] = []
  return {
    events,
    alert: (level, message) => {
      events.push({ kind: 'alert', level, message, at: 0 })
    },
    heartbeat: () => {
      events.push({ kind: 'heartbeat', at: 0 })
    },
    pages: () =>
      events.flatMap((e) => (e.kind === 'alert' && e.level === 'page' ? [e.message] : [])),
    oks: () => events.flatMap((e) => (e.kind === 'alert' && e.level === 'ok' ? [e.message] : [])),
    beats: () => events.filter((e) => e.kind === 'heartbeat').length,
  }
}

function watch(fixture: Fixture, allowlist: Allowlist = ALLOW_GOOD, store?: CursorStore) {
  const client = syntheticChain(fixture)
  const sink = recorder()
  const deps = {
    client,
    factory: PINNED,
    startBlock: 1n,
    allowlist,
    alert: sink.alert,
    heartbeat: sink.heartbeat,
    // Varsayilan olarak yerel saat zincir saatiyle AYNI: kayma testleri bunu
    // acikca ezer, geri kalan hicbir test kazara `chain-time-skewed` almaz.
    nowMs: fixture.nowMs ?? localClock(fixture.timestamp ?? NOW),
    ...(store === undefined ? {} : { store }),
  }
  return { client, sink, run: () => runWatcher(deps) }
}

// ---------------------------------------------------------------
// 1. Pencere aritmetigi -- IKI SINIR DA KAPSAYICI
// ---------------------------------------------------------------

describe('computeWindow', () => {
  it('bekleyen oneri yoksa faz none ve iki uc da sifirdir', () => {
    expect(computeWindow(ZERO_ADDRESS, 0n, DELAY, NOW)).toEqual({
      opensAt: 0n,
      expiresAt: 0n,
      phase: 'none',
    })
  })

  it('eta gelecekteyse armed', () => {
    const w = computeWindow(EVIL_TARGET, NOW + 1n, DELAY, NOW)
    expect(w.phase).toBe('armed')
    expect(w.opensAt).toBe(NOW + 1n)
    expect(w.expiresAt).toBe(NOW + 1n + DELAY)
  })

  // SOZLESME: `block.timestamp < eta` reddeder, `block.timestamp > eta + DELAY`
  // reddeder -- yani IKI ucta da islem HALA inebilir. Bir ucta bir saniye kayan
  // bir izleyici rota'ya yanlis sey soyler.
  it('now == eta aninda open (alt sinir KAPSAYICI)', () => {
    expect(computeWindow(EVIL_TARGET, NOW, DELAY, NOW).phase).toBe('open')
  })

  it('now == eta - 1 aninda hala armed', () => {
    expect(computeWindow(EVIL_TARGET, NOW, DELAY, NOW - 1n).phase).toBe('armed')
  })

  it('now == eta + delay aninda hala open (ust sinir KAPSAYICI)', () => {
    expect(computeWindow(EVIL_TARGET, NOW, DELAY, NOW + DELAY).phase).toBe('open')
  })

  it('now == eta + delay + 1 aninda expired', () => {
    expect(computeWindow(EVIL_TARGET, NOW, DELAY, NOW + DELAY + 1n).phase).toBe('expired')
  })

  it('gecikmeyi ARGUMANDAN alir, 3 gunu varsaymaz', () => {
    const oneDay = 86_400n
    const w = computeWindow(EVIL_TARGET, NOW, oneDay, NOW + oneDay)
    expect(w.expiresAt).toBe(NOW + oneDay)
    expect(w.phase).toBe('open')
    expect(computeWindow(EVIL_TARGET, NOW, oneDay, NOW + oneDay + 1n).phase).toBe('expired')
  })
})

// ---------------------------------------------------------------
// 2. Slot okumasi
// ---------------------------------------------------------------

describe('readWindowState', () => {
  it('alti slotu da okur ve pencereyi zincirden gelen gecikmeyle kurar', async () => {
    const client = syntheticChain({
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      currentTarget: GOOD_TARGET,
      protocolTreasury: TREASURY,
      launched: [{ block: 5n, curve: CURVE_A }],
    })
    const state = await readWindowState(client, FACTORY, { nowMs: localClock(NOW) })
    expect(state).toEqual<WindowState>({
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      currentTarget: GOOD_TARGET,
      protocolTreasury: TREASURY,
      nowSeconds: NOW,
      opensAt: NOW + 100n,
      expiresAt: NOW + 100n + DELAY,
      phase: 'armed',
      delaySeconds: DELAY,
      blockNumber: 1_000n,
      launchCount: 1n,
      trust: { trusted: true, reasons: [] },
    })
  })

  // ALTI OKUMA TEK BIR BLOGA SABITLENIR. Sabitlenmeseydi "latest"e karsi
  // yapilan okumalar bir blok sinirini kesip TUTARSIZ bir goruntu uretebilirdi:
  // oneri inisten once, hedef inisten sonra.
  it('her okumayi tek bir blok numarasina sabitler', async () => {
    const client = syntheticChain({ blockNumber: 4_242n })
    await readWindowState(client, FACTORY, { nowMs: localClock(NOW) })
    expect(client.readBlocks.length).toBe(6)
    expect(new Set(client.readBlocks)).toEqual(new Set([4_242n]))
  })

  it('bir slot beklenmedik tip donduruse ALANI ADIYLA firlatir', async () => {
    const client = syntheticChain({})
    const broken: ChainReader = {
      getBlock: () => client.getBlock(),
      readContract: (call) =>
        call.functionName === 'pendingGraduationTargetEta'
          ? Promise.resolve('not a number')
          : client.readContract(call),
      getLogs: (q) => client.getLogs(q),
    }
    await expect(readWindowState(broken, FACTORY, { nowMs: localClock(NOW) })).rejects.toThrow(
      /pendingGraduationTargetEta/,
    )
  })
})

// ---------------------------------------------------------------
// 3. Siniflandirma -- gorev tanimindaki tablo
// ---------------------------------------------------------------

function stateOf(overrides: Partial<WindowState> = {}): WindowState {
  const base: WindowState = {
    pendingTarget: ZERO_ADDRESS,
    pendingEta: 0n,
    currentTarget: ZERO_ADDRESS,
    protocolTreasury: TREASURY,
    nowSeconds: NOW,
    opensAt: 0n,
    expiresAt: 0n,
    phase: 'none',
    delaySeconds: DELAY,
    blockNumber: 1_000n,
    launchCount: 0n,
    trust: { trusted: true, reasons: [] },
  }
  const merged = { ...base, ...overrides }
  const w = computeWindow(
    merged.pendingTarget,
    merged.pendingEta,
    merged.delaySeconds,
    merged.nowSeconds,
  )
  return { ...merged, ...w }
}

describe('classify', () => {
  it('bekleyen oneri yok: ok, sessiz', () => {
    const c = classify(stateOf(), ALLOW_GOOD)
    expect(c.level).toBe('ok')
    expect(c.severity).toBe('none')
    expect(c.quiet).toBe(true)
    expect(c.findings).toEqual(['no-pending-target'])
  })

  it('bekleyen ve izin listesinde, now < eta: armed ve ok ama SESSIZ DEGIL', () => {
    const c = classify(stateOf({ pendingTarget: GOOD_TARGET, pendingEta: NOW + 500n }), ALLOW_GOOD)
    expect(c.level).toBe('ok')
    expect(c.severity).toBe('notice')
    expect(c.quiet).toBe(false)
    expect(c.findings).toEqual(['pending-target-allowlisted'])
    expect(c.reason).toContain('phase=armed')
  })

  it('bekleyen ve izin listesinde DEGIL: sayfa, mesajda hedef ve IKI zaman damgasi', () => {
    const eta = NOW + 500n
    const c = classify(stateOf({ pendingTarget: EVIL_TARGET, pendingEta: eta }), ALLOW_GOOD)
    expect(c.level).toBe('page')
    expect(c.severity).toBe('page')
    expect(c.findings).toEqual(['pending-target-not-allowlisted'])
    expect(c.reason).toContain(EVIL_TARGET)
    expect(c.reason).toContain(`opensAt=${eta}`)
    expect(c.reason).toContain(`expiresAt=${eta + DELAY}`)
    expect(c.reason).toContain(new Date(Number(eta) * 1000).toISOString())
    expect(c.reason).toContain(new Date(Number(eta + DELAY) * 1000).toISOString())
    expect(c.reason).toContain('PERMISSIONLESS')
  })

  it('izin listesi BOS ise sifir olmayan HER hedef sayfa cikarir', () => {
    for (const target of [GOOD_TARGET, EVIL_TARGET, addr('1234')]) {
      const c = classify(stateOf({ pendingTarget: target, pendingEta: NOW + 1n }), ALLOW_EMPTY)
      expect(c.level, `${target} should page against an empty allowlist`).toBe('page')
    }
  })

  it('hedef izleyicinin burnunun dibinde DEGISTI: en yuksek siddet, mesaj pencerenin bittigini soyler', () => {
    const c = classify(stateOf({ currentTarget: EVIL_TARGET }), ALLOW_GOOD)
    expect(c.level).toBe('page')
    expect(c.severity).toBe('critical')
    expect(c.findings).toContain('graduation-target-off-allowlist')
    expect(c.reason).toContain('ALREADY LANDED')
    expect(c.reason).toContain('DRAIN WINDOW IS OVER')
  })

  it('hazine izin listesinde degil: sayfa, ve mesaj GECIKME OLMADIGINI soyler', () => {
    const c = classify(stateOf({ protocolTreasury: EVIL_TREASURY }), ALLOW_GOOD)
    expect(c.level).toBe('page')
    expect(c.findings).toContain('protocol-treasury-off-allowlist')
    expect(c.reason).toContain('NO DELAY')
    expect(c.reason).toContain('after the fact')
  })

  // ERKEN DONUS YOK. Bir bulgu digerini maskeleyemez -- bu depoda on bir kez
  // olculen "bir giris noktasinda kapatilan ozellik hepsinde kapali sayilir"
  // hatasinin `classify` icindeki karsiligi tam olarak budur.
  it('uc bulgu ayni anda: ucu de raporlanir, siddet en yuksegidir', () => {
    const c = classify(
      stateOf({
        pendingTarget: EVIL_TARGET,
        pendingEta: NOW + 10n,
        currentTarget: addr('f00d'),
        protocolTreasury: EVIL_TREASURY,
      }),
      ALLOW_GOOD,
    )
    expect(c.severity).toBe('critical')
    expect(c.findings).toEqual([
      'graduation-target-off-allowlist',
      'pending-target-not-allowlisted',
      'protocol-treasury-off-allowlist',
    ])
    expect(c.reason).toContain(EVIL_TARGET)
    expect(c.reason).toContain(EVIL_TREASURY)
    expect(c.reason).toContain(addr('f00d'))
  })

  it('suresi gecmis dusman oneri SAYFA CIKARMAZ ama sessiz de gecmez', () => {
    const state = stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW - DELAY - 1n })
    expect(state.phase).toBe('expired')
    const c = classify(state, ALLOW_GOOD)
    expect(c.level).toBe('ok')
    expect(c.severity).toBe('notice')
    expect(c.quiet).toBe(false)
    expect(c.findings).toEqual(['pending-target-not-allowlisted-expired'])
    expect(c.reason).toContain('GraduationTargetProposalExpired')
  })

  it('maruziyet mesajda: 0, 1 ve 3 tamamlanmis curve icin sayi DOGRU', () => {
    const cases: Array<[number, bigint, string]> = [
      [0, 0n, '0 completed-but-ungraduated curve(s), 0.00 USDC'],
      [1, 12_160_000_000_000_000_000n, '1 completed-but-ungraduated curve(s), 12.16 USDC'],
      [3, 36_480_000_000_000_000_000n, '3 completed-but-ungraduated curve(s), 36.48 USDC'],
    ]
    for (const [count, wei, expected] of cases) {
      const c = classify(
        stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n }),
        ALLOW_GOOD,
        {
          count,
          totalQuoteWei: wei,
          complete: true,
        },
      )
      expect(c.reason).toContain(expected)
      expect(c.reason).toContain(`${wei} wei`)
    }
  })

  it('maruziyet olculemediyse SIFIR DEGIL "UNMEASURED" yazar', () => {
    const c = classify(stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n }), ALLOW_GOOD)
    expect(c.reason).toContain('exposure=UNMEASURED')
    expect(c.reason).not.toContain('0.00 USDC')
  })

  it('tarama eksikse maruziyet ALT SINIR olarak etiketlenir', () => {
    const c = classify(stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n }), ALLOW_GOOD, {
      count: 1,
      totalQuoteWei: 1n,
      complete: false,
    })
    expect(c.reason).toContain('LOWER BOUND')
  })

  // ---- BU SUITE'IN EN ONEMLI TESTI ----
  //
  // Saldirinin en keskin hali: HENUZ HICBIR LAUNCH TAMAMLANMAMISKEN oner.
  // Bosaltilacak bir sey yoktur, dolayisiyla itiraz eden de olmaz. Bu
  // izleyicinin bunu ZARARSIZ SAYMAMASI gerekir; tam tersine tehlikeli olan
  // odur. Somut kod ifadesi: `classify` seviyeyi belirlerken `exposure`a
  // BAKMAZ.
  it('BOS KUMEYE karsi yapilan oneri de tam olarak ayni sekilde sayfa cikarir', () => {
    const empty = classify(
      stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n }),
      ALLOW_GOOD,
      {
        count: 0,
        totalQuoteWei: 0n,
        complete: true,
      },
    )
    const loaded = classify(
      stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n }),
      ALLOW_GOOD,
      {
        count: 9,
        totalQuoteWei: 10n ** 21n,
        complete: true,
      },
    )
    expect(empty.level).toBe('page')
    expect(empty.severity).toBe(loaded.severity)
    expect(empty.findings).toEqual(loaded.findings)
    expect(empty.reason).toContain('0 completed-but-ungraduated curve(s)')
  })

  // ALARM YOLU "HER ZAMAN ACIK" DEGIL. Tek degisken izin listesidir; her sey
  // sabit tutulup yalnizca o degistirildiginde sayfa GORUNUR ve KAYBOLUR.
  it('karar izin listesine BAGLIDIR: ayni durum, iki liste, iki farkli sonuc', () => {
    const state = stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n })
    expect(classify(state, ALLOW_GOOD).level).toBe('page')
    expect(
      classify(state, {
        graduationTargets: [EVIL_TARGET],
        treasuries: [TREASURY],
        governor: addr('601'),
      }).level,
    ).toBe('ok')
  })

  it('checksum farki bir eslesmeyi kacirmaz', () => {
    const state = stateOf({ pendingTarget: GOOD_TARGET, pendingEta: NOW + 1n })
    const lowercased = {
      graduationTargets: [GOOD_TARGET.toLowerCase() as Address],
      treasuries: [TREASURY],
      governor: addr('601'),
    }
    expect(classify(state, lowercased).level).toBe('ok')
    expect(classify(state, lowercased).findings).toEqual(['pending-target-allowlisted'])
  })
})

// ---------------------------------------------------------------
// 4. Curve kumesi -- loglar, imlec, ve KISA LISTE YERINE FIRLATMA
// ---------------------------------------------------------------

describe('knownCurves', () => {
  const scratch: string[] = []
  afterEach(() => {
    while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true })
  })
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-keeper-'))
    scratch.push(dir)
    return dir
  }

  it('Launched loglarindan curve adreslerini toplar', async () => {
    const client = syntheticChain({
      blockNumber: 30n,
      launched: [
        { block: 3n, curve: CURVE_A },
        { block: 11n, curve: CURVE_B },
      ],
    })
    await expect(knownCurves(client, FACTORY, 1n)).resolves.toEqual([CURVE_A, CURVE_B].sort())
    expect(client.logQueries.every((q) => q.event.startsWith('Launched+'))).toBe(true)
  })

  it('araligi sayfalar ve son blogu KAPSAR', async () => {
    const client = syntheticChain({ blockNumber: 25n, launched: [{ block: 25n, curve: CURVE_C }] })
    const found = await knownCurves(client, FACTORY, 1n, { chunk: 10n })
    expect(client.logQueries.map((q) => [q.fromBlock, q.toBlock])).toEqual([
      [1n, 10n],
      [11n, 20n],
      [21n, 25n],
    ])
    expect(found).toEqual([CURVE_C])
  })

  // -------------------------------------------------------------
  // KALICI ARALIK HATASI: BEKLEMEK COZMEZ, KUCULMEK COZER
  // -------------------------------------------------------------
  //
  // Round 7 GECICI hatayi (hiz siniri) cozdu: basarili on ek kaydedilir, bir
  // sonraki poll oradan devam eder, tarama YAKINSAR. Ayni care KALICI hatada
  // ise yaramaz -- ayni parca her poll ayni sekilde duser, imlec o parcanin
  // onune GECEMEZ, ve olculen sonuc aynidir: sayfa var, KALP ATISI YOK,
  // tatbikat "there was no watcher" der. Yani izleyici, calisiyorken, YOK
  // SAYILIR.

  it('saglayicinin araligi bizimkinden DARSA tarama yine YAKINSAR', async () => {
    const client = syntheticChain({
      blockNumber: 40n,
      rangeLimit: 10n,
      launched: [
        { block: 5n, curve: CURVE_A },
        { block: 37n, curve: CURVE_C },
      ],
    })
    // Bizim istedigimiz 40 blokluk parca saglayicinin 10'luk sinirini asar.
    // `scanFactoryLogs` KUCUK HARFE gore siralar; `.sort()` degil.
    await expect(knownCurves(client, FACTORY, 1n, { chunk: 40n })).resolves.toEqual([
      CURVE_A,
      CURVE_C,
    ])
    const ok = client.logQueries.filter((q) => q.toBlock - q.fromBlock + 1n <= 10n)
    // ARALIK BOSLUKSUZ TARANIR: basarili parcalar 1..40'i tam kapsar.
    expect(ok[0]?.fromBlock).toBe(1n)
    expect(ok[ok.length - 1]?.toBlock).toBe(40n)
    for (let i = 1; i < ok.length; i += 1) {
      expect(ok[i]?.fromBlock).toBe((ok[i - 1]?.toBlock as bigint) + 1n)
    }
  })

  it('kuculen aralik SADECE KUCULUR, cagri boyunca yeniden buyumez', async () => {
    const client = syntheticChain({ blockNumber: 200n, rangeLimit: 25n })
    await knownCurves(client, FACTORY, 1n, { chunk: 100n })
    const spans = client.logQueries.map((q) => q.toBlock - q.fromBlock + 1n)
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i] as bigint).toBeLessThanOrEqual(spans[i - 1] as bigint)
    }
  })

  // KUCULTME BIR MASKE DEGILDIR. Aralikla ILGISI OLMAYAN bir hata TEK
  // denemede yukari cikar; yoksa duzeltme, `runWatcher`in sayfaya cevirmesi
  // gereken her arizayi geciktiren genel bir "her seyi yeniden dene"ye
  // donerdi.
  it('aralik DISI bir hata KUCULTULMEZ: tek deneme, sonra firlatir', async () => {
    const client = syntheticChain({
      blockNumber: 200n,
      failLogs: true,
      failLogsMessage: 'execution reverted: node is unhappy',
    })
    await expect(knownCurves(client, FACTORY, 1n, { chunk: 100n })).rejects.toThrow(LogScanError)
    expect(client.logQueries.length).toBe(1)
  })

  // Kucultme KENDILIGINDEN SINIRLIDIR, ve bu da bir sessizlik savunmasidir:
  // sinirsiz bir dongu, saglayici hicbir genislige cevap veremiyorsa poll'u
  // SONSUZA KADAR surdururdu, ve TAKILMIS bir poll dusen bir poll'dan daha
  // sessizdir. Her adim ikiye boler ve 1'de durur:
  //   1000, 500, 250, 125, 62, 31, 15, 7, 3, 1  = 10 deneme, sonra sayfa.
  it('hicbir genislik tutmuyorsa SINIRLI denemeden sonra sayfaya cikar', async () => {
    const client = syntheticChain({ blockNumber: 5_000n, rangeLimit: 0n })
    await expect(knownCurves(client, FACTORY, 1n, { chunk: 1_000n })).rejects.toThrow(LogScanError)
    expect(client.logQueries.length).toBe(10)
    expect(client.logQueries[client.logQueries.length - 1]?.toBlock).toBe(1n)
  })

  it('isRangeTooLarge: OLCULEN kodlari tanir, hiz sinirini TANIMAZ', () => {
    for (const code of [-32012, -32614, -32602]) {
      expect(isRangeTooLarge(Object.assign(new Error('x'), { code }))).toBe(true)
    }
    expect(isRangeTooLarge(new Error('requested range too large'))).toBe(true)
    expect(isRangeTooLarge(new Error('query returned more than 10000 results'))).toBe(true)
    // Arc'in CANLI olculen hiz siniri mesaji. Aralik sanilirsa, GECICI bir
    // hata yuzunden aralik bosuna kuculur ve teshis bulanir.
    expect(isRangeTooLarge(new Error('Request exceeds defined limit: rate limit exceeded'))).toBe(
      false,
    )
    expect(
      isRangeTooLarge(Object.assign(new Error('request limit reached'), { code: -32011 })),
    ).toBe(false)
  })

  // ASIL IDDIA, `runWatcher` SEVIYESINDE: dar aralikli bir saglayicida
  // izleyici KALP ATISI YAYAR. Kalp atisi tatbikatin "izleyici vardi"
  // olcusudur; onsuz dogru sayfalar bile "there was no watcher" okunur.
  it('dar aralikli saglayicida runWatcher KALP ATISI YAYAR', async () => {
    const { sink, run } = watch({ blockNumber: 400n, rangeLimit: 20n })
    await run()
    expect(sink.beats()).toBe(1)
    expect(sink.pages()).toEqual([])
  })

  // MARUZIYETI EKSIK BILDIREN BIR SAYFA HIC SAYFA CIKARMAMAKTAN KOTUDUR.
  it('bir RPC aralik hatasinda KISA LISTE DONMEZ, firlatir', async () => {
    const client = syntheticChain({ blockNumber: 30n, failLogs: true })
    await expect(knownCurves(client, FACTORY, 1n)).rejects.toBeInstanceOf(LogScanError)
  })

  it('ILK parca duserse imlec YAZILMAZ -- yazilacak ilerleme yoktur', async () => {
    const path = join(tempDir(), '.cursor')
    const store = cursorAt(path)
    const client = syntheticChain({ blockNumber: 30n, failLogs: true })
    await expect(knownCurves(client, FACTORY, 1n, { store })).rejects.toBeInstanceOf(LogScanError)
    expect(store.read()).toBeNull()
  })

  /**
   * BASARILI ON EK KAYDEDILIR, ve bunun olculmus bir sebebi vardir.
   *
   * Onceki hal hicbir sey yazmiyordu, dolayisiyla parca 15'te dusen bir tarama
   * bir sonraki poll'da PARCA 1'DEN basliyordu. Canli Arc'ta (67 parcalik
   * soguk tarama, hiz siniri 15. parcada geri cekilme butcesini tuketiyor) bu
   * demek ki tarama HICBIR ZAMAN tamamlanmaz: kalp atisi HIC yayilmaz, ve
   * haftalik tatbikat calisan bir izleyici icin "there was no watcher" der.
   * Faz 2 redeploy'u tam olarak bu durumu uretir (yeni factory = soguk imlec).
   *
   * TARANMAMIS BLOK "TARANDI" DIYE KAYDEDILMEZ: kaydedilen deger DUSEN
   * parcanin bir ONCESIDIR, ve bu test onu blok blok pinler.
   */
  it('ORTADA duserse BASARILI ON EK kaydedilir ve bir sonraki kosum ORADAN devam eder', async () => {
    const path = join(tempDir(), '.cursor')
    const store = cursorAt(path)
    // [1,10] ve [11,20] gecer, [21,30] duser.
    const client = syntheticChain({
      blockNumber: 30n,
      launched: [{ block: 4n, curve: CURVE_A }],
      failLogsFrom: 21n,
    })
    await expect(knownCurves(client, FACTORY, 1n, { store, chunk: 10n })).rejects.toBeInstanceOf(
      LogScanError,
    )

    const saved = store.read()
    expect(saved?.lastScannedBlock).toBe(20n)
    expect(saved?.curves).toEqual([CURVE_A])

    // Bir sonraki kosum 21'DEN devam eder, 1'den DEGIL.
    const next = syntheticChain({ blockNumber: 30n, launched: [{ block: 25n, curve: CURVE_B }] })
    const found = await knownCurves(next, FACTORY, 1n, { store, chunk: 10n })
    expect(next.logQueries[0]?.fromBlock).toBe(21n)
    expect(found).toEqual([CURVE_A, CURVE_B].sort())
  })

  it('imleci diske yazar ve yeniden baslatma genesis"ten taramaz', async () => {
    const path = join(tempDir(), '.cursor')
    const store = cursorAt(path)

    const first = syntheticChain({ blockNumber: 20n, launched: [{ block: 4n, curve: CURVE_A }] })
    await knownCurves(first, FACTORY, 1n, { store, chunk: 100n })
    expect(store.read()).toEqual({
      lastScannedBlock: 20n,
      curves: [CURVE_A],
      history: { proposedTargets: [], landedTargets: [], treasuries: [] },
    })

    const second = syntheticChain({ blockNumber: 40n, launched: [{ block: 33n, curve: CURVE_B }] })
    const found = await knownCurves(second, FACTORY, 1n, { store, chunk: 100n })
    expect(second.logQueries).toEqual([
      {
        event: 'Launched+GraduationTargetProposed+GraduationTargetChanged+ProtocolTreasuryChanged',
        fromBlock: 21n,
        toBlock: 40n,
      },
    ])
    expect(found).toEqual([CURVE_A, CURVE_B].sort())
  })

  it('imlec basligin ILERISINDEYSE durur -- reorg ya da yanlis zincir', async () => {
    const path = join(tempDir(), '.cursor')
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        chainId: CHAIN_ID,
        factory: FACTORY,
        startBlock: '1',
        lastScannedBlock: '9999',
        curves: [],
        history: { proposedTargets: [], landedTargets: [], treasuries: [] },
      }),
      'utf8',
    )
    const client = syntheticChain({ blockNumber: 20n })
    await expect(knownCurves(client, FACTORY, 1n, { store: cursorAt(path) })).rejects.toThrow(
      /ahead of the chain head/,
    )
  })

  it('imlec dosyasi tanimsizsa TAHMIN ETMEZ', () => {
    const path = join(tempDir(), '.cursor')
    writeFileSync(path, JSON.stringify({ nonsense: true }), 'utf8')
    expect(() => cursorAt(path).read()).toThrow(/not a keeper cursor/)
  })

  // -------------------------------------------------------------
  // IMLEC KIMLIGI -- FAZ 2 REDEPLOY'UNA HAZIRLIK
  //
  // Faz 2 `LaunchFactory`ye bir `feeSchedule` yapici argumani ekliyor, yani
  // adres degisiyor. Keeper adresi DEFTERDEN alir ve bunun icin kod
  // degisikligi GEREKMEZ -- ama imlec dosyasinin YOLU degismez. Bu blok, o
  // dosyanin ESKI factory'ye ait icerigini yeni factory'ye tasimadigini pinler.
  // -------------------------------------------------------------

  it('BASKA bir factory icin yazilmis imlec YOK SAYILIR, ve sebep loglanir', async () => {
    const path = join(tempDir(), '.cursor')

    // Eski factory: 100'e kadar tarandi, bir curve bulundu.
    const old = cursorAt(path, { factory: FACTORY })
    await knownCurves(
      syntheticChain({ blockNumber: 100n, launched: [{ block: 5n, curve: CURVE_A }] }),
      FACTORY,
      1n,
      { store: old, chunk: 1_000n },
    )
    expect(old.read()?.curves).toEqual([CURVE_A])

    // Yeni factory, AYNI dosya yolu.
    const reasons: string[] = []
    const fresh = cursorAt(path, { factory: FACTORY_2 }, (reason) => reasons.push(reason))
    expect(fresh.read()).toBeNull()
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(FACTORY)
    expect(reasons[0]).toContain(FACTORY_2)
  })

  it('KIMLIKSIZ (v2) imlec de yok sayilir -- hangi factory"ye ait oldugu BILINEMEZ', () => {
    const path = join(tempDir(), '.cursor')
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        lastScannedBlock: '54701659',
        curves: [CURVE_A],
        history: { proposedTargets: [], landedTargets: [], treasuries: [] },
      }),
      'utf8',
    )
    expect(cursorAt(path).read()).toBeNull()
  })

  it('chainId ya da startBlock ayrisirsa da yok sayilir', () => {
    const path = join(tempDir(), '.cursor')
    const store = cursorAt(path)
    store.write({
      lastScannedBlock: 50n,
      curves: [CURVE_A],
      history: { proposedTargets: [], landedTargets: [], treasuries: [] },
    })
    expect(cursorAt(path).read()?.lastScannedBlock).toBe(50n) // AYNI kimlik: okunur
    expect(cursorAt(path, { chainId: 31337 }).read()).toBeNull()
    expect(cursorAt(path, { startBlock: 2n }).read()).toBeNull()
  })

  /**
   * KIMLIK KONTROLUNUN ASIL ODEDIGI SEY BU, ve `launchCount` orakli onu
   * GORMEZ: eski imlec YENI factory'nin `startBlock`indan ILERIDEYSE,
   * `from = lastScannedBlock + 1` aradaki bloklari ATLAR. `from < startBlock`
   * duzeltmesi yalnizca YUKARI ceker. Atlanan aralikta `Launched` yoksa
   * sayilar tutar ve hicbir sey atesler etmez -- ama uc governance olayi
   * SESSIZCE kaybolur.
   */
  it('eski imlec YENI factory"nin bloklarini ATLAMAZ', async () => {
    const path = join(tempDir(), '.cursor')
    const old = cursorAt(path, { factory: FACTORY, startBlock: 1n })
    await knownCurves(syntheticChain({ blockNumber: 900n }), FACTORY, 1n, {
      store: old,
      chunk: 10_000n,
    })
    expect(old.read()?.lastScannedBlock).toBe(900n)

    // Yeni factory 500. bloktan itibaren izleniyor; 500..900 arasinda bir
    // GraduationTargetChanged var ve kimlik kontrolu olmasa TARANMAZDI.
    const store = cursorAt(path, { factory: FACTORY_2, startBlock: 500n })
    const client = syntheticChain({
      blockNumber: 1_000n,
      governanceLogs: [
        {
          block: 600n,
          eventName: 'GraduationTargetChanged',
          args: { previous: ZERO_ADDRESS, current: EVIL_TARGET },
        },
      ],
    })
    const scan = await scanFactoryLogs(client, FACTORY_2, 500n, { store, chunk: 10_000n })
    expect(client.logQueries[0]?.fromBlock).toBe(500n)
    expect(scan.history.landedTargets).toEqual([EVIL_TARGET])
  })
})

// ---------------------------------------------------------------
// 5. Maruziyet
// ---------------------------------------------------------------

describe('exposure', () => {
  const complete = (wei: bigint): CurveFixture => ({
    complete: true,
    graduated: false,
    realQuoteReserves: wei,
  })

  it('sifir curve: sifir, ve bu bir HATA DEGIL bir olcumdur', async () => {
    const client = syntheticChain({})
    await expect(exposure(client, [], 1n)).resolves.toEqual({ count: 0, totalQuoteWei: 0n })
  })

  it('yalnizca tamamlanmis VE mezun edilmemis curve"leri sayar', async () => {
    const client = syntheticChain({
      curves: curveSet([
        [CURVE_A, complete(10n ** 19n)],
        [CURVE_B, { complete: false, graduated: false, realQuoteReserves: 5n * 10n ** 18n }],
        [CURVE_C, { complete: true, graduated: true, realQuoteReserves: 7n * 10n ** 18n }],
      ]),
    })
    await expect(exposure(client, [CURVE_A, CURVE_B, CURVE_C], 1n)).resolves.toEqual({
      count: 1,
      totalQuoteWei: 10n ** 19n,
    })
  })

  it('uc tamamlanmis curve: toplam DOGRU', async () => {
    const client = syntheticChain({
      curves: curveSet([
        [CURVE_A, complete(12_160_000_000_000_000_000n)],
        [CURVE_B, complete(12_160_000_000_000_000_000n)],
        [CURVE_C, complete(12_160_000_000_000_000_000n)],
      ]),
    })
    await expect(exposure(client, [CURVE_A, CURVE_B, CURVE_C], 1n)).resolves.toEqual({
      count: 3,
      totalQuoteWei: 36_480_000_000_000_000_000n,
    })
  })

  it('bir curve okunamiyorsa SIFIR SAYIP GECMEZ, firlatir', async () => {
    const client = syntheticChain({ failCurveReads: true })
    await expect(exposure(client, [CURVE_A], 1n)).rejects.toThrow(/timed out/)
  })
})

// ---------------------------------------------------------------
// 6. runWatcher -- SESSIZLIK once, sonra gurultu
// ---------------------------------------------------------------

describe('runWatcher: SESSIZLIK ISPATI', () => {
  // "Bir alarmin ateslendigini iddia eden test, izleyicinin SESSIZ
  // KALABILDIGINI de ispatlamadikca hicbir sey ispatlamaz."

  it('bekleyen oneri yok: HICBIR alarm yok, yalnizca kalp atisi', async () => {
    const { sink, run } = watch({})
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.oks()).toEqual([])
    expect(sink.beats()).toBe(1)
  })

  it('on ardisik saglikli poll: sifir alarm, on kalp atisi', async () => {
    const client = syntheticChain({
      blockNumber: 50n,
      launched: [{ block: 4n, curve: CURVE_A }],
      curves: curveSet([[CURVE_A, { complete: false, graduated: false, realQuoteReserves: 0n }]]),
    })
    const sink = recorder()
    for (let i = 0; i < 10; i += 1) {
      await runWatcher({
        client,
        factory: PINNED,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        nowMs: localClock(NOW),
      })
    }
    expect(sink.pages()).toEqual([])
    expect(sink.oks()).toEqual([])
    expect(sink.beats()).toBe(10)
  })

  // ZATEN INMIS ONERI: `applyGraduationTarget` bekleyeni sifirlar. Izin
  // listesindeki bir hedefe inmisse soylenecek bir sey yoktur.
  it('izin listesindeki bir hedefe INMIS oneri: sessiz', async () => {
    const { sink, run } = watch({ pendingTarget: ZERO_ADDRESS, currentTarget: GOOD_TARGET })
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.oks()).toEqual([])
    expect(sink.beats()).toBe(1)
  })

  it('suresi gecmis dusman oneri: SAYFA YOK, kayit VAR, kalp atisi VAR', async () => {
    const { sink, run } = watch({ pendingTarget: EVIL_TARGET, pendingEta: NOW - DELAY - 1n })
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.oks().length).toBe(1)
    expect(sink.beats()).toBe(1)
  })
})

describe('runWatcher: GURULTU', () => {
  it('HICBIR CURVE TAMAMLANMAMISKEN yapilan dusman oneri: sayfa, ve maruziyet 0 yazar', async () => {
    const { sink, run } = watch({
      blockNumber: 50n,
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      launched: [],
    })
    await run()
    expect(sink.pages().length).toBe(1)
    const page = sink.pages()[0] as string
    expect(page).toContain(EVIL_TARGET)
    expect(page).toContain('0 completed-but-ungraduated curve(s), 0.00 USDC')
    expect(page).toContain(`opensAt=${NOW + 100n}`)
    expect(page).toContain(`expiresAt=${NOW + 100n + DELAY}`)
    expect(sink.beats()).toBe(1)
  })

  it('uc tamamlanmis curve varken dusman oneri: sayfa RAKAMI TASIR', async () => {
    const { sink, run } = watch({
      blockNumber: 50n,
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      launched: [
        { block: 4n, curve: CURVE_A },
        { block: 5n, curve: CURVE_B },
        { block: 6n, curve: CURVE_C },
      ],
      curves: curveSet([
        [
          CURVE_A,
          { complete: true, graduated: false, realQuoteReserves: 12_160_000_000_000_000_000n },
        ],
        [
          CURVE_B,
          { complete: true, graduated: false, realQuoteReserves: 12_160_000_000_000_000_000n },
        ],
        [
          CURVE_C,
          { complete: true, graduated: false, realQuoteReserves: 12_160_000_000_000_000_000n },
        ],
      ]),
    })
    await run()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain('3 completed-but-ungraduated curve(s), 36.48 USDC')
  })

  // SLOT YOLU DEKORATIF DEGIL: loglar TAMAMEN sussa bile pencere yine
  // siniflandirilir. Sayfa iki tanedir -- biri log yolunun coktugunu, digeri
  // penceredeki tehdidi soyler -- ve ikincisinin varligi bu testin butun
  // meselesidir.
  it('loglar tamamen dustu, slotlar dolu: PENCERE YINE SINIFLANDIRILIR', async () => {
    const { sink, run } = watch({
      blockNumber: 50n,
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      failLogs: true,
      launchCount: 2n,
    })
    await run()
    const pages = sink.pages()
    expect(pages.some((p) => p.includes('log-scan-failed'))).toBe(true)
    expect(pages.some((p) => p.includes(EVIL_TARGET) && p.includes('NOT on the allowlist'))).toBe(
      true,
    )
    expect(pages.some((p) => p.includes('exposure=UNMEASURED'))).toBe(true)
    expect(sink.beats()).toBe(0)
  })

  it('hedef DEGISTI: en yuksek siddet ve pencerenin bittigini soyleyen sayfa', async () => {
    const { sink, run } = watch({ currentTarget: EVIL_TARGET })
    await run()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain('DRAIN WINDOW IS OVER')
  })

  it('hazine degisti: sayfa, ve gecikme olmadigi mesajda', async () => {
    const { sink, run } = watch({ protocolTreasury: EVIL_TREASURY })
    await run()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain('NO DELAY')
  })

  it('slot okumasi coktu: sayfa, kalp atisi YOK', async () => {
    const { sink, run } = watch({ failReads: true })
    await run()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain('watcher-state-read-failed')
    expect(sink.beats()).toBe(0)
  })

  it('curve okumasi coktu: sayfa, kalp atisi YOK, maruziyet UNMEASURED', async () => {
    const { sink, run } = watch({
      blockNumber: 50n,
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      launched: [{ block: 4n, curve: CURVE_A }],
      failCurveReads: true,
    })
    await run()
    expect(sink.pages().some((p) => p.includes('exposure-read-failed'))).toBe(true)
    expect(sink.pages().some((p) => p.includes('exposure=UNMEASURED'))).toBe(true)
    expect(sink.beats()).toBe(0)
  })
})

// ---------------------------------------------------------------
// 7. IZLEYICIYI BILEREK KIRMAK
// ---------------------------------------------------------------

describe('kirilma 1: log abonesi dustu (loglar SESSIZCE bos donuyor)', () => {
  // Bu, log yolunun EN SINSI arizasidir: hata yok, bos liste var. "Hic launch
  // olmamis" ile ayirt edilemez -- ancak SLOT olmadan. `launchCount` her
  // `launch()`ta bir artar ve her `launch()` tam olarak bir `Launched` yayar,
  // yani slot log sayisinin TAM bir kehanetidir. Gorev tanimindaki "hem
  // slotlar hem loglar" kararinin calistirilabilir karsiligi budur.
  it('slot log sayisiyla celisiyorsa sayfa cikar ve kalp atisi kesilir', async () => {
    const { sink, run } = watch({ blockNumber: 50n, dropLogs: true, launchCount: 3n })
    await run()
    const page = sink.pages().find((p) => p.includes('log-scan-incomplete'))
    expect(page).toBeDefined()
    expect(page).toContain('returned 0 curve(s)')
    expect(page).toContain('launchCount slot says 3')
    expect(sink.beats()).toBe(0)
  })

  it('ayni durum ama slot da 0: SAYFA YOK -- tespit "her zaman acik" degil', async () => {
    const { sink, run } = watch({ blockNumber: 50n, dropLogs: true, launchCount: 0n })
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.beats()).toBe(1)
  })

  it('eksik tarama sirasinda cikan pencere sayfasi maruziyeti ALT SINIR isaretler', async () => {
    const { sink, run } = watch({
      blockNumber: 50n,
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      dropLogs: true,
      launchCount: 3n,
    })
    await run()
    expect(sink.pages().some((p) => p.includes('LOWER BOUND'))).toBe(true)
  })
})

describe('kirilma 2: izleyici poll etmeyi birakti', () => {
  const POLL = 5_000

  it('kanarya DOGUSTAN kurulu: hic basarili poll yapmadan iki aralik gecerse sayfa', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    expect(liveness.check(NOW_MS + POLL)).toEqual([])
    const findings = liveness.check(NOW_MS + 2 * POLL)
    expect(findings.map((f) => f.code)).toEqual(['watcher-heartbeat-missed', 'chain-head-stale'])
  })

  it('poll ediliyorken sessiz, DURDUGUNDA iki aralik sonra sayfa', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    for (let t = 0; t <= 60_000; t += POLL) {
      liveness.observeHead(BigInt(t / POLL), NOW_MS + t)
      liveness.observeChainTime(NOW + BigInt(t / 1000), NOW_MS + t)
      liveness.pollSucceeded(NOW_MS + t)
      expect(liveness.check(NOW_MS + t), `t=${t}`).toEqual([])
    }
    // Burada durur.
    expect(liveness.check(NOW_MS + 60_000 + POLL)).toEqual([])
    const findings = liveness.check(NOW_MS + 60_000 + 2 * POLL)
    expect(findings.map((f) => f.code)).toEqual(['watcher-heartbeat-missed', 'chain-head-stale'])
    expect(findings[0]?.message).toContain('the watcher is not watching')
  })

  it('yarim poll kalp atisi vermez, yani kanarya onu da yakalar', async () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    const client = syntheticChain({ blockNumber: 50n, failLogs: true })
    const sink = recorder()
    for (let t = NOW_MS; t <= NOW_MS + 3 * POLL; t += POLL) {
      await runWatcher({
        client,
        factory: PINNED,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        liveness,
        nowMs: () => t,
      })
    }
    expect(sink.beats()).toBe(0)
    expect(liveness.check(NOW_MS + 3 * POLL).map((f) => f.code)).toContain(
      'watcher-heartbeat-missed',
    )
  })
})

describe('kirilma 3: RPC bayat blok besliyor', () => {
  const POLL = 5_000

  it('ayni blok numarasi tekrar tekrar gorulurse sayac SIFIRLANMAZ', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    for (let t = 0; t <= 2 * POLL; t += POLL) {
      liveness.observeHead(777n, NOW_MS + t)
      liveness.observeChainTime(NOW + BigInt(t / 1000), NOW_MS + t)
      liveness.pollSucceeded(NOW_MS + t)
    }
    const findings = liveness.check(NOW_MS + 2 * POLL)
    expect(findings.map((f) => f.code)).toEqual(['chain-head-stale'])
    expect(findings[0]?.message).toContain('block 777')
    // Kalp atisi SAGLAM -- yani bu ariza SADECE bayat-blok dedektoruyle
    // gorunur. Ikisini ayri tutmanin sebebi tam olarak budur.
    expect(findings.some((f) => f.code === 'watcher-heartbeat-missed')).toBe(false)
  })

  it('blok ilerledigi surece sessiz', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    for (let t = 0; t <= 10 * POLL; t += POLL) {
      liveness.observeHead(BigInt(t / POLL), NOW_MS + t)
      liveness.observeChainTime(NOW + BigInt(t / 1000), NOW_MS + t)
      liveness.pollSucceeded(NOW_MS + t)
      expect(liveness.check(NOW_MS + t), `t=${t}`).toEqual([])
    }
  })

  it('bayat blok gercek bir poll dongusunde yakalanir: pencere saati donar', async () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    // Blok ve zaman damgasi sabit -- RPC dondurulmus bir goruntu servis ediyor.
    const client = syntheticChain({ blockNumber: 900n, timestamp: NOW })
    const sink = recorder()
    for (let t = NOW_MS; t <= NOW_MS + 2 * POLL; t += POLL) {
      await runWatcher({
        client,
        factory: PINNED,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        liveness,
        nowMs: () => t,
      })
    }
    // Zincir yolu "saglikli" gorunur: sayfa yok, her poll kalp atisi verdi.
    expect(sink.pages()).toEqual([])
    expect(sink.beats()).toBe(3)
    // Kanarya yine de yakalar.  HENUZ CIKMAZ: butcesi
    // bilerek genistir (10 aralik), cunku Arc'ta zaman damgasinin artmamasi
    // NORMALDIR. Iki dedektor ayni arizaya FARKLI hizlarda tepki verir.
    expect(liveness.check(NOW_MS + 2 * POLL).map((f) => f.code)).toEqual(['chain-head-stale'])
  })
})

// ---------------------------------------------------------------
// 8. Izin listesi yukleyicisi
// ---------------------------------------------------------------

describe('parseGovernanceAllowlist', () => {
  it('doldurulmus bir kaydi okur', () => {
    const parsed = parseGovernanceAllowlist(
      {
        'arc-testnet': {
          governor: addr('601'),
          treasury: TREASURY,
          owners: [],
          allowedGraduationTargets: [GOOD_TARGET],
        },
      },
      'arc-testnet',
    )
    expect(parsed).toEqual({
      graduationTargets: [GOOD_TARGET],
      treasuries: [TREASURY],
      governor: addr('601'),
    })
  })

  // Faz 1d'de hicbir hedef atanmamistir. BOS LISTE "kontrol yok" degil,
  // "hicbir sey mesru degil" demektir.
  it('allowedGraduationTargets BOS olabilir ve bu Faz 1d"nin dogru halidir', () => {
    const parsed = parseGovernanceAllowlist(
      {
        k: { governor: addr('601'), treasury: TREASURY, owners: [], allowedGraduationTargets: [] },
      },
      'k',
    )
    expect(parsed.graduationTargets).toEqual([])
    expect(
      classify(stateOf({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n }), parsed).level,
    ).toBe('page')
  })

  // DOLDURULMAMIS DOSYAYLA BASLAMAK, bes saniyede bir sayfa demektir; rota bir
  // gun icinde susturmayi ogrenir ve kontrol -- "calisiyor" gorunurken --
  // sifira duser. Hata ACILISTA, bir kez, yuksek sesle.
  it('hazine sifirsa BASLAMAYI REDDEDER', () => {
    expect(() =>
      parseGovernanceAllowlist(
        {
          k: {
            governor: addr('601'),
            treasury: ZERO_ADDRESS,
            owners: [],
            allowedGraduationTargets: [],
          },
        },
        'k',
      ),
    ).toThrow(/treasury is the zero address/)
  })

  it('governor sifirsa reddeder', () => {
    expect(() =>
      parseGovernanceAllowlist(
        {
          k: {
            governor: ZERO_ADDRESS,
            treasury: TREASURY,
            owners: [],
            allowedGraduationTargets: [],
          },
        },
        'k',
      ),
    ).toThrow(/governor is the zero address/)
  })

  it('izin listesine SIFIR hedef konmasini reddeder', () => {
    expect(() =>
      parseGovernanceAllowlist(
        {
          k: {
            governor: addr('601'),
            treasury: TREASURY,
            owners: [],
            allowedGraduationTargets: [ZERO_ADDRESS],
          },
        },
        'k',
      ),
    ).toThrow(/ZeroGraduationTarget/)
  })

  it('bilinmeyen chainKey icin bilinen anahtarlari sayarak firlatir', () => {
    expect(() => parseGovernanceAllowlist({ a: {}, b: {} }, 'c')).toThrow(/known keys: a, b/)
  })

  it('depodaki gercek expected-governance.json"in local-rehearsal kaydi yuklenir', () => {
    const path = new URL('../../contracts/deploy/expected-governance.json', import.meta.url)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const parsed = parseGovernanceAllowlist(raw, 'local-rehearsal')
    expect(parsed.graduationTargets).toEqual([])
    expect(parsed.treasuries.length).toBe(1)

    // HER KAYIT ICIN DEGISMEZ: ya SIFIR OLMAYAN governance ile yuklenir, ya da
    // sifir adresi ADIYLA soyleyerek REDDEDER. Bunun onceki hali "arc-testnet
    // henuz sifirdir" diye BUGUNKU degere pinliydi ve baska bir ajan Safe'leri
    // doldurdugu anda kirildi -- fixture'a pinlenmis bir test, degismezi degil
    // takvimi olcer.
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      let entry: ReturnType<typeof parseGovernanceAllowlist> | undefined
      try {
        entry = parseGovernanceAllowlist(raw, key)
      } catch (error) {
        expect(String(error), `${key} must name the zero address if it refuses`).toMatch(
          /zero address/,
        )
        continue
      }
      expect(entry.governor, key).not.toBe(ZERO_ADDRESS)
      expect(entry.treasuries[0], key).not.toBe(ZERO_ADDRESS)
    }
  })
})

// ---------------------------------------------------------------
// 9. Tatbikat
// ---------------------------------------------------------------

describe('drill: observe', () => {
  const noSleep = (): Promise<void> => Promise.resolve()

  // BU YARDIMCILAR ARTIK SAHTE DEGIL. Onceki halleri `fileAlertSink`in
  // GOVDESINI yeniden yaziyordu -- ayni regex, ayni `Date.parse`, ayni pencere
  // karsilastirmasi -- yani onlari kullanan her test, test ettigi kodu
  // ATLIYORDU. M23 mutanti (pencereyi kaldir) tam olarak bu yuzden SAG KALDI:
  // suzgec testin kendi kopyasinda duruyordu.
  //
  // Simdi ikisi de satirlari GERCEK BICIMDE gecici bir dosyaya yazar ve
  // GERCEK `fileAlertSink`i dondurur. Yani "en yakin yardimciya uzanmak"
  // artik bos bir yesil uretemez: yardimcinin kendisi gercek yolu kosar.
  const scratch: string[] = []
  afterEach(() => {
    while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true })
  })
  let seq = 0
  const sinkOf = (lines: string[]): AlertSinkQuery => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-sinkof-'))
    scratch.push(dir)
    const path = join(dir, `alerts-${(seq += 1)}.log`)
    writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
    return fileAlertSink(path)
  }
  const stamp = (atMs: number): string => new Date(atMs).toISOString()
  const beatLine = (atMs = 1_000): string => `HEARTBEAT keeper.graduationWindow at=${stamp(atMs)}`
  const pageLine = (target: Address, atMs = 1_000): string =>
    `PAGE keeper.graduationWindow at=${stamp(atMs)} pendingGraduationTarget is ${target} ...`
  const fakeSink = (lines: string[]): AlertSinkQuery => sinkOf(lines)
  const linesSink = (raw: string[]): AlertSinkQuery => sinkOf(raw)

  it('lavaboda hedefi anan bir sayfa varsa gecer', async () => {
    const sink = fakeSink([beatLine(), pageLine(EVIL_TARGET)])
    const outcome = await drillObserve({
      sinceMs: 0,
      sink,
      target: EVIL_TARGET,
      waitMs: 0,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('attempt 1/3')
  })

  // ALARM BORUSU SESSIZSE TATBIKAT DUSER. Bu, tatbikatin var olma sebebidir:
  // izleyici "sayfa cikardim" dese bile lavaboya bir sey varmadiysa kontrol
  // yoktur.
  it('lavabo bossa duser', async () => {
    const sink = fakeSink([])
    const outcome = await drillObserve({
      sinceMs: 0,
      sink,
      target: EVIL_TARGET,
      waitMs: 0,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(false)
    // Bos lavabo "alarm basarisiz" DEGIL "izleyici kosmuyordu" demektir; iki
    // ariza farkli runbook dallarina gider.
    expect(outcome.detail).toContain('NO HEARTBEAT')
    expect(outcome.detail).toContain('there was no watcher')
  })

  // KAPI, IZLEDIGI SEYIN OLUMUNDEN SAG CIKMAMALI. Eski bir sayfa dosyada
  // durur, izleyici olmustur (pencerede kalp atisi yok) -> DUSER.
  it('BAYAT bir sayfa, kalp atisi olmadan, tatbikati GECIREMEZ', async () => {
    const monthAgo = Date.parse('2026-06-01T00:00:00.000Z')
    const now = Date.parse('2026-07-01T00:00:00.000Z')
    const outcome = await drillObserve({
      sinceMs: now,
      sink: fakeSink([pageLine(EVIL_TARGET, monthAgo), beatLine(monthAgo)]),
      target: EVIL_TARGET,
      waitMs: 0,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('NO HEARTBEAT')
  })

  // Ve TERSI: ayni bayat sayfa, ama pencere onu KAPSIYORSA gecer. Pencere
  // "her zaman reddet" degil.
  it('ayni sayfa pencere icindeyse gecer', async () => {
    const at = Date.parse('2026-07-01T00:00:00.000Z')
    const outcome = await drillObserve({
      sinceMs: at - 1000,
      sink: fakeSink([pageLine(EVIL_TARGET, at), beatLine(at)]),
      target: EVIL_TARGET,
      waitMs: 0,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('the watcher was alive for it')
  })

  // IZLEYICI YASIYOR AMA ATESLEMEDI: ucuncu, ayri ariza.
  it('kalp atisi VAR ama sayfa YOK: farkli mesaj, yine duser', async () => {
    const outcome = await drillObserve({
      sinceMs: 0,
      sink: fakeSink([beatLine()]),
      target: EVIL_TARGET,
      waitMs: 0,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('The watcher was alive')
    expect(outcome.detail).toContain('did not carry the proposal')
  })

  it('damgasi ayristirilamayan satir SAYILMAZ -- yanlis kirmizi, yanlis yesile yeglenir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-badstamp-'))
    try {
      const path = join(dir, 'alerts.log')
      writeFileSync(
        path,
        `PAGE keeper.graduationWindow at=not-a-date ${EVIL_TARGET}\nHEARTBEAT keeper.graduationWindow at=also-bad\n`,
        'utf8',
      )
      return expect(fileAlertSink(path).readSince(0)).resolves.toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ALAKASIZ bir sayfa tatbikati gecirmez', async () => {
    const sink = fakeSink([
      `PAGE keeper.graduationWindow at=${stamp(1000)} chain-head-stale ...`,
      beatLine(),
    ])
    const outcome = await drillObserve({
      sinceMs: 0,
      sink,
      target: EVIL_TARGET,
      waitMs: 0,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('1 unrelated page(s)')
  })

  it('sayfa gec gelirse sonraki denemede yakalanir', async () => {
    let calls = 0
    // Iki GERCEK lavabo, ve aralarinda gecis. Sayim disinda hicbir sey taklit
    // edilmiyor: her iki dal da `fileAlertSink`i kosar.
    const early = fakeSink([beatLine()])
    const late = fakeSink([beatLine(), pageLine(EVIL_TARGET)])
    const sink: AlertSinkQuery = {
      readSince: (sinceMs) => {
        calls += 1
        return (calls < 3 ? early : late).readSince(sinceMs)
      },
    }
    const outcome = await drillObserve({
      sinceMs: 0,
      sink,
      target: EVIL_TARGET,
      waitMs: 0,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('attempt 3/3')
  })

  // TATBIKAT ILE ALARM YOLU AYNI DIZEYI PAYLASIR. Tatbikat kendi uydurdugu bir
  // bicimi ayristirsaydi, `consoleSink`in bicimini degistiren bir duzenleme
  // tatbikati SESSIZCE hep-gecer haline getirirdi -- ve o an kimse fark etmez.
  // Bu test iki ucu birbirine baglar: dize gercekten `consoleSink`ten cikar.
  it('gercek consoleSink ciktisini ayristirir', async () => {
    const lines: string[] = []
    const original = { log: console.log, error: console.error }
    console.log = (line: string): void => void lines.push(line)
    console.error = (line: string): void => void lines.push(line)
    try {
      // Gercek bir keeper IKISINI DE yayar; tatbikat da ikisini birden ister.
      emitHeartbeat(consoleSink)
      emitAlert(
        'page',
        `pendingGraduationTarget is ${EVIL_TARGET} and is NOT on the allowlist`,
        consoleSink,
      )
    } finally {
      console.log = original.log
      console.error = original.error
    }
    expect(lines.filter((line) => line.startsWith('PAGE ')).length).toBe(1)
    expect(lines.filter((line) => line.startsWith('HEARTBEAT ')).length).toBe(1)
    await expect(
      drillObserve({
        sinceMs: 0,
        sink: linesSink(lines),
        target: EVIL_TARGET,
        waitMs: 0,
        sleep: noSleep,
      }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('drill: expiry', () => {
  it('yalnizca GraduationTargetProposalExpired gecer', async () => {
    await expect(
      drillExpiry({
        simulateApply: () =>
          Promise.resolve({ reverted: true, errorName: 'GraduationTargetProposalExpired' }),
      }),
    ).resolves.toMatchObject({ ok: true })
  })

  // BASKA BIR REVERT KABUL EDILMEZ. Edilseydi tatbikat, ust sinir hic
  // olmasaydi bile gecerdi: `NotGovernor` da bir revert'tir.
  it('baska bir revert DUSER', async () => {
    const outcome = await drillExpiry({
      simulateApply: () =>
        Promise.resolve({ reverted: true, errorName: 'NoPendingGraduationTarget' }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('proves nothing about the window bound')
  })

  it('hic revert etmemesi EN KOTU sonuctur ve duser', async () => {
    const outcome = await drillExpiry({ simulateApply: () => Promise.resolve({ reverted: false }) })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('still armed')
  })
})

// ---------------------------------------------------------------
// 10. ZINCIR SAATINE DUYULAN GUVEN  (inceleme: Important 1)
// ---------------------------------------------------------------
//
// `phase === 'expired'` dusman bir hedef icin TEK sessiz daldir ve ona zincirin
// verdigi IKI dogrulanmamis sayiyla varilir. Bu bolum o iki sayiyi da kirar.

describe('guven: zincir saati ve gecikme', () => {
  it('one kaymis bir zaman damgasi TAZE bir oneriyi expired gostermez -- sayfa cikar', async () => {
    // Blok numarasi NORMAL ilerliyor, zaman damgasi bir yil ileride.
    const { sink, run } = watch({
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW + 100n,
      timestamp: NOW + 31_536_000n,
      nowMs: localClock(NOW),
    })
    await run()
    expect(sink.pages().length).toBe(1)
    const page = sink.pages()[0] as string
    expect(page).toContain('WINDOW INPUTS CANNOT BE TRUSTED')
    expect(page).toContain('ahead of local time')
    expect(page).toContain(EVIL_TARGET)
  })

  // AYNI DURUM, KAYMASIZ SAAT -> SESSIZ. Tespit "her zaman acik" degil.
  it('ayni oneri gercekten suresi gecmisse ve saat duzgunse SAYFA CIKMAZ', async () => {
    const { sink, run } = watch({
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW - DELAY - 1n,
      nowMs: localClock(NOW),
    })
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.oks().length).toBe(1)
  })

  it('geriye kaymis saat de guvenilmezdir', () => {
    const state = stateOf({
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW - DELAY - 1n,
      trust: { trusted: false, reasons: ['chain time is behind local time'] },
    })
    expect(state.phase).toBe('expired')
    const c = classify(state, ALLOW_GOOD)
    expect(c.level).toBe('page')
    expect(c.findings).toContain('window-inputs-untrusted')
    expect(c.findings).toContain('pending-target-not-allowlisted')
    expect(c.findings).not.toContain('pending-target-not-allowlisted-expired')
  })

  it('GRADUATION_TARGET_DELAY 0 dondurulurse pencere coker ve bu YAKALANIR', async () => {
    const { sink, run } = watch({
      pendingTarget: EVIL_TARGET,
      pendingEta: NOW - 1n,
      delay: 0n,
      nowMs: localClock(NOW),
    })
    await run()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain('below the 3600s floor')
    expect(sink.pages()[0]).toContain(EVIL_TARGET)
  })

  it('gercek 3 gunluk gecikme tabani ASMAZ, yani sessizligi bozmaz', async () => {
    const { sink, run } = watch({ nowMs: localClock(NOW) })
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.beats()).toBe(1)
  })

  it('readWindowState kaymayi ve tabani ALANI ADIYLA raporlar', async () => {
    const client = syntheticChain({ delay: 60n, timestamp: NOW + 10_000n })
    const state = await readWindowState(client, FACTORY, { nowMs: localClock(NOW) })
    expect(state.trust.trusted).toBe(false)
    expect(state.trust.reasons.length).toBe(2)
    expect(state.trust.reasons[0]).toContain('GRADUATION_TARGET_DELAY')
    expect(state.trust.reasons[1]).toContain('chain time')
  })

  it('tolerans icindeki kucuk kayma guveni BOZMAZ', async () => {
    const client = syntheticChain({ timestamp: NOW + 60n })
    const state = await readWindowState(client, FACTORY, { nowMs: localClock(NOW) })
    expect(state.trust.trusted).toBe(true)
  })
})

describe('kirilma 4: RPC saati kaymis (kanarya tarafi)', () => {
  const POLL = 5_000

  it('blok ilerlerken saat kayarsa chain-time-skewed cikar, blok dedektoru sessiz kalir', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    for (let t = 0; t <= 2 * POLL; t += POLL) {
      liveness.observeHead(BigInt(t / POLL), NOW_MS + t)
      // Zincir saati bir yil ileride ve ILERLIYOR: donmus degil, KAYMIS.
      liveness.observeChainTime(NOW + 31_536_000n + BigInt(t / 1000), NOW_MS + t)
      liveness.pollSucceeded(NOW_MS + t)
    }
    const codes = liveness.check(NOW_MS + 2 * POLL).map((f) => f.code)
    expect(codes).toEqual(['chain-time-skewed'])
  })

  it('donmus zincir saati TOLERANSLIDIR -- kisa duraklama sayfa cikarmaz', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    // Arc'in dokumani zaman damgalarinin artmayabilecegini soyler.
    for (let t = 0; t <= 5 * POLL; t += POLL) {
      liveness.observeHead(BigInt(t / POLL), NOW_MS + t)
      liveness.observeChainTime(NOW, NOW_MS + t)
      liveness.pollSucceeded(NOW_MS + t)
    }
    expect(liveness.check(NOW_MS + 5 * POLL)).toEqual([])
  })

  it('yeterince uzun donarsa chain-time-frozen cikar', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    for (let t = 0; t <= 12 * POLL; t += POLL) {
      liveness.observeHead(BigInt(t / POLL), NOW_MS + t)
      liveness.observeChainTime(NOW, NOW_MS + t)
      liveness.pollSucceeded(NOW_MS + t)
    }
    expect(liveness.check(NOW_MS + 12 * POLL).map((f) => f.code)).toEqual(['chain-time-frozen'])
  })

  it('runWatcher zincir saatini kanaryaya GERCEKTEN besler', async () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, NOW_MS)
    const client = syntheticChain({ timestamp: NOW + 31_536_000n })
    const sink = recorder()
    await runWatcher({
      client,
      factory: PINNED,
      startBlock: 1n,
      allowlist: ALLOW_GOOD,
      alert: sink.alert,
      heartbeat: sink.heartbeat,
      liveness,
      nowMs: localClock(NOW),
    })
    expect(liveness.check(NOW_MS).map((f) => f.code)).toContain('chain-time-skewed')
  })
})

// ---------------------------------------------------------------
// 11. ASLA REJECT ETMEZ  (inceleme: Important 4)
// ---------------------------------------------------------------

describe('runWatcher: ASLA REJECT ETMEZ', () => {
  // `renderTime` bir onceki halde `new Date(Number(s) * 1000).toISOString()`i
  // korumasiz cagiriyordu; `classify` her `try`in DISINDA oldugu icin poll
  // SIFIR alarmla dusuyor ve `index.ts`teki dongu KALICI oluyordu.
  const ABSURD_ETA = 10n ** 18n

  it('temsil edilemeyecek kadar buyuk bir eta renderTime"i PATLATMAZ', () => {
    const c = classify(stateOf({ pendingTarget: EVIL_TARGET, pendingEta: ABSURD_ETA }), ALLOW_GOOD)
    expect(c.level).toBe('page')
    expect(c.reason).toContain('out-of-range')
  })

  it('boyle bir eta ile poll reject ETMEZ ve SESSIZ de kalmaz', async () => {
    const { sink, run } = watch({
      pendingTarget: EVIL_TARGET,
      pendingEta: ABSURD_ETA,
      nowMs: localClock(NOW),
    })
    await expect(run()).resolves.toBeUndefined()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain(EVIL_TARGET)
  })

  // YEDEK KATMAN: `classify` BASKA bir sebeple patlarsa da poll bir sayfa
  // birakmali. `renderTime` duzeltmesi bunu gereksiz kilmaz -- bir sonraki
  // bicimlendirici ayni sekilde patlayabilir.
  it('classify her sekilde patlarsa poll yine sayfa cikarir ve reject etmez', async () => {
    const client = syntheticChain({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 1n })
    const sink = recorder()
    const exploding: Allowlist = {
      treasuries: [TREASURY],
      governor: addr('601'),
      get graduationTargets(): Address[] {
        throw new Error('boom from inside classify')
      },
    }
    await expect(
      runWatcher({
        client,
        factory: PINNED,
        startBlock: 1n,
        allowlist: exploding,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        nowMs: localClock(NOW),
      }),
    ).resolves.toBeUndefined()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain('classify-threw')
    expect(sink.pages()[0]).toContain(EVIL_TARGET)
    expect(sink.beats()).toBe(0)
  })
})

// ---------------------------------------------------------------
// 12. GECMIS YARISI -- governance loglari  (inceleme: Important 2)
// ---------------------------------------------------------------

describe('governance gecmisi', () => {
  const proposedLog = (block: bigint, target: Address) => ({
    block,
    eventName: 'GraduationTargetProposed',
    args: { target, eta: 0n },
  })
  const changedLog = (block: bigint, current: Address) => ({
    block,
    eventName: 'GraduationTargetChanged',
    args: { previous: ZERO_ADDRESS, current },
  })
  const treasuryLog = (block: bigint, current: Address) => ({
    block,
    eventName: 'ProtocolTreasuryChanged',
    args: { previous: TREASURY, current },
  })

  // INCELEMENIN SOMUT KOR NOKTASI: dusman hedef onerildi, indi, sonra mesru
  // bir oneriyle degistirildi. SLOTLAR TERTEMIZ. Ilk turda izleyici bunu
  // `quiet` siniflandiriyordu.
  it('inmis-sonra-degistirilmis dusman hedef, SLOTLAR TEMIZKEN bile yakalanir', async () => {
    const { sink, run } = watch({
      blockNumber: 100n,
      currentTarget: GOOD_TARGET,
      governanceLogs: [
        proposedLog(10n, EVIL_TARGET),
        changedLog(20n, EVIL_TARGET),
        proposedLog(30n, GOOD_TARGET),
        changedLog(40n, GOOD_TARGET),
      ],
      nowMs: localClock(NOW),
    })
    await run()
    expect(sink.pages().length).toBe(1)
    const page = sink.pages()[0] as string
    expect(page).toContain('GraduationTargetChanged shows the pointer WAS held by')
    expect(page).toContain(EVIL_TARGET)
    expect(page).toContain('CURRENT target reads clean')
  })

  // Ve TERSI: yalnizca mesru hedefler gecmiste -> SESSIZ.
  it('gecmiste yalnizca izin listesindeki hedefler varsa SESSIZ', async () => {
    const { sink, run } = watch({
      blockNumber: 100n,
      currentTarget: GOOD_TARGET,
      governanceLogs: [proposedLog(10n, GOOD_TARGET), changedLog(20n, GOOD_TARGET)],
      nowMs: localClock(NOW),
    })
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.oks()).toEqual([])
    expect(sink.beats()).toBe(1)
  })

  it('inmemis dusman oneri gecmiste NOTICE"tir, sayfa degil -- gun-0 ayak izi', async () => {
    const { sink, run } = watch({
      blockNumber: 100n,
      governanceLogs: [proposedLog(10n, EVIL_TARGET)],
      nowMs: localClock(NOW),
    })
    await run()
    expect(sink.pages()).toEqual([])
    expect(sink.oks().length).toBe(1)
    expect(sink.oks()[0]).toContain('proposed and never landed')
  })

  it('gecmisteki hazine degisimi, simdi temiz okunsa bile sayfa cikarir', async () => {
    const { sink, run } = watch({
      blockNumber: 100n,
      protocolTreasury: TREASURY,
      governanceLogs: [treasuryLog(10n, EVIL_TREASURY), treasuryLog(20n, TREASURY)],
      nowMs: localClock(NOW),
    })
    await run()
    expect(sink.pages().length).toBe(1)
    expect(sink.pages()[0]).toContain('ProtocolTreasuryChanged shows the fee recipient WAS')
    expect(sink.pages()[0]).toContain('remain claimable by it')
  })

  it('halihazirda slotta gorunen adres IKI KEZ raporlanmaz', () => {
    const c = classify(stateOf({ currentTarget: EVIL_TARGET }), ALLOW_GOOD, undefined, {
      proposedTargets: [EVIL_TARGET],
      landedTargets: [EVIL_TARGET],
      treasuries: [],
    })
    expect(c.findings).toEqual(['graduation-target-off-allowlist', 'no-pending-target'])
  })

  it('gecmis imlece yazilir, yani yeniden baslatma KOR KALMAZ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-hist-'))
    try {
      const store = cursorAt(join(dir, '.cursor'))
      const first = syntheticChain({
        blockNumber: 50n,
        governanceLogs: [changedLog(10n, EVIL_TARGET)],
      })
      await scanFactoryLogs(first, FACTORY, 1n, { store, chunk: 1_000n })
      expect(store.read()?.history.landedTargets).toEqual([EVIL_TARGET])

      // Yeniden baslatma: yalnizca YENI bloklari tarar, ama gecmisi KORUR.
      const second = syntheticChain({ blockNumber: 60n })
      const scan = await scanFactoryLogs(second, FACTORY, 1n, { store, chunk: 1_000n })
      expect(second.logQueries[0]?.fromBlock).toBe(51n)
      expect(scan.history.landedTargets).toEqual([EVIL_TARGET])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ESKI SEKILDEKI imlec yok sayilir ve bastan taranir -- gecmis "bos" sanilmaz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-v1-'))
    try {
      const path = join(dir, '.cursor')
      writeFileSync(path, JSON.stringify({ lastScannedBlock: '500', curves: [CURVE_A] }), 'utf8')
      expect(cursorAt(path).read()).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------
// 13. TEKRAR BASTIRMA  (inceleme: Important 3)
// ---------------------------------------------------------------

describe('alarm tekrari', () => {
  it('ilk sayfa ASLA bastirilmaz, tekrari bastirilir', () => {
    const throttle = createThrottle({ repeatAfterMs: 60_000 })
    expect(throttle.shouldEmit('k', 0)).toBe(true)
    expect(throttle.shouldEmit('k', 1_000)).toBe(false)
    expect(throttle.shouldEmit('k', 59_999)).toBe(false)
    expect(throttle.shouldEmit('k', 60_000)).toBe(true)
  })

  it('FARKLI bir anahtar ANINDA cikar', () => {
    const throttle = createThrottle({ repeatAfterMs: 60_000 })
    expect(throttle.shouldEmit('a', 0)).toBe(true)
    expect(throttle.shouldEmit('b', 0)).toBe(true)
  })

  it('bulgu kaybolup geri gelirse yeniden ANINDA cikar', () => {
    const throttle = createThrottle({ repeatAfterMs: 60_000 })
    expect(throttle.shouldEmit('a', 0)).toBe(true)
    throttle.sweep([])
    expect(throttle.shouldEmit('a', 1)).toBe(true)
  })

  // OLCULEN ARIZA: startBlock ilk launch'in ilerisinde -> her poll sayfa, sifir
  // kalp atisi. Bes saniyelik aralikta gunde ~35.000 sayfa.
  it('kalici bir yanlis yapilandirma 20 poll"da 20 degil 1 sayfa cikarir', async () => {
    const client = syntheticChain({ blockNumber: 50n, dropLogs: true, launchCount: 3n })
    const sink = recorder()
    const throttle = createThrottle({ repeatAfterMs: 3_600_000 })
    for (let i = 0; i < 20; i += 1) {
      await runWatcher({
        client,
        factory: PINNED,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        nowMs: () => NOW_MS + i * 5_000,
        throttle,
      })
    }
    expect(sink.pages().length).toBe(1)
    // Ama KALP ATISI hic bastirilmaz: harici olu-adam anahtari onu sayar.
    expect(sink.beats()).toBe(0)
  })

  it('throttle YOKSA her poll yayar -- bastirma opt-in"dir', async () => {
    const client = syntheticChain({ blockNumber: 50n, dropLogs: true, launchCount: 3n })
    const sink = recorder()
    for (let i = 0; i < 3; i += 1) {
      await runWatcher({
        client,
        factory: PINNED,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        nowMs: localClock(NOW),
      })
    }
    expect(sink.pages().length).toBe(3)
  })

  it('DURUM DEGISIRSE bastirma devreye girmez: yeni hedef yeni sayfadir', async () => {
    const sink = recorder()
    const throttle = createThrottle({ repeatAfterMs: 3_600_000 })
    for (const target of [EVIL_TARGET, addr('bee5')]) {
      await runWatcher({
        client: syntheticChain({ pendingTarget: target, pendingEta: NOW + 100n }),
        factory: PINNED,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        nowMs: localClock(NOW),
        throttle,
      })
    }
    expect(sink.pages().length).toBe(2)
  })
})

// ---------------------------------------------------------------
// 14. FAZLA SAYMA  (inceleme: Minor 1)
// ---------------------------------------------------------------

describe('imlec fazla sayarsa mesaj TERSINI soylemez', () => {
  it('log > slot ise OVER-reporting der ve caresi olarak imleci silmeyi soyler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-over-'))
    try {
      const path = join(dir, '.cursor')
      writeFileSync(
        path,
        // v3 + AYNI kimlik: bu test reorg kaynakli fazla saymayi olcer, imlec
        // kimliginin ayrismasini DEGIL. Kimlik ayrisirsa imlec zaten yok
        // sayilir ve fazla sayma hic olusmaz -- yani buradaki fixture'in
        // kimligi TUTMAK ZORUNDADIR, yoksa test kendi konusunu kaybeder.
        JSON.stringify({
          version: 3,
          chainId: CHAIN_ID,
          factory: FACTORY,
          startBlock: '1',
          lastScannedBlock: '40',
          curves: [CURVE_A, CURVE_B],
          history: { proposedTargets: [], landedTargets: [], treasuries: [] },
        }),
        'utf8',
      )
      // Zincir yalnizca BIR launch biliyor; imlec ikisini tutuyor (reorg).
      const { sink, run } = watch(
        { blockNumber: 50n, launchCount: 1n, nowMs: localClock(NOW) },
        ALLOW_GOOD,
        cursorAt(path),
      )
      await run()
      const page = sink.pages().find((p) => p.includes('log-scan-incomplete'))
      expect(page).toBeDefined()
      expect(page).toContain('OVER-reporting')
      expect(page).toContain('delete the cursor file')
      expect(page).not.toContain('LOWER BOUND')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('log < slot ise hala UNDER-reporting ve LOWER BOUND der', async () => {
    const { sink, run } = watch({
      blockNumber: 50n,
      dropLogs: true,
      launchCount: 2n,
      nowMs: localClock(NOW),
    })
    await run()
    const page = sink.pages().find((p) => p.includes('log-scan-incomplete'))
    expect(page).toContain('UNDER-reporting')
    expect(page).toContain('LOWER BOUND')
  })
})

// ---------------------------------------------------------------
// 15. ALARM BORUSU UCTAN UCA  (inceleme: Important 5)
// ---------------------------------------------------------------

describe('KEEPER_ALERT_LOG borusu', () => {
  // Ilk turda tatbikat bu dosyayi OKUYORDU ama hicbir sey YAZMIYORDU. Bu test
  // iki ucu GERCEKTEN birlestirir: keeper'in lavabosu yazar, tatbikatin
  // lavabo sorgusu okur, ve `drillObserve` karar verir.
  it('fileSink yazar, fileAlertSink okur, drillObserve gecer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-sink-'))
    try {
      const path = join(dir, 'alerts.log')
      const sink = multiSink(fileSink(path))
      emitAlert('ok', 'nothing to see here', sink)
      emitHeartbeat(sink)
      emitAlert('page', `pendingGraduationTarget is ${EVIL_TARGET}, NOT on the allowlist`, sink)

      const lines = readFileSync(path, 'utf8').trim().split('\n')
      expect(lines.length).toBe(3)
      expect(lines.filter((l) => l.startsWith('HEARTBEAT ')).length).toBe(1)
      expect(lines.filter((l) => l.startsWith('PAGE ')).length).toBe(1)

      await expect(
        drillObserve({
          sinceMs: 0,
          sink: fileAlertSink(path),
          target: EVIL_TARGET,
          waitMs: 0,
          sleep: () => Promise.resolve(),
        }),
      ).resolves.toMatchObject({ ok: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // AYNI BORU, SAYFA YOKKEN -> tatbikat DUSER. Boru "her zaman gecer" degil.
  it('lavaboda yalnizca OK ve HEARTBEAT varsa tatbikat DUSER', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-sink2-'))
    try {
      const path = join(dir, 'alerts.log')
      const sink = fileSink(path)
      emitHeartbeat(sink)
      emitAlert('ok', 'all quiet', sink)
      await expect(
        drillObserve({
          sinceMs: 0,
          sink: fileAlertSink(path),
          target: EVIL_TARGET,
          waitMs: 0,
          sleep: () => Promise.resolve(),
        }),
      ).resolves.toMatchObject({ ok: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dosya hic yoksa tatbikat DUSER, gecmez', async () => {
    await expect(
      drillObserve({
        sinceMs: 0,
        sink: fileAlertSink(join(tmpdir(), 'arcpad-does-not-exist-9f3a1', 'alerts.log')),
        target: EVIL_TARGET,
        waitMs: 0,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ ok: false })
  })
})

// ---------------------------------------------------------------
// 16. DEFTERDEN BAGIMSIZ PIN  (re-inceleme: Finding B)
// ---------------------------------------------------------------
//
// `KEEPER_ADDRESS_BOOK_DIR` defterin dizinini env'e acti, ve bununla birlikte
// round 1'in capraz kontrolunun GUVENLIK ICERIGI bosaldi: `assertEnvAgrees`in
// iki tarafi da ayni env-secili dosyadan gelir. Bu pin ucuncu, bagimsiz bir
// kaynak getirir -- zincir -- ve onu AYRI yollu governance dosyasina baglar.

describe('assertFactoryMatchesGovernance', () => {
  const GOVERNOR = addr('601')
  const allow: Allowlist = {
    graduationTargets: [GOOD_TARGET],
    treasuries: [TREASURY],
    governor: GOVERNOR,
  }
  const chainWithGovernor = governorChain

  it('zincirin governor"u governance dosyasiyla ayniysa gecer', async () => {
    await expect(
      assertFactoryMatchesGovernance(chainWithGovernor(GOVERNOR), FACTORY, allow),
    ).resolves.toMatchObject({ address: FACTORY, governor: GOVERNOR })
  })

  it('buyuk-kucuk harf farki gecerli bir eslesmeyi bozmaz', async () => {
    await expect(
      assertFactoryMatchesGovernance(chainWithGovernor(GOVERNOR.toLowerCase()), FACTORY, allow),
    ).resolves.toMatchObject({ address: FACTORY })
  })

  // BAYAT TATBIKAT DIZINI SEKLI: defter BASKA, gercek, sessiz bir factory'yi
  // gosteriyor. Okumalar basarili, kalp atislari akardi, her dedektor
  // susardi -- eger acilista burada dusmeseydi.
  it('defter BASKA bir factory"yi gosteriyorsa BASLAMAZ', async () => {
    await expect(
      assertFactoryMatchesGovernance(chainWithGovernor(addr('f00d')), FACTORY, allow),
    ).rejects.toThrow(/reports governor .* but expected-governance\.json says/)
  })

  it('hata mesaji bayat dizin ihtimalini ADIYLA soyler', async () => {
    await expect(
      assertFactoryMatchesGovernance(chainWithGovernor(addr('f00d')), FACTORY, allow),
    ).rejects.toThrow(/stale KEEPER_ADDRESS_BOOK_DIR/)
  })

  // Kodu olmayan bir adres `eth_call`da bos doner; `asAddress` ALANI ADIYLA
  // firlatir, sessizce sifir governor'a cozmez.
  it('kodsuz adres (bos donus) ALANI ADIYLA duser', async () => {
    await expect(
      assertFactoryMatchesGovernance(chainWithGovernor('0x'), FACTORY, allow),
    ).rejects.toThrow(/governor\(\)/)
  })
})

// ---------------------------------------------------------------
// 16b. PIN ATLANAMAZ  (index.ts P1/P2/P3'un kapatilmasi)
// ---------------------------------------------------------------
//
// OLCULEN DELIK, uc turdur ayni sekilde: `index.ts`teki pin cagrisini SILMEK
// (P1), `await`ini DUSURMEK (P2) ve onu `poll()`dan SONRAYA ALMAK (P3) --
// ucu de typecheck'ten geciyor ve birim suitinin TAMAMINI gecirtiyordu. Tek
// yakalayan sey `pin-mutants.mjs` idi, cunku `index.ts` bir surectir ve
// suit ona ERISEMEZ.
//
// Kapatma, siralamayi VERI BAGIMLILIGINA cevirmektir: `runWatcher` artik
// `Address` degil `PinnedFactory` ister, ve o jetonu uretebilen tek yer
// pindir. Uc mutasyon da artik DERLENMEZ. Asagidakiler o kapinin CALISMA ANI
// yarisidir -- `index.ts` `tsx` altinda kosar ve `tsx` tip DENETLEMEZ, yani
// tip tarafi tek basina uretimde hicbir sey ifade etmezdi.
describe('pin atlanamaz: PinnedFactory', () => {
  const unpinned = (value: unknown): PinnedFactory => value as PinnedFactory

  it('P1 SEKLI: hic pinlenmemis (undefined) factory ADIYLA duser', () => {
    expect(() => pinnedAddress(unpinned(undefined))).toThrow(/never pinned/)
  })

  it('P2 SEKLI: `await` dusurulmus -- bir Promise jeton DEGILDIR', () => {
    const notAwaited = assertFactoryMatchesGovernance(
      governorChain(ALLOW_GOOD.governor),
      FACTORY,
      ALLOW_GOOD,
    )
    expect(() => pinnedAddress(unpinned(notAwaited))).toThrow(/never pinned/)
  })

  // ELDE UYDURULMUS BIR JETON DA GECMEZ. Marka disari verilmedigi icin bu
  // sekli bu modulun disinda hicbir sey uretemez -- ne uretim kodu ne test.
  it('elde uydurulmus bir jeton (dogru alanlar, marka yok) GECMEZ', () => {
    expect(() => pinnedAddress(unpinned({ address: FACTORY, governor: addr('601') }))).toThrow(
      /never pinned/,
    )
    expect(() => pinnedAddress(unpinned(FACTORY))).toThrow(/never pinned/)
  })

  it('GERCEK jeton gecer ve pinlendigi adresi tasir', () => {
    expect(pinnedAddress(PINNED)).toBe(FACTORY)
  })

  // ASIL IDDIA: pin atlanirsa izleyici KOSMAZ. Sayfa cikarip devam etmek
  // DOGRU sonuc DEGILDIR -- yanlis factory'ye karsi dogru sayfalar cikaran
  // bir izleyici, tam olarak bu kontrolun onlemek icin var oldugu seydir.
  it('pinlenmemis factory ile runWatcher KOSMAZ: sifir sayfa, SIFIR kalp atisi', async () => {
    const sink = recorder()
    await expect(
      runWatcher({
        client: syntheticChain({ pendingTarget: EVIL_TARGET, pendingEta: NOW + 100n }),
        factory: unpinned(FACTORY),
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        nowMs: localClock(NOW),
      }),
    ).rejects.toThrow(/never pinned/)
    expect(sink.beats()).toBe(0)
    expect(sink.pages()).toEqual([])
  })
})

// ---------------------------------------------------------------
// 17. UC HAYATTA KALAN MUTANTIN KAPATTIGI DELIKLER
// ---------------------------------------------------------------
//
// M23, M24 ve M30 round 3'un kampanyasinda HAYATTA KALDI, ve ucu de AYNI
// hatanin ornegiydi: test, test ettigi kodu ATLAYAN bir yoldan iddia
// ediyordu.
//
//   M23  `fileAlertSink`in zaman penceresi kaldirildi -> test gormedi, cunku
//        `fakeSink` filtrelemeyi KENDI yapiyordu; gercek suzgec hic
//        yurutulmuyordu.
//   M24  kalp atisi sarti kaldirildi -> hicbir testte "pencere icinde sayfa
//        VAR ama kalp atisi YOK" durumu yoktu.
//   M30  bos dizeyi undefined'a ceviren yardimci kaldirildi -> test
//        `bookDir` ARGUMANI geciyordu, ki o env'i tamamen ezer.
//
// Asagidakiler ucunu de GERCEK yoldan yurur.

describe('hayatta kalan mutantlarin kapatilmasi', () => {
  const noSleep = (): Promise<void> => Promise.resolve()
  const withSink = <T>(body: (path: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-surv-'))
    try {
      return body(join(dir, 'alerts.log'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // M23: GERCEK `fileAlertSink` uzerinden, sahte suzgec olmadan.
  it('fileAlertSink penceresi GERCEKTEN suzer (M23)', async () => {
    const old = '2026-06-01T00:00:00.000Z'
    const fresh = '2026-07-01T00:00:00.000Z'
    await withSink(async (path) => {
      writeFileSync(
        path,
        [
          `PAGE keeper.graduationWindow at=${old} pendingGraduationTarget is ${EVIL_TARGET}`,
          `HEARTBEAT keeper.graduationWindow at=${fresh}`,
          '',
        ].join('\n'),
        'utf8',
      )
      const since = Date.parse('2026-06-15T00:00:00.000Z')
      const lines = await fileAlertSink(path).readSince(since)
      expect(lines.map((l) => l.kind)).toEqual(['heartbeat'])

      // Ve uctan uca: BAYAT sayfa + TAZE kalp atisi -> tatbikat DUSER.
      await expect(
        drillObserve({
          sink: fileAlertSink(path),
          target: EVIL_TARGET,
          sinceMs: since,
          waitMs: 0,
          sleep: noSleep,
        }),
      ).resolves.toMatchObject({ ok: false })
    })
  })

  it('ayni dosya, pencere ONCEYE alininca GECER -- suzgec "her zaman reddet" degil (M23)', async () => {
    const at = '2026-07-01T00:00:00.000Z'
    await withSink(async (path) => {
      writeFileSync(
        path,
        [
          `PAGE keeper.graduationWindow at=${at} pendingGraduationTarget is ${EVIL_TARGET}`,
          `HEARTBEAT keeper.graduationWindow at=${at}`,
          '',
        ].join('\n'),
        'utf8',
      )
      await expect(
        drillObserve({
          sink: fileAlertSink(path),
          target: EVIL_TARGET,
          sinceMs: Date.parse('2026-06-15T00:00:00.000Z'),
          waitMs: 0,
          sleep: noSleep,
        }),
      ).resolves.toMatchObject({ ok: true })
    })
  })

  // M24: PENCERE ICINDE sayfa VAR, kalp atisi YOK. Kapinin izledigi seyin
  // olumunden sag cikmadigini ispatlayan TEK durum budur.
  it('pencere icinde sayfa var ama kalp atisi yoksa DUSER (M24)', async () => {
    const at = '2026-07-01T00:00:00.000Z'
    await withSink(async (path) => {
      writeFileSync(
        path,
        `PAGE keeper.graduationWindow at=${at} pendingGraduationTarget is ${EVIL_TARGET}\n`,
        'utf8',
      )
      const outcome = await drillObserve({
        sink: fileAlertSink(path),
        target: EVIL_TARGET,
        sinceMs: Date.parse('2026-06-15T00:00:00.000Z'),
        waitMs: 0,
        sleep: noSleep,
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.detail).toContain('NO HEARTBEAT')
    })
  })

  it('ayni dosyaya kalp atisi eklenince GECER (M24)', async () => {
    const at = '2026-07-01T00:00:00.000Z'
    await withSink(async (path) => {
      writeFileSync(
        path,
        [
          `PAGE keeper.graduationWindow at=${at} pendingGraduationTarget is ${EVIL_TARGET}`,
          `HEARTBEAT keeper.graduationWindow at=${at}`,
          '',
        ].join('\n'),
        'utf8',
      )
      await expect(
        drillObserve({
          sink: fileAlertSink(path),
          target: EVIL_TARGET,
          sinceMs: Date.parse('2026-06-15T00:00:00.000Z'),
          waitMs: 0,
          sleep: noSleep,
        }),
      ).resolves.toMatchObject({ ok: true })
    })
  })
})
