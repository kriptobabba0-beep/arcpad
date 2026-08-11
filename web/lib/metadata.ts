import { ipfsGatewayOrigins } from './ipfs'
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
export const DESCRIPTION_LIMIT = 256

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

export async function resolveMetadata(uri: string): Promise<ResolvedMetadata | null> {
  /*
   * SEQUENTIAL, NOT `Promise.any`. Racing every gateway would be faster on the
   * unhappy path and would also mean four requests for every card on every
   * page — the common case is that the FIRST one answers, and paying 4x for
   * the rare case is how a launchpad gets itself rate-limited off the
   * gateways it depends on. The 2 s per-attempt timeout bounds the tail.
   */
  let raw: string | null = null
  for (const url of resolvableUrls(uri)) {
    const attempt = await readDocument(url)
    if (attempt.kind === 'answered') {
      raw = attempt.body
      break
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
