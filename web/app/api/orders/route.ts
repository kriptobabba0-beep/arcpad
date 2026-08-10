import {
  DEFAULT_ORDER_RATE_LIMIT,
  type LimitOrderRow,
  orderPreflight,
  placeOrder,
} from '@arcpad/db'
import { isAddress } from 'viem'
import { getWebConfig } from '@/lib/addresses'
import { getPool } from '@/lib/db'
import {
  checkAmount,
  checkExpiresAt,
  checkOrderIssuedAt,
  ORDER_ISSUED_PATTERN,
  ORDER_NONCE_PATTERN,
  ORDER_SIGNATURE_PATTERN,
  type OrderPlacePayload,
  placeSignatureMatches,
} from '@/lib/limitOrder'
import type { HexAddress } from '@/components/read/types'

/**
 * ==========================================================================
 *  EMIR YERLESTIRME -- URUNUN IKINCI YAZMA YOLU
 * ==========================================================================
 *
 * Faz 6'nin `/api/chat`i bu urunun ilk yazma yoluydu ve dosyanin sekli oradan
 * geliyor: **UCUZDAN PAHALIYA, VE HICBIR ARKA UC IMZASIZ DOKUNULMAZ.**
 *
 *   1-7  boy, JSON, alan bicimleri, zincir kimligi, miktar bicimleri,
 *        `issued` penceresi, son kullanma penceresi   -- SAF, hicbir I/O
 *   8    IMZADAN SAHIBI KURTAR                        -- SAF (secp256k1)
 *   ----------------------------------------------------------------------
 *   9    Postgres: launch var mi + iki sayim (TEK sorgu)
 *   10   Postgres: kilit + yetkili sayim + INSERT
 *
 * ==========================================================================
 *  CHAT'TEN BIR EKSIGI VAR, VE O EKSIK BILINCLI: ZINCIR OKUMASI YOK
 * ==========================================================================
 *
 * Chat'in 9. adimi bir `eth_call`di (holder kapisi). BURADA YOKTUR, ve bu bir
 * atlama degil bir karar:
 *
 *   BIR EMIR VERMEK ICIN FONA SAHIP OLMAK GEREKMEZ, cunku emir doldugunda
 *   fonu HARCAYAN sey kullanicinin KENDI islemidir. Bir kullanici "5 USDC
 *   geldiginde su fiyattan al" emri verip parayi sonra yatirabilir; bakiyeyi
 *   YERLESTIRME aninda dayatmak, mesru bir kullanimi yasaklardi.
 *
 *   VE ONEMLISI: bir emrin yerlestirme anindaki bakiyesi HICBIR SEY GARANTI
 *   ETMEZ. Chat'te `balance_tok` bir OLCUMDU ve satirin degeriydi; burada ayni
 *   sayi yalnizca bir anlik goruntu olurdu ve emir gunlerce yasar. Fonun
 *   yetip yetmedigi DOLDURMA aninda belli olur, ve o an zincirin kendisi karar
 *   verir.
 *
 * Bedeli acikca: fonu olmayan biri emir birakabilir. Bunun bize maliyeti bir
 * satirdir ve iki sinirla cevrilidir (pencere + acik emir tavani); keeper
 * boyle bir emri TETIKLEMEZ ve "Orders" sekmesi bakiyeyi CANLI okuyup
 * kullaniciya soyler.
 *
 * ==========================================================================
 *  `GET` YOKTUR (spec §6.3)
 * ==========================================================================
 *
 * Okuma yolu bir server component + bir server action'dir
 * (`app/token/[address]/actions.ts`, `loadOrders`). Buraya bir `GET` eklemek
 * iki okuma yolu dogururdu.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Chat ile ayni tavan ve ayni gerekce: `JSON.parse`i megabaytlardan korur. */
export const ORDER_MAX_REQUEST_BYTES = 8 * 1024

function fail(error: string, status: number, extra?: Record<string, string>): Response {
  return Response.json(
    { error, ...(extra ?? {}) },
    {
      status,
      ...(status === 429
        ? { headers: { 'Retry-After': String(DEFAULT_ORDER_RATE_LIMIT.windowSeconds) } }
        : {}),
    },
  )
}

