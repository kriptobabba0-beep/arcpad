import {
  type ChatMessageRow,
  chatPreflight,
  DEFAULT_CHAT_RATE_LIMIT,
  postChatMessage,
} from '@arcpad/db'
import { isAddress } from 'viem'
import { getWebConfig } from '@/lib/addresses'
import { getHolderReader } from '@/lib/chatBalance'
import { getPool } from '@/lib/db'
import {
  CHAT_ISSUED_PATTERN,
  CHAT_NONCE_PATTERN,
  CHAT_SIGNATURE_PATTERN,
  type ChatPayload,
  chatSignatureMatches,
  checkIssuedAt,
} from '@/lib/chatMessage'
import { checkChatBody } from '@/lib/chatPolicy'
import type { HexAddress } from '@/components/read/types'

/**
 * ==========================================================================
 *  URUNUN ILK VERITABANI YAZMA YOLU
 * ==========================================================================
 *
 * Bugune kadar her sey ya bir OKUMAYDI (server component -> Postgres) ya da
 * bir ZINCIR ISLEMIYDI (cuzdan imzalar, zincir dogrular, biz yalnizca
 * gondeririz). Ikisinde de bizim tarafimizda dogrulanacak bir sey yoktu:
 * okuma bir sey degistirmez, zincir kendi kurallarini kendi uygular.
 *
 * Burasi farkli. Bu rota, KIMLIGI OLMAYAN BIR CAGRICININ veritabanimiza satir
 * yazdirabilecegi tek yer. Dolayisiyla dosyanin sekli "once dogrula, sonra
 * yaz" degil, **"ucuzdan pahaliya, ve hicbir arka uc imzasiz dokunulmaz"**.
 *
 * ==========================================================================
 *  SIRA BIR GUVENLIK OZELLIGIDIR
 * ==========================================================================
 *
 *   1-6  govde boyu, JSON, alan bicimleri, zincir kimligi, govde politikasi,
 *        `issued` penceresi                       -- SAF, hicbir I/O yok
 *   7    IMZADAN YAZARI KURTAR                    -- SAF (secp256k1), I/O yok
 *   ----------------------------------------------------------------------
 *   8    Postgres: launch var mi + pencerede kac mesaj (TEK sorgu)
 *   9    ZINCIR: `balanceOf` + blok, tek `eth_call`
 *   10   Postgres: kilit + sayim + INSERT
 *
 * 7. adimin ustundeki cizgi asil iddiadir: **gecerli bir imzasi olmayan bir
 * cagrici bize tek bir veritabani sorgusu ya da tek bir RPC objesi
 * yaptiramaz.** Bu iddia `test/chat/route.test.ts` icinde, cagrildiginda ATAN
 * bir havuz ve ATAN bir zincir okuyucusu enjekte edilerek OLCULUYOR --
 * yani "boyle yazdik" degil, "boyle davraniyor".
 *
 * 8. adimin 9'dan ONCE olmasinin sebebi de ayni sinif: gecerli bir imza
 * uretmek bir cuzdan sahibi icin bedavadir, yani imza tek basina RPC kotamizi
 * korumaz. "Bu token diye bir sey yok" ve "bu yazar kotasini doldurmus"
 * cevaplari ZINCIRE HIC GITMEDEN verilir.
 *
 * ==========================================================================
 *  CSRF YOKTUR, CUNKU ORTAM YETKISI YOKTUR
 * ==========================================================================
 *
 * Bu rota cerez, oturum ya da `Authorization` basligi OKUMAZ. Yetkiyi tasiyan
 * tek sey govdedeki imzadir, yani bir baska sitenin tarayiciya attirdigi bir
 * istek hicbir sey elde edemez: imzayi uretebilmesi icin ozel anahtara sahip
 * olmasi gerekirdi. Bu yuzden bir CSRF token'i ne var ne de gerekli --
 * cikarim yazili, cunku "POST var ama CSRF korumasi yok" bir inceleme
 * bulgusu gibi okunur.
 *
 * ==========================================================================
 *  `GET` YOKTUR
 * ==========================================================================
 *
 * Spec §6.3 API rotalarini YALNIZCA yazmaya birakir; panel Postgres'i bir
 * server component'ten okur (`lib/read.ts`, `readChat`). Buraya bir `GET`
 * eklemek iki okuma yolu dogururdu ve ikisi ayrisirdi.
 */

/** `pg` ve `viem` node runtime ister; ikisi de edge'de kosmaz. */
export const runtime = 'nodejs'
/** Bir yazma rotasi asla onbeleklenmez. */
export const dynamic = 'force-dynamic'

