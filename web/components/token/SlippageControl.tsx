'use client'

import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { cx } from '@/components/ui/cx'
import { formatSlipBps } from './tradeModel'

/** `0.5% · 1% · 3%`. Varsayilan `%1`. */
export const SLIPPAGE_PRESETS_BPS: readonly number[] = [50, 100, 300]
export const DEFAULT_SLIP_BPS = 100
/** Uzerinde uyarilir. Planlayicinin ust siniri ayrica `10_000`'dir. */
export const HIGH_SLIP_BPS = 500

export type SlippageControlProps = {
  readonly value: number
  readonly onChange: (bps: number) => void
}

/**
 * SLIPAJ, BAYAT KOTAYA KARSI TEK GERCEK KORUMA.
 *
 * Rezervler 2000 ms'de bir yenileniyor ve Arc'in blok suresi ~350 ms; yani
 * kullanicinin gordugu kota imzaladigi anda birkac blok eskimis olabilir.
 * Onu koruyan sey yenileme sikligi DEGIL, zincire giden `minTokensOut` /
 * `maxQuoteIn` / `minQuoteOut` argumanidir -- bu yuzden bu kontrol paneldeki
 * en gorunur ikinci sey ve varsayilani gizli degil yazili.
 *
 * Ozel deger BPS'e cevrilirken TAM SAYIYA yuvarlanir: planlayici
 * `slipBps`'in tam sayi olmasini sart kosar (`assertSlip`) ve `0.15%` gibi bir
 * girdi aksi halde bir `RangeError` ile paneli komple dusururdu.
 */
export function SlippageControl({ value, onChange }: SlippageControlProps) {
  const id = useId()
  const [custom, setCustom] = useState('')
  const isPreset = SLIPPAGE_PRESETS_BPS.includes(value)

  return (
    <div className="flex flex-col gap-1.5" data-testid="slippage-control">
      <div className="flex items-center justify-between">
        <span id={id} className="text-[13px] font-medium text-muted">
          Slippage tolerance
        </span>
        <span className="text-[13px] tabular-nums" data-testid="slippage-value">
          {formatSlipBps(value)}
        </span>
      </div>

      <div className="flex items-center gap-1.5" role="group" aria-labelledby={id}>
        {SLIPPAGE_PRESETS_BPS.map((bps) => (
          <Button
            key={bps}
            size="sm"
            pill
            variant={bps === value ? 'primary' : 'ghost'}
            aria-pressed={bps === value}
            data-testid={`slippage-${bps}`}
            onClick={() => {
              setCustom('')
              onChange(bps)
            }}
          >
            {formatSlipBps(bps)}
          </Button>
        ))}

        <label className="sr-only" htmlFor={`${id}-custom`}>
          Custom slippage tolerance, percent
        </label>
        <input
          id={`${id}-custom`}
          value={isPreset ? custom : custom || formatSlipBps(value).replace('%', '')}
          onChange={(event) => {
            const next = event.target.value
            setCustom(next)
            const percent = Number(next)
            if (!Number.isFinite(percent) || percent < 0 || percent > 100) return
            onChange(Math.round(percent * 100))
          }}
          inputMode="decimal"
          autoComplete="off"
          placeholder="Custom"
          className={cx(
            'h-8 w-20 rounded-pill border border-border bg-surface-2 px-3',
            'text-[13px] tabular-nums text-text outline-none',
            'placeholder:text-muted focus:border-white/25',
          )}
        />
      </div>

      {value >= HIGH_SLIP_BPS ? (
        <p role="status" className="text-[12px] leading-snug text-negative">
          A tolerance this wide lets the trade settle far from the quote you can see.
        </p>
      ) : null}
    </div>
  )
}
