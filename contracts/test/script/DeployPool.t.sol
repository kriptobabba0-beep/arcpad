// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {DeployLib} from "../../script/DeployLib.sol";
import {PoolDeployLib, PoolPlan} from "../../script/PoolDeployLib.sol";
import {ArcpadHook} from "../../src/ArcpadHook.sol";

/// @title DeployPoolTest
/// @notice Hook adresinin ve onu ureten tuzun PINI.
///
/// @dev NICIN BU DOSYA VAR. `ArcpadHook`un adresi bu depodaki en geri
///      donulemez sayidir: V4 izin kumesini adresin ALT 14 BITINDE kodlar
///      (`Hooks.ALL_HOOK_MASK`) ve o adres her `PoolKey`in bir ALANIDIR.
///      Ilk graduation'dan sonra ne hook degistirilebilir ne izinler. Bir
///      yoruma yazilmis "madenlenen tuz 13'tur" satirini kimse dogrulayamaz;
///      burada tuz DERLENEN bir sabittir ve adres ONDAN yeniden turetilir.
contract DeployPoolTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function setUp() public {
        // Kanonik deployer'in KODU degil KIMLIGI gerekiyor; `assertDeployable`
        // codehash'i kontrol eder. `Deploy.t.sol`daki ayni fixture.
        vm.etch(CREATE2_DEPLOYER, _canonicalCreate2DeployerRuntime());
    }

    function _arcPlan() internal view returns (PoolPlan memory) {
        return PoolDeployLib.build(
            PoolDeployLib.ARC_TESTNET_CHAIN_ID,
            PoolDeployLib.ARC_GOVERNOR,
            PoolDeployLib.ARC_FACTORY,
            PoolDeployLib.ARC_ESCROW
        );
    }

    /// TUZ PINLENIR VE ADRES ONDAN YENIDEN TURETILIR.
    ///
    /// @dev `HookMiner.find` tuzu ve adresi BIRLIKTE dondurur, yani onun
    ///      ciktisinin kendisiyle tutarli oldugunu iddia etmek TOTOLOJIDIR.
    ///      Burada adres `DeployLib.predict` ile -- kanonik deployer,
    ///      pinlenmis tuz, ve YAYINLANACAK initcode (arguman kuyrugu dahil)
    ///      ile -- bagimsiz olarak hesaplanir.
    function test_thePinnedSaltReproducesThePinnedHookAddress() public view {
        PoolPlan memory p = _arcPlan();

        assertEq(p.hookSalt, PoolDeployLib.ARC_HOOK_SALT, "madenlenen tuz pinden ayristi");
        assertEq(p.hook, PoolDeployLib.ARC_HOOK, "madenlenen hook adresi pinden ayristi");
        assertEq(
            DeployLib.predict(PoolDeployLib.ARC_HOOK_SALT, p.hookInitcode),
            PoolDeployLib.ARC_HOOK,
            "pinlenen tuz pinlenen adresi URETMIYOR"
        );
    }

    /// ...VE O ADRES IZIN KUMESINI TASIR. Bu, tuzun VAR OLMA SEBEBIDIR.
    function test_thePinnedHookAddressCarriesExactlyTheArcpadFlags() public pure {
        uint160 flags = uint160(PoolDeployLib.ARC_HOOK) & Hooks.ALL_HOOK_MASK;
        assertEq(uint256(flags), uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS), "alt 14 bit 0x20CC degil");

        // ...ve bit bit, bayraklarin KENDILERINDEN turetilerek. Literalin
        // dogru oldugunu literalle iddia etmek olcmezdi.
        assertEq(
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            uint256(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            ),
            "0x20CC bayraklarin toplamindan ayristi"
        );
    }

    /// UC ADRESIN UCU DE PINLENIR, cunku hook'unki digerlerine BAGLIDIR:
    /// `PoolManager` adresi hook'un constructor argumanidir, hook adresi de
    /// locker'inki. Biri kayarsa ucu birden kayar ve bunu tek bir pin
    /// gostermezdi.
    function test_theWholePoolLayerAddressSetIsPinned() public view {
        PoolPlan memory p = _arcPlan();
        assertEq(p.poolManager, PoolDeployLib.ARC_POOL_MANAGER, "PoolManager adresi kaydi");
        assertEq(p.hook, PoolDeployLib.ARC_HOOK, "ArcpadHook adresi kaydi");
        assertEq(p.locker, PoolDeployLib.ARC_LOCKER, "ArcpadLocker adresi kaydi");
    }

    /// BYTECODE PINI. Adres pini bunun SONUCUDUR; ayri durmasi teshis
    /// icindir -- "kod mu degisti yoksa bir arguman mi" sorusu, adres
    /// kaydiginda cevaplanabilir kalmalidir.
    function test_theHookCreationCodeIsPinned() public pure {
        assertEq(
            PoolDeployLib.hookCreationCodeHash(),
            PoolDeployLib.ARC_HOOK_CREATION_CODE_HASH,
            "ArcpadHook creation code kaydi -- hook ADRESI de kaymistir"
        );
        // ...ve bu birimde gorulen `type(...).creationCode` ile ayni sey.
        assertEq(
            keccak256(type(ArcpadHook).creationCode),
            PoolDeployLib.ARC_HOOK_CREATION_CODE_HASH,
            "bu birimin hook bytecode'u pinden ayristi"
        );
    }

    /// @dev `assertDeployable` BOS BIR AGACTA GECER -- pozitif kontrol.
    ///      Negatif kontrol tek basina anlamsizdir: her seye revert eden bir
    ///      kapi da onu saglar.
    function test_theArcPlanPassesThePreFlight() public view {
        PoolDeployLib.assertDeployable(_arcPlan());
    }

    /// NEGATIF KONTROL: adres ISGAL EDILMISSE deploy DURUR. Uc kontratin
    /// hicbiri yeniden kullanilabilir DEGILDIR -- hepsi Faz 2'de ILK KEZ
    /// iniyor, ve birinde kod bulmak "bu plan zaten yayinlanmis" demektir.
    function test_anOccupiedHookAddressStopsTheDeploy() public {
        PoolPlan memory p = _arcPlan();
        vm.etch(p.hook, hex"6001600155");
        vm.expectRevert(
            abi.encodeWithSelector(PoolDeployLib.PoolContractAlreadyDeployed.selector, "ArcpadHook", p.hook)
        );
        this.callAssertDeployable(p);
    }

    /// NEGATIF KONTROL: bayraksiz bir adres reddedilir -- ve reddi
    /// `BaseHook`in constructor'i DEGIL, on-kontrol yapar. Fark tasiyicidir:
    /// `BaseHook`in revert'i BROADCAST SIRASINDA, `PoolManager` ZATEN
    /// INDIKTEN sonra olurdu.
    function test_aHookAddressWithoutTheFlagsIsRefusedBeforeAnythingIsBroadcast() public {
        PoolPlan memory p = _arcPlan();
        p.hook = address(0x1234); // alt 14 bit = 0x1234 & 0x3FFF = 0x1234
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolDeployLib.HookAddressLacksTheArcpadFlags.selector,
                p.hook,
                uint160(p.hook) & Hooks.ALL_HOOK_MASK,
                PoolDeployLib.ARCPAD_HOOK_FLAGS
            )
        );
        this.callAssertDeployable(p);
    }

    /// NEGATIF KONTROL, VE BU GERCEK ARIZANIN SEKLIDIR: hook'un initcode'unu
    /// belirleyen HERHANGI bir sey degisirse arama BASKA bir tuz bulur, ve
    /// deploy Arc'ta DURUR.
    ///
    /// @dev Tanik olarak YANLIS BIR FACTORY adresi kullanilir. Uydurma bir
    ///      tuz atamak yerine bunun secilmesi kasitlidir: madencilik gercekten
    ///      yeniden kosar ve gercekten baska bir sonuc verir, yani test
    ///      "tuz sabiti degistirilirse ne olur"u degil "yayinlanacak baytlar
    ///      degisirse ne olur"u olcer -- ki kaybedilecek sey odur.
    ///      Bayrak ve yeniden-turetme kollari bu planda GECER, dolayisiyla
    ///      duran sey PIN kolunun kendisidir.
    function test_aDifferentWiringMinesADifferentSaltAndArcRefusesIt() public {
        PoolPlan memory wrong = PoolDeployLib.build(
            PoolDeployLib.ARC_TESTNET_CHAIN_ID,
            PoolDeployLib.ARC_GOVERNOR,
            address(0xBEEF), // YANLIS factory
            PoolDeployLib.ARC_ESCROW
        );

        assertTrue(wrong.hookSalt != PoolDeployLib.ARC_HOOK_SALT, "tanik ayni tuzu buldu -- test hicbir sey olcmuyor");
        assertEq(
            uint256(uint160(wrong.hook) & Hooks.ALL_HOOK_MASK),
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            "tanik bayrak kolunda duruyor -- pin kolu kosmadi"
        );
        assertEq(
            DeployLib.predict(wrong.hookSalt, wrong.hookInitcode),
            wrong.hook,
            "tanik yeniden-turetme kolunda duruyor -- pin kolu kosmadi"
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                PoolDeployLib.HookSaltIsNotThePinnedOne.selector, PoolDeployLib.ARC_HOOK_SALT, wrong.hookSalt
            )
        );
        this.callAssertDeployable(wrong);
    }

    function callAssertDeployable(PoolPlan memory p) external view {
        PoolDeployLib.assertDeployable(p);
    }

    /// @dev Kanonik CREATE2 deployer'in OLCULEN 69 baytlik runtime'i --
    ///      `Deploy.t.sol`daki literalin aynisi. Gereken sey uzunluk degil
    ///      KIMLIKTIR: `assertDeployable` codehash'e bakar, cunku 69 baytlik
    ///      HERHANGI bir kontrat gecmemelidir.
    function _canonicalCreate2DeployerRuntime() internal pure returns (bytes memory) {
        return hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0"
            hex"3601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    }
}
