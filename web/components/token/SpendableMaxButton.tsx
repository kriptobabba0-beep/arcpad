'use client'

import { Button } from '@/components/ui/Button'
import { maxAmount } from './gas'

export type SpendableMaxButtonProps = {
  /** Gaz payi DUSULMUS bakiye. `null` -> tahmin yok, dugme kapali. */
  readonly spendable: bigint | null
  /** `spendable === null` oldugunda tooltip'e giren sebep. */
  readonly reason: string | null
  readonly onPick: (amount: bigint) => void
  readonly disabled?: boolean
}

/**
 * MAX -- ve adi `spendable` kelimesini TASIYOR, cunku tasidigi bilgi bu.
 *
 * Dosya `MaxButton.tsx` adiyla dogdu ve DORT dugme cizdi (`25% · 50% · 75% ·
 * MAX`); yuzdeler kaldirildi, geriye bir dugme kaldi. Adin `SpendableMax`
 * olmasinin sebebi dugme sayisi degil: bu bilesenin varlik sebebi MAX'in
 * `balance` degil `spendable` uzerinden hesaplanmasi, ve o ayrimi adin
 * kendisine yazmak, bir gun birinin `balance` gecmesini bir YAZIM HATASI gibi
 * gorunur kilar.
 *
 * YUZDELER NEDEN GITTI. Arc'ta gaz harcanan varligin kendisiyle odenir, yani
 * gonderilebilir EN BUYUK tutar kullanicinin GOREMEDIGI bir sayidir --
 * `useGasReserve` onu islem basina olcer ve ekranda cikarilacak bir rakam
 * olarak hic yazilmaz. MAX bu yuzden bilgi tasir. Bakiyenin dortte biri ise
 * kullanicinin iki santim otede duran bir figur uzerinde kendi yapabilecegi bir
 * bolme islemidir; tasidigi bilgi yok.
 *
 * Tahmin basarisiz oldugunda dugme DEVRE DISI ve sebep `title`'da yazar. Kapali
 * bir dugme sebepsiz kaldiginda kullanici onu bir hata sanar; sebebi yazmak,
 * kapaliligi bir karara cevirir.
 *
 * Bu bilesen kendi aritmetigini HIC yazmaz, `gas.ts`'i cagirir -- `spendable`'i
 * `balance` ile degistiren mutant orada, `web/test/trade/gas.test.ts`'te olur.
 */
export function SpendableMaxButton({
  spendable,
  reason,
  onPick,
  disabled = false,
}: SpendableMaxButtonProps) {
  const off = disabled || spendable === null
  const title = spendable === null && reason !== null ? reason : undefined

  return (
    <Button
      size="sm"
      pill
      variant="ghost"
      disabled={off}
      {...(title === undefined ? {} : { title })}
      data-testid="max-button"
      onClick={() => {
        const amount = maxAmount(spendable)
        if (amount === null) return
        onPick(amount)
      }}
    >
      MAX
    </Button>
  )
}
