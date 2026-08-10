import { recoverMessageAddress } from 'viem'

/**
 * ==========================================================================
 *  BIR EMRIN KIMLIGI -- FAZ 6'NIN SEMASI, IKI YERDE BILINCLI OLARAK FARKLI
 * ==========================================================================
 *
 * `chatMessage.ts` EIP-191 `personal_sign` + kanonik metin semasini kurdu ve
 * gerekcesi burada da aynen gecerli (EIP-712 govdeyi bir alan etiketinin
 * arkasina koyar; SIWE bir OTURUM kurar ve calinan bir oturum butun gelecek
 * yazmalari ele gecirir). Ayni sema, IKI IYILESTIRMEYLE:
 *
 * ------------------------------------------------------------------
 * 1. BIRIM, IMZALANAN METNIN ICINDEDIR.
 * ------------------------------------------------------------------
 * Chat'te imzalanan sey kullanicinin yazdigi cumleydi. Burada imzalanan sey
 * PARADIR, ve Arc'ta bir para sayisi TEK BASINA ANLAMSIZDIR: USDC'nin
 * 18-decimal native gorunumu ve 6-decimal ERC-20 gorunumu AYNI fonun iki
 * yuzudur ve aralarindaki 1e12'lik fark tamamen gecerli bir sayidir. Bu yuzden
 * satirlarin adi `spend_wei` / `sell_tok` / `min_out_tok` / `min_out_wei`dir:
 * kullanicinin cuzdaninda GORDUGU metin hangi gorunumu imzaladigini soyler.
 * `packages/db`nin `naming.test.ts` kapisinin sema icin yaptigi seyin, imza
 * metni icin yapilmis hali.
 *
 * ------------------------------------------------------------------
 * 2. BIREBIRLIK YAPISALDIR, KURULMUS DEGIL.
 * ------------------------------------------------------------------
 * Chat'in `body`si SERBEST metindi, yani sunucunun metni alanlardan yeniden
 * kurmasi bir tehlike tasiyordu: iki farkli alan kumesi AYNI metni uretebilir
 * miydi? Cozum `body`yi EN SONA koymak ve "geri kalanin tamami" yapmakti.
 *
 * BURADA SERBEST ALAN HIC YOKTUR. Her satir sabit bicimlidir -- ondalik sayi,
 * `0x` + 40 hex, `buy`/`sell`, milisaniyeli ISO damgasi -- yani iki farkli
 * alan kumesinin ayni metni uretmesi MUMKUN DEGILDIR ve bunun icin bir
 * yerlesim numarasi gerekmez. `message.test.ts`in kurdugu saldiri burada
 * TEMSIL EDILEMEZ.
 *
 * ------------------------------------------------------------------
 * DEGISMEYEN BEDEL: EIP-1271 CUZDANLAR IMZALAYAMAZ.
 * ------------------------------------------------------------------
 * Kurtarma saf secp256k1'dir (`recoverMessageAddress`, viem'in `verifyMessage`
 * CLIENT eylemi DEGIL -- o EIP-1271 icin bir `eth_call` yapar). Bedeli: bir
 * AKILLI KONTRAT CUZDANI (Safe dahil) EMIR VEREMEZ.
 *
 * VE BU, CHAT'TEKINDEN DAHA AGIR BIR BEDELDIR. Faz 6 raporu "governor Safe'in
 * sohbet etmesi beklenen bir sey degil" diyerek gecti; bir EMIR icin ayni sey
 * soylenemez -- bir hazine ya da bir DAO'nun limit emri vermek istemesi
 * TAMAMEN makuldur. Yine de ayni secim yapildi ve gerekcesi degisti:
 *
 *   1271'i acmak, "gecerli bir imzasi olmayan bir cagrici bize tek bir
 *   veritabani sorgusu ya da tek bir RPC objesi yaptiramaz" ozelligini
 *   kaybettirir -- imzayi DOGRULAMAK icin bir `eth_call` gerekir, yani
 *   dogrulama artik kotayi harcayan seyin KENDISI olur.
 *
 *   VE BU FAZDA 1271'IN KAZANDIRACAGI SEY ZATEN KUCUKTUR: bir Safe emri
 *   verebilse bile onu DOLDURAMAZ, cunku doldurma islemi sahibin kendi
 *   islemidir ve bir Safe icin o islem 2-of-3 imza ister -- yani tetiklendigi
 *   an "tek dokunusla doldur" akisi bir Safe icin zaten yoktur. Bedel gercek,
 *   ama bu fazda kazanci teorik.
 */

export const ORDER_PLACE_HEADER = 'arcpad limit order'
export const ORDER_CANCEL_HEADER = 'arcpad cancel order'
export const ORDER_FILL_HEADER = 'arcpad order filled'

