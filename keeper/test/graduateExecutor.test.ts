import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { AlertLevel } from '../src/alert'
import {
  type GraduationWriter,
  type PassSummary,
  type ReceiptSummary,
  runGraduationPass,
  type SimulateResult,
} from '../src/graduate/executor'
import { type CurveLocks, type LockHandle, type LockRefusal } from '../src/graduate/lock'
import { memoryQuarantineStore, type QuarantineStore } from '../src/graduate/state'
import type {
  ChainReader,
  Cursor,
  CursorStore,
  HeadBlock,

  ObservedLog,
  ReadCall,
} from '../src/watch/graduationWindow'

const FACTORY = '0xfE11Db901168B0B0f7474b72a2e39b3d805b4849' as Address
const LOCKER = '0x1AfD2eF32C445FAdC95f05Ed237ed4C9dAE9d33F' as Address
const OTHER_LOCKER = '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const CURVE_A = '0xAAaA000000000000000000000000000000000001' as Address
const CURVE_B = '0xBbbb000000000000000000000000000000000002' as Address

const GRADUATION_TARGET_UNSET = '0xfe30fa5b'
const ALREADY_GRADUATED = '0xe6a0d45f'
const GRADUATION_PAYOUT_FAILED = '0x1ee5f101'

type CurveFixture = { complete: boolean; graduated: boolean; quote: bigint }

type ReaderOpts = {
  head?: bigint
  target?: Address
  /** `Launched` loglarinin verdigi curve'ler. */
  launched?: Address[]
  curves: Record<Address, CurveFixture>
}

function fakeReader(opts: ReaderOpts): ChainReader & { reads: string[] } {
  const head = opts.head ?? 100n
  const reads: string[] = []
  // ADRESLER KUCUK HARFE INDIRGENIR. `scanFactoryLogs` her log argumanini
  // `getAddress` ile CHECKSUM'LAR, dolayisiyla ham dizeyle anahtarlanmis bir
  // fixture haritasi ISKA GECER -- ve iska gecen fixture, testin olcmek
  // istedigi seyi degil bir okuma hatasini olcerdi.
  const lookup = (address: Address): CurveFixture | undefined =>
    Object.entries(opts.curves).find(
      ([key]) => key.toLowerCase() === address.toLowerCase(),
    )?.[1]
  return {
    reads,
    getBlock(): Promise<HeadBlock> {
      return Promise.resolve({ number: head, timestamp: 1_786_489_400n })
    },
    readContract(call: ReadCall): Promise<unknown> {
      reads.push(`${call.address}.${call.functionName}`)
      if (call.functionName === 'graduationTarget') return Promise.resolve(opts.target ?? ZERO)
      const fixture = lookup(call.address)
      if (fixture === undefined) throw new Error(`no fixture for ${call.address}`)
      if (call.functionName === 'complete') return Promise.resolve(fixture.complete)
      if (call.functionName === 'graduated') return Promise.resolve(fixture.graduated)
      if (call.functionName === 'realQuoteReserves') return Promise.resolve(fixture.quote)
      throw new Error(`unexpected read ${call.functionName}`)
    },
    getLogs(): Promise<ReadonlyArray<ObservedLog>> {
      return Promise.resolve((opts.launched ?? []).map((curve) => ({ args: { curve } })))
    },
  }
}

function memoryCursor(initial?: Cursor): CursorStore {
  let cursor = initial ?? null
  return {
    read: () => cursor,
    write: (next) => {
      cursor = next
    },
  }
}

type WriterScript = {
  simulate?: (curve: Address, block: bigint) => Promise<SimulateResult> | SimulateResult
  send?: (curve: Address) => Promise<Hex> | Hex
  wait?: (hash: Hex) => Promise<ReceiptSummary> | ReceiptSummary
}

