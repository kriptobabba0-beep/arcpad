// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";

/// @title SurfaceTest
/// @notice Bes kontratin DIS YUZEYINI derleme ciktisindaki ABI'den okuyup
///         beklenen kumeyle IKI YONLU karsilastirir.
///
/// @dev NICIN ISIM SAYMAK YETMEZ. Faz 1b'nin yuzey testleri selector ISMI
///      sayiyordu ve tavani OLCULDU: `issue(address,uint256)` adli bir minter,
///      iki adimli `setMinter`+`mint`, testin prank etmedigi bir adrese kilitli
///      minter, `burn(uint256)`, ve escrow'da `sweep` yerine `collect(address)`
///      -- BESI DE paketi tamamen yesil biraktu. `collect` uydurma degildir;
///      pump.fun'in kendi talimati `collect_creator_fee_v2`'dir. Bir isim
///      listesi yalnizca "bekledigim seyler duruyor mu" diye sorar; butun mesele
///      EKLENMIS bir fonksiyonu gormektir, ve o soruyu ancak TAM ESITLIK sorar.
///
/// @dev UC AYRI PIN, cunku tek basina hicbiri yetmiyor:
///
///      (1) FONKSIYON IMZALARI -- `methodIdentifiers` anahtarlari, iki yonlu tam
///          esitlik. Eksik olan da hata, fazla olan da.
///      (2) HATA ISIMLERI -- `.abi` uzerinde jsonpath filtresi, iki yonlu tam
///          esitlik. Kutuphane katmani hatalari DAHIL; gerekce asagida.
///      (3) GIRDI TURU SAYIMI -- `.abi` icindeki her girisin `type` alani
///          sayilir. (1) ve (2)'nin GORMEDIGI seyi gorur: `receive()` ve
///          `fallback()` bir selector TASIMAZ, dolayisiyla `methodIdentifiers`
///          icinde HIC GORUNMEZLER. `FeeEscrow`'un kisit (1)'i tam olarak
///          "receive()/fallback() YOKTUR" diye yazilmis bir ozelliktir ve (1)
///          ile (2) onu ekleyen bir mutanti yesil birakirdi. Ayni sayim
///          eklenen bir OLAYI ve eklenen bir constructor'i da yakalar.
///
/// @dev CIKARMA MEKANIZMASI: `methodIdentifiers`. Iki aday da BU FOUNDRY
///      SURUMUNDE (forge 1.6.0-rc1) denendi ve ikisi de calisti; secim
///      calismasina degil, DONDURDUKLERI SEYE dayaniyor:
///
///        `vm.parseJsonKeys(j, ".methodIdentifiers")`
///          -> ["bind(address)", "buyExactQuoteIn(uint256)", ...]  (20 giris)
///        `vm.parseJson` + `.abi` uzerinde `type == 'function'` jsonpath
///        filtresi
///          -> ["bind", "buyExactQuoteIn", ...]                    (20 giris)
///
///      Ikinci yol yalnizca ISIM verir; parametre turleri `.inputs[*].type`
///      altinda AYRI bir sorgudadir ve ikisini birlestirmek iki sorgunun
///      indekslerinin ortustugu VARSAYIMINA dayanir -- yani "kimsenin
///      yazmadigi bir sebeple gecen test". Ustelik isim-yalnizca bir kume
///      `deposit(address)` -> `deposit(address,uint256)` degisikligini HIC
///      GORMEZ; bu, Faz 1b'nin "isim sayma" hatasinin cikarma katmaninda
///      yeniden uretilmis halidir. `methodIdentifiers` imzayi solc'un kendisi
///      birlestirmis olarak verir ve ustelik selector'u da tasir -- yani
///      yeniden ayristirma yoktur. Bu yuzden fonksiyonlarda (1) secildi.
///
///      Hatalar icin `methodIdentifiers` KULLANILAMAZ (yalnizca fonksiyon
///      tasir), dolayisiyla (2) zorunlu olarak jsonpath filtresidir. Orada
///      isim-yalnizca olmasi kabul edildi ve acik hucre olarak raporlandi:
///      var olan bir hatanin ARITESINI degistiren bir mutant (`ZeroToken()` ->
///      `ZeroToken(address)`) bu testte gorunmez.
///
/// @dev KUTUPHANE KATMANI HATALARI YUZEYIN PARCASIDIR -- karar ve gerekcesi.
///      `CurveMath`'in hatalari `BondingCurve`'un DECLARE ETTIGI kumede
///      degildir ama derlenen ABI'sinde vardir ve disari propagate olur.
///      Karar: YUZEYIN PARCASIDIR, digerleriyle ayni sekilde iki yonlu
///      pinlenir. Uc gerekce:
///        (a) ULASILABILIRLER. `CurveMath.NetTooSmall()` `buyExactQuoteIn`
///            uzerinden gercekten doner ve BondingCurve.t.sol'da bir
///            `BondingCurve` CAGRISINA karsi zaten iddia ediliyor. Onu
///            `catch` eden bir entegratorun ele almasi gereken bir revert'tir;
///            "yayinlanmis" olmanin tanimi budur.
///        (b) UYELIGI BIZ DEGIL DERLEYICI SECIYOR. solc her kontratin ABI'sine
///            o kontratin fiilen revert edebilecegi kutuphane hatalarini koyar:
///            `BondingCurve` 5'inin hepsini alir, `LaunchFactory` yalnizca
///            2'sini (`InsufficientTokenReserve`, `ZeroReserve`). Disarida
///            birakmak, herkesin okudugu artifact'tan AYRISAN ikinci bir
///            "yuzey" tanimini elde tutmak demek olurdu.
///        (c) ULASILABILIRLIK BELGEDIR, YUZEY DEGIL. Bugun ulasilamayan iki
///            hata da bir selector isgal eder ve ileride ulasilabilir hale
///            gelirse hicbir sey sinyal vermez. Iki yonlu pinlemek, o
///            ULASILABILIRLIK NOTUNUN gozden gecirilmesi gereken sey olmasini
///            saglar -- ve notun durdugu yer bu testtir.
///
/// @dev `CurveMath` NEDEN LISTEDE. Dagitilabilir dort kontrattan biri degil,
///      saf bir kutuphane. Yine de burada, cunku pinlenen iddia BOS OLMASIDIR:
///      `methodIdentifiers` TAM OLARAK BOS olmalidir. Bir `internal`
///      fonksiyonu `public`/`external`e cevirmek kutuphaneyi cagiran her
///      kontratin DELEGATECALL ile baglanmasi gereken, deploy zamaninda ayri
///      bir adres isteyen bir sey haline getirir -- ve bu, hicbir davranis
///      testinin gormedigi bir dagitim degisikligidir. Bos kume iddiasi onu
///      yakalar. Ayrica (b)'nin kaynagi olan bes hatanin listesi de burada
///      pinlenir.
///
/// @dev `LaunchToken`'in "toplam arz sonsuza kadar sabit" iddiasi bugune kadar
///      yalnizca YUKARIDAN pinliydi (`totalSupply() == TOTAL_SUPPLY` gibi
///      olcumler). Iki yonlu esitlik onu ASAGIDAN da pinler: `mint`, `issue`,
///      `burn`, `setMinter` -- adi ne olursa olsun -- fonksiyon kumesine bir
///      GIRIS EKLER ve fazlalik hatadir.
contract SurfaceTest is Test {
    // ---------------------------------------------------------------
    // Cikarma
    // ---------------------------------------------------------------

    /// @dev `fs_permissions` bu faz icin bilerek acildi: salt okuma, yalnizca
    ///      `./out`. Dosya yoksa `vm.readFile` REVERT eder -- yani yanlis
    ///      yazilmis bir kontrat adi testi sessizce bos kumeyle gecirmez,
    ///      kirar. Fail-closed.
    function _artifact(string memory contractName) internal view returns (string memory) {
        return vm.readFile(string.concat("out/", contractName, ".sol/", contractName, ".json"));
    }

    function _functionSignatures(string memory contractName) internal view returns (string[] memory) {
        return vm.parseJsonKeys(_artifact(contractName), ".methodIdentifiers");
    }

    /// @dev Bes kontratin HEPSINDE en az dort hata vardir. Bu onemlidir:
    ///      jsonpath tek bir eslesme dondurdugunde Foundry onu dizi DEGIL
    ///      skaler olarak kodlar ve `abi.decode(..., (string[]))` revert eder.
    ///      Bugunku hicbir kontrat o sinira yakin degil; oraya dusuren bir
    ///      mutasyon zaten testi KIRARDI (decode revert'i basarisizliktir),
    ///      yani sapma yonunde de fail-closed.
    function _errorNames(string memory contractName) internal view returns (string[] memory) {
        return abi.decode(vm.parseJson(_artifact(contractName), "$.abi[?(@.type == 'error')].name"), (string[]));
    }

    /// @dev ABI'deki her girisin `type` alani, sirasiyla. Sayimi cagiran yapar.
    function _entryTypes(string memory contractName) internal view returns (string[] memory) {
        return abi.decode(vm.parseJson(_artifact(contractName), "$.abi[*].type"), (string[]));
    }

    // ---------------------------------------------------------------
    // Iki yonlu kume esitligi
    // ---------------------------------------------------------------

    /// @dev IKI YONLULUK SART. Yalnizca "beklenenlerin hepsi duruyor mu" diye
    ///      bakan bir dongu, EKLENMIS bir fonksiyonu goremez -- ve butun mesele
    ///      odur. Uzunluk esitligi ayrica tutulur: iki yon de tekrarlanan bir
    ///      girisi tek basina yakalayamaz.
    function _assertSetEquals(string[] memory actual, string[] memory expected, string memory label) internal pure {
        for (uint256 i = 0; i < expected.length; i++) {
            assertTrue(_contains(actual, expected[i]), string.concat(label, ": EKSIK -> ", expected[i]));
        }
        for (uint256 i = 0; i < actual.length; i++) {
            assertTrue(_contains(expected, actual[i]), string.concat(label, ": FAZLA -> ", actual[i]));
        }
        assertEq(actual.length, expected.length, string.concat(label, ": eleman sayisi"));
    }

    function _contains(string[] memory set, string memory needle) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(needle));
        for (uint256 i = 0; i < set.length; i++) {
            if (keccak256(bytes(set[i])) == h) return true;
        }
        return false;
    }

    /// @dev `receive`, `fallback`, `constructor` ve `event` girisleri
    ///      `methodIdentifiers` icinde HIC GORUNMEZ; bu sayim onlarin tek
    ///      koruyucusudur.
    function _assertEntryCensus(
        string memory contractName,
        uint256 functions,
        uint256 errors_,
        uint256 events,
        uint256 constructors,
        uint256 receives,
        uint256 fallbacks
    ) internal view {
        string[] memory types = _entryTypes(contractName);
        uint256[6] memory seen;
        for (uint256 i = 0; i < types.length; i++) {
            bytes32 h = keccak256(bytes(types[i]));
            if (h == keccak256("function")) seen[0]++;
            else if (h == keccak256("error")) seen[1]++;
            else if (h == keccak256("event")) seen[2]++;
            else if (h == keccak256("constructor")) seen[3]++;
            else if (h == keccak256("receive")) seen[4]++;
            else if (h == keccak256("fallback")) seen[5]++;
            else revert(string.concat(contractName, ": bilinmeyen ABI giris turu -> ", types[i]));
        }
        assertEq(seen[0], functions, string.concat(contractName, ": function sayisi"));
        assertEq(seen[1], errors_, string.concat(contractName, ": error sayisi"));
        assertEq(seen[2], events, string.concat(contractName, ": event sayisi"));
        assertEq(seen[3], constructors, string.concat(contractName, ": constructor sayisi"));
        assertEq(seen[4], receives, string.concat(contractName, ": receive sayisi"));
        assertEq(seen[5], fallbacks, string.concat(contractName, ": fallback sayisi"));
        assertEq(types.length, functions + errors_ + events + constructors + receives + fallbacks, "toplam giris");
    }

    // ---------------------------------------------------------------
    // Okudugumuz artifact GERCEKTEN test edilen kontrat mi
    // ---------------------------------------------------------------

    /// @dev "Kimsenin yazmadigi bir sebeple gecen test"e karsi bag: yukaridaki
    ///      butun iddialar `out/<C>.sol/<C>.json`'un o kontratin artifact'i
    ///      OLDUGUNU varsayar. Burada varsayilmiyor, olculuyor: `FeeEscrow`
    ///      deploy edilir ve zincirdeki runtime kodu artifact'in
    ///      `deployedBytecode.object`'i ile BAYT BAYT karsilastirilir.
    ///      `FeeEscrow` secildi cunku tek immutable'i ve constructor argumani
    ///      yoktur -- diger dortunde immutable degerleri runtime koduna
    ///      gomuldugu icin esitlik yapisal olarak tutmaz.
    ///      Bagi tek bir kontratta kurmak yeter: dosya adi seman hepsinde ayni.
    function test_artifactPathResolvesToTheContractUnderTest() public {
        FeeEscrow escrow = new FeeEscrow();
        bytes memory onChain = address(escrow).code;
        bytes memory fromArtifact = vm.parseJsonBytes(_artifact("FeeEscrow"), ".deployedBytecode.object");
        assertEq(keccak256(onChain), keccak256(fromArtifact), "artifact != deploy edilen kontrat");
        assertGt(onChain.length, 0, "runtime kod bos");
    }

    // ---------------------------------------------------------------
    // LaunchToken
    // ---------------------------------------------------------------

    /// @dev BU LISTE `LaunchToken`'in ARZ SABITLIGI IDDIASININ ASAGIDAN PINI.
    ///      Icinde `mint` YOK, `issue` YOK, `burn` YOK, `setMinter` YOK --
    ///      ve bu bir dilek degil, iki yonlu esitligin sonucu: adi ne olursa
    ///      olsun yeni bir giris kumeyi buyutur ve `FAZLA` ile kirar.
    function test_launchTokenExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](14);
        expected[0] = "TOTAL_SUPPLY()";
        expected[1] = "allowance(address,address)";
        expected[2] = "approve(address,uint256)";
        expected[3] = "balanceOf(address)";
        expected[4] = "creator()";
        expected[5] = "curve()";
        expected[6] = "decimals()";
        expected[7] = "launchSalt()";
        expected[8] = "metadataURI()";
        expected[9] = "name()";
        expected[10] = "symbol()";
        expected[11] = "totalSupply()";
        expected[12] = "transfer(address,uint256)";
        expected[13] = "transferFrom(address,address,uint256)";
        _assertSetEquals(_functionSignatures("LaunchToken"), expected, "LaunchToken fonksiyonlari");
    }

    function test_launchTokenExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](11);
        // OZ ERC20'nin kendi hatalari -- bizim degil ama YUZEYDE.
        expected[0] = "ERC20InsufficientAllowance";
        expected[1] = "ERC20InsufficientBalance";
        expected[2] = "ERC20InvalidApprover";
        expected[3] = "ERC20InvalidReceiver";
        expected[4] = "ERC20InvalidSender";
        expected[5] = "ERC20InvalidSpender";
        expected[6] = "NameTooLong";
        expected[7] = "SymbolTooLong";
        expected[8] = "UriTooLong";
        expected[9] = "ZeroCreator";
        expected[10] = "ZeroCurve";
        _assertSetEquals(_errorNames("LaunchToken"), expected, "LaunchToken hatalari");
    }

    function test_launchTokenAbiCensus() public view {
        _assertEntryCensus("LaunchToken", 14, 11, 2, 1, 0, 0);
    }

    // ---------------------------------------------------------------
    // FeeEscrow
    // ---------------------------------------------------------------

    /// @dev Faz 1b'nin hayatta kalan besinci mutanti burada oturuyordu:
    ///      `sweep` yerine `collect(address)`. `collect` uydurma degildir --
    ///      pump.fun'in kendi talimati `collect_creator_fee_v2`. Isim sayan
    ///      bir test onu goremez; iki yonlu esitlik `FAZLA -> collect(address)`
    ///      ile kirar.
    function test_feeEscrowExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](4);
        expected[0] = "claim(address)";
        expected[1] = "deposit(address)";
        expected[2] = "owed(address)";
        expected[3] = "totalOwed()";
        _assertSetEquals(_functionSignatures("FeeEscrow"), expected, "FeeEscrow fonksiyonlari");
    }

    function test_feeEscrowExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](4);
        expected[0] = "NothingToClaim";
        expected[1] = "TransferFailed";
        expected[2] = "ZeroAmount";
        expected[3] = "ZeroRecipient";
        _assertSetEquals(_errorNames("FeeEscrow"), expected, "FeeEscrow hatalari");
    }

    /// @dev `receive` = 0 ve `fallback` = 0, `FeeEscrow`'un kisit (1)'inin
    ///      TAM OLARAK ifade ettigi ozellik: duz bir native gonderim
    ///      BASARISIZ OLMALI. `methodIdentifiers` bu ikisini hic gormez,
    ///      dolayisiyla bu sayim onlarin tek koruyucusu.
    ///      `constructor` = 0 cunku kontratin bildirilmis bir constructor'i
    ///      yoktur; eklenmesi de yuzey degisikligidir.
    function test_feeEscrowAbiCensus() public view {
        _assertEntryCensus("FeeEscrow", 4, 4, 2, 0, 0, 0);
    }

    // ---------------------------------------------------------------
    // BondingCurve
    // ---------------------------------------------------------------

    function test_bondingCurveExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](20);
        expected[0] = "CREATOR_FEE_BPS()";
        expected[1] = "INITIAL_REAL_TOKEN_RESERVES()";
        expected[2] = "INITIAL_VIRTUAL_QUOTE_RESERVES()";
        expected[3] = "INITIAL_VIRTUAL_TOKEN_RESERVES()";
        expected[4] = "PROTOCOL_FEE_BPS()";
        expected[5] = "bind(address)";
        expected[6] = "buyExactQuoteIn(uint256)";
        expected[7] = "buyExactTokensOut(uint256,uint256)";
        expected[8] = "complete()";
        expected[9] = "creator()";
        expected[10] = "escrow()";
        expected[11] = "factory()";
        expected[12] = "poolSeedSupply()";
        expected[13] = "protocolTreasury()";
        expected[14] = "realQuoteReserves()";
        expected[15] = "realTokenReserves()";
        expected[16] = "sellExactTokensIn(uint256,uint256)";
        expected[17] = "token()";
        expected[18] = "virtualQuoteReserves()";
        expected[19] = "virtualTokenReserves()";
        _assertSetEquals(_functionSignatures("BondingCurve"), expected, "BondingCurve fonksiyonlari");
    }

    /// @dev Son bes giris `CurveMath`'ten gelir. Yukaridaki karar geregi
    ///      YUZEYIN PARCASIDIR ve isaretlenerek pinlenir; `NetTooSmall`
    ///      ULASILABILIR (`buyExactQuoteIn`), digerleri bugun degildir.
    function test_bondingCurveExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](27);
        expected[0] = "AlreadyBound";
        expected[1] = "CurveComplete";
        expected[2] = "NotBound";
        expected[3] = "NotEnoughTokensToBuy";
        expected[4] = "NotFactory";
        expected[5] = "PayoutFailed";
        expected[6] = "ProceedsTooSmall";
        expected[7] = "RefundFailed";
        expected[8] = "SaleSupplyNotBelowTokenReserves";
        expected[9] = "SlippageExceeded";
        expected[10] = "TokenBalanceBelowSaleAndSeed";
        expected[11] = "TokenDoesNotPointBack";
        expected[12] = "TokenTransferFailed";
        expected[13] = "ZeroEscrow";
        expected[14] = "ZeroQuoteIn";
        expected[15] = "ZeroSaleSupply";
        expected[16] = "ZeroToken";
        expected[17] = "ZeroTokensIn";
        expected[18] = "ZeroTokensOut";
        expected[19] = "ZeroTreasury";
        expected[20] = "ZeroVirtualQuoteReserves";
        expected[21] = "ZeroVirtualTokenReserves";
        // --- CurveMath katmani: ULASILABILIR ---
        expected[22] = "NetTooSmall";
        // --- CurveMath katmani: bugun ULASILAMAZ, yine de yuzeyde ---
        expected[23] = "InsufficientTokenReserve";
        expected[24] = "InvalidBps";
        expected[25] = "ZeroAmount";
        expected[26] = "ZeroReserve";
        _assertSetEquals(_errorNames("BondingCurve"), expected, "BondingCurve hatalari");
    }

    function test_bondingCurveAbiCensus() public view {
        _assertEntryCensus("BondingCurve", 20, 27, 2, 1, 0, 0);
    }

    // ---------------------------------------------------------------
    // LaunchFactory
    // ---------------------------------------------------------------

    function test_launchFactoryExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](12);
        expected[0] = "MIN_GRADUATION_RAISE()";
        expected[1] = "MIN_OPENING_MARKET_CAP()";
        expected[2] = "MIN_SALE_AND_SEED()";
        expected[3] = "SALE_SUPPLY()";
        expected[4] = "VIRTUAL_QUOTE_RESERVES()";
        expected[5] = "VIRTUAL_TOKEN_RESERVES()";
        expected[6] = "escrow()";
        expected[7] = "isCanonical(address)";
        expected[8] = "launch(string,string,string)";
        expected[9] = "launchCount()";
        expected[10] = "predictAddresses(address,string,string,string,uint256)";
        expected[11] = "protocolTreasury()";
        _assertSetEquals(_functionSignatures("LaunchFactory"), expected, "LaunchFactory fonksiyonlari");
    }

    /// @dev `LaunchFactory`'nin NatSpec'i ULASILABILIR dokuzu sayiyor. Buradaki
    ///      kume onbir: solc, bu kontratin fiilen revert edebilecegi iki
    ///      `CurveMath` hatasini da ABI'ye koyuyor (besini degil -- uyeligi
    ///      derleyici seciyor, bkz. dosya bas notu (b)). Ikisi de bugun
    ///      ULASILAMAZ ve isaretlenerek pinleniyor.
    function test_launchFactoryExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](11);
        expected[0] = "DegenerateProfile";
        expected[1] = "EmptyName";
        expected[2] = "EmptySymbol";
        expected[3] = "EscrowHasNoCode";
        expected[4] = "GraduationRaiseTooSmall";
        expected[5] = "SaleAndSeedExceedSupply";
        expected[6] = "SaleAndSeedStrandSupply";
        expected[7] = "ZeroEscrowAddress";
        expected[8] = "ZeroTreasuryAddress";
        // --- CurveMath katmani: bugun ULASILAMAZ, yine de yuzeyde ---
        expected[9] = "InsufficientTokenReserve";
        expected[10] = "ZeroReserve";
        _assertSetEquals(_errorNames("LaunchFactory"), expected, "LaunchFactory hatalari");
    }

    function test_launchFactoryAbiCensus() public view {
        _assertEntryCensus("LaunchFactory", 12, 11, 1, 1, 0, 0);
    }

    // ---------------------------------------------------------------
    // CurveMath
    // ---------------------------------------------------------------

    /// @dev IDDIA BOS KUMEDIR ve bos oldugu icin daha zayif degil, DAHA
    ///      KESKINDIR: `internal` bir fonksiyonu `public`/`external` yapmak
    ///      kutuphaneyi DELEGATECALL ile baglanan, deploy zamaninda ayri bir
    ///      adres isteyen bir sey haline getirir. Hicbir davranis testi bunu
    ///      gormez -- bytecode degisir, sonuclar degismez.
    function test_curveMathExposesNoExternalFunctions() public view {
        _assertSetEquals(_functionSignatures("CurveMath"), new string[](0), "CurveMath fonksiyonlari");
    }

    /// @dev `BondingCurve` ve `LaunchFactory`'nin ABI'sinde gorunen kutuphane
    ///      hatalarinin KAYNAK listesi. Burada eksilme/artma, oradaki iki
    ///      kumeyi de sessizce kaydirirdi.
    function test_curveMathExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](5);
        expected[0] = "InsufficientTokenReserve";
        expected[1] = "InvalidBps";
        expected[2] = "NetTooSmall";
        expected[3] = "ZeroAmount";
        expected[4] = "ZeroReserve";
        _assertSetEquals(_errorNames("CurveMath"), expected, "CurveMath hatalari");
    }

    function test_curveMathAbiCensus() public view {
        _assertEntryCensus("CurveMath", 0, 5, 0, 0, 0, 0);
    }
}
