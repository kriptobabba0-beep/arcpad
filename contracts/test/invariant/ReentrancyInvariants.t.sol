// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {FeeSchedule} from "../../src/FeeSchedule.sol";
import {LAUNCH_TOKEN_TOTAL_SUPPLY} from "../../src/LaunchToken.sol";
import {
    DirectCurveFactory,
    HostileToken,
    ReentrantActor,
    ReentryLog,
    P_BUY_TOKEN_TRANSFER,
    P_BUY_REFUND,
    P_SELL_TOKEN_TRANSFER_FROM,
    P_SELL_PAYOUT,
    P_GRADUATION_TOKEN_TRANSFER,
    P_GRADUATION_PAYOUT,
    P_ESCROW_CLAIM
} from "./ReentrantAttacker.sol";
import {ReentrancyHandler} from "./ReentrancyHandler.sol";

/// @title ReentrancyInvariantsBase
/// @notice `BondingCurve` ve `FeeEscrow`un MERKEZI IDDIASINI -- "kati CEI
///         reentrancy guard'i gereksiz kilar" -- fuzz'layan kampanya.
///
/// @dev NICIN VAR. `production-hardening.md` §5.6 bu boslugu adiyla kaydetti:
///      *"Hicbir fuzz paketinde yeniden girebilen bir aktor YOK -- bu rapor
///      icin kurulan da dahil."* O tarihte iddia su ucune dayaniyordu: dikkatli
///      okuma, deterministik birim testleri, ve reentrancy'i "MUMKUN" diye
///      isaretleyen iki statik analizci. Bu dosya dorduncu ayagi koyar.
///
/// @dev DORT CURVE, TEK ESCROW, TEK FACTORY -- ve dordunculerin biri DUSMAN
///      BIR TOKEN'A baglidir. Sebep sayilarak bulundu: kaynaktaki YEDI
///      yeniden giris noktasindan UCU (`_settleBuy`in `transfer`i, satisin
///      `transferFrom`u, `graduate()`in `transfer`i) TOKEN'IN kodudur ve
///      `LaunchToken` OZ ERC20'sidir -- yani urun yolunda o uc nokta
///      ULASILAMAZ. `bind`in NatSpec'i bunun neden bir kusur degil bir kisit
///      oldugunu zaten yaziyor ("BU BIR YAPILANDIRMA KONTROLUDUR, MULKIYET
///      KANITI DEGIL"); burada o kisitin ALTINDAKI dunya kuruluyor.
///
/// @dev NE OLCULMUYOR, ACIKCA: `CurveMath`in KENDISI. Beklentiler yine
///      `CurveMath` ile kurulur, dolayisiyla kutuphane icindeki bir mutasyon
///      iki tarafi birden kaydirir -- `CurveTradingHandler`in bas notundaki
///      ayni sinirlama. O katman `CurveMath*.t.sol` tarafindan korunur.
abstract contract ReentrancyInvariantsBase is Test {
    /// Faz 2: factory'nin yedinci constructor argumani. KODU OLMALI.
    FeeSchedule internal FEE_SCHEDULE;

    /// Spec 5.3: iki kutsanmis profil YALNIZCA `V`'de ayrisir.
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant S = 793_100_000e18;
    uint256 internal constant V_PRODUCTION = 4_292e18;
    uint256 internal constant V_TESTNET = 4_292e15;

    uint256 internal constant N_CURVES = 4;
    /// @dev Dusman token'a bagli curve. Uc token noktasi (P1/P3/P5) YALNIZCA
    ///      burada ulasilabilir.
    uint256 internal constant HOSTILE = 3;

    address internal constant EOA = address(0xA11CE);

    FeeEscrow internal escrow;
    LaunchFactory internal factory;
    DirectCurveFactory internal direct;
    ReentryLog internal reentryLog;
    ReentrancyHandler internal handler;

    ReentrantActor internal actor0;
    ReentrantActor internal actor1;
    ReentrantActor internal actor2;

    BondingCurve[N_CURVES] internal curves;
    IERC20[N_CURVES] internal tokens;
    address[N_CURVES] internal creators;

    /// @notice KORUNUM CEMBERI. Native ve token muhasebesinin toplandigi
    ///         adres kumesi; disina cikan tek bir wei korunumu bozar.
    address[] internal perimeter;
    uint256 internal totalNativeFunded;

    uint256 internal virtualQuote;

    function _virtualQuote() internal pure virtual returns (uint256);

    function _selectors() internal pure virtual returns (bytes4[] memory);

    function setUp() public {
        FEE_SCHEDULE = new FeeSchedule();
        virtualQuote = _virtualQuote();

        escrow = new FeeEscrow();
        reentryLog = new ReentryLog();

        actor0 = new ReentrantActor(reentryLog);
        actor1 = new ReentrantActor(reentryLog);
        actor2 = new ReentrantActor(reentryLog);

        // TREASURY DE KODLU BIR AKTORDUR. Boylece `claim(treasury)` yolu (P7)
        // gercek bir `receive()` calistirir; kodsuz bir treasury o noktayi
        // YAPISAL OLARAK olu birakirdi -- Faz 1b'nin escrow handler'inin
        // olculmus kor noktasinin aynisi.
        factory = new LaunchFactory(
            address(escrow), address(actor1), address(this), T, virtualQuote, S, address(FEE_SCHEDULE)
        , address(0));

        // Uc curve URUN YOLUYLA: creator'lari aktorlerdir, dolayisiyla
        // creator ucreti de silahli bir alicida birikir.
        creators[0] = address(actor0);
        creators[1] = address(actor1);
        creators[2] = address(actor2);
        _launch(0, address(actor0), "arcpad-a", "ARCA");
        _launch(1, address(actor1), "arcpad-b", "ARCB");
        _launch(2, address(actor2), "arcpad-c", "ARCC");

        // Dorduncu curve DOGRUDAN deploy edilir ve DUSMAN bir token'a
        // baglanir. Creator SIFIRDIR: "creator payi alinmaz ve protokol payina
        // KATLANMAZ" kuralinin yasadigi hucre boylece bu kampanyada da yurunur.
        direct =
            new DirectCurveFactory(address(escrow), address(actor1), address(actor0), address(0), T, virtualQuote, S);
        curves[HOSTILE] = direct.curve();
        tokens[HOSTILE] = IERC20(address(direct.token()));
        creators[HOSTILE] = address(0);

        // GERCEK YOL: oner, uc gun bekle, indir.
        factory.proposeGraduationTarget(address(actor0));
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();
        assertEq(factory.graduationTarget(), address(actor0), "hedef inmedi");

        // PROFIL PINI. Uc konfigurasyon YALNIZCA `V`'de ayrisir ve o ayrim
        // fuzz sayaclarinda gorunmez (ayni opcode'lar, ayni gaz); pin
        // olmadan, `_virtualQuote()` override'i sessizce dusse de uc
        // konfigurasyon da YESIL kalirdi -- yani "iki profil de yurundu"
        // iddiasi hicbir seye dayanmazdi.
        assertEq(curves[0].INITIAL_VIRTUAL_QUOTE_RESERVES(), virtualQuote, "profil kanonik curve'e inmedi");
        assertEq(curves[HOSTILE].INITIAL_VIRTUAL_QUOTE_RESERVES(), virtualQuote, "profil dusman curve'e inmedi");

        handler = new ReentrancyHandler(
            ReentrancyHandler.World({
                escrow: escrow,
                factory: factory,
                log: reentryLog,
                eoa: EOA,
                protocolTreasury: address(actor1),
                maxQuotePerCall: virtualQuote / 4,
                saleSupply: S
            }),
            curves,
            tokens,
            creators,
            [actor0, actor1, actor2]
        );

        address[] memory payees = new address[](5);
        payees[0] = address(actor1); // protocolTreasury
        payees[1] = address(actor0);
        payees[2] = address(actor1);
        payees[3] = address(actor2);
        payees[4] = EOA;

        BondingCurve[] memory cs = new BondingCurve[](N_CURVES);
        IERC20[] memory ts = new IERC20[](N_CURVES);
        for (uint256 i = 0; i < N_CURVES; i++) {
            cs[i] = curves[i];
            ts[i] = tokens[i];
        }
        actor0.init(escrow, factory, cs, ts, payees, virtualQuote / 4);
        actor1.init(escrow, factory, cs, ts, payees, virtualQuote / 4);
        actor2.init(escrow, factory, cs, ts, payees, virtualQuote / 4);

        // --- fonlama ve korunum cemberi ---
        vm.deal(address(handler), 1e12 ether);
        vm.deal(address(actor0), 1e12 ether);
        vm.deal(address(actor1), 1e12 ether);
        vm.deal(address(actor2), 1e12 ether);
        vm.deal(EOA, 1e12 ether);

        perimeter.push(address(escrow));
        perimeter.push(address(factory));
        perimeter.push(address(direct));
        perimeter.push(address(handler));
        perimeter.push(address(actor0));
        perimeter.push(address(actor1));
        perimeter.push(address(actor2));
        perimeter.push(EOA);
        perimeter.push(address(this));
        for (uint256 i = 0; i < N_CURVES; i++) {
            perimeter.push(address(curves[i]));
        }

        for (uint256 i = 0; i < N_CURVES; i++) {
            vm.prank(EOA);
            tokens[i].approve(address(curves[i]), type(uint256).max);
        }

        // TOPLAM, `vm.deal` CAGRILARININ TOPLAMI OLARAK DEGIL, CEMBERIN
        // FIILEN OLCULEN BAKIYESI OLARAK ALINIR -- ve bu duzeltme OLCUMLE
        // geldi: forge test kontratina varsayilan olarak `2^96 - 1` wei verir
        // (79228162514264337593543950335, gozlendi), yani "fonladiklarimin
        // toplami" kimligi kurulumda ZATEN yanlisti. Kalibrasyonu cemberin
        // kendisinden almak ayni zamanda daha dogru iddiadir: olculen sey
        // "kampanya boyunca cemberin toplami DEGISMEDI"dir.
        totalNativeFunded = _perimeterNative();

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _selectors()}));
    }

    function _launch(uint256 i, address creator, string memory name_, string memory symbol_) internal {
        vm.prank(creator);
        (address token, address curve) = factory.launch(name_, symbol_, "ipfs://arcpad");
        curves[i] = BondingCurve(curve);
        tokens[i] = IERC20(token);
    }

    function _perimeterNative() internal view returns (uint256 total) {
        for (uint256 i = 0; i < perimeter.length; i++) {
            total += perimeter[i].balance;
        }
    }

    // ---------------------------------------------------------------
    // 1. Escrow odeme gucu
    // ---------------------------------------------------------------

    /// @notice Escrow her zaman borcunu odeyebilir, defteri toplami tutar, ve
    ///         bakiyesi ile toplam borcu AYRISMAZ.
    /// @dev `assertGe` zincirdeki gercek garantidir (Arc'ta bakiye disaridan
    ///      ARTABILIR, kisit 1); `assertEq` bu dunyada gecerli olan daha guclu
    ///      olcumdur -- burada bagis yolu yoktur, dolayisiyla fazla bakiye
    ///      "muhasebeye girmemis para" demektir. Ucuncu satir defterin
    ///      KENDI ICINDE tutarli oldugunu soyler ve bagimsizdir: `owed`
    ///      toplaminin `totalOwed`dan ayrilmasi ilk iki satiri kirmaz.
    function invariant_escrowIsSolventAndItsLedgerAdds() public view {
        assertGe(address(escrow).balance, escrow.totalOwed(), "escrow borcunu odeyemez");
        assertEq(address(escrow).balance, escrow.totalOwed(), "escrow bakiyesi defterinden ayristi");

        uint256 summed;
        for (uint256 i = 0; i < perimeter.length; i++) {
            summed += escrow.owed(perimeter[i]);
        }
        assertEq(summed, escrow.totalOwed(), "owed toplami totalOwed degil");
    }

    // ---------------------------------------------------------------
    // 2. Her curve kendi defterini karsilar
    // ---------------------------------------------------------------

    /// @dev FAZA GORE AYRILIR: graduation `R`yi bakiyeden cikarir ama
    ///      `realQuoteReserves`i BILEREK sifirlamaz (tasarim 7.2 madde 7).
    function invariant_everyCurveCoversItsOwnLedger() public view {
        for (uint256 i = 0; i < N_CURVES; i++) {
            BondingCurve c = curves[i];
            if (c.graduated()) {
                assertEq(address(c).balance, 0, "mezun curve bakiye tutuyor");
            } else {
                assertGe(address(c).balance, c.realQuoteReserves(), "curve defterini karsilamiyor");
                assertEq(address(c).balance, c.realQuoteReserves(), "curve bakiyesi defterinden ayristi");
            }
        }
    }

    // ---------------------------------------------------------------
    // 3. Sabit carpim
    // ---------------------------------------------------------------

    function invariant_constantProductNeverDecreases() public view {
        for (uint256 i = 0; i < N_CURVES; i++) {
            assertGe(
                curves[i].virtualQuoteReserves() * curves[i].virtualTokenReserves(),
                virtualQuote * T,
                "sabit carpim kucaldi"
            );
        }
    }

    // ---------------------------------------------------------------
    // 4. `complete` ve `graduated` geri alinamaz
    // ---------------------------------------------------------------

    /// @dev DORT SATIR, DORDU DE AYRI: olay tarafi (`Completed`/`Graduated`
    ///      IKI KEZ yayildi mi -- ic ice cerceveler dahil), durum tarafi
    ///      (bayrak geri alindi mi), ve iki esdegerlik yonu.
    function invariant_completeAndGraduatedAreIrreversible() public view {
        assertEq(handler.completedTwice(), 0, "ayni curve iki kez tamamlandi");
        assertEq(handler.graduatedTwice(), 0, "ayni curve IKI KEZ mezun oldu");

        for (uint256 i = 0; i < N_CURVES; i++) {
            BondingCurve c = curves[i];
            if (handler.sawCompleted(i)) assertTrue(c.complete(), "complete geri alindi");
            if (handler.sawGraduated(i)) assertTrue(c.graduated(), "graduated geri alindi");
            assertTrue(!c.graduated() || c.complete(), "graduated ama complete degil");
            assertTrue(c.realTokenReserves() != 0 || c.complete(), "rezerv sifir ama complete degil");
        }
    }

    // ---------------------------------------------------------------
    // 5. Tamamlanmadan/mezuniyetten sonra islem yok
    // ---------------------------------------------------------------

    /// @notice OLAY TABANLI, durum tabanli DEGIL -- ve fark tam olarak bu
    ///         kampanyanin var olma sebebidir.
    /// @dev Ic ice bir cerceveden yapilan tamamlanma-sonrasi islem, dis cagri
    ///      basariyla dondugunde HICBIR durum farkinda gorunmez: dis cagrinin
    ///      oncesi/sonrasi karsilastirmasi iki islemin toplamini gosterir ve
    ///      "yasak olan hangisiydi" sorusuna cevap veremez. `Trade` olaylarinin
    ///      SIRASI verir: bir curve `Completed` yaydiktan sonra ayni curve icin
    ///      yayilan her `Trade` bir ihlaldir.
    function invariant_noTradeAfterCompletionOrGraduation() public view {
        assertEq(handler.tradeAfterCompletion(), 0, "tamamlanmis curve'de islem yayildi");
        assertEq(handler.tradeAfterGraduation(), 0, "mezun curve'de islem yayildi");
    }

    // ---------------------------------------------------------------
    // 6. Tamamlanma toz birakmaz
    // ---------------------------------------------------------------

    function invariant_completionLeavesNoDust() public view {
        for (uint256 i = 0; i < N_CURVES; i++) {
            BondingCurve c = curves[i];
            if (!c.complete()) continue;
            assertEq(c.realTokenReserves(), 0, "TOZ");
            assertEq(c.virtualTokenReserves(), T - S, "sanal token rezervi T-S degil");
        }
    }

    // ---------------------------------------------------------------
    // 7. Ucret IKI TAVANDAN toplanir, bir toplamdan BOLUNMEZ
    // ---------------------------------------------------------------

    /// @dev BES SATIR. Ilk ucu olay basina; dorduncusu ucretin UCUNCU bir
    ///      aliciya sizmasini; besincisi ise curve basina KIMLIK kurar --
    ///      `Trade` olaylarinda ILAN EDILEN ucret ile escrow'a FIILEN yatan
    ///      ucret esit olmak zorundadir. Bes farkli mutant.
    function invariant_feesAreSummedFromPartsAndFullyDeposited() public view {
        assertEq(handler.feePartsInconsistent(), 0, "ucret cifti hicbir anapara ile aciklanamiyor");
        assertEq(handler.creatorPartWrong(), 0, "creator sifirken creator payi alindi");
        assertEq(handler.feeWasDividedFromTotal(), 0, "ucret toplamdan bolundu");
        assertEq(handler.feeWentToUnknownRecipient(), 0, "ucret ucuncu bir aliciya yatti");

        for (uint256 i = 0; i < N_CURVES; i++) {
            assertEq(handler.feesFromTrades(i), handler.feesDeposited(i), "ilan edilen ucret yatirilanla ayristi");
        }
    }

    // ---------------------------------------------------------------
    // 8. KORUNUM -- her wei ve her token
    // ---------------------------------------------------------------

    /// @notice Dort kontratin BIRLIKTE tuttugu native, kampanyaya fonlanan
    ///         native'e esittir.
    /// @dev BU IDDIA TEK BIR KONTRATTA IFADE EDILEMEZ ve ic ice cerceveler
    ///      altinda da bozulamaz: iki yarisi ayri kontratlarda olan bir sizinti
    ///      -- ornegin curve'un iki kez odedigi ama escrow'un bir kez
    ///      kaydettigi bir wei -- ancak burada gorunur.
    function invariant_nativeIsConserved() public view {
        assertEq(_perimeterNative(), totalNativeFunded, "native cemberden sizdi ya da uretildi");
    }

    /// @notice Her token'in TUM arzi cemberin icindedir.
    /// @dev Ikinci satir curve'un defterini ERC-20 bakiyesiyle esler ve
    ///      graduation'dan sonra `D` kadar kayar -- yani mezuniyet TOKEN
    ///      tarafinda da tam olarak `poolSeedSupply` kadar hareket ettirir.
    function invariant_tokenSupplyIsAccountedFor() public view {
        for (uint256 i = 0; i < N_CURVES; i++) {
            uint256 held;
            for (uint256 k = 0; k < perimeter.length; k++) {
                held += tokens[i].balanceOf(perimeter[k]);
            }
            assertEq(held, LAUNCH_TOKEN_TOTAL_SUPPLY, "token arzi cemberden sizdi");

            BondingCurve c = curves[i];
            uint256 expectedResidue =
                c.graduated() ? LAUNCH_TOKEN_TOTAL_SUPPLY - S - c.poolSeedSupply() : LAUNCH_TOKEN_TOTAL_SUPPLY - S;
            assertEq(tokens[i].balanceOf(address(c)) - c.realTokenReserves(), expectedResidue, "artik yanlis");
        }
    }

    // ---------------------------------------------------------------
    // 9. Graduation TAM OLARAK `(D, R)` oder
    // ---------------------------------------------------------------

    function invariant_graduationPaidExactlyDAndR() public view {
        assertEq(handler.graduationBaseWrong(), 0, "graduation baz bacagi poolSeedSupply degil");
        for (uint256 i = 0; i < N_CURVES; i++) {
            if (!handler.sawGraduated(i)) continue;
            assertEq(handler.graduationQuotePaid(i), curves[i].realQuoteReserves(), "graduation quote bacagi R degil");
        }
    }

    // ---------------------------------------------------------------
    // 10. Saldirgan HIC BAYAT DEFTER GORMEDI
    // ---------------------------------------------------------------

    /// @notice Aktor kontrolu her aldiginda her curve icin
    ///         `bakiye >= realQuoteReserves` tutuyordu.
    /// @dev ISLEMIN ICINDEN olculur. Yukaridaki butun iddialar handler
    ///      cagrilari ARASINDA calisir ve ara durumlari hic gormez; bu sayac
    ///      tam olarak o kor noktadadir.
    function invariant_reentrantFramesNeverSawAnInsolventCurve() public view {
        assertEq(reentryLog.staleLedgerObserved(), 0, "yeniden giris aninda curve defterini karsilamiyordu");
    }

    // ---------------------------------------------------------------
    // 11. Kullanilabilirlik -- GIRIS NOKTASI BASINA
    // ---------------------------------------------------------------

    /// @dev YUKARIDAKI ON IDDIANIN HEPSI GUVENLIK IDDIASIDIR VE HICBIR SEY
    ///      YAPMAYAN BIR KONTRAT HEPSINI SAGLAR. Bu depoda olculmus mekanizma:
    ///      `fail_on_revert = false` revert eden handler cagrisini yutar ve
    ///      ayni revert ghost artirimini da geri alir. Care `try/catch` + sifir
    ///      iddia edilen bir sayactir ve YEDI GIRIS NOKTASININ HEPSINE ayri
    ///      ayri uygulanir.
    function invariant_everyEntrypointStaysAvailable() public view {
        assertEq(handler.buyExactOutReverted(), 0, "buyExactOut");
        assertEq(handler.buyQuoteInReverted(), 0, "buyQuoteIn");
        assertEq(handler.sellReverted(), 0, "sell");
        assertEq(handler.buyRemainingReverted(), 0, "buyRemaining");
        assertEq(handler.buyOverBudgetReverted(), 0, "buyOverBudget");
        assertEq(handler.graduateReverted(), 0, "graduate");
        assertEq(handler.claimReverted(), 0, "claim");
    }

    // ---------------------------------------------------------------
    // KAPSAM TABANLARI
    // ---------------------------------------------------------------

    /// @notice Foundry bunu her invariant KOSUSUNUN sonunda cagirir. Buradaki
    ///         iddialar guvenlik degil KAPSAM iddialaridir.
    ///
    /// @dev BURAYA YALNIZCA YAPISAL OLARAK GARANTI SAYACLAR GIRER, ve bu kural
    ///      `BondingCurveInvariants.t.sol` icinde OLCULEREK bulunmustu. BU
    ///      DOSYA ONU BIR KEZ DAHA OLCEREK OGRENDI, ve kayit burasidir: ilk
    ///      hali buraya dort taban koyuyordu (kodlu/kodsuz aktor,
    ///      silahli/silahsiz cagri) ve `ReentrancyInvariantsTestnetProfileTest`
    ///      altinda DUSTU --
    ///        `[FAIL: kodsuz aktor hic secilmedi: 0 <= 0]`
    ///      -- yani 256 kosunun en az birinde 64 cagrinin HICBIRI kodsuz
    ///      aktoru secmemisti. Mekanizma: yedi eylemden IKISI (`claim`,
    ///      `graduate`) aktor secmez, dolayisiyla secim yapan cagri sayisi
    ///      ~46'ya duser ve `(3/4)^46` bir kosuda ihmal edilebilir olsa da
    ///      12 invariant x 256 kosu x 3 konfigurasyon = ~9200 kosuda DEGILDIR.
    ///      O dort taban artik `test_everyActorClassAndDepthClassIsExercised`
    ///      icinde DETERMINISTIK olarak iddia ediliyor.
    ///
    /// @dev GERIYE KALAN IKI TABAN. Ilki dizinin BOS gecmedigini soyler;
    ///      ikincisi bu kampanyanin VAROLMA SEBEBIDIR: yeniden giris noktalari
    ///      saldirgan koda kontrolu FIILEN verdi mi. Ikincisi olmadan, aktoru
    ///      sessizce silahsizlandiran bir refactor BUTUN kosulari yesil
    ///      birakirdi -- `production-hardening.md`in "erisim kanaryasi"
    ///      tekniginin buradaki karsiligi tam olarak bu satirdir.
    ///      Yapisalligi: her basarili islem bir aktore ait `receive()`i
    ///      calistirir (alim iadesi ya da satis odemesi), her graduation
    ///      odemesi `actorAt[0]`a gider ve her `claim` bes aliciyi dordu KODLU
    ///      olan bir kumeden secer -- yani `entered` toplaminin sifir kalmasi
    ///      icin dizinin islem, mezuniyet ve claim yollarinin UCUNDEN DE
    ///      kacinmasi gerekir.
    function afterInvariant() public view {
        assertGt(handler.tradesObserved(), 0, "dizide hic islem olmadi");
        assertGt(_totalEntered(), 0, "hicbir yeniden giris noktasi saldirgan koda kontrol vermedi");

        // ERISIM VEKTORU, CEVRE DEGISKENIYLE ACILIR. Varsayilan olarak
        // SESSIZDIR (256 kosu 256 blok log uretirdi), ama olcum
        // COMMIT EDILMIS AGACTAN YENIDEN URETILEBILIR olmali:
        //   ARCPAD_REACH_LOG=1 FOUNDRY_INVARIANT_RUNS=1 forge test ...
        // Rapordaki erisim tablosunun tam olarak bu yolla alindigi, ve
        // sayilarin BIR KOSUNUN (64 cagri) sayilari oldugu boylece
        // dogrulanabilir.
        if (vm.envOr("ARCPAD_REACH_LOG", false)) _logReach();
    }

    function _totalEntered() internal view returns (uint256 total) {
        for (uint8 p = 1; p < 8; p++) {
            total += reentryLog.entered(p);
        }
    }

    // ---------------------------------------------------------------
    // ERISIM KANARYASI -- yedi noktanin YEDISI de yurunuyor mu
    // ---------------------------------------------------------------

    /// @notice YEDI yeniden giris noktasinin HER BIRINE fiilen ulasildigini,
    ///         her birinden fiilen bir ic cagri yapildigini SAYIYLA gosterir.
    ///
    /// @dev BU TESTIN VAROLMA SEBEBI. Yukaridaki on bir invariant, saldiri
    ///      yolu HIC YURUNMESE DE yesildir -- bir yeniden giris kampanyasinin
    ///      bos yere yesil olmasinin TEK sekli budur ve bu deponun dorduncu
    ///      adi konmus hata sinifi tam olarak odur ("erisimi olculmeyip
    ///      VARSAYILAN bir ozellik testi"). `production-hardening.md`in alti
    ///      "erisim kanaryasi"nin buradaki karsiligi bu testtir: orada bir
    ///      durumun ULASILMADIGI iddia edilip DUSMESI kanit sayiliyordu;
    ///      Foundry'de `afterInvariant` disinda ayni numaraya gerek yok, cunku
    ///      dizi burada DETERMINISTIKTIR ve taban dogrudan iddia edilebilir.
    ///
    /// @dev IKI SAYAC AYRIDIR VE AYRILMALIDIR: `entered` "nokta kontrolu
    ///      saldirgan koda VERDI" demektir, `attempted` ise "saldirgan
    ///      oradan GERI CAGIRDI". Ilki ikincisi olmadan da artabilir
    ///      (`depth == 0` kontrol grubu), yani ikisi bagimsiz olcumlerdir ve
    ///      yalnizca birine bakan bir kanarya otekini varsayardi.
    function test_everySevenReentryPointsAreActuallyReached() public {
        // --- P2 / P4: iade ve satis odemesi, KANONIK curve'de ---
        handler.buyExactOut(0, 0, S / 64, 12345, 2);
        assertGt(reentryLog.entered(P_BUY_REFUND), 0, "P2 alim iadesi hic calismadi");
        assertGt(reentryLog.attempted(P_BUY_REFUND), 0, "P2'den hic geri cagrilmadi");

        handler.sell(0, 0, type(uint256).max, 999, 2);
        assertGt(reentryLog.entered(P_SELL_PAYOUT), 0, "P4 satis odemesi hic calismadi");
        assertGt(reentryLog.attempted(P_SELL_PAYOUT), 0, "P4'ten hic geri cagrilmadi");

        // --- P1 / P3: token bacaklari, DUSMAN token'a bagli curve'de ---
        handler.buyExactOut(1, HOSTILE, S / 64, 4242, 2);
        assertGt(reentryLog.entered(P_BUY_TOKEN_TRANSFER), 0, "P1 alimin token transferi hic kanca atmadi");
        assertGt(reentryLog.attempted(P_BUY_TOKEN_TRANSFER), 0, "P1'den hic geri cagrilmadi");

        handler.sell(1, HOSTILE, type(uint256).max, 7, 2);
        assertGt(reentryLog.entered(P_SELL_TOKEN_TRANSFER_FROM), 0, "P3 satisin transferFrom'u hic kanca atmadi");
        assertGt(reentryLog.attempted(P_SELL_TOKEN_TRANSFER_FROM), 0, "P3'ten hic geri cagrilmadi");

        // --- P7: escrow claim. Yukaridaki islemler treasury'ye (actor1) ve
        //     creator'lara ucret yatirdi. ---
        assertGt(escrow.owed(address(actor1)), 0, "treasury'de alacak yok");
        handler.claim(0, 31337, 2);
        assertGt(reentryLog.entered(P_ESCROW_CLAIM), 0, "P7 claim transferi hic calismadi");
        assertGt(reentryLog.attempted(P_ESCROW_CLAIM), 0, "P7'den hic geri cagrilmadi");

        // --- P5 / P6: graduation'in iki bacagi, DUSMAN token'li curve'de ---
        handler.buyRemaining(0, HOSTILE, 1, 5, 0);
        assertTrue(curves[HOSTILE].complete(), "dusman curve tamamlanmadi");
        handler.graduate(HOSTILE, 8888, 2);
        assertTrue(curves[HOSTILE].graduated(), "dusman curve mezun olmadi");
        assertGt(reentryLog.entered(P_GRADUATION_TOKEN_TRANSFER), 0, "P5 graduation token transferi kanca atmadi");
        assertGt(reentryLog.attempted(P_GRADUATION_TOKEN_TRANSFER), 0, "P5'ten hic geri cagrilmadi");
        assertGt(reentryLog.entered(P_GRADUATION_PAYOUT), 0, "P6 graduation odemesi hic calismadi");
        assertGt(reentryLog.attempted(P_GRADUATION_PAYOUT), 0, "P6'dan hic geri cagrilmadi");

        // Ve bu deterministik dizi butun guvenlik iddialarini AYAKTA birakir.
        _assertAllProperties();

        console.log("--- ERISIM (deterministik dizi) ---");
        _logReach();
    }

    /// @notice KONTROL GRUBU. `depth == 0` ile aktor kodlu bir alici olarak
    ///         kalir: `receive()` calisir (`entered` artar) ama HICBIR ic cagri
    ///         yapilmaz.
    /// @dev BU TEST OLMADAN yukaridaki kanaryanin sayaclari kendi kendini
    ///      dogrulayan olabilirdi -- `attempted`in `entered`den BAGIMSIZ
    ///      artabildigi ancak burada gosterilir. Ayni zamanda `armed`/`depth`
    ///      mekanizmasinin gercekten bir anahtar oldugunu kanitlar: silah
    ///      kapaliyken saldiri olmuyorsa, acikken olan sey GERCEKTEN
    ///      saldiridir.
    function test_controlGroupEntersButNeverReenters() public {
        handler.buyExactOut(0, 0, S / 64, 12345, 0);
        assertGt(reentryLog.entered(P_BUY_REFUND), 0, "kontrol grubunda `receive()` hic calismadi");
        assertEq(reentryLog.attempted(P_BUY_REFUND), 0, "silahsiz aktor geri cagirdi");

        handler.sell(0, 0, type(uint256).max, 999, 0);
        assertGt(reentryLog.entered(P_SELL_PAYOUT), 0, "kontrol grubunda satis odemesi hic calismadi");
        assertEq(reentryLog.attempted(P_SELL_PAYOUT), 0, "silahsiz aktor geri cagirdi");

        _assertAllProperties();
    }

    /// @notice DORT AKTOR SINIFININ ve IKI DERINLIK SINIFININ hepsi yurunur.
    ///
    /// @dev NICIN BURADA, `afterInvariant()`ta DEGIL: oraya konmus hali
    ///      OLCULEREK dustu (bkz. `afterInvariant`in notu). Rastgele dizide
    ///      garanti olmayan her sey bu depoda deterministik `test_`
    ///      fonksiyonlarinda iddia edilir.
    /// @dev DORT AKTOR SINIFI: uc KODLU aktor ve bir KODSUZ EOA. Kodsuz aktor
    ///      kontrol grubudur -- `.call{value:...}("")` kodsuz bir alicida her
    ///      zaman trivial basarili doner ve hicbir sey calistirmaz, yani o
    ///      aktorle yurunen dizilerde CEI'nin ters cevrilmesi GOZLENEMEZ.
    ///      Ikisinin de yurundugunu gostermek, paketin yalnizca saldiri
    ///      altinda degil olagan kullanim altinda da ayakta oldugunu soyler.
    function test_everyActorClassAndDepthClassIsExercised() public {
        for (uint256 who = 0; who < 4; who++) {
            handler.buyExactOut(who, who, S / 512, 11 + who, 2);
        }
        assertGt(handler.codedActorCalls(), 0, "kodlu aktor hic secilmedi");
        assertGt(handler.codelessActorCalls(), 0, "kodsuz aktor hic secilmedi");

        uint256 armedBefore = handler.armedCalls();
        uint256 disarmedBefore = handler.disarmedCalls();
        handler.buyExactOut(0, 0, S / 512, 3, 2);
        assertEq(handler.armedCalls(), armedBefore + 1, "silahli sinif yurunmedi");
        handler.buyExactOut(0, 0, S / 512, 3, 0);
        assertEq(handler.disarmedCalls(), disarmedBefore + 1, "silahsiz sinif yurunmedi");

        _assertAllProperties();
    }

    /// @notice CAPRAZ CURVE penceresi: bir curve'un odemesi icinden BASKA bir
    ///         curve'de islem yapilir.
    /// @dev `graduate()`in NatSpec'i bu pencereyi (a) "ULASILABILIR" diye
    ///      kaydediyor. Burada olculuyor: dis cagri curve 0'da, ic cagri
    ///      curve 1/2/3'te.
    function test_crossCurveReentryActuallyHappens() public {
        uint256 before1 = curves[1].realQuoteReserves();
        uint256 before2 = curves[2].realQuoteReserves();
        uint256 before3 = curves[3].realQuoteReserves();

        bool moved;
        for (uint256 k = 0; k < 24 && !moved; k++) {
            handler.buyExactOut(0, 0, S / 256, k * 7919 + 1, 3);
            moved = curves[1].realQuoteReserves() != before1 || curves[2].realQuoteReserves() != before2
                || curves[3].realQuoteReserves() != before3;
        }
        assertTrue(moved, "capraz curve penceresi hic yurunmedi");
        _assertAllProperties();
    }

    function _assertAllProperties() internal view {
        invariant_escrowIsSolventAndItsLedgerAdds();
        invariant_everyCurveCoversItsOwnLedger();
        invariant_constantProductNeverDecreases();
        invariant_completeAndGraduatedAreIrreversible();
        invariant_noTradeAfterCompletionOrGraduation();
        invariant_completionLeavesNoDust();
        invariant_feesAreSummedFromPartsAndFullyDeposited();
        invariant_nativeIsConserved();
        invariant_tokenSupplyIsAccountedFor();
        invariant_graduationPaidExactlyDAndR();
        invariant_reentrantFramesNeverSawAnInsolventCurve();
        invariant_everyEntrypointStaysAvailable();
    }

    function _logReach() internal view {
        console.log("P1 buy token transfer   entered/attempted/succeeded");
        console.log(
            reentryLog.entered(P_BUY_TOKEN_TRANSFER),
            reentryLog.attempted(P_BUY_TOKEN_TRANSFER),
            reentryLog.succeeded(P_BUY_TOKEN_TRANSFER)
        );
        console.log("P2 buy refund");
        console.log(
            reentryLog.entered(P_BUY_REFUND), reentryLog.attempted(P_BUY_REFUND), reentryLog.succeeded(P_BUY_REFUND)
        );
        console.log("P3 sell transferFrom");
        console.log(
            reentryLog.entered(P_SELL_TOKEN_TRANSFER_FROM),
            reentryLog.attempted(P_SELL_TOKEN_TRANSFER_FROM),
            reentryLog.succeeded(P_SELL_TOKEN_TRANSFER_FROM)
        );
        console.log("P4 sell payout");
        console.log(
            reentryLog.entered(P_SELL_PAYOUT), reentryLog.attempted(P_SELL_PAYOUT), reentryLog.succeeded(P_SELL_PAYOUT)
        );
        console.log("P5 graduation token transfer");
        console.log(
            reentryLog.entered(P_GRADUATION_TOKEN_TRANSFER),
            reentryLog.attempted(P_GRADUATION_TOKEN_TRANSFER),
            reentryLog.succeeded(P_GRADUATION_TOKEN_TRANSFER)
        );
        console.log("P6 graduation payout");
        console.log(
            reentryLog.entered(P_GRADUATION_PAYOUT),
            reentryLog.attempted(P_GRADUATION_PAYOUT),
            reentryLog.succeeded(P_GRADUATION_PAYOUT)
        );
        console.log("P7 escrow claim");
        console.log(
            reentryLog.entered(P_ESCROW_CLAIM),
            reentryLog.attempted(P_ESCROW_CLAIM),
            reentryLog.succeeded(P_ESCROW_CLAIM)
        );
        console.log("maxDepthReached, launchesFromCallback");
        console.log(reentryLog.maxDepthReached(), reentryLog.launchesFromCallback());
        console.log("trades, completions, graduations");
        console.log(handler.tradesObserved(), handler.completionsObserved(), handler.graduationsObserved());
        console.log("deposits, claims, clamps");
        console.log(handler.depositsObserved(), handler.claimsObserved(), handler.clampsObserved());
        console.log("coded, codeless, armed, disarmed");
        console.log(handler.codedActorCalls(), handler.codelessActorCalls());
        console.log(handler.armedCalls(), handler.disarmedCalls());
        console.log("maxFeePrincipalGap");
        console.log(handler.maxFeePrincipalGap());
    }

    // ---------------------------------------------------------------
    // Yardimcilar
    // ---------------------------------------------------------------

    function _allSelectors() internal pure returns (bytes4[] memory sel) {
        sel = new bytes4[](7);
        sel[0] = ReentrancyHandler.buyExactOut.selector;
        sel[1] = ReentrancyHandler.buyQuoteIn.selector;
        sel[2] = ReentrancyHandler.sell.selector;
        sel[3] = ReentrancyHandler.buyRemaining.selector;
        sel[4] = ReentrancyHandler.buyOverBudget.selector;
        sel[5] = ReentrancyHandler.graduate.selector;
        sel[6] = ReentrancyHandler.claim.selector;
    }
}

