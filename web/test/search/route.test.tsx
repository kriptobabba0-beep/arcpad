import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchPayload } from '@/components/search/params'
import { LIVE_INDEXER } from '../fixtures/readModel'
import { overview, PASTED, PASTED_LOWER } from './fixtures'

/**
 * `GET /api/search` -- OKUMA SINIRI SAHTELENIR, ROTA SAHTELENMEZ.
 *
 * Sinir UC AYRI MODULE dagildi: `readSearch` hâlâ bir stub
 * (`components/search/searchBoundary.ts` -- `searchTokens` `packages/db`'ye
 * inmedi), `readTokenOverview` gercek `web/lib/read.ts`'te, `verifyCanonical`
 * `web/lib/canonical.ts`'te. Ucu de burada sahtelenir cunku olculen sey
 * ROTANIN KENDISIDIR: beyaz liste, adres dali, parametre baglama.
 *
 * `valueOf` SAHTELENMEZ -- `ReadResult`'in uc dalini cozen gercek fonksiyon
 * kosar, yani bayat bir sonucun da dogru gectigi bu testlerle olculur.
 */
const boundary = vi.hoisted(() => ({
  readSearch: vi.fn(),
  readTokenOverview: vi.fn(),
  verifyCanonical: vi.fn(),
}))

vi.mock('@/components/search/searchBoundary', () => ({ readSearch: boundary.readSearch }))
vi.mock('@/lib/canonical', () => ({ verifyCanonical: boundary.verifyCanonical }))
vi.mock('@/lib/read', async () => {
  const actual = await vi.importActual<typeof import('@/lib/read')>('@/lib/read')
  return { ...actual, readTokenOverview: boundary.readTokenOverview }
})

const { GET } = await import('@/app/api/search/route')

function request(query: string): Request {
  return new Request(`http://localhost:3000/api/search${query}`)
}

async function payload(response: Response): Promise<SearchPayload> {
  return (await response.json()) as SearchPayload
}

/** `readSearch`'e giden params nesnesi. Testler bunun UZERINDE iddia eder. */
function searchParams(): Record<string, unknown> {
  const call = boundary.readSearch.mock.calls[0]
  expect(call).toBeDefined()
  return call?.[0] as Record<string, unknown>
}

const EMPTY_PAGE = { ok: true, data: { rows: [], nextCursor: null, shown: 0 } } as const

beforeEach(() => {
  boundary.readSearch.mockReset()
  boundary.readTokenOverview.mockReset()
  boundary.verifyCanonical.mockReset()
  boundary.readSearch.mockResolvedValue(EMPTY_PAGE)
  boundary.readTokenOverview.mockResolvedValue({ ok: false, reason: 'notFound' })
  boundary.verifyCanonical.mockResolvedValue('unverifiable')
})

describe('GET /api/search -- parametre baglama', () => {
  /**
   * MUTANT: `q`'yu SQL'e string olarak gom.
   *
   * Bu testin oldurdugu sey, `q`'nun DIZEYE DOKUNULMADAN gecmesidir. Bir
   * mutant onu kacislarsa, `%…%` ile sararsa, tirnaklarsa ya da hazir bir
   * ifadeye yapistirip fazladan bir alan gonderirse iki iddiadan biri duser:
   * degerin kendisi ya da params nesnesinin ALAN KUMESI.
   */
  it("`'; DROP TABLE launches; --` bir DEGER olarak gecer, bir ifade olarak degil", async () => {
    const hostile = "'; DROP TABLE launches; --"
    await GET(request(`?q=${encodeURIComponent(hostile)}`))

    const params = searchParams()
    expect(params.q).toBe(hostile)

    // Rota bir SORGU KURMAZ: gonderdigi sey bes anahtarli bir params
    // nesnesidir ve icinde SQL tasiyacak bir alan yoktur.
    expect(Object.keys(params).sort()).toEqual(['ageDays', 'cursor', 'limit', 'q', 'sort'])
    expect(JSON.stringify(params)).not.toMatch(/select|where|ilike|like/i)
  })

  it('`sort` beyaz listeden cozulur; taninmayan deger sessizce varsayilana duser', async () => {
    await GET(request('?q=doge&sort=market_cap%3B%20DROP'))
    expect(searchParams().sort).toBe('relevance')
  })

  it('`limit` URL`den OKUNMAZ -- sinirsiz sayfa bir ucuz DoS kolu olurdu', async () => {
    await GET(request('?q=doge&limit=100000'))
    expect(searchParams().limit).toBe(20)
  })

  it('`after` yalnizca ondalik basamaklardan olusuyorsa gecer', async () => {
    await GET(request('?q=doge&after=abc'))
    expect(searchParams().cursor).toBeNull()

    boundary.readSearch.mockClear()
    await GET(request('?q=doge&after=4210'))
    expect(searchParams().cursor).toBe('4210')
  })

  it('`age` gun sayisina cozulur; All -> null', async () => {
    await GET(request('?q=doge&age=1'))
    expect(searchParams().ageDays).toBe(1)

    boundary.readSearch.mockClear()
    await GET(request('?q=doge&age=all'))
    expect(searchParams().ageDays).toBeNull()

    boundary.readSearch.mockClear()
    await GET(request('?q=doge&age=99'))
    expect(searchParams().ageDays).toBeNull()
  })

  it('`q` 128 karakterde kesilir -- baglama enjeksiyonu keser, MALIYETI kesmez', async () => {
    await GET(request(`?q=${'a'.repeat(500)}`))
    expect(String(searchParams().q)).toHaveLength(128)
  })
})

