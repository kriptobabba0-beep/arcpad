// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {CurrencySettler} from "uniswap-hooks/utils/CurrencySettler.sol";
import {GraduationMath} from "./libraries/GraduationMath.sol";
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
    using StateLibrary for IPoolManager;
    using CurrencySettler for Currency;

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
    /// @dev Fonlarin kalici olarak erisilemez kalmasini engeller (spec Â§29).
    uint256 public constant SWEEP_GRACE = 7 days;

    uint256 private constant BPS = 10_000;

    address public immutable factory;
    address public immutable escrow;
    BuybackVestingVault public immutable vault;

    /// @notice Mezuniyet SONRASI alim mercii.
    ///
    /// @dev NICIN CONSTRUCTOR ARGUMANI OLABILIYOR -- ve hook'un neden
    ///      olamadigi. `PoolManager` kendi tuzuyla deploy edilir ve adresi
    ///      fabrikaya, hazineye ya da hook'a BAGLI DEGILDIR; buyback nesli
    ///      fabrikayi ve hook'u kaydirdiginda bile YERINDE KALDI
    ///      (`PoolDeployLib.ARC_POOL_MANAGER`, degismedi). Yani hazine
    ///      deploy edildiginde `PoolManager` ZATEN VARDIR ve bir dairesel
    ///      bagimlilik olusmaz. Hook boyle degildir: tuzu fabrikaya
    ///      madenlenir, yani hazineden SONRA var olur -- o yuzden hook
    ///      fabrikadan CALISMA ZAMANINDA okunur (`graduationHook()`).
    IPoolManager public immutable poolManager;

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

    constructor(address factory_, address escrow_, BuybackVestingVault vault_, IPoolManager poolManager_) {
        if (
            factory_ == address(0) || escrow_ == address(0) || address(vault_) == address(0)
                || address(poolManager_) == address(0)
        ) {
            revert ZeroAddress();
        }
        factory = factory_;
        escrow = escrow_;
        vault = vault_;
        poolManager = poolManager_;
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
        // `== 0` BURADA BIR SENTINEL, bir zaman karsilastirmasi DEGIL: "bu
        // token icin saat hic baslamadi" demenin tek yolu. `block.timestamp`
        // sifir olamayacagi icin yanlis pozitif de uretemez.
        // slither-disable-next-line incorrect-equality
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
     * @dev ASLA REVERT ETMEZ "piyasa ince" diye. Spec Â§11: guvenli alim
     *      yapilamiyorsa para creator'a doner -- protokole GITMEZ, kontratta
     *      KALMAZ.
     *
     * @param minTokensOut Anahtarcinin hesapladigi alt sinir. YALNIZCA alim
     *        GERCEKTEN yapilirken uygulanir; atlanan bir buyback bu yuzden
     *        butun dagitimi kilitlemez (spec Â§12).
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

        /*
         * MERCI SECIMI -- VE SIRA "EGRI ONCE"DIR.
         *
         * Bir launch'in hayati iki asamalidir ve alim yalnizca BIRINDE
         * mumkundur: egri asamasinda satis arzi egridedir, mezuniyetten sonra
         * likidite V4 havuzundadir. `_spendableOnCurve` ikinci durumda ZATEN
         * sifir doner (`complete() || graduated()`), yani bu dal onun
         * biraktigi yeri devralir.
         *
         * ONCEKI HALDE IKINCI DAL YOKTU ve sonucu olculdu: mezuniyetten sonra
         * her supurme butun butceyi creator'a GERI KATLIYORDU. Ozellik
         * "guvenli degil" diye degil, ALIM YAPACAK YER OLMADIGI icin
         * calismiyordu -- ve hicbir sey kirmizi olmuyordu, cunku geri katlama
         * mesru bir sonuctur.
         */
        uint256 toSpend = _spendableOnCurve(curve, pending);
        bool onPool = toSpend == 0 && ICurveView(curve).graduated();

        if (!onPool && toSpend < MIN_SWEEP_WEI) {
            _foldBack(token, creator, pending, "below-threshold-or-unsafe");
            return;
        }

        uint256 got;
        if (onPool) {
            if (pending < MIN_SWEEP_WEI) {
                _foldBack(token, creator, pending, "below-threshold-or-unsafe");
                return;
            }
            string memory why;
            (toSpend, got, why) = _buyOnPool(token, pending, minTokensOut);
            if (toSpend == 0) {
                _foldBack(token, creator, pending, why);
                return;
            }
        } else {
            got = _buyOnCurve(curve, token, toSpend, minTokensOut);
        }

        uint256 leftover = pending - toSpend;
        if (leftover != 0) _refund(creator, leftover);

        cumulativeQuoteSpent[token] += toSpend;
        cumulativeTokensBought[token] += got;
        emit BuybackExecuted(token, toSpend, got);

        IERC20(token).forceApprove(address(vault), got);
        vault.lock(token, got, creator);
    }

    // ------------------------------------------------------------------
    // Havuz mercii -- mezuniyet SONRASI alim
    // ------------------------------------------------------------------

    /// @dev `unlock` -> `unlockCallback` arasinda tasinan is emri.
    /// @dev BIR STORAGE ALANI DEGIL, `abi.encode` YUKUDUR: storage'a yazmak
    ///      iki supurmenin ic ice gecmesi halinde birbirinin emrini okumasina
    ///      izin verirdi. V4 `unlock`u zaten yeniden girise kapali, ama emri
    ///      cagri yigininda tasimak o varsayima HIC dayanmaz.
    struct PoolBuy {
        address token;
        uint256 unitsIn;
        bool baseIsCurrency0;
    }

    error NotPoolManager();
    error SlippageTooHigh(uint256 got, uint256 minTokensOut);

    /**
     * @notice Havuzdan alim yapar; fiyat etkisi sinirini AMM'in KENDISINE
     *         uygulattirir.
     *
     * @return spentWei Gercekten harcanan quote (native wei).
     * @return got      Alinan token.
     *
     * @dev ============ SINIR YENIDEN HESAPLANMAZ, HAVUZA VERILIR ============
     *
     *      `_spendableOnCurve` "ne kadar harcarsam fiyat %3'ten fazla kaymaz"
     *      sorusunu KAPALI FORMDA cozer, cunku egrinin rezervleri iki sayidir.
     *      V4 havuzunda ayni soru YOGUNLASTIRILMIS likidite yuzunden kapali
     *      formda cozulemez: cevap, gecilecek her tick araligindaki likiditeye
     *      baglidir.
     *
     *      Onu yeniden implemente etmek (tick tick yuruyen bir simulasyon)
     *      hem buyuk hem YANLIS OLABILIR bir kod olurdu -- ve yanlis oldugunda
     *      sessizce fazla harcar. Bunun yerine V4'un `sqrtPriceLimitX96`si
     *      kullanilir: swap fiyat sinira VARDIGI anda durur ve girdinin
     *      kalanina DOKUNMAZ. Sinirin uygulanmasi havuzun kendi kodundadir,
     *      yani bizim aritmetigimiz yanlis olamaz.
     *
     *      Bedeli: harcanan miktar ONCEDEN bilinmez, SONRADAN olculur --
     *      donusteki `spentWei` `delta`dan okunur, tahmin edilmez. Kalan
     *      creator'a katlanir, tipki ince bir egride oldugu gibi.
     *
     * @dev EXACT-INPUT: `amountSpecified` NEGATIFTIR. Pozitif yazmak
     *      exact-output demek olurdu ve o, "elimdeki butceyi harca" degil
     *      "su kadar token al, ne pahasina olursa olsun" demektir.
     */
    function _buyOnPool(address token, uint256 pending, uint256 minTokensOut)
        private
        returns (uint256 spentWei, uint256 got, string memory reason)
    {
        (PoolKey memory key, bool baseIsCurrency0) =
            GraduationMath.poolKey(token, IHooks(ITreasuryFactoryView(factory).graduationHook()));

        // HAVUZ YOKSA REVERT EDILMEZ, GERI KATLANIR. Bu kontratin ilkesi
        // dosya basliginda yazili: alim yapilamiyorsa para CREATOR'A doner,
        // kontratta KALMAZ. Revert etmek butceyi, kimsenin duzeltemeyecegi
        // bir kosula bagli olarak kilitlerdi -- ve mezun bir egrinin havuzu
        // locker tarafindan AYNI islemde acildigi icin bu dal normalde
        // ulasilamazdir; ulasildigi gun ise fon kilitlemek yanlis cevaptir.
        // AYRI BIR SEBEP DIZESI TASIR: "havuz yok" ile "havuz ince" bir
        // operator icin ayni sey degildir.
        // Yalnizca fiyat sorulur; tick ve iki ucret alani bu hesaba GIRMEZ.
        // slither-disable-next-line unused-return
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP == 0) return (0, 0, "pool-not-initialized");

        // 6-DECIMAL'E TABANA YUVARLANIR. Kalan (< 10^12 wei) harcanamaz --
        // havuz bacagi ERC-20'dir ve 1 biriminin altini tasiyamaz. O artik
        // `leftover` icinde creator'a doner, kontratta KALMAZ.
        uint256 unitsIn = GraduationMath.quoteUnits(pending);
        if (unitsIn == 0) return (0, 0, "below-one-quote-unit");

        bytes memory out =
            poolManager.unlock(abi.encode(PoolBuy({token: token, unitsIn: unitsIn, baseIsCurrency0: baseIsCurrency0})));
        (uint256 spentUnits, uint256 bought) = abi.decode(out, (uint256, uint256));
        if (spentUnits == 0) return (0, 0, "pool-cannot-absorb");

        // SLIPAJ KONTROLU BURADA, VE REVERT EDER. Geri katlama DEGIL: anahtarci
        // bir alt sinir bildirdiyse, o sinirin altinda kalan bir alim
        // GERCEKLESMEMELIDIR -- islemin tamami geri alinir ve butce yerinde
        // kalir. Geri katlamak, kotu bir fiyati "kabul edilmis" saymak olurdu.
        if (bought < minTokensOut) revert SlippageTooHigh(bought, minTokensOut);

        spentWei = GraduationMath.quoteWei(spentUnits);
        got = bought;
        reason = "";
    }

    /**
     * @dev V4'un tek giris noktasi. `msg.sender` kontrolu ZORUNLUDUR ve
     *      locker'daki ikizinin ayni gerekcesini tasir: `PoolManager.unlock`
     *      yalnizca KENDI cagiranini geri arar, dolayisiyla bir saldirganin
     *      `unlock`u BU callback'i hic calistirmaz -- ama dogrudan cagri
     *      denemesi bu satirda duser.
     */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        PoolBuy memory job = abi.decode(data, (PoolBuy));

        // Ikinci donen deger `zeroForOne`dir ve bu cagri yerinde ADRES
        // SIRASINDAN zaten turetilir; ikinci bir kaynak, ikisinin
        // ayrisabilecegi bir yer acardi.
        // slither-disable-next-line unused-return
        (PoolKey memory key,) =
            GraduationMath.poolKey(job.token, IHooks(ITreasuryFactoryView(factory).graduationHook()));

        // Yalnizca fiyat sorulur; tick ve iki ucret alani bu hesaba GIRMEZ.
        // slither-disable-next-line unused-return
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());

        /*
         * YON VE SINIR, TEK BIR GERCEKTEN TURETILIR: fiyat
         * `currency1 / currency0`dir.
         *
         *   base == currency0  -> base'i currency1 (quote) ile aliyoruz,
         *                         yani `zeroForOne = false` ve fiyat YUKSELIR.
         *   base == currency1  -> base'i currency0 (quote) ile aliyoruz,
         *                         yani `zeroForOne = true` ve fiyat DUSER.
         *
         * Iki dali da elle yazmak yerine tek bir bayraktan turetmek
         * TASIYICIDIR: yonu yanlis yazmak revert URETMEZ, ters yone bir swap
         * yapar -- yani buyback token SATARDI.
         */
        bool zeroForOne = !job.baseIsCurrency0;
        uint160 limit = _impactLimit(sqrtP, zeroForOne);

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(job.unitsIn), sqrtPriceLimitX96: limit}),
            ""
        );

        int128 quoteDelta = job.baseIsCurrency0 ? delta.amount1() : delta.amount0();
        int128 baseDelta = job.baseIsCurrency0 ? delta.amount0() : delta.amount1();

        // BEKLENEN ISARETLER IDDIA EDILIR. Bir alimda quote bacagi BORC
        // (negatif), base bacagi ALACAK (pozitif) olmak zorundadir. Ters bir
        // isaret, yonun ya da anahtarin yanlis oldugu anlamina gelir ve
        // asagidaki `uint256(int256(-x))` donusumu onu SESSIZCE devasa bir
        // sayiya cevirirdi.
        if (quoteDelta > 0 || baseDelta < 0) revert UnexpectedPoolDelta();

        uint256 owedQuote = uint256(int256(-quoteDelta));
        uint256 gotBase = uint256(int256(baseDelta));

        if (owedQuote != 0) {
            Currency quote = job.baseIsCurrency0 ? key.currency1 : key.currency0;
            quote.settle(poolManager, address(this), owedQuote, false);
        }
        if (gotBase != 0) {
            Currency base = job.baseIsCurrency0 ? key.currency0 : key.currency1;
            base.take(poolManager, address(this), gotBase, false);
        }
        return abi.encode(owedQuote, gotBase);
    }

    error UnexpectedPoolDelta();

    /**
     * @notice `MAX_PRICE_IMPACT_BPS` kadar kaymaya izin veren `sqrtPrice`
     *         siniri.
     *
     * @dev FIYAT DEGIL, KAREKOKU OLCEKLENIR. V4 siniri `sqrtPriceX96` olarak
     *      alir, dolayisiyla `%3`luk bir FIYAT kaymasi `sqrt(1,03)` katlik bir
     *      `sqrtPrice` kaymasidir. Dogrudan `1,03` ile carpmak, fiyati %6,09
     *      kaydirmaya izin verirdi -- sinirin IKI KATINDAN fazlasi, ve hicbir
     *      revert uretmeden.
     *
     * @dev KAREKOK TAM SAYIDA, `2^96` OLCEGINDE alinir. `Math.sqrt` TABANA
     *      yuvarlar, yani hesaplanan sinir her zaman GERCEK sinirin guvenli
     *      tarafinda kalir: yukari yonde biraz DAHA DAR, asagi yonde biraz
     *      DAHA DAR. Ikisi de fazla harcamayi degil, az harcamayi uretir.
     *
     * @dev V4'UN KENDI KELEPCELERI KORUNUR: `sqrtPriceLimitX96` kati olarak
     *      `(MIN_SQRT_PRICE, MAX_SQRT_PRICE)` ACIK araliginda olmak
     *      zorundadir; sinirlardan birine tam esit bir deger
     *      `PriceLimitOutOfBounds` ile revert eder.
     */
    function _impactLimit(uint160 sqrtP, bool priceFalls) private pure returns (uint160) {
        // sqrt(1 + impact) ve sqrt(1 / (1 + impact)), 2^96 olceginde.
        uint256 scaled = priceFalls
            ? Math.mulDiv(BPS, 1 << 192, BPS + MAX_PRICE_IMPACT_BPS)
            : Math.mulDiv(BPS + MAX_PRICE_IMPACT_BPS, 1 << 192, BPS);
        uint256 factorX96 = Math.sqrt(scaled);
        uint256 limit = Math.mulDiv(uint256(sqrtP), factorX96, 1 << 96);

        if (priceFalls) {
            uint256 floor_ = uint256(MIN_SQRT_PRICE) + 1;
            return uint160(limit < floor_ ? floor_ : limit);
        }
        uint256 ceil_ = uint256(MAX_SQRT_PRICE) - 1;
        return uint160(limit > ceil_ ? ceil_ : limit);
    }

    /// @dev `TickMath`ten KOPYALANMADI, ORADAN ALINAMADI: `TickMath` bu
    ///      degerleri `internal constant` olarak tutar ve kutuphane
    ///      importunun tamamini bu birime cekmek, yalnizca iki sayi icin
    ///      derleme yuzeyini genisletirdi. Degerler V4'un DEGISMEZ
    ///      sabitleridir; `test/BuybackTreasury.t.sol` ikisini de
    ///      `TickMath`in kendisiyle esitler, yani kopya sessizce ayrisamaz.
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// @dev Anahtarci; ya da sessiz kaldiysa (Â§29) herkes.
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
     * @dev ============ MEZUNIYET REZERVI (Â§9) ============
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
     *      alimidir (Â§8) ve ayricalikli bir ucret muafiyeti, egriye
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

    /**
     * @notice Su anda guvenle harcanabilecek tutar -- anahtarci bunu okur.
     *
     * @dev IKI ASAMA, IKI CEVAP. Egri asamasinda cevap `_spendableOnCurve`in
     *      KAPALI FORM sonucudur ve kesindir. Mezuniyetten sonra kesin bir
     *      cevap YOKTUR: havuzda ne kadarinin emilecegi, fiyat sinirina kadar
     *      gecilecek tick araliklarindaki likiditeye baglidir ve ancak swap
     *      KOSTURULARAK ogrenilir (bkz. `_buyOnPool`).
     *
     *      BU YUZDEN MEZUNIYET SONRASI `pending` DONER, SIFIR DEGIL. Sifir
     *      donmek, anahtarciya "harcanacak bir sey yok" demek olurdu ve
     *      anahtarci supurmeyi HIC cagirmazdi -- ozellik, calisabilecekken
     *      sessizce durur. Donen deger bir UST SINIRDIR: gercekte harcanan
     *      tutar `BuybackExecuted` olayindan okunur, ve kalan creator'a
     *      katlanir.
     *
     *      Anahtarci icin dogru okuma sudur: "bu sayi `MIN_SWEEP_WEI`in
     *      ustundeyse supurmeyi dene".
     */
    function spendable(address token) external view returns (uint256) {
        uint256 pending = pendingQuote[token];
        if (pending == 0) return 0;

        address curve = ILaunchTokenView(token).curve();
        uint256 onCurve = _spendableOnCurve(curve, pending);
        if (onCurve != 0) return onCurve;
        return ICurveView(curve).graduated() ? pending : 0;
    }

    /// @notice Supurme su an izinsiz cagrilabilir mi.
    function sweepIsPermissionless(address token) external view returns (bool) {
        return block.timestamp > lastSweepAt[token] + SWEEP_GRACE;
    }

    /// @dev Yalnizca egriden gelen alim iadesi icin. Dogrudan bagis muhasebeye
    ///      GIRMEZ (bkz. dosya basligi) ve hicbir butceyi buyutmez.
    receive() external payable {}
}
