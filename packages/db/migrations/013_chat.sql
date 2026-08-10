-- ==========================================================================
--  HOLDER-GATED CHAT (spec §6.2, §7.1, Faz 6)
-- ==========================================================================
--
-- BU TABLONUN YAZICISI INDEXER DEGIL, `web`IN POST ROTASIDIR. Sema'daki her
-- oteki tablo bir zincir olayindan turer ve `(tx_hash, log_index)` uzerinde
-- idempotent yazilir; burada oyle bir capa YOKTUR. Satirlar kullanicidan
-- gelir, yani bu dosyanin isi bir olayi kaydetmek degil, ZINCIRDE KARSILIGI
-- OLMAYAN bir veriye zincirin sagladigi kadar delil iliştirmektir.
--
-- ==========================================================================
--  SIRA: `message_seq`, VE NEDEN BIR ZAMAN DAMGASI DEGIL
-- ==========================================================================
--
-- Deponun her yerinde sira `event_seq`tir, cunku Arc'ta ardisik bloklarin
-- %49,0'i AYNI timestamp'i tasir (553 cift uzerinde olculdu) ve `ORDER BY
-- ..._at` siralamanin yarisini TANIMSIZ birakir; kararsiz sira keyset
-- sayfalamada satir TEKRARLATIR VE ATLATIR.
--
-- CHAT MESAJLARININ `event_seq`I YOKTUR: bir blok numarasi ve bir log indeksi
-- yoktur, cunku zincire hic dokunmazlar. Yani ayni ariza kipine ayni carenin
-- BASKA bir kaynaktan uretilmesi gerekiyor. `created_at` o kaynak DEGILDIR:
-- `now()` bir transaction icinde SABITTIR, yani tek bir istekte yazilan iki
-- satir birebir ayni damgayi tasir, ve iki ayri istek de mikrosaniye
-- cozunurlugunde esitlenebilir. Damga TAM SIRA VERMEZ.
--
-- `GENERATED ALWAYS AS IDENTITY` verir: degeri Postgres'in dizisi uretir,
-- BIREBIRDIR (birincil anahtar) ve monotondur. Dolayisiyla
-- `ORDER BY message_seq DESC` TAM bir siradir ve `message_seq < $imlec`
-- keyset'i tek bir karsilastirmayla tanimlar -- `holders`in iki parcali
-- imlecine ya da aramanin `search_key` paketlemesine gerek YOKTUR, cunku
-- birinci anahtar zaten tekrarsizdir.
--
-- SINIRI DA YAZILI: dizi degeri INSERT aninda alinir, GORUNURLUGU ise COMMIT
-- aninda dogar. Yani gorunen dizide BOSLUK olabilir ve daha kucuk bir
-- `message_seq` daha GEC gorunur olabilir. Yeniden-eskiye sayfalamada bu bir
-- kayip DEGILDIR (gec gorunen kucuk seq yine `< imlec` kosulunu saglar ve bir
-- sonraki sayfada cikar); kaybettirecegi tek okuma bicimi "bana X'ten YENI
-- olan her seyi ver" seklinde bir yoklamadir ve bu fazda oyle bir okuma
-- YOKTUR. Eklenirse bu paragraf onun sartnamesidir.

