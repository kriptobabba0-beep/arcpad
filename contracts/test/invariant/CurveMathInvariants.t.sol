// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveHandler} from "./CurveHandler.sol";

/// @dev V, T, S burada ve CurveHandler'in constructor argumanlarinda AYNI
///      olmak zorundadir (constructor sirasi initialQuote, initialToken,
///      saleSupply) -- aksi halde muhasebe kimlikleri bariz bir nedenle
///      kirilir.
///
///      NOT (tautoloji): brief'in ilk taslaginda `quoteReserve == V +
///      totalQuoteIn - totalGrossQuoteOut` ve `totalGrossQuoteOut -
///      totalNetQuoteOut == totalSellFees` seklinde iki invariant vardi.
///      Ikisi de handler kodunda AYNI degerin (cost / proceeds) iki
///      degiskene birden yazilmasindan ibaretti -- yani cebirsel olarak
///      `x == x`'e indirgeniyordu ve CurveMath ne dondururse dondursun
///      (hatta tamamen bozuk olsa bile) gecerdi. Yerlerine
///      `invariant_constantProductNeverDecreases` konuldu (asagida).
///
///      NOT (seyreltme): brief sonrasi eklenen `totalSellFees <=
///      totalGrossQuoteOut` / `totalBuyFees <= totalQuoteIn` toplam
///      invariant'lari da kaldirildi. 125 bps'te her biri kendi
///      karsiligininin ~%1,25'i civarinda oldugundan, karsilastirmanin
///      donmesi icin toplamin ~80 kat yanlis olmasi gerekiyordu -- olcum:
///      feeOn ciktisini x2, x10, x50, x80 ile carpmak SIFIR basarisizlik
///      verdi, x81 64/64 verdi. Yerlerine `buyExactTokens`/`sellExactTokens`
///      icinde CAGRI BASINA `fee <= cost` / `fee <= proceeds` kontrolu
///      konuldu (asagida `invariant_buyFeeNeverExceedsCost` /
///      `invariant_sellFeeNeverExceedsProceeds`).
///
///      NOT (yanlis ilk deneme): cagri basina kontrolun ilk hali handler
///      icinde `StdAssertions.assertLe` cagiriyordu. Bir mutasyonla test
///      edildiginde bunun ISE YARAMADIGI ortaya cikti: `vm.assertLe`
///      cheatcode'u basarisiz oldugunda cagrildigi CALL'u REVERT ETTIRIYOR,
///      ve bu CALL fuzzed hedef fonksiyona yapilan bir cagri oldugundan
///      `fail_on_revert = false` onu sessizce iskartaya cikariyor -- test
///      YESIL kaliyordu. Dogru desen: handler sadece bir sayaci artirir
///      (asla revert etmeyen duz aritmetik), gercek `assertEq(...,0)`
///      kontrolu ise burada, bir `invariant_` fonksiyonu icinde yapilir --
///      bu fonksiyon fuzzed hedef cagrisi degildir, `fail_on_revert`
///      tarafindan kapsanmaz (bkz. CurveHandler.sol'daki ayrintili not).
contract CurveMathInvariantsTest is Test {
    CurveHandler internal handler;

    uint256 internal constant T = 1_073_000_000_000_000;
    uint256 internal constant S = 793_100_000_000_000;
    uint256 internal constant V = 4_292_000_000;

    function setUp() public {
        handler = new CurveHandler(V, T, S);
        targetContract(address(handler));
    }

    /// Curve asla baslangictaki sanal quote rezervinin altina inemez.
    /// @dev Durustluk notu: bu, olcumle 0/256 tespit orani aldi -- ne
    ///      quoteBuyCost'un ne de quoteSellProceeds'un yuvarlama yonu
    ///      degistirildiginde kirilmiyor, cunku CurveHandler'daki floor
    ///      guard'i (bkz. sellExactTokens) ihlali ONCEDEN kesip sessizce
    ///      atlıyordu. O maskeleme artik yok: guard hala satisi engelliyor
    ///      (protokolun gercekte yapmasi gereken sey de bu), ama tetiklenme
    ///      sayisi `floorBreachAttempts` ile sayiliyor ve asagida ayri bir
    ///      invariant olarak dogrulaniyor. Bu invariant'in kendisi hala
    ///      esasen handler'in guard mantiginin (`<` vs `<=` off-by-one)
    ///      dogrulugunu test ediyor, CurveMath'i degil.
    function invariant_quoteReserveNeverFallsBelowVirtualFloor() public view {
        assertGe(handler.quoteReserve(), V);
    }

    /// Guard'in kendisi hicbir zaman tetiklenmemelidir. Dogru kutuphaneyle
    /// olcum: 51.200 cagride 0 tetiklenme. Tetiklenmesi, `quoteSellProceeds`'un
    /// floor'u ihlal edecek bir deger urettigi ve guard'in bunu SESSIZCE
    /// yuttugu anlamina gelir -- yani `invariant_quoteReserveNeverFallsBelowVirtualFloor`
    /// yesil kalsa bile CurveMath tarafi kirilmis olabilir. Bu invariant,
    /// maskelemeyi gorunur kilan sey.
    function invariant_floorGuardNeverFires() public view {
        assertEq(handler.floorBreachAttempts(), 0);
    }

    /// Token rezervi hicbir zaman baslangic degerini asamaz.
    /// @dev Durustluk notu: bu da 0/256 tespit orani aldi. `sellExactTokens`
    ///      `tokensIn`'i `_bound(tokensIn, 1, soldSoFar())` ile siniirlar --
    ///      bu bound'un kendisi tokenReserve'in initialTokenReserve'i
    ///      asmasini imkansiz kilar, CurveMath'in tokensIn'e ne yanit verdigi
    ///      ONEMSIZ (miktar dogrudan kullaniciyla belirlenir, kutuphaneden
    ///      hesaplanmaz). Bu, `_bound` argumanlarinda gelecekte bir off-by-one
    ///      olursa yakalayan ucuz bir regresyon koruyucusu; CurveMath'e karsi
    ///      bir kisit degil.
    function invariant_tokenReserveNeverExceedsInitial() public view {
        assertLe(handler.tokenReserve(), T);
    }

    /// Satilabilir arz asla baslangic satis arzini asamaz.
    /// @dev Durustluk notu: cebirsel olarak yukaridakiyle AYNI ozellik.
    ///      saleSupplyRemaining = tokenReserve - (T - S) her iki fonksiyonda
    ///      da korunan bir sabit oldugundan (`tokenReserve` ve
    ///      `saleSupplyRemaining` her alim/satimda AYNI miktarla degisir),
    ///      `saleSupplyRemaining <= S` ile `tokenReserve <= T` matematiksel
    ///      olarak denktir. Ikisi de burada tutuluyor cunku her ikisi de
    ///      handler'in dogru degiskeni guncelledigini dogrulayan ucuz bir
    ///      regresyon kontrolu (birini guncellemeyi unutmak gibi bir hata,
    ///      digeri sabit kalirken digeri kayarsa yakalanir) -- yine CurveMath'e
    ///      karsi bagimsiz bir kisit degil.
    function invariant_saleSupplyNeverExceedsInitial() public view {
        assertLe(handler.saleSupplyRemaining(), S);
    }

    /// Sabit carpim (quoteReserve * tokenReserve) HERHANGI bir alim/satim
    /// dizisinde asla kucalmez. Bu tesadufi degil: quoteBuyCost alicinin
    /// odedigini yukari, quoteSellProceeds saticinin aldigini asagi
    /// yuvarlar ve HER IKI yuvarlama da ayri ayri urunu yukari iter (bkz.
    /// kanit: k_sonra = (V+cost)(T-tokensOut) >= V*T cunku cost >=
    /// tokensOut*V/(T-tokensOut); satista simetrik; `buyExactQuoteIn` yolu
    /// icin de ayni kanit `CurveHandler.sol`'da). Yuvarlama yonlerinden biri
    /// ters cevrilseydi bu invariant, tek bir al-sat turundan cok daha once
    /// -- rastgele, cok adimli bir dizide -- kirilirdi. Olcumle dogrulandi:
    /// `quoteBuyCost`'tan `+1`'i kaldirmak 256/256 kosuda ILK alimda
    /// tetikler; `quoteSellProceeds`'u yukari yuvarlamaya cevirmek 252/256
    /// kosuda tetikler. Bu paketteki en guclu iddia budur.
    function invariant_constantProductNeverDecreases() public view {
        assertGe(
            handler.quoteReserve() * handler.tokenReserve(),
            handler.initialQuoteReserve() * handler.initialTokenReserve()
        );
    }

    /// `feeOn`'un kendi garantisi (`fee <= amount`), `buyExactTokens`'in
    /// kullandigi EXCLUSIVE yolda (`quoteBuyCost` + `feeOn(cost, bps)`)
    /// cagri basina dogrulanir. Toplam-tabanli versiyonun 125 bps'te ~80x
    /// pay biraktigi olculdugu icin (yukaridaki NOT) buraya tasindi.
    function invariant_buyFeeNeverExceedsCost() public view {
        assertEq(handler.buyFeeViolations(), 0);
    }

    /// Ayni garanti, `sellExactTokens`'in kullandigi yol icin.
    function invariant_sellFeeNeverExceedsProceeds() public view {
        assertEq(handler.sellFeeViolations(), 0);
    }
}
