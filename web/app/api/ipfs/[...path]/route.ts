import { ipfsGatewayOrigins, ipfsPathPrefix } from '@/lib/ipfs'
import { type CachedImage, once, readCached, writeCached } from '@/lib/ipfsCache'

/**
 * ===========================================================================
 *  ARTWORK, SERVED FROM OUR OWN ORIGIN.
 * ===========================================================================
 *
 * WHY THIS EXISTS, MEASURED RATHER THAN REASONED. A real upload through the
 * real form on the live server, watched in a real browser:
 *
 *   POST /api/metadata                                  => 200  (pinned)
 *   GET  https://ipfs.io/ipfs/QmWcPGQ…  => net::ERR_BLOCKED_BY_ORB
 *
 * Everything our code does was correct — the file uploaded, the CID came
 * back, the preview's `<img>` switched to it. The BROWSER threw the image
 * away. Opaque Response Blocking discards a cross-origin no-cors response
 * that does not look like the media it was requested as, and a gateway
 * serving a bare CID has no filename to infer a type from, so it answers
 * `application/octet-stream`. `onError` fires, the fallback gradient returns,
 * and to the person who just uploaded their logo the page simply ignored them.
 *
 * No client-side change can fix that. The response has to be ours.
 *
 * ---------------------------------------------------------------------------
 * THIS ROUTE FETCHES A URL BUILT FROM A PATH A STRANGER CHOSE, so it is an
 * SSRF surface and every restriction below is load-bearing:
 *
 *   1. The first segment must look like a CID, and the rest must be a tame
 *      relative path. The check runs BEFORE a URL exists — not inside an
 *      error handler with the socket already open.
 *   2. The host is never taken from input. It comes from `ipfsGatewayOrigins()`
 *      and nowhere else, so this cannot be pointed at 169.254.169.254 or at
 *      anything on the deployment's own network.
 *   3. The content type is DECIDED HERE FROM THE BYTES, never copied from
 *      upstream. This is what defeats ORB — and it is also what stops this
 *      route becoming stored XSS: pin an HTML file, and a proxy that echoed
 *      `text/html` would serve attacker script FROM OUR ORIGIN, with our
 *      cookies and our CSP. Four magic numbers, everything else is 415.
 *   4. A hard byte ceiling applied WHILE STREAMING. `Content-Length` is a
 *      claim by the same party that controls the body.
 *   5. Failure is never a 500. A missing image is an ordinary event on IPFS;
 *      the card draws its gradient and the page is fine.
 */

/** The same ceiling `/api/metadata` enforces on upload. Ours cannot be laxer. */
const MAX_BYTES = 5 * 1024 * 1024

/**
 * Per-gateway, and then a ceiling on the whole request.
 *
 * MEASURED: a successful fetch from the public Pinata gateway took 3.5 s,
 * 5.2 s and 5.6 s on three tries — so a 6 s per-gateway budget was refusing
 * responses that were merely slow. 9 s covers the observed spread.
 *
 * The DEADLINE exists because four gateways at 9 s each is 36 seconds, and
 * nothing should hold a socket open that long for a picture. Past it we stop
 * asking and let the card draw its gradient; the next visitor tries again.
 */
const UPSTREAM_TIMEOUT_MS = 9_000
const TOTAL_DEADLINE_MS = 20_000

/**
 * A CIDv0 (`Qm…`, base58btc, 46 chars) or a CIDv1 (base32, lowercase, `b…`).
 *
 * Deliberately stricter than "whatever IPFS accepts": this string is about to
 * become part of a URL we fetch, and a narrow shape that occasionally refuses
 * an exotic-but-valid CID is the correct trade against one that occasionally
 * admits something that is not a CID at all.
 */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/

/** Path segments after the CID: ordinary file names, and nothing that climbs. */
const SUBPATH_SEGMENT = /^[\w][\w\-.]{0,127}$/

/**
 * Magic numbers for the four types `/api/metadata` accepts on upload.
 *
 * SNIFFED, NOT TRUSTED. The bytes are the only thing here that the person who
 * pinned the file cannot lie about.
 */
