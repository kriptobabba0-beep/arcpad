import { CurveMathError, formatPriceWeiPerToken, priceWeiPerToken } from '@arcpad/shared/browser'
import type { TradeRow } from '@/components/read/types'
import { Card } from '@/components/ui/Card'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'
import { CurveChart, type CurveProfileLike } from './CurveChart'
import { blockOfSeq } from './lifecycle'
import type { Lifecycle } from './lifecycle'
import { venueOf, type Venue } from './venue'

/**
 * ==========================================================================
 *  ONE HISTORY ACROSS TWO VENUES -- AND WHY THE AXIS HAS TO CHANGE.
 * ==========================================================================
 *
 * `CurveChart`'s x axis is TOKENS SOLD ON THE CURVE (`S - realTokenReserves`),
 * plotted against the bonding curve's own closed-form price. That axis is
 * exactly right up to graduation and MEANINGLESS after it, and the failure is
 * not cosmetic:
 *
 *   - At graduation the curve's `realTokenReserves` is 0, so x = S = 100%.
 *   - A pool row's `real_token_reserves_tok` is the POOL's implied reserve,
 *     derived by the indexer from `Swap`'s `sqrtPriceX96` and `liquidity`. The
 *     seeded position is ~2.069e26 tokens, so `S - 2.069e26` lands at ~74% --
 *     and the realised line would JUMP BACKWARDS at the seam and then wander
 *     along a curve the trade never touched.
 *
 * `CurveChart`'s own comment already forbids exactly this class of drawing: a
 * shape that is IMPOSSIBLE to realise on that curve. So pool rows are removed
 * from `realisedSeries` (see `CurveChart`), and after graduation the chart is
 * replaced by one whose axis is TIME -- which is what both venues share.
 *
 * ============ AND IT MUST NOT RESTART ============
 *
 * The two venues are one history. The indexer measured the price seam across
 * graduation at 2.2e-10 relative (58_783_256_052 wei/token from the curve's
 * closing virtual reserves against 58_783_256_039 from the pool's implied
 * ones), so the line is drawn CONTINUOUS through the seam rather than as two
 * charts. The seam is marked, not cut.
 *
 * ============ THE X AXIS IS THE BLOCK, NOT THE CLOCK ============
 *
 * Measured on Arc: 271 of 553 consecutive finalized block pairs (49.0%) share a
 * timestamp. A time axis would stack half the blocks on top of each other.
 * `event_seq >> 20` is the block, and `event_seq` is the only total order this
 * data has.
 */

export type PricePoint = {
  readonly block: number
  readonly priceWei: bigint
  readonly seq: bigint
  readonly venue: Venue
}

/**
 * Price per block, oldest first, both venues.
 *
 * SAMPLING IS "LAST TRADE IN THE BLOCK", never an average -- the same rule
 * `realisedSeries` uses, and for the same reason: an average draws a price that
 * never happened and a reader takes it for a trade.
 *
 * A row whose virtual reserves cannot produce a price is SKIPPED rather than
 * drawn at zero. Migration 012 made a zero-amount pool row representable (a
 * 1-wei token sell yields 0 quote units after floor, and it is a real, mined
 * swap); such a row still carries reserves, so it still prices. What does not
 * price is a reserve of zero, which `priceWeiPerToken` refuses.
 */
export function priceSeries(trades: readonly TradeRow[]): PricePoint[] {
  const lastPerBlock = new Map<number, PricePoint>()
  for (const trade of trades) {
    let priceWei: bigint
    try {
      priceWei = priceWeiPerToken(trade.virtualQuoteReservesWei, trade.virtualTokenReservesTok)
    } catch (error) {
      if (error instanceof CurveMathError || error instanceof RangeError) continue
      throw error
    }
    const block = blockOfSeq(trade.eventSeq)
    const point: PricePoint = {
      block,
      priceWei,
      seq: trade.eventSeq,
      venue: venueOf(trade),
    }
    const existing = lastPerBlock.get(block)
    if (existing === undefined || point.seq > existing.seq) lastPerBlock.set(block, point)
  }
  return [...lastPerBlock.values()].sort((a, b) => a.block - b.block)
}

const VIEW_W = 640
const VIEW_H = 240
const PAD = { left: 8, right: 8, top: 12, bottom: 8 }

export type PriceHistoryChartProps = {
  readonly trades: readonly TradeRow[]
  readonly symbol?: string
}

