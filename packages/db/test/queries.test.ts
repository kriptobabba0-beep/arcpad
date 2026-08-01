import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_STALE_AFTER_SECONDS,
  getClaimableFees,
  getIndexerStatus,
  getTokenOverview,
  listCreatorEarningsByLaunch,
  listHolders,
  listLaunchesByCreator,
  listTokens,
  listTrades,
} from '../src/queries'
import { putDeployment } from '../src/deployment'
import { replayRange, setCursor } from '../src/apply'
import { pool, resetSchema } from './setup'
import {
  ALICE,
  BOB,
  CREATOR,
  CURVE,
  DEPLOYMENT,
  hashFor,
  LAUNCH,
  PROFILE,
  RANGE,
  RANGE_TO,
  TOKEN,
} from './fixtures'

/** Uretim profili: V = 4_292e18. Testnet ile TEK farki budur (tam 1000x). */
const PRODUCTION_V = 4_292n * 10n ** 18n
const TESTNET_V = 4_292n * 10n ** 15n
const S = PROFILE.saleSupplyTok

/**
 * Dagitim profili VE curve'un ACILIS rezervleri birlikte kurulur.
 *
 * Ikisi uretimde de birlikte gelir: `admit` `curve_state`i `deployment`in
 * degerleriyle acar. Yalnizca `deployment`i degistirip curve'u fixture'in
 * degeriyle birakmak, hicbir zaman olusamayacak bir durumu olcmek olurdu --
 * ve ilk kosuda tam olarak o oldu (market cap 27,9 USDC cikti, cunku curve
 * 30e18 ile aciliyordu).
 */
async function seed(virtualQuoteReservesWei = TESTNET_V): Promise<void> {
  await putDeployment(pool, { ...DEPLOYMENT, virtualQuoteReservesWei })
}

function launchWith(virtualQuoteReservesWei: bigint) {
  return [{ ...LAUNCH, virtualQuoteReservesWei }]
}

async function setReserves(patch: Record<string, bigint>): Promise<void> {
  const keys = Object.keys(patch)
  const set = keys.map((k, i) => `${k} = $${i + 1}::numeric`).join(', ')
  await pool.query(`UPDATE curve_state SET ${set}`, Object.values(patch).map(String))
}

async function overview() {
  const { rows } = await getTokenOverview(pool, TOKEN)
  if (rows === null) throw new Error('token_overview bos')
  return rows
}

