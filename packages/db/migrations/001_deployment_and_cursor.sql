-- Uygulanan migration'lar. runMigrations bunu kendisi de olusturur (islemin
-- DISINDA, bilerek: bir migration patlayip transaction geri alindiginda bu
-- tablonun kendisi de yok olsaydi, "hicbiri uygulanmadi" iddiasi
-- `SELECT count(*)` ile DOGRULANAMAZDI -- sorgu "relation does not exist" ile
-- patlardi ve testin gectigi sey baska bir sey olurdu).
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename      text PRIMARY KEY,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  -- Uygulandigi ANDAKI dosya iceriginin sha256'si. `runMigrations` uygulanmis
  -- bir dosyanin icerigi DEGISTIYSE calismayi reddeder.
  --
  -- NICIN VAR: bu dosyalar bir kez uygulandiktan sonra duzenlenebiliyor ve
  -- duzenleme SESSIZ kaliyordu -- defterde ad var, icerik baska. Bir gozden
  -- gecirenin kendi kumesinde 002'nin eski halini uygulamis olmasi yeterliydi:
  -- sonraki kosu hicbir sey yapmadan yesil doner ve o veritabani semanin
  -- ESKI halini tasimaya devam eder. Ozet, bunu gurultulu bir hataya cevirir.
  checksum_hex  text
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
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block       bigint      NOT NULL,
  -- `last_block`'un HASH'I. Bir sonraki turun ilk blogunun `parentHash`'i
  -- buna esit olmak ZORUNDA; degilse uzerine insa ettigimiz zincir
  -- degismistir.
  --
  -- NICIN VAR -- ve BU BIR ONARIM DEGIL, BIR IDDIADIR:
  --
  -- Keeper, zincirdeki `launchCount()` slotunu biriktirdigi `Launched`
  -- loglariyla karsilastiriyor. Reorg'la disari dusmus bir bloktan kalan bir
  -- kayit o kumeyi FAZLA saydirir, ve keeper bunu bulundugu yerden
  -- ENGELLEYEMEZ. Engelleme, verinin kuruldugu yere -- buraya -- aittir ve
  -- `Launched`a degil HER olay tipine uygulanmalidir; bu yuzden muhafiz
  -- olaylara degil BLOKLARA takilidir.
  --
  -- Arc'ta ~350ms deterministik finality var ve reorg OLMADIGI belgeli;
  -- ustelik ingest yalnizca `finalized` etiketinden okuyor (bkz.
  -- indexer/src/cursor.ts `finalizedHead`). Yani bu satirin yakalayacagi sey
  -- ZATEN OLMAMALI. Buna ragmen SESSIZ bir varsayim birakmak bu projenin
  -- tekrar tekrar dustugu ariza kipidir, ve varsayim bos degil: OLCULDU ki
  -- `finalized` iki okuma arasinda GERIYE dusebiliyor ve `latest`in ONUNDE
  -- gorulebiliyor -- yani "finalized" gorunumu dugumden dugume tutarli DEGIL.
  --
  -- Secim bilincli: KENDINI ONARAN bir geri sarma (belirli bir derinligin
  -- ustundeki satirlari sil, imleci geri al) YAZILMADI. Reorg uretmeyen bir
  -- zincirde o kodu HICBIR SEY egzersiz etmez -- yani bu projenin adini
  -- koydugu "hicbir seyin calistirmadigi kod yolu" olurdu, ve daha kotusu,
  -- GUVENILIRDI. Onun yerine bag kontrolu bir HATA firlatir ve ingest DURUR.
  -- Duran bir indexer operator tarafindan kurtarilabilir; sessizce yanlis bir
  -- veritabani kurtarilamaz. Ve iddianin kendisi BUGUN test edilebilir:
  -- bagi bozup muhafizin patladigini gostermek bir RPC gerektirmez.
  last_block_hash  text NOT NULL CHECK (last_block_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
