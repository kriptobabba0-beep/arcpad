import { progressPpm } from '@arcpad/shared/browser'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NotALaunch } from '@/components/token/CanonicalBadge'
import { CurveChart, realisedSeries, referenceCurve } from '@/components/token/CurveChart'
import { LifecycleNotice } from '@/components/token/LifecycleNotice'
import { ProgressToGraduation } from '@/components/token/ProgressToGraduation'
import { StatRow, statsFromOverview } from '@/components/token/StatRow'
import {
  BLOCKS_PER_SECOND,
  blockOfSeq,
  rangeToBlocks,
  resolveLifecycle,
} from '@/components/token/lifecycle'
import { BUY_ONE_USDC, CLIMBING, SMOKE } from '../fixtures/readModel'

const PROFILE = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292n * 10n ** 15n,
  saleSupply: 793_100_000n * 10n ** 18n,
}

describe('ilerleme -- pay TOKEN satisi uzerinden', () => {
  /**
   * IKI KAYNAK AYNI SAYIYI VERMEK ZORUNDA.
   *
   * Fixture'in `progressPpm`'i ELLE turetildi (`1e6 - ceil(kalan*1e6/S)`);
   * `progressPpm` Task 4'un zincirle diferansiyel test edilmis portudur. Ayni
   * kaldiklarini olcmek, "indexer bir sey, arayuz baska bir sey soyluyor"
   * sinifini kapatir.
   */
  it('elle turetilen 253_087 ile Task 4’un portu ayni sonucu verir', () => {
    expect(CLIMBING.progressPpm).toBe(253_087)
    expect(progressPpm(CLIMBING.realTokenReservesTok, PROFILE.saleSupply)).toBe(253_087)
  })

  /**
   * QUOTE TABANLI BIR YUZDE %100'U GECER, ve bu olculdu.
   *
   * `quoteBuyCost` her alimda `floor(...) + 1` doner, yani biriken quote
   * tamamlanmada `R`'yi ASAR. Canli smoke curve `...714` topladi, `R` ise
   * `...706`. Ilerlemeyi `real_quote / graduation_raise` yapan mutant tam
   * olarak burada olur.
   */
  it('canli curve toplanan quote ile %100’u ASAR, token tabanli olan tam 100’dur', () => {
    const raised = SMOKE.realQuoteReservesWei
    const target = SMOKE.graduationRaiseWei
    expect(raised - target).toBe(8n)

    /*
     * OLCULDU VE KAYDA GECIYOR: asim ppm cozunurlugunun ALTINDA.
     * `(raised * 1e6) / target` tam olarak 1_000_000 verir -- 1,2e19 uzerinde
     * 8 wei, milyonda bir paydan kucuk. Yani "yuzde 100'u gecer" iddiasi ppm
     * olceginde GORUNMEZ ve bunu ppm ile olcmeye calisan bir test, mutanti
     * yakalamadigi hâlde yesil gorunur.
     *
     * Asim bu yuzden tam hassasiyette olculuyor. Onemi de bu: quote tabanli
     * bir yuzde SINIRSIZ degil ama UST SINIRSIZDIR -- bu curve'de 8 wei,
     * baska bir parametre setinde daha fazla, ve hicbir yerde tam 100 degil.
     */
    expect((raised * 1_000_000n) / target).toBe(1_000_000n)
    expect((raised * 10n ** 30n) / target).toBeGreaterThan(10n ** 30n)

    // Token tabanli olan ise tam sifir rezervde TAM 1_000_000 verir.
    expect(progressPpm(0n, PROFILE.saleSupply)).toBe(1_000_000)
  })

  it('payi da paydasi da yazar', () => {
    render(
      <ProgressToGraduation
        ppm={CLIMBING.progressPpm}
        raisedWei={CLIMBING.realQuoteReservesWei}
        targetWei={CLIMBING.graduationRaiseWei}
      />,
    )
    expect(screen.getByText('25.3%')).toBeInTheDocument()
    expect(screen.getByText('0.987654')).toBeInTheDocument()
    // Hedef YUKARI yuvarlanir: ulasilmasi gereken esik.
    expect(screen.getByText('12.161434')).toBeInTheDocument()
  })
})

