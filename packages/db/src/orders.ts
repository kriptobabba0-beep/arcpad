import type { Address } from './hex'
import { lower } from './hex'
import { type Pool, type Queryable, withTransaction } from './pool'

/**
 * ==========================================================================
 *  LIMIT ORDERS -- BU PAKETTEKI IKINCI KULLANICI-YAZILI TABLO
 * ==========================================================================
 *
 * `chat.ts`in sozlesmesi burada da gecerlidir (yazma bir `Pool` ister cunku
 * hiz siniri ile INSERT ayni transaction'da olmak zorunda; okuma `Queryable`
 * ister; reddedilmeler ATILMAZ, DONDURULUR). Farkli olan tek sey su:
 *
 *   BIR CHAT MESAJI YAZILDIKTAN SONRA BITER. BIR EMIR YAZILDIKTAN SONRA
 *   BASLAR.
 *
 * Yani bu dosyanin `chat.ts`te olmayan bir sorumlulugu var: **DURUM
 * GECISLERI**, ve para soz konusu oldugu icin hepsi KOSULLU UPDATE'tir --
 * "once oku, karar ver, sonra yaz" degil. Bir `SELECT` ile bir `UPDATE`
 * arasindaki her pencere, ayni emrin iki kez doldurulabilecegi bir penceredir.
 * Buradaki her gecis WHERE'inde kendi on kosulunu tasir ve `rowCount`la
 * dogrulanir; yaris kaybeden taraf SIFIR SATIR gunceller ve bunu ANLAR.
 *
 * ==========================================================================
 *  DURUM MAKINESI -- IZIN VERILEN TEK GECISLER
 * ==========================================================================
 *
 *      open ----------> triggered ----------> filled       (terminal)
 *        \                   \
 *         \--> cancelled <----/                            (terminal, sahibin)
 *          \-> expired  <----/                             (terminal, keeper'in)
 *
 * TERMINAL DURUMLARDAN CIKIS YOKTUR. Bu, "iptalden sonra dolmak" arizasinin
 * kapandigi yerdir ve tek bir `WHERE status = ...` ile kapanir -- uygulama
 * katmaninda bir `if` ile DEGIL, cunku o `if` ile UPDATE arasinda bir
 * transaction siniri vardir.
 */

export type OrderStatus = 'open' | 'triggered' | 'filled' | 'cancelled' | 'expired'

/** Bir emrin degistirilemez cekirdegi -- imzalanan metnin tam olarak tasidigi. */
export interface LimitOrderTerms {
  token: Address
  ownerAddr: Address
  isBuy: boolean
  /**
   * ALIMDA `msg.value` (18-decimal native USDC), SATIMDA `tokensIn`.
   * Hangisi oldugu `isBuy`tan okunur ve bu tip AYRIMI TASIMAZ -- tasisaydi
   * iki alanli bir tip olurdu ve cagiran yanlisini doldurabilirdi. Semada
   * ayrim `amount_wei` / `amount_tok` olarak ZORLANIR.
   */
  amount: bigint
  /** ALIMDA `minTokensOut`, SATIMDA `minQuoteOut`. Zincirin kendi argumani. */
  minOut: bigint
  expiresAt: Date
}

export interface LimitOrderRow extends LimitOrderTerms {
  orderSeq: bigint
  status: OrderStatus
  triggerBlockNumber: bigint | null
  fillTxHash: string | null
  nonceHex: string
  signatureHex: string
  issuedAt: Date
  createdAt: Date
}

interface OrderDbRow {
  order_seq: string
  token: string
  owner_addr: string
  is_buy: boolean
  amount_wei: string | null
  amount_tok: string | null
  min_out_tok: string | null
  min_out_wei: string | null
  status: OrderStatus
  expires_at: Date
  trigger_block_number: string | null
  fill_tx_hash: string | null
  nonce_hex: string
  signature_hex: string
  issued_at: Date
  created_at: Date
}

