import { expect, type Page, test } from '@playwright/test'
import type { Pool } from '../../../packages/db/src/pool'
import { openPool, OLD, reset, SEEDED, seed, type Seeded } from '../fixtures/db'

/**
 * THE INDEXED LEG: EXPLORE, ⌘K AND THE TOKEN PAGE'S TABLES.
 *
 * `DATABASE_URL` IS REQUIRED AND ITS ABSENCE FAILS. A skipped gate reads
 * exactly like a passing one, and a Postgres service is one block of YAML in
 * CI. `web/e2e/fixtures/db.ts` throws rather than returning a null pool.
 *
 * THE SERVER HERE IS A DIFFERENT PROCESS from the chain leg's -- same build,
 * opposite environment. The chain leg's whole claim is that the page works
 * with `DATABASE_URL` stripped; this leg's is what the page does when the
 * database answers. One server could only ever have made one of the two.
 *
 * LOCATORS ARE ACCESSIBLE NAMES, NOT TEST IDS. Not a style preference: the
 * cards, the pager and the tables are reached the way a screen-reader user
 * reaches them, so a change that keeps the markup working but destroys the
 * accessible name breaks this suite instead of shipping.
 *
 * EVERY ASSERTION STATES ITS PRECONDITION. "The second page differs from the
 * first" is meaningless unless there ARE two pages, so the row count is
 * asserted from the DATABASE before the pager is touched.
 */

const BASE = process.env.E2E_DB_BASE_URL ?? ''

let pool: Pool | null = null
let fixture: Seeded | null = null

function url(path: string): string {
  return `${BASE}${path}`
}

/** The launches grid, by the `aria-label` `TokenGrid` gives it. */
function grid(page: Page) {
  return page.getByRole('list', { name: 'Launches' })
}

/**
 * The cards' accessible names, in DOM order. That order IS the sort.
 *
 * IT WAITS FOR THE GRID FIRST, AND THAT IS NOT A TIMING WORKAROUND.
 *
 * `app/(explore)/loading.tsx` opens a Suspense boundary, so the response
 * STREAMS: the shell (banner, empty `<main>`, skeleton) is flushed first and
 * the list arrives afterwards. `evaluateAll` does not auto-wait, so reading
 * straight after `goto` measured the skeleton and reported zero cards on a
 * page that was about to render thirty. The same streaming behaviour is what
 * made a `notFound()` answer 200 earlier in this phase; it is a property of
 * this application, not of this test.
 */
async function cardNames(page: Page): Promise<string[]> {
  await expect(grid(page)).toBeVisible()
  const links = grid(page).getByRole('link')
  return (await links.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label') ?? ''),
  )) as string[]
}

/**
 * Opens ⌘K and WAITS FOR IT, retrying the keypress.
 *
 * MEASURED: the shortcut is installed by an effect in `SearchTrigger`, so a
 * keypress that lands before hydration goes nowhere and the dialog never
 * opens. `expect(dialog).toBeVisible()` retries the ASSERTION but not the
 * PRESS, which is how this surfaced as a 90-second timeout on `getByRole
 * ('combobox')` rather than as anything to do with hydration.
 *
 * Retrying is not papering over a race: "the shortcut works before the
 * JavaScript that implements it has loaded" is not a claim anybody wants to
 * make. What IS claimed -- that it opens, traps focus and closes -- is
 * asserted immediately after.
 */
async function openSearch(page: Page) {
  const dialog = page.getByRole('dialog')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.keyboard.press('ControlOrMeta+k')
    try {
      await dialog.waitFor({ state: 'visible', timeout: 1_500 })
      return dialog
    } catch {
      /* not hydrated yet; press again */
    }
  }
  await expect(dialog, 'the ⌘K shortcut never opened the dialog').toBeVisible()
  return dialog
}

test.beforeAll(async () => {
  expect(
    BASE,
    'the database leg needs E2E_DB_BASE_URL — the global setup publishes it only when ' +
      'DATABASE_URL is set. This FAILS rather than skipping: a gate that quietly does not ' +
      'run is not a gate.',
  ).not.toBe('')
  pool = await openPool()
  await reset(pool)
  fixture = await seed(pool)
})

test.afterAll(async () => {
  // THE POOL IS THIS SUITE'S TO OWN. A previous round of this project left
  // database processes running for hours; every handle opened here is closed
  // here, whatever happened above.
  await pool?.end().catch(() => undefined)
})

