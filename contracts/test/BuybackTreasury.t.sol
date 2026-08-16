// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../src/BuybackVestingVault.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";

contract MockLaunchToken is ERC20 {
    address public curve;

    constructor(address curve_) ERC20("Mock", "MOCK") {
        curve = curve_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * ACILMAMIS BIR HAVUZ BILDIREN en kucuk `PoolManager` yuzeyi.
 *
 * BU PAKET EGRI MERCIINI OLCER, HAVUZ MERCIINI DEGIL. Gercek bir V4 havuzu
 * kurmak `PoolManager` + hook + locker + tam bir mezuniyet dongusu demektir ve
 * o, bir birim testinin degil `test/BuybackPoolVenue.t.sol`un isidir.
 *
 * `getSlot0` SIFIR DONER, yani mezun bir egride supurme "pool-not-initialized"
 * ile geri katlanir. Bu bir kacamak DEGIL, kontratin gercek bir dalidir ve
 * burada tam olarak o dal olculur.
 */
contract MockPoolManager {
    /// @dev `extsload`, `getSlot0` DEGIL -- VE FARK OLCULDU. `StateLibrary`
    ///      slot0'i bir GORUNUM FONKSIYONUYLA degil, ham depolama okumasiyla
    ///      alir (`extsload(bytes32)`, selector `0x1e2eaeaf`). Bir `getSlot0`
    ///      taklidi HIC CAGRILMAZ ve cagri "unrecognized function selector"
    ///      ile duser; ilk hal tam olarak boyle kirmizi oldu. Sifir donmek
    ///      "havuz acilmamis" demektir.
    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }
}

/// Egrinin buyback icin gereken en kucuk yuzeyi. Sabit carpim taklit edilir.
contract MockCurve {
    address public token;
    address public creator;
    bool public complete;
    bool public graduated;
    uint256 public virtualQuoteReserves = 4.292e18;
    uint256 public virtualTokenReserves = 1_073_000_000e18;
    uint256 public realTokenReserves = 793_100_000e18;

    /// Alimda gercekten token gonderir; miktar sabit carpimdan hesaplanir.
    function buyExactQuoteIn(uint256 minTokensOut) external payable {
        uint256 k = virtualQuoteReserves * virtualTokenReserves;
        uint256 newQ = virtualQuoteReserves + msg.value;
        uint256 newT = k / newQ;
        uint256 out = virtualTokenReserves - newT;
        require(out >= minTokensOut, "slippage");
        require(out <= realTokenReserves, "reserve");
        virtualQuoteReserves = newQ;
        virtualTokenReserves = newT;
        realTokenReserves -= out;
        MockLaunchToken(token).mint(msg.sender, out);
    }

    function setToken(address t) external {
        token = t;
    }

    function setCreator(address c) external {
        creator = c;
    }

    function setComplete(bool v) external {
        complete = v;
    }

    function setGraduated(bool v) external {
        graduated = v;
    }

    function setReserves(uint256 q, uint256 t, uint256 r) external {
        virtualQuoteReserves = q;
        virtualTokenReserves = t;
        realTokenReserves = r;
    }
}

contract MockFactory {
    address public protocolTreasury;
    address public buybackTreasury;
    address public graduationHook;
    address public buybackKeeper;

    function set(address t, address bt, address h, address k) external {
        protocolTreasury = t;
        buybackTreasury = bt;
        graduationHook = h;
        buybackKeeper = k;
    }
}

/**
 * ============================================================================
 *  BUYBACK HAZINESI
 * ============================================================================
 *
 * Cevaplanan soru: "creator'in parasi kaybolabilir mi, yanlis yere gidebilir
 * mi, ya da guvensiz bir fiyata harcanabilir mi".
 */
contract BuybackTreasuryTest is Test {
    BuybackTreasury internal treasury;
    BuybackVestingVault internal vault;
    FeeEscrow internal escrow;
    MockFactory internal factory;
    MockCurve internal curve;
    MockLaunchToken internal token;
    MockPoolManager internal poolManager;

    /// @dev `vm.expectEmit` icin yerel bildirim -- kontratinkiyle AYNI imza.
    event BuybackSkipped(address indexed token, uint256 quoteReturnedToCreator, string reason);

    address internal constant PROTOCOL = address(0xDA0);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant KEEPER = address(0x4EE9);
    address internal constant HOOK = address(0x400C);
    address internal constant STRANGER = address(0xBAD);

    uint256 internal constant START = 1_000_000_000;

    function setUp() public {
        vm.warp(START);
        escrow = new FeeEscrow();
        factory = new MockFactory();
        vault = new BuybackVestingVault(address(factory));
        poolManager = new MockPoolManager();
        treasury = new BuybackTreasury(address(factory), address(escrow), vault, IPoolManager(address(poolManager)));
        factory.set(PROTOCOL, address(treasury), HOOK, KEEPER);

        curve = new MockCurve();
        token = new MockLaunchToken(address(curve));
        curve.setToken(address(token));
        curve.setCreator(CREATOR);
    }

    function _accrue(uint256 amount) internal {
        vm.deal(address(curve), amount);
        vm.prank(address(curve));
        treasury.accrue{value: amount}(address(token));
    }

    // ================================================================
    // Tahakkuk yetkisi
    // ================================================================

    function test_egri_tahakkuk_edebilir() public {
        _accrue(1e18);
        assertEq(treasury.pendingQuote(address(token)), 1e18);
    }

    function test_hook_tahakkuk_edebilir() public {
        vm.deal(HOOK, 1e18);
        vm.prank(HOOK);
        treasury.accrue{value: 1e18}(address(token));
        assertEq(treasury.pendingQuote(address(token)), 1e18);
    }

    function test_yabanci_tahakkuk_edemez() public {
        vm.deal(STRANGER, 1e18);
        vm.prank(STRANGER);
        vm.expectRevert(BuybackTreasury.NotAccrualVenue.selector);
        treasury.accrue{value: 1e18}(address(token));
    }

    /// ZORLA GONDERILEN PARA HICBIR BUTCEYI BUYUTMEZ (§30 "forced transfers").
    function test_dogrudan_bagis_butceyi_sismez() public {
        _accrue(1e18);
        vm.deal(STRANGER, 100e18);
        vm.prank(STRANGER);
        (bool ok,) = address(treasury).call{value: 100e18}("");
        assertTrue(ok, "receive kabul eder");
        assertEq(treasury.pendingQuote(address(token)), 1e18, "butce degismez");
    }

    // ================================================================
    // Supurme: basarili alim
    // ================================================================

    function test_supurme_alir_ve_kasaya_kilitler() public {
        _accrue(0.05e18); // esigin tam ustu, fiyat etkisi sinirinin altinda
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);

        uint256 bought = treasury.cumulativeTokensBought(address(token));
        assertGt(bought, 0, "gercek alim oldu");
        assertEq(vault.totalLocked(address(token)), bought, "hepsi kasada");
        assertEq(treasury.pendingQuote(address(token)), 0, "butce bosaldi");
        assertEq(vault.creatorBeneficiary(address(token)), CREATOR);
    }

    // ================================================================
    // §10-11: fiyat etkisi siniri ve GERI KATLAMA
    // ================================================================

    /// Butce sinirdan buyukse: KISMI alim, kalani creator'a.
    function test_fiyat_etkisi_asilirsa_kismi_alir_kalani_creator_a() public {
        // vQ = 4.292e18 -> %3 etki siniri ~0.0322e18. Butce cok daha buyuk.
        _accrue(1e18);
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);

        uint256 spent = treasury.cumulativeQuoteSpent(address(token));
        assertGt(spent, 0, "bir kismi harcandi");
        assertLt(spent, 1e18, "hepsi degil");
        assertEq(escrow.owed(CREATOR), 1e18 - spent, "kalan creator'a");
        assertEq(address(treasury).balance, 0, "kontratta para kalmaz");
    }

    /// FIYAT ETKISI SINIRI TAM FORMULE UYAR: (1+d/vQ)^2 - 1 <= %3.
    function test_harcanan_tutar_fiyat_etkisi_sinirini_asmaz() public {
        _accrue(100e18);
        uint256 vQ = curve.virtualQuoteReserves();
        uint256 cap = treasury.spendable(address(token));

        // (vQ + cap)^2 * 10000 <= vQ^2 * 10300
        assertLe((vQ + cap) * (vQ + cap) * 10_000, vQ * vQ * 10_300, "etki sinir icinde");
        // Ve sinir BOS degil -- yani kural asiri kisitlayici degil.
        assertGt(cap, 0);
    }

    /// EGRI TAMAMLANDIYSA hic alim yapilmaz, para creator'a doner (§9).
    function test_tamamlanmis_egride_para_creator_a_doner() public {
        _accrue(1e18);
        curve.setComplete(true);

        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);

        assertEq(escrow.owed(CREATOR), 1e18, "tamami creator'a");
        assertEq(treasury.cumulativeQuoteSpent(address(token)), 0, "hic harcanmadi");
        assertEq(vault.totalLocked(address(token)), 0, "kasaya bir sey girmedi");
    }

    /**
     * MEZUN EGRI + HAVUZ YOK -> geri katlama, ve SEBEP "pool-not-initialized".
     *
     * BU TESTIN ANLAMI DEGISTI VE DEGISMESI GEREKIYORDU. Onceki hali "mezun
     * egride para creator'a doner" diyordu ve o gun DOGRUYDU: hazinenin tek
     * mercii egriydi, mezuniyetten sonra alim yapacak yer YOKTU. Yani test,
     * bir OZELLIGI degil bir EKSIKLIGI sabitliyordu -- ve ozellik tamamlandigi
     * gun, tamamlandigini fark etmeden kirmizi olacakti.
     *
     * Bugun havuz mercii VAR (`_buyOnPool`). Bu paket onu OLCEMEZ cunku
     * `MockPoolManager` acilmamis bir havuz bildirir; olctugu sey artik
     * mercinin YOKLUGUNDA ne oldugudur. Gercek alim `BuybackPoolVenue.t.sol`da
     * gercek bir havuza karsi yurunur.
     *
     * Sebep dizesi TASIYICIDIR: `below-threshold-or-unsafe` ile ayrilmasi,
     * bir operatorun "havuz hic acilmamis" ile "havuz ince" arasinda karar
     * verebilmesini saglar.
     */
    function test_mezun_egride_havuz_yoksa_para_creator_a_doner() public {
        _accrue(1e18);
        curve.setGraduated(true);

        // `expectEmit` KULLANILMIYOR VE SEBEBI OLCULDU: `_foldBack` ONCE
        // `_refund` cagirir, yani escrow'un `Deposited`i `BuybackSkipped`ten
        // ONCE yayilir. `expectEmit` bir SONRAKI logu esler ve escrow'unkine
        // takilir. Log kaydi, sirayla ilgili hicbir varsayim yapmaz.
        vm.recordLogs();
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("BuybackSkipped(address,uint256,string)");
        string memory reason = "";
        bool found = false;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(treasury) || logs[i].topics[0] != topic) continue;
            (, reason) = abi.decode(logs[i].data, (uint256, string));
            found = true;
        }
        assertTrue(found, "BuybackSkipped hic yayilmadi");
        assertEq(reason, "pool-not-initialized", "sebep ayristi");

        assertEq(escrow.owed(CREATOR), 1e18, "tamami creator'a");
        assertEq(treasury.cumulativeQuoteSpent(address(token)), 0, "hic harcanmadi");
    }

    /// ...VE `spendable` ARTIK MEZUN EGRIDE SIFIR DONMEZ.
    ///
    /// @dev Anahtarcinin okudugu sayi budur. Sifir donseydi anahtarci supurmeyi
    ///      HIC cagirmaz ve havuz mercii -- calisabilecekken -- hic tetiklenmezdi.
    ///      Deger bir UST SINIRDIR; gercekte harcanan `BuybackExecuted`ten okunur.
    function test_spendable_mezuniyetten_sonra_bekleyeni_bildirir() public {
        _accrue(1e18);
        assertGt(treasury.spendable(address(token)), 0, "egri asamasi: pozitif");

        curve.setGraduated(true);
        assertEq(treasury.spendable(address(token)), 1e18, "mezuniyet sonrasi: bekleyenin tamami ust sinir");
    }

    /// SATILABILIR ENVANTER BITTIYSE de para creator'a doner.
    function test_envanter_bittiginde_para_creator_a_doner() public {
        _accrue(1e18);
        curve.setReserves(4.292e18, 1_073_000_000e18, 0);
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);
        assertEq(escrow.owed(CREATOR), 1e18);
    }

    /// PARA PROTOKOLE GITMEZ (§33).
    function test_basarisiz_buyback_protokole_gitmez() public {
        _accrue(1e18);
        curve.setComplete(true);
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);
        assertEq(escrow.owed(PROTOCOL), 0, "protokol basarisiz buyback'ten pay ALMAZ");
    }

    /// ESIGIN ALTINDAKI TOZ da kilitlenmez: creator'a doner.
    function test_esigin_altindaki_toz_creator_a_doner() public {
        _accrue(0.001e18); // MIN_SWEEP_WEI'nin altinda
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);
        assertEq(escrow.owed(CREATOR), 0.001e18);
        assertEq(address(treasury).balance, 0, "toz kontratta hapsolmaz");
    }

    // ================================================================
    // §12: minTokensOut YALNIZCA gercek alimda uygulanir
    // ================================================================

    function test_bayat_slipaj_gercek_alimi_dusurur() public {
        _accrue(0.05e18);
        vm.prank(KEEPER);
        vm.expectRevert(); // egri "slippage" ile duser
        treasury.sweep(address(token), type(uint256).max, block.timestamp + 1);
    }

    /// AMA atlanan bir buyback, absurt bir `minTokensOut` ile bile dagitimi
    /// kilitlemez -- cunku alim hic yapilmaz.
    function test_atlanan_buyback_absurt_slipajla_bile_dagitimi_kilitlemez() public {
        _accrue(1e18);
        curve.setComplete(true);
        vm.prank(KEEPER);
        treasury.sweep(address(token), type(uint256).max, block.timestamp + 1);
        assertEq(escrow.owed(CREATOR), 1e18, "para yine creator'a ulasti");
    }

    // ================================================================
    // §13 / §29: kim supurebilir
    // ================================================================

    function test_yabanci_once_supuremez() public {
        _accrue(1e18);
        vm.prank(STRANGER);
        vm.expectRevert(BuybackTreasury.NotKeeper.selector);
        treasury.sweep(address(token), 0, block.timestamp + 1);
    }

    /// ANAHTARCI SESSIZ KALIRSA para hapsolmaz: sure dolunca herkes cagirabilir.
    function test_anahtarci_sessizse_supurme_izinsizlesir() public {
        _accrue(1e18);
        vm.warp(START + 7 days + 1);
        vm.prank(STRANGER);
        treasury.sweep(address(token), 0, block.timestamp + 1);
        assertGt(escrow.owed(CREATOR) + treasury.cumulativeQuoteSpent(address(token)), 0);
    }

    function test_gecmis_deadline_reddedilir() public {
        _accrue(1e18);
        vm.prank(KEEPER);
        vm.expectRevert(BuybackTreasury.DeadlinePassed.selector);
        treasury.sweep(address(token), 0, block.timestamp - 1);
    }

    function test_bos_butce_supurulemez() public {
        vm.prank(KEEPER);
        vm.expectRevert(BuybackTreasury.NothingPending.selector);
        treasury.sweep(address(token), 0, block.timestamp + 1);
    }

    // ================================================================
    // Muhasebe degismezleri
    // ================================================================

    /// HER SUPURMEDEN SONRA KONTRATTA PARA KALMAZ.
    function test_supurmeden_sonra_kontrat_bos_kalir() public {
        _accrue(1e18);
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);
        assertEq(address(treasury).balance, 0);
    }

    /// HARCANAN + IADE = TAHAKKUK EDEN. Tek wei kaybolmaz.
    function test_harcanan_arti_iade_tahakkuka_esittir() public {
        _accrue(1e18);
        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);
        assertEq(treasury.cumulativeQuoteSpent(address(token)) + escrow.owed(CREATOR), 1e18, "muhasebe kapanir");
    }

    /// IKI TOKEN BIRBIRINE KARISMAZ (§30).
    function test_iki_token_butceleri_ayridir() public {
        MockCurve curve2 = new MockCurve();
        MockLaunchToken token2 = new MockLaunchToken(address(curve2));
        curve2.setToken(address(token2));
        curve2.setCreator(address(0xFEED));

        _accrue(1e18);
        vm.deal(address(curve2), 2e18);
        vm.prank(address(curve2));
        treasury.accrue{value: 2e18}(address(token2));

        assertEq(treasury.pendingQuote(address(token)), 1e18);
        assertEq(treasury.pendingQuote(address(token2)), 2e18);

        vm.prank(KEEPER);
        treasury.sweep(address(token), 0, block.timestamp + 1);

        assertEq(treasury.pendingQuote(address(token2)), 2e18, "B'nin butcesi dokunulmadi");
        assertEq(vault.totalLocked(address(token2)), 0);
    }
}
