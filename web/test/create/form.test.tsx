import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchFactsFrom } from '@/components/create/facts'
import { LaunchForm } from '@/components/create/LaunchForm'
import type { LaunchDriver } from '@/components/create/useLaunch'
import { renderWithProviders } from '../ui/harness'
import { launchedLog, SMOKE_CURVE, SMOKE_TOKEN } from './fixtures'

const FACTS = launchFactsFrom(
  {
    virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
    virtualQuoteReserves: 4_292n * 10n ** 15n,
    saleSupply: 793_100_000n * 10n ** 18n,
  },
  // Unset, which is what the live testnet factory answers today.
  '0x0000000000000000000000000000000000000000',
)

function stubDriver(overrides: Partial<LaunchDriver> = {}): LaunchDriver {
  return {
    simulate: vi.fn(async () => undefined),
    write: vi.fn(async () => '0xhash' as const),
    receipt: vi.fn(async () => ({ logs: [] })),
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('<LaunchForm> -- S16, "Advanced" bolumu YOKTUR', () => {
  it('sabit-parametre satiri cizilir', async () => {
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)
    expect(await screen.findByTestId('fixed-parameters')).toHaveTextContent(
      'Curve parameters are fixed for every launch.',
    )
  })

  it('"Advanced" sozcugu hicbir yerde GECMEZ', async () => {
    const { container } = renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)
    await screen.findByTestId('fixed-parameters')
    /*
     * Katlanmis bos bir "Advanced" bolumu, OLMAYAN bir kontrol vaat eder:
     * `launch`in uc argumani vardir ve geri kalan her parametre factory'nin
     * `immutable`idir. Kullaniciyi acip icinde bir sey aramaya gondermek,
     * bulamadigi seyi kendi hatasi sanmasina yol acar.
     */
    expect(container.textContent ?? '').not.toMatch(/\bAdvanced\b/i)
  })
})

describe('<LaunchForm> -- S4, dev buy IKINCI BIR ISLEMDIR', () => {
  it('ayri islem oldugu ve tavan OLMADIGI yazilir', async () => {
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)
    expect(
      await screen.findByText('A separate transaction. Your launch is live either way.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('no-cap-note')).toHaveTextContent(/no cap on a creator's first buy/i)
  })

  it('dev buy bolumunde HICBIR YUZDE gecmez', async () => {
    const { container } = renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)
    await screen.findByTestId('no-cap-note')
    const section = container.querySelector('section[aria-labelledby="devbuy-heading"]')
    expect(section).not.toBeNull()
    /*
     * Zincirde TAVAN YOKTUR: `launch` `payable` degildir, hicbir alim yapmaz
     * ve hicbir yerde bir tavan kontrolu yoktur. Bu bolumde bir yuzde
     * gostermek -- %5 ya da baska bir sayi -- neyin yuzdesi oldugu
     * soylenemeyecek bir sayi gostermektir.
     */
    expect(section?.textContent ?? '').not.toContain('%')
  })

  it('gecersiz tutar gonderimi engeller', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />, { connected: true })
    await screen.findByRole('button', { name: 'Launch' })

    await user.type(screen.getByPlaceholderText('0.00'), '1e9')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled())
  })
})

