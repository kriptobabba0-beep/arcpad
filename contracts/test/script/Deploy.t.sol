// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployLib, ISafeProbe, Plan} from "../../script/DeployLib.sol";
import {Profile, Profiles} from "../../script/Profiles.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";

/// @dev Safe'in yoklanan iki uyesi. `_owners` DINAMIK BIR DIZIDIR ve bu
///      kasithdir: fixture'in kendisi `vm.etch`in storage'i tasimadigi tuzagina
///      dusebilsin diye degil, DUSMEDIGI OLCULEBILSIN diye.
contract SafeStub {
    uint256 private immutable _threshold;
    address[] private _owners;

    constructor(uint256 threshold_, uint256 ownerCount) {
        _threshold = threshold_;
        for (uint256 i; i < ownerCount; ++i) {
            _owners.push(address(uint160(i + 1)));
        }
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }
}

/// @dev KODU OLAN ama Safe OLMAYAN bir adres. EOA'dan AYRI BIR SINIFTIR ve
///      `_assertMultisig` icinde AYRI BIR KOLA duser: burada `try` gercekten
///      cagri yapar ve `catch` calisir; kodsuz adreste ise extcodesize
///      kontrolu `catch`e hic ulasmadan revert eder.
contract NotASafe {
    uint256 public x;
}