function fakeWriter(script: WriterScript): GraduationWriter & {
  simulated: Address[]
  sent: Address[]
} {
  const simulated: Address[] = []
  const sent: Address[] = []
  return {
    account: '0xe92c64C4f36216eA773f2622f6D5f8530Ae92fD2' as Address,
    simulated,
    sent,
    async simulate(curve, block) {
      simulated.push(curve)
      return script.simulate === undefined ? { ok: true } : await script.simulate(curve, block)
    },
    async send(curve) {
      sent.push(curve)
      if (script.send === undefined) return `0x${'11'.repeat(32)}` as Hex
      return await script.send(curve)
    },
    async wait(hash) {
      if (script.wait === undefined) {
        return { status: 'success', blockNumber: 101n, gasUsed: 500_000n, transactionHash: hash }
      }
      return await script.wait(hash)
    },
  }
}

function openLocks(): CurveLocks {
  return {
    acquire(curve): LockHandle {
      return { curve, path: `/tmp/${curve}`, token: 'test', stolen: false, release: () => {} }
    },
  }
}

function refusingLocks(): CurveLocks {
  return {
    acquire(curve): LockRefusal {
      return { heldBy: 'other-executor', expiresAt: 9e12, detail: `${curve} is locked elsewhere` }
    },
  }
}

type Emitted = { level: AlertLevel; key: string; message: string }

async function pass(overrides: {
  reader: ChainReader
  writer: GraduationWriter
  dryRun?: boolean
  quarantine?: QuarantineStore
  locks?: CurveLocks
  cursor?: CursorStore
  nowMs?: number
  maxPerPass?: number
}): Promise<{ summary: PassSummary; emitted: Emitted[] }> {
  const emitted: Emitted[] = []
  const summary = await runGraduationPass({
    client: overrides.reader,
    writer: overrides.writer,
    factory: FACTORY,
    locker: LOCKER,
    startBlock: 1n,
    store: overrides.cursor ?? memoryCursor(),
    quarantine: overrides.quarantine ?? memoryQuarantineStore(),
    locks: overrides.locks ?? openLocks(),
    dryRun: overrides.dryRun ?? true,
    ...(overrides.maxPerPass === undefined ? {} : { maxPerPass: overrides.maxPerPass }),
    nowMs: () => overrides.nowMs ?? 1_000_000,
    alert: (level, key, message) => {
      emitted.push({ level, key, message })
    },
  })
  return { summary, emitted }
}

const pages = (emitted: Emitted[]): Emitted[] => emitted.filter((e) => e.level === 'page')

describe('runGraduationPass -- hedef silahlanmamisken', () => {
  it('BEKLEYEN CURVE VARKEN BILE SAYFA CIKARMAZ ve hicbir simulasyon yapmaz', async () => {
    // Uretim fabrikasinin BUGUNKU durumu: `graduationTarget == 0x0`, ve
    // tamamlanmis bir curve bekliyor (canli smoke curve tam olarak budur).
    const reader = fakeReader({
      target: ZERO,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 12_161_433_369_060_378_707n } },
    })
    const writer = fakeWriter({})
    const { summary, emitted } = await pass({ reader, writer })

    expect(summary.armed).toBe(false)
    expect(summary.pending.map((p) => p.curve)).toEqual([CURVE_A])
    expect(summary.pendingQuoteWei).toBe(12_161_433_369_060_378_707n)
    // SIFIR SAYFA. Gorev tanimindaki acik sart.
    expect(pages(emitted)).toEqual([])
    // ...VE SIFIR SIMULASYON: silahlanmamis bir fabrikaya karsi cagri yapmak,
    // Arc'in paylasilan hiz sinirini bos yere yemektir.
    expect(writer.simulated).toEqual([])
    expect(writer.sent).toEqual([])
    // AMA SESSIZ DE DEGIL: maruziyet ADIYLA kayda gecer.
    expect(emitted.some((e) => e.key === 'graduation-waiting-for-target')).toBe(true)
  })

  it('hedef BASKA bir adresse SAYFA cikarir ve hicbir curve\'e dokunmaz', async () => {
    const reader = fakeReader({
      target: OTHER_LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 5n } },
    })
    const writer = fakeWriter({})
    const { summary, emitted } = await pass({ reader, writer })

    expect(summary.armed).toBe(false)
    const page = pages(emitted)[0]
    expect(page?.key.startsWith('graduation-target-is-not-our-locker')).toBe(true)
    expect(writer.simulated).toEqual([])
  })
})

