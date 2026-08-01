// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DeployLib, Plan} from "./DeployLib.sol";
import {Profile, Profiles} from "./Profiles.sol";

/// @title Deploy
/// @notice `plan()` KURU KOSU, `run()` GERCEK. Ikisi de AYNI `_resolve()`den
///         gecer; `run()`un iddialari atlayabilecegi bir yol YOKTUR, cunku
///         yayinladigi Plan tam olarak `_resolve()`in dondurdugu Plan'dir.
contract Deploy is Script {
    // GOVERNANCE_PATH BURADA DEGIL, `Profiles.sol`dadir: governance dosyasi
    // artik profil dosyasiyla ayni mekanizmadan -- yol + digest -- gecer.

    function plan() public view returns (Plan memory p) {
        p = _resolve();
        _print(p, "DRY RUN -- nothing was broadcast");
    }

    function run() public returns (Plan memory p) {
        p = _resolve();
        _print(p, "BROADCASTING");

        vm.startBroadcast();
        address escrowAddr = DeployLib.deploy(p.escrowSalt, p.escrowInitcode);
        // SIRA ZORUNLUDUR: factory'nin constructor'i `feeSchedule`in KODUNU
        // kontrol eder (`FeeScheduleHasNoCode`). Once schedule inmezse
        // factory'nin CREATE2'si revert eder.
        address scheduleAddr = DeployLib.deploy(p.feeScheduleSalt, p.feeScheduleInitcode);
        address factoryAddr = DeployLib.deploy(p.factorySalt, p.factoryInitcode);
        vm.stopBroadcast();

        require(escrowAddr == p.escrow, "escrow address diverged from the plan");
        require(scheduleAddr == p.feeSchedule, "feeSchedule address diverged from the plan");
        require(factoryAddr == p.factory, "factory address diverged from the plan");

        DeployLib.assertAsDeployed(p);
        console2.log("read-back OK: the deployed factory holds the resolved profile");
    }

    /// @dev IKI VERI DOSYASI, IKI DIGEST, AYNI MEKANIZMA. Sayilar
    ///      `profiles.toml`dan `ProfileDigestMismatch` ile, adresler
    ///      `expected-governance.json`dan `GovernanceDigestMismatch` ile gelir.
    ///      Ikisi de tek basina duzenlenemez, cunku ikisinin de pinlenmis
    ///      sabiti DERLENEN kodda durur.
    function _resolve() private view returns (Plan memory p) {
        Profile memory profile = Profiles.forChain(block.chainid);
        (address governor, address treasury) = Profiles.governanceForChain(block.chainid);

        p = DeployLib.build(block.chainid, profile, msg.sender, governor, treasury);
        DeployLib.assertDeployable(p);
    }

    /// @dev `pure`, `view` DEGIL. Plan bunu `view` yaziyor ve gerekcesini
    ///      "`vm.toString` `pure` degil" diye veriyor. OLCULDU VE YANLIS: bu
    ///      forge-std surumunde `toString(bytes32)` `external pure`, ve
    ///      `console2.log` da `_castToPure` uzerinden `pure`dur. `view`
    ///      birakmak solc'un "Function state mutability can be restricted to
    ///      pure" uyarisini uretiyordu. Plan "bir derleyici yukseltmesi `pure`
    ///      olmasina izin verirse SIKILASTIR" diyor; kosul BUGUN zaten
    ///      saglaniyor, o yuzden sikilastirildi. GEVSETILMESI YASAK.
    function _print(Plan memory p, string memory banner) private pure {
        console2.log("=== arcpad deploy ===");
        console2.log(banner);
        console2.log("chainId             ", p.chainId);
        console2.log("PROFILE             ", p.profile.name);
        console2.log("  T                 ", p.profile.virtualTokenReserves);
        console2.log("  V                 ", p.profile.virtualQuoteReserves);
        console2.log("  S                 ", p.profile.saleSupply);
        console2.log("deployer (gas only) ", p.deployer);
        console2.log("governor (Safe)     ", p.governor);
        console2.log("treasury (Safe)     ", p.treasury);
        console2.log("escrow  salt        ", vm.toString(p.escrowSalt));
        console2.log("escrow  initcodeHash", vm.toString(keccak256(p.escrowInitcode)));
        console2.log("escrow  ADDRESS     ", p.escrow);
        console2.log("factory salt        ", vm.toString(p.factorySalt));
        console2.log("factory initcodeHash", vm.toString(keccak256(p.factoryInitcode)));
        console2.log("factory ADDRESS     ", p.factory);
        console2.log("schedule salt       ", vm.toString(p.feeScheduleSalt));
        console2.log("schedule initcodeHsh", vm.toString(keccak256(p.feeScheduleInitcode)));
        console2.log("schedule ADDRESS    ", p.feeSchedule);
        console2.log("tx 1 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ FeeEscrow initcode");
        console2.log("tx 2 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ LaunchFactory initcode");
    }
}
