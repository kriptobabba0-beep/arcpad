import type { IndexerStatus } from './types'

/**
 * VERI VAR AMA GUNCEL DEGIL -- EN PAHALI DURUM.
 *
 * "Veri yok" durumunu arayuz zaten durustce cizer: acik bir kutu, ve
 * kullanici hicbir sayiya guvenmez. Tehlikeli olan oteki: satirlar GELIYOR,
 * fiyat makul gorunuyor, ama indexer on bes dakika geride. O ekranda hicbir
 * sey yanlis GORUNMEZ ve kullanici bayat bir fiyata gore alim yapar.
 *
 * Bu yuzden bayatlik `ReadResult`'in AYRI BIR DALIDIR (`web/lib/read.ts`):
 * basarili sonuc ya `{ stale: false, data }` ya `{ stale: true, staleData }`
 * verir. Alan adinin farkli olmasi, bir cagiranin bayat dali unutmasini
 * derleme hatasi yapar -- bir `boolean` bayragi unutulabilirdi.
 *
 * ESIK BIZIM DEGIL: `packages/db` `now() - updated_at`'i SUNUCUNUN saatinden
 * hesaplar ve `DEFAULT_STALE_AFTER_SECONDS = 30`'la karsilastirir. Tarayici
 * saatiyle hesaplamak, saati kaymis bir kullaniciya kalici bir uyari
 * gosterirdi.
 */
export function StaleNotice({
  indexer,
  what,
}: {
  indexer: IndexerStatus
  /** "Prices", "This page" -- neyin bayat oldugu. */
  what: string
}) {
  return (
    <div
      role="status"
      data-testid="stale-notice"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-negative/30 bg-negative/8 px-4 py-2.5 text-[13px]"
    >
      <span className="font-medium">{what} may be out of date.</span>
      <span className="text-muted">
        Our indexer last updated {describeLag(indexer.stalenessSeconds)}. Trading reads reserves
        straight from the chain and is unaffected.
      </span>
    </div>
  )
}

/**
 * "42 saniye once", "15 dakika once".
 *
 * `null` = indexer HIC kosmadi, ki bu "biraz geride"den baska bir seydir ve
 * oyle de yazilir. Sifiri "0 saniye once" diye yazmak, sorunun kendisini
 * yokmus gibi gosterirdi.
 */
export function describeLag(stalenessSeconds: number | null): string {
  if (stalenessSeconds === null) return 'never'
  const s = Math.max(0, Math.round(stalenessSeconds))
  if (s < 90) return `${s}s ago`
  const minutes = Math.round(s / 60)
  if (minutes < 90) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
