import type { ChatMessageRow } from '@arcpad/db'
import { screen } from '@testing-library/react'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page, ReadResult, TokenOverview } from '@/components/read/types'
import { renderWithProviders } from '../ui/harness'
import { CLIMBING, LIVE_INDEXER } from '../fixtures/readModel'

/**
 * ==========================================================================
 *  CHAT PANELI SAYFADAN ULASILABILIR MI?
 * ==========================================================================
 *
 * `test/chat/panel.test.tsx` paneli ELLE kurulmus prop'larla ciziyor ve o
 * dosya, bu depodaki en sik kusurun tam olarak yasadigi yer: **bir bilesenin
 * testi, o bilesenin ULASILABILIR oldugunu soylemez.** Ayni kusur `web/`de
 * bes gunde uc kez indi -- `TradePanel` 645 testle olculuyordu ve hicbir sayfa
 * onu cizmiyordu; `CurveChart`in gerceklesen katmani prop gecilmedigi icin
 * hicbir DOM'a girmiyordu; `resolveLifecycle`in `graduated` dali sayfada
 * besleniyor degildi.
 *
 * Bu dosya bu yuzden `app/token/[address]/page.tsx`i BIR SAYFA OLARAK cizer
 * ve panelin (a) DOM'da oldugunu, (b) SATIRLARI aldigini, (c) `loadMore`unun
 * GECILDIGINI olcer.
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

/**
 * ==========================================================================
 *  SUNUCU BILESENLERINI COZEN KUCUK BIR YARDIMCI
 * ==========================================================================
 *
 * `TokenPage` bir `async` fonksiyondur ve DONDURDUGU agacin icinde BASKA bir
 * `async` bilesen (`IndexedToken`) durur. `@testing-library/react` bir
 * `Promise` dondurten eleman tipini cizemez, yani `render(await TokenPage(...))`
 * TEK BASINA yetmez -- ve yetmedigi fark edilmeseydi bu dosya "sayfayi
 * cizdim" derken aslinda bos bir Fragment ciziyor olurdu.
 *
 * `IndexedToken`i disari acmak da SECILMEDI: bir Next `page.tsx`inden
 * beklenmeyen bir isim ihrac etmek, uretim derlemesinin dogruladigi bir
 * sozlesmeyi testin ihtiyaci icin degistirmek olurdu.
 *
 * Asagidaki gezinti `async` bilesen elemanlarini cagirip sonuclariyla
 * degistirir; senkron olanlara DOKUNMAZ, cunku onlari React'in kendisi
 * cizmelidir (hook'lari var). `resolvedCount` bir sayacdir ve testin ilk
 * iddiasi onun SIFIR OLMADIGI: cozulmemis bir agacta bu dosyanin butun
 * "panel orada" iddialari bos olurdu.
 */
let resolvedCount = 0

