import { beforeEach, describe, expect, it } from 'vitest'
import { applyLaunch } from '../src/apply'
import { putDeployment } from '../src/deployment'
import type { Address } from '../src/hex'
import {
  cancelOrder,
  countRecentOrders,
  DEFAULT_ORDER_RATE_LIMIT,
  encodeOrderCursor,
  expireDueOrders,
  getOrder,
  type LimitOrderRow,
  listLiveOrders,
  listOrders,
  markExpired,
  markFilled,
  markTriggered,
  type OrderInsert,
  type OrderRateLimit,
  orderPreflight,
  parseOrderCursor,
  placeOrder,
} from '../src/orders'
import { toSeq } from '../src/seq'
import { pool, resetSchema } from './setup'
import { addr, ALICE, BOB, CREATOR, DEPLOYMENT, hash32, LAUNCH, TOKEN } from './fixtures'

/**
 * ==========================================================================
 *  limit_orders -- VE NEDEN BURADA "GERCEK POSTGRES" DAHA DA GEREKLI
 * ==========================================================================
 *
 * `chat.test.ts`in gerekcesi burada bir kat daha keskin: emirlerin tasidigi
 * garantilerin cogu SEMADA ve SQL'DE yasiyor, TypeScript'te degil.
 *
 *   - `limit_orders_side_units_check` -- bir alim emrinin token miktari
 *     tasimasini IMKANSIZ kilar. Bir sahte veritabani bunu kanitlamaz.
 *   - Her durum gecisi KOSULLU bir UPDATE'tir. "Once oku sonra yaz" ile
 *     arasindaki fark yalnizca es zamanlilik altinda gorunur.
 *   - `nonce_hex UNIQUE`, yabanci anahtar, `GENERATED ALWAYS AS IDENTITY`.
 *
 * ==========================================================================
 *  PARA, VE UC SOMUT ARIZA
 * ==========================================================================
 *
 * Bir chat mesajinin kaybolmasi can sikicidir; bir emrin (1) YANLIS FIYATTAN,
 * (2) IKI KEZ, ya da (3) IPTALDEN SONRA dolmasi bir KAYIPTIR. Ucu de burada
 * ADIYLA olculuyor, ve her biri icin bir MUTANT kontrolu var -- yani iddia
 * "boyle yazdik" degil "bu satiri kaldirinca test kiriliyor".
 */

let nonceCounter = 0
function nonce(): string {
  nonceCounter += 1
  return `0x${nonceCounter.toString(16).padStart(64, '0')}`
}

const SIGNATURE = `0x${'ab'.repeat(65)}`
const FAR = new Date('2026-12-31T00:00:00.000Z')
const TX = `0x${'11'.repeat(32)}`

function buy(overrides: Partial<OrderInsert> = {}): OrderInsert {
  return {
    token: TOKEN,
    ownerAddr: ALICE,
    isBuy: true,
    amount: 5n * 10n ** 18n, // 5 USDC, 18-decimal native view
    minOut: 1_000n * 10n ** 18n, // at least 1000 tokens
    expiresAt: FAR,
    nonceHex: nonce(),
    signatureHex: SIGNATURE,
    issuedAt: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  }
}

function sell(overrides: Partial<OrderInsert> = {}): OrderInsert {
  return buy({ isBuy: false, amount: 1_000n * 10n ** 18n, minOut: 6n * 10n ** 18n, ...overrides })
}

async function place(input: OrderInsert): Promise<LimitOrderRow> {
  const outcome = await placeOrder(pool, input)
  if (!outcome.ok) throw new Error(`placeOrder refused: ${outcome.reason}`)
  return outcome.row
}

/** Ikinci bir launch -- `applyLaunch` ile, elle INSERT ile DEGIL. */
const TOKEN2 = addr(0x7002) as Address
async function secondLaunch(): Promise<void> {
  await applyLaunch(pool, {
    ...LAUNCH,
    eventSeq: toSeq(54_900_001n, 0),
    blockNumber: 54_900_001n,
    logIndex: 0,
    token: TOKEN2,
    curve: addr(0xc002) as Address,
    txHash: hash32(0x7002),
    salt: hash32(0x5902),
  })
}

