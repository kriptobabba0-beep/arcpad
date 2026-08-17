import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveNumber } from '@/components/ui/LiveNumber'

/**
 * ============================================================================
 *  SAYARAK DEGISEN SAYI
 * ============================================================================
 *
 * Kullanicinin istegi acikti: "sitede olan butun dinamik sayilar slot makinesi
 * gibi degissin -- 50, 51, 52, 53, 54, 55, hem yukari hem asagi." Bu dosya o
 * davranisin ARA DEGERLERINI olcuyor, yalnizca son degeri degil: son degeri
 * dogrulayan bir test, animasyon tamamen silinse bile GECERDI.
 *
 * ZAMAN SAHTE. `setInterval` gercek zamanda calissaydi her test yuzlerce
 * milisaniye beklerdi ve ara kareyi yakalamak yarisa donerdi.
 */

/** `matchMedia` jsdom'da yok; hareket-azaltma varsayilan olarak KAPALI. */
function stubMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduced,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  stubMatchMedia(false)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Animasyonun toplam suresi (`DURATION_MS`) ve adim sayisi (`STEPS`). */
const DURATION_MS = 650
const STEPS = 20

/**
 * Cizilen sayiyi okur. VIRGULLER ATILIR: `count` bicimi binlik ayirici koyar
 * ve `Number('1,050')` `NaN`dir -- karsilastirma o zaman degeri degil, degerin
 * binligi gecip gecmedigini olcerdi.
 */
