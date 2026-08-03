import type { CurveState } from '@arcpad/shared/browser'
import { cleanup, render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QuoteBreakdown } from '@/components/token/QuoteBreakdown'
import { quoteFor, type TradeTab } from '@/components/token/tradeModel'
import {
  CLIMBED,
  CLIMBED_PRICE_WEI,
  FEES,
  FRESH,
  FRESH_NO_CREATOR,
  FRESH_PRICE_WEI,
  ONE_USDC,
  ONE_USDC_TOKENS,
  ROUND_TRIP_NET,
  TESTNET_PROFILE,
} from './fixtures'

/**
 * DOKUM SATIRLARI, DIZE OLARAK SABITLENMIS.
 *
 * Her sayi elle turetildi ve kaynagi `fixtures.ts`'te yaziyor. Sabitlenmis
 * DIZELER kullanilmasinin sebebi: bir bicimlendirme YONU degistiginde
 * (`rounding="up"` -> `"down"`) sayi bir mikro-USDC kayar ve baska hicbir sey
 * degismez -- tip degismez, plan degismez, ve kullanici hesabi tutmayan bir
 * dokum gorur.
 *
 * OLCULEN 1 USDC VEKTORU (taze testnet curve, 95/30 bps, %1 slipaj):
 *
 *   You spend                 1.000000 USDC
 *     Curve amount            0.987654 USDC
 *     Protocol fee (0.95%)    0.009383 USDC
 *     Creator fee (0.30%)     0.002963 USDC
 *   You receive             ~200,723,953.120761 DIFF
 *   Minimum tokens received  198,716,713.589554 DIFF (slippage 1%)
 *   Price impact                      +51.32%
 *   Progress after                      25.3%
 *
 * BRIEF'TEN BIR SAPMA, ve bilincli: brief ucret satirlarini `0.009382` /
 * `0.002962` diye sabitliyor -- yani ASAGI yuvarlayarak. Burada YUKARI
 * yuvarlaniyor, uc olculmus sebeple:
 *
 *   1. K1: maliyet ve ust sinir YUKARI yuvarlanir, ve bir ucret bir
 *      maliyettir. `walletDelta.ts` bunu boyle yaziyor ve Task 11'in YESIL
 *      testi (`test/token/tables.test.tsx`) ayni iki sayiyi `0,009383` /
 *      `0,002963` diye sabitlemis durumda. Asagi yuvarlamak ayni islemi iki
 *      ekranda iki farkli sayiyla gosterirdi.
 *   2. Alimda dokum TAM TOPLANIYOR: 0,987654 + 0,009383 + 0,002963 = 1,000000.
 *      Asagi yuvarlanmis ucretlerle toplam 0,999998 cikar ve ekrandaki
 *      aritmetik tutmaz.
 *   3. Satista TAM CIKARILIYOR: 0,987654 - 0,009383 - 0,002963 = 0,975308, ve
 *      0,975308 tam olarak `netProceedsOf`'un dondugu sayi. Asagi yuvarlanmis
 *      ucretlerle 0,975310 cikardi -- ele gecen tutardan iki mikro-USDC fazla.
 */

const planFor = (tab: TradeTab, amount: bigint, state: CurveState) => {
  const quote = quoteFor({ tab, amount, state, profile: TESTNET_PROFILE, fees: FEES, slipBps: 100 })
  if (!quote.ok) throw new Error(`expected a plan, got ${quote.errorName}`)
  return quote.plan
}

/**
 * SORGULAR KENDI KAPSAMINDA. `screen` butun `document.body`'yi tarar; iki
 * dokumu yan yana karsilastiran test (alim sablonu vs satis sablonu) orada iki
 * kopya birden bulur ve testin kendisi kirilir -- iddiasi yanlis oldugu icin
 * degil.
 */
function scoped(container: HTMLElement) {
  const q = within(container)
  return {
    q,
    text: (id: string) => q.getByTestId(id).textContent ?? '',
    label: (id: string) => q.getByTestId(`label-${id}`).textContent ?? '',
    node: (id: string) => q.getByTestId(id),
    missing: (id: string) => q.queryByTestId(id),
    /** Ekrandaki dizeyi mikro-USDC tam sayisina cevirir. */
    micro: (id: string) =>
      Math.round(Number((q.getByTestId(id).textContent ?? '').replace(' USDC', '')) * 1e6),
  }
}