function imageTypeOf(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i]
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * `['Qm…', 'logo.png']` -> `Qm…/logo.png`, or `null` if anything is off.
 *
 * Rejecting rather than sanitising: a path that needed cleaning is a path
 * somebody built by hand, and guessing what they meant is how traversal bugs
 * are written. `..` never survives, both because it fails `SUBPATH_SEGMENT`
 * and because a caller could not have produced it from an `ipfs://` URI.
 */
export function safeIpfsPath(segments: readonly string[]): string | null {
  const [cid, ...rest] = segments
  if (cid === undefined || !CID.test(cid)) return null
  if (rest.some((segment) => !SUBPATH_SEGMENT.test(segment))) return null
  return [cid, ...rest].join('/')
}

/** Reads at most `limit` bytes, then stops and drops the connection. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
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
      if (total > limit) return null
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** A gateway answered and the content is not an image. Distinct from "nobody answered". */
const NOT_AN_IMAGE = Symbol('not an image')

/**
 * Fetches the bytes from the first gateway that answers, or reports why not.
 *
 * `NOT_AN_IMAGE` is separate from `null` on purpose. A CID that resolves to
 * something we will not serve has been ANSWERED — content addressing means
 * every other gateway holds the same bytes, so asking them is four requests
 * for a result already known.
 */
async function fromGateways(relative: string): Promise<CachedImage | typeof NOT_AN_IMAGE | null> {
  const deadline = Date.now() + TOTAL_DEADLINE_MS

  for (const origin of ipfsGatewayOrigins()) {
    if (Date.now() >= deadline) break

    let response: Response
    try {
      response = await fetch(`${ipfsPathPrefix(origin)}${relative}`, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: 'follow',
        headers: { accept: 'image/*' },
        cache: 'no-store',
      })
    } catch {
      continue // Timeout, DNS, TLS, connection refused: try the next one.
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      continue
    }

    const bytes = await readCapped(response, MAX_BYTES)
    if (bytes === null || bytes.byteLength === 0) continue

    const type = imageTypeOf(bytes)
    if (type === null) return NOT_AN_IMAGE
    return { bytes, type }
  }
  return null
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params
  const relative = safeIpfsPath(path ?? [])
  if (relative === null) return notFound()

  const cached = await readCached(relative)
  if (cached !== null) return serve(cached)

  /*
   * ONE ATTEMPT PER CID, NO MATTER HOW MANY CARDS ASK AT ONCE.
   *
   * The explore page draws 48 of these. Without `once`, a cold page is 48
   * simultaneous requests to the same gateway for the same file — which is
   * precisely the burst that gets a public gateway to start refusing us, and
   * it was measured doing exactly that: half of six sequential requests came
   * back 404 after up to 24 seconds.
   */
  let notAnImage = false
  const image = await once(relative, async () => {
    const result = await fromGateways(relative)
    if (result === NOT_AN_IMAGE) {
      notAnImage = true
      return null
    }
    if (result !== null) await writeCached(relative, result)
    return result
  })

  if (image !== null) return serve(image)
  if (notAnImage) {
    return new Response('unsupported media type', {
      status: 415,
      headers: { 'cache-control': 'public, max-age=3600' },
    })
  }

  /*
   * NOT 500. Nothing is broken here that an operator can act on — the file
   * is simply not retrievable right now, which on IPFS is ordinary. 404 also
   * lets `TokenArtwork` do the one correct thing: draw the gradient.
   *
   * `no-store`, unlike the 415 above: a gateway that is throttling us right
   * now will not be in an hour, and caching this would turn a bad minute into
   * a permanently missing picture.
   */
  return notFound()
}

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } })
}

function serve(image: CachedImage): Response {
  return new Response(image.bytes as BodyInit, {
    status: 200,
    headers: {
      'content-type': image.type,
      'content-length': String(image.bytes.byteLength),
      /*
       * IMMUTABLE IS NOT OPTIMISM HERE, IT IS WHAT A CID MEANS. The bytes are
       * the address; this response can never become stale. Without it every
       * card redraw would spend a request, and the home page draws 48 of them.
       */
      'cache-control': 'public, max-age=31536000, immutable',
      // We just decided the type from the bytes. Do not let a browser
      // re-decide it into something executable.
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    },
  })
}
