import {
  formatTokenAmount,
  planBuyExactQuoteIn,
  resolveSellForNet,
  type TradePlan,
  USDC_VIEW_SCALE,
} from '@arcpad/shared/browser'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TradeForm, type TradeFormProps } from '@/components/token/TradePanel'
import type { RealisedTrade } from '@/components/token/useTrade'
import type { TradeRow } from '@/components/read/types'
import {
  CLIMBED,
  CREATOR,
  PRODUCTION_FRESH,
  PRODUCTION_HOLDING,
  PRODUCTION_PROFILE,
  FEES,
  FRESH,
  ONE_USDC,
  ONE_USDC_MIN_TOKENS,
  ONE_USDC_TOKENS,
  TESTNET_PROFILE,
  TRADER,
} from './fixtures'

/**
 * PANELIN DAVRANISI.
 *
 * `TradeForm` -- panelin SAF yarisi -- cizdiriliyor: zincire giden her sey
 * (rezerv okumasi, simulasyon, onay, gaz tahmini) prop olarak veriliyor. Bunun
 * sebebi bir kolaylik degil: bir sekmenin HANGI giris noktasina gittigini
 * olcmek icin gereken sey `onSubmit`'e ULASAN PLAN, ve o plani bir RPC'nin
 * arkasindan okumak testi zincire baglar -- yani uc giris noktasindan biri
 * kirildiginda test AGDAN dolayi kirilmis gibi gorunur.
 */

const DEFAULTS: TradeFormProps = {
  symbol: 'DIFF',
  state: FRESH,
  profile: TESTNET_PROFILE,
  profileName: 'testnet',
  fees: FEES,
  connection: 'connected',
  chainName: 'Arc Testnet',
  spendable: 10n * ONE_USDC,
  gasReason: null,
  usdcBalance: 10n * ONE_USDC,
  tokenBalance: 0n,
  approval: 'notNeeded',
  approvalPhase: 'idle',
  simulation: { kind: 'ok' },
  phase: 'idle',
  failure: null,
  realised: null,
}

function setup(overrides: Partial<TradeFormProps> = {}) {
  const onSubmit = vi.fn<(plan: TradePlan) => void>()
  const onApprove = vi.fn()
  const onConnect = vi.fn()
  const onSwitch = vi.fn()
  const view = render(
    <TradeForm
      {...DEFAULTS}
      {...overrides}
      onSubmit={onSubmit}
      onApprove={onApprove}
      onConnect={onConnect}
      onSwitch={onSwitch}
    />,
  )
  const q = within(view.container)
  return {
    q,
    onSubmit,
    onApprove,
    onConnect,
    onSwitch,
    user: userEvent.setup(),
    button: () => q.getByTestId('trade-submit'),
    field: () => q.getByRole('textbox', { name: /amount|tokens/i }),
    tab: (name: RegExp) => q.getByRole('tab', { name }),
    /*
     * ============ UC DURUM, IKI KONTROL ============
     *
     * Panel artik once NIYETI soruyor (Buy / Sell), sonra -- yalnizca alimda
     * -- BIRIMI (USDC / token). Model uc durumlu kaldi; degisen sey sunum.
     * Testler bu yuzden yardimcidan gecer: iddialar (hangi giris noktasina
     * gidiliyor, alan temizleniyor mu, hangi cip hangi sayiyi dolduruyor)
     * AYNEN duruyor, yalnizca onlara ULASMA yolu degisti.
     */
    goBuySpend: async (u: ReturnType<typeof userEvent.setup>) => {
      await u.click(q.getByRole('tab', { name: /^Buy$/ }))
      const toggle = q.queryByTestId('buy-unit-toggle')
      // Hap "su an hangi birimdesin"i yazar; token yaziyorsa USDC'ye gec.
      if (toggle !== null && !/USDC/.test(toggle.textContent ?? '')) await u.click(toggle)
    },
    goBuyReceive: async (u: ReturnType<typeof userEvent.setup>) => {
      await u.click(q.getByRole('tab', { name: /^Buy$/ }))
      const toggle = q.getByTestId('buy-unit-toggle')
      if (/USDC/.test(toggle.textContent ?? '')) await u.click(toggle)
    },
  }
}

