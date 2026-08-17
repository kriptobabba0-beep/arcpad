import Link from 'next/link'
import type { AnalyticsRange } from '@/lib/read'
import { cx } from '@/components/ui/cx'

/**
 * 24h / All time.
 *
 * LINKS, NOT BUTTONS, AND NOT A CLIENT COMPONENT. The range is a server-side
 * query parameter -- the page re-runs the aggregate for it -- so the control
 * that changes it is a navigation, and a navigation is an anchor. A `<button>`
 * with an `onClick` here would need `'use client'`, ship JavaScript, and break
 * middle-click / open-in-new-tab for a control whose entire job is to produce a
 * different URL.
 *
 * `aria-current="page"` CARRIES THE SELECTION. Colour alone does not: a
 * screen-reader user gets no reading of "which one am I on" from a lime tint,
 * and neither does anyone with a monochrome display. `web/e2e/audit/a11y.spec`
 * runs axe over this route.
 */
export const RANGE_LABEL: Record<AnalyticsRange, string> = {
  '24h': '24h',
  all: 'All time',
}

export function RangeToggle({ active }: { active: AnalyticsRange }) {
  const options: readonly AnalyticsRange[] = ['24h', 'all']
  return (
    <nav aria-label="Time range" className="flex items-center gap-1 rounded-pill p-1">
      {options.map((option) => {
        const current = option === active
        return (
          <Link
            key={option}
            // `all` IS THE DEFAULT AND CARRIES NO PARAMETER. Two URLs for one
            // state is two cache entries and two things to keep in step.
            href={option === 'all' ? '/analytics' : `/analytics?range=${option}`}
            {...(current ? { 'aria-current': 'page' as const } : {})}
            className={cx(
              'rounded-pill px-3 py-1.5 text-[13px] transition-colors duration-150',
              current ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface hover:text-text',
            )}
          >
            {RANGE_LABEL[option]}
          </Link>
        )
      })}
    </nav>
  )
}