function renderQuote(tab: TradeTab, amount: bigint, state: CurveState, priceBefore: bigint) {
  const plan = planFor(tab, amount, state)
  const view = render(
    <QuoteBreakdown
      plan={plan}
      state={state}
      fees={FEES}
      symbol="DIFF"
      slipBps={100}
      priceBeforeWei={priceBefore}
    />,
  )
  return { plan, ...scoped(view.container) }
}

const renderBuy = (state: CurveState = FRESH) =>
  renderQuote('spend', ONE_USDC, state, FRESH_PRICE_WEI)

const renderSell = () => renderQuote('sell', ONE_USDC_TOKENS, CLIMBED, CLIMBED_PRICE_WEI)

describe('the buy breakdown', () => {
  it('is OPEN by default: a folded breakdown makes the two fee parts uninferable', () => {
    const { node } = renderBuy()
    expect(node('quote-breakdown')).toHaveAttribute('open')
  })

  it('pins every line of the measured 1 USDC vector', () => {
    const { text } = renderBuy()
    expect(text('quote-principal')).toBe('1.000000 USDC')
    expect(text('quote-curve')).toBe('0.987654 USDC')
    expect(text('quote-protocolFee')).toBe('0.009383 USDC')
    expect(text('quote-creatorFee')).toBe('0.002963 USDC')
    expect(text('quote-result')).toBe('~200,723,953.120761 DIFF')
    expect(text('quote-bound')).toBe('198,716,713.589554 DIFF (slippage 1%)')
    expect(text('quote-impact')).toBe('+51.32%')
    expect(text('quote-progress')).toBe('25.3%')
  })

  it('adds up ON SCREEN: the three parts are exactly the total', () => {
    const { micro } = renderBuy()
    expect(micro('quote-curve') + micro('quote-protocolFee') + micro('quote-creatorFee')).toBe(
      micro('quote-principal'),
    )
  })

  it('labels each fee with the rate AND what the rate is a rate OF', () => {
    const { label } = renderBuy()
    // Toplam ucret butcenin %1,2345679'u, %1,25'i DEGIL: yuzde CURVE tutarinin
    // uzerinedir. Yanindaki mutlak sayiyla celismeyen tek etiket bu.
    expect(label('protocolFee')).toBe('Protocol fee (0.95%), added on top')
    expect(label('creatorFee')).toBe('Creator fee (0.30%), added on top')
    expect(label('curve')).toBe('Curve amount, into the reserves')
  })

  it('keeps the two fee parts as two rows, never summed into one', () => {
    const { node, missing } = renderBuy()
    // Toplayip tek satir yazmak, iki tavan yuvarlamasinin toplami ile birlesik
    // oranin tek yuvarlamasi arasindaki farki gorunmez kilar -- canli zincirde
    // olculdu, ticaret #1'de bir wei.
    expect(node('quote-protocolFee')).toBeInTheDocument()
    expect(node('quote-creatorFee')).toBeInTheDocument()
    expect(missing('quote-totalFee')).toBeNull()
  })

  it('never derives a fee from the input: feeOn(spend, 125) would print 0.012500', () => {
    const { text } = renderBuy()
    const both = `${text('quote-protocolFee')} ${text('quote-creatorFee')}`
    expect(both).not.toContain('0.012500')
    expect(both).not.toContain('0.012346')
  })

  it('caps the buyExactTokensOut bound with the FEE-INCLUSIVE maximum', () => {
    const { label, text } = renderQuote('receive', ONE_USDC_TOKENS, FRESH, FRESH_PRICE_WEI)
    expect(label('bound')).toBe('Maximum you spend, fees included')
    // Sinir USDC cinsinden ve slipaj payi da cuzdandan cikar.
    expect(text('quote-bound')).toContain('USDC')
    expect(text('quote-bound')).toContain('(slippage 1%)')
  })

  it('does NOT carry the round-trip sentence: the user has not sold anything yet', () => {
    const { missing } = renderBuy()
    expect(missing('quote-roundTrip')).toBeNull()
  })
})

