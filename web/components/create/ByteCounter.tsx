import { cx } from '@/components/ui/cx'
import { countBytes } from './fields'

export type ByteCounterProps = {
  value: string
  maxBytes: number
  /** `aria-describedby` ile alana baglanabilmesi icin. */
  id?: string
  className?: string
}

/**
 * `27/32 bytes` -- ZINCIRIN SAYDIGI SAYI, EKRANDA.
 *
 * UC RENK, UC ANLAM:
 *   sinirin altinda -> `text-muted`. Bilgi, uyari degil.
 *   TAM sinirda     -> `text-accent`. Bir bayt daha yazilamaz ve kullanici
 *                      bunu yazmadan ONCE bilmeli.
 *   sinirin ustunde -> `text-negative` + `role="alert"`, ve gonderim engellenir.
 *
 * RENK TEK ISARET DEGILDIR: asim durumunda sayinin yanina "over the limit"
 * yazilir ve duyurulur. Kirmiziyi gormeyen biri icin de sinir asilmis olur.
 *
 * Sayim `countBytes` -- yani `utf8ByteLength(normaliseMetadataText(value))`.
 * `.length` DEGIL: `"🚀".repeat(9)` icin `.length` 18 der ve sinirin altinda
 * gorunur; zincir 36 bayt gorur ve `NameTooLong()` ile geri doner.
 */
export function ByteCounter({ value, maxBytes, id, className }: ByteCounterProps) {
  const bytes = countBytes(value)
  const over = bytes > maxBytes
  const atLimit = bytes === maxBytes

  return (
    <span
      id={id}
      data-testid="byte-counter"
      data-over={over ? 'true' : 'false'}
      {...(over ? { role: 'alert' as const } : {})}
      className={cx(
        'tabular-nums text-[12px]',
        over ? 'text-negative' : atLimit ? 'text-accent' : 'text-muted',
        className,
      )}
    >
      {bytes}/{maxBytes} bytes{over ? ' — over the limit' : ''}
    </span>
  )
}
