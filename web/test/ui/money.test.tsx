import { nativeToErc20 } from '@arcpad/shared/browser'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Money } from '@/components/ui/Money'

/**
 * HER PARA HUCRESI `<Money>`'DEN GECER, ve `tabular-nums`'i tasiyan odur.
 *
 * Sabitlenmis vektorler Faz 4 planinin K3/K2 tablolarindan: her biri bu urunde
 * gercekten olusan bir tutar. Uydurma sayilar da ayni aritmetigi olcerdi, ama
 * "12,161433 USDC" ekranda goruldugunde onun graduation raise oldugunu
 * soyleyecek bir sey olmazdi.
 */
const VECTORS = [
  {
    native: 12_161_433_369_060_378_706n,
    down: '12.161433',
    up: '12.161434',
    what: 'graduation raise R (testnet)',
  },
  { native: 12_313_451_286_173_633_442n, down: '12.313451', up: '12.313452', what: 'R + ucretler' },
  {
    native: 975_308_641_975_308_639n,
    down: '0.975308',
    up: '0.975309',
    what: '1 USDC gidis-donus sonrasi net',
  },
  {
    native: 9_382_716_049_382_717n,
    down: '0.009382',
    up: '0.009383',
    what: '1 USDC alimin protokol payi',
  },
  {
    native: 2_962_962_962_962_963n,
    down: '0.002962',
    up: '0.002963',
    what: 'ayni alimin creator payi',
  },
] as const

function moneyCell(container: HTMLElement): HTMLElement {
  const cell = container.querySelector<HTMLElement>('[data-rounding]')
  if (!cell) throw new Error('<Money> bir hucre cizmedi')
  return cell
}

describe('<Money>', () => {
  it('tabular-nums tasir -- para kolonu satir satir kaymaz', () => {
    const { container } = render(<Money native={1_000_000_000_000n} rounding="down" />)
    expect(moneyCell(container).className.split(/\s+/)).toContain('tabular-nums')
  })

  it('birim gosterildiginde de tabular-nums yerinde kalir', () => {
    const { container } = render(<Money native={1_000_000_000_000n} rounding="down" unit />)
    expect(moneyCell(container).className.split(/\s+/)).toContain('tabular-nums')
    expect(container.textContent).toContain('USDC')
  })

  it.each(VECTORS)('$what -> down $down', ({ native, down }) => {
    render(<Money native={native} rounding="down" />)
    expect(screen.getByText(down)).toBeInTheDocument()
  })

  it.each(VECTORS)('$what -> up $up', ({ native, up }) => {
    render(<Money native={native} rounding="up" />)
    expect(screen.getByText(up)).toBeInTheDocument()
  })

  /**
   * K1'IN TEK SATIRLIK OLCULEBILIR HALI.
   *
   * Ekranda gorunen rakamlar ile ERC-20 gorunumunun kendisi AYNI SAYIYI
   * soylemek zorunda. Ayrilirlarsa arayuz, cuzdanin ve explorer'in
   * gormedigi bir bakiye gostermis olur.
   */
  it('down yonu her zaman nativeToErc20 ile ayni degeri gosterir', () => {
    for (const value of [
      0n,
      1n,
      500_000_000_000n,
      999_999_999_999n,
      1_000_000_000_000n,
      12_161_433_369_060_378_706n,
    ]) {
      const { container, unmount } = render(<Money native={value} rounding="down" />)
      const shown = moneyCell(container).textContent ?? ''
      expect(BigInt(shown.replace(/[,.]/g, ''))).toBe(nativeToErc20(value))
      unmount()
    }
  })

  it('yarim mikro-USDC bir BAKIYE olarak sifir, bir MALIYET olarak bir gorunur', () => {
    // Olculdu: `nativeToErc20(5e11) === 0n`. Yukari yuvarlayan bir
    // biciimlendirici burada olmayan parayi gosterirdi.
    const balance = render(<Money native={500_000_000_000n} rounding="down" />)
    expect(moneyCell(balance.container).textContent).toBe('0.000000')
    balance.unmount()

    const cost = render(<Money native={500_000_000_000n} rounding="up" />)
    expect(moneyCell(cost.container).textContent).toBe('0.000001')
  })
})
