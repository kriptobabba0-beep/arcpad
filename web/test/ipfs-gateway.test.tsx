import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * =========================================================================
 *  THE FOUR FILES THAT MUST AGREE ABOUT WHERE ARTWORK COMES FROM.
 * =========================================================================
 *
 * This is the assertion no single file can make, which is why the defect
 * lived: `next.config.ts` opened `img-src` to the CONFIGURED gateway while
 * `TokenArtwork.tsx` built every `<img src>` from a hardcoded
 * `https://ipfs.io/ipfs/`. Each file was internally consistent. Together they
 * meant that pointing the app at your own gateway made the browser refuse
 * EVERY token image, by our own header.
 *
 * THE INVARIANT HAS CHANGED, BECAUSE THE FIX FOR THAT BUG WAS NOT ENOUGH.
 * Making the gateway one value fixed the drift and did nothing about what was
 * measured next on the live server: a gateway that answers a bare CID with
 * `application/octet-stream` has its response DISCARDED by Chrome before our
 * code can see it (`net::ERR_BLOCKED_BY_ORB`), and a gateway that answers
 * nothing at all (ipfs.io, 12 s, 0 bytes) takes every image AND every
 * description on the site down with it.
 *
 * So artwork is now same-origin (`/api/ipfs/…`) and the gateway is a LIST.
 * What these tests pin:
 *
 *   1. `img-src` names NO gateway -- the browser must not need one.
 *   2. A configured gateway still moves `connect-src` and the metadata fetch
 *      together, and is PREFERRED without deleting the fallbacks.
 *   3. Every URL `lib/metadata.ts` can hand out as `image` is one that
 *      `resolveArtworkSrc` accepts. This is the new cross-file seam, in
 *      exactly the place the old one was.
 *
 * THE ENV IS SET, THE MODULES ARE RE-IMPORTED, AND IT IS PUT BACK. All of
 * them read `process.env` at CALL time, so a stale module graph would measure
 * the default and pass no matter what.
 */
