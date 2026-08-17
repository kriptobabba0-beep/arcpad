import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="opener">
        Connect wallet
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false)
          onClose?.()
        }}
        title="Connect a wallet"
        description="You sign every transaction in your own wallet."
      >
        <button type="button">MetaMask</button>
        <button type="button">Rabby</button>
      </Dialog>
    </>
  )
}

describe('<Dialog>', () => {
  it('role, aria-modal ve baslik baglantisini tasir', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('opener'))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // Erisilebilir ad BASLIKTAN gelir; `aria-labelledby` bagi kopunca bu duser.
    expect(dialog).toHaveAccessibleName('Connect a wallet')
    expect(dialog).toHaveAccessibleDescription('You sign every transaction in your own wallet.')
  })

  it('acilista odak panelin kendisine gider', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('opener'))

    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  /**
   * ODAK TUZAGI. `aria-modal="true"` yardimci teknolojiye "arkasi kapali" der
   * ama KLAVYEYE hicbir sey soylemez. Tuzak kaldirildiginda Tab modali terk
   * eder ve kullanici gormedigi bir seye odaklanir -- bu test tam olarak o
   * mutanti oldurur.
   */
  it('Tab sondan basa sarar, modali TERK ETMEZ', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('opener'))

    const rabby = screen.getByRole('button', { name: 'Rabby' })
    rabby.focus()
    expect(document.activeElement).toBe(rabby)

    await user.tab()

    // Ilk odaklanabilir oge DOM sirasinda "Close"; onemli olan odagin modalin
    // ICINDE kalmasi.
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('Shift+Tab bastan sona sarar', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('opener'))

    screen.getByRole('button', { name: 'Close' }).focus()
    await user.tab({ shift: true })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rabby' }))
  })

  it('acilistaki panel odagindan Shift+Tab da modalin arkasina kacmaz', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('opener'))

    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    await user.tab({ shift: true })

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('Esc kapatir', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    await user.click(screen.getByTestId('opener'))

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('kapanista odak ACAN ogeye geri doner', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByTestId('opener')

    await user.click(opener)
    await user.keyboard('{Escape}')

    // Donmezse odak <body>'ye duser ve klavyeyle gezen biri her modal
    // kapanisinda sayfayi bastan gezmek zorunda kalir.
    expect(document.activeElement).toBe(opener)
  })

  it('kapaliyken hicbir sey cizmez', () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
