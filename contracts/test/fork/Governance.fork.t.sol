// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployLib, Plan} from "../../script/DeployLib.sol";
import {Governance, ISafe} from "../../script/Governance.s.sol";
import {Profile, Profiles} from "../../script/Profiles.sol";

/// @title GovernanceForkTest
/// @notice Task 4'un bugunku OLCUMLERINI kalici bir KAPIYA cevirir.
///
/// @dev NICIN FORK. Bu dosyadaki her iddia UZAK ZINCIR DURUMU hakkindadir --
///      Safe deployment'inin orada olmasi, iki Safe'in gercekten 2-of-3
///      olmasi, tahmin edilen adreslerin GERCEKTEN deploy edilmis olanlarla
///      ayni olmasi. Fork'suz bir testte bunlarin hicbiri olculemez; ancak
///      fixture'in kendi uydurdugu bir cevap olculebilirdi.
///
/// @dev UZUNLUKLAR `> 0` ILE OLCULUR, ESITLIKLE DEGIL. Bugunku olcumler
///      (proxy factory 3054, SafeL2 24421, Safe 23579, fallback handler 5637,
///      MultiSend 629) belgedir; bir Safe yama surumu esitlik kontrolunu
///      hicbir guvenlik sebebi olmadan kirmis olurdu. Onemli olan tek
///      basarisizlik SIFIRDIR.
contract GovernanceForkTest is Test {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address internal constant SAFE_MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;

    address internal constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// Task 4'te CANLI deploy edilenler. ELLE YAZILDI.
    address internal constant GOVERNOR_SAFE = 0x970534698e4592932F31892759147f79EB0D2C22;
    address internal constant TREASURY_SAFE = 0xebBeCfDA308EA307e173C6eC19a9C48F53d4B10c;

    address internal constant DEPLOYER = 0xe92c64C4f36216eA773f2622f6D5f8530Ae92fD2;

    Governance internal governance;

    function setUp() public {
        governance = new Governance();
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "this suite is meaningless off Arc testnet");
    }

    function test_theSafeDeploymentIsPresentOnArc() public view {
        assertGt(SAFE_PROXY_FACTORY.code.length, 0, "SafeProxyFactory missing");
        assertGt(SAFE_L2_SINGLETON.code.length, 0, "SafeL2 singleton missing");
        assertGt(SAFE_SINGLETON.code.length, 0, "Safe singleton missing");
        assertGt(SAFE_FALLBACK_HANDLER.code.length, 0, "CompatibilityFallbackHandler missing");
        assertGt(SAFE_MULTISEND.code.length, 0, "MultiSend missing");
    }

    /// Faz 0'in probe'larini ILERI TASIR: deploy'un bagimliliklari VARSAYILMAZ,
    /// KAPIYA baglanir.
    function test_theCreate2DeployerAndPredeploysArePresent() public view {
        assertEq(DeployLib.CREATE2_FACTORY.code.length, 69, "CREATE2 deployer is not the canonical 69 bytes");
        assertEq(
            DeployLib.CREATE2_FACTORY.codehash,
            DeployLib.CREATE2_FACTORY_CODEHASH,
            "CREATE2 deployer is not the CANONICAL one -- every predicted address depends on this"
        );
        assertGt(USDC_ERC20.code.length, 0, "USDC ERC-20 view missing");
        assertGt(MULTICALL3.code.length, 0, "Multicall3 missing");
        assertGt(PERMIT2.code.length, 0, "Permit2 missing");
    }

    /// TAHMIN = GERCEK. `predictSafes()` zincirden `proxyCreationCode()`
    /// okuyarak turetir; bu test o turetmenin DEPLOY EDILMIS olanla ayni
    /// oldugunu soyler -- yani Task 6'nin factory adresi de dogru turetilmis
    /// demektir, cunku ayni iki adresi arguman olarak aliyor.
    function test_thePredictedSafeAddressesMatchTheDeployedOnes() public view {
        (address governor, address treasury) = governance.predictSafes();
        assertEq(governor, GOVERNOR_SAFE, "governor prediction diverged from the deployed Safe");
        assertEq(treasury, TREASURY_SAFE, "treasury prediction diverged from the deployed Safe");
    }

    /// ...VE governance dosyasi da ayni iki adresi tasiyor. Digest'i Solidity
    /// tarafinda tutan sey `Profiles.governanceForChain`; bu test onu ZINCIRE
    /// baglar.
    function test_theGovernanceFileNamesTheDeployedSafes() public view {
        (address governor, address treasury) = Profiles.governanceForChain(ARC_TESTNET_CHAIN_ID);
        assertEq(governor, GOVERNOR_SAFE);
        assertEq(treasury, TREASURY_SAFE);
        assertGt(governor.code.length, 0, "the governance file names an address with no code on Arc");
        assertGt(treasury.code.length, 0, "the governance file names an address with no code on Arc");
    }

    function test_bothSafesAreTwoOfThreeOrStricter() public view {
        _assertSafeIsAtLeastTwoOfThree(GOVERNOR_SAFE, "governor");
        _assertSafeIsAtLeastTwoOfThree(TREASURY_SAFE, "treasury");
    }

    function _assertSafeIsAtLeastTwoOfThree(address safe, string memory role) internal view {
        assertGe(ISafe(safe).getThreshold(), 2, string.concat(role, ": threshold below 2"));
        assertGe(ISafe(safe).getOwners().length, 3, string.concat(role, ": fewer than 3 owners"));
    }

    function test_theTwoSafesAreDistinct() public pure {
        assertTrue(GOVERNOR_SAFE != TREASURY_SAFE, "authority and revenue must not be the same Safe");
    }

    /// @dev BU TESTIN ASIL ICERIGI: deploy eden EOA, deploy ettigi seyin
    ///      uzerinde HICBIR yetki tutmuyor. Task 6'dan sonra factory'nin
    ///      governor'i bu Safe olacak; deployer o Safe'in owner'i DEGILSE,
    ///      deployer anahtarinin ele gecirilmesi protokolu ele gecirmez.
    function test_theDeployerIsNotAnOwnerAndCannotReachTheThresholdAlone() public view {
        address[] memory owners = ISafe(GOVERNOR_SAFE).getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            assertTrue(owners[i] != DEPLOYER, "the deploying EOA is an owner of the governor Safe");
        }
        // Bir owner OLSAYDI bile tek basina esige ulasamazdi; esik >= 2.
        assertGe(ISafe(GOVERNOR_SAFE).getThreshold(), 2, "one signature must never be enough");
    }

    /// @dev TASK 6'NIN ON KOSULU, ZINCIRDE OLCULUR. `plan()`in yaptigi her
    ///      seyi tekrarlamaz; yalnizca deploy edilecek IKI ADRESIN hala BOS
    ///      oldugunu soyler. Dolu bir adres, ya deploy'un zaten yapildigi ya
    ///      da bir adres carpismasi demektir -- ikisi de Task 6'yi
    ///      durdurmalidir.
    function test_theTargetAddressesAreStillFree() public view {
        Profile memory profile = Profiles.forChain(ARC_TESTNET_CHAIN_ID);
        (address governor, address treasury) = Profiles.governanceForChain(ARC_TESTNET_CHAIN_ID);
        Plan memory p = DeployLib.build(ARC_TESTNET_CHAIN_ID, profile, DEPLOYER, governor, treasury);

        assertEq(p.escrow.code.length, 0, "the escrow address is already occupied on Arc");
        assertEq(p.factory.code.length, 0, "the factory address is already occupied on Arc");
    }

    /// @dev ADRES DEFTERININ HENUZ OLMAYAN GIRISININ ONCEDEN OLCULMESI.
    ///      Task 6 bu adresi deftere yazacak; burada onu ZINCIRDEN turetip
    ///      pinliyoruz ki Task 6 bir DEGER kopyalamasin, bir OLCUMU
    ///      dogrulasin.
    function test_theFactoryAddressTheSafesDetermine() public view {
        Profile memory profile = Profiles.forChain(ARC_TESTNET_CHAIN_ID);
        (address governor, address treasury) = Profiles.governanceForChain(ARC_TESTNET_CHAIN_ID);
        Plan memory p = DeployLib.build(ARC_TESTNET_CHAIN_ID, profile, DEPLOYER, governor, treasury);

        assertEq(p.escrow, 0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6, "escrow address moved");
        assertEq(p.factory, 0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439, "factory address moved");
    }
}
