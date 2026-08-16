-- CREATOR-FONLU BUYBACK & LOCK -- DEFTER VE TOPLAM.
--
-- Bes olay, IKI kontrat. Uc tanesi hazineden, iki tanesi kasadan gelir ve
-- ADRESE gore filtrelenir (tipe gore degil). Imzalar derlenmis ABI'den
-- turetilir; asagidaki alan adlari `indexer/src/logs.ts`in cozdugu adlardir:
--
--   BuybackTreasury.BuybackAccrued(token indexed, venue indexed, quoteAmount, pending)
--   BuybackTreasury.BuybackExecuted(token indexed, quoteSpent, tokensBought)
--   BuybackTreasury.BuybackSkipped(token indexed, quoteReturnedToCreator, reason)
--   BuybackVestingVault.BuybackLocked(token indexed, tokenAmount, vestingStart, vestingEnd, totalLocked)
--   BuybackVestingVault.VestingReleased(token indexed, caller indexed, creatorAmount, protocolAmount)
--
-- BUTUN QUOTE MIKTARLARI NATIVE WEI'DIR (18 decimal), havuz olaylarinin 6
-- decimal biriminde DEGIL. Hazine `pendingQuote`u wei tutar; ikisini
-- karistirmak 10^12 kat hata verir ve bu depoda `_marketCap` icin bir kez
-- olculdu.
--
-- ===========================================================================
-- NEDEN TEK TABLO VE NEDEN KOLONLAR TURE GORE NULL
-- ===========================================================================
--
-- Bes olayin ortak govdesi ayni (`event_seq`, blok, tx, token) ve hepsi TEK bir
-- olgunun -- bir tokenin buyback gecmisi -- pesi sira gelen adimlaridir. Ayri
-- bes tablo, "para nerede" sorusunu bes yollu bir UNION'a cevirirdi; oysa o
-- soru tam olarak bu ozelligin var olma sebebi (`BuybackSkipped`in NatSpec'i:
-- "BU OLAY OLMADAN DEFTER KAPANMAZ").
--
-- Bedeli ture gore bos kalan kolonlardir, ve o bosluk SEMADA ZORLANIR:
-- asagidaki `*_iff_*` kisitlari "hangi kolon hangi turde dolu" sorusunu bir
-- SOZLESME olmaktan cikarip bir OLGU yapar. `fee_events.deposit_has_from` ve
-- `curve_state.graduated_iff_payout` ayni sinifin daha kucuk ornekleridir.
CREATE TABLE buyback_events (
  event_seq     bigint PRIMARY KEY,
  block_number  bigint NOT NULL,
  log_index     integer NOT NULL CHECK (log_index BETWEEN 0 AND 1048575),
  tx_hash       text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_time    timestamptz NOT NULL,
  -- Zincirdeki olay adlarinin KISALTILMISI degil, DEFTERIN kendi sozlugu.
  -- `fee_events.kind`in ('deposit','claim') ile ayni sinifta.
  kind          text NOT NULL CHECK (kind IN ('accrued','executed','skipped','locked','released')),
  -- Semadaki her token sutunu gibi `launches`a baglidir. Bunun buradaki ozel
  -- anlami sudur: hazine ve kasa, launch'lardan BAGIMSIZ adreslerdir ve
  -- olaylari adrese gore cekilir -- yani bir `Launched` gormeden bir buyback
  -- olayi GELEBILIR. Yabanci anahtar o hali sessiz bir satir yerine GURULTULU
  -- bir islem hatasina cevirir; `indexer/src/apply/buyback.ts` ayni hali daha
  -- once ve daha okunur bir mesajla (`UnknownBuybackToken`) yakalar.
  token         text NOT NULL REFERENCES launches(token),
  -- Olayi YAYAN kontrat: hazine (ilk uc tur) ya da kasa (son iki tur).
  -- SAKLANIR cunku ikisi de yeniden dagitilabilir ve gecmis, hangi surumun
  -- yazdigini SOYLEMEK zorundadir; `deployment` tablosu yalnizca BUGUNKU
  -- adresleri tasir.
  emitter_addr  text NOT NULL CHECK (emitter_addr ~ '^0x[0-9a-f]{40}$'),
  -- YALNIZCA `accrued`: tahakkuku yapan merci -- tokenin EGRISI ya da
  -- mezuniyet HOOK'u. Buyback butcesinin hangi venue'den biriktigi BASKA
  -- hicbir yerde yazili degildir, ve iki venue'nun ucret rejimi FARKLIDIR
  -- (egri mercii protokol ucreti oder, havuz mercii MUAFTIR).
  venue_addr    text CHECK (venue_addr ~ '^0x[0-9a-f]{40}$'),
  -- YALNIZCA `released`: `release()`i cagiran (creator ya da protokol
  -- hazinesi). Dagitimin PAYLARINI degistirmez -- %30/%70 sabittir -- ama
  -- "kim tetikledi" sorusunun tek kaydidir.
  caller_addr   text CHECK (caller_addr ~ '^0x[0-9a-f]{40}$'),
  -- YALNIZCA `skipped`. Zincirin yaydigi dize; operatorun ayirt etmesi gereken
  -- durumlari tasir (`pool-not-initialized`, `pool-cannot-absorb`,
  -- `below-threshold-or-unsafe`, `below-one-quote-unit`).
  --
  -- DESEN KISITI BILEREK YOKTUR. `rejected_launches.reason` BIZIM yazdigimiz
  -- bir etikettir ve orada desen dogru karardir; bu alan ZINCIRDEN gelir.
  -- Zincirin mesru olarak yayabilecegi bir degeri reddeden bir CHECK, ingest
  -- islemini geri alir ve indexer'i o blokta SONSUZA KADAR kilitler -- yani
  -- bir veri-kalitesi iddiasi bir liveness arizasina donerdi
  -- (`002_launches.sql` ayni gerekceyi uzunluk kisitlari icin yaziyor).
  reason        text,
  -- Quote tasiyan uc tur, TEK KOLONDA: `accrued` ayrilan, `executed` harcanan,
  -- `skipped` creator'a geri katlanan. Uc ayri kolon, "bu tokene ne kadar para
  -- girdi/cikti" sorusunu her seferinde uc kolonun COALESCE'ine cevirirdi;
  -- yon zaten `kind`te yazili.
  quote_wei     numeric(78,0) CHECK (quote_wei >= 0),
  -- YALNIZCA `accrued`: tahakkuk SONRASI toplam bekleyen. ZINCIRIN MUTLAK
  -- DEGERIDIR ve tam da bu yuzden saklanir -- toplam tablosundaki
  -- `pending_quote_wei` her tahakkukta buna SIFIRLANIR, yani birikimli bir
  -- sapma tasiyamaz.
  pending_wei   numeric(78,0) CHECK (pending_wei >= 0),
  -- `executed`te ALINAN token, `locked`ta KILITLENEN token. Ikisi de ayni
  -- olgunun iki yuzudur (canli kanitta BIREBIR esitti: 14.435.072,652524 BBP
  -- alindi, 14.435.072,652524 BBP kilitlendi) ama ESIT OLMAK ZORUNDA
  -- DEGILDIRLER -- kasa birden fazla supurmenin tokenini biriktirebilir.
  token_amount_tok numeric(78,0) CHECK (token_amount_tok >= 0),
  -- YALNIZCA `locked`: kasadaki KUMULATIF toplam, zincirin kendi sayisi.
  total_locked_tok numeric(78,0) CHECK (total_locked_tok >= 0),
  -- YALNIZCA `released`. Bolusme sabit %30 protokol / %70 creator'dir ve ucret
  -- kademesinden AYRIDIR; iki tutar da AYRI saklanir cunku toplamdan geri
  -- turetmek o sabiti kodun icine gomerdi.
  creator_amount_tok  numeric(78,0) CHECK (creator_amount_tok >= 0),
  protocol_amount_tok numeric(78,0) CHECK (protocol_amount_tok >= 0),
  -- YALNIZCA `locked`: AGIRLIKLI vesting penceresi. Her yeni kilit baslangici
  -- ILERI iter, yani bu iki alan bir gecmis degil O ANDAKI penceredir.
  vesting_start_at timestamptz,
  vesting_end_at   timestamptz,

  -- ---------------------------------------------------------------------
  -- TUR <-> KOLON ESLESMESI. Yarim yazilmis bir olay sema duzeyinde IMKANSIZ.
  -- ---------------------------------------------------------------------
  CONSTRAINT buyback_quote_iff_quote_kind CHECK (
    (kind IN ('accrued','executed','skipped')) = (quote_wei IS NOT NULL)),
  CONSTRAINT buyback_pending_iff_accrued CHECK (
    (kind = 'accrued') = (pending_wei IS NOT NULL)),
  CONSTRAINT buyback_venue_iff_accrued CHECK (
    (kind = 'accrued') = (venue_addr IS NOT NULL)),
  CONSTRAINT buyback_reason_iff_skipped CHECK (
    (kind = 'skipped') = (reason IS NOT NULL)),
  CONSTRAINT buyback_tokens_iff_buy_or_lock CHECK (
    (kind IN ('executed','locked')) = (token_amount_tok IS NOT NULL)),
  CONSTRAINT buyback_vesting_iff_locked CHECK (
    (kind = 'locked') = (total_locked_tok IS NOT NULL)
    AND (kind = 'locked') = (vesting_start_at IS NOT NULL)
    AND (kind = 'locked') = (vesting_end_at IS NOT NULL)),
  CONSTRAINT buyback_split_iff_released CHECK (
    (kind = 'released') = (creator_amount_tok IS NOT NULL)
    AND (kind = 'released') = (protocol_amount_tok IS NOT NULL)
    AND (kind = 'released') = (caller_addr IS NOT NULL)),
  -- Pencere ILERI akar. `vestingStart` her kilitte agirlikli olarak ILERI
  -- itilir ama bitis her zaman baslangictan sonradir (5 yil, `BuybackVestingVault`).
  CONSTRAINT buyback_vesting_window_is_forward CHECK (
    vesting_end_at IS NULL OR vesting_end_at > vesting_start_at)
);
CREATE INDEX buyback_events_token_seq_idx ON buyback_events (token, event_seq DESC);
CREATE INDEX buyback_events_kind_seq_idx  ON buyback_events (kind, event_seq DESC);