const SELL_DEFAULTS: Partial<TradeFormProps> = {
  state: CLIMBED,
  tokenBalance: 10n ** 30n,
}

// --------------------------------------------------------------------------
// Uc sekme, uc giris noktasi -- ve HER BIRININ KENDI TESTI
// --------------------------------------------------------------------------

describe('each tab reaches its own entrypoint', () => {
  it('Spend USDC sends buyExactQuoteIn with the budget as msg.value', async () => {
    const t = setup()
    await t.user.type(t.field(), '1')
    await t.user.click(t.button())

    expect(t.onSubmit).toHaveBeenCalledTimes(1)
    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    // "Spend USDC sekmesini buyExactTokensOut'a haritala" MUTANTI BURADA OLUR:
    // o giris noktasinin ilk argumani token miktaridir ve `value` bir UST
    // SINIRDIR, butce degil.
    expect(plan.action).toBe('buyExactQuoteIn')
    expect(plan.args).toEqual([ONE_USDC_MIN_TOKENS])
    expect(plan.value).toBe(ONE_USDC)
  })

  it('Receive tokens sends buyExactTokensOut with a fee-inclusive cap', async () => {
    const t = setup()
    await t.goBuyReceive(t.user)
    await t.user.type(t.field(), '1000000')
    await t.user.click(t.button())

    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    expect(plan.action).toBe('buyExactTokensOut')
    expect(plan.args[0]).toBe(1_000_000_000_000_000_000_000_000n)
    expect(plan.value).toBe(plan.args[1])
    expect(plan.value).toBeGreaterThan(plan.curveAmount + plan.protocolFee + plan.creatorFee - 1n)
  })

  it('Sell sends sellExactTokensIn with a zero msg.value', async () => {
    const t = setup({ ...SELL_DEFAULTS, approval: 'sufficient' })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '1000')
    await t.user.click(t.button())

    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    expect(plan.action).toBe('sellExactTokensIn')
    expect(plan.value).toBe(0n)
  })

  it('clears the field when the unit changes with the tab', async () => {
    // "1.5" bir USDC tutariyken sekme degisince 1,5 TOKEN olurdu ve kullanici
    // bunu fark etmezdi -- ayni rakam, bin kat farkli anlam.
    const t = setup()
    await t.user.type(t.field(), '1.5')
    expect(t.field()).toHaveValue('1.5')
    await t.goBuyReceive(t.user)
    expect(t.field()).toHaveValue('')
  })

  it('ALIM VARSAYILAN, birim USDC, ve SEBEBI ekranda yazili', () => {
    const t = setup()
    // Niyet: alim. Panel bir launchpad'de acilir ve orada varsayilan niyet
    // almaktir; satis, elinde bir sey olan birinin arayacagi seydir.
    expect(t.tab(/^Buy$/)).toHaveAttribute('aria-selected', 'true')
    // Birim: USDC, yani `buyExactQuoteIn`. Bu, rezervin tepesinde revert
    // ETMEYEN tek alim yolu -- butce kirpilir, kalan ayni islemde iade edilir.
    expect(t.q.getByTestId('buy-unit-toggle').textContent).toMatch(/USDC/)
    expect(t.q.getByTestId('tab-rationale').textContent).toMatch(
      /clamped and the remainder is refunded/i,
    )
  })
})

// --------------------------------------------------------------------------
// Kelepce -- ve yalnizca kelepceleyen sekmede
// --------------------------------------------------------------------------