describe('runGraduationPass -- silahliyken', () => {
  it('kuru kosuda SIMULE EDER ve YAYINLAMAZ', async () => {
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 7n } },
    })
    const writer = fakeWriter({})
    const { summary, emitted } = await pass({ reader, writer, dryRun: true })

    expect(writer.simulated).toEqual([CURVE_A])
    expect(writer.sent).toEqual([])
    expect(summary.outcomes[0]?.code).toBe('would-graduate')
    expect(summary.broadcast).toBe(0)
    expect(pages(emitted)).toEqual([])
  })

  it('kuru kosu KAPALIYKEN yayinlar, makbuzu bekler ve GERI OKUR', async () => {
    const fixtures: Record<Address, CurveFixture> = {
      [CURVE_A]: { complete: true, graduated: false, quote: 12n },
    }
    const reader = fakeReader({ target: LOCKER, launched: [CURVE_A], curves: fixtures })
    const writer = fakeWriter({
      send: (curve) => {
        // Zincir simdi mezun etti; geri okuma bunu GORMELI.
        fixtures[curve] = { complete: true, graduated: true, quote: 12n }
        return `0x${'ab'.repeat(32)}` as Hex
      },
    })
    const { summary, emitted } = await pass({ reader, writer, dryRun: false })

    expect(writer.sent).toEqual([CURVE_A])
    expect(summary.outcomes[0]?.code).toBe('graduated')
    expect(summary.broadcast).toBe(1)
    expect(pages(emitted)).toEqual([])
    expect(emitted.some((e) => e.key.startsWith('graduation-landed'))).toBe(true)
  })

  it('BASARILI MAKBUZ AMA `graduated()` HALA FALSE ise SAYFA cikarir', async () => {
    // Makbuz "islem revert etmedi" der; "curve mezun oldu" DEMEZ. Bu ayrimi
    // silen bir yurutucu, hicbir sey yapmayan bir islemi basari sayardi.
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 12n } },
    })
    const writer = fakeWriter({})
    const { summary, emitted } = await pass({ reader, writer, dryRun: false })

    expect(writer.sent).toEqual([CURVE_A])
    expect(pages(emitted).some((e) => e.key.startsWith('graduation-did-not-latch'))).toBe(true)
    expect(summary.outcomes[0]?.code).toBe('unknown-revert')
  })

  it('zincirde revert eden bir islem SAYFA cikarir ve gaz sayisini tasir', async () => {
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 12n } },
    })
    const writer = fakeWriter({
      wait: (hash) => ({
        status: 'reverted' as const,
        blockNumber: 101n,
        gasUsed: 44_000n,
        transactionHash: hash,
      }),
    })
    const { summary, emitted } = await pass({ reader, writer, dryRun: false })
    expect(pages(emitted).some((e) => e.key.startsWith('graduation-reverted-on-chain'))).toBe(true)
    expect(summary.outcomes[0]?.gasUsed).toBe(44_000n)
  })
})

