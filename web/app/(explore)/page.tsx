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
        SAYFANIN `h1`I -- GORSEL OLARAK GIZLI, VE BU BIR KACAMAK DEGIL.

        OLCULEREK BULUNDU: axe bu rotada `page-has-heading-one` veriyordu, uc
        genislikte de (`web/e2e/audit/a11y.spec.ts`). Sayfa iki `h2` ile
        basliyordu -- "Complete" ve "Explore" -- ve hicbir `h1` yoktu, yani
        ekran okuyucuyla gezen biri icin bu sayfanin BIR ADI yoktu; baslik
        listesi iki es duzey bolumle basliyordu ve hangisinin sayfa oldugu
        soylenmiyordu.

        Gorunur bir baslik EKLENMEDI cunku tasarim bilerek "Complete"
        seridiyle aciliyor ve onun ustune ikinci bir goruntu baslik koymak
        duzeni bozardi. `sr-only` bir `h1`, tam olarak bu durum icin olan
        kalip: gorsel hiyerarsi degismez, ANLAMSAL hiyerarsi tamamlanir.

        Bu kusuru hicbir birim testi goremezdi ve gormedi: 645 test yesildi.
        Tarayici acilmadan gorunmedi.
      */}
      <h1 className="sr-only">Explore token launches on Arc</h1>

      {/*
        BAYAT VERI UYARISI EN USTTE, izgaranin degil SAYFANIN basinda: bayat
        olan tek bir kart degil butun listedir.
      */}
      {listStale === null ? null : <StaleNotice indexer={listStale} what="Prices and volumes" />}

      <CompleteSection tokens={completeTokens} />

      <section aria-labelledby="explore-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
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
