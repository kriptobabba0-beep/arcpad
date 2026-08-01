import { createPool, type Pool } from '@arcpad/db'
import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setPoolForTesting } from '../lib/db'
import {
  fold,
  guard,
  type ReadResult,
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
  const laggingStatus = {
    lastBlock: 1_000n,
    lastBlockHash: '0xabc',
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    stalenessSeconds: 240,
    stale: true,
  }
  const freshStatus = { ...laggingStatus, stalenessSeconds: 2, stale: false }

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
    expect(result.indexer.stalenessSeconds).toBe(240)
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
        return `lagging ${indexer.stalenessSeconds}s`
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
