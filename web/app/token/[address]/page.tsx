import { isAddress } from 'viem'
import { notFound } from 'next/navigation'
import {
  readHolders,
  readTokenOverview,
  readTrades,
  resolveMetadata,
  verifyCanonical,
} from '@/components/read/boundary'
import {
  asHex,
  type Canonicity,
  type HexAddress,
  type TokenOverview,
} from '@/components/read/types'
import { NotALaunch } from '@/components/token/CanonicalBadge'
import { CurveChart } from '@/components/token/CurveChart'
import { LaunchFacts } from '@/components/token/LaunchFacts'
import { LifecycleNotice } from '@/components/token/LifecycleNotice'
import { ProgressToGraduation } from '@/components/token/ProgressToGraduation'
import { StatRow, statsFromOverview } from '@/components/token/StatRow'
import { TableTabs } from '@/components/token/TableTabs'
import { AboutPanel, TokenHeader } from '@/components/token/TokenHeader'
import { resolveLifecycle } from '@/components/token/lifecycle'
import { Card } from '@/components/ui/Card'

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

  if (!result.ok && result.reason === 'notFound') {
    const canonicity = await verifyCanonical(token)
    if (canonicity !== 'canonical') return <NotALaunch address={token} />
    return <ChainOnly token={token} canonicity={canonicity} notice="not-indexed" />
  }

  if (!result.ok) {
    // `unavailable`. Sayfa 500 VERMEZ ve al-sat paneli calismaya devam eder --
    // o rezervleri ZINCIRDEN okur ve veritabanina hic ihtiyaci yoktur.
    return <ChainOnly token={token} canonicity="unverifiable" notice="unavailable" />
  }

  return <IndexedToken overview={result.data} />
}

async function IndexedToken({ overview }: { overview: TokenOverview }) {
  const [metadata, trades, holders] = await Promise.all([
    resolveMetadata(overview.uri),
    readTrades(asHex(overview.token), { cursor: null, limit: 25 }),
    readHolders(asHex(overview.token), { cursor: null, limit: 25 }),
  ])
  const lifecycle = resolveLifecycle({ complete: overview.complete })
  const stats = statsFromOverview(overview)

  const saleSupply = 793_100_000n * 10n ** 18n
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
            <CurveChart
              profile={{
                virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
                virtualQuoteReserves: 4_292n * 10n ** 15n,
                saleSupply,
              }}
              soldTok={soldTok}
              currentPriceWei={stats.priceWeiPerToken}
              progressPercent={percent}
            />
          </Card>

          {/*
            Iki okuma AYRI: bir tabin okumasi dusse otekinin tabi calismaya
            devam eder. Tek bir `Promise.all` reddi ikisini birden karartirdi.

            Task 12'nin <TradePanel>'i hâlâ BURADA DEGIL, ve bu bilincli: bos
            bir cerceve, kullaniciya gelmeyecek bir sey vaat eder.
          */}
          <TableTabs
            trades={trades}
            holders={holders}
            overview={{
              curve: overview.curve,
              launchCreator: overview.launchCreator,
              symbol: overview.symbol,
            }}
          />
        </div>

        <div className="flex flex-col gap-6">
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
 * ZINCIRDEN CIZILEN DAL.
 *
 * `TokenHeader`, `StatRow`, `ProgressToGraduation` ve al-sat paneli
 * `CurveState` + `CurveProfile` ile de cizilebilir. Yalnizca hacim, holder
 * sayisi, ATH ve islem listesi indexer'a baglidir ve onlar "—" gosterir --
 * SIFIR degil.
 *
 * TODO(task-7): bu dal bugun yalnizca seridi cizip duruyor. Zincir okumasi
 * `web/hooks/useCurveState.ts` (Task 12) ve `web/lib/profile.ts`'in
 * `getCurveProfile()`'ina baglanacak; ikisi de bu dalgada baska bir izin
 * sahibinde.
 */
function ChainOnly({
  token,
  canonicity,
  notice,
}: {
  token: HexAddress
  canonicity: Canonicity
  notice: 'not-indexed' | 'unavailable'
}) {
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

      <p className="text-sm text-muted">
        Token <span className="tabular-nums">{token}</span>
      </p>
      <p className="text-[13px] text-muted">Provenance: {canonicity}</p>
    </div>
  )
}
