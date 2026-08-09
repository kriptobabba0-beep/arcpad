import type { CurveProfile } from '@arcpad/shared/browser'
import { isAddress } from 'viem'
import { notFound } from 'next/navigation'
import { verifyCanonical } from '@/lib/canonical'
import { resolveMetadata } from '@/lib/metadata'
import { readHolders, readTokenOverview, readTrades, TABLE_PAGE_SIZE, valueOf } from '@/lib/read'
import { loadMoreHolders, loadMoreTrades } from './actions'
import {
  asHex,
  type Canonicity,
  type HexAddress,
  stalenessOf,
  type TokenOverview,
} from '@/components/read/types'
import { CanonicalBadge, NotALaunch } from '@/components/token/CanonicalBadge'
import { CurveChart } from '@/components/token/CurveChart'
import { LaunchFacts } from '@/components/token/LaunchFacts'
import { LifecycleNotice } from '@/components/token/LifecycleNotice'
import { ProgressToGraduation } from '@/components/token/ProgressToGraduation'
import { StatRow, statsFromOverview } from '@/components/token/StatRow'
import { TableTabs } from '@/components/token/TableTabs'
import { AboutPanel, TokenHeader } from '@/components/token/TokenHeader'
import { TradePanel } from '@/components/token/TradePanel'
import { resolveLifecycle } from '@/components/token/lifecycle'
import { type ChainToken, readChainToken } from '@/lib/chainToken'
import { getCurveProfile } from '@/lib/profile'
import { Card } from '@/components/ui/Card'
import { StaleNotice } from '@/components/read/StaleNotice'

/**
 * COZUMLEME SIRASI, ve dort dalin her biri AYRI bir ekran degil ayni sayfanin
 * VERI KAYNAGI DEGISMIS hâli:
 *
 *   adres gecerli mi?              -> degilse notFound()
 *   readTokenOverview(lowercase)
 *     ok        -> normal sayfa (satir KANONIK; Faz 3 kabulde dogruladi, yani
 *                  listeleme yolunda ikinci bir kontrol GEREKMEZ)
 *     notFound  -> verifyCanonical(adres)
 *                    canonical            -> zincirden ciz + "Not indexed yet"
 *                    forged/unverifiable  -> "This address is not a launch."
 *     unavailable -> zincirden ciz + "Live data unavailable"
 *
 * SAHTE ADRES DALINDA ISIM VE SEMBOL HIC OKUNMAZ. Okunsaydi ekranda gercek
 * bir launch'in adi gorunurdu; sahtekarligin isleyis bicimi tam olarak budur.
 * `<NotALaunch>` yalnizca adresi alan bir bilesendir -- ismi cizmek bir hata
 * degil bir IMKANSIZLIKTIR.
 */
export default async function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params

  if (!isAddress(address, { strict: false })) notFound()
  const token = address.toLowerCase() as HexAddress

  const result = await readTokenOverview(token)

  if (!result.ok) {
    /*
     * IKI DUSUS, TEK DAL, ve `unavailable` icin de KANONIKLIK SORULUR.
     *
     * Onceden `unavailable` dali kanonikligi HIC sormuyor, `unverifiable`
     * yaziyordu. Sonucu olculdu: `DATABASE_URL` tanimsizken -- ki `getPool()`
     * o durumda `notFound` degil `unavailable` verir -- sayfa gercek bir
     * launch icin bile yalnizca bir uyari kutusu ve bir adres ciziyordu. Yani
     * "veritabani dustugunde islem yapmaya devam edilir" ozelligi ekranda
     * ULASILAMAZDI. Zincir hâlâ ayakta ve `isCanonical` hâlâ cevap veriyor;
     * sormamak icin bir sebep yok.
     *
     * SAHTE ADRES YINE DE CIZILMEZ: `ChainOnly` launch yuzeyini yalnizca
     * `canonical` icin acar. `unverifiable` (RPC de dustu) `NotALaunch`'a
     * DUSURULMEZ -- "dogrulayamadik" ile "sahte" ayni cumle degildir ve
     * indexer'in dusmesi bir kullaniciya "bu bir launch degil" dedirtmez.
     */
    const canonicity = await verifyCanonical(token)
    if (result.reason === 'notFound' && canonicity !== 'canonical') {
      return <NotALaunch address={token} />
    }
    return (
      <ChainOnly
        token={token}
        canonicity={canonicity}
        notice={result.reason === 'notFound' ? 'not-indexed' : 'unavailable'}
      />
    )
  }

  const lagging = stalenessOf(result)
  const overview = valueOf(result)
  if (overview === undefined) {
    return <ChainOnly token={token} canonicity="unverifiable" notice="unavailable" />
  }
  return (
    <>
      {lagging === null ? null : <StaleNotice indexer={lagging} what="This page" />}
      <IndexedToken overview={overview} />
    </>
  )
}

