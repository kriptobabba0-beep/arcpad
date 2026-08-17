import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  applyCompleted,
  applyLaunch,
  applyTrade,
  applyTransfer,
  type LaunchEvent,
  setCursor,
  type TradeEvent,
} from '../../../packages/db/src/apply'
import { putDeployment } from '../../../packages/db/src/deployment'
import { toHexBytes } from '../../../packages/db/src/hex'
import { createPool, type Pool } from '../../../packages/db/src/pool'
import { toSeq } from '../../../packages/db/src/seq'

/**
 * `@arcpad/db` IS REACHED BY RELATIVE PATH, AND ITS MIGRATIONS BY SUBPROCESS.
 *
 * MEASURED, AND NEITHER HALF IS A PREFERENCE.
 *
 * Playwright transpiles the files it loads to CommonJS whenever the nearest
 * `package.json` has no `"type": "module"` -- which `web/` does not, the Phase
 * 0 carry-over this phase also did not close. `@arcpad/db` IS `"type":
 * "module"` and its `migrate.ts` resolves the migrations directory from
 * `import.meta.url`, so requiring the package BARREL dies with "Cannot use
 * 'import.meta' outside a module" before a single row is written.
 *
 * A real dynamic `import()` was tried and does not work either: the package's
 * internal imports are extensionless (`./apply`), which Node's ESM resolver
 * refuses -- measured, "Cannot find module .../src/apply".
 *
 * So the writers come in by relative path, where Playwright's own resolver
 * handles the extensions, and the MIGRATIONS are run by the REAL
 * `runMigrations` inside a `tsx` subprocess. Re-implementing the runner here
 * would have been a double doing the real code's job -- failure mode 5 in
 * AGENT-CONTEXT -- and the migration order and the applied-set bookkeeping are
 * exactly the parts a hand-rolled copy gets wrong.
 */
function tsxBin(): string {
  const require = createRequire(pathToFileURL(join(process.cwd(), 'noop.cjs')).href)
  return require.resolve('tsx/cli')
}

/**
 * Runs `@arcpad/db`'s OWN migration runner, in a context where it can load.
 *
 * A TEMPORARY `.mts` FILE, NOT `tsx --eval`. Both were measured:
 *   `--eval` transforms to CommonJS and esbuild refuses top-level await there,
 *   and wrapping in an IIFE then fails inside tsx's own CJS register shim.
 *   A real module file takes the ESM path and works.
 *
 * `cwd` IS `web/`, NOT THE REPOSITORY ROOT. `@arcpad/db` is a workspace
 * dependency of `web` and `indexer`, not of the root package, so resolving it
 * from the root fails with `ERR_MODULE_NOT_FOUND` -- measured, and it is the
 * kind of failure that reads like a broken package rather than a wrong
 * directory.
 */
export function migrate(databaseUrl: string): void {
  const script =
    "import { createPool, runMigrations } from '@arcpad/db'\n" +
    'void (async () => {\n' +
    '  const pool = createPool(process.env.DATABASE_URL as string)\n' +
    '  const applied = await runMigrations(pool)\n' +
    '  await pool.end()\n' +
    "  process.stdout.write('migrations applied: ' + JSON.stringify(applied))\n" +
    '})()\n'

  const file = join(process.cwd(), 'e2e', '.migrate.mts')
  writeFileSync(file, script, 'utf8')
  try {
    const result = spawnSync(process.execPath, [tsxBin(), file], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    })
    if (result.status !== 0) {
      throw new Error(
        `running @arcpad/db migrations failed (${result.status}):\n` +
          `${result.stdout ?? ''}${result.stderr ?? ''}`,
      )
    }
  } finally {
    // The file is this function's to own, whatever happened above.
    rmSync(file, { force: true })
  }
}

/**
 * THE INDEXED WORLD, PINNED.
 *
 * The rows below are written by hand rather than produced by running the
 * indexer, and that is the point: this leg measures what the WEB does with a
 * known database, so the database has to be known. Every number here is a
 * fixed value a spec can assert against by name.
 *
 * `DATABASE_URL` IS REQUIRED AND ITS ABSENCE IS A FAILURE, NOT A SKIP. A
 * Postgres service is one block of YAML in CI; a gate that quietly does not
 * run is not a gate. This module throws rather than returning a null pool for
 * exactly that reason.
 */

export const DB_CHAIN_ID = 5042002n

