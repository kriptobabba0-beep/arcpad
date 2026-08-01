import type { ReactNode } from 'react'
import type { TokenOverview } from '@/components/read/types'
import { Skeleton } from '@/components/ui/Skeleton'
import { cx } from '@/components/ui/cx'
import { TokenCard } from './TokenCard'

/**
 * BES KIRILMA NOKTASI: 1 → 2 (≥480) → 3 (≥768) → 4 (≥1024) → 5 (≥1280).
 *
 * Sinif dizesi TEK BIR YERDE duruyor cunku `loading.tsx`'in iskeleti ayni
 * geometriyi kullanmak ZORUNDA. Iki ayri yerde yazilsalardi biri
 * degistiginde oteki kalir ve icerik geldiginde sayfa ziplardi -- iskeletin
 * cozdugu problemin ta kendisi.
 */
export const GRID_CLASS =
  'grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'

export function TokenGrid({ tokens, label }: { tokens: readonly TokenOverview[]; label: string }) {
  return (
    <ul aria-label={label} className={cx(GRID_CLASS, 'list-none')}>
      {tokens.map((overview) => (
        <li key={overview.token} className="contents">
          <TokenCard overview={overview} />
        </li>
      ))}
    </ul>
  )
}

/**
 * Kart izgarasiyla AYNI geometride iskelet. Farkli geometri = icerik gelince
 * ziplama, ve o ziplama tam olarak iskeletin onlemesi gereken sey.
 */
export function TokenGridSkeleton({ count = 10 }: { count?: number }): ReactNode {
  return (
    <div className={GRID_CLASS} aria-busy="true" aria-label="Loading launches">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          data-testid="token-card-skeleton"
          className="overflow-hidden rounded-card border border-border bg-surface"
        >
          {/* 1:1 -- kartin gorsel kutusuyla ayni oran. */}
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-1 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
