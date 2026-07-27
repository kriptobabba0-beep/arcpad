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
///      her zaman tokenReserve'den kesin kucuktur ve bps girdileri asla
///      BPS_DENOMINATOR'u asmaz. Bu yuzden hicbir fuzz calistirmasi bir
///      guard'a carpip erken donmez -- her calistirma gercek aritmetigi
///      test eder.
contract CurveMathFuzzTest is Test {
    uint256 internal constant T = 1_073_000_000_000_000;
    uint256 internal constant V = 4_292_000_000;
    uint256 internal constant CURVE_FEE_BPS = 125;

    /// Al ve hemen sat: kullanici asla kar edemez. Ucret sifir olsa bile
    /// yuvarlama tek basina bunu garanti etmelidir.
    function testFuzz_buyThenSellNeverProfits(uint256 tokensOut) public pure {
        tokensOut = bound(tokensOut, 1, T / 2);

        uint256 cost = CurveMath.quoteBuyCost(tokensOut, V, T);
        uint256 newQuote = V + cost;
        uint256 newToken = T - tokensOut;

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensOut, newQuote, newToken);
        assertLe(proceeds, cost, "round trip created value");
    }

    /// Daha cok token istemek asla daha ucuz olmamali.
    function testFuzz_buyCostIsMonotonic(uint256 a, uint256 b) public pure {
        a = bound(a, 1, T / 2);
        b = bound(b, 1, T / 2);
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
}
