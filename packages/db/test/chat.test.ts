import { beforeEach, describe, expect, it } from 'vitest'
import { applyLaunch, replayRange } from '../src/apply'
import {
  type ChatInsert,
  type ChatRateLimit,
  countRecentChatMessages,
  DEFAULT_CHAT_RATE_LIMIT,
  encodeChatCursor,
  listChatMessages,
  parseChatCursor,
  postChatMessage,
} from '../src/chat'
import { putDeployment } from '../src/deployment'
import type { Address } from '../src/hex'
import { toSeq } from '../src/seq'
import { pool, resetSchema } from './setup'
import {
  addr,
  ALICE,
  BOB,
  CREATOR,
  DEPLOYMENT,
  GENESIS,
  hash32,
  hashFor,
  LAUNCH,
  RANGE,
  RANGE_TO,
  TOKEN,
} from './fixtures'

/**
 * ==========================================================================
 *  chat_messages -- SEMANIN INDEXER'IN YAZMADIGI TEK TABLOSU
 * ==========================================================================
 *
 * Buradaki her iddia GERCEK bir Postgres'e karsi kosar. Bunun sebebi bu
 * fazda ozellikle keskin: chat'i tasiyan garantilerin cogu UYGULAMA
 * KODUNDA DEGIL SEMADA yasiyor -- nonce'un UNIQUE'i (tekrar oynatma),
 * `balance_tok > 0` (holder kapisi), yabanci anahtar (bilinmeyen token),
 * ve `GENERATED ALWAYS AS IDENTITY` (siranin cagiran tarafindan
 * SECILEMEZ olmasi). Bir sahte veritabani bunlarin hicbirini kanitlamaz.
 */

let nonceCounter = 0
function nonce(): string {
  nonceCounter += 1
  return `0x${nonceCounter.toString(16).padStart(64, '0')}`
}

const SIGNATURE = `0x${'ab'.repeat(65)}`

function message(overrides: Partial<ChatInsert> = {}): ChatInsert {
  return {
    token: TOKEN,
    authorAddr: ALICE,
    body: 'gm',
    balanceTok: 1_000n * 10n ** 18n,
    balanceBlockNumber: 55_870_261n,
    nonceHex: nonce(),
    signatureHex: SIGNATURE,
    issuedAt: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  }
}

/**
 * IKINCI BIR LAUNCH. `applyLaunch` KULLANILIR, elle bir INSERT DEGIL: bir
 * INSERT sutun adlarini test dosyasina kopyalar ve sema degistiginde SESSIZCE
 * degil GURULTULU bicimde ama YANLIS yerde kirilir (ilk deneme tam olarak
 * boyle kirildi: `launches`ta `block_number` diye bir sutun yok).
 */
async function secondLaunch(token: Address, n: number): Promise<Address> {
  await applyLaunch(pool, {
    ...LAUNCH,
    eventSeq: toSeq(54_900_000n + BigInt(n), 0),
    blockNumber: 54_900_000n + BigInt(n),
    logIndex: 0,
    txHash: hash32(0xdd00 + n),
    token,
    curve: addr(0xc900 + n),
    salt: hash32(0x5900 + n),
  })
  return token
}

/** Semayi kurar ve fixture araligini oynatir; ALICE ve CURVE holder olur. */
async function seed(): Promise<void> {
  await resetSchema()
  await putDeployment(pool, DEPLOYMENT)
  await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), GENESIS)
}

