import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurveState, FeeBps } from '@arcpad/shared/browser'
import { TradePanel } from '@/components/token/TradePanel'
import type { HexAddress } from '@/components/read/types'
import { renderWithProviders } from '../ui/harness'
import { COMPLETED, CURVE, FEES, FRESH, TESTNET_PROFILE, TOKEN } from './fixtures'

/**
 * PANEL, VERITABANI OLUYKEN.
 *
 * Iki kapi birlikte calisiyor ve ikisi de gerekli:
 *
 *   (a) `@arcpad/db` HIC YUKLENMEZ. Sahte fabrikanin kendisi ATIYOR, yani
 *       panelin modul grafinde o pakete giden bir kenar VARSA test import
 *       aninda ve yuksek sesle duser. Bir "import etmiyoruz" yorumundan farki
 *       bu: yorum bir niyet, bu bir olcum.
 *   (b) `getPool` HER CAGRIDA atiyor. Veritabani yalnizca yok degil, BOZUK --
 *       ve panel yine kota uretiyor, yine gonderilebilir durumda.
 *
 * ZINCIR OKUMASI SAHTELENDI, ve bu bilincli: jsdom'da zincir YOK. Sahtelenen
 * sey testin OLCTUGU sey degil; olculen sey veritabaninin olusunun paneli
 * etkilemedigi. Rezerv okumasinin kendisi `useCurveState`'in kendi testinde
 * (`curveReadFrom`) ve Task 15'in anvil vakalarinda olculuyor.
 */

vi.mock('@arcpad/db', () => {
  throw new Error(
    '@arcpad/db reached the trade panel. It carries `pg`, so this is a build failure waiting to happen.',
  )
})

vi.mock('@/lib/db', () => ({
  getPool: () => {
    throw new Error('database is down')
  },
  setPoolForTesting: () => {},
  DatabaseNotConfigured: class DatabaseNotConfigured extends Error {},
}))

const chain = vi.hoisted(() => ({
  state: undefined as CurveState | undefined,
  fees: undefined as FeeBps | undefined,
  refetched: 0,
}))

vi.mock('@/components/token/useCurveState', () => ({
  CURVE_STATE_POLL_MS: 2000,
  useCurveState: () => ({
    state: chain.state,
    fees: chain.fees,
    isPending: chain.state === undefined,
    refetch: () => {
      chain.refetched += 1
    },
  }),
}))

function renderPanel(lifecycleKind: 'trading' | 'complete' = 'trading') {
  return renderWithProviders(
    <TradePanel
      token={TOKEN as HexAddress}
      curve={CURVE as HexAddress}
      lifecycle={lifecycleKind === 'trading' ? { kind: 'trading' } : { kind: 'complete' }}
      profile={TESTNET_PROFILE}
      profileName="testnet"
      symbol="DIFF"
    />,
    { connected: true },
  )
}

beforeEach(() => {
  chain.state = FRESH
  chain.fees = FEES
  chain.refetched = 0
})

describe('the panel does not need the database', () => {
  it('quotes a trade while every getPool() call throws', async () => {
    const user = userEvent.setup()
    renderPanel()

    await waitFor(() => expect(screen.getByTestId('trade-panel')).toBeInTheDocument())
    await user.type(screen.getByRole('textbox', { name: /amount to spend/i }), '1')

    // Kota ureildi -- ve olculmus vektorun ta kendisi.
    expect(screen.getByTestId('quote-curve').textContent).toBe('0.987654 USDC')
    expect(screen.getByTestId('quote-result').textContent).toBe('~200,723,953.120761 DIFF')
  })

  it('leaves the trade sendable: the RPC being unreachable is not a refusal', async () => {
    const user = userEvent.setup()
    renderPanel()

    await waitFor(() => expect(screen.getByTestId('trade-panel')).toBeInTheDocument())
    await user.type(screen.getByRole('textbox', { name: /amount to spend/i }), '1')

    // Simulasyon bu ortamda AGDAN dolayi kosamiyor. `blocked` degil
    // `unverified`: simulasyonun basarisizligi islemin basarisizligi demek
    // degildir, ve gonderme acik kalir.
    await waitFor(() => {
      expect(screen.getByTestId('trade-submit').textContent).toBe('Buy DIFF')
    })
    expect(screen.getByTestId('trade-submit')).toBeEnabled()
  })

  it('reads its addresses from the caller and the address book, never a literal', () => {
    renderPanel()
    // Faz 2 `LaunchFactory`'yi yeniden dagitiyor (yapicisi bir `feeSchedule`
    // argumani aliyor), yani panele kopyalanmis bir adres sessizce olu bir
    // kontrata bakardi. Gezgin adresi de defterden geliyor.
    const link = screen.queryByRole('link')
    expect(link).toBeNull()
    expect(screen.getByTestId('trade-panel')).toBeInTheDocument()
  })
})

describe('a completed curve has no panel at all', () => {
  it('draws nothing when the lifecycle says complete', () => {
    const { container } = renderPanel('complete')
    // Uc giris noktasi da `CurveComplete()` ile revert eder; bir "Buy"
    // dugmesi cizmek, basildiginda kesin olarak basarisiz olacak bir sey
    // gostermek olurdu.
    expect(container.querySelector('[data-testid="trade-panel"]')).toBeNull()
  })

  it('draws nothing when the CHAIN says complete, even if the row still says trading', () => {
    // Veritabani satiri birkac blok geride olabilir; zincirin `complete`'i
    // gecerli olandir. Yalnizca `lifecycle`'a bakan bir panel, kapanmis bir
    // curve'de calisir gorunurdu.
    chain.state = COMPLETED
    const { container } = renderPanel('trading')
    expect(container.querySelector('[data-testid="trade-panel"]')).toBeNull()
  })

  it('draws nothing while the reserves are still unknown', () => {
    // Rezervsiz bir panel, kotasiz bir panel demek. Bos bir cerceve,
    // kullaniciya gelmeyecek bir sey vaat eder.
    chain.state = undefined
    chain.fees = undefined
    const { container } = renderPanel('trading')
    expect(container.querySelector('[data-testid="trade-panel"]')).toBeNull()
  })
})
