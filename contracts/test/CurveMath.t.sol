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
}