/// @notice URETIM profili, KAPATICILAR VE GRADUATION KAPALI.
///
/// @dev NICIN AYRI BIR KONFIGURASYON -- ve gerekce TAHMIN DEGIL OLCUM. Yedi
///      eylemin hepsi acikken 64 cagrilik bir dizide DORT curve'un DORDU DE
///      ilk on cagri icinde tamamlanip mezun oluyor (olculdu: 64 cagrida
///      `tradesObserved = 8`, `completionsObserved = 4`,
///      `graduationsObserved = 4`), ve dizinin geri kalani tamamen olu
///      geciyor -- SATIS yolu hic yurunmuyor, dolayisiyla P3 ve P4 O KOSUDA
///      SIFIR kaliyor. Yani "yedi noktanin hepsi taraniyor" iddiasi tek bir
///      konfigurasyonda YANLIS olurdu. Burada kapaticilar ve `graduate`
///      kapali: curve tamamlanmadan once derin alim/satim dizileri yurur ve
///      P1-P4 ile P7 tam boyda taranir.
contract ReentrancyInvariantsTradingTest is ReentrancyInvariantsBase {
    function _virtualQuote() internal pure override returns (uint256) {
        return V_PRODUCTION;
    }

    function _selectors() internal pure override returns (bytes4[] memory sel) {
        sel = new bytes4[](4);
        sel[0] = ReentrancyHandler.buyExactOut.selector;
        sel[1] = ReentrancyHandler.buyQuoteIn.selector;
        sel[2] = ReentrancyHandler.sell.selector;
        sel[3] = ReentrancyHandler.claim.selector;
    }
}