/**
 * SATIR -> MODEL, VE BURASI DORT SUTUNU IKIYE INDIREN TEK YERDIR.
 *
 * Semanin `limit_orders_side_units_check`i tam olarak iki sutunun dolu
 * olmasini garanti eder, yani buradaki `??` bir varsayim degil semanin
 * tasidigi bir olgudur. Yine de `null` gelirse ATILIR: sessizce `0n` yazmak,
 * bir emri "sifir miktar" gibi gosterip taramadan dusururdu.
 */
function toOrder(row: OrderDbRow): LimitOrderRow {
  const amount = row.is_buy ? row.amount_wei : row.amount_tok
  const minOut = row.is_buy ? row.min_out_tok : row.min_out_wei
  if (amount === null || minOut === null) {
    throw new Error(
      `limit_orders ${row.order_seq}: is_buy=${row.is_buy} but the matching amount/minOut column is NULL. ` +
        'The schema CHECK that makes this impossible must have been dropped.',
    )
  }
  return {
    orderSeq: BigInt(row.order_seq),
    token: row.token as Address,
    ownerAddr: row.owner_addr as Address,
    isBuy: row.is_buy,
    amount: BigInt(amount),
    minOut: BigInt(minOut),
    status: row.status,
    expiresAt: row.expires_at,
    triggerBlockNumber: row.trigger_block_number === null ? null : BigInt(row.trigger_block_number),
    fillTxHash: row.fill_tx_hash,
    nonceHex: row.nonce_hex,
    signatureHex: row.signature_hex,
    issuedAt: row.issued_at,
    createdAt: row.created_at,
  }
}

const ORDER_COLUMNS = `
    o.order_seq::text            AS order_seq,
    o.token                      AS token,
    o.owner_addr                 AS owner_addr,
    o.is_buy                     AS is_buy,
    o.amount_wei::text           AS amount_wei,
    o.amount_tok::text           AS amount_tok,
    o.min_out_tok::text          AS min_out_tok,
    o.min_out_wei::text          AS min_out_wei,
    o.status                     AS status,
    o.expires_at                 AS expires_at,
    o.trigger_block_number::text AS trigger_block_number,
    o.fill_tx_hash               AS fill_tx_hash,
    o.nonce_hex                  AS nonce_hex,
    o.signature_hex              AS signature_hex,
    o.issued_at                  AS issued_at,
    o.created_at                 AS created_at`

/** Durumu terminal OLMAYAN emirler. Keeper'in ilgilendigi tek kume. */
export const LIVE_STATUSES: readonly OrderStatus[] = ['open', 'triggered']

// ---------------------------------------------------------------
// Okuma
// ---------------------------------------------------------------

/**
 * BIR SAHIBIN BIR TOKEN'DAKI EMIRLERI, YENIDEN ESKIYE ("Orders" sekmesi).
 *
 * `ORDER BY o.order_seq DESC` -- bir zaman kolonu KULLANILMAZ ve gerekcesi
 * migration 013/014'te yazili. Imlec birincil anahtardir, yani birebirdir ve
 * tek parcalidir.
 */
export async function listOrders(
  db: Queryable,
  token: Address,
  owner: Address,
  options: { before?: bigint | null; limit?: number } = {},
): Promise<LimitOrderRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200)
  const before = options.before ?? null
  const { rows } = await db.query<OrderDbRow>(
    `SELECT ${ORDER_COLUMNS} FROM limit_orders o
      WHERE o.token = $1 AND o.owner_addr = $2
        AND ($3::bigint IS NULL OR o.order_seq < $3::bigint)
      ORDER BY o.order_seq DESC LIMIT $4`,
    [lower(token), lower(owner), before === null ? null : before.toString(), limit],
  )
  return rows.map(toOrder)
}

/**
 * KEEPER'IN TARAMA SORGUSU. Terminal olmayan her emir, TOKEN'A GORE GRUPLU.
 *
 * `ORDER BY o.token, o.order_seq` -- rezervler token basina BIR KEZ okunur ve
 * o token'in butun emirleri o tek okumayi paylasir. Sira `_at` tasimaz.
 *
 * `limit` bir GECISIN TAVANIDIR ve bilerek vardir: bir gecisin maliyeti
 * ONGORULEBILIR olmali (bkz. `keeper/src/orders/scan.ts`in maliyet hesabi).
 * Tavana dayanan bir gecis kalan emirleri BIR SONRAKI gecise birakir; emirler
 * kaybolmaz, yalnizca gecikir.
 */
