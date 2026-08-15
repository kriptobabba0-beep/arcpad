// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {LAUNCH_TOKEN_TOTAL_SUPPLY} from "../../src/LaunchToken.sol";

// ---------------------------------------------------------------
// YENIDEN GIRIS NOKTALARI -- kaynaktan SAYILARAK cikarildi
// ---------------------------------------------------------------
//
// `contracts/src/*.sol` icindeki HER dis cagri yeri okundu. Disaridan secilen
// bir adrese kontrolu veren -- yani yeniden girilebilen -- YEDI nokta var;
// asagidaki yedi sabit onlardir ve numaralar rapordaki tabloyla AYNIDIR.
//
// Dort nokta daha vardir ve onlar STATICCALL'dur (`bind`in iki okumasi,
// `protocolTreasury()`, `graduationTarget()`): yeniden girisi kapatan sey
// `view`dir ve o dort nokta BU DOSYADA DEGIL, `BondingCurve.t.sol` icinde
// yazim sayaci + kontrol grubu ile olculur (R-5). Sebep yapisaldir: STATICCALL
// cercevesinde bir kontrat KENDI denemesini bile sayamaz, yani buradaki
// sayac mekanizmasi orada calismaz.
uint8 constant P_BUY_TOKEN_TRANSFER = 1;
uint8 constant P_BUY_REFUND = 2;
uint8 constant P_SELL_TOKEN_TRANSFER_FROM = 3;
uint8 constant P_SELL_PAYOUT = 4;
uint8 constant P_GRADUATION_TOKEN_TRANSFER = 5;
uint8 constant P_GRADUATION_PAYOUT = 6;
uint8 constant P_ESCROW_CLAIM = 7;
/// @dev 0 KULLANILMAZ ("bilinmeyen cerceve"), dolayisiyla dizi boyu 8.
uint8 constant P_COUNT = 8;

/// @dev Geri cagri icinden denenebilecek islem sayisi. Liste
///      `ReentrantActor._attack` icinde.
uint8 constant OP_COUNT = 12;

/// @title ReentryLog
/// @notice Butun aktorlerin ORTAK sayac defteri.
///
/// @dev AYRI BIR KONTRAT OLMASI TASIYICIDIR, uslup degil. Sayaclar aktorun
///      kendi depolamasinda dursaydi, `graduate()`in odemesi icinden bir
///      SATIS denenip o satis basarisiz oldugunda revert AKTORUN sayacini da
///      geri alirdi -- yani "denendi" bilgisi tam olarak denemenin
///      basarisiz oldugu durumlarda kaybolurdu. Burada da ayni geri alma
///      olur (ayni islem), ama defter DIS cerceveden de yazilabilir oldugu
///      icin handler basarisiz bir dis cagriyi kendi cercevesinde sayabilir.
///
/// @dev SAYACLARIN HICBIRI GUVENLIK IDDIASI DEGILDIR. Hepsi ULASILABILIRLIK
///      olcumudur: bu projenin dorduncu adi konmus hata sinifi "erisimi
///      olculmeyip varsayilan bir ozellik testi"dir, ve bir yeniden giris
///      kampanyasinda o hata "saldiri yolu hic yurunmedi" seklinde ortaya
///      cikar. `ReentrancyInvariants.t.sol` bu sayaclara TABAN koyar.
contract ReentryLog {
    uint256[P_COUNT] private _entered;
    uint256[P_COUNT] private _attempted;
    uint256[P_COUNT] private _succeeded;
    uint256[OP_COUNT] private _opAttempted;
    uint256[OP_COUNT] private _opSucceeded;

    /// @notice Ulasilan en derin ic seviye. 1 = tek seviyeli geri giris.
    uint256 public maxDepthReached;

    /// @notice Geri cagri icinden BASARIYLA calisan `launch` sayisi.
    /// @dev Ust sinirli (bkz. `ReentrantActor._attack`); sinir olculur ve
    ///      raporlanir.
    uint256 public launchesFromCallback;

    /// @notice Curve'un ODEMESI icinden yapilan ic cagrida curve'un o anki
    ///         defteri okundu ve BAYAT bulundu. Sifir olmasi gerekir.
    /// @dev Bu tek "guvenlik" sayacidir ve gerekcesi su: kati CEI'nin iddiasi
    ///      "reentrant bir cagri asla BAYAT rezerv goremez"dir. Aktor, ic
    ///      cagriyi yapmadan ONCE curve'un rezervlerini okur ve dis cagrinin
    ///      kendisine gecirdigi "olmasi gereken" degerle karsilastirir.
    uint256 public staleLedgerObserved;

    function entered(uint8 p) external view returns (uint256) {
        return _entered[p];
    }

    function attempted(uint8 p) external view returns (uint256) {
        return _attempted[p];
    }

    function succeeded(uint8 p) external view returns (uint256) {
        return _succeeded[p];
    }

    function opAttempted(uint8 op) external view returns (uint256) {
        return _opAttempted[op];
    }

    function opSucceeded(uint8 op) external view returns (uint256) {
        return _opSucceeded[op];
    }

    function noteEnter(uint8 p) external {
        _entered[p] += 1;
    }

    function noteAttempt(uint8 p, uint8 op, bool ok, uint256 depth) external {
        _attempted[p] += 1;
        _opAttempted[op] += 1;
        if (ok) {
            _succeeded[p] += 1;
            _opSucceeded[op] += 1;
        }
        if (depth > maxDepthReached) maxDepthReached = depth;
    }

    function noteLaunch() external {
        launchesFromCallback += 1;
    }

    function noteStaleLedger() external {
        staleLedgerObserved += 1;
    }
}

