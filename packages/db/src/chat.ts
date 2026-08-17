import type { Address } from './hex'
import { lower } from './hex'
import { type Pool, type Queryable, withTransaction } from './pool'

/**
 * ==========================================================================
 *  CHAT -- BU PAKETTEKI TEK KULLANICI-YAZILI TABLO
 * ==========================================================================
 *
 * `apply.ts` zincir olaylarini yazar ve her satirin `(tx_hash, log_index)`
 * capasi vardir. BURADA OYLE BIR CAPA YOKTUR: satirlar bir POST rotasindan
 * gelir. Dolayisiyla bu dosyanin sozlesmesi otekilerden farklidir ve farki
 * yazmak gerekiyor:
 *
 *   - YAZMA bir `Pool` ister, `Queryable` degil. Sebep bir uslup tercihi
 *     degil: hiz siniri ile INSERT AYNI transaction icinde olmak zorunda ve
 *     aralarinda bir advisory lock var; `Queryable` bir transaction acmayi
 *     ifade edemez.
 *   - OKUMA `Queryable` ister, cunku hicbir sey kilitlemez.
 *   - Reddedilmeler ATILMAZ, DONDURULUR. Bir POST rotasinin ihtiyaci olan sey
 *     "hangi kapi kapandi" bilgisidir ve onu `pg`nin hata kodlarindan rotada
 *     cozmek, sema bilgisini bu paketten disari sizdirmak olurdu.
 */

/** `chat_messages`in bir satiri, okumanin zenginlestirdigi iki alanla. */
export interface ChatMessageRow {
  messageSeq: bigint
  token: string
  authorAddr: string
  body: string
  /** GONDERI ANINDAKI bakiye -- zincirden, `balanceBlockNumber` bloğunda. */
  balanceTok: bigint
  /** Bakiyenin olculdugu blok. `balanceTok` bunsuz dogrulanamaz. */
  balanceBlockNumber: bigint
  nonceHex: string
  signatureHex: string
  issuedAt: Date
  createdAt: Date
  /**
   * YAZARIN SU ANKI bakiyesi -- `holders`tan, yani INDEXER'dan, zincirden
   * DEGIL. `null` yalnizca indexer'in o (token, holder) icin hic satiri
   * olmadigi anlamina gelir.
   *
   * BU ALAN `balanceTok`UN VAR OLMA SEBEBIDIR. Ikisi birlikte "gonderirken
   * neyi tutuyordu / su anda neyi tutuyor" sorusunu cevaplar; tek basina
   * hicbiri cevaplamaz, ve gecmis bir bakiyeyi zincire sormak bir archive
   * node ister. Panelin "sold since" rozeti tam olarak bu iki sayinin
   * karsilastirmasidir.
   */
  currentBalanceTok: bigint | null
  /** Yazar bu launch'i baslatan adres mi (`launches.launch_creator`). */
  isLaunchCreator: boolean
}

interface ChatRow {
  message_seq: string
  token: string
  author_addr: string
  body: string
  balance_tok: string
  balance_block_number: string
  nonce_hex: string
  signature_hex: string
  issued_at: Date
  created_at: Date
  current_balance_tok: string | null
  is_launch_creator: boolean
}

function toChatMessage(row: ChatRow): ChatMessageRow {
  return {
    messageSeq: BigInt(row.message_seq),
    token: row.token,
    authorAddr: row.author_addr,
    body: row.body,
    balanceTok: BigInt(row.balance_tok),
    balanceBlockNumber: BigInt(row.balance_block_number),
    nonceHex: row.nonce_hex,
    signatureHex: row.signature_hex,
    issuedAt: row.issued_at,
    createdAt: row.created_at,
    currentBalanceTok: row.current_balance_tok === null ? null : BigInt(row.current_balance_tok),
    isLaunchCreator: row.is_launch_creator,
  }
}

