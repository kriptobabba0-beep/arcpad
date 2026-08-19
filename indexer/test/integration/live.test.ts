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
import {
  assertStartBlockCoversEscrow,
  ensureDeployment,
  isTransient,
  readFactoryProfile,
  runOnce,
} from '../../src/run'

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
/**
 * ============ TEK UC YETMEDI, VE BU OLCULDU ============
 *
 * OLCULDU (18 Agustos 2026, ilk zamanlanmis kosu): butun suit `Error: rate
 * limit exceeded` ile dustu -- dokuz test. Sebep tek bir uca bagli olmasiydi:
 * `liveClient` dort kez DENIYORDU ama hep AYNI uca, ve o uc gunun o saatinde
 * oran sinirindaydi. Uretim tarafi bunu coktan cozmustu (`arcRpcUrls` +
 * yedekler); yalnizca bu dosya cozmemisti.
 *
 * YEDEKLER SECILEREK VERILIR, HEPSI DEGIL. Ayni gun blockdaemon'in log
 * sorgularina HATASIZ BOS DIZI dondurdugu olculdu; boyle bir uc bir TESTTE
 * felakettir, cunku "olay yok" cevabi yesil bir iddiaya donusur. Yalanci uc
 * uretimin yedek zincirinden de cikarildi.
 */
const RPC_URLS: readonly string[] = [
  ...(RPC_URL === undefined ? [] : [RPC_URL]),
  ...(process.env['ARC_RPC_FALLBACK_URLS'] ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u !== ''),
].filter((u, i, all) => all.indexOf(u) === i)
const DATABASE_URL = process.env['DATABASE_URL']
/**
 * VARSAYILAN, DEFTERIN BUGUNKU `launchFactory`I. CI onu zaten `pnpm
 * addressbook --env-only` ile gecirir; buradaki literal yalnizca elle kosum
 * icin var ve defterle AYNI olmak zorunda.
 *
 * ONCEKI VARSAYILAN FAZ 1'IN FACTORY'SIYDI ve Faz 2'den sonra bu dosyayi
 * ZATEN KIRMISTI: CI'in gecirdigi Faz 2 adresiyle `launches` sayisi 0 cikar
 * (`toBe(1)` duser) ve `ledger === totalOwed` iddiasi da duser, cunku
 * `totalOwed()` artik 321214784333543529.
 */
const FACTORY = (process.env['ARC_FACTORY_ADDRESS'] ??
  '0x5ca156f1809ab784655410d0f4b0704d2b306b47') as Address

if (!RPC_URL) {
  throw new Error(
    'canli entegrasyon testi ARC_RPC_URL ister. ATLANMAZ: atlayan bir entegrasyon testi yesil gorunur.',
  )
}
if (!DATABASE_URL) {
  throw new Error('canli entegrasyon testi DATABASE_URL ister (gercek Postgres).')
}

/**
 * ================= IKI PENCERE, VE NEDEN IKI TANE =================
 *
 * Defterin `startBlock`u `min(feeEscrowBlock, launchFactoryBlock)` = ESCROW'un
 * blogudur, factory'ninki degil -- ve Faz 2'den sonra bu bir ihtiyat degil
 * ZORUNLULUKTUR: escrow DEVRALINDI, yani `[54661437, 55870260)` araliginda
 * -- CANLI factory henuz YOKKEN -- gercek `Deposited`lar var ve onlar Faz
 * 2'nin de odedigi AYNI IKI alici slotuna giriyor.
 *
 * OLCULDU (2026-08-09, bu RPC, escrow adresine 135 `eth_getLogs`):
 *
 *   [54661437, 55870260]  8 Deposited, 152069146725900635  (Faz 1 curve'u)
 *   [55870261, 56010150]  8 Deposited, 169145637607642894  (Faz 2 curve'u)
 *   TOPLAM 321214784333543529 = `totalOwed()` = escrow'un bakiyesi
 *
 * Ve o 1,21M blogun ICINDE baska HICBIR SEY yok: sekiz olayin hepsi
 * 54663522-54663673 arasinda, factory'nin ise 55870260'ta KODU YOK (olculdu:
 * 0 bayt; 55870261'de 14008). Izleme kumesindeki `curves`/`tokens` de Faz
 * 2'nin launch'ina kadar bostur.
 *
 * BU YUZDEN TEST IKI PENCERE KOSUYOR VE ARADAKI BOSLUGU ATLIYOR: atlanan
 * araligin BOS oldugu OLCULDU, yani atlamak hicbir iddiayi zayiflatmiyor --
 * yalnizca 1,21M blogun bos oldugunu ispatlamak icin harcanacak ~35 dakikayi
 * harcamiyor. Atlama, imleci gercek `parentHash`iyle ilerleterek yapilir;
 * zincir bagi muhafizi devrede kalir.
 */
