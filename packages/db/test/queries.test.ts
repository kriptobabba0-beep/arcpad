import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HEAD_STALE_AFTER_SECONDS,
  type HeadObservation,
  DEFAULT_MAX_BLOCKS_BEHIND,
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
import { noteAlive, noteHead, replayRange, setCursor } from '../src/apply'
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

  /**
   * ============================================================================
   *  VIEW HESAPLADIGI SEYI SAKLAMAZ -- AMA `market_cap_wei` ARTIK HESAPLANMIYOR
   * ============================================================================
   *
   * BU TEST `marketCapWei` UZERINDEN YAZILMISTI VE `018_market_cap_source.sql`
   * ONU GECERSIZ KILDI. Sebep bir gerileme degil, bir URUN KARARI (denetim
   * defteri D-14): mezuniyetten sonra market cap HAVUZUN fiyatidir, ve egri
   * mezuniyette DONAR -- yani egriden hesaplanan bir deger mezun bir token icin
   * son eger fiyatta kalirdi. Sutun artik `token_stats`te BAKILIR
   * (`applyLaunch` / `applyTrade` / `applyPoolSwap`), view onu okur.
   *
   * ONUN YERINE ISPAT IKIYE BOLUNDU, cunku iddia iki ayri sey soyluyor:
   *
   *   1. HESAPLANAN sutunlar GERCEKTEN hesaplanir -- `price_wei_per_tok` ve
   *      `progress_ppm` `curve_state`e dokunulunca ANINDA degisir. Bu, "view bir
   *      onbellek degildir" iddiasinin hala GECERLI olan yarisi.
   *   2. BAKILAN sutun, bakilmayan bir yoldan degismez -- `curve_state`e elle
   *      yazmak market cap'i OYNATMAZ. Bu bir kusur DEGIL, saklanan bir sutunun
   *      tanimi; ve bayatlayamamasinin sebebi YAPISAL:
   *
   *        * sanal rezervleri (market cap'in girdilerini) yazan YALNIZCA
   *          `applyLaunch`, `applyTrade` ve `applyPoolSwap`tir -- ucu de ayni
   *          ifadeyle sutunu bakar;
   *        * `applyCompleted` yalnizca GERCEK rezervleri, `applyGraduated`
   *          yalnizca bayraklari yazar;
   *        * reorg ONARILMAZ -- `ReorgDetected` ingest'i DURDURUR, yani
   *          rezervleri islem olmadan geri saran bir yol yok.
   *
   *      Bu maddeler olculdu, varsayilmadi.
   */
  it('HESAPLANAN sutunlar ANINDA degisir -- view bir onbellek degil', async () => {
    await seed()
    await replayRange(pool, launchWith(TESTNET_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    const before = await overview()
    await setReserves({ virtual_quote_reserves_wei: TESTNET_V * 2n })
    const after = await overview()
    // Fiyat = div(Vq * 1e18, Vt). Vq ikiye katlandi.
    expect(after.priceWeiPerTok).toBe(before.priceWeiPerTok * 2n)
  })

  it('BAKILAN `market_cap_wei` elle yazilan bir `curve_state`ten ETKILENMEZ', async () => {
    await seed()
    await replayRange(pool, launchWith(TESTNET_V), RANGE_TO, hashFor(RANGE_TO), hashFor(0n))
    const before = await overview()
    await setReserves({ virtual_quote_reserves_wei: TESTNET_V * 2n })
    const after = await overview()
    expect(
      after.marketCapWei,
      'sutun `token_stats`te bakilir; onu oynatan sey bir OLAYDIR, elle yazilan bir satir degil',
    ).toBe(before.marketCapWei)
    // VE DEGER SIFIR DEGIL: `applyLaunch` acilis market cap'ini yazar. Sifir
    // olsaydi yukaridaki esitlik VAKUMDA gecerdi.
    expect(before.marketCapWei, 'acilis market cap i yazilmis olmali').toBeGreaterThan(0n)
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

  /**
   * UCRET PARCALARI VE DORT REZERV DE DONER.
   *
   * Frontend'in okuma katmani bunlari ZORUNLU alan olarak istiyor ve sebebi
   * hesaplanabilirlik: cuzdandan cikan tutar `quote + protocolFee +
   * creatorFee`dir (satista eksi), ve gerceklesen fiyat grafigi ancak islem
   * SONRASI rezervlerle kurulabilir. Sutunlar 003'te hep vardi; SELECT onlari
   * atliyordu -- yani veri kaybi degil, GORUNMEZLIK.
   */
  it('listTrades ucret parcalarini ve dort rezervi de dondurur', async () => {
    const [trade] = await listTrades(pool, TOKEN, { limit: 1 })
    expect(trade).toBeDefined()
    const { rows } = await pool.query<Record<string, string>>(
      `SELECT protocol_fee_wei::text AS p, creator_fee_wei::text AS c,
              virtual_token_reserves_tok::text AS vt, virtual_quote_reserves_wei::text AS vq,
              real_token_reserves_tok::text AS rt, real_quote_reserves_wei::text AS rq
         FROM trades WHERE event_seq = $1`,
      [trade!.eventSeq.toString()],
    )
    const row = rows[0]!
    expect(trade!.protocolFeeWei).toBe(BigInt(row['p']!))
    expect(trade!.creatorFeeWei).toBe(BigInt(row['c']!))
    expect(trade!.virtualTokenReservesTok).toBe(BigInt(row['vt']!))
    expect(trade!.virtualQuoteReservesWei).toBe(BigInt(row['vq']!))
    expect(trade!.realTokenReservesTok).toBe(BigInt(row['rt']!))
    expect(trade!.realQuoteReservesWei).toBe(BigInt(row['rq']!))
    // Ve tuketicinin gercekten hesapladigi sey kurulabiliyor:
    const walletDelta = trade!.isBuy
      ? -(trade!.quoteAmountWei + trade!.protocolFeeWei + trade!.creatorFeeWei)
      : trade!.quoteAmountWei - trade!.protocolFeeWei - trade!.creatorFeeWei
    expect(walletDelta).not.toBe(0n)
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
 * TAZELIK -- IKI EKSEN.
 *
 * Frontend'in gereksinimi: bayat sayilari CANLI gibi gostermek yerine
 * "indexer geride" demek. Bu ancak okuma modeli tazeligi KENDISI verirse
 * mumkun -- ve `listTokens`/`getTokenOverview` onu satirlarla BIRLIKTE
 * dondurdugu icin cagiran onu almayi unutamaz.
 *
 * IKINCI EKSEN BIR ARIZADAN GELDI. `stale` yalnizca `now() - updated_at`i
 * olcerken, canli Arc'a karsi kosan gercek indexer 767.504 blok (~75 saat)
 * geridEYKEN `stale: false` dedi ve sayfa hicbir uyari cizmedi. Asagidaki
 * "canli ama geride" testi tam olarak o durumdur ve eski kodda GECMEZDI.
 */

/**
 * GECIKME, HANGI DALDAN GELIRSE GELSIN -- ve daraltma her cagri yerinde
 * GORUNUR. Tip `blocksBehind`i yalnizca olculmus dalda tasir; testler de o
 * kurala uyar, cunku bir test yardimcisi kurali gevsetirse kural kalmaz.
 */
function lagOf(at: { head: HeadObservation } | null): bigint | null {
  if (at === null) return null
  return at.head.measured ? at.head.blocksBehind : at.head.lastKnownBlocksBehind
}

/** Gozlenen bas, olculmus olsun olmasin. */
function lagSourceOf(at: { head: HeadObservation } | null): bigint | null {
  return at === null ? null : at.head.headBlock
}

/** `sync_state`in ham hali -- iki damganin AYRI hareket ettigini olcmek icin. */
async function raw(): Promise<{
  head_block: string | null
  updated_at: Date
  head_observed_at: Date
}> {
  const { rows } = await pool.query<{
    head_block: string | null
    updated_at: Date
    head_observed_at: Date
  }>('SELECT head_block::text, updated_at, head_observed_at FROM sync_state WHERE id = 1')
  return rows[0]!
}

describe('indexer tazeligi', () => {
  beforeEach(async () => {
    await resetSchema()
    await seed()
  })

  it('hic kosmamis bir indexer BAYATTIR (bilinmiyor, "taze" degil)', async () => {
    const status = await getIndexerStatus(pool)
    expect(status.stale).toBe(true)
    if (!status.stale) throw new Error('unreachable')
    expect(status.why).toBe('never-ran')
    expect(status.at).toBeNull()
  })

  it('yeni ilerlemis VE basa yetismis bir imlec TAZEDIR', async () => {
    await setCursor(pool, 54_661_437n, hashFor(54_661_437n), 54_661_437n)
    const status = await getIndexerStatus(pool)
    expect(status.stale).toBe(false)
    if (status.stale) throw new Error('unreachable')
    expect(status.at.lastBlock).toBe(54_661_437n)
    expect(status.at.head.blocksBehind).toBe(0n)
    expect(status.at.head.observedSecondsAgo).toBeLessThan(5)
    expect(status.at.stalenessSeconds).toBeLessThan(5)
  })

  it('esigi asan bir imlec BAYATTIR ve olcum SUNUCU saatindendir', async () => {
    await setCursor(pool, 54_661_437n, hashFor(54_661_437n), 54_661_437n)
    // Zamani veritabaninda geri al -- cagiranin saatini degil.
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '10 minutes'")
    const status = await getIndexerStatus(pool)
    expect(status.stale).toBe(true)
    if (!status.stale) throw new Error('unreachable')
    expect(status.why).toBe('writes-stalled')
    expect(status.at?.stalenessSeconds).toBeGreaterThan(590)
    // Esik parametreliktir: 20 dakika esikte ayni satir TAZE sayilir.
    expect((await getIndexerStatus(pool, 1_200)).stale).toBe(false)
    expect(DEFAULT_STALE_AFTER_SECONDS).toBe(30)
  })

  /**
   * B2-a. SANIYELER ONCE YAZDI, YARIM MILYON BLOK GERIDE.
   *
   * Bu satir CANLI kosuda uretildi: `runOnce` bir aralik isledi (`updated_at`
   * = simdi), imlec 54.671.436'da kaldi, zincirin basi 55.438.940'taydi.
   * Surec ekseni bunu "taze" gorur ve GORMEYE DEVAM ETMELIDIR -- yakalayan sey
   * ikinci eksendir.
   */
  it('CANLI AMA GERIDE bir indexer BAYATTIR -- yazma tazeligi onu kurtarmaz', async () => {
    await setCursor(pool, 54_671_436n, hashFor(54_671_436n), 55_438_940n)
    const status = await getIndexerStatus(pool)

    expect(status.stale).toBe(true)
    if (!status.stale) throw new Error('unreachable')
    expect(status.why).toBe('behind-head')
    // Surec ekseni TAZE der -- eski sozlesmenin verdigi cevap tam da buydu.
    expect(status.at?.stalenessSeconds).toBeLessThan(5)
    expect(lagOf(status.at)).toBe(767_504n)
  })

  /**
   * C1. IKI OLGU BIRDEN DOGRUYSA IKISI DE SOYLENIR.
   *
   * Eski hal bir `if` zinciriydi ve ilk dal ikincisini yutuyordu: yazma
   * bayatligi kazandigi anda `blocksBehind` cumleden dusuyordu. Olculdu: 25
   * cizimin 25'i "durmus olabilir" dedi, 727.334 bloklu gecikme hicbirinde
   * gorunmedi.
   */
  it('YAZMIYOR VE GERIDE ise sebep ikisini birden adlandirir', async () => {
    await setCursor(pool, 54_671_436n, hashFor(54_671_436n), 55_438_940n)
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '10 minutes'")
    const status = await getIndexerStatus(pool)
    expect(status.stale).toBe(true)
    if (!status.stale) throw new Error('unreachable')
    expect(status.why).toBe('stopped-and-behind')
    // IKI OLGU DA ELDE, ve ikisi de kullanilabilir.
    expect(status.at?.stalenessSeconds).toBeGreaterThan(590)
    expect(lagOf(status.at)).toBe(767_504n)
  })

  it('YAZMIYOR ama GERIDE DEGILSE sebep yalnizca writes-stalled', async () => {
    await setCursor(pool, 54_671_436n, hashFor(54_671_436n), 54_671_436n)
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '10 minutes'")
    const status = await getIndexerStatus(pool)
    if (!status.stale) throw new Error('unreachable')
    expect(status.why).toBe('writes-stalled')
    expect(lagOf(status.at)).toBe(0n)
  })

  /**
   * `noteAlive` -- GERI CEKILEN INDEXER'IN SESI.
   *
   * Imlece de basa da DOKUNMAZ: bir geri cekilme sirasinda ilerleme iddia
   * etmek, duzeltilen yalanin yerine baskasini koymak olurdu.
   */
  it('noteAlive yalnizca canliligi tazeler; imlec, bas ve sebep aynen kalir', async () => {
    await setCursor(pool, 54_671_436n, hashFor(54_671_436n), 55_438_940n)
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '10 minutes'")
    expect((await getIndexerStatus(pool)).stale).toBe(true)
    expect(((await getIndexerStatus(pool)) as { why?: string }).why).toBe('stopped-and-behind')

    expect(await noteAlive(pool)).toBe(1)

    const after = await getIndexerStatus(pool)
    if (!after.stale) throw new Error('unreachable')
    // Canlilik tazelendi -> "durmus" DUSER, ama veri yasi DUSMEZ.
    expect(after.why).toBe('behind-head')
    expect(after.at?.stalenessSeconds).toBeLessThan(5)
    expect(after.at?.lastBlock).toBe(54_671_436n)
    expect(after.at?.head.headBlock).toBe(55_438_940n)
    expect(lagOf(after.at)).toBe(767_504n)
  })

  /**
   * ============ N1: DONMUS BIR GOZLEM TAZE OKUNAMAZ ============
   *
   * Basa yetismis bir indexer merdivene girdiginde `noteAlive` `updated_at`i
   * tazeler ama basa BAKAMAZ. Eski hal iki ekseni de "saglikli" goruyordu --
   * biri gercekten taze oldugu icin, oteki DONDUGU icin -- ve sayfa TAZE
   * dalini seciyordu. Olculdu: 11/11 cizim uyarisiz, gercek gecikme 0 -> 120.
   */
  it('CANLI ama basa BAKAMAYAN bir indexer TAZE DEGILDIR (gecikme olculemez)', async () => {
    await setCursor(pool, 1_000n, hashFor(1_000n), 1_000n)
    // Merdiven: canlilik tazelenmeye devam ediyor, gozlem donuyor.
    await pool.query("UPDATE sync_state SET head_observed_at = now() - interval '5 minutes'")
    expect(await noteAlive(pool)).toBe(1)

    const status = await getIndexerStatus(pool)
    expect(status.stale).toBe(true)
    if (!status.stale) throw new Error('unreachable')
    expect(status.why).toBe('head-stale')
    // Surec ekseni saglikli -- ve OYLE KALMALI, cunku surec gercekten canli.
    expect(status.at?.stalenessSeconds).toBeLessThan(5)
    // Ve `blocksBehind` OKUNAMAZ: olculmemis dalda o alan YOKTUR.
    expect(status.at?.head.measured).toBe(false)
    expect(lagOf(status.at)).toBe(0n) // son BILINEN, bir alt sinir
  })

  /**
   * BU TESTIN VARLIK SEBEBI: N1 iki sutunun AYRISMASIYDI. Ayrisamayacaklarini
   * iddia eden sey artik bir yorum degil, bir kapi.
   */
  it('head_block ile head_observed_at BIRLIKTE yazilir; noteAlive IKISINE DE dokunmaz', async () => {
    await setCursor(pool, 1_000n, hashFor(1_000n), 1_100n)
    const before = await raw()
    await new Promise((done) => setTimeout(done, 25))

    await noteAlive(pool)
    const afterAlive = await raw()
    // Canlilik ILERLEDI...
    expect(afterAlive.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime())
    // ...gozlem ve bas AYNEN durdu.
    expect(afterAlive.head_observed_at.getTime()).toBe(before.head_observed_at.getTime())
    expect(afterAlive.head_block).toBe(before.head_block)

    // `noteHead` ikisini BIRLIKTE tasir.
    await noteHead(pool, 1_200n)
    const afterHead = await raw()
    expect(afterHead.head_block).toBe('1200')
    expect(afterHead.head_observed_at.getTime()).toBeGreaterThan(before.head_observed_at.getTime())
  })

  it('gozlem esigi parametriktir ve 30 saniye varsayilanini pinler', async () => {
    expect(DEFAULT_HEAD_STALE_AFTER_SECONDS).toBe(30)
    await setCursor(pool, 1_000n, hashFor(1_000n), 1_000n)
    await pool.query("UPDATE sync_state SET head_observed_at = now() - interval '45 seconds'")
    expect((await getIndexerStatus(pool)).stale).toBe(true)
    // Genis bir gozlem esiginde ayni satir yine TAZE.
    expect((await getIndexerStatus(pool, { headStaleAfterSeconds: 120 })).stale).toBe(false)
  })

  it('esik BLOK cinsinden de parametriktir ve 90 varsayilani ~30 saniyedir', async () => {
    expect(DEFAULT_MAX_BLOCKS_BEHIND).toBe(90n)
    // 90 blok TAM ESIKTE: `>` ile karsilastirilir, yani hala taze.
    await setCursor(pool, 1_000n, hashFor(1_000n), 1_090n)
    expect((await getIndexerStatus(pool)).stale).toBe(false)
    // 91 blok bayat.
    await setCursor(pool, 1_001n, hashFor(1_001n), 1_092n)
    expect((await getIndexerStatus(pool)).stale).toBe(true)
    // ...ve genis bir esik ayni satiri yine taze yapar.
    expect((await getIndexerStatus(pool, { maxBlocksBehind: 1_000n })).stale).toBe(false)
  })

  /**
   * BASI HIC YAZILMAMIS BIR SATIR TAZE SAYILAMAZ.
   *
   * Bu, migration 010'dan onceki bir satirin (ya da bu sutunu yazmayan eski
   * bir indexer'in) sekli. "Bilinmiyor"u "taze"ye yuvarlamak, duzeltilen
   * arizanin sessiz halini geri getirirdi -- ve tip duzeyinde de imkansizdir:
   * `stale: false` dali `blocksBehind: bigint` ISTER.
   */
  it('head_block NULL ise TAZE DEGILDIR, sebebi head-unknown', async () => {
    await setCursor(pool, 54_661_437n, hashFor(54_661_437n), 54_661_437n)
    await pool.query('UPDATE sync_state SET head_block = NULL')
    const status = await getIndexerStatus(pool)
    expect(status.stale).toBe(true)
    if (!status.stale) throw new Error('unreachable')
    expect(status.why).toBe('head-unknown')
    expect(lagOf(status.at)).toBeNull()
  })

  /** `noteHead` imleci ILERLETMEZ ama yasi ve canliligi tazeler. */
  it('noteHead imleci degistirmeden basi ve updated_at i tasir', async () => {
    await setCursor(pool, 1_000n, hashFor(1_000n), 1_000n)
    await pool.query("UPDATE sync_state SET updated_at = now() - interval '10 minutes'")
    expect((await getIndexerStatus(pool)).stale).toBe(true)

    expect(await noteHead(pool, 1_050n)).toBe(1)
    const status = await getIndexerStatus(pool)
    expect(status.stale).toBe(false)
    if (status.stale) throw new Error('unreachable')
    expect(status.at.lastBlock).toBe(1_000n)
    expect(status.at.head.blocksBehind).toBe(50n)

    // Bas GERIYE gitmez.
    await noteHead(pool, 1_020n)
    expect(lagSourceOf((await getIndexerStatus(pool)).at)).toBe(1_050n)
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
    expect(one.indexer.at?.lastBlock).toBe(list.indexer.at?.lastBlock)
  })
})
