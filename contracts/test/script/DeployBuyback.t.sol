// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BuybackDeployLib, BuybackPlan} from "../../script/BuybackDeployLib.sol";
import {DeployLib} from "../../script/DeployLib.sol";
import {BuybackTreasury} from "../../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../../src/BuybackVestingVault.sol";

/**
 * @title DeployBuybackTest
 * @notice Buyback deploy yolunun kapisi.
 *
 * @dev BU BIRIM 44444444'TE DERLENIR VE BU OLCULDU, VARSAYILMADI. `PoolManager`i
 *      dogrudan import etmez ama `BuybackDeployLib` -> `PoolDeployLib` zinciri
 *      onu ISMIYLE ceker, ve bir solc girdisinin TEK optimizer ayari oldugu
 *      icin bu birimdeki HER SEY -- `BuybackTreasury` dahil -- 44444444'e
 *      duser. Ilk hal "bu birim 800'dur" diye yazilmisti ve test bunu ANINDA
 *      yalanladi.
 *
 *      SONUC TASARIMI DEGISTIRMEZ, PEKISTIRIR: `DeployBuyback.s.sol` de ayni
 *      zinciri import eder, yani O DA 44444444'tur. Eger turetme
 *      `type(BuybackTreasury).creationCode`u kullansaydi, betik 44444444'lik
 *      bytecode'un adresini hesaplar ve oraya yayin yapardi -- oysa
 *      `frozen_bytecode_gate.py` ve `BuybackTreasury.t.sol` 800'lik baytlari
 *      tasir. Turetmenin `out-frozen/`dan okumasi tam da bu ayrimi
 *      kapatir.
 */
