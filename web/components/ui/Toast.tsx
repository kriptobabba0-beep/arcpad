'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cx } from './cx'

export type ToastTone = 'neutral' | 'positive' | 'negative'

export type ToastInput = {
  title: string
  body?: string
  tone?: ToastTone
  /** ms. `0` -> kendiliginden kapanmaz. */
  duration?: number
}

type ToastRecord = ToastInput & { id: number; tone: ToastTone }

type ToastApi = {
  push: (toast: ToastInput) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside <ToastProvider>')
  return api
}

const TONES: Record<ToastTone, string> = {
  neutral: 'border-border bg-surface',
  positive: 'border-positive/30 bg-surface',
  negative: 'border-negative/40 bg-surface',
}

/**
 * Bildirimler.
 *
 * Iki AYRI canli bolge var ve bu bir ayrinti degil: basarili bir islem
 * `polite` ile duyurulur (kullanicinin yaptigi seyi bolmez), basarisiz bir
 * islem `assertive` ile (kullanici parasi hakkinda bir seyin yanlis gittigini
 * SIRADAKI ISI BEKLEMEDEN duymalidir). Tek bir polite bolge kullanmak, hata
 * mesajini kuyrugun sonuna koyar.
 *
 * Bolgeler modaldan BAGIMSIZ durur: bir Dialog acikken gelen bildirim de
 * duyurulur, cunku `aria-live` odak tuzagina tabi degildir.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++
      const record: ToastRecord = { ...toast, id, tone: toast.tone ?? 'neutral' }
      setToasts((current) => [...current, record])
      const duration = toast.duration ?? 6000
      if (duration > 0) setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-60 flex flex-col items-center gap-2 p-4 sm:items-end">
        <ToastRegion
          toasts={toasts.filter((toast) => toast.tone !== 'negative')}
          politeness="polite"
          onDismiss={dismiss}
        />
        <ToastRegion
          toasts={toasts.filter((toast) => toast.tone === 'negative')}
          politeness="assertive"
          onDismiss={dismiss}
        />
      </div>
    </ToastContext.Provider>
  )
}

function ToastRegion({
  toasts,
  politeness,
  onDismiss,
}: {
  toasts: readonly ToastRecord[]
  politeness: 'polite' | 'assertive'
  onDismiss: (id: number) => void
}) {
  return (
    <div
      role={politeness === 'assertive' ? 'alert' : 'status'}
      aria-live={politeness}
      className="flex w-full flex-col gap-2 sm:w-auto"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            'pointer-events-auto flex w-full items-start gap-3 rounded-card border px-4 py-3 sm:w-80',
            TONES[toast.tone],
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{toast.title}</p>
            {toast.body ? (
              <p className="mt-0.5 text-[13px] leading-snug text-muted">{toast.body}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label={`Dismiss: ${toast.title}`}
            className="rounded-sm text-muted transition-colors duration-150 hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="m4 4 8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
