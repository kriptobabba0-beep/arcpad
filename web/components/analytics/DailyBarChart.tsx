import type { ProtocolDay } from '@arcpad/db'
import { formatUsdcCompact } from '@arcpad/shared/browser'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'

/**
 * ================= DAILY BARS: VOLUME AND LAUNCHES =================
 *
 * THE SERIES IS DENSE BEFORE IT GETS HERE. `listProtocolDaily` fills every
 * empty day with a zero (`generate_series` + `LEFT JOIN`), so this component
 * never has to guess whether a gap means "no data" or "no activity" -- a
 * distinction a chart cannot express and must therefore not be asked to make.
 * A component that skipped absent days would draw three idle days as three
 * adjacent bars and silently compress the time axis.
 *
 * A ZERO SERIES DRAWS NO BARS AND SAYS SO. Scaling by `max` when `max === 0`
 * is a division by zero; the obvious guard (`max || 1`) produces a row of
 * zero-height bars that reads exactly like a working chart with no traffic.
 * The honest answer for "nothing happened in this window" is a sentence, and
 * that sentence names the window.
 *
 * THE AXIS IS UTC DAYS OF BLOCK TIME. `day` arrives as `YYYY-MM-DD` TEXT, not
 * a `Date`: `pg` decodes a `date` column to a LOCAL-midnight `Date`, which on
 * this machine (UTC+3) formats back to the PREVIOUS day and would shift every
 * bar. The conversion is removed at the source rather than compensated here.
 */

const VIEW_W = 720
const VIEW_H = 160
const GAP = 2

export type DailyBarChartProps = {
  readonly days: readonly ProtocolDay[]
  readonly metric: 'volume' | 'launches'
  readonly title: string
}

/** `2026-08-10` -> `Aug 10`. Locale is PINNED; the root eslint config demands it. */
function shortDay(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(parsed)) return day
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function valueOfDay(day: ProtocolDay, metric: DailyBarChartProps['metric']): bigint {
  return metric === 'volume' ? day.volumeWei : BigInt(day.launchCount)
}

function formatValue(value: bigint, metric: DailyBarChartProps['metric']): string {
  return metric === 'volume'
    ? formatUsdcCompact(value)
    : Number(value).toLocaleString('en-US')
}

export function DailyBarChart({ days, metric, title }: DailyBarChartProps) {
  const values = days.map((d) => valueOfDay(d, metric))
  const max = values.reduce((a, b) => (b > a ? b : a), 0n)
  const total = values.reduce((a, b) => a + b, 0n)
  const first = days[0]
  const last = days[days.length - 1]

  const span =
    first === undefined || last === undefined
      ? ''
      : `${shortDay(first.day)} to ${shortDay(last.day)}`

  if (days.length === 0 || max === 0n) {
    return (
      <figure className="flex flex-col gap-2" data-testid={`daily-${metric}`}>
        <figcaption className="text-[11px] uppercase tracking-[0.08em] text-muted">
          {title}
        </figcaption>
        <p className="rounded-input border border-border bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">
          {/*
            NOT A CHART WITH ZERO BARS. "Nothing happened" and "the chart is
            broken" have to look different, and only one of them is true.
          */}
          {days.length === 0
            ? 'No days in range.'
            : `Nothing recorded${span === '' ? '' : `, ${span}`}.`}
        </p>
      </figure>
    )
  }

  const barWidth = (VIEW_W - GAP * (days.length - 1)) / days.length

  return (
    <figure className="flex flex-col gap-2" data-testid={`daily-${metric}`}>
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted">{title}</span>
        <span className="text-[11px] tabular-nums text-muted">
          {formatValue(total, metric)} total
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}, ${span}. Peak ${formatValue(max, metric)} on a single day, ${formatValue(total, metric)} in total across ${days.length} days.`}
        className="h-32 w-full"
        data-testid={`daily-${metric}-svg`}
      >
        {days.map((day, i) => {
          const value = valueOfDay(day, metric)
          /*
           * HEIGHT IN INTEGER ARITHMETIC, NOT FLOATS. `volumeWei` is an
           * 18-decimal amount; `Number(volumeWei)` loses precision above 2^53
           * and a testnet day's volume already exceeds it. The ratio is taken
           * in `bigint` at a fixed scale and only THEN converted -- so the bar
           * heights are exact and a whale day cannot round two others to the
           * same pixel by accident.
           */
          const height =
            value === 0n ? 0 : Number((value * BigInt(VIEW_H * 1000)) / max) / 1000
          const x = i * (barWidth + GAP)
          return (
            <rect
              key={day.day}
              x={x}
              // A zero day still occupies its slot; it just has no bar.
              y={VIEW_H - height}
              width={barWidth}
              height={height}
              fill="var(--color-accent)"
              fillOpacity={value === 0n ? 0 : 0.85}
              data-testid={value === 0n ? 'daily-bar-empty' : 'daily-bar'}
            />
          )
        })}
      </svg>

      {/*
        A BAR CHART TELLS A SCREEN READER NOTHING. `aria-label` summarises;
        the table CARRIES the numbers. Every day is listed, including the empty
        ones -- the gaps are part of the story.
      */}
      <VisuallyHidden>
        <table>
          <caption>{title} by day (UTC)</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{metric === 'volume' ? 'Volume (USDC)' : 'Launches'}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <td>{day.day}</td>
                <td>{formatValue(valueOfDay(day, metric), metric)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VisuallyHidden>

      <p className="text-[11px] text-muted">
        {span} · UTC days of block time
      </p>
    </figure>
  )
}
