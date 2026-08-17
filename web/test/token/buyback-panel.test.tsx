import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BuybackPanel, VestingWindow } from '@/components/token/BuybackPanel'
import type { TokenBuyback } from '@/lib/read'

/**
 * ============================================================================
 *  BUYBACK PANELI -- BIR TAAHHUDUN EKRANDAKI HALI
 * ============================================================================
 *
 * Panelin isi bir SOZU denetlenebilir kilmaktir: creator ucretinin yarisini
 * geri alima ayirdi mi, ne kadar alindi, ne kadari kilitli. Dolayisiyla
 * buradaki testler "bilesen cizildi mi" degil, "hangi cumleyi kuruyor" diye
 * sorar.
 *
 * EN ONEMLI IDDIA BIR YOKLUK IDDIASIDIR: panel "su anda cekilebilir" diye bir
 * TOKEN MIKTARI gostermez. Kasa vesting'i checkpoint'li hesaplar ve o sayi
 * olaylardan turetilemez; turetmeye calisan bir surum TEK KILITLI tokenlerde
 * dogru cevabi verir, yani hata ancak ikinci kilitten sonra ve SESSIZCE
 * ortaya cikardi.
 */

const BASE: TokenBuyback = {
  enabled: true,
  enabledSeq: 1n,
  enabledByAddr: '0x000000000000000000000000000000000000c7ea',
  pendingQuoteWei: 87_791_495_198_903n,
  accruedTotalWei: 59_259_000_000_000_000n,
  spentTotalWei: 59_259_000_000_000_000n,
  returnedTotalWei: 0n,
  boughtTotalTok: 14_435_072_652_524_000_000_000_000n,
  lockedTotalTok: 14_435_072_652_524_000_000_000_000n,
  releasedCreatorTok: 0n,
  releasedProtocolTok: 0n,
  vestingStartAt: null,
  vestingEndAt: null,
  lastSeq: 9n,
  history: [],
}

function panel(over: Partial<TokenBuyback> = {}) {
  const rendered = render(<BuybackPanel buyback={{ ...BASE, ...over }} symbol="BBP" />)
  return within(rendered.container)
}

describe('BuybackPanel', () => {
  it('acikken ozelligi ACIK gosterir ve dort rakami da cizer', () => {
    const q = panel()
    expect(q.getByTestId('buyback-status')).toHaveTextContent('On')
    expect(q.getByTestId('buyback-bought')).toBeInTheDocument()
    expect(q.getByTestId('buyback-locked')).toBeInTheDocument()
    expect(q.getByTestId('buyback-spent')).toBeInTheDocument()
    expect(q.getByTestId('buyback-pending')).toBeInTheDocument()
  })

  /**
   * KAPALI HAL GECMISI SILMEZ.
   *
   * Bir creator buyback'i kapattiginda ALINMIS token hala kilitlidir. Paneli
   * tamamen gizlemek ya da rakamlari sifirlamak, kullaniciya var olan bir
   * kilidi YOK gostermek olurdu -- ve o kilit zincirde duruyor.
   */
  it('kapaliyken durumu soyler AMA rakamlari SILMEZ', () => {
    const q = panel({ enabled: false })
    expect(q.getByTestId('buyback-status')).toHaveTextContent('Off')
    expect(q.getByTestId('buyback-locked')).toBeInTheDocument()
    expect(q.getByText(/turned buyback off/i)).toBeInTheDocument()
  })

  /**
   * GERI KATLAMA OLDUYSA GORUNUR, OLMADIYSA SATIR YOK.
   *
   * `accrued` ile `spent` arasindaki fark ancak bu satirla aciklanir; onsuz
   * fark bir KAYIP gibi okunur. Sifirken cizmek ise cevabi olmayan bir soru
   * eklemek olurdu.
   */
  it('geri katlama SIFIRKEN satir cizilmez', () => {
    expect(panel().queryByTestId('buyback-returned')).toBeNull()
  })

  it('geri katlama VARKEN tutar ve sebep gorunur', () => {
    const q = panel({ returnedTotalWei: 18_242_150_053_590_568n })
    expect(q.getByTestId('buyback-returned')).toHaveTextContent(/back to the creator/i)
  })

  it('dagitim olmadan release satiri cizilmez', () => {
    expect(panel().queryByTestId('buyback-released')).toBeNull()
  })

  it('dagitim varken IKI pay da yazilir', () => {
    const q = panel({
      releasedCreatorTok: 2_177_022_286_681_341_270_817_135n,
      releasedProtocolTok: 933_009_551_434_860_544_635_914n,
    })
    const line = q.getByTestId('buyback-released')
    expect(line).toHaveTextContent(/creator/i)
    expect(line).toHaveTextContent(/protocol/i)
  })

  it('kilit yokken vesting penceresi CIZILMEZ', () => {
    expect(panel().queryByTestId('buyback-vesting')).toBeNull()
  })

  /**
   * ============ PANEL BIR TOKEN MIKTARI OLARAK "VESTED" SOYLEMEZ ============
   *
   * Bu testin kirilmasinin TEK yolu, birinin panele turetilmis bir hak edis
   * rakami eklemesidir -- yani tam olarak engellemek istedigimiz sey. Metin
   * taramasi bilerek genis: "vested", "claimable" ve "releasable" kelimeleri
   * ekranda HIC gecmemeli.
   */
  it('hak edilmis TOKEN MIKTARI iddia etmez', () => {
    const q = panel({
      vestingStartAt: new Date('2026-08-16T00:00:00Z'),
      vestingEndAt: new Date('2031-08-15T00:00:00Z'),
    })
    const text = q.getByTestId('buyback-panel').textContent ?? ''
    expect(text).not.toMatch(/vested/i)
    expect(text).not.toMatch(/claimable/i)
    expect(text).not.toMatch(/releasable/i)
    // ...ama pencere GORUNUR, ve etiketi bir ZAMAN olgusu oldugunu soyler.
    expect(q.getByTestId('buyback-vesting')).toHaveTextContent(/elapsed/i)
  })
})