export function PriceHistoryChart({ trades, symbol }: PriceHistoryChartProps) {
  const points = priceSeries(trades)
  const poolCount = points.filter((p) => p.venue === 'pool').length

  if (points.length === 0) {
    return (
      <figure className="flex flex-col gap-3" data-testid="price-history-empty">
        <p className="text-[13px] text-muted">
          This token has graduated and trades in its pool. No pool trades have been indexed yet, so
          there is nothing to draw — the first swap sets the opening print.
        </p>
      </figure>
    )
  }

  const blocks = points.map((p) => p.block)
  const minBlock = Math.min(...blocks)
  const maxBlock = Math.max(...blocks)
  const prices = points.map((p) => p.priceWei)
  const minPrice = prices.reduce((a, b) => (b < a ? b : a), prices[0] as bigint)
  const maxPrice = prices.reduce((a, b) => (b > a ? b : a), prices[0] as bigint)

  const innerW = VIEW_W - PAD.left - PAD.right
  const innerH = VIEW_H - PAD.top - PAD.bottom
  /*
   * X IS LINEAR IN THE BLOCK NUMBER, NOT ORDINAL, so a token that traded twice
   * an hour apart does not look like a token that traded twice in one block.
   * The degenerate case -- every trade in ONE block -- has no span to scale by,
   * and there the points are spread evenly, which is the only honest thing left
   * to do with a single x value.
   */
  const span = maxBlock - minBlock
  const xOf = (point: PricePoint, index: number) =>
    span === 0
      ? PAD.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW)
      : PAD.left + ((point.block - minBlock) / span) * innerW
  const yOf = (price: bigint) => {
    const range = maxPrice - minPrice
    const frac = range === 0n ? 0.5 : Number(((price - minPrice) * 10_000n) / range) / 10_000
    return PAD.top + (1 - frac) * innerH
  }

  const coords = points.map((p, i) => ({ x: xOf(p, i), y: yOf(p.priceWei), venue: p.venue }))
  const line = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(' ')

  // The seam sits at the FIRST pool point: the curve's last print and the
  // pool's first are the same price to 2.2e-10, so the line runs through it.
  const seamIndex = coords.findIndex((c) => c.venue === 'pool')
  const seamX = seamIndex === -1 ? null : coords[seamIndex]?.x

  const summary =
    `Price from ${formatPriceWeiPerToken(minPrice)} to ${formatPriceWeiPerToken(maxPrice)} USDC ` +
    `per token across ${points.length} block${points.length === 1 ? '' : 's'} of trading` +
    (poolCount > 0
      ? `, of which ${poolCount} ${poolCount === 1 ? 'is' : 'are'} in the pool after graduation.`
      : '. All of it is on the bonding curve.')

  return (
    <figure className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="h-56 w-full"
        data-testid="price-history-chart"
      >
        {seamX === null ? null : (
          <line
            x1={seamX}
            x2={seamX}
            y1={PAD.top}
            y2={VIEW_H - PAD.bottom}
            stroke="var(--color-accent)"
            strokeOpacity="0.5"
            strokeDasharray="4 4"
            strokeWidth="1.5"
            data-testid="graduation-seam"
          />
        )}
        {/*
          ONE PATH, NOT TWO. Drawing the venues as separate polylines would put
          a visible gap at the seam and say the history restarted -- which is
          the thing this component exists to prevent. The venue is carried by
          the markers and by the seam line.
        */}
        <path
          d={line}
          fill="none"
          stroke="var(--color-text)"
          strokeWidth="2"
          data-testid="price-history-line"
        />
        {coords.map((c, i) => (
          <circle
            key={String(points[i]?.seq)}
            cx={c.x}
            cy={c.y}
            r="2.5"
            fill={c.venue === 'pool' ? 'var(--color-accent)' : 'var(--color-text)'}
            data-testid={c.venue === 'pool' ? 'price-point-pool' : 'price-point-curve'}
          />
        ))}
      </svg>

      <VisuallyHidden>
        <table>
          <caption>Realised prices, oldest first, with the venue each came from</caption>
          <thead>
            <tr>
              <th scope="col">Block</th>
              <th scope="col">Venue</th>
              <th scope="col">Price (USDC per token)</th>
            </tr>
          </thead>
          <tbody>
            {points.slice(-20).map((point) => (
              <tr key={String(point.seq)}>
                <td>{point.block}</td>
                <td>{point.venue === 'pool' ? 'Pool' : 'Curve'}</td>
                <td>{formatPriceWeiPerToken(point.priceWei)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VisuallyHidden>

      <figcaption className="text-[12px] text-muted" data-testid="price-history-caption">
        {poolCount > 0
          ? `Price across both venues${symbol === undefined ? '' : ` for ${symbol}`}. The dashed line is graduation; ` +
            'the history continues through it rather than restarting, because the curve’s last ' +
            'price and the pool’s first are the same price.'
          : 'Price by block. Trading is still on the bonding curve.'}
      </figcaption>
    </figure>
  )
}

export type TokenPriceChartProps = {
  readonly lifecycle: Lifecycle
  readonly profile: CurveProfileLike
  readonly soldTok: bigint
  readonly currentPriceWei: bigint
  readonly progressPercent: string
  readonly trades?: readonly TradeRow[]
  readonly symbol?: string
}

/**
 * WHICH CHART A TOKEN GETS, DECIDED ONCE.
 *
 * Same argument as `TradeSurface`: the token page has two branches and a chart
 * choice made on one of them is a chart choice forgotten on the other. Both
 * branches render this.
 */
export function TokenPriceChart({
  lifecycle,
  profile,
  soldTok,
  currentPriceWei,
  progressPercent,
  trades = [],
  symbol,
}: TokenPriceChartProps) {
  return (
    <Card className="px-4 py-4">
      {lifecycle.kind === 'graduated' ? (
        <PriceHistoryChart trades={trades} {...(symbol === undefined ? {} : { symbol })} />
      ) : (
        <CurveChart
          profile={profile}
          soldTok={soldTok}
          currentPriceWei={currentPriceWei}
          trades={trades}
          progressPercent={progressPercent}
        />
      )}
    </Card>
  )
}
