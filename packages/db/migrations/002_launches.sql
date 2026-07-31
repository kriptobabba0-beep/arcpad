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
  -- GOSTERIM metni. `pgSafeText`'ten gecmistir, yani Postgres'e giremeyen kod
  -- birimleri U+FFFD olmustur. GERI DONULEMEZ bir eslemedir; provenance
  -- asagidaki `*_hex` sutunlarindadir.
  name            text NOT NULL CHECK (length(name)   BETWEEN 1 AND 32),
  symbol          text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 13),
  uri             text NOT NULL CHECK (length(uri)    <= 200),
  -- ZINCIRDEKI HAM BAYTLAR. NICIN AYRI SUTUN OLARAK PARA ODUYORUZ:
  --
  -- Token kimligi CREATE2 ile TURETILIR ve turetme HAM baytlar uzerindendir:
  --   CREATE2(factory, salt, keccak(creationCode ++
  --           abi.encode(name, symbol, metadataURI, creator, curve, launchSalt)))
  -- `LaunchFactory.isCanonical` (contracts/src/LaunchFactory.sol:925 @26ce330)
  -- tam olarak bunu yeniden hesaplar. `pgSafeText` COKA-BIR bir eslemedir --
  -- zincirdeki AYRI iki isim, `a<U+0000>b` ve `a<U+FFFD>b`, ayni gosterim
  -- metnine duser. Yalnizca gosterim metnini saklayan bir veritabani, dusman
  -- metinli bir launch icin token adresini YENIDEN TURETEMEZ, yani canonicity
  -- yalnizca veritabanina bakarak DOGRULANAMAZ hale gelir.
  --
  -- Sinirlar BAYT cinsindendir ve zincirin kendi sinirlaridir (LaunchToken.sol
  -- :31-33 @26ce330: 32 / 13 / 200 BYTE). Gosterim sutunlarindaki `length()`
  -- KARAKTER sayar; buradaki desen BAYT sayar, yani ikisi birlikte zincirin
  -- kisitini iki yonden de sabitler.
  name_hex        text NOT NULL CHECK (name_hex   ~ '^0x([0-9a-f]{2}){1,32}$'),
  symbol_hex      text NOT NULL CHECK (symbol_hex ~ '^0x([0-9a-f]{2}){1,13}$'),
  uri_hex         text NOT NULL CHECK (uri_hex    ~ '^0x([0-9a-f]{2}){0,200}$'),
  salt            text NOT NULL CHECK (salt ~ '^0x[0-9a-f]{64}$'),
  created_seq     bigint NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL,
  tx_hash         text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- EIP-7708 DUVARINI KOSULSUZ YAPAN SATIRLAR.
  --
  -- `token_transfers.token` ve `holders.token` `launches(token)`a yabanci
  -- anahtardir, yani native USDC'nin `Transfer` loglari oraya giremez. AMA bu
  -- duvarin gucu `launches`in TEMIZ olmasina baglidir ve `launches`i temiz
  -- tutan tek sey Task 6'nin provenance dogrulamasi -- HENUZ YAZILMAMIS bir
  -- kod. Gozden gecirme bunu calistirarak gosterdi: desen kontrolu
  -- 0x3600...0000'i kabul ediyor ve satir temiz giriyordu.
  --
  -- Bu iki kisit, garantiyi yazilmamis koddan BAGIMSIZ kilar ve Task 6 nasil
  -- evrilirse evrilsin gecerli kalir.
  --   0x3600...0000  Arc'in native USDC ERC-20'si (canli testnette dogrulandi:
  --                  symbol USDC, decimals 6, chainId 5042002). 6 decimal
  --                  gorunum; bir launch token'i ASLA degildir.
  --   0x0000...0000  Sifir adres. `applyTransfer` onu "holder degil" diye
  --                  ozel isler; bir launch kimligi olmasi o mantigi bozardi.
  CONSTRAINT launches_token_is_not_a_system_address CHECK (
    token NOT IN ('0x0000000000000000000000000000000000000000',
                  '0x3600000000000000000000000000000000000000')),
  CONSTRAINT launches_curve_is_not_a_system_address CHECK (
    curve NOT IN ('0x0000000000000000000000000000000000000000',
                  '0x3600000000000000000000000000000000000000'))
);
CREATE INDEX launches_creator_created_idx ON launches (launch_creator, created_seq DESC);
CREATE INDEX launches_created_idx        ON launches (created_seq DESC);

