'use client'

import { useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string
  /** Etiketi gorsel olarak gizler ama ekran okuyucuya birakir. */
  hideLabel?: boolean
  hint?: ReactNode
  error?: string
  /** Sag ic kenardaki birim/kisayol (`USDC`, `MAX`). */
  suffix?: ReactNode
  /**
   * CERCEVESIZ: kutu, kenarlik ve zemin YOK.
   *
   * Islem panelindeki tutar alani icin. Orada alanin KENDISI zaten bir
   * yuzeyin (`AmountCard`) icinde duruyor ve ikinci bir cerceve, sayiyi dar
   * bir kutuya hapsedip uzun bir rakamin kesilmesine yol aciyordu. Referans
   * tasarimda da sayi dogrudan kartin uzerinde durur.
   */
  bare?: boolean
  /**
   * Sol ic kenardaki sabit parca (`x.com/`, `t.me/`).
   *
   * KULLANICIYA TAM URL YAZDIRMAK GEREKSIZ BIR IS. Sabit kismi ekranda
   * gostermek hem yazilacagi azaltir hem de BEKLENEN BICIMI gosterir --
   * "https://x.com/ad" mi "@ad" mi diye dusunmek zorunda kalinmaz.
   */
  prefix?: ReactNode
}

/**
 * `label` ZORUNLU BIR PROP'TUR, opsiyonel degil.
 *
 * Yalnizca `placeholder` ile etiketlenen bir alan, kullanici yazmaya
 * basladiginda etiketini kaybeder ve ekran okuyucuda hicbir zaman tasimaz.
 * Gorsel olarak etiket istemeyen yerler `hideLabel` yazar -- yani gizlemek bir
 * karar olur, bir unutma degil.
 */
export function Input({
  label,
  hideLabel = false,
  hint,
  error,
  suffix,
  prefix,
  bare = false,
  className,
  ...rest
}: InputProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={cx('text-[13px] font-medium text-muted', hideLabel && 'sr-only')}
      >
        {label}
      </label>

      <div
        className={cx(
          'flex items-center gap-2',
          bare
            ? 'min-w-0'
            : cx(
                'rounded-input border bg-surface-2 px-3',
                'transition-colors duration-150 focus-within:border-white/25',
                error ? 'border-negative/60' : 'border-border',
              ),
        )}
      >
        {prefix ? <span className="shrink-0 select-none text-sm text-muted">{prefix}</span> : null}
        <input
          id={id}
          className={cx(
            'min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-muted',
            bare ? '' : 'h-10 text-sm',
            className,
          )}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          {...(error ? { 'aria-invalid': true } : {})}
          {...rest}
        />
        {suffix ? <span className="shrink-0 text-[13px] text-muted">{suffix}</span> : null}
      </div>

      {/* Girdi ici yardimci metin: #8A8A8A / #1C1C1C = 4,94:1. Sinirda gecer,
          ve `contrast.test.ts`'in olctugu dokuz cift bunu iceriyor. */}
      {hint ? (
        <p id={hintId} className="text-[12px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}

      {/*
        Hata METNI kirmizidir ama hata ISARETI yalnizca renk degildir: kenarlik
        degisir, `aria-invalid` yazilir ve mesaj `role="alert"` ile duyurulur.
        Renk korligi olan bir kullanicinin kirmiziyi gormedigi durumda hata yine
        de vardir ve okunur.
      */}
      {error ? (
        <p id={errorId} role="alert" className="text-[12px] leading-snug text-negative">
          {error}
        </p>
      ) : null}
    </div>
  )
}
