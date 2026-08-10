-- ==========================================================================
--  LIMIT ORDERS (spec §6.2 `limit_orders`, §7.1'in `Market | Limit | Orders`
--  serisi, §8'in 1. ve 4. keeper gorevi -- Faz 7)
-- ==========================================================================
--
-- BU TABLONUN SEKLINI BELIRLEYEN SEY BIR OLCUMDUR, BIR TERCIH DEGIL.
--
-- `keeper/test/localchain/custodyProof.ts`, Arc testnet'in bir anvil fork'unda,
-- CANLI kontratlara karsi 21/21 ile sunu olctu (fork blogu 56.199.900):
--
--   * Bir ucuncu taraf curve'e `buyExactQuoteIn` gonderdiginde TOKENLER
--     CAGIRANA gider (230660319445495064646540), emir sahibine SIFIR. Kontrol
--     grubu: ayni cagriyi sahip yapinca tokenler SAHIBE gidiyor -- yani
--     "kimse alamiyor" degil, "ALAN CAGIRANDIR".
--   * Sahip keeper'a SINIRSIZ `approve` verse VE keeper curve'e SINIRSIZ
--     `approve` verse bile, keeper sahibin tokenini satamaz: revert
--     `0xe450d38c` = `ERC20InsufficientBalance`, cunku curve
--     `transferFrom(msg.sender, ...)` yapar. Hasilat da `msg.sender`e gider;
--     olculdu, sahibin native bakiyesi KIMILDAMADI.
--   * Ne `BondingCurve`de ne `ArcpadRouter`da delege yetki tasiyan TEK BIR
--     giris noktasi vardir (15 aday imza zincirde tek tek denendi; pozitif
--     kontrol ayni probe'un gercek girisleri GORDUGUNU gosteriyor).
--
-- SONUC, VE TABLONUN TAMAMI BUNUN UZERINE KURULU: **KEEPER BIR EMRI
-- DOLDURAMAZ.** Kontratlar dondurulmus oldugu icin bu bir eksik degil bir
-- SINIRDIR. Dolayisiyla bu tablo bir EMANET DEFTERI DEGILDIR -- hicbir satiri
-- bir fonun nerede durdugunu soylemez, cunku fon HER ZAMAN sahibinin
-- cuzdanindadir. Tablonun tuttugu sey **imzalanmis bir NIYET** ve keeper'in
-- **olculmus bir GOZLEMI**dir.
--
-- ==========================================================================
--  TETIK FIYATI, ZINCIRIN KENDI ARGUMANI OLARAK SAKLANIR
-- ==========================================================================
--
-- `min_out_tok` / `min_out_wei` bir "fiyat" degildir; uc giris noktasindan
-- birinin SLIPAJ SINIRIDIR (`buyExactQuoteIn(minTokensOut)`,
-- `sellExactTokensIn(tokensIn, minQuoteOut)`). Bir ondalik fiyat saklayip
-- doldurma aninda argumana cevirmek IKI kod yolu dogururdu: ekranda gosterilen
-- fiyat ve calldata'ya giden sayi. Bu deponun `useQuote` yasaginin (spec §7.2)
-- gerekcesi aynen burada gecerlidir.
--
-- KAZANDIGI SEY BIR GUVENLIK OZELLIGIDIR VE KEEPER'I GUVENILMEZ KILAR:
-- doldurma islemi emrin KENDI sinirini tasidigi icin, keeper YANLISLIKLA ya da
-- KOTU NIYETLE erken tetiklerse islem zincirde `SlippageExceeded` ile REVERT
-- eder. Keeper'a FIYAT icin guvenilmez; yalnizca CANLILIK icin guvenilir.
--
-- ==========================================================================
--  DORT MIKTAR SUTUNU, VE NEDEN IKI DEGIL
-- ==========================================================================
--
-- Bir alim USDC taahhut eder (18-decimal native gorunum, `msg.value`); bir
-- satim TOKEN taahhut eder. Ayni sutunda tasinsalardi o sutun gorunumunu
-- BILDIREMEZDI ve `naming.test.ts`in var olma sebebi tam olarak budur: Arc'ta
-- 1e12'lik bir gorunum hatasi tamamen gecerli bir sayidir ve hicbir calisma
-- zamani kontrolu onu goremez. Yani dort sutun, ve tam olarak IKISI dolu;
-- esleme tablo seviyesinde bir CHECK ile zorlanir.

CREATE TABLE limit_orders (
  -- SIRA: `chat_messages`in `message_seq`i ile AYNI gerekce (migration 013).
  -- Arc'ta ardisik bloklarin %49'u ayni timestamp'i tasir ve `now()` bir
  -- transaction icinde SABITTIR; bir zaman damgasi TAM SIRA VERMEZ ve
  -- kararsiz sira keyset sayfalamada satir tekrarlatir. Bu satirlarin bir
  -- `event_seq`i de yoktur -- zincire hic dokunmazlar.
  order_seq     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- YABANCI ANAHTAR: bir emir yalnizca INDEKSLENMIS bir launch'a asilabilir.
  -- `chat_messages` ile ayni gerekce ve ayni sonuc: 23503, rotada 404.
  token         text NOT NULL REFERENCES launches(token),

  -- SAHIP. Istemcinin IDDIASI DEGIL: rota `signature_hex`ten kurtardigi
  -- adresle karsilastirir. Emri IPTAL edebilen tek adres de budur.
  owner_addr    text NOT NULL CHECK (owner_addr ~ '^0x[0-9a-f]{40}$'),

  -- YON. `side`/`durum` yerine `is_buy`, cunku semanin geri kalani ZATEN
  -- boyle konusuyor (`trades.is_buy`) ve zincirdeki `Trade` olayinin yon
  -- bayragi da `isBuy`tir. Ucuncu bir sozcuk uydurmak, ayni seyin iki adi
  -- olmasi demekti.
  is_buy        boolean NOT NULL,

  -- ============ MIKTAR (spec: "miktar") ============
  -- ALIM: islemin TAM `msg.value`'su. Kismi doldurma YOKTUR ve olamaz:
  -- `buyExactQuoteIn` butcenin tamamini harcar, rezerv tepesinde KISAR ve
  -- artani IADE eder. Emir "5 USDC harca" der, "5 USDC'lik pozisyona kadar
  -- doldur" demez.
  amount_wei    numeric(78,0) CHECK (amount_wei IS NULL OR amount_wei > 0),
  -- SATIM: `sellExactTokensIn`in TAM `tokensIn`i.
  amount_tok    numeric(78,0) CHECK (amount_tok IS NULL OR amount_tok > 0),

  -- ============ TETIK FIYATI (spec: "tetik fiyati") ============
  -- Yukaridaki basliga bakin: bunlar zincirin argumanlaridir.
  min_out_tok   numeric(78,0) CHECK (min_out_tok IS NULL OR min_out_tok > 0),
  min_out_wei   numeric(78,0) CHECK (min_out_wei IS NULL OR min_out_wei > 0),

  -- ============ DURUM (spec: "durum") ============
  -- BES DEGER, VE UCU TERMINAL. `triggered` bir SOZ DEGIL bir GOZLEMDIR:
  -- "keeper `trigger_block_number` blogunda bu emrin zincirde kabul
  -- edilebilecegini olctu". Arayuz onu bir dugmeye cevirmeden ONCE kendi
  -- canli kotasini alir -- keeper'in isi FARK ETMEK, arayuzun isi GUNCEL
  -- OLMAK.
  --
  -- `triggered` YAPISKANDIR ve `open`a GERI DONMEZ. Geri dondurmek, fiyat
  -- oynadikca satirin sallanmasi ve kullanicinin gecmisinden bir olayin
  -- SILINMESI demek olurdu; oysa "bu emir su blokta doldurulabilirdi" kalici
  -- bir olgudur. Zararsizligini saglayan sey yine zincirdir: gec basilan bir
  -- dugme `SlippageExceeded` alir.
  status        text NOT NULL
                  CHECK (status IN ('open', 'triggered', 'filled', 'cancelled', 'expired')),

  -- SON KULLANMA. NULLABLE DEGIL, ve bu bir urun karari degil bir KEEPER
  -- karari: her acik emir her geciste taranir (bkz. `keeper/src/orders`), yani
  -- suresiz bir emir kalici bir tarama maliyetidir. Ustelik "sonsuza kadar
  -- acik" bir emir, kullanicinin unuttugu bir fiyatta bir gun dolabilir.
  expires_at    timestamptz NOT NULL,

  -- ============ KEEPER'IN GOZLEMI, YENIDEN OLCULEBILIR HALDE ============
  -- `chat_messages.balance_block_number` ile AYNI gerekce: blok olmadan
  -- "tetiklendi" DOGRULANAMAZ bir iddiadir. Bu blokla birlikte herhangi biri
  -- bir archive node'dan dort rezervi okuyup TS portunu calistirabilir ve
  -- keeper'in karari dogru muydu diye BAGIMSIZCA olcebilir.
  trigger_block_number bigint CHECK (trigger_block_number IS NULL OR trigger_block_number >= 0),

  -- DOLDURAN ISLEM. Kullanicinin KENDI cuzdanindan cikar (yukaridaki custody
  -- olcumu), yani bu alani yazan sey bir makbuz DOGRULAMASIDIR: rota
  -- `eth_getTransactionReceipt` ile logu cozer ve `trader == owner_addr`
  -- olmadan satiri `filled` YAPMAZ.
  fill_tx_hash  text CHECK (fill_tx_hash IS NULL OR fill_tx_hash ~ '^0x[0-9a-f]{64}$'),

  -- ============ KIMLIK VE TEKRAR OYNATMA -- FAZ 6'NIN SEKLI ============
  -- Nonce imzalanan metnin ICINDEDIR, yani saldirgan onu degistirip imzayi
  -- koruyamaz; UNIQUE yakalanmis bir (emir, imza) ciftinin ikinci kez
  -- yazilmasini 23505 ile durdurur. Tek basina yetmez (veritabani sifirlanirsa
  -- eski imzalar dirilir); ikinci kat rotadaki `issued` penceresidir.
  nonce_hex     text NOT NULL UNIQUE CHECK (nonce_hex ~ '^0x[0-9a-f]{64}$'),
  -- 0x + 65 bayt (r,s,v). Satir BAGIMSIZCA dogrulanabilir olsun diye saklanir.
  signature_hex text NOT NULL CHECK (signature_hex ~ '^0x[0-9a-f]{130}$'),

  -- IMZALAYANIN BEYAN ETTIGI AN. Rota bunu SUNUCU saatine karsi sinirlar.
  issued_at     timestamptz NOT NULL,
  -- SUNUCUNUN yazdigi an. Hiz siniri icin bir SUZGEC; SIRALAMA ICIN DEGIL.
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- ============ YONE GORE BIRIM ESLEMESI ============
  -- TAM OLARAK IKI SUTUN DOLU, ve hangisi oldugu `is_buy`a baglidir. Bunu
  -- uygulama katmanina birakmak, bir alim emrinin `amount_tok` tasidigi
  -- (yani 18-decimal bir sayinin token sanildigi) bir satirin yazilabilmesi
  -- demekti -- ve o satir hicbir zaman "gecersiz" GORUNMEZDI.
  CONSTRAINT limit_orders_side_units_check CHECK (
    (is_buy AND amount_wei IS NOT NULL AND min_out_tok IS NOT NULL
             AND amount_tok IS NULL AND min_out_wei IS NULL)
    OR
    (NOT is_buy AND amount_tok IS NOT NULL AND min_out_wei IS NOT NULL
                AND amount_wei IS NULL AND min_out_tok IS NULL)
  ),

  -- TERMINAL DURUMLARIN TUTARLILIGI. `filled` bir islem hash'i OLMADAN
  -- yazilamaz: "doldu" diyen ama neyle doldugunu soyleyemeyen bir satir, tam
  -- olarak dogrulanamaz bir iddiadir.
  CONSTRAINT limit_orders_filled_needs_tx_check CHECK (
    (status = 'filled') = (fill_tx_hash IS NOT NULL)
  ),

  -- `triggered` ve ondan sonra gelen her durum bir GOZLEM BLOGU tasir.
  -- `open` ve `cancelled` tasimaz -- iptal edilen bir emir hic tetiklenmemis
  -- olabilir.
  CONSTRAINT limit_orders_triggered_needs_block_check CHECK (
    status <> 'triggered' OR trigger_block_number IS NOT NULL
  )
);

-- ============ KEEPER'IN TARAMA SORGUSU, TAM OLARAK BU INDEKSTEN ============
-- Her gecis "acik ve suresi gecmemis emirler"i TOKEN'A GORE GRUPLU ister:
-- rezervler token basina BIR KEZ okunur ve o token'in butun emirleri o tek
-- okumayi paylasir. Kismi indeks tabloyu tarihe degil YALNIZCA acik islere
-- oranti kilar -- dolmus ve iptal edilmis emirler buyudukce tarama buyumez.
CREATE INDEX limit_orders_open_by_token_idx
  ON limit_orders (token, order_seq)
  WHERE status IN ('open', 'triggered');

-- SAHIBIN "Orders" SEKMESI: token + sahip, yeniden eskiye. Keyset `order_seq`
-- uzerindedir, bir zaman kolonu uzerinde DEGIL.
CREATE INDEX limit_orders_owner_idx
  ON limit_orders (token, owner_addr, order_seq DESC);

-- HIZ SINIRI PENCERESI. `created_at` burada bir SUZGECTIR, bir sira degil --
-- migration 003'un ve 013'un ayni ayrimi.
CREATE INDEX limit_orders_owner_recent_idx
  ON limit_orders (token, owner_addr, created_at DESC);

-- SURESI GECENLERIN SUPURULMESI (spec §8, keeper gorev 4). Kismi indeks, ayni
-- gerekceyle: supuruculuk acik isle orantili olmali.
CREATE INDEX limit_orders_expiry_idx
  ON limit_orders (expires_at)
  WHERE status IN ('open', 'triggered');
