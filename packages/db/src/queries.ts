import type { Address } from './hex'
import { lower } from './hex'
import type { Queryable } from './pool'

/**
 * OKUMA MODELI.
 *
 * Iki kural bu dosyanin sekline hakim:
 *
 * 1. SIRALAMA ASLA BIR ZAMAN KOLONU UZERINDE DEGILDIR. Arc'ta ardisik
 *    bloklarin ~%49'u AYNI timestamp'i tasir (olculdu: 553 ciftin 271'i; sifir
 *    gerileme), yani `ORDER BY last_buy_at DESC` siralamanin yarisini
 *    TANIMSIZ birakir. Postgres esit anahtarlar icin sira garanti etmez ve
 *    plan degistiginde sira da degisir; kararsiz sira ise keyset sayfalamada
 *    SATIR TEKRARLATIR VE ATLATIR -- kullaniciya gorunen, teshisi zor bir
 *    hata ("Explore'da ayni token iki kez cikiyor"). `event_seq` zincirin
 *    kendi tam sirasidir. `ordering.test.ts` bu kurali KAYNAK METNI OKUYARAK
 *    uygular, yani bir yorum degil bir kapidir.
 *
 * 2. HER CANLI SAYI, KENDI TAZELIGIYLE BIRLIKTE DONER. Bunun gerekcesi
 *    yapisaldir: bir okuma modeli "satirlari" dondurup tazeligi AYRI bir
 *    fonksiyona birakirsa, tuketici onu cagirmayi UNUTABILIR ve bayat sayilar
 *    canliymis gibi gosterilir. `listTokens` ve `getTokenOverview` bu yuzden
 *    `{ rows, indexer }` dondurur -- sayilari elde etmenin, tazeligi de elde
 *    etmeden BASKA bir yolu yoktur.
 */

/**
 * INDEXER'IN KENDI TAZELIGI.
 *
 * `stalenessSeconds` SUNUCU TARAFINDA hesaplanir (`now() - updated_at`),
 * cagiranin saatiyle degil: web sunucusunun saati veritabanininkinden saparsa
 * "indexer geride" uyarisi saat farkini rapor ederdi.
 *
 * `updatedAt` her ILERLEYEN aralikta tazelenir -- BOS bir aralik da imleci
 * ilerletir, yani bu alanin bayatlamasi "zincirde bir sey olmadi" degil
 * "indexer kosmuyor ya da takildi" demektir.
 */
export interface IndexerStatus {
  /** Islenmis son blok. `null` ise indexer hic kosmadi. */
  lastBlock: bigint | null
  lastBlockHash: string | null
  updatedAt: Date | null
  /** `now() - updated_at`, saniye. Sunucu saatinden. */
  stalenessSeconds: number | null
  /** `stalenessSeconds > staleAfterSeconds`. Hic kosmadiysa `true`. */
  stale: boolean
}

/**
 * Varsayilan bayatlik esigi.
 *
 * Arc'ta blok suresi ~350ms ve dongu her turda imleci ilerletir (bos aralikta
 * bile), yani saglikli bir indexer'da `updated_at` saniyeler icinde tazelenir.
 * 30 saniye, gecici bir RPC yavaslamasini alarm yapmayacak kadar genis, bir
 * duraklamayi kullanicidan gizlemeyecek kadar dardir.
 */
export const DEFAULT_STALE_AFTER_SECONDS = 30

export async function getIndexerStatus(
  db: Queryable,
  staleAfterSeconds: number = DEFAULT_STALE_AFTER_SECONDS,
): Promise<IndexerStatus> {
  const { rows } = await db.query<{
    last_block: string
    last_block_hash: string
    updated_at: Date
    staleness_seconds: string
  }>(
    `SELECT last_block::text AS last_block, last_block_hash, updated_at,
            EXTRACT(EPOCH FROM (now() - updated_at))::text AS staleness_seconds
       FROM sync_state WHERE id = 1`,
  )
  const row = rows[0]
  if (row === undefined) {
    // HIC KOSMADI. `stale: true` -- "bilinmiyor"u "taze"ye yuvarlamak, bos bir
    // veritabanini canli gostermek olurdu.
    return {
      lastBlock: null,
      lastBlockHash: null,
      updatedAt: null,
      stalenessSeconds: null,
      stale: true,
    }
  }
  const staleness = Number(row.staleness_seconds)
  return {
    lastBlock: BigInt(row.last_block),
    lastBlockHash: row.last_block_hash,
    updatedAt: row.updated_at,
    stalenessSeconds: staleness,
    stale: staleness > staleAfterSeconds,
  }
}

