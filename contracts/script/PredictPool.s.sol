// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PoolDeployLib, PoolPlan} from "./PoolDeployLib.sol";

/// @notice Faz 2'nin UC havuz kontratinin adreslerini TAHMIN EDER, deploy
///         ETMEZ -- ve `assertDeployable`i CAGIRMAZ.
///
/// @dev `PredictPhase2`nin ikizi ve ayni gerekceyle: yoklamalar zincir ister,
///      bu script yerelde de kosabilmelidir. AYRICA bu, hook tuzunu ILK KEZ
///      madenlemenin yoludur: pini URETEN komut, pini KONTROL eden komut
///      olamaz -- `assertDeployable` bos bir pinle zaten duserdi.
contract PredictPool is Script {
    function run() external view {
        uint256 chainId = PoolDeployLib.ARC_TESTNET_CHAIN_ID;
        PoolPlan memory p = PoolDeployLib.build(
            chainId, PoolDeployLib.ARC_GOVERNOR, PoolDeployLib.factoryFor(chainId), PoolDeployLib.escrowFor(chainId)
        );

        console2.log("=== arcpad Faz 2 havuz katmani (chain 5042002) ===");
        console2.log("owner (governor Safe)", p.owner);
        console2.log("factory              ", p.factory);
        console2.log("escrow               ", p.escrow);
        console2.log("");
        console2.log("PoolManager  ", p.poolManager);
        console2.log("ArcpadHook   ", p.hook);
        console2.log("ArcpadLocker ", p.locker);
        console2.log("");
        console2.log("hook salt (MINED)    ", vm.toString(p.hookSalt));
        console2.log("hook flags (low 14b) ", uint256(uint160(p.hook) & 0x3FFF));
        console2.log("hook creationCodeHash", vm.toString(PoolDeployLib.hookCreationCodeHash()));
        console2.log("hook initcodeHash    ", vm.toString(keccak256(p.hookInitcode)));
        console2.log("poolManager initHash ", vm.toString(keccak256(p.poolManagerInitcode)));
        console2.log("locker initcodeHash  ", vm.toString(keccak256(p.lockerInitcode)));
    }
}
