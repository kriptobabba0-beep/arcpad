import Link from 'next/link'

/**
 * ============================================================================
 *  GRAFIK KONTROLLERI -- `<Link>`, ACILIR MENU DEGIL
 * ============================================================================
 *
 * Referans tasarimda bunlar birer acilir menu gibi gorunur. Burada birer
 * baglanti, ve sebebi `FilterBar`in bu depodaki gerekcesiyle ayni: JS gelmeden
 * calisir, her secim PAYLASILABILIR bir adres uretir, ve tarayicinin geri
 * dugmesi onceki secime doner. Bir `onClick` menusu ucunu de kaybettirir ve
 * karsiliginda hicbir sey vermez -- sayfa zaten bir server component ve mumlar
 * SUNUCUDA hesaplaniyor.
 *
 * `scroll={false}` ZORUNLU. Kullanici grafige bakarken "6H"e basiyor; sayfa
 * basa firlarsa baktigi sey gozunden kaybolur. Ayni kural bu depoda
 * `FilterBar` ve `NumberedPager` icin de yaziliydi.
 */

/**
 * ZAMAN DILIMLERI VE KOVA SANIYELERI, TEK YERDE.
 *
 * Etiket ile saniye yan yana durur cunku ikisini iki dosyada tutmak, "1H"
 * yazip alti saatlik kova cizen bir grafigin yoludur -- ve o hata ekranda
 * dogru gorunur.
 */
export const TIMEFRAMES = [
  { key: '5m', label: '5M', seconds: 300 },
  { key: '1h', label: '1H', seconds: 3_600 },
  { key: '6h', label: '6H', seconds: 21_600 },
  { key: '24h', label: '24H', seconds: 86_400 },
] as const

export type TimeframeKey = (typeof TIMEFRAMES)[number]['key']

export function timeframeSeconds(key: string | undefined): number {
  return TIMEFRAMES.find((t) => t.key === key)?.seconds ?? 3_600
}

export function timeframeKey(key: string | undefined): TimeframeKey {
  return (TIMEFRAMES.find((t) => t.key === key)?.key ?? '1h') as TimeframeKey
}

/**
 * `?tf=` ve `?metric=` DISINDAKI parametreler KORUNUR.
 *
 * Sayfa bir sekme (`?tab=`) ve bir sayfa numarasi (`?p=`) da tasiyor. Zaman
 * dilimini degistirmek kullanicinin actigi holder sekmesini kapatmamali --
 * yeni bir `URLSearchParams` kurup yalnizca bir anahtari yazmak, geri kalan
 * her seyi SESSIZCE silmenin klasik yoludur.
 */
function hrefWith(
  current: Readonly<Record<string, string | undefined>>,
  patch: Readonly<Record<string, string>>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(current)) {
    if (value !== undefined && value !== '') params.set(key, value)
  }
  for (const [key, value] of Object.entries(patch)) params.set(key, value)
  const query = params.toString()
  return query === '' ? '?' : `?${query}`
}

export function TimeframePicker({
  active,
  params,
  ariaLabel = 'Chart timeframe',
}: {
  active: TimeframeKey
  params: Readonly<Record<string, string | undefined>>
  ariaLabel?: string
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="flex shrink-0 items-center gap-0.5 rounded-pill bg-surface-2 p-1"
    >
      {TIMEFRAMES.map((tf) => {
        const on = tf.key === active
        return (
          <Link
            key={tf.key}
            href={hrefWith(params, { tf: tf.key })}
            scroll={false}
            aria-current={on ? 'true' : undefined}
            className={[
              'rounded-pill px-2.5 py-1 text-[12px] leading-none transition-colors duration-150',
              on ? 'bg-white/10 text-text' : 'text-muted hover:text-text',
            ].join(' ')}
          >
            {tf.label}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * FDV / Fiyat.
 *
 * IKISININ MUMLARI AYNI SEKILDEDIR ve bu bir tesaduf degil: fiyat, market
 * cap'in tam olarak 1e9'da biridir (`migrations/007_views.sql`: N = 1e27,
 * olcek 1e18). Yani secim EKSENIN NE OKUDUGUNU degistirir, mumlarin oranini
 * degil. Bunu bilmeden bakan biri "iki grafik ayni" diye bir kusur bildirirdi;
 * yorum bu yuzden burada.
 */
export function MetricPicker({
  active,
  params,
}: {
  active: 'fdv' | 'price'
  params: Readonly<Record<string, string | undefined>>
}) {
  const other = active === 'fdv' ? 'price' : 'fdv'
  return (
    <Link
      href={hrefWith(params, { metric: other })}
      scroll={false}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-[12px] leading-none text-text transition-colors duration-150 hover:border-white/20"
      data-testid="metric-picker"
    >
      {active === 'fdv' ? 'FDV' : 'Price'}
      <span aria-hidden="true" className="text-muted">
        ⌄
      </span>
    </Link>
  )
}