/**
 * SECILEN ALANLAR, TEK YERDE. Okuma ve yazma AYNI listeyi kullanir: yazma
 * yolunun donen satiri ile okuma yolunun satiri ayrisirsa, gonderilen mesaj
 * listede farkli gorunurdu.
 *
 * `m.token` uzerinden `launches`a JOIN INNER'dir ve olmali: yabanci anahtar
 * zaten satirin varligini garanti ediyor, yani INNER burada satir DUSURMEZ --
 * LEFT yazmak, dusmeyecegi bilinen bir dal icin `null` tasiyan bir tip
 * uretirdi.
 */
const CHAT_COLUMNS = `
    m.message_seq::text          AS message_seq,
    m.token                      AS token,
    m.author_addr                AS author_addr,
    m.body                       AS body,
    m.balance_tok::text          AS balance_tok,
    m.balance_block_number::text AS balance_block_number,
    m.nonce_hex                  AS nonce_hex,
    m.signature_hex              AS signature_hex,
    m.issued_at                  AS issued_at,
    m.created_at                 AS created_at,
    h.balance_tok::text          AS current_balance_tok,
    (l.launch_creator = m.author_addr) AS is_launch_creator`

const CHAT_FROM = `
    FROM chat_messages m
    JOIN launches l ON l.token = m.token
    LEFT JOIN holders h ON h.token = m.token AND h.holder = m.author_addr`

/**
 * BIR TOKEN'IN MESAJLARI, YENIDEN ESKIYE.
 *
 * ================== SIRA VE IMLEC AYNI IFADEDIR ==================
 *
 * `ORDER BY m.message_seq DESC` ve `m.message_seq < $imlec`. Anahtar birincil
 * anahtardir, yani BIREBIR: `holders`in iki parcali imlecine gerek yok, cunku
 * o imlec `balance_tok`un TEKRAR ETMESI yuzunden iki parcaliydi ve burada
 * tekrar YOKTUR. Bir zaman kolonu kullanilmamasinin gerekcesi migration
 * 013'te yazili.
 *
 * `before` bozuk gelirse ILK SAYFA: imlec URL'den ya da bir istemci
 * argumanindan gelir ve bir 500 ile odullendirilmemeli. Bu cozumleme cagiran
 * tarafta yapilir (`parseChatCursor`).
 */
export async function listChatMessages(
  db: Queryable,
  token: Address,
  options: { before?: bigint | null; limit?: number } = {},
): Promise<ChatMessageRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200)
  const before = options.before ?? null
  const { rows } = await db.query<ChatRow>(
    `SELECT ${CHAT_COLUMNS} ${CHAT_FROM}
      WHERE m.token = $1 AND ($2::bigint IS NULL OR m.message_seq < $2::bigint)
      ORDER BY m.message_seq DESC LIMIT $3`,
    [lower(token), before === null ? null : before.toString(), limit],
  )
  return rows.map(toChatMessage)
}

