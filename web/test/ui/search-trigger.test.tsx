import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SearchTrigger } from '@/components/layout/SearchTrigger'

function Probe() {
  return (
    <SearchTrigger
      renderDialog={({ open, onClose }) =>
        open ? (
          <div data-testid="search-dialog">
            <button type="button" onClick={onClose}>
              close search
            </button>
          </div>
        ) : null
      }
    />
  )
}

describe('<SearchTrigger>', () => {
  /**
   * BIR KLAVYE KISAYOLU KESFEDILEBILIR DEGILDIR. Yalnizca ⌘K'ye baglanan bir
   * arama, onu bilmeyen herkes icin var olmayan bir ozelliktir.
   */
  it('gorunur bir butondur ve kisayolu uzerinde yazar', () => {
    render(<Probe />)
    const trigger = screen.getByRole('button', { name: /search tokens/i })
    expect(trigger).toBeVisible()
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveTextContent('K')
  })

  it('erisilebilir adi dar ekranda da durur -- ad `aria-label`den gelir', () => {
    render(<Probe />)
    // Metin `sm` altinda gizlenir, ikon ve kisayol rozeti `aria-hidden`dir.
    // `aria-label` kaldirilirsa buton mobilde ADSIZ kalir.
    expect(screen.getByRole('button', { name: 'Search tokens' })).toHaveAttribute(
      'aria-label',
      'Search tokens',
    )
  })

  it('tiklama acar', async () => {
    const user = userEvent.setup()
    render(<Probe />)

    await user.click(screen.getByRole('button', { name: /search tokens/i }))

    expect(screen.getByTestId('search-dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /search tokens/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('Ctrl+K acar -- tek platforma baglanan bir kisayol otekinde yok demektir', async () => {
    const user = userEvent.setup()
    render(<Probe />)

    await user.keyboard('{Control>}k{/Control}')

    expect(screen.getByTestId('search-dialog')).toBeInTheDocument()
  })

  it('⌘K de acar', async () => {
    const user = userEvent.setup()
    render(<Probe />)

    await user.keyboard('{Meta>}k{/Meta}')

    expect(screen.getByTestId('search-dialog')).toBeInTheDocument()
  })

  it('yalin K hicbir sey yapmaz', async () => {
    const user = userEvent.setup()
    render(<Probe />)

    await user.keyboard('k')

    expect(screen.queryByTestId('search-dialog')).not.toBeInTheDocument()
  })

  it('Task 9 gelmeden de tetikleyici cizilir ve kisayol calisir', async () => {
    const user = userEvent.setup()
    render(<SearchTrigger />)

    await user.keyboard('{Control>}k{/Control}')

    expect(screen.getByRole('button', { name: /search tokens/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })
})
