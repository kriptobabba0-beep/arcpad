// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {BuybackVestingVault} from "./BuybackVestingVault.sol";

interface ITreasuryFactoryView {
    function protocolTreasury() external view returns (address);
    /// @notice Mezuniyet sonrasi ucret kesen hook. Governor tarafindan BIR KEZ yazilir.
    function graduationHook() external view returns (address);
    /// @notice Anahtarci; supurmeyi tetikleyen operator.
    function buybackKeeper() external view returns (address);
}

interface ICurveView {
    function token() external view returns (address);
    function creator() external view returns (address);
    function complete() external view returns (bool);
    function graduated() external view returns (bool);
    function virtualQuoteReserves() external view returns (uint256);
    function virtualTokenReserves() external view returns (uint256);
    function realTokenReserves() external view returns (uint256);
    function buyExactQuoteIn(uint256 minTokensOut) external payable;
}

interface ILaunchTokenView {
    function curve() external view returns (address);
}

/**
 * @title BuybackTreasury
 * @notice Creator'in ucret gelirinden AYRILAN quote'u token basina biriktirir,
 *         guvenli oldugunda piyasadan gercek alim yapar ve alinani kasaya
 *         kilitler. Guvenli degilse parayi CREATOR'A geri katlar.
 *
 * @dev ============ ISARETLEME TAHAKKUKTA, SUPURMEDE DEGIL ============
 *
 *      Referans uygulama ucretleri egride biriktirir ve periyodik olarak
 *      supururken bolusturur; bu, "supurmeden hemen once ayari degistir"
 *      yarisini dogurur ve onun icin ayri bir `pendingBuybackQuote` alani
 *      tutmak ZORUNDADIR.
 *
 *      Bizde o yaris YAPISAL OLARAK YOKTUR: `BondingCurve` ucreti HER ISLEMDE
 *      aninda dagitir. Dolayisiyla buyback payi da ISLEM ANINDA ayrilir ve bu
 *      kontrata yatirilir. Bir launch buyback'i kapatirsa, kapatmadan ONCE
 *      birikmis olan pay burada durmaya devam eder ve buyback olarak harcanir
 *      -- cunku o ucretler o politika altinda kazanildi. Ayni sekilde kapaliyken
 *      biriken ucret sonradan acilmakla buyback'e donusemez: hic yatirilmamistir.
 *
 * @dev ============ MUHASEBE `balanceOf` ILE YAPILMAZ ============
 *
 *      `pendingQuote` ACIK olarak izlenir. Biri kontrata dogrudan native
 *      gonderirse (zorla transfer, `selfdestruct` artigi) o para HICBIR
 *      tokenin butcesine yazilmaz ve hicbir supurmeyi buyutmez. Aksi halde
 *      "bagis yap, sonra fiyat etkisi sinirini asir" gibi bir manipulasyon
 *      yuzeyi acilirdi.
 */