/** Imlec tel uzerinde ondalik bir tamsayidir; bozuk deger ILK SAYFADIR. */
export function parseChatCursor(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null
  if (!/^\d{1,19}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= 0n ? null : parsed
}

export function encodeChatCursor(row: { messageSeq: bigint }): string {
  return row.messageSeq.toString()
}

export interface ChatInsert {
  token: Address
  authorAddr: Address
  body: string
  balanceTok: bigint
  balanceBlockNumber: bigint
  nonceHex: string
  signatureHex: string
  issuedAt: Date
}

/**
 * HIZ SINIRI. Bir pencere, bir sayi, ve ikisi de cagiranda DEGIL BURADA
 * uygulanir -- cunku sayim ile INSERT'in ayni transaction'da olmasi sartinin
 * tek uygulanabilir yeri burasidir.
 */
export interface ChatRateLimit {
  /** Pencere, saniye. */
  windowSeconds: number
  /** Pencerede AYNI (token, yazar) icin izin verilen mesaj sayisi. */
  maxMessages: number
}

export const DEFAULT_CHAT_RATE_LIMIT: ChatRateLimit = { windowSeconds: 60, maxMessages: 5 }

export type ChatPostOutcome =
  | { ok: true; row: ChatMessageRow }
  /** `token` `launches`ta yok -- yabanci anahtar (23503). */
  | { ok: false; reason: 'unknownToken' }
  /** Ayni `nonce_hex` ikinci kez (23505). TEKRAR OYNATMA burada durur. */
  | { ok: false; reason: 'duplicateNonce' }
  /** Pencerede kota doldu. `retryAfterSeconds` penceredir, kalan sure degil. */
  | { ok: false; reason: 'rateLimited'; retryAfterSeconds: number }
  /** Bir CHECK reddetti; `constraint` hangisi oldugunu soyler (23514). */
  | { ok: false; reason: 'rejected'; constraint: string | null }

/**
 * ==========================================================================
 *  YAZMA. UC KAPI, TEK TRANSACTION.
 * ==========================================================================
 *
 * 1. ADVISORY LOCK, `(token, yazar)` uzerinde. BU SATIR OLMADAN HIZ SINIRI
 *    TAVSIYEDEN IBARETTIR ve bu OLCULDU: sayim ile INSERT arasinda
 *    serilestirilmemis N es zamanli istek, N mesajin hepsini yazar -- cunku
 *    hepsi ayni "su anda 0 mesaj var" anini gorur. `READ COMMITTED` bunu
 *    engellemez: okunmayan bir satir kilitlenemez.
 *
 *    Kilit TRANSACTION KAPSAMLIDIR (`_xact_`), yani COMMIT/ROLLBACK ile
 *    kendiliginden birakilir; bir hata yolunda unutulmasi MUMKUN DEGILDIR.
 *    Anahtar `hashtext(token), hashtext(yazar)` -- carpisma iki farkli
 *    (token, yazar) ciftini gereksizce serilestirir, ki bu YANLIS bir sonuc
 *    degil yalnizca kucuk bir bekleme; ters yonde bir hata uretmez.
 *
 * 2. PENCEREDEKI SAYIM. `created_at > now() - interval` bir SUZGECTIR;
 *    siralama degil (bkz. migration 013).
 *
 * 3. INSERT. Kalan her kural SEMANIN kendisindedir: bakiye `> 0`, govde
 *    uzunlugu, nonce UNIQUE, token yabanci anahtar. Bunlarin uygulama
 *    katmaninda da kontrol edilmesi iyi bir mesaj icindir; DOGRULUK burada
 *    durur.
 */
export async function postChatMessage(
  pool: Pool,
  input: ChatInsert,
  limit: ChatRateLimit = DEFAULT_CHAT_RATE_LIMIT,
): Promise<ChatPostOutcome> {
  const token = lower(input.token)
  const author = lower(input.authorAddr)

  try {
    return await withTransaction(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [token, author])

      const { rows: counted } = await tx.query<{ recent_count: string }>(
        `SELECT count(*)::text AS recent_count FROM chat_messages
          WHERE token = $1 AND author_addr = $2
            AND created_at > now() - make_interval(secs => $3::double precision)`,
        [token, author, limit.windowSeconds],
      )
      const recent = Number(counted[0]?.recent_count ?? '0')
      if (recent >= limit.maxMessages) {
        return { ok: false, reason: 'rateLimited', retryAfterSeconds: limit.windowSeconds } as const
      }

      /*
       * `INSERT ... RETURNING message_seq` DEGIL: donen satir OKUMA YOLUNUN
       * satiriyla AYNI sekle sahip olmali, yoksa gonderilen mesaj listede
       * baska turlu gorunurdu. Bu yuzden INSERT bir CTE'dir ve ustune okuma
       * yolunun JOIN'leri konur -- tek turda, tek anlik goruntu.
       */
      const { rows } = await tx.query<ChatRow>(
        `WITH inserted AS (
           INSERT INTO chat_messages
             (token, author_addr, body, balance_tok, balance_block_number,
              nonce_hex, signature_hex, issued_at)
           VALUES ($1, $2, $3, $4::numeric, $5::bigint, $6, $7, $8::timestamptz)
           RETURNING *
         )
         SELECT ${CHAT_COLUMNS}
           FROM inserted m
           JOIN launches l ON l.token = m.token
           LEFT JOIN holders h ON h.token = m.token AND h.holder = m.author_addr`,
        [
          token,
          author,
          input.body,
          input.balanceTok.toString(),
          input.balanceBlockNumber.toString(),
          input.nonceHex.toLowerCase(),
          input.signatureHex.toLowerCase(),
          input.issuedAt.toISOString(),
        ],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('postChatMessage: INSERT satir dondurmedi')
      return { ok: true, row: toChatMessage(row) } as const
    })
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string }
    if (pgError.code === '23503') return { ok: false, reason: 'unknownToken' }
    if (pgError.code === '23505') return { ok: false, reason: 'duplicateNonce' }
    if (pgError.code === '23514') {
      return { ok: false, reason: 'rejected', constraint: pgError.constraint ?? null }
    }
    throw error
  }
}

