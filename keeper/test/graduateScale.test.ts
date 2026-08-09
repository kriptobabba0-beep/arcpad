import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { loadGraduatorConfig } from '../src/graduate/config'
import {
  COMPLETED_EVENT,
  createCompletedWatch,
  DEFAULT_COMPLETED_WATCH_MS,
} from '../src/graduate/completedWatch'
import { runPollLoop } from '../src/graduate/loop'
import {
  type BatchReadCall,
  type ChainReader,
  DEFAULT_CURVE_BATCH_SUBCALLS,
  type HeadBlock,
  type LogQuery,
  type ObservedLog,
  type ReadCall,
  scanCurveStates,
} from '../src/watch/graduationWindow'

const CURVE_A = '0xAAaA000000000000000000000000000000000001' as Address
const CURVE_B = '0xBbbb000000000000000000000000000000000002' as Address
const STRANGER = '0xcCCc000000000000000000000000000000000003' as Address

const BASE_ENV = {
  ARC_RPC_URL: 'http://127.0.0.1:58545',
  ARC_CHAIN_ID: '5042002',
  KEEPER_GRADUATE_FACTORY: '0xfE11Db901168B0B0f7474b72a2e39b3d805b4849',
  KEEPER_GRADUATE_LOCKER: '0x1AfD2eF32C445FAdC95f05Ed237ed4C9dAE9d33F',
  KEEPER_GRADUATE_START_BLOCK: '56016843',
} satisfies NodeJS.ProcessEnv

type Fixture = { complete: boolean; graduated: boolean; quote: bigint }

const HEAD: HeadBlock = { number: 100n, timestamp: 1_786_489_400n }

/**
 * IKI YOLU DA TASIYAN TEK OKUYUCU. Ayni fixture'i hem `readContract` hem
 * `readContractBatch` uzerinden sunar, boylece "toplu yol ile ardisik yol AYNI
 * cevabi verir" iddiasi tek bir gercek kaynaga karsi olculur.
 */
function dualReader(
  curves: Record<string, Fixture>,
  opts?: { batchCalls?: number[][]; shortBy?: number },
): ChainReader & { singles: number; batches: number[] } {
  const state = { singles: 0, batches: [] as number[] }
  const lookup = (address: Address): Fixture => {
    const found = Object.entries(curves).find(
      ([key]) => key.toLowerCase() === address.toLowerCase(),
    )?.[1]
    if (found === undefined) throw new Error(`no fixture for ${address}`)
    return found
  }
  const answer = (address: Address, functionName: string): unknown => {
    const fixture = lookup(address)
    if (functionName === 'complete') return fixture.complete
    if (functionName === 'graduated') return fixture.graduated
    if (functionName === 'realQuoteReserves') return fixture.quote
    throw new Error(`unexpected read ${functionName}`)
  }
  return {
    get singles() {
      return state.singles
    },
    get batches() {
      return state.batches
    },
    getBlock: () => Promise.resolve(HEAD),
    readContract(call: ReadCall): Promise<unknown> {
      state.singles += 1
      return Promise.resolve(answer(call.address, call.functionName))
    },
    getLogs(): Promise<ReadonlyArray<ObservedLog>> {
      return Promise.resolve([])
    },
    readContractBatch(calls: readonly BatchReadCall[]): Promise<unknown[]> {
      state.batches.push(calls.length)
      const values = calls.map((call) => answer(call.address, call.functionName))
      return Promise.resolve(
        opts?.shortBy === undefined ? values : values.slice(0, values.length - opts.shortBy),
      )
    },
  }
}

/** `readContractBatch`i gizler: ESKI yol. */
function sequentialOnly(reader: ChainReader): ChainReader {
  return {
    getBlock: reader.getBlock.bind(reader),
    readContract: reader.readContract.bind(reader),
    getLogs: reader.getLogs.bind(reader),
  }
}

// ---------------------------------------------------------------
// Toplu slot okumasi
// ---------------------------------------------------------------

