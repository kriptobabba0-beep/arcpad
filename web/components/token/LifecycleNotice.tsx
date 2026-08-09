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
/**
 * "POOL CREATION LANDS WITH PHASE 2" WAS FALSE WHEN IT WAS READ IN A BROWSER.
 *
 * Measured 2026-08-09 against an Arc-configured build of this app and the live
 * completed curve `0xDdB9e739…f27b`: the card said *"Sale supply sold out.
 * Trading on the curve is closed; pool creation lands with Phase 2."* Phase 2
 * has been ON CHAIN since 2026-08-06 -- `PoolManager 0x617321A8…`,
 * `ArcpadHook 0xd95198Cd…`, `ArcpadLocker 0x0e777109…`, all in
 * `contracts/deploy/addresses.5042002.json`. The sentence pointed the reader at
 * a release that had already shipped, and therefore at the wrong cause.
 *
 * THE TRUE THING IS A MECHANISM, NOT A DATE. Graduation is a SEPARATE
 * TRANSACTION and there is no automatic path to it -- there cannot be one:
 * `BondingCurve.graduate()` requires `msg.sender == graduationTarget`
 * (`contracts/src/BondingCurve.sol:886`) and `BondingCurve`'s creation code is
 * frozen at `8e2460ff…4982f`, so the curve can never call the target itself.
 * The keeper is the primary caller; `ArcpadLocker.graduate(address)` is
 * `external` with no access control, so anyone may send it as a fallback.
 *
 * WHAT THIS CARD DOES NOT SAY, DELIBERATELY. Whether that call would SUCCEED
 * right now depends on `factory.graduationTarget()`, which is a live chain read
 * and is `0x0` on the production factory today. A static sentence cannot know
 * it, and asserting it here would be the same class of error as the one being
 * fixed -- a hardcoded claim about chain state. `<GraduationPanel>` reads it and
 * says so; this card says only what is true of every completed curve.
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
          ? 'Sale supply sold out, so trading on the curve is closed. Opening the pool is a ' +
            'separate transaction called graduation; it does not happen automatically, and ' +
            'anyone may send it.'
          : lifecycle.poolNote}
      </p>
    </Card>
  )
}