contract DeployBuybackTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    address internal constant FACTORY = address(0xFAC7);
    address internal constant ESCROW = address(0xE5C0);
    address internal constant POOL_MANAGER = address(0x9001);

    bytes internal constant PLACEHOLDER_RUNTIME = hex"60006000fd";

    function setUp() public {
        // Uc bagimliligin da KODU olmali; turetme "adres dogru" der, kod
        // varligi "kontrat ORADA" der.
        vm.etch(FACTORY, PLACEHOLDER_RUNTIME);
        vm.etch(ESCROW, PLACEHOLDER_RUNTIME);
        vm.etch(POOL_MANAGER, PLACEHOLDER_RUNTIME);
        vm.etch(CREATE2_DEPLOYER, _canonicalDeployerRuntime());
    }

    /// @dev Olculen 69 baytlik kanonik deterministik deployer runtime'i --
    ///      `Deploy.t.sol`daki sabitin AYNISI. `DeployLib` KOD KIMLIGINI
    ///      (codehash) kontrol eder, uzunlugu DEGIL, yani 69 baytlik bir
    ///      dolgu YETMEZ; ilk hal tam olarak boyle kirmizi oldu.
    function _canonicalDeployerRuntime() internal pure returns (bytes memory) {
        return hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0"
            hex"3601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    }

    function _plan() internal view returns (BuybackPlan memory) {
        return BuybackDeployLib.build(31337, FACTORY, ESCROW, POOL_MANAGER);
    }

    function callAssertDeployable(BuybackPlan memory p) external view {
        BuybackDeployLib.assertDeployable(p);
    }

    // ---------------------------------------------------------------
    // 1. TURETME `out-frozen/`DAN GELIR
    // ---------------------------------------------------------------

    /// TERS TANIK: BU BIRIM DONDURULMUS DERLEMEYI GORMEZ -- VE ANKRAJ YINE DE
    /// DOGRUDUR.
    ///
    /// @dev `DeployPool.t.sol::test_thisUnitDoesNotCompileTheFrozenLaunchFactory`
    ///      ile AYNI CIFTIN yarisidir. Tek basina hicbir sey kanitlamaz -- her
    ///      birim kendi icinde tutarlidir -- ama bir sonraki testle birlikte,
    ///      turetmenin `type(...)`ten DEGIL `out-frozen/`dan okumasinin
    ///      ZORUNLU oldugunu gosterir.
    ///
    ///      Bu iddia bir gun duserse (kisit kalkarsa) turetme yine dogru
    ///      kalir; duserken soyleyecegi sey "artik tek bir derleme var"dir, ki
    ///      o da kaydedilmeye degerdir.
    function test_bu_birim_dondurulmus_buyback_derlemesini_GORMEZ() public view {
        bytes memory frozenTreasury =
            vm.parseJsonBytes(vm.readFile("out-frozen/BuybackTreasury.sol/BuybackTreasury.json"), ".bytecode.object");
        assertTrue(
            keccak256(type(BuybackTreasury).creationCode) != keccak256(frozenTreasury),
            "bu birim artik dondurulmus hazineyi goruyor -- kisit kalkmis olabilir, TURETMEYI GOZDEN GECIR"
        );

        bytes memory frozenVault = vm.parseJsonBytes(
            vm.readFile("out-frozen/BuybackVestingVault.sol/BuybackVestingVault.json"), ".bytecode.object"
        );
        assertTrue(
            keccak256(type(BuybackVestingVault).creationCode) != keccak256(frozenVault),
            "bu birim artik dondurulmus kasayi goruyor"
        );
    }

    /// @dev BAGIMSIZ TURETME: CREATE2 formulu burada YENIDEN YAZILIR ve
    ///      girdileri `out-frozen/`dan okunur. `BuybackDeployLib.build`i
    ///      cagirmak, olculmek istenen turetmeyi olcumun ICINE sokardi.
    function test_adresler_bagimsiz_turetmeyle_ayni() public view {
        BuybackPlan memory p = _plan();

        bytes memory vaultIc = abi.encodePacked(
            vm.parseJsonBytes(
                vm.readFile("out-frozen/BuybackVestingVault.sol/BuybackVestingVault.json"), ".bytecode.object"
            ),
            abi.encode(FACTORY)
        );
        address vault = _create2(keccak256("arcpad.BuybackVestingVault.v1"), vaultIc);
        assertEq(p.vault, vault, "kasa adresi bagimsiz turetmeden ayristi");

        bytes memory treasuryIc = abi.encodePacked(
            vm.parseJsonBytes(vm.readFile("out-frozen/BuybackTreasury.sol/BuybackTreasury.json"), ".bytecode.object"),
            abi.encode(FACTORY, ESCROW, vault, POOL_MANAGER)
        );
        assertEq(
            p.treasury,
            _create2(keccak256("arcpad.BuybackTreasury.v1"), treasuryIc),
            "hazine adresi bagimsiz turetmeden ayristi"
        );
    }

    /// @dev DUYARLILIK: sabit donduren bir mutant burada duser.
    function test_turetme_argumanlara_duyarlidir() public view {
        BuybackPlan memory a = _plan();
        BuybackPlan memory b = BuybackDeployLib.build(31337, address(0xFAC8), ESCROW, POOL_MANAGER);
        assertTrue(a.vault != b.vault, "farkli fabrika ayni kasayi uretti -- turetme bir SABIT");
        assertTrue(a.treasury != b.treasury, "farkli fabrika ayni hazineyi uretti");
    }

    function _create2(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), DeployLib.CREATE2_FACTORY, salt, keccak256(initcode))))
            )
        );
    }

    // ---------------------------------------------------------------
    // 2. ON KONTROL
    // ---------------------------------------------------------------

    function test_bozulmamis_plan_on_kontrolu_gecer() public view {
        BuybackDeployLib.assertDeployable(_plan());
    }

    function test_kodsuz_fabrika_reddedilir() public {
        BuybackPlan memory p = _plan();
        vm.etch(FACTORY, "");
        vm.expectRevert(abi.encodeWithSelector(BuybackDeployLib.FactoryHasNoCode.selector, FACTORY));
        this.callAssertDeployable(p);
    }

    function test_kodsuz_escrow_reddedilir() public {
        BuybackPlan memory p = _plan();
        vm.etch(ESCROW, "");
        vm.expectRevert(abi.encodeWithSelector(BuybackDeployLib.EscrowHasNoCode.selector, ESCROW));
        this.callAssertDeployable(p);
    }

    /// @dev `PoolManager` KODSUZ olsaydi hazinenin constructor'i GECERDI
    ///      (yalnizca sifira bakar) ve mezuniyet sonrasi HER supurme
    ///      `getSlot0`da duserdi. Bu satir onu yayin oncesine cekiyor.
    function test_kodsuz_poolManager_reddedilir() public {
        BuybackPlan memory p = _plan();
        vm.etch(POOL_MANAGER, "");
        vm.expectRevert(abi.encodeWithSelector(BuybackDeployLib.PoolManagerHasNoCode.selector, POOL_MANAGER));
        this.callAssertDeployable(p);
    }

    function test_dolu_adres_reddedilir() public {
        BuybackPlan memory p = _plan();
        vm.etch(p.treasury, PLACEHOLDER_RUNTIME);
        vm.expectRevert(
            abi.encodeWithSelector(BuybackDeployLib.AlreadyDeployed.selector, "BuybackTreasury", p.treasury)
        );
        this.callAssertDeployable(p);
    }

    /// @dev ARGUMAN SIRASI: dordu de `address`tir, yani bir takas
    ///      DERLEYICIDEN GECER. Bunu yakalayan tek satir initcode cozumudur.
    function test_initcode_plani_kodlar() public {
        BuybackPlan memory p = _plan();
        // Kuyrugun son 32 bayti `poolManager`dir; onu bozmak cozumu
        // ayristirmali.
        p.treasuryInitcode[p.treasuryInitcode.length - 1] = 0xFF;
        vm.expectRevert(abi.encodeWithSelector(BuybackDeployLib.InitcodeDoesNotEncodeThePlan.selector, "poolManager"));
        this.callAssertDeployable(p);
    }

    // ---------------------------------------------------------------
    // 3. GERI OKUMA
    // ---------------------------------------------------------------

    function test_geri_okuma_yayinlanan_kablolamayi_dogrular() public {
        BuybackPlan memory p = _plan();
        address vaultAddr = DeployLib.deploy(p.vaultSalt, p.vaultInitcode);
        address treasuryAddr = DeployLib.deploy(p.treasurySalt, p.treasuryInitcode);
        assertEq(vaultAddr, p.vault, "kasa plandan ayristi");
        assertEq(treasuryAddr, p.treasury, "hazine plandan ayristi");
        BuybackDeployLib.assertAsDeployed(p);
    }

    /**
     * GERI OKUMA SAPMIS BIR KABLOLAMAYI YAKALAR.
     *
     * @dev TANIK `escrow`DUR, `vault` DEGIL -- VE SEBEBI OLCULDU. `p.vault`i
     *      bozmak, `assertAsDeployed`in ILK satirini
     *      (`BuybackVestingVault(p.vault).factory()`) KODSUZ bir adrese
     *      cagirtir; solc'un extcodesize kontrolu CAGIRANIN ICINDE bos veriyle
     *      revert eder, yani beklenen `GovernanceNotAsDeployed` HIC olusmaz.
     *      Test "reverted as expected, but without data" ile duser ve olcmek
     *      istedigi kolu hic yurumez.
     *
     *      `escrow` boyle bir kontrata cagri YAPMAZ: hazineden okunur ve
     *      plandaki degerle karsilastirilir, dolayisiyla kol GERCEKTEN
     *      yurunur. `vault` kolunun pozitif tarafi
     *      `test_geri_okuma_yayinlanan_kablolamayi_dogrular` icinde durur.
     */
    function test_geri_okuma_sapmis_kablolamayi_yakalar() public {
        BuybackPlan memory p = _plan();
        DeployLib.deploy(p.vaultSalt, p.vaultInitcode);
        DeployLib.deploy(p.treasurySalt, p.treasuryInitcode);

        address real = p.escrow;
        p.escrow = address(0xBEEF);
        vm.expectRevert(
            abi.encodeWithSelector(DeployLib.GovernanceNotAsDeployed.selector, "treasury.escrow", address(0xBEEF), real)
        );
        this.callAssertAsDeployed(p);
    }

    function callAssertAsDeployed(BuybackPlan memory p) external view {
        BuybackDeployLib.assertAsDeployed(p);
    }
}
