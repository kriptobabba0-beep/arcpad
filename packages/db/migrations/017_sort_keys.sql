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
--  COZUM: EKLEMELI. GOSTERILEN DEGER DEGISMEZ.
-- ==================================================================
--
-- View'in `market_cap_wei`i OLDUGU GIBI KALIR (hesaplanan ifade, her zaman
-- taze). Yanina YALNIZCA SIRALAMA ICIN iki sutun eklenir ve ikisi de TAMAMEN
-- `token_stats`ten turer, yani ifade indeksleri onlara hizmet edebilir.
--
-- NICIN GOSTERILEN DEGERI DEGISTIRMIYORUM: `writeMarketCap` bir sira muhafizi
-- tasir (`COALESCE(last_trade_seq, 0) <= guardSeq`), yani gec gelen bir olay
-- yazimi ATLAYABILIR. Ayrisma pratikte olmaz -- ama olsaydi, view'in
-- gosterdigi sayiyi bayatlatmak siralamayi bayatlatmaktan COK daha kotu bir
-- ariza olurdu. Bu yuzden risk yalnizca SIRAYA verilir, SAYIYA verilmez.

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
-- 2. VIEW: IKI SIRALAMA SUTUNU EKLENIR
-- ------------------------------------------------------------------
-- `CREATE OR REPLACE VIEW` yalnizca SONA sutun eklemeye izin verir; mevcut
-- sutunlarin adi, tipi ve SIRASI birebir korunmak zorunda. Bu yuzden govde
-- `016_buyback.sql`den OLDUGU GIBI kopyalanir ve iki satir SONA eklenir.
-- Kopya istenmez ama alternatifi view'i DROP etmektir ve bu depoda bir view'i
-- dusurmek ona bagli her seyi de dusurur.
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

  div(cs.virtual_quote_reserves_wei * d.total_supply_tok, cs.virtual_token_reserves_tok)::numeric(
    78, 0
  ) AS market_cap_wei,

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
  l.created_seq,
  l.created_at,

  -- ---- SONA EKLENEN IKI SUTUN: YALNIZCA SIRALAMA ICIN ----
  --
  -- Ikisi de TAMAMEN `ts`den turer. Bu, tek onemli ozellik: `l.created_seq`
  -- kullanilsaydi ifade yine TABLOLAR ARASI olur ve indeks yine ise yaramazdi.
  -- `ts.created_seq` ile `l.created_seq` ayni launch'in ayni numarasidir
  -- (`applyLaunch` ikisini birlikte yazar), yani sira ayni.
  search_key(ts.market_cap_wei, ts.created_seq) AS sort_mcap_key,
  search_key(ts.volume_24h_wei, ts.created_seq) AS sort_volume_key
FROM launches l
JOIN curve_state cs ON cs.token = l.token
JOIN token_stats ts ON ts.token = l.token
LEFT JOIN buyback_state bb ON bb.token = l.token
CROSS JOIN deployment d;
