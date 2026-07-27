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

    /// Tam quote girisiyle alim (netQuoteIn -> quoteBuyTokensOut), sonra hemen
    /// satis: ayni garanti, exact-tokens-out'un simetrigi olan exact-quote-in
    /// yolu icin. Gercek bir launch'ta kullanicinin fiilen kullandigi yol
    /// budur -- ne kadar harcamak istedigini soyler, karsiliginda token alir.
    /// @dev t = floor(nT/(V+n)) <= nT/(V+n) (gercel) oldugundan
    ///      t(V+n) <= nT, yani floor(t(V+n)/T) <= n her zaman dogrudur.
    /// @dev gross=1 veya 2 icin netQuoteIn asagi yuvarlamadan sifir doner
    ///      (ZeroAmount ile reddedilir); 125 bps'te net'in kesin >0 olmasi
    ///      icin gross>=3 gerekir: (gross-1)*10000/10125 >= 1 <=> gross >= 3.
    /// @dev Ust sinir `2 * 12_161_433_369` (USDC graduation raise'inin tam
    ///      tutarinin iki kati): [3, type(uint128).max] ile ust sinir V'ye
    ///      (4.292e9) kiyasla o kadar buyuktu ki 200.000/200.000 uniform
    ///      cekilis `tokensOut == T - 1`'e (guard sinirina) carpiyordu --
    ///      gercek bir launch'in hic gormeyecegi bir bolgeyi fuzzluyordu.
    ///      Bir launch'in gorebilecegi TUM aralik, bolluca pay ile, budur.
    function testFuzz_buyTokensOutThenSellNeverProfits(uint256 grossQuoteIn) public pure {
        grossQuoteIn = bound(grossQuoteIn, 3, 2 * 12_161_433_369);

        uint256 net = CurveMath.netQuoteIn(grossQuoteIn, CURVE_FEE_BPS);
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

    /// Ucret dusuldukten sonra kalan, brut tutari asamaz.
    function testFuzz_netQuoteInNeverExceedsGross(uint256 gross) public pure {
        gross = bound(gross, 1, type(uint128).max);
        assertLt(CurveMath.netQuoteIn(gross, CURVE_FEE_BPS), gross);
    }

    /// Sureklilik: havuz tohumu her zaman satis arzindan kucuk olmali.
    function testFuzz_poolSeedSupplyIsAlwaysSmallerThanSaleSupply(uint256 saleSupply) public pure {
        saleSupply = bound(saleSupply, 1, T - 1);
        assertLt(CurveMath.poolSeedSupply(saleSupply, T), saleSupply);
    }

    /// netQuoteIn'in INCLUSIVE ayrisimi ile feeOn'un EXCLUSIVE sozlesmesi
    /// arasindaki koprü: `net`'in EXCLUSIVE ucretini geri eklesen bile
    /// `gross`'a asla ULASAMAZSIN (kesin kucuk kalir). Bu, Faz 1b'deki
    /// stateful bir cagiranin `net` uzerinden EXCLUSIVE bir ucret
    /// hesaplayip fark kadar iade yaparken alta tasmadan (underflow)
    /// calisabilmesi icin gereken garantidir -- INCLUSIVE/EXCLUSIVE
    /// koprusunu bir yoruma degil, calistirilabilir bir ozellige baglar.
    function testFuzz_netQuoteInPlusFeeOnOfNetNeverReachesGross(uint256 gross, uint256 bps) public pure {
        gross = bound(gross, 1, type(uint128).max);
        bps = bound(bps, 0, CurveMath.BPS_DENOMINATOR);

        uint256 net = CurveMath.netQuoteIn(gross, bps);
        assertLt(net + CurveMath.feeOn(net, bps), gross);
    }
}