export async function listLiveOrders(
  db: Queryable,
  options: { limit?: number; token?: Address } = {},
): Promise<LimitOrderRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5_000)
  const token = options.token === undefined ? null : lower(options.token)
  const { rows } = await db.query<OrderDbRow>(
    `SELECT ${ORDER_COLUMNS} FROM limit_orders o
      WHERE o.status = ANY($1::text[])
        AND ($2::text IS NULL OR o.token = $2::text)
      ORDER BY o.token, o.order_seq LIMIT $3`,
    [LIVE_STATUSES, token, limit],
  )
  return rows.map(toOrder)
}

export async function getOrder(db: Queryable, orderSeq: bigint): Promise<LimitOrderRow | null> {
  const { rows } = await db.query<OrderDbRow>(
    `SELECT ${ORDER_COLUMNS} FROM limit_orders o WHERE o.order_seq = $1`,
    [orderSeq.toString()],
  )
  const row = rows[0]
  return row === undefined ? null : toOrder(row)
}

/** Imlec tel uzerinde ondalik bir tamsayidir; bozuk deger ILK SAYFADIR. */
export function parseOrderCursor(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null
  if (!/^\d{1,19}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= 0n ? null : parsed
}

export function encodeOrderCursor(row: { orderSeq: bigint }): string {
  return row.orderSeq.toString()
}

// ---------------------------------------------------------------
// Yazma -- yerlestirme
// ---------------------------------------------------------------

export interface OrderInsert extends LimitOrderTerms {
  nonceHex: string
  signatureHex: string
  issuedAt: Date
}

/**
 * IKI SINIR, VE IKINCISI KEEPER'IN MALIYETINDEN GELIR.
 *
 * `maxPerWindow` bir hiz siniridir ve `chat`inkiyle ayni sekildedir. `maxOpen`
 * ise FARKLI bir seydir ve nedeni yazili: acik bir emir kalici bir TARAMA
 * MALIYETIDIR -- her geciste okunur. Hiz siniri "dakikada kac emir
 * yazabilirsin"i sinirlar; acik-emir tavani "aynı anda kac emrim
 * taranabilir"i. Ilkini gecmeden ikincisini doldurmak mumkundur (dakikada 5,
 * bes dakika boyunca), yani tek sinir yeterli DEGILDIR.
 */
export interface OrderRateLimit {
  windowSeconds: number
  maxPerWindow: number
  maxOpen: number
}

export const DEFAULT_ORDER_RATE_LIMIT: OrderRateLimit = {
  windowSeconds: 60,
  maxPerWindow: 5,
  maxOpen: 20,
}

export type OrderPlaceOutcome =
  | { ok: true; row: LimitOrderRow }
  /** `token` `launches`ta yok -- yabanci anahtar (23503). */
  | { ok: false; reason: 'unknownToken' }
  /** Ayni `nonce_hex` ikinci kez (23505). TEKRAR OYNATMA burada durur. */
  | { ok: false; reason: 'duplicateNonce' }
  | { ok: false; reason: 'rateLimited'; retryAfterSeconds: number }
  /** Acik emir tavani dolu. Hiz sinirindan AYRI bir kapi -- yukariya bakin. */
  | { ok: false; reason: 'tooManyOpen'; maxOpen: number }
  | { ok: false; reason: 'rejected'; constraint: string | null }

/**
 * ==========================================================================
 *  YERLESTIRME. UC KAPI, TEK TRANSACTION -- `postChatMessage` ILE AYNI SEKIL.
 * ==========================================================================
 *
 * 1. ADVISORY LOCK, `(token, sahip)` uzerinde. Bu satir olmadan HER IKI sinir
 *    da TAVSIYEDEN IBARETTIR: sayim ile INSERT arasinda serilestirilmemis N
 *    es zamanli istek hepsini yazar, cunku hepsi ayni "su anda k tane var"
 *    anini gorur. `READ COMMITTED` bunu engellemez -- okunmayan bir satir
 *    kilitlenemez.
 * 2. IKI SAYIM, TEK SORGUDA. Pencere sayimi ve acik emir sayimi.
 * 3. INSERT. Kalan her kural SEMANIN kendisindedir.
 */
export async function placeOrder(
  pool: Pool,
  input: OrderInsert,
  limit: OrderRateLimit = DEFAULT_ORDER_RATE_LIMIT,
): Promise<OrderPlaceOutcome> {
  const token = lower(input.token)
  const owner = lower(input.ownerAddr)

  try {
    return await withTransaction(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [token, owner])

      const { rows: counted } = await tx.query<{ recent_count: string; open_count: string }>(
        `SELECT
           count(*) FILTER (
             WHERE created_at > now() - make_interval(secs => $3::double precision)
           )::text AS recent_count,
           count(*) FILTER (WHERE status = ANY($4::text[]))::text AS open_count
         FROM limit_orders WHERE token = $1 AND owner_addr = $2`,
        [token, owner, limit.windowSeconds, LIVE_STATUSES],
      )
      const recent = Number(counted[0]?.recent_count ?? '0')
      const open = Number(counted[0]?.open_count ?? '0')
      if (recent >= limit.maxPerWindow) {
        return { ok: false, reason: 'rateLimited', retryAfterSeconds: limit.windowSeconds } as const
      }
      if (open >= limit.maxOpen) {
        return { ok: false, reason: 'tooManyOpen', maxOpen: limit.maxOpen } as const
      }

      const { rows } = await tx.query<OrderDbRow>(
        `WITH inserted AS (
           INSERT INTO limit_orders
             (token, owner_addr, is_buy, amount_wei, amount_tok, min_out_tok, min_out_wei,
              status, expires_at, nonce_hex, signature_hex, issued_at)
           VALUES ($1, $2, $3,
                   $4::numeric, $5::numeric, $6::numeric, $7::numeric,
                   'open', $8::timestamptz, $9, $10, $11::timestamptz)
           RETURNING *
         )
         SELECT ${ORDER_COLUMNS} FROM inserted o`,
        [
          token,
          owner,
          input.isBuy,
          input.isBuy ? input.amount.toString() : null,
          input.isBuy ? null : input.amount.toString(),
          input.isBuy ? input.minOut.toString() : null,
          input.isBuy ? null : input.minOut.toString(),
          input.expiresAt.toISOString(),
          input.nonceHex.toLowerCase(),
          input.signatureHex.toLowerCase(),
          input.issuedAt.toISOString(),
        ],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('placeOrder: INSERT satir dondurmedi')
      return { ok: true, row: toOrder(row) } as const
    })
  } catch (error) {
    return classify(error)
  }
}

