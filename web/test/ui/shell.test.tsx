import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppShell } from '@/components/layout/AppShell'
import { BRAND } from '@/lib/brand'
import { renderWithProviders } from './harness'

/**
 * KABUGUN ERISILEBILIRLIK IDDIALARI, CALISTIRILARAK.
 *
 * `AppShell` `layout.tsx`'ten ayri bir bilesen; `layout.tsx` `next/font/local`
 * cagirir ve o cagri yalnizca Next'in derleyicisi altinda cozulur, yani
 * Vitest'te render edilemez. Kabuk ayri durdugu icin bu iddialar bir yorum
 * degil bir test.
 */
describe('kabuk', () => {
  it('atlama baglantisi ILK odaklanabilir ogedir ve ana bolgeyi hedefler', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
    )

    await user.tab()

    const skip = screen.getByRole('link', { name: /skip to content/i })
    expect(document.activeElement).toBe(skip)
    expect(skip).toHaveAttribute('href', '#main')
    expect(skip.className).toContain('skip-link')
  })

  it('TEK bir main landmark var ve atlama baglantisinin hedefi odur', () => {
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
    )

    const mains = screen.getAllByRole('main')
    expect(mains).toHaveLength(1)
    expect(mains[0]).toHaveAttribute('id', 'main')
    // Odaklanamayan bir hedefe atlamak yalnizca kaydirma yapar: Tab'a bir
    // sonraki basista odak hâlâ basliktadir.
    expect(mains[0]).toHaveAttribute('tabindex', '-1')
  })

  it('banner, navigation ve contentinfo landmarklari yerinde', () => {
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
    )

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Footer' })).toBeInTheDocument()
  })

  it('wordmark BRAND’ten gelir, isaretlemeye dagitilmaz', () => {
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
    )

    const banner = screen.getByRole('banner')
    expect(within(banner).getByRole('link', { name: `${BRAND.name} home` })).toHaveTextContent(
      BRAND.wordmark,
    )
  })

  it('ikon hâline dusen kontroller erisilebilir adlarini korur', () => {
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
    )

    const banner = screen.getByRole('banner')
    // Dar ekranda "Create" metni gizlenir ve geriye `aria-hidden` bir `+`
    // kalir. Ad `aria-label`den gelmezse baglanti ekran okuyucuda adsizdir.
    expect(within(banner).getByRole('link', { name: 'Create a token' })).toHaveAttribute(
      'href',
      '/create',
    )
    expect(within(banner).getByRole('button', { name: 'Search tokens' })).toBeInTheDocument()
  })

  it('altbilgi testnet uyarisini ve geri alinamazlik notunu tasir', () => {
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
    )

    const footer = screen.getByRole('contentinfo')
    // Urun kamuya acik bir testnet'te duruyor ve Circle'in faucet'inden gelen
    // USDC gercek para degil. Bu satir istege bagli degil.
    expect(footer).toHaveTextContent('Arc Testnet. Tokens here have no monetary value.')
    expect(footer).toHaveTextContent(/irreversible/i)
    expect(footer).toHaveTextContent(`${BRAND.name} does not custody assets.`)
    expect(footer).toHaveTextContent(BRAND.tagline)
  })

  it('baglanmamis ziyaretciye yanlis-ag seridi GOSTERILMEZ', async () => {
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
    )

    // Baglanmamisken wagmi'nin chainId'si undefined'dir; naif bir
    // karsilastirma bu seridi her ilk ziyaretciye gosterir ve insanlara
    // onemli olan tek uyariyi kapatmayi ogretir.
    await waitFor(() => expect(screen.queryByTestId('network-banner')).not.toBeInTheDocument())
  })

  it('yanlis agdaki cuzdana serit ve gecis dugmesi gosterilir', async () => {
    renderWithProviders(
      <AppShell>
        <p>content</p>
      </AppShell>,
      { connected: true, wrongNetwork: true },
    )

    const banner = await screen.findByTestId('network-banner')
    // Serit "hicbir sey calismiyor" DEMEZ: RPC tasiyicisi bizim, site yanlis
    // agda da tamamen okunur, durulan tek yer imzadir.
    expect(banner).toHaveTextContent(/you can read everything here/i)
    expect(within(banner).getByRole('button', { name: /switch to arc testnet/i })).toBeEnabled()
  })
})
