import { ipfsGatewayOrigins } from './ipfs'
import { readCached, writeCached } from './ipfsCache'
import { sanitiseForDisplay } from '@arcpad/shared/browser'

/**
 * METADATA RESOLUTION -- AND `uri` IS ATTACKER CONTROLLED.
 *
 * The description, the image and the social links are not on chain; they live
 * in the JSON that `launches.uri` points at, and `uri` is a free string the
 * launcher typed. Fetching it happens on the SERVER, which makes this an SSRF
 * surface: an unconstrained server-side fetch is permission to send requests
 * into internal networks from inside the deployment.
 *
 * Every constraint below is load-bearing:
 *   1. ONLY `ipfs://<cid>[/path]` and the configured gateway's own origin.
 *      Everything else -- `http://`, `file://`, `data:`, a bare IP, any other
 *      host -- resolves to null with NO FETCH AT ALL.
 *   2. 2000 ms timeout, and a 64 kB body ceiling applied WHILE STREAMING.
 *      `Content-Length` is not trusted: it is a claim by the same party that
 *      controls the body.
 *   3. The JSON is validated and unknown fields are DROPPED. `image` is
 *      returned only if it passes the same allow-list as the document.
 *   4. Text goes through `sanitiseForDisplay` and is clipped.
 *   5. Next's fetch cache, 300 s. Explore draws 24 cards; uncached that is 24
 *      gateway requests per render.
 *   6. EVERY failure is a NORMAL result, `null`. Unresolvable metadata is the
 *      common case, not an error -- `uri` is frequently empty.
 */

export type ResolvedMetadata = {
  readonly description?: string
  readonly image?: string
  readonly x?: string
  readonly telegram?: string
}

export const METADATA_TIMEOUT_MS = 2_000
export const METADATA_BODY_LIMIT = 64 * 1024
export const METADATA_REVALIDATE_SECONDS = 300
export { DESCRIPTION_LIMIT } from './metadataLimits'
import { DESCRIPTION_LIMIT } from './metadataLimits'

/** `ipfs://<cid>[/path]`, with a CID that looks like a CID and nothing else. */
const IPFS_URI = /^ipfs:\/\/([A-Za-z0-9]{46,}|Qm[1-9A-HJ-NP-Za-km-z]{44})(\/[\w\-./%]*)?$/

/**
 * Every URL worth trying for an acceptable `uri`, best first. Empty = no fetch.
 *
 * AN EMPTY LIST MEANS NO REQUEST IS MADE. That is the whole SSRF defence: the
 * decision happens before `fetch` is reachable, not inside an error handler
 * after the socket is already open. The HOSTS come from `ipfsGatewayOrigins()`
 * and never from `uri`, so no input can steer this at an internal address.
 *
 * ONE URL WAS NOT ENOUGH, MEASURED IN PRODUCTION. `ipfs.io` — the origin this
 * resolved to on the live deployment — answered nothing at all for twelve
 * seconds, so `resolveMetadata` returned `null` for every token on the site
 * and every card lost its description and its artwork at once. One gateway
 * being down is not an outage we should have; the same CID is on the others.
 */
export function resolvableUrls(uri: string): readonly string[] {
  const trimmed = uri.trim()
  if (trimmed === '') return []

  const ipfs = IPFS_URI.exec(trimmed)
  if (ipfs?.[1] !== undefined) {
    const path = `${ipfs[1]}${ipfs[2] ?? ''}`
    return ipfsGatewayOrigins().map((origin) => `${origin}/ipfs/${path}`)
  }

  // The only other acceptable shape: an https URL on a CONFIGURED gateway's
  // own origin. Its path is then retried across the others -- the document is
  // content addressed, so the host in the string is a hint, not an identity.
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return []
  }
  if (parsed.protocol !== 'https:') return []
  const origins = ipfsGatewayOrigins()
  if (!origins.includes(parsed.origin)) return []
  if (!parsed.pathname.startsWith('/ipfs/')) return [parsed.toString()]
  return [
    parsed.toString(),
    ...origins
      .filter((origin) => origin !== parsed.origin)
      .map((origin) => `${origin}${parsed.pathname}${parsed.search}`),
  ]
}

/**
 * The FIRST URL worth trying, or `null`.
 *
 * Kept because `image` needs a single canonical value to hand to the browser,
 * not a list — `TokenArtwork` turns whichever gateway URL it receives into a
 * same-origin `/api/ipfs/…` request anyway, and that route does its own
 * failover across the same gateways.
 */
