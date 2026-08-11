'use client'

import { useId, useState } from 'react'
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
 * ---
 *
 * FARE ICIN HOVER, KLAVYE ICIN ODAK, DOKUNMA ICIN TIKLAMA -- UCU DE.
 * Yalnizca `:hover` ile calisan bir ipucu, klavyeyle gezen ve dokunmatik
 * kullanan herkes icin YOK demektir. `<button>` olmasinin sebebi de bu:
 * odaklanabilir ve tiklanabilir bir oge, `<span title>` degil.
 *
 * `title` NITELIGI KULLANILMIYOR ve bu bilincli: tarayicinin kendi ipucu
 * bir saniye gecikmeyle acilir, dokunmatikte hic acilmaz, ve bicimlendirilemez.
 *
 * ICERIK `aria-describedby` ILE BAGLANIR, `aria-label` ile DEGIL: etiket
 * dugmenin ADIDIR ("What is this?"), acıklama ise AYRI bir metindir. Ikisini
 * birlestirmek, ekran okuyucunun dugmeyi uzun bir cumleyle adlandirmasi olurdu.
 */
export function InfoTip({ label, children }: { label: string; children: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Dokunmatikte hover yok: tiklama acar ve kapatir.
        onClick={() => setOpen((v) => !v)}
        // ESC, acilan her seyi kapatir -- bu urunde modal da boyle davraniyor.
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        className={cx(
          'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
          'border border-border text-[11px] font-semibold leading-none text-muted',
          'transition-colors duration-150 hover:border-white/30 hover:text-text',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40',
        )}
      >
        <span aria-hidden="true">i</span>
      </button>

      {open ? (
        <span
          id={id}
          role="tooltip"
          /*
            `left-0` DEGIL: baslik satirinin solunda duran bir ipucu ekranin
            disina tasabilir. `-translate-x-1/2 left-1/2` onu dugmenin
            ustunde ORTALAR, ve `max-w` metni bir satira sikismaktan kurtarir.
          */
          className={cx(
            'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 w-max max-w-[280px] -translate-x-1/2',
            'rounded-card border border-border bg-surface-2 px-3 py-2 text-[13px] font-normal leading-relaxed text-text',
            'shadow-lg shadow-black/40',
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  )
}
