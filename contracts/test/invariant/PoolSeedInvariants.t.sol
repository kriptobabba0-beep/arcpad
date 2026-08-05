// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {ArcpadHook} from "../../src/ArcpadHook.sol";
import {ArcpadLocker} from "../../src/ArcpadLocker.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {FeeSchedule} from "../../src/FeeSchedule.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {GraduationMath} from "../../src/libraries/GraduationMath.sol";
import {GraduationHandler} from "./GraduationHandler.sol";

// TEK MOCK TANIMI, UCUNCU BIR KOPYA DEGIL. `UsdcMock` Arc'in tasiyici
// ozelligini (tek bakiye, iki gorunum) modeller ve o modelin bu pakette
// UCUNCU kez yazilmasi, uc kopyanin sessizce ayrisabilecegi anlamina gelirdi.
// `ArcpadLocker.t.sol`daki tanim IMPORT edilir; adi verilerek import edildigi
// icin o dosyanin dosya-seviyesi `SeedLegFailed` hatasi buraya SIZMAZ.
import {UsdcMock} from "../ArcpadLocker.t.sol";

/// @title PoolSeedInvariantsTest
/// @notice Graduation havuzunun, rastgele `alim -> tamamla -> mezun et ->
///         swap` dizileri altinda tutmasi gereken iddialari, ve ariza
///         modelinin fuzz ile kapatilamayan iki satiri (F6, F7).
///
/// @dev BU DOSYADAKI HER IDDIA YA MUTLAK DURUM UZERINDEDIR YA DA HANDLER'IN
///      ARTIRDIGI BIR GHOST SAYAC UZERINDEDIR. Handler icinde assertion
///      CAGRILMAZ: `fail_on_revert = false` fuzzed hedefe yapilan cagridaki
///      HER revert'i -- forge-std assertion'larinin urettikleri dahil --
///      sessizce yutar.
///
/// @dev IKI SIRALAMA DA KURULUR VE BU BIR SUS DEGIL, IDDIALARIN ON KOSULUDUR.
///      `LaunchFactory`nin salt'i turetilmistir, madenle bulunmamis; token
///      adresleri 160-bit uzayda tekduzedir ve yalnizca `0x36/0x100 = %21,09`u
///      USDC'nin ALTINA duser. Yani "token her zaman currency1" varsayimini
///      tasiyan bir mutasyon (bu fazin `baseIsCurrency0 = false` mutanti) her
///      BES launch'tan DORDUNDE gorunmez. `setUp` adaylari TARAR, iki
///      siralamadan da BIRER launch kurar ve IKISINI DE mezun eder --
///      dolayisiyla dizinin ilk adiminda bile iki siralamanin da CANLI bir
///      havuzu vardir.
contract PoolSeedInvariantsTest is Test {
    using StateLibrary for IPoolManager;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant ARCPAD_HOOK_FLAGS = 0x20CC;

    // TESTNET PROFILI -- `ArcpadLocker.t.sol` ve `ArcpadHook.t.sol` ile ayni
    // uclu, boylece oradaki olculmus sabitler burada da gecerlidir.
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant GOVERNOR = address(0x600D);
    address internal constant CREATOR = address(0xC0FFEE);

    IPoolManager internal pm;
    UsdcMock internal usdc;
    FeeEscrow internal escrow;
    FeeSchedule internal schedule;
    LaunchFactory internal factory;
    ArcpadHook internal hook;
    ArcpadLocker internal locker;
    GraduationHandler internal handler;

    /// @notice `setUp`ta mezun edilen iki launch'in indeksleri.
    uint256 internal constant BELOW = 0; // token < USDC  -> token = currency0
    uint256 internal constant ABOVE = 1; // token > USDC  -> USDC  = currency0
    uint256 internal constant OPEN = 2; // rastgele dizinin mezun edecegi

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

        address[3] memory eoas = [address(0xA11CE), address(0xB0B), address(0xCAFE)];
        handler = new GraduationHandler(pm, locker, escrow, IHooks(address(hook)), TREASURY, eoas);

        // --- UC LAUNCH, IKI SIRALAMA ---
        _launchInto(_nameSortingBelowUsdc());
        _launchInto(_nameSortingAboveUsdc());
        _launchInto(_nameSortingAboveUsdc());

        (,, bool below) = handler.launchAt(BELOW);
        (,, bool above) = handler.launchAt(ABOVE);
        require(below, "BELOW launch'u USDC'nin altina dusmedi");
        require(!above, "ABOVE launch'u USDC'nin ustune cikmadi");

        // --- FONLAMA ---
        vm.deal(address(handler), 1e12 ether);
        for (uint256 i = 0; i < 3; ++i) {
            vm.deal(eoas[i], 1e12 ether);
        }
        // Swapper'in USDC'si NATIVE bakiyedir (tek bakiye, iki gorunum).
        vm.deal(address(handler.swapper()), 1e15 * 1e12);
        for (uint256 i = 0; i < 3; ++i) {
            (address tk,,) = handler.launchAt(i);
            deal(tk, address(handler.swapper()), 1e30, true);
        }

        // --- IKI SIRALAMAYI DA MEZUN ET, HANDLER UZERINDEN ---
        // Sayac handler'in KENDI yolundan dolar, yani
        // `invariant_theHandlerActuallyReachesGraduation` bir "setUp yapti"
        // iddiasi degil, "handler'in graduate yolu YURUYOR" iddiasidir. Ve
        // dizinin ILK adiminda bile iki siralamanin da canli havuzu vardir.
        handler.completeCurve(BELOW, 0);
        handler.graduate(BELOW, 0);
        handler.completeCurve(ABOVE, 3); // KODLU aktor de alim yapar
        handler.graduate(ABOVE, 3); // ...ve KODLU aktor de mezun eder
        require(handler.graduations() == 2, "setUp iki graduation'i yurutemedi");

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](4);
        sel[0] = GraduationHandler.buy.selector;
        sel[1] = GraduationHandler.completeCurve.selector;
        sel[2] = GraduationHandler.graduate.selector;
        sel[3] = GraduationHandler.swap.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    // ---------------------------------------------------------------
    // 1. Spec §10 invariant 6 -- havuz, curve'un kapanis fiyatinda acar
    // ---------------------------------------------------------------

    /// @notice Her mezun curve icin, zincirdeki `sqrtPriceX96` o curve'un
    ///         getter'larindan turetilen degere esittir.
    ///
    /// @dev IKI SATIR VE IKISI DE GEREKLI. Birincisi TOHUMLAMA ANINI olcer
    ///      (handler, `GraduationMath`i CAGIRMADAN yeniden turetir); ikincisi
    ///      MUTLAK DURUMU okur ama yalnizca HENUZ SWAP GORMEMIS havuzlar icin
    ///      -- bir swap fiyati mesru olarak hareket ettirir ve o hareketi
    ///      ihlal saymak testi yanlis yapardi.
    /// @dev Onu kiran mutasyon: `ArcpadLocker`da sabit bir `sqrtPriceX96`.
    ///      (Hook'un ikinci katmani o mutanti zaten revert ettirir, yani
    ///      `graduations` sifira duser ve asagidaki 9. iddia da kirilir --
    ///      IKI AYRI iddianin ayni mutanti oldurmesi kapsamin bir kusuru
    ///      degil, katmanin kendisidir.)
    function invariant_poolPriceAlwaysEqualsTheCurveClosingPrice() public view {
        assertEq(handler.openedAtWrongPrice(), 0, "havuz kapanis fiyatindan baska bir fiyatta acildi");

        for (uint256 i = 0; i < handler.launchCount(); ++i) {
            (, address curve, bool baseIsCurrency0) = handler.launchAt(i);
            if (!BondingCurve(payable(curve)).graduated()) continue;
            if (handler.swapsOnLaunch(i) != 0) continue;
            (uint160 onChain,,,) = pm.getSlot0(handler.keyAt(i).toId());
            assertEq(
                onChain,
                handler.expectedSqrtPrice(
                    BondingCurve(payable(curve)).virtualQuoteReserves(),
                    BondingCurve(payable(curve)).virtualTokenReserves(),
                    baseIsCurrency0
                ),
                "zincirdeki fiyat curve'un kapanis fiyati degil"
            );
        }
    }

    // ---------------------------------------------------------------
    // 2-3. Anahtarin sekli
    // ---------------------------------------------------------------

    /// @notice Hicbir `PoolKey` `address(0)` tasimaz.
    /// @dev SESSIZ USDC-USDC HAVUZU. `{address(0), 0x3600...}` cifti
    ///      `currency0 < currency1`i SAGLAR ve `PoolManager` onu KABUL EDER --
    ///      native gorunum ile ERC-20 gorunum ayni varliktir. Reddetmek
    ///      arcpad'in isi; `GraduationMath.ZeroBase` o kontroldur.
    /// @dev Onu kiran mutasyon: `ZeroBase` kontrolunu kaldirmak.
    function invariant_noPoolKeyEverContainsTheZeroAddress() public view {
        assertEq(handler.poolKeyHadZeroAddress(), 0, "anahtarda sifir adres");
        for (uint256 i = 0; i < handler.launchCount(); ++i) {
            PoolKey memory k = handler.keyAt(i);
            assertTrue(Currency.unwrap(k.currency0) != address(0), "currency0 sifir");
            assertTrue(Currency.unwrap(k.currency1) != address(0), "currency1 sifir");
        }
    }

    /// @notice `currency0 < currency1`, KATI.
    /// @dev Onu kiran mutasyon: `baseIsCurrency0 = false` sabitlemek. Kume iki
    ///      siralamayi da icerdigi icin o mutant BURADA gorunur; yalnizca
    ///      %79'luk hali tasiyan bir kumede GORUNMEZDI.
    function invariant_currenciesAreAlwaysStrictlyOrdered() public view {
        assertEq(handler.currenciesOutOfOrder(), 0, "siralama bozuldu");
        bool sawBelow;
        bool sawAbove;
        for (uint256 i = 0; i < handler.launchCount(); ++i) {
            PoolKey memory k = handler.keyAt(i);
            assertLt(
                uint256(uint160(Currency.unwrap(k.currency0))),
                uint256(uint160(Currency.unwrap(k.currency1))),
                "currency0 >= currency1"
            );
            (,, bool baseIsCurrency0) = handler.launchAt(i);
            if (baseIsCurrency0) sawBelow = true;
            else sawAbove = true;
        }
        // ON KOSUL, VARSAYIM DEGIL: kume gercekten iki siralamayi da tasiyor.
        assertTrue(sawBelow && sawAbove, "kume tek siralama tasiyor -- iddia %79'luk hali olcuyor");
    }

    // ---------------------------------------------------------------
    // 4. Kalicilik
    // ---------------------------------------------------------------

    /// @notice Tohumlanan likidite ASLA azalmaz.
    /// @dev "Yakma" bu depoda negatif `liquidityDelta` cagiran KODUN HIC
    ///      YAZILMAMASIDIR; yokluk test edilemez, SONUCU test edilir.
    /// @dev Onu kiran mutasyon: `unlockCallback`e negatif delta yolu eklemek.
    function invariant_seededLiquidityNeverDecreases() public view {
        assertEq(handler.liquidityDecreased(), 0, "likidite azaldi (ghost)");
        for (uint256 i = 0; i < handler.launchCount(); ++i) {
            uint128 seeded = handler.seededLiquidity(i);
            if (seeded == 0) continue;
            (uint128 nowLiq,,) = pm.getPositionInfo(
                handler.keyAt(i).toId(),
                address(locker),
                GraduationMath.TICK_LOWER,
                GraduationMath.TICK_UPPER,
                bytes32(0)
            );
            assertGe(nowLiq, seeded, "arcpad'in pozisyonu kuculdu");
        }
    }

    // ---------------------------------------------------------------
    // 5. 10^12 artigi sizmaz
    // ---------------------------------------------------------------

    /// @notice Locker'in native bakiyesi, graduation'larin biraktigi artiktan
    ///         FAZLA olamaz -- ve her graduation'in birakti ALT BIRIMDIR.
    ///
    /// @dev IKI AYRI IDDIA, VE AYRILMALARI OLCUMDUR: toplami olcen satir tek
    ///      bir launch'in bir TAM ERC-20 birimi birakmasini goremezdi
    ///      (toplamda hala "az" gorunur), launch basina olcen satir ise
    ///      locker'a DISARIDAN gelen bir bakiyeyi goremezdi.
    /// @dev Onu kiran mutasyon: `quoteUnits`i kimlige cevirmek.
    function invariant_lockerNeverHoldsMoreQuoteThanTheAccumulatedResidue() public view {
        assertEq(handler.residueExceededOneUnit(), 0, "bir graduation TAM birim artik birakti");
        assertLe(address(locker).balance, handler.expectedLockerResidue(), "locker fazladan quote tutuyor");
        assertEq(address(locker).balance, handler.expectedLockerResidue(), "locker bakiyesi olculen artikla ayristi");
        assertLt(
            address(locker).balance,
            handler.graduations() * GraduationMath.QUOTE_SCALE + 1,
            "artik graduation basina bir ERC-20 birimini asti"
        );
    }

    // ---------------------------------------------------------------
    // 6. Mezun curve <-> havuz, BIRE BIR
    // ---------------------------------------------------------------

    /// @notice Her mezun curve'un TAM OLARAK BIR havuzu vardir; mezun olmayanin
    ///         HIC havuzu yoktur.
    /// @dev IKINCI YARI ONEMLIDIR VE AYRI BIR SEYI OLCER: mezuniyetten ONCE
    ///      havuzun ACILAMADIGINI. O yariyi tutan sey hook'un
    ///      `beforeInitialize`idir (F2) -- onsuz herkes anahtari cop bir
    ///      fiyatla acip launch'i KALICI olarak tuglalastirabilirdi.
    /// @dev Onu kiran mutasyon: `graduated` latch'ini kaldirmak (cift
    ///      tohumlama), ya da hook'un hedef kontrolunu kaldirmak.
    function invariant_everyGraduatedCurveHasExactlyOnePool() public view {
        assertEq(handler.curveSeededTwice(), 0, "bir curve iki kez tohumlandi");
        assertEq(handler.poolExistedBeforeGraduation(), 0, "mezuniyetten once havuz vardi");
        assertEq(handler.secondGraduationSucceeded(), 0, "ikinci graduation BASARDI");
        assertEq(handler.graduatedBeforeCompletion(), 0, "tamamlanmamis curve mezun oldu");

        for (uint256 i = 0; i < handler.launchCount(); ++i) {
            (, address curve,) = handler.launchAt(i);
            (uint160 price,,,) = pm.getSlot0(handler.keyAt(i).toId());
            if (BondingCurve(payable(curve)).graduated()) {
                assertEq(handler.seedCount(i), 1, "mezun curve'un tohumlama sayisi 1 degil");
                assertGt(price, 0, "mezun curve'un havuzu YOK");
            } else {
                assertEq(handler.seedCount(i), 0, "mezun olmayan curve tohumlandi");
                assertEq(price, 0, "mezun olmayan curve'un havuzu VAR");
            }
        }
    }

    // ---------------------------------------------------------------
    // 7. Geri alinamazlik
    // ---------------------------------------------------------------

    /// @notice `graduated` bir kez cevrildikten sonra geri alinmaz.
    /// @dev NEGATIF BIR GHOST'TUR ve bu KAYDA GECIRILIYOR: `graduate()` hic
    ///      cagrilmasa da sifir kalir, yani YAZILDIGI BOSLUGU KENDISI TESPIT
    ///      EDEMEZ. Kapsam iddiasini asagidaki 9. satir tasir.
    function invariant_graduatedWasNeverUnset() public view {
        assertEq(handler.graduatedWasUnset(), 0, "graduated geri alindi");
    }

    // ---------------------------------------------------------------
    // 8. Ucret HER ZAMAN quote cinsinden
    // ---------------------------------------------------------------

    /// @notice Quote hareket eden her swap escrow'a ucret yatirir, ve ucret
    ///         ASLA launch tokeninde tutulmaz.
    ///
    /// @dev IKI SAYAC, VE BIRINCISI OLMADAN IKINCISI YANILTICIDIR.
    ///      `_afterSwap`i sifirlayan mutant ucreti launch tokeninde ALMAZ --
    ///      HIC ALMAZ. "Hook token tutuyor mu" diye soran bir sayac o mutanti
    ///      GOREMEZ; goren sey "quote hareket etti ama escrow artmadi"dir.
    ///      Dort swap seklinin ikisi `beforeSwap`ta, ikisi `afterSwap`ta
    ///      ucretlenir, ve handler dordunu de surer.
    function invariant_hookFeeIsAlwaysDenominatedInQuote() public view {
        assertEq(handler.swapChargedNoQuoteFee(), 0, "quote hareket etti ama ucret alinmadi");
        assertEq(handler.feeHeldInBaseToken(), 0, "ucret launch tokeninde tutuldu");
        for (uint256 i = 0; i < handler.launchCount(); ++i) {
            (address tk,,) = handler.launchAt(i);
            assertEq(IERC20(tk).balanceOf(address(hook)), 0, "hook launch tokeni tutuyor");
            assertEq(IERC20(tk).balanceOf(address(escrow)), 0, "escrow launch tokeni tutuyor");
        }
    }

    // ---------------------------------------------------------------
    // 9. ULASILABILIRLIK -- bu bir invariant gibi gorunmuyor ve oyle olmali
    // ---------------------------------------------------------------

    /// @notice Handler `graduate()`e GERCEKTEN ulasiyor.
    ///
    /// @dev FAZ 1C'NIN R-3'U: `graduate()`e ulasamayan bir handler yukaridaki
    ///      SEKIZ iddianin hepsini YESIL birakir ve paket tam kapsama bildirir.
    ///      Ulasamayan bir handler GECEN bir paket degil, BASARISIZ bir
    ///      pakettir.
    ///
    /// @dev NICIN `invariant_` VE `afterInvariant()` DEGIL. `afterInvariant`
    ///      yalnizca kosunun SONUNDA calisir, yani sekiz iddianin dizinin
    ///      ORTASINDA da anlamli oldugunu gostermez. `> 0` bir invariant
    ///      olarak ancak sayac dizinin ILK adimindan once dolmussa yazilabilir
    ///      -- `setUp` graduation'i HANDLER UZERINDEN yaptigi icin doludur, ve
    ///      dolduran yol fuzzer'in kullandigi yolun TA KENDISIDIR. Bu, sayaci
    ///      "setUp bir sey yapti" iddiasi olmaktan cikarip "handler'in
    ///      graduate yolu yuruyor" iddiasi yapan seydir.
    function invariant_theHandlerActuallyReachesGraduation() public view {
        assertGt(handler.graduations(), 0, "handler graduate()'e HIC ulasmadi -- ustteki iddialar bos");
        assertGt(handler.seededLiquidity(BELOW), 0, "token = currency0 halinde tohumlanmis havuz yok");
        assertGt(handler.seededLiquidity(ABOVE), 0, "USDC = currency0 halinde tohumlanmis havuz yok");
    }

    // ---------------------------------------------------------------
    // 10. Kullanilabilirlik -- GIRIS NOKTASI BASINA
    // ---------------------------------------------------------------

    /// @notice Gecerli hicbir cagri revert etmez.
    /// @dev YUKARIDAKI DOKUZ IDDIA GUVENLIK IDDIASIDIR VE HICBIR SEY YAPMAYAN
    ///      BIR KONTRAT HEPSINI SAGLAR. `fail_on_revert = false` revert eden
    ///      handler cagrisini yutar ve ghost artirimini de geri alir, yani
    ///      durum ile ghost TAM OLARAK islem basarisiz oldugu ICIN tutarli
    ///      kalir. Care `try/catch` + sifir iddia edilen bir sayactir ve
    ///      BURADA DORT GIRIS NOKTASININ DORDUNE de ayri ayri uygulanir.
    function invariant_everyEntrypointStaysAvailable() public view {
        assertEq(handler.buyReverted(), 0, "buy");
        assertEq(handler.completeReverted(), 0, "completeCurve");
        assertEq(handler.graduateReverted(), 0, "graduate");
        assertEq(handler.swapReverted(), 0, "swap");
    }

    // ---------------------------------------------------------------
    // KAPSAM TABANLARI -- yalnizca YAPISAL OLARAK GARANTI olanlar
    // ---------------------------------------------------------------

    /// @dev Buraya YALNIZCA `setUp`in garanti ettigi sayaclar girer. Rastgele
    ///      dizide garanti OLMAYAN her sey (dort swap seklinin dordu, ucuncu
    ///      curve'un mezun olmasi) asagidaki deterministik testlerde iddia
    ///      edilir -- `BondingCurveInvariants.t.sol`un olculmus kurali:
    ///      `--fuzz-seed` degistiginde dusen bir taban paketi
    ///      gudumlu-kirilgan yapar.
    function afterInvariant() public view {
        assertEq(handler.graduations(), handler.seedCount(BELOW) + handler.seedCount(ABOVE) + handler.seedCount(OPEN));
        assertGt(handler.graduations(), 0, "hic graduation yok");
    }

    // ---------------------------------------------------------------
    // HUCRE YURUYUSU -- rastgele dizide garanti OLMAYANLAR
    // ---------------------------------------------------------------

    /// @notice Dort swap seklinin DORDU de fiilen yurunur, ve dordu de ucreti
    ///         QUOTE cinsinden alir.
    /// @dev NICIN AYRI BIR TEST. `invariant_hookFeeIsAlwaysDenominatedInQuote`
    ///      64 cagrilik bir dizide dort seklin dordune de dusmeyebilir; bir
    ///      sekli hic yurumeyen bir kosu o iddiayi o sekil icin BOS birakir.
    ///      Burada dordu de deterministik olarak surulur.
    function test_allFourSwapShapesAreExercisedAndEachChargesInQuote() public {
        uint256 before_ = escrow.owed(TREASURY);
        for (uint256 shape = 0; shape < 4; ++shape) {
            uint256 owedBefore = escrow.owed(TREASURY);
            handler.swap(BELOW, shape, shape < 2 ? 1e5 : 1e20);
            assertEq(handler.swapsByShape(shape), 1, "sekil yurunmedi");
            assertGt(escrow.owed(TREASURY), owedBefore, "bu sekil ucret uretmedi");
        }
        assertGt(escrow.owed(TREASURY), before_);
        assertEq(handler.swapReverted(), 0, "swap revert etti");
        assertEq(handler.swapChargedNoQuoteFee(), 0);
        assertEq(handler.feeHeldInBaseToken(), 0);

        // ...ve IKI SIRALAMADA DA. Ucret mantigi `quoteIsCurrency0`a dallanir.
        for (uint256 shape = 0; shape < 4; ++shape) {
            uint256 owedBefore = escrow.owed(TREASURY);
            handler.swap(ABOVE, shape, shape < 2 ? 1e5 : 1e20);
            assertGt(escrow.owed(TREASURY), owedBefore, "obur siralamada bu sekil ucret uretmedi");
        }
        assertGt(handler.swapsOnCurrency0Quote(), 0, "USDC = currency0 havuzunda swap yok");
        assertGt(handler.swapsOnCurrency1Quote(), 0, "token = currency0 havuzunda swap yok");
    }

    /// @notice Rastgele dizinin bulmasi gerekmeyen yol: ucuncu curve alimlarla
    ///         tamamlanir, mezun olur ve havuzu acilir.
    function test_theThirdCurveWalksTheWholePathFromBuyToPool() public {
        assertEq(handler.seedCount(OPEN), 0, "ucuncu curve zaten mezun");
        handler.buy(OPEN, 0, 1e18);
        handler.completeCurve(OPEN, 1);
        handler.graduate(OPEN, 2);

        assertEq(handler.seedCount(OPEN), 1, "ucuncu curve mezun olmadi");
        assertEq(handler.graduations(), 3);
        assertGt(handler.graduationsByCodelessActor(), 0, "kodsuz aktor hic mezun etmedi");
        assertGt(handler.graduationsByCodedActor(), 0, "kodlu aktor hic mezun etmedi");
        assertGt(handler.buysByCodelessActor(), 0, "kodsuz aktor hic alim yapmadi");
        assertGt(handler.buysByCodedActor(), 0, "kodlu aktor hic alim yapmadi");

        invariant_poolPriceAlwaysEqualsTheCurveClosingPrice();
        invariant_everyGraduatedCurveHasExactlyOnePool();
        invariant_lockerNeverHoldsMoreQuoteThanTheAccumulatedResidue();
        invariant_everyEntrypointStaysAvailable();
    }

    /// @notice UC HUCRE DE YURUNUR: tamamlanmadan once, tamamlandiktan sonra,
    ///         ve zaten mezunken.
    /// @dev Handler `graduate`i ONCEDEN FILTRELEMEZ; filtreleyen bir handler
    ///      `NotComplete` korumasini silen mutanti GORUNMEZ kilardi.
    function test_graduateWalksAllThreeCellsAndOnlyTheMiddleOneSucceeds() public {
        handler.graduate(OPEN, 0); // (a) tamamlanmamis
        assertGt(handler.graduateAttemptsBeforeCompletion(), 0, "(a) hucresi yurunmedi");
        assertEq(handler.seedCount(OPEN), 0);

        handler.completeCurve(OPEN, 0);
        handler.graduate(OPEN, 0); // (b) tamamlandi
        assertEq(handler.seedCount(OPEN), 1);

        handler.graduate(OPEN, 0); // (c) zaten mezun
        assertGt(handler.graduateAttemptsAfterGraduation(), 0, "(c) hucresi yurunmedi");
        assertEq(handler.seedCount(OPEN), 1, "ucuncu cagri yeniden tohumladi");
        assertEq(handler.secondGraduationSucceeded(), 0);
        assertEq(handler.graduatedBeforeCompletion(), 0);
        assertEq(handler.graduateReverted(), 0, "mesru cagri revert etti");
    }

    /// @notice OLCULMUS TOZ SINIRI: quote tarafinda EN KUCUK calisan
    ///         exact-input 2 birimdir; 1 birim `HookDeltaExceedsSwapAmount()`
    ///         ile GURULTULU bicimde duser.
    ///
    /// @dev BU BIR BULGU, BIR BANT SECIMI DEGIL, VE PINLENMESININ SEBEBI ODUR.
    ///      Fuzzer'i ilk kosuda dusuren sey buydu ve ilk refleks bandi
    ///      yukseltip devam etmekti -- o refleks, hicbir yerde yazili olmayan
    ///      bir davranisi paketin ICINDE gizlerdi.
    ///
    ///      MEKANIZMA: hook ucreti IKI TAVAN yuvarlamasinin TOPLAMIDIR
    ///      (`feeOn(x,95) + feeOn(x,30)`) -- curve'un kuralinin aynisi, ve ayni
    ///      sebeple: iki tavanin toplami birlesik oranin tavanini asabilir ve
    ///      fark her zaman protokolun LEHINEDIR. `x = 1` icin toplam
    ///      `1 + 1 = 2`dir, yani ucret miktarin KENDISINI asar; V4 `beforeSwap`
    ///      deltasinin `|amountSpecified|`i asmasini reddeder.
    ///
    ///      DEGERLENDIRME, ve neden DUZELTILMIYOR: 1 birim = 10^-6 USDC'dir.
    ///      Revert GURULTULUDUR (sessiz bir yanlis ucret degil), fon kaybi
    ///      YOKTUR, ve griefing yuzeyi YOKTUR -- maliyeti cagiranin kendi
    ///      gazidir. Ucreti `amountSpecified`e KISMAK ise ucret kuralini
    ///      degistirir ve hook'un ADRESINI yeniden madenlemeyi gerektirirdi.
    ///      Kaydediliyor, kapatilmiyor -- `ArcpadLocker`in bagis hucresiyle
    ///      ayni sinifta.
    function test_theSmallestQuoteSwapThatWorksIsTwoUnitsAndOneUnitRevertsLoudly() public {
        vm.expectRevert(Hooks.HookDeltaExceedsSwapAmount.selector);
        handler.swapRaw(BELOW, 0, 1);

        // ...ve IKI birim GECER. Kontrol olmadan yukaridaki revert "herhangi
        // bir sebeple" olabilirdi.
        uint256 owedBefore = escrow.owed(TREASURY);
        handler.swapRaw(BELOW, 0, 2);
        assertGt(escrow.owed(TREASURY), owedBefore, "iki birimlik swap ucret uretmedi");

        // SINIR IKI SIRALAMADA DA AYNI YERDEDIR -- ucret mantigi
        // `quoteIsCurrency0`a dallanir, yani tek siralamada olculen bir sinir
        // oburunu KANITLAMAZ.
        vm.expectRevert(Hooks.HookDeltaExceedsSwapAmount.selector);
        handler.swapRaw(ABOVE, 0, 1);
        handler.swapRaw(ABOVE, 0, 2);
    }

    /// @notice On filtre HER SEYI yutmuyor.
    /// @dev Bir bant, tam da elemek icin yazildigi durumu her seferinde elerse
    ///      paket "hicbir sey yapmayan" bir handler'a doner. Deterministik
    ///      kosuda filtrenin HIC devreye girmedigi ve swap'larin GERCEKTEN
    ///      yurudugu iddia edilir.
    function test_theDepthFilterDoesNotSwallowEverything() public {
        for (uint256 shape = 0; shape < 4; ++shape) {
            handler.swap(BELOW, shape, shape < 2 ? 1e5 : 1e20);
        }
        assertEq(handler.swapSkippedForDepth(), 0, "derinlik filtresi mezun bir havuzda devreye girdi");
        assertEq(handler.swaps(), 4, "dort swap yurumedi");
    }

    // ---------------------------------------------------------------
    // ARIZA MODELI -- F6 ve F7
    // ---------------------------------------------------------------

    /// @notice F6. Hedef, TAMAMLANMIS ama MEZUN OLMAMIS bir curve varken
    ///         degisir: curve YENI hedefe mezun olur. Goc yok, kayit yok,
    ///         kayip yok.
    ///
    /// @dev CURVE HEDEFI `graduate()` ANINDA OKUR (`protocolTreasury()` ile
    ///      ayni sinif: canli okuma, onbelleklenmez). Bu testin olctugu sey o
    ///      canliligin SONUCUDUR -- eski locker artik cagiramaz, yenisi
    ///      cagirabilir, ve curve'de hicbir sey kaybolmaz.
    function test_aCurveThatCompletedUnderTheOldTargetGraduatesToTheNewOne() public {
        handler.completeCurve(OPEN, 0);
        (, address curveAddr,) = handler.launchAt(OPEN);
        address payable curve = payable(curveAddr);
        uint256 r = BondingCurve(curve).realQuoteReserves();

        ArcpadLocker newLocker = new ArcpadLocker(pm, address(factory), IHooks(address(hook)));
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(newLocker));
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();

        // ESKI hedef artik cagiramaz, ve curve'de HICBIR SEY hareket etmez.
        vm.expectRevert(BondingCurve.NotGraduationTarget.selector);
        locker.graduate(curve);
        assertFalse(BondingCurve(curve).graduated(), "eski hedef yine de mezun etti");
        assertEq(BondingCurve(curve).realQuoteReserves(), r, "basarisiz denemede R hareket etti");

        // YENI hedef mezun eder, ve havuz YENI locker'in pozisyonunu tasir.
        newLocker.graduate(curve);
        assertTrue(BondingCurve(curve).graduated(), "yeni hedef mezun edemedi");
        PoolKey memory key = handler.keyAt(OPEN);
        (uint128 liq,,) = pm.getPositionInfo(
            key.toId(), address(newLocker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        assertGt(liq, 0, "yeni locker'in pozisyonu yok");
        (uint128 oldLiq,,) = pm.getPositionInfo(
            key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        assertEq(oldLiq, 0, "eski locker bu havuzda pozisyon tasiyor");
        assertEq(address(locker).balance, handler.expectedLockerResidue(), "eski locker'a quote sizdi");
    }

    /// @notice F7. Hedef, ZATEN MEZUN OLMUS bir curve varken degisir: hicbir
    ///         sey. O havuz ESKI locker'in pozisyonunu tasir ve calismaya
    ///         devam eder.
    ///
    /// @dev `beforeSwap` HEDEFE BAKMAZ -- ve bu testin oldurdugu mutant tam
    ///      olarak "swap yolunda hedefi okumak"tir. O mutant altinda her
    ///      yeniden yonlendirme, daha once mezun olmus HER havuzu olduruerdi;
    ///      hicbir graduation testi bunu gormezdi.
    function test_aGraduatedCurveIsUnaffectedByARepoint() public {
        PoolKey memory key = handler.keyAt(BELOW);
        (uint128 before_,,) = pm.getPositionInfo(
            key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        assertGt(before_, 0, "pozisyon yok -- test hicbir sey olcmuyor");
        (uint160 priceBefore,,,) = pm.getSlot0(key.toId());

        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(0x11E11));
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();
        assertEq(factory.graduationTarget(), address(0x11E11), "hedef inmedi");

        // (a) POZISYON VE FIYAT KIMILDAMAZ.
        (uint128 after_,,) = pm.getPositionInfo(
            key.toId(), address(locker), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        assertEq(after_, before_, "yeniden yonlendirme pozisyonu degistirdi");
        (uint160 priceAfter,,,) = pm.getSlot0(key.toId());
        assertEq(priceAfter, priceBefore, "yeniden yonlendirme fiyati degistirdi");

        // (b) VE SWAP CALISMAYA DEVAM EDER, UCRETIYLE BIRLIKTE.
        uint256 owedBefore = escrow.owed(TREASURY);
        handler.swap(BELOW, 0, 1e5);
        assertEq(handler.swapReverted(), 0, "yeniden yonlendirmeden sonra swap revert etti");
        assertGt(escrow.owed(TREASURY), owedBefore, "yeniden yonlendirmeden sonra swap ucret uretmedi");
    }

    // ---------------------------------------------------------------
    // Kurulum yardimcilari
    // ---------------------------------------------------------------

    /// @dev DONGU SINIRLI VE BULAMAZSA KURULUM DUSER -- sessizce "obur
    ///      siralamayla devam" etmek, iddiayi bos birakirdi.
    function _nameSortingBelowUsdc() internal view returns (string memory) {
        for (uint256 i = 0; i < 128; ++i) {
            string memory name = string.concat("ARC", vm.toString(i));
            (address predicted,) = factory.predictAddresses(CREATOR, name, "ARC", "ipfs://x", factory.launchCount());
            if (predicted < GraduationMath.QUOTE) return name;
        }
        revert("128 denemede USDC'nin ALTINA dusen aday yok");
    }

    function _nameSortingAboveUsdc() internal view returns (string memory) {
        for (uint256 i = 0; i < 128; ++i) {
            string memory name = string.concat("UP", vm.toString(i));
            (address predicted,) = factory.predictAddresses(CREATOR, name, "ARC", "ipfs://x", factory.launchCount());
            if (predicted > GraduationMath.QUOTE) return name;
        }
        revert("128 denemede USDC'nin USTUNE cikan aday yok");
    }

    function _launchInto(string memory name) internal {
        vm.prank(CREATOR);
        (address token, address curve) = factory.launch(name, "ARC", "ipfs://x");
        (PoolKey memory key, bool baseIsCurrency0) = GraduationMath.poolKey(token, IHooks(address(hook)));
        handler.register(token, payable(curve), key, baseIsCurrency0);
    }
}
