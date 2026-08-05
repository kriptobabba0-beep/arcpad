-- BIR OLCUMUN KENDI YASI OLMADAN OKUNMASI -- AYNI KUSUR, BIR SEVIYE ASAGIDA.
--
-- 010 verinin yasini olcen ikinci ekseni ekledi (`head_block - last_block`) ve
-- B2-a'yi kapatti. `c26c065` sonra canliligi veri yazmaktan AYIRDI (`noteAlive`
-- geri cekilme uykusunun icinde `updated_at`i tazeler), cunku susan bir
-- indexer "olmus" gibi okunuyordu.
--
-- O ayirma DOGRUYDU ve BIR SEYI KOPARDI: `c26c065`ten ONCE `updated_at` ayni
-- zamanda BASIN GOZLENDIGI andi -- `head_block`i yazan tek iki yol
-- (`setCursor`, `noteHead`) `updated_at`i de yaziyordu. Ayirmadan sonra
-- `updated_at` tazelenirken `head_block` DONABILIYOR, ve iki eksen birden
-- "saglikli" diyor:
--
--   notWriting = false   (atis yapiyoruz)
--   behind     = false   (blocksBehind SIFIRA DONMUS -- sifir OLCULMUS degil)
--
-- OLCULDU (canli, 6 ardisik cizim): basa yetismis bir indexer merdivene
-- girdiginde sayfa TAZE dalini secti, HICBIR uyari cizmedi, ve gercek gecikme
-- 90 bloklik esigi asip 164'e ciktigi halde rapor edilen `blocksBehind` 0'da
-- kaldi.
--
-- Bu, B2-a'nin ta kendisidir: BIR DEGER, KENDI YASI KONTROL EDILMEDEN GUNCEL
-- SAYILDI. Bu sutun, `head_block`a kendi yasini verir; okuma katmani artik
-- "olculmemis" durumu TEMSIL EDEMEYEN bir tiple calisir (bkz.
-- `HeadObservation`), yani dorduncu bir `if` degil, yazilamayan bir durum.
--
-- NULL OLABILIR: bu sutundan onceki satirlar (ve 010'u yazan ama bunu
-- yazmayan bir indexer) "ne zaman bakildigi bilinmiyor" demektir ve o da
-- TAZE SAYILMAZ.
-- `DEFAULT now()` -- ve bu, `updated_at` ile AYNI gerekcedendir. `packages/db`
-- test kapisi "iki bagimsiz kurulusta zorunlu olarak farkli olan sutunlar"
-- listesini KATALOGDAN turetir (`column_default LIKE '%now()%'`), elle yazilmis
-- bir listeden degil. Varsayilansiz bir damga o turetmenin DISINDA kalirdi:
-- yani kapinin kendisi, tam olarak korumak icin var oldugu sekilde -- "bir
-- sutun sessizce kapsam disina kacti" -- bosalirdi. Varsayilan, gecmeyi
-- degil KAPSANMAYI saglar.
ALTER TABLE sync_state ADD COLUMN head_observed_at timestamptz DEFAULT now();

COMMENT ON COLUMN sync_state.head_observed_at IS
  'head_block''in GOZLENDIGI an. `head_block` ile AYNI ifadede yazilir ve BASKA hicbir yerde yazilmaz: ikisi ayrisirsa, donmus bir bas guncel gorunur ve okuma katmani gecikmeyi sifir sanar (olculdu: gercek gecikme 164 blokken rapor 0). `noteAlive` bu sutuna DOKUNMAZ -- canlilik ayri bir eksendir.';

-- Mevcut satir icin: `head_block` varsa gozlem ani en iyi tahminle
-- `updated_at`tir, cunku 011'den ONCE ikisini yazan yollar `updated_at`i de
-- yaziyordu. Yoksa NULL kalir ve "hic gozlenmedi" olarak okunur.
UPDATE sync_state SET head_observed_at = updated_at WHERE head_block IS NOT NULL;