describe('scanCurveStates -- toplu okuma', () => {
  const curves: Record<string, Fixture> = {
    [CURVE_A]: { complete: true, graduated: false, quote: 12_161_433_369_060_378_713n },
    [CURVE_B]: { complete: false, graduated: false, quote: 7n },
  }

  it('toplu yol ile ardisik yol AYNI durumu uretir', async () => {
    const reader = dualReader(curves)
    const batched = await scanCurveStates(reader, [CURVE_A, CURVE_B], HEAD.number)
    const sequential = await scanCurveStates(sequentialOnly(reader), [CURVE_A, CURVE_B], HEAD.number)
    expect(batched).toEqual(sequential)
    expect(batched[0]?.realQuoteWei).toBe(12_161_433_369_060_378_713n)
    // Bekleyen OLMAYAN curve'un rezervi hala okunmaz: davranis korunur.
    expect(batched[1]?.realQuoteWei).toBeNull()
  })

  it('N curve, 3N degil CEIL(3N/genislik) istek eder', async () => {
    const many: Record<string, Fixture> = {}
    const list: Address[] = []
    for (let i = 0; i < 100; i += 1) {
      const curve = `0x${(0xd0d00000n + BigInt(i)).toString(16).padStart(40, '0')}` as Address
      many[curve] = { complete: false, graduated: false, quote: 0n }
      list.push(curve)
    }
    const reader = dualReader(many)
    await scanCurveStates(reader, list, HEAD.number, { batchSubcalls: 100 })
    // 300 alt cagri / 100 = 3 parca, ve HICBIR tekil `readContract` yok.
    expect(reader.batches).toEqual([100, 100, 100])
    expect(reader.singles).toBe(0)
  })

  it('son parca kisadir ve dogru boyanir', async () => {
    const reader = dualReader(curves)
    await scanCurveStates(reader, [CURVE_A, CURVE_B], HEAD.number, { batchSubcalls: 4 })
    expect(reader.batches).toEqual([4, 2])
  })

  it('`readContractBatch` TASIMAYAN bir okuyucu eski yoldan gecer', async () => {
    const reader = dualReader(curves)
    await scanCurveStates(sequentialOnly(reader), [CURVE_A, CURVE_B], HEAD.number)
    expect(reader.singles).toBe(6)
    expect(reader.batches).toEqual([])
  })

  /**
   * ============ KISA PARCA, SESSIZ KAYMA ============
   *
   * Bu testin tek isi tek bir uzunluk kontroludur. Bir parca istenenden AZ
   * sonuc dondururse sonrasindaki HER curve'un slotlari bir kayar: `complete`,
   * bir onceki curve'un `graduated`ini okur. Sonuc gecerli tiptedir, gecerli
   * gorunur ve TAMAMEN YANLISTIR -- "hatanin siradan bir deger gibi okunmasi"
   * seklinin en sinsi hali, ve bir revert'ten farkli olarak hicbir yerde
   * hata uretmez.
   */
  it('KISA donen bir parca kullanilmaz, FIRLATIR', async () => {
    const reader = dualReader(curves, { shortBy: 1 })
    await expect(scanCurveStates(reader, [CURVE_A, CURVE_B], HEAD.number)).rejects.toThrow(
      /returned 5 results for 6 sub-calls/,
    )
  })

  it('gecersiz bir parca genisligi ADIYLA reddedilir', async () => {
    const reader = dualReader(curves)
    await expect(
      scanCurveStates(reader, [CURVE_A], HEAD.number, { batchSubcalls: 0 }),
    ).rejects.toThrow(/positive integer/)
  })

  it('varsayilan genislik olculen sabittir', () => {
    expect(DEFAULT_CURVE_BATCH_SUBCALLS).toBe(500)
  })

  /**
   * ALT CAGRI ARIZASI CAGIRANA BIR DEGER OLARAK ULASAMAZ. `readContractBatch`
   * `unknown[]` doner -- durum bayragi YOKTUR -- dolayisiyla gercek uygulama
   * (`chainReader.ts`) firlatmak DISINDA bir sey yapamaz. Burada o sozlesmenin
   * cagiran tarafi olculur: firlatan bir parca taramayi durdurur, yarim bir
   * kume uretmez.
   */
  it('bir parca firlatirsa tarama YARIM bir kume dondurmez', async () => {
    const reader = dualReader(curves)
    const throwing: ChainReader = {
      ...reader,
      readContractBatch: () => Promise.reject(new Error(`${CURVE_B}.complete() FAILED`)),
    }
    await expect(scanCurveStates(throwing, [CURVE_A, CURVE_B], HEAD.number)).rejects.toThrow(
      CURVE_B,
    )
  })
})