/**
 * EXPLORE SIRALAMALARI (spec 7.1).
 *
 * Sabit bir nesnedir ve `sort` parametresi onun ANAHTARLARIYLA sinirlidir:
 * siralama ifadesi hicbir zaman kullanici girdisinden birlestirilmez.
 */
export const SORTS = {
  recentBuys: 'last_buy_seq DESC',
  newest: 'created_seq DESC',
  oldest: 'created_seq ASC',
  marketCap: 'market_cap_wei DESC',
  volume: 'volume_24h_wei DESC',
} as const

export type SortKey = keyof typeof SORTS

/** Keyset sayfalamanin imleci: siralama anahtarinin son degeri. */
export type Cursor = bigint | null

export interface TokenOverview {
  token: string
  curve: string
  name: string
  symbol: string
  uri: string
  launchCreator: string
  feeCreator: string
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
  complete: boolean
  completedSeq: bigint | null
  poolSeedSupplyTok: bigint | null
  marketCapWei: bigint
  priceWeiPerTok: bigint
  progressPpm: number
  graduationRaiseWei: bigint
  holderCount: number
  volumeTotalWei: bigint
  volume24hWei: bigint
  athMarketCapWei: bigint
  tradeCount: number
  buyCount: number
  lastTradeSeq: bigint | null
  lastBuySeq: bigint | null
  lastTradeAt: Date | null
  lastBuyAt: Date | null
  createdSeq: bigint
  createdAt: Date
}

interface OverviewRow {
  token: string
  curve: string
  name: string
  symbol: string
  uri: string
  launch_creator: string
  fee_creator: string
  virtual_token_reserves_tok: string
  virtual_quote_reserves_wei: string
  real_token_reserves_tok: string
  real_quote_reserves_wei: string
  complete: boolean
  completed_seq: string | null
  pool_seed_supply_tok: string | null
  market_cap_wei: string
  price_wei_per_tok: string
  progress_ppm: number
  graduation_raise_wei: string
  holder_count: number
  volume_total_wei: string
  volume_24h_wei: string
  ath_market_cap_wei: string
  trade_count: number
  buy_count: number
  last_trade_seq: string | null
  last_buy_seq: string | null
  last_trade_at: Date | null
  last_buy_at: Date | null
  created_seq: string
  created_at: Date
}

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v))

function toOverview(row: OverviewRow): TokenOverview {
  return {
    token: row.token,
    curve: row.curve,
    name: row.name,
    symbol: row.symbol,
    uri: row.uri,
    launchCreator: row.launch_creator,
    feeCreator: row.fee_creator,
    virtualTokenReservesTok: BigInt(row.virtual_token_reserves_tok),
    virtualQuoteReservesWei: BigInt(row.virtual_quote_reserves_wei),
    realTokenReservesTok: BigInt(row.real_token_reserves_tok),
    realQuoteReservesWei: BigInt(row.real_quote_reserves_wei),
    complete: row.complete,
    completedSeq: big(row.completed_seq),
    poolSeedSupplyTok: big(row.pool_seed_supply_tok),
    marketCapWei: BigInt(row.market_cap_wei),
    priceWeiPerTok: BigInt(row.price_wei_per_tok),
    progressPpm: row.progress_ppm,
    graduationRaiseWei: BigInt(row.graduation_raise_wei),
    holderCount: row.holder_count,
    volumeTotalWei: BigInt(row.volume_total_wei),
    volume24hWei: BigInt(row.volume_24h_wei),
    athMarketCapWei: BigInt(row.ath_market_cap_wei),
    tradeCount: row.trade_count,
    buyCount: row.buy_count,
    lastTradeSeq: big(row.last_trade_seq),
    lastBuySeq: big(row.last_buy_seq),
    lastTradeAt: row.last_trade_at,
    lastBuyAt: row.last_buy_at,
    createdSeq: BigInt(row.created_seq),
    createdAt: row.created_at,
  }
}

