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
    render(<Address value={FACTORY} copy label="Launch factory" />)

    await user.click(screen.getByRole('button', { name: /copy launch factory/i }))

    // `userEvent.setup()` kendi pano sahtesini kurar; okunan sey o panonun
    // ICERIGI, yani bir cagri kaydi degil gercekten yazilmis metin. Kisaltma
    // bilgi kaybidir ve panoya kisaltilmis adres yazmak, yapistiran kisiye
    // gecersiz bir adres verir.
    expect(await navigator.clipboard.readText()).toBe(FACTORY)
    expect(await screen.findByText('Address copied')).toBeInTheDocument()
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