describe('yasam dongusu -- uc durum', () => {
  it('complete === false -> trading', () => {
    expect(resolveLifecycle({ complete: false })).toEqual({ kind: 'trading' })
  })

  it('complete === true -> complete', () => {
    expect(resolveLifecycle({ complete: true })).toEqual({ kind: 'complete' })
  })

  it('graduated dali BUGUN ULASILAMAZ ama tip ve ekran hazir', () => {
    // Faz 2 bir yeniden yazim olmasin diye bugunden test ediliyor.
    const lifecycle = resolveLifecycle({ complete: true, graduated: true })
    expect(lifecycle.kind).toBe('graduated')
    render(<LifecycleNotice lifecycle={lifecycle} />)
    expect(screen.getByText('Graduated')).toBeInTheDocument()
  })

  it('trading durumunda uyari HIC cizilmez', () => {
    const { container } = render(<LifecycleNotice lifecycle={{ kind: 'trading' }} />)
    // Gizlenmis degil, YOK: gizlenmis bir panel DOM'da durur ve klavye ona
    // yine ulasir.
    expect(container).toBeEmptyDOMElement()
  })

  it('complete durumunda kullaniciya kesin basarisiz olacak islem teklif edilmez', () => {
    render(<LifecycleNotice lifecycle={{ kind: 'complete' }} />)
    expect(
      screen.getByText(/trading on the curve is closed; pool creation lands with phase 2/i),
    ).toBeInTheDocument()
  })
})

describe('sahte adres dali', () => {
  it('isim ve sembol HIC OKUNMAZ', () => {
    render(<NotALaunch address={SMOKE.token} />)
    // Bilesenin ismi alacak bir prop'u YOKTUR; bu bir imkansizlik iddiasi.
    expect(screen.queryByText('Smoke')).not.toBeInTheDocument()
    expect(screen.queryByText(/SMOKE/)).not.toBeInTheDocument()
    expect(screen.getByText(/is not a arcpad launch|is not a .* launch/i)).toBeInTheDocument()
  })

  it('adres KISALTILMIS gosterilir', () => {
    render(<NotALaunch address={SMOKE.token} />)
    expect(screen.getByTitle(SMOKE.token)).toHaveTextContent('0x1bd9…8fab')
  })
})