CREATE TABLE chat_messages (
  message_seq   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- YABANCI ANAHTAR BILEREK: bir chat mesaji yalnizca INDEKSLENMIS BIR
  -- LAUNCH'a asilabilir. Olmasaydi POST rotasi rastgele 20 baytlik her adres
  -- icin satir uretebilir, tabloyu zincirle hicbir ilgisi olmayan anahtarlarla
  -- sisirebilirdi. Kisit 23503 ile GURULTULU biter; rota onu 404'e cevirir.
  token         text NOT NULL REFERENCES launches(token),

  -- YAZAR. `_addr`: bir adres, bir miktar degil (adlandirma kapisi).
  -- Bu deger ISTEMCININ IDDIASI DEGILDIR: rota `signature_hex`ten kurtarilan
  -- adresle karsilastirir ve esitlemezse satir hic yazilmaz.
  author_addr   text NOT NULL CHECK (author_addr ~ '^0x[0-9a-f]{40}$'),

  -- GOVDE, IMZALANMIS HALIYLE. Tek bir karakteri bile degistirilemez:
  -- `signature_hex` tam olarak bu dizenin uzerindedir, yani govdeyi
  -- "temizlemek" (link'i soymak, U+0000'i U+FFFD yapmak) satirin kendi
  -- delilini gecersiz kilardi. Bu yuzden temizleme YOKTUR ve rota kabul
  -- edilemez bir govdeyi REDDEDER. `pgSafeText` bu sutuna UYGULANMAZ.
  --
  -- IKI SINIR, IKI BIRIM, VE IKINCISININ SAYISI OLCULEREK SECILDI.
  --
  -- `length` KARAKTER (kod noktasi) sayar, `octet_length` BAYT. ILK DENEMEDE
  -- bayt tavani 2000 yazilmisti ve o kisit ULASILAMAZDI: UTF-8'de bir kod
  -- noktasi EN COK 4 bayttir, yani `length <= 500` zaten `octet_length <= 2000`
  -- demektir. Kosturularak gorundu -- 501 emoji'lik govde bayt kisitini degil
  -- KARAKTER kisitini kiriyordu (`chat_messages_body_check`), yani ikinci
  -- kisit hicbir girdiyle tetiklenemiyordu. "Bir seyi kontrol ediyor gibi
  -- duran ama hicbir seyi reddedemeyen kisit" tam olarak bu deponun
  -- yasakladigi sey.
  --
  -- 1000 bayt ULASILABILIR ve AYRI bir sinirdir: 500 ASCII karakter gecer
  -- (500 bayt), 251 emoji GECMEZ (1004 bayt) -- 251 karakter oldugu halde.
  -- Sinirladigi sey depolama ve bant genisligi maliyeti, ki o baytla olculur.
  body          text NOT NULL
                  CHECK (length(body) BETWEEN 1 AND 500)
                  CHECK (octet_length(body) <= 1000),

  -- ==================================================================
  --  GONDERI ANINDAKI BAKIYE -- SPEC'IN UCUNCU KARSI-ONLEMI
  -- ==================================================================
  -- `> 0` KISITI KAPININ KENDISIDIR, SEMAYA YAZILMIS HALI. Bakiyesi sifir
  -- olan bir yazarin satiri veritabanina GIREMEZ; rotanin kontrolu duserse
  -- ya da atlanirsa 23514 ile durur. Uygulama katmanindaki bir `if`in tek
  -- basina tasiyamayacagi tek sey budur.
  balance_tok   numeric(78,0) NOT NULL CHECK (balance_tok > 0),

  -- BAKIYENIN OLCULDUGU BLOK. Bu sutun olmadan `balance_tok` DOGRULANAMAZ
  -- bir iddiadir: `balanceOf` gecmis bir deger icin bir archive node ister ve
  -- hangi blogun sorulacagi bilinmeden o da sorulamaz. Ikisi birlikte satiri
  -- bagimsizca yeniden olculebilir kilar.
  balance_block_number bigint NOT NULL CHECK (balance_block_number >= 0),

  -- ==================================================================
  --  TEKRAR OYNATMA (REPLAY) KAPISI
  -- ==================================================================
  -- Bir imza SONSUZA KADAR gecerlidir; imzayi goren herkes ayni govdeyi
  -- yeniden gonderebilir. UNIQUE burasi o saldirinin durdugu yerdir: ayni
  -- nonce ikinci kez yazilamaz (23505), ve nonce imzalanan metnin ICINDEDIR,
  -- yani saldirgan onu degistirip imzayi koruyamaz.
  --
  -- Bu kisit TEK BASINA yetmez ve niye yetmedigi yazili: veritabani sifirlansa
  -- eski imzalar yeniden gecerli olurdu. Ikinci kat `issued_at` penceresidir
  -- ve rotada uygulanir.
  nonce_hex     text NOT NULL UNIQUE CHECK (nonce_hex ~ '^0x[0-9a-f]{64}$'),

  -- IMZANIN KENDISI SAKLANIR. 65 bayt karsiliginda satir BAGIMSIZCA
  -- DOGRULANABILIR olur: (chain_id, token, author, nonce, issued, body)
  -- yeniden kurulur, imza ondan kurtarilir ve `author_addr` cikmali. Yani
  -- "biz kontrol ettik" bir guven ifadesi degil, tekrarlanabilir bir olcumdur.
  -- 0x + 65 bayt (r,s,v).
  signature_hex text NOT NULL CHECK (signature_hex ~ '^0x[0-9a-f]{130}$'),

  -- IMZALAYANIN BEYAN ETTIGI AN (imzalanan metnin icinde). Rota bunu SUNUCU
  -- saatine karsi bir pencereyle sinirlar. SIRALAMA ICIN KULLANILMAZ.
  issued_at     timestamptz NOT NULL,

  -- SUNUCUNUN yazdigi an. Gosterim ve hiz siniri icin; SIRALAMA ICIN DEGIL.
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- SAYFALAMANIN TA KENDISI: `WHERE token = $1 AND message_seq < $2
-- ORDER BY message_seq DESC` bu indeksi siralama YAPMADAN tarar.
CREATE INDEX chat_messages_token_seq_idx ON chat_messages (token, message_seq DESC);

-- HIZ SINIRI ICIN. `created_at` burada bir SUZGECTIR, bir SIRA degil --
-- migration 003'un `block_time` icin blesledigi ayirimin aynisi: esit
-- timestamp'ler pencere sorgusunu bozmaz, siralamayi bozar.
CREATE INDEX chat_messages_author_recent_idx
  ON chat_messages (token, author_addr, created_at DESC);

-- Bir yazarin butun mesajlari (profil / moderasyon icin ileride).
CREATE INDEX chat_messages_author_idx ON chat_messages (author_addr, message_seq DESC);
