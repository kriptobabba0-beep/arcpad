-- KABUL EDILMIS launch'lar. Bu tabloya giren her satirin provenance'i
-- Task 6'da dogrulanmistir. Dogrulanmamis bir token BURAYA GIRMEZ.
--
-- UZUNLUK KISITLARI ZINCIRDE ZORLANIYOR, dogrulandi (varsayilmadi):
--   contracts/src/LaunchToken.sol @26ce330 satir 31-33 ve 103-105
--     MAX_NAME_LENGTH = 32, MAX_SYMBOL_LENGTH = 13, MAX_URI_LENGTH = 200
--     ve constructor uzunlugu asani NameTooLong/SymbolTooLong/UriTooLong ile
--     REVERT eder.
--   contracts/src/LaunchFactory.sol @26ce330 satir 660-661
--     bos name ve bos symbol EmptyName/EmptySymbol ile revert eder.
-- Yani hicbir zincir-mesru launch bu CHECK'lere takilamaz. Bu onemli: takilan
-- bir CHECK, ingest islemini geri alir ve indexer'i o blokta SONSUZA KADAR
-- kilitler -- yani bir veri-kalitesi iddiasi bir liveness arizasina donerdi.
-- (Zincir BYTE sayar, Postgres `length()` KARAKTER sayar; karakter sayisi
-- byte sayisini asla asamaz, bu yuzden esitsizlik guvenli yonde.)
CREATE TABLE launches (
  token           text PRIMARY KEY CHECK (token ~ '^0x[0-9a-f]{40}$'),
  curve           text NOT NULL UNIQUE CHECK (curve ~ '^0x[0-9a-f]{40}$'),
  -- LAUNCH ANINDAKI creator. Kalicidir: "kim baslatti" olgusu degismez.
  -- Ucreti fiilen ALAN cuzdan bu DEGILDIR; o `creator_history`'dedir.
  launch_creator  text NOT NULL CHECK (launch_creator ~ '^0x[0-9a-f]{40}$'),
  name            text NOT NULL CHECK (length(name)   BETWEEN 1 AND 32),
  symbol          text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 13),
  uri             text NOT NULL CHECK (length(uri)    <= 200),
  salt            text NOT NULL CHECK (salt ~ '^0x[0-9a-f]{64}$'),
  created_seq     bigint NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL,
  tx_hash         text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$')
);
CREATE INDEX launches_creator_created_idx ON launches (launch_creator, created_seq DESC);
CREATE INDEX launches_created_idx        ON launches (created_seq DESC);

-- REDDEDILEN launch'lar. Bos kalmasi BEKLENIR (asagi).
--
-- `token` ve `curve` burada BILEREK kisitsizdir: reddedilmis bir launch'un
-- adresleri tanim geregi guvenilmezdir ve onlara `launches`'in desenini
-- dayatmak, kaydin var olma amacini -- elle inceleme -- ortadan kaldirirdi.
CREATE TABLE rejected_launches (
  created_seq  bigint PRIMARY KEY,
  token        text   NOT NULL,
  curve        text   NOT NULL,
  reason       text   NOT NULL,
  expected     text   NOT NULL,   -- yerel CREATE2 turetmesinin verdigi adres
  raw          jsonb  NOT NULL,   -- ham log, elle inceleme icin
  seen_at      timestamptz NOT NULL DEFAULT now()
);

-- Ucreti ALAN creator'in ZAMANA GORE tarihi.
--
-- NICIN BUGUN VAR, arcpad'in creator'i DEGISTIRILEMEZ oldugu halde:
-- `BondingCurve.creator` ve `LaunchToken.creator` `immutable`'dir ve iki
-- kontratta da atama YALNIZCA constructor'dadir (dogrulandi:
-- `grep -n "creator\s*=" contracts/src/*.sol` uc satir dondurur, ucu de
-- constructor icinde). Ayrica Surface.t.sol olay kumesini iki yonlu
-- sabitliyor, yani bir `CreatorUpdated` olayi BUGUN YOKTUR.
--
-- AMA pump.fun'da curve creator'i DORT ayri yetki yoluyla degisir
-- (`set_creator`, `admin_set_creator`, `set_metaplex_creator`,
-- `migrate_bonding_curve_creator`) ve her biri `SetCreatorEvent` yayar; spec
-- 5.7 arcpad'in creator'inin ucret alici cuzdanini degistirebilecegini
-- soyluyor ve Faz 1c'nin devir listesi bu yolu Faz 1d'ye birakiyor.
--
-- Bu tablo o gunun migration'ini VERI degisikligine indirir: sema, view ve
-- sorgular ayni kalir, yalnizca yeni satirlar gelir. Bugun her token icin
-- TAM BIR satir vardir (launch aninda) ve `creator_at` `launches.creator`'a
-- dejenere olur. Task 7 bu yolu SENTETIK bir satirla BUGUNDEN test eder --
-- yani "hicbir sey egzersiz etmeyen kod yolu" durumu bastan kapatilir.
CREATE TABLE creator_history (
  token     text   NOT NULL REFERENCES launches(token) ON DELETE CASCADE,
  from_seq  bigint NOT NULL,
  creator   text   NOT NULL CHECK (creator ~ '^0x[0-9a-f]{40}$'),
  PRIMARY KEY (token, from_seq)
);

-- `seq` anindaki ucret alicisi. Bugun tek satirlik, yarin cok satirlik.
CREATE FUNCTION creator_at(p_token text, p_seq bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT creator FROM creator_history
  WHERE token = p_token AND from_seq <= p_seq
  ORDER BY from_seq DESC LIMIT 1
$$;