function classify(error: unknown): OrderPlaceOutcome {
  const pgError = error as { code?: string; constraint?: string }
  if (pgError.code === '23503') return { ok: false, reason: 'unknownToken' }
  if (pgError.code === '23505') return { ok: false, reason: 'duplicateNonce' }
  if (pgError.code === '23514') {
    return { ok: false, reason: 'rejected', constraint: pgError.constraint ?? null }
  }
  throw error
}

/**
 * YAZMA ONCESI KONTROL -- `chatPreflight` ile ayni gerekce.
 *
 * Gecerli bir imza uretmek bir cuzdan sahibi icin BEDAVADIR, yani imza tek
 * basina RPC kotamizi korumaz. "Boyle bir token yok" ve "kotan dolu"
 * cevaplari ZINCIRE HIC GITMEDEN verilir. Bu sayim YETKILI DEGILDIR;
 * `placeOrder` onu advisory lock ALTINDA bir daha yapar.
 */
export async function orderPreflight(
  db: Queryable,
  token: Address,
  owner: Address,
  windowSeconds: number,
): Promise<{ launchExists: boolean; recentCount: number; openCount: number }> {
  const { rows } = await db.query<{
    launch_exists: boolean
    recent_count: string
    open_count: string
  }>(
    `SELECT EXISTS (SELECT 1 FROM launches WHERE token = $1) AS launch_exists,
            (SELECT count(*)::text FROM limit_orders
              WHERE token = $1 AND owner_addr = $2
                AND created_at > now() - make_interval(secs => $3::double precision)
            ) AS recent_count,
            (SELECT count(*)::text FROM limit_orders
              WHERE token = $1 AND owner_addr = $2 AND status = ANY($4::text[])
            ) AS open_count`,
    [lower(token), lower(owner), windowSeconds, LIVE_STATUSES],
  )
  return {
    launchExists: rows[0]?.launch_exists ?? false,
    recentCount: Number(rows[0]?.recent_count ?? '0'),
    openCount: Number(rows[0]?.open_count ?? '0'),
  }
}

