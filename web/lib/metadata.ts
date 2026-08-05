import { ipfsGatewayOrigin } from './ipfs'
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
 * Turns an acceptable `uri` into a URL to fetch, or `null`.
 *
 * RETURNING NULL MEANS NO REQUEST IS MADE. That is the whole SSRF defence: the
 * decision happens before `fetch` is reachable, not inside an error handler
 * after the socket is already open.
 */
export function resolvableUrl(uri: string): string | null {
  const trimmed = uri.trim()
  if (trimmed === '') return null

  const ipfs = IPFS_URI.exec(trimmed)
  if (ipfs?.[1] !== undefined) {
    return `${ipfsGatewayOrigin()}/ipfs/${ipfs[1]}${ipfs[2] ?? ''}`
  }

  // The only other acceptable shape: an https URL on the gateway's OWN origin.
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.origin !== ipfsGatewayOrigin()) return null
  return parsed.toString()
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

export async function resolveMetadata(uri: string): Promise<ResolvedMetadata | null> {
  const url = resolvableUrl(uri)
  if (url === null) return null

  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      // `next` is Next.js own extension to RequestInit. Without it Explore
      // would issue one gateway request per card per render.
      next: { revalidate: METADATA_REVALIDATE_SECONDS },
    })
  } catch {
    return null
  }
  if (!response.ok) return null

  const raw = await readCapped(response, METADATA_BODY_LIMIT)
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
