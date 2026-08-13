import type { ReactNode } from 'react'
import { LiveNumber } from '@/components/ui/LiveNumber'

/**
 * ============================================================================
 *  BES SAYI, TEK SERIT, DIKEY AYIRICILARLA
 * ============================================================================
 *
 * FDV · Fiyat · 24s hacim · Likidite · Holder. Referans tasarimin ust seridi
 * budur ve sirasi rastgele degil: bir kullanicinin sordugu sirayla -- "ne
 * kadar buyuk", "kacdan", "ne kadar isliyor", "cikabilir miyim", "kac kisi".
 *
 * AYIRICI `border-l`, BOSLUK DEGIL. Bes sayiyi yalnizca bosluklarla ayirmak,
 * dar ekranda ikisinin birbirine yapismasi demektir; cizgi hangi sayinin
 * hangi baslikla gittigini her genislikte belli eder.
 *
 * BES SAYININ BESI DE SAYARAK DEGISIR (`LiveNumber`). Bu serit `LiveRefresh`
 * ile on saniyede bir yenilenir ve bir islem gectiginde FDV, fiyat, hacim,
 * likidite ve holder sayisi AYNI ANDA siçrardi. Sayarak gecmek, degisenin
 * hangisi oldugunu ve hangi yone gittigini gorunur kilar -- ve bu sayfada
 * "az once ne oldu" sorusunun tek cevabi odur.
 *
 * BILINMEYEN BIR DEGER "—" YAZAR, SIFIR YAZMAZ. Bir sayfanin "0 holder"
 * demesi ile "bilmiyoruz" demesi ayni sey degildir, ve indexer dustugunde
 * ikincisi dogru olandir. Bu ayrim bu depoda `StatRow`da zaten kayitli;
 * burada da aynen gecerlidir.
 */
export function TokenStatStrip({
  marketCapWei,
  changePercent,
  priceWeiPerToken,
  volume24hWei,
  sellSharePercent,
  liquidityWei,
  holderCount,
}: {
  marketCapWei: bigint
  /** 24 saatlik degisim. `null` = olculemedi (yeterli gecmis yok). */
  changePercent: number | null
  priceWeiPerToken: bigint
  volume24hWei: bigint | null
  /** 24s hacmin yuzde kaci SATIS. `null` = hic islem yok. */
  sellSharePercent: number | null
  /** Curve'de duran quote -- bir satisin karsilanabilecegi tutar. */
  liquidityWei: bigint
  holderCount: number | null
}) {
  return (
    <dl
      data-testid="token-stat-strip"
      className="grid grid-cols-2 gap-y-5 sm:grid-cols-3 lg:grid-cols-5"
    >
      <Cell label="FDV">
        <Value>
          <LiveNumber value={marketCapWei} format="usdc" />
        </Value>
        {changePercent === null ? null : <Change percent={changePercent} />}
      </Cell>

      <Cell label="Price" divider>
        <Value>
          {/*
            FIYAT KISALTILMAZ ve sifir dizisi SIKISTIRILIR: bir memecoin'in
            fiyati 0.00000452 olabilir ve iki ondalikli bir hucre hicbir sey
            soylemez. `price` bicimi bu deponun sifir-alt-simge gosterimini
            (0.0(7)5878) tasiyor -- ikinci bir bicim yazmak, ayni sayinin iki
            sayfada iki turlu gorunmesi demek olurdu.
          */}
          <LiveNumber value={priceWeiPerToken} format="price" />
        </Value>
      </Cell>

      <Cell label="24H volume" divider>
        <Value>
          {volume24hWei === null ? (
            <span className="text-muted">&mdash;</span>
          ) : (
            <LiveNumber value={volume24hWei} format="usdc" />
          )}
        </Value>
        {sellSharePercent === null ? null : (
          <span className="text-[12px] text-negative">
            <LiveNumber value={BigInt(Math.round(sellSharePercent * 10))} format="percent1" /> sells
          </span>
        )}
      </Cell>

      <Cell label="Liquidity" divider>
        <Value>
          <LiveNumber value={liquidityWei} format="usdc" />
        </Value>
      </Cell>

      <Cell label="Holders" divider>
        <Value>
          {holderCount === null ? (
            <span className="text-muted">&mdash;</span>
          ) : (
            <LiveNumber value={BigInt(holderCount)} format="count" />
          )}
        </Value>
      </Cell>
    </dl>
  )
}

function Cell({
  label,
  divider = false,
  children,
}: {
  label: string
  divider?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={[
        'flex flex-col gap-1 px-4 first:pl-0',
        // Ayirici YALNIZCA satirin ilk hucresinde gizlenir; sarma oldugunda
        // alt satirin ilk hucresi de solda cizgisiz kalir.
        divider ? 'border-l border-border' : '',
      ].join(' ')}
    >
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-2">{children}</dd>
    </div>
  )
}

function Value({ children }: { children: ReactNode }) {
  return <span className="text-[22px] font-medium leading-none tabular-nums">{children}</span>
}

/**
 * Yuzde degisim, isaretiyle.
 *
 * UCGEN KARAKTERI RENGE EK OLARAK: kirmizi/yesil tek basina, renk korlugu
 * olan bir kullanici icin hicbir sey soylemez. Isaret ve yon birlikte gider.
 */
function Change({ percent }: { percent: number }) {
  const down = percent < 0
  return (
    <span
      className={`text-[12px] tabular-nums ${down ? 'text-negative' : 'text-accent'}`}
      data-testid="stat-change"
    >
      <span aria-hidden="true">{down ? '▾' : '▴'}</span>{' '}
      {/* ISARETLI gecilir; bkz. `percent1`. Ok isareti tasir, metin tasimaz. */}
      <LiveNumber value={BigInt(Math.round(percent * 10))} format="percent1" />
    </span>
  )
}
