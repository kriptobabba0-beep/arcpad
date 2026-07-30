// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";

/// @title CurveTradingHandler
/// @notice Bir launch'in TUM ticaret hayatini rastgele dizilerle suren aktor.
///
/// @dev HANDLER ICINDE ASSERTION CAGRILMAZ. forge-std'nin assertion'lari
///      revert eder ve `fail_on_revert = false` fuzzed hedef fonksiyona
///      yapilan cagridaki HER revert'i sessizce iskartaya cikarir -- yani
///      assertion hic calismamis gibi olur (Faz 1b'de olculdu: kasten ters
///      cevrilmis bir `assertLe` testi PASS birakti, yalnizca "Reverts"
///      sayaci artti). Burada yalnizca sayac artirilir; gercek `assertEq(...,
///      0)` kontrolu `BondingCurveInvariants.t.sol` icindeki `invariant_`
///      fonksiyonlarinda yapilir -- onlar fuzzed hedef cagrisi DEGILDIR ve
///      `fail_on_revert`'ten bagimsiz olarak testi kirmizi yapar.
///
/// @dev AKTOR KUMESI HEM KODLU HEM KODSUZ ADRES ICERIR VE BU YAPISALDIR.
///      Faz 1b'nin escrow handler'inin uc alicisinin da kodsuz olmasi, paketi
///      korumak icin yazildigi reentrancy penceresine YAPISAL OLARAK KOR
///      birakti: kodsuz bir adrese yapilan `.call{value:...}("")` her zaman
///      trivial olarak basarili doner ve hicbir sey calistirmaz, yani
///      CEI'nin ters cevrilmesi GOZLENEMEZ. Burada `actors[3]` gercek bir
///      kontrattir ve silahlandirildiginda `receive()` icinden curve'e GERI
///      GIRER.
///
/// @dev HER GIRIS NOKTASI ICIN AYRI BIR KULLANILABILIRLIK SAYACI VAR.
///      Gerekcesi olculdu: `fail_on_revert = false` revert eden bir handler
///      cagrisini yutar, ve ayni revert ghost artirimini da geri alir --
///      boylece kontrat durumu ile ghost durumu TAM OLARAK islem basarisiz
///      oldugu ICIN tutarli kalir. HICBIR SEY YAPMAYAN bir kontrat butun
///      guvenlik invariant'larini saglar. Care `try/catch` + sifir iddia
///      edilen bir sayactir ve BURADA HEPSINE uygulanir, birine degil.
///
/// @dev TAMAMLANMA SONRASI HER GIRIS NOKTASI KENDI ISLEMINI DENER.
///      "Bir ozelligin bir giris noktasinda kapatilmasi hepsinde kapatilmis
///      gibi okunur" bu depoda dokuz kez olusmus bir hatadir. Tamamlanmadan
///      sonra alim yollari ZATEN baska bir korumaya carpar
///      (`realTokenReserves == 0` -> `NotEnoughTokensToBuy` / kismadan sonra
///      `CurveMath.ZeroAmount`), yani `complete` korumasini oralardan silmek
///      DAVRANISI degistirmez -- yalnizca REVERT VERISINI degistirir. Bu
///      yuzden tamamlanma sonrasi denemede yalnizca "revert etti mi" degil,
///      `CurveComplete()` selector'u ile mi revert etti de olculur
///      (`postCompletionRevertHadWrongSelector`). Satis yolunda ise koruma
///      DAVRANISSAL olarak canlidir: tamamlanmis bir curve'e satis
///      yapilabilseydi `realTokenReserves` tekrar sifirdan buyuk olur ve
///      graduation'in bekledigi quote curve'den cikardi.
///
/// @dev BEKLENEN DEGERLER CAGRIDAN ONCE HESAPLANIR, SONRADAN TURETILMEZ.
///      Ilk hali ucret parcalarini cagri SONRASI rezerv farkindan yeniden
///      hesapliyordu ve YANLISTI: `correctedNetQuoteIn` ucreti DUZELTME
///      ONCESI net uzerinden alir, donen `net` ise duzeltilmis olandir --
///      yani donen net'ten yeniden hesaplamak tam olarak `CurveMath`'in
///      NatSpec'inde "cagiranin yapmamasi gereken sey" diye yazili
///      hesaplamadir. Olculdu: paket bunu 256 kosuda yakaladi. Simdi handler
///      giris noktasinin ALGORITMASINI aynen yansitir ve sonucu gozlenen
///      delta ile karsilastirir.
///
/// @dev AYNA NEYI KAPSAR, NEYI KAPSAMAZ. Beklenti `CurveMath`'in KENDISIYLE
///      kurulur, dolayisiyla `CurveMath` icindeki bir mutasyon iki tarafi
///      birden kaydirir ve BU PAKET ONU GORMEZ -- Faz 1c Task 1'de olculdu
///      (dort `CurveMath` mutasyonunun dordu de invariant paketini yesil
///      birakti). Kutuphane katmani `CurveMath.t.sol`, `CurveMathFuzz.t.sol`
///      ve `CurveMathInvariants.t.sol` tarafindan korunur. Buradaki paketin
///      korudugu sey `BondingCurve`'un BESTELEMESIDIR: hangi kutuphane
///      fonksiyonu, hangi argumanla, hangi sirayla cagriliyor; donen parcalar
///      kullaniliyor mu yoksa yeniden mi hesaplaniyor; kisma duruyor mu.
contract CurveTradingHandler is CommonBase, StdUtils {
    // ---------------------------------------------------------------
    // Sistem
    // ---------------------------------------------------------------

    BondingCurve public immutable curve;
    IERC20 public immutable token;
    FeeEscrow public immutable escrow;
    address public immutable protocolTreasury;

    /// @notice SIFIR OLABILIR. Sifirsa creator payi hic alinmamalidir --
    ///         protokol payina KATLANMAMALIDIR.
    address public immutable creator;

    /// @notice Tek cagri basina azami butce. Profile gore olceklenir
    ///         (`V / 4`), boylece testnet ve uretim profilleri ayni sayida
    ///         cagriyla curve'un ayni kesrini yurur.
    uint256 public immutable maxQuotePerCall;

    /// @notice 0..2 KODSUZ (EOA), 3 KODLU (`ReentrantTrader`).
    address[4] public actors;
    ReentrantTrader public immutable reentrantTrader;

    uint256 internal constant PROTOCOL_FEE_BPS = 95;
    uint256 internal constant CREATOR_FEE_BPS = 30;
    /// @dev YALNIZCA OLCUM ICIN. Kontratta boyle bir sabit YOKTUR ve
    ///      olmamalidir; burada sadece "toplamdan bolme"nin ne uretecegini
    ///      hesaplayip o sonuca DUSULUP DUSULMEDIGINI gormek icin duruyor.
    uint256 internal constant COMBINED_FEE_BPS_FOR_MEASUREMENT_ONLY = 125;

    // ---------------------------------------------------------------
    // Ghost muhasebe -- curve'un KENDI defterinden BAGIMSIZ olculur
    // ---------------------------------------------------------------

    /// @dev Kaynaklar bilerek defter DISINDADIR: quote tarafi curve'un NATIVE
    ///      BAKIYESINDEN, token tarafi AKTORLERIN token bakiyesinden okunur.
    ///      Defterden okunsalardi kimlik `x == x`'e indirgenir ve kontrat ne
    ///      yazarsa yazsin gecerdi (bu depoda bir kez olustu; bkz.
    ///      CurveMathInvariants.t.sol tautoloji notu).
    uint256 public ghostQuoteIn;
    uint256 public ghostQuoteOut;
    uint256 public ghostTokensOut;
    uint256 public ghostTokensIn;

    /// @notice Bir kez `complete` gorulduyse true. Geri alinamazligin tanigi.
    bool public ghostSawComplete;

    // ---------------------------------------------------------------
    // Ghost ihlal sayaclari -- hepsi `invariant_` icinde ==0
    // ---------------------------------------------------------------

    uint256 public tradeSucceededAfterCompletion;
    uint256 public postCompletionRevertHadWrongSelector;
    uint256 public completeWasUnset;

    /// @notice Yatirilan iki payin toplami `feeOn(x,95) + feeOn(x,30)`'a esit
    ///         degil.
    uint256 public feeNotSummedFromParts;
    /// @notice ...ve tam olarak `feeOn(x,125)`'e esit. Toplamdan bolmenin geri
    ///         sizmasini yakalayan sayac budur.
    uint256 public feeWasDividedFromTotal;
    /// @notice Protokol payi tek basina yanlis (katlama bunu dusurur).
    uint256 public protocolPartWrong;
    /// @notice Creator payi tek basina yanlis.
    uint256 public creatorPartWrong;
    /// @notice Escrow'un TOPLAM alacagi, iki adli alicinin aldigi paylarin
    ///         toplamindan farkli artti -- yani ucretin bir kismi UCUNCU bir
    ///         adrese yatti. Iki parcayi ayri ayri olcen sayaclar bunu
    ///         GOREMEZ; onlar yalnizca kendi alicilarina bakar.
    uint256 public feeWentToUnknownRecipient;

    /// @notice Curve'a giren/cikan anapara, giris noktasinin algoritmasinin
    ///         soyledigi degerden farkli.
    uint256 public curveInMismatch;
    /// @notice Aktorun aldigi/verdigi token miktari beklenenden farkli.
    uint256 public tokensMovedMismatch;

    uint256 public completionLeftDust;
    uint256 public completionLeftWrongVirtualReserves;

    // ---------------------------------------------------------------
    // Kullanilabilirlik sayaclari -- GIRIS NOKTASI BASINA, hepsi ==0
    // ---------------------------------------------------------------

    uint256 public buyExactTokensOutReverted;
    uint256 public buyExactQuoteInReverted;
    uint256 public sellReverted;
    uint256 public buyRemainingExactOutReverted;
    uint256 public buyOverBudgetQuoteInReverted;
    uint256 public reentrantBuyReverted;
    uint256 public reentrantSellReverted;

    /// @notice Teshis icin: yukaridaki sayaclardan biri arttiginda gorulen son
    ///         revert selector'u. Hicbir iddia buna bakmaz; bir
    ///         basarisizligin SEBEBINI okumak icin durur.
    bytes4 public lastUnexpectedRevert;
    bytes4 public lastPostCompletionSelector;

    // ---------------------------------------------------------------
    // Kapsam sayaclari -- SIFIR OLMASI GEREKMEZ, hucrelerin yurundugunu
    // olcerler. Bir invariant'in bos yere yesil olmadigini ancak bunlar
    // gosterir.
    // ---------------------------------------------------------------

    uint256 public completions;
    uint256 public clampsObserved;
    uint256 public callsWhileComplete;
    uint256 public tradesByCodedActor;
    uint256 public tradesByCodelessActor;
    uint256 public reentriesObserved;
    uint256 public buysMeasuredForFees;
    uint256 public sellsMeasuredForFees;

    constructor(BondingCurve curve_, address[3] memory eoas, uint256 maxQuotePerCall_) {
        curve = curve_;
        token = IERC20(curve_.token());
        escrow = FeeEscrow(curve_.escrow());
        protocolTreasury = curve_.protocolTreasury();
        creator = curve_.creator();
        maxQuotePerCall = maxQuotePerCall_;

        actors[0] = eoas[0];
        actors[1] = eoas[1];
        actors[2] = eoas[2];

        reentrantTrader = new ReentrantTrader(curve_, IERC20(curve_.token()));
        actors[3] = address(reentrantTrader);
    }

    receive() external payable {}

    // ---------------------------------------------------------------
    // Giris noktasi 1: tam token cikisi
    // ---------------------------------------------------------------

    function buyExactTokensOut(uint256 who, uint256 amount) external {
        address actor = _actor(who);

        if (curve.complete()) {
            _attemptAfterCompletion(actor, 0, amount);
            return;
        }

        uint256 reserve = curve.realTokenReserves();
        if (reserve == 0) return;
        uint256 tokensOut = _bound(amount, 1, reserve);

        Expected memory e = _expectedForExactOut(tokensOut);
        // FAZLADAN ODE. Iade yolu ancak boyle yurunur, ve iade `msg.sender`e
        // duz bir `.call` oldugu icin KODLU aktorde `receive()`i tetikleyen
        // sey de budur.
        uint256 value = e.curveIn + e.protocolFee + e.creatorFee + _bound(amount, 0, 1 ether);
        if (_payerBalance(actor) < value) return;

        Snapshot memory s = _snapshot(actor);
        (bool ok, bytes memory err) = _buyExactOut(actor, tokensOut, value, type(uint256).max);
        if (!ok) {
            buyExactTokensOutReverted++;
            lastUnexpectedRevert = _selectorOf(err);
            return;
        }
        _settleObservations(actor, s, true, e, tokensOut);
    }

    // ---------------------------------------------------------------
    // Giris noktasi 2: tam quote girisi
    // ---------------------------------------------------------------

    function buyExactQuoteIn(uint256 who, uint256 gross) external {
        address actor = _actor(who);

        if (curve.complete()) {
            _attemptAfterCompletion(actor, 1, gross);
            return;
        }
        if (curve.realTokenReserves() == 0) return;

        // Alt sinir 4: (95, 30) bps'te duzeltilmis net ISPATEN >= 2'dir ve
        // `quoteBuyTokensOut`'un `NetTooSmall` dali tetiklenmez (bkz.
        // CurveHandler.sol'daki ayni sinirin turetimi).
        uint256 value = _bound(gross, 4, maxQuotePerCall);
        if (_payerBalance(actor) < value) return;

        (Expected memory e, uint256 tokensOut, bool clamped) = _expectedForQuoteIn(value);
        if (clamped) clampsObserved++;

        Snapshot memory s = _snapshot(actor);
        (bool ok, bytes memory err) = _buyQuoteIn(actor, value, 0);
        if (!ok) {
            buyExactQuoteInReverted++;
            lastUnexpectedRevert = _selectorOf(err);
            return;
        }
        _settleObservations(actor, s, true, e, tokensOut);
    }

    // ---------------------------------------------------------------
    // Giris noktasi 3: satim
    // ---------------------------------------------------------------

    function sell(uint256 who, uint256 amount) external {
        address actor = _actor(who);

        if (curve.complete()) {
            _attemptAfterCompletion(actor, 2, amount);
            return;
        }

        uint256 bal = token.balanceOf(actor);
        if (bal == 0) return;
        uint256 tokensIn = _bound(amount, 1, bal);

        Expected memory e = _expectedForSell(tokensIn);
        // `ProceedsTooSmall` MESRU bir revert'tir (satici sifir alirdi), bu
        // yuzden kullanilabilirlik kusuru SAYILMAZ ve onceden elenir.
        if (e.curveIn <= e.protocolFee + e.creatorFee) return;

        Snapshot memory s = _snapshot(actor);
        (bool ok, bytes memory err) = _sell(actor, tokensIn, 0);
        if (!ok) {
            sellReverted++;
            lastUnexpectedRevert = _selectorOf(err);
            return;
        }
        _settleObservations(actor, s, false, e, tokensIn);
    }

    // ---------------------------------------------------------------
    // Giris noktasi 4: kalan rezervin TAMAMI, tam-cikis yoluyla
    // ---------------------------------------------------------------

    /// @dev pump.fun'da toz YAPISAL OLARAK YOKTUR cunku `buy` tam-cikislidir:
    ///      `real_token_reserves` tam sifira iner (iki canli tamamlanma
    ///      olculdu, ikisi de tam). Bu giris noktasi o yolu aynen yurur.
    function buyRemainingExactOut(uint256 who, uint256 overpay) external {
        address actor = _actor(who);

        if (curve.complete()) {
            _attemptAfterCompletion(actor, 0, overpay);
            return;
        }

        uint256 reserve = curve.realTokenReserves();
        if (reserve == 0) return;

        Expected memory e = _expectedForExactOut(reserve);
        uint256 value = e.curveIn + e.protocolFee + e.creatorFee + _bound(overpay, 0, 1 ether);
        if (_payerBalance(actor) < value) return;

        Snapshot memory s = _snapshot(actor);
        (bool ok, bytes memory err) = _buyExactOut(actor, reserve, value, type(uint256).max);
        if (!ok) {
            buyRemainingExactOutReverted++;
            lastUnexpectedRevert = _selectorOf(err);
            return;
        }
        _settleObservations(actor, s, true, e, reserve);
    }

    // ---------------------------------------------------------------
    // Giris noktasi 5: butce rezervi ASAN quote girisi -> KISMA
    // ---------------------------------------------------------------

    /// @dev BU FAZIN BORCLU OLDUGU HUCRE. arcpad `buyExactQuoteIn`'de
    ///      rezerve KISAR; pump.fun'in tam-cikisli `buy`u kismaz. Kisma,
    ///      "toz yoktur" garantisini YAPISAL olmaktan cikarip OLCULMESI
    ///      gereken bir seye cevirir. Burada butce kasten yetecegin iki
    ///      katidir, yani kisma HER cagride tetiklenir ve tamamlanma tam
    ///      olarak `buyExactTokensOut(realTokenReserves)` ile ayni yere
    ///      dusmelidir: `realTokenReserves == 0` ve
    ///      `virtualTokenReserves == T - S`.
    ///
    ///      Ayni giris noktasi kismanin KALDIRILMASINI da yakalar ve bu bir
    ///      GUVENLIK degil KULLANILABILIRLIK olcumudur: kisma olmadan
    ///      `_settleBuy` icindeki `realTokenReserves -= tokensOut` alttan
    ///      tasar ve cagri revert eder -- `buyOverBudgetQuoteInReverted`
    ///      artar. Guvenlik invariant'larinin hicbiri bunu goremez, cunku
    ///      revert ayni anda her seyi geri alir.
    function buyOverBudgetQuoteIn(uint256 who) external {
        address actor = _actor(who);

        if (curve.complete()) {
            _attemptAfterCompletion(actor, 1, who);
            return;
        }

        uint256 reserve = curve.realTokenReserves();
        if (reserve == 0) return;

        Expected memory full = _expectedForExactOut(reserve);
        uint256 value = (full.curveIn + full.protocolFee + full.creatorFee) * 2;
        if (_payerBalance(actor) < value) return;

        (Expected memory e, uint256 tokensOut, bool clamped) = _expectedForQuoteIn(value);
        if (clamped) clampsObserved++;

        Snapshot memory s = _snapshot(actor);
        (bool ok, bytes memory err) = _buyQuoteIn(actor, value, 0);
        if (!ok) {
            buyOverBudgetQuoteInReverted++;
            lastUnexpectedRevert = _selectorOf(err);
            return;
        }
        _settleObservations(actor, s, true, e, tokensOut);
    }

    // ---------------------------------------------------------------
    // Giris noktasi 6-7: KODLU aktor, `receive()` icinden geri girer
    // ---------------------------------------------------------------

    /// @dev Faz 1b'nin olculen kor noktasi. Iade `msg.sender`e duz bir
    ///      `.call`'dir; kodsuz bir alicida hicbir sey calistirmaz. Burada
    ///      calisir ve curve'e GERI GIRER. Kati CEI altinda ic islem MESRU
    ///      bir islemdir ve basarir; CEI ters cevrilirse ic islem BAYAT
    ///      rezerv gorur ve dis islem onun defter yazimini uzerine yazar --
    ///      defter ile gercek bakiye ayrisir.
    /// @dev TAM-CIKIS YOLU KULLANILIR, TAM-QUOTE-GIRISI DEGIL, VE SEBEBI
    ///      OLCULDU: `buyExactQuoteIn`'in iadesi ISPATEN 0 ya da 1 wei'dir
    ///      (`correctedNetQuoteIn` butceyi en fazla 1 birim altta birakir),
    ///      yani o yolla `receive()` ya hic tetiklenmez ya da geri girmeye
    ///      yetmeyen bir bakiyeyle tetiklenir -- ilk hali boyleydi ve
    ///      `reentriesObserved` SIFIR kaldi, yani pencere HIC ACILMADI. Tam
    ///      cikis yolunda iade cagiranin sectigi kadardir ve burada bilerek
    ///      1 ether'dir.
    ///
    ///      PENCERE IKI ALIM GIRIS NOKTASI ICIN AYNIDIR: ikisi de `_settleBuy`
    ///      icinden gecer ve iade o fonksiyonun son adimidir. Yani burada
    ///      acilan pencere `buyExactQuoteIn`'in penceresiyle AYNI KOD'dur.
    ///      Ayrica `Mode.Buy` geri cagrisi bakiye yetmezse SATISA duser, yani
    ///      1 wei'lik bir iade bile pencereyi kullanir.
    function reentrantBuy(uint256 amount) external {
        address actor = address(reentrantTrader);

        if (curve.complete()) {
            _attemptAfterCompletion(actor, 0, amount);
            return;
        }

        uint256 reserve = curve.realTokenReserves();
        if (reserve == 0) return;
        uint256 tokensOut = _bound(amount, 1, reserve);

        Expected memory e = _expectedForExactOut(tokensOut);
        uint256 value = e.curveIn + e.protocolFee + e.creatorFee + 1 ether;
        if (_payerBalance(actor) < value) return;

        reentrantTrader.arm(ReentrantTrader.Mode.Buy);
        Snapshot memory s = _snapshot(actor);
        (bool ok, bytes memory err) = _buyExactOut(actor, tokensOut, value, type(uint256).max);
        reentrantTrader.arm(ReentrantTrader.Mode.Off);
        if (!ok) {
            reentrantBuyReverted++;
            lastUnexpectedRevert = _selectorOf(err);
            return;
        }
        _settleObservations(actor, s, true, e, tokensOut);
    }

    function reentrantSell(uint256 amount) external {
        address actor = address(reentrantTrader);

        if (curve.complete()) {
            _attemptAfterCompletion(actor, 2, amount);
            return;
        }

        uint256 bal = token.balanceOf(actor);
        if (bal < 2) return;
        // Yarisini birakir ki ic islem de satacak bir sey bulsun.
        uint256 tokensIn = _bound(amount, 1, bal / 2);

        Expected memory e = _expectedForSell(tokensIn);
        if (e.curveIn <= e.protocolFee + e.creatorFee) return;

        reentrantTrader.arm(ReentrantTrader.Mode.Sell);
        Snapshot memory s = _snapshot(actor);
        (bool ok, bytes memory err) = _sell(actor, tokensIn, 0);
        reentrantTrader.arm(ReentrantTrader.Mode.Off);
        if (!ok) {
            reentrantSellReverted++;
            lastUnexpectedRevert = _selectorOf(err);
            return;
        }
        _settleObservations(actor, s, false, e, tokensIn);
    }

    // ---------------------------------------------------------------
    // Tamamlanma sonrasi deneme
    // ---------------------------------------------------------------

    /// @dev Tamamlanmadan SONRA da her giris noktasi KENDI islemini dener.
    ///      Basari bir ihlaldir; revert bekleniyor ama HANGI revert oldugu da
    ///      olculur -- alim yollarinda `complete` korumasini silmek davranisi
    ///      degistirmez, yalnizca selector'u degistirir.
    function _attemptAfterCompletion(address actor, uint256 kind, uint256 seed) internal {
        callsWhileComplete++;

        bool ok;
        bytes memory err;
        if (kind == 0) {
            if (_payerBalance(actor) < 1 ether) return;
            (ok, err) = _buyExactOut(actor, 1, 1 ether, type(uint256).max);
        } else if (kind == 1) {
            if (_payerBalance(actor) < 1 ether) return;
            (ok, err) = _buyQuoteIn(actor, 1 ether, 0);
        } else {
            uint256 bal = token.balanceOf(actor);
            if (bal == 0) return;
            (ok, err) = _sell(actor, _bound(seed, 1, bal), 0);
        }

        if (ok) {
            tradeSucceededAfterCompletion++;
            return;
        }
        bytes4 sel = _selectorOf(err);
        if (sel != BondingCurve.CurveComplete.selector) {
            postCompletionRevertHadWrongSelector++;
            lastPostCompletionSelector = sel;
        }
    }

    // ---------------------------------------------------------------
    // Cagri yardimcilari -- KODLU aktor kendi kontrati uzerinden, KODSUZ
    // aktor `vm.prank` ile cagirir.
    // ---------------------------------------------------------------

    function _buyExactOut(address actor, uint256 tokensOut, uint256 value, uint256 maxIn)
        internal
        returns (bool, bytes memory)
    {
        if (actor == address(reentrantTrader)) {
            tradesByCodedActor++;
            try reentrantTrader.buyExactTokensOut{value: value}(tokensOut, maxIn) {
                return (true, "");
            } catch (bytes memory err) {
                return (false, err);
            }
        }
        tradesByCodelessActor++;
        vm.prank(actor);
        try curve.buyExactTokensOut{value: value}(tokensOut, maxIn) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    function _buyQuoteIn(address actor, uint256 value, uint256 minOut) internal returns (bool, bytes memory) {
        if (actor == address(reentrantTrader)) {
            tradesByCodedActor++;
            try reentrantTrader.buyExactQuoteIn{value: value}(minOut) {
                return (true, "");
            } catch (bytes memory err) {
                return (false, err);
            }
        }
        tradesByCodelessActor++;
        vm.prank(actor);
        try curve.buyExactQuoteIn{value: value}(minOut) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    function _sell(address actor, uint256 tokensIn, uint256 minOut) internal returns (bool, bytes memory) {
        if (actor == address(reentrantTrader)) {
            tradesByCodedActor++;
            try reentrantTrader.sellExactTokensIn(tokensIn, minOut) {
                return (true, "");
            } catch (bytes memory err) {
                return (false, err);
            }
        }
        tradesByCodelessActor++;
        vm.prank(actor);
        try curve.sellExactTokensIn(tokensIn, minOut) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    // ---------------------------------------------------------------
    // Beklenti -- giris noktasinin algoritmasinin AYNASI
    // ---------------------------------------------------------------

    struct Expected {
        /// Curve tarafina giren (alimda) ya da curve tarafindan cikan
        /// (satimda) anapara; ucret HARIC.
        uint256 curveIn;
        uint256 protocolFee;
        uint256 creatorFee;
    }

    function _expectedForExactOut(uint256 tokensOut) internal view returns (Expected memory e) {
        e.curveIn = CurveMath.quoteBuyCost(tokensOut, curve.virtualQuoteReserves(), curve.virtualTokenReserves());
        e.protocolFee = CurveMath.feeOn(e.curveIn, PROTOCOL_FEE_BPS);
        e.creatorFee = _creatorFeeOn(e.curveIn);
    }

    function _expectedForSell(uint256 tokensIn) internal view returns (Expected memory e) {
        e.curveIn = CurveMath.quoteSellProceeds(tokensIn, curve.virtualQuoteReserves(), curve.virtualTokenReserves());
        e.protocolFee = CurveMath.feeOn(e.curveIn, PROTOCOL_FEE_BPS);
        e.creatorFee = _creatorFeeOn(e.curveIn);
    }

    /// @dev DIKKAT -- ucret parcalari `correctedNetQuoteIn`'in DONDURDUGU
    ///      degerlerdir ve donen net uzerinden YENIDEN HESAPLANMAZ. Duzeltme
    ///      tetiklendiginde ikisi ayrisir; yeniden hesaplayan bir ayna
    ///      dogru kontrata karsi bile kirilir (olculdu).
    function _expectedForQuoteIn(uint256 value)
        internal
        view
        returns (Expected memory e, uint256 tokensOut, bool clamped)
    {
        uint256 creatorBps = creator == address(0) ? 0 : CREATOR_FEE_BPS;
        (e.curveIn, e.protocolFee, e.creatorFee) = CurveMath.correctedNetQuoteIn(value, PROTOCOL_FEE_BPS, creatorBps);

        uint256 vq = curve.virtualQuoteReserves();
        uint256 vt = curve.virtualTokenReserves();
        tokensOut = CurveMath.quoteBuyTokensOut(e.curveIn, vq, vt);

        uint256 reserve = curve.realTokenReserves();
        if (tokensOut > reserve) {
            clamped = true;
            tokensOut = reserve;
            e.curveIn = CurveMath.quoteBuyCost(tokensOut, vq, vt);
            e.protocolFee = CurveMath.feeOn(e.curveIn, PROTOCOL_FEE_BPS);
            e.creatorFee = creatorBps == 0 ? 0 : CurveMath.feeOn(e.curveIn, CREATOR_FEE_BPS);
        }
    }

    // ---------------------------------------------------------------
    // Olcum
    // ---------------------------------------------------------------

    struct Snapshot {
        uint256 curveBalance;
        uint256 actorTokens;
        uint256 protocolOwed;
        uint256 creatorOwed;
        uint256 escrowTotalOwed;
        uint256 virtualQuote;
        uint256 reentries;
        bool wasComplete;
    }

    function _snapshot(address actor) internal view returns (Snapshot memory s) {
        s.curveBalance = address(curve).balance;
        s.actorTokens = token.balanceOf(actor);
        s.protocolOwed = escrow.owed(protocolTreasury);
        s.creatorOwed = creator == address(0) ? 0 : escrow.owed(creator);
        s.escrowTotalOwed = escrow.totalOwed();
        s.virtualQuote = curve.virtualQuoteReserves();
        s.reentries = reentrantTrader.reentries();
        s.wasComplete = curve.complete();
    }

    function _settleObservations(
        address actor,
        Snapshot memory s,
        bool isBuy,
        Expected memory e,
        uint256 expectedTokensMoved
    ) internal {
        // --- akis muhasebesi (defterden BAGIMSIZ kaynaklar) ---
        uint256 tokensMoved;
        if (isBuy) {
            ghostQuoteIn += address(curve).balance - s.curveBalance;
            tokensMoved = token.balanceOf(actor) - s.actorTokens;
            ghostTokensOut += tokensMoved;
        } else {
            ghostQuoteOut += s.curveBalance - address(curve).balance;
            tokensMoved = s.actorTokens - token.balanceOf(actor);
            ghostTokensIn += tokensMoved;
        }

        // --- geri alinamazlik ---
        if (curve.complete()) ghostSawComplete = true;
        if (ghostSawComplete && !curve.complete()) completeWasUnset++;

        // --- tamamlanma toz kontrolu ---
        if (!s.wasComplete && curve.complete()) {
            completions++;
            if (curve.realTokenReserves() != 0) completionLeftDust++;
            if (
                curve.virtualTokenReserves()
                    != curve.INITIAL_VIRTUAL_TOKEN_RESERVES() - curve.INITIAL_REAL_TOKEN_RESERVES()
            ) completionLeftWrongVirtualReserves++;
        }

        // --- ic islem oldu mu ---
        uint256 reentriesNow = reentrantTrader.reentries();
        if (reentriesNow != s.reentries) {
            // IC ISLEM OLDU: bu cagrida escrow'a IKI islemin paylari yatti ve
            // rezerv farki da iki islemin toplami. `feeOn` tavana yuvarladigi
            // icin `feeOn(a) + feeOn(b) != feeOn(a+b)`, dolayisiyla TEK bir
            // beklentiyle karsilastirma bu cagri icin ANLAMSIZDIR ve atlanir.
            // Reentrancy'nin kendisi bu cagrida ledger/odeme gucu/sabit
            // carpim invariant'lariyla korunur -- onlar delta degil MUTLAK
            // durum iddialaridir ve ic islemden etkilenmezler.
            reentriesObserved += reentriesNow - s.reentries;
            return;
        }

        // --- anapara ve token miktari ---
        uint256 curveIn =
            isBuy ? curve.virtualQuoteReserves() - s.virtualQuote : s.virtualQuote - curve.virtualQuoteReserves();
        if (curveIn != e.curveIn) curveInMismatch++;
        if (tokensMoved != expectedTokensMoved) tokensMovedMismatch++;

        // --- ucret parcalari ---
        uint256 protocolPaid = escrow.owed(protocolTreasury) - s.protocolOwed;
        uint256 creatorPaid = creator == address(0) ? 0 : escrow.owed(creator) - s.creatorOwed;

        // UCUNCU BIR ALICIYA sizinti. Iki parcayi ayri olcen sayaclar bunu
        // goremez; escrow'un TOPLAM alacagi ise gorur.
        if (escrow.totalOwed() - s.escrowTotalOwed != protocolPaid + creatorPaid) feeWentToUnknownRecipient++;

        if (protocolPaid != e.protocolFee) protocolPartWrong++;
        if (creatorPaid != e.creatorFee) creatorPartWrong++;

        uint256 summedFromParts = e.protocolFee + e.creatorFee;
        uint256 observed = protocolPaid + creatorPaid;
        if (observed != summedFromParts) feeNotSummedFromParts++;

        // TOPLAMDAN BOLME TANIGI. `feeOn(x,95) + feeOn(x,30)` ile
        // `feeOn(x,125)` genel olarak FARKLIDIR ve fark her seferinde
        // protokolun aleyhinedir. Yalnizca ikisinin farklilastigi girdilerde
        // ve gozlenen deger tam olarak birlesik orani verdiginde artar --
        // yani bu sayac "yanlis ucret"i degil, "toplamdan bolunmus ucret"i
        // ISIMLENDIRIR. Creator sifirken ayni tanik protokol payi uzerinden
        // kurulur: oradaki mutasyon "creator payini protokole KATLAMAK"tir.
        uint256 dividedFromTotal = CurveMath.feeOn(e.curveIn, COMBINED_FEE_BPS_FOR_MEASUREMENT_ONLY);
        if (creator != address(0)) {
            if (summedFromParts != dividedFromTotal && observed == dividedFromTotal) feeWasDividedFromTotal++;
        } else {
            if (e.protocolFee != dividedFromTotal && protocolPaid == dividedFromTotal) feeWasDividedFromTotal++;
        }

        if (isBuy) buysMeasuredForFees++;
        else sellsMeasuredForFees++;
    }

    // ---------------------------------------------------------------
    // Kucuk yardimcilar
    // ---------------------------------------------------------------

    function _actor(uint256 who) internal view returns (address) {
        return actors[_bound(who, 0, 3)];
    }

    /// @notice Cagriyi FIILEN odeyen adresin bakiyesi.
    /// @dev OLCULDU VE SASIRTICIDIR: `vm.prank(actor)` altinda `{value: x}`
    ///      ile yapilan cagrida degeri PRANK EDILEN adres oder, cagriyi fiilen
    ///      yapan kontrat degil. Ilk hali handler'in bakiyesine bakiyordu ve
    ///      EOA aktorler sifir bakiyeliydi: cagri `EvmError: OutOfFunds` ile
    ///      dusuyor, `try/catch` onu bos revert verisiyle yakaliyor ve HEM
    ///      kullanilabilirlik sayaci HEM DE tamamlanma sonrasi selector
    ///      kontrolu (bos veri != `CurveComplete()`) sahte alarm veriyordu.
    ///      KODLU aktor yolunda ise cagriyi handler'in KENDISI yapar (trader
    ///      forward eder), dolayisiyla oradaki odeyici handler'dir.
    function _payerBalance(address actor) internal view returns (uint256) {
        return actor == address(reentrantTrader) ? address(this).balance : actor.balance;
    }

    /// @dev Creator sifirsa pay ALINMAZ ve protokol payina KATLANMAZ.
    function _creatorFeeOn(uint256 amount) internal view returns (uint256) {
        return creator == address(0) ? 0 : CurveMath.feeOn(amount, CREATOR_FEE_BPS);
    }

    function _selectorOf(bytes memory err) internal pure returns (bytes4) {
        if (err.length < 4) return bytes4(0);
        return bytes4(err[0]) | (bytes4(err[1]) >> 8) | (bytes4(err[2]) >> 16) | (bytes4(err[3]) >> 24);
    }
}

/// @notice KODLU aktor. Silahsizken duz bir kontrat alicidir (kodlu ama
///         zararsiz); silahliyken `receive()` icinden curve'e GERI GIRER.
/// @dev Ic cagri DUZ `.call` ile yapilir ve basarisizligi YUKARI TASINMAZ:
///      bir revert dis islemi de dusurseydi `fail_on_revert = false` onu
///      sessizce yutar ve saldiri hic GOZLENEMEZ olurdu (Faz 1b'nin escrow
///      handler'inda ayni gerekce yazili).
/// @dev `inCallback` tek seviyeli geri girise izin verir. Sinirsiz recursion
///      cagri yigitini tuketip TUM dis cagriyi revert ettirir -- yine ayni
///      sebeple gozlenemez hale gelirdi.
contract ReentrantTrader {
    enum Mode {
        Off,
        Buy,
        Sell
    }

    BondingCurve public immutable curve;
    IERC20 public immutable token;

    Mode public mode;
    bool internal inCallback;

    /// @notice Ic cagrinin BASARILI oldugu sayi. Handler bunu delta tabanli
    ///         olcumu atlamak icin okur.
    uint256 public reentries;

    constructor(BondingCurve curve_, IERC20 token_) {
        curve = curve_;
        token = token_;
        token_.approve(address(curve_), type(uint256).max);
    }

    function arm(Mode mode_) external {
        mode = mode_;
    }

    function buyExactTokensOut(uint256 tokensOut, uint256 maxIn) external payable {
        curve.buyExactTokensOut{value: msg.value}(tokensOut, maxIn);
    }

    function buyExactQuoteIn(uint256 minOut) external payable {
        curve.buyExactQuoteIn{value: msg.value}(minOut);
    }

    function sellExactTokensIn(uint256 tokensIn, uint256 minOut) external {
        curve.sellExactTokensIn(tokensIn, minOut);
    }

    receive() external payable {
        if (mode == Mode.Off || inCallback) return;
        inCallback = true;

        bool ok;
        uint256 v = address(this).balance;
        if (v > 1 ether) v = 1 ether;
        // Alim modunda bakiye yetmiyorsa SATISA duser. Boylece iadesi en
        // fazla 1 wei olan `buyExactQuoteIn` yolunda bile pencere kullanilir.
        if (mode == Mode.Buy && v >= 4) {
            (ok,) = address(curve).call{value: v}(abi.encodeWithSelector(BondingCurve.buyExactQuoteIn.selector, 0));
        }
        if (!ok) {
            uint256 bal = token.balanceOf(address(this));
            if (bal != 0) {
                (ok,) = address(curve)
                    .call(abi.encodeWithSelector(BondingCurve.sellExactTokensIn.selector, bal, uint256(0)));
            }
        }
        if (ok) reentries++;

        inCallback = false;
    }
}
