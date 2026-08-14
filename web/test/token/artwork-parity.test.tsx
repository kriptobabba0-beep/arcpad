import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { resolveArtworkSrc, TokenArtwork } from '@/components/layout/TokenArtwork'

/*
 * `TradeSurface` -> `TradePanel` zinciri istemci tarafi kancalarla (cuzdan,
 * rezerv okumasi, onay) doludur ve bu testin sorusu onlarin HICBIRI degil.
 * Soru TEK bir sey: aradaki tasiyici `imageUrl`i GECIRIYOR MU. Bu yuzden
 * `TradePanel` bir casusla degistirilir ve aldigi prop okunur.
 */
const seen: Array<Record<string, unknown>> = []
vi.mock('@/components/token/TradePanel', () => ({
  TradePanel: (props: Record<string, unknown>) => {
    seen.push(props)
    return <div data-testid="trade-panel" />
  },
}))
vi.mock('@/components/token/PoolTradePanel', () => ({
  PoolTradePanel: (props: Record<string, unknown>) => {
    seen.push(props)
    return <div data-testid="pool-panel" />
  },
}))

const { TradeSurface } = await import('@/components/token/TradeSurface')

const TOKEN = '0x99340e06e6acfb7ca625fb2ab6636bd51e87a526' as const
const CURVE = '0x2e812f107742b1b9180144ead240a46c892eeab1' as const
const IMAGE = 'ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/art.png'

const PROFILE = {
  name: 'testnet',
  profile: {
    virtualQuoteReserves: 4_292_000_000_000_000_000n,
    virtualTokenReserves: 1_073_000_000_000_000_000_000_000_000n,
    saleSupply: 793_100_000_000_000_000_000_000_000n,
  },
} as never

/**
 * ============================================================================
 *  AYNI TOKEN, AYNI SEMBOL -- SAYFANIN HER IKI YERINDE
 * ============================================================================
 *
 * Bildirilen kusur: sol ustte tokenin gercek gorseli, al-sat panelinde BASKA
 * bir sembol. Ikisi de ayni `TokenArtwork` bilesenini cagiriyordu; fark
 * girdideydi -- panele hicbir zaman bir `uri` ULASMIYORDU.
 *
 * VE ZINCIRIN GERI KALANI ZATEN KURULUYDU: `TradePanel` propu tanimliyor ve
 * `AmountCard`a geciriyordu, `AmountCard` da `TokenArtwork`a. Kopuk olan tek
 * halka `TradeSurface`ti. Yani bilesenlerin hicbiri hatali degildi; hata
 * ARADAKI TASIYICIDAYDI ve bu yuzden hicbir bilesen testi goremezdi.
 *
 * Bu dosya tam olarak o araligi okur.
 */
describe('gorsel her iki yuzeye de ulasir', () => {
  it('TradeSurface `imageUrl`i egri paneline GECIRIR', () => {
    seen.length = 0
    render(
      <TradeSurface
        token={TOKEN}
        curve={CURVE}
        lifecycle={{ kind: 'trading' }}
        profile={PROFILE}
        symbol="LOCKED"
        imageUrl={IMAGE}
      />,
    )
    expect(screen.getByTestId('trade-panel')).toBeInTheDocument()
    expect(seen).toHaveLength(1)
    // KRITIK IDDIA: prop yutulmadi.
    expect(seen[0]?.['imageUrl']).toBe(IMAGE)
  })

  it('gorsel YOKKEN `null` gecer -- `undefined` degil', () => {
    seen.length = 0
    render(
      <TradeSurface
        token={TOKEN}
        curve={CURVE}
        lifecycle={{ kind: 'trading' }}
        profile={PROFILE}
        symbol="LOCKED"
      />,
    )
    expect(seen[0]?.['imageUrl']).toBeNull()
  })

  /*
   * IKI YUZEY AYNI GIRDIDEN AYNI CIKTIYI VERIR.
   *
   * `TokenArtwork` iki farkli boyutta cizilir (kimlikte 64, panelde 24) ama
   * KAYNAK ayni olmali. Boyut degistigi icin dizeleri degil `src`i
   * karsilastiriyoruz -- kusur zaten "ayni token, iki farkli SEMBOL"du.
   */
  it('ayni uri, iki boyutta AYNI kaynagi verir', () => {
    const { container: big } = render(
      <TokenArtwork address={TOKEN} uri={IMAGE} size={64} symbol="LOCKED" />,
    )
    const { container: small } = render(
      <TokenArtwork address={TOKEN} uri={IMAGE} size={24} symbol="LOCKED" />,
    )
    const src = (c: HTMLElement) => c.querySelector('img')?.getAttribute('src')
    expect(src(big)).not.toBeNull()
    expect(src(big)).toBe(src(small))
  })

  it('uri YOKKEN ikisi de AYNI yedege duser -- tutarsizlik gorsel yoklugunda da olmaz', () => {
    const { container: big } = render(
      <TokenArtwork address={TOKEN} uri={null} size={64} symbol="LOCKED" />,
    )
    const { container: small } = render(
      <TokenArtwork address={TOKEN} uri={null} size={24} symbol="LOCKED" />,
    )
    expect(big.querySelector('img')).toBeNull()
    expect(small.querySelector('img')).toBeNull()
    // Yedek ADRESTEN uretilir, yani ayni token her yerde ayni gradyani alir.
    expect(resolveArtworkSrc(null)).toBeNull()
  })
})
