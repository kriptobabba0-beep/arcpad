/**
 * Islenecek bir sonraki blok araligini hesaplar.
 *
 * Arc'ta deterministik finality vardir (~350ms, reorg yok), bu yuzden geri
 * alma mantigi yoktur. `head` her zaman `finalized` etiketinden okunur ve
 * imlecten geriye duserse -- ki bu yalnizca RPC degistirdigimizde veya bir
 * dugum geride kaldiginda olur -- hicbir sey islemeyiz.
 */
export function nextRange(
  cursor: bigint,
  head: bigint,
  maxSpan: bigint,
): { from: bigint; to: bigint } | null {
  if (head <= cursor) return null

  const from = cursor + 1n
  const remaining = head - cursor
  const to = remaining > maxSpan ? cursor + maxSpan : head

  return { from, to }
}
