import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

/**
 * TEK AYIRICI: 8% beyaz bir kil cizgi.
 *
 * Golge yok, ikinci bir zemin kademesi yok, gradyan cerceve yok. Bir tarama
 * yuzeyinde her kartin kendi golgesi olduğunda goz sinirlari degil golgeleri
 * okur ve yogunluk okunmaz hale gelir. Derinlik yalnizca zemin kademesiyle
 * anlatilir: bg -> surface -> surface-2.
 */
export function Card({
  as: Tag = 'div',
  interactive = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'article' | 'section' | 'li'
  interactive?: boolean
  children?: ReactNode
}) {
  return (
    <Tag
      className={cx(
        'rounded-card border border-border bg-surface',
        interactive && 'transition-colors duration-150 hover:border-white/18 hover:bg-surface-2',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  )
}
