// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "uniswap-hooks/base/BaseHook.sol";
import {CurrencySettler} from "uniswap-hooks/utils/CurrencySettler.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

import {GraduationMath} from "./libraries/GraduationMath.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {FeeSchedule} from "./FeeSchedule.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";

/// @dev YEREL arayuzler. `LaunchFactory`yi ya da `BondingCurve`u IMPORT ETMEK
///      hook'un derleme birimini onlarinkine baglardi; ayni bagimlilik yonu
///      curve'un `ILaunchFactory`yi yerel tutma gerekcesiyle aynidir.
interface IFactoryView {
    function graduationTarget() external view returns (address);
    function feeScheduleOf(address token) external view returns (address);
}

interface ILaunchTokenView {
    function curve() external view returns (address);
    function creator() external view returns (address);
}

interface ICurveView {
    function virtualQuoteReserves() external view returns (uint256);
    function virtualTokenReserves() external view returns (uint256);
}

/// @title ArcpadHook
/// @notice Havuzun KIMLIGINI korur ve ucreti HER ZAMAN quote (USDC) cinsinden
///         tahsil eder.
///
/// @dev IZIN KUMESI `0x20CC`, VE `afterSwap` BAYRAKLARI ZORUNLUDUR. Faz 1d'nin
///      pinlediği `0x2088` (`beforeInitialize`+`beforeSwap`+delta) spec §5.5'i
///      UYGULAYAMAZ. V4'te `beforeSwap` yalnizca SPECIFIED para birimini bilir
///      ve specified taraf `(exactInput == zeroForOne)` iken `currency0`dir.
///      Dort swap sekli boylece IKIYE AYRILIR: quote miktari swap'ten ONCE
///      biliniyorsa `beforeSwap`, ancak SONRA biliniyorsa `afterSwap`. Ikinci
///      grup icin miktari uretebilecek tek yer `afterSwap`tir -- `swapDelta`
///      orada vardir. `0x2088` ile kalmak, dort seklin IKISINDE ucreti LAUNCH
///      TOKENINDA tahsil etmek demekti.
///
///      BU DEGISIKLIGIN GERI DONUSU YOKTUR: bayrak eklemek hook'un ADRESINI,
///      dolayisiyla her `PoolKey`i ve her `PoolId`yi degistirir. Ilk
///      graduation'dan sonra yapilamaz.
///
/// @dev `PoolManager` ADRESI ENJEKTE EDILIR, SABIT DEGILDIR. Arc'ta V4 hicbir
///      yerde deploy edilmemistir (dort kanonik adres de kodsuz, olculdu), yani
///      Faz 2 kendi `PoolManager`ini deploy eder; ayni bytecode daha sonra
///      Uniswap'in kanonik mainnet deployment'ina karsi kosabilsin diye adres
///      constructor argumanidir.
contract ArcpadHook is BaseHook {
    using CurrencySettler for Currency;
    using StateLibrary for IPoolManager;

    /// @notice Havuz basina, `beforeInitialize`da BIR KEZ yazilir.
    /// @dev SWAP YOLUNU SABIT GAZLI YAPAR: tek `mapping` okumasi, sifir dis
    ///      `view` cagrisi. Kimlik dogrulamasinin tamami initialize aninda
    ///      yapilir ve swap yolu onu bir daha sorgulamaz.
    struct PoolConfig {
        address base;
        address creator;
        address schedule;
        bool quoteIsCurrency0;
    }

    address public immutable factory;
    address public immutable escrow;
    address public immutable protocolTreasury;

    mapping(PoolId => PoolConfig) public configOf;

    event PoolRegistered(PoolId indexed id, address indexed base, address indexed creator);
    event SwapFeeCollected(PoolId indexed id, uint256 protocolFee, uint256 creatorFee);

    error NotGraduationTarget();
    error QuoteLegMissing();
    error ZeroCurrency();
    error WrongPoolFee();
    error WrongTickSpacing();
    error TokenNotFromFactory();
    error PriceIsNotTheCurveClosingPrice();

    constructor(IPoolManager poolManager_, address factory_, address escrow_, address protocolTreasury_)
        BaseHook(poolManager_)
    {
        factory = factory_;
        escrow = escrow_;
        protocolTreasury = protocolTreasury_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------
    // beforeInitialize -- havuzun kimligi
    // ---------------------------------------------------------------

    /// @dev BU KANCA FAZIN EN KESKIN SALDIRISINI KAPATIR. Onsuz HERKES,
    ///      graduation'dan ONCE, arcpad'in `PoolKey`ini COP bir fiyatla
    ///      initialize edebilirdi; sonra locker'in `initialize`i
    ///      `PoolAlreadyInitialized` ile SONSUZA KADAR revert eder ve curve
    ///      `graduated = false` ile, fonlari elinde, ASLA mezun olamayacak
    ///      durumda kalirdi. Tek bir launch'i kalici olarak tuglalastirmanin
    ///      maliyeti bir `initialize` cagrisinin gazi olurdu.
    ///
    /// @dev SIRA TASIYICIDIR: en ucuz kontrol once. Iki harici okuma
    ///      (`feeScheduleOf`, curve durumu) YALNIZCA hedefin sectigi bir
    ///      anahtar icin yapilir, dolayisiyla dusman bir token uzerinden
    ///      griefing yolu YOKTUR.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override
        returns (bytes4)
    {
        if (sender != IFactoryView(factory).graduationTarget()) revert NotGraduationTarget();

        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);

        // IKINCI KATMAN, VE `PoolManager` BUNU GECIRIR: {address(0), 0x3600...}
        // cifti `currency0 < currency1`i saglar ve sessizce USDC'nin KENDISINE
        // karsi bir havuz olurdu -- native gorunum ile ERC-20 gorunum ayni
        // varlik oldugu icin.
        if (c0 == address(0) || c1 == address(0)) revert ZeroCurrency();

        bool quoteIsCurrency0 = c0 == GraduationMath.QUOTE;
        if (!quoteIsCurrency0 && c1 != GraduationMath.QUOTE) revert QuoteLegMissing();
        if (key.fee != GraduationMath.POOL_FEE) revert WrongPoolFee();
        if (key.tickSpacing != GraduationMath.TICK_SPACING) revert WrongTickSpacing();

        address base = quoteIsCurrency0 ? c1 : c0;

        // KANONIKLIK, SABIT GAZLI. `isCanonical` cagirmak SINIRSIZ GAZLI bir
        // griefing yuzeyi olurdu -- `LaunchFactory`nin NatSpec'i olcerek
        // kaydetti: 3.000.000 gaz butcesiyle 2.958.151 tuketim. Factory'nin
        // mapping'i ayni kaniti TEK `SLOAD` ile verir.
        address schedule = IFactoryView(factory).feeScheduleOf(base);

        // INVARIANT 6, IKINCI KATMAN. Curve'un CANLI durumundan yeniden
        // hesaplar. Kutuphaneden BAGIMSIZ bir turetme DEGILDIR (ayni
        // kutuphaneyi cagirir); oldurdugu mutant "dogru hesapladi, BASKASINI
        // gecirdi"dir, ve o mutant tek katmanda gorunmez.
        address curve = ILaunchTokenView(base).curve();
        uint160 expected = GraduationMath.sqrtPriceX96(
            ICurveView(curve).virtualQuoteReserves(), ICurveView(curve).virtualTokenReserves(), !quoteIsCurrency0
        );
        if (sqrtPriceX96 != expected) revert PriceIsNotTheCurveClosingPrice();

        PoolId id = key.toId();
        address creator_ = ILaunchTokenView(base).creator();
        configOf[id] =
            PoolConfig({base: base, creator: creator_, schedule: schedule, quoteIsCurrency0: quoteIsCurrency0});
        emit PoolRegistered(id, base, creator_);
        return IHooks.beforeInitialize.selector;
    }

    // ---------------------------------------------------------------
    // Ucret -- dort swap seklinin dordunde de QUOTE cinsinden
    // ---------------------------------------------------------------

    /// @dev quote SPECIFIED tarafta oldugunda miktar `amountSpecified`ten
    ///      bilinir.
    ///        exact-input : `amountToSwap` KUCULUR, ucret girdiden kesilir.
    ///        exact-output: `amountToSwap` BUYUR, havuz `amountSpecified`i
    ///                      uretir, kullanici tam istedigini alir ve ucreti
    ///                      fazladan girdi olarak oder.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolConfig memory cfg = configOf[key.toId()];
        bool exactInput = params.amountSpecified < 0;
        bool specifiedIsCurrency0 = (exactInput == params.zeroForOne);
        if (specifiedIsCurrency0 != cfg.quoteIsCurrency0) {
            // quote UNSPECIFIED tarafta -> `afterSwap` halleder.
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        uint256 amount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = _collect(key, cfg, amount);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    /// @dev quote UNSPECIFIED tarafta oldugunda miktar ancak swap'ten SONRA
    ///      bilinir. `Hooks.afterSwap`in vendored govdesi bu donusu
    ///      unspecified slot'a yazar ve dogru para birimine KENDISI esler.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolConfig memory cfg = configOf[key.toId()];
        bool exactInput = params.amountSpecified < 0;
        bool specifiedIsCurrency0 = (exactInput == params.zeroForOne);
        if (specifiedIsCurrency0 == cfg.quoteIsCurrency0) return (IHooks.afterSwap.selector, 0);

        int128 quoteDelta = cfg.quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        uint256 amount = quoteDelta < 0 ? uint256(int256(-quoteDelta)) : uint256(int256(quoteDelta));
        uint256 fee = _collect(key, cfg, amount);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    /// @dev UCRET PARCALARDAN TOPLANIR, TOPLAMDAN BOLUNMEZ -- curve'un
    ///      kuralinin aynisi ve ayni sebeple: iki tavan yuvarlamasinin toplami
    ///      birlesik oranin tavanini asabilir ve fark her seferinde protokolun
    ///      ALEYHINEDIR.
    ///
    /// @dev `take` krediyi kaydetmeden ONCE yapilir ve bu V4'un STANDART
    ///      desenidir: `take` bir borc yaratir, `_accountPoolBalanceDelta`
    ///      donusten SONRA krediyi kaydeder, ikisi net sifirda bulusur. Ters
    ///      sira IMKANSIZDIR -- kredi henuz yoktur.
    ///
    /// @dev `take` USDC'yi hook'un NATIVE bakiyesine yazar ve `deposit{value:}`
    ///      onu oradan harcar. Arc'ta ERC-20 transferi alicinin native
    ///      bakiyesini kredilendirir ve `receive()`i CALISTIRMAZ (canli olcum,
    ///      blok 54019678). Yani bu kontratin `receive()`e ihtiyaci YOKTUR ve
    ///      olmamasi gerekir.
    ///
    /// @dev 10^12 donusumu `GraduationMath.quoteWei` uzerinden gecer; bu
    ///      dosyada `1e12` literali YOKTUR.
    function _collect(PoolKey calldata key, PoolConfig memory cfg, uint256 amount) private returns (uint256 fee) {
        (uint256 protocolBps, uint256 creatorBps) = FeeSchedule(cfg.schedule).tierFor(_marketCap(key, cfg));

        uint256 protocolFee = CurveMath.feeOn(amount, protocolBps);
        // Creator sifirsa creator payi ALINMAZ ve protokol payina KATLANMAZ --
        // islem sadece daha ucuz olur. Curve'un kuralinin aynisi.
        uint256 creatorFee = cfg.creator == address(0) ? 0 : CurveMath.feeOn(amount, creatorBps);
        fee = protocolFee + creatorFee;
        if (fee == 0) return 0;

        Currency quote = cfg.quoteIsCurrency0 ? key.currency0 : key.currency1;
        quote.take(poolManager, address(this), fee, false);

        IFeeEscrow(escrow).deposit{value: GraduationMath.quoteWei(protocolFee)}(protocolTreasury);
        if (creatorFee != 0) {
            IFeeEscrow(escrow).deposit{value: GraduationMath.quoteWei(creatorFee)}(cfg.creator);
        }
        emit SwapFeeCollected(key.toId(), protocolFee, creatorFee);
    }

    /// @notice Havuzun ANLIK fiyatindan turetilmis market cap, quote'un taban
    ///         biriminde (6 decimal).
    ///
    /// @dev HAM REZERV OKUNAMAZ VE BU V4'UN TEKIL MIMARISININ DOGRUDAN
    ///      SONUCUDUR: `PoolManager`in USDC bakiyesi TUM havuzlarin toplamidir.
    ///      V3'ten en onemli ayrim budur. Kullanilabilir tek kaynak `slot0`in
    ///      `sqrtPriceX96`sidir.
    ///
    /// @dev DONUSUM YOKTUR VE OLMAMALIDIR: quote bacagi zaten 6 decimal'dir,
    ///      dolayisiyla oran dogrudan 6-decimal bir market cap verir. Buraya
    ///      bir `QUOTE_SCALE` koymak degeri 10^12 kat sisirir, kademeyi HER
    ///      ZAMAN en uste tasir (ucret %1,25 yerine %0,30 olur) ve HICBIR
    ///      revert uretmez.
    ///
    /// @dev `FeeSchedule.marketCap` BURADAN CAGRILMAZ: imzasi HAM REZERV ister
    ///      ve hook'un ham rezervi yoktur. Iki yol ayni buyuklugu farkli
    ///      girdilerden hesaplar ve URETIM buyuklugunde AYNI sayiya varir
    ///      (58_783_256_052); testnet buyuklugunde 10^12 artigi yuzunden IKI
    ///      BIRIM ayrisirlar. Ayrisma OLCULMUS ve testte SINIRLANMISTIR.
    function _marketCap(PoolKey calldata key, PoolConfig memory cfg) private view returns (uint256) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        // p = (sqrtP / 2^96)^2, ve p = currency1_raw / currency0_raw.
        // Q96 asamali hesaplanir ki ara sonuc tasmasin.
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
        uint256 supply = FeeSchedule(cfg.schedule).SUPPLY_CONSTANT();
        return cfg.quoteIsCurrency0
            // USDC = currency0: quote/base = 2^96 / priceX96
            ? FullMath.mulDiv(supply, 1 << 96, priceX96)
            // token = currency0: quote/base = priceX96 / 2^96
            : FullMath.mulDiv(supply, priceX96, 1 << 96);
    }
}