async function IndexedToken({ overview }: { overview: TokenOverview }) {
  const [metadata, trades, holders, profile] = await Promise.all([
    resolveMetadata(overview.uri),
    readTrades(asHex(overview.token), { cursor: null, limit: TABLE_PAGE_SIZE }),
    readHolders(asHex(overview.token), { cursor: null, limit: TABLE_PAGE_SIZE }),
    // PROFIL FACTORY'DEN, ve dusmesi sayfayi dusurmez: al-sat paneli o zaman
    // cizilmez, geri kalan her sey cizilir. Uydurulmus bir yedek KONMAZ --
    // testnet ile uretim yalnizca `V`de ve tam 1000 kat ayrisir.
    getCurveProfile().then(
      ({ profile: p }) => p,
      (error: unknown) => {
        console.error(
          'curve profile unavailable; the token page draws without a trade panel',
          error,
        )
        return null
      },
    ),
  ])
  /*
   * `overview.graduated` GECILIYOR, VE GECILMEDIGI SURECE `graduated` DALI
   * HICBIR SAYFADA URETILEMIYORDU.
   *
   * Satir bu alani zaten tasiyordu (`packages/db/src/queries.ts`, `graduated`
   * + `graduatedSeq` + `graduationTargetAddr` + iki odeme miktari) ve burasi
   * yalnizca `complete`i okuyordu. Sonuc: mezun olan ilk token, arkasinda canli
   * bir havuzla, sonsuza kadar "Curve complete" olarak cizilecekti. Bileşenin
   * kendi testi elle kurulmus bir nesne ile "Graduated"i goruyordu, yani YESIL
   * kaliyordu -- eksik `loadMore*` prop'lariyla ve `CurveChart`'in hic cizilmeyen
   * gerceklesen katmaniyla AYNI kusur, ucuncu kez.
   *
   * `resolveLifecycle`in imzasi bu yuzden degisti: `graduated` artik ZORUNLU,
   * dolayisiyla bu satiri yeniden unutmak derlenmez.
   */
  const lifecycle = resolveLifecycle({
    complete: overview.complete,
    graduated: overview.graduated,
  })
  const stats = statsFromOverview(overview)

  const saleSupply = profile?.saleSupply ?? 793_100_000n * 10n ** 18n
  const soldTok = saleSupply - overview.realTokenReservesTok
  const percent = (Math.round(overview.progressPpm / 1_000) / 10).toFixed(1)

  return (
    <div className="flex flex-col gap-6">
      <TokenHeader overview={overview} imageUrl={metadata?.image ?? null} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          <StatRow stats={stats} />

          {lifecycle.kind === 'trading' ? (
            <ProgressToGraduation
              ppm={overview.progressPpm}
              raisedWei={stats.raisedWei}
              targetWei={stats.targetWei}
            />
          ) : (
            <LifecycleNotice lifecycle={lifecycle} />
          )}

          <Card className="px-4 py-4">
            {/*
              `trades` GECILIYOR, ve gecilmedigi surece bu grafigin GERCEKLESEN
              KATMANI HIC CIZILMEDI. `CurveChart`'in `trades` prop'u opsiyonel
              ve varsayilani `[]`, yani `realisedSeries([])` bos donuyor,
              `realised.length > 1` yanlis kaliyor ve `curve-realised` yolu
              hicbir sayfada DOM'a girmiyordu -- bileşenin testleri ise prop'u
              kendileri veriyordu. Bu, ayni dosyadaki eksik `loadMore*`
              prop'lariyla AYNI kusur ve yine ancak tarayicida gorundu.
            */}
            <CurveChart
              profile={
                profile ?? {
                  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
                  virtualQuoteReserves: 4_292n * 10n ** 15n,
                  saleSupply,
                }
              }
              soldTok={soldTok}
              currentPriceWei={stats.priceWeiPerToken}
              trades={valueOf(trades)?.rows ?? []}
              progressPercent={percent}
            />
          </Card>

          {/*
            Iki okuma AYRI: bir tabin okumasi dusse otekinin tabi calismaya
            devam eder. Tek bir `Promise.all` reddi ikisini birden karartirdi.

            ==================================================================
             `loadMore*` IKI PROP, VE YOKLUKLARI EKRANDA HICBIR IZ BIRAKMIYORDU.
            ==================================================================

            Bu iki satir gelene kadar sayfa EN COK 25 islem ve 25 holder
            gosterebiliyordu. Eksik olan bir dugme degildi: `useKeysetRows`
            `loadMore` olmadan `canLoadMore: false` doner ve `LoadMoreFooter`
            hicbir sey cizmez -- DOGRU davranis, cunku hicbir sey yapmayan bir
            dugme olmayandan kotudur. Sonuc, dort bin islemi olan bir token ile
            yirmi bes islemi olanin AYNI gorunmesiydi; ekranda "devami var"
            diyen tek bir piksel yoktu. `readTrades` bu sure boyunca gercek bir
            `nextCursor` donduruyordu, kimsenin gecmedigi bir prop'a.

            `.bind` sunucu eylemini token'a BAGLAR, yani istemcinin gonderdigi
            tek sey imlectir. Adres yine de eylemin icinde dogrulanir: bir
            sunucu eylemi acik bir uc noktadir.
          */}
          <TableTabs
            trades={trades}
            holders={holders}
            loadMoreTrades={loadMoreTrades.bind(null, overview.token)}
            loadMoreHolders={loadMoreHolders.bind(null, overview.token)}
            overview={{
              curve: overview.curve,
              launchCreator: overview.launchCreator,
              symbol: overview.symbol,
            }}
          />
        </div>

        <div className="flex flex-col gap-6">
          {/*
            AL-SAT PANELI, ve 375px'te GRAFIKTEN ONCE.
            `order-first lg:order-none`: telefonda niyet islem yapmaktir, masaustunde
            sag kolon zaten ilk ekranda gorunur.

            BU BAGLANTI FAZ 4'UN EN BUYUK BOSLUGUYDU. `TradePanel` 12. gorevde
            yazildi, 645 birim testinin bir kismi onu olcuyor ve HICBIR SAYFA
            ONU CIZMIYORDU -- bir bilesenin testi, o bilesenin ULASILABILIR
            oldugunu soylemez. Tarayici acilmadan gorunmedi.
          */}
          {profile === null ? null : (
            <TradePanel
              token={asHex(overview.token)}
              curve={asHex(overview.curve)}
              lifecycle={lifecycle}
              profile={profile}
              symbol={overview.symbol}
            />
          )}
          <AboutPanel
            {...(metadata?.description === undefined ? {} : { description: metadata.description })}
            {...(metadata === null
              ? {}
              : { links: { x: metadata.x, telegram: metadata.telegram } })}
          />
          <LaunchFacts overview={overview} canonicity="canonical" />
        </div>
      </div>
    </div>
  )
}

