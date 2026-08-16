// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {Profile, Profiles} from "./Profiles.sol";

/// @dev Safe'in yalnizca yoklamanin ihtiyac duydugu iki uyesi.
interface ISafeProbe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

struct Plan {
    uint256 chainId;
    Profile profile;
    address deployer;
    address governor;
    address treasury;
    bytes32 escrowSalt;
    bytes32 factorySalt;
    bytes escrowInitcode;
    bytes factoryInitcode;
    address escrow;
    address factory;
    bytes32 feeScheduleSalt;
    bytes feeScheduleInitcode;
    address feeSchedule;
}

library DeployLib {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Kanonik deterministik deployer. Arc testnet'te OLCULDU: 69 bayt.
    address internal constant CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant CREATE2_FACTORY_CODE_LENGTH = 69;

    /// @dev KOD KIMLIGI, UZUNLUK DEGIL. Onceki hali `code.length == 69`
    ///      kontrol ediyordu ve bu YETERSIZDI: 69 baytlik HERHANGI bir kontrat
    ///      geciyordu. Bunun varsayimsal olmadigini bu dosyanin KENDI testleri
    ///      gosteriyor -- D5 ve D6 taniklari tam olarak o durumu kullaniyor
    ///      (69 baytlik, kanonik OLMAYAN bir deployer etch'lenir ve on-kontrol
    ///      bunu kabul eder). Onemli olan varsayim "o adreste 69 baytlik bir
    ///      sey var" degil, "o adreste KANONIK deployer var"dir: her tahmin
    ///      edilen adresi dogru kilan sey budur.
    ///
    ///      DEGER ARC TESTNET'TEN OLCULDU, bir incelemeciden veya
    ///      dokumantasyondan alinmadi:
    ///        cast keccak $(cast code 0x4e59b448... --rpc-url $ARC_RPC_URL)
    ///        -> 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989
    bytes32 internal constant CREATE2_FACTORY_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    /// @dev `LaunchFactory` constructor'inin ABI-encode edilmis YEDI argumani:
    ///      7 * 32 bayt. Initcode'un KUYRUGUDUR. Faz 2'de `feeSchedule`
    ///      eklendigi icin 192'den 224'e cikti; kuyruk uzunlugu ile decode
    ///      imzasi AYNI ANDA guncellenmek zorundadir, aksi halde `abi.decode`
    ///      kaymis bir kuyruktan sessizce anlamsiz degerler okurdu.
    ///
    /// @dev BIR KEZ 256 YAPILDI VE O BIR REGRESYONDU (buyback nesli, c625116).
    ///      Sebebi kayda deger, cunku sinifi tekrar edebilir: buyback isi
    ///      constructor'a SEKIZINCI bir `buybackTreasury` argumani eklemeyi
    ///      DENEDI, sonra o tasarimdan vazgecildi -- `buybackTreasury` bugun
    ///      governor'in BIR KEZ yazdigi bir storage degiskenidir ve BILEREK
    ///      oyledir (bkz. `LaunchFactory.buybackTreasury` NatSpec'i: uc kontrat
    ///      birbirinin initcode'una girerse hicbir CREATE2 on-tahmini o
    ///      dongüyü cozemez). Constructor geri alindi, DEPLOY TARAFI ALINMADI.
    ///
    ///      BEDELI: `factoryArgs` 32 baytlik bir CÖP KUYRUGU uretti. Solidity
    ///      constructor cozucusu fazla baytlari SESSIZCE yoksayar, yani
    ///      fabrika YINE DE deploy olurdu -- ama BASKA BIR ADRESTE
    ///      (`0x7A02759a` -> `0x3eE0Ff0a`, olculdu). Adres kaymasi hook'un
    ///      tuzuna, o da hook ve locker adreslerine yayildi; DeployPool
    ///      paketinde dokuz test kirmizi oldu ve hepsi ayni tek satiri
    ///      gosteriyordu. KAYIT: bu sabit ile `factoryArgs`in arguman sayisi
    ///      ve `_assertInitcodeEncodesThePlan`in decode imzasi UC AYRI YERDE
    ///      ayni sayiyi soyler; ucu birden constructor'a bakarak degistirilir.
    uint256 internal constant FACTORY_ARG_BYTES = 224;

    /// @dev Salt'lar SECILMEZ, TURETILIR.
    ///      keccak256("arcpad.FeeEscrow.v1")
    ///        = 0xc86ad978a80671d39d91fd5b65d5b29cc34a84fb29664012ce6de14effefa718
    ///      keccak256("arcpad.LaunchFactory.v1")
    ///        = 0xbe555c18d58e8926d5c280a3e9cbc89e2f14c6032e597b69644113c7092390e4
    bytes32 internal constant ESCROW_SALT = keccak256("arcpad.FeeEscrow.v1");
    bytes32 internal constant FACTORY_SALT = keccak256("arcpad.LaunchFactory.v1");
    bytes32 internal constant FEE_SCHEDULE_SALT = keccak256("arcpad.FeeSchedule.v1");

    uint256 internal constant MIN_SAFE_THRESHOLD = 2;
    uint256 internal constant MIN_SAFE_OWNERS = 3;

    /// @dev Tahmini deploy maliyetinin 5 kati. TURETME: olculen 25 gwei'de
    ///      escrow ~189k + factory ~2,90M ~= 3,1M gaz = 0,0775 USDC; 5 kati
    ///      0,39; yukari yuvarlanmis hali 0,5 USDC. SECILMEDI, olculen bir
    ///      buyuklukten okundu.
    uint256 internal constant MIN_DEPLOYER_BALANCE = 0.5e18;

    error Create2DeployerMissing(address expected, uint256 codeLength);
    error Create2DeployerNotCanonical(address at, bytes32 expected, bytes32 actual);
    error InitcodeDoesNotEncodeThePlan(string field);
    error NotAMultisig(string role, address account);
    error MultisigThresholdTooLow(string role, address account, uint256 threshold);
    error MultisigTooFewOwners(string role, address account, uint256 owners);
    error AlreadyDeployed(string what, address at);
    error Create2Failed(bytes32 salt);
    error InsufficientDeployerBalance(address deployer, uint256 have, uint256 need);
    error ProfileNotAsDeployed(string field, uint256 expected, uint256 actual);
    error GovernanceNotAsDeployed(string field, address expected, address actual);

    /// @dev "DONDURULMUS KAPIYI HIC KOSMADIN." `make frozen-hash` calismadan
    ///      `out-frozen/` YOKTUR. AYRI BIR HATA OLMASI TASIYICIDIR: operator
    ///      icin "kapiyi kosmadim" ile "kostum ve baytlar tutmuyor" AYNI SEY
    ///      DEGILDIR, ve ikisini tek hataya toplamak teshisi tam da en pahali
    ///      anda kaybettirirdi.
    error FrozenArtifactMissing(string path);
    /// @dev "KOSTUN, VE BAYTLAR TUTMUYOR." Yayinlanmak uzere olan initcode
    ///      dondurulmus derlemenin urettigi initcode DEGILDIR.
    error NotTheFrozenBuild(string what, string remedy, bytes32 expected, bytes32 actual);

    /// @dev `remedy` ALANI BIR YANLIS KIRMIZIYI ONLEMEK ICIN VAR, VE BIR
    ///      `console2.log` YERINE ALAN OLMASININ SEBEBI OLCULDU: forge, log
    ///      satirlarini VARSAYILAN AYRINTI DUZEYINDE GOSTERMEZ (`-vv`
    ///      gerekir), ama hata alanlarini HER ZAMAN basar. Bir ipucu,
    ///      okunmadigi yerde ipucu degildir.
    ///
    ///      ONLEDIGI DURUM: `forge test` `out-frozen/` dizinini YENIDEN
    ///      DERLEMEZ -- onu yalnizca `make frozen-hash` yazar. Bir kaynagi
    ///      degistirip geri alan, sonra CIPLAK `forge test` kosan biri TEMIZ
    ///      bir agacta ~38 `NotTheFrozenBuild` hatasi gorur; hicbiri agac
    ///      hakkinda bir sey soylemez, hepsi REFERANSIN bayat oldugunu
    ///      soyler. Bu depoda "insanlarin gormezden gelmeye alistigi bir kapi,
    ///      hic olmayan bir kapidan KOTUDUR" iki kez olculdu.
    ///
    ///      METIN IKI SEYI SIRAYLA SOYLER: once "kapiyi kos" (vakalarin
    ///      cogu), sonra "hala kirmiziysa pin'i YENIDEN URETME, sebebini bul"
    ///      (gercek bir kayma da aynen boyle gorunur, ve iki durumu ayirt
    ///      edecek olan operatordur).
    string internal constant FROZEN_REMEDY =
        "ONCE KOS: make frozen-hash (forge test out-frozen/ dizinini YENIDEN DERLEMEZ). Sonra hala kirmiziysa: pin'i YENIDEN URETMEYIN, sebebini bulun.";

    /// @notice DONDURULMUS ARTIFACT DIZINI. TEK YERDE.
    /// @dev Uretim yolundaki HER okuma bu sabitten gecer; dosyada baska bir
    ///      `out-frozen` literali KALMADI. Sebep bir mutasyon hijyeni: dizin
    ///      adi bes ayri cagri yerinde dururken, tek bir yeri degistirmek
    ///      digerlerini yesil birakiyordu.
    string internal constant FROZEN_DIR = "out-frozen";

    /// @notice `[profile.frozen]`in SKIP ETTIGI kaynak. DIZIN KIMLIGININ
    ///         AYIRT EDICISI.
    /// @dev `foundry.toml`: `skip = ["src/ArcpadHook.sol", "src/ArcpadLocker.sol",
    ///      "test/**", "script/**"]`. Yani `out-frozen/ArcpadHook.sol/` HICBIR
    ///      zaman uretilemez, `out/ArcpadHook.sol/` ise HER derlemede uretilir.
    ///      Ayirt edici olarak SECILDI cunku iki dizinin FARKI budur: baytlarin
    ///      kendisi ayirt edici DEGILDIR -- `out/` dogru baytlari da tutabilir,
    ///      ve tam olarak o yuzden mutant hayatta kaliyordu.
    string internal constant NOT_IN_THE_FROZEN_BUILD = "ArcpadHook.sol";

    /// @dev "O ADRESTE BIR SEY VAR, VE O BIZIM DERLEMEMIZ DEGIL."
    ///      `AlreadyDeployed`DEN AYRI BIR HATA OLMASI TASIYICIDIR ve ayrimin
    ///      kendisi guvenlik ozelligidir: bir CREATE2 adresinde KOD BULMAK iki
    ///      apayri durumdur. Kod, deploy EDECEGIMIZ baytlarin ta kendisiyse o
    ///      kontrat ZATEN BIZIMKIDIR ve yeniden kullanilmasi yalnizca guvenli
    ///      degil ZORUNLUDUR (`FeeEscrow` canli ve FONLU). Baska bir sey ise
    ///      adres ele gecirilmistir ve deploy DURMALIDIR.
    error OccupiedByAForeignBuild(string what, address at, bytes32 expected, bytes32 actual);

    /// @dev "OKUNAN DIZIN DONDURULMUS DERLEMENIN DIZINI DEGIL."
    ///      KAPININ KENDI KAPISI, ve var olma sebebi OLCULMUS BIR MUTANTTIR:
    ///      bu dosyadaki bes `out-frozen` literalinin hepsini `out` yapmak
    ///      621/621'i HAYATTA BIRAKIYORDU. Sebep de tam olarak `out-frozen/`in
    ///      var olma sebebiydi: `out/`u IKI derleme isi yazar, hangisinin
    ///      kazandigi CAGRI SIRASINA baglidir, dolayisiyla mutant bazen dogru
    ///      baytlari okur ve kapi "gecer" -- ve bir incelemeci bu hayaleti
    ///      GERCEKTEN yasadi: bir restore'dan sonra `out/` bir mutantin
    ///      bytecode'unu tutuyordu.
    ///
    ///      AYRIM SU: bu hata bir BAYT karsilastirmasinin sonucu DEGILDIR,
    ///      REFERANSIN KIMLIGI hakkindadir. `NotTheFrozenBuild` "baytlar
    ///      tutmuyor" der; bu "yanlis dizine bakiyorsun" der, ve ikisini tek
    ///      hataya toplamak teshisi tam da en pahali anda kaybettirirdi.
    error NotTheFrozenArtifactDirectory(string dir, string sawArtifactFor);

    /// @dev "BU KONTRAT ICIN RUNTIME CODEHASH KARSILASTIRMASI GECERSIZ."
    ///      Yeniden kullanim kararinin ALTINDAKI on kosul: immutable tasiyan
    ///      bir kontratin runtime kodu CONSTRUCTOR ARGUMANLARINA baglidir,
    ///      dolayisiyla artifact'in `deployedBytecode`u zincirdekiyle ASLA
    ///      esitlenemez (`LaunchFactory`: 6 aralik, olculdu). Sessizce
    ///      "esitlemedi, demek ki yabanci" demek YANLIS TESHIS uretirdi;
    ///      ON KOSULUN KENDISI iddia edilir ve saglanmazsa kapi duser.
    error FrozenArtifactHasImmutables(string what);

    /// @dev "BU AGAC, ZINCIRDEKI ESCROW'U URETEMIYOR." Adres defterinin
    ///      kaydettigi initcode hash'i ile bu agacin derledigi initcode
    ///      AYRISTI.
    error AddressBookDisagrees(string field, bytes32 recorded, bytes32 built);

    function predict(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, keccak256(initcode)))))
        );
    }

    /// @dev ARGUMAN SIRASI: (escrow, treasury, governor, T, V, S).
    ///      **T, V'DEN ONCE GELIR.** Faz 1c'nin kayda gecirdigi "derlenen bir
    ///      hata": ikisi de uint256'dir, takas derleyiciden gecer. BUGUN
    ///      fail-closed'dir -- T = 4_292e15 ile `S >= T` olur ve constructor
    ///      `DegenerateProfile()` doner (olculdu) -- ama bu KAZA ESERI
    ///      dogrudur, tasarim geregi degil, cunku baska bir profil ciftinde
    ///      takas gecerli bir profil uretebilir. Kemer: `assertAsDeployed`
    ///      deploy edilmis factory'den GERI OKUR.
    function build(uint256 chainId, Profile memory p, address deployer, address governor, address treasury)
        internal
        pure
        returns (Plan memory plan)
    {
        plan.chainId = chainId;
        plan.profile = p;
        plan.deployer = deployer;
        plan.governor = governor;
        plan.treasury = treasury;

        plan.escrowSalt = ESCROW_SALT;
        plan.factorySalt = FACTORY_SALT;

        // FeeEscrow'un CONSTRUCTOR ARGUMANI YOKTUR (olculdu: kaynakta sifir
        // `constructor` gecisi), yani initcode'u salt creation code'dur ve
        // adresi ayni salt ile HER ZINCIRDE AYNIDIR. Adres defterinin bu
        // ozelligi tasiyan TEK uyesidir; factory tasimaz, cunku argumanlarinin
        // ucu zincire ozgudur.
        plan.escrowInitcode = type(FeeEscrow).creationCode;
        plan.escrow = predict(ESCROW_SALT, plan.escrowInitcode);

        // `FeeSchedule` de CONSTRUCTOR ARGUMANSIZDIR, yani escrow gibi adresi
        // ayni salt ile her zincirde aynidir. Factory'DEN ONCE gelmek
        // ZORUNDADIR: factory'nin constructor'i onun KODUNU kontrol eder.
        plan.feeScheduleSalt = FEE_SCHEDULE_SALT;
        plan.feeScheduleInitcode = type(FeeSchedule).creationCode;
        plan.feeSchedule = predict(FEE_SCHEDULE_SALT, plan.feeScheduleInitcode);

        plan.factoryInitcode = abi.encodePacked(
            type(LaunchFactory).creationCode, factoryArgs(plan.escrow, treasury, governor, p, plan.feeSchedule)
        );
        plan.factory = predict(FACTORY_SALT, plan.factoryInitcode);
    }

    /// @dev ARGUMAN KODLAMASI TEK YERDE. Ikinci bir `abi.encode(...)` cagrisi
    ///      -- ornegin `frozenFactoryAddress` icinde -- sessizce ayrisabilirdi
    ///      ve ayrisma dogrudan FABRIKA ADRESI demektir. Sira burada da
    ///      TASIYICIDIR: `T`, `V`den ONCE gelir.
    /**
     * @dev BUYBACK KABLOLAMASI BURAYA GIRMEZ, VE GIRMEMESI BIR TASARIM
     *      KARARIDIR -- ihmal degil.
     *
     *      `buybackTreasury` governor'in BIR KEZ yazdigi bir storage
     *      degiskenidir, constructor argumani DEGILDIR. Gerekce
     *      `LaunchFactory.buybackTreasury`nin NatSpec'inde: kasa fabrikanin
     *      adresini constructor'inda alir, hazine kasanin ve fabrikanin;
     *      fabrika da hazinenin alsaydi ucu birden birbirinin initcode'una
     *      girerdi ve hicbir CREATE2 on-tahmini o dongüyü cozemezdi.
     *
     *      KAZANC ADRES KARARLILIGIDIR VE BURADA OLCULUR: fabrikanin ADRESI
     *      buyback kablolamasindan BAGIMSIZ kalir. Hook'un madenlenmis tuzu
     *      fabrika adresine bagli oldugu icin, aksi halde hazineyi degistirmek
     *      -- ya da yalnizca onu SONRADAN baglamak -- hook'u yeniden
     *      madenlemeyi gerektirirdi, ve hook adresi her `PoolKey`in bir alani
     *      oldugu icin ilk graduation'dan sonra bu ARTIK MUMKUN DEGILDIR.
     *
     *      Dolayisiyla buyback'i acan nesil fabrikanin adresini KIMILDATMAZ:
     *      once `BuybackVestingVault` (fabrika adresini ON-TAHMINLE alir),
     *      sonra `BuybackTreasury`, sonra `setBuybackTreasury`. Uc adim, tek
     *      adres.
     */
    function factoryArgs(address escrow_, address treasury, address governor, Profile memory p, address feeSchedule_)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            escrow_, treasury, governor, p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply, feeSchedule_
        );
    }

    /// @notice Uc adres de, YAYINLANACAK BAYTLARDAN turetilmis: creation code
    ///         `out-frozen/`dan okunur, `type(...).creationCode`tan DEGIL.
    ///
    /// @dev NICIN AYRI BIR TURETME VAR. `type(X).creationCode` CAGIRAN
    ///      DERLEME BIRIMININ ayarina baglidir, ve bu depoda o ayar tek degil:
    ///      `lib/v4-core/src/PoolManager.sol`u ismiyle import eden her birim
    ///      `optimizer_runs = 44444444`e duser, otekiler 800'de kalir.
    ///      `Deploy.s.sol` 800'dur (olculdu: `out/Deploy.s.sol/Deploy.json`),
    ///      `DeployPool.s.sol` 44444444'tur -- yani ikisi
    ///      `type(LaunchFactory).creationCode`u FARKLI gorur ve FARKLI bir
    ///      fabrika adresi hesaplar. Havuz katmani fabrikanin adresini
    ///      `ArcpadHook`un constructor argumani olarak KALICI bicimde
    ///      gomdugu icin, o adres BIRIM-BAGIMSIZ olmak zorundadir.
    ///
    /// @dev `out-frozen/` tam olarak bunu verir: yalnizca `[profile.frozen]`in
    ///      yazabildigi, 800 ayarli dizin -- ve `assertMatchesFrozenBuild`
    ///      `Deploy.s.sol`un yayinlayacagi baytlarin AYNEN o dizindekiler
    ///      oldugunu zaten iddia eder. Yani bu turetme "fabrika hangi adreste
    ///      YAYINLANACAK" sorusunun cevabidir, "bu birim onu nerede
    ///      hesaplardi" sorusunun degil.
    function frozenFactoryAddress(uint256 chainId) internal view returns (address) {
        Profile memory p = Profiles.forChain(chainId);
        (address governor, address treasury) = Profiles.governanceForChain(chainId);
        bytes memory initcode = abi.encodePacked(
            _frozenCreationCode(FROZEN_DIR, "LaunchFactory"),
            factoryArgs(frozenEscrowAddress(), treasury, governor, p, frozenFeeScheduleAddress())
        );
        return predict(FACTORY_SALT, initcode);
    }

    /// @dev `FeeEscrow` ve `FeeSchedule` constructor argumansizdir, yani
    ///      adresleri ZINCIRDEN BAGIMSIZDIR -- parametre almamalarinin sebebi
    ///      budur.
    function frozenEscrowAddress() internal view returns (address) {
        return predict(ESCROW_SALT, _frozenCreationCode(FROZEN_DIR, "FeeEscrow"));
    }

    function frozenFeeScheduleAddress() internal view returns (address) {
        return predict(FEE_SCHEDULE_SALT, _frozenCreationCode(FROZEN_DIR, "FeeSchedule"));
    }

    function assertDeployable(Plan memory plan) internal view {
        // IKI AYRI DURUM, IKI AYRI HATA. "Deployer hic yok" (yeni bir zincir)
        // ile "adreste baska bir sey var" operator icin ayni sey degildir.
        if (CREATE2_FACTORY.code.length == 0) {
            revert Create2DeployerMissing(CREATE2_FACTORY, 0);
        }
        if (CREATE2_FACTORY.codehash != CREATE2_FACTORY_CODEHASH) {
            revert Create2DeployerNotCanonical(CREATE2_FACTORY, CREATE2_FACTORY_CODEHASH, CREATE2_FACTORY.codehash);
        }
        if (plan.deployer.balance < MIN_DEPLOYER_BALANCE) {
            revert InsufficientDeployerBalance(plan.deployer, plan.deployer.balance, MIN_DEPLOYER_BALANCE);
        }
        _assertInitcodeEncodesThePlan(plan);
        assertMatchesFrozenBuild(plan);
        _assertMultisig("governor", plan.governor);
        _assertMultisig("treasury", plan.treasury);
        assertVacantOrTheFrozenBuildIn(plan, FROZEN_DIR);
        assertEscrowMatchesTheAddressBook(plan);
        if (plan.factory.code.length != 0) revert AlreadyDeployed("LaunchFactory", plan.factory);
    }

    /// @dev ARC'IN DEFTERI HER ZINCIRI BAGLAR, VE BU BIR TAKLA DEGIL OLCULMUS
    ///      BIR OZELLIKTIR: `FeeEscrow`un constructor argumani yoktur,
    ///      dolayisiyla adresi ayni salt ile HER ZINCIRDE AYNIDIR -- defterin
    ///      bu ozelligi tasiyan TEK uyesi (`test_theEscrowAddressIsChainIndependent`).
    ///      Bu yuzden burada "bu zincirin defteri VARSA karsilastir" gibi bir
    ///      ATLAMA DALI YOKTUR; tek bir kayit her yolu baglar.
    string internal constant ARC_ADDRESS_BOOK = "deploy/addresses.5042002.json";

    /// @notice Bu agacin derledigi escrow, ZINCIRDEKI escrow'dur.
    ///
    /// @dev BU IDDIA `assertMatchesFrozenBuild`IN YAPAMADIGI SEYI YAPAR, VE
    ///      FARK "REFERANSIN NEREDEN GELDIGI"DIR. `out-frozen/` bu agactan
    ///      TURETILIR: `make frozen-hash` onu her cagrida yeniden uretir, ve
    ///      `Makefile`in `test: frozen-hash` on kosulu bunu otomatik yapar --
    ///      yani kaynak degistiginde referans ONUNLA BIRLIKTE hareket eder ve
    ///      iddia sessizce tatmin olur (olculdu: `FeeSchedule` 95 -> 94 ile
    ///      kapi YESIL, `Deploy.t.sol` 53/53). `deploy/addresses.5042002.json`
    ///      ise GECMIS BIR YAYINDAN kalan bir kayittir; bu agactan yeniden
    ///      URETILEMEZ, dolayisiyla kaynakla birlikte HAREKET ETMEZ.
    ///
    /// @dev DURDURDUGU ARIZA, TAM OLARAK: `FeeEscrow.sol`da bir baytlik bir
    ///      degisiklik initcode'u, o da `predict(ESCROW_SALT, ...)` ile ADRESI
    ///      kaydirir. Yeni adres BOSTUR, yani ne `AlreadyDeployed` ne de
    ///      yeniden-kullanim kolu tetiklenir; deploy IKINCI bir escrow indirir,
    ///      yeni factory ona baglanir, ve canli escrow'daki
    ///      152.069.146.725.900.635 wei ile her `owed[]` girisi YETIM KALIR.
    ///      Sessiz, geri donusu yok, ve broadcast'e kadar hicbir sey kirmizi
    ///      olmaz. Bu satir orada durur.
    function assertEscrowMatchesTheAddressBook(Plan memory plan) internal view {
        assertEscrowMatchesTheAddressBookIn(plan, ARC_ADDRESS_BOOK);
    }

    /// @dev MEKANIZMA POLITIKADAN AYRI -- `Profiles.readFrom`un aynisi ve ayni
    ///      sebeple: negatif testin GERCEK bir tahrif edilmis defter
    ///      yurutebilmesi gerekir.
    function assertEscrowMatchesTheAddressBookIn(Plan memory plan, string memory path) internal view {
        string memory json = vm.readFile(path);

        bytes32 recorded = vm.parseJsonBytes32(json, ".escrowInitcodeHash");
        bytes32 built = keccak256(plan.escrowInitcode);
        if (recorded != built) revert AddressBookDisagrees("escrowInitcodeHash", recorded, built);

        address recordedEscrow = vm.parseJsonAddress(json, ".feeEscrow");
        if (recordedEscrow != plan.escrow) {
            revert AddressBookDisagrees(
                "feeEscrow", bytes32(uint256(uint160(recordedEscrow))), bytes32(uint256(uint160(plan.escrow)))
            );
        }
    }

    /// @notice `FeeEscrow` ve `FeeSchedule` icin: adres ya BOSTUR ya da
    ///         UZERINDE TAM OLARAK BIZIM DERLEMEMIZ vardir.
    ///
    /// @dev NICIN VAR. Faz 2'nin deploy'u Arc testnet'te `AlreadyDeployed`
    ///      ile DUSUYORDU ve dusme sebebi bir hata degil bir GERCEKTI:
    ///      `FeeEscrow`un constructor argumani yoktur, yani adresi
    ///      `predict(ESCROW_SALT, creationCode)`tir ve o adres --
    ///      `0xEEd4431e...` -- ZATEN CANLIDIR, 152.069.146.725.900.635 wei
    ///      alacak tasiyor. Faz 2 YENI bir factory deploy eder ama AYNI
    ///      escrow'u kullanmak ZORUNDADIR; ikinci bir escrow deploy etmek
    ///      canli alacaklarin tamamini yetim birakirdi.
    ///
    /// @dev YENIDEN KULLANIM ANCAK KIMLIK KANITLANDIGINDA GUVENLIDIR, ve
    ///      guvenlik ozelligi TAM OLARAK BU AYRIMDIR. "Kod var, devam et"
    ///      demek kapiyi tamamen kaldirmakti: o adreste baska bir kontrat
    ///      olsaydi factory onu escrow olarak baglar, `LaunchFactory`nin
    ///      `owed(address(0))` yoklamasi da (dolgun bir fallback ile)
    ///      atlatilabilirdi. Bu yuzden karsilastirilan sey KOD VARLIGI degil
    ///      RUNTIME CODEHASH'IDIR, ve referans `out-frozen/`dir -- yani
    ///      YALNIZCA `[profile.frozen]`in yazabildigi dizin.
    ///
    /// @dev ON KOSUL IDDIA EDILIR, VARSAYILMAZ: bu karsilastirma yalnizca
    ///      IMMUTABLE TASIMAYAN bir kontrat icin gecerlidir. `FeeEscrow` ve
    ///      `FeeSchedule` icin solc sifir aralik bildirir (olculdu);
    ///      `LaunchFactory` icin ALTI bildirir ve o yuzden bu yola HIC
    ///      girmez -- onun kolu `AlreadyDeployed` olarak KATI kalir, cunku
    ///      bir factory adresinde kod bulmak "bu plan zaten deploy edilmis"
    ///      demektir ve operatorun bunu SESSIZCE gecmesi istenmez.
    function assertVacantOrTheFrozenBuildIn(Plan memory plan, string memory dir) internal view {
        _assertVacantOrTheFrozenBuild(dir, "FeeEscrow", plan.escrow);
        _assertVacantOrTheFrozenBuild(dir, "FeeSchedule", plan.feeSchedule);
    }

    function _assertVacantOrTheFrozenBuild(string memory dir, string memory name, address at) private view {
        if (at.code.length == 0) return;
        bytes32 want = _frozenRuntimeCodehash(dir, name);
        bytes32 got = at.codehash;
        if (want != got) revert OccupiedByAForeignBuild(name, at, want, got);
    }

    /// @dev `immutableReferences` ANAHTARI HIC BULUNMAYABILIR ve bu, sifir
    ///      immutable demektir (olculdu: `FeeEscrow`da anahtar YOK,
    ///      `LaunchFactory`de alti aralikli bir nesne var). Ucu de ayri ayri
    ///      ele alinir; "anahtar yoksa atla" ile "anahtar var ve bos"
    ///      arasindaki farki gormeyen bir kontrol, sessizce her seyi kabul
    ///      ederdi.
    function _frozenRuntimeCodehash(string memory dir, string memory name) private view returns (bytes32) {
        _assertFrozenArtifactDirectory(dir);
        string memory path = string.concat(dir, "/", name, ".sol/", name, ".json");
        string memory json = vm.readFile(path);
        if (vm.keyExistsJson(json, ".deployedBytecode.immutableReferences")) {
            if (vm.parseJsonKeys(json, ".deployedBytecode.immutableReferences").length != 0) {
                revert FrozenArtifactHasImmutables(name);
            }
        }
        bytes memory code = vm.parseJsonBytes(json, ".deployedBytecode.object");
        if (code.length == 0) revert FrozenArtifactMissing(path);
        return keccak256(code);
    }

    /// @dev BASILAN SAYILARIN GERCEKTEN DEPLOY EDILECEK SAYILAR OLDUGUNU
    ///      KANITLAR -- ve `assertDeployable` icinde durdugu icin bunu HEM
    ///      `plan()` HEM `run()` yapar, HERHANGI BIR SEY DEPLOY EDILMEDEN ONCE.
    ///
    /// @dev NICIN GEREKLI. `_print`, `V`yi `p.profile`den, initcode hash'ini
    ///      ise `keccak256(p.factoryInitcode)`ten okur; bu ikisinin AYNI SEYI
    ///      soyledigini `plan()` yolunda hicbir sey iddia etmiyordu. `build`
    ///      icinde `V`yi sabitleyen bir hata (mutant D14) kuru kosuda
    ///      `V 4292000000000000000` yazdirip yanina 4292000000000000000000'e
    ///      baglanan bir initcode hash'i koyardi -- ve basilan adres de hash de
    ///      KENDI ICINDE TUTARLI olurdu. Yani operatorun inceledigi ciktinin
    ///      KENDISI yalan soyleyebilirdi. Brief'in 6. adimi tam olarak bu
    ///      ciktiyi inceleme delili yaptigi icin bu bir teshis bosluğundan
    ///      fazlasidir.
    ///
    /// @dev BU, GERI OKUMANIN YERINI ALMAZ; ONDAN ONCE GELIR. `assertAsDeployed`
    ///      deploy EDILMIS kontrattan okur (dolayisiyla constructor'in gercekten
    ///      ne sakladigini gorur); bu ise deploy EDILECEK baytlari cozer. Ikisi
    ///      birlikte "plan -> initcode -> deploy edilmis kontrat" zincirinin her
    ///      iki halkasini da kapatir.
    function _assertInitcodeEncodesThePlan(Plan memory plan) private pure {
        // Escrow'un initcode'u SALT creation code'dur; argumani yoktur.
        if (keccak256(plan.escrowInitcode) != keccak256(type(FeeEscrow).creationCode)) {
            revert InitcodeDoesNotEncodeThePlan("escrowInitcode");
        }

        bytes memory initcode = plan.factoryInitcode;
        if (initcode.length <= FACTORY_ARG_BYTES) revert InitcodeDoesNotEncodeThePlan("factoryInitcodeLength");

        bytes memory tail = new bytes(FACTORY_ARG_BYTES);
        uint256 start = initcode.length - FACTORY_ARG_BYTES;
        for (uint256 i = 0; i < FACTORY_ARG_BYTES; ++i) {
            tail[i] = initcode[start + i];
        }
        (address escrow_, address treasury_, address governor_, uint256 t, uint256 v, uint256 s, address schedule_) =
            abi.decode(tail, (address, address, address, uint256, uint256, uint256, address));

        if (escrow_ != plan.escrow) revert InitcodeDoesNotEncodeThePlan("escrow");
        if (treasury_ != plan.treasury) revert InitcodeDoesNotEncodeThePlan("treasury");
        if (governor_ != plan.governor) revert InitcodeDoesNotEncodeThePlan("governor");
        if (t != plan.profile.virtualTokenReserves) revert InitcodeDoesNotEncodeThePlan("T");
        if (v != plan.profile.virtualQuoteReserves) revert InitcodeDoesNotEncodeThePlan("V");
        if (s != plan.profile.saleSupply) revert InitcodeDoesNotEncodeThePlan("S");
        if (schedule_ != plan.feeSchedule) revert InitcodeDoesNotEncodeThePlan("feeSchedule");
    }

    /// @dev EOA REDDEDILIR VE SEBEBI YAPISALDIR: bir EOA'nin `getThreshold()`
    ///      uyesi yoktur. Kontrat DEGISMEZ: `LaunchFactory` bilerek musamahali
    ///      kalir (ciplak bir `BondingCurve` icin ve testlerde EOA governor
    ///      mesrudur); politika deploy katmanindadir.
    ///
    /// @dev KOD UZUNLUGU KONTROLU `try`DEN ONCE GELIR VE GEREKLIDIR. Plan bu
    ///      satiri TASIMIYORDU ve gerekcesi soyleydi: "solc'un extcodesize
    ///      kontrolu cagriyi revert ettirir ve `catch` `NotAMultisig` uretir."
    ///      OLCULDU VE YANLIS. Kodsuz bir adrese yapilan `try` cagrisinda
    ///      extcodesize kontrolu CAGIRANIN ICINDE bos veriyle revert eder,
    ///      yani `catch` HIC CALISMAZ: donen veri `0x`tir, `NotAMultisig`
    ///      degil. (Ayni yoklama KODU OLAN ama Safe OLMAYAN bir adres icin
    ///      plandaki gibi calisir: donen veri `0x3ba18bfc...`, yani
    ///      `NotAMultisig`.) Bu satir olmadan deploy YINE fail-closed olurdu --
    ///      ama ISIMSIZ bos bir revert ile, ve operator icin "governor bir
    ///      multisig degil" ile "bir sey patladi" arasindaki fark tam olarak
    ///      bu satirdir. Mutant D16 bunu olcer.
    function _assertMultisig(string memory role, address account) private view {
        if (account.code.length == 0) revert NotAMultisig(role, account);

        try ISafeProbe(account).getThreshold() returns (uint256 threshold) {
            if (threshold < MIN_SAFE_THRESHOLD) revert MultisigThresholdTooLow(role, account, threshold);
        } catch {
            revert NotAMultisig(role, account);
        }
        try ISafeProbe(account).getOwners() returns (address[] memory owners) {
            if (owners.length < MIN_SAFE_OWNERS) revert MultisigTooFewOwners(role, account, owners.length);
        } catch {
            revert NotAMultisig(role, account);
        }
    }

    /// @dev `new C{salt:}` DEGIL, DEPLOYER'A ACIK CAGRI. Sebep olculebilir:
    ///      `forge test` icinde `new C{salt:}` CREATE2 opcode'unu CAGIRAN
    ///      KONTRATTA calistirir, `forge script --broadcast` ise deterministik
    ///      deployer uzerinden gonderir -- IKI FARKLI ADRES. Acik cagri ikisini
    ///      AYNI yapar; bedeli test fixture'inda tek bir `vm.etch`tir. Aksi
    ///      halde prova, canli kosunun hic uretmeyecegi bir adresi dogrulardi.
    function deploy(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initcode));
        if (!ok || ret.length != 20) revert Create2Failed(salt);
        deployed = address(bytes20(ret));
    }

    /// @notice Zaten oradaysa yeniden kullan, degilse deploy et.
    /// @dev BU FONKSIYON HICBIR KARAR VERMEZ VE VERMEMELIDIR. Yeniden
    ///      kullanimin GUVENLI oldugu `assertVacantOrTheFrozenBuildIn`de
    ///      KANITLANIR ve o iddia `assertDeployable`in icinde, HERHANGI BIR
    ///      SEY YAYINLANMADAN ONCE kosar. Burada bir kimlik kontrolu daha
    ///      yazmak, kararı iki yere bolerek birinin gevsetilmesini
    ///      gorunmez kilardi; `expected.code.length` ise CREATE2'nin
    ///      determinizmi geregi o iddianin baktigi adresin AYNISINI okur.
    function deployIfAbsent(bytes32 salt, bytes memory initcode, address expected) internal returns (address) {
        if (expected.code.length != 0) return expected;
        return deploy(salt, initcode);
    }

    /// @notice Yayinlanmak uzere olan baytlar, DONDURULMUS DERLEMENIN
    ///         urettigi baytlardir.
    ///
    /// @dev BUNUN NEDEN AYRI BIR IDDIA OLDUGU, VE `_assertInitcodeEncodesThePlan`IN
    ///      NEDEN YETMEDIGI. O fonksiyon `plan.factoryInitcode`i
    ///      `type(LaunchFactory).creationCode` ile karsilastirir -- ve
    ///      `plan.factoryInitcode` ZATEN ondan uretilmistir. IKI TARAF AYNI
    ///      DERLEMEDEN GELIR, dolayisiyla o derleme yanlissa IKISI BIRDEN
    ///      kayar ve iddia SESSIZCE gecer. Bu, deponun kendi adlandirdigi
    ///      "test edilen seyi ATLAYAN bir yoldan gecen iddia" kipidir ve bu
    ///      hafta bir gune mal oldu: `optimizer_runs` 800 -> 44444444
    ///      kaymasinda `out/` altindaki HER SEY birlikte hareket etti ve
    ///      hicbir sey kirmizi olmadi.
    ///
    /// @dev BU YUZDEN REFERANS `out/` DEGIL `out-frozen/`DIR. `out/`u IKI
    ///      derleme isi yazar (`ArcpadLockerTest` 44444444'te derlenir ve
    ///      `BondingCurve`u import eder), hangisinin kazandigi CAGRI SIRASINA
    ///      baglidir. `out-frozen/`e yalnizca `[profile.frozen]` yazabilir.
    ///
    /// @dev ESITLIK, ICERME DEGIL -- VE ESITLIK KATI OLARAK DAHA GUCLUDUR.
    ///      `frozen_bytecode_gate.py` "fabrika, dondurulmus `BondingCurve`
    ///      initcode'unu ICERIYOR" der. Burada `LaunchFactory`nin creation
    ///      code'unun KENDISI bayt bayt esitlenir: esitse, ICERDIGI her sey de
    ///      -- gomulu `BondingCurve` ve `LaunchToken` initcode'lari dahil --
    ///      zorunlu olarak esittir. Icerme aramasi ayrica ~30KB x ~8KB'lik bir
    ///      alt-dizi taramasi demekti; esitlik tek bir `keccak256`.
    ///
    /// @dev FABRIKADA BAS KISIM KARSILASTIRILIR, TAMAMI DEGIL: initcode'un son
    ///      `FACTORY_ARG_BYTES` bayti ABI-encode edilmis constructor
    ///      argumanlaridir ve ZINCIRE OZGUDUR. Onlarin dogrulugu
    ///      `_assertInitcodeEncodesThePlan`in isidir; burada derlenen KODUN
    ///      kimligi dogrulanir. `FeeEscrow` ve `FeeSchedule` argumansizdir,
    ///      dolayisiyla onlarda initcode'un TAMAMI esitlenir.
    function assertMatchesFrozenBuild(Plan memory plan) internal view {
        assertMatchesFrozenBuildIn(plan, FROZEN_DIR);
    }

    /// @dev DIZIN PARAMETRELIDIR ve YALNIZCA testin eksik-artifact halini
    ///      surebilmesi icin. Uretim yolu her zaman `assertMatchesFrozenBuild`
    ///      uzerinden gecer ve dizini SABIT verir.
    function assertMatchesFrozenBuildIn(Plan memory plan, string memory dir) internal view {
        // Fabrika: BAS KISIM (creation code) esit olmali.
        bytes memory frozenFactory = _frozenCreationCode(dir, "LaunchFactory");
        if (plan.factoryInitcode.length <= FACTORY_ARG_BYTES) {
            revert InitcodeDoesNotEncodeThePlan("factoryInitcodeLength");
        }
        uint256 headLen = plan.factoryInitcode.length - FACTORY_ARG_BYTES;
        bytes memory head = new bytes(headLen);
        for (uint256 i = 0; i < headLen; ++i) {
            head[i] = plan.factoryInitcode[i];
        }
        bytes32 want = keccak256(frozenFactory);
        bytes32 got = keccak256(head);
        if (want != got) _frozenMismatch("LaunchFactory", want, got);

        // Argumansiz ikili: initcode'un TAMAMI esit olmali.
        want = keccak256(_frozenCreationCode(dir, "FeeEscrow"));
        got = keccak256(plan.escrowInitcode);
        if (want != got) _frozenMismatch("FeeEscrow", want, got);

        want = keccak256(_frozenCreationCode(dir, "FeeSchedule"));
        got = keccak256(plan.feeScheduleInitcode);
        if (want != got) _frozenMismatch("FeeSchedule", want, got);
    }

    /// @dev HATA SELECTOR'U DEGISMEDI; ONUNDE BIR SATIR VAR, VE O SATIR BIR
    ///      YANLIS KIRMIZIYI ONLEMEK ICIN.
    ///
    ///      OLCULDU: `forge test` `out-frozen/`i YENIDEN DERLEMEZ -- onu
    ///      yalnizca `make frozen-hash` yazar. Bir kaynagi degistirip geri
    ///      alan, sonra CIPLAK `forge test` kosan biri, TEMIZ bir agacta 38
    ///      `NotTheFrozenBuild` hatasi gorur. Hatalarin hicbiri agac hakkinda
    ///      bir sey soylemez; hepsi referansin bayat oldugunu soyler. Boyle
    ///      bir kirmizi, kapiya guvenmemeyi ogretir -- ve bu depoda "insanlarin
    ///      gormezden gelmeye alistigi bir kapi, hic olmayan bir kapidan
    ///      KOTUDUR" iki kez olculdu.
    ///
    ///      METIN IKI SEYI BIRDEN SOYLER ve sirasi kasitlidir: once "kapiyi
    ///      kos", cunku vakalarin cogu budur; sonra "hala kirmiziysa PIN'I
    ///      YENIDEN URETME, sebebini bul", cunku gercek bir kayma da tam
    ///      olarak boyle gorunur ve iki durumun ayirt edilme yeri operatordur.
    function _frozenMismatch(string memory what, bytes32 want, bytes32 got) private pure {
        revert NotTheFrozenBuild(what, FROZEN_REMEDY, want, got);
    }

    /// @dev FAIL-CLOSED, VE "ATLA" DALI YOKTUR. Artifact yoksa `vm.readFile`
    ///      REVERT eder; okunabiliyor ama bos ise `FrozenArtifactMissing`
    ///      atilir. Hicbir yolda "kontrol edecek bir sey yok, devam et"
    ///      SONUCU URETILEMEZ -- eksik bir dosyanin sessizce basari olarak
    ///      okunmasi tam olarak bu kapinin engellemek icin var oldugu sey.
    ///
    /// @dev DURUST SINIR: `fs_permissions` tarafindan REDDEDILEN bir okuma ile
    ///      MEVCUT OLMAYAN bir dosya, Solidity tarafindan AYIRT EDILEMEZ --
    ///      ikisi de `vm.readFile` icinde revert eder. Ikisi de fail-closed
    ///      oldugu icin kapinin dogrulugu bundan etkilenmez, ama iki durumu
    ///      ayri hatalarla raporlayamayiz ve bu yazili duruyor.
    function _frozenCreationCode(string memory dir, string memory name) private view returns (bytes memory code) {
        _assertFrozenArtifactDirectory(dir);
        string memory path = string.concat(dir, "/", name, ".sol/", name, ".json");
        code = vm.parseJsonBytes(vm.readFile(path), ".bytecode.object");
        if (code.length == 0) revert FrozenArtifactMissing(path);
    }

    /// @notice OKUNAN DIZININ DONDURULMUS DERLEMENIN DIZINI OLDUGUNU IDDIA
    ///         EDER -- ICERDIGI BAYTLARA BAKMADAN.
    ///
    /// @dev BU KONTROL NEDEN BAYT KARSILASTIRMASI OLAMAZ. `out/` ile
    ///      `out-frozen/` ayni baytlari TUTABILIR ve cogu zaman TUTAR; ayrisma
    ///      yalnizca 44444444'lu is `out/`u en son yazdiginda ortaya cikar,
    ///      yani "baytlar tutuyor mu" sorusu YARISI OLCER, DIZINI DEGIL. Bu
    ///      yuzden iddia dizinin YAPISINA bakar: `[profile.frozen]`
    ///      `src/ArcpadHook.sol`u kaynak kumesinden CIKARIR (v4-core'a ulasir),
    ///      dolayisiyla o artifact dondurulmus dizinde URETILEMEZ. `out/`ta ise
    ///      HER derlemede vardir.
    ///
    /// @dev SKIP LISTESI DEGISIRSE BU AYIRT EDICI DE DEGISIR -- ve o degisiklik
    ///      SESSIZ OLAMAZ: `ArcpadHook`u dondurulmus kumeye sokmak, kisitlari
    ///      bosaltilmis o profilde onu 800'de derlemeye calisirdi ve
    ///      `make frozen-hash` bunu gorurdu. Yine de
    ///      `test_theTwoArtifactDirectoriesAreActuallyDistinguishable` ayirt
    ///      edicinin GERCEKTEN ayirt ettigini her kosuda olcer; onsuz bu kontrol
    ///      bir gun sessizce vakum olurdu.
    function _assertFrozenArtifactDirectory(string memory dir) private view {
        if (vm.isDir(string.concat(dir, "/", NOT_IN_THE_FROZEN_BUILD))) {
            revert NotTheFrozenArtifactDirectory(dir, NOT_IN_THE_FROZEN_BUILD);
        }
    }

    /// @dev DERLEME ZAMANI KONTROLLERININ GOREMEDIGI TEK SINIF: cozulen profil
    ///      ile constructor'a GECIRILEN degerin ayrismasi. Yanlis BUYUKLUKTEKI
    ///      bir `V` yedi korumadan da gecer (olculdu), yani onu yakalayan TEK
    ///      SATIR budur.
    function assertAsDeployed(Plan memory plan) internal view {
        LaunchFactory f = LaunchFactory(plan.factory);
        if (f.VIRTUAL_TOKEN_RESERVES() != plan.profile.virtualTokenReserves) {
            revert ProfileNotAsDeployed("T", plan.profile.virtualTokenReserves, f.VIRTUAL_TOKEN_RESERVES());
        }
        if (f.VIRTUAL_QUOTE_RESERVES() != plan.profile.virtualQuoteReserves) {
            revert ProfileNotAsDeployed("V", plan.profile.virtualQuoteReserves, f.VIRTUAL_QUOTE_RESERVES());
        }
        if (f.SALE_SUPPLY() != plan.profile.saleSupply) {
            revert ProfileNotAsDeployed("S", plan.profile.saleSupply, f.SALE_SUPPLY());
        }
        if (f.escrow() != plan.escrow) revert GovernanceNotAsDeployed("escrow", plan.escrow, f.escrow());
        if (f.governor() != plan.governor) revert GovernanceNotAsDeployed("governor", plan.governor, f.governor());
        if (f.protocolTreasury() != plan.treasury) {
            revert GovernanceNotAsDeployed("treasury", plan.treasury, f.protocolTreasury());
        }
        if (f.graduationTarget() != address(0)) {
            revert GovernanceNotAsDeployed("graduationTarget", address(0), f.graduationTarget());
        }
        if (f.launchCount() != 0) revert ProfileNotAsDeployed("launchCount", 0, f.launchCount());
    }
}
