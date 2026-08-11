import Link from 'next/link'
import { cx } from '@/components/ui/cx'
import { InfoTip } from '@/components/ui/InfoTip'
import { type ExploreQuery, TAB_LABELS, tabHref } from './params'

/**
 * SEKME SERIDI `<Link>`'LERDEN OLUSUR, BUTONLARDAN DEGIL.
 *
 * Uc sonucu var ve ucu de bedava: JS gelmeden once calisir, her sekme
 * PAYLASILABILIR bir adrese sahiptir, ve tarayicinin geri dugmesi bir onceki
 * sekmeye doner. `onClick`'li bir buton uculunu de kaybettirir ve karsiliginda
 * hicbir sey vermez -- sayfa zaten bir server component.
 *
 * ============ `scroll={false}` -- VE BU BIR SUSLEME DEGIL ============
 *
 * Next'in `<Link>`i varsayilan olarak gezinmeden sonra sayfayi BASA KAYDIRIR,
 * cunku cogu gezinme BASKA bir sayfaya gider ve orada dogru davranis budur.
 * Burada gitmez: ayni sayfanin ayni bolumu, yalnizca farkli siralamayla
 * yeniden ciziliyor. Kullanici izgaraya bakarken "Top"a basiyor ve ekran
 * hero'ya firliyor -- yani baktigi sey gozunden kayboluyor ve geri gelmek icin
 * her seferinde asagi kaydirmak zorunda kaliyor.
 *
 * Sayfa numaralari icin de AYNI kural gecerlidir (`NumberedPager`).
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
      className="flex min-w-0 max-w-full items-center gap-1 self-start overflow-x-auto rounded-pill bg-surface-2 p-1.5"
    >
      {TAB_LABELS.map((item) => {
        const active = item.key === query.tab
        return (
          <span key={item.key} className="flex shrink-0 items-center">
            <Link
              href={tabHref(item.key)}
              scroll={false}
              {...(active ? { 'aria-current': 'page' as const } : {})}
              className={cx(
                'shrink-0 rounded-pill px-4 py-2 text-[15px] font-medium transition-colors duration-150',
                active
                  ? 'bg-surface text-text shadow-sm shadow-black/30'
                  : 'text-muted hover:text-text',
              )}
            >
              {item.label}
            </Link>
            {/*
              IPUCU BAGLANTININ ICINDE DEGIL YANINDA. Ic ice tiklanabilir oge
              klavye icin kiriktir: Tab iki durak yapar ve kullanici hangi
              hedefe gittigini bilemez. Ayrica bir `<button>`u bir `<a>`nin
              icine koymak gecersiz HTML'dir.
            */}
            <span className="mr-1.5 ml-0.5">
              <InfoTip label={`How ${item.label} is sorted`}>{item.hint}</InfoTip>
            </span>
          </span>
        )
      })}
    </nav>
  )
}
