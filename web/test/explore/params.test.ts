import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SORT,
  exploreHref,
  parseCursorStack,
  parseExploreParams,
} from '@/components/explore/params'
import { SORT_KEYS } from '@/components/read/types'

/**
 * URL'DEN GELEN BIR DIZE HICBIR ZAMAN BIR SQL IFADESINE DONUSMEZ.
 *
 * Bu, "parametreleri baglayin" tavsiyesinin ONUNDEKI savunmadir: siralama bir
 * DEGER degil bir IFADE oldugu icin baglanamaz, dolayisiyla tek guvenli sekil
 * onu bir ANAHTARA cozmektir. Beyaz listenin disina cikan her sey varsayilana
 * duser.
 */
describe('parseExploreParams', () => {
  it('bes mesru siralamayi gecirir', () => {
    for (const sort of SORT_KEYS) {
      expect(parseExploreParams({ sort }).sort).toBe(sort)
    }
  })

  it.each([
    ['marketCapWei DESC', 'ham SQL'],
    ["'; DROP TABLE launches--", 'enjeksiyon denemesi'],
    ['createdSeq', 'gercek bir kolon adi'],
    ['RECENTBUYS', 'buyuk harf'],
    ['', 'bos dize'],
  ])('%s (%s) varsayilana duser', (sort) => {
    const parsed = parseExploreParams({ sort })
    expect(parsed.sort).toBe(DEFAULT_SORT)
    expect(SORT_KEYS).toContain(parsed.sort)
  })

  it('parametre hic verilmediginde varsayilan recentBuys', () => {
    expect(parseExploreParams({}).sort).toBe('recentBuys')
  })

  it('`?sort=a&sort=b` -> ILK deger baglayicidir', () => {
    expect(parseExploreParams({ sort: ['marketCap', 'volume'] }).sort).toBe('marketCap')
  })

  it('yas filtresi yalnizca all / 1 / 7 kabul eder', () => {
    expect(parseExploreParams({ age: 'all' }).ageDays).toBeNull()
    expect(parseExploreParams({ age: '1' }).ageDays).toBe(1)
    expect(parseExploreParams({ age: '7' }).ageDays).toBe(7)
    // 30 gun bir indeks tarafindan desteklenmiyor; sessizce "hepsi" olur.
    expect(parseExploreParams({ age: '30' }).ageDays).toBeNull()
    expect(parseExploreParams({ age: 'OR 1=1' }).ageDays).toBeNull()
  })

  it('cursor yalnizca ondalik basamaklardan olusabilir', () => {
    // Keyset cursor'u bir `eventSeq`tir. Sekli dogrulamak, onu sorguya
    // parametre olarak baglamanin YERINE GECMEZ; onunde durur.
    expect(parseExploreParams({ after: '4194304' }).cursor).toBe('4194304')
    expect(parseExploreParams({ after: '4194304; DROP' }).cursor).toBeNull()
    expect(parseExploreParams({ after: '-1' }).cursor).toBeNull()
    expect(parseExploreParams({ after: '0x10' }).cursor).toBeNull()
  })
})

describe('exploreHref', () => {
  it('varsayilanlari URL’e YAZMAZ -- temiz adres paylasilabilir adrestir', () => {
    expect(exploreHref({ sort: 'recentBuys', ageDays: null, cursor: null }, {})).toBe('/')
  })

  it('varsayilan olmayan degerleri tasir', () => {
    expect(
      exploreHref({ sort: 'recentBuys', ageDays: null, cursor: null }, { sort: 'volume' }),
    ).toBe('/?sort=volume')
    expect(exploreHref({ sort: 'marketCap', ageDays: null, cursor: null }, { age: '7' })).toBe(
      '/?sort=marketCap&age=7',
    )
  })

  it('filtre degistiginde cursor DUSURULUR', () => {
    // Tasinsaydi, yeni siralamada anlami olmayan bir anahtardan devam
    // edilirdi: kullanici "Market cap"e tikladiginda listenin ortasindan
    // basliyor olurdu.
    const href = exploreHref({ sort: 'newest', ageDays: 7, cursor: '4194304' }, { sort: 'volume' })
    expect(href).not.toContain('after')
    expect(href).toBe('/?sort=volume&age=7')
  })
})

describe('parseCursorStack', () => {
  it('gezilen cursor yigini URL’de tasinir', () => {
    // Bellekte tutulan bir yigin, yenilemede ya da paylasilan bir adreste
    // yok olur -- sayfa bir server component.
    expect(parseCursorStack('10.20', '30')).toEqual(['10', '20', '30'])
    expect(parseCursorStack(undefined, null)).toEqual([])
  })

  it('yigindaki cop degerler atilir', () => {
    expect(parseCursorStack('10.abc.20', null)).toEqual(['10', '20'])
  })
})
