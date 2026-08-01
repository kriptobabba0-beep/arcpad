import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asHex } from '@/components/read/types'
import type { HexAddress, TokenOverview } from '@/components/read/types'
import type { SearchPayload } from '@/components/search/params'
import { SearchDialog } from '@/components/search/SearchDialog'
import { shortenAddress } from '@/components/ui/Address'
import { overview, PASTED_LOWER } from './fixtures'
import { toWire } from '@/components/read/wire'

/**
 * ⌘K MODALI.
 *
 * Yonlendirici sahtelenir cunku `next/navigation` bir App Router baglami
 * ister ve bir bilesen testinde o baglam yoktur. Sahtelenen sey NAVIGASYONUN
 * KENDISI degil, hedefi: `push`'un hangi adrese cagrildigi bir iddiadir.
 */
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigation.push }) }))

/**
 * UCU KONTROL EDILEN BIR `fetch`.
 *
 * Yaris testinin olcebilmesi icin yanitlarin NE ZAMAN dondugu testin elinde
 * olmali. Sahte ayrica GERCEK fetch gibi davranir: `signal` iptal edildiginde
 * soz REDDEDILIR. Bu ayrinti onemli -- iptali sessizce yutan bir sahte,
 * `AbortController`'i kaldiran mutanti hayatta birakirdi.
 */
type Pending = {
  readonly url: string
  aborted: boolean
  settle: (body: unknown) => void
}

let pending: Pending[] = []
let fetchMock: ReturnType<typeof vi.fn>

