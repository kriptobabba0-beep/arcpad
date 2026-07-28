// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

/// Native kabul etmeyen alici. Iade yolunun SESSIZCE yutmadigini, revert
/// ettigini kanitlar (Arc'ta sozlesmelere native gonderim garanti degildir).
contract RejectingBuyer {
    BondingCurve public immutable curve;

    constructor(BondingCurve curve_) {
        curve = curve_;
    }

    function buy(uint256 tokensOut, uint256 maxQuoteIn, uint256 value) external {
        curve.buyExactTokensOut{value: value}(tokensOut, maxQuoteIn);
    }

    receive() external payable {
        revert("no");
    }
}

/// CEI saldirgani. Iade `msg.sender.call` ile geldigi anda -- yani curve'un
/// SON dis cagrisinda -- ayni curve'e ikinci bir alim yapar.
///
/// Bu kurgunun saldiriyi GERCEKTEN mumkun kildigi mutasyonla dogrulandi:
/// defter yazimini dis cagrilarin ARKASINA almak (yani pump.fun'in Solana
/// sirasi) ikinci alimin BAYAT rezervleri gormesine ve birinciyle AYNI
/// fiyattan doldurulmasina yol aciyor. Faz 1b'nin dersi burada uygulandi:
/// once mutasyonun testi kirmizi yaptigi olculdu, sonra geri alindi.
contract ReentrantBuyer {
    BondingCurve public immutable curve;
    uint256 public immutable amount;
    uint256 public immutable secondValue;

    bool public armed;
    bool public reentered;

    constructor(BondingCurve curve_, uint256 amount_, uint256 secondValue_) {
        curve = curve_;
        amount = amount_;
        secondValue = secondValue_;
    }

    function attack(uint256 firstValue) external {
        armed = true;
        curve.buyExactTokensOut{value: firstValue}(amount, type(uint256).max);
        armed = false;
    }

    receive() external payable {
        if (armed && !reentered) {
            reentered = true;
            curve.buyExactTokensOut{value: secondValue}(amount, type(uint256).max);
        }
    }
}

/// CEI saldirgani, SATIS tarafi. Satis geliri `msg.sender.call` ile odendigi
/// icin satis yolunun da bir reentrancy penceresi vardir; ilk mutasyon turunda
/// bu pencereyi kimse test etmiyordu ve satis tarafi CEI'yi ters ceviren
/// mutant 33/33 ile HAYATTA KALDI. Bu yardimci onu oldurmek icin eklendi.
contract ReentrantSeller {
    BondingCurve public immutable curve;
    LaunchToken public immutable token;
    uint256 public immutable amount;

    bool public armed;
    bool public reentered;

    constructor(BondingCurve curve_, LaunchToken token_, uint256 amount_) {
        curve = curve_;
        token = token_;
        amount = amount_;
    }

    /// Kendi bakiyesinin TAMAMINI harcar; iade olusmaz, dolayisiyla `receive`
    /// bu asamada hic calismaz ve saldiri yalnizca satis penceresinde olur.
    function acquire(uint256 tokensOut) external {
        curve.buyExactTokensOut{value: address(this).balance}(tokensOut, type(uint256).max);
        token.approve(address(curve), type(uint256).max);
    }

    function attack() external {
        armed = true;
        curve.sellExactTokensIn(amount, 0);
        armed = false;
    }

    receive() external payable {
        if (armed && !reentered) {
            reentered = true;
            curve.sellExactTokensIn(amount, 0);
        }
    }
}

