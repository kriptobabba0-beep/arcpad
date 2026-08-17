/**
 * Uzerine insa ettigimiz zincir degisti. Ingest DURUR.
 *
 * Ayri bir sinif, cunku cagiran bunu diger hatalardan AYIRT ETMEK zorunda:
 * gecici bir RPC hatasi yeniden denenir, bu denenmez.
 */
export class ReorgDetected extends Error {
  constructor(
    readonly cursor: bigint,
    readonly expectedParentHash: string,
    readonly actualParentHash: string,
  ) {
    super(
      `ReorgDetected: blok ${cursor + 1n}'in parentHash'i ${actualParentHash}, ` +
        `ama imlecin ${cursor} numarali blogu icin ${expectedParentHash} kaydedilmisti. ` +
        `Uzerine insa edilen zincir degismis; ingest durdu.`,
    )
    this.name = 'ReorgDetected'
  }
}

/**
 * ZINCIR BAGI MUHAFIZI -- reorg'la disari dusmus bir kaydin tutulmasini
 * onleyen sey.
 *
 * NICIN `packages/db` ICINDE: onceki hali `indexer/src/cursor.ts`teydi ve
 * TAVSIYE NITELIGINDEYDI -- `replayRange` onu hic cagirmiyordu ve tek
 * cagirani sabit kodlanmis bir `null` geciyordu, yani calisan hicbir yolda
 * hicbir sey karsilastirilmiyordu. Muhafiz, imleci ILERLETEN kodun yaninda
 * durursa ozellik SOZLESMEYLE degil YAPIYLA saglanir: `replayRange` disinda
 * imleci ilerleten bir yol yok, ve `replayRange` once bagi kontrol etmeden
 * ilerletemiyor. `indexer/src/cursor.ts` bunu yeniden disa aktarir, yani
 * indexer'in yuzeyi degismez.
 *
 * BU BIR ONARIM DEGIL, BIR IDDIADIR:
 *
 *  - Keeper `launchCount()` slotunu biriktirdigi `Launched` loglariyla
 *    karsilastiriyor; reorg'la dusmus bir kayit o kumeyi FAZLA saydirir ve
 *    keeper bunu bulundugu yerden ENGELLEYEMEZ. Engelleme verinin kuruldugu
 *    yere ait, ve `Launched`a degil HER olay tipine uygulanmali -- bu yuzden
 *    muhafiz olaylara degil BLOKLARA takili.
 *  - IHLAL GORULMEDI ve bu muhafiz bir ihlal goruldugu icin YAZILMADI. Arc
 *    ~350ms deterministik finality ve reorg olmadigini BELGELIYOR; batch'li
 *    olcum `latest`, `safe` ve `finalized`i AYNI blok gosteriyor; ve ingest
 *    yalnizca `finalized` etiketinden okuyor.
 *  - Gerekce ASIMETRIK MALIYET: varsayim tutarsa tur basina bir
 *    karsilastirma; tutmazsa SESSIZ bir fazla sayim ve keeper onu ancak
 *    OLDUKTAN SONRA fark eder.
 *  - KENDINI ONARAN bir geri sarma BILEREK YAZILMADI. Iki sebep: reorg
 *    uretmeyen bir zincirde onu hicbir sey egzersiz etmez ("hicbir seyin
 *    calistirmadigi kod yolu"), VE geri sarma hicbir gozlemin sinirlamadigi
 *    bir derinlik tahmin etmek zorundadir -- yanlis bir tahmin veritabanini
 *    ONARILMIS GORUNURKEN yeni bir bicimde sessizce yanlis birakir. Durmanin
 *    boyle bir kipi yoktur.
 *
 * Maliyet TUR BASINA SABIT: araligin ilk blogunun basligindaki `parentHash`,
 * imlecin blogu icin sakladigimiz hash'e esit olmali. Reorg bir SONEKI
 * yeniden yazdigi icin, imlecten daha derin bir degisiklik de imlecin
 * blogunu degistirir ve ayni tek karsilastirmayla yakalanir.
 *
 * @param cursorHash imlecin blogu icin kaydedilen hash; ilk kosuda `null`.
 */
export function assertContinuous(
  cursor: bigint,
  cursorHash: string | null,
  firstBlockParentHash: string,
): void {
  // ILK KOSU: uzerine insa edilmis bir sey yok, karsilastirilacak sey de yok.
  if (cursorHash === null) return
  const expected = cursorHash.toLowerCase()
  const actual = firstBlockParentHash.toLowerCase()
  if (expected !== actual) throw new ReorgDetected(cursor, expected, actual)
}
