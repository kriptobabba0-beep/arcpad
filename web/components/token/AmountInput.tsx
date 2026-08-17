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
  /**
   * ETIKETI GIZLE (ekran okuyucuda KALIR).
   *
   * Tutar kutusunun kendi basligi var ("Buy SYMBOL"); alanin ustunde ikinci
   * bir etiket ayni seyi iki kez soylerdi. `sr-only` ile gizlenir, SILINMEZ:
   * bir ekran okuyucu icin alanin ne oldugu hala soylenmeli.
   */
  readonly hideLabel?: boolean
  /** Tutarin onunde duran sabit isaret -- alimda `$`. */
  readonly prefix?: string
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
  hideLabel = false,
  prefix,
}: AmountInputProps) {
  return (
    <Input
      label={label}
      hideLabel={hideLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      placeholder="0.0"
      disabled={disabled}
      {...(large ? { bare: true } : { suffix: unit })}
      {...(prefix === undefined ? {} : { prefix })}
      {...(large
        ? {
            /*
              ============ TUTAR ALANI KESILMEZ ============

              OLCULDU: dort basamaktan uzun bir sayi yaziliyor ve gorunen kismi
              kesiliyordu -- kullanici ne yazdigini goremiyor. Iki sebebi vardi
              ve ikisi de duzeltildi:

                - Alan, yanindaki birim eki ve token hapiyla ayni satirda
                  SIKISIYORDU. `w-full min-w-0` ile artik satirin tamamini
                  alir; hap `shrink-0` ile kendi genisliginde kalir.
                - 30px'te "5000000" bu genislige sigmiyor. Boyut `text-[26px]`
                  ve `sm:text-[30px]`: dar ekranda daha kucuk, genis ekranda
                  referansin boyutu.

              `truncate` KONMAZ: bir tutar alaninda kirpma, kullanicinin
              yazdigi seyi GIZLEMEK demektir. Sigmiyorsa kucultulur.
            */
            className: 'w-full min-w-0 text-[26px] font-medium leading-none sm:text-[30px]',
          }
        : {})}
      {...(error === undefined ? {} : { error })}
      {...(hint === undefined ? {} : { hint })}
    />
  )
}
