// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IProtocolFees} from "@uniswap/v4-core/src/interfaces/IProtocolFees.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {BaseHook} from "uniswap-hooks/base/BaseHook.sol";
import {ArcpadHook} from "../src/ArcpadHook.sol";
import {PoolDeployLib} from "../script/PoolDeployLib.sol";
import {GraduationMath} from "../src/libraries/GraduationMath.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

/// @dev Arc'ta USDC HEM native HEM 0x3600...'daki ERC-20 gorunumdur -- AYNI
///      BAKIYENIN iki yuzu. Yerel EVM'de o esdegerlik yoktur, bu yuzden test
///      o adrese, transferi alicinin NATIVE bakiyesine yazan bir ERC-20
///      etch'ler. Canli olcum (blok 54019678): transfer `receive()`i
///      CALISTIRMAZ, sadece bakiyeyi kredilendirir. Mock tam bunu taklit eder.
contract UsdcMock {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => mapping(address => uint256)) public allowance;

    /// ARC'IN TASIYICI OZELLIGI: TEK BAKIYE, IKI GORUNUM. `balanceOf`
    /// SAKLANMAZ -- native bakiyeden TURETILIR. Ilk yazimda iki ayri defter
    /// tutuluyordu ve o model YANLISTI: `graduate()` quote'u `call{value:}`
    /// ile odedigi icin locker'in ERC-20 gorunumu SIFIR kaliyordu ve
    /// likidite tohumlamasi underflow ediyordu. Arc'ta oyle bir ayrism YOK.
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

/// @dev `graduationTarget` rolunu oynar: `graduate()`i cagirir, havuzu
///      `initialize` eder ve likidite ekler. Task 5'in `ArcpadLocker`inin
///      test-yerine-gecenidir.
contract LockerStub is IUnlockCallback {
    IPoolManager public immutable pm;
    UsdcMock public immutable usdc;

    constructor(IPoolManager pm_, UsdcMock usdc_) {
        pm = pm_;
        usdc = usdc_;
    }

    receive() external payable {}

    function graduate(address curve) external returns (uint256 b, uint256 q) {
        return BondingCurve(payable(curve)).graduate();
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external {
        pm.initialize(key, sqrtPriceX96);
    }

    function addLiquidity(PoolKey calldata key, int24 tl, int24 tu, int256 liq) external {
        pm.unlock(abi.encode(key, tl, tu, liq));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, int24 tl, int24 tu, int256 liq) = abi.decode(data, (PoolKey, int24, int24, int256));
        (BalanceDelta delta,) = pm.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: liq, salt: 0}), ""
        );
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return "";
    }

    function _settle(Currency c, int128 amt) private {
        if (amt == 0) return;
        if (amt < 0) {
            uint256 owed = uint256(int256(-amt));
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(pm), owed);
            pm.settle();
        } else {
            // Likidite CIKARMA pozitif delta uretir; alinmazsa
            // `CurrencyNotSettled` gelir.
            pm.take(c, address(this), uint256(int256(amt)));
        }
    }
}

/// @dev Dort swap seklini de gercek `PoolManager`a karsi kosar.
contract SwapHarness is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) external returns (BalanceDelta) {
        bytes memory out = pm.unlock(abi.encode(key, zeroForOne, amountSpecified));
        return abi.decode(out, (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) = abi.decode(data, (PoolKey, bool, int256));
        BalanceDelta delta = pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne
                    ? uint160(4295128740)
                    : uint160(1461446703485210103287273052203988822378723970341)
            }),
            ""
        );
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _settle(Currency c, int128 amt) private {
        if (amt == 0) return;
        if (amt < 0) {
            uint256 owed = uint256(int256(-amt));
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(pm), owed);
            pm.settle();
        } else {
            pm.take(c, address(this), uint256(int256(amt)));
        }
    }
}

