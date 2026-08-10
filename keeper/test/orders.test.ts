import type { CurveProfile, CurveState, FeeBps } from '@arcpad/shared'
import { asTok, asWei, planBuyExactQuoteIn, planSellExactTokensIn, netProceedsOf } from '@arcpad/shared'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_ORDERS_PER_PASS,
  type OrderStore,
  type PassOrder,
  runOrderPass,
} from '../src/orders/pass'
import {
  fitsPoll,
  IMMUTABLE_SLOTS_PER_CURVE,
  MUTABLE_SLOTS_PER_CURVE,
  scanCost,
  shapeOf,
} from '../src/orders/scan'
import { poolTriggerVerdict, triggerVerdict } from '../src/orders/trigger'
import type { BatchReadCall, ChainReader, HeadBlock } from '../src/watch/graduationWindow'

/**
 * ==========================================================================
 *  EMIR GECISI -- VE HANGI IDDIA HANGI SEVIYEDE OLCULUYOR
 * ==========================================================================
 *
 * BURADA OLCULMEYEN SEY, ONCE SOYLENMELI: keeper'in bir emri DOLDURAMADIGI
 * iddiasi bu dosyada DEGIL, `test/localchain/custodyProof.ts`te olculuyor --
 * canli kontratlara karsi, bir Arc fork'unda, 21/21. Bir birim testi o soruyu
 * cevaplayamaz cunku cevabi zincirin bytecode'unda.
 *
 * BURADA OLCULEN SEY: tetik predikatinin ZINCIRIN KENDI KORUMASININ BIREBIR
 * AYNISI oldugu, maliyet modelinin gercekten yayilan istekleri sayd??igi, ve
 * gecisin okuma sirasinin cozumleme sirasiyla AYNI oldugu.
 */

const PROFILE: CurveProfile = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292n * 10n ** 15n,
  saleSupply: 793_100_000n * 10n ** 18n,
}
const FEES: FeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n }
const CREATOR = '0x00000000000000000000000000000000000c4ea7'

function freshCurve(overrides: Partial<CurveState> = {}): CurveState {
  return {
    virtualQuoteReserves: PROFILE.virtualQuoteReserves,
    virtualTokenReserves: PROFILE.virtualTokenReserves,
    realTokenReserves: asTok(PROFILE.saleSupply),
    realQuoteReserves: asWei(0n),
    complete: false,
    creator: CREATOR,
    ...overrides,
  }
}

const ONE_USDC = 10n ** 18n

