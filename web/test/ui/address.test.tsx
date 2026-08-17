import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Address, shortenAddress } from '@/components/ui/Address'

/** Zincirde SU AN duran adresler. */
const FACTORY = '0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439'
const SMOKE_TOKEN = '0x1bd93613a7BC470a739D9615cdc65e535d958fab'

describe('shortenAddress', () => {
  it('iki ucu da tasir -- `0x` + 4 nibble, sonra son 4', () => {
    expect(shortenAddress(FACTORY)).toBe('0x0d75…b439')
    expect(shortenAddress(SMOKE_TOKEN)).toBe('0x1bd9…8fab')
  })

  it('zaten kisa olani bozmaz', () => {
    expect(shortenAddress('0x1234')).toBe('0x1234')
  })
})

describe('<Address>', () => {
  it('tabular-nums tasir ve tam degeri title olarak birakir', () => {
    render(<Address value={FACTORY} />)
    const cell = screen.getByTitle(FACTORY)
    expect(cell.className.split(/\s+/)).toContain('tabular-nums')
    expect(cell).toHaveTextContent('0x0d75…b439')
  })

  it('shorten=false tam adresi yazar', () => {
    render(<Address value={FACTORY} shorten={false} />)
    expect(screen.getByTitle(FACTORY)).toHaveTextContent(FACTORY)
  })

  it('kopyalama TAM adresi panoya yazar, kisaltilmisini degil', async () => {
    const user = userEvent.setup()
    /*
      GUVENLI BAGLAM ACIKCA KURULUR. `navigator.clipboard` yalnizca guvenli
      bir baglamda (HTTPS ya da localhost) VARDIR, ve bileşen bunu artik
      okuyor -- cunku uretimde duz HTTP uzerinden pano API'si TANIMSIZDI ve
      `?.writeText()` sessizce hicbir sey yapiyordu. jsdom varsayilan olarak
      guvensiz sayiliyor; bayragi kurmadan bu test asagidaki yedek yolu
      olcerdi, ustteki yolu degil.
    */
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    render(<Address value={FACTORY} copy label="Launch factory" />)

    await user.click(screen.getByRole('button', { name: /copy launch factory/i }))

    // `userEvent.setup()` kendi pano sahtesini kurar; okunan sey o panonun
    // ICERIGI, yani bir cagri kaydi degil gercekten yazilmis metin. Kisaltma
    // bilgi kaybidir ve panoya kisaltilmis adres yazmak, yapistiran kisiye
    // gecersiz bir adres verir.
    expect(await navigator.clipboard.readText()).toBe(FACTORY)
    expect(await screen.findByText('Address copied')).toBeInTheDocument()
  })

  /*
   * ============ KULLANICININ BILDIRDIGI KUSUR, BIR KAPI OLARAK ============
   *
   * "Contract address kopyalama butonu calismiyor." Sebep kodda bir yazim
   * hatasi degildi: site duz HTTP uzerinden (`http://167.99.135.135`)
   * sunuluyor ve tarayici pano API'sini GUVENLI OLMAYAN bir baglamda hic
   * tanimlamiyor. `navigator.clipboard?.writeText()` bu yuzden `undefined`
   * uzerinden kisa devre yapiyor, hata firlatmiyor, hicbir sey yapmiyordu --
   * yani buton basiliyor, bir sey olmuyordu.
   *
   * Yedek yol `document.execCommand('copy')`: eski, kullanimdan kaldirilmis,
   * ama duz HTTP'de calisan TEK yol. jsdom onu uygulamadigi icin burada
   * sahtesi kuruluyor; olculen sey secimin panoya GIDIYOR olmasi degil, o
   * yolun GERCEKTEN denendigi ve durumun "kopyalandi"ya dondugu.
   */
  it('pano APIsi yoksa (duz HTTP) yedek yola duser ve SESSIZ KALMAZ', async () => {
    const user = userEvent.setup()
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    let copied: string | null = null
    const exec = (command: string): boolean => {
      if (command !== 'copy') return false
      /*
        `execCommand('copy')` seciliyi kopyalar; yedek yol degeri gecici bir
        `<textarea>`ya yazip secer. jsdom secim modelini uygulamadigi icin
        olculen sey O ANDA BELGEDE duran alanin degeri: yani kopyalanmak uzere
        SUNULAN metin. Kisaltilmis bir adres sunulsaydi bu test duserdi.
      */
      copied = document.querySelector('textarea')?.value ?? null
      return true
    }
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })

    render(<Address value={FACTORY} copy label="Contract address" />)
    await user.click(screen.getByRole('button', { name: /copy contract address/i }))

    expect(copied, 'the fallback never reached the clipboard').toBe(FACTORY)
    expect(await screen.findByText('Address copied')).toBeInTheDocument()
  })

  /*
   * VE IKI YOL DA BASARISIZ OLURSA BUTON BUNU SOYLER. Sessiz basarisizlik
   * kullanicinin bildirdigi kusurun TA KENDISIYDI: bir sey olmadigini
   * anlamanin tek yolu yapistirmayi denemekti.
   */
  it('iki yol da dustugunde "copy failed" yazar', async () => {
    const user = userEvent.setup()
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })

    render(<Address value={FACTORY} copy label="Contract address" />)
    await user.click(screen.getByRole('button', { name: /copy contract address/i }))

    expect(await screen.findByText(/copy failed/i)).toBeInTheDocument()
  })

  it('explorer baglantisi kayittaki ArcScan adresine gider', () => {
    render(<Address value={SMOKE_TOKEN} explorer label="Token address" />)
    // Host `packages/shared/src/chain.ts`'in kaydindan gelir; burada elle
    // yazilmis olmasi, kayit degistiginde bu testin haber vermesi icin.
    expect(screen.getByRole('link', { name: /arcscan/i })).toHaveAttribute(
      'href',
      `https://testnet.arcscan.app/address/${SMOKE_TOKEN}`,
    )
  })

  it('explorer baglantisi yeni sekmede ve referrer sizdirmadan acilir', () => {
    render(<Address value={SMOKE_TOKEN} explorer />)
    const link = screen.getByRole('link', { name: /arcscan/i })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('varsayilan olarak ne kopyalama ne explorer cizer', () => {
    render(<Address value={FACTORY} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
