-- ==================================================================
--  `progress_ppm` SAKLANIR -- SON PARA SIRALAMASI DA INDEKSTEN GELIR
-- ==================================================================
--
-- ============ NICIN ============
--
-- OLCULDU (CI + sunucu, 3.000 token, `packages/db/test/scale.test.ts`):
--
--   ONCE:  nearGraduation  Sort=2   <- 3.000 satir siralaniyor
--   SONRA: nearGraduation  Sort=0   <- ifade indeksinden
--
-- Sebep oteki ikisiyle AYNIYDI: `progress_ppm` view'de `curve_state` x
-- `deployment`ten hesaplaniyordu, yani `search_key(progress_ppm::numeric,
-- created_seq)` bir TABLOLAR ARASI ifadeye cozuluyor ve hicbir indeks ona
-- hizmet edemiyordu. `017` `created_seq`i, `018` `market_cap_wei`i tasidi; bu
-- migration ucuncusunu tasir ve Explore'un ALTI siralamasinin ALTISI da
-- indekse baglanir.
--
-- ============ BAKIM NOKTALARI, VE BIRI MARKET CAP'TEN FARKLI ============
--
-- Girdi `real_token_reserves_tok`tur. Onu yazan yollar:
--
--   applyLaunch     -> acilis degeri (`real = saleSupply`, yani ppm = 0)
--   applyTrade      -> her egri islemi, SIRA ile korunmus
--   applyCompleted  -> `real_token_reserves_tok = 0` YAZAR, yani ppm = 1.000.000
--
-- UCUNCUSU MARKET CAP'TE YOKTU VE ATLANMASI SESSIZ BIR KUSUR OLURDU:
-- `applyCompleted` SANAL rezervlere dokunmaz (o yuzden market cap'i etkilemez)
-- ama GERCEK token rezervini sifira ceker -- yani ilerlemeyi %100'e tasiyan sey
-- ODUR. Bakilmasaydi tamamlanmis bir curve, son islemin biraktigi yuzdede
-- DONAR ve "graduation'a en yakin" listesi tam olarak en ust satirini
-- kaybederdi.
--
-- `applyPoolSwap` BILEREK DISARIDA: ilerleme bir EGRI kavramidir ve mezuniyette
-- %100'de biter. Havuzun rezervleriyle yeniden hesaplamak, egriyle ilgisi
-- olmayan bir sayiyi egrinin yuzdesi diye yazmak olurdu.
--
-- ============ IFADE BIREBIR AYNI OLMAK ZORUNDA ============
--
-- `SORTS.nearGraduation` anahtari `search_key(progress_ppm::numeric,
-- created_seq)` -- ACIK bir `::numeric` cast tasir. Indeks ifadesi de AYNI cast
-- ile kurulur; farkli yazilsa planlayici indeksi KULLANMAZ ve olcum sessizce
-- eski haline donerdi.

-- ------------------------------------------------------------------
-- 1. SUTUN
-- ------------------------------------------------------------------
-- `integer`: milyonda pay 0..1.000.000 araligindadir, `int4`e rahat sigar.
-- `_ppm` soneki `naming.test.ts`in NON_MONEY_SUFFIX listesinde ZATEN bildirilmis
-- -- yani bu sutun para gibi (`numeric(78,0)`) olmak zorunda DEGIL, ve olmamali.
ALTER TABLE token_stats ADD COLUMN progress_ppm integer NOT NULL DEFAULT 0;

-- ------------------------------------------------------------------
-- 2. GERIYE DOLDURMA
-- ------------------------------------------------------------------
-- MEVCUT satirlar icin deger view'in bugune kadar HESAPLADIGI ifadeden gelir --
-- birebir aynisi, kirpilmadan. Kirpmak (`GREATEST/LEAST`) saklanan degeri
-- tarihsel ifadeden AYIRIRDI; aralik zaten 0..1.000.000, cunku
-- `real_token_reserves_tok` `saleSupply`ten 0'a iner.
--
-- Burada `CROSS JOIN` MESRU: tek seferlik bir doldurma, ve `deployment` bossa
-- doldurulacak anlamli bir deger de yoktur -- `DEFAULT 0` yerinde kalir.
UPDATE token_stats s
   SET progress_ppm =
         (1000000 - ceil(c.real_token_reserves_tok * 1000000::numeric / d.sale_supply_tok))::integer
  FROM curve_state c CROSS JOIN deployment d
 WHERE c.token = s.token;

-- ------------------------------------------------------------------
-- 3. IFADE INDEKSI
-- ------------------------------------------------------------------
CREATE INDEX token_stats_sort_progress_idx
  ON token_stats (search_key(progress_ppm::numeric, created_seq) DESC);

-- ------------------------------------------------------------------
-- 4. VIEW: `progress_ppm` KAYNAGI DEGISIR
-- ------------------------------------------------------------------
-- `CREATE OR REPLACE VIEW` sutun adlarini, TIPLERINI ve SIRASINI birebir
-- korumami sart kosar. Hesaplanan ifade `::integer` ile bitiyordu ve
-- `ts.progress_ppm` de `integer` -- yani tip AYNI.

CREATE OR REPLACE VIEW token_overview AS
SELECT
  l.token,
  l.curve,
  l.name,
  l.symbol,
  l.uri,
  l.launch_creator,
  creator_at(l.token, COALESCE(cs.last_seq, l.created_seq)) AS fee_creator,

  cs.virtual_token_reserves_tok,
  cs.virtual_quote_reserves_wei,
  cs.real_token_reserves_tok,
  cs.real_quote_reserves_wei,
  cs.complete,
  cs.completed_seq,
  cs.pool_seed_supply_tok,

  cs.graduated,
  cs.graduated_seq,
  cs.graduation_target_addr,
  cs.graduation_base_tok,
  cs.graduation_quote_wei,

  COALESCE(bb.enabled, false) AS buyback_enabled,
  COALESCE(bb.locked_total_tok, 0)::numeric(78, 0) AS buyback_locked_tok,

  -- SAKLI SUTUN, HESAPLANAN IFADE DEGIL. Gerekce basliktaki §KARAR'da.
  ts.market_cap_wei,

  div(cs.virtual_quote_reserves_wei * 1000000000000000000::numeric, cs.virtual_token_reserves_tok)::numeric(
    78, 0
  ) AS price_wei_per_tok,

  -- SAKLI SUTUN. Gerekce basliktaki §NICIN'de.
  ts.progress_ppm,

  div(d.virtual_quote_reserves_wei * d.sale_supply_tok, d.virtual_token_reserves_tok - d.sale_supply_tok)::numeric(
    78, 0
  ) AS graduation_raise_wei,

  ts.holder_count,
  ts.volume_total_wei,
  ts.volume_24h_wei,
  ts.ath_market_cap_wei,
  ts.trade_count,
  ts.buy_count,
  ts.last_trade_seq,
  ts.last_buy_seq,
  ts.last_trade_at,
  ts.last_buy_at,
  -- `ts`den, `l`den DEGIL. Artik UC ifade de tek tabloya cozulur:
  -- `search_key(volume_24h_wei, created_seq)`,
  -- `search_key(market_cap_wei, created_seq)`.
  ts.created_seq,
  l.created_at
FROM launches l
JOIN curve_state cs ON cs.token = l.token
JOIN token_stats ts ON ts.token = l.token
LEFT JOIN buyback_state bb ON bb.token = l.token
CROSS JOIN deployment d;
