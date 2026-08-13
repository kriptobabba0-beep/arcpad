// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {ArcpadHook} from "../src/ArcpadHook.sol";
import {ArcpadLocker} from "../src/ArcpadLocker.sol";
import {DeployLib} from "./DeployLib.sol";

struct PoolPlan {
    uint256 chainId;
    address owner; // `PoolManager`in sahibi -- governor Safe
    address factory; // Faz 2 `LaunchFactory`si
    address escrow; // CANLI `FeeEscrow`
    bytes32 poolManagerSalt;
    bytes poolManagerInitcode;
    address poolManager;
    bytes32 hookSalt;
    bytes hookInitcode;
    address hook;
    bytes32 lockerSalt;
    bytes lockerInitcode;
    address locker;
}

/// @title PoolDeployLib
/// @notice Faz 2'nin UC KALICI KONTRATI: `PoolManager`, `ArcpadHook`,
///         `ArcpadLocker`.
///
/// @dev HOOK ADRESI BU DEPODAKI EN GERI DONULEMEZ SAYIDIR ve sebebi V4'un
///      tasarimidir: izin kumesi hook'un ADRESININ ALT 14 BITINDE kodlanir
///      (`Hooks.ALL_HOOK_MASK`), ve o adres her `PoolKey`in bir ALANIDIR.
///      Yani adres tutulan izinleri, izinler adresi belirler; ilk
///      graduation'dan sonra ikisi de degistirilemez. Bir tuz aramasi bu
///      yuzden opsiyonel DEGILDIR, ve sonucu bir yorumda degil DERLENEN bir
///      sabitte durmalidir -- yorumdaki bir sayiyi kimse dogrulayamaz.
///
/// @dev BU BIRIM `PoolManager`I ISMIYLE IMPORT EDER VE BU BILINCLIDIR.
///      `foundry.toml`un kisiti `lib/v4-core/src/PoolManager.sol`u
///      `optimizer_runs = 44444444`e zorlar (800'de Yul'da "memPtr_1 is 1 too
///      deep in the stack" ile duser), ve bir solc girdisinin TEK optimizer
///      ayari oldugu icin bu birimdeki `ArcpadHook` de 44444444'te derlenir.
///      OLCULDU: `out/ArcpadHook.sol/ArcpadHook.json` (800) ve
///      `ArcpadHook.v4core.json` (44444444) FARKLI initcode'lardir --
///      sha256(inspect) `af0e74eb...` ve `6bdcd07c...`.
///
///      SECIM ACIKTIR: 44444444 YAYINLANIR, cunku `ArcpadHook.t.sol`,
///      `ArcpadLocker.t.sol` ve `PoolSeedInvariants.t.sol` da `PoolManager`i
///      ismiyle import eder, yani PAKETIN SINADIGI BYTECODE ODUR. 800'u
///      yayinlamak, hicbir testin kosmadigi baytlari KALICI bir adrese
///      yazmak olurdu. Iki tarafi da hareket ettiren sey ayni kisittir,
///      dolayisiyla birlikte hareket ederler -- ve `ARC_HOOK_CREATION_CODE_HASH`
///      hareketi yakalar.
library PoolDeployLib {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice arcpad'in izin kumesi: `beforeInitialize` + `beforeSwap` +
    ///         `afterSwap` + iki delta bayragi.
    /// @dev `0x2000 | 0x80 | 0x40 | 0x8 | 0x4`. `V4Wiring.t.sol` bu sayiyi
    ///      bayraklarin KENDILERINDEN turetir; burada literal durmasi
    ///      kasitlidir, iki taraf birbirini olcsun diye.
    uint160 internal constant ARCPAD_HOOK_FLAGS = 0x20CC;

    /// @dev Tuzlar SECILMEZ, TURETILIR -- `DeployLib`in kuralinin aynisi.
    ///      HOOK bunun ISTISNASIDIR ve olamazdi: onun tuzu bir ARAMA
    ///      sonucudur.
    bytes32 internal constant POOL_MANAGER_SALT = keccak256("arcpad.PoolManager.v1");
    bytes32 internal constant LOCKER_SALT = keccak256("arcpad.ArcpadLocker.v1");

    error FactoryIsNotTheDerivedOne(address derived, address given);
    error EscrowIsNotTheDerivedOne(address derived, address given);
    error FactoryHasNoCode(address factory);
    error EscrowHasNoCode(address escrow);
    error HookAddressLacksTheArcpadFlags(address hook, uint160 got, uint160 want);
    error HookSaltDoesNotReproduceTheAddress(bytes32 salt, address expected, address actual);
    error HookSaltIsNotThePinnedOne(bytes32 pinned, bytes32 mined);
    error PoolContractAlreadyDeployed(string what, address at);
    error PoolManagerOwnerIsNotTheGovernor(address owner);

    // ---------------------------------------------------------------
    // ARC TESTNET PINLERI
    // ---------------------------------------------------------------
    //
    // BU DORT SAYI DERLENEN KODDA DURUR, BIR YORUMDA DEGIL, ve tamami
    // `test/script/DeployPool.t.sol` tarafindan YENIDEN TURETILIR. Madencilik
    // her kosuda yeniden yapilir; pin, arama sonucunun INCELENMIS sonuc
    // oldugunu iddia eder. Bytecode kayarsa (kaynak degisikligi, solc
    // yukseltmesi, ya da `compilation_restrictions` globunun degismesi)
    // dordu birden kirmizi olur -- ve olmasi gerekir, cunku o an adres
    // degismis demektir.

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    address internal constant ARC_GOVERNOR = 0x970534698e4592932F31892759147f79EB0D2C22;
    address internal constant ARC_ESCROW = 0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6;
    /// @notice Faz 2 `LaunchFactory`si. **PIN, KAYNAK DEGIL.**
    ///
    /// @dev BU SABIT BIR ZAMANLAR TEK BASINA TASIYICIYDI VE O EN TEHLIKELI
    ///      HALIYDI. Hicbir sey onu `DeployLib.build().factory` ile
    ///      baglamiyordu, hicbir sey o adreste KOD olmasini istemiyordu, ve
    ///      `LaunchFactory` dondurulmus literal kumesinden MUAFTI. Olculdu:
    ///      `LaunchFactory`nin constructor'indaki dort atamanin sirasini
    ///      degistirmek -- ANLAMBILIMSEL OLARAK HICBIR SEY DEGISTIRMEZ --
    ///      kapiyi YESIL ve paketi 607/607 birakiyor, fabrikayi
    ///      `0x5CA156f1...` -> `0x2F0C56DB...` kaydiriyor, ve hook'un tuzu ile
    ///      adresi HIC KIMILDAMIYORDU. Yani hook KODSUZ bir fabrikaya kalici
    ///      olarak baglanirdi: `_beforeInitialize` her cagrida revert eder,
    ///      hicbir havuz acilamaz, ve hook adresi her `PoolKey`de yayinlandigi
    ///      icin yeniden madenlenemez.
    ///
    /// @dev UC KAPI BIRDEN KONDU, cunku hicbiri tek basina yetmiyor:
    ///        (1) `factoryFor(chainId)` adresi `DeployLib`in TURETTIGI YERDEN
    ///            turetir -- ayni profil, ayni governance, ayni salt. Asagidaki
    ///            sabit artik o turetmenin PINIDIR ve `DeployPool.t.sol` ikisini
    ///            esitler.
    ///        (2) `assertDeployable` o adreste KOD olmasini ister. Bir literal
    ///            "dogru gorunebilir" ama kodsuz bir adres YAYINLANAMAZ.
    ///        (3) `LaunchFactory` artik `frozen_bytecode_gate.py`nin FROZEN
    ///            kumesinde -- muafiyet, saldirinin ULASILABILIR olmasinin
    ///            sebebiydi.
    address internal constant ARC_FACTORY = 0x5CA156f1809aB784655410d0f4B0704d2b306B47;

    /// @notice Kaynaktan degil, ARAMA SONUCUNDAN gelen tek sabit.
    /// @dev `forge script PredictPool` ile madenlendi. Alt 14 bit icin gecerli
    ///      adres yogunlugu 1/16.384'tur, yani tuzun buyuklugu hicbir sey ifade
    ///      etmez.
    ///
    /// @dev YENIDEN MADENLENDI (2026-08-13 denetimi). Onceki uclu
    ///      (salt 13, hook `0xd951…e0cC`, locker `0x0e77…98E8`) ARTIK
    ///      GECERSIZDIR: denetim hem hook'a hem locker'a birer koruma ekledi,
    ///      bytecode degisti, ve V4'te hook'un IZINLERI ADRESIN ALT 14 BITINDE
    ///      yasadigi icin eski tuz artik `0x20CC` ile biten bir adres uretmez.
    ///      Yani duzeltme, adresleri de zorunlu olarak hareket ettirdi.
    ///
    ///      ESKI LOCKER TESTNET'TE DEPLOY EDILMIS DURUMDA ve factory'de
    ///      BEKLEYEN bir oneriydi (`0x0e77…98E8`, pencere 15-18 Agustos).
    ///      O ONERI INDIRILMEMELIDIR -- indirilirse acikli locker silahlanir.
    ///      Yerine bu dosyadaki YENI locker onerilir; oneri uzerine yazmak
    ///      mumkundur ve sureyi bastan baslatir.
    ///
    ///      HICBIR SEY MEZUN OLMADIGI ICIN (graduationTarget hala sifir,
    ///      olculdu) adres degisiminin bir bedeli yoktur: eski hook'un adresi
    ///      hicbir `PoolKey`e girmemistir.
    bytes32 internal constant ARC_HOOK_SALT = bytes32(uint256(0x1273));
    address internal constant ARC_HOOK = 0x89AfefCbD64c9Ae84e74698C96Dcba087c40e0cc;
    address internal constant ARC_POOL_MANAGER = 0x617321A877e024C870516CD599A581dCDCa6c09b;
    address internal constant ARC_LOCKER = 0xaEE2DA2D21B92AfCAccF9DAD3d72254eE1630158;

    /// @notice `ArcpadHook` creation code'unun hash'i, ARGUMANSIZ.
    /// @dev BU PIN, YAYINLANAN BYTECODE ILE SINANAN BYTECODE'UN AYNI
    ///      OLDUGUNU SOYLEYEN SATIRDIR. `ArcpadHook.t.sol` da onu iddia eder
    ///      (`test_theTestedHookBytecodeIsTheOneTheDeployWouldShip`), ve o
    ///      test BASKA BIR DERLEME BIRIMINDEDIR -- yani iki birim ayrisirsa
    ///      biri kirmizi olur. Ayrisma teorik degil: `out/`ta `ArcpadHook`in
    ///      IKI artifact'i vardir (`ArcpadHook.json` 800 ve
    ///      `ArcpadHook.v4core.json` 44444444) ve initcode'lari FARKLIDIR.
    bytes32 internal constant ARC_HOOK_CREATION_CODE_HASH =
        0x73025527d44fa3eee512ba9f5f6d44bb446ca2ef5e0c1138e638015ea8793c43;

    function predict(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return DeployLib.predict(salt, initcode);
    }

    /// @notice Bu zincirin `LaunchFactory` ve `FeeEscrow` adresleri, `Deploy`in
    ///         KULLANDIGI YERDEN turetilmis.
    ///
    /// @dev TEK KAYNAK, VE `type(...).creationCode` DEGIL. Bu birim
    ///      `PoolManager`i ismiyle import ettigi icin `optimizer_runs =
    ///      44444444`tur; `Deploy.s.sol` ise 800'dur. Ikisi
    ///      `type(LaunchFactory).creationCode`u FARKLI gorur, dolayisiyla
    ///      burada `DeployLib.build` cagirmak FARKLI bir fabrika adresi
    ///      uretirdi -- ve o adres hook'un constructor argumani olarak KALICI
    ///      olarak gomulurdu. `DeployLib.frozenFactoryAddress` bunun yerine
    ///      `out-frozen/`dan okur: YAYINLANACAK baytlar, birimden bagimsiz.
    function factoryFor(uint256 chainId) internal view returns (address) {
        return DeployLib.frozenFactoryAddress(chainId);
    }

    function escrowFor(uint256) internal view returns (address) {
        return DeployLib.frozenEscrowAddress();
    }

    /// @notice Bu derleme biriminin gordugu `ArcpadHook` creation code'unun
    ///         hash'i -- ARGUMANSIZ.
    /// @dev AYRI BIR PIN OLMASI TASIYICIDIR. `hookInitcode` argumanlari da
    ///      icerir, yani onun hash'i factory ya da escrow adresi degistiginde
    ///      de kayar; bu ise YALNIZCA BYTECODE kaydiginda kayar. Ikisini tek
    ///      pine toplamak, "kod mu degisti yoksa argumanlar mi" sorusunu tam
    ///      da en pahali anda kaybettirirdi.
    function hookCreationCodeHash() internal pure returns (bytes32) {
        return keccak256(type(ArcpadHook).creationCode);
    }

    function poolManagerInitcode(address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(type(PoolManager).creationCode, abi.encode(owner));
    }

    function hookInitcode(address poolManager_, address factory_, address escrow_)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(ArcpadHook).creationCode, abi.encode(IPoolManager(poolManager_), factory_, escrow_)
        );
    }

    function lockerInitcode(address poolManager_, address factory_, address hook_)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(ArcpadLocker).creationCode, abi.encode(IPoolManager(poolManager_), factory_, IHooks(hook_))
        );
    }

    /// @notice Uc adresi de TURETIR. Zincire dokunmaz.
    ///
    /// @dev SIRA ZORUNLUDUR VE TEK YONLUDUR: hook'un constructor'i
    ///      `poolManager`i alir, locker'in constructor'i hook'u alir.
    ///      Dolayisiyla `PoolManager` adresi once sabitlenmeli, sonra hook
    ///      madenlenmeli, sonra locker turetilmelidir. Ters sirada bir
    ///      "once locker" yaklasimi CEVRIMSEL olurdu.
    function build(uint256 chainId, address owner, address factory_, address escrow_)
        internal
        view
        returns (PoolPlan memory p)
    {
        p.chainId = chainId;
        p.owner = owner;
        p.factory = factory_;
        p.escrow = escrow_;

        p.poolManagerSalt = POOL_MANAGER_SALT;
        p.poolManagerInitcode = poolManagerInitcode(owner);
        p.poolManager = predict(POOL_MANAGER_SALT, p.poolManagerInitcode);

        // MADENCILIK KANONIK DEPLOYER'A KARSI YAPILIR. `forge test` icinde
        // `new C{salt:}` cagiran KONTRATTA calisir; `forge script --broadcast`
        // deterministik deployer uzerinden gonderir. Iki farkli adres. Arama
        // yayinlanacak olanina gore yapilmali, aksi halde madenlenen adres
        // canli kosuda HIC uretilmez.
        (address minedHook, bytes32 minedSalt) = HookMiner.find(
            DeployLib.CREATE2_FACTORY,
            ARCPAD_HOOK_FLAGS,
            type(ArcpadHook).creationCode,
            abi.encode(IPoolManager(p.poolManager), factory_, escrow_)
        );
        p.hookSalt = minedSalt;
        p.hookInitcode = hookInitcode(p.poolManager, factory_, escrow_);
        p.hook = minedHook;

        p.lockerSalt = LOCKER_SALT;
        p.lockerInitcode = lockerInitcode(p.poolManager, factory_, p.hook);
        p.locker = predict(LOCKER_SALT, p.lockerInitcode);
    }

    /// @notice Yayinlanmadan once dogru olmasi gereken her sey.
    ///
    /// @dev BAYRAK KONTROLU `BaseHook`IN CONSTRUCTOR'INI TEKRAR ETMEZ, ONDAN
    ///      ONCE GELIR. `BaseHook.validateHookAddress` yanlis adreste revert
    ///      eder -- ama o revert BROADCAST SIRASINDA, gaz harcandiktan ve
    ///      `PoolManager` ZATEN INDIKTEN sonra olurdu. Burada duran kontrol
    ///      hicbir sey yayinlanmadan once duser.
    function assertDeployable(PoolPlan memory p) internal view {
        if (DeployLib.CREATE2_FACTORY.codehash != DeployLib.CREATE2_FACTORY_CODEHASH) {
            revert DeployLib.Create2DeployerNotCanonical(
                DeployLib.CREATE2_FACTORY, DeployLib.CREATE2_FACTORY_CODEHASH, DeployLib.CREATE2_FACTORY.codehash
            );
        }

        // ---- ONCE BAGLANILAN ADRESLER, SONRA HOOK'UN KENDISI ----
        // SIRA TASIYICIDIR: hook'un tuzu bu iki adresten TURETILIR, yani
        // onlar yanlissa hook adresi de yanlistir ve bayrak kontrolu YINE DE
        // gecerdi (olculdu: yanlis bir fabrikayla madenlenen adres de 0x20CC
        // tasir). Bayraga once bakan bir sira, en pahali hatayi en son
        // gorurdu.
        address derivedFactory = factoryFor(p.chainId);
        if (p.factory != derivedFactory) revert FactoryIsNotTheDerivedOne(derivedFactory, p.factory);
        address derivedEscrow = escrowFor(p.chainId);
        if (p.escrow != derivedEscrow) revert EscrowIsNotTheDerivedOne(derivedEscrow, p.escrow);

        // ...VE IKISI DE ZINCIRDE OLMALI. Turetme "adres dogru" der, kod
        // varligi "kontrat ORADA" der, ve hook'un ihtiyaci ikincisidir:
        // `_beforeInitialize` her cagrida `factory`ye STATICCALL yapar ve
        // kodsuz bir adres `graduationTarget()`i bos dondurup revert ettirir --
        // sonsuza kadar, cunku hook adresi `PoolKey`in alanidir.
        if (p.factory.code.length == 0) revert FactoryHasNoCode(p.factory);
        if (p.escrow.code.length == 0) revert EscrowHasNoCode(p.escrow);

        uint160 got = uint160(p.hook) & Hooks.ALL_HOOK_MASK;
        if (got != ARCPAD_HOOK_FLAGS) revert HookAddressLacksTheArcpadFlags(p.hook, got, ARCPAD_HOOK_FLAGS);

        // TUZ ADRESI YENIDEN URETIR. `HookMiner` ikisini birlikte dondurur,
        // yani onun ciktisina guvenmek bir TOTOLOJI olurdu; bu satir
        // `predict`i BAGIMSIZ olarak yurutur ve yayinlanacak initcode'u
        // (arguman kuyrugu dahil) kullanir.
        address rederived = predict(p.hookSalt, p.hookInitcode);
        if (rederived != p.hook) revert HookSaltDoesNotReproduceTheAddress(p.hookSalt, p.hook, rederived);

        // ARC'TA MADENLENEN TUZ, INCELENMIS TUZ OLMAK ZORUNDADIR.
        // Madencilik her kosuda yeniden yapilir; bu satir aramanin SONUCUNUN
        // incelenmis sonuc oldugunu iddia eder. Bytecode kaydiginda arama
        // baska bir tuz bulur ve deploy BURADA duser -- ki tam olarak
        // durmasi gereken yer orasidir, cunku hook adresi degismis demektir.
        if (p.chainId == ARC_TESTNET_CHAIN_ID) {
            if (p.hookSalt != ARC_HOOK_SALT) revert HookSaltIsNotThePinnedOne(ARC_HOOK_SALT, p.hookSalt);
            if (p.hook != ARC_HOOK) {
                revert HookSaltDoesNotReproduceTheAddress(p.hookSalt, ARC_HOOK, p.hook);
            }
        }

        if (p.poolManager.code.length != 0) revert PoolContractAlreadyDeployed("PoolManager", p.poolManager);
        if (p.hook.code.length != 0) revert PoolContractAlreadyDeployed("ArcpadHook", p.hook);
        if (p.locker.code.length != 0) revert PoolContractAlreadyDeployed("ArcpadLocker", p.locker);
    }

    /// @notice Yayinlandiktan SONRA, ZINCIRDEN geri okuma.
    /// @dev `_assertInitcodeEncodesThePlan`in yerine gecmez; onun ikizidir.
    ///      Bu uc kontratin hepsi constructor argumanlarini `immutable`
    ///      olarak saklar, yani zincirdeki degeri SORMAK mumkundur -- ve
    ///      "plan neyi soyluyordu" ile "kontrat neyi sakladi" ancak boyle
    ///      ayrisamaz.
    function assertAsDeployed(PoolPlan memory p) internal view {
        ArcpadHook h = ArcpadHook(p.hook);
        if (address(h.poolManager()) != p.poolManager) {
            revert DeployLib.GovernanceNotAsDeployed("hook.poolManager", p.poolManager, address(h.poolManager()));
        }
        if (h.factory() != p.factory) {
            revert DeployLib.GovernanceNotAsDeployed("hook.factory", p.factory, h.factory());
        }
        if (h.escrow() != p.escrow) {
            revert DeployLib.GovernanceNotAsDeployed("hook.escrow", p.escrow, h.escrow());
        }

        ArcpadLocker l = ArcpadLocker(payable(p.locker));
        if (address(l.poolManager()) != p.poolManager) {
            revert DeployLib.GovernanceNotAsDeployed("locker.poolManager", p.poolManager, address(l.poolManager()));
        }
        if (l.factory() != p.factory) {
            revert DeployLib.GovernanceNotAsDeployed("locker.factory", p.factory, l.factory());
        }
        if (address(l.hook()) != p.hook) {
            revert DeployLib.GovernanceNotAsDeployed("locker.hook", p.hook, address(l.hook()));
        }

        // `PoolManager`in sahibi GOVERNOR SAFE'I olmali. Sahiplik protokol
        // ucreti oranini belirler (`setProtocolFeeController`), yani bir EOA'da
        // birakmak Faz 2'nin tum havuzlarini o anahtara baglardi.
        if (PoolManager(p.poolManager).owner() != p.owner) {
            revert PoolManagerOwnerIsNotTheGovernor(PoolManager(p.poolManager).owner());
        }
    }
}
