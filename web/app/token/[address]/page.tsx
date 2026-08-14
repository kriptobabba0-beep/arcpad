import { isAddress } from 'viem'
import { notFound } from 'next/navigation'
import { verifyCanonical } from '@/lib/canonical'
import { resolveMetadata } from '@/lib/metadata'
import {
  CHAT_PAGE_SIZE,
  chainCandles,
  readCandles,
  readChat,
  readHolderPage,
  readTokenOverview,
  readTradePage,
  readVolumeSplit,
  TABLE_PAGE_SIZE,
  valueOf,
} from '@/lib/read'
import { loadMoreChat } from './actions'
import {
  asHex,
  type Canonicity,
  type HexAddress,
  stalenessOf,
  type TokenOverview,
} from '@/components/read/types'
import { CanonicalBadge, NotALaunch } from '@/components/token/CanonicalBadge'
import { TokenPriceChart } from '@/components/token/PriceHistoryChart'
import { LifecycleNotice } from '@/components/token/LifecycleNotice'
import { ProgressToGraduation } from '@/components/token/ProgressToGraduation'
import { ActivityTabs, tabOf } from '@/components/token/ActivityTabs'
import { PriceChart, type ChartMetric, type ChartShape } from '@/components/token/PriceChart'
import {
  CHART_TF_PARAM,
  MetricPicker,
  ShapePicker,
  TimeframePicker,
  timeframeKey,
  timeframeSeconds,
  VOLUME_TF_PARAM,
} from '@/components/token/ChartControls'
import { IdentityBadge, TokenIdentity } from '@/components/token/TokenIdentity'
import { TokenInfo } from '@/components/token/TokenInfo'
import { TokenStatStrip } from '@/components/token/TokenStatStrip'
import { VolumePanel } from '@/components/token/VolumePanel'
import { TOTAL_SUPPLY_TOK } from '@/components/create/facts'
import { TradeSurface } from '@/components/token/TradeSurface'
import { ChatPanel } from '@/components/token/ChatPanel'
import { resolveLifecycle } from '@/components/token/lifecycle'
import { type ChainToken, readChainToken } from '@/lib/chainToken'
import { getCurveProfile, type IdentifiedProfile } from '@/lib/profile'
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
export default async function TokenPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>
  /*
   * SAYFANIN DURUMU ADRESTE. Zaman dilimi, olcu, sekme ve sayfa numarasi
   * `searchParams`tan gelir -- yani her gorunum PAYLASILABILIR ve tarayicinin
   * geri dugmesi calisir. Bu deponun `FilterBar`da yazili kurali.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { address } = await params
  const search = await searchParams

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
      <IndexedToken overview={overview} search={search} />
    </>
  )
}

/** `?x=a&x=b` -> ilk deger. Bir dizi burada bir hata degil, yalnizca fazlalik. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function IndexedToken({
  overview,
  search,
}: {
  overview: TokenOverview
  search: Record<string, string | string[] | undefined>
}) {
  /*
   * ============ SAYFANIN DURUMU, ADRESTEN OKUNUR ============
   *
   * Dordu de DOGRULANARAK okunur: bir kullanici `?tf=banana` yazabilir ve o
   * durumda sayfa DUSMEZ, varsayilana doner. `timeframeKey` ve `tabOf` bu
   * dogrulamayi kendi dosyalarinda tasiyor -- burada tekrarlamak, ayni kurali
   * iki yerde tutmak olurdu.
   */
  /*
   * IKI AYRI ZAMAN DILIMI, VE AYRILMALARININ SEBEBI OLCULDU. Tek bir `tf`
   * ikisini birden suruyordu: hacim penceresini degistirmek mum kovasini da
   * degistiriyordu. Bunlar AYRI sorulardir -- "her mum kac dakika" ile "son ne
   * kadar surenin hacmi" arasinda bir bag yok.
   */
  const tf = timeframeKey(one(search[CHART_TF_PARAM]))
  const vf = timeframeKey(one(search[VOLUME_TF_PARAM]))
  /*
   * METRIK ARTIK BIR SECIM DEGIL. `?metric=price` hala YAZILABILIR ve sayfa
   * dusmez -- yalnizca yok sayilir. Fiyat, FDV'nin tam olarak 1e9'da biri
   * oldugu icin iki secenek ayni mumlari ciziyordu; secici basliga donustu.
   */
  const metric: ChartMetric = 'fdv'
  const shape: ChartShape = one(search['shape']) === 'line' ? 'line' : 'candles'
  const tab = tabOf(one(search['tab']))
  const pageParam = Number(one(search['p']) ?? '1')
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? Math.min(pageParam, 10_000) : 1

  const [metadata, candles, split24h, splitWindow, tradePage, holderPage, identified] =
    await Promise.all([
      resolveMetadata(overview.uri),
      readCandles(asHex(overview.token), { bucketSeconds: timeframeSeconds(tf), limit: 120 }),
      /*
       * ISTATISTIK SERIDI HER ZAMAN 24 SAAT OKUR -- baslik "24H volume" diyor
       * ve o baslik zaman dilimi secimiyle DEGISMEZ. Ikisini ayni okumadan
       * beslemek, "24H" yazip bes dakikalik hacmi gosteren bir hucre uretirdi.
       */
      readVolumeSplit(asHex(overview.token), { sinceSeconds: 86_400 }),
      // HACIM PANELI ise KENDI dilimini okur (`?vf=`), grafiginkini DEGIL.
      readVolumeSplit(asHex(overview.token), { sinceSeconds: timeframeSeconds(vf) }),
      readTradePage(asHex(overview.token), { page, pageSize: TABLE_PAGE_SIZE }),
      readHolderPage(asHex(overview.token), { page, pageSize: TABLE_PAGE_SIZE }),
      // PROFIL FACTORY'DEN, ve dusmesi sayfayi dusurmez: al-sat paneli o zaman
      // cizilmez, geri kalan her sey cizilir. Uydurulmus bir yedek KONMAZ --
      // testnet ile uretim yalnizca `V`de ve tam 1000 kat ayrisir.
      getCurveProfile().then(
        (found) => found,
        (error: unknown) => {
          console.error(
            'curve profile unavailable; the token page draws without a trade panel',
            error,
          )
          return null
        },
      ),
    ])

  const lifecycle = resolveLifecycle({
    complete: overview.complete,
    graduated: overview.graduated,
  })

  /*
   * MUMLARIN ACILISI ZINCIRLENIR. Bkz. `chainCandles`: bir mumun acilisi BIR ONCEKININ KAPANISIDIR. Zincirlenmezse
   * tek islemli her kova sifir yukseklikte bir doji cikar. Bosluk DOLDURULMAZ
   * -- `lightweight-charts` noktalari sirayla cizer ve bos zamanin genislik
   * kaplamasi, gercek mumlari ekranin bir kosesine sikistirmaktan baska bir
   * sey yapmiyordu.
   */
  const now = new Date()
  const candleRows = chainCandles(valueOf(candles) ?? [])
  const windowSplit = valueOf(splitWindow) ?? EMPTY_SPLIT
  const daySplit = valueOf(split24h) ?? EMPTY_SPLIT
  const trades = valueOf(tradePage)
  const holders = valueOf(holderPage)

  /*
   * DEGISIM, MUMLARIN EN ESKISINDEN BUGUNE. YETERLI GECMIS YOKSA `null` --
   * ve sifir DEGIL: tek islemli bir token icin "%0.0" yazmak "degismedi"
   * demek olurdu, oysa karsilastirilacak bir sey yok. Bu ayrim bu depoda
   * `StatRow` icin zaten yaziliydi.
   */
  const firstCandle = candleRows[0]
  const changePercent =
    firstCandle === undefined || firstCandle.openWei === 0n
      ? null
      : Number(((overview.marketCapWei - firstCandle.openWei) * 1_000n) / firstCandle.openWei) / 10

  /*
   * ============ AYNI SAYI, IKI YERDE, AYNI TURETIM ============
   *
   * OLCULDU, canli sayfada: serit "42.9% sells" derken hemen altindaki hacim
   * paneli ayni pencere icin "43.0% sells" diyordu. Ikisi de dogruydu ve
   * ikisi de yanlisti -- serit SATIS tarafini bolup KIRPIYOR, panel ise ALIS
   * tarafini bolup 100'den cikariyordu. Kirpma iki farkli yone dustugu icin
   * fark 0.1 puanda kaliyor, yani kimse "hangisi bozuk" diye soramiyor; ama
   * ayni sayfada ayni sayinin iki degeri, guvenilirligi tam olarak boyle
   * asindirir.
   *
   * Turetim TEK: alis binde birligi kirpilir, satis onun tumleyenidir --
   * `VolumePanel`in yaptigi da budur. Boylece iki sayi ayni girdiden ayni
   * cikti verir, ve cubugun iki parcasi da her zaman 100 eder.
   */
  const sellShare =
    daySplit.volumeWei === 0n
      ? null
      : 100 - Number((daySplit.buyVolumeWei * 1_000n) / daySplit.volumeWei) / 10

  /*
   * HER IKI KONTROL GRUBU DA AYNI TABANI KORUR, ve bu ONEMLIDIR: hacim
   * dilimine basmak grafigin dilimini SILMEMELI, ve tersi. Ikisi de burada
   * yaziliysa `hrefWith` her secimde otekini geri yazar.
   */
  const sharedParams: Record<string, string | undefined> = {
    [CHART_TF_PARAM]: tf,
    [VOLUME_TF_PARAM]: vf,
    ...(shape === 'candles' ? {} : { shape }),
    ...(tab === 'activity' ? {} : { tab }),
  }
  /** Sekme baglantilarinin koruyacagi parametreler. */
  const tableQuery: Record<string, string> = { tf, vf, shape }

  return (
    <div className="flex flex-col gap-8">
      <TokenIdentity
        name={overview.name}
        symbol={overview.symbol}
        token={asHex(overview.token)}
        imageUrl={metadata?.image ?? null}
        badges={
          <>
            {lifecycle.kind === 'graduated' ? (
              <IdentityBadge tone="accent">Graduated</IdentityBadge>
            ) : lifecycle.kind === 'complete' ? (
              // MAVI, KIRMIZI DEGIL: satis arzinin tukenmesi bir ariza degil
              // bir asama -- bkz. `IdentityBadge`in `blue` tonu.
              <IdentityBadge tone="blue">Curve complete</IdentityBadge>
            ) : (
              <IdentityBadge tone="accent">On the curve</IdentityBadge>
            )}
          </>
        }
      />

      <TokenStatStrip
        marketCapWei={overview.marketCapWei}
        changePercent={changePercent}
        priceWeiPerToken={overview.priceWeiPerTok}
        volume24hWei={overview.volume24hWei}
        sellSharePercent={sellShare}
        liquidityWei={overview.realQuoteReservesWei}
        holderCount={overview.holderCount}
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-8">
          <PriceChart
            candles={candleRows}
            metric={metric}
            shape={shape}
            bucketSeconds={timeframeSeconds(tf)}
            controls={
              <div className="flex items-center gap-2">
                <ShapePicker active={shape} params={sharedParams} />
                <MetricPicker active={metric} />
                <TimeframePicker
                  active={tf}
                  params={sharedParams}
                  param={CHART_TF_PARAM}
                  ariaLabel="Chart timeframe"
                />
              </div>
            }
          />

          <VolumePanel split={windowSplit} timeframe={vf} params={sharedParams} />

          <ActivityTabs
            tab={tab}
            trades={trades?.rows ?? []}
            holders={holders?.rows ?? []}
            holderCount={holders?.total ?? overview.holderCount ?? 0}
            tradeCount={trades?.total ?? 0}
            symbol={overview.symbol}
            curve={overview.curve}
            creator={overview.launchCreator}
            now={now}
            page={page}
            pageSize={TABLE_PAGE_SIZE}
            basePath={`/token/${overview.token}`}
            query={tableQuery}
            totalSupplyTok={TOTAL_SUPPLY_TOK}
            priceWeiPerToken={overview.priceWeiPerTok}
          />

          <TokenInfo
            creator={overview.launchCreator}
            token={overview.token}
            {...(metadata?.x === undefined ? {} : { x: metadata.x })}
            {...(metadata?.telegram === undefined ? {} : { telegram: metadata.telegram })}
            {...(metadata?.description === undefined ? {} : { description: metadata.description })}
          />
        </div>

        {/*
          SAG RAY YAPISKAN. Kullanici islem listesinde asagi kayarken al-sat
          paneli ekranda kalir; referans tasarimin davranisi da budur ve sebebi
          basit: bu sayfada asagi kaydirmanin amaci KARAR VERMEKTIR, ve karar
          verildiginde eylem elin altinda olmalidir.
        */}
        <div className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
          <TradeSurface
            token={asHex(overview.token)}
            curve={asHex(overview.curve)}
            lifecycle={lifecycle}
            profile={identified}
            symbol={overview.symbol}
          />
          {lifecycle.kind === 'trading' ? (
            <ProgressToGraduation
              ppm={overview.progressPpm}
              raisedWei={overview.realQuoteReservesWei}
              targetWei={overview.graduationRaiseWei}
            />
          ) : (
            /*
              `curve` GECILIYOR: bu olmadan tamamlanmis bir curve'de EKRANDA
              HICBIR EYLEM YOKTU. `graduate()` izinsizdir ve keeper dustugunde
              kullanicinin curve'u kendisi acabilmesi gerekir; panel hedefi
              ZINCIRDEN okur ve hedef `0x0` iken bir dugme HIC cizmez.
            */
            <LifecycleNotice lifecycle={lifecycle} curve={asHex(overview.curve)} />
          )}

          <ChatPanel
            token={asHex(overview.token)}
            symbol={overview.symbol}
            chat={await readChat(asHex(overview.token), { cursor: null, limit: CHAT_PAGE_SIZE })}
            loadMore={loadMoreChat.bind(null, overview.token)}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Okuma dustugunde hacim paneli SIFIR gosterir.
 *
 * Burada sifir DOGRU olandir, `null` degil: panel bir PENCERE hakkinda konusur
 * ve "bu pencerede olculebilen hacim yok" ile "hic islem olmadi" ekranda ayni
 * seyi soyler. Istatistik seridindeki `volume24hWei` ise ayri bir alandir ve
 * orada `null` "bilmiyoruz" demeye devam eder.
 */
const EMPTY_SPLIT = {
  volumeWei: 0n,
  buys: 0,
  sells: 0,
  buyers: 0,
  sellers: 0,
  buyVolumeWei: 0n,
  sellVolumeWei: 0n,
} as const

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
  const chain = identified === null ? null : await readChainToken(token, identified.profile)

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
        <ChainDrawnLaunch chain={chain} identified={identified} canonicity={canonicity} />
      )}
    </div>
  )
}

