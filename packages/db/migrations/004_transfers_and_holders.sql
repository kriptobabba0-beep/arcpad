-- IDEMPOTENCY DEFTERI. `holders` artimli guncellenmek ZORUNDA (Transfer bir
-- delta tasir, mutlak bakiye tasimaz), ve artimli guncelleme ON CONFLICT DO
-- NOTHING ile idempotent OLMAZ. Cozum: delta yalnizca BU tabloya bir satir
-- GERCEKTEN eklendiginde uygulanir (`applyTransfer`'in CTE'si).
--
-- EIP-7708 CIFT SAYIM TEHLIKESI VE BU SEMANIN ONA NEDEN DUSEMEYECEGI:
-- Arc, bir sistem adresinden yapilan HER native hareket icin de bir `Transfer`
-- logu yayar. Bu loglarin yayincisi 6 decimal'lik native-USDC ERC-20'sidir
-- (0x3600000000000000000000000000000000000000), bir launch token'i degil.
-- Burada `token` sutunu `launches(token)`'a YABANCI ANAHTARDIR: boyle bir log
-- yazilmaya kalkilirsa 23503 ile GURULTULU biter, sessizce bakiyelere
-- karismaz. Ikinci kat savunma adlandirmadir -- native tutar bir `_wei`
-- degeridir ve buradaki sutun `amount_tok`'tur; onu buraya yazmak adin
-- kendisini yalanlar. (Ikisi de calistirilarak test edilir, bkz.
-- test/transfers.test.ts.)
CREATE TABLE token_transfers (
  event_seq     bigint PRIMARY KEY,
  block_number  bigint NOT NULL,
  log_index     integer NOT NULL CHECK (log_index BETWEEN 0 AND 1048575),
  tx_hash       text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_time    timestamptz NOT NULL,
  token         text NOT NULL REFERENCES launches(token),
  from_addr     text NOT NULL CHECK (from_addr ~ '^0x[0-9a-f]{40}$'),
  to_addr       text NOT NULL CHECK (to_addr   ~ '^0x[0-9a-f]{40}$'),
  amount_tok    numeric(78,0) NOT NULL
);
CREATE INDEX token_transfers_token_seq_idx ON token_transfers (token, event_seq DESC);

CREATE TABLE holders (
  token        text NOT NULL REFERENCES launches(token),
  holder       text NOT NULL CHECK (holder ~ '^0x[0-9a-f]{40}$'),
  -- NEGATIF OLAMAZ. Bir Transfer atlanirsa (ornegin adres filtresi
  -- dusurulurse ve bir token'in loglari eksik gelirse) bu CHECK patlar ve
  -- transaction geri alinir. Sessiz veri kaybini GURULTULU bir hataya
  -- ceviren tek yer burasidir.
  balance_tok  numeric(78,0) NOT NULL CHECK (balance_tok >= 0),
  last_seq     bigint NOT NULL,
  PRIMARY KEY (token, holder)
);
-- Holder SAYISI icin. Sifir bakiyeli satirlar silinmez (last_seq bilgisi
-- degerli), bu yuzden kismi indeks.
CREATE INDEX holders_token_nonzero_idx ON holders (token) WHERE balance_tok > 0;
CREATE INDEX holders_holder_idx        ON holders (holder) WHERE balance_tok > 0;
