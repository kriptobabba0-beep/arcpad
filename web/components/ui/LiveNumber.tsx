'use client'

import { formatUsdcCompact } from '@arcpad/shared/browser'
import { useEffect, useRef, useState } from 'react'
import { cx } from './cx'

/**
 * DEGISEN BIR SAYIYI SICRATMADAN, SAYARAK GOSTERIR.
 *
 * `$50` -> `$60` arasi tek karede degisirse kullanici ne oldugunu GORMEZ:
 * ekranda bir sayi vardi, simdi baska bir sayi var, ve hangi yone gittigi
 * yalnizca once/sonrayi hatirlayana belli olur. Aradaki degerlerden gecmek
 * degisimin KENDISINI gorunur kilar -- ve yonu renkle soyler.
 *
 * ---
 *
 * ARITMETIK `bigint` UZERINDEDIR, ARADA `number` YOKTUR.
 *
 * Bu urundeki her para degeri 18 ondalikli `wei`dir ve 1 USDC = 1e18, yani
 * `Number.MAX_SAFE_INTEGER`in (9.007e15) YUZ KATINDAN buyuk. Ara degerleri
 * `number` uzerinde hesaplamak, gosterilen her tutari sessizce yuvarlardi --
 * bir launchpad'de en son yapilacak sey. Interpolasyon bu yuzden tamamen
 * `bigint`: `from + (to - from) * adim / TOPLAM_ADIM`.
 *
 * `prefers-reduced-motion` ONCELIKLIDIR. Hareketi azaltilmis bir sistemde
 * animasyon HIC calismaz ve sayi dogrudan son degerine gecer; bu bir incelik
 * degil bir erisilebilirlik kosulu (WCAG 2.3.3), ve sayarak degisen bir sayi
 * vestibuler duyarliligi olan biri icin gercekten rahatsiz edicidir.
 *
 * ILK CIZIM ANIMASYON DEGILDIR. Sunucudan gelen ilk deger dogrudan yazilir:
 * sifirdan sayarak baslayan bir sayfa, her yenilemede butun ekrani oynatir ve
 * "yukleniyor" hissi verir -- oysa veri zaten oradadir.
 *
 * ============ BICIM BIR AD, BIR FONKSIYON DEGIL ============
 *
 * Ilk hal `format` diye bir FONKSIYON prop'u aliyordu ve uretim yapisinda
 * su hatayla dustu: "Functions cannot be passed directly to Client Components".
 * Sebep yapisal: bu bileşen `'use client'`, onu cizen kart ise bir SUNUCU
 * bileşeni, ve sunucu->istemci sinirindan gecen her sey SERILESTIRILIR --
 * bir fonksiyon serilestirilemez.
 *
 * Bu yuzden prop bir ANAHTAR ('usdc' | 'count'), ve bicimlendirici burada,
 * istemci tarafinda secilir. Yan faydasi: bir izgarada 48 kart varken 48 ayni
 * fonksiyon referansi sinirdan gecmez.
 */

/** Desteklenen bicimler. Bir dize gecer, bir fonksiyon degil -- bkz. yukarisi. */
const FORMATS = {
  /** `$58.78`, `$39.2K`, `$7.2M` -- 18 ondalikli native USDC. */
  usdc: (value: bigint) => formatUsdcCompact(value),
  /** `1,234` -- gruplanmis tam sayi. Locale ACIKCA `en-US` (kok eslint kurali). */
  count: (value: bigint) => value.toLocaleString('en-US'),
} as const

export type LiveNumberFormat = keyof typeof FORMATS

/** Animasyonun toplam suresi. Kisa: bu bir gecis, bir gosteri degil. */
const DURATION_MS = 650

/** Kac ara adim cizilir. 20 adim ~30ms'de bir kare; goz akiciligi burada doyar. */
const STEPS = 20

export function LiveNumber({
  value,
  format: formatKey,
  className,
}: {
  value: bigint
  /** Bicim ADI. Fonksiyon DEGIL -- sunucu sinirindan gecemez. */
  format: LiveNumberFormat
  className?: string
}) {
  const format = FORMATS[formatKey]
  const [shown, setShown] = useState(value)
  const [direction, setDirection] = useState<'up' | 'down' | null>(null)
  const previous = useRef(value)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const from = previous.current
    if (from === value) return
    previous.current = value

    setDirection(value > from ? 'up' : 'down')

    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setShown(value)
      return
    }

    if (timer.current !== null) clearInterval(timer.current)
    let step = 0
    timer.current = setInterval(() => {
      step += 1
      if (step >= STEPS) {
        setShown(value)
        if (timer.current !== null) clearInterval(timer.current)
        timer.current = null
        return
      }
      // TAMAMEN `bigint`: bir `number`a ugramak wei olceginde yuvarlardi.
      setShown(from + ((value - from) * BigInt(step)) / BigInt(STEPS))
    }, DURATION_MS / STEPS)

    return () => {
      if (timer.current !== null) clearInterval(timer.current)
      timer.current = null
    }
  }, [value])

  /* Yon rengi animasyon bitince soner: kalici bir renk, eski bir olayi surekli
     bir durum gibi gosterirdi. */
  useEffect(() => {
    if (direction === null) return
    const t = setTimeout(() => setDirection(null), DURATION_MS + 400)
    return () => clearTimeout(t)
  }, [direction, shown])

  return (
    <span
      className={cx(
        'tabular-nums transition-colors duration-300',
        direction === 'up' && 'text-accent',
        direction === 'down' && 'text-negative',
        className,
      )}
      /*
        DEGISEN SAYI EKRAN OKUYUCUYA HER ADIMDA OKUNMAZ. `aria-live` konsaydi
        yirmi ara deger arka arkaya duyurulurdu. Son deger `title` ile ve
        DOM'daki metnin kendisiyle zaten erisilebilir; okuyucu sayfayi
        gezerken guncel degeri okur.
      */
      title={format(value)}
    >
      {format(shown)}
    </span>
  )
}