async function profileOrNull(): Promise<IdentifiedProfile | null> {
  try {
    return await getCurveProfile()
  } catch (error) {
    console.error('curve profile unavailable; the chain-only branch cannot draw', error)
    return null
  }
}

function ChainDrawnLaunch({
  chain,
  identified,
  canonicity,
}: {
  chain: ChainToken
  /** Triple AND name, as one reading -- see `TradeSurface`'s prop. */
  identified: IdentifiedProfile
  canonicity: Canonicity
}) {
  const profile = identified.profile
  // Zincir dali da AYNI iki bayragi besler: `readChainToken` `graduated()`i
  // artik ayni multicall icinde okuyor, yani indexer dustugunde de mezuniyet
  // ekranda GORUNUR. Iki dali ayri beslemek, birini duzeltip otekini unutmanin
  // klasik yoluydu.
  const lifecycle = resolveLifecycle({ complete: chain.complete, graduated: chain.graduated })
  const soldTok = profile.saleSupply - chain.realTokenReserves
  const percent = (Math.round(chain.progressPpm / 1_000) / 10).toFixed(1)

  return (
    <div className="flex flex-col gap-6" data-testid="chain-drawn-launch">
      {/*
        AYNI KIMLIK BILESENI, ayni sebeple: iki dal ayni sayfadir, yalnizca
        VERI KAYNAGI farklidir. Ayri bir baslik yazmak, bir gun birini
        degistirip otekini unutmanin yoluydu -- bu dosya o kusuru zaten alti
        kez kaydediyor.
      */}
      <TokenIdentity
        name={chain.name}
        symbol={chain.symbol}
        token={chain.token}
        badges={<CanonicalBadge status={canonicity} />}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="order-last flex flex-col gap-6 lg:order-none">
          {/*
            AYNI SERIT. INDEXER OLCUMLERI `null` GECER ve SIFIR DEGIL: bir
            sayfanin "0 holder" demesi ile "bilmiyoruz" demesi ayni sey
            degildir, ve bu dal tam olarak indexer'in dustugu daldir.
            `changePercent` de `null`: degisim mumlardan hesaplanir, mumlar
            indexer'dan gelir, yani burada olculemez.
          */}
          <TokenStatStrip
            marketCapWei={chain.marketCapWei}
            changePercent={null}
            priceWeiPerToken={chain.priceWeiPerTok}
            volume24hWei={null}
            sellSharePercent={null}
            liquidityWei={chain.realQuoteReserves}
            holderCount={null}
          />

          {lifecycle.kind === 'trading' ? (
            <ProgressToGraduation
              ppm={chain.progressPpm}
              raisedWei={chain.realQuoteReserves}
              targetWei={chain.graduationRaiseWei}
            />
          ) : (
            // Zincir dali da paneli tasir. Indexer dustugunde graduation'i
            // tetiklemek TAM OLARAK o zaman gerekebilir; iki dalin birinde
            // eylem olup otekinde olmamasi, bu deponun en sik kusuru olurdu.
            <LifecycleNotice lifecycle={lifecycle} curve={chain.curve} />
          )}

          {/*
            THE SAME CHART COMPONENT AS THE INDEXED BRANCH. There is no trade
            history on this branch -- the indexer is what has history -- so a
            graduated token draws the "no pool trades indexed yet" state rather
            than a bonding curve whose marker has been frozen at 100% since
            graduation.
          */}
          <TokenPriceChart
            lifecycle={lifecycle}
            profile={profile}
            soldTok={soldTok}
            currentPriceWei={chain.priceWeiPerTok}
            symbol={chain.symbol}
            progressPercent={percent}
          />

          <p className="text-[13px] text-muted" data-testid="no-trade-history">
            No trade history — the indexer has not answered for this token.
          </p>
        </div>

        <div className="order-first flex flex-col gap-6 lg:order-none">
          {/*
            THE SAME COMPONENT AS THE INDEXED BRANCH. `readChainToken` reads
            `graduated()` in its own multicall, so this branch resolves the same
            lifecycle -- and a user whose indexer is down still reaches the pool.
          */}
          <TradeSurface
            token={chain.token}
            curve={chain.curve}
            lifecycle={lifecycle}
            profile={identified}
            symbol={chain.symbol}
          />
        </div>
      </div>
    </div>
  )
}