describe('GET /api/search -- `relevance` yalnizca `q` doluyken', () => {
  it('dolu `q` ile `relevance` gecer', async () => {
    await GET(request('?q=doge&sort=relevance'))
    expect(searchParams().sort).toBe('relevance')
  })

  /** Bos bir sorguda siralanacak bir "alaka" yoktur. */
  it('bos `q` ile `relevance` SECILEMEZ -- `recentBuys`a duser', async () => {
    await GET(request('?q=&sort=relevance'))
    expect(searchParams().sort).toBe('recentBuys')
  })

  it('yalnizca bosluktan olusan `q` de bos sayilir', async () => {
    await GET(request('?q=%20%20&sort=relevance'))
    expect(searchParams().sort).toBe('recentBuys')
    expect(searchParams().q).toBe('')
  })

  it('bos `q` ile beyaz listedeki BASKA bir siralama korunur', async () => {
    await GET(request('?q=&sort=newest'))
    expect(searchParams().sort).toBe('newest')
  })
})

describe('GET /api/search -- yapistirilan adres', () => {
  /**
   * MUTANT: adres yolunu kaldir (adresi metin gibi ara).
   *
   * Mutant altinda `readSearch` cagrilir ve `readTokenOverview` cagrilmaz;
   * iki iddia da duser. Adresi metin gibi aramak yalnizca bos sonuc uretmez,
   * daha kotusunu uretir: adresi ADINDA gecen bir taklidi bulabilir.
   */
  it('adres METIN GIBI ARANMAZ -- satir dogrudan cozulur', async () => {
    boundary.readTokenOverview.mockResolvedValue({ ok: true, data: overview() })

    const body = await payload(await GET(request(`?q=${PASTED}`)))

    expect(boundary.readSearch).not.toHaveBeenCalled()
    expect(boundary.readTokenOverview).toHaveBeenCalledWith(PASTED_LOWER)
    expect(body.rows).toHaveLength(1)
    expect(body.pasted).toEqual({ kind: 'indexed', address: PASTED_LOWER })
  })

  /**
   * Veritabanindaki her satir `Launched`tan gelir ve `Launched` yalnizca
   * `LaunchFactory` tarafindan yayilabilir. Ikinci bir eth_call ayni gercegi
   * dugumun gazi pahasina sorardi.
   */
  it('satir bulunduysa `verifyCanonical` HIC cagrilmaz', async () => {
    boundary.readTokenOverview.mockResolvedValue({ ok: true, data: overview() })
    await GET(request(`?q=${PASTED}`))
    expect(boundary.verifyCanonical).not.toHaveBeenCalled()
  })

  it('satir yok + `canonical` -> "not indexed yet" hukmu, satir YOK', async () => {
    boundary.verifyCanonical.mockResolvedValue('canonical')

    const body = await payload(await GET(request(`?q=${PASTED}`)))

    expect(body.pasted).toEqual({ kind: 'notIndexed', address: PASTED_LOWER })
    expect(body.rows).toEqual([])
  })

  /**
   * MUTANT: `forged` durumunda satiri normal ciz.
   *
   * Bu testin oldurdugu sey, yanitin o dalda CIZILECEK HICBIR SEY
   * TASIMAMASIDIR. Alan kumesi birebir iddia ediliyor: mutant satiri, adi ya
   * da sembolu govdeye koydugu anda `toEqual` duser.
   */
  it('`forged` -> govdede isim/sembol/satir YOKTUR, yalnizca adres', async () => {
    boundary.verifyCanonical.mockResolvedValue('forged')

    const body = await payload(await GET(request(`?q=${PASTED}`)))

    expect(body).toEqual({
      rows: [],
      nextCursor: null,
      shown: 0,
      pasted: { kind: 'refused', address: PASTED_LOWER, canonicity: 'forged' },
    })
    expect(JSON.stringify(body)).not.toContain('DOGEARC')
  })

  /** Uc degerli kanoniklikte ikisi AYNI ekrana gider (bkz. `read/types.ts`). */
  it('`unverifiable` da ayni retle sonuclanir', async () => {
    boundary.verifyCanonical.mockResolvedValue('unverifiable')

    const body = await payload(await GET(request(`?q=${PASTED}`)))

    expect(body.pasted).toEqual({
      kind: 'refused',
      address: PASTED_LOWER,
      canonicity: 'unverifiable',
    })
  })

  /**
   * `verifyCanonical` bir eth_call'dir; veritabanina ihtiyaci YOKTUR. Dusen
   * bir veritabani yuzunden hukmu vermemek, yapistirilan bir adres hakkinda
   * soyleyebilecegimiz TEK guvenlik ifadesini dususle birlikte kaybetmek
   * olurdu.
   */
  it('veritabani dustugunde bile kanoniklik ZINCIRDEN sorulur', async () => {
    boundary.readTokenOverview.mockResolvedValue({ ok: false, reason: 'unavailable' })
    boundary.verifyCanonical.mockResolvedValue('canonical')

    const body = await payload(await GET(request(`?q=${PASTED}`)))

    expect(boundary.verifyCanonical).toHaveBeenCalledWith(PASTED_LOWER)
    expect(body.pasted).toEqual({ kind: 'notIndexed', address: PASTED_LOWER })
  })

  it('adres kucuk harfe cevrilir -- defter kucuk harf tutuyor', async () => {
    await GET(request(`?q=%20${PASTED}%20`))
    expect(boundary.readTokenOverview).toHaveBeenCalledWith(PASTED_LOWER)
  })

  it('39 haneli bir dize adres DEGILDIR ve metin gibi aranir', async () => {
    await GET(request('?q=0x1234'))
    expect(boundary.readSearch).toHaveBeenCalledTimes(1)
    expect(boundary.readTokenOverview).not.toHaveBeenCalled()
  })
})

