-- DENORMALIZE. Spec 6.2 bunu zorunlu kilar: Explore sayfasi yuz binlerce
-- token arasinda "market cap'e gore sirala" diyebilmeli ve bu her istekte
-- `trades` uzerinden toplanamaz.
--
-- BURAYA YALNIZCA INDEKSLENEBILIR SIRALAMA ANAHTARLARI GIRER. Token detay
-- sayfasinin tek satirlik alanlari (fiyat, graduation ilerlemesi, rezervler)
-- `token_overview` VIEW'inda durur -- saklanmadiklari icin bayatlamazlar.
CREATE TABLE token_stats (
  token                    text PRIMARY KEY REFERENCES launches(token),
  market_cap_wei           numeric(78,0) NOT NULL,
  ath_market_cap_wei       numeric(78,0) NOT NULL,
  volume_total_wei         numeric(78,0) NOT NULL DEFAULT 0,
  volume_24h_wei           numeric(78,0) NOT NULL DEFAULT 0,
  -- 24s hacim PENCERELI bir toplamdir: girisler ZAMANLA DUSER, yani artimli
  -- olarak dogru tutulamaz. Bu kolon her dokunulan token icin yeniden
  -- HESAPLANIR, ve dokunulmayan tokenlar icin bir surgu adimi tazeler
  -- (Task 11). Tazelenme zamani BURADA duruyor cunku degerin ne kadar bayat
  -- oldugu okuyanin bilmesi gereken bir seydir.
  volume_24h_refreshed_at  timestamptz NOT NULL DEFAULT now(),
  trade_count              integer NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  buy_count                integer NOT NULL DEFAULT 0 CHECK (buy_count >= 0),
  holder_count             integer NOT NULL DEFAULT 0 CHECK (holder_count >= 0),
  last_trade_seq           bigint,
  -- "Recent buys" beslemesinin SIRALAMA anahtari. ZAMAN DEGIL SIRA.
  -- Gerekce Task 10'da; kisaca: Arc'ta ardisik bloklarin %49,0'i ayni
  -- timestamp'i tasir -- olculdu 2026-07-31, 553 ciftin 271'i; yontem ve
  -- dagilim 003_trades_and_curve_state.sql'de. Yani zamana gore siralama yari
  -- yariya keyfi ve sayfalama sinirinda KARARSIZDIR.
  last_buy_seq             bigint,
  last_trade_at            timestamptz,
  last_buy_at              timestamptz,
  created_seq              bigint NOT NULL,
  created_at               timestamptz NOT NULL
);

CREATE INDEX token_stats_mcap_idx    ON token_stats (market_cap_wei DESC);
CREATE INDEX token_stats_vol24_idx   ON token_stats (volume_24h_wei DESC);
CREATE INDEX token_stats_created_idx ON token_stats (created_seq DESC);
-- KISMI indeks: hic alim gormemis bir token "Recent buys" beslemesinde
-- GORUNMEZ. Bu bir optimizasyon degil URUN kararidir -- etiket "recent
-- buys"tur, "recently launched" degil.
CREATE INDEX token_stats_last_buy_idx ON token_stats (last_buy_seq DESC)
  WHERE last_buy_seq IS NOT NULL;
