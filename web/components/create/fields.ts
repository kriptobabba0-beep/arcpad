import {
  METADATA_LIMITS,
  type MetadataField,
  normaliseMetadataText,
  sanitiseForDisplay,
  utf8ByteLength,
} from '@arcpad/shared/browser'
import { DESCRIPTION_LIMIT } from '@/lib/metadataLimits'

/**
 * UC ALAN ZINCIRE GIDER, DORT ALAN GITMEZ.
 *
 * `LaunchFactory.launch(string name_, string symbol_, string uri_)` -- HEPSI
 * BU. Aciklama, gorsel, X ve Telegram zincirde YOKTUR; `uri`'nin gosterdigi
 * metadata JSON'unun icindedir. Formun bu ayrimi EKRANDA soylemesi bir suslama
 * degil: isim, sembol ve `uri` bir daha degistirilemez (`LaunchToken`'da
 * `metadataURI` icin bir setter YOKTUR, `name`/`symbol` ise ERC-20'nin
 * `immutable` benzeri sabitleri), oysa metadata dosyasinin ICERIGI pinlendigi
 * yerde degisebilir.
 */
export type LaunchFields = {
  readonly name: string
  readonly symbol: string
  readonly description: string
  /** Metadata JSON'unun `image` alani. Zincirde YOK. */
  readonly image: string
  readonly x: string
  readonly telegram: string
  /** ZINCIRE GIDEN metadata baglantisi. Bos dize MESRUDUR (bkz. Adim 3). */
  readonly uri: string
  /**
   * Creator-funded buyback: ucret gelirinin bir kismi ayrilip token geri
   * alimina harcanir ve alinan token bes yil kilitlenir.
   *
   * DOGRULANMAZ VE DOGRULANAMAZ. Ote uc alanin aksine bunun bir "gecersiz"
   * hali yoktur -- iki degeri de mesrudur. Hazinenin bagli olup olmadigi ise
   * ZINCIR DURUMUDUR; form onu bilemez, simulasyon bilir ve
   * `launch:BuybackUnavailable` olarak geri doner.
   */
  readonly buyback: boolean
}

export const EMPTY_FIELDS: LaunchFields = {
  // VARSAYILAN KAPALI. Buyback creator'in KENDI gelirini baglar ve
  // ciktisinin %30'u protokole gider; boyle bir tercih varsayilan olarak
  // ACIK gelemez -- kullanicinin bilerek isaretlemesi gerekir.
  buyback: false,
  name: '',
  symbol: '',
  description: '',
  image: '',
  x: '',
  telegram: '',
  uri: '',
}

/**
 * SAYAC ILE ZINCIRE GIDEN DIZE AYNI DIZEDIR.
 *
 * `utf8ByteLength(normaliseMetadataText(value))` -- iki cagri da zorunlu ve
 * her biri ayri bir hatayi kapatir:
 *
 *   - `utf8ByteLength` yerine `.length` yazmak UTF-16 kod birimi sayar.
 *     Olculdu: `"🚀".repeat(9)` icin `.length === 18` (sinirin altinda gorunur)
 *     ama zincirin gordugu `bytes(name_).length === 36`'dir ve `NameTooLong()`
 *     ile geri doner -- kullanici gazi odedikten SONRA.
 *   - `normaliseMetadataText` cagrilmazsa sayilan dize ile GONDERILEN dize
 *     ayrisir. Olculdu: NFD `"e" + U+0301` 3 bayt, NFC `"é"` 2 bayt. Ekranda
 *     ayni harf, zincirde farkli uzunluk.
 *
 * Bu fonksiyon TEK YERDIR: hem sayac hem gonderim kapisi bunu cagirir, yani
 * ikisinin ayrisma ihtimali yoktur.
 */
export function countBytes(value: string): number {
  return utf8ByteLength(normaliseMetadataText(value))
}

export type FieldState = {
  /** Normalize edilmis -- yani zincire GIDECEK -- dize. */
  readonly value: string
  readonly bytes: number
  readonly limit: number
  readonly empty: boolean
  readonly over: boolean
  /** Tam sinirda. Sayac burada `--color-accent` cizer. */
  readonly atLimit: boolean
}

export function fieldState(field: MetadataField, raw: string): FieldState {
  const value = normaliseMetadataText(raw)
  const bytes = countBytes(raw)
  const limit = METADATA_LIMITS[field]
  return { value, bytes, limit, empty: bytes === 0, over: bytes > limit, atLimit: bytes === limit }
}

/**
 * KARAKTER KISITI YOKTUR VE BU BILINCLIDIR.
 *
 * Zincir yalnizca bayt uzunlugu dayatir; `LaunchToken` ne alfabe ne de bosluk
 * kontrolu yapar. pons "Letters, numbers, and spaces" diyerek yazilabilecek
 * seyi daraltiyor -- arcpad daraltmaz ama GOSTERIMDE `sanitiseForDisplay`
 * uygular, yani onizleme karti kullanicinin ekranda gorecegi hâli gosterir.
 * Gorunmez karakterler ve bidi override'lari bir launchpad'de gercek bir
 * taklit yoludur; onlari yazmayi engellemek yerine ne gorunecegini DURUSTCE
 * gostermek dogru olan.
 */
export function displayName(raw: string): string {
  return sanitiseForDisplay(normaliseMetadataText(raw))
}

