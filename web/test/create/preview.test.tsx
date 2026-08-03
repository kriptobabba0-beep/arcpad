import type { CurveProfile } from '@arcpad/shared/browser'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  bpsPercent,
  formatTok,
  formatTokExact,
  launchFactsFrom,
  supplySharePercent,
  TOTAL_SUPPLY_TOK,
} from '@/components/create/facts'
import { EMPTY_FIELDS } from '@/components/create/fields'
import { TokenPreviewCard } from '@/components/create/TokenPreviewCard'

/**
 * CANLI TESTNET PROFILI, `contracts/deploy/addresses.5042002.json`ten.
 *
 * Sabit degil OLCUM: brief'in sekiz satiri bu ucluden turetildi ve bu dosya o
 * turetmeyi tekrar etmiyor, SONUCLARI pinliyor. `V` uretimde tam 1000 kat
 * farklidir ve bu, iki profilin ayrildigi TEK alandir.
 */
const TESTNET: CurveProfile = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292n * 10n ** 15n,
  saleSupply: 793_100_000n * 10n ** 18n,
}

const FACTS = launchFactsFrom(TESTNET)

describe('launchFactsFrom -- sekiz satirin sayilari', () => {
  it('toplam arz turetilmez: `LaunchToken.TOTAL_SUPPLY` = 1e27', () => {
    expect(FACTS.totalSupplyTok).toBe(10n ** 27n)
    expect(formatTok(FACTS.totalSupplyTok)).toBe('1,000,000,000')
  })

  it('curve uzerindeki arz `SALE_SUPPLY`dir: 793.100.000 (%79,31)', () => {
    expect(formatTok(FACTS.saleSupplyTok)).toBe('793,100,000')
    expect(supplySharePercent(FACTS.saleSupplyTok, TOTAL_SUPPLY_TOK)).toBe('79.31')
  })

  it('havuz tohumu `poolSeedSupply(S, T)`: 206.886.011,183597 (%20,69)', () => {
    expect(FACTS.poolSeedTok).toBe(206_886_011_183_597_390_493_942_218n)
    expect(formatTok(FACTS.poolSeedTok)).toBe('206,886,011.183597')
    expect(supplySharePercent(FACTS.poolSeedTok, TOTAL_SUPPLY_TOK)).toBe('20.69')
  })

  it('mezuniyet `graduationRaise(S, V, T)`: 12,161433 USDC', () => {
    expect(FACTS.graduationRaiseWei).toBe(12_161_433_369_060_378_706n)
  })

  it('acilis market cap `marketCap(V, T, N)`: tam 4 USDC', () => {
    expect(FACTS.openingMarketCapWei).toBe(4n * 10n ** 18n)
  })

  it('ARZIN TAMAMI TUTAR: S + D + artik = N, ve artik curve’de kalir', () => {
    expect(FACTS.saleSupplyTok + FACTS.poolSeedTok + FACTS.strandedTok).toBe(TOTAL_SUPPLY_TOK)
    expect(formatTokExact(FACTS.strandedTok)).toBe('13,988.816402609506057782')
  })

  it('ucretler `BondingCurve`in `constant`lari: 0,95% + 0,30%', () => {
    expect(bpsPercent(FACTS.protocolFeeBps)).toBe('0.95')
    expect(bpsPercent(FACTS.creatorFeeBps)).toBe('0.30')
  })
})

describe('<TokenPreviewCard>', () => {
  const row = (label: string) => {
    const term = screen.getByText(label)
    const wrapper = term.parentElement
    if (!wrapper) throw new Error(`no row for ${label}`)
    return within(wrapper)
  }

  it('sekiz satirin sekizi de cizilir', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    for (const label of [
      'Launch fee',
      'Trading fee',
      'Total supply',
      'On the curve',
      'Reserved for the pool',
      'Graduation at',
      'Opening market cap',
      'Liquidity',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('launch ucreti "None" -- `launch` `payable` degil', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    expect(row('Launch fee').getByText('None')).toBeInTheDocument()
    // "0.000000 USDC ucret" ile "ucret yok" ayni sey degil.
    expect(row('Launch fee').queryByText(/0\.000000/)).toBeNull()
  })

  it('LIKIDITE SATIRI FAZ 2 IBARESINI TASIR ve "Locked" tek basina yazmaz', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    const liquidity = row('Liquidity')
    // "Liquidity: Locked" yazmak, bugun var olmayan bir garantiyi vaat etmek
    // olurdu. Havuz ve kalici kilit Faz 2'dedir.
    expect(liquidity.getByText(/not live on testnet yet/i)).toBeInTheDocument()
    expect(liquidity.queryByText('Locked')).toBeNull()
  })

  it('para hucreleri `<Money>`den gecer ve yonu ISIMLENDIRILMISTIR', () => {
    const { container } = render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    const monies = container.querySelectorAll('[data-rounding]')
    expect(monies.length).toBe(2)
    // Mezuniyet bir ESIKTIR -> yukari. Market cap var olan bir degeri anlatir
    // -> asagi. Varsayilan yon YOKTUR ve olmamalidir.
    expect(row('Graduation at').getByText(/12\.161434/)).toBeInTheDocument()
    expect(row('Opening market cap').getByText('4.00')).toBeInTheDocument()
  })

  it('kalici artik TAM degeriyle yazilir -- kirpilirsa toplam N etmez', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    expect(row('Reserved for the pool').getByText(/13,988\.816402609506057782/)).toBeInTheDocument()
  })

  it('profil okunamadiginda sayilar "—" olur, kart YOK OLMAZ', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={null} />)
    // `launch(name, symbol, uri)` uc dizeden ibarettir: profil dustugunde de
    // launch edilebilir olmali.
    expect(screen.getByText('Total supply')).toBeInTheDocument()
    expect(row('Total supply').getByText('—')).toBeInTheDocument()
    expect(row('Launch fee').getByText('None')).toBeInTheDocument()
  })

  it('onizleme TEMIZLENMIS adi gosterir: kullanici ekranda ne gorecekse onu gorur', () => {
    render(
      <TokenPreviewCard
        fields={{ ...EMPTY_FIELDS, name: 'Diff‮usion', symbol: 'DIFF' }}
        facts={FACTS}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Diffusion' })).toBeInTheDocument()
  })
})
