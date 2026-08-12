'use client'

import type { ReactNode } from 'react'
import { Input } from '@/components/ui/Input'

export type AmountInputProps = {
  readonly label: string
  readonly unit: string
  readonly value: string
  readonly onChange: (next: string) => void
  readonly error?: string | undefined
  readonly hint?: ReactNode
  readonly disabled?: boolean
  /**
   * TUTARI BUYUK YAZ.
   *
   * Islem panelinde girilen sayi EKRANDAKI EN ONEMLI SEYDIR ve referans
   * tasarim onu baslik boyutunda yazar. Bu bir opsiyon, cunku ayni bilesen
   * `/create`teki dar alanlarda da kullaniliyor ve orada bir baslik boyutu
   * kutuyu tasirdi.
   */
  readonly large?: boolean
}

/**
 * TUTAR ALANI, ve `inputMode="decimal"` bir susleme degil.
 *
 * Mobil klavyede `type="number"` sayisal tus takimini getirir ama beraberinde
 * tekerlek/yukari-asagi ile DEGERI DEGISTIRME davranisini de getirir: para
 * girilen bir alanda kaydirma sirasinda kazara degisen bir rakam, kullanicinin
 * fark etmedigi bir islem demektir. `type="text"` + `inputMode="decimal"` ayni
 * klavyeyi verir, o davranisi vermez.
 *
 * `autoComplete="off"` ve `spellCheck={false}`: tarayicinin onerileri bir para
 * alaninda yalnizca eski bir tutari geri yapistirma riskidir.
 */
export function AmountInput({
  label,
  unit,
  value,
  onChange,
  error,
  hint,
  disabled = false,
  large = false,
}: AmountInputProps) {
  return (
    <Input
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      placeholder="0.0"
      disabled={disabled}
      suffix={unit}
      {...(large ? { className: 'text-[30px] font-medium leading-none' } : {})}
      {...(error === undefined ? {} : { error })}
      {...(hint === undefined ? {} : { hint })}
    />
  )
}
