import {
  asTok,
  graduationRaise,
  planBuyExactQuoteIn,
  PROFILE_DIGESTS,
  resolveSellForNet,
  totalSpentOf,
  TRADE_ACTIONS,
  USDC_VIEW_SCALE,
} from '@arcpad/shared/browser'
// `profileDigest` lives in the SERVER half of the package (`profiles.ts` opens
// `profiles.toml` with `node:fs`). A test runs in node, so importing it here is
// fine -- and it is the only way to check the fixture against the pinned digest
// without copying the hash a third time.
import { profileDigest } from '@arcpad/shared'
import { describe, expect, it } from 'vitest'
import {
  AMOUNT_CHIPS_BY_PROFILE,
  amountChipsFor,
  BOUND_LABEL,
  buttonFor,
  type ButtonInput,
  clampToReserve,
  DEFAULT_TAB,
  formatBps,
  formatProgressPercent,
  formatSignedPercent,
  formatSlipBps,
  maxTokensFromSpendable,
  parseAmount,
  priceImpactPpm,
  type Quote,
  quoteFor,
  shortcutBaseFor,
  TAB_ACTION,
  TRADE_TABS,
  type TradeTab,
} from '@/components/token/tradeModel'
import {
  CLIMBED,
  CREATOR,
  PRODUCTION_FRESH,
  PRODUCTION_HOLDING,
  PRODUCTION_PROFILE,
  EXTREME_FEES,
  FEES,
  FRESH,
  FRESH_NO_CREATOR,
  FRESH_PRICE_WEI,
  ONE_USDC,
  ONE_USDC_CREATOR_FEE,
  ONE_USDC_CURVE_AMOUNT,
  ONE_USDC_MIN_TOKENS,
  ONE_USDC_PROTOCOL_FEE,
  ONE_USDC_TOKENS,
  TESTNET_PROFILE,
} from './fixtures'

const base = { state: FRESH, profile: TESTNET_PROFILE, fees: FEES, slipBps: 100 } as const

// --------------------------------------------------------------------------
// Uc sekme, uc giris noktasi
// --------------------------------------------------------------------------

describe('the tab -> entrypoint map', () => {
  it('sends each tab to its OWN entrypoint', () => {
    // "Spend USDC sekmesini buyExactTokensOut'a haritala" MUTANTI BURADA OLUR.
    expect(TAB_ACTION.spend).toBe('buyExactQuoteIn')
    expect(TAB_ACTION.receive).toBe('buyExactTokensOut')
    expect(TAB_ACTION.sell).toBe('sellExactTokensIn')
  })

  it('covers all three of the chain entrypoints, exactly once each', () => {
    const mapped = TRADE_TABS.map((tab) => TAB_ACTION[tab])
    expect(new Set(mapped).size).toBe(3)
    expect([...mapped].sort()).toEqual([...TRADE_ACTIONS].sort())
  })

  it('defaults to the entrypoint that CANNOT fail on a stale quote', () => {
    expect(DEFAULT_TAB).toBe('spend')
    expect(TAB_ACTION[DEFAULT_TAB]).toBe('buyExactQuoteIn')
  })

  it('labels the bound per ENTRYPOINT, because two of them share a boundKind', () => {
    const spend = quoteFor({ ...base, tab: 'spend', amount: ONE_USDC })
    const receive = quoteFor({ ...base, tab: 'receive', amount: ONE_USDC_TOKENS })
    expect(spend.ok && receive.ok).toBe(true)
    if (!spend.ok || !receive.ok) return
    // Ayni `boundKind`, FARKLI etiket: biri `minTokensOut`'u, oteki
    // `maxQuoteIn`'i koruyor.
    expect(spend.plan.boundKind).toBe(receive.plan.boundKind)
    expect(BOUND_LABEL[spend.plan.action]).not.toBe(BOUND_LABEL[receive.plan.action])
    expect(BOUND_LABEL.buyExactQuoteIn).toBe('Minimum tokens you receive')
    expect(BOUND_LABEL.buyExactTokensOut).toBe('Maximum you spend, fees included')
    expect(BOUND_LABEL.sellExactTokensIn).toBe('Minimum you receive, after fees')
  })
})