/**
 * ZINCIRDEN CIZILEN DAL, ARTIK GERCEKTEN ZINCIRDEN.
 *
 * `TokenHeader`, `StatRow` ve islem listesi indexer'in satirina baglidir;
 * ISIM, SEMBOL, REZERVLER, ILERLEME, FIYAT VE UC GIRIS NOKTASI degildir. Bu
 * dal onlari `LaunchToken` + `BondingCurve` uzerinden okur ve al-sat panelini
 * cizer -- yani "veritabani dustugunde islem yapmaya devam edilir" iddiasi
 * artik EKRANDA ULASILABILIR. Onceden bu bilesen yalnizca bir uyari kutusu ve
 * bir adres ciziyordu, dolayisiyla iddia dogru ama GORUNMEZDI.
 *
 * ISIM VE SEMBOL YALNIZCA `canonical` ICIN OKUNUR. Kanonik olmayan bir adres
 * icin bu bilesen eskisi gibi yalnizca adresi ve provenance'i yazar: sahte bir
 * token'in `name()`'ini cizmek, sahtekarligin isleyis bicimidir.
 */
async function ChainOnly({
  token,
  canonicity,
  notice,
}: {
  token: HexAddress
  canonicity: Canonicity
  notice: 'not-indexed' | 'unavailable'
}) {
  const identified = canonicity === 'canonical' ? await profileOrNull() : null
  const chain = identified === null ? null : await readChainToken(token, identified)

  return (
    <div className="flex flex-col gap-6">
      <div
        role="status"
        data-testid={notice === 'not-indexed' ? 'not-indexed-notice' : 'unavailable-notice'}
        className="rounded-card border border-border bg-surface px-5 py-4 text-[13px]"
      >
        {notice === 'not-indexed' ? (
          <>
            <span className="font-medium">Not indexed yet.</span>{' '}
            <span className="text-muted">
              This launch is canonical but our indexer has not caught up. Everything below is read
              straight from the chain.
            </span>
          </>
        ) : (
          <>
            <span className="font-medium">Live data unavailable.</span>{' '}
            <span className="text-muted">
              Our indexer is not responding, so volume, holders and trade history are missing.
              Reserves, price and trading are read from the chain and still work.
            </span>
          </>
        )}
      </div>

      {chain === null || identified === null ? (
        <>
          <p className="text-sm text-muted">
            Token <span className="tabular-nums">{token}</span>
          </p>
          <p className="text-[13px] text-muted">Provenance: {canonicity}</p>
        </>
      ) : (
        <ChainDrawnLaunch chain={chain} profile={identified} canonicity={canonicity} />
      )}
    </div>
  )
}

