import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  candidates,
  runSweepPass,
  type SendOutcome,
  type SimulateOutcome,
  type SweepChain,
  type SweepEvent,
  type TokenSweepState,
} from '../src/sweep/pass'

/**
 * ============================================================================
 *  SUPURME GECISI -- GERCEK BIR DUGUM OLMADAN
 * ============================================================================
 *
 * Bu paketin iddiasi "supurme calisiyor" DEGIL: onu ancak canli zincir
 * soyleyebilir. Buradaki iddia daha dar ve daha olculebilir: **gecis, kararı
 * dogru sirayla ve dogru sayida RPC ile yurutur, ve simulasyon reddettiginde
 * HICBIR SEY GONDERMEZ.**
 *
 * `SweepChain` bir taklit degil bir SAYACTIR: her cagriyi kaydeder, boylece
 * "teklif icin RPC harcanmadi" gibi NEGATIF iddialar da olculebilir. Bu
 * deponun tekrar tekrar odedigi ariza, tam olarak olculmeyen negatif
 * iddialardan cikti.
 */

const TREASURY_TOKEN = '0x1111111111111111111111111111111111111111' as Address
const OTHER_TOKEN = '0x2222222222222222222222222222222222222222' as Address
const CURVE = '0x3333333333333333333333333333333333333333' as Address

const HEAD = 5_000_000n
const NOW = 1_800_000_000
const ONE_USDC = 10n ** 18n

type Calls = {
  head: number
  minSweepWei: number
  isDesignatedKeeper: number
  readToken: Address[]
  quote: Address[]
  simulate: { token: Address; minTokensOut: bigint; deadline: bigint }[]
  send: { token: Address; minTokensOut: bigint }[]
  sleeps: number[]
}

function emptyCalls(): Calls {
  return {
    head: 0,
    minSweepWei: 0,
    isDesignatedKeeper: 0,
    readToken: [],
    quote: [],
    simulate: [],
    send: [],
    sleeps: [],
  }
}

const OK_RECEIPT: SendOutcome = {
  status: 'success',
  blockNumber: HEAD + 1n,
  gasUsed: 210_000n,
  transactionHash: '0xfeed' as Hex,
}

function fakeChain(
  overrides: {
    state?: Partial<TokenSweepState>
    quote?: bigint | null
    simulate?: SimulateOutcome
    designated?: boolean
    readThrows?: Address
  } = {},
): { chain: SweepChain; calls: Calls } {
  const calls = emptyCalls()
  const chain: SweepChain = {
    head() {
      calls.head++
      return Promise.resolve(HEAD)
    },
    // Kesif bu pakette olculmez -- gecis `tokens`i HAZIR alir. Yine de
    // arayuzun bir uyesidir ve bos donmesi kasitli: bir gecis testinin log
    // taramasina bagli olmasi, iki ayri seyi tek bir kirmiziya baglardi.
    accruedTokens() {
      return Promise.resolve([])
    },
    minSweepWei() {
      calls.minSweepWei++
      // 0,05 USDC -- kontrattaki `MIN_SWEEP_WEI`.
      return Promise.resolve(5n * 10n ** 16n)
    },
    isDesignatedKeeper() {
      calls.isDesignatedKeeper++
      return Promise.resolve(overrides.designated ?? true)
    },
    readToken(token) {
      calls.readToken.push(token)
      if (overrides.readThrows === token) {
        return Promise.reject(new Error('curve() reverted'))
      }
      return Promise.resolve({
        token,
        curve: CURVE,
        spendableWei: ONE_USDC,
        permissionless: false,
        graduated: false,
        ...overrides.state,
      })
    },
    quote(state) {
      calls.quote.push(state.token)
      return Promise.resolve(overrides.quote === undefined ? 1_000n : overrides.quote)
    },
    simulate(token, minTokensOut, deadline) {
      calls.simulate.push({ token, minTokensOut, deadline })
      return Promise.resolve(overrides.simulate ?? { ok: true })
    },
    send(token, minTokensOut) {
      calls.send.push({ token, minTokensOut })
      return Promise.resolve('0xfeed' as Hex)
    },
    wait() {
      return Promise.resolve(OK_RECEIPT)
    },
  }
  return { chain, calls }
}

