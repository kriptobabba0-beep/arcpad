// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployLib, Plan} from "../../script/DeployLib.sol";
import {Governance, ISafe} from "../../script/Governance.s.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
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

    /// @dev BU TEST TASK 6'DA ANLAM DEGISTIRDI VE ADI DA DEGISTI.
    ///      Onceki hali "iki hedef adres HALA BOS" diyordu ve Task 6'nin on
    ///      kosuluydu. Task 6 CALISTI, dolayisiyla o iddia artik yanlis olurdu.
    ///      Yerine gecen sey daha guclu: iki adres de DOLU, ve icindekiler
    ///      plandaki degerlerin TA KENDISI.
    function test_theDeploymentIsPresentAndHoldsTheResolvedProfile() public view {
        Profile memory profile = Profiles.forChain(ARC_TESTNET_CHAIN_ID);
        (address governor, address treasury) = Profiles.governanceForChain(ARC_TESTNET_CHAIN_ID);
        Plan memory p = DeployLib.build(ARC_TESTNET_CHAIN_ID, profile, DEPLOYER, governor, treasury);

        assertGt(p.escrow.code.length, 0, "FeeEscrow is not deployed at the reserved address");
        assertGt(p.factory.code.length, 0, "LaunchFactory is not deployed at the reserved address");

        // Deploy script'inin KENDI geri okumasi degil; fork testinin kendi
        // iddiasi. Ayni kontroller, bagimsiz bir yerden.
        LaunchFactory f = LaunchFactory(p.factory);
        assertEq(f.escrow(), p.escrow, "escrow");
        assertEq(f.governor(), GOVERNOR_SAFE, "governor");
        assertEq(f.protocolTreasury(), TREASURY_SAFE, "protocolTreasury");
        assertEq(f.VIRTUAL_TOKEN_RESERVES(), 1_073_000_000e18, "T");
        assertEq(f.VIRTUAL_QUOTE_RESERVES(), 4_292e15, "V -- 4292e15 is testnet; 4292e18 would be production");
        assertEq(f.SALE_SUPPLY(), 793_100_000e18, "S");
        assertEq(f.graduationTarget(), address(0), "graduationTarget must still be unset");
    }

    /// DEPLOY EDEN EOA, DEPLOY ETTIGI SEY UZERINDE HICBIR YETKI TUTMUYOR.
    function test_theDeployerCannotGovernTheDeployedFactory() public {
        Profile memory profile = Profiles.forChain(ARC_TESTNET_CHAIN_ID);
        (address governor, address treasury) = Profiles.governanceForChain(ARC_TESTNET_CHAIN_ID);
        Plan memory p = DeployLib.build(ARC_TESTNET_CHAIN_ID, profile, DEPLOYER, governor, treasury);
        LaunchFactory f = LaunchFactory(p.factory);

        vm.prank(DEPLOYER);
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        f.proposeGraduationTarget(address(0xABCD));

        vm.prank(DEPLOYER);
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        f.setProtocolTreasury(DEPLOYER);
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
        // FAZ 2 BU SAYIYI TASIDI VE TASIMASI GEREKIYORDU: `LaunchFactory`nin
        // constructor'i `feeSchedule` argumanini kazandi, ve fabrika adresi
        // argumanlarina COMMIT EDER. Eski deger 0x0d75a4fF... Faz 1'indir ve
        // SUPERSEDE EDILMISTIR.
        assertEq(p.factory, 0x7A02759adD7193AD11A0C51914398d366Bf256A3, "factory address moved");
        // ...VE DEFTER AYNI SEYI SOYLUYOR. Literal, turetmenin BAGIMSIZ pini;
        // bu satir turetmeyi DEFTERE baglar, yani ikisi ayrisirsa -- Faz 2'nin
        // en pahali arizasinin sekli tam olarak buydu -- burasi kirmizi olur.
        assertEq(
            p.factory,
            vm.parseJsonAddress(vm.readFile("deploy/addresses.5042002.json"), ".launchFactory"),
            "the address book and this tree disagree about the factory"
        );
    }

    /// @dev TORENIN GERCEKTEN YURUDUGUNUN KALICI KANITI.
    ///
    ///      Prova factory'si governor Safe'i governor VE treasury olarak dogdu;
    ///      toren `setProtocolTreasury`yi 2-of-3 imzayla yurutup onu treasury
    ///      Safe'e cevirdi. Asagidaki esitsizlik o imza demetinin Safe
    ///      tarafindan KABUL EDILDIGININ zincirdeki izidir.
    ///
    ///      BU TEST BIR KEZ KAZAYLA SILINDI VE SAYIM ONU GIZLEDI. Task 6
    ///      duzenlemesi iki testi degistirirken bu ucuncusunu de kapsayan bir
    ///      araligi degistirdi; suite 10'dan 10'a gitti (iki yeni, iki eski,
    ///      bir silinen) ve yesil kaldi. Ders yazili birakiliyor: SABIT KALAN
    ///      BIR TEST SAYISI, SILINMIS BIR TESTI GIZLER -- degisen ARALIK degil,
    ///      degisen ISIM LISTESI okunmalidir.
    function test_theCeremonyRehearsalTookEffectOnChain() public view {
        address rehearsalFactory = 0xfed991C6B9AD7144Df3d670c6b9EcF3620ac6eA5;
        assertGt(rehearsalFactory.code.length, 0, "the rehearsal factory is gone");
        assertEq(
            LaunchFactory(rehearsalFactory).governor(),
            GOVERNOR_SAFE,
            "the rehearsal factory was not governed by the governor Safe"
        );
        assertEq(
            LaunchFactory(rehearsalFactory).protocolTreasury(),
            TREASURY_SAFE,
            "the 2-of-3 ceremony did not take effect: the treasury never moved"
        );
        // ...VE ARTIK DONGUNUN TAMAMI YURUDU. BU IDDIA 2026-08-08'DE
        // DEGISTIRILDI VE SEBEBI KAYDA DEGER.
        //
        // Onceki hali "hedef ONERILDI, henuz INMEDI" diyordu ve o gun dogruydu.
        // Zincirde olculen bugunku hal: `pendingGraduationTarget` BOS,
        // `graduationTarget` 0x...dEaD, `eta` 0. Yani `applyGraduationTarget()`
        // KOSTU -- ve onu kimsenin ONAYLAMASI GEREKMEDI: o fonksiyon BILEREK
        // IZINSIZDIR. Ihbar suresi doldu, pencere acildi, ve indi.
        //
        // TARIHSEL NOT, BUGUNKU SABITLE KARISTIRILMASIN: bu gozlem V1
        // fabrikasinda yapildi ve ORADA `GRADUATION_TARGET_DELAY` UC GUNDU.
        // Bugun bir GUNDUR. Yukaridaki anlati o gunun zincirini anlatir; bu
        // testin iddiasi sureden BAGIMSIZDIR -- olctugu sey dongunun
        // TAMAMLANMIS olmasidir, ne kadar surdugu degil.
        //
        // BU YUZDEN BURADA DURUYOR: "propose -> bekle -> apply" dongusunun
        // TAMAMININ Arc'ta fiilen yurudugunun kalici kanitidir, VE ayni zamanda
        // izinsiz apply'in TEORIK OLMADIGININ olcumudur. Gercek fabrikada bir
        // oneri baslatmak, ihbar suresi sonunda HERKESIN silahlayabilecegi bir
        // dugme birakir; burada zararsizdi cunku bu yigin DISPOSABLE.
        assertEq(
            LaunchFactory(rehearsalFactory).graduationTarget(),
            0x000000000000000000000000000000000000dEaD,
            "the rehearsal target never landed -- the propose->wait->apply cycle is unproven"
        );
        assertEq(
            LaunchFactory(rehearsalFactory).pendingGraduationTarget(),
            address(0),
            "apply did not clear the pending slot"
        );
    }

    /// @dev `vm.parseJsonAddress` JSON `null` uzerinde REVERT eder, yani
    ///      "bos mu" sorusu ondan ONCE sorulmalidir -- ve `vm.parseJson`in
    ///      donen uzunluguna bakmak YETMEDI (olculdu: null icin de bos
    ///      donmuyor). Cagri bu yuzden DISARI cikarilir; `try/catch` bir
    ///      cheatcode revert'unu yakalayabilir, ama yalnizca EXTERNAL bir
    ///      cagrida.
    function parseAddressExternally(string calldata json, string calldata key) external view returns (address) {
        return vm.parseJsonAddress(json, key);
    }

    function _isJsonNull(string memory json, string memory key) internal view returns (bool) {
        try this.parseAddressExternally(json, key) returns (address) {
            return false;
        } catch {
            return true;
        }
    }

    /// @dev ADRES DEFTERININ `smokeToken`/`smokeCurve` ALANLARININ VAROLMA
    ///      SEBEBI: "CI fork kapisinin okudugu KALICI tamamlanmis-curve
    ///      fixture'i". Task 7 onlari doldurdu; bu test onlari DEFTERDEN okuyup
    ///      ZINCIRE karsi dogrular -- yani defter artik yalnizca yazilan degil,
    ///      OKUNAN bir sey.
    /// @dev NULL BIR ALAN, EKSIK BIR ALAN DEGILDIR -- VE BU TEST ONU
    ///      AYIRT ETMEK ZORUNDA. Semada tip `Address | null`dur ve Task 7
    ///      ikisini de `null` YAPTI: defterdeki smoke ciftii SUPERSEDE EDILMIS
    ///      Faz 1 fabrikasinin urunuydu, yeni fabrikaya ait DEGIL. `null`
    ///      birakmak dogru degerdi, ama `vm.parseJsonAddress` JSON null'u
    ///      PARSE EDEMEZ ve bu test onun uzerinde patladi -- semanin izin
    ///      verdigi bir degeri okuyamayan bir okuyucu.
    ///
    ///      Task 8B bu alanlari Faz 2'nin kendi tamamlanmis curve'uyle
    ///      dolduracak; o zamana kadar iddia "alan bos, ve bos olmasi
    ///      MESRU"dur. Sessizce gecmez: bos olduguNU iddia eder.
    ///
    /// @dev `graduated == false` IDDIASI KALDIRILDI (Task 8B). BU BIR
    ///      GEVSETME DEGIL, ALTINCI ARIZA MODUNUN DUZELTILMESIDIR: bir kapinin
    ///      MEVCUT DURUMUN BIR RASTLANTISINI KANUN GIBI KODLAMASI.
    ///
    ///      Fixture'in ANLAMI defterin kendi semasinda yazilidir: "CI fork
    ///      kapisinin okudugu KALICI tamamlanmis-curve fixture'i". Tasidigi
    ///      ozellikler MONOTONDUR ve hepsi burada duruyor -- kod var, token
    ///      kanonik, curve token'a isaret ediyor, `complete` (ki geri
    ///      alinamaz), ve hasilat graduation esigini gecmis. Bunlarin hicbiri
    ///      graduation'dan sonra degismez.
    ///
    ///      `graduated == false` ise fixture'in anlaminin PARCASI DEGILDI:
    ///      yalnizca "uretim fabrikasinin hedefi henuz silahlanmadi"
    ///      demekti -- ki onu ZATEN `ArcV4.fork.t.sol`daki
    ///      `test_theGraduationTargetIsStillUnset` dogrudan ve kendi adiyla
    ///      olcuyor. Hedef silahlandigi gun bu curve mezun olur, `graduated`
    ///      SONSUZA KADAR `true` olur ve bu kapi HICBIR ARIZA OLMADAN kirmizi
    ///      olurdu -- projenin ilerledigi yon tam olarak orasi oldugu icin de
    ///      bu ertelenmis bir kesinlik, bir risk degil.
    ///
    ///      YERINE GECEN SEY BIR KANUNDUR, BIR DURUM DEGIL: `graduated`
    ///      YALNIZCA hedef silahliyken mumkundur (`BondingCurve.graduate()`
    ///      once `GraduationTargetUnset()` ile doner). Yani mezun bir curve,
    ///      hedefi HALA BOS olan bir fabrikayla birlikte GORULEMEZ. Bu
    ///      cift, hangi tarafa giderse gitsin, tutarli olmak ZORUNDADIR --
    ///      ve tutarsizligi gercek bir ariza olurdu.
    function test_theSmokeCurveInTheBookIsRealAndComplete() public view {
        string memory book = vm.readFile("deploy/addresses.5042002.json");
        if (vm.keyExistsJson(book, ".smokeToken") && _isJsonNull(book, ".smokeToken")) {
            assertTrue(
                _isJsonNull(book, ".smokeCurve"),
                "smokeToken is null but smokeCurve is not -- the pair must move together"
            );
            return;
        }
        address smokeToken = vm.parseJsonAddress(book, ".smokeToken");
        address smokeCurve = vm.parseJsonAddress(book, ".smokeCurve");
        address factory = vm.parseJsonAddress(book, ".launchFactory");

        assertGt(smokeToken.code.length, 0, "the book names a smokeToken with no code");
        assertGt(smokeCurve.code.length, 0, "the book names a smokeCurve with no code");

        assertTrue(LaunchFactory(factory).isCanonical(smokeToken), "the smoke token is not canonical");
        assertEq(BondingCurve(payable(smokeCurve)).token(), smokeToken, "curve and token disagree");
        assertTrue(BondingCurve(payable(smokeCurve)).complete(), "the smoke curve is not complete");

        // "Tamamlandi"nin EKONOMIK anlami: hasilat graduation esigini gecti.
        assertGe(
            BondingCurve(payable(smokeCurve)).realQuoteReserves(),
            LaunchFactory(factory).MIN_GRADUATION_RAISE(),
            "the completed curve did not reach the graduation raise"
        );

        // KANUN, DURUM DEGIL. Iki yon de yurunur, cunku ikisi de gercek bir
        // arizanin sekli:
        //   mezun ama hedef bos  -> `graduate()`in `GraduationTargetUnset`
        //                           korumasi asilmis demektir.
        //   mezun ama tamam degil -> `NotComplete` korumasi asilmis demektir
        //                           (ustteki `complete` iddiasiyla birlikte).
        if (BondingCurve(payable(smokeCurve)).graduated()) {
            assertTrue(
                LaunchFactory(factory).graduationTarget() != address(0),
                "a graduated curve on a factory whose graduationTarget is still unset"
            );
        }
    }
}