describe('token_overview', () => {
  beforeEach(async () => {
    await resetSchema()
  })

  // ---------------------------------------------------------------
  // SABITLENMIS DEGERLER -- elle turetilmis, kutuphaneyi cagirarak DEGIL
  // ---------------------------------------------------------------

  /**
   * URETIM profili: V = 4_292e18, Vt = 1_073e24, N = 1e27
   *   market_cap = floor(4292e18 * 1e27 / 1,073e27) = 4000e18 wei = 4.000 USDC
   *   price      = floor(4292e18 * 1e18 / 1,073e27) = 4e12 wei
   */
  it('acilis market cap i URETIM profilinde tam 4.000 USDC', async () => {
    await seed(PRODUCTION_V)
    await replayRange(pool, launchWith(PRODUCTION_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    const o = await overview()
    expect(o.marketCapWei).toBe(4_000n * 10n ** 18n)
    expect(o.priceWeiPerTok).toBe(4n * 10n ** 12n)
  })

  /**
   * TESTNET profili: V = 4_292e15 -> market_cap = 4e18 wei = 4 USDC.
   * Bu ayni zamanda `LaunchFactory.MIN_OPENING_MARKET_CAP`'in TA KENDISIDIR --
   * testnet profili tabanin TAM UZERINDE oturur.
   */
  it('acilis market cap i TESTNET profilinde tam 4 USDC', async () => {
    await seed()
    await replayRange(pool, launchWith(TESTNET_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    expect((await overview()).marketCapWei).toBe(4n * 10n ** 18n)
  })

  it('fiyat ile market cap birbiriyle tutarlidir (N = 1e27, olcek 1e18)', async () => {
    await seed()
    await replayRange(pool, launchWith(TESTNET_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    const o = await overview()
    // market_cap / 1e9 = price  (N/1e18 = 1e9)
    expect(o.marketCapWei / 1_000_000_000n).toBe(o.priceWeiPerTok)
  })

  it('progress_ppm kenar degerleri', async () => {
    await seed()
    await replayRange(pool, launchWith(TESTNET_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))

    await setReserves({ real_token_reserves_tok: S })
    expect((await overview()).progressPpm).toBe(0)

    await setReserves({ real_token_reserves_tok: S / 2n })
    expect((await overview()).progressPpm).toBe(500_000)

    // BIR WEI kaldi: 999.999, 1.000.000 DEGIL. Asagi yuvarlamak curve
    // kapanmadan %100 gostermek olurdu.
    await setReserves({ real_token_reserves_tok: 1n })
    expect((await overview()).progressPpm).toBe(999_999)

    await setReserves({ real_token_reserves_tok: 0n })
    expect((await overview()).progressPpm).toBe(1_000_000)
  })

  /**
   * GRADUATION RAISE = mulDiv(V, S, T-S), floor.
   * Testnet profilinde 12_161_433_369_060_378_706 wei.
   *
   * CANLI ZINCIR BUNU DOGRULUYOR ve fark ANLAMLI: canli smoke'un `Completed`
   * olayi `realQuoteReserves = 12_161_433_369_060_378_714` tasiyor -- SEKIZ
   * wei FAZLA. Sebebi `quoteBuyCost`un her alimda `floor(...) + 1` donmesi
   * (CurveMath.sol:52), yani biriken quote alim sayisi kadar fazladir. Tam da
   * bu yuzden `progress_ppm` quote'a degil TOKEN'a bakar.
   */
  it('graduation raise testnet profilinde 12_161_433_369_060_378_706 wei', async () => {
    await seed()
    await replayRange(pool, launchWith(TESTNET_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    expect((await overview()).graduationRaiseWei).toBe(12_161_433_369_060_378_706n)
  })

  it('view saklamaz -- rezervler degisince degerler ANINDA degisir', async () => {
    await seed()
    await replayRange(pool, launchWith(TESTNET_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    const before = await overview()
    await setReserves({ virtual_quote_reserves_wei: TESTNET_V * 2n })
    const after = await overview()
    expect(after.marketCapWei).toBe(before.marketCapWei * 2n)
  })

  it('fee_creator devirden sonra GUNCEL aliciyi verir', async () => {
    await seed()
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    expect((await overview()).feeCreator).toBe(CREATOR)
    // Sentetik devir: `curve_state.last_seq`ten SONRAKI bir satir SECILMEZ,
    // once gelen secilir -- `creator_at` noktasaldir.
    const { last_seq } = (
      await pool.query<{ last_seq: string }>('SELECT last_seq::text FROM curve_state')
    ).rows[0]!
    await pool.query('INSERT INTO creator_history (token, from_seq, creator) VALUES ($1,$2,$3)', [
      TOKEN,
      last_seq,
      BOB,
    ])
    expect((await overview()).feeCreator).toBe(BOB)
  })
})

describe('listeler', () => {
  beforeEach(async () => {
    await resetSchema()
    await seed()
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
  })

  it('listTokens varsayilan olarak en yeniden eskiye', async () => {
    const { rows } = await listTokens(pool)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token).toBe(TOKEN)
  })

  it('recentBuys hic alim gormemis token u GOSTERMEZ', async () => {
    await pool.query('UPDATE token_stats SET last_buy_seq = NULL, last_buy_at = NULL')
    const { rows } = await listTokens(pool, { sort: 'recentBuys' })
    expect(rows).toHaveLength(0)
    // Ve bu bir optimizasyon degil URUN karari: etiket "recent buys",
    // "recently launched" degil.
    expect((await listTokens(pool, { sort: 'newest' })).rows).toHaveLength(1)
  })

  it('keyset imleci ayni satiri IKINCI kez vermez', async () => {
    const first = await listTokens(pool, { sort: 'newest', limit: 1 })
    expect(first.rows).toHaveLength(1)
    const next = await listTokens(pool, {
      sort: 'newest',
      limit: 1,
      cursor: first.rows[0]!.createdSeq,
    })
    expect(next.rows).toHaveLength(0)
  })

  it('ageDays bir PENCEREDIR, siralama degil', async () => {
    expect((await listTokens(pool, { ageDays: 3650 })).rows).toHaveLength(1)
    await pool.query("UPDATE launches SET created_at = now() - interval '40 days'")
    expect((await listTokens(pool, { ageDays: 7 })).rows).toHaveLength(0)
    expect((await listTokens(pool, { ageDays: 90 })).rows).toHaveLength(1)
  })

  it('listTrades en yeniden eskiye ve is_dev NOKTASALDIR', async () => {
    const trades = await listTrades(pool, TOKEN)
    expect(trades.length).toBeGreaterThan(0)
    const seqs = trades.map((t) => t.eventSeq)
    expect(seqs).toEqual([...seqs].sort((a, b) => (a > b ? -1 : 1)))
    // Fixture'in ticaretlerini ALICE yapti; creator CREATOR, yani is_dev false.
    expect(trades.every((t) => t.isDev === false)).toBe(true)

    // Sentetik devir ALICE'e: SONRAKI islemler is_dev olur, oncekiler OLMAZ.
    const pivot = seqs[seqs.length - 1]!
    await pool.query('INSERT INTO creator_history (token, from_seq, creator) VALUES ($1,$2,$3)', [
      TOKEN,
      (pivot + 1n).toString(),
      ALICE,
    ])
    const after = await listTrades(pool, TOKEN)
    expect(after.filter((t) => t.isDev).length).toBeGreaterThan(0)
    expect(after.find((t) => t.eventSeq === pivot)?.isDev).toBe(false)
  })

  /**
   * HOLDER LISTESI CURVE'U GOSTERMEZ. Curve tum arzi tasir; listede olsaydi
   * her token'in en buyuk "holder"i, hicbir kullanicinin elinde olmayan bir
   * bakiye olurdu.
   */
  it('listHolders curve i HARIC tutar ve bakiyeye gore siralar', async () => {
    const holders = await listHolders(pool, TOKEN)
    expect(holders.map((h) => h.holder)).not.toContain(CURVE)
    const balances = holders.map((h) => h.balanceTok)
    expect(balances).toEqual([...balances].sort((a, b) => (a > b ? -1 : 1)))
    // Curve GERCEKTEN bir satir olarak duruyor -- yani filtre calisiyor,
    // veri eksik degil.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM holders WHERE holder = $1',
      [CURVE],
    )
    expect(rows[0]!.n).toBe('1')
  })

  it('listLaunchesByCreator BASLATANI kullanir, ucret alicisini degil', async () => {
    expect((await listLaunchesByCreator(pool, CREATOR)).map((t) => t.token)).toEqual([TOKEN])
    expect(await listLaunchesByCreator(pool, BOB)).toEqual([])
  })

  it('getClaimableFees defterin uc alanini birden verir', async () => {
    const fees = await getClaimableFees(pool, CREATOR)
    expect(fees).not.toBeNull()
    expect(fees!.claimableWei).toBe(fees!.depositedTotalWei - fees!.claimedTotalWei)
    expect(await getClaimableFees(pool, BOB)).toBeNull()
  })

  it('creator kazanci LAUNCH BASINA dokulur (Deposited.from sayesinde)', async () => {
    const earnings = await listCreatorEarningsByLaunch(pool, CREATOR)
    expect(earnings).toHaveLength(1)
    expect(earnings[0]?.token).toBe(TOKEN)
    expect(earnings[0]!.earnedWei).toBeGreaterThan(0n)
  })
})

/**
 * TAZELIK.
 *
 * Frontend'in gereksinimi: bayat sayilari CANLI gibi gostermek yerine
 * "indexer geride" demek. Bu ancak okuma modeli tazeligi KENDISI verirse
 * mumkun -- ve `listTokens`/`getTokenOverview` onu satirlarla BIRLIKTE
 * dondurdugu icin cagiran onu almayi unutamaz.
 */
describe('indexer tazeligi', () => {
  beforeEach(async () => {
    await resetSchema()
    await seed()
  })

  it('hic kosmamis bir indexer BAYATTIR (bilinmiyor, "taze" degil)', async () => {
    const status = await getIndexerStatus(pool)
    expect(status.lastBlock).toBeNull()
    expect(status.updatedAt).toBeNull()
    expect(status.stale).toBe(true)
  })

  it('yeni ilerlemis bir imlec TAZEDIR', async () => {
    await setCursor(pool, 54_661_437n, hashFor(54_661_437n))
    const status = await getIndexerStatus(pool)
    expect(status.lastBlock).toBe(54_661_437n)
    expect(status.stale).toBe(false)
    expect(status.stalenessSeconds).toBeLessThan(5)
  })

  it('esigi asan bir imlec BAYATTIR ve olcum SUNUCU saatindendir', async () => {
    await setCursor(pool, 54_661_437n, hashFor(54_661_437n))
    // Zamani veritabaninda geri al -- cagiranin saatini degil.
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '10 minutes'")
    const status = await getIndexerStatus(pool)
    expect(status.stalenessSeconds).toBeGreaterThan(590)
    expect(status.stale).toBe(true)
    // Esik parametreliktir: 20 dakika esikte ayni satir TAZE sayilir.
    expect((await getIndexerStatus(pool, 1_200)).stale).toBe(false)
    expect(DEFAULT_STALE_AFTER_SECONDS).toBe(30)
  })

  it('satirlari almanin tazeligi ALMADAN bir yolu yok', async () => {
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '1 hour'")

    const list = await listTokens(pool)
    expect(list.rows).toHaveLength(1)
    expect(list.indexer.stale).toBe(true)

    const one = await getTokenOverview(pool, TOKEN)
    expect(one.rows?.token).toBe(TOKEN)
    expect(one.indexer.stale).toBe(true)
    // Ayni imlec, ayni cevap: iki yol da AYNI kaynagi okur.
    expect(one.indexer.lastBlock).toBe(list.indexer.lastBlock)
  })
})