contract BuybackTreasury {
    using SafeERC20 for IERC20;

    /// @notice Tek supurmede izin verilen azami FIYAT ETKISI: %3.
    /// @dev Referans uygulamanin degeriyle ayni buyuklukte secildi. Sabittir:
    ///      ayarlanabilir olsaydi, yonetisim bir supurmeden hemen once siniri
    ///      genisletip creator'in parasini kotu bir fiyata harcatabilirdi.
    uint256 public constant MAX_PRICE_IMPACT_BPS = 300;

    /// @notice Altinda supurmenin gaz acisindan anlamsiz oldugu esik.
    /// @dev 0,05 USDC. Bunun ALTINDA kalan para KILITLENMEZ: `SWEEP_GRACE`
    ///      dolduktan sonra herkes `sweep` cagirabilir ve para creator'a geri
    ///      katlanir. Yani esik bir hapishane degil, bir erteleme.
    uint256 public constant MIN_SWEEP_WEI = 0.05e18;

    /// @notice Anahtarci sessiz kalirsa supurme IZINSIZ hale gelir.
    /// @dev Fonlarin kalici olarak erisilemez kalmasini engeller (spec §29).
    uint256 public constant SWEEP_GRACE = 7 days;

    uint256 private constant BPS = 10_000;

    address public immutable factory;
    address public immutable escrow;
    BuybackVestingVault public immutable vault;

    /// @notice Token basina harcanmayi bekleyen quote (native wei).
    mapping(address token => uint256) public pendingQuote;
    /// @notice Son supurme ani; `SWEEP_GRACE` bunun uzerine biner.
    mapping(address token => uint256) public lastSweepAt;
    /// @notice Kumulatif olcumler -- indexer ve arayuz icin.
    mapping(address token => uint256) public cumulativeQuoteSpent;
    mapping(address token => uint256) public cumulativeTokensBought;

    error ZeroAddress();
    error NotAccrualVenue();
    error NotKeeper();
    error NothingPending();
    error DeadlinePassed();

    event BuybackAccrued(address indexed token, address indexed venue, uint256 quoteAmount, uint256 pending);
    event BuybackExecuted(address indexed token, uint256 quoteSpent, uint256 tokensBought);
    event BuybackSkipped(address indexed token, uint256 quoteReturnedToCreator, string reason);

    constructor(address factory_, address escrow_, BuybackVestingVault vault_) {
        if (factory_ == address(0) || escrow_ == address(0) || address(vault_) == address(0)) {
            revert ZeroAddress();
        }
        factory = factory_;
        escrow = escrow_;
        vault = vault_;
    }

    // ------------------------------------------------------------------
    // Tahakkuk
    // ------------------------------------------------------------------

    /**
     * @notice Bir islemin buyback payini yatirir.
     *
     * @dev YALNIZCA IKI YER cagirabilir ve ikisi de KANITLANIR:
     *        - tokenin KENDI egrisi (`token.curve() == msg.sender`),
     *        - fabrikanin kaydettigi mezuniyet hook'u.
     *      Boylece bir sahtekar baska bir tokenin butcesini sisiremez.
     */
    function accrue(address token) external payable {
        if (msg.value == 0) return;
        address curve = ILaunchTokenView(token).curve();
        if (msg.sender != curve && msg.sender != ITreasuryFactoryView(factory).graduationHook()) {
            revert NotAccrualVenue();
        }
        uint256 next = pendingQuote[token] + msg.value;
        pendingQuote[token] = next;
        /*
         * ANAHTARCI SAATINI ILK PARAYLA BASLAT.
         *
         * `lastSweepAt` sifirken `_assertSweeper`in ikinci dali her zaman
         * dogrudur (`now > 0 + 7 gun`), yani HIC SUPURULMEMIS bir token
         * ANINDA izinsiz supurulebilirdi -- ve bu, butcenin en buyuk oldugu
         * andir. Testte yakalandi. Saat parayi ilk gorunce baslar; anahtarci
         * yedi gun boyunca tek yetkilidir, sonra kilit acilir.
         */
        if (lastSweepAt[token] == 0) lastSweepAt[token] = block.timestamp;
        emit BuybackAccrued(token, msg.sender, msg.value, next);
    }

    // ------------------------------------------------------------------
    // Supurme
    // ------------------------------------------------------------------

    /**
     * @notice Birikmis butceyi guvenli oldugu kadar harcar; kalani creator'a
     *         geri katlar.
     *
     * @dev ASLA REVERT ETMEZ "piyasa ince" diye. Spec §11: guvenli alim
     *      yapilamiyorsa para creator'a doner -- protokole GITMEZ, kontratta
     *      KALMAZ.
     *
     * @param minTokensOut Anahtarcinin hesapladigi alt sinir. YALNIZCA alim
     *        GERCEKTEN yapilirken uygulanir; atlanan bir buyback bu yuzden
     *        butun dagitimi kilitlemez (spec §12).
     */
    function sweep(address token, uint256 minTokensOut, uint256 deadline) external {
        if (block.timestamp > deadline) revert DeadlinePassed();
        _assertSweeper(token);

        uint256 pending = pendingQuote[token];
        if (pending == 0) revert NothingPending();

        address curve = ILaunchTokenView(token).curve();
        address creator = ICurveView(curve).creator();

        // ETKILER ONCE. Bundan sonraki her sey dis cagridir ve `pending`
        // sifirlandigi icin yeniden giris butceyi ikinci kez harcayamaz.
        pendingQuote[token] = 0;
        lastSweepAt[token] = block.timestamp;

        uint256 spendable = _spendableOnCurve(curve, pending);

        if (spendable < MIN_SWEEP_WEI) {
            _foldBack(token, creator, pending, "below-threshold-or-unsafe");
            return;
        }

        uint256 got = _buyOnCurve(curve, token, spendable, minTokensOut);
        uint256 leftover = pending - spendable;
        if (leftover != 0) _refund(creator, leftover);

        cumulativeQuoteSpent[token] += spendable;
        cumulativeTokensBought[token] += got;
        emit BuybackExecuted(token, spendable, got);

        IERC20(token).forceApprove(address(vault), got);
        vault.lock(token, got, creator);
    }

    /// @dev Anahtarci; ya da sessiz kaldiysa (§29) herkes.
    function _assertSweeper(address token) private view {
        if (msg.sender == ITreasuryFactoryView(factory).buybackKeeper()) return;
        if (block.timestamp > lastSweepAt[token] + SWEEP_GRACE) return;
        revert NotKeeper();
    }

    function _foldBack(address token, address creator, uint256 amount, string memory reason) private {
        _refund(creator, amount);
        emit BuybackSkipped(token, amount, reason);
    }

    /// @dev Creator'a GERI KATLAMA, mevcut ucret defterinden gecer -- boylece
    ///      creator parayi her zamanki `claim` akisiyla alir ve ikinci bir
    ///      cekme yuzeyi acilmaz.
    function _refund(address creator, uint256 amount) private {
        if (amount == 0) return;
        IFeeEscrow(escrow).deposit{value: amount}(creator);
    }

    // ------------------------------------------------------------------
    // Guvenli miktar
    // ------------------------------------------------------------------

    /**
     * @notice Egride, fiyat etkisi sinirini ve satilabilir envanteri asmadan
     *         harcanabilecek azami quote.
     *
     * @dev ============ FIYAT ETKISI, TAM FORMULLE ============
     *
     *      Sabit carpimda `k = vQ * vT` ve fiyat `vQ / vT` oldugundan, `d`
     *      kadar alim sonrasi:
     *
     *          fiyat' / fiyat = (1 + d/vQ)^2
     *
     *      Yani `%p` etki sinirinin TAM karsiligi:
     *
     *          d_max = vQ * ( sqrt(1 + p) - 1 )
     *
     *      Yaygin `d <= vQ * p` yaklasimi bu araligi IKI KATINA cikarir ve ince
     *      bir egride gercek etkiyi sinirin ustune tasir. Karekok tam sayida
     *      alinir ve TABANA yuvarlanir; yani sinir her zaman guvenli tarafta.
     *
     * @dev ============ MEZUNIYET REZERVI (§9) ============
     *
     *      Alim, kullanici alimlariyla AYNI `realTokenReserves` kisitindan
     *      gecer -- ayri bir yol yoktur. Egri tamamlandiysa (`complete`) ya da
     *      mezun olduysa curve alim KABUL ETMEZ, bu yuzden burada sifir doner
     *      ve para creator'a katlanir. Bir buyback mezuniyeti IMKANSIZ
     *      KILAMAZ.
     */
    function _spendableOnCurve(address curve, uint256 pending) private view returns (uint256) {
        if (ICurveView(curve).complete() || ICurveView(curve).graduated()) return 0;
        if (ICurveView(curve).realTokenReserves() == 0) return 0;

        uint256 vQ = ICurveView(curve).virtualQuoteReserves();
        if (vQ == 0) return 0;

        // d_max = vQ * (sqrt(1 + p) - 1),  p = MAX_PRICE_IMPACT_BPS / BPS
        // Tam sayida: sqrt(vQ^2 * (BPS + p_bps) / BPS) - vQ
        uint256 scaled = Math.mulDiv(vQ * vQ, BPS + MAX_PRICE_IMPACT_BPS, BPS);
        uint256 cap = Math.sqrt(scaled);
        cap = cap > vQ ? cap - vQ : 0;

        return pending < cap ? pending : cap;
    }

    /**
     * @dev Egriden GERCEK alim. Alinan miktar bakiye FARKIYLA olculur; egrinin
     *      dondurdugu degere degil, gerceklesen transfere bakilir.
     *
     *      NOT: bu alim da her alim gibi protokol ve creator ucreti oder. Yani
     *      buyback'in kucuk bir kismi (%1,25) ucret olarak geri doner -- bir
     *      kismi ayni creator'a. Bu bilinclidir: buyback GERCEK bir piyasa
     *      alimidir (§8) ve ayricalikli bir ucret muafiyeti, egriye
     *      ayricalikli bir yol acmak demek olurdu.
     */
    function _buyOnCurve(address curve, address token, uint256 amount, uint256 minTokensOut)
        private
        returns (uint256 received)
    {
        uint256 before = IERC20(token).balanceOf(address(this));
        ICurveView(curve).buyExactQuoteIn{value: amount}(minTokensOut);
        received = IERC20(token).balanceOf(address(this)) - before;
    }

    // ------------------------------------------------------------------
    // Gorunumler
    // ------------------------------------------------------------------

    /// @notice Su anda guvenle harcanabilecek tutar -- anahtarci bunu okur.
    function spendable(address token) external view returns (uint256) {
        uint256 pending = pendingQuote[token];
        if (pending == 0) return 0;
        return _spendableOnCurve(ILaunchTokenView(token).curve(), pending);
    }

    /// @notice Supurme su an izinsiz cagrilabilir mi.
    function sweepIsPermissionless(address token) external view returns (bool) {
        return block.timestamp > lastSweepAt[token] + SWEEP_GRACE;
    }

    /// @dev Yalnizca egriden gelen alim iadesi icin. Dogrudan bagis muhasebeye
    ///      GIRMEZ (bkz. dosya basligi) ve hicbir butceyi buyutmez.
    receive() external payable {}
}
