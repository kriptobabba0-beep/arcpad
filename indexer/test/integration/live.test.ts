import { beforeAll, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { decodeAbiParameters, encodeFunctionData } from 'viem'
import type { Pool } from '@arcpad/db'
import { createPool, getCursor, runMigrations, snapshot } from '@arcpad/db'
import { getIndexerStatus, getTokenOverview, listTrades } from '@arcpad/db'
import { deriveTokenAddress } from '../../src/admit'
import { isForbiddenEmitter, TOPIC0 } from '../../src/arc'
import type { IndexerConfig } from '../../src/config'
import type { LaunchedEvent, RawLog, RpcClient } from '../../src/logs'
import { createPacer, decodeAll } from '../../src/logs'
import { ensureDeployment, isTransient, readFactoryProfile, runOnce } from '../../src/run'

/**
 * CANLI ARC TESTNET ENTEGRASYON TESTI.
 *
 * Bu depodaki her ciddi kusur CALISTIRILARAK bulundu, ve fixture'lar gercek
 * yurutmeden gelse bile `anvil` Arc'i SIMULE EDEMEZ: EIP-7708 loglari, native
 * USDC davranisi ve hiz siniri yalnizca gercek RPC'de gorunur. Bu dosyanin ilk
 * kosusu tam olarak bunu ispatladi -- IKI GERCEK KUSUR buldu:
 *
 *   1. Arc'in hiz siniri `{"code":-32011,"message":"request limit reached"}`
 *      dondururyor ve `isTransient` onu KALICI sayiyordu: indexer bir hiz
 *      sinirinda HALT ediyordu. (250ms araliklarla alti cagrinin ikisi.)
 *   2. Test fixture'indaki `protocolTreasury` YANLISTI (creator'in adresi
 *      yazilmisti); hicbir birim testi bunu goremezdi cunku hicbiri zincire
 *      sormuyordu.
 *
 * SENARYO NOTU: plan burada YENI islemler gondermeyi (launch/buy/sell/claim,
 * sifreli keystore ile) tarif ediyor. Bu kosu onun yerine ZATEN ZINCIRDE OLAN
 * smoke dagitimini indeksliyor ve sonucu zincirin KENDI cevaplariyla
 * karsilastiriyor. Kanit degeri ayni yerden gelir -- veriyi biz uretmedik --
 * ve testi tekrarlanabilir kilar: gonderen bir test her kosuda yeni USDC
 * harcar ve zincir durumunu buyutur.
 *
 * ATLAMAZ, COKER: `ARC_RPC_URL` / `ARC_FACTORY_ADDRESS` / `DATABASE_URL`
 * yoksa bu dosya patlar. Sessizce atlanan bir entegrasyon testi, Faz 0'in
 * `continue-on-error` dersinin aynisidir.
 */

const RPC_URL = process.env['ARC_RPC_URL']
const DATABASE_URL = process.env['DATABASE_URL']
const FACTORY = (process.env['ARC_FACTORY_ADDRESS'] ??
  '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439') as Address

if (!RPC_URL) {
  throw new Error(
    'canli entegrasyon testi ARC_RPC_URL ister. ATLANMAZ: atlayan bir entegrasyon testi yesil gorunur.',
  )
}
if (!DATABASE_URL) {
  throw new Error('canli entegrasyon testi DATABASE_URL ister (gercek Postgres).')
}

/** Olculmus baslangic: factory'nin deploy blogu. */
const START_BLOCK = 54_661_437n
/** Smoke islemlerinin son blogu (0x34219f9) -- aralik burada kapanir. */
const SMOKE_LAST = 54_663_673n

const EXPECTED = {
  token: '0x1bd93613a7bc470a739d9615cdc65e535d958fab' as Address,
  curve: '0x7938be340a14a12f94a83aea246d9d2566324c9c' as Address,
  escrow: '0xeed4431ead3e27f16d97f677a9c4c1a963df8dc6' as Address,
  protocolTreasury: '0xebbecfda308ea307e173c6ec19a9c48f53d4b10c' as Address,
  creator: '0xe92c64c4f36216ea773f2622f6d5f8530ae92fd2' as Address,
  chainId: 5_042_002n,
}

/**
 * PACING ZORUNLU. Arc es zamanli VE ardisik istekleri sinirlar; olculdu
 * (2026-08-02): 250ms araliklarla alti `eth_call`in ikisi -32011 dondu.
 * Burada 400ms + hiz siniri gorulunce ustel geri cekilme kullaniliyor, ve
 * `isTransient` ayni kodu URETIM yolunda da gecici sayiyor.
 */
const MIN_INTERVAL_MS = 600
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let requestCount = 0

/**
 * ZAMAN ASIMI ZORUNLU. Ilk kosu `beforeAll`da 300 saniyede TIMEOUT oldu ve
 * sebebi olculdu: `fetch`in varsayilan zaman asimi YOKTUR, ve Arc'in RPC'si
 * yuk altinda baglantiyi sifirliyor (`ECONNRESET`, olculdu) ya da yaniti
 * geciktiriyor. Zaman asimi olmadan tek bir asili istek butun kosuyu
 * bloklar -- ve bu, URETIM dongusu icin de gecerli bir risktir (backlog'a
 * yazildi).
 */
const REQUEST_TIMEOUT_MS = 15_000

const liveClient: RpcClient = {
  async request({ method, params }) {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt += 1) {
      requestCount += 1
      const started = Date.now()
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: requestCount, method, params }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const json = (await response.json()) as {
          result?: unknown
          error?: { code: number; message: string }
        }
        if (json.error === undefined) {
          if (process.env['LIVE_TRACE'] === '1') {
            console.log(`[rpc] ${method} ${Date.now() - started}ms`)
          }
          return json.result
        }
        lastError = Object.assign(new Error(json.error.message), { code: json.error.code })
      } catch (error) {
        lastError = error
      }
      // URETIM POLITIKASININ AYNISI: gecici hata -> bekle -> tekrar dene.
      if (!isTransient(lastError)) throw lastError
      await sleep(500 * 2 ** attempt)
    }
    throw lastError
  },
}

