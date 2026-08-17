import type { Canonicity } from '@/components/read/types'
import { BRAND } from '@/lib/brand'
import { Pill } from '@/components/ui/Pill'

/**
 * KANONIKLIK UC DEGERLIDIR VE IKISI AYNI EKRANA GIDER.
 *
 * Faz 1c olctu: bir sahteci gercek bir launch'in creator'ini, curve'unu,
 * metadata'sini, salt'ini ve hatta gerceklesen islem fiyatini BIREBIR taklit
 * edebilir. Ayiran TEK sey, adresin kendi HAM verisinden CREATE2 ile yeniden
 * turetilmesidir -- ve gosterim metninden turetilemez, cunku `pgSafeText`
 * coka-bir bir eslemedir.
 *
 * `forged` ve `unverifiable` ayni sonuca varir: ikisi de bir launch gibi
 * CIZILMEZ. Ayri ayri adlandirilmalari kullaniciya degil BIZE lazim --
 * `unverifiable` bir gaz tukenmesi ya da RPC dususu olabilir ve onu
 * `forged`'dan ayirmak bir operasyon sinyalidir.
 */
const BADGES: Record<Canonicity, { tone: 'accent' | 'negative' | 'warn'; label: string }> = {
  canonical: { tone: 'accent', label: 'Canonical' },
  forged: { tone: 'negative', label: `Not a ${BRAND.name} launch` },
  unverifiable: { tone: 'warn', label: 'Unverified' },
}

export function CanonicalBadge({ status }: { status: Canonicity }) {
  const badge = BADGES[status]
  return (
    <Pill tone={badge.tone} dot={status !== 'canonical'}>
      {badge.label}
    </Pill>
  )
}

/**
 * SAHTE ADRES EKRANI. Isim ve sembol HIC OKUNMAZ.
 *
 * Okunsaydi ekranda gercek bir launch'in adi gorunurdu ve sahtekarligin
 * isleyis bicimi tam olarak budur: kullanici adresi degil ADI okur. Bu
 * bilesen yalnizca adresi alir -- ismi alacak bir prop'u yoktur, yani onu
 * cizmek bir hata degil bir IMKANSIZLIKTIR.
 */
export function NotALaunch({ address }: { address: string }) {
  const short = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 rounded-card border border-negative/30 bg-negative/8 px-6 py-14 text-center">
      <p className="font-serif text-2xl leading-tight">
        This address is not a {BRAND.name} launch.
      </p>
      <p className="tabular-nums text-sm text-muted" title={address}>
        {short}
      </p>
      <p className="max-w-md text-sm text-muted">
        Its address cannot be re-derived from the launch data it exposes. A token that copies a real
        launch&apos;s name, creator and price will still fail this check — that is the point of it.
      </p>
    </div>
  )
}