/** `bigint` JSON'a girmez. Tel bicimi: ondalik DIZE, `Number` DEGIL. */
export type OrderWire = {
  readonly orderSeq: string
  readonly token: string
  readonly ownerAddr: string
  readonly isBuy: boolean
  readonly amount: string
  readonly minOut: string
  readonly status: string
  readonly expiresAt: string
  readonly triggerBlockNumber: string | null
  readonly fillTxHash: string | null
  readonly createdAt: string
}

export function toOrderWire(row: LimitOrderRow): OrderWire {
  return {
    orderSeq: row.orderSeq.toString(),
    token: row.token,
    ownerAddr: row.ownerAddr,
    isBuy: row.isBuy,
    amount: row.amount.toString(),
    minOut: row.minOut.toString(),
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    triggerBlockNumber: row.triggerBlockNumber === null ? null : row.triggerBlockNumber.toString(),
    fillTxHash: row.fillTxHash,
    createdAt: row.createdAt.toISOString(),
  }
}

type Parsed = { payload: OrderPlacePayload; signature: string }

/**
 * ALANLARIN BICIMI. Her biri REDDEDER, hicbiri DUZELTMEZ.
 *
 * Duzeltme burada YAPILAMAZ: alanlarin tamami imzalanan metnin icine giriyor.
 * Adreslerin kucuk harfe indirilmesi TEK istisnadir ve guvenlidir cunku
 * `orderPlaceText` de ayni indirmeyi yapar.
 */
function parseBody(raw: unknown): Parsed | 'badRequest' {
  if (raw === null || typeof raw !== 'object') return 'badRequest'
  const doc = raw as Record<string, unknown>
  const str = (key: string): string | null =>
    typeof doc[key] === 'string' ? (doc[key] as string) : null

  const token = str('token')
  const owner = str('owner')
  const amount = str('amount')
  const minOut = str('minOut')
  const expiresAt = str('expiresAt')
  const nonce = str('nonce')
  const issuedAt = str('issuedAt')
  const signature = str('signature')
  const chainId = doc['chainId']
  const isBuy = doc['isBuy']

  if (token === null || owner === null || amount === null || minOut === null) return 'badRequest'
  if (expiresAt === null || nonce === null || issuedAt === null || signature === null) {
    return 'badRequest'
  }
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId)) return 'badRequest'
  if (typeof isBuy !== 'boolean') return 'badRequest'
  if (!isAddress(token, { strict: false })) return 'badRequest'
  if (!isAddress(owner, { strict: false })) return 'badRequest'
  if (!ORDER_NONCE_PATTERN.test(nonce.toLowerCase())) return 'badRequest'
  if (!ORDER_SIGNATURE_PATTERN.test(signature)) return 'badRequest'
  if (!ORDER_ISSUED_PATTERN.test(issuedAt)) return 'badRequest'
  if (!ORDER_ISSUED_PATTERN.test(expiresAt)) return 'badRequest'

  return {
    payload: {
      chainId,
      token: token.toLowerCase(),
      owner: owner.toLowerCase(),
      isBuy,
      amount,
      minOut,
      expiresAt,
      nonce: nonce.toLowerCase(),
      issuedAt,
    },
    signature: signature.toLowerCase(),
  }
}