export function resolvableUrl(uri: string): string | null {
  return resolvableUrls(uri)[0] ?? null
}

/** Reads at most `limit` bytes, then stops. The header is never trusted. */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  const body = response.body
  if (body === null) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      // OVER THE CEILING IS A FAILURE, not a truncation: half a JSON document
      // is not a smaller JSON document, and parsing it would be luck.
      if (total > limit) return null
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(joined)
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = sanitiseForDisplay(value).slice(0, limit)
  return clean === '' ? undefined : clean
}

/** A social link is kept only if it is an https URL. It is never fetched. */
function link(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * One gateway attempt, and the distinction the retry loop turns on.
 *
 * `unreachable` — nobody answered: a timeout, a refused connection, a 502.
 *   Another gateway may well hold the document, so it is worth asking.
 *
 * `answered` — a gateway replied and we have its verdict. `body: null` means
 *   it replied with something unusable (over the ceiling, an unreadable
 *   stream). ASKING AGAIN IS POINTLESS: IPFS is content addressed, so every
 *   gateway serves the same bytes for the same CID and the second answer
 *   cannot differ from the first. Retrying it would multiply our requests to
 *   the gateways we depend on for a result already known.
 */
type Attempt = { readonly kind: 'unreachable' } | { readonly kind: 'answered'; readonly body: string | null }

const UNREACHABLE: Attempt = { kind: 'unreachable' }

async function readDocument(url: string): Promise<Attempt> {
  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      // `next` is Next.js own extension to RequestInit. Without it Explore
      // would issue one gateway request per card per render.
      next: { revalidate: METADATA_REVALIDATE_SECONDS },
    })
  } catch {
    return UNREACHABLE
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return UNREACHABLE
  }
  try {
    return { kind: 'answered', body: await readCapped(response, METADATA_BODY_LIMIT) }
  } catch {
    /*
     * READING THE BODY MUST NOT THROW PAST THIS POINT. `getReader()` throws
     * on a stream that is already locked or consumed, and this function is
     * now called in a loop — one exception here would escape `resolveMetadata`
     * and take down the render of a page whose only problem is a token with
     * bad metadata. Same shape as the unhandled pool error that killed the
     * indexer: a failure arriving outside the call it belongs to.
     */
    return { kind: 'answered', body: null }
  }
}

/**
 * The disk key for a metadata document, or `null` if it is not content addressed.
 *
 * ONLY `ipfs://<cid>[/path]` IS CACHED FOREVER, and the distinction matters:
 * a CID names its own bytes, so the answer can never change. The other
 * acceptable shape -- an https URL on a gateway -- is a LOCATION, and a
 * location's contents can. Caching that one permanently would be a promise we
 * have no right to make.
 */
function immutableKey(uri: string): string | null {
  const match = IPFS_URI.exec(uri.trim())
  return match?.[1] === undefined ? null : `${match[1]}${match[2] ?? ''}`
}