const PROFILE = {
  virtualTokenReservesTok: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReservesWei: 4_292_000_000_000_000_000n,
  saleSupplyTok: 793_100_000n * 10n ** 18n,
  totalSupplyTok: 10n ** 27n,
}

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, '0')}`
}
function hash32(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`
}

export const FACTORY = addr(0xfac)
export const ESCROW = addr(0xe5c)
export const TREASURY = addr(0x77e)
export const CREATOR = addr(0xc4ea)
export const TRADER = addr(0xa11ce)

const START_BLOCK = 54_000_000n

/**
 * TWENTY-FOUR TOKENS: enough that the first Explore page is FULL and a second
 * page exists. A fixture with fewer rows than the page size makes the keyset
 * pager's "Next" button unreachable, and every assertion about paging would
 * then pass by never being exercised.
 */
export const SEEDED = 30
/** Of those, this many are `complete` — the Explore page draws them separately. */
export const COMPLETED = 2
/** And this many are OLD: created outside the 24h window, for the age filter. */
export const OLD = 6

/**
 * ONE TOKEN WITH MORE HISTORY THAN A PAGE, because a page size that is never
 * exceeded proves nothing about paging.
 *
 * The token page asks for `TABLE_PAGE_SIZE` (25) rows per tab. A fixture whose
 * busiest token has two trades and one holder makes the "Load more" button
 * UNREACHABLE, and every assertion about paging would then pass by never being
 * exercised -- which is exactly how the missing `loadMoreTrades` prop survived:
 * the component's own tests drove `loadMore` directly and were green while NO
 * PAGE PASSED IT.
 *
 * 30 > 25, so page one is full and page two has five rows.
 */
export const DEEP_TRADES = 30
export const DEEP_HOLDERS = 30

/**
 * THE LAST TEN HOLDERS SHARE ONE BALANCE, ON PURPOSE.
 *
 * The holders keyset is `(balance_tok DESC, holder ASC)` and the SECOND key
 * exists because balances tie. With 30 holders and a 25-row page the boundary
 * falls INSIDE the tied group, so a single-key cursor would repeat or skip a
 * wallet right where a user would see it. A fixture with 30 distinct balances
 * would let that mutant live.
 */
const TIED_FROM = 20

export type Seeded = {
  readonly tokens: readonly `0x${string}`[]
  /** A token with trades and holders, for the token page's tables. */
  readonly busy: `0x${string}`
  /**
   * A token with MORE than one page of both trades and holders.
   *
   * Its exact row counts are deliberately NOT promised here: the shared
   * transfer the main loop writes lands among these balances, so the specs
   * read the counts and the expected order out of the DATABASE. A fixture
   * that states a number this file has to keep true is a number that goes
   * quietly wrong.
   */
  readonly deep: `0x${string}`
  /** A canonical-looking address that is NOT in the database. */
  readonly absent: `0x${string}`
  readonly names: readonly string[]
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? ''
  if (url === '') {
    throw new Error(
      'the database leg requires DATABASE_URL and does NOT skip without it. ' +
        'A skipped gate reads exactly like a passing one; a Postgres service is one ' +
        'block of YAML in CI.',
    )
  }
  return url
}

export async function openPool(): Promise<Pool> {
  return createPool(requireDatabaseUrl())
}

/** Every table this leg writes, dropped so a rerun is deterministic. */
const TABLES = [
  'token_transfers',
  'holders',
  'trades',
  'curve_state',
  'token_stats',
  'creator_history',
  'fee_events',
  'fee_balances',
  'launches',
  'sync_state',
  'deployment',
]

export async function reset(pool: Pool): Promise<void> {
  migrate(requireDatabaseUrl())
  // TRUNCATE, not DROP: the schema under test is the migrated one, and a
  // rerun that recreated it would be measuring the migration rather than the
  // page. `IF EXISTS` because a table this list names may legitimately not
  // exist yet on an older migration set.
  /*
   * ONLY THE TABLES THAT EXIST, AND IN ONE STATEMENT.
   *
   * Postgres has no `TRUNCATE ... IF EXISTS`, so the set is resolved first --
   * a migration set that has not created one of these yet must not turn a
   * reset into a failure, and swallowing per-table errors would hide a real
   * one. `TABLES` is a literal list in this file, so nothing user-supplied
   * reaches the statement text.
   */
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [TABLES],
  )
  const present = rows.map((row) => row.tablename)
  if (present.length > 0) {
    await pool.query(`TRUNCATE TABLE ${present.join(', ')} CASCADE`)
  }
}

