// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Kasanin fabrikadan okudugu iki sey. IKISI DE CANLI OKUNUR, cunku
///      ikisi de ADRESTIR ve adresler yonetisimle doner. Ekonomik SART olan
///      `protocolVestBps` ise launch aninda SNAPSHOT'lanir (bkz. `LaunchVest`)
///      -- bir adres rotasyonu operasyoneldir, bir pay degisikligi ekonomiktir
///      ve gecmise doneni ikincisidir.
interface IBuybackFactoryView {
    /// @notice Vested tokenlarin protokol payinin gidecegi adres.
    function protocolTreasury() external view returns (address);
    /// @notice `lock` cagirmaya YETKILI tek adres.
    function buybackTreasury() external view returns (address);
}

/**
 * @title BuybackVestingVault
 * @notice Creator'in KENDI ucret gelirinden piyasadan satin alinan tokenlari
 *         bes yil boyunca dogrusal olarak serbest birakan, launch basina
 *         defter tutan TEK kasa.
 *
 * @dev ============ BU BIR YAKMA DEGIL ============
 *
 *      Buraya giren token YAKILMAZ. `totalSupply` degismez; degisen sey
 *      DOLASIMDAKI envanterdir. Bu ayrim koda da yansir: bu dosyada `burn`
 *      cagrisi YOKTUR ve olmamalidir.
 *
 * @dev ============ NICIN TEK KASA, TOKEN BASINA DEGIL ============
 *
 *      Her launch icin ayri bir vesting kontrati deploy etmek, launch
 *      maliyetine kalici bir deploy ekler ve bu deponun olctugu sey sudur:
 *      launch maliyeti 1.861.145 gaz (0,039 USDC) ve populerlik launch
 *      uretir. Ikinci bir kontrat o maliyeti buyutur, karsiliginda hicbir
 *      izolasyon getirmez -- izolasyon zaten `mapping(address token => ...)`
 *      ile saglanir ve hicbir defter baska bir tokenin defterine dokunamaz.
 *
 * @dev ============ AGIRLIKLI ORTALAMA SAAT: NICIN DIZI YOK ============
 *
 *      Naif tasarim her buyback icin bir `VestingTranche` push'lar. Populer
 *      bir token binlerce supurme uretir ve `release` maliyeti dogrusal
 *      buyur; bir noktada kullanilamaz olur.
 *
 *      Bunun yerine TEK bir pozisyon tutulur ve her yeni yatirim, mevcut
 *      VESTE OLMAMIS bakiye ile yeni yatirimi BUYUKLUKLE AGIRLIKLANDIRARAK
 *      harmanlar:
 *
 *          kalanSure   = vestingEnd - now            (mevcut pozisyonun)
 *          birlesikSure = (mevcutVestsiz * kalanSure
 *                          + yeniTutar * VESTING_DURATION) / toplam
 *
 *      Buyuk bir pozisyona kucuk bir ekleme takvimi COK AZ oynatir; kucuk bir
 *      pozisyona buyuk bir ekleme takvimi neredeyse tamamen yeni yatirimin
 *      saatine tasir. Islem O(1)'dir ve kac supurme yapildigindan bagimsizdir.
 *
 * @dev ============ `lastUpdate` VE OLCTUGUM SEY ============
 *
 *      Referans uygulama (`PonsV2BuybackVault._checkpoint`) `lastUpdate`i
 *      KOSULSUZ ilerletir -- vesting sifir ciksa da. Ilk okumada bunu "zamani
 *      yutan bir hata" diye niteledim; OLCTUM VE IDDIAM FAZLA GUCLUYDU.
 *      Gerceklesen sey su:
 *
 *      (1) KALICI KAYIP YOK, HICBIR SURUMDE. `_previewNewlyVested`in
 *          `nowTs >= vestingEnd` dali kalan HER SEYI vest eder, yani tabana
 *          yuvarlanan artik bitiste mutlaka geri gelir. `totalSupply` gibi
 *          burada da kaybolan bir sey yoktur -- test
 *          `test_bitisten_sonra_artik_kalmaz` bunu son wei'ye kadar iddia
 *          eder.
 *
 *      (2) `release` YOLU ZATEN KAPALI, ama sebebi bu satir DEGIL: cekilecek
 *          sey yokken `NothingToRelease` ile REVERT ediyoruz ve revert,
 *          `_checkpoint`in yazdigi `lastUpdate`i de geri aliyor. Referans
 *          uygulama orada `return 0` yapar, yani onda durum KALICI olur.
 *          Fark bu satirda degil, revert tercihindedir.
 *
 *      (3) `lock` yolunda bu satir bir SEY DEGISTIRMEZ, cunku `lock` zaten
 *          agirlikli ortalama icin `lastUpdate`i yeniden yaziyor -- yeni
 *          takvim SIMDI baslar, tanim geregi.
 *
 *      Yani asagidaki `if (newlyVested == 0) return;` SAVUNMACIDIR: davranisi
 *      degistirdigi bir senaryo KURAMADIM. Duruyor cunku niyeti acik yaziyor
 *      ve hicbir maliyeti yok; ama "Pons'un hatasini duzelttik" diye
 *      OKUNMAMALIDIR.
 *
 */
