'use client'

import type { ReactNode } from 'react'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import { UsdcMark } from '@/components/ui/UsdcMark'

/**
 * ============================================================================
 *  ISLEM PANELININ GORSEL PARCALARI
 * ============================================================================
 *
 * Hicbiri karar vermez: hepsi kendisine verilen seyi cizer. Panelin kendisi
 * (`TradePanel`) kota, plan, onay ve gonderme mantigini tasimaya devam ediyor
 * -- bu dosya yalnizca o mantigin GORUNTUSU.
 *
 * Ayrimin sebebi: islem yuzeyi bu urundeki en yuksek riskli kod ve bir
 * yeniden tasarim onun icine girmemeli. Renk ve yerlesim degistiginde
 * `tradeModel.ts` dokunulmamis kalir.
 */

/**
 * TUTAR KUTUSU: baslik, buyuk sayi, ve token hapi.
 *
 * Referans tasarimda tutar kendi yuzeyinde durur ve token hapi onun saginda.
 * Hap SUSLEME DEGIL: bir kullanicinin "neyi aliyorum" sorusuna verilen cevap
 * o hapta, ve gorsel + ticker birlikte oldugunda o cevap OKUNMADAN anlasilir.
 */
export function AmountCard({
  title,
  token,
  symbol,
  imageUrl,
  children,
  converse,
}: {
  /** "Buy CHWDR" / "Sell CHWDR". */
  title: string
  token: string
  symbol: string
  imageUrl?: string | null | undefined
  /** Tutar alani. */
  children: ReactNode
  /** Altindaki karsit tutar satiri -- alimda "su kadar token alirsin". */
  converse?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-card bg-surface-2 px-4 py-3.5" data-testid="amount-card">
      <span className="text-[13px] text-muted">{title}</span>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-pill bg-white/8 py-1.5 pl-1.5 pr-3">
          <TokenArtwork address={token} uri={imageUrl ?? null} size={24} symbol={symbol} />
          <span className="text-[14px] font-medium">{symbol}</span>
        </span>
      </div>
      {converse === undefined ? null : (
        <div className="text-[13px] text-muted tabular-nums">{converse}</div>
      )}
    </div>
  )
}

/**
 * "Pay with" / "Receive" satiri.
 *
 * Referansta bir ag secici; burada TEK bir varlik var ve o USDC. Yine de bir
 * satir olarak duruyor cunku sorusu gecerli: "neyle odeyecegim". Cevabin tek
 * olmasi, sorunun sorulmadigi anlamina gelmez -- ve Arc'ta bu cevap sasirtici
 * oldugu icin (gaz varligi USDC'nin KENDISI) yazili olmasi daha da onemli.
 */
export function AssetRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between rounded-card bg-surface-2 px-4 py-3">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="inline-flex items-center gap-2 rounded-pill bg-white/8 py-1.5 pl-2 pr-3">
        <UsdcMark size={18} withLabel={false} />
        <span className="text-[14px] font-medium">USDC</span>
      </span>
    </div>
  )
}

/** `You receive` / `You pay` gibi tek satirlik bir ozet. */
export function SummaryRow({
  label,
  value,
  testId,
}: {
  label: string
  value: ReactNode
  testId?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]" data-testid={testId}>
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

/**
 * "Details" ayirici -- ve KATLANABILIR OLMASI bir tercih degil bir gereklilik.
 *
 * Panelde gosterilecek dogru bilgi cok: ucretler, fiyat etkisi, en kotu
 * durumda alinacak miktar, gaz payi, bakiye. Hepsi AYNI ANDA gorunurse
 * kullanici hicbirini okumaz ve panel bir duvar olur. `<details>` ile
 * KAPALI baslar; acan biri hepsini gorur.
 *
 * NATIF `<details>`, JS'li bir acilir kutu DEGIL: klavyeyle calisir, ekran
 * okuyucuda dogru duyurulur ve JS gelmeden once de acilir.
 */
export function DetailsSection({ children }: { children: ReactNode }) {
  return (
    <details className="group" data-testid="trade-details">
      <summary className="flex cursor-pointer list-none items-center justify-center gap-2 text-[13px] text-muted transition-colors hover:text-text">
        <span className="h-px flex-1 bg-border" />
        Details
        <span aria-hidden="true" className="transition-transform group-open:rotate-180">
          ⌄
        </span>
        <span className="h-px flex-1 bg-border" />
      </summary>
      <div className="flex flex-col gap-2 pt-3">{children}</div>
    </details>
  )
}