// --------------------------------------------------------------------------
// Kota, ve ucretin YENIDEN TURETILMEDIGI
// --------------------------------------------------------------------------

describe('quoteFor', () => {
  it('carries the measured 1 USDC vector verbatim', () => {
    const quote = quoteFor({ ...base, tab: 'spend', amount: ONE_USDC })
    expect(quote.ok).toBe(true)
    if (!quote.ok) return
    const { plan } = quote
    expect(plan.action).toBe('buyExactQuoteIn')
    expect(plan.value).toBe(ONE_USDC)
    expect(plan.curveAmount).toBe(ONE_USDC_CURVE_AMOUNT)
    expect(plan.protocolFee).toBe(ONE_USDC_PROTOCOL_FEE)
    expect(plan.creatorFee).toBe(ONE_USDC_CREATOR_FEE)
    expect(plan.tokens).toBe(ONE_USDC_TOKENS)
    expect(plan.args).toEqual([ONE_USDC_MIN_TOKENS])
    expect(plan.progressPpmAfter).toBe(253_087)
    expect(plan.clamped).toBe(false)
  })

  it('the fee is NOT a percentage of the input -- it is 1.2345679% of the budget, not 1.25%', () => {
    const quote = quoteFor({ ...base, tab: 'spend', amount: ONE_USDC })
    if (!quote.ok) throw new Error('expected a plan')
    const fee = quote.plan.protocolFee + quote.plan.creatorFee
    // `feeOn(spend, 125)` olsaydi bu 12_500_000_000_000_000 olurdu.
    expect(fee).toBe(12_345_679_012_345_680n)
    expect(fee).not.toBe(12_500_000_000_000_000n)
    // Ve ucret CURVE tutarinin uzerinde: %1,25 orada dogru.
    expect((quote.plan.curveAmount * 125n) / 10_000n).toBeLessThan(fee)
  })

  it('keeps the two fee parts SEPARATE: their sum is not the combined rate rounded once', () => {
    const quote = quoteFor({ ...base, tab: 'spend', amount: ONE_USDC })
    if (!quote.ok) throw new Error('expected a plan')
    const summed = quote.plan.protocolFee + quote.plan.creatorFee
    const curve = quote.plan.curveAmount
    const combined = (curve * 125n + 9_999n) / 10_000n
    expect(summed).not.toBe(combined)
  })

  it('gives the sell a bound on the NET, not on the proceeds', () => {
    const quote = quoteFor({ ...base, state: CLIMBED, tab: 'sell', amount: ONE_USDC_TOKENS })
    if (!quote.ok) throw new Error('expected a plan')
    const [tokensIn, minQuoteOut] = quote.plan.args as readonly [bigint, bigint]
    expect(tokensIn).toBe(ONE_USDC_TOKENS)
    expect(quote.plan.value).toBe(0n)
    const net = quote.plan.curveAmount - quote.plan.protocolFee - quote.plan.creatorFee
    // `minQuoteOut`'a `proceeds` veren MUTANT BURADA OLUR: `proceeds`
    // uzerinden hesaplanan bir taban, ele gecebilecek olanin ~%1,25 USTUNDE
    // olur ve her satis `SlippageExceeded` alir.
    expect(minQuoteOut).toBe((net * 9_900n) / 10_000n)
    expect(minQuoteOut).toBeLessThan((quote.plan.curveAmount * 9_900n) / 10_000n)
  })

  it('gives buyExactTokensOut a FEE-INCLUSIVE cap', () => {
    const quote = quoteFor({ ...base, tab: 'receive', amount: ONE_USDC_TOKENS, slipBps: 0 })
    if (!quote.ok) throw new Error('expected a plan')
    const [, maxQuoteIn] = quote.plan.args as readonly [bigint, bigint]
    // Ucret HARIC hesaplanan bir `maxQuoteIn` mutanti: sifir slipajda
    // `total > maxQuoteIn` olur ve zincir reddeder.
    expect(maxQuoteIn).toBe(totalSpentOf(quote.plan))
    expect(maxQuoteIn).toBeGreaterThan(quote.plan.curveAmount)
    expect(quote.plan.value).toBe(maxQuoteIn)
  })

  it('drops the creator share entirely when the creator is the zero address', () => {
    const withCreator = quoteFor({ ...base, tab: 'spend', amount: ONE_USDC })
    const without = quoteFor({ ...base, state: FRESH_NO_CREATOR, tab: 'spend', amount: ONE_USDC })
    if (!withCreator.ok || !without.ok) throw new Error('expected plans')
    expect(without.plan.creatorFee).toBe(0n)
    // KATLANMAZ: protokol payi AYNI oranda kalir, yani islem 30 bps daha ucuz
    // ve alici DAHA COK token alir.
    expect(without.plan.tokens).toBeGreaterThan(withCreator.plan.tokens)
  })

  it('reports the planner refusal instead of throwing', () => {
    const quote = quoteFor({
      ...base,
      tab: 'receive',
      amount: TESTNET_PROFILE.saleSupply + 1n,
    })
    expect(quote).toEqual({ ok: false, errorName: 'NotEnoughTokensToBuy' })
  })
})

