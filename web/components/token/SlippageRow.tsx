'use client'

import { useState } from 'react'
import { InfoTip } from '@/components/ui/InfoTip'
import { formatSlipBps } from './tradeModel'

/**
 * ============================================================================
 *  MAX SLIPPAGE -- TEK SATIR, "AUTO" ILE
 * ============================================================================
 *
 * Onceki hal uc hap ve bir "Custom" kutusuydu: dort kontrol, panelin en genis
 * satiri, ve kullanicilarin %99'unun hic dokunmadigi bir karar. Referans
 * tasarim onu tek bir satira indiriyor -- "Auto 2.5%" ve bir kalem -- ve
 * dogrusu da bu: varsayilan GORUNUR olmali, degistirmek ise MUMKUN.
 *
 * ============ "AUTO" NE DEMEK, VE NE DEMEK DEGIL ============
 *
 * Auto, `DEFAULT_SLIP_BPS`i kullanir. Piyasa kosuluna gore DEGISEN bir sey
 * DEGILDIR ve oyleymis gibi sunulmaz: rozet yalnizca "bu degeri sen
 * secmedin" der. Uydurulmus bir "akilli slipaj", kullaniciya olcmedigimiz bir
 * zeka atfetmek olurdu.
 *
 * SLIPAJ BAYAT KOTAYA KARSI TEK GERCEK KORUMA. Rezervler iki saniyede bir
 * yenilenir ve Arc'in blok suresi ~0.52 sn; kullanicinin gordugu kota
 * imzaladigi anda birkac blok eskimis olabilir. Onu koruyan sey yenileme
 * sikligi degil, zincire giden `minTokensOut` / `maxQuoteIn` / `minQuoteOut`
 * argumanidir.
 */
export const DEFAULT_SLIP_BPS = 100
/** Uzerinde uyarilir. Planlayicinin ust siniri ayrica `10_000`. */
export const HIGH_SLIP_BPS = 500

export function SlippageRow({
  value,
  auto,
  onChange,
}: {
  value: number
  /** Kullanici hic dokunmadi mi. */
  auto: boolean
  onChange: (bps: number, auto: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  return (
    <div className="flex flex-col gap-1.5" data-testid="slippage-row">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
          Max slippage
          <InfoTip label="What is max slippage?">
            The furthest the price may move against you before the trade is refused. It is enforced
            on chain, not by this page.
          </InfoTip>
        </span>

        {editing ? (
          <span className="inline-flex items-center gap-1.5">
            <label className="sr-only" htmlFor="slippage-custom">
              Max slippage, percent
            </label>
            <input
              id="slippage-custom"
              autoFocus
              value={text}
              onChange={(event) => {
                const next = event.target.value
                setText(next)
                const percent = Number(next)
                if (!Number.isFinite(percent) || percent < 0 || percent > 100) return
                // TAM SAYIYA yuvarlanir: planlayici `slipBps`in tam sayi
                // olmasini sart kosar (`assertSlip`) ve `0.15%` gibi bir girdi
                // aksi halde paneli komple dusururdu.
                onChange(Math.round(percent * 100), false)
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') setEditing(false)
              }}
              inputMode="decimal"
              autoComplete="off"
              placeholder="2.5"
              className="h-7 w-16 rounded-pill border border-border bg-surface-2 px-2.5 text-right text-[13px] tabular-nums outline-none focus:border-white/25"
            />
            <span className="text-[13px] text-muted">%</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            {auto ? (
              <span className="rounded-pill bg-white/8 px-2 py-0.5 text-[11px] leading-none text-muted">
                Auto
              </span>
            ) : null}
            <span className="text-[13px] tabular-nums" data-testid="slippage-value">
              {formatSlipBps(value)}
            </span>
            <button
              type="button"
              onClick={() => {
                setText((value / 100).toString())
                setEditing(true)
              }}
              aria-label="Edit max slippage"
              className="text-muted transition-colors hover:text-text"
              data-testid="slippage-edit"
            >
              <span aria-hidden="true">✎</span>
            </button>
          </span>
        )}
      </div>

      {value >= HIGH_SLIP_BPS ? (
        <p role="status" className="text-[12px] leading-snug text-negative">
          A tolerance this wide lets the trade settle far from the quote you can see.
        </p>
      ) : null}
    </div>
  )
}
