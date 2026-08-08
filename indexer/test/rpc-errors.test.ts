import { readFileSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPublicClient, http } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { asRpcError, SingleBlockTooLarge } from '../src/logs'
import { isTransient } from '../src/run'

/**
 * RPC HATA SINIFLANDIRMASI -- GERCEK HATA NESNELERI UZERINDE.
 *
 * BU DOSYA VAR CUNKU AYNI SINIF ELLE YAZILMIS `new Error('429 ...')`
 * DIZGELERIYLE TEST EDILIYORDU VE O TESTLER GERCEK YOLU HIC GORMUYORDU.
 * Gercek yolda hata viem'in urettigi bir nesnedir ve viem mesaja
 *
 *     URL: https://rpc.testnet.arc.network
 *     Request body: {"method":"eth_getLogs","params":[...]}
 *
 * satirlarini KOYAR -- yani BIZIM gonderdigimiz seyleri. Siniflandirici o
 * blokta desen arayinca RPC ADRESININ KENDISINE tutuyordu (`/network/i` vs.
 * `arc.network`) ve canliya atilan on alti istegin HEPSI gecici cikiyordu:
 * `-32601 method not supported`, `-32602 invalid params`, `3 execution
 * reverted` dahil. Dosyanin yazili varsayilani "bilinmeyen hata KALICIDIR"
 * uretimde TERSINE donmustu ve hicbir birim testi bunu goremezdi.
 *
 * Buradaki her vaka gercek bir HTTP sunucusuna gercek bir viem istemcisiyle
 * gidiyor; yani viem'in bicimlendirmesi degisirse bu testler bunu SOYLER.
 */

let servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  servers = []
})

/** Verilen handler'i dinleyen bir sunucu acar ve o adrese giden istemciyi doner. */
async function client(handler: RequestListener, path = ''): Promise<ReturnType<typeof make>> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return make(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)
}

function make(url: string) {
  // `retryCount: 0` -- viem'in KENDI yeniden denemesi burada olculeni bulanik
  // yapardi; sinifi ilk cevaptan okuyoruz.
  const c = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 300 }) })
  return {
    url,
    async fail(): Promise<unknown> {
      try {
        await c.request({ method: 'eth_chainId' })
      } catch (error) {
        return error
      }
      throw new Error(`${url} hata vermedi -- bu testin girdisi bir HATA olmali`)
    },
  }
}

/** JSON-RPC seviyesinde hata donen bir sunucu (HTTP 200). */
const jsonRpcError =
  (code: number, message: string): RequestListener =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }))
  }

/** HTTP seviyesinde hata donen bir sunucu. */
const httpError =
  (status: number, body: string): RequestListener =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end(body)
  }

describe('asRpcError', () => {
  it('details ISTEK ADRESINI VE GOVDESINI TASIMAZ, message TASIR', async () => {
    // Yol parcasi olarak Arc'in gercek ana bilgisayar adi: viem tam URL'i
    // mesaja yazar, yani adresin HERHANGI bir parcasi siniflandirmaya sizabilir.
    const c = await client(jsonRpcError(-32601, 'method not supported'), '/rpc.testnet.arc.network')
    const { message, details } = asRpcError(await c.fail())

    // (1) viem GERCEKTEN kendi mesajina URL'i ve istek govdesini koyuyor.
    expect(message).toContain('rpc.testnet.arc.network')
    expect(message).toContain('Request body')
    // (2) Siniflandirmanin okudugu alan onlarin HICBIRINI tasimiyor.
    expect(details).not.toContain('rpc.testnet.arc.network')
    expect(details).not.toContain('Request body')
    expect(details).not.toContain('127.0.0.1')
    // (3) Ve sunucunun kendi metni HALA orada.
    expect(details).toContain('method not supported')
  })

  it('HTTP durum kodunu ALAN olarak okur', async () => {
    const c = await client(httpError(429, 'Too Many Requests'))
    expect(asRpcError(await c.fail()).status).toBe(429)
  })

  it('duz bir transportun {code, message} sekli details e duser', () => {
    const plain = Object.assign(new Error('request limit reached'), { code: -32011 })
    const shape = asRpcError(plain)
    expect(shape.code).toBe(-32011)
    expect(shape.details).toContain('request limit reached')
  })
})