export async function POST(request: Request): Promise<Response> {
  // ---- 1. HAM BOY ------------------------------------------------------
  let text: string
  try {
    text = await request.text()
  } catch {
    return fail('badRequest', 400)
  }
  if (new TextEncoder().encode(text).length > ORDER_MAX_REQUEST_BYTES) {
    return fail('requestTooLarge', 413)
  }

  // ---- 2. JSON ---------------------------------------------------------
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('badRequest', 400)
  }

  // ---- 3. ALAN BICIMLERI -----------------------------------------------
  const parsed = parseBody(raw)
  if (parsed === 'badRequest') return fail('badRequest', 400)
  const { payload, signature } = parsed

  // ---- 4. ZINCIR KIMLIGI -----------------------------------------------
  // Metnin ICINDE de var, BURADA da kontrol ediliyor: metindeki, baska bir
  // agda uretilmis bir imzanin burada gecerli OLMAMASINI saglar; buradaki,
  // dogru imzalanmis ama YANLIS AGA ait bir istegin erken ve okunur bicimde
  // reddedilmesini. Deger `getWebConfig()`ten gelir -- bu dosyada bir zincir
  // sabiti YOKTUR (`chain-registry.test.ts` ikinci bir kopyayi yasaklar).
  const config = getWebConfig()
  if (payload.chainId !== config.chain.id) return fail('wrongChain', 400)

  // ---- 5. MIKTAR BICIMLERI ---------------------------------------------
  // `BigInt(x)` cagrilmadan ONCE. `BigInt('  0x10 ')` calisir ve 16 doner --
  // yani ondalik bir alanda onaltilik bir sayi kabul edilirdi, ve imzalanan
  // metin ile saklanan sayi AYNI KALIRDI (metin ham dizeyi tasiyor). Bir
  // kullanici "10" imzalayip 16 birim taahhut edebilirdi.
  if (checkAmount(payload.amount) !== 'ok') return fail('badAmount', 400)
  if (checkAmount(payload.minOut) !== 'ok') return fail('badMinOut', 400)

  // ---- 6. `issued` PENCERESI -------------------------------------------
  const now = Date.now()
  const issued = checkOrderIssuedAt(payload.issuedAt, now)
  if (issued !== 'ok') return fail(issued === 'malformed' ? 'badRequest' : issued, 400)

  // ---- 7. SON KULLANMA PENCERESI ---------------------------------------
  const expiry = checkExpiresAt(payload.expiresAt, now)
  if (expiry !== 'ok') return fail(expiry === 'malformed' ? 'badRequest' : expiry, 400)

  // ---- 8. IMZA. BURAYA KADAR HICBIR I/O YAPILMADI. ---------------------
  if (!(await placeSignatureMatches(payload, signature))) return fail('badSignature', 401)

  const token = payload.token as HexAddress
  const owner = payload.owner as HexAddress

  // ---- 9. POSTGRES: on eleme (TEK sorgu) -------------------------------
  // Gecerli bir imza uretmek bedava oldugu icin imza tek basina kaynagimizi
  // korumaz. "Boyle bir token yok" ve "kotan dolu" en ucuz yerde cevaplanir.
  let pre: { launchExists: boolean; recentCount: number; openCount: number }
  try {
    pre = await orderPreflight(getPool(), token, owner, DEFAULT_ORDER_RATE_LIMIT.windowSeconds)
  } catch (error) {
    console.error('[orders] preflight query failed', error)
    return fail('databaseUnavailable', 503)
  }
  if (!pre.launchExists) return fail('unknownToken', 404)
  if (pre.recentCount >= DEFAULT_ORDER_RATE_LIMIT.maxPerWindow) return fail('rateLimited', 429)
  if (pre.openCount >= DEFAULT_ORDER_RATE_LIMIT.maxOpen) {
    return fail('tooManyOpen', 409, { detail: String(DEFAULT_ORDER_RATE_LIMIT.maxOpen) })
  }

  // ---- 10. YAZ ---------------------------------------------------------
  let outcome
  try {
    outcome = await placeOrder(getPool(), {
      token,
      ownerAddr: owner,
      isBuy: payload.isBuy,
      amount: BigInt(payload.amount),
      minOut: BigInt(payload.minOut),
      expiresAt: new Date(payload.expiresAt),
      nonceHex: payload.nonce,
      signatureHex: signature,
      issuedAt: new Date(payload.issuedAt),
    })
  } catch (error) {
    console.error('[orders] insert failed', error)
    return fail('databaseUnavailable', 503)
  }

  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'unknownToken':
        return fail('unknownToken', 404)
      case 'duplicateNonce':
        // 409, 400 DEGIL: istek KUSURSUZ bicimlidir ve imzasi gecerlidir --
        // yalnizca DAHA ONCE yazilmistir. Tekrar oynatma boyle gorunur.
        return fail('duplicateNonce', 409)
      case 'rateLimited':
        return fail('rateLimited', 429)
      case 'tooManyOpen':
        return fail('tooManyOpen', 409, { detail: String(outcome.maxOpen) })
      case 'rejected':
        console.error('[orders] a schema CHECK refused a row the route accepted', outcome.constraint)
        return fail('rejected', 400, outcome.constraint === null ? undefined : { detail: outcome.constraint })
    }
  }

  return Response.json({ ok: true, order: toOrderWire(outcome.row) }, { status: 201 })
}