/**
 * ACIKLAMA BAYT DEGIL KARAKTER SAYAR, ve bu bir tutarsizlik degil bir
 * eslesmedir: aciklama zincire hic gitmez, onu KIRPACAK olan okuyucudur ve
 * `web/lib/metadata.ts` bunu `sanitiseForDisplay(value).slice(0, 256)` ile
 * yapar -- `.slice` UTF-16 kod birimi sayar. Burada bayt gostermek,
 * kullaniciya token sayfasinda gorecegi sayidan BASKA bir sayi vermek olurdu.
 */
export function descriptionState(raw: string): {
  readonly value: string
  readonly used: number
  readonly limit: number
  readonly over: boolean
} {
  const value = raw.trim()
  return {
    value,
    used: sanitiseForDisplay(value).length,
    limit: DESCRIPTION_LIMIT,
    over: sanitiseForDisplay(value).length > DESCRIPTION_LIMIT,
  }
}

/**
 * URI icin `https:` ve `ipfs:` DISINDA hicbir sey kabul edilmez.
 *
 * Zincir her dizeyi kabul eder -- kontrat yalnizca 200 bayt bakar. Ama bu URI
 * daha sonra SUNUCUDA cozulur (`web/lib/metadata.ts`) ve orada `data:`,
 * `file:`, `http:` ya da bir ic ag adresi bir SSRF yuzeyidir. Formda reddetmek
 * o yuzeyi kapatmaz (asil kapi `resolvableUrl`'dedir ve orada durur), ama
 * kullaniciya hicbir zaman cozulemeyecek bir URI'yi zincire yazdirmayi
 * engeller: `uri` degistirilemez, yani buradaki bir yanlis KALICIDIR.
 */
export function uriLooksResolvable(raw: string): boolean {
  const value = normaliseMetadataText(raw)
  if (value === '') return true
  return /^ipfs:\/\/./.test(value) || /^https:\/\/./.test(value)
}

export type LaunchArgs = {
  readonly name: string
  readonly symbol: string
  readonly uri: string
  readonly buyback: boolean
}

export type FieldErrors = {
  name?: string
  symbol?: string
  uri?: string
}

export type Validation =
  | { readonly ok: true; readonly args: LaunchArgs }
  | { readonly ok: false; readonly errors: FieldErrors }

/**
 * ISTEMCI DOGRULAMASI, SIMULASYONUN ONUNDEKI ILK KAPI.
 *
 * Kontratin gercekten dayattigi uc sey: `EmptyName`, `EmptySymbol` ve uc
 * uzunluk tavani. `uri` BOS OLABILIR ve bu bir kolaylik degil bir gercektir --
 * `LaunchFactory.launch` yalnizca isim ve sembolun bos olmamasini ister.
 */
export function validateLaunch(fields: LaunchFields): Validation {
  const name = fieldState('name', fields.name)
  const symbol = fieldState('symbol', fields.symbol)
  const uri = fieldState('uri', fields.uri)

  const errors: FieldErrors = {}
  if (name.empty) errors.name = 'A name is required.'
  else if (name.over) errors.name = `That name is ${name.bytes} bytes; the chain accepts 32.`
  if (symbol.empty) errors.symbol = 'A symbol is required.'
  else if (symbol.over)
    errors.symbol = `That symbol is ${symbol.bytes} bytes; the chain accepts 13.`
  if (uri.over) errors.uri = `That URI is ${uri.bytes} bytes; the chain accepts 200.`
  else if (!uriLooksResolvable(fields.uri)) {
    errors.uri = 'Use an ipfs:// or https:// URI, or leave it empty.'
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  // NORMALIZE EDILMIS degerler doner: olculen dize ile gonderilen dize ayni.
  return {
    ok: true,
    // `buyback` NORMALIZE EDILMEZ CUNKU EDILECEK BIR SEYI YOK: bir boolean'in
    // kirpilacak bosluğu ya da uzunluk siniri yoktur. Alan yine de BURADAN
    // gecer, dogrudan forma erisilerek degil -- `LaunchArgs` zincire gidenin
    // TEK kaynagi olmali.
    args: { name: name.value, symbol: symbol.value, uri: uri.value, buyback: fields.buyback },
  }
}

/**
 * Metadata JSON'u -- ANAHTAR SIRASI SABIT.
 *
 * Sira sabit cunku bu dizenin kendisi pinlenir ve icerigi degismedigi hâlde
 * anahtar sirasi degisirse CID degisir. Ayni forma iki kez ayni CID demek,
 * "yukledigim sey bu mu" sorusunu cevaplanabilir kilar.
 *
 * BOS ALANLAR HIC YAZILMAZ. `"x": ""` yazan bir dokuman, okuyan tarafa bos bir
 * baglanti VAAT eder; `web/lib/metadata.ts` onu zaten `undefined`'a dusurur ve
 * iki taraf arasinda gereksiz bir fark birakmanin degeri yok.
 */
export function buildMetadataJson(fields: LaunchFields): string {
  const name = normaliseMetadataText(fields.name)
  const symbol = normaliseMetadataText(fields.symbol)
  const doc: Record<string, string> = {}
  if (name !== '') doc.name = name
  if (symbol !== '') doc.symbol = symbol
  const description = fields.description.trim()
  if (description !== '') doc.description = description
  const image = fields.image.trim()
  if (image !== '') doc.image = image
  const x = fields.x.trim()
  if (x !== '') doc.x = x
  const telegram = fields.telegram.trim()
  if (telegram !== '') doc.telegram = telegram
  return JSON.stringify(doc)
}