describe('where artwork comes from, across the app and its CSP', () => {
  const CUSTOM = 'https://gateway.example.test'
  const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_IPFS_GATEWAY
    vi.resetModules()
  })

  async function cspOf(): Promise<string> {
    const config = (await import('../next.config')).default as {
      headers: () => Promise<{ headers: { key: string; value: string }[] }[]>
    }
    const routes = await config.headers()
    const header = routes
      .flatMap((route) => route.headers)
      .find((entry) => entry.key === 'Content-Security-Policy')
    expect(header, 'the config must still emit a CSP').toBeDefined()
    return header!.value
  }

  it('a configured gateway is PREFERRED and moves the CSP and the metadata fetch with it', async () => {
    process.env.NEXT_PUBLIC_IPFS_GATEWAY = CUSTOM
    vi.resetModules()

    const { ipfsGatewayOrigin, ipfsGatewayOrigins, DEFAULT_IPFS_GATEWAYS } = await import(
      '../lib/ipfs'
    )
    const { resolvableUrls } = await import('../lib/metadata')

    expect(ipfsGatewayOrigin(), 'the configured one is tried first').toBe(CUSTOM)
    // AND THE DEFAULTS SURVIVE. Naming your own gateway must not mean the site
    // goes dark while it restarts -- that is the failure this list exists for.
    expect(ipfsGatewayOrigins()).toEqual([CUSTOM, ...DEFAULT_IPFS_GATEWAYS])

    expect(resolvableUrls(`ipfs://${CID}`)[0]).toBe(`${CUSTOM}/ipfs/${CID}`)
    expect(resolvableUrls(`ipfs://${CID}`)).toHaveLength(DEFAULT_IPFS_GATEWAYS.length + 1)

    const csp = await cspOf()
    expect(csp, 'connect-src must still name what the server may talk to').toContain(CUSTOM)
  })

  it('naming a DEFAULT gateway reorders the list rather than duplicating it', async () => {
    const { DEFAULT_IPFS_GATEWAYS } = await import('../lib/ipfs')
    // The last default -- so a pass cannot come from it already being first.
    const last = DEFAULT_IPFS_GATEWAYS[DEFAULT_IPFS_GATEWAYS.length - 1] as string
    process.env.NEXT_PUBLIC_IPFS_GATEWAY = last
    vi.resetModules()

    const { ipfsGatewayOrigins } = await import('../lib/ipfs')
    const origins = ipfsGatewayOrigins()
    expect(origins[0]).toBe(last)
    expect(new Set(origins).size, 'no gateway may appear twice').toBe(origins.length)
    expect(origins).toHaveLength(DEFAULT_IPFS_GATEWAYS.length)
  })

  it('a malformed gateway is ignored, and does not empty the list', async () => {
    process.env.NEXT_PUBLIC_IPFS_GATEWAY = 'not a url'
    vi.resetModules()

    const { ipfsGatewayOrigins, DEFAULT_IPFS_GATEWAYS } = await import('../lib/ipfs')
    // A typo in an env var must not take a page down: this is read while
    // rendering a token card.
    expect(ipfsGatewayOrigins()).toEqual([...DEFAULT_IPFS_GATEWAYS])
  })

  it('the artwork is SAME-ORIGIN, and img-src names no gateway at all', async () => {
    process.env.NEXT_PUBLIC_IPFS_GATEWAY = CUSTOM
    vi.resetModules()

    const { resolveArtworkSrc } = await import('../components/layout/TokenArtwork')
    const { DEFAULT_IPFS_GATEWAYS } = await import('../lib/ipfs')

    expect(resolveArtworkSrc(`ipfs://${CID}/image.png`)).toBe(`/api/ipfs/${CID}/image.png`)

    const csp = await cspOf()
    const imgSrc = csp.split('; ').find((directive) => directive.startsWith('img-src'))
    expect(imgSrc).toBe("img-src 'self' data:")
    // THE POINT: no gateway can make the browser refuse an image any more,
    // because the browser never asks a gateway for one.
    for (const gateway of [CUSTOM, ...DEFAULT_IPFS_GATEWAYS]) {
      expect(imgSrc, `${gateway} must not be needed to draw a picture`).not.toContain(
        new URL(gateway).host,
      )
    }
  })

  it('EVERY url the metadata layer can produce for `image` is one the artwork accepts', async () => {
    process.env.NEXT_PUBLIC_IPFS_GATEWAY = CUSTOM
    vi.resetModules()

    const { resolvableUrls } = await import('../lib/metadata')
    const { resolveArtworkSrc } = await import('../components/layout/TokenArtwork')

    /*
     * THE SEAM. `resolveMetadata` validates `image` with the same allow-list
     * as the document and hands out a GATEWAY url; `TokenArtwork` receives it.
     * If the two ever disagree about which origins are legitimate, artwork
     * silently vanishes for a subset of tokens -- the same shape of bug as
     * before, one layer along. Checked for every gateway, not just the first.
     */
    for (const url of resolvableUrls(`ipfs://${CID}/logo.png`)) {
      expect(resolveArtworkSrc(url), `${url} must survive the hand-off`).toBe(
        `/api/ipfs/${CID}/logo.png`,
      )
    }
  })

  it('an https artwork url on a host we do not use is refused outright', async () => {
    vi.resetModules()
    const { resolveArtworkSrc } = await import('../components/layout/TokenArtwork')
    // Not "rendered and then blocked by the CSP" -- never requested. That
    // request would leak every visitor's IP to whoever owns the host.
    expect(resolveArtworkSrc('https://tracker.example/pixel.png')).toBeNull()
    expect(resolveArtworkSrc('http://gateway.pinata.cloud/ipfs/QmX')).toBeNull()
    expect(resolveArtworkSrc('javascript:alert(1)')).toBeNull()
    expect(resolveArtworkSrc('data:image/png;base64,AAAA')).toBeNull()
  })

  it('with NOTHING configured, the default is a gateway that ANSWERS', async () => {
    delete process.env.NEXT_PUBLIC_IPFS_GATEWAY
    vi.resetModules()

    const { ipfsGatewayOrigin, ipfsGatewayOrigins } = await import('../lib/ipfs')

    /*
     * MEASURED, NOT PREFERRED. From the live deployment on 2026-08-11:
     *   ipfs.io               timed out after 12 s, 0 bytes
     *   gateway.pinata.cloud  200, image/png, 3.7 s
     * ipfs.io stays in the list -- it recovers -- but it must never again be
     * the one every request goes to first.
     */
    expect(ipfsGatewayOrigin()).not.toContain('ipfs.io')
    expect(ipfsGatewayOrigins().length, 'one gateway is one point of failure').toBeGreaterThan(1)
  })
})