// ---------------------------------------------------------------
describe('tetik predikati ZINCIRIN KORUMASININ AYNISIDIR', () => {
  /**
   * ============ TASIYICI IDDIA, VE DIFERANSIYEL OLARAK OLCULUYOR ============
   *
   * `buyExactQuoteIn(minTokensOut)` zincirde su tek satirla korunur:
   *     `if (tokensOut < minTokensOut) revert SlippageExceeded();`
   * Burada olculen sey, `triggerVerdict`in TAM OLARAK bu predikat oldugudur --
   * "yaklasik", "esik", ya da "fiyat karsilastirmasi" DEGIL. Referans, ayni
   * plani KENDISI kuran bagimsiz bir hesaptir; ikisi 200 esikte de aynidir.
   */
  it('ALIM: karar, planlayicinin `tokens >= minOut`u ile BIREBIR ayni', () => {
    const state = freshCurve()
    const plan = planBuyExactQuoteIn(state, PROFILE, FEES, 5n * ONE_USDC, 0)
    const exact = plan.tokens

    for (const delta of [-2n, -1n, 0n, 1n, 2n]) {
      const minOut = exact + delta
      const verdict = triggerVerdict(
        { isBuy: true, amount: 5n * ONE_USDC, minOut, held: null },
        state,
        PROFILE,
        FEES,
      )
      // Zincirin kurali `<`tir, yani TAM ESITLIK GECER.
      expect(verdict.kind, `delta=${delta}`).toBe(delta <= 0n ? 'triggered' : 'notYet')
    }
  })

  it('SATIM: karar, `netProceedsOf(plan) >= minOut` ile BIREBIR ayni', () => {
    // Curve'de once bir miktar quote birikmis olmali ki satis mumkun olsun.
    const bought = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 50n * ONE_USDC, 0)
    const state = freshCurve({
      virtualQuoteReserves: PROFILE.virtualQuoteReserves + bought.curveAmount,
      virtualTokenReserves: PROFILE.virtualTokenReserves - bought.tokens,
      realTokenReserves: asTok(PROFILE.saleSupply - bought.tokens),
      realQuoteReserves: asWei(bought.curveAmount),
    })
    const tokensIn = bought.tokens
    const exact = netProceedsOf(planSellExactTokensIn(state, PROFILE, FEES, tokensIn, 0))

    for (const delta of [-1n, 0n, 1n]) {
      const verdict = triggerVerdict(
        { isBuy: false, amount: tokensIn, minOut: exact + delta, held: null },
        state,
        PROFILE,
        FEES,
      )
      expect(verdict.kind, `delta=${delta}`).toBe(delta <= 0n ? 'triggered' : 'notYet')
    }
  })

  /**
   * ============ OLCULMUS ESDEGERLIK: `slipBps` KARARI DEGISTIRMEZ ============
   *
   * Bir mutasyon turu `slipBps`i 0'dan 100'e cevirdi ve mutant HAYATTA KALDI.
   * Ilk tepkim testi guclendirmekti; dogru tepki OLCMEKTI, ve olcum sudur:
   * `slipBps` YALNIZCA `plan.args`i (zincire gidecek slipaj sinirini)
   * sekillendirir, `plan.tokens`i DEGIL. Bu predikat `plan.tokens` okur, yani
   * mutant GERCEKTEN ESDEGERDIR.
   *
   * Bu test o esdegerligi SABITLER. Degeri ileriye donuktur: biri bir gun
   * `plan.args[0]`i okumaya baslarsa -- ki o zaman `slipBps` KARARI DEGISTIRIR
   * -- bu satir kirilir ve degisiklik sessiz kalmaz.
   */
  it('ESDEGERLIK: `slipBps` planin SONUCUNU degistirmez, yalnizca SINIRINI', () => {
    const state = freshCurve()
    const zero = planBuyExactQuoteIn(state, PROFILE, FEES, ONE_USDC, 0)
    const wide = planBuyExactQuoteIn(state, PROFILE, FEES, ONE_USDC, 100)
    expect(wide.tokens).toBe(zero.tokens)
    // ...ve ZINCIRE GIDEN sinir GERCEKTEN degisir, yani karsilastirma vakum degil.
    expect(wide.args[0]).not.toBe(zero.args[0])
  })

  it('tam esitlik TETIKLER', () => {
    const state = freshCurve()
    const exact = planBuyExactQuoteIn(state, PROFILE, FEES, ONE_USDC, 0).tokens
    expect(
      triggerVerdict({ isBuy: true, amount: ONE_USDC, minOut: exact, held: null }, state, PROFILE, FEES)
        .kind,
    ).toBe('triggered')
    // Kontrol: 1 birim daha istemek tetiklemez, yani karsilastirma GERCEKTEN
    // bu sayinin uzerinde calisiyor.
    expect(
      triggerVerdict({ isBuy: true, amount: ONE_USDC, minOut: exact + 1n, held: null }, state, PROFILE, FEES)
        .kind,
    ).toBe('notYet')
  })

  it('KAPALI curve: `stalled`, ve TERMINAL DEGIL', () => {
    const verdict = triggerVerdict(
      { isBuy: true, amount: ONE_USDC, minOut: 1n, held: null },
      freshCurve({ complete: true }),
      PROFILE,
      FEES,
    )
    expect(verdict).toEqual({ kind: 'stalled', reason: 'completeNotGraduated' })
  })

  it('FONU YETMEYEN emir TETIKLENMEZ -- ve iptal de EDILMEZ', () => {
    const state = freshCurve()
    const verdict = triggerVerdict(
      { isBuy: true, amount: 5n * ONE_USDC, minOut: 1n, held: 4n * ONE_USDC },
      state,
      PROFILE,
      FEES,
    )
    expect(verdict).toEqual({ kind: 'underfunded', held: 4n * ONE_USDC, needed: 5n * ONE_USDC })
    // KONTROL: ayni emir, yeterli bakiye ile, tetiklenir. Yani red bakiyeden
    // geliyor, fiyattan degil.
    expect(
      triggerVerdict(
        { isBuy: true, amount: 5n * ONE_USDC, minOut: 1n, held: 5n * ONE_USDC },
        state,
        PROFILE,
        FEES,
      ).kind,
    ).toBe('triggered')
  })

  it('OLCULEMEYEN bakiye bir TETIKLEME SEBEBI DEGILDIR -- ama tetiklemeyi de engellemez', () => {
    // `null` "bilmiyoruz" demektir. Karar fiyata gore verilir; gecis kodu
    // `null`i ancak bir okuma yapilmadiginda uretir ve o zaman zaten emir
    // degerlendirilmemistir. Burada olculen sey: `null` bir `underfunded`
    // uretmez (aksi halde her sentetik test yanlis yoldan gecerdi).
    const verdict = triggerVerdict(
      { isBuy: true, amount: ONE_USDC, minOut: 1n, held: null },
      freshCurve(),
      PROFILE,
      FEES,
    )
    expect(verdict.kind).toBe('triggered')
  })

  it('planlayicinin REDDI yutulmaz, `unfillable` olarak siniflanir', () => {
    // Bir wei'lik satis: iki ucret parcasi da tavana yuvarlandigi icin
    // hasilati yutar -> `ProceedsTooSmall`.
    const verdict = triggerVerdict(
      { isBuy: false, amount: 1n, minOut: 1n, held: null },
      freshCurve(),
      PROFILE,
      FEES,
    )
    expect(verdict).toEqual({ kind: 'unfillable', errorName: 'ProceedsTooSmall' })
  })

  it('HAVUZ: karar kotanin dondugu sayidan gelir, yerel bir AMM hesabindan DEGIL', async () => {
    const quote = async (): Promise<{ ok: true; amountOut: bigint }> => ({
      ok: true,
      amountOut: 1_000n,
    })
    expect(
      (await poolTriggerVerdict({ isBuy: true, amount: 1n, minOut: 1_000n, held: null }, '0xt', quote))
        .kind,
    ).toBe('triggered')
    expect(
      (await poolTriggerVerdict({ isBuy: true, amount: 1n, minOut: 1_001n, held: null }, '0xt', quote))
        .kind,
    ).toBe('notYet')
  })

  it('HAVUZ: kota basarisiz olursa emir `unfillable`, sessizce tetiklenmez', async () => {
    const quote = async (): Promise<{ ok: false; reason: string }> => ({
      ok: false,
      reason: 'PoolNotInitialized',
    })
    expect(
      await poolTriggerVerdict({ isBuy: true, amount: 1n, minOut: 1n, held: null }, '0xt', quote),
    ).toEqual({ kind: 'unfillable', errorName: 'PoolNotInitialized' })
  })
})

