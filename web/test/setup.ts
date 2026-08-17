import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * BILESEN TESTLERININ ORTAMI.
 *
 * Env degerleri GERCEK: chainId Arc testnet'in kaydindaki 5042002, factory ve
 * escrow ise zincirde SU AN duran adresler. Uydurma adresler de typecheck'ten
 * gecerdi, ama o zaman `Address`'in explorer baglantisi gibi seyler "bir sey
 * uretiyor" diye dogrulanir, "dogru seyi uretiyor" diye degil.
 *
 * `getWebConfig()` sonucu memoize eder ve modul yuklenirken degil CAGRILIRKEN
 * okur, dolayisiyla burada set etmek yeterli.
 */
process.env.NEXT_PUBLIC_ARC_CHAIN_ID = '5042002'
process.env.NEXT_PUBLIC_ARCPAD_FACTORY = '0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439'
process.env.NEXT_PUBLIC_ARCPAD_ESCROW = '0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6'

/**
 * jsdom `matchMedia` uygulamiyor ve onsuz `prefers-reduced-motion`'a bakan
 * hicbir sey render edilemez. Varsayilan "hareket azaltma KAPALI" -- yani
 * testler animasyonlarin acik oldugu, daha zor durumu olcer.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

/** jsdom'da yok; `Dialog`/`Toast` disinda kullanan olursa diye. */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

/**
 * `navigator.clipboard` jsdom'da tanimsiz. Gercek panoya yazmayan ama
 * cagrildigini kaydeden bir sahte: `Address`'in kopyalama testi bunu okur.
 */
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: vi.fn(async () => {}) },
})

afterEach(() => {
  cleanup()
})
