import { expect, type Page, test } from '@playwright/test'
import { auditToken, openSearchWithKeyboard } from './routes'

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

  // Ayni yaris burada da var (`SearchTrigger` dinleyicisini hidrasyonda
  // baglar), o yuzden ayni yardimciyi kullanir. Iddia degismedi: modal
  // KLAVYEDEN acilir.
  await openSearchWithKeyboard(page)
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

  /*
   * DOKUM BIR ACILIRIN ARDINDA, VE ONU DA KLAVYEYLE ACMAK GEREKIR.
   *
   * `TradeCard.DetailsSection` `open` tasimayan bir `<details>`tir, yani
   * `quote-breakdown` baslangicta `hidden`dir. Bu testte acilir bir TIKLAMAYLA
   * ACILAMAZ -- iddianin tamami "klavye tek basina yeter"dir.
   *
   * Bu yuzden ozete TAB ILE varilir ve Enter ile acilir, ve boylece test
   * ESKISINDEN GUCLU hale gelir: acilirin kendisinin klavyeyle ULASILABILIR
   * oldugunu da olcer. Bir `<summary>` varsayilan olarak odaklanabilirdir, ama
   * "varsayilan olarak oyle" ile "bu sayfada oyle" ayni sey degildir.
   */
  let opened = false
  for (let i = 0; i < 20 && !opened; i += 1) {
    await page.keyboard.press('Tab')
    const here = await focused(page)
    if (here.tag === 'summary' && here.label.includes('Details')) {
      await expectVisibleFocus(page, 'the Details disclosure')
      await page.keyboard.press('Enter')
      opened = true
    }
  }
  expect(opened, 'the Details disclosure must be reachable by Tab from the amount field').toBe(true)

  await expect(page.getByTestId('quote-breakdown')).toBeVisible()

  /*
   * ============ SLIPAJ, GERCEK KONTROLU UZERINDEN ============
   *
   * BU BLOK 2026-08-17'DE YENIDEN YAZILDI, VE ONCEKI HALI VAR OLMAYAN BIR
   * KONTROLU IDDIA EDIYORDU. Eski hal `aria-pressed` tasiyan bir `3%` on ayar
   * dugmesi ariyordu ve `SlippageRow`da boyle bir dugme HIC OLMADI:
   * `git log -S aria-pressed -- SlippageRow.tsx` BOS doner, spec'te de yoktur.
   * Yani test hayali bir arayuze yazilmisti ve hicbir zaman kosulmadigi icin
   * bu gorunmedi (bkz. C-11).
   *
   * IDDIA SILINMEDI, KONUSU DUZELTILDI. "Klavye kullanicisi slipaji
   * degistirebilir" mesru ve DOGRULANMAMIS bir iddiaydi; urunun gercek yolu
   * bir kalem dugmesi + bir metin alanidir, ve o yolun kendine ozgu riski var:
   * alan `autoFocus` ile acilir, `onBlur` onu KAPATIR, Enter/Escape de kapatir
   * -- yani klavye kullanicisi degeri kaybedebilir ya da alana sikisabilir.
   * Test artik tam olarak onu yurur.
   */
  let reachedEdit = false
  for (let i = 0; i < 30 && !reachedEdit; i += 1) {
    await page.keyboard.press('Tab')
    const here = await focused(page)
    if (here.label === 'Edit max slippage') {
      await expectVisibleFocus(page, 'the edit-slippage button')
      await page.keyboard.press('Enter')
      reachedEdit = true
    }
  }
  expect(
    reachedEdit,
    'the slippage edit control must be reachable by Tab from the amount field',
  ).toBe(true)

  // `autoFocus` ODAGI GERCEKTEN TASIYOR MU: bir alan acilip odagi almazsa
  // klavye kullanicisi onu goremez ve yazdigi yer baska bir yerdir.
  const inField = await focused(page)
  expect(inField.tag, 'opening the editor must move focus INTO the input').toBe('input')

  await page.keyboard.type('3')
  await page.keyboard.press('Enter')

  // Deger yazildi, alan kapandi, ve TEKLIF onu izledi. Ucuncusu olmadan
  // "ulasilabilir ama etkisiz" bir kontrol yesil kalirdi.
  await expect(page.getByTestId('slippage-value')).toHaveText('3%')
  await expect(page.getByTestId('quote-breakdown')).toContainText('slippage 3%')

  // VE `Auto`YA DONUS YOLU EKRANDA KALDI. Elle bir deger girildikten sonra
  // rozet bir DUGMEYE doner; donmezse kullanici Auto'ya sayfayi yenilemeden
  // donemez -- `SlippageRow`un kendi yorumunun adiyla anlattigi kusur.
  await expect(page.getByTestId('slippage-auto-reset')).toBeVisible()
})

test('the launch form is completable with the keyboard alone', async ({ page }) => {
  await page.goto('/create')

  const name = page.getByLabel('Name', { exact: true })
  await name.focus()
  await expectVisibleFocus(page, 'the name field')
  await page.keyboard.type('Keyboard Only')

  // Tab must land on Symbol NEXT -- DOM order and tab order agree, or a
  // sighted keyboard user's eye and their focus disagree on every form.
  await page.keyboard.press('Tab')
  const afterName = await focused(page)
  expect(afterName.tag, 'the field after Name must be the Symbol input').toBe('input')
  await page.keyboard.type('KBD')
  await expect(page.getByLabel('Ticker', { exact: true })).toHaveValue('KBD')

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
