// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {CurrencySettler} from "uniswap-hooks/utils/CurrencySettler.sol";

import {GraduationMath} from "./libraries/GraduationMath.sol";
import {IGraduatableCurve} from "./interfaces/IGraduatableCurve.sol";

/// @dev YEREL arayuz, hook'unkiyle ayni gerekce: `LaunchFactory`yi import
///      etmek locker'in derleme birimini factory'ninkine baglardi.
interface IFactoryFeeSchedule {
    function feeScheduleOf(address token) external view returns (address);
}

/// @title ArcpadLocker
/// @notice Graduation hedefi. Curve'un odemesini alir, havuzu curve'un
///         KAPANIS FIYATINDA acar, tam aralik likidite ekler ve pozisyonu
///         KALICI kilar.
///
/// @dev POZISYON NASIL "YAKILIR". V4'te LP TOKENI YOKTUR: likidite,
///      `PoolManager`in icinde `(owner, tickLower, tickUpper, salt)` ile
///      anahtarlanmis bir kayittir ve sahibi bu kontrattir. "Yakmak", negatif
///      `liquidityDelta` ile `modifyLiquidity` cagiran KODUN HIC YAZILMAMASI
///      demektir. Bir NFT kilitlemekten GUCLU ama test edilmesi ZOR bir
///      garantidir -- yokluk test edilemez, YUZEY test edilir.
///
/// @dev BU KONTRAT KENDI BAKIYESINI HIC OKUMAZ. Arc'ta ucuncu bir taraf hem
///      native hem ERC-20 bakiyesini, burada HICBIR KOD CALISTIRMADAN
///      sisirebilir (tek bakiye, iki gorunum). Tohumlanan miktarlar YALNIZCA
///      `curve.graduate()`in DONUS DEGERLERINDEN gelir; `balanceOf` ya da
///      `address(this).balance` bu dosyada HIC GECMEZ.
///
/// @dev ACIK HUCRE -- BAGISLAR YAKILIR. Havuz ucreti sifir oldugu icin
///      pozisyona ucret BIRIKMEZ, ama `PoolManager.donate` izinsizdir ve
///      hook'un `beforeDonate` bayragi YOKTUR. Arcpad havuzuna yapilan bir
///      bagis aralikta duran likiditeye kredilenir ve bu kontratta onu
///      tahsil edecek bir yol OLMADIGI icin YAKILIR. Kapatmak
///      `BEFORE_DONATE_FLAG` demekti, o da hook ADRESINI degistirmek demekti.
///      Kaydediliyor, kapatilmiyor.
contract ArcpadLocker is IUnlockCallback {
    using StateLibrary for IPoolManager;
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;
    address public immutable factory;
    IHooks public immutable hook;

    /// @notice Havuz acildi ve tohumlandi.
    /// @dev ISIM `Graduated` DEGIL, VE BU BIR INDEXER TUZAGINDAN KACINMADIR:
    ///      `BondingCurve` zaten `Graduated(address,address,uint256,uint256)`
    ///      yayiyor. Ayni isimde iki olay farkli topic0'lar uretir, dolayisiyla
    ///      birine gore yazilmis bir filtre oburu icin SESSIZCE BOS doner.
    event PoolSeeded(
        address indexed token,
        address indexed curve,
        PoolId indexed poolId,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        uint256 baseSeeded,
        uint256 quoteSeeded
    );

    error NotPoolManager();
    error CurveNotFromFactory();
    error UnexpectedCredit();
    error SeedShortfall();
    error ZeroLiquidity();
    error PoolPriceMismatch();
    error PositionNotSeeded();

    constructor(IPoolManager poolManager_, address factory_, IHooks hook_) {
        poolManager = poolManager_;
        factory = factory_;
        hook = hook_;
    }

    /// @notice CIPLAK KABUL, VE BASKA HICBIR SEY.
    /// @dev Curve `target.call{value: R}("")` ile oder, yani bu gereklidir.
    ///      GOVDESI BOS OLMAK ZORUNDA: bu fonksiyon curve'un cagri
    ///      cercevesinde, locker'in KENDI durum makinesi ORTA YERDEYKEN
    ///      calisir. Burada calisan her satir, yarim kalmis bir graduation'in
    ///      icinden yeniden girilebilir bir yuzey olurdu.
    receive() external payable {}

    /// @notice Tamamlanmis bir curve'u mezun eder ve havuzunu acar. IZINSIZ.
    ///
    /// @dev IZINSIZLIK KASITLIDIR: curve tarafinda YALNIZCA hedef
    ///      cagirabilir, ama hedefin kendi giris noktasi HERKESE aciktir --
    ///      pump.fun'in `migrate_v2`sinin izinsizligi boylece uctan uca
    ///      korunur.
    ///
    /// @dev ISI TEK ISLEMDE BITIRIR VE HER BASARISIZLIKTA REVERT EDER.
    ///      `try`/`catch` YOKTUR ve OLMAMALIDIR: bir tanesi "odemeyi aldi ama
    ///      havuz yok" durumunu TEMSIL EDILEBILIR kilardi. Atomiklik `unlock`
    ///      sinirindan DEGIL ISLEM sinirindan gelir -- `initialize`in
    ///      modifier'lari `noDelegateCall`dir ve `onlyWhenUnlocked` DEGILDIR,
    ///      yani kilidin disinda cagrilabilir; `modifyLiquidity` ise
    ///      `onlyWhenUnlocked`tir. Ikisinin ayri cercevelerde olmasi
    ///      atomikligi BOZMAZ.
    function graduate(address curve) external {
        address token = IGraduatableCurve(curve).token();

        // KANONIKLIK, hook'un kullandigi AYNI sabit-gazli kanit. Curve'un
        // kendisini degil TOKEN'i sorar, cunku factory'nin defteri token'a
        // gore anahtarlanmistir.
        if (IFactoryFeeSchedule(factory).feeScheduleOf(token) == address(0)) {
            revert CurveNotFromFactory();
        }

        // --- 1. ODEMEYI CEK. Curve `graduated`i BUNUN ICINDE latch eder. ---
        (uint256 baseAmount, uint256 quoteAmount) = IGraduatableCurve(curve).graduate();

        // --- 2. FIYAT, CURVE'UN GETTER'LARINDAN -- SABITTEN DEGIL. ---
        // `graduate()` sanal rezervleri MUTASYONA UGRATMAZ, dolayisiyla bu
        // okuma cagridan sonra da kapanis durumunu verir. Sabit bir literal
        // yazmak IKI ALIMLA tamamlanan bir curve'de yanlis fiyat verirdi:
        // `quoteBuyCost`un +1'i her alimda birikir.
        (PoolKey memory key, bool baseIsCurrency0) = GraduationMath.poolKey(token, hook);
        uint160 sqrtPriceX96 = GraduationMath.sqrtPriceX96(
            IGraduatableCurve(curve).virtualQuoteReserves(),
            IGraduatableCurve(curve).virtualTokenReserves(),
            baseIsCurrency0
        );

        // --- 3. 10^12 SINIRI, TEK GECIS. ---
        // Curve native wei (18 decimal) oder; havuzun quote bacagi 6
        // decimal'lik ERC-20 gorunumdur. Donusum BU SATIRDA ve yalnizca
        // burada olur. Kalan `< 1e12` wei locker'da KALICI kalir -- gonderme
        // yolu yazilmamistir -- ama birikip sonraki bir launch'a asla
        // sizamaz, cunku bu kontrat kendi bakiyesini HIC OKUMAZ.
        uint256 quoteUnits = GraduationMath.quoteUnits(quoteAmount);
        (uint256 have0, uint256 have1) = baseIsCurrency0 ? (baseAmount, quoteUnits) : (quoteUnits, baseAmount);

        // --- 4. HAVUZ. ---
        poolManager.initialize(key, sqrtPriceX96);

        uint128 liquidity = GraduationMath.seedLiquidity(sqrtPriceX96, have0, have1);
        if (liquidity == 0) revert ZeroLiquidity();

        poolManager.unlock(abi.encode(key, liquidity, have0, have1));

        // --- 5. GERI OKUMA, YEREL DEGISKENDEN DEGIL `PoolManager`IN KENDI
        //        DURUMUNDAN. Bu cerceveden BASARIYLA cikmanin tek yolunu
        //        "canli ve fonlanmis bir havuz" yapan sey budur; oldurdugu
        //        mutant "dogru hesapladi, `initialize`a BASKASINI gecirdi"dir
        //        ve o mutant yerel bir degiskene bakan bir kontrolde
        //        GORUNMEZ. ---
        PoolId id = key.toId();
        (uint160 actual,,,) = poolManager.getSlot0(id);
        if (actual != sqrtPriceX96) revert PoolPriceMismatch();
        (uint128 seeded,,) = poolManager.getPositionInfo(
            id, address(this), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        if (seeded != liquidity) revert PositionNotSeeded();

        emit PoolSeeded(token, curve, id, sqrtPriceX96, liquidity, baseAmount, quoteAmount);
    }

    /// @dev IKI KATMAN, VE IKINCISI YAPISALDIR:
    ///        (1) `msg.sender` kontrolu -- saldirgan dogrudan cagiramaz.
    ///        (2) `PoolManager.unlock`, `IUnlockCallback(msg.sender)` cagirir,
    ///            yani BIR SALDIRGANIN `unlock`U BU CALLBACK'I HIC
    ///            CALISTIRMAZ -- kendi kontratininkini calistirir.
    ///      Ikisi birlikte, negatif likiditeye giden HICBIR yol olmadigini
    ///      verir. `data` da bu kontratin kendi `graduate`inden gelir; disari
    ///      acilan tek sey callback'in KABUL edilmesidir, ICERIGI degil.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint128 liquidity, uint256 have0, uint256 have1) =
            abi.decode(data, (PoolKey, uint128, uint256, uint256));

        // `salt: bytes32(0)`: pozisyon zaten `poolId` ile ad alanina
        // alinmistir. `hookData: ""`: hook'un likidite bayragi YOKTUR,
        // dolayisiyla hic cagrilmaz.
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: GraduationMath.TICK_LOWER,
                tickUpper: GraduationMath.TICK_UPPER,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Likidite EKLERKEN iki bacak da NEGATIF olmak zorunda; pozitif bir
        // delta havuzun beklenmedik bir durumda oldugu anlamina gelir.
        if (delta.amount0() > 0 || delta.amount1() > 0) revert UnexpectedCredit();
        uint256 owed0 = uint256(int256(-delta.amount0()));
        uint256 owed1 = uint256(int256(-delta.amount1()));

        // ACIK KONTROL, VE GEREKCESI TESHISTIR: `getLiquidityForAmounts`
        // ASAGI, `Pool.modifyLiquidity` YUKARI yuvarlar, yani bacak basina
        // 1 wei tasma TEORIK olarak mumkundur. Bu kontrol olmasa ariza
        // `SafeERC20`nin icinde, HANGI KATMANIN yetersiz kaldigini
        // soylemeyen bir revert olarak gorunurdu.
        if (owed0 > have0 || owed1 > have1) revert SeedShortfall();

        // sync -> transfer -> settle, IKISI DE ERC-20. `settle{value:}`
        // NATIVE dali HIC CALISMAZ ve bu, `address(0)`in anahtara hic
        // girmemesinin somut karsiligidir.
        key.currency0.settle(poolManager, address(this), owed0, false);
        key.currency1.settle(poolManager, address(this), owed1, false);
        return "";
    }
}
