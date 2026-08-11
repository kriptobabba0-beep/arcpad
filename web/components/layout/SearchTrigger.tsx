'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cx } from '@/components/ui/cx'

/**
 * ARAMA TETIKLEYICISI VE ⌘K DINLEYICISI BURADA.
 *
 * Bir klavye kisayolu KESFEDILEBILIR DEGILDIR. Yalnizca ⌘K'ye baglanan bir
 * arama, onu bilmeyen herkes icin var olmayan bir ozelliktir -- bu yuzden
 * tetikleyici GORUNUR BIR BUTONDUR ve kisayolu kendi uzerinde yazar.
 *
 * Modalin ICERIGI Task 9'undur: bu bilesen yalnizca acik/kapali durumu ve
 * kisayolu tasir, `renderDialog` ile de icerigi disaridan alir. Boyle
 * bolunmesinin sebebi, Task 9'un veritabanina ve `verifyCanonical`'a bagli
 * olmasi ve kabugun ondan once ayakta olmasi gerekmesi.
 */
export type SearchTriggerProps = {
  /**
   * Task 9: `({ open, onClose }) => <SearchDialog open={open} onClose={onClose} />`.
   * Verilmezse tetikleyici yine cizilir ve kisayol yine calisir; yalnizca
   * acilacak bir sey olmaz.
   */
  renderDialog?: (props: { open: boolean; onClose: () => void }) => ReactNode
  className?: string
}

/**
 * Sunucuda `navigator` yok, ve varsayilan olarak ⌘ yazmak Windows'ta yanlis
 * tusa isaret eder. Bu yuzden gosterge yalnizca istemcide, montaj SONRASI
 * belirlenir -- hidrasyondan sonra calistigi icin uyumsuzluk uretmez.
 */
function useModifierLabel(): string | null {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ?? navigator.userAgent
    setLabel(/mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl ')
  }, [])
  return label
}

export function SearchTrigger({ renderDialog, className }: SearchTriggerProps) {
  const [open, setOpen] = useState(false)
  const modifier = useModifierLabel()
  const onClose = useCallback(() => setOpen(false), [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // ⌘K VE Ctrl+K, ikisi de. Tek platforma baglanan bir kisayol, oteki
      // platformda sessizce yok demektir.
      if (event.key.toLowerCase() !== 'k') return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      setOpen((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Ayni sebeple kosulsuz: dar ekranda "Search tokens" metni gizlenir,
        // ikon ve kisayol rozeti `aria-hidden`dir, geriye adsiz bir buton
        // kalirdi.
        aria-label="Search tokens"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cx(
          // GENIS VE ORTADA. Referans arayuzde arama seridin ortasinda duran
          // GENIS bir kutudur, sag kumeye yapisik dar bir dugme degil:
          // `w-full max-w-[460px]` onu bir "arac" degil bir GIRIS ALANI gibi
          // gosterir, ki tiklanacak sey odur.
          'group inline-flex h-11 w-full max-w-[460px] items-center gap-2.5 rounded-pill border border-border bg-surface-2',
          'px-4 text-[15px] text-muted transition-colors duration-150',
          'hover:border-white/20 hover:text-text',
          className,
        )}
      >
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">Search tokens</span>
        <kbd
          className="ml-auto hidden rounded-[6px] border border-border bg-bg px-2 py-0.5 font-sans text-[12px] tabular-nums text-muted sm:inline"
          aria-hidden="true"
        >
          {modifier ?? ''}K
        </kbd>
      </button>

      {renderDialog ? renderDialog({ open, onClose }) : null}
    </>
  )
}