// --------------------------------------------------------------------------
// Butce guvencesi: `<=`, ASLA `==`
// --------------------------------------------------------------------------

describe('the budget guarantee', () => {
  const budgets = [
    1_000_000_000_000n,
    2_000_000_000_000n,
    123_456_000_000_000_000n,
    ONE_USDC,
    7_000_000_000_000_000_000n,
  ]

  it('spends AT MOST the budget -- and equality is not guaranteed', () => {
    for (const fees of [FEES, EXTREME_FEES]) {
      for (const amount of budgets) {
        const quote = quoteFor({ ...base, fees, tab: 'spend', amount })
        if (!quote.ok) continue
        const spent = totalSpentOf(quote.plan)
        // `<=`, ASLA `==`. Esitlik (95,30) bps'te %99,95 vakada, (5000,5000)
        // bps'te yalnizca %75 vakada tutuyor: duzeltme atesleme(me)diginde
        // toplam butcenin bir birim altinda kalir ve o birim IADE EDILIR.
        expect(spent).toBeLessThanOrEqual(quote.plan.value)
        expect(spent + quote.plan.refund).toBe(quote.plan.value)
      }
    }
  })

  it('has witnesses where the spend is STRICTLY below the budget', () => {
    // Iddianin bos olmadiginin kaniti, ve `==` yazan bir kontrolun neden
    // gizli bir hata oldugunun. Ikisi de olculdu (bu planlayici, bu profil):
    //   (95, 30) bps    -> gross 2026 iade eder
    //   (5000, 5000) bps -> gross 5 iade eder, ve esitlik vakalarin ancak
    //                       %75'inde tutar
    const witnesses = [
      [FEES, 2_026n],
      [EXTREME_FEES, 5n],
    ] as const
    for (const [fees, amount] of witnesses) {
      const quote = quoteFor({ ...base, fees, tab: 'spend', amount })
      if (!quote.ok) throw new Error(`expected a plan for ${amount}`)
      expect(totalSpentOf(quote.plan)).toBeLessThan(quote.plan.value)
      expect(quote.plan.refund).toBeGreaterThan(0n)
    }
  })

  it('reaches the planner with UNQUANTISED budgets through the Receive MAX', () => {
    // Alan alti ondalikla kuantalar, ama `maxTokensFromSpendable` slipaj payini
    // dusmek icin `spendable × 10000 / (10000 + slip)` yapiyor -- ve o bolme
    // kuantayi bozar. Yani `==` iddiasinin kirilabildigi girdiler bu panelde
    // GERCEKTEN uretiliyor; "kullanici zaten yuvarlak sayi yazar" bir savunma
    // degil.
    const spendable = 1_000_000_000_000n
    expect((spendable * 10_000n) / 10_100n).not.toBe(spendable)
    expect(maxTokensFromSpendable({ ...base, spendable, slipBps: 100 })).toBeGreaterThan(0n)
  })
})

// --------------------------------------------------------------------------
// Kelepce
// --------------------------------------------------------------------------