describe('<LaunchForm> -- bos ve hata durumlari', () => {
  it('bagli degilken form DOLDURULABILIR, buton "Connect wallet" der', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)

    const name = await screen.findByLabelText('Name')
    await user.type(name, 'Diffusion')
    expect(name).toHaveValue('Diffusion')

    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeDisabled()
    // Devre disi bir buton cikmaz sokaktir; nereye gidilecegi YAZILI.
    expect(screen.getByText(/Use the Connect wallet button at the top/i)).toBeInTheDocument()
  })

  it('yanlis agda buton ag degistirir, launch etmez', async () => {
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />, {
      connected: true,
      wrongNetwork: true,
    })
    expect(await screen.findByRole('button', { name: /switch to arc testnet/i })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument()
  })

  it('pinning yapilandirilmamisken URI alani calisir ve bu bir HATA gibi cizilmez', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured={false} />)

    const note = await screen.findByTestId('pinning-unconfigured')
    expect(note).toHaveTextContent(/artwork is pasted rather than uploaded/i)
    // Bir hata degil, urunun o kurulumdaki calisma bicimi.
    expect(note).not.toHaveAttribute('role', 'alert')
    expect(screen.queryByLabelText('Artwork')).not.toBeInTheDocument()

    const uri = screen.getByLabelText('Metadata URI')
    await user.type(uri, 'ipfs://bafybeib')
    expect(uri).toHaveValue('ipfs://bafybeib')
  })

  it('"URI’siz launch" secilince URI temizlenir ve alan kilitlenir', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured={false} />)

    const uri = await screen.findByLabelText('Metadata URI')
    await user.type(uri, 'ipfs://bafybeib')
    await user.click(screen.getByLabelText(/Launch without artwork/i))

    expect(uri).toHaveValue('')
    expect(uri).toBeDisabled()
  })

  it('CUZDAN REDDINDE FORM AYNEN DURUR', async () => {
    const user = userEvent.setup()
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 })
    const driver = stubDriver({
      write: vi.fn(async () => {
        throw rejection
      }),
    })

    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured driver={driver} />, {
      connected: true,
    })
    await screen.findByRole('button', { name: 'Launch' })

    await user.type(screen.getByLabelText('Name'), 'Diffusion')
    await user.type(screen.getByLabelText('Symbol'), 'DIFF')
    await user.type(screen.getByPlaceholderText('0.00'), '12.5')
    await user.click(screen.getByRole('button', { name: 'Launch' }))

    const failure = await screen.findByTestId('launch-failure')
    expect(within(failure).getByText('Transaction cancelled')).toBeInTheDocument()

    /*
     * EN SIK YASANAN DURUM BUDUR: kullanici pencereyi gorur, bir daha okur,
     * vazgecer. Formu sifirlamak, on dakikalik bir isi bir "Reject" tusuna
     * baglamak olurdu.
     */
    expect(screen.getByLabelText('Name')).toHaveValue('Diffusion')
    expect(screen.getByLabelText('Symbol')).toHaveValue('DIFF')
    expect(screen.getByPlaceholderText('0.00')).toHaveValue('12.5')
    // Ve tekrar denenebilir.
    expect(screen.getByRole('button', { name: 'Launch' })).toBeEnabled()
  })

  it('yukleme dustugunde DOSYA KAYBOLMAZ ve tekrar denenebilir', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"pinningFailed"}', { status: 502 })),
    )
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)

    await user.click(await screen.findByLabelText(/I understand the artwork is uploaded/i))
    const file = new File(['x'], 'rocket.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Artwork'), file)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument()
    // En can sikici hata, kullaniciyi yaptigi isi tekrarlamaya zorlayandir.
    expect(screen.getByText('rocket.png')).toBeInTheDocument()
  })

  it('rota 501 dondugunde form URI yoluna DUSER, hata gostermez', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"pinningNotConfigured"}', { status: 501 })),
    )
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)

    await user.click(await screen.findByLabelText(/I understand the artwork is uploaded/i))
    await user.upload(
      screen.getByLabelText('Artwork'),
      new File(['x'], 'rocket.png', { type: 'image/png' }),
    )

    expect(await screen.findByTestId('pinning-unconfigured')).toBeInTheDocument()
    // Hicbir hata metni yok: 501 bir ariza degil, bu kurulumda pinning'in
    // olmadiginin ifadesidir. (`queryByRole('alert')` KULLANILMIYOR: Toast
    // saglayicisi bos bir `role="alert"` bolgesini her zaman cizer.)
    expect(screen.queryByText(/upload failed/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByLabelText('Metadata URI')).toBeEnabled()
  })

  it('yukleme basarili olunca donen URI zincire giden alana yazilir', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"uri":"ipfs://bafyjson","image":"ipfs://bafyimage"}', { status: 200 }),
      ),
    )
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)

    await user.click(await screen.findByLabelText(/I understand the artwork is uploaded/i))
    await user.upload(
      screen.getByLabelText('Artwork'),
      new File(['x'], 'rocket.png', { type: 'image/png' }),
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Metadata URI')).toHaveValue('ipfs://bafyjson'),
    )
  })

  it('onay kutusu ISARETLENMEDEN dosya secilemez', async () => {
    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured />)
    // IPFS'e pinlenen bir dosya SILINEMEZ; bunu dosya secildikten sonra
    // soylemek, geri alinamayan bir islemi haber vermeden yaptirmak olurdu.
    expect(await screen.findByLabelText('Artwork')).toBeDisabled()
  })
})

describe('<LaunchForm> -- launch sonrasi', () => {
  it('makbuzdaki adres cizilir ve dev buy tutari token sayfasina TASINIR', async () => {
    const user = userEvent.setup()
    const driver = stubDriver({
      receipt: vi.fn(async () => ({
        logs: [launchedLog({ token: SMOKE_TOKEN, curve: SMOKE_CURVE })],
      })),
    })

    renderWithProviders(<LaunchForm facts={FACTS} pinningConfigured driver={driver} />, {
      connected: true,
    })
    await screen.findByRole('button', { name: 'Launch' })

    await user.type(screen.getByLabelText('Name'), 'Diffusion')
    await user.type(screen.getByLabelText('Symbol'), 'DIFF')
    await user.type(screen.getByPlaceholderText('0.00'), '12.5')
    await user.click(screen.getByRole('button', { name: 'Launch' }))

    const link = await screen.findByRole('link', { name: /View token and buy 12\.5 USDC/ })
    expect(link).toHaveAttribute('href', `/token/${SMOKE_TOKEN}?buy=12.5`)
    // Alim HENUZ YAPILMADI ve bu acikca yazilir.
    expect(screen.getByText(/Nothing has been bought yet/i)).toBeInTheDocument()
  })
})
