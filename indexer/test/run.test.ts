import { beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  DEFAULT_STALE_AFTER_SECONDS,
  type HeadObservation,
  getCursor,
  getIndexerStatus,
  putDeployment,
  setCursor,
  snapshot,
} from '@arcpad/db'
import { NonCanonicalLaunch } from '../src/admit'
import type { IndexerConfig } from '../src/config'
import { loadConfig } from '../src/config'
import type { RawLog, RpcClient } from '../src/logs'
import { createPacer } from '../src/logs'
import {
  backoffMs,
  isRateLimit,
  LIVENESS_BEAT_MS,
  RATE_LIMIT_BACKOFF_BASE_MS,
  BlockUnavailable,
  DeploymentMismatch,
  ensureDeployment,
  isTransient,
  loadWatchSet,
  readFactoryProfile,
  refreshStale24hVolume,
  refreshVolume24h,
  runOnce,
  runWithRetry,
  sameDeployment,
  touchedTokens,
} from '../src/run'
import { FakeNode, LIVE, loadSmoke, rawLogs, smokeLogs } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

const logs = smokeLogs()
/** Canli zincirdeki IKINCI gercek factory (tek kullanimlik tatbikat factory'si). */
const OTHER_FACTORY = '0xfed991c6b9ad7144df3d670c6b9ecf3620ac6ea5' as Address
const FIRST = BigInt(logs[0]!.blockNumber)
const LAST = BigInt(logs[logs.length - 1]!.blockNumber)

const CONFIG: IndexerConfig = {
  rpcUrl: 'http://unused',
  rpcFallbackUrls: '',
  databaseUrl: 'postgres://unused',
  factory: LIVE.factory,
  startBlock: LIVE_DEPLOYMENT.startBlock,
  // 10.000: canli smoke'un ilk logu `startBlock`tan 1.939 blok SONRA. 1.000
  // ile ilk tur BOS bir araligi tarardi ve testler "hicbir sey olmadi"yi
  // olcerdi -- ilk kosuda tam olarak bu oldu. Sinirin kendisi
  // `ARC_GETLOGS_MAX_RANGE` ve `loadConfig` onu ayrica iddia ediyor.
  maxSpan: 10_000n,
  pollMs: 10,
  volumeRefreshBatch: 100,
  maxAttempts: 3,
  rateLimitMaxAttempts: 3,
  minRequestIntervalMs: 0,
}

/** Blok cagrilarini da cevaplayan bir dugum: `runOnce` zincir bagini kontrol eder. */
class ChainNode extends FakeNode {
  constructor(
    logs: readonly RawLog[],
    private readonly opts: { head?: bigint; failCall?: string } = {},
    fakeOpts?: ConstructorParameters<typeof FakeNode>[1],
  ) {
    super(logs, fakeOpts)
  }

  override async request(args: { method: string; params?: unknown }): Promise<unknown> {
    if (args.method === 'eth_getBlockByNumber') {
      this.requests.push({ method: args.method, params: args.params })
      const [tag] = args.params as [Hex | string, boolean]
      if (tag === 'finalized') {
        return { number: `0x${(this.opts.head ?? LAST).toString(16)}` }
      }
      const block = BigInt(tag as Hex)
      return {
        number: tag,
        hash: hashOf(block),
        parentHash: hashOf(block - 1n),
        timestamp: '0x6a6a7f0a',
      }
    }
    if (args.method === 'eth_call') {
      this.requests.push({ method: args.method, params: args.params })
      const [call] = args.params as [{ data: string }]
      const answer = PROFILE_ANSWERS[call.data]
      if (answer === undefined) throw new Error(`beklenmeyen selector: ${call.data}`)
      return answer
    }
    return super.request(args)
  }
}

function hashOf(block: bigint): Hex {
  return `0x${block.toString(16).padStart(64, '0')}`
}