function run(
  chain: SweepChain,
  tokens: readonly Address[],
  extra: Partial<Parameters<typeof runSweepPass>[0]> = {},
  events?: SweepEvent[],
): ReturnType<typeof runSweepPass> {
  const sleeps: number[] = []
  return runSweepPass({
    chain,
    tokens,
    nowSeconds: NOW,
    jitterSeed: () => 0,
    dryRun: false,
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    onEvent: (e) => events?.push(e),
    ...extra,
  })
}

describe('candidates', () => {
  it('KUME BIRIKIMLIDIR ve tekrarlari eler', () => {
    const merged = candidates([TREASURY_TOKEN], [OTHER_TOKEN, TREASURY_TOKEN])
    expect(merged).toEqual([TREASURY_TOKEN, OTHER_TOKEN])
  })

  it('adresleri kucuk harfe indirir -- ayni token IKI kez adaylanamaz', () => {
    const upper = TREASURY_TOKEN.toUpperCase().replace('0X', '0x') as Address
    expect(candidates([TREASURY_TOKEN], [upper])).toHaveLength(1)
  })

  it('EKLEME SIRASINI korur', () => {
    expect(candidates([OTHER_TOKEN], [TREASURY_TOKEN])).toEqual([OTHER_TOKEN, TREASURY_TOKEN])
  })
})