test.describe.configure({ mode: 'serial' })

test('the fixture landed — the precondition every assertion below leans on', async () => {
  const { rows } = await pool!.query<{ n: string }>('SELECT count(*)::text AS n FROM launches')
  expect(Number(rows[0]!.n), 'the seed must have written every launch').toBe(SEEDED)
  const trades = await pool!.query<{ n: string }>('SELECT count(*)::text AS n FROM trades')
  expect(Number(trades.rows[0]!.n), 'the seed must have written trades').toBeGreaterThan(0)
})

test('Explore draws the indexed list, and the empty-state branches are NOT taken', async ({
  page,
}) => {
  await page.goto(url('/'))

  const names = await cardNames(page)
  const main = (await page.getByRole('main').textContent()) ?? ''
  expect(
    names.length,
    `the first page must carry cards. main said:\n${main.slice(0, 800)}`,
  ).toBeGreaterThan(0)

  /*
   * THE EMPTY BRANCHES ARE RULED OUT AFTER THE GRID HAS ARRIVED.
   *
   * Checked before the wait they were vacuously satisfied by the streamed
   * skeleton, which contains neither string -- the same trap that made the
   * card count read zero. "The list rendered" only means the list once the
   * placeholders are known to be absent from the SETTLED page.
   */
  await expect(page.getByText('No launches yet.')).toHaveCount(0)
  await expect(page.getByText(/could not be read/i)).toHaveCount(0)
})

test('the five sorts are five different orders, not five different URLs', async ({ page }) => {
  const orders = new Map<string, string[]>()
  for (const sort of ['recentBuys', 'newest', 'oldest', 'marketCap', 'volume']) {
    await page.goto(url(`/?sort=${sort}`))
    const names = await cardNames(page)
    expect(names.length, `${sort} returned nothing`).toBeGreaterThan(0)
    orders.set(sort, names)
  }

  /*
   * THE ASSERTION THAT MATTERS, AND WHY IT IS MONOTONICITY RATHER THAN
   * "`oldest` IS `newest` REVERSED".
   *
   * The reversal claim was the first version and it is FALSE for a paged list:
   * the fixture holds 30 rows and a page holds 24, so `newest` returns 29..06
   * and `oldest` returns 00..23. Reversing the first gives 06..29, which is a
   * different set — the test would have reported a defect in a correct pager.
   *
   * Monotonicity in the fixture's own index is the property that actually
   * holds, at any page size, and it still kills the mutant that matters: a
   * `sort` parameter falling through to the default would give five identical
   * lists and one of these two directions would be violated.
   */
  const index = (name: string): number => Number(/Fixture (\d+)/.exec(name)?.[1] ?? '-1')
  const newest = orders.get('newest')!.map(index)
  const oldest = orders.get('oldest')!.map(index)
  expect(newest.every((n) => n >= 0) && oldest.every((n) => n >= 0)).toBe(true)

  for (let i = 1; i < newest.length; i += 1) {
    expect(newest[i]!, '`newest` must descend by creation order').toBeLessThan(newest[i - 1]!)
  }
  for (let i = 1; i < oldest.length; i += 1) {
    expect(oldest[i]!, '`oldest` must ascend by creation order').toBeGreaterThan(oldest[i - 1]!)
  }
  // And the two are genuinely different pages, not one order printed twice.
  expect(newest[0], '`newest` and `oldest` must not start at the same row').not.toBe(oldest[0])
})

test('the three age filters actually exclude, and the exclusion is the fixture’s own', async ({
  page,
}) => {
  // PRECONDITION: the fixture contains rows OUTSIDE the 24h window. Without
  // it, "the 24h list is shorter" could hold because the page broke.
  expect(OLD, 'the fixture must contain rows older than a day').toBeGreaterThan(0)

  await page.goto(url('/?age=all'))
  const all = await cardNames(page)
  await page.goto(url('/?age=7'))
  const week = await cardNames(page)
  await page.goto(url('/?age=1'))
  const day = await cardNames(page)

  expect(day.length, 'a 24h filter must exclude the week-old rows').toBeLessThan(all.length)
  expect(week.length).toBeGreaterThanOrEqual(day.length)
})

