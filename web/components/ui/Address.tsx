'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getWebConfig } from '@/lib/addresses'
import { cx } from './cx'
import { VisuallyHidden } from './VisuallyHidden'

/**
 * `0x92FB…b4bA`. Arc'ta ENS YOKTUR, dolayisiyla `useEnsName` cagrilmaz ve
 * kullanicilar kisaltilmis adresle gosterilir. Arc kendi isim servisini
 * cikarirsa bu fonksiyon onun baglanacagi tek yerdir.
 *
 * Bas 6 (`0x` + 4 nibble) ve son 4: iki ucu da tasimak sart, cunku bir adresi
 * dogrulayan kisi genelde her iki ucu birden karsilastirir ve tek uclu bir
 * kisaltma tam olarak "vanity" adres saldirisinin isledigi bosluktur.
 */
export function shortenAddress(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`
}

export type AddressProps = {
  value: string
  /** Varsayilan acik. `false` tam adresi yazar (About paneli, cuzdan modali). */
  shorten?: boolean
  copy?: boolean
  explorer?: boolean
  /** Ekran okuyucunun duyacagi ad: "Token address", "Your wallet". */
  label?: string
  className?: string
}

export function Address({
  value,
  shorten = true,
  copy = false,
  explorer = false,
  label,
  className,
}: AddressProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    })
  }, [value])

  const shown = shorten ? shortenAddress(value) : value

  return (
    <span className={cx('inline-flex items-center gap-1.5', className)}>
      {/*
        `tabular-nums`: adresler kolonlarda yan yana durur ve orantili
        rakamlarla cizildiklerinde ayni uzunluktaki iki adres farkli genislikte
        gorunur. `title` tam degeri tasir -- kisaltma bilgi kaybidir ve fareyle
        uzerine gelen biri tamamini gorebilmelidir.
      */}
      <span className="tabular-nums tracking-tight" title={value}>
        {label ? <VisuallyHidden>{`${label}: `}</VisuallyHidden> : null}
        {shown}
      </span>

      {copy ? (
        <button
          type="button"
          onClick={onCopy}
          className="rounded-sm text-muted transition-colors duration-150 hover:text-text"
          aria-label={label ? `Copy ${label.toLowerCase()}` : 'Copy address'}
        >
          <CopyGlyph copied={copied} />
        </button>
      ) : null}

      {explorer ? (
        <a
          href={`${getWebConfig().chain.blockExplorers.default.url}/address/${value}`}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-sm text-muted transition-colors duration-150 hover:text-accent"
          aria-label={label ? `View ${label.toLowerCase()} on ArcScan` : 'View on ArcScan'}
        >
          <ExternalGlyph />
        </a>
      ) : null}

      {/* Kopyalama gorsel bir onay uretir; ekran okuyucu icin de duyurulur. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Address copied' : ''}
      </span>
    </span>
  )
}

function CopyGlyph({ copied }: { copied: boolean }) {
  return copied ? (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8.5 6.5 12 13 4.5"
        stroke="var(--color-accent)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="5.75"
        y="5.75"
        width="8.5"
        height="8.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M10.25 3.75A2 2 0 0 0 8.25 1.75h-4.5a2 2 0 0 0-2 2v4.5a2 2 0 0 0 2 2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ExternalGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.5 2.5 7 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
