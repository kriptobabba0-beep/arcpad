/**
 * SERVER ONLY -- BY CONVENTION TODAY, NOT BY THE `server-only` PACKAGE.
 *
 * That import is the mechanism that turns "a client component imported this"
 * into a BUILD error. It is not installed in this workspace, and installing it
 * would edit `pnpm-lock.yaml`, which every track shares.
 *
 * The guarantee is therefore weaker than it should be, and it is named here
 * rather than assumed: this module reaches `pg` through `@arcpad/db`, so a
 * client component that imports it fails at BUNDLE time on an unresolvable
 * `node:` builtin -- loudly, but with a worse message. Add `server-only` the
 * next time the lockfile is legitimately touched.
 */

import { createPool, type Pool } from '@arcpad/db'

/**
 * ONE POOL, CREATED LAZILY.
 *
 * Next's module cache keeps this singleton per process, which is what a pool
 * needs: a new `pg.Pool` per request would open a new TCP connection per
 * request and exhaust Postgres long before it exhausted the page.
 *
 * `DATABASE_URL` IS CHECKED AT THE FIRST QUERY, NOT AT MODULE LOAD. A
 * top-level throw would take down every route that merely IMPORTS this module
 * transitively -- including the trade panel, which reads its reserves from the
 * CHAIN and does not need Postgres at all. The whole point of this layer is
 * that the database going missing costs you the list and the history, not the
 * ability to trade.
 */

let pool: Pool | undefined

export class DatabaseNotConfigured extends Error {
  constructor() {
    super(
      'DATABASE_URL is not set. The read layer cannot answer, but the trade panel ' +
        'does not need it -- it reads reserves from the chain.',
    )
    this.name = 'DatabaseNotConfigured'
  }
}

export function getPool(): Pool {
  if (pool !== undefined) return pool
  const url = process.env.DATABASE_URL
  if (url === undefined || url.trim() === '') throw new DatabaseNotConfigured()
  pool = createPool(url)
  return pool
}

/**
 * TEST SEAM. Lets a test point the layer at a real address that is not
 * listening, which is how the degraded path is proved by degrading something
 * real rather than by stubbing a rejection.
 */
export function setPoolForTesting(replacement: Pool | undefined): void {
  pool = replacement
}
