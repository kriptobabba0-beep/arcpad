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

/// Native kabul etmeyen SATICI. Alim sirasinda kabul eder (tokenleri
/// edinebilsin diye), satis sirasinda reddeder. `RejectingBuyer`'in satis
/// tarafindaki ikizidir; o ikiz yokken `PayoutFailed` korumasini silen
/// mutant 37/37 ile hayatta kaliyordu.
contract RejectingSeller {
    BondingCurve public immutable curve;
    LaunchToken public immutable token;
    bool public accept;

    constructor(BondingCurve curve_, LaunchToken token_) {
        curve = curve_;
        token = token_;
    }

    function buy(uint256 tokensOut, uint256 value) external {
        accept = true;
        curve.buyExactTokensOut{value: value}(tokensOut, type(uint256).max);
        accept = false;
        token.approve(address(curve), type(uint256).max);
    }

    function sell(uint256 tokensIn) external {
        curve.sellExactTokensIn(tokensIn, 0);
    }

    receive() external payable {
        require(accept, "no native");
    }
}

/// Revert verisinden selector cikaran ortak yardimci; ic cercevelerden
/// olculen revert'ler icin gerekli (`try/catch` bir kontrat cagrisi ister,
/// `receive()` icinden yapilan ham `.call` istemez).
function selectorOf(bytes memory err) pure returns (bytes4) {
    if (err.length < 4) return bytes4(0);
    return bytes4(err[0]) | (bytes4(err[1]) >> 8) | (bytes4(err[2]) >> 16) | (bytes4(err[3]) >> 24);
}

/// KODU OLAN ama defter OLMAYAN "escrow". `LaunchFactory`'nin deploy aninda
/// reddettigi sekil; burada REDDEDILMEDEN once ne olurdu, o olculuyor.
contract NotALedgerEscrow {
    function unrelated() external pure returns (uint256) {
        return 1;
    }
}

/// GRADUATION HEDEFI. `receive()` CIPLAK BIR KABULDUR ve bu Faz 2'nin
/// yukumlulugu (2)'sidir: odeme hedefin KENDI durum makinesi ucus halindeyken,
/// curve'un cagri cercevesinde calisir.
contract PoolSeeder {
    uint256 public baseReceived;
    uint256 public quoteReceived;
    uint256 public pulls;

    function pull(BondingCurve curve) external returns (uint256 base, uint256 quote) {
        (base, quote) = curve.graduate();
        baseReceived += base;
        quoteReceived += quote;
        pulls++;
    }

    receive() external payable {}
}

/// Odemeyi REDDEDEN hedef; ONARILABILIR. Yeniden denemenin ayni `(D, R)`yi
/// dondurdugu ancak onarim sonrasi olculebilir -- ve o olcum "reddeden bir
/// havuz bir launch'i strand edemez" cumlesinin ikinci yarisidir.
contract RejectingSeeder {
    bool public repaired;

    function repair() external {
        repaired = true;
    }

    function pull(BondingCurve curve) external returns (uint256, uint256) {
        return curve.graduate();
    }

    receive() external payable {
        require(repaired, "no native");
    }
}

/// `receive()` HIC OLMAYAN hedef. `RejectingSeeder`dan ayri bir vakadir:
/// orada revert bir `require`dan gelir, burada cagrilacak fonksiyon YOKTUR.
contract NoReceiveSeeder {
    function pull(BondingCurve curve) external returns (uint256, uint256) {
        return curve.graduate();
    }
}

/// Odeme cercevesinin ICINDEN curve'un BES giris noktasini da yoklayan hedef.
/// Yalnizca "revert etti mi" degil HANGI selector ile revert ettigi olculur;
/// alim yollarinda `complete` korumasini silmek davranisi degistirmez,
/// yalnizca selector'u degistirir.
contract ProbingSeeder {
    BondingCurve public curve;
    bytes4[5] public seen;
    bool public probed;

    function pull(BondingCurve curve_) external returns (uint256, uint256) {
        curve = curve_;
        return curve_.graduate();
    }

    receive() external payable {
        if (probed) return;
        probed = true;
        seen[0] = _probe(abi.encodeWithSelector(BondingCurve.graduate.selector));
        seen[1] = _probe(abi.encodeWithSelector(BondingCurve.buyExactTokensOut.selector, 1, type(uint256).max));
        seen[2] = _probe(abi.encodeWithSelector(BondingCurve.buyExactQuoteIn.selector, uint256(0)));
        seen[3] = _probe(abi.encodeWithSelector(BondingCurve.sellExactTokensIn.selector, 1, 0));
        seen[4] = _probe(abi.encodeWithSelector(BondingCurve.bind.selector, address(0xBEEF)));
    }

    /// @dev Basari `bytes4(0)` dondurur ve testte IHLAL olarak okunur.
    function _probe(bytes memory data) internal returns (bytes4) {
        (bool ok, bytes memory err) = address(curve).call(data);
        if (ok) return bytes4(0);
        return selectorOf(err);
    }
}

/// CAPRAZ CURVE. Curve A'nin odemesi icinde curve B'yi mezun eder. Ucuncu bir
/// tarafca somurulemez (cagiran hedefin KENDISIDIR) ama Faz 2 yazarinin
/// carpacagi vaka budur.
contract CrossCurveSeeder {
    BondingCurve public other;
    bool public done;
    bytes4 public innerFailure;

    function setOther(BondingCurve other_) external {
        other = other_;
    }

    function pull(BondingCurve curve) external returns (uint256, uint256) {
        return curve.graduate();
    }

    receive() external payable {
        if (done || address(other) == address(0)) return;
        done = true;
        (bool ok, bytes memory err) = address(other).call(abi.encodeWithSelector(BondingCurve.graduate.selector));
        if (!ok) innerFailure = selectorOf(err);
    }
}

