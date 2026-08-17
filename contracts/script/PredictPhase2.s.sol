// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DeployLib, Plan} from "./DeployLib.sol";
import {Profile} from "./Profiles.sol";

/// @notice Faz 2 sonrasi Arc testnet adreslerini TAHMIN EDER, deploy ETMEZ.
///         `assertDeployable`i CAGIRMAZ, cunku o Safe yoklamasi yapar ve bu
///         script yerelde de kosabilmelidir.
contract PredictPhase2 is Script {
    function run() external pure {
        Profile memory p = Profile({
            name: "testnet",
            virtualTokenReserves: 1_073_000_000e18,
            virtualQuoteReserves: 4_292e15,
            saleSupply: 793_100_000e18
        });
        Plan memory plan = DeployLib.build(
            5042002,
            p,
            address(0xdead), // deployer -- adresi ETKILEMEZ (CREATE2 deployer sabittir)
            0x970534698e4592932F31892759147f79EB0D2C22, // governor Safe
            0xebBeCfDA308EA307e173C6eC19a9C48F53d4B10c // treasury Safe
        );

        console2.log("=== arcpad Faz 2 tahmini adresler (chain 5042002) ===");
        console2.log("escrow       ", plan.escrow);
        console2.log("feeSchedule  ", plan.feeSchedule);
        console2.log("factory (NEW)", plan.factory);
        console2.log("");
        console2.log("escrow      initcodeHash", vm.toString(keccak256(plan.escrowInitcode)));
        console2.log("feeSchedule initcodeHash", vm.toString(keccak256(plan.feeScheduleInitcode)));
        console2.log("factory     initcodeHash", vm.toString(keccak256(plan.factoryInitcode)));
    }
}