/**
 * ============ URETIM OKUYUCUSU TOPLU YOLU GERCEKTEN TASIYOR MU ============
 *
 * `readContractBatch` ISTEGE BAGLIDIR, ve o secim sentetik test okuyucularinin
 * calismaya devam etmesi icin dogru. Ama BEDELI SUDUR: eksikligi HICBIR SEYI
 * DUSURMEZ -- `scanCurveStates` sessizce eski 3N cagrilik yola doner, butun
 * testler yesil kalir, ve olculen 100 kat kaybolur. Hicbir sey bagirmaz.
 *
 * Bu test o tek sessiz mutasyonun karsisindaki tek settir: `chainReader.ts`ten
 * `readContractBatch`i silmek buradan DUSER. `viemChainReader`in geri kalani
 * bilerek test edilmez (canli bir RPC ister); olculen sey davranisi degil
 * VARLIGIDIR, cunku yalnizca varligi sessizce kaybolabilir.
 */
describe('uretim okuyucusu', () => {
  it('viemChainReader toplu okuma yolunu TASIR', async () => {
    const { viemChainReader } = await import('../src/chainReader')
    const reader = viemChainReader({} as never)
    expect(typeof reader.readContractBatch).toBe('function')
  })
})

// ---------------------------------------------------------------
// `Completed` kapi zili
// ---------------------------------------------------------------

type LogFixture = { address?: Address }

function ringReader(opts: {
  heads: bigint[]
  logsByCall: LogFixture[][]
  onQuery?: (query: LogQuery) => void
  failLogs?: boolean
}): ChainReader {
  let headIndex = 0
  let callIndex = 0
  return {
    getBlock(): Promise<HeadBlock> {
      const number = opts.heads[Math.min(headIndex, opts.heads.length - 1)] ?? 0n
      headIndex += 1
      return Promise.resolve({ number, timestamp: 1n })
    },
    readContract: () => Promise.resolve(undefined),
    getLogs(query: LogQuery): Promise<ReadonlyArray<ObservedLog>> {
      opts.onQuery?.(query)
      if (opts.failLogs === true) return Promise.reject(new Error('rate limit exceeded'))
      const batch = opts.logsByCall[callIndex] ?? []
      callIndex += 1
      return Promise.resolve(batch as ReadonlyArray<ObservedLog>)
    },
  }
}