/** Canli sayilar HER ZAMAN tazelikleriyle birlikte. */
export interface Fresh<T> {
  rows: T
  indexer: IndexerStatus
}

export interface ListTokensOptions {
  sort?: SortKey
  /** Yas filtresi: yalnizca son `ageDays` gunde acilanlar. PENCERE, siralama degil. */
  ageDays?: number
  cursor?: Cursor
  limit?: number
}

/**
 * EXPLORE listesi, keyset sayfalamayla.
 *
 * `ageDays` bir PENCEREDIR ve `created_at` uzerindedir; siralama yine
 * `created_seq`/`market_cap_wei` gibi bir seq/miktar anahtarindadir. Zamanin
 * pencerede kullanilmasi guvenlidir (esitlik siralamayi degil kumeyi etkiler),
 * SIRALAMADA kullanilmasi degildir.
 */
export async function listTokens(
  db: Queryable,
  options: ListTokensOptions = {},
): Promise<Fresh<TokenOverview[]>> {
  const sort: SortKey = options.sort ?? 'newest'
  const order = SORTS[sort]
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ?? null
  const key = order.split(' ')[0] as string
  const descending = order.endsWith('DESC')

  const where: string[] = []
  const params: unknown[] = []
  if (sort === 'recentBuys') where.push('last_buy_seq IS NOT NULL')
  if (options.ageDays !== undefined) {
    params.push(options.ageDays)
    where.push(`created_at >= now() - ($${params.length}::int * interval '1 day')`)
  }
  if (cursor !== null) {
    params.push(cursor.toString())
    where.push(`${key} ${descending ? '<' : '>'} $${params.length}::numeric`)
  }
  params.push(limit)

  const { rows } = await db.query<OverviewRow>(
    `SELECT * FROM token_overview
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${order} LIMIT $${params.length}`,
    params,
  )
  return { rows: rows.map(toOverview), indexer: await getIndexerStatus(db) }
}

export async function getTokenOverview(
  db: Queryable,
  token: Address,
): Promise<Fresh<TokenOverview | null>> {
  const { rows } = await db.query<OverviewRow>('SELECT * FROM token_overview WHERE token = $1', [
    lower(token),
  ])
  const row = rows[0]
  return {
    rows: row === undefined ? null : toOverview(row),
    indexer: await getIndexerStatus(db),
  }
}

export interface TradeRow {
  eventSeq: bigint
  txHash: string
  blockTime: Date
  trader: string
  isBuy: boolean
  tokenAmountTok: bigint
  quoteAmountWei: bigint
  /**
   * UCRET PARCALARI. AYRI AYRI donerler ve TOPLANMIS bir alan YOKTUR:
   * ucret `feeOn(q,95) + feeOn(q,30)`tir, `feeOn(q,125)` DEGIL, ve fark canli
   * zincirde olculdu (ticaret #1'de bir wei). Toplami burada hesaplayip tek
   * alan olarak donmek, o farki gizleyen bir yol acardi.
   *
   * Tuketici icin ANLAMI: bir alicinin cuzdanindan cikan tutar
   * `quoteAmountWei + protocolFeeWei + creatorFeeWei`, satista ise giren tutar
   * `quoteAmountWei - protocolFeeWei - creatorFeeWei`. Bu hesap ancak parcalar
   * gorunurse yapilabilir.
   */
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  /**
   * ISLEM SONRASI DORT REZERV. `Trade` dordunu de tasir (BondingCurve.sol
   * :133-135) ve `trades` onlari AYNEN saklar, yani her ticaretin ANINDAKI
   * fiyati zincire tekrar sorulmadan turetilebilir:
   *   gerceklesen fiyat = quote/token, o andaki isaret fiyati = vQ/vT.
   * Bunlar olmadan bir fiyat grafigi ancak rezervleri yeniden oynatarak
   * kurulabilirdi.
   */
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
  /** `trader` O ANDAKI ucret creator'i mi. NOKTASAL -- guncel creator'a gore degil. */
  isDev: boolean
}