const pacer = createPacer({ minIntervalMs: MIN_INTERVAL_MS })

/**
 * TEST TARAFININ KENDI CAGRILARI. Indexer fonksiyonlarina `liveClient` HAM
 * gecilir ve `pacer` AYRICA verilir -- onlar cagriyi kendileri havuzdan
 * gecirir.
 *
 * OLCULMUS TUZAK: ilk hali istemciyi `pacer.run(...)` ile sarmalayip AYNI
 * pacer'i indexer'a da veriyordu. `concurrency: 1` oldugu icin dis `run` tek
 * slotu tutarken ic `run` ayni slotu bekliyordu -- KILITLENME. Hata vermez,
 * yalnizca ASILIR; `beforeAll` iki kez 300 saniyede timeout oldu ve sebep
 * ancak vitest'in disinda, tsx ile kosturulunca gorundu. Uretim yolu ayni
 * tuzaga acik degil (`index.ts` ham istemciyi verir) ama tuzak GERCEK ve
 * rapora yazildi.
 */
const paced: RpcClient = {
  request: (args) => pacer.run(() => liveClient.request(args)),
}

const CONFIG: IndexerConfig = {
  rpcUrl: RPC_URL,
  databaseUrl: DATABASE_URL,
  factory: FACTORY,
  startBlock: START_BLOCK,
  // Smoke bloklari `startBlock`tan ~2.240 blok sonra; tek turda kapsanmalari
  // icin 10.000 (RPC'nin olculmus aralik siniri).
  maxSpan: 10_000n,
  pollMs: 500,
  volumeRefreshBatch: 100,
  maxAttempts: 5,
  rateLimitMaxAttempts: 5,
  minRequestIntervalMs: MIN_INTERVAL_MS,
}

let pool: Pool
let deployment: Awaited<ReturnType<typeof readFactoryProfile>>
let firstDump: Record<string, unknown[]>

