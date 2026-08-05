import { createPool, type FreshIndexer, type Pool, type StaleIndexer } from '@arcpad/db'
import { createServer, type Server } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setPoolForTesting } from '../lib/db'
import {
  fold,
  guard,
  type ReadResult,
  readHolders,
  readTokenList,
  readTokenOverview,
  valueOf,
} from '../lib/read'

/**
 * THE DEGRADED PATH IS PROVED BY DEGRADING SOMETHING REAL.
 *
 * No mocked rejection, no stubbed driver: a real `pg.Pool` is pointed at a real
 * TCP port that nothing is listening on, and the real `pg` client produces a
 * real ECONNREFUSED. That is the failure a dead database actually produces, and
 * it is the one the layer has to survive.
 *
 * A stubbed `Promise.reject(new Error('boom'))` would pass this file just as
 * happily while proving nothing about `pg`, about connection timeouts, or about
 * whether the pool swallows the error somewhere before `guard` can see it.
 */

/** A port that is definitely closed: bind one, read its number, close it. */
async function closedPort(): Promise<number> {
  const server: Server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

let deadPool: Pool

beforeAll(async () => {
  const port = await closedPort()
  deadPool = createPool(`postgres://arcpad:arcpad@127.0.0.1:${port}/arcpad`)
  // The pool emits on background connection failures; without a listener node
  // turns that into an unhandled error and kills the run for the wrong reason.
  deadPool.on('error', () => undefined)
  setPoolForTesting(deadPool)
})

afterAll(async () => {
  setPoolForTesting(undefined)
  await deadPool?.end().catch(() => undefined)
})

describe('a database that is really down', () => {
  it('CONTROL: the port really is refusing connections', async () => {
    // Anti-vacuity. If this ever started succeeding, every assertion below
    // would be measuring a different failure than the one it claims.
    await expect(deadPool.query('SELECT 1')).rejects.toThrow(/ECONNREFUSED|connect/i)
  })

  it('readTokenList degrades to unavailable instead of throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await readTokenList({ sort: 'newest', ageDays: null, cursor: null, limit: 24 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('unavailable')
    // The indexer status is NULL, not a fabricated fresh one: we could not
    // reach the database to ask, and guessing "fresh" is the failure this
    // whole layer exists to prevent.
    expect(result.indexer).toBeNull()
    // ...and it LOGS, because a silent outage is one nobody pages for.
    expect(errors).toHaveBeenCalledOnce()
    errors.mockRestore()
  })

  it('readTokenOverview degrades the same way', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await readTokenOverview('0x00000000000000000000000000000000000000aa')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('unavailable')
    errors.mockRestore()
  })

  it('the failure is a VALUE, so a page can still render around it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await readTokenList({ sort: 'newest', ageDays: null, cursor: null, limit: 24 })
    // The whole point: no throw escaped, so Next never draws the error
    // boundary and the trade panel -- which reads reserves from the CHAIN --
    // keeps working.
    const rendered = fold(result, {
      fresh: () => 'list',
      stale: () => 'list with a warning',
      missing: (reason) => `box: ${reason}`,
    })
    expect(rendered).toBe('box: unavailable')
    errors.mockRestore()
  })
})

/**
 * THE STALE PATH.
 *
 * `indexer.stale` is computed by `packages/db` from `now() - updated_at` on the
 * SERVER's clock and is covered by that package's own suite against a real
 * Postgres in CI. What is proved HERE is the half this layer owns: that a
 * stale-but-present reading is CARRIED as stale and cannot be read as if it
 * were fresh.
 */