describe('GET /api/search -- dusus', () => {
  it('`unavailable` -> 503 ve `{ error: "unavailable" }`', async () => {
    boundary.readSearch.mockResolvedValue({ ok: false, reason: 'unavailable' })

    const response = await GET(request('?q=doge'))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  })

  /** "Hicbir sey bulunamadi" bos bir sayfadir, dusmus bir veritabani degil. */
  it('`notFound` bir HATA DEGIL, bos bir sayfadir', async () => {
    boundary.readSearch.mockResolvedValue({ ok: false, reason: 'notFound' })

    const response = await GET(request('?q=doge'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rows: [], nextCursor: null, shown: 0, pasted: null })
  })

  it('basarili sayfa `rows`/`nextCursor`/`total` olarak gecer', async () => {
    boundary.readSearch.mockResolvedValue({
      ok: true,
      stale: false,
      indexer: LIVE_INDEXER,
      data: { rows: [overview()], nextCursor: '41' },
    })

    const body = await payload(await GET(request('?q=doge')))

    expect(body.rows).toHaveLength(1)
    expect(body.nextCursor).toBe('41')
    // `shown` BU SAYFADAKI satir sayisidir, toplam degil -- Faz 3'un
    // `Page<T>`'si toplam vermiyor ve uydurmak yerine adi degistirildi.
    expect(body.shown).toBe(1)
    expect(body.pasted).toBeNull()
  })
})