test('the keyset pager goes forward to NEW rows and back to the SAME ones', async ({ page }) => {
  await page.goto(url('/?sort=newest'))
  const first = await cardNames(page)
  expect(first.length, 'page one must be full enough to have a second').toBeGreaterThan(0)

  /*
   * EACH NAVIGATION WAITS FOR ITS OWN CARD COUNT, NOT FOR `networkidle`.
   *
   * MEASURED. After a client-side navigation the PREVIOUS page's grid is still
   * mounted while the next one streams in, so every "wait for the grid" check
   * is satisfied by stale content and the comparison runs against the page the
   * test just left. That produced a failure claiming "going back must land on
   * the SAME rows" while showing page TWO's six rows -- a true observation of
   * the wrong moment. `toHaveCount` auto-waits, and the counts are DERIVED
   * (page size, and the fixture's remainder) rather than typed in.
   */
  const remainder = SEEDED - first.length
  expect(remainder, 'the fixture must spill onto a second page').toBeGreaterThan(0)

  /*
   * THE URL IS WAITED FOR BEFORE THE CONTENT, AND THAT ORDER IS THE FIX.
   *
   * Waiting only on the card count was FLAKY -- it passed one run and hung on
   * the next with the previous page's rows still mounted. The two possible
   * causes are different defects and a count assertion cannot tell them apart:
   * the navigation never happened (a `<Link>` clicked before hydration), or it
   * happened and rendered the wrong page. Waiting for the URL first splits
   * them, so a failure names which one it was.
   */
  const next = page.getByRole('link', { name: 'Next', exact: true })
  await expect(next, 'the fixture must be larger than one page').toHaveCount(1)
  await next.click()
  await page.waitForURL((u) => u.searchParams.has('after'), { timeout: 30_000 })
  await expect(grid(page).getByRole('link')).toHaveCount(remainder, { timeout: 30_000 })
  const second = await cardNames(page)

  // FORWARD MUST NOT REPEAT. A cursor that failed to advance would show page
  // one again and a naive "the second page rendered" check would pass.
  expect(second.length).toBeGreaterThan(0)
  expect(
    second.some((name) => first.includes(name)),
    'the two pages must not overlap',
  ).toBe(false)

  // `Prev`, not `Previous` -- that is the control's accessible name, and this
  // is exactly the kind of drift a locator built from an accessible name is
  // supposed to catch. The disabled state renders a `<span aria-hidden>`
  // rather than a link, so `toHaveCount(1)` also asserts the button is LIVE.
  const previous = page.getByRole('link', { name: 'Prev', exact: true })
  await expect(previous).toHaveCount(1)
  await previous.click()
  await page.waitForURL((u) => !u.searchParams.has('after'), { timeout: 30_000 })
  await expect(grid(page).getByRole('link')).toHaveCount(first.length, { timeout: 30_000 })
  expect(await cardNames(page), 'going back must land on the SAME rows').toEqual(first)
})

test('⌘K resolves a PASTED ADDRESS from the index, and refuses one that is not a launch', async ({
  page,
}) => {
  await page.goto(url('/'))
  const dialog = await openSearch(page)

  await page.getByRole('combobox').fill(fixture!.tokens[0]!)
  await expect(dialog.getByText(fixture!.names[0]!)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('combobox').fill(fixture!.absent)
  /*
   * A NAME IS NEVER DRAWN FOR AN UNVERIFIED ADDRESS. A forger can return a
   * real launch's `name()`, `symbol()` and `uri()` verbatim; printing them
   * would be doing the forgery's work. The refusal carries the address and
   * nothing else, and BOTH halves are asserted -- the refusal appearing, and
   * the previous result's name being gone.
   */
  /*
   * TWO SURFACES, ASSERTED SEPARATELY, BECAUSE THERE REALLY ARE TWO.
   *
   * The sentence appears twice: once in the `sr-only` live region that
   * announces the verdict, and once in the visible refusal card. A single
   * locator hit both and Playwright refused it in strict mode -- which was the
   * right answer, because the two are different requirements and collapsing
   * them would let either one disappear unnoticed.
   */
  await expect(dialog.getByTestId('search-announcement')).toHaveText(
    'This address is not an arcpad launch.',
    { timeout: 15_000 },
  )
  await expect(dialog.getByText(/could not be derived from arcpad/i)).toBeVisible()
  await expect(dialog.getByText(fixture!.names[0]!)).toHaveCount(0)
})

/**
 * THE TEXT SEARCH, WHICH USED TO BE A DECLARED 503 AND IS NOW A REAL QUERY.
 *
 * This test asserted the honest "we could not look" message while
 * `searchTokens` was missing from `@arcpad/db`, precisely so it would go RED
 * the day the query landed rather than quietly passing against a working
 * search. `c035a88` landed it, `web/lib/releaseGate.ts` expired the cell, and
 * this is the rewrite that closes it.
 *
 * WHAT IT MEASURES THAT A UNIT TEST CANNOT: the query, the route's parameter
 * binding, the client's debounce and the modal's rendering, over a real
 * Postgres with real trigram indexes.
 */
test('the text search returns matching rows, over the real query', async ({ page }) => {
  const response = await page.request.get(url('/api/search?q=Fixture%2007'))
  expect(response.status(), 'the text path answers for real now').toBe(200)
  const body = (await response.json()) as { rows: { name: string }[]; nextCursor: string | null }
  expect(body.rows.length, 'a name that exists must match something').toBeGreaterThan(0)
  expect(body.rows.map((row) => row.name)).toContain('Fixture 07')

  /*
   * A QUERY THAT MATCHES NOTHING IS AN EMPTY PAGE, NOT AN ERROR.
   *
   * "Nothing matched" and "search is broken" are different sentences and only
   * one of them is true; collapsing them would tell a user the product is
   * down because their typo found no token. The route's 503 branch still
   * exists for a real outage -- it is simply no longer the only branch.
   */
  const empty = await page.request.get(url('/api/search?q=zzzznotatoken'))
  expect(empty.status(), 'no matches is a 200 with no rows').toBe(200)
  expect(((await empty.json()) as { rows: unknown[] }).rows).toEqual([])

  await page.goto(url('/'))
  const dialog = await openSearch(page)
  await page.getByRole('combobox').fill('Fixture 07')
  await expect(dialog.getByText('Fixture 07')).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByText('Search is unavailable right now.')).toHaveCount(0)
})