// ---------------------------------------------------------------
// Yazma -- durum gecisleri
// ---------------------------------------------------------------

/**
 * ==========================================================================
 *  HER GECIS KOSULLU BIR UPDATE'TIR, VE ON KOSUL `WHERE`IN ICINDEDIR
 * ==========================================================================
 *
 * "Once oku, kontrol et, sonra yaz" burada YANLIS OLURDU ve neden yanlis
 * oldugu somuttur: keeper bir emri `triggered` yaparken kullanici ayni anda
 * onu iptal ediyor olabilir. Iki islem de "durum open" gordugu icin ikisi de
 * yazar ve son yazan kazanir -- yani IPTAL EDILMIS bir emir `triggered`
 * gorunebilir. `WHERE status = 'open'` bunu Postgres'in satir kilidine
 * havale eder: kaybeden taraf SIFIR satir gunceller ve `false` doner.
 *
 * DONUS DEGERI BILEREK `boolean`: cagiran "benim gecisim oldu mu" sorusunu
 * sormak ZORUNDA kalir. `void` donseydi, kaybedilmis bir yaris SESSIZ olurdu.
 */
export type TransitionResult = { changed: boolean; row: LimitOrderRow | null }

async function transition(
  db: Queryable,
  orderSeq: bigint,
  set: string,
  from: readonly OrderStatus[],
  params: readonly unknown[],
): Promise<TransitionResult> {
  const { rows } = await db.query<OrderDbRow>(
    `WITH updated AS (
       UPDATE limit_orders SET ${set}
        WHERE order_seq = $1 AND status = ANY($2::text[])
        RETURNING *
     )
     SELECT ${ORDER_COLUMNS} FROM updated o`,
    [orderSeq.toString(), from, ...params],
  )
  const row = rows[0]
  return row === undefined ? { changed: false, row: null } : { changed: true, row: toOrder(row) }
}

/**
 * KEEPER: "bu emir su blokta zincirde kabul edilebilirdi".
 *
 * YALNIZCA `open`DAN. Zaten `triggered` olan bir emri tekrar tetiklemek blok
 * numarasini ILERI ITERDI ve o sutunun tasidigi tek sey ILK gozlemdir --
 * "ne zamandan beri doldurulabilir" sorusunun cevabi. `changed: false`
 * burada bir ariza degil, olagan bir sonuctur.
 */
export async function markTriggered(
  db: Queryable,
  orderSeq: bigint,
  blockNumber: bigint,
): Promise<TransitionResult> {
  return transition(
    db,
    orderSeq,
    'status = \'triggered\', trigger_block_number = $3::bigint',
    ['open'],
    [blockNumber.toString()],
  )
}

/**
 * KEEPER: suresi gecti (spec §8, gorev 4).
 *
 * `open` VE `triggered`den. Tetiklenmis ama doldurulmamis bir emir de suresi
 * gectiginde olur -- "doldurulabilirdi" bir gecmis zamandir, bir rezervasyon
 * degil.
 */
export async function markExpired(db: Queryable, orderSeq: bigint): Promise<TransitionResult> {
  return transition(db, orderSeq, "status = 'expired'", ['open', 'triggered'], [])
}

