import type { ChatMessageRow } from '@arcpad/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { chatMessageText, type ChatPayload } from '@/lib/chatMessage'
import { setHolderReaderForTesting } from '@/lib/chatBalance'

/**
 * ==========================================================================
 *  POST /api/chat -- URUNUN ILK YAZMA YOLU, DUSMAN BIR CAGRICIYA KARSI
 * ==========================================================================
 *
 * Buradaki iddialarin cogu POZITIF DEGIL NEGATIFTIR: "su cagri su seyi
 * YAPTIRAMAZ". Bir yazma rotasinda onemli olan sey odur, ve negatif bir
 * iddia ancak yapilmasi yasak olan sey CALISTIGINDA ATACAK sekilde kurulursa
 * olculur. Bu yuzden:
 *
 *   - `getPool()` cagrildiginda ATAR,
 *   - zincir okuyucusu cagrildiginda ATAR,
 *   - ve testler o cagrilarin OLMADIGINI, sayacla degil ARIZANIN YOKLUGUYLA
 *     gosterir (bir sayac unutulabilir; bir 500 unutulamaz).
 *
 * VERITABANININ KENDI DAVRANISI BURADA SAHTELENMISTIR ve bu bilincli bir
 * boluntudur: nonce'un UNIQUE oldugu, yabanci anahtarin tuttugu, hiz
 * sinirinin advisory lock altinda TAM oldugu -- ucu de GERCEK bir Postgres'e
 * karsi `packages/db/test/chat.test.ts`te olculuyor. Burada olculen sey
 * ROTANIN o cevaplari nasil SIRALADIGI ve hangi HTTP koduna cevirdigi.
 */

/**
 * ENV BURADA KURULUR, `test/setup.ts`TE DEGIL.
 *
 * `setup.ts` YALNIZCA `component` projesine (jsdom, `*.test.tsx`) bagli;
 * bu dosya `unit` projesinde (node) kosar ve orada setupFiles YOKTUR. Env'i
 * kurmadan `getWebConfig()` `WebConfigError` atar ve testler rotanin degil
 * yapilandirmanin eksikliginden kirmizi olurdu.
 *
 * Degerler `test/setup.ts` ile AYNI ve GERCEK: uydurma bir chain id de
 * derlenirdi, ama o zaman "yanlis zincir" testi bir sabiti degil kendi
 * uydurmasini olcerdi. `import`lardan ONCE calismasi icin en uste konuldu --
 * `route.ts` `getWebConfig()`i cagri aninda okur, yani bu yeterli.
 */
process.env['NEXT_PUBLIC_ARC_CHAIN_ID'] ??= '5042002'
process.env['NEXT_PUBLIC_ARCPAD_FACTORY'] ??= '0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439'
process.env['NEXT_PUBLIC_ARCPAD_ESCROW'] ??= '0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6'

const preflight = vi.fn()
const post = vi.fn()
const poolStub = { query: vi.fn() }
const getPool = vi.fn(() => poolStub)

vi.mock('@arcpad/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcpad/db')>()
  return { ...actual, chatPreflight: preflight, postChatMessage: post }
})

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>()
  return { ...actual, getPool: () => getPool() }
})

const route = await import('@/app/api/chat/route')

const ALICE = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const MALLORY = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const TOKEN = '0x085c926e24ed64bb045e67d26d9e76e5730c21b3'
/** `test/setup.ts` `NEXT_PUBLIC_ARC_CHAIN_ID`i gercek deger olarak koyuyor. */
const CHAIN_ID = Number(process.env['NEXT_PUBLIC_ARC_CHAIN_ID'])

let nonceCounter = 0
function nonce(): string {
  nonceCounter += 1
  return `0x${nonceCounter.toString(16).padStart(64, '0')}`
}

function basePayload(overrides: Partial<ChatPayload> = {}): ChatPayload {
  return {
    chainId: CHAIN_ID,
    token: TOKEN,
    author: ALICE.address.toLowerCase(),
    nonce: nonce(),
    issuedAt: new Date().toISOString(),
    body: 'gm',
    ...overrides,
  }
}