describe('clampToReserve', () => {
  it('says the clamp out loud rather than silently reducing the order', () => {
    const verdict = clampToReserve(CLIMBED.realTokenReserves + 1n, CLIMBED.realTokenReserves)
    expect(verdict.value).toBe(CLIMBED.realTokenReserves)
    expect(verdict.notice).toBe('Only 592,376,046.879238 left on the curve.')
  })

  it('leaves an order inside the reserve untouched and silent', () => {
    expect(clampToReserve(1n, CLIMBED.realTokenReserves)).toEqual({ value: 1n, notice: null })
    expect(clampToReserve(CLIMBED.realTokenReserves, CLIMBED.realTokenReserves).notice).toBeNull()
  })
})

describe('the Receive tokens MAX', () => {
  it('leaves room for the slippage headroom the cap will add', () => {
    const spendable = ONE_USDC
    const tokens = maxTokensFromSpendable({ ...base, spendable, slipBps: 100 })
    const quote = quoteFor({ ...base, tab: 'receive', amount: tokens, slipBps: 100 })
    if (!quote.ok) throw new Error('expected a plan')
    // `maxQuoteIn` = ceil(total × 1,01) ve cuzdandan cikan sey O. Slipaj payi
    // dusulmeden hesaplanan bir MAX burada `spendable`'i asar ve buton
    // "Insufficient USDC" gosterir -- yani MAX kendi kendini reddeder.
    expect(quote.plan.value).toBeLessThanOrEqual(spendable)
  })

  it('never asks for more than the curve has left', () => {
    const tokens = maxTokensFromSpendable({
      ...base,
      state: CLIMBED,
      spendable: 10n ** 21n,
      slipBps: 100,
    })
    expect(tokens).toBeLessThanOrEqual(CLIMBED.realTokenReserves)
  })

  it('is null on the buy tabs when the gas estimate is missing, and the token balance on sell', () => {
    const shared = { ...base, tokenBalance: 5n, spendable: null }
    expect(shortcutBaseFor({ ...shared, tab: 'spend' })).toBeNull()
    expect(shortcutBaseFor({ ...shared, tab: 'receive' })).toBeNull()
    // Satista harcanan sey TOKEN'dir; gaz tahmini olmasa da tokenlar orada.
    expect(shortcutBaseFor({ ...shared, tab: 'sell' })).toBe(5n)
  })
})

// --------------------------------------------------------------------------
// Bicimlendirme
// --------------------------------------------------------------------------

describe('the display arithmetic', () => {
  it('turns the measured price move into +51.32%', () => {
    // 4_000_000_000 -> 6_052_733_351, yani +51,3183% -> iki ondalikta +51,32%.
    const ppm = priceImpactPpm(FRESH_PRICE_WEI, 6_052_733_351n)
    expect(ppm).toBe(513_183)
    expect(formatSignedPercent(ppm)).toBe('+51.32%')
  })

  it('always writes the sign, and rounds the MAGNITUDE', () => {
    expect(formatSignedPercent(0)).toBe('+0.00%')
    expect(formatSignedPercent(-513_183)).toBe('-51.32%')
    expect(formatSignedPercent(-51)).toBe('-0.01%')
    expect(formatSignedPercent(49)).toBe('+0.00%')
  })

  it('writes progress with the same formula as the page header', () => {
    expect(formatProgressPercent(253_087)).toBe('25.3%')
    expect(formatProgressPercent(1_000_000)).toBe('100.0%')
  })

  it('writes 30 bps as 0.30%, not 0.3%', () => {
    expect(formatBps(95n)).toBe('0.95%')
    expect(formatBps(30n)).toBe('0.30%')
    expect(formatBps(5000n)).toBe('50.00%')
  })

  it('writes the slippage without trailing zeros', () => {
    expect(formatSlipBps(100)).toBe('1%')
    expect(formatSlipBps(50)).toBe('0.5%')
    expect(formatSlipBps(300)).toBe('3%')
  })
})

