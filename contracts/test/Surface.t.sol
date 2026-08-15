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
/// @dev BU DOSYA "IMZA SAYAN" HALINDEN BIR TUR DAHA ILERI GOTURULDU, cunku ilk
///      hali AYNI HATANIN BIR KATMAN ASAGISINI yapiyordu: `methodIdentifiers`
///      anahtarlari imzayi tasir ama MUTABILITE'yi, DONUS TIPINI, hata
///      ARITESINI ve olaylarin KIMLIGINI tasimaz. INCELEMEDE OLCULDU (bu
///      dosyanin imza-yalnizca halinde): `claim(address) external` ->
///      `external payable`, `sellExactTokensIn` -> `payable`, `claim` ->
///      `returns (uint256)`, ayni imzali bir `public` mapping getter'i,
///      `Trade`in `indexed trader`ini indekssiz yapmak, `Deposited`i
///      `FeeCredited` diye yeniden adlandirmak, `Claimed`e ucuncu bir parametre
///      eklemek ve `TokenTransferFailed()` -> `TokenTransferFailed(address)` --
///      SEKIZI DE paketin tamamini yesil birakiyordu.
///      SEKIZI DE ARTIK OLUYOR ve her biri YALNIZCA asagidaki pinlerden birine
///      dusuyor; olcumler task-4-report.md §S-tur-2'de.
///
/// @dev BES AYRI PIN, cunku tek basina hicbiri yetmiyor:
///
///      (1) FONKSIYON IMZALARI -- `methodIdentifiers` anahtarlari, iki yonlu
///          tam esitlik. Eksik olan da hata, fazla olan da.
///      (2) FONKSIYON TANIMLAYICILARI -- `imza <mutabilite> -> (donus tipleri)`,
///          iki yonlu. `payable` kazanan bir `claim`i, `returns` kazanan bir
///          fonksiyonu ve durum degistiren bir fonksiyonun ayni imzali bir
///          `public` mapping getter'iyla degistirilmesini (mutabilite `view`e
///          duser) bu yakalar. Constructor'in kendi tanimlayicisi da buraya
///          dahildir: `LaunchToken`in constructor ARGUMAN SIRASI
///          `LaunchFactory.isCanonical`in CREATE2 turetmesinde tasiyicidir.
///      (3) HATA TANIMLAYICILARI -- `Ad(girdi tipleri)`, iki yonlu. ARITE
///          BURADA KAPANIR: `TokenTransferFailed()` -> `...(address)` gorunur.
///      (4) OLAY TANIMLAYICILARI -- `Ad(tipler) indexed:(indeksli parametre
///          ADLARI)`, iki yonlu. Olay adini, aritesini, tiplerini ve HANGI
///          parametrenin indeksli oldugunu birlikte sabitler. Faz 3'un
///          indexer'i topic duzenine baglidir: `indexed` kaldirmak her
///          `getLogs` filtresini SESSIZCE bos dondurur.
///      (5) GIRDI TURU SAYIMI -- `.abi` icindeki her girisin `type` alani
///          sayilir. (1)-(4)'un GORMEDIGI seyi gorur: `receive()` ve
///          `fallback()` bir selector TASIMAZ ve `methodIdentifiers` icinde HIC
///          GORUNMEZ. `FeeEscrow`un kisit (1)'i tam olarak "receive()/fallback()
///          YOKTUR" diye yazilmis bir ozelliktir.
///      (6) CURVE'UN BYTECODE'UNDAKI BAGIMLILIK -- (1)-(5) YUZEYLERI sabitler,
///          bagimliligin YONUNU sabitlemez. `BondingCurve`in deployed kodunda
///          `graduationTarget()` (0xa4b20f13) ve `protocolTreasury()`
///          (0x803db96d) selector'leri ARANIR: iki uye de curve'e degil
///          FACTORY'ye aittir ve curve deploy edildikten sonra onlara olan
///          bagimliligi degistirilemez.
///      (7) OLAY ADI SAHIPLIGI -- `Graduated` adinin TAM OLARAK BIR kontratta
///          oldugu. Faz 2 ayni adi baska bir sekille kullanirsa topic0 ayrisir
///          ve Faz 3'un filtreleri hata vermeden BOS doner.
///
/// @dev PINLENMEYENLER -- BU DOSYANIN KENDI ACIK HUCRELERI, raporda degil
///      BURADA duruyorlar cunku okuyan kisi dosyanin ne vaat ettigini
///      buradan okur:
///        (a) INDEKSSIZ parametre ADLARI hicbir yerde pinlenmez (fonksiyon,
///            hata ve olay girdileri). Tip ve sira pinlidir; yalnizca
///            `uint256 tokenAmount` -> `uint256 amount` gorunmez. Indeksli olay
///            parametrelerinin adlari pinlidir, cunku topic kimligini onlar
///            tasir.
///        (b) `anonymous` olaylar. ABI'de `"anonymous": true` alani vardir,
///            okunmuyor. arcpad'de anonim olay yoktur.
///        (c) FONKSIYON ADI ASIRI YUKLENMESI (overload) tanimlayici uretimini
///            belirsiz kilardi. Varsayim degil, CALISTIRILABILIR ON KOSUL:
///            asagidaki `_functionDescriptors` her ad icin TAM BIR
///            `stateMutability` sonucu bekler ve overload'da o iddia duser.
///        (d) NatSpec, doc-string ve gorunurluk-disi nitelikler (`virtual`,
///            `override`) ABI'de yoktur ve pinlenemez.
///
/// @dev CIKARMA MEKANIZMASI: fonksiyon IMZALARI icin `methodIdentifiers`,
///      geri kalan her sey icin `.abi` uzerinde jsonpath. Iki aday da BU
///      FOUNDRY SURUMUNDE (forge 1.6.0-rc1) denendi ve ikisi de calisti; secim
///      calismasina degil, DONDURDUKLERI SEYE dayaniyor:
///
///        `vm.parseJsonKeys(j, ".methodIdentifiers")`
///          -> ["bind(address)", "buyExactQuoteIn(uint256)", ...]  (20 giris)
///        `vm.parseJson` + `.abi` uzerinde `type == 'function'` jsonpath
///        filtresi
///          -> ["bind", "buyExactQuoteIn", ...]                    (20 giris)
///
///      Ikinci yol yalnizca ISIM verir; parametre turleri `.inputs[*].type`
///      altinda AYRI bir sorgudadir ve ikisini DUZLESTIRILMIS halde
///      birlestirmek iki sorgunun indekslerinin ortustugu VARSAYIMINA dayanir
///      -- her fonksiyonun girdi SAYISI farkli oldugu icin o varsayim yanlistir
///      ve gruplama geri kurtarilamaz. `methodIdentifiers` imzayi solc'un
///      kendisi birlestirmis olarak verir. Bu yuzden imzalarda (1) secildi.
///
///      (2)-(4)'teki jsonpath sorgulari bu tuzagi ICERMEZ, cunku hepsi TEK BIR
///      UYE uzerinde `name == 'X'` ile filtrelenir ve o uyenin kendi girdi
///      dizisini okur. Duzlestirme yoktur; gruplama sorgunun kendisindedir.
///
/// @dev UC KODLAMA OLCULDU ve `_strings` ucunu de ele alir:
///        eslesme YOK        -> `vm.parseJson` BOS bytes doner (revert ETMEZ)
///        TEK eslesme        -> SKALER string olarak kodlanir (96 bayt)
///        COK eslesme        -> `string[]`
///      Once dizi denenir, olmazsa skaler. Ikisi de tutmazsa cagri revert eder
///      ve test DUSER -- fail-closed.
///
/// @dev KUTUPHANE KATMANI HATALARI YUZEYIN PARCASIDIR -- karar ve gerekcesi.
///      `CurveMath`in hatalari `BondingCurve`un DECLARE ETTIGI kumede
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
///      testinin gormedigi bir dagitim degisikligidir.
///
/// @dev `LaunchToken`in "toplam arz sonsuza kadar sabit" iddiasi bugune kadar
///      yalnizca YUKARIDAN pinliydi. Iki yonlu esitlik onu ASAGIDAN da pinler:
///      `mint`, `issue`, `burn`, `setMinter` -- adi ne olursa olsun -- fonksiyon
///      kumesine bir GIRIS EKLER ve fazlalik hatadir.
contract SurfaceTest is Test {
    // ---------------------------------------------------------------
    // Ham okuma
    // ---------------------------------------------------------------

    /// @dev Dosya yoksa `vm.readFile` REVERT eder -- yani yanlis yazilmis bir
    ///      kontrat adi testi sessizce bos kumeyle gecirmez, kirar.
    function _artifact(string memory contractName) internal view returns (string memory) {
        return vm.readFile(string.concat("out/", contractName, ".sol/", contractName, ".json"));
    }

    /// @dev `abi.decode`u yakalanabilir kilmak icin DIS fonksiyon; `_strings`
    ///      bunu `this.` ile cagirir.
    function decodeStringArray(bytes calldata raw) external pure returns (string[] memory) {
        return abi.decode(raw, (string[]));
    }

    /// @notice Bir jsonpath sorgusunun string sonuclari.
    /// @dev Uc kodlamayi da ele alir; bkz. dosya bas notu.
    function _strings(string memory json, string memory path) internal view returns (string[] memory) {
        bytes memory raw = vm.parseJson(json, path);
        if (raw.length == 0) return new string[](0);
        try this.decodeStringArray(raw) returns (string[] memory many) {
            return many;
        } catch {
            string[] memory one = new string[](1);
            one[0] = abi.decode(raw, (string));
            return one;
        }
    }

    function _join(string[] memory parts) internal pure returns (string memory out) {
        for (uint256 i = 0; i < parts.length; i++) {
            out = i == 0 ? parts[i] : string.concat(out, ",", parts[i]);
        }
    }

    /// @dev `bind(address)` -> `bind`.
    function _nameOf(string memory signature) internal pure returns (string memory) {
        bytes memory b = bytes(signature);
        uint256 n = 0;
        while (n < b.length && b[n] != "(") n++;
        bytes memory name = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            name[i] = b[i];
        }
        return string(name);
    }

    function _member(string memory kind, string memory name) internal pure returns (string memory) {
        return string.concat("$.abi[?(@.type == '", kind, "' && @.name == '", name, "')]");
    }

    // ---------------------------------------------------------------
    // Tanimlayicilar
    // ---------------------------------------------------------------

    function _functionSignatures(string memory contractName) internal view returns (string[] memory) {
        return vm.parseJsonKeys(_artifact(contractName), ".methodIdentifiers");
    }

    /// @dev `imza <mutabilite> -> (donus tipleri)`.
    function _functionDescriptors(string memory contractName) internal view returns (string[] memory out) {
        string memory j = _artifact(contractName);
        string[] memory sigs = vm.parseJsonKeys(j, ".methodIdentifiers");
        out = new string[](sigs.length);
        for (uint256 i = 0; i < sigs.length; i++) {
            string memory base = _member("function", _nameOf(sigs[i]));
            string[] memory mutability = _strings(j, string.concat(base, ".stateMutability"));
            // ON KOSUL, VARSAYIM DEGIL: ada gore filtreleme ancak ad benzersizse
            // tanimlayiciyi belirler. Overload eklenirse burasi duser.
            assertEq(mutability.length, 1, string.concat(contractName, ": asiri yuklenmis ad -> ", sigs[i]));
            string[] memory outputs = _strings(j, string.concat(base, ".outputs[*].type"));
            out[i] = string.concat(sigs[i], " ", mutability[0], " -> (", _join(outputs), ")");
        }
    }

    /// @dev `constructor(tipler) <mutabilite>`; constructor'i olmayan kontratta
    ///      bos kume. `LaunchToken`in arguman SIRASI `isCanonical`in CREATE2
    ///      turetmesinde tasiyicidir -- bir alan dusurulurse sahteci o alani
    ///      serbestce degistirip kanonik kalir (bkz. `LaunchFactory` NatSpec).
    function _constructorDescriptor(string memory contractName) internal view returns (string[] memory out) {
        string memory j = _artifact(contractName);
        string[] memory mutability = _strings(j, "$.abi[?(@.type == 'constructor')].stateMutability");
        if (mutability.length == 0) return new string[](0);
        assertEq(mutability.length, 1, string.concat(contractName, ": birden fazla constructor"));
        string[] memory inputs = _strings(j, "$.abi[?(@.type == 'constructor')].inputs[*].type");
        out = new string[](1);
        out[0] = string.concat("constructor(", _join(inputs), ") ", mutability[0]);
    }

    /// @dev `Ad(girdi tipleri)` -- ARITE BURADA KAPANIR.
    function _errorDescriptors(string memory contractName) internal view returns (string[] memory out) {
        string memory j = _artifact(contractName);
        string[] memory names = _strings(j, "$.abi[?(@.type == 'error')].name");
        out = new string[](names.length);
        for (uint256 i = 0; i < names.length; i++) {
            string[] memory inputs = _strings(j, string.concat(_member("error", names[i]), ".inputs[*].type"));
            out[i] = string.concat(names[i], "(", _join(inputs), ")");
        }
    }

    /// @dev `Ad(tipler) indexed:(indeksli parametre adlari)`.
    ///      Indeksli parametrelerin ADI tasinir, tipi degil: topic kimligini
    ///      tasiyan sey odur, ve ayni tipte iki parametre arasinda `indexed`
    ///      tasinmasi ancak adla gorunur.
    function _eventDescriptors(string memory contractName) internal view returns (string[] memory out) {
        string memory j = _artifact(contractName);
        string[] memory names = _strings(j, "$.abi[?(@.type == 'event')].name");
        out = new string[](names.length);
        for (uint256 i = 0; i < names.length; i++) {
            string memory base = _member("event", names[i]);
            string[] memory types = _strings(j, string.concat(base, ".inputs[*].type"));
            string[] memory topics = _strings(j, string.concat(base, ".inputs[?(@.indexed == true)].name"));
            out[i] = string.concat(names[i], "(", _join(types), ") indexed:(", _join(topics), ")");
        }
    }

    function _entryTypes(string memory contractName) internal view returns (string[] memory) {
        return _strings(_artifact(contractName), "$.abi[*].type");
    }

    // ---------------------------------------------------------------
    // Iki yonlu kume esitligi
    // ---------------------------------------------------------------

    /// @dev IKI YONLULUK SART. Yalnizca "beklenenlerin hepsi duruyor mu" diye
    ///      bakan bir dongu, EKLENMIS bir uyeyi goremez -- ve butun mesele
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

    /// @dev "Kimsenin yazmadigi bir sebeple gecen test"e karsi bag: butun
    ///      iddialar `out/<C>.sol/<C>.json`in o kontratin artifact'i OLDUGUNU
    ///      varsayar. Burada varsayilmiyor, olculuyor: `FeeEscrow` deploy edilir
    ///      ve zincirdeki runtime kodu artifact'in `deployedBytecode.object`i
    ///      ile BAYT BAYT karsilastirilir. `FeeEscrow` secildi cunku tek
    ///      immutable'i ve constructor argumani yoktur -- diger dortunde
    ///      immutable degerleri runtime koduna gomuldugu icin esitlik yapisal
    ///      olarak tutmaz. Dosya adi semasi hepsinde ayni oldugu icin bagi tek
    ///      bir kontratta kurmak yeter.
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

    /// @dev BU LISTE `LaunchToken`in ARZ SABITLIGI IDDIASININ ASAGIDAN PINI.
    ///      Icinde `mint` YOK, `issue` YOK, `burn` YOK, `setMinter` YOK --
    ///      ve bu bir dilek degil, iki yonlu esitligin sonucu.
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

    function test_launchTokenFunctionMutabilityAndReturns() public view {
        string[] memory expected = new string[](14);
        expected[0] = "TOTAL_SUPPLY() view -> (uint256)";
        expected[1] = "allowance(address,address) view -> (uint256)";
        expected[2] = "approve(address,uint256) nonpayable -> (bool)";
        expected[3] = "balanceOf(address) view -> (uint256)";
        expected[4] = "creator() view -> (address)";
        expected[5] = "curve() view -> (address)";
        expected[6] = "decimals() view -> (uint8)";
        expected[7] = "launchSalt() view -> (bytes32)";
        expected[8] = "metadataURI() view -> (string)";
        expected[9] = "name() view -> (string)";
        expected[10] = "symbol() view -> (string)";
        expected[11] = "totalSupply() view -> (uint256)";
        expected[12] = "transfer(address,uint256) nonpayable -> (bool)";
        expected[13] = "transferFrom(address,address,uint256) nonpayable -> (bool)";
        _assertSetEquals(_functionDescriptors("LaunchToken"), expected, "LaunchToken tanimlayicilari");

        string[] memory ctor = new string[](1);
        ctor[0] = "constructor(string,string,string,address,address,bytes32) nonpayable";
        _assertSetEquals(_constructorDescriptor("LaunchToken"), ctor, "LaunchToken constructor");
    }

    function test_launchTokenExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](11);
        // OZ ERC20'nin kendi hatalari -- bizim degil ama YUZEYDE.
        expected[0] = "ERC20InsufficientAllowance(address,uint256,uint256)";
        expected[1] = "ERC20InsufficientBalance(address,uint256,uint256)";
        expected[2] = "ERC20InvalidApprover(address)";
        expected[3] = "ERC20InvalidReceiver(address)";
        expected[4] = "ERC20InvalidSender(address)";
        expected[5] = "ERC20InvalidSpender(address)";
        expected[6] = "NameTooLong()";
        expected[7] = "SymbolTooLong()";
        expected[8] = "UriTooLong()";
        expected[9] = "ZeroCreator()";
        expected[10] = "ZeroCurve()";
        _assertSetEquals(_errorDescriptors("LaunchToken"), expected, "LaunchToken hatalari");
    }

    function test_launchTokenExposesExactlyTheseEvents() public view {
        string[] memory expected = new string[](2);
        expected[0] = "Approval(address,address,uint256) indexed:(owner,spender)";
        expected[1] = "Transfer(address,address,uint256) indexed:(from,to)";
        _assertSetEquals(_eventDescriptors("LaunchToken"), expected, "LaunchToken olaylari");
    }

    function test_launchTokenAbiCensus() public view {
        _assertEntryCensus("LaunchToken", 14, 11, 2, 1, 0, 0);
    }

    // ---------------------------------------------------------------
    // FeeEscrow
    // ---------------------------------------------------------------

    /// @dev Faz 1b'nin hayatta kalan besinci mutanti burada oturuyordu:
    ///      `sweep` yerine `collect(address)`. `collect` uydurma degildir --
    ///      pump.fun'in kendi talimati `collect_creator_fee_v2`.
    function test_feeEscrowExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](4);
        expected[0] = "claim(address)";
        expected[1] = "deposit(address)";
        expected[2] = "owed(address)";
        expected[3] = "totalOwed()";
        _assertSetEquals(_functionSignatures("FeeEscrow"), expected, "FeeEscrow fonksiyonlari");
    }

    /// @dev `claim` `nonpayable` OLMAK ZORUNDA. `payable` olsaydi deger
    ///      gonderen bir cagiran (ya da toplu odeme yapan bir router) parayi
    ///      escrow'a birakir, escrow onu HICBIR alacaga yazmaz, ve kontratin
    ///      `receive()`i, sahibi ve kurtarma yolu YOKTUR -- yani para kalici
    ///      olarak kaybolur. Kontratin kendi bas NatSpec'i tam olarak bu risk
    ///      sinifini sayiyor; bu satir onu ABI seviyesinde sabitler.
    function test_feeEscrowFunctionMutabilityAndReturns() public view {
        string[] memory expected = new string[](4);
        expected[0] = "claim(address) nonpayable -> ()";
        expected[1] = "deposit(address) payable -> ()";
        expected[2] = "owed(address) view -> (uint256)";
        expected[3] = "totalOwed() view -> (uint256)";
        _assertSetEquals(_functionDescriptors("FeeEscrow"), expected, "FeeEscrow tanimlayicilari");
        _assertSetEquals(_constructorDescriptor("FeeEscrow"), new string[](0), "FeeEscrow constructor");
    }

    function test_feeEscrowExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](4);
        expected[0] = "NothingToClaim()";
        expected[1] = "TransferFailed()";
        expected[2] = "ZeroAmount()";
        expected[3] = "ZeroRecipient()";
        _assertSetEquals(_errorDescriptors("FeeEscrow"), expected, "FeeEscrow hatalari");
    }

    /// @dev `Deposited.recipient` ve `Claimed.recipient` INDEKSLI kalmali:
    ///      alicinin kendi ucret gecmisini cekmesi bu topic'e baglidir.
    function test_feeEscrowExposesExactlyTheseEvents() public view {
        string[] memory expected = new string[](2);
        expected[0] = "Claimed(address,uint256) indexed:(recipient)";
        expected[1] = "Deposited(address,address,uint256) indexed:(recipient,from)";
        _assertSetEquals(_eventDescriptors("FeeEscrow"), expected, "FeeEscrow olaylari");
    }

    /// @dev `receive` = 0 ve `fallback` = 0, `FeeEscrow`un kisit (1)'inin TAM
    ///      OLARAK ifade ettigi ozellik: duz bir native gonderim BASARISIZ
    ///      OLMALI. `methodIdentifiers` bu ikisini hic gormez, dolayisiyla bu
    ///      sayim onlarin tek koruyucusu.
    function test_feeEscrowAbiCensus() public view {
        _assertEntryCensus("FeeEscrow", 4, 4, 2, 0, 0, 0);
    }

    // ---------------------------------------------------------------
    // BondingCurve
    // ---------------------------------------------------------------

    /// @dev BU LISTE TAM OLARAK DORT NON-VIEW GIRIS NOKTASI + BIR TERMINAL
    ///      CIKIS ICERIR ve fazlasi hatadir. `graduate()` eklendi; eklenmesi bu
    ///      dosyada ALTI iddiayi birden kirdi (fonksiyon kumesi, tanimlayici
    ///      kumesi, hata kumesi, olay kumesi, sayim, ve constructor
    ///      tanimlayicisi) -- pin'in tasarlandigi gibi calismasi budur.
    function test_bondingCurveExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](22);
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
        expected[12] = "graduate()";
        expected[13] = "graduated()";
        expected[14] = "poolSeedSupply()";
        expected[15] = "protocolTreasury()";
        expected[16] = "realQuoteReserves()";
        expected[17] = "realTokenReserves()";
        expected[18] = "sellExactTokensIn(uint256,uint256)";
        expected[19] = "token()";
        expected[20] = "virtualQuoteReserves()";
        expected[21] = "virtualTokenReserves()";
        _assertSetEquals(_functionSignatures("BondingCurve"), expected, "BondingCurve fonksiyonlari");
    }

    /// @dev `sellExactTokensIn` `nonpayable` OLMAK ZORUNDA: satis yolunda
    ///      curve'e giren native tutar YOKTUR, gonderilen deger hicbir deftere
    ///      yazilmaz ve cikis yolu olmayan bir kontratta kalir. Iki alim yolu
    ///      ise `payable` OLMAK ZORUNDA.
    /// @dev `graduate()` `nonpayable` OLMAK ZORUNDA: `payable` olsaydi cagiran
    ///      curve'e native birakabilir ve curve onu BIR DAHA hareket
    ///      ettiremezdi (tamamlanma sonrasi tek cikis yolu graduation'dir ve o
    ///      da defterden odeme yapar). Bu tek kelimelik bir src degisikligidir
    ///      ve baska hicbir test gormez.
    /// @dev `protocolTreasury()` `view -> (address)` OLARAK KALIR ama artik bir
    ///      IMMUTABLE GETTER'I DEGIL, factory'ye giden bir okumadir (F1). ABI
    ///      bu farki TASIMAZ -- ve bu bir bosluk degil, bilincli bir sonuctur:
    ///      Faz 2'nin hook'u ile Faz 3'un indexer'i acisindan yuzey aynidir.
    ///      Degisikligin ABI'de gorundugu yerler constructor'in ARITESI
    ///      (`ZeroTreasury()` argumaniyla birlikte gitti) ve hata kumesidir.
    function test_bondingCurveFunctionMutabilityAndReturns() public view {
        string[] memory expected = new string[](22);
        expected[0] = "CREATOR_FEE_BPS() view -> (uint256)";
        expected[1] = "INITIAL_REAL_TOKEN_RESERVES() view -> (uint256)";
        expected[2] = "INITIAL_VIRTUAL_QUOTE_RESERVES() view -> (uint256)";
        expected[3] = "INITIAL_VIRTUAL_TOKEN_RESERVES() view -> (uint256)";
        expected[4] = "PROTOCOL_FEE_BPS() view -> (uint256)";
        expected[5] = "bind(address) nonpayable -> ()";
        expected[6] = "buyExactQuoteIn(uint256) payable -> ()";
        expected[7] = "buyExactTokensOut(uint256,uint256) payable -> ()";
        expected[8] = "complete() view -> (bool)";
        expected[9] = "creator() view -> (address)";
        expected[10] = "escrow() view -> (address)";
        expected[11] = "factory() view -> (address)";
        expected[12] = "graduate() nonpayable -> (uint256,uint256)";
        expected[13] = "graduated() view -> (bool)";
        expected[14] = "poolSeedSupply() view -> (uint256)";
        expected[15] = "protocolTreasury() view -> (address)";
        expected[16] = "realQuoteReserves() view -> (uint256)";
        expected[17] = "realTokenReserves() view -> (uint256)";
        expected[18] = "sellExactTokensIn(uint256,uint256) nonpayable -> ()";
        expected[19] = "token() view -> (address)";
        expected[20] = "virtualQuoteReserves() view -> (uint256)";
        expected[21] = "virtualTokenReserves() view -> (uint256)";
        _assertSetEquals(_functionDescriptors("BondingCurve"), expected, "BondingCurve tanimlayicilari");

        string[] memory ctor = new string[](1);
        ctor[0] = "constructor(address,address,uint256,uint256,uint256) nonpayable";
        _assertSetEquals(_constructorDescriptor("BondingCurve"), ctor, "BondingCurve constructor");
    }

    /// @dev Son bes giris `CurveMath`ten gelir. Yukaridaki karar geregi
    ///      YUZEYIN PARCASIDIR ve isaretlenerek pinlenir; `NetTooSmall`
    ///      ULASILABILIR (`buyExactQuoteIn`), digerleri bugun degildir.
    /// @dev `ZeroTreasury()` BU KUMEDEN CIKTI ve cikmasi F1'in olculebilir
    ///      izidir: curve artik bir treasury argumani ALMAZ, dolayisiyla o hata
    ///      ULASILAMAZ olurdu. Ulasilamaz bir hatayi yuzeyde birakmak bu
    ///      dosyanin (c) gerekcesine gore savunulabilirdi ama BURADA DEGIL:
    ///      `CurveMath`in iki hatasi bir GUN ulasilabilir hale gelebilir,
    ///      `ZeroTreasury` ise bir daha ASLA -- argumani yok.
    /// @dev BES YENI HATA graduation'dandir ve `NotComplete()` ile
    ///      `CurveComplete()`in AYRI selector'ler oldugu burada gorunur.
    function test_bondingCurveExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](31);
        expected[0] = "AlreadyBound()";
        expected[1] = "CurveComplete()";
        expected[2] = "NotBound()";
        expected[3] = "NotEnoughTokensToBuy()";
        expected[4] = "NotFactory()";
        expected[5] = "PayoutFailed()";
        expected[6] = "ProceedsTooSmall()";
        expected[7] = "RefundFailed()";
        expected[8] = "SaleSupplyNotBelowTokenReserves()";
        expected[9] = "SlippageExceeded()";
        expected[10] = "TokenBalanceBelowSaleAndSeed()";
        expected[11] = "TokenDoesNotPointBack()";
        expected[12] = "TokenTransferFailed()";
        expected[13] = "ZeroEscrow()";
        expected[14] = "ZeroQuoteIn()";
        expected[15] = "ZeroSaleSupply()";
        expected[16] = "ZeroToken()";
        expected[17] = "ZeroTokensIn()";
        expected[18] = "ZeroTokensOut()";
        expected[19] = "ZeroVirtualQuoteReserves()";
        expected[20] = "ZeroVirtualTokenReserves()";
        // --- graduation ---
        expected[21] = "AlreadyGraduated()";
        expected[22] = "GraduationPayoutFailed()";
        expected[23] = "GraduationTargetUnset()";
        expected[24] = "NotComplete()";
        expected[25] = "NotGraduationTarget()";
        // --- CurveMath katmani: ULASILABILIR ---
        expected[26] = "NetTooSmall()";
        // --- CurveMath katmani: bugun ULASILAMAZ, yine de yuzeyde ---
        expected[27] = "InsufficientTokenReserve()";
        expected[28] = "InvalidBps()";
        expected[29] = "ZeroAmount()";
        expected[30] = "ZeroReserve()";
        _assertSetEquals(_errorDescriptors("BondingCurve"), expected, "BondingCurve hatalari");
    }

    /// @dev `Trade.trader` INDEKSLI kalmali. Faz 3'un indexer'i bir launch'in
    ///      gecmisini bu olaydan yeniden kurar (dort rezervi de tasimasinin
    ///      sebebi budur) ve trader topic'i uzerinden filtreler; `indexed`i
    ///      kaldirmak her `getLogs` filtresini SESSIZCE bos dondurur -- src'de
    ///      TEK KELIMELIK bir degisiklik. `Completed.token` ayni sinifta.
    /// @dev `Graduated`in IKI indeksli alani da tasiyicidir: `token` Faz 3'un
    ///      birincil anahtaridir, `to` ise hedefin YENIDEN ISARETLENEBILIR
    ///      olmasi yuzunden ("bu havuzu hangi hedef tohumladi") bir sorgudur.
    ///      Birini indekssiz yapmak src'de tek kelimedir ve her `getLogs`
    ///      filtresini SESSIZCE bos dondurur.
    function test_bondingCurveExposesExactlyTheseEvents() public view {
        string[] memory expected = new string[](3);
        expected[0] = "Completed(address,uint256,uint256) indexed:(token)";
        expected[1] = "Graduated(address,address,uint256,uint256) indexed:(token,to)";
        expected[2] =
        "Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) indexed:(trader)";
        _assertSetEquals(_eventDescriptors("BondingCurve"), expected, "BondingCurve olaylari");
    }

    function test_bondingCurveAbiCensus() public view {
        _assertEntryCensus("BondingCurve", 22, 31, 3, 1, 0, 0);
    }

    /// @notice Curve'un RUNTIME KODU, factory'de var olmasini gerektirdigi iki
    ///         uyenin selector'unu ICERIR.
    ///
    /// @dev R-11. Yukaridaki pinler factory'nin ABI'sini sabitler, ama
    ///      BAGIMLILIGIN YONUNU gostermezler: bagimlilik curve'un
    ///      BYTECODE'UNDADIR ve deploy edildikten sonra degistirilemez. Bu test
    ///      onu ARTIFACT'TAN olcer: `graduationTarget()` (0xa4b20f13) ve
    ///      `protocolTreasury()` (0x803db96d) literalleri curve'un deployed
    ///      kodunda ARANIR. Ikisini birden yeniden adlandiran ya da non-`view`
    ///      yapan bir factory, deploy ettigi her curve'u kirar -- ilkinde
    ///      graduation'i, ikincisinde HER ISLEMI.
    ///
    /// @dev NICIN AYRI BIR IDDIA. `LaunchFactory`nin ABI pinleri bu iki uyeyi
    ///      SILMEYE karsi korur, ama curve'un onlara BAGLI OLMAYI BIRAKMASINA
    ///      karsi korumaz: `protocolTreasury()`i tekrar bir immutable'a
    ///      cevirmek (yani F1'i geri almak) factory'nin yuzeyini hic
    ///      degistirmez ve buradaki ikinci arama DUSER.
    function test_theCurveRuntimeCodeContainsTheFactorySelectorsItDependsOn() public view {
        bytes memory code = vm.parseJsonBytes(_artifact("BondingCurve"), ".deployedBytecode.object");
        assertGt(code.length, 0, "runtime kod bos");
        assertTrue(_containsSelector(code, 0xa4b20f13), "graduationTarget() selector'u curve kodunda YOK");
        assertTrue(_containsSelector(code, 0x803db96d), "protocolTreasury() selector'u curve kodunda YOK");
    }

    /// @notice `Graduated` adi TAM OLARAK BIR kontrat tarafindan sahiplenilir ve
    ///         topic0'i su literaldir.
    ///
    /// @dev R-10'un yeni yarisi. Tehlike su: Faz 2'nin havuz/locker katmani da
    ///      `Graduated` adli ama BASKA SEKILLI bir olay yayinlarsa topic0
    ///      ayrisir ve birine gore yazilmis her `getLogs` filtresi otekini
    ///      SESSIZCE bos dondurur -- hata vermez, BOS DONER. Karar kayda
    ///      gecirildi (`BondingCurve` NatSpec'i): Faz 2'nin olayi `PoolSeeded`
    ///      adini alacaktir. Bu test o karari CALISTIRILABILIR yapar: bes
    ///      kontratin olay adlari taranir ve `Graduated` birden fazla yerde
    ///      gorunurse duser.
    /// @dev Literal topic0 ayrica olayin SEKLINI kilitler; yukaridaki
    ///      tanimlayici pini de yapar ama bu satir Faz 3'un filtre sabitiyle
    ///      BIRE BIR karsilastirilabilir bir sayi verir.
    function test_theGraduatedEventNameIsClaimedByExactlyOneContract() public view {
        // FAZ 2'NIN UC YENI KONTRATI LISTEYE GIRDI. Listeye eklenmeyen bir
        // kontrat, adi `Graduated` olan bir olay YAYSA DA sayilmazdi -- yani
        // bu testin gucu tam olarak listenin GUNCELLIGI kadardir, ve bu
        // dosyanin acik hucrelerinden biridir.
        string[8] memory contracts = [
            "BondingCurve",
            "LaunchFactory",
            "LaunchToken",
            "FeeEscrow",
            "CurveMath",
            "ArcpadLocker",
            "ArcpadHook",
            "FeeSchedule"
        ];
        uint256 claims;
        for (uint256 i = 0; i < contracts.length; i++) {
            string[] memory names = _strings(_artifact(contracts[i]), "$.abi[?(@.type == 'event')].name");
            for (uint256 j = 0; j < names.length; j++) {
                if (keccak256(bytes(names[j])) == keccak256("Graduated")) claims++;
            }
        }
        assertEq(claims, 1, "`Graduated` adi birden fazla kontratta -- indexer filtreleri sessizce bosalir");

        assertEq(
            keccak256("Graduated(address,address,uint256,uint256)"),
            bytes32(0x18a56450d3c666e2bae9e0829fcada82a9ab0deef6e33c2496752c88d4155c9d),
            "Graduated topic0"
        );
    }

    /// @dev Dort baytlik dizi aramasi. `code.length < 4` durumunda dongu hic
    ///      calismaz ve `false` doner (fail-closed).
    function _containsSelector(bytes memory code, bytes4 selector) internal pure returns (bool) {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------
    // LaunchFactory
    // ---------------------------------------------------------------

    /// @dev BU KUMEDE UC MUTATIF UYE VAR ve ucu de governance'tir; DORDUNCUSU
    ///      OLMAMALIDIR. Ozellikle bir `setGovernor`, bir `setEscrow`, bir
    ///      `setProfile` ya da bir `pause` bu kumeye bir GIRIS EKLER ve fazlalik
    ///      hatadir -- iki yonlu esitligin butun anlami budur.
    function test_launchFactoryExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](33);
        expected[0] = "GRADUATION_TARGET_DELAY()";
        expected[1] = "MIN_GRADUATION_RAISE()";
        expected[2] = "MIN_OPENING_MARKET_CAP()";
        expected[3] = "MIN_SALE_AND_SEED()";
        expected[4] = "SALE_SUPPLY()";
        expected[5] = "VIRTUAL_QUOTE_RESERVES()";
        expected[6] = "VIRTUAL_TOKEN_RESERVES()";
        expected[7] = "applyGraduationTarget()";
        expected[8] = "escrow()";
        expected[9] = "governor()";
        expected[10] = "graduationTarget()";
        expected[11] = "isCanonical(address)";
        expected[12] = "launch(string,string,string)";
        expected[13] = "launchCount()";
        expected[14] = "pendingGraduationTarget()";
        expected[15] = "pendingGraduationTargetEta()";
        expected[16] = "predictAddresses(address,string,string,string,uint256)";
        expected[17] = "proposeGraduationTarget(address)";
        expected[18] = "protocolTreasury()";
        expected[19] = "setProtocolTreasury(address)";
        // FAZ 2: ucret kademesi tablosu ve token basina dondurulmus atamasi.
        expected[20] = "feeSchedule()";
        expected[21] = "feeScheduleOf(address)";
        // ============ BUYBACK & LOCK NESLI ============
        // Creator-funded buyback ile gelen uyeler. Eklendiklerinde yuzey
        // pini BES iddiayi birden kirdi -- pinin isi budur.
        expected[22] = "BUYBACK_LOCK_BPS()";
        expected[23] = "buybackTreasury()";
        expected[24] = "buybackEnabledOf(address)";
        expected[25] = "graduationHook()";
        expected[26] = "buybackKeeper()";
        expected[27] = "buybackPolicy(address)";
        expected[28] = "setBuybackEnabled(address,bool)";
        expected[29] = "setGraduationHook(address)";
        expected[30] = "setBuybackKeeper(address)";
        expected[31] = "launchWithBuyback(string,string,string,bool)";
        expected[32] = "setBuybackTreasury(address)";
        _assertSetEquals(_functionSignatures("LaunchFactory"), expected, "LaunchFactory fonksiyonlari");
    }

    /// @dev `launch` `nonpayable` OLMAK ZORUNDA -- ucretsizdir ve deger gonderen
    ///      bir cagri revert etmelidir (src NatSpec'i bunu acikca soyluyor).
    ///      `isCanonical` ve `predictAddresses` `view` kalmali: ikisi de zincir
    ///      disi dogrulayicinin cagirdigi saf sorgulardir.
    /// @dev `graduationTarget()` `view -> (address)` OLMAK ZORUNDA VE BU
    ///      SATIRIN OLCTUGU SEY CURVE'UN BYTECODE'UDUR: `BondingCurve`
    ///      `ILaunchFactory` uzerinden `view` cagirir, yani solc STATICCALL
    ///      uretir; bu uyeyi non-`view` yapmak (ya da yeniden adlandirmak)
    ///      deploy edilmis HER curve'un graduation'ini kirar. `protocolTreasury()`
    ///      icin AYNISI gecerlidir ve orada bedeli daha da yuksektir: HER
    ///      ISLEM o okumadan gecer.
    /// @dev `proposeGraduationTarget` / `setProtocolTreasury` `nonpayable`,
    ///      `applyGraduationTarget` da `nonpayable` VE IZINSIZDIR (governor
    ///      kontrolu yalnizca ilk ikisindedir); izinsizlik ABI'de gorunmez,
    ///      `LaunchFactory.t.sol` onu davranissal olarak olcer.
    function test_launchFactoryFunctionMutabilityAndReturns() public view {
        string[] memory expected = new string[](33);
        expected[0] = "GRADUATION_TARGET_DELAY() view -> (uint256)";
        expected[1] = "MIN_GRADUATION_RAISE() view -> (uint256)";
        expected[2] = "MIN_OPENING_MARKET_CAP() view -> (uint256)";
        expected[3] = "MIN_SALE_AND_SEED() view -> (uint256)";
        expected[4] = "SALE_SUPPLY() view -> (uint256)";
        expected[5] = "VIRTUAL_QUOTE_RESERVES() view -> (uint256)";
        expected[6] = "VIRTUAL_TOKEN_RESERVES() view -> (uint256)";
        expected[7] = "applyGraduationTarget() nonpayable -> ()";
        expected[8] = "escrow() view -> (address)";
        expected[9] = "governor() view -> (address)";
        expected[10] = "graduationTarget() view -> (address)";
        expected[11] = "isCanonical(address) view -> (bool)";
        expected[12] = "launch(string,string,string) nonpayable -> (address,address)";
        expected[13] = "launchCount() view -> (uint256)";
        expected[14] = "pendingGraduationTarget() view -> (address)";
        expected[15] = "pendingGraduationTargetEta() view -> (uint256)";
        expected[16] = "predictAddresses(address,string,string,string,uint256) view -> (address,address)";
        expected[17] = "proposeGraduationTarget(address) nonpayable -> ()";
        expected[18] = "protocolTreasury() view -> (address)";
        expected[19] = "setProtocolTreasury(address) nonpayable -> ()";
        expected[20] = "feeSchedule() view -> (address)";
        expected[21] = "feeScheduleOf(address) view -> (address)";
        // ============ BUYBACK & LOCK NESLI ============
        // Creator-funded buyback ile gelen uyeler. Eklendiklerinde yuzey
        // pini BES iddiayi birden kirdi -- pinin isi budur.
        expected[22] = "BUYBACK_LOCK_BPS() view -> (uint256)";
        expected[23] = "buybackTreasury() view -> (address)";
        expected[24] = "buybackEnabledOf(address) view -> (bool)";
        expected[25] = "graduationHook() view -> (address)";
        expected[26] = "buybackKeeper() view -> (address)";
        expected[27] = "buybackPolicy(address) view -> (address,uint256)";
        expected[28] = "setBuybackEnabled(address,bool) nonpayable -> ()";
        expected[29] = "setGraduationHook(address) nonpayable -> ()";
        expected[30] = "setBuybackKeeper(address) nonpayable -> ()";
        expected[31] = "launchWithBuyback(string,string,string,bool) nonpayable -> (address,address)";
        expected[32] = "setBuybackTreasury(address) nonpayable -> ()";
        _assertSetEquals(_functionDescriptors("LaunchFactory"), expected, "LaunchFactory tanimlayicilari");

        string[] memory ctor = new string[](1);
        ctor[0] = "constructor(address,address,address,uint256,uint256,uint256,address) nonpayable";
        _assertSetEquals(_constructorDescriptor("LaunchFactory"), ctor, "LaunchFactory constructor");
    }

    /// @dev `LaunchFactory`nin NatSpec'i ULASILABILIR dokuzu sayiyor. Buradaki
    ///      kume onbir: solc, bu kontratin fiilen revert edebilecegi iki
    ///      `CurveMath` hatasini da ABI'ye koyuyor (besini degil -- uyeligi
    ///      derleyici seciyor, bkz. dosya bas notu (b)). Ikisi de bugun
    ///      ULASILAMAZ ve isaretlenerek pinleniyor.
    /// @dev YEDI YENI HATA: uc adres argumaninin "rolunu tasiyamaz" hucreleri
    ///      (`TreasuryIsTheEscrow`, `GovernorIsTheEscrow`, `ZeroGovernorAddress`)
    ///      ve governance'in dort korumasi. `TreasuryIsTheEscrow` F1'in
    ///      olculebilir izidir.
    function test_launchFactoryExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](28);
        expected[0] = "DegenerateProfile()";
        expected[1] = "EmptyName()";
        expected[2] = "EmptySymbol()";
        expected[3] = "EscrowHasNoCode()";
        expected[4] = "GraduationRaiseTooSmall()";
        expected[5] = "SaleAndSeedExceedSupply()";
        expected[6] = "SaleAndSeedStrandSupply()";
        expected[7] = "ZeroEscrowAddress()";
        expected[8] = "ZeroTreasuryAddress()";
        // --- adres argumanlari: rolu tasiyamaz ---
        // `EscrowHasNoCode` ve `EscrowIsNotAFeeEscrow` AYNI HUCRENIN iki
        // yarisidir: biri kod YOKLUGUNU, oteki kodu olan ama defter gibi cevap
        // VERMEYEN adresi eler. Ikincisi olmadan birincisi, engellemek icin
        // yazildigi terminal duruma bir adres sekli oteden ulasilmasina izin
        // veriyordu (olculdu).
        expected[9] = "EscrowIsNotAFeeEscrow()";
        expected[10] = "GovernorIsTheEscrow()";
        expected[11] = "TreasuryIsTheEscrow()";
        expected[12] = "ZeroGovernorAddress()";
        // --- governance ---
        // `...DelayNotElapsed` ve `...ProposalExpired` AYNI PENCERENIN IKI
        // YUZUDUR; birinin varligi otekini gerektirir, cunku alttan sinirli
        // ust sinirsiz bir pencere "suresi gecmis ama hala silahli" bir oneri
        // birakir.
        expected[13] = "GraduationTargetDelayNotElapsed()";
        expected[14] = "GraduationTargetProposalExpired()";
        expected[15] = "NoPendingGraduationTarget()";
        expected[16] = "NotGovernor()";
        expected[17] = "ZeroGraduationTarget()";
        // --- CurveMath katmani: bugun ULASILAMAZ, yine de yuzeyde ---
        expected[18] = "InsufficientTokenReserve()";
        expected[19] = "ZeroReserve()";
        // FAZ 2: `feeSchedule` argumani ve tek yeni profil kontrolu.
        expected[20] = "ZeroFeeSchedule()";
        expected[21] = "FeeScheduleHasNoCode()";
        expected[22] = "ProfileNotSeedable()";
        // ============ BUYBACK & LOCK NESLI ============
        // Creator-funded buyback ile gelen uyeler. Eklendiklerinde yuzey
        // pini BES iddiayi birden kirdi -- pinin isi budur.
        expected[23] = "BuybackUnavailable()";
        expected[24] = "NotLaunchCreator()";
        expected[25] = "GovernorCannotEnableBuyback()";
        expected[26] = "UnknownLaunch()";
        expected[27] = "HookAlreadySet()";
        _assertSetEquals(_errorDescriptors("LaunchFactory"), expected, "LaunchFactory hatalari");
    }

    /// @dev UC indeksli alan: `token`, `curve`, `creator`. Faz 3'un indexer'i
    ///      bir launch'i bu olaydan yeniden kurar ve ucunun de topic olmasi
    ///      "bu creator'in launch'lari" gibi sorgularin tek dayanagidir.
    /// @dev UC GOVERNANCE OLAYI: `GraduationTargetProposed` gecikmenin KAMUYA
    ///      ACIK yarisidir (bir keeper yalnizca onu izleyerek "uc gun icinde
    ///      bosaltilmasi gereken curve'ler" listesini kurar), `eta` INDEKSSIZ
    ///      kalir cunku ona gore filtre yapilmaz. Ikisi de `previous`/`current`
    ///      tasir: bir denetci rotasyon gecmisini yalnizca loglardan kurar.
    function test_launchFactoryExposesExactlyTheseEvents() public view {
        string[] memory expected = new string[](9);
        expected[0] = "GraduationTargetChanged(address,address) indexed:(previous,current)";
        expected[1] = "GraduationTargetProposed(address,uint256) indexed:(target)";
        expected[2] = "Launched(address,address,address,string,string,string,bytes32) indexed:(token,curve,creator)";
        expected[3] = "ProtocolTreasuryChanged(address,address) indexed:(previous,current)";
        expected[4] = "FeeScheduleAssigned(address,address) indexed:(token,schedule)";
        // ============ BUYBACK & LOCK NESLI ============
        // Creator-funded buyback ile gelen uyeler. Eklendiklerinde yuzey
        // pini BES iddiayi birden kirdi -- pinin isi budur.
        expected[5] = "BuybackEnabledUpdated(address,address,bool) indexed:(token,by)";
        expected[6] = "GraduationHookSet(address) indexed:(hook)";
        expected[7] = "BuybackKeeperSet(address) indexed:(keeper)";
        expected[8] = "BuybackTreasurySet(address) indexed:(treasury)";
        _assertSetEquals(_eventDescriptors("LaunchFactory"), expected, "LaunchFactory olaylari");
    }

    function test_launchFactoryAbiCensus() public view {
        _assertEntryCensus("LaunchFactory", 33, 28, 9, 1, 0, 0);
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
        _assertSetEquals(_functionDescriptors("CurveMath"), new string[](0), "CurveMath tanimlayicilari");
        _assertSetEquals(_constructorDescriptor("CurveMath"), new string[](0), "CurveMath constructor");
    }

    /// @dev `BondingCurve` ve `LaunchFactory`nin ABI'sinde gorunen kutuphane
    ///      hatalarinin KAYNAK listesi. Burada eksilme/artma, oradaki iki
    ///      kumeyi de sessizce kaydirirdi.
    function test_curveMathExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](5);
        expected[0] = "InsufficientTokenReserve()";
        expected[1] = "InvalidBps()";
        expected[2] = "NetTooSmall()";
        expected[3] = "ZeroAmount()";
        expected[4] = "ZeroReserve()";
        _assertSetEquals(_errorDescriptors("CurveMath"), expected, "CurveMath hatalari");
    }

    function test_curveMathExposesNoEvents() public view {
        _assertSetEquals(_eventDescriptors("CurveMath"), new string[](0), "CurveMath olaylari");
    }

    function test_curveMathAbiCensus() public view {
        _assertEntryCensus("CurveMath", 0, 5, 0, 0, 0, 0);
    }

    // ---------------------------------------------------------------
    // ArcpadLocker
    // ---------------------------------------------------------------

    /// @dev BES DIS FONKSIYON, VE ALTINCISI OLMAMALIDIR. Ozellikle bir
    ///      `retrySeed`, bir `seedFromHeld`, bir `withdraw`, bir `sweep` ya da
    ///      bir `setX` bu kumeye bir GIRIS EKLER ve fazlalik hatadir.
    ///      `retrySeed` uydurma degildir: yazilmasi CAZIPTI ve tasarimi
    ///      savunulabilirdi (parametresi yok, `PoolKey`in tamami curve'den
    ///      turer). REDDEDILME SEBEBI, `graduate`in atomikligi ve zincirden
    ///      geri okumasi verildiginde ULASILAMAZ olmasidir -- yani bu deponun
    ///      acikca yasakladigi OLDURULEMEZ bir mutant. Iki yonlu esitlik o
    ///      karari CALISTIRILABILIR yapar.
    function test_arcpadLockerExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](5);
        expected[0] = "factory()";
        expected[1] = "graduate(address)";
        expected[2] = "hook()";
        expected[3] = "poolManager()";
        expected[4] = "unlockCallback(bytes)";
        _assertSetEquals(_functionSignatures("ArcpadLocker"), expected, "ArcpadLocker fonksiyonlari");
    }

    /// @dev `graduate` `nonpayable` OLMAK ZORUNDA: `payable` olsaydi cagiran
    ///      locker'a native birakabilir ve locker o bakiyeyi BIR DAHA hareket
    ///      ettiremezdi -- gonderme yolu yazilmamistir. `unlockCallback` de
    ///      `nonpayable`dir; `PoolManager` ona deger gondermez.
    function test_arcpadLockerFunctionMutabilityAndReturns() public view {
        string[] memory expected = new string[](5);
        expected[0] = "factory() view -> (address)";
        expected[1] = "graduate(address) nonpayable -> ()";
        expected[2] = "hook() view -> (address)";
        expected[3] = "poolManager() view -> (address)";
        expected[4] = "unlockCallback(bytes) nonpayable -> (bytes)";
        _assertSetEquals(_functionDescriptors("ArcpadLocker"), expected, "ArcpadLocker tanimlayicilari");

        string[] memory ctor = new string[](1);
        ctor[0] = "constructor(address,address,address) nonpayable";
        _assertSetEquals(_constructorDescriptor("ArcpadLocker"), ctor, "ArcpadLocker constructor");
    }

    /// @dev Son BES giris kutuphane katmanindandir (`GraduationMath` ve
    ///      OZ `SafeERC20`/`Address`) ve `CurveMath`in `BondingCurve` ABI'sine
    ///      girmesiyle AYNI kararla pinlenir: uyeligi biz degil DERLEYICI
    ///      seciyor, ve disari propagate oluyorlar.
    function test_arcpadLockerExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](17);
        // Kurulum bagimliliklari sifir olamaz (denetim 2026-08-13).
        expected[16] = "ZeroDependency()";
        expected[0] = "CurveNotFromFactory()";
        // DENETIM (2026-08-13): verilen curve, token'in BAGLI oldugu curve
        // degilse reddedilir. Onceki halde bu kontrol YOKTU ve sahte bir curve
        // kanonik havuzu odeme yapilmadan aciyordu -- gercek mezuniyeti
        // KALICI olarak imkansiz kilarak.
        expected[15] = "CurveTokenMismatch()";
        expected[1] = "NotPoolManager()";
        expected[2] = "PoolPriceMismatch()";
        expected[3] = "PositionNotSeeded()";
        expected[4] = "SeedShortfall()";
        expected[5] = "UnexpectedCredit()";
        expected[6] = "ZeroLiquidity()";
        // --- GraduationMath katmani ---
        expected[7] = "BaseIsQuote()";
        expected[8] = "PriceOutOfRange()";
        expected[9] = "ZeroBase()";
        expected[10] = "ZeroReserves()";
        // --- OZ SafeERC20 / Address katmani (CurrencySettler uzerinden) ---
        expected[11] = "AddressEmptyCode(address)";
        expected[12] = "AddressInsufficientBalance(address)";
        expected[13] = "FailedInnerCall()";
        expected[14] = "SafeERC20FailedOperation(address)";
        _assertSetEquals(_errorDescriptors("ArcpadLocker"), expected, "ArcpadLocker hatalari");
    }

    /// @dev UC INDEKSLI ALAN. `poolId` topic olmak ZORUNDA: Faz 3'un indexer'i
    ///      "bu havuzu hangi graduation actı" sorgusunu ona gore filtreler.
    ///      `PoolId` bir user-defined value type'tir ve ABI'de `bytes32`
    ///      gorunur -- pinlenen sey ABI'nin GORDUGU seydir.
    function test_arcpadLockerExposesExactlyTheseEvents() public view {
        string[] memory expected = new string[](1);
        expected[0] = "PoolSeeded(address,address,bytes32,uint160,uint128,uint256,uint256) indexed:(token,curve,poolId)";
        _assertSetEquals(_eventDescriptors("ArcpadLocker"), expected, "ArcpadLocker olaylari");
    }

    /// @dev `receive = 1` VE `fallback = 0`, IKISI DE TASIYICI. `receive`
    ///      GEREKLIDIR: curve `target.call{value: R}("")` ile oder, onsuz her
    ///      graduation `GraduationPayoutFailed` ile duserdi. `fallback` ise
    ///      OLMAMALIDIR: bir `fallback` bilinmeyen her selector'u sessizce
    ///      yutar ve yukaridaki iki yonlu fonksiyon esitligini ANLAMSIZ kilar
    ///      -- kume "eksik" gorunmezdi cunku her cagri bir sey yapardi.
    ///      `methodIdentifiers` bu ikisini HIC gormez; bu sayim tek koruyucu.
    function test_arcpadLockerAbiCensus() public view {
        _assertEntryCensus("ArcpadLocker", 5, 17, 1, 1, 1, 0);
    }

    /// @notice Locker'in HICBIR dis fonksiyonu isaretli tamsayi PARAMETRESI
    ///         ALMAZ.
    ///
    /// @dev NEGATIF LIKIDITEYE GIDEN BIR YOLUN EN UCUZ NEGATIF GOSTERGESI.
    ///      "Pozisyon kalicidir" iddiasi, negatif `liquidityDelta` cagiran
    ///      kodun HIC YAZILMAMIS olmasidir -- ve YOKLUK test edilemez, YUZEY
    ///      test edilir. Disaridan bir isaretli miktar KABUL EDEN her fonksiyon
    ///      o iddianin en olasi giris noktasidir; kume bos oldugu surece
    ///      cikarma yoluna disaridan miktar GECIRILEMEZ.
    ///
    /// @dev DUZLESTIRME BURADA MESRUDUR VE SEBEBI YAZILIYOR: dosya bas notu
    ///      `inputs[*].type`i fonksiyonlara GRUPLAYAMADIGI icin reddediyor,
    ///      ama bu iddia bir VARLIK sorgusudur ("herhangi bir yerde isaretli
    ///      bir girdi var mi") ve gruplama gerektirmez. Iddia bos kume oldugu
    ///      icin de duzlestirme hicbir sey kaybetmez.
    function test_noExternalLockerFunctionTakesASignedAmount() public view {
        string[] memory types = _strings(_artifact("ArcpadLocker"), "$.abi[?(@.type == 'function')].inputs[*].type");
        for (uint256 i = 0; i < types.length; i++) {
            assertFalse(_isSignedInt(types[i]), string.concat("locker isaretli girdi aliyor -> ", types[i]));
        }
        // KONTROL: tarama GERCEKTEN isaretli tipleri ayirt ediyor. Hook'un
        // `afterSwap`i `int256` alir; ayni tarama orada BULMAK ZORUNDA, aksi
        // halde yukaridaki dongu her seyi "temiz" ilan ederdi.
        string[] memory hookTypes = _strings(_artifact("ArcpadHook"), "$.abi[?(@.type == 'function')].inputs[*].type");
        bool foundOnHook;
        for (uint256 i = 0; i < hookTypes.length; i++) {
            if (_isSignedInt(hookTypes[i])) foundOnHook = true;
        }
        assertTrue(foundOnHook, "tarama isaretli tip bulamiyor -- iddia vakumla geciyor");
    }

    /// @dev `int8`..`int256` ve `int24` gibi tipler; `uint...` DEGIL.
    function _isSignedInt(string memory t) internal pure returns (bool) {
        bytes memory b = bytes(t);
        return b.length >= 3 && b[0] == "i" && b[1] == "n" && b[2] == "t";
    }

    // ---------------------------------------------------------------
    // ArcpadHook
    // ---------------------------------------------------------------

    /// @dev ONBIRI `IHooks`in TAMAMIDIR ve `BaseHook` onlari ZORUNLU KILAR;
    ///      uygulanmayanlar `HookNotImplemented()` ile revert eder. Kume bu
    ///      yuzden "arcpad'in yazdiklari" degil "hook'un ABI'sinde duranlar"
    ///      olarak pinlenir -- entegratorun gordugu sey odur.
    function test_arcpadHookExposesExactlyTheseFunctions() public view {
        _assertSetEquals(_functionSignatures("ArcpadHook"), _expectedHookSignatures(), "ArcpadHook fonksiyonlari");
    }

    /// @dev `getHookPermissions()` `pure` OLMAK ZORUNDA: izin kumesi hook'un
    ///      ADRESINE gomulur ve `BaseHook`in constructor'i onu adrese karsi
    ///      dogrular. `view`e dusmesi, izinlerin bir DURUMDAN okundugu
    ///      anlamina gelirdi -- yani deploy sonrasi degisebilir gorunurdu.
    /// @dev `configOf(bytes32)` bir `public mapping` getter'idir ve DORT alan
    ///      dondurur; bir alan eklemek/cikarmak swap yolunun sabit gazini
    ///      degistirir ve BURADA gorunur.
    function test_arcpadHookFunctionMutabilityAndReturns() public view {
        _assertSetEquals(_functionDescriptors("ArcpadHook"), _expectedHookDescriptors(), "ArcpadHook tanimlayicilari");

        string[] memory ctor = new string[](1);
        ctor[0] = "constructor(address,address,address) nonpayable";
        _assertSetEquals(_constructorDescriptor("ArcpadHook"), ctor, "ArcpadHook constructor");
    }

    function test_arcpadHookExposesExactlyTheseErrors() public view {
        string[] memory expected = new string[](14);
        expected[13] = "ZeroDependency()";
        // DENETIM (2026-08-13) IKINCI KATMANI: hedef tarafi yeniden yanlis
        // yazilsa bile, odemesini yapmamis bir curve'un havuzu ACILAMAZ.
        expected[12] = "CurveNotGraduated()";
        expected[0] = "NotGraduationTarget()";
        expected[1] = "PriceIsNotTheCurveClosingPrice()";
        expected[2] = "QuoteLegMissing()";
        expected[3] = "TokenNotFromFactory()";
        expected[4] = "WrongPoolFee()";
        expected[5] = "WrongTickSpacing()";
        expected[6] = "ZeroCurrency()";
        // --- BaseHook katmani ---
        expected[7] = "HookNotImplemented()";
        expected[8] = "NotPoolManager()";
        // --- kutuphane katmani ---
        expected[9] = "InvalidBps()"; // CurveMath
        expected[10] = "PriceOutOfRange()"; // GraduationMath
        expected[11] = "ZeroReserves()"; // GraduationMath
        _assertSetEquals(_errorDescriptors("ArcpadHook"), expected, "ArcpadHook hatalari");
    }

    /// @dev `PoolRegistered.id` topic olmak ZORUNDA: bir havuzun kaydini
    ///      `poolId`den bulmak Faz 3'un birincil sorgusudur.
    function test_arcpadHookExposesExactlyTheseEvents() public view {
        string[] memory expected = new string[](2);
        expected[0] = "PoolRegistered(bytes32,address,address) indexed:(id,base,creator)";
        expected[1] = "SwapFeeCollected(bytes32,uint256,uint256) indexed:(id)";
        _assertSetEquals(_eventDescriptors("ArcpadHook"), expected, "ArcpadHook olaylari");
    }

    /// @dev SIFIR `receive`, SIFIR `fallback`, VE BU BIR EKSIKLIK DEGIL OLCUM
    ///      SONUCUDUR: Arc'ta bir ERC-20 transferi alicinin NATIVE bakiyesini
    ///      kredilendirir ve `receive()`i CALISTIRMAZ (canli olcum, blok
    ///      54019678). Hook ucreti `take` ile alir ve `deposit{value:}` ile
    ///      harcar; arada `receive()`e ihtiyac duyulan bir an YOKTUR. Bir
    ///      `receive` eklemek, hook'a duz native gonderiminin BASARMASI
    ///      demekti -- ve hook'un cikis yolu yoktur.
    function test_arcpadHookAbiCensus() public view {
        _assertEntryCensus("ArcpadHook", 16, 14, 2, 1, 0, 0);
    }

    // ---------------------------------------------------------------
    // FeeSchedule
    // ---------------------------------------------------------------

    /// @dev DORT FONKSIYON, HEPSI OKUMA. Bir `setTier`, bir `setOwner`, bir
    ///      `upgrade` bu kumeye bir GIRIS EKLER; tablonun degistirilemezligi
    ///      tam olarak o girisin YOKLUGUDUR. Tabloyu guncellemek YENI bir
    ///      `FeeSchedule` deploy etmektir ve o da yalnizca SONRAKI launch'lari
    ///      etkiler.
    function test_feeScheduleExposesExactlyTheseFunctions() public view {
        string[] memory expected = new string[](4);
        expected[0] = "SUPPLY_CONSTANT()";
        expected[1] = "TIER_COUNT()";
        expected[2] = "marketCap(uint256,uint256)";
        expected[3] = "tierFor(uint256)";
        _assertSetEquals(_functionSignatures("FeeSchedule"), expected, "FeeSchedule fonksiyonlari");
    }

    /// @dev `tierFor` ve `marketCap` `pure` OLMAK ZORUNDA -- `view`e dusmeleri
    ///      tablonun bir DURUMDAN okundugu anlamina gelirdi, ve degismezlik
    ///      garantisi BYTECODE'dan degil "setter yok" dilekcesinden gelirdi.
    ///      Iki sabit getter'i `view`dir; `public constant` icin solc'un
    ///      urettigi mutabilite budur ve degistirilemez.
    function test_feeScheduleFunctionMutabilityAndReturns() public view {
        string[] memory expected = new string[](4);
        expected[0] = "SUPPLY_CONSTANT() view -> (uint256)";
        expected[1] = "TIER_COUNT() view -> (uint256)";
        expected[2] = "marketCap(uint256,uint256) pure -> (uint256)";
        expected[3] = "tierFor(uint256) pure -> (uint256,uint256)";
        _assertSetEquals(_functionDescriptors("FeeSchedule"), expected, "FeeSchedule tanimlayicilari");
        _assertSetEquals(_constructorDescriptor("FeeSchedule"), new string[](0), "FeeSchedule constructor");
    }

    /// @dev HATA YOK, OLAY YOK, CONSTRUCTOR YOK, `receive` YOK, `fallback` YOK.
    function test_feeScheduleAbiCensus() public view {
        _assertSetEquals(_errorDescriptors("FeeSchedule"), new string[](0), "FeeSchedule hatalari");
        _assertSetEquals(_eventDescriptors("FeeSchedule"), new string[](0), "FeeSchedule olaylari");
        _assertEntryCensus("FeeSchedule", 4, 0, 0, 0, 0, 0);
    }

    /// @notice `FeeSchedule`in runtime kodunda TEK BIR `SSTORE` YOKTUR.
    ///
    /// @dev "DEPOLAMA YOK" ABI'DE GORUNMEZ VE PINLENMESI GEREKEN SEY ODUR.
    ///      Kontratin kendi NatSpec'i "degistirilemezlik garantisi
    ///      BYTECODE'DAN gelir" diyor; bu satir o cumleyi CALISTIRILABILIR
    ///      yapar. Bir `constructor` + storage dizisi ile yazilmis bir tablo
    ///      da setter'siz degistirilemez olurdu -- ama ABI kumesi AYNI kalirdi
    ///      ve yukaridaki dort iddianin HICBIRI farki gormezdi.
    ///
    /// @dev TARAMA PUSH VERISINI ATLAR. Ham bir bayt aramasi `0x55`i bir
    ///      `PUSH32` sabitinin ICINDE de bulur ve sahte alarm verirdi; bu
    ///      yuruyucu opcode sinirlarini takip eder.
    function test_theFeeScheduleRuntimeCodeContainsNoStorageWrite() public view {
        bytes memory code = vm.parseJsonBytes(_artifact("FeeSchedule"), ".deployedBytecode.object");
        assertGt(code.length, 0, "runtime kod bos");
        assertFalse(_containsOpcode(code, 0x55), "FeeSchedule SSTORE iceriyor -- tablo artik bytecode'da degil");

        // KONTROL: yuruyucu GERCEKTEN SSTORE bulabiliyor. `FeeEscrow`un defteri
        // storage'dadir; orada BULMAK ZORUNDA.
        bytes memory escrowCode = vm.parseJsonBytes(_artifact("FeeEscrow"), ".deployedBytecode.object");
        assertTrue(_containsOpcode(escrowCode, 0x55), "yuruyucu SSTORE bulamiyor -- iddia vakumla geciyor");
    }

    /// @dev PUSH1..PUSH32 (0x60..0x7f) kendi verisini ATLAR; aksi halde bir
    ///      sabitin icindeki bayt opcode sanilirdi.
    function _containsOpcode(bytes memory code, uint8 op) internal pure returns (bool) {
        uint256 i = 0;
        while (i < code.length) {
            uint8 b = uint8(code[i]);
            if (b == op) return true;
            i += (b >= 0x60 && b <= 0x7f) ? uint256(b) - 0x5f + 1 : 1;
        }
        return false;
    }

    // ---------------------------------------------------------------
    // Olay adi ve topic0 carpismalari
    // ---------------------------------------------------------------

    /// @notice `PoolSeeded`in topic0'i `Graduated`inkine ESIT DEGILDIR.
    ///
    /// @dev UCUZ, KALICI, VE GRADUATION YUZEYI TASARIMI BUNU R-10'DA ACIKCA
    ///      ISTEDI. Tehlike su: iki olay ayni topic0'i tasisaydi, birine gore
    ///      yazilmis bir `getLogs` filtresi otekini de dondurur ve Faz 3'un
    ///      indexer'i bir graduation'i IKI KEZ sayardi. Ters yon
    ///      (`test_theGraduatedEventNameIsClaimedByExactlyOneContract`) ayni
    ///      ADIN iki kontrata yayilmasini engeller; bu satir ayni TOPIC'in iki
    ///      olaya dusmesini engeller.
    function test_thePoolSeededTopicIsNotTheGraduatedTopic() public pure {
        bytes32 graduated = keccak256("Graduated(address,address,uint256,uint256)");
        bytes32 poolSeeded = keccak256("PoolSeeded(address,address,bytes32,uint160,uint128,uint256,uint256)");
        assertTrue(graduated != poolSeeded, "PoolSeeded ve Graduated ayni topic0'i tasiyor");
        assertEq(
            poolSeeded, bytes32(0x03211e5ffb9673bbadaa0cc9107605913e68ccd7516817b4bae1bccdd90d4561), "PoolSeeded topic0"
        );
    }

    // ---------------------------------------------------------------

    function _expectedHookSignatures() internal pure returns (string[] memory e) {
        e = new string[](16);
        e[0] =
            "afterAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)";
        e[1] = "afterDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)";
        e[2] = "afterInitialize(address,(address,address,uint24,int24,address),uint160,int24)";
        e[3] =
            "afterRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)";
        e[4] = "afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)";
        e[5] = "beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)";
        e[6] = "beforeDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)";
        e[7] = "beforeInitialize(address,(address,address,uint24,int24,address),uint160)";
        e[8] =
        "beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)";
        e[9] = "beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)";
        e[10] = "configOf(bytes32)";
        e[11] = "escrow()";
        e[12] = "factory()";
        e[13] = "getHookPermissions()";
        e[14] = "poolManager()";
        e[15] = "protocolTreasury()";
    }

    function _expectedHookDescriptors() internal pure returns (string[] memory e) {
        e = _expectedHookSignatures();
        e[0] = string.concat(e[0], " nonpayable -> (bytes4,int256)");
        e[1] = string.concat(e[1], " nonpayable -> (bytes4)");
        e[2] = string.concat(e[2], " nonpayable -> (bytes4)");
        e[3] = string.concat(e[3], " nonpayable -> (bytes4,int256)");
        e[4] = string.concat(e[4], " nonpayable -> (bytes4,int128)");
        e[5] = string.concat(e[5], " nonpayable -> (bytes4)");
        e[6] = string.concat(e[6], " nonpayable -> (bytes4)");
        e[7] = string.concat(e[7], " nonpayable -> (bytes4)");
        e[8] = string.concat(e[8], " nonpayable -> (bytes4)");
        e[9] = string.concat(e[9], " nonpayable -> (bytes4,int256,uint24)");
        e[10] = string.concat(e[10], " view -> (address,address,address,bool)");
        e[11] = string.concat(e[11], " view -> (address)");
        e[12] = string.concat(e[12], " view -> (address)");
        e[13] = string.concat(e[13], " pure -> (tuple)");
        e[14] = string.concat(e[14], " view -> (address)");
        e[15] = string.concat(e[15], " view -> (address)");
    }
}