/**
 * SUPURME, TOPLU. `expires_at <= $1` olan her canli emir.
 *
 * ZAMAN DISARIDAN VERILIR, `now()` DEGIL. Sebep bir uslup tercihi degil:
 * keeper'in gecisi zincirin BLOK ZAMANINA gore karar verir ve zincirin saati
 * ile veritabaninin saati ayni degildir. Ayrica disaridan verilen bir zaman
 * TEST EDILEBILIR; `now()` degildir.
 */
export async function expireDueOrders(db: Queryable, asOf: Date): Promise<bigint[]> {
  const { rows } = await db.query<{ order_seq: string }>(
    `UPDATE limit_orders SET status = 'expired'
      WHERE status = ANY($1::text[]) AND expires_at <= $2::timestamptz
      RETURNING order_seq::text AS order_seq`,
    [LIVE_STATUSES, asOf.toISOString()],
  )
  return rows.map((r) => BigInt(r.order_seq))
}

/**
 * SAHIP: iptal.
 *
 * `open` VE `triggered`den, terminal durumlardan DEGIL. "Doldu ama ben iptal
 * ettim" temsil edilemez olmali.
 *
 * SAHIPLIK BURADA DA KONTROL EDILIR, yalnizca rotada degil: `owner_addr = $3`
 * WHERE'in icindedir. Rotada bir `if`in atlanmasi, baskasinin emrini iptal
 * ettirmemeli.
 */
export async function cancelOrder(
  db: Queryable,
  orderSeq: bigint,
  owner: Address,
): Promise<TransitionResult> {
  const { rows } = await db.query<OrderDbRow>(
    `WITH updated AS (
       UPDATE limit_orders SET status = 'cancelled'
        WHERE order_seq = $1 AND status = ANY($2::text[]) AND owner_addr = $3
        RETURNING *
     )
     SELECT ${ORDER_COLUMNS} FROM updated o`,
    [orderSeq.toString(), LIVE_STATUSES, lower(owner)],
  )
  const row = rows[0]
  return row === undefined ? { changed: false, row: null } : { changed: true, row: toOrder(row) }
}

/**
 * SAHIP (makbuz DOGRULANDIKTAN sonra): doldu.
 *
 * `open` VE `triggered`den -- kullanici keeper'i beklemeden de doldurabilir ve
 * doldurmalidir: zincir emrin kendi sinirini zaten uyguluyor, yani "keeper
 * henuz tetiklemedi" bir kilit DEGILDIR.
 *
 * IPTAL EDILMIS BIR EMIR DOLDURULAMAZ ve bu tam olarak `LIVE_STATUSES`in
 * yaptigi istir: `cancelled` listede olmadigi icin UPDATE sifir satir bulur.
 * "Iptalden sonra dolmak" bu tek satirda kapanir -- ve `orders.test.ts` bunu
 * bir mutantla olcuyor.
 */
export async function markFilled(
  db: Queryable,
  orderSeq: bigint,
  owner: Address,
  txHash: string,
): Promise<TransitionResult> {
  const { rows } = await db.query<OrderDbRow>(
    `WITH updated AS (
       UPDATE limit_orders SET status = 'filled', fill_tx_hash = $4
        WHERE order_seq = $1 AND status = ANY($2::text[]) AND owner_addr = $3
        RETURNING *
     )
     SELECT ${ORDER_COLUMNS} FROM updated o`,
    [orderSeq.toString(), LIVE_STATUSES, lower(owner), txHash.toLowerCase()],
  )
  const row = rows[0]
  return row === undefined ? { changed: false, row: null } : { changed: true, row: toOrder(row) }
}

/** Yalnizca olcum ve test icin: penceredeki emir sayisi. */
export async function countRecentOrders(
  db: Queryable,
  token: Address,
  owner: Address,
  windowSeconds: number,
): Promise<number> {
  const { rows } = await db.query<{ recent_count: string }>(
    `SELECT count(*)::text AS recent_count FROM limit_orders
      WHERE token = $1 AND owner_addr = $2
        AND created_at > now() - make_interval(secs => $3::double precision)`,
    [lower(token), lower(owner), windowSeconds],
  )
  return Number(rows[0]?.recent_count ?? '0')
}
