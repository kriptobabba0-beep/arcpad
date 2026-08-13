import { describe, expect, it } from 'vitest'
import { IMAGE_MAGIC_BYTES, imageTypeOf, ALLOWED_IMAGE_TYPES } from '@/lib/imageBytes'

/**
 * ============================================================================
 *  TUR, ISTEMCININ SOZUNDEN DEGIL BAYTLARDAN
 * ============================================================================
 *
 * BULUNAN KUSUR (denetim, ikinci tur): `/api/metadata` dosya turunu
 * `file.type`tan okuyordu -- yani MULTIPART BASLIGINDAN, ki onu yukleyen
 * yazar. `Content-Type: image/png` yazan biri herhangi bir baytı pinletebilirdi,
 * ve o rota KIMLIK DOGRULAMASI ISTEMIYOR: internetteki herkes bizim odedigimiz
 * pinning hesabina 5 MB'lik keyfi icerik yazabiliyordu.
 *
 * Depolanmis XSS'e donusmuyordu -- sunum rotasi zaten baytlara bakiyor -- ama
 * iki taraf AYRI kaynaklardan karar veriyordu, ve ayrisma iki yonde de sessiz
 * bir arizadir.
 */

const png = (n = 16) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b }
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const gif = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
const webp = () => { const b = new Uint8Array(16); b.set([0x52,0x49,0x46,0x46], 0); b.set([0x57,0x45,0x42,0x50], 8); return b }
const text = (s: string) => new TextEncoder().encode(s)

describe('imageTypeOf', () => {
  it('dort turu de baytlarindan tanir', () => {
    expect(imageTypeOf(png())).toBe('image/png')
    expect(imageTypeOf(jpeg())).toBe('image/jpeg')
    expect(imageTypeOf(gif())).toBe('image/gif')
    expect(imageTypeOf(webp())).toBe('image/webp')
  })

  it('HTML REDDEDILIR -- pinlenen dosyanin gateway URL\u2019i dogrudan acilabilir', () => {
    expect(imageTypeOf(text('<html><script>alert(1)</script>'))).toBeNull()
    expect(imageTypeOf(text('<!DOCTYPE html>'))).toBeNull()
  })

  it('SVG REDDEDILIR ve edilmeye devam etmeli -- betik calistirabilen bir dokumandir', () => {
    expect(imageTypeOf(text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull()
    expect(ALLOWED_IMAGE_TYPES).not.toContain('image/svg+xml')
  })

  it('KEYFI VERI reddedilir -- kotamiz baskasinin deposu degil', () => {
    expect(imageTypeOf(text('PK\u0003\u0004 zip'))).toBeNull()
    expect(imageTypeOf(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toBeNull()
    expect(imageTypeOf(new Uint8Array())).toBeNull()
  })

  it('KISA GIRDI ATMAZ, `null` doner', () => {
    // Yukleme rotasi yalnizca ilk 12 baytı okur; kisa bir dosya orada biter.
    expect(imageTypeOf(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(imageTypeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull() // RIFF ama WEBP degil
  })

  it('RIFF ama WEBP OLMAYAN reddedilir -- ornegin bir WAV', () => {
    const wav = new Uint8Array(16)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"
    expect(imageTypeOf(wav)).toBeNull()
  })

  it('ON EK 12 BAYT YETER -- rota dosyanin tamamini bellege almaz', () => {
    expect(IMAGE_MAGIC_BYTES).toBe(12)
    for (const make of [png, jpeg, gif, webp]) {
      const full = make()
      expect(imageTypeOf(full.slice(0, IMAGE_MAGIC_BYTES))).toBe(imageTypeOf(full))
    }
  })
})

/**
 * IKI ROTA AYNI KARARI VERMEK ZORUNDA. Ayri kopyalar tutulsaydi bu test
 * yazilamazdi; tek kaynak oldugu icin kapinin kendisi yapisal.
 */
describe('yukleme ile sunum ayrismaz', () => {
  it('her iki rota da `lib/imageBytes` kullanir, kendi kopyasini degil', async () => {
    const [upload, serve] = await Promise.all([
      import('node:fs/promises').then((fs) => fs.readFile('app/api/metadata/route.ts', 'utf8')),
      import('node:fs/promises').then((fs) => fs.readFile('app/api/ipfs/[...path]/route.ts', 'utf8')),
    ])
    for (const [name, src] of [['metadata', upload], ['ipfs', serve]] as const) {
      expect(src, `${name} rotasi imageTypeOf'u ithal etmiyor`).toMatch(
        /import\s*\{[^}]*imageTypeOf[^}]*\}\s*from\s*'@\/lib\/imageBytes'/,
      )
      expect(src, `${name} rotasi kendi sihirli sayilarini tasiyor`).not.toMatch(/0x89.*0x50.*0x4e/s)
    }
  })
})
