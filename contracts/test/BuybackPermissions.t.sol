// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../src/BuybackVestingVault.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @dev Havuz merciine HIC girilmez bu pakette; adres yalnizca constructor'in
///      sifir kontrolunu gecmek icin gerekli.
contract StubPoolManager {
    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }
}

/**
 * @title BuybackPermissions
 * @notice Ozelligin GUVEN CEKIRDEGI: kim buyback'i acabilir, kim kapatabilir.
 *
 * @dev NICIN AYRI BIR PAKET, VE NICIN VAR. `Surface.t.sol` bu fonksiyonlarin
 *      ABI'de OLDUGUNU iddia ediyordu; `LaunchFactory.t.sol` buyback'ten
 *      yalnizca "kapali bir taslak politikasi" olarak soz ediyordu. Yani
 *      izin modelinin DAVRANISI -- spec §6'nin cekirdegi -- hicbir yerde
 *      yurunmuyordu. Bir yuzey testi bir imzanin varligini kanitlar, o
 *      imzanin ARKASINDAKI KURALI degil.
 *
 * @dev KURAL, TEK CUMLE: creator iki yone de gidebilir; governor YALNIZCA
 *      kapatabilir. Asimetrinin sebebi `setBuybackEnabled`in NatSpec'inde
 *      yazili: buyback'in parasi creator'in gelirinden cikar ama ciktisinin
 *      %30'u protokole gider, dolayisiyla protokolun ACABILMESI, bir
 *      creator'in gelirini protokolun pay aldigi bir kasaya ZORLA yonlendirmek
 *      olurdu.
 */
