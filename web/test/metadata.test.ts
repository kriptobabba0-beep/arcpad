import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  METADATA_BODY_LIMIT,
  METADATA_REVALIDATE_SECONDS,
  resolvableUrl,
  resolveMetadata,
} from '../lib/metadata'

/**
 * `uri` IS ATTACKER CONTROLLED, so the interesting assertion is not what the
 * resolver RETURNS but whether it makes a REQUEST AT ALL.
 *
 * Every SSRF case below counts `fetch` calls and requires ZERO. A test that
 * only checked the return value would pass just as happily against a resolver
 * that fetched `http://169.254.169.254/`, got a 404, and returned null.
 */

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'

afterEach(() => {
  vi.restoreAllMocks()
})

function countingFetch(response?: Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (response === undefined) throw new Error('this test must not fetch')
    return response
  })
}

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('the allow-list decides BEFORE fetch is reachable', () => {
  it.each([
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata over plain http'],
    ['http://127.0.0.1:5432/', 'loopback'],
    ['https://10.0.0.5/meta.json', 'a private IP on https'],
    ['file:///etc/passwd', 'a local file'],
    ['data:application/json,{}', 'an inline data URI'],
    ['https://evil.example/meta.json', 'some other host'],
    ['ipfs://../../etc/passwd', 'a traversal dressed as ipfs'],
    ['', 'the empty string, which is common'],
  ])('%s makes NO request (%s)', async (uri) => {
    const fetchSpy = countingFetch()
    expect(resolvableUrl(uri)).toBeNull()
    await expect(resolveMetadata(uri)).resolves.toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(0)
  })

  it('CONTROL: a real ipfs uri DOES resolve and DOES fetch', async () => {
    // Without this, every case above would be satisfied by a resolver that
    // never fetches anything at all.
    const fetchSpy = countingFetch(jsonResponse({ description: 'hello' }))
    expect(resolvableUrl(`ipfs://${CID}`)).toBe(`https://ipfs.io/ipfs/${CID}`)
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toEqual({ description: 'hello' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('an ipfs uri with a path keeps the path', () => {
    expect(resolvableUrl(`ipfs://${CID}/meta/token.json`)).toBe(
      `https://ipfs.io/ipfs/${CID}/meta/token.json`,
    )
  })
})

describe('the body ceiling is applied to the STREAM, not to the header', () => {
  it('a 100 kB body is refused', async () => {
    const big = 'x'.repeat(100 * 1024)
    countingFetch(jsonResponse({ description: big }))
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toBeNull()
  })

  /**
   * THE HEADER LIES. A response that CLAIMS to be small and streams 100 kB is
   * exactly what an attacker sends, and a ceiling read off `Content-Length`
   * would wave it through.
   */
  it('a LYING Content-Length does not get the body past the ceiling', async () => {
    const big = 'x'.repeat(100 * 1024)
    const lying = new Response(JSON.stringify({ description: big }), {
      status: 200,
      // A deliberate lie: the real body is ~100 kB.
      headers: { 'content-type': 'application/json', 'content-length': '12' },
    })
    countingFetch(lying)
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toBeNull()
  })

  it('the ceiling is 64 kB and a document just under it still resolves', async () => {
    expect(METADATA_BODY_LIMIT).toBe(64 * 1024)
    countingFetch(jsonResponse({ description: 'y'.repeat(1_000) }))
    const resolved = await resolveMetadata(`ipfs://${CID}`)
    // Clipped to the display limit, but present.
    expect(resolved?.description).toHaveLength(256)
  })
})

describe('failure is a normal result', () => {
  it('a non-200 resolves to null', async () => {
    countingFetch(jsonResponse({ description: 'no' }, { status: 404 }))
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toBeNull()
  })

  it('a network error or a timeout resolves to null, never throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
    )
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toBeNull()
  })

  it('a non-JSON body resolves to null', async () => {
    countingFetch(new Response('<html>nope</html>', { status: 200 }))
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toBeNull()
  })

  it('a JSON array is not a metadata document', async () => {
    countingFetch(jsonResponse([{ description: 'x' }]))
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toBeNull()
  })
})

describe('the document is filtered, not trusted', () => {
  it('an image on another host is DROPPED while the description survives', async () => {
    countingFetch(
      jsonResponse({ description: 'a real token', image: 'https://evil.example/tracker.png' }),
    )
    const resolved = await resolveMetadata(`ipfs://${CID}`)
    expect(resolved).toEqual({ description: 'a real token' })
    expect(resolved?.image).toBeUndefined()
  })

  it('an ipfs image is kept and rewritten to the gateway', async () => {
    countingFetch(jsonResponse({ image: `ipfs://${CID}/art.png` }))
    const resolved = await resolveMetadata(`ipfs://${CID}`)
    expect(resolved?.image).toBe(`https://ipfs.io/ipfs/${CID}/art.png`)
  })

  it('unknown fields are dropped by construction', async () => {
    countingFetch(
      jsonResponse({ description: 'ok', evil: 'payload', __proto__: { polluted: true } }),
    )
    const resolved = await resolveMetadata(`ipfs://${CID}`)
    expect(resolved).toEqual({ description: 'ok' })
    expect(Object.keys(resolved ?? {})).toEqual(['description'])
  })

  it('a description carrying markup and bidi controls is sanitised', async () => {
    const nasty = `<script>alert(1)</script>${String.fromCodePoint(0x202e)}drawkcab`
    countingFetch(jsonResponse({ description: nasty }))
    const resolved = await resolveMetadata(`ipfs://${CID}`)
    // React escapes the markup; what React does NOT do is strip the bidi
    // override, which is the part that makes one string render as another.
    expect(resolved?.description).not.toContain(String.fromCodePoint(0x202e))
    expect(resolved?.description).toContain('alert(1)')
  })

  it('a non-https social link is dropped', async () => {
    countingFetch(
      jsonResponse({ telegram: 'javascript:alert(1)', twitter: 'https://x.com/arcpad' }),
    )
    const resolved = await resolveMetadata(`ipfs://${CID}`)
    expect(resolved?.telegram).toBeUndefined()
    expect(resolved?.x).toBe('https://x.com/arcpad')
  })

  it('an empty document resolves to null rather than an empty object', async () => {
    countingFetch(jsonResponse({}))
    await expect(resolveMetadata(`ipfs://${CID}`)).resolves.toBeNull()
  })
})

describe('caching', () => {
  it('the fetch carries a revalidate window', async () => {
    // Explore draws 24 cards. Uncached that is 24 gateway requests per render,
    // which is both slow and a way to get rate-limited off the gateway.
    const fetchSpy = countingFetch(jsonResponse({ description: 'ok' }))
    await resolveMetadata(`ipfs://${CID}`)
    const init = fetchSpy.mock.calls[0]?.[1] as { next?: { revalidate?: number } } | undefined
    expect(init?.next?.revalidate).toBe(METADATA_REVALIDATE_SECONDS)
    expect(METADATA_REVALIDATE_SECONDS).toBe(300)
  })
})
