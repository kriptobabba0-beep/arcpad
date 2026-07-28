// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveMath} from "./libraries/CurveMath.sol";

/// @notice `FeeEscrow`'un bu kontratin kullandigi tek fonksiyonu.
/// @dev Sifir tutarda `ZeroAmount()` ile revert eder; sifir paylar
///      CAGIRANIN yukumlulugu olarak atlanir (FeeEscrow kisiti 3).
interface IFeeEscrow {
    function deposit(address recipient) external payable;
}

/// @notice `LaunchToken`'in geri-isaret alani. Tam ERC-20 yuzeyine gerek
///         olmadigi icin ayri ve dar tutulur.
interface ICurveBoundToken {
    function curve() external view returns (address);
}

/// @title BondingCurve
/// @notice Bir launch'in tum ticaret hayati: sanal rezervli sabit carpim,
///         curve'un DISINDA alinan ucret, ve tek yonlu tamamlanma.
///
/// @dev DURUM ALANLARI pump.fun'in `BondingCurve` hesabini yansitir (canli
///      hesap duzeninden alinmistir): `virtualTokenReserves`,
///      `virtualQuoteReserves`, `realTokenReserves`, `realQuoteReserves`,
///      `complete`, `creator`. pump.fun'da ayrica `token_total_supply` ve
///      `quote_mint` vardir; arcpad'de birincisi `LaunchToken.TOTAL_SUPPLY`
///      sabitidir, ikincisi tek varlik (native USDC) oldugu icin gereksizdir.
///
/// @dev KATI CEI -- bu kontratin en onemli ozelligi. pump.fun rezervleri
///      transferlerden SONRA yazar; Solana'da hesap kilitleme yuzunden
///      guvenlidir, EVM'de DEGILDIR. Buradaki sira su sekilde baglayicidir:
///      dogrula -> defteri yaz -> `complete`'i cevir -> olayi yay ->
///      token transferi -> escrow'a yatir -> iade. Her defter yazimi her dis
///      cagridan ONCE biter, boylece reentrant bir cagri asla BAYAT rezerv
///      goremez ve reentrancy guard'a ihtiyac kalmaz.
///
/// @dev UCRET PARCALARDAN TOPLANIR, bir toplamdan BOLUNMEZ.
///      `feeOn(x, 95) + feeOn(x, 30)`, `feeOn(x, 125)`'ten buyuk olabilir ve
///      olculdu: fark her seferinde protokolun aleyhinedir. Bu yuzden
///      birlesik `125` sabiti TANIMLANMAZ -- ileri yonde kullanilabilecek bir
///      literal birakilmaz. Toplam yalnizca `correctedNetQuoteIn`'in ICINDE,
///      inclusive ayrisimin paydasi olarak gecer.
///
/// @dev KURULUM IKI ADIMLIDIR. Constructor token adresini ALMAZ; `bind` ile
///      yalnizca factory, yalnizca bir kez yazar. Gerekcesi Task 3'un CREATE2
///      kurgusudur: curve token'dan ONCE deploy edilir, boylece curve'un
///      adresi token'a bagli olmaz ve iki adres birbirini bekleyen dongusel
///      bir bagimlilik dogmaz. `bind` cagrilmadan HER ticaret giris noktasi
///      revert eder; initialize edilmemis bir pencerede islem yapilamaz.
contract BondingCurve {
    // ---------------------------------------------------------------
    // Sabitler
    // ---------------------------------------------------------------

    /// @notice Protokol payi. Curve'de kademe taramasi YOKTUR: arcpad ucret
    ///         kademelerini launch aninda dondurur ve curve duz %1,25 alir.
    uint256 public constant PROTOCOL_FEE_BPS = 95;

    /// @notice Creator payi. Creator sifirsa ALINMAZ ve protokol payina
    ///         KATLANMAZ -- islem sadece 30 bps daha ucuz olur.
    uint256 public constant CREATOR_FEE_BPS = 30;

    /// @notice Sanal token rezervi `T`. pump.fun'in canli degerinin (6 decimal
    ///         Solana olceginde 1_073_000_000_000_000) 18 decimal karsiligi.
    uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000e18;

    /// @notice Sanal quote rezervi `V`. pump.fun'in canli `Global` hesabindaki
    ///         `initial_virtual_quote_reserves = 4_292_000_000` (6 decimal
    ///         USDC) degerinin 18 decimal native gorunumu. Acilis FDV'sini tam
    ///         4.000 USDC'ye oturtur (4292 / 1,073 = 4000).
    uint256 public constant INITIAL_VIRTUAL_QUOTE_RESERVES = 4_292e18;

    /// @notice Satis arzi `S`; ilk `realTokenReserves`. Curve TUM arzi custody
    ///         eder ama yalnizca bunu satar; `N - S` artigi graduation'da
    ///         havuza gider.
    uint256 public constant INITIAL_REAL_TOKEN_RESERVES = 793_100_000e18;

    // ---------------------------------------------------------------
    // Immutable'lar
    // ---------------------------------------------------------------

    /// @notice `bind`'i cagirabilecek tek adres: bu curve'u deploy eden.
    address public immutable factory;

    /// @notice Creator payinin alicisi. SIFIR OLABILIR -- o zaman creator payi
    ///         hic alinmaz.
    address public immutable creator;

    /// @notice Ucretlerin yatirildigi pull-based defter.
    address public immutable escrow;

    /// @notice Protokol payinin alicisi.
    address public immutable protocolTreasury;

    /// @notice Havuz tohum arzi `D = S(T-S)/T`. Her launch icin ayni sayidir;
    ///         `Completed` ile birlikte yayinlanir ki Faz 2 yeniden
    ///         hesaplamak zorunda kalmasin.
    uint256 public immutable poolSeedSupply;

    // ---------------------------------------------------------------
    // Durum
    // ---------------------------------------------------------------

    /// @notice Arzin tamamini tutan token. `bind` ile BIR KEZ yazilir.
    address public token;

    uint256 public virtualTokenReserves;
    uint256 public virtualQuoteReserves;
    uint256 public realTokenReserves;
    uint256 public realQuoteReserves;

    /// @notice Tek yonlu kapi. Curve'de bunu geri alan bir yol yoktur.
    bool public complete;

    // ---------------------------------------------------------------
    // Olaylar
    // ---------------------------------------------------------------

    /// @notice Her islem. Rezervlerin DORDUNU DE tasir: pump.fun'in
    ///         `TradeEvent`'i aynisini yapar ve Faz 3'un indexer'i boylece her
    ///         islemden sonraki durumu zincire tekrar sormadan yeniden kurar.
    /// @param quoteAmount Curve tarafindaki tutar (ucret HARIC). Ucret
    ///        parcalari ayri alanlardadir; toplanmis bir tutar yayinlanmaz.
    event Trade(
        address indexed trader,
        bool isBuy,
        uint256 tokenAmount,
        uint256 quoteAmount,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 virtualTokenReserves,
        uint256 virtualQuoteReserves,
        uint256 realTokenReserves,
        uint256 realQuoteReserves
    );

    /// @notice Satis arzi tukendi; curve kapandi.
    event Completed(address indexed token, uint256 realQuoteReserves, uint256 poolSeedSupply);

    // ---------------------------------------------------------------
    // Hatalar
    // ---------------------------------------------------------------

    error ZeroAmount();
    error CurveComplete();
    error NotEnoughTokensToBuy();
    error SlippageExceeded();
    error RefundFailed();
    error PayoutFailed();
    error TokenTransferFailed();
    error ZeroToken();
    error ZeroEscrow();
    error ZeroTreasury();
    error TokenDoesNotPointBack();
    error NotFactory();
    error AlreadyBound();
    error NotBound();

    constructor(address creator_, address escrow_, address protocolTreasury_) {
        if (escrow_ == address(0)) revert ZeroEscrow();
        if (protocolTreasury_ == address(0)) revert ZeroTreasury();

        factory = msg.sender;
        creator = creator_;
        escrow = escrow_;
        protocolTreasury = protocolTreasury_;
        poolSeedSupply = CurveMath.poolSeedSupply(INITIAL_REAL_TOKEN_RESERVES, INITIAL_VIRTUAL_TOKEN_RESERVES);

        virtualTokenReserves = INITIAL_VIRTUAL_TOKEN_RESERVES;
        virtualQuoteReserves = INITIAL_VIRTUAL_QUOTE_RESERVES;
        realTokenReserves = INITIAL_REAL_TOKEN_RESERVES;
    }

    /// @notice Token adresini bir kez yazar.
    /// @dev Tek yonlu bir isaretci YETMEZ: token'in da bu curve'u isaret
    ///      ettigi dogrulanir. Aksi halde curve, arzi baska bir adreste duran
    ///      bir token'a baglanir ve hicbir alimi karsilayamaz.
    function bind(address token_) external {
        if (msg.sender != factory) revert NotFactory();
        if (token != address(0)) revert AlreadyBound();
        if (token_ == address(0)) revert ZeroToken();
        if (ICurveBoundToken(token_).curve() != address(this)) revert TokenDoesNotPointBack();

        token = token_;
    }

    // ---------------------------------------------------------------
    // Alim -- tam token cikisi
    // ---------------------------------------------------------------

    /// @notice Tam `tokensOut` token alir; artan `msg.value` iade edilir.
    /// @dev Sinirda REVERT EDER, kismi doldurmaz. pump.fun'in `buy`'unun
    ///      davranisi budur; canli bir curve'e karsi simule edildi ve
    ///      `reserves + 1` icin `NotEnoughTokensToBuy` (6021) dondu, tam
    ///      rezerv gecti.
    /// @param maxQuoteIn Ucret DAHIL ust sinir. `msg.value`'ya karsi tutulur,
    ///        curve maliyetine karsi degil; tersine kurmak sessiz bir
    ///        kullanici-zarari hatasidir.
    function buyExactTokensOut(uint256 tokensOut, uint256 maxQuoteIn) external payable {
        // --- 1. DOGRULA ---
        address token_ = token;
        if (token_ == address(0)) revert NotBound();
        if (complete) revert CurveComplete();
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut > realTokenReserves) revert NotEnoughTokensToBuy();

        uint256 cost = CurveMath.quoteBuyCost(tokensOut, virtualQuoteReserves, virtualTokenReserves);
        uint256 protocolFee = CurveMath.feeOn(cost, PROTOCOL_FEE_BPS);
        uint256 creatorFee = creator == address(0) ? 0 : CurveMath.feeOn(cost, CREATOR_FEE_BPS);
        uint256 total = cost + protocolFee + creatorFee;
        if (total > maxQuoteIn || total > msg.value) revert SlippageExceeded();

        _settleBuy(token_, tokensOut, cost, protocolFee, creatorFee, msg.value - total);
    }

    // ---------------------------------------------------------------
    // Alim -- tam quote girisi
    // ---------------------------------------------------------------

    /// @notice `msg.value` kadar butceyle alabildigi kadar token alir.
    /// @dev Rezervi asan bir butce REVERT ETMEZ, rezerve KISAR. Bu bir sapma
    ///      degildir: pump.fun bu semantigi `buy_exact_sol_in` /
    ///      `buy_exact_quote_in_v2` altinda zaten sunar; arcpad pump.fun'in
    ///      OBUR giris noktasini varsayilan yapmayi secmistir.
    /// @dev Cok kucuk bir butce SIFIR TOKEN dondurmez, `CurveMath` icinden
    ///      `NetTooSmall()` ile revert eder. Bu arcpad'in kararidir; pump.fun'da
    ///      dogrulanmis bir davranis DEGILDIR. Gerekcesi: cagiran para odeyip
    ///      hicbir sey almamali.
    function buyExactQuoteIn(uint256 minTokensOut) external payable {
        // --- 1. DOGRULA ---
        address token_ = token;
        if (token_ == address(0)) revert NotBound();
        if (complete) revert CurveComplete();
        if (msg.value == 0) revert ZeroAmount();

        uint256 creatorBps = creator == address(0) ? 0 : CREATOR_FEE_BPS;

        // Zincirin exact-quote-in algoritmasi (1-3. adim). UCRET PARCALARI
        // BURADAN DONER VE YENIDEN HESAPLANMAZ: `correctedNetQuoteIn` ucreti
        // DUZELTME ONCESI net uzerinden alir; donen net uzerinden yeniden
        // hesaplamak (95, 30) bps'te girdilerin %1,23'unde 1 birim eksik
        // tahsil eder ve eksik alan taraf creator olur.
        (uint256 curveIn, uint256 protocolFee, uint256 creatorFee) =
            CurveMath.correctedNetQuoteIn(msg.value, PROTOCOL_FEE_BPS, creatorBps);

        // 4. adim.
        uint256 tokensOut = CurveMath.quoteBuyTokensOut(curveIn, virtualQuoteReserves, virtualTokenReserves);

        if (tokensOut > realTokenReserves) {
            // KISMA. Kalan rezervin TAMAMI satilir ve islem tam olarak
            // `buyExactTokensOut(realTokenReserves)` ile ayni yere duser --
            // yani rezervler tam sifira iner, toz kalmaz. Anapara degistigi
            // icin ucret de o anapara uzerinden yeniden alinir; bu, donen
            // net'in ucretini yeniden hesaplamak DEGILDIR (o yasaktir),
            // exclusive sozlesmeye sahip BASKA bir anaparanin ucretidir.
            // Artan butce iade edilir.
            //
            // Kisilan tutarin butceye sigacagi ispatlanabilir: `tokensOut`
            // kucultuldugu ve `quoteBuyCost` ile `quoteBuyTokensOut` ayni
            // egrinin iki yonu oldugu icin yeni `curveIn` eskisini asamaz;
            // `feeOn` monoton oldugu icin iki ucret parcasi da asamaz.
            tokensOut = realTokenReserves;
            curveIn = CurveMath.quoteBuyCost(tokensOut, virtualQuoteReserves, virtualTokenReserves);
            protocolFee = CurveMath.feeOn(curveIn, PROTOCOL_FEE_BPS);
            creatorFee = creatorBps == 0 ? 0 : CurveMath.feeOn(curveIn, CREATOR_FEE_BPS);
        }

        if (tokensOut < minTokensOut) revert SlippageExceeded();

        // `curveIn + protocolFee + creatorFee <= msg.value` GARANTIDIR, ama
        // ESITLIK DEGILDIR: duzeltme tetiklenmediginde toplam butcenin 1
        // altinda kalabilir. Olculdu: (95, 30) bps'te girdilerin %99,95'inde
        // esit; (5000, 5000) bps'te yalnizca %75'inde. `== msg.value` diye
        // kurulmus bir koruma islemlerin dortte birini revert ettirirdi.
        // Artik kullanicinindir ve iade edilir.
        _settleBuy(token_, tokensOut, curveIn, protocolFee, creatorFee, msg.value - curveIn - protocolFee - creatorFee);
    }

    // ---------------------------------------------------------------
    // Satim
    // ---------------------------------------------------------------

    /// @notice Tam `tokensIn` token satar.
    /// @param minQuoteOut Ucret DUSULDUKTEN SONRA saticiya fiilen odenen net
    ///        tutara karsi tutulur, ucret oncesi curve tutarina karsi degil.
    function sellExactTokensIn(uint256 tokensIn, uint256 minQuoteOut) external {
        // --- 1. DOGRULA ---
        address token_ = token;
        if (token_ == address(0)) revert NotBound();
        if (complete) revert CurveComplete();
        if (tokensIn == 0) revert ZeroAmount();

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensIn, virtualQuoteReserves, virtualTokenReserves);
        uint256 protocolFee = CurveMath.feeOn(proceeds, PROTOCOL_FEE_BPS);
        uint256 creatorFee = creator == address(0) ? 0 : CurveMath.feeOn(proceeds, CREATOR_FEE_BPS);

        // `quoteSellProceeds` tabana yuvarlar ve sifir verebilir; ustelik
        // proceeds 1 ya da 2 iken iki ucret parcasi (ikisi de tavana
        // yuvarlandigi icin en az 1) toplami proceeds'i yutar. Escrow'a
        // dokunmadan ONCE eleniyor: aksi halde ya satici sifir alir ya da
        // cikarma altan tasar. `FeeEscrow.deposit` sifir tutarda revert
        // ettigi icin bu ayni zamanda escrow kisiti 3'un geregidir.
        if (proceeds <= protocolFee + creatorFee) revert ZeroAmount();
        uint256 netOut = proceeds - protocolFee - creatorFee;
        if (netOut < minQuoteOut) revert SlippageExceeded();

        // --- 2. DEFTERI YAZ (her dis cagridan ONCE) ---
        virtualQuoteReserves -= proceeds;
        virtualTokenReserves += tokensIn;
        realTokenReserves += tokensIn;
        realQuoteReserves -= proceeds;

        // --- 3. OLAY ---
        emit Trade(
            msg.sender,
            false,
            tokensIn,
            proceeds,
            protocolFee,
            creatorFee,
            virtualTokenReserves,
            virtualQuoteReserves,
            realTokenReserves,
            realQuoteReserves
        );

        // --- 4. DIS CAGRILAR ---
        if (!IERC20(token_).transferFrom(msg.sender, address(this), tokensIn)) revert TokenTransferFailed();
        IFeeEscrow(escrow).deposit{value: protocolFee}(protocolTreasury);
        if (creatorFee != 0) IFeeEscrow(escrow).deposit{value: creatorFee}(creator);

        (bool ok,) = msg.sender.call{value: netOut}("");
        if (!ok) revert PayoutFailed();
    }

    // ---------------------------------------------------------------
    // Ortak alim yerlesimi
    // ---------------------------------------------------------------

    /// @dev SIRA BAGLAYICIDIR ve iki alim giris noktasi da buradan gecer:
    ///      defter -> `complete` -> olaylar -> token -> escrow -> iade.
    ///      Her defter yazimi her dis cagridan once biter.
    function _settleBuy(
        address token_,
        uint256 tokensOut,
        uint256 curveIn,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 refund
    ) private {
        // --- 2. DEFTERI YAZ (her dis cagridan ONCE) ---
        virtualQuoteReserves += curveIn;
        virtualTokenReserves -= tokensOut;
        realTokenReserves -= tokensOut;
        realQuoteReserves += curveIn;
        bool justCompleted = realTokenReserves == 0;
        if (justCompleted) complete = true;

        // --- 3. OLAYLAR ---
        emit Trade(
            msg.sender,
            true,
            tokensOut,
            curveIn,
            protocolFee,
            creatorFee,
            virtualTokenReserves,
            virtualQuoteReserves,
            realTokenReserves,
            realQuoteReserves
        );
        if (justCompleted) emit Completed(token_, realQuoteReserves, poolSeedSupply);

        // --- 4. DIS CAGRILAR ---
        if (!IERC20(token_).transfer(msg.sender, tokensOut)) revert TokenTransferFailed();

        // `protocolFee` sifir OLAMAZ (`quoteBuyCost` en az 1 doner ve `feeOn`
        // tavana yuvarlar), ama `creatorFee` creator sifirken sifirdir -- bu
        // yuzden kosullu. Kosulu kaldirmak, `FeeEscrow.deposit` sifir tutarda
        // revert ettigi icin HER islemi kirardi.
        IFeeEscrow(escrow).deposit{value: protocolFee}(protocolTreasury);
        if (creatorFee != 0) IFeeEscrow(escrow).deposit{value: creatorFee}(creator);

        // Iade duz `call` ile yapilir ve BASARISIZLIGINDA REVERT EDER. Arc'ta
        // sozlesmelere native gonderimin basarili olacagi garanti degildir ve
        // sessizce yutmak kullanicinin parasini yakar. Bu, `FeeEscrow`'un
        // pull-based olmasinin TERSI bir tercihtir ve bilinclidir: escrow'da
        // fon baska bir alicinin parasini kilitlemesin diye cekilir, burada
        // ise iade zaten `msg.sender`'in kendi isleminin parcasidir --
        // basarisizsa islemin tamami geri alinmalidir.
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }
}