/**
 * HAM GOVDE TAVANI. Govde sinirinin (1000 bayt) cok ustunde, cunku JSON
 * cercevesi + imza + nonce + adresler yaklasik 400 bayt tutar; 8 KiB rahat
 * bir tavan ve yine de `JSON.parse`i megabaytlarca metinden korur.
 *
 * `Content-Length` basligina GUVENILMEZ -- gonderen onu yanlis yazabilir;
 * olculen sey okunmus metnin gercek boyudur.
 */
export const CHAT_MAX_REQUEST_BYTES = 8 * 1024

type ErrorBody = { readonly error: string; readonly detail?: string }

function fail(error: string, status: number, extra?: Record<string, string>): Response {
  const body: ErrorBody = { error, ...(extra ?? {}) }
  return Response.json(body, {
    status,
    ...(status === 429
      ? { headers: { 'Retry-After': String(DEFAULT_CHAT_RATE_LIMIT.windowSeconds) } }
      : {}),
  })
}

/** `bigint` JSON'a girmez. Tel bicimi: ondalik DIZE, `Number` DEGIL. */
export type ChatWireMessage = {
  readonly messageSeq: string
  readonly token: string
  readonly authorAddr: string
  readonly body: string
  readonly balanceTok: string
  readonly balanceBlockNumber: string
  readonly issuedAt: string
  readonly createdAt: string
  readonly currentBalanceTok: string | null
  readonly isLaunchCreator: boolean
}

export function toWireMessage(row: ChatMessageRow): ChatWireMessage {
  return {
    messageSeq: row.messageSeq.toString(),
    token: row.token,
    authorAddr: row.authorAddr,
    body: row.body,
    balanceTok: row.balanceTok.toString(),
    balanceBlockNumber: row.balanceBlockNumber.toString(),
    issuedAt: row.issuedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    currentBalanceTok: row.currentBalanceTok === null ? null : row.currentBalanceTok.toString(),
    isLaunchCreator: row.isLaunchCreator,
  }
}

type Parsed = { payload: ChatPayload; signature: string }

/**
 * ALANLARIN BICIMI. Her biri REDDEDER, hicbiri DUZELTMEZ.
 *
 * Duzeltme (trim, lowercase, normalise) burada YAPILAMAZ: alanlarin tamami
 * imzalanan metnin icine giriyor, yani sunucunun degistirdigi bir alan
 * imzayi dusururdu. Adreslerin kucuk harfe indirilmesi TEK istisnadir ve
 * guvenlidir cunku `chatMessageText` de ayni indirmeyi yapar -- yani
 * imzalanan metin her iki tarafta da kucuk harflidir.
 */
function parseBody(raw: unknown): Parsed | 'badRequest' {
  if (raw === null || typeof raw !== 'object') return 'badRequest'
  const doc = raw as Record<string, unknown>
  const str = (key: string): string | null =>
    typeof doc[key] === 'string' ? (doc[key] as string) : null

  const token = str('token')
  const author = str('author')
  const nonce = str('nonce')
  const issuedAt = str('issuedAt')
  const body = str('body')
  const signature = str('signature')
  const chainId = doc['chainId']

  if (token === null || author === null || nonce === null) return 'badRequest'
  if (issuedAt === null || body === null || signature === null) return 'badRequest'
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId)) return 'badRequest'
  if (!isAddress(token, { strict: false })) return 'badRequest'
  if (!isAddress(author, { strict: false })) return 'badRequest'
  if (!CHAT_NONCE_PATTERN.test(nonce.toLowerCase())) return 'badRequest'
  if (!CHAT_SIGNATURE_PATTERN.test(signature)) return 'badRequest'
  if (!CHAT_ISSUED_PATTERN.test(issuedAt)) return 'badRequest'

  return {
    payload: {
      chainId,
      token: token.toLowerCase(),
      author: author.toLowerCase(),
      nonce: nonce.toLowerCase(),
      issuedAt,
      body,
    },
    signature: signature.toLowerCase(),
  }
}

