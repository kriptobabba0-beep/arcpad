/**
 * PINNING ISTEGE BAGLIDIR VE YAPILANDIRILMAMIS OLMASI BIR ARIZA DEGILDIR.
 *
 * arcpad'in launch akisi pinning olmadan da SONUNA KADAR calisir: kullanici
 * kendi `ipfs://…` URI'sini yapistirabilir, ya da hic URI vermeden launch
 * edebilir (`LaunchFactory.launch` yalnizca isim ve sembolun bos olmamasini
 * ister). Bu yuzden yapilandirilmamis kurulum bir hata ekrani degil, urunun o
 * kurulumdaki CALISMA BICIMIDIR -- ve rota bunu 501 ile soyler, 500 ile degil.
 */

export type PinningConfig = {
  readonly endpoint: string
  readonly token: string
}

/**
 * Indeks imzasi ZORUNLU, susleme degil: yalnizca iki opsiyonel alani olan bir
 * tip TS'in "weak type" kontroluna takilir ve `process.env` (`ProcessEnv`)
 * ona atanamaz -- "no properties in common" ile derleme durur.
 *
 * Bu iki degisken `NEXT_PUBLIC_*` DEGILDIR, yani `addresses.ts`teki literal
 * erisim kurali burada gecerli degil: Next onlari pakete gommez, sunucuda
 * gercek bir nesne olarak dururlar ve istek aninda okunabilirler.
 */
export type PinningEnv = {
  readonly ARCPAD_PIN_ENDPOINT?: string | undefined
  readonly ARCPAD_PIN_TOKEN?: string | undefined
  readonly [key: string]: string | undefined
}

/**
 * HTTP YALNIZCA LOOPBACK ICIN.
 *
 * Endpoint kullanici girdisi DEGILDIR, operatorun env'idir -- ama "bugun
 * kullanici girdisi degil" kodun degil kurulumun bir ozelligidir. Bu rota
 * sunucudan bir POST atar; env'e dusen bir
 * `http://169.254.169.254/latest/meta-data/` degeri onu bulut metadata
 * servisine dogrultulmus bir istek iletkenine cevirir. `https:` sarti bunu
 * ucuza kapatir; loopback istisnasi ise gercek bir kullanim icin durur (yerel
 * `kubo` 5001 portunda TLS konusmaz) ve ic aga cikmaz.
 */
function endpointIsAcceptable(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
}

/**
 * IKI DEGERDEN BIRI EKSIKSE YAPILANDIRILMAMISTIR. Endpoint var ama kabul
 * edilebilir degilse de AYNI cevap doner ve bu bilincli: cagiran taraf icin
 * "aramayacagim bir endpoint" ile "endpoint yok" ayni sey demektir -- ikisinde
 * de form URI yoluna duser. Fark sunucu gunlugundedir, yani operatorun
 * bakacagi yerde.
 */
export function readPinningConfig(env: PinningEnv = process.env): PinningConfig | null {
  const endpoint = env.ARCPAD_PIN_ENDPOINT?.trim() ?? ''
  const token = env.ARCPAD_PIN_TOKEN?.trim() ?? ''
  if (endpoint === '' || token === '') return null
  if (!endpointIsAcceptable(endpoint)) {
    console.error(
      `ARCPAD_PIN_ENDPOINT is ${JSON.stringify(endpoint)}, which this route refuses to call: ` +
        'only https:, or http: on loopback. Pinning is reported as not configured.',
    )
    return null
  }
  return { endpoint, token }
}

export function pinningIsConfigured(env: PinningEnv = process.env): boolean {
  return readPinningConfig(env) !== null
}
