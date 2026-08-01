import type { ReactNode } from 'react'
import { cx } from './cx'

export type PillTone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warn'

/**
 * Bir durum etiketi, bir eylem degil. Tiklanabilir bir seye ihtiyaciniz varsa
 * `<Button pill>` kullanin -- gorsel olarak ayni, ama klavye ve ekran okuyucu
 * icin dogru olan sey.
 */
const TONES: Record<PillTone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent/12 text-accent border-accent/25',
  positive: 'bg-positive/12 text-positive border-positive/25',
  negative: 'bg-negative/12 text-negative border-negative/30',
  warn: 'bg-white/6 text-text border-white/15',
}

export function Pill({
  tone = 'neutral',
  children,
  className,
  /** Metnin solunda 5px'lik bir nokta. Durum "canli" ise gorsel olarak da oyle. */
  dot = false,
}: {
  tone?: PillTone
  children: ReactNode
  className?: string
  dot?: boolean
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5',
        'text-[11px] font-medium uppercase tracking-[0.08em]',
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className="size-[5px] rounded-pill bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}
