-- Curve basina CANLI rezerv durumu. `Trade` olayinin dort rezervinden
-- MUTLAK olarak yazilir (artimli DEGIL) -- olay dorduncu de tasidigi icin
-- (BondingCurve.sol:226-237 @26ce330: virtualTokenReserves,
-- virtualQuoteReserves, realTokenReserves, realQuoteReserves) indexer zincire
-- hic sormaz.
CREATE TABLE curve_state (
  -- `launches(curve)`'e YABANCI ANAHTAR. Onceden yalnizca desen kontrolu
  -- vardi, yani sema `launches`'takinden BASKA bir curve adresi tasiyan bir
  -- curve_state satirina izin veriyordu ve `trades.curve` ondan tureyerek
  -- butun islem gecmisini sahte bir curve'e baglayabiliyordu. Yabanci anahtar
  -- bunu imkansiz kilar ve ayni zamanda `launches_curve_is_not_a_system_address`
  -- kisitini BURAYA da tasir -- garanti tek yerde tanimlanip her yere
  -- devrolur.
  curve                       text PRIMARY KEY CHECK (curve ~ '^0x[0-9a-f]{40}$')
                              REFERENCES launches(curve),
  token                       text NOT NULL UNIQUE REFERENCES launches(token),
  virtual_token_reserves_tok  numeric(78,0) NOT NULL,
  virtual_quote_reserves_wei  numeric(78,0) NOT NULL,
  real_token_reserves_tok     numeric(78,0) NOT NULL,
  real_quote_reserves_wei     numeric(78,0) NOT NULL,
  complete                    boolean NOT NULL DEFAULT false,
  completed_seq               bigint,
  -- `Completed` olayindan gelir; Faz 2'nin havuz tohumu. Curve tamamlanana
  -- kadar NULL. (BondingCurve.sol:240 @26ce330:
  -- `Completed(address indexed token, uint256 realQuoteReserves, uint256 poolSeedSupply)`.)
  pool_seed_supply_tok        numeric(78,0),
  -- SIRA MUHAFIZI. Her mutlak yazim yalnizca last_seq'ten BUYUK bir seq ile
  -- yapilir. Bu, yeniden oynatilan ESKI bir olayin YENI durumu ezmesini
  -- imkansiz kilar -- ki at-least-once teslimatta bu kacinilmaz bir vakadir.
  last_seq                    bigint NOT NULL,
  CONSTRAINT completed_iff_seq CHECK ((complete) = (completed_seq IS NOT NULL)),
  CONSTRAINT complete_means_empty CHECK (NOT complete OR real_token_reserves_tok = 0)
);

CREATE TABLE trades (
  event_seq                   bigint PRIMARY KEY,
  block_number                bigint NOT NULL,
  log_index                   integer NOT NULL CHECK (log_index BETWEEN 0 AND 1048575),
  tx_hash                     text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- YALNIZCA gosterim ve 24s penceresi. SIRALAMA ICIN KULLANILMAZ: Arc'ta
  -- ardisik 400 blok cifti olculdu, 197'si (%49,1) AYNI timestamp'i tasiyor.
  block_time                  timestamptz NOT NULL,
  token                       text NOT NULL REFERENCES launches(token),
  curve                       text NOT NULL REFERENCES curve_state(curve),
  trader                      text NOT NULL CHECK (trader ~ '^0x[0-9a-f]{40}$'),
  -- `Trade` TEK bir olaydir ve yonu bu BAYRAKLA tasir; iki ayri olay YOKTUR.
  -- Bayrak INDEKSLI DEGILDIR (BondingCurve.sol:227-228 @26ce330), yani yon bir
  -- topic'ten SUZULEMEZ -- alim/satim ayrimi ancak burada, yazildiktan sonra
  -- yapilabilir.
  is_buy                      boolean NOT NULL,
  -- Ikisi de zincirde sifirdan buyuk garantidir: `buyExactTokensOut` sifir
  -- tokensOut'u ZeroTokensOut ile, `sellExactTokensIn` sifir tokensIn'i
  -- ZeroTokensIn ile, `buyExactQuoteIn` cok kucuk butceyi CurveMath'in
  -- NetTooSmall'u ile reddeder. Yani bu iki CHECK de mesru bir islemi
  -- reddedemez.
  token_amount_tok            numeric(78,0) NOT NULL CHECK (token_amount_tok > 0),
  quote_amount_wei            numeric(78,0) NOT NULL CHECK (quote_amount_wei > 0),
  protocol_fee_wei            numeric(78,0) NOT NULL CHECK (protocol_fee_wei >= 0),
  -- SIFIR OLABILIR ve bu MESRUDUR: creator sifirsa creator payi hic alinmaz
  -- ve protokol payina KATLANMAZ (BondingCurve.sol:545, 580, 639 @26ce330 --
  -- `creator == address(0) ? 0 : ...`). Bir `> 0` CHECK'i sifir-creator'lu
  -- her curve'un her islemini reddederdi.
  creator_fee_wei             numeric(78,0) NOT NULL CHECK (creator_fee_wei >= 0),
  virtual_token_reserves_tok  numeric(78,0) NOT NULL,
  virtual_quote_reserves_wei  numeric(78,0) NOT NULL,
  real_token_reserves_tok     numeric(78,0) NOT NULL,
  real_quote_reserves_wei     numeric(78,0) NOT NULL,
  -- Faz 2'nin havuz islemleri MIGRATION'SIZ girsin diye bugunden aciliyor.
  -- Spec 6.2'nin "bir token graduate oldugunda fiyat gecmisi kopmaz"
  -- gerekcesi budur.
  source                      text NOT NULL DEFAULT 'curve'
                              CHECK (source IN ('curve','pool'))
);
CREATE INDEX trades_token_seq_idx    ON trades (token, event_seq DESC);
CREATE INDEX trades_trader_seq_idx   ON trades (trader, event_seq DESC);
-- 24 saatlik hacim penceresi icin. block_time BURADA mesrudur: pencere
-- filtresidir, siralama degil -- esit timestamp'ler bir aralik filtresini
-- bozmaz.
CREATE INDEX trades_token_time_idx   ON trades (token, block_time DESC);
