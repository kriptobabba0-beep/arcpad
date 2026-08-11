import Image from 'next/image'
import { cx } from './cx'

/**
 * USDC'NIN RESMI ISARETI, VE YANINDA ADI.
 *
 * ISARET `aria-hidden`, AD OKUNUR. Bir ekran okuyucu icin daire bir bilgi
 * degildir; "USDC" kelimesidir. Gorsel isaret onun yerine GECMEZ, yanina
 * durur -- ve `alt=""` ile dekoratif oldugu soylenir, cunku ayni bilgiyi iki
 * kez duyurmak (bir resim adi + bir metin) gurultudur.
 *
 * `/usdc.svg` KENDI ORIJINIMIZDEN gelir ve bu bir zorunluluk: `next.config.ts`
 * CSP'si `img-src 'self' data: <gateway>` diyor, yani uzak bir CDN'den
 * cekilen bir logo tarayici tarafindan REDDEDILIRDI. Dosya `web/public/`
 * altinda, Circle'in verdigi SVG'nin kendisi.
 *
 * `next/image` DEGIL DUZ `<img>` KULLANILMIYOR: SVG icin `next/image`'in
 * optimizasyonu devre disidir ve dosya oldugu gibi servis edilir; kazanc
 * `width`/`height`in zorunlu olmasi, yani yer ayrilmasi ve yuklenirken sayfa
 * ZIPLAMAMASI.
 */
export function UsdcMark({
  size = 16,
  withLabel = true,
  className,
}: {
  size?: number
  /** `false` ise yalnizca isaret cizilir -- yeri dar olan yerler icin. */
  withLabel?: boolean
  className?: string
}) {
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1.5 align-baseline', className)}>
      <Image
        src="/usdc.svg"
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className="shrink-0 rounded-full"
      />
      {withLabel ? <span>USDC</span> : <span className="sr-only">USDC</span>}
    </span>
  )
}
