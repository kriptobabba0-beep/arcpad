import { METADATA_LIMITS } from '@arcpad/shared/browser'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ByteCounter } from '@/components/create/ByteCounter'
import {
  buildMetadataJson,
  countBytes,
  descriptionState,
  displayName,
  EMPTY_FIELDS,
  fieldState,
  uriLooksResolvable,
  validateLaunch,
} from '@/components/create/fields'

/**
 * SEKIZ BAYT VEKTORU, PINLENMIS.
 *
 * Hepsi ayni tek hatayi olcuyor: `String.length` UTF-16 KOD BIRIMI sayar,
 * Solidity'nin `bytes(string).length`i UTF-8 BAYTI. ASCII'de esittirler ve
 * baska hicbir yerde degil.
 */
describe('bayt sayimi -- brief’in vektorleri', () => {
  it('rocket x8 = 32/32, TAM sinirda ve kabul', () => {
    const state = fieldState('name', '\u{1F680}'.repeat(8))
    expect(state.bytes).toBe(32)
    expect(state.over).toBe(false)
    expect(state.atLimit).toBe(true)
  })

  it('rocket x9 = 36/32, RET -- ve `.length` 18 diyerek kabul ederdi', () => {
    const value = '\u{1F680}'.repeat(9)
    // Mutantin gordugu sayi. Testin kendisi bunu yaziyor ki, sayacin
    // `.length`e cevrilmesi halinde neyin yesil kalacagi belli olsun.
    expect(value.length).toBe(18)
    expect(countBytes(value)).toBe(36)
    expect(fieldState('name', value).over).toBe(true)
  })

  it('NFD "e" + U+0301 IKI bayt sayilir, uc degil', () => {
    const nfd = 'e\u0301'
    expect(nfd.length).toBe(2)
    // Normalize edilmeden UTF-8'de 3 bayt: 'e' (1) + U+0301 (2). Kaynakta
    // ESCAPE olarak duruyor, harfin kendisiyle degil: NFD bir "é" yazsaydik,
    // bir sonraki editor onu sessizce NFC'ye cevirdiginde test yesil kalir ve
    // olctugu sey yok olurdu.
    expect(new TextEncoder().encode(nfd).length).toBe(3)
    // `normaliseMetadataText` NFC'ye cevirir: 'é' tek kod noktasi, 2 bayt --
    // ve ZINCIRE GIDEN dize de odur.
    expect(countBytes(nfd)).toBe(2)
  })

  it('"Gorusuruz" (Turkce diakritikleriyle) 14 bayt', () => {
    expect(countBytes('Görüşürüz')).toBe(14)
  })

  it('sembol: rocket x3 = 12/13 kabul, x4 = 16/13 ret', () => {
    expect(METADATA_LIMITS.symbol).toBe(13)
    const three = fieldState('symbol', '\u{1F680}'.repeat(3))
    expect(three.bytes).toBe(12)
    expect(three.over).toBe(false)

    const four = fieldState('symbol', '\u{1F680}'.repeat(4))
    expect(four.bytes).toBe(16)
    expect(four.over).toBe(true)
  })

  it('bosluk kirpilir ve sayilmaz', () => {
    // Gorunmez, bayta mal olur, ve " arcpad" ile "arcpad" her listede ayni
    // gorunur.
    expect(countBytes('  arcpad  ')).toBe(6)
  })

  it('ipfs:// + CIDv1 base32 = 66 bayt, 200 sinirinin cok altinda', () => {
    const uri = `ipfs://${'b'.repeat(59)}`
    expect(countBytes(uri)).toBe(66)
    expect(fieldState('uri', uri).over).toBe(false)
  })

  it('sorgu parametreli bir gateway URL’i 200 baytı asabilir ve sayac bunu gosterir', () => {
    const long = `https://gateway.example/ipfs/${'b'.repeat(59)}?${'k=v&'.repeat(40)}`
    expect(countBytes(long)).toBeGreaterThan(METADATA_LIMITS.uri)
    expect(fieldState('uri', long).over).toBe(true)
  })
})

