import { Skeleton } from '@/components/ui/Skeleton'

/** Token sayfasinin geometrisiyle ayni: baslik, istatistik seridi, grafik. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Skeleton className="size-16" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    </div>
  )
}