describe('the zero-creator branch', () => {
  it('replaces the creator row with one sentence instead of printing a zero', () => {
    const { text, missing } = renderBuy(FRESH_NO_CREATOR)
    // Sifir yazmak "alindi ama sifir" gibi okunur; asil gercek alinmadigi ve
    // protokol payina KATLANMADIGIDIR.
    expect(missing('quote-creatorFee')).toBeNull()
    expect(text('quote-noCreatorFee')).toBe('No creator fee on this launch.')
  })

  it('is not cosmetic: the protocol share itself moves, because the net is larger', () => {
    const withCreator = renderBuy(FRESH)
    expect(withCreator.text('quote-protocolFee')).toBe('0.009383 USDC')
    cleanup()

    const without = renderBuy(FRESH_NO_CREATOR)
    // 30 bps hic alinmadigi icin duzeltilmis net BUYUR, yani protokol payi da
    // buyur ve alici daha cok token alir. Dali kaldiran mutant burada 0,009383
    // yazardi.
    expect(without.text('quote-protocolFee')).toBe('0.009411 USDC')
  })

  it('keeps the creator row when there IS a creator', () => {
    const { node, missing } = renderBuy(FRESH)
    expect(missing('quote-noCreatorFee')).toBeNull()
    expect(node('quote-creatorFee')).toBeInTheDocument()
  })
})

describe('the sell breakdown', () => {
  it('is a DIFFERENT template: every structural label differs from the buy side', () => {
    const ids = ['principal', 'curve', 'protocolFee', 'creatorFee']
    const buyLabels = ids.map(renderBuy().label)
    cleanup()
    const sellLabels = ids.map(renderSell().label)

    // Sablonlari takas eden bir mutant burada olur: ucretlerin "eklendigini"
    // soyleyen bir satis dokumu, ele gececek tutari oldugundan buyuk gosterir.
    for (const [i, buyLabel] of buyLabels.entries()) {
      expect(sellLabels[i]).not.toBe(buyLabel)
    }
    expect(sellLabels).toEqual([
      'You sell',
      'Curve amount, out of the reserves',
      'Protocol fee (0.95%), deducted',
      'Creator fee (0.30%), deducted',
    ])
  })

  it('subtracts exactly on screen, and the net is what netProceedsOf returns', () => {
    const { plan, text, micro } = renderSell()
    expect(text('quote-principal')).toBe('200,723,953.120761 DIFF')
    expect(text('quote-curve')).toBe('0.987654 USDC')
    expect(text('quote-protocolFee')).toBe('0.009383 USDC')
    expect(text('quote-creatorFee')).toBe('0.002963 USDC')
    expect(text('quote-result')).toBe('0.975308 USDC')
    expect(plan.curveAmount - plan.protocolFee - plan.creatorFee).toBe(ROUND_TRIP_NET)
    expect(micro('quote-curve') - micro('quote-protocolFee') - micro('quote-creatorFee')).toBe(
      micro('quote-result'),
    )
  })

  it('bounds the NET, fees already deducted -- not the proceeds', () => {
    const { label, text } = renderSell()
    expect(label('bound')).toBe('Minimum you receive, after fees')
    // `minQuoteOut`'a `proceeds` veren bir mutant burada ~0,977777 yazardi:
    // ele gecebilecek olanin USTUNDE bir taban, yani her satis revert eder.
    expect(text('quote-bound')).toBe('0.965555 USDC (slippage 1%)')
  })

  it('states the round-trip truth ONCE, on this side', () => {
    const { text } = renderSell()
    const sentence = text('quote-roundTrip')
    expect(sentence).toContain('1.000000 USDC')
    expect(sentence).toContain('0.975308 USDC')
    expect(sentence).toContain('2.4691%')
  })
})

describe('price impact', () => {
  it('warns above 10% and does NOT block: high impact is normal on a bonding curve', () => {
    const { q, text, node } = renderBuy()
    expect(text('quote-impact')).toBe('+51.32%')
    expect(node('quote-impact')).toHaveClass('text-negative')
    expect(q.getByText(/High price impact is normal/i)).toBeInTheDocument()
    // Bloklamak urunu yanlis tarif ederdi: testnet profilinde 1 USDC'lik bir
    // alim arzin ceyregini goturur, ve bu bir hata degil egrinin kendisidir.
    expect(q.queryByRole('button')).toBeNull()
  })

  it('leaves a small move uncoloured and unannotated', () => {
    const { q, node } = renderQuote('spend', 1_000_000_000_000n, FRESH, FRESH_PRICE_WEI)
    expect(node('quote-impact')).not.toHaveClass('text-negative')
    expect(q.queryByText(/High price impact is normal/i)).toBeNull()
  })

  it('reads negative on a sell, and the magnitude crosses the same threshold', () => {
    const { text, node } = renderSell()
    expect(text('quote-impact')).toBe('-33.91%')
    expect(node('quote-impact')).toHaveClass('text-negative')
  })
})