// ---------------------------------------------------------------
describe('maliyet modeli -- N emir bir geciste ne tutar', () => {
  const order = (n: number, isBuy: boolean, curve: string, owner: string) =>
    ({ token: `0xt${n % 7}`, curve, ownerAddr: owner, isBuy, venue: 'curve' }) as const

  it('alim okumalari SAHIP basina tekillesir, token basina DEGIL', () => {
    // Ayni sahip, uc farkli token/curve. Fonlama okumasi BIR tanedir.
    const shape = shapeOf([
      { token: '0xa', curve: '0xc1', ownerAddr: '0xowner', isBuy: true, venue: 'curve' },
      { token: '0xb', curve: '0xc2', ownerAddr: '0xowner', isBuy: true, venue: 'curve' },
      { token: '0xc', curve: '0xc3', ownerAddr: '0xowner', isBuy: true, venue: 'curve' },
    ])
    expect(shape.fundingReads).toBe(1)
    expect(shape.curves).toBe(3)
  })

  it('satim okumalari (token, sahip) basinadir', () => {
    const shape = shapeOf([
      { token: '0xa', curve: '0xc1', ownerAddr: '0xowner', isBuy: false, venue: 'curve' },
      { token: '0xb', curve: '0xc2', ownerAddr: '0xowner', isBuy: false, venue: 'curve' },
      { token: '0xa', curve: '0xc1', ownerAddr: '0xowner', isBuy: false, venue: 'curve' },
    ])
    expect(shape.fundingReads).toBe(2)
  })

  /**
   * ============ RAPOR EDILEN SAYI, VE NASIL CIKTIGI ============
   *
   * 1000 emir, 200 farkli token/curve, 300 farkli sahip (hepsi alim):
   *   6 x 200 curve slotu        = 1200
   * + 3 x 200 immutable (SOGUK)  =  600
   * + 300 fonlama okumasi        =  300
   *                              -------
   *                                2100 alt cagri  -> ceil(2100/500) = 5 eth_call
   *
   * SICAK gecislerde (immutable'lar onbellekte) 1500 -> 3 eth_call.
   */
  it('1000 emir / 200 curve / 300 sahip: SOGUK 5, SICAK 3 `eth_call`', () => {
    const shape = {
      curveOrders: 1_000,
      curves: 200,
      fundingReads: 300,
      coldCurves: 200,
      poolOrders: 0,
    }
    const cold = scanCost(shape)
    expect(cold.subcalls).toBe(2_100)
    expect(cold.batchedCalls).toBe(5)
    expect(cold.rpcObjects).toBe(6)

    const warm = scanCost({ ...shape, coldCurves: 0 })
    expect(warm.subcalls).toBe(1_500)
    expect(warm.batchedCalls).toBe(3)
  })

  it('SICAK 1000-emirlik gecis 5 sn poll araligina 14 kat marjla sigar', () => {
    const warm = scanCost({
      curveOrders: 1_000,
      curves: 200,
      fundingReads: 300,
      coldCurves: 0,
      poolOrders: 0,
    })
    const fit = fitsPoll(warm, 5_000)
    expect(fit.estimatedMs).toBe(351) // 3 x 117 ms, olculmus sabit
    expect(fit.fits).toBe(true)
    expect(Math.floor(fit.headroom)).toBe(14)
  })

  it('HAVUZ emirleri BUYUME SINIFINI degistirir -- ve model bunu gosterir', () => {
    // Ayni 1000 emir, ama havuzda: her biri kendi `eth_call`i.
    const pooled = scanCost({
      curveOrders: 0,
      curves: 0,
      fundingReads: 0,
      coldCurves: 0,
      poolOrders: 1_000,
    })
    expect(pooled.batchedCalls).toBe(0)
    expect(pooled.poolCalls).toBe(1_000)
    expect(pooled.rpcObjects).toBe(1_001)
    // 5 saniyelik bir poll'a SIGMAZ, ve bunu soylemesi gerekir.
    expect(fitsPoll(pooled, 5_000).fits).toBe(false)
  })

  it('sabitler kaynagiyla ayni: 6 mutable, 3 immutable', () => {
    expect(MUTABLE_SLOTS_PER_CURVE).toBe(6)
    expect(IMMUTABLE_SLOTS_PER_CURVE).toBe(3)
    const one = scanCost({ curveOrders: 1, curves: 1, fundingReads: 1, coldCurves: 1, poolOrders: 0 })
    expect(one.subcalls).toBe(MUTABLE_SLOTS_PER_CURVE + IMMUTABLE_SLOTS_PER_CURVE + 1)
  })

  it('parca genisligi gecersizse FIRLATIR -- sessizce bir varsayilana dusmez', () => {
    expect(() => scanCost({ curveOrders: 0, curves: 0, fundingReads: 0, coldCurves: 0, poolOrders: 0 }, 0)).toThrow(
      /positive integer/,
    )
  })

  it('bin emirlik sentetik kume, gercek tekillestirme ile', () => {
    const orders = Array.from({ length: 1_000 }, (_, i) =>
      order(i, true, `0xc${i % 200}`, `0xo${i % 300}`),
    )
    const shape = shapeOf(orders)
    expect(shape.curves).toBe(200)
    expect(shape.fundingReads).toBe(300)
    expect(scanCost(shape).batchedCalls).toBe(5)
  })
})

