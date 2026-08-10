import Link from 'next/link'
import { cx } from '@/components/ui/cx'
import { type ExploreQuery, TAB_LABELS, tabHref } from './params'

/**
 * SEKME SERIDI `<Link>`'LERDEN OLUSUR, BUTONLARDAN DEGIL.
 *
 * Uc sonucu var ve ucu de bedava: JS gelmeden once calisir, her sekme
 * PAYLASILABILIR bir adrese sahiptir, ve tarayicinin geri dugmesi bir onceki
 * sekmeye doner. `onClick`'li bir buton uculunu de kaybettirir ve karsiliginda
 * hicbir sey vermez -- sayfa zaten bir server component.
 *
 * BES SIRALAMA + UC YAS FILTRESI YERINE DORT SEKME. Onceki hal iki ayri serit
 * ciziyordu (`Recent buys / Newest / Oldest / Market cap / Volume` ve
 * `All / 24h / 7d`): on bes kombinasyon, hicbirinin adi yok, ve kullanicinin
 * sordugu soru zaten "hangi kolona gore sirala" degildi. `params.ts`teki
 * `TABS` her sekmeyi bir (siralama, pencere) ciftine baglar; bu dosya yalnizca
 * onlari cizer.
 *
 * Secili olan `aria-current="page"` tasir: rengin tek basina "secili" demesi
 * yeterli degildir.
 */
export function FilterBar({ query }: { query: ExploreQuery }) {
  return (
    /*
      `max-w-full overflow-x-auto` -- OLCULEREK EKLENDI, TASARIM TERCIHI DEGIL.
      375px'te sekmeler bir satira sigmiyor ve `flex` (wrap YOK) oldugu icin
      serit disari tasiyordu: SAYFANIN kendisi 382px genislige cikiyor ve butun
      ekran yana kayiyordu (`e2e/audit/responsive.spec.ts`, "explore overflows
      by 7px at 375px"). Genis icerigin KENDI kutusunda kaymasi kural; `shrink-0`
      her sekmenin kendi genisliginde kalmasini saglar -- yoksa flex onlari
      sikistirip kaydirma ihtiyacini "cozer" ve etiketler okunmaz hale gelir.
    */
    <nav
      aria-label="Filter launches"
      className="flex min-w-0 max-w-full items-center gap-1 self-start overflow-x-auto rounded-pill bg-surface-2 p-1"
    >
      {TAB_LABELS.map((item) => {
        const active = item.key === query.tab
        return (
          <Link
            key={item.key}
            href={tabHref(item.key)}
            {...(active ? { 'aria-current': 'page' as const } : {})}
            className={cx(
              'shrink-0 rounded-pill px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150',
              active ? 'bg-surface text-text' : 'text-muted hover:text-text',
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
