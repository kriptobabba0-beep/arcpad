/**
 * Integration harness: apply every migration to the database named by
 * `DATABASE_URL`.
 *
 * Lives in `scripts/integration/` because no package owns a migrate CLI --
 * `packages/db` exports `runMigrations` and the suites call it directly. This
 * file is the harness, not a product entrypoint.
 */
// RELATIVE IMPORT, deliberately. The root workspace package does not declare
// `@arcpad/db`, and adding it would touch the shared `pnpm-lock.yaml` that
// three other tracks are reading. tsx resolves `pg` from
// `packages/db/node_modules`, so the relative path costs nothing.
import { createPool, runMigrations } from '../../packages/db/src/index'

const url = process.env.DATABASE_URL
if (url === undefined || url === '') throw new Error('DATABASE_URL ayarli degil')

const pool = createPool(url)
try {
  const applied = await runMigrations(pool)
  console.log(`[migrate] applied ${applied.length}: ${applied.join(', ')}`)
} finally {
  await pool.end()
}
