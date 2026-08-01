-- TURETILMIS OKUMA MODELI.
--
-- BURADA SAKLANAN HICBIR SEY YOK, ve bu bir tercih degil bir gerekce:
-- saklanan bir turetme BAYATLAR ve bayatladigini kimse gormez. Token detay
-- sayfasinin tek satirlik alanlari (fiyat, market cap, graduation ilerlemesi,
-- rezervler) her okumada YENIDEN hesaplanir. `token_stats`teki denormalize
-- kolonlar YALNIZCA siralama anahtaridir (yuz binlerce token arasinda "market
-- cap'e gore sirala" her istekte `trades` uzerinden toplanamaz) ve ayni
-- ifadeyle yazilirlar -- `indexer/src/apply/trade.ts:writeMarketCap` bu
-- dosyadaki `div(...)` ile BIREBIR aynidir.
--
-- ARITMETIK KONTRATIN KENDISIYLE AYNI YONE YUVARLAR:
-- `CurveMath.marketCap` = `FullMath.mulDiv(Vq, N, Vt)`, yani TABANA. Postgres'in
-- `div(numeric, numeric)`'i sifira dogru keser; negatif olmayan girdide bu tam
-- olarak floor'dur. Indexer kontrattan SAPAMAZ.
--
-- KOLON ADLARI ADLANDIRMA KAPISINA TABIDIR (test/naming.test.ts view'lari da
-- inceler, relkind 'v'). Bu yuzden `price_wei_per_token` DEGIL
-- `price_wei_per_tok`: kapinin para soneki `_wei|_tok`tur ve `_token` bir
-- gorunum BILDIRMEZ. Ayni sebeple butun hesaplanmis miktarlar `numeric(78,0)`a
-- CAST edilir -- `div()` niteliksiz `numeric` dondurur ve kapi "her numeric TAM
-- OLARAK numeric(78,0)" der.
CREATE VIEW token_overview AS
SELECT
  l.token,
  l.curve,
  l.name,
  l.symbol,
  l.uri,
  l.launch_creator,
  -- UCRETI ALAN creator, ilgili ANDAKI hali. `launches.launch_creator` "kim
  -- baslatti" olgusudur ve degismez; ucret alicisi ise devredilebilir olacak
  -- (spec 5.7). Guncel creator'a duz bir JOIN, devirden ONCEKI islemleri
  -- yanlis etiketlerdi.
  creator_at(l.token, COALESCE(cs.last_seq, l.created_seq)) AS fee_creator,

  cs.virtual_token_reserves_tok,
  cs.virtual_quote_reserves_wei,
  cs.real_token_reserves_tok,
  cs.real_quote_reserves_wei,
  cs.complete,
  cs.completed_seq,
  cs.pool_seed_supply_tok,

  -- MARKET CAP = mulDiv(Vq, N, Vt), floor.
  div(cs.virtual_quote_reserves_wei * d.total_supply_tok, cs.virtual_token_reserves_tok)::numeric(
    78, 0
  ) AS market_cap_wei,

  -- FIYAT: TAM bir token (1e18 taban birimi) kac wei. `market_cap_wei / 1e9`
  -- ile birebir tutarlidir (N = 1e27, olcek 1e18).
  div(cs.virtual_quote_reserves_wei * 1000000000000000000::numeric, cs.virtual_token_reserves_tok)::numeric(
    78, 0
  ) AS price_wei_per_tok,

  -- GRADUATION ILERLEMESI, milyonda pay.
  --
  -- TANIM: SATILAN token orani, `sold/S`. Toplanan quote orani DEGIL, ve bu
  -- bir tercih degil bir turetme: `quoteBuyCost` her alimda `floor(...) + 1`
  -- doner (CurveMath.sol:52), yani biriken quote her alimda 1 wei FAZLA
  -- toplanir ve tamamlanma aninda `realQuoteReserves = R + (alim sayisi)`
  -- civaridir -- quote tabanli bir ilerleme %100'u ASARDI. Canli smoke bunu
  -- dogruluyor: graduation raise 12161433369060378706, tamamlanmada toplanan
  -- 12161433369060378714 (SEKIZ wei fazla).
  --
  -- KALAN YUKARI yuvarlanir (`ceil`), boylece bir wei token kaldiginda deger
  -- 999.999'dur, 1.000.000 DEGIL. Asagi yuvarlamak curve kapanmadan %100
  -- gostermek olurdu.
  (1000000 - ceil(cs.real_token_reserves_tok * 1000000::numeric / d.sale_supply_tok))::integer
    AS progress_ppm,

  -- GRADUATION RAISE = mulDiv(V, S, T-S), floor. `deployment`tan gelir, yani
  -- her token icin AYNIDIR; view'da durmasinin sebebi tuketicinin ikinci bir
  -- sorgu yapmak zorunda kalmamasidir.
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
  -- ZAMAN KOLONLARI YALNIZCA GOSTERIM ICIN. Siralama `_seq` uzerindedir;
  -- gerekce `queries.ts`te ve olculdu (ardisik bloklarin ~%49'u ayni
  -- timestamp'i tasir).
  ts.last_trade_at,
  ts.last_buy_at,
  l.created_seq,
  l.created_at
FROM launches l
JOIN curve_state cs ON cs.token = l.token
JOIN token_stats ts ON ts.token = l.token
CROSS JOIN deployment d;