async function resolveServerTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child) => resolveServerTree(child)))
  }
  if (!isValidElement(node)) return node

  const element = node as ReactElement<{ children?: ReactNode }>
  if (typeof element.type === 'function') {
    /*
     * YALNIZCA `async` OLANLAR CAGRILIR, ve bu bir duzeltme: ilk hali her
     * fonksiyon bilesenini "Promise mi donduruyor" diye CAGIRIYORDU ve
     * `TableTabs` gibi hook tasiyan senkron bir bilesende
     * "Cannot read properties of null (reading 'useState')" ile patliyordu --
     * React'in disinda bir hook cagrisi. Senkron bilesenleri React cizmeli.
     */
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

const MESSAGE: ChatMessageRow = {
  messageSeq: 42n,
  token: TOKEN,
  authorAddr: '0x00000000000000000000000000000000000a11ce',
  body: 'this curve is going to graduate',
  balanceTok: (10n ** 27n * 250n) / 10_000n,
  balanceBlockNumber: 55_870_261n,
  nonceHex: `0x${'ab'.repeat(32)}`,
  signatureHex: `0x${'cd'.repeat(65)}`,
  issuedAt: new Date('2026-08-10T00:00:00.000Z'),
  createdAt: new Date('2026-08-10T00:00:01.000Z'),
  currentBalanceTok: 0n,
  isLaunchCreator: false,
}

async function renderTokenPage(chat: ReadResult<Page<ChatMessageRow>>) {
  vi.mocked(read.readTokenOverview).mockResolvedValue(fresh<TokenOverview>(CLIMBING))
  vi.mocked(read.readTrades).mockResolvedValue(emptyPage())
  vi.mocked(read.readHolders).mockResolvedValue(emptyPage())
  vi.mocked(read.readChat).mockResolvedValue(chat)

  const tree = await resolveServerTree(
    await TokenPage({
      params: Promise.resolve({ address: TOKEN }),
      // SAYFANIN DURUMU ADRESTE (zaman dilimi, olcu, sekme, sayfa). Bos bir
      // nesne "varsayilanlar" demektir ve sayfa tam olarak oyle davranmalidir.
      searchParams: Promise.resolve({}),
    }),
  )
  return renderWithProviders(tree as ReactElement)
}

beforeEach(() => {
  resolvedCount = 0
  vi.clearAllMocks()
})

describe('/token/[address] CHAT PANELINI CIZER', () => {
  it('panel DOM`da ve mesaji tasiyor', async () => {
    await renderTokenPage(fresh({ rows: [MESSAGE], nextCursor: null }))

    // (0) COZUCU GERCEKTEN CALISTI. Bu iddia olmadan asagidakiler bos olurdu.
    expect(resolvedCount).toBeGreaterThan(0)

    // (1) PANEL ULASILABILIR.
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
    // (2) SATIRLAR SAYFADAN GELDI -- elle kurulmus bir prop'tan degil.
    expect(screen.getByTestId('chat-messages')).toHaveTextContent('this curve is going to graduate')
    // (3) SAKLANAN BAKIYE EKRANDA, ve GUNCEL olandan AYRI.
    expect(screen.getByTestId('chat-stake-then')).toHaveTextContent('held 2.50% when posted')
    expect(screen.getByTestId('chat-stake-now')).toHaveTextContent('holds none now')
  })

  it('SAYFA `readChat`i DOGRU token ve DOGRU sayfa boyuyla cagirir', async () => {
    await renderTokenPage(emptyPage())
    expect(read.readChat).toHaveBeenCalledWith(TOKEN, {
      cursor: null,
      limit: read.CHAT_PAGE_SIZE,
    })
    // Sayfa boyu tablo boyundan AYRI ve oyle kalmali: mesajlar cok satirli,
    // 25 tanesi sag kolonu iki ekran uzatirdi.
    expect(read.CHAT_PAGE_SIZE).toBeLessThan(read.TABLE_PAGE_SIZE)
  })

  /**
   * ==========================================================================
   *  `loadMore` GECILIYOR -- VE GECILMEZSE EKRANDA HICBIR IZ KALMAZDI
   * ==========================================================================
   *
   * `useKeysetRows` `loadMore` olmadan `canLoadMore: false` doner ve
   * `LoadMoreFooter` HICBIR SEY cizmez -- yani "yirmi mesaji olan token ile
   * dort bin mesaji olan token AYNI gorunur". Bu dosyanin ust yorumundaki uc
   * kusurdan biri tam olarak buydu (`loadMoreTrades`/`loadMoreHolders`), ve
   * ancak tarayicida gorulmustu.
   *
   * Iddia DOM uzerinden yapiliyor: prop'un varligi degil, DUGMENIN CIZILMESI.
   */
  it('imlec varken "Older messages" dugmesi GERCEKTEN cizilir', async () => {
    await renderTokenPage(fresh({ rows: [MESSAGE], nextCursor: '42' }))
    expect(screen.getByRole('button', { name: 'Older messages' })).toBeInTheDocument()
  })

  it('imlec YOKKEN dugme cizilmez', async () => {
    await renderTokenPage(fresh({ rows: [MESSAGE], nextCursor: null }))
    expect(screen.queryByRole('button', { name: 'Older messages' })).toBeNull()
  })

  /**
   * CHAT DUSSE DE SAYFA AYAKTA. `Promise.all`in ayri bir dali oldugu icin
   * chat'in `unavailable` olmasi al-sat panelini ya da istatistikleri
   * karartmaz.
   */
  it('chat okumasi DUSTUGUNDE sayfanin geri kalani cizilmeye devam eder', async () => {
    await renderTokenPage({ ok: false, reason: 'unavailable', indexer: null })
    expect(screen.getByTestId('chat-unavailable')).toBeInTheDocument()
    // Token basligi ve al-sat yuzeyi hala orada.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(CLIMBING.name)
  })
})
