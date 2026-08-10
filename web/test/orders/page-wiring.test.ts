import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ==========================================================================
 *  KAYNAK TARAMASI -- "IKI DALDAN BIRINDE UNUTMAK" KAPANDI MI
 * ==========================================================================
 *
 * `test/pool/page.test.ts` `TradeSurface`in IKI kez cizildigini sayiyor. Emir
 * yolunun kendi arizasi bir prop'un TEK dalda verilmesidir: indexer dustugunde
 * cizilen dal `loadOrders`i almasaydi, kullanicinin acik emirleri TAM DA
 * ONLARA EN COK IHTIYAC DUYDUGU ANDA ekrandan silinirdi -- ve bileşen testi
 * yesil kalirdi.
 */
const PAGE = readFileSync(
  fileURLToPath(new URL('../../app/token/[address]/page.tsx', import.meta.url)),
  'utf8',
)

/** Yorumlar cikarilir: bir yorumdaki `loadOrders={` bir cagri yeri DEGILDIR. */
function codeOf(text: string): string {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

describe('the page passes `loadOrders` on BOTH branches', () => {
  it('exactly two call sites, and both carry the prop', () => {
    const code = codeOf(PAGE)
    const surfaces = [...code.matchAll(/<TradeSurface[\s\S]*?\/>/g)].map((m) => m[0])
    expect(surfaces).toHaveLength(2)
    for (const call of surfaces) expect(call).toMatch(/loadOrders=\{/)
  })

  it('and the action is BOUND to the right token on each branch', () => {
    const code = codeOf(PAGE)
    expect(code).toMatch(/loadOrders\.bind\(null, overview\.token\)/)
    expect(code).toMatch(/loadOrders\.bind\(null, chain\.token\)/)
  })
})
