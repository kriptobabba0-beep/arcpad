import type { Address } from './hex'
import { lower, lowerHash32, pgSafeText } from './hex'
import type { Pool, PoolClient, Queryable } from './pool'
import { withTransaction } from './pool'

/**
 * TAM OLARAK BIR KEZ YAZAN uygulayici.
 *
 * NEDEN BU PAKETTE: "ayni araligi iki kez oynatmak ikinci seferde hicbir sey
 * yapmaz" bir SEMA ozelligi degil, (sema + yazici) ciftinin ozelligidir.
 * Yazici olmadan bu ozellik ancak IDDIA edilebilirdi -- birincil anahtar
 * hakkinda akil yurutmek yoluyla -- ve bu projenin butun ciddi kusurlari akil
 * yurutmeyle degil CALISTIRMAYLA bulundu. Burasi, iddianin calistirilabildigi
 * en dar yer.
 *
 * NE YAPAR, NE YAPMAZ -- BOSLUK ISIMLENDIRILIYOR ki "hicbir seyin egzersiz
 * etmedigi kod yolu" arizasi bir surpriz olarak degil bir kayit olarak dursun:
 *   YAPAR   launches, creator_history, curve_state, trades, token_transfers,
 *           holders, fee_events, fee_balances, sync_state,
 *           token_stats'in {volume_total_wei, trade_count, buy_count,
 *           last_trade_seq/at, last_buy_seq/at, holder_count} sutunlari.
 *   YAPMAZ  token_stats.{market_cap_wei, ath_market_cap_wei} (Task 9 fiyat
 *           turetmesini getirir), token_stats.volume_24h_wei (PENCERELI, Task
 *           11'in surgu adimi), rejected_launches (Task 6'nin provenance
 *           dogrulamasi).
 *
 * IDEMPOTENCY MEKANIGI TEK BIR KALIPTIR ve her olayda ayni: yazim, DEFTER
 * TABLOSUNA (`trades`, `token_transfers`, `fee_events`, `launches`) bir satirin
 * GERCEKTEN eklenmis olmasina bagli bir CTE'dir. `ON CONFLICT DO NOTHING`
 * hicbir sey dondurmedigi anda ona bagli butun artimli guncellemeler de bos
 * kumeye uygulanir. Artimli guncellemeyi birincil anahtarin "korudugunu"
 * varsaymak -- ki en yaygin hata budur -- YANLIS olurdu: `holders.balance_tok`
 * bir DELTA'dir ve ikinci kez uygulanmasini engelleyen tek sey bu bagimliliktir.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface LogRef {
  eventSeq: bigint
  blockNumber: bigint
  logIndex: number
  txHash: string
  blockTime: Date
}

export interface LaunchEvent extends LogRef {
  kind: 'launch'
  token: Address
  curve: Address
  creator: Address
  name: string
  symbol: string
  uri: string
  /**
   * ZINCIRDEKI HAM BAYTLAR, onaltilik. ZORUNLUDUR ve `name`'den TURETILMEZ.
   *
   * Istege bagli yapip yoklugunda `toHexBytes(name)`e dusmek, tam olarak bu
   * projenin "yazilmamis bir gerekce yuzunden gecen test" dedigi seyi
   * uretirdi: cagiran, cozulmus (ve belki coktan kayipli) dizgeyi verir,
   * fonksiyon sessizce onu HAM baytmis gibi saklar, ve canonicity dogrulamasi
   * gorunuste calisirken aslinda yanlis girdiyle calisir. Zorunlu tutmak
   * kararı cagiranin -- Task 5/8'in, logun COZULMEMIS `data` alanini
   * dilimleyerek -- vermesini SART kosar.
   */
  nameHex: string
  symbolHex: string
  uriHex: string
  salt: string
  /** Curve'un acilis rezervleri; `Launched` tasimaz, `deployment` profilinden gelir. */
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
}

export interface TradeEvent extends LogRef {
  kind: 'trade'
  token: Address
  curve: Address
  trader: Address
  isBuy: boolean
  tokenAmountTok: bigint
  quoteAmountWei: bigint
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
}

export interface CompletedEvent extends LogRef {
  kind: 'completed'
  token: Address
  realQuoteReservesWei: bigint
  poolSeedSupplyTok: bigint
}