/**
 * THE 38-DIGIT CURSOR, END TO END.
 *
 * The packed key is `amount * 2^63 + created_seq`, so a `marketCap` cursor is
 * 38 digits at the testnet opening market cap and up to 97 at the limit.
 * `parseSearchParams` whitelisted `\d{1,20}`, which would have rejected EVERY
 * such cursor and silently served page one forever -- no error, no log, just a
 * list that never advances. Both the width and the paging are measured here
 * against the real query rather than against a fixture's idea of a cursor.
 */
test('search paging survives a cursor far wider than a double', async ({ page }) => {
  const first = await page.request.get(url('/api/search?q=Fixture&sort=marketCap'))
  expect(first.status()).toBe(200)
  const page1 = (await first.json()) as {
    rows: { name: string }[]
    nextCursor: string | null
  }
  expect(page1.rows.length, 'the fixture must fill a search page').toBeGreaterThan(0)
  expect(page1.nextCursor, 'a full page must carry a cursor').not.toBeNull()

  // THE PRECONDITION THIS TEST EXISTS FOR, asserted rather than assumed.
  expect(
    page1.nextCursor!.length,
    `the cursor is ${page1.nextCursor!.length} digits; a double holds 16`,
  ).toBeGreaterThan(20)
  expect(BigInt(page1.nextCursor!) > 0n, 'it must survive BigInt, never Number').toBe(true)

  const second = await page.request.get(
    url(`/api/search?q=Fixture&sort=marketCap&after=${page1.nextCursor!}`),
  )
  expect(second.status()).toBe(200)
  const page2 = (await second.json()) as { rows: { token: string }[] }
  expect(page2.rows.length, 'the second page must exist').toBeGreaterThan(0)

  // The cursor ADVANCED. A rejected cursor would serve page one again, which
  // is exactly what the narrow whitelist did and what nothing would have said.
  const firstTokens = new Set((page1.rows as unknown as { token: string }[]).map((r) => r.token))
  expect(
    page2.rows.some((row) => firstTokens.has(row.token)),
    'page two must not repeat page one — the cursor was honoured',
  ).toBe(false)
})

test('the token page draws the indexed trade and holder tables', async ({ page }) => {
  const busy = fixture!.busy
  // PRECONDITION from the DATABASE, not from this file's idea of the fixture.
  const { rows } = await pool!.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM trades WHERE token = $1',
    [busy],
  )
  expect(
    Number(rows[0]!.n),
    'this token must have trades for the table to mean anything',
  ).toBeGreaterThan(0)

  await page.goto(url(`/token/${busy}`))
  // The indexed branch, said on screen: no chain-only fallback notice.
  await expect(page.getByTestId('unavailable-notice')).toHaveCount(0)
  await expect(page.getByTestId('chain-drawn-launch')).toHaveCount(0)

  await expect(page.getByRole('tab', { name: /Trades/ })).toBeVisible()
  await expect(page.getByRole('tabpanel').first()).toBeVisible()

  await page.getByRole('tab', { name: /Holders/ }).click()
  await expect(page.getByRole('tabpanel').first()).toBeVisible()
})

