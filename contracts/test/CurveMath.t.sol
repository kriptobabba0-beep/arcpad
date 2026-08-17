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
        assertEq(CurveMath.graduationRaise(S, V_SOL, T), 85_005_359_056);
    }

    /// USDC-quote'lu curve icin ayni formul 12.161 USDC verir.
    function test_graduationRaiseReproducesPumpFunUsdcThreshold() public pure {
        assertEq(CurveMath.graduationRaise(S, V_USDC, T), 12_161_433_369);
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

    // ---------------------------------------------------------------
    // Zincirin exact-quote-in algoritmasi (buy_exact_sol_in doc-comment'i)
    // ---------------------------------------------------------------

    /// 1. adim: girdiden 1 CIKARILMAZ. SDK'nin tahmin edicisi cikariyordu; zincir
    /// cikarmiyor. Bolme tam bolundugunde ikisi farkli sonuc verir.
    function test_netBeforeCorrectionDoesNotSubtractOneFromInput() public pure {
        // 10_125 * 10_000 / 10_125 = 10_000 tam bolunur.
        // Eski SDK kurali (gross-1) ile 9_999 verirdi.
        assertEq(CurveMath.netQuoteInBeforeCorrection(10_125, CURVE_FEE_BPS), 10_000);
    }

    /// 3. adim: iki BAGIMSIZ tavan yuvarlamasi butceyi asabilir; program revert
    /// ETMEZ, net'i kisar. Bu girdide tasma tam olarak 1 birimdir.
    ///   gross      = 1_000_013
    ///   duzeltmesiz= 1_000_013 * 10_000 / 10_125            = 987_667
    ///   ucretler   = ceil(987_667*95/1e4) + ceil(987_667*30/1e4)
    ///              = 9_383 + 2_964                          =  12_347
    ///   987_667 + 12_347 = 1_000_014 > 1_000_013            -> tasma 1
    ///   duzeltilmis                                         = 987_666
    function test_correctionShrinksNetWhenTheTwoCeilsOvershootTheBudget() public pure {
        assertEq(CurveMath.netQuoteInBeforeCorrection(1_000_013, CURVE_FEE_BPS), 987_667);
        (uint256 net,,) = CurveMath.correctedNetQuoteIn(1_000_013, 95, 30);
        assertEq(net, 987_666);
    }

    /// Ucretler DUZELTME ONCESI net uzerinden hesaplanir ve 3. adimdan sonra
    /// YENIDEN HESAPLANMAZ. Bu, fonksiyonun en kolay yanlis anlasilan tarafi
    /// oldugu icin ucretler donduruluyor -- ve burada sabitleniyor.
    ///   duzeltme oncesi net = 987_667
    ///   protocolFee = ceil(987_667*95/1e4) = 9_383
    ///   creatorFee  = ceil(987_667*30/1e4) = 2_964
    ///   duzeltilmis net = 987_666
    ///   987_666 + 9_383 + 2_964 = 1_000_013 = gross  -> TAM
    function test_feesAreChargedOnThePreCorrectionNetAndSumExactlyToGross() public pure {
        (uint256 net, uint256 protocolFee, uint256 creatorFee) = CurveMath.correctedNetQuoteIn(1_000_013, 95, 30);

        assertEq(net, 987_666);
        assertEq(protocolFee, 9_383);
        assertEq(creatorFee, 2_964);
        assertEq(net + protocolFee + creatorFee, 1_000_013);
    }

    /// Ayni girdide, donen net uzerinden ucreti YENIDEN hesaplamak farkli --
    /// ve YANLIS -- bir sonuc verir: creator 2_964 yerine 2_963 alirdi ve
    /// kullanicinin odemesinin 1 birimi ne anapara ne ucret olurdu. Cagiranin
    /// bunu yapmasi icin bir sebep olmasin diye ucretler donduruluyor; bu
    /// test o tuzagi sabitler.
    function test_recomputingTheFeeOnTheCorrectedNetUnderchargesByOne() public pure {
        (uint256 net, uint256 protocolFee, uint256 creatorFee) = CurveMath.correctedNetQuoteIn(1_000_013, 95, 30);

        uint256 recomputed = CurveMath.feeOn(net, 95) + CurveMath.feeOn(net, 30);
        assertEq(CurveMath.feeOn(net, 95), 9_383); // protokol payi ayni...
        assertEq(CurveMath.feeOn(net, 30), 2_963); // ...creator payi 1 EKSIK
        assertEq(recomputed, 12_346);
        assertEq(protocolFee + creatorFee, 12_347);
        assertEq(net + recomputed, 1_000_012); // butceye 1 birim eksik oturur
        assertLt(recomputed, protocolFee + creatorFee);
    }

    /// Duzeltme nadir bir uc durum DEGILDIR: gross in [4, 40000] araliginin
    /// 20.015'inde duzeltilmis net, duzeltmesiz net'ten FARKLI cikar. 3. adimi
    /// atlayan bir uygulama, pump.fun'in kabul ettigi girdilerin yaklasik
    /// yarisinda yanlis sonuc verir.
    /// @dev Aralik [1, 40_000] yerine [4, 40_000]: gross = 2 revert eder ve
    ///      gross = 3'te duzeltme tetiklenir ama sonucu quoteBuyTokensOut
    ///      kabul etmez; ikisi de correctedNetQuoteIn'in gecerli calisma
    ///      araligi disindadir. Eski predicate sayimi [1, 40_000] icin
    ///      20_017 idi ve bu iki degeri de sayiyordu (gross = 1'de duzeltme
    ///      tetiklenmez), yani 20_017 - 2 = 20_015.
    /// @dev Bu test artik predicate'i satir ici yeniden kurmuyor,
    ///      `correctedNetQuoteIn`'i CAGIRIYOR -- onceki hali 3. adimi hic
    ///      calistirmadigi icin adinin korudugu mutasyonlarin (3. adimin
    ///      kaldirilmasi, birlesik oranla ucret) HICBIRINI yakalamiyordu.
    function test_correctionIsNotAnEdgeCase() public pure {
        uint256 triggered;
        for (uint256 g = 4; g <= 40_000; ++g) {
            (uint256 net,,) = CurveMath.correctedNetQuoteIn(g, 95, 30);
            if (net != CurveMath.netQuoteInBeforeCorrection(g, CURVE_FEE_BPS)) ++triggered;
        }
        assertEq(triggered, 20_015);
    }

    /// 4. adim: -1 curve teriminin ICINDE. Elle turetilmis:
    ///   (987_666 - 1) * T / (V_USDC + 987_666 - 1)
    ///   = 987_665 * 1_073_000_000_000_000 / 4_292_987_665
    ///   = 246_859_443_282
    function test_buyTokensOutSubtractsOneInsideTheCurveTerm() public pure {
        assertEq(CurveMath.quoteBuyTokensOut(987_666, V_USDC, T), 246_859_443_282);
    }

    /// Ayni girdide SDK tahmin edicisi 246_859_693_167 vaat ederdi -- zincirden
    /// 249_885 birim FAZLA. Kullanici lehine yuvarlayan formulun geri sizmasini
    /// yakalayan sabitlenmis deger budur.
    function test_theSdkEstimatorWouldHaveOverQuotedThisInput() public pure {
        assertLt(CurveMath.quoteBuyTokensOut(987_666, V_USDC, T), 246_859_693_167);
    }

    /// Duzeltilmis net 1'e dustugunde (net-1)=0 olur ve sifir token verirdi.
    /// Sessizce sifir dondurmek yerine revert: cagiran para odeyip hicbir sey
    /// almamali. Kucuk tutarlarda duzeltme net'i gercekten 0'a indirir --
    /// gross=2 icin duzeltmesiz net=1, ucretler=2, tasma=1.
    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyTokensOutRevertsWhenNetIsOne() public {
        vm.expectRevert(CurveMath.NetTooSmall.selector);
        CurveMath.quoteBuyTokensOut(1, V_USDC, T);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_correctedNetRevertsWhenTheCorrectionWouldEraseIt() public {
        vm.expectRevert(CurveMath.NetTooSmall.selector);
        CurveMath.correctedNetQuoteIn(2, 95, 30);
    }

    // ---------------------------------------------------------------
    // Ucret sozlesmeleri. Eski test (test_netQuoteInAndFeeOnUseIncompatible-
    // FeeConventions) "feeOn(net, birlesikBps) != gross - net" diyordu ve bunu
    // gross = 1_000_000'da sabitliyordu. O iddia ARTIK YANLIS: 1 cikarma
    // girdiden kalkinca net 987_653 -> 987_654 oldu ve o girdide
    // feeOn(987_654, 125) = 12_346 = gross - net, yani iki taraf ESITLENDI.
    // Gecerliligini koruyan -- ve zincir algoritmasinin gercekten dayandigi --
    // uyumsuzluk baskadir: zincir ucreti IKI BAGIMSIZ tavan yuvarlamasindan
    // toplar ve bu toplam, BIRLESIK oranin tek tavan yuvarlamasiyla ayni
    // degildir. 3. adimin kistigi tasma tam olarak bu farktir.
    // ---------------------------------------------------------------

    /// Elle turetilmis, gross = 1_000_013:
    ///   net           = 1_000_013 * 10_000 / 10_125          = 987_667
    ///   impliedFee    = 1_000_013 - 987_667                  =  12_346
    ///   BIRLESIK      = ceil(987_667 * 125 / 1e4)            =  12_346
    ///   PARCALI       = ceil(987_667*95/1e4)+ceil(987_667*30/1e4)
    ///                 = 9_383 + 2_964                        =  12_347
    /// Zincir PARCALI olani tahsil eder; birlesik oran ileri yonde
    /// kullanilmaz. Aradaki 1 birim, net + ucret toplamini butcenin 1 uzerine
    /// tasiyan seydir ve 3. adim tam olarak onu geri kisar.
    function test_splitCeilsChargeMoreThanTheCombinedRate() public pure {
        uint256 gross = 1_000_013;

        uint256 net = CurveMath.netQuoteInBeforeCorrection(gross, CURVE_FEE_BPS);
        assertEq(net, 987_667);

        // INCLUSIVE ayristirmanin ima ettigi ucret. (net + impliedFee == gross
        // ozdesligi burada SABITLENMEZ: impliedFee bir satir once gross - net
        // olarak tanimlandigi icin o esitlik hicbir mutasyon altinda
        // bozulamaz -- yani hicbir sey kanitlamaz.)
        uint256 impliedFee = gross - net;
        assertEq(impliedFee, 12_346);

        // Birlesik oranin TEK tavan yuvarlamasi butceye tam sigar...
        assertEq(CurveMath.feeOn(net, CURVE_FEE_BPS), 12_346);
        assertEq(net + CurveMath.feeOn(net, CURVE_FEE_BPS), gross);

        // ...ama zincirin fiilen tahsil ettigi IKI PARCALI ucret sigmaz.
        assertEq(CurveMath.feeOn(net, 95), 9_383);
        assertEq(CurveMath.feeOn(net, 30), 2_964);
        assertEq(CurveMath.feeOn(net, 95) + CurveMath.feeOn(net, 30), 12_347);
        assertTrue(CurveMath.feeOn(net, 95) + CurveMath.feeOn(net, 30) > CurveMath.feeOn(net, CURVE_FEE_BPS));

        // EXCLUSIVE orani BRUT tutara uygulamak, INCLUSIVE ayrisimin ima
        // ettigi ucretten FAZLA alir -- ayni bps, farkli sozlesme. Fark
        // sabitleniyor: 12_501 - 12_346 = 155. (Eski surum burada
        // `gross - feeOn(gross) != impliedFee` diyordu; o, 987_512 != 12_346
        // demekti ve bir yuvarlama ozelligini degil, sadece iki sayinin
        // buyukluk farkini dogruluyordu.)
        assertEq(CurveMath.feeOn(gross, CURVE_FEE_BPS), 12_501);
        assertGt(CurveMath.feeOn(gross, CURVE_FEE_BPS), impliedFee);
        assertEq(CurveMath.feeOn(gross, CURVE_FEE_BPS) - impliedFee, 155);
    }

    // ---------------------------------------------------------------
    // Somut curve ornekleri (USDC profili, yeni curve)
    // ---------------------------------------------------------------

    /// Elle turetilmis, 4. adima gore (`-1` curve teriminin ICINDE):
    ///   (1_000_000 - 1) * T / (V_USDC + 1_000_000 - 1)
    ///   = 999_999 * 1_073_000_000_000_000 / 4_292_999_999
    ///   = 249_941_515_781
    /// Eski (duzeltmesiz) gövde `-1` uygulamadigi icin 249_941_765_665
    /// veriyordu -- zincirden 249_884 birim FAZLA.
    function test_oneUsdcNetBuysExpectedTokens() public pure {
        assertEq(CurveMath.quoteBuyTokensOut(1_000_000, V_USDC, T), 249_941_515_781);
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
    function test_netBeforeCorrectionRevertsOnZero() public {
        vm.expectRevert(CurveMath.ZeroAmount.selector);
        CurveMath.netQuoteInBeforeCorrection(0, CURVE_FEE_BPS);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyCostRevertsOnZeroTokensOut() public {
        vm.expectRevert(CurveMath.ZeroAmount.selector);
        CurveMath.quoteBuyCost(0, V_USDC, T);
    }

    /// Sifir girdi hala reddedilir, ama artik `ZeroAmount` ile DEGIL: 4. adim
    /// gövdesi `net - 1`'i besleyemeyecek her girdiyi (`<= 1`) tek bir
    /// `NetTooSmall` ile eler. Sifir o kumenin alt ucudur; ayri bir
    /// `ZeroAmount` dali tutmak, 0 ile 1 arasinda cagirana hicbir sey
    /// anlatmayan bir ayrim yapardi.
    /// forge-config: default.allow_internal_expect_revert = true
    function test_buyTokensOutRevertsOnZeroNetQuoteIn() public {
        vm.expectRevert(CurveMath.NetTooSmall.selector);
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
        CurveMath.graduationRaise(T, V_USDC, T);
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
    function test_netBeforeCorrectionRevertsWhenBpsExceedsDenominator() public {
        vm.expectRevert(CurveMath.InvalidBps.selector);
        CurveMath.netQuoteInBeforeCorrection(1_000_000, 10_001);
    }

    /// bps sinirinin GECEN tarafi (10_001) reddedilir, ama bu tek basina
    /// sinirin bir-fazla-dar (>= yerine >) olmadigini KANITLAMAZ. Sinirin
    /// tam UZERINDEKI (== BPS_DENOMINATOR, %100 ucret) deger BASARIYLA
    /// gecmelidir -- bu testler o taraf.
    function test_feeOnAllowsBpsEqualToDenominator() public pure {
        // %100 ucret: tum miktar ucret olarak doner.
        assertEq(CurveMath.feeOn(1_000_000, 10_000), 1_000_000);
    }

    /// Girdiden 1 kalktigi icin bu deger 499_999'dan 500_000'e cikti:
    /// 1_000_000 * 10_000 / (10_000 + 10_000) = 500_000 (tam bolunur).
    function test_netBeforeCorrectionAllowsBpsEqualToDenominator() public pure {
        assertEq(CurveMath.netQuoteInBeforeCorrection(1_000_000, 10_000), 500_000);
    }
}