describe('isTransient -- GERCEK viem hatalari', () => {
  /**
   * ASIL REGRESYON. RPC adresi `arc.network` uzerinde oldugu icin eski desen
   * bu KALICI hatayi gecici sayiyordu.
   */
  it('RPC adresi arc.network olsa bile -32601 KALICIDIR', async () => {
    const c = await client(jsonRpcError(-32601, 'method not supported'), '/rpc.testnet.arc.network')
    expect(isTransient(await c.fail())).toBe(false)
  })

  it('canli Arc ta olculen KALICI kodlar kalicidir', async () => {
    // Hepsi CANLI Arc'tan, uretim istemcisiyle. Son ikisi 2026-08-05'te
    // eklendi (head 55.339.691): `-32603` gelecege dusen bir `eth_getLogs`
    // araligi ve `eth_newFilter` icin, UST USTE UC kez ayni yanitla --
    // yani kendiliginden gecmiyor; `-32001` head'in ustundeki bir blokta
    // `eth_getBalance`/`eth_call` icin. IKISI DE dongude ULASILAMAZ
    // (`runOnce` `finalized`in otesini sormaz, filtre yaratmaz,
    // `eth_getBalance` cagirmaz), ama artik TAHMIN degil OLCUM olarak kalici.
    const measured: [number, string][] = [
      [-32601, 'method not supported'],
      [-32602, 'Invalid params'],
      [-32012, 'requested range too large'],
      [3, 'execution reverted'],
      [-32603, 'internal error'],
      [-32001, 'block not found: 0x398b5eb'],
    ]
    for (const [code, message] of measured) {
      const c = await client(jsonRpcError(code, message), '/rpc.testnet.arc.network')
      expect(isTransient(await c.fail()), `${code} ${message}`).toBe(false)
    }
  })

  /**
   * ARC'IN IKI HIZ SINIRI KODU, IKISI DE OLCULDU (2026-08-04, on dort
   * `eth_getLogs`lik olculu bir patlama; ikisi KARISIK geldi ve ikisi de
   * HTTP 429 tasiyordu):
   *
   *   {"code":-32005,"message":"rate limit exceeded"}
   *   {"code":-32011,"message":"request limit reached"}
   *
   * `-32005` bu depoda hic kayitli DEGILDI. Ilk turda yazilan "Arc'in hiz
   * siniri kodu -32011'dir" cumlesi, ulasilan ORNEKLEMIN tamamiydi.
   */
  it('Arc in IKI hiz siniri kodu da GECICIDIR', async () => {
    for (const [code, message] of [
      [-32011, 'request limit reached'],
      [-32005, 'rate limit exceeded'],
    ] as [number, string][]) {
      const c = await client((_q, res) => {
        // GERCEK SEKIL: govde JSON-RPC hatasi, HTTP durumu 429.
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }))
      })
      expect(isTransient(await c.fail()), `${code}`).toBe(true)
    }
  })

  /**
   * BILINMEYEN BIR UCUNCU HIZ SINIRI KODU DA GECICI OLMALI -- VE ONU KURTARAN
   * SEY 429 DEGIL, METINDIR.
   *
   * Bu testin ilk hali "429 kod kumesinden once okunur" diyordu ve KIRMIZI
   * GELDI. Olculen sebep: govde gecerli bir JSON-RPC hatasi oldugunda viem
   * `RpcRequestError` uretir ve HTTP durumunu TASIMAZ -- `status` `undefined`
   * kalir. Arc'in hiz siniri tam olarak bu sekilde gelir (429 + JSON-RPC
   * govdesi), yani "429 otoriterdir" cumlesi Arc'in kendi seklinde YANLIS.
   *
   * Ayakta kalan guvence METIN kontrolunun kalici kod kumesinden ONCE
   * gelmesidir. Asagidaki vaka bunu olcuyor: kod KALICI kumesinde, mesaj hiz
   * siniri diyor, sonuc GECICI.
   *
   * KALAN ACIK: hem kodu hem metni tanimadigimiz bir hiz siniri hala KALICI
   * sayilir. Bu tahmin edilerek kapatilamaz; kapatan sey yeni bir olcumdur.
   */
  it('KALICI bir kod tasisa bile hiz siniri METNI GECICI kazandirir', async () => {
    const c = await client((_q, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32602, message: 'rate limit exceeded' },
        }),
      )
    })
    const error = await c.fail()
    // OLCUM: JSON-RPC govdesi varken HTTP durumu hataya HIC ulasmiyor.
    expect(asRpcError(error).status).toBeUndefined()
    expect(asRpcError(error).code).toBe(-32602)
    expect(isTransient(error)).toBe(true)
  })

  /**
   * ZAMAN ASIMI. viem'in `TimeoutError`i "The request timed out." der --
   * icinde "timeout" KELIMESI GECMEZ, yani eski desen onu KALICI sayiyordu.
   * URETIM istemcisi (`createArcClient`) 10sn zaman asimi + 3 yeniden deneme
   * ile ~41sn sonra tam olarak bu hatayi atiyor (OLCULDU), yani asili bir
   * Arc RPC'si indexer'i DURDURACAKTI. Bugun durdurmuyordu -- ama yalnizca
   * yukaridaki `/network/i` kazasi ortuyordu diye.
   */
  it('zaman asimi GECICIDIR (viem TimeoutError icinde "timeout" GECMEZ)', async () => {
    const c = await client((_q, res) => {
      setTimeout(() => res.end('{}'), 30_000).unref()
    })
    const error = await c.fail()
    expect((error as { name?: string }).name).toBe('TimeoutError')
    // Kanit: eski desenin aradigi kelime GERCEKTEN yok.
    expect(asRpcError(error).details).not.toMatch(/timeout/i)
    expect(isTransient(error)).toBe(true)
  })

  it('HTTP 5xx/429 GECICI, 4xx in gerisi KALICI -- status ALANINDAN', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const c = await client(httpError(status, 'x'))
      expect(isTransient(await c.fail()), `${status}`).toBe(true)
    }
    for (const status of [400, 401, 403, 404, 451]) {
      const c = await client(httpError(status, 'x'))
      expect(isTransient(await c.fail()), `${status}`).toBe(false)
    }
  })

  it('baglanti kurulamamasi GECICIDIR', async () => {
    // 1 numarali porta kimse baglanamaz; viem "fetch failed" der.
    const error = await make('http://127.0.0.1:1/').fail()
    expect(isTransient(error)).toBe(true)
  })

  /**
   * 200 donen ama JSON OLMAYAN bir govde (araya giren bir proxy) KALICI
   * kalir. Arc'ta GOZLEMLENMEDI, o yuzden gecici saymak bir TAHMIN olurdu ve
   * bu dosyanin varsayilani "olculmeyen = kalici"dir. Burada yaziliyor ki
   * yoklugu gozden kacma olarak okunmasin.
   */
  it('JSON olmayan 200 govdesi KALICIDIR (Arc ta gozlemlenmedi)', async () => {
    const c = await client((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('not json at all')
    })
    expect(isTransient(await c.fail())).toBe(false)
  })

  it('HALT sinifi ad, her seyin onunde gelir', async () => {
    const c = await client(jsonRpcError(-32011, 'request limit reached'))
    const error = Object.assign((await c.fail()) as Error, { name: 'ReorgDetected' })
    expect(isTransient(error)).toBe(false)
  })
})