describe('the Receive tokens clamp', () => {
  it('reduces the order to the reserve AND says so', async () => {
    const t = setup({
      state: CLIMBED,
      spendable: 1_000n * ONE_USDC,
      usdcBalance: 1_000n * ONE_USDC,
    })
    await t.goBuyReceive(t.user)
    await t.user.type(t.field(), '999999999')

    expect(t.q.getByTestId('clamp-notice').textContent).toContain(
      'Only 592,376,046.879238 left on the curve.',
    )
    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    // Sessiz bir kelepce, kullanicinin yazdigi sayidan BASKA bir sey
    // imzalatmak olurdu.
    expect(plan.args[0]).toBe(CLIMBED.realTokenReserves)
  })

  it('does NOT clamp the Spend USDC tab: the chain clamps that one and refunds', async () => {
    const t = setup({
      state: CLIMBED,
      spendable: 10_000n * ONE_USDC,
      usdcBalance: 10_000n * ONE_USDC,
    })
    await t.user.type(t.field(), '9999')

    expect(t.q.queryByTestId('clamp-notice')).toBeNull()
    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    expect(plan.value).toBe(9_999n * ONE_USDC)
    expect(plan.clamped).toBe(true)
    // Butce KISILDI ama girdi kisilmadi: artan zincirde iade edilir.
    expect(plan.refund).toBeGreaterThan(0n)
  })
})

// --------------------------------------------------------------------------
// MAX ve gaz payi
// --------------------------------------------------------------------------

describe('MAX and the gas reserve', () => {
  it('spends the SPENDABLE balance, never the whole balance', async () => {
    const balance = ONE_USDC
    const spendable = balance - 300_000_000_000_000n
    const t = setup({ usdcBalance: balance, spendable })

    await t.user.click(t.q.getByTestId('max-button'))
    expect(t.field()).toHaveValue('0.999700')

    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    // `spendable` yerine `balance` kullanan mutant burada 1e18 gonderirdi ve
    // islem gaz icin para bulamazdi.
    expect(plan.value).toBe(spendable)
    expect(plan.value).toBeLessThan(balance)
  })

  it('explains why MAX is below the balance rather than leaving it unexplained', () => {
    const t = setup({ usdcBalance: ONE_USDC, spendable: ONE_USDC - 300_000_000_000_000n })
    // `<Money unit>` birimi ayri bir `<span class="ml-1">` olarak ciziyor:
    // aradaki bosluk CSS'ten geliyor, metinden degil.
    expect(t.q.getByTestId('gas-reserve-note').textContent).toMatch(/0\.000300\s*USDC/)
    expect(t.q.getByTestId('gas-reserve-note').textContent).toMatch(/gas asset is USDC too/i)
  })

  it('produces NOTHING at all when the balance is exactly the transaction cost', async () => {
    const t = setup({ usdcBalance: 300_000_000_000_000n, spendable: 0n })
    await t.user.click(t.q.getByTestId('max-button'))
    expect(t.field()).toHaveValue('0.000000')
    // Ve boyle bir tutar gonderilemez: buton "Enter an amount"ta kalir.
    expect(t.button()).toBeDisabled()
    expect(t.button().textContent).toBe('Enter an amount')
  })

  it('disables MAX, with a reason, when the estimate failed', () => {
    const t = setup({ spendable: null, gasReason: 'Gas could not be estimated right now.' })
    const button = t.q.getByTestId('max-button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Gas could not be estimated right now.')
  })

  it('is the ONLY fraction-of-balance control: the percentages are gone', () => {
    // `25% · 50% · 75%` were removed deliberately. MAX stays because it carries
    // a number the user cannot see -- the per-transaction gas reserve -- and a
    // quarter of a printed balance carries nothing.
    const t = setup()
    for (const percent of [25, 50, 75]) {
      expect(t.q.queryByTestId(`shortcut-${percent}`)).toBeNull()
    }
    expect(t.q.getByTestId('max-button')).toBeInTheDocument()
  })

  it('divides the TOKEN balance on the sell tab, where gas is not the constraint', async () => {
    const t = setup({ ...SELL_DEFAULTS, tokenBalance: ONE_USDC_TOKENS, approval: 'sufficient' })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.click(t.q.getByTestId('max-button'))
    expect(t.field()).toHaveValue('200723953.120761')
  })
})

