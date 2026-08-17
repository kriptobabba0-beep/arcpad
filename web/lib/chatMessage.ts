import { recoverMessageAddress } from 'viem'

/**
 * ==========================================================================
 *  CHAT'IN KIMLIK DOGRULAMASI. BIR ADRES BIR IDDIADIR, BIR DELIL DEGIL.
 * ==========================================================================
 *
 * Bir POST govdesindeki `author: 0x...` alani, gonderenin o adres oldugunu
 * SOYLEMEZ; yalnizca oyle YAZILDIGINI soyler. Bu urunun bir hesabi, bir
 * oturumu ya da bir cerezi yok -- olan tek sey bir cuzdan, ve bir cuzdanin
 * kanitlayabilecegi tek sey bir IMZADIR.
 *
 * SECILEN SEMA: EIP-191 `personal_sign`, kanonik bir metin uzerinde.
 *
 *   - EIP-712 DEGIL, ve sebebi olculebilir bir sey: EIP-712 kazanci
 *     "cuzdanda okunabilir alanlar" ve bir `domain` ayrimidir. Buradaki metin
 *     zaten dogrudan okunabilir -- kullanici tam olarak yazdigi cumleyi
 *     goruyor -- ve `domain`in tasidigi iki bilgi (chainId, uygulama)
 *     metnin ICINE zaten yazili. Ustune EIP-712, imzalanan seyi kullanici
 *     icin daha OKUNMAZ yapardi (typed-data ekranlari govdeyi bir alan
 *     etiketinin arkasina koyar).
 *   - SIWE DEGIL: SIWE bir OTURUM kurar. Burada oturum ISTENMEZ -- bir
 *     oturum belirteci, calindiginda gonderenin butun gelecek mesajlarini
 *     yazabilir. Her mesaj KENDI imzasini tasir, yani bir imzanin sizmasi
 *     yalnizca O mesaji tekrar oynatabilir, ve o da asagidaki iki katmanla
 *     kapali.
 *
 * ==========================================================================
 *  TEKRAR OYNATMA: BIR IMZA SONSUZA KADAR GECERLIDIR
 * ==========================================================================
 *
 * Kurtarma (recover) saf matematiktir ve zaman kavrami YOKTUR: bugun gecerli
 * olan bir imza on yil sonra da gecerlidir, ve mesaji goren HERKES imzayi da
 * gorur (satirla birlikte saklaniyor). Yani "imza dogrulandi" tek basina
 * hicbir sey ifade etmez. Uc bagimsiz sey birlikte kapatir:
 *
 *   1. NONCE, metnin ICINDE, ve `chat_messages.nonce_hex` UNIQUE. Yakalanan
 *      bir (govde, imza, nonce) ucluunun ikinci kez yazilmasi 23505 verir.
 *      Nonce imzalanan metnin parcasi oldugu icin saldirgan onu degistirip
 *      imzayi koruyamaz.
 *   2. `issued` PENCERESI. Veritabani bir gun sifirlanirsa (1) sifirlanir;
 *      pencere sifirlanmaz. Bes dakikadan eski bir imza kabul edilmez.
 *   3. `chain` VE `token` metnin icinde. Bir imza baska bir agda ya da baska
 *      bir token'in altinda YENIDEN KULLANILAMAZ -- metin degisir, imza
 *      dusmez.
 *
 * ==========================================================================
 *  METIN NEDEN BOYLE SIRALI: `body` EN SONDA
 * ==========================================================================
 *
 * Sunucu metni KENDI kurar (alanlardan) ve imzanin o metinden `author`i
 * verdigini kontrol eder. Yani tehlike, IKI FARKLI alan kumesinin AYNI metni
 * uretmesidir -- o zaman bir kumeye alinan imza otekine gecerdi.
 *
 * `body` en sonda ve metnin GERI KALANININ TAMAMI oldugu icin esleme
 * BIREBIRDIR: onceki bes alanin hepsi sabit bicimlidir (ondalik sayi, iki
 * adres, 32 baytlik hex, milisaniyeli ISO damgasi), yani ayrıştırma
 * belirsizligi yoktur ve govdenin icine ne yazilirsa yazilsin bir onceki
 * alanin sinirini kaydiramaz. `body` ORTADA olsaydi, icine `\nnonce: 0x…`
 * yazan bir govde ikinci bir okuma uretebilirdi.
 */

export const CHAT_MESSAGE_HEADER = 'arcpad chat'

/** Imzanin YASI icin ust sinir. Bes dakika: cuzdan onayı insan hizindadir. */
export const CHAT_SIGNATURE_TTL_SECONDS = 300

/**
 * GELECEGE TOLERANS. Sifir olamaz: istemcinin saati sunucununkinden birkac
 * saniye ileri olabilir ve o kullanici HICBIR mesaj gonderemezdi. Bir dakika,
 * ve daha fazlasi tekrar oynatma penceresini bedavaya buyuturdu.
 */