describe('chat: yazma ve okuma', () => {
  beforeEach(seed)

  it('yazilan satir OKUMA YOLUNUN sekliyle geri gelir -- her alan', async () => {
    const input = message({ body: 'first post', balanceTok: 42n, balanceBlockNumber: 12n })
    const posted = await postChatMessage(pool, input)
    expect(posted.ok).toBe(true)
    if (!posted.ok) return

    const [read] = await listChatMessages(pool, TOKEN)
    expect(read).toBeDefined()
    // YAZMANIN DONDURDUGU SATIR ILE OKUMANIN DONDURDUGU SATIR AYNI OLMAK
    // ZORUNDA: ayrilsalardi, gonderilen mesaj listeye girdiginde baska
    // gorunurdu ve bunu hicbir bileşen testi yakalayamazdi.
    expect(read).toEqual(posted.row)

    expect(read?.token).toBe(TOKEN)
    expect(read?.authorAddr).toBe(ALICE)
    expect(read?.body).toBe('first post')
    expect(read?.balanceTok).toBe(42n)
    expect(read?.balanceBlockNumber).toBe(12n)
    expect(read?.signatureHex).toBe(SIGNATURE)
    expect(read?.nonceHex).toBe(input.nonceHex)
    expect(read?.issuedAt.toISOString()).toBe('2026-08-10T00:00:00.000Z')
    // `bigint`, `number` DEGIL: `pg` numeric/bigint'i string dondurur ve
    // `Number`a cevirmek 2^53 ustunde sessizce hassasiyet kaybeder.
    expect(typeof read?.balanceTok).toBe('bigint')
    expect(typeof read?.messageSeq).toBe('bigint')
  })

  it('GOVDE IMZALANDIGI GIBI SAKLANIR -- temizlenmez, kirpilmaz', async () => {
    // `pgSafeText` bu sutuna UYGULANMAZ. Sebep: `signature_hex` tam olarak bu
    // dizenin uzerinde. Tek bir karakteri degistirmek satirin kendi delilini
    // gecersiz kilardi.
    const body = '  gm   fren  <b>not html</b>  🚀 '
    const posted = await postChatMessage(pool, message({ body }))
    expect(posted.ok).toBe(true)
    const [read] = await listChatMessages(pool, TOKEN)
    expect(read?.body).toBe(body)
  })

  it('yazarin SU ANKI bakiyesi `holders`tan gelir -- ve satista yaziyla AYRISIR', async () => {
    // ALICE fixture araliginda alim yapip SATIYOR, yani `holders` satiri
    // gonderi anindaki iddiadan farkli olabilir. Burada gonderi aninda 10^24
    // iddia ediliyor; indexer'in tuttugu sayi ondan bagimsiz.
    await postChatMessage(pool, message({ authorAddr: ALICE, balanceTok: 10n ** 24n }))
    const [read] = await listChatMessages(pool, TOKEN)
    expect(read?.balanceTok).toBe(10n ** 24n)
    expect(read?.currentBalanceTok).not.toBeNull()
    expect(read?.currentBalanceTok).not.toBe(read?.balanceTok)

    // ============ BU IKI SAYININ AYRI OLMASI KOLONUN VAR OLMA SEBEBI ========
    // `balanceOf` GECMIS bir blok icin bir archive node ister. Gonderi anindaki
    // bakiye saklanmasa, "gonderirken tutuyordu, simdi tutmuyor" cumlesi
    // KURULAMAZDI -- ve o cumle spec'in chat kotuye kullanim satirindaki
    // ucuncu karsi-onlemin tamamidir.
    expect(read?.currentBalanceTok).toBeLessThan(read?.balanceTok ?? 0n)
  })

  it('hic satiri olmayan bir yazarin SU ANKI bakiyesi `null`, SIFIR DEGIL', async () => {
    // ============ FIXTURE SECIMI OLCULEREK YAPILDI ============
    // Ilk yazilisinda burada BOB vardi ve test DUSTU: BOB fixture araliginda
    // token aliyor, yani `holders` satiri VAR (792.5M). Yani "satiri olmayan
    // yazar" dali hic kosmuyordu -- testin ISMININ olctugunu sandigi sey ile
    // gercekte olctugu sey ayrisiyordu. `STRANGER` bu tabloda hicbir zaman
    // gorunmemis bir adres.
    //
    // Ayrimin kendisi onemli: `0` "hicbir sey tutmuyor" der, `null` "indexer
    // bilmiyor" der. Ikisi ayni ekran degildir ve `LEFT JOIN`i `COALESCE(...,0)`
    // ile kapatan bir mutant tam olarak bu farki yok ederdi.
    const STRANGER = addr(0xf00d)
    const { rows: none } = await pool.query(
      'SELECT 1 FROM holders WHERE token = $1 AND holder = $2',
      [TOKEN, STRANGER],
    )
    expect(none).toHaveLength(0)

    await postChatMessage(pool, message({ authorAddr: STRANGER }))
    const [read] = await listChatMessages(pool, TOKEN)
    expect(read?.authorAddr).toBe(STRANGER)
    expect(read?.currentBalanceTok).toBeNull()
  })

  it('launch creator isaretlenir, baskasi isaretlenmez', async () => {
    await postChatMessage(pool, message({ authorAddr: CREATOR }))
    await postChatMessage(pool, message({ authorAddr: BOB }))
    const rows = await listChatMessages(pool, TOKEN)
    expect(rows.map((r) => [r.authorAddr, r.isLaunchCreator])).toEqual([
      [BOB, false],
      [CREATOR, true],
    ])
  })

  it('BUYUK HARFLI adres kucultulerek yazilir', async () => {
    const mixed = ALICE.toUpperCase().replace('0X', '0x') as Address
    expect(mixed).not.toBe(ALICE)
    const posted = await postChatMessage(pool, message({ authorAddr: mixed }))
    expect(posted.ok).toBe(true)
    const [read] = await listChatMessages(pool, TOKEN)
    expect(read?.authorAddr).toBe(ALICE)
  })
})