describe('runSweepPass', () => {
  it('okumalari TEK BLOGA sabitler ve tokene bagli OLMAYANI bir kez okur', async () => {
    const { chain, calls } = fakeChain()
    const result = await run(chain, [TREASURY_TOKEN, OTHER_TOKEN])

    expect(result.head).toBe(HEAD)
    expect(calls.head).toBe(1)
    // Iki token, ama esik ve anahtarci kimligi BIRER kez okundu: ikisi de
    // tokene bagli degildir ve token basina okumak Arc'in hiz sinirini
    // gereksizce yerdi.
    expect(calls.minSweepWei).toBe(1)
    expect(calls.isDesignatedKeeper).toBe(1)
  })

  it('ESIK ALTINDA TEKLIF ICIN TEK BIR RPC HARCAMAZ', async () => {
    // Bu, iki asamali kararin TEK olculebilir gerekcesi. Tek asamali bir
    // yazim once teklif alir, sonra esige bakip atlar -- her poll'da, her
    // token icin, bosuna.
    const { chain, calls } = fakeChain({ state: { spendableWei: 4n * 10n ** 16n } })
    const events: SweepEvent[] = []
    const result = await run(chain, [TREASURY_TOKEN], {}, events)

    expect(calls.quote).toEqual([])
    expect(calls.simulate).toEqual([])
    expect(result.summary.skipped['below-threshold']).toBe(1)
    expect(events).toContainEqual({
      kind: 'skip',
      token: TREASURY_TOKEN,
      reason: 'below-threshold',
    })
  })

  it('YETKISIZ ve izinsiz DEGILSE de teklif almaz', async () => {
    const { chain, calls } = fakeChain({
      designated: false,
      state: { permissionless: false },
    })
    const result = await run(chain, [TREASURY_TOKEN])

    expect(calls.quote).toEqual([])
    expect(result.summary.skipped['not-authorised']).toBe(1)
  })

  it('yetkisiz ama IZINSIZ ise supurur -- yedinci gunden sonraki hal', async () => {
    const { chain, calls } = fakeChain({
      designated: false,
      state: { permissionless: true },
    })
    const result = await run(chain, [TREASURY_TOKEN])

    expect(calls.send).toHaveLength(1)
    expect(result.summary.swept).toBe(1)
  })

  it('teklif YOKSA supurme YOK -- `minTokensOut: 0` gonderilmez', async () => {
    // Korumasiz bir supurme, supurmemekten kotudur: sandvic tam olarak
    // oradan gecer.
    const { chain, calls } = fakeChain({ quote: null })
    const result = await run(chain, [TREASURY_TOKEN])

    expect(calls.simulate).toEqual([])
    expect(calls.send).toEqual([])
    expect(result.summary.skipped['no-quote']).toBe(1)
  })

  it('`minTokensOut` teklifin slipaj kadar ALTINDADIR', async () => {
    const { chain, calls } = fakeChain({ quote: 10_000n })
    await run(chain, [TREASURY_TOKEN])

    // Varsayilan politika %1.
    expect(calls.send[0]?.minTokensOut).toBe(9_900n)
    expect(calls.simulate[0]?.minTokensOut).toBe(9_900n)
  })

  it('SIMULASYON REDDEDERSE HICBIR SEY GONDERILMEZ', async () => {
    const { chain, calls } = fakeChain({
      simulate: { ok: false, detail: 'SlippageTooHigh(900, 9900)' },
    })
    const events: SweepEvent[] = []
    const result = await run(chain, [TREASURY_TOKEN], {}, events)

    expect(calls.send).toEqual([])
    expect(result.refused).toBe(1)
    expect(events.some((e) => e.kind === 'simulation-refused')).toBe(true)
    // Karar YINE DE bir supurmeydi: ozet bunu `swept` sayar cunku KARAR
    // odur. Reddedilen simulasyon AYRI bir sayacta durur, ve o sayacin
    // sifirdan buyuk olmasi bir alarm konusudur.
    expect(result.summary.swept).toBe(1)
  })

  it('KURU KOSU simule eder ama GONDERMEZ', async () => {
    const { chain, calls } = fakeChain()
    const events: SweepEvent[] = []
    await run(chain, [TREASURY_TOKEN], { dryRun: true }, events)

    expect(calls.simulate).toHaveLength(1)
    expect(calls.send).toEqual([])
    expect(events.some((e) => e.kind === 'dry-run')).toBe(true)
  })

  it('JITTER SIMULASYONDAN SONRA, GONDERMEDEN ONCE beklenir', async () => {
    const order: string[] = []
    const { chain } = fakeChain()
    const wrapped: SweepChain = {
      ...chain,
      simulate(...args) {
        order.push('simulate')
        return chain.simulate(...args)
      },
      send(...args) {
        order.push('send')
        return chain.send(...args)
      },
    }
    await runSweepPass({
      chain: wrapped,
      tokens: [TREASURY_TOKEN],
      nowSeconds: NOW,
      // Sifir olmayan bir gecikme uretecek tohum.
      jitterSeed: () => 12_345,
      dryRun: false,
      sleep: (ms) => {
        order.push(`sleep:${ms}`)
        return Promise.resolve()
      },
    })

    expect(order).toEqual(['simulate', 'sleep:12345', 'send'])
  })

  it('OKUMASI DUSEN BIR TOKEN gecisi durdurmaz ve SAYILIR', async () => {
    const { chain, calls } = fakeChain({ readThrows: TREASURY_TOKEN })
    const events: SweepEvent[] = []
    const result = await run(chain, [TREASURY_TOKEN, OTHER_TOKEN], {}, events)

    expect(result.unreadable).toBe(1)
    // Ikinci token yine supuruldu.
    expect(calls.send.map((s) => s.token)).toEqual([OTHER_TOKEN])
    expect(events.some((e) => e.kind === 'read-failed')).toBe(true)
  })

  it('GECIS BUTCESI tukendiginde durur ve bunu SOYLER', async () => {
    const { chain, calls } = fakeChain()
    const events: SweepEvent[] = []
    await run(chain, [TREASURY_TOKEN, OTHER_TOKEN], { maxPerPass: 1 }, events)

    expect(calls.send).toHaveLength(1)
    expect(events.some((e) => e.kind === 'budget-exhausted')).toBe(true)
  })

  it('SIFIR bekleyen butce zincire hic gitmez', async () => {
    const { chain, calls } = fakeChain({ state: { spendableWei: 0n } })
    const result = await run(chain, [TREASURY_TOKEN])

    expect(calls.quote).toEqual([])
    expect(result.summary.skipped['nothing-pending']).toBe(1)
  })

  it('makbuz gecisin SONUCUNDA tasinir', async () => {
    const { chain } = fakeChain()
    const result = await run(chain, [TREASURY_TOKEN])

    expect(result.sent).toEqual([{ token: TREASURY_TOKEN, hash: '0xfeed', outcome: OK_RECEIPT }])
  })
})
