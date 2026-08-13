import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TokenGrid } from '@/components/explore/TokenGrid'
import type { TokenOverview } from '@/components/read/types'

/**
 * ============================================================================
 *  THE GRID MUST BE ABLE TO DRAW ARTWORK, AND ONE PLACE MUST PASS IT
 * ============================================================================
 *
 * The defect this file exists for: `TokenCard` accepted an OPTIONAL `imageUrl`
 * and `TokenGrid` rendered `<TokenCard overview={overview} />` without it. So
 * every card on the home page drew its fallback gradient forever, no matter
 * what a creator uploaded -- and nothing failed, because `undefined` is a
 * legal value that means "this token has no artwork".
 *
 * It hid for as long as it did because for months it was also TRUE: every
 * launch on the deployment carried an empty `uri`. The first launch with a
 * real pinned document made it visible -- the picture appeared on the token
 * PAGE (which resolves metadata) and was missing from the GRID (which did
 * not).
 *
 * So the assertion is not "the component can render an image" -- it always
 * could. It is that the grid PASSES THE MAP DOWN, which is the wiring that was
 * missing.
 */

function overview(token: string, symbol: string): TokenOverview {
  return {
    token,
    curve: '0x0000000000000000000000000000000000000001',
    name: `Token ${symbol}`,
    symbol,
    creator: '0x0000000000000000000000000000000000000002',
    uri: 'ipfs://QmfSPEQvd88SGQRsLzcxCWCfNwt4sSscSzCr5ffxynWhKs',
    createdAt: new Date('2026-08-11T00:00:00Z'),
    priceWei: 4_000_000_000_000_000_000n,
    marketCapWei: 4_000_000_000_000_000_000n,
    volume24hWei: 0n,
    progressPpm: 0,
    holders: 0,
    graduated: false,
  } as unknown as TokenOverview
}

const CID = 'QmXULSPHUzkHpC7Ua3SABpnNVNRERofjyiTETXM1HBonNH'

describe('TokenGrid passes artwork through', () => {
  it('draws the image when the map has one for that token', () => {
    const a = overview('0x1111111111111111111111111111111111111111', 'AAA')
    render(<TokenGrid tokens={[a]} label="Launches" images={{ [a.token]: `ipfs://${CID}` }} />)
    const img = screen.getByTestId('token-artwork').querySelector('img')
    expect(img, 'the grid must render the artwork it was given').not.toBeNull()
    // SAME-ORIGIN. A gateway URL here would be discarded by Chrome's ORB --
    // measured live, and the reason `/api/ipfs/` exists at all.
    expect(img).toHaveAttribute('src', `/api/ipfs/${CID}`)
  })

  it('per-token, not all-or-nothing', () => {
    const a = overview('0x1111111111111111111111111111111111111111', 'AAA')
    const b = overview('0x2222222222222222222222222222222222222222', 'BBB')
    render(<TokenGrid tokens={[a, b]} label="Launches" images={{ [a.token]: `ipfs://${CID}` }} />)

    const boxes = screen.getAllByTestId('token-artwork')
    expect(boxes).toHaveLength(2)
    // One picture, one gradient -- a token without artwork must not suppress
    // the artwork of its neighbour.
    expect(boxes.filter((box) => box.querySelector('img') !== null)).toHaveLength(1)
  })

  it('no map at all still renders -- gradients, never a crash', () => {
    // The old behaviour, kept legal on purpose: `images` is optional so a
    // caller that genuinely has no metadata (a skeleton, a test) still works.
    const a = overview('0x1111111111111111111111111111111111111111', 'AAA')
    render(<TokenGrid tokens={[a]} label="Launches" />)
    expect(screen.getByTestId('token-artwork').querySelector('img')).toBeNull()
  })
})

/**
 * THE BATCH RESOLVER, AND THE BUDGET THAT KEEPS A GATEWAY OFF THE PAGE.
 *
 * A gateway fetch was measured at 5.2 s on the live box. A grid is up to 48
 * cards. The rules below are what stop that arithmetic from becoming a dead
 * page.
 */
describe('resolveArtworkMap', () => {
  it('makes NO request for tokens with an empty uri', async () => {
    const { resolveArtworkMap } = await import('@/lib/metadata')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const out = await resolveArtworkMap([
        { token: '0xaaa', uri: '' },
        { token: '0xbbb', uri: null },
        { token: '0xccc' },
      ])
      expect(out).toEqual({})
      // Most launches on this deployment have no uri. Paying a request for
      // each of them would be the entire cost of the feature, for nothing.
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resolves ONE document for two tokens that share a uri', async () => {
    const { resolveArtworkMap } = await import('@/lib/metadata')
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response(JSON.stringify({ image: `ipfs://${CID}` }), { status: 200 })
    })
    try {
      const out = await resolveArtworkMap([
        { token: '0xaaa', uri: 'ipfs://QmfSPEQvd88SGQRsLzcxCWCfNwt4sSscSzCr5ffxynWhKs' },
        { token: '0xbbb', uri: 'ipfs://QmfSPEQvd88SGQRsLzcxCWCfNwt4sSscSzCr5ffxynWhKs' },
      ])
      expect(calls, 'de-duplicated by URI, not by token').toBe(1)
      expect(out['0xaaa']).toBe(out['0xbbb'])
      /*
       * WHAT COMES BACK IS A GATEWAY URL, NOT THE RAW `ipfs://`, because
       * `resolveMetadata` puts `image` through the same allow-list as the
       * document. That is the seam worth asserting: whatever shape it is, the
       * artwork resolver must ACCEPT it -- otherwise the picture is resolved
       * and then silently dropped one layer later, which is this file's
       * entire subject.
       */
      const { resolveArtworkSrc } = await import('@/components/layout/TokenArtwork')
      expect(resolveArtworkSrc(out['0xaaa'] as string)).toBe(`/api/ipfs/${CID}`)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('A SLOW GATEWAY DOES NOT HOLD THE PAGE', async () => {
    const { resolveArtworkMap } = await import('@/lib/metadata')
    vi.stubGlobal(
      'fetch',
      () => new Promise<Response>(() => {}), // never settles
    )
    try {
      const started = Date.now()
      const out = await resolveArtworkMap(
        [{ token: '0xaaa', uri: 'ipfs://QmfSPEQvd88SGQRsLzcxCWCfNwt4sSscSzCr5ffxynWhKs' }],
        60,
      )
      // Renders WITHOUT the picture rather than not rendering. The next
      // `LiveRefresh` tick picks it up once Next's fetch cache is warm.
      expect(out).toEqual({})
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