// ==========================================================================
//  SIRA VE KEYSET
// ==========================================================================

describe('chat: sira `message_seq`, ve zaman damgasi OLAMAZ', () => {
  beforeEach(seed)

  async function postMany(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await postChatMessage(pool, message({ body: `m${i}` }), {
        windowSeconds: 60,
        maxMessages: 1000,
      })
    }
  }

  it('keyset sayfalama TEKRARLATMAZ VE ATLATMAZ', async () => {
    await postMany(7)

    const seen: string[] = []
    let cursor: bigint | null = null
    for (let page = 0; page < 10; page++) {
      const rows: Awaited<ReturnType<typeof listChatMessages>> = await listChatMessages(
        pool,
        TOKEN,
        { before: cursor, limit: 2 },
      )
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.body))
      const last = rows[rows.length - 1]
      cursor = last === undefined ? null : last.messageSeq
      if (rows.length < 2) break
    }

    // Yediyi de bir kez, ve YENIDEN ESKIYE.
    expect(seen).toEqual(['m6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0'])
    expect(new Set(seen).size).toBe(7)
  })

  /**
   * ==========================================================================
   *  NEGATIF KONTROL: AYNI KEYSET'I `created_at` UZERINDE KURMAK VERI KAYBEDER
   * ==========================================================================
   *
   * Bu, `event_seq` kuralinin chat tarafindaki karsiligidir ve OLCULEREK
   * gosteriliyor: alti satirin damgasi esitlendiginde `created_at < imlec`
   * suzgeci IKINCI SAYFADA SIFIR satir dondurur, yani dort satir HICBIR
   * sayfada gorunmez. Ayni veri uzerinde `message_seq` altisini da verir.
   *
   * Damgalarin esitlenmesi kurgu DEGIL: `now()` bir transaction icinde
   * SABITTIR ve Arc'ta ardisik bloklarin %49'unun timestamp'i zaten esittir --
   * bu tablo zincirden beslenmese de ayni sinif hata ayni bicimde ulasilir.
   */
  it('NEGATIF KONTROL: esit `created_at` uzerinde keyset DORT SATIR KAYBEDER', async () => {
    await postMany(6)
    await pool.query(`UPDATE chat_messages SET created_at = timestamptz '2026-08-10 00:00:00Z'`)

    // (a) ZAMAN ANAHTARIYLA: ikinci sayfa BOS.
    const timeKeyed = async (before: Date | null) => {
      const { rows } = await pool.query<{ body: string; created_at: Date }>(
        `SELECT body, created_at FROM chat_messages
          WHERE token = $1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
          ORDER BY created_at DESC LIMIT 2`,
        [TOKEN, before],
      )
      return rows
    }
    const t1 = await timeKeyed(null)
    expect(t1).toHaveLength(2)
    const t2 = await timeKeyed(t1[1]?.created_at ?? null)
    expect(t2).toHaveLength(0) //  <-- DORT SATIR ULASILAMAZ

    // (b) `message_seq` ILE: altisi da gorunur, ayni satirlar uzerinde.
    const seen: string[] = []
    let cursor: bigint | null = null
    for (let page = 0; page < 6; page++) {
      const rows = await listChatMessages(pool, TOKEN, { before: cursor, limit: 2 })
      if (rows.length === 0) break
      seen.push(...rows.map((r) => r.body))
      cursor = rows[rows.length - 1]?.messageSeq ?? null
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  it('SIRA CAGIRAN TARAFINDAN SECILEMEZ: `message_seq` GENERATED ALWAYS', async () => {
    await postMany(1)
    // Bir yazarin siranin basina zorla oturmasi -- "pinned" bir mesaj --
    // veritabani duzeyinde IMKANSIZ. `BY DEFAULT` olsaydi mumkun olurdu.
    const failure = await pool
      .query(
        `INSERT INTO chat_messages
           (message_seq, token, author_addr, body, balance_tok, balance_block_number,
            nonce_hex, signature_hex, issued_at)
         VALUES (999999, $1, $2, 'pinned', 1, 1, $3, $4, now())`,
        [TOKEN, ALICE, nonce(), SIGNATURE],
      )
      .then(
        () => null,
        (error: { code?: string }) => error,
      )
    expect(failure).not.toBeNull()
    expect(failure?.code).toBe('428C9')
  })

  it('imlec cozumleyicisi bozuk degeri ILK SAYFA sayar, atmaz', () => {
    expect(parseChatCursor(null)).toBeNull()
    expect(parseChatCursor('')).toBeNull()
    expect(parseChatCursor('abc')).toBeNull()
    expect(parseChatCursor('-3')).toBeNull()
    expect(parseChatCursor('0')).toBeNull()
    expect(parseChatCursor('1; DROP TABLE chat_messages')).toBeNull()
    expect(parseChatCursor('12345678901234567890123')).toBeNull()
    expect(parseChatCursor('42')).toBe(42n)
    expect(encodeChatCursor({ messageSeq: 42n })).toBe('42')
  })

  it('BASKA bir token in mesajlari sizmaz', async () => {
    const other = await secondLaunch(addr(0x7999), 1)
    await postChatMessage(pool, message({ body: 'here' }))
    await postChatMessage(pool, message({ token: other, body: 'there' }))

    expect((await listChatMessages(pool, TOKEN)).map((r) => r.body)).toEqual(['here'])
    expect((await listChatMessages(pool, other)).map((r) => r.body)).toEqual(['there'])
  })
})

// ==========================================================================
//  KAPILAR
// ==========================================================================

describe('chat: her kapi SEMADA da durur', () => {
  beforeEach(seed)

  it('AYNI NONCE IKINCI KEZ YAZILAMAZ -- tekrar oynatma burada durur', async () => {
    const input = message({ body: 'replay me' })
    expect((await postChatMessage(pool, input)).ok).toBe(true)

    // Saldirgan yakaladigi govdeyi, imzayi ve nonce'u OLDUGU GIBI geri gonderir.
    const again = await postChatMessage(pool, input)
    expect(again).toEqual({ ok: false, reason: 'duplicateNonce' })

    // Ve tabloda hala TEK satir var: reddedilen istek yan etki birakmaz.
    expect(await listChatMessages(pool, TOKEN)).toHaveLength(1)
  })

  it('nonce BUTUN TABLODA benzersiz: baska bir token da tekrari kabul etmez', async () => {
    // Kisit `(token, nonce)` DEGIL, tek basina `nonce_hex` uzerinde. Aksi
    // halde bir imza baska bir token'in altina yeniden oynatilabilirdi --
    // imzalanan metin token'i icerdigi icin o imza orada gecersiz olurdu, ama
    // savunmanin TEK bir katmana dayanmasi tam olarak kacinilan sey.
    const other = await secondLaunch(addr(0x7998), 2)
    const shared = nonce()
    expect((await postChatMessage(pool, message({ nonceHex: shared }))).ok).toBe(true)
    expect(await postChatMessage(pool, message({ token: other, nonceHex: shared }))).toEqual({
      ok: false,
      reason: 'duplicateNonce',
    })
  })

  it('BILINMEYEN TOKEN yazilamaz -- yabanci anahtar', async () => {
    // Bu kapi olmasa POST rotasi 2^160 adresin her biri icin satir uretebilir.
    expect(await postChatMessage(pool, message({ token: addr(0xdead) }))).toEqual({
      ok: false,
      reason: 'unknownToken',
    })
  })

  it('SIFIR BAKIYE yazilamaz -- holder kapisi semada da duruyor', async () => {
    const outcome = await postChatMessage(pool, message({ balanceTok: 0n }))
    expect(outcome).toEqual({
      ok: false,
      reason: 'rejected',
      constraint: 'chat_messages_balance_tok_check',
    })
  })

  it('govde uzunlugu KARAKTER ve BAYT olarak AYRI sinirlanir', async () => {
    // 500 karakter gecer.
    expect((await postChatMessage(pool, message({ body: 'a'.repeat(500) }))).ok).toBe(true)
    // 501 gecmez.
    expect(await postChatMessage(pool, message({ body: 'a'.repeat(501) }))).toEqual({
      ok: false,
      reason: 'rejected',
      constraint: 'chat_messages_body_check',
    })
    // BOS gecmez.
    expect((await postChatMessage(pool, message({ body: '' }))).ok).toBe(false)

    // ==================================================================
    //  BAYT SINIRI AYRI BIR KAPI -- VE ILK YAZILISINDA DEGILDI
    // ==================================================================
    // Tavan ONCE 2000 bayt yazilmisti ve ULASILAMAZDI: UTF-8'de bir kod
    // noktasi en cok 4 bayttir, yani `length <= 500` zaten `octet_length
    // <= 2000` demek. Kosturuldu ve gorundu -- 501 emoji'lik govde KARAKTER
    // kisitini kiriyor, bayt kisitini hicbir girdi tetikleyemiyordu.
    //
    // 1000 baytta ikisi GERCEKTEN ayrisir, ve iki yon de burada olculuyor:
    //   500 ASCII  -> 500 karakter,  500 bayt  -> GECER (yukarida)
    //   250 emoji  -> 250 karakter, 1000 bayt  -> GECER
    //   251 emoji  -> 251 karakter, 1004 bayt  -> BAYT kisitindan DUSER
    const atByteCeiling = '🚀'.repeat(250)
    expect([...atByteCeiling]).toHaveLength(250)
    expect(Buffer.byteLength(atByteCeiling, 'utf8')).toBe(1000)
    expect((await postChatMessage(pool, message({ body: atByteCeiling }))).ok).toBe(true)

    const tooManyBytes = '🚀'.repeat(251)
    expect([...tooManyBytes]).toHaveLength(251) // KARAKTER kapisindan gecer
    expect(Buffer.byteLength(tooManyBytes, 'utf8')).toBe(1004)
    expect(await postChatMessage(pool, message({ body: tooManyBytes }))).toEqual({
      ok: false,
      reason: 'rejected',
      // Ikinci CHECK, yani BAYT olan. Adin `1` ile bitmesi Postgres'in ayni
      // sutuna ikinci kisiti adlandirma bicimidir ve iddianin ta kendisi:
      // duseren sey KARAKTER kisiti DEGIL.
      constraint: 'chat_messages_body_check1',
    })
  })
})

// ==========================================================================
//  HIZ SINIRI -- VE NEDEN ADVISORY LOCK OLMADAN TAVSIYEDEN IBARET
// ==========================================================================

describe('chat: hiz siniri', () => {
  beforeEach(seed)

  const TIGHT: ChatRateLimit = { windowSeconds: 60, maxMessages: 3 }

  it('pencerede kotayi asan istek reddedilir', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await postChatMessage(pool, message({ body: `m${i}` }), TIGHT)).ok).toBe(true)
    }
    expect(await postChatMessage(pool, message({ body: 'm3' }), TIGHT)).toEqual({
      ok: false,
      reason: 'rateLimited',
      retryAfterSeconds: 60,
    })
    expect(await countRecentChatMessages(pool, TOKEN, ALICE, 60)).toBe(3)
  })

  it('kota YAZAR BASINA ve TOKEN BASINA -- baskasi engellenmez', async () => {
    for (let i = 0; i < 3; i++) {
      await postChatMessage(pool, message({ body: `a${i}` }), TIGHT)
    }
    expect((await postChatMessage(pool, message({ authorAddr: BOB }), TIGHT)).ok).toBe(true)
  })

  it('pencere DISINDAKI mesajlar sayilmaz', async () => {
    for (let i = 0; i < 3; i++) {
      await postChatMessage(pool, message({ body: `a${i}` }), TIGHT)
    }
    // Uc mesaji da penceresinin disina it.
    await pool.query(`UPDATE chat_messages SET created_at = now() - interval '10 minutes'`)
    expect(await countRecentChatMessages(pool, TOKEN, ALICE, 60)).toBe(0)
    expect((await postChatMessage(pool, message({ body: 'fresh' }), TIGHT)).ok).toBe(true)
  })

  /**
   * ==========================================================================
   *  ES ZAMANLILIK: KOTA TAM, VE TAMLIK BIR SATIRA BAGLI
   * ==========================================================================
   *
   * On istek AYNI ANDA gonderilir. `READ COMMITTED` altinda hepsi ayni
   * "su anda 0 mesaj var" anini gorebilir -- okunmayan bir satir kilitlenemez,
   * yani sayim tek basina bir kapi DEGILDIR. Kapiyi kapatan sey
   * `pg_advisory_xact_lock(hashtext(token), hashtext(yazar))`tir.
   */
  it('ON ES ZAMANLI istekten TAM OLARAK kota kadari gecer', async () => {
    const limit: ChatRateLimit = { windowSeconds: 60, maxMessages: 4 }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postChatMessage(pool, message({ body: `c${i}` }), limit),
      ),
    )
    const accepted = results.filter((r) => r.ok).length
    expect(accepted).toBe(4)
    expect(results.filter((r) => !r.ok && r.reason === 'rateLimited')).toHaveLength(6)
    expect(await countRecentChatMessages(pool, TOKEN, ALICE, 60)).toBe(4)
  })

  /**
   * NEGATIF KONTROL, VE DETERMINISTIK: kilit olmadan ayni sira kotayi ASAR.
   *
   * `Promise.all` ile bir yaris kurmak olcumu makinenin planlamasina birakirdi;
   * burada interleaving ELLE kuruluyor -- iki client, ikisi de sayar, sonra
   * ikisi de yazar. Kota 1 iken IKI satir girer. Yani yukaridaki "TAM OLARAK
   * kota kadari" iddiasi bos degil: kilit dusurulurse OLCULEBILIR bicimde
   * kirilir.
   */
  it('NEGATIF KONTROL: kilitsiz ayni sira kotayi ASAR (deterministik)', async () => {
    const a = await pool.connect()
    const b = await pool.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const countIn = async (c: typeof a) =>
        Number(
          (
            await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM chat_messages
                WHERE token = $1 AND author_addr = $2
                  AND created_at > now() - interval '60 seconds'`,
              [TOKEN, ALICE],
            )
          ).rows[0]?.n ?? '0',
        )
      // IKISI DE SIFIR GORUR -- kilit olmadigi icin.
      expect(await countIn(a)).toBe(0)
      expect(await countIn(b)).toBe(0)

      const insert = async (c: typeof a, body: string) =>
        c.query(
          `INSERT INTO chat_messages
             (token, author_addr, body, balance_tok, balance_block_number,
              nonce_hex, signature_hex, issued_at)
           VALUES ($1, $2, $3, 1, 1, $4, $5, now())`,
          [TOKEN, ALICE, body, nonce(), SIGNATURE],
        )
      await insert(a, 'a')
      await insert(b, 'b')
      await a.query('COMMIT')
      await b.query('COMMIT')
    } finally {
      a.release()
      b.release()
    }
    // Kota 1 olsaydi bu iki satirdan biri hic yazilmamaliydi.
    expect(await countRecentChatMessages(pool, TOKEN, ALICE, 60)).toBe(2)
  })

  it('varsayilan kota beyan edilmistir', () => {
    expect(DEFAULT_CHAT_RATE_LIMIT).toEqual({ windowSeconds: 60, maxMessages: 5 })
  })
})