function launchEvent(index: number, createdAt: Date, block: bigint): LaunchEvent {
  const name = `Fixture ${String(index).padStart(2, '0')}`
  const symbol = `FIX${String(index).padStart(2, '0')}`
  const uri = `ipfs://bafyfixture${String(index).padStart(2, '0')}`
  return {
    kind: 'launch',
    eventSeq: toSeq(block, 0),
    blockNumber: block,
    logIndex: 0,
    txHash: hash32(0x1000 + index),
    blockTime: createdAt,
    token: addr(0x7000 + index),
    curve: addr(0xc000 + index),
    creator: CREATOR,
    name,
    symbol,
    uri,
    nameHex: toHexBytes(name),
    symbolHex: toHexBytes(symbol),
    uriHex: toHexBytes(uri),
    salt: hash32(0x5a00 + index),
    virtualTokenReservesTok: PROFILE.virtualTokenReservesTok,
    virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei,
    realTokenReservesTok: PROFILE.saleSupplyTok,
    realQuoteReservesWei: 0n,
  }
}

function tradeEvent(index: number, nth: number, at: Date, block: bigint): TradeEvent {
  const quote = BigInt(nth + 1) * 10n ** 17n
  const tokens = BigInt(nth + 1) * 10_000_000n * 10n ** 18n
  return {
    kind: 'trade',
    eventSeq: toSeq(block, nth + 1),
    blockNumber: block,
    logIndex: nth + 1,
    txHash: hash32(0x2000 + index * 16 + nth),
    blockTime: at,
    token: addr(0x7000 + index),
    curve: addr(0xc000 + index),
    trader: TRADER,
    isBuy: true,
    tokenAmountTok: tokens,
    quoteAmountWei: quote,
    protocolFeeWei: (quote * 95n) / 10_000n,
    creatorFeeWei: (quote * 30n) / 10_000n,
    virtualTokenReservesTok: PROFILE.virtualTokenReservesTok - tokens,
    /*
     * THE CURVE'S OWN RELATION, NOT `V + quote`.
     *
     * `vQ = V*T/vT` is what the chain computes (`BondingCurve`), and the
     * previous `PROFILE.virtualQuoteReservesWei + quote` was an invented
     * number that happened to increase. It made every fixture row describe a
     * curve that CANNOT EXIST, so any claim shaped like "the realised price
     * lies on the bonding curve" was unmeasurable here -- the assertion would
     * have failed against correct rendering code.
     */
    virtualQuoteReservesWei:
      (PROFILE.virtualQuoteReservesWei * PROFILE.virtualTokenReservesTok) /
      (PROFILE.virtualTokenReservesTok - tokens),
    realTokenReservesTok: PROFILE.saleSupplyTok - tokens,
    realQuoteReservesWei: quote,
  }
}

/**
 * Writes the fixture and returns what the specs need to name.
 *
 * ORDER MATTERS AND IS NOT INCIDENTAL: `event_seq` increases with the loop, so
 * `newest` and `oldest` are exact inverses of each other and a sort assertion
 * has something unambiguous to check. Arc's block timestamps are frequently
 * EQUAL between consecutive blocks (49.0% measured), so this fixture reuses
 * timestamps deliberately — a page that ordered by `block_time` would produce
 * an unstable list here and the paging assertions would flap.
 */
