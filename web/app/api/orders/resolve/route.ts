import { cancelOrder, getOrder, markFilled } from '@arcpad/db'
import { isAddress } from 'viem'
import { getWebConfig } from '@/lib/addresses'
import { getPool } from '@/lib/db'
import {
  checkOrderIssuedAt,
  ORDER_ISSUED_PATTERN,
  ORDER_SIGNATURE_PATTERN,
  ORDER_TX_PATTERN,
  type OrderResolvePayload,
  resolveSignatureMatches,
} from '@/lib/limitOrder'
import { getFillReader } from '@/lib/orderFill'
import { toOrderWire } from '../route'
import type { HexAddress } from '@/components/read/types'

/**
 * ==========================================================================
 *  IKI TERMINAL GECIS: IPTAL VE DOLDU
 * ==========================================================================
 *
 * IKISI TEK ROTADA, cunku ikisi de AYNI seyi soruyor: "bu emrin sahibi
 * misin, ve emir hala canli mi". Ayri rotalar iki kopya dogurur ve bu depoda
 * ikilenen bir kontrolun HANGI kopyasinin kaydigi sorusu defalarca odendi.
 *
 * IKISI ARASINDAKI TEK FARK, `filled`in bir ZINCIR OLCUMU istemesidir --
 * `cancel` yalnizca bir imza ister, cunku iptal kullanicinin kendi kaydini
 * kapatmasidir ve zincirde bir karsiligi yoktur.
 *
 *   1-5  boy, JSON, alan bicimleri, zincir kimligi, `issued` penceresi -- SAF
 *   6    IMZADAN SAHIBI KURTAR                                         -- SAF
 *   ----------------------------------------------------------------------
 *   7    Postgres: emri oku (sahiplik + canlilik + curve)
 *   8    (yalnizca `filled`) ZINCIR: makbuz, tek `eth_getTransactionReceipt`
 *   9    Postgres: KOSULLU UPDATE
 *
 * 7'NIN 8'DEN ONCE OLMASI, chat'in 8-9 sirasiyla ayni sinif: gecerli bir imza
 * bedavadir, yani imza tek basina RPC kotamizi korumaz. "Boyle bir emir yok"
 * ve "bu emir zaten kapali" ZINCIRE HIC GITMEDEN cevaplanir.
 *
 * ==========================================================================
 *  9. ADIM BIR `if` DEGIL, BIR `WHERE`DIR
 * ==========================================================================
 *
 * Sahiplik ve canlilik 7. adimda ZATEN okundu -- ama o okuma ile UPDATE
 * arasinda bir pencere var ve o pencerede keeper emri tetikleyebilir,
 * kullanici baska bir sekmeden iptal edebilir. `cancelOrder` ve `markFilled`
 * on kosullarini kendi `WHERE`lerinde tasir (`packages/db/src/orders.ts`),
 * yani yarisi kaybeden taraf SIFIR satir gunceller ve 409 alir. Buradaki
 * okuma bir KARAR degil, bir UCUZ ELEMEDIR.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const RESOLVE_MAX_REQUEST_BYTES = 4 * 1024

function fail(error: string, status: number, extra?: Record<string, string>): Response {
  return Response.json({ error, ...(extra ?? {}) }, { status })
}

type Parsed = { payload: OrderResolvePayload; signature: string }

function parseBody(raw: unknown): Parsed | 'badRequest' {
  if (raw === null || typeof raw !== 'object') return 'badRequest'
  const doc = raw as Record<string, unknown>
  const str = (key: string): string | null =>
    typeof doc[key] === 'string' ? (doc[key] as string) : null

  const token = str('token')
  const owner = str('owner')
  const orderSeq = str('orderSeq')
  const intent = str('intent')
  const issuedAt = str('issuedAt')
  const signature = str('signature')
  const txHash = str('txHash') ?? ''
  const chainId = doc['chainId']

  if (token === null || owner === null || orderSeq === null || intent === null) return 'badRequest'
  if (issuedAt === null || signature === null) return 'badRequest'
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId)) return 'badRequest'
  if (!isAddress(token, { strict: false })) return 'badRequest'
  if (!isAddress(owner, { strict: false })) return 'badRequest'
  if (intent !== 'cancel' && intent !== 'filled') return 'badRequest'
  // `order_seq` `bigint`tir ve 19 hane onun tavani. Bir `Number` ile
  // ayristirmak 2^53'un ustunde SESSIZCE yuvarlar.
  if (!/^[1-9][0-9]{0,18}$/.test(orderSeq)) return 'badRequest'
  if (!ORDER_SIGNATURE_PATTERN.test(signature)) return 'badRequest'
  if (!ORDER_ISSUED_PATTERN.test(issuedAt)) return 'badRequest'
  if (intent === 'filled' && !ORDER_TX_PATTERN.test(txHash)) return 'badRequest'
  // `cancel`de bir `txHash` GONDERILMEMELI: metin onu tasimaz, yani gonderilen
  // deger imzalanmamis olurdu. Sessizce yok saymak, imzalanan sey ile
  // gonderilen sey arasinda bir bosluk acardi.
  if (intent === 'cancel' && txHash !== '') return 'badRequest'

  return {
    payload: {
      chainId,
      token: token.toLowerCase(),
      owner: owner.toLowerCase(),
      orderSeq,
      intent,
      txHash: txHash.toLowerCase(),
      issuedAt,
    },
    signature: signature.toLowerCase(),
  }
}

export async function POST(request: Request): Promise<Response> {
  let text: string
  try {
    text = await request.text()
  } catch {
    return fail('badRequest', 400)
  }
  if (new TextEncoder().encode(text).length > RESOLVE_MAX_REQUEST_BYTES) {
    return fail('requestTooLarge', 413)
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('badRequest', 400)
  }

  const parsed = parseBody(raw)
  if (parsed === 'badRequest') return fail('badRequest', 400)
  const { payload, signature } = parsed

  const config = getWebConfig()
  if (payload.chainId !== config.chain.id) return fail('wrongChain', 400)

  const issued = checkOrderIssuedAt(payload.issuedAt, Date.now())
  if (issued !== 'ok') return fail(issued === 'malformed' ? 'badRequest' : issued, 400)

  // ---- IMZA. BURAYA KADAR HICBIR I/O YAPILMADI. ------------------------
  if (!(await resolveSignatureMatches(payload, signature))) return fail('badSignature', 401)

  const owner = payload.owner as HexAddress
  const orderSeq = BigInt(payload.orderSeq)

  // ---- UCUZ ELEME: emri oku --------------------------------------------
  let existing
  try {
    existing = await getOrder(getPool(), orderSeq)
  } catch (error) {
    console.error('[orders] read failed', error)
    return fail('databaseUnavailable', 503)
  }
  // "Yok" ve "senin degil" AYNI CEVABI alir, ve bu bilincli: farkli cevaplar,
  // bir yabancinin `order_seq` tarayarak baskalarinin emirlerinin VARLIGINI
  // sayabilmesi demekti.
  if (existing === null || existing.ownerAddr.toLowerCase() !== owner.toLowerCase()) {
    return fail('unknownOrder', 404)
  }
  if (existing.token.toLowerCase() !== payload.token.toLowerCase()) {
    // Imza `token`i tasiyor, yani bu ancak istemcinin kendi kendine tutarsiz
    // bir istek uretmesiyle olur -- ama sessiz gecmez.
    return fail('unknownOrder', 404)
  }
  if (existing.status !== 'open' && existing.status !== 'triggered') {
    return fail('notLive', 409, { detail: existing.status })
  }

  // ---- IPTAL ------------------------------------------------------------
  if (payload.intent === 'cancel') {
    let result
    try {
      result = await cancelOrder(getPool(), orderSeq, owner)
    } catch (error) {
      console.error('[orders] cancel failed', error)
      return fail('databaseUnavailable', 503)
    }
    if (!result.changed || result.row === null) return fail('notLive', 409)
    return Response.json({ ok: true, order: toOrderWire(result.row) }, { status: 200 })
  }

  // ---- DOLDU: ONCE ZINCIR, SONRA YAZ ------------------------------------
  const reading = await getFillReader()({
    txHash: payload.txHash,
    owner,
    // CURVE ADRESI VERITABANINDAN, ISTEMCIDEN DEGIL. Istemciden alinsaydi,
    // sahip kendi kontratindan bir `Trade` yayip emri kapatabilirdi.
    curve: (await curveOf(existing.token)) as HexAddress,
  })
  if (!reading.ok) {
    if (reading.reason === 'unavailable') return fail('chainUnavailable', 503)
    return fail('receiptRejected', 400, { detail: reading.reason })
  }

  let result
  try {
    result = await markFilled(getPool(), orderSeq, owner, payload.txHash)
  } catch (error) {
    console.error('[orders] fill failed', error)
    return fail('databaseUnavailable', 503)
  }
  if (!result.changed || result.row === null) return fail('notLive', 409)
  return Response.json({ ok: true, order: toOrderWire(result.row) }, { status: 200 })
}

/** `launches.curve`, emrin token'indan. Bir emir token'a asilidir. */
async function curveOf(token: string): Promise<string> {
  const { rows } = await getPool().query<{ curve: string }>(
    'SELECT curve FROM launches WHERE token = $1',
    [token.toLowerCase()],
  )
  const curve = rows[0]?.curve
  if (curve === undefined) {
    // Emrin yabanci anahtari bunu imkansiz kilar; yine de sessiz bir
    // `undefined` ile devam etmek, makbuz kontrolunu `0xundefined`a karsi
    // yapardi ve HER makbuzu reddederdi -- yani kapi gorunmez bicimde
    // her zaman kapali olurdu.
    throw new Error(`limit_orders points at ${token}, which has no launches row`)
  }
  return curve
}
