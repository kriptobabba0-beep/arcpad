-- ==================================================================
--  MARKET CAP SAKLI SUTUNDAN OKUNUR -- VE BU BIR URUN KARARIYDI
-- ==================================================================
--
-- ============ KARAR ============
--
-- `017_sort_keys.sql` bu degisikligi ACIK BIRAKTI, cunku bir performans isi
-- degildi. Iki deger bayatliktan degil TASARIMDAN ayrisiyordu:
--
--   `writeMarketCap` UC yerden cagrilir ve ucuncusu `indexer/src/apply/pool.ts`
--   -- yani MEZUNIYETTEN SONRA, HAVUZ fiyatindan. `token_overview` ise
--   `curve_state`ten hesapliyordu, ve egri mezuniyette DONAR.
--
--     ts.market_cap_wei         -> mezun tokende havuzun CANLI fiyati
--     view'in hesapladigi       -> egrinin DONMUS son fiyati
--
-- Yani view'i `ts`e baglamak, mezun tokenlerin GOSTERILEN market cap'ini ve bu
-- siralamanin ANLAMINI degistirir. Karar sahibi CANLI HAVUZ FIYATINI secti
-- (denetim defteri D-14): mezun bir token'in market cap'i artik havuzla hareket
-- eder, cunku token'in gercek fiyati odur.
--
-- ============ NEDEN ONCEKI DENEME DOKUZ TESTLE DUSTU ============
--
-- Sutunu view'e baglamak YETMEZ, cunku `packages/db` onu BAKMIYORDU:
-- `applyLaunch` yalnizca 0 INSERT ediyordu ve islemlerde guncelleyen sey
-- INDEXER'in `writeMarketCap`iydi. Yani bu katmanda deger BAYATLIYORDU ve
-- dokuz test ("acilis market cap'i tam 4 USDC", "hic islem gormemis alti token
-- TEK bir deger tasir", ...) tam bunu gosterdi. Testler HAKLIYDI.
--
-- Bu yuzden bakim `packages/db`ye TASINDI (`src/apply.ts`):
--
--   * `applyLaunch`  -> acilis market cap'ini yazar (0 degil);
--   * `applyTrade`   -> egri islemlerinde MUTLAK yazar, sira ile korunmus;
--   * `applyPoolSwap`-> mezuniyetten sonra HAVUZ fiyatindan yazar.
--
-- UCU DE MEVCUT CTE'NIN ICINDE, AYRI BIR CTE'DE DEGIL. Postgres tek ifadede
-- ayni satiri iki kez guncellemeyi desteklemez ve ikinci etki SESSIZCE kaybolur
-- -- ayri bir `mc AS (UPDATE token_stats ...)` ya hacim sayaclarini ya da market
-- cap'i dusururdu.
--
-- VE `LEFT JOIN deployment d ON true`, `CROSS JOIN` DEGIL: `deployment` EN
-- FAZLA bir satirdir ama EN AZ bir satir degildir. `CROSS JOIN` bos bir
-- `deployment`ta hic satir uretir, yani market cap eklemek HACIM SAYACLARINI
-- sessizce durdururdu.
--
-- INDEXER'IN CAGRILARI KALDI ve bu bilincli: ayni ifadeyle, ayni muhafizla,
-- ayni degeri yazarlar (idempotent). Artik gereksizler ve kaldirilmalari
-- temizlik olur -- ama bu, indexer'in kendi kapilariyla dogrulanacak AYRI bir
-- turdur; iki yazicinin AYNI degeri yazmasi bir kusur degildir.
--
-- ============ OLCUM ============
--
--   ONCE:  marketCap  Sort=2   <- 3.000 satir siralaniyor
--   SONRA: marketCap  Sort=0   <- ifade indeksinden
--
-- `token_stats_mcap_idx` (`market_cap_wei DESC`) yeterli DEGILDIR: sorgu
-- `search_key(market_cap_wei, created_seq)` siralar, yani PAKETLENMIS anahtarin
-- kendi ifade indeksi gerekir. Paketleme `SORTS`ta GORUNUR kalir -- bunu
-- `ordering.test.ts` sart kosar.

-- ------------------------------------------------------------------
-- 1. IFADE INDEKSI
-- ------------------------------------------------------------------
-- `search_key` `IMMUTABLE STRICT`tir (`008_search.sql`), yani ifade indeksinde
-- kullanilabilir. Yon `DESC`, sorgudakiyle AYNI.
--
-- BU INDEKS ARTIK OLU DEGIL, ve fark tam olarak su: view sutunu `ts`den
-- okuduğu icin ifade TEK TABLOYA cozulur. `017` oncesinde ayni indeks
-- eklenseydi hicbir sorgunun kullanmadigi bir yazma yuku olurdu.
CREATE INDEX token_stats_sort_mcap_idx
  ON token_stats (search_key(market_cap_wei, created_seq) DESC);

-- ------------------------------------------------------------------
-- 2. VIEW: `market_cap_wei` KAYNAGI DEGISIR
-- ------------------------------------------------------------------
-- `CREATE OR REPLACE VIEW` sutun adlarini, TIPLERINI ve SIRASINI birebir
-- korumami sart kosar. Ne sutun eklenir ne cikarilir: `ts.market_cap_wei` de
-- `numeric(78,0)`, hesaplanan ifade de `numeric(78,0)` idi.

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

  (1000000 - ceil(cs.real_token_reserves_tok * 1000000::numeric / d.sale_supply_tok))::integer
    AS progress_ppm,

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
