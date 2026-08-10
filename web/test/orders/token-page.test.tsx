import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page, ReadResult, TokenOverview } from '@/components/read/types'
import { CLIMBING, LIVE_INDEXER } from '../fixtures/readModel'
import { renderWithProviders } from '../ui/harness'

/**
 * ==========================================================================
 *  BESTELENMIS SAYFA -- SEKME SERIDI GERCEKTEN ULASILABILIR MI
 * ==========================================================================
 *
 * `surface.test.tsx` seridi BILESEN duzeyinde olcuyor. Bu deponun 1 numarali
 * ariza sekli tam olarak o testin YETMEDIGI yer: *"bir bilesenin testi, o
 * bilesenin ULASILABILIR oldugunu soylemez"* -- on bir ornek, sekizi bir
 * oncekini kapatmak icin yazilmis kodda. `TradePanel` 645 birim testiyle
 * yesildi ve HICBIR SAYFA onu cizmiyordu.
 *
 * Bu yuzden ayni iddia burada, GERCEK `page.tsx` cizilerek tekrarlaniyor:
 * `Market | Limit | Orders` seridi sayfada VAR MI, ve `Limit`e tiklayinca
 * panel GELIYOR MU.
 */

vi.mock('@/lib/read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/read')>()
  return {
    ...actual,
    readTokenOverview: vi.fn(),
    readTrades: vi.fn(),
    readHolders: vi.fn(),
    readChat: vi.fn(),
  }
})

vi.mock('@/lib/metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metadata')>()
  return { ...actual, resolveMetadata: vi.fn(async () => null) }
})

vi.mock('@/lib/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/profile')>()
  return {
    ...actual,
    getCurveProfile: vi.fn(async () => ({
      profile: {
        virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
        virtualQuoteReserves: 4_292n * 10n ** 15n,
        saleSupply: 793_100_000n * 10n ** 18n,
      },
    })),
  }
})

const read = await import('@/lib/read')
const { default: TokenPage } = await import('@/app/token/[address]/page')

/** `chat/token-page.test.tsx` ile AYNI cozucu ve ayni anti-vakum sayaci. */
let resolvedCount = 0

async function resolveServerTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveServerTree(child)))
  if (!isValidElement(node)) return node
  const element = node as ReactElement<{ children?: ReactNode }>
  if (typeof element.type === 'function') {
    if (element.type.constructor.name !== 'AsyncFunction') return element
    resolvedCount += 1
    const output = await (element.type as (props: unknown) => Promise<unknown>)(element.props)
    return resolveServerTree(output as ReactNode)
  }
  const children = element.props.children
  if (children === undefined) return element
  const resolved = await resolveServerTree(children)
  return { ...element, props: { ...element.props, children: resolved } }
}

const TOKEN = CLIMBING.token as `0x${string}`

function fresh<T>(data: T): ReadResult<T> {
  return { ok: true, stale: false, data, indexer: LIVE_INDEXER }
}
function emptyPage<T>(): ReadResult<Page<T>> {
  return fresh({ rows: [] as readonly T[], nextCursor: null })
}

async function renderTokenPage() {
  vi.mocked(read.readTokenOverview).mockResolvedValue(fresh<TokenOverview>(CLIMBING))
  vi.mocked(read.readTrades).mockResolvedValue(emptyPage())
  vi.mocked(read.readHolders).mockResolvedValue(emptyPage())
  vi.mocked(read.readChat).mockResolvedValue(emptyPage())
  const tree = await resolveServerTree(
    await TokenPage({ params: Promise.resolve({ address: TOKEN }) }),
  )
  return renderWithProviders(tree as ReactElement, { connected: true })
}

beforeEach(() => {
  resolvedCount = 0
  vi.clearAllMocks()
})

describe('/token/[address] DRAWS THE Market | Limit | Orders STRIP', () => {
  it('the strip is on the composed page, with all three tabs', async () => {
    await renderTokenPage()
    // ANTI-VAKUM ONCE: cozulmemis bir agacta asagidaki her iddia bos olurdu.
    expect(resolvedCount).toBeGreaterThan(0)

    const strip = screen.getByRole('tablist', { name: 'Trading mode' })
    const tabs = within(strip)
      .getAllByRole('tab')
      .map((t) => t.textContent)
    expect(tabs).toEqual(['Market', 'Limit', 'Orders'])
  })

  it('`Limit` on the REAL page opens a panel that says what it cannot do', async () => {
    await renderTokenPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Limit' }))
    expect(screen.getByTestId('limit-panel')).toBeInTheDocument()
    expect(screen.getByTestId('limit-custody-note').textContent ?? '').toMatch(
      /cannot trade for you/i,
    )
  })

  it('`Orders` on the REAL page opens the orders panel', async () => {
    await renderTokenPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(screen.getByTestId('orders-panel')).toBeInTheDocument()
  })

  /**
   * `Market` VARSAYILAN KALIR, ve bu iddia `trade-panel`i ARAMAZ.
   *
   * OLCULDU: bestelenmis sayfada `TradePanel` DOM'a HIC girmiyor, cunku
   * `useCurveState` zincirden okur ve jsdom'da bir RPC yok -- panel
   * `state === undefined` dalinda `null` doner. Yani "trade-panel orada"
   * demek, olculemeyen bir seyi olcmek olurdu ve testi bir RPC sahtesine
   * bagimli yapardi.
   *
   * Gercek regresyon riski BASKA: seridin YANLIS sekmeyle acilmasi. Faz 4'un
   * karari `Market`in varsayilan olmasiydi ve `Limit` varsayilan olsaydi
   * kullanici, market emri vermek isterken bir limit formu gorurdu. Olculen
   * sey odur.
   */
  it('`Market` is the selected tab when the page first renders', async () => {
    await renderTokenPage()
    const strip = screen.getByRole('tablist', { name: 'Trading mode' })
    const selected = within(strip)
      .getAllByRole('tab')
      .filter((t) => t.getAttribute('aria-selected') === 'true')
      .map((t) => t.textContent)
    expect(selected).toEqual(['Market'])
    expect(screen.queryByTestId('limit-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('orders-panel')).not.toBeInTheDocument()
  })
})
