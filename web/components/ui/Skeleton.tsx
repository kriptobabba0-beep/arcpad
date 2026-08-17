import { cx } from './cx'

/**
 * Yukleniyor yer tutucusu.
 *
 * `animate-pulse` `prefers-reduced-motion: reduce` altinda KENDILIGINDEN
 * durur: `globals.css`'teki evrensel kural `animation-duration`'i 0s yapar,
 * yani burada bir kosul yazmaya gerek yok ve bir gun baska bir bilesen
 * animasyon eklediginde de aynisi gecerli olur.
 *
 * `aria-hidden`: bir iskelet duyurulacak bir icerik degildir; yukleme durumu
 * bunu kusatan bolgenin `aria-busy`'siyle anlatilir.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx('block animate-pulse rounded-input bg-white/6', className)}
    />
  )
}
