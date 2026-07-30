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
} from '../src/alert'
import { parseGovernanceAllowlist } from '../src/config'
import { drillExpiry, drillObserve } from '../src/drill'
import {
  type Allowlist,
  type ChainReader,
  classify,
  computeWindow,
  type CursorStore,
  exposure,
  fileCursorStore,
  knownCurves,
  LogScanError,
  readWindowState,
  runWatcher,
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

/** 2026-06-01T00:26:40Z. Gercekci bir unix zamani; ISO ciktisi okunabilir olsun diye. */
const NOW = 1_780_000_000n
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
  curves?: Record<string, CurveFixture>
  /** Log taramasinin RPC hatasi atmasi. */
  failLogs?: boolean
  /** Log taramasinin SESSIZCE bos donmesi -- dusmus bir abonelik. */
  dropLogs?: boolean
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
      const event = query.event as { name?: string }
      logQueries.push({
        event: event.name ?? '?',
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
      })
      if (fixture.failLogs) {
        return Promise.reject(new Error('query returned more than 10000 results'))
      }
      if (fixture.dropLogs) return Promise.resolve([])
      return Promise.resolve(
        launched
          .filter((entry) => entry.block >= query.fromBlock && entry.block <= query.toBlock)
          .map((entry) => ({ args: { curve: entry.curve } })),
      )
    },
  }
}

function curveSet(entries: Array<[Address, CurveFixture]>): Record<string, CurveFixture> {
  return Object.fromEntries(entries.map(([address, fixture]) => [address.toLowerCase(), fixture]))
}

