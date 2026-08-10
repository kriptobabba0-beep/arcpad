'use client'

import {
  type CurveProfile,
  formatTokenAmount,
  netProceedsOf,
  planBuyExactQuoteIn,
  planSellExactTokensIn,
  TradePlanError,
} from '@arcpad/shared/browser'
import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import type { HexAddress } from '@/components/read/types'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Money } from '@/components/ui/Money'
import { Tabs } from '@/components/ui/Tabs'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { AmountInput } from './AmountInput'
import { parseAmount } from './tradeModel'
import { useCurveState } from './useCurveState'
import { useOrderPost } from './useOrderPost'

/**
 * ==========================================================================
 *  LIMIT SEKMESI -- VE ONCE, EKRANDAKI CUMLENIN NEDEN O CUMLE OLDUGU
 * ==========================================================================
 *
 * Bir limit emri "sonra, ben orada olmasam bile" sozudur. arcpad O SOZU
 * VEREMEZ, ve bu bir tasarim tercihi degil OLCULMUS bir sinirdir:
 * `keeper/test/localchain/custodyProof.ts` canli kontratlara karsi (Arc
 * fork'u, 21/21) sunu gosterdi -- curve alimlari `msg.sender`i kredilendirir,
 * curve satimlari `msg.sender`den ceker ve ONA oder, router'in `payer`i
 * `msg.sender`den yazilir ve BIR PARAMETRE DEGILDIR. Kontratlar donmus
 * oldugu icin bir care de yok.
 *
 * Yani bu panel bir emri BASKASINA yaptirmaz. Yaptigi sey:
 *
 *   VERDIGI SOZ      : bu emir tetiklendiginde sana soyleriz, ve o an
 *                      basacagin islem SENIN SINIRINI calldata'da tasir --
 *                      yani belirledigin fiyattan DAHA KOTUSUNE dolamaz.
 *                      Fiyat geri gitmisse zincir islemi REDDEDER ve paran
 *                      sende kalir.
 *   VERMEDIGI SOZ    : cuzdanin uzaktayken emir DOLMAZ.
 *
 * Ikisi de ekranda YAZILI. Bir emrin sessizce dolmamasi, soylenmediginde bir
 * urun yalanidir.
 *
 * ==========================================================================
 *  FIYAT ALANI YOKTUR. IKI MIKTAR VARDIR.
 * ==========================================================================
 *
 * "Tetik fiyati" bir bolme demektir, bolme bir yuvarlama demektir, ve
 * yuvarlama BURADA kullanicinin gordugu sayi ile zincire giden sayiyi
 * ayirir -- bu deponun `useQuote` yasaginin (spec §7.2) gerekcesinin ta
 * kendisi.
 *
 * Onun yerine kullanici IKI MIKTAR yazar ve ikincisi ZINCIRIN ARGUMANIDIR:
 *
 *   alim : "5 USDC harca"  +  "en az 1.000.000 TOKEN al"  -> `buyExactQuoteIn(min)`
 *   satim: "1.000.000 TOKEN sat" + "en az 6 USDC al"      -> `sellExactTokensIn(x, min)`
 *
 * Yazilan sey imzalanan seydir, imzalanan sey saklanan seydir, saklanan sey
 * calldata'ya giden seydir. Arada tek bir donusum yok. Ima edilen fiyat
 * yalnizca GOSTERILIR ve hicbir sey onu geri okumaz.
 */

export type LimitPanelProps = {
  readonly token: HexAddress
  readonly curve: HexAddress
  readonly symbol: string
  readonly profile: CurveProfile
}

const SIDES = [
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
] as const

/** Varsayilan sure. Tavan otuz gun (`ORDER_MAX_TTL_SECONDS`); bir hafta makul. */
const DEFAULT_TTL_DAYS = 7
const TTL_CHOICES = [1, 7, 30] as const