export async function POST(request: Request): Promise<Response> {
  // ---- 1. HAM BOY. `JSON.parse` bundan sonra cagrilir. --------------------
  let text: string
  try {
    text = await request.text()
  } catch {
    return fail('badRequest', 400)
  }
  if (new TextEncoder().encode(text).length > CHAT_MAX_REQUEST_BYTES) {
    return fail('requestTooLarge', 413)
  }

  // ---- 2. JSON --------------------------------------------------------
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('badRequest', 400)
  }

  // ---- 3. ALAN BICIMLERI ----------------------------------------------
  const parsed = parseBody(raw)
  if (parsed === 'badRequest') return fail('badRequest', 400)
  const { payload, signature } = parsed

  // ---- 4. ZINCIR KIMLIGI ----------------------------------------------
  /*
   * `chainId` IMZALANAN METNIN ICINDE ve BURADA da kontrol ediliyor. Ikisi
   * ayri isler: metindeki, baska bir agda uretilmis bir imzanin BURADA
   * gecerli OLMAMASINI saglar (metin farkli olur, kurtarma baska bir adres
   * verir); buradaki ise dogru imzalanmis ama YANLIS AGA ait bir istegin
   * erken ve okunur bicimde reddedilmesini saglar.
   *
   * Deger `getWebConfig()`ten gelir -- bu dosyada bir zincir sabiti YOKTUR
   * (`chain-registry` kapisi tarali kaynakta ikinci bir kopyayi yasaklar).
   */
  const config = getWebConfig()
  if (payload.chainId !== config.chain.id) return fail('wrongChain', 400)

  // ---- 5. GOVDE POLITIKASI (link yasagi dahil) ------------------------
  const verdict = checkChatBody(payload.body)
  if (!verdict.ok) {
    return fail(
      verdict.reason,
      400,
      verdict.detail === undefined ? undefined : { detail: verdict.detail },
    )
  }

  // ---- 6. `issued` PENCERESI ------------------------------------------
  const issued = checkIssuedAt(payload.issuedAt, Date.now())
  if (issued !== 'ok') return fail(issued === 'malformed' ? 'badRequest' : issued, 400)

  // ---- 7. IMZA. BURAYA KADAR HICBIR I/O YAPILMADI. --------------------
  if (!(await chatSignatureMatches(payload, signature))) return fail('badSignature', 401)

  const token = payload.token as HexAddress
  const author = payload.author as HexAddress

  // ---- 8. POSTGRES: launch var mi + on eleme sayimi (TEK sorgu) --------
  let pre: { launchExists: boolean; recentCount: number }
  try {
    pre = await chatPreflight(getPool(), token, author, DEFAULT_CHAT_RATE_LIMIT.windowSeconds)
  } catch (error) {
    console.error('[chat] preflight query failed', error)
    return fail('databaseUnavailable', 503)
  }
  if (!pre.launchExists) return fail('unknownToken', 404)
  if (pre.recentCount >= DEFAULT_CHAT_RATE_LIMIT.maxMessages) return fail('rateLimited', 429)

  // ---- 9. ZINCIR: bakiye + blok, tek `eth_call` -----------------------
  const reading = await getHolderReader()(token, author)
  if (!reading.ok) return fail('chainUnavailable', 503)

  // ---- 10. HOLDER KAPISI ----------------------------------------------
  /*
   * ESIK SIFIRDIR: "holder" = bir tanesi bile var. Bir minimum uydurmak
   * spec'te olmayan bir urun karari olurdu, ve daha onemlisi GEREKSIZ:
   * mesajin yaninda gonderi anindaki bakiye CIZILIYOR, yani 1 wei'lik bir
   * "holder"in mesaji ekranda AGIRLIKSIZ gorunur. Kapi "drive-by degil"
   * demek icin var; agirligi anlatan sey sayinin kendisi.
   *
   * Ayni kural semada da duruyor (`CHECK (balance_tok > 0)`), yani buradaki
   * `if` atlanirsa satir yine yazilamaz.
   */
  if (reading.balanceTok <= 0n) return fail('notAHolder', 403)

  // ---- 11. YAZ ---------------------------------------------------------
  let outcome
  try {
    outcome = await postChatMessage(getPool(), {
      token,
      authorAddr: author,
      body: payload.body,
      balanceTok: reading.balanceTok,
      balanceBlockNumber: reading.blockNumber,
      nonceHex: payload.nonce,
      signatureHex: signature,
      issuedAt: new Date(payload.issuedAt),
    })
  } catch (error) {
    console.error('[chat] insert failed', error)
    return fail('databaseUnavailable', 503)
  }

  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'unknownToken':
        return fail('unknownToken', 404)
      case 'duplicateNonce':
        // 409, 400 DEGIL: istek KUSURSUZ bicimlidir ve imzasi gecerlidir --
        // yalnizca DAHA ONCE yazilmistir. Tekrar oynatma tam olarak boyle
        // gorunur ve 400 demek onu "bozuk istek" diye gizlerdi.
        return fail('duplicateNonce', 409)
      case 'rateLimited':
        return fail('rateLimited', 429)
      case 'rejected':
        console.error('[chat] a schema CHECK refused a row the route accepted', outcome.constraint)
        return fail(
          'rejected',
          400,
          outcome.constraint === null ? undefined : { detail: outcome.constraint },
        )
    }
  }

  return Response.json({ ok: true, message: toWireMessage(outcome.row) }, { status: 201 })
}
