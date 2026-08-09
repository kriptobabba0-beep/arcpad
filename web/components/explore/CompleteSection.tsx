import type { TokenOverview } from '@/components/read/types'
import { NoCompleteCurves } from './EmptyState'
import { TokenGrid } from './TokenGrid'

/**
 * "GRADUATED" DEGIL "CURVE COMPLETE" -- S6.
 *
 * `graduated` bayragi ve havuz Faz 2'dedir; `BondingCurve`'un bugunku tek
 * durumu `bool complete`. Bir curve tukendiginde olan sey TAMAMLANMADIR,
 * mezuniyet degil, ve olmayan bir asamayi adiyla anmak kullaniciya var
 * olmayan bir likidite havuzu vaat eder.
 *
 * AYRIM BUGUNDEN ISIMLENDIRILIYOR. `phase` prop'u Faz 2 geldiginde bolumu
 * ikiye ayirmak icin var: `complete && !graduated` → "Graduating",
 * `graduated` → "Graduated". Bugun yalnizca `complete` gonderiliyor, ama
 * cagri yeri o gun bir YENIDEN YAZIM degil bir ikinci cagri olacak.
 *
 * `complete` NOTU DEGISTI, VE SEBEBI TARAYICIDA OLCULDU. Eskisi "Pool creation
 * lands with Phase 2." diyordu; Faz 2 2026-08-06'dan beri ZINCIRDE (havuz
 * yoneticisi, hook ve locker adres defterinde). Token sayfasindaki ikizi ile
 * ayni yalandi ve ikisi de ayni anda duzeltildi -- biri duzeltilip oteki
 * birakilsaydi, bu deponun "bir giris noktasinda kapatilan sey hepsinde
 * kapatilmis gorunur" kusurunun bir ornegi daha olurdu.
 */
export type CompletePhase = 'complete' | 'graduating' | 'graduated'

const HEADINGS: Record<CompletePhase, { title: string; note: string }> = {
  complete: {
    title: 'Curve complete',
    note: 'Sale supply sold out. Opening the pool is a separate step called graduation.',
  },
  graduating: {
    title: 'Graduating',
    note: 'Sale supply sold out. The pool is being seeded.',
  },
  graduated: {
    title: 'Graduated',
    note: 'Trading has moved to the pool.',
  },
}

export function CompleteSection({
  tokens,
  phase = 'complete',
}: {
  tokens: readonly TokenOverview[]
  phase?: CompletePhase
}) {
  const heading = HEADINGS[phase]

  return (
    <section aria-labelledby="complete-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="complete-heading" className="font-serif text-2xl leading-none">
          {heading.title}
        </h2>
        <p className="text-[13px] text-muted">{heading.note}</p>
      </div>

      {tokens.length === 0 ? (
        <NoCompleteCurves />
      ) : (
        <TokenGrid tokens={tokens} label={heading.title} />
      )}
    </section>
  )
}
