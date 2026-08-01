/**
 * Kosullu sinif birlestirme, ve bilerek bundan fazlasi degil.
 *
 * `tailwind-merge` gibi bir cakisma cozucu EKLENMEDI: paylasilan
 * `pnpm-lock.yaml`'a bir bagimlilik yazmanin bedeli, bu kabukta cozdugu
 * problemin buyuklugunden fazla. Bileşenler cakisan yardimci siniflari
 * varyant tablolarinda ayristirir, cagiran tarafin `className`'i en sona
 * yazilir.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
