import { expect, type Page, test } from '@playwright/test'
import type { Pool } from '../../../packages/db/src/pool'
// THE PAGE SIZE AND THE TAB LIST ARE IMPORTED, NOT TYPED IN. Both are product
// decisions that have already moved once (`PAGE_SIZE` 24 -> 48, five sorts ->
// four tabs), and a copy of either in this file is a copy that can go stale
// without failing -- which is precisely what happened to the tests below.
// `explore/params` is safe to import here: its only dependency is a TYPE
// (`SortKey`), which the transform erases. `search/params` is NOT imported for
// exactly that reason -- it pulls `SEARCH_SORT_KEYS` at RUNTIME through the
// `@/` alias, no e2e file resolves that alias today, and a module that fails to
// load takes all fourteen tests with it.
import { PAGE_SIZE, TAB_KEYS, type TabKey, tabHref } from '../../components/explore/params'
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

/** `Fixture 07` -> 7. The fixture's own creation index, and therefore its order. */
function fixtureIndex(name: string): number {
  return Number(/Fixture (\d+)/.exec(name)?.[1] ?? '-1')
}

/*
 * THE NEXT THREE TESTS WERE REWRITTEN AGAINST THE URL THIS PAGE ACTUALLY HAS,
 * AND THE STORY IS WORTH KEEPING.
 *
 * They drove `/?sort=oldest`, `/?age=1` and a `Next` link that writes `?after=`.
 * NONE of those three exist on Explore. `parseExploreParams` reads `tab` and
 * `page` and DERIVES the sort and the age window from `TABS` -- deliberately,
 * so that one view has exactly one canonical address -- and the pager here is
 * `NumberedPager`, which writes `?page=`.
 *
 * So every one of those URLs rendered the DEFAULT tab, and the suite reported
 * "`oldest` must ascend by creation order": a TRUE observation of a list nobody
 * had asked for.
 *
 * WHY IT SURVIVED: this suite is `serial` and fail-fast, and the first CI run
 * ever to reach this line is the run that failed it. A suite can encode a
 * deprecated contract indefinitely as long as something above it stops first.
 *
 * AND THE HALF THAT PASSED IS THE MORE USEFUL LESSON. The default tab is
 * `trending`, which sorts by `search_key(volume_24h_wei, created_seq) DESC`;
 * the fixture's volumes TIE, so that expression degenerates to `created_seq
 * DESC` -- exactly the order the `newest` assertion was looking for. A green
 * assertion measuring a different sort.
 */

/**
 * THE ROW COUNT IS WHAT KILLS THE FALL-THROUGH MUTANT, NOT THE ORDER.
 *
 * Same reason as the coincidence above: under ties two tabs can share an
 * ORDER, but they cannot share a COUNT, because `new` carries a seven-day
 * window and `trending` carries none. The counts are derived from the fixture's
 * own constants, so a fixture change moves the expectation with it.
 */
test('the four tabs are four views, not four URLs', async ({ page }) => {
  expect(OLD, 'the fixture must hold rows outside the 7-day window').toBeGreaterThan(0)
  expect(
    SEEDED,
    'these counts are whole lists, so the fixture must fit one page',
  ).toBeLessThanOrEqual(PAGE_SIZE)

  const orders = new Map<TabKey, string[]>()
  for (const tab of TAB_KEYS) {
    // `tabHref` is the product's own function: the default tab is `/`, not
    // `/?tab=trending`, and hard-coding the latter would test a URL the
    // FilterBar never emits.
    await page.goto(url(tabHref(tab)))
    const names = await cardNames(page)
    expect(names.length, `${tab} returned nothing`).toBeGreaterThan(0)
    orders.set(tab, names)
  }

  /*
   * THE WINDOW BELONGS TO THE TAB. `trending` has none, `new` has seven days,
   * and the fixture's last `OLD` rows are dated seven days AND some minutes
   * back (`ageDays * 86_400_000 + i * 60_000`), so the exclusion is a margin
   * rather than a boundary coin-flip.
   */
  expect(orders.get('trending')!.length, '`trending` must filter no rows by age').toBe(SEEDED)
  expect(orders.get('new')!.length, '`new` must exclude the rows older than 7 days').toBe(
    SEEDED - OLD,
  )

  // AND SO DOES THE ORDER: `new` is `created_seq DESC`.
  const fresh = orders.get('new')!.map(fixtureIndex)
  expect(
    fresh.every((n) => n >= 0),
    'every card must carry a fixture name',
  ).toBe(true)
  for (let i = 1; i < fresh.length; i += 1) {
    expect(fresh[i]!, '`new` must descend by creation order').toBeLessThan(fresh[i - 1]!)
  }

  /*
   * `nearGraduation` IS THE ONE LIST THE FIXTURE CANNOT TIE WITH `new`, AND IT
   * HOLDS EITHER WAY THE PROGRESS FALLS.
   *
   * `new`'s top is deterministic: `created_seq DESC` over the rows inside the
   * window, so it is index `SEEDED - OLD - 1` = 23 -- and 23 % 3 = 2, so that
   * row carries NO trades.
   *
   * If progress VARIES (trades land on every third token) the top of this list
   * is therefore a DIFFERENT, traded row. If progress TIES the packed key
   * degenerates to `created_seq DESC` and the top is the newest row overall,
   * which is inside `OLD` and therefore excluded from `new`. Both branches
   * differ from `new`'s top, so this witness does not rest on a fixture detail
   * that could quietly change.
   */
  expect(
    orders.get('nearGraduation')![0],
    '`nearGraduation` must not open on the same row as `new`',
  ).not.toBe(orders.get('new')![0])
})

