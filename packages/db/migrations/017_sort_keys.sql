-- ==================================================================
--  EXPLORE SIRALAMALARI BIR INDEKSTEN GELIR
-- ==================================================================
--
-- OLCULDU, TAHMIN EDILMEDI (2026-08-17, `packages/db/test/scale.test.ts`,
-- 3.000 token, CI'in Postgres 17'sinde):
--
--   recentBuys       Sort=0     <- indeksten
--   newest           Sort=0     <- indeksten
--   oldest           Sort=0     <- indeksten
--   marketCap        Sort=2     <- 3.000 SATIR SIRALANIYOR
--   volume           Sort=2     <- 3.000 SATIR SIRALANIYOR
--   nearGraduation   Sort=2     <- 3.000 SATIR SIRALANIYOR
--
-- `marketCap` icin planin tamami: uc `Seq Scan` (launches, curve_state,
-- token_stats), 3.000 satirlik iki hash join, sonra 3.000 satirlik bir `Sort`,
-- ve EN SON `Limit 24`. Yani `LIMIT` hicbir sey kurtarmiyor -- `Sort` once
-- butun satirlari uretmek ZORUNDA.
--
-- BEDELI ISTEK BASINA VE KULLANICI BASINA ODENIR: `LiveRefresh` gorunur her
-- sekmede on saniyede bir `router.refresh()` cagirir. Yani bu is, token sayisi
-- x gorunur kullanici / 10 saniye hizinda tekrarlanir. Binlerce tokenli ve
-- binlerce kullanicili bir platformda ilk coken yer burasidir.
--
-- ==================================================================
--  SEBEP: ANAHTAR ZATEN VARDI, VIEW ONU KULLANMIYORDU
-- ==================================================================
--
-- `token_stats` uc girdinin UCUNU de tasir: `market_cap_wei`,
-- `volume_24h_wei`, `created_seq` -- hepsi TEK TABLODA. Ve
-- `indexer/src/apply/trade.ts:writeMarketCap` `market_cap_wei`i HER ISLEMDE,
-- view'in KULLANDIGI AYNI ifadeyle (`div(Vq * N, Vt)`) yazar; o fonksiyonun
-- kendi yorumu "saklanan siralama anahtari ile gosterilen deger AYRISAMAZ"
-- diyor.
--
-- Yani siralama anahtari ZATEN saklaniyordu ve `token_stats_mcap_idx` ZATEN
-- indeksliydi. Eksik olan tek sey: `token_overview` `market_cap_wei`i
-- `curve_state`ten YENIDEN HESAPLIYOR, dolayisiyla `ORDER BY
-- search_key(market_cap_wei, created_seq)` bir TABLOLAR ARASI IFADEYE cozuluyor
-- ve hicbir indeks ona hizmet edemiyor. Ayni sey `volume` icin de gecerli:
-- `volume_24h_wei` `token_stats`ten gelir ama `created_seq` view'de
-- `launches`tan (`l.created_seq`) gelir -- iki tablo, sifir indeks.
--
-- ==================================================================
--  COZUM: IKI SUTUNUN KAYNAGI DEGISIR. YENI SUTUN YOK.
-- ==================================================================
--
-- ILK DENEME REDDEDILDI, VE KAPILAR HAKLIYDI. View'in SONUNA `sort_mcap_key`
-- diye onceden paketlenmis sutunlar eklemeyi denedim; uc kapi birden kirdi:
--
--   * `naming.test.ts`: her `numeric` TAM OLARAK `numeric(78,0)` olmali ve
--     `_wei`/`_tok` ile bitmeli. `sort_mcap_key numeric` ikisini de ihlal eder.
--   * `ordering.test.ts`: `SORTS`taki her ifade GORUNUR sekilde
--     `search_key(...)` olmali. Paketlemeyi view'in icine saklamak, sorguyu
--     okuyanin bag-bozma anahtarini GOREMEMESI demek.
--   * sema parmak izi: yeni sutunlar envanteri kaydirir.
--
-- Uc kural da dogru kurallar. Dolayisiyla dogru cozum EKLEMEK degil, mevcut
-- iki sutunun KAYNAGINI degistirmek:
--
--   market_cap_wei : div(cs...)  ->  ts.market_cap_wei
--   created_seq    : l.created_seq -> ts.created_seq
--
-- Boylece `search_key(market_cap_wei, created_seq)` TEK BIR TABLONUN iki
-- sutununa cozulur ve ifade indeksi ona hizmet eder. `SORTS` DEGISMEZ --
-- paketleme sorguda gorunur kalir.
--
-- ============ SAKLI DEGERE GUVENMEK NEDEN SAGLAM ============
--
-- `curve_state`in sanal rezervlerini yazan TEK yol var (`applyTrade`,
-- `packages/db/src/apply.ts`) ve muhafizi `event_seq > c.last_seq`.
-- `writeMarketCap` ayni degeri AYNI ifadeyle (`div(Vq * N, Vt)`) ve esdeger
-- bir muhafizla (`COALESCE(last_trade_seq, 0) <= guardSeq`) yazar; gec gelen
-- eski bir olay IKISINDE DE atlanir. Yani iki deger ayrisamaz -- o
-- fonksiyonun kendi yorumunun soyledigi sey.
--
-- `ts.created_seq` ile `l.created_seq` de ayni launch'in ayni numarasidir;
-- `applyLaunch` ikisini birlikte yazar.
--
-- Sonuc olarak bu migration bir kopyayi KALDIRIR: market cap artik TEK bir
-- yerden okunur.

-- ------------------------------------------------------------------
-- 1. IFADE INDEKSLERI
-- ------------------------------------------------------------------
-- `search_key` `IMMUTABLE STRICT`tir (bkz. `008_search.sql`), yani bir ifade
-- indeksinde kullanilabilir. Yon `DESC`, sorgudakiyle AYNI: yonu ters bir
-- indeks sirali taramaya hizmet ETMEZ ve planlayici yine siralar.
CREATE INDEX token_stats_sort_mcap_idx
  ON token_stats (search_key(market_cap_wei, created_seq) DESC);

CREATE INDEX token_stats_sort_volume_idx
  ON token_stats (search_key(volume_24h_wei, created_seq) DESC);

-- ------------------------------------------------------------------
-- 2. VIEW: IKI SUTUNUN KAYNAGI DEGISIR
-- ------------------------------------------------------------------
-- `CREATE OR REPLACE VIEW` sutun adlarini, TIPLERINI ve SIRASINI birebir
-- korumami sart kosar -- ve bu degisiklik tam olarak oyle: ne sutun eklenir ne
-- cikarilir, yalnizca IKISININ KAYNAGI degisir. `ts.market_cap_wei` da
-- `numeric(78,0)`, `ts.created_seq` da `bigint`, yani tipler AYNI.
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

  -- SAKLI DEGER, YENIDEN HESAPLANAN DEGIL. Bkz. yukaridaki gerekce.
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
  -- `ts`den, `l`den DEGIL: `search_key(volume_24h_wei, created_seq)` ve
  -- `search_key(market_cap_wei, created_seq)` boylece TEK TABLOYA coozulur.
  ts.created_seq,
  l.created_at
FROM launches l
JOIN curve_state cs ON cs.token = l.token
JOIN token_stats ts ON ts.token = l.token
LEFT JOIN buyback_state bb ON bb.token = l.token
CROSS JOIN deployment d;