export const CHAT_SIGNATURE_SKEW_SECONDS = 60

/** `0x` + 64 hex. Nonce'un TAM bicimi; semadaki CHECK ile ayni. */
export const CHAT_NONCE_PATTERN = /^0x[0-9a-f]{64}$/
/** `0x` + 130 hex (r,s,v). */
export const CHAT_SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
/** Milisaniyeli, UTC, `Z` sonlu. TEK bicim: iki bicim iki metin demektir. */
export const CHAT_ISSUED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ChatPayload = {
  readonly chainId: number
  readonly token: string
  readonly author: string
  readonly nonce: string
  readonly issuedAt: string
  readonly body: string
}

/**
 * IMZALANAN METIN. ISTEMCI VE SUNUCU AYNI FONKSIYONU CAGIRIR.
 *
 * Iki kopya olsaydi tek bir bosluk karakteri butun imzalari gecersiz kilardi
 * ve ariza "imza tutmuyor" diye gorunurdu -- tesihisi en zor sinif. Bu dosya
 * `pg`ye ya da bir node builtin'ine DOKUNMAZ, yani bir istemci bileşeni onu
 * dogrudan import edebilir.
 */
export function chatMessageText(payload: ChatPayload): string {
  return [
    CHAT_MESSAGE_HEADER,
    `chain: ${payload.chainId}`,
    `token: ${payload.token.toLowerCase()}`,
    `author: ${payload.author.toLowerCase()}`,
    `nonce: ${payload.nonce.toLowerCase()}`,
    `issued: ${payload.issuedAt}`,
    'body:',
    payload.body,
  ].join('\n')
}

/** Tarayicida uretilen 32 baytlik nonce. `crypto.getRandomValues` her yerde var. */
export function newChatNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let out = '0x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * IMZADAN YAZARI KURTARIR -- VE HICBIR AG CAGRISI YAPMAZ.
 *
 * Bu ozellik POST rotasinin guvenlik iddiasinin tasiyicisi: kurtarma saf
 * secp256k1'dir, yani ROTA IMZAYI DOGRULAMADAN ONCE hicbir RPC'ye ve hicbir
 * veritabanina dokunmaz. Dolayisiyla kimligi olmayan bir cagrici, rotaya
 * bagirarak bizim adimiza bir zincir okumasi ya da bir sorgu yaptiramaz.
 *
 * `verifyMessage` (viem'in client eylemi) SECILMEDI ve gerekcesi budur: o
 * EIP-1271/6492 icin bir `eth_call` yapar. Bedeli: BU FAZDA BIR AKILLI
 * KONTRAT CUZDANI (Safe dahil) CHAT'E YAZAMAZ. Bilinerek, ve yazili --
 * governor Safe'in sohbet etmesi beklenen bir sey degil, ve 1271'i acmak
 * yukaridaki "imzasiz cagri hicbir arka ucu dokunduramaz" cumlesini
 * kaybettirirdi.
 *
 * Bozuk imza ATMAZ, `null` doner: bir POST govdesindeki hicbir sey bir 500'e
 * donusmemeli.
 */
export async function recoverChatAuthor(
  payload: ChatPayload,
  signature: string,
): Promise<string | null> {
  if (!CHAT_SIGNATURE_PATTERN.test(signature)) return null
  try {
    const recovered = await recoverMessageAddress({
      message: chatMessageText(payload),
      signature: signature as `0x${string}`,
    })
    return recovered.toLowerCase()
  } catch {
    return null
  }
}

/** Imza gercekten `payload.author`a mi ait? */
export async function chatSignatureMatches(
  payload: ChatPayload,
  signature: string,
): Promise<boolean> {
  const recovered = await recoverChatAuthor(payload, signature)
  return recovered !== null && recovered === payload.author.toLowerCase()
}

export type IssuedVerdict = 'ok' | 'malformed' | 'expired' | 'fromTheFuture'

/**
 * `issued` PENCERESI, sunucunun saatine karsi.
 *
 * ISTEMCININ SAATI KULLANILMAZ ve kullanilamaz: pencerenin var olma sebebi
 * saldirgani sinirlamak, ve saldirgan istemcinin ta kendisi.
 */
export function checkIssuedAt(issuedAt: string, now: number): IssuedVerdict {
  if (!CHAT_ISSUED_PATTERN.test(issuedAt)) return 'malformed'
  const millis = Date.parse(issuedAt)
  if (Number.isNaN(millis)) return 'malformed'
  const ageSeconds = (now - millis) / 1000
  if (ageSeconds > CHAT_SIGNATURE_TTL_SECONDS) return 'expired'
  if (ageSeconds < -CHAT_SIGNATURE_SKEW_SECONDS) return 'fromTheFuture'
  return 'ok'
}
