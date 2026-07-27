// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdUtils} from "forge-std/StdUtils.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";

/// @dev Fuzz'un surdugu durum makinesi. Gercek bir curve kontratinin yerine
///      gecer: rezervleri tutar, alim/satim uygular ve akislari izler. Amac,
///      uzun rastgele islem dizilerinden sonra bile muhasebenin tutup
///      tutmadigini gormek.
/// @dev StdUtils'ten miras alir, cunku forge-std'nin `_bound`'u kenar
///      degerlerde bizim yazacagimiz modulo'dan daha az yanli dagitir.
/// @dev FEE_BPS sabit ve BPS_DENOMINATOR'un altinda oldugundan `feeOn`'un
///      InvalidBps guard'i hicbir zaman tetiklenmez. quoteReserve ve
///      tokenReserve de hicbir zaman sifira inemez (asagidaki fonksiyon
///      yorumlarina bakin) -- bu yuzden `ZeroReserve` guard'i icin de ekstra
///      bound gerekmez.
contract CurveHandler is StdUtils {
    uint256 public immutable initialQuoteReserve;
    uint256 public immutable initialTokenReserve;
    uint256 public immutable initialSaleSupply;

    uint256 public quoteReserve;
    uint256 public tokenReserve;
    uint256 public saleSupplyRemaining;

    /// Curve'e giren brut quote (ucret haric -- ucret rezervlere hic girmez).
    uint256 public totalQuoteIn;
    /// Curve'den cikan brut quote (ucret dusulmeden once).
    uint256 public totalGrossQuoteOut;
    /// Kullanicilara fiilen odenen (ucret dusulmus) quote.
    uint256 public totalNetQuoteOut;
    /// Ucretler taraf bazinda ayri tutulur; toplam tek basina hicbir
    /// invariant'i dogrulanabilir kilmaz.
    uint256 public totalBuyFees;
    uint256 public totalSellFees;

    uint256 internal constant FEE_BPS = 125;

    constructor(uint256 initialQuote, uint256 initialToken, uint256 saleSupply) {
        initialQuoteReserve = initialQuote;
        initialTokenReserve = initialToken;
        initialSaleSupply = saleSupply;

        quoteReserve = initialQuote;
        tokenReserve = initialToken;
        saleSupplyRemaining = saleSupply;
    }

    /// @dev tokensOut, saleSupplyRemaining'e siniirlanir ve saleSupplyRemaining
    ///      = tokenReserve - (initialTokenReserve - initialSaleSupply) esitligi
    ///      her iki fonksiyonda da ayni miktarla korundugundan, tokensOut her
    ///      zaman tokenReserve'den KESIN kucuktur -- `tokensOut >= tokenReserve`
    ///      dali savunma amaclidir, gercek kurulumda hic tetiklenmez.
    function buyExactTokens(uint256 tokensOut) external {
        if (saleSupplyRemaining == 0) return;
        tokensOut = _bound(tokensOut, 1, saleSupplyRemaining);
        if (tokensOut >= tokenReserve) return;

        uint256 cost = CurveMath.quoteBuyCost(tokensOut, quoteReserve, tokenReserve);
        uint256 fee = CurveMath.feeOn(cost, FEE_BPS);

        quoteReserve += cost;
        tokenReserve -= tokensOut;
        saleSupplyRemaining -= tokensOut;

        totalQuoteIn += cost;
        totalBuyFees += fee;
    }

    function sellExactTokens(uint256 tokensIn) external {
        uint256 sold = soldSoFar();
        if (sold == 0) return;
        tokensIn = _bound(tokensIn, 1, sold);

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensIn, quoteReserve, tokenReserve);
        // Curve, sanal taban rezervinin altina inecek bir satisi kabul edemez.
        if (proceeds == 0 || quoteReserve - proceeds < initialQuoteReserve) return;
        uint256 fee = CurveMath.feeOn(proceeds, FEE_BPS);

        quoteReserve -= proceeds;
        tokenReserve += tokensIn;
        saleSupplyRemaining += tokensIn;

        totalGrossQuoteOut += proceeds;
        totalNetQuoteOut += proceeds - fee;
        totalSellFees += fee;
    }

    /// @notice Su ana kadar curve'den cikmis net token miktari.
    function soldSoFar() public view returns (uint256) {
        return initialTokenReserve - tokenReserve;
    }
}
