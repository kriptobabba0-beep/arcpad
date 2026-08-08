// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {PoolDeployLib} from "../../script/PoolDeployLib.sol";
import {DeployLib} from "../../script/DeployLib.sol";
import {ArcpadHook} from "../../src/ArcpadHook.sol";
import {ArcpadLocker} from "../../src/ArcpadLocker.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeSchedule} from "../../src/FeeSchedule.sol";
import {GraduationMath} from "../../src/libraries/GraduationMath.sol";

interface IEscrowView {
    function owed(address) external view returns (uint256);
}

interface IVmDeal {
    function deal(address, uint256) external;
}

/// @notice Arc'in `0x1800...` NATIVE VARLIK PRECOMPILE'ININ yerine gecen tek
///         parca. FORK'UN SAGLAYAMADIGI TEK SEY BUDUR ve baska hicbir sey
///         degistirilmez.
///
/// @dev NICIN GEREKLI, OLCUMLE. Canli `0x3600...` bir PROXY'dir; implementasyon
///      `0xC6AD664ac6679F4Ce74e10E91449C93Ec1ae3cA6`, ve `transfer` orada
///      `0x1800...`e `transfer(address,address,uint256)` ile 18-DECIMAL
///      miktar gecerek iner. O adresin zincirdeki kodu TEK BAYT (`0x01`);
///      gercek davranis dugumun kendisindedir. revm o bayti `ADD` olarak
///      calistirir ve `StackUnderflow` ile duser -- yani sim OLMADAN canli
///      USDC bir fork'ta HIC transfer edemez (olculdu, iz kaydedildi).
///
/// @dev SIMIN SOZLESMESI OLCULDU, TAHMIN EDILMEDI: 18-decimal miktari
///      kaynaktan hedefe tasir ve `true` doner. USDC implementasyonunun KENDI
///      kodu -- 6-decimal donusum, `Transfer` olayi, allowance defteri --
///      YERINDE KALIR ve gercekten calisir.
///
/// @dev SIM BLOKLAMA LISTESI UYGULAMAZ VE UYGULAMAMALIDIR. Olculdu: sim
///      takiliyken bloklu adrese ERC-20 transferi BASARIR, sim yokken canli
///      dugum ayni cagriyi `Error("Blocked address")` ile reddeder --
///      dolayisiyla bloklama TAM OLARAK bu precompile'in ARKASINDADIR. Simin
///      onu taklit etmesi, gercek kodun isini yapan bir sahte olurdu; bu
///      yuzden bloklama iddiasi fork'ta DEGIL, `vm.rpc` ile CANLI DUGUMDE
///      olculur.
contract ArcNativeAssetPrecompileShim {
    IVmDeal private constant VM = IVmDeal(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function transfer(address from, address to, uint256 amount) external returns (bool) {
        require(from.balance >= amount, "shim: insufficient native balance");
        VM.deal(from, from.balance - amount);
        VM.deal(to, to.balance + amount);
        return true;
    }

    /// @dev GURULTULU DUSER. Sessiz bir `fallback` simin eksik bir uyesini
    ///      "bos donus" olarak gecirir ve testi hicbir sey olcmeden yesil
    ///      birakirdi.
    fallback() external {
        revert("shim: the live USDC reached an unmodelled precompile member");
    }
}

/// @notice Odemeyi REDDEDEN graduation hedefi.
/// @dev Arc'in bloklama listesinin GOZLENEN etkisi budur: `graduate()`in
///      `target.call{value: R}("")` bacagi `ok = false` doner. Bloklamanin
///      KENDISI dugum seviyesindedir ve fork'ta yoktur (olculdu); burada
///      olculen sey, curve'un O BASARISIZLIGI nasil ele aldigidir.
contract PayoutRejectingTarget {
    error Rejected();

    function graduate(address curve) external returns (uint256, uint256) {
        return BondingCurve(payable(curve)).graduate();
    }

    receive() external payable {
        revert Rejected();
    }
}

/// @notice Havuza karsi gercek bir swap yapar.
contract SwapHarness is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) external returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountSpecified)), (BalanceDelta));
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
            uint256 owedAmount = uint256(int256(-amt));
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(pm), owedAmount);
            pm.settle();
        } else {
            pm.take(c, address(this), uint256(int256(amt)));
        }
    }
}

