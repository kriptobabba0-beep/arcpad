import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CompleteSection } from '@/components/explore/CompleteSection'
import {
  NoLaunchesForFilter,
  NoLaunchesYet,
  ReadUnavailable,
} from '@/components/explore/EmptyState'
import { KeysetPager } from '@/components/explore/KeysetPager'
import { progressPercent, TokenCard } from '@/components/explore/TokenCard'
import { GRID_CLASS, TokenGrid, TokenGridSkeleton } from '@/components/explore/TokenGrid'
import { CLIMBING, SMOKE } from '../fixtures/readModel'

describe('progressPercent', () => {
  /**
   * `progressPpm` MILYONDA PAYDIR. 10.000'e bolunur, 1.000'e degil.
   * Fixture'in 253_087'si ELLE turetildi (`1e6 - ceil(kalan*1e6/S)`), yani bu
   * iddia bilesenin kendi aritmetigini tekrar etmiyor.
   */
  it('253_087 ppm -> 25.3%', () => {
    expect(progressPercent(253_087)).toBe('25.3')
  })

  it('sinirlar', () => {
    expect(progressPercent(0)).toBe('0.0')
    expect(progressPercent(1_000_000)).toBe('100.0')
  })
})

describe('<TokenCard>', () => {
  it('UC metrik tasir; holder sayisi ve 24s hacim KARTA KONMAZ', () => {
    render(<TokenCard overview={CLIMBING} />)
    const card = screen.getByRole('link')

    expect(card).toHaveTextContent('Diff')
    expect(card).toHaveTextContent('$DIFF')
    expect(card).toHaveTextContent('25.3%')
    // Kart yogunlugu bir kaynaktir: bes metrik, hicbirinin okunmamasi demek.
    expect(card).not.toHaveTextContent(/holders?/i)
    expect(card).not.toHaveTextContent(/24h/i)
  })

  it('DEVIASYON 3: yuzde ciplak degil, neyin yuzdesi oldugu yazar', () => {
    render(<TokenCard overview={CLIMBING} />)
    // Bu urunde IKI farkli yuzde var (ilerleme ve arz payi); ciplak birakmak
    // gercekten yaniltir.
    expect(screen.getByRole('link')).toHaveTextContent('to graduation')
  })

  it('erisilebilir ad tek bir dizedir ve gorseli icermez', () => {
    render(<TokenCard overview={CLIMBING} />)
    const card = screen.getByRole('link', {
      name: /Diff \(DIFF\), market cap .*, 25\.3% to graduation/,
    })
    expect(card).toBeInTheDocument()
    // Gorsel dekoratif: adi zaten bitisik metin tasiyor.
    expect(card.querySelector('img')?.getAttribute('alt') ?? '').toBe('')
  })

  it('kartin ICINDE ikinci bir etkilesimli oge YOKTUR', () => {
    render(<TokenCard overview={CLIMBING} />)
    const card = screen.getByRole('link')
    // Ic ice tiklanabilir oge klavye ve ekran okuyucu icin kiriktir: Tab iki
    // durak yapar ve kullanici hangi hedefe gittigini bilemez.
    expect(card.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0)
  })

  it('tamamlanmis curve ilerleme cubugu yerine rozet gosterir', () => {
    render(<TokenCard overview={SMOKE} />)
    expect(screen.getByRole('link')).toHaveTextContent('Curve complete')
    expect(screen.getByRole('link')).not.toHaveTextContent('to graduation')
  })

  it('token sayfasina baglar', () => {
    render(<TokenCard overview={SMOKE} />)
    expect(screen.getByRole('link')).toHaveAttribute('href', `/token/${SMOKE.token}`)
  })
})

describe('izgara geometrisi', () => {
  /**
   * ISKELET IZGARAYLA AYNI GEOMETRIDE OLMAK ZORUNDA, yoksa icerik geldiginde
   * sayfa ziplar -- iskeletin var olma sebebinin tam tersi. Ikisi ayni sinif
   * sabitini PAYLASIR, bu yuzden ayrisamazlar; test o paylasimi olcer.
   */
  it('iskelet ve izgara ayni kirilma noktalarini kullanir', () => {
    const grid = render(<TokenGrid tokens={[CLIMBING]} label="Launches" />)
    const gridClass = grid.container.querySelector('ul')?.className ?? ''
    grid.unmount()

    const skeleton = render(<TokenGridSkeleton count={3} />)
    const skeletonClass = skeleton.container.firstElementChild?.className ?? ''

    for (const cls of GRID_CLASS.split(' ')) {
      expect(gridClass).toContain(cls)
      expect(skeletonClass).toContain(cls)
    }
  })

  it('bes kirilma noktasi tanimli', () => {
    expect(GRID_CLASS).toContain('grid-cols-1')
    expect(GRID_CLASS).toContain('min-[480px]:grid-cols-2')
    expect(GRID_CLASS).toContain('md:grid-cols-3')
    expect(GRID_CLASS).toContain('lg:grid-cols-4')
    expect(GRID_CLASS).toContain('xl:grid-cols-5')
  })

  it('iskelet tek satirlik bir "Loading" degil, kart sayisinca kutu cizer', () => {
    render(<TokenGridSkeleton count={7} />)
    expect(screen.getAllByTestId('token-card-skeleton')).toHaveLength(7)
  })
})

