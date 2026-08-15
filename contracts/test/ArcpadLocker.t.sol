// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {ArcpadLocker} from "../src/ArcpadLocker.sol";
import {ArcpadHook} from "../src/ArcpadHook.sol";
import {GraduationMath} from "../src/libraries/GraduationMath.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {IGraduatableCurve} from "../src/interfaces/IGraduatableCurve.sol";

/// @dev Arc'in tasiyici ozelligi: TEK BAKIYE, IKI GORUNUM. `balanceOf`
///      SAKLANMAZ, native bakiyeden TURETILIR. `ArcpadHook.t.sol`daki
///      mock'un aynisi ve ayni gerekceyle: `graduate()` quote'u
///      `call{value:}` ile oder, yani ayri bir ERC-20 defteri tutan bir mock
///      locker'in quote gorunumunu SIFIR birakir ve tohumlama underflow eder.
contract UsdcMock {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => mapping(address => uint256)) public allowance;

    function balanceOf(address a) public view returns (uint256) {
        return a.balance / 1e12;
    }

    function totalSupply() external pure returns (uint256) {
        return type(uint256).max;
    }

    function mint(address to, uint256 units) external {
        _credit(to, units);
        emit Transfer(address(0), to, units);
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        return _move(msg.sender, to, a);
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        return _move(f, to, a);
    }

    function _move(address f, address t, uint256 units) private returns (bool) {
        uint256 wei_ = units * 1e12;
        require(f.balance >= wei_, "usdc: insufficient");
        VmLike(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).deal(f, f.balance - wei_);
        VmLike(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).deal(t, t.balance + wei_);
        emit Transfer(f, t, units);
        return true;
    }

    function _credit(address to, uint256 units) private {
        VmLike(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).deal(to, to.balance + units * 1e12);
    }
}

interface VmLike {
    function deal(address, uint256) external;
}

/// @dev Saldirganin KENDI `unlock`u. `PoolManager` `IUnlockCallback(msg.sender)`
///      cagirir, yani bu kontrat kilidi acabilir ama locker'in callback'ine
///      ULASAMAZ -- kendi callback'i calisir.
contract AttackerUnlocker is IUnlockCallback {
    IPoolManager public immutable pm;
    bool public ranOwnCallback;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function go(bytes calldata data) external {
        pm.unlock(data);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        ranOwnCallback = true;
        return "";
    }
}

/// @dev Kaldirma denemelerini kilidin ICINDEN yapar; aksi halde her deneme
///      `ManagerLocked` ile duserdi ve test, KILIDIN mi yoksa POZISYON
///      SAHIPLIGININ mi engelledigini AYIRT EDEMEZDI.
contract RemovalAttempt is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function tryRemove(PoolKey calldata key, int256 delta) external {
        pm.unlock(abi.encode(key, delta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, int256 delta) = abi.decode(data, (PoolKey, int256));
        pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: GraduationMath.TICK_LOWER,
                tickUpper: GraduationMath.TICK_UPPER,
                liquidityDelta: delta,
                salt: bytes32(0)
            }),
            ""
        );
        return "";
    }
}

/// @dev Bagis surucusu. `donate` `onlyWhenUnlocked`tur.
contract Donor is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function donate(PoolKey calldata key, uint256 a0, uint256 a1) external {
        pm.unlock(abi.encode(key, a0, a1));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, uint256 a0, uint256 a1) = abi.decode(data, (PoolKey, uint256, uint256));
        BalanceDelta delta = pm.donate(key, a0, a1, "");
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return "";
    }

    function _settle(Currency c, int128 amt) private {
        if (amt >= 0) return;
        uint256 owed = uint256(int256(-amt));
        pm.sync(c);
        IERC20(Currency.unwrap(c)).transfer(address(pm), owed);
        pm.settle();
    }
}

/// @dev Tohumlama bacagini dusurmek icin kullanilan NISAN HATASI. Ayri bir
///      selector olmasi TASIYICIDIR: `try`/`catch` mutanti bu hatayi YUTAR ve
///      yerine `PositionNotSeeded` kor, yani iki durum ancak IC SELECTOR
///      iddia edilirse ayrilir.
error SeedLegFailed();

/// @dev Duz bir ERC-20. `UsdcMock` BURADA KULLANILAMAZ: onun `balanceOf`u
///      NATIVE bakiyeden turer (Arc'in tek-bakiye-iki-gorunum ozelligi) ve
///      launch tokeni oyle DEGILDIR.
contract TokenMock {
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
        emit Transfer(address(0), to, a);
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        emit Transfer(msg.sender, to, a);
        return true;
    }
}

/// @dev `SeedShortfall`in ARANMASI icin. Locker'in kendi yolunu DEGIL,
///      o korumanin ustunde durdugu YUVARLAMA CIFTINI surer:
///      `GraduationMath.seedLiquidity` ASAGI yuvarlar, `Pool.modifyLiquidity`
///      YUKARI. Aradaki fark bacak basina 1 wei tasma URETEBILIR.
///      Bu, `Pool`un GERCEK yuvarlamasini kullanir -- yeniden uygulamaz.
contract SeedProbe is IUnlockCallback {
    IPoolManager public immutable pm;
    uint256 public owed0;
    uint256 public owed1;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    /// @return o0 o1 `Pool`un GERCEKTEN istedigi miktarlar.
    function measure(PoolKey calldata key, uint128 liquidity) external returns (uint256 o0, uint256 o1) {
        pm.unlock(abi.encode(key, liquidity));
        return (owed0, owed1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, uint128 liquidity) = abi.decode(data, (PoolKey, uint128));
        (BalanceDelta delta,) = pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: GraduationMath.TICK_LOWER,
                tickUpper: GraduationMath.TICK_UPPER,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        owed0 = uint256(int256(-delta.amount0()));
        owed1 = uint256(int256(-delta.amount1()));
        _settle(key.currency0, owed0);
        _settle(key.currency1, owed1);
        return "";
    }

    function _settle(Currency c, uint256 owed) private {
        if (owed == 0) return;
        pm.sync(c);
        IERC20(Currency.unwrap(c)).transfer(address(pm), owed);
        pm.settle();
    }
}