// --------------------------------------------------------------------------
// Buton sirasi, cizilmis hâliyle
// --------------------------------------------------------------------------

describe('the button, on screen', () => {
  it('asks for a wallet before it asks for anything else', () => {
    const t = setup({ connection: 'disconnected', spendable: null })
    expect(t.button().textContent).toBe('Connect wallet')
    expect(t.button()).toBeEnabled()
  })

  it('names the chain from the registry rather than a literal', () => {
    const t = setup({ connection: 'wrongNetwork', chainName: 'Arc Testnet' })
    expect(t.button().textContent).toBe('Switch to Arc Testnet')
  })

  it('refuses to send when the simulation reverted, and shows the resolved reason', async () => {
    const failure = {
      kind: 'contract' as const,
      action: 'buyExactQuoteIn' as const,
      name: 'SlippageExceeded',
      title: 'The price moved past your tolerance',
      detail: 'The contract refused this buyExactQuoteIn with SlippageExceeded().',
      remedy: 'Raise the tolerance or try again.',
      retryable: false,
      raw: null,
    }
    const t = setup({ simulation: { kind: 'blocked', failure } })
    await t.user.type(t.field(), '1')

    expect(t.button().textContent).toBe('The price moved past your tolerance')
    expect(t.button()).toBeDisabled()
    expect(t.q.getByTestId('sim-blocked').textContent).toContain('Raise the tolerance')
    await t.user.click(t.button())
    // Cuzdan penceresi HIC acilmaz.
    expect(t.onSubmit).not.toHaveBeenCalled()
  })

  it('stays open, with a warning, when the simulation failed on the NETWORK', async () => {
    const failure = {
      kind: 'network' as const,
      action: 'buyExactQuoteIn' as const,
      name: 'NetworkError',
      title: 'The network did not answer',
      detail: '',
      retryable: true,
      raw: null,
    }
    const t = setup({ simulation: { kind: 'unverified', failure } })
    await t.user.type(t.field(), '1')

    // Simulasyonun basarisizligi islemin basarisizligi demek DEGILDIR.
    expect(t.button().textContent).toBe('Buy DIFF')
    expect(t.button()).toBeEnabled()
    expect(t.q.getByTestId('sim-unverified').textContent).toContain('The network did not answer')
    await t.user.click(t.button())
    expect(t.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('shows the wallet balance as ONE figure', () => {
    const t = setup({ usdcBalance: 12_345_678_000_000_000_000n })
    // Ayni fonun iki gorunumu (18 ondalikli native, 6 ondalikli ERC-20) iki
    // satir olarak yazilirsa 1e12'lik bir hatanin hicbir isareti kalmaz.
    const balances = t.q.getAllByText(/12\.345678/)
    expect(balances).toHaveLength(1)
  })
})

// --------------------------------------------------------------------------
// Satis iki islemdir
// --------------------------------------------------------------------------

describe('the sell is two transactions', () => {
  it('asks for the approval first, and sends NOTHING when it is pressed', async () => {
    const t = setup({ ...SELL_DEFAULTS, approval: 'required' })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '1000')

    expect(t.button().textContent).toBe('Approve DIFF')
    await t.user.click(t.button())

    expect(t.onApprove).toHaveBeenCalledTimes(1)
    // "approve onayindan sonra satisi otomatik gonder" MUTANTI BURADA OLUR.
    expect(t.onSubmit).not.toHaveBeenCalled()
  })

  it('names the two steps and the EXACT allowance, never an unlimited one', async () => {
    const t = setup({ ...SELL_DEFAULTS, approval: 'required' })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '1000')

    const steps = t.q.getByTestId('approve-steps')
    expect(within(steps).getByTestId('approve-step-1').textContent).toBe(
      'Approve DIFF (allowance: 1,000.000000 DIFF)',
    )
    expect(within(steps).getByTestId('approve-step-2').textContent).toBe('Sell')
  })

  it('hides the steps entirely once the allowance is enough', async () => {
    const t = setup({ ...SELL_DEFAULTS, approval: 'sufficient' })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '1000')

    // Zaten onaylamis bir kullaniciya "1. Approve" gostermek, yapilmis bir isi
    // yeniden yapilacak gibi gosterir.
    expect(t.q.queryByTestId('approve-steps')).toBeNull()
    expect(t.button().textContent).toBe('Sell DIFF')
  })

  it('never shows an approval on the buy side: msg.value needs no allowance', async () => {
    const t = setup({ approval: 'required' })
    await t.user.type(t.field(), '1')
    expect(t.q.queryByTestId('approve-steps')).toBeNull()
  })
})