const START_BLOCK = 54_661_437n
/** Faz 1 curve'unun SON escrow olayinin blogu. Birinci pencere burada kapanir. */
const ESCROW_PREFIX_LAST = 54_663_673n
/*
 * IKINCI PENCERE SMOKE'UN ETRAFIDIR, FABRIKANIN DEGIL -- VE BU DEGISIM OLCULDU.
 *
 * Eski hal `FACTORY_BLOCK = 55_870_261n` idi ve adi da yorumu da "factory'nin
 * yaratildigi blok" diyordu. Fabrika yeniden deploy edilince defter
 * `launchFactoryBlock: 57_179_323`e gecti, bu satir gecmedi, ve suit BASKA bir
 * fabrikanin blogunu tarayip hicbir launch bulamadi: dokuz test `expected +0
 * to be 1` ile dustu (`indexer-live`in ilk zamanlanmis kosusu).
 *
 * VE ISIM ARTIK DOGRU DEGILDI. Yeni dagitimda fabrika 57_179_323'te, smoke
 * launch ise 57_363_854'te -- aralarinda 184.531 blok var, yani `maxSpan`
 * (10.000) ile tek pencerede kapsanamazlar. Fabrikanin KENDISI zaten log
 * taramasiyla degil `readFactoryProfile` ile (state okumasi) dogrulaniyor;
 * taranmasi gereken sey smoke'un OLAYLARI. Pencere bu yuzden smoke launch'in
 * blogunda baslar.
 *
 * OLCULDU (uretim defteri, 19 Agustos 2026): bu pencerede TEK launch, TEK
 * curve ve 10 escrow olayi var -- yani `SUFFIX_FEES` yalnizca smoke'u sayar,
 * komsu bir curve'un olaylarini degil.
 */
const SMOKE_FIRST = 57_363_854n
/**
 * Smoke launch'inin creator basina nonce'u -- ZINCIRE SORULARAK dogrulandi
 * (`predictAddresses` yalnizca 21'de bu tokeni verir).
 */
const SMOKE_NONCE = 21n
/** Smoke curve'unun SON escrow olayinin blogu. */
const SMOKE_LAST = 57_363_919n

const EXPECTED = {
  token: '0xe721ef447247103934225ce1bf47afbada101244' as Address,
  curve: '0x26dd9eae03c029cbfed58725d5ebfbe4c661f5ed' as Address,
  escrow: '0xeed4431ead3e27f16d97f677a9c4c1a963df8dc6' as Address,
  protocolTreasury: '0xebbecfda308ea307e173c6ec19a9c48f53d4b10c' as Address,
  creator: '0xe92c64c4f36216ea773f2622f6d5f8530ae92fd2' as Address,
  chainId: 5_042_002n,
}

/** Faz 1'in curve'u. Faz 2'de ARTIK IZLENMIYOR ama escrow'a odemis. */
const PHASE1_CURVE = '0x7938be340a14a12f94a83aea246d9d2566324c9c' as Address