async function profileOrNull(): Promise<CurveProfile | null> {
  try {
    const { profile } = await getCurveProfile()
    return profile
  } catch (error) {
    console.error('curve profile unavailable; the chain-only branch cannot draw', error)
    return null
  }
}

function ChainDrawnLaunch({
  chain,
  profile,
  canonicity,
}: {
  chain: ChainToken
  profile: CurveProfile
  canonicity: Canonicity
}) {
  // Zincir dali da AYNI iki bayragi besler: `readChainToken` `graduated()`i
  // artik ayni multicall icinde okuyor, yani indexer dustugunde de mezuniyet
  // ekranda GORUNUR. Iki dali ayri beslemek, birini duzeltip otekini unutmanin
  // klasik yoluydu.
  const lifecycle = resolveLifecycle({ complete: chain.complete, graduated: chain.graduated })
  const soldTok = profile.saleSupply - chain.realTokenReserves
  const percent = (Math.round(chain.progressPpm / 1_000) / 10).toFixed(1)

  return (
    <div className="flex flex-col gap-6" data-testid="chain-drawn-launch">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-serif text-3xl leading-none">{chain.name}</h1>
        <p className="text-sm uppercase tracking-[0.08em] text-muted">{chain.symbol}</p>
        <CanonicalBadge status={canonicity} />
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="order-last flex flex-col gap-6 lg:order-none">
          <StatRow
            stats={{
              marketCapWei: chain.marketCapWei,
              priceWeiPerToken: chain.priceWeiPerTok,
              raisedWei: chain.realQuoteReserves,
              targetWei: chain.graduationRaiseWei,
              // INDEXER OLCUMLERI. `null` -> "—", ve SIFIR DEGIL: bir sayfanin
              // "0 holder" demesi ile "bilmiyoruz" demesi ayni sey degildir.
              volume24hWei: null,
              athMarketCapWei: null,
              holderCount: null,
            }}
          />

          {lifecycle.kind === 'trading' ? (
            <ProgressToGraduation
              ppm={chain.progressPpm}
              raisedWei={chain.realQuoteReserves}
              targetWei={chain.graduationRaiseWei}
            />
          ) : (
            <LifecycleNotice lifecycle={lifecycle} />
          )}

          <Card className="px-4 py-4">
            <CurveChart
              profile={profile}
              soldTok={soldTok}
              currentPriceWei={chain.priceWeiPerTok}
              progressPercent={percent}
            />
          </Card>

          <p className="text-[13px] text-muted" data-testid="no-trade-history">
            No trade history — the indexer has not answered for this token.
          </p>
        </div>

        <div className="order-first flex flex-col gap-6 lg:order-none">
          <TradePanel
            token={chain.token}
            curve={chain.curve}
            lifecycle={lifecycle}
            profile={profile}
            symbol={chain.symbol}
          />
        </div>
      </div>
    </div>
  )
}
