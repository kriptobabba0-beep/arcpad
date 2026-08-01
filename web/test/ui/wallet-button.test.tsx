import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { WalletButton } from '@/components/layout/WalletButton'
import { renderWithProviders, TEST_ACCOUNT } from './harness'

describe('<WalletButton>', () => {
  describe('bagli degil', () => {
    it('birincil bir "Connect wallet" dugmesi cizer', async () => {
      renderWithProviders(<WalletButton />)
      const button = await screen.findByRole('button', { name: 'Connect wallet' })
      expect(button.className).toContain('bg-primary')
    })

    it('connector listesi bir Dialog icinde ve EIP-6963 ile kesfedilir', async () => {
      const user = userEvent.setup()
      renderWithProviders(<WalletButton />)

      await user.click(await screen.findByRole('button', { name: 'Connect wallet' }))

      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveAccessibleName('Connect a wallet')
      // Liste `useConnectors()`'tan gelir; elle yazilmis bir cuzdan listesi
      // kurulu olmayanlari onerir ve kurulu olan yenilerini gizler.
      expect(within(dialog).getByRole('button', { name: /mock connector/i })).toBeInTheDocument()
    })
  })

  describe('yanlis ag', () => {
    it('gecis dugmesi cizer, bakiye cizmez', async () => {
      renderWithProviders(<WalletButton />, { connected: true, wrongNetwork: true })

      expect(await screen.findByRole('button', { name: /switch to arc testnet/i })).toBeVisible()
      expect(screen.queryByTitle(TEST_ACCOUNT)).not.toBeInTheDocument()
    })
  })

  describe('bagli', () => {
    it('kisaltilmis adres ve bakiye TEK SATIRDA durur', async () => {
      renderWithProviders(<WalletButton />, { connected: true })

      const chip = await waitFor(() => {
        const cell = screen.getByTitle(TEST_ACCOUNT)
        return cell.closest('button') as HTMLButtonElement
      })

      // Sarilirsa iki satir olur, ve iki satir "iki bakiye" gibi okunur.
      expect(chip.className).toContain('whitespace-nowrap')
      expect(chip).toHaveTextContent('0x7938…4c9C')
    })

    /**
     * K1'IN GORUNUR HALI: TEK BAKIYE, IKI DEGIL.
     *
     * Arc'ta native gaz varligi USDC'nin kendisidir ve ayni fonun iki okumasi
     * vardir. Iki figur gostermek 1e12'lik bir hatayi ekranda dogrulanmis gibi
     * gosterir; hicbir calisma zamani kontrolu onu goremez.
     */
    it('cuzdan panelinde TEK bir bakiye figuru vardir', async () => {
      const user = userEvent.setup()
      renderWithProviders(<WalletButton />, { connected: true })

      const chip = await waitFor(() => {
        const cell = screen.getByTitle(TEST_ACCOUNT)
        return cell.closest('button') as HTMLButtonElement
      })
      await user.click(chip)

      const dialog = screen.getByRole('dialog')
      // TAM eslesme: paneldeki tek "Balance" ETIKETI. Bir gun ikinci bir
      // "Native balance" / "USDC balance" ciftinin eklenmesi burada kirilir.
      expect(within(dialog).getAllByText('Balance')).toHaveLength(1)
      expect(within(dialog).queryByText(/native/i)).not.toBeInTheDocument()
      expect(within(dialog).queryByText(/\bwei\b/i)).not.toBeInTheDocument()
    })

    it('iki gorunum tek cumleyle aciklanir', async () => {
      const user = userEvent.setup()
      renderWithProviders(<WalletButton />, { connected: true })

      const chip = await waitFor(() => {
        const cell = screen.getByTitle(TEST_ACCOUNT)
        return cell.closest('button') as HTMLButtonElement
      })
      await user.click(chip)

      expect(
        within(screen.getByRole('dialog')).getByText(
          "USDC is Arc's gas asset. Your wallet may show 18 decimals; this is the same balance.",
        ),
      ).toBeInTheDocument()
    })

    it('panelde tam adres, kopyalama ve explorer baglantisi bulunur', async () => {
      const user = userEvent.setup()
      renderWithProviders(<WalletButton />, { connected: true })

      const chip = await waitFor(() => {
        const cell = screen.getByTitle(TEST_ACCOUNT)
        return cell.closest('button') as HTMLButtonElement
      })
      await user.click(chip)

      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByTitle(TEST_ACCOUNT)).toHaveTextContent(TEST_ACCOUNT)
      expect(within(dialog).getByRole('button', { name: /copy your wallet/i })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    })
  })
})