/** Iki yarinin OLCULEN toplamlari. */
const PREFIX_FEES = 152_069_146_725_900_635n
const SUFFIX_FEES = 133_775_767_059_664_173n
const LEDGER_TOTAL = PREFIX_FEES + SUFFIX_FEES

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
    // DENEME SAYISI x UC SAYISI. Ayni uca dort kez sormak, o uc oran
    // sinirindayken dort kez ayni cevabi almaktir; tur her denemede DEGISIR.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const url = RPC_URLS[attempt % RPC_URLS.length] ?? RPC_URL
      requestCount += 1
      const started = Date.now()
      try {
        const response = await fetch(url, {
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
  rpcFallbackUrls: '',
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

/**
 * IMLECI BOS BIR ARALIGIN UZERINDEN ATLATIR -- GERCEK `parentHash` ILE.
 *
 * `assertContinuous` bir sonraki araligin ILK blogunun `parentHash`ini kayitli
 * imlec hash'iyle karsilastirir, yani atlama uydurulmus bir hash'le
 * YAPILAMAZ: blok `to`nun hash'i zincirden okunur. Muhafiz devrede kalir.
 */
async function jumpCursorTo(block: bigint): Promise<void> {
  const hash = (
    (await paced.request({
      method: 'eth_getBlockByNumber',
      params: [`0x${block.toString(16)}`, false],
    })) as { hash: Hex }
  ).hash
  await pool.query(
    'UPDATE sync_state SET last_block = $1, last_block_hash = $2, head_block = $1, head_observed_at = now()',
    [block.toString(), hash],
  )
}

/** Iki penceri sirayla kosar. Bkz. `START_BLOCK` yorumu. */
async function walkBothWindows(): Promise<void> {
  const first = await runOnce(pool, liveClient, deployment, CONFIG, {
    pacer,
    head: async () => ESCROW_PREFIX_LAST,
  })
  expect(first).not.toBeNull()
  await jumpCursorTo(SMOKE_FIRST - 1n)
  const second = await runOnce(pool, liveClient, deployment, CONFIG, {
    pacer,
    head: async () => SMOKE_LAST,
  })
  expect(second).not.toBeNull()
}

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

    // (0b) URETIM ACILIS KAPISI, URETIMDEKI SIRAYLA. `index.ts` bunu
    //      `ensureDeployment`ten sonra cagirir; burada da oyle cagriliyor ki
    //      kapinin GERCEK zincire karsi ne dedigi olculsun. Defterin
    //      `startBlock`u escrow'un blogudur, yani gecmesi gerekir.
    await assertStartBlockCoversEscrow(liveClient, deployment.escrow, START_BLOCK, pacer)

    await walkBothWindows()
    firstDump = await snapshot(pool)
  }, 300_000)

  /**
   * KAPI, GERCEK ZINCIRE KARSI, IKI YONDE.
   *
   * `beforeAll` zaten POZITIF yonu kosuyor. Bu test NEGATIF yonu olcuyor:
   * `launchFactoryBlock`tan baslamak -- trap 3'un davet ettigi
   * "optimizasyon" -- CANLI zincirde reddediliyor mu. Iki `eth_getCode`.
   */
  it('acilis kapisi factory nin blogundan baslamayi CANLI zincirde reddeder', async () => {
    await expect(
      assertStartBlockCoversEscrow(liveClient, deployment.escrow, SMOKE_FIRST, pacer),
    ).rejects.toThrow(/StartBlockAfterEscrow/)
  })

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
      symbol: 'AUBB',
    })
    /*
     * ZINCIRIN TOPLAM SAYACI BU SUITIN OLCTUGU SEY DEGIL.
     *
     * Eski hal `toBe(1n)` idi cunku fabrika o zaman TAZEYDI ve smoke tek
     * launch'ti. Bugun 27 launch var; suit ise bir PENCERE tariyor ve o
     * pencerede tam bir launch oldugu olculdu. Toplam sayaci pencereye esit
     * beklemek, suitin kendi kapsamini unutmasi olurdu.
     *
     * Olculebilir ve KALICI olan iliski: zincirin sayaci, smoke'un nonce'undan
     * buyuk olmali -- yani smoke gercekten bu fabrikada uretilmis.
     */
    expect(await readUint(FACTORY, 'launchCount()')).toBeGreaterThan(SMOKE_NONCE)

    // VE FAZ 1'IN LAUNCH'I GIRMEDI. Ayni escrow'u paylassalar da `Launched`
    // YALNIZCA `watch.factory` adresinden cekilir; superseded factory'nin
    // curve'u burada bir satir acamaz. Bu, "escrow'un gecmisini almak"
    // ile "iki dagitimin verisini karistirmak" arasindaki farkin ta kendisi.
    const { rows: curves } = await pool.query<{ curve: string }>('SELECT curve FROM curve_state')
    expect(curves.map((c) => c.curve)).toEqual([EXPECTED.curve])
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

    /*
     * VE INDEXER YALNIZCA TOKEN TRANSFER'LERINI GORDU.
     *
     * OLCULDU (uretim defteri, smoke penceresi): ALTI hareket -- mint arti BES
     * alim. Eski deger 5'ti ve o zamanki senaryoya aitti (mint + uc alim + bir
     * satis); yeni smoke bes ALIM yapiyor, satis yok.
     */
    expect(await count('token_transfers')).toBe(6)
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
      /*
       * NONCE 21, VE BU ZINCIRE SORULARAK BULUNDU.
       *
       * Eski hal `0n` idi ve yorumu "smoke ILK launch'ti" diyordu -- o zaman
       * dogruydu. Bugun ayni creator'in 22. launch'i ve fabrika 27 launch
       * tasiyor. `predictAddresses(..., 0n)` bu yuzden `0xD00C4591...` uretiyordu:
       * gercek bir adres, ama BASKA bir tokenin.
       */
      args: [launched.creator, launched.name, launched.symbol, launched.uri, SMOKE_NONCE],
    })
    const [token, curve] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }],
      await ethCallRaw(FACTORY, data),
    )
    expect((token as string).toLowerCase()).toBe(EXPECTED.token)
    expect((curve as string).toLowerCase()).toBe(EXPECTED.curve)
  })

  /**
   * (4) ESCROW ODEME GUCU -- VE `startBlock`IN TASIYICI OLDUGU YER.
   *
   * Dogru invariant `totalOwed <= balance`, `==` DEGIL: escrow'a dogrudan
   * gonderilen USDC TALEP EDILEMEZ (kontratin kisit 1'i). Bugun bagis yok,
   * yani ikisi esit.
   *
   * ASIL IDDIA IKINCI SATIRDA: defter `totalOwed`in TAMAMINA esit, ve o
   * toplamin 152069146725900635 wei'si SUPERSEDED factory'nin curve'unden
   * geldi. Bu esitlik, taramanin escrow'un blogundan basladigini olcen
   * seydir -- `startBlock`i `launchFactoryBlock` yapan bir kosuda defter tam
   * o kadar EKSIK cikardi ve ilk `claim()`de `CHECK (claimable_wei >= 0)` ile
   * kalici olarak kilitlenirdi (`test/shared-escrow.test.ts` bunu ayrica
   * calistiriyor).
   */
  it('claimable toplami totalOwed a esittir -- ON EKIN KATKISI DAHIL', async () => {
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

    /*
     * DEFTER TOPLAMI, ZINCIRIN TOPLAMINA ESIT DEGIL -- VE OLMAMALI.
     *
     * `ledger === totalOwed` iddiasi fabrika TAZEYKEN dogruydu: taranan iki
     * pencere escrow'un butun gecmisiydi. Bugun escrow'un `totalOwed()`u
     * 1.956e18 iken bu suitin iki penceresi 285.8e15 sayiyor -- fark eksik
     * veri degil, KAPSAM: suit bilerek iki dar pencere tariyor.
     *
     * Kalici olan iliski bir SIRALAMA: taranan toplam, zincirin toplamini
     * ASAMAZ; o da escrow'un bakiyesini asamaz. Esitlik beklemek, suitin kendi
     * kapsamini unutmasi olurdu (`launchCount()` ile ayni ders).
     */
    expect(ledger).toBe(LEDGER_TOTAL)
    expect(ledger).toBeLessThanOrEqual(totalOwed)
    expect(totalOwed).toBeLessThanOrEqual(balance)

    // VE DOKUM: on ek gercekten SUPERSEDED curve'den, son ek Faz 2'ninkinden.
    // `fee_events.from_addr` bu ayrimi tasiyan TEK alan.
    const { rows: byCurve } = await pool.query<{ from_addr: string; s: string }>(
      `SELECT from_addr, sum(amount_wei)::text AS s FROM fee_events
        WHERE kind = 'deposit' GROUP BY from_addr ORDER BY from_addr`,
    )
    expect(new Map(byCurve.map((r) => [r.from_addr, BigInt(r.s)]))).toEqual(
      new Map([
        [PHASE1_CURVE, PREFIX_FEES],
        [EXPECTED.curve, SUFFIX_FEES],
      ]),
    )
    console.log(
      `[live] defter=${ledger} totalOwed=${totalOwed} bakiye=${balance} ` +
        `(on ek ${PREFIX_FEES} superseded curve ${PHASE1_CURVE}'den)`,
    )
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
    // OLCULDU: smoke penceresinde bes trade, hepsi alim.
    expect(trades.length).toBe(5)
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
    // Toplanan quote, raise'i YEDI wei asiyor -- `floor()+1` her alimda; sayi
    // ALIM SAYISINA baglidir, sabit degil (Faz 1 smoke'unda 8'di, Faz 2'de 7).
    // OLCULDU: `curve.realQuoteReserves()` = 12161433369060378713.
    expect(rows!.realQuoteReservesWei - rows!.graduationRaiseWei).toBe(7n)
    // TAZE, cunku bu kosunun BASI `SMOKE_LAST`e sabitlendi ve imlec tam oraya
    // ulasti -- yani `blocksBehind` SIFIR. Bu bir ayrinti degil: gercek basla
    // kosulan ayni indexer yuz binlerce blok geride kalir ve o durumda TAZE
    // DEGILDIR (bkz. asagidaki iddia ve `packages/db`nin "canli ama geride"
    // testi).
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
    // GECIKME SABIT BIR LITERAL DEGIL: zincirin O ANDAKI basi ile imlecin
    // farki. Bir literal, her gun buyuyen bir sayiyi test icine gomerdi.
    const lag = behind.at?.head.measured === true ? behind.at.head.blocksBehind : null
    const expectedLag = BigInt(head as string) - SMOKE_LAST
    expect(lag).toBe(expectedLag)
    expect(lag).toBeGreaterThan(10_000n)
    await pool.query('UPDATE sync_state SET head_block = $1, head_observed_at = now()', [
      SMOKE_LAST.toString(),
    ])
  })

  /** (7) IKINCI KOSU IDEMPOTENT -- GERCEK zincir verisiyle, IKI PENCEREDE. */
  it('imleci geri alip yeniden kosturmak ayni veritabanini verir', async () => {
    // Zincir bagi muhafizi gercek `parentHash`i isteyecek; imlec hash'ini de
    // gercegiyle degistiriyoruz.
    const parent = (await paced.request({
      method: 'eth_getBlockByNumber',
      params: [`0x${START_BLOCK.toString(16)}`, false],
    })) as { parentHash: Hex }
    await pool.query('UPDATE sync_state SET last_block = $1, last_block_hash = $2', [
      (START_BLOCK - 1n).toString(),
      parent.parentHash,
    ])

    await walkBothWindows()

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
    // `head_observed_at` DE BIR DUVAR SAATIDIR ve LISTEDE YOKTU. Migration
    // 011 onu ekledi, `setCursor` her imlec ilerletmesinde `now()` yazar, ve
    // bu dosyanin ikinci kosusu imleci geri alip TEKRAR ilerletir -- yani iki
    // dokum bu sutunda ZORUNLU olarak ayrisir. Eksikligi gorunmuyordu cunku
    // `indexer-live.yml` adimi `continue-on-error: true` ile kosuyor.
    sync_state: ['updated_at', 'head_observed_at'],
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