/**
 * `oldest`, `recentBuys` AND THE AGE FILTER LIVE ON SEARCH, NOT ON EXPLORE.
 *
 * `SORT_KEYS` holds five keys and the tabs expose four views; `oldest` is a
 * pill in ⌘K (`SEARCH_SORT_LABELS`) and reaches `/api/search?sort=oldest`.
 * `recentBuys` is absent from the pills on purpose -- it is the empty-`q`
 * fallback, and an empty `q` draws no rows at all. The 24-hour window is the
 * same story: no tab uses `ageDays: 1`, `SEARCH_AGE_LABELS` does.
 *
 * So the direction and the exclusion are asserted against the surface that
 * HONOURS the parameter, over the real query.
 */
test('`oldest` and `newest` are opposite directions on the search route, and `age` excludes', async ({
  page,
}) => {
  const read = async (query: string): Promise<number[]> => {
    const response = await page.request.get(url(`/api/search?q=Fixture&${query}`))
    expect(response.status(), `${query} must answer`).toBe(200)
    const body = (await response.json()) as { rows: { name: string }[] }
    expect(body.rows.length, `${query} returned nothing`).toBeGreaterThan(0)
    const seq = body.rows.map((row) => row.name).map(fixtureIndex)
    expect(
      seq.every((n) => n >= 0),
      'every row must carry a fixture name',
    ).toBe(true)
    return seq
  }

  const newest = await read('sort=newest')
  const oldest = await read('sort=oldest')

  for (let i = 1; i < newest.length; i += 1) {
    expect(newest[i]!, '`newest` must descend by creation order').toBeLessThan(newest[i - 1]!)
  }
  for (let i = 1; i < oldest.length; i += 1) {
    expect(oldest[i]!, '`oldest` must ascend by creation order').toBeGreaterThan(oldest[i - 1]!)
  }
  // A `sort` falling through to the default would print one direction twice.
  expect(newest[0], '`newest` and `oldest` must not open on the same row').not.toBe(oldest[0])

  /*
   * THE EXCLUSION IS ASSERTED BY MEMBERSHIP, NOT BY LENGTH -- AND THAT IS THE
   * WHOLE POINT OF THIS BLOCK.
   *
   * `SEARCH_LIMIT` is 20 (`components/search/params.ts`). `age=all` matches 30
   * rows and `age=1` matches 24, so BOTH come back capped at 20 and the lengths
   * are IDENTICAL: "the 24h list is shorter" is not merely weak here, it is
   * FALSE. A length comparison would have failed on a WORKING filter -- the same
   * mistake as the one this file just made, in the opposite direction.
   *
   * What the cap cannot hide is WHICH rows arrive. Same sort, same first page:
   * the old rows are present without the window and absent with it. That holds
   * at any `SEEDED`, any `OLD` and any page size, so the cap is named here for
   * the reader but nothing below DEPENDS on its value -- if it ever shrank far
   * enough to hide the old rows, the first assertion is what would say so.
   */
  const OLD_FROM = SEEDED - OLD
  expect(OLD, 'the fixture must hold rows older than a day').toBeGreaterThan(0)

  const all = await read('age=all&sort=newest')
  expect(
    all.some((n) => n >= OLD_FROM),
    'without a window, `newest` must reach the fixture’s old rows',
  ).toBe(true)

  const day = await read('age=1&sort=newest')
  expect(
    day.some((n) => n >= OLD_FROM),
    'with a 24h window, not one row older than a day may appear',
  ).toBe(false)
})

/**
 * `?page=` REACHES THE QUERY'S OFFSET, AND AN OFFSET PAST THE END IS EMPTY.
 *
 * WHAT THIS FIXTURE CAN PROVE, AND WHAT IT CANNOT. `PAGE_SIZE` is 48 and the
 * fixture holds 30, so there is no second page of ROWS to compare against the
 * first: "forward must not repeat" is not reachable here and is NOT asserted.
 * The keyset behaviour it used to assert did not vanish with the pager -- it is
 * exercised on the token page's trade and holder tables below, which still use
 * `KeysetPager`, and `pageNumbers` carries its own property test.
 *
 * An offset past the end is the honest witness for the wiring: page two of a
 * one-page list must be EMPTY. An ignored `page` parameter would redraw all
 * thirty rows, which is exactly the mutant this test exists for.
 */
