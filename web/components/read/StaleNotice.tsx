import type { StaleIndexer } from './types'

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
 * hesaplar, ve blok gecikmesini indexer'in KENDI gordugu zincir basindan
 * (`sync_state.head_block`). Tarayici saatiyle -- ya da tarayicidan atilan bir
 * RPC ile -- hesaplamak, saati kaymis bir kullaniciya kalici bir uyari
 * gosterirdi.
 *
 * ============ BU BILESEN CIZILIYORDU AMA HICBIR ZAMAN CIZILMIYORDU ==========
 *
 * Iki sayfa da onu `0b4f9c2`'den beri baglar, ve canli kosuda EKRANA HIC
 * GELMEDI: indexer 767.504 blok (~75 saat) geridEYKEN `stale` `false` idi,
 * cunku o bayrak "indexer yaziyor mu"yu olcuyordu. Bileşen dogruydu; ona
 * verilen cevap yanlisti. Simdi `why` ile geliyor ve UCU DE ayri cumle:
 * "hic kosmadi", "yazma durdu", "geride".
 */
export function StaleNotice({
  indexer,
  what,
}: {
  indexer: StaleIndexer
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
        {describeStaleness(indexer)} Trading reads reserves straight from the chain and is
        unaffected.
      </span>
    </div>
  )
}

/** Arc'ta olculen blok suresi. Bloklari saniyeye cevirmenin TEK yeri. */
export const ARC_BLOCK_SECONDS = 0.35

/**
 * BAYATLIGIN CUMLESI, SEBEBINE GORE.
 *
 * Dordu de ayri bir ariza ve ayri bir runbook dalidir; hepsini "indexer
 * geride" diye yazmak, olu bir indexer ile yavas bir indexer'i ayni ekrana
 * katlardi. `behind-head` dalinda GERIDE OLDUGU SAYIYLA yazilir -- bu, canli
 * kosuda hicbir yerde gorunmeyen sayinin ta kendisi.
 */
export function describeStaleness(indexer: StaleIndexer): string {
  const at = indexer.at
  switch (indexer.why) {
    case 'never-ran':
      return 'Our indexer has never run against this database, so nothing here has been checked against the chain.'
    case 'head-unknown':
      return `Our indexer last updated ${describeLag(at?.stalenessSeconds ?? null)} but did not record where the chain head was, so how far behind this page is CANNOT be measured.`
    case 'writes-stalled':
      return `Our indexer last updated ${describeLag(at?.stalenessSeconds ?? null)} and may have stopped.`
    case 'behind-head':
      return `Our indexer is ${describeBlockLag(at?.blocksBehind ?? null)} behind the chain (last updated ${describeLag(at?.stalenessSeconds ?? null)}).`
  }
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

/**
 * "510,000 blocks (~50 hours)".
 *
 * BLOK SAYISI DA YAZILIR, YALNIZCA SURE DEGIL: sure bir CEVIRIDIR (~350ms/blok)
 * ve zincirin hizi degisirse yanlis olur; blok sayisi olculen seyin kendisidir.
 * Ikisi birlikte hem dogrulanabilir hem anlasilir olur.
 */
export function describeBlockLag(blocksBehind: bigint | null): string {
  if (blocksBehind === null) return 'an unknown number of blocks'
  const blocks = blocksBehind < 0n ? 0n : blocksBehind
  const seconds = Number(blocks) * ARC_BLOCK_SECONDS
  return `${blocks.toLocaleString('en-US')} block${blocks === 1n ? '' : 's'} (~${describeDuration(seconds)})`
}

function describeDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)} minutes`
  const hours = minutes / 60
  return hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`
}
