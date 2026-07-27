// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveHandler} from "./CurveHandler.sol";

/// @dev V, T, S burada ve CurveHandler'in constructor argumanlarinda AYNI
///      olmak zorundadir (constructor sirasi initialQuote, initialToken,
///      saleSupply) -- aksi halde muhasebe kimlikleri bariz bir nedenle
///      kirilir.
///
///      NOT: brief'in ilk taslaginda `quoteReserve == V + totalQuoteIn -
///      totalGrossQuoteOut` ve `totalGrossQuoteOut - totalNetQuoteOut ==
///      totalSellFees` seklinde iki invariant vardi. Ikisi de handler
///      kodunda AYNI degerin (cost / proceeds) iki degiskene birden
///      yazilmasindan ibaretti -- yani cebirsel olarak `x == x`'e
///      indirgeniyordu ve CurveMath ne dondururse dondursun (hatta tamamen
///      bozuk olsa bile) gecerdi. Burada onlarin yerine gercekten
///      kirilabilecek iki sey konuldu: sabit carpimin asla kucalmadigi
///      (dogrudan CurveMath'in yuvarlama yonune bagli) ve ucretin akistan
///      asla fazla olamayacagi (feeOn'un kendi garantisine bagli).
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
    function invariant_quoteReserveNeverFallsBelowVirtualFloor() public view {
        assertGe(handler.quoteReserve(), V);
    }

    /// Token rezervi hicbir zaman baslangic degerini asamaz.
    function invariant_tokenReserveNeverExceedsInitial() public view {
        assertLe(handler.tokenReserve(), T);
    }

    /// Satilabilir arz asla baslangic satis arzini asamaz.
    function invariant_saleSupplyNeverExceedsInitial() public view {
        assertLe(handler.saleSupplyRemaining(), S);
    }

    /// Sabit carpim (quoteReserve * tokenReserve) HERHANGI bir alim/satim
    /// dizisinde asla kucalmez. Bu tesadufi degil: quoteBuyCost alicinin
    /// odedigini yukari, quoteSellProceeds saticinin aldigini asagi
    /// yuvarlar ve HER IKI yuvarlama da ayri ayri urunu yukari iter (bkz.
    /// kanit: k_sonra = (V+cost)(T-tokensOut) >= V*T cunku cost >=
    /// tokensOut*V/(T-tokensOut); satista simetrik). Yuvarlama yonlerinden
    /// biri ters cevrilseydi bu invariant, tek bir al-sat turundan cok daha
    /// once -- rastgele, cok adimli bir dizide -- kirilirdi.
    function invariant_constantProductNeverDecreases() public view {
        assertGe(
            handler.quoteReserve() * handler.tokenReserve(),
            handler.initialQuoteReserve() * handler.initialTokenReserve()
        );
    }

    /// Satis ucreti, curve'den cikan brut miktardan asla fazla olamaz --
    /// feeOn'un kendi `f <= amount` garantisinin bir dizi boyunca
    /// toplamda da gecerli kalmasi.
    function invariant_sellFeeNeverExceedsGrossProceeds() public view {
        assertLe(handler.totalSellFees(), handler.totalGrossQuoteOut());
    }

    /// Alim ucreti, curve'e giren miktardan asla fazla olamaz -- ayni
    /// garantinin alim tarafi.
    function invariant_buyFeeNeverExceedsQuoteIn() public view {
        assertLe(handler.totalBuyFees(), handler.totalQuoteIn());
    }
}