contract ArcpadLockerTest is Test {
    using StateLibrary for IPoolManager;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant ARCPAD_HOOK_FLAGS = 0x20CC;

    // TESTNET PROFILI -- canli `LaunchFactory`nin uclusu.
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;

    /// D = S*(vT0-S)/vT0. PAYDA `vT0 - S`DIR, `N - S` DEGIL.
    uint256 internal constant D = 206_886_011_183_597_390_493_942_218;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant GOVERNOR = address(0x600D);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0FFEE);
    address internal constant ATTACKER = address(0xBAD);

    IPoolManager internal pm;
    UsdcMock internal usdc;
    FeeEscrow internal escrow;
    FeeSchedule internal schedule;
    LaunchFactory internal factory;
    ArcpadHook internal hook;
    ArcpadLocker internal locker;

    function setUp() public {
        pm = IPoolManager(address(new PoolManager(address(this))));

        usdc = new UsdcMock();
        vm.etch(GraduationMath.QUOTE, address(usdc).code);
        usdc = UsdcMock(GraduationMath.QUOTE);

        escrow = new FeeEscrow();
        schedule = new FeeSchedule();
        factory = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(schedule));

        bytes memory args = abi.encode(IPoolManager(address(pm)), address(factory), address(escrow));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, ARCPAD_HOOK_FLAGS, type(ArcpadHook).creationCode, args);
        vm.prank(CREATE2_DEPLOYER);
        hook = new ArcpadHook{salt: salt}(IPoolManager(address(pm)), address(factory), address(escrow));
        require(address(hook) == hookAddr, "mined address diverged");

        locker = new ArcpadLocker(pm, address(factory), IHooks(address(hook)));

        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(locker));
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();
    }

    // ---------------------------------------------------------------
    // Yardimcilar
    // ---------------------------------------------------------------

    function _launch(string memory n) internal returns (address tk, address payable cv) {
        vm.prank(CREATOR);
        (address a, address b) = factory.launch(n, "ARC", "ipfs://x");
        return (a, payable(b));
    }

    /// TEK ALIMLA tamamla.
    function _buyOut(address payable cv) internal {
        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(cv).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);
        require(BondingCurve(cv).complete(), "curve not complete");
    }

    function _launchAndBuyOut(string memory n) internal returns (address tk, address payable cv) {
        (tk, cv) = _launch(n);
        _buyOut(cv);
    }

    function _keyOf(address tk) internal view returns (PoolKey memory k, bool baseIsCurrency0) {
        (k, baseIsCurrency0) = GraduationMath.poolKey(tk, IHooks(address(hook)));
    }

    function _liquidityOfToken(address tk) internal view returns (uint128) {
        (PoolKey memory k,) = _keyOf(tk);
        return _liquidityOf(k);
    }

    function _liquidityOf(PoolKey memory k) internal view returns (uint128 l) {
        (l,,) = pm.getPositionInfo(
            k.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
    }

    // ---------------------------------------------------------------
    // Mutlu yol, IKI SIRALAMADA
    // ---------------------------------------------------------------

    /// TOKEN USDC'NIN USTUNDE (~%79 hal): USDC = currency0.
    function test_graduationSeedsThePoolAtTheCurveClosingPrice() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        (PoolKey memory key, bool baseIsCurrency0) = _keyOf(token);
        assertFalse(baseIsCurrency0, "bu test USDC = currency0 halini olcer");

        locker.graduate(curve);

        (uint160 sqrtPrice,,,) = pm.getSlot0(key.toId());
        assertEq(sqrtPrice, 326777965518061118072680912817470217035);
    }

    /// ~%21 hal: token USDC'nin ALTINDA, yani token = currency0. Aday
    /// metadata TARANIR; DONGU SINIRLI ve BULAMAZSA TEST BASARISIZ OLUR --
    /// aksi halde test hicbir sey kanitlamadan gecerdi.
    function test_graduationWorksWhenTheTokenSortsBelowUsdc() public {
        string memory name;
        bool found;
        for (uint256 i = 0; i < 64; ++i) {
            name = string.concat("ARC", vm.toString(i));
            (address predicted,) = factory.predictAddresses(CREATOR, name, "ARC", "ipfs://x", factory.launchCount());
            if (predicted < GraduationMath.QUOTE) {
                found = true;
                break;
            }
        }
        assertTrue(found, "64 denemede USDC'nin altina dusen aday yok -- test hicbir sey kanitlamiyor");

        (address token, address payable curve) = _launchAndBuyOut(name);
        (PoolKey memory key, bool baseIsCurrency0) = _keyOf(token);
        assertTrue(baseIsCurrency0, "aday yine de USDC'nin ustunde -- tarama yanlis");

        locker.graduate(curve);

        (uint160 sqrtPrice,,,) = pm.getSlot0(key.toId());
        assertEq(sqrtPrice, 19209072819323074681);
    }

    /// %21 BIR OLCUMDUR, TAHMIN DEGIL: 0x36/0x100 = %21,09375. Test yalnizca
    /// IKI SIRALAMANIN DA gerceklestigini iddia eder -- kesin sayi keccak'a
    /// baglidir ve kirilgan bir test olurdu.
    function test_bothOrderingsOccurAcrossManyLaunches() public view {
        uint256 below;
        for (uint256 i = 0; i < 512; ++i) {
            (address predicted,) =
                factory.predictAddresses(CREATOR, string.concat("N", vm.toString(i)), "ARC", "ipfs://x", i);
            if (predicted < GraduationMath.QUOTE) ++below;
        }
        assertGt(below, 0, "hicbir launch USDC'nin altina dusmedi");
        assertLt(below, 512, "her launch USDC'nin altina dustu");
        // Beklenen ~108 (512 * 0,2109). Genis bant BILINCLI: kesin sayi
        // keccak'a baglidir.
        assertGt(below, 60);
        assertLt(below, 160);
    }

    /// TOHUMLANAN MIKTARLAR VE TOZ, TAM OLARAK.
    function test_theSeededAmountsAndTheDustAreExact() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        (PoolKey memory key,) = _keyOf(token);

        vm.recordLogs();
        locker.graduate(curve);

        (uint128 liquidity, uint256 baseSeeded, uint256 quoteSeeded) = _readPoolSeeded(vm.getRecordedLogs());
        assertEq(liquidity, 50160046734639668, "L");
        assertEq(baseSeeded, D, "baseSeeded curve'un poolSeedSupply'i degil");
        assertEq(quoteSeeded, 12_161_433_369_060_378_707, "quoteSeeded curve'un R'si degil");
        assertEq(_liquidityOf(key), liquidity, "zincirdeki pozisyon olayla uyusmuyor");

        // TOZ: locker'da kalan base. `getLiquidityForAmounts` ASAGI yuvarlar,
        // dolayisiyla tohumlanan base tam `D` DEGILDIR.
        assertEq(IERC20(token).balanceOf(address(locker)), 6_231_944_955_121_217_298, "base tozu");
    }

    /// QUOTE ARTIGI: `R - R6*1e12` wei locker'da KALICI kalir -- 1 ERC-20
    /// biriminin ALTINDADIR ve locker'in native gonderme yolu YOKTUR.
    function test_theSubUnitQuoteResidueStaysInTheLockerForever() public {
        (, address payable curve) = _launchAndBuyOut("Arc");
        locker.graduate(curve);
        assertEq(address(locker).balance, 369_060_378_707);
    }

    /// ...VE ARTIK BIRIKIR AMA SONRAKI BIR LAUNCH'A ASLA SIZAMAZ, cunku
    /// locker kendi bakiyesini HIC OKUMAZ. Ikinci graduation'in tohumu
    /// birinciyle BIREBIR ayni olmak zorundadir.
    function test_theResidueAccumulatesAndNeverLeaksIntoALaterLaunch() public {
        (, address payable c1) = _launchAndBuyOut("Arc");
        vm.recordLogs();
        locker.graduate(c1);
        (uint128 l1,, uint256 q1) = _readPoolSeeded(vm.getRecordedLogs());

        (, address payable c2) = _launchAndBuyOut("Arc2");
        vm.recordLogs();
        locker.graduate(c2);
        (uint128 l2,, uint256 q2) = _readPoolSeeded(vm.getRecordedLogs());

        assertEq(q2, q1, "ikinci graduation farkli quote tohumladi");
        assertEq(l2, l1, "ikinci havuzun likiditesi farkli");
        assertEq(address(locker).balance, 2 * 369_060_378_707, "artik birikmedi");
    }

    // ---------------------------------------------------------------
    // Invariant 6 -- ZINCIRDEN GERI OKUMA
    // ---------------------------------------------------------------

    /// YEREL BIR DEGISKENDEN DEGIL, `PoolManager`IN KENDI DURUMUNDAN.
    /// Oldurdugu mutant: "dogru hesapladi, `initialize`a BASKASINI gecirdi".
    function test_theOnChainSqrtPriceEqualsTheValueDerivedFromTheCurvesOwnGetters() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        uint256 vq = IGraduatableCurve(curve).virtualQuoteReserves();
        uint256 vt = IGraduatableCurve(curve).virtualTokenReserves();

        locker.graduate(curve);

        (PoolKey memory key, bool baseIsCurrency0) = _keyOf(token);
        (uint160 onChain,,,) = pm.getSlot0(key.toId());
        assertEq(onChain, GraduationMath.sqrtPriceX96(vq, vt, baseIsCurrency0));

        // ...ve `graduate()` sanal rezervleri MUTASYONA UGRATMADI. Locker'in
        // fiyati cagriDAN SONRA okumasi tam olarak buna dayanir.
        assertEq(IGraduatableCurve(curve).virtualQuoteReserves(), vq, "graduate() vQ'yu degistirdi");
        assertEq(IGraduatableCurve(curve).virtualTokenReserves(), vt, "graduate() vT'yi degistirdi");
    }

    /// IKI ALIMLA tamamlanan bir curve KATI OLARAK DAHA YUKSEK bir fiyatta
    /// acar, cunku `quoteBuyCost`un +1'i HER ALIMDA birikir. SABIT YAZILMIS
    /// BIR `sqrtPriceX96` BU TESTTE OLUR ve tek-alim testleri onu GORMEZ.
    function test_aTwoBuyCompletionOpensAtAStrictlyHigherPrice() public {
        (address t1, address payable c1) = _launchAndBuyOut("Arc");
        (PoolKey memory k1, bool base0a) = _keyOf(t1);
        locker.graduate(c1);
        (uint160 oneBuy,,,) = pm.getSlot0(k1.toId());

        (address t2, address payable c2) = _launch("Arc2");
        vm.deal(BUYER, 1_000_000e18);
        vm.startPrank(BUYER);
        BondingCurve(c2).buyExactTokensOut{value: 100_000e18}(S / 2, type(uint256).max);
        BondingCurve(c2).buyExactTokensOut{value: 100_000e18}(S - S / 2, type(uint256).max);
        vm.stopPrank();
        require(BondingCurve(c2).complete(), "two-buy curve not complete");
        (PoolKey memory k2, bool base0b) = _keyOf(t2);
        locker.graduate(c2);
        (uint160 twoBuys,,,) = pm.getSlot0(k2.toId());

        // FIYATIN YONU SIRALAMAYA BAGLIDIR: USDC = currency0 iken oran
        // base/quote'tur, yani DAHA COK quote DAHA DUSUK sqrtPrice demektir.
        assertEq(base0a, base0b, "iki launch farkli siralamaya dustu -- karsilastirma anlamsiz");
        if (base0a) {
            assertGt(twoBuys, oneBuy, "token = currency0: ikinci alim fiyati yukseltmeliydi");
        } else {
            assertLt(twoBuys, oneBuy, "USDC = currency0: ikinci alim orani dusurmeliydi");
        }
    }

    /// `quoteBuyCost`TAKI KOSULSUZ `+1` TASIYICIDIR. Bu test onun SONUCUNU
    /// pinler: tohumlanan oran R/D, kapanis fiyati vQ/vT'nin USTUNDE kalir, ve
    /// R formul degerinin tam bir birim uzerindedir.
    ///
    /// @dev BU TESTIN ONCEKI NATSPEC'I IKI SEY IDDIA EDIYORDU VE IKISI DE
    ///      OLCULDU, IKISI DE YANLIS:
    ///      (1) "bunu yapan baska bir test yoktu" -- vardi:
    ///          `CurveMath.t.sol::test_buyCostAddsOneEvenWhenDivisionIsExact`
    ///          tam bolunen kurguyu DOGRUDAN surer (`quoteBuyCost(50,100,150)`
    ///          == 51) ve bu fazdan ONCE yazilmistir.
    ///      (2) "`mulDivRoundingUp`a sadelestirilirse bu test yakalar" -- TASK 6
    ///          ADIM 2'DE OLCULDU: o mutasyon uygulandiginda BU TEST GECER.
    ///
    ///      SEBEP: `mulDiv(a,b,d) + 1` ile `mulDivRoundingUp(a,b,d)` YALNIZCA
    ///      `d`, `a*b`yi TAM BOLDUGUNDE ayrisir. `_launchAndBuyOut`un surdugu
    ///      alim dizisi hicbir adimda tam bolunmeye dusmez, dolayisiyla R
    ///      degismez ve asagidaki uc iddia da aynen tutar. Bu, testin
    ///      ULASIMININ olculmeden VARSAYILMASIydi.
    ///
    ///      O mutasyonu FIILEN olduren iki test sudur ve ikisi de
    ///      `CurveMath` tarafindadir:
    ///        - `CurveMath.t.sol::test_buyCostAddsOneEvenWhenDivisionIsExact`
    ///          (`50 != 51`, tam bolunen kurguyu elle kurar)
    ///        - `CurveMathFuzz.t.sol`in gidis-donus iddiasi
    ///          (`assertLt(proceeds, cost, "round trip created value")`) --
    ///          sadelestirme ile gidis-donus EsITLENIR, yani al-sat artik
    ///          kesin zararli olmaktan cikar.
    ///
    ///      Test SILINMIYOR: pinledigi iki sey (oranin YONU ve R'nin tam
    ///      degeri) gercek ozelliklerdir. Silinen sey, tasimadigi bir
    ///      korumayi tasidigi IDDIASIDIR.
    function test_theUnconditionalPlusOneKeepsTheSeededRatioAboveTheClosingPrice() public {
        (, address payable curve) = _launchAndBuyOut("Arc");
        uint256 r = BondingCurve(curve).realQuoteReserves();
        uint256 vq = IGraduatableCurve(curve).virtualQuoteReserves();
        uint256 vt = IGraduatableCurve(curve).virtualTokenReserves();

        // TOHUMLANAN oran R/D; KAPANIS fiyati vQ/vT. Ikisi de 1e36 ile
        // olceklenir ki tam sayi karsilastirmasi anlamli olsun.
        uint256 seededX36 = FullMath.mulDiv(r, 1e36, D);
        uint256 finalX36 = FullMath.mulDiv(vq, 1e36, vt);
        assertGt(seededX36, finalX36, "+1 kaybolmus -- tohumlanan oran kapanis fiyatinin ALTINA dustu");

        // ...ve `+1` GERCEKTEN oradadir: R, formul degerinin TAM USTUNDEDIR.
        assertEq(r, 12_161_433_369_060_378_707);
        assertEq(r - 1, 12_161_433_369_060_378_706, "MIN_GRADUATION_RAISE ile ayrisma");
    }

    // ---------------------------------------------------------------
    // Pozisyon kaliciligi
    // ---------------------------------------------------------------

    function test_callingUnlockCallbackDirectlyRevertsNotPoolManager() public {
        vm.prank(ATTACKER);
        vm.expectRevert(ArcpadLocker.NotPoolManager.selector);
        locker.unlockCallback("");
    }

    /// SALDIRGANIN KENDI `unlock`I LOCKER'IN CALLBACK'INI HIC CALISTIRMAZ:
    /// `PoolManager` `IUnlockCallback(msg.sender)` cagirir.
    function test_anAttackersUnlockCannotReachTheLockersCallback() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        locker.graduate(curve);
        (PoolKey memory key,) = _keyOf(token);
        uint128 before = _liquidityOf(key);
        assertGt(before, 0, "pozisyon yok -- test hicbir sey olcmuyor");

        AttackerUnlocker a = new AttackerUnlocker(pm);
        vm.recordLogs();
        vm.prank(ATTACKER);
        a.go(abi.encode(key, uint128(1), uint256(0), uint256(0)));

        assertTrue(a.ranOwnCallback(), "saldirganin kendi callback'i calismadi -- test yanlis kurulmus");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(locker), "locker'dan log cikti");
        }
        assertEq(_liquidityOf(key), before, "likidite degisti");
    }

    /// LIKIDITE, HER AKTORUN HER KALDIRMA DENEMESINDEN SONRA DEGISMEZ.
    /// Denemeler KILIDIN ICINDEN yapilir; aksi halde hepsi `ManagerLocked`
    /// ile duserdi ve test, kilidin mi POZISYON SAHIPLIGININ mi engelledigini
    /// AYIRT EDEMEZDI.
    function test_theSeededLiquidityIsUnchangedAfterEveryRemovalAttempt() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        locker.graduate(curve);
        (PoolKey memory key,) = _keyOf(token);
        uint128 before = _liquidityOf(key);
        assertGt(before, 0, "pozisyon yok -- test hicbir sey olcmuyor");

        int256 remove = -int256(uint256(before));

        // (1) Ucuncu bir kontrat, kilidin icinden. Kendi (bos) pozisyonunu
        //     eksiye cekmeye calisir -> `PoolManager` underflow eder.
        RemovalAttempt r = new RemovalAttempt(pm);
        vm.prank(ATTACKER);
        vm.expectRevert();
        r.tryRemove(key, remove);
        assertEq(_liquidityOf(key), before, "ucuncu taraf denemesinden sonra likidite degisti");

        // (2) Creator.
        RemovalAttempt r2 = new RemovalAttempt(pm);
        vm.prank(CREATOR);
        vm.expectRevert();
        r2.tryRemove(key, remove);
        assertEq(_liquidityOf(key), before, "creator denemesinden sonra likidite degisti");

        // (3) LOCKER'IN KENDISI. Kilidi acan bir yol VARDIR (`graduate`) ama
        //     `unlockCallback` yalnizca EKLEME kodu tasir; negatif delta
        //     uretebilecek hicbir dis yuzey YOKTUR. Locker'a rastgele bir
        //     `data` ile callback calistiran bir yol da yoktur: `graduate`
        //     `data`yi KENDI kurar.
        vm.prank(ATTACKER);
        vm.expectRevert(ArcpadLocker.NotPoolManager.selector);
        locker.unlockCallback(abi.encode(key, uint128(before), uint256(0), uint256(0)));
        assertEq(_liquidityOf(key), before, "locker uzerinden deneme likiditeyi degistirdi");
    }

    /// ACIK HUCRE: BAGIS ARALIKTAKI LIKIDITEYE KREDILENIR VE TAHSIL
    /// EDILEMEZ -- YANI YAKILIR. Kapatmak `BEFORE_DONATE_FLAG` demekti, o da
    /// hook ADRESINI degistirmek demekti.
    function test_aDonationToThePoolIsCreditedAndCanNeverBeCollected() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        locker.graduate(curve);
        (PoolKey memory key,) = _keyOf(token);

        // IKI FARKLI BUYUKLUK, VE KARISTIRMAK BU TESTIN TEK TUZAGIYDI (ilk
        // yazim tam olarak buna dustu ve "bagis kredilenmedi" diyordu):
        //   `getFeeGrowthInside`  -> CANLI deger, bagisla ANINDA artar.
        //   `getPositionInfo`in `feeGrowthInside*LastX128`i -> pozisyonun
        //      SAKLANMIS anlik goruntusu; yalnizca `modifyLiquidity`
        //      pozisyona DOKUNDUGUNDA guncellenir.
        // Ikincisinin OYNAMAMASI bir eksiklik degil, iddianin TA KENDISIDIR.
        (uint256 live0Before, uint256 live1Before) =
            pm.getFeeGrowthInside(key.toId(), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER);
        (, uint256 snap0Before, uint256 snap1Before) = pm.getPositionInfo(
            key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        uint128 liqBefore = _liquidityOf(key);

        Donor d = new Donor(pm);
        usdc.mint(address(d), 1_000_000);
        deal(token, address(d), 1e21, true);
        d.donate(key, 1_000_000, 1e18);

        // (1) BAGIS GERCEKTEN ARALIKTAKI LIKIDITEYE KREDILENDI.
        (uint256 live0After, uint256 live1After) =
            pm.getFeeGrowthInside(key.toId(), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER);
        assertTrue(live0After > live0Before || live1After > live1Before, "bagis aralikta likiditeye kredilenmedi");

        // (2) VE TAHSIL EDILEMEZ. Krediyi gerceklestirmenin TEK yolu
        //     pozisyona `modifyLiquidity` ile dokunmaktir; locker'da o cagriya
        //     ulasan tek kod `unlockCallback`tir, o da (a) yalnizca
        //     `PoolManager` tarafindan cagrilabilir ve (b) yalnizca
        //     `graduate`in KENDI kurdugu `data` ile calisir. Disaridan
        //     tetiklenebilir hicbir yol yoktur.
        vm.prank(ATTACKER);
        vm.expectRevert(ArcpadLocker.NotPoolManager.selector);
        locker.unlockCallback(abi.encode(key, uint128(0), uint256(0), uint256(0)));

        // (3) POZISYONUN SAKLANMIS GORUNTUSU KIMILDAMADI -- yani kredi
        //     gerceklesmedi ve gerceklesemez. ACIK HUCRE: bu bagis YAKILDI.
        (uint128 liqAfter, uint256 snap0After, uint256 snap1After) = pm.getPositionInfo(
            key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        assertEq(snap0After, snap0Before, "pozisyonun goruntusu oynadi -- kredi gerceklesmis olurdu");
        assertEq(snap1After, snap1Before, "pozisyonun goruntusu oynadi -- kredi gerceklesmis olurdu");
        assertEq(liqAfter, liqBefore, "bagis likiditeyi degistirdi");
    }

    // ---------------------------------------------------------------
    // Ariza modeli
    // ---------------------------------------------------------------

    function test_aSecondGraduateOnTheSameCurveRevertsAlreadyGraduated() public {
        (, address payable curve) = _launchAndBuyOut("Arc");
        locker.graduate(curve);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        locker.graduate(curve);
    }

    function test_graduateOnAnIncompleteCurveRevertsNotComplete() public {
        (, address payable curve) = _launch("Arc");
        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(curve).buyExactTokensOut{value: 100_000e18}(S / 2, type(uint256).max);
        assertFalse(BondingCurve(curve).complete(), "curve tamamlandi -- test hicbir sey olcmuyor");

        vm.expectRevert(BondingCurve.NotComplete.selector);
        locker.graduate(curve);
    }

    /// BASKA BIR FACTORY'NIN CURVE'U. Locker'in kanoniklik kaniti factory'nin
    /// KENDI defteridir, dolayisiyla ikinci factory'nin token'i bu locker'in
    /// factory'sinde SIFIR schedule tasir.
    function test_graduateOnACurveFromAnotherFactoryReverts() public {
        LaunchFactory other = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(schedule));
        vm.prank(GOVERNOR);
        other.proposeGraduationTarget(address(locker));
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        other.applyGraduationTarget();

        vm.prank(CREATOR);
        (address tk, address cv) = other.launch("Other", "OTH", "ipfs://x");
        assertEq(factory.feeScheduleOf(tk), address(0), "yabanci token bu factory'de schedule tasiyor");

        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(payable(cv)).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);

        vm.expectRevert(ArcpadLocker.CurveNotFromFactory.selector);
        locker.graduate(cv);
    }

    /// BOZUK BIR HEDEF BIR LAUNCH'I STRAND EDEMEZ. Iddianin IKI YARISI VAR:
    /// (a) revert edince curve'de HICBIR SEY hareket etmemistir, ve
    /// (b) DUZELTMEDEN SONRA YENIDEN DENEME BASARIR. Ikincisi olmadan
    ///     birincisi "kalici olarak kilitlendi" ile ayirt edilemezdi.
    function test_ifInitializeRevertsTheCurveIsUntouchedAndARetrySucceeds() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        uint256 r = BondingCurve(curve).realQuoteReserves();

        vm.mockCallRevert(address(hook), abi.encodeWithSelector(IHooks.beforeInitialize.selector), abi.encode("nope"));
        vm.expectRevert();
        locker.graduate(curve);

        assertFalse(BondingCurve(curve).graduated(), "graduated latch'i geri alinmadi");
        assertEq(BondingCurve(curve).realQuoteReserves(), r, "R hareket etti");
        assertEq(IERC20(token).balanceOf(curve), 1e27 - S, "curve'un token bakiyesi hareket etti");
        assertEq(address(locker).balance, 0, "locker quote aldi");
        assertEq(IERC20(token).balanceOf(address(locker)), 0, "locker token aldi");

        vm.clearMockedCalls();
        vm.recordLogs();
        locker.graduate(curve);
        (uint128 l,,) = _readPoolSeeded(vm.getRecordedLogs());
        assertEq(l, 50160046734639668, "yeniden deneme farkli tohumladi");
        assertTrue(BondingCurve(curve).graduated());
    }

    /// TOHUMLAMA BACAGININ KENDISI DUSERSE DE ISLEMIN TAMAMI GERI ALINIR.
    ///
    /// BU TEST BIR OLCUMLE DOGDU VE BOSLUGU GERCEKTI. Ilk yazimda ariza
    /// modelinin TAMAMI islemi `initialize`DA ya da daha ONCE olduruyordu,
    /// yani `unlock` cagrisi HICBIR TESTTE BASARISIZ OLMUYORDU. Olculdu:
    /// `unlock`i `try`/`catch` ile sarmak (accept-then-fail'i geri getiren
    /// mutasyon) 20 testin HICBIRINI kirmiyordu; `PositionNotSeeded` geri
    /// okumasini DA silen BIRLESIK mutant da kirmiyordu -- ve o birlesik
    /// halde curve odemeyi yapmis, havuzda likidite YOK, islem BASARILI
    /// oluyordu. Tam olarak fazin yasakladigi durum, paket YESILKEN.
    ///
    /// IC SELECTOR IDDIA EDILMEK ZORUNDA, ciplak `vm.expectRevert()` DEGIL:
    /// `try`/`catch` mutantinda islem YINE revert eder (geri okuma yakalar)
    /// ama SEBEBI degisir. Ciplak bir bekleyis ikisini ayirt edemez ve
    /// mutant hayatta kalirdi -- hook paketinin `ZeroCurrency` dersinin
    /// aynisi.
    function test_ifTheSeedingLegRevertsTheWholeGraduationIsRolledBack() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        uint256 r = BondingCurve(curve).realQuoteReserves();

        vm.mockCallRevert(
            address(pm),
            abi.encodeWithSelector(IPoolManager.unlock.selector),
            abi.encodeWithSelector(SeedLegFailed.selector)
        );
        vm.expectRevert(SeedLegFailed.selector);
        locker.graduate(curve);
        vm.clearMockedCalls();

        // Curve'de HICBIR SEY hareket etmemis.
        assertFalse(BondingCurve(curve).graduated(), "graduated latch'i geri alinmadi");
        assertEq(BondingCurve(curve).realQuoteReserves(), r, "R hareket etti");
        assertEq(IERC20(token).balanceOf(curve), 1e27 - S, "curve'un token bakiyesi hareket etti");
        assertEq(address(locker).balance, 0, "locker quote aldi ve havuz yok -- ACCEPT-THEN-FAIL");
        assertEq(IERC20(token).balanceOf(address(locker)), 0, "locker token aldi ve havuz yok");

        // ...ve DUZELTMEDEN SONRA YENIDEN DENEME BASARIR.
        vm.recordLogs();
        locker.graduate(curve);
        (uint128 l,,) = _readPoolSeeded(vm.getRecordedLogs());
        assertEq(l, 50160046734639668);
        assertGt(_liquidityOfToken(token), 0, "yeniden deneme havuzu tohumlamadi");
    }

    /// ONCEDEN ACILMIS BIR HAVUZ LAUNCH'I TUGLALASTIRIR -- VE ONU ENGELLEYEN
    /// TEK SEY HOOK'TUR. Hook'un hedef kontrolu mock'la devre disi
    /// birakilarak durum KURULUR ve gorunur oldugu KANITLANIR; sonra mock
    /// kaldirilip ayni saldirinin GERCEKTEN reddedildigi olculur.
    function test_aPreExistingPoolBricksTheLaunchAndOnlyTheHookPreventsIt() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        (PoolKey memory key,) = _keyOf(token);

        // KONTROL ONCE: hook AYAKTAYKEN saldirgan anahtari ACAMAZ.
        vm.prank(ATTACKER);
        vm.expectRevert();
        pm.initialize(key, 79228162514264337593543950336);

        // Simdi hook'un `beforeInitialize`ini SESSIZCE KABUL EDER hale getir.
        vm.mockCall(
            address(hook),
            abi.encodeWithSelector(IHooks.beforeInitialize.selector),
            abi.encode(IHooks.beforeInitialize.selector)
        );
        vm.prank(ATTACKER);
        pm.initialize(key, 79228162514264337593543950336);
        vm.clearMockedCalls();

        // Havuz artik COP bir fiyatta ve graduation SONSUZA KADAR duser.
        vm.expectRevert();
        locker.graduate(curve);
        assertFalse(BondingCurve(curve).graduated(), "curve mezun oldu -- tuglalasma olcumu yanlis");

        // YENIDEN DENEME DE DUSER: ilerleme IMKANSIZDIR.
        vm.expectRevert();
        locker.graduate(curve);
    }

    /// `SeedShortfall` ARANDI, BULUNAMADI -- VE ARAMA BURADA DURUYOR.
    ///
    /// Koruma, ZIT YONLU IKI YUVARLAMANIN ustunde durur:
    /// `GraduationMath.seedLiquidity` (`getLiquidityForAmounts`) ASAGI,
    /// `Pool.modifyLiquidity` YUKARI yuvarlar. Fark bacak basina 1 wei tasma
    /// URETEBILIR -- teoride. Bu fuzz onu, `Pool`un GERCEK yuvarlamasini
    /// surerek arar; hicbir seyi yeniden uygulamaz.
    ///
    /// BULUNURSA test kirilir ve koruma ULASILABILIR demektir. Bulunmazsa
    /// koruma, `BondingCurve`in `!ok` dallariyla AYNI SINIFTA esdeger bir
    /// mutanttir: yerinde durur cunku yonu korumacidir ve arizayi
    /// `SafeERC20`nin icinde degil BURADA, hangi katmanin yetersiz kaldigini
    /// SOYLEYEREK gosterir.
    ///
    /// NEGATIF SONUCU RAPOR EDILEBILIR KILAN SEY, ARAMANIN HICBIR SEYE
    /// BAKMADIGI ICIN GECMEDIGININ KANITIDIR: `assertGt(liq, 0)` ve
    /// `assertGt(o0 + o1, 0)` her kosuda aramanin GERCEKTEN yurudugunu
    /// olcer.
    function testFuzz_theRoundingPairNeverMakesTheSeedFallShort(uint256 quoteSeed, uint256 baseSeed) public {
        // HICBIR ERKEN CIKIS YOK, VE BU BILINCLI BIR DUZELTMEDIR. Ilk yazim
        // adresi `| (1 << 159)` ile uretiyordu -- yani HER ZAMAN `QUOTE`un
        // USTUNDE -- ve hemen ardindaki `if (tk >= QUOTE) return;` her kosuda
        // caliyordu. Test 256/256 GECIYORDU ve HICBIR SEY OLCMUYORDU;
        // yakalayan sey ortalama gazin 5.990 olmasiydi. Bantlar artik
        // on kosullari SAGLAYACAK sekilde secilmistir ve saglandiklari
        // ITIRAZ EDILIR, atlanmaz.
        //
        // `q >= 1e9`: `isSeedable`in ikinci ucurumu `quoteFinal > scaled>>64`
        // ister, yani `q > b / 2^64`; `b <= 1e28` icin bu 5,4e8'dir.
        uint256 q = bound(quoteSeed, 1e9, 1e14); // 6-decimal quote birimi
        uint256 b = bound(baseSeed, 1e24, 1e28); // 18-decimal base wei

        assertTrue(GraduationMath.isSeedable(q * 1e12, b), "bant on kosulu saglamiyor -- fuzz yanlis kurulmus");
        uint160 sqrtPrice = GraduationMath.sqrtPriceX96(q * 1e12, b, true);

        // Token `QUOTE`UN ALTINA ZORLANIR (token = currency0 dali), atlanmaz.
        // Precompile araligindan kacinmak icin taban eklenir.
        uint160 raw = uint160(uint256(keccak256(abi.encode(q, b))));
        address tk = address(uint160(0x10000) + (raw % (uint160(GraduationMath.QUOTE) - uint160(0x10000))));
        assertTrue(tk < GraduationMath.QUOTE, "token QUOTE'un altinda degil");

        vm.etch(tk, address(new TokenMock()).code);

        (PoolKey memory key,) = GraduationMath.poolKey(tk, IHooks(address(0)));
        uint128 liq = GraduationMath.seedLiquidity(sqrtPrice, b, q);

        pm.initialize(key, sqrtPrice);
        SeedProbe probe = new SeedProbe(pm);
        TokenMock(tk).mint(address(probe), b);
        usdc.mint(address(probe), q);
        (uint256 o0, uint256 o1) = probe.measure(key, liq);

        // ARAMA GERCEKTEN YURUDU -- bu uc satir olmadan yukaridaki iki
        // `assertLe` bos bir pozisyonda vakumla gecerdi.
        assertGt(liq, 0, "likidite sifir -- arama hicbir sey olcmedi");
        assertGt(o0, 0, "havuz base istemedi -- arama hicbir sey olcmedi");
        assertGt(o1, 0, "havuz quote istemedi -- arama hicbir sey olcmedi");

        // VE KISA KALMADI.
        assertLe(o0, b, "base bacagi kisa kaldi -- SeedShortfall ULASILABILIR");
        assertLe(o1, q, "quote bacagi kisa kaldi -- SeedShortfall ULASILABILIR");
    }

    /// `receive()` CIPLAK BIR KABULDUR: log yaymaz, storage yazmaz.
    function test_receiveIsABareAcceptAndDoesNothingElse() public {
        bytes32[4] memory before;
        for (uint256 i = 0; i < 4; ++i) {
            before[i] = vm.load(address(locker), bytes32(i));
        }

        vm.deal(ATTACKER, 1 ether);
        vm.recordLogs();
        vm.prank(ATTACKER);
        (bool ok,) = address(locker).call{value: 1}("");
        assertTrue(ok, "receive() kabul etmedi");
        assertEq(vm.getRecordedLogs().length, 0, "receive() log yaydi");

        for (uint256 i = 0; i < 4; ++i) {
            assertEq(vm.load(address(locker), bytes32(i)), before[i], "receive() storage yazdi");
        }
    }

    // ---------------------------------------------------------------
    // `IGraduatableCurve` -- DERLEME ZAMANI KONTROLUNUN YERINE GECEN OLCUM
    // ---------------------------------------------------------------

    /// `BondingCurve` BU ARAYUZU `is` ILE UYGULAYAMAZ: bytecode'u
    /// DONDURULMUSTUR ve `is IGraduatableCurve` eklemek hash'i hareket
    /// ettirirdi. Dolayisiyla `IFeeEscrow`in derleme-zamani kontrolu burada
    /// YOKTUR -- yerine BU OLCUM gecer. Ayrisma sessiz kalmaz.
    ///
    /// SELECTOR ESITLIGI YETMEZ, CAGRILABILIRLIK DE OLCULUR: ayni selector'e
    /// sahip ama farkli donus tipi tasiyan bir uye ancak fiili cagriyla
    /// yakalanir.
    function test_everyMemberOfIGraduatableCurveExistsOnTheRealCurve() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");

        // ARAYUZUN KENDI selector'lari, ELLE YAZILMAZ. Her biri GERCEK
        // curve'e `staticcall` edilir: hem varligi hem 32 baytlik bir cevap
        // dondurdugu olculur. Selector esitligini elle yazmak, iki tarafi da
        // ayni yanlisla doldurabilecegim icin daha zayif olurdu.
        bytes4[6] memory sels = [
            IGraduatableCurve.token.selector,
            IGraduatableCurve.virtualQuoteReserves.selector,
            IGraduatableCurve.virtualTokenReserves.selector,
            IGraduatableCurve.poolSeedSupply.selector,
            IGraduatableCurve.complete.selector,
            IGraduatableCurve.graduated.selector
        ];
        for (uint256 i = 0; i < sels.length; ++i) {
            (bool ok, bytes memory ret) = curve.staticcall(abi.encodeWithSelector(sels[i]));
            assertTrue(ok, "arayuz uyesi gercek curve'de yok");
            assertEq(ret.length, 32, "arayuz uyesi 32 baytlik bir deger dondurmedi");
        }

        // KONTROL: `staticcall` GERCEKTEN ayirt ediyor. Var olmayan bir
        // selector BASARISIZ olmali; olmuyorsa yukaridaki dongu her seyi
        // "var" ilan ederdi.
        (bool bogus,) = curve.staticcall(abi.encodeWithSelector(bytes4(0xdeadbeef)));
        assertFalse(bogus, "curve bilinmeyen bir selector'u kabul etti -- olcum anlamsiz");

        // ...ve arayuz TIPI uzerinden cagrilar dogru degerleri veriyor.
        IGraduatableCurve c = IGraduatableCurve(curve);
        assertEq(c.token(), token);
        assertTrue(c.complete());
        assertFalse(c.graduated());
        assertEq(c.poolSeedSupply(), D);
        assertEq(c.virtualQuoteReserves(), BondingCurve(curve).virtualQuoteReserves());
        assertEq(c.virtualTokenReserves(), BondingCurve(curve).virtualTokenReserves());
    }

    // ---------------------------------------------------------------

    /// `PoolSeeded`i kayitli loglardan cozer. Olay YAYILMAMISSA test
    /// BASARISIZ OLUR -- sessizce sifir donmez.
    function _readPoolSeeded(Vm.Log[] memory logs)
        internal
        view
        returns (uint128 liquidity, uint256 baseSeeded, uint256 quoteSeeded)
    {
        bytes32 topic0 = keccak256("PoolSeeded(address,address,bytes32,uint160,uint128,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(locker) && logs[i].topics[0] == topic0) {
                (, uint128 l, uint256 b, uint256 q) = abi.decode(logs[i].data, (uint160, uint128, uint256, uint256));
                return (l, b, q);
            }
        }
        revert("PoolSeeded yayilmadi");
    }
}

