import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/metadata/route'
import { pinningIsConfigured, readPinningConfig } from '@/app/api/metadata/pinning'

/**
 * `/api/metadata` -- YAZMA ROTASI, VE PINNING ISTEGE BAGLIDIR.
 *
 * Testler `process.env`i degil, cagriya gecirilen `env` nesnesini kullanir
 * ("yapilandirma" testleri icin) ve rotanin kendisi icin `vi.stubEnv`. Ikisi
 * ayri, cunku rota `process.env`i CAGRI aninda okur -- modul yuklenirken
 * degil -- ve bu, bir kurulumun yeniden deploy olmadan yapilandirilabilmesi
 * demektir.
 */

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function form(fields: Record<string, string>, image?: Blob, filename = 'a.png'): Request {
  const body = new FormData()
  body.append('fields', JSON.stringify(fields))
  if (image) body.append('image', image, filename)
  return new Request('http://localhost/api/metadata', { method: 'POST', body })
}

/**
 * GERCEK PNG SIHIRLI BAYTLARI.
 *
 * Fixture eskiden `new Blob(['png'], { type: 'image/png' })` idi -- yani
 * ICERIK "png" HARFLERIYDI ve tur yalnizca BASLIKTA yaziyordu. Rota o basligi
 * okudugu surece test geciyordu; denetimde rota BAYTLARA cevrildi ve fixture
 * dustu. Dusmesi DOGRU: eski hali, "istemcinin soyledigi tur" ile "dosyanin
 * gercekten oldugu tur" arasindaki farki hic olcmuyordu.
 */
function pngBlob(): Blob {
  const bytes = new Uint8Array(32)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return new Blob([bytes], { type: 'image/png' })
}

describe('readPinningConfig', () => {
  it('iki degerden biri eksikse YAPILANDIRILMAMIS', () => {
    expect(readPinningConfig({})).toBeNull()
    expect(readPinningConfig({ ARCPAD_PIN_ENDPOINT: 'https://pin.example/add' })).toBeNull()
    expect(readPinningConfig({ ARCPAD_PIN_TOKEN: 'secret' })).toBeNull()
    // Bos dize "yapilandirilmamis"tir, "bos bir deger" degil: `.env.example`
    // bos gonderir.
    expect(readPinningConfig({ ARCPAD_PIN_ENDPOINT: '  ', ARCPAD_PIN_TOKEN: 's' })).toBeNull()
  })

  it('https gecer; loopback disinda http GECMEZ', () => {
    const token = 'secret'
    expect(
      readPinningConfig({
        ARCPAD_PIN_ENDPOINT: 'https://pin.example/add',
        ARCPAD_PIN_TOKEN: token,
      }),
    ).toEqual({
      endpoint: 'https://pin.example/add',
      token,
    })
    expect(
      readPinningConfig({
        ARCPAD_PIN_ENDPOINT: 'http://127.0.0.1:5001/api/v0/add',
        ARCPAD_PIN_TOKEN: token,
      }),
    ).not.toBeNull()

    /*
     * Endpoint kullanici girdisi degildir -- ama "bugun kullanici girdisi
     * degil" kodun degil KURULUMUN bir ozelligidir. Env'e dusen bir bulut
     * metadata adresi bu rotayi bir istek iletkenine cevirirdi.
     */
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      readPinningConfig({
        ARCPAD_PIN_ENDPOINT: 'http://169.254.169.254/latest/meta-data/',
        ARCPAD_PIN_TOKEN: token,
      }),
    ).toBeNull()
    expect(
      readPinningConfig({ ARCPAD_PIN_ENDPOINT: 'file:///etc/passwd', ARCPAD_PIN_TOKEN: token }),
    ).toBeNull()
  })
})

