'use client'

import { useCallback, useState } from 'react'
import { useSignMessage } from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import { getWebConfig } from '@/lib/addresses'
import {
  newOrderNonce,
  orderPlaceText,
  orderResolveText,
  type OrderPlacePayload,
  type OrderResolvePayload,
} from '@/lib/limitOrder'

/**
 * ==========================================================================
 *  IMZALA, SONRA GONDER -- `useChatPost` ILE AYNI DEVLET MAKINESI
 * ==========================================================================
 *
 * Ayni sekil bilerek: `idle -> signing -> sending -> sent | error`, kullanici
 * IPTALI BIR HATA DEGILDIR (`idle`e doner), ve tel hatalari bir tabloda
 * cumleye cevrilir. Iki ekranin ayni akisi iki farkli sekilde yasamasi, bu
 * depoda cok kez odenen "ayni olgunun iki kopyasi" bedeliydi.
 *
 * TEK GERCEK FARK, VE PARA ORADA: **CUZDAN PENCERESI ACILMADAN ONCE HICBIR
 * SEY GONDERILMEZ**, ve imzalanan metin kullanicinin ekranda GORDUGU IKI
 * SAYIYI birimleriyle birlikte tasir (`spend_wei` / `min_out_tok`). Bir chat
 * mesajinda yanlis imzalanan sey bir cumledir; burada bir taahhuttur.
 */

export type OrderPostState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * TEL KODU -> CUMLE. Anahtarlar iki rotanin `fail(...)` cagrilarindan gelir.
 *
 * Bir kod eksik kalirsa `orderErrorCopy` genel bir cumleye duser -- sessiz bir
 * bos dize DEGIL, cunku bos bir hata satiri "gonderildi" gibi okunur.
 */
export const ORDER_ERROR_COPY: Readonly<Record<string, string>> = {
  badRequest: 'The order was malformed and was not placed.',
  badAmount: 'The amount must be a whole number of base units.',
  badMinOut: 'The minimum you receive must be a whole number of base units.',
  wrongChain: 'Your wallet is on the wrong network.',
  expired: 'The signature took too long to arrive. Please sign again.',
  fromTheFuture: "Your computer's clock is ahead of ours. Check the time and sign again.",
  tooSoon: 'An order must last at least five minutes.',
  tooFar: 'An order can last at most thirty days.',
  badSignature: 'That signature does not belong to the connected wallet.',
  unknownToken: 'This token is not indexed yet, so an order cannot be attached to it.',
  rateLimited: 'You are placing orders too quickly. Try again in a minute.',
  tooManyOpen: 'You already have the maximum number of open orders on this token.',
  duplicateNonce: 'That order was already placed.',
  notLive: 'That order is already closed.',
  unknownOrder: 'That order does not exist, or it is not yours.',
  receiptRejected: 'We could not verify that transaction as a fill of this order.',
  chainUnavailable: 'Arc is unreachable, so the fill could not be verified. Try again shortly.',
  databaseUnavailable: 'Our database is unavailable. Try again shortly.',
  requestTooLarge: 'The request was too large.',
  rejected: 'The order was refused by a database rule.',
}

export function orderErrorCopy(code: string | undefined): string {
  if (code === undefined) return 'The order was not placed.'
  return ORDER_ERROR_COPY[code] ?? 'The order was not placed.'
}

export type PlaceInput = {
  readonly token: HexAddress
  readonly isBuy: boolean
  /** ALIMDA `msg.value` (wei), SATIMDA `tokensIn` (tok). */
  readonly amount: bigint
  /** ALIMDA `minTokensOut`, SATIMDA `minQuoteOut`. Zincirin argumani. */
  readonly minOut: bigint
  readonly expiresAt: Date
}

export type OrderPostHandle = {
  readonly state: OrderPostState
  readonly place: (input: PlaceInput) => Promise<boolean>
  readonly resolve: (input: {
    readonly token: HexAddress
    readonly orderSeq: string
    readonly intent: 'cancel' | 'filled'
    readonly txHash?: string
  }) => Promise<boolean>
  readonly reset: () => void
}

export function useOrderPost(owner: HexAddress | undefined): OrderPostHandle {
  const { signMessageAsync } = useSignMessage()
  const [state, setState] = useState<OrderPostState>({ kind: 'idle' })

  const send = useCallback(
    async (url: string, text: string, body: Record<string, unknown>): Promise<boolean> => {
      setState({ kind: 'signing' })
      let signature: string
      try {
        signature = await signMessageAsync({ message: text })
      } catch {
        // KULLANICI REDDI BIR HATA DEGILDIR. Kirmizi bir kutu, kullanicinin
        // bilerek verdigi karari ona bir ariza olarak gosterirdi.
        setState({ kind: 'idle' })
        return false
      }

      setState({ kind: 'sending' })
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, signature }),
        })
      } catch {
        setState({ kind: 'error', message: 'Could not reach the server.' })
        return false
      }
      if (!response.ok) {
        let code: string | undefined
        try {
          code = ((await response.json()) as { error?: string }).error
        } catch {
          code = undefined
        }
        setState({ kind: 'error', message: orderErrorCopy(code) })
        return false
      }
      setState({ kind: 'sent' })
      return true
    },
    [signMessageAsync],
  )

  const place = useCallback(
    async (input: PlaceInput): Promise<boolean> => {
      if (owner === undefined) {
        setState({ kind: 'error', message: 'Connect a wallet to place an order.' })
        return false
      }
      const payload: OrderPlacePayload = {
        chainId: getWebConfig().chain.id,
        token: input.token.toLowerCase(),
        owner: owner.toLowerCase(),
        isBuy: input.isBuy,
        // ONDALIK DIZE, `bigint` DEGIL: imzalanan metin ile gonderilen alan
        // AYNI dize olmali. `JSON.stringify` bir `bigint`i zaten atar; onu
        // burada cevirmek, iki tarafta iki farkli bicimlendirme riskini de
        // kapatir.
        amount: input.amount.toString(),
        minOut: input.minOut.toString(),
        expiresAt: input.expiresAt.toISOString(),
        nonce: newOrderNonce(),
        issuedAt: new Date().toISOString(),
      }
      return send('/api/orders', orderPlaceText(payload), payload)
    },
    [owner, send],
  )

  const resolve = useCallback(
    async (input: {
      token: HexAddress
      orderSeq: string
      intent: 'cancel' | 'filled'
      txHash?: string
    }): Promise<boolean> => {
      if (owner === undefined) {
        setState({ kind: 'error', message: 'Connect a wallet first.' })
        return false
      }
      const payload: OrderResolvePayload = {
        chainId: getWebConfig().chain.id,
        token: input.token.toLowerCase(),
        owner: owner.toLowerCase(),
        orderSeq: input.orderSeq,
        intent: input.intent,
        txHash: input.txHash ?? '',
        issuedAt: new Date().toISOString(),
      }
      return send('/api/orders/resolve', orderResolveText(payload), payload)
    },
    [owner, send],
  )

  const reset = useCallback(() => {
    setState({ kind: 'idle' })
  }, [])

  return { state, place, resolve, reset }
}
