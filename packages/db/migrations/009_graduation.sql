-- GRADUATION -- TERMINAL DURUM, TICARET DURUMU DEGIL.
--
-- NEDEN AYRI BIR SUTUN KUMESI VE NEDEN `complete` YETMEZ. Ikisi FARKLI iki
-- olgudur ve canli zincir bunu SU AN gosteriyor: smoke curve
-- `0x7938BE340A14A12f94a83AEa246d9d2566324c9C` `complete = true` AMA mezun
-- DEGIL -- uretim factory'sinde `graduationTarget` sifir, dolayisiyla
-- `graduate()` `0xfe30fa5b` (`GraduationTargetUnset`) ile revert eder. Yani
-- "satis arzi bitti" ile "curve artik hicbir sey fiyatlamiyor" arasinda
-- gercek bir zaman araligi vardir ve bu aralik boyunca iki durum ayni satirda
-- ayirt edilebilir olmak zorundadir.
--
-- BUNUN OKUMA MODELINDEKI KARSILIGI BIR YALANI ONLEMEKTIR. `token_overview`
-- `price_wei_per_tok` ve `market_cap_wei` degerlerini curve'un SANAL
-- rezervlerinden turetir. Mezuniyetten sonra o rezervler DONAR: son ticaretin
-- biraktigi fiyat, sonsuza kadar, ve hicbir sey onun artik canli olmadigini
-- SOYLEMEZ. `graduated` bayragi, arayuzun "bu curve kapandi" diyebilmesi icin
-- gereken tek alandir -- `complete AND (havuz var mi?)` gibi IKI YERDE
-- kurulan bir bilesim degil (bu depo o siniftan bir kusuru zaten kaydetti:
-- `marketCap -> tierFor` iki cagri yerinde besteleniyor).
--
-- OLAY: `BondingCurve.sol:283`
--   `Graduated(address indexed token, address indexed to,
--              uint256 baseAmount, uint256 quoteAmount)`
-- `baseAmount` = `poolSeedSupply`, `quoteAmount` = `realQuoteReserves`
-- (`BondingCurve.sol:892-893` -- DEFTERDEN VE IMMUTABLE'DAN, hicbir bakiyeden
-- degil). Ikisini de saklamak "olmasi gerekeni" degil "GERCEKTEN odeneni"
-- kaydeder; `Completed`in tasidigi degerlerden turetmek, odemenin ayni sayilar
-- uzerinde gerceklestigini VARSAYMAK olurdu.
ALTER TABLE curve_state
  ADD COLUMN graduated             boolean NOT NULL DEFAULT false,
  ADD COLUMN graduated_seq         bigint,
  -- `_addr` soneki ADLANDIRMA KAPISININ bildirilmis soneklerinden biridir
  -- (`token_transfers.from_addr`/`to_addr` ile ayni). `graduation_target`
  -- soneksiz olurdu ve kapi -- dogru olarak -- onu reddederdi.
  ADD COLUMN graduation_target_addr text CHECK (graduation_target_addr ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN graduation_base_tok   numeric(78,0),
  ADD COLUMN graduation_quote_wei  numeric(78,0);

-- BAYRAK VE YUK BIRLIKTE YASAR. `completed_iff_seq`in aynisi: bir satir ya
-- mezundur ve DORT alani da doludur, ya degildir ve DORDU DE bostur. Yarim
-- yazilmis bir mezuniyet -- ornegin bir uygulayicinin `graduated = true`
-- yazip tutari yazmayi unutmasi -- sema duzeyinde imkansiz olur.
ALTER TABLE curve_state
  ADD CONSTRAINT graduated_iff_seq
    CHECK (graduated = (graduated_seq IS NOT NULL)),
  ADD CONSTRAINT graduated_iff_payout
    CHECK (graduated = (graduation_target_addr IS NOT NULL)
       AND graduated = (graduation_base_tok IS NOT NULL)
       AND graduated = (graduation_quote_wei IS NOT NULL));

-- ZINCIRIN KENDI ON KOSULU, SEMADA.
--
-- `graduate()` ILK isi olarak `if (!complete) revert NotComplete()` yapar
-- (`BondingCurve.sol:884`), yani `graduated => complete` zincirde YAPISAL
-- olarak dogrudur. Burada tekrarlanmasinin sebebi suslemek degil: uygulama
-- yolu `Completed`i KACIRMIS olsaydi (bir aralik dusuruldu, bir filtre
-- bozuldu), `Graduated` sessizce yazilir ve satir "mezun ama tamamlanmamis"
-- diye -- zincirde var olamayan bir durumda -- kalirdi. Kisit onu GURULTULU
-- bir islem hatasina cevirir; bu depoda sessiz kayip her zaman daha pahaliya
-- mal oldu.
ALTER TABLE curve_state
  ADD CONSTRAINT graduated_implies_complete CHECK (NOT graduated OR complete);

-- Mezun curve'lari taramak icin. Kismi indeks: mezun olanlar her zaman
-- azinliktir ve tam indeks her satiri tasirdi.
CREATE INDEX curve_state_graduated_idx ON curve_state (graduated_seq DESC) WHERE graduated;

-- ---------------------------------------------------------------------------
-- OKUMA MODELI: `token_overview` 007'nin tanimini SUPERSEDE EDER.
--
-- `CREATE OR REPLACE VIEW` yeni sutunlari yalnizca SONA ekleyebilir; graduation
-- alanlarini `complete`/`completed_seq`in yanina koyabilmek icin view
-- dusurulup yeniden kuruluyor. Govde 007'dekiyle BIREBIR aynidir, ayni
-- gerekcelerle ve ayni yuvarlama yonuyle -- tek fark bes yeni sutun.
-- ---------------------------------------------------------------------------
DROP VIEW token_overview;

CREATE VIEW token_overview AS
SELECT
  l.token,
  l.curve,
  l.name,
  l.symbol,
  l.uri,
  l.launch_creator,
  -- UCRETI ALAN creator, ilgili ANDAKI hali (`launches.launch_creator` "kim
  -- baslatti" olgusudur ve degismez).
  creator_at(l.token, COALESCE(cs.last_seq, l.created_seq)) AS fee_creator,

  cs.virtual_token_reserves_tok,
  cs.virtual_quote_reserves_wei,
  cs.real_token_reserves_tok,
  cs.real_quote_reserves_wei,
  cs.complete,
  cs.completed_seq,
  cs.pool_seed_supply_tok,

  -- TERMINAL DURUM. `complete`ten AYRI cikar cunku AYRI bir olgudur; arayuz
  -- "son ticaretin fiyatini canli gibi gosterme" kararini TEK bir alana
  -- bakarak verir.
  cs.graduated,
  cs.graduated_seq,
  cs.graduation_target_addr,
  cs.graduation_base_tok,
  cs.graduation_quote_wei,

  -- MARKET CAP = mulDiv(Vq, N, Vt), floor.
  --
  -- MEZUNIYETTEN SONRA BU SAYI CURVE'UN SON DEGERIDIR, CANLI BIR FIYAT DEGIL.
  -- Sutun yine de doludur ve olmalidir: fiyat gecmisi mezuniyette KOPMAZ
  -- (spec 6.2) ve son curve degeri o gecmisin son noktasidir. Onu NULL yapmak
  -- veriyi silmek olurdu; `graduated` ise onu ETIKETLER.
  div(cs.virtual_quote_reserves_wei * d.total_supply_tok, cs.virtual_token_reserves_tok)::numeric(
    78, 0
  ) AS market_cap_wei,

  -- FIYAT: TAM bir token (1e18 taban birimi) kac wei.
  div(cs.virtual_quote_reserves_wei * 1000000000000000000::numeric, cs.virtual_token_reserves_tok)::numeric(
    78, 0
  ) AS price_wei_per_tok,

  -- GRADUATION ILERLEMESI, milyonda pay. TANIM: SATILAN token orani, `sold/S`
  -- -- toplanan quote orani DEGIL (`quoteBuyCost` her alimda bir wei fazla
  -- toplar, canli smoke'ta sekiz wei), ve KALAN yukari yuvarlanir.
  (1000000 - ceil(cs.real_token_reserves_tok * 1000000::numeric / d.sale_supply_tok))::integer
    AS progress_ppm,

  -- GRADUATION RAISE = mulDiv(V, S, T-S), floor. `deployment`tan gelir.
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
  -- ZAMAN KOLONLARI YALNIZCA GOSTERIM ICIN. Siralama `_seq` uzerindedir.
  ts.last_trade_at,
  ts.last_buy_at,
  l.created_seq,
  l.created_at
FROM launches l
JOIN curve_state cs ON cs.token = l.token
JOIN token_stats ts ON ts.token = l.token
CROSS JOIN deployment d;