/**
 * Bir token'in islemleri, EN YENIDEN eskiye.
 *
 * `is_dev` `creator_at(token, event_seq)` ile NOKTASAL hesaplanir. Guncel
 * creator'a duz bir JOIN, bir devirden sonra devirden ONCEKI islemleri yanlis
 * etiketlerdi -- bugun creator degistirilemez oldugu icin fark GORUNMEZ, ve
 * tam da bu yuzden yol bugunden sentetik bir devirle test edilir.
 */
export async function listTrades(
  db: Queryable,
  token: Address,
  options: { cursor?: Cursor; limit?: number } = {},
): Promise<TradeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ?? null
  const { rows } = await db.query<{
    event_seq: string
    tx_hash: string
    block_time: Date
    trader: string
    is_buy: boolean
    token_amount_tok: string
    quote_amount_wei: string
    protocol_fee_wei: string
    creator_fee_wei: string
    virtual_token_reserves_tok: string
    virtual_quote_reserves_wei: string
    real_token_reserves_tok: string
    real_quote_reserves_wei: string
    is_dev: boolean
  }>(
    `SELECT t.event_seq::text AS event_seq, t.tx_hash, t.block_time, t.trader, t.is_buy,
            t.token_amount_tok::text AS token_amount_tok,
            t.quote_amount_wei::text AS quote_amount_wei,
            t.protocol_fee_wei::text AS protocol_fee_wei,
            t.creator_fee_wei::text AS creator_fee_wei,
            t.virtual_token_reserves_tok::text AS virtual_token_reserves_tok,
            t.virtual_quote_reserves_wei::text AS virtual_quote_reserves_wei,
            t.real_token_reserves_tok::text AS real_token_reserves_tok,
            t.real_quote_reserves_wei::text AS real_quote_reserves_wei,
            t.trader = creator_at(t.token, t.event_seq) AS is_dev
       FROM trades t
      WHERE t.token = $1 AND ($2::bigint IS NULL OR t.event_seq < $2)
      ORDER BY t.event_seq DESC LIMIT $3`,
    [lower(token), cursor === null ? null : cursor.toString(), limit],
  )
  return rows.map((r) => ({
    eventSeq: BigInt(r.event_seq),
    txHash: r.tx_hash,
    blockTime: r.block_time,
    trader: r.trader,
    isBuy: r.is_buy,
    tokenAmountTok: BigInt(r.token_amount_tok),
    quoteAmountWei: BigInt(r.quote_amount_wei),
    protocolFeeWei: BigInt(r.protocol_fee_wei),
    creatorFeeWei: BigInt(r.creator_fee_wei),
    virtualTokenReservesTok: BigInt(r.virtual_token_reserves_tok),
    virtualQuoteReservesWei: BigInt(r.virtual_quote_reserves_wei),
    realTokenReservesTok: BigInt(r.real_token_reserves_tok),
    realQuoteReservesWei: BigInt(r.real_quote_reserves_wei),
    isDev: r.is_dev,
  }))
}

export interface HolderRow {
  holder: string
  balanceTok: bigint
}

/**
 * Holder listesi. CURVE HARIC TUTULUR.
 *
 * `LaunchToken` tum arzi constructor'da curve'e basar, yani curve her zaman en
 * buyuk "holder"dir ve listenin basinda otururdu -- hicbir kullanicinin
 * elinde olmayan bir bakiye. `token_stats.holder_count` de ayni sebeple onu
 * saymaz; iki taraf ayni seyi soylemeli.
 */