-- TOKEN BASINA TOPLAM -- arayuzun tek satirda okudugu sey.
--
-- `fee_balances` ile AYNI sinifta: artimlidir ve artimi, defter tablosuna bir
-- satirin GERCEKTEN eklenmis olmasina baglidir (`apply.ts`, `ON CONFLICT DO
-- NOTHING` -> bagimli CTE bos kumeye uygulanir).
--
-- ===========================================================================
-- `fee_balances`TEN AYRILDIGI TEK YER: DEFTER ESITLIGI KISITI YOKTUR
-- ===========================================================================
--
-- Ilk tasarim `CHECK (pending_quote_wei = accrued_total_wei - spent_total_wei -
-- returned_total_wei)` tasiyordu -- `claimable_is_the_difference`in birebir
-- karsiligi. OLCULDU VE KALDIRILDI: `contracts/fixtures/buyback.json` TEK BIR
-- islemin loglaridir (tahakkuk -> supurme -> kilit -> dagitim). O islemdeki
-- tahakkuk 94.672.977.389.008 wei, supurmenin harcadigi 63.904.259.737.580.596
-- wei; aradaki fark DAHA ONCEKI islemlerde birikmistir ve o loglar dosyada
-- yoktur. Yani kisit, MESRU bir log dilimini reddediyordu.
--
-- Yerine gecen sey daha guclu, cunku iddiasi daha dar: `pending_quote_wei` her
-- `accrued`ta zincirin MUTLAK `pending` degerine SIFIRLANIR ve yalnizca iki
-- tahakkuk ARASINDA delta ile ilerler. Bir dusurulmus olay bu yuzden en fazla
-- bir tahakkuk boyu yasar. Dusurulmus olayin KENDISINI yakalayan sey ise bu
-- tablo degil, `verify.ts::assertRangeApplied`in `buyback_events` uzerindeki
-- kapsam kontroludur -- ve bu, ikisinin AYNI commit'te gitmesinin sebebidir.
CREATE TABLE buyback_state (
  token                 text PRIMARY KEY REFERENCES launches(token),
  -- O ANDAKI butce. Tahakkukta zincirin mutlak degerine kurulur; harcama ve
  -- geri katlamada dusulur, `GREATEST(0, ...)` ile KIRPILARAK.
  --
  -- KIRPMA NEDEN VAR VE URETIMDE NEDEN BAGLAMAZ: `deployment.start_block`
  -- fabrikanin dagitim blogudur, yani indexer hazine daha var olmadan once
  -- baslar ve hicbir tahakkuk goruntunun disinda kalmaz. Kirpma yalnizca bir
  -- log DILIMI uygulandiginda baglar (yukaridaki fixture) ve `apply-buyback`
  -- testi tam olarak o hali olcer -- yani kirpma gizli bir davranis degildir.
  pending_quote_wei     numeric(78,0) NOT NULL DEFAULT 0 CHECK (pending_quote_wei >= 0),
  -- Kumulatif akislar. Ucu birlikte "para nerede" sorusunu kapatir:
  -- accrued = spent + returned + (halen pending).
  accrued_total_wei     numeric(78,0) NOT NULL DEFAULT 0 CHECK (accrued_total_wei  >= 0),
  spent_total_wei       numeric(78,0) NOT NULL DEFAULT 0 CHECK (spent_total_wei    >= 0),
  returned_total_wei    numeric(78,0) NOT NULL DEFAULT 0 CHECK (returned_total_wei >= 0),
  -- Piyasadan alinan kumulatif token.
  bought_total_tok      numeric(78,0) NOT NULL DEFAULT 0 CHECK (bought_total_tok >= 0),
  -- Kasadaki kumulatif kilit. TOPLANMAZ, ATANIR: zincir `totalLocked`i mutlak
  -- olarak yayar, ve mutlak bir sayiyi deltalardan yeniden kurmak sapma
  -- birikmesine acik olurdu.
  locked_total_tok      numeric(78,0) NOT NULL DEFAULT 0 CHECK (locked_total_tok >= 0),
  released_creator_tok  numeric(78,0) NOT NULL DEFAULT 0 CHECK (released_creator_tok  >= 0),
  released_protocol_tok numeric(78,0) NOT NULL DEFAULT 0 CHECK (released_protocol_tok >= 0),
  -- EN SON kilidin agirlikli penceresi. Bir gecmis degil, O ANKI pencere.
  vesting_start_at      timestamptz,
  vesting_end_at        timestamptz,
  last_seq              bigint NOT NULL,
  CONSTRAINT buyback_state_window_is_forward CHECK (
    vesting_end_at IS NULL OR vesting_end_at > vesting_start_at)
);
