'use client'

import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'

/**
 * ODAK TUZAGI OLAN MODAL. Task 9 (⌘K arama) ve Task 12 (al-sat onaylari)
 * bunu kullanir; kabukta ikinci bir odak yonetimi UYGULAMASI YOKTUR ve bu
 * bilincli: iki uygulama oldugunda biri her zaman digerinden once curur.
 *
 * `aria-modal="true"` tek basina YETMEZ. O oznitelik yardimci teknolojiye
 * "arkasi kapali" der ama KLAVYEYE hicbir sey soylemez: Tab yine de arkadaki
 * baglantilara gider ve kullanici gormedigi bir seye odaklanir. Tuzak bu
 * yuzden JS'te, keydown uzerinde.
 *
 * Kapanista odak ACAN OGEYE geri doner. Donmezse odak <body>'ye duser ve
 * klavyeyle gezen biri her modal kapanisinda sayfanin bastan gezinmesine
 * mahkum olur.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export type DialogProps = {
  open: boolean
  onClose: () => void
  /** Baslik gorunur ve `aria-labelledby` ile modala baglanir. */
  title: string
  description?: string
  children?: ReactNode
  /** `sm` cuzdan/onay, `lg` ⌘K arama gibi tam ekrana yakin icerik icin. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  size = 'sm',
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()

  /**
   * `offsetParent`/`getBoundingClientRect` ile gorunurluk elemesi YAPILMIYOR:
   * jsdom her ikisini de sifir/null dondurur, yani boyle bir eleme testte
   * butun ogeleri atar ve tuzagin testi sessizce anlamsizlasir. Modalin
   * icindeki gizli bir kontrol zaten `disabled` ya da `tabindex="-1"`
   * tasimalidir; secici ikisini de disliyor.
   */
  const focusables = useCallback(
    (): HTMLElement[] =>
      panelRef.current ? Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : [],
    [],
  )

  // Acilista odagi iceri al, kapanista acan ogeye geri ver.
  useEffect(() => {
    if (!open) return
    restoreTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    /*
     * Odak PANELIN KENDISINE gider, ilk odaklanabilir ogeye degil.
     *
     * DOM sirasinda ilk odaklanabilir sey "Close" dugmesidir (gorsel olarak
     * sag ustte, ama isaretlemede once). Acilista oraya odaklanmak, ekran
     * okuyucuya modalin adini degil "Kapat" yazisini okutur ve klavye
     * kullanicisini kapatma tusunun uzerinde birakir. Panele odaklanmak
     * `aria-labelledby`'yi okutur; Tab bir sonraki adimda zaten iceri girer.
     *
     * Icerige ozel bir baslangic odagi isteyen cagiranlar (Task 9'un arama
     * girdisi) kendi `useEffect`'lerinde odaklanir.
     */
    panelRef.current?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
      restoreTo.current?.focus()
    }
  }, [open, focusables])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const items = focusables()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        // Odaklanacak hicbir sey yoksa Tab modali TERK ETMEMELI.
        event.preventDefault()
        return
      }

      const active = document.activeElement
      const inside = panelRef.current?.contains(active instanceof Node ? active : null) ?? false

      if (event.shiftKey) {
        // `active === panelRef.current` de basi sayilir: acilistaki odak
        // paneldedir ve oradan Shift+Tab, aksi hâlde portal'in ONUNDEKI
        // sayfaya -- yani modalin arkasina -- kacar.
        if (!inside || active === first || active === panelRef.current) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [focusables, onClose],
  )

  if (!open) return null
  if (typeof document === 'undefined') return null

  const width = size === 'lg' ? 'max-w-2xl' : size === 'md' ? 'max-w-lg' : 'max-w-sm'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[10vh]"
      onKeyDown={onKeyDown}
    >
      {/* Zemin: tiklanabilir ama klavye sirasinda DEGIL -- Esc zaten kapatiyor
          ve odak sirasina bir "kapat" hedefi daha eklemek tuzagi genisletir. */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description ? { 'aria-describedby': descId } : {})}
        tabIndex={-1}
        className={cx(
          'relative w-full rounded-card border border-border bg-surface',
          'shadow-[0_24px_80px_-24px_rgb(0_0_0/0.9)]',
          width,
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-[13px] leading-snug text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-input p-1.5 text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="m4 4 8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