describe('Completed kapi zili', () => {
  it('ILK kontrol zil calmaz -- yalnizca imleci kurar', async () => {
    const watch = createCompletedWatch({
      client: ringReader({ heads: [100n], logsByCall: [[{ address: CURVE_A }]] }),
      knownCurves: () => [CURVE_A],
    })
    expect(await watch.check()).toEqual({ rang: false })
    expect(watch.lastSeenBlock()).toBe(100n)
  })

  it('BILINEN bir curve `Completed` yayinca calar', async () => {
    const watch = createCompletedWatch({
      client: ringReader({ heads: [100n, 101n], logsByCall: [[{ address: CURVE_A }]] }),
      knownCurves: () => [CURVE_A, CURVE_B],
    })
    await watch.check()
    const ring = await watch.check()
    expect(ring.rang).toBe(true)
    if (ring.rang) {
      expect(ring.curves).toEqual([CURVE_A])
      expect(ring.strangers).toEqual([])
    }
  })

  /**
   * YANLIS ZIL ZARARSIZ, KACIRILMIS ZIL GECIKMEDIR. Henuz taranmamis bir
   * curve (ya da imzayi paylasan yabanci bir kontrat) da zili calar; bedeli,
   * kapilari degismemis idempotent bir gecisin ERKEN kosmasidir, ve sikligi
   * `intervalMs` ile UST SINIRLIDIR.
   */
  it('BILINMEYEN bir adres de calar, ama ADIYLA raporlanir', async () => {
    const rings: string[] = []
    const watch = createCompletedWatch({
      client: ringReader({ heads: [100n, 101n], logsByCall: [[{ address: STRANGER }]] }),
      knownCurves: () => [CURVE_A],
      onRing: (detail) => rings.push(detail),
    })
    await watch.check()
    const ring = await watch.check()
    expect(ring.rang).toBe(true)
    if (ring.rang) expect(ring.strangers).toEqual([STRANGER])
    expect(rings[0]).toContain(STRANGER)
    expect(rings[0]).toContain('does not know yet')
  })

  it('log YOKSA calmaz', async () => {
    const watch = createCompletedWatch({
      client: ringReader({ heads: [100n, 101n], logsByCall: [[]] }),
      knownCurves: () => [CURVE_A],
    })
    await watch.check()
    expect(await watch.check()).toEqual({ rang: false })
  })

  it('sorgu ADRES FILTRESI TASIMAZ ve topic0 iledir', async () => {
    const queries: LogQuery[] = []
    const watch = createCompletedWatch({
      client: ringReader({
        heads: [100n, 101n],
        logsByCall: [[]],
        onQuery: (query) => queries.push(query),
      }),
      knownCurves: () => [CURVE_A],
    })
    await watch.check()
    await watch.check()
    expect(queries).toHaveLength(1)
    expect(queries[0]?.address).toBeUndefined()
    expect(queries[0]?.events).toEqual([COMPLETED_EVENT])
    expect(queries[0]?.fromBlock).toBe(101n)
  })

  /**
   * ZIL BIR OPTIMIZASYONDUR; EMNIYET AGI ONA BAGLI OLAMAZ. Bir `eth_getLogs`
   * arizasi FIRLATMAZ, cunku firlatsaydi dongunun beklemesi -- ve dolayisiyla
   * BIR SONRAKI GECIS -- bir optimizasyonun arizasina bagli olurdu.
   */
  it('log okumasi DUSERSE firlatmaz, RAPOR EDER', async () => {
    const errors: string[] = []
    const watch = createCompletedWatch({
      client: ringReader({ heads: [100n, 101n], logsByCall: [], failLogs: true }),
      knownCurves: () => [CURVE_A],
      onError: (detail) => errors.push(detail),
    })
    await watch.check()
    expect(await watch.check()).toEqual({ rang: false })
    expect(errors[0]).toContain('completed-watch-failed')
    expect(errors[0]).toContain('the poll is the backstop and it is untouched')
  })

  /**
   * ADRESSIZ BIR LOG SESSIZCE ATLANMAZ. `Completed`in indeksli argumani
   * TOKEN'dir, curve degil; `log.address` curve'u tanimlayan TEK alandir.
   * Onu atlamak, zilin hic calmamasi ve sebebinin hicbir yerde yazmamasi
   * demekti.
   */
  it('ADRESSIZ bir log sessizce atlanmaz -- hata olarak raporlanir', async () => {
    const errors: string[] = []
    const watch = createCompletedWatch({
      client: ringReader({ heads: [100n, 101n], logsByCall: [[{}]] }),
      knownCurves: () => [CURVE_A],
      onError: (detail) => errors.push(detail),
    })
    await watch.check()
    expect(await watch.check()).toEqual({ rang: false })
    expect(errors[0]).toContain('without an emitting address')
  })

  it('geriye bakis SINIRLIDIR -- uzun bir kesintiden sonra devasa bir sorgu atilmaz', async () => {
    const queries: LogQuery[] = []
    const watch = createCompletedWatch({
      client: ringReader({
        heads: [100n, 1_000_000n],
        logsByCall: [[]],
        onQuery: (query) => queries.push(query),
      }),
      knownCurves: () => [CURVE_A],
    })
    await watch.check()
    await watch.check()
    expect(queries[0]?.fromBlock).toBe(1_000_000n - 200n)
    expect(queries[0]?.toBlock).toBe(1_000_000n)
  })

  it('varsayilan aralik izleyicinin bugunku yukunun ALTINDADIR', () => {
    expect(DEFAULT_COMPLETED_WATCH_MS).toBe(2_000)
  })
})