describe('VestingWindow', () => {
  const START = new Date('2026-01-01T00:00:00Z')
  const END = new Date('2031-01-01T00:00:00Z') // 5 yil, tam.

  /** `now` DISARIDAN verilir: `Date.now()`a bagli bir test zamanla kayar. */
  const at = (now: Date) =>
    within(render(<VestingWindow start={START} end={END} now={now} />).container)

  it('pencerenin basinda %0,0', () => {
    expect(at(START).getByTestId('buyback-vesting-pct')).toHaveTextContent('0.0% elapsed')
  })

  it('tam ortada ~%50', () => {
    const mid = new Date((START.getTime() + END.getTime()) / 2)
    expect(at(mid).getByTestId('buyback-vesting-pct')).toHaveTextContent('50.0% elapsed')
  })

  /**
   * PENCERE BITTIKTEN SONRA %100'DE KALIR, %100'U ASMAZ.
   *
   * Kirpilmamis bir yuzde, bes yil sonra "%140 elapsed" yazar ve cubugu
   * kutunun disina tasirdi.
   */
  it('bitisten SONRA %100 de kalir', () => {
    const after = new Date('2035-01-01T00:00:00Z')
    expect(at(after).getByTestId('buyback-vesting-pct')).toHaveTextContent('100.0% elapsed')
  })

  it('baslangictan ONCE %0 da kalir (negatife dusmez)', () => {
    const before = new Date('2020-01-01T00:00:00Z')
    expect(at(before).getByTestId('buyback-vesting-pct')).toHaveTextContent('0.0% elapsed')
  })

  /** Tarihler ISO SIRASINDA: bes yillik bir pencerede gun/ay belirsizligi
   *  tam olarak yanlis okunacak yerdir. */
  it('tarihler YYYY-MM-DD olarak yazilir', () => {
    const q = at(START)
    expect(q.getByTestId('buyback-vesting-dates')).toHaveTextContent('2026-01-01')
    expect(q.getByTestId('buyback-vesting-dates')).toHaveTextContent('2031-01-01')
  })
})

describe('BuybackPanel -- erisilebilirlik', () => {
  it('cubuk bir ilerleme DEGIL, etiketli bir gorsel', () => {
    render(
      <BuybackPanel
        buyback={{
          ...BASE,
          vestingStartAt: new Date('2026-01-01T00:00:00Z'),
          vestingEndAt: new Date('2031-01-01T00:00:00Z'),
        }}
        symbol="BBP"
      />,
    )
    // `<progress>` DEGIL: ekran okuyucuya "su kadari tamamlandi" demek, token
    // miktari hakkinda bir sey ima ederdi. `role="img"` + acik etiket, neyin
    // ilerledigini (ZAMAN) soyler.
    expect(screen.getByRole('img', { name: /vesting window has elapsed/i })).toBeInTheDocument()
  })
})
