// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {DeployLib} from "./DeployLib.sol";
import {PoolDeployLib, PoolPlan} from "./PoolDeployLib.sol";
import {Profiles} from "./Profiles.sol";

/// @title RedeployPoolLayer
/// @notice `ArcpadHook` ve `ArcpadLocker`i YENIDEN yayinlar; `PoolManager`i
///         OLDUGU GIBI birakir.
///
/// @dev NICIN AYRI BIR SCRIPT. `DeployPool` uc kontrati birlikte yayinlar ve
///      ucunun de BOS olmasini sart kosar (`PoolContractAlreadyDeployed`). O
///      koruma dogrudur ve GEVSETILMEMELIDIR: bir havuz katmanini yanlislikla
///      ikinci kez kurmak, ilk graduation'dan sonra iki farkli hook adresi
///      demektir ve `PoolKey` degistirilemez.
///
///      Ama bu kosuda `PoolManager` BILEREK yeniden kullanilir: hook ile
///      locker'in bytecode'u bir GUVENLIK DUZELTMESI yuzunden degisti, adresleri
///      onunla birlikte kaydi, `PoolManager`inki ise kaymadi ve kaymamali --
///      onun adresi bir `PoolKey` alani DEGILDIR ama sahibi governor Safe'tir
///      ve yeniden kurmak o sahipligi bosuna tazelerdi.
///
/// @dev BU KOSU YALNIZCA HICBIR SEY MEZUN OLMAMISKEN GUVENLIDIR. Hook adresi
///      her `PoolKey`in bir alanidir; bir havuz acildiktan SONRA hook'u
///      degistirmek, o havuzu arcpad'in korumalarindan kalici olarak koparir.
///      Bu yuzden asagidaki kontrol bir incelik degil bir KAPIDIR:
///      `graduationTarget == 0` ise hicbir curve mezun olamamis, dolayisiyla
///      hicbir havuz acilmamistir.
///
/// @dev DUZELTILEN ACIK (denetim 2026-08-13, PoC ile kanitlandi):
///      `ArcpadLocker.graduate(curve)` `curve` ile `token` arasindaki bagi
///      dogrulamiyordu. Gercek bir token bildiren sahte bir curve, kanonik
///      havuzu HICBIR ODEME YAPILMADAN toz likiditeyle aciyor; gercek
///      mezuniyet o andan sonra `PoolAlreadyInitialized` ile KALICI olarak
///      basarisiz oluyordu. Tamamlanmis bir curve'de satis da kapali oldugu
///      icin toplanan raise'in TAMAMI sonsuza kadar kilitleniyordu.
contract RedeployPoolLayer is Script {
    error PoolManagerMissing(address at);
    error PoolManagerOwnerChanged(address owner, address expected);
    error SomethingAlreadyGraduated(address target);
    error HookAlreadyDeployed(address at);
    error LockerAlreadyDeployed(address at);
    error AddressDivergedFromPlan(string what, address planned, address actual);
    error WiringWrong(string what);

    function plan() public view returns (PoolPlan memory p) {
        p = _resolve();
        _print(p, "DRY RUN -- hicbir sey yayinlanmadi");
    }

    function run() public returns (PoolPlan memory p) {
        p = _resolve();
        _print(p, "YAYINLANIYOR");

        vm.startBroadcast();
        // SIRA ZORUNLU: locker hook'u constructor argumani olarak alir.
        address hookAddr = DeployLib.deploy(p.hookSalt, p.hookInitcode);
        address lockerAddr = DeployLib.deploy(p.lockerSalt, p.lockerInitcode);
        vm.stopBroadcast();

        if (hookAddr != p.hook) revert AddressDivergedFromPlan("ArcpadHook", p.hook, hookAddr);
        if (lockerAddr != p.locker) revert AddressDivergedFromPlan("ArcpadLocker", p.locker, lockerAddr);

        _assertWiring(p);

        console2.log("");
        console2.log("YAYINLANDI.");
        console2.log("ArcpadHook   ", p.hook);
        console2.log("ArcpadLocker ", p.locker);
        console2.log("");
        console2.log("SIRADAKI ADIM, VE OTOMATIK DEGILDIR:");
        console2.log("  governor Safe -> proposeGraduationTarget(", p.locker, ")");
        console2.log("  3 gun sonra   -> applyGraduationTarget()   (izinsiz)");
        console2.log("BEKLEYEN ESKI ONERI INDIRILMEMELIDIR -- acikli locker'i silahlandirir.");
    }

    function _resolve() private view returns (PoolPlan memory p) {
        uint256 chainId = block.chainid;
        (address governor,) = Profiles.governanceForChain(chainId);
        p = PoolDeployLib.build(chainId, governor, PoolDeployLib.factoryFor(chainId), PoolDeployLib.escrowFor(chainId));

        // `PoolManager` DURUYOR OLMALI -- bu script onu kurmaz.
        if (p.poolManager.code.length == 0) revert PoolManagerMissing(p.poolManager);
        address owner = IOwned(p.poolManager).owner();
        if (owner != p.owner) revert PoolManagerOwnerChanged(owner, p.owner);

        /*
         * HICBIR SEY MEZUN OLMAMIS OLMALI. Bkz. sinifin basindaki not: hook
         * adresi `PoolKey`in bir alanidir, dolayisiyla bir havuz acildiktan
         * sonra hook'u degistirmek o havuzu korumalardan koparir. `graduationTarget`
         * hala sifirsa hicbir curve mezun olamamis demektir.
         */
        address target = IFactoryTarget(p.factory).graduationTarget();
        if (target != address(0)) revert SomethingAlreadyGraduated(target);

        // Ve YENI adresler bos olmali; eskiler dolu olabilir, o bizi ilgilendirmez.
        if (p.hook.code.length != 0) revert HookAlreadyDeployed(p.hook);
        if (p.locker.code.length != 0) revert LockerAlreadyDeployed(p.locker);
    }

    /// @dev ZINCIRDEN GERI OKUMA. Plan ne dediyse kontratlar onu SAKLAMIS
    ///      olmali; yerel bir degiskene bakan bir kontrol "dogru hesapladi,
    ///      baskasini gecirdi" mutantini GORMEZ.
    function _assertWiring(PoolPlan memory p) private view {
        if (IHookView(p.hook).factory() != p.factory) revert WiringWrong("hook.factory");
        if (IHookView(p.hook).escrow() != p.escrow) revert WiringWrong("hook.escrow");
        if (address(IHookView(p.hook).poolManager()) != p.poolManager) revert WiringWrong("hook.poolManager");
        if (ILockerView(p.locker).factory() != p.factory) revert WiringWrong("locker.factory");
        if (address(ILockerView(p.locker).hook()) != p.hook) revert WiringWrong("locker.hook");
        if (address(ILockerView(p.locker).poolManager()) != p.poolManager) revert WiringWrong("locker.poolManager");
    }

    function _print(PoolPlan memory p, string memory banner) private pure {
        console2.log("=== arcpad havuz katmani YENIDEN yayin ===");
        console2.log(banner);
        console2.log("chainId              ", p.chainId);
        console2.log("owner (governor Safe)", p.owner);
        console2.log("factory              ", p.factory);
        console2.log("escrow               ", p.escrow);
        console2.log("PoolManager (MEVCUT) ", p.poolManager);
        console2.log("ArcpadHook   YENI    ", p.hook);
        console2.log("  hook salt (MINED)  ", vm.toString(p.hookSalt));
        console2.log("  hook flags low 14b ", uint256(uint160(p.hook) & 0x3FFF));
        console2.log("ArcpadLocker YENI    ", p.locker);
    }
}

interface IOwned {
    function owner() external view returns (address);
}

interface IFactoryTarget {
    function graduationTarget() external view returns (address);
}

interface IHookView {
    function factory() external view returns (address);
    function escrow() external view returns (address);
    function poolManager() external view returns (address);
}

interface ILockerView {
    function factory() external view returns (address);
    function hook() external view returns (address);
    function poolManager() external view returns (address);
}
