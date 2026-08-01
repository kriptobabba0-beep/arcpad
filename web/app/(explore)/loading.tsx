import { TokenGridSkeleton } from '@/components/explore/TokenGrid'
import { Skeleton } from '@/components/ui/Skeleton'

/**
 * IZGARAYLA AYNI GEOMETRI.
 *
 * Tek satirlik bir "Loading…" ya da farkli oranli bir iskelet, icerik
 * geldiginde sayfayi ZIPLATIR -- ve iskeletin var olma sebebi tam olarak o
 * ziplamayi onlemek. `TokenGridSkeleton` izgara siniflarini `TokenGrid` ile
 * PAYLASIR (`GRID_CLASS`), yani ikisi ayrisamaz.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-16 w-full" />
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-10 w-80" />
        </div>
        <TokenGridSkeleton />
      </section>
    </div>
  )
}
