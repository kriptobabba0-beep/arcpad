import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchBar } from '@/components/layout/SearchBar'

/**
 * TETIKLEYICI + MODAL, BIRLIKTE.
 *
 * Iki parca ayri ayri yesil olup BIRLIKTE olu olabilir: `<SearchTrigger>`
 * `renderDialog` verilmediginde de cizilir ve kisayol yine calisir (kendi
 * testi bunu acikca iddia ediyor), `<SearchDialog>` de `open` prop'uyla tek
 * basina olculuyor. Yani `SearchBar` ikisini baglamayi birakirsa her iki
 * dosyanin testi de gecmeye devam eder. Kopuklugu goren tek sey burasi.
 *
 * Test `web/components/layout/SearchBar.tsx`'i olcuyor -- bu gorevin yazma
 * izninde olmayan ama `<SearchDialog open onClose>`'u tuketen dosya. Kapsam
 * sinirinin iki tarafa da bakmasi bilincli: sozlesmeyi tanimlayan taraf
 * onun TUTULDUGUNU da gostermeli.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('<SearchBar>', () => {
  it('Ctrl+K modali acar ve odak arama girdisine gider', async () => {
    const user = userEvent.setup()
    render(<SearchBar />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.keyboard('{Control>}k{/Control}')

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Search')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox')))
  })

  it('⌘K de acar ve Esc kapatir', async () => {
    const user = userEvent.setup()
    render(<SearchBar />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox')))

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('gorunur butona tiklamak da acar, ve kapanista odak ONA geri doner', async () => {
    const user = userEvent.setup()
    render(<SearchBar />)
    const trigger = screen.getByRole('button', { name: 'Search tokens' })

    await user.click(trigger)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Bos kutu artik oneri listesini getiriyor; modalin ACILDIGINI kanitlayan
    // sey o listenin basligi.
    expect(await screen.findByText(/by 24h volume/i)).toBeVisible()

    await user.keyboard('{Escape}')

    /*
     * Odak ACAN OGEYE doner. Bu YALNIZCA tiklama yolunda iddia edilebilir:
     * ⌘K ile acildiginda acilis anindaki `document.activeElement` <body>'dir
     * (kullanici hicbir seye odaklanmamisti), dolayisiyla `<Dialog>`'un geri
     * verecegi bir oge yoktur. Kisayol yolunda buton beklemek, testin
     * uygulamayla degil kendi varsayimiyla kavga etmesi olurdu.
     */
    expect(document.activeElement).toBe(trigger)
  })
})