contract BuybackPermissionsTest is Test {
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant GOVERNOR = address(0x600D);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0FFEE);
    address internal constant STRANGER = address(0xBAD);
    address internal constant HOOK = address(0x400C);
    address internal constant KEEPER = address(0x4EE9);

    FeeEscrow internal escrow;
    FeeSchedule internal schedule;
    LaunchFactory internal factory;
    BuybackVestingVault internal vault;
    BuybackTreasury internal treasury;

    address internal token;
    address payable internal curve;

    function setUp() public {
        escrow = new FeeEscrow();
        schedule = new FeeSchedule();
        factory = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(schedule));
        vault = new BuybackVestingVault(address(factory));
        treasury =
            new BuybackTreasury(address(factory), address(escrow), vault, IPoolManager(address(new StubPoolManager())));
    }

    function _wireTreasury() internal {
        vm.prank(GOVERNOR);
        factory.setBuybackTreasury(address(treasury));
    }

    function _launch() internal {
        vm.prank(CREATOR);
        (address tk, address cv) = factory.launch("Arc", "ARC", "ipfs://x");
        token = tk;
        curve = payable(cv);
    }

    /// @dev Kucuk bir alim; creator ucreti uretir.
    function _buy(uint256 weiIn) internal {
        vm.deal(BUYER, weiIn);
        vm.prank(BUYER);
        BondingCurve(curve).buyExactQuoteIn{value: weiIn}(0);
    }

    // ---------------------------------------------------------------
    // 1. ASIMETRI
    // ---------------------------------------------------------------

    function test_creator_acabilir() public {
        _wireTreasury();
        _launch();
        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, true);
        assertTrue(factory.buybackEnabledOf(token), "creator acamadi");
    }

    function test_creator_kapatabilir() public {
        _wireTreasury();
        _launch();
        vm.startPrank(CREATOR);
        factory.setBuybackEnabled(token, true);
        factory.setBuybackEnabled(token, false);
        vm.stopPrank();
        assertFalse(factory.buybackEnabledOf(token), "creator kapatamadi");
    }

    /// ============ OZELLIGIN GUVEN MODELININ TAMAMI, TEK TESTTE ============
    function test_governor_ACAMAZ() public {
        _wireTreasury();
        _launch();
        vm.prank(GOVERNOR);
        vm.expectRevert(LaunchFactory.GovernorCannotEnableBuyback.selector);
        factory.setBuybackEnabled(token, true);
        assertFalse(factory.buybackEnabledOf(token), "governor buyback'i acti");
    }

    /// ...AMA KAPATABILIR, ve bu zararsizdir: yapabilecegi tek sey gelecekteki
    /// gelirin TAMAMINI creator'a birakmaktir.
    function test_governor_kapatabilir() public {
        _wireTreasury();
        _launch();
        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, true);

        vm.prank(GOVERNOR);
        factory.setBuybackEnabled(token, false);
        assertFalse(factory.buybackEnabledOf(token), "governor kapatamadi");
    }

    function test_yabanci_hicbirini_yapamaz() public {
        _wireTreasury();
        _launch();
        vm.startPrank(STRANGER);
        vm.expectRevert(LaunchFactory.NotLaunchCreator.selector);
        factory.setBuybackEnabled(token, true);
        vm.expectRevert(LaunchFactory.NotLaunchCreator.selector);
        factory.setBuybackEnabled(token, false);
        vm.stopPrank();
    }

    /// @dev BU FABRIKANIN BASMADIGI bir token reddedilir -- aksi halde biri
    ///      rastgele bir adres icin defterde giris acabilirdi.
    function test_taninmayan_token_reddedilir() public {
        _wireTreasury();
        vm.prank(CREATOR);
        vm.expectRevert(LaunchFactory.UnknownLaunch.selector);
        factory.setBuybackEnabled(address(0xDEAD), true);
    }

    // ---------------------------------------------------------------
    // 2. HAZINE BAGLANMADAN ACILAMAZ
    // ---------------------------------------------------------------

    function test_hazine_yokken_creator_acamaz() public {
        _launch();
        vm.prank(CREATOR);
        vm.expectRevert(LaunchFactory.BuybackUnavailable.selector);
        factory.setBuybackEnabled(token, true);
    }

    function test_hazine_yokken_launchWithBuyback_reddedilir() public {
        vm.prank(CREATOR);
        vm.expectRevert(LaunchFactory.BuybackUnavailable.selector);
        factory.launchWithBuyback("Arc", "ARC", "ipfs://x", true);
    }

    /// @dev Hazine yokken buyback'i KAPATMAK serbesttir: zaten kapali olani
    ///      kapatmak bir islem degildir ve bir operator betigi idempotent
    ///      olabilmelidir.
    function test_hazine_yokken_kapatmak_serbest() public {
        _launch();
        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, false);
        assertFalse(factory.buybackEnabledOf(token));
    }

    // ---------------------------------------------------------------
    // 3. TOGGLE YARISI (§7) -- ISARETLEME ISLEM ANINDA
    // ---------------------------------------------------------------

    /**
     * KAPATMAK, ONCEDEN AYRILMIS PARAYI GERI ALMAZ.
     *
     * @dev Referans uygulamada ucretler egride birikir ve supurmede bolusulur,
     *      dolayisiyla "supurmeden hemen once kapat" butun birikmis payi geri
     *      alirdi. Bizde isaretleme ucretin KAZANILDIGI islemde yapilir, yani
     *      o yaris YAPISAL OLARAK YOKTUR. Bu test o yapisal ozelligi yurur.
     */
    function test_kapatmak_onceden_ayrilmis_butceyi_geri_almaz() public {
        _wireTreasury();
        _launch();
        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, true);

        _buy(10e18);
        uint256 accrued = treasury.pendingQuote(token);
        assertGt(accrued, 0, "acikken hic pay ayrilmadi -- test bosluk olcuyor");

        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, false);

        assertEq(treasury.pendingQuote(token), accrued, "kapatmak birikmis butceyi geri aldi");
    }

    /**
     * ...VE ACMAK, GECMISTE KAZANILMIS UCRETI BUYBACK'E CEVIRMEZ.
     *
     * @dev Ayni ozelligin obur yuzu. Kapaliyken kazanilan ucret escrow'a nakit
     *      olarak gitti; hazineye HIC yatirilmadi, dolayisiyla sonradan acmak
     *      onu geri getiremez. "Eski ucretler eski politikayi izler" cumlesinin
     *      iki yarisi bu iki testtir.
     */
    function test_acmak_gecmis_ucreti_buybacke_cevirmez() public {
        _wireTreasury();
        _launch();

        _buy(10e18);
        assertEq(treasury.pendingQuote(token), 0, "kapaliyken pay ayrildi");
        uint256 cashBefore = escrow.owed(CREATOR);
        assertGt(cashBefore, 0, "kapaliyken creator nakit almadi -- test bosluk olcuyor");

        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, true);

        assertEq(treasury.pendingQuote(token), 0, "acmak gecmis ucreti hazineye tasidi");
        assertEq(escrow.owed(CREATOR), cashBefore, "acmak creator'in nakdini geri aldi");
    }

    /// @dev ...VE ACTIKTAN SONRAKI islemler ayrilir. Ustteki iki testin
    ///      anti-vakumu: toggle'in HICBIR SEY yapmadigi bir dunyada ikisi de
    ///      yesil kalirdi.
    function test_actiktan_sonraki_islemler_ayrilir() public {
        _wireTreasury();
        _launch();
        _buy(10e18);

        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, true);

        _buy(10e18);
        assertGt(treasury.pendingQuote(token), 0, "actiktan sonra da ayrilmadi -- toggle etkisiz");
    }

    // ---------------------------------------------------------------
    // 4. BIR KEZ YAZILAN KABLOLAMA
    // ---------------------------------------------------------------

    function test_hazine_yalnizca_governor_ve_BIR_KEZ() public {
        vm.prank(STRANGER);
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        factory.setBuybackTreasury(address(treasury));

        _wireTreasury();

        // IKINCI YAZIM REDDEDILIR. Degistirilebilir olsaydi governor,
        // creator'larin ayrilmis paylarini kendi kontrol ettigi bir adrese
        // yonlendirebilirdi.
        vm.prank(GOVERNOR);
        vm.expectRevert(LaunchFactory.HookAlreadySet.selector);
        factory.setBuybackTreasury(address(0xBEEF));
        assertEq(factory.buybackTreasury(), address(treasury), "hazine degisti");
    }

    function test_graduationHook_yalnizca_governor_ve_BIR_KEZ() public {
        vm.prank(STRANGER);
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        factory.setGraduationHook(HOOK);

        vm.startPrank(GOVERNOR);
        factory.setGraduationHook(HOOK);
        // Degistirilebilir olsaydi governor, hazineye TAHAKKUK YETKISI olan
        // sahte bir adres kaydedebilirdi.
        vm.expectRevert(LaunchFactory.HookAlreadySet.selector);
        factory.setGraduationHook(address(0xBEEF));
        vm.stopPrank();
        assertEq(factory.graduationHook(), HOOK, "hook degisti");
    }

    /// @dev ANAHTARCI ISTISNADIR VE DEGISTIRILEBILIR OLMALIDIR: anahtar
    ///      rotasyonu bir operasyon gerekliligidir, ve anahtarcinin tek yetkisi
    ///      supurmeyi TETIKLEMEKTIR -- nereye harcanacagi hazinede sabittir.
    function test_anahtarci_dondurulebilir() public {
        vm.startPrank(GOVERNOR);
        factory.setBuybackKeeper(KEEPER);
        assertEq(factory.buybackKeeper(), KEEPER);
        factory.setBuybackKeeper(STRANGER);
        assertEq(factory.buybackKeeper(), STRANGER, "anahtarci dondurulemedi");
        vm.stopPrank();

        vm.prank(STRANGER);
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        factory.setBuybackKeeper(address(0xBEEF));
    }

    // ---------------------------------------------------------------
    // 5. POLITIKA OKUMASI
    // ---------------------------------------------------------------

    /// @dev Curve ve hook'un okudugu TEK karar noktasi. Kapali bir launch icin
    ///      SIFIR HAZINE doner -- carpim hic yapilmaz.
    function test_buybackPolicy_kapaliyken_sifir_doner() public {
        _wireTreasury();
        _launch();
        (address t, uint256 bps) = factory.buybackPolicy(token);
        assertEq(t, address(0), "kapaliyken hazine bildirdi");
        assertEq(bps, 0, "kapaliyken oran bildirdi");

        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, true);
        (t, bps) = factory.buybackPolicy(token);
        assertEq(t, address(treasury), "acikken hazine bildirmedi");
        assertEq(bps, factory.BUYBACK_LOCK_BPS(), "acikken oran bildirmedi");
    }
}
