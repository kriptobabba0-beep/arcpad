// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DeployLib} from "../../script/DeployLib.sol";
import {DeployPool} from "../../script/DeployPool.s.sol";
import {PoolDeployLib, PoolPlan} from "../../script/PoolDeployLib.sol";
import {Profile, Profiles} from "../../script/Profiles.sol";
import {ArcpadHook} from "../../src/ArcpadHook.sol";
import {ArcpadLocker} from "../../src/ArcpadLocker.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";

/// @title DeployPoolTest
/// @notice Havuz katmaninin adres ankrajlari ve pinleri -- ve script'in
///         KENDISI.
///
/// @dev NICIN BU DOSYA VAR. `ArcpadHook`un adresi bu depodaki en geri
///      donulemez sayidir: V4 izin kumesini adresin ALT 14 BITINDE kodlar
///      (`Hooks.ALL_HOOK_MASK`) ve o adres her `PoolKey`in bir ALANIDIR.
///      Ilk graduation'dan sonra ne hook degistirilebilir ne izinler.
///
/// @dev IKINCI SEBEP BIR INCELEME BULGUSUDUR: `DeployPool.s.sol` hicbir test
///      tarafindan ORNEKLENMIYORDU. `plan()`, `run()`, yayin SIRASI ve
///      `assertAsDeployed`in TAMAMI kosulmamis koddu -- `l.hook()`u
///      `p.poolManager` ile karsilastiran ve `PoolManager` sahiplik
///      kontrolunu tersine ceviren bir mutant 607/607 HAYATTA KALIYORDU.
///      Geri donulemez isi yapan tek dosya, kapsami olmayan tek dosyaydi.
contract DeployPoolTest is Test {
    /// @dev Olculen 69 baytlik kanonik deterministik deployer runtime'i --
    ///      `Deploy.t.sol`daki literalin aynisi. Gereken sey uzunluk degil
    ///      KIMLIKTIR: `assertDeployable` codehash'e bakar.
    bytes internal constant CREATE2_deployer_RUNTIME = hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0"
        hex"3601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    uint256 internal constant LOCAL_REHEARSAL = 31337;

    /// @dev Fabrika ve escrow icin YER TUTUCU RUNTIME. `assertDeployable`
    ///      onlardan yalnizca KOD VARLIGI ister -- kimlikleri profil +
    ///      governance + DONDURULMUS creation code'dan turetilir, yani buraya
    ///      gercek bir `LaunchFactory` koymak testin olctugu hicbir seyi
    ///      degistirmezdi.
    bytes internal constant PLACEHOLDER_RUNTIME = hex"6001600155";

    DeployPool internal script;

    function setUp() public {
        vm.etch(DeployLib.CREATE2_FACTORY, CREATE2_deployer_RUNTIME);
        assertEq(DeployLib.CREATE2_FACTORY.code.length, 69, "etched deployer is not the measured 69 bytes");

        script = new DeployPool();

        // Arc pin testleri icin: hook'un baglanacagi iki adres ZINCIRDE olmali.
        vm.etch(PoolDeployLib.factoryFor(PoolDeployLib.ARC_TESTNET_CHAIN_ID), PLACEHOLDER_RUNTIME);
        vm.etch(PoolDeployLib.escrowFor(PoolDeployLib.ARC_TESTNET_CHAIN_ID), PLACEHOLDER_RUNTIME);

        vm.chainId(LOCAL_REHEARSAL);
        vm.deal(address(this), 1 ether);
    }

    function _arcPlan() internal view returns (PoolPlan memory) {
        uint256 chainId = PoolDeployLib.ARC_TESTNET_CHAIN_ID;
        return PoolDeployLib.build(
            chainId, PoolDeployLib.ARC_GOVERNOR, PoolDeployLib.factoryFor(chainId), PoolDeployLib.escrowFor(chainId)
        );
    }

    function callAssertDeployable(PoolPlan memory p) external view {
        PoolDeployLib.assertDeployable(p);
    }

    // ---------------------------------------------------------------
    // 1. FABRIKA ADRESI -- ANKRAJ, LITERAL DEGIL
    // ---------------------------------------------------------------

    /// PIN, TURETMENIN PINIDIR -- ve turetme `Deploy`in YAYINLAYACAGI
    /// BAYTLARDAN gelir (`out-frozen/`), bu birimin gordugu
    /// `type(LaunchFactory).creationCode`tan DEGIL.
    ///
    /// @dev BU TESTIN VAR OLMA SEBEBI OLCULMUS BIR SALDIRIDIR.
    ///      `PoolDeployLib.ARC_FACTORY` bir zamanlar TEK BASINA tasiyiciydi:
    ///      hicbir sey onu `DeployLib`in urettigi adrese baglamiyordu ve
    ///      `LaunchFactory` dondurulmus literal kumesinden MUAFTI.
    ///      `LaunchFactory`nin constructor'indaki DORT ATAMANIN SIRASINI
    ///      degistirmek -- anlambilimsel olarak notr -- kapiyi YESIL, paketi
    ///      607/607 birakiyor ve fabrikayi `0x5CA156f1...` -> `0x2F0C56DB...`
    ///      kaydiriyordu; hook'un tuzu ve adresi HIC kimildamiyordu. Sonuc:
    ///      hook KODSUZ bir fabrikaya KALICI olarak baglanirdi,
    ///      `_beforeInitialize` sonsuza kadar revert ederdi.
    function test_thePinnedFactoryIsTheOneTheFrozenBuildWouldPublish() public view {
        assertEq(
            PoolDeployLib.factoryFor(PoolDeployLib.ARC_TESTNET_CHAIN_ID),
            PoolDeployLib.ARC_FACTORY,
            "fabrika adresi kaydi -- hook YENIDEN madenlenmeli, ve zincirdeyse ARTIK MUMKUN DEGIL"
        );
        assertEq(
            PoolDeployLib.escrowFor(PoolDeployLib.ARC_TESTNET_CHAIN_ID), PoolDeployLib.ARC_ESCROW, "escrow adresi kaydi"
        );
    }

    /// ...AMA YUKARIDAKI IDDIA TEK BASINA BIR TOTOLOJIYE DONUSEBILIR, VE
    /// OLCULDU: `factoryFor()`u `return ARC_FACTORY;`e KISALTMAK **621/621
    /// HAYATTA KALIYORDU**. Sebep basit -- temiz bir agacta pin ile turetme
    /// AYNI SAYIDIR, dolayisiyla "esitler mi" sorusu ikisi de sabit oldugunda
    /// da EVET doner. Ankrajin tasidigi anlam ise tam tersidir: fabrika
    /// KAYDIGINDA bu sayinin ONUNLA BIRLIKTE kaymasi.
    ///
    /// @dev BU YUZDEN IKI SEY OLCULUR:
    ///        (1) BAGIMSIZ TURETME -- CREATE2 formulu bu dosyada YENIDEN
    ///            YAZILIR ve girdileri `out-frozen/` artifact'lerinden okunur,
    ///            `DeployLib`in turetmesinden degil;
    ///        (2) DUYARLILIK -- BASKA bir zincirin governance'i BASKA bir
    ///            fabrika adresi uretir, ve `factoryFor` onu URETMEK
    ///            ZORUNDADIR. Sabit donduren bir mutant burada duser.
    function test_theFactoryAnchorIsAComputationAndNotAConstant() public view {
        assertEq(
            PoolDeployLib.factoryFor(PoolDeployLib.ARC_TESTNET_CHAIN_ID),
            _independentlyDerivedFactory(PoolDeployLib.ARC_TESTNET_CHAIN_ID),
            "ankraj, bu dosyada yeniden yazilan CREATE2 turetmesinden AYRISTI"
        );

        address local = _independentlyDerivedFactory(LOCAL_REHEARSAL);
        assertTrue(
            local != PoolDeployLib.ARC_FACTORY, "iki zincir AYNI fabrikayi uretiyor -- tanik yok, duyarlilik olculemez"
        );
        assertEq(
            PoolDeployLib.factoryFor(LOCAL_REHEARSAL),
            local,
            "factoryFor argumanini YOKSAYDI -- ankraj bir turetme degil, bir SABIT"
        );
    }

    /// @dev ESCROW ICIN AYNI DUYARLILIK TESTI YAZILAMAZ, VE SEBEBI YAPISALDIR:
    ///      `FeeEscrow`un constructor argumani yoktur, dolayisiyla adresi HER
    ///      ZINCIRDE AYNIDIR -- "baska bir zincir baska bir adres verir"
    ///      tanigi MEVCUT DEGILDIR. Escrow'un TOTOLOJI OLMAYAN ankraji baska
    ///      bir yerdedir ve orada KOSULUR:
    ///      `DeployLib.assertEscrowMatchesTheAddressBook`, escrow initcode
    ///      hash'ini `deploy/addresses.5042002.json`e -- GECMIS BIR YAYINDAN
    ///      kalan, bu agactan YENIDEN URETILEMEYEN bir kayda -- baglar
    ///      (`Deploy.t.sol::test_theAddressBookBindsTheEscrowThisTreeWouldDeploy`,
    ///      `::test_anAddressBookThatDisagreesStopsTheDeploy`). Escrow bytecode'u
    ///      kaydiginda `Deploy` ORADA durur ve havuz katmani hic kosmaz.
    function test_theEscrowAnchorAgreesWithAnIndependentDerivation() public view {
        assertEq(
            PoolDeployLib.escrowFor(PoolDeployLib.ARC_TESTNET_CHAIN_ID),
            _create2(keccak256("arcpad.FeeEscrow.v1"), _frozenCreationCode("FeeEscrow")),
            "escrow ankraji, bu dosyada yeniden yazilan CREATE2 turetmesinden AYRISTI"
        );
    }

    /// @dev CREATE2 FORMULU BURADA YENIDEN YAZILIR. `DeployLib.predict`i
    ///      cagirmak, olculmek istenen turetmenin bir parcasini olcumun ICINE
    ///      sokardi.
    function _create2(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), DeployLib.CREATE2_FACTORY, salt, keccak256(initcode))))
            )
        );
    }

    function _frozenCreationCode(string memory name) internal view returns (bytes memory) {
        return
            vm.parseJsonBytes(
                vm.readFile(string.concat("out-frozen/", name, ".sol/", name, ".json")), ".bytecode.object"
            );
    }

    /// @dev YAYINLANACAK BAYTLARDAN, PROFILDEN VE GOVERNANCE'TAN. Arguman
    ///      SIRASI `LaunchFactory`nin constructor'inin sirasidir ve BURAYA
    ///      ELLE yazilir: `DeployLib.factoryArgs`i cagirmak, sirasi yanlis
    ///      olan bir dunyada iki tarafi BIRLIKTE kaydiran o "ayni derlemeden
    ///      gelen iki taraf" kipini yeniden kurardi.
    function _independentlyDerivedFactory(uint256 chainId) internal view returns (address) {
        address escrow_ = _create2(keccak256("arcpad.FeeEscrow.v1"), _frozenCreationCode("FeeEscrow"));
        address schedule_ = _create2(keccak256("arcpad.FeeSchedule.v1"), _frozenCreationCode("FeeSchedule"));
        Profile memory pr = Profiles.forChain(chainId);
        (address governor, address treasury) = Profiles.governanceForChain(chainId);
        bytes memory initcode = abi.encodePacked(
            _frozenCreationCode("LaunchFactory"),
            abi.encode(
                escrow_, treasury, governor, pr.virtualTokenReserves, pr.virtualQuoteReserves, pr.saleSupply, schedule_
            )
        );
        return _create2(keccak256("arcpad.LaunchFactory.v1"), initcode);
    }

    /// TURETMEDEN BASKA BIR FABRIKA REDDEDILIR.
    function test_aFactoryThatIsNotTheDerivedOneIsRefused() public {
        PoolPlan memory p = _arcPlan();
        address foreign = address(0xF00D);
        vm.etch(foreign, PLACEHOLDER_RUNTIME);
        p.factory = foreign;
        vm.expectRevert(
            abi.encodeWithSelector(PoolDeployLib.FactoryIsNotTheDerivedOne.selector, PoolDeployLib.ARC_FACTORY, foreign)
        );
        this.callAssertDeployable(p);
    }

    /// ...VE KODSUZ BIR FABRIKA DA REDDEDILIR. Turetme "adres dogru" der; bu
    /// satir "kontrat ORADA" der, ve hook'un ihtiyaci ikincisidir.
    function test_aCodelessFactoryIsRefusedBeforeTheHookIsDeployed() public {
        PoolPlan memory p = _arcPlan();
        vm.etch(p.factory, "");
        assertEq(p.factory.code.length, 0, "tanik kurulamadi -- test hicbir sey olcmuyor");
        vm.expectRevert(abi.encodeWithSelector(PoolDeployLib.FactoryHasNoCode.selector, p.factory));
        this.callAssertDeployable(p);
    }

    function test_aCodelessEscrowIsRefused() public {
        PoolPlan memory p = _arcPlan();
        vm.etch(p.escrow, "");
        vm.expectRevert(abi.encodeWithSelector(PoolDeployLib.EscrowHasNoCode.selector, p.escrow));
        this.callAssertDeployable(p);
    }

    // ---------------------------------------------------------------
    // 2. TUZ VE ADRES PINLERI
    // ---------------------------------------------------------------

    /// @dev `HookMiner.find` tuzu ve adresi BIRLIKTE dondurur, yani onun
    ///      ciktisinin kendisiyle tutarli oldugunu iddia etmek TOTOLOJIDIR.
    ///      Burada adres `DeployLib.predict` ile BAGIMSIZ olarak hesaplanir.
    function test_thePinnedSaltReproducesThePinnedHookAddress() public view {
        PoolPlan memory p = _arcPlan();
        assertEq(p.hookSalt, PoolDeployLib.ARC_HOOK_SALT, "madenlenen tuz pinden ayristi");
        assertEq(p.hook, PoolDeployLib.ARC_HOOK, "madenlenen hook adresi pinden ayristi");
        assertEq(
            DeployLib.predict(PoolDeployLib.ARC_HOOK_SALT, p.hookInitcode),
            PoolDeployLib.ARC_HOOK,
            "pinlenen tuz pinlenen adresi URETMIYOR"
        );
    }

    /// ...VE O ADRES IZIN KUMESINI TASIR. Bu, tuzun VAR OLMA SEBEBIDIR.
    function test_thePinnedHookAddressCarriesExactlyTheArcpadFlags() public pure {
        uint160 flags = uint160(PoolDeployLib.ARC_HOOK) & Hooks.ALL_HOOK_MASK;
        assertEq(uint256(flags), uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS), "alt 14 bit 0x20CC degil");
        assertEq(
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            uint256(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            ),
            "0x20CC bayraklarin toplamindan ayristi"
        );
    }

    function test_theWholePoolLayerAddressSetIsPinned() public view {
        PoolPlan memory p = _arcPlan();
        assertEq(p.poolManager, PoolDeployLib.ARC_POOL_MANAGER, "PoolManager adresi kaydi");
        assertEq(p.hook, PoolDeployLib.ARC_HOOK, "ArcpadHook adresi kaydi");
        assertEq(p.locker, PoolDeployLib.ARC_LOCKER, "ArcpadLocker adresi kaydi");
    }

    function test_theHookCreationCodeIsPinned() public pure {
        assertEq(
            PoolDeployLib.hookCreationCodeHash(),
            PoolDeployLib.ARC_HOOK_CREATION_CODE_HASH,
            "ArcpadHook creation code kaydi -- hook ADRESI de kaymistir"
        );
        assertEq(
            keccak256(type(ArcpadHook).creationCode),
            PoolDeployLib.ARC_HOOK_CREATION_CODE_HASH,
            "bu birimin hook bytecode'u pinden ayristi"
        );
    }

    /// TERS TANIK: BU BIRIM 800 DEGIL, VE FARK OLCULUR.
    ///
    /// @dev "Hangi derleme yayinlanir" sorusunun cevabini YURUTULEBILIR yapan
    ///      ciftin ikinci yarisi. `Deploy.t.sol`
    ///      (`test_thisUnitCompilesTheSameLaunchFactoryTheFrozenProfileDoes`)
    ///      kendi biriminin `type(LaunchFactory).creationCode`unun
    ///      `out-frozen/`dakiyle AYNI oldugunu iddia eder; bu test onun
    ///      BURADA FARKLI oldugunu iddia eder. Tek basina hicbiri yetmez --
    ///      her birim kendi icinde tutarlidir -- ama ikisi birlikte,
    ///      `PoolDeployLib`in fabrikayi `type(...)`ten DEGIL `out-frozen/`dan
    ///      turetmesinin ZORUNLU oldugunu gosterir. Bu iddia bir gun duserse
    ///      (kisit kalkarsa) turetme yine dogru kalir; duserken soyleyecegi
    ///      sey "artik tek bir derleme var"dir, ki o da kaydedilmeye degerdir.
    function test_thisUnitDoesNotCompileTheFrozenLaunchFactory() public view {
        bytes memory frozen =
            vm.parseJsonBytes(vm.readFile("out-frozen/LaunchFactory.sol/LaunchFactory.json"), ".bytecode.object");
        assertTrue(
            keccak256(type(LaunchFactory).creationCode) != keccak256(frozen),
            "bu birim artik dondurulmus LaunchFactory'yi goruyor -- kisit kalkmis olabilir, TURETMEYI GOZDEN GECIR"
        );
        // ...ve ankraj yine de DOGRU adresi verir, cunku `out-frozen/`dan okur.
        assertEq(
            PoolDeployLib.factoryFor(PoolDeployLib.ARC_TESTNET_CHAIN_ID),
            PoolDeployLib.ARC_FACTORY,
            "ankraj birimden etkilendi"
        );
    }

    function test_theArcPlanPassesThePreFlight() public view {
        PoolDeployLib.assertDeployable(_arcPlan());
    }

    // ---------------------------------------------------------------
    // 2b. ARC CALISMA-ZAMANI PIN BLOGU -- KORUMANIN KORUMASI
    // ---------------------------------------------------------------
    //
    // OLCULEN MUTANT (M1): `assertDeployable` icindeki
    //
    //     if (p.chainId == ARC_TESTNET_CHAIN_ID) { ... }
    //
    // blogunu TAMAMEN SILMEK **621/621 HAYATTA KALIYORDU**. Bu blok, bu
    // dosyanin en pahali arizasini -- constructor'daki dort atamanin
    // anlambilimsel olarak notr yeniden siralanmasini -- yayin aninda durduran
    // seydir; yani KORUMA CALISIYORDU ve KORUMANIN VAR OLDUGUNU hicbir sey
    // sinamiyordu.
    //
    // NICIN MEVCUT TESTLER YETMIYORDU. Hepsi DUZGUN kurulmus bir plan uzerinde
    // `p.hookSalt == ARC_HOOK_SALT` iddia eder; o esitlik `build()`in ciktisi
    // hakkindadir, `assertDeployable`in KOLU hakkinda degil. Blogu silmek o
    // iddialarin hicbirini kimildatmaz. Asagidaki iki test blogun IKI KOLUNU
    // da -- ayri ayri -- yurutur.

    /// KOL 1: MADENLENEN TUZ PINDEN AYRISTIGINDA DEPLOY DURUR.
    ///
    /// @dev TANIK GERCEK ARIZANIN SEKLIDIR: `PoolManager`in initcode'unu
    ///      kimildatan HERHANGI bir sey (solc yukseltmesi, v4-core guncellemesi,
    ///      `compilation_restrictions` degisikligi) onun CREATE2 adresini,
    ///      o da hook'un constructor kuyrugunu, o da ARAMANIN sonucunu
    ///      kaydirir -- FABRIKA VE ESCROW ANKRAJLARI YERINDE DURURKEN. Yani
    ///      bu sinifi ankrajlar goremez; onu goren TEK SATIR pin blogudur.
    ///
    /// @dev VE ONCEKI HER KONTROL GECER: adres bayraklari TASIR (asagida
    ///      iddia edilir) ve tuz adresi YENIDEN URETIR. Pin blogu olmasa bu
    ///      plan on-kontrolden temiz gecerdi.
    function test_theArcPinStopsAPlanWhoseHookWasMinedAgainstDifferentBytes() public {
        PoolPlan memory p = _arcPlan();

        address movedPoolManager = address(0xA11CE);
        (address minedHook, bytes32 minedSalt) = HookMiner.find(
            DeployLib.CREATE2_FACTORY,
            PoolDeployLib.ARCPAD_HOOK_FLAGS,
            type(ArcpadHook).creationCode,
            abi.encode(IPoolManager(movedPoolManager), p.factory, p.escrow)
        );
        assertTrue(minedSalt != PoolDeployLib.ARC_HOOK_SALT, "tanik pinlenen tuzu buldu -- test hicbir sey olcmuyor");

        p.hookSalt = minedSalt;
        p.hook = minedHook;
        p.hookInitcode = PoolDeployLib.hookInitcode(movedPoolManager, p.factory, p.escrow);

        // ONCEKI IKI KONTROLUN BU PLANI GECIRDIGI AYRICA IDDIA EDILIR --
        // yoksa test, pin blogunu degil onlardan birini olcuyor olabilirdi.
        assertEq(
            uint256(uint160(p.hook) & Hooks.ALL_HOOK_MASK),
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            "tanik bayraklari TASIMIYOR -- o zaman bayrak kontrolu yeterdi"
        );
        assertEq(DeployLib.predict(p.hookSalt, p.hookInitcode), p.hook, "tanik kendi icinde tutarsiz");

        vm.expectRevert(
            abi.encodeWithSelector(
                PoolDeployLib.HookSaltIsNotThePinnedOne.selector, PoolDeployLib.ARC_HOOK_SALT, minedSalt
            )
        );
        this.callAssertDeployable(p);
    }

    /// KOL 2: PINLENEN TUZ BASKA BIR ADRES URETTIGINDE DE DURUR.
    ///
    /// @dev AYRI BIR KOL VE AYRI BIR TESTI HAK EDIYOR, cunku yalnizca tuzu
    ///      sinayan bir blok "tuz 13, ama adres baska" halini GECIRIRDI --
    ///      ve o hal, arama uzayinin 1/16.384'unde tam olarak boyle gorunur.
    ///      Bu depoda ayni sekil defalarca olculdu: iki kol, biri kosulmus.
    ///
    /// @dev TANIK ARANIR, PINLENMEZ. Pinlenmis sihirli bir sayi buraya
    ///      dogrulanamayan bir iddia koyardi; arama, taniginin GERCEKTEN
    ///      bayraklari tasidigini her kosuda YENIDEN kanitlar.
    function test_theArcPinStopsThePinnedSaltReproducingADifferentAddress() public {
        PoolPlan memory p = _arcPlan();

        bytes memory witness;
        address landing;
        for (uint256 i = 0; i < 200_000; ++i) {
            bytes memory candidate = abi.encodePacked(bytes32(uint256(i)));
            address a = DeployLib.predict(PoolDeployLib.ARC_HOOK_SALT, candidate);
            if (uint160(a) & Hooks.ALL_HOOK_MASK == PoolDeployLib.ARCPAD_HOOK_FLAGS) {
                witness = candidate;
                landing = a;
                break;
            }
        }
        assertTrue(landing != address(0), "tanik aramasi tukendi -- test hicbir sey olcmuyor");
        assertTrue(landing != PoolDeployLib.ARC_HOOK, "tanik pinlenen adrese dustu");

        p.hookInitcode = witness;
        p.hook = landing;
        // p.hookSalt PINLENEN TUZ OLARAK KALIR.
        assertEq(p.hookSalt, PoolDeployLib.ARC_HOOK_SALT, "tanik tuzu kimildatti -- olculen kol 1 olurdu");
        assertEq(DeployLib.predict(p.hookSalt, p.hookInitcode), p.hook, "tanik kendi icinde tutarsiz");

        vm.expectRevert(
            abi.encodeWithSelector(
                PoolDeployLib.HookSaltDoesNotReproduceTheAddress.selector,
                PoolDeployLib.ARC_HOOK_SALT,
                PoolDeployLib.ARC_HOOK,
                landing
            )
        );
        this.callAssertDeployable(p);
    }

    /// KONTROL GRUBU: PIN BLOGU YALNIZCA ARC'TA KOSAR.
    /// @dev Blogun `chainId` kosulu da tasiyicidir: her zincirde kossaydi
    ///      `local-rehearsal` provasi -- ki hook'u BASKA bir fabrikaya karsi
    ///      madenler -- imkansiz olurdu. Yukaridaki iki test, kosulu
    ///      `true`ya sabitleyen bir mutanti goremez; bu test gorur.
    function test_thePinBlockDoesNotFireOffArc() public {
        (address factory_, address escrow_) = _fundLocalWiring();
        PoolPlan memory local = PoolDeployLib.build(LOCAL_REHEARSAL, PoolDeployLib.ARC_GOVERNOR, factory_, escrow_);
        assertTrue(
            local.hookSalt != PoolDeployLib.ARC_HOOK_SALT, "yerel prova pinlenen tuzu buldu -- test hicbir sey olcmuyor"
        );
        // ...ve on-kontrol yine de GECER, cunku bu Arc degil.
        PoolDeployLib.assertDeployable(local);
    }

    function test_anOccupiedHookAddressStopsTheDeploy() public {
        PoolPlan memory p = _arcPlan();
        vm.etch(p.hook, PLACEHOLDER_RUNTIME);
        vm.expectRevert(
            abi.encodeWithSelector(PoolDeployLib.PoolContractAlreadyDeployed.selector, "ArcpadHook", p.hook)
        );
        this.callAssertDeployable(p);
    }

    /// @dev Reddi `BaseHook`in constructor'i DEGIL, on-kontrol yapar. Fark
    ///      tasiyicidir: `BaseHook`in revert'i BROADCAST SIRASINDA,
    ///      `PoolManager` ZATEN INDIKTEN sonra olurdu.
    function test_aHookAddressWithoutTheFlagsIsRefusedBeforeAnythingIsBroadcast() public {
        PoolPlan memory p = _arcPlan();
        p.hook = address(0x1234);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolDeployLib.HookAddressLacksTheArcpadFlags.selector,
                p.hook,
                uint160(p.hook) & Hooks.ALL_HOOK_MASK,
                PoolDeployLib.ARCPAD_HOOK_FLAGS
            )
        );
        this.callAssertDeployable(p);
    }

    /// GERCEK ARIZANIN SEKLI: hook'un initcode'unu belirleyen HERHANGI bir
    /// sey degisirse arama BASKA bir tuz ve BASKA bir adres bulur.
    ///
    /// @dev ...VE O ADRES YINE BAYRAKLARI TASIR. Bu satir, bayrak
    ///      kontrolunun bu sinifi YAKALAYAMADIGININ olcumudur -- fabrika
    ///      ankraji tam olarak bu yuzden gereklidir.
    function test_aDifferentWiringMinesADifferentSaltAndTheFlagCheckCannotSeeIt() public view {
        PoolPlan memory wrong = PoolDeployLib.build(
            PoolDeployLib.ARC_TESTNET_CHAIN_ID, PoolDeployLib.ARC_GOVERNOR, address(0xBEEF), PoolDeployLib.ARC_ESCROW
        );
        assertTrue(wrong.hookSalt != PoolDeployLib.ARC_HOOK_SALT, "tanik ayni tuzu buldu -- test hicbir sey olcmuyor");
        assertTrue(wrong.hook != PoolDeployLib.ARC_HOOK, "tanik ayni adresi buldu");
        assertEq(
            uint256(uint160(wrong.hook) & Hooks.ALL_HOOK_MASK),
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            "yanlis fabrikayla madenlenen adres bayraklari TASIMIYOR -- o zaman bayrak kontrolu yeterdi"
        );
    }

    // ---------------------------------------------------------------
    // 3. SCRIPT'IN KENDISI -- `plan()` VE `run()`
    // ---------------------------------------------------------------

    /// @dev `local-rehearsal` zinciri kullanilir cunku Arc'in fabrikasi HENUZ
    ///      ZINCIRDE DEGIL; olculen sey script'in MEKANIGIDIR -- sira, geri
    ///      okuma, ve `plan()` ile `run()`un ayni Plan'i uretmesi.
    function _fundLocalWiring() internal returns (address factory_, address escrow_) {
        factory_ = PoolDeployLib.factoryFor(LOCAL_REHEARSAL);
        escrow_ = PoolDeployLib.escrowFor(LOCAL_REHEARSAL);
        vm.etch(factory_, PLACEHOLDER_RUNTIME);
        vm.etch(escrow_, PLACEHOLDER_RUNTIME);
    }

    function test_planIsADryRunAndBroadcastsNothing() public {
        _fundLocalWiring();
        PoolPlan memory p = script.plan();
        assertEq(p.poolManager.code.length, 0, "plan() PoolManager DEPLOY ETTI");
        assertEq(p.hook.code.length, 0, "plan() hook DEPLOY ETTI");
        assertEq(p.locker.code.length, 0, "plan() locker DEPLOY ETTI");
    }

    function test_planAndRunAgreeOnEveryAddress() public {
        _fundLocalWiring();
        PoolPlan memory dry = script.plan();
        PoolPlan memory wet = script.run();
        assertEq(dry.poolManager, wet.poolManager, "plan() ve run() PoolManager konusunda ayrisiyor");
        assertEq(dry.hook, wet.hook, "plan() ve run() hook konusunda ayrisiyor");
        assertEq(dry.locker, wet.locker, "plan() ve run() locker konusunda ayrisiyor");
        assertEq(dry.hookSalt, wet.hookSalt, "tuz ayristi");
    }

    /// UC KONTRAT DA TAHMIN EDILEN ADRESLERE INER VE BIRBIRLERINE DOGRU
    /// BAGLANIR.
    ///
    /// @dev `assertAsDeployed` `run()`un ICINDE kosar, yani bu test onu da
    ///      yurutur. Iddialar burada AYRICA yazilir cunku o fonksiyonun bir
    ///      kolu bozulsa bile (olculdu: `l.hook()`u `p.poolManager` ile
    ///      karsilastiran mutant) `run()` yine gecerdi.
    function test_runDeploysTheThreeContractsAndWiresThem() public {
        (address factory_, address escrow_) = _fundLocalWiring();
        PoolPlan memory p = script.run();

        assertGt(p.poolManager.code.length, 0, "PoolManager inmedi");
        assertGt(p.hook.code.length, 0, "hook inmedi");
        assertGt(p.locker.code.length, 0, "locker inmedi");

        ArcpadHook h = ArcpadHook(p.hook);
        assertEq(address(h.poolManager()), p.poolManager, "hook baska bir PoolManager'a bagli");
        assertEq(h.factory(), factory_, "hook baska bir factory'ye bagli");
        assertEq(h.escrow(), escrow_, "hook baska bir escrow'a bagli");

        ArcpadLocker l = ArcpadLocker(payable(p.locker));
        assertEq(address(l.poolManager()), p.poolManager, "locker baska bir PoolManager'a bagli");
        assertEq(l.factory(), factory_, "locker baska bir factory'ye bagli");
        assertEq(address(l.hook()), p.hook, "locker baska bir hook'a bagli");

        // SAHIPLIK GOVERNOR SAFE'INDE. `PoolManager`in sahibi protokol ucreti
        // denetleyicisini atar, yani bir EOA'da birakmak Faz 2'nin tum
        // havuzlarini o anahtara baglardi.
        assertEq(PoolManager(p.poolManager).owner(), p.owner, "PoolManager'in sahibi governor Safe'i degil");
    }

    /// MADENLENEN ADRES GERCEKTEN O BAYRAKLARLA INER. `BaseHook`in
    /// constructor'i yanlis adreste revert eder, yani bu testin GECMESI
    /// adresin dogru madenlendiginin ZINCIR USTU kanitidir.
    function test_theDeployedHookAcceptsItsOwnAddress() public {
        _fundLocalWiring();
        PoolPlan memory p = script.run();
        assertEq(
            uint256(uint160(p.hook) & Hooks.ALL_HOOK_MASK),
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            "inen hook'un adresi bayraklari tasimiyor"
        );
        assertTrue(ArcpadHook(p.hook).getHookPermissions().beforeInitialize, "inen hook izin kumesini bildirmiyor");
    }

    /// IKINCI KOSU IKINCI BIR EVREN URETMEZ.
    function test_aSecondRunIsRefused() public {
        _fundLocalWiring();
        PoolPlan memory p = script.run();
        vm.expectRevert(
            abi.encodeWithSelector(PoolDeployLib.PoolContractAlreadyDeployed.selector, "PoolManager", p.poolManager)
        );
        script.run();
    }
}