describe('runGraduationPass -- yaris ve idempotenslik', () => {
  it('AlreadyGraduated bir NO-OP\'tir: sayfa yok, yayin yok, gaz yok', async () => {
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 9n } },
    })
    const writer = fakeWriter({
      simulate: () => ({ ok: false, revertData: ALREADY_GRADUATED, detail: 'reverted' }),
    })
    const { summary, emitted } = await pass({ reader, writer, dryRun: false })

    expect(writer.sent).toEqual([])
    expect(pages(emitted)).toEqual([])
    expect(summary.outcomes[0]?.code).toBe('already-graduated')
  })

  it('BASKA BIR YURUTUCU kilidi tutuyorsa simulasyon bile yapilmaz', async () => {
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 9n } },
    })
    const writer = fakeWriter({})
    const { summary, emitted } = await pass({
      reader,
      writer,
      dryRun: false,
      locks: refusingLocks(),
    })

    expect(writer.simulated).toEqual([])
    expect(writer.sent).toEqual([])
    expect(summary.outcomes[0]?.code).toBe('locked-elsewhere')
    expect(pages(emitted)).toEqual([])
  })

  it('silahliyken bile GraduationTargetUnset uyandirmaz', async () => {
    // Hedef okundu ve bizimdi, ama cagri anina kadar degisti (ya da baska bir
    // fabrikanin curve'u kumeye girdi). Yon her zaman ayni: bu revert
    // uyandirmaz.
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 9n } },
    })
    const writer = fakeWriter({
      simulate: () => ({ ok: false, revertData: GRADUATION_TARGET_UNSET, detail: 'reverted' }),
    })
    const { emitted } = await pass({ reader, writer, dryRun: false })
    expect(pages(emitted)).toEqual([])
  })
})

describe('runGraduationPass -- karantina', () => {
  it('kalici bir revert BIR KEZ sayfa cikarir, sonraki gecisler SESSIZDIR', async () => {
    const quarantine = memoryQuarantineStore()
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 9n } },
    })
    const writer = fakeWriter({
      simulate: () => ({ ok: false, revertData: GRADUATION_PAYOUT_FAILED, detail: 'reverted' }),
    })

    const first = await pass({ reader, writer, dryRun: false, quarantine })
    expect(pages(first.emitted).length).toBe(1)
    expect(writer.simulated).toEqual([CURVE_A])

    const second = await pass({ reader, writer, dryRun: false, quarantine })
    // IKINCI GECIS: sayfa YOK, simulasyon YOK...
    expect(pages(second.emitted)).toEqual([])
    expect(writer.simulated).toEqual([CURVE_A])
    // ...AMA CURVE HALA MARUZIYETTE SAYILIR. Karantina "denemeyi birak"
    // demektir, "yok say" demek DEGIL.
    expect(second.summary.pending.map((p) => p.curve)).toEqual([CURVE_A])
    expect(second.summary.pendingQuoteWei).toBe(9n)
    expect(second.summary.outcomes[0]?.code).toBe('quarantined')
  })

  it('karantinanin OMRU vardir: sure dolunca yeniden denenir', async () => {
    const quarantine = memoryQuarantineStore({ quarantineMs: 1_000 })
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 9n } },
    })
    const writer = fakeWriter({
      simulate: () => ({ ok: false, revertData: GRADUATION_PAYOUT_FAILED, detail: 'reverted' }),
    })

    await pass({ reader, writer, dryRun: false, quarantine, nowMs: 1_000_000 })
    expect(writer.simulated.length).toBe(1)

    await pass({ reader, writer, dryRun: false, quarantine, nowMs: 1_000_500 })
    expect(writer.simulated.length).toBe(1) // hala tutuluyor

    await pass({ reader, writer, dryRun: false, quarantine, nowMs: 1_002_000 })
    expect(writer.simulated.length).toBe(2) // sure doldu, TEK bir yeniden deneme
  })

  it('mezun olan bir curve karantinadan DUSER', async () => {
    const quarantine = memoryQuarantineStore()
    const fixtures: Record<Address, CurveFixture> = {
      [CURVE_A]: { complete: true, graduated: false, quote: 9n },
    }
    const reader = fakeReader({ target: LOCKER, launched: [CURVE_A], curves: fixtures })
    let broken = true
    const writer = fakeWriter({
      simulate: () =>
        broken
          ? ({ ok: false, revertData: GRADUATION_PAYOUT_FAILED, detail: 'reverted' } as const)
          : ({ ok: true } as const),
      send: (curve) => {
        fixtures[curve] = { complete: true, graduated: true, quote: 9n }
        return `0x${'cd'.repeat(32)}` as Hex
      },
    })

    await pass({ reader, writer, dryRun: false, quarantine, nowMs: 1_000_000 })
    expect(quarantine.entry(CURVE_A)).toBeDefined()

    broken = false
    // Karantina suresi dolduktan sonraki gecis.
    await pass({
      reader,
      writer,
      dryRun: false,
      quarantine,
      nowMs: 1_000_000 + 25 * 60 * 60 * 1000,
    })
    expect(quarantine.entry(CURVE_A)).toBeUndefined()
  })
})

