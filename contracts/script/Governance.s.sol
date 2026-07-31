// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {DeployLib} from "./DeployLib.sol";
import {Profile, Profiles} from "./Profiles.sol";

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
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
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

    // ---------------------------------------------------------------
    // The signing ceremony
    // ---------------------------------------------------------------
    //
    // NICIN BU BLOK TASK 6'DAN ONCE GELMEK ZORUNDA. `LaunchFactory` deploy
    // edildigi anda governor Safe, `graduationTarget`a dokunmanin TEK yolu
    // olur -- ve Faz 2 curve'u pool'a yoneltmek icin TAM OLARAK o cagriyi
    // gerektirir. Toren calismiyorsa, KALICI bir adreste KIMSENIN
    // YONETEMEYECEGI bir factory deploy etmis oluruz; kurtarma yolu her seyi
    // yeniden deploy edip adresleri terk etmekten ibarettir.
    //
    // Bu yuzden toren GERCEK zincirde, GERCEK anahtarlarla, ATILABILIR bir
    // hedefe karsi prova edilir -- ve YANLIS durumlar da kanitlanir: yanlis
    // sebeple calisiyor gorunen bir toren, hic olmamasindan kotudur.

    /// @dev EIP-712. Sabitler ELLE TURETILDI ve zincire karsi CAPRAZ
    ///      KONTROL EDILIR (`_safeTxHash` yerel hesabi Safe'in kendi
    ///      `getTransactionHash`'i ile karsilastirir): typehash'i yanlis
    ///      yazmak sessizce imzalanamaz bir hash uretirdi.
    ///        keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")
    bytes32 internal constant SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;
    ///        keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
    bytes32 internal constant SAFE_DOMAIN_TYPEHASH = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;

    /// @dev PROVA YIGININ SALT'LARI GERCEKLERDEN AYRIDIR VE OYLE OLMAK
    ///      ZORUNDADIR. `Deploy.s.sol`un `FACTORY_SALT`i bir SABITTIR ve oyle
    ///      kalmalidir: salt argumani kabul eden bir deploy script'i, her yere
    ///      yoneltilebilen bir deploy script'idir. Prova yigini bu yuzden
    ///      `DeployLib.deploy`i KENDI salt'lariyla dogrudan cagirir ve
    ///      ADRES DEFTERINE ASLA GIRMEZ.
    bytes32 internal constant REHEARSAL_ESCROW_SALT = keccak256("arcpad.FeeEscrow.rehearsal");
    bytes32 internal constant REHEARSAL_FACTORY_SALT = keccak256("arcpad.LaunchFactory.rehearsal");

    error SafeDeploymentMissing(string what, address at);
    error SafeTxHashDiverged(bytes32 local, bytes32 onchain);
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

    // ---------------------------------------------------------------
    // Ceremony: build the payload, execute the bundle
    // ---------------------------------------------------------------

    /// @notice Governor Safe'in bir cagriyi imzalamasi icin gereken EIP-712
    ///         hash'i ve gonderilecek IC calldata.
    ///
    /// @dev PLANDAN SAPMA, GEREKCESIYLE. Plan bunlari `encodeProposeTarget(address)`
    ///      diye, hedef factory ORTUK olacak sekilde tarif ediyor. Factory
    ///      adresi acikca gecirilir, cunku torenin ATILABILIR bir factory'ye
    ///      karsi prova edilebilmesi gerekir; gercek factory'yi sabitlemek
    ///      provayi -- yani bu blogun VAROLMA SEBEBINI -- imkansiz kilardi.
    function encodeProposeTarget(address factory, address target)
        public
        view
        returns (bytes32 safeTxHash, bytes memory txData, uint256 nonce)
    {
        txData = abi.encodeCall(LaunchFactory.proposeGraduationTarget, (target));
        (safeTxHash, nonce) = _safeTxHash(_governorSafe(), factory, txData);
        _printTx("proposeGraduationTarget", factory, target, safeTxHash, nonce, txData);
    }

    function encodeRotateTreasury(address factory, address next)
        public
        view
        returns (bytes32 safeTxHash, bytes memory txData, uint256 nonce)
    {
        txData = abi.encodeCall(LaunchFactory.setProtocolTreasury, (next));
        (safeTxHash, nonce) = _safeTxHash(_governorSafe(), factory, txData);
        _printTx("setProtocolTreasury", factory, next, safeTxHash, nonce, txData);
    }

    /// @notice Imza demetini governor Safe'e gonderir.
    /// @param signatures 65 baytlik imzalarin bitisik hali, OWNER ADRESINE
    ///        GORE ARTAN SIRADA. Safe bunu zorunlu kilar: sirasiz bir demet
    ///        `GS026` ile doner.
    function executeFromGovernor(address to, bytes memory txData, bytes memory signatures) public {
        address safe = _governorSafe();
        vm.startBroadcast();
        bool ok = ISafe(safe).execTransaction(to, 0, txData, 0, 0, 0, 0, address(0), payable(address(0)), signatures);
        vm.stopBroadcast();
        require(ok, "execTransaction returned false");
        console2.log("executed from the governor Safe", safe);
    }

    /// @dev YEREL HESAP + ZINCIR CAPRAZ KONTROLU. Yalnizca Safe'e sormak
    ///      calisirdi, ama o zaman typehash'lerimizin dogru oldugunu HICBIR
    ///      SEY olcmezdi; yalnizca yerel hesaplamak da calisirdi, ama o zaman
    ///      Safe'in gercekten ayni seyi bekledigini hicbir sey olcmezdi.
    ///      Ikisi birden, birbirini olcer.
    function _safeTxHash(address safe, address to, bytes memory data)
        internal
        view
        returns (bytes32 hash, uint256 nonce)
    {
        nonce = ISafe(safe).nonce();

        bytes32 domainSeparator = keccak256(abi.encode(SAFE_DOMAIN_TYPEHASH, block.chainid, safe));
        bytes32 structHash = keccak256(
            abi.encode(
                SAFE_TX_TYPEHASH,
                to,
                uint256(0), // value
                keccak256(data),
                uint8(0), // operation = CALL
                uint256(0), // safeTxGas
                uint256(0), // baseGas
                uint256(0), // gasPrice
                address(0), // gasToken
                address(0), // refundReceiver
                nonce
            )
        );
        hash = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));

        bytes32 onchain = ISafe(safe).getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), nonce);
        if (hash != onchain) revert SafeTxHashDiverged(hash, onchain);
    }

    function _governorSafe() internal view returns (address governor) {
        (governor,) = Profiles.governanceForChain(block.chainid);
    }

    // ---------------------------------------------------------------
    // The disposable rehearsal stack
    // ---------------------------------------------------------------

    /// @notice Torenin uzerinde prova edildigi ATILABILIR yigin.
    ///
    /// @dev Prova factory'sinin governor'i governor Safe'tir -- mesele budur.
    ///      Treasury'si de BASLANGICTA governor Safe'tir, boylece toren onu
    ///      treasury Safe'e cevirebilir ve degisiklik ZINCIRDE GOZLENEBILIR
    ///      olur. `LaunchFactory` `governor == protocolTreasury`i acikca kabul
    ///      eder; bu factory adres defterine hic girmedigi icin defterin
    ///      takma-ad kontrolu onu hic gormez.
    ///
    /// @dev AYRI BIR ESCROW da deploy edilir. Gercek escrow'u kullanmak onun
    ///      adresini TUKETIRDI ve Task 6'nin `AlreadyDeployed` on-kontrolunu
    ///      tetiklerdi; provanin gercek deploy'un onune gecmesi yasaktir.
    function rehearsalAddresses() public view returns (address escrow, address factory) {
        Profile memory p = Profiles.forChain(block.chainid);
        (address governor,) = Profiles.governanceForChain(block.chainid);

        bytes memory escrowInitcode = type(FeeEscrow).creationCode;
        escrow = _predictWithSalt(REHEARSAL_ESCROW_SALT, escrowInitcode);

        bytes memory factoryInitcode = abi.encodePacked(
            type(LaunchFactory).creationCode,
            abi.encode(escrow, governor, governor, p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply)
        );
        factory = _predictWithSalt(REHEARSAL_FACTORY_SALT, factoryInitcode);
    }

    function deployRehearsalStack() public returns (address escrow, address factory) {
        Profile memory p = Profiles.forChain(block.chainid);
        (address governor,) = Profiles.governanceForChain(block.chainid);

        bytes memory escrowInitcode = type(FeeEscrow).creationCode;
        bytes memory factoryInitcode;

        vm.startBroadcast();
        escrow = _predictWithSalt(REHEARSAL_ESCROW_SALT, escrowInitcode);
        if (escrow.code.length == 0) escrow = DeployLib.deploy(REHEARSAL_ESCROW_SALT, escrowInitcode);

        factoryInitcode = abi.encodePacked(
            type(LaunchFactory).creationCode,
            abi.encode(escrow, governor, governor, p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply)
        );
        factory = _predictWithSalt(REHEARSAL_FACTORY_SALT, factoryInitcode);
        if (factory.code.length == 0) factory = DeployLib.deploy(REHEARSAL_FACTORY_SALT, factoryInitcode);
        vm.stopBroadcast();

        console2.log("REHEARSAL escrow ", escrow);
        console2.log("REHEARSAL factory", factory);
        console2.log("governor         ", LaunchFactory(factory).governor());
        console2.log("protocolTreasury ", LaunchFactory(factory).protocolTreasury());
        console2.log("NOT IN THE ADDRESS BOOK. Disposable. Different salt from the real one.");
    }

    function _predictWithSalt(bytes32 salt, bytes memory initcode) private pure returns (address) {
        return DeployLib.predict(salt, initcode);
    }

    function _printTx(
        string memory what,
        address to,
        address argument,
        bytes32 safeTxHash,
        uint256 nonce,
        bytes memory txData
    ) private pure {
        console2.log("=== arcpad governance tx ===");
        console2.log("call                ", what);
        console2.log("to (factory)        ", to);
        console2.log("argument            ", argument);
        console2.log("safe nonce          ", nonce);
        console2.log("SAFE TX HASH        ", vm.toString(safeTxHash));
        console2.log("inner calldata      ", vm.toString(txData));
        console2.log("-- each owner signs the SAFE TX HASH with: cast wallet sign --no-hash <hash>");
        console2.log("-- concatenate 65-byte signatures ORDERED BY OWNER ADDRESS ASCENDING");
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