async function signed(payload: ChatPayload, key = ALICE): Promise<Record<string, unknown>> {
  return { ...payload, signature: await key.signMessage({ message: chatMessageText(payload) }) }
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const ROW: ChatMessageRow = {
  messageSeq: 7n,
  token: TOKEN,
  authorAddr: ALICE.address.toLowerCase(),
  body: 'gm',
  balanceTok: 5n * 10n ** 24n,
  balanceBlockNumber: 55_870_261n,
  nonceHex: `0x${'ab'.repeat(32)}`,
  signatureHex: `0x${'cd'.repeat(65)}`,
  issuedAt: new Date('2026-08-10T00:00:00.000Z'),
  createdAt: new Date('2026-08-10T00:00:01.000Z'),
  currentBalanceTok: 0n,
  isLaunchCreator: false,
}

/** Cagrildiginda ATAR. "Zincire hic gidilmedi" iddiasinin tasiyicisi. */
function forbiddenChainReader() {
  return vi.fn(() => {
    throw new Error('the chain must not be read on this path')
  })
}

/** Cagrildiginda ATAR. "Veritabanina hic gidilmedi" iddiasinin tasiyicisi. */
function forbidDatabase(): void {
  getPool.mockImplementation(() => {
    throw new Error('the database must not be reached on this path')
  })
  preflight.mockImplementation(() => {
    throw new Error('preflight must not run on this path')
  })
  post.mockImplementation(() => {
    throw new Error('insert must not run on this path')
  })
}

/** Mutlu yolun kurulumu: launch var, kota bos, zincir bir bakiye veriyor. */
function allowEverything(balanceTok = 5n * 10n ** 24n): ReturnType<typeof vi.fn> {
  getPool.mockImplementation(() => poolStub)
  preflight.mockResolvedValue({ launchExists: true, recentCount: 0 })
  post.mockResolvedValue({ ok: true, row: ROW })
  const reader = vi.fn(async () => ({ ok: true as const, balanceTok, blockNumber: 55_870_261n }))
  setHolderReaderForTesting(reader as never)
  return reader
}

beforeEach(() => {
  vi.clearAllMocks()
  setHolderReaderForTesting(undefined)
})

// ==========================================================================
//  1. IMZASIZ HICBIR ARKA UCA DOKUNULMAZ
// ==========================================================================

describe('imza dogrulanmadan HICBIR I/O yapilmaz', () => {
  beforeEach(() => {
    forbidDatabase()
    setHolderReaderForTesting(forbiddenChainReader() as never)
  })

  it('bicimsiz JSON -> 400, sifir I/O', async () => {
    const response = await route.POST(request('{not json'))
    expect(response.status).toBe(400)
    expect(getPool).not.toHaveBeenCalled()
  })

  it('eksik alanlar -> 400, sifir I/O', async () => {
    for (const body of [
      {},
      { token: TOKEN },
      { ...basePayload() }, // imza YOK
      { ...basePayload(), signature: 'nope' },
      { ...basePayload(), token: 'not-an-address', signature: `0x${'ab'.repeat(65)}` },
      { ...basePayload(), nonce: '0xshort', signature: `0x${'ab'.repeat(65)}` },
      { ...basePayload(), chainId: '5042002', signature: `0x${'ab'.repeat(65)}` },
    ]) {
      const response = await route.POST(request(body))
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect(getPool).not.toHaveBeenCalled()
  })

  /**
   * BASKASININ ADINA YAZMA GIRISIMI. Bu, rotanin var olma sebebi olan
   * saldiridir: govdedeki `author` bir IDDIADIR, imza ise bir DELIL.
   */
  it('BASKASININ ADINA imza -> 401, sifir I/O', async () => {
    const payload = basePayload({ author: ALICE.address.toLowerCase() })
    const response = await route.POST(request(await signed(payload, MALLORY)))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'badSignature' })
    expect(getPool).not.toHaveBeenCalled()
  })

  /**
   * IMZALANAN GOVDE ILE GONDERILEN GOVDE AYRISIRSA. Saldirgan zararsiz bir
   * cumleyi imzalatip govdeyi degistirebilseydi, imza sistemi hicbir sey
   * ifade etmezdi.
   */
  it('imzadan SONRA degistirilen govde -> 401', async () => {
    const honest = basePayload({ body: 'gm' })
    const body = await signed(honest)
    const response = await route.POST(request({ ...body, body: 'buy my thing' }))
    expect(response.status).toBe(401)
  })

  it('LINK iceren govde -> 400, ve ZINCIRE HIC GIDILMEZ', async () => {
    // Link kontrolu imzadan da ONCE: gecerli imzali bir link mesaji da
    // zincire ulasmadan duser, yani spam bize RPC objesi harcatamaz.
    const response = await route.POST(
      request(await signed(basePayload({ body: 'go to evil.com' }))),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'link', detail: 'evil.com' })
    expect(getPool).not.toHaveBeenCalled()
  })

  it('COK BUYUK istek -> 413, ve `JSON.parse` bile calismaz', async () => {
    // Govde GECERLI JSON ama devasa. 413 aliyorsa boy kontrolu parse'tan
    // ONCE demektir.
    const huge = JSON.stringify({ ...basePayload(), body: 'a'.repeat(20_000) })
    expect(huge.length).toBeGreaterThan(route.CHAT_MAX_REQUEST_BYTES)
    const response = await route.POST(request(huge))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'requestTooLarge' })
  })

  it('YANLIS ZINCIR -> 400, sifir I/O', async () => {
    const response = await route.POST(request(await signed(basePayload({ chainId: 1 }))))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'wrongChain' })
    expect(getPool).not.toHaveBeenCalled()
  })

  it('ESKIMIS imza -> 400 `expired`, sifir I/O', async () => {
    const stale = basePayload({ issuedAt: new Date(Date.now() - 3_600_000).toISOString() })
    const response = await route.POST(request(await signed(stale)))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'expired' })
    expect(getPool).not.toHaveBeenCalled()
  })

  it('GELECEKTEN gelen imza -> 400 `fromTheFuture`', async () => {
    const ahead = basePayload({ issuedAt: new Date(Date.now() + 3_600_000).toISOString() })
    const response = await route.POST(request(await signed(ahead)))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'fromTheFuture' })
  })

  it('Postgres`in `text`ine giremeyen govde -> 400, 503 DEGIL', async () => {
    // `JSON.parse('"\\ud800"')` tek basina bir vekil uretir. Bu kontrol
    // olmasaydi INSERT Postgres'te patlar ve kullanici 503 gorurdu.
    const payload = basePayload({ body: JSON.parse('"a\\ud800b"') as string })
    const response = await route.POST(request(await signed(payload)))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'hostileCharacters' })
    expect(getPool).not.toHaveBeenCalled()
  })
})