async function ethCallRaw(to: Address, data: Hex): Promise<Hex> {
  return (await paced.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as Hex
}

async function readUint(to: Address, signature: string): Promise<bigint> {
  return BigInt(await ethCallRaw(to, encodeFunctionData({ abi: minimalAbi(signature), args: [] })))
}

function minimalAbi(signature: string): readonly [Record<string, unknown>] {
  const name = signature.slice(0, signature.indexOf('('))
  return [
    { type: 'function', name, inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  ] as never
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

describe('canli Arc testnet', () => {
  beforeAll(async () => {
    pool = createPool(DATABASE_URL)
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await runMigrations(pool)

    // (0) PROFIL ZINCIRDEN. Bes `eth_call`.
    deployment = await readFactoryProfile(liveClient, FACTORY, EXPECTED.chainId, START_BLOCK, pacer)
    await ensureDeployment(pool, deployment)

    // Butun smoke araligi TEK turda: head'i smoke'un son blogunda sabitliyoruz
    // ki test zincirin bugunku basina kadar tarayip binlerce bos blok
    // okumasin.
    const result = await runOnce(pool, liveClient, deployment, CONFIG, {
      pacer,
      head: async () => SMOKE_LAST,
    })
    expect(result).not.toBeNull()
    firstDump = await snapshot(pool)
  }, 300_000)

  it('zincirden okunan profil TESTNET profilidir', () => {
    expect(deployment.virtualTokenReservesTok).toBe(1_073_000_000n * 10n ** 18n)
    // V = 4292e15. Uretim profili bunun TAM 1000 KATIDIR ve tek fark budur.
    expect(deployment.virtualQuoteReservesWei).toBe(4_292n * 10n ** 15n)
    expect(deployment.saleSupplyTok).toBe(793_100_000n * 10n ** 18n)
    expect(deployment.escrow).toBe(EXPECTED.escrow)
    expect(deployment.protocolTreasury).toBe(EXPECTED.protocolTreasury)
  })

  it('canli launch indekslendi', async () => {
    expect(await count('launches')).toBe(1)
    const { rows } = await pool.query<{ token: string; curve: string; symbol: string }>(
      'SELECT token, curve, symbol FROM launches',
    )
    expect(rows[0]).toMatchObject({
      token: EXPECTED.token,
      curve: EXPECTED.curve,
      symbol: 'SMOKE',
    })
    // Zincirin kendi sayaci da bir tane diyor.
    expect(await readUint(FACTORY, 'launchCount()')).toBe(1n)
  })

  /**
   * (1) EIP-7708 -- BU IDDIA FIXTURE'LARDA YAZILAMAZ.
   *
   * Foundry 7708 logu uretmez; dokum yalnizca canli bir makbuzda gorunur.
   */
  it('bir alim isleminde token Transfer i DISINDA holders a hicbir sey girmez', async () => {
    const { rows } = await pool.query<{ tx_hash: string }>(
      'SELECT tx_hash FROM trades ORDER BY event_seq LIMIT 1',
    )
    const receipt = (await paced.request({
      method: 'eth_getTransactionReceipt',
      params: [rows[0]!.tx_hash],
    })) as { logs: RawLog[] }

    const transfers = receipt.logs.filter((l) => l.topics[0] === TOPIC0.transfer)
    const byEmitter = new Map<string, number>()
    for (const log of transfers) {
      const key = log.address.toLowerCase()
      byEmitter.set(key, (byEmitter.get(key) ?? 0) + 1)
    }

    // OLCULEN DOKUM (rapora yazilir):
    const system = byEmitter.get('0xfffffffffffffffffffffffffffffffffffffffe') ?? 0
    const real = byEmitter.get(EXPECTED.token) ?? 0
    const erc20 = byEmitter.get('0x3600000000000000000000000000000000000000')
    console.log(
      `[live] alim tx ${rows[0]!.tx_hash}: Transfer loglari -> ` +
        `7708 sistem=${system}, LaunchToken=${real}, USDC ERC-20=${erc20 ?? 0}`,
    )
    // Native hareketler: alici->curve, curve->escrow (x1-2), curve->alici iade.
    expect(system).toBeGreaterThanOrEqual(2)
    // TEK gercek token `Transfer`'i.
    expect(real).toBe(1)
    // ERC-20 giris noktasi kullanilmadi.
    expect(erc20).toBeUndefined()

    // VE INDEXER YALNIZCA TOKEN TRANSFER'LERINI GORDU: bes smoke islemi,
    // bes `LaunchToken` hareketi (mint + uc alim + bir satis).
    expect(await count('token_transfers')).toBe(5)
    const { rows: emitters } = await pool.query<{ token: string }>(
      'SELECT DISTINCT token FROM token_transfers',
    )
    expect(emitters.map((e) => e.token)).toEqual([EXPECTED.token])
    for (const row of emitters) expect(isForbiddenEmitter(row.token)).toBe(false)
  })

  /**
   * (2) YEREL TURETME ZINCIRIN CEVABIYLA UYUSUR.
   *
   * Sicak yol `isCanonical` CAGIRMAZ (gaz sinirsiz bir griefing yuzeyidir);
   * bu testin isi o kararin dogru oldugunu KANITLAMAK.
   */
  it('deriveTokenAddress ile isCanonical ayni cevabi verir', async () => {
    const launched = await launchedEvent()
    const derived = deriveTokenAddress({
      factory: FACTORY,
      salt: launched.salt,
      nameHex: launched.nameHex,
      symbolHex: launched.symbolHex,
      uriHex: launched.uriHex,
      creator: launched.creator,
      curve: launched.curve,
    })
    expect(derived).toBe(EXPECTED.token)

    const isCanonical = async (token: Address): Promise<boolean> =>
      BigInt(
        await ethCallRaw(
          FACTORY,
          `0xb754bdfa${'0'.repeat(24)}${token.slice(2).toLowerCase()}` as Hex,
        ),
      ) === 1n

    expect(await isCanonical(EXPECTED.token)).toBe(true)
    // Ve zincir de, yerel turetme de sahte bir token'i REDDEDER.
    const bogus = '0x000000000000000000000000000000000000dead' as Address
    expect(await isCanonical(bogus)).toBe(false)
    expect(derived).not.toBe(bogus)
  })

  /**
   * (3) `predictAddresses` PARITESI. Factory'nin kendi onizlemesi ile bizim
   * turetmemiz AYNI CREATE2'yi kullanir; ayrismalari creationCode kaymasi
   * demektir -- ve o gun indexer HER launch'i reddederdi.
   */
  it('predictAddresses launch oncesi ayni adresi verir', async () => {
    const launched = await launchedEvent()
    const data = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'predictAddresses',
          stateMutability: 'view',
          inputs: [
            { name: 'creator', type: 'address' },
            { name: 'name', type: 'string' },
            { name: 'symbol', type: 'string' },
            { name: 'uri', type: 'string' },
            { name: 'nonce', type: 'uint256' },
          ],
          outputs: [
            { name: 'token', type: 'address' },
            { name: 'curve', type: 'address' },
          ],
        },
      ],
      functionName: 'predictAddresses',
      // Smoke ILK launch'ti, yani nonce 0.
      args: [launched.creator, launched.name, launched.symbol, launched.uri, 0n],
    })
    const [token, curve] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }],
      await ethCallRaw(FACTORY, data),
    )
    expect((token as string).toLowerCase()).toBe(EXPECTED.token)
    expect((curve as string).toLowerCase()).toBe(EXPECTED.curve)
  })

  /**
   * (4) ESCROW ODEME GUCU. Dogru invariant `totalOwed <= balance`, `==` DEGIL:
   * escrow'a dogrudan gonderilen USDC TALEP EDILEMEZ (kontratin kisit 1'i).
   */
  it('claimable toplami escrow bakiyesini ASMAZ ve kontratin defteriyle ORTUSUR', async () => {
    const { rows } = await pool.query<{ s: string }>(
      'SELECT COALESCE(sum(claimable_wei),0)::text AS s FROM fee_balances',
    )
    const ledger = BigInt(rows[0]!.s)
    const balance = BigInt(
      (await paced.request({
        method: 'eth_getBalance',
        params: [EXPECTED.escrow, 'latest'],
      })) as Hex,
    )
    const totalOwed = await readUint(EXPECTED.escrow, 'totalOwed()')

    expect(ledger).toBe(152_069_146_725_900_635n)
    expect(ledger).toBe(totalOwed)
    expect(ledger).toBeLessThanOrEqual(balance)
    console.log(`[live] defter=${ledger} totalOwed=${totalOwed} bakiye=${balance}`)
  })

  /**
   * (5) REZERV PARITESI. `curve_state` YALNIZCA olaylardan kuruldu; zincire
   * hic sorulmadi. Simdi soruluyor.
   */
  it('curve_state zincirin dort rezerviyle birebir ayni', async () => {
    const { rows } = await pool.query<Record<string, string | boolean>>(
      'SELECT * FROM curve_state WHERE curve = $1',
      [EXPECTED.curve],
    )
    const state = rows[0]!
    const pairs: [string, string][] = [
      ['virtual_token_reserves_tok', 'virtualTokenReserves()'],
      ['virtual_quote_reserves_wei', 'virtualQuoteReserves()'],
      ['real_token_reserves_tok', 'realTokenReserves()'],
      ['real_quote_reserves_wei', 'realQuoteReserves()'],
    ]
    for (const [column, signature] of pairs) {
      const onChain = await readUint(EXPECTED.curve, signature)
      expect(BigInt(state[column] as string), column).toBe(onChain)
    }
    expect(state['complete']).toBe(true)
    expect(BigInt(state['pool_seed_supply_tok'] as string)).toBe(
      await readUint(EXPECTED.curve, 'poolSeedSupply()'),
    )
  })

  /**
   * (6) TIMESTAMP TEKRARI CANLIDA. Sira `event_seq`i izler; esit zamanlar
   * onu BOZMAZ.
   */
  it('siralama event_seq i izler, block_time i degil', async () => {
    const trades = await listTrades(pool, EXPECTED.token, { limit: 100 })
    expect(trades.length).toBe(4)
    const seqs = trades.map((t) => t.eventSeq)
    expect(seqs).toEqual([...seqs].sort((a, b) => (a > b ? -1 : 1)))
    const ties = trades.filter(
      (t, i) => i > 0 && t.blockTime.getTime() === trades[i - 1]!.blockTime.getTime(),
    )
    console.log(
      `[live] ${trades.length} ticaretin ${ties.length} tanesi bir onceki ile AYNI zamanda`,
    )
  })

  it('okuma modeli canli rezervlerden turetiyor ve tazeligini soyluyor', async () => {
    const { rows, indexer } = await getTokenOverview(pool, EXPECTED.token)
    expect(rows).not.toBeNull()
    expect(rows!.complete).toBe(true)
    // Curve tukendi: ilerleme tam 1.000.000.
    expect(rows!.progressPpm).toBe(1_000_000)
    expect(rows!.graduationRaiseWei).toBe(12_161_433_369_060_378_706n)
    // Toplanan quote, raise'i SEKIZ wei asiyor -- `floor()+1` her alimda.
    expect(rows!.realQuoteReservesWei - rows!.graduationRaiseWei).toBe(8n)
    // TAZE, cunku bu kosunun BASI `SMOKE_LAST`e sabitlendi ve imlec tam oraya
    // ulasti -- yani `blocksBehind` SIFIR. Bu bir ayrinti degil: gercek basla
    // kosulan ayni indexer 767.504 blok geride kalir ve o durumda TAZE DEGILDIR
    // (bkz. asagidaki iddia ve `packages/db`nin "canli ama geride" testi).
    expect(indexer.stale).toBe(false)
    if (indexer.stale) throw new Error('unreachable')
    expect(indexer.at.lastBlock).toBe(SMOKE_LAST)
    expect(indexer.at.head.blocksBehind).toBe(0n)

    // AYNI SATIR, GERCEK ZINCIR BASIYLA: veri saniyeler once yazildi ve yine de
    // BAYAT. Bu, B2-a'nin canli kanitidir ve kurgu bir bayrakla degil, zincirin
    // o andaki basiyla kuruluyor.
    const head = await liveClient.request({
      method: 'eth_blockNumber',
      params: [],
    })
    // GOZLEM DAMGASI DA TAZELENIR. Yalnizca `head_block`i itmek, artik
    // `head-stale` uretirdi -- ve o da DOGRU olurdu, ama olcmek istedigimiz
    // sey bu degil: burada iddia edilen, TAZE bir gozlemin BUYUK bir gecikme
    // gostermesi. Iki sutunu birlikte yazmak, uretimdeki `setCursor`/`noteHead`
    // ciftinin ta kendisidir.
    await pool.query(
      'UPDATE sync_state SET head_block = $1, head_observed_at = now(), updated_at = now()',
      [BigInt(head as string).toString()],
    )
    const behind = await getIndexerStatus(pool)
    expect(behind.stale).toBe(true)
    if (!behind.stale) throw new Error('unreachable')
    expect(behind.why).toBe('behind-head')
    expect(behind.at?.stalenessSeconds).toBeLessThan(30)
    const lag = behind.at?.head.measured === true ? behind.at.head.blocksBehind : null
    expect(lag).toBeGreaterThan(700_000n)
    await pool.query('UPDATE sync_state SET head_block = $1, head_observed_at = now()', [
      SMOKE_LAST.toString(),
    ])
  })

  /** (7) IKINCI KOSU IDEMPOTENT -- GERCEK zincir verisiyle. */
  it('imleci geri alip yeniden kosturmak ayni veritabanini verir', async () => {
    await pool.query('UPDATE sync_state SET last_block = $1, last_block_hash = $2', [
      (START_BLOCK - 1n).toString(),
      `0x${(START_BLOCK - 1n).toString(16).padStart(64, '0')}`,
    ])
    // Zincir bagi muhafizi gercek `parentHash`i isteyecek; imlec hash'ini de
    // gercegiyle degistiriyoruz.
    const parent = (await paced.request({
      method: 'eth_getBlockByNumber',
      params: [`0x${START_BLOCK.toString(16)}`, false],
    })) as { parentHash: Hex }
    await pool.query('UPDATE sync_state SET last_block_hash = $1', [parent.parentHash])

    await runOnce(pool, liveClient, deployment, CONFIG, { pacer, head: async () => SMOKE_LAST })

    const second = await snapshot(pool)
    expect(stripClocks(second)).toEqual(stripClocks(firstDump))
    expect((await getCursor(pool))?.lastBlock).toBe(SMOKE_LAST)
  }, 300_000)
})