export async function seed(pool: Pool): Promise<Seeded> {
  await putDeployment(pool, {
    chainId: DB_CHAIN_ID,
    factory: FACTORY,
    escrow: ESCROW,
    protocolTreasury: TREASURY,
    ...PROFILE,
    startBlock: START_BLOCK,
  })

  const now = Date.now()
  const tokens: `0x${string}`[] = []
  const names: string[] = []

  for (let i = 0; i < SEEDED; i += 1) {
    // The last `OLD` entries are dated a week back so the 24h filter has
    // something to exclude and the 7d filter has something to include.
    const ageDays = i >= SEEDED - OLD ? 7 : 0
    const createdAt = new Date(now - ageDays * 86_400_000 - i * 60_000)
    const block = START_BLOCK + BigInt(i * 10)
    const event = launchEvent(i, createdAt, block)
    await applyLaunch(pool, event)
    tokens.push(event.token)
    names.push(event.name)

    // Two trades on every third token, so `recentBuys` has a real ordering and
    // the "no trades yet" empty state is still reachable on the others.
    if (i % 3 === 0) {
      for (let nth = 0; nth < 2; nth += 1) {
        await applyTrade(pool, tradeEvent(i, nth, createdAt, block))
      }
      await applyTransfer(pool, {
        kind: 'transfer',
        eventSeq: toSeq(block, 8),
        blockNumber: block,
        logIndex: 8,
        txHash: hash32(0x3000 + i),
        blockTime: createdAt,
        token: event.token,
        from: '0x0000000000000000000000000000000000000000',
        to: TRADER,
        amountTok: 20_000_000n * 10n ** 18n,
      })
    }

    if (i < COMPLETED) {
      await applyCompleted(pool, {
        kind: 'completed',
        eventSeq: toSeq(block, 9),
        blockNumber: block,
        logIndex: 9,
        txHash: hash32(0x4000 + i),
        blockTime: createdAt,
        token: event.token,
        realQuoteReservesWei: 12_161_433_369_060_378_706n,
        poolSeedSupplyTok: 206_886_011_183_597_390_493_942_218n,
      })
    }
  }

  /*
   * THE DEEP TOKEN. Index 3, and the index is chosen rather than incidental:
   *   - `i % 3 === 0`, so it already carries two trades and the shared shape;
   *   - `i >= COMPLETED`, so it is NOT complete — a `Completed` at log index 9
   *     would sit between the trades below and force them into an ordering
   *     nothing in the product produces;
   *   - `i < SEEDED - OLD`, so it is inside the 24h window like a real one.
   *
   * `SEEDED` DOES NOT CHANGE, so every count this file already promises stays
   * exactly as it was and the Explore assertions keep their meaning.
   */
  const deep = tokens[3]!
  const deepBlock = START_BLOCK + 30n
  const deepAt = new Date(now - 3 * 60_000)

  // Trades 3..DEEP_TRADES, at log indices 200+ so they cannot collide with the
  // transfer at 8 or the `Completed` at 9 that other tokens use.
  /*
   * ONE TRADE PER BLOCK, AND THAT IS NOT COSMETIC.
   *
   * `realisedSeries` samples the LAST trade in each block -- averaging would
   * draw a price that never happened. Writing all 28 into one block therefore
   * collapsed them to a SINGLE realised point, `realised.length > 1` was false,
   * and the chart's realised overlay was NEVER RENDERED in any browser. The
   * fixture was hiding a whole render path from the only leg that can see it.
   *
   * Blocks `deepBlock+1 .. deepBlock+27` overlap other tokens' launch blocks,
   * which is fine and realistic: `event_seq` is `(block << 20) | logIndex` and
   * these sit at log index 200+, where nothing else does.
   */
  for (let nth = 2; nth < DEEP_TRADES; nth += 1) {
    const block = deepBlock + BigInt(nth)
    const base = tradeEvent(3, nth, deepAt, block)
    await applyTrade(pool, {
      ...base,
      blockNumber: block,
      eventSeq: toSeq(block, 200 + nth),
      logIndex: 200 + nth,
      txHash: hash32(0x20_000 + nth),
    })
  }

  for (let k = 0; k < DEEP_HOLDERS; k += 1) {
    const holder = addr(0xd000 + k)
    await applyTransfer(pool, {
      kind: 'transfer',
      eventSeq: toSeq(deepBlock, 400 + k),
      blockNumber: deepBlock,
      logIndex: 400 + k,
      txHash: hash32(0x30_000 + k),
      blockTime: deepAt,
      token: deep,
      from: '0x0000000000000000000000000000000000000000',
      to: holder,
      // Strictly descending until `TIED_FROM`, then FLAT. `addr()` pads
      // ascending, so the tied wallets are already in `holder ASC` order and
      // the expected page boundary is readable from this array.
      amountTok: BigInt(DEEP_HOLDERS - Math.min(k, TIED_FROM)) * 10n ** 24n,
    })
  }

  // The cursor is what `getIndexerStatus` reads to decide whether the data is
  // stale. Advancing it keeps the stale notice out of the way of every other
  // assertion — the notice has its own test elsewhere.
  //
  // THE HEAD IS PASSED EQUAL TO THE CURSOR, and that is now load-bearing rather
  // than cosmetic: freshness has TWO axes and this seed has to satisfy both.
  // Writing a head ahead of the cursor here would put a `behind-head` banner on
  // top of every explore assertion in this file.
  const seededTo = START_BLOCK + BigInt(SEEDED * 10)
  await setCursor(pool, seededTo, hash32(0xb10c), seededTo)

  return {
    tokens,
    busy: tokens[0]!,
    deep,
    absent: addr(0xdead),
    names,
  }
}
