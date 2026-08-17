import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatTokenAmount, formatUsdcCompact } from '@arcpad/shared/browser'
import { LiveNumber } from '@/components/ui/LiveNumber'
import type { HolderRow, TradeRow } from '@/components/read/types'
import { Address } from '@/components/ui/Address'
import { NumberedPager } from '@/components/explore/NumberedPager'

/**
 * ============================================================================
 *  ISLEMLER VE HOLDER'LAR -- IKI SEKME, SUNUCUDA
 * ============================================================================
 *
 * Sekmeler `<Link>`, tablolar sunucuda cizilir, sayfalar numarali. Ucu de bu
 * deponun `FilterBar`da yazili gerekcesini paylasir: JS gelmeden calisir, her
 * sekme ve her sayfa PAYLASILABILIR bir adrestir, ve geri dugmesi calisir.
 *
 * UCUNCU BIR SEKME YOK. Referans tasarimda "Top traders" da var; bu urunde
 * BILINCLI OLARAK yok. Onu cizmek, kimin kazandigini bir tabloya yazmak
 * demektir ve bir launchpad'de o tablo bir pazarlama yuzeyine donusur.
 */

export type ActivityTab = 'activity' | 'holders'

export function tabOf(value: string | undefined): ActivityTab {
  return value === 'holders' ? 'holders' : 'activity'
}

export function ActivityTabs({
  tab,
  trades,
  holders,
  holderCount,
  tradeCount,
  symbol,
  curve,
  creator,
  page,
  pageSize,
  basePath,
  query,
  totalSupplyTok,
  priceWeiPerToken,
  now,
}: {
  tab: ActivityTab
  trades: readonly TradeRow[]
  holders: readonly HolderRow[]
  holderCount: number
  tradeCount: number
  symbol: string
  curve: string
  creator: string
  page: number
  pageSize: number
  basePath: string
  /** `?tab` ve `?p` DISINDAKI parametreler -- korunurlar. */
  query: Readonly<Record<string, string>>
  totalSupplyTok: bigint
  priceWeiPerToken: bigint
  /**
   * Istek ani -- SAYFADAN gelir, burada olculmez.
   *
   * `new Date()` bu bileşenin icinde cagrilsaydi sunucu ile istemci iki
   * farkli an olcerdi. Sayfa zaten bir `now` tasiyor (mum bosluklarini
   * doldurmak icin) ve tek bir an, sayfanin her yerinde ayni cevabi verir.
   */
  now: Date
}) {
  const total = tab === 'activity' ? tradeCount : holderCount

  return (
    <section className="flex flex-col gap-4" data-testid="activity-tabs">
      <nav aria-label="Token tables" className="flex items-center gap-6">
        <TabLink
          href={hrefFor(basePath, query, 'activity')}
          active={tab === 'activity'}
          label="Activity"
        />
        <TabLink
          href={hrefFor(basePath, query, 'holders')}
          active={tab === 'holders'}
          /*
            Sayi ETIKETIN ICINDE: "13,000 holders" tek bir sey soyler,
            "Holders (13,000)" iki sey soyler ve ikincisi daha yavas okunur.

            TEKIL DE YAZILIR. Canli sayfada "1 holders" goruldu; kucuk bir sey
            ama yeni bir token'in sayfasinda HER ZAMAN gorunen sey odur --
            yani urunun ilk izlenimi, yanlis yazilmis bir cumle oluyordu.
          */
          label={
            <>
              <LiveNumber value={BigInt(holderCount)} format="count" />{' '}
              {holderCount === 1 ? 'holder' : 'holders'}
            </>
          }
        />
      </nav>

      {tab === 'activity' ? (
        <TradeTable rows={trades} symbol={symbol} now={now} />
      ) : (
        <HolderTable
          rows={holders}
          curve={curve}
          creator={creator}
          totalSupplyTok={totalSupplyTok}
          priceWeiPerToken={priceWeiPerToken}
        />
      )}

      {/*
        TOPLAM SAYILMISSA sayfalar cizilir. `NumberedPager` toplam olmadan HIC
        cizilmez -- numara listesi toplam olmadan uydurulur, ve uydurulmus bir
        "3 sayfa" kullaniciyi olmayan bir sayfaya goturur.
      */}
      {total > pageSize ? (
        <NumberedPager
          basePath={basePath}
          query={{ ...query, tab }}
          page={page}
          pageSize={pageSize}
          total={total}
          label={tab === 'activity' ? 'Trade pages' : 'Holder pages'}
        />
      ) : null}
    </section>
  )
}