/// @title GraduationCycleLiveForkTest -- Task 8, ALT KATMAN B
/// @notice R-12'nin prosedurunun CALISTIRILABILIR hali: launch -> satis arzini
///         tuket -> graduate -> havuz var, CANLI Arc testnet durumuna karsi.
///
/// @dev CI'DA KOSMAZ VE BU BIR TAVIZ DEGIL. Kontrat adi `...LiveForkTest`tir
///      ve hem `make fork-test` hem CI'in fork isi `--no-match-contract
///      'LiveForkTest'` ile onu DISLAR; `make fork-test-live` yalnizca onu
///      kosar. Dosya `test/fork/` altinda durur, dolayisiyla fork'suz paket
///      (`--no-match-path 'test/fork/*'`) da onu ZATEN dislar -- iki filtre
///      birbirinin TUMLEYENI oldugu icin tek basina yol ayrimi YETMEZDI ve
///      ilk tasarim tam da orada delik birakiyordu.
///
/// @dev BRIEFTEKI "FONLU ANAHTAR / FAUCET USDC / HER KOSU BIR LAUNCH TUKETIR"
///      PREMISI YANLIS VE SEBEBI YAPISALDIR. Bir factory'nin graduation hedefi
///      ANCAK `proposeGraduationTarget` + `GRADUATION_TARGET_DELAY` (UC GUN) +
///      `applyGraduationTarget` ile silahlanir, ve gecikme GECICI bir factory
///      icin de aynen gecerlidir. Yani "tam dongu" TEK BIR OTURUMDA ZINCIRE
///      YAYINLANAMAZ. Fork -- yerel EVM + UZAK DURUM -- bu donguyu bugun
///      calistirabilen TEK bicimdir, ve `vm.warp` gecikmeyi yerelde gecer.
///      Bedeli sifirdir; hicbir launch tuketilmez, hicbir USDC harcanmaz.
///
/// @dev O HALDE FORK NEYI OLCER, YEREL PAKETIN OLCMEDIGI: CANLI `PoolManager`
///      (0x617321...), CANLI `FeeEscrow`, CANLI `FeeSchedule`, ve CANLI USDC
///      proxy + implementasyonunun KENDI KODU. Yerel pakette bunlarin hepsi
///      taze deploy ya da mock'tur.
///
/// @dev ...VE FORK'UN OLCEMEDIGI IKI SEY ACIKCA ISARETLENIR, cunku sessiz
///      birakilirlarsa "hicbir seyi olcmeyen yesil test" olurlar:
///        (1) EIP-7708 `Transfer` loglari NODE tarafindan uretilir, EVM
///            tarafindan degil -- fork'ta HIC gorunmezler.
///        (2) Bloklama listesi `0x1800...` precompile'inin arkasindadir --
///            fork'ta HIC uygulanmaz.
///      Ikisi de bu dosyada CANLI DUGUME sorulur (`vm.eth_getLogs`, `vm.rpc`),
///      taklit edilmez.
contract GraduationCycleLiveForkTest is Test {
    using StateLibrary for IPoolManager;

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant NATIVE_ASSET_PRECOMPILE = 0x1800000000000000000000000000000000000000;

    /// @notice EIP-7708'in SISTEM EMITTER'I. OLCULDU, TAHMIN EDILMEDI.
    /// @dev Brief "sistem emitter, 18 decimal" diyor ama iddia sozlesmesinde
    ///      onu yalnizca `emitter != 0x3600...` ile tarif ediyor -- yani
    ///      ADRESI HIC PINLEMIYOR ve dunyadaki her kontrat o testi gecerdi.
    ///      Canli olcum (Faz 1 smoke makbuzlari + bu gorevin kendi islemi):
    ///      emitter TAM OLARAK `0xffff...fffe`dir.
    address internal constant EIP7708_EMITTER = 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE;

    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

    /// @notice Bloklu adres, Arc testnet'te FIILEN bloklu (olculdu).
    address internal constant BLOCKED = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    // ---------------------------------------------------------------
    // CANLI CIFT GORUNUM ISLEMI -- PIN
    // ---------------------------------------------------------------
    //
    // 2026-08-09'da bu gorev tarafindan yayinlandi: deployer'dan `0x...dEaD`e
    // 1 birimlik ERC-20 USDC transferi. TEK BIR HAREKET, IKI `Transfer` LOGU.
    // Idempotenttir ve bedavadir: sabit bir GECMIS blok okunur.
    uint256 internal constant DOUBLE_VIEW_BLOCK = 56_010_289;
    bytes32 internal constant DOUBLE_VIEW_TX = 0x864671a6481ef3753186815b9c610607796df2bf71f88dc5aafea1a97cade770;
    address internal constant DOUBLE_VIEW_FROM = 0xe92c64C4f36216eA773f2622f6D5f8530Ae92fD2;
    address internal constant DOUBLE_VIEW_TO = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant DOUBLE_VIEW_UNITS = 1;
    uint256 internal constant DOUBLE_VIEW_WEI = 1e12;

    // ---------------------------------------------------------------
    // TESTNET PROFILI VE KAPANIS DEGERLERI
    // ---------------------------------------------------------------
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;
    uint256 internal constant D = 206_886_011_183_597_390_493_942_218;

    /// Kapanistaki `realQuoteReserves`. `MIN_GRADUATION_RAISE`in +1'i.
    uint256 internal constant R = 12_161_433_369_060_378_707;
    /// ...ve onun 6-decimal gorunumu. `R / 1e12`, TABANA yuvarli.
    uint256 internal constant R6 = 12_161_433;
    /// ...ve aradaki, locker'da KALICI kalan artik.
    uint256 internal constant QUOTE_RESIDUE = 369_060_378_707;

    uint160 internal constant SQRT_TOKEN_IS_CURRENCY0 = 19_209_072_819_323_074_681;
    uint160 internal constant SQRT_USDC_IS_CURRENCY0 = 326_777_965_518_061_118_072_680_912_817_470_217_035;

    /// @notice Tohumlanan tam aralik pozisyonun likiditesi.
    /// @dev TEK BIR SAYIDIR VE BU BIR OLCUM SONUCUDUR, VARSAYIM DEGIL. Faz
    ///      2'nin tamamlanma olcutu "IKI `L` degeri" diyor; olculdu, ikisi
    ///      ESIT. Sebep `getLiquidityForAmounts`in tam aralikta simetrik
    ///      olmasidir: siralama hem fiyati hem miktar ciftini birlikte ters
    ///      cevirir. Iki dal `test_theTwoSeedLiquidityValuesAreThePinnedOnes`
    ///      icinde AYRI AYRI turetilir, yani esitlik VARSAYILMAZ, iddia
    ///      edilir -- ayrisirlarsa orasi kirmizi olur.
    uint128 internal constant L = 50_160_046_734_639_668;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0FFEE);
    address internal constant DISPOSABLE_GOVERNOR = address(0x600D);
    address internal constant DISPOSABLE_TREASURY = address(0x7EA5);

    // CANLI, defterden.
    IPoolManager internal pm;
    address internal liveEscrow;
    address internal liveFeeSchedule;
    address internal liveFactory;
    address internal liveHook;
    address internal liveLocker;

    // GECICI. Hicbiri zincire yayinlanmaz.
    LaunchFactory internal factory;
    ArcpadHook internal hook;
    ArcpadLocker internal locker;

    function setUp() public {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "this suite is meaningless off Arc testnet");

        string memory json = vm.readFile("deploy/addresses.5042002.json");
        pm = IPoolManager(vm.parseJsonAddress(json, ".poolManager"));
        liveEscrow = vm.parseJsonAddress(json, ".feeEscrow");
        liveFeeSchedule = vm.parseJsonAddress(json, ".feeSchedule");
        liveFactory = vm.parseJsonAddress(json, ".launchFactory");
        liveHook = vm.parseJsonAddress(json, ".arcpadHook");
        liveLocker = vm.parseJsonAddress(json, ".arcpadLocker");

        _installNativeAssetShim();
        _deployDisposableStack();
    }

    // ---------------------------------------------------------------
    // Kurulum
    // ---------------------------------------------------------------

    function _installNativeAssetShim() internal {
        vm.etch(NATIVE_ASSET_PRECOMPILE, address(new ArcNativeAssetPrecompileShim()).code);
        vm.allowCheatcodes(NATIVE_ASSET_PRECOMPILE);
    }

    /// @dev GERCEK FABRIKAYA HIC DOKUNULMAZ. `applyGraduationTarget` IZINSIZDIR
    ///      ve ilk graduation havuzu acarak HOOK ADRESINI KALICI OLARAK
    ///      DONDURUR; uretim fabrikasinin hedefini burada silahlamak, o kararin
    ///      geri donusu olmayan halini bir teste gomerdi. Bu yuzden dongu
    ///      KENDI fabrikasi, KENDI hook'u ve KENDI locker'i uzerinde yurur --
    ///      ama CANLI `PoolManager`, CANLI `FeeEscrow` ve CANLI `FeeSchedule`
    ///      ile.
    function _deployDisposableStack() internal {
        factory = new LaunchFactory(liveEscrow, DISPOSABLE_TREASURY, DISPOSABLE_GOVERNOR, T, V, S, liveFeeSchedule);

        bytes memory args = abi.encode(pm, address(factory), liveEscrow);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, PoolDeployLib.ARCPAD_HOOK_FLAGS, type(ArcpadHook).creationCode, args);
        vm.prank(CREATE2_DEPLOYER);
        hook = new ArcpadHook{salt: salt}(pm, address(factory), liveEscrow);
        require(address(hook) == hookAddr, "mined hook address diverged");

        locker = new ArcpadLocker(pm, address(factory), IHooks(address(hook)));

        vm.prank(DISPOSABLE_GOVERNOR);
        factory.proposeGraduationTarget(address(locker));
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();
    }

    /// @dev Istenen SIRALAMAYA dusen bir aday adi arar. BULAMAZSA TEST DUSER --
    ///      aksi halde test hicbir sey kanitlamadan gecerdi.
    function _nameForOrdering(bool wantBaseIsCurrency0) internal view returns (string memory) {
        uint256 nonce = factory.launchCount();
        for (uint256 i = 0; i < 256; ++i) {
            string memory candidate = string.concat("ARC", vm.toString(i));
            (address predicted,) = factory.predictAddresses(CREATOR, candidate, "ARC", "ipfs://x", nonce);
            if ((predicted < GraduationMath.QUOTE) == wantBaseIsCurrency0) return candidate;
        }
        revert("no candidate name lands in the requested currency ordering");
    }

    function _launchAndBuyOut(string memory name) internal returns (address token, address payable curve) {
        vm.prank(CREATOR);
        (address t, address c) = factory.launch(name, "ARC", "ipfs://x");
        token = t;
        curve = payable(c);

        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(curve).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);
    }

    function _keyOf(address token) internal view returns (PoolKey memory key, bool baseIsCurrency0) {
        (key, baseIsCurrency0) = GraduationMath.poolKey(token, IHooks(address(hook)));
    }

    // ---------------------------------------------------------------
    // 0. NE OLCTUGUMUZUN ON KOSULLARI -- VAKUM BEKCILERI
    // ---------------------------------------------------------------

    /// @dev BU TESTIN ISI, GERI KALAN HERSEYIN "GERCEK KOD" IDDIASINI
    ///      TASIMAKTIR. Fork bir bytecode'u YEREL olarak calistirir; hangi
    ///      bytecode oldugu ayri bir sorudur ve burada CEVAPLANIR: bu derleme
    ///      biriminin gordugu `ArcpadHook` ve `ArcpadLocker` creation code'u,
    ///      canli adreslerdekini UREteN creation code'un TA KENDISIDIR --
    ///      cunku ayni tuz + ayni initcode ayni adresi verir, ve o adreste kod
    ///      vardir.
    function test_theDisposableStackIsTheDeployedBytecode() public view {
        address rederivedHook = PoolDeployLib.predict(
            PoolDeployLib.ARC_HOOK_SALT, PoolDeployLib.hookInitcode(address(pm), liveFactory, liveEscrow)
        );
        assertEq(rederivedHook, liveHook, "this unit's ArcpadHook creation code is not the deployed one");
        assertGt(liveHook.code.length, 0, "the derived hook address has no code");

        address rederivedLocker = PoolDeployLib.predict(
            PoolDeployLib.LOCKER_SALT, PoolDeployLib.lockerInitcode(address(pm), liveFactory, liveHook)
        );
        assertEq(rederivedLocker, liveLocker, "this unit's ArcpadLocker creation code is not the deployed one");
        assertGt(liveLocker.code.length, 0, "the derived locker address has no code");

        assertEq(
            keccak256(type(ArcpadHook).creationCode),
            PoolDeployLib.ARC_HOOK_CREATION_CODE_HASH,
            "ArcpadHook creation code moved away from the shipped pin"
        );
    }

    /// @dev SIM'IN GEREKLI OLDUGU OLCULUR, VARSAYILMAZ. Sim yokken canli USDC
    ///      transferi DUSER; takiliyken BASARIR ve tek bir 6-decimal `Transfer`
    ///      uretir. Bu test olmadan, sim ileride gereksizlesse bile kimse fark
    ///      etmezdi -- ve "gereksiz bir sahte" bu depoda bir bulgudur.
    function test_theOnlyThingTheForkCannotProvideIsArcsNativeAssetPrecompile() public {
        address a = address(0xA11CE);
        address b = address(0xB0B);
        vm.deal(a, 5e18);

        // Zincirdeki `0x1800...` TEK BAYTLIK bir isarettir; gercek davranis
        // dugumdedir.
        assertEq(
            keccak256(NATIVE_ASSET_PRECOMPILE.code),
            keccak256(address(new ArcNativeAssetPrecompileShim()).code),
            "the shim is not installed where the test claims"
        );

        vm.prank(a);
        assertTrue(IERC20(GraduationMath.QUOTE).transfer(b, 1_000_000), "live USDC transfer failed under the shim");
        assertEq(b.balance, 1e18, "the shim did not move 18-decimal native balance");
        assertEq(IERC20(GraduationMath.QUOTE).balanceOf(b), 1_000_000, "the 6-decimal view disagrees");

        // ...VE SIM KALDIRILDIGINDA AYNI CAGRI DUSER. Kontrol grubu olmadan
        // yukaridaki satirlar simin GEREKLI oldugunu degil yalnizca ZARARSIZ
        // oldugunu soylerdi.
        vm.etch(NATIVE_ASSET_PRECOMPILE, hex"01");
        vm.prank(a);
        (bool ok,) = GraduationMath.QUOTE.call(abi.encodeWithSelector(IERC20.transfer.selector, b, uint256(1_000_000)));
        assertFalse(ok, "live USDC transferred without Arc's native-asset precompile -- the shim measures nothing");
    }

    // ---------------------------------------------------------------
    // 1. TAM GRADUATION DONGUSU
    // ---------------------------------------------------------------

    /// LAUNCH -> SATIS ARZINI TUKET -> GRADUATE -> HAVUZ VAR.
    ///
    /// @dev IKI SIRALAMANIN IKISI DE YURUNUR ve bu brief'ten daha genistir:
    ///      brief "dort literalden BIRINE esit" diyor, yani tek bir kosuda
    ///      hangi siralamanin dustugu SANSA kalirdi. Faz 2'nin tamamlanma
    ///      olcutu ise "her iki para birimi siralamasi icin tam bir graduation
    ///      dongusu yesil" diyor; bu test onu karsilar.
    function test_fullGraduationCycleAgainstTheDeployedContracts() public {
        _runCycle(false, SQRT_USDC_IS_CURRENCY0);
        _runCycle(true, SQRT_TOKEN_IS_CURRENCY0);
    }

    function _runCycle(bool wantBaseIsCurrency0, uint160 expectedSqrtPrice) internal {
        (address token, address payable curve) = _launchAndBuyOut(_nameForOrdering(wantBaseIsCurrency0));

        assertTrue(BondingCurve(curve).complete(), "the curve did not complete on a full-supply buy");
        assertEq(BondingCurve(curve).realQuoteReserves(), R, "the closing raise is not the pinned value");
        assertGe(
            BondingCurve(curve).realQuoteReserves(),
            factory.MIN_GRADUATION_RAISE(),
            "the completed curve did not reach the graduation raise"
        );
        assertFalse(BondingCurve(curve).graduated(), "the curve graduated before the locker was called");

        (PoolKey memory key, bool baseIsCurrency0) = _keyOf(token);
        assertEq(baseIsCurrency0, wantBaseIsCurrency0, "the ordering scan picked the wrong candidate");

        locker.graduate(curve);

        assertTrue(BondingCurve(curve).graduated(), "graduate() did not latch");
        assertEq(BondingCurve(curve).realQuoteReserves(), R, "graduate() mutated the curve's ledger");

        (uint160 sqrtPriceX96,,,) = pm.getSlot0(key.toId());
        assertEq(sqrtPriceX96, expectedSqrtPrice, "the pool did not open at the curve's closing price");
        // ...VE O FIYAT CURVE'UN KENDI GETTER'LARINDAN YENIDEN TURETILIR.
        // Literal ile turetme ayri yerlerden gelir; ayrisirlarsa burasi kirmizi
        // olur.
        assertEq(
            sqrtPriceX96,
            GraduationMath.sqrtPriceX96(
                BondingCurve(curve).virtualQuoteReserves(), BondingCurve(curve).virtualTokenReserves(), baseIsCurrency0
            ),
            "the on-chain price and the curve's own derivation disagree"
        );

        (uint128 liquidity,,) = pm.getPositionInfo(
            key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        // LITERAL ONCE. Turetme ikinci: `seedLiquidity` locker'in KULLANDIGI
        // kutuphanedir, dolayisiyla tek basina bir totolojiye yakindir.
        assertEq(uint256(liquidity), uint256(L), "the seeded position is not the pinned liquidity");
        assertEq(
            uint256(liquidity),
            uint256(_expectedLiquidity(baseIsCurrency0)),
            "the pinned liquidity and the library's own derivation disagree"
        );
    }

    function _expectedLiquidity(bool baseIsCurrency0) internal pure returns (uint128) {
        return baseIsCurrency0
            ? GraduationMath.seedLiquidity(SQRT_TOKEN_IS_CURRENCY0, D, R6)
            : GraduationMath.seedLiquidity(SQRT_USDC_IS_CURRENCY0, R6, D);
    }

    /// @dev IKI SIRALAMANIN `L`SI AYRI AYRI TURETILIR VE PINE KARSI OLCULUR.
    ///      Esitlikleri bir VARSAYIM degil, bu testin SONUCUDUR.
    function test_theTwoSeedLiquidityValuesAreThePinnedOnes() public pure {
        assertEq(uint256(_expectedLiquidity(false)), uint256(L), "L, USDC = currency0");
        assertEq(uint256(_expectedLiquidity(true)), uint256(L), "L, token = currency0");
    }

    // ---------------------------------------------------------------
    // 2. ALTI DECIMAL KESME -- 10^12 SINIRININ UZAK UCU
    // ---------------------------------------------------------------

    /// @dev Arc dokumaninin *"bir `balanceOf` degeri `0` native bakiyenin `0`
    ///      oldugunu ima etmez"* cumlesinin CANLI olcumu. Yerel EVM'de bu test
    ///      hicbir sey ifade etmez: `balanceOf`u native bakiyeden TURETEN sey
    ///      Arc'in kendi USDC kontratidir, mock degil.
    function test_theSixDecimalViewReadsZeroWhileTheNativeBalanceIsNot() public {
        (, address payable curve) = _launchAndBuyOut(_nameForOrdering(false));
        assertEq(address(locker).balance, 0, "the disposable locker started with a balance");

        locker.graduate(curve);

        assertEq(address(locker).balance, QUOTE_RESIDUE, "the quote residue is not the pinned value");
        assertEq(
            IERC20(GraduationMath.QUOTE).balanceOf(address(locker)),
            0,
            "the 6-decimal view is not zero -- the residue would be movable"
        );
        // ...ve iliski, sifirdan BAGIMSIZ olarak da dogru.
        assertEq(
            IERC20(GraduationMath.QUOTE).balanceOf(address(locker)),
            address(locker).balance / 1e12,
            "balanceOf is not the floored native balance"
        );
        assertLt(QUOTE_RESIDUE, 1e12, "the residue is not below one ERC-20 unit -- it would be sweepable");
    }

    // ---------------------------------------------------------------
    // 3. EIP-7708 CIFT SAYIM TUZAGI
    // ---------------------------------------------------------------

    /// @dev BRIEF'IN IDDIA SOZLESMESI BURADA ARITMETIK OLARAK YANLIS VE
    ///      DUZELTILEREK UYGULANDI.
    ///
    ///      Brief graduation'in IKI `Transfer` uretecegini ve "ikisinin AYNI
    ///      hareketi anlattiginin `data1 / data2 == 10^12` ile iddia
    ///      edilecegini" yaziyor. Iki bacak AYNI HAREKET DEGILDIR:
    ///        - curve -> locker : NATIVE, `R = 12_161_433_369_060_378_707` wei
    ///        - locker -> pool  : ERC-20, `R6 = 12_161_433` birim
    ///      ve `R != R6 * 1e12`; aralarinda tam olarak `QUOTE_RESIDUE` wei
    ///      fark vardir. `R / R6 = 1_000_000_030_347`, `1e12` DEGIL. Yani
    ///      brief'in yazdigi `assertEq` KIRMIZI olurdu.
    ///
    ///      DOGRU IFADE HAREKET BASINADIR: Arc'ta TEK bir ERC-20 USDC hareketi
    ///      IKI log uretir -- `0xffff...fffe`den 18-decimal, `0x3600...`dan
    ///      6-decimal -- ayni `from`/`to` ile ve TAM OLARAK `10^12` oranla.
    ///      Indexer'in cift saymamasi gereken sey BUDUR.
    ///
    /// @dev VE OLCUM CANLI DUGUMDEN GELIR, cunku `0xffff...fffe` loglarini
    ///      NODE uretir: yerel EVM onlari HIC yaymaz. `vm.recordLogs` bu
    ///      yuzden yalnizca yarim cevap verir -- ve o yarim cevap da burada
    ///      iddia edilir, ki bir sonraki okuyucu fork'un ne gormedigini
    ///      bilsin.
    function test_graduationEmitsBothTransferFlavoursAndTheyMustNotBeDoubleCounted() public {
        // --- YARI 1: CANLI ZINCIR, PINLENMIS ISLEM ---
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = TRANSFER_TOPIC;

        Vm.EthGetLogs[] memory systemLogs =
            vm.eth_getLogs(DOUBLE_VIEW_BLOCK, DOUBLE_VIEW_BLOCK, EIP7708_EMITTER, topics);
        Vm.EthGetLogs[] memory erc20Logs =
            vm.eth_getLogs(DOUBLE_VIEW_BLOCK, DOUBLE_VIEW_BLOCK, GraduationMath.QUOTE, topics);

        (bool foundSystem, uint256 systemValue) = _findTransfer(systemLogs);
        (bool foundErc20, uint256 erc20Value) = _findTransfer(erc20Logs);

        assertTrue(foundSystem, "no EIP-7708 Transfer from the system emitter in the pinned transaction");
        assertTrue(foundErc20, "no ERC-20 Transfer from 0x3600... in the pinned transaction");
        assertEq(systemValue, DOUBLE_VIEW_WEI, "the 18-decimal flavour is not the pinned amount");
        assertEq(erc20Value, DOUBLE_VIEW_UNITS, "the 6-decimal flavour is not the pinned amount");

        // IKISI AYNI HAREKETTIR: ayni islem, ayni `from`, ayni `to`, ve oran
        // TAM OLARAK 10^12. Bir indexer ikisini de token hareketi sayarsa
        // hacmi IKI KAT gorur.
        assertEq(systemValue, erc20Value * 1e12, "the two flavours are not the same movement");
        assertTrue(EIP7708_EMITTER != GraduationMath.QUOTE, "the two emitters must be distinguishable");

        // --- YARI 2: FORK, GRADUATION'IN KENDISI ---
        (, address payable curve) = _launchAndBuyOut(_nameForOrdering(false));
        vm.recordLogs();
        locker.graduate(curve);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 erc20Transfers;
        uint256 systemTransfers;
        uint256 seededUnits;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != TRANSFER_TOPIC) continue;
            if (logs[i].emitter == GraduationMath.QUOTE) {
                ++erc20Transfers;
                seededUnits = abi.decode(logs[i].data, (uint256));
            } else if (logs[i].emitter == EIP7708_EMITTER) {
                ++systemTransfers;
            }
        }

        assertEq(erc20Transfers, 1, "graduation did not make exactly one ERC-20 USDC movement");
        assertEq(seededUnits, R6, "the ERC-20 leg did not move the floored raise");
        // FORK'UN GORMEDIGI SEY, ACIKCA. `0xffff...fffe` loglarini dugum
        // uretir; revm onlari uretemez, dolayisiyla YARI 1 vazgecilmezdir.
        assertEq(
            systemTransfers, 0, "the fork produced an EIP-7708 log -- then half 1 of this test is no longer needed"
        );
        // ...VE IKI BACAK AYNI HAREKET DEGILDIR. Brief'in `10^12` orani
        // graduation'a UYGULANAMAZ; fark tam olarak artiktir.
        assertEq(BondingCurve(curve).realQuoteReserves() - seededUnits * 1e12, QUOTE_RESIDUE, "residue");
        assertTrue(BondingCurve(curve).realQuoteReserves() != seededUnits * 1e12, "the two legs moved equal amounts");
    }

    function _findTransfer(Vm.EthGetLogs[] memory logs) internal pure returns (bool found, uint256 value) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].transactionHash != DOUBLE_VIEW_TX) continue;
            if (logs[i].topics.length != 3) continue;
            if (logs[i].topics[1] != bytes32(uint256(uint160(DOUBLE_VIEW_FROM)))) continue;
            if (logs[i].topics[2] != bytes32(uint256(uint160(DOUBLE_VIEW_TO)))) continue;
            return (true, abi.decode(logs[i].data, (uint256)));
        }
        return (false, 0);
    }

    // ---------------------------------------------------------------
    // 4. BLOKLAMA
    // ---------------------------------------------------------------

    /// @dev IKI YARI, VE AYRILMALARI ZORUNLU. Arc'in bloklama listesi
    ///      `0x1800...` precompile'inin ARKASINDADIR (olculdu: sim takiliyken
    ///      bloklu adrese ERC-20 transferi BASARIR, canli dugum ayni cagriyi
    ///      `Error("Blocked address")` ile reddeder). Yerel EVM onu HIC
    ///      uygulamaz. Bu yuzden:
    ///        YARI 1  bloklamayi CANLI DUGUME `eth_call` ile sorar -- fork'un
    ///                yeniden ureteMEDIGI tek gercek.
    ///        YARI 2  curve'un o basarisizligi NASIL ele aldigini fork'ta
    ///                olcer: `GraduationPayoutFailed()`, curve SAGLAM, gaz
    ///                TUKETILDI.
    ///      Tek bir yari yazmak, ya taklit bir bloklama uzerinde (sahte gercek
    ///      kodun isini yapardi) ya da olculmemis bir zincir iddiasi uzerinde
    ///      yesil olurdu.
    function test_aBlocklistedTargetMakesGraduationRevertWhileConsumingGas() public {
        // --- YARI 1: CANLI DUGUM ---
        // `graduate()`in odeme bacagiyla AYNI SEKIL: bir kontrat cercevesinden
        // DEGER TASIYAN bir `CALL`. Dondurulen 32 bayt `CALL`in basari
        // bayragidir.
        //   5F5F5F5F 6001 73<addr> 5A F1 5F 52 6020 5F F3
        bytes memory blockedProbe = hex"5F5F5F5F60017370997970C51812dc3A010C7d01b50e0d17dc79C85AF15F5260205FF3";
        bytes memory controlProbe = hex"5F5F5F5F60017300000000000000000000000000000000000012345AF15F5260205FF3";

        assertEq(
            uint256(bytes32(_ethCallCreate(blockedProbe))),
            0,
            "a value-bearing CALL to the blocklisted address SUCCEEDED on the live node"
        );
        assertEq(
            uint256(bytes32(_ethCallCreate(controlProbe))),
            1,
            "the control CALL failed too -- the probe measures something other than the blocklist"
        );

        // ...VE FORK O KURALI UYGULAMAZ. Bu satir yariyi ZORUNLU kilar; onsuz
        // bir sonraki okuyucu ikisini tek yerde birlestirmeye calisirdi.
        vm.deal(address(this), 1 ether);
        (bool okInFork,) = BLOCKED.call{value: 1}("");
        assertTrue(okInFork, "the fork enforced the blocklist -- then half 1 is no longer needed");

        // --- YARI 2: CURVE'UN ELE ALISI, FORK'TA ---
        LaunchFactory blocked =
            new LaunchFactory(liveEscrow, DISPOSABLE_TREASURY, DISPOSABLE_GOVERNOR, T, V, S, liveFeeSchedule);
        PayoutRejectingTarget target = new PayoutRejectingTarget();

        vm.prank(DISPOSABLE_GOVERNOR);
        blocked.proposeGraduationTarget(address(target));
        vm.warp(block.timestamp + blocked.GRADUATION_TARGET_DELAY());
        blocked.applyGraduationTarget();

        vm.prank(CREATOR);
        (address token, address curveAddr) = blocked.launch("BLOCKED", "ARC", "ipfs://x");
        address payable curve = payable(curveAddr);
        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(curve).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);
        assertTrue(BondingCurve(curve).complete(), "the blocked-target curve did not complete");

        uint256 tokensBefore = IERC20(token).balanceOf(curve);
        uint256 quoteBefore = curve.balance;

        uint256 gasBefore = gasleft();
        vm.expectRevert(BondingCurve.GraduationPayoutFailed.selector);
        target.graduate(curve);
        uint256 gasAfter = gasleft();

        assertGt(gasBefore - gasAfter, 0, "the reverting graduation consumed no gas");
        assertFalse(BondingCurve(curve).graduated(), "graduated latched through a failed payout");
        assertTrue(BondingCurve(curve).complete(), "the curve lost its completion");
        assertEq(IERC20(token).balanceOf(curve), tokensBefore, "the base leg was not rolled back");
        assertEq(curve.balance, quoteBefore, "the curve lost quote through a failed payout");
    }

    /// @dev `vm.rpc` istegi CANLI DUGUME gider ve YURUTMEYI DUGUM YAPAR. Fork
    ///      cache'i devrede DEGILDIR: `eth_call` bir EVM cagrisidir, bir durum
    ///      okumasi degil.
    function _ethCallCreate(bytes memory initcode) internal returns (bytes memory) {
        string memory params = string.concat(
            '[{"from":"',
            vm.toString(DOUBLE_VIEW_FROM),
            '","value":"0x1","input":"',
            vm.toString(initcode),
            '"},"latest"]'
        );
        return vm.rpc("eth_call", params);
    }

    // ---------------------------------------------------------------
    // 5. ILK HAVUZ SWAP'I -- KADEME 0, CANLI `FeeSchedule`A KARSI
    // ---------------------------------------------------------------

    /// @dev KADEME GECISLERI TESTNET'TE ULASILAMAZ ve bu ACIK HUCRE olarak
    ///      kayitlidir: FDV 58,78 USDC, ilk esik 59.000 USDC. Olculebilen sey
    ///      kademe 0'in CANLI `FeeSchedule` kontratindan geldigidir.
    function test_theFirstPoolSwapChargesTierZeroOnTheLiveChain() public {
        (address token, address payable curve) = _launchAndBuyOut(_nameForOrdering(false));
        locker.graduate(curve);

        (PoolKey memory key, bool baseIsCurrency0) = _keyOf(token);
        bool quoteIsCurrency0 = !baseIsCurrency0;

        SwapHarness harness = new SwapHarness(pm);
        vm.deal(address(harness), 1_000_000e18);
        deal(token, address(harness), 5e26, true);

        // KADEME 0, CANLI TABLODAN. Havuzun ANLIK fiyatindan turetilmis market
        // cap ile sorulur -- hook'un kendi yolu.
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        uint256 priceX96 = (uint256(sqrtP) * uint256(sqrtP)) >> 96;
        uint256 supply = FeeSchedule(liveFeeSchedule).SUPPLY_CONSTANT();
        uint256 marketCapUnits = quoteIsCurrency0 ? (supply << 96) / priceX96 : (supply * priceX96) >> 96;
        (uint256 protocolBps, uint256 creatorBps) = FeeSchedule(liveFeeSchedule).tierFor(marketCapUnits);
        assertEq(protocolBps, 95, "the live fee schedule is not on tier 0");
        assertEq(creatorBps, 30, "the live fee schedule is not on tier 0");

        uint256 protocolBefore = IEscrowView(liveEscrow).owed(DISPOSABLE_TREASURY);
        uint256 creatorBefore = IEscrowView(liveEscrow).owed(CREATOR);

        // EXACT-INPUT ALIM, 1_000_000 quote birimi. quote SPECIFIED tarafta
        // oldugu icin ucret `beforeSwap`ta kesilir.
        harness.swap(key, quoteIsCurrency0, -1_000_000);

        assertEq(
            IEscrowView(liveEscrow).owed(DISPOSABLE_TREASURY) - protocolBefore,
            uint256(9_500) * 1e12,
            "the protocol share is not 95 bps of the swap"
        );
        assertEq(
            IEscrowView(liveEscrow).owed(CREATOR) - creatorBefore,
            uint256(3_000) * 1e12,
            "the creator share is not 30 bps of the swap"
        );
        // ...VE UCRET LAUNCH TOKENINDA ALINMADI.
        assertEq(IERC20(token).balanceOf(address(hook)), 0, "the hook holds launch tokens");
    }
}
