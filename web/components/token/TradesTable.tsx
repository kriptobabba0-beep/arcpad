'use client'

import {
  CurveMathError,
  formatPriceWeiPerToken,
  formatTokenAmount,
  formatUsdcAmount,
  priceWeiPerToken,
} from '@arcpad/shared/browser'
import type { TradeRow } from '@/components/read/types'
import { Address } from '@/components/ui/Address'
import { buttonClassName } from '@/components/ui/Button'
import { cx } from '@/components/ui/cx'
import { Money } from '@/components/ui/Money'
import { Pill } from '@/components/ui/Pill'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'
import {
  BODY_ROW_CLASS,
  Cell,
  HeadCell,
  LoadMoreFooter,
  TABLE_CLASS,
  TableNotice,
  TBODY_CLASS,
  THEAD_CLASS,
  useKeysetRows,
  type LoadMore,
} from './tableShell'
import { feeBreakdown, walletDeltaWei } from './walletDelta'

export type TradesTableProps = {
  readonly rows: readonly TradeRow[]
  readonly nextCursor: string | null
  /** Miktar kolonunun basligina konur: "Amount (PEPE)". */
  readonly symbol?: string
  /** Bos durumdaki baglantinin hedefi -- al-sat paneli. */
  readonly tradePanelHref?: string
  readonly loadMore?: LoadMore<TradeRow>
  /** Yas hesabinin referans ani. Testler sabitler; uretimde `Date.now()`. */
  readonly now?: number
  readonly className?: string
}

/**
 * YAS `block_time`'DAN, VE YALNIZCA GOSTERIM ICIN.
 *
 * Siralama `event_seq` uzerindedir, cunku olculdu (003_trades_and_curve_state.sql):
 * 553 ardisik blok ciftinin %49'u AYNI timestamp'i tasiyor. Yani zaman bir
 * siralama anahtari degil; burada da yalnizca "ne kadar once" sorusunu yanitlar.
 *
 * GELECEK BIR `block_time` NEGATIF YAS URETMEZ. Sunucunun saati ile
 * kullanicinin saati arasindaki fark bir kac saniye olabilir ve "-3s" yazan bir
 * satir bir hata gibi gorunur; alt sinir sifirdir.
 */
export function relativeAge(blockTime: string, now: number): string {
  const at = Date.parse(blockTime)
  if (Number.isNaN(at)) return '—'
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * TOOLTIP ORAN DEGIL MUTLAK DEGER GOSTERIR.
 *
 * Olculdu (K2): 1,000000 USDC butceli bir `buyExactQuoteIn`'de toplam ucret
 * butcenin %1,2345679'u -- %1,25'i DEGIL, cunku %1,25 CURVE tutarinin
 * uzerindedir, butcenin degil. "Fee 1.25%" yazip yanina mutlak sayiyi koymak,
 * aritmetigi kullaniciya tutarsiz gosterir. Bu yuzden burada hicbir yerde
 * yuzde yok: uc mutlak tutar ve aralarindaki isaret.
 *
 * Yonler `<Money>`'nin kuralindan: alimda odenen her sey YUKARI (kullanici
 * odeyecekten azini gormesin), satimda ele gecen tutar ASAGI (var olmayan
 * parayi gostermesin) ve ucretler her zaman YUKARI (ucret bir maliyettir).
 */
export function feeSentence(row: TradeRow): string {
  const { curveWei, protocolWei, creatorWei } = feeBreakdown(row)
  const total = formatUsdcAmount(walletDeltaWei(row), { rounding: row.is_buy ? 'up' : 'down' })
  const curve = formatUsdcAmount(curveWei, { rounding: row.is_buy ? 'up' : 'down' })
  const protocol = formatUsdcAmount(protocolWei, { rounding: 'up' })
  const creator = formatUsdcAmount(creatorWei, { rounding: 'up' })

  return row.is_buy
    ? `Paid ${total} USDC: ${curve} to the curve, plus ${protocol} protocol fee and ${creator} creator fee.`
    : `Received ${total} USDC: ${curve} from the curve, less ${protocol} protocol fee and ${creator} creator fee.`
}

/**
 * `virtual_*` REZERVLER O SATIRIN KENDI ANLIK GORUNTUSUDUR.
 *
 * Token'in BUGUNKU rezervlerinden hesaplansaydi butun satirlar ayni fiyati
 * gosterirdi ve kolon hicbir sey soylemezdi. Satirin kendi rezervleriyle
 * hesaplandiginda kolon asagi dogru okundugunda fiyat yorungesini verir.
 *
 * Sifir token rezervi zincirde MUMKUN DEGIL (sanal rezerv hep pozitif), ama
 * `priceWeiPerToken` orada `ZeroReserve` firlatir ve bir tablo satirinda
 * firlayan bir istisna butun sayfayi goturur. Bozuk bir satir en fazla kendi
 * hucresini kaybeder.
 */
export function rowPrice(row: TradeRow): string {
  try {
    return formatPriceWeiPerToken(
      priceWeiPerToken(
        BigInt(row.virtual_quote_reserves_wei),
        BigInt(row.virtual_token_reserves_tok),
      ),
    )
  } catch (error) {
    if (error instanceof CurveMathError || error instanceof RangeError) return '—'
    throw error
  }
}