-- REDDEDILEN launch'lar. Bos kalmasi BEKLENIR (asagi).
--
-- `token` ve `curve` burada BILEREK kisitsizdir: reddedilmis bir launch'un
-- adresleri tanim geregi guvenilmezdir ve onlara `launches`'in desenini
-- dayatmak, kaydin var olma amacini -- elle inceleme -- ortadan kaldirirdi.
-- Bunlar semada adres tasiyip da korunmayan TEK iki sutundur ve
-- `constraints.test.ts` istisnayi ISMIYLE sabitler.
--
-- HAM LOG NEDEN `jsonb` DEGIL: onceki hali `raw jsonb NOT NULL` idi ve
-- `launches`'ta kapatilan U+0000 kamasini bir tablo oteye tasiyordu. Bir
-- launch'i reddeden sey zaten ONUN dusman metni olacaktir, yani bu tablo tam
-- olarak o yuku almak icin vardir. Olculdu (Postgres 17.9):
--   SELECT to_jsonb('a'||chr(0)||'b');   -> ERROR: null character not permitted
--   '{"name":"a<U+0000>b"}'::jsonb       -> ERROR: unsupported Unicode escape sequence
--   '{"name":"a<U+0000>b"}'::json        -> KABUL EDILIR
--   (...::json)->>'name'                 -> ERROR (ayni hata, CIKARMA aninda)
-- Yani `json`'a gecmek kamayi KALDIRMAZ, cikarma zamanina ERTELER. Ve
-- `pgSafeText` bunu kapatamaz: o, uc ADLI metin alanina uygulanan bir dizge
-- fonksiyonudur; serbest bicimli bir belgeye uygulanamaz.
--
-- Cozum YAPISALDIR: ham EVM logu ZATEN saf onaltiliktir (adres, topic'ler,
-- data). Tabloya cozulmus metin koyulabilecek bir yer BIRAKILMIYOR, boylece
-- kama "olmamali" degil "OLAMAZ" hale geliyor. Cozulmus isme ihtiyaci olan
-- inceleyici onu `raw_data_hex`'ten kendisi cozer.
CREATE TABLE rejected_launches (
  created_seq     bigint PRIMARY KEY,
  token           text NOT NULL,
  curve           text NOT NULL,
  -- SABIT BIR ETIKET, serbest metin DEGIL. Kisitsiz birakildiginda ayni
  -- U+0000 kamasini tasiyordu (sunucu tarafinda SQLSTATE 22021, islem geri
  -- alinir, indexer o blokta takilir) ve `reason` tam olarak bir Task 6
  -- yazarinin cozulmus ismi icine yerlestirecegi yerdir:
  -- `'name mismatch: ' || name`. Desen bunu IMKANSIZ kilar; ayrintiyi
  -- tasiyacak yer `raw_data_hex`tir.
  reason          text NOT NULL CHECK (reason ~ '^[a-z_]{1,64}$'),
  -- Yerel CREATE2 turetmesinin verdigi adres. BIZIM urettigimiz deger oldugu
  -- icin, `token`/`curve`'un aksine, bicimi garantidir ve zorlanir.
  expected        text NOT NULL CHECK (expected ~ '^0x[0-9a-f]{40}$'),
  -- Ham logun uc parcasi. Hepsi onaltilik; hicbiri metin tasiyamaz.
  raw_addr        text NOT NULL CHECK (raw_addr ~ '^0x[0-9a-f]{40}$'),
  -- Virgulle birlestirilmis topic'ler. Bir EVM logunda EN COK DORT topic olur.
  raw_topics_hex  text NOT NULL
                  CHECK (raw_topics_hex ~ '^(0x[0-9a-f]{64}(,0x[0-9a-f]{64}){0,3})?$'),
  raw_data_hex    text NOT NULL CHECK (raw_data_hex ~ '^0x([0-9a-f]{2})*$'),
  seen_at         timestamptz NOT NULL DEFAULT now()
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
