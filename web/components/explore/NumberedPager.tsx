import Link from 'next/link'
import { buttonClassName } from '@/components/ui/Button'
import { cx } from '@/components/ui/cx'
import { pageNumbers } from './pageNumbers'

/**
 * NUMARALI SAYFALAR (`1 2 3 … 12`), VE BEDELI YAZILI.
 *
 * `KeysetPager` bunu bilerek YAPMIYORDU ve gerekcesi hala dogru: numarali
 * sayfa `OFFSET` ister, `OFFSET` de CANLI bir siralama anahtarinda satir
 * tekrarlatir ya da atlatir -- iki sorgu arasinda bir alim gelirse butun liste
 * bir kayar ve 2. sayfanin son satiri 3. sayfanin ilki olur.
 *
 * Urun yine de numarali sayfa istedi, o yuzden bu bilesen var ve bedel BURADA
 * yazili, gizlenmis degil:
 *
 *   `newest` / `oldest` -> BEDEL YOK. `created_seq` bir daha degismez, yani
 *                          bu iki sekmede numarali sayfalama TAM DOGRUDUR.
 *   `trending` / `top` / `nearGraduation` -> siralama anahtari her islemde
 *                          degisir; sayfa sinirinda kayma MUMKUNDUR.
 *
 * `KeysetPager` SILINMEDI: token sayfasindaki islem ve tutucu listeleri onu
 * kullaniyor ve orada dogru olan odur.
 *
 * `scroll={false}` HER BAGLANTIDA. Next varsayilan olarak gezinmeden sonra
 * sayfayi basa kaydirir; burada gitmek istenen yer sayfanin basi DEGIL, ayni
 * izgaranin bir sonraki sayfasidir. Kaydirma acik kalsaydi 3. sayfaya basan
 * biri hero'ya firlar ve baktigi izgarayi bulmak icin her seferinde asagi
 * kaydirmak zorunda kalirdi.
 */

export function NumberedPager({
  basePath,
  query,
  page,
  pageSize,
  total,
  label,
}: {
  basePath: string
  /** Sayfayi tanimlayan oteki parametreler (tab, age…). `page` BURADA OLMAZ. */
  query: Readonly<Record<string, string>>
  /** 1 tabanli. */
  page: number
  pageSize: number
  /**
   * Filtreye uyan toplam satir. SAYILMAMISSA bu bilesen HIC CIZILMEZ --
   * numara listesi toplam olmadan uydurulur, ve uydurulmus bir "3 sayfa"
   * kullaniciyi olmayan bir sayfaya goturur.
   */
  total: number
  label: string
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (pageCount <= 1) return null

  const href = (n: number): string => {
    const params = new URLSearchParams(query)
    // 1. sayfa parametresizdir: kanonik adres tek olmali, `?page=1` ve `/`
    // ayni listeyi iki farkli URL'den gostermemeli.
    if (n > 1) params.set('page', String(n))
    const search = params.toString()
    return search === '' ? basePath : `${basePath}?${search}`
  }

  const current = Math.min(Math.max(1, page), pageCount)
  const numbers = pageNumbers(current, pageCount)

  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-center gap-1.5 pt-4">
      {current > 1 ? (
        <Link
          href={href(current - 1)}
          scroll={false}
          className={buttonClassName({ size: 'md' })}
          rel="prev"
        >
          Prev
        </Link>
      ) : (
        <span
          className={buttonClassName({ size: 'md', className: 'opacity-40' })}
          aria-hidden="true"
        >
          Prev
        </span>
      )}

      {numbers.map((n, i) =>
        n === null ? (
          // `…` BIR BAGLANTI DEGIL: hangi sayfaya gidecegi tanimsizdir.
          <span
            key={`gap-${i}`}
            aria-hidden="true"
            className="px-1.5 text-[15px] text-muted select-none"
          >
            …
          </span>
        ) : n === current ? (
          <span
            key={n}
            aria-current="page"
            className={cx(
              buttonClassName({ size: 'md', className: 'min-w-[44px]' }),
              'pointer-events-none border-white/25 bg-surface font-semibold text-text',
            )}
          >
            {n}
          </span>
        ) : (
          <Link
            key={n}
            href={href(n)}
            scroll={false}
            className={buttonClassName({ size: 'md', className: 'tabular-nums min-w-[44px]' })}
            aria-label={`Page ${n}`}
          >
            {n}
          </Link>
        ),
      )}

      {current < pageCount ? (
        <Link
          href={href(current + 1)}
          scroll={false}
          className={buttonClassName({ size: 'md' })}
          rel="next"
        >
          Next
        </Link>
      ) : (
        <span
          className={buttonClassName({ size: 'md', className: 'opacity-40' })}
          aria-hidden="true"
        >
          Next
        </span>
      )}
    </nav>
  )
}
