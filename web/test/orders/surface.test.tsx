import { screen, within } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { resolveLifecycle } from '@/components/token/lifecycle'
import { TradeSurface } from '@/components/token/TradeSurface'
import { CURVE, TESTNET_PROFILE, TOKEN } from '../trade/fixtures'
import { renderWithProviders } from '../ui/harness'

/**
 * ==========================================================================
 *  `Market | Limit | Orders` -- CIZILIYOR MU, VE TIKLANINCA BIR SEY YAPIYOR MU
 * ==========================================================================
 *
 * Faz 4 bu seridi ADIYLA ertelemisti: *"bu fazda yalnizca `Market` sekmesi
 * render edilir, diger ikisi hic cizilmez. Tiklandiginda hicbir sey yapmayan
 * bir sekme, olmayan bir sekmeden kotudur."* Bu dosya o cumlenin artik
 * gecerli OLMADIGINI olcer -- ve "gecerli degil"in olcumu, sekmeye TIKLAYIP
 * ICINDEN BIR SEY CIKTIGINI gormektir. Serit `items`ta gorunup panel
 * cizilmeseydi, tam olarak Faz 4'un yasakladigi seyi yapmis olurduk.
 *
 * BU DEPONUN 1 NUMARALI ARIZA SEKLI BURADA DA GECERLI ("bir bilesenin testi,
 * o bilesenin ULASILABILIR oldugunu soylemez"), bu yuzden ayni iddia
 * `token-page.test.tsx`te BESTELENMIS SAYFA uzerinde tekrar olculuyor.
 */

vi.mock('@/components/token/TradePanel', () => ({
  TradePanel: () => <div data-testid="curve-panel" />,
}))
vi.mock('@/components/token/PoolTradePanel', () => ({
  PoolTradePanel: () => <div data-testid="pool-panel" />,
}))

const EMPTY_ORDERS = async () =>
  ({
    ok: true as const,
    stale: false as const,
    data: { rows: [], nextCursor: null },
    indexer: {
      stale: false as const,
      head: 1n,
      cursor: 1n,
      blocksBehind: 0n,
      lastRunAt: new Date(),
      headObservedAt: new Date(),
    },
  }) as never

function surface(opts: { graduated?: boolean; withOrders?: boolean } = {}) {
  const lifecycle = resolveLifecycle({
    complete: opts.graduated ?? false,
    graduated: opts.graduated ?? false,
  })
  return renderWithProviders(
    <TradeSurface
      token={TOKEN}
      curve={CURVE}
      lifecycle={lifecycle}
      profile={TESTNET_PROFILE}
      symbol="DIFF"
      {...(opts.withOrders === false ? {} : { loadOrders: EMPTY_ORDERS })}
    />,
    { connected: true },
  )
}