/// @title ReentrantActor
/// @notice YEDI noktanin HEPSINDEN geri girebilen aktor.
///
/// @dev MEVCUT `CurveTradingHandler.ReentrantTrader`DAN FARKI, ve niye
///      genisletme degil AYRI bir aktor: o aktor yalnizca `receive()`ten
///      (yani iade ve satis odemesi), TEK bir curve'e, IKI sabit islemle
///      (alim/satis) ve TEK seviye derinlikte geri girer. Buradaki aktor
///        - yedi noktanin hepsinden girer (uc token transferi dahil),
///        - DORT curve'un HERHANGI birine, escrow'a ve factory'ye gider,
///          yani CAPRAZ-CURVE penceresi (`graduate()` NatSpec'i (a))
///          otomatik olarak taranir,
///        - ON IKI islemden fuzzer'in sectigini yapar,
///        - fuzzer'in sectigi derinlige kadar KENDI kendini besler.
///
/// @dev IC CAGRI DUZ `.call` ILE YAPILIR VE BASARISIZLIGI YUKARI TASINMAZ.
///      Gerekce `CurveTradingHandler`inkiyle aynidir ve orada olculmustur:
///      bir revert dis islemi de dusurseydi `fail_on_revert = false` onu
///      sessizce yutar ve saldiri HIC GOZLENEMEZ olurdu.
///
/// @dev CERCEVE ATFI (`ctx`) TAHMIN DEGIL, CAGRIYI YAPANIN KENDI KAYDI.
///      `receive()` yalnizca `msg.sender`e bakarak alim iadesini satis
///      odemesinden AYIRAMAZ -- ikisi de curve'den gelir. Bu yuzden DISARI
///      DOGRU her cagriyi yapan cerceve, cagridan hemen once `ctx`i yazar ve
///      sonra eski degerine dondurur. Ic cagrilar da ayni disiplini uygular,
///      yani bir alimin iadesi icinden yapilan satisin odemesi P4 olarak
///      dogru sayilir. Escrow'dan gelen deger tek anlamlidir (`claim`in tek
///      transferi) ve `ctx`e hic bakilmadan P7 sayilir.
contract ReentrantActor {
    ReentryLog public immutable log;

    FeeEscrow public escrow;
    LaunchFactory public factory;
    BondingCurve[] public curves;
    IERC20[] public tokens;
    /// @notice Escrow islemlerinin kullanabilecegi alici kumesi. KAPALI
    ///         tutulur: korunum iddiasi ancak native'in bilinen bir kumeden
    ///         disari cikamamasiyla anlamlidir.
    address[] public payees;
    uint256 public maxQuotePerCall;

    bool public armed;
    bool public initialized;

    uint256 internal planSeed;
    uint8 internal maxDepth;
    uint8 internal level;
    uint8 internal ctx;

    constructor(ReentryLog log_) {
        log = log_;
    }

    function init(
        FeeEscrow escrow_,
        LaunchFactory factory_,
        BondingCurve[] memory curves_,
        IERC20[] memory tokens_,
        address[] memory payees_,
        uint256 maxQuotePerCall_
    ) external {
        require(!initialized, "init once");
        initialized = true;
        escrow = escrow_;
        factory = factory_;
        maxQuotePerCall = maxQuotePerCall_;
        for (uint256 i = 0; i < curves_.length; i++) {
            curves.push(curves_[i]);
            tokens.push(tokens_[i]);
            tokens_[i].approve(address(curves_[i]), type(uint256).max);
        }
        for (uint256 i = 0; i < payees_.length; i++) {
            payees.push(payees_[i]);
        }
    }

    // ---------------------------------------------------------------
    // Silahlanma
    // ---------------------------------------------------------------

    /// @notice Aktoru silahlandirir. `maxDepth_ == 0` KONTROL GRUBUDUR:
    ///         aktor kodlu bir alici olarak kalir ama hicbir yerden geri
    ///         girmez.
    function arm(uint256 planSeed_, uint8 maxDepth_) external {
        armed = true;
        planSeed = planSeed_;
        maxDepth = maxDepth_;
    }

    function disarm() external {
        armed = false;
        maxDepth = 0;
    }

    function currentDepth() external view returns (uint8) {
        return level;
    }

    // ---------------------------------------------------------------
    // DIS islemler -- handler bunlari cagirir
    // ---------------------------------------------------------------

    function doBuyExactOut(uint256 i, uint256 tokensOut, uint256 maxIn) external payable {
        uint8 prev = ctx;
        ctx = P_BUY_REFUND;
        curves[i].buyExactTokensOut{value: msg.value}(tokensOut, maxIn);
        ctx = prev;
    }

    function doBuyQuoteIn(uint256 i, uint256 minOut) external payable {
        uint8 prev = ctx;
        ctx = P_BUY_REFUND;
        curves[i].buyExactQuoteIn{value: msg.value}(minOut);
        ctx = prev;
    }

    function doSell(uint256 i, uint256 tokensIn, uint256 minOut) external {
        uint8 prev = ctx;
        ctx = P_SELL_PAYOUT;
        curves[i].sellExactTokensIn(tokensIn, minOut);
        ctx = prev;
    }

    function doGraduate(uint256 i) external returns (uint256 base, uint256 quote) {
        uint8 prev = ctx;
        ctx = P_GRADUATION_PAYOUT;
        (base, quote) = curves[i].graduate();
        ctx = prev;
    }

    function doClaim(address recipient) external {
        uint8 prev = ctx;
        ctx = P_ESCROW_CLAIM;
        escrow.claim(recipient);
        ctx = prev;
    }

    // ---------------------------------------------------------------
    // GERI GIRIS -- yedi noktanin hepsi buraya duser
    // ---------------------------------------------------------------

    /// @dev P2 (alim iadesi), P4 (satis odemesi), P6 (graduation odemesi) ve
    ///      P7 (escrow claim) buradan gelir. Ilk uc curve'den, dorduncu
    ///      escrow'dan; `msg.sender == escrow` tek anlamlidir cunku escrow'un
    ///      TEK deger transferi `claim`dedir.
    receive() external payable {
        if (!armed) return;
        uint8 p = msg.sender == address(escrow) ? P_ESCROW_CLAIM : ctx;
        if (p == 0) return;
        _onControl(p);
    }

    /// @dev P1 (alimin token transferi), P3 (satisin `transferFrom`u) ve P5
    ///      (graduation'in token transferi) buradan gelir. Cagiran dusman
    ///      token'dir ve nokta numarasini KENDISI bilir: hangi curve
    ///      fonksiyonunun icinde oldugunu `graduated()` ile ayirir.
    function onTokenMove(uint8 p) external {
        if (!armed) return;
        if (p == 0 || p >= P_COUNT) return;
        _onControl(p);
    }

    function _onControl(uint8 p) internal {
        log.noteEnter(p);
        _checkSolvencyMidFlight();
        if (level >= maxDepth) return;

        level += 1;
        uint8 d = level;
        _attack(p, uint256(keccak256(abi.encode(planSeed, p, d, address(this)))), d);
        level -= 1;
    }

    /// @notice ISLEMIN ORTASINDA odeme gucu kontrolu.
    ///
    /// @dev BU, YENIDEN GIRISIN OLCUM ARACI OLARAK KULLANILDIGI YERDIR.
    ///      `ReentrancyInvariants.t.sol`in odeme gucu iddiasi HANDLER
    ///      CAGRILARI ARASINDA calisir, yani islemin ICINDEKI ara durumlari
    ///      HIC GORMEZ. Buradaki kontrol o kor noktayi kapatir: aktor kontrolu
    ///      aldigi ANDA her curve icin `bakiye >= realQuoteReserves` olmak
    ///      zorundadir.
    ///
    /// @dev BU IDDIA KATI CEI'NIN DOGRUDAN SONUCUDUR VE INVERSIYONU GORUR.
    ///      Ornek, satis yolu: dogru sirada defter (`realQuoteReserves -=
    ///      proceeds`) odemeden ONCE yazilir, dolayisiyla odeme aninda bakiye
    ///      `B - proceeds`, defter de `R - proceeds`tir ve esitlik korunur.
    ///      Sira ters cevrilirse defter HALA `R` iken bakiye `B - proceeds`
    ///      olur ve `bakiye >= defter` DUSER -- mutasyon testinde olculdu.
    ///
    /// @dev MEZUN CURVE ATLANIR VE ATLANMASI ZORUNLU: `graduate()` `R`yi
    ///      bakiyeden cikarir ama `realQuoteReserves`i BILEREK sifirlamaz
    ///      (tasarim 7.2 madde 7), yani mezun bir curve'de `0 >= R` kalici
    ///      olarak YANLISTIR ve atlanmazsa sayac saldiriyla ilgisi olmayan bir
    ///      sebeple dolardi.
    function _checkSolvencyMidFlight() internal {
        for (uint256 k = 0; k < curves.length; k++) {
            BondingCurve c = curves[k];
            if (c.graduated()) continue;
            if (address(c).balance < c.realQuoteReserves()) log.noteStaleLedger();
        }
    }

    // ---------------------------------------------------------------
    // Saldiri: fuzzer'in sectigi hedef, giris noktasi ve arguman
    // ---------------------------------------------------------------

    /// @dev ON IKI ISLEM. Liste bilerek "curve'un alim/satimi"ndan genis:
    ///      escrow ve factory de saldirinin hedefidir, cunku iddia
    ///      `BondingCurve`in degil PAKETIN CEI'sidir.
    ///        0  buyExactTokensOut   1  buyExactQuoteIn   2  sellExactTokensIn
    ///        3  graduate            4  claim             5  deposit
    ///        6  launch              7  bind              8  isCanonical
    ///        9  proposeGraduationTarget  10 applyGraduationTarget
    ///        11 token.transfer
    ///      Hedef curve fuzzer'in sectigi INDEKSTIR, yani dis cagrinin
    ///      curve'u ile ayni olabilir de olmayabilir de -- `graduate()`in
    ///      NatSpec'inde "ulasilabilir" diye kaydedilen CAPRAZ-CURVE
    ///      penceresi (a) boylece SECILEREK degil TARANARAK bulunur.
    function _attack(uint8 p, uint256 s, uint8 d) internal {
        uint8 op = uint8(s % OP_COUNT);
        uint256 i = (s >> 8) % curves.length;
        uint256 j = (s >> 24) % payees.length;
        uint256 amt = s >> 40;

        uint8 prev = ctx;
        bool ok;

        if (op == 0) {
            uint256 reserve = curves[i].realTokenReserves();
            uint256 tokensOut = reserve == 0 ? 1 : (amt % reserve) + 1;
            ctx = P_BUY_REFUND;
            (ok,) = address(curves[i]).call{value: _budget(amt, true)}(
                abi.encodeWithSelector(BondingCurve.buyExactTokensOut.selector, tokensOut, type(uint256).max)
            );
        } else if (op == 1) {
            ctx = P_BUY_REFUND;
            (ok,) = address(curves[i]).call{value: _budget(amt, false)}(
                abi.encodeWithSelector(BondingCurve.buyExactQuoteIn.selector, uint256(0))
            );
        } else if (op == 2) {
            uint256 bal = tokens[i].balanceOf(address(this));
            uint256 tokensIn = bal == 0 ? 1 : (amt % bal) + 1;
            ctx = P_SELL_PAYOUT;
            (ok,) = address(curves[i])
                .call(abi.encodeWithSelector(BondingCurve.sellExactTokensIn.selector, tokensIn, uint256(0)));
        } else if (op == 3) {
            ctx = P_GRADUATION_PAYOUT;
            (ok,) = address(curves[i]).call(abi.encodeWithSelector(BondingCurve.graduate.selector));
        } else if (op == 4) {
            ctx = P_ESCROW_CLAIM;
            (ok,) = address(escrow).call(abi.encodeWithSelector(FeeEscrow.claim.selector, payees[j]));
        } else if (op == 5) {
            uint256 v = _depositValue(amt);
            if (v != 0) {
                (ok,) = address(escrow).call{value: v}(abi.encodeWithSelector(FeeEscrow.deposit.selector, payees[j]));
            }
        } else if (op == 6) {
            // UST SINIRLI VE BU KAYDA GECIRILIYOR: her `launch` iki kontrat
            // deploy eder (~3M gaz). Sinirsiz birakildiginda kampanya
            // saatlere cikar. Sinir ULASILABILIRLIGI degil TEKRARI keser --
            // rapordaki sayac noktanin fiilen yurundugunu gosterir.
            if (log.launchesFromCallback() < 32) {
                (ok,) = address(factory)
                    .call(abi.encodeWithSelector(LaunchFactory.launch.selector, "reentrant", "RE", "ipfs://reentrant"));
                if (ok) log.noteLaunch();
            }
        } else if (op == 7) {
            (ok,) = address(curves[i]).call(abi.encodeWithSelector(BondingCurve.bind.selector, address(tokens[i])));
        } else if (op == 8) {
            (ok,) =
                address(factory).call(abi.encodeWithSelector(LaunchFactory.isCanonical.selector, address(tokens[i])));
        } else if (op == 9) {
            (ok,) = address(factory)
                .call(abi.encodeWithSelector(LaunchFactory.proposeGraduationTarget.selector, address(this)));
        } else if (op == 10) {
            (ok,) = address(factory).call(abi.encodeWithSelector(LaunchFactory.applyGraduationTarget.selector));
        } else {
            uint256 bal = tokens[i].balanceOf(address(this));
            if (bal != 0) {
                (ok,) = address(tokens[i])
                    .call(abi.encodeWithSelector(IERC20.transfer.selector, payees[j], (amt % bal) + 1));
            }
        }

        ctx = prev;
        log.noteAttempt(p, op, ok, d);
    }

    /// @dev Ic alimin butcesi. Bakiyeyi asamaz; asarsa `OutOfFunds` ile duser
    ///      ve olculen sey saldiri degil AKTORUN FONLANMASI olur.
    function _budget(uint256 amt, bool exactOut) internal view returns (uint256) {
        uint256 bal = address(this).balance;
        if (bal == 0) return 0;
        // Tam-cikis yolunda BOL ODENIR: iade yolu (P2) ancak fazladan
        // odendiginde yurunur ve `maxQuoteIn` zaten `type(uint256).max`tir.
        uint256 want = exactOut ? maxQuotePerCall * 4 : (amt % maxQuotePerCall) + 4;
        return want > bal / 2 ? bal / 2 : want;
    }

    function _depositValue(uint256 amt) internal view returns (uint256) {
        uint256 bal = address(this).balance;
        if (bal == 0) return 0;
        uint256 v = (amt % 1e15) + 1;
        return v > bal ? bal : v;
    }
}

