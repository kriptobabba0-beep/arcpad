import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * ===========================================================================
 *  A CID's BYTES NEVER CHANGE, SO WE SHOULD FETCH THEM ONCE.
 * ===========================================================================
 *
 * MEASURED ON THE LIVE SERVER, against the public Pinata gateway, six
 * requests for one small PNG:
 *
 *   200 in 3.5s   200 in 5.2s   200 in 5.6s
 *   404 in 12.2s  404 in 18.2s  404 in 24.0s   <- every gateway refused
 *
 * Public gateways are shared and they throttle. Without a cache, every `<img>`
 * on a page is its own upstream request — the explore page draws 48 cards, so
 * one visitor is 48 requests, and the gateway's answer to that is the 404
 * column above. The artwork would flicker in and out for everyone, and the
 * harder the site was used the worse it would get.
 *
 * Content addressing makes this the easy case: the bytes ARE the name. There
 * is no invalidation problem, no staleness, no revalidation — a CID we have
 * read once we never need to read again.
 *
 * TWO LAYERS, AND THEY SOLVE DIFFERENT PROBLEMS:
 *
 *   - DISK, so a restart does not throw the work away and so a CID costs at
 *     most one successful gateway request in the deployment's lifetime.
 *   - SINGLE FLIGHT, so the 48 cards of a cold page make ONE upstream request
 *     instead of 48 identical ones racing each other. Without it the cache
 *     fills correctly and the stampede that fills it is exactly the load that
 *     gets us throttled.
 *
 * NOTHING HERE MAY THROW. A cache that takes the page down when the disk is
 * full is worse than no cache: every failure path below degrades to "fetch it
 * again", which is merely slow.
 */

/**
 * Where the bytes live.
 *
 * `CACHE_DIRECTORY` is set by systemd from `CacheDirectory=` in the unit —
 * which is also what creates the directory with the right owner and mode, so
 * the app never needs to be root to have somewhere to write. Unset (a dev
 * machine, a container without it) means the cache is simply off.
 */
export function cacheDir(): string | null {
  const explicit = process.env.ARCPAD_IPFS_CACHE_DIR
  if (explicit !== undefined && explicit !== '') return explicit
  const systemd = process.env.CACHE_DIRECTORY
  if (systemd === undefined || systemd === '') return null
  return join(systemd, 'ipfs')
}

/** The four types `/api/metadata` accepts, and the extension each is stored under. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([type, extension]) => [extension, type]),
)

/**
 * A flat, safe filename for an already-validated `<cid>[/path]`.
 *
 * HASHED RATHER THAN USED DIRECTLY, even though the caller has validated it:
 * the path legitimately contains `/`, and writing it verbatim would create
 * directories from a value that came in over the network. A hash cannot
 * traverse, cannot collide with a sibling entry, and is a fixed length.
 *
 * The TYPE is in the extension so that reading it back does not require
 * parsing the file, and so nothing can ever be served under a type that was
 * not one of the four we accept.
 */
function keyFor(relative: string, extension: string): string {
  const hash = createHash('sha256').update(relative).digest('hex')
  return `${hash}.${extension}`
}

export type CachedImage = { readonly bytes: Uint8Array; readonly type: string }

/** The bytes, if we already have them. Never throws; a miss and an error are the same. */
export async function readCached(relative: string): Promise<CachedImage | null> {
  const dir = cacheDir()
  if (dir === null) return null
  for (const [extension, type] of Object.entries(TYPES_BY_EXTENSION)) {
    try {
      const bytes = await readFile(join(dir, keyFor(relative, extension)))
      return { bytes: new Uint8Array(bytes), type }
    } catch {
      // Not this type, or unreadable. Either way: try the next, then miss.
    }
  }
  return null
}

/**
 * Keeps the bytes for next time. Never throws, and never leaves a partial file.
 *
 * WRITE-THEN-RENAME. A crash halfway through a plain write leaves a truncated
 * image that every later read would happily serve — a permanently broken
 * picture with a valid-looking cache entry behind it. `rename` within one
 * filesystem is atomic: the entry either does not exist or is complete.
 */
export async function writeCached(relative: string, image: CachedImage): Promise<void> {
  const dir = cacheDir()
  if (dir === null) return
  const extension = EXTENSIONS[image.type]
  if (extension === undefined) return
  try {
    await mkdir(dir, { recursive: true })
    const final = join(dir, keyFor(relative, extension))
    // The temporary name carries the process id so two workers writing the
    // same CID at the same moment cannot truncate each other's file.
    const temporary = `${final}.${process.pid}.tmp`
    await writeFile(temporary, image.bytes)
    await rename(temporary, final)
  } catch {
    // A full or read-only disk must cost us speed, never correctness.
  }
}

/**
 * SINGLE FLIGHT. Concurrent callers asking for the same thing get one attempt.
 *
 * The entry is removed as soon as the work settles: this is a de-duplicator
 * for requests in flight, NOT a second cache. Keeping resolved promises here
 * would hold every image ever served in memory, and would also cache failures
 * for the lifetime of the process.
 */
const inFlight = new Map<string, Promise<CachedImage | null>>()

export function once(
  key: string,
  work: () => Promise<CachedImage | null>,
): Promise<CachedImage | null> {
  const existing = inFlight.get(key)
  if (existing !== undefined) return existing
  const started = work().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, started)
  return started
}

/** Test seam: the map must not leak between cases. */
export function inFlightSize(): number {
  return inFlight.size
}