contract ArcpadHookTest is Test {
    using StateLibrary for IPoolManager;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant ARCPAD_HOOK_FLAGS = 0x20CC;

    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;

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
    LockerStub internal locker;
    SwapHarness internal harness;

    address internal token;
    address payable internal curve;
    PoolKey internal key;
    bool internal quoteIsCurrency0;
    uint160 internal openingPrice;
    bytes32 internal minedSalt;

    function setUp() public {
        pm = IPoolManager(address(new PoolManager(address(this))));

        usdc = new UsdcMock();
        vm.etch(GraduationMath.QUOTE, address(usdc).code);
        usdc = UsdcMock(GraduationMath.QUOTE);

        escrow = new FeeEscrow();
        schedule = new FeeSchedule();
        factory = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(schedule));

        locker = new LockerStub(pm, usdc);
        harness = new SwapHarness(pm);

        // ADRES MADENCILIGI. Alt 14 bit tam olarak 0x20CC olmali; `BaseHook`in
        // constructor'i bunu dogrular, yani yanlis adrese deploy IMKANSIZDIR.
        bytes memory args = abi.encode(IPoolManager(address(pm)), address(factory), address(escrow));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, ARCPAD_HOOK_FLAGS, type(ArcpadHook).creationCode, args);
        vm.prank(CREATE2_DEPLOYER);
        hook = new ArcpadHook{salt: salt}(IPoolManager(address(pm)), address(factory), address(escrow));
        require(address(hook) == hookAddr, "mined address diverged");
        minedSalt = salt;

        // Hedefi locker'a yonlendir.
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(locker));
        vm.warp(block.timestamp + 3 days);
        factory.applyGraduationTarget();

        (token, curve) = _launch(CREATOR, "Arc", "ARC");
        _completeAndGraduate(curve);

        (key, quoteIsCurrency0) = _keyFor(token);
        openingPrice = GraduationMath.sqrtPriceX96(
            BondingCurve(curve).virtualQuoteReserves(), BondingCurve(curve).virtualTokenReserves(), !quoteIsCurrency0
        );
    }

    function _launch(address creator_, string memory n, string memory sym)
        internal
        returns (address tk, address payable cv)
    {
        vm.prank(creator_);
        (address a, address b) = factory.launch(n, sym, "ipfs://x");
        return (a, payable(b));
    }

    function _completeAndGraduate(address payable cv) internal {
        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(cv).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);
        require(BondingCurve(cv).complete(), "curve not complete");
        locker.graduate(cv);
    }

    /// `poolKey` token'i currency0 mi currency1 mi yapar -- HESAPLANIR.
    function _keyFor(address base) internal view returns (PoolKey memory k, bool quote0) {
        bool baseIs0;
        (k, baseIs0) = GraduationMath.poolKey(base, IHooks(address(hook)));
        quote0 = !baseIs0;
    }

    /// @dev LIKIDITE GERCEK TOHUM MIKTARINDAN HESAPLANIR, uydurma bir
    ///      sabitten degil. Ilk yazim `1e15` kullaniyordu ve havuz o kadar
    ///      sig kaliyordu ki 1 USDC'lik exact-output cikis 1,8e34 wei token
    ///      girdisi istiyordu -- toplam arzin 1,8e7 katı. Task 5'in locker'i
    ///      da tam olarak bu hesabi yapacak.
    /// @dev V4 hook revert'lerini `CustomRevert.WrappedError` ile SARAR:
    ///      (hook, beforeInitialize.selector, IC HATA, HookCallFailed).
    ///      IC SELECTOR'U IDDIA ETMEK ZORUNLU -- ciplak `vm.expectRevert()`
    ///      HERHANGI bir revert'i kabul eder ve olculdu: `ZeroCurrency`
    ///      kontrolunu SILEN mutant o haliyle HAYATTA KALIYORDU, cunku
    ///      anahtar bir sonraki kontrolde (`TokenNotFromFactory`) yine revert
    ///      ediyordu. Testin gecmesi ile DOGRU SEBEPLE gecmesi farkli seyler.
    function _expectHookRevert(bytes4 inner) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(inner),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }

    function _openPool() internal {
        locker.initialize(key, openingPrice);
        _seed(key, quoteIsCurrency0, token, address(locker));
    }

    function _seed(PoolKey memory k, bool q0, address tk, address who) internal {
        uint256 baseAmount = IERC20(tk).balanceOf(who);
        uint256 quoteUnits = GraduationMath.quoteUnits(who.balance);
        uint128 liq = q0
            ? GraduationMath.seedLiquidity(uint160(uint256(_slot0Price(k))), quoteUnits, baseAmount)
            : GraduationMath.seedLiquidity(uint160(uint256(_slot0Price(k))), baseAmount, quoteUnits);
        LockerStub(payable(who))
            .addLiquidity(k, GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, int256(uint256(liq)));
    }

    function _slot0Price(PoolKey memory k) internal view returns (uint160 sp) {
        (sp,,,) = pm.getSlot0(k.toId());
    }

    /// @dev TOKEN FONU BUYUK OLMAK ZORUNDA: mezuniyet fiyatinda 1 USDC
    ///      ~1,7e7 token eder, dolayisiyla exact-output ile 1e6 quote birimi
    ///      istemek ~1,7e25 wei token girdisi gerektirir.
    function _fundHarness() internal {
        usdc.mint(address(harness), 1_000_000_000_000);
        deal(token, address(harness), 5e26, true);
    }

    // ---------------------------------------------------------------
    // Izin bitleri
    // ---------------------------------------------------------------

    /// @dev `0x20CC` VE `0x2088` DEGIL. Faz 1d `0x2088` pinliyordu; o kume
    ///      spec §5.5'in "ucret ASLA launch tokeninda alinmaz" cumlesini
    ///      dort swap seklinin IKISINDE uygulayamaz.
    function test_permissionFlagsAreExactlyTheArcpadSet() public pure {
        assertEq(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG,
            0x20CC
        );
    }

    function test_theMinedAddressCarriesExactlyTheArcpadFlags() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, 0x20CC);
    }

    /// SALT, ADRESIN TEK BELIRLEYICISI DEGILDIR -- `creationCode` DE
    /// BELIRLEYICIDIR, VE FAZIN EN KOLAY UNUTULAN BAGIMLILIGI BUDUR.
    ///
    /// Task 7'nin script'i bulunan salt'i SABITLER. `ArcpadHook.sol`in
    /// TEK BIR BAYTI degisirse o salt artik `0x20CC` ile biten bir adres
    /// URETMEZ ve deploy `HookAddressNotValid` ile revert eder -- ya da,
    /// daha kotusu, script sabit adresi VARSAYIP yanlis yere yazar.
    ///
    /// Bu test o bagimliligi CALISTIRARAK sabitler: madenlenen salt ile
    /// GUNCEL creationCode'dan CREATE2 adresi ELLE yeniden turetilir ve
    /// deploy edilmis hook'un adresine esit olmasi istenir. Ayrica alt 14
    /// bitin `0x20CC` oldugu, yani turetmenin DOGRU adresi urettigi ve
    /// yalnizca "bir adres" uretmedigi iddia edilir.
    ///
    /// KANONIK ADRES YOKTUR VE OLAMAZ: salt, constructor argumanlarina
    /// (`PoolManager`, factory, escrow, treasury) bagimlidir ve o dortlu
    /// ancak Task 7'nin deploy'unda sabitlenir. Dolayisiyla burada
    /// PINLENEN sey bir literal degil, TURETMENIN KENDISIDIR -- Task 7'nin
    /// script'i tam olarak bu formulu kullanmak zorundadir.
    function test_theMinedSaltAndTheCurrentCreationCodeReproduceTheHookAddress() public view {
        bytes memory initcode = abi.encodePacked(
            type(ArcpadHook).creationCode, abi.encode(IPoolManager(address(pm)), address(factory), address(escrow))
        );
        address derived = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, minedSalt, keccak256(initcode))))
            )
        );
        assertEq(derived, address(hook), "salt + creationCode artik bu adresi uretmiyor -- hook YENIDEN madenlenmeli");
        assertEq(
            uint160(derived) & Hooks.ALL_HOOK_MASK, ARCPAD_HOOK_FLAGS, "turetilen adres arcpad bayraklarini tasimiyor"
        );

        // ...VE ARTIK BIR LITERAL DE PINLENIYOR. Yukaridaki NatSpec "kanonik
        // adres yoktur ve olamaz" diyor; Task 7'nin dortlusu sabitlendigi
        // icin bu ARTIK DOGRU DEGILDIR ve pin `PoolDeployLib`tedir.
        assertEq(
            keccak256(type(ArcpadHook).creationCode),
            PoolDeployLib.ARC_HOOK_CREATION_CODE_HASH,
            "bu paketin sinadigi hook bytecode'u DeployPool'un yayinlayacagi bytecode DEGIL"
        );

        // KONTROL: turetme GERCEKTEN initcode'a duyarli. Bir bayt eklemek
        // adresi degistirmeli; degistirmiyorsa yukaridaki esitlik bir
        // TESADUFTUR ve hicbir sey olcmez.
        address perturbed = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            CREATE2_DEPLOYER,
                            minedSalt,
                            keccak256(abi.encodePacked(initcode, bytes1(0x00)))
                        )
                    )
                )
            )
        );
        assertTrue(perturbed != address(hook), "turetme initcode'a duyarsiz -- test hicbir sey olcmuyor");
    }

    function test_everyOtherPermissionIsFalse() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize);
        assertFalse(p.afterInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertTrue(p.beforeSwap);
        assertTrue(p.afterSwap);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertTrue(p.beforeSwapReturnDelta);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);
    }

    // ---------------------------------------------------------------
    // beforeInitialize -- fazin en keskin saldirisi
    // ---------------------------------------------------------------

    /// ONCELIK SIRASI SALDIRISI. Bu kanca olmadan HERKES, graduation'dan
    /// ONCE, arcpad'in `PoolKey`ini cop bir fiyatla acabilir ve o launch'i
    /// KALICI OLARAK tuglalastirabilirdi.
    function test_anyoneOtherThanTheGraduationTargetCannotInitializeAnArcpadKey() public {
        vm.prank(ATTACKER);
        _expectHookRevert(ArcpadHook.NotGraduationTarget.selector);
        pm.initialize(key, openingPrice);

        // ...ve HEDEF ayni anahtari acabilir. Kontrol olmadan yukaridaki
        // revert "herhangi bir sebeple" olabilirdi.
        locker.initialize(key, openingPrice);
        (uint160 got,,,) = pm.getSlot0(key.toId());
        assertEq(got, openingPrice);
    }

    function test_aKeyWithTheZeroAddressIsRejectedByTheHook() public {
        PoolKey memory bad = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(GraduationMath.QUOTE),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        _expectHookRevert(ArcpadHook.ZeroCurrency.selector);
        locker.initialize(bad, openingPrice);
    }

    function test_aKeyWithoutTheUsdcLegIsRejected() public {
        PoolKey memory bad = PoolKey({
            currency0: Currency.wrap(address(0x11)),
            currency1: Currency.wrap(address(0x22)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        _expectHookRevert(ArcpadHook.QuoteLegMissing.selector);
        locker.initialize(bad, openingPrice);
    }

    function test_aKeyWithNonZeroFeeIsRejected() public {
        PoolKey memory bad = key;
        bad.fee = 3000;
        _expectHookRevert(ArcpadHook.WrongPoolFee.selector);
        locker.initialize(bad, openingPrice);
    }

    function test_aKeyWithTheWrongTickSpacingIsRejected() public {
        PoolKey memory bad = key;
        bad.tickSpacing = 10;
        _expectHookRevert(ArcpadHook.WrongTickSpacing.selector);
        locker.initialize(bad, openingPrice);
    }

    /// SAHTE TOKEN, SABIT GAZLI KANONIKLIK KANITIYLA REDDEDILIR.
    /// Faz 1c'nin saldirisi: gercek bir curve'u IDDIA EDEN, factory'nin
    /// uretmedigi bir `LaunchToken`. `feeScheduleOf` onu TEK `SLOAD` ile
    /// eler; `isCanonical` cagirmak sinirsiz gazli bir griefing yuzeyi
    /// olurdu.
    function test_aForgedTokenIsRejectedByTheFeeScheduleLookup() public {
        LaunchToken forged = new LaunchToken("Arc", "ARC", "ipfs://x", CREATOR, curve, bytes32(0));
        assertEq(factory.feeScheduleOf(address(forged)), address(0), "sahte token schedule tasiyor");

        (PoolKey memory bad,) = GraduationMath.poolKey(address(forged), IHooks(address(hook)));
        _expectHookRevert(ArcpadHook.TokenNotFromFactory.selector);
        locker.initialize(bad, openingPrice);
    }

    /// INVARIANT 6, IKINCI KATMAN. Oldurdugu mutant "dogru hesapladi,
    /// BASKASINI gecirdi"dir -- tek katmanda gorunmez.
    function test_aPriceThatIsNotTheCurveClosingPriceIsRejected() public {
        _expectHookRevert(ArcpadHook.PriceIsNotTheCurveClosingPrice.selector);
        locker.initialize(key, openingPrice + 1);

        // KONTROL: dogru fiyatla GECER.
        locker.initialize(key, openingPrice);
    }

    /// Hook havuzu `configOf`a yazar ve swap yolu bir daha hicbir sey
    /// sorgulamaz -- sabit gazin tamami buradan gelir.
    function test_theConfigIsWrittenOnceAtInitialize() public {
        _openPool();
        (address base, address creator_, address sched, bool q0) = hook.configOf(key.toId());
        assertEq(base, token);
        assertEq(creator_, CREATOR);
        assertEq(sched, address(schedule));
        assertEq(q0, quoteIsCurrency0);
    }

    /// `beforeSwap` HEDEFE BAKMAZ. Hedef yeniden yonlendirildiginde ESKI
    /// locker'in actigi havuzlar CALISMAYA DEVAM ETMEK ZORUNDADIR.
    function test_swapsKeepWorkingAfterTheGraduationTargetIsRepointed() public {
        _openPool();
        _fundHarness();

        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(0x11E11));
        vm.warp(block.timestamp + 3 days);
        factory.applyGraduationTarget();

        uint256 before = escrow.owed(TREASURY);
        harness.swap(key, quoteIsCurrency0, -1_000_000);
        assertGt(escrow.owed(TREASURY), before, "yeniden yonlendirmeden sonra swap ucret uretmedi");
    }

    // ---------------------------------------------------------------
    // TREASURY ROTASYONU -- ONBELLEK GERI GELIRSE BU TEST DUSER
    // ---------------------------------------------------------------

    /// @notice Governor treasury'yi dondurdukten sonra hook YENISINE oder ve
    ///         eskisine ARTIK HIC odemez.
    ///
    /// @dev BU TEST BIR ONBELLEGIN VARLIGINI OLCER, YOKLUGUNU DEGIL, VE FARK
    ///      TASIYICIDIR. Hook `protocolTreasury`yi `immutable` tutuyordu;
    ///      `LaunchFactory.setProtocolTreasury` HER CURVE'E ulasip HICBIR
    ///      HAVUZA ulasmiyordu. Hook'un adresi `PoolKey`in bir alani
    ///      oldugundan bu, Task 7'nin ilk graduation'indan sonra
    ///      DUZELTILEMEZ hale gelirdi: her havuz ucretini eski -- ya da ele
    ///      gecirilmis -- treasury'ye sonsuza kadar oderdi.
    ///
    /// @dev UC IDDIA VE UCU DE GEREKLI:
    ///        (1) YENI treasury'nin alacagi ARTAR. Tek basina yetmez: hook
    ///            ikisine birden odese de gecerdi.
    ///        (2) ESKI treasury'nin alacagi ROTASYONDAN SONRA HIC ARTMAZ.
    ///            Onbellekli hal tam olarak buradan duser.
    ///        (3) ROTASYONDAN ONCE eski treasury'nin GERCEKTEN artmis olmasi.
    ///            Bu KONTROL GRUBUDUR: onsuz, ucreti hic almayan bir hook da
    ///            (2)'yi saglar ve test hicbir sey olcmedigi halde gecer --
    ///            deponun kendi adlandirdigi "hicbir sey yapmayan kontrat
    ///            butun guvenlik iddialarini saglar" kipi.
    function test_theHookPaysTheROTATEDTreasuryBecauseItNeverCachesIt() public {
        _openPool();
        _fundHarness();

        address newTreasury = address(0x0EDDEC0DE);

        // (3) KONTROL: rotasyondan ONCE eski treasury ucret ALIYOR.
        uint256 oldBefore = escrow.owed(TREASURY);
        harness.swap(key, quoteIsCurrency0, -1_000_000);
        uint256 oldAfterFirstSwap = escrow.owed(TREASURY);
        assertGt(oldAfterFirstSwap, oldBefore, "kontrol grubu: hook rotasyondan ONCE de odemiyor -- test bos");

        vm.prank(GOVERNOR);
        factory.setProtocolTreasury(newTreasury);
        assertEq(factory.protocolTreasury(), newTreasury, "rotasyon factory'ye inmedi");
        // Hook'un KENDI getter'i da canli okumali; `configOf` bir kopya tasimaz.
        assertEq(hook.protocolTreasury(), newTreasury, "hook hala eski treasury'yi bildiriyor");

        uint256 newBefore = escrow.owed(newTreasury);
        harness.swap(key, quoteIsCurrency0, -1_000_000);

        // (1) YENI alici odendi.
        assertGt(escrow.owed(newTreasury), newBefore, "rotasyondan sonra YENI treasury odenmedi");
        // (2) ESKI alici ARTIK ODENMIYOR -- onbellek geri gelirse burasi duser.
        assertEq(
            escrow.owed(TREASURY),
            oldAfterFirstSwap,
            "ESKI treasury rotasyondan sonra da odendi -- hook adresi onbellekliyor"
        );
    }

    /// @notice Rotasyon, ZATEN ACILMIS bir havuzda da isler.
    /// @dev `configOf` havuz basina BIR KEZ yazilir; treasury oraya girseydi
    ///      rotasyon yalnizca SONRAKI havuzlara ulasirdi ve bu test onu
    ///      `PoolConfig`in dort alanindan bagimsiz olarak yakalar.
    function test_aRotationReachesAPoolThatWasOpenedBeforeIt() public {
        _openPool();
        _fundHarness();

        address newTreasury = address(0x0B0BFACE);
        vm.prank(GOVERNOR);
        factory.setProtocolTreasury(newTreasury);

        uint256 before = escrow.owed(newTreasury);
        harness.swap(key, !quoteIsCurrency0, int256(1_000_000)); // OBUR sekil
        assertGt(escrow.owed(newTreasury), before, "rotasyon acilmis havuza ulasmadi");
    }

    // ---------------------------------------------------------------
    // Ucret: dort seklin dordu de -- OLCUM ZORUNLULUGU
    // ---------------------------------------------------------------

    /// @dev DORT SEKLIN TABLOSU VENDORED KAYNAKTAN TURETILDI; BU DORT TEST O
    ///      TURETMENIN OLCUMUDUR. Tablo yanlissa ogrenilmesi gereken an
    ///      burasidir -- hook madenlenip deploy edildikten sonrasi YOKTUR.
    function _swapAndMeasure(bool zeroForOne, int256 amountSpecified)
        internal
        returns (uint256 protocolGain, uint256 creatorGain, uint256 hookTokenBalance)
    {
        uint256 p0 = escrow.owed(TREASURY);
        uint256 c0 = escrow.owed(CREATOR);
        harness.swap(key, zeroForOne, amountSpecified);
        protocolGain = escrow.owed(TREASURY) - p0;
        creatorGain = escrow.owed(CREATOR) - c0;
        hookTokenBalance = IERC20(token).balanceOf(address(hook));
    }

    /// quote SPECIFIED -> `beforeSwap`.
    function test_exactInputBuyChargesTheFeeInUsdcViaBeforeSwap() public {
        _openPool();
        _fundHarness();
        (uint256 p, uint256 c, uint256 tokBal) = _swapAndMeasure(quoteIsCurrency0, -1_000_000);
        assertEq(p, uint256(9_500) * 1e12, "protokol payi 95 bps degil");
        assertEq(c, uint256(3_000) * 1e12, "creator payi 30 bps degil");
        assertEq(tokBal, 0, "hook launch tokeni tuttu");
    }

    /// quote SPECIFIED, exact-output -> `beforeSwap`.
    function test_exactOutputSellChargesTheFeeInUsdcViaBeforeSwap() public {
        _openPool();
        _fundHarness();
        (uint256 p, uint256 c, uint256 tokBal) = _swapAndMeasure(!quoteIsCurrency0, int256(1_000_000));
        assertEq(p, uint256(9_500) * 1e12);
        assertEq(c, uint256(3_000) * 1e12);
        assertEq(tokBal, 0);
    }

    /// quote UNSPECIFIED -> `afterSwap`. Miktar ancak swap'ten SONRA bilinir.
    function test_exactInputSellChargesTheFeeInUsdcViaAfterSwap() public {
        _openPool();
        _fundHarness();

        uint256 p0 = escrow.owed(TREASURY);
        uint256 c0 = escrow.owed(CREATOR);
        BalanceDelta delta = harness.swap(key, !quoteIsCurrency0, -int256(1_000e18));
        uint256 p = escrow.owed(TREASURY) - p0;
        uint256 c = escrow.owed(CREATOR) - c0;

        // Quote miktari ancak swap'ten SONRA bilinir; olculen deltadan
        // okunur ve ucret ONUN uzerinden TAM olarak dogrulanir.
        int128 qd = quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        uint256 quoteOut = uint256(int256(qd < 0 ? -qd : qd));
        assertGt(quoteOut, 0, "swap quote uretmedi -- test hicbir sey olcmuyor");

        // Ucretten SONRAKI cikti = brut - ucret, yani brut = quoteOut + ucret.
        uint256 gross = quoteOut + (p + c) / 1e12;
        assertEq(p, CurveMath.feeOn(gross, 95) * 1e12, "afterSwap protokol payi");
        assertEq(c, CurveMath.feeOn(gross, 30) * 1e12, "afterSwap creator payi");
        assertEq(IERC20(token).balanceOf(address(hook)), 0, "hook launch tokeni tuttu");
    }

    /// quote UNSPECIFIED, exact-output -> `afterSwap`.
    function test_exactOutputBuyChargesTheFeeInUsdcViaAfterSwap() public {
        _openPool();
        _fundHarness();
        (uint256 p, uint256 c, uint256 tokBal) = _swapAndMeasure(quoteIsCurrency0, int256(1_000e18));
        assertGt(p, 0);
        assertGt(c, 0);
        assertEq(tokBal, 0);
    }

    /// "USDC alindi" iddiasi, token'dan DA alinmis olsaydi bile gecerdi.
    /// Bu yuzden dort seklin DORDUNDE de token bakiyesi ayrica sifirlanir.
    function test_noFeeIsEverTakenInTheLaunchToken() public {
        _openPool();
        _fundHarness();
        harness.swap(key, quoteIsCurrency0, -1_000_000);
        harness.swap(key, !quoteIsCurrency0, int256(1_000_000));
        harness.swap(key, !quoteIsCurrency0, -int256(1_000e18));
        harness.swap(key, quoteIsCurrency0, int256(1_000e18));
        assertEq(IERC20(token).balanceOf(address(hook)), 0, "hook launch tokeni tuttu");
        assertEq(IERC20(token).balanceOf(address(escrow)), 0, "escrow launch tokeni tuttu");
    }

    /// UCRET PARCALARDAN TOPLANIR, TOPLAMDAN BOLUNMEZ.
    ///   feeOn(1_000_001, 95) + feeOn(1_000_001, 30) = 9_501 + 3_001 = 12_502
    ///   feeOn(1_000_001, 125)                       = 12_501
    /// Fark her seferinde protokolun ALEYHINEDIR.
    function test_feeIsSummedFromPartsNotDividedFromTheTotal() public {
        _openPool();
        _fundHarness();
        assertEq(CurveMath.feeOn(1_000_001, 95) + CurveMath.feeOn(1_000_001, 30), 12_502);
        assertEq(CurveMath.feeOn(1_000_001, 125), 12_501);

        (uint256 p, uint256 c,) = _swapAndMeasure(quoteIsCurrency0, -int256(1_000_001));
        assertEq((p + c) / 1e12, 12_502, "ucret toplamdan bolunmus");
    }

    /// CREATOR SIFIR OLAMAZ -- VE BU ULASILAMAZLIK IDDIA EDILIYOR, TESTI
    /// UYDURULMUYOR.
    ///
    /// Hook'un `cfg.creator == address(0)` terneri curve'un kuralini yansitir
    /// (creator payi ALINMAZ ve protokol payina KATLANMAZ), ama KANONIK
    /// YOLDAN ULASILAMAZ: `LaunchToken`in constructor'i `creator_ == 0`i
    /// `ZeroCreator()` ile reddeder, ve hook YALNIZCA factory'nin urettigi
    /// token'lari kabul eder (`feeScheduleOf` kontrolu). Dolayisiyla hicbir
    /// kayitli havuzun creator'i sifir olamaz.
    ///
    /// Ternerin BIRAKILMA sebebi: curve'un kendisi (factory'siz, ciplak
    /// deploy edilmis hali) sifir creator'i DESTEKLER ve hook'un o kuraldan
    /// SESSIZCE ayrismasi istenmez. Ama "test ettim" demek yanlis olurdu.
    function test_aZeroCreatorPoolCannotExistBecauseTheTokenRejectsIt() public {
        vm.expectRevert(LaunchToken.ZeroCreator.selector);
        vm.prank(address(0));
        factory.launch("Zero", "ZRO", "ipfs://z");

        // ...ve kayitli havuzun creator'i gercekten sifir DEGIL.
        _openPool();
        (, address creator_,,) = hook.configOf(key.toId());
        assertTrue(creator_ != address(0), "kayitli havuzun creator'i sifir");
        assertEq(creator_, CREATOR);
    }

    /// IKI BAGIMSIZ YOL AYNI BUYUKLUGE VARIR -- ve NEREDE AYRISTIKLARI
    /// OLCULMUSTUR.
    ///
    /// `_marketCap` havuzun `slot0` FIYATINDAN hesaplar (hook'un ham rezervi
    /// YOKTUR: `PoolManager`in USDC bakiyesi TUM havuzlarin toplamidir).
    /// `FeeSchedule.marketCap` ise HAM REZERVLERDEN hesaplar.
    ///
    /// URETIM buyuklugunde ikisi TAM ESITTIR: 58_783_256_052.
    /// TESTNET buyuklugunde IKI BIRIM ayrisirlar: fiyat yolu 58_783_256,
    /// rezerv yolu 58_783_254 -- cunku rezerv yolu quote'u 6 decimal'e
    /// KIRPAR (12_161_433_369_060_378_707 wei -> 12_161_433 birim) ve
    /// kirpilan artik `369_060_378_707 / 1e12 = 0,369` birimdir; `N/D =
    /// 4,8335` ile carpilinca 1,78 -> tabana yuvarlamalarla 2 birim eder.
    /// URETIMDE ayni artik 0,0604 birimdir ve 0,29'a duser, yani kaybolur.
    ///
    /// TOLERANS BILINCLI SECILDI: mutlak fark `ceil(N/D) = 5` biriminden
    /// KUCUK olmali. Bu tureme sinirdir -- kirpma en fazla 1 birim quote
    /// kaybettirir, o da `N/D` katiyla market cap'e yansir. Genis bir
    /// "yaklasik esit" bandi gercek bir hatayi gizlerdi; bu sinir gizlemez.
    function test_theTwoMarketCapRoutesAgreeAtProductionAndDifferByTwoAtTestnet() public view {
        uint256 D = 206_886_011_183_597_390_493_942_218;

        // URETIM: tam esitlik.
        uint256 reserveProd = schedule.marketCap(12_161_433_369, D);
        assertEq(reserveProd, 58_783_256_052);
        assertEq(_priceRouteMarketCap(10333626601930376557517671504208461029, true), 58_783_256_052);
        assertEq(_priceRouteMarketCap(607444218490929862364, false), 58_783_256_052);

        // TESTNET: TAM OLARAK iki birim ayrisma.
        uint256 reserveTest = schedule.marketCap(12_161_433, D);
        assertEq(reserveTest, 58_783_254);
        uint256 priceTest = _priceRouteMarketCap(326777965518061118072680912817470217035, true);
        assertEq(priceTest, 58_783_256);
        assertEq(priceTest - reserveTest, 2, "iki yolun ayrismasi degismis");

        // ...ve turetilmis sinirin icinde.
        assertLt(priceTest - reserveTest, 5, "ayrisma turetilmis siniri asti");
    }

    /// `_marketCap`in aritmetigi, hook'a girmeden yeniden uretilir.
    function _priceRouteMarketCap(uint256 sqrtP, bool usdcIsCurrency0) internal pure returns (uint256) {
        uint256 priceX96 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 96);
        return usdcIsCurrency0 ? FullMath.mulDiv(1e27, 1 << 96, priceX96) : FullMath.mulDiv(1e27, priceX96, 1 << 96);
    }

    /// Mezuniyet aninda kademe 0'dir ve oranlar curve'unkiyle AYNIDIR.
    function test_theFirstPoolSwapPaysExactlyWhatTheLastCurveTradePaid() public {
        _openPool();
        (uint256 p, uint256 c) = schedule.tierFor(_priceRouteMarketCap(uint256(openingPrice), quoteIsCurrency0));
        assertEq(p, BondingCurve(curve).PROTOCOL_FEE_BPS());
        assertEq(c, BondingCurve(curve).CREATOR_FEE_BPS());
        assertEq(p, 95);
        assertEq(c, 30);
    }

    /// Havuz ucreti hicbir kosulda degistirilemez -- HOOK'UN KENDISI BILE.
    function test_evenTheHookCannotChangeThePoolFee() public {
        _openPool();
        vm.prank(address(hook));
        vm.expectRevert(IPoolManager.UnauthorizedDynamicLPFeeUpdate.selector);
        pm.updateDynamicLPFee(key, 3000);
    }

    /// LIKIDITE BAYRAKLARI YOKTUR ve bu BILINCLIDIR: ucuncu bir taraf
    /// arcpad havuzuna likidite ekleyip cikarabilir. "Likidite kalicidir"
    /// iddiasi ARCPAD'IN POZISYONU hakkindadir, havuzun tamami hakkinda degil.
    function test_thirdPartyLiquidityIsPermittedAndDoesNotTouchArcpadsPosition() public {
        _openPool();
        (uint128 before,,) =
            pm.getPositionInfo(key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, 0);
        assertGt(before, 0, "arcpad pozisyonu yok -- test hicbir sey olcmuyor");

        LockerStub lp = new LockerStub(pm, usdc);
        usdc.mint(address(lp), 1_000_000_000_000);
        deal(token, address(lp), 5e26, true);
        lp.addLiquidity(key, -600, 600, 1e12);

        (uint128 afterAdd,,) =
            pm.getPositionInfo(key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, 0);
        assertEq(afterAdd, before, "ucuncu tarafin eklemesi arcpad pozisyonunu degistirdi");

        lp.addLiquidity(key, -600, 600, -1e12);
        (uint128 afterRemove,,) =
            pm.getPositionInfo(key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, 0);
        assertEq(afterRemove, before, "ucuncu tarafin cikarmasi arcpad pozisyonunu degistirdi");
    }
}


