import { correctedNetQuoteIn, type CurveProfile } from '@arcpad/shared/browser'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  bpsPercent,
  formatTok,
  formatTokExact,
  launchFactsFrom,
  supplySharePercent,
  TOTAL_SUPPLY_TOK,
} from '@/components/create/facts'
import { EMPTY_FIELDS } from '@/components/create/fields'
import { TokenPreviewCard } from '@/components/create/TokenPreviewCard'

/**
 * CANLI TESTNET PROFILI, `contracts/deploy/addresses.5042002.json`ten.
 *
 * Sabit degil OLCUM: brief'in sekiz satiri bu ucluden turetildi ve bu dosya o
 * turetmeyi tekrar etmiyor, SONUCLARI pinliyor. `V` uretimde tam 1000 kat
 * farklidir ve bu, iki profilin ayrildigi TEK alandir.
 */
const TESTNET: CurveProfile = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292n * 10n ** 15n,
  saleSupply: 793_100_000n * 10n ** 18n,
}

const FACTS = launchFactsFrom(TESTNET, '0x0000000000000000000000000000000000000000')

describe('launchFactsFrom -- sekiz satirin sayilari', () => {
  it('toplam arz turetilmez: `LaunchToken.TOTAL_SUPPLY` = 1e27', () => {
    expect(FACTS.totalSupplyTok).toBe(10n ** 27n)
    expect(formatTok(FACTS.totalSupplyTok)).toBe('1,000,000,000')
  })

  it('curve uzerindeki arz `SALE_SUPPLY`dir: 793.100.000 (%79,31)', () => {
    expect(formatTok(FACTS.saleSupplyTok)).toBe('793,100,000')
    expect(supplySharePercent(FACTS.saleSupplyTok, TOTAL_SUPPLY_TOK)).toBe('79.31')
  })

  it('havuz tohumu `poolSeedSupply(S, T)`: 206.886.011,183597 (%20,69)', () => {
    expect(FACTS.poolSeedTok).toBe(206_886_011_183_597_390_493_942_218n)
    expect(formatTok(FACTS.poolSeedTok)).toBe('206,886,011.183597')
    expect(supplySharePercent(FACTS.poolSeedTok, TOTAL_SUPPLY_TOK)).toBe('20.69')
  })

  it('mezuniyet `graduationRaise(S, V, T)`: 12,161433 USDC', () => {
    expect(FACTS.graduationRaiseWei).toBe(12_161_433_369_060_378_706n)
  })

  it('acilis market cap `marketCap(V, T, N)`: tam 4 USDC', () => {
    expect(FACTS.openingMarketCapWei).toBe(4n * 10n ** 18n)
  })

  it('ARZIN TAMAMI TUTAR: S + D + artik = N, ve artik curve’de kalir', () => {
    expect(FACTS.saleSupplyTok + FACTS.poolSeedTok + FACTS.strandedTok).toBe(TOTAL_SUPPLY_TOK)
    expect(formatTokExact(FACTS.strandedTok)).toBe('13,988.816402609506057782')
  })

  /*
   * CURVE'UN TAMAMINI DOLDURAN BUTCE, `graduationRaiseWei` DEGIL.
   *
   * Aradaki fark ucrettir: `buyExactQuoteIn` `msg.value`yu once ucretlere
   * ayirir (95 + 30 bps), geri kalani curve'e verir. Ikisini karistirmak,
   * ekranda "bu kadar gonderirsen curve dolar" derken curve'un DOLMADIGI bir
   * sayi gostermek olurdu.
   */
  it('tam curve butcesi raise`in USTUNDEDIR', () => {
    expect(FACTS.fullCurveBudgetWei).toBeGreaterThan(FACTS.graduationRaiseWei)
    expect(FACTS.fullCurveBudgetWei).toBe(12_315_375_563_605_446_791n)
  })

  /*
   * BUTCE GERCEKTEN DOLDURUR -- VE BIRAZ YUKARIDAN ALIR.
   *
   * Olculdu: butcenin net'i 12,163333 USDC, gereken 12,161433. Yani ~0,0019
   * USDC fazla. Sebep `correctedNetQuoteIn`in DUZELTMESI: ucret, kapali
   * formulun varsaydigi tam 125 bps'ten biraz az cikiyor, dolayisiyla net
   * beklenenden buyuk oluyor.
   *
   * BU YON DOGRU YON. Bir hair EKSIK bir sayi ekranda "bunu gonder, curve
   * dolar" der ve DOLDURMAZ -- kullanici curve'u kapattigini sanip
   * kapatmamis olur. Bir hair FAZLA olan sayi ise zaten iade edilir. Test bu
   * yuzden "esit" degil "kapsar ve makul yakinlikta" iddia eder.
   */
  it('butce curve`i KAPSAR, ve yalnizca binde birkac fazladan', () => {
    const { net } = correctedNetQuoteIn(FACTS.fullCurveBudgetWei, 95n, 30n)
    expect(net).toBeGreaterThanOrEqual(FACTS.graduationRaiseWei)
    // Fazlalik raise'in binde birinden kucuk olmali; aksi halde ekrandaki
    // sayi gereksiz yere buyuktur ve kullaniciyi fazla gondermeye iter.
    const excess = net - FACTS.graduationRaiseWei
    expect(excess * 1000n).toBeLessThan(FACTS.graduationRaiseWei)
  })

  it('ucretler `BondingCurve`in `constant`lari: 0,95% + 0,30%', () => {
    expect(bpsPercent(FACTS.protocolFeeBps)).toBe('0.95')
    expect(bpsPercent(FACTS.creatorFeeBps)).toBe('0.30')
  })
})