/** Imzanin YASI icin ust sinir. Chat ile ayni: bes dakika. */
export const ORDER_SIGNATURE_TTL_SECONDS = 300
/** Gelecege tolerans. Sifir olamaz -- istemcinin saati birkac saniye ileri olabilir. */
export const ORDER_SIGNATURE_SKEW_SECONDS = 60

/**
 * BIR EMRIN YASAYABILECEGI EN UZUN SURE.
 *
 * Bir tavan OLMAK ZORUNDA ve sebebi urun degil KEEPER: her acik emir HER
 * GECISTE taranir (bkz. `keeper/src/orders/scan.ts`), yani suresiz bir emir
 * kalici bir tarama maliyetidir. Otuz gun, "bir sonraki dongude dolar"
 * beklentisini tasiyacak kadar uzun, ve unutulmus bir emrin bir yil sonra
 * beklenmedik bir fiyattan dolmasina izin vermeyecek kadar kisa.
 *
 * ALT SINIR DA VAR: bes dakikadan kisa bir emir, imzanin kendi TTL'inden
 * (300 sn) daha kisa yasardi -- yani kullanici imzalarken zaten olmus bir emir
 * uretebilirdi.
 */
export const ORDER_MAX_TTL_SECONDS = 30 * 24 * 60 * 60
export const ORDER_MIN_TTL_SECONDS = 300

export const ORDER_NONCE_PATTERN = /^0x[0-9a-f]{64}$/
export const ORDER_SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
export const ORDER_ISSUED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const ORDER_TX_PATTERN = /^0x[0-9a-f]{64}$/i

export type OrderPlacePayload = {
  readonly chainId: number
  readonly token: string
  readonly owner: string
  readonly isBuy: boolean
  /** ALIMDA `msg.value` (wei), SATIMDA `tokensIn` (tok). Ondalik dize. */
  readonly amount: string
  /** ALIMDA `minTokensOut` (tok), SATIMDA `minQuoteOut` (wei). Ondalik dize. */
  readonly minOut: string
  /** Milisaniyeli ISO. */
  readonly expiresAt: string
  readonly nonce: string
  readonly issuedAt: string
}

/**
 * IMZALANAN METIN. ISTEMCI VE SUNUCU AYNI FONKSIYONU CAGIRIR.
 *
 * Iki kopya olsaydi tek bir bosluk karakteri butun imzalari dusururdu ve ariza
 * "imza tutmuyor" diye gorunurdu -- teshisi en zor sinif.
 *
 * SATIR ADLARI YONE GORE DEGISIR, ve bu bir suslemenin degil bir korumanin
 * sonucudur: bir ALIM icin alinan imza, alanlar yeniden etiketlenerek bir
 * SATIS gibi okunamaz -- metin farklidir, kurtarma baska bir adres verir.
 */
export function orderPlaceText(payload: OrderPlacePayload): string {
  const amountLine = payload.isBuy ? 'spend_wei' : 'sell_tok'
  const minLine = payload.isBuy ? 'min_out_tok' : 'min_out_wei'
  return [
    ORDER_PLACE_HEADER,
    `chain: ${payload.chainId}`,
    `token: ${payload.token.toLowerCase()}`,
    `owner: ${payload.owner.toLowerCase()}`,
    `side: ${payload.isBuy ? 'buy' : 'sell'}`,
    `${amountLine}: ${payload.amount}`,
    `${minLine}: ${payload.minOut}`,
    `expires: ${payload.expiresAt}`,
    `nonce: ${payload.nonce}`,
    `issued: ${payload.issuedAt}`,
  ].join('\n')
}

export type OrderResolvePayload = {
  readonly chainId: number
  readonly token: string
  readonly owner: string
  readonly orderSeq: string
  readonly intent: 'cancel' | 'filled'
  /** `filled` icin ZORUNLU, `cancel` icin BOS DIZE. */
  readonly txHash: string
  readonly issuedAt: string
}