const ALLOW_GOOD: Allowlist = { graduationTargets: [GOOD_TARGET], treasuries: [TREASURY] }
const ALLOW_EMPTY: Allowlist = { graduationTargets: [], treasuries: [TREASURY] }

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
    factory: FACTORY,
    startBlock: 1n,
    allowlist,
    alert: sink.alert,
    heartbeat: sink.heartbeat,
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
    const state = await readWindowState(client, FACTORY)
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
    })
  })

  // ALTI OKUMA TEK BIR BLOGA SABITLENIR. Sabitlenmeseydi "latest"e karsi
  // yapilan okumalar bir blok sinirini kesip TUTARSIZ bir goruntu uretebilirdi:
  // oneri inisten once, hedef inisten sonra.
  it('her okumayi tek bir blok numarasina sabitler', async () => {
    const client = syntheticChain({ blockNumber: 4_242n })
    await readWindowState(client, FACTORY)
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
    await expect(readWindowState(broken, FACTORY)).rejects.toThrow(/pendingGraduationTargetEta/)
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
      classify(state, { graduationTargets: [EVIL_TARGET], treasuries: [TREASURY] }).level,
    ).toBe('ok')
  })

  it('checksum farki bir eslesmeyi kacirmaz', () => {
    const state = stateOf({ pendingTarget: GOOD_TARGET, pendingEta: NOW + 1n })
    const lowercased = {
      graduationTargets: [GOOD_TARGET.toLowerCase() as Address],
      treasuries: [TREASURY],
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
    expect(client.logQueries.every((q) => q.event === 'Launched')).toBe(true)
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

  // MARUZIYETI EKSIK BILDIREN BIR SAYFA HIC SAYFA CIKARMAMAKTAN KOTUDUR.
  it('bir RPC aralik hatasinda KISA LISTE DONMEZ, firlatir', async () => {
    const client = syntheticChain({ blockNumber: 30n, failLogs: true })
    await expect(knownCurves(client, FACTORY, 1n)).rejects.toBeInstanceOf(LogScanError)
  })

  it('tarama basarisiz olursa imleci YAZMAZ -- yeniden baslatma araligi tekrar tarar', async () => {
    const path = join(tempDir(), '.cursor')
    const store = fileCursorStore(path)
    const client = syntheticChain({ blockNumber: 30n, failLogs: true })
    await expect(knownCurves(client, FACTORY, 1n, { store })).rejects.toBeInstanceOf(LogScanError)
    expect(store.read()).toBeNull()
  })

  it('imleci diske yazar ve yeniden baslatma genesis"ten taramaz', async () => {
    const path = join(tempDir(), '.cursor')
    const store = fileCursorStore(path)

    const first = syntheticChain({ blockNumber: 20n, launched: [{ block: 4n, curve: CURVE_A }] })
    await knownCurves(first, FACTORY, 1n, { store, chunk: 100n })
    expect(store.read()).toEqual({ lastScannedBlock: 20n, curves: [CURVE_A] })

    const second = syntheticChain({ blockNumber: 40n, launched: [{ block: 33n, curve: CURVE_B }] })
    const found = await knownCurves(second, FACTORY, 1n, { store, chunk: 100n })
    expect(second.logQueries).toEqual([{ event: 'Launched', fromBlock: 21n, toBlock: 40n }])
    expect(found).toEqual([CURVE_A, CURVE_B].sort())
  })

  it('imlec basligin ILERISINDEYSE durur -- reorg ya da yanlis zincir', async () => {
    const path = join(tempDir(), '.cursor')
    writeFileSync(path, JSON.stringify({ lastScannedBlock: '9999', curves: [] }), 'utf8')
    const client = syntheticChain({ blockNumber: 20n })
    await expect(
      knownCurves(client, FACTORY, 1n, { store: fileCursorStore(path) }),
    ).rejects.toThrow(/ahead of the chain head/)
  })

  it('imlec dosyasi tanimsizsa TAHMIN ETMEZ', () => {
    const path = join(tempDir(), '.cursor')
    writeFileSync(path, JSON.stringify({ nonsense: true }), 'utf8')
    expect(() => fileCursorStore(path).read()).toThrow(/not a keeper cursor/)
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
        factory: FACTORY,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
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
    const liveness = createLiveness({ pollIntervalMs: POLL }, 0)
    expect(liveness.check(POLL)).toEqual([])
    const findings = liveness.check(2 * POLL)
    expect(findings.map((f) => f.code)).toEqual(['watcher-heartbeat-missed', 'chain-head-stale'])
  })

  it('poll ediliyorken sessiz, DURDUGUNDA iki aralik sonra sayfa', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, 0)
    for (let t = 0; t <= 60_000; t += POLL) {
      liveness.observeHead(BigInt(t / POLL), t)
      liveness.pollSucceeded(t)
      expect(liveness.check(t), `t=${t}`).toEqual([])
    }
    // Burada durur.
    expect(liveness.check(60_000 + POLL)).toEqual([])
    const findings = liveness.check(60_000 + 2 * POLL)
    expect(findings.map((f) => f.code)).toEqual(['watcher-heartbeat-missed', 'chain-head-stale'])
    expect(findings[0]?.message).toContain('the watcher is not watching')
  })

  it('yarim poll kalp atisi vermez, yani kanarya onu da yakalar', async () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, 0)
    const client = syntheticChain({ blockNumber: 50n, failLogs: true })
    const sink = recorder()
    for (let t = 0; t <= 3 * POLL; t += POLL) {
      await runWatcher({
        client,
        factory: FACTORY,
        startBlock: 1n,
        allowlist: ALLOW_GOOD,
        alert: sink.alert,
        heartbeat: sink.heartbeat,
        liveness,
        nowMs: () => t,
      })
    }
    expect(sink.beats()).toBe(0)
    expect(liveness.check(3 * POLL).map((f) => f.code)).toContain('watcher-heartbeat-missed')
  })
})

