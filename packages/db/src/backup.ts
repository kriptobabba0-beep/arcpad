/**
 * Backup policy — the decisions, separated from the process that carries them out.
 *
 * WHY ONLY ONE TABLE. Everything in this database except `chat_messages` is
 * derived from the chain: reset the cursor and the indexer rebuilds `launches`,
 * `trades`, `holders`, `curve_state` and the rest, byte for byte, because each
 * row is a log the chain still holds. A rebuild costs hours (measured: ~3 on
 * one endpoint), which is an availability problem rather than a data-loss one.
 *
 * `chat_messages` is the exception and the only one. It exists nowhere but
 * here. The signature in each row proves the author wrote it, but no signature
 * can prove a message that was deleted ever existed — so a lost row is lost,
 * and it is the only kind of loss on this box that no amount of re-indexing
 * repairs.
 *
 * Dumping the whole database instead would not be *wrong*, but it grows
 * without bound with data that is already durable somewhere far better than a
 * VPS disk, and a backup nobody can afford to keep is one nobody keeps.
 */

/** The tables a backup must contain, each for a reason that is written down. */
export const BACKUP_TABLES = Object.freeze(['chat_messages'] as const)

/** `arcpad-chat-20260810T174430Z.sql.gz` */
const NAME_PATTERN = /^arcpad-chat-(\d{8})T(\d{6})Z\.sql\.gz$/

/**
 * The name a backup taken at `at` gets.
 *
 * UTC, always, and sortable as text. A local-time name reorders itself twice a
 * year, and the hour that repeats in autumn would have two backups claiming the
 * same instant — with the second silently overwriting the first.
 */
export function backupFileName(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `arcpad-chat-${p(at.getUTCFullYear(), 4)}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `T${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}Z.sql.gz`
  )
}

/**
 * The instant a backup file name encodes, or `null` if it is not one of ours.
 *
 * THE CHECK IS A ROUND TRIP, NOT A RANGE TEST, AND THAT IS NOT STYLE.
 * `new Date('2026-08-10T99:44:30Z')` is Invalid Date as expected — but
 * `new Date('2026-02-31T00:00:00Z')` is **not**. JavaScript rolls the
 * impossible day forward and hands back 3 March, a date the file name never
 * claimed. A `Number.isNaN` guard therefore accepts `20260231` and quietly
 * relabels it, which is how a name that means nothing acquires a plausible
 * age and starts taking part in retention decisions.
 *
 * Re-rendering the parsed instant and demanding it equal the input rejects
 * every rolled-over value at once, without a table of month lengths and
 * without a leap-year rule to get wrong.
 */
export function backupTakenAt(fileName: string): Date | null {
  const m = NAME_PATTERN.exec(fileName)
  if (m === null) return null
  const [, d, t] = m as unknown as [string, string, string]
  const iso =
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` +
    `T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return backupFileName(at) === fileName ? at : null
}

/**
 * Which files retention may delete.
 *
 * TWO RULES, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 * 1. Older than `keepDays` — the ordinary case.
 *
 * 2. **The newest backup is never deleted, however old it is.** Retention
 *    written as "delete everything past the window" is correct only while
 *    backups keep arriving. Stop the timer, or leave the box off, or let the
 *    dump fail quietly for a fortnight, and the same rule walks through the
 *    whole directory and leaves ZERO — turning a stalled backup job into
 *    actual data loss, at the exact moment the backups became the only copy.
 *    The rule here is "keep the window, and always keep the last one", so a
 *    stalled job degrades into a stale backup rather than none.
 *
 * Files that are not ours are never returned. A directory shared with
 * something else is not this function's business to tidy.
 */
export function expiredBackups(
  fileNames: readonly string[],
  now: Date,
  keepDays: number,
): readonly string[] {
  if (keepDays < 0) throw new RangeError(`keepDays must not be negative, got ${keepDays}`)

  const ours = fileNames
    .map((name) => ({ name, at: backupTakenAt(name) }))
    .filter((f): f is { name: string; at: Date } => f.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime())

  const newest = ours[0]
  if (newest === undefined) return []

  const cutoff = now.getTime() - keepDays * 86_400_000
  return ours.filter((f) => f.name !== newest.name && f.at.getTime() < cutoff).map((f) => f.name)
}
