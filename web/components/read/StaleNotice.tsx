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

/**
 * Arc'ta OLCULEN blok suresi. Bloklari saniyeye cevirmenin TEK yeri.
 *
 * OLCUM 2026-08-10, canli testnet, bes ayri pencere -- ve hepsi ayni yeri
 * gosteriyor, yani deger dalgalanmiyor:
 *
 *     son     1.000 blok ->   512 sn  -> 0,5120 sn/blok
 *     son    10.000 blok ->  5.149 sn -> 0,5149
 *     son   100.000 blok -> 51.923 sn -> 0,5192
 *     son   500.000 blok -> 258.249 sn-> 0,5165
 *     son 1.652.000 blok -> 848.591 sn-> 0,5137   (fabrikanin dagitimindan beri)
 *
 * BU SABIT 0,35'TI VE YANLISTI -- %47 kadar, ve TEHLIKELI YONDE. Deger
 * bloklari YASA cevirir; kucuk bir sabit yasi kucuk gosterir, yani veriyi
 * OLDUGUNDAN TAZE gosterir. Canli sitede olculdu: indexer 1.229.458 blok
 * geridiyken uyari "~5 days" yaziyordu, dogrusu ~7,4 gundu. Bir islem
 * sitesinde bayatligi eksik soylemek, fazla soylemekten cok daha kotudur.
 *
 * BU YUZDEN YUKARI YUVARLANDI. Olculen aralik 0,5137-0,5192; 0,52 hepsinin
 * ustunde. Suphede kalindiginda yas BUYUK gorunmeli.
 *
 * VE BU SAYI BAYATLAR. Zincirin hizi bizim kontrolumuzde degil; 0,35 de bir
 * zamanlar olculmustu. Yeniden olcmek icin iki blogun `timestamp` farkini
 * span'a bolmek yeterli -- yukaridaki tablo tam olarak bu.
 */
export const ARC_BLOCK_SECONDS = 0.52

/**
 * ============ BAYATLIGIN CUMLESI -- IKI OLGU, HICBIRI DUSMEZ ============
 *
 * Bes sebebin her biri ayri bir ariza ve ayri bir runbook dalidir. Bir
 * onceki hal DORT sebep tasiyordu ve `writes-stalled` dali gecikmeyi
 * SOYLEMIYORDU; kompozisyon kosusunda 25 cizimin 25'i o dala dustu ve
 * `blocksBehind: 727334` -- aynen elde olan tek eyleme donusebilir sayi --
 * ekrana hic gelmedi. Ustelik GERCEKTEN olmus bir indexer de birebir ayni
 * cumleyi yaziyordu.
 *
 * SIMDI:
 *   - "yasiyor ama geride" (`behind-head`) ile "durmus" (`writes-stalled`)
 *     ayri cumlelerdir, ve ikincisi birincisinden ULASILAMAZ: geri cekilen
 *     indexer artik `noteAlive` ile canliligini yaziyor;
 *   - ikisi AYNI ANDA dogruysa (`stopped-and-behind`) cumle IKISINI DE soyler,
 *     birini otekinin altina gizlemez.
 */
export function describeStaleness(indexer: StaleIndexer): string {
  const at = indexer.at
  const age = describeLag(at?.stalenessSeconds ?? null)
  // SON BILINEN gecikme. Bir bayat dalda gecikme neredeyse hicbir zaman TAZE
  // OLCULMUS degildir (surec durduysa ya da basa bakamiyorsa, gozlem de
  // donmustur), yani burada okunan sey bir ALT SINIRDIR ve cumleler onu oyle
  // yazar -- "when it last reported/looked".
  const head = at?.head
  const lastKnown =
    head === undefined ? null : head.measured ? head.blocksBehind : head.lastKnownBlocksBehind
  const lag = describeBlockLag(lastKnown)
  const lookedAgo = describeLag(
    head === undefined
      ? null
      : head.measured
        ? head.observedSecondsAgo
        : head.lastObservedSecondsAgo,
  )
  switch (indexer.why) {
    case 'never-ran':
      return 'Our indexer has never run against this database, so nothing here has been checked against the chain.'
    case 'head-unknown':
      return `Our indexer last reported ${age} but has never recorded where the chain head was, so how far behind this page is CANNOT be measured.`
    /**
     * N1. INDEXER YASIYOR, AMA ZINCIRE BAKAMIYOR.
     *
     * Bu cumle bir sure HIC YAZILMIYORDU: durum TAZE dalina dusuyor ve sayfa
     * hicbir uyari cizmiyordu (olculdu, 11/11 cizim, gercek gecikme 120 blok).
     * "Bilmiyorum" demek, "sifir" demekten her zaman iyidir.
     */
    case 'head-stale':
      return `Our indexer is running but has not been able to read the chain head for ${lookedAgo.replace(/ ago$/, '')} — it is most likely backing off a rate limit — so how far behind this page is CANNOT be measured right now. When it last looked it was ${lag} behind.`
    case 'writes-stalled':
      // GECIKME DE YAZILIR, kucuk olsa bile: "durmus olabilir" tek basina
      // operatore verinin NE KADAR eski oldugunu soylemez, ve bu sayfa tam
      // olarak o soruyu cevaplamak icin var.
      return `Our indexer has not reported for ${age.replace(/ ago$/, '')} and may have stopped. When it last looked at the chain it was ${lag} behind.`
    case 'stopped-and-behind':
      return `Our indexer has not reported for ${age.replace(/ ago$/, '')} and may have stopped, and it was ALREADY ${lag} behind the chain when it last looked.`
    case 'behind-head':
      // "hala yetisiyor": son rapor TAZE **VE** gozlem TAZE -- yani bu, bir
      // hatira degil bir OLCUMDUR, ve cumle onu oyle yazabilir.
      return `Our indexer is ${lag} behind the chain and still catching up (last reported ${age}).`
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

/**
 * `1 second`, `2 seconds` -- ve TEKILI OLAN "1" ELDE VARDI DEGIL.
 *
 * Bu hata dosyada zaten duruyordu ve GORUNMUYORDU: `ARC_BLOCK_SECONDS` 0,35
 * iken tek bir blok `Math.round(0,35) = 0` verip "0 seconds" yaziyordu, ki
 * cogul dogru. Sabit olculen degerine (0,52) cekilince ayni blok 1'e yuvarlandi
 * ve "1 seconds" ekrana cikti. Bir sayiyi duzeltmek, o sayinin sakladigi
 * hatayi ortaya cikardi.
 */
function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}

function describeDuration(seconds: number): string {
  if (seconds < 90) return plural(Math.round(seconds), 'second')
  const minutes = seconds / 60
  if (minutes < 90) return plural(Math.round(minutes), 'minute')
  const hours = minutes / 60
  return hours < 48 ? plural(Math.round(hours), 'hour') : plural(Math.round(hours / 24), 'day')
}