/// ============================================================================
///  KANCALARA DOGRUDAN CAGRI: `onlyPoolManager` TASIYICIDIR
/// ============================================================================
///
/// `_beforeInitialize`in `sender` argumani BIR PARAMETREDIR, `msg.sender`
/// DEGIL -- `PoolManager` onu doldurur. Dolayisiyla kanca dogrudan
/// cagrilabilseydi, saldirgan `sender` yerine graduation hedefini YAZAR ve
/// "yalnizca hedef initialize edebilir" kontrolunu duz gecerdi.
///
/// Ayrimi tasiyan sey `BaseHook.onlyPoolManager`dir ve bu deponun kodunda
/// GORUNMEZ: bir bagimliligin modifier'idir. Denetim (ucuncu gecis) onu
/// testsiz buldu -- yani "kanca korunuyor" iddiasi bir OKUMAYA dayaniyordu,
/// bir olcume degil. Uc giris noktasinin ucu de burada yuruyor.
///
/// `_beforeSwap`/`_afterSwap` icin de ayni sey gecerlidir ve daha somuttur:
/// dogrudan cagirabilen biri `configOf`u okumadan ucret hesaplatabilir ya da
/// `take` cagrisini bir baska havuzun parasi uzerinde tetikleyebilirdi.
contract ArcpadHookDirectCallTest is ArcpadHookTest {
    function test_beforeInitializeRefusesEveryCallerButThePoolManager() public {
        (PoolKey memory key,) = _keyFor(address(token));
        uint160 price = GraduationMath.sqrtPriceX96(
            BondingCurve(payable(curve)).virtualQuoteReserves(),
            BondingCurve(payable(curve)).virtualTokenReserves(),
            Currency.unwrap(key.currency0) != GraduationMath.QUOTE
        );

        // SALDIRGAN, HEDEFIN KENDISINI `sender` OLARAK YAZIYOR. Kontrol
        // parametreye baktigi icin bu, korumayi TAM OLARAK atlatan cagridir.
        vm.prank(address(0xBAD));
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        IHooks(address(hook)).beforeInitialize(address(locker), key, price);
    }

    function test_beforeSwapAndAfterSwapRefuseDirectCalls() public {
        (PoolKey memory key,) = _keyFor(address(token));
        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -1e6, sqrtPriceLimitX96: 0});

        vm.prank(address(0xBAD));
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        IHooks(address(hook)).beforeSwap(address(0xBAD), key, params, "");

        vm.prank(address(0xBAD));
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        IHooks(address(hook)).afterSwap(address(0xBAD), key, params, BalanceDelta.wrap(0), "");
    }
}
