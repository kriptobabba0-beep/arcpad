import { buildMetadataJson, EMPTY_FIELDS, type LaunchFields } from '@/components/create/fields'
import { resolvableUrl } from '@/lib/metadata'
import { readPinningConfig } from './pinning'

/**
 * =========================================================================
 *  YAZMA ROTASI. §6.3'E UYAR: BURADA `GET` YOKTUR.
 * =========================================================================
 *
 * Okuma yolunun tamami server component'lerden gecer; bu rota bir sey OKUMAZ,
 * bir sey YUKLER. Tarayicidan bir pinning saglayicisina dogrudan yuklemek
 * yerine sunucudan gecmesinin tek sebebi `ARCPAD_PIN_TOKEN`: istemciye
 * verilen bir pinning anahtari, herkesin bizim hesabimiza dosya pinlemesi
 * demektir.
 *
 * KULLANICININ VERDIGI HICBIR URL BURADAN CAGRILMAZ. Yalnizca operatorun
 * env'indeki endpoint cagrilir (`pinning.ts` onu ayrica suzer). Kullanicinin
 * yapistirdigi `uri` bu rotaya hic ugramaz; onu cozen `web/lib/metadata.ts`
 * ve orada `resolvableUrl` izin listesi durur.
 */

/** `fetch` ve `formData` node runtime'i ister; edge'de dosya sinirlari farklidir. */
export const runtime = 'nodejs'

/** Yapilandirma istek aninda okunur: build aninda pinlenmis bir cevap yanlis olurdu. */
export const dynamic = 'force-dynamic'

/**
 * 5 MiB. Bir launch gorseli 1:1 bir kutuda 40-320 px arasinda cizilir
 * (`TokenArtwork`); bunun uzerindeki her bayt, kimsenin gormeyecegi cozunurluk
 * icin BIZIM pinning kotamizdan harcanir.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * `image/svg+xml` YOKTUR VE EKLENMEYECEK. SVG betik calistirabilen bir
 * dokumandir; `<img>` icinde zararsizdir ama pinlenen dosyanin gateway
 * URL'i dogrudan da acilabilir ve orada bir HTML dokumani gibi davranir.
 */
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

type PinResponse = { readonly uri: string; readonly image?: string }

function json(body: unknown, status: number): Response {
  return Response.json(body, { status })
}

/**
 * Saglayicinin cevabindan CID'i cikarir.
 *
 * UC ANAHTAR: `cid` (kubo `/api/v0/add` --cid-version 1 ve cogu modern
 * saglayici), `Hash` (kubo'nun klasik cevabi), `IpfsHash` (Pinata). Bu uclu
 * bir tahmin degil, desteklenen sozlesmenin TAMAMI -- ve baska bir sey donen
 * bir saglayici sessizce degil GURULTULU bicimde reddedilir.
 */
function cidFrom(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const doc = payload as Record<string, unknown>
  for (const key of ['cid', 'Hash', 'IpfsHash']) {
    const value = doc[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Tek bir yukleme. DONEN URI'NIN COZULEBILIR OLDUGU BURADA GARANTI EDILIR.
 *
 * `resolvableUrl` okuma tarafinin izin listesidir. Yuklemenin dondugu CID o
 * listeden gecmiyorsa pinleme BASARISIZ sayilir -- cunku basarili saymak,
 * kullaniciya zincire yazacagi ve token sayfasinin hicbir zaman
 * cozemeyecegi bir URI vermek olurdu. `uri` degistirilemez; buradaki bir
 * yanlis KALICIDIR.
 */
async function pinOne(
  config: { endpoint: string; token: string },
  part: Blob,
  filename: string,
): Promise<string | null> {
  const body = new FormData()
  body.append('file', part, filename)

  let response: Response
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    console.error('pinning request failed', error)
    return null
  }
  if (!response.ok) {
    console.error(`pinning provider answered ${response.status}`)
    return null
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    console.error('pinning provider did not answer with JSON')
    return null
  }

  const cid = cidFrom(payload)
  if (cid === null) {
    console.error('pinning provider answered without a cid/Hash/IpfsHash field')
    return null
  }

  const uri = `ipfs://${cid}`
  if (resolvableUrl(uri) === null) {
    console.error(`pinning provider returned ${JSON.stringify(cid)}, which is not a resolvable CID`)
    return null
  }
  return uri
}

function fieldsFrom(raw: unknown): LaunchFields {
  if (typeof raw !== 'string') return EMPTY_FIELDS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_FIELDS
  }
  if (parsed === null || typeof parsed !== 'object') return EMPTY_FIELDS
  const doc = parsed as Record<string, unknown>
  const str = (key: keyof LaunchFields): string =>
    typeof doc[key] === 'string' ? (doc[key] as string) : ''
  return {
    name: str('name'),
    symbol: str('symbol'),
    description: str('description'),
    // `image` ve `uri` ISTEMCIDEN ALINMAZ: ikisi de bu rotanin URETTIGI
    // degerlerdir. Gelen bir `image` alanini gecirmek, dokumana rastgele bir
    // URL yazdirmanin yolu olurdu.
    image: '',
    x: str('x'),
    telegram: str('telegram'),
    uri: '',
  }
}

export async function POST(request: Request): Promise<Response> {
  const config = readPinningConfig()
  /*
   * 501, "Not Implemented". Dogru kod bu: sunucu istegin YONTEMINI bu
   * kurulumda desteklemiyor. 503 "gecici olarak yok" derdi ve istemciyi
   * yeniden denemeye cagirirdi; 500 bir ariza oldugunu soylerdi. Ikisi de
   * yanlis: burada bozulan bir sey yok, yapilandirilmamis bir sey var ve
   * formun yapmasi gereken tek sey URI yoluna dusmek.
   */
  if (config === null) return json({ error: 'pinningNotConfigured' }, 501)

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json({ error: 'badRequest' }, 400)
  }

  const fields = fieldsFrom(form.get('fields'))
  const file = form.get('image')

  let image: string | undefined
  if (file instanceof Blob && file.size > 0) {
    if (file.size > MAX_IMAGE_BYTES) return json({ error: 'imageTooLarge' }, 413)
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) return json({ error: 'imageTypeNotAllowed' }, 415)

    const pinned = await pinOne(config, file, 'artwork')
    if (pinned === null) return json({ error: 'pinningFailed' }, 502)
    image = pinned
  }

  /*
   * IKI YUKLEME, SIRAYLA VE BU SIRAYLA: once gorsel, sonra JSON. JSON'un
   * `image` alani gorselin CID'ini TASIMAK ZORUNDA, dolayisiyla ters sira
   * mumkun degil. Gorsel pinlenip JSON pinlenemezse cevap 502'dir ve form
   * dosyayi kaybetmez -- yalnizca ikinci adim tekrarlanir.
   */
  const document = buildMetadataJson({ ...fields, ...(image === undefined ? {} : { image }) })
  const uri = await pinOne(
    config,
    new Blob([document], { type: 'application/json' }),
    'metadata.json',
  )
  if (uri === null) return json({ error: 'pinningFailed' }, 502)

  const body: PinResponse = { uri, ...(image === undefined ? {} : { image }) }
  return json(body, 200)
}