describe('POST /api/metadata', () => {
  it('YAPILANDIRILMAMIS -> 501 { error: "pinningNotConfigured" }', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', '')
    vi.stubEnv('ARCPAD_PIN_TOKEN', '')
    expect(pinningIsConfigured({})).toBe(false)

    const response = await POST(form({ name: 'Diffusion', symbol: 'DIFF' }))
    /*
     * 501 "Not Implemented". 503 "gecici olarak yok" derdi ve istemciyi
     * yeniden denemeye cagirirdi; 500 bir ariza oldugunu soylerdi. Ikisi de
     * yanlis: bozulan bir sey yok, YAPILANDIRILMAMIS bir sey var ve formun
     * yapmasi gereken tek sey URI yoluna dusmek.
     */
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: 'pinningNotConfigured' })
  })

  it('yapilandirilmisken JSON pinlenir ve `ipfs://<cid>` doner', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', 'https://pin.example/add')
    vi.stubEnv('ARCPAD_PIN_TOKEN', 'secret')
    const fetchMock = vi.fn(async () => Response.json({ cid: CID }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(form({ name: 'Diffusion', symbol: 'DIFF', description: 'Hi' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ uri: `ipfs://${CID}` })

    // Gorsel yoksa TEK yukleme yapilir.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gorsel varsa IKI yukleme yapilir ve JSON gorselin CID’ini tasir', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', 'https://pin.example/add')
    vi.stubEnv('ARCPAD_PIN_TOKEN', 'secret')
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const part = (init.body as FormData).get('file')
      bodies.push(part instanceof Blob ? await part.text() : '')
      return Response.json({ IpfsHash: CID })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(form({ name: 'Diffusion', symbol: 'DIFF' }, pngBlob()))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ uri: `ipfs://${CID}`, image: `ipfs://${CID}` })

    // SIRA BAGLAYICI: once gorsel, sonra JSON -- JSON'un `image` alani
    // gorselin CID'ini tasimak zorunda oldugu icin ters sira mumkun degil.
    //
    // ILK GOVDE GORSELIN KENDISIDIR. Fixture artik GERCEK PNG imzasi tasiyor;
    // eskiden govde "png" HARFLERIYDI ve tur yalnizca BASLIKTA yaziyordu --
    // yani test, rota istemcinin sozune baktigi surece geciyordu.
    //
    // `0x89` baytı metin olarak okundugunda kayboluyor (U+FFFD), bu yuzden
    // imzanin ASCII yarisi (`PNG`) aranir; JSON govdesi onu tasimaz.
    expect(bodies[0], 'ilk yuklenen sey gorsel degil').toContain('PNG')
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({
      name: 'Diffusion',
      symbol: 'DIFF',
      image: `ipfs://${CID}`,
    })
  })

  it('istemcinin gonderdigi `image`/`uri` alanlari YOK SAYILIR', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', 'https://pin.example/add')
    vi.stubEnv('ARCPAD_PIN_TOKEN', 'secret')
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const part = (init.body as FormData).get('file')
        bodies.push(part instanceof Blob ? await part.text() : '')
        return Response.json({ cid: CID })
      }),
    )

    await POST(
      form({
        name: 'Diffusion',
        symbol: 'DIFF',
        image: 'https://attacker.example/pixel.gif',
        uri: 'ipfs://whatever',
      }),
    )
    // Gecirilseydi, dokumana rastgele bir URL yazdirmanin yolu olurdu.
    expect(bodies[0]).not.toContain('attacker.example')
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ name: 'Diffusion', symbol: 'DIFF' })
  })

  it('COZULEMEYECEK bir CID basari sayilmaz', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', 'https://pin.example/add')
    vi.stubEnv('ARCPAD_PIN_TOKEN', 'secret')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ cid: 'not-a-cid' })),
    )

    /*
     * Donen URI'yi ZINCIRE yazacagiz ve `uri` DEGISTIRILEMEZ. Okuma tarafinin
     * (`web/lib/metadata.ts`) cozemeyecegi bir CID'i basari saymak,
     * kullaniciya kalici olarak olu bir baglanti vermek olurdu.
     */
    const response = await POST(form({ name: 'Diffusion', symbol: 'DIFF' }))
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'pinningFailed' })
  })

  it('5 MB ustu gorsel 413, izin verilmeyen tur 415', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', 'https://pin.example/add')
    vi.stubEnv('ARCPAD_PIN_TOKEN', 'secret')
    const fetchMock = vi.fn(async () => Response.json({ cid: CID }))
    vi.stubGlobal('fetch', fetchMock)

    const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' })
    expect((await POST(form({ name: 'D', symbol: 'D' }, big))).status).toBe(413)

    // SVG betik calistirabilen bir dokumandir ve pinlenen dosyanin gateway
    // URL'i dogrudan da acilabilir.
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' })
    expect((await POST(form({ name: 'D', symbol: 'D' }, svg))).status).toBe(415)

    // Reddedilen hicbir dosya icin saglayiciya gidilmedi.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('saglayici dusunce 502 doner ve istemci dosyayi kaybetmez', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', 'https://pin.example/add')
    vi.stubEnv('ARCPAD_PIN_TOKEN', 'secret')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )

    const response = await POST(form({ name: 'Diffusion', symbol: 'DIFF' }))
    expect(response.status).toBe(502)
  })

  it('multipart olmayan govde 400', async () => {
    vi.stubEnv('ARCPAD_PIN_ENDPOINT', 'https://pin.example/add')
    vi.stubEnv('ARCPAD_PIN_TOKEN', 'secret')
    const response = await POST(
      new Request('http://localhost/api/metadata', { method: 'POST', body: 'not-a-form' }),
    )
    expect(response.status).toBe(400)
  })
})
