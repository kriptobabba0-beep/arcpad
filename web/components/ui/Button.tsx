import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

/**
 * BIRINCIL BUTONUN METNI KOYUDUR, BEYAZ DEGIL -- ve bu olculmus bir
 * deviasyondur (S10, spec §7.3).
 *
 * Referans arayuz zeytin `#7E8F2E` zemin uzerine beyaz metin kullaniyor;
 * kontrast 3,59:1 ve WCAG AA'nin normal metin icin istedigi 4,5:1'in altinda.
 * Ayni zeminde `#0B0B0B` metin 5,49:1 verir. Hover'da zemin `#C6F24E`'ye cikar,
 * metin ayni kalir (15,2:1). Degisen tek sey metin rengidir; palet §7.3'un
 * paletinin AYNISIDIR.
 *
 * Buradaki `text-primary-fg` / `bg-primary` / `hover:bg-primary-hover` uclusu
 * dekoratif degil BAGLAYICIDIR: `contrast.test.ts` tam olarak bu token
 * ciftlerini olcer, `test/ui/button.test.tsx` de butonun bu tokenlari tasidigini
 * iddia eder. Ikisi birlikte, "birincil butonun metnini acik yap" mutantinin
 * hangi yoldan denenirse denensin kirmizi olmasini saglar.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover font-semibold',
  secondary: 'bg-surface-2 text-text border border-border hover:border-white/20 hover:bg-surface',
  ghost: 'text-muted hover:text-text hover:bg-surface-2',
  danger: 'bg-negative/12 text-negative border border-negative/30 hover:bg-negative/20',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2',
}

const BASE = [
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap',
  'transition-colors duration-150',
  'disabled:pointer-events-none disabled:opacity-45',
].join(' ')

/**
 * Recete, bilesenden AYRI.
 *
 * Gezinti icindeki `+ Create` bir BAGLANTIDIR, buton degil: yeni sekmede
 * acilabilmeli, adresi kopyalanabilmeli, tarayicinin geri dugmesiyle
 * calismalidir. Bir `<button>`'a `onClick={() => router.push(...)}` yazmak
 * bunlarin ucunu de kaybettirir. Bu yuzden gorunum bir sinif recetesi olarak
 * disari verilir ve `<Link>` onu giyer.
 */
export function buttonClassName(opts?: {
  variant?: ButtonVariant
  size?: ButtonSize
  pill?: boolean
  className?: string
}): string {
  return cx(
    BASE,
    opts?.pill ? 'rounded-pill' : 'rounded-input',
    SIZES[opts?.size ?? 'md'],
    VARIANTS[opts?.variant ?? 'secondary'],
    opts?.className,
  )
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** `rounded-pill` -- filtre ve rozet seklindeki eylemler icin. */
  pill?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  pill = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      // Varsayilan `submit` DEGIL. Bir form icindeki susleme butonu formu
      // gondermemeli; gondermesi gereken cagiran tarafta acikca yazilir.
      type={type}
      className={buttonClassName({ variant, size, pill, ...(className ? { className } : {}) })}
      {...rest}
    >
      {children}
    </button>
  )
}
