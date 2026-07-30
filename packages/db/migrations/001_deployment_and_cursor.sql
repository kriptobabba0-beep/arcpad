-- Uygulanan migration'lar. runMigrations bunu kendisi de olusturur (islemin
-- DISINDA, bilerek: bir migration patlayip transaction geri alindiginda bu
-- tablonun kendisi de yok olsaydi, "hicbiri uygulanmadi" iddiasi
-- `SELECT count(*)` ile DOGRULANAMAZDI -- sorgu "relation does not exist" ile
-- patlardi ve testin gectigi sey baska bir sey olurdu).
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Bu veritabaninin HANGI dagitimi indexledigi. Tekil satir.
--
-- NICIN AYRI BIR TABLO: `V` (sanal quote rezervi) testnet ile uretim
-- arasindaki TEK farktir (spec 5.3, tam 1000x). Ayni Postgres'e iki profilin
-- verisini karistirmak, market cap'i 1000 kat yanlis gosterir ve HICBIR
-- kontrol bunu yakalamaz. Bu yuzden acilista uyusmazlik HALT sebebidir.
CREATE TABLE deployment (
  id                          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chain_id                    bigint  NOT NULL,
  factory                     text    NOT NULL CHECK (factory  ~ '^0x[0-9a-f]{40}$'),
  escrow                      text    NOT NULL CHECK (escrow   ~ '^0x[0-9a-f]{40}$'),
  protocol_treasury           text    NOT NULL CHECK (protocol_treasury ~ '^0x[0-9a-f]{40}$'),
  -- Profil. Zincirden okunur (factory'nin public immutable'lari), ASLA
  -- .env'den veya spec'ten kopyalanmaz.
  virtual_token_reserves_tok  numeric(78,0) NOT NULL CHECK (virtual_token_reserves_tok > 0),
  virtual_quote_reserves_wei  numeric(78,0) NOT NULL CHECK (virtual_quote_reserves_wei > 0),
  sale_supply_tok             numeric(78,0) NOT NULL CHECK (sale_supply_tok > 0),
  -- Butun arz. LaunchToken.TOTAL_SUPPLY = 1e27 (1 milyar token, 18 decimal).
  -- Dogrulandi: contracts/src/LaunchToken.sol @26ce330 satir 18 ve 46 --
  -- `uint256 constant LAUNCH_TOKEN_TOTAL_SUPPLY = 1_000_000_000e18`.
  total_supply_tok            numeric(78,0) NOT NULL,
  -- Factory'nin deploy edildigi blok. Ingest buradan baslar; daha erken bir
  -- bloktan baslamak yalnizca bos aralik tarar, daha GEC baslamak launch
  -- KAYBEDER ve bu geri alinamaz (kayip launch'in Transfer'lari da hic
  -- gelmez, cunku token adresi hic ogrenilmez).
  start_block                 bigint  NOT NULL,
  CONSTRAINT sale_supply_below_token_reserves
    CHECK (sale_supply_tok < virtual_token_reserves_tok)
);

-- Imlec. `deployment`'tan AYRI, cunku biri kurulum digeri ilerleme.
CREATE TABLE sync_state (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block   bigint      NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
