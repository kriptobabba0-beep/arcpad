'use client'

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { cx } from './cx'

/**
 * BIR BASLIGIN YANINDAKI BILGI ISARETI.
 *
 * NEDEN VAR. "Top tokens" ve dort sekme birer SIRALAMA vaat ediyor ve hangi
 * siralama oldugu ekranda hicbir yerde yazmiyordu. Onceki hal seridin sag
 * ucuna kucuk gri bir "by FDV" koymustu: baslikla arasinda bin piksel vardi,
 * yani baslikla iliskisi gorunmuyordu ve pratikte okunmuyordu.
 *
 * KULLANICI NEYE GORE SIRALANDIGINI BILMEK ZORUNDA. Bir launchpad'de
 * "Trending" kelimesi tek basina hicbir sey soylemez -- hacme gore mi, alim
 * sayisina gore mi, fiyat degisimine gore mi? Ucu de mesru ve ucu de BASKA bir
 * liste uretir. Tahmin ettirmek, kullanicinin listeyi yanlis okumasi demektir.
 *
 * ============ BALON `fixed`, `absolute` DEGIL -- OLCULMUS BIR ARIZA ============
 *
 * Ilk hal `absolute bottom-[calc(100%+8px)]` idi ve SEKME SERIDINDE HIC
 * GORUNMEDI. Sebep sunucuda ya da React'te degil, CSS'te: sekme seridi
 * `overflow-x-auto` tasiyor (375px'te serit sayfayi 7px tasitiyordu, olculdu)
 * ve `overflow` DEGERI `visible` OLMAYAN bir ata, icindeki mutlak konumlu her
 * seyi KIRPAR. Balon ciziliyordu, cerceve disinda kaliyordu; ustune gelince
 * seride bir kaydirma cubugu bile beliriyordu.
 *
 * `position: fixed` bu zincirin tamamindan cikar -- kirpan ata artik yok --
 * ve konum acilis aninda `getBoundingClientRect()` ile olculur. Bedeli:
 * sayfa kaydiginda balon yerinde kalmaz, o yuzden kaydirma ve yeniden
 * boyutlandirma onu KAPATIR. Kaymis bir balon, yanlis bir sey isaret eder.
 *
 * ---
 *
 * FARE ICIN HOVER, KLAVYE ICIN ODAK, DOKUNMA ICIN TIKLAMA -- UCU DE.
 * Yalnizca `:hover` ile calisan bir ipucu, klavyeyle gezen ve dokunmatik
 * kullanan herkes icin YOK demektir. `<button>` olmasinin sebebi de bu.
 *
 * ICERIK `aria-describedby` ILE BAGLANIR, `aria-label` ile DEGIL: etiket
 * dugmenin ADIDIR, aciklama ise AYRI bir metindir. Ikisini birlestirmek,
 * ekran okuyucunun dugmeyi uzun bir cumleyle adlandirmasi olurdu.
 */

/** Balonun genisligi -- ekran kenarina yapismamasi icin konum hesabinda gerekli. */
const TIP_WIDTH = 300

export function InfoTip({ label, children }: { label: string; children: string }) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  const place = useCallback(() => {
    const el = buttonRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    /*
     * Balon dugmenin USTUNDE ve ortalanmis; ama ekran kenarindan tasmasi
     * engellenir. Sekme seridinin en sagindaki "Near graduation"in ipucu,
     * hizalanmis birakilsaydi pencerenin disina cikardi.
     */
    const half = TIP_WIDTH / 2
    const centre = rect.left + rect.width / 2
    const left = Math.min(Math.max(centre, half + 8), window.innerWidth - half - 8)
    setAt({ left, top: rect.top - 10 })
  }, [])

  const close = useCallback(() => setAt(null), [])

  /*
   * KAYDIRMA VE YENIDEN BOYUTLANDIRMA BALONU KAPATIR.
   * `fixed` bir oge sayfayla birlikte kaymaz: acik kalsaydi, kullanici
   * kaydirdikca balon ekranda asili kalir ve baska bir seyi isaret ederdi.
   * `capture: true` -- kaydirma ic bir kutuda olabilir ve baloncuga kadar
   * kabarmayabilir.
   */
  useLayoutEffect(() => {
    if (at === null) return
    window.addEventListener('scroll', close, { capture: true, passive: true })
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, { capture: true })
      window.removeEventListener('resize', close)
    }
  }, [at, close])

  const open = at !== null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        {...(open ? { 'aria-describedby': id } : {})}
        aria-expanded={open}
        onMouseEnter={place}
        onMouseLeave={close}
        onFocus={place}
        onBlur={close}
        // Dokunmatikte hover yok: tiklama acar ve kapatir.
        onClick={() => (open ? close() : place())}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
        className={cx(
          'inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full',
          'border border-white/25 text-[11px] font-bold leading-none text-muted',
          'transition-colors duration-150 hover:border-white/50 hover:bg-white/10 hover:text-text',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40',
        )}
      >
        <span aria-hidden="true">i</span>
      </button>

      {at === null ? null : (
        <span
          id={id}
          role="tooltip"
          style={{ left: at.left, top: at.top, width: TIP_WIDTH }}
          /*
            RENK ZEMINDEN AYRISMALI. Ilk hal `bg-surface-2` (#1c1c1c) idi ve
            sayfa zemini #0b0b0b: aradaki fark bir kenarligi zar zor
            gosteriyordu, balonun kendisi zeminde kayboluyordu. `#242424`
            zemin, `white/18` kenarlik ve gercek bir golge onu YUZEN bir
            katman gibi gosterir -- ki oldugu sey de budur.
          */
          className={cx(
            'pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full',
            'rounded-card border border-white/18 bg-[#242424] px-3.5 py-2.5',
            'text-[13px] font-normal leading-relaxed text-text',
            'shadow-xl shadow-black/60',
          )}
        >
          {children}
        </span>
      )}
    </>
  )
}
