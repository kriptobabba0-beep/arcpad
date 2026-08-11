import {
  NoLaunchesForFilter,
  NoLaunchesYet,
  ReadUnavailable,
} from '@/components/explore/EmptyState'
import { ExploreHero } from '@/components/explore/ExploreHero'
import { LiveRefresh } from '@/components/explore/LiveRefresh'
import { FilterBar } from '@/components/explore/FilterBar'
import { NumberedPager } from '@/components/explore/NumberedPager'
import {
  type ExploreSearchParams,
  PAGE_SIZE,
  parseExploreParams,
  TOP_TOKENS_COUNT,
  tabQuery,
} from '@/components/explore/params'
import { TokenGrid } from '@/components/explore/TokenGrid'
import { TopTokensStrip } from '@/components/explore/TopTokensStrip'
import { StaleNotice } from '@/components/read/StaleNotice'
import { fold, type IndexerStatus, stalenessOf, type TokenOverview } from '@/components/read/types'
import { readTokenList } from '@/lib/read'

/**
 * EXPLORE. Bir SERVER COMPONENT, ve araya bir API katmani konmuyor
 * (spec §6.3): sorgu burada, render burada.
 *
 * Sayfa `searchParams`'i okur, beyaz listeden cozer ve `readTokenList`
 * cagirir. URL'den gelen hicbir dize bir SQL ifadesine donusmez --
 * `parseExploreParams` yalnizca `TABS`'in bir ANAHTARINI ve bir sayfa
 * numarasini dondurur.
 *
 * `<main>` BURADA YOK: landmark kabuktadir (`components/layout/AppShell`).
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<ExploreSearchParams>
}) {
  const raw = await searchParams
  const query = parseExploreParams(raw)

  /*
   * IKI OKUMA, PARALEL VE BIRBIRINDEN BAGIMSIZ.
   *
   * Serit her zaman FDV'ye gore ilk 16'dir ve sekmeden ETKILENMEZ: "Top
   * tokens" sabit bir referans noktasidir, altindaki liste ise degisen
   * gorunumdur. Ikisi ayni sorguyu paylassaydi, "New" sekmesinde serit de
   * yenilere donerdi ve iki bolum ayni seyi iki kez gosterirdi.
   *
   * Liste `withTotal` ister, cunku numarali sayfalayici kac sayfa cizecegini
   * ancak toplamdan bilir. Serit ISTEMEZ -- sayfasi yok.
   */
  const [list, top] = await Promise.all([
    readTokenList({
      sort: query.sort,
      ageDays: query.ageDays,
      cursor: null,
      limit: PAGE_SIZE,
      offset: (query.page - 1) * PAGE_SIZE,
      withTotal: true,
    }),
    readTokenList({
      sort: 'marketCap',
      ageDays: null,
      cursor: null,
      limit: TOP_TOKENS_COUNT,
    }),
  ])

  /*
   * `fold` UC DALI DA ZORUNLU KILAR. Bayat dal ayri bir varyant oldugu icin
   * (`staleData`, `data` degil) unutulmasi bir DERLEME hatasidir -- bir
   * `stale` boolean'i sessizce unutulabilirdi ve tam da unutulan sey olurdu.
   */
  const topTokens = fold(top, {
    fresh: (page) => page.rows,
    stale: (page) => page.rows,
    missing: () => [] as readonly TokenOverview[],
  })

  // `stalenessOf`, ELLE YAZILMIS AYNI IFADE DEGIL. Bu ucluyu iki sayfada
  // kopyalamak, bayatlik testinin bir gun bir yerde degisip otekinde kalmasi
  // demek -- ve bu sayfada kaybolan bir uyari, ekranda hicbir iz birakmaz.
  const listStale: IndexerStatus | null = stalenessOf(list)
  const page = list.ok ? (list.stale ? list.staleData : list.data) : null

  /*
   * SUNUCUNUN SAATI, ISTEMCININ DEGIL.
   *
   * `TopTokensStrip` artik bir istemci bilesenidir (ok dugmeleri) ve icinde
   * yas rozetleri var. `Date.now()`u orada cagirmak, SSR ile ilk istemci
   * ciziminin FARKLI degerler uretmesi demektir -- React bunu bir hidrasyon
   * uyusmazligi olarak bildirir ve rozet bir an yanlis gorunur. Zamani
   * sunucudan bir prop olarak gecmek ikisini esitler.
   */
  const now = Date.now()

  return (
    <div className="flex flex-col gap-10">
      {/*
        Sayfa kullanici yenilemeden guncel kalir: `router.refresh()` sunucu
        bileşenlerini yeniden calistirir, React sonucu mevcut agaca yamar, ve
        degisen sayilar `LiveNumber`a yeni prop olarak gelip animasyonla akar.
      */}
      <LiveRefresh />

      <ExploreHero />

      {/*
        BAYAT VERI UYARISI HERO'NUN ALTINDA, izgaranin degil LISTENIN ustunde:
        bayat olan tek bir kart degil butun listedir. Sayfanin EN ustunde
        degil, cunku oradaki hali urunu tanitmadan once bir ariza bildiriyordu.
      */}
      {listStale === null ? null : <StaleNotice indexer={listStale} what="Prices and volumes" />}

      <TopTokensStrip tokens={topTokens} now={now} />

      <section aria-labelledby="explore-heading" className="flex flex-col gap-4">
        {/*
          BASLIK VE SEKMELER AYNI KENARDA, ALT ALTA. Onceki hal
          `justify-between` idi: baslik solda, filtreler sagda, ve 1600px'lik
          bir ekranda aralarinda bin piksel bosluk -- ikisi ayni kontrolun
          parcasi olmasina ragmen ilgisiz iki oge gibi okunuyorlardi.
        */}
        <div className="flex flex-col gap-3">
          <h2 id="explore-heading" className="font-serif text-[28px] leading-none">
            All launches
          </h2>
          <FilterBar query={query} />
        </div>

        {page === null ? (
          <ReadUnavailable what="The launch list" />
        ) : page.rows.length === 0 ? (
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
            <TokenGrid tokens={page.rows} label="Launches" />
            {/*
              TOPLAM SAYILMAMISSA SAYFALAYICI CIZILMEZ. `total` `undefined`
              olabilir (okuma `withTotal` istememisse ya da sorgu duserse) ve
              uydurulmus bir sayfa sayisi kullaniciyi olmayan bir sayfaya
              goturur.
            */}
            {page.total === undefined ? null : (
              <NumberedPager
                basePath="/"
                query={tabQuery(query)}
                page={query.page}
                pageSize={PAGE_SIZE}
                total={page.total}
                label="Launch pages"
              />
            )}
          </>
        )}
      </section>
    </div>
  )
}