/// @notice URETIM profili, YEDI eylem de acik. Tamamlanma ve graduation
///         yurunur, yani P5 ve P6 burada taranir.
contract ReentrancyInvariantsLifecycleTest is ReentrancyInvariantsBase {
    function _virtualQuote() internal pure override returns (uint256) {
        return V_PRODUCTION;
    }

    function _selectors() internal pure override returns (bytes4[] memory) {
        return _allSelectors();
    }
}

/// @notice TESTNET profili, yedi eylem de acik.
/// @dev `R` bin kat kucuktur. Ayni cagri sayisiyla curve'un cok daha buyuk bir
///      kesri yurunur, yani tamamlanma-sonrasi ve mezuniyet-sonrasi hucreler
///      burada en yogun taranir. Ayrica `V`'nin buyuklugu ucret yuvarlamasinin
///      ISABET ETTIGI araligi kaydirir: uretim profilinde tavan yuvarlamasinin
///      goreli etkisi kaybolur, testnet profilinde gorunur kalir.
contract ReentrancyInvariantsTestnetProfileTest is ReentrancyInvariantsBase {
    function _virtualQuote() internal pure override returns (uint256) {
        return V_TESTNET;
    }

    function _selectors() internal pure override returns (bytes4[] memory) {
        return _allSelectors();
    }
}

