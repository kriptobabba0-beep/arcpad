'use client'

import {
  formatPriceWeiPerToken,
  formatTokenCompact,
  formatUsdcCompact,
} from '@arcpad/shared/browser'
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
  /**
   * `$0.0(7)5878` -- token basina fiyat, KISALTILMADAN.
   *
   * Bir memecoin'in fiyati 0.00000452 olabilir ve `usdc` bicimi onu `$0.00`
   * yapardi. Sifir-alt-simge gosterimi bu deponun tek fiyat bicimidir.
   */
  price: (value: bigint) => `$${formatPriceWeiPerToken(value)}`,
  /**
   * `11.00M` -- token adedi. Para DEGIL, bu yuzden `$` yok.
   */
  token: (value: bigint) => formatTokenCompact(value),
  /**
   * `12.3%` -- ONDA BIR YUZDE tasiyan bir tam sayi bekler (`123` -> `12.3%`).
   *
   * Yuzde bir kesirdir ve bu bileşenin aritmetigi tamamen `bigint`; kesri
   * ondaliga tasiyip burada geri bolmek, ara degerleri `number`a cevirmeden
   * animasyon yapmanin tek yolu. Cagiran taraf `Math.round(p * 10)` gecer.
   *
   * ISARET BASILMAZ, AMA DEGERDE TASINIR. Cagiran taraf yonu bir okla
   * (▴/▾) gosterir, yani metinde ayrica bir eksi olsaydi ayni sey iki kez
   * yazilmis olurdu. Buna ragmen `value` ISARETLI gecirilmeli: `-5%`ten
   * `-3%`e giden bir token YUKSELMISTIR, ama buyuklukler (5 -> 3) DUSER.
   * Mutlak deger gecilseydi yon rengi tam TERSINI gosterirdi.
   */
  percent1: (value: bigint) => {
    const abs = value < 0n ? -value : value
    return `${abs / 10n}.${abs % 10n}%`
  },
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
  /*
   * ANIMASYON EKRANDAKI DEGERDEN BASLAR, SON HEDEFTEN DEGIL.
   *
   * Bir sayi 650 ms'lik gecis bitmeden yeniden degisebilir -- kullanici bir
   * tutar yaziyorsa (1 -> 10 -> 100) ya da art arda iki islem gectiyse. Baslangic
   * olarak son HEDEFI alsaydik, yarim kalmis gecis once o hedefe SICRAR sonra
   * yeniden sayardi; yani en cok hareket eden sayilar en cok sicrayanlar
   * olurdu. `shownRef` o an cizili olani tutar ve gecis kesintisiz surer.
   */
  const shownRef = useRef(value)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  shownRef.current = shown

  useEffect(() => {
    const from = shownRef.current
    if (previous.current === value) return
    previous.current = value

    setDirection(value > from ? 'up' : 'down')

    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      shownRef.current = value
      setShown(value)
      return
    }

    if (timer.current !== null) clearInterval(timer.current)
    let step = 0
    timer.current = setInterval(() => {
      step += 1
      if (step >= STEPS) {
        shownRef.current = value
        setShown(value)
        if (timer.current !== null) clearInterval(timer.current)
        timer.current = null
        return
      }
      // TAMAMEN `bigint`: bir `number`a ugramak wei olceginde yuvarlardi.
      const next = from + ((value - from) * BigInt(step)) / BigInt(STEPS)
      shownRef.current = next
      setShown(next)
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
