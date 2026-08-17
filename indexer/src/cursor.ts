import type { PublicClient } from 'viem'

/**
 * Arc'in `eth_getLogs`'unun kabul ettigi en genis blok araligi.
 *
 * SINIR NOTU -- bu sabitin normal evi `@arcpad/shared`'dir (plan Task 1) ve o
 * paket SU AN baska bir ajanin elinde. Ona uzanmak yerine ihtiyac duyulan sey
 * burada, bu taskin sahip oldugu sinirda tanimlanir. Task 1 indigi gun bu satir
 * `export { ARC_GETLOGS_MAX_RANGE } from '@arcpad/shared'` olur ve dosyanin
 * geri kalani DEGISMEZ -- `nextRange` sabiti ada gore kullanir, degere gore
 * degil.
 *
 * Deger olculmustur (plan 3. faz, "aralik" bolumu): span 10.000 gecti,
 * 50.000 -32012 dondu, 100.000 -32614 dondu.
 */
export const ARC_GETLOGS_MAX_RANGE = 10_000n

/**
 * Islenecek bir sonraki blok araligini hesaplar.
 *
 * Arc'ta deterministik finality vardir (~350ms, reorg yok), bu yuzden geri
 * alma mantigi yoktur. `head` her zaman `finalizedHead`'den gelir ve imlecten
 * geriye duserse -- ki bu yalnizca RPC degistirdigimizde veya bir dugum geride
 * kaldiginda olur -- hicbir sey islemeyiz.
 */
export function nextRange(
  cursor: bigint,
  head: bigint,
  maxSpan: bigint,
): { from: bigint; to: bigint } | null {
  // maxSpan <= 0 TERS bir aralik uretiyordu: nextRange(0n, 10n, 0n) ->
  // {from: 1n, to: 0n}. Faz 0'da zararsizdi (MAX_SPAN modul sabitiydi); Faz
  // 3'te konfigurasyondan geldigi icin bir sifir env degeri butun ingest'i
  // sessizce bos aralik dondurmeye cevirirdi.
  // Negatif imlec, `head <= cursor` dalina TAKILMAZ ve `from = cursor + 1n`
  // ile sifirin altinda bir blok numarasi uretir -- `eth_getLogs`'a gonderilen
  // anlamsiz bir aralik. Uygulamada ulasilamaz (imlec `bigint NOT NULL` bir
  // sutundan gelir) ama `toSeq` ayni kontrolu yapiyor ve iki taraf ayni seyi
  // soylemeli: negatif bir blok numarasi yoktur.
  if (cursor < 0n) throw new RangeError(`nextRange: cursor negatif: ${cursor}`)
  if (maxSpan <= 0n) throw new RangeError('nextRange: maxSpan pozitif olmali')
  // Arc'in eth_getLogs'u 10.000 blokla SINIRLI (olculdu: span 10_000 ok,
  // 50_000 -> -32012, 100_000 -> -32614). Sinirin USTUNDE bir maxSpan her
  // cagriyi hataya cevirir; burada reddetmek onu bir baslangic hatasi yapar,
  // her turda tekrarlanan bir calisma zamani hatasi degil.
  if (maxSpan > ARC_GETLOGS_MAX_RANGE) {
    throw new RangeError(`nextRange: maxSpan ${maxSpan} > ${ARC_GETLOGS_MAX_RANGE}`)
  }
  if (head <= cursor) return null

  const from = cursor + 1n
  const remaining = head - cursor
  const to = remaining > maxSpan ? cursor + maxSpan : head

  return { from, to }
}