beforeEach(async () => {
  await resetSchema()
  await putDeployment(pool, DEPLOYMENT)
  await applyLaunch(pool, LAUNCH)
})

// ---------------------------------------------------------------
describe('yerlestirme', () => {
  it('bir alim emri, yonun DOGRU sutununa yazilir', async () => {
    const row = await place(buy())
    expect(row.status).toBe('open')
    expect(row.isBuy).toBe(true)
    expect(row.amount).toBe(5n * 10n ** 18n)
    expect(row.minOut).toBe(1_000n * 10n ** 18n)
    expect(row.orderSeq).toBeGreaterThan(0n)
    expect(row.triggerBlockNumber).toBeNull()
    expect(row.fillTxHash).toBeNull()

    // SUTUN SEVIYESINDE de dogrulanir: model iki alan gosterse de semada
    // DORT sutun var ve tam olarak alim tarafi dolu olmali.
    const { rows } = await pool.query<{
      amount_wei: string | null
      amount_tok: string | null
      min_out_tok: string | null
      min_out_wei: string | null
    }>('SELECT amount_wei::text, amount_tok::text, min_out_tok::text, min_out_wei::text FROM limit_orders')
    expect(rows[0]).toEqual({
      amount_wei: '5000000000000000000',
      amount_tok: null,
      min_out_tok: '1000000000000000000000',
      min_out_wei: null,
    })
  })

  it('bir satim emri, obur ciftin sutunlarina yazilir', async () => {
    const row = await place(sell())
    expect(row.isBuy).toBe(false)
    const { rows } = await pool.query<{ amount_wei: string | null; amount_tok: string | null }>(
      'SELECT amount_wei::text, amount_tok::text FROM limit_orders',
    )
    expect(rows[0]).toEqual({ amount_wei: null, amount_tok: '1000000000000000000000' })
  })

  /**
   * MUTANT: yon ile birim ciftini AYIRAN satiri kaldirmak. `placeOrder` dort
   * argumani `isBuy`a gore secer; secmeseydi ne olurdu?
   *
   * Bu test onu SQL seviyesinde yeniden uretiyor: bir alim satiri, token
   * sutunlari dolu halde. Semanin CHECK'i onu reddetmek ZORUNDA -- cunku o
   * satir tip sisteminde tamamen gecerlidir ve hicbir calisma zamani kontrolu
   * 18-decimal bir sayinin token sanildigini goremez.
   */
  it('SEMA: bir ALIM emri token sutunlariyla YAZILAMAZ', async () => {
    await expect(
      pool.query(
        `INSERT INTO limit_orders
           (token, owner_addr, is_buy, amount_tok, min_out_wei, status, expires_at,
            nonce_hex, signature_hex, issued_at)
         VALUES ($1, $2, true, 1, 1, 'open', $3, $4, $5, now())`,
        [TOKEN, ALICE, FAR.toISOString(), nonce(), SIGNATURE],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'limit_orders_side_units_check' })
  })

  it('SEMA: her iki cift birden dolu OLAMAZ', async () => {
    await expect(
      pool.query(
        `INSERT INTO limit_orders
           (token, owner_addr, is_buy, amount_wei, amount_tok, min_out_tok, min_out_wei,
            status, expires_at, nonce_hex, signature_hex, issued_at)
         VALUES ($1, $2, true, 1, 1, 1, 1, 'open', $3, $4, $5, now())`,
        [TOKEN, ALICE, FAR.toISOString(), nonce(), SIGNATURE],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('KONTROL: ayni INSERT dogru cift ile GECER', async () => {
    // Yukaridaki iki reddin "INSERT zaten calismiyordu"dan gelmedigini
    // gosterir. Kontrol grubu olmadan iki test de bir yazim hatasiyla yesil
    // kalirdi.
    await pool.query(
      `INSERT INTO limit_orders
         (token, owner_addr, is_buy, amount_wei, min_out_tok, status, expires_at,
          nonce_hex, signature_hex, issued_at)
       VALUES ($1, $2, true, 1, 1, 'open', $3, $4, $5, now())`,
      [TOKEN, ALICE, FAR.toISOString(), nonce(), SIGNATURE],
    )
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text n FROM limit_orders')
    expect(rows[0]?.n).toBe('1')
  })

  it('bilinmeyen token yabanci anahtarla reddedilir', async () => {
    const outcome = await placeOrder(pool, buy({ token: addr(0xdead) as Address }))
    expect(outcome).toEqual({ ok: false, reason: 'unknownToken' })
  })

  it('ayni nonce ikinci kez yazilamaz -- TEKRAR OYNATMA burada durur', async () => {
    const input = buy()
    expect((await placeOrder(pool, input)).ok).toBe(true)
    const again = await placeOrder(pool, { ...input, nonceHex: input.nonceHex })
    expect(again).toEqual({ ok: false, reason: 'duplicateNonce' })
  })

  it('`order_seq` cagiran tarafindan SECILEMEZ', async () => {
    await expect(
      pool.query(
        `INSERT INTO limit_orders
           (order_seq, token, owner_addr, is_buy, amount_wei, min_out_tok, status,
            expires_at, nonce_hex, signature_hex, issued_at)
         VALUES (999, $1, $2, true, 1, 1, 'open', $3, $4, $5, now())`,
        [TOKEN, ALICE, FAR.toISOString(), nonce(), SIGNATURE],
      ),
    ).rejects.toMatchObject({ code: '428C9' })
  })

  it('`filled` bir islem hashı OLMADAN yazilamaz', async () => {
    await expect(
      pool.query(
        `INSERT INTO limit_orders
           (token, owner_addr, is_buy, amount_wei, min_out_tok, status, expires_at,
            nonce_hex, signature_hex, issued_at)
         VALUES ($1, $2, true, 1, 1, 'filled', $3, $4, $5, now())`,
        [TOKEN, ALICE, FAR.toISOString(), nonce(), SIGNATURE],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'limit_orders_filled_needs_tx_check' })
  })

  it('`triggered` bir GOZLEM BLOGU olmadan yazilamaz', async () => {
    await expect(
      pool.query(
        `INSERT INTO limit_orders
           (token, owner_addr, is_buy, amount_wei, min_out_tok, status, expires_at,
            nonce_hex, signature_hex, issued_at)
         VALUES ($1, $2, true, 1, 1, 'triggered', $3, $4, $5, now())`,
        [TOKEN, ALICE, FAR.toISOString(), nonce(), SIGNATURE],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'limit_orders_triggered_needs_block_check',
    })
  })
})

// ---------------------------------------------------------------
describe('iki sinir, ve ikisi AYNI DEGIL', () => {
  const fast: OrderRateLimit = { windowSeconds: 60, maxPerWindow: 3, maxOpen: 100 }
  const narrow: OrderRateLimit = { windowSeconds: 60, maxPerWindow: 100, maxOpen: 2 }

  it('pencere siniri: dorduncu emir 429', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await placeOrder(pool, buy(), fast)).ok).toBe(true)
    }
    expect(await placeOrder(pool, buy(), fast)).toEqual({
      ok: false,
      reason: 'rateLimited',
      retryAfterSeconds: 60,
    })
    expect(await countRecentOrders(pool, TOKEN, ALICE, 60)).toBe(3)
  })

  /**
   * ACIK-EMIR TAVANI, PENCERE SINIRINDAN AYRI BIR KAPIDIR VE BU OLCULUYOR.
   *
   * `narrow` penceresi 100'e acik -- yani pencere siniri BURADA HIC
   * DEVREYE GIRMEZ. Ucuncu emir yine reddedilir, ve reddin sebebi
   * `tooManyOpen`dir. Tek sinirla yetinilseydi bir kullanici dakikada bese
   * sadik kalarak bes dakikada 25 acik emir birakabilirdi ve HER GECIS
   * onlarin hepsini tarardi.
   */
  it('acik emir tavani: pencere BOSKEN bile ucuncu emir reddedilir', async () => {
    expect((await placeOrder(pool, buy(), narrow)).ok).toBe(true)
    expect((await placeOrder(pool, buy(), narrow)).ok).toBe(true)
    expect(await placeOrder(pool, buy(), narrow)).toEqual({
      ok: false,
      reason: 'tooManyOpen',
      maxOpen: 2,
    })
  })

  it('KONTROL: bir emri iptal etmek tavanda YER ACAR, pencerede acmaz', async () => {
    const first = await place(buy())
    await place(buy())
    expect((await placeOrder(pool, buy(), narrow)).ok).toBe(false)
    await cancelOrder(pool, first.orderSeq, ALICE)
    // Tavan acildi: iptal edilen emir artik TARANMIYOR, yani keeper'a
    // maliyeti kalmadi.
    expect((await placeOrder(pool, buy(), narrow)).ok).toBe(true)
    // ...ama PENCERE sayaci dusmedi: uc satir yazildi ve ucu de pencerede.
    // Iki sinirin AYNI SEY OLMADIGININ olcumu tam olarak bu satirdir --
    // biri ACIK ISI, oteki YAZMA HIZINI sinirlar.
    expect(await countRecentOrders(pool, TOKEN, ALICE, 60)).toBe(3)
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM limit_orders WHERE status = 'open'",
    )
    expect(rows[0]?.n).toBe('2')
  })

  it('sinirlar (token, sahip) BASINADIR', async () => {
    await secondLaunch()
    for (let i = 0; i < 3; i += 1) expect((await placeOrder(pool, buy(), fast)).ok).toBe(true)
    expect((await placeOrder(pool, buy(), fast)).ok).toBe(false)
    // Baska bir sahip: acik.
    expect((await placeOrder(pool, buy({ ownerAddr: BOB }), fast)).ok).toBe(true)
    // Baska bir token: acik.
    expect((await placeOrder(pool, buy({ token: TOKEN2 }), fast)).ok).toBe(true)
  })

  /**
   * KILIT TASIYICI, VE OLCULUYOR -- `chat.test.ts`in deseninin aynisi.
   *
   * Es zamanli N istek, kotasi 3 olan bir sinirla. Tam olarak 3'u yazilmali.
   * Advisory lock olmasaydi hepsi ayni "su anda 0 var" anini gorurdu.
   */
  it('es zamanli sekiz yerlestirme, kotasi uc: TAM OLARAK ucu yazilir', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => placeOrder(pool, buy(), fast)),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text n FROM limit_orders')
    expect(rows[0]?.n).toBe('3')
  })

  /**
   * ==========================================================================
   *  KILIT GERCEKTEN ALINIYOR MU -- VE BU TEST BIR MUTASYON TURUNUN SONUCU
   * ==========================================================================
   *
   * Ustteki es zamanlilik testi kilidi OLCMEK ICIN YETMIYOR, ve bu OLCULDU:
   * `pg_advisory_xact_lock` satiri silinip paket kosturuldu ve test bir turda
   * **5** satir gordu (3 bekliyordu -> kirmizi), ama mutasyon turunun kendi
   * kosusunda 3 gorup YESIL kaldi. Yani sekiz es zamanli istek bazen kendi
   * kendine serilesiyor: test bir YARISA dayaniyor ve yaris bazen "dogru"
   * sonucu tesadufen veriyor. Bir kilidin varligini kanitlamak icin
   * kullanilamaz.
   *
   * BU TEST YARISA DAYANMAZ. Ayni anahtari BASKA bir oturumdan tutar ve
   * `placeOrder`in BLOKLANDIGINI olcer:
   *
   *   1. B oturumu `BEGIN` + ayni `(token, sahip)` anahtarini kilitler.
   *   2. `placeOrder` cagrilir ve 750 ms icinde BITMEMELIDIR.
   *   3. B `COMMIT` eder; `placeOrder` bundan SONRA biter.
   *
   * Kilit satiri silinirse 2. adim aninda biter ve test kirilir -- her
   * seferinde, zamanlamaya bakmadan.
   */
  it('KILIT GERCEKTEN ALINIR: ayni anahtar tutulurken yerlestirme BLOKLANIR', async () => {
    const blocker = await pool.connect()
    let settled = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        TOKEN,
        ALICE,
      ])

      const pending = placeOrder(pool, buy()).then((outcome) => {
        settled = true
        return outcome
      })

      await new Promise((done) => setTimeout(done, 750))
      // BEKLEMEDEN GECEN 750 ms, KILIDIN OLMADIGI ANLAMINA GELIR.
      expect(settled, 'placeOrder finished while the advisory lock was held').toBe(false)

      await blocker.query('COMMIT')
      const outcome = await pending
      expect(outcome.ok).toBe(true)
      expect(settled).toBe(true)
    } finally {
      // Kilit transaction kapsamli: COMMIT/ROLLBACK onu kendiliginden birakir.
      blocker.release()
    }
  })

  it('NEGATIF KONTROL: kilitsiz iki istemci kotayi ASAR', async () => {
    // Yaris beklemeye dayanmaz: iki client ACIKCA once ikisi de sayar, sonra
    // ikisi de yazar. Kota 1 iken IKI satir duser.
    const a = await pool.connect()
    const b = await pool.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const count = async (c: typeof a): Promise<number> => {
        const { rows } = await c.query<{ n: string }>(
          'SELECT count(*)::text n FROM limit_orders WHERE token = $1 AND owner_addr = $2',
          [TOKEN, ALICE],
        )
        return Number(rows[0]?.n ?? '0')
      }
      expect(await count(a)).toBe(0)
      expect(await count(b)).toBe(0)
      const insert = async (c: typeof a): Promise<void> => {
        await c.query(
          `INSERT INTO limit_orders
             (token, owner_addr, is_buy, amount_wei, min_out_tok, status, expires_at,
              nonce_hex, signature_hex, issued_at)
           VALUES ($1, $2, true, 1, 1, 'open', $3, $4, $5, now())`,
          [TOKEN, ALICE, FAR.toISOString(), nonce(), SIGNATURE],
        )
      }
      await insert(a)
      await insert(b)
      await a.query('COMMIT')
      await b.query('COMMIT')
    } finally {
      a.release()
      b.release()
    }
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text n FROM limit_orders')
    expect(rows[0]?.n).toBe('2')
  })

  it('on eleme sayimi rota icin iki cevabi TEK sorguda verir', async () => {
    await place(buy())
    const pre = await orderPreflight(pool, TOKEN, ALICE, 60)
    expect(pre).toEqual({ launchExists: true, recentCount: 1, openCount: 1 })
    const missing = await orderPreflight(pool, addr(0xdead) as Address, ALICE, 60)
    expect(missing.launchExists).toBe(false)
  })
})