function installFetch() {
  pending = []
  fetchMock = vi.fn(
    (input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        const entry: Pending = {
          url: String(input),
          aborted: false,
          settle: (body) => resolve(Response.json(body)),
        }
        init?.signal?.addEventListener('abort', () => {
          entry.aborted = true
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        pending.push(entry)
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
}

function pendingAt(index: number): Pending {
  const entry = pending[index]
  if (!entry) throw new Error(`istek #${index} hic acilmadi`)
  return entry
}

/**
 * Sunucunun donecegi govde. `total` varsayilan olarak satir sayisidir.
 *
 * Satirlar TEL BICIMINDE gonderilir (`toWire`), cunku gercek route da oyle
 * gonderiyor: JSON'da `bigint` yoktur ve `Response.json()` bir bigint gorunce
 * ATAR. Fixture'i zengin tiple gondermek, uretimde var olmayan bir yolu test
 * etmek olurdu.
 */
function page(rows: readonly TokenOverview[], patch: Partial<SearchPayload> = {}): SearchPayload {
  return { rows: rows.map(toWire), nextCursor: null, shown: rows.length, pasted: null, ...patch }
}

const ALPHA = overview({
  token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Alpha',
  symbol: 'ALP',
})
const BETA = overview({
  token: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  name: 'Beta',
  symbol: 'BET',
})
const GAMMA = overview({
  token: '0xcccccccccccccccccccccccccccccccccccccccc',
  name: 'Gamma',
  symbol: 'GAM',
})

const noop = () => {}

/** Yaz, istegin acilmasini bekle, ve verilen govdeyle cevapla. */
async function searchFor(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
  body: unknown,
): Promise<void> {
  await user.type(screen.getByRole('combobox'), text)
  await waitFor(() => expect(pending).toHaveLength(1))
  await act(async () => {
    pendingAt(0).settle(body)
  })
}

beforeEach(() => {
  navigation.push.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('<SearchDialog> -- girdi, debounce, iptal', () => {
  it('acilista odak GIRDIYE gider -- panelde birakmak bir Tab borcu olurdu', async () => {
    render(<SearchDialog open onClose={noop} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox')))
  })

  it('bos `q` ile istek YOK ve "son bakilanlar" GOSTERILMEZ', async () => {
    render(<SearchDialog open onClose={noop} />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText(/type to search/i)).toBeVisible()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('250 ms debounce: dort tus vurusu TEK istek acar', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    await user.type(screen.getByRole('combobox'), 'doge')
    // Tus vurusunun hemen ardindan henuz hicbir sey ucusta degil.
    expect(fetchMock).not.toHaveBeenCalled()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(pendingAt(0).url).toContain('q=doge')
    expect(pendingAt(0).url).toContain('sort=relevance')
  })

  /**
   * MUTANT: `AbortController`'i kaldir.
   *
   * Iki sorgu, ilki GEC doner. Iptal olmadan gec yanit ekrandaki yeni
   * sonuclari ezer ve kullanici, yazdigi metinle hicbir ilgisi olmayan bir
   * listeye bakar -- sonra da yanlis token'a tiklar.
   */
  it('gec donen yanit YENISININ sonuclarini EZMEZ', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)
    const input = screen.getByRole('combobox')

    await user.type(input, 'aa')
    await waitFor(() => expect(pending).toHaveLength(1))

    await user.clear(input)
    await user.type(input, 'bb')
    await waitFor(() => expect(pending).toHaveLength(2))

    // Ucaki istek gercekten iptal edildi.
    expect(pendingAt(0).aborted).toBe(true)

    await act(async () => {
      pendingAt(1).settle(page([BETA]))
    })
    expect(await screen.findByText('Beta')).toBeVisible()

    // GEC DONEN yanit: iptal edilmis istegin sozu reddedilmis durumda.
    await act(async () => {
      pendingAt(0).settle(page([ALPHA]))
    })

    expect(screen.getByText('Beta')).toBeVisible()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('siralama degisince yeni istek acilir ve eskisi iptal edilir', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    await searchFor(user, 'doge', page([ALPHA]))
    await user.click(screen.getByRole('button', { name: 'Newest' }))

    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pendingAt(1).url).toContain('sort=newest')
  })
})

describe('<SearchDialog> -- listbox klavye deseni', () => {
  async function withResults(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)
    await searchFor(user, 'a', page([ALPHA, BETA, GAMMA]))
    return user
  }

  it('sonuclar bir listbox, satirlar option', async () => {
    await withResults()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  /**
   * MUTANT: `aria-activedescendant`'i kaldir.
   *
   * Odak GIRDIDE kalir; secimin nerede oldugunu ekran okuyucuya soyleyen tek
   * sey bu ozniteliktir. Kaldirildiginda gorsel vurgu yerinde durur ama
   * klavyeyle gezen bir kullanici icin secim diye bir sey yoktur.
   */
  it('ok tuslari secimi tasir ve `aria-activedescendant` onu izler', async () => {
    const user = await withResults()
    const input = screen.getByRole('combobox')
    const options = screen.getAllByRole('option')

    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[1]?.id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')

    await user.keyboard('{ArrowUp}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)

    // Uclarda sarilir: yirmi satirlik bir listede basa donmek tek tusa mal
    // olmali, yirmi tusa degil.
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveAttribute('aria-activedescendant', options[2]?.id)
  })

  it('Home ve End uclara gider', async () => {
    const user = await withResults()
    const input = screen.getByRole('combobox')
    const options = screen.getAllByRole('option')

    await user.keyboard('{End}')
    expect(input).toHaveAttribute('aria-activedescendant', options[2]?.id)

    await user.keyboard('{Home}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)
  })

  it('Enter secili satira gider ve modali kapatir', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SearchDialog open onClose={onClose} />)
    await searchFor(user, 'a', page([ALPHA, BETA, GAMMA]))

    await user.keyboard('{ArrowDown}{Enter}')

    expect(navigation.push).toHaveBeenCalledWith(`/token/${BETA.token}`)
    expect(onClose).toHaveBeenCalled()
  })

  it('sonuc sayisi `aria-live` ile duyurulur', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)
    await searchFor(user, 'a', page([ALPHA, BETA, GAMMA], { shown: 24 }))

    const status = screen.getByTestId('search-announcement')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('24 results')
  })

  /**
   * MUTANT: Esc dinleyicisini kaldir (`<Dialog>` icinde).
   *
   * Esc bu dosyada uygulanmiyor ama BU YUZEYDEN olculuyor: kullanicinin
   * gordugu sey ⌘K modalidir ve onun kapanmamasi, hangi dosyada kirildigindan
   * bagimsiz olarak bir hatadir.
   */
  it('Esc modali kapatir', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SearchDialog open onClose={onClose} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox')))

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('<SearchDialog> -- yapistirilan adres', () => {
  it('indekslenmis adres dogrudan tek sonuc olarak cizilir', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    await searchFor(
      user,
      PASTED_LOWER,
      page([ALPHA], { pasted: { kind: 'indexed', address: asHex(ALPHA.token) } }),
    )

    expect(screen.getByRole('option')).toHaveTextContent('Alpha')
  })

  it('kanonik ama indekslenmemis adres "Not indexed yet" ile cizilir', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    await searchFor(
      user,
      PASTED_LOWER,
      page([], { pasted: { kind: 'notIndexed', address: PASTED_LOWER } }),
    )

    const option = screen.getByRole('option')
    expect(option).toHaveTextContent('Not indexed yet')
    expect(option).toHaveTextContent(shortenAddress(PASTED_LOWER))

    await user.keyboard('{Enter}')
    expect(navigation.push).toHaveBeenCalledWith(`/token/${PASTED_LOWER}`)
  })

  /**
   * MUTANT: `forged` durumunda satiri normal ciz.
   *
   * Govde BILEREK dusmancadir: `rows` icinde gercek bir launch'in adi ve
   * sembolu duruyor. Sunucu boyle bir govde uretmez (bkz. route.test.tsx) --
   * bu test ISTEMCININ kendi kapisini olcuyor. Iki bagimsiz kapinin ayni anda
   * acilmasi gerekir ki sahte bir adres bir launch gibi gorunsun.
   */
  it('sahte adres BIR LAUNCH GIBI CIZILMEZ -- govdede satir olsa bile', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    const impostor = overview({ name: 'USD Coin', symbol: 'USDCX', token: PASTED_LOWER })
    await searchFor(
      user,
      PASTED_LOWER,
      page([impostor], {
        pasted: { kind: 'refused', address: PASTED_LOWER, canonicity: 'forged' },
      }),
    )

    // Iki kez: biri gorunur metin, biri `aria-live` duyurusu. Ret HEM okunur
    // HEM duyurulur -- yalnizca gorsel bir ret, klavye/ekran okuyucu
    // kullanicisi icin hic verilmemis bir rettir.
    expect(screen.getAllByText('This address is not an arcpad launch.')).toHaveLength(2)
    expect(screen.getByTestId('search-announcement')).toHaveTextContent(
      'This address is not an arcpad launch.',
    )
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // Isim ve sembol EKRANDA YOK: sahtekarligin isleyis bicimi tam olarak
    // gercek bir launch'in adini tasiyabilmesidir.
    expect(screen.queryByText('USD Coin')).not.toBeInTheDocument()
    expect(screen.queryByText('USDCX')).not.toBeInTheDocument()

    // Adres KISALTILMIS gosterilir.
    expect(screen.getByTitle(PASTED_LOWER)).toHaveTextContent(shortenAddress(PASTED_LOWER))
  })

  it('`unverifiable` de ayni retle karsilanir', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    await searchFor(
      user,
      PASTED_LOWER,
      page([], {
        pasted: { kind: 'refused', address: PASTED_LOWER, canonicity: 'unverifiable' },
      }),
    )

    expect(screen.getAllByText('This address is not an arcpad launch.')).toHaveLength(2)
  })
})

describe('<SearchDialog> -- bos durumlar ve dusus', () => {
  it('sonuc yoksa mesaj `q`yu tirnak icinde tekrarlar', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    await searchFor(user, 'zzz', page([]))

    expect(screen.getByText('No tokens match “zzz”.')).toBeVisible()
  })

  /**
   * BU DAL BUGUN CANLI YOLDUR: `components/read/boundary.ts` her okumaya
   * `unavailable` donuyor cunku Faz 3'un `queries.ts`'i depoda yok.
   */
  it('veritabani dustugunde acik mesaj cikar ve modal YINE kapanabilir', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SearchDialog open onClose={onClose} />)

    await searchFor(user, 'doge', { error: 'unavailable' })

    expect(screen.getByText(/search is unavailable right now/i)).toBeVisible()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('`Relevance` yalnizca `q` doluyken etkindir', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    expect(screen.getByRole('button', { name: 'Relevance' })).toBeDisabled()

    await user.type(screen.getByRole('combobox'), 'd')
    expect(screen.getByRole('button', { name: 'Relevance' })).toBeEnabled()
  })

  it('devami varsa "ilk N gosteriliyor" YAZILIR -- toplam iddia edilmez', async () => {
    const user = userEvent.setup()
    render(<SearchDialog open onClose={noop} />)

    await searchFor(user, 'a', page([ALPHA, BETA], { nextCursor: '41' }))

    expect(screen.getByText(/showing the first 2/i)).toBeVisible()
  })
})

/** Tip kapisi: fixture'lar gercekten `HexAddress` uretiyor mu. */
const _addresses: readonly HexAddress[] = [
  asHex(ALPHA.token),
  asHex(BETA.token),
  asHex(GAMMA.token),
  PASTED_LOWER,
]
void _addresses
