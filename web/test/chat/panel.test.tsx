import type { ChatMessageRow } from '@arcpad/db'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ChatPanel } from '@/components/token/ChatPanel'
import type { Page, ReadResult } from '@/components/read/types'
import { renderWithProviders } from '../ui/harness'

/**
 * ==========================================================================
 *  PANEL: SAKLANAN BAKIYE EKRANDA MI?
 * ==========================================================================
 *
 * `chat_messages.balance_tok` spec'in ucuncu karsi-onlemi. Saklanmasinin bir
 * gerekcesi olmasi YETMEZ -- okunmuyorsa kimsenin bakmadigi bir kolondur.
 * Bu dosyanin ilk isi o kolonun ekranda oldugunu ve `holders`taki GUNCEL
 * bakiyeden AYRI cizildigini olcmek.
 *
 * Fixture'lar bilerek AYRISIYOR: gonderi anindaki bakiye ile su anki bakiye
 * hicbir satirda esit degil. Esit olsalardi, iki sayiyi da ayni kaynaktan
 * ceken bir mutant testten gecerdi.
 */

const TOKEN = '0x085c926e24ed64bb045e67d26d9e76e5730c21b3' as const
const TOTAL = 10n ** 27n

function message(overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    messageSeq: 1n,
    token: TOKEN,
    authorAddr: '0x00000000000000000000000000000000000a11ce',
    body: 'gm',
    // %1,20 -> gonderi aninda
    balanceTok: (TOTAL * 120n) / 10_000n,
    balanceBlockNumber: 55_870_261n,
    nonceHex: `0x${'ab'.repeat(32)}`,
    signatureHex: `0x${'cd'.repeat(65)}`,
    issuedAt: new Date('2026-08-10T00:00:00.000Z'),
    createdAt: new Date('2026-08-10T00:00:01.000Z'),
    // %0,30 -> su anda
    currentBalanceTok: (TOTAL * 30n) / 10_000n,
    isLaunchCreator: false,
    ...overrides,
  }
}

const FRESH = { stale: false, lastBlock: 55_900_000n, updatedAt: new Date(), blocksBehind: 0n }

function ok(
  rows: readonly ChatMessageRow[],
  nextCursor: string | null = null,
): ReadResult<Page<ChatMessageRow>> {
  return { ok: true, stale: false, data: { rows, nextCursor }, indexer: FRESH as never }
}

const DOWN: ReadResult<Page<ChatMessageRow>> = {
  ok: false,
  reason: 'unavailable',
  indexer: null,
}

describe('gonderi anindaki bakiye EKRANDA', () => {
  it('IKI sayi cizilir ve AYRIDIRLAR', () => {
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([message()])} />)
    expect(screen.getByTestId('chat-stake-then')).toHaveTextContent('held 1.20% when posted')
    expect(screen.getByTestId('chat-stake-now')).toHaveTextContent('holds 0.30% now')
  })

  /**
   * ============ SATTI: PANELIN VAR OLMA SEBEBI OLAN DURUM ============
   *
   * Pozisyon alip yazip SONRA satmak, holder-gate'in tek basina
   * durduramadigi seydir -- kapi bir ANDIR, pozisyon degildir. Gonderi
   * anindaki bakiye SAKLANDIGI icin bu cumle kurulabiliyor; gecmis bir
   * bakiyeyi zincire sormak bir archive node isterdi.
   */
  it('bakiyesi SIFIRA dusmus yazar ayri cizilir', () => {
    renderWithProviders(
      <ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([message({ currentBalanceTok: 0n })])} />,
    )
    expect(screen.getByTestId('chat-stake-now')).toHaveTextContent('holds none now')
    // Gonderi anindaki sayi HALA orada: mesaj bir zamanlar agirligi olan
    // birinden geldi ve bu bilgi kaybolmuyor.
    expect(screen.getByTestId('chat-stake-then')).toHaveTextContent('held 1.20% when posted')
  })

  /**
   * `null` ILE `0` AYRI EKRANLAR. `COALESCE(h.balance_tok, 0)` yazan bir
   * mutant bu testi olduruur: "indexer bilmiyor" ile "satti" ayni cumle
   * degildir ve ikincisi bir suclama.
   */
  it('indexer satiri YOKSA "not indexed" der, %0 DEMEZ', () => {
    renderWithProviders(
      <ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([message({ currentBalanceTok: null })])} />,
    )
    expect(screen.getByTestId('chat-stake-now')).toHaveTextContent('balance not indexed')
    expect(screen.getByTestId('chat-stake-now')).not.toHaveTextContent('0.00%')
    expect(screen.getByTestId('chat-stake-now')).not.toHaveTextContent('none')
  })

  it('YUZDE bigint aritmetigiyle -- iki buyuk bakiye ayni yuzdeyi vermez', () => {
    const a = message({ messageSeq: 2n, balanceTok: (TOTAL * 1234n) / 100_000n, body: 'a' })
    const b = message({ messageSeq: 1n, balanceTok: (TOTAL * 1235n) / 100_000n, body: 'b' })
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([a, b])} />)
    const stakes = screen.getAllByTestId('chat-stake-then').map((n) => n.textContent)
    expect(stakes).toEqual(['held 1.23% when posted', 'held 1.23% when posted'])
    // ...ve 1e27 uzerinde bir `Number` donusumu bu iki degeri ESITLERDI.
    expect(a.balanceTok).not.toBe(b.balanceTok)
  })

  it('launch creator `dev` rozetiyle cizilir', () => {
    renderWithProviders(
      <ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([message({ isLaunchCreator: true })])} />,
    )
    expect(screen.getByText('dev')).toBeInTheDocument()
  })
})

