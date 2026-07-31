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
 * Head'in TEK kaynagi.
 *
 * `finalized`, `latest` DEGIL. Arc'ta ikisi genelde ESIT (deterministik
 * finality, olculen gecikme 0 blok) ama AYNI KAYNAK DEGILLER; olculdu:
 *
 *   latest 54326388  finalized 54326388  safe 54326388
 *   latest 54326390  finalized 54326391  safe 54326391   <-- finalized > latest
 *   latest 54326393  finalized 54326393  safe 54326394
 *
 * Yuk dengeleyici arkasinda farkli dugumler iki bagimsiz gecikmeli gorunum
 * verir. Karistirmak, ayni turda GELECEKTEN bir head ile GECMISTEN bir aralik
 * hesaplamak olurdu. `finalized` iki okuma arasinda geriye de dusebilir;
 * `nextRange`'in `head <= cursor -> null` dali bunu yutar ve o dalin gerekcesi
 * artik olculmus bir olgudur, varsayim degil.
 */
export async function finalizedHead(client: PublicClient): Promise<bigint> {
  const block = await client.getBlock({ blockTag: 'finalized' })
  return block.number
}