/**
 * IPTAL VE DOLDURMA-BILDIRIMI ICIN METIN -- VE BURADA NONCE YOKTUR.
 *
 * Bu bir eksik degil bir COZUMLEME: bir nonce'un isi TEKRAR OYNATMAYI
 * durdurmaktir, ve tekrar oynatma ancak IKINCI KEZ CALISTIRILDIGINDA BIR SEY
 * DEGISTIREN bir islem icin tehlikelidir. Bu iki niyetin ikisi de
 * **BIREBIR AYNI SATIRA, BIREBIR AYNI SONUCU** yazar:
 *
 *   - `cancel`  emri `cancelled` yapar. Ikinci kez calistirildiginda satir
 *     ZATEN `cancelled`tir ve `WHERE status = ANY(LIVE_STATUSES)` sifir satir
 *     gunceller. Yani tekrar oynatmanin etkisi YOKTUR.
 *   - `filled`  emri `filled` + `fill_tx_hash` yapar. Metin `order`i VE `tx`i
 *     birlikte tasidigi icin, yakalanmis bir imza yalnizca AYNI emri AYNI
 *     islemle isaretleyebilir.
 *
 * Ustelik metin `order: <seq>` tasir ve `order_seq` birebirdir, yani yakalanmis
 * bir iptal imzasi kullanicinin DAHA SONRA verdigi baska bir emre TASINAMAZ.
 * Geriye kalan tek pencere `issued` penceresidir ve o uygulanmaktadir.
 *
 * BIR NONCE EKLEMEK NE MALIYET GETIRIRDI: her iptal icin bir UNIQUE satir
 * saklamak gerekirdi (aksi halde nonce hicbir sey yapmaz), yani iptaller icin
 * ikinci bir tablo. Etkisi olmayan bir tekrar oynatmayi durdurmak icin bir
 * tablo, korunan seyden pahalidir.
 */
export function orderResolveText(payload: OrderResolvePayload): string {
  const header = payload.intent === 'cancel' ? ORDER_CANCEL_HEADER : ORDER_FILL_HEADER
  const lines = [
    header,
    `chain: ${payload.chainId}`,
    `token: ${payload.token.toLowerCase()}`,
    `owner: ${payload.owner.toLowerCase()}`,
    `order: ${payload.orderSeq}`,
  ]
  if (payload.intent === 'filled') lines.push(`tx: ${payload.txHash.toLowerCase()}`)
  lines.push(`issued: ${payload.issuedAt}`)
  return lines.join('\n')
}

/** Tarayicida uretilen 32 baytlik nonce. */
export function newOrderNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let out = '0x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

async function recover(text: string, signature: string): Promise<string | null> {
  if (!ORDER_SIGNATURE_PATTERN.test(signature)) return null
  try {
    const recovered = await recoverMessageAddress({
      message: text,
      signature: signature as `0x${string}`,
    })
    return recovered.toLowerCase()
  } catch {
    return null
  }
}

export async function placeSignatureMatches(
  payload: OrderPlacePayload,
  signature: string,
): Promise<boolean> {
  const recovered = await recover(orderPlaceText(payload), signature)
  return recovered !== null && recovered === payload.owner.toLowerCase()
}

export async function resolveSignatureMatches(
  payload: OrderResolvePayload,
  signature: string,
): Promise<boolean> {
  const recovered = await recover(orderResolveText(payload), signature)
  return recovered !== null && recovered === payload.owner.toLowerCase()
}

export type IssuedVerdict = 'ok' | 'malformed' | 'expired' | 'fromTheFuture'

/** `issued` penceresi, SUNUCUNUN saatine karsi. Istemcinin saati saldirganindir. */
export function checkOrderIssuedAt(issuedAt: string, now: number): IssuedVerdict {
  if (!ORDER_ISSUED_PATTERN.test(issuedAt)) return 'malformed'
  const millis = Date.parse(issuedAt)
  if (Number.isNaN(millis)) return 'malformed'
  const ageSeconds = (now - millis) / 1000
  if (ageSeconds > ORDER_SIGNATURE_TTL_SECONDS) return 'expired'
  if (ageSeconds < -ORDER_SIGNATURE_SKEW_SECONDS) return 'fromTheFuture'
  return 'ok'
}

export type ExpiryVerdict = 'ok' | 'malformed' | 'tooSoon' | 'tooFar'

/**
 * SON KULLANMA PENCERESI, ve o da SUNUCUNUN saatine karsi.
 *
 * `issuedAt`e gore DEGIL: istemcinin damgasina gore olculseydi, saati bir yil
 * ileri kurulmus bir istemci bir yillik bir emir uretebilirdi ve ust sinir
 * hicbir sey yapmazdi.
 */
export function checkExpiresAt(expiresAt: string, now: number): ExpiryVerdict {
  if (!ORDER_ISSUED_PATTERN.test(expiresAt)) return 'malformed'
  const millis = Date.parse(expiresAt)
  if (Number.isNaN(millis)) return 'malformed'
  const seconds = (millis - now) / 1000
  if (seconds < ORDER_MIN_TTL_SECONDS) return 'tooSoon'
  if (seconds > ORDER_MAX_TTL_SECONDS) return 'tooFar'
  return 'ok'
}

/** Ondalik, isaretsiz, sifir olmayan tamsayi. `bigint`e cevrilmeden ONCE. */
export const ORDER_AMOUNT_PATTERN = /^[1-9][0-9]{0,77}$/

export type AmountVerdict = 'ok' | 'malformed'

export function checkAmount(value: string): AmountVerdict {
  return ORDER_AMOUNT_PATTERN.test(value) ? 'ok' : 'malformed'
}