// --------------------------------------------------------------------------
// Onaylanan miktarlar OLAYDAN
// --------------------------------------------------------------------------

function realisedRow(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    eventSeq: 4_194_304n,
    txHash: `0x${'11'.repeat(32)}`,
    blockTime: new Date('2026-08-01T12:00:00.000Z'),
    trader: TRADER,
    isBuy: true,
    tokenAmountTok: 592_376_046_879_238_259_473_675_895n,
    quoteAmountWei: 987_654_320_987_654_320n,
    protocolFeeWei: 9_382_716_049_382_717n,
    creatorFeeWei: 2_962_962_962_962_963n,
    virtualTokenReservesTok: CLIMBED.virtualTokenReserves,
    virtualQuoteReservesWei: CLIMBED.virtualQuoteReserves,
    realTokenReservesTok: 0n,
    realQuoteReservesWei: 987_654_320_987_654_320n,
    isDev: false,
    // Bir `BondingCurve.Trade` makbuzundan kurulan IYIMSER satir; mekani
    // tartismasiz egridir (`useTrade.realisedFromReceipt` de boyle yazar).
    source: 'curve',
    ...overrides,
  }
}

describe('the confirmed trade', () => {
  it('shows the amounts from the EVENT, not the amounts from the quote', async () => {
    const realised: RealisedTrade = {
      row: realisedRow(),
      walletDeltaWei: ONE_USDC,
      refundWei: 7_686_548_000_000_000_000n,
      clamped: true,
    }
    const t = setup({ realised })
    await t.user.type(t.field(), '1')

    // Kota 200,723,953.120761 diyordu; GERCEKLESEN 592,376,046.879238.
    // "Onaylanan miktari kotadan goster" MUTANTI BURADA OLUR.
    expect(t.q.getByTestId('realised-tokens').textContent).toBe('592,376,046.879238 DIFF')
    expect(t.q.getByTestId('quote-result').textContent).toBe('~200,723,953.120761 DIFF')
  })

  it('names the refund when the buy was filled to the remaining supply', () => {
    const realised: RealisedTrade = {
      row: realisedRow(),
      walletDeltaWei: ONE_USDC,
      refundWei: 7_686_548_000_000_000_000n,
      clamped: true,
    }
    const t = setup({ realised })
    expect(t.q.getByTestId('realised-refund').textContent).toMatch(
      /^Filled to the remaining supply; 7\.686548\s*USDC refunded\.$/,
    )
  })

  it('stays silent about a one-wei refund, which cannot even be drawn', () => {
    const realised: RealisedTrade = {
      row: realisedRow(),
      walletDeltaWei: ONE_USDC,
      refundWei: 1n,
      clamped: false,
    }
    const t = setup({ realised })
    expect(t.q.queryByTestId('realised-refund')).toBeNull()
  })
})