/**
 * SON ISLEMLER.
 *
 * USDC KOLONU `walletDeltaWei`'DIR, `quote_amount_wei` DEGIL. `Trade` olayi uc
 * alani ayri tasidigi icin iki farkli sayi hesaplanabilir; ekranda dogru olan,
 * kullanicinin banka ekstresiyle uyusandir. Formul TEK yerde durur
 * (`walletDelta.ts`) ve Task 12'nin onay ekrani ayni fonksiyonu cagirir.
 *
 * `is_dev` `row.is_dev`'DEN GELIR. Bu bilesen `fee_creator`'i PROP OLARAK BILE
 * ALMAZ, ve bu bilerek: creator degistirilebilir (Faz 1d), dolayisiyla bugunun
 * creator'iyla eski bir islemi karsilastirmak gecmisi yanlis boyar. Alani
 * indexer noktasal olarak (`creator_at(token, seq)`) turetir; arayuzun elinde
 * karsilastiracak bir sey OLMAMASI, o karsilastirmanin bir daha yazilamamasinin
 * en ucuz garantisidir.
 */
export function TradesTable({
  rows,
  nextCursor,
  symbol,
  tradePanelHref = '#trade',
  loadMore,
  now,
  className,
}: TradesTableProps) {
  const keyset = useKeysetRows(rows, nextCursor, loadMore)
  const at = now ?? Date.now()

  if (keyset.rows.length === 0) {
    return (
      <TableNotice
        title="No trades yet. Be the first."
        body="Nothing has traded on this curve. The first buy sets the opening print."
        action={
          <a
            href={tradePanelHref}
            className={buttonClassName({ variant: 'primary', size: 'sm', className: 'mt-1' })}
          >
            Buy this token
          </a>
        }
      />
    )
  }

  return (
    <div className={cx('rounded-card border border-border bg-surface', className)}>
      <table role="table" className={TABLE_CLASS}>
        <caption className="sr-only">
          Recent trades, newest first. Amounts are what left or entered the wallet, fees included.
        </caption>
        <thead role="rowgroup" className={THEAD_CLASS}>
          <tr role="row" className="border-b border-border">
            <HeadCell>Type</HeadCell>
            <HeadCell numeric>{symbol ? `Amount (${symbol})` : 'Amount'}</HeadCell>
            <HeadCell numeric>Price</HeadCell>
            <HeadCell numeric>USDC</HeadCell>
            <HeadCell>Trader</HeadCell>
            <HeadCell numeric>Age</HeadCell>
          </tr>
        </thead>

        <tbody role="rowgroup" className={TBODY_CLASS}>
          {keyset.rows.map((row) => {
            const sentence = feeSentence(row)
            return (
              <tr role="row" key={row.event_seq} className={BODY_ROW_CLASS}>
                <Cell label="Type">
                  {/*
                    YON HEM OK HEM SOZCUK. Renk tek basina anlam tasimazsa
                    kirmizi/yesil ayrimini goremeyen kullanici da satiri okur --
                    ve bu urunde satirin yonu, satirin kendisidir. Ok
                    `aria-hidden`: ekran okuyucu "ucgen yukari Buy" degil "Buy"
                    duyar.
                  */}
                  <span
                    className={cx('font-medium', row.is_buy ? 'text-positive' : 'text-negative')}
                  >
                    <span aria-hidden="true">{row.is_buy ? '▲' : '▼'}</span>{' '}
                    {row.is_buy ? 'Buy' : 'Sell'}
                  </span>
                </Cell>

                <Cell label="Amount" numeric>
                  {formatTokenAmount(BigInt(row.token_amount_tok))}
                </Cell>

                <Cell label="Price" numeric>
                  {rowPrice(row)}
                </Cell>

                {/*
                  `title` fareyle gelen icin, `VisuallyHidden` ekran okuyucu
                  icin: ikisi de AYNI cumleyi tasir, yani dokum bir gorme
                  bicimine bagli degil.
                */}
                <Cell label="USDC" numeric title={sentence}>
                  <Money native={walletDeltaWei(row)} rounding={row.is_buy ? 'up' : 'down'} />
                  <VisuallyHidden>{` ${sentence}`}</VisuallyHidden>
                </Cell>

                <Cell label="Trader">
                  <span className="inline-flex items-center gap-2">
                    <Address value={row.trader} label="Trader" explorer />
                    {row.is_dev ? <Pill tone="accent">dev</Pill> : null}
                  </span>
                </Cell>

                <Cell label="Age" numeric>
                  {/*
                    Sunucunun ve tarayicinin `now`'u birkac yuz ms ayrilir ve
                    "59s" ile "1m" arasindaki sinir tam oraya dusebilir. Bu bir
                    hidrasyon HATASI degil, zamana bagli bir degerin dogasi.
                  */}
                  <time dateTime={row.block_time} suppressHydrationWarning>
                    {relativeAge(row.block_time, at)}
                  </time>
                </Cell>
              </tr>
            )
          })}
        </tbody>
      </table>

      <LoadMoreFooter state={keyset} label="Load more trades" />
    </div>
  )
}