/// @dev SAHTE CURVE -- uc okuma uyesi gercek curve'u AYNALAR, `graduate()` ise
///      HICBIR SEY ODEMEZ. Locker'in eskiden dogrulamadigi sey tam olarak buydu.
contract SpoofCurve {
    address public immutable token;
    address public immutable mirror;
    uint256 public immutable baseOut;
    uint256 public immutable quoteOut;

    constructor(address token_, address mirror_, uint256 baseOut_, uint256 quoteOut_) {
        token = token_;
        mirror = mirror_;
        baseOut = baseOut_;
        quoteOut = quoteOut_;
    }

    function virtualQuoteReserves() external view returns (uint256) {
        return BondingCurve(payable(mirror)).virtualQuoteReserves();
    }

    function virtualTokenReserves() external view returns (uint256) {
        return BondingCurve(payable(mirror)).virtualTokenReserves();
    }

    function complete() external pure returns (bool) {
        return true;
    }

    function graduated() external pure returns (bool) {
        return false;
    }

    function poolSeedSupply() external view returns (uint256) {
        return baseOut;
    }

    /// Odeme YOK. Eskiden donen sayilar locker icin yeterliydi.
    function graduate() external view returns (uint256, uint256) {
        return (baseOut, quoteOut);
    }
}

/// ============================================================================
///  KANONIK HAVUZ, ODEME YAPILMADAN ACILAMAZ -- IKI BAGIMSIZ KATMAN
/// ============================================================================
///
/// BULUNAN ACIK (denetim, PoC ile kanitlandi): `ArcpadLocker.graduate(curve)`
/// `curve` ile `token` arasindaki bagi dogrulamiyordu. Tek kanoniklik kontrolu
/// `feeScheduleOf(token) != 0`di ve `token` GUVENILMEYEN curve'den okunuyordu --
/// yani gercek bir token bildiren sahte bir curve kontrolu geciyor,
/// `curve.graduate()` hicbir sey odemeden istedigi sayilari donduruyor ve locker
/// KANONIK havuzu saldirganin sectigi toz likiditeyle aciyordu.
///
/// Etkisi hirsizlik degil, DAHA KOTUSUYDU: gercek mezuniyet o andan sonra
/// `poolManager.initialize` satirinda `PoolAlreadyInitialized` ile revert eder ve
/// BASKA CIKIS YOKTUR -- curve'de ikinci bir hedef, kurtarma yolu ya da "zaten
/// acilmissa atla" dali yoktur. Tamamlanmis bir curve'de satis da kapali
/// oldugundan, toplanan raise'in TAMAMI sonsuza kadar kilitlenirdi. Maliyeti
/// birkac dolarlik tozdu ve HER launch'a uygulanabilirdi.
///
/// IKI KATMAN, ve ikincisi birincisine GUVENMEZ: locker `token.curve() == curve`
/// ister; hook ayrica curve'un `graduated` bayragini okur, yani hedef tarafi
/// yeniden yanlis yazilsa bile havuz odeme yapilmadan acilamaz.
contract ArcpadLockerCurveSpoofTest is ArcpadLockerTest {
    using StateLibrary for IPoolManager;

    /// @dev Saldirganin kurdugu sahne: kurban tamamlanmis, mezun olmayi
    ///      bekliyor; locker toz likidite ile fonlanmis.
    function _armSpoof(string memory n)
        internal
        returns (address token, address payable curve, SpoofCurve spoof, uint256 trapped)
    {
        (token, curve) = _launchAndBuyOut(n);
        assertTrue(BondingCurve(curve).complete(), "kurban tamamlanmadi");
        assertFalse(BondingCurve(curve).graduated(), "kurban zaten mezun");
        trapped = BondingCurve(curve).realQuoteReserves();
        assertGt(trapped, 0, "kilitlenecek raise yok");

        uint256 dustBase = 1e18;
        uint256 dustQuoteUnits = 1_000;
        vm.prank(address(curve));
        IERC20(token).transfer(address(locker), dustBase);
        usdc.mint(address(locker), dustQuoteUnits);

        spoof = new SpoofCurve(token, curve, dustBase, dustQuoteUnits * 1e12);
    }

    /// KATMAN 1 -- LOCKER. Token'in bagli oldugu curve DEGILSE reddeder.
    function test_spoofedCurveCannotOpenTheCanonicalPool() public {
        (address token, address payable curve, SpoofCurve spoof, uint256 trapped) = _armSpoof("Arc");

        vm.prank(address(0xA11CE));
        vm.expectRevert(ArcpadLocker.CurveTokenMismatch.selector);
        locker.graduate(address(spoof));

        // Havuz ACILMADI ve kurban dokunulmamis: mezuniyet HALA mumkun.
        (PoolKey memory key,) = _keyOf(token);
        (uint160 sqrtPrice,,,) = pm.getSlot0(key.toId());
        assertEq(sqrtPrice, 0, "havuz saldirganca acildi");
        assertEq(BondingCurve(curve).realQuoteReserves(), trapped, "raise hareket etti");

        // VE ASIL ISPAT: mesru mezuniyet BASARIR. Bir revert tek basina
        // "kalici olarak kilitlendi" ile ayirt edilemezdi.
        locker.graduate(curve);
        assertTrue(BondingCurve(curve).graduated(), "mesru mezuniyet gecmedi");
    }

    /// KATMAN 2 -- HOOK. Hedef tarafi yeniden yanlis yazilsa bile, odeme
    /// yapilmamis bir curve'un havuzu ACILAMAZ.
    ///
    /// Hedefin kontrolu BURADA ATLANIR (`prank` ile dogrudan `initialize`),
    /// cunku olculen sey tam olarak "locker bir daha hata yaparsa ne olur"dur.
    function test_theHookRefusesAPoolWhoseCurveHasNotPaid() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        assertFalse(BondingCurve(curve).graduated(), "kurulum: curve zaten mezun");

        (PoolKey memory key, bool baseIsCurrency0) = _keyOf(token);
        uint160 price = GraduationMath.sqrtPriceX96(
            BondingCurve(curve).virtualQuoteReserves(),
            BondingCurve(curve).virtualTokenReserves(),
            baseIsCurrency0
        );

        vm.prank(address(locker));
        vm.expectRevert();
        pm.initialize(key, price);

        (uint160 sqrtPrice,,,) = pm.getSlot0(key.toId());
        assertEq(sqrtPrice, 0, "odeme yapilmadan havuz acildi");
    }

    /// VE MESRU YOL HALA CALISIR -- iki katman da gecirir.
    function test_theLegitimatePathStillGraduates() public {
        (address token, address payable curve) = _launchAndBuyOut("Arc");
        locker.graduate(curve);

        assertTrue(BondingCurve(curve).graduated(), "mezuniyet gecmedi");
        (PoolKey memory key,) = _keyOf(token);
        (uint160 sqrtPrice,,,) = pm.getSlot0(key.toId());
        assertGt(sqrtPrice, 0, "havuz acilmadi");
        assertGt(_liquidityOfToken(token), 0, "likidite tohumlanmadi");
    }
}

