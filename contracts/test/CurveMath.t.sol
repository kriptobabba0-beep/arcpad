// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

/// @dev Referans degerler pump.fun'in canli Global hesabindan (2026-07-27)
///      okunmustur. Beklenen sonuclar tamsayi aritmetigiyle onceden
///      hesaplanmis olup, kutuphanenin bunlari birebir uretmesi gerekir.
contract CurveMathTest is Test {
    uint256 internal constant T = 1_073_000_000_000_000;
    uint256 internal constant S = 793_100_000_000_000;
    uint256 internal constant N = 1_000_000_000_000_000;
    uint256 internal constant V_SOL = 30_000_000_000;
    uint256 internal constant V_USDC = 4_292_000_000;

    uint256 internal constant CURVE_FEE_BPS = 125; // %1,25 = 95 protokol + 30 creator

    // ---------------------------------------------------------------
    // pump.fun esitlik testleri
    // ---------------------------------------------------------------

    /// pump.fun'in meshur 85 SOL esigi bir parametre degil, bu formulun sonucu.
    function test_graduationRaiseReproducesPumpFunSolThreshold() public pure {
        assertEq(CurveMath.graduationRaise(V_SOL, S, T), 85_005_359_056);
    }

    /// USDC-quote'lu curve icin ayni formul 12.161 USDC verir.
    function test_graduationRaiseReproducesPumpFunUsdcThreshold() public pure {
        assertEq(CurveMath.graduationRaise(V_USDC, S, T), 12_161_433_369);
    }

    /// Havuz tohumu arzi: sureklilik kosulunun sadelestirilmis hali.
    function test_poolSeedSupplyMatchesPumpFunReservedSupply() public pure {
        assertEq(CurveMath.poolSeedSupply(S, T), 206_886_011_183_597);
    }

    /// pump.fun rezerve arzi yuvarlak 206.900.000'a sabitlemis; sureklilik
    /// formulunun verdigi deger bundan ~13.989 token daha azdir. Aradaki fark
    /// graduation'da kilitlenen artik arzdir -- bir hata degil, tasarim.
    function test_reservedSupplyExceedsExactSeedAndDifferenceIsLocked() public pure {
        uint256 exactSeed = CurveMath.poolSeedSupply(S, T);
        uint256 pumpFunReserved = N - S;
        assertGt(pumpFunReserved, exactSeed);
        assertEq(pumpFunReserved - exactSeed, 13_988_816_403);
    }

    /// USDC curve'un acilis FDV'si tam olarak 4.000 USDC -- kasitli yuvarlak.
    function test_openingMarketCapIsExactlyFourThousandUsdc() public pure {
        assertEq(CurveMath.marketCap(V_USDC, T, N), 4_000_000_000);
    }

    function test_openingMarketCapSolCurve() public pure {
        assertEq(CurveMath.marketCap(V_SOL, T, N), 27_958_993_476);
    }

    // ---------------------------------------------------------------
    // Yuvarlama yonleri -- her biri protokol lehine
    // ---------------------------------------------------------------

    /// Alim maliyeti floor + 1'dir. Tam bolunen bir durumda bile bir fazla
    /// alinir; mulDivRoundingUp ile ayni sey DEGILDIR.
    function test_buyCostAddsOneEvenWhenDivisionIsExact() public pure {
        // 1 * 100 / (200 - 1) = 0 (taban), + 1 = 1
        assertEq(CurveMath.quoteBuyCost(1, 100, 200), 1);
        // tam bolunen kurgu: 50 * 100 / (150 - 50) = 50, + 1 = 51
        assertEq(CurveMath.quoteBuyCost(50, 100, 150), 51);
    }

    function test_feeRoundsUp() public pure {
        assertEq(CurveMath.feeOn(1_000_000, 125), 12_500); // tam bolunur
        assertEq(CurveMath.feeOn(1, 125), 1); // 1 wei bile ucret dogurur
        assertEq(CurveMath.feeOn(0, 125), 0);
    }

    function test_sellProceedsRoundDown() public pure {
        // 1 * 100 / (200 + 1) = 0
        assertEq(CurveMath.quoteSellProceeds(1, 100, 200), 0);
    }

    function test_netQuoteInSubtractsOneBeforeDividing() public pure {
        // (1_000_000 - 1) * 10_000 / 10_125 = 987_653
        assertEq(CurveMath.netQuoteIn(1_000_000, CURVE_FEE_BPS), 987_653);
    }

    // ---------------------------------------------------------------
    // Ucret sozlesmeleri -- feeOn (EXCLUSIVE) ve netQuoteIn (INCLUSIVE)
    // birbirinin tersi DEGILDIR; bu iliski varsayilmak yerine sabitlenir.
    // ---------------------------------------------------------------

    /// feeOn `amount`'in USTUNE ucret ekler (EXCLUSIVE); netQuoteIn ise
    /// ucretin `grossQuoteIn`'in ICINE gomulu oldugunu varsayar (INCLUSIVE).
    /// Ikisi ayni bps ile cagrilsa bile FARKLI sayilar uretir -- zincirlenip
    /// birbirinin tersi gibi kullanilmamalidir.
    function test_netQuoteInAndFeeOnUseIncompatibleFeeConventions() public pure {
        uint256 gross = 1_000_000;

        uint256 net = CurveMath.netQuoteIn(gross, CURVE_FEE_BPS);
        uint256 impliedFee = gross - net;

        // Tanim geregi: INCLUSIVE ayristirmada net + impliedFee daima gross'a esittir.
        assertEq(net, 987_653);
        assertEq(impliedFee, 12_347);
        assertEq(net + impliedFee, gross);

        // feeOn (EXCLUSIVE) net miktar uzerinden FARKLI bir ucret uretir --
        // impliedFee (INCLUSIVE) ile karistirilmamalidir.
        assertEq(CurveMath.feeOn(net, CURVE_FEE_BPS), 12_346);
        assertTrue(CurveMath.feeOn(net, CURVE_FEE_BPS) != impliedFee);

        // gross - feeOn(gross) da impliedFee'ye esit DEGILDIR.
        assertEq(CurveMath.feeOn(gross, CURVE_FEE_BPS), 12_500);
        assertTrue(gross - CurveMath.feeOn(gross, CURVE_FEE_BPS) != impliedFee);
    }

    // ---------------------------------------------------------------
    // Somut curve ornekleri (USDC profili, yeni curve)
    // ---------------------------------------------------------------

    function test_oneUsdcNetBuysExpectedTokens() public pure {
        assertEq(CurveMath.quoteBuyTokensOut(1_000_000, V_USDC, T), 249_941_765_665);
    }

    function test_oneMillionTokensCostOnNewCurve() public pure {
        assertEq(CurveMath.quoteBuyCost(1_000_000_000_000, V_USDC, T), 4_003_732);
    }

    function test_sellingOneMillionTokensOnNewCurveYieldsLess() public pure {
        assertEq(CurveMath.quoteSellProceeds(1_000_000_000_000, V_USDC, T), 3_996_275);
    }

    // ---------------------------------------------------------------
    // Hata durumlari
    // ---------------------------------------------------------------

    /// @dev CurveMath'in fonksiyonlari `internal pure` oldugundan cagrilari
    ///      ayri bir CALL cercevesi acmaz -- revert, cheatcode'un calistigi
    ///      cerceveyle AYNI derinlikte olusur. vm.expectRevert() varsayilan
    ///      olarak bir alt derinlik bekler; bu yuzden ayni oruntuyu kullanan
    ///      v4-core (bkz. lib/v4-core/foundry.toml, allow_internal_expect_revert)
    ///      ve v4-periphery'nin BipsLibrary.t.sol testleriyle birebir ayni
    ///      forge-config bayragi gerekir. foundry.toml'a dokunmadan, sadece bu
    ///      testlere kapsamli olarak uygulanir.
    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyCostRevertsWhenTokensOutMeetsReserve() public {
        vm.expectRevert(CurveMath.InsufficientTokenReserve.selector);
        CurveMath.quoteBuyCost(T, V_USDC, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyCostRevertsWhenTokensOutExceedsReserve() public {
        vm.expectRevert(CurveMath.InsufficientTokenReserve.selector);
        CurveMath.quoteBuyCost(T + 1, V_USDC, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_netQuoteInRevertsOnZero() public {
        vm.expectRevert(CurveMath.ZeroAmount.selector);
        CurveMath.netQuoteIn(0, CURVE_FEE_BPS);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyCostRevertsOnZeroTokensOut() public {
        vm.expectRevert(CurveMath.ZeroAmount.selector);
        CurveMath.quoteBuyCost(0, V_USDC, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyTokensOutRevertsOnZeroNetQuoteIn() public {
        vm.expectRevert(CurveMath.ZeroAmount.selector);
        CurveMath.quoteBuyTokensOut(0, V_USDC, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_sellProceedsRevertsOnZeroTokensIn() public {
        vm.expectRevert(CurveMath.ZeroAmount.selector);
        CurveMath.quoteSellProceeds(0, V_USDC, T);
    }

    // ---------------------------------------------------------------
    // Hata durumlari -- sifir rezerv (drain onleme)
    // ---------------------------------------------------------------

    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyCostRevertsOnZeroQuoteReserve() public {
        vm.expectRevert(CurveMath.ZeroReserve.selector);
        CurveMath.quoteBuyCost(1_000_000_000_000, 0, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyTokensOutRevertsOnZeroQuoteReserve() public {
        vm.expectRevert(CurveMath.ZeroReserve.selector);
        CurveMath.quoteBuyTokensOut(1_000_000, 0, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyTokensOutRevertsOnZeroTokenReserve() public {
        vm.expectRevert(CurveMath.ZeroReserve.selector);
        CurveMath.quoteBuyTokensOut(1_000_000, V_USDC, 0);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_sellProceedsRevertsOnZeroQuoteReserve() public {
        vm.expectRevert(CurveMath.ZeroReserve.selector);
        CurveMath.quoteSellProceeds(1_000_000_000_000, 0, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_sellProceedsRevertsOnZeroTokenReserve() public {
        vm.expectRevert(CurveMath.ZeroReserve.selector);
        CurveMath.quoteSellProceeds(1_000_000_000_000, V_USDC, 0);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_marketCapRevertsOnZeroTokenReserve() public {
        vm.expectRevert(CurveMath.ZeroReserve.selector);
        CurveMath.marketCap(V_USDC, 0, N);
    }

    // ---------------------------------------------------------------
    // Hata durumlari -- yetersiz satis arzi (graduationRaise / poolSeedSupply)
    // ---------------------------------------------------------------

    /// forge-config: default.allow_internal_expect_revert = true
    function test_graduationRaiseRevertsWhenSaleSupplyMeetsTokenReserve() public {
        vm.expectRevert(CurveMath.InsufficientTokenReserve.selector);
        CurveMath.graduationRaise(V_USDC, T, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_poolSeedSupplyRevertsWhenSaleSupplyMeetsTokenReserve() public {
        vm.expectRevert(CurveMath.InsufficientTokenReserve.selector);
        CurveMath.poolSeedSupply(T, T);
    }

    // ---------------------------------------------------------------
    // Hata durumlari -- sinirsiz bps kabul edilmez
    // ---------------------------------------------------------------

    /// forge-config: default.allow_internal_expect_revert = true
    function test_feeOnRevertsWhenBpsExceedsDenominator() public {
        vm.expectRevert(CurveMath.InvalidBps.selector);
        CurveMath.feeOn(1_000_000, 10_001);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_netQuoteInRevertsWhenBpsExceedsDenominator() public {
        vm.expectRevert(CurveMath.InvalidBps.selector);
        CurveMath.netQuoteIn(1_000_000, 10_001);
    }

    /// bps sinirinin GECEN tarafi (10_001) reddedilir, ama bu tek basina
    /// sinirin bir-fazla-dar (>= yerine >) olmadigini KANITLAMAZ. Sinirin
    /// tam UZERINDEKI (== BPS_DENOMINATOR, %100 ucret) deger BASARIYLA
    /// gecmelidir -- bu testler o taraf.
    function test_feeOnAllowsBpsEqualToDenominator() public pure {
        // %100 ucret: tum miktar ucret olarak doner.
        assertEq(CurveMath.feeOn(1_000_000, 10_000), 1_000_000);
    }

    function test_netQuoteInAllowsBpsEqualToDenominator() public pure {
        // (1_000_000 - 1) * 10_000 / (10_000 + 10_000) = 499_999
        assertEq(CurveMath.netQuoteIn(1_000_000, 10_000), 499_999);
    }
}
