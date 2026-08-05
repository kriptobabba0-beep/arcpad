import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * =========================================================================
 *  THE CSP'S GATEWAY AND THE ARTWORK'S GATEWAY MUST BE ONE STRING.
 * =========================================================================
 *
 * This is the assertion no single file could make, which is why the defect
 * lived: `next.config.ts` opened `img-src` to the CONFIGURED gateway while
 * `TokenArtwork.tsx` built every `<img src>` from a hardcoded
 * `https://ipfs.io/ipfs/`. Each file was internally consistent. Together they
 * meant that pointing the app at your own gateway made the browser refuse
 * EVERY token image, by our own header — and the metadata JSON still arrived,
 * so it read like a broken gateway rather than a broken config.
 *
 * `MAINNET-READINESS.md` §3 files this as "`IPFS_GATEWAY` is not
 * configurable". It is configurable in three places out of four; the knob does
 * half of something and the half it does breaks the other half.
 *
 * THE ENV IS SET, THE MODULES ARE RE-IMPORTED, AND IT IS PUT BACK. All three
 * read `process.env` at CALL time, so a stale module graph would measure the
 * default and pass no matter what.
 */
describe('the IPFS gateway is ONE value across the app and its CSP', () => {
  const CUSTOM = 'https://gateway.example.test'

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_IPFS_GATEWAY
    vi.resetModules()
  })

  it('a configured gateway moves the CSP, the metadata fetch AND the artwork together', async () => {
    process.env.NEXT_PUBLIC_IPFS_GATEWAY = CUSTOM
    vi.resetModules()

    const { ipfsGatewayOrigin, ipfsPathPrefix } = await import('../lib/ipfs')
    const { resolvableUrl } = await import('../lib/metadata')
    const config = (await import('../next.config')).default as {
      headers: () => Promise<{ headers: { key: string; value: string }[] }[]>
    }

    expect(ipfsGatewayOrigin()).toBe(CUSTOM)
    expect(ipfsPathPrefix()).toBe(`${CUSTOM}/ipfs/`)
    expect(
      resolvableUrl('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'),
    ).toBe(`${CUSTOM}/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`)

    const routes = await config.headers()
    const csp = routes
      .flatMap((route) => route.headers)
      .find((header) => header.key === 'Content-Security-Policy')
    expect(csp, 'the config must still emit a CSP').toBeDefined()

    // THE ASSERTION. `img-src` must name the origin the <img> will actually
    // ask for -- and must NOT still be carrying the default.
    expect(csp!.value).toContain(`img-src 'self' data: ${CUSTOM}`)
    expect(csp!.value).not.toContain('ipfs.io')

    // The artwork resolver, which is the half that used to be hardcoded.
    const { resolveArtworkSrc } = await import('../components/layout/TokenArtwork')
    expect(
      resolveArtworkSrc(
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/image.png',
      ),
    ).toBe(`${CUSTOM}/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/image.png`)
  })

  it('with NOTHING configured, all four agree on the default', async () => {
    delete process.env.NEXT_PUBLIC_IPFS_GATEWAY
    vi.resetModules()

    const { ipfsGatewayOrigin, DEFAULT_IPFS_GATEWAY } = await import('../lib/ipfs')
    const { resolveArtworkSrc } = await import('../components/layout/TokenArtwork')
    const { resolvableUrl } = await import('../lib/metadata')

    expect(ipfsGatewayOrigin()).toBe(DEFAULT_IPFS_GATEWAY)
    expect(
      resolvableUrl('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'),
    ).toBe(
      `${DEFAULT_IPFS_GATEWAY}/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`,
    )
    expect(
      resolveArtworkSrc('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'),
    ).toBe(
      `${DEFAULT_IPFS_GATEWAY}/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`,
    )
  })
})
