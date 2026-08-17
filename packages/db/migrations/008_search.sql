-- ARAMA VE HOLDER SAYFALAMA.
--
-- Bu dosya SONA EKLENDI, 001-007 YERINDE DUZENLENMEDI. Defter (bkz.
-- `src/migrate.ts`) uygulanmis bir dosyanin degismesini SERT DURUSLA
-- reddeder ve o kural bu dosyanin var olma bicimini belirler: `launches`e
-- yeni bir kisit, `holders`a yeni bir indeks ve iki yeni fonksiyon EKLENIR,
-- hicbir eski govde DOKUNULMAZ.
--
-- ==================================================================
-- NEDEN BIR EXTENSION `public` ICINDE, VE BEDELI NEDIR
-- ==================================================================
-- `src/migrate.ts` `public` icinde ONCEDEN kurulmus bir extension'i sert
-- durusla reddeder (`test/migrate.test.ts`, "URETIMDEKI SEKLI"), ve gerekcesi
-- dogru: nereden geldigi bilinmeyen 31 fonksiyon satirini parmak izine almak,
-- SONRAKI siradan bir extension bakimini yanlis bir sert durusa cevirir.
--
-- Buradaki durum FARKLIDIR ve farki yazmak gerekiyor: bu extension'i
-- MIGRATION'IN KENDISI kuruyor. Yani parmak izine girmesi "bilinmeyen bir
-- nesnenin benimsenmesi" degil, migration'larin URETTIGI semanin bir
-- parcasinin kaydedilmesidir -- muhafizin tam olarak yapmasi istenen sey.
--
-- BEDEL YINE DE GERCEK VE BURAYA YAZILIYOR: `pg_trgm` bir gun 1.6'dan
-- yukseltilirse fonksiyon govdeleri degisir, parmak izi oynar ve
-- `runMigrations` durur -- mesaji ise "dropdb" onerir, ki o durumda YANLIS
-- oneridir. Dogru mudahale `schema_state`i yeniden hesaplatmaktir. Bu
-- olculdu: extension `public` icinde 31 fonksiyon YARATIR, ama SIFIR iliski
-- (relkind r/p/v/m/f) ve SIFIR alan (domain) yaratir -- yani adlandirma
-- kapisinin `examined`/`inventory`/`schemas`/`reach` iddialarinin HICBIRI
-- oynamaz. Kapinin sutun envanteri bu dosyadan sonra AYNIDIR.
--
-- AYRI BIR SEMAYA KURMAK COZUM DEGILDIR: `schemaInventory` sistem DISI her
-- semayi tarar, yani fonksiyonlar yine parmak izine girerdi; kazanc yalnizca
-- `public`in temiz gorunmesi olurdu ve bedeli `naming.test.ts`in
-- "sistem disi tek sema `public`tir" iddiasini kirmak.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ==================================================================
-- TRIGRAM INDEKSLERI
-- ==================================================================
-- `name` ve `symbol` AYRI indekslenir, birlestirilmis bir ifade olarak DEGIL.
-- Gerekce olculdu: `similarity('SMOKE SMOKE', 'smoke')` ile
-- `similarity('SMOKE', 'smoke')` ayni degildir -- birlestirme, sembolu adin
-- icine karistirip her iki alanin skorunu da BOZAR. Skor `GREATEST(...)` ile
-- alinir, yani "adiyla ya da sembolüyle ne kadar eslesti"nin IYISI.
CREATE INDEX launches_name_trgm_idx   ON launches USING gin (name   gin_trgm_ops);
CREATE INDEX launches_symbol_trgm_idx ON launches USING gin (symbol gin_trgm_ops);

-- ==================================================================
-- SIRALAMA ANAHTARININ TAM OLMASI: PAKETLEME
-- ==================================================================
-- OLCULEN SORUN: `similarity` TEKRAR EDER. Alti gercekci token adi
-- (SMOKE, Smokey, SMOKESCREEN, SMOKED, SMOKER, SMOKES) 'smoke' sorgusuna
-- karsi YALNIZCA UC ayri skor uretir -- alti satirin ucu esit. Yalnizca
-- `ORDER BY similarity DESC` yazmak, siralamanin yarisini Postgres'in plan
-- secimine birakir; keyset sayfalamada bu, AYNI SATIRIN IKI SAYFADA ya da
-- HICBIR SAYFADA cikmasi demektir. Okuma modeli bu dersi bir kez `block_time`
-- uzerinde aldi (ardisik Arc bloklarinin %49,0'i ayni timestamp'i tasir,
-- 553 cift uzerinde olculdu); ayni sekli baska bir kolonda TEKRARLAMAK
-- yasaktir.
--
-- COZUM: anahtar TEK bir sayiya PAKETLENIR.
--
--   anahtar = miktar * 2^63 + created_seq
--
-- `created_seq` `launches` icinde UNIQUE ve (asagidaki kisit sayesinde)
-- NEGATIF DEGILDIR, ve `bigint` oldugu icin 2^63'ten KUCUKTUR. Yani
-- `s -> miktar*2^63 + s` konumsal bir kodlamadir ve BIREBIRDIR: iki farkli
-- satir asla ayni anahtari alamaz. Dolayisiyla:
--   * siralama TAMDIR (esit anahtar YOKTUR, plan degisse de sira degismez),
--   * ve `anahtar < imlec` tek bir karsilastirmayla `(miktar, created_seq)`
--     sozluk sirasinin TA KENDISIDIR.
--
-- Ustelik SIRALAMA ve IMLEC AYNI IFADEDIR: sayfanin son satirinin imleci
-- sorgunun kendisinden doner, cagiran onu YENIDEN HESAPLAMAZ. Imleci cagiran
-- tarafta yeniden turetmek (`web/lib/read.ts`'in `CURSOR_KEY` haritasi bunu
-- yapar) iki ifadenin sessizce ayrismasina acik bir kapidir.
--
-- FLOAT BIR IMLEC ANAHTARI OLAMAZ, ve `search_rank`in var olma sebebi budur:
-- `similarity()` `real` (float4) doner. Bir float'i ondalik metne cevirip
-- imlec olarak geri alip ESITLIK aramak, bit-birebir yeniden uretime bel
-- baglamak demektir. `search_rank` skoru ONDE bir TAMSAYIYA indirger
-- (0..10000), boylece karsilastirmalarin tamami `numeric` uzerinde TAM olur.
-- Kuantizasyonun yan etkisi zararsizdir: 1e-4'ten yakin iki skor esitlesir ve
-- ikinci anahtar (`created_seq`) devreye girer -- yani sonuc yine TAM sirali.
ALTER TABLE launches
  ADD CONSTRAINT launches_created_seq_is_nonnegative CHECK (created_seq >= 0);

