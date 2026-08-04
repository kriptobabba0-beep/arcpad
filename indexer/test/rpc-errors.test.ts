import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPublicClient, http } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { asRpcError } from '../src/logs'
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
    const measured: [number, string][] = [
      [-32601, 'method not supported'],
      [-32602, 'Invalid params'],
      [-32012, 'requested range too large'],
      [3, 'execution reverted'],
    ]
    for (const [code, message] of measured) {
      const c = await client(jsonRpcError(code, message), '/rpc.testnet.arc.network')
      expect(isTransient(await c.fail()), `${code} ${message}`).toBe(false)
    }
  })

  it('-32011 (Arc in hiz siniri) GECICIDIR', async () => {
    const c = await client(jsonRpcError(-32011, 'request limit reached'))
    expect(isTransient(await c.fail())).toBe(true)
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