describe('the tab strip Faz 4 refused to draw', () => {
  it('all three tabs are ON SCREEN for a trading curve', () => {
    surface()
    const strip = screen.getByRole('tablist', { name: 'Trading mode' })
    const tabs = within(strip)
      .getAllByRole('tab')
      .map((t) => t.textContent)
    expect(tabs).toEqual(['Market', 'Limit', 'Orders'])
  })

  it('`Market` is the default, and it draws the curve panel', () => {
    surface()
    expect(screen.getByTestId('curve-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('limit-panel')).not.toBeInTheDocument()
  })

  it('CLICKING `Limit` DRAWS THE LIMIT PANEL -- not an empty body', async () => {
    surface()
    await userEvent.click(screen.getByRole('tab', { name: 'Limit' }))
    expect(screen.getByTestId('limit-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('curve-panel')).not.toBeInTheDocument()
  })

  it('CLICKING `Orders` DRAWS THE ORDERS PANEL', async () => {
    surface()
    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(screen.getByTestId('orders-panel')).toBeInTheDocument()
  })

  /**
   * ============ URUNUN SOYLEMEK ZORUNDA OLDUGU IKI CUMLE ============
   *
   * Dispatch'in cumlesi: "bir emrin sessizce dolmamasi, ARAYUZ SOYLEMEDIKCE
   * bir urun yalanidir." Bu iddia bir yorumda duramaz; ekranda durmali ve bir
   * test onu ekranda gormeli.
   */
  it('the Limit panel says WHAT IT CANNOT DO, in words, on screen', async () => {
    surface()
    await userEvent.click(screen.getByRole('tab', { name: 'Limit' }))
    const note = screen.getByTestId('limit-custody-note').textContent ?? ''
    expect(note).toMatch(/never holds your funds/i)
    expect(note).toMatch(/cannot trade for you/i)
    expect(note).toMatch(/does not fill/i)
  })

  it('and WHAT IT DOES guarantee -- the on-chain limit', async () => {
    surface()
    await userEvent.click(screen.getByRole('tab', { name: 'Limit' }))
    const note = screen.getByTestId('limit-guarantee-note').textContent ?? ''
    expect(note).toMatch(/on-chain limit/i)
    expect(note).toMatch(/never fill for less/i)
  })

  it('the Orders panel states the read is UNAUTHENTICATED', async () => {
    surface()
    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(screen.getByTestId('orders-visibility-note').textContent ?? '').toMatch(
      /readable by anyone who knows your address/i,
    )
  })

  /**
   * MEZUN BIR TOKEN'DA `Limit` CIZILMEZ, ve bu `Tabs.tsx`in kuralinin
   * uygulanmasidir: keeper'in havuz yolu CANLI BIR HAVUZA KARSI HIC
   * CALISMADI (uretim `graduationTarget`i `0x0`), yani o sekme "tiklandiginda
   * calistigini iddia edemedigimiz" siniftadir.
   */
  it('a GRADUATED token does not get a `Limit` tab', () => {
    surface({ graduated: true })
    const tabs = within(screen.getByRole('tablist', { name: 'Trading mode' }))
      .getAllByRole('tab')
      .map((t) => t.textContent)
    expect(tabs).toEqual(['Market', 'Orders'])
    expect(screen.getByTestId('pool-panel')).toBeInTheDocument()
  })

  it('with no way to load orders, the strip does not promise one', () => {
    surface({ withOrders: false })
    const tabs = within(screen.getByRole('tablist', { name: 'Trading mode' }))
      .getAllByRole('tab')
      .map((t) => t.textContent)
    expect(tabs).toEqual(['Market', 'Limit'])
  })

  /**
   * AYNI BILESEN ORNEGI, DEGISEN PROP. Bir kabuk bileseni `graduated`i
   * durumda tutuyor cunku `rerender` saglayicilari (wagmi/query) ATLAR ve
   * bilesen `useConnection`a dokunuyor -- olculdu, ciplak `rerender`
   * `WagmiProviderNotFoundError` veriyor. Kabuk ayni agacta kaldigi icin
   * `TradeSurface`in KENDI durumu (secili sekme) korunur, ki testin olctugu
   * sey tam olarak odur.
   */
  it('a tab that stops being drawn cannot stay selected', async () => {
    function Shell() {
      const [graduated, setGraduated] = useState(false)
      return (
        <>
          <button type="button" onClick={() => { setGraduated(true) }}>graduate</button>
          <TradeSurface
            token={TOKEN}
            curve={CURVE}
            lifecycle={resolveLifecycle({ complete: graduated, graduated })}
            profile={TESTNET_PROFILE}
            symbol="DIFF"
            loadOrders={EMPTY_ORDERS}
          />
        </>
      )
    }
    renderWithProviders(<Shell />, { connected: true })
    await userEvent.click(screen.getByRole('tab', { name: 'Limit' }))
    expect(screen.getByTestId('limit-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'graduate' }))
    // Bos bir govde DEGIL, `Market`e duser.
    expect(screen.queryByTestId('limit-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('pool-panel')).toBeInTheDocument()
  })
})