async function launchedEvent(): Promise<LaunchedEvent> {
  const { rows } = await pool.query<{ tx_hash: string }>('SELECT tx_hash FROM launches')
  const receipt = (await paced.request({
    method: 'eth_getTransactionReceipt',
    params: [rows[0]!.tx_hash],
  })) as { logs: RawLog[] }
  const log = receipt.logs.find((l) => l.topics[0] === TOPIC0.launched)
  if (log === undefined) throw new Error('canli makbuzda Launched yok')
  const block = BigInt(log.blockNumber)
  const [event] = await decodeAll(liveClient, [log], block, block, pacer)
  if (event?.kind !== 'launched') throw new Error('Launched cozulemedi')
  return event
}

/** Duvar saati tasiyan alanlar; iki kosu arasinda esit OLAMAZLAR. */
function stripClocks(dump: Record<string, unknown[]>): Record<string, unknown[]> {
  const clocks: Record<string, readonly string[]> = {
    sync_state: ['updated_at'],
    // `volume_24h_wei` SEMANIN TEK `now()` BAGIMLI DEGERIDIR: 24 saatlik bir
    // PENCERE toplamidir ve iki kosu arasindaki saniyelerde bile pencere kenari
    // gecilebilir. Canli smoke tam olarak ~24 saat oncesine dustugu icin bu
    // testte GERCEKTEN gecildi (bir kosuda dolu, sonrakinde sifir). Deger
    // karsilastirmadan cikariliyor; DAVRANISI ayrica ve DETERMINISTIK olarak
    // olculuyor (`run.test.ts`, "pencere DISINDAKI ticaretler sayilmaz").
    token_stats: ['volume_24h_refreshed_at', 'volume_24h_wei'],
    schema_migrations: ['applied_at'],
    schema_state: ['updated_at'],
  }
  const out: Record<string, unknown[]> = {}
  for (const [table, rows] of Object.entries(dump)) {
    const columns = clocks[table]
    out[table] =
      columns === undefined
        ? rows
        : rows.map((row) => {
            const copy = { ...(row as Record<string, unknown>) }
            for (const column of columns) delete copy[column]
            return copy
          })
  }
  return out
}
