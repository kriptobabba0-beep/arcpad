// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DeployLib} from "./DeployLib.sol";
import {PoolDeployLib, PoolPlan} from "./PoolDeployLib.sol";
import {Profiles} from "./Profiles.sol";

/// @title DeployPool
/// @notice Faz 2'nin havuz katmani: `PoolManager`, `ArcpadHook`,
///         `ArcpadLocker`. `Deploy`in ikizi -- `plan()` KURU KOSU, `run()`
///         GERCEK, ikisi de AYNI `_resolve()`den gecer.
///
/// @dev BU SCRIPT `Deploy`DAN SONRA KOSAR VE SIRA ZORUNLUDUR: hook ile
///      locker'in constructor'lari `LaunchFactory` adresini alir, yani
///      factory zincirde OLMADAN bu katman turetilmez. Ters sira
///      `LaunchFactory`nin `feeSchedule` argumanini kaldirmadan mumkun
///      degildir ve olmamalidir.
///
/// @dev GRADUATION HEDEFI BURADA AYARLANMAZ. `applyGraduationTarget` uc gun
///      gecikmelidir ve R-12 acikca soyler: bir locker'a ancak o locker'a
///      KARSI tam bir launch -> satis -> graduate dongusu Arc testnet'te
///      FIILEN kosturuldiktan sonra isaret edilebilir. Bu script locker'i
///      YAYINLAR; isaret etmek AYRI ve INCELENMIS bir adimdir (Task 8).
contract DeployPool is Script {
    function plan() public view returns (PoolPlan memory p) {
        p = _resolve();
        _print(p, "DRY RUN -- nothing was broadcast");
    }

    function run() public returns (PoolPlan memory p) {
        p = _resolve();
        _print(p, "BROADCASTING");

        vm.startBroadcast();
        // SIRA ZORUNLUDUR VE TEK YONLUDUR: hook `poolManager`i, locker hook'u
        // constructor argumani olarak alir.
        address pmAddr = DeployLib.deploy(p.poolManagerSalt, p.poolManagerInitcode);
        address hookAddr = DeployLib.deploy(p.hookSalt, p.hookInitcode);
        address lockerAddr = DeployLib.deploy(p.lockerSalt, p.lockerInitcode);
        vm.stopBroadcast();

        require(pmAddr == p.poolManager, "poolManager address diverged from the plan");
        require(hookAddr == p.hook, "hook address diverged from the plan");
        require(lockerAddr == p.locker, "locker address diverged from the plan");

        PoolDeployLib.assertAsDeployed(p);
        console2.log("read-back OK: the three pool contracts hold the resolved wiring");
    }

    /// @dev ADRESLER `Profiles`TEN VE `PoolDeployLib`IN PINLERINDEN GELIR,
    ///      ORTAM DEGISKENINDEN DEGIL. Bir `vm.envAddress("FACTORY")` satiri
    ///      bu script'i, kabuk gecmisindeki bir yazim hatasinin kalici bir
    ///      hook adresi uretebildigi bir sey yapardi.
    function _resolve() private view returns (PoolPlan memory p) {
        (address governor,) = Profiles.governanceForChain(block.chainid);
        p = PoolDeployLib.build(block.chainid, governor, PoolDeployLib.ARC_FACTORY, PoolDeployLib.ARC_ESCROW);
        PoolDeployLib.assertDeployable(p);
    }

    function _print(PoolPlan memory p, string memory banner) private pure {
        console2.log("=== arcpad pool deploy ===");
        console2.log(banner);
        console2.log("chainId              ", p.chainId);
        console2.log("owner (governor Safe)", p.owner);
        console2.log("factory              ", p.factory);
        console2.log("escrow               ", p.escrow);
        console2.log("PoolManager  ADDRESS ", p.poolManager);
        console2.log("ArcpadHook   ADDRESS ", p.hook);
        console2.log("  hook salt (MINED)  ", vm.toString(p.hookSalt));
        console2.log("  hook flags low 14b ", uint256(uint160(p.hook) & 0x3FFF));
        console2.log("ArcpadLocker ADDRESS ", p.locker);
        console2.log("tx 1 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ PoolManager  initcode");
        console2.log("tx 2 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ ArcpadHook   initcode");
        console2.log("tx 3 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ ArcpadLocker initcode");
    }
}