/**
 * Head'in TEK kaynagi: `finalized` etiketi.
 *
 * DUZELTME -- BU YORUM DAHA ONCE YANLIS BIR OLCUME DAYANIYORDU.
 *
 * Burada eskiden "olculdu: latest 54326390 iken finalized 54326391 idi" diyen
 * bir tablo vardi ve `finalized`in `latest`in ONUNDE gorulebildigi iddia
 * ediliyordu. O sayilar plandan devralinmisti, bu dosyada hicbir zaman
 * calistirilmadi, ve YANLISLAR: sira sira yapilan uc `eth_getBlockByNumber`
 * cagrisi arasinda, Arc'in ~350ms blok suresinde, bir blok gecer. Yani olculen
 * sey etiketlerin farki degil ZAMANIN GECMESIYDI. Kontrol: cagri sirasini ters
 * cevirince isaret de ters donuyor.
 *
 * TEK BIR JSON-RPC BATCH'INDE -- yani uc etiket ayni ani paylasirken --
 * olculdu (arc testnet, 6 ornek, 400ms arayla):
 *
 *   latest=54514654  safe=54514654  finalized=54514654   finalized-latest=0
 *   latest=54514655  safe=54514655  finalized=54514655   finalized-latest=0
 *   latest=54514656  safe=54514656  finalized=54514656   finalized-latest=0
 *   latest=54514656  safe=54514656  finalized=54514656   finalized-latest=0
 *   latest=54514657  safe=54514657  finalized=54514657   finalized-latest=0
 *   latest=54514658  safe=54514658  finalized=54514658   finalized-latest=0
 *
 * UCU DE AYNI. Bu, Arc'in belgelenmis ~350ms deterministik finality'si ve
 * reorg olmamasiyla tutarli.
 *
 * "finalized geriye dusebilir" iddiasi da ayni yerden devralinmisti; ayri
 * olarak sinandi (tek etiket, 80 ardisik okuma, 250ms arayla): sifir gerileme,
 * ayni yukseklikte sifir hash degisikligi. Uretilemedi, o yuzden dayanak
 * olarak KULLANILMIYOR.
 *
 * O HALDE `finalized` OKUMAK NE KAZANDIRIR: bugun olculebilir bir GUVENLIK
 * farki yok. Ama GECIKME de MALIYETI YOK -- uc etiket ayni blok oldugu icin
 * `finalized` okumak `latest` okumaktan bir blok bile geride kalmiyor. Yani
 * bu, "guvenlik icin geriden gitmek" DEGILDIR; bedava olan tarafi secmektir.
 * Anlami ihtiyacimiz olan seye uyan etiket budur (geri alinmayacak blok), ve
 * Arc bir gun belgesinden saparsa yapisal olarak dogru tarafta oluruz.
 *
 * `nextRange`'in `head <= cursor -> null` dali duruyor ama gerekcesi artik
 * "olculmus bir olgu" DEGIL: RPC degistirmek ya da geride kalmis bir dugume
 * dusmek gibi calisma zamani olasiliklarina karsi ucuz bir korumadir.
 */
export async function finalizedHead(client: PublicClient): Promise<bigint> {
  const block = await client.getBlock({ blockTag: 'finalized' })
  return block.number
}

/**
 * ZINCIR BAGI MUHAFIZI -- `@arcpad/db`'den YENIDEN DISA AKTARILIR.
 *
 * Tanim `packages/db/src/reorg.ts`'e tasindi ve gerekcesi orada. Kisaca:
 * muhafiz burada dururken TAVSIYE NITELIGINDEYDI -- `replayRange` onu hic
 * cagirmiyordu ve tek cagirani sabit kodlanmis bir `null` geciyordu, yani
 * calisan hicbir yolda hicbir sey karsilastirilmiyordu. Imleci ilerleten tek
 * yol `replayRange` oldugu icin kontrol oraya tasindi; ozellik artik
 * sozlesmeyle degil YAPIYLA saglaniyor.
 *
 * Buradan da disa aktariliyor ki indexer'in yuzeyi degismesin: bir sonraki
 * ingest dongusu `nextRange` ve `finalizedHead` ile ayni yerden alabilsin.
 */
export { assertContinuous, ReorgDetected } from '@arcpad/db'
