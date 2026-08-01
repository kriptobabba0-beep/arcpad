import { CompleteSection } from '@/components/explore/CompleteSection'
import {
  NoLaunchesForFilter,
  NoLaunchesYet,
  ReadUnavailable,
} from '@/components/explore/EmptyState'
import { FilterBar } from '@/components/explore/FilterBar'
import { KeysetPager } from '@/components/explore/KeysetPager'
import {
  parseCursorStack,
  parseExploreParams,
  type ExploreSearchParams,
} from '@/components/explore/params'
import { TokenGrid } from '@/components/explore/TokenGrid'
import { readTokenList } from '@/components/read/boundary'

/**
 * EXPLORE. Bir SERVER COMPONENT, ve araya bir API katmani konmuyor
 * (spec §6.3): sorgu burada, render burada.
 *
 * Sayfa `searchParams`'i okur, beyaz listeden cozer ve `readTokenList`
 * cagirir. URL'den gelen hicbir dize bir SQL ifadesine donusmez --
 * `parseExploreParams` yalnizca `SORTS`'un bir ANAHTARINI dondurur.
 *
 * `<main>` BURADA YOK: landmark kabuktadir (`components/layout/AppShell`).
 * Ikinci bir `main`, atlama baglantisinin hedefini belirsizlestirir.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<ExploreSearchParams & { seen?: string | string[] }>
}) {
  const raw = await searchParams
  const query = parseExploreParams(raw)
  const cursors = parseCursorStack(raw.seen, query.cursor)

  const [climbing, complete] = await Promise.all([
    readTokenList({ sort: query.sort, ageDays: query.ageDays, cursor: query.cursor, limit: 24 }),
    // Tamamlanmis curve'ler AYRI bir okuma: en yeniler, kucuk bir sayfa.
    readTokenList({ sort: 'newest', ageDays: null, cursor: null, limit: 10 }),
  ])

  const completeTokens = complete.ok ? complete.data.rows.filter((row) => row.complete) : []

  return (
    <div className="flex flex-col gap-10">
      {/*
        Ust bolum VERIYE BAGLIDIR ve bugun bos olmasi beklenir. Yine de
        ciziliyor: bolumun kendisi urunun bir sozu -- "buraya tamamlanmis
        curve'ler gelir" -- ve o soz bos hâlde de okunabilir olmali.
      */}
      <CompleteSection tokens={completeTokens} />

      <section aria-labelledby="explore-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="explore-heading" className="font-serif text-2xl leading-none">
            Explore
          </h2>
          <FilterBar query={query} />
        </div>

        {!climbing.ok ? (
          <ReadUnavailable what="The launch list" />
        ) : climbing.data.rows.length === 0 ? (
          // Iki bos durum AYRIDIR. Filtre boslugunu urun bosluguyla ayni
          // metne baglamak, kullaniciya urunun bos oldugunu soyler -- oysa
          // filtresi bostur.
          query.ageDays === null ? (
            <NoLaunchesYet />
          ) : (
            <NoLaunchesForFilter ageDays={query.ageDays} />
          )
        ) : (
          <>
            <TokenGrid tokens={climbing.data.rows} label="Launches" />
            <KeysetPager
              basePath="/"
              query={{
                ...(query.sort === 'recentBuys' ? {} : { sort: query.sort }),
                ...(query.ageDays === null ? {} : { age: String(query.ageDays) }),
              }}
              cursors={cursors}
              nextCursor={climbing.data.nextCursor}
              total={climbing.data.total}
              label="Launch pages"
            />
          </>
        )}
      </section>
    </div>
  )
}
