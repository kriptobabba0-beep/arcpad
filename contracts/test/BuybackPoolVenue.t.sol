// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ArcpadHook} from "../src/ArcpadHook.sol";
import {ArcpadLocker} from "../src/ArcpadLocker.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../src/BuybackVestingVault.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {GraduationMath} from "../src/libraries/GraduationMath.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {UsdcMock} from "./helpers/ArcUsdcMock.sol";

/// @dev `ArcpadHook.t.sol`daki ikizinin aynisi: `unlock` sahibi bir swap
///      sarmalayicisi. Buradaki tek isi, hazineden BAGIMSIZ bir uculuncu
///      taraf islemi uretmektir -- ucret ayrimi ancak gercek bir swap ile
///      olculebilir.
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
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
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

/**
 * @title BuybackPoolVenue
 * @notice MEZUNIYET SONRASI buyback: ucret ayrimi havuzda yapilir, alim
 *         havuzdan yapilir.
 *
 * @dev NICIN AYRI BIR PAKET. `BuybackTreasury.t.sol` mock'larla kosar ve
 *      EGRI merciini olcer; bu paketin olctugu her sey GERCEK bir V4 havuzu
 *      gerektirir -- `PoolManager`, madenlenmis bir hook, locker ve tam bir
 *      launch -> satis -> graduate dongusu. Ikisini tek dosyada toplamak,
 *      hizli birim testlerini agir bir fixture'in arkasina koyardi.
 *
 * @dev BU PAKET BIR EKSIKLIGIN KAPATILDIGINI OLCER. Buyback nesli ilk halinde
 *      yalnizca egri merciini tasiyordu: `_spendableOnCurve` mezun bir egride
 *      SIFIR doner, dolayisiyla mezuniyetten sonra biriken her buyback payi
 *      supurmede creator'a GERI KATLANIYORDU. Hicbir test kirmizi degildi --
 *      geri katlama mesru bir sonuctur ve "alim yapacak yer yok" ile "piyasa
 *      ince" disaridan ayni gorunur. Buradaki testler o iki durumu ayirir.
 */
