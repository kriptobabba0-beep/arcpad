-- VERI YASI, SUREC CANLILIGINDAN AYRI.
--
-- 001'in `sync_state`'i tek bir soruya cevap veriyordu: "indexer en son NE ZAMAN
-- yazdi". `updated_at` her ILERLEYEN aralikta tazelenir -- bos aralik da dahil --
-- yani onu okuyan `stale` bayragi SURECIN canli olup olmadigini olcuyordu.
--
-- OLCULDU (2026-08-05, canli Arc testnet, gercek factory): `runOnce` bir aralik
-- isledi, `updated_at` 0,17 saniye once yazildi, imlec 54.671.436'da kaldi ve
-- zincirin basi 55.438.940'taydi. **767.504 blok = ~75 saat** geride, ve okuma
-- katmani `stale: false` dedi; token sayfasi TAZE dalini secti, yani hicbir
-- uyari cizmedi. Sureci olcen bir bayrak, verinin yasi hakkinda hicbir sey
-- soylemiyordu ve tam olarak onun icin yazilmisti.
--
-- ZINCIRIN BASI BURAYA YAZILIR, WEB TARAFINDA OKUNMAZ. Iki sebep:
--   1. Karsilastirmanin SUNUCUNUN saatinden/gozleminden gelmesi gerekiyor;
--      tarayicidan hesaplamak saati kaymis bir kullaniciya kalici uyari
--      gosterirdi. Ayni gerekce `updated_at` icin de yazildi (001).
--   2. Her sayfa cizimi icin bir RPC cagrisi, Arc'in hiz sinirina (bu depoda
--      olculmus iki ayri kod) her ziyaretcide bir istek daha eklerdi.
--
-- Indexer zaten her turun BASINDA `finalized` basligi okuyor; buraya yazilan o
-- sayidir. NULL OLABILIR ve bilerek: bu sutundan onceki bir satir (ya da bu
-- sutunu yazmayan eski bir indexer) "bas bilinmiyor" demektir, ve okuma
-- katmani onu TAZE sayamaz -- `head-unknown` de bir bayatlik sebebidir.
ALTER TABLE sync_state ADD COLUMN head_block bigint
  CHECK (head_block IS NULL OR head_block >= 0);

COMMENT ON COLUMN sync_state.head_block IS
  'Indexer bu satiri yazarken GORDUGU zincir basi. `head_block - last_block` verinin BLOK cinsinden yasidir; `updated_at` ise surecin canliligidir. Ikisi de gereklidir: olu bir indexer eski bir head_block birakir (yasi kucuk gorunur, yazma bayatligi yakalar), canli ama geride bir indexer taze yazar (yazma bayatligi gormez, blok yasi yakalar).';
