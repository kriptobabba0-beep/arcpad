import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TradeSideTabs } from '@/components/token/TradeTabs'
import type { TradeTab } from '@/components/token/tradeModel'

/**
 * ============================================================================
 *  SEKMENIN BIR `id`SI VAR, VE PANEL ONA ISARET EDER
 * ============================================================================
 *
 * OLCULDU (2026-08-19): `TradeSideTabs` hicbir `id` uretmiyordu, ama
 * `TradePanel` panelini `aria-labelledby={`trade-tab-${tab}`}` ile
 * etiketliyordu. `aria-labelledby` var olmayan bir `id`ye isaret ettiginde
 * SESSIZCE yok sayilir -- yani panelin ekran okuyucudaki adi yoktu ve hicbir
 * sey kirmizi vermiyordu.
 *
 * Ikinci bir tuzak da vardi: `tab` UC degerlidir (`spend`/`receive`/`sell`)
 * ama sekme IKIDIR. `trade-tab-receive` diye bir eleman HICBIR ZAMAN olmazdi,
 * yani alim sekmesinde birim degistirmek etiketi sessizce koparirdi.
 *
 * Bu dosya iki paneli de baglayan sozlesmeyi olcer: uc `tab` degerinin
 * UCU icin de, panelin isaret ettigi `id` GERCEKTEN belgede olmali.
 */
describe('sekme etiketlemesi: panel var olan bir sekmeye isaret eder', () => {
  const TABS: readonly TradeTab[] = ['spend', 'receive', 'sell']

  it.each(TABS)('`%s` icin hedef `id` belgede vardir', (tab) => {
    render(<TradeSideTabs idBase="trade" tab={tab} onChange={() => {}} />)
    // `TradePanel` ve `PoolTradePanel` bu ifadeyi kullanir.
    const target = `trade-tab-${tab === 'sell' ? 'sell' : 'buy'}`
    expect(document.getElementById(target), `${target} yok`).not.toBeNull()
  })

  it('AYIRT EDICI: `tab` degerini oldugu gibi kullanmak KOPARDI', () => {
    // Eski ifade `trade-tab-${tab}` idi. `receive` icin boyle bir eleman
    // yoktur -- bu kontrol olmadan duzeltme geri alinabilir ve kimse gormez.
    render(<TradeSideTabs idBase="trade" tab="receive" onChange={() => {}} />)
    expect(document.getElementById('trade-tab-receive')).toBeNull()
    expect(document.getElementById('trade-tab-buy')).not.toBeNull()
  })

  it('`idBase` iki paneli AYIRIR -- ayni sayfada cakisan `id` olmaz', () => {
    render(
      <>
        <TradeSideTabs idBase="trade" tab="spend" onChange={() => {}} />
        <TradeSideTabs idBase="pool-trade" tab="spend" onChange={() => {}} />
      </>,
    )
    expect(document.getElementById('trade-tab-buy')).not.toBeNull()
    expect(document.getElementById('pool-trade-tab-buy')).not.toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(4)
  })
})