/// @title DeployTest
/// @notice Deploy script'inin TAMAMI in-EVM provasi.
///
/// @dev `vm.etch` SECIMI ACIKCA YAZILIYOR, cunku plan iki secenek birakip
///      "hangisi oldugunu soyle" diyor:
///
///      (1) CREATE2 deployer icin `vm.etch` KULLANILIR. Mesrudur ve tuzaksizdir:
///          o runtime SAF KODDUR, tek bir storage slot'u yoktur, dolayisiyla
///          "etch storage tasimaz" sorunu ONA UYGULANMAZ. `setUp` uzunlugu
///          olculen 69 bayta pinler ki fixture sessizce curumesin.
///
///      (2) SAFE STUB'LARI icin `vm.etch` KULLANILMAZ. `deployCodeTo` kullanilir,
///          cunku o creation code'u HEDEF ADRESTE calistirir -- yani
///          constructor'in `_owners.push` yazmalari HEDEFIN storage'ina duser.
///          Ciplak `vm.etch(GOVERNOR, address(new SafeStub(2,3)).code)` ise
///          YALNIZCA runtime'i kopyalar; `_owners` BOS gelirdi, `getOwners()`
///          sifir uzunluk dondururdu ve `MIN_SAFE_OWNERS` BOSA DUSERDU --
///          `test_aTwoOfTwoSafeCannotBeDeployed` yesil kalirken hicbir sey
///          olcmezdi. Faz 1c'nin `metadataURI` bulgusunun aynisi.
///          `setUp` yine de `getOwners().length == 3` iddiasini KOYAR: secim
///          dogru olsa bile iddia, secimin dogru KALDIGINI olcen seydir.
contract DeployTest is Test {
    /// @dev Olculen 69 baytlik kanonik deterministik deployer runtime'i.
    bytes internal constant CREATE2_deployer_RUNTIME = hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0"
        hex"3601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    // deploy/expected-governance.json -> local-rehearsal
    address internal constant GOVERNOR = 0x0000000000000000000000000000000000000601;
    address internal constant TREASURY = 0x0000000000000000000000000000000000007EA5;

    /// @dev deployer TEST KONTRATININ KENDISIDIR VE BU BIR SECIM DEGIL,
    ///      OLCULMUS BIR KISITTIR. `_resolve()` `msg.sender` okur; ayri bir
    ///      adres gostermenin tek yolu `vm.prank`tir; ve `run()` icindeki
    ///      `vm.startBroadcast` bir prank ACIKKEN
    ///        "vm.startBroadcast: you have an active prank; broadcasting and
    ///         pranks are not compatible"
    ///      ile revert eder (olculdu: prank cagri DONENE KADAR acik kalir,
    ///      yani `script.run()`u pranklamak `startBroadcast`i her seferinde
    ///      kirar). Script'i test edilebilir kilmak icin degistirmek YANLIS
    ///      olurdu -- `msg.sender` canli kosuda tam olarak dogru olan seydir --
    ///      bu yuzden fixture uyum saglar. `theDeployerHoldsNoAuthority`
    ///      iddialari bundan ZARAR GORMEZ: cagri zaten deployer'dan gider.
    address internal deployer;

    uint256 internal constant ARC_TESTNET = 5042002;
    uint256 internal constant LOCAL_REHEARSAL = 31337;

    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V_TESTNET = 4_292e15;
    uint256 internal constant V_PRODUCTION = 4_292e18;
    uint256 internal constant S = 793_100_000e18;

    Deploy internal script;

    function setUp() public {
        script = new Deploy();

        vm.etch(DeployLib.CREATE2_FACTORY, CREATE2_deployer_RUNTIME);
        assertEq(DeployLib.CREATE2_FACTORY.code.length, 69, "etched deployer is not the measured 69 bytes");

        _installSafe(GOVERNOR, 2, 3);
        _installSafe(TREASURY, 2, 3);

        // FIXTURE CURUMESINE KARSI. Bu iddia olmadan bos bir `_owners`
        // MIN_SAFE_OWNERS'i sessizce bosa dusururdu.
        assertEq(ISafeProbe(GOVERNOR).getOwners().length, 3, "governor stub lost its owners array");
        assertEq(ISafeProbe(TREASURY).getOwners().length, 3, "treasury stub lost its owners array");
        assertEq(ISafeProbe(GOVERNOR).getThreshold(), 2, "governor stub lost its threshold");

        deployer = address(this);
        vm.deal(deployer, 1 ether);
        vm.chainId(LOCAL_REHEARSAL);
    }

    /// @dev `vm.etch` DEGIL, `deployCodeTo`. Gerekcesi kontrat NatSpec'inde.
    ///
    /// @dev SLOT 0 ELLE SIFIRLANIR VE BU SATIR BIR HATA AYIKLAMANIN SONUCUDUR.
    ///      `vm.etch` KODU degistirir, STORAGE'I DEGISTIRMEZ. `setUp` once
    ///      2-of-3 kurdugu icin `_owners` uzunlugu (slot 0) 3'te kalir; ayni
    ///      adrese 2-of-2 kurmak constructor'i YENIDEN calistirir ve iki
    ///      `push` daha yapar -- dizi 5 UYELI olur, `MIN_SAFE_OWNERS` gecer ve
    ///      `test_aTwoOfTwoSafeCannotBeDeployed` "revert bekleniyordu"
    ///      diyerek OLCULEBILIR bicimde kirilir. (`_threshold` immutable
    ///      oldugu icin KODDA durur ve bu sorundan etkilenmez; storage'daki
    ///      tek degisken `_owners`tir.)
    ///
    ///      TUZAGIN ASIL YUZU BUYDU: kirilma bu SIRAYLA gurultuluydu, ama ters
    ///      sirada (once 2-of-2, sonra 2-of-3) SESSIZ olurdu. Bu yuzden asil
    ///      duzeltme `vm.store` degil, ONDAN SONRAKI IKI IDDIADIR: her kurulum
    ///      ne istendiyse ONU verdigini KENDISI olcer, ve fixture bir daha
    ///      sessizce yalan soyleyemez.
    function _installSafe(address where, uint256 threshold, uint256 ownerCount) internal {
        vm.etch(where, "");
        vm.store(where, bytes32(uint256(0)), bytes32(uint256(0)));
        deployCodeTo("Deploy.t.sol:SafeStub", abi.encode(threshold, ownerCount), where);

        assertEq(ISafeProbe(where).getOwners().length, ownerCount, "stub installed with the wrong owner count");
        assertEq(ISafeProbe(where).getThreshold(), threshold, "stub installed with the wrong threshold");
    }

    function _profile(string memory name) internal view returns (Profile memory) {
        return Profiles.readFrom(Profiles.PROFILES_PATH, name);
    }

    // ---------------------------------------------------------------
    // plan(): the dry run
    // ---------------------------------------------------------------

    /// @dev PLANIN KENDI ICINDE CELISKISI. Task 2'nin test tablosu
    ///      `test_planOnArcTestnetResolvesTheTestnetProfile` icin
    ///      "`vm.chainId(5042002)`; `plan()` `name == "testnet"` DONDURUR"
    ///      diyor. Bu BUGUN IMKANSIZDIR ve ayni brief'in Adim 6'si bunu zaten
    ///      soyluyor: `expected-governance.json`in arc-testnet girisi Task
    ///      4'e kadar sifirdir ve sifir bir governor `NotAMultisig` ile
    ///      REDDEDILIR. Iki iddia ayni anda dogru olamaz.
    ///      Adim 6 kazanir (kapinin CANLI olmasi ozelligin ta kendisidir), ve
    ///      tablonun olcmek istedigi sey IKIYE AYRILIR:
    ///        - profil cozumu             -> bu test,
    ///        - governance kapisi         -> test_arcTestnetGovernanceIsStillUnfilled,
    ///        - `plan()`in tam ciktisi    -> test_planOnLocalRehearsalResolvesTheTestnetProfile.
    function test_theTestnetProfileIsWhatArcTestnetResolves() public view {
        Profile memory p = Profiles.forChain(ARC_TESTNET);
        assertEq(p.name, "testnet");
        assertEq(p.virtualQuoteReserves, 4_292_000_000_000_000_000);
    }

    /// @dev `view`, cunku `plan()` KURU KOSUDUR: hicbir sey yayinlamaz ve
    ///      hicbir durumu degistirmez. solc'un bunu dogrulamasi, "plan()
    ///      deploy etmez" iddiasinin DERLEYICI TARAFINDAN kontrol edilen
    ///      hali olur -- bir gun `plan()` yola bir yazma sokarsa bu satir
    ///      derlenmez.
    function test_planOnLocalRehearsalResolvesTheTestnetProfile() public view {
        Plan memory p = script.plan();
        assertEq(p.profile.name, "testnet");
        assertEq(p.profile.virtualQuoteReserves, 4_292_000_000_000_000_000);
        assertEq(p.chainId, LOCAL_REHEARSAL);
        assertEq(p.deployer, deployer);
        assertEq(p.governor, GOVERNOR);
        assertEq(p.treasury, TREASURY);
    }

    /// TASK 4'UN KAPISI CANLI MI. Sifir governor deploy edilemez, yani
    /// expected-governance.json YARIM BIRAKILAMAZ.
    function test_arcTestnetGovernanceIsStillUnfilled() public {
        vm.chainId(ARC_TESTNET);
        vm.expectRevert(abi.encodeWithSelector(DeployLib.NotAMultisig.selector, "governor", address(0)));
        script.plan();
    }

    function test_planRevertsOnAnUnregisteredChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Profiles.UnregisteredChain.selector, uint256(1)));
        script.plan();
    }

    /// AYNI OZELLIK, IKINCI GIRIS NOKTASI. `plan()`i olcmek `run()`u OLCMEZ:
    /// `run()`u kendi cozumune sahip kilan bir mutant (D12) yalnizca burada
    /// olur. Bu depodaki en cok tekrar eden kusur tam olarak budur.
    function test_runRevertsOnAnUnregisteredChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Profiles.UnregisteredChain.selector, uint256(1)));
        script.run();
    }

    /// VE UCUNCU BIR ORTAK OZELLIK: `run()` de `plan()` de AYNI Plan'i
    /// uretmelidir. Ikisinin cozumunu ayiran her mutant burada da olur.
    function test_planAndRunAgreeOnEveryAddress() public {
        Plan memory dry = script.plan();
        Plan memory wet = script.run();

        assertEq(dry.escrow, wet.escrow, "plan() and run() disagree about the escrow");
        assertEq(dry.factory, wet.factory, "plan() and run() disagree about the factory");
        assertEq(dry.governor, wet.governor, "plan() and run() disagree about the governor");
        assertEq(dry.treasury, wet.treasury, "plan() and run() disagree about the treasury");
        assertEq(dry.deployer, wet.deployer, "plan() and run() disagree about the deployer");
        assertEq(keccak256(dry.factoryInitcode), keccak256(wet.factoryInitcode), "initcode diverged");
        assertEq(dry.profile.virtualQuoteReserves, wet.profile.virtualQuoteReserves, "V diverged");
    }

    // ---------------------------------------------------------------
    // run(): the real thing
    // ---------------------------------------------------------------

    function test_runDeploysAtExactlyThePredictedAddresses() public {
        Plan memory p = script.run();

        assertGt(p.escrow.code.length, 0, "escrow has no code");
        assertGt(p.factory.code.length, 0, "factory has no code");

        // BAGIMSIZ YENIDEN TURETME: plan'in adresini plan'in adresiyle
        // karsilastirmak totoloji olurdu.
        assertEq(p.escrow, DeployLib.predict(keccak256("arcpad.FeeEscrow.v1"), p.escrowInitcode), "escrow address");
        assertEq(
            p.factory, DeployLib.predict(keccak256("arcpad.LaunchFactory.v1"), p.factoryInitcode), "factory address"
        );
    }

    function test_theDeployedFactoryHoldsTheResolvedProfile() public {
        Plan memory p = script.run();

        LaunchFactory f = LaunchFactory(p.factory);
        assertEq(f.VIRTUAL_TOKEN_RESERVES(), 1_073_000_000_000_000_000_000_000_000, "T");
        assertEq(f.VIRTUAL_QUOTE_RESERVES(), 4_292_000_000_000_000_000, "V");
        assertEq(f.SALE_SUPPLY(), 793_100_000_000_000_000_000_000_000, "S");
        assertEq(f.escrow(), p.escrow, "escrow");
        assertEq(f.governor(), GOVERNOR, "governor");
        assertEq(f.protocolTreasury(), TREASURY, "treasury");
    }

    function test_theGraduationTargetStartsUnset() public {
        Plan memory p = script.run();
        LaunchFactory f = LaunchFactory(p.factory);
        assertEq(f.graduationTarget(), address(0), "graduationTarget");
        assertEq(f.launchCount(), 0, "launchCount");
    }

    /// IKINCI KOSU IKINCI BIR EVREN URETMEZ -- ve HATA ADIYLA pinlenir, cunku
    /// on-kontrolu silmek yine revert ederdi (ama `Create2Failed` ile).
    function test_aSecondRunRevertsRatherThanMintingASecondUniverse() public {
        Plan memory p = script.run();

        vm.expectRevert(abi.encodeWithSelector(DeployLib.AlreadyDeployed.selector, "FeeEscrow", p.escrow));
        script.run();
    }

    /// `AlreadyDeployed`in IKINCI kolu. Escrow kontrolu her zaman once
    /// tetiklendigi icin factory kolu YUKARIDAKI testte ULASILMAZ; buraya
    /// ozel olarak ulasilir.
    function test_anOccupiedFactoryAddressIsAlsoRefused() public {
        Plan memory p = script.plan();

        vm.etch(p.factory, hex"6001600155");
        vm.expectRevert(abi.encodeWithSelector(DeployLib.AlreadyDeployed.selector, "LaunchFactory", p.factory));
        script.plan();
    }

    // ---------------------------------------------------------------
    // Address derivation
    // ---------------------------------------------------------------

    function test_theEscrowAddressIsChainIndependent() public view {
        Profile memory p = _profile("testnet");
        Plan memory a = DeployLib.build(ARC_TESTNET, p, deployer, GOVERNOR, TREASURY);
        Plan memory b = DeployLib.build(LOCAL_REHEARSAL, p, deployer, GOVERNOR, TREASURY);
        assertEq(a.escrow, b.escrow, "the escrow is the one chain-independent member of the book");
    }

    /// Duzeltme C-1 YURUTULEBILIR HALDE: CREATE2 ayni factory adresini
    /// testnet ve mainnet'te VERMEZ, cunku adres constructor argumanlarini
    /// icerir ve `V` iki profil arasinda 1000 kat farklidir.
    function test_theFactoryAddressMovesWithTheProfile() public view {
        Plan memory a = DeployLib.build(ARC_TESTNET, _profile("testnet"), deployer, GOVERNOR, TREASURY);
        Plan memory b = DeployLib.build(ARC_TESTNET, _profile("production"), deployer, GOVERNOR, TREASURY);
        assertTrue(a.factory != b.factory, "factory address did not move with the profile");
        assertEq(a.escrow, b.escrow, "the escrow must NOT move with the profile");
    }

    function test_theFactoryAddressMovesWithTheTreasury() public view {
        Profile memory p = _profile("testnet");
        Plan memory a = DeployLib.build(ARC_TESTNET, p, deployer, GOVERNOR, TREASURY);
        Plan memory b = DeployLib.build(ARC_TESTNET, p, deployer, GOVERNOR, address(0xBEEF));
        assertTrue(a.factory != b.factory, "the initial treasury is address-committing");
    }

    function test_theFactoryAddressMovesWithTheGovernor() public view {
        Profile memory p = _profile("testnet");
        Plan memory a = DeployLib.build(ARC_TESTNET, p, deployer, GOVERNOR, TREASURY);
        Plan memory b = DeployLib.build(ARC_TESTNET, p, deployer, address(0xBEEF), TREASURY);
        assertTrue(a.factory != b.factory, "the initial governor is address-committing");
    }

    // ---------------------------------------------------------------
    // The multisig gate -- BOTH roles, not just the governor
    // ---------------------------------------------------------------

    /// `run()` UZERINDEN yurunur, `assertDeployable` uzerinden DEGIL: iddiayi
    /// `run()` icinde atlayan bir mutant burada olmelidir.
    function test_anEoaGovernorCannotBeDeployed() public {
        vm.etch(GOVERNOR, "");
        vm.expectRevert(abi.encodeWithSelector(DeployLib.NotAMultisig.selector, "governor", GOVERNOR));
        script.run();
    }

    /// AYNI OZELLIK, KARDES ROL. Plan yalnizca governor'i yuruyordu; treasury
    /// kolunu silen bir mutant (D17) o kumede HAYATTA KALIRDI.
    function test_anEoaTreasuryCannotBeDeployed() public {
        vm.etch(TREASURY, "");
        vm.expectRevert(abi.encodeWithSelector(DeployLib.NotAMultisig.selector, "treasury", TREASURY));
        script.run();
    }

    /// KODU OLAN ama Safe OLMAYAN adres: `catch` kolunun GERCEKTEN calistigi
    /// tek sinif. Kodsuz adres bu kola HIC ULASMAZ (olculdu).
    function test_aContractThatIsNotASafeCannotBeDeployed() public {
        vm.etch(GOVERNOR, address(new NotASafe()).code);
        vm.expectRevert(abi.encodeWithSelector(DeployLib.NotAMultisig.selector, "governor", GOVERNOR));
        script.run();
    }

    function test_aOneOfNSafeCannotBeDeployed() public {
        _installSafe(GOVERNOR, 1, 3);
        vm.expectRevert(
            abi.encodeWithSelector(DeployLib.MultisigThresholdTooLow.selector, "governor", GOVERNOR, uint256(1))
        );
        script.run();
    }

    function test_aOneOfNTreasuryCannotBeDeployed() public {
        _installSafe(TREASURY, 1, 3);
        vm.expectRevert(
            abi.encodeWithSelector(DeployLib.MultisigThresholdTooLow.selector, "treasury", TREASURY, uint256(1))
        );
        script.run();
    }

    function test_aTwoOfTwoSafeCannotBeDeployed() public {
        _installSafe(GOVERNOR, 2, 2);
        vm.expectRevert(
            abi.encodeWithSelector(DeployLib.MultisigTooFewOwners.selector, "governor", GOVERNOR, uint256(2))
        );
        script.run();
    }

    function test_aTwoOfTwoTreasuryCannotBeDeployed() public {
        _installSafe(TREASURY, 2, 2);
        vm.expectRevert(
            abi.encodeWithSelector(DeployLib.MultisigTooFewOwners.selector, "treasury", TREASURY, uint256(2))
        );
        script.run();
    }

    /// SINIRIN IKI YANI DA.
    function test_aThreeOfThreeSafeIsAccepted() public {
        _installSafe(GOVERNOR, 3, 3);
        Plan memory p = script.run();
        assertEq(LaunchFactory(p.factory).governor(), GOVERNOR);
    }

    // ---------------------------------------------------------------
    // Deployer funding -- both sides of the bound
    // ---------------------------------------------------------------

    function test_anUnderfundedDeployerCannotDeploy() public {
        vm.deal(deployer, 0.5e18 - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployLib.InsufficientDeployerBalance.selector, deployer, uint256(0.5e18 - 1), uint256(0.5e18)
            )
        );
        script.run();

        // ...and EXACTLY the bound is accepted.
        vm.deal(deployer, 0.5e18);
        Plan memory p = script.run();
        assertGt(p.factory.code.length, 0, "0.5e18 exactly must be enough");
    }

    // ---------------------------------------------------------------
    // The deployer keeps nothing
    // ---------------------------------------------------------------

    function test_theDeployerHoldsNoAuthorityAfterwards() public {
        Plan memory p = script.run();
        LaunchFactory f = LaunchFactory(p.factory);

        assertTrue(f.governor() != deployer, "deployer kept the governor role");
        assertTrue(f.protocolTreasury() != deployer, "deployer kept the treasury role");

        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        f.proposeGraduationTarget(address(0xABCD));

        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        f.setProtocolTreasury(address(0xABCD));
    }

    // ---------------------------------------------------------------
    // The CREATE2 deployer itself
    // ---------------------------------------------------------------

    function test_theCreate2DeployerIsRequired() public {
        vm.etch(DeployLib.CREATE2_FACTORY, "");
        vm.expectRevert(
            abi.encodeWithSelector(DeployLib.Create2DeployerMissing.selector, DeployLib.CREATE2_FACTORY, uint256(0))
        );
        script.run();
    }

    /// D5'IN TANIGI, VE VAR OLMA SEBEBI OLCULDU. `deploy` icindeki `!ok`
    /// kolu, `ret.length != 20` koluyla BIRLIKTE yazilmistir; kanonik
    /// deterministik deployer basarisiz oldugunda BOS veriyle revert eder,
    /// yani `ret.length == 0` zaten yakalar ve `!ok` HICBIR ULASILABILIR
    /// yolda tek basina calismaz. Olculdu: `!ok`u silen mutant (D5) TAM
    /// SUITE'IN 394 TESTINI birden yesil biraktu.
    ///
    /// Bu tanik o kolu ULASILABILIR yapar: 69 bayt uzunlugunda (on-kontrolu
    /// gecer), `revert(0, 20)` yapan bir deployer -- yani BASARISIZ ama tam
    /// ADRES BOYUNDA veri donduren. `!ok` olmasaydi `address(0)` deploy
    /// edilmis SAYILIRDI.
    function test_aDeployerThatRevertsWithAnAddressSizedPayloadIsRejected() public {
        // PUSH1 0x14; PUSH1 0x00; REVERT  -> revert(offset=0, length=20)
        // ...then zero-padded to the 69 bytes the pre-flight demands.
        bytes memory stub = abi.encodePacked(hex"60146000fd", new bytes(64));
        vm.etch(DeployLib.CREATE2_FACTORY, stub);
        assertEq(DeployLib.CREATE2_FACTORY.code.length, 69, "witness must pass the length pre-flight");

        (bool ok, bytes memory ret) = DeployLib.CREATE2_FACTORY.call(abi.encodePacked(DeployLib.ESCROW_SALT));
        assertFalse(ok, "witness must FAIL");
        assertEq(ret.length, 20, "witness must fail with exactly 20 bytes, or it does not isolate !ok");

        vm.expectRevert(abi.encodeWithSelector(DeployLib.Create2Failed.selector, DeployLib.ESCROW_SALT));
        script.run();
    }

    /// D6'NIN TANIGI. 69 bayt STOP: on-kontrolden GECER (uzunluk dogru), ama
    /// adres DONDURMEZ. `ret.length != 20` kontrolu olmasa `address(0)`
    /// deploy edilmis sayilirdi.
    function test_aDeployerThatReturnsNoAddressIsRejected() public {
        vm.etch(DeployLib.CREATE2_FACTORY, new bytes(69));
        assertEq(DeployLib.CREATE2_FACTORY.code.length, 69, "witness must pass the length pre-flight");
        vm.expectRevert(abi.encodeWithSelector(DeployLib.Create2Failed.selector, DeployLib.ESCROW_SALT));
        script.run();
    }

    // ---------------------------------------------------------------
    // The transposed-argument class
    // ---------------------------------------------------------------

    /// ADI GERCEGI SOYLUYOR: bu guvenlik KAZA ESERIDIR. `T` ile `V` takas
    /// edilince `T = 4_292e15` olur, `S >= T` saglanir ve constructor
    /// `DegenerateProfile()` doner. BASKA bir profil ciftinde ayni takas
    /// GECERLI bir profil uretebilirdi; kemer bu yuzden `assertAsDeployed`tir.
    function test_swappingTandVFailsClosedToday() public {
        Profile memory p = _profile("testnet");
        Profile memory swapped = Profile({
            name: p.name,
            virtualTokenReserves: p.virtualQuoteReserves,
            virtualQuoteReserves: p.virtualTokenReserves,
            saleSupply: p.saleSupply
        });

        // (a) Kontrat katmani: SEBEP.
        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        this.constructFactory(swapped);

        // (b) Deploy katmani: SONUC. Deterministik deployer ic revert'i
        //     YUTAR, bu yuzden disari `Create2Failed` olarak cikar -- ama
        //     CIKAR, ve deploy OLMAZ.
        Plan memory plan = DeployLib.build(LOCAL_REHEARSAL, swapped, deployer, GOVERNOR, TREASURY);
        vm.expectRevert(abi.encodeWithSelector(DeployLib.Create2Failed.selector, DeployLib.FACTORY_SALT));
        this.deployPlanFactory(plan);
    }

    // --- external wrappers so expectRevert has a call boundary ---

    function constructFactory(Profile memory p) external returns (address) {
        return address(
            new LaunchFactory(
                _deployedEscrow(), TREASURY, GOVERNOR, p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply
            )
        );
    }

    function deployPlanFactory(Plan memory p) external returns (address) {
        DeployLib.deploy(p.escrowSalt, p.escrowInitcode);
        return DeployLib.deploy(p.factorySalt, p.factoryInitcode);
    }

    function _deployedEscrow() internal returns (address) {
        Profile memory p = _profile("testnet");
        Plan memory plan = DeployLib.build(LOCAL_REHEARSAL, p, deployer, GOVERNOR, TREASURY);
        if (plan.escrow.code.length == 0) DeployLib.deploy(plan.escrowSalt, plan.escrowInitcode);
        return plan.escrow;
    }
}