/**
 * ==========================================================================
 *  YAZMA ONCESI KONTROL -- TEK SORGUDA IKI CEVAP
 * ==========================================================================
 *
 * POST rotasinin ZINCIRE dokunmadan once bilmesi gereken iki sey var:
 *
 *   1. `token` INDEKSLENMIS BIR LAUNCH MI? Degilse yabanci anahtar zaten
 *      reddederdi -- ama o red INSERT aninda, yani ZINCIR OKUMASINDAN SONRA
 *      gelirdi. Yani gecerli bir imzasi olan biri, var olmayan adreslere POST
 *      atarak bizim RPC kotamizi yakabilirdi. Kontrol ONE alinmasinin sebebi
 *      budur, "daha guzel bir hata mesaji" degil.
 *   2. Pencerede kac mesaj yazmis? Ayni gerekce: hiz sinirina TAKILACAK bir
 *      istek icin zincir okumasi yapmak, sinirin korumaya calistigi kaynagi
 *      harcamak olurdu.
 *
 * BU SAYIM YETKILI DEGILDIR ve olmadigi yazili: `postChatMessage` sayimi
 * advisory lock ALTINDA bir daha yapar. Buradaki yalnizca ucuz bir on
 * elemedir; ikisi arasinda kalan bir yaris, ikinci sayimda kapanir.
 */
export async function chatPreflight(
  db: Queryable,
  token: Address,
  author: Address,
  windowSeconds: number,
): Promise<{ launchExists: boolean; recentCount: number }> {
  const { rows } = await db.query<{ launch_exists: boolean; recent_count: string }>(
    `SELECT EXISTS (SELECT 1 FROM launches WHERE token = $1) AS launch_exists,
            (SELECT count(*)::text FROM chat_messages
              WHERE token = $1 AND author_addr = $2
                AND created_at > now() - make_interval(secs => $3::double precision)
            ) AS recent_count`,
    [lower(token), lower(author), windowSeconds],
  )
  return {
    launchExists: rows[0]?.launch_exists ?? false,
    recentCount: Number(rows[0]?.recent_count ?? '0'),
  }
}

/** Yalnizca olcum ve test icin: penceredeki mesaj sayisi. */
export async function countRecentChatMessages(
  db: Queryable,
  token: Address,
  author: Address,
  windowSeconds: number,
): Promise<number> {
  const { rows } = await db.query<{ recent_count: string }>(
    `SELECT count(*)::text AS recent_count FROM chat_messages
      WHERE token = $1 AND author_addr = $2
        AND created_at > now() - make_interval(secs => $3::double precision)`,
    [lower(token), lower(author), windowSeconds],
  )
  return Number(rows[0]?.recent_count ?? '0')
}