describe('parseAmount', () => {
  it('quantises to six decimals, in both views', () => {
    expect(parseAmount('1')).toEqual({ ok: true, value: ONE_USDC })
    expect(parseAmount('0.000001')).toEqual({ ok: true, value: 1_000_000_000_000n })
  })

  it('leaves an empty field WITHOUT an error message', () => {
    // Bos bir alan "yanlis" degil, BOS. Kirmizi bir mesaj kullaniciya
    // yapmadigi bir hata bildirirdi.
    expect(parseAmount('')).toEqual({ ok: false, reason: null })
  })

  it('names each refusal', () => {
    /**
     * `AmountParse` BIR BIRLESIM, ve `.reason` yalnizca `ok: false` dalinda
     * VAR. Daraltmadan okumak derlenmez -- ama vitest tip DENETLEMEDEN cevirdigi
     * icin bu uc satir aylarca `undefined.toMatch(...)` olarak kosabilirdi.
     * Daraltma bir cast ile degil, KABULU REDDEDEREK yapiliyor: bir gun
     * `parseAmount('-1')` kabul ederse test "reason yok" diye degil, "bunun
     * reddedilmesi gerekiyordu" diye duser.
     */
    const refusal = (text: string): string | null => {
      const parsed = parseAmount(text)
      if (parsed.ok) throw new Error(`${text} kabul edildi (${parsed.value}); reddedilmeliydi`)
      return parsed.reason
    }
    expect(refusal('1e3')).toMatch(/write the number out/i)
    expect(refusal('-1')).toMatch(/negative/i)
    expect(refusal('1.2345678')).toMatch(/six decimals/i)
  })
})

// --------------------------------------------------------------------------
// Buton sirasi -- BIR TABLO, BASTAN SONA
// --------------------------------------------------------------------------

const READY: ButtonInput = {
  connection: 'connected',
  chainName: 'Arc Testnet',
  symbol: 'DIFF',
  tab: 'spend',
  amount: ONE_USDC,
  quote: quoteFor({ ...base, tab: 'spend', amount: ONE_USDC }),
  available: 10n * ONE_USDC,
  approval: 'notNeeded',
  simulation: { kind: 'ok' },
  phase: 'idle',
}

const blocked = (title: string): ButtonInput['simulation'] => ({
  kind: 'blocked',
  failure: {
    kind: 'contract',
    action: 'buyExactQuoteIn',
    name: 'SlippageExceeded',
    title,
    detail: '',
    retryable: false,
    raw: null,
  },
})

describe('the button ladder', () => {
  const cases: readonly (readonly [string, Partial<ButtonInput>, string, boolean])[] = [
    ['disconnected', { connection: 'disconnected' }, 'Connect wallet', false],
    ['wrong network', { connection: 'wrongNetwork' }, 'Switch to Arc Testnet', false],
    ['empty input', { amount: null, quote: null }, 'Enter an amount', true],
    ['zero input', { amount: 0n, quote: null }, 'Enter an amount', true],
    ['above the balance', { available: 1n }, 'Insufficient USDC', true],
    [
      'above the token balance, on sell',
      {
        tab: 'sell',
        amount: ONE_USDC_TOKENS,
        quote: quoteFor({ ...base, state: CLIMBED, tab: 'sell', amount: ONE_USDC_TOKENS }),
        available: 1n,
      },
      'Insufficient DIFF',
      true,
    ],
    ['allowance still loading', { tab: 'sell', approval: 'unknown' }, 'Checking allowance…', true],
    ['allowance missing', { tab: 'sell', approval: 'required' }, 'Approve DIFF', false],
    [
      'simulation reverted',
      { simulation: blocked('Slippage exceeded') },
      'Slippage exceeded',
      true,
    ],
    ['simulating', { phase: 'simulating' }, 'Checking…', true],
    ['waiting on the wallet', { phase: 'awaitingSignature' }, 'Confirm in your wallet', true],
    ['in flight', { phase: 'pending' }, 'Submitting…', true],
    [
      'the planner refused',
      { quote: { ok: false, errorName: 'ProceedsTooSmall' } },
      'That is too small to sell: the fees would take all of it.',
      true,
    ],
    ['ready to buy', {}, 'Buy DIFF', false],
    [
      'ready to sell',
      {
        tab: 'sell',
        approval: 'sufficient',
        amount: ONE_USDC_TOKENS,
        quote: quoteFor({ ...base, state: CLIMBED, tab: 'sell', amount: ONE_USDC_TOKENS }),
        available: 10n ** 30n,
      },
      'Sell DIFF',
      false,
    ],
  ]

  it.each(cases)('%s -> exactly one label', (_name, overrides, label, disabled) => {
    const plan = buttonFor({ ...READY, ...overrides })
    expect(plan.label).toBe(label)
    expect(plan.disabled).toBe(disabled)
  })

  it('puts connection BEFORE balance: a disconnected wallet has no balance to be short of', () => {
    const plan = buttonFor({ ...READY, connection: 'disconnected', available: 0n })
    expect(plan.label).toBe('Connect wallet')
  })

  it('puts approval BEFORE the simulation: the sell WILL revert until the allowance exists', () => {
    const plan = buttonFor({
      ...READY,
      tab: 'sell',
      approval: 'required',
      simulation: blocked('Not enough allowance'),
    })
    // Bu sira olmasaydi kullaniciya "bu islem revert ediyor" denirdi, oysa
    // yapmasi gereken sey "Approve"a basmak.
    expect(plan.label).toBe('Approve DIFF')
    expect(plan.disabled).toBe(false)
  })

  it('produces exactly one label for every tab in the ready state', () => {
    const labels = new Set<string>()
    for (const tab of TRADE_TABS satisfies readonly TradeTab[]) {
      labels.add(buttonFor({ ...READY, tab, approval: 'notNeeded' }).label)
    }
    expect([...labels].sort()).toEqual(['Buy DIFF', 'Sell DIFF'])
  })
})

