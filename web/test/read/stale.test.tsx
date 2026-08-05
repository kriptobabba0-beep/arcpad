import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { describeLag, StaleNotice } from '@/components/read/StaleNotice'
import { stalenessOf } from '@/components/read/result'
import type { IndexerStatus, ReadResult } from '@/components/read/types'
import { LIVE_INDEXER, STALE_INDEXER } from '../fixtures/readModel'

/**
 * BU BILESENI HICBIR TEST CIZMIYORDU.
 *
 * `MAINNET-READINESS.md` §2.4 "hicbir sey kullaniciya indexer'in geride
 * oldugunu soylemiyor" diyor; bu YANLIS -- `<StaleNotice>` iki sayfada da
 * `0b4f9c2`'den beri cizili. Ama iddianin altindaki endise dogruydu ve kimse
 * yazmamisti: bu dosya inene kadar `web/test` altinda `<StaleNotice>`'i import
 * eden TEK BIR test yoktu. Yani kullanici ile "bayat fiyati canli sanmak"
 * arasindaki tek sey, hic kosulmamis bir bileşendi.
 *
 * Cizilebilirligi tarayicida olculur (`e2e/db/explore-and-search.spec.ts`:
 * `sync_state` gercekten geriye alinir). Burada olculen METINDIR -- ve metin
 * onemli, cunku gorunen ama "0s ago" yazan bir uyari, olmayandan kotudur.
 */
describe('<StaleNotice>', () => {
  it('neyin bayat oldugunu, ne kadar geride oldugunu ve NEYIN etkilenmedigini yazar', () => {
    render(<StaleNotice indexer={STALE_INDEXER} what="Prices and volumes" />)
    const notice = screen.getByTestId('stale-notice')
    expect(notice).toHaveTextContent('Prices and volumes may be out of date')
    // Kullanicinin imzaladigi sayinin bu olmadigini soyleyen cumle. Bu cumle
    // olmadan uyari yalnizca korkutur; onunla birlikte ne yapilacagini soyler.
    expect(notice).toHaveTextContent('Trading reads reserves straight from the chain')
    // `role="status"`: DOM'a sonradan girse bile duyurulur.
    expect(notice).toHaveAttribute('role', 'status')
  })
})

describe('describeLag -- sinirlar', () => {
  /**
   * `null` "HIC KOSMADI"dir ve "0 saniye once" DEGILDIR.
   *
   * Sifira yuvarlamak, bos bir indexer'i mukemmel calisan bir indexer gibi
   * gosterirdi -- yani uyarinin var olma sebebini tam tersine cevirirdi.
   */
  it('hic kosmamis indexer "never" der, "0s ago" demez', () => {
    expect(describeLag(null)).toBe('never')
    expect(describeLag(0)).toBe('0s ago')
  })

  it('90 saniyede dakikaya, 90 dakikada saate, 48 saatte gune gecer', () => {
    expect(describeLag(89)).toBe('89s ago')
    expect(describeLag(90)).toBe('2m ago')
    expect(describeLag(89 * 60)).toBe('89m ago')
    expect(describeLag(90 * 60)).toBe('2h ago')
    expect(describeLag(47 * 3600)).toBe('47h ago')
    expect(describeLag(48 * 3600)).toBe('2d ago')
  })

  /** Negatif bir gecikme -- saat kaymasi -- "-3s ago" yazmaz. */
  it('negatif gecikme sifira kirpilir', () => {
    expect(describeLag(-5)).toBe('0s ago')
  })
})

describe('stalenessOf -- iki sayfanin da cagirdigi tek ifade', () => {
  it('yalnizca BAYAT dalda durum doner', () => {
    const fresh: ReadResult<number> = { ok: true, stale: false, data: 1, indexer: LIVE_INDEXER }
    const stale: ReadResult<number> = {
      ok: true,
      stale: true,
      staleData: 1,
      indexer: STALE_INDEXER,
    }
    const missing: ReadResult<number> = { ok: false, reason: 'unavailable', indexer: null }

    expect(stalenessOf(fresh)).toBeNull()
    // DUSMUS bir okuma bayat DEGILDIR: ekranda zaten "veri yok" kutusu var ve
    // ustune bir de "bayat" demek, iki farkli sorunu tek cumleye katlardi.
    expect(stalenessOf(missing)).toBeNull()
    const lagging: IndexerStatus | null = stalenessOf(stale)
    expect(lagging).toBe(STALE_INDEXER)
  })
})
