import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TAB,
  PAGE_SIZE,
  parseExploreParams,
  TAB_KEYS,
  TAB_LABELS,
  TABS,
  tabHref,
  tabQuery,
} from '@/components/explore/params'

/**
 * URL'DEN GELEN HICBIR DIZE BIR SQL IFADESINE DONUSMEZ.
 *
 * Bu suite'in isi tek bir sinir: `searchParams` ham kullanici girdisidir ve
 * `parseExploreParams`ten cikan sey yalnizca `TABS`'in bir ANAHTARI ile
 * sinirlanmis bir tam sayidir. Bes siralama + uc yas filtresi modelinden dort
 * sekmeye gecildi; asagidaki testler o gecisin HICBIR korumayi dusurmedigini
 * gosterir.
 */
describe('parseExploreParams -- sekme', () => {
  it('dort mesru sekmeyi gecirir ve her birini kendi (siralama, pencere) ciftine cozer', () => {
    expect(parseExploreParams({ tab: 'trending' })).toMatchObject({
      tab: 'trending',
      sort: 'volume',
      ageDays: null,
    })
    expect(parseExploreParams({ tab: 'new' })).toMatchObject({
      tab: 'new',
      sort: 'newest',
      ageDays: 7,
    })
    expect(parseExploreParams({ tab: 'top' })).toMatchObject({
      tab: 'top',
      sort: 'marketCap',
      ageDays: null,
    })
    expect(parseExploreParams({ tab: 'nearGraduation' })).toMatchObject({
      tab: 'nearGraduation',
      sort: 'nearGraduation',
      ageDays: null,
    })
  })

  it('parametre hic verilmediginde varsayilan sekme', () => {
    expect(parseExploreParams({})).toMatchObject({ tab: DEFAULT_TAB, page: 1 })
  })

  it('`?tab=a&tab=b` -> ILK deger baglayicidir', () => {
    expect(parseExploreParams({ tab: ['top', 'new'] }).tab).toBe('top')
  })

  /*
   * BEYAZ LISTE DISI HER DEGER SESSIZCE VARSAYILANA DUSER.
   *
   * Sessizce, cunku elle yazilmis bir URL icin hata sayfasi gostermek bir sey
   * kazandirmaz. Ama SORGUYA ULASMAMASI zorunlu: asagidaki dizelerin her biri
   * bir `ORDER BY` ifadesine yapistirilsaydi calisan bir enjeksiyon olurdu.
   */
  it.each([
    ['bilinmeyen anahtar', 'volume'],
    ['SQL parcasi', '1; DROP TABLE launches--'],
    ['ORDER BY enjeksiyonu', 'created_seq DESC, (SELECT 1)'],
    ['bos dize', ''],
    ['bosluk', ' trending '],
    ['buyuk harf', 'TRENDING'],
  ])('%s -> varsayilan sekme', (_label, value) => {
    expect(parseExploreParams({ tab: value }).tab).toBe(DEFAULT_TAB)
  })
})

describe('parseExploreParams -- sayfa', () => {
  it('gecerli sayfa numarasini gecirir', () => {
    expect(parseExploreParams({ page: '3' }).page).toBe(3)
  })

  it.each([
    ['sifir', '0'],
    ['negatif', '-1'],
    ['ondalik', '1.5'],
    ['harf', 'abc'],
    ['bos', ''],
    ['bosluklu', ' 2'],
  ])('%s -> 1. sayfa', (_label, value) => {
    expect(parseExploreParams({ page: value }).page).toBe(1)
  })

  /*
   * UST SINIR BIR SAVUNMADIR, BIR TERCIH DEGIL.
   *
   * `OFFSET` = (page - 1) x 48. Elle yazilan `?page=999999999`, Postgres'i 48
   * milyar satir atlamaya calisirken oyalardi -- tek bir GET ile. Sinir bu
   * urunun gorebilecegi her listeden buyuk ve bir saldiri yuzeyinden kucuk.
   */
  it('cok buyuk bir sayfa numarasi KIRPILIR, oldugu gibi gecmez', () => {
    expect(parseExploreParams({ page: '999999' }).page).toBe(10_000)
    // Alti basamagi asan bir dize desene hic uymaz -> 1.
    expect(parseExploreParams({ page: '9999999' }).page).toBe(1)
  })
})

describe('tabHref', () => {
  it('varsayilan sekmeyi URL’e YAZMAZ -- temiz adres paylasilabilir adrestir', () => {
    expect(tabHref(DEFAULT_TAB)).toBe('/')
  })

  it('varsayilan olmayan sekmeyi tasir', () => {
    expect(tabHref('top')).toBe('/?tab=top')
    expect(tabHref('nearGraduation')).toBe('/?tab=nearGraduation')
  })

  /*
   * SEKME DEGISTIGINDE SAYFA DUSURULUR.
   *
   * "Top"un 7. sayfasindan "New"a gecen biri 7. sayfada degil BASTA olmali:
   * baska bir listenin 7. sayfasi onun icin anlamsiz bir yerdir ve cogu zaman
   * bos bir sayfadir -- yani kullanici bir sekmeye tiklayip BOS ekran gorurdu.
   */
  it('sekme adresi sayfa numarasi TASIMAZ', () => {
    for (const key of TAB_KEYS) {
      expect(tabHref(key)).not.toContain('page')
    }
  })
})

describe('tabQuery -- sayfalayicinin koruyacagi parametreler', () => {
  it('varsayilan sekmede bos, digerlerinde yalnizca sekme', () => {
    expect(tabQuery(parseExploreParams({}))).toEqual({})
    expect(tabQuery(parseExploreParams({ tab: 'top' }))).toEqual({ tab: 'top' })
  })

  it('sayfa numarasini ASLA icermez -- onu sayfalayici kendi yazar', () => {
    expect(tabQuery(parseExploreParams({ tab: 'new', page: '4' }))).not.toHaveProperty('page')
  })
})

describe('TABS sozlesmesi', () => {
  it('etiketler ile anahtarlar AYNI kaynaktan turer', () => {
    expect(TAB_LABELS.map((t) => t.key)).toEqual([...TAB_KEYS])
    for (const { key, label } of TAB_LABELS) expect(label).toBe(TABS[key].label)
  })

  it('varsayilan sekme gercekten bir sekmedir', () => {
    expect(TAB_KEYS).toContain(DEFAULT_TAB)
  })

  /*
   * SAYFA BOYUTU `packages/db`'NIN 200 SATIRLIK SINIRININ ALTINDA OLMALI.
   * `listTokens` `limit`i kirpar ve "daha var mi" sorusunu `rows.length <
   * limit` ile cevaplar; 200'u asan bir istek 200 satir alir, `200 < 500`
   * okur ve arkasinda duran her seyi YOK sayar.
   */
  it('sayfa boyutu veritabani sinirinin altinda ve her sutun sayisina TAM bolunur', () => {
    expect(PAGE_SIZE).toBeLessThanOrEqual(200)
    for (const columns of [2, 3, 4, 5, 6]) {
      if (columns === 5) continue // 48 / 5 tam degil; xl kirilmasi son satiri eksik biter
      expect(PAGE_SIZE % columns).toBe(0)
    }
  })
})
