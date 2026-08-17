#!/usr/bin/env tsx
/**
 * `pnpm --filter @arcpad/db backup` — dump the one table no chain can rebuild.
 *
 * WHAT THIS IS FOR is argued in `../backup.ts`: everything else in this
 * database is derived from logs the chain still holds, so losing it costs
 * hours of re-indexing rather than data. `chat_messages` exists nowhere else.
 *
 * THREE PROPERTIES, EACH BECAUSE THE ALTERNATIVE FAILS QUIETLY.
 *
 * 1. IT WRITES TO `.part` AND RENAMES. A backup job killed mid-dump — OOM, a
 *    reboot, a `systemctl stop` during the nightly window — otherwise leaves a
 *    truncated file with a perfectly normal name. Nothing distinguishes it
 *    from a good one until the day it is restored. `rename(2)` within a
 *    directory is atomic, so a name that exists is a dump that finished.
 *
 * 2. IT READS THE DUMP BACK BEFORE ACCEPTING IT. `pg_dump` exiting 0 means it
 *    ran; it does not mean the bytes reached the disk intact through gzip and
 *    a write stream. The check decompresses and looks for the table's own DDL
 *    and its COPY block, so an empty file, a truncated file, or a dump of the
 *    WRONG table all fail here rather than at a restore.
 *
 * 3. RETENTION RUNS AFTER, AND NEVER EMPTIES THE DIRECTORY. See
 *    `expiredBackups` — the newest file is kept however old it is, so a
 *    stalled job degrades to a stale backup instead of to none.
 *
 * ENV
 *   DATABASE_URL              required. No default; this box runs two databases.
 *   ARCPAD_BACKUP_DIR         default /var/lib/arcpad/backups
 *   ARCPAD_BACKUP_KEEP_DAYS   default 30
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { createReadStream } from 'node:fs'

import { BACKUP_TABLES, backupFileName, expiredBackups } from '../backup'

const DEFAULT_DIR = '/var/lib/arcpad/backups'
const DEFAULT_KEEP_DAYS = 30

/** `postgres://user:secret@host/db` -> `postgres://user:***@host/db`. */
function redact(url: string): string {
  return url.replace(/(:\/\/[^:@/]+:)[^@]*(@)/, '$1***$2')
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. Refusing to guess — this box runs both \`arcpad\` and ` +
        '`arcpad_test`, and a backup of the wrong one is worse than none because it ' +
        'looks like a backup.',
    )
  }
  return value.trim()
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

/** Run `pg_dump` for the policy's tables, gzip it, and land it at `target`. */
async function dumpTo(url: string, target: string): Promise<void> {
  const args = [
    '--no-owner',
    '--no-privileges',
    // The dump restores into a database whose schema the migrator already
    // built, so it must carry data and DDL for its own table only -- never a
    // DROP, and never anything about the tables the indexer owns.
    ...BACKUP_TABLES.flatMap((t) => ['--table', `public.${t}`]),
    url,
  ]
  const child = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', (error: Error) => {
      reject(
        new Error(
          `pg_dump could not be started (${error.message}). Is postgresql-client installed?`,
        ),
      )
    })
    child.on('close', (code: number | null) => {
      if (code === 0) resolve()
      // The URL can appear in pg_dump's own errors, so redact before printing.
      else reject(new Error(`pg_dump exited ${String(code)}: ${redact(stderr).trim()}`))
    })
  })

  await Promise.all([
    pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(target)),
    exited,
  ])
}

/**
 * Decompress `path` and assert it is a dump of what we asked for.
 *
 * IT SCANS AS A STREAM AND NEVER HOLDS THE DUMP IN MEMORY. `chat_messages` is
 * small today and will not stay small; a verifier that concatenates the whole
 * decompressed dump into one string is a backup job that starts failing with
 * OOM precisely when the table becomes worth backing up — and on this box
 * that OOM would land in the same 3.8 GB the database and the indexer share.
 *
 * The needles can straddle a chunk boundary, so each round keeps the last
 * `overlap` characters and prepends them to the next. `overlap` is one byte
 * short of the longest needle, which is the smallest window that cannot miss
 * a split match.
 *
 * It looks for the DDL and the COPY block rather than checking the file size:
 * an empty `chat_messages` is a legitimate backup on a young deployment, and
 * any size threshold would either reject that or be too small to catch a
 * truncation.
 */
async function verify(path: string): Promise<number> {
  const needles = [
    ...BACKUP_TABLES.flatMap((t) => [
      {
        text: `CREATE TABLE public.${t}`,
        missing: `the dump does not define public.${t} — it is not the backup we asked for`,
      },
      {
        text: `COPY public.${t}`,
        missing: `the dump defines public.${t} but carries no COPY block`,
      },
    ]),
    // pg_dump terminates every COPY with a lone `\.`; its absence means the
    // stream was cut mid-table, which is the failure this function exists to
    // catch.
    { text: '\n\\.\n', missing: 'the dump has no COPY terminator — it was truncated' },
  ]
  const found = new Set<string>()
  const overlap = Math.max(...needles.map((n) => n.text.length)) - 1

  let carry = ''
  let bytes = 0
  await pipeline(createReadStream(path), createGunzip(), async (source) => {
    source.setEncoding('utf8')
    for await (const chunk of source) {
      const text = chunk as string
      bytes += text.length
      const window = carry + text
      for (const needle of needles) {
        if (!found.has(needle.text) && window.includes(needle.text)) found.add(needle.text)
      }
      carry = window.slice(-overlap)
    }
  })

  for (const needle of needles) {
    if (!found.has(needle.text)) throw new Error(needle.missing)
  }
  return bytes
}

async function main(): Promise<void> {
  const url = requireEnv('DATABASE_URL')
  const dir = process.env['ARCPAD_BACKUP_DIR']?.trim() || DEFAULT_DIR
  const keepDays = positiveInt('ARCPAD_BACKUP_KEEP_DAYS', DEFAULT_KEEP_DAYS)
  const now = new Date()

  console.log(`backing up ${BACKUP_TABLES.join(', ')} from ${redact(url)}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })

  const name = backupFileName(now)
  const target = join(dir, name)
  const part = `${target}.part`

  try {
    await dumpTo(url, part)
    const bytes = await verify(part)
    await rename(part, target)
    const { size } = await stat(target)
    console.log(`wrote ${name} (${size} bytes gzipped, ${bytes} uncompressed)`)
  } catch (error) {
    // A failed attempt must not be left behind looking like a candidate for
    // the next run's retention pass.
    await unlink(part).catch(() => undefined)
    throw error
  }

  // Listed AFTER the rename, so the dump just taken is already in here and is
  // the newest — which is what makes it the one `expiredBackups` protects.
  const present = await readdir(dir)
  const expired = expiredBackups(present, now, keepDays)
  for (const old of expired) await unlink(join(dir, old))
  const kept = present.filter((f) => f.endsWith('.sql.gz') && !expired.includes(f)).length
  console.log(
    expired.length === 0
      ? `retention: nothing past ${keepDays} days`
      : `retention: removed ${expired.length} past ${keepDays} days`,
  )
  console.log(`${kept} backup(s) in ${dir}`)
}

main().catch((error: unknown) => {
  console.error(`backup FAILED: ${(error as Error).message}`)
  process.exitCode = 1
})
