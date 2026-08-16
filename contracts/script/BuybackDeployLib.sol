// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../src/BuybackVestingVault.sol";
import {DeployLib} from "./DeployLib.sol";
import {PoolDeployLib} from "./PoolDeployLib.sol";

struct BuybackPlan {
    uint256 chainId;
    address factory;
    address escrow;
    address poolManager;
    bytes32 vaultSalt;
    bytes vaultInitcode;
    address vault;
    bytes32 treasurySalt;
    bytes treasuryInitcode;
    address treasury;
}

/// @title BuybackDeployLib
/// @notice Buyback neslinin IKI KALICI KONTRATI: `BuybackVestingVault` ve
///         `BuybackTreasury`.
///
/// @dev ============ SIRA ZORUNLUDUR VE TEK YONLUDUR ============
///
///        1. `BuybackVestingVault(factory)`  -- yalnizca fabrikayi alir.
///        2. `BuybackTreasury(factory, escrow, vault, poolManager)`.
///        3. governor Safe -> `setBuybackTreasury(treasury)`   [BIR KEZ]
///        4. governor Safe -> `setGraduationHook(hook)`        [BIR KEZ]
///        5. governor Safe -> `setBuybackKeeper(keeper)`       [dondurulebilir]
///
///      3-5 BU BETIKTE YAPILAMAZ ve yapilmamalidir: ucu de `onlyGovernor`dur
///      ve governor bir 2-of-3 Safe'tir. Betik onlari YAZDIRIR; imzalamak
///      operatorun isidir.
///
/// @dev ============ DAIRESEL BAGIMLILIK YOK, VE BU KAZA DEGIL ============
///
///      Uc kontrat birbirini tanimak zorunda ama HICBIRI otekinin adresini
///      constructor'inda ALMAZ -- her biri fabrikadan CALISMA ZAMANINDA okur:
///        kasa   -> `factory.buybackTreasury()`  (kilitleme yetkisi)
///        hazine -> `factory.graduationHook()`   (tahakkuk mercii)
///        egri   -> `factory.buybackPolicy()`    (ayirma karari)
///      Ucu de constructor argumani olsaydi uc ayri CREATE2 on-tahmini
///      birbirini beklerdi ve hicbiri cozulemezdi. Bedeli tek bir governor
///      yazimidir; kazanci, FABRIKA ADRESININ KIMILDAMAMASIDIR.
///
/// @dev ============ ADRESLER `out-frozen/`DAN TURETILIR ============
///
///      `type(BuybackTreasury).creationCode` CAGIRAN BIRIME BAGLIDIR ve bu
///      OLCULDU: `BuybackPoolVenue.t.sol` `PoolManager`i ismiyle import
///      ettigi icin o birimdeki hazine 44444444'te derlenir
///      (`8b12ff3c...`), bu betik ise 800'dedir (`0d486366...`). Iki farkli
///      initcode, iki farkli ADRES.
///
///      Bedeli `LaunchFactory`ninkiyle ayni sinifta ama daha SESSIZ olurdu:
///      `setBuybackTreasury` BIR KEZ yazilir, yani yanlis birimden turetilmis
///      bir adrese yayin yapmak hazineyi KALICI olarak baglar ve hicbir sey
///      kirmizi olmaz -- kontrat orada, kod orada, yalnizca baytlar paketin
///      sinadigi baytlar degil.
///
///      Bu yuzden turetme `DeployLib.frozenFactoryAddress`in aynisidir:
///      creation code `out-frozen/`dan okunur ve o dizini yalnizca
///      `[profile.frozen]` yazar. Ikisi de `frozen_bytecode_gate.py`nin
///      `FROZEN` tablosunda pinlidir.
library BuybackDeployLib {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Salt'lar SECILMEZ, TURETILIR -- `DeployLib`in kuralinin aynisi.
    bytes32 internal constant VAULT_SALT = keccak256("arcpad.BuybackVestingVault.v1");
    bytes32 internal constant TREASURY_SALT = keccak256("arcpad.BuybackTreasury.v1");

    /// @dev `BuybackVestingVault(address factory)` -- TEK arguman, 32 bayt.
    uint256 internal constant VAULT_ARG_BYTES = 32;
    /// @dev `BuybackTreasury(factory, escrow, vault, poolManager)` -- DORT
    ///      arguman, 128 bayt. Bu sabit ile `_treasuryArgs`in arguman sayisi
    ///      AYNI ANDA guncellenmek zorundadir; `DeployLib.FACTORY_ARG_BYTES`in
    ///      ayrisip fabrika adresini kaydirmasi bu depoda ZATEN YASANDI.
    uint256 internal constant TREASURY_ARG_BYTES = 128;

    error FactoryHasNoCode(address at);
    error EscrowHasNoCode(address at);
    error PoolManagerHasNoCode(address at);
    error GraduationHookNotSet();
    error AlreadyDeployed(string what, address at);
    error InitcodeDoesNotEncodeThePlan(string field);

    function _frozenCreationCode(string memory name) private view returns (bytes memory code) {
        string memory path = string.concat("out-frozen/", name, ".sol/", name, ".json");
        code = vm.parseJsonBytes(vm.readFile(path), ".bytecode.object");
        if (code.length == 0) revert DeployLib.FrozenArtifactMissing(path);
    }

    function build(uint256 chainId, address factory, address escrow, address poolManager)
        internal
        view
        returns (BuybackPlan memory p)
    {
        p.chainId = chainId;
        p.factory = factory;
        p.escrow = escrow;
        p.poolManager = poolManager;

        p.vaultSalt = VAULT_SALT;
        p.vaultInitcode = abi.encodePacked(_frozenCreationCode("BuybackVestingVault"), abi.encode(factory));
        p.vault = DeployLib.predict(VAULT_SALT, p.vaultInitcode);

        p.treasurySalt = TREASURY_SALT;
        p.treasuryInitcode =
            abi.encodePacked(_frozenCreationCode("BuybackTreasury"), abi.encode(factory, escrow, p.vault, poolManager));
        p.treasury = DeployLib.predict(TREASURY_SALT, p.treasuryInitcode);
    }

    /// @notice Yayinlanmadan once dogru olmasi gereken her sey.
    ///
    /// @dev KOD VARLIGI TURETMEDEN AYRI BIR IDDIADIR. Turetme "adres dogru"
    ///      der; bu satirlar "kontrat ORADA" der. Hazinenin constructor'i
    ///      argumanlarini yalnizca sifira karsi kontrol eder, yani kodsuz bir
    ///      fabrika adresi constructor'dan GECER ve her `accrue` cagrisi
    ///      sonsuza kadar revert ederdi.
    function assertDeployable(BuybackPlan memory p) internal view {
        if (DeployLib.CREATE2_FACTORY.codehash != DeployLib.CREATE2_FACTORY_CODEHASH) {
            revert DeployLib.Create2DeployerNotCanonical(
                DeployLib.CREATE2_FACTORY, DeployLib.CREATE2_FACTORY_CODEHASH, DeployLib.CREATE2_FACTORY.codehash
            );
        }
        if (p.factory.code.length == 0) revert FactoryHasNoCode(p.factory);
        if (p.escrow.code.length == 0) revert EscrowHasNoCode(p.escrow);
        if (p.poolManager.code.length == 0) revert PoolManagerHasNoCode(p.poolManager);

        _assertInitcodeEncodesThePlan(p);

        if (p.vault.code.length != 0) revert AlreadyDeployed("BuybackVestingVault", p.vault);
        if (p.treasury.code.length != 0) revert AlreadyDeployed("BuybackTreasury", p.treasury);
    }

    /// @dev `DeployLib._assertInitcodeEncodesThePlan`in ikizi: yayinlanacak
    ///      BAYTLARIN plani gercekten kodladigini cozer. Iki taraf da ayni
    ///      `build`den geldigi icin bu tek basina yetmez -- kimlik kapisi
    ///      `out-frozen/` okumasidir -- ama bir arguman SIRASI hatasini
    ///      (dordu de `address`tir, takas derleyiciden GECER) yakalayan tek
    ///      satir budur.
    function _assertInitcodeEncodesThePlan(BuybackPlan memory p) private pure {
        bytes memory ic = p.treasuryInitcode;
        if (ic.length <= TREASURY_ARG_BYTES) revert InitcodeDoesNotEncodeThePlan("treasuryInitcodeLength");
        bytes memory tail = new bytes(TREASURY_ARG_BYTES);
        uint256 start = ic.length - TREASURY_ARG_BYTES;
        for (uint256 i = 0; i < TREASURY_ARG_BYTES; ++i) {
            tail[i] = ic[start + i];
        }
        (address f, address e, address v, address pmv) = abi.decode(tail, (address, address, address, address));
        if (f != p.factory) revert InitcodeDoesNotEncodeThePlan("factory");
        if (e != p.escrow) revert InitcodeDoesNotEncodeThePlan("escrow");
        if (v != p.vault) revert InitcodeDoesNotEncodeThePlan("vault");
        if (pmv != p.poolManager) revert InitcodeDoesNotEncodeThePlan("poolManager");
    }

    /// @notice Yayinlandiktan SONRA, ZINCIRDEN geri okuma.
    /// @dev Plan "neyi soyluyordu" ile kontrat "neyi sakladi" ancak boyle
    ///      ayrisamaz; dordu de `immutable`dir, yani sorulabilirler.
    function assertAsDeployed(BuybackPlan memory p) internal view {
        BuybackVestingVault vault_ = BuybackVestingVault(p.vault);
        if (vault_.factory() != p.factory) {
            revert DeployLib.GovernanceNotAsDeployed("vault.factory", p.factory, vault_.factory());
        }

        BuybackTreasury t = BuybackTreasury(payable(p.treasury));
        if (t.factory() != p.factory) {
            revert DeployLib.GovernanceNotAsDeployed("treasury.factory", p.factory, t.factory());
        }
        if (t.escrow() != p.escrow) {
            revert DeployLib.GovernanceNotAsDeployed("treasury.escrow", p.escrow, t.escrow());
        }
        if (address(t.vault()) != p.vault) {
            revert DeployLib.GovernanceNotAsDeployed("treasury.vault", p.vault, address(t.vault()));
        }
        if (address(t.poolManager()) != p.poolManager) {
            revert DeployLib.GovernanceNotAsDeployed("treasury.poolManager", p.poolManager, address(t.poolManager()));
        }
    }
}
