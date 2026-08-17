// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {ArcpadHook} from "../src/ArcpadHook.sol";
import {ArcpadLocker} from "../src/ArcpadLocker.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {DeployLib} from "./DeployLib.sol";
import {PoolDeployLib} from "./PoolDeployLib.sol";
import {Profile, Profiles} from "./Profiles.sol";

struct ClockPlan {
    uint256 chainId;
    address governor; // deployer EOA -- the ONLY member allowed to propose
    address treasury; // disposable
    address poolManager; // LIVE, from the address book
    address feeSchedule; // LIVE, from the address book -- stateless, pure table
    bytes32 escrowSalt;
    bytes escrowInitcode;
    address escrow;
    bytes32 factorySalt;
    bytes factoryInitcode;
    address factory;
    bytes32 hookSalt;
    bytes hookInitcode;
    address hook;
    bytes32 lockerSalt;
    bytes lockerInitcode;
    address locker;
}

/// @title DeployDisposableGraduationClock
/// @notice A FULLY DISPOSABLE Phase-2-shape stack -- own `FeeEscrow`, own
///         `LaunchFactory`, own `ArcpadHook`, own `ArcpadLocker` -- bound to
///         the LIVE `PoolManager` and the LIVE (stateless) `FeeSchedule`, and
///         the `proposeGraduationTarget` call that STARTS THE THREE-DAY CLOCK.
///
/// @dev WHY THIS SCRIPT EXISTS AND WHY IT IS NOT `DeployPool`. Task 8B proved
///      the graduation cycle in a fork; nothing on chain has ever observed a
///      real `Graduated` event, a real pool, or node-produced EIP-7708 logs
///      from an actual `graduate()`. Arming ANY factory costs three days
///      (`proposeGraduationTarget` -> `GRADUATION_TARGET_DELAY` ->
///      `applyGraduationTarget`), so the clock has to start in one session and
///      finish in another. This script is the first half, and ONLY the first
///      half.
///
/// @dev THE PRODUCTION FACTORY IS NEVER TOUCHED, AND THAT IS ASSERTED RATHER
///      THAN INTENDED. `applyGraduationTarget` is PERMISSIONLESS: an armed
///      proposal on `0x5CA156f1...` lands with zero notice once its delay
///      expires, and the first graduation freezes the hook address in every
///      `PoolKey` forever. `_assertDisposable` refuses to broadcast if any
///      derived address collides with a book address.
///
/// @dev NOTHING LIVE MOVES. The escrow is the stack's OWN, so no `owed` slot
///      of the real treasury or any real creator can be written; the live
///      `FeeSchedule` is stateless (constants plus `pure`/`view` members only),
///      so binding to it is a STATICCALL and nothing more; the live
///      `PoolManager` gains, later, one pool under a DIFFERENT hook address --
///      hence a different `PoolId` -- and no existing pool is reachable from
///      this stack.
///
/// @dev EVERY ADDRESS IS CREATE2, INCLUDING THE ONES THAT DID NOT NEED TO BE.
///      `forge script` simulates and then broadcasts; a nonce that moves in
///      between shifts every CREATE address. That would be silent here and not
///      elsewhere: the hook's salt is MINED against the factory address, so a
///      shifted factory would leave a hook whose flags are still 0x20CC, whose
///      mined address still reproduces, and whose `factory` immutable points
///      at an address with no code -- permanently, because the hook address is
///      a field of every `PoolKey`. Deterministic CREATE2 for all four removes
///      the class instead of guarding against it.
contract DeployDisposableGraduationClock is Script {
    /// @dev Disposable salts. DISTINCT FROM THE PRODUCTION ONES BY
    ///      CONSTRUCTION: `FeeEscrow` has no constructor arguments, so
    ///      `keccak256("arcpad.FeeEscrow.v1")` already resolves to the LIVE,
    ///      FUNDED escrow `0xEEd4431e...`. Reusing that salt would not deploy a
    ///      disposable escrow -- it would hit an occupied address.
    bytes32 internal constant ESCROW_SALT = keccak256("arcpad.disposable.graduation-clock.FeeEscrow.v1");
    bytes32 internal constant FACTORY_SALT = keccak256("arcpad.disposable.graduation-clock.LaunchFactory.v1");
    bytes32 internal constant LOCKER_SALT = keccak256("arcpad.disposable.graduation-clock.ArcpadLocker.v1");

    /// @dev The disposable protocol treasury. Same literal Task 8B's fork test
    ///      uses, so the two agree on which recipient is fictional.
    address internal constant DISPOSABLE_TREASURY = address(0x7EA5);

    string internal constant ARC_ADDRESS_BOOK = "deploy/addresses.5042002.json";

    /// @dev Five deploys' worth of headroom at the measured ~21.7 gwei. The
    ///      whole run is ~6.7M gas ~= 0.15 USDC.
    uint256 internal constant MIN_DEPLOYER_BALANCE = 2e18;

    error NotArcTestnet(uint256 chainId);
    error GovernorIsNotAnEoa(address governor);
    error CollidesWithTheProductionStack(string what, address at);
    error HookAddressLacksTheArcpadFlags(address hook, uint160 got, uint160 want);
    error HookSaltDoesNotReproduceTheAddress(bytes32 salt, address expected, address actual);
    error AddressAlreadyOccupied(string what, address at);
    error InsufficientDeployerBalance(address deployer, uint256 have, uint256 need);
    error NotAsDeployed(string field, address expected, address actual);
    error ProposalNotAsBroadcast(string field, uint256 expected, uint256 actual);

    function plan() public returns (ClockPlan memory p) {
        p = _resolve();
        _print(p, "DRY RUN -- nothing was broadcast");
    }

    function run() public returns (ClockPlan memory p) {
        p = _resolve();
        _print(p, "BROADCASTING -- four deploys and ONE propose");

        vm.startBroadcast();
        address escrowAddr = DeployLib.deploy(p.escrowSalt, p.escrowInitcode);
        address factoryAddr = DeployLib.deploy(p.factorySalt, p.factoryInitcode);
        address hookAddr = DeployLib.deploy(p.hookSalt, p.hookInitcode);
        address lockerAddr = DeployLib.deploy(p.lockerSalt, p.lockerInitcode);
        // THE CLOCK STARTS HERE, AND NOWHERE ELSE. `_assertDisposable` has
        // already refused every book address, so `factoryAddr` cannot be the
        // production factory.
        LaunchFactory(factoryAddr).proposeGraduationTarget(lockerAddr);
        vm.stopBroadcast();

        if (escrowAddr != p.escrow) revert NotAsDeployed("escrow", p.escrow, escrowAddr);
        if (factoryAddr != p.factory) revert NotAsDeployed("factory", p.factory, factoryAddr);
        if (hookAddr != p.hook) revert NotAsDeployed("hook", p.hook, hookAddr);
        if (lockerAddr != p.locker) revert NotAsDeployed("locker", p.locker, lockerAddr);

        _assertAsDeployed(p);
        _assertProposalArmed(p);

        console2.log("read-back OK -- the clock is running on the DISPOSABLE factory");
    }

    // ---------------------------------------------------------------
    // Derivation
    // ---------------------------------------------------------------

    function _resolve() private returns (ClockPlan memory p) {
        p.chainId = block.chainid;
        if (p.chainId != Profiles.ARC_TESTNET_CHAIN_ID) revert NotArcTestnet(p.chainId);

        // GOVERNOR IS THE BROADCASTER. `LaunchFactory`'s constructor rejects
        // only the zero address and the escrow (`ZeroGovernorAddress`,
        // `GovernorIsTheEscrow`); the Safe requirement lives in
        // `DeployLib._assertMultisig`, i.e. in the DEPLOY SCRIPT and not in the
        // contract -- which is exactly why a disposable stack may hold an EOA
        // here. Verified by reading `LaunchFactory.sol:663-664` against
        // `DeployLib.sol:478`.
        p.governor = msg.sender;
        if (p.governor.code.length != 0) revert GovernorIsNotAnEoa(p.governor);
        p.treasury = DISPOSABLE_TREASURY;

        string memory json = vm.readFile(ARC_ADDRESS_BOOK);
        p.poolManager = vm.parseJsonAddress(json, ".poolManager");
        p.feeSchedule = vm.parseJsonAddress(json, ".feeSchedule");

        Profile memory profile = Profiles.forChain(p.chainId);

        p.escrowSalt = ESCROW_SALT;
        p.escrowInitcode = type(FeeEscrow).creationCode;
        p.escrow = DeployLib.predict(p.escrowSalt, p.escrowInitcode);

        p.factorySalt = FACTORY_SALT;
        p.factoryInitcode = abi.encodePacked(
            type(LaunchFactory).creationCode,
            DeployLib.factoryArgs(p.escrow, p.treasury, p.governor, profile, p.feeSchedule)
        );
        p.factory = DeployLib.predict(p.factorySalt, p.factoryInitcode);

        bytes memory hookArgs = abi.encode(IPoolManager(p.poolManager), p.factory, p.escrow);
        (address minedHook, bytes32 minedSalt) = HookMiner.find(
            DeployLib.CREATE2_FACTORY, PoolDeployLib.ARCPAD_HOOK_FLAGS, type(ArcpadHook).creationCode, hookArgs
        );
        p.hookSalt = minedSalt;
        p.hookInitcode = abi.encodePacked(type(ArcpadHook).creationCode, hookArgs);
        p.hook = minedHook;

        p.lockerSalt = LOCKER_SALT;
        p.lockerInitcode = abi.encodePacked(
            type(ArcpadLocker).creationCode, abi.encode(IPoolManager(p.poolManager), p.factory, IHooks(p.hook))
        );
        p.locker = DeployLib.predict(p.lockerSalt, p.lockerInitcode);

        _assertDeployable(p);
    }

    function _assertDeployable(ClockPlan memory p) private view {
        if (DeployLib.CREATE2_FACTORY.codehash != DeployLib.CREATE2_FACTORY_CODEHASH) {
            revert DeployLib.Create2DeployerNotCanonical(
                DeployLib.CREATE2_FACTORY, DeployLib.CREATE2_FACTORY_CODEHASH, DeployLib.CREATE2_FACTORY.codehash
            );
        }
        if (p.governor.balance < MIN_DEPLOYER_BALANCE) {
            revert InsufficientDeployerBalance(p.governor, p.governor.balance, MIN_DEPLOYER_BALANCE);
        }

        _assertDisposable(p);

        uint160 got = uint160(p.hook) & Hooks.ALL_HOOK_MASK;
        if (got != PoolDeployLib.ARCPAD_HOOK_FLAGS) {
            revert HookAddressLacksTheArcpadFlags(p.hook, got, PoolDeployLib.ARCPAD_HOOK_FLAGS);
        }
        // `HookMiner` returns address and salt TOGETHER, so trusting its pair
        // would be a tautology; `predict` runs independently over the initcode
        // that will actually be broadcast.
        address rederived = DeployLib.predict(p.hookSalt, p.hookInitcode);
        if (rederived != p.hook) revert HookSaltDoesNotReproduceTheAddress(p.hookSalt, p.hook, rederived);

        if (p.escrow.code.length != 0) revert AddressAlreadyOccupied("FeeEscrow", p.escrow);
        if (p.factory.code.length != 0) revert AddressAlreadyOccupied("LaunchFactory", p.factory);
        if (p.hook.code.length != 0) revert AddressAlreadyOccupied("ArcpadHook", p.hook);
        if (p.locker.code.length != 0) revert AddressAlreadyOccupied("ArcpadLocker", p.locker);

        // The live members this stack BINDS to must really be on chain.
        if (p.poolManager.code.length == 0) revert NotAsDeployed("poolManager has no code", p.poolManager, address(0));
        if (p.feeSchedule.code.length == 0) revert NotAsDeployed("feeSchedule has no code", p.feeSchedule, address(0));
    }

    /// @notice Not one derived address may be a production address.
    /// @dev THE GUARD IS AGAINST THE BOOK, NOT AGAINST A LITERAL. A literal
    ///      would have to be kept in step with a redeploy by hand; the book is
    ///      what every other layer reads.
    function _assertDisposable(ClockPlan memory p) private view {
        string memory json = vm.readFile(ARC_ADDRESS_BOOK);
        address[5] memory production = [
            vm.parseJsonAddress(json, ".launchFactory"),
            vm.parseJsonAddress(json, ".feeEscrow"),
            vm.parseJsonAddress(json, ".arcpadHook"),
            vm.parseJsonAddress(json, ".arcpadLocker"),
            vm.parseJsonAddress(json, ".governor")
        ];
        address[4] memory derived = [p.escrow, p.factory, p.hook, p.locker];
        for (uint256 i = 0; i < derived.length; ++i) {
            for (uint256 j = 0; j < production.length; ++j) {
                if (derived[i] == production[j]) revert CollidesWithTheProductionStack("derived", derived[i]);
            }
        }
        // ...and the treasury this stack pays must not be the real one either.
        if (p.treasury == vm.parseJsonAddress(json, ".protocolTreasury")) {
            revert CollidesWithTheProductionStack("treasury", p.treasury);
        }
    }

    // ---------------------------------------------------------------
    // Read-back
    // ---------------------------------------------------------------

    function _assertAsDeployed(ClockPlan memory p) private view {
        LaunchFactory f = LaunchFactory(p.factory);
        if (f.escrow() != p.escrow) revert NotAsDeployed("factory.escrow", p.escrow, f.escrow());
        if (f.governor() != p.governor) revert NotAsDeployed("factory.governor", p.governor, f.governor());
        if (f.protocolTreasury() != p.treasury) {
            revert NotAsDeployed("factory.protocolTreasury", p.treasury, f.protocolTreasury());
        }
        if (f.feeSchedule() != p.feeSchedule) {
            revert NotAsDeployed("factory.feeSchedule", p.feeSchedule, f.feeSchedule());
        }
        // THE TARGET IS STILL UNSET, AND MUST BE: `proposeGraduationTarget`
        // arms `pendingGraduationTarget`, never `graduationTarget`.
        if (f.graduationTarget() != address(0)) {
            revert NotAsDeployed("factory.graduationTarget", address(0), f.graduationTarget());
        }

        ArcpadHook h = ArcpadHook(p.hook);
        if (address(h.poolManager()) != p.poolManager) {
            revert NotAsDeployed("hook.poolManager", p.poolManager, address(h.poolManager()));
        }
        if (h.factory() != p.factory) revert NotAsDeployed("hook.factory", p.factory, h.factory());
        if (h.escrow() != p.escrow) revert NotAsDeployed("hook.escrow", p.escrow, h.escrow());

        ArcpadLocker l = ArcpadLocker(payable(p.locker));
        if (address(l.poolManager()) != p.poolManager) {
            revert NotAsDeployed("locker.poolManager", p.poolManager, address(l.poolManager()));
        }
        if (l.factory() != p.factory) revert NotAsDeployed("locker.factory", p.factory, l.factory());
        if (address(l.hook()) != p.hook) revert NotAsDeployed("locker.hook", p.hook, address(l.hook()));
    }

    /// @dev THE WINDOW IS BOUNDED ON BOTH SIDES. `applyGraduationTarget`
    ///      reverts `GraduationTargetDelayNotElapsed()` below `eta` AND
    ///      `GraduationTargetProposalExpired()` above
    ///      `eta + GRADUATION_TARGET_DELAY` (`LaunchFactory.sol:931-932`). A
    ///      report that records only the open end would send the next session
    ///      to a proposal that has already lapsed.
    function _assertProposalArmed(ClockPlan memory p) private view {
        LaunchFactory f = LaunchFactory(p.factory);
        if (f.pendingGraduationTarget() != p.locker) {
            revert NotAsDeployed("pendingGraduationTarget", p.locker, f.pendingGraduationTarget());
        }
        uint256 eta = f.pendingGraduationTargetEta();
        uint256 delay = f.GRADUATION_TARGET_DELAY();
        if (eta != block.timestamp + delay) {
            revert ProposalNotAsBroadcast("eta", block.timestamp + delay, eta);
        }
        console2.log("pendingGraduationTargetEta (SIMULATED -- re-read from chain)", eta);
        console2.log("apply window closes at (SIMULATED)                          ", eta + delay);
    }

    function _print(ClockPlan memory p, string memory banner) private pure {
        console2.log("=== arcpad DISPOSABLE graduation clock ===");
        console2.log(banner);
        console2.log("chainId                  ", p.chainId);
        console2.log("governor  (deployer EOA) ", p.governor);
        console2.log("treasury  (DISPOSABLE)   ", p.treasury);
        console2.log("PoolManager (LIVE)       ", p.poolManager);
        console2.log("FeeSchedule (LIVE)       ", p.feeSchedule);
        console2.log("FeeEscrow     DISPOSABLE ", p.escrow);
        console2.log("LaunchFactory DISPOSABLE ", p.factory);
        console2.log("ArcpadHook    DISPOSABLE ", p.hook);
        console2.log("  hook salt (MINED)      ", vm.toString(p.hookSalt));
        console2.log("  hook flags low 14b     ", uint256(uint160(p.hook) & 0x3FFF));
        console2.log("ArcpadLocker  DISPOSABLE ", p.locker);
        console2.log("tx 1 -> CREATE2 FeeEscrow");
        console2.log("tx 2 -> CREATE2 LaunchFactory");
        console2.log("tx 3 -> CREATE2 ArcpadHook");
        console2.log("tx 4 -> CREATE2 ArcpadLocker");
        console2.log("tx 5 -> factory.proposeGraduationTarget(locker)   <- STARTS THE 3-DAY CLOCK");
    }
}