// ---------------------------------------------------------------
describe('gecis', () => {
  const CURVE = '0x00000000000000000000000000000000000c0001'
  const TOKEN = '0x0000000000000000000000000000000000007001'
  const OWNER = '0x00000000000000000000000000000000000a11ce'

  function passOrder(overrides: Partial<PassOrder> = {}): PassOrder {
    return {
      orderSeq: 1n,
      token: TOKEN,
      ownerAddr: OWNER,
      isBuy: true,
      amount: ONE_USDC,
      minOut: 1n,
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      status: 'open',
      ...overrides,
    }
  }

  /**
   * SENTETIK OKUYUCU. Alt cagrilari ADIYLA cevaplar, yani gecisin OKUMA
   * SIRASI ile COZUMLEME SIRASI ayrisirsa test bunu gorur -- bu tam olarak
   * `scanCurveStates`in "kisa parca her seyi bir kaydirir" arizasinin emir
   * tarafindaki karsiligi.
   */
  function reader(
    opts: {
      complete?: boolean
      graduated?: boolean
      nativeBalance?: bigint
      tokenBalance?: bigint
      blockNumber?: bigint
      timestamp?: bigint
    } = {},
  ): ChainReader & { batches: number } {
    const answer = (call: BatchReadCall): unknown => {
      switch (call.functionName) {
        case 'complete':
          return opts.complete ?? false
        case 'graduated':
          return opts.graduated ?? false
        case 'virtualQuoteReserves':
          return PROFILE.virtualQuoteReserves
        case 'virtualTokenReserves':
          return PROFILE.virtualTokenReserves
        case 'realTokenReserves':
          return PROFILE.saleSupply
        case 'realQuoteReserves':
          return 0n
        case 'creator':
          return CREATOR
        case 'PROTOCOL_FEE_BPS':
          return 95n
        case 'CREATOR_FEE_BPS':
          return 30n
        case 'getEthBalance':
          return opts.nativeBalance ?? 1_000n * ONE_USDC
        case 'balanceOf':
          return opts.tokenBalance ?? 1_000n * ONE_USDC
        /* c8 ignore next 2 */
        default:
          throw new Error(`unexpected sub-call ${call.functionName}`)
      }
    }
    const self = {
      batches: 0,
      getBlock: async (): Promise<HeadBlock> => ({
        number: opts.blockNumber ?? 56_199_900n,
        timestamp: opts.timestamp ?? 1_786_000_000n,
      }),
      readContract: async (): Promise<unknown> => {
        throw new Error('the order pass must not read one call at a time')
      },
      getLogs: async () => [],
      readContractBatch: async (calls: readonly BatchReadCall[]): Promise<unknown[]> => {
        self.batches += 1
        return calls.map(answer)
      },
    }
    return self
  }

  function store(orders: readonly PassOrder[]): OrderStore & {
    triggered: bigint[]
    expiredAt: Date | null
  } {
    const state = {
      triggered: [] as bigint[],
      expiredAt: null as Date | null,
      listLive: async () => orders,
      markTriggered: async (orderSeq: bigint): Promise<boolean> => {
        state.triggered.push(orderSeq)
        return true
      },
      expireDue: async (asOf: Date): Promise<readonly bigint[]> => {
        state.expiredAt = asOf
        return []
      },
    }
    return state
  }

  const curveOf = async (): Promise<string> => CURVE

  it('tetiklenen emir isaretlenir, ve BLOK gecisin blogudur', async () => {
    const s = store([passOrder()])
    const summary = await runOrderPass({
      client: reader(),
      store: s,
      curveOf,
      profile: PROFILE,
    })
    expect(summary.triggered).toEqual([1n])
    expect(s.triggered).toEqual([1n])
    expect(summary.blockNumber).toBe(56_199_900n)
    expect(summary.verdicts.triggered).toBe(1)
  })

  it('fiyat yetmiyorsa isaretlenmez', async () => {
    const s = store([passOrder({ minOut: 10n ** 30n })])
    const summary = await runOrderPass({ client: reader(), store: s, curveOf, profile: PROFILE })
    expect(summary.triggered).toEqual([])
    expect(s.triggered).toEqual([])
    expect(summary.verdicts.notYet).toBe(1)
  })

  it('ZATEN tetiklenmis bir emre tekrar UPDATE atilmaz', async () => {
    const s = store([passOrder({ status: 'triggered' })])
    const summary = await runOrderPass({ client: reader(), store: s, curveOf, profile: PROFILE })
    expect(s.triggered).toEqual([])
    // Yine de SAYILIR: gecis onu degerlendirdi ve hala tetiklenebilir buldu.
    expect(summary.verdicts.triggered).toBe(1)
  })

  it('SURE ASIMI ZINCIRIN SAATINE gore yapilir, sunucununkine gore DEGIL', async () => {
    const s = store([])
    await runOrderPass({
      client: reader({ timestamp: 1_786_499_999n }),
      store: s,
      curveOf,
      profile: PROFILE,
    })
    expect(s.expiredAt).toEqual(new Date(1_786_499_999 * 1000))
  })

  it('fonu yetmeyen emir tetiklenmez ve SILINMEZ', async () => {
    const s = store([passOrder({ amount: 5_000n * ONE_USDC })])
    const summary = await runOrderPass({
      client: reader({ nativeBalance: ONE_USDC }),
      store: s,
      curveOf,
      profile: PROFILE,
    })
    expect(summary.verdicts.underfunded).toBe(1)
    expect(s.triggered).toEqual([])
    expect(summary.expired).toEqual([])
  })

  it('SATIM emri TOKEN bakiyesine bakar, native bakiyeye DEGIL', async () => {
    // Native bakiye bol, token bakiyesi yok: emir tetiklenmemeli. Yanlis
    // varlik okunsaydi bu test yesil kalirdi, bu yuzden ikisi AYRI ayarlanir.
    const s = store([passOrder({ isBuy: false, amount: 1_000n * ONE_USDC, minOut: 1n })])
    const summary = await runOrderPass({
      client: reader({ nativeBalance: 10n ** 30n, tokenBalance: 1n }),
      store: s,
      curveOf,
      profile: PROFILE,
    })
    expect(summary.verdicts.underfunded).toBe(1)
  })

  it('KONTROL: ayni satim emri, token bakiyesi yeterken tetiklenir', async () => {
    const s = store([passOrder({ isBuy: false, amount: 1_000n * ONE_USDC, minOut: 1n })])
    const summary = await runOrderPass({
      client: reader({ nativeBalance: 0n, tokenBalance: 10n ** 30n }),
      store: s,
      curveOf,
      profile: PROFILE,
    })
    expect(summary.verdicts.triggered).toBe(1)
  })

  it('KAPALI curve: emir `stalled`, ve KAPATILMAZ', async () => {
    const s = store([passOrder()])
    const summary = await runOrderPass({
      client: reader({ complete: true }),
      store: s,
      curveOf,
      profile: PROFILE,
    })
    expect(summary.verdicts.stalled).toBe(1)
    expect(s.triggered).toEqual([])
  })

  it('MEZUN token: havuz okuyucusu yoksa emir DEGERLENDIRILMEZ ve SAYILIR', async () => {
    const s = store([passOrder()])
    const pages: string[] = []
    const summary = await runOrderPass({
      client: reader({ complete: true, graduated: true }),
      store: s,
      curveOf,
      profile: PROFILE,
      alert: (_l, key) => pages.push(key),
    })
    expect(summary.poolUnevaluated).toBe(1)
    expect(s.triggered).toEqual([])
    // SESSIZ OLAMAZ: degerlendirilemeyen bir emir, degerlendirilip
    // reddedilenle ayni gorunurdu.
    expect(pages).toContain('orders-pool-unevaluated')
  })

  it('MEZUN token: havuz okuyucusu varsa emir ONUN uzerinden karara baglanir', async () => {
    const s = store([passOrder({ minOut: 500n })])
    const summary = await runOrderPass({
      client: reader({ complete: true, graduated: true }),
      store: s,
      curveOf,
      profile: PROFILE,
      poolQuote: async () => ({ ok: true, amountOut: 500n }),
    })
    expect(summary.poolUnevaluated).toBe(0)
    expect(s.triggered).toEqual([1n])
  })

  it('curve adresi cozulemeyen emir ATLANIR ve SAYFALANIR', async () => {
    const s = store([passOrder()])
    const pages: string[] = []
    const summary = await runOrderPass({
      client: reader(),
      store: s,
      curveOf: async () => null,
      profile: PROFILE,
      alert: (_l, key) => pages.push(key),
    })
    expect(summary.scanned).toBe(0)
    expect(pages).toContain('orders-unknown-token')
  })

  it('kisa donen bir parca KULLANILMAZ, FIRLATIR', async () => {
    const base = reader()
    const broken: ChainReader = {
      ...base,
      readContractBatch: async (calls) => (await base.readContractBatch?.(calls, 0n) ?? []).slice(1),
    }
    await expect(
      runOrderPass({ client: broken, store: store([passOrder()]), curveOf, profile: PROFILE }),
    ).rejects.toThrow(/shifts every following read/)
  })

  it('toplu okuma tasimayan bir okuyucu SESSIZCE ardisiga DUSMEZ', async () => {
    const base = reader()
    const noBatch: ChainReader = {
      getBlock: base.getBlock,
      readContract: base.readContract,
      getLogs: base.getLogs,
    }
    await expect(
      runOrderPass({ client: noBatch, store: store([passOrder()]), curveOf, profile: PROFILE }),
    ).rejects.toThrow(/needs a batching reader/)
  })

  it('immutable degerler GECISLER ARASI onbellekte kalir', async () => {
    const constants = new Map()
    const first = reader()
    await runOrderPass({
      client: first,
      store: store([passOrder()]),
      curveOf,
      profile: PROFILE,
      constants,
    })
    expect(constants.size).toBe(1)
    // 6 slot + 3 immutable + 1 fonlama = 10
    expect(scanCost({ curveOrders: 1, curves: 1, fundingReads: 1, coldCurves: 1, poolOrders: 0 }).subcalls).toBe(10)

    const second = reader()
    const summary = await runOrderPass({
      client: second,
      store: store([passOrder()]),
      curveOf,
      profile: PROFILE,
      constants,
    })
    // Ikinci geciste immutable'lar OKUNMAZ: 6 + 1 = 7.
    expect(summary.cost.subcalls).toBe(7)
  })

  it('tavana dayanan gecis SESSIZ DEGILDIR', async () => {
    const many = Array.from({ length: 3 }, (_, i) => passOrder({ orderSeq: BigInt(i + 1) }))
    const pages: string[] = []
    await runOrderPass({
      client: reader(),
      store: store(many),
      curveOf,
      profile: PROFILE,
      maxOrdersPerPass: 3,
      alert: (_l, key) => pages.push(key),
    })
    expect(pages).toContain('orders-pass-saturated')
  })

  it('varsayilan tavan makul ve pozitif', () => {
    expect(DEFAULT_MAX_ORDERS_PER_PASS).toBeGreaterThan(0)
  })

  it('bos gecis hicbir sey okumaz ama blogu yine de sabitler', async () => {
    const r = reader()
    const summary = await runOrderPass({ client: r, store: store([]), curveOf, profile: PROFILE })
    expect(r.batches).toBe(0)
    expect(summary.blockNumber).toBe(56_199_900n)
    expect(summary.cost.subcalls).toBe(0)
  })
})
