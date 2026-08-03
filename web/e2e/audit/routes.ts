import { expect } from '@playwright/test'

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
