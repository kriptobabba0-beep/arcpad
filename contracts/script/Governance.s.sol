// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Profiles} from "./Profiles.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    /// @dev Safe'in kendi kaynaginda bu uye `public pure`dur, ve onu burada da
    ///      `pure` yazmak DERLENIR -- solc bir dis cagrinin mutabilitesini
    ///      CAGRILAN ARAYUZDEN alir. Ama o zaman `_predict` de `pure`
    ///      olabilirdi ve bu YANILTICI olurdu: cagri gercek bir STATICCALL'dir
    ///      ve sonucu ZINCIR DURUMUNA baglidir (o adreste hangi factory
    ///      duruyorsa). `view` yazmak, solc'un uyarisini susturmak yerine
    ///      fonksiyonun gercekte ne yaptigini soyler.
    function proxyCreationCode() external view returns (bytes memory);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

interface ISafe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @title Governance
/// @notice Iki Safe: YETKI (governor) ve GELIR (treasury). Karar D-3.
///
/// @dev NICIN IKI SAFE, BIR DEGIL. Governor yetkiyi, treasury geliri tasir;
///      tek bir uzlasma ikisini birden ele gecirmemeli. `LaunchFactory`
///      `governor == protocolTreasury`i ACIKCA kabul eder, yani bu bir POLITIKA
///      secimidir ve zincir tarafindan degil `addresses.ts`in takma-ad
///      kontrolu tarafindan uygulanir.
///
/// @dev NICIN `SafeL2`, `Safe` DEGIL. L2 varyanti her yurutme icin
///      `SafeMultiSigTransaction` / `ExecutionSuccess` olaylari YAYAR. Arc'ta
///      bu planin dogrulayabildigi bir Safe transaction service YOKTUR, yani
///      ZINCIRIN KENDI LOGLARI governance faaliyetinin TEK kaydidir -- Task
///      5'in watcher'inin ve Faz 3'un indexer'inin yeniden kurmasi gereken sey
///      tam olarak budur. L2 olmayan singleton'i secmek Safe faaliyetini
///      zincir disindan gorunmez kilardi (trace disinda).
///
/// @dev ADRESLER OWNER KUMESINE BAGLIDIR. `owners` initializer'in icindedir,
///      initializer salt'in icindedir, salt adresin icindedir. Yani FARKLI BIR
///      OWNER KUMESI FARKLI BIR SAFE ADRESIDIR -- ve o adres factory'nin
///      constructor argumani oldugu icin FARKLI BIR FACTORY ADRESIDIR. Owner
///      kumesini incelenen artefaktin parcasi yapan sey budur.
contract Governance is Script {
    /// @dev Arc testnet'te OLCULDU (bayt): proxy factory 3054, SafeL2 24421,
    ///      fallback handler 5637. Uzunluklar burada YALNIZCA belge; kapi
    ///      `test/fork/Governance.fork.t.sol` icindedir ve `> 0` bakar --
    ///      bir Safe yama surumu esitlik kontrolunu bosuna kirmis olurdu.
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    uint256 internal constant SAFE_THRESHOLD = 2;

    uint256 internal constant GOVERNOR_SALT_NONCE = uint256(keccak256("arcpad.governor.v1"));
    uint256 internal constant TREASURY_SALT_NONCE = uint256(keccak256("arcpad.treasury.v1"));

    error SafeDeploymentMissing(string what, address at);
    error NoOwnersDeclared(string chainKey);
    error SafeAddressDiverged(string role, address predicted, address actual);
    error SafesCollide(address both);

    /// @notice KURU KOSU: iki Safe adresini deploy etmeden turetir.
    function predictSafes() public view returns (address governor, address treasury) {
        address[] memory owners = _owners();
        governor = _predict(owners, GOVERNOR_SALT_NONCE);
        treasury = _predict(owners, TREASURY_SALT_NONCE);
        _print(owners, governor, treasury, "DRY RUN -- nothing was broadcast");
    }

    /// @notice GERCEK: iki Safe'i deploy eder ve adreslerini tahminle karsilastirir.
    function createSafes() public returns (address governor, address treasury) {
        address[] memory owners = _owners();
        _assertSafeDeploymentPresent();

        address predictedGovernor = _predict(owners, GOVERNOR_SALT_NONCE);
        address predictedTreasury = _predict(owners, TREASURY_SALT_NONCE);
        _print(owners, predictedGovernor, predictedTreasury, "BROADCASTING");

        bytes memory initializer = _initializer(owners);

        vm.startBroadcast();
        governor = _createIfAbsent(predictedGovernor, initializer, GOVERNOR_SALT_NONCE);
        treasury = _createIfAbsent(predictedTreasury, initializer, TREASURY_SALT_NONCE);
        vm.stopBroadcast();

        if (governor != predictedGovernor) revert SafeAddressDiverged("governor", predictedGovernor, governor);
        if (treasury != predictedTreasury) revert SafeAddressDiverged("treasury", predictedTreasury, treasury);
        if (governor == treasury) revert SafesCollide(governor);

        _assertSafe("governor", governor, owners);
        _assertSafe("treasury", treasury, owners);

        console2.log("read-back OK: both Safes are 2-of-3 at the predicted addresses");
        console2.log("governor", governor);
        console2.log("treasury", treasury);
    }

    /// @dev AYNI initializer, FARKLI saltNonce. Iki Safe'in ayni owner kumesini
    ///      ve ayni esigi tasimasi TESTNET icin kabul edilmistir; MAINNET'te
    ///      ayrilmalari gerekir ve bu bir mainnet kapisi olarak kayitlidir.
    ///      Adreslerin ayrilmasini saglayan sey saltNonce'tur.
    function _createIfAbsent(address predicted, bytes memory initializer, uint256 saltNonce) private returns (address) {
        // IDEMPOTENT. Yarida kalmis bir kosuyu tekrar etmek ikinci bir Safe
        // URETMEZ; ayni salt ayni adresi verir ve `createProxyWithNonce` orada
        // kod varsa revert ederdi. Bu yuzden once bakiyoruz.
        if (predicted.code.length != 0) {
            console2.log("already deployed, skipping", predicted);
            return predicted;
        }
        return ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_L2_SINGLETON, initializer, saltNonce);
    }

    function _initializer(address[] memory owners) private pure returns (bytes memory) {
        return abi.encodeCall(
            ISafeSetup.setup,
            (
                owners,
                SAFE_THRESHOLD,
                address(0), // to
                "", // data
                SAFE_FALLBACK_HANDLER,
                address(0), // paymentToken
                0, // payment
                payable(address(0)) // paymentReceiver
            )
        );
    }

    /// @dev `proxyCreationCode` CANLI FACTORY'DEN OKUNUR, SABIT DEGILDIR.
    ///      Sabitlemek tam olarak bu projenin defalarca yakaladigi
    ///      TRANSKRIPSIYON hatasi olurdu: o bytecode deploy edilmis
    ///      factory'nin bir OZELLIGIDIR, bizim bir varsayimimiz degil.
    function _predict(address[] memory owners, uint256 saltNonce) private view returns (address) {
        bytes memory initializer = _initializer(owners);
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes memory deploymentData = abi.encodePacked(
            ISafeProxyFactory(SAFE_PROXY_FACTORY).proxyCreationCode(), uint256(uint160(SAFE_L2_SINGLETON))
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), SAFE_PROXY_FACTORY, salt, keccak256(deploymentData))))
            )
        );
    }

    /// @dev OWNER KUMESI VERIDIR ve `expected-governance.json`dan okunur.
    ///      Script'e argüman olarak gecirilemez: gecirilebilseydi, incelenen
    ///      dosyadan BASKA bir owner kumesiyle Safe uretmek mumkun olurdu ve
    ///      adresin o dosyaya baglanmasinin anlami kalmazdi.
    function _owners() private view returns (address[] memory owners) {
        string memory key = Profiles.chainKeyFor(block.chainid);
        string memory json = vm.readFile(Profiles.GOVERNANCE_PATH);
        owners = vm.parseJsonAddressArray(json, string.concat(".", key, ".owners"));
        if (owners.length < 3) revert NoOwnersDeclared(key);
    }

    function _assertSafeDeploymentPresent() private view {
        if (SAFE_PROXY_FACTORY.code.length == 0) revert SafeDeploymentMissing("SafeProxyFactory", SAFE_PROXY_FACTORY);
        if (SAFE_L2_SINGLETON.code.length == 0) revert SafeDeploymentMissing("SafeL2", SAFE_L2_SINGLETON);
        if (SAFE_FALLBACK_HANDLER.code.length == 0) {
            revert SafeDeploymentMissing("FallbackHandler", SAFE_FALLBACK_HANDLER);
        }
    }

    /// @dev GERI OKUMA. `Deploy.s.sol`un `assertAsDeployed`i ile ayni gerekce:
    ///      deploy edilen seyin GERCEKTEN istenen sey oldugunu, tahminden
    ///      degil ZINCIRDEN okuyarak dogrular.
    function _assertSafe(string memory role, address safe, address[] memory expectedOwners) private view {
        if (safe.code.length == 0) revert SafeDeploymentMissing(role, safe);
        require(ISafe(safe).getThreshold() == SAFE_THRESHOLD, "safe threshold is not 2");
        address[] memory actual = ISafe(safe).getOwners();
        require(actual.length == expectedOwners.length, "safe owner count diverged");
        // Safe owner'lari bagli listede tutar ve SIRA korunmaz; kume olarak
        // karsilastirilir.
        for (uint256 i = 0; i < expectedOwners.length; ++i) {
            bool found;
            for (uint256 j = 0; j < actual.length; ++j) {
                if (actual[j] == expectedOwners[i]) {
                    found = true;
                    break;
                }
            }
            require(found, "declared owner is not an owner of the deployed Safe");
        }
    }

    function _print(address[] memory owners, address governor, address treasury, string memory banner) private pure {
        console2.log("=== arcpad governance ===");
        console2.log(banner);
        console2.log("threshold           ", SAFE_THRESHOLD);
        console2.log("owners              ", owners.length);
        for (uint256 i = 0; i < owners.length; ++i) {
            console2.log("  owner", i, owners[i]);
        }
        console2.log("singleton (SafeL2)  ", SAFE_L2_SINGLETON);
        console2.log("proxy factory       ", SAFE_PROXY_FACTORY);
        console2.log("fallback handler    ", SAFE_FALLBACK_HANDLER);
        console2.log("GOVERNOR ADDRESS    ", governor);
        console2.log("TREASURY ADDRESS    ", treasury);
    }
}