describe('runGraduationPass -- kesif', () => {
  it('KEEPER KAPALIYKEN TAMAMLANAN bir curve, hicbir `Completed` olayi gorulmeden bulunur', async () => {
    // Imlec curve'u ONCEDEN biliyor (o zaman curve aciktı). Keeper kapaliydi,
    // curve tamamlandi ve `Completed` olayi kimse tarafindan gorulmedi. Log
    // taramasi bu gecisde HICBIR yeni log dondurmuyor -- `launched: []` --
    // yani curve YALNIZCA imlecten ve SLOTTAN geliyor.
    const cursor = memoryCursor({
      lastScannedBlock: 99n,
      curves: [CURVE_A],
      history: { proposedTargets: [], landedTargets: [], treasuries: [] },
    })
    const reader = fakeReader({
      target: LOCKER,
      launched: [],
      curves: { [CURVE_A]: { complete: true, graduated: false, quote: 12n } },
    })
    const writer = fakeWriter({})
    const { summary } = await pass({ reader, writer, cursor, dryRun: true })

    expect(summary.pending.map((p) => p.curve)).toEqual([CURVE_A])
    expect(writer.simulated).toEqual([CURVE_A])
  })

  it('mezun olmus ve acik curve\'ler bekleyen kumeye GIRMEZ', async () => {
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A, CURVE_B],
      curves: {
        [CURVE_A]: { complete: true, graduated: true, quote: 1n },
        [CURVE_B]: { complete: false, graduated: false, quote: 0n },
      },
    })
    const writer = fakeWriter({})
    const { summary } = await pass({ reader, writer })
    expect(summary.pending).toEqual([])
    expect(summary.knownCurves).toBe(2)
    expect(writer.simulated).toEqual([])
  })

  it('gecis basina butce asilmaz ve asilanlar RAPOR EDILIR', async () => {
    const reader = fakeReader({
      target: LOCKER,
      launched: [CURVE_A, CURVE_B],
      curves: {
        [CURVE_A]: { complete: true, graduated: false, quote: 1n },
        [CURVE_B]: { complete: true, graduated: false, quote: 2n },
      },
    })
    const writer = fakeWriter({})
    const { summary } = await pass({ reader, writer, maxPerPass: 1 })
    expect(writer.simulated.length).toBe(1)
    expect(summary.pending.length).toBe(2)
    expect(summary.outcomes.some((o) => o.detail.includes('were not attempted this pass'))).toBe(
      true,
    )
  })
})

describe('runGraduationPass -- zincir arizalari', () => {
  it('hedef okunamazsa gecis HICBIR SEY yapmaz ve bekleyen kume SIFIR DEGIL BILINMEZDIR', async () => {
    const reader: ChainReader = {
      getBlock: () => Promise.resolve({ number: 100n, timestamp: 1n }),
      readContract: () => Promise.reject(new Error('rpc down')),
      getLogs: () => Promise.resolve([]),
    }
    const writer = fakeWriter({})
    const { summary, emitted } = await pass({ reader, writer, dryRun: false })
    expect(summary.armed).toBe(false)
    expect(summary.pending).toEqual([])
    expect(writer.simulated).toEqual([])
    expect(emitted[0]?.message).toContain('UNKNOWN (not zero)')
  })
})