// ==========================================================================
//  2. IMZA GECERLI -- AMA ZINCIRE HALA ERKEN GIDILMEZ
// ==========================================================================

describe('gecerli imza, ZINCIRDEN ONCEKI kapilar', () => {
  it('BILINMEYEN TOKEN -> 404, ve zincire GIDILMEZ', async () => {
    getPool.mockImplementation(() => poolStub)
    preflight.mockResolvedValue({ launchExists: false, recentCount: 0 })
    const reader = forbiddenChainReader()
    setHolderReaderForTesting(reader as never)

    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknownToken' })
    // ============ BU SIRA BIR KAYNAK KORUMASIDIR ============
    // Gecerli imza uretmek bir cuzdan sahibi icin BEDAVADIR. Kontrol zincirden
    // sonra olsaydi, bir dongu var olmayan adreslere POST atarak RPC
    // kotamizi yakabilirdi.
    expect(reader).not.toHaveBeenCalled()
  })

  it('KOTA DOLU -> 429 + Retry-After, ve zincire GIDILMEZ', async () => {
    getPool.mockImplementation(() => poolStub)
    preflight.mockResolvedValue({ launchExists: true, recentCount: 5 })
    const reader = forbiddenChainReader()
    setHolderReaderForTesting(reader as never)

    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(reader).not.toHaveBeenCalled()
  })

  it('preflight sorgusu DUSERSE -> 503, ve yine zincire gidilmez', async () => {
    getPool.mockImplementation(() => poolStub)
    preflight.mockRejectedValue(new Error('connection refused'))
    const reader = forbiddenChainReader()
    setHolderReaderForTesting(reader as never)

    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'databaseUnavailable' })
    expect(reader).not.toHaveBeenCalled()
  })
})