describe('kirilma 3: RPC bayat blok besliyor', () => {
  const POLL = 5_000

  it('ayni blok numarasi tekrar tekrar gorulurse sayac SIFIRLANMAZ', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, 0)
    for (let t = 0; t <= 2 * POLL; t += POLL) {
      liveness.observeHead(777n, t)
      liveness.pollSucceeded(t)
    }
    const findings = liveness.check(2 * POLL)
    expect(findings.map((f) => f.code)).toEqual(['chain-head-stale'])
    expect(findings[0]?.message).toContain('block 777')
    // Kalp atisi SAGLAM -- yani bu ariza SADECE bayat-blok dedektoruyle
    // gorunur. Ikisini ayri tutmanin sebebi tam olarak budur.
    expect(findings.some((f) => f.code === 'watcher-heartbeat-missed')).toBe(false)
  })

  it('blok ilerledigi surece sessiz', () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, 0)
    for (let t = 0; t <= 10 * POLL; t += POLL) {
      liveness.observeHead(BigInt(t / POLL), t)
      liveness.pollSucceeded(t)
      expect(liveness.check(t), `t=${t}`).toEqual([])
    }
  })

  it('bayat blok gercek bir poll dongusunde yakalanir: pencere saati donar', async () => {
    const liveness = createLiveness({ pollIntervalMs: POLL }, 0)
    // Blok ve zaman damgasi sabit -- RPC dondurulmus bir goruntu servis ediyor.
    const client = syntheticChain({ blockNumber: 900n, timestamp: NOW })
    const sink = recorder()
    for (let t = 0; t <= 2 * POLL; t += POLL) {
      await runWatcher({
        client,
        factory: FACTORY,
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
    // Kanarya yine de yakalar.
    expect(liveness.check(2 * POLL).map((f) => f.code)).toEqual(['chain-head-stale'])
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
    expect(parsed).toEqual({ graduationTargets: [GOOD_TARGET], treasuries: [TREASURY] })
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
    // arc-testnet KAYDI HENUZ SIFIR: izleyici ona karsi baslamayi reddetmeli.
    expect(() => parseGovernanceAllowlist(raw, 'arc-testnet')).toThrow(/zero address/)
  })
})

// ---------------------------------------------------------------
// 9. Tatbikat
// ---------------------------------------------------------------

describe('drill: observe', () => {
  const noSleep = (): Promise<void> => Promise.resolve()

  it('lavaboda hedefi anan bir sayfa varsa gecer', async () => {
    const sink = {
      recentPages: () =>
        Promise.resolve([
          `PAGE keeper.graduationWindow pendingGraduationTarget is ${EVIL_TARGET} ...`,
        ]),
    }
    const outcome = await drillObserve({ sink, target: EVIL_TARGET, waitMs: 0, sleep: noSleep })
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('attempt 1/3')
  })

  // ALARM BORUSU SESSIZSE TATBIKAT DUSER. Bu, tatbikatin var olma sebebidir:
  // izleyici "sayfa cikardim" dese bile lavaboya bir sey varmadiysa kontrol
  // yoktur.
  it('lavabo bossa duser', async () => {
    const sink = { recentPages: () => Promise.resolve([]) }
    const outcome = await drillObserve({ sink, target: EVIL_TARGET, waitMs: 0, sleep: noSleep })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('NO PAGE')
  })

  it('ALAKASIZ bir sayfa tatbikati gecirmez', async () => {
    const sink = {
      recentPages: () => Promise.resolve(['PAGE keeper.graduationWindow chain-head-stale ...']),
    }
    const outcome = await drillObserve({ sink, target: EVIL_TARGET, waitMs: 0, sleep: noSleep })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('1 unrelated page(s)')
  })

  it('sayfa gec gelirse sonraki denemede yakalanir', async () => {
    let calls = 0
    const sink = {
      recentPages: () => {
        calls += 1
        return Promise.resolve(calls < 3 ? [] : [`PAGE ... ${EVIL_TARGET} ...`])
      },
    }
    const outcome = await drillObserve({ sink, target: EVIL_TARGET, waitMs: 0, sleep: noSleep })
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
      emitAlert(
        'page',
        `pendingGraduationTarget is ${EVIL_TARGET} and is NOT on the allowlist`,
        consoleSink,
      )
    } finally {
      console.log = original.log
      console.error = original.error
    }
    const pages = lines.filter((line) => line.startsWith('PAGE '))
    expect(pages.length).toBe(1)
    await expect(
      drillObserve({
        sink: { recentPages: () => Promise.resolve(pages) },
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