-- Paketlemenin miktar tarafinin on kosulu: NEGATIF OLMAYAN TAMSAYI.
-- `numeric(78,0)` tamsayiligi zaten veriyor; isaret BURADA zorlaniyor.
-- YAZMA ZAMANINDA zorlanmasinin sebebi maliyet: okuma yolunda her satir icin
-- bir plpgsql kontrolu kosturmak yerine, degerin girisi bir kez kapatilir.
ALTER TABLE curve_state
  ADD CONSTRAINT curve_state_reserves_are_nonnegative CHECK (
    virtual_token_reserves_tok > 0
    AND virtual_quote_reserves_wei >= 0
    AND real_token_reserves_tok    >= 0
    AND real_quote_reserves_wei    >= 0);

ALTER TABLE token_stats
  ADD CONSTRAINT token_stats_amounts_are_nonnegative CHECK (
    market_cap_wei     >= 0
    AND ath_market_cap_wei >= 0
    AND volume_total_wei   >= 0
    AND volume_24h_wei     >= 0);

-- ALAKA SKORU, TAMSAYI OLARAK. 0..10000 (yani 1e-4 adimli).
--
-- `similarity` [0,1] araligindadir ve AYNI dizgede TAM OLARAK 1 doner
-- (olculdu), yani `LEAST` yalnizca kayan nokta yukari yuvarlamasina karsi
-- durur; kaldirmak degeri 10001 yapabilirdi ve o da paketlemeyi degil ama
-- "rank <= 10000" ifadesini yalanlardi.
--
-- BUYUK/KUCUK HARF: `similarity` trigram'lari uretirken zaten kucultur
-- (olculdu: 'SMOKE' ve 'smoke' sorgulari BIREBIR ayni skorlari verir), yani
-- burada `lower()` YOKTUR ve olmamalidir -- eklemek, kapali bir donusumu iki
-- kez yapip hicbir sey degistirmeyen olu kod olurdu.
CREATE FUNCTION search_rank(p_name text, p_symbol text, p_q text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT LEAST(
    10000::numeric,
    floor(GREATEST(similarity(p_name, p_q), similarity(p_symbol, p_q))::numeric * 10000)
  )::integer
$$;

-- PAKETLENMIS ANAHTAR. Tek tanim; hem `ORDER BY` hem imlec suzgeci hem de
-- donen `nextCursor` BUNU cagirir, yani ucu ayrismaz.
--
-- 9223372036854775808 = 2^63. `created_seq` bir `bigint`tir, yani
-- [0, 2^63) araligindadir (alt sinir yukaridaki kisitla). Carpan tam olarak
-- o araligin genisligidir; daha kucugu tasma, daha buyugu bosluk yaratirdi.
CREATE FUNCTION search_key(p_amount numeric, p_created_seq bigint) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT p_amount * 9223372036854775808::numeric + p_created_seq::numeric
$$;

-- ==================================================================
-- HOLDER SAYFALAMA
-- ==================================================================
-- `listHolders` `balance_tok DESC, holder ASC` siralar. BIRINCI ANAHTAR TEK
-- BASINA TAM DEGILDIR -- bakiyeler tekrar eder, ve en cok tekrar ettikleri
-- yer tam da bir listenin KUYRUGUDUR (ayni miktarda alan yuzlerce cuzdan).
-- `holder` ise `(token, holder)` birincil anahtarinin bir parcasidir, yani
-- TEK BIR token icinde BIREBIRDIR; ikisi birlikte TAM sira verir.
--
-- Bu indeks siranin KENDISIDIR -- `DESC, ASC` yonleri sorgudakiyle ayni,
-- boylece keyset sorgusu siralama yapmadan indeksi TARAR. Kismi olmasi
-- `holders_token_nonzero_idx` ile ayni gerekceye dayanir: sifir bakiyeli
-- satirlar silinmez (`last_seq` degerlidir) ama listede DE gorunmezler.
CREATE INDEX holders_token_balance_idx
  ON holders (token, balance_tok DESC, holder ASC) WHERE balance_tok > 0;