describe('a fixture sanity check', () => {
  it('the fresh curve opens at the measured price', () => {
    expect(FRESH.creator).toBe(CREATOR)
    const quote: Quote = quoteFor({ ...base, tab: 'spend', amount: ONE_USDC })
    if (!quote.ok) throw new Error('expected a plan')
    expect(quote.plan.priceAfterWeiPerToken).toBe(6_052_733_351n)
  })
})

// --------------------------------------------------------------------------
// Mutlak para kisayollari
// --------------------------------------------------------------------------

/**
 * ==========================================================================
 *  THE MONEY CHIPS -- ONE LADDER, THREE TABS, THREE UNITS
 * ==========================================================================
 *
 * The owner's decision is that the user always picks MONEY, on both sides. So
 * the chip's job is a unit conversion, and it is a different conversion per
 * tab: identity on `spend`, a BUY quote on `receive`, a SELL quote on `sell`.
 * Nothing proved about one of those transfers to the others -- the three tabs
 * are three entrypoints, which is the rule the rest of this file is organised
 * around.
 */
describe('amountChipsFor', () => {
  const RICH = 10_000n * ONE_USDC

  const chipsOn = (tab: 'spend' | 'receive' | 'sell', over: Record<string, unknown> = {}) =>
    amountChipsFor({
      tab,
      spendable: RICH,
      tokenBalance: PRODUCTION_HOLDING,
      state: PRODUCTION_FRESH,
      profile: PRODUCTION_PROFILE,
      profileName: 'production',
      fees: FEES,
      ...over,
    } as Parameters<typeof amountChipsFor>[0])

  const chipsOnTestnet = (tab: 'spend' | 'receive' | 'sell', over: Record<string, unknown> = {}) =>
    amountChipsFor({
      tab,
      spendable: RICH,
      tokenBalance: TESTNET_PROFILE.saleSupply / 2n,
      state: FRESH,
      profile: TESTNET_PROFILE,
      profileName: 'testnet',
      fees: FEES,
      ...over,
    } as Parameters<typeof amountChipsFor>[0])

  it('is the PRODUCTION ladder on the production profile', () => {
    expect(AMOUNT_CHIPS_BY_PROFILE.production).toEqual([25n, 100n, 500n])
    expect(chipsOn('spend').map((c) => c.usdc)).toEqual([25n, 100n, 500n])
  })

  it('is the TESTNET ladder on the testnet profile, and it is a different ladder', () => {
    // THE WHOLE POINT OF KEYING OFF THE PROFILE. `$25` is not wrong, it is
    // right for a curve that raises 12_161 USDC and unreachable on one that
    // raises 12.16 -- the same factor of 1000 that separates the two `V`s.
    expect(AMOUNT_CHIPS_BY_PROFILE.testnet).toEqual([1n, 5n, 10n])
    expect(chipsOnTestnet('spend').map((c) => c.usdc)).toEqual([1n, 5n, 10n])
  })

  it('the two ladders are in the same ratio as the two profiles', () => {
    // 1000x in `V` is 1000x in every quote-denominated figure, the ladder
    // included. A ladder that did not scale with the profile would be a
    // hardcoded `V` wearing a different hat.
    const testnet = AMOUNT_CHIPS_BY_PROFILE.testnet
    const production = AMOUNT_CHIPS_BY_PROFILE.production
    expect(testnet).toHaveLength(production.length)
    expect(PRODUCTION_PROFILE.virtualQuoteReserves).toBe(
      TESTNET_PROFILE.virtualQuoteReserves * 1000n,
    )
  })

  it('the production fixture IS the pinned production profile', () => {
    // Not an invented "deep curve": the digest is the cross-language gate that
    // says so, and without this assertion the fixture could drift into fiction.
    expect(profileDigest(PRODUCTION_PROFILE)).toBe(PROFILE_DIGESTS.production)
    expect(profileDigest(TESTNET_PROFILE)).toBe(PROFILE_DIGESTS.testnet)
  })

  it('fills the money itself on Spend USDC', () => {
    // The identity case, and it still has to be asserted: a conversion applied
    // where none belongs is exactly as wrong as one omitted where it does.
    for (const chip of chipsOn('spend')) {
      expect(chip.fill).toBe(chip.usdc * ONE_USDC)
      expect(chip.fill).toBe(chip.wei)
    }
  })

  it('fills TOKENS on Receive tokens, and they are what that budget buys', () => {
    for (const chip of chipsOn('receive')) {
      const plan = planBuyExactQuoteIn(PRODUCTION_FRESH, PRODUCTION_PROFILE, FEES, chip.wei, 0)
      expect(chip.fill).toBe(plan.tokens)
      // NOT the money. A chip that wrote `25e18` into a token field would be
      // asking for 25 tokens, and both views are 1e18-scaled so it would look
      // entirely normal.
      expect(chip.fill).not.toBe(chip.wei)
    }
  })

  it('fills TOKENS on Sell, resolved in the SELL direction', () => {
    const chips = chipsOn('sell')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      const found = resolveSellForNet(
        PRODUCTION_FRESH,
        PRODUCTION_PROFILE,
        FEES,
        chip.wei,
        PRODUCTION_HOLDING,
        USDC_VIEW_SCALE,
      )
      expect(found.ok).toBe(true)
      if (!found.ok) continue
      expect(chip.fill).toBe(found.tokensIn)
      // THE DIRECTION MUTANT, at the panel's own level: the buy-side answer for
      // the same money is a different, smaller quantity.
      const buySide = planBuyExactQuoteIn(
        PRODUCTION_FRESH,
        PRODUCTION_PROFILE,
        FEES,
        chip.wei,
        0,
      ).tokens
      expect(chip.fill).not.toBe(buySide)
    }
  })

  it('drops a chip the gas reserve cannot cover, on BOTH buy tabs', () => {
    // $100 spendable: $25 survives, $100 does not -- the reserve is inside it.
    const spendable = 100n * ONE_USDC - 300_000_000_000_000n
    expect(chipsOn('spend', { spendable }).map((c) => c.usdc)).toEqual([25n])
    // The receive tab spends USDC too, and forgetting it there is precisely
    // the "covered on one entrypoint" failure this repo keeps hitting.
    expect(chipsOn('receive', { spendable }).map((c) => c.usdc)).toEqual([25n])
  })

  it('drops every chip when the gas estimate failed', () => {
    expect(chipsOn('spend', { spendable: null })).toEqual([])
    expect(chipsOn('receive', { spendable: null })).toEqual([])
  })

  it('drops a sell chip the holding cannot make', () => {
    // Enough token for $25, not for $500.
    const small = PRODUCTION_PROFILE.saleSupply / 500n
    const usable = chipsOn('sell', { tokenBalance: small }).map((c) => c.usdc)
    expect(usable).not.toContain(500n)
    expect(usable.length).toBeLessThan(3)
  })

  it('drops every sell chip when the wallet holds nothing', () => {
    expect(chipsOn('sell', { tokenBalance: 0n })).toEqual([])
    expect(chipsOn('sell', { tokenBalance: null })).toEqual([])
  })

  it('does NOT offer a buy chip that would clamp', () => {
    // A clamping chip says `$500` and spends whatever is left on the curve,
    // completing it. The money and the label part company, which is the one
    // thing a shortcut on a payment surface may not do.
    const nearlyDone = {
      ...PRODUCTION_FRESH,
      realTokenReserves: asTok(PRODUCTION_PROFILE.saleSupply / 1_000_000n),
    }
    expect(chipsOn('spend', { state: nearlyDone })).toEqual([])
  })

  it('offers nothing on a completed curve', () => {
    expect(chipsOn('spend', { state: { ...PRODUCTION_FRESH, complete: true } })).toEqual([])
    expect(chipsOn('sell', { state: { ...PRODUCTION_FRESH, complete: true } })).toEqual([])
  })

  /**
   * ======================================================================
   *  THE MEASUREMENT THAT DECIDED THE SHAPE OF THIS FEATURE
   * ======================================================================
   */
  /**
   * ======================================================================
   *  THE SUPPRESSION IS THE INVARIANT, AND IT OUTLIVES THE RIGHT LADDER
   * ======================================================================
   */
  it('suppresses the PRODUCTION ladder on a curve without the depth for it', () => {
    // The production ladder meeting a testnet-depth curve. This is the case the
    // measurement found and it must stay closed no matter which ladder is
    // configured: a curve that raises 12.16 USDC in total cannot fill a $25
    // chip, so nothing renders.
    for (const tab of ['spend', 'receive', 'sell'] as const) {
      expect(
        amountChipsFor({
          tab,
          spendable: RICH,
          tokenBalance: TESTNET_PROFILE.saleSupply / 2n,
          state: FRESH,
          profile: TESTNET_PROFILE,
          profileName: 'production',
          fees: FEES,
        }),
      ).toEqual([])
    }
  })

  it('suppresses the chips a LATE production curve can no longer absorb', () => {
    // The ladder being right for the profile does not make it right at every
    // point in a curve's life. Near the top there is not enough reserve left,
    // so the chips that would clamp go and the rest stay.
    const late = {
      ...PRODUCTION_FRESH,
      realTokenReserves: asTok(PRODUCTION_PROFILE.saleSupply / 20_000n),
    }
    const usable = chipsOn('spend', { state: late }).map((c) => c.usdc)
    expect(usable).not.toContain(500n)
    expect(usable.length).toBeLessThan(3)
  })

  it('suppresses the testnet sell chips above the curve ceiling', () => {
    // A fresh testnet curve's sell asymptote is `virtualQuoteReserves` =
    // 4.292 USDC, so $5 and $10 are unreachable to EVERY holder while $1 is
    // fine. The buy side of the same ladder is unaffected -- three entrypoints,
    // three boundaries.
    expect(chipsOnTestnet('sell').map((c) => c.usdc)).toEqual([1n])
    expect(chipsOnTestnet('spend').map((c) => c.usdc)).toEqual([1n, 5n, 10n])
  })

  it('the whole testnet curve costs less than the smallest PRODUCTION chip', () => {
    // `V*S/(vT0-S)`, the number that decided the ladder split.
    const raise = graduationRaise(
      TESTNET_PROFILE.saleSupply,
      TESTNET_PROFILE.virtualQuoteReserves,
      TESTNET_PROFILE.virtualTokenReserves,
    )
    expect(raise).toBe(12_161_433_369_060_378_706n)
    expect(raise).toBeLessThan(AMOUNT_CHIPS_BY_PROFILE.production[0]! * ONE_USDC)
    // ...and MORE than the largest testnet chip, which is what makes that
    // ladder fillable.
    expect(raise).toBeGreaterThan(AMOUNT_CHIPS_BY_PROFILE.testnet[2]! * ONE_USDC)
  })
})