const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`
const addressWord = (a: Address): Hex => `0x${'0'.repeat(24)}${a.slice(2)}`

/** Canli dagitimin degerleri; `readFactoryProfile` bunlari okuyacak. */
const PROFILE_ANSWERS: Record<string, Hex> = {
  '0x1b1158ab': word(LIVE_DEPLOYMENT.virtualTokenReservesTok),
  '0x1401cbca': word(LIVE_DEPLOYMENT.virtualQuoteReservesWei),
  '0xcbf6fff9': word(LIVE_DEPLOYMENT.saleSupplyTok),
  '0xe2fdcc17': addressWord(LIVE_DEPLOYMENT.escrow),
  '0x803db96d': addressWord(LIVE_DEPLOYMENT.protocolTreasury),
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

/** Imlecin UC alani: nereye ulastik, hangi basi gorduk, ne zaman yazdik. */
async function stamp(): Promise<{
  lastBlock: bigint
  headBlock: bigint | null
  updatedAt: number
}> {
  const { rows } = await pool.query<{
    last_block: string
    head_block: string | null
    updated_at: Date
  }>('SELECT last_block::text, head_block::text, updated_at FROM sync_state WHERE id = 1')
  const row = rows[0]!
  return {
    lastBlock: BigInt(row.last_block),
    headBlock: row.head_block === null ? null : BigInt(row.head_block),
    updatedAt: row.updated_at.getTime(),
  }
}

describe('acilis', () => {
  beforeEach(async () => {
    await resetSchema()
  })

  it('profil ZINCIRDEN okunur (env den degil)', async () => {
    const node = new ChainNode([])
    const onChain = await readFactoryProfile(
      node,
      LIVE.factory,
      5_042_002n,
      LIVE_DEPLOYMENT.startBlock,
      createPacer(),
    )
    expect(onChain).toEqual(LIVE_DEPLOYMENT)
    // BES `eth_call`, hepsi factory'ye.
    const calls = node.requests.filter((r) => r.method === 'eth_call')
    expect(calls).toHaveLength(5)
  })

  it('ilk kosuda dagitim yazilir', async () => {
    const node = new ChainNode([])
    const onChain = await readFactoryProfile(
      node,
      LIVE.factory,
      5_042_002n,
      LIVE_DEPLOYMENT.startBlock,
      createPacer(),
    )
    expect(await ensureDeployment(pool, onChain)).toEqual(onChain)
    expect(await count('deployment')).toBe(1)
  })

  /**
   * PROFIL UYUSMAZLIGINDA HALT. `V` testnet ile uretim arasinda TAM 1000x
   * ayrisir; yanlis profille yazilan her market cap 1000 kat kayar ve bunu
   * baska HICBIR kontrol goremez.
   */
  it('V farkli oldugunda acilista DURUR', async () => {
    await putDeployment(pool, LIVE_DEPLOYMENT)
    const production = {
      ...LIVE_DEPLOYMENT,
      virtualQuoteReservesWei: LIVE_DEPLOYMENT.virtualQuoteReservesWei * 1000n,
    }
    await expect(ensureDeployment(pool, production)).rejects.toThrow(DeploymentMismatch)
  })

  it('factory farkli oldugunda da DURUR', async () => {
    await putDeployment(pool, LIVE_DEPLOYMENT)
    const other = {
      ...LIVE_DEPLOYMENT,
      factory: '0x00000000000000000000000000000000000000fa' as const,
    }
    await expect(ensureDeployment(pool, other)).rejects.toThrow(DeploymentMismatch)
  })

  /**
   * HAZINE ROTASYONU INDEXER'I DURDURMAZ.
   *
   * `protocolTreasury` dondurulebilir: factory onu deposit aninda CANLI okur,
   * boylece rotasyon dagitilmis curve'lere de ulasir. Kimlige dahil etseydik
   * mesru bir rotasyon `DeploymentMismatch` uretir ve indexer'i durdururdu --
   * oysa o adres indexer'in hicbir hesabina girmiyor (ucret alicisi
   * `Deposited.recipient`ten gelir).
   */
  it('protocolTreasury rotasyonu uyusmazlik SAYILMAZ', async () => {
    await putDeployment(pool, LIVE_DEPLOYMENT)
    const rotated = {
      ...LIVE_DEPLOYMENT,
      protocolTreasury: '0x00000000000000000000000000000000000000aa' as const,
    }
    expect(sameDeployment(LIVE_DEPLOYMENT, rotated)).toBe(true)
    await expect(ensureDeployment(pool, rotated)).resolves.toBeDefined()
    // Ama PROFIL degisirse yine DURUR -- kimligin bel kemigi orada.
    expect(sameDeployment(LIVE_DEPLOYMENT, { ...rotated, saleSupplyTok: 1n })).toBe(false)
  })

  // `startBlock` bir KONFIGURASYON secimidir, dagitimin kimligi degil.
  it('startBlock farki uyusmazlik SAYILMAZ', async () => {
    await putDeployment(pool, LIVE_DEPLOYMENT)
    const earlier = { ...LIVE_DEPLOYMENT, startBlock: LIVE_DEPLOYMENT.startBlock - 1_000n }
    expect(sameDeployment(LIVE_DEPLOYMENT, earlier)).toBe(true)
    await expect(ensureDeployment(pool, earlier)).resolves.toBeDefined()
  })

  it('izleme kumesi VERITABANINDAN kurulur', async () => {
    await seedDeployment()
    const empty = await loadWatchSet(pool, LIVE_DEPLOYMENT)
    expect(empty.curves.size).toBe(0)
    expect(empty.factory).toBe(LIVE.factory)

    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    const after = await loadWatchSet(pool, LIVE_DEPLOYMENT)
    expect([...after.tokens]).toEqual([LIVE.token])
    expect([...after.curves]).toEqual([LIVE.curve])
  })
})

describe('runOnce', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  it('bir aralik cekilir, uygulanir ve imlec AYNI islemde ilerler', async () => {
    const result = await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    expect(result).not.toBeNull()
    expect(result!.counts).toEqual({
      launches: 1,
      trades: 4,
      // HAVUZ ISLEMI YOK VE OLMAMALI: bu fixture mezuniyet ONCESI bir egridir.
      poolSwaps: 0,
      completed: 1,
      graduated: 0,
      transfers: 5,
      fees: 8,
      total: 19,
    })
    const cursor = await getCursor(pool)
    expect(cursor?.lastBlock).toBe(LAST)
    expect(cursor?.lastBlockHash).toBe(hashOf(LAST))
  })

  /**
   * HEAD IMLECE YETISMISSE HICBIR SATIR YAZILMAZ -- AMA CANLILIK YAZILIR.
   *
   * Bu test bir sure `snapshot(pool)`u OLDUGU GIBI karsilastiriyordu ve o hali
   * `sync_state.updated_at`i de kapsiyordu, yani "hicbir sey yapmaz" iddiasi
   * `updated_at`in DONMUS kalmasini da iceriyordu. O donmusluk B2-a'nin ikinci
   * yarisiydi: basa yetismis bir indexer 30 saniye sonra okuma katmanina
   * "yazma durdu" dedirtiyordu, oysa gayet iyi kosuyordu.
   *
   * Iddia daralmadi, KESKINLESTI: DEFTER degismez (exactly-once'in korudugu
   * sey), imlec ILERLEMEZ, ve canlilik damgasi ILERLER.
   */
  it('head imlece yetismisse hicbir SATIR yazmaz, ama canliligi tazeler', async () => {
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    const before = await snapshot(pool)
    const beforeStamp = await stamp()
    // Ayni milisaniyede iki `now()` esit cikabilir; damganin ILERLEDIGINI
    // olcmek icin arada gercek zaman gecmeli.
    await new Promise((done) => setTimeout(done, 25))

    expect(await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)).toBeNull()

    const after = await snapshot(pool)
    // DEFTERIN TAMAMI, `sync_state` HARIC: tek bir satir bile degismedi.
    const { sync_state: syncBefore, ...ledgerBefore } = before
    const { sync_state: syncAfter, ...ledgerAfter } = after
    expect(ledgerAfter).toEqual(ledgerBefore)
    expect(syncBefore).toHaveLength(1)
    expect(syncAfter).toHaveLength(1)

    const afterStamp = await stamp()
    // IMLEC ILERLEMEDI.
    expect(afterStamp.lastBlock).toBe(beforeStamp.lastBlock)
    // ...ve "hala buradayim" yazildi.
    expect(afterStamp.updatedAt).toBeGreaterThan(beforeStamp.updatedAt)
    expect(afterStamp.headBlock).toBe(beforeStamp.lastBlock)
  })

  it('head GERIYE duserse hicbir sey yapmaz', async () => {
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    const before = await snapshot(pool)
    const regressed = new ChainNode(logs, { head: FIRST - 10n })
    expect(await runOnce(pool, regressed, LIVE_DEPLOYMENT, CONFIG)).toBeNull()
    expect(await snapshot(pool)).toEqual(before)
  })

  /**
   * DELIVERABLE: ARALIK ORTASINDA OLDURULEN BIR SUREC.
   *
   * Yeniden baslatildiginda `snapshot`, hic olmemis bir kosunun snapshot'iyla
   * ESIT olmali. Burada "olum" transaction'in ortasinda patlayan bir yazim
   * olarak modelleniyor: `token_transfers`e yazmayi imkansiz kilan bir kisit
   * konur, tur patlar, kisit kaldirilir ve tur TEKRARLANIR.
   */
  it('commit oncesi cokme imleci ILERLETMEZ ve satir birakmaz', async () => {
    // Aralik ortasinda patlat: `token_transfers`e yazilamaz.
    await pool.query(
      `CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'aralik ortasinda cokme'; END $$`,
    )
    await pool.query(
      'CREATE TRIGGER t_boom BEFORE INSERT ON token_transfers FOR EACH ROW EXECUTE FUNCTION boom()',
    )

    await expect(runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)).rejects.toThrow(
      /aralik ortasinda cokme/,
    )

    // IMLEC YERINDE, VERITABANI BOS. Yarim aralik YOKTUR.
    expect(await getCursor(pool)).toBeNull()
    expect(await count('trades')).toBe(0)
    expect(await count('launches')).toBe(0)
    expect(await count('token_transfers')).toBe(0)

    // Surec yeniden basliyor.
    await pool.query('DROP TRIGGER t_boom ON token_transfers')
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    const revived = await snapshot(pool)

    // Ve HIC OLMEMIS bir kosu:
    await resetSchema()
    await seedDeployment()
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    const clean = await snapshot(pool)

    // `sync_state.updated_at` duvar saatidir ve iki kosu arasinda farklidir;
    // karsilastirma ondan arindirilir. Baska HICBIR alan disarida degil.
    expect(withoutClock(revived)).toEqual(withoutClock(clean))
  })

  it('ayni araligi iki kez kosturmak veritabanini AYNI birakir', async () => {
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    const first = await snapshot(pool)

    // Imleci geri al: aralik TEKRAR islenecek.
    await pool.query('UPDATE sync_state SET last_block = $1, last_block_hash = $2', [
      (FIRST - 1n).toString(),
      hashOf(FIRST - 1n),
    ])
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    expect(withoutClock(await snapshot(pool))).toEqual(withoutClock(first))
  })

  /**
   * KANONIK OLMAYAN LAUNCH: DURUR ama reddi KAYDEDER.
   *
   * Kayit AYRI bir baglantida yazilir; ayni transaction'a yazmak rollback'in
   * onu da yutmasi demekti ve operator elinde hicbir iz olmadan durmus bir
   * surec bulurdu.
   */
  it('kanonik olmayan launch ta durur ama reddi KAYDEDER', async () => {
    const forged = rawLogs('forged', { block: FIRST })
    // Sahte `Launched`i GERCEK factory adresinden yayilmis gibi goster: adres
    // filtresi onu ceker, ve kapiyi CREATE2 turetmesi kapatir.
    const relabelled = forged.map((log) =>
      log.topics[0] === '0x18335d7ceae0e8415362afcfc11b534b5bfbf6b27c59420bf3d8e783b39de1c7'
        ? { ...log, address: LIVE.factory }
        : log,
    )
    const node = new ChainNode(relabelled, { head: FIRST })
    await expect(runOnce(pool, node, LIVE_DEPLOYMENT, CONFIG)).rejects.toThrow(NonCanonicalLaunch)

    expect(await count('launches')).toBe(0)
    // ROLLBACK BUNU YUTMADI:
    expect(await count('rejected_launches')).toBe(1)
    const { rows } = await pool.query<{ reason: string; raw_addr: string }>(
      'SELECT reason, raw_addr FROM rejected_launches',
    )
    expect(rows[0]).toMatchObject({ reason: 'non_canonical', raw_addr: LIVE.factory })
    // Ve imlec ILERLEMEDI.
    expect(await getCursor(pool)).toBeNull()
  })

  it('kapsam kontrolu URETIM yolunda kosar', async () => {
    // `assertRangeApplied` transaction'in ICINDE cagriliyor: bir olay
    // deftere girmezse tur PATLAR ve imlec ilerlemez. Burada `trades`e
    // yazilani sessizce silen bir tetikleyici ile olculuyor.
    await pool.query(
      `CREATE FUNCTION swallow() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RETURN NULL; END $$`,
    )
    await pool.query(
      'CREATE TRIGGER t_swallow BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION swallow()',
    )
    await expect(runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)).rejects.toThrow(
      /LedgerGap/,
    )
    expect(await getCursor(pool)).toBeNull()
    await pool.query('DROP TRIGGER t_swallow ON trades')
  })

  it('zincir bagi kopmussa DURUR (parentHash uyusmuyor)', async () => {
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
    // Kayitli imlec hash'ini boz: bir sonraki turun `parentHash`i tutmayacak.
    await pool.query('UPDATE sync_state SET last_block_hash = $1', [hashOf(999_999n)])
    const node = new ChainNode(logs, { head: LAST + 5n })
    await expect(runOnce(pool, node, LIVE_DEPLOYMENT, CONFIG)).rejects.toThrow(/ReorgDetected/)
  })
})

describe('volume_24h_wei', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
    await runOnce(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG)
  })

  /**
   * PENCERE ZAMANA GORE KESER -- ve test bunu FIXTURE'IN gercek zamanina
   * BIRAKMAZ.
   *
   * Ilk hali "canli smoke'un bloklari eskidir, yani 0 bekleriz" diyordu ve
   * YANLISTI: makbuzlar bir gun once cekilmisti, yani pencerenin ICINDEYDILER
   * ve test bugun gecip yarin kirilacakti -- takvime bagli bir yesil. Zaman
   * artik acikca kuruluyor.
   */
  it('pencere DISINDAKI ticaretler sayilmaz, ICINDEKILER sayilir', async () => {
    await pool.query("UPDATE trades SET block_time = now() - interval '25 hours'")
    await refreshVolume24h(pool, [LIVE.token])
    const outside = await pool.query<{ v24: string; total: string }>(
      'SELECT volume_24h_wei::text AS v24, volume_total_wei::text AS total FROM token_stats',
    )
    expect(outside.rows[0]!.v24).toBe('0')
    // TOPLAM hacim penceresizdir ve DOLU: yani sifir, "veri yok"tan degil
    // pencerenin kendisinden geliyor.
    expect(BigInt(outside.rows[0]!.total)).toBeGreaterThan(0n)

    await pool.query("UPDATE trades SET block_time = now() - interval '23 hours'")
    await refreshVolume24h(pool, [LIVE.token])
    const inside = await pool.query<{ v24: string; total: string }>(
      'SELECT volume_24h_wei::text AS v24, volume_total_wei::text AS total FROM token_stats',
    )
    expect(inside.rows[0]!.v24).toBe(inside.rows[0]!.total)
  })

  it('pencereye giren ticaretler SAYILIR', async () => {
    await pool.query('UPDATE trades SET block_time = now()')
    expect(await refreshVolume24h(pool, [LIVE.token])).toBe(1)
    const { rows } = await pool.query<{ v24: string; total: string }>(
      'SELECT volume_24h_wei::text AS v24, volume_total_wei::text AS total FROM token_stats',
    )
    expect(rows[0]!.v24).toBe(rows[0]!.total)
  })

  /**
   * DOKUNULMAYAN TOKENLAR. Eski bir ticaret pencereden DUSTUGUNDE bunu
   * tetikleyen hicbir olay yoktur -- surgu adimi olmasa deger sonsuza kadar
   * bayat kalirdi.
   */
  it('surgu adimi dokunulmayan bir token u da tazeler', async () => {
    await pool.query('UPDATE trades SET block_time = now()')
    await refreshVolume24h(pool, [LIVE.token])
    const before = await pool.query<{ v24: string }>(
      'SELECT volume_24h_wei::text AS v24 FROM token_stats',
    )
    expect(before.rows[0]!.v24).not.toBe('0')

    // Ticaretler pencereden dusuyor; HICBIR yeni olay yok.
    await pool.query("UPDATE trades SET block_time = now() - interval '2 days'")
    expect(await refreshStale24hVolume(pool, 500)).toBe(1)
    const after = await pool.query<{ v24: string }>(
      'SELECT volume_24h_wei::text AS v24 FROM token_stats',
    )
    expect(after.rows[0]!.v24).toBe('0')
  })

  // `Trade` token TASIMAZ; curve'den cozulmezse ticaret alan ama transfer
  // gormeyen bir token'in 24s hacmi HIC tazelenmezdi.
  it('dokunulan tokenlar TICARET curve lerinden de cozulur', async () => {
    const smoke = loadSmoke()
    const tradeOnly = smoke.receipts
      .find((r) => r.scenario === 'sell')!
      .logs.filter(
        (l) => l.topics[0] === '0x733bb99acb17010119efa3b694a341a4be53fb2e7ea4800188314660780de278',
      )
    const events = await new FakeNode([]).request.length // no-op, tip icin
    expect(events).toBeGreaterThanOrEqual(0)
    const decoded = await import('../src/logs').then((m) =>
      m.decodeAll(new FakeNode([]), tradeOnly, 0n, 10n ** 12n, createPacer()),
    )
    expect(decoded).toHaveLength(1)
    expect(await touchedTokens(pool, decoded)).toEqual([LIVE.token])
  })
})

/**
 * ============ SAHIPSIZ IMLEC: FAZ 2 REDEPLOY'UNUN GERCEK RISKI ============
 *
 * `sync_state` factory TASIMAZ. Imlece anlamini veren sey `deployment`
 * satiridir ve uyusmazlikta `ensureDeployment` HALT eder -- ama IKISI
 * AYRILABILIR. Canli olculdu (2026-08-08): `deployment` bosaltilip imlec
 * 54721436'da birakildi, indexer YENI bir factory ile baslatildi; yeni
 * dagitim `start_block = 55000000` ile yazildi ve tarama 54721437'DEN, yani
 * ONCEKI factory'nin imlecinden devam etti.
 *
 * O yonde maliyet bosa taramadir. TERS YON kalicidir: imlec yeni
 * `startBlock`in ILERISINDEYSE aradaki her launch atlanir ve bir daha
 * cekilmez -- `nextRange` `cursor + 1`den acar, `start_block` yalnizca imlec
 * YOKKEN kullanilir. Faz 2 tam olarak bunu uretebilir.
 */
describe('sahipsiz imlec', () => {
  beforeEach(async () => {
    await resetSchema()
  })

  it('dagitim satiri YOKKEN duran bir imlec ATILIR, devralinmaz', async () => {
    // Eski dagitimin birakabilecegi hal: imlec var, `deployment` yok.
    await setCursor(pool, 54_721_436n, `0x${'ab'.repeat(32)}`, 54_800_000n)
    expect((await getCursor(pool))?.lastBlock).toBe(54_721_436n)

    const fresh = { ...LIVE_DEPLOYMENT, factory: OTHER_FACTORY, startBlock: 55_000_000n }
    const out = await ensureDeployment(pool, fresh)

    expect(out.factory).toBe(OTHER_FACTORY)
    // ASIL IDDIA: imlec GITTI, yani bir sonraki tur `startBlock`tan acar.
    expect(await getCursor(pool)).toBeNull()
  })

  it('NEGATIF KONTROL: dagitim satiri VARSA imlec KORUNUR', async () => {
    await putDeployment(pool, LIVE_DEPLOYMENT)
    await setCursor(pool, 54_721_436n, `0x${'cd'.repeat(32)}`, 54_800_000n)

    const out = await ensureDeployment(pool, LIVE_DEPLOYMENT)

    expect(out.factory).toBe(LIVE_DEPLOYMENT.factory)
    // Ayni dagitim -> ilerleme SILINMEZ. Bu satir olmadan yukaridaki test
    // "her acilista bastan tara" ile de gecerdi.
    expect((await getCursor(pool))?.lastBlock).toBe(54_721_436n)
  })

  it('ve BASKA bir factory dagitim satiriyla birlikte gelirse HALT eder', async () => {
    await putDeployment(pool, LIVE_DEPLOYMENT)
    await setCursor(pool, 54_721_436n, `0x${'ef'.repeat(32)}`, 54_800_000n)
    await expect(
      ensureDeployment(pool, { ...LIVE_DEPLOYMENT, factory: OTHER_FACTORY }),
    ).rejects.toBeInstanceOf(DeploymentMismatch)
    // HALT, yani imlece DOKUNULMAZ: operator karar verene kadar ilerleme durur.
    expect((await getCursor(pool))?.lastBlock).toBe(54_721_436n)
  })
})

describe('gecici hata politikasi', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  /**
   * BU TEST YALNIZCA DUZ TRANSPORT'U KAPSAR ve bunu bilerek soyluyor.
   *
   * Elle yazilan `new Error('429 ...')`, GERCEK yolun sekli DEGILDIR: uretimde
   * hata viem'in urettigi bir nesnedir ve icinde `URL:` ile `Request body:`
   * satirlari GECER. Tam olarak bu fark yuzunden buradaki dort satir yesilken
   * canlida siniflandirma TERSINE calisiyordu (bkz. `rpc-errors.test.ts`).
   * Gercek nesneler orada test edilir; burada kalan sey, canli entegrasyon
   * testinin kendi `fetch` tabanli transportunun attigi duz `Error` seklidir.
   */
  it('duz transportta 429/5xx GECICIDIR, bilinmeyen hata DEGILDIR', () => {
    expect(isTransient(new Error('429 Too Many Requests'))).toBe(true)
    expect(isTransient(new Error('503 Service Unavailable'))).toBe(true)
    expect(isTransient(new Error('fetch failed'))).toBe(true)
    expect(isTransient(new Error('socket hang up'))).toBe(true)
    // `AbortSignal.timeout` -- canli testin transportu bunu atar.
    expect(isTransient(new Error('The operation was aborted due to timeout'))).toBe(true)
    // Bilinmeyen bir hatayi gecici saymak, gercek bir kusuru bes kez
    // tekrarlayip gizlemek olurdu.
    expect(isTransient(new Error('something odd'))).toBe(false)
    // Ve bir KALICI kod, mesaji ne derse desin kalicidir.
    expect(isTransient(Object.assign(new Error('execution reverted'), { code: 3 }))).toBe(false)
  })

  it('HALT sinifi hatalar TEKRAR DENENMEZ', () => {
    for (const name of [
      'DeploymentMismatch',
      'NonCanonicalLaunch',
      'RemovedLog',
      'LogOutOfRange',
      'ForbiddenEmitter',
      'LedgerGap',
      'ReorgDetected',
    ]) {
      const error = Object.assign(new Error('429 ama kalici'), { name })
      expect(isTransient(error), name).toBe(false)
    }
  })

  it('geri cekilme ustel ve JITTERLI', () => {
    // Jitter olmadan, ayni anda geri cekilen iki indexer AYNI anda geri gelir.
    expect(backoffMs(0, () => 0)).toBe(125)
    expect(backoffMs(0, () => 0.999)).toBeGreaterThan(125)
    expect(backoffMs(3, () => 0)).toBe(1_000)
    // Tavan: 30 saniye.
    expect(backoffMs(20, () => 1)).toBeLessThanOrEqual(30_000)
    // TABAN PARAMETRIK, ve hiz sinirininki DORT KAT: olculen kurtarma araligi
    // 250ms'de guvenilir DEGIL (5 denemede 2 ret), 1.000ms'de 5/5.
    expect(backoffMs(0, () => 0, RATE_LIMIT_BACKOFF_BASE_MS)).toBe(500)
    expect(backoffMs(3, () => 0, RATE_LIMIT_BACKOFF_BASE_MS)).toBe(4_000)
    expect(backoffMs(20, () => 1, RATE_LIMIT_BACKOFF_BASE_MS)).toBeLessThanOrEqual(30_000)
  })

  /**
   * SINIFLANDIRMA TEK YERDE. `isTransient` ile `isRateLimit` ayrisirsa,
   * "gecici sayilan ama 250ms'lik butceyle denenen" bir kod yeniden dogar --
   * yani B2-c'nin ta kendisi.
   */
  it('isRateLimit, Arc in OLCULEN iki kodunu ve 429 u tanir', () => {
    expect(isRateLimit(Object.assign(new Error('x'), { code: -32005 }))).toBe(true)
    expect(isRateLimit(Object.assign(new Error('x'), { code: -32011 }))).toBe(true)
    expect(isRateLimit(Object.assign(new Error('x'), { status: 429 }))).toBe(true)
    // Bilinmeyen bir UCUNCU kod da 429 ile gelirse yakalanir.
    expect(isRateLimit(Object.assign(new Error('x'), { code: -32099, status: 429 }))).toBe(true)
    // ...ama her gecici hata hiz siniri DEGILDIR.
    expect(isRateLimit(Object.assign(new Error('x'), { status: 503 }))).toBe(false)
    expect(isRateLimit(new Error('fetch failed'))).toBe(false)
  })

  it('gecici hatada tekrar dener ve IMLEC ilerlemez', async () => {
    let attempts = 0
    const flaky: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getLogs' && attempts < 2) {
          attempts += 1
          throw new Error('429 Too Many Requests')
        }
        return new ChainNode(logs).request(args)
      },
    }
    const slept: number[] = []
    const result = await runWithRetry(pool, flaky, LIVE_DEPLOYMENT, CONFIG, {
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(attempts).toBe(2)
    expect(slept).toHaveLength(2)
    expect(result?.counts.total).toBe(19)
    expect((await getCursor(pool))?.lastBlock).toBe(LAST)
  })

  /**
   * ==========================================================================
   *  HIZ SINIRI BU SURECI ARTIK OLDURMEZ -- URETIMDE OLCULEN ARIZA.
   * ==========================================================================
   *
   * ESKI SOZLESME: sekiz denemeden sonra firlat -> `exit 1` -> systemd 5 sn
   * sonra yeniden baslatir -> ayni dolu kovaya AYNI istegi yollar -> yine
   * olur. Uretimde olculdu: 141 YENIDEN BASLATMA ve imlec 60 saniyede SIFIR
   * blok. Yani "yavaslama" diye tasarlanan sey CANLI KILIDE donusmustu, ve
   * yeniden baslatmanin kendisi durumu KOTULESTIRIYORDU -- her acilis, zaten
   * dolu kovaya taze bir istek demek.
   *
   * YENI SOZLESME: hiz sinirinda deneme sayisinin USTU YOKTUR. `backoffMs`
   * 30 saniyede tavanlanir, yani en kotu ihtimalle 30 saniyede bir dener --
   * sonsuza kadar -- ve kova bosaldigi an devam eder. Bir zinciri takip
   * etmekle gorevli bir surec, karsi taraf "simdi degil" dedi diye pes etmez.
   *
   * `maxAttempts` DIGER gecici hatalar icin aynen duruyor: bir DNS arizasi
   * sekiz denemede gecmiyorsa gercekten yanlis bir sey vardir.
   */
  it('hiz siniri ESKI BUTCEYI KAT KAT assa bile surec pes ETMEZ', async () => {
    let refusals = 0
    // Eski butce 8'di. Onun uc katindan fazla reddet.
    const REFUSALS = 25
    const stubborn: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getLogs' && refusals < REFUSALS) {
          refusals += 1
          throw Object.assign(new Error('rate limit exceeded'), { code: -32005 })
        }
        return new ChainNode(logs).request(args)
      },
    }
    const slept: number[] = []
    const result = await runWithRetry(pool, stubborn, LIVE_DEPLOYMENT, CONFIG, {
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    expect(refusals).toBe(REFUSALS)
    // Eski hal burada FIRLATIRDI. Simdi is bitiyor ve imlec ILERLIYOR --
    // yavas, ama duruyor degil.
    expect(result).not.toBeNull()
    expect((await getCursor(pool))?.lastBlock).toBe(LAST)
    /*
     * BIR GECISTE BIRDEN COK `eth_getLogs` VAR (ayri konu gruplari), yani
     * 25 ret 25'ten COK yeniden deneme uretir. Olculen sey sayinin kendisi
     * degil: HER ret yeniden denendi (>= REFUSALS) ve HICBIR bekleme 30
     * saniyelik tavani asmadi -- sonsuz sabir, sonsuz bekleme DEGIL.
     */
    expect(slept.length).toBeGreaterThanOrEqual(REFUSALS)
    for (const ms of slept) expect(ms).toBeLessThanOrEqual(30_000)
  })

  /**
   * ============ BOS BLOK YANITI: GECICI, VE ESKIDEN OYLE DEGILDI ============
   *
   * Uc blok okuma yeri de CIPLAK `new Error(...)` firlatiyordu. `name`
   * `'Error'`di, `PERMANENT`e girmezdi, BES metin sezgisinin hicbirine
   * takilmazdi ("blok 54661437 okunamadi": ne durum kodu, ne "timeout") ve
   * `isTransient`in son satirina -- "bilinmeyen KALICIDIR" -- duserdi. Yani
   * `finalized`i bir kez `null` donduren bir dugum ingest'i TAMAMEN
   * durduruyordu; oysa `finalized` HENUZ hicbir sey finalize etmemis bir
   * dugumde (yeniden baslamis, senkronize olan) tam olarak boyle doner.
   *
   * Asagidaki uc test uc AYRI seyi olcer ve ucu de gerekli:
   * yol (sinif gercekten firlatiliyor mu), politika (gecici mi), butce
   * (sonsuza kadar denemiyor mu).
   */
  it('null `finalized` BlockUnavailable firlatir -- ciplak Error DEGIL', async () => {
    const nullHead: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getBlockByNumber') {
          const [tag] = args.params as [string, boolean]
          if (tag === 'finalized') return null
        }
        return new ChainNode(logs).request(args)
      },
    }
    await expect(runOnce(pool, nullHead, LIVE_DEPLOYMENT, CONFIG)).rejects.toBeInstanceOf(
      BlockUnavailable,
    )
    // VE POLITIKA: ayni nesne GECICI sayilir. Iki iddia ayri cunku sinifi
    // firlatmak ile onu dogru siniflandirmak IKI ayri kusurdur -- ve bu depo
    // "adi olan ama kumede olmayan" halini bir kez yasadi.
    expect(isTransient(new BlockUnavailable('finalized', 'number'))).toBe(true)
  })

  /**
   * `-32001 block not found`, CAGRI YERINDE cevrilir. Ayni kod head'in
   * USTUNDE `eth_call`/`eth_getBalance` icin KALICIDIR (olculdu 2026-08-05) ve
   * o yollar degismedi -- burada cevrilmesinin sebebi, ONCEDEN GORULMUS bir
   * basi ya da altini sormus olmamiz.
   */
  it('-32001, blok okumasinda BlockUnavailable olur (ama genel kod tablosunda degil)', async () => {
    const notFound: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getBlockByNumber') {
          const [tag] = args.params as [string, boolean]
          if (tag !== 'finalized') {
            throw Object.assign(new Error('block not found'), { code: -32001 })
          }
        }
        return new ChainNode(logs).request(args)
      },
    }
    await expect(runOnce(pool, notFound, LIVE_DEPLOYMENT, CONFIG)).rejects.toBeInstanceOf(
      BlockUnavailable,
    )
    // Cagri yeri disinda -32001 hala siniflandirilmamis => kalici.
    expect(isTransient(Object.assign(new Error('block not found'), { code: -32001 }))).toBe(false)
  })

  it('bos blok yaniti TEKRAR DENENIR ve gecerse tur NORMAL biter', async () => {
    let nulls = 0
    const flapping: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getBlockByNumber') {
          const [tag] = args.params as [string, boolean]
          if (tag === 'finalized' && nulls < 2) {
            nulls += 1
            return null
          }
        }
        return new ChainNode(logs).request(args)
      },
    }
    const slept: number[] = []
    const result = await runWithRetry(pool, flapping, LIVE_DEPLOYMENT, CONFIG, {
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(nulls).toBe(2)
    expect(slept).toHaveLength(2)
    expect(result?.counts.total).toBe(19)
    expect((await getCursor(pool))?.lastBlock).toBe(LAST)
  })

  it('...ama BUTCESI VAR: hic gecmezse maxAttempts sonunda FIRLATIR', async () => {
    let calls = 0
    const dead: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getBlockByNumber') {
          const [tag] = args.params as [string, boolean]
          if (tag === 'finalized') {
            calls += 1
            return null
          }
        }
        return new ChainNode(logs).request(args)
      },
    }
    await expect(
      runWithRetry(pool, dead, LIVE_DEPLOYMENT, CONFIG, { sleep: async () => {} }),
    ).rejects.toBeInstanceOf(BlockUnavailable)
    expect(calls).toBe(CONFIG.maxAttempts)
    expect((await getCursor(pool))?.lastBlock).toBeUndefined()
  })

  /**
   * ================== B2-c: BUTCE, SINIFLANDIRMA DEGIL ==================
   *
   * `-32005` ZATEN dogru siniflandiriliyordu (gecici). Indexer yine de canliya
   * karsi bes aralik sonra `exit 1` etti, cunku BUTCE limitin gectigi araligin
   * ALTINDAYDI: `min(30s, 250*2^a)/2 + jitter`, bes deneme -> toplam 1,9-3,75
   * saniye. Olculen merdiven (bkz. `RATE_LIMIT_BACKOFF_BASE_MS`) 250ms'lik
   * araliklarda bes denemenin ikisinin REDDEDILDIGINI gosteriyor.
   *
   * Bu test uyku SURELERINI olcer, sayisini degil: "bes kez denedi" iddiasi
   * arizayi ISKALARDI -- eski kod da bes kez deniyordu.
   */
  it('HIZ SINIRI kendi butcesini ve merdivenini kullanir -- saniyeler, milisaniyeler degil', async () => {
    /*
     * SINIRLI SAYIDA REDDET, SONRA GECIR.
     *
     * Eski hal SONSUZA KADAR reddediyordu ve testin bitis kosulu
     * `runWithRetry`in bir butceyi tuketip FIRLATMASIYDI. O sozlesme kalkti:
     * hiz sinirinda ust sinir YOKTUR artik (uretimde olculdu -- 141 yeniden
     * baslatma ve imlec 60 saniyede sifir blok). Olculen OZELLIK degismedi,
     * yalnizca nereden okundugu degisti: merdiven `delays` dizisinden.
     */
    let refusals = 0
    const limited: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getLogs' && refusals < 8) {
          refusals += 1
          throw Object.assign(new Error('rate limit exceeded'), { code: -32005, status: 429 })
        }
        return new ChainNode(logs).request(args)
      },
    }
    const slept: number[] = []
    const delays: number[] = []
    await runWithRetry(
      pool,
      limited,
      LIVE_DEPLOYMENT,
      { ...CONFIG, maxAttempts: 3 },
      {
        sleep: async (ms) => {
          slept.push(ms)
        },
        onRetry: (info) => {
          delays.push(info.delayMs)
        },
      },
    )

    // GENEL butce (3) hiz sinirini SINIRLAMAZ: sekiz reddin sekizi de
    // yeniden denendi, yani `maxAttempts` bu dala hic karismadi.
    expect(delays).toHaveLength(8)
    const total = delays.reduce((a, b) => a + b, 0)
    // Eski davranisin TAVANI 3.750ms idi ve limit 3.000ms araliklarda bile
    // bir kez reddediyordu. Yeni taban tek basina onu asiyor.
    expect(total).toBeGreaterThan(3_750)
    // Ilk bekleme bile saniye mertebesinde -- eskisi 125-250ms idi.
    expect(delays[0]).toBeGreaterThanOrEqual(500)
    // HICBIR UYKU DILIMI CANLILIK ARALIGINI ASMAZ. Bekleme buyudukce dilim
    // SAYISI artar, SURESI degil -- C1'in butun mekanizmasi budur.
    expect(Math.max(...slept)).toBeLessThanOrEqual(LIVENESS_BEAT_MS)
    expect(slept.reduce((a, b) => a + b, 0)).toBe(total)
    /*
     * VE IMLEC ARTIK ILERLIYOR -- olculen sey de bu degil.
     *
     * Eski hal "butce tukendi, hicbir sey yazilmadi" diyordu. O sozlesme
     * kalkti: hiz sinirinda butce YOK, surec bekler ve gecince isini yapar.
     * Bu testin korudugu ozellik MERDIVENIN OLCEGI (saniyeler, milisaniyeler
     * degil) ve o yukarida olculuyor. Imlecin ilerlemesi, duzeltmenin
     * calistiginin ta kendisi.
     */
    expect(await getCursor(pool)).not.toBeNull()
  })

  /**
   * ============ C1: GERI CEKILEN INDEXER "DURMUS" GORUNMEZ ============
   *
   * BU TEST GERCEK BIR GERI CEKILME KOSAR. `sleep` DEGISTIRILMEZ, saat
   * SAHTELENMEZ, `vi.useFakeTimers` YOKTUR -- cunku ariza tam olarak sahte bir
   * saatin goremeyecegi yerdeydi: gercek `setTimeout` uykusu boyunca hicbir
   * sey YAZILMIYORDU ve veritabaninin KENDI saati ilerliyordu. Sahte bir saat,
   * `now()`u Postgres'in icinde ilerletmez, yani kusuru uretemez.
   *
   * OLCULEN ARIZA (gercek merdiven, gercek sunucu saati): sekiz denemelik
   * ladder 68,6 saniye surdu ve 4 saniye arayla alinan 18 orneklemin 10'u
   * `writes-stalled` dedi -- indexer her denemeyi loglayarak yasarken.
   *
   * Burada butce 3'e kisiltilir (gercek uykular ~0,5-2 sn) ve esik 1 saniyeye
   * indirilir; oran korunur, sure test edilebilir kalir.
   */
  it('GERCEK bir geri cekilme sirasinda canlilik yazilir, "durmus" DEMEZ', async () => {
    const CURSOR = 54_671_436n
    const HEAD = 55_438_940n
    await setCursor(pool, CURSOR, hashOf(CURSOR), HEAD)
    // Damgayi GERIYE al: eger geri cekilme sessiz olsaydi, durum bu testin
    // sonunda hala `stopped-and-behind` olurdu.
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '10 minutes'")
    const before = await getIndexerStatus(pool, { staleAfterSeconds: 1 })
    if (!before.stale) throw new Error('unreachable')
    expect(before.why).toBe('stopped-and-behind')

    /*
     * UC KEZ REDDET, SONRA GECIR. Eski hal sonsuza kadar reddediyordu ve
     * testin bitis kosulu bir butcenin tukenmesiydi -- o sozlesme kalkti.
     * OLCULEN SEY AYNI: geri cekilme SESSIZ DEGILDIR, sirasinda canlilik
     * yazilir, ve okuma katmani "durmus" demez.
     */
    let refusals = 0
    const limited: RpcClient = {
      request: async (args) => {
        if (refusals < 3) {
          refusals += 1
          throw Object.assign(new Error('rate limit exceeded'), { code: -32005, status: 429 })
        }
        return new ChainNode(logs).request(args)
      },
    }
    // GERCEK uykular: `sleep` gecilmiyor.
    await runWithRetry(pool, limited, LIVE_DEPLOYMENT, { ...CONFIG, maxAttempts: 3 })

    const after = await getIndexerStatus(pool, { staleAfterSeconds: 1 })
    if (!after.stale) throw new Error('unreachable')
    // ARTIK "durmus" DEMIYOR -- ve "geride" oldugunu hala soyluyor.
    expect(after.why).toBe('behind-head')
    expect(after.at?.stalenessSeconds).toBeLessThan(1)
    expect(lagOf(after.at)).toBe(HEAD - CURSOR)
    // Ve ilerleme IDDIA EDILMEDI: imlec ve bas aynen yerinde.
    expect(after.at?.lastBlock).toBe(CURSOR)
    expect(after.at?.head.headBlock).toBe(HEAD)
  })

  it('canlilik atisi arasi bosluk, bayatlik esiginden KUCUK olmak zorunda', () => {
    // Iliski bir tesaduf degil bir SART: merdiven ne kadar buyurse buyusun,
    // iki atis arasindaki en buyuk bosluk bu sabittir. Esik saniye, sabit
    // milisaniye.
    expect(LIVENESS_BEAT_MS).toBeLessThan(DEFAULT_STALE_AFTER_SECONDS * 1000)
    // Ucte bir pay: tek bir kacirilmis atis bile esigi asmaz.
    expect(LIVENESS_BEAT_MS * 3).toBeLessThanOrEqual(DEFAULT_STALE_AFTER_SECONDS * 1000)
  })

  it('hiz siniri butcesi GENEL butceyi tuketmez -- sayaclar ayri', async () => {
    // Once iki hiz siniri, sonra bilinmeyen bir gecici hata: genel butce
    // (3) hala DOLU olmali, yani istek yine de basariya ulasabilmeli.
    let calls = 0
    const mixed: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getLogs') {
          calls += 1
          if (calls <= 2) {
            throw Object.assign(new Error('rate limit exceeded'), { code: -32005, status: 429 })
          }
          if (calls === 3) throw new Error('503 Service Unavailable')
        }
        return new ChainNode(logs).request(args)
      },
    }
    const result = await runWithRetry(
      pool,
      mixed,
      LIVE_DEPLOYMENT,
      { ...CONFIG, maxAttempts: 3, rateLimitMaxAttempts: 8 },
      { sleep: async () => undefined },
    )
    expect(result?.counts.total).toBe(19)
  })

  it('deneme hakki bitince hata YUKARI cikar ve imlec YERINDE kalir', async () => {
    const always: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getLogs') throw new Error('503 Service Unavailable')
        return new ChainNode(logs).request(args)
      },
    }
    await expect(
      runWithRetry(pool, always, LIVE_DEPLOYMENT, CONFIG, { sleep: async () => undefined }),
    ).rejects.toThrow(/503/)
    expect(await getCursor(pool)).toBeNull()
  })
})

describe('config', () => {
  const base = {
    ARC_RPC_URL: 'https://rpc.testnet.arc.network',
    DATABASE_URL: 'postgres://x',
    ARC_FACTORY_ADDRESS: LIVE.factory,
    ARC_START_BLOCK: '54661437',
  }

  it('zorunlu alanlar eksikse ACILISTA patlar', () => {
    expect(() => loadConfig({ ...base, ARC_RPC_URL: '' })).toThrow(/ARC_RPC_URL/)
    expect(() => loadConfig({ ...base, ARC_FACTORY_ADDRESS: '' })).toThrow(/ARC_FACTORY_ADDRESS/)
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
    // Baslangic blogu olmadan taramaya baslamak, "nereden" sorusunu sessizce
    // sifira yuvarlamak olurdu.
    expect(() => loadConfig({ ...base, ARC_START_BLOCK: '' })).toThrow(/ARC_START_BLOCK/)
  })

  it('adres olmayan bir factory reddedilir', () => {
    expect(() => loadConfig({ ...base, ARC_FACTORY_ADDRESS: 'yok' })).toThrow(/adres degil/)
  })

  // Sinirin USTUNDE bir maxSpan HER cagriyi hataya cevirirdi; acilista
  // reddetmek onu bir baslangic hatasi yapar.
  it('maxSpan RPC sinirini asamaz', () => {
    expect(() => loadConfig({ ...base, INDEXER_MAX_SPAN: '50000' })).toThrow(/INDEXER_MAX_SPAN/)
    expect(loadConfig({ ...base, INDEXER_MAX_SPAN: '10000' }).maxSpan).toBe(10_000n)
  })

  it('varsayilanlar olculmus degerlerdir', () => {
    const cfg = loadConfig(base)
    // RPC'nin KENDI onerdigi yeniden deneme araligi 903 bloktu.
    expect(cfg.maxSpan).toBe(1_000n)
    expect(cfg.volumeRefreshBatch).toBe(500)
    expect(cfg.maxAttempts).toBe(5)
    expect(cfg.factory).toBe(LIVE.factory)
    expect(cfg.startBlock).toBe(54_661_437n)
  })

  /**
   * SIFIR, TEK BIR ANAHTARDA MESRU BIR DEGERDIR.
   *
   * `createPacer`in KENDI varsayilani 0 ve `Math.max(0, ...)` ile kelepceliyor,
   * yani kutuphane "pacing yok"u destekliyordu; konfigurasyon yuzeyi
   * ETMIYORDU ve `0` veren operator ACILISTA hata aliyordu. Varsayilan
   * DEGISMEDI (600, olculmus) -- degisen sey, acikca yazilan sifirin
   * gecebilmesi.
   */
  it('minRequestIntervalMs SIFIR olabilir; digerlerinin tabani 1 kalir', () => {
    expect(loadConfig({ ...base, INDEXER_MIN_REQUEST_INTERVAL_MS: '0' }).minRequestIntervalMs).toBe(
      0,
    )
    // Varsayilan hala olculmus 600.
    expect(loadConfig(base).minRequestIntervalMs).toBe(600)
    // Negatif hala reddedilir -- sifir bir taban, kapi degil.
    expect(() => loadConfig({ ...base, INDEXER_MIN_REQUEST_INTERVAL_MS: '-1' })).toThrow(/en az 0/)
    // Ve gevseme YALNIZCA o anahtarda: sifir poll = mesgul dongu, sifir
    // deneme = hic denememek, sifir batch = hic tazelenmeyen 24s hacmi.
    for (const key of ['INDEXER_POLL_MS', 'INDEXER_MAX_ATTEMPTS', 'INDEXER_VOLUME_REFRESH_BATCH']) {
      expect(() => loadConfig({ ...base, [key]: '0' }), key).toThrow(/en az 1/)
    }
  })
})

/**
 * DUVAR SAATI TASIYAN ALANLAR, TABLO TABLO.
 *
 * Bunlar INDEXER VERISI DEGILDIR: uc tanesi semanin kendi defteri (migration
 * ne zaman uygulandi, envanter ne zaman yazildi), ikisi de "bu satira en son
 * ne zaman dokunuldu" bilgisi. Iki AYRI kosu ayni duvar saatini tasiyamaz,
 * yani karsilastirmadan cikarilmalari zorunlu -- ama LISTE DAR TUTULUYOR ve
 * burada yazili: baska hicbir alan disarida degil, ozellikle hicbir MIKTAR,
 * SIRA ya da ADRES.
 */
/**
 * Gecikme, olculmus olsun olmasin -- ve daraltma HER cagri yerinde gorunur.
 * Tip `blocksBehind`i yalnizca `measured: true` dalinda tasir (bkz.
 * `HeadObservation`); test yardimcisi o kurali gevsetmez, ADLANDIRIR.
 */
function lagOf(at: { head: HeadObservation } | null | undefined): bigint | null {
  if (at === null || at === undefined) return null
  return at.head.measured ? at.head.blocksBehind : at.head.lastKnownBlocksBehind
}

const CLOCK_COLUMNS: Record<string, readonly string[]> = {
  // `head_observed_at` DE BIR DUVAR SAATIDIR ve `updated_at` ile ayni sebeple
  // burada: ikisi de "ne zaman" sorusunun cevabidir, "ne" sorusunun degil. Onu
  // listeye eklemeyi unutmak, iki kosunun ayni ANDA yapilmadigini bir
  // idempotency ihlali gibi gostermisti -- kapinin dogru sekilde patlamasi.
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

function withoutClock(dump: Record<string, unknown[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const [table, rows] of Object.entries(dump)) {
    const columns = CLOCK_COLUMNS[table]
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

/**
 * ============================================================================
 *  ARIZA GOSTEREMEYEN BIR SAGLIK GOSTERGESI -- URETIMDE OLCULDU
 * ============================================================================
 *
 * 2026-08-11, canli kutuda, ayni saniyede okundu:
 *
 *     db last_block   56512126
 *     db head_block   56512126     ->  `behind` = 0
 *     GERCEK zincir basi 56512307  ->  GERCEK gecikme 181 blok (~94 saniye)
 *     updated_at      9 saniye once
 *
 * Yani sagligi okuyan herkes "behind 0, taze yazma" goruyordu, indexer bir
 * bucuk dakika geride TAKILMISKEN. Sayi yalan soylemiyordu, DONMUSTU:
 * `head_block` yalnizca bir aralik BASARIYLA yazildiginda tazelenir. Getirilen
 * aralik basa kadar ulastiysa fark 0 olur, ve indexer o andan sonra ne kadar
 * takilirsa takilsin 0 KALIR.
 *
 * Ve `noteAlive` bunu KOTULESTIRIYORDU: geri cekilme uykusunda `updated_at`i
 * tazeleyerek "canliyim" diyor, tam da tek gorunur ariza belirtisi olan
 * sessizligi siliyordu. Iki dogru duzeltme birlestiginde bir yalan uretti.
 */
describe('gecikme, indexer TAKILIYKEN de gorunur', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  it('geri cekilme uykusunda bas TAZELENIR -- `behind` donmaz', async () => {
    // Imleci ilerlet: bir tur basariyla tamamlansin.
    await runWithRetry(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG, {
      sleep: async () => {},
    })
    const settled = await getCursor(pool)
    expect(settled?.lastBlock).toBe(LAST)

    // Zincir 500 blok ilerledi, ama `eth_getLogs` artik hep reddediliyor --
    // olculen durumun ta kendisi: log butcesi tukenmis, blok numarasi degil.
    const AHEAD = LAST + 500n
    let logCalls = 0
    const starved: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getLogs') {
          logCalls += 1
          throw new Error('rate limit exceeded')
        }
        return new ChainNode(logs).request(args)
      },
    }

    let slept = 0
    const run = runWithRetry(pool, starved, LIVE_DEPLOYMENT, CONFIG, {
      head: async () => AHEAD,
      sleep: async () => {
        slept += 1
        // Uc geri cekilmeden sonra kes: hiz siniri dalinin ust siniri YOKTUR
        // (bilerek), yani bu dongu kendiliginden bitmez.
        if (slept >= 3) throw new Error('STOP')
      },
    })
    await expect(run).rejects.toThrow('STOP')

    const row = await pool.query<{ last_block: string; head_block: string }>(
      'SELECT last_block, head_block FROM sync_state WHERE id = 1',
    )
    const lastBlock = BigInt(row.rows[0]!.last_block)
    const headBlock = BigInt(row.rows[0]!.head_block)

    // IMLEC ILERLEMEDI -- geri cekilirken ilerleme iddia etmek, duzeltilen
    // yalanin yerine baskasini koymak olurdu.
    expect(lastBlock).toBe(LAST)
    // AMA BAS TAZELENDI, dolayisiyla gecikme GORUNUR.
    expect(headBlock).toBe(AHEAD)
    expect(headBlock - lastBlock).toBe(500n)
    expect(logCalls, 'takilan sey log taramasiydi, bas okumasi degil').toBeGreaterThan(0)
  })

  it('bas OKUNAMAZSA canlilik yine de yazilir -- iki iddia ayridir', async () => {
    await runWithRetry(pool, new ChainNode(logs), LIVE_DEPLOYMENT, CONFIG, {
      sleep: async () => {},
    })
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '5 minutes' WHERE id = 1")

    const dead: RpcClient = {
      request: async (args) => {
        if (args.method === 'eth_getLogs') throw new Error('rate limit exceeded')
        return new ChainNode(logs).request(args)
      },
    }

    let slept = 0
    const run = runWithRetry(pool, dead, LIVE_DEPLOYMENT, CONFIG, {
      // RPC tamamen kapali: bas da okunamiyor.
      head: async () => {
        throw new Error('rate limit exceeded')
      },
      sleep: async () => {
        slept += 1
        if (slept >= 2) throw new Error('STOP')
      },
    })
    await expect(run).rejects.toThrow('STOP')

    const { rows } = await pool.query<{ age: string }>(
      'SELECT extract(epoch from age(now(), updated_at))::int AS age FROM sync_state WHERE id = 1',
    )
    // Basi kaybetmek CANLILIGI da kaybettirmemeli: dogru bir sayiyi, baska
    // bir sayinin arizasi yuzunden susturmak olurdu.
    expect(Number(rows[0]!.age)).toBeLessThan(60)
  })
})