function hrefFor(
  basePath: string,
  query: Readonly<Record<string, string>>,
  tab: ActivityTab,
): string {
  const params = new URLSearchParams(query)
  params.set('tab', tab)
  // SAYFA NUMARASI SIFIRLANIR. Islemlerin 4. sayfasindayken holder sekmesine
  // gecmek, holder'larin 4. sayfasina DUSMEMELI -- muhtemelen yoktur ve
  // kullanici bos bir tabloya bakar.
  params.delete('p')
  return `${basePath}?${params.toString()}`
}

function TabLink({
  href,
  active,
  label,
}: {
  href: string
  active: boolean
  /*
    `ReactNode`, `string` DEGIL: holder sekmesinin etiketi bir SAYI tasiyor
    ve o sayi `LiveNumber` ile sayarak degisiyor. Dize olsaydi sayfanin geri
    kalaninda animasyonlu olan bir deger yalnizca burada sicrardi.
  */
  label: ReactNode
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'page' : undefined}
      className={[
        'text-[15px] transition-colors duration-150',
        active ? 'font-medium text-text' : 'text-muted hover:text-text',
      ].join(' ')}
    >
      {label}
    </Link>
  )
}

/* ========================================================================== */

/**
 * ISLEM TABLOSU: Zaman · Yon · Deger · Token · Fiyat · Trader.
 *
 * KOLON SIRASI REFERANSIN SIRASI ve tesaduf degil: bir kullanici once NE
 * ZAMAN ve NE YONDE oldugunu, sonra NE KADAR oldugunu, en son KIM oldugunu
 * sorar. Adres en saga konur cunku en genis ve en az okunan alandir.
 */
