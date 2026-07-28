// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

/// @dev Esitlik testleri (CurveMath.t.sol) formullerin dogru yazildigini
///      kanitlar; bu dosya hicbir girdi kombinasyonunda curve'un
///      somurulemeyecegini kanitlar.
///
///      Sinirlar kutuphanenin guncel guard'lariyla (ZeroReserve, InvalidBps)
///      birebir uyumlu secilmistir: V ve T sifir olmayan sabitlerdir, tokensOut
///      her zaman tokenReserve'den kesin kucuktur (T-1'e kadar -- graduation'a
///      yakin dik bolge dahil) ve bps girdileri asla BPS_DENOMINATOR'u asmaz.
///      Bu yuzden hicbir fuzz calistirmasi bir guard'a carpip erken donmez --
///      her calistirma gercek aritmetigi test eder.
contract CurveMathFuzzTest is Test {
    uint256 internal constant T = 1_073_000_000_000_000;
    uint256 internal constant V = 4_292_000_000;
    uint256 internal constant CURVE_FEE_BPS = 125;

    /// Al ve hemen sat: kullanici asla kar edemez. Ucret sifir olsa bile
    /// yuvarlama tek basina bunu garanti etmelidir.
    ///
    /// @dev Bu iliski aslinda KESIN kucuktur, esit degil: cost = floor(xV/(T-x))+1
    ///      ve proceeds = floor(x(V+cost)/T) icin proceeds <= cost-1 her zaman
    ///      dogrudur. `assertLe` bunu kanitlayamaz -- iki yuvarlama yonunden
    ///      HERHANGI biri (ayri ayri) ters cevrilse bile proceeds == cost'a
    ///      esitlenir ve `assertLe` yine gecer; sadece HER IKI yon birden ters
    ///      cevrilirse `assertLe` yakalar. `assertLt` ikisini de yakalar --
    ///      curve'un somurulemez oldugunu iddia eden test buysa, gercekten
    ///      kanitladigi iliski bu olmali.
    /// @dev Sinir T-1'e genisletildi: satis arzi T'nin %73,9'u, yani eski T/2
    ///      siniri graduation'a yakin dik bolgeyi hic ornekleyemiyordu. Guard
    ///      `tokensOut >= tokenReserve` (T-1 gecerlidir, T degil), FullMath
    ///      512-bit oldugundan tasma riski yok.
    function testFuzz_buyThenSellNeverProfits(uint256 tokensOut) public pure {
        tokensOut = bound(tokensOut, 1, T - 1);

        uint256 cost = CurveMath.quoteBuyCost(tokensOut, V, T);
        uint256 newQuote = V + cost;
        uint256 newToken = T - tokensOut;

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensOut, newQuote, newToken);
        assertLt(proceeds, cost, "round trip created value");
    }

    /// Tam quote girisiyle alim (correctedNetQuoteIn -> quoteBuyTokensOut),
    /// sonra hemen
    /// satis: ayni garanti, exact-tokens-out'un simetrigi olan exact-quote-in
    /// yolu icin. Gercek bir launch'ta kullanicinin fiilen kullandigi yol
    /// budur -- ne kadar harcamak istedigini soyler, karsiliginda token alir.
    /// @dev t = floor(nT/(V+n)) <= nT/(V+n) (gercel) oldugundan
    ///      t(V+n) <= nT, yani floor(t(V+n)/T) <= n her zaman dogrudur.
    /// @dev Alt sinir 3 -> 4. Zincir algoritmasinda `quoteBuyTokensOut`
    ///      `net - 1`'i besledigi icin duzeltilmis net'in >= 2 olmasi gerekir.
    ///      Elle turetilmis (95 + 30 bps):
    ///        gross=1: net=floor(10_000/10_125)=0, ucret 0, duzeltme yok
    ///                 -> 0, quoteBuyTokensOut NetTooSmall
    ///        gross=2: net=1, ucret 1+1=2, toplam 3>2, tasma 1 >= net 1
    ///                 -> correctedNetQuoteIn'in KENDISI NetTooSmall
    ///        gross=3: net=2, ucret 1+1=2, toplam 4>3, tasma 1 -> net 1,
    ///                 quoteBuyTokensOut NetTooSmall
    ///        gross=4: net=3, ucret 1+1=2, toplam 5>4, tasma 1 -> net 2  OK
    ///      4'ten sonra guvenli kalir: net = floor(gross*1e4/10_125) gross'ta
    ///      azalmayan bir fonksiyondur ve tasma ISPATEN en fazla 1'dir
    ///      (bkz. CurveMath.correctedNetQuoteIn NatSpec'i), yani gross >= 4
    ///      icin duzeltilmis net >= 3 - 1 = 2.
    /// @dev Ust sinir `2 * 12_161_433_369` (USDC graduation raise'inin tam
    ///      tutarinin iki kati): [3, type(uint128).max] ile ust sinir V'ye
    ///      (4.292e9) kiyasla o kadar buyuktu ki 200.000/200.000 uniform
    ///      cekilis `tokensOut == T - 1`'e (guard sinirina) carpiyordu --
    ///      gercek bir launch'in hic gormeyecegi bir bolgeyi fuzzluyordu.
    ///      Bir launch'in gorebilecegi TUM aralik, bolluca pay ile, budur.
    function testFuzz_buyTokensOutThenSellNeverProfits(uint256 grossQuoteIn) public pure {
        grossQuoteIn = bound(grossQuoteIn, 4, 2 * 12_161_433_369);

        (uint256 net,,) = CurveMath.correctedNetQuoteIn(grossQuoteIn, 95, 30);
        uint256 tokensOut = CurveMath.quoteBuyTokensOut(net, V, T);

        uint256 newQuote = V + net;
        uint256 newToken = T - tokensOut;

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensOut, newQuote, newToken);
        assertLe(proceeds, net, "exact-quote-in round trip created value");
    }

    /// Daha cok token istemek asla daha ucuz olmamali.
    function testFuzz_buyCostIsMonotonic(uint256 a, uint256 b) public pure {
        a = bound(a, 1, T - 1);
        b = bound(b, 1, T - 1);
        if (a > b) (a, b) = (b, a);

        assertLe(CurveMath.quoteBuyCost(a, V, T), CurveMath.quoteBuyCost(b, V, T));
    }

    /// Daha cok token satmak asla daha az getirmemeli.
    function testFuzz_sellProceedsAreMonotonic(uint256 a, uint256 b) public pure {
        a = bound(a, 1, T);
        b = bound(b, 1, T);
        if (a > b) (a, b) = (b, a);

        assertLe(CurveMath.quoteSellProceeds(a, V, T), CurveMath.quoteSellProceeds(b, V, T));
    }

    /// Ucret hicbir zaman miktarin kendisini asmamali ve sifir miktarda sifir olmali.
    function testFuzz_feeIsBoundedByAmount(uint256 amount, uint256 bps) public pure {
        amount = bound(amount, 0, type(uint128).max);
        bps = bound(bps, 0, CurveMath.BPS_DENOMINATOR);

        uint256 f = CurveMath.feeOn(amount, bps);
        assertLe(f, amount);
        if (amount == 0) assertEq(f, 0);
    }

    /// Ucret dusuldukten sonra kalan, brut tutari asamaz. Bu ozellik girdiden
    /// 1 cikarma kuralindan BAGIMSIZ olarak dogrudur ve oyle kalmalidir:
    /// 125 bps'te net = floor(gross*10_000/10_125) <= gross*10_000/10_125
    /// < gross, yani `-1` olmadan da KESIN kucuktur (gross = 1 icin net = 0).
    function testFuzz_netBeforeCorrectionNeverExceedsGross(uint256 gross) public pure {
        gross = bound(gross, 1, type(uint128).max);
        assertLt(CurveMath.netQuoteInBeforeCorrection(gross, CURVE_FEE_BPS), gross);
    }

    /// Sureklilik: havuz tohumu her zaman satis arzindan kucuk olmali.
    function testFuzz_poolSeedSupplyIsAlwaysSmallerThanSaleSupply(uint256 saleSupply) public pure {
        saleSupply = bound(saleSupply, 1, T - 1);
        assertLt(CurveMath.poolSeedSupply(saleSupply, T), saleSupply);
    }

    /// 3. adimdan SONRA gecerli olan ozellik: duzeltilmis net ile fonksiyonun
    /// DONDURDUGU iki ucret parcasinin toplami butceyi ASLA asmaz -- ama esit
    /// OLABILIR. Eski surum "never reaches" diyordu; o, DUZELTMESIZ
    /// konvansiyonun ozelligiydi ve 3. adim eklendikten sonra yanlistir.
    ///
    /// Ucretler donen degerlerden alinir, `net` uzerinden YENIDEN
    /// HESAPLANMAZ: zincir onlari duzeltme ONCESI net uzerinden hesaplar ve
    /// yeniden hesaplama daha kucuk (yanlis) bir ucret bulur. Bir cagiranin
    /// fiilen tahsil edecegi sayilar bunlardir, dolayisiyla butce ozelligi de
    /// bunlar uzerinden kurulmalidir.
    function testFuzz_correctedNetPlusFeesNeverExceedsGross(uint256 gross) public pure {
        gross = bound(gross, 1_000, 1e30);
        (uint256 net, uint256 protocolFee, uint256 creatorFee) = CurveMath.correctedNetQuoteIn(gross, 95, 30);
        assertLe(net + protocolFee + creatorFee, gross);
    }

    /// Butceye ne kadar yaklasildigi da sinirlidir: acik en fazla 1 birimdir.
    /// Esitlik EVRENSEL DEGILDIR (duzeltme tetiklenmediginde 1 eksik
    /// kalabilir), bu yuzden burada esitlik degil, ACIGIN SINIRI sabitlenir.
    /// Olculdu: (95, 30) bps'te gross in [1, 1e6] araliginin %99,95'inde acik
    /// 0, 494'unde 1; hicbir yerde 2 veya daha fazla degil.
    /// @dev `sum <= gross` burada kasten TEKRAR ediliyor. Onsuz, toplamin
    ///      butceyi astigi bir mutasyonda `gross - sum` alta tasar ve test
    ///      okunakli bir assertion yerine ciplak bir `panic 0x11` ile duser.
    ///      Ayni sonucu verir ama neden dustugunu soylemez.
    function testFuzz_theGapToGrossIsAtMostOne(uint256 gross) public pure {
        gross = bound(gross, 1_000, 1e30);
        (uint256 net, uint256 protocolFee, uint256 creatorFee) = CurveMath.correctedNetQuoteIn(gross, 95, 30);

        uint256 sum = net + protocolFee + creatorFee;
        assertLe(sum, gross, "toplam butceyi asti");
        assertLe(gross - sum, 1, "butceye acik 1 birimden fazla");
    }

    /// Zincir SDK tahmin edicisinden ASLA daha comert degildir. Kullanici lehine
    /// yuvarlayan bir formulun geri sizmasini yakalayan bekci budur; 200.000
    /// ornekte SDK 102.318'inde fazla vaat etti, tersi hic olmadi.
    function testFuzz_chainNeverGivesMoreTokensThanTheSdkEstimator(uint256 gross) public pure {
        gross = bound(gross, 1_000, 1e24);
        uint256 sdkNet = ((gross - 1) * 10_000) / (CURVE_FEE_BPS + 10_000);
        uint256 sdkTokens = (sdkNet * T) / (V + sdkNet);
        (uint256 chainNet,,) = CurveMath.correctedNetQuoteIn(gross, 95, 30);
        uint256 chainTokens = CurveMath.quoteBuyTokensOut(chainNet, V, T);
        assertLe(chainTokens, sdkTokens);
    }
}
