import type { Address } from './hex'
import { lower, lowerHash32, pgSafeText } from './hex'
import type { Pool, PoolClient, Queryable } from './pool'
import { withTransaction } from './pool'
import { assertContinuous } from './reorg'

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

/**
 * MEZUNIYETTEN SONRAKI ISLEM -- AYNI TABLO, `source = 'pool'`.
 *
 * `TradeEvent`in IKIZIDIR ve alan adlari BILEREK aynidir: ikisi de `trades`in
 * AYNI sutunlarina yazar. Ayri bir tip olmasinin sebebi, IKI ALANIN farkli
 * seyler olmasidir ve o fark yazma yolunu degistirir:
 *
 *   `curve`      egri satirinda OLAYIN YAYINCISIDIR; havuz satirinda
 *                token'in MEZUN OLDUGU egridir. Islem ORADA OLMADI, ve bu
 *                yuzden bu yol `curve_state`i GUNCELLEMEZ -- egrinin
 *                rezervleri mezuniyette DONDU ve bir havuz islemi onlari
 *                degistiremez. `applyTrade`in `cs` CTE'sinin burada
 *                OLMAMASI, bu tipin var olma sebebidir.
 *   rezervler    egri satirinda olayin TASIDIGI dort sayidir; havuz satirinda
 *                `Swap`in `sqrtPriceX96`/`liquidity`sinden TURETILIR
 *                (`indexer/src/pool.ts`, `impliedReserves`). Turetme orada
 *                olur, burada degil: bu paket bir yazicidir, bir cozucu
 *                degil.
 *
 * `token_stats` guncellemesi ise AYNIDIR ve olmasi gerekir: hacim, islem
 * sayisi ve "son islem" bir TOKEN'in olgularidir, bir VENUE'nun degil. Havuz
 * islemlerini disarida birakan bir toplama, mezun bir token'i "islem
 * gormuyor" gibi gosterirdi.
 */