/// @title HostileToken
/// @notice Curve'un token bacagindan geri giren ERC-20.
///
/// @dev NICIN GEREKLI: `LaunchToken` OZ'un ERC20'sidir ve `transfer` hicbir
///      geri cagri yapmaz, dolayisiyla P1/P3/P5 -- alim yerlesiminin token
///      transferi, satisin `transferFrom`u ve graduation'in token transferi --
///      URUN YOLUNDA ULASILAMAZ. `bind`in NatSpec'i bunu zaten yaziyor:
///      koruma bir YAPILANDIRMA kontroludur, mulkiyet kaniti degil, ve
///      dogrudan deploy edilmis bir curve'e boyle bir token BAGLANABILIR.
///      Bu kontrat o senaryodur.
///
/// @dev DEFTERI DOGRUDUR ve bu bilincli: amac "bozuk ERC20"yu degil KATI
///      CEI'yi sinamaktir. Arz sabit, bakiyeler tutarli, `transfer` her zaman
///      `true` doner. Tek sapmasi, curve'un YAPTIGI transferlerde karsi tarafa
///      kontrol vermesidir (ERC-777'nin `tokensReceived` kancasinin sekli).
///
/// @dev KANCA YALNIZCA CURVE'UN CAGRILARINDA ATES EDER (`msg.sender == curve`).
///      Aktorler birbirine token yollarken atesleseydi, sayaclar curve'un
///      cagri yerleriyle ILGISI OLMAYAN cerceveleri P1/P5 diye sayardi ve
///      "hangi noktaya ulasildi" olcumu sessizce sisirdi.
contract HostileToken {
    string public constant name = "hostile";
    string public constant symbol = "HOST";
    uint8 public constant decimals = 18;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice `ICurveBoundToken.curve()` -- `bind`in geri-isaret kontrolu.
    address public curve;
    bool public hookEnabled;

    constructor(address curve_) {
        curve = curve_;
        totalSupply = LAUNCH_TOKEN_TOTAL_SUPPLY;
        balanceOf[curve_] = LAUNCH_TOKEN_TOTAL_SUPPLY;
        emit Transfer(address(0), curve_, LAUNCH_TOKEN_TOTAL_SUPPLY);
    }

    /// @dev `bind` SIRASINDA KAPALIDIR. `bind`in iki okumasi da STATICCALL'dur
    ///      ve kanca oradan atesleseydi ic cagri revert eder, `bind` duser ve
    ///      KURULUM basarisiz olurdu -- yani olculen sey saldiri degil
    ///      kurulum hatasi olurdu. S1/S2'nin `view` ile kapali oldugu
    ///      `BondingCurve.t.sol` icinde ayri ve DETERMINISTIK olarak
    ///      olculuyor.
    function enableHook() external {
        hookEnabled = true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        if (hookEnabled && msg.sender == curve) {
            // Graduation'in token bacagi ile alim yerlesiminin token bacagi
            // AYNI satir degildir ama AYNI selector'dur. Ayirt eden sey
            // `graduated`tir: `graduate()` bayragi dis cagrilardan ONCE yazar,
            // `_settleBuy` ise mezun olmamis bir curve'de calisir.
            _hook(to, BondingCurve(curve).graduated() ? P_GRADUATION_TOKEN_TRANSFER : P_BUY_TOKEN_TRANSFER);
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "allowance");
            allowance[from][msg.sender] = a - value;
        }
        _move(from, to, value);
        if (hookEnabled && msg.sender == curve) _hook(from, P_SELL_TOKEN_TRANSFER_FROM);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    /// @dev Kancanin basarisizligi YUKARI TASINMAZ: tasinsaydi ic cagrinin
    ///      revert'i curve'un islemini de dusururdu ve saldiri gozlenemez
    ///      olurdu (aktorun ic cagrisiyla ayni gerekce).
    function _hook(address who, uint8 point) internal {
        if (who.code.length == 0) return;
        (bool ok,) = who.call(abi.encodeWithSelector(ReentrantActor.onTokenMove.selector, point));
        ok;
    }
}

