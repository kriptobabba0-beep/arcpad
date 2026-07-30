// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {ReentrantActor, ReentryLog, P_COUNT} from "./ReentrantAttacker.sol";

/// @title ReentrancyHandler
/// @notice DORT curve, BIR escrow, BIR factory ve YEDI yeniden giris noktasi
///         uzerinde yurutulen saldiri kampanyasinin surucusu.
///
/// @dev NICIN AYRI BIR HANDLER, `CurveTradingHandler` VARKEN. O handler TEK
///      curve surer ve tek bir `ReentrantTrader` tasir; bu paketin iddiasi ise
///      CAPRAZ kontrat ve CAPRAZ curve'dur: bir curve'un odemesi icinden
///      BASKA bir curve'e, escrow'a ve factory'ye girilebilir. Tek curve'lu
///      bir dunyada bu ifade EDILEMEZ, dolayisiyla genisletme degil ikinci
///      bir kampanya dogru sekildir. Eski handler'in olctugu her sey
///      yerinde durur; buradaki iddialar onun uzerine BINER.
///
/// @dev OLAY GUNLUGU BU DOSYANIN MERKEZI ARACIDIR, ve sebebi olculebilir bir
///      kusurdur: delta tabanli olcum (cagri oncesi/sonrasi durum farki)
///      YENIDEN GIRIS ALTINDA ANLAMSIZDIR. Bir dis alimin icinden iki ic
///      islem daha gecmisse, "escrow'un alacagi ne kadar artti" sorusunun
///      cevabi UC islemin toplamidir ve tek bir beklentiyle karsilastirmak
///      hicbir sey olcmez -- `CurveTradingHandler` bunu fark edip o cagrilarda
///      olcumu ATLAR. Burada atlanmaz: `vm.recordLogs()` islemin TAMAMINI --
///      ic ice her cerceve dahil -- kaydeder, ve her `Trade`, `Completed`,
///      `Graduated`, `Deposited` olayi TEK TEK denetlenir. Yani derinlik
///      arttikca olcum korlesmez, ZENGINLESIR.
///
/// @dev HANDLER ICINDE ASSERTION CAGRILMAZ -- `CurveTradingHandler`in bas
///      notundaki olculmus gerekce burada da aynen gecerlidir
///      (`fail_on_revert = false` her revert'i, forge-std assertion'larinin
///      urettikleri dahil, sessizce yutar). Yalnizca sayac artirilir; iddialar
///      `ReentrancyInvariants.t.sol` icindedir.
contract ReentrancyHandler is CommonBase, StdUtils {
    // ---------------------------------------------------------------
    // Dunya
    // ---------------------------------------------------------------

    uint256 internal constant N_CURVES = 4;

    struct World {
        FeeEscrow escrow;
        LaunchFactory factory;
        ReentryLog log;
        address eoa;
        address protocolTreasury;
        uint256 maxQuotePerCall;
        uint256 saleSupply;
    }

    FeeEscrow public immutable escrow;
    LaunchFactory public immutable factory;
    ReentryLog public immutable log;
    address public immutable eoa;
    address public immutable protocolTreasury;
    uint256 public immutable maxQuotePerCall;
    uint256 public immutable saleSupply;

    BondingCurve[N_CURVES] public curveAt;
    IERC20[N_CURVES] public tokenAt;
    address[N_CURVES] public creatorAt;
    ReentrantActor[3] public actorAt;

    /// @dev `curveIndexPlusOne[emitter]` 0 ise emitter bir curve DEGILDIR.
    ///      Olay denetimi bunu kullanir.
    mapping(address => uint256) public curveIndexPlusOne;

    // ---------------------------------------------------------------
    // Olay denetiminden dogan IHLAL sayaclari -- hepsi ==0
    // ---------------------------------------------------------------

    /// @notice Bir curve `Completed` yaydiktan SONRA ayni curve icin bir
    ///         `Trade` daha yayildi.
    /// @dev Delta tabanli olcumun goremeyecegi sekil budur: ic ice bir
    ///      cerceveden yapilan tamamlanma-sonrasi islem, dis cagri BASARIYLA
    ///      donerse hicbir durum farkinda "yasak bir islem" diye gorunmez.
    uint256 public tradeAfterCompletion;
    /// @notice ...ve `Graduated`dan sonra.
    uint256 public tradeAfterGraduation;
    /// @notice Ayni curve IKI KEZ `Completed` yaydi.
    uint256 public completedTwice;
    /// @notice Ayni curve IKI KEZ `Graduated` yaydi. Bayragi dis cagrilarin
    ///         ARKASINA almak tam olarak burada gorunur.
    uint256 public graduatedTwice;

    /// @notice Yayilan iki ucret payini AYNI anapara uzerinden IKI AYRI TAVAN
    ///         olarak aciklayan hicbir anapara yok.
    /// @dev NICIN "ANAPARA PENCERESI" VE NICIN DUZ ESITLIK DEGIL -- olculmus
    ///      bir sebep: `buyExactQuoteIn`in DUZELTILMEMIS yolunda ucret
    ///      `correctedNetQuoteIn` icinde DUZELTME ONCESI net uzerinden alinir,
    ///      olaydaki `quoteAmount` ise DUZELTILMIS nettir
    ///      (`CurveMath.correctedNetQuoteIn`, `net -= overshoot`). Yani
    ///      `feeOn(quoteAmount, 95) == protocolFee` O YOLDA YANLIS BIR
    ///      IDDIADIR ve duz esitlikle kurulmus bir sayac girdilerin buyuk
    ///      cogunlugunda yanlis alarm verirdi -- NatSpec'in kendi olcumu
    ///      (%99,95'inde toplam butceye ESIT) tam olarak duzeltmenin sik
    ///      tetiklendigini soyler. Bu yuzden iddia sudur: iki pay, `quoteAmount`
    ///      ile `quoteAmount + FEE_PRINCIPAL_WINDOW` arasindaki BIR anaparanin
    ///      iki ayri tavani olmak zorundadir. Toplamdan bolunmus bir ucret bu
    ///      pencerede HICBIR anapara ile aciklanamaz.
    uint256 public feePartsInconsistent;
    /// @notice Creator SIFIRKEN creator payi sifir degil.
    /// @dev Yoldan BAGIMSIZ ve TAM: duzeltme bu iddiaya dokunmaz.
    uint256 public creatorPartWrong;
    /// @notice Iki pay TAM OLARAK `feeOn(x, 125)` -- yani toplamdan bolunmus.
    /// @dev `feePartsInconsistent`in ALT SINIFIDIR: pencerede aciklanamayan
    ///      bir ucret ciftinin SEKLINI isimlendirir. Ayri durur cunku
    ///      "yanlis ucret" ile "toplamdan bolunmus ucret" ayni sey degildir ve
    ///      bu depoda oldurulmesi istenen mutant ikincisidir.
    uint256 public feeWasDividedFromTotal;
    /// @notice Escrow'a bir curve tarafindan yatirilan pay, ne treasury'ye ne
    ///         de o curve'un creator'una gitti.
    uint256 public feeWentToUnknownRecipient;

    /// @notice `Graduated` olayindaki baz bacagi `poolSeedSupply` degil.
    uint256 public graduationBaseWrong;

    // ---------------------------------------------------------------
    // Olay denetiminden dogan KIMLIK muhasebesi
    // ---------------------------------------------------------------

    /// @notice Curve basina, `Trade` olaylarindan toplanan ucret.
    uint256[N_CURVES] public feesFromTrades;
    /// @notice Curve basina, escrow'a FIILEN yatan ucret.
    uint256[N_CURVES] public feesDeposited;
    /// @notice Curve basina `Graduated`in quote bacagi.
    uint256[N_CURVES] public graduationQuotePaid;

    bool[N_CURVES] public sawCompleted;
    bool[N_CURVES] public sawGraduated;

    // ---------------------------------------------------------------
    // Kapsam sayaclari -- SIFIR OLMASI GEREKMEZ
    // ---------------------------------------------------------------

    uint256 public tradesObserved;
    uint256 public completionsObserved;
    uint256 public graduationsObserved;
    uint256 public depositsObserved;
    uint256 public claimsObserved;
    uint256 public codedActorCalls;
    uint256 public codelessActorCalls;
    uint256 public armedCalls;
    uint256 public disarmedCalls;
    uint256 public clampsObserved;
    /// @notice Iki ucret payini aciklayan EN KUCUK anapara kaymasi, gorulen en
    ///         buyugu. Pencere genisliginin olculmus gerekcesi budur.
    uint256 public maxFeePrincipalGap;

    // ---------------------------------------------------------------
    // Kullanilabilirlik sayaclari -- GIRIS NOKTASI BASINA, hepsi ==0
    // ---------------------------------------------------------------

    uint256 public buyExactOutReverted;
    uint256 public buyQuoteInReverted;
    uint256 public sellReverted;
    uint256 public buyRemainingReverted;
    uint256 public buyOverBudgetReverted;
    uint256 public graduateReverted;
    uint256 public claimReverted;

    bytes4 public lastUnexpectedRevert;

    // ---------------------------------------------------------------
    // Olay imzalari
    // ---------------------------------------------------------------

    /// @dev `immutable`, `constant` DEGIL -- ve bu bir uslup tercihi degil
    ///      derleyici kisitidir: `Event.selector` solc icin derleme zamani
    ///      SABITI SAYILMAZ (Error 8349). `immutable` ayni degeri constructor'da
    ///      bir kez hesaplar; elle yazilmis bir keccak literali ise olay imzasi
    ///      degistiginde SESSIZCE yanlislasirdi, bu yuzden literal YAZILMIYOR.
    bytes32 internal immutable TRADE_TOPIC = BondingCurve.Trade.selector;
    bytes32 internal immutable COMPLETED_TOPIC = BondingCurve.Completed.selector;
    bytes32 internal immutable GRADUATED_TOPIC = BondingCurve.Graduated.selector;
    bytes32 internal immutable DEPOSITED_TOPIC = FeeEscrow.Deposited.selector;

    uint256 internal constant PROTOCOL_FEE_BPS = 95;
    uint256 internal constant CREATOR_FEE_BPS = 30;
    /// @dev YALNIZCA TANIK ICIN. Kontratta boyle bir sabit yoktur ve olmamali.
    uint256 internal constant COMBINED_FEE_BPS_FOR_MEASUREMENT_ONLY = 125;
    /// @dev Anapara penceresinin genisligi. Sekiz TAHMIN DEGIL: duzeltme
    ///      `net`i en fazla iki tavan yuvarlamasi kadar dusurebilir, yani
    ///      gercek kayma 0..2'dir; sekiz o araligin dort kati ve fiilen
    ///      gorulen en buyuk kayma `maxFeePrincipalGap` ile RAPORLANIR.
    uint256 internal constant FEE_PRINCIPAL_WINDOW = 8;

    constructor(
        World memory w,
        BondingCurve[N_CURVES] memory curves,
        IERC20[N_CURVES] memory tokens,
        address[N_CURVES] memory creators,
        ReentrantActor[3] memory actors
    ) {
        escrow = w.escrow;
        factory = w.factory;
        log = w.log;
        eoa = w.eoa;
        protocolTreasury = w.protocolTreasury;
        maxQuotePerCall = w.maxQuotePerCall;
        saleSupply = w.saleSupply;

        for (uint256 i = 0; i < N_CURVES; i++) {
            curveAt[i] = curves[i];
            tokenAt[i] = tokens[i];
            creatorAt[i] = creators[i];
            curveIndexPlusOne[address(curves[i])] = i + 1;
        }
        actorAt[0] = actors[0];
        actorAt[1] = actors[1];
        actorAt[2] = actors[2];
    }

    receive() external payable {}

    // ---------------------------------------------------------------
    // Giris noktasi 1: tam token cikisi (FAZLA odeme -> P2 iade yolu)
    // ---------------------------------------------------------------

    function buyExactOut(uint256 who, uint256 ci, uint256 amount, uint256 plan, uint256 depth) external {
        vm.recordLogs();
        _buyExactOut(who, ci, amount, plan, depth);
        _audit();
    }

    function _buyExactOut(uint256 who, uint256 ci, uint256 amount, uint256 plan, uint256 depth) internal {
        _noteSelection(who, depth);
        uint256 i = _curveIndex(ci);
        BondingCurve c = curveAt[i];
        if (c.complete()) return;

        uint256 reserve = c.realTokenReserves();
        if (reserve == 0) return;
        uint256 tokensOut = _bound(amount, 1, reserve);

        (uint256 curveIn, uint256 pf, uint256 cf) = _quoteExactOut(i, tokensOut);
        // FAZLADAN ODENIR: iade (P2) ancak boyle yurunur.
        uint256 value = curveIn + pf + cf + _bound(amount, 1, maxQuotePerCall);

        address actor = _arm(who, plan, depth);
        (bool ok, bytes memory err) = _callBuyExactOut(actor, i, tokensOut, value);
        _disarm();

        if (!ok) {
            buyExactOutReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    // ---------------------------------------------------------------
    // Giris noktasi 2: tam quote girisi
    // ---------------------------------------------------------------

    function buyQuoteIn(uint256 who, uint256 ci, uint256 gross, uint256 plan, uint256 depth) external {
        vm.recordLogs();
        _buyQuoteIn(who, ci, gross, plan, depth);
        _audit();
    }

    function _buyQuoteIn(uint256 who, uint256 ci, uint256 gross, uint256 plan, uint256 depth) internal {
        _noteSelection(who, depth);
        uint256 i = _curveIndex(ci);
        BondingCurve c = curveAt[i];
        if (c.complete()) return;
        if (c.realTokenReserves() == 0) return;

        // Alt sinir 4: (95, 30) bps'te duzeltilmis net ISPATEN >= 2'dir.
        uint256 value = _bound(gross, 4, maxQuotePerCall);

        address actor = _arm(who, plan, depth);
        (bool ok, bytes memory err) = _callBuyQuoteIn(actor, i, value);
        _disarm();

        if (!ok) {
            buyQuoteInReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    // ---------------------------------------------------------------
    // Giris noktasi 3: satim
    // ---------------------------------------------------------------

    function sell(uint256 who, uint256 ci, uint256 amount, uint256 plan, uint256 depth) external {
        vm.recordLogs();
        _sell(who, ci, amount, plan, depth);
        _audit();
    }

    function _sell(uint256 who, uint256 ci, uint256 amount, uint256 plan, uint256 depth) internal {
        _noteSelection(who, depth);
        uint256 i = _curveIndex(ci);
        BondingCurve c = curveAt[i];
        if (c.complete()) return;

        address actor = _actor(who);
        uint256 bal = tokenAt[i].balanceOf(actor);
        if (bal == 0) return;
        uint256 tokensIn = _bound(amount, 1, bal);

        // `ProceedsTooSmall` MESRU bir revert'tir ve kullanilabilirlik kusuru
        // SAYILMAZ; onceden elenir.
        uint256 proceeds = CurveMath.quoteSellProceeds(tokensIn, c.virtualQuoteReserves(), c.virtualTokenReserves());
        uint256 pf = CurveMath.feeOn(proceeds, PROTOCOL_FEE_BPS);
        uint256 cf = creatorAt[i] == address(0) ? 0 : CurveMath.feeOn(proceeds, CREATOR_FEE_BPS);
        if (proceeds <= pf + cf) return;

        _armActor(actor, plan, depth);
        (bool ok, bytes memory err) = _callSell(actor, i, tokensIn);
        _disarm();

        if (!ok) {
            sellReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    // ---------------------------------------------------------------
    // Giris noktasi 4: kalanin TAMAMI, tam-cikis yoluyla (kapatici)
    // ---------------------------------------------------------------

    function buyRemaining(uint256 who, uint256 ci, uint256 overpay, uint256 plan, uint256 depth) external {
        vm.recordLogs();
        _buyRemaining(who, ci, overpay, plan, depth);
        _audit();
    }

    function _buyRemaining(uint256 who, uint256 ci, uint256 overpay, uint256 plan, uint256 depth) internal {
        _noteSelection(who, depth);
        uint256 i = _curveIndex(ci);
        BondingCurve c = curveAt[i];
        if (c.complete()) return;

        uint256 reserve = c.realTokenReserves();
        if (reserve == 0) return;

        (uint256 curveIn, uint256 pf, uint256 cf) = _quoteExactOut(i, reserve);
        uint256 value = curveIn + pf + cf + _bound(overpay, 1, maxQuotePerCall);

        address actor = _arm(who, plan, depth);
        (bool ok, bytes memory err) = _callBuyExactOut(actor, i, reserve, value);
        _disarm();

        if (!ok) {
            buyRemainingReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    // ---------------------------------------------------------------
    // Giris noktasi 5: rezervi ASAN butce -> KISMA (kapatici)
    // ---------------------------------------------------------------

    function buyOverBudget(uint256 who, uint256 ci, uint256 plan, uint256 depth) external {
        vm.recordLogs();
        _buyOverBudget(who, ci, plan, depth);
        _audit();
    }

    function _buyOverBudget(uint256 who, uint256 ci, uint256 plan, uint256 depth) internal {
        _noteSelection(who, depth);
        uint256 i = _curveIndex(ci);
        BondingCurve c = curveAt[i];
        if (c.complete()) return;

        uint256 reserve = c.realTokenReserves();
        if (reserve == 0) return;

        (uint256 curveIn, uint256 pf, uint256 cf) = _quoteExactOut(i, reserve);
        uint256 value = (curveIn + pf + cf) * 2;
        clampsObserved++;

        address actor = _arm(who, plan, depth);
        (bool ok, bytes memory err) = _callBuyQuoteIn(actor, i, value);
        _disarm();

        if (!ok) {
            buyOverBudgetReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
    }

    // ---------------------------------------------------------------
    // Giris noktasi 6: graduation (P5 + P6)
    // ---------------------------------------------------------------

    /// @dev HEDEF `actorAt[0]`DIR ve baska turlu olamaz: D4 yalnizca cozulmus
    ///      hedefin `graduate()` cagirmasina izin verir. Hedefin SILAHLI bir
    ///      aktor olmasi P6'yi (graduation odemesi) ve dusman token'a bagli
    ///      curve'de P5'i (graduation'in token transferi) acan seydir.
    ///
    /// @dev UC HUCRE, onceden filtrelenmeden -- `CurveTradingHandler.graduate`
    ///      ile ayni olculmus gerekce: filtre `NotComplete` mutantini
    ///      GORUNMEZ yapardi.
    function graduate(uint256 ci, uint256 plan, uint256 depth) external {
        vm.recordLogs();
        _graduate(ci, plan, depth);
        _audit();
    }

    function _graduate(uint256 ci, uint256 plan, uint256 depth) internal {
        uint256 i = _curveIndex(ci);
        BondingCurve c = curveAt[i];

        bool wasComplete = c.complete();
        bool wasGraduated = c.graduated();

        ReentrantActor target = actorAt[0];
        _armActor(address(target), plan, depth);
        (bool ok, bytes memory err) = _callGraduate(target, i);
        _disarm();

        if (ok) return;

        bytes4 sel = _selectorOf(err);
        if (!wasComplete) {
            if (sel != BondingCurve.NotComplete.selector) {
                graduateReverted++;
                lastUnexpectedRevert = sel;
            }
        } else if (wasGraduated) {
            if (sel != BondingCurve.AlreadyGraduated.selector) {
                graduateReverted++;
                lastUnexpectedRevert = sel;
            }
        } else {
            // Tamamlanmis, mezun olmamis, hedef `receive()`i kabul eden bir
            // aktor: revert etmesi icin MESRU bir sebep yoktur.
            graduateReverted++;
            lastUnexpectedRevert = sel;
        }
    }

    // ---------------------------------------------------------------
    // Giris noktasi 7: escrow claim (P7) -- IZINSIZ
    // ---------------------------------------------------------------

    /// @dev CAGIRAN HANDLER'IN KENDISIDIR, alici degil. `claim` izinsizdir ve
    ///      "ucuncu bir taraf alicinin `receive()`ini istedigi anda
    ///      calistirir" ozelligi tam olarak escrow kisit (2)'nin dayandigi
    ///      seydir; alicinin kendisi cagirsaydi olculen sey daha zayif olurdu.
    function claim(uint256 whoRecipient, uint256 plan, uint256 depth) external {
        vm.recordLogs();
        _claim(whoRecipient, plan, depth);
        _audit();
    }

    function _claim(uint256 whoRecipient, uint256 plan, uint256 depth) internal {
        address r = _payee(whoRecipient);
        if (escrow.owed(r) == 0) return;

        if (_bound(depth, 0, 3) == 0) disarmedCalls++;
        else armedCalls++;
        _armAll(plan, depth);
        claimsObserved++;
        try escrow.claim(r) {}
        catch (bytes memory err) {
            claimReverted++;
            lastUnexpectedRevert = _selectorOf(err);
        }
        _disarm();
    }

    // ---------------------------------------------------------------
    // OLAY DENETIMI -- bu dosyanin merkezi araci
    // ---------------------------------------------------------------

    /// @dev Islemin TAMAMINI, ic ice her cerceve dahil, olay olay okur.
    ///      Kayit `vm.recordLogs()` ile eylemin BASINDA baslar, dolayisiyla
    ///      burada okunan liste dis cagrinin urettigi HER SEYDIR.
    ///
    /// @dev BU SAYACLAR "YAYILDI" DER, "ISLENDI" DEMEZ -- VE FARK OLCULDU,
    ///      VARSAYILMADI. `vm.getRecordedLogs()`, SONRADAN REVERT EDEN bir alt
    ///      cerceveden yayilmis olaylari DA dondurur: bunu olcen pin
    ///      `ReentrancyInvariants.t.sol` icindeki
    ///      `test_recordedLogsSurviveARevertedFrame`dir (iki olay bekleniyor,
    ///      ikisi de geliyor, biri revert eden cagriya ait).
    ///
    ///      IKI SONUCU VAR VE IKISI DE KAYDA GECIRILIYOR:
    ///        (1) GUC. Bir korumayi gecip olayini yayan, sonra baska bir
    ///            sebeple duren bir cerceve GORUNUR. `graduated` bayragini dis
    ///            cagrilarin arkasina alan mutant tam olarak boyle yakalandi:
    ///            ikinci `graduate()` `AlreadyGraduated`i GECTI ve `Graduated`i
    ///            YAYDI, ardindan token bacaginda dustu -- zincirde hicbir
    ///            ikinci odeme olmadi, ama KORUMANIN GECILDIGI gorundu.
    ///            Durum tabanli hicbir iddia bunu goremezdi.
    ///        (2) SINIR. Dogru kodda da `Trade` yayip sonra revert eden bir
    ///            cerceve olsaydi, ucret kimligi (`feesFromTrades` ==
    ///            `feesDeposited`) yanlis alarm verirdi. BU DUNYADA O YOL
    ///            ULASILAMAZ ve ulasilamazligi SAYILARAK gosterilebilir:
    ///            `_settleBuy` olaydan sonra yalnizca uc sekilde duser --
    ///            `TokenTransferFailed` (curve token'i her zaman tutar),
    ///            `FeeEscrow` revert'i (`protocolTreasury()` sifir olamaz,
    ///            `protocolFee` tavan yuvarlandigi icin sifir olamaz, creator
    ///            payi sifirken zaten yatirilmaz) ve `RefundFailed` (bu
    ///            kampanyadaki hicbir alicinin `receive()`i revert etmez).
    ///            Yani bu bir OLCULMUS yokluk, yapisal bir garanti DEGIL: bu
    ///            dunyaya revert eden bir `receive()` eklenirse sinir gercek
    ///            olur ve sayaclarin ayristirilmasi gerekir.
    function _audit() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 k = 0; k < logs.length; k++) {
            Vm.Log memory l = logs[k];
            if (l.topics.length == 0) continue;

            uint256 plusOne = curveIndexPlusOne[l.emitter];
            if (plusOne != 0) {
                _auditCurveLog(plusOne - 1, l);
            } else if (l.emitter == address(escrow) && l.topics[0] == DEPOSITED_TOPIC) {
                _auditDepositLog(l);
            }
        }
    }

    function _auditCurveLog(uint256 i, Vm.Log memory l) internal {
        bytes32 t0 = l.topics[0];

        if (t0 == TRADE_TOPIC) {
            tradesObserved++;
            if (sawCompleted[i]) tradeAfterCompletion++;
            if (sawGraduated[i]) tradeAfterGraduation++;

            (,/* bool isBuy */ /* uint256 tokenAmount */, uint256 quoteAmount, uint256 pf, uint256 cf,,,,) =
                abi.decode(l.data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));

            _checkFeeParts(i, quoteAmount, pf, cf);
            feesFromTrades[i] += pf + cf;
        } else if (t0 == COMPLETED_TOPIC) {
            if (sawCompleted[i]) completedTwice++;
            sawCompleted[i] = true;
            completionsObserved++;
        } else if (t0 == GRADUATED_TOPIC) {
            if (sawGraduated[i]) graduatedTwice++;
            sawGraduated[i] = true;
            graduationsObserved++;

            (uint256 baseAmount, uint256 quoteAmount) = abi.decode(l.data, (uint256, uint256));
            if (baseAmount != curveAt[i].poolSeedSupply()) graduationBaseWrong++;
            graduationQuotePaid[i] += quoteAmount;
        }
    }

    /// @dev Ucret ciftini denetler. Sira baglayicidir: once creator-sifir
    ///      TAMLIGI (yoldan bagimsiz), sonra anapara penceresi, ve pencere
    ///      hicbir sey aciklamiyorsa toplamdan-bolme TANIGI.
    function _checkFeeParts(uint256 i, uint256 quoteAmount, uint256 pf, uint256 cf) internal {
        bool zeroCreator = creatorAt[i] == address(0);
        if (zeroCreator && cf != 0) creatorPartWrong++;

        bool explained;
        uint256 gap;
        for (uint256 g = 0; g <= FEE_PRINCIPAL_WINDOW; g++) {
            uint256 x = quoteAmount + g;
            if (
                pf == CurveMath.feeOn(x, PROTOCOL_FEE_BPS)
                    && cf == (zeroCreator ? 0 : CurveMath.feeOn(x, CREATOR_FEE_BPS))
            ) {
                explained = true;
                gap = g;
                break;
            }
        }

        if (explained) {
            if (gap > maxFeePrincipalGap) maxFeePrincipalGap = gap;
            return;
        }

        feePartsInconsistent++;

        uint256 combined = CurveMath.feeOn(quoteAmount, COMBINED_FEE_BPS_FOR_MEASUREMENT_ONLY);
        if (zeroCreator) {
            // Creator sifirken mutant "creator payini protokole KATLAMAK"tir.
            if (pf == combined && CurveMath.feeOn(quoteAmount, PROTOCOL_FEE_BPS) != combined) feeWasDividedFromTotal++;
        } else if (
            pf + cf == combined
                && CurveMath.feeOn(quoteAmount, PROTOCOL_FEE_BPS) + CurveMath.feeOn(quoteAmount, CREATOR_FEE_BPS)
                    != combined
        ) {
            feeWasDividedFromTotal++;
        }
    }

    /// @dev YALNIZCA BIR CURVE'UN yatirdiklari sayilir. Aktorlerin dogrudan
    ///      `deposit` cagrilari (saldiri islemi 5) da ayni olayi yayar ve
    ///      ayirt edilmezse ucret kimligi SESSIZCE bozulurdu -- `from` alani
    ///      (`msg.sender`) tam olarak bunu ayirir.
    function _auditDepositLog(Vm.Log memory l) internal {
        depositsObserved++;
        if (l.topics.length < 3) return;

        address recipient = address(uint160(uint256(l.topics[1])));
        address from = address(uint160(uint256(l.topics[2])));

        uint256 plusOne = curveIndexPlusOne[from];
        if (plusOne == 0) return;
        uint256 i = plusOne - 1;

        uint256 amount = abi.decode(l.data, (uint256));
        feesDeposited[i] += amount;

        if (recipient != protocolTreasury && recipient != creatorAt[i]) feeWentToUnknownRecipient++;
    }

    // ---------------------------------------------------------------
    // Silahlanma
    // ---------------------------------------------------------------

    /// @dev UC AKTORUN UCU DE silahlanir, yalnizca islemi yapan degil.
    ///      Gerekcesi olculebilir: bir dis alimin iadesi icinden yapilan
    ///      `claim(baskaAktor)` cagrisi O AKTORUN `receive()`ini calistirir --
    ///      yani kontrolu alan aktor, dis cagriyi yapan aktor OLMAK ZORUNDA
    ///      DEGILDIR. Yalnizca cagirani silahlandiran bir kurgu bu zinciri
    ///      HIC gormezdi.
    /// @dev `depth == 0` KONTROL GRUBUDUR: aktor kodlu bir alici olarak kalir,
    ///      `receive()`i calisir ve `entered` sayaci artar, ama hicbir ic cagri
    ///      YAPILMAZ. `entered > 0` ile `attempted > 0` boylece BAGIMSIZ olarak
    ///      olculur.
    function _arm(uint256 who, uint256 plan, uint256 depth) internal returns (address actor) {
        actor = _actor(who);
        _armAll(plan, depth);
    }

    function _armActor(address actor, uint256 plan, uint256 depth) internal {
        actor;
        _armAll(plan, depth);
    }

    function _armAll(uint256 plan, uint256 depth) internal {
        uint8 d = uint8(_bound(depth, 0, 3));
        actorAt[0].arm(plan, d);
        actorAt[1].arm(plan >> 3, d);
        actorAt[2].arm(plan >> 7, d);
    }

    /// @dev KAPSAM SAYACLARI KORUMALARDAN ONCE, EYLEMIN ILK SATIRINDA ARTAR.
    ///      Gerekcesi olculmus bir kural: `afterInvariant()`a yalnizca YAPISAL
    ///      OLARAK GARANTI sayaclar konabilir. Korumalardan sonra artan bir
    ///      sayac garanti degildir -- curve tamamlanmissa eylem erken doner --
    ///      ve `BondingCurveInvariants.t.sol` bu deponun tam olarak bu hatayi
    ///      (`sellsMeasuredForFees > 0`) bir kez yapip geri aldigini kaydediyor.
    function _noteSelection(uint256 who, uint256 depth) internal {
        if (_actor(who) == eoa) codelessActorCalls++;
        else codedActorCalls++;
        if (_bound(depth, 0, 3) == 0) disarmedCalls++;
        else armedCalls++;
    }

    function _disarm() internal {
        actorAt[0].disarm();
        actorAt[1].disarm();
        actorAt[2].disarm();
    }

    // ---------------------------------------------------------------
    // Cagri yardimcilari
    // ---------------------------------------------------------------

    function _callBuyExactOut(address actor, uint256 i, uint256 tokensOut, uint256 value)
        internal
        returns (bool, bytes memory)
    {
        if (actor == eoa) {
            if (eoa.balance < value) return (true, "");
            vm.prank(eoa);
            try curveAt[i].buyExactTokensOut{value: value}(tokensOut, type(uint256).max) {
                return (true, "");
            } catch (bytes memory err) {
                return (false, err);
            }
        }
        if (address(this).balance < value) return (true, "");
        try ReentrantActor(payable(actor)).doBuyExactOut{value: value}(i, tokensOut, type(uint256).max) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    function _callBuyQuoteIn(address actor, uint256 i, uint256 value) internal returns (bool, bytes memory) {
        if (actor == eoa) {
            if (eoa.balance < value) return (true, "");
            vm.prank(eoa);
            try curveAt[i].buyExactQuoteIn{value: value}(0) {
                return (true, "");
            } catch (bytes memory err) {
                return (false, err);
            }
        }
        if (address(this).balance < value) return (true, "");
        try ReentrantActor(payable(actor)).doBuyQuoteIn{value: value}(i, 0) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    function _callSell(address actor, uint256 i, uint256 tokensIn) internal returns (bool, bytes memory) {
        if (actor == eoa) {
            vm.prank(eoa);
            try curveAt[i].sellExactTokensIn(tokensIn, 0) {
                return (true, "");
            } catch (bytes memory err) {
                return (false, err);
            }
        }
        try ReentrantActor(payable(actor)).doSell(i, tokensIn, 0) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    function _callGraduate(ReentrantActor target, uint256 i) internal returns (bool, bytes memory) {
        try target.doGraduate(i) returns (uint256, uint256) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    // ---------------------------------------------------------------
    // Kucuk yardimcilar
    // ---------------------------------------------------------------

    function _quoteExactOut(uint256 i, uint256 tokensOut)
        internal
        view
        returns (uint256 curveIn, uint256 pf, uint256 cf)
    {
        BondingCurve c = curveAt[i];
        curveIn = CurveMath.quoteBuyCost(tokensOut, c.virtualQuoteReserves(), c.virtualTokenReserves());
        pf = CurveMath.feeOn(curveIn, PROTOCOL_FEE_BPS);
        cf = creatorAt[i] == address(0) ? 0 : CurveMath.feeOn(curveIn, CREATOR_FEE_BPS);
    }

    function _curveIndex(uint256 ci) internal pure returns (uint256) {
        return ci % N_CURVES;
    }

    /// @dev 0..2 KODLU aktor, 3 KODSUZ EOA. Kodsuz aktor kontrol grubudur:
    ///      onun uzerinden yapilan hicbir islem geri girmez, yani dunyanin
    ///      yalnizca saldiri altinda ayakta durmadigi da olculur.
    function _actor(uint256 who) internal view returns (address) {
        uint256 k = who % 4;
        return k == 3 ? eoa : address(actorAt[k]);
    }

    /// @notice Escrow eylemlerinin alici kumesi -- KAPALI.
    function _payee(uint256 k) internal view returns (address) {
        uint256 j = k % 5;
        if (j == 0) return protocolTreasury;
        if (j == 1) return address(actorAt[0]);
        if (j == 2) return address(actorAt[1]);
        if (j == 3) return address(actorAt[2]);
        return eoa;
    }

    function _selectorOf(bytes memory err) internal pure returns (bytes4) {
        if (err.length < 4) return bytes4(0);
        return bytes4(err[0]) | (bytes4(err[1]) >> 8) | (bytes4(err[2]) >> 16) | (bytes4(err[3]) >> 24);
    }

    // ---------------------------------------------------------------
    // Invariant dosyasinin okudugu yuzey
    // ---------------------------------------------------------------

    function curveCount() external pure returns (uint256) {
        return N_CURVES;
    }

    function reentryEntered(uint8 p) external view returns (uint256) {
        return log.entered(p);
    }

    function reentryAttempted(uint8 p) external view returns (uint256) {
        return log.attempted(p);
    }

    function reentrySucceeded(uint8 p) external view returns (uint256) {
        return log.succeeded(p);
    }

    function pointCount() external pure returns (uint8) {
        return P_COUNT;
    }
}