export interface PoolSwapEvent extends LogRef {
  kind: 'poolSwap'
  token: Address
  /** Token'in MEZUN OLDUGU egri. Islem burada olmadi; `source` bunu soyler. */
  curve: Address
  /** `Swap.sender` -- `PoolManager.swap`in cagirani. Genellikle bir router. */
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

export interface GraduatedEvent extends LogRef {
  kind: 'graduated'
  token: Address
  /** `Graduated.to` -- odemeyi alan graduation hedefi. */
  target: Address
  /** `Graduated.baseAmount` = curve'un `poolSeedSupply`si. */
  baseAmountTok: bigint
  /** `Graduated.quoteAmount` = curve'un `realQuoteReserves`i. */
  quoteAmountWei: bigint
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

export type IngestEvent =
  | LaunchEvent
  | TradeEvent
  | PoolSwapEvent
  | CompletedEvent
  | GraduatedEvent
  | TransferEvent
  | FeeLedgerEvent

export interface ReplayResult {
  launches: number
  trades: number
  /**
   * `trades` tablosuna `source = 'pool'` ile giren satirlar. `trades`TEN AYRI
   * SAYILIR, ayni tabloya yazsalar bile: sayaclari birlestirmek, "havuz yolu
   * hic calismadi" halini "egri yolu iki kat calisti" halinden ayirt
   * edilemez yapardi -- ve bugun havuz yolunun BEKLENEN sayisi sifirdir, yani
   * karistirma tam da fark edilmeyecek yerde olurdu.
   */
  poolSwaps: number
  completed: number
  graduated: number
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

/**
 * MEZUNIYET SONRASI BIR HAVUZ ISLEMI. `applyTrade`IN IKIZI, IKI FARKLA.
 *
 *   1. `source = 'pool'` YAZILIR. Sutun 003'ten beri var ve bugune kadar
 *      HICBIR SEY 'pool' yazmadi -- semanin hazir olup yolun olmamasi,
 *      spec 6.2'nin ("bir token graduate oldugunda fiyat gecmisi kopmaz")
 *      yarim kalmis yarisiydi.
 *   2. `curve_state` GUNCELLENMEZ. Egrinin rezervleri mezuniyette DONDU;
 *      bir havuz islemi onlari degistirmez. `applyTrade`in `cs` CTE'sini
 *      buraya kopyalamak, mezun bir egrinin sanal rezervlerini havuzun
 *      turetilmis rezervleriyle EZERDI ve `curve_state` iki farkli venue'nun
 *      durumunu tasiyan tek bir satira donusurdu.
 *
 * `token_stats` yazimi AYNIDIR ve `applyTrade`inkiyle KELIMESI KELIMESINE
 * ayni olmak zorundadir: hacim ve sayaclar TOKEN'in olgusudur. Ayrisan bir
 * kopya, mezuniyetten sonra hacmin sessizce baska bir kurala gore
 * toplanmasi demekti.
 */
export async function applyPoolSwap(db: Queryable, e: PoolSwapEvent): Promise<number> {
  return affected(
    db,
    `WITH ins AS (
       INSERT INTO trades
         (event_seq, block_number, log_index, tx_hash, block_time, token, curve, trader, is_buy,
          token_amount_tok, quote_amount_wei, protocol_fee_wei, creator_fee_wei,
          virtual_token_reserves_tok, virtual_quote_reserves_wei,
          real_token_reserves_tok, real_quote_reserves_wei, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pool')
       ON CONFLICT (event_seq) DO NOTHING
       RETURNING *
     ),
     st AS (
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
 * `Graduated`. `curve_state.graduated` bir DURUM GECISIDIR.
 *
 * IDEMPOTENCY MUHAFIZI `NOT graduated`TIR, DEFTER SATIRI DEGIL -- ve bu bir
 * ihmal degil bir AYRIM: bu paketin defter-satiri kurali "DELTA tasiyan her
 * yazim" icindir (`holders.balance_tok`, `fee_balances.claimable_wei`), cunku
 * bir deltayi ikinci kez uygulamak sessizce yanlis bir sayi uretir.
 * `Graduated` MUTLAK yazar: ikinci oynatim ayni degerleri yazsa bile "ikinci
 * gecis hicbir sey yazmaz" iddiasi olculebilir olmali, ve onu olculebilir
 * yapan sey `WHERE ... AND NOT graduated`in SIFIR satir dondurmesidir --
 * `applyCompleted`in `NOT complete`i ile ayni mekanik.
 *
 * ODENEN TOKEN'IN HOLDER MUHASEBESI BURADA YAPILMAZ VE YAPILMAMALI.
 * `graduate()` `IERC20(token).transfer(target, baseAmount)` cagirir
 * (`BondingCurve.sol:902`), yani zincir GERCEK bir `Transfer` logu yayar; o
 * log zaten izleme kumesindeki bir token'dan gelir, `applyTransfer` onu kendi
 * defteriyle (`token_transfers`) tam bir kez uygular ve curve'un bakiyesini
 * dusurup hedefinkini artirir. Burada ikinci bir delta yazmak, tek bir
 * hareketi IKI KEZ saymak olurdu -- EIP-7708'in `Transfer` duvarinin
 * kapattigi arizanin aynisi, bu sefer kendi elimizle.
 *
 * `graduated_implies_complete` KISITI BILEREK YAKALAYICIDIR: `WHERE`, complete
 * OLMAYAN bir satiri secerse kisit patlar ve islem geri alinir. Sessizce sifir
 * satir dondurmek, `Completed`i kacirmis bir indexer'i "yapacak bir sey yoktu"
 * gibi gosterirdi.
 */
export async function applyGraduated(db: Queryable, e: GraduatedEvent): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE curve_state SET
       graduated              = true,
       graduated_seq          = $2,
       graduation_target_addr = $3,
       graduation_base_tok    = $4,
       graduation_quote_wei   = $5,
       last_seq               = GREATEST(last_seq, $2)
     WHERE token = $1 AND NOT graduated`,
    [
      lower(e.token),
      e.eventSeq.toString(),
      lower(e.target),
      e.baseAmountTok.toString(),
      e.quoteAmountWei.toString(),
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
  // CURVE HARIC TUTULUR VE BU ZORUNLUDUR.
  //
  // `LaunchToken` TUM arzi (1e27) constructor'da curve'e basar, yani launch
  // aninda curve TEK holder'dir. Onu saymak, hicbir kullanicisi olmayan bir
  // token'in "1 holder" gostermesi demekti -- kullaniciya YANLIS BIR RAKAM.
  // Dogru deger 0'dir ve `apply-transfer.test.ts` bunu launch fixture'inda
  // olcer.
  await db.query(
    `UPDATE token_stats s
       SET holder_count = (SELECT count(*) FROM holders h
                           LEFT JOIN curve_state c ON c.token = h.token
                           WHERE h.token = s.token AND h.balance_tok > 0
                             AND (c.curve IS NULL OR h.holder <> c.curve))
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
 * BUYBACK DEFTERI -- `buyback_events` + `buyback_state`.
 *
 * `applyFeeEvent` ILE AYNI IKI IFADELI KALIP, ayni zorunlulukla: artimli
 * guncelleme defter satirinin GERCEKTEN eklenmis olmasina baglidir, ve
 * `pending_quote_wei` bir CHECK tasidigi icin onerilen satirda
 * degerlendirilemez -- yani `ON CONFLICT DO UPDATE` icinde hesaplanamaz.
 * Ikisinin AYNI ISLEMDE cagrilmasi bu yuzden ZORUNLUDUR (`applyRange`).
 *
 * BES TURUN TEK KAYDA SIGMASI icin alanlarin cogu `null` olabilir; hangisinin
 * hangi turde dolu OLMAK ZORUNDA oldugunu bu tip DEGIL, semadaki `*_iff_*`
 * kisitlari soyler. Tipi dar bir birlesim yapmak (bes ayri arayuz) cagiran
 * tarafi guzellestirir ama SQL yine on dort parametre alir; kisit semada
 * durdugu surece iki bicim de ayni seyi garanti eder, ve bu bicim
 * `FeeLedgerEvent`in (`from: Address | null`) buyutulmus halidir.
 */
export interface BuybackLedgerEvent extends LogRef {
  kind: 'buyback'
  buybackKind: 'policy' | 'accrued' | 'executed' | 'skipped' | 'locked' | 'released'
  token: Address
  /** Olayi yayan kontrat: FABRIKA (`policy`), hazine ya da kasa. */
  emitter: Address
  /** `accrued`: tahakkuku yapan merci (egri ya da hook). Digerlerinde null. */
  venue: Address | null
  /** `released`: `release()`i cagiran. `policy`: degisikligi yapan. */
  caller: Address | null
  /** `policy`: yeni deger. Digerlerinde null. */
  enabled: boolean | null
  /** `skipped`: zincirin yaydigi sebep dizesi. Digerlerinde null. */
  reason: string | null
  /** `accrued`/`executed`/`skipped` tutari, native wei. */
  quoteWei: bigint | null
  /** `accrued`: tahakkuk SONRASI bekleyen -- zincirin MUTLAK degeri. */
  pendingWei: bigint | null
  /** `executed`: alinan token. `locked`: kilitlenen token. */
  tokenAmountTok: bigint | null
  /** `locked`: kasadaki kumulatif toplam (zincirin mutlak sayisi). */
  totalLockedTok: bigint | null
  creatorAmountTok: bigint | null
  protocolAmountTok: bigint | null
  vestingStart: Date | null
  vestingEnd: Date | null
}

export async function applyBuybackEvent(db: Queryable, e: BuybackLedgerEvent): Promise<number> {
  const n = await affected(
    db,
    `WITH ins AS (
       INSERT INTO buyback_events
         (event_seq, block_number, log_index, tx_hash, block_time, kind, token,
          emitter_addr, venue_addr, caller_addr, reason, enabled,
          quote_wei, pending_wei, token_amount_tok, total_locked_tok,
          creator_amount_tok, protocol_amount_tok, vesting_start_at, vesting_end_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (event_seq) DO NOTHING
       RETURNING token, event_seq
     ),
     seed AS (
       INSERT INTO buyback_state (token, last_seq) SELECT token, event_seq FROM ins
       ON CONFLICT (token) DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
    [
      e.eventSeq.toString(),
      e.blockNumber.toString(),
      e.logIndex,
      lowerHash32(e.txHash),
      e.blockTime,
      e.buybackKind,
      lower(e.token),
      lower(e.emitter),
      e.venue === null ? null : lower(e.venue),
      e.caller === null ? null : lower(e.caller),
      e.reason === null ? null : pgSafeText(e.reason),
      e.enabled,
      e.quoteWei?.toString() ?? null,
      e.pendingWei?.toString() ?? null,
      e.tokenAmountTok?.toString() ?? null,
      e.totalLockedTok?.toString() ?? null,
      e.creatorAmountTok?.toString() ?? null,
      e.protocolAmountTok?.toString() ?? null,
      e.vestingStart,
      e.vestingEnd,
    ],
  )
  if (n === 0) return 0

  // `pending_quote_wei` UC FARKLI SEKILDE HAREKET EDER, ve ucu de zincirin
  // soyledigi seyi tekrar eder:
  //   accrued   MUTLAK atama -- zincir tahakkuk sonrasi toplami yayar, yani
  //             burada toplamak hem gereksiz hem de sapmaya acik olurdu.
  //   executed  butceden dusulur (harcandi).
  //   skipped   butceden dusulur (creator'a geri katlandi).
  // `GREATEST(0, ...)` yalnizca bir log DILIMINDE baglar; gerekce migration
  // 016'da, ve `apply-buyback` testi baglamasini OLCER.
  await db.query(
    `UPDATE buyback_state SET
       pending_quote_wei = CASE
         -- GERIDEN GELEN BIR TAHAKKUK MUTLAK DEGERI EZMEZ.
         --
         -- Kumulatif sutunlar sirasizdir (toplama degismelidir), ama bu sutun
         -- bir ATAMADIR: eski bir tahakkuk yeni bir tahakkuktan SONRA
         -- uygulanirsa butceyi GERIYE alirdi. Uretimde ulasilamaz -- imlec
         -- yalnizca ILERI gider, bir bosluk \`assertContinuous\` ile durur, ve
         -- zaten uygulanmis bir olay defter satirina takilip bu UPDATE'e hic
         -- gelmez -- ama bu satir, yazicinin dogrulugunu CAGIRANIN bir
         -- ozelligine bagli olmaktan cikarir.
         WHEN $2 = 'accrued' AND $11::bigint >= last_seq THEN $3::numeric
         WHEN $2 = 'accrued'                 THEN pending_quote_wei
         WHEN $2 IN ('executed','skipped')   THEN GREATEST(0, pending_quote_wei - $4::numeric)
         ELSE pending_quote_wei END,
       accrued_total_wei  = accrued_total_wei  + CASE WHEN $2 = 'accrued'  THEN $4::numeric ELSE 0 END,
       spent_total_wei    = spent_total_wei    + CASE WHEN $2 = 'executed' THEN $4::numeric ELSE 0 END,
       returned_total_wei = returned_total_wei + CASE WHEN $2 = 'skipped'  THEN $4::numeric ELSE 0 END,
       bought_total_tok   = bought_total_tok   + CASE WHEN $2 = 'executed' THEN $5::numeric ELSE 0 END,
       -- ATANIR, TOPLANMAZ: zincirin mutlak \`totalLocked\`i.
       locked_total_tok   = CASE WHEN $2 = 'locked' THEN $6::numeric ELSE locked_total_tok END,
       released_creator_tok  = released_creator_tok
         + CASE WHEN $2 = 'released' THEN $7::numeric ELSE 0 END,
       released_protocol_tok = released_protocol_tok
         + CASE WHEN $2 = 'released' THEN $8::numeric ELSE 0 END,
       vesting_start_at = CASE WHEN $2 = 'locked' THEN $9::timestamptz  ELSE vesting_start_at END,
       vesting_end_at   = CASE WHEN $2 = 'locked' THEN $10::timestamptz ELSE vesting_end_at   END,
       -- POLITIKA DA MUTLAK BIR ATAMADIR, yani \`pending_quote_wei\` ile AYNI
       -- sira muhafizina tabidir: geriden gelen bir toggle, guncel durumu
       -- ezip arayuze "kapali" dedirtirdi.
       enabled = CASE
         WHEN $2 = 'policy' AND $11::bigint >= last_seq THEN $12::boolean
         ELSE enabled END,
       enabled_seq = CASE
         WHEN $2 = 'policy' AND $11::bigint >= last_seq THEN $11::bigint
         ELSE enabled_seq END,
       enabled_by_addr = CASE
         WHEN $2 = 'policy' AND $11::bigint >= last_seq THEN $13::text
         ELSE enabled_by_addr END,
       last_seq = GREATEST(last_seq, $11::bigint)
     WHERE token = $1`,
    [
      lower(e.token),
      e.buybackKind,
      e.pendingWei?.toString() ?? null,
      e.quoteWei?.toString() ?? null,
      e.tokenAmountTok?.toString() ?? null,
      e.totalLockedTok?.toString() ?? null,
      e.creatorAmountTok?.toString() ?? null,
      e.protocolAmountTok?.toString() ?? null,
      e.vestingStart,
      e.vestingEnd,
      e.eventSeq.toString(),
      e.enabled,
      e.caller === null ? null : lower(e.caller),
    ],
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
/**
 * `headBlock` ZORUNLUDUR, ve bu bir tip degil bir SOZLESME meselesidir.
 *
 * Imleci ilerleten herkes o anda zincirin basini ZATEN okumustur -- `runOnce`
 * her turun basinda `finalized`i sorar, `replayRange`e aralik disaridan
 * verilir. Opsiyonel yapmak, "bas bilinmiyor" satirlarini URETIM yolundan da
 * uretilebilir kilardi; ve bir kez `head_block` NULL kaldiginda okuma katmani
 * verinin yasini HESAPLAYAMAZ -- yani B2-a'nin tam olarak duzeltmeye calistigi
 * korluk, bu parametreyi gecmeyi unutan tek bir cagirandan geri gelirdi.
 */
export async function setCursor(
  db: Queryable,
  lastBlock: bigint,
  lastBlockHash: string,
  headBlock: bigint,
): Promise<number> {
  if (headBlock < lastBlock) {
    // Bas imlecin GERISINDE olamaz: `runOnce` araligi basin otesine hic
    // acmaz. Sessizce negatif bir "geride" degeri yazmak, sayfada negatif bir
    // gecikme gosterirdi.
    throw new RangeError(`head ${headBlock} is behind the cursor ${lastBlock}`)
  }
  // `head_block` VE `head_observed_at` AYNI IFADEDE. Ikisini ayri yollardan
  // yazilabilir birakmak, donmus bir basi guncel gostermenin ta kendisidir
  // (bkz. migration 011): bir yazici birini tazeleyip otekini birakirsa,
  // okuma katmani gecikmeyi olculmus sanar. Bu depoda `head_block`i yazan
  // ifade sayisi IKIDIR ve ikisi de bu satirdaki gibi ciftini tasir.
  const { rowCount } = await db.query(
    `INSERT INTO sync_state (id, last_block, last_block_hash, head_block, head_observed_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE
       SET last_block = EXCLUDED.last_block,
           last_block_hash = EXCLUDED.last_block_hash,
           head_block = EXCLUDED.head_block,
           head_observed_at = now(),
           updated_at = now()
     WHERE EXCLUDED.last_block > sync_state.last_block`,
    [lastBlock.toString(), lowerHash32(lastBlockHash), headBlock.toString()],
  )
  return rowCount ?? 0
}

/**
 * BASA YETISMIS BIR INDEXER DE BIR SEY SOYLEMEK ZORUNDA.
 *
 * `runOnce` `null` dondugunde -- yani islenecek aralik kalmadiginda -- eski
 * hal HICBIR SEY yazmiyordu. Iki sonucu vardi: `updated_at` yerinde sayardi
 * (30 saniyeden sonra "yazma durdu" derdi, oysa surec gayet iyi) ve
 * `head_block` bir onceki turdan kalirdi, yani "ne kadar geride" sorusunun
 * cevabi TAZELENMEZDI.
 *
 * Bu yazma imleci ILERLETMEZ -- `last_block`a dokunmaz. Yalnizca "bu ana kadar
 * gordugum bas budur ve hala kosuyorum" der. Bas GERIYE gitmez (`GREATEST`):
 * `finalized` etiketinin geri dusmesi Arc'ta olculmedi, ama dusseydi verinin
 * yasini SIFIRLAMASI kabul edilemezdi.
 */
/**
 * ================== "HALA BURADAYIM" -- ILERLEME IDDIASI YOK ==============
 *
 * `updated_at` SURECIN CANLILIGIDIR, verinin yasi degil; verinin yasini
 * `head_block - last_block` tasir. Ama indexer canliligini yalnizca BIR SEY
 * YAZDIGINDA bildiriyordu, ve hiz siniri merdiveni buyuyunce (`6f2b0a4`) o
 * sessizlik bayatlik esigini duzenli olarak asmaya basladi.
 *
 * OLCULDU (kompozisyon kosusu): tek tek uykular 26-29 saniye, tam merdiven
 * 62,3 saniye; esik 30 saniye. 4 saniye arayla 25 sayfa cizimi, **25'i de**
 * "Our indexer last updated 47s ago and may have stopped" dedi -- indexer
 * gayet canliyken, 8 denemenin 7.'sinde geri cekilirken. Ve GERCEKTEN olmus
 * bir indexer AYNI cumleyi uretiyordu.
 *
 * Cozum esigi buyutmek DEGIL: bu, olu bir indexer'in fark edilmesini de o
 * kadar geciktirirdi. Cozum, susan tarafin KONUSMASIDIR. Geri cekilme
 * uykusunun icinde bu satir atilir, yani "yaziyorum" ile "yasiyorum" ayrilir
 * ve ikisi de olculebilir kalir.
 *
 * IMLECE VE BASA DOKUNMAZ. Yalnizca `updated_at`. Geri cekilirken bir ilerleme
 * iddia etmek, duzeltilen yalanin yerine baskasini koymak olurdu.
 */
export async function noteAlive(db: Queryable): Promise<number> {
  // `head_block`A VE `head_observed_at`E DOKUNMAZ, ve bu satirin BUTUN anlami
  // odur. Onceki hal `head_block`a zaten dokunmuyordu -- kusur, dokunmamanin
  // GORUNMEMESIYDI: bas donuyor, `updated_at` tazeleniyor, ve gecikme sifir
  // OKUNUYORDU. Gozlemin kendi damgasi (`head_observed_at`) o donmayi
  // gorunur yapar; burasi ona da dokunmayarak yalani imkansiz kilar.
  const { rowCount } = await db.query('UPDATE sync_state SET updated_at = now() WHERE id = 1')
  return rowCount ?? 0
}

export async function noteHead(db: Queryable, headBlock: bigint): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sync_state
        SET head_block = GREATEST(COALESCE(head_block, 0), $1::bigint),
            head_observed_at = now(),
            updated_at = now()
      WHERE id = 1 AND last_block <= $1::bigint`,
    [headBlock.toString()],
  )
  return rowCount ?? 0
}

/**
 * Imlec ve uzerine insa ettigimiz blogun hash'i. Ingest dongusu her turun
 * BASINDA bunu okur ve `assertContinuous` ile bir sonraki araligin ilk
 * blogunun `parentHash`'ine karsi tutar.
 */
export async function getCursor(
  db: Queryable,
): Promise<{ lastBlock: bigint; lastBlockHash: string } | null> {
  const { rows } = await db.query<{ last_block: string; last_block_hash: string }>(
    'SELECT last_block, last_block_hash FROM sync_state WHERE id = 1',
  )
  const row = rows[0]
  if (row === undefined) return null
  return { lastBlock: BigInt(row.last_block), lastBlockHash: row.last_block_hash }
}

/**
 * IMLECI SIL. SAHIPSIZ BIR IMLEC ICIN, BASKA HICBIR SEY ICIN DEGIL.
 *
 * `sync_state` FACTORY TASIMAZ, ve tasimasi da gerekmez: imlecin anlamini
 * veren sey `deployment` satiridir ve `ensureDeployment` uyusmazlikta HALT
 * eder. AMA IKISI AYRILABILIR -- `deployment` satiri silinip `sync_state`
 * kalirsa, `ensureDeployment` "kayit yok" dalina girer, YENI factory'yi yazar
 * ve dongu ESKI factory'nin imlecinden devam eder.
 *
 * OLCULDU (2026-08-08, canli): `deployment` bosaltildi, imlec 54721436'da
 * birakildi, indexer YENI bir factory ile baslatildi. Yeni dagitim yazildi
 * (`start_block = 55000000`) ve tarama 54721437'DEN devam etti -- yani imlec
 * ve dagitim BASKA BASKA seylerden bahsediyordu. Bu yonde maliyet yalnizca
 * bosa tarama; TERS YONDE (imlec yeni `startBlock`in ILERISINDE) aradaki her
 * launch KALICI OLARAK ATLANIR, cunku `nextRange` `cursor + 1`den acar ve
 * `start_block` yalnizca imlec YOKKEN kullanilir.
 *
 * Keeper ayni soruyu bir tur once cozdu ve cozumu de ayni: baska bir factory
 * icin yazilmis imlec YOK SAYILIR ve sebep loglanir. Yeniden taramak
 * PAHALIDIR ama GUVENLIDIR (exactly-once `event_seq` birincil anahtarlarindan
 * gelir); launch kaybetmek geri alinamaz.
 */
export async function clearCursor(db: Queryable): Promise<number> {
  const { rowCount } = await db.query('DELETE FROM sync_state WHERE id = 1')
  return rowCount ?? 0
}

export async function applyEvent(db: Queryable, e: IngestEvent): Promise<number> {
  switch (e.kind) {
    case 'launch':
      return applyLaunch(db, e)
    case 'trade':
      return applyTrade(db, e)
    case 'poolSwap':
      return applyPoolSwap(db, e)
    case 'completed':
      return applyCompleted(db, e)
    case 'graduated':
      return applyGraduated(db, e)
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
 *
 * ZINCIR BAGINI KENDISI KONTROL EDER. `fromParentHash`, isledigimiz araligin
 * ILK blogunun `parentHash`'idir; kayitli imlec hash'iyle uyusmuyorsa islem
 * hicbir sey yazmadan `ReorgDetected` ile geri alinir.
 *
 * Muhafizin cagrisi BURADA, cunku daha once `indexer`da durup TAVSIYE
 * NITELIGINDEYDI: `replayRange` onu cagirmiyordu ve tek cagirani sabit
 * kodlanmis bir `null` geciyordu. Imleci ilerleten tek yol burasi oldugu icin
 * kontrolu buraya koymak, ozelligi sozlesmeyle degil YAPIYLA saglar.
 */
export async function replayRange(
  pool: Pool,
  events: readonly IngestEvent[],
  to: bigint,
  toHash: string,
  fromParentHash: string,
): Promise<ReplayResult> {
  return withTransaction(pool, async (tx: PoolClient) => {
    // Islemin ICINDE okunur: imleci baska bir yazicinin altimizdan
    // degistirmesi durumunda da dogru degeri gormus oluruz.
    const current = await getCursor(tx)
    assertContinuous(current?.lastBlock ?? 0n, current?.lastBlockHash ?? null, fromParentHash)
    const r: ReplayResult = {
      launches: 0,
      trades: 0,
      poolSwaps: 0,
      completed: 0,
      graduated: 0,
      transfers: 0,
      fees: 0,
      cursorMoved: 0,
      total: 0,
    }
    for (const e of events) {
      const n = await applyEvent(tx, e)
      if (e.kind === 'launch') r.launches += n
      else if (e.kind === 'trade') r.trades += n
      else if (e.kind === 'poolSwap') r.poolSwaps += n
      else if (e.kind === 'completed') r.completed += n
      else if (e.kind === 'graduated') r.graduated += n
      else if (e.kind === 'transfer') r.transfers += n
      else r.fees += n
    }
    // BASI `to` OLARAK YAZAR, ve bu bir varsayim degil bir TANIM: `replayRange`
    // araligi disaridan alir ve onu BUTUNUYLE uygular, yani cagirana gore bu
    // kosunun bildigi en ileri blok `to`dur. Zincirin gercek basini bu
    // fonksiyon HIC gormez -- goren tek yer `runOnce`tir ve o kendi basini
    // gecirir. Ikisini karistirmamak icin burada `to` yaziliyor: "bildigim
    // kadariyla basa yetismis durumdayim".
    r.cursorMoved = await setCursor(tx, to, toHash, to)
    r.total =
      r.launches +
      r.trades +
      r.poolSwaps +
      r.completed +
      r.graduated +
      r.transfers +
      r.fees +
      r.cursorMoved
    return r
  })
}