contract BuybackVestingVault {
    using SafeERC20 for IERC20;

    /// @notice Bes yil, dogrusal. Ucuncu yilin sonunda ~%60 acilmis olur.
    /// @dev `365 days` kullanilir; artik yil suruklenmesi bilinclidir ve
    ///      ekonomik olarak onemsizdir (bes yilda ~1 gun).
    uint256 public constant VESTING_DURATION = 5 * 365 days;

    /// @notice Vested tokenlarin protokole giden payi: %30.
    /// @dev ============ NICIN SABIT, NICIN UCRET KADEMESINDEN DEGIL ============
    ///
    ///      Referans uygulama bu payi launch'in protokol/creator ucret
    ///      PAYINDAN alir. Bizde oyle bir tek sayi YOKTUR: `FeeSchedule`
    ///      birbirinden bagimsiz iki bps dondurur (`protocolBps`, `creatorBps`)
    ///      ve ikisi de islem tutarina AYRI AYRI uygulanir. En yakin karsilik
    ///      `protocolBps / (protocolBps + creatorBps)` olurdu ve o, egride
    ///      95/125 = %76 eder.
    ///
    ///      Yani TAMAMEN creator parasiyla alinmis tokenlarin dortte ucu
    ///      protokole giderdi. Referans uygulamada bu oran %30'dur. Kademeyi
    ///      aynen kullanmak ozelligi creator icin akildisi yapar ve hic
    ///      acilmaz; o yuzden pay kademeden AYRILIR ve sabitlenir.
    ///
    ///      Bu, bilincli bir ekonomik karardir ve depo sahibi tarafindan
    ///      acikca onaylanmistir.
    uint16 public constant PROTOCOL_VEST_BPS = 3_000;

    uint256 private constant BPS = 10_000;

    /**
     * @notice Bir launch'in vesting defteri.
     *
     * @dev `vestingStart` YALNIZCA GOSTERIMDIR: hicbir hesaba girmez.
     *      `now - (VESTING_DURATION - birlesikSure)` olarak yazilir, boylece
     *      `start..end` araligi her zaman tam `VESTING_DURATION` genisligindedir
     *      ve arayuz "sozde baslangic" gosterebilir. Matematik yalnizca
     *      `unvestedAmount`, `lastUpdate` ve `vestingEnd` uzerinden yurur.
     *
     * @dev `creatorRecipient` ILK KILITTE yazilir ve BIR DAHA DEGISMEZ. Bu bir
     *      kisitlama degil, mimarinin yansimasidir: `BondingCurve.creator`
     *      `immutable`dir, yani bu platformda creator adresi ZATEN
     *      dondurulemez. Referans uygulamanin "creator alicisini senkronla"
     *      mekanizmasinin bizde karsiligi yoktur ve gerekmez -- yetim kalacak
     *      bir alici uretilemez.
     */
    struct LaunchVest {
        /// Kasaya bugune kadar giren toplam token (kumulatif).
        uint256 totalLocked;
        /// Bugune kadar faydalanicilara odenen toplam token (kumulatif).
        uint256 totalReleased;
        /// Veste ERMIS ama henuz odenmemis.
        uint256 vestedUnreleased;
        /// Hala vesting'de olan.
        uint256 unvestedAmount;
        /// Son ILERLEME KAYDEDILEN an. Bkz. yukaridaki sapma notu.
        uint256 lastUpdate;
        /// Mevcut pozisyonun bitis ani.
        uint256 vestingEnd;
        /// GOSTERIM icin sozde baslangic.
        uint256 vestingStart;
        /// Bes yillik payin creator tarafi.
        address creatorRecipient;
        /// Launch aninda dondurulan protokol payi.
        uint16 protocolVestBps;
    }

    /// @notice `LaunchFactory`. `protocolTreasury` ve `buybackTreasury` buradan.
    address public immutable factory;

    mapping(address token => LaunchVest) private _vests;

    error ZeroAddress();
    error NotBuybackTreasury();
    error NotBeneficiary();
    error NothingToRelease();
    error VestNotOpen();

    /// @notice Piyasadan alinmis token kasaya girdi.
    event BuybackLocked(
        address indexed token, uint256 tokenAmount, uint256 vestingStart, uint256 vestingEnd, uint256 totalLocked
    );

    /// @notice Veste ermis tokenlar faydalanicilara odendi.
    event VestingReleased(address indexed token, address indexed caller, uint256 creatorAmount, uint256 protocolAmount);

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    // ------------------------------------------------------------------
    // Kilitleme
    // ------------------------------------------------------------------

    /**
     * @notice Satin alinmis tokenlari kilitler ve vesting saatini gunceller.
     *
     * @dev YALNIZCA `BuybackTreasury` cagirabilir. Yetki fabrikadan CANLI
     *      okunur; bir setter YOKTUR. Aksi halde "sahte bir vesting pozisyonu
     *      yatir" saldirisi (spec'in "vault authorization" maddesi) acik
     *      kalirdi: herkes bir token gonderip o tokenin takvimini
     *      sulandirabilirdi.
     *
     * @dev TUTAR `balanceOf` FARKIYLA OLCULUR, cagiranin soyledigiyle degil.
     *      `LaunchToken` bizim kendi OZ `ERC20`umuzdur ve transfer ucreti
     *      yoktur; olcum yine de yapilir cunku ucuzdur ve muhasebeyi
     *      cagiranin dogru sozune bagli olmaktan cikarir.
     *
     * @param token          Kilitlenecek launch tokeni.
     * @param amount         Cagiranin gonderdigini soyledigi miktar.
     * @param creatorRecipient Ilk kilitte yazilir; sonrakilerde YOK SAYILIR.
     */
    function lock(address token, uint256 amount, address creatorRecipient) external {
        if (msg.sender != IBuybackFactoryView(factory).buybackTreasury()) revert NotBuybackTreasury();
        if (token == address(0) || creatorRecipient == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) return;

        LaunchVest storage v = _vests[token];
        uint256 nowTs = block.timestamp;

        // ONCE CHECKPOINT: yeni yatirim, ESKI takvime gore hak edilmis
        // vesting'i geriye donuk seyreltemez.
        _checkpoint(v, nowTs);

        if (v.creatorRecipient == address(0)) {
            v.creatorRecipient = creatorRecipient;
            v.protocolVestBps = PROTOCOL_VEST_BPS;
        }

        uint256 existingUnvested = v.unvestedAmount;
        uint256 combined = existingUnvested + received;
        // `vestingEnd` gecmiste kalmis olabilir (her sey vest etti); o durumda
        // kalan sure SIFIRDIR, negatif degil.
        uint256 remaining = existingUnvested == 0 || v.vestingEnd <= nowTs ? 0 : v.vestingEnd - nowTs;

        uint256 combinedDuration = (existingUnvested * remaining + received * VESTING_DURATION) / combined;

        v.unvestedAmount = combined;
        v.lastUpdate = nowTs;
        v.vestingEnd = nowTs + combinedDuration;
        v.vestingStart = nowTs - (VESTING_DURATION - combinedDuration);
        v.totalLocked += received;

        emit BuybackLocked(token, received, v.vestingStart, v.vestingEnd, v.totalLocked);
    }

    // ------------------------------------------------------------------
    // Serbest birakma
    // ------------------------------------------------------------------

    /**
     * @notice Veste ermis tokenlari IKI faydalaniciya birden oder.
     *
     * @dev Cagiran yalnizca faydalanicilardan biri olabilir. Odeme HER IKISINE
     *      birden yapilir; "kendi payini cek" tasarimi iki ayri defter
     *      gerektirirdi ve yuvarlama artiklarini ikiye bolerdi.
     *
     * @dev DOGRUDAN TRANSFER, escrow YOK. Bu deponun `FeeEscrow`u yalnizca
     *      NATIVE tutar tasir (`deposit` `payable`, `owed` tek boyutlu); token
     *      kredilendirmesi icin ikinci bir defter acmak, sirf referans
     *      uygulamaya benzemek olurdu.
     */
    function release(address token) external returns (uint256 released) {
        LaunchVest storage v = _vests[token];
        if (v.creatorRecipient == address(0)) revert VestNotOpen();

        address protocolRecipient = IBuybackFactoryView(factory).protocolTreasury();
        if (msg.sender != v.creatorRecipient && msg.sender != protocolRecipient) revert NotBeneficiary();

        _checkpoint(v, block.timestamp);

        released = v.vestedUnreleased;
        if (released == 0) revert NothingToRelease();

        // ETKILER ONCE: dis cagridan once defter kapanir.
        v.vestedUnreleased = 0;
        v.totalReleased += released;

        uint256 protocolAmount = (released * v.protocolVestBps) / BPS;
        uint256 creatorAmount = released - protocolAmount;

        if (creatorAmount != 0) IERC20(token).safeTransfer(v.creatorRecipient, creatorAmount);
        if (protocolAmount != 0) IERC20(token).safeTransfer(protocolRecipient, protocolAmount);

        emit VestingReleased(token, msg.sender, creatorAmount, protocolAmount);
    }

    // ------------------------------------------------------------------
    // Vesting matematigi
    // ------------------------------------------------------------------

    /**
     * @dev Veste ERMIS ama defterde henuz yazilmamis kismi tasir.
     *
     *      `lastUpdate` YALNIZCA bir ilerleme kaydedildiginde yazilir; bu,
     *      referans uygulamadan bilincli sapmadir ve dosya basligindaki
     *      gerekce ile birlikte okunmalidir. Yazilmadigi durumda gecen zaman
     *      KAYBOLMAZ, bir sonraki cagriya devredilir.
     */
    function _checkpoint(LaunchVest storage v, uint256 nowTs) private {
        uint256 newlyVested = _previewNewlyVested(v, nowTs);
        if (newlyVested == 0) return;
        v.unvestedAmount -= newlyVested;
        v.vestedUnreleased += newlyVested;
        v.lastUpdate = nowTs;
    }

    /**
     * @dev "Kalanin oransal payi" formu:
     *
     *          yeni = vestsizKalan * gecenSure / (bitis - sonGuncelleme)
     *
     *      Toplam suresi degil KALAN suresi kullanilir; boylece agirlikli
     *      ortalama `vestingEnd`i kaydirdiginda dahi defter tutarli kalir.
     *      Bitis gecildiyse kalanin TAMAMI vest eder -- bu dal yuvarlama
     *      artiginin kasada takili kalmasini engelleyen yerdir.
     */
    function _previewNewlyVested(LaunchVest storage v, uint256 nowTs) private view returns (uint256) {
        uint256 unvested = v.unvestedAmount;
        if (unvested == 0 || nowTs <= v.lastUpdate) return 0;
        if (nowTs >= v.vestingEnd) return unvested;
        return (unvested * (nowTs - v.lastUpdate)) / (v.vestingEnd - v.lastUpdate);
    }

    // ------------------------------------------------------------------
    // Gorunumler -- arayuz ve indexer icin
    // ------------------------------------------------------------------

    /// @notice Kasaya bugune kadar giren toplam token.
    function totalLocked(address token) external view returns (uint256) {
        return _vests[token].totalLocked;
    }

    /// @notice Bugune kadar odenen toplam token.
    function totalReleased(address token) external view returns (uint256) {
        return _vests[token].totalReleased;
    }

    /// @notice Su ana kadar veste ERMIS toplam (odenmis + odenmemis).
    function vestedAmount(address token) external view returns (uint256) {
        LaunchVest storage v = _vests[token];
        return v.totalReleased + v.vestedUnreleased + _previewNewlyVested(v, block.timestamp);
    }

    /// @notice Su anda cekilebilir tutar.
    function releasable(address token) external view returns (uint256) {
        LaunchVest storage v = _vests[token];
        return v.vestedUnreleased + _previewNewlyVested(v, block.timestamp);
    }

    /// @notice Hala kilitli (veste ermemis) tutar.
    function locked(address token) external view returns (uint256) {
        LaunchVest storage v = _vests[token];
        return v.unvestedAmount - _previewNewlyVested(v, block.timestamp);
    }

    function vestingStart(address token) external view returns (uint256) {
        return _vests[token].vestingStart;
    }

    function vestingEnd(address token) external view returns (uint256) {
        return _vests[token].vestingEnd;
    }

    function creatorBeneficiary(address token) external view returns (address) {
        return _vests[token].creatorRecipient;
    }

    /// @dev CANLI okunur: governor treasury'yi dondurdugunde butun kasalar
    ///      onu birlikte takip eder.
    function protocolBeneficiary() external view returns (address) {
        return IBuybackFactoryView(factory).protocolTreasury();
    }

    /// @notice Tek cagride butun defter -- arayuz icin.
    function vestOf(address token) external view returns (LaunchVest memory) {
        return _vests[token];
    }
}
