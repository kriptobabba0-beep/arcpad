// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import {ArcpadLocker} from "../../src/ArcpadLocker.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {GraduationMath} from "../../src/libraries/GraduationMath.sol";

/// @notice KODLU aktor. Swap YAPABILEN tek aktor sinifi budur ve bu YAPISALDIR,
///         bir tercih degil: V4'te swap `unlock` icinden yapilir ve
///         `PoolManager` `IUnlockCallback(msg.sender)` cagirir, yani KODSUZ bir
///         adres bir arcpad havuzunda swap EDEMEZ.
///
/// @dev Faz 1b'nin dersi burada TERSINE isler ve kaydedilmesi gerekir: orada
///      butun aktorlerin KODSUZ olmasi reentrancy penceresini gorunmez
///      kilmisti. Burada tehlike simetriktir -- butun aktorler KODLU olsaydi,
///      `graduate()`in izinsizliginin KODSUZ bir cagirandan da isledigi hic
///      olculmezdi. Bu yuzden `graduate` ve alim yollari HER IKI sinifi da
///      surer, swap yolu ise yalnizca kodluyu surebilir ve bu sinir OLCUMDUR,
///      atlanan bir hucre degil.
contract PoolSwapper is IUnlockCallback {
    IPoolManager public immutable pm;

    /// @dev V4'un kendi sinirlari; bir fiyat limiti VERMEK ZORUNLU.
    uint160 internal constant MIN_LIMIT = 4295128740;
    uint160 internal constant MAX_LIMIT = 1461446703485210103287273052203988822378723970341;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) external returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountSpecified)), (BalanceDelta));
    }

    /// @dev Curve'de alim yapan KODLU aktor. Iade `msg.sender`e duz bir
    ///      `.call`dir; kodsuz bir alicida hicbir sey calistirmaz, burada
    ///      `receive()`i calistirir.
    function buyExactTokensOut(address payable curve, uint256 tokensOut, uint256 maxIn) external payable {
        BondingCurve(curve).buyExactTokensOut{value: msg.value}(tokensOut, maxIn);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) = abi.decode(data, (PoolKey, bool, int256));
        BalanceDelta delta = pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? MIN_LIMIT : MAX_LIMIT
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