describe('a reading that is present but lagging', () => {
  const at = {
    lastBlock: 1_000n,
    lastBlockHash: '0xabc',
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    stalenessSeconds: 240,
    head: {
      measured: true as const,
      headBlock: 1_000n,
      blocksBehind: 0n,
      observedSecondsAgo: 240,
    },
  }
  const laggingStatus: StaleIndexer = { stale: true, why: 'writes-stalled', at }
  const freshStatus: FreshIndexer = {
    stale: false,
    at: { ...at, stalenessSeconds: 2 },
  }

  it('a stale reading has NO `data` field at all', async () => {
    const result = await guard(async () => ({ value: [1, 2, 3], indexer: laggingStatus }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.stale).toBe(true)
    // The runtime half of the compile gate: the field a careless consumer
    // reaches for is genuinely absent, so `r.data` is `undefined` rather than
    // a plausible array.
    expect((result as unknown as { data?: unknown }).data).toBeUndefined()
    if (!result.stale) throw new Error('unreachable')
    expect(result.staleData).toEqual([1, 2, 3])
    expect(result.indexer.at?.stalenessSeconds).toBe(240)
  })

  it('a fresh reading has `data` and no `staleData`', async () => {
    const result = await guard(async () => ({ value: [1], indexer: freshStatus }))
    if (!result.ok || result.stale) throw new Error('unreachable')
    expect(result.data).toEqual([1])
    expect((result as unknown as { staleData?: unknown }).staleData).toBeUndefined()
  })

  it('fold REQUIRES a stale branch, and it is the one that runs', async () => {
    const result = await guard(async () => ({ value: 'rows', indexer: laggingStatus }))
    const seen: string[] = []
    const out = fold(result, {
      fresh: () => {
        seen.push('fresh')
        return 'live'
      },
      stale: (_data, indexer) => {
        seen.push('stale')
        return `lagging ${indexer.at?.stalenessSeconds}s`
      },
      missing: () => {
        seen.push('missing')
        return 'gone'
      },
    })
    expect(out).toBe('lagging 240s')
    expect(seen).toEqual(['stale'])
  })

  it('valueOf returns the value on BOTH ok branches, and undefined otherwise', async () => {
    const stale = await guard(async () => ({ value: 7, indexer: laggingStatus }))
    const fresh = await guard(async () => ({ value: 7, indexer: freshStatus }))
    expect(valueOf(stale)).toBe(7)
    expect(valueOf(fresh)).toBe(7)
    const missing: ReadResult<number> = { ok: false, reason: 'notFound', indexer: null }
    expect(valueOf(missing)).toBeUndefined()
  })

  it('a missing row is notFound, NOT unavailable', async () => {
    // Two different screens. Collapsing them would tell somebody to "try again
    // later" about an address that will never exist.
    const result = await guard(
      async () => ({ value: null, indexer: freshStatus }),
      (value) => value === null,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('notFound')
    // ...and notFound still carries the indexer status, because "no row" from
    // a lagging indexer is a different statement than "no row" from a fresh one.
    expect(result.indexer).not.toBeNull()
  })
})

/**
 * =========================================================================
 *  THE HOLDERS CURSOR: THE PARAMETER HAS TO REACH THE QUERY.
 * =========================================================================
 *
 * `readHolders` used to hard-code `nextCursor: null` with a comment saying
 * `listHolders` "takes only `{ limit }`". It has taken `{ after, limit }` since
 * `c035a88`. A comment cannot notice that its dependency landed, so the holders
 * tab was capped at one page and NOTHING ON SCREEN SAID SO -- a null cursor
 * draws no button, and an absent button is indistinguishable from a short list.
 *
 * WHAT IS FAKED HERE IS `pg`, AND NOTHING ELSE. `listHolders`,
 * `parseHolderCursor` and `encodeHolderCursor` are the real functions from
 * `@arcpad/db`; only the driver is replaced, so what is measured is that this
 * layer's cursor ARRIVES IN THE STATEMENT'S PARAMETERS and comes back out
 * encoded. The SQL's own semantics -- that `balance_tok < $2 OR (= $2 AND
 * holder > $3)` is the right keyset for `DESC, ASC` -- are proved against a
 * real Postgres in `packages/db`'s suite, and re-asserting them against a fake
 * would be a double doing the real code's job.
 */
describe('readHolders -- the keyset that was hard-coded to null', () => {
  const STATUS_ROW = {
    last_block: '1000',
    last_block_hash: '0xabc',
    // THE HEAD IS PART OF THE ROW NOW. Leaving it out is not a fresh status --
    // it is `head-unknown`, which is stale, and the notice would land on top of
    // a test that is about cursors. That is the contract working: freshness
    // cannot be claimed without a head.
    head_block: '1000',
    updated_at: new Date('2026-08-05T00:00:00Z'),
    staleness_seconds: '2',
  }

  type Call = { text: string; params: unknown[] }

  /** Replaces the DRIVER. Dispatches on the statement, records every call. */
  function fakePool(holderRows: { holder: string; balance_tok: string }[]) {
    const calls: Call[] = []
    const pool = {
      query: async (text: string, params: unknown[] = []) => {
        calls.push({ text, params })
        if (text.includes('sync_state')) return { rows: [STATUS_ROW] }
        if (text.includes('FROM holders')) return { rows: holderRows }
        throw new Error(`unexpected statement: ${text}`)
      },
      on: () => undefined,
      end: async () => undefined,
    }
    return { pool: pool as unknown as Pool, calls }
  }

  function rows(n: number, balance: bigint) {
    return Array.from({ length: n }, (_, i) => ({
      holder: `0x${(0xa0 + i).toString(16).padStart(40, '0')}`,
      balance_tok: balance.toString(),
    }))
  }

  afterEach(() => setPoolForTesting(deadPool))

  it('a FULL page returns a two-part cursor built from the last row', async () => {
    const { pool } = fakePool(rows(3, 500n))
    setPoolForTesting(pool)

    const result = await readHolders('0x00000000000000000000000000000000000000aa', {
      cursor: null,
      limit: 3,
    })
    const page = valueOf(result)
    expect(page?.rows).toHaveLength(3)
    // `<balance>:<holder>` -- the balance ALONE cannot be a keyset, because
    // balances tie, most densely in the tail of the list.
    expect(page?.nextCursor).toBe('500:0x00000000000000000000000000000000000000a2')
  })

  it('a SHORT page is the last page: no cursor, so no button', async () => {
    const { pool } = fakePool(rows(2, 500n))
    setPoolForTesting(pool)

    const result = await readHolders('0x00000000000000000000000000000000000000aa', {
      cursor: null,
      limit: 3,
    })
    expect(valueOf(result)?.nextCursor).toBeNull()
  })

  it('the cursor REACHES the statement as its parameters, both halves', async () => {
    const { pool, calls } = fakePool(rows(1, 400n))
    setPoolForTesting(pool)

    await readHolders('0x00000000000000000000000000000000000000aa', {
      cursor: '500:0x00000000000000000000000000000000000000a2',
      limit: 3,
    })

    const holders = calls.find((c) => c.text.includes('FROM holders'))
    // $1 token, $2 balance, $3 holder, $4 limit. THIS is the assertion the
    // hard-coded `nextCursor: null` would have passed happily: without it, a
    // page-two request silently re-served page one.
    expect(holders?.params).toEqual([
      '0x00000000000000000000000000000000000000aa',
      '500',
      '0x00000000000000000000000000000000000000a2',
      3,
    ])
  })

  it('a MALFORMED cursor is the first page, not a 500', async () => {
    const { pool, calls } = fakePool(rows(1, 400n))
    setPoolForTesting(pool)

    // This value arrives from a URL or a client-supplied server-action
    // argument. Both halves must be null, or the statement gets a broken
    // numeric and Postgres -- not the user -- decides what happens next.
    await readHolders('0x00000000000000000000000000000000000000aa', {
      cursor: 'not-a-cursor',
      limit: 3,
    })
    const holders = calls.find((c) => c.text.includes('FROM holders'))
    expect(holders?.params[1]).toBeNull()
    expect(holders?.params[2]).toBeNull()
  })
})
