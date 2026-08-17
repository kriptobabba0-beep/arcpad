'use client'

import { useCallback, useRef, type ReactNode } from 'react'
import { cx } from './cx'

export type TabItem = {
  id: string
  label: ReactNode
  disabled?: boolean
}

export type TabsProps = {
  items: readonly TabItem[]
  value: string
  onChange: (id: string) => void
  /** `aria-label` -- bir sekme seridinin ne hakkinda oldugu sorulabilir olmali. */
  label: string
  /** `aria-controls` / `id` uretiminin koku. Panel `${idBase}-panel-${id}` olur. */
  idBase: string
  className?: string
}

/**
 * WAI-ARIA sekme deseni, DONER TABINDEX ile.
 *
 * Serit odak sirasinda TEK bir durak tutar; sekmeler arasinda ok tuslariyla
 * gezilir. Her sekmeye ayri bir Tab durağı vermek "erisilebilir" gorunur ama
 * degildir: on sekmeli bir seride klavye kullanicisi icerige ulasmak icin on
 * kez Tab'a basar.
 *
 * Faz 4'te al-sat panelinde yalnizca `Market` sekmesi cizilir (Limit ve Orders
 * Faz 7). Tiklandiginda hicbir sey yapmayan bir sekme, olmayan bir sekmeden
 * kotudur -- bu yuzden bilesen "devre disi sekme" degil, "cizilmeyen sekme"
 * modelini destekler: gelmeyen sekme `items`'a hic konmaz.
 */
export function Tabs({ items, value, onChange, label, idBase, className }: TabsProps) {
  const stripRef = useRef<HTMLDivElement | null>(null)

  const move = useCallback(
    (delta: number | 'first' | 'last') => {
      const enabled = items.filter((item) => !item.disabled)
      if (enabled.length === 0) return
      const current = enabled.findIndex((item) => item.id === value)
      let next: number
      if (delta === 'first') next = 0
      else if (delta === 'last') next = enabled.length - 1
      else next = (current + delta + enabled.length) % enabled.length

      const target = enabled[next]
      if (!target) return
      onChange(target.id)
      stripRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(`${idBase}-tab-${target.id}`)}`)
        ?.focus()
    },
    [items, value, onChange, idBase],
  )

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label}
      className={cx('inline-flex items-center gap-1 rounded-pill bg-surface-2 p-1', className)}
      onKeyDown={(event) => {
        const handled: Record<string, () => void> = {
          ArrowRight: () => move(1),
          ArrowLeft: () => move(-1),
          Home: () => move('first'),
          End: () => move('last'),
        }
        const run = handled[event.key]
        if (!run) return
        event.preventDefault()
        run()
      }}
    >
      {items.map((item) => {
        const selected = item.id === value
        return (
          <button
            key={item.id}
            id={`${idBase}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled ?? false}
            onClick={() => onChange(item.id)}
            className={cx(
              'rounded-pill px-3 py-1.5 text-[13px] font-medium transition-colors duration-150',
              'disabled:pointer-events-none disabled:opacity-45',
              selected ? 'bg-surface text-text' : 'text-muted hover:text-text',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