/// @title GraduationHandler
/// @notice `launch -> alim dizisi -> graduate -> havuzda swap` dizilerini
///         rastgele surer.
///
/// @dev HANDLER ICINDE ASSERTION CAGRILMAZ. forge-std'nin assertion'lari revert
///      eder ve `fail_on_revert = false` fuzzed hedef fonksiyona yapilan HER
///      revert'i sessizce iskartaya cikarir -- assertion hic calismamis gibi
///      olur. Burada yalnizca ghost sayac artirilir; sifir iddiasi
///      `PoolSeedInvariants.t.sol`daki `invariant_` fonksiyonlarindadir, ve
///      onlar fuzzed cagri DEGILDIR.
///
/// @dev CURVE'LER `setUp`TA ACILIR, HANDLER ICINDE DEGIL, VE BU BILINCLIDIR.
///      Iki siralamanin (token USDC'nin ustunde / altinda) IKISININ DE
///      yurunmesi `invariant_currenciesAreAlwaysStrictlyOrdered`in bos yere
///      yesil olmamasinin ON KOSULUDUR, ve rastgele bir `launch` eylemi bunu
///      GARANTI EDEMEZ: aday adreslerin yalnizca %21,09'u USDC'nin altina
///      duser. `setUp` adaylari TARAR ve iki siralamayi da kumeye KOYAR;
///      taramanin basarisi ayrica iddia edilir.
///
/// @dev BIR CURVE `setUp`TA MEZUN EDILIR, VE BU SAYAC TABANI DEGIL ZAMANLAMA
///      MESELESIDIR. Foundry `invariant_` fonksiyonlarini dizinin HER
///      adiminda cagirir, yani `graduations > 0` gibi bir iddia ilk cagridan
///      ONCE de degerlendirilir ve bos bir handler'da DUSERDI. `setUp`
///      graduation'i HANDLER UZERINDEN yapar (`completeCurve` + `graduate`),
///      dolayisiyla sayac handler'in KENDI yolundan dolar ve iddia her
///      derinlikte anlamlidir. Kalan iki curve rastgele dizide mezun olur ya
///      da olmaz; ikisi de mesrudur.
contract GraduationHandler is CommonBase, StdUtils {
    using StateLibrary for IPoolManager;

    struct Launch {
        address token;
        address payable curve;
        PoolKey key;
        bool baseIsCurrency0;
    }

    IPoolManager public immutable poolManager;
    ArcpadLocker public immutable locker;
    FeeEscrow public immutable escrow;
    IHooks public immutable hook;
    address public immutable protocolTreasury;

    Launch[] internal launches;

    /// @notice 0..2 KODSUZ (EOA), 3 KODLU (`PoolSwapper`).
    address[4] public actors;
    PoolSwapper public immutable swapper;

    // ---------------------------------------------------------------
    // Ihlal sayaclari -- hepsi `invariant_` icinde == 0
    // ---------------------------------------------------------------

    /// @notice Havuz, curve'un KAPANIS fiyatindan BASKA bir fiyatta acildi.
    /// @dev Beklenen deger `GraduationMath`i CAGIRMADAN, formul burada YENIDEN
    ///      YAZILARAK hesaplanir. Kutuphaneyi cagiran bir beklenti iki tarafi
    ///      birden kaydirir ve kutuphanenin KENDI mutasyonunu goremezdi -- bu
    ///      depoda bir kez olustu (bkz. CurveTradingHandler'in ayna notu).
    uint256 public openedAtWrongPrice;

    /// @notice `PoolKey`in bir bacagi `address(0)`.
    uint256 public poolKeyHadZeroAddress;
    /// @notice `currency0 < currency1` bozuldu.
    uint256 public currenciesOutOfOrder;
    /// @notice Tohumlanan likidite AZALDI.
    uint256 public liquidityDecreased;
    /// @notice Bir curve IKI KEZ tohumlandi.
    uint256 public curveSeededTwice;
    /// @notice `graduated` GERI ALINDI.
    uint256 public graduatedWasUnset;
    /// @notice Mezun olmamis bir curve'un havuzu ACILMIS bulundu.
    uint256 public poolExistedBeforeGraduation;
    /// @notice TAMAMLANMAMIS bir curve mezun oldu.
    uint256 public graduatedBeforeCompletion;
    /// @notice IKINCI graduation BASARDI.
    uint256 public secondGraduationSucceeded;
    /// @notice Havuzun derinligi, istenen swap'i tasiyamayacak kadar
    ///         kucuktu; cagri YAPILMADI.
    /// @dev SIFIR OLMASI GEREKMEZ, AMA SESSIZ DE OLAMAZ. Bir on filtre, tam
    ///      da elemek icin yazildigi durumu her seferinde elerse paket
    ///      "hicbir sey yapmayan" bir handler'a doner -- bu depoda bir kez
    ///      olustu (`SeedShortfall` fuzz'i 256/256 gecerken hicbir seye
    ///      bakmiyordu). Sayac, filtrenin ne kadar yuttugunu GORUNUR yapar ve
    ///      `swaps > 0` ayrica iddia edilir.
    uint256 public swapSkippedForDepth;

    /// @notice Bir graduation locker'da BIR TAM ERC-20 BIRIMI ya da daha
    ///         fazlasini birakti.
    /// @dev Iddia "artik ALT BIRIMDIR" -- `quoteUnits`in taban bolmesinin
    ///      birakabilecegi azami `QUOTE_SCALE - 1` wei. Bu sayac o iddiayi
    ///      launch BASINA olcer; toplami olcen satir onu goremezdi.
    uint256 public residueExceededOneUnit;

    /// @notice Quote HAREKET ETTI ama escrow'a HICBIR ucret yatmadi.
    /// @dev `_afterSwap`i sifirlayan mutasyonun gorundugu yer burasidir: o
    ///      mutant ucreti launch tokeninde ALMAZ, HIC ALMAZ -- yani "ucret
    ///      token cinsinden mi" diye soran bir sayac onu GOREMEZ.
    uint256 public swapChargedNoQuoteFee;
    /// @notice Hook ya da escrow LAUNCH TOKENI tuttu.
    uint256 public feeHeldInBaseToken;

    // ---------------------------------------------------------------
    // Kullanilabilirlik sayaclari -- GIRIS NOKTASI BASINA, hepsi == 0
    // ---------------------------------------------------------------

    uint256 public buyReverted;
    uint256 public completeReverted;
    uint256 public graduateReverted;
    uint256 public swapReverted;
    bytes4 public lastUnexpectedRevert;

    // ---------------------------------------------------------------
    // Kapsam sayaclari -- SIFIR OLMASI GEREKMEZ
    // ---------------------------------------------------------------

    uint256 public graduations;
    uint256 public graduateAttemptsBeforeCompletion;
    uint256 public graduateAttemptsAfterGraduation;
    uint256 public swaps;
    uint256[4] public swapsByShape;
    uint256 public swapsOnCurrency0Quote;
    uint256 public swapsOnCurrency1Quote;
    uint256 public graduationsByCodelessActor;
    uint256 public graduationsByCodedActor;
    uint256 public buysByCodelessActor;
    uint256 public buysByCodedActor;

    /// @notice Graduation aninda gorulen ham quote toplaminin `QUOTE_SCALE`
    ///         artigi. Locker'in bakiyesi BUNA esit olmali.
    uint256 public expectedLockerResidue;
    /// @notice Tohumlanan likidite, launch basina.
    mapping(uint256 => uint128) public seededLiquidity;
    /// @notice Tohumlama sayisi, launch basina. 1'i asamaz.
    mapping(uint256 => uint256) public seedCount;
    /// @notice Launch basina BASARILI swap sayisi. Fiyatin MUTLAK kontrolu
    ///         yalnizca hic swap gormemis havuzlarda anlamlidir.
    mapping(uint256 => uint256) public swapsOnLaunch;
    /// @notice Bir kez `graduated` gorulduyse.
    mapping(uint256 => bool) internal sawGraduated;

    constructor(
        IPoolManager poolManager_,
        ArcpadLocker locker_,
        FeeEscrow escrow_,
        IHooks hook_,
        address protocolTreasury_,
        address[3] memory eoas
    ) {
        poolManager = poolManager_;
        locker = locker_;
        escrow = escrow_;
        hook = hook_;
        protocolTreasury = protocolTreasury_;

        swapper = new PoolSwapper(poolManager_);
        actors[0] = eoas[0];
        actors[1] = eoas[1];
        actors[2] = eoas[2];
        actors[3] = address(swapper);
    }

    receive() external payable {}

    /// @dev `setUp` cagirir. Handler kayit tutar; launch'i test kontrati yapar
    ///      cunku `vm.prank` ile creator secmek onun isidir.
    function register(address token, address payable curve, PoolKey memory key, bool baseIsCurrency0) external {
        launches.push(Launch({token: token, curve: curve, key: key, baseIsCurrency0: baseIsCurrency0}));
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    function launchAt(uint256 i) external view returns (address token, address curve, bool baseIsCurrency0) {
        Launch storage l = launches[i];
        return (l.token, l.curve, l.baseIsCurrency0);
    }

    function keyAt(uint256 i) external view returns (PoolKey memory) {
        return launches[i].key;
    }

    // ---------------------------------------------------------------
    // Eylem 1: kismi alim
    // ---------------------------------------------------------------

    function buy(uint256 which, uint256 who, uint256 amount) external {
        Launch storage l = launches[_bound(which, 0, launches.length - 1)];
        if (BondingCurve(l.curve).complete()) return;
        uint256 reserve = BondingCurve(l.curve).realTokenReserves();
        if (reserve == 0) return;

        address actor = actors[_bound(who, 0, 3)];
        uint256 tokensOut = _bound(amount, 1, reserve / 4 + 1);
        uint256 value = 200_000e18;
        if (_payer(actor).balance < value) return;

        (bool ok, bytes memory err) = _buy(actor, l.curve, tokensOut, value);
        if (!ok) {
            buyReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    // ---------------------------------------------------------------
    // Eylem 2: kalan rezervin tamamini alarak TAMAMLA
    // ---------------------------------------------------------------

    function completeCurve(uint256 which, uint256 who) external {
        Launch storage l = launches[_bound(which, 0, launches.length - 1)];
        if (BondingCurve(l.curve).complete()) return;
        uint256 reserve = BondingCurve(l.curve).realTokenReserves();
        if (reserve == 0) return;

        address actor = actors[_bound(who, 0, 3)];
        uint256 value = 1_000_000e18;
        if (_payer(actor).balance < value) return;

        (bool ok, bytes memory err) = _buy(actor, l.curve, reserve, value);
        if (!ok) {
            completeReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    // ---------------------------------------------------------------
    // Eylem 3: graduation -- IZINSIZ, ve UC HUCRE
    // ---------------------------------------------------------------

    /// @dev EYLEM "tamamlandi mi" DIYE ONCEDEN FILTRELEMEZ. Filtreleyen bir
    ///      handler'da `NotComplete` korumasini silen mutant GORUNMEZ olurdu --
    ///      Faz 1c'nin R-6'si.
    ///
    /// @dev CAGIRAN AKTOR HER IKI SINIFTAN SECILIR. `ArcpadLocker.graduate`
    ///      izinsizdir ve izinsizligin KODSUZ bir cagirandan da isledigi ancak
    ///      boyle olculur.
    function graduate(uint256 which, uint256 who) external {
        uint256 i = _bound(which, 0, launches.length - 1);
        Launch storage l = launches[i];
        address actor = actors[_bound(who, 0, 3)];

        bool wasComplete = BondingCurve(l.curve).complete();
        bool wasGraduated = BondingCurve(l.curve).graduated();

        // HAVUZ, MEZUNIYETTEN ONCE VAR OLAMAZ. Hook'un `beforeInitialize`i
        // hedef disindaki herkesi reddeder; bu satir onun SONUCUNU olcer.
        if (!wasGraduated) {
            (uint160 priceBefore,,,) = poolManager.getSlot0(l.key.toId());
            if (priceBefore != 0) poolExistedBeforeGraduation++;
        }

        // Beklenen fiyat cagriDAN ONCE, curve'un CANLI durumundan ve
        // `GraduationMath` CAGRILMADAN hesaplanir.
        uint256 vq = BondingCurve(l.curve).virtualQuoteReserves();
        uint256 vt = BondingCurve(l.curve).virtualTokenReserves();

        if (!wasComplete) graduateAttemptsBeforeCompletion++;
        if (wasGraduated) graduateAttemptsAfterGraduation++;
        uint256 lockerBalanceBefore = address(locker).balance;

        vm.prank(actor);
        try locker.graduate(l.curve) {
            if (wasGraduated) {
                secondGraduationSucceeded++;
            } else if (!wasComplete) {
                graduatedBeforeCompletion++;
            } else {
                graduations++;
                if (actor == address(swapper)) graduationsByCodedActor++;
                else graduationsByCodelessActor++;
                _settleSeedGhosts(i, vq, vt, lockerBalanceBefore);
            }
        } catch (bytes memory err) {
            // Tamamlanmamis ya da zaten mezun bir curve'de revert BEKLENIR ve
            // kullanilabilirlik kusuru SAYILMAZ.
            if (wasComplete && !wasGraduated) {
                graduateReverted++;
                lastUnexpectedRevert = _selectorOf(err);
            }
        }

        if (BondingCurve(l.curve).graduated()) sawGraduated[i] = true;
        if (sawGraduated[i] && !BondingCurve(l.curve).graduated()) graduatedWasUnset++;
    }

    /// @dev Tohumlamadan HEMEN SONRA olculen her sey. Ayri bir fonksiyon
    ///      olmasinin sebebi yigin derinligi, tasarim degil.
    function _settleSeedGhosts(uint256 i, uint256 vq, uint256 vt, uint256 lockerBalanceBefore) internal {
        Launch storage l = launches[i];
        seedCount[i]++;
        if (seedCount[i] > 1) curveSeededTwice++;

        // (1) FIYAT. Beklenti BURADA, kutuphaneden BAGIMSIZ olarak yeniden
        //     turetilir.
        (uint160 onChain,,,) = poolManager.getSlot0(l.key.toId());
        if (onChain != expectedSqrtPrice(vq, vt, l.baseIsCurrency0)) openedAtWrongPrice++;

        // (2) ANAHTARIN SEKLI.
        address c0 = Currency.unwrap(l.key.currency0);
        address c1 = Currency.unwrap(l.key.currency1);
        if (c0 == address(0) || c1 == address(0)) poolKeyHadZeroAddress++;
        if (c0 >= c1) currenciesOutOfOrder++;

        // (3) LIKIDITE.
        (uint128 liq,,) = poolManager.getPositionInfo(
            l.key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        seededLiquidity[i] = liq;

        // (4) 10^12 ARTIGI, OLCULEREK -- FORMULDEN DEGIL.
        //
        // ILK YAZIM `R % 1e12` YAZIYORDU VE O BIR VARSAYIMDI: locker'in
        // quote bacagi TAM TUKENIRSE artik gercekten `R % QUOTE_SCALE`tir,
        // ama `getLiquidityForAmounts` BAGLAYICI bacagi secer ve OBUR bacakta
        // artik kalir. Hangi bacagin bagladigi profile baglidir, yani formul
        // "bugunku profilde dogru" bir sayidir, invariant DEGIL. Burada
        // gercekten kalan olculur; ALT BIRIM oldugu ise ayrica ve launch
        // BASINA iddia edilir -- toplami olcen bir satir tek bir launch'in
        // bir TAM birim birakmasini goremezdi.
        uint256 delta = address(locker).balance - lockerBalanceBefore;
        expectedLockerResidue += delta;
        if (delta >= 1e12) residueExceededOneUnit++;
    }

    // ---------------------------------------------------------------
    // Eylem 4: mezun havuzda swap -- DORT SEKLIN DORDU
    // ---------------------------------------------------------------

    /// @dev DORT SEKIL: (exactInput | exactOutput) x (quote specified | quote
    ///      unspecified). Ilk ikisi `beforeSwap`ta, son ikisi `afterSwap`ta
    ///      ucretlenir; "bir ozelligin bir giris noktasinda kapatilmasi
    ///      hepsinde kapatilmis gibi okunur" bu depoda dokuz kez olustu, o
    ///      yuzden dordu de surulur ve HANGISININ surulduğu sayilir.
    function swap(uint256 which, uint256 shape, uint256 amount) external {
        uint256 i = _bound(which, 0, launches.length - 1);
        Launch storage l = launches[i];
        if (!BondingCurve(l.curve).graduated()) return;

        uint256 s = _bound(shape, 0, 3);
        bool quoteIsCurrency0 = !l.baseIsCurrency0;
        // s0: quote specified, exact input   -> beforeSwap
        // s1: quote specified, exact output  -> beforeSwap
        // s2: base  specified, exact input   -> afterSwap
        // s3: base  specified, exact output  -> afterSwap
        bool quoteSpecified = s < 2;
        bool exactInput = (s % 2 == 0);
        // specified taraf `(exactInput == zeroForOne)` iken currency0'dir.
        bool specifiedIsCurrency0 = quoteSpecified ? quoteIsCurrency0 : !quoteIsCurrency0;
        bool zeroForOne = exactInput ? specifiedIsCurrency0 : !specifiedIsCurrency0;

        // MIKTAR HAVUZUN KENDI DERINLIGINDEN TURETILIR, SABITTEN DEGIL -- VE
        // BU DUZELTME OLCUMLE GELDI. Ilk yazim quote tarafini `1e4..1e8` ile
        // sinirliyordu; havuz mezuniyet aninda 1,216e7 quote birimi tasir,
        // yani bant havuzun SEKIZ KATINI isteyebiliyordu. Fuzzer bunu ilk
        // kosuda buldu: exact-output ile 99,99 USDC istendi, havuz fiyat
        // limitine kadar doldurup girdi olarak 9,2e35 token wei talep etti ve
        // swapper'in 5e26'lik bakiyesi yetmedi (`ERC20InsufficientBalance`).
        // O revert bir protokol kusuru DEGILDIR -- havuzun tasiyamayacagi bir
        // istektir -- ama `swapReverted`i artirdigi icin kullanilabilirlik
        // iddiasini haksiz yere kirmisti.
        //
        // Simdi tavan CANLI durumdan hesaplanir: tam aralik pozisyonun
        // belirtilen para birimindeki mevcut derinliginin SEKIZDE BIRI.
        // Sekizde bir keyfi degil, fiyatin limite yaklasmasini onleyen ve
        // ard arda gelen swap'larda derinligi geometrik olarak azaltan bir
        // paydir; boylece hicbir dizi havuzu limite dayayamaz.
        //
        // ALT SINIR DA OLCULDU VE 2'DIR, TAHMIN DEGIL. Hook ucreti IKI TAVAN
        // yuvarlamasinin TOPLAMIDIR (`feeOn(x,95) + feeOn(x,30)`), yani
        // `x = 1` icin `1 + 1 = 2` eder ve V4 `beforeSwap`in specified taraf
        // deltasinin `|amountSpecified|`i ASMASINI `HookDeltaExceedsSwapAmount()`
        // ile reddeder. Fuzzer bunu ilk kosuda buldu. Sinir
        // `test_theSmallestQuoteSwapThatWorksIsTwoUnitsAndOneUnitRevertsLoudly`
        // ile PINLENIR; buradaki taban o olcumun sonucudur, ondan kacinma
        // degil.
        uint256 floor_ = quoteSpecified ? 2 : 1e12;
        uint256 cap = _specifiedDepth(l, specifiedIsCurrency0) / 8;
        if (cap < floor_) {
            swapSkippedForDepth++;
            return;
        }
        uint256 magnitude = _bound(amount, floor_, cap);
        int256 amountSpecified = exactInput ? -int256(magnitude) : int256(magnitude);

        uint256 protocolOwedBefore = escrow.owed(protocolTreasury);

        try swapper.swap(l.key, zeroForOne, amountSpecified) returns (BalanceDelta delta) {
            swaps++;
            swapsByShape[s]++;
            swapsOnLaunch[i]++;
            if (quoteIsCurrency0) swapsOnCurrency0Quote++;
            else swapsOnCurrency1Quote++;

            int128 quoteDelta = quoteIsCurrency0 ? delta.amount0() : delta.amount1();
            if (quoteDelta != 0 && escrow.owed(protocolTreasury) == protocolOwedBefore) swapChargedNoQuoteFee++;

            // UCRET QUOTE CINSINDEN: ne hook ne escrow launch tokeni TUTAR.
            if (IERC20(l.token).balanceOf(address(hook)) != 0 || IERC20(l.token).balanceOf(address(escrow)) != 0) {
                feeHeldInBaseToken++;
            }
        } catch (bytes memory err) {
            swapReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    /// @notice Tam aralik pozisyonun, BELIRTILEN para biriminde su anki
    ///         derinligi.
    /// @dev Yalnizca FUZZ BANDINI secmek icin kullanilir; hicbir beklenti
    ///      buradan turetilmez, dolayisiyla "sahte, gercek kodun isini
    ///      yapiyor" sinifina girmez.
    function _specifiedDepth(Launch storage l, bool specifiedIsCurrency0) internal view returns (uint256) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(l.key.toId());
        uint128 liq = poolManager.getLiquidity(l.key.toId());
        if (sqrtP == 0 || liq == 0) return 0;
        // `LiquidityAmounts` bu depoda YALNIZCA ters yonu (miktar -> likidite)
        // tasir, dolayisiyla iki standart formul burada acikca yazilir.
        // Beklenti degil BANT hesaplandigi icin bunun bir "ayna" riski yoktur.
        //   amount0 = L * (sqrtB - sqrtA) * 2^96 / (sqrtB * sqrtA)
        //   amount1 = L * (sqrtB - sqrtA) / 2^96
        if (specifiedIsCurrency0) {
            uint160 hi = GraduationMath.SQRT_UPPER;
            if (sqrtP >= hi) return 0;
            return _mulDiv(uint256(liq) << 96, uint256(hi - sqrtP), uint256(hi)) / uint256(sqrtP);
        }
        uint160 lo = GraduationMath.SQRT_LOWER;
        if (sqrtP <= lo) return 0;
        return _mulDiv(uint256(liq), uint256(sqrtP - lo), uint256(1) << 96);
    }

    /// @notice BANDI ATLAYARAK ham miktarla swap eder.
    /// @dev YALNIZCA DETERMINISTIK OLCUM ICINDIR ve fuzz hedefleri arasinda
    ///      DEGILDIR (`targetSelector` dortlusune girmez). Var olma sebebi
    ///      tozluk sinirini PINLEYEN testtir: bandin alt sinirini `2` yapan
    ///      olcumun kendisi, bandi kullanan bir fonksiyonla yapilamazdi.
    function swapRaw(uint256 which, uint256 shape, uint256 magnitude) external {
        Launch storage l = launches[_bound(which, 0, launches.length - 1)];
        uint256 s = _bound(shape, 0, 3);
        bool quoteIsCurrency0 = !l.baseIsCurrency0;
        bool quoteSpecified = s < 2;
        bool exactInput = (s % 2 == 0);
        bool specifiedIsCurrency0 = quoteSpecified ? quoteIsCurrency0 : !quoteIsCurrency0;
        bool zeroForOne = exactInput ? specifiedIsCurrency0 : !specifiedIsCurrency0;
        swapper.swap(l.key, zeroForOne, exactInput ? -int256(magnitude) : int256(magnitude));
    }

    // ---------------------------------------------------------------
    // BAGIMSIZ FIYAT TURETMESI
    // ---------------------------------------------------------------

    /// @notice `GraduationMath.sqrtPriceX96`in AYNI TANIMI, AYRI YAZILMIS.
    ///
    /// @dev BILEREK IKINCI BIR UYGULAMA. Kutuphaneyi cagirsaydi beklenti ile
    ///      olculen deger AYNI koddan gelirdi ve `sqrtPriceX96` icindeki bir
    ///      mutasyon ikisini birden kaydirip GORUNMEZ kalirdi -- deponun
    ///      `GraduationMath.SQRT_UPPER` sabitini `TickMath`e karsi kanitlama
    ///      deseninin aynisi. Tanim: oran = floor(pay * 2^192 / payda),
    ///      sonuc = floor(sqrt(oran)), IKI dalda da ASAGI yuvarlanir.
    function expectedSqrtPrice(uint256 quoteFinal, uint256 baseFinal, bool baseIsCurrency0)
        public
        pure
        returns (uint160)
    {
        uint256 scaled = baseFinal * 1e12;
        uint256 q192 = uint256(1) << 192;
        uint256 ratio = baseIsCurrency0 ? _mulDiv(quoteFinal, q192, scaled) : _mulDiv(scaled, q192, quoteFinal);
        return uint160(_sqrt(ratio));
    }

    /// @dev 512-bit mulDiv (Remco Bloemen / OZ). `FullMath`i IMPORT ETMEK bu
    ///      turetmeyi `GraduationMath`in kullandigi kodun uzerine oturturdu.
    function _mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 lo = x * y;
            uint256 hi;
            assembly {
                let mm := mulmod(x, y, not(0))
                hi := sub(sub(mm, lo), lt(mm, lo))
            }
            require(d > hi, "mulDiv overflow");
            if (hi == 0) return lo / d;

            uint256 rem;
            assembly {
                rem := mulmod(x, y, d)
                hi := sub(hi, gt(rem, lo))
                lo := sub(lo, rem)
            }
            uint256 twos = d & (0 - d);
            assembly {
                d := div(d, twos)
                lo := div(lo, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            lo |= hi * twos;

            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = lo * inv;
        }
    }

    /// @dev Babylonian, `Math.sqrt`in ustune oturmamak icin ayri yazildi.
    function _sqrt(uint256 a) internal pure returns (uint256) {
        if (a == 0) return 0;
        uint256 x = a;
        uint256 y = (x + 1) >> 1;
        while (y < x) {
            x = y;
            y = (a / y + y) >> 1;
        }
        return x;
    }

    // ---------------------------------------------------------------
    // Kucuk yardimcilar
    // ---------------------------------------------------------------

    /// @dev OLCULDU VE SASIRTICIDIR (Faz 1b, `CurveTradingHandler`da ayni not):
    ///      `vm.prank(actor)` altinda `{value: x}` ile yapilan cagriyi PRANK
    ///      EDILEN adres oder, cagriyi fiilen yapan kontrat degil. KODLU aktor
    ///      yolunda ise cagriyi HANDLER'IN KENDISI yapar (swapper forward
    ///      eder), dolayisiyla odeyici handler'dir. Yanlis tarafa bakmak
    ///      `OutOfFunds`u sahte bir kullanilabilirlik kusuru olarak sayardi.
    function _payer(address actor) internal view returns (address) {
        return actor == address(swapper) ? address(this) : actor;
    }

    function _buy(address actor, address payable curve, uint256 tokensOut, uint256 value)
        internal
        returns (bool, bytes memory)
    {
        if (actor == address(swapper)) {
            buysByCodedActor++;
            try swapper.buyExactTokensOut{value: value}(curve, tokensOut, type(uint256).max) {
                return (true, "");
            } catch (bytes memory err) {
                return (false, err);
            }
        }
        buysByCodelessActor++;
        vm.prank(actor);
        try BondingCurve(curve).buyExactTokensOut{value: value}(tokensOut, type(uint256).max) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    function _selectorOf(bytes memory err) internal pure returns (bytes4) {
        if (err.length < 4) return bytes4(0);
        return bytes4(err[0]) | (bytes4(err[1]) >> 8) | (bytes4(err[2]) >> 16) | (bytes4(err[3]) >> 24);
    }
}
