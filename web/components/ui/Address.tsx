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
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const onCopy = useCallback(() => {
    /*
     * ============ `navigator.clipboard` GUVENLI BAGLAM ISTER ============
     *
     * OLCULDU: canli sitede kopyalama butonu HICBIR SEY yapmiyordu ve hicbir
     * hata da vermiyordu. Sebep TLS: `navigator.clipboard` yalnizca guvenli
     * bir baglamda (HTTPS ya da localhost) TANIMLIDIR, ve site duz HTTP'de
     * duruyor. Eski kod `navigator.clipboard?.writeText(...)` yaziyordu --
     * `?.` kisa devre yapip `undefined` donduruyor, `.then` hic calismiyor,
     * kullanici bir sey olmadigini goruyor. Sessiz basarisizligin ders
     * kitabi ornegi.
     *
     * Yedek yol `document.execCommand('copy')`: kullanimdan kaldirildi ama
     * HER tarayicida calisiyor ve guvenli baglam ISTEMIYOR. TLS geldiginde
     * ust dal devreye girer ve bu dal hic kullanilmaz.
     */
    const done = (ok: boolean): void => {
      setState(ok ? 'copied' : 'failed')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 1600)
    }

    if (navigator.clipboard !== undefined && window.isSecureContext) {
      void navigator.clipboard.writeText(value).then(
        () => done(true),
        () => done(fallbackCopy(value)),
      )
      return
    }
    done(fallbackCopy(value))
  }, [value])

  const copied = state === 'copied'

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
          data-testid="copy-address"
        >
          <CopyGlyph copied={copied} />
        </button>
      ) : null}

      {/*
        BASARISIZLIK SESSIZ KALMAZ. Kopyalama iki yolla da olmadiysa
        kullanici bunu OGRENMELI -- eski hal hicbir sey soylemiyordu ve bir
        kullanici butonun bozuk mu yoksa kendisinin mi kacirdigini bilemezdi.
      */}
      {state === 'failed' ? (
        <span role="status" className="text-[11px] text-negative">
          copy failed
        </span>
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

/**
 * Guvenli baglam olmadan kopyalama.
 *
 * Gizli bir `<textarea>`, secim, `execCommand('copy')`. Uc ayrinti
 * load-bearing:
 *   - `position: fixed` + `opacity: 0`: sayfa iOS'ta kutuya KAYMASIN.
 *   - `readOnly`: mobilde klavye acilmasin.
 *   - `document.body`e eklenir, cunku `execCommand` gorunur bir agac ister.
 *
 * Basarisizsa `false` doner ve cagiran bunu KULLANICIYA soyler -- sessizce
 * yutmak, bu fonksiyonun var olma sebebi olan kusurun ta kendisi.
 */
function fallbackCopy(value: string): boolean {
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '0'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
