import Link from 'next/link'
import { buttonClassName } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

/**
 * ADRES BICIMI GECERSIZ.
 *
 * Bu, "bulunamadi"dan FARKLI bir durumdur ve ayri bir metni hak eder: bir
 * launch'in var olup olmadigi sorusuna hic gelinmedi, cunku sorulan sey bir
 * adres bile degildi. Ayni metni kullanmak, kullaniciya var olmayan bir
 * tokeni aradigini soylerdi.
 */
export default function NotFound() {
  return (
    <Card className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-14 text-center">
      <p className="font-serif text-2xl leading-tight">That is not a token address.</p>
      <p className="text-sm text-muted">
        A token address is 42 characters: <span className="tabular-nums">0x</span> followed by 40
        hexadecimal digits.
      </p>
      <Link href="/" className={buttonClassName({ variant: 'primary' })}>
        Back to explore
      </Link>
    </Card>
  )
}
