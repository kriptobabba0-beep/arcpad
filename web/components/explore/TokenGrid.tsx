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
  // 2xl'de ALTI sutun. Bes sutunda 1600px'lik bir ekranda kart genisligi
  // ~290px'e cikiyordu ve gorsel kartin geri kalanini eziyordu; alti sutun
  // karti ~240px'e cekiyor, ki referans arayuzlerin (pools.trade,
  // ponsfamily.com) izgara adimi da bu civarda. Daha dar bir kart demek, ilk
  // ekranda daha cok launch demek -- bir launchpad'de taranan sey odur.
  'grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'

export function TokenGrid({
  tokens,
  label,
  images,
}: {
  tokens: readonly TokenOverview[]
  label: string
  /**
   * Token adresi -> cozulmus gorsel URL'i. VERILMEZSE HER KART GRADYAN CIZER.
   *
   * Bu prop bir sureligine YOKTU ve kimse fark etmedi: `TokenCard` zaten
   * `imageUrl`i istege bagli aliyordu, `undefined` da "gorsel yok" demek
   * oldugu icin hicbir test dusmedi. Sonuc, bir kullanicinin yukledigi
   * gorselin token SAYFASINDA gorunup ANA IZGARADA hic gorunmemesiydi.
   */
  images?: Readonly<Record<string, string | null>>
}) {
  return (
    <ul aria-label={label} className={cx(GRID_CLASS, 'list-none')}>
      {tokens.map((overview) => (
        <li key={overview.token} className="contents">
          <TokenCard overview={overview} imageUrl={images?.[overview.token] ?? null} />
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
