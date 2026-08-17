'use client'

import { Button } from '@/components/ui/Button'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { getWebConfig } from '@/lib/addresses'

/**
 * YANLIS AG SERIDI -- ve ne demedigi en az ne dedigi kadar onemli.
 *
 * Bu site YANLIS AGDA DA TAMAMEN OKUNUR. RPC tasiyicisi bizimdir, cuzdanin
 * degil (`web/lib/wagmi.ts`), yani token listesi, grafik ve rezervler her
 * durumda gelir. Kullanicinin durdugu tek yer IMZADIR. Serit bunu soyler:
 * "hicbir sey calismiyor" demez, cunku bu dogru olmaz ve dogru olmayan bir
 * uyari, dogru olani da okunmaz hale getirir.
 *
 * Serit YALNIZCA bir cuzdan bagliyken ve o cuzdan baska bir agdayken cizilir
 * (`useArcNetwork`'un `status === 'connected'` kapisi). Baglanmamis ziyaretcide
 * wagmi'nin `chainId`'si `undefined`'dir; naif bir karsilastirma her ilk
 * ziyaretciye bu seridi gosterir ve insanlara onemli olan tek uyariyi
 * kapatmayi ogretir.
 */
export function NetworkBanner() {
  const { wrongNetwork, switchToArc, isSwitching } = useArcNetwork()
  const { chain } = getWebConfig()

  if (!wrongNetwork) return null

  return (
    <div
      role="status"
      className="border-b border-negative/25 bg-negative/10"
      data-testid="network-banner"
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <span className="text-[13px] text-text">
          Your wallet is on another network. You can read everything here; signing needs{' '}
          {chain.name}.
        </span>
        <Button size="sm" variant="primary" onClick={switchToArc} disabled={isSwitching}>
          {isSwitching ? 'Switching…' : `Switch to ${chain.name}`}
        </Button>
      </div>
    </div>
  )
}
