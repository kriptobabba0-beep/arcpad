// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {ArcpadRouter} from "../src/ArcpadRouter.sol";
import {DeployLib} from "./DeployLib.sol";
import {PoolDeployLib} from "./PoolDeployLib.sol";

struct RouterPlan {
    uint256 chainId;
    address poolManager;
    address hook;
    bytes32 salt;
    bytes initcode;
    address router;
}

/// @title RouterDeployLib
/// @notice Faz 2'nin DORDUNCU kontrati: `ArcpadRouter`.
///
/// @dev BU BIRIM `PoolDeployLib`I IMPORT EDER VE BU BIR DERLEME BIRIMI
///      KARARIDIR, KOLAYLIK DEGIL. `PoolDeployLib` `PoolManager`i ISMIYLE
///      import eder; `foundry.toml`un kisiti o dosyayi
///      `optimizer_runs = 44444444`e zorlar; ve bir solc girdisinin TEK
///      optimizer ayari vardir. Yani bu birimdeki `ArcpadRouter` de
///      44444444'te derlenir -- ve `ArcpadRouter.t.sol` da `PoolManager`i
///      ismiyle import ettigi icin PAKETIN SINADIGI BYTECODE tam olarak
///      budur. Bu satiri kaldirmak (ornegin adresleri elle yazmak) router'i
///      800'de derletir ve YAYINLANAN baytlar ile TEST EDILEN baytlar
///      SESSIZCE ayrisirdi -- `PoolDeployLib`in `ArcpadHook` icin olctugu
///      ayrismanin (sha256 `af0e74eb...` vs `6bdcd07c...`) aynisi.
///
/// @dev ROUTER'IN ADRESI KRITIK DEGILDIR VE BU, YIGINDA BENZERSIZDIR.
///      `ArcpadHook`un adresi izin kumesini kodlar ve her `PoolKey`in
///      alanidir; `ArcpadLocker`in adresi factory'nin `graduationTarget`idir.
///      Router'i ise HICBIR ZINCIR USTU YAPI REFERANS ETMEZ -- havuz onu
///      tanimaz, hook onu tanimaz, factory onu tanimaz. Dolayisiyla:
///        - madencilik YOKTUR (bayrak gereksinimi yok),
///        - `AlreadyDeployed` KIRMIZI bir kapidir ama caresi UCUZDUR (tuzu
///          `v2`ye almak),
///        - ve burada bulunacak bir kusurun caresi YENI BIR ROUTER'dir.
///      Tuz yine de TURETILIR, SECILMEZ -- `DeployLib`in kuralinin aynisi.
library RouterDeployLib {
    bytes32 internal constant ROUTER_SALT = keccak256("arcpad.ArcpadRouter.v1");

    /// @notice Bu derleme biriminin gordugu `ArcpadRouter` creation code'unun
    ///         hash'i -- ARGUMANSIZ.
    /// @dev AYRI BIR PIN OLMASI TASIYICIDIR, `PoolDeployLib`in
    ///      `ARC_HOOK_CREATION_CODE_HASH` gerekcesiyle ayni: `routerInitcode`
    ///      argumanlari da icerir, yani onun hash'i `PoolManager` ya da hook
    ///      adresi degistiginde de kayar; bu ise YALNIZCA BYTECODE kaydiginda
    ///      kayar. `ArcpadRouter.t.sol` -- BASKA BIR DERLEME BIRIMI -- ayni
    ///      degeri iddia eder, yani iki birim ayrisirsa biri kirmizi olur.
    bytes32 internal constant ARC_ROUTER_CREATION_CODE_HASH =
        0x1076f0b7e1519c4428eccbe365422cbc0be0a26a8c95baa4f7969bd4ee9f81f6;

    error PoolManagerHasNoCode(address poolManager);
    error HookHasNoCode(address hook);
    error PoolManagerIsNotTheDeployedOne(address expected, address given);
    error HookIsNotTheDeployedOne(address expected, address given);
    error RouterCreationCodeMoved(bytes32 expected, bytes32 actual);
    error RouterAlreadyDeployed(address at);
    error RouterNotAsDeployed(string field, address expected, address actual);

    function routerCreationCodeHash() internal pure returns (bytes32) {
        return keccak256(type(ArcpadRouter).creationCode);
    }

    function routerInitcode(address poolManager_, address hook_) internal pure returns (bytes memory) {
        return abi.encodePacked(type(ArcpadRouter).creationCode, abi.encode(IPoolManager(poolManager_), IHooks(hook_)));
    }

    function build(uint256 chainId, address poolManager_, address hook_) internal pure returns (RouterPlan memory p) {
        p.chainId = chainId;
        p.poolManager = poolManager_;
        p.hook = hook_;
        p.salt = ROUTER_SALT;
        p.initcode = routerInitcode(poolManager_, hook_);
        p.router = DeployLib.predict(ROUTER_SALT, p.initcode);
    }

    /// @notice Yayinlanmadan once dogru olmasi gereken her sey.
    ///
    /// @dev SIRA TASIYICIDIR VE `PoolDeployLib.assertDeployable`IN AYNISIDIR:
    ///      once BAGLANILAN adresler, sonra router'in kendisi. Router'in iki
    ///      constructor argumani da `immutable`dir, yani yanlis bir
    ///      `PoolManager` ya da yanlis bir hook DUZELTILEMEZ -- yalnizca
    ///      yeniden yayinlanabilir. Ikisi de ZINCIRDE olmali: kodsuz bir hook
    ///      adresi `GraduationMath.poolKey`in urettigi her anahtari SESSIZCE
    ///      var olmayan bir havuza cevirirdi ve router her cagrida
    ///      `PoolNotInitialized` ile duserdi.
    function assertDeployable(RouterPlan memory p) internal view {
        if (DeployLib.CREATE2_FACTORY.codehash != DeployLib.CREATE2_FACTORY_CODEHASH) {
            revert DeployLib.Create2DeployerNotCanonical(
                DeployLib.CREATE2_FACTORY, DeployLib.CREATE2_FACTORY_CODEHASH, DeployLib.CREATE2_FACTORY.codehash
            );
        }

        // ARC'TA IKI ADRES DE PINLIDIR. Router bir EOA'nin elinden gecen
        // parayi tasidigi icin "hangi hook" sorusu bir yazim hatasina
        // birakilamaz: yanlis bir hook, arcpad'in havuzlarina AIT OLMAYAN bir
        // anahtar uretir.
        if (p.chainId == PoolDeployLib.ARC_TESTNET_CHAIN_ID) {
            if (p.poolManager != PoolDeployLib.ARC_POOL_MANAGER) {
                revert PoolManagerIsNotTheDeployedOne(PoolDeployLib.ARC_POOL_MANAGER, p.poolManager);
            }
            if (p.hook != PoolDeployLib.ARC_HOOK) {
                revert HookIsNotTheDeployedOne(PoolDeployLib.ARC_HOOK, p.hook);
            }
        }

        if (p.poolManager.code.length == 0) revert PoolManagerHasNoCode(p.poolManager);
        if (p.hook.code.length == 0) revert HookHasNoCode(p.hook);

        bytes32 got = routerCreationCodeHash();
        if (got != ARC_ROUTER_CREATION_CODE_HASH) {
            revert RouterCreationCodeMoved(ARC_ROUTER_CREATION_CODE_HASH, got);
        }

        if (p.router.code.length != 0) revert RouterAlreadyDeployed(p.router);
    }

    /// @notice Yayinlandiktan SONRA, ZINCIRDEN geri okuma.
    /// @dev `assertDeployable`in yerine gecmez, IKIZIDIR: plan neyi
    ///      soyluyordu ile kontrat neyi sakladi ancak boyle ayrisamaz.
    ///      `PoolDeployLib.assertAsDeployed`in gerekcesiyle ayni, ve `--resume`
    ///      yolunda `run()`in kosmadigi olculdugu icin zincirden bagimsiz
    ///      okumak opsiyonel degildir.
    function assertAsDeployed(RouterPlan memory p) internal view {
        ArcpadRouter r = ArcpadRouter(p.router);
        if (address(r.poolManager()) != p.poolManager) {
            revert RouterNotAsDeployed("router.poolManager", p.poolManager, address(r.poolManager()));
        }
        if (address(r.hook()) != p.hook) {
            revert RouterNotAsDeployed("router.hook", p.hook, address(r.hook()));
        }
    }
}