/// ============================================================================
///  KURULUM BAGIMLILIKLARI SIFIR OLAMAZ
/// ============================================================================
///
/// Bunlar deploy aninda DISARIDAN verilir ve baska hicbir yerde dogrulanmaz --
/// yani buradaki kontroller `protocolTreasury()`teki gibi "gercek factory ile
/// ulasilamaz olu kod" DEGILDIR; asagidaki testler onlari oldurur.
///
/// EN SESSIZ OLANI ESCROW: `deposit` hicbir sey dondurmedigi icin solc
/// EXTCODESIZE kontrolu uretmez, yani kodsuz bir adrese yapilan
/// `deposit{value: x}` BASARILI SAYILIR. Sifir escrow'lu bir hook her swap'te
/// ucreti sessizce yakardi -- ve hook'un adresi `PoolKey`in bir alani oldugu
/// icin bu ilk mezuniyetten sonra DUZELTILEMEZDI.
contract ArcpadPoolLayerZeroDependencyTest is ArcpadLockerTest {
    function test_lockerRefusesAZeroPoolManager() public {
        vm.expectRevert(ArcpadLocker.ZeroDependency.selector);
        new ArcpadLocker(IPoolManager(address(0)), address(factory), IHooks(address(hook)));
    }

    function test_lockerRefusesAZeroFactory() public {
        vm.expectRevert(ArcpadLocker.ZeroDependency.selector);
        new ArcpadLocker(IPoolManager(address(pm)), address(0), IHooks(address(hook)));
    }

    /// Sifir hook GORUNMEZ olurdu: `GraduationMath.poolKey` onu ANAHTARA koyar
    /// ve hook'suz bir anahtar, arcpad'in korumalarinin HICBIRI olmadan acilan
    /// bir havuzdur.
    function test_lockerRefusesAZeroHook() public {
        vm.expectRevert(ArcpadLocker.ZeroDependency.selector);
        new ArcpadLocker(IPoolManager(address(pm)), address(factory), IHooks(address(0)));
    }

    /// @dev HOOK'U DUZ `new` ILE DENEMEK OLCMEZ. `BaseHook(poolManager_)`
    ///      constructor GOVDESINDEN ONCE calisir ve adresin izin bayraklarini
    ///      dogrular; rastgele bir adreste `HookAddressNotValid` ile duser ve
    ///      test, olcmek istedigi kontrole HIC ULASMAZ. Gercek deploy yolu
    ///      CREATE2 + madenlenmis adrestir, dolayisiyla test de oyle olmali.
    function _deployHookWith(address factory_, address escrow_) private {
        bytes memory args = abi.encode(IPoolManager(address(pm)), factory_, escrow_);
        (, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, 0x20CC, type(ArcpadHook).creationCode, args);
        vm.prank(CREATE2_DEPLOYER);
        new ArcpadHook{salt: salt}(IPoolManager(address(pm)), factory_, escrow_);
    }

    function test_hookRefusesAZeroFactory() public {
        vm.expectRevert(ArcpadHook.ZeroDependency.selector);
        _deployHookWith(address(0), address(escrow));
    }

    /// EN SESSIZ ARIZA. Bkz. sinifin basindaki not: kodsuz bir escrow'a yapilan
    /// `deposit{value: x}` REVERT ETMEZ, cunku `deposit` hicbir sey dondurmez
    /// ve solc EXTCODESIZE kontrolu uretmez.
    function test_hookRefusesAZeroEscrow() public {
        vm.expectRevert(ArcpadHook.ZeroDependency.selector);
        _deployHookWith(address(factory), address(0));
    }
}
