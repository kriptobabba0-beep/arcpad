import Link from 'next/link'
import { cx } from '@/components/ui/cx'
import { AGE_LABELS, exploreHref, SORT_LABELS, type ExploreQuery } from './params'

/**
 * FILTRE SERIDI `<Link>`'LERDEN OLUSUR, BUTONLARDAN DEGIL.
 *
 * Uc sonucu var ve ucu de bedava: JS gelmeden once calisir, her filtre
 * PAYLASILABILIR bir adrese sahiptir, ve tarayicinin geri dugmesi bir onceki
 * filtreye doner. `onClick`'li bir buton uculunu de kaybettirir ve karsiliginda
 * hicbir sey vermez -- sayfa zaten bir server component.
 *
 * Secili olan `aria-current="page"` tasir: rengin tek basina "secili" demesi
 * yeterli degildir.
 */
function FilterGroup({
  label,
  items,
}: {
  label: string
  items: ReadonlyArray<{ href: string; label: string; active: boolean }>
}) {
  return (
    <nav aria-label={label} className="flex items-center gap-1 rounded-pill bg-surface-2 p-1">
      {items.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          {...(item.active ? { 'aria-current': 'page' as const } : {})}
          className={cx(
            'rounded-pill px-3 py-1.5 text-[13px] font-medium transition-colors duration-150',
            item.active ? 'bg-surface text-text' : 'text-muted hover:text-text',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}

export function FilterBar({ query }: { query: ExploreQuery }) {
  const currentAge = query.ageDays === null ? 'all' : String(query.ageDays)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterGroup
        label="Sort launches"
        items={SORT_LABELS.map((item) => ({
          href: exploreHref(query, { sort: item.key }),
          label: item.label,
          active: query.sort === item.key,
        }))}
      />
      <FilterGroup
        label="Filter by age"
        items={AGE_LABELS.map((item) => ({
          href: exploreHref(query, { age: item.value }),
          label: item.label,
          active: currentAge === item.value,
        }))}
      />
    </div>
  )
}