// ---------------------------------------------------------------
// `waitOrRing` ve dongu baglantisi
// ---------------------------------------------------------------

describe('dongu, zil calinca ERKEN uyanir', () => {
  it('zil yoksa araligi doldurur', async () => {
    let clock = 0
    const watch = createCompletedWatch(
      {
        client: ringReader({ heads: [1n, 2n, 3n, 4n, 5n], logsByCall: [[], [], [], []] }),
        knownCurves: () => [CURVE_A],
      },
      {
        intervalMs: 1_000,
        now: () => clock,
        sleep: (ms) => {
          clock += ms
          return Promise.resolve()
        },
      },
    )
    expect(await watch.waitOrRing(3_000)).toBe('interval')
    expect(clock).toBe(3_000)
  })

  it('zil calarsa aralik DOLMADAN doner', async () => {
    let clock = 0
    const watch = createCompletedWatch(
      {
        client: ringReader({
          heads: [1n, 2n, 3n],
          logsByCall: [[{ address: CURVE_A }]],
        }),
        knownCurves: () => [CURVE_A],
      },
      {
        intervalMs: 1_000,
        now: () => clock,
        sleep: (ms) => {
          clock += ms
          return Promise.resolve()
        },
      },
    )
    // IMLECI KURAN ILK KONTROL, olcumun DISINDA yapilir. Zil "ben bakarken
    // OLDU" der; acilistaki ilk kontrolun zil calmamasi tasarimdir (asagidaki
    // teste bkz.) ve onu burada olcmek, kazanilan gecikmeyi bir aralik fazla
    // gosterirdi.
    await watch.check()
    expect(await watch.waitOrRing(15_000)).toBe('doorbell')
    expect(clock).toBe(1_000)
  })

  /**
   * ZILIN ILK ARALIGI BEDAVA DEGILDIR, VE BU KAYDA GECER: acilistan sonraki
   * ilk `Completed` bir aralik gec yakalanir, cunku ilk kontrol yalnizca
   * imleci kurar. Zararsizdir -- acilistaki ILK OLAGAN GECIS zaten butun
   * slotlari okur, yani o pencerede tamamlanmis her curve slottan bulunur --
   * ama olculmemis birakilirsa "zil neden bir tur gec caldi" sorusunun cevabi
   * hicbir yerde olmazdi.
   */
  it('acilistan sonraki ILK tur imleci kurmaya gider', async () => {
    let clock = 0
    const watch = createCompletedWatch(
      {
        client: ringReader({
          heads: [1n, 2n, 3n],
          logsByCall: [[{ address: CURVE_A }]],
        }),
        knownCurves: () => [CURVE_A],
      },
      {
        intervalMs: 1_000,
        now: () => clock,
        sleep: (ms) => {
          clock += ms
          return Promise.resolve()
        },
      },
    )
    expect(await watch.waitOrRing(15_000)).toBe('doorbell')
    expect(clock).toBe(2_000)
  })

  it('`waitBeforeNextPass` dongude UYKUNUN yerine gecer ve gecisi erken kosar', async () => {
    const passes: number[] = []
    const wakes: string[] = []
    let count = 0
    await runPollLoop({
      pass: () => {
        passes.push(count)
        return Promise.resolve()
      },
      stopped: () => count >= 3,
      pollIntervalMs: 15_000,
      onWake: (reason) => wakes.push(reason),
      waitBeforeNextPass: () => {
        count += 1
        return Promise.resolve('doorbell')
      },
      schedule: (fn) => fn(),
    })
    expect(passes).toHaveLength(3)
    expect(wakes).toEqual(['doorbell', 'doorbell', 'doorbell'])
  })

  /**
   * BEKLEYICI DUSERSE DONGU DUSMEZ. Aksi halde, gecikmeyi kisaltmak icin
   * eklenen sey, keeper'i tamamen durduran sey olurdu.
   */
  it('`waitBeforeNextPass` REDDEDERSE dongu olagan araliga geri duser', async () => {
    const wakes: string[] = []
    const scheduled: number[] = []
    let count = 0
    await runPollLoop({
      pass: () => {
        count += 1
        return Promise.resolve()
      },
      stopped: () => count >= 2,
      pollIntervalMs: 15_000,
      onWake: (reason) => wakes.push(reason),
      waitBeforeNextPass: () => Promise.reject(new Error('rpc down')),
      schedule: (fn, ms) => {
        scheduled.push(ms)
        fn()
      },
    })
    expect(count).toBe(2)
    expect(wakes).toEqual(['interval'])
    expect(scheduled).toEqual([15_000])
  })
})

