'use client'

import type { ChatMessageRow } from '@arcpad/db'
import { useCallback, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { getWebConfig } from '@/lib/addresses'
import { chatMessageText, newChatNonce } from '@/lib/chatMessage'
import { checkChatBody, CHAT_REJECTION_COPY } from '@/lib/chatPolicy'
import type { HexAddress } from '@/components/read/types'

/**
 * ==========================================================================
 *  GONDERME: IMZALA, GONDER, VE HER REDDIN KENDI CUMLESI OLSUN
 * ==========================================================================
 *
 * ISTEMCI TARAFINDAKI KONTROLLER BIR KAPI DEGIL, BIR NEZAKETTIR. Rotanin
 * kontrolleriyle AYNI fonksiyon cagriliyor (`checkChatBody`), yani iki taraf
 * ayrisamaz; ama buradaki kontrolun tek isi CUZDAN PENCERESI ACILMADAN
 * reddetmektir. Kullaniciya once imzalatip sonra "link yasak" demek, onun
 * zamanini ve guvenini bosa harcamak olurdu.
 *
 * Kim yetkilendirir sorusunun cevabi degismedi: SUNUCU. Bu dosyadaki hicbir
 * `if` atlandiginda satir yazilmaz.
 */

export type ChatPostState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * SUNUCUNUN HATA KODLARI -> KULLANICININ CUMLELERI.
 *
 * Tel uzerindeki kodlar sabittir ve arayuz onlarin metnini burada tutar. Bir
 * ham kodu ekrana basmak (`rateLimited`) kullaniciya hicbir sey anlatmaz;
 * genel bir "bir seyler ters gitti" ise DAHA KOTUDUR, cunku bu rotanin
 * reddetme sebeplerinin cogu kullanicinin DUZELTEBILECEGI seylerdir.
 */
export const CHAT_ERROR_COPY: Record<string, string> = {
  ...CHAT_REJECTION_COPY,
  badRequest: 'That message could not be sent — something in the request was malformed.',
  wrongChain: 'Your wallet signed for a different network. Switch to Arc and try again.',
  expired: 'That signature took too long to arrive. Send it again.',
  fromTheFuture: "Your device's clock is ahead of the server. Check it and try again.",
  badSignature: 'The signature did not match your wallet address.',
  unknownToken: 'This token is not indexed yet, so it has no chat.',
  notAHolder: 'You need to hold this token to post.',
  duplicateNonce: 'That exact message was already posted.',
  rateLimited: 'You are posting too quickly. Wait a minute and try again.',
  chainUnavailable: 'We could not read your balance from Arc, so the message was not posted.',
  databaseUnavailable: 'Chat storage is not answering right now.',
  requestTooLarge: 'That message is too large.',
  rejected: 'The message was refused.',
}

const FALLBACK = 'The message was not posted.'

export function chatErrorCopy(code: unknown): string {
  return typeof code === 'string' && code in CHAT_ERROR_COPY
    ? (CHAT_ERROR_COPY[code] as string)
    : FALLBACK
}

export type ChatPostResult = { readonly ok: true; readonly row: ChatMessageRow } | { readonly ok: false }

/**
 * `ChatMessageRow`u TELDEN geri kurar.
 *
 * Rota `bigint`leri DIZE olarak gonderir (JSON'da `bigint` yoktur) ve panel
 * `ChatMessageRow` cizer. Donusum TEK yerde: iki farkli yerde `BigInt(...)`
 * cagirmak, birinde `Number(...)` yazmanin kapisidir ve bu depoda o hata
 * 2^53 ustunde SESSIZDIR.
 */
function fromWire(raw: Record<string, unknown>): ChatMessageRow | null {
  const str = (k: string): string | null => (typeof raw[k] === 'string' ? (raw[k] as string) : null)
  const seq = str('messageSeq')
  const token = str('token')
  const author = str('authorAddr')
  const body = str('body')
  const balance = str('balanceTok')
  const block = str('balanceBlockNumber')
  const issued = str('issuedAt')
  const created = str('createdAt')
  if (
    seq === null ||
    token === null ||
    author === null ||
    body === null ||
    balance === null ||
    block === null ||
    issued === null ||
    created === null
  ) {
    return null
  }
  const current = raw['currentBalanceTok']
  return {
    messageSeq: BigInt(seq),
    token,
    authorAddr: author,
    body,
    balanceTok: BigInt(balance),
    balanceBlockNumber: BigInt(block),
    // Panel bu ikisini CIZMEZ; tip tam olsun diye tasiniyor. Tel bicimi
    // onlari hic gondermiyor (imza ve nonce ekranda isi olmayan seyler).
    nonceHex: '',
    signatureHex: '',
    issuedAt: new Date(issued),
    createdAt: new Date(created),
    currentBalanceTok: typeof current === 'string' ? BigInt(current) : null,
    isLaunchCreator: raw['isLaunchCreator'] === true,
  }
}

export function useChatPost(token: HexAddress, author: HexAddress | undefined) {
  const [state, setState] = useState<ChatPostState>({ kind: 'idle' })
  const { signMessageAsync } = useSignMessage()

  const send = useCallback(
    async (body: string): Promise<ChatPostResult> => {
      if (author === undefined) {
        setState({ kind: 'error', message: 'Connect a wallet to post.' })
        return { ok: false }
      }
      const verdict = checkChatBody(body)
      if (!verdict.ok) {
        // CUZDAN HIC ACILMAZ. Kullanici bir imza penceresi gorup sonra
        // reddedilmez.
        setState({ kind: 'error', message: chatErrorCopy(verdict.reason) })
        return { ok: false }
      }

      const payload = {
        chainId: getWebConfig().chain.id,
        token: token.toLowerCase(),
        author: author.toLowerCase(),
        nonce: newChatNonce(),
        // MILISANIYELI ISO, ve TAM OLARAK bu bicim: sunucu ayni dizeyi metne
        // koyar. Baska bir bicim (saniye cozunurlugu, yerel saat) imzayi
        // dusururdu.
        issuedAt: new Date().toISOString(),
        body,
      }

      setState({ kind: 'signing' })
      let signature: string
      try {
        signature = await signMessageAsync({ message: chatMessageText(payload) })
      } catch {
        // Kullanicinin cuzdanda IPTAL etmesi bir hata degildir.
        setState({ kind: 'idle' })
        return { ok: false }
      }

      setState({ kind: 'sending' })
      let response: Response
      try {
        response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, signature }),
        })
      } catch {
        setState({ kind: 'error', message: 'Could not reach the server.' })
        return { ok: false }
      }

      let doc: unknown
      try {
        doc = await response.json()
      } catch {
        doc = null
      }

      if (!response.ok) {
        const code = (doc as { error?: unknown } | null)?.error
        setState({ kind: 'error', message: chatErrorCopy(code) })
        return { ok: false }
      }

      const wire = (doc as { message?: unknown } | null)?.message
      const row = wire !== null && typeof wire === 'object' ? fromWire(wire as Record<string, unknown>) : null
      if (row === null) {
        // Sunucu 201 dedi ama govde okunamadi: mesaj YAZILDI, ekran onu
        // yenilemeyle gorecek. "Hata" demek yanlis olurdu.
        setState({ kind: 'sent' })
        return { ok: false }
      }
      setState({ kind: 'sent' })
      return { ok: true, row }
    },
    [author, signMessageAsync, token],
  )

  return { state, send, reset: useCallback(() => setState({ kind: 'idle' }), []) }
}