// ==========================================================================
//  3. HOLDER KAPISI
// ==========================================================================

describe('holder kapisi', () => {
  it('SIFIR bakiye -> 403, ve satir YAZILMAZ', async () => {
    getPool.mockImplementation(() => poolStub)
    preflight.mockResolvedValue({ launchExists: true, recentCount: 0 })
    setHolderReaderForTesting(
      vi.fn(async () => ({ ok: true as const, balanceTok: 0n, blockNumber: 1n })) as never,
    )
    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'notAHolder' })
    expect(post).not.toHaveBeenCalled()
  })

  it('BIR birim bile yeter -- esik SIFIRDIR ve bu bir karardir', async () => {
    allowEverything(1n)
    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(201)
  })

  /**
   * RPC DUSTUGUNDE KAPALI DUSER.
   *
   * Alternatif -- bakiyeyi bilinmez sayip yazmak -- iki seyi birden bozardi:
   * kapiyi (holder olmayan yazabilirdi) ve KAYDI (`balance_tok` olculmemis
   * bir sayi tasirdi). Bedeli acikca yazili: RPC dustugunde chat'e YAZILAMAZ.
   */
  it('ZINCIR OKUNAMAZSA -> 503, ve satir YAZILMAZ', async () => {
    getPool.mockImplementation(() => poolStub)
    preflight.mockResolvedValue({ launchExists: true, recentCount: 0 })
    setHolderReaderForTesting(
      vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })) as never,
    )
    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'chainUnavailable' })
    expect(post).not.toHaveBeenCalled()
  })
})

// ==========================================================================
//  4. YAZMA VE VERITABANININ CEVAPLARI
// ==========================================================================

