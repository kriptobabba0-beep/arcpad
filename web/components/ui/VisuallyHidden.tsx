import type { ReactNode } from 'react'

/**
 * Gorsel olarak gizli, ekran okuyucuya acik.
 *
 * `display: none` ve `visibility: hidden` metni ekran okuyuculardan DA
 * gizler; bu yuzden Tailwind'in `sr-only`'si (1x1 kirpilmis kutu) kullanilir.
 * Ikonla anlatilan her eylemin metinli bir karsiligi buradan gecer.
 */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>
}
