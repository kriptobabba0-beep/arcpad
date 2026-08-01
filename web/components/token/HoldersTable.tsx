'use client'

import { formatTokenAmount } from '@arcpad/shared/browser'
import type { HexAddress, HolderRow } from '@/components/read/types'
import { Address } from '@/components/ui/Address'
import { cx } from '@/components/ui/cx'
import { Pill } from '@/components/ui/Pill'
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
import { supplyPercent, TOTAL_SUPPLY_TOK } from './walletDelta'

export type HoldersTableProps = {
  readonly rows: readonly HolderRow[]
  readonly nextCursor: string | null
  /**
   * Yuzdenin paydasi. K3'te olculdu: `N = 1_000_000_000e18 = 1e27` ve SABITTIR
   * -- rezervlerden turetilmez. Prop brief'in imzasinda oldugu icin duruyor ve
   * varsayilani sabitin kendisidir; aritmetik tek yerde, `supplyPercent`'te.
   */
  readonly totalSupply?: bigint
  /** LISTEDEN CIKARILIR. Verilmezse curve satiri (varsa) listede kalir. */
  readonly curve?: HexAddress
  /**
   * `dev` rozeti BUNA gore verilir, `fee_creator`'a gore DEGIL: launch
   * creator'i kalicidir, ucreti alan cuzdan degistirilebilir.
   */
  readonly launchCreator?: HexAddress
  readonly symbol?: string
  readonly loadMore?: LoadMore<HolderRow>
  readonly className?: string
}

/**
 * Adres karsilastirmasi KUCUK HARFE INDIRGENEREK yapilir.
 *
 * Veritabani `^0x[0-9a-f]{40}$` CHECK'i ile kucuk harf zorluyor, ama bu
 * bilesene adres veren taraf `viem`'den gelen bir EIP-55 checksum dizesi de
 * tutabilir. Buyuk/kucuk harfe duyarli bir esitlik, curve satirinin listeye
 * geri sizmasi icin yeterlidir -- ve o satir tam olarak gizlenmek istenen sey.
 */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * AYNI HOLDER IKI KEZ CIZILMEZ.
 *
 * `holders` sorgusu `(balance_tok DESC, holder ASC)` ile sayfalanir ve IKINCI
 * anahtar Task 7'de tam da bunun icin eklendi: `balance_tok` tekil degildir,
 * yani tek anahtarli bir keyset'te esit bakiyeli satirlarin sirasi sayfalar
 * arasinda kayar ve ayni holder iki sayfada birden cikar. Asil duzeltme
 * SQL'dedir; buradaki eleme son savunma hatti, cunku tekrarlanan bir holder
 * satiri ekranda arzi CIFT sayar -- yuzdeler zaten toplamda %100 vermedigi
 * icin de kullanicinin bunu fark etmesinin bir yolu yoktur.
 */
function dedupeByHolder(rows: readonly HolderRow[]): readonly HolderRow[] {
  const seen = new Set<string>()
  const out: HolderRow[] = []
  for (const row of rows) {
    const key = row.holder.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/**
 * HOLDERS -- CURVE HARIC.
 *
 * Curve arzin satilmamis kismini tutar, yani "en buyuk holder curve" satiri her
 * token icin dogru ve hicbir sey soylemeyen bir satirdir; listeden cikar.
 * Bunun dogrudan sonucu: yuzdeler TOPLAMDA %100 VERMEZ. Tablonun altindaki tek
 * satir bunu soyler, cunku soylenmezse kullanici eksik yuzdeyi bir hata sanir
 * ve dogru olan sey bir hata gibi gorunur.
 *
 * Launch'tan hemen sonra bu liste BOSTUR (arzin tamami curve'de) ve bu, "curve
 * haric" kararinin dogrudan sonucudur -- bu yuzden "hic islem yok"tan AYRI bir
 * metin gerektirir.
 */
export function HoldersTable({
  rows,
  nextCursor,
  totalSupply = TOTAL_SUPPLY_TOK,
  curve,
  launchCreator,
  symbol,
  loadMore,
  className,
}: HoldersTableProps) {
  const keyset = useKeysetRows(rows, nextCursor, loadMore)

  const visible = dedupeByHolder(
    curve === undefined
      ? keyset.rows
      : keyset.rows.filter((row) => !sameAddress(row.holder, curve)),
  )

  // Locale ACIKCA en-US: kok eslint yapilandirmasi locale'siz `Intl`i
  // reddediyor ve sebebi CONTRIBUTING.md'de -- ayni sayi bir kullanicida
  // "1,000,000,000", digerinde "1.000.000.000" okunur.
  const wholeSupply = new Intl.NumberFormat('en-US').format(totalSupply / 10n ** 18n)

  if (visible.length === 0) {
    return (
      <TableNotice
        title="No holders yet — the curve holds the entire supply."
        body="Every token still sits on the bonding curve. The first buy creates the first holder."
      />
    )
  }

  return (
    <div className={cx('rounded-card border border-border bg-surface', className)}>
      <table role="table" className={TABLE_CLASS}>
        <caption className="sr-only">
          Token holders, largest first. The bonding curve is excluded.
        </caption>
        <thead role="rowgroup" className={THEAD_CLASS}>
          <tr role="row" className="border-b border-border">
            <HeadCell numeric>#</HeadCell>
            <HeadCell>Holder</HeadCell>
            <HeadCell numeric>{symbol ? `Balance (${symbol})` : 'Balance'}</HeadCell>
            {/*
              Paydayi basligin ustunde ISIMLENDIRIR. Ciplak bir "% of supply",
              bu sayfada IKI farkli yuzde oldugu icin (graduation ilerlemesi ve
              arz payi) neyin yuzdesi oldugunu saklar.
            */}
            <HeadCell numeric title={`Percent of the fixed ${wholeSupply} token supply`}>
              % of supply
            </HeadCell>
          </tr>
        </thead>

        <tbody role="rowgroup" className={TBODY_CLASS}>
          {visible.map((row, index) => (
            <tr role="row" key={row.holder} className={BODY_ROW_CLASS}>
              <Cell label="#" numeric className="text-muted">
                {index + 1}
              </Cell>

              <Cell label="Holder">
                <span className="inline-flex items-center gap-2">
                  <Address value={row.holder} label="Holder" explorer />
                  {launchCreator !== undefined && sameAddress(row.holder, launchCreator) ? (
                    <Pill tone="accent">dev</Pill>
                  ) : null}
                </span>
              </Cell>

              <Cell label="Balance" numeric>
                {formatTokenAmount(BigInt(row.balance_tok))}
              </Cell>

              {/*
                Tamamen bigint. `Number(balance) / Number(1e27)` IEEE-754'te
                anlamli basamaklarin cogunu atar ve iki farkli holder ayni
                yuzdeyi gosterebilir.
              */}
              <Cell label="% of supply" numeric>
                {supplyPercent(row.balance_tok)}%
              </Cell>
            </tr>
          ))}
        </tbody>
      </table>

      {/*
        DIPNOT SILINEBILIR BIR SUS DEGIL. Curve listeden cikarildigi icin
        yuzdeler toplamda %100 vermez; bunu soylemeyen bir tablo, dogru olan
        seyi bir hata gibi gosterir.
      */}
      <p className="border-t border-border px-3 py-2.5 text-[12px] text-muted">
        Excludes the curve, which holds the unsold supply.
      </p>

      <LoadMoreFooter state={keyset} label="Load more holders" />
    </div>
  )
}
