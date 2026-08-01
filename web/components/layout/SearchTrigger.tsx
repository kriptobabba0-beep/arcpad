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
          'group inline-flex h-10 items-center gap-2 rounded-input border border-border bg-surface-2',
          'px-3 text-sm text-muted transition-colors duration-150',
          'hover:border-white/20 hover:text-text',
          className,
        )}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">Search tokens</span>
        <kbd
          className="ml-2 hidden rounded-[6px] border border-border bg-bg px-1.5 py-0.5 font-sans text-[11px] tabular-nums text-muted sm:inline"
          aria-hidden="true"
        >
          {modifier ?? ''}K
        </kbd>
      </button>

      {renderDialog ? renderDialog({ open, onClose }) : null}
    </>
  )
}