// ---------------------------------------------------------------
// Yapilandirma
// ---------------------------------------------------------------

describe('olcek yapilandirmasi', () => {
  it('varsayilanlar olculen sabitlerdir', () => {
    const config = loadGraduatorConfig({ ...BASE_ENV })
    expect(config.curveBatchSize).toBe(DEFAULT_CURVE_BATCH_SUBCALLS)
    expect(config.completedWatchMs).toBe(DEFAULT_COMPLETED_WATCH_MS)
  })

  it('KEEPER_CURVE_BATCH_SIZE indirilebilir', () => {
    expect(loadGraduatorConfig({ ...BASE_ENV, KEEPER_CURVE_BATCH_SIZE: '120' }).curveBatchSize).toBe(
      120,
    )
  })

  for (const bad of ['0', '-1', '1.5', 'lots']) {
    it(`KEEPER_CURVE_BATCH_SIZE="${bad}" reddedilir`, () => {
      expect(() => loadGraduatorConfig({ ...BASE_ENV, KEEPER_CURVE_BATCH_SIZE: bad })).toThrow(
        /positive integer/,
      )
    })
  }

  it('KEEPER_GRADUATE_COMPLETED_WATCH_MS=0 zili KAPATIR ve bu gecerli bir yapilandirmadir', () => {
    expect(
      loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_COMPLETED_WATCH_MS: '0' })
        .completedWatchMs,
    ).toBe(0)
  })

  for (const bad of ['-1', '2.5', 'soon']) {
    it(`KEEPER_GRADUATE_COMPLETED_WATCH_MS="${bad}" reddedilir`, () => {
      expect(() =>
        loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_COMPLETED_WATCH_MS: bad }),
      ).toThrow(/non-negative integer/)
    })
  }

  /**
   * POLL ARALIGINDAN BUYUK BIR ZIL, HICBIR GECIKME SATIN ALMADAN EK ISTEK
   * HARCAR: poll zaten once atesler. Sessizce kabul etmek, "acik ama ise
   * yaramayan" bir ozellik uretirdi -- bu depoda tekrar eden sekil.
   */
  it('poll araligina ESIT ya da ONDAN BUYUK bir zil reddedilir', () => {
    expect(() =>
      loadGraduatorConfig({
        ...BASE_ENV,
        KEEPER_GRADUATE_POLL_INTERVAL_MS: '5000',
        KEEPER_GRADUATE_COMPLETED_WATCH_MS: '5000',
      }),
    ).toThrow(/buys NO latency/)
  })

  it('poll araliginin ALTINDA kalan bir zil kabul edilir', () => {
    expect(
      loadGraduatorConfig({
        ...BASE_ENV,
        KEEPER_GRADUATE_POLL_INTERVAL_MS: '5000',
        KEEPER_GRADUATE_COMPLETED_WATCH_MS: '1000',
      }).completedWatchMs,
    ).toBe(1_000)
  })
})