function TradeTable({
  rows,
  symbol,
  now,
}: {
  rows: readonly TradeRow[]
  symbol: string
  /** Istek ani. Tarihin YAZILIP yazilmayacagini bu belirler. */
  now: Date
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-card border border-border bg-surface px-5 py-6 text-[13px] text-muted">
        No trades yet.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-card border border-border">
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-surface-2 text-left text-[12px] text-muted">
            <Th>Time</Th>
            <Th>Trade</Th>
            <Th title="What reached the curve, after the 1.25% fee">Value</Th>
            <Th>{symbol}</Th>
            <Th>Price</Th>
            <Th>Trader</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.eventSeq.toString()} className="border-t border-border">
              <Td className="text-muted tabular-nums">{clockTime(row.blockTime, now)}</Td>
              <Td>
                <span className={row.isBuy ? 'text-[#4ade80]' : 'text-[#f87171]'}>
                  {row.isBuy ? 'Buy' : 'Sell'}
                </span>
              </Td>
              <Td className="tabular-nums">{formatUsdcCompact(row.quoteAmountWei)}</Td>
              <Td className="tabular-nums">{compactTokens(row.tokenAmountTok)}</Td>
              <Td className="text-muted tabular-nums">
                {/*
                  FIYAT KOLONU FDV OKUR, birim fiyat degil -- referans tasarim
                  da oyle. Sebep okunabilirlik: birim fiyat 0.0000000452 gibi
                  bir sayidir ve bir kolonda kiyaslanamaz; FDV ayni bilgiyi
                  1e9 ile olceklenmis, karsilastirilabilir halde tasir.
                */}
                {formatUsdcCompact(fdvOf(row))} FDV
              </Td>
              <Td>
                <span className="inline-flex items-center gap-2">
                  <Dot seed={row.trader} />
                  <Address value={row.trader} />
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Bir islemin ANINDAKI FDV'si: mulDiv(Vq, N, Vt).
 *
 * `migrations/007_views.sql:46` ile AYNI ifade. Satirin kendi rezervleri
 * uzerinden hesaplanir, yani gecmis bir islem BUGUNKU fiyatla degil KENDI
 * anindaki fiyatla yazilir -- ikisi karistirilirsa tablo, olmamis bir gecmis
 * anlatir.
 */
function fdvOf(row: TradeRow): bigint {
  if (row.virtualTokenReservesTok === 0n) return 0n
  return (row.virtualQuoteReservesWei * 10n ** 27n) / row.virtualTokenReservesTok
}

/* ========================================================================== */

/**
 * HOLDER TABLOSU: # · Cuzdan · % arz · Token · Deger.
 *
 * CURVE'UN KENDISI DE LISTELENIR ama NUMARASIZ ve "Liquidity" rozetiyle --
 * referans tasarimdaki gibi. Sebep durustluk: curve'de duran arz gercekten
 * oradadir ve onu gizlemek, ilk on cuzdanin payini oldugundan buyuk gosterir.
 * Numarasiz cunku bir "holder" degil, bir kontrattir.
 */
function HolderTable({
  rows,
  curve,
  creator,
  totalSupplyTok,
  priceWeiPerToken,
}: {
  rows: readonly HolderRow[]
  curve: string
  creator: string
  totalSupplyTok: bigint
  priceWeiPerToken: bigint
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-card border border-border bg-surface px-5 py-6 text-[13px] text-muted">
        No holders yet.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-card border border-border">
      <table className="w-full min-w-[560px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-surface-2 text-left text-[12px] text-muted">
            <Th>#</Th>
            <Th>Wallet</Th>
            <Th>% supply</Th>
            <Th>Tokens</Th>
            <Th title="What reached the curve, after the 1.25% fee">Value</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isCurve = row.holder.toLowerCase() === curve.toLowerCase()
            const isCreator = row.holder.toLowerCase() === creator.toLowerCase()
            return (
              <tr key={row.holder} className="border-t border-border">
                <Td className="text-muted tabular-nums">
                  {isCurve ? <span aria-label="not ranked">&ndash;</span> : index + 1}
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-2">
                    <Dot seed={row.holder} />
                    <Address value={row.holder} />
                    {isCurve ? <Tag>Liquidity</Tag> : null}
                    {isCreator ? <Tag>Creator</Tag> : null}
                  </span>
                </Td>
                <Td className="tabular-nums">{supplyPercent(row.balanceTok, totalSupplyTok)}%</Td>
                <Td className="tabular-nums">{compactTokens(row.balanceTok)}</Td>
                <Td className="tabular-nums">
                  {formatUsdcCompact((row.balanceTok * priceWeiPerToken) / 10n ** 18n)}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ========================================================================== */

function Th({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <th className="px-4 py-2.5 font-normal" title={title}>
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 ${className ?? ''}`}>{children}</td>
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full ${1}text-muted-raised">{children}</span>
}

/**
 * Adresten deterministik bir renk noktasi.
 *
 * Referans tasarimda her cuzdanin yaninda renkli bir daire var ve isi
 * TANIMA: ayni adres bir listede iki kez gecince, goz onu adresi okumadan
 * eslestirir. Renk adresten TURETILIR, atanmaz -- bir tablo ile bir sonrakinde
 * ayni cuzdanin ayni rengi olmasi ancak boyle garanti edilir.
 */
function Dot({ seed }: { seed: string }) {
  let hash = 0x811c9dc5
  for (const ch of seed.toLowerCase()) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const hue = hash % 360
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: `oklch(0.72 0.16 ${hue})` }}
    />
  )
}

/**
 * `3:25 AM` bugunse, `12 Aug 3:25 AM` degilse.
 *
 * ============ TARIHSIZ BIR SAAT YALAN SOYLER ============
 *
 * OLCULDU, ve beni de yanaltti: bu tabloda "2:56 AM" yazan bir islem 35 saat
 * onceydi. Sadece saati okuyan biri onu BUGUN sanir -- ve o kisi, ustteki
 * "24H volume $0.00" ile alttaki dolu islem listesini yan yana gorup urunde
 * bir hata oldugu sonucuna varir. Oysa ikisi de dogruydu; eksik olan tek sey
 * gunun kendisiydi.
 *
 * Tarih YALNIZCA gerektiginde yazilir: bugunku islemlerin hepsine tarih
 * koymak, canli bir sayfada her satiri ayni ve gereksiz bir metinle
 * uzatirdi.
 *
 * Bu bir SUNUCU bileseni, yani `now` istek anindadir ve istemcide yeniden
 * hesaplanmaz -- hidrasyon uyusmazligi olamaz. Locale ve saat dilimi ACIKCA
 * verilir; kutunun yereline birakilan bir tarih, sunucu ile tarayicinin
 * farkli metinler uretmesi demektir.
 */
function clockTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  })
  const sameDay =
    at.getUTCFullYear() === now.getUTCFullYear() &&
    at.getUTCMonth() === now.getUTCMonth() &&
    at.getUTCDate() === now.getUTCDate()
  if (sameDay) return time
  const day = at.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
  return `${day} ${time}`
}

/** `22.1K`, `250.7K`, `41` -- token miktarlari icin kisa bicim. */
function compactTokens(tok: bigint): string {
  const whole = tok / 10n ** 18n
  if (whole >= 1_000_000_000n) return `${(Number(whole / 1_000_000n) / 1_000).toFixed(1)}B`
  if (whole >= 1_000_000n) return `${(Number(whole / 1_000n) / 1_000).toFixed(1)}M`
  if (whole >= 1_000n) return `${(Number(whole) / 1_000).toFixed(1)}K`
  // BIN'IN ALTINDA ONDALIK YOK: "41" bir adet sayisidir, "41.0" bir olcum.
  if (whole > 0n) return whole.toLocaleString('en-US')
  return formatTokenAmount(tok)
}

/** Arzdaki pay, bir ondalikla, `bigint` uzerinde yuvarlanarak. */
function supplyPercent(part: bigint, total: bigint): string {
  if (total === 0n) return '0.0'
  const tenths = (part * 2_000n + total) / (total * 2n)
  return `${tenths / 10n}.${tenths % 10n}`
}
