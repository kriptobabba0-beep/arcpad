// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {LaunchToken, LAUNCH_TOKEN_TOTAL_SUPPLY} from "../../src/LaunchToken.sol";
import {CurveTradingHandler} from "./CurveTradingHandler.sol";

/// @title BondingCurveInvariantsBase
/// @notice Bir launch'in TUM hayat dongusu boyunca tutmasi gereken iddialar.
///
/// @dev BU DOSYADAKI HER IDDIA MUTLAK DURUM UZERINDEDIR ya da handler'in
///      artirdigi bir GHOST SAYAC uzerindedir; hicbiri handler icinde
///      calisan bir assertion degildir. Gerekce olculdu ve Faz 1b'den
///      devralindi: `fail_on_revert = false`, fuzzed hedef fonksiyona yapilan
///      cagridaki HER revert'i -- forge-std assertion'larinin urettigi
///      revert'ler dahil -- sessizce iskartaya cikarir.
///
/// @dev IKI PROFIL, UC KONFIGURASYON. Alt siniflar:
///        - `BondingCurveInvariantsTest`          uretim `V`, creator DOLU,
///                                                kapatici giris noktalari
///                                                KAPALI -> derin
///                                                tamamlanma-oncesi ticaret
///        - `BondingCurveInvariantsTestCompletion` uretim `V`, creator DOLU,
///                                                kapaticilar ACIK ->
///                                                tamamlanma ve sonrasi
///        - `BondingCurveInvariantsTestZeroCreator` testnet `V`, creator
///                                                SIFIR, kapaticilar ACIK
///      Ayrilmalarinin sebebi olculebilir: kapaticilar acikken curve rastgele
///      dizinin ILK birkac cagrisinda tamamlanir (yedi hedeften ikisi
///      kapaticidir) ve dizinin geri kalani tamamlanma-sonrasi yola duser --
///      yani tamamlanma-oncesi aritmetigin derinligi kaybolur. Ayirmak
///      ikisini de tam boyda birakir.
abstract contract BondingCurveInvariantsBase is Test {
    BondingCurve internal curve;
    IERC20 internal token;
    FeeEscrow internal escrow;
    CurveTradingHandler internal handler;

    /// Spec 5.3: iki kutsanmis profil YALNIZCA `V`'de ayrisir.
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant S = 793_100_000e18;
    uint256 internal constant V_PRODUCTION = 4_292e18;
    uint256 internal constant V_TESTNET = 4_292e15;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant LAUNCHER = address(0xC0FFEE);

    uint256 internal virtualQuote;

    address[3] internal eoas;

    /// @dev Alt sinif curve'u kurar ve `virtualQuote`'u yazar.
    function _deployCurve() internal virtual;

    /// @dev Alt sinif hangi giris noktalarinin fuzz edilecegini secer.
    function _selectors() internal pure virtual returns (bytes4[] memory);

    function setUp() public {
        eoas[0] = address(0xA11CE);
        eoas[1] = address(0xB0B);
        eoas[2] = address(0xCAFE);

        escrow = new FeeEscrow();
        _deployCurve();
        token = IERC20(curve.token());

        // Butce, cagri basina `V/4`. Profil olcegiyle birlikte kayar, boylece
        // testnet ve uretim ayni sayida cagriyla curve'un ayni kesrini yurur.
        handler = new CurveTradingHandler(curve, eoas, virtualQuote / 4);

        // IKI TARAF DA FONLANIR VE SEBEBI OLCULDU: `vm.prank(actor)` altinda
        // `{value: x}` ile yapilan cagriyi PRANK EDILEN adres oder, cagriyi
        // fiilen yapan kontrat degil. Dolayisiyla KODSUZ aktorlerin kendi
        // bakiyesi gerekir; KODLU aktor yolunda ise cagriyi handler yapar
        // (trader forward eder) ve odeyici handler'dir.
        vm.deal(address(handler), 1e12 ether);

        // KODSUZ aktorler curve'e onay verir; KODLU aktor bunu kendi
        // constructor'inda yapar.
        for (uint256 i = 0; i < 3; i++) {
            vm.deal(eoas[i], 1e12 ether);
            vm.prank(eoas[i]);
            token.approve(address(curve), type(uint256).max);
        }

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _selectors()}));
    }

    // ---------------------------------------------------------------
    // 1. Odeme gucu
    // ---------------------------------------------------------------

    /// @notice Curve, defterinde yazili quote'u her zaman odeyebilmeli.
    /// @dev SATICININ ALDIGI HER SEY `realQuoteReserves`'ten cikar
    ///      (`proceeds <= realQuoteReserves`), dolayisiyla bakiye defteri
    ///      karsiliyorsa curve hicbir satisi karsilayamaz duruma DUSEMEZ.
    ///      `assertGe` zincirdeki gercek garantidir: Arc'ta native varlik ile
    ///      0x3600...00 adresindeki ERC-20 gorunum AYNI bakiyenin iki
    ///      gorunumudur, yani bakiye disaridan ARTABILIR.
    ///      `assertEq` ise BU handler'in dunyasinda gecerli olan daha guclu
    ///      olcum aracidir: burada bagis yolu yoktur, dolayisiyla fazla bakiye
    ///      "muhasebeye girmemis para" demektir. Ikisi bilerek birlikte durur.
    function invariant_curveHoldsAtLeastWhatItOwesTraders() public view {
        assertGe(address(curve).balance, curve.realQuoteReserves());
        assertEq(address(curve).balance, curve.realQuoteReserves());
    }

    // ---------------------------------------------------------------
    // 2. Defter ile gercek bakiye
    // ---------------------------------------------------------------

    /// @notice `realTokenReserves`, curve'un GERCEK token bakiyesinden
    ///         satilmayan artigi (`N - S`) dusmus haline esit olmali.
    /// @dev Curve arzin TAMAMINI (`N`) custody eder ama yalnizca `S`'i satar;
    ///      fark her alimda ve her satimda AYNI miktarla degistigi icin sabit
    ///      kalir. Iki tarafi da AYNI KAYNAKTAN okumamak esastir: sol taraf
    ///      curve'un defteri, sag taraf ERC-20'nin bakiyesi.
    /// @dev Ikinci satir AYNADIR ve aktor tarafindan olculur: satilmis her
    ///      token bir aktorun bakiyesindedir. Reentrancy'nin defteri bayat
    ///      rezervle uzerine yazmasi tam olarak burada gorunur.
    function invariant_realTokenReservesEqualTokenBalanceMinusSold() public view {
        assertEq(token.balanceOf(address(curve)) - curve.realTokenReserves(), LAUNCH_TOKEN_TOTAL_SUPPLY - S);

        uint256 heldByActors;
        for (uint256 i = 0; i < 4; i++) {
            heldByActors += token.balanceOf(handler.actors(i));
        }
        assertEq(heldByActors, S - curve.realTokenReserves());
    }

    // ---------------------------------------------------------------
    // 3. Curve matematigi
    // ---------------------------------------------------------------

    /// @notice Sanal sabit carpim hicbir alim/satim dizisinde kucalmez.
    /// @dev Tesadufi degil: `quoteBuyCost` alicinin odedigini YUKARI,
    ///      `quoteSellProceeds` saticinin aldigini ASAGI yuvarlar ve her iki
    ///      yuvarlama da urunu ayri ayri yukari iter. Bu iddia ayni zamanda
    ///      handler'in guvenli oldugunu da ISPATLAR: urun asla kucalmadigi
    ///      icin `virtualQuoteReserves >= V` her zaman dogrudur, yani
    ///      `realQuoteReserves` alttan tasamaz.
    function invariant_constantProductNeverDecreases() public view {
        assertGe(curve.virtualQuoteReserves() * curve.virtualTokenReserves(), virtualQuote * T);
    }

    // ---------------------------------------------------------------
    // 4. Tamamlanma geri alinamaz
    // ---------------------------------------------------------------

    /// @notice Bir kez cevrilen `complete` bir daha kapanmaz.
    /// @dev Iki taraf: handler her islemden sonra gordugunu ghost'a yazar
    ///      (`completeWasUnset`), buradaki satir ise durumu DOGRUDAN okur --
    ///      handler'in hic islem yapmadigi bir dizide bile gecerli olsun diye.
    /// @dev UCUNCU SATIR AYNADIR VE AYRI BIR MUTASYONU OLDURUR: bayragin hic
    ///      CEVRILMEMESI. `complete = true` satirini silmek yukaridaki iki
    ///      iddiayi da yesil birakir (bayrak hic gorulmez, dolayisiyla hic
    ///      geri de alinmaz) ve butun guvenlik iddialari gecerli kalir --
    ///      rezerv sifira iner, satis yolu ACIK kalir ve curve geri
    ///      "acilabilir". Bu satir `rezerv == 0 <=> complete` esdegerliginin
    ///      eksik yonudur. Ghost'a ihtiyac yok: durumun kendisi soyluyor.
    function invariant_completeIsNeverUnset() public view {
        assertEq(handler.completeWasUnset(), 0);
        if (handler.ghostSawComplete()) assertTrue(curve.complete());
        assertTrue(curve.realTokenReserves() != 0 || curve.complete(), "rezerv sifir ama complete degil");
    }

    // ---------------------------------------------------------------
    // 5. Tamamlanmadan sonra islem yok
    // ---------------------------------------------------------------

    /// @notice Tamamlanmis bir curve'de hicbir giris noktasi is goremez.
    /// @dev IKINCI SATIR TASIYICIDIR. Alim yollarinda `complete` korumasini
    ///      silmek DAVRANISI degistirmez -- `realTokenReserves == 0` oldugu
    ///      icin cagri zaten `NotEnoughTokensToBuy` ya da kismadan sonra
    ///      `CurveMath.ZeroAmount` ile duser. Yalnizca "revert etti mi" diye
    ///      soran bir iddia o mutantlari YASATIR. Bu yuzden handler revert
    ///      VERISINI de olcer ve `CurveComplete()` disinda bir selector
    ///      sayilir. Satis yolunda koruma davranissal olarak canlidir:
    ///      tamamlanmis bir curve'e satis, graduation'in bekledigi quote'u
    ///      disari cikarirdi.
    function invariant_noTradeEverSucceedsAfterCompletion() public view {
        assertEq(handler.tradeSucceededAfterCompletion(), 0);
        assertEq(handler.postCompletionRevertHadWrongSelector(), 0);
    }

    // ---------------------------------------------------------------
    // 6. Ucret parcalardan toplanir
    // ---------------------------------------------------------------

    /// @notice Escrow'a yatan iki pay tam olarak `feeOn(x,95)` ve
    ///         `feeOn(x,30)` olmali; toplamlari birlesik `125` oranindan
    ///         BOLUNMUS olmamali.
    /// @dev `feeOn(x,95) + feeOn(x,30)` ile `feeOn(x,125)` genel olarak
    ///      farklidir ve fark HER SEFERINDE protokolun aleyhinedir. Dort
    ///      sayac dort ayri sekli ayirir: parcalarin tek tek yanlisligi,
    ///      toplamin yanlisligi, tam olarak birlesik orana dusme, ve ucretin
    ///      ucuncu bir aliciya sizmasi. Yalnizca toplami olcen bir iddia
    ///      "creator payi protokole katlandi" durumunu GOREMEZDI.
    function invariant_feesAlwaysSummedFromPartsNeverDividedFromTotal() public view {
        assertEq(handler.feeWasDividedFromTotal(), 0);
        assertEq(handler.feeNotSummedFromParts(), 0);
        assertEq(handler.protocolPartWrong(), 0);
        assertEq(handler.creatorPartWrong(), 0);
        assertEq(handler.feeWentToUnknownRecipient(), 0);
    }

    // ---------------------------------------------------------------
    // 7. Tamamlanma toz birakmaz -- BU FAZIN BORCLU OLDUGU IDDIA
    // ---------------------------------------------------------------

    /// @notice Curve tamamlandigi anda `realTokenReserves` TAM SIFIR ve
    ///         `virtualTokenReserves` TAM `T - S` olmali.
    /// @dev pump.fun'da bu YAPISALDIR: `buy` tam-cikislidir, dolayisiyla
    ///      rezerv tam sifira iner -- iki canli tamamlanma olculdu, ikisi de
    ///      tam. arcpad `buyExactQuoteIn`'i rezerve KISTIGI icin o garantiyi
    ///      yapisal olmaktan cikarir; burada fuzz invariant'i olarak YENIDEN
    ///      KURULUR. Iki kapatici giris noktasi iki yolu da yurur: tam-cikisla
    ///      kalanin tamami, ve rezervi asan butceyle kisma.
    /// @dev UCUNCU SATIR GHOST'SUZDUR VE ESDEGERLIGIN EKSIK YONUNU KAPATIR.
    ///      Ilk iki satir yalnizca tamamlanmanin GERCEKLESTIGI islemi olcer;
    ///      tamamlanma esigini gevsetip `realTokenReserves == 0` yerine
    ///      `<= 1e18` yazan bir mutant, o esigi fuzzer'in tam olarak o araliga
    ///      dusmesini gerektirdigi icin ghost sayacini hic tetiklemeyebilir.
    ///      Bu satir durumun kendisini okur: `complete` ise rezerv SIFIR
    ///      olmalidir. `invariant_completeIsNeverUnset`teki ters yonle birlikte
    ///      (`rezerv == 0` ise `complete`) TAM ESDEGERLIK elde edilir.
    function invariant_exactOutCompletionLeavesNoDust() public view {
        assertEq(handler.completionLeftDust(), 0);
        assertEq(handler.completionLeftWrongVirtualReserves(), 0);
        assertTrue(!curve.complete() || curve.realTokenReserves() == 0, "complete ama rezerv sifir degil");
    }

    // ---------------------------------------------------------------
    // 8. Kullanilabilirlik -- GIRIS NOKTASI BASINA
    // ---------------------------------------------------------------

    /// @notice Gecerli her cagri icin hicbir giris noktasi revert ETMEMELI.
    /// @dev YUKARIDAKI YEDI IDDIANIN HEPSI GUVENLIK IDDIASIDIR VE HICBIR SEY
    ///      YAPMAYAN BIR KONTRAT HEPSINI SAGLAR. Mekanizma olculdu (Faz 1b,
    ///      escrow): `fail_on_revert = false` revert eden handler cagrisini
    ///      yutar, ve ayni revert ghost artirimini da geri alir -- kontrat
    ///      durumu ile ghost durumu TAM OLARAK islem basarisiz oldugu ICIN
    ///      tutarli kalir. Care `try/catch` + sifir iddia edilen bir sayactir
    ///      ve BURADA YEDI GIRIS NOKTASININ HEPSINE ayri ayri uygulanir:
    ///      "bir ozelligin bir giris noktasinda kapatilmasi hepsinde
    ///      kapatilmis gibi okunur" bu depoda dokuz kez olustu.
    /// @dev `buyOverBudgetQuoteIn` satiri `buyExactQuoteIn`'in KISMASINI
    ///      koruyan tek seydir: kisma kaldirilirsa `realTokenReserves -=
    ///      tokensOut` alttan tasar, cagri revert eder ve guvenlik
    ///      iddialarinin HICBIRI bunu goremez.
    function invariant_everyEntrypointStaysAvailable() public view {
        assertEq(handler.buyExactTokensOutReverted(), 0, "buyExactTokensOut");
        assertEq(handler.buyExactQuoteInReverted(), 0, "buyExactQuoteIn");
        assertEq(handler.sellReverted(), 0, "sellExactTokensIn");
        assertEq(handler.buyRemainingExactOutReverted(), 0, "buyRemainingExactOut");
        assertEq(handler.buyOverBudgetQuoteInReverted(), 0, "buyOverBudgetQuoteIn");
        assertEq(handler.reentrantBuyReverted(), 0, "reentrantBuy");
        assertEq(handler.reentrantSellReverted(), 0, "reentrantSell");
    }

    // ---------------------------------------------------------------
    // 9. Ghost akislari defterle ortusur
    // ---------------------------------------------------------------

    /// @notice Aktor ve bakiye tarafinda olculen akislar curve'un defteriyle
    ///         ortusmeli.
    /// @dev KAYNAKLAR BILEREK DEFTERIN DISINDADIR. Ghost degerleri curve'un
    ///      kendi rezerv alanlarindan okunsaydi kimlik `x == x`'e indirgenir
    ///      ve kontrat ne yazarsa yazsin gecerdi -- bu depoda bir kez olustu
    ///      (bkz. CurveMathInvariants.t.sol tautoloji notu). Quote tarafi
    ///      curve'un NATIVE BAKIYESINDEN, token tarafi AKTORUN ERC-20
    ///      bakiyesinden okunur.
    ///
    /// @dev DUZELTME (inceleme): bu gerekce ILK IKI SATIR icin gecerlidir,
    ///      `curveInMismatch` icin DEGIL. O sayacin olctugu delta
    ///      `virtualQuoteReserves()` farkidir, yani DEFTERDEN okunur.
    ///      Tautoloji olmamasinin sebebi kaynagin disarida olmasi degil,
    ///      KARSILASTIRILAN SEYIN farkli olmasidir: beklenen deger cagridan
    ///      ONCE, giris noktasinin algoritmasi handler'da yeniden yurutulerek
    ///      hesaplanir (`_expectedForQuoteIn` / `_expectedForExactOut`), sonra
    ///      defterin fiilen ne kadar kaydigina bakilir. Yani iddia "defter
    ///      kendisiyle tutarli" degil, "defter kaydi kontratin izlemesi gereken
    ///      algoritmanin verdigi sayi kadar" demektir. `CurveMath`in KENDISI
    ///      mutasyona ugrarsa iki taraf birlikte kayar ve bu sayac gormez --
    ///      o katman `CurveMath*.t.sol` tarafindan korunur (bkz. handler bas
    ///      notu).
    function invariant_ghostFlowsMatchTheLedger() public view {
        assertEq(curve.realQuoteReserves(), handler.ghostQuoteIn() - handler.ghostQuoteOut());
        assertEq(curve.realTokenReserves(), S + handler.ghostTokensIn() - handler.ghostTokensOut());
        assertEq(handler.curveInMismatch(), 0, "curveIn");
        assertEq(handler.tokensMovedMismatch(), 0, "tokensMoved");
    }

    // ---------------------------------------------------------------
    // KAPSAM TABANLARI -- her KOSUNUN sonunda, konfigurasyona gore
    // ---------------------------------------------------------------

    /// @notice Foundry bunu her invariant KOSUSUNUN sonunda cagirir. Buradaki
    ///         iddialar guvenlik degil KAPSAM iddialaridir.
    ///
    /// @dev NICIN GEREKLI. Yukaridaki dokuz invariant'in bir kismi ancak belirli
    ///      hucreler yurunduyse ANLAMLIDIR:
    ///      `feesAlwaysSummedFromPartsNeverDividedFromTotal` yalnizca ucreti
    ///      fiilen olculmus bir islem varsa, `noTradeEverSucceedsAfterCompletion`
    ///      yalnizca tamamlanma sonrasi bir deneme yapildiysa bir sey soyler.
    ///      Sayaclar bastan beri tutuluyordu ama HICBIR IDDIA ONLARI OKUMUYORDU
    ///      -- yani bir kosu sessizce bos gecebilirdi. Olculdu: ornek
    ///      kosularda `sellsMeasuredForFees` = 0 (kapaticili iki konfigurasyon),
    ///      `callsWhileComplete` = 0 (kapaticisiz konfigurasyon),
    ///      `clampsObserved` = 0 (uc konfigurasyonun her birinde en az bir
    ///      kosuda). Bu, bu dosyanin kendi "bir giris noktasinda kapatilan
    ///      ozellik hepsinde kapatilmis gorunur" desenidir, KAPSAM SAYACI
    ///      mekanizmasinin kendisine uygulanmis hali.
    ///
    /// @dev TABANLAR YAPISAL OLARAK GARANTI OLANLARLA SINIRLI, VE HANGILERININ
    ///      GARANTI OLDUGU TAHMIN EDILMEDI, OLCULDU. Ilk denemede buraya
    ///      `sellsMeasuredForFees > 0` da konmustu ve `--fuzz-seed 1` altinda
    ///      256 kosunun en az birinde DUSTU (`0 <= 0`); iki kapaticili
    ///      konfigurasyonda ise curve dizinin ilk cagrilarinda tamamlandigi icin
    ///      satis olcumu SIK SIK hic olmuyor (ornek kosularda sellsFee = 0).
    ///      Yani "her kosuda en az bir satisin ucreti olculur" YANLIS bir
    ///      iddiadir ve buraya konmasi paketi gudumlu-kirilgan yapardi.
    ///      Rastgele dizide garanti OLMAYAN her sey burada DEGIL,
    ///      deterministik `test_` fonksiyonlarinda iddia ediliyor:
    ///      satis/alim ucret olcumu ve iki tamamlanma yolu
    ///      `test_completionFromManyStatesLeavesNoDustOnEitherPath` icinde,
    ///      reentrancy penceresi `test_theCodedActorActuallyReentersTheCurve`
    ///      icinde.
    ///
    /// @dev Buradaki iki aktor tabani en saglam olanlar: `tradesBy*Actor`
    ///      sayaclari her DENEMEDE artar -- basarisiz cagrilarda ve tamamlanma
    ///      sonrasi denemelerde de -- dolayisiyla 64 cagrilik bir dizide
    ///      sifir kalmalari icin fuzzer'in tek bir aktor sinifina hic
    ///      dusmemesi gerekir.
    function afterInvariant() public view {
        assertGt(handler.tradesByCodelessActor(), 0, "kodsuz aktor hic islem denemedi");
        assertGt(handler.tradesByCodedActor(), 0, "kodlu aktor hic islem denemedi");
        _afterInvariantForThisProfile();
    }

    /// @dev Konfigurasyona ozgu taban; alt sinif doldurur.
    function _afterInvariantForThisProfile() internal view virtual;

    // ---------------------------------------------------------------
    // HUCRE YURUYUSU -- fuzz'in yurudugunu VARSAYMAK yerine OLCMEK
    // ---------------------------------------------------------------

    /// @notice Yirmi farkli ara durumdan, IKI tamamlanma yolunun IKISIYLE de
    ///         tamamlar ve her seferinde toz olmadigini dogrular.
    ///
    /// @dev NICIN AYRI BIR TEST, `invariant_exactOutCompletionLeavesNoDust`
    ///      VARKEN. Cunku o invariant'in bos yere yesil olup olmadigi
    ///      OLCULDU: kapaticilar acikken curve rastgele dizinin ilk etkili
    ///      cagrisinda tamamlanir ve HANGI kapaticinin kazandigi rastgeledir
    ///      -- ornek bir kosuda `clampsObserved` SIFIR cikti, yani o kosuda
    ///      kisma yolu HIC yurunmedi. Bu test o rastgeleligi kaldirir:
    ///      k cift ise tam-cikisla, tek ise rezervi asan butceyle tamamlar.
    ///
    /// @dev OZEL DURUM DEGIL OZELLIK SEKLI: yirmi farkli ara durum, iki yol.
    ///      Elle yazilmis iki vaka ailenin yalnizca iki uyesini kapatirdi.
    function test_completionFromManyStatesLeavesNoDustOnEitherPath() public {
        for (uint256 k = 0; k < 20; k++) {
            uint256 snap = vm.snapshotState();

            _warmUp(k);
            // TESTIN KENDI ON KOSULU. Isinma turu curve'u tamamlasaydi
            // asagidaki iddialar BASKA bir olay hakkinda olurdu ve test
            // "kimsenin yazmadigi bir sebeple" gecerdi.
            assertFalse(curve.complete(), "isinma turu curve'u tamamladi");

            if (k % 2 == 0) {
                handler.buyRemainingExactOut(k, k);
            } else {
                handler.buyOverBudgetQuoteIn(k);
                assertGt(handler.clampsObserved(), 0, "kisma yolu yurunmedi");
            }

            // UCRET OLCUMUNUN FIILEN CALISTIGI BURADA IDDIA EDILIYOR, ve
            // burada cunku rastgele dizide garanti DEGIL (bkz. afterInvariant
            // notu). `_warmUp` k >= 3'te en az bir alim ve bir satis yurutur,
            // dolayisiyla `feesAlwaysSummedFromPartsNeverDividedFromTotal`in
            // BOS YERE yesil olmadigi deterministik olarak gosterilir.
            if (k >= 3) {
                assertGt(handler.buysMeasuredForFees(), 0, "hicbir alimda ucret olculmedi");
                assertGt(handler.sellsMeasuredForFees(), 0, "hicbir satista ucret olculmedi");
            }

            assertTrue(curve.complete(), "tamamlanmadi");
            assertEq(curve.realTokenReserves(), 0, "TOZ");
            assertEq(curve.virtualTokenReserves(), T - S, "sanal token rezervi T-S degil");
            assertEq(handler.completions(), 1, "tamamlanma sayisi");
            assertEq(handler.completionLeftDust(), 0, "completionLeftDust");
            assertEq(handler.completionLeftWrongVirtualReserves(), 0, "completionLeftWrongVirtualReserves");
            _assertNoAvailabilityFailures();

            // TAMAMLANMA SONRASI DAL DA DETERMINISTIK OLARAK YURUNUR.
            // `afterInvariant` buna taban KOYAMAZ (tamamlanma dizinin son
            // cagrisinda olursa sonrasinda hic deneme kalmaz), ama burada curve
            // zaten tamamlanmis durumda: asagidaki uc cagri UCU DE
            // `_attemptAfterCompletion`a duser -- `callsWhileComplete` her
            // birinde kosulsuz artar, dolayisiyla `+3` TAM olarak beklenir.
            // Bu, `invariant_noTradeEverSucceedsAfterCompletion`in bos yere
            // yesil olmadiginin deterministik kanitidir, ve ikinci satiri
            // (revert VERISININ `CurveComplete()` oldugu) uc giris noktasinda
            // birden yurutur -- I4/I5 mutantlarini olduren sey odur.
            uint256 attemptsBefore = handler.callsWhileComplete();
            handler.buyExactTokensOut(k, k);
            handler.buyExactQuoteIn(k, k);
            handler.sell(k, k);
            assertEq(handler.callsWhileComplete(), attemptsBefore + 3, "tamamlanma sonrasi dal yurunmedi");
            assertEq(handler.tradeSucceededAfterCompletion(), 0, "tamamlanmis curve'de islem BASARDI");
            assertEq(handler.postCompletionRevertHadWrongSelector(), 0, "revert CurveComplete() degil");

            vm.revertToState(snap);
        }
    }

    /// @notice KODLU aktorun `receive()` icinden curve'e GERCEKTEN geri
    ///         girdigini olcer.
    /// @dev Faz 1b'nin olculen kor noktasi tam olarak buydu: handler'in uc
    ///      alicisi da kodsuzdu, `.call{value:...}("")` her zaman trivial
    ///      basarili donuyordu ve reentrancy penceresi HIC ACILMIYORDU --
    ///      paket, korumak icin yazildigi seye yapisal olarak kordu. Bu test
    ///      pencerenin acildigini SAYIYLA gosterir; acilmazsa yukaridaki
    ///      ledger/odeme gucu iddialarinin CEI hakkinda soyledigi hicbir sey
    ///      gecerli degildir.
    function test_theCodedActorActuallyReentersTheCurve() public {
        // Once kodlu aktore token ve bakiye kazandiran bir alim (aktor 3).
        handler.buyExactTokensOut(3, S / 512);
        assertGt(token.balanceOf(address(handler.reentrantTrader())), 0, "kodlu aktorde token yok");

        // Miktar OLCULU: `type(uint256).max` kalan rezervin TAMAMINI alir ve
        // curve'u tamamlar; o durumda ic cagri `CurveComplete()` ile duser ve
        // pencere acilmis gorunmez. Olculdu.
        handler.reentrantBuy(S / 512);
        uint256 afterBuy = handler.reentriesObserved();
        assertGt(afterBuy, 0, "alim yolunda geri girilmedi");

        handler.reentrantSell(type(uint256).max);
        assertGt(handler.reentriesObserved(), afterBuy, "satis yolunda geri girilmedi");

        _assertNoAvailabilityFailures();
    }

    /// @dev ISINMA TURU KONTROLLU, IKINCI BIR RASTGELE DIZI DEGIL -- ve bu
    ///      duzeltme OLCUMLE geldi. Ilk hali aktoru de `seed`den turetiyordu,
    ///      dolayisiyla bir `sell` cagrisi cogu zaman BAKIYESI SIFIR bir aktore
    ///      dusup sessizce erken donuyordu: `sellsMeasuredForFees` SIFIR
    ///      kaliyordu ve asagidaki iddia dusuyordu (uc ayri fuzz-seed'de,
    ///      `0 <= 0`). Simdi her turda AYNI aktorle once alim, sonra satis
    ///      yapilir; bakiye tanim geregi sifir olamaz, `ProceedsTooSmall` on
    ///      filtresi devreye girmez ve satis ucret olcumu GARANTIDIR.
    /// @dev Miktarlar kucuk tutulur: yirmi turun toplami satis arzinin ~%7'sini
    ///      gecmez, yani isinma turu curve'u tamamlayamaz (ustteki
    ///      `assertFalse(curve.complete())` bunu ayrica dogrular).
    function _warmUp(uint256 k) internal {
        for (uint256 i = 0; i < k; i++) {
            uint256 who = i % 4;
            uint256 amount = (uint256(keccak256(abi.encode(k, i))) % (S / 256)) + 1e18;
            handler.buyExactTokensOut(who, amount);
            if (i % 3 == 2) handler.sell(who, amount / 2);
        }
    }

    function _assertNoAvailabilityFailures() internal view {
        assertEq(handler.buyExactTokensOutReverted(), 0, "buyExactTokensOut");
        assertEq(handler.buyExactQuoteInReverted(), 0, "buyExactQuoteIn");
        assertEq(handler.sellReverted(), 0, "sellExactTokensIn");
        assertEq(handler.buyRemainingExactOutReverted(), 0, "buyRemainingExactOut");
        assertEq(handler.buyOverBudgetQuoteInReverted(), 0, "buyOverBudgetQuoteIn");
        assertEq(handler.reentrantBuyReverted(), 0, "reentrantBuy");
        assertEq(handler.reentrantSellReverted(), 0, "reentrantSell");
    }

    // ---------------------------------------------------------------
    // Yardimcilar
    // ---------------------------------------------------------------

    function _allSelectors() internal pure returns (bytes4[] memory sel) {
        sel = new bytes4[](7);
        sel[0] = CurveTradingHandler.buyExactTokensOut.selector;
        sel[1] = CurveTradingHandler.buyExactQuoteIn.selector;
        sel[2] = CurveTradingHandler.sell.selector;
        sel[3] = CurveTradingHandler.buyRemainingExactOut.selector;
        sel[4] = CurveTradingHandler.buyOverBudgetQuoteIn.selector;
        sel[5] = CurveTradingHandler.reentrantBuy.selector;
        sel[6] = CurveTradingHandler.reentrantSell.selector;
    }

    function _tradingSelectors() internal pure returns (bytes4[] memory sel) {
        sel = new bytes4[](5);
        sel[0] = CurveTradingHandler.buyExactTokensOut.selector;
        sel[1] = CurveTradingHandler.buyExactQuoteIn.selector;
        sel[2] = CurveTradingHandler.sell.selector;
        sel[3] = CurveTradingHandler.reentrantBuy.selector;
        sel[4] = CurveTradingHandler.reentrantSell.selector;
    }

    /// @dev Curve'u factory ile, yani URUNDEKI TEK YOLLA kurar.
    function _launchViaFactory(uint256 v) internal {
        LaunchFactory factory = new LaunchFactory(address(escrow), TREASURY, T, v, S);
        vm.prank(LAUNCHER);
        (, address curveAddr) = factory.launch("arcpad", "ARC", "ipfs://arcpad");
        curve = BondingCurve(curveAddr);
        virtualQuote = v;
    }
}

