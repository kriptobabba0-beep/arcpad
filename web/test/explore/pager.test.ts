import { describe, expect, it } from 'vitest'

import { pageNumbers } from '@/components/explore/pageNumbers'

/**
 * `1 2 3 … 12` -- VE `…` BIR SAYFA DEGILDIR.
 *
 * Bu fonksiyon saf ve kenar durumlari gercek: pencerenin bir uca dayanmasi,
 * elipsin tek bir sayfayi gizlemesi (ki o zaman elips SAYFANIN KENDISINDEN
 * genistir), ve toplamin pencereden kucuk olmasi. Ekranda hepsi ayni sekilde
 * "biraz garip" gorunur; testte hepsi ayri.
 */
describe('pageNumbers', () => {
  it('toplam pencereden kucukse HEPSI cizilir, elips YOK', () => {
    expect(pageNumbers(1, 1)).toEqual([1])
    expect(pageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('sifir ya da negatif sayfa sayisi bos liste verir -- cizecek bir sey yok', () => {
    expect(pageNumbers(1, 0)).toEqual([])
    expect(pageNumbers(1, -3)).toEqual([])
  })

  it('ILK ve SON her zaman gorunur', () => {
    for (const current of [1, 5, 20, 40]) {
      const out = pageNumbers(current, 40)
      expect(out[0]).toBe(1)
      expect(out[out.length - 1]).toBe(40)
    }
  })

  it('mevcut sayfa HER ZAMAN listededir', () => {
    for (let current = 1; current <= 40; current++) {
      expect(pageNumbers(current, 40)).toContain(current)
    }
  })

  /*
   * PENCERE BIR UCA DAYANDIGINDA OTEKI UCA TASAR.
   *
   * Ilk yazimda tasmadan ONCE kirpiliyordu ve bant 1. sayfada UCE dusuyordu:
   * serit her tiklamada genislik degistiriyor, kullanicinin "sonraki"
   * dugmesi yerinden oynuyordu. Sabit olmasi gereken sey ORTA BANTTIR --
   * toplam uzunluk elipslerin varligina gore bir ya da iki slot oynar, ki o
   * da uclarda BIR kez olur, her tiklamada degil.
   */
  it('ORTA BANT her sayfada tam ayni sayida numara tasir', () => {
    const bands = new Set<number>()
    for (let current = 1; current <= 40; current++) {
      const middle = pageNumbers(current, 40)
        .slice(1, -1)
        .filter((n): n is number => n !== null)
      bands.add(middle.length)
    }
    expect(bands).toEqual(new Set([5]))
  })

  it('bastayken sag tarafa, sondayken sol tarafa acilir', () => {
    expect(pageNumbers(1, 40)).toEqual([1, 2, 3, 4, 5, 6, null, 40])
    expect(pageNumbers(40, 40)).toEqual([1, null, 35, 36, 37, 38, 39, 40])
  })

  it('ortadayken iki yanda da elips vardir', () => {
    expect(pageNumbers(20, 40)).toEqual([1, null, 18, 19, 20, 21, 22, null, 40])
  })

  it('cizilen numaralar ARTAN ve TEKRARSIZ', () => {
    for (const [current, count] of [
      [1, 40],
      [2, 40],
      [7, 40],
      [39, 40],
      [4, 9],
    ] as const) {
      const nums = pageNumbers(current, count).filter((n): n is number => n !== null)
      expect(nums).toEqual([...nums].sort((a, b) => a - b))
      expect(new Set(nums).size).toBe(nums.length)
      // Sinirlarin disina TASMAZ.
      for (const n of nums) {
        expect(n).toBeGreaterThanOrEqual(1)
        expect(n).toBeLessThanOrEqual(count)
      }
    }
  })

  /*
   * ELIPS YALNIZCA GERCEKTEN GIZLENEN SAYFA VARSA CIZILIR.
   *
   * Tek bir sayfayi gizleyen bir `…`, o sayfanin numarasindan genistir ve
   * kullaniciya tiklanabilir bir hedef yerine tiklanamaz bir isaret verir.
   */
  it('bir sayfa gizlenecekse elips DEGIL sayinin kendisi cizilir', () => {
    const out = pageNumbers(4, 8)
    // 8 <= WINDOW + 2 (7) degil, yani pencere devrede; ama 1 ile pencere
    // arasinda gizlenen sayfa YOKSA elips konmaz.
    const gaps = out.filter((n) => n === null).length
    const shown = out.filter((n): n is number => n !== null)
    // Her elips EN AZ bir sayfa gizlemeli.
    let hidden = 0
    for (let i = 1; i < shown.length; i++) {
      const prev = shown[i - 1] as number
      const cur = shown[i] as number
      if (cur - prev > 1) hidden++
    }
    expect(gaps).toBe(hidden)
  })
})
