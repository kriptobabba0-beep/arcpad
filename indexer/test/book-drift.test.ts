import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadAddressBook } from '@arcpad/shared'

/**
 * ============================================================================
 *  CANLI SUITIN SABITLERI DEFTERDEN AYRIŞAMAZ
 * ============================================================================
 *
 * OLCULDU (19 Agustos 2026): `indexer-live` is akisi ILK zamanlanmis kosusunda
 * komple kirmiziydi -- dokuz test, hepsi `expected +0 to be 1`. Sebep RPC degil
 * AYRISMAYDI: `live.test.ts` `FACTORY_BLOCK = 55_870_261n` tariyordu, oysa
 * defterin `launchFactoryBlock`u **57_179_323**. Fabrika yeniden deploy
 * edilmisti; defter guncellendi, suit guncellenmedi.
 *
 * SUITIN KENDI YORUMU DEFTERI ISARET EDIYORDU -- "(defterin `launchFactoryBlock`u)"
 * -- ama deger bir KOPYAYDI. `indexer-live.yml` bu dersi factory ADRESI icin
 * coktan ogrenmisti ("baska her tuketici defteri okuyor, yalnizca burasi
 * okumuyordu"); ayni dosyadaki BLOK ve SMOKE sabitleri ogrenmemisti.
 *
 * BU DOSYA CANLI ZINCIRE DOKUNMAZ ve bilerek: ayrisma bir YAPILANDIRMA
 * olgusudur, bir ag olgusu degil. RPC'siz, saniyenin altinda kosar.
 *
 * VE `test/integration/` ICINDE DEGIL: o dizin normal suitten HARIC tutulur
 * (`exclude: test/integration/**`), yani orada dursaydi yalnizca gunluk cron
 * onu gorurdu -- tam da bu ayrismanin aylarca fark edilmemesinin sebebi.
 * Burada her PR'da kosar.
 */
describe('canli suit ile adres defteri AYRIŞAMAZ', () => {
  const book = loadAddressBook(5_042_002)
  const source = readFileSync(join(import.meta.dirname, 'integration', 'live.test.ts'), 'utf8')

  /** Suitteki `const NAME = 123n` degerini okur. */
  function constant(name: string): bigint {
    const m = new RegExp(`const ${name} = ([0-9_]+)n`).exec(source)
    expect(m, `${name} suitte bulunamadi`).not.toBeNull()
    return BigInt((m?.[1] ?? '0').replace(/_/g, ''))
  }

  /** `EXPECTED` icindeki bir adresi okur. */
  function expected(field: string): string {
    const m = new RegExp(`${field}: '(0x[0-9a-fA-F]{40})'`).exec(source)
    expect(m, `EXPECTED.${field} suitte bulunamadi`).not.toBeNull()
    return (m?.[1] ?? '').toLowerCase()
  }

  it('FACTORY_BLOCK defterin `launchFactoryBlock`udur', () => {
    expect(
      constant('FACTORY_BLOCK'),
      'suit BASKA bir fabrikanin blogunu tariyor -- hicbir launch bulamaz ve ' +
        'butun iddialar 0 uzerinden duser',
    ).toBe(book.launchFactoryBlock)
  })

  it('START_BLOCK defterin `startBlock`udur', () => {
    expect(constant('START_BLOCK')).toBe(book.startBlock)
  })

  it('smoke penceresi launch`i KAPSAR', () => {
    // `SMOKE_LAST` taramanin durdugu yer; fabrikadan once biterse smoke launch
    // pencerenin DISINDA kalir ve suit yine 0 goruru.
    expect(constant('SMOKE_LAST')).toBeGreaterThan(constant('FACTORY_BLOCK'))
  })

  it('EXPECTED.escrow defterin escrow`udur', () => {
    expect(expected('escrow')).toBe(book.feeEscrow.toLowerCase())
  })

  it('EXPECTED.token defterin `smokeToken`udur', () => {
    expect(book.smokeToken, 'defterde smokeToken yok').not.toBeNull()
    expect(expected('token')).toBe((book.smokeToken ?? '').toLowerCase())
  })

  it('EXPECTED.curve defterin `smokeCurve`udur', () => {
    expect(book.smokeCurve, 'defterde smokeCurve yok').not.toBeNull()
    expect(expected('curve')).toBe((book.smokeCurve ?? '').toLowerCase())
  })

  it('AYIRT EDICI: okuyucu gercekten okuyor -- olmayan bir sabit BULUNAMAZ', () => {
    // Anti-vakumluk. Regex hicbir sey bulamayip `0n` donseydi ustteki
    // iddialarin bir kismi tesadufen gecebilirdi.
    expect(() => constant('BOYLE_BIR_SABIT_YOK')).toThrow()
  })
})
