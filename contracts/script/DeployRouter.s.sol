// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {DeployLib} from "./DeployLib.sol";
import {PoolDeployLib} from "./PoolDeployLib.sol";
import {RouterDeployLib, RouterPlan} from "./RouterDeployLib.sol";

/// @title DeployRouter
/// @notice Mezuniyet sonrasi ticaretin giris noktasi: `ArcpadRouter`.
///         `Deploy` ve `DeployPool`un ikizi -- `plan()` KURU KOSU, `run()`
///         GERCEK, ikisi de AYNI `_resolve()`den gecer.
///
/// @dev BU SCRIPT `DeployPool`DAN SONRA KOSAR VE SIRA ZORUNLUDUR: router'in
///      constructor'i hem `PoolManager` hem hook adresini `immutable` olarak
///      alir, yani ikisi de zincirde olmadan turetilemez.
///
/// @dev BU SCRIPT `graduationTarget`A DOKUNMAZ, HAVUZ ACMAZ, LIKIDITE
///      EKLEMEZ. Tek isi TEK bir kontrat indirmektir; router hicbir yetki
///      tasimaz ve hicbir zincir ustu yapi onu referans etmez.
contract DeployRouter is Script {
    function plan() public view returns (RouterPlan memory p) {
        p = _resolve();
        _print(p, "DRY RUN -- nothing was broadcast");
    }

    function run() public returns (RouterPlan memory p) {
        p = _resolve();
        _print(p, "BROADCASTING");

        vm.startBroadcast();
        address routerAddr = DeployLib.deploy(p.salt, p.initcode);
        vm.stopBroadcast();

        require(routerAddr == p.router, "router address diverged from the plan");

        RouterDeployLib.assertAsDeployed(p);
        console2.log("read-back OK: the router holds the resolved wiring");
    }

    /// @dev ADRESLER `PoolDeployLib`IN PINLERINDEN GELIR, ORTAM
    ///      DEGISKENINDEN DEGIL -- `DeployPool`un kuralinin aynisi. Bir
    ///      `vm.envAddress("HOOK")` satiri, kabuk gecmisindeki bir yazim
    ///      hatasinin router'i arcpad'e AIT OLMAYAN bir anahtar uzayina
    ///      baglayabildigi bir sey yapardi.
    function _resolve() private view returns (RouterPlan memory p) {
        p = RouterDeployLib.build(block.chainid, PoolDeployLib.ARC_POOL_MANAGER, PoolDeployLib.ARC_HOOK);
        RouterDeployLib.assertDeployable(p);
    }

    function _print(RouterPlan memory p, string memory banner) private pure {
        console2.log("=== arcpad router deploy ===");
        console2.log(banner);
        console2.log("chainId              ", p.chainId);
        console2.log("PoolManager          ", p.poolManager);
        console2.log("ArcpadHook           ", p.hook);
        console2.log("ArcpadRouter ADDRESS ", p.router);
        console2.log("  salt (DERIVED)     ", vm.toString(p.salt));
        console2.log("tx 1 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ ArcpadRouter initcode");
    }
}