/// @title DirectCurveFactory
/// @notice Dusman token'a bagli curve'u URUNDEKI factory OLMADAN kurar.
///
/// @dev NICIN AYRI BIR KONTRAT: `BondingCurve`in `factory`si onu deploy eden
///      adrestir ve `bind`i yalnizca o cagirabilir. Ayrica curve `factory`den
///      `protocolTreasury()` ve `graduationTarget()` okur, yani deploy eden
///      sey bu iki `view` uyeyi TASIMAK ZORUNDADIR. Handler'in kendisini
///      factory yapmak da mumkundu; ayri tutuldu cunku handler'in yuzeyi
///      fuzzer'in hedefidir ve oraya konan her `public` uye fuzzer'in
///      cagirabilecegi bir eylem haline gelir.
contract DirectCurveFactory {
    address public immutable graduationTarget;
    address public immutable protocolTreasury;
    BondingCurve public immutable curve;
    HostileToken public immutable token;

    constructor(
        address escrow_,
        address treasury_,
        address target_,
        address creator_,
        uint256 virtualTokenReserves_,
        uint256 virtualQuoteReserves_,
        uint256 saleSupply_
    ) {
        protocolTreasury = treasury_;
        graduationTarget = target_;

        BondingCurve c = new BondingCurve(creator_, escrow_, virtualTokenReserves_, virtualQuoteReserves_, saleSupply_);
        HostileToken t = new HostileToken(address(c));
        c.bind(address(t));
        t.enableHook();

        curve = c;
        token = t;
    }

    /**
     * @dev BUYBACK KAPALI TASLAGI.
     *
     *      `BondingCurve` her ucret dagitiminda fabrikasina bu soruyu sorar ve
     *      fabrika, egriyi deploy eden kontrattir -- yani bu test kontrati.
     *      Sifir hazine "kapali" demektir, dolayisiyla bu dosyalardaki her
     *      olcum buyback ONCESI davranisi olcmeye devam eder. Buyback'in
     *      kendi testleri ayri dosyalardadir.
     */
    function buybackPolicy(address) external pure returns (address, uint256) {
        return (address(0), 0);
    }
}