test('`?page=` reaches the OFFSET, and its width guard falls back to page one', async ({
  page,
}) => {
  expect(SEEDED, 'this test is written for a fixture that fits one page').toBeLessThanOrEqual(
    PAGE_SIZE,
  )

  await page.goto(url('/'))
  expect(await cardNames(page), 'page one must carry the whole fixture').toHaveLength(SEEDED)

  /*
   * The empty branch is chosen by `ageDays`, not by the row count: the default
   * tab filters no age, so this is the PRODUCT-empty text rather than the
   * FILTER-empty one. Asserting the wrong one of the two would pass on a page
   * that told the user their filter was too narrow.
   */
  await page.goto(url('/?page=2'))
  await expect(
    page.getByText('No launches yet.'),
    'an offset past the end must draw the empty state, not page one again',
  ).toBeVisible()
  await expect(grid(page).getByRole('link'), 'and it must draw no cards').toHaveCount(0)

  // The clamp is reachable: 6 digits parse, then `MAX_PAGE` caps at 10,000.
  await page.goto(url('/?page=999999'))
  await expect(
    page.getByText('No launches yet.'),
    'a clamped page is still past the end',
  ).toBeVisible()

  /*
   * AND THE WIDTH GUARD FAILS OPEN TO PAGE ONE, WHICH IS THE DOCUMENTED
   * BEHAVIOUR RATHER THAN AN ACCIDENT: `/^\d{1,6}$/` rejects seven digits
   * outright, so `?page=9999999` is not a clamped page — it is no page at all,
   * and the fallback is 1. A user editing the URL by hand gets the list, not an
   * error page.
   */
  await page.goto(url('/?page=9999999'))
  expect(
    await cardNames(page),
    'a page number too wide to parse must fall back to page one',
  ).toHaveLength(SEEDED)
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

/**
 * =========================================================================
 *  THE CHART'S REALISED LAYER, WHICH NO PAGE HAD EVER DRAWN.
 * =========================================================================
 *
 * `<CurveChart>`'s `trades` prop is optional and defaults to `[]`, and the
 * token page never passed it. So `realisedSeries([])` was always empty,
 * `realised.length > 1` was always false, and the `curve-realised` path never
 * entered the DOM on any real page — while the component's own tests passed
 * `trades` themselves and drew it happily. Third instance in this file of one
 * failure mode: A PROP THE COMPONENT TESTS SUPPLY AND THE PAGE DOES NOT.
 *
 * The fixture was hiding it a second way: `realisedSeries` keeps the LAST
 * trade per BLOCK, and all 28 deep trades were written into ONE block, so even
 * a page that passed them would have had a single point and drawn nothing.
 * They are one-per-block now.
 */
test('the curve chart draws the realised layer, and it lies ON the reference curve', async ({
  page,
}) => {
  const deep = fixture!.deep
  const { rows } = await pool!.query<{ n: string }>(
    'SELECT count(DISTINCT block_number)::text AS n FROM trades WHERE token = $1',
    [deep],
  )
  expect(
    Number(rows[0]!.n),
    'the realised layer needs trades in MORE THAN ONE block to exist at all',
  ).toBeGreaterThan(1)

  await page.goto(url(`/token/${deep}`))

  const reference = page.locator('[data-testid="curve-reference"]')
  const realised = page.locator('[data-testid="curve-realised"]')
  await expect(reference).toHaveCount(1)
  await expect(realised, 'the realised overlay must be in the DOM of a real page').toHaveCount(1)

  const parse = (d: string) =>
    [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))

  const curve = parse((await reference.getAttribute('d')) ?? '')
  const points = parse((await realised.getAttribute('d')) ?? '')
  expect(points.length, 'more than one point, or there is no line').toBeGreaterThan(1)

  /*
   * ON A BONDING CURVE THE REALISED PRICE IS A FUNCTION OF TOKENS SOLD, so
   * every realised point MUST sit on the reference curve. Positioned by index
   * — which is what the code did — they do not, and the chart shows a price
   * history that this curve cannot produce.
   */
  for (const point of points) {
    const seg = curve.find((_, i) => i > 0 && curve[i - 1]!.x <= point.x && point.x <= curve[i]!.x)
    const prev = seg === undefined ? undefined : curve[curve.indexOf(seg) - 1]
    expect(seg !== undefined && prev !== undefined, `x=${point.x} is off the reference curve`).toBe(
      true,
    )
    const t = seg!.x === prev!.x ? 0 : (point.x - prev!.x) / (seg!.x - prev!.x)
    expect(Math.abs(point.y - (prev!.y + t * (seg!.y - prev!.y)))).toBeLessThan(1)
  }

  // AND THE CAPTION NAMES THE AXIS IT ACTUALLY USES. It said "the x axis is
  // blocks", which was false before the fix and after it.
  await expect(page.getByText(/x axis is tokens sold/i)).toBeVisible()
})
