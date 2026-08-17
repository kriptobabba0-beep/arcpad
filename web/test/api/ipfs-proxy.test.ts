import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, safeIpfsPath } from '../../app/api/ipfs/[...path]/route'

/**
 * =========================================================================
 *  THE ROUTE THAT MAKES A PICTURE OURS.
 * =========================================================================
 *
 * It exists because of one measured line from a real upload on the live
 * server, in a real browser:
 *
 *   GET https://ipfs.io/ipfs/QmWcPGQ…  =>  net::ERR_BLOCKED_BY_ORB
 *
 * Everything our code did was right; the browser threw the image away because
 * the gateway could not name its type. So the tests below are about the two
 * things this route must do that no client-side code could: NAME THE TYPE
 * FROM THE BYTES, and SURVIVE A GATEWAY THAT IS DOWN.
 *
 * And one thing it must never do. This route fetches a URL built from a path
 * a stranger chose and serves the result from OUR origin -- so if it echoed
 * upstream's content type, anyone could pin an HTML file and have us serve
 * their script under our own domain and CSP. That is the `text/html` test,
 * and it is the most important one here.
 */

const CID = 'QmWcPGQPKBe9iHBh8HqjZX729JBc4CSBKJSbJ7fpWWf5WB'
const CIDv1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0])
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
])
const HTML = new TextEncoder().encode('<script>fetch("/api/steal")</script>')

function params(...path: string[]) {
  return { params: Promise.resolve({ path }) }
}

function upstream(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(bytes as BodyInit, { status: 200, ...init })
}

describe('/api/ipfs -- the path guard', () => {
  it('accepts a CIDv0, a CIDv1 and an ordinary sub-path', () => {
    expect(safeIpfsPath([CID])).toBe(CID)
    expect(safeIpfsPath([CIDv1])).toBe(CIDv1)
    expect(safeIpfsPath([CID, 'logo.png'])).toBe(`${CID}/logo.png`)
  })

  it('refuses anything that is not a CID, and never sanitises', () => {
    // A URL is built from this and then FETCHED. Every one of these is a way
    // to aim that fetch at something that is not IPFS.
    expect(safeIpfsPath([])).toBeNull()
    expect(safeIpfsPath([''])).toBeNull()
    expect(safeIpfsPath(['..'])).toBeNull()
    expect(safeIpfsPath(['169.254.169.254'])).toBeNull()
    expect(safeIpfsPath(['QmTooShort'])).toBeNull()
    expect(safeIpfsPath([`${CID}?x=1`])).toBeNull()
    expect(safeIpfsPath([CID, '..', '..', 'etc', 'passwd'])).toBeNull()
    expect(safeIpfsPath([CID, 'a/b'])).toBeNull()
    // Guessing what a malformed path meant is how traversal bugs are written.
    expect(safeIpfsPath([CID, '%2e%2e'])).toBeNull()
  })
})

describe('/api/ipfs -- serving', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the type FROM THE BYTES, whatever upstream claimed', async () => {
    // The exact production failure: a gateway calling a PNG an octet-stream.
    // Echoing that header is what made Chrome discard the image.
    fetchMock.mockResolvedValue(
      upstream(PNG, { headers: { 'content-type': 'application/octet-stream' } }),
    )

    const response = await GET(new Request('http://x/'), params(CID))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })

  it.each([
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
  ])('recognises %s', async (type, bytes) => {
    fetchMock.mockResolvedValue(upstream(bytes))
    const response = await GET(new Request('http://x/'), params(CID))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
  })

  it('REFUSES to serve html, even when upstream says it is html', async () => {
    /*
     * THE ONE THAT MATTERS. Pin an HTML file, get the site to draw it as an
     * avatar, and a proxy that trusted upstream would serve attacker script
     * from our origin -- same-origin with our CSP, our cookies, our domain in
     * the address bar. Stored XSS, delivered by us.
     */
    fetchMock.mockResolvedValue(upstream(HTML, { headers: { 'content-type': 'text/html' } }))

    const response = await GET(new Request('http://x/'), params(CID))

    expect(response.status).toBe(415)
    expect(response.headers.get('content-type')).not.toContain('text/html')
    expect(await response.text()).not.toContain('<script>')
    // ONE upstream request, not four: IPFS is content addressed, so a second
    // gateway cannot hold different bytes for the same CID.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches immutably, because a CID cannot change', async () => {
    fetchMock.mockResolvedValue(upstream(PNG))
    const response = await GET(new Request('http://x/'), params(CID))
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('404s on a bad path WITHOUT fetching anything', async () => {
    const response = await GET(new Request('http://x/'), params('not-a-cid'))
    expect(response.status).toBe(404)
    // The SSRF defence is that the decision happens before `fetch` is reachable.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('/api/ipfs -- one dead gateway is not an outage', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('moves to the next gateway when the first one times out', async () => {
    // ipfs.io on 2026-08-11: twelve seconds, zero bytes. With one gateway
    // that was every image on the site.
    fetchMock
      .mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'))
      .mockResolvedValueOnce(upstream(PNG))

    const response = await GET(new Request('http://x/'), params(CID))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('moves on for a 404 or a 5xx too', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(upstream(GIF))

    const response = await GET(new Request('http://x/'), params(CID))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/gif')
  })

  it('when EVERY gateway is down it is a 404, not a 500', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    const response = await GET(new Request('http://x/'), params(CID))

    // Nothing here is broken that an operator can act on, and 404 lets
    // TokenArtwork do the one right thing: draw its gradient.
    expect(response.status).toBe(404)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    // Every attempt went to a gateway host -- never to anything from the path.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/[^/]+\/ipfs\/QmWcPGQ/)
    }
  })
})