describe('govde DUZ METIN olarak cizilir', () => {
  it('HTML calistirilmaz', () => {
    const body = '<img src=x onerror="alert(1)"> <b>bold?</b>'
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([message({ body })])} />)
    const list = screen.getByTestId('chat-messages')
    // Metin OLDUGU GIBI gorunur...
    expect(list).toHaveTextContent('<img src=x onerror="alert(1)"> <b>bold?</b>')
    // ...ve DOM'a hicbir element girmemistir.
    expect(within(list).queryByRole('img')).toBeNull()
    expect(list.querySelector('img')).toBeNull()
    expect(list.querySelector('b')).toBeNull()
  })
})

describe('veritabani dustugunde', () => {
  it('panel "unavailable" der ve sayfanin geri kalanini karartmaz', () => {
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={DOWN} />)
    expect(screen.getByTestId('chat-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-messages')).toBeNull()
  })

  it('bos liste "unavailable" DEGIL "no messages"', () => {
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([])} />)
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-unavailable')).toBeNull()
  })
})

describe('sayfalama', () => {
  it('`loadMore` VERILMEZSE dugme HIC cizilmez', () => {
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([message()], '5')} />)
    // Hicbir sey yapmayan bir "Older messages" dugmesi, olmayandan kotudur.
    expect(screen.queryByRole('button', { name: 'Older messages' })).toBeNull()
  })

  it('`loadMore` verildiginde imlecle cagrilir ve satirlar EKLENIR', async () => {
    const older = message({ messageSeq: 1n, body: 'older one' })
    const loadMore = async () => ok([older], null)
    renderWithProviders(
      <ChatPanel
        token={TOKEN}
        symbol="SMOKE"
        chat={ok([message({ messageSeq: 9n, body: 'newest' })], '9')}
        loadMore={loadMore}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Older messages' }))
    await waitFor(() => expect(screen.getByTestId('chat-messages')).toHaveTextContent('older one'))
    expect(screen.getByTestId('chat-messages')).toHaveTextContent('newest')
  })
})

describe('yazma kutusu', () => {
  it('cuzdan BAGLI DEGILSE kutu degil bir baglanma cagrisi cizilir', () => {
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([])} />, {
      connected: false,
    })
    expect(screen.queryByTestId('chat-draft')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument()
  })

  it('LINK iceren bir taslak CUZDANI HIC ACMADAN reddedilir', async () => {
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([])} />, {
      connected: true,
    })
    const box = await screen.findByTestId('chat-draft')
    await userEvent.type(box, 'buy at evil.com')
    await userEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() =>
      expect(screen.getByTestId('chat-error')).toHaveTextContent(
        'Links are not allowed in token chat.',
      ),
    )
    // ISTEMCI KONTROLU BIR KAPI DEGIL BIR NEZAKETTIR: sunucu ayni kontrolu
    // ayni fonksiyonla yapar. Buradaki tek kazanc, kullanicinin bir imza
    // penceresi gorup SONRA reddedilmemesi.
  })

  it('kalan karakter sayaci KOD NOKTASI sayar', async () => {
    renderWithProviders(<ChatPanel token={TOKEN} symbol="SMOKE" chat={ok([])} />, {
      connected: true,
    })
    const box = await screen.findByTestId('chat-draft')
    await userEvent.type(box, 'ab')
    expect(screen.getByTestId('chat-remaining')).toHaveTextContent('498')
  })
})
