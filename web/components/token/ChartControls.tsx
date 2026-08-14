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
  { key: '4h', label: '4H', seconds: 14_400 },
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
 * GRAFIK VE HACIM AYRI PARAMETRELER KULLANIR.
 *
 * Ikisi eskiden tek bir `?tf=` okuyordu, yani hacim penceresini degistirmek
 * mum kovasini da degistiriyordu ve tersi. Kullanicinin bildirdigi kusur tam
 * olarak buydu ve hakliydi: bunlar AYRI sorulardir. "Son 24 saatte ne kadar
 * islem gordu" ile "her mum kac dakika" arasinda hicbir bag yok.
 *
 * Adlar KISA cunku adreste gorunurler: grafik `tf`, hacim `vf`.
 */
export const CHART_TF_PARAM = 'tf'
export const VOLUME_TF_PARAM = 'vf'

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
  param = CHART_TF_PARAM,
}: {
  active: TimeframeKey
  params: Readonly<Record<string, string | undefined>>
  ariaLabel?: string
  /** `tf` grafigi, `vf` hacmi surer. Varsayilanin grafik olmasi bilincli:
   *  bu bileseni parametresiz kullanan tek yer grafik basligi. */
  param?: string
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
            href={hrefWith(params, { [param]: tf.key })}
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
 * MUM / CIZGI.
 *
 * Iki sekil AYNI VERIYI okur; secim yalnizca o verinin nasil cizildigidir.
 * Mum dort sayi (acilis/yuksek/dusuk/kapanis) gosterir ve islem goren bir
 * tokende dogru secimdir; cizgi TEK sayi (kapanis) gosterir ve az islemli bir
 * tokende daha okunakli, cunku orada mumlarin coğu tek islemliktir ve grafik
 * bir dizi ince cubuga donusur.
 *
 * Secim ADRESTE tutulur (`?shape=line`), bir istemci durumunda degil: baglanti
 * paylasilabilir olmali ve `LiveRefresh`in on saniyelik yenilemesi secimi
 * silmemeli.
 */
export function ShapePicker({
  active,
  params,
}: {
  active: 'candles' | 'line'
  params: Readonly<Record<string, string | undefined>>
}) {
  const other = active === 'candles' ? 'line' : 'candles'
  return (
    <Link
      href={hrefWith(params, { shape: other })}
      scroll={false}
      aria-label={`Switch to ${other === 'line' ? 'line' : 'candlestick'} chart`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-[12px] leading-none text-text transition-colors duration-150 hover:border-white/20"
      data-testid="shape-picker"
    >
      <span aria-hidden="true">{active === 'candles' ? '▦' : '∿'}</span>
      {active === 'candles' ? 'Candles' : 'Line'}
    </Link>
  )
}

/**
 * FDV -- VE ARTIK BIR SECIM DEGIL.
 *
 * Eskiden FDV ile Fiyat arasinda gecis yapiyordu. Kaldirildi cunku SECIM
 * DEGILDI: fiyat, market cap'in tam olarak 1e9'da biridir
 * (`migrations/007_views.sql`: N = 1e27, olcek 1e18). Yani iki secenek AYNI
 * mumlari, ayni oranlarda, yalnizca ekseni yeniden etiketleyerek ciziyordu.
 * Hicbir sey degistirmeyen bir dugme, kullanicinin "burada bir yanlislik var"
 * demesinin en hizli yoludur -- ve haklidir.
 *
 * Etiket DURUYOR: grafigin neyi cizdigini soylemek hala gerekli. Sadece artik
 * bir baglanti degil, bir BASLIK.
 */
export function MetricPicker() {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-[12px] leading-none text-text"
      data-testid="metric-picker"
    >
      FDV
    </span>
  )
}