/**
 * DORT BOS/HATA DURUMU BIRBIRINDEN AYRIDIR.
 *
 * Aynisini soyleyen tek bir kutu, kullaniciya YANLIS seyi soyler ve onu
 * yanlis eyleme yonlendirir: filtresi bosken sayfayi terk etmeye, veritabani
 * dusmusken token yaratmaya.
 */
describe('bos durumlar', () => {
  it('urun bos: Create cagrisi', () => {
    render(<NoLaunchesYet />)
    expect(screen.getByText('No launches yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /create a token/i })).toHaveAttribute('href', '/create')
  })

  it('filtre bos: pencereyi ADIYLA anar ve filtreyi temizler', () => {
    render(<NoLaunchesForFilter ageDays={1} />)
    expect(screen.getByText('No launches in the last 24 hours.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /clear filters/i })).toHaveAttribute('href', '/')
  })

  it('iki bos durum AYNI metni PAYLASMAZ', () => {
    const empty = render(<NoLaunchesYet />)
    const emptyText = empty.container.textContent ?? ''
    empty.unmount()

    const filtered = render(<NoLaunchesForFilter ageDays={7} />)
    const filteredText = filtered.container.textContent ?? ''

    expect(emptyText).not.toBe(filteredText)
    expect(filteredText).toContain('7 days')
    // Filtre bosken "urun bos" demek, kullaniciya olmayan bir gercegi soyler.
    expect(filteredText).not.toContain('No launches yet.')
  })

  it('veritabani dustu: ne kaybedildigi ve neyin calistigi AYRI AYRI yazar', () => {
    render(<ReadUnavailable what="The launch list" />)
    expect(screen.getByText(/can't load the index/i)).toBeInTheDocument()
    // Kullanicinin sonraki hamlesi buna bagli: islem ve launch zincire gider.
    expect(screen.getByText(/straight to the chain and still work/i)).toBeInTheDocument()
  })
})

describe('<CompleteSection>', () => {
  it('"Graduated" DEGIL "Curve complete" (S6)', () => {
    render(<CompleteSection tokens={[]} />)
    // `graduated` bayragi ve havuz Faz 2'de; olmayan bir asamayi adiyla anmak
    // kullaniciya var olmayan bir likidite havuzu vaat eder.
    expect(screen.getByRole('heading', { name: 'Curve complete' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Graduated' })).not.toBeInTheDocument()
    // NOT "Pool creation lands with Phase 2." -- Faz 2 2026-08-06'dan beri
    // zincirde ve o cumle token sayfasindaki ikiziyle birlikte duzeltildi.
    expect(
      screen.getByText('Sale supply sold out. Opening the pool is a separate step called graduation.'),
    ).toBeVisible()
  })

  it('bugun BOS ve bu bir hata degil', () => {
    render(<CompleteSection tokens={[]} />)
    expect(screen.getByText(/no curve has sold out yet/i)).toBeInTheDocument()
  })

  it('Faz 2’nin ayrimi bugunden isimlendirilmis', () => {
    // O gun bir yeniden yazim degil bir ikinci cagri olsun diye.
    render(<CompleteSection tokens={[SMOKE]} phase="graduated" />)
    expect(screen.getByRole('heading', { name: 'Graduated' })).toBeInTheDocument()
    expect(within(screen.getByRole('list')).getAllByRole('link')).toHaveLength(1)
  })
})

describe('<KeysetPager>', () => {
  it('NUMARALI SAYFA YOK -- yalnizca Prev/Next ve toplam', () => {
    render(
      <KeysetPager
        basePath="/"
        query={{}}
        cursors={[]}
        nextCursor="4194304"
        total={159_123}
        label="Launch pages"
      />,
    )
    // Numarali bir sayfa listesi, keyset siralamada veremeyecegimiz bir
    // kesinlik vaat eder.
    expect(screen.queryByRole('link', { name: '2' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/?after=4194304')
  })

  it('toplam sayi en-US locale ile bicimlenir', () => {
    render(
      <KeysetPager
        basePath="/"
        query={{}}
        cursors={[]}
        nextCursor="4194304"
        total={159_123}
        label="Launch pages"
      />,
    )
    expect(screen.getByText('159,123')).toHaveClass('tabular-nums')
  })

  it('geri gitmek icin cursor yiginini URL’de tasir', () => {
    render(
      <KeysetPager
        basePath="/"
        query={{ sort: 'volume' }}
        cursors={['10', '20']}
        nextCursor="30"
        total={99}
        label="Launch pages"
      />,
    )
    expect(screen.getByRole('link', { name: 'Prev' })).toHaveAttribute(
      'href',
      '/?sort=volume&after=10',
    )
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/?sort=volume&after=30&seen=10.20',
    )
  })

  it('tek sayfa varsa hic cizilmez', () => {
    const { container } = render(
      <KeysetPager
        basePath="/"
        query={{}}
        cursors={[]}
        nextCursor={null}
        total={3}
        label="Launch pages"
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
