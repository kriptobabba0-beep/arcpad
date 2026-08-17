'use client'

import type { ChatMessageRow } from '@arcpad/db'
import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import type { HexAddress, Page, ReadResult } from '@/components/read/types'
import { fold } from '@/components/read/result'
import { Address } from '@/components/ui/Address'
import { Button } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { CHAT_BODY_MAX_CHARS } from '@/lib/chatPolicy'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { LoadMoreFooter, type LoadMore, useKeysetRows } from './tableShell'
import { useChatPost } from './useChatPost'
import { useTokenBalance } from './useTokenBalance'
import { supplyPercent } from './walletDelta'

/**
 * ==========================================================================
 *  HOLDER-GATED CHAT PANELI (spec §7.1 -- `/token/[address]`in SAG kolonu)
 * ==========================================================================
 *
 * OKUMA VE YAZMA AYRI YOLLARDAN GELIR, VE BU EKRANDA IKISI DE GORUNUR:
 *   - satirlar bir SERVER COMPONENT'in Postgres sorgusundan (`readChat`),
 *     prop olarak asagi iner;
 *   - gonderme `/api/chat`e bir POST'tur.
 * Spec §6.3'un "okuma server component'ten, yazma API rotasindan" kurali tam
 * olarak budur ve chat onu tek ekranda tasiyan ilk ozelliktir.
 *
 * ==========================================================================
 *  GONDERI ANINDAKI BAKIYE EKRANDA -- YOKSA KOLON KIMSENIN OKUMADIGI BIR SEY
 * ==========================================================================
 *
 * `chat_messages.balance_tok` spec'te bilerek duruyor ve saklanmasinin bir
 * sebebi olmasi yetmez: OKUNMASI da gerekir, yoksa yalnizca bir denetim izi
 * olur. Her satir IKI sayi cizer:
 *
 *   "held 1.20% when posted"      <- zincirden, gonderi aninda, o blokta
 *   "holds 0.00% now"             <- `holders`tan, yani indexer'dan
 *
 * Ikisinin AYRI olmasinin urun degeri sudur: bir hesabin once pozisyon alip
 * mesaji yazmasi ve SONRA satmasi, bu panelde GORUNUR. Gecmis bir bakiyeyi
 * zincire sormak bir archive node ister, yani bu cumle o kolon olmadan
 * KURULAMAZDI.
 *
 * `null` ile `0` AYRI CIZILIR: indexer'in o cuzdan icin satiri yoksa panel
 * "not indexed" der, "%0" DEMEZ -- "bilmiyoruz" ile "sattı" ayni cumle
 * degildir.
 */

export type ChatPanelProps = {
  readonly token: HexAddress
  readonly symbol: string
  readonly chat: ReadResult<Page<ChatMessageRow>>
  readonly loadMore?: LoadMore<ChatMessageRow>
}

/** UTC, ve BILEREK yerel saat degil: sunucu ile istemcinin ayni dizeyi
 *  uretmesi gerekir, yoksa React hidrasyon uyusmazligi verir. */