test('a token with NO trades shows the empty state, not a zero', async ({ page }) => {
  // The fixture gives trades to every third token, so this one has none --
  // asserted from the database rather than inferred from the index.
  const quiet = fixture!.tokens[1]!
  const { rows } = await pool!.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM trades WHERE token = $1',
    [quiet],
  )
  expect(Number(rows[0]!.n), 'this token must have NO trades').toBe(0)

  await page.goto(url(`/token/${quiet}`))
  // "No trades yet" and "0 trades" are different sentences; only the first is
  // true for a launch nobody has touched.
  await expect(page.getByText(/No trades yet/i).first()).toBeVisible()
})

/**
 * =========================================================================
 *  THE TOKEN PAGE'S "LOAD MORE" — THE HALF NO UNIT TEST COULD SEE.
 * =========================================================================
 *
 * `<TradesTable>` and `<HoldersTable>` had working keyset paging and tests
 * that drove `loadMore` directly. Both were green for the whole of Phase 4
 * while `app/token/[address]/page.tsx` PASSED NEITHER PROP, so the button did
 * not exist on any real page and the product was capped at 25 trades and 25
 * holders. A component test cannot see that: it supplies the prop itself.
 *
 * This is the same failure mode as `<TradePanel>` — written, tested, and
 * rendered by nothing — and it is why this assertion lives in a browser
 * against a real server action rather than in jsdom.
 *
 * EVERY NUMBER BELOW COMES FROM THE DATABASE. The page size (25) is the only
 * literal, and it is asserted to be smaller than the row count before anything
 * is clicked; otherwise "the button appeared" would be a claim about a button
 * that had nothing to fetch.
 */
const TOKEN_PAGE_SIZE = 25

async function countOf(sql: string, token: string): Promise<number> {
  const { rows } = await pool!.query<{ n: string }>(sql, [token])
  return Number(rows[0]!.n)
}

test('the trades tab pages past 25, and the tab label counts what is DRAWN', async ({ page }) => {
  const deep = fixture!.deep
  const total = await countOf('SELECT count(*)::text AS n FROM trades WHERE token = $1', deep)
  expect(total, 'the fixture must exceed one page or this test proves nothing').toBeGreaterThan(
    TOKEN_PAGE_SIZE,
  )

  await page.goto(url(`/token/${deep}`))

  // NAMED, not `getByRole('table')`. The curve chart draws its own <table> as
  // the sr-only text alternative for the SVG, so an unnamed locator counts a
  // row that is not a trade -- measured here as 27 where 26 was expected.
  const bodyRows = page.getByRole('table', { name: /Recent trades/ }).getByRole('row')
  // The header row is a row too; the page size plus it.
  await expect(bodyRows).toHaveCount(TOKEN_PAGE_SIZE + 1)
  await expect(page.getByRole('tab', { name: `Trades (${TOKEN_PAGE_SIZE})` })).toBeVisible()

  const more = page.getByRole('button', { name: 'Load more trades' })
  await expect(more, 'a next cursor exists, so the button must be reachable').toBeVisible()
  await more.click()

  // EVERY remaining row arrives, and the LABEL moves with the table. A label
  // read from the server's first page would still say (25) here — the defect
  // the fix itself introduced, and the reason the paging state was lifted.
  await expect(bodyRows).toHaveCount(total + 1)
  await expect(page.getByRole('tab', { name: `Trades (${total})` })).toBeVisible()
  // The cursor is exhausted, so the button goes away rather than fetching
  // an empty page forever.
  await expect(more).toHaveCount(0)
})