describe('the transaction lifecycle', () => {
  it('shows the hash and an explorer link the moment it is pending', () => {
    const t = setup({
      phase: 'pending',
      hash: `0x${'ab'.repeat(32)}`,
      explorerUrl: 'https://testnet.arcscan.app',
    })
    // Arc'in finality'si ~350 ms, yani bu durum kisa omurlu -- ama
    // ATLANMAZ: imzadan sonra hicbir ara durum gostermemek, islemin
    // kayboldugu izlenimini verir.
    const pending = t.q.getByTestId('tx-pending')
    expect(within(pending).getByRole('link')).toHaveAttribute(
      'href',
      `https://testnet.arcscan.app/tx/0x${'ab'.repeat(32)}`,
    )
  })

  /*
   * IKI HAL, VE IKINCISI BIRINCININ KONTROLU.
   *
   * Bu blok eskiden TEK bir iddiaydi -- "basarisizligin basligi, detayi ve
   * caresi yaziliyor" -- ve panel kullanici reddini de KIRMIZI BIR KUTUYA
   * koyarken YESILDI. Baslik/detay/care sorgulamak, TONU hic sormaz.
   *
   * Simdi iki hal birlikte olculuyor: nötr olan kutu CIZMEZ, sozlesme reddi
   * CIZER. Nötr dal kaldirilirsa ilki, ton ayrimi kaldirilirsa ikincisi kirilir
   * -- ve ikisi ayni anda gecemez.
   */
  it('a wallet rejection is a DECISION: neutral tone, no box, and the amounts stay', async () => {
    const t = setup({
      failure: {
        kind: 'wallet',
        action: 'buyExactQuoteIn',
        name: 'UserRejected',
        title: 'Transaction cancelled',
        detail: 'You rejected the request in your wallet.',
        remedy: 'Try again when you are ready.',
        retryable: false,
        raw: null,
      },
    })
    await t.user.type(t.q.getByLabelText('Amount to spend'), '0.25')

    const notice = t.q.getByTestId('failure-notice')
    expect(notice.getAttribute('data-tone')).toBe('neutral')
    expect(notice.getAttribute('data-name')).toBe('UserRejected')
    // KUTU YOK: cerceve sinifi da kirmizi zemin de bulunmamali.
    expect(notice.className).not.toMatch(/border|bg-negative/)
    expect(notice.textContent).toContain('Cancelled.')
    // Girdi KORUNUR. "Nothing was sent" derken formu bosaltmak, kullaniciya
    // iptalin bir bedeli oldugunu ogretir.
    expect((t.q.getByLabelText('Amount to spend') as HTMLInputElement).value).toBe('0.25')
  })

  it('a contract refusal DOES draw the box -- the control for the case above', () => {
    const t = setup({
      failure: {
        kind: 'contract',
        action: 'buyExactQuoteIn',
        name: 'CurveComplete',
        title: 'ignored: the copy comes from the error surface',
        detail: 'ignored',
        retryable: false,
        raw: null,
      },
    })
    const notice = t.q.getByTestId('failure-notice')
    expect(notice.getAttribute('data-tone')).not.toBe('neutral')
    expect(notice.className).toMatch(/border/)
  })
})

describe('a fixture guard', () => {
  it('keeps the panel fixtures aligned with the read-model ones', () => {
    // `CLIMBED` ve `readModel.ts`'in `CLIMBING`'i AYNI ANI tarif ediyor. Ikisi
    // ayrisirsa bu dosyanin sabitleri sessizce baska bir curve'u anlatir.
    expect(CLIMBED.creator).toBe(CREATOR)
    expect(FRESH.realTokenReserves).toBe(TESTNET_PROFILE.saleSupply)
    expect(screen).toBeDefined()
  })
})

// --------------------------------------------------------------------------
// Mutlak para kisayollari -- UC SEKMEDE DE, AYNI EKRANDA
// --------------------------------------------------------------------------

