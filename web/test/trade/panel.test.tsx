import type { TradePlan } from '@arcpad/shared/browser'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TradeForm, type TradeFormProps } from '@/components/token/TradePanel'
import type { RealisedTrade } from '@/components/token/useTrade'
import type { TradeRow } from '@/components/read/types'
import {
  CLIMBED,
  CREATOR,
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
    await t.user.click(t.tab(/Receive tokens/))
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
    await t.user.click(t.tab(/Receive tokens/))
    expect(t.field()).toHaveValue('')
  })

  it('defaults to Spend USDC and says WHY on screen', () => {
    const t = setup()
    expect(t.tab(/Spend USDC/)).toHaveAttribute('aria-selected', 'true')
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
    await t.user.click(t.tab(/Receive tokens/))
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

    await t.user.click(t.q.getByTestId('shortcut-100'))
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
    await t.user.click(t.q.getByTestId('shortcut-100'))
    expect(t.field()).toHaveValue('0.000000')
    // Ve boyle bir tutar gonderilemez: buton "Enter an amount"ta kalir.
    expect(t.button()).toBeDisabled()
    expect(t.button().textContent).toBe('Enter an amount')
  })

  it('disables every shortcut, with a reason, when the estimate failed', () => {
    const t = setup({ spendable: null, gasReason: 'Gas could not be estimated right now.' })
    for (const percent of [25, 50, 75, 100]) {
      const button = t.q.getByTestId(`shortcut-${percent}`)
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', 'Gas could not be estimated right now.')
    }
  })

  it('divides the TOKEN balance on the sell tab, where gas is not the constraint', async () => {
    const t = setup({ ...SELL_DEFAULTS, tokenBalance: ONE_USDC_TOKENS, approval: 'sufficient' })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.click(t.q.getByTestId('shortcut-100'))
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
