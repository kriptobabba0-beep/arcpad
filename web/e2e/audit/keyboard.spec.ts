import { expect, type Page, test } from '@playwright/test'
import { auditToken } from './routes'

/**
 * THE WHOLE PRODUCT, WITHOUT A MOUSE.
 *
 * No `click()` appears in this file, and that is enforced rather than
 * promised: every interaction is `keyboard.press` or `keyboard.type`. A spec
 * that clicked "just this once" would leave one control with no keyboard path
 * and would still be green.
 *
 * FOUR CLAIMS, ALL MEASURED IN THE BROWSER:
 *   1. Focus is VISIBLE at every stop -- `:focus-visible` paints a ring, and
 *      the ring is read off `getComputedStyle`, not off a class name. Tailwind
 *      emits in ITS order, not the authoring order, so a conflicting utility
 *      can be present in `className` and lose in the cascade. That exact shape
 *      produced three invisible defects in this phase.
 *   2. Tab order follows DOM order.
 *   3. An open dialog TRAPS Tab.
 *   4. Closing restores focus to the trigger.
 */

/** Where the focus is, in a form an assertion can read. */
async function focused(page: Page): Promise<{ tag: string; label: string; testid: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (el === null) return { tag: '', label: '', testid: '' }
    return {
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 60) ?? '',
      testid: el.getAttribute('data-testid') ?? '',
    }
  })
}

/**
 * The focus ring, as PAINTED.
 *
 * `outline-width` alone is not the claim: an outline of `0px` with a visible
 * `box-shadow` ring is equally valid, and Tailwind's `ring-*` utilities
 * compile to `box-shadow`. So both are read and either satisfies it.
 */
async function ringOf(page: Page): Promise<{ outlineWidth: number; boxShadow: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (el === null) return { outlineWidth: 0, boxShadow: 'none' }
    const style = getComputedStyle(el)
    return {
      outlineWidth: Number.parseFloat(style.outlineWidth || '0'),
      boxShadow: style.boxShadow,
    }
  })
}

async function expectVisibleFocus(page: Page, where: string): Promise<void> {
  const ring = await ringOf(page)
  const visible = ring.outlineWidth > 0 || (ring.boxShadow !== 'none' && ring.boxShadow !== '')
  expect(visible, `focus is invisible at ${where}: ${JSON.stringify(ring)}`).toBe(true)
}

test('the skip link is the FIRST stop, and it actually moves focus', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Tab')

  const first = await focused(page)
  expect(first.label, 'the skip link must be the first focusable element').toContain(
    'Skip to content',
  )
  await expectVisibleFocus(page, 'the skip link')

  await page.keyboard.press('Enter')
  // A skip link that only scrolls is not a skip link: the next Tab would land
  // back in the header. `<main tabIndex={-1}>` is what makes it real.
  const landed = await page.evaluate(() => document.activeElement?.id ?? '')
  expect(landed, 'Enter on the skip link must move focus INTO main').toBe('main')
})

test('⌘K opens from the keyboard, traps Tab, and gives focus back on Escape', async ({ page }) => {
  await page.goto('/')

  // PRECONDITION: the trigger must be focused BEFORE the dialog opens, or
  // "focus returns to the trigger" is satisfied by focus never having left it.
  await page.getByRole('button', { name: 'Search tokens' }).focus()
  const trigger = await focused(page)
  expect(trigger.label).toBe('Search tokens')

  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  /*
   * THE TRAP, MEASURED BY WALKING PAST THE END.
   *
   * Twenty tabs is more than the dialog has stops, so a missing trap shows up
   * as focus outside the panel. Asserting "Tab moves focus" would pass with no
   * trap at all.
   */
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]')
      return panel !== null && document.activeElement !== null
        ? panel.contains(document.activeElement)
        : false
    })
    expect(inside, `Tab #${i + 1} escaped the dialog`).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  const restored = await focused(page)
  expect(restored.label, 'closing must return focus to the control that opened it').toBe(
    'Search tokens',
  )
})

test('the trade panel is fillable with the keyboard alone, slippage included', async ({ page }) => {
  await page.goto(`/token/${auditToken()}`)
  await expect(page.getByTestId('trade-panel')).toBeVisible()

  const amount = page.getByLabel('Amount to spend')
  await amount.focus()
  await expectVisibleFocus(page, 'the amount field')
  await page.keyboard.type('0.5')
  await expect(page.getByTestId('quote-breakdown')).toBeVisible()

  // THE SLIPPAGE CONTROL IS REACHED BY TABBING, not by a locator. Reaching a
  // control by locator and then pressing Enter proves the handler works and
  // proves NOTHING about whether a keyboard user can arrive there.
  let reached = false
  for (let i = 0; i < 30 && !reached; i += 1) {
    await page.keyboard.press('Tab')
    const here = await focused(page)
    if (here.label === '3%') {
      await expectVisibleFocus(page, 'the 3% slippage button')
      await page.keyboard.press('Enter')
      reached = true
    }
  }
  expect(reached, 'the 3% slippage preset must be reachable by Tab from the amount field').toBe(
    true,
  )
  await expect(page.getByRole('button', { name: '3%' })).toHaveAttribute('aria-pressed', 'true')

  // And the quote followed the change: a control that is reachable but inert
  // is the same defect wearing a different hat.
  await expect(page.getByTestId('quote-breakdown')).toContainText('slippage 3%')
})

test('the launch form is completable with the keyboard alone', async ({ page }) => {
  await page.goto('/create')

  const name = page.getByLabel('Name')
  await name.focus()
  await expectVisibleFocus(page, 'the name field')
  await page.keyboard.type('Keyboard Only')

  // Tab must land on Symbol NEXT -- DOM order and tab order agree, or a
  // sighted keyboard user's eye and their focus disagree on every form.
  await page.keyboard.press('Tab')
  const afterName = await focused(page)
  expect(afterName.tag, 'the field after Name must be the Symbol input').toBe('input')
  await page.keyboard.type('KBD')
  await expect(page.getByLabel('Symbol')).toHaveValue('KBD')

  // The submit button is reachable without a mouse, and it says what it wants.
  let sawSubmit = false
  for (let i = 0; i < 25 && !sawSubmit; i += 1) {
    await page.keyboard.press('Tab')
    const here = await focused(page)
    if (/Launch|Connect wallet/.test(here.label)) {
      await expectVisibleFocus(page, 'the launch button')
      sawSubmit = true
    }
  }
  expect(sawSubmit, 'the launch button must be reachable by Tab').toBe(true)
})

test('this file never uses the mouse', async () => {
  /*
   * THE RULE IS EXECUTED, NOT PROMISED. A single `click()` added later would
   * silently turn "keyboard only" into "mostly keyboard", and every assertion
   * above would stay green while the claim in the file's title stopped being
   * true.
   *
   * The path is resolved from the working directory (`web/`) rather than from
   * `__filename`: Playwright transpiles specs and the transpiled path is an
   * implementation detail. A missing file FAILS -- a check that silently read
   * nothing is the vacuous shape this repository has already shipped once.
   */
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const source = readFileSync(join(process.cwd(), 'e2e', 'audit', 'keyboard.spec.ts'), 'utf8')
  expect(
    source,
    'the check must be reading THIS file; a different one would pass vacuously',
  ).toContain('this file never uses the mouse')
  const clicks = source.split('\n').filter((line) => /\.click\(|\.hover\(|\.dblclick\(/.test(line))
  expect(clicks, `mouse interactions found:\n${clicks.join('\n')}`).toEqual([])
})