// ---------------------------------------------------------------
describe('durum makinesi -- paranin oldugu yer', () => {
  it('tetikleme YALNIZCA `open`dan olur ve blogu kaydeder', async () => {
    const row = await place(buy())
    const first = await markTriggered(pool, row.orderSeq, 56_199_900n)
    expect(first.changed).toBe(true)
    expect(first.row?.status).toBe('triggered')
    expect(first.row?.triggerBlockNumber).toBe(56_199_900n)

    // IKINCI TETIKLEME HICBIR SEY YAPMAZ. `trigger_block_number` ILK gozlemdir
    // ve ileri itilmesi o sutunun cevapladigi soruyu degistirirdi.
    const second = await markTriggered(pool, row.orderSeq, 56_200_000n)
    expect(second.changed).toBe(false)
    expect((await getOrder(pool, row.orderSeq))?.triggerBlockNumber).toBe(56_199_900n)
  })

  /**
   * ============ ARIZA 3: IPTALDEN SONRA DOLMAK ============
   *
   * Bu deponun en pahali arizasi bu olurdu ve tek bir `WHERE` ile kapaniyor.
   */
  it('IPTAL EDILMIS bir emir DOLDURULAMAZ', async () => {
    const row = await place(buy())
    expect((await cancelOrder(pool, row.orderSeq, ALICE)).changed).toBe(true)

    const fill = await markFilled(pool, row.orderSeq, ALICE, TX)
    expect(fill.changed).toBe(false)
    expect(fill.row).toBeNull()

    const after = await getOrder(pool, row.orderSeq)
    expect(after?.status).toBe('cancelled')
    expect(after?.fillTxHash).toBeNull()
  })

  it('IPTAL EDILMIS bir emir TETIKLENEMEZ', async () => {
    const row = await place(buy())
    await cancelOrder(pool, row.orderSeq, ALICE)
    expect((await markTriggered(pool, row.orderSeq, 1n)).changed).toBe(false)
    expect((await getOrder(pool, row.orderSeq))?.status).toBe('cancelled')
  })

  it('KONTROL: iptal EDILMEMIS ayni emir doldurulabilir', async () => {
    // Iki reddin "markFilled zaten calismiyor"dan gelmedigini gosterir.
    const row = await place(buy())
    const fill = await markFilled(pool, row.orderSeq, ALICE, TX)
    expect(fill.changed).toBe(true)
    expect(fill.row?.status).toBe('filled')
    expect(fill.row?.fillTxHash).toBe(TX)
  })

  /** ============ ARIZA 2: IKI KEZ DOLMAK ============ */
  it('bir emir IKI KEZ dolamaz', async () => {
    const row = await place(buy())
    const first = await markFilled(pool, row.orderSeq, ALICE, TX)
    expect(first.changed).toBe(true)
    const second = await markFilled(pool, row.orderSeq, ALICE, `0x${'22'.repeat(32)}`)
    expect(second.changed).toBe(false)
    // ILK islem hash'i KALIR. Ikincisinin uzerine yazmasi, hangi islemin
    // doldurdugu sorusunu cevapsiz birakirdi.
    expect((await getOrder(pool, row.orderSeq))?.fillTxHash).toBe(TX)
  })

  it('es zamanli sekiz doldurma denemesinden TAM OLARAK biri tutar', async () => {
    const row = await place(buy())
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        markFilled(pool, row.orderSeq, ALICE, `0x${i.toString(16).padStart(2, '0').repeat(32)}`),
      ),
    )
    expect(results.filter((r) => r.changed)).toHaveLength(1)
  })

  it('BASKASI bir emri iptal EDEMEZ', async () => {
    const row = await place(buy())
    expect((await cancelOrder(pool, row.orderSeq, BOB)).changed).toBe(false)
    expect((await getOrder(pool, row.orderSeq))?.status).toBe('open')
    // KONTROL: sahibi edebilir.
    expect((await cancelOrder(pool, row.orderSeq, ALICE)).changed).toBe(true)
  })

  it('BASKASI bir emri DOLDURULMUS isaretleyemez', async () => {
    const row = await place(buy())
    expect((await markFilled(pool, row.orderSeq, CREATOR, TX)).changed).toBe(false)
    expect((await getOrder(pool, row.orderSeq))?.status).toBe('open')
  })

  it('tetiklenmis bir emir hala iptal edilebilir ve hala doldurulabilir', async () => {
    const a = await place(buy())
    await markTriggered(pool, a.orderSeq, 10n)
    expect((await cancelOrder(pool, a.orderSeq, ALICE)).changed).toBe(true)

    const b = await place(buy())
    await markTriggered(pool, b.orderSeq, 10n)
    expect((await markFilled(pool, b.orderSeq, ALICE, TX)).changed).toBe(true)
  })

  it('DOLMUS bir emir iptal edilemez', async () => {
    const row = await place(buy())
    await markFilled(pool, row.orderSeq, ALICE, TX)
    expect((await cancelOrder(pool, row.orderSeq, ALICE)).changed).toBe(false)
    expect((await getOrder(pool, row.orderSeq))?.status).toBe('filled')
  })

  it('keeper suresi gecenleri supurur, gecmeyenlere DOKUNMAZ', async () => {
    const soon = await place(buy({ expiresAt: new Date('2026-08-10T00:00:00.000Z') }))
    const later = await place(buy({ expiresAt: new Date('2027-01-01T00:00:00.000Z') }))
    const triggered = await place(buy({ expiresAt: new Date('2026-08-10T00:00:00.000Z') }))
    await markTriggered(pool, triggered.orderSeq, 5n)

    const swept = await expireDueOrders(pool, new Date('2026-08-10T00:00:01.000Z'))
    expect(swept.sort()).toEqual([soon.orderSeq, triggered.orderSeq].sort())
    expect((await getOrder(pool, later.orderSeq))?.status).toBe('open')
    expect((await getOrder(pool, triggered.orderSeq))?.status).toBe('expired')
  })

  it('supurme TERMINAL durumlara dokunmaz', async () => {
    const cancelled = await place(buy({ expiresAt: new Date('2026-08-10T00:00:00.000Z') }))
    await cancelOrder(pool, cancelled.orderSeq, ALICE)
    const filled = await place(buy({ expiresAt: new Date('2026-08-10T00:00:00.000Z') }))
    await markFilled(pool, filled.orderSeq, ALICE, TX)

    const swept = await expireDueOrders(pool, new Date('2026-08-10T00:00:01.000Z'))
    expect(swept).toEqual([])
    expect((await getOrder(pool, cancelled.orderSeq))?.status).toBe('cancelled')
    expect((await getOrder(pool, filled.orderSeq))?.status).toBe('filled')
  })

  it('tek tek sure asimi da terminal durumlari atlar', async () => {
    const row = await place(buy())
    await markFilled(pool, row.orderSeq, ALICE, TX)
    expect((await markExpired(pool, row.orderSeq)).changed).toBe(false)
  })

  it('SEMA: bilinmeyen bir durum yazilamaz', async () => {
    const row = await place(buy())
    await expect(
      pool.query("UPDATE limit_orders SET status = 'partially_filled' WHERE order_seq = $1", [
        row.orderSeq.toString(),
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

// ---------------------------------------------------------------
describe('okuma', () => {
  it('keeper yalnizca CANLI emirleri gorur, tokenına gore gruplu', async () => {
    await secondLaunch()
    const open1 = await place(buy())
    const open2 = await place(buy({ token: TOKEN2 }))
    const trig = await place(buy())
    await markTriggered(pool, trig.orderSeq, 7n)
    const gone = await place(buy())
    await cancelOrder(pool, gone.orderSeq, ALICE)

    const live = await listLiveOrders(pool)
    expect(live.map((o) => o.orderSeq)).toEqual([open1.orderSeq, trig.orderSeq, open2.orderSeq])
    // Gruplama TASIYICI: keeper token basina BIR KEZ rezerv okur, ve bunun
    // dogru olmasi icin ayni token'in emirlerinin BITISIK gelmesi gerekir.
    const tokens = live.map((o) => o.token)
    expect(tokens).toEqual([...new Set(tokens)].flatMap((t) => tokens.filter((x) => x === t)))
  })

  it('sahibin sekmesi yeniden eskiye, keyset `order_seq` uzerinde', async () => {
    const rows: LimitOrderRow[] = []
    for (let i = 0; i < 5; i += 1) rows.push(await place(buy()))
    await place(buy({ ownerAddr: BOB }))

    const page1 = await listOrders(pool, TOKEN, ALICE, { limit: 2 })
    expect(page1.map((o) => o.orderSeq)).toEqual([rows[4]?.orderSeq, rows[3]?.orderSeq])
    const page2 = await listOrders(pool, TOKEN, ALICE, {
      limit: 2,
      before: parseOrderCursor(encodeOrderCursor(page1[1] as LimitOrderRow)),
    })
    expect(page2.map((o) => o.orderSeq)).toEqual([rows[2]?.orderSeq, rows[1]?.orderSeq])
    // BOB'un emri ALICE'in sayfasinda GORUNMEZ.
    const all = await listOrders(pool, TOKEN, ALICE, { limit: 50 })
    expect(all).toHaveLength(5)
  })

  it('bozuk imlec ILK SAYFADIR, bir 500 degil', () => {
    expect(parseOrderCursor('abc')).toBeNull()
    expect(parseOrderCursor('-1')).toBeNull()
    expect(parseOrderCursor('0')).toBeNull()
    expect(parseOrderCursor(null)).toBeNull()
    expect(parseOrderCursor('42')).toBe(42n)
  })

  it('varsayilan sinir makul, ve tavan zorlanir', async () => {
    expect(DEFAULT_ORDER_RATE_LIMIT.maxOpen).toBeGreaterThan(0)
    expect(DEFAULT_ORDER_RATE_LIMIT.maxPerWindow).toBeGreaterThan(0)
    const many = await listOrders(pool, TOKEN, ALICE, { limit: 10_000 })
    expect(many).toEqual([])
  })
})
