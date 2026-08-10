import type { LimitOrderRow } from '@arcpad/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  checkAmount,
  checkExpiresAt,
  checkOrderIssuedAt,
  ORDER_MAX_TTL_SECONDS,
  ORDER_MIN_TTL_SECONDS,
  orderPlaceText,
  orderResolveText,
  type OrderPlacePayload,
  type OrderResolvePayload,
  placeSignatureMatches,
} from '@/lib/limitOrder'
import { setFillReaderForTesting } from '@/lib/orderFill'

/**
 * ==========================================================================
 *  POST /api/orders (+ /resolve) -- PARA TASIYAN IKI YAZMA YOLU
 * ==========================================================================
 *
 * `test/chat/route.test.ts`in sekli ve gerekcesi aynen gecerli: iddialarin
 * cogu NEGATIFTIR ("su cagri su seyi YAPTIRAMAZ") ve negatif bir iddia ancak
 * yasak olan sey CALISTIGINDA ATACAK sekilde kurulursa OLCULUR. Bu yuzden
 * `getPool()` ve makbuz okuyucusu cagrildiklarinda ATAR.
 *
 * BURADA FAZLADAN OLCULEN UC SEY, VE UCU DE PARANIN OLDUGU YER:
 *
 *   1. IPTAL EDILMIS BIR EMIR DOLDURULAMAZ. (Semanin `WHERE`i bunu
 *      `packages/db`de gercek Postgres'e karsi olcuyor; BURADA olculen sey
 *      ROTANIN o cevabi 409'a cevirdigi ve makbuzu bosuna OKUMADIGI.)
 *   2. BIR EMIR IKI KEZ DOLAMAZ.
 *   3. BIR YABANCI, BASKASININ EMRINI NE IPTAL NE DOLU ISARETLEYEBILIR.
 */

process.env['NEXT_PUBLIC_ARC_CHAIN_ID'] ??= '5042002'
process.env['NEXT_PUBLIC_ARCPAD_FACTORY'] ??= '0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439'
process.env['NEXT_PUBLIC_ARCPAD_ESCROW'] ??= '0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6'

const preflight = vi.fn()
const place = vi.fn()
const getOrder = vi.fn()
const cancel = vi.fn()
const fill = vi.fn()
const poolStub = { query: vi.fn() }
const getPool = vi.fn(() => poolStub)

vi.mock('@arcpad/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcpad/db')>()
  return {
    ...actual,
    orderPreflight: preflight,
    placeOrder: place,
    getOrder,
    cancelOrder: cancel,
    markFilled: fill,
  }
})

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>()
  return { ...actual, getPool: () => getPool() }
})

const route = await import('@/app/api/orders/route')
const resolveRoute = await import('@/app/api/orders/resolve/route')

const ALICE = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const MALLORY = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const TOKEN = '0x085c926e24ed64bb045e67d26d9e76e5730c21b3'
const CURVE = '0xddb9e739a948c968eb4c7e1449b94c598b1cf27b'
const CHAIN_ID = Number(process.env['NEXT_PUBLIC_ARC_CHAIN_ID'])
const TX = `0x${'ee'.repeat(32)}`

let nonceCounter = 0
function nonce(): string {
  nonceCounter += 1
  return `0x${nonceCounter.toString(16).padStart(64, '0')}`
}

function payload(overrides: Partial<OrderPlacePayload> = {}): OrderPlacePayload {
  return {
    chainId: CHAIN_ID,
    token: TOKEN,
    owner: ALICE.address.toLowerCase(),
    isBuy: true,
    amount: '5000000000000000000',
    minOut: '1000000000000000000000',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    nonce: nonce(),
    issuedAt: new Date().toISOString(),
    ...overrides,
  }
}

async function signedPlace(
  p: OrderPlacePayload,
  key = ALICE,
): Promise<Record<string, unknown>> {
  return { ...p, signature: await key.signMessage({ message: orderPlaceText(p) }) }
}

function resolvePayload(overrides: Partial<OrderResolvePayload> = {}): OrderResolvePayload {
  return {
    chainId: CHAIN_ID,
    token: TOKEN,
    owner: ALICE.address.toLowerCase(),
    orderSeq: '7',
    intent: 'cancel',
    txHash: '',
    issuedAt: new Date().toISOString(),
    ...overrides,
  }
}

async function signedResolve(
  p: OrderResolvePayload,
  key = ALICE,
): Promise<Record<string, unknown>> {
  return { ...p, signature: await key.signMessage({ message: orderResolveText(p) }) }
}