test('the holders tab pages past 25, and no wallet is repeated across the tie', async ({
  page,
}) => {
  const deep = fixture!.deep
  const total = await countOf(
    `SELECT count(*)::text AS n
       FROM holders h JOIN curve_state c ON c.token = h.token
      WHERE h.token = $1 AND h.balance_tok > 0 AND h.holder <> c.curve`,
    deep,
  )
  expect(total).toBeGreaterThan(TOKEN_PAGE_SIZE)

  // THE TIE IS THE POINT. The keyset is `(balance_tok DESC, holder ASC)` and
  // the page boundary is inside a group of equal balances, which is where a
  // single-key cursor repeats or skips a row.
  const { rows: tied } = await pool!.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT balance_tok FROM holders WHERE token = $1 AND balance_tok > 0
        GROUP BY balance_tok HAVING count(*) > 1) t`,
    [deep],
  )
  expect(Number(tied[0]!.n), 'the fixture must contain tied balances').toBeGreaterThan(0)

  await page.goto(url(`/token/${deep}`))
  await page.getByRole('tab', { name: /Holders/ }).click()

  const table = page.getByRole('table', { name: /Token holders/ })
  await expect(table.getByRole('row')).toHaveCount(TOKEN_PAGE_SIZE + 1)

  const more = page.getByRole('button', { name: 'Load more holders' })
  await expect(more).toBeVisible()
  await more.click()

  await expect(table.getByRole('row')).toHaveCount(total + 1)
  await expect(page.getByRole('tab', { name: `Holders (${total})` })).toBeVisible()

  // NO DUPLICATES. The rank column is positional, so a repeated wallet would
  // show the same shortened address twice with two different numbers beside
  // it — and the percentages already do not sum to 100, so nothing else on
  // screen would give it away.
  const shown = await table
    .getByRole('row')
    .locator('td:nth-child(2)')
    .evaluateAll((cells) => cells.map((c) => c.textContent ?? ''))
  expect(new Set(shown).size, 'a wallet must not appear on both pages').toBe(shown.length)
})

/**
 * =========================================================================
 *  THE STALE NOTICE, WHICH NOTHING HAD EVER EXECUTED.
 * =========================================================================
 *
 * `MAINNET-READINESS.md` §2.4 says `stalenessOf` has "zero consumers in
 * web/app or web/components" and that nothing tells a user the index is
 * behind. THE FIRST HALF WAS TRUE AND THE SECOND WAS NOT: `<StaleNotice>`
 * landed on both pages in `0b4f9c2`, and only the HELPER was unused (both
 * sites had inlined the same three-way expression; they call it now).
 *
 * What WAS true is worse than the claim and nobody wrote it down: no test in
 * this repository imported `<StaleNotice>` at all, so its two call sites --
 * the only thing standing between a user and a stale price rendered as a live
 * one -- had never been executed by anything. "Present in the source" and
 * "reachable on the page" are the distinction this whole phase is about.
 *
 * THE LAG IS WRITTEN ONTO `sync_state`, NOT SIMULATED. The threshold is
 * `packages/db`'s (`now() - updated_at > 30s`, the SERVER's clock), so making
 * the row genuinely old is the only way to cross the real boundary. This test
 * runs LAST and puts the cursor back, because every assertion above depends on
 * the notice being absent.
 */
test('a lagging indexer says so, on BOTH pages, and the trade panel says it is unaffected', async ({
  page,
}) => {
  const before = await pool!.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM sync_state WHERE id = 1 AND now() - updated_at > interval '30 seconds'",
  )
  expect(
    Number(before.rows[0]!.n),
    'PRECONDITION: the fixture must start FRESH, or this test proves nothing',
  ).toBe(0)

  try {
    await pool!.query(
      "UPDATE sync_state SET updated_at = now() - interval '9 minutes' WHERE id = 1",
    )

    await page.goto(url('/'))
    const onExplore = page.getByTestId('stale-notice')
    await expect(onExplore).toBeVisible()
    await expect(onExplore).toContainText('Prices and volumes may be out of date')
    // The LAG ITSELF, formatted by `describeLag`: 540s -> "9m ago". A notice
    // that appeared but reported "0s ago" would be worse than none.
    await expect(onExplore).toContainText('9m ago')
    // AND the sentence a user needs in order to act: the number they sign
    // against is read from the chain, not from this index.
    await expect(onExplore).toContainText('Trading reads reserves straight from the chain')

    await page.goto(url(`/token/${fixture!.deep}`))
    const onToken = page.getByTestId('stale-notice')
    await expect(onToken).toBeVisible()
    await expect(onToken).toContainText('This page may be out of date')
  } finally {
    // Whatever happened above, the fixture goes back. A leaked stale cursor
    // would make every re-run of the tests above fail for the wrong reason.
    await pool!.query('UPDATE sync_state SET updated_at = now() WHERE id = 1')
  }
})