function drawn(title: string): number {
  return Number(screen.getByTitle(title).textContent?.replace(/,/g, ''))
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('<LiveNumber>', () => {
  it('ILK CIZIM ANIMASYON DEGIL -- sunucudan gelen deger dogrudan yazilir', () => {
    /*
     * Sifirdan sayarak baslayan bir sayfa her yenilemede butun ekrani oynatir
     * ve "yukleniyor" hissi verir; oysa veri zaten oradadir. Ilk deger
     * animasyonsuz gorunmeli.
     */
    render(<LiveNumber value={50n} format="count" />)
    expect(screen.getByTitle('50')).toHaveTextContent('50')
  })

  it('50 -> 55 arasindaki ARA degerlerden gecer, tek karede atlamaz', () => {
    const { rerender } = render(<LiveNumber value={50n} format="count" />)
    rerender(<LiveNumber value={55n} format="count" />)

    // Yarida: 50 ile 55 arasinda bir yerde olmali, ucunda degil.
    advance(DURATION_MS / 2)
    const mid = drawn('55')
    expect(mid, 'the number jumped instead of counting').toBeGreaterThan(50)
    expect(mid).toBeLessThan(55)

    // Sonunda TAM hedefte durur -- interpolasyon bir yaklasim birakmaz.
    advance(DURATION_MS)
    expect(screen.getByTitle('55')).toHaveTextContent('55')
  })

  it('ASAGI da sayar -- yon tek yonlu degil', () => {
    const { rerender } = render(<LiveNumber value={55n} format="count" />)
    rerender(<LiveNumber value={50n} format="count" />)

    advance(DURATION_MS / 2)
    const mid = drawn('50')
    expect(mid).toBeLessThan(55)
    expect(mid).toBeGreaterThan(50)

    advance(DURATION_MS)
    expect(screen.getByTitle('50')).toHaveTextContent('50')
  })

  it('YON RENGI: yukari `text-accent`, asagi `text-negative`, sonra soner', () => {
    /*
     * Renk gecici olmali: kalici bir renk, gecmis bir OLAYI surekli bir DURUM
     * gibi gosterirdi -- yesil bir FDV, bir daha hic degismese bile sonsuza
     * dek yesil kalirdi.
     */
    const { rerender } = render(<LiveNumber value={50n} format="count" />)
    rerender(<LiveNumber value={60n} format="count" />)
    advance(10)
    expect(screen.getByTitle('60').className).toContain('text-accent')

    rerender(<LiveNumber value={40n} format="count" />)
    advance(10)
    expect(screen.getByTitle('40').className).toContain('text-negative')

    advance(DURATION_MS + 600)
    const settled = screen.getByTitle('40').className
    expect(settled).not.toContain('text-accent')
    expect(settled).not.toContain('text-negative')
  })

  it('ARITMETIK `bigint` -- wei olceginde tek bir birim bile kaybolmaz', () => {
    /*
     * 1 USDC = 1e18 wei, yani `Number.MAX_SAFE_INTEGER`in (9.007e15) yuz
     * katindan buyuk. Ara degerler `number` uzerinde hesaplansaydi gosterilen
     * her tutar sessizce yuvarlanirdi. Burada olculen sey: hedefe TAM
     * ulasildigi ve son degerin ondaligiyla birlikte korundugu.
     */
    const from = 1_000_000_000_000_000_001n
    const to = 2_000_000_000_000_000_003n
    const { rerender } = render(<LiveNumber value={from} format="usdc" />)
    rerender(<LiveNumber value={to} format="usdc" />)
    advance(DURATION_MS + 100)
    // `title` HAM hedefin bicimlenmisidir; metin de ona esit olmali.
    const node = screen.getByTitle('$2.00')
    expect(node).toHaveTextContent('$2.00')
  })

  it('YARIDA KESILEN GECIS SICRAMAZ -- ekrandaki degerden devam eder', () => {
    /*
     * KULLANICI YAZARKEN OLUR: "100" yazmak 1 -> 10 -> 100 uretir ve her biri
     * onceki gecis bitmeden gelir. Baslangic olarak son HEDEF alinsaydi, yarim
     * kalmis gecis once oraya SICRAR sonra yeniden sayardi; yani en cok
     * hareket eden sayilar en cok sicrayanlar olurdu.
     */
    const { rerender } = render(<LiveNumber value={0n} format="count" />)
    rerender(<LiveNumber value={1000n} format="count" />)
    advance(DURATION_MS / 2)
    const mid = drawn('1,000')

    // Gecis surerken hedef degisir.
    rerender(<LiveNumber value={2000n} format="count" />)
    advance(DURATION_MS / STEPS)
    const afterInterrupt = drawn('2,000')

    // Yeni gecis, kesildigi yerin YAKININDAN devam eder -- geriye 1000'e ya da
    // ileriye 2000'e sicramaz.
    expect(afterInterrupt).toBeGreaterThanOrEqual(mid)
    expect(afterInterrupt).toBeLessThan(mid + 300)
  })

  it('`prefers-reduced-motion` ONCELIKLI -- animasyon HIC calismaz', () => {
    /*
     * WCAG 2.3.3. Bu bir incelik degil bir erisilebilirlik kosulu: sayarak
     * degisen bir sayi, vestibuler duyarliligi olan biri icin gercekten
     * rahatsiz edici. Deger dogrudan son haline gecmeli.
     */
    stubMatchMedia(true)
    const { rerender } = render(<LiveNumber value={50n} format="count" />)
    rerender(<LiveNumber value={9999n} format="count" />)
    advance(1)
    expect(screen.getByTitle('9,999')).toHaveTextContent('9,999')
  })

  it('BICIM BIR AD -- fiyat kisaltilmaz, yuzde isaretini metne basmaz', () => {
    /*
     * `format` bir FONKSIYON olsaydi sunucu->istemci sinirindan gecemezdi
     * ("Functions cannot be passed directly to Client Components") -- bu hata
     * uretimde bir kez alindi. Anahtarlarin her biri burada bir kez cizilir ki
     * biri sessizce degistiginde haber versin.
     */
    render(<LiveNumber value={5_878_000_000n} format="price" />)
    // Sifir-alt-simge gosterimi: 0.000000005878 -> `0.0(8)5878`.
    expect(screen.getByTitle(/^\$0\.0/)).toBeInTheDocument()

    render(<LiveNumber value={11_000_000n * 10n ** 18n} format="token" />)
    expect(screen.getByTitle('11.00M')).toBeInTheDocument()

    // ISARET METINDE YOK, DEGERDE VAR: yonu ok gosterir, metin degil.
    render(<LiveNumber value={-123n} format="percent1" />)
    expect(screen.getByTitle('12.3%')).toHaveTextContent('12.3%')
  })

  it('EKRAN OKUYUCU ARA DEGERLERI DUYURMAZ', () => {
    /*
     * `aria-live` konsaydi yirmi ara deger arka arkaya okunurdu. Guncel deger
     * `title` ile ve DOM metniyle zaten erisilebilir.
     */
    const { container } = render(<LiveNumber value={50n} format="count" />)
    expect(container.querySelector('[aria-live]')).toBeNull()
  })
})