function request(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const ROW: LimitOrderRow = {
  orderSeq: 7n,
  token: TOKEN as `0x${string}`,
  ownerAddr: ALICE.address.toLowerCase() as `0x${string}`,
  isBuy: true,
  amount: 5n * 10n ** 18n,
  minOut: 1_000n * 10n ** 18n,
  status: 'open',
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
  triggerBlockNumber: null,
  fillTxHash: null,
  nonceHex: `0x${'ab'.repeat(32)}`,
  signatureHex: `0x${'cd'.repeat(65)}`,
  issuedAt: new Date('2026-08-10T00:00:00.000Z'),
  createdAt: new Date('2026-08-10T00:00:01.000Z'),
}

/** Cagrildiginda ATAR. Negatif iddialarin tasiyicisi. */
function forbidBackends(): void {
  getPool.mockImplementation(() => {
    throw new Error('THE POOL WAS TOUCHED BEFORE THE SIGNATURE VERIFIED')
  })
  setFillReaderForTesting(() => {
    throw new Error('THE CHAIN WAS TOUCHED BEFORE THE SIGNATURE VERIFIED')
  })
}

function allowBackends(): void {
  getPool.mockImplementation(() => poolStub)
  setFillReaderForTesting(undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  allowBackends()
  preflight.mockResolvedValue({ launchExists: true, recentCount: 0, openCount: 0 })
  place.mockResolvedValue({ ok: true, row: ROW })
  getOrder.mockResolvedValue(ROW)
  cancel.mockResolvedValue({ changed: true, row: { ...ROW, status: 'cancelled' } })
  fill.mockResolvedValue({ changed: true, row: { ...ROW, status: 'filled', fillTxHash: TX } })
  poolStub.query.mockResolvedValue({ rows: [{ curve: CURVE }] })
})

// ---------------------------------------------------------------
describe('imza dogrulanmadan HICBIR arka uca dokunulmaz', () => {
  /**
   * ==========================================================================
   *  HER SATIR KENDI DURUM KODUNU TASIR -- VE BU BIR MUTASYON BULGUSUDUR
   * ==========================================================================
   *
   * ILK HALI yalnizca `status >= 400` ve "arka uc cagrilmadi" diyordu, ve o
   * hali VAKUMDU. Sebep: `forbidBackends()` `getPool()`i ATTIRIYOR, rota o
   * hatayi yakalayip **503** donuyor, ve `orderPreflight` mock'u `getPool()`
   * ONDAN ONCE atildigi icin HIC CAGRILMIYOR. Yani imzayi GECEN bir istek de,
   * imzada REDDEDILEN bir istek de tipatip ayni gorunuyordu (503 >= 400,
   * `preflight` cagrilmadi).
   *
   * OLCULDU: `checkAmount(payload.amount)` satirini silen mutant (W4) HAYATTA
   * KALDI, cunku `'0x10'` miktarli istek imzayi geciyor, `getPool()`e
   * carpiyor ve 503 doner -- test bunu "reddedildi" sayiyordu. HTTP e2e'de
   * ayni durum 400 `badAmount` donuyordu, yani DAVRANIS DOGRUYDU; kirilan sey
   * TESTIN AYIRT ETME GUCUYDU.
   *
   * Artik her satir BEKLENEN KODU ve BEKLENEN HATA ADINI tasiyor: 503 gormek
   * testi kirar.
   */
  const hostile: [string, number, string, () => Promise<unknown> | unknown][] = [
    ['bozuk JSON', 400, 'badRequest', () => 'not json'],
    ['eksik alan', 400, 'badRequest', () => ({ token: TOKEN })],
    ['yanlis zincir', 400, 'wrongChain', async () => signedPlace(payload({ chainId: CHAIN_ID + 1 }))],
    ['ondalik olmayan miktar', 400, 'badAmount', async () => signedPlace(payload({ amount: '0x10' }))],
    ['sifir miktar', 400, 'badAmount', async () => signedPlace(payload({ amount: '0' }))],
    ['bosluklu miktar', 400, 'badAmount', async () => signedPlace(payload({ amount: ' 5 ' }))],
    ['ondalik olmayan minOut', 400, 'badMinOut', async () => signedPlace(payload({ minOut: '0x20' }))],
    [
      'bir saat once imzalanmis',
      400,
      'expired',
      async () => signedPlace(payload({ issuedAt: new Date(Date.now() - 3_600_000).toISOString() })),
    ],
    [
      'bir yil sonra bitiyor',
      400,
      'tooFar',
      async () =>
        signedPlace(payload({ expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() })),
    ],
    [
      'bir dakika sonra bitiyor',
      400,
      'tooSoon',
      async () => signedPlace(payload({ expiresAt: new Date(Date.now() + 60_000).toISOString() })),
    ],
    ['baskasinin adina imzalanmis', 401, 'badSignature', async () => signedPlace(payload(), MALLORY)],
    [
      'imzadan SONRA degistirilmis miktar',
      401,
      'badSignature',
      async () => ({ ...(await signedPlace(payload())), amount: '999999999999999999999' }),
    ],
  ]

  for (const [label, status, error, build] of hostile) {
    it(`${label} -> ${status} ${error}, ve arka uca DOKUNULMAZ`, async () => {
      forbidBackends()
      const response = await route.POST(request('/api/orders', await build()))
      // KODU ONCE IDDIA ET. 503 gormek "reddedildi" DEGIL, "arka uca
      // dokunuldu" demektir -- ve bu satir olmadan ikisi ayirt edilemez.
      expect(response.status, `${label} answered ${response.status}`).toBe(status)
      expect((await response.json()).error).toBe(error)
      expect(preflight).not.toHaveBeenCalled()
      expect(place).not.toHaveBeenCalled()
    })
  }

  it('POZITIF KONTROL: gecerli bir istek arka uclara GERCEKTEN dokunur', async () => {
    // Bu satir olmadan yukaridaki on iki iddia, `POST`un hicbir sey yapmadigi
    // bir dunyada da yesil kalirdi.
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    expect(response.status).toBe(201)
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(place).toHaveBeenCalledTimes(1)
  })

  it('NEGATIF KONTROL: imzayi GECEN bir istek, arka uc atarken 503 verir', async () => {
    // Yukaridaki satirlarin ayirt etmek zorunda oldugu sey TAM OLARAK budur.
    // Bu test 503'un ULASILABILIR oldugunu gosterir, yani `toBe(status)`
    // iddialari bos degil GERCEK bir alternatifi disliyor.
    forbidBackends()
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    expect(response.status).toBe(503)
  })

  it('cok buyuk govde `JSON.parse` CAGRILMADAN reddedilir', async () => {
    forbidBackends()
    const response = await route.POST(request('/api/orders', 'x'.repeat(9_000)))
    expect(response.status).toBe(413)
  })
})

// ---------------------------------------------------------------
describe('kapilar, zincire ve INSERT\'e gitmeden', () => {
  it('bilinmeyen token -> 404', async () => {
    preflight.mockResolvedValue({ launchExists: false, recentCount: 0, openCount: 0 })
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    expect(response.status).toBe(404)
    expect(place).not.toHaveBeenCalled()
  })

  it('pencere kotasi dolu -> 429 ve `Retry-After`', async () => {
    preflight.mockResolvedValue({ launchExists: true, recentCount: 5, openCount: 0 })
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(place).not.toHaveBeenCalled()
  })

  it('acik emir tavani dolu -> 409, ve bu 429\'DAN AYRI bir cevaptir', async () => {
    preflight.mockResolvedValue({ launchExists: true, recentCount: 0, openCount: 20 })
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('tooManyOpen')
    expect(place).not.toHaveBeenCalled()
  })

  it('on eleme sorgusu duserse 503 -- 500 DEGIL', async () => {
    preflight.mockRejectedValue(new Error('connection refused'))
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    expect(response.status).toBe(503)
  })

  it('ayni nonce ikinci kez -> 409 `duplicateNonce`', async () => {
    place.mockResolvedValue({ ok: false, reason: 'duplicateNonce' })
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('duplicateNonce')
  })

  it('tel bicimi hicbir `bigint` tasimaz', async () => {
    const response = await route.POST(request('/api/orders', await signedPlace(payload())))
    const body = await response.json()
    expect(typeof body.order.amount).toBe('string')
    expect(typeof body.order.minOut).toBe('string')
    expect(typeof body.order.orderSeq).toBe('string')
  })

  it('§6.3: `GET` IHRAC EDILMEZ', () => {
    expect((route as Record<string, unknown>)['GET']).toBeUndefined()
    expect((resolveRoute as Record<string, unknown>)['GET']).toBeUndefined()
  })
})

// ---------------------------------------------------------------
describe('IPTAL VE DOLDURMA -- paranin oldugu yer', () => {
  it('sahibi iptal edebilir', async () => {
    const response = await resolveRoute.POST(
      request('/api/orders/resolve', await signedResolve(resolvePayload())),
    )
    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('BIR YABANCI baskasinin emrini iptal EDEMEZ', async () => {
    // Mallory kendi adresini yazip KENDI imzasini atar -- imza gecerlidir.
    // Kapi imzada degil, EMRIN SAHIBINDE.
    const p = resolvePayload({ owner: MALLORY.address.toLowerCase() })
    const response = await resolveRoute.POST(
      request('/api/orders/resolve', await signedResolve(p, MALLORY)),
    )
    expect(response.status).toBe(404)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('"yok" ile "senin degil" AYNI cevabi alir', async () => {
    getOrder.mockResolvedValue(null)
    const response = await resolveRoute.POST(
      request('/api/orders/resolve', await signedResolve(resolvePayload())),
    )
    expect(response.status).toBe(404)
    expect((await response.json()).error).toBe('unknownOrder')
  })

  /** ============ IPTALDEN SONRA DOLMAK ============ */
  it('IPTAL EDILMIS bir emir icin makbuz bile OKUNMAZ', async () => {
    getOrder.mockResolvedValue({ ...ROW, status: 'cancelled' })
    setFillReaderForTesting(() => {
      throw new Error('THE RECEIPT WAS READ FOR A CANCELLED ORDER')
    })
    const response = await resolveRoute.POST(
      request(
        '/api/orders/resolve',
        await signedResolve(resolvePayload({ intent: 'filled', txHash: TX })),
      ),
    )
    expect(response.status).toBe(409)
    expect((await response.json()).detail).toBe('cancelled')
    expect(fill).not.toHaveBeenCalled()
  })

  /** ============ IKI KEZ DOLMAK ============ */
  it('ZATEN DOLMUS bir emir tekrar doldurulamaz', async () => {
    getOrder.mockResolvedValue({ ...ROW, status: 'filled', fillTxHash: TX })
    const response = await resolveRoute.POST(
      request(
        '/api/orders/resolve',
        await signedResolve(resolvePayload({ intent: 'filled', txHash: TX })),
      ),
    )
    expect(response.status).toBe(409)
    expect(fill).not.toHaveBeenCalled()
  })

  it('UCUZ ELEME GECSE BILE, kaybedilen bir yaris 409 verir', async () => {
    // `getOrder` "canli" der ama UPDATE sifir satir gunceller -- keeper ya da
    // baska bir sekme araya girmistir. Rota bunu 200 DIYE OKUYAMAZ.
    setFillReaderForTesting(async () => ({ ok: true }))
    fill.mockResolvedValue({ changed: false, row: null })
    const response = await resolveRoute.POST(
      request(
        '/api/orders/resolve',
        await signedResolve(resolvePayload({ intent: 'filled', txHash: TX })),
      ),
    )
    expect(response.status).toBe(409)
  })

  it('MAKBUZ DOGRULANMADAN `filled` YAZILMAZ', async () => {
    setFillReaderForTesting(async () => ({ ok: false, reason: 'noTrade' }))
    const response = await resolveRoute.POST(
      request(
        '/api/orders/resolve',
        await signedResolve(resolvePayload({ intent: 'filled', txHash: TX })),
      ),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).detail).toBe('noTrade')
    expect(fill).not.toHaveBeenCalled()
  })

  it('makbuz OKUNAMAZSA 503 -- ve emir ACIK KALIR', async () => {
    setFillReaderForTesting(async () => ({ ok: false, reason: 'unavailable' }))
    const response = await resolveRoute.POST(
      request(
        '/api/orders/resolve',
        await signedResolve(resolvePayload({ intent: 'filled', txHash: TX })),
      ),
    )
    expect(response.status).toBe(503)
    expect(fill).not.toHaveBeenCalled()
  })

  it('KONTROL: gecerli bir makbuz emri KAPATIR', async () => {
    setFillReaderForTesting(async () => ({ ok: true }))
    const response = await resolveRoute.POST(
      request(
        '/api/orders/resolve',
        await signedResolve(resolvePayload({ intent: 'filled', txHash: TX })),
      ),
    )
    expect(response.status).toBe(200)
    expect(fill).toHaveBeenCalledWith(expect.anything(), 7n, ALICE.address.toLowerCase(), TX)
  })

  it('CURVE ADRESI VERITABANINDAN GELIR, istemciden DEGIL', async () => {
    // Istemci `token`i imzaliyor ama `curve`u HIC gondermiyor. Makbuz
    // dogrulamasi `launches.curve`e karsi yapilir; aksi halde sahip kendi
    // kontratindan bir `Trade` yayip emri kapatabilirdi.
    const seen: unknown[] = []
    setFillReaderForTesting(async (input) => {
      seen.push(input.curve)
      return { ok: true }
    })
    await resolveRoute.POST(
      request(
        '/api/orders/resolve',
        await signedResolve(resolvePayload({ intent: 'filled', txHash: TX })),
      ),
    )
    expect(seen).toEqual([CURVE])
  })

  it('`cancel` bir `txHash` TASIYAMAZ', async () => {
    // Metin onu tasimaz, yani gonderilen deger IMZALANMAMIS olurdu. Sessizce
    // yok saymak, imzalanan sey ile gonderilen sey arasinda bir bosluk acardi.
    const body = await signedResolve(resolvePayload())
    const response = await resolveRoute.POST(
      request('/api/orders/resolve', { ...body, txHash: TX }),
    )
    expect(response.status).toBe(400)
  })

  it('`filled` bir `txHash` OLMADAN gonderilemez', async () => {
    const response = await resolveRoute.POST(
      request('/api/orders/resolve', await signedResolve(resolvePayload({ intent: 'filled' }))),
    )
    expect(response.status).toBe(400)
  })

  it('bir IPTAL imzasi bir DOLDURMA olarak yeniden kullanilamaz', async () => {
    // Basliklar farkli (`arcpad cancel order` / `arcpad order filled`), yani
    // kurtarma baska bir adres verir.
    const cancelBody = await signedResolve(resolvePayload())
    const response = await resolveRoute.POST(
      request('/api/orders/resolve', { ...cancelBody, intent: 'filled', txHash: TX }),
    )
    expect(response.status).toBe(401)
  })
})

// ---------------------------------------------------------------
describe('imzalanan metin', () => {
  it('BIR ALIM imzasi bir SATIM olarak okunamaz', async () => {
    const buy = payload({ isBuy: true })
    const signature = await ALICE.signMessage({ message: orderPlaceText(buy) })
    expect(await placeSignatureMatches({ ...buy, isBuy: false }, signature)).toBe(false)
    // KONTROL: dogru yonle tutar.
    expect(await placeSignatureMatches(buy, signature)).toBe(true)
  })

  /**
   * ============ IKI SATIR, IKI MUTASYON BULGUSU ============
   *
   * `side:` satirini SABITLEYEN mutant (S1) ve iki basligi BIRLESTIREN mutant
   * (S3) ilk turda HAYATTA KALDI, ve ikisi de "kismen esdeger"di: metinde
   * BASKA bir sey de yone/niyete gore degistigi icin (alim/satim'da birim
   * etiketleri, iptal/doldurma'da `tx:` satiri) sonuc yine ayrisiyordu.
   *
   * Yani savunma derinligi vardi ama iki satirin KENDISI olculmuyordu. Bu iki
   * test onlari dogrudan sabitler: bir gun birim etiketleri tek bicime
   * dusurulurse, `side:` satirinin korumasi sessizce kaybolmasin.
   */
  it('`side:` SATIRI yone gore degisir, ve tek basina yeterlidir', () => {
    expect(orderPlaceText(payload({ isBuy: true }))).toContain('side: buy')
    expect(orderPlaceText(payload({ isBuy: false }))).toContain('side: sell')
  })

  it('IPTAL ve DOLDURMA basliklari FARKLIDIR, tek basina', () => {
    const base = resolvePayload()
    const cancelText = orderResolveText({ ...base, intent: 'cancel' })
    const fillText = orderResolveText({ ...base, intent: 'filled', txHash: TX })
    const firstLine = (text: string): string => text.slice(0, text.indexOf('\n'))
    expect(firstLine(cancelText)).not.toBe(firstLine(fillText))
    expect(firstLine(cancelText)).toBe('arcpad cancel order')
    expect(firstLine(fillText)).toBe('arcpad order filled')
  })

  it('BIRIM METNIN ICINDEDIR -- alim `spend_wei`, satim `sell_tok` der', () => {
    const buy = orderPlaceText(payload({ isBuy: true }))
    const sell = orderPlaceText(payload({ isBuy: false }))
    expect(buy).toContain('spend_wei: ')
    expect(buy).toContain('min_out_tok: ')
    expect(sell).toContain('sell_tok: ')
    expect(sell).toContain('min_out_wei: ')
  })

  it('HICBIR ALAN SERBEST DEGILDIR -- birebirlik yapisaldir', () => {
    // Chat'in `body`si serbestti ve birebirlik "en sona koy" ile KURULMUSTU.
    // Burada her satir sabit bicimli, yani iki farkli alan kumesinin ayni
    // metni uretmesi TEMSIL EDILEMEZ. Olcum: her alanin degisimi metni
    // degistirir, ve hicbir alanin degeri bir satir sonu TASIYAMAZ.
    const base = payload()
    const text = orderPlaceText(base)
    const variants: OrderPlacePayload[] = [
      { ...base, amount: '5000000000000000001' },
      { ...base, minOut: '1000000000000000000001' },
      { ...base, isBuy: false },
      { ...base, nonce: nonce() },
      { ...base, token: `0x${'ab'.repeat(20)}` },
      { ...base, owner: `0x${'cd'.repeat(20)}` },
      { ...base, chainId: base.chainId + 1 },
    ]
    for (const v of variants) expect(orderPlaceText(v)).not.toBe(text)
    expect(text.split('\n')).toHaveLength(10)
  })

  it('bir imza baska bir aga ya da baska bir token altina TASINAMAZ', async () => {
    const base = payload()
    const signature = await ALICE.signMessage({ message: orderPlaceText(base) })
    expect(await placeSignatureMatches({ ...base, chainId: base.chainId + 1 }, signature)).toBe(false)
    expect(await placeSignatureMatches({ ...base, token: `0x${'ab'.repeat(20)}` }, signature)).toBe(
      false,
    )
  })

  it('kurtarma HICBIR AG CAGRISI YAPMAZ', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('the signature path made a network call')
    }) as typeof fetch
    try {
      const base = payload()
      const signature = await ALICE.signMessage({ message: orderPlaceText(base) })
      expect(await placeSignatureMatches(base, signature)).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('miktar deseni: `BigInt()` CAGRILMADAN once', () => {
    expect(checkAmount('1')).toBe('ok')
    expect(checkAmount('0')).toBe('malformed')
    // `BigInt('0x10')` CALISIR ve 16 doner. Metin ham dizeyi tasidigi icin
    // kullanici "0x10" imzalar, zincire 16 gider ve HICBIR SEY tutarsiz
    // gorunmez. Bu satir o yolu kapatir.
    expect(checkAmount('0x10')).toBe('malformed')
    expect(checkAmount(' 5 ')).toBe('malformed')
    expect(checkAmount('5.5')).toBe('malformed')
    expect(checkAmount('-5')).toBe('malformed')
    expect(checkAmount('')).toBe('malformed')
  })

  it('pencereler sunucunun saatine karsi', () => {
    const now = Date.parse('2026-08-10T00:00:00.000Z')
    expect(checkOrderIssuedAt('2026-08-10T00:00:00.000Z', now)).toBe('ok')
    expect(checkOrderIssuedAt('2026-08-09T23:54:59.000Z', now)).toBe('expired')
    expect(checkOrderIssuedAt('2026-08-10T00:02:00.000Z', now)).toBe('fromTheFuture')
    expect(checkOrderIssuedAt('2026-08-10T00:00:00Z', now)).toBe('malformed')
  })

  it('son kullanma penceresi ve ikisinin ILISKISI', () => {
    const now = Date.parse('2026-08-10T00:00:00.000Z')
    const at = (seconds: number): string => new Date(now + seconds * 1000).toISOString()
    expect(checkExpiresAt(at(ORDER_MIN_TTL_SECONDS + 1), now)).toBe('ok')
    expect(checkExpiresAt(at(ORDER_MIN_TTL_SECONDS - 1), now)).toBe('tooSoon')
    expect(checkExpiresAt(at(ORDER_MAX_TTL_SECONDS + 1), now)).toBe('tooFar')
    // ALT SINIR IMZANIN TTL'INDEN KISA OLAMAZ: aksi halde kullanici,
    // imzalarken ZATEN OLMUS bir emir uretebilirdi.
    expect(ORDER_MIN_TTL_SECONDS).toBeGreaterThanOrEqual(300)
  })
})
