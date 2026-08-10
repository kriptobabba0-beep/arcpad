import { CompleteSection } from '@/components/explore/CompleteSection'
import {
  NoLaunchesForFilter,
  NoLaunchesYet,
  ReadUnavailable,
} from '@/components/explore/EmptyState'
import { ExploreHero } from '@/components/explore/ExploreHero'
import { FilterBar } from '@/components/explore/FilterBar'
import { KeysetPager } from '@/components/explore/KeysetPager'
import {
  parseCursorStack,
  parseExploreParams,
  type ExploreSearchParams,
} from '@/components/explore/params'
import { TokenGrid } from '@/components/explore/TokenGrid'
import { StaleNotice } from '@/components/read/StaleNotice'
import { fold, type IndexerStatus, stalenessOf, type TokenOverview } from '@/components/read/types'
import { readTokenList } from '@/lib/read'

/**
 * EXPLORE. Bir SERVER COMPONENT, ve araya bir API katmani konmuyor
 * (spec §6.3): sorgu burada, render burada.
 *
 * Sayfa `searchParams`'i okur, beyaz listeden cozer ve `readTokenList`
 * cagirir. URL'den gelen hicbir dize bir SQL ifadesine donusmez --
 * `parseExploreParams` yalnizca `SORTS`'un bir ANAHTARINI dondurur.
 *
 * `<main>` BURADA YOK: landmark kabuktadir (`components/layout/AppShell`).
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

  /*
   * `fold` UC DALI DA ZORUNLU KILAR. Bayat dal ayri bir varyant oldugu icin
   * (`staleData`, `data` degil) unutulmasi bir DERLEME hatasidir -- bir
   * `stale` boolean'i sessizce unutulabilirdi ve tam da unutulan sey olurdu.
   */
  const completeTokens = fold(complete, {
    fresh: (page) => page.rows.filter((row) => row.complete),
    stale: (page) => page.rows.filter((row) => row.complete),
    missing: () => [] as readonly TokenOverview[],
  })

  // `stalenessOf`, ELLE YAZILMIS AYNI IFADE DEGIL. Bu ucluyu iki sayfada
  // kopyalamak, bayatlik testinin bir gun bir yerde degisip otekinde kalmasi
  // demek -- ve bu sayfada kaybolan bir uyari, ekranda hicbir iz birakmaz.
  const listStale: IndexerStatus | null = stalenessOf(climbing)
  const list = climbing.ok ? (climbing.stale ? climbing.staleData : climbing.data) : null

  return (
    <div className="flex flex-col gap-10">
      {/*
        SAYFANIN `h1`I ARTIK GORUNUR, VE BU BIR GERI ADIM DEGIL.

        Onceden `sr-only` idi ve gerekcesi yaziliydi: axe bu rotada
        `page-has-heading-one` veriyordu, sayfa iki `h2` ile basliyordu, ve
        "tasarim bilerek Complete seridiyle aciliyor" deniyordu. Erisilebilirlik
        tarafi dogruydu; TASARIM tarafi ise olculdugunde tutmadi -- goren bir
        ziyaretcinin gordugu ilk oge KIRMIZI BIR UYARI KUTUSUYDU ve urunun ne
        oldugunu soyleyen hicbir cumle yoktu.

        `<ExploreHero>` gorunur bir `h1` tasiyor, yani `sr-only` olan
        KALDIRILDI: iki `h1` (biri gizli, biri gorunur) ekran okuyucuya bu
        sayfanin iki adi oldugunu soylerdi. Bir sayfanin bir adi vardir.
      */}
      <ExploreHero />

      {/*
        BAYAT VERI UYARISI HERO'NUN ALTINDA, izgaranin degil LISTENIN ustunde:
        bayat olan tek bir kart degil butun listedir. Sayfanin EN ustunde
        degil, cunku oradaki hali urunu tanitmadan once bir ariza bildiriyordu.
      */}
      {listStale === null ? null : <StaleNotice indexer={listStale} what="Prices and volumes" />}

      <CompleteSection tokens={completeTokens} />

      <section aria-labelledby="explore-heading" className="flex flex-col gap-4">
        {/*
          BASLIK VE FILTRELER AYNI KENARDA, ALT ALTA.

          Onceki hal `justify-between` idi: baslik solda, filtreler sagda, ve
          1600px'lik bir ekranda aralarinda bin piksel bosluk. Ikisi ayni
          kontrolun parcasi -- "neye bakiyorum" ve "nasil siralanmis" -- ama
          ekranin iki ucunda durunca ilgisiz iki oge gibi okunuyorlardi, ve
          filtreler bir izgaranin degil bir sonraki bolumun basligi gibi
          duruyordu.
        */}
        <div className="flex flex-col gap-3">
          <h2 id="explore-heading" className="font-serif text-2xl leading-none">
            Explore
          </h2>
          <FilterBar query={query} />
        </div>

        {list === null ? (
          <ReadUnavailable what="The launch list" />
        ) : list.rows.length === 0 ? (
          // Iki bos durum AYRIDIR. Filtre boslugunu urun bosluguyla ayni metne
          // baglamak, kullaniciya urunun bos oldugunu soyler -- oysa filtresi
          // bostur.
          query.ageDays === null ? (
            <NoLaunchesYet />
          ) : (
            <NoLaunchesForFilter ageDays={query.ageDays} />
          )
        ) : (
          <>
            <TokenGrid tokens={list.rows} label="Launches" />
            <KeysetPager
              basePath="/"
              query={{
                ...(query.sort === 'recentBuys' ? {} : { sort: query.sort }),
                ...(query.ageDays === null ? {} : { age: String(query.ageDays) }),
              }}
              cursors={cursors}
              nextCursor={list.nextCursor}
              label="Launch pages"
            />
          </>
        )}
      </section>
    </div>
  )
}