/// FACTORY ROLUNU OYNAYAN OLCUM ARACI. Curve'un factory'sinden okudugu IKI
/// uyeyi de NON-`view` olarak sunar ve istege bagli olarak SSTORE yapar --
/// yani `view`in TASIYICI oldugu iddiasi burada OLCULUR, kaynak koddan
/// OKUNMAZ. Kontrol grubu ayni fonksiyonun statik OLMAYAN bir cagriyla
/// sayaci artirmasidir; o olmadan test "herhangi bir sebeple revert eden" bir
/// kontratta da gecerdi.
contract MeasuringFactory {
    BondingCurve public curve;
    LaunchToken public token;

    address internal treasury;
    address internal target;

    uint256 public writes;
    bool public writeOnTargetRead;
    bool public writeOnTreasuryRead;

    constructor(address treasury_, uint256 t_, uint256 v_, uint256 s_) {
        treasury = treasury_;
        curve = new BondingCurve(address(0xC7EA), address(new FeeEscrow()), t_, v_, s_);
        token = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", address(0xC7EA), address(curve), bytes32(0));
        curve.bind(address(token));
    }

    function setTarget(address target_) external {
        target = target_;
    }

    function armTargetWrite() external {
        writeOnTargetRead = true;
    }

    function armTreasuryWrite() external {
        writeOnTreasuryRead = true;
    }

    /// @dev NON-`view` BILEREK. Curve'un YEREL arayuzu bunu `view` beyan eder,
    ///      dolayisiyla solc curve tarafinda STATICCALL uretir ve asagidaki
    ///      SSTORE o cercevede YASAKTIR.
    function graduationTarget() external returns (address) {
        if (writeOnTargetRead) writes += 1;
        return target;
    }

    function protocolTreasury() external returns (address) {
        if (writeOnTreasuryRead) writes += 1;
        return treasury;
    }

    function pull() external returns (uint256, uint256) {
        return curve.graduate();
    }

    receive() external payable {}
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

    /// BU TEST KONTRATI CURVE'LERIN FACTORY'SIDIR (deploy eden odur), yani
    /// `ILaunchFactory`nin IKI uyesini TASIMAK ZORUNDADIR: `protocolTreasury()`
    /// HER islemde, `graduationTarget()` her `graduate()` cagrisinda STATICCALL
    /// ile okunur. Ikisi de DEGISKENDIR, cunku rotasyonun CANLI bir curve'e
    /// ulastigi ancak boyle olculebilir.
    address public protocolTreasury = TREASURY;
    address public graduationTarget;

    function setUp() public {
        escrow = new FeeEscrow();
        (curve, token) = _launch(CREATOR, escrow);
        vm.deal(BUYER, 1_000_000e18);
        vm.deal(ALICE, 1_000_000e18);
    }

    /// Task 3'un factory'sinin yapacagi seyin aynisi: once curve, sonra token,
    /// sonra bind. Bu dosyada factory rolunu test kontratinin kendisi oynar ve
    /// URETIM profilini gecirir -- factory de profili kendi immutable'larinda
    /// boyle tutacak.
    ///
    /// `launchSalt` bu dosyada her yerde `bytes32(0)`'dir ve bu bilerek
    /// boyledir: curve o alani HIC OKUMAZ. Salt yalnizca
    /// `LaunchFactory.isCanonical`'in turetmesine girer, ve bu dosyanin
    /// olctugu hicbir sey provenance degildir.
    function _launch(address creator_, FeeEscrow escrow_) internal returns (BondingCurve c, LaunchToken t) {
        c = _newCurve(creator_, address(escrow_));
        t = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(c), bytes32(0));
        c.bind(address(t));
    }

    function _newCurve(address creator_, address escrow_) internal returns (BondingCurve) {
        return new BondingCurve(creator_, escrow_, T, V, S);
    }

    function _curveWithProfile(uint256 t_, uint256 v_, uint256 s_) internal returns (BondingCurve) {
        return new BondingCurve(CREATOR, address(escrow), t_, v_, s_);
    }

    /// Uretim disi bir profille tam bir launch (curve + token + bind).
    function _launchWithProfile(uint256 t_, uint256 v_, uint256 s_) internal returns (BondingCurve c, LaunchToken t) {
        c = _curveWithProfile(t_, v_, s_);
        t = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(c), bytes32(0));
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
        BondingCurve fresh = _newCurve(CREATOR, address(escrow));
        LaunchToken t = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(fresh), bytes32(0));

        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.NotFactory.selector);
        fresh.bind(address(t));

        // Factory yapinca gecer.
        fresh.bind(address(t));
        assertEq(fresh.token(), address(t));
    }

    function test_bindRevertsOnTheSecondCall() public {
        LaunchToken other = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(curve), bytes32(0));
        vm.expectRevert(BondingCurve.AlreadyBound.selector);
        curve.bind(address(other));
        assertEq(curve.token(), address(token));
    }

    function test_bindRevertsOnZeroToken() public {
        BondingCurve fresh = _newCurve(CREATOR, address(escrow));
        vm.expectRevert(BondingCurve.ZeroToken.selector);
        fresh.bind(address(0));
    }

    /// Bagi tek yonlu kurmak yetmez: token'in da curve'u isaret etmesi gerekir.
    /// Aksi halde curve, arzi baska bir curve'de duran bir token'a baglanir ve
    /// hicbir transferi karsilayamaz.
    function test_bindRevertsWhenTheTokenDoesNotPointBack() public {
        BondingCurve fresh = _newCurve(CREATOR, address(escrow));
        LaunchToken elsewhere = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(curve), bytes32(0));

        vm.expectRevert(BondingCurve.TokenDoesNotPointBack.selector);
        fresh.bind(address(elsewhere));
    }

    /// bind edilmemis bir curve'de TICARET PENCERESI YOKTUR. Ucunu de kapat.
    function test_everyTradingEntrypointRevertsBeforeBind() public {
        BondingCurve unbound = _newCurve(CREATOR, address(escrow));
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

    /// Curve `escrow`u IMMUTABLE tutar ve sifir olmasini reddeder.
    ///
    /// `protocolTreasury` icin BURADA ARTIK BIR KONTROL YOKTUR ve olmamalidir:
    /// curve o adresi bir argumandan almaz, `protocolTreasury()` ile HER
    /// YATIRIMDA factory'den okur (F1). Sifir olmama garantisinin tek yeri
    /// `LaunchFactory`'nin constructor'i ve setter'idir; buraya bir kontrol
    /// koymak gercek factory ile ULASILAMAZ bir dal, yani mutasyonla
    /// oldurulemeyen olu kod olurdu.
    ///
    /// Asimetri kasitlidir: escrow BIRIKMIS alacaklari tutar, dolayisiyla onu
    /// dondurmek gecmis ucretleri tasimaz, yalnizca defteri catallar. Treasury
    /// rotasyonunda ise `owed[eski]` eski adresin talebi olarak aynen kalir.
    function test_constructorRejectsZeroEscrowAndTakesNoTreasuryArgument() public {
        vm.expectRevert(BondingCurve.ZeroEscrow.selector);
        new BondingCurve(CREATOR, address(0), T, V, S);

        // Ve treasury'yi factory'den okur: bu test kontrati curve'un
        // factory'sidir ve `protocolTreasury()`si TREASURY dondurur.
        assertEq(curve.protocolTreasury(), TREASURY, "treasury factory'den okunmuyor");
        assertEq(curve.factory(), address(this));
    }

    /// Profil artik factory'den geldigi icin YANLIS BIR DEPLOY ARGUMANI
    /// sessiz olamaz. Uc sifir ve tasiyici esitsizlik `S < T` ayri ayri
    /// reddedilir.
    function test_constructorRejectsADegenerateProfile() public {
        vm.expectRevert(BondingCurve.ZeroVirtualTokenReserves.selector);
        new BondingCurve(CREATOR, address(escrow), 0, V, S);

        vm.expectRevert(BondingCurve.ZeroVirtualQuoteReserves.selector);
        new BondingCurve(CREATOR, address(escrow), T, 0, S);

        vm.expectRevert(BondingCurve.ZeroSaleSupply.selector);
        new BondingCurve(CREATOR, address(escrow), T, V, 0);

        // S == T reddedilir; sinirin GECEN tarafi (S = T - 1) constructor'dan
        // gecer. Bu bir ONAY DEGILDIR: constructor yalnizca ARITMETIK olarak
        // iyi tanimli olani sinirlar, cunku o anda token -- ve dolayisiyla
        // arz -- henuz bilinmez. `S = T - 1` fiilen kullanilamaz ve bunu
        // `bind` reddeder; asagidaki test o katmani kapatir.
        vm.expectRevert(BondingCurve.SaleSupplyNotBelowTokenReserves.selector);
        new BondingCurve(CREATOR, address(escrow), T, V, T);

        vm.expectRevert(BondingCurve.SaleSupplyNotBelowTokenReserves.selector);
        new BondingCurve(CREATOR, address(escrow), T, V, T + 1);

        BondingCurve edge = new BondingCurve(CREATOR, address(escrow), T, V, T - 1);
        assertEq(edge.INITIAL_REAL_TOKEN_RESERVES(), T - 1);

        // ...ve ona bir token BAGLANAMAZ: S = 1,073e27 > N = 1e27.
        LaunchToken t = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(edge), bytes32(0));
        vm.expectRevert(BondingCurve.TokenBalanceBelowSaleAndSeed.selector);
        edge.bind(address(t));
    }

    /// `S <= N` ve `D <= N - S` iliskilerini `bind` kurar, cunku constructor
    /// token'i -- dolayisiyla `N`'i -- bilmez. Ikisi tek kontratta toplanir:
    /// bakiye >= S + D.
    ///
    /// Elle turetilmis (uretim T ile):
    ///   D(S)      = S(T-S)/T
    ///   S = 793_100_000e18 -> D = 206_886_011_183_597_390_493_942_218
    ///                         S + D = 999_986_011_183_597_390_493_942_218 <= 1e27  (pay 13_988,8 token)
    ///   En buyuk fonlanabilir S    = 793_126_814_431_964_561_597_182_417
    ///                         S + D = 1e27 TAM
    ///   Bir fazlasi                = 793_126_814_431_964_561_597_182_418 -> S + D = 1e27 + 1  RED
    ///   S = 900_000_000e18 -> D = 145_107_176_141_658_900_279_589_934 ama geriye
    ///                         yalnizca 1e26 kalir -> RED. (Bu deger `S <= N`i
    ///                         SAGLAR; yalnizca tohum parcasini iceren bir
    ///                         kontrol onu kacirirdi.)
    function test_bindRejectsAProfileTheTokenSupplyCannotFund() public {
        // Graduation'i fonlayamayan profil: S <= N ama S + D > N.
        BondingCurve unfundable = _curveWithProfile(T, V, 900_000_000e18);
        LaunchToken t1 = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(unfundable), bytes32(0));
        vm.expectRevert(BondingCurve.TokenBalanceBelowSaleAndSeed.selector);
        unfundable.bind(address(t1));

        // Sinirin TAM uzeri gecer.
        uint256 sMax = 793_126_814_431_964_561_597_182_417;
        BondingCurve atLimit = _curveWithProfile(T, V, sMax);
        LaunchToken t2 = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(atLimit), bytes32(0));
        atLimit.bind(address(t2));
        assertEq(atLimit.token(), address(t2));
        assertEq(atLimit.INITIAL_REAL_TOKEN_RESERVES() + atLimit.poolSeedSupply(), 1_000_000_000e18);

        // Bir fazlasi gecmez.
        BondingCurve overLimit = _curveWithProfile(T, V, sMax + 1);
        LaunchToken t3 = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(overLimit), bytes32(0));
        vm.expectRevert(BondingCurve.TokenBalanceBelowSaleAndSeed.selector);
        overLimit.bind(address(t3));
    }

    /// Profil TESTNET ile URETIM arasinda yalnizca `V`'de ayrisir ve arcpad
    /// artik ikisini de deploy edebilir -- ama TEST EDILEN uretim profilidir
    /// ve bu test onu sabitler. Sabitlenen sey echo DEGIL, TURETILMIS
    /// degerlerdir: `poolSeedSupply` uc parametrenin hepsinden hesaplanir,
    /// yani yanlis bir uclu buradan sessizce gecemez.
    function test_theProductionProfileIsTheOneUnderTest() public {
        assertEq(curve.INITIAL_VIRTUAL_TOKEN_RESERVES(), 1_073_000_000e18);
        assertEq(curve.INITIAL_VIRTUAL_QUOTE_RESERVES(), 4_292e18);
        assertEq(curve.INITIAL_REAL_TOKEN_RESERVES(), 793_100_000e18);
        assertEq(curve.poolSeedSupply(), 206_886_011_183_597_390_493_942_218);

        // Ve testnet profili (V'nin 1/1000'i) ayni kod tabaniyla deploy
        // edilebilir: yalnizca argumanlar degisir, `poolSeedSupply` ise
        // V'den bagimsiz oldugu icin AYNI kalir.
        BondingCurve testnet = new BondingCurve(CREATOR, address(escrow), T, 4_292e15, S);
        assertEq(testnet.INITIAL_VIRTUAL_QUOTE_RESERVES(), 4_292e15);
        assertEq(testnet.poolSeedSupply(), 206_886_011_183_597_390_493_942_218);

        // CANLI rezervler de argumandan gelmelidir, sabitten DEGIL.
        assertEq(testnet.virtualQuoteReserves(), 4_292e15, "live reserves ignored the deploy argument");

        // ...ama testnet profili yalnizca `V`'de ayrisiyor, dolayisiyla
        // yukaridaki `T` ve `S` iddialarini burada kurmak BOSTUR: argumani
        // kullansa da kullanmasa da gecerler. Ucunu de birden degistiren
        // ayri bir profil gerekir; aksi halde canli `realTokenReserves`'i
        // uretim literalinden tohumlayan ya da `poolSeedSupply`'i uretim
        // literallerinden hesaplayan mutantlar hayatta kalir (olculdu:
        // ikisi de 42/42 yesil).
        //
        // Elle turetilmis: D2 = S2 (T2 - S2) / T2
        //   = 500_000_000e18 * 1_500_000_000e18 / 2_000_000_000e18
        //   = 375_000_000e18
        uint256 t2 = 2_000_000_000e18;
        uint256 v2 = 1_000e18;
        uint256 s2 = 500_000_000e18;
        BondingCurve other = _curveWithProfile(t2, v2, s2);

        assertEq(other.INITIAL_VIRTUAL_TOKEN_RESERVES(), t2);
        assertEq(other.INITIAL_VIRTUAL_QUOTE_RESERVES(), v2);
        assertEq(other.INITIAL_REAL_TOKEN_RESERVES(), s2);
        assertEq(other.virtualTokenReserves(), t2, "live token reserve ignored the deploy argument");
        assertEq(other.virtualQuoteReserves(), v2);
        assertEq(other.realTokenReserves(), s2, "live sale supply ignored the deploy argument");
        assertEq(other.poolSeedSupply(), 375_000_000e18, "poolSeedSupply ignored the deploy arguments");
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
        uint256 total = cost + protocolFee + creatorFee; // = 4_053_777_985_074_626_867

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
    ///
    /// Onceki hali `ZeroAmount()` bekliyordu ve HICBIR SEY kanitlamiyordu:
    /// `CurveMath.ZeroAmount()` ayni selector'u (0x1f2a2005) tasidigi icin
    /// korumayi silmek revert verisini degistirmiyor, cagri
    /// `quoteBuyCost`'un ayni isimli kontroluna dusuyordu. Curve'e ozel
    /// `ZeroTokensOut()` ile koruma artik OLDURULEBILIR ve bu test onu
    /// oldurendir.
    ///
    /// Sirayla ilgili kisim ayri bir mesele: `tokensOut == 0` iken
    /// `0 > realTokenReserves` her zaman yanlistir, yani iki kontrolu takas
    /// etmek ESDEGER bir mutasyondur ve hicbir test onu ayirt edemez.
    function test_buyExactTokensOutRevertsOnZeroAmountBeforeCheckingReserves() public {
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.ZeroTokensOut.selector);
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
        // Fark ZINCIRIN cikitisindan olculur, iki yerel literalden degil.
        assertEq(sdkTokens - token.balanceOf(BUYER), 249_885);

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
        uint256 spent = cost + protocolFee + creatorFee; // = 12_313_451_286_173_633_440_516

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

    /// KISILAN dolum da `minTokensOut`u onurlandirmak ZORUNDADIR -- ve bu,
    /// sinirin en cok onem tasidigi daldir, cunku dolumu SESSIZCE kucultup
    /// yine de tahsilat yapan tek yol odur. Slippage kontrolu kismadan ONCE
    /// yapilirsa kullanici istedigi asgariden azini alir; o mutant paketi
    /// 42/42 yesil birakiyordu, cunku `minTokensOut` diger UC dalda
    /// sabitlenmisti (exact-out, kisilmamis quote-in, satis) ve dorduncusunde
    /// degildi.
    function test_buyExactQuoteInHonoursMinTokensOutOnTheClampedFill() public {
        vm.deal(BUYER, 200_000e18);

        // Kisilmamis dolum 1_028_313_111_279_674_811_551_798_181 token olurdu;
        // kisilmis dolum tam olarak S'tir. S + 1 istemek REDDEDILMELIDIR.
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.buyExactQuoteIn{value: 100_000e18}(S + 1);

        // Kisilmis dolumun kendisi kabul edilir.
        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 100_000e18}(S);
        assertEq(token.balanceOf(BUYER), S);
        assertTrue(curve.complete());
    }

    /// KISMA SINIRI `>` OLMALIDIR, `>=` DEGIL. Kisma yalnizca dolum rezervi
    /// ASTIGINDA devreye girmelidir; tam esitlikte exact-quote-in sozlesmesi
    /// gecerlidir ve butcenin tamami curve'e yazilir.
    ///
    /// Sinir URETIM PROFILINDE pratikte yurunemez: orada bir wei'lik `net`
    /// degisimi cikti tokenini 17_012 birim kaydirir, yani
    /// `tokensOut == realTokenReserves` tam esitligi ~1,7e-14 olasilikla
    /// olusur. Profil artik factory'den geldigi icin sinir SENTETIK bir
    /// profille yurunuyor; asagidaki ucluyle bir wei'lik `net` degisimi
    /// ciktiyi 1 birimden az kaydirir ve 401 ayri `net` degeri ayni
    /// `tokensOut`a duser.
    ///
    /// Elle turetilmis (T = 1000, V = 100_000, S = 500):
    ///   tokens(net) = floor((net-1) * 1000 / (100_000 + net - 1)) == 500
    ///     <=> net - 1 in [100_000, 100_400]  ->  net in [100_001, 100_401]
    ///   net* = 100_401 (araligin en ustu) -> tokens = 500 = S TAM
    ///   gross = 101_657 -> net = 100_401, pf = 954, cf = 302, toplam = gross
    ///   quoteBuyCost(500, 100_000, 1000) = floor(500*100_000/500) + 1 = 100_001
    /// Yani `>=` kismayi tetikleseydi curve'e 100_001 yazilirdi -- 400 wei
    /// EKSIK -- ve kullaniciya 404 wei iade edilirdi.
    function test_buyExactQuoteInDoesNotClampWhenTheFillExactlyMeetsTheReserve() public {
        (BondingCurve c2, LaunchToken t2) = _launchWithProfile(1000, 100_000, 500);

        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        c2.buyExactQuoteIn{value: 101_657}(0);

        assertEq(t2.balanceOf(BUYER), 500);
        assertEq(c2.realTokenReserves(), 0);
        assertTrue(c2.complete());

        // Tam esitlikte kisma DEVREYE GIRMEZ: butcenin tamami harcanir.
        assertEq(before - BUYER.balance, 101_657, "the clamp fired at equality");
        assertEq(c2.realQuoteReserves(), 100_401, "the clamp fired at equality");
        assertEq(address(c2).balance, 100_401);
        assertEq(escrow.owed(TREASURY), 954);
        assertEq(escrow.owed(CREATOR), 302);
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
        vm.expectRevert(BondingCurve.ZeroQuoteIn.selector);
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
    /// DIKKAT -- turetme testin ICINDE BULUNDUGU duruma gore yapilmistir,
    /// taze curve'e gore DEGIL. Satici once 1_000_000e18 alir, dolayisiyla
    ///   Vq = 4_296_003_731_343_283_582_090, Vt = 1_072_000_000e18
    /// ve proceeds = floor(a * Vq / (Vt + a)):
    ///   a =   250_000 -> 1   ucretler 1 + 1 = 2  -> reddedilir
    ///   a =   250_001 -> 1   ucretler 1 + 1 = 2  -> reddedilir
    ///   a =   500_001 -> 2   ucretler 1 + 1 = 2  -> reddedilir
    ///   a =   748_602 -> 2   ucretler 1 + 1 = 2  -> reddedilir  (SON red)
    ///   a =   748_603 -> 3   ucretler 1 + 1 = 2  -> net 1, GECER (ILK kabul)
    /// (Ilk surumun yorumu TAZE curve icin turetilmisti ve `a = 250_000 -> 0`,
    /// sinir `750_001` diyordu; ikisi de bu durumda yanlisti.)
    ///
    /// KABUL EDEN TARAF DA SABITLENIYOR. Yalnizca reddi test etmek, korumayi
    /// asiri sikilastiran mutasyonlari (`proceeds <= 3 * ucretler` gibi)
    /// hayatta birakir -- olculdu.
    function test_sellRevertsWhenProceedsWouldBeZero() public {
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 10e18}(1_000_000e18, type(uint256).max);
        vm.prank(BUYER);
        token.approve(address(curve), type(uint256).max);

        uint256[4] memory dust = [uint256(250_000), 250_001, 500_001, 748_602];
        for (uint256 i = 0; i < dust.length; ++i) {
            vm.prank(BUYER);
            vm.expectRevert(BondingCurve.ProceedsTooSmall.selector);
            curve.sellExactTokensIn(dust[i], 0);
        }

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.ZeroTokensIn.selector);
        curve.sellExactTokensIn(0, 0);

        // Sinirin bir uzeri KABUL EDILIR ve saticiya tam 1 wei oder.
        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        curve.sellExactTokensIn(748_603, 0);
        assertEq(BUYER.balance - before, 1, "the smallest viable sell was rejected or mispaid");
        assertEq(escrow.totalOwed(), 38_035_447_761_194_030 + 12_011_194_029_850_747 + 2);
    }

    /// Satis odemesinin BASARISIZLIGI da yutulmaz. `RefundFailed`'in satis
    /// tarafindaki ikizi; ikizi olmadan `PayoutFailed` korumasini silen
    /// mutant hayatta kaliyordu (olculdu: 37/37 yesil). Yutulsaydi satici
    /// tokenlerini verir, iki ucret parcasi escrow'a gider, defter borclanir
    /// ve `netOut` curve'de mahsur kalirdi -- `balance > realQuoteReserves`
    /// kalici olarak bozulurdu.
    function test_sellRevertsWhenThePayoutCannotBeDelivered() public {
        RejectingSeller s = new RejectingSeller(curve, token);
        vm.deal(address(s), 100e18);
        s.buy(1_000_000e18, 10e18);

        uint256 balBefore = address(curve).balance;
        uint256 owedBefore = escrow.totalOwed();

        vm.expectRevert(BondingCurve.PayoutFailed.selector);
        s.sell(500_000e18);

        // Islemin tamami geri alindi: para, defter ve tokenler yerinde.
        assertEq(address(curve).balance, balBefore);
        assertEq(address(curve).balance, curve.realQuoteReserves());
        assertEq(escrow.totalOwed(), owedBefore);
        assertEq(token.balanceOf(address(s)), 1_000_000e18);
        assertEq(curve.realTokenReserves(), S - 1_000_000e18);
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

        // Ve islem tam olarak creator payi kadar ucuzdur. Bu, iki YEREL
        // literalin toplamiyla degil, creator'LU curve'e yapilan ayni alimin
        // gercek ucretiyle olculur -- yoksa iddia hicbir mutasyon altinda
        // dusemezdi.
        uint256 spentWithoutCreator = before - BUYER.balance;
        assertEq(spentWithoutCreator, cost + protocolFee);

        uint256 beforeWithCreator = BUYER.balance;
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 10e18}(1_000_000e18, type(uint256).max);
        uint256 spentWithCreator = beforeWithCreator - BUYER.balance;

        assertEq(spentWithCreator - spentWithoutCreator, 12_011_194_029_850_747, "the delta is not exactly 30 bps");
        assertEq(escrow.owed(TREASURY), escrow2.owed(TREASURY), "the protocol share moved with the creator share");
    }

    /// UCUNCU CANLI YOL. Ayni ozellik `buyExactTokensOut` ve
    /// `sellExactTokensIn` uzerinde testliydi, `buyExactQuoteIn` uzerinde
    /// DEGILDI -- ve o yolda dusmesi digerlerinden daha kotu: `creatorBps`
    /// ternary'si dustugunde `correctedNetQuoteIn` sifir olmayan bir creator
    /// payi dondurur, `deposit{value: creatorFee}(address(0))` cagrilir ve
    /// `FeeEscrow` `ZeroRecipient()` ile revert eder, yani sifir-creator'lu
    /// bir curve'de HER exact-quote-in alimi sonsuza kadar kirilir.
    ///
    /// Elle turetilmis, creator sifir oldugu icin toplam bps = 95 (30 DEGIL):
    ///   net = floor(1e18 * 10_000 / 10_095)  = 990_589_400_693_412_580
    ///   protocolFee = ceil(net * 95 / 10_000) =   9_410_599_306_587_420
    ///   creatorFee  = ceil(net *  0 / 10_000) =                       0
    ///   990_589_400_693_412_580 + 9_410_599_306_587_420 = 1e18 = gross
    ///   -> tasma yok, duzeltme yok, iade yok
    function test_creatorFeeIsSkippedOnTheExactQuoteInPathToo() public {
        FeeEscrow escrow2 = new FeeEscrow();
        (BondingCurve c2, LaunchToken t2) = _launch(address(0), escrow2);

        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        c2.buyExactQuoteIn{value: 1e18}(0);

        assertGt(t2.balanceOf(BUYER), 0);
        assertEq(escrow2.owed(address(0)), 0);
        assertEq(escrow2.totalOwed(), escrow2.owed(TREASURY), "creator share was folded into the protocol share");
        assertEq(c2.realQuoteReserves(), 990_589_400_693_412_580);
        assertEq(escrow2.owed(TREASURY), 9_410_599_306_587_420);
        assertEq(before - BUYER.balance, 1e18);
    }

    /// Ayni yolun KISILAN dali. Kisma exact-out sozlesmesine dusuyor, yani
    /// creator atlanmasinin orada da gecerli olmasi gerekir.
    ///   cost = floor(S * V / (T - S)) + 1  = 12_161_433_369_060_378_706_681
    ///   protocolFee = ceil(cost * 95 / 1e4) =   115_533_617_006_073_597_714
    ///   creatorFee                          =                             0
    function test_creatorFeeIsSkippedOnAClampedExactQuoteInToo() public {
        FeeEscrow escrow2 = new FeeEscrow();
        (BondingCurve c2, LaunchToken t2) = _launch(address(0), escrow2);

        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        c2.buyExactQuoteIn{value: 100_000e18}(0);

        assertEq(t2.balanceOf(BUYER), S);
        assertTrue(c2.complete());
        assertEq(escrow2.owed(address(0)), 0);
        assertEq(escrow2.totalOwed(), escrow2.owed(TREASURY));
        assertEq(c2.realQuoteReserves(), 12_161_433_369_060_378_706_681);
        assertEq(escrow2.owed(TREASURY), 115_533_617_006_073_597_714);
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

    /// FACTORY'NIN DEFTER YOKLAMASININ ENGELLEDIGI TERMINAL DURUM, OLCULEREK.
    ///
    /// `EscrowHasNoCode` bir adres SEKLINI eler; gitmek istedigi durumu degil.
    /// Kodu OLAN ama defter olmayan bir escrow ile curve kurulur, `bind`
    /// basarir, arzin %100'u curve'e girer -- ve HER ticaret giris noktasi
    /// sonsuza kadar revert eder, cunku her islem
    /// `IFeeEscrow(escrow).deposit{value: ...}` cagirir. Curve'un cikis yolu
    /// yoktur: tamamlanamaz, dolayisiyla mezun da olamaz.
    ///
    /// Bu test o durumu CURVE seviyesinde gosterir (bu dosyada factory rolunu
    /// test kontrati oynar, yani yoklama yoktur); `LaunchFactory.t.sol`
    /// yoklamanin ayni adresi deploy aninda reddettigini gosterir. Ikisi
    /// birlikte "koruma neyi engelliyor" sorusunu cevaplar -- yalnizca ikincisi
    /// yazilsaydi korumanin bedeli olculmus, DEGERI olculmemis olurdu.
    function test_aCodedButWrongTypeEscrowStrandsTheWholeSupplyInACurveWithNoExit() public {
        NotALedgerEscrow wrong = new NotALedgerEscrow();
        BondingCurve stuck = new BondingCurve(CREATOR, address(wrong), T, V, S);
        LaunchToken t = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(stuck), bytes32(0));
        stuck.bind(address(t));

        // Kurulum SORUNSUZ gorunur.
        assertEq(stuck.token(), address(t));
        assertEq(t.balanceOf(address(stuck)), N, "arzin tamami curve'de");

        // ...ve UC GIRIS NOKTASININ UCU DE sonsuza kadar reddeder.
        vm.deal(BUYER, 1_000e18);
        vm.prank(BUYER);
        (bool ok1,) = address(stuck).call{value: 10e18}(
            abi.encodeWithSelector(BondingCurve.buyExactTokensOut.selector, 1e18, type(uint256).max)
        );
        assertFalse(ok1, "buyExactTokensOut kodsuz-olmayan yanlis escrow ile gecti");

        vm.prank(BUYER);
        (bool ok2,) =
            address(stuck).call{value: 10e18}(abi.encodeWithSelector(BondingCurve.buyExactQuoteIn.selector, uint256(0)));
        assertFalse(ok2, "buyExactQuoteIn gecti");

        // Satis yolu da: once token gerekir, ama alim yapilamadigi icin kimsede
        // token yoktur -- yani satis yolu ULASILAMAZ, curve olu dogmustur.
        assertEq(t.balanceOf(BUYER), 0, "hicbir alim gerceklesemedi");
        assertEq(stuck.realTokenReserves(), S, "rezerv hic kipirdamadi");
        assertFalse(stuck.complete(), "curve TAMAMLANAMAZ");

        // Mint'in %100'u cikisi olmayan bir curve'de.
        assertEq(t.balanceOf(address(stuck)), N);
        assertEq(t.totalSupply(), N);
    }

    // ---------------------------------------------------------------
    // Graduation
    // ---------------------------------------------------------------

    /// Uretim profilinde tam-cikisla tamamlanan bir curve'un TAM degerleri.
    /// Elle turetilmis (`CurveMath` cagrilmadan): bkz.
    /// `test_completeFlipsInsideTheBuyThatDrainsRealTokenReserves`.
    uint256 internal constant R_AFTER_EXACT_OUT_COMPLETION = 12_161_433_369_060_378_706_681;
    uint256 internal constant D_POOL_SEED = 206_886_011_183_597_390_493_942_218;
    uint256 internal constant RESIDUE_AFTER_GRADUATION = 13_988_816_402_609_506_057_782;

    function _completeCurve() internal {
        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        assertTrue(curve.complete(), "curve tamamlanmadi");
        assertEq(curve.realQuoteReserves(), R_AFTER_EXACT_OUT_COMPLETION);
    }

    /// R-1. `graduated` `complete` ILE AYNI SLOT'ta ve ONDAN SONRA gelir.
    ///
    /// Olcum artifact'tan degil ZINCIRDEN yapilir, ve bu daha guclu: slot 5
    /// ham olarak okunur, yani hem PAKETLENDIGI hem de OFFSET'LERIN SIRASI
    /// dogrulanir. `graduated` once declare edilseydi ayni bayraklar
    /// `0x0100`/`0x0101` verirdi; ayri bir slota dusseydi slot 5 tamamlanmadan
    /// sonra da `0x01` kalir ve slot 6 `0x01` olurdu.
    ///
    /// Deploy edildikten sonra bu duzen her curve icin sonsuza kadar sabittir.
    function test_graduatedPacksIntoCompletesSlotAndComesAfterIt() public {
        bytes32 slot5 = vm.load(address(curve), bytes32(uint256(5)));
        assertEq(slot5, bytes32(0), "baslangicta iki bayrak da kapali");

        _completeCurve();
        assertEq(vm.load(address(curve), bytes32(uint256(5))), bytes32(uint256(0x01)), "complete offset 0 olmali");

        PoolSeeder seeder = new PoolSeeder();
        graduationTarget = address(seeder);
        seeder.pull(curve);

        assertEq(vm.load(address(curve), bytes32(uint256(5))), bytes32(uint256(0x0101)), "graduated offset 1'de olmali");
        assertEq(vm.load(address(curve), bytes32(uint256(6))), bytes32(0), "graduated yeni bir slot aldi");
    }

    /// R-6. Tamamlanmamis bir curve MEZUN EDILEMEZ. Korumanin silinmesi
    /// `realQuoteReserves`i satis ortasinda disari odetir, `graduated` latch
    /// eder ve kalan her alici hicbir satisi karsilayamayan bir curve'de islem
    /// yapar -- ve hicbir odeme gucu invariant'i bunu goremez, cunku curve
    /// SONRASINDA gercekten oder duruma dusmez; YALAN SOYLEYEN sey
    /// `realQuoteReserves`tir.
    function test_graduateRevertsBeforeCompletion() public {
        PoolSeeder seeder = new PoolSeeder();
        graduationTarget = address(seeder);

        // Once hic islem olmadan.
        vm.expectRevert(BondingCurve.NotComplete.selector);
        seeder.pull(curve);

        // Sonra satis arzinin bir kismi satildiktan sonra: koruma hala
        // reddeder, ve reddetmesi `NotComplete` ILE olur.
        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 1_000e18}(1_000_000e18, type(uint256).max);
        assertGt(curve.realQuoteReserves(), 0);

        vm.expectRevert(BondingCurve.NotComplete.selector);
        seeder.pull(curve);
        assertFalse(curve.graduated());
        assertEq(address(curve).balance, curve.realQuoteReserves());
    }

    /// `GraduationTargetUnset` CAGIRAN KONTROLUNDEN ONCE gelir, ve bu SIRA
    /// olculebilir: hedef atanmamisken cagiran KIM OLURSA OLSUN gordugu hata
    /// budur. Sira ters olsaydi bu hata yalnizca `msg.sender == address(0)`
    /// iken ulasilabilir olurdu -- yani pratikte hic.
    function test_graduateRevertsWhenTheTargetIsUnsetWhoeverCalls() public {
        _completeCurve();
        assertEq(graduationTarget, address(0), "on kosul: hedef atanmamis");

        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        curve.graduate();

        PoolSeeder seeder = new PoolSeeder();
        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        seeder.pull(curve);

        // Ve bu, Faz 2 var olmadigi surece herkesin gorecegi hatadir.
        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        curve.graduate();
    }

    /// R-4. Cozulmus hedef DISINDA kimse cagiramaz -- ve bu IKI TANIKLA
    /// olculur: bir EOA ve KODU OLAN ikinci bir kontrat. Ikincisi
    /// `msg.sender.code.length != 0` seklindeki mutanti oldurur; yalnizca EOA
    /// taniginda o mutant HAYATTA KALIRDI.
    function test_graduateRevertsForEveryCallerButTheResolvedTarget() public {
        _completeCurve();
        PoolSeeder theTarget = new PoolSeeder();
        PoolSeeder anotherContract = new PoolSeeder();
        graduationTarget = address(theTarget);

        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.NotGraduationTarget.selector);
        curve.graduate();

        vm.expectRevert(BondingCurve.NotGraduationTarget.selector);
        anotherContract.pull(curve);

        // Factory'nin kendisi de cagiramaz: yetki `bind`ten AYRIDIR.
        vm.expectRevert(BondingCurve.NotGraduationTarget.selector);
        curve.graduate();

        assertFalse(curve.graduated());

        // Hedef gecer.
        theTarget.pull(curve);
        assertTrue(curve.graduated());
    }

    /// MUTLU YOL. Donen degerler, olay, iki bakiye, ve MUTASYONA UGRAMAYAN
    /// rezervler.
    ///
    /// Rezervlerin sifirlanmamasi bilincli (tasarim 7.2 madde 7): tamamlanma
    /// sonrasi her giris noktasi zaten revert eder, dolayisiyla bayat bir okuma
    /// ulasilamazdir; buna karsilik `realQuoteReserves` graduation sonrasi bir
    /// dogrulayicinin havuzla karsilastirabilecegi TEK zincir kaydidir. Ayni
    /// sebeple kapanis fiyati da hala okunabilir kalir:
    /// `virtualQuoteReserves == V + R` ve `virtualTokenReserves == T - S`.
    function test_graduatePaysDFromTheImmutableAndRFromTheLedger() public {
        _completeCurve();
        PoolSeeder seeder = new PoolSeeder();
        graduationTarget = address(seeder);

        uint256 escrowOwedBefore = escrow.totalOwed();

        vm.expectEmit(true, true, false, true, address(curve));
        emit BondingCurve.Graduated(address(token), address(seeder), D_POOL_SEED, R_AFTER_EXACT_OUT_COMPLETION);
        (uint256 base, uint256 quote) = seeder.pull(curve);

        assertEq(base, D_POOL_SEED, "baz bacagi immutable `D` olmali");
        assertEq(quote, R_AFTER_EXACT_OUT_COMPLETION, "quote bacagi defterdeki `R` olmali");
        assertEq(base, curve.poolSeedSupply());

        assertTrue(curve.graduated());
        assertEq(token.balanceOf(address(seeder)), D_POOL_SEED);
        assertEq(address(seeder).balance, R_AFTER_EXACT_OUT_COMPLETION);
        assertEq(address(curve).balance, 0, "curve butun raise'i odedi");
        assertEq(token.balanceOf(address(curve)), RESIDUE_AFTER_GRADUATION, "artik `N - S - D` olmali");

        // DEFTER MUTASYONA UGRAMAZ.
        assertEq(curve.realQuoteReserves(), R_AFTER_EXACT_OUT_COMPLETION, "realQuoteReserves sifirlanmis");
        assertEq(curve.realTokenReserves(), 0);
        assertEq(curve.virtualQuoteReserves(), V + R_AFTER_EXACT_OUT_COMPLETION, "V + R");
        assertEq(curve.virtualTokenReserves(), T - S, "T - S");

        // D7: graduation UCRET ALMAZ. Escrow'un toplam alacagi degismez.
        assertEq(escrow.totalOwed(), escrowOwedBefore, "graduation escrow'a bir sey yatirdi");
    }

    /// `graduate()` `payable` DEGILDIR. Yuzey testi mutabiliteyi ABI'de pinler;
    /// bu satir onu DAVRANISSAL olarak da kapatir. `payable` olsaydi gonderilen
    /// deger curve'de kalir ve bir daha CIKAMAZDI.
    function test_graduateIsNotPayable() public {
        _completeCurve();
        PoolSeeder seeder = new PoolSeeder();
        graduationTarget = address(seeder);

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(curve).call{value: 1 wei}(abi.encodeWithSelector(BondingCurve.graduate.selector));
        assertFalse(ok, "graduate deger kabul etti");
        assertFalse(curve.graduated());
    }

    /// R-2. Ikinci cagri REVERT eder (pump.fun'in sessiz no-op'unun aksine).
    function test_theSecondGraduateRevertsAlreadyGraduated() public {
        _completeCurve();
        PoolSeeder seeder = new PoolSeeder();
        graduationTarget = address(seeder);
        seeder.pull(curve);

        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        seeder.pull(curve);

        // Hedef degistirilse bile ikinci bir odeme YOKTUR.
        PoolSeeder second = new PoolSeeder();
        graduationTarget = address(second);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        second.pull(curve);

        assertEq(token.balanceOf(address(second)), 0);
        assertEq(address(second).balance, 0);
        assertEq(seeder.pulls(), 1);
    }

    /// R-2 + R-8. Odeme cercevesinden yapilan GERI GIRIS `AlreadyGraduated`
    /// alir VE -- tasiyici kisim -- hedef TAM OLARAK BIR KEZ `D` ve `R` alir.
    /// Bayragi dis cagrilarin ARKASINA almak (pump.fun'in Solana sirasi) ic
    /// cagriyi BASARILI kilar ve hedef `2D`/`2R` alirdi; yalnizca "ikinci cagri
    /// dustu" diyen bir iddia o mutanti YASATIR.
    ///
    /// Ayni cerceveden UC TICARET GIRIS NOKTASI da yoklanir ve her biri
    /// `CurveComplete()` selector'u ile dusmelidir (R-13). "Revert etti" demek
    /// YETMEZ: alim yollarinda `complete` korumasini silmek davranisi
    /// degistirmez, cunku cagri `NotEnoughTokensToBuy` ya da kismadan sonra
    /// `CurveMath.ZeroAmount`a duser.
    function test_reentrantGraduateGetsAlreadyGraduatedAndEveryTradeGetsCurveComplete() public {
        _completeCurve();
        ProbingSeeder seeder = new ProbingSeeder();
        graduationTarget = address(seeder);

        seeder.pull(curve);

        assertTrue(seeder.probed(), "odeme cercevesi hic acilmadi");
        assertEq(seeder.seen(0), BondingCurve.AlreadyGraduated.selector, "ic graduate");
        assertEq(seeder.seen(1), BondingCurve.CurveComplete.selector, "buyExactTokensOut");
        assertEq(seeder.seen(2), BondingCurve.CurveComplete.selector, "buyExactQuoteIn");
        assertEq(seeder.seen(3), BondingCurve.CurveComplete.selector, "sellExactTokensIn");
        assertEq(seeder.seen(4), BondingCurve.NotFactory.selector, "bind");

        // TAM OLARAK BIR KEZ.
        assertEq(token.balanceOf(address(seeder)), D_POOL_SEED, "baz bacagi bir kereden fazla odendi");
        assertEq(address(seeder).balance, R_AFTER_EXACT_OUT_COMPLETION, "quote bacagi bir kereden fazla odendi");
        assertEq(address(curve).balance, 0);
        assertEq(token.balanceOf(address(curve)), RESIDUE_AFTER_GRADUATION);

        // Ve zincirin dorduncu halkasi, FACTORY'NIN kendi cercevesinden:
        // `graduated => bound`, dolayisiyla `bind` de kapalidir.
        LaunchToken other = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", CREATOR, address(curve), bytes32(0));
        vm.expectRevert(BondingCurve.AlreadyBound.selector);
        curve.bind(address(other));
    }

    /// CAPRAZ CURVE PENCERESI ULASILABILIRDIR. Tasarimin reentrancy bolumu
    /// yalnizca AYNI curve hakkinda yazilmisti; Faz 2 yazarinin carpacagi vaka
    /// budur ve Faz 2 yukumlulugu (2)'nin somut icerigidir.
    function test_crossCurveGraduationInsideThePayoutIsReachable() public {
        (BondingCurve curveB, LaunchToken tokenB) = _launch(CREATOR, escrow);

        _completeCurve();
        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        curveB.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        assertTrue(curveB.complete());

        CrossCurveSeeder seeder = new CrossCurveSeeder();
        seeder.setOther(curveB);
        graduationTarget = address(seeder);

        seeder.pull(curve);

        assertEq(seeder.innerFailure(), bytes4(0), "ic graduate basarisiz oldu");
        assertTrue(curve.graduated());
        assertTrue(curveB.graduated(), "capraz curve mezun olmadi");
        assertEq(address(seeder).balance, 2 * R_AFTER_EXACT_OUT_COMPLETION, "R1 + R2");
        assertEq(token.balanceOf(address(seeder)), D_POOL_SEED);
        assertEq(tokenB.balanceOf(address(seeder)), D_POOL_SEED);
    }

    /// R-9. REDDEDEN BIR HEDEF BIR LAUNCH'I STRAND EDEMEZ. Dort iddia birden:
    /// hata `GraduationPayoutFailed()`, bayrak GERI ALINMIS, token transferi
    /// GERI ALINMIS, ve -- yarinin tasiyici olani -- onarimdan sonra AYNI cagri
    /// AYNI `(D, R)`yi dondurur.
    function test_aRejectingTargetCannotStrandTheLaunchAndTheRetryPaysTheSame() public {
        _completeCurve();
        RejectingSeeder seeder = new RejectingSeeder();
        graduationTarget = address(seeder);

        vm.expectRevert(BondingCurve.GraduationPayoutFailed.selector);
        seeder.pull(curve);

        assertFalse(curve.graduated(), "bayrak reddedilen odemede latch etti");
        assertEq(address(curve).balance, R_AFTER_EXACT_OUT_COMPLETION, "curve `R`yi kaybetti");
        assertEq(curve.realQuoteReserves(), R_AFTER_EXACT_OUT_COMPLETION);
        assertEq(token.balanceOf(address(seeder)), 0, "token transferi geri alinmadi");
        assertEq(token.balanceOf(address(curve)), N - S);

        seeder.repair();
        (uint256 base, uint256 quote) = seeder.pull(curve);
        assertEq(base, D_POOL_SEED);
        assertEq(quote, R_AFTER_EXACT_OUT_COMPLETION);
        assertTrue(curve.graduated());
    }

    /// `receive()` HIC OLMAYAN hedef de fail-closed'dir. `RejectingSeeder`dan
    /// ayri bir vakadir: orada revert bir `require`dan gelir, burada
    /// cagrilacak fonksiyon yoktur. Care hedefi YENIDEN ISARETLEMEKTIR (D3).
    function test_aTargetWithNoReceiveFailsClosedAndRepointingIsTheRemedy() public {
        _completeCurve();
        NoReceiveSeeder broken = new NoReceiveSeeder();
        graduationTarget = address(broken);

        vm.expectRevert(BondingCurve.GraduationPayoutFailed.selector);
        broken.pull(curve);
        assertFalse(curve.graduated());
        assertEq(address(curve).balance, R_AFTER_EXACT_OUT_COMPLETION);

        // D3: yeniden isaretleme TEK caredir ve calisir.
        PoolSeeder good = new PoolSeeder();
        graduationTarget = address(good);
        (uint256 base, uint256 quote) = good.pull(curve);
        assertEq(base, D_POOL_SEED);
        assertEq(quote, R_AFTER_EXACT_OUT_COMPLETION);
    }

    /// R-7. BU TESTIN ADI "MIKTARLAR" DEGIL "BAGIS"TIR, ve olmasi gereken de
    /// bu: bakiye okuyan bir hal `(D, R)` yerine bakiyeleri oderdi ve
    /// BAGIS OLMADIGI SURECE ayni sonucu verirdi -- hicbir test bagis
    /// yapmadigi icin de yesil kalirdi. Tasarim ile pump.fun'in davranisi
    /// arasinda duran TEK sey budur.
    ///
    /// Bagislar Arc'ta gercektir: 6 decimal ERC-20 gorunumunden yapilan bir
    /// `transfer` native bakiyeyi artirir ve `receive()` HIC calismaz (canli
    /// olcum, `FeeEscrow` kisit (1)). `vm.deal` o kanalin yerine gecen bir
    /// vekildir ve fork'ta yeniden olculmesi gerekir.
    function test_donationsDoNotChangeWhatGraduationPays() public {
        _completeCurve();

        // NATIVE BAGIS: bakiye defterin 7 ether uzerine cikar.
        vm.deal(address(curve), address(curve).balance + 7 ether);
        // TOKEN BAGISI: alici tokenlerini curve'e geri gonderir.
        vm.prank(BUYER);
        assertTrue(token.transfer(address(curve), 1_000e18));

        assertEq(address(curve).balance, R_AFTER_EXACT_OUT_COMPLETION + 7 ether, "bagis kanali kurulmadi");
        assertEq(token.balanceOf(address(curve)), N - S + 1_000e18);

        PoolSeeder seeder = new PoolSeeder();
        graduationTarget = address(seeder);
        (uint256 base, uint256 quote) = seeder.pull(curve);

        assertEq(base, D_POOL_SEED, "baz bacagi bakiyeden okundu");
        assertEq(quote, R_AFTER_EXACT_OUT_COMPLETION, "quote bacagi bakiyeden okundu");

        // BAGISLAR CURVE'DE KALIR, SONSUZA KADAR.
        assertEq(address(curve).balance, 7 ether);
        assertEq(token.balanceOf(address(curve)), RESIDUE_AFTER_GRADUATION + 1_000e18);
    }

    /// D5'in GEREKCESI DUZELTILDI: cagiran zorunlu olarak bir kontrat DEGILDIR.
    /// Hedef bir EOA olabilir, `graduate()`i dogrudan cagirir ve `R` ile `D`yi
    /// alir. Bu bugun onemlidir: Arc'in HICBIR yerinde Uniswap V4 yoktur, yani
    /// ilk graduation'lar tam olarak bu yolla yapilacaktir.
    ///
    /// D5'in ayakta kalan gerekcesi ise sudur: bes basarisizlik modunun BESI DE
    /// ayri selector tasir, dolayisiyla hicbir cagiran -- EOA da olsa --
    /// "zaten mezun oldu"yu baska bir basarisizlikla karistiramaz.
    function test_anEoaTargetCanGraduateDirectly() public {
        _completeCurve();
        graduationTarget = ALICE;

        uint256 balanceBefore = ALICE.balance;
        vm.prank(ALICE);
        (uint256 base, uint256 quote) = curve.graduate();

        assertEq(base, D_POOL_SEED);
        assertEq(quote, R_AFTER_EXACT_OUT_COMPLETION);
        assertEq(ALICE.balance, balanceBefore + R_AFTER_EXACT_OUT_COMPLETION, "EOA hedef `R`yi almadi");
        assertEq(token.balanceOf(ALICE), D_POOL_SEED);
        assertTrue(curve.graduated());

        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.graduate();
    }

    /// R-5. HEDEF OKUMASI BIR STATICCALL'DUR -- kaynak kodda `view` YAZILI
    /// OLDUGU icin degil, YAZIMIN REVERT ETTIGI OLCULDUGU icin.
    ///
    /// KONTROL GRUBU ZORUNLUDUR: ayni fonksiyon statik OLMAYAN bir cagriyla
    /// sayaci 1'e cikarir. O olmadan bu test "herhangi bir sebeple revert eden"
    /// bir kontratta da gecerdi ve hicbir sey kanitlamazdi.
    ///
    /// Arayuzu non-`view` yapmak src'de TEK KELIMELIK bir degisikliktir,
    /// GORUNUR hicbir etkisi yoktur ve reentrancy kapanisini sessizce kaldirir.
    function test_theGraduationTargetReadIsAStaticcallAndTheWriteReverts() public {
        MeasuringFactory f = new MeasuringFactory(TREASURY, T, V, S);
        BondingCurve c = f.curve();

        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        c.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        assertTrue(c.complete());

        f.setTarget(address(f));
        f.armTargetWrite();

        (bool ok,) = address(f).call(abi.encodeWithSelector(MeasuringFactory.pull.selector));
        assertFalse(ok, "SSTORE yapan bir `graduationTarget()` cagrisi gecti");
        assertEq(f.writes(), 0, "yazim STATICCALL altinda gerceklesti");
        assertFalse(c.graduated());

        // KONTROL: ayni fonksiyon, statik OLMAYAN cagri.
        f.graduationTarget();
        assertEq(f.writes(), 1, "kontrol grubu yazamadi -- test hicbir sey olcmuyor");
    }

    /// F1'IN AYNI OLCUMU, YATIRIM ANINDAKI OKUMA ICIN. `protocolTreasury()`
    /// artik ticaretin ORTASINDA factory'ye gider; `view` orada da TASIYICIDIR
    /// ve hucre bu depoda daha once YURUNMEMISTIR.
    ///
    /// Kapsam farki tasiyici: hedef okumasi yalnizca `graduate()`te, treasury
    /// okumasi UC TICARET GIRIS NOKTASININ UCUNDE de vardir (satista ayrica).
    /// Bu yuzden iki alim yolu ve satis yolu AYRI AYRI olculur.
    function test_theTreasuryReadIsAStaticcallOnEveryTradingPath() public {
        MeasuringFactory f = new MeasuringFactory(TREASURY, T, V, S);
        BondingCurve c = f.curve();
        LaunchToken tk = f.token();

        // KONTROL GRUBU, GIRIS NOKTASI BASINA: silahsizken UCU DE BASARIR.
        // Bu olmadan asagidaki uc basarisizlik "SSTORE yuzunden" degil
        // "herhangi bir sebeple" olabilirdi ve test hicbir sey olcmezdi.
        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        c.buyExactTokensOut{value: 1_000e18}(1_000_000e18, type(uint256).max);
        vm.prank(BUYER);
        c.buyExactQuoteIn{value: 1_000e18}(0);
        vm.prank(BUYER);
        tk.approve(address(c), type(uint256).max);
        vm.prank(BUYER);
        c.sellExactTokensIn(1e18, 0);

        f.armTreasuryWrite();

        vm.prank(BUYER);
        (bool ok1,) = address(c).call{value: 10e18}(
            abi.encodeWithSelector(BondingCurve.buyExactTokensOut.selector, 1e18, type(uint256).max)
        );
        assertFalse(ok1, "buyExactTokensOut: SSTORE yapan treasury okumasi gecti");

        vm.prank(BUYER);
        (bool ok2,) =
            address(c).call{value: 10e18}(abi.encodeWithSelector(BondingCurve.buyExactQuoteIn.selector, uint256(0)));
        assertFalse(ok2, "buyExactQuoteIn: SSTORE yapan treasury okumasi gecti");

        vm.prank(BUYER);
        (bool ok3,) = address(c).call(abi.encodeWithSelector(BondingCurve.sellExactTokensIn.selector, 1e18, uint256(0)));
        assertFalse(ok3, "sellExactTokensIn: SSTORE yapan treasury okumasi gecti");

        assertEq(f.writes(), 0, "yazim STATICCALL altinda gerceklesti");

        // KONTROL.
        f.protocolTreasury();
        assertEq(f.writes(), 1, "kontrol grubu yazamadi -- test hicbir sey olcmuyor");
    }

    /// F1'IN CEKIRDEGI: ROTASYON CANLI BIR CURVE'E ULASIR.
    ///
    /// `protocolTreasury` bir immutable KOPYA olsaydi bu test yazilamazdi --
    /// ve `FeeEscrow` kisit (4)'un Faz 1c'ye biraktigi borc odenmemis kalirdi:
    /// Arc treasury'yi bloklarsa ticaret calismaya devam eder, `owed[bloklu]`
    /// buyur, `claim` revert eder ve HICBIR yol yeniden yonlendirmez.
    ///
    /// Ayrica ikinci yari: BIRIKMIS alacak TASINMAZ. `owed[eski]` eski adresin
    /// talebi olarak aynen durur.
    function test_rotatingTheTreasuryRedirectsTheFeesOfALiveCurve() public {
        address newTreasury = address(0xBEEF);

        vm.deal(BUYER, 100_000e18);
        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 100e18}(0);

        uint256 owedOld = escrow.owed(TREASURY);
        assertGt(owedOld, 0, "ilk islem eski treasury'ye yazmadi");
        assertEq(escrow.owed(newTreasury), 0);

        // ROTASYON (bu test kontrati curve'un factory'sidir).
        protocolTreasury = newTreasury;
        assertEq(curve.protocolTreasury(), newTreasury, "curve rotasyonu gormedi");

        vm.prank(BUYER);
        curve.buyExactQuoteIn{value: 100e18}(0);

        assertGt(escrow.owed(newTreasury), 0, "yeni treasury'ye yazilmadi");
        assertEq(escrow.owed(TREASURY), owedOld, "birikmis alacak tasindi");

        // UC GIRIS NOKTASININ UCU DE AYRI AYRI YURUNUR. Kaynak tarafinda iki
        // cagri yeri var (`_settleBuy` iki alim yolunca PAYLASILIR,
        // `sellExactTokensIn` kendi satirini tasir), ama "iki alim yolu ayni
        // fonksiyondan gecer" tam olarak sonradan yanlislanan turden ORTUK bir
        // gerekcedir -- bu depoda on kez olustu. Bu yuzden hucre giris noktasi
        // basina yurunur, cagri yeri basina degil.
        uint256 owedAfterQuoteIn = escrow.owed(newTreasury);
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 100e18}(1_000e18, type(uint256).max);
        assertGt(escrow.owed(newTreasury), owedAfterQuoteIn, "buyExactTokensOut rotasyonu gormedi");

        uint256 owedAfterExactOut = escrow.owed(newTreasury);
        vm.startPrank(BUYER);
        token.approve(address(curve), type(uint256).max);
        curve.sellExactTokensIn(1_000e18, 0);
        vm.stopPrank();

        assertGt(escrow.owed(newTreasury), owedAfterExactOut, "satis yolu rotasyonu gormedi");
        assertEq(escrow.owed(TREASURY), owedOld, "bir yol eski adrese yazdi");
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