/// @notice Uretim profili, creator DOLU, kapaticilar KAPALI.
/// @dev Kapaticilar kapali oldugu icin curve rastgele dizide (bu butcelerle)
///      pratikte tamamlanmaz; bu konfigurasyonun isi tamamlanma ONCESI
///      aritmetigi tam derinlikte surmektir.
contract BondingCurveInvariantsTest is BondingCurveInvariantsBase {
    function _deployCurve() internal override {
        _launchViaFactory(V_PRODUCTION);
    }

    function _selectors() internal pure override returns (bytes4[] memory) {
        return _tradingSelectors();
    }

    /// @dev BU KONFIGURASYONDA EK BIR TABAN YOK, ve sebebi tahmin degil OLCUM.
    ///      Buraya once `buysMeasuredForFees > 0` konmustu; `--fuzz-seed 2` ve
    ///      `3` altinda DUSTU. Mekanizma: `reentrantBuy` hedefi `tokensOut`u
    ///      `_bound(amount, 1, realTokenReserves)` ile sinirlar ve fuzzer'in
    ///      sozlugu `type(uint256).max`i sever, yani ILK cagri kalan rezervin
    ///      TAMAMINI alip curve'u tamamlayabilir. O cagri kodlu aktoru
    ///      SILAHLANDIRDIGI icin ucret olcumu atlanir (ic islem deltalari
    ///      bozar), ve tamamlanmadan sonra HICBIR cagri olculmez -- dolayisiyla
    ///      sayac butun kosu boyunca sifir kalir. Bu bir kusur degil, dizinin
    ///      mesru bir sonucudur; iddia edilemez olan sey odur.
    ///      Tamamlanma da garanti degildir (kapatici yok), o yuzden `completions`
    ///      uzerine de taban konmaz. Ucret olcumunun fiilen calistigi
    ///      `test_completionFromManyStatesLeavesNoDustOnEitherPath` icinde
    ///      deterministik olarak iddia ediliyor.
    function _afterInvariantForThisProfile() internal view override {}
}

