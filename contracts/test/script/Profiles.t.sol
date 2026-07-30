// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Profile, Profiles} from "../../script/Profiles.sol";

/// @title ProfilesTest
/// @notice ZINCIR -> PROFIL baginin ve digest'in testi.
/// @dev Bu dosya `src/` altindan HICBIR SEY import etmez, cunku olctugu sey de
///      etmez. Mutant basina kosu ~2 saniyedir; P1-P11 bu yuzden ucuzdur.
contract ProfilesTest is Test {
    // ELLE YAZILDI; dosyadan OKUNMAZ. Zincir: TOML <- sabit <- bu literaller.
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V_TESTNET = 4_292e15;
    uint256 internal constant V_PRODUCTION = 4_292e18;
    uint256 internal constant S = 793_100_000e18;

    function test_arcTestnetResolvesToTheTestnetProfile() public view {
        Profile memory p = Profiles.forChain(5042002);
        assertEq(p.name, "testnet");
        assertEq(p.virtualTokenReserves, 1_073_000_000_000_000_000_000_000_000);
        assertEq(p.virtualQuoteReserves, 4_292_000_000_000_000_000);
        assertEq(p.saleSupply, 793_100_000_000_000_000_000_000_000);
    }

    function test_localRehearsalResolvesToTheSameNumbersAsArcTestnet() public view {
        Profile memory a = Profiles.forChain(5042002);
        Profile memory b = Profiles.forChain(31337);
        assertEq(a.virtualQuoteReserves, b.virtualQuoteReserves);
        assertEq(keccak256(bytes(a.name)), keccak256(bytes(b.name)));
    }

    /// ULASIM OLCULDU, VARSAYILMADI: yakin ikizler TEK TEK yurunur. `5042`
    /// ucuncu taraflarin andigi mainnet id'sidir ve BUGUN REVERT ETMELIDIR --
    /// mainnet deploy'unu incelenmis bir commit'e baglayan satir budur.
    function test_everyNearMissChainIdReverts() public {
        uint256[9] memory ids = [uint256(0), 1, 5042, 5042001, 5042003, 8453, 31338, 42161, type(uint256).max];
        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(Profiles.UnregisteredChain.selector, ids[i]));
            this.nameFor(ids[i]);
        }
    }

    function testFuzz_onlyTheTwoRegisteredChainIdsResolve(uint256 chainId) public {
        vm.assume(chainId != 5042002 && chainId != 31337);
        vm.expectRevert(abi.encodeWithSelector(Profiles.UnregisteredChain.selector, chainId));
        this.nameFor(chainId);
    }

    // --- chainKeyFor: AYRI BIR GIRIS NOKTASI, AYRI KAPSAM ---
    //
    // BU UC TEST BRIEF'TE YOKTU VE OLCUM SONUCU EKLENDI. Brief'in P1-P11
    // mutant kumesi `chainKeyFor`a HIC DOKUNMUYOR; iki anahtari takas eden bir
    // mutant (P12) 362 testin TAMAMINI yesil biraktu, `digestFor`in
    // `UnknownProfileName` revert'ini kaldiran bir mutant (P13) da oyle.
    // "Bir ozelligin bir giris noktasinda kapanmis olmasi HEPSINDE kapandigi
    // anlamina gelmez": yakin-ikiz taramasi `nameForChain` icin vardi,
    // KARDESI `chainKeyFor` icin yoktu.

    function test_eachChainCarriesItsOwnGovernanceKey() public pure {
        assertEq(Profiles.chainKeyFor(5042002), "arc-testnet");
        assertEq(Profiles.chainKeyFor(31337), "local-rehearsal");
    }

    /// `chainKeyFor`in VAROLMA SEBEBI: profil adi ORTAK, governance anahtari
    /// AYRI. Ikisinin ayrildigini olcmeyen bir test, anahtari profil adina
    /// baglayan bir refactor'u gecirirdi.
    function test_theGovernanceKeyIsNotTheProfileName() public pure {
        assertEq(
            keccak256(bytes(Profiles.nameForChain(5042002))),
            keccak256(bytes(Profiles.nameForChain(31337))),
            "the two chains must share one profile name"
        );
        assertTrue(
            keccak256(bytes(Profiles.chainKeyFor(5042002))) != keccak256(bytes(Profiles.chainKeyFor(31337))),
            "the two chains must NOT share one governance key"
        );
    }

    /// `nameForChain`in yakin-ikiz taramasinin AYNISI, KARDES giris noktasinda.
    function test_everyNearMissChainIdRevertsForTheGovernanceKeyToo() public {
        uint256[9] memory ids = [uint256(0), 1, 5042, 5042001, 5042003, 8453, 31338, 42161, type(uint256).max];
        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(Profiles.UnregisteredChain.selector, ids[i]));
            this.chainKeyFor(ids[i]);
        }
    }

    /// KAYITSIZ BIR PROFIL ADININ DIGEST'I YOKTUR. `digestFor`in fail-open
    /// hale gelmesi (bilinmeyen ada testnet digest'i vermesi) her adi
    /// deploy edilebilir kilardi.
    function test_anUnknownProfileNameHasNoDigest() public {
        string[4] memory unknown = ["staging", "Testnet", "", "production "];
        for (uint256 i = 0; i < unknown.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(Profiles.UnknownProfileName.selector, unknown[i]));
            this.digestFor(unknown[i]);
        }
    }

    /// URETIM PROFILI KAYITLI AMA HICBIR ZINCIRDEN ULASILAMAZ.
    function test_noChainIdResolvesToTheProductionProfile() public pure {
        assertEq(Profiles.digestFor("production"), Profiles.PRODUCTION_DIGEST);
        uint256[2] memory registered = [uint256(5042002), 31337];
        for (uint256 i = 0; i < registered.length; ++i) {
            assertTrue(
                keccak256(bytes(Profiles.nameForChain(registered[i]))) != keccak256("production"),
                "a registered chain resolved to the production profile"
            );
        }
    }

    /// TOTOLOJI KIRICI: digest dosyadan degil ELLE YAZILMIS ucluden turetilir.
    function test_digestIsTheHashOfTheHandWrittenTriple() public pure {
        assertEq(keccak256(abi.encode(T, V_TESTNET, S)), Profiles.TESTNET_DIGEST);
        assertEq(keccak256(abi.encode(T, V_PRODUCTION, S)), Profiles.PRODUCTION_DIGEST);
    }

    /// Digest'in AYIRDIGI SEY tam olarak korktugumuz hatadir.
    function test_theDigestSeparatesTheTwoMagnitudes() public pure {
        assertTrue(Profiles.TESTNET_DIGEST != Profiles.PRODUCTION_DIGEST);
        assertEq(V_PRODUCTION / V_TESTNET, 1000);
    }

    /// H3'un TA KENDISI, gercek bir dosyayla yurunur.
    function test_aSlippedExponentIsRejectedByTheDigest() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                Profiles.ProfileDigestMismatch.selector,
                "testnet",
                Profiles.TESTNET_DIGEST,
                keccak256(abi.encode(T, V_PRODUCTION, S))
            )
        );
        this.readFrom("deploy/testdata/slipped-testnet.toml", "testnet");
    }

    // --- fs_permissions kapisi: UC IDDIA, ucuncusu GENISLEME icin ---

    function test_theArtifactGrantSurvived() public view {
        assertGt(
            bytes(vm.readFile("out/FeeEscrow.sol/FeeEscrow.json")).length,
            0,
            "./out grant lost -- Surface.t.sol is the next thing to fall"
        );
    }

    function test_theDeployGrantExists() public view {
        assertGt(bytes(vm.readFile("deploy/profiles.toml")).length, 0, "./deploy grant missing");
    }

    /// @dev `view`, cunku govdesi bir staticcall'dan ibarettir. `readSrc`
    ///      IZINSIZ oldugu icin degil, IZIN VERILDIGINDE GECTIGI olculdugu icin
    ///      anlamlidir: P10 (`fs_permissions`e `./src` eklemek) bu testi -- ve
    ///      YALNIZCA bunu -- kirmizilastirir. Yani `ok == false` gozlemi
    ///      bosluktan degil, reddedilen okumadan gelir.
    function test_theGrantDidNotWiden() public view {
        (bool ok,) = address(this).staticcall(abi.encodeCall(this.readSrc, ()));
        assertFalse(ok, "src/ became readable -- fs_permissions widened beyond {out, deploy}");
    }

    // Revert'i yakalayabilmek icin cagrilar DISARIDAN gider.
    function nameFor(uint256 chainId) external pure returns (string memory) {
        return Profiles.nameForChain(chainId);
    }

    function chainKeyFor(uint256 chainId) external pure returns (string memory) {
        return Profiles.chainKeyFor(chainId);
    }

    function digestFor(string calldata n) external pure returns (bytes32) {
        return Profiles.digestFor(n);
    }

    function readFrom(string calldata p, string calldata n) external view returns (Profile memory) {
        return Profiles.readFrom(p, n);
    }

    function readSrc() external view returns (string memory) {
        return vm.readFile("src/FeeEscrow.sol");
    }
}
