import { expect, type Page } from '@playwright/test'

/**
 * THE FOUR SURFACES EVERY AUDIT SPEC WALKS, AND THE THREE VIEWPORTS.
 *
 * One list, imported by four specs. Not tidiness: a route added to the a11y
 * spec and forgotten in the network spec produces a page nobody checked for
 * third-party requests, and NOTHING would say so -- the exact shape of the
 * completeness check that was vacuous for one action earlier in this project.
 * The audits differ in what they measure, never in what they cover.
 */

export const VIEWPORTS = [
  { name: 'phone', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

export type Viewport = (typeof VIEWPORTS)[number]

/**
 * The token launched by `deployArcpad` itself, published by the global setup.
 *
 * IT IS READ AT CALL TIME, NOT AT MODULE LOAD. Playwright imports every spec
 * file before the global setup's environment reaches the worker in some run
 * modes; a module-level constant would freeze the empty string and every route
 * would be `/token/`.
 */
export function auditToken(): string {
  const token = process.env.E2E_TOKEN ?? ''
  expect(token, 'the global setup must publish E2E_TOKEN').toMatch(/^0x[0-9a-fA-F]{40}$/)
  return token
}

export type AuditRoute = {
  readonly name: string
  /**
   * THE PATH IS A FUNCTION, NOT A STRING, AND THAT IS NOT A STYLE CHOICE.
   *
   * Test titles are built from this list at COLLECTION time, before the global
   * setup has run, so a `path` string would have to call `auditToken()` there
   * -- and it did, which made `playwright test --list` fail outright with "the
   * global setup must publish E2E_TOKEN". A harness that cannot be listed
   * cannot be inspected, and the failure looked like a broken suite rather
   * than a lifecycle mistake. Calling it inside the test keeps the assertion
   * loud where it belongs and the titles stable where they belong.
   */
  readonly path: () => string
  /** Opened with the keyboard after load; used by the a11y and network specs. */
  readonly openSearch?: boolean
}

export function auditRoutes(): readonly AuditRoute[] {
  return [
    { name: 'explore', path: () => '/' },
    { name: 'token', path: () => `/token/${auditToken()}` },
    { name: 'create', path: () => '/create' },
    { name: 'search-modal', path: () => '/', openSearch: true },
  ]
}

/**
 * ============ ⌘K'YI HIDRASYONLA YARISMADAN BASAR ============
 *
 * TEK YERDE, UC SPEC ICIN, VE BU DOSYANIN KENDI GEREKCESIYLE AYNI: a11y,
 * network ve responsive spec'lerinin ucu de ayni uc satiri kopyalamisti ve
 * ucu de ayni yarisi tasiyordu.
 *
 * YARIS OLCULDU. `page.goto` `load`ta cozulur; `SearchTrigger`in `keydown`
 * dinleyicisi ise bir `useEffect` icinde, yani HIDRASYONDAN SONRA baglanir.
 * Aradaki pencerede basilan tus, dinleyicisi olmadigi icin SESSIZCE kaybolur.
 *
 * Sonucu 2026-08-17'de goruldu ve iki kez farkli davrandi: CI'da
 * `getByRole('dialog')` 15 saniye bekleyip DUSTU, ayni suite yerelde GECTI.
 * Modalin `role="dialog"`u ZATEN VAR (`ui/Dialog.tsx:157`) -- eksik olan rol
 * degil, tusun varis anıydı. Ve bazen gecen bir kapi, tutarli dusenden
 * KOTUDUR: birine guvenilemez, otekine bakilir.
 *
 * TEKRAR, KORLUK DEGIL. Her denemeden ONCE gorunurluk sinanir, yani acilmis
 * bir modal ikinci bir basimla KAPATILMAZ (`setOpen(c => !c)` bir anahtardir).
 * Ve deneme sayisi SINIRLIDIR: gercekten olu bir kisayol yine kirmizi olur,
 * yalnizca mesaji artik "yavas" ile "yok"u ayirir.
 */
export async function openSearchWithKeyboard(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.keyboard.press('ControlOrMeta+k')
    if (await dialog.isVisible()) return
    // Hidrasyon henuz dinleyiciyi baglamamis olabilir; kisa bir soluk ver.
    await page.waitForTimeout(150)
    if (await dialog.isVisible()) return
  }
  await expect(dialog, 'on denemede de ⌘K modali acmadi -- kisayol YAVAS degil, OLU').toBeVisible()
}