/**
 * ==========================================================================
 *  THE MONEY CHIPS, PRESSED -- AND FOLLOWED ALL THE WAY TO THE PLAN
 * ==========================================================================
 *
 * `test/trade/model.test.ts` proves `amountChipsFor` resolves the right
 * quantity. THAT IS NOT THIS. The defect this repository keeps shipping is a
 * correct function that the screen never reaches, or reaches with the wrong
 * argument -- `TradePanel` measured by 645 tests while no page drew it, two
 * switch controls on one composed screen with both component tests green. So
 * these press the button on the assembled panel and read what comes out of
 * `onSubmit`: the field text, the unit, and the calldata.
 *
 * PRODUCTION FIXTURES, BECAUSE THE REAL ONES CANNOT CARRY THE LADDER. See
 * `fixtures.ts`: on the deployed profile all three chips are unfillable and the
 * row is empty, which is asserted separately and on purpose.
 */
describe('the money chips', () => {
  const PRODUCTION: Partial<TradeFormProps> = {
    state: PRODUCTION_FRESH,
    profile: PRODUCTION_PROFILE,
    profileName: 'production',
    spendable: 10_000n * ONE_USDC,
    usdcBalance: 10_000n * ONE_USDC,
    tokenBalance: PRODUCTION_HOLDING,
  }

  it('draws $25 / $100 / $500 when the curve can carry them', () => {
    const t = setup(PRODUCTION)
    const row = t.q.getByTestId('amount-chips')
    expect(within(row).getByTestId('chip-25')).toHaveTextContent('$25')
    expect(within(row).getByTestId('chip-100')).toHaveTextContent('$100')
    expect(within(row).getByTestId('chip-500')).toHaveTextContent('$500')
  })

  it('Spend USDC: $25 fills 25 and sends it as msg.value', async () => {
    const t = setup(PRODUCTION)
    await t.user.click(t.q.getByTestId('chip-25'))
    expect(t.field()).toHaveValue('25.000000')

    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    expect(plan.action).toBe('buyExactQuoteIn')
    expect(plan.value).toBe(25n * ONE_USDC)
    // The chip promised twenty-five dollars and twenty-five dollars is what
    // leaves the wallet -- no clamp, no surprise refund.
    expect(plan.clamped).toBe(false)
  })

  it('Receive tokens: $100 fills TOKENS, not the number 100', async () => {
    const t = setup(PRODUCTION)
    await t.goBuyReceive(t.user)
    await t.user.click(t.q.getByTestId('chip-100'))

    // THE UNIT MUTANT. Writing `100` into a token field would ask for one
    // hundred tokens; both views are 1e18-scaled so nothing on screen looks
    // wrong. The field must carry the token quantity that budget buys.
    expect(t.field()).not.toHaveValue('100.000000')
    const expected = planBuyExactQuoteIn(
      PRODUCTION_FRESH,
      PRODUCTION_PROFILE,
      FEES,
      100n * ONE_USDC,
      0,
    )
    expect(t.field()).toHaveValue(formatTokenAmount(expected.tokens).replace(/,/g, ''))

    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    expect(plan.action).toBe('buyExactTokensOut')
  })

  it('Sell: $25 fills a token quantity resolved in the SELL direction', async () => {
    const t = setup({ ...PRODUCTION, approval: 'sufficient' })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.click(t.q.getByTestId('chip-25'))

    // THE QUANTUM IS PASSED HERE TOO, and that is the point of the assertion:
    // the field carries six decimals, so the resolved quantity has to be one
    // the field can express. Without it this expectation reads
    // `6366667.853370` while the panel writes `6366667.853371` -- and the
    // difference is the guarantee that the chip delivers $25 rather than
    // 24.999999999996747628.
    const found = resolveSellForNet(
      PRODUCTION_FRESH,
      PRODUCTION_PROFILE,
      FEES,
      25n * ONE_USDC,
      PRODUCTION_HOLDING,
      USDC_VIEW_SCALE,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    // Six decimals is the field's quantum, so the comparison is on the text the
    // field actually carries.
    expect(t.field()).toHaveValue(formatTokenAmount(found.tokensIn).replace(/,/g, ''))

    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as TradePlan
    expect(plan.action).toBe('sellExactTokensIn')
    expect(plan.value).toBe(0n)
    // AND THE MONEY ARRIVES. The chip said $25; the plan's net proceeds must
    // reach it. A buy-side resolution lands here and falls short.
    expect(plan.curveAmount - plan.protocolFee - plan.creatorFee).toBeGreaterThanOrEqual(
      25n * ONE_USDC,
    )
  })

  it('the SAME chip fills three different numbers on the three tabs', async () => {
    // One ladder, three units. If any two of these agreed, a conversion would
    // be missing.
    const t = setup({ ...PRODUCTION, approval: 'sufficient' })
    await t.user.click(t.q.getByTestId('chip-25'))
    const spend = (t.field() as HTMLInputElement).value

    await t.goBuyReceive(t.user)
    await t.user.click(t.q.getByTestId('chip-25'))
    const receive = (t.field() as HTMLInputElement).value

    await t.user.click(t.tab(/^Sell$/))
    await t.user.click(t.q.getByTestId('chip-25'))
    const sell = (t.field() as HTMLInputElement).value

    expect(new Set([spend, receive, sell]).size).toBe(3)
    // And the sell quantity is the LARGER of the two token figures: the curve
    // pays less for a token than it charges for one.
    expect(Number(sell)).toBeGreaterThan(Number(receive))
  })

  it('the gas reserve binds the chips exactly as it binds MAX', async () => {
    // Holding exactly $100, with the reserve inside it: the $100 chip is gone
    // and MAX writes less than $100. The coordinator's `$500` case, measurable.
    const balance = 100n * ONE_USDC
    const spendable = balance - 300_000_000_000_000n
    const t = setup({ ...PRODUCTION, spendable, usdcBalance: balance })

    expect(t.q.queryByTestId('chip-100')).toBeNull()
    expect(t.q.queryByTestId('chip-500')).toBeNull()
    expect(t.q.getByTestId('chip-25')).toBeInTheDocument()

    await t.user.click(t.q.getByTestId('max-button'))
    expect(t.field()).toHaveValue('99.999700')
  })

  it('draws the TESTNET ladder on the deployed profile', () => {
    // The default fixtures ARE the deployed profile, and its ladder is
    // $1/$5/$10 -- a testnet curve absorbs 12.161433 USDC in total, so these
    // fit and $25 would not.
    const t = setup()
    const row = t.q.getByTestId('amount-chips')
    expect(within(row).getByTestId('chip-1')).toHaveTextContent('$1')
    expect(within(row).getByTestId('chip-5')).toHaveTextContent('$5')
    expect(within(row).getByTestId('chip-10')).toHaveTextContent('$10')
    expect(t.q.queryByTestId('chip-25')).toBeNull()
  })

  it('suppresses the row when the PRODUCTION ladder meets a testnet curve', () => {
    // The invariant that survives the ladder being right: a chip that cannot be
    // resolved is not rendered. Same curve, production ladder, nothing drawn.
    const t = setup({ profileName: 'production' })
    expect(t.q.queryByTestId('amount-chips')).toBeNull()
    // MAX is untouched -- it is sized from the user's balance, not a ladder.
    expect(t.q.getByTestId('max-button')).toBeInTheDocument()
  })

  it('draws no row when the gas estimate failed, on either buy tab', async () => {
    const t = setup({ ...PRODUCTION, spendable: null, gasReason: 'no estimate' })
    expect(t.q.queryByTestId('amount-chips')).toBeNull()
    await t.goBuyReceive(t.user)
    expect(t.q.queryByTestId('amount-chips')).toBeNull()
  })
})