export function LimitPanel({ token, curve, symbol, profile }: LimitPanelProps) {
  const router = useRouter()
  const network = useArcNetwork()
  const owner = network.address as HexAddress | undefined
  const { state, fees } = useCurveState(curve)
  const post = useOrderPost(owner)

  const [isBuy, setIsBuy] = useState(true)
  const [amountText, setAmountText] = useState('')
  const [minOutText, setMinOutText] = useState('')
  const [ttlDays, setTtlDays] = useState<number>(DEFAULT_TTL_DAYS)

  const amount = parseAmount(amountText)
  const minOut = parseAmount(minOutText)
  const amountValue = amount.ok ? amount.value : null
  const minOutValue = minOut.ok ? minOut.value : null

  /**
   * SIMDI NE VERIRDI. Bir kota DEGIL bir REFERANS: kullanicinin sinirini
   * nereye koyacagini bilmesi icin. Ayni saf fonksiyonlardan gelir
   * (`packages/shared`), yani ekrandaki sayi ile keeper'in tetik predikati
   * AYNI aritmetigi kullanir -- ikisinin ayrisabilecegi bir yol yok.
   */
  const nowGives = useMemo((): { out: bigint } | { error: string } | null => {
    if (state === undefined || fees === undefined || amountValue === null || amountValue === 0n) {
      return null
    }
    try {
      if (isBuy) return { out: planBuyExactQuoteIn(state, profile, fees, amountValue, 0).tokens }
      return { out: netProceedsOf(planSellExactTokensIn(state, profile, fees, amountValue, 0)) }
    } catch (error) {
      if (error instanceof TradePlanError) return { error: error.errorName }
      throw error
    }
  }, [state, fees, profile, amountValue, isBuy])

  const submit = useCallback(async () => {
    if (amountValue === null || minOutValue === null) return
    if (amountValue === 0n || minOutValue === 0n) return
    const ok = await post.place({
      token,
      isBuy,
      amount: amountValue,
      minOut: minOutValue,
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    })
    if (ok) {
      setAmountText('')
      setMinOutText('')
      // Sunucu bileseni yeniden cizilir; yeni emir "Orders" sekmesinde gorunur.
      router.refresh()
    }
  }, [amountValue, minOutValue, post, token, isBuy, ttlDays, router])

  const busy = post.state.kind === 'signing' || post.state.kind === 'sending'
  const connected = network.status === 'connected' && owner !== undefined
  const ready = amountValue !== null && amountValue > 0n && minOutValue !== null && minOutValue > 0n

  const amountUnit = isBuy ? 'USDC' : symbol
  const minOutUnit = isBuy ? symbol : 'USDC'

  return (
    <Card className="flex flex-col gap-3 px-4 py-4" data-testid="limit-panel">
      <Tabs
        items={SIDES.map((s) => ({ id: s.id, label: s.label }))}
        value={isBuy ? 'buy' : 'sell'}
        onChange={(next) => {
          setIsBuy(next === 'buy')
          // Birimi degisen alanlarda eski METNI birakmak, bir USDC tutarini
          // sessizce bir TOKEN tutarina cevirir. `TradePanel` ile ayni kural.
          setAmountText('')
          setMinOutText('')
        }}
        label="Order side"
        idBase="limit-side"
      />

      {/*
        ====================================================================
         URUNUN SOYLEMEK ZORUNDA OLDUGU IKI CUMLE
        ====================================================================
        Birincisi ne YAPMADIGIMIZ, ikincisi ne YAPTIGIMIZ. Sirasi bu:
        kullanici once neyin GARANTI OLMADIGINI bilmeli.
      */}
      <p className="text-[12px] leading-snug text-muted" data-testid="limit-custody-note">
        arcpad never holds your funds and cannot trade for you. This order watches the price and
        tells you the moment it can fill — the fill is one transaction you sign yourself. If your
        wallet is away when the price crosses, the order does not fill.
      </p>
      <p className="text-[12px] leading-snug text-muted" data-testid="limit-guarantee-note">
        What it does guarantee: the transaction carries the minimum below as its on-chain limit, so
        it can never fill for less. If the price has moved back, the chain refuses it and you keep
        your funds.
      </p>

      <AmountInput
        label={isBuy ? 'Amount to spend' : 'Tokens to sell'}
        unit={amountUnit}
        value={amountText}
        onChange={setAmountText}
        {...(amount.ok || amount.reason === null ? {} : { error: amount.reason })}
      />

      <AmountInput
        label={isBuy ? 'Only if I receive at least' : 'Only if I receive at least'}
        unit={minOutUnit}
        value={minOutText}
        onChange={setMinOutText}
        {...(minOut.ok || minOut.reason === null ? {} : { error: minOut.reason })}
      />

      {nowGives !== null ? (
        <p className="text-[12px] text-muted" data-testid="limit-reference">
          {'error' in nowGives ? (
            <>Right now the curve cannot fill that amount ({nowGives.error}).</>
          ) : (
            <>
              Right now this would give you{' '}
              <span className="tabular-nums">
                {isBuy ? (
                  `${formatTokenAmount(nowGives.out)} ${symbol}`
                ) : (
                  <Money native={nowGives.out} rounding="down" unit />
                )}
              </span>
              .
            </>
          )}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted">Expires in</span>
        {TTL_CHOICES.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => {
              setTtlDays(days)
            }}
            aria-pressed={ttlDays === days}
            className={`rounded-full px-3 py-1 text-[12px] ${
              ttlDays === days ? 'bg-accent text-bg' : 'border border-border text-muted'
            }`}
            data-testid={`limit-ttl-${days}`}
          >
            {days}d
          </button>
        ))}
      </div>

      <Button
        variant="primary"
        size="lg"
        disabled={!connected || network.wrongNetwork || !ready || busy}
        onClick={() => {
          void submit()
        }}
        data-testid="limit-submit"
      >
        {!connected
          ? 'Connect a wallet'
          : network.wrongNetwork
            ? 'Switch to Arc'
            : post.state.kind === 'signing'
              ? 'Sign in wallet…'
              : post.state.kind === 'sending'
                ? 'Placing…'
                : 'Place order'}
      </Button>

      {/*
        CANLI BOLGE HER ZAMAN AGACTA. Hata anında bir `role="status"` EKLEMEK,
        cogu ekran okuyucuda duyurulmaz -- `ChatPanel` ile ayni desen.
      */}
      <p
        role="status"
        className="text-[12px] leading-snug text-negative empty:hidden"
        data-testid="limit-error"
      >
        {post.state.kind === 'error' ? post.state.message : ''}
      </p>
    </Card>
  )
}