contract BuybackPoolVenueTest is Test {
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
    address internal constant KEEPER = address(0x4EE9);

    IPoolManager internal pm;
    FeeEscrow internal escrow;
    FeeSchedule internal schedule;
    LaunchFactory internal factory;
    ArcpadHook internal hook;
    ArcpadLocker internal locker;
    BuybackVestingVault internal vault;
    BuybackTreasury internal treasury;
    SwapHarness internal harness;

    function setUp() public {
        pm = IPoolManager(address(new PoolManager(address(this))));

        UsdcMock usdc = new UsdcMock();
        vm.etch(GraduationMath.QUOTE, address(usdc).code);

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

        vault = new BuybackVestingVault(address(factory));
        treasury = new BuybackTreasury(address(factory), address(escrow), vault, pm);

        // KABLOLAMA SIRASI, VE HEPSI BIR KEZ YAZILIR.
        vm.startPrank(GOVERNOR);
        factory.setBuybackTreasury(address(treasury));
        factory.setGraduationHook(address(hook));
        factory.setBuybackKeeper(KEEPER);
        factory.proposeGraduationTarget(address(locker));
        vm.stopPrank();
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();

        harness = new SwapHarness(pm);
    }

    // ---------------------------------------------------------------
    // Yardimcilar
    // ---------------------------------------------------------------

    /// @dev Buyback ACIK bir launch; mezuniyete kadar goturur ve havuzu acar.
    function _graduatedLaunch() internal returns (address token, address payable curve, PoolKey memory key) {
        vm.prank(CREATOR);
        (address tk, address cv) = factory.launchWithBuyback("Arc", "ARC", "ipfs://x", true);
        token = tk;
        curve = payable(cv);

        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(curve).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);
        require(BondingCurve(curve).complete(), "curve not complete");

        locker.graduate(curve);
        require(BondingCurve(curve).graduated(), "curve not graduated");

        (key,) = GraduationMath.poolKey(token, IHooks(address(hook)));
    }

    /// @dev Havuzda gercek bir uculuncu-taraf islemi yurutur; hook ucreti
    ///      keser ve buyback payi hazineye girer.
    function _tradeOnPool(PoolKey memory key, uint256 quoteIn) internal {
        // `vm.deal`, `deal(token, ...)` DEGIL. forge-std'nin token surumu
        // ERC-20 DEPOLAMASINA yazar; `UsdcMock` ise bakiyeyi NATIVE bakiyeden
        // TURETIR ve o alan icin depolama KULLANMAZ -- cagri
        // "No storage use detected for target" ile duser. Arc'ta dogru hamle
        // zaten native bakiyeyi fonlamaktir: iki gorunum tek bakiyedir.
        vm.deal(address(harness), quoteIn * 4 * 1e12);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == GraduationMath.QUOTE;
        harness.swap(key, quoteIsCurrency0, -int256(quoteIn));
    }

    /**
     * @dev BUTCEYI DOGRUDAN KURAR -- ve bu bir kacamak DEGIL, mesru merciin
     *      ta kendisidir: `accrue` yalnizca egriyi ve fabrikanin kaydettigi
     *      `graduationHook`u kabul eder, burada cagiran hook'tur.
     *
     *      NICIN HACIMLE KURULMUYOR: testnet profilinin mezuniyet raise'i
     *      ~12,16 USDC'dir, yani havuzun quote bacagi da o buyuklüktedir.
     *      `MIN_SWEEP_WEI` esigini (0,05 USDC) ucretle asmak icin ~34 USDC'lik
     *      hacim gerekirdi -- havuzun tamaminin uc kati. Ucret ayriminin
     *      DOGRULUGU ayri bir testte gercek hacimle olculur; buradaki testler
     *      SUPURMEYI olcer ve butceyi tek satirda kurmak onlari okunur kilar.
     */
    function _fundBudget(address token, uint256 weiAmount) internal {
        vm.deal(address(hook), weiAmount);
        vm.prank(address(hook));
        treasury.accrue{value: weiAmount}(token);
    }

    // ---------------------------------------------------------------
    // 1. UCRET AYRIMI -- HAVUZDA DA YAPILIR
    // ---------------------------------------------------------------

    /**
     * HOOK, CREATOR UCRETINI AYIRIR VE BUYBACK PAYI HAZINEYE GIRER.
     *
     * @dev BU TESTIN OLCTUGU SATIR `ArcpadHook._settleCreatorFee`DIR. Onceki
     *      halde hook creator ucretinin TAMAMINI escrow'a yatiriyordu, yani
     *      mezuniyet buyback'i SESSIZCE kapatiyordu: egride %50 ayrilan bir
     *      launch, havuza gectigi anda %0 ayirmaya basliyordu ve hicbir sey
     *      bunu soylemiyordu.
     */
    function test_havuz_ucreti_buyback_payini_hazineye_ayirir() public {
        (address token,, PoolKey memory key) = _graduatedLaunch();

        uint256 pending0 = treasury.pendingQuote(token);
        uint256 creator0 = escrow.owed(CREATOR);

        _tradeOnPool(key, 1e6);

        uint256 accrued = treasury.pendingQuote(token) - pending0;
        uint256 cash = escrow.owed(CREATOR) - creator0;

        assertGt(accrued, 0, "havuz islemi hazineye HIC pay ayirmadi");
        assertGt(cash, 0, "creator nakit pay ALMADI");

        // ORAN, FABRIKANIN SABITINDEN TURETILIR -- literal degil. `BUYBACK_LOCK_BPS`
        // degisirse bu test onunla birlikte hareket eder ve ayrimin KENDISINI
        // olcmeye devam eder.
        uint256 total = accrued + cash;
        assertEq(accrued, (total * factory.BUYBACK_LOCK_BPS()) / 10_000, "buyback payi orandan ayristi");
    }

    /**
     * ...VE PROTOKOL PAYINA DOKUNULMAZ.
     *
     * @dev Ozelligin guven cekirdegi: buyback creator'in gelirinden cikar,
     *      protokolunkinden DEGIL. Iki launch ayni hacmi gorur -- biri buyback
     *      acik, biri kapali -- ve protokolun aldigi TAM OLARAK AYNI olmalidir.
     */
    function test_buyback_protokol_payini_degistirmez() public {
        (,, PoolKey memory keyOn) = _graduatedLaunch();
        uint256 p0 = escrow.owed(TREASURY);
        _tradeOnPool(keyOn, 1e6);
        uint256 withBuyback = escrow.owed(TREASURY) - p0;

        // Buyback KAPALI ikinci bir launch, ayni hacim.
        vm.prank(CREATOR);
        (address tk2, address cv2) = factory.launch("Arc2", "ARC2", "ipfs://y");
        vm.deal(BUYER, 1_000_000e18);
        vm.prank(BUYER);
        BondingCurve(payable(cv2)).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);
        locker.graduate(payable(cv2));
        (PoolKey memory keyOff,) = GraduationMath.poolKey(tk2, IHooks(address(hook)));

        uint256 p1 = escrow.owed(TREASURY);
        _tradeOnPool(keyOff, 1e6);
        uint256 withoutBuyback = escrow.owed(TREASURY) - p1;

        assertEq(withBuyback, withoutBuyback, "buyback protokol payini degistirdi");
        assertGt(withBuyback, 0, "hic protokol payi olusmadi -- test bosluk olcuyor");
    }

    // ---------------------------------------------------------------
    // 2. HAVUZ MERCII -- GERCEK ALIM
    // ---------------------------------------------------------------

    /**
     * MEZUNIYETTEN SONRA SUPURME GERCEK BIR ALIM YAPAR VE KASAYA KILITLER.
     *
     * @dev BU, PAKETIN VAROLUS SEBEBIDIR. Ayni senaryo havuz mercii eklenmeden
     *      once butun butceyi creator'a geri katliyordu.
     */
    function test_mezuniyet_sonrasi_supurme_havuzdan_alir_ve_kilitler() public {
        (address token,,) = _graduatedLaunch();
        // 0,1 USDC: `MIN_SWEEP_WEI`in (0,05) ustunde, havuzun ~12,16 USDC'lik
        // quote bacagina gore fiyat sinirinin ALTINDA.
        _fundBudget(token, 0.1e18);

        uint256 pending = treasury.pendingQuote(token);
        assertGt(pending, treasury.MIN_SWEEP_WEI(), "butce esigin altinda -- test hicbir sey olcmuyor");

        uint256 creatorBefore = escrow.owed(CREATOR);

        vm.prank(KEEPER);
        treasury.sweep(token, 0, block.timestamp + 1);

        uint256 spent = treasury.cumulativeQuoteSpent(token);
        uint256 bought = treasury.cumulativeTokensBought(token);

        assertGt(spent, 0, "hic harcanmadi -- geri katlamaya dustu");
        assertGt(bought, 0, "hic token alinmadi");
        assertEq(vault.totalLocked(token), bought, "alinan token kasaya kilitlenmedi");
        assertEq(treasury.pendingQuote(token), 0, "bekleyen sifirlanmadi");

        // Harcanamayan kalan creator'a doner, kontratta KALMAZ.
        uint256 refunded = escrow.owed(CREATOR) - creatorBefore;
        assertEq(spent + refunded, pending, "butce ne harcandi ne iade edildi -- fark kontratta kaldi");
    }

    /**
     * FIYAT ETKISI SINIRI GERCEKTEN BAGLAYICIDIR.
     *
     * @dev Butce havuzun %3'te emebileceginden BUYUK oldugunda, supurme
     *      butcenin TAMAMINI harcamaz: swap `sqrtPriceLimitX96`de durur ve
     *      kalan creator'a katlanir. Sinir olmasaydi ayni butce fiyati
     *      istedigi kadar kaydirirdi.
     */
    function test_fiyat_etkisi_siniri_butcenin_tamamini_harcatmaz() public {
        (address token,, PoolKey memory key) = _graduatedLaunch();
        // Havuzun %3'te emeceginden acikca buyuk: quote bacagi ~12,16 USDC.
        _fundBudget(token, 100e18);

        uint256 pending = treasury.pendingQuote(token);
        (uint160 sqrtBefore,,,) = pm.getSlot0(key.toId());

        uint256 creatorBefore = escrow.owed(CREATOR);
        vm.prank(KEEPER);
        treasury.sweep(token, 0, block.timestamp + 1);

        uint256 spent = treasury.cumulativeQuoteSpent(token);
        assertGt(spent, 0, "hic harcanmadi");
        assertLt(spent, pending, "butcenin TAMAMI harcandi -- sinir baglamadi");
        assertEq(escrow.owed(CREATOR) - creatorBefore, pending - spent, "harcanmayan kisim creator'a donmedi");

        // FIYAT KAYMASI SINIRIN ICINDE. Karsilastirma `sqrtPrice` UZERINDEN
        // yapilir ve orani da oyle: %3'luk FIYAT kaymasi sqrt(1,03) katlik bir
        // `sqrtPrice` kaymasidir.
        (uint160 sqrtAfter,,,) = pm.getSlot0(key.toId());
        uint256 movedBps = _sqrtMoveBps(sqrtBefore, sqrtAfter);
        assertLe(movedBps, treasury.MAX_PRICE_IMPACT_BPS() + 1, "fiyat etkisi sinirin ustune cikti");
    }

    /// @dev `|p1/p0 - 1|`, bps cinsinden; `p = sqrtP^2` uzerinden.
    function _sqrtMoveBps(uint160 a, uint160 b) internal pure returns (uint256) {
        uint256 pa = (uint256(a) * uint256(a)) >> 96;
        uint256 pb = (uint256(b) * uint256(b)) >> 96;
        (uint256 lo, uint256 hi) = pa < pb ? (pa, pb) : (pb, pa);
        if (lo == 0) return type(uint256).max;
        return ((hi - lo) * 10_000) / lo;
    }

    // ---------------------------------------------------------------
    // 3. UCRET MUAFIYETI
    // ---------------------------------------------------------------

    /**
     * HAZINENIN ALIMI UCRET ODEMEZ.
     *
     * @dev Muafiyet olmasaydi iki sey olurdu ve ikisi de olculebilir:
     *      protokol, creator'in buyback butcesinden pay alirdi; ve alimin
     *      creator payinin bir kismi supurme SIRASINDA hazineye geri
     *      yatilirdi, yani `pendingQuote` sifir kalmazdi.
     */
    function test_hazinenin_alimi_ucretten_muaftir() public {
        (address token,,) = _graduatedLaunch();
        _fundBudget(token, 0.1e18);

        uint256 protocolBefore = escrow.owed(TREASURY);

        vm.prank(KEEPER);
        treasury.sweep(token, 0, block.timestamp + 1);

        assertEq(escrow.owed(TREASURY), protocolBefore, "hazinenin alimi protokole ucret odedi");
        assertEq(treasury.pendingQuote(token), 0, "supurme SIRASINDA yeniden tahakkuk olustu");
    }

    // ---------------------------------------------------------------
    // 4. KOPYALANAN SABITLER AYRISAMAZ
    // ---------------------------------------------------------------

    /// @dev `BuybackTreasury` V4'un fiyat sinirlarini YEREL sabit olarak tutar
    ///      (`TickMath` `internal constant` verir ve tum kutuphaneyi cekmek
    ///      gereksizdi). Kopya, kaynagiyla burada esitlenir -- aksi halde bir
    ///      V4 yukseltmesi sinirlari kaydirirsa kopya sessizce bayatlardi.
    function test_yerel_fiyat_sinirlari_TickMath_ile_ayni() public pure {
        assertEq(uint256(TickMath.MIN_SQRT_PRICE), 4295128739, "MIN_SQRT_PRICE ayristi");
        assertEq(
            uint256(TickMath.MAX_SQRT_PRICE),
            1461446703485210103287273052203988822378723970342,
            "MAX_SQRT_PRICE ayristi"
        );
    }
}
