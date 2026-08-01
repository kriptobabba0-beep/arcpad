import { Card } from '@/components/ui/Card'
import type { Lifecycle } from './lifecycle'

/**
 * TAMAMLANMIS BIR CURVE'DE AL-SAT PANELI ACIK KALAMAZ.
 *
 * `complete == true` oldugunda UC GIRIS NOKTASI DA `CurveComplete()` ile
 * doner (K5). Paneli acik birakmak, kullaniciya KESIN basarisiz olacak bir
 * islem imzalatmak demektir -- gaz oder, revert alir, ve arayuz ona bunu
 * onceden soyleyebilecekken sylememis olur.
 *
 * Panel GIZLENMEZ, HIC CIZILMEZ. Gizlenmis bir panel DOM'da durur ve klavye
 * ya da ekran okuyucu ona yine ulasir.
 */
export function LifecycleNotice({ lifecycle }: { lifecycle: Lifecycle }) {
  if (lifecycle.kind === 'trading') return null

  return (
    <Card className="flex flex-col gap-2 px-5 py-6" data-testid="lifecycle-notice">
      <p className="font-serif text-xl leading-tight">
        {lifecycle.kind === 'complete' ? 'Curve complete' : 'Graduated'}
      </p>
      <p className="text-[13px] leading-relaxed text-muted">
        {lifecycle.kind === 'complete'
          ? 'Sale supply sold out. Trading on the curve is closed; pool creation lands with Phase 2.'
          : lifecycle.poolNote}
      </p>
    </Card>
  )
}
