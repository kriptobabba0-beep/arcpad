import Link from 'next/link'
import { buttonClassName } from '@/components/ui/Button'

/**
 * NUMARALI SAYFALAR YOK -- DEVIASYON 2, ve gerekcesi aritmetiktir.
 *
 * Referans arayuz `1 2 … 3137` gosteriyor. Bunu dogru yapmanin tek yolu
 * `OFFSET`tir, ve bu siralama anahtari `lastBuySeq` gibi CANLI bir kolon
 * oldugunda satir TEKRARLAR ya da ATLAR: iki sorgu arasinda yeni bir alim
 * geldiginde butun liste bir kayar, ve 3. sayfanin ilk satiri 2. sayfanin son
 * satiriyla ayni olur. Numarali bir sayfa listesi veremeyecegimiz bir kesinlik
 * VAAT EDER.
 *
 * Keyset sayfalama bu problemi tanim geregi yasamaz -- "su anahtardan sonrasi"
 * araya giren yazimlardan etkilenmez. Bedeli geriye gitmenin bedava olmamasi,
 * o yuzden gezilen cursor'lar URL'de bir YIGIN olarak tasinir.
 *
 * Toplam sayi yine gosterilir: kullanicinin bilmek istedigi sey "kacinci
 * sayfadayim" degil "ne kadar var".
 */
export function KeysetPager({
  basePath,
  query,
  cursors,
  nextCursor,
  total,
  label,
}: {
  /** `/` ya da `/token/0x…` -- ayni bilesen Task 9 ve Task 11'de de kullanilir. */
  basePath: string
  /** Sayfayi tanimlayan oteki parametreler (sort, age, tab...). */
  query: Readonly<Record<string, string>>
  /** Ziyaret edilen cursor yigini, en eskiden yeniye. */
  cursors: readonly string[]
  nextCursor: string | null
  /**
   * TOPLAM SAYI OPSIYONEL, cunku Faz 3'un `Page<T>`'si onu VERMIYOR --
   * `listTokens` yalnizca satirlari ve tazeligi dondurur. Uydurmak ya da
   * sayfa boyutundan tahmin etmek, kullaniciya olmayan bir kesinlik vaat
   * ederdi; verilmediginde satir hic cizilmez.
   */
  total?: number | undefined
  label: string
}) {
  const build = (stack: readonly string[]): string => {
    const params = new URLSearchParams(query)
    const top = stack[stack.length - 1]
    if (top !== undefined) params.set('after', top)
    // Yigin URL'de tasinir cunku sayfa bir server component: bellekte tutulan
    // bir yigin, yenilemede ya da paylasilan bir adreste yok olur.
    if (stack.length > 1) params.set('seen', stack.slice(0, -1).join('.'))
    const search = params.toString()
    return search === '' ? basePath : `${basePath}?${search}`
  }

  const hasPrev = cursors.length > 0
  const prevHref = build(cursors.slice(0, -1))
  const nextHref = nextCursor === null ? null : build([...cursors, nextCursor])

  if (!hasPrev && nextHref === null) return null

  return (
    <nav aria-label={label} className="flex items-center justify-between gap-4 pt-2">
      {total === undefined ? (
        <span />
      ) : (
        <p className="text-[13px] text-muted">
          {/*
            Locale ACIKCA `en-US`. Sabitlenmezse ayni sayi bir kullanicida
            "1,234", digerinde "1.234" okunur; kok eslint kuralinin reddettigi
            sey de tam olarak locale'siz cagri.
          */}
          <span className="tabular-nums text-text">{total.toLocaleString('en-US')}</span> launched
        </p>
      )}

      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link href={prevHref} className={buttonClassName({ size: 'sm' })} rel="prev">
            Prev
          </Link>
        ) : (
          <span className={buttonClassName({ size: 'sm', className: 'opacity-45' })} aria-hidden>
            Prev
          </span>
        )}
        {nextHref === null ? (
          <span className={buttonClassName({ size: 'sm', className: 'opacity-45' })} aria-hidden>
            Next
          </span>
        ) : (
          <Link href={nextHref} className={buttonClassName({ size: 'sm' })} rel="next">
            Next
          </Link>
        )}
      </div>
    </nav>
  )
}
