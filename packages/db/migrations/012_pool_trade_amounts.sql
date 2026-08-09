-- HAVUZ ISLEMLERI ICIN MIKTAR KISITLARI: `> 0` DEGIL, `>= 0`.
--
-- 003, `trades.token_amount_tok > 0` ve `quote_amount_wei > 0` yaziyordu ve
-- gerekcesini de yaziyordu: "Ikisi de zincirde sifirdan buyuk garantidir"
-- (`ZeroTokensOut`, `ZeroTokensIn`, `NetTooSmall`). O CUMLE EGRI ICIN
-- DOGRUDUR VE OYLE KALIYOR. Havuz icin DEGILDIR, ve fark bir tercih degil
-- iki venue'nun aritmetigidir:
--
--   Egri, her giris noktasinda sifir sonucu ACIKCA REVERT EDER.
--   Uniswap V4 yalnizca `amountSpecified == 0`i reddeder
--   (`SwapAmountCannotBeZero`); SONUCUN sifir olmasini reddetmez. Launch
--   tokeni 18 decimal, quote bacagi 6 decimal'dir -- yani 1 wei token satmak
--   `floor` sonrasi 0 quote birimi getirir, ve bu GECERLI, ONAYLANMIS, GERCEK
--   bir swap'tir. Aradaki 10^12'lik decimal farki bu vakayi ulasilabilir
--   kilan seyin ta kendisi.
--
-- KISITI OLDUGU GIBI BIRAKMANIN BEDELI OLCULEBILIR VE KALICIDIR: boyle bir
-- `Swap` geldiginde INSERT patlar, aralik geri alinir, imlec ILERLEMEZ, ve
-- hata adi hicbir "gecici" kumesinde olmadigi icin surec oler. Her yeniden
-- baslatma AYNI araligi oynatir ve AYNI yerde oler. Yani zincirdeki bir toz
-- islemi indexer'i KALICI olarak durdurur -- bu deponun `startBlock`
-- kapisinda zaten bir kez adlandirdigi ariza kipinin aynisi.
--
-- SIFIR SATIRIN OKUMA TARAFINDAKI ANLAMI DA YAZILI OLSUN: o satirin
-- `quote/token` orani bir FIYAT DEGILDIR (0/x ya da x/0). Fiyati islem
-- miktarlarindan turetecek her okuma, sifir bacakli satiri ATLAMAK
-- ZORUNDADIR. Satirin kendisi yine de yazilir cunku olan bir sey oldu;
-- yazmamak, defter kapsam kontrolunu (`assertRangeApplied`) kirar ve olayi
-- sessizce dusururdu.

ALTER TABLE trades DROP CONSTRAINT trades_token_amount_tok_check;
ALTER TABLE trades DROP CONSTRAINT trades_quote_amount_wei_check;

-- ALT SINIR HER SATIR ICIN DURUYOR. Negatif bir miktar iki venue'da da
-- imkansizdir: egri `uint256` yayar, havuz tarafinda ise mutlak deger alinir.
-- Isaretli okumanin (`int128`) bozulmasi tam olarak burada gorunur.
ALTER TABLE trades
  ADD CONSTRAINT trades_amounts_are_not_negative
    CHECK (token_amount_tok >= 0 AND quote_amount_wei >= 0);

-- VE EGRI SATIRLARI ICIN ESKI, DAHA GUCLU KISIT AYNEN KALIYOR. Kaldirmak,
-- olculmus bir zincir garantisini semadan silmek olurdu.
ALTER TABLE trades
  ADD CONSTRAINT trades_curve_amounts_are_positive
    CHECK (source <> 'curve' OR (token_amount_tok > 0 AND quote_amount_wei > 0));
