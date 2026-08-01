import { formatPriceWeiPerToken, formatUsdcCompact } from '@arcpad/shared/browser'
import type { TokenOverview } from '@/components/read/types'
import { cx } from '@/components/ui/cx'

/**
 * "LIQUIDITY" YERINE "RAISED" -- DEVIASYON.
 *
 * Referans seridi: Market cap · Liquidity · 24h volume · ATH. arcpad'de
 * HAVUZ YOK (Faz 2), yani "Liquidity" ya sabit sifir ya uydurma olurdu.
 * Yerine curve'un fiilen topladigi tutar: `real_quote_reserves_wei`.
 *
 * "BURNED" SATIRI YOK (S8). Yakma yolu yoktur -- OZ ERC-20 `to ==
 * address(0)` icin `ERC20InvalidReceiver` ile revert eder ve Arc sifir adrese
 * native transferi ayrica yasaklar. Her token icin sabit sifir gosteren bir
 * satir, urunun bir seyi OLCTUGU izlenimi verir; oysa olculecek bir sey yok.
 *
 * Indexer'a bagli alanlar (`volume_24h`, `ath`, `holders`) zincirden cizilen
 * dalda "—" gosterir -- sifir DEGIL. Sifir bir olcum, "—" bir bilinmezliktir
 * ve ikisini karistirmak kullaniciya olcmedigimiz bir seyi olcmus gibi
 * gosterir.
 */
export type StatSource = {
  readonly marketCapWei: bigint
  readonly priceWeiPerToken: bigint
  readonly raisedWei: bigint
  readonly targetWei: bigint
  /** `null` = indexer'dan gelmedi. Sifir DEGIL. */
  readonly volume24hWei: bigint | null
  readonly athMarketCapWei: bigint | null
  readonly holderCount: number | null
}

export function statsFromOverview(overview: TokenOverview): StatSource {
  return {
    marketCapWei: BigInt(overview.market_cap_wei),
    priceWeiPerToken: BigInt(overview.price_wei_per_token),
    raisedWei: BigInt(overview.real_quote_reserves_wei),
    targetWei: BigInt(overview.graduation_raise_wei),
    volume24hWei: BigInt(overview.volume_24h_wei),
    athMarketCapWei: BigInt(overview.ath_market_cap_wei),
    holderCount: overview.holder_count,
  }
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className={cx('tabular-nums text-sm', muted && 'text-muted')}>{value}</dd>
    </div>
  )
}

/** Bilinmeyen bir olcum. Sifir degil. */
const UNKNOWN = '—'

export function StatRow({ stats }: { stats: StatSource }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="font-serif text-4xl leading-none tabular-nums">
          {formatUsdcCompact(stats.marketCapWei)}
        </p>
        <p className="text-sm text-muted">
          market cap ·{' '}
          <span className="tabular-nums">
            {formatPriceWeiPerToken(stats.priceWeiPerToken)} USDC
          </span>{' '}
          per token
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat label="Raised" value={`${formatUsdcCompact(stats.raisedWei)}`} />
        <Stat
          label="24h volume"
          value={stats.volume24hWei === null ? UNKNOWN : formatUsdcCompact(stats.volume24hWei)}
          {...(stats.volume24hWei === null ? { muted: true } : {})}
        />
        <Stat
          label="ATH"
          value={
            stats.athMarketCapWei === null ? UNKNOWN : formatUsdcCompact(stats.athMarketCapWei)
          }
          {...(stats.athMarketCapWei === null ? { muted: true } : {})}
        />
        <Stat
          label="Holders"
          value={stats.holderCount === null ? UNKNOWN : stats.holderCount.toLocaleString('en-US')}
          {...(stats.holderCount === null ? { muted: true } : {})}
        />
      </dl>
    </div>
  )
}
