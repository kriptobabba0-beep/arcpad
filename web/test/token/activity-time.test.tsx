import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityTabs } from '@/components/token/ActivityTabs'
import { BUY_ONE_USDC, CLIMBING } from '../fixtures/readModel'

/**
 * ============================================================================
 *  TARIHSIZ BIR SAAT YALAN SOYLER
 * ============================================================================
 *
 * OLCULDU, uretim kutusunda, ve BENI de yaniltti: islem tablosunda "2:56 AM"
 * yazan bir satir 35 saat oncesine aitti. Ustteki serit "24H volume $0.00"
 * diyordu ve ikisi yan yana bir CELISKI gibi okunuyordu -- oysa iki sayi da
 * dogruydu. Eksik olan tek sey gunun kendisiydi.
 *
 * Bu, bir bicimlendirme inceligi degil: bir launchpad'de "bu token DUN mu
 * islem gordu bugun mu" sorusu, alip almama kararinin ta kendisi.
 */

const BASE = {
  tab: 'activity' as const,
  holders: [],
  holderCount: 1,
  tradeCount: 1,
  symbol: 'LOCKED',
  curve: CLIMBING.curve,
  creator: CLIMBING.launchCreator,
  page: 1,
  pageSize: 25,
  basePath: '/token/0xabc',
  query: {},
  totalSupplyTok: 10n ** 27n,
  priceWeiPerToken: 4_820_000_000n,
}

/** Islem `2026-07-31T12:00:00Z`de. Fixture bunu sabitliyor. */
const TRADE_AT = BUY_ONE_USDC.blockTime

describe('islem tablosunda zaman', () => {
  it('AYNI GUNDEKI islem yalnizca saat yazar -- her satira tarih koymak gurultu', () => {
    /*
     * Canli bir sayfada islemlerin cogu bugundendir; hepsine ayni tarihi
     * yazmak, hicbir sey ayirt etmeyen bir metni her satirda tekrarlamaktir.
     */
    const sameDay = new Date('2026-07-31T23:59:00.000Z')
    render(<ActivityTabs {...BASE} trades={[BUY_ONE_USDC]} now={sameDay} />)
    expect(screen.getByText('12:00 PM')).toBeInTheDocument()
    expect(screen.queryByText(/Jul 31/)).toBeNull()
  })

  it('BASKA GUNDEKI islem TARIHI de yazar -- kusurun kendisi buydu', () => {
    // Bir dakika sonrasi yeni bir UTC gunu: sinir GUNDE, gecen surede degil.
    const nextDay = new Date('2026-08-01T00:01:00.000Z')
    render(<ActivityTabs {...BASE} trades={[BUY_ONE_USDC]} now={nextDay} />)
    expect(screen.getByText('Jul 31 12:00 PM')).toBeInTheDocument()
  })

  it('GUNLER SONRASI da ayni bicimi tasir', () => {
    const muchLater = new Date('2026-08-13T14:35:00.000Z')
    render(<ActivityTabs {...BASE} trades={[BUY_ONE_USDC]} now={muchLater} />)
    expect(screen.getByText('Jul 31 12:00 PM')).toBeInTheDocument()
  })

  it('SAAT DILIMI VE LOCALE ACIK -- sunucu ile tarayici ayni metni uretmeli', () => {
    /*
     * Kutunun yereline birakilan bir tarih, sunucuda bir metin istemcide baska
     * bir metin uretir ve React bunu bir hidrasyon hatasi olarak bildirir.
     * Fixture UTC 12:00; hangi kutuda kosarsa kossun `12:00 PM` okunmali.
     */
    expect(TRADE_AT.toISOString()).toBe('2026-07-31T12:00:00.000Z')
    render(<ActivityTabs {...BASE} trades={[BUY_ONE_USDC]} now={TRADE_AT} />)
    expect(screen.getByText('12:00 PM')).toBeInTheDocument()
  })
})

/**
 * ============================================================================
 *  BIR HOLDER, "1 HOLDERS" DEGIL
 * ============================================================================
 *
 * Canli sayfada goruldu. Kucuk bir sey -- ama yeni bir tokenin sayfasinda
 * HER ZAMAN gorunen sey odur: sayfa daha ilk ziyaretinde yanlis yazilmis bir
 * cumleyle karsilar.
 */
describe('holder sekmesinin etiketi', () => {
  it('TEKIL: "1 holder"', () => {
    render(<ActivityTabs {...BASE} holderCount={1} trades={[BUY_ONE_USDC]} now={TRADE_AT} />)
    const tab = screen.getByRole('link', { name: /holder/ })
    expect(tab.textContent).toBe('1 holder')
  })

  it('COGUL: "2 holders", ve binlik ayirici duruyor', () => {
    render(<ActivityTabs {...BASE} holderCount={2} trades={[BUY_ONE_USDC]} now={TRADE_AT} />)
    expect(screen.getByRole('link', { name: /holders/ }).textContent).toBe('2 holders')

    render(<ActivityTabs {...BASE} holderCount={13_000} trades={[BUY_ONE_USDC]} now={TRADE_AT} />)
    expect(screen.getAllByRole('link', { name: /holders/ }).at(-1)?.textContent).toBe(
      '13,000 holders',
    )
  })

  it('SIFIR da cogul -- "0 holder" Ingilizce degil', () => {
    render(<ActivityTabs {...BASE} holderCount={0} trades={[BUY_ONE_USDC]} now={TRADE_AT} />)
    expect(screen.getByRole('link', { name: /holders/ }).textContent).toBe('0 holders')
  })
})