describe('<ByteCounter>', () => {
  it('sinirin altinda muted, TAM sinirda accent, ustunde negative', () => {
    const { rerender } = render(<ByteCounter value="ab" maxBytes={32} />)
    expect(screen.getByTestId('byte-counter')).toHaveClass('text-muted')

    rerender(<ByteCounter value={'\u{1F680}'.repeat(8)} maxBytes={32} />)
    expect(screen.getByTestId('byte-counter')).toHaveClass('text-accent')

    rerender(<ByteCounter value={'\u{1F680}'.repeat(9)} maxBytes={32} />)
    expect(screen.getByTestId('byte-counter')).toHaveClass('text-negative')
  })

  it('asim RENKTEN BASKA bir isaret de tasir ve duyurulur', () => {
    render(<ByteCounter value={'\u{1F680}'.repeat(9)} maxBytes={32} />)
    const counter = screen.getByTestId('byte-counter')
    // Kirmiziyi gormeyen biri icin de sinir asilmis olmali.
    expect(counter).toHaveTextContent('36/32 bytes')
    expect(counter).toHaveTextContent('over the limit')
    expect(counter).toHaveAttribute('role', 'alert')
  })

  it('sayac ZINCIRE GIDEN dizeyi sayar: NFD girdi 2 bayt yazar', () => {
    render(<ByteCounter value="é" maxBytes={32} />)
    expect(screen.getByTestId('byte-counter')).toHaveTextContent('2/32 bytes')
  })
})

describe('validateLaunch', () => {
  it('bos isim ve bos sembol AYRI hatalardir', () => {
    const result = validateLaunch(EMPTY_FIELDS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.name).toMatch(/name is required/i)
    expect(result.errors.symbol).toMatch(/symbol is required/i)
  })

  it('BOS `uri` GECERLIDIR -- kontrat yalnizca isim ve sembol ister', () => {
    const result = validateLaunch({ ...EMPTY_FIELDS, name: 'Diffusion', symbol: 'DIFF' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args).toEqual({ name: 'Diffusion', symbol: 'DIFF', uri: '' })
  })

  it('gonderilen dize OLCULEN dizedir: NFC normalize edilmis hâli doner', () => {
    const result = validateLaunch({ ...EMPTY_FIELDS, name: ' Café ', symbol: 'CAFE' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.name).toBe('Café')
    expect(countBytes(result.args.name)).toBe(5)
  })

  it('36 baytlik isim reddedilir ve hata BAYT sayisini yazar', () => {
    const result = validateLaunch({
      ...EMPTY_FIELDS,
      name: '\u{1F680}'.repeat(9),
      symbol: 'DIFF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.name).toContain('36 bytes')
  })

  it('data: ve http: URI reddedilir -- `uri` DEGISTIRILEMEZ', () => {
    expect(uriLooksResolvable('data:application/json,{}')).toBe(false)
    expect(uriLooksResolvable('http://example.com/meta.json')).toBe(false)
    expect(uriLooksResolvable('ipfs://bafyfoo')).toBe(true)
    expect(uriLooksResolvable('https://example.com/meta.json')).toBe(true)
    expect(uriLooksResolvable('')).toBe(true)
  })
})

describe('gosterim ve metadata dokumani', () => {
  it('gosterimde gorunmez karakterler ve bidi override’lari duser', () => {
    // Taklit bir launchpad'de gercek bir yoldur; React'in kacislamasi HTML
    // enjeksiyonunu durdurur, GORSEL TAKLIDI durdurmaz.
    expect(displayName('Diff\u202Eusion')).toBe('Diffusion')
    expect(displayName('a\u200Bb')).toBe('ab')
  })

  it('metadata JSON’u bos alanlari HIC yazmaz', () => {
    const json = buildMetadataJson({ ...EMPTY_FIELDS, name: 'Diffusion', symbol: 'DIFF' })
    expect(JSON.parse(json)).toEqual({ name: 'Diffusion', symbol: 'DIFF' })
    expect(json).not.toContain('description')
  })

  it('anahtar sirasi SABIT: ayni alanlar ayni dizeyi, yani ayni CID’i verir', () => {
    const json = buildMetadataJson({
      name: 'Diffusion',
      symbol: 'DIFF',
      description: 'A token',
      image: 'ipfs://bafyimage',
      x: 'https://x.com/diff',
      telegram: 'https://t.me/diff',
      uri: 'ignored',
    })
    expect(json).toBe(
      '{"name":"Diffusion","symbol":"DIFF","description":"A token","image":"ipfs://bafyimage","x":"https://x.com/diff","telegram":"https://t.me/diff"}',
    )
    // `uri` dokumana GIRMEZ: dokumanin kendisi o URI'nin gosterdigi seydir.
    expect(json).not.toContain('ignored')
  })

  it('aciklama sayaci OKUYUCUNUN kirptigi gibi sayar (karakter, bayt degil)', () => {
    // `web/lib/metadata.ts` `.slice(0, 256)` yapar ve `.slice` UTF-16 sayar.
    const state = descriptionState('\u{1F680}'.repeat(4))
    expect(state.used).toBe(8)
    expect(state.limit).toBe(256)
    expect(state.over).toBe(false)
  })
})
