#!/usr/bin/env tsx
/**
 * `pnpm --filter @arcpad/db migrate` — apply pending migrations to `DATABASE_URL`.
 *
 * WHY THIS EXISTS. `runMigrations` was already production-grade — an advisory
 * lock so two concurrent runs cannot race, a `schema_migrations` ledger with
 * checksums, and no DDL before the comparison. What did not exist was a
 * SANCTIONED WAY TO CALL IT. The suites called it directly and
 * `scripts/integration/migrate.ts` says of itself, in its own header, that it
 * is "the harness, not a product entrypoint".
 *
 * So deploying the product meant either reaching for a file that disclaims the
 * job or writing the call by hand at 2am. This closes that: one command, and
 * it refuses rather than guesses.
 *
 * IT PRINTS THE DATABASE IT IS ABOUT TO CHANGE, WITH THE PASSWORD REDACTED,
 * AND IT PRINTS IT FIRST. The reason is specific: this repo runs TWO databases
 * on the production box — `arcpad` and `arcpad_test` — because the test suite
 * executes `DROP SCHEMA public CASCADE` and would erase production if pointed
 * at it. A migration tool that does not say which one it opened is one
 * mistyped variable away from the same accident.
 */
import { Pool } from 'pg'

import { runMigrations } from '../migrate'

/** `postgres://user:secret@host/db` -> `postgres://user:***@host/db`. */
function redact(url: string): string {
  return url.replace(/(:\/\/[^:@/]+:)[^@]*(@)/, '$1***$2')
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    // NOT a default, and not a skip. A migration run that silently picks a
    // fallback database is how the wrong one gets written to.
    throw new Error(
      'DATABASE_URL is not set. Refusing to guess — this box runs both `arcpad` ' +
        'and `arcpad_test`, and they must never be confused.',
    )
  }

  console.log(`migrating ${redact(url)}`)
  const pool = new Pool({ connectionString: url })
  try {
    const applied = await runMigrations(pool)
    if (applied.length === 0) {
      console.log('already up to date — nothing to apply')
    } else {
      console.log(`applied ${applied.length}:`)
      for (const name of applied) console.log(`  ${name}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(`migration FAILED: ${(error as Error).message}`)
  process.exitCode = 1
})