/**
 * HALT SINIFININ KAPISI -- ADLAR KAYNAKTAN OKUNUR, ELLE YAZILMAZ.
 *
 * Ucu (`UnorderedLogs`, `SingleBlockTooLarge`, `SplitDepthExceeded`) `PERMANENT`
 * kumesinde YOKTU ve yine de "kalici" cikiyorlardi -- ad kontroluyle degil,
 * `isTransient`'in BES metin sezgisinin hepsinden dusrek. O sebep yazili
 * degildi ve GERCEKTEN COKUYOR: son sezgi `\b(408|425|429|502|503|504)\b`, ve
 * hatanin KENDI metni blok numarasini tasiyor. Asagidaki iki test bunu
 * OLCUYOR: ayni rakam, adi kumede olan bir sinifta KALICI, olmayan bir sinifta
 * GECICI kaliyordu.
 *
 * Elle yazilmis bir ad listesi bu kusuru bir kez kapatir; kapiyi KAYNAKTAN
 * turetmek YARIN eklenecek sinifi da kapatir. `ordering.test.ts`in kaynak
 * tarayan kapisiyla ayni sekil, ayni gerekce.
 */
describe('HALT sinifi -- kaynaktan turetilen kapi', () => {
  const SOURCES = [
    '../src/logs.ts',
    '../src/run.ts',
    '../src/admit.ts',
    '../src/verify.ts',
    '../src/apply/trade.ts',
    '../../packages/db/src/reorg.ts',
  ]

  /** Her `this.name = 'X'` atamasi bir hata sinifinin CALISMA ZAMANI adidir. */
  function declaredNames(): string[] {
    const out = new Set<string>()
    for (const rel of SOURCES) {
      const text = readFileSync(new URL(rel, import.meta.url), 'utf8')
      for (const m of text.matchAll(/this\.name = '([A-Za-z]+)'/g)) out.add(m[1] as string)
    }
    return [...out].sort()
  }

  /**
   * KUMELER KAYNAKTAN OKUNUR, TESTE ELLE YAZILMAZ. Elle yazilan bir kopya,
   * `run.ts`teki kume degisince SESSIZCE ayrisirdi -- yani kapi kendi
   * girdisini uydururdu.
   */
  function declaredSet(constName: string): string[] {
    const text = readFileSync(new URL('../src/run.ts', import.meta.url), 'utf8')
    const m = new RegExp(`const ${constName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(text)
    if (m?.[1] === undefined) throw new Error(`${constName} kaynakta bulunamadi`)
    return [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1] as string).sort()
  }

  it('kapinin girdisi BOS DEGIL -- ve bugun on dort sinif var', () => {
    const names = declaredNames()
    expect(names.length).toBeGreaterThanOrEqual(14)
    // Ucu eksikti; adlariyla anilmalari kapinin neyi kapattigini yaziyor.
    expect(names).toContain('UnorderedLogs')
    expect(names).toContain('SingleBlockTooLarge')
    expect(names).toContain('SplitDepthExceeded')
    // Dorduncusu kapiyi DEGISTIRDI: adi olan ama KALICI OLMAYAN ilk sinif.
    expect(names).toContain('BlockUnavailable')
  })

  /**
   * KAPI: TANIMLANAN HER AD, IKI KUMEDEN TAM OLARAK BIRINDE.
   *
   * Onceki hali "her ad `PERMANENT`te" idi ve bu bir SAYIMDI, bir kural degil:
   * o gune kadar yazilmis her sinifin kalici olmasi dogruydu. Kapinin gercek
   * isi "kimse siniflandirma kararini atlayamaz"; bugun ayni isi iki degerli
   * bir kararla yapiyor. `BlockUnavailable` (bos blok yaniti) GECICIDIR ve
   * kapiyi yumusatmadan gecmesinin tek yolu buydu.
   */
  it('TANIMLANAN HER hata sinifi TAM OLARAK BIR kumede siniflandirilmis', () => {
    const permanent = new Set(declaredSet('PERMANENT'))
    const retryable = new Set(declaredSet('RETRYABLE'))
    // Iki kume de DOLU olmali: bos bir `RETRYABLE`, kapinin "iki degerli"
    // oldugu iddiasini vakum yapardi.
    expect(permanent.size).toBeGreaterThan(0)
    expect(retryable.size).toBeGreaterThan(0)
    for (const name of declaredNames()) {
      const memberships = Number(permanent.has(name)) + Number(retryable.has(name))
      // 0 = siniflandirilmamis (metin sezgilerine duser), 2 = celiskili.
      expect(
        memberships,
        `${name}: ${memberships === 0 ? 'siniflandirilmamis' : 'IKI kumede'}`,
      ).toBe(1)
    }
  })

  it('KALICI kumedeki her ad, HIZ SINIRI govdesine ragmen kalicidir', async () => {
    const c = await client(jsonRpcError(-32011, 'request limit reached'))
    const base = (await c.fail()) as Error
    for (const name of declaredSet('PERMANENT')) {
      // Govde bir HIZ SINIRI -- yani ad kontrolu olmasaydi GECICI cikardi.
      // Testin ayirt edici olmasi tam olarak buradan geliyor.
      const error = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base, {
        name,
      }) as Error
      expect(isTransient(error), name).toBe(false)
    }
  })

  /**
   * TERS YON, VE AYNI OLCUDE AYIRT EDICI OLMAK ZORUNDA. Hiz siniri govdesi
   * kullanmak burada HICBIR SEY olcmezdi (govde zaten gecici). Govde
   * `-32601`dir: KALICI bir kod. Yani gecen tek sey ADIN kendisi.
   */
  it('GECICI kumedeki her ad, KALICI bir govdeye ragmen gecicidir', async () => {
    const c = await client(jsonRpcError(-32601, 'method not supported'))
    const base = (await c.fail()) as Error
    for (const name of declaredSet('RETRYABLE')) {
      const bare = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base, {
        name,
      }) as Error
      expect(isTransient(bare), name).toBe(true)
      // NEGATIF KONTROL: adi dusurulen AYNI nesne KALICI olur.
      expect(isTransient(Object.assign(bare, { name: 'Bilinmeyen' })), name).toBe(false)
    }
  })

  /**
   * NEGATIF KONTROL: kapinin kapattigi ariza GERCEK. Blok 429 ile kurulmus bir
   * `SingleBlockTooLarge`, adi kumeden dusurulurse GECICI cikar.
   */
  it('NEGATIF KONTROL: 429 numarali blok, ad kumede yoksa GECICI olur', () => {
    const halt = new SingleBlockTooLarge(429n)
    expect(halt.message).toMatch(/\b429\b/)
    // Bugun: adi kumede, yani kalici.
    expect(isTransient(halt)).toBe(false)
    // Ad dusurulunce ayni nesne gecici olur -- metin sezgisi onu yakaliyor.
    expect(isTransient(Object.assign(new SingleBlockTooLarge(429n), { name: 'Bilinmeyen' }))).toBe(
      true,
    )
  })
})

/**
 * Hiz sinirina yakalanmamak, hatayi dogru siniflandirmakla ayni sorunun oteki
 * yarisi: varsayilan bosluk 0 iken uretim istekleri arka arkaya atiyordu ve
 * 250ms'lik bir bosluk bile OLCULMUS olarak `-32011` uretiyor.
 */
describe('loadConfig -- pacing varsayilani', () => {
  const ENV = {
    ARC_FACTORY_ADDRESS: '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439',
    ARC_START_BLOCK: '54661437',
    ARC_RPC_URL: 'https://rpc.testnet.arc.network',
    DATABASE_URL: 'postgres://x@127.0.0.1:1/x',
  } as NodeJS.ProcessEnv

  it('varsayilan bosluk SIFIR DEGILDIR ve olculen 250ms nin USTUNDEDIR', () => {
    const config = loadConfig({ ...ENV })
    expect(config.minRequestIntervalMs).toBeGreaterThan(250)
  })

  it('operator onu env ile degistirebilir', () => {
    expect(
      loadConfig({ ...ENV, INDEXER_MIN_REQUEST_INTERVAL_MS: '900' }).minRequestIntervalMs,
    ).toBe(900)
  })
})
