/**
 * ============================================================================
 *  "BU BIR GORSEL MI" SORUSUNUN TEK CEVABI
 * ============================================================================
 *
 * IKI YER SORUYOR ve ikisinin AYNI cevabi vermesi zorunlu:
 *
 *   `/api/metadata`  -- YUKLERKEN. Neyin pinlenecegine karar verir.
 *   `/api/ipfs/…`    -- SUNARKEN.  Neyin servis edilecegine karar verir.
 *
 * AYRISTIKLARINDA NE OLUR, IKI YONDE DE:
 *   - Yukleme gevsek, sunum siki  -> kabul edilen dosya bir daha ASLA
 *     gorunmez. Kullanici gorselini yukler, form basarili der, kart sonsuza
 *     kadar gradyan cizer. (OLCULDU: yukleme `file.type`a bakiyordu, yani
 *     ISTEMCININ SOYLEDIGINE -- multipart basligina `image/png` yazan biri
 *     herhangi bir baytı pinletebiliyordu.)
 *   - Yukleme siki, sunum gevsek -> sunum HTML sunabilir hale gelir, yani
 *     bizim origin'imizden depolanmis XSS.
 *
 * Bu yuzden karar TEK YERDE ve BAYTLARDAN verilir. Dosyayi pinleyen kisinin
 * yalan soyleyemeyecegi tek sey baytlardir.
 *
 * `image/svg+xml` YOKTUR VE EKLENMEYECEK: SVG betik calistirabilen bir
 * dokumandir ve gateway URL'i dogrudan acilabilir.
 */

/** Kabul edilen dort tur. Baska tur EKLEMEK, iki rotayi da etkiler. */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

/**
 * Baytlardan tur; taninmiyorsa `null`.
 *
 * Yalnizca BASLANGIC baytlarina bakar, dolayisiyla cagiran dosyanin tamamini
 * bellege almak zorunda degil -- ilk 12 bayt yeter.
 */
export function imageTypeOf(bytes: Uint8Array): AllowedImageType | null {
  const at = (i: number): number | undefined => bytes[i]

  // PNG: 89 50 4E 47 ("\x89PNG")
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return 'image/jpeg'
  }
  // GIF: 47 49 46 38 ("GIF8")
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return 'image/gif'
  }
  // WebP: "RIFF" ---- "WEBP". Dort bayt UZUNLUK atlanir; onlar iceriktir.
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/** Sihirli sayilarin okunmasi icin gereken en kucuk on ek. */
export const IMAGE_MAGIC_BYTES = 12