/// @dev Sabitlenmis her beklenen deger ZINCIR ALGORITMASINDAN ELLE
///      turetilmistir; hicbiri `CurveMath` cagrilarak uretilmemistir. Testin
///      kutuphaneyi kendisiyle karsilastirmasi bu projenin defalarca
///      yakaladigi totoloji sinifidir.
contract BondingCurveTest is Test {
    // Curve profili (spec 5.3, 18 decimal native gorunum).
    uint256 internal constant T = 1_073_000_000e18; // sanal token rezervi
    uint256 internal constant V = 4_292e18; // sanal quote rezervi
    uint256 internal constant S = 793_100_000e18; // satis arzi = ilk realTokenReserves
    uint256 internal constant N = 1_000_000_000e18; // LaunchToken.TOTAL_SUPPLY

    address internal constant CREATOR = address(0xC7EA);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant BUYER = address(0xB0B);
    address internal constant ALICE = address(0xA11CE);

    FeeEscrow internal escrow;
    BondingCurve internal curve;
    LaunchToken internal token;

    function setUp() public {
        escrow = new FeeEscrow();
        (curve, token) = _launch(CREATOR, escrow);
        vm.deal(BUYER, 1_000_000e18);
        vm.deal(ALICE, 1_000_000e18);
    }

    /// Task 3'un factory'sinin yapacagi seyin aynisi: once curve, sonra token,
    /// sonra bind. Bu dosyada factory rolunu test kontratinin kendisi oynar.
    function _launch(address creator_, FeeEscrow escrow_) internal returns (BondingCurve c, LaunchToken t) {
        c = new BondingCurve(creator_, address(escrow_), TREASURY);
        t = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(c));
        c.bind(address(t));
    }

    // ---------------------------------------------------------------
    // Kurulum
    // ---------------------------------------------------------------

    /// Ilk rezervler pump.fun'in canli Global hesabindaki degerlerin 1e12
    /// katidir (6 decimal Solana olcegi -> 18 decimal native gorunum).
    function test_initialReservesMatchThePumpFunProfileScaledTo18Decimals() public view {
        assertEq(curve.virtualTokenReserves(), T);
        assertEq(curve.INITIAL_VIRTUAL_TOKEN_RESERVES(), T);
        assertEq(curve.INITIAL_VIRTUAL_QUOTE_RESERVES(), V);
        assertEq(curve.INITIAL_REAL_TOKEN_RESERVES(), S);
        assertEq(curve.PROTOCOL_FEE_BPS(), 95);
        assertEq(curve.CREATOR_FEE_BPS(), 30);
        assertEq(curve.virtualQuoteReserves(), V);
        assertEq(curve.realTokenReserves(), S);
        assertEq(curve.realQuoteReserves(), 0);
        assertFalse(curve.complete());
        assertEq(curve.token(), address(token));
        assertEq(curve.creator(), CREATOR);
        assertEq(curve.escrow(), address(escrow));
        assertEq(curve.protocolTreasury(), TREASURY);
        assertEq(curve.factory(), address(this));
    }

    /// Curve TUM arzi custody eder ama yalnizca S'ini satar. Aradaki N - S
    /// graduation'da havuza gider.
    function test_curveCustodiesTheWholeSupplyButOnlySellsTheSaleSupply() public view {
        assertEq(token.balanceOf(address(curve)), N);
        assertEq(token.totalSupply(), N);
        assertGt(N, curve.realTokenReserves());
    }

    /// D = S(T-S)/T. Elle turetilmis:
    ///   S = 793_100_000e18, T - S = 279_900_000e18, T = 1_073_000_000e18
    ///   D = 793_100_000e18 * 279_900_000e18 / 1_073_000_000e18
    ///     = 206_886_011_183_597_390_493_942_218
    /// Faz 1a'nin 6 decimal degeri 206_886_011_183_597 idi; 1e12 kati.
    function test_poolSeedSupplyIsTheContinuityValueNotTheRoundedReserve() public view {
        assertEq(curve.poolSeedSupply(), 206_886_011_183_597_390_493_942_218);
        // pump.fun'in yuvarlak rezerve rakami (N - S) BUNDAN BUYUKTUR; aradaki
        // fark kalici olarak kilitlenir.
        assertGt(N - S, curve.poolSeedSupply());
    }

    // ---------------------------------------------------------------
    // bind
    // ---------------------------------------------------------------

    function test_bindRevertsWhenCalledByAnyoneButTheFactory() public {
        BondingCurve fresh = new BondingCurve(CREATOR, address(escrow), TREASURY);
        LaunchToken t = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(fresh));

        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.NotFactory.selector);
        fresh.bind(address(t));

        // Factory yapinca gecer.
        fresh.bind(address(t));
        assertEq(fresh.token(), address(t));
    }

    function test_bindRevertsOnTheSecondCall() public {
        LaunchToken other = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(curve));
        vm.expectRevert(BondingCurve.AlreadyBound.selector);
        curve.bind(address(other));
        assertEq(curve.token(), address(token));
    }

    function test_bindRevertsOnZeroToken() public {
        BondingCurve fresh = new BondingCurve(CREATOR, address(escrow), TREASURY);
        vm.expectRevert(BondingCurve.ZeroToken.selector);
        fresh.bind(address(0));
    }

    /// Bagi tek yonlu kurmak yetmez: token'in da curve'u isaret etmesi gerekir.
    /// Aksi halde curve, arzi baska bir curve'de duran bir token'a baglanir ve
    /// hicbir transferi karsilayamaz.
    function test_bindRevertsWhenTheTokenDoesNotPointBack() public {
        BondingCurve fresh = new BondingCurve(CREATOR, address(escrow), TREASURY);
        LaunchToken elsewhere = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(curve));

        vm.expectRevert(BondingCurve.TokenDoesNotPointBack.selector);
        fresh.bind(address(elsewhere));
    }

    /// bind edilmemis bir curve'de TICARET PENCERESI YOKTUR. Ucunu de kapat.
    function test_everyTradingEntrypointRevertsBeforeBind() public {
        BondingCurve unbound = new BondingCurve(CREATOR, address(escrow), TREASURY);
        vm.deal(BUYER, 100e18);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.NotBound.selector);
        unbound.buyExactTokensOut{value: 10e18}(1e18, type(uint256).max);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.NotBound.selector);
        unbound.buyExactQuoteIn{value: 10e18}(0);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.NotBound.selector);
        unbound.sellExactTokensIn(1e18, 0);
    }

    function test_constructorRejectsZeroEscrowAndZeroTreasury() public {
        vm.expectRevert(BondingCurve.ZeroEscrow.selector);
        new BondingCurve(CREATOR, address(0), TREASURY);

        vm.expectRevert(BondingCurve.ZeroTreasury.selector);
        new BondingCurve(CREATOR, address(escrow), address(0));
    }

    // ---------------------------------------------------------------
    // Alim -- tam token cikisi
    // ---------------------------------------------------------------

    /// Elle turetilmis (taze curve, tokensOut = 1_000_000e18):
    ///   cost = floor(1e24 * 4_292e18 / (1_073_000_000e18 - 1e24)) + 1
    ///        = 4_003_731_343_283_582_090
    ///   protocolFee = ceil(cost * 95 / 10_000) =    38_035_447_761_194_030
    ///   creatorFee  = ceil(cost * 30 / 10_000) =    12_011_194_029_850_747
    ///   toplam                                 = 4_053_777_985_074_626_867
    function test_buyExactTokensOutChargesCurveCostPlusBothFeeParts() public {
        uint256 tokensOut = 1_000_000e18;
        uint256 cost = 4_003_731_343_283_582_090;
        uint256 protocolFee = 38_035_447_761_194_030;
        uint256 creatorFee = 12_011_194_029_850_747;
        uint256 total = cost + protocolFee + creatorFee;
        assertEq(total, 4_053_777_985_074_626_867);

        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: total}(tokensOut, total);

        assertEq(before - BUYER.balance, total, "buyer paid something other than cost + both fee parts");
        assertEq(token.balanceOf(BUYER), tokensOut);

        // Ucret escrow'a IKI AYRI yatirim olarak gider.
        assertEq(escrow.owed(TREASURY), protocolFee);
        assertEq(escrow.owed(CREATOR), creatorFee);
        assertEq(escrow.totalOwed(), protocolFee + creatorFee);

        // Rezervler ucret ONCESI curve tutariyla hareket eder.
        assertEq(curve.virtualQuoteReserves(), V + cost);
        assertEq(curve.virtualTokenReserves(), T - tokensOut);
        assertEq(curve.realTokenReserves(), S - tokensOut);
        assertEq(curve.realQuoteReserves(), cost);
        assertEq(address(curve).balance, cost);
    }

    function test_buyExactTokensOutRevertsWhenTokensExceedRealReserves() public {
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.NotEnoughTokensToBuy.selector);
        curve.buyExactTokensOut{value: 1_000_000e18}(S + 1, type(uint256).max);

        // Tam rezerv GECER -- sinir `>` olmalidir, `>=` degil.
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        assertEq(curve.realTokenReserves(), 0);
    }

    /// Sifir miktar AYRI bir hatadir ve rezerv kontrolunden ONCE gelir.
    /// DIKKAT -- bu testin kanitladigi sey sinirlidir: `CurveMath.ZeroAmount()`
    /// ile `BondingCurve.ZeroAmount()` AYNI selector'u tasir, bu yuzden
    /// koruma tamamen kaldirilsa bile revert verisi degismez. Testin fiilen
    /// sabitledigi sey, sifirin `NotEnoughTokensToBuy` ile KARISMAMASIDIR.
    /// Ayrintili gerekce icin task-2-report.md'deki mutasyon matrisine bakin.
    function test_buyExactTokensOutRevertsOnZeroAmountBeforeCheckingReserves() public {
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buyExactTokensOut{value: 1e18}(0, type(uint256).max);
    }

    /// Slippage UCRET-DAHIL kontrol edilir: `maxQuoteIn` toplam odemeye karsi
    /// tutulur, curve maliyetine karsi degil. Tersine kurmak sessiz bir
    /// kullanici-zarari hatasidir.
    function test_buyExactTokensOutRevertsWhenCostExceedsMaxQuoteIn() public {
        uint256 total = 4_053_777_985_074_626_867;

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.buyExactTokensOut{value: total}(1_000_000e18, total - 1);

        // Curve maliyeti tek basina maxQuoteIn'in ALTINDA olsa bile ucretle
        // birlikte asiyorsa reddedilir.
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.buyExactTokensOut{value: total}(1_000_000e18, 4_003_731_343_283_582_090);

        // msg.value yetmiyorsa da ayni hata.
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.buyExactTokensOut{value: total - 1}(1_000_000e18, type(uint256).max);

        // Tam yeterli miktarla GECER.
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: total}(1_000_000e18, total);
    }

    function test_buyRefundsTheUnusedRemainderOfMsgValue() public {
        uint256 total = 4_053_777_985_074_626_867;
        uint256 sent = total + 7e18;

        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: sent}(1_000_000e18, type(uint256).max);

        assertEq(before - BUYER.balance, total, "the unused remainder was not refunded");
        assertEq(address(curve).balance, curve.realQuoteReserves());
    }

    /// Iade duz `call` ile yapilir ve BASARISIZLIGINDA REVERT EDER. Sessizce
    /// yutmak kullanicinin parasini yakardi. Bu, FeeEscrow'un pull-based
    /// olmasinin TERSI bir tercihtir ve bilinclidir.
    function test_buyRevertsWhenTheRefundCannotBeDelivered() public {
        RejectingBuyer bad = new RejectingBuyer(curve);
        vm.deal(address(bad), 100e18);

        vm.expectRevert(BondingCurve.RefundFailed.selector);
        bad.buy(1_000_000e18, type(uint256).max, 10e18);

        // Iade edilecek bir sey yoksa ayni alici basariyla alabilir.
        bad.buy(1_000_000e18, type(uint256).max, 4_053_777_985_074_626_867);
        assertEq(token.balanceOf(address(bad)), 1_000_000e18);
    }

    // ---------------------------------------------------------------
    // Alim -- tam quote girisi
    // ---------------------------------------------------------------

    /// Elle turetilmis (taze curve, gross = 1e18):
    ///   duzeltmesiz net = 1e18 * 10_000 / 10_125 = 987_654_320_987_654_320
    ///   protocolFee     = ceil(net * 95 / 1e4)   =   9_382_716_049_382_717
    ///   creatorFee      = ceil(net * 30 / 1e4)   =   2_962_962_962_962_963
    ///   toplam = 1e18 = gross -> duzeltme yok, iade yok
    ///   tokens = floor((net - 1) * T / (V + net - 1))
    ///          = 246_856_774_757_571_922_708_542
    /// SDK tahmin edicisi ayni girdide 246_856_774_757_571_922_958_427
    /// vaat ederdi -- zincirden 249_885 birim FAZLA.
    function test_buyExactQuoteInUsesTheChainAlgorithmNotTheSdkEstimator() public {
        uint256 net = 987_654_320_987_654_320;
        uint256 chainTokens = 246_856_774_757_571_922_708_542;
        uint256 sdkTokens = 246_856_774_757_571_922_958_427;

        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 1e18}(0);

        assertEq(token.balanceOf(BUYER), chainTokens);
        assertLt(token.balanceOf(BUYER), sdkTokens);
        assertEq(sdkTokens - chainTokens, 249_885);

        assertEq(curve.realQuoteReserves(), net);
        assertEq(curve.virtualQuoteReserves(), V + net);
        assertEq(curve.virtualTokenReserves(), T - chainTokens);
        assertEq(curve.realTokenReserves(), S - chainTokens);
        assertEq(escrow.owed(TREASURY), 9_382_716_049_382_717);
        assertEq(escrow.owed(CREATOR), 2_962_962_962_962_963);
    }

    /// Rezervi asan bir butce REVERT ETMEZ, rezerve KISAR ve artigi iade eder.
    /// Kisilan islem tam olarak `buyExactTokensOut(realTokenReserves)` ile
    /// ayni yere duser -- toz birakmadan.
    ///
    /// Elle turetilmis (gross = 100_000e18):
    ///   kisilmamis tokens = 1_028_313_111_279_674_811_551_798_181 > S
    ///   kisildiktan sonra: cost = floor(S * V / (T - S)) + 1
    ///                           = 12_161_433_369_060_378_706_681
    ///   protocolFee = ceil(cost * 95 / 1e4) =   115_533_617_006_073_597_714
    ///   creatorFee  = ceil(cost * 30 / 1e4) =    36_484_300_107_181_136_121
    ///   harcanan                            = 12_313_451_286_173_633_440_516
    ///   iade        = 100_000e18 - harcanan = 87_686_548_713_826_366_559_484
    function test_buyExactQuoteInClampsToRealReservesInsteadOfReverting() public {
        uint256 cost = 12_161_433_369_060_378_706_681;
        uint256 protocolFee = 115_533_617_006_073_597_714;
        uint256 creatorFee = 36_484_300_107_181_136_121;
        uint256 spent = cost + protocolFee + creatorFee;
        assertEq(spent, 12_313_451_286_173_633_440_516);

        vm.deal(BUYER, 100_000e18);
        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 100_000e18}(0);

        assertEq(token.balanceOf(BUYER), S, "the fill did not clamp to the sale supply");
        assertEq(before - BUYER.balance, spent, "the clamped remainder was not refunded");
        assertEq(curve.realTokenReserves(), 0);
        assertEq(curve.virtualTokenReserves(), T - S);
        assertEq(curve.realQuoteReserves(), cost);
        assertTrue(curve.complete());
        assertEq(escrow.owed(TREASURY), protocolFee);
        assertEq(escrow.owed(CREATOR), creatorFee);
    }

    function test_buyExactQuoteInRevertsWhenTokensBelowMinTokensOut() public {
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.buyExactQuoteIn{value: 1e18}(246_856_774_757_571_922_708_543);

        // Tam beklenen miktar GECER.
        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 1e18}(246_856_774_757_571_922_708_542);
    }

    /// Butce garantisi `<=`dir, `==` DEGIL. Duzeltme tetiklenmediginde
    /// net + iki ucret parcasi brut tutarin 1 ALTINDA kalabilir ve o 1 birim
    /// kullanicinindir. `== gross` diye kurulan bir koruma bu islemi revert
    /// ettirirdi.
    ///
    /// Elle turetilmis (gross = 2026 wei):
    ///   net = 2026 * 10_000 / 10_125 = 2000  (10_125 * 2000 = 20_250_000)
    ///   protocolFee = ceil(2000 * 95 / 1e4) = 19
    ///   creatorFee  = ceil(2000 * 30 / 1e4) =  6
    ///   2000 + 19 + 6 = 2025 <= 2026 -> duzeltme YOK, artik 1 wei
    function test_buyExactQuoteInRefundsTheUnitTheBudgetGuaranteeLeavesOver() public {
        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 2026}(0);

        assertEq(before - BUYER.balance, 2025, "the one unit of slack was not returned");
        assertEq(curve.realQuoteReserves(), 2000);
        assertEq(escrow.owed(TREASURY), 19);
        assertEq(escrow.owed(CREATOR), 6);
        assertEq(token.balanceOf(BUYER), 499_749_999);
    }

    /// Ucret parcalari `correctedNetQuoteIn`'den GELDIGI GIBI kullanilir.
    /// Zincir ucreti DUZELTME ONCESI net uzerinden alir; donen (duzeltilmis)
    /// net uzerinden yeniden hesaplayan bir govde 1 birim eksik tahsil eder ve
    /// eksik alan taraf CREATOR olur.
    ///
    /// Elle turetilmis (gross = 1_000_013 wei):
    ///   duzeltmesiz net = 1_000_013 * 10_000 / 10_125 = 987_667
    ///   protocolFee = ceil(987_667 * 95 / 1e4) = 9_383
    ///   creatorFee  = ceil(987_667 * 30 / 1e4) = 2_964     (toplam 12_347)
    ///   987_667 + 12_347 = 1_000_014 > gross -> tasma 1 -> net = 987_666
    ///   987_666 + 9_383 + 2_964 = 1_000_013 = gross   (TAM, iade yok)
    /// Ayni girdide donen net uzerinden yeniden hesaplama
    /// ceil(987_666 * 30 / 1e4) = 2_963 verirdi -- creator 1 birim eksik.
    function test_buyExactQuoteInChargesTheFeeOnThePreCorrectionNet() public {
        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 1_000_013}(0);

        assertEq(escrow.owed(CREATOR), 2_964, "the creator was shorted by a recomputed fee");
        assertEq(escrow.owed(TREASURY), 9_383);
        assertEq(curve.realQuoteReserves(), 987_666);
        // Duzeltme tetiklendigi icin toplam butceye TAM oturur; iade yoktur.
        assertEq(before - BUYER.balance, 1_000_013);
        assertEq(token.balanceOf(BUYER), 246_916_249_999);
    }

    /// Cok kucuk bir butce SIFIR TOKEN dondurmez, revert eder. Bu arcpad'in
    /// karari; pump.fun'da dogrulanmis bir davranis DEGILDIR.
    function test_buyExactQuoteInRevertsRatherThanSellingZeroTokens() public {
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buyExactQuoteIn{value: 0}(0);

        // gross = 2: duzeltmesiz net = 1, ucretler 1 + 1 = 2, tasma 1 -> net 0.
        vm.prank(BUYER);
        vm.expectRevert(CurveMath.NetTooSmall.selector);
        curve.buyExactQuoteIn{value: 2}(0);
    }

    // ---------------------------------------------------------------
    // Satim
    // ---------------------------------------------------------------

    /// Elle turetilmis. Once 2_000_000e18 alinir:
    ///   cost = floor(2e24 * 4_292e18 / (1_073_000_000e18 - 2e24)) + 1
    ///        = 8_014_939_309_056_956_116
    ///   Vq = 4_292e18 + cost, Vt = 1_071_000_000e18
    /// Sonra 1_000_000e18 satilir:
    ///   proceeds = floor(1e24 * Vq / (Vt + 1e24)) = 4_011_207_965_773_374_026
    ///   protocolFee = ceil(proceeds * 95 / 1e4) =    38_106_475_674_847_054
    ///   creatorFee  = ceil(proceeds * 30 / 1e4) =    12_033_623_897_320_123
    ///   satici net alir             = 3_961_067_866_201_206_849
    function test_sellPaysCurveProceedsMinusBothFeeParts() public {
        uint256 buyTotal = 8_014_939_309_056_956_116 + 76_141_923_436_041_084 + 24_044_817_927_170_869;

        vm.startPrank(BUYER);
        curve.buyExactTokensOut{value: buyTotal}(2_000_000e18, type(uint256).max);
        token.approve(address(curve), type(uint256).max);

        uint256 before = BUYER.balance;
        curve.sellExactTokensIn(1_000_000e18, 0);
        vm.stopPrank();

        assertEq(BUYER.balance - before, 3_961_067_866_201_206_849, "seller was not paid proceeds minus both fees");
        assertEq(escrow.owed(TREASURY), 76_141_923_436_041_084 + 38_106_475_674_847_054);
        assertEq(escrow.owed(CREATOR), 24_044_817_927_170_869 + 12_033_623_897_320_123);

        assertEq(curve.virtualQuoteReserves(), 4_296_003_731_343_283_582_090);
        assertEq(curve.virtualTokenReserves(), 1_072_000_000e18);
        assertEq(curve.realTokenReserves(), 792_100_000e18);
        assertEq(curve.realQuoteReserves(), 4_003_731_343_283_582_090);
        assertEq(address(curve).balance, curve.realQuoteReserves());
        assertEq(token.balanceOf(BUYER), 1_000_000e18);
    }

    /// `quoteSellProceeds` tabana yuvarlar ve sifir verebilir; ustelik
    /// proceeds 1 veya 2 iken iki ucret parcasi (tavana yuvarlandiklari icin
    /// ikisi de en az 1) toplami proceeds'i yutar. Escrow'a dokunmadan ONCE
    /// bu eleniyor -- aksi halde saticiya sifir odenir ya da cikarma altan
    /// tasar.
    ///
    /// Elle turetilmis (taze curve): proceeds = floor(a * V / (T + a))
    ///   a =   250_000 -> 0   ucretler 0 + 0 = 0  -> reddedilir
    ///   a =   250_001 -> 1   ucretler 1 + 1 = 2  -> reddedilir
    ///   a =   500_001 -> 2   ucretler 1 + 1 = 2  -> reddedilir
    ///   a =   750_001 -> 3   ucretler 1 + 1 = 2  -> net 1, GECER
    function test_sellRevertsWhenProceedsWouldBeZero() public {
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 10e18}(1_000_000e18, type(uint256).max);
        vm.prank(BUYER);
        token.approve(address(curve), type(uint256).max);

        uint256[3] memory dust = [uint256(250_000), 250_001, 500_001];
        for (uint256 i = 0; i < dust.length; ++i) {
            vm.prank(BUYER);
            vm.expectRevert(BondingCurve.ZeroAmount.selector);
            curve.sellExactTokensIn(dust[i], 0);
        }

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.sellExactTokensIn(0, 0);
    }

    function test_sellRevertsWhenProceedsBelowMinQuoteOut() public {
        uint256 buyTotal = 8_014_939_309_056_956_116 + 76_141_923_436_041_084 + 24_044_817_927_170_869;

        vm.startPrank(BUYER);
        curve.buyExactTokensOut{value: buyTotal}(2_000_000e18, type(uint256).max);
        token.approve(address(curve), type(uint256).max);

        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.sellExactTokensIn(1_000_000e18, 3_961_067_866_201_206_850);

        // Ucret DUSULDUKTEN sonraki net tutar tam olarak bu; minQuoteOut ona
        // karsi tutulur, ucret oncesi proceeds'e karsi degil.
        curve.sellExactTokensIn(1_000_000e18, 3_961_067_866_201_206_849);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------
    // Ucretler
    // ---------------------------------------------------------------

    /// Ucret PARCALARDAN TOPLANIR, bir toplamdan BOLUNMEZ.
    /// Elle turetilmis (taze curve, tokensOut = 1e18):
    ///   cost        = floor(1e18 * 4_292e18 / (1_073_000_000e18 - 1e18)) + 1
    ///               = 4_000_000_003_728
    ///   protocolFee = ceil(cost * 95 / 1e4) = 38_000_000_036
    ///   creatorFee  = ceil(cost * 30 / 1e4) = 12_000_000_012
    ///   PARCALI toplam                      = 50_000_000_048
    ///   BIRLESIK ceil(cost * 125 / 1e4)     = 50_000_000_047   <- 1 EKSIK
    /// Birlesik orandan bolen bir uygulama protokolu 1 birim eksik oder.
    function test_feeIsSummedFromPartsNotDividedFromTheTotal() public {
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 1e18}(1e18, type(uint256).max);

        assertEq(escrow.owed(TREASURY), 38_000_000_036);
        assertEq(escrow.owed(CREATOR), 12_000_000_012);
        assertEq(escrow.totalOwed(), 50_000_000_048);

        // Birlesik oranin TEK tavan yuvarlamasi bundan 1 birim azdir.
        assertEq(escrow.totalOwed() - 50_000_000_047, 1);
    }

    /// Creator sifirsa creator payi HIC ALINMAZ ve protokol payina KATLANMAZ.
    /// Islem sadece 30 bps daha ucuz olur. Ayrica FeeEscrow.deposit sifir
    /// tutarda revert ettigi icin kosulsuz yatirim her islemi kirardi.
    function test_creatorFeeIsSkippedWhenCreatorIsZeroAndNotFoldedIntoProtocol() public {
        FeeEscrow escrow2 = new FeeEscrow();
        (BondingCurve c2,) = _launch(address(0), escrow2);

        uint256 cost = 4_003_731_343_283_582_090;
        uint256 protocolFee = 38_035_447_761_194_030;

        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        c2.buyExactTokensOut{value: 10e18}(1_000_000e18, type(uint256).max);

        // Protokol payi creator'li curve'dekiyle AYNI -- katlanma yok.
        assertEq(escrow2.owed(TREASURY), protocolFee);
        assertEq(escrow2.owed(address(0)), 0);
        assertEq(escrow2.totalOwed(), protocolFee);

        // Ve islem tam olarak creator payi kadar ucuzdur.
        assertEq(before - BUYER.balance, cost + protocolFee);
        assertEq(cost + protocolFee + 12_011_194_029_850_747, 4_053_777_985_074_626_867);
    }

    function test_creatorFeeIsSkippedOnTheSellPathToo() public {
        FeeEscrow escrow2 = new FeeEscrow();
        (BondingCurve c2, LaunchToken t2) = _launch(address(0), escrow2);

        vm.startPrank(BUYER);
        c2.buyExactTokensOut{value: 10e18}(2_000_000e18, type(uint256).max);
        t2.approve(address(c2), type(uint256).max);
        uint256 before = BUYER.balance;
        c2.sellExactTokensIn(1_000_000e18, 0);
        vm.stopPrank();

        // proceeds = 4_011_207_965_773_374_026, protocolFee = 38_106_475_674_847_054
        assertEq(BUYER.balance - before, 4_011_207_965_773_374_026 - 38_106_475_674_847_054);
        assertEq(escrow2.owed(address(0)), 0);
    }

    // ---------------------------------------------------------------
    // Olaylar
    // ---------------------------------------------------------------

    /// `Trade` rezervlerin DORDUNU DE ve ISLEMDEN SONRAKI degerleriyle tasir.
    /// Faz 3'un indexer'i her islemden sonraki durumu zincire tekrar sormadan
    /// bunun uzerinden yeniden kurar; islem ONCESI degerleri yayinlayan bir
    /// govde indexer'i sessizce bir islem geriye kaydirirdi.
    function test_tradeEventCarriesTheFourReservesAsTheyAreAfterTheTrade() public {
        vm.expectEmit(true, false, false, true, address(curve));
        emit BondingCurve.Trade(
            BUYER,
            true,
            1_000_000e18,
            4_003_731_343_283_582_090,
            38_035_447_761_194_030,
            12_011_194_029_850_747,
            1_072_000_000e18,
            4_296_003_731_343_283_582_090,
            792_100_000e18,
            4_003_731_343_283_582_090
        );
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 10e18}(1_000_000e18, type(uint256).max);
    }

    function test_tradeEventOnTheSellSideCarriesPostTradeReservesToo() public {
        vm.startPrank(BUYER);
        curve.buyExactTokensOut{value: 10e18}(2_000_000e18, type(uint256).max);
        token.approve(address(curve), type(uint256).max);

        vm.expectEmit(true, false, false, true, address(curve));
        emit BondingCurve.Trade(
            BUYER,
            false,
            1_000_000e18,
            4_011_207_965_773_374_026,
            38_106_475_674_847_054,
            12_033_623_897_320_123,
            1_072_000_000e18,
            4_296_003_731_343_283_582_090,
            792_100_000e18,
            4_003_731_343_283_582_090
        );
        curve.sellExactTokensIn(1_000_000e18, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------
    // Tamamlanma
    // ---------------------------------------------------------------

    function test_completeFlipsInsideTheBuyThatDrainsRealTokenReserves() public {
        uint256 cost = 12_161_433_369_060_378_706_681;

        vm.deal(BUYER, 100_000e18);
        vm.expectEmit(true, false, false, true, address(curve));
        emit BondingCurve.Completed(address(token), cost, 206_886_011_183_597_390_493_942_218);

        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);

        assertTrue(curve.complete());
        assertEq(curve.realQuoteReserves(), cost);
    }

    /// Tamamlanma tek yonlu kapidir. Satis onu geri alamaz cunku satis
    /// tamamlanmis bir curve'de HIC calismaz.
    function test_completeIsIrreversibleAndSellCannotUndoIt() public {
        vm.deal(BUYER, 100_000e18);
        vm.startPrank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        token.approve(address(curve), type(uint256).max);

        vm.expectRevert(BondingCurve.CurveComplete.selector);
        curve.sellExactTokensIn(1_000_000e18, 0);
        vm.stopPrank();

        assertTrue(curve.complete());
        assertEq(curve.realTokenReserves(), 0);
    }

    function test_everyEntrypointRevertsWithCurveCompleteAfterCompletion() public {
        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.CurveComplete.selector);
        curve.buyExactTokensOut{value: 1e18}(1e18, type(uint256).max);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.CurveComplete.selector);
        curve.buyExactQuoteIn{value: 1e18}(0);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.CurveComplete.selector);
        curve.sellExactTokensIn(1e18, 0);
    }

    /// pump.fun'da toz YAPISAL OLARAK yoktur: `buy` tam-cikisli oldugu icin
    /// `real_token_reserves` tam sifira iner. arcpad `buyExactQuoteIn`'de
    /// rezerve kistigi icin ayni garantiyi burada YENIDEN KURMAK zorundadir.
    function test_reservesLandExactlyOnZeroWithNoDustOnAnExactOutCompletion() public {
        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);

        assertEq(curve.realTokenReserves(), 0, "exact-out completion left token dust");
        assertEq(curve.virtualTokenReserves(), T - S);
        assertEq(curve.virtualTokenReserves(), 279_900_000e18);
        // Kalan bakiye tam olarak havuza gidecek olan artiktir.
        assertEq(token.balanceOf(address(curve)), N - S);
        assertEq(address(curve).balance, curve.realQuoteReserves());
    }

    // ---------------------------------------------------------------
    // CEI
    // ---------------------------------------------------------------

    /// TASIYICI TEST. Saldirgan, iadesi geldigi anda -- curve'un SON dis
    /// cagrisinda -- ayni curve'e ikinci bir alim yapar. Defter zaten
    /// yazilmissa ikinci alim GUNCEL rezervleri gorur ve daha PAHALIYA
    /// doldurulur; defter dis cagrilardan sonra yazilsaydi ikinci alim BAYAT
    /// rezervleri gorur ve birinciyle ayni fiyattan doldurulurdu.
    ///
    /// Kurgunun saldiriyi gercekten mumkun kildigini kanitlayan iki sey:
    ///   (1) Curve'de saldirganin kendi parasi DISINDA para vardir (ALICE'in
    ///       tohum alimi). Faz 1b'de tam bu eksik oldugu icin ayni sinifta
    ///       bir test hicbir sey kanitlamiyordu.
    ///   (2) Ikiz curve. Saldirganin reentrant ciftinin, ard arda yapilan
    ///       DURUST cifte birebir esit dusmesi gerekir. Mutasyon her iki
    ///       curve'e de uygulanir ama yalnizca reentrant olanda etki eder --
    ///       yani esitlik mutasyonu ayirt eder.
    ///
    /// Elle turetilmis. Tohum alim 5_000_000e18 -> cost 20_093_632_958_801_498_128.
    /// Sonra 2 x 1_000_000e18:
    ///   cost1 = 4_041_324_866_877_977_037
    ///   cost2 = 4_048_907_089_892_757_482   (cost1'den 7_582_223_014_780_445 fazla)
    /// Bayat rezervlerle her ikisi de cost1 olurdu.
    function test_ledgerIsFullyWrittenBeforeAnyExternalCall() public {
        uint256 amount = 1_000_000e18;
        uint256 seedTotal = 20_093_632_958_801_498_128 + 190_889_513_108_614_233 + 60_280_898_876_404_495;

        uint256 cost1 = 4_041_324_866_877_977_037;
        uint256 cost2 = 4_048_907_089_892_757_482;
        uint256 honestSpend = 8_191_359_856_230_368_703;

        // --- Curve A: reentrant cift ---
        FeeEscrow escrowA = new FeeEscrow();
        (BondingCurve curveA, LaunchToken tokenA) = _launch(CREATOR, escrowA);
        vm.prank(ALICE);
        curveA.buyExactTokensOut{value: seedTotal}(5_000_000e18, type(uint256).max);

        ReentrantBuyer attacker = new ReentrantBuyer(curveA, amount, 10e18);
        vm.deal(address(attacker), 100e18);
        attacker.attack(10e18);
        uint256 attackerSpend = 100e18 - address(attacker).balance;

        // --- Curve B: ard arda iki durust alim ---
        FeeEscrow escrowB = new FeeEscrow();
        (BondingCurve curveB, LaunchToken tokenB) = _launch(CREATOR, escrowB);
        vm.prank(ALICE);
        curveB.buyExactTokensOut{value: seedTotal}(5_000_000e18, type(uint256).max);

        address honest = address(0x40E57);
        vm.deal(honest, 100e18);
        vm.startPrank(honest);
        curveB.buyExactTokensOut{value: 10e18}(amount, type(uint256).max);
        curveB.buyExactTokensOut{value: 10e18}(amount, type(uint256).max);
        vm.stopPrank();
        uint256 honestSpendMeasured = 100e18 - honest.balance;

        // Saldiri gercekten OLDU -- test bos yere yesil olamaz.
        assertTrue(attacker.reentered(), "the reentrant call never happened; the fixture proves nothing");

        // Reentrancy hicbir avantaj saglamadi.
        assertEq(attackerSpend, honestSpendMeasured, "reentering the refund bought tokens at a stale price");
        assertEq(attackerSpend, honestSpend);
        assertEq(honestSpendMeasured, honestSpend);

        assertEq(curveA.realQuoteReserves(), curveB.realQuoteReserves());
        assertEq(curveA.virtualQuoteReserves(), curveB.virtualQuoteReserves());
        assertEq(curveA.realTokenReserves(), curveB.realTokenReserves());
        assertEq(curveA.virtualTokenReserves(), curveB.virtualTokenReserves());
        assertEq(escrowA.totalOwed(), escrowB.totalOwed());
        assertEq(tokenA.balanceOf(address(attacker)), tokenB.balanceOf(honest));
        assertEq(tokenA.balanceOf(address(attacker)), 2 * amount);

        // Ve mutlak degerler de sabitlenir, boylece HER IKI curve'u birden
        // kaydiran bir mutasyon esitlige siginamaz.
        assertEq(curveA.realQuoteReserves(), 20_093_632_958_801_498_128 + cost1 + cost2);
        assertEq(curveA.realQuoteReserves(), 28_183_864_915_572_232_647);
        assertEq(address(curveA).balance, curveA.realQuoteReserves());
    }

    /// AYNI TASIYICI TEST, SATIS TARAFI. Satis geliri de duz `call` ile
    /// odendigi icin satisin da bir reentrancy penceresi vardir. Ilk mutasyon
    /// turunda satis tarafi CEI'yi ters ceviren mutant 33/33 ile hayatta
    /// kaldi -- yani paket, korumak icin yazildigi ozelligin YARISINA
    /// yapisal olarak kordu. Bu test o yarim.
    ///
    /// Elle turetilmis. Tohum alim 5_000_000e18 (ALICE), sonra satici
    /// 2_000_000e18 alir; Vq = 4_320_183_864_915_572_232_647,
    /// Vt = 1_066_000_000e18. Ardindan 2 x 1_000_000e18 satilir:
    ///   sell1 proceeds = 4_048_907_089_892_757_481 -> net 3_998_295_751_269_098_011
    ///   sell2 proceeds = 4_041_324_866_877_977_036 -> net 3_990_808_306_042_002_322
    ///   toplam net                                 = 7_989_104_057_311_100_333
    /// Bayat rezervlerle her iki satis da sell1 fiyatindan odenirdi:
    /// 2 x 3_998_295_751_269_098_011 = 7_996_591_502_538_196_022.
    function test_theSellPayoutCannotBeReenteredAtAStalePrice() public {
        uint256 amount = 1_000_000e18;
        uint256 seedTotal = 20_344_803_370_786_516_856;
        uint256 acquireTotal = 8_191_359_856_230_368_701;

        // --- Curve A: reentrant cift satis ---
        FeeEscrow escrowA = new FeeEscrow();
        (BondingCurve curveA, LaunchToken tokenA) = _launch(CREATOR, escrowA);
        vm.prank(ALICE);
        curveA.buyExactTokensOut{value: seedTotal}(5_000_000e18, type(uint256).max);

        ReentrantSeller attacker = new ReentrantSeller(curveA, tokenA, amount);
        vm.deal(address(attacker), acquireTotal);
        attacker.acquire(2_000_000e18);
        assertEq(address(attacker).balance, 0);
        attacker.attack();
        uint256 attackerReceived = address(attacker).balance;

        // --- Curve B: ard arda iki durust satis ---
        FeeEscrow escrowB = new FeeEscrow();
        (BondingCurve curveB, LaunchToken tokenB) = _launch(CREATOR, escrowB);
        vm.prank(ALICE);
        curveB.buyExactTokensOut{value: seedTotal}(5_000_000e18, type(uint256).max);

        address honest = address(0x40E58);
        vm.deal(honest, acquireTotal);
        vm.startPrank(honest);
        curveB.buyExactTokensOut{value: acquireTotal}(2_000_000e18, type(uint256).max);
        tokenB.approve(address(curveB), type(uint256).max);
        curveB.sellExactTokensIn(amount, 0);
        curveB.sellExactTokensIn(amount, 0);
        vm.stopPrank();
        uint256 honestReceived = honest.balance;

        assertTrue(attacker.reentered(), "the reentrant sell never happened; the fixture proves nothing");

        assertEq(attackerReceived, honestReceived, "reentering the payout sold at a stale price");
        assertEq(attackerReceived, 7_989_104_057_311_100_333);
        assertEq(curveA.realQuoteReserves(), curveB.realQuoteReserves());
        assertEq(curveA.virtualQuoteReserves(), curveB.virtualQuoteReserves());
        assertEq(curveA.realTokenReserves(), curveB.realTokenReserves());
        assertEq(curveA.virtualTokenReserves(), curveB.virtualTokenReserves());
        assertEq(escrowA.totalOwed(), escrowB.totalOwed());
        assertEq(curveA.realQuoteReserves(), 20_093_632_958_801_498_130);
        assertEq(address(curveA).balance, curveA.realQuoteReserves());
    }

    // ---------------------------------------------------------------
    // Fuzz -- odeme gucu ve butce
    // ---------------------------------------------------------------

    /// Curve'un native bakiyesi HER ZAMAN realQuoteReserves'e esittir: ucret
    /// escrow'a, iade kullaniciya gider ve defterde iz birakmaz.
    /// Aralik KISMA ESIGINI (12_313_451_286_173_633_440_516 wei) bilerek
    /// ASAR, boylece fuzz iki dali da dolasir. Kisilan dalda ayrica toz
    /// olmadigi fuzz'lanir -- pump.fun'da toz yapisal olarak yoktur ve kismi
    /// doldurma o garantiyi kaybettirdigi icin burada yeniden kurulmasi
    /// gerekir.
    function testFuzz_buyExactQuoteInNeverSpendsMoreThanTheBudget(uint256 gross) public {
        gross = bound(gross, 10_000, 40_000e18);
        vm.deal(BUYER, 100_000e18);

        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: gross}(0);
        uint256 spent = before - BUYER.balance;

        assertLe(spent, gross, "the curve spent more than msg.value");
        assertEq(spent, curve.realQuoteReserves() + escrow.totalOwed());
        assertEq(address(curve).balance, curve.realQuoteReserves());

        if (curve.complete()) {
            // Kisildi: rezerv TAM sifira indi, toz kalmadi.
            assertEq(curve.realTokenReserves(), 0, "a clamped fill left token dust");
            assertEq(curve.virtualTokenReserves(), T - S);
        } else {
            // Kisilmadi: artik yalnizca butce garantisinin biraktigidir ve
            // {0, 1} kumesindedir -- asla negatif, asla 2 ve uzeri.
            assertLe(gross - spent, 1, "slack outside {0, 1}");
        }
    }

    function testFuzz_buyThenSellBackNeverProfits(uint256 tokensOut) public {
        tokensOut = bound(tokensOut, 1e18, 10_000_000e18);
        vm.deal(BUYER, 1_000_000e18);

        uint256 before = BUYER.balance;
        vm.startPrank(BUYER);
        curve.buyExactTokensOut{value: 500_000e18}(tokensOut, type(uint256).max);
        token.approve(address(curve), type(uint256).max);
        curve.sellExactTokensIn(tokensOut, 0);
        vm.stopPrank();

        assertLe(BUYER.balance, before, "a round trip returned more than it cost");
        assertEq(address(curve).balance, curve.realQuoteReserves());
    }
}