describe('yazma', () => {
  it('mutlu yol -> 201, ve SAKLANAN degerler ZINCIRDEN gelir', async () => {
    const reader = allowEverything(5n * 10n ** 24n)
    const payload = basePayload({ body: 'gm fren' })
    const response = await route.POST(request(await signed(payload)))

    expect(response.status).toBe(201)
    expect(reader).toHaveBeenCalledWith(TOKEN, ALICE.address.toLowerCase())

    /*
     * ============ YUKARIDAKI HER `not.toHaveBeenCalled()` ICIN POZITIF KONTROL ============
     *
     * Bu iddia olmadan butun "sifir I/O" testleri BOS OLABILIRDI: `vi.mock`
     * sessizce uygulanmasaydi bu casus HICBIR ZAMAN cagrilmazdi ve her
     * `not.toHaveBeenCalled()` kendiliginden gecerdi -- yani rota veritabanina
     * gitse bile testler yesil kalirdi. Burasi casusun GERCEKTEN rotanin
     * cagirdigi sey oldugunu gosterir.
     */
    expect(getPool).toHaveBeenCalled()
    expect(preflight).toHaveBeenCalled()
    expect(post).toHaveBeenCalled()

    const written = post.mock.calls[0]?.[1] as Record<string, unknown>
    // ============ BAKIYE ISTEMCIDEN ALINMAZ ============
    // Govdede boyle bir alan YOKTUR ve olsa da okunmazdi: yazilan sayi
    // zincir okumasindan gelir, blok numarasi da ayni okumadan.
    expect(written['balanceTok']).toBe(5n * 10n ** 24n)
    expect(written['balanceBlockNumber']).toBe(55_870_261n)
    expect(written['authorAddr']).toBe(ALICE.address.toLowerCase())
    expect(written['body']).toBe('gm fren')
    expect(written['nonceHex']).toBe(payload.nonce)
    // IMZA SAKLANIR: satir bagimsizca dogrulanabilsin diye.
    expect(String(written['signatureHex'])).toMatch(/^0x[0-9a-f]{130}$/)
  })

  it('ISTEMCININ GONDERDIGI bakiye/blok alanlari YOK SAYILIR', async () => {
    const reader = allowEverything(7n)
    const payload = basePayload()
    const body = {
      ...(await signed(payload)),
      balanceTok: '999999999999999999999999999',
      balanceBlockNumber: '1',
      isLaunchCreator: true,
      messageSeq: '1',
    }
    const response = await route.POST(request(body))
    expect(response.status).toBe(201)
    expect(reader).toHaveBeenCalled()
    const written = post.mock.calls[0]?.[1] as Record<string, unknown>
    expect(written['balanceTok']).toBe(7n)
    expect(written['balanceBlockNumber']).toBe(55_870_261n)
  })

  it('TEKRAR OYNATMA -> 409, `duplicateNonce`', async () => {
    allowEverything()
    post.mockResolvedValue({ ok: false, reason: 'duplicateNonce' })
    const response = await route.POST(request(await signed(basePayload())))
    // 409, 400 DEGIL: istek kusursuz bicimli ve imzasi gecerli -- yalnizca
    // DAHA ONCE yazilmis. 400 demek onu "bozuk istek" diye gizlerdi.
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'duplicateNonce' })
  })

  it('kilit altindaki IKINCI sayim kotayi doldurursa -> 429', async () => {
    // On eleme gecti ama yetkili sayim reddetti. Ikisinin AYRI olmasi
    // (`chatPreflight` yetkili DEGIL) tam olarak bu dalin var olma sebebi.
    allowEverything()
    post.mockResolvedValue({ ok: false, reason: 'rateLimited', retryAfterSeconds: 60 })
    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
  })

  it('yabanci anahtar INSERT aninda duserse -> 404', async () => {
    allowEverything()
    post.mockResolvedValue({ ok: false, reason: 'unknownToken' })
    expect((await route.POST(request(await signed(basePayload())))).status).toBe(404)
  })

  it('bir CHECK reddederse -> 400 ve KISIT ADI cevapta', async () => {
    allowEverything()
    post.mockResolvedValue({
      ok: false,
      reason: 'rejected',
      constraint: 'chat_messages_body_check',
    })
    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ detail: 'chat_messages_body_check' })
  })

  it('INSERT atarsa -> 503, 500 DEGIL', async () => {
    allowEverything()
    post.mockRejectedValue(new Error('connection terminated'))
    const response = await route.POST(request(await signed(basePayload())))
    expect(response.status).toBe(503)
  })
})

// ==========================================================================
//  5. §6.3: BU ROTA YAZMA ICINDIR
// ==========================================================================

describe('§6.3 -- API rotalari YALNIZCA yazma icin', () => {
  it('`GET` IHRAC EDILMEZ', () => {
    // Panel Postgres'i bir server component'ten okur (`readChat`). Buraya bir
    // `GET` eklemek iki okuma yolu dogururdu ve ikisi ayrisirdi.
    expect((route as Record<string, unknown>)['GET']).toBeUndefined()
    expect((route as Record<string, unknown>)['PUT']).toBeUndefined()
    expect((route as Record<string, unknown>)['DELETE']).toBeUndefined()
    expect(typeof route.POST).toBe('function')
  })

  it('tel bicimi `bigint` tasimaz -- ondalik DIZE', async () => {
    allowEverything()
    const response = await route.POST(request(await signed(basePayload())))
    const doc = (await response.json()) as { message: Record<string, unknown> }
    expect(doc.message['messageSeq']).toBe('7')
    expect(doc.message['balanceTok']).toBe('5000000000000000000000000')
    expect(doc.message['currentBalanceTok']).toBe('0')
    // NONCE VE IMZA TELDE DONMEZ: ekranda isi olmayan seylerdir ve imzayi
    // yankilamak, onu tekrar oynatmak isteyen birine kolaylik olurdu.
    expect(doc.message['nonceHex']).toBeUndefined()
    expect(doc.message['signatureHex']).toBeUndefined()
  })
})