describe('<TokenPreviewCard>', () => {
  const row = (label: string) => {
    const term = screen.getByText(label)
    const wrapper = term.parentElement
    if (!wrapper) throw new Error(`no row for ${label}`)
    return within(wrapper)
  }

  it('sekiz satirin sekizi de cizilir', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    for (const label of [
      'Launch fee',
      'Trading fee',
      'Total supply',
      'On the curve',
      'Reserved for the pool',
      'Graduation at',
      'Opening market cap',
      'Liquidity',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('launch ucreti "None" -- `launch` `payable` degil', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    expect(row('Launch fee').getByText('None')).toBeInTheDocument()
    // "0.000000 USDC ucret" ile "ucret yok" ayni sey degil.
    expect(row('Launch fee').queryByText(/0\.000000/)).toBeNull()
  })

  /*
   * ============================================================
   *  LIKIDITE SATIRI: SAYFANIN EN AGIR CUMLESI, VE ARTIK TURETILMIS.
   * ============================================================
   *
   * Sabit metindi -- "the pool and its permanent lock ship in a later phase"
   * -- ve yazildigi gun dogruydu. Havuz katmani o zamandan beri dagitildi;
   * canli olmayan sey mezuniyetin KENDISI, cunku `graduationTarget` sifir.
   * Yani cumle dogru sonucu yanlis gerekce ile soyluyordu, ve yonetisim
   * hedefi silahlandirdigi an yalana donusecekti -- hicbir sey gormeden.
   *
   * Uc dal da burada, cunku YANLIS OLANI SESSIZCE dogru gorunur:
   * silahlanmamis dal bugunku uretim fabrikasidir, silahli dal yarinki, ve
   * `null` dali "fabrika cevap veremedi"dir -- orada bir likidite iddiasi
   * BASILMAMALIDIR.
   */
  it('hedef SIFIRKEN: garanti VAAT EDILMEZ, ve sebep dogru soylenir', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    const liquidity = row('Liquidity')
    expect(liquidity.getByText(/not armed on this deployment/i)).toBeInTheDocument()
    expect(liquidity.getByText(/no curve can open a pool yet/i)).toBeInTheDocument()
    // Ve eski cumle GERI GELMEZ: havuz katmani dagitildi, "later phase"
    // artik yanlis bir gerekce.
    expect(liquidity.queryByText(/later phase/i)).toBeNull()
    expect(liquidity.queryByText(/not live on testnet/i)).toBeNull()
  })

  it('hedef SILAHLIYKEN: kilit soylenir, ve "bize dahil" acikca yazilir', () => {
    const armed = launchFactsFrom(TESTNET, '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8')
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={armed} />)
    const liquidity = row('Liquidity')
    expect(liquidity.getByText(/permanently/i)).toBeInTheDocument()
    expect(liquidity.getByText(/including us/i)).toBeInTheDocument()
    expect(liquidity.queryByText(/not armed/i)).toBeNull()
  })

  it('BUYUK/KUCUK HARF: zincir checksum`lu cevap verir, hedef yine de SIFIRDIR', () => {
    // `graduationTarget` sifirken viem `0x0000...0000` dondurur, ama bir
    // proxy ya da farkli bir istemci onu buyuk harfle verebilir. Kucuk harfe
    // indirmeyen bir karsilastirma her SILAHSIZ fabrikayi SILAHLI sayar --
    // yani sayfanin en agir cumlesini tam ters yone cevirir.
    const upper = launchFactsFrom(
      TESTNET,
      '0x0000000000000000000000000000000000000000'.toUpperCase(),
    )
    expect(upper.graduationArmed).toBe(false)
  })

  it('FABRIKA CEVAP VEREMEZSE hicbir likidite IDDIASI basilmaz', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={null} />)
    const liquidity = row('Liquidity')
    expect(liquidity.getByText('—')).toBeInTheDocument()
    expect(liquidity.queryByText(/locked/i)).toBeNull()
    expect(liquidity.queryByText(/not armed/i)).toBeNull()
  })

  it('para hucreleri `<Money>`den gecer ve yonu ISIMLENDIRILMISTIR', () => {
    const { container } = render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    const monies = container.querySelectorAll('[data-rounding]')
    expect(monies.length).toBe(2)
    // Mezuniyet bir ESIKTIR -> yukari. Market cap var olan bir degeri anlatir
    // -> asagi. Varsayilan yon YOKTUR ve olmamalidir.
    expect(row('Graduation at').getByText(/12\.161434/)).toBeInTheDocument()
    expect(row('Opening market cap').getByText('4.00')).toBeInTheDocument()
  })

  /*
   * KALICI ARTIK GORUNUR KALIR -- AMA YUZDE OLARAK.
   *
   * Onceden 20 haneli tam degeri yaziliyordu ve gerekcesi suydu: uc sayi
   * toplamda `N` etmiyor, sebebi gorunmeli. Gerekce hala gecerli, TASIYICI
   * degisti: bir kurucuya `13,988.816402609506057782` gostermek, gercekten
   * onemli olan uc sayinin (toplam arz, curve'deki, havuzdaki) okunurlugunu
   * dusuruyordu. Yuzde ayni olguyu bir bakista soyler.
   *
   * TOPLAMIN TUTTUGU IDDIASI KAYBOLMADI: `facts` suite'indeki
   * "ARZIN TAMAMI TUTAR" testi `S + D + artik === N` esitligini olcuyor. Bu
   * test EKRANI olcer, aritmetigi degil.
   */
  it('kalici artik YUZDE olarak yazilir, ve "0.00" diye kaybolmaz', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={FACTS} />)
    const pool = row('Reserved for the pool')
    expect(pool.getByText(/rounding remainder/i)).toBeInTheDocument()
    // Iki ondalik `0.00` verirdi -- yani "yok" derdi, oysa var.
    expect(pool.getByText(/0\.0014%/)).toBeInTheDocument()
  })

  it('profil okunamadiginda sayilar "—" olur, kart YOK OLMAZ', () => {
    render(<TokenPreviewCard fields={EMPTY_FIELDS} facts={null} />)
    // `launch(name, symbol, uri)` uc dizeden ibarettir: profil dustugunde de
    // launch edilebilir olmali.
    expect(screen.getByText('Total supply')).toBeInTheDocument()
    expect(row('Total supply').getByText('—')).toBeInTheDocument()
    expect(row('Launch fee').getByText('None')).toBeInTheDocument()
  })

  it('onizleme TEMIZLENMIS adi gosterir: kullanici ekranda ne gorecekse onu gorur', () => {
    render(
      <TokenPreviewCard
        fields={{ ...EMPTY_FIELDS, name: 'Diff‮usion', symbol: 'DIFF' }}
        facts={FACTS}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Diffusion' })).toBeInTheDocument()
  })
})