export async function listHolders(
  db: Queryable,
  token: Address,
  options: { limit?: number } = {},
): Promise<HolderRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const { rows } = await db.query<{ holder: string; balance_tok: string }>(
    `SELECT h.holder, h.balance_tok::text AS balance_tok
       FROM holders h
       JOIN curve_state c ON c.token = h.token
      WHERE h.token = $1 AND h.balance_tok > 0 AND h.holder <> c.curve
      ORDER BY h.balance_tok DESC, h.holder ASC LIMIT $2`,
    [lower(token), limit],
  )
  return rows.map((r) => ({ holder: r.holder, balanceTok: BigInt(r.balance_tok) }))
}

/** "Kim baslatti" -- `launches.launch_creator`, ucret alicisi DEGIL. */
export async function listLaunchesByCreator(
  db: Queryable,
  creator: Address,
  options: { limit?: number } = {},
): Promise<TokenOverview[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const { rows } = await db.query<OverviewRow>(
    `SELECT * FROM token_overview WHERE launch_creator = $1
      ORDER BY created_seq DESC LIMIT $2`,
    [lower(creator), limit],
  )
  return rows.map(toOverview)
}

export interface ClaimableFees {
  recipient: string
  claimableWei: bigint
  depositedTotalWei: bigint
  claimedTotalWei: bigint
}

/**
 * Bir alicinin cekilebilir ucreti.
 *
 * ESCROW'UN BAKIYESINI DONDUREN BIR FONKSIYON YOKTUR ve bu bir eksiklik degil
 * KARARDIR: `FeeEscrow`'un NatSpec'i (kisit 1) escrow bakiyesinin `deposit()`
 * DISINDAN da artabilecegini kaydediyor (`USDC.transfer(escrow, x)` basarili
 * olur, `receive()` hic calismaz) ve o para TALEP EDILEMEZ. Yani bakiye,
 * cekilebilir ucretin UST siniridir; onu "cekilebilir" diye gostermek
 * kullaniciya cekemeyecegi bir rakam gostermektir.
 */
export async function getClaimableFees(
  db: Queryable,
  recipient: Address,
): Promise<ClaimableFees | null> {
  const { rows } = await db.query<{
    recipient: string
    claimable_wei: string
    deposited_total_wei: string
    claimed_total_wei: string
  }>(
    `SELECT recipient, claimable_wei::text AS claimable_wei,
            deposited_total_wei::text AS deposited_total_wei,
            claimed_total_wei::text AS claimed_total_wei
       FROM fee_balances WHERE recipient = $1`,
    [lower(recipient)],
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    recipient: row.recipient,
    claimableWei: BigInt(row.claimable_wei),
    depositedTotalWei: BigInt(row.deposited_total_wei),
    claimedTotalWei: BigInt(row.claimed_total_wei),
  }
}

export interface CreatorEarning {
  token: string
  symbol: string
  earnedWei: bigint
}

/**
 * Creator'in LAUNCH BASINA kazanci.
 *
 * Yalnizca `fee_events.from_addr` sayesinde mumkundur: `Deposited.from`
 * yatiran CURVE'dur ve ucretin hangi launch'tan geldigi baska HICBIR yerde
 * yazili degildir.
 */
export async function listCreatorEarningsByLaunch(
  db: Queryable,
  recipient: Address,
): Promise<CreatorEarning[]> {
  const { rows } = await db.query<{ token: string; symbol: string; earned_wei: string }>(
    `SELECT l.token, l.symbol, sum(f.amount_wei)::text AS earned_wei
       FROM fee_events f
       JOIN curve_state c ON c.curve = f.from_addr
       JOIN launches l ON l.token = c.token
      WHERE f.kind = 'deposit' AND f.recipient = $1
      GROUP BY l.token, l.symbol
      ORDER BY sum(f.amount_wei) DESC, l.token ASC`,
    [lower(recipient)],
  )
  return rows.map((r) => ({
    token: r.token,
    symbol: r.symbol,
    earnedWei: BigInt(r.earned_wei),
  }))
}