describe('grafik', () => {
  /**
   * X EKSENI BLOKTUR, DUVAR SAATI DEGIL.
   *
   * Olculdu (Faz 3, 2026-07-31): 553 ardisik blok ciftinin 271'i (%49,0) ayni
   * timestamp'i tasiyor. Zamana oturtulan bir eksende bloklarin yarisi UST
   * USTE duser ve grafik yalan soyler.
   */
  it('eventSeq >> 20 blok numarasini verir', () => {
    expect(blockOfSeq(4194304n)).toBe(4) // 4 << 20
    expect(blockOfSeq(4194305n)).toBe(4) // ayni blok, log 1
    expect(blockOfSeq(5242880n)).toBe(5)
  })

  it('ayni bloktaki iki islemden SON olani alinir -- ortalama ALINMAZ', () => {
    // Ortalama, hicbir zaman gerceklesmemis bir fiyati cizer ve kullanici
    // onu bir islem sanir.
    const series = realisedSeries([
      BUY_ONE_USDC,
      {
        ...BUY_ONE_USDC,
        eventSeq: 4_194_305n,
        virtualQuoteReservesWei: 9_999_999_999_999_999_999n,
      },
    ])
    expect(series).toHaveLength(1)
    expect(series[0]?.seq).toBe(4_194_305n)
  })

  it('referans egri acilis ve graduation fiyatlarini verir', () => {
    const curve = referenceCurve(PROFILE, 8)
    // K3: acilis fiyati 4_000_000_000 wei / tam token (testnet).
    expect(curve[0]?.priceWei).toBe(4_000_000_000n)
    // Son nokta graduation fiyati; FDV 58_783_256_052_377_201_521 / 1e9.
    expect(curve[curve.length - 1]?.priceWei).toBe(58_783_256_052n)
  })

  /**
   * DEVIASYON 3: ISLEMI OLMAYAN TOKEN EGRININ KENDISINI GOSTERIR.
   *
   * Hic islem gormemis bir launch YAYGIN DURUMDUR -- urunun ilk gununde HER
   * token boyledir. Iki noktali, neredeyse dikey bir cizgi hicbir sey
   * anlatmaz.
   */
  it('hic islem yokken referans egri YINE cizilir', () => {
    render(
      <CurveChart
        profile={PROFILE}
        soldTok={0n}
        currentPriceWei={4_000_000_000n}
        progressPercent="0.0"
      />,
    )
    const reference = screen.getByTestId('curve-reference')
    expect(reference).toBeInTheDocument()
    expect(reference.getAttribute('d') ?? '').toMatch(/^M[\d.]+ [\d.]+ L/)
    // Gerceklesen seri yok, ama grafik bos DEGIL.
    expect(screen.queryByTestId('curve-realised')).not.toBeInTheDocument()
    expect(screen.getByText(/this is the bonding curve itself/i)).toBeInTheDocument()
  })

  it('bir cizgi grafigi ekran okuyucuya konusur: aria-label + gizli tablo', () => {
    render(
      <CurveChart
        profile={PROFILE}
        soldTok={0n}
        currentPriceWei={4_000_000_000n}
        trades={[BUY_ONE_USDC]}
        progressPercent="25.3"
      />,
    )
    const chart = screen.getByRole('img')
    expect(chart.getAttribute('aria-label') ?? '').toMatch(/bonding curve price from .* to .*/i)
    expect(chart.getAttribute('aria-label') ?? '').toContain('25.3% to graduation')
    // Tablo veriyi VERIR; aria-label yalnizca ozetler.
    expect(screen.getByRole('table', { name: /realised trade prices/i })).toBeInTheDocument()
  })
})

describe('aralik pill’leri tek bir sabitten turer', () => {
  it('BLOCKS_PER_SECOND blok suresinden gelir', () => {
    // Arc ~350 ms. BLOK SURESI DEGISIRSE BURASI DEGISIR.
    expect(BLOCKS_PER_SECOND).toBeCloseTo(1000 / 350, 10)
  })

  it('dort pencere elle yazilmaz, turetilir', () => {
    expect(rangeToBlocks('5M')).toBe(857)
    expect(rangeToBlocks('1H')).toBe(10_286)
    expect(rangeToBlocks('6H')).toBe(61_714)
    expect(rangeToBlocks('1D')).toBe(246_857)
    expect(rangeToBlocks('ALL')).toBeNull()
  })
})

describe('istatistik seridi', () => {
  it('"Liquidity" YOK, "Raised" var -- havuz yok (Faz 2)', () => {
    render(<StatRow stats={statsFromOverview(CLIMBING)} />)
    expect(screen.getByText('Raised')).toBeInTheDocument()
    expect(screen.queryByText(/liquidity/i)).not.toBeInTheDocument()
  })

  it('"Burned" satiri YOK (S8) -- olculecek bir sey olmadigi icin', () => {
    render(<StatRow stats={statsFromOverview(CLIMBING)} />)
    // Yakma yolu yoktur; her token icin sabit sifir gosteren bir satir,
    // urunun bir seyi olctugu izlenimi verir.
    expect(screen.queryByText(/burned/i)).not.toBeInTheDocument()
  })

  /**
   * INDEXER DUSTUGUNDE "—", SIFIR DEGIL.
   *
   * Sifir bir OLCUMDUR, "—" bir BILINMEZLIK. Ikisini karistirmak kullaniciya
   * olcmedigimiz bir seyi olcmus gibi gosterir -- ve "24h volume 0" ile "24h
   * volume bilinmiyor" farkli kararlar dogurur.
   */
  it('indexer alanlari yoksa "—" gosterilir, sifir DEGIL', () => {
    render(
      <StatRow
        stats={{
          ...statsFromOverview(CLIMBING),
          volume24hWei: null,
          athMarketCapWei: null,
          holderCount: null,
        }}
      />,
    )
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })
})