/// @notice Handler'in olay denetiminin dayandigi FOUNDRY SEMANTIGINI pinler.
///
/// @dev `ReentrancyHandler._audit` "yayildi" ile "islendi"yi ayirmak zorunda
///      ve ayrimin hangi tarafta oldugu forge'un davranisina baglidir. Bu test
///      onu OLCER: revert eden bir alt cagrida yayilan olay `getRecordedLogs()`
///      icinde GORUNUYOR mu. Bugun goruyor (iki olay bekleniyor, ikisi de
///      geliyor) ve handler'in NatSpec'i bunun uzerine kuruluyor. Bir forge
///      surumu bunu degistirirse, sessizce zayiflamis bir denetim yerine
///      KIRMIZI bir test gorulur.
contract RecordedLogSemanticsPinTest is Test {
    event Ping(uint256 n);

    function emitThenRevert() external {
        emit Ping(1);
        revert("boom");
    }

    function callAndSwallow() external {
        (bool ok,) = address(this).call(abi.encodeWithSelector(this.emitThenRevert.selector));
        ok;
    }

    function test_recordedLogsSurviveARevertedFrame() public {
        vm.recordLogs();
        this.callAndSwallow();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 pings;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == Ping.selector) pings++;
        }
        assertEq(pings, 1, "revert eden cerceveden yayilan olay kayitta gorunmuyor");
    }
}