export interface TransferEvent extends LogRef {
  kind: 'transfer'
  token: Address
  from: Address
  to: Address
  amountTok: bigint
}

export interface FeeLedgerEvent extends LogRef {
  kind: 'fee'
  feeKind: 'deposit' | 'claim'
  recipient: Address
  /** `Deposited.from` (yatiran curve). `Claimed`'da yoktur. */
  from: Address | null
  amountWei: bigint
}

export type IngestEvent = LaunchEvent | TradeEvent | CompletedEvent | TransferEvent | FeeLedgerEvent

export interface ReplayResult {
  launches: number
  trades: number
  completed: number
  transfers: number
  fees: number
  cursorMoved: number
  /** Yukaridakilerin toplami. Ikinci oynatimda SIFIR olmasi gereken sayi. */
  total: number
}

async function affected(db: Queryable, sql: string, values: readonly unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql, values)
  return rows[0]?.n ?? 0
}

export async function applyLaunch(db: Queryable, e: LaunchEvent): Promise<number> {
  return affected(
    db,
    `WITH ins AS (
       INSERT INTO launches
         (token, curve, launch_creator, name, symbol, uri,
          name_hex, symbol_hex, uri_hex, salt, created_seq, created_at, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$15,$16,$17,$7,$8,$9,$10)
       ON CONFLICT (token) DO NOTHING
       RETURNING token, curve, launch_creator, created_seq, created_at
     ),
     ch AS (
       INSERT INTO creator_history (token, from_seq, creator)
       SELECT token, created_seq, launch_creator FROM ins
       RETURNING 1
     ),
     cs AS (
       INSERT INTO curve_state
         (curve, token, virtual_token_reserves_tok, virtual_quote_reserves_wei,
          real_token_reserves_tok, real_quote_reserves_wei, last_seq)
       SELECT curve, token, $11, $12, $13, $14, created_seq FROM ins
       RETURNING 1
     ),
     st AS (
       INSERT INTO token_stats (token, market_cap_wei, ath_market_cap_wei, created_seq, created_at)
       SELECT token, 0, 0, created_seq, created_at FROM ins
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
    [
      lower(e.token),
      lower(e.curve),
      lower(e.creator),
      pgSafeText(e.name),
      pgSafeText(e.symbol),
      pgSafeText(e.uri),
      lowerHash32(e.salt),
      e.eventSeq.toString(),
      e.blockTime,
      lowerHash32(e.txHash),
      e.virtualTokenReservesTok.toString(),
      e.virtualQuoteReservesWei.toString(),
      e.realTokenReservesTok.toString(),
      e.realQuoteReservesWei.toString(),
      // $15..$17 -- HAM baytlar. `pgSafeText`'ten GECMEZLER: temizlemek tam
      // olarak kaybetmemek icin sakladigimiz seyi kaybetmek olurdu.
      e.nameHex,
      e.symbolHex,
      e.uriHex,
    ],
  )
}

export async function applyTrade(db: Queryable, e: TradeEvent): Promise<number> {
  return affected(
    db,
    `WITH ins AS (
       INSERT INTO trades
         (event_seq, block_number, log_index, tx_hash, block_time, token, curve, trader, is_buy,
          token_amount_tok, quote_amount_wei, protocol_fee_wei, creator_fee_wei,
          virtual_token_reserves_tok, virtual_quote_reserves_wei,
          real_token_reserves_tok, real_quote_reserves_wei)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (event_seq) DO NOTHING
       RETURNING *
     ),
     cs AS (
       -- MUTLAK yazim. Iki muhafiz birlikte calisir: \`ins\` (aynisi zaten
       -- yazilmis mi) ve \`event_seq > last_seq\` (bu, gorulen en yeni olay mi).
       -- Ikincisi TEK BASINA gereklidir: hic gorulmemis ama ESKI bir olay
       -- \`ins\`ten gecer ve muhafiz olmasa YENI durumu ezerdi.
       UPDATE curve_state c SET
         virtual_token_reserves_tok = i.virtual_token_reserves_tok,
         virtual_quote_reserves_wei = i.virtual_quote_reserves_wei,
         real_token_reserves_tok    = i.real_token_reserves_tok,
         real_quote_reserves_wei    = i.real_quote_reserves_wei,
         last_seq                   = i.event_seq
       FROM ins i
       WHERE c.curve = i.curve AND i.event_seq > c.last_seq
       RETURNING 1
     ),
     st AS (
       -- ARTIMLI toplamlar. Bunlar degismeli (commutative) oldugu icin
       -- \`event_seq > last_seq\` muhafizina TABI DEGILDIR: gec gelen eski bir
       -- islem hacme ve sayaclara dogru sekilde katilir. Yalnizca "en son"
       -- alanlari sira ile korunur.
       UPDATE token_stats s SET
         volume_total_wei = s.volume_total_wei + i.quote_amount_wei,
         trade_count      = s.trade_count + 1,
         buy_count        = s.buy_count + (CASE WHEN i.is_buy THEN 1 ELSE 0 END),
         last_trade_seq   = GREATEST(coalesce(s.last_trade_seq, 0), i.event_seq),
         last_trade_at    = CASE WHEN i.event_seq > coalesce(s.last_trade_seq, 0)
                                 THEN i.block_time ELSE s.last_trade_at END,
         last_buy_seq     = CASE WHEN i.is_buy
                                 THEN GREATEST(coalesce(s.last_buy_seq, 0), i.event_seq)
                                 ELSE s.last_buy_seq END,
         last_buy_at      = CASE WHEN i.is_buy AND i.event_seq > coalesce(s.last_buy_seq, 0)
                                 THEN i.block_time ELSE s.last_buy_at END
       FROM ins i WHERE s.token = i.token
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
    [
      e.eventSeq.toString(),
      e.blockNumber.toString(),
      e.logIndex,
      lowerHash32(e.txHash),
      e.blockTime,
      lower(e.token),
      lower(e.curve),
      lower(e.trader),
      e.isBuy,
      e.tokenAmountTok.toString(),
      e.quoteAmountWei.toString(),
      e.protocolFeeWei.toString(),
      e.creatorFeeWei.toString(),
      e.virtualTokenReservesTok.toString(),
      e.virtualQuoteReservesWei.toString(),
      e.realTokenReservesTok.toString(),
      e.realQuoteReservesWei.toString(),
    ],
  )
}

export async function applyCompleted(db: Queryable, e: CompletedEvent): Promise<number> {
  // `NOT complete` muhafizi bunu idempotent yapar: ikinci oynatimda WHERE
  // hicbir satir secmez. Bir defter tablosu yoktur cunku `Completed` ayri bir
  // olgu tasimaz -- kendisi bir durum gecisidir.
  const { rowCount } = await db.query(
    `UPDATE curve_state SET
       complete                = true,
       completed_seq           = $2,
       pool_seed_supply_tok    = $3,
       real_quote_reserves_wei = $4,
       real_token_reserves_tok = 0,
       last_seq                = GREATEST(last_seq, $2)
     WHERE token = $1 AND NOT complete`,
    [
      lower(e.token),
      e.eventSeq.toString(),
      e.poolSeedSupplyTok.toString(),
      e.realQuoteReservesWei.toString(),
    ],
  )
  return rowCount ?? 0
}

/**
 * DELTA UYGULAMA UC ADIMDIR VE IKI IFADEYE BOLUNMEK ZORUNDADIR. Gerekce
 * OLCULDU, tahmin edilmedi:
 *
 *   INSERT INTO holders (...) VALUES (..., -1000000000000000000000000, ...)
 *   ON CONFLICT (token, holder) DO UPDATE SET balance_tok = holders.balance_tok + EXCLUDED.balance_tok
 *   -->  new row for relation "holders" violates check constraint "holders_balance_tok_check"
 *
 * Postgres CHECK kisitlarini ONERILEN satir uzerinde, catisma cozulmeden ONCE
 * degerlendirir. Yani `EXCLUDED.balance_tok` bir DELTA oldugunda ve delta
 * negatifse (her satis, her gonderim), kisit catismasiz satirmis gibi patlar --
 * hesaplanan sonuc pozitif olsa bile. Bu okuyarak gorulmez; ilk kosuda 9 test
 * birden bu yuzden kirmizi oldu.
 *
 * Cozum: once satiri SIFIR bakiyeyle tohumla (ON CONFLICT DO NOTHING, hicbir
 * zaman negatif bir onerilen satir yok), sonra AYRI bir UPDATE ile deltayi
 * uygula. UPDATE'te kisit GERCEK sonuc uzerinde degerlendirilir; gercekten
 * negatife dusen bir bakiye hala GURULTULU patlar ve patlamasi gerekir.
 */
export async function applyTransfer(db: Queryable, e: TransferEvent): Promise<number> {
  interface Row {
    n: number
    token: string | null
    holder: string | null
    delta: string | null
    seq: string | null
  }
  const { rows } = await db.query<Row>(
    `WITH ins AS (
       INSERT INTO token_transfers
         (event_seq, block_number, log_index, tx_hash, block_time, token, from_addr, to_addr, amount_tok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (event_seq) DO NOTHING
       RETURNING event_seq, token, from_addr, to_addr, amount_tok
     ),
     deltas AS (
       SELECT token, from_addr AS holder, -amount_tok AS delta, event_seq FROM ins WHERE from_addr <> $10
       UNION ALL
       SELECT token, to_addr   AS holder,  amount_tok AS delta, event_seq FROM ins WHERE to_addr   <> $10
     ),
     agg AS (
       -- KENDINE TRANSFER (from = to) tek bir upsert icinde AYNI satiri iki kez
       -- etkilerdi ve Postgres bunu hata sayar. Toplayarak delta sifira iner ve
       -- dogru cevap kendiliginden cikar.
       SELECT token, holder, sum(delta) AS delta, max(event_seq) AS seq
       FROM deltas GROUP BY token, holder
     ),
     seed AS (
       -- Veri degistiren bir CTE, cikti okunmasa bile HER ZAMAN calisir.
       INSERT INTO holders (token, holder, balance_tok, last_seq)
       SELECT token, holder, 0, seq FROM agg
       ON CONFLICT (token, holder) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*)::int FROM ins) AS n,
            a.token, a.holder, a.delta::text AS delta, a.seq::text AS seq
     FROM (SELECT 1) o LEFT JOIN agg a ON true`,
    [
      e.eventSeq.toString(),
      e.blockNumber.toString(),
      e.logIndex,
      lowerHash32(e.txHash),
      e.blockTime,
      lower(e.token),
      lower(e.from),
      lower(e.to),
      e.amountTok.toString(),
      ZERO_ADDRESS,
    ],
  )

  const n = rows[0]?.n ?? 0
  if (n === 0) return 0

  const applied = rows.filter((r) => r.holder !== null)
  if (applied.length > 0) {
    await db.query(
      `UPDATE holders h SET
         balance_tok = h.balance_tok + d.delta,
         last_seq    = GREATEST(h.last_seq, d.seq)
       FROM unnest($1::text[], $2::text[], $3::numeric[], $4::bigint[])
            AS d(token, holder, delta, seq)
       WHERE h.token = d.token AND h.holder = d.holder`,
      [
        applied.map((r) => r.token),
        applied.map((r) => r.holder),
        applied.map((r) => r.delta),
        applied.map((r) => r.seq),
      ],
    )
  }

  // AYRI BIR IFADE OLMAK ZORUNDA: veri degistiren bir CTE'nin etkisi AYNI
  // ifadedeki baska bir CTE'ye GORUNMEZ (hepsi ayni anlik goruntuyu okur), yani
  // yukaridaki yazimlarin sonucunu orada saymak eski sayiyi verirdi. `n === 0`
  // iken hic calismaz, boylece ikinci oynatim TAM OLARAK sifir yazim yapar.
  await db.query(
    `UPDATE token_stats s
       SET holder_count = (SELECT count(*) FROM holders h
                           WHERE h.token = s.token AND h.balance_tok > 0)
     WHERE s.token = $1`,
    [lower(e.token)],
  )
  return n
}

/**
 * `fee_balances` de artimlidir ve `applyTransfer` ile AYNI tuzaga duser: bir
 * `claim`in onerilen satiri `claimable_wei = -amount` tasir ve
 * `CHECK (claimable_wei >= 0)` catisma cozulmeden patlar. Ayni cozum: once
 * sifirlarla tohumla, sonra ayri bir UPDATE ile uygula.
 */
export async function applyFeeEvent(db: Queryable, e: FeeLedgerEvent): Promise<number> {
  const n = await affected(
    db,
    `WITH ins AS (
       INSERT INTO fee_events
         (event_seq, block_number, log_index, tx_hash, block_time, kind, recipient, from_addr, amount_wei)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (event_seq) DO NOTHING
       RETURNING kind, recipient, amount_wei, event_seq
     ),
     seed AS (
       INSERT INTO fee_balances
         (recipient, claimable_wei, deposited_total_wei, claimed_total_wei, last_seq)
       SELECT recipient, 0, 0, 0, event_seq FROM ins
       ON CONFLICT (recipient) DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
    [
      e.eventSeq.toString(),
      e.blockNumber.toString(),
      e.logIndex,
      lowerHash32(e.txHash),
      e.blockTime,
      e.feeKind,
      lower(e.recipient),
      e.from === null ? null : lower(e.from),
      e.amountWei.toString(),
    ],
  )
  if (n === 0) return 0

  await db.query(
    `UPDATE fee_balances SET
       claimable_wei       = claimable_wei + CASE WHEN $2 = 'deposit' THEN $3::numeric ELSE -$3::numeric END,
       deposited_total_wei = deposited_total_wei + CASE WHEN $2 = 'deposit' THEN $3::numeric ELSE 0 END,
       claimed_total_wei   = claimed_total_wei   + CASE WHEN $2 = 'claim'   THEN $3::numeric ELSE 0 END,
       last_seq            = GREATEST(last_seq, $4::bigint)
     WHERE recipient = $1`,
    [lower(e.recipient), e.feeKind, e.amountWei.toString(), e.eventSeq.toString()],
  )
  return n
}

/**
 * Imleci ILERI dogru tasir.
 *
 * `WHERE EXCLUDED.last_block > sync_state.last_block` iki isi birden yapar:
 * ayni araligi tekrar oynatmak HICBIR SATIR YAZMAZ (yoksa `updated_at`
 * degisir ve "ikinci gecis bir no-op" iddiasi dokum esitligiyle
 * ISPATLANAMAZDI), ve geriye dusmus bir head imleci geri cekemez.
 */
export async function setCursor(db: Queryable, lastBlock: bigint): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO sync_state (id, last_block) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()
     WHERE EXCLUDED.last_block > sync_state.last_block`,
    [lastBlock.toString()],
  )
  return rowCount ?? 0
}

export async function applyEvent(db: Queryable, e: IngestEvent): Promise<number> {
  switch (e.kind) {
    case 'launch':
      return applyLaunch(db, e)
    case 'trade':
      return applyTrade(db, e)
    case 'completed':
      return applyCompleted(db, e)
    case 'transfer':
      return applyTransfer(db, e)
    case 'fee':
      return applyFeeEvent(db, e)
  }
}

/**
 * Bir blok araliginin olaylarini TEK BIR ISLEMDE uygular ve imleci `to`ya
 * tasir. Gercek ingest dongusunun sekli budur: aralik ya butunuyle girer ya da
 * hic girmez, ve imlec verinin yanindan asla ayrilmaz.
 */
export async function replayRange(
  pool: Pool,
  events: readonly IngestEvent[],
  to: bigint,
): Promise<ReplayResult> {
  return withTransaction(pool, async (tx: PoolClient) => {
    const r: ReplayResult = {
      launches: 0,
      trades: 0,
      completed: 0,
      transfers: 0,
      fees: 0,
      cursorMoved: 0,
      total: 0,
    }
    for (const e of events) {
      const n = await applyEvent(tx, e)
      if (e.kind === 'launch') r.launches += n
      else if (e.kind === 'trade') r.trades += n
      else if (e.kind === 'completed') r.completed += n
      else if (e.kind === 'transfer') r.transfers += n
      else r.fees += n
    }
    r.cursorMoved = await setCursor(tx, to)
    r.total = r.launches + r.trades + r.completed + r.transfers + r.fees + r.cursorMoved
    return r
  })
}