export async function resolveMetadata(uri: string): Promise<ResolvedMetadata | null> {
  /*
   * SEQUENTIAL, NOT `Promise.any`. Racing every gateway would be faster on the
   * unhappy path and would also mean four requests for every card on every
   * page — the common case is that the FIRST one answers, and paying 4x for
   * the rare case is how a launchpad gets itself rate-limited off the
   * gateways it depends on. The 2 s per-attempt timeout bounds the tail.
   */
  /*
   * ============ OUR OWN DISK FIRST, AND FOREVER ============
   *
   * Next's fetch cache held this for `METADATA_REVALIDATE_SECONDS` and that
   * number is simply WRONG for content-addressed data: it expires something
   * that cannot go stale. MEASURED CONSEQUENCE on the live box -- the artwork
   * on the home page appeared, vanished five minutes later for exactly one
   * render, and came back. Intermittent, which reads as broken more than
   * absent does.
   *
   * A CID's document is fetched ONCE in the lifetime of the deployment, and
   * the entry survives restarts. Everything else in this function -- the
   * allow-list, the timeouts, the byte ceiling, the validation -- is unchanged
   * and still runs on the way in; the cache holds the RAW text, so a document
   * is never trusted just because it is local.
   */
  const key = immutableKey(uri)
  let raw: string | null = null

  if (key !== null) {
    const hit = await readCached(key)
    if (hit !== null) raw = new TextDecoder('utf-8').decode(hit.bytes)
  }

  if (raw === null) {
    for (const url of resolvableUrls(uri)) {
      const attempt = await readDocument(url)
      if (attempt.kind === 'answered') {
        raw = attempt.body
        break
      }
    }
    // Only a document we actually fetched is worth storing, and only when it
    // is addressed by content.
    if (raw !== null && key !== null) {
      await writeCached(key, {
        bytes: new TextEncoder().encode(raw),
        type: 'application/json',
      })
    }
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>

  const description = text(doc.description, DESCRIPTION_LIMIT)
  // `image` goes through THE SAME allow-list as the document. An image on an
  // arbitrary host is a request the browser makes on the user's behalf, and it
  // is also a tracking pixel.
  const imageCandidate = typeof doc.image === 'string' ? resolvableUrl(doc.image) : null
  const x = link(doc.twitter ?? doc.x)
  const telegram = link(doc.telegram)

  const resolved: ResolvedMetadata = {
    ...(description === undefined ? {} : { description }),
    ...(imageCandidate === null ? {} : { image: imageCandidate }),
    ...(x === undefined ? {} : { x }),
    ...(telegram === undefined ? {} : { telegram }),
  }
  // Unknown fields are dropped by construction: nothing above copies them.
  return Object.keys(resolved).length === 0 ? null : resolved
}

/**
 * ===========================================================================
 *  THE GRID NEVER SHOWED ARTWORK, AND NOTHING SAID SO.
 * ===========================================================================
 *
 * `TokenCard` takes an `imageUrl` prop and `TokenGrid` rendered
 * `<TokenCard overview={overview} />` -- without it. `TopTokensStrip` takes an
 * `images` map and the page rendered `<TopTokensStrip tokens now />` --
 * without it. So EVERY card on the home page drew its fallback gradient
 * forever, no matter what a creator uploaded, and no test failed: the props
 * are optional and `undefined` is a legal value meaning "no artwork".
 *
 * It stayed invisible because for a long time it was also TRUE: every launch
 * on this deployment carried an empty `uri`, so there was nothing to draw. The
 * first launch with a real pinned document (`LOCKED`, 2026-08-11) is what made
 * the gap observable -- its picture appears on the token PAGE, which resolves
 * metadata, and was missing from the grid, which did not.
 *
 * THE BUDGET IS THE INTERESTING PART. A grid is up to 48 cards and a gateway
 * fetch was measured at 5.2 s; 48 of those in series would be a dead page, and
 * even in parallel one slow gateway would hold the whole render. So:
 *
 *   - tokens with an empty `uri` cost NOTHING. `resolvableUrls('')` is empty,
 *     so no request is made -- which is most of them today.
 *   - the rest resolve CONCURRENTLY, each already bounded by
 *     `METADATA_TIMEOUT_MS` per gateway attempt.
 *   - and the whole batch races a wall-clock budget. Past it the page renders
 *     with whatever arrived and gradients for the rest.
 *
 * A MISSED IMAGE IS NOT A LOST IMAGE. Next caches the fetch for
 * `METADATA_REVALIDATE_SECONDS`, and the explore page re-renders every ten
 * seconds via `LiveRefresh` -- so the first visitor after a cold cache may see
 * a gradient, and the next render has the picture. That is the correct
 * trade for a launchpad: never make someone wait on a stranger's gateway to
 * see prices.
 */
export const ARTWORK_BATCH_BUDGET_MS = 2_500

export async function resolveArtworkMap(
  tokens: ReadonlyArray<{ readonly token: string; readonly uri?: string | null }>,
  budgetMs: number = ARTWORK_BATCH_BUDGET_MS,
): Promise<Readonly<Record<string, string | null>>> {
  const out: Record<string, string | null> = {}

  const pending = tokens.filter((t) => typeof t.uri === 'string' && t.uri.trim() !== '')
  if (pending.length === 0) return out

  /*
   * DE-DUPLICATED BY URI, not by token. Two launches can legitimately point at
   * the same document, and resolving it twice would double the cost of the
   * exact case where cost matters.
   */
  const byUri = new Map<string, string[]>()
  for (const t of pending) {
    const uri = (t.uri as string).trim()
    const bucket = byUri.get(uri)
    if (bucket === undefined) byUri.set(uri, [t.token])
    else bucket.push(t.token)
  }

  const work = Promise.all(
    [...byUri.entries()].map(async ([uri, addresses]) => {
      const meta = await resolveMetadata(uri)
      const image = meta?.image ?? null
      for (const address of addresses) out[address] = image
    }),
  )

  // `Promise.race` against a timer: whatever has resolved by then is already
  // written into `out`, because each task writes as it finishes rather than at
  // the end. A late arrival simply misses this render.
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, budgetMs))])
  return out
}