/// @notice Uretim profili, creator DOLU, kapaticilar ACIK.
/// @dev Tamamlanmayi ve tamamlanma SONRASINI suren konfigurasyon.
contract BondingCurveInvariantsTestCompletion is BondingCurveInvariantsBase {
    function _deployCurve() internal override {
        _launchViaFactory(V_PRODUCTION);
    }

    function _selectors() internal pure override returns (bytes4[] memory) {
        return _allSelectors();
    }

    /// @dev Yedi hedeften IKISI kapatici, dolayisiyla 64 cagrilik bir dizide
    ///      tamamlanmanin gerceklesmemesi olasiligi (5/7)^64 ~ 2e-9'dur;
    ///      taban gudumlu degil YAPISALDIR. `== 1` cunku tamamlanma geri
    ///      alinamaz, ikinci kez olamaz.
    /// @dev Yedi hedeften IKISI kapatici, dolayisiyla 64 cagrilik bir dizide
    ///      tamamlanmanin gerceklesmemesi olasiligi (5/7)^64 ~ 2e-9'dur; taban
    ///      gudumlu degil YAPISALDIR. `== 1` cunku tamamlanma geri alinamaz.
    ///      `callsWhileComplete` uzerine taban KONMAZ: tamamlanma dizinin SON
    ///      cagrisinda olursa sonrasinda deneme kalmaz.
    function _afterInvariantForThisProfile() internal view override {
        assertEq(handler.completions(), 1, "curve tamamlanmadi");
    }
}