function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`
}

export function ChatPanel({ token, symbol, chat, loadMore }: ChatPanelProps) {
  const page = fold(chat, {
    fresh: (data) => data,
    stale: (data) => data,
    missing: () => null,
  })

  const rows = useMemo(() => page?.rows ?? [], [page])
  const keyset = useKeysetRows(rows, page?.nextCursor ?? null, loadMore)
  const [posted, setPosted] = useState<readonly ChatMessageRow[]>([])

  /*
   * SUNUCU YENILENDIGINDE MESAJ IKI KEZ CIZILMEZ.
   *
   * `router.refresh()` sonrasinda gonderilen mesaj artik sunucunun sayfasinda
   * DA var. Yerel listeyi temizlemek yerine ELEMEK secildi: temizlemek,
   * yenileme gec dondugunde mesaji ekrandan bir an icin KAYBEDERDI ve
   * kullaniciya "gitmedi mi?" dedirtirdi.
   */
  const known = useMemo(() => new Set(keyset.rows.map((r) => r.messageSeq)), [keyset.rows])
  const optimistic = posted.filter((r) => !known.has(r.messageSeq))
  const shown = [...optimistic, ...keyset.rows]

  return (
    <section
      data-testid="chat-panel"
      aria-labelledby="chat-heading"
      className="flex flex-col rounded-card border border-border bg-surface"
    >
      <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 id="chat-heading" className="text-sm font-medium">
          Chat
        </h2>
        <p className="text-[12px] text-muted">Holders only</p>
      </header>

      <ChatComposer
        token={token}
        symbol={symbol}
        onPosted={(row) => setPosted((p) => [row, ...p])}
      />

      {page === null ? (
        <p
          role="status"
          data-testid="chat-unavailable"
          className="px-4 py-6 text-[13px] text-muted"
        >
          Chat is unavailable right now. The database that stores messages is not answering —
          prices, reserves and trading on this page read the chain directly and are unaffected.
        </p>
      ) : shown.length === 0 ? (
        <p data-testid="chat-empty" className="px-4 py-6 text-[13px] text-muted">
          No messages yet. Holders of {symbol} can start the conversation.
        </p>
      ) : (
        <ol data-testid="chat-messages" className="flex flex-col">
          {shown.map((row) => (
            <ChatMessage key={row.messageSeq.toString()} row={row} />
          ))}
        </ol>
      )}

      <LoadMoreFooter state={keyset} label="Older messages" />
    </section>
  )
}

function ChatMessage({ row }: { row: ChatMessageRow }) {
  const then = supplyPercent(row.balanceTok)
  const now = row.currentBalanceTok === null ? null : supplyPercent(row.currentBalanceTok)
  const exited = row.currentBalanceTok !== null && row.currentBalanceTok === 0n

  return (
    <li className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
        <Address value={row.authorAddr} label="Message author" />
        {row.isLaunchCreator ? <Pill tone="accent">dev</Pill> : null}
        <time dateTime={row.createdAt.toISOString()} className="tabular-nums">
          {stamp(row.createdAt)}
        </time>
      </div>

      {/*
        GOVDE DUZ METINDIR. `dangerouslySetInnerHTML` YOKTUR ve olmayacak:
        govde kullanicinin yazdigi ve IMZALADIGI dizedir, React onu kacislar.
        Link yasagi bir XSS onlemi DEGILDIR (React zaten kaciyor); tiklanabilir
        kimlik avini ve spam'i hedefler.
      */}
      <p className="whitespace-pre-wrap break-words text-[13px] text-text">{row.body}</p>

      <p className="text-[11px] text-muted" data-testid="chat-stake">
        <span data-testid="chat-stake-then">held {then}% when posted</span>
        {' · '}
        {now === null ? (
          <span data-testid="chat-stake-now">balance not indexed</span>
        ) : exited ? (
          <span data-testid="chat-stake-now" className="text-negative">
            holds none now
          </span>
        ) : (
          <span data-testid="chat-stake-now">holds {now}% now</span>
        )}
      </p>
    </li>
  )
}

/**
 * ==========================================================================
 *  YAZMA KUTUSU
 * ==========================================================================
 *
 * ZINCIRDEN OKUNAN BAKIYE BURADA BIR KAPI DEGIL, BIR ISARETTIR. Yetkiyi
 * sunucu verir; buradaki okuma yalnizca "yazacaksin ama reddedileceksin"
 * durumunu ONCEDEN gostermek icin. Bu ayrimi yazmak gerekiyor cunku aksi bir
 * okuma -- "istemci kontrol ediyor" -- bu rotanin butun tehdit modelini
 * yanlislar.
 */
function ChatComposer({
  token,
  symbol,
  onPosted,
}: {
  token: HexAddress
  symbol: string
  onPosted: (row: ChatMessageRow) => void
}) {
  const router = useRouter()
  const { status, address, wrongNetwork, switchToArc, isSwitching } = useArcNetwork()
  const connected = status === 'connected' && address !== undefined
  const balance = useTokenBalance(token, connected ? (address as HexAddress) : undefined)
  const { state, send, reset } = useChatPost(token, connected ? (address as HexAddress) : undefined)
  const [draft, setDraft] = useState('')

  const onSubmit = useCallback(async () => {
    const result = await send(draft)
    if (result.ok) {
      setDraft('')
      onPosted(result.row)
      // Sunucu bileşeni yeniden cizilsin: yerel satir yalnizca ARADAKI bosluk
      // icin var ve `ChatPanel` onu geldiginde eliyor.
      router.refresh()
    }
  }, [draft, onPosted, router, send])

  if (!connected) {
    return (
      <div className="border-b border-border px-4 py-3">
        <p className="text-[13px] text-muted">Connect a wallet that holds {symbol} to post.</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => {
            // TEK BIR CONNECTOR LISTESI: `WalletButton` onu tasiyor ve
            // `data-wallet-connect` bu yuzden bir test kancasi degil, urun
            // baglantisidir (bkz. `TradePanel`).
            const trigger = document.querySelector<HTMLElement>('[data-wallet-connect]')
            trigger?.click()
          }}
        >
          Connect wallet
        </Button>
      </div>
    )
  }

  if (wrongNetwork) {
    return (
      <div className="border-b border-border px-4 py-3">
        <p className="text-[13px] text-muted">Your wallet is on another network.</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={switchToArc}
          disabled={isSwitching}
        >
          {isSwitching ? 'Switching…' : 'Switch to Arc'}
        </Button>
      </div>
    )
  }

  /*
   * `balance === null` -> OKUMA HENUZ DONMEDI ya da DUSTU. Kutu KAPATILMAZ:
   * bir okuma arizasi yuzunden yazma yolunu kilitlemek, sunucunun zaten
   * yapacagi kontrolu istemcide TEKRARLAYIP bir de kotu tarafa dusmek olurdu.
   * Yalnizca `0` -- yani OLCULMUS bir sifir -- kutuyu kapatir.
   */
  if (balance === 0n) {
    return (
      <div className="border-b border-border px-4 py-3" data-testid="chat-not-a-holder">
        <p className="text-[13px] text-muted">
          You need to hold {symbol} to post. Buy any amount and the box opens.
        </p>
      </div>
    )
  }

  const remaining = CHAT_BODY_MAX_CHARS - [...draft].length
  const busy = state.kind === 'signing' || state.kind === 'sending'

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <label className="sr-only" htmlFor="chat-draft">
        Message
      </label>
      <textarea
        id="chat-draft"
        data-testid="chat-draft"
        rows={2}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          if (state.kind === 'error' || state.kind === 'sent') reset()
        }}
        placeholder={`Say something about ${symbol}`}
        className="w-full resize-y rounded-input border border-border bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-accent"
      />
      <div className="flex items-center justify-between gap-2">
        <p
          className={`text-[11px] tabular-nums ${remaining < 0 ? 'text-negative' : 'text-muted'}`}
          data-testid="chat-remaining"
        >
          {remaining}
        </p>
        <Button
          variant="primary"
          size="sm"
          data-testid="chat-send"
          disabled={busy || draft.trim() === ''}
          onClick={() => void onSubmit()}
        >
          {state.kind === 'signing'
            ? 'Sign in wallet…'
            : state.kind === 'sending'
              ? 'Posting…'
              : 'Post'}
        </Button>
      </div>
      {/*
        CANLI BOLGE HER ZAMAN AGACTA. Hata aninda yeni bir `role="status"`
        eklemek, bircok ekran okuyucuda hic duyurulmayan bir bolge uretir --
        ayni gerekce `LoadMoreFooter`da da yazili.
      */}
      <p role="status" data-testid="chat-error" className="text-[12px] text-negative empty:hidden">
        {state.kind === 'error' ? state.message : ''}
      </p>
      <p className="text-[11px] text-muted">
        Your wallet signs the message. Links are not allowed, and the balance you hold right now is
        recorded with the post.
      </p>
    </div>
  )
}
