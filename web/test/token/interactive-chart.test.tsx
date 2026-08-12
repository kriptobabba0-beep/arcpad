import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InteractiveChart } from '@/components/token/InteractiveChart'
import type { CandleRow } from '@/lib/read'

/**
 * ============================================================================
 *  YAKINLASTIRMA VE KAYDIRMA -- CIZIM SUNUCUDA KALARAK
 * ============================================================================
 *
 * Bu sarmalayicinin tuttugu sey bir GORUNTU degil bir DILIM: `[end-span, end)`.
 * Mumlar ayni mumlar; degisen tek sey kacinin cizildigi. Boylece olcekleme
 * `bigint` uzerinde ve cizim sunucuda kalir -- bir memecoin'in market cap'i
 * 4e18 ile 5e24 arasinda gezer ve `number`a cevrilmis bir olcek kucuk
 * degerlerde mumlari ust uste bindirir.
 */

function series(n: number): CandleRow[] {
  return Array.from({ length: n }, (_, i) => ({
    bucket: new Date(Date.UTC(2026, 7, 11, 0, i * 5)),
    openWei: BigInt(10 + i) * 10n ** 18n,
    highWei: BigInt(12 + i) * 10n ** 18n,
    lowWei: BigInt(9 + i) * 10n ** 18n,
    closeWei: BigInt(11 + i) * 10n ** 18n,
    volumeWei: 10n ** 18n,
    trades: 1,
  }))
}

function bodyCount(container: HTMLElement): number {
  return [...container.querySelectorAll('rect')].filter(
    (r) => r.getAttribute('fill') === 'currentColor' && r.getAttribute('class') === null,
  ).length
}

const CURRENT = 11n * 10n ** 18n

describe('InteractiveChart', () => {
  it('varsayilan olarak HEPSINI cizer ve nasil kullanilacagini soyler', () => {
    const { container } = render(
      <InteractiveChart candles={series(30)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    expect(bodyCount(container)).toBe(30)
    // Bir etkilesim, kesfedilebilir degilse yok demektir.
    expect(screen.getByText(/scroll to zoom, drag to pan/i)).toBeDefined()
  })

  it('TEKERLEK YUKARI yakinlastirir -- daha AZ mum cizilir', () => {
    const { container } = render(
      <InteractiveChart candles={series(40)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    const box = screen.getByTestId('interactive-chart')
    fireEvent.wheel(box, { deltaY: -120, clientX: 500 })
    expect(bodyCount(container)).toBeLessThan(40)
  })

  it('yakinlastirinca KAC MUMDAN KACI gorundugu YAZILIR ve geri donus yolu cikar', () => {
    render(
      <InteractiveChart candles={series(40)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    fireEvent.wheel(screen.getByTestId('interactive-chart'), { deltaY: -120, clientX: 500 })
    expect(screen.getByText(/of 40 candles/)).toBeDefined()
    // Cikis yolu ekranda olmali: "hepsini goster"i olmayan bir yakinlastirma
    // kullaniciyi sayfayi yenilemeye zorlar.
    expect(screen.getByTestId('chart-reset')).toBeDefined()
  })

  it('RESET her seyi geri getirir', () => {
    const { container } = render(
      <InteractiveChart candles={series(40)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    const box = screen.getByTestId('interactive-chart')
    fireEvent.wheel(box, { deltaY: -120, clientX: 500 })
    fireEvent.wheel(box, { deltaY: -120, clientX: 500 })
    expect(bodyCount(container)).toBeLessThan(40)
    fireEvent.click(screen.getByTestId('chart-reset'))
    expect(bodyCount(container)).toBe(40)
  })

  it('BIR MUMUN ALTINA INMEZ -- bir cubuk grafik degildir', () => {
    /*
     * TABAN SEKIZDI VE COK YUKSEKTI: yedi mumu olan bir token'da yakinlastirma
     * HIC calismiyordu, cunku asgari pencere butun seriden genisti. Tarayicida
     * olculdu -- tekerlek donuyor, ekranda hicbir sey degismiyor. Uc, bir
     * grafigin okunabilecegi en dar pencere.
     */
    const { container } = render(
      <InteractiveChart candles={series(40)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    const box = screen.getByTestId('interactive-chart')
    for (let i = 0; i < 30; i += 1) fireEvent.wheel(box, { deltaY: -120, clientX: 500 })
    expect(bodyCount(container)).toBeGreaterThanOrEqual(3)
  })

  it('AZ MUMLU BIR TOKENDA DA YAKINLASTIRILIR', () => {
    // Yedi mum: eski tabanla (8) bu grafik yakinlastirilamiyordu.
    const { container } = render(
      <InteractiveChart candles={series(7)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    const box = screen.getByTestId('interactive-chart')
    fireEvent.wheel(box, { deltaY: -120, clientX: 500 })
    expect(bodyCount(container)).toBeLessThan(7)
  })

  it('UZAKLASTIRMA TOPLAMI ASAMAZ -- olmayan mum cizilmez', () => {
    const { container } = render(
      <InteractiveChart candles={series(12)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    const box = screen.getByTestId('interactive-chart')
    for (let i = 0; i < 10; i += 1) fireEvent.wheel(box, { deltaY: 120, clientX: 500 })
    expect(bodyCount(container)).toBe(12)
  })

  it('DOKUNMATIKTE SAYFA DEGIL GRAFIK HAREKET EDER', () => {
    render(
      <InteractiveChart candles={series(20)} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />,
    )
    // `touch-action: none` olmadan mobilde surukleme HIC calismaz -- tarayici
    // hareketi sayfa kaydirmasi olarak yorumlar.
    expect(screen.getByTestId('interactive-chart').className).toContain('touch-none')
  })

  it('BOS SERI CIZILEBILIR -- sarmalayici kendi basina duşmez', () => {
    render(<InteractiveChart candles={[]} metric="fdv" currentWei={CURRENT} bucketSeconds={300} />)
    expect(screen.getByTestId('candle-chart-empty')).toBeDefined()
  })
})