/// @notice Testnet profili, creator SIFIR, kapaticilar ACIK.
///
/// @dev CREATOR SIFIR OLAN BIR CURVE FACTORY ILE URETILEMEZ -- `launch`
///      creator'i `msg.sender` yapar. Bu yuzden burada `BondingCurve`
///      DOGRUDAN deploy edilir ve bu test kontrati curve'un `factory`si
///      olur; ardindan token basilir ve `bind` cagrilir. Kurulum urundeki
///      yolun aynisidir, yalnizca creator sifirdir.
///
/// @dev NICIN GEREKLI: "creator payi ALINMAZ ve protokol payina KATLANMAZ"
///      kuralinin YASADIGI hucre burasidir, ve `buyExactQuoteIn` icindeki
///      `creatorBps` ternary'si bu depoda bir kez mutasyonla 37/37 yesil
///      birakmis bir hucredir. Testnet `V`'si ayni anda ikinci profili de
///      yurur.
contract BondingCurveInvariantsTestZeroCreator is BondingCurveInvariantsBase {
    function _deployCurve() internal override {
        curve = new BondingCurve(address(0), address(escrow), TREASURY, T, V_TESTNET, S);
        LaunchToken t = new LaunchToken("arcpad", "ARC", "ipfs://arcpad", LAUNCHER, address(curve), bytes32(0));
        curve.bind(address(t));
        virtualQuote = V_TESTNET;
    }

    function _selectors() internal pure override returns (bytes4[] memory) {
        return _allSelectors();
    }

    /// @dev Yedi hedeften IKISI kapatici, dolayisiyla 64 cagrilik bir dizide
    ///      tamamlanmanin gerceklesmemesi olasiligi (5/7)^64 ~ 2e-9'dur; taban
    ///      gudumlu degil YAPISALDIR. `== 1` cunku tamamlanma geri alinamaz.
    ///      `callsWhileComplete` uzerine taban KONMAZ: tamamlanma dizinin SON
    ///      cagrisinda olursa sonrasinda deneme kalmaz.
    function _afterInvariantForThisProfile() internal view override {
        assertEq(handler.completions(), 1, "curve tamamlanmadi");
    }
}
