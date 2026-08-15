// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";

/// @notice `LaunchToken`'in geri-isaret alani. Tam ERC-20 yuzeyine gerek
///         olmadigi icin ayri ve dar tutulur.
/// @dev `IFeeEscrow`'un aksine bu YEREL kalir ve `LaunchToken` onu uygulamaz:
///      buradaki bag calisma zamaninda `bind` icinde zaten dogrulanir ve
///      basarisizligi bir launch'i durdurur (fail-closed, factory testinde
///      gorunur). Escrow'daki bagin derleme zamanina cekilmesinin sebebi
///      onun ticaret sirasinda ve her islemde kullanilmasiydi.
interface ICurveBoundToken {
    function curve() external view returns (address);
}

/// @notice Curve'un factory'sinden OKUDUGU iki uye. Ikisi de calisma aninda
///         okunur, kopyalanmaz: rotasyon boylece CANLI curve'lere de ulasir.
///
/// @dev YEREL, ve `LaunchFactory` import EDILMEZ. Sebebi CREATE2 kurgusudur:
///      curve'un derleme birimi factory'ye bagimli hale gelirse Task 3'un
///      kirdigi dongusel bagimlilik geri gelir. `ICurveBoundToken` ile ayni
///      disiplin.
///
/// @dev `view` TASIYICIDIR, susleme degil: solc `view` icin STATICCALL uretir
///      ve STATICCALL altinda her yazim revert eder -- YENIDEN GIRISI KAPATAN
///      SEY BUDUR. `bind`'in NatSpec'i ayni seyi ayni kelimelerle soyluyor ve
///      orada olculdu. Bu iki uyeden BIRINI non-`view` yapmak tek kelimelik,
///      gorunur hicbir etkisi olmayan ve reentrancy kapanisini SESSIZCE
///      kaldiran bir degisikliktir; `BondingCurve.t.sol` her ikisi icin de
///      yazim sayaci + kontrol grubu ile olcer.
///
/// @dev CURVE FACTORY'SINE KOSULSUZ GUVENIR. Iki uye de bir yetkinin
///      ciktisidir (bkz. `LaunchFactory` governance bolumu) ve curve onlari
///      dogrulamaz: `protocolTreasury` sifir olmadigini factory'nin
///      constructor'i ve setter'i garanti eder, `graduationTarget` icin ise
///      `graduate()` sifir kontrolunu KENDISI yapar. Bir factory'nin bu iki
///      uyeyi yeniden adlandirmasi ya da non-`view` yapmasi, deploy ettigi HER
///      curve'u kirar -- curve'un bytecode'u selector'leri ve STATICCALL'u
///      icerir.
///
/// @dev BU ARAYUZU KOPYALIYORSANIZ BU SATIRLARI DA KOPYALAYIN.
///
///      **`protocolTreasury()` HER HARCAMADA YENIDEN OKUNUR. HICBIR KOSULDA
///      ONBELLEKLENMEZ** -- ne `immutable`, ne storage, ne bir constructor
///      argumani, ne de bir struct alani. Governor Safe'i treasury'yi
///      dondurdugunde rotasyonun ZATEN DEPLOY EDILMIS tuketicilere
///      ulasmasinin tek yolu canli okumadir; bir kopya tutan her tuketici
///      ucreti eski (ya da ele gecirilmis) treasury'ye SONSUZA KADAR oder.
///
///      OLCULDU, IKI KEZ, VE IKINCISI BU SATIR YAZILMADIGI ICIN OLDU:
///      `graduation-implementation-review.md` F-G tam olarak bu arizayi
///      ONGORDU ve buraya bir uyari istedi; uyari yazilmadi, Faz 2'nin
///      `ArcpadHook`u bu arayuzu CIPLAK kopyaladi ve degeri `immutable`
///      olarak onbellekledi. Hook'un adresi `PoolKey`in bir alani oldugu
///      icin kusur ilk graduation'dan sonra DUZELTILEMEZ olacakti.
///      Onbellekleyen bir tuketiciye karsi acilan test
///      `ArcpadHook.t.sol::test_theHookPaysTheROTATEDTreasuryBecauseItNeverCachesIt`.
///
///      Ayni sey `graduationTarget()` icin de gecerlidir ve `graduate()` onu
///      cagri aninda okur.
interface ILaunchFactory {
    function graduationTarget() external view returns (address);
    function protocolTreasury() external view returns (address);
    /// @notice Bu launch'in buyback politikasi. `treasury == 0` -> KAPALI.
    /// @dev TEK cagri: "acik mi" ile "yuzde kac" ayri okunsaydi ikisi bir
    ///      islem icinde ayrisabilirdi. Ayrica `view` TASIYICIDIR -- solc
    ///      `view`den STATICCALL uretir, yani kotu niyetli bir factory ucret
    ///      dagitiminin ORTASINDA curve'e geri giremez. Ayni uyari
    ///      `protocolTreasury` icin de gecerlidir ve oradan kopyalanmistir.
    function buybackPolicy(address token) external view returns (address treasury, uint256 lockBps);
}

/// @dev Buyback payinin yatirildigi yer. `accrue` token basina defter tutar.
interface IBuybackTreasury {
    function accrue(address token) external payable;
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
/// @dev HAYAT DONGUSU UC DURUMDUR: `!complete` -> `complete` -> `graduated`.
///      Spec 5.4'un dort fazli `Rescued` diyagrami BU KONTRATTA YOKTUR ve bu
///      bilincli bir spec sapmasidir: o diyagram graduation'in tamamlayici
///      alimin ICINDE atomik oldugunu ve dolayisiyla kurtarilamaz sekilde
///      basarisiz olabilecegini varsayiyordu. Ayrildiginda `pushGraduation()`
///      tam olarak hedefin kendi izinsiz girisidir ve `Rescued`in bir karsiligi
///      kalmaz.
///
/// @dev BU YUZEYDE OLMAYAN VE OLMAMASI GEREKEN SEYLER -- listenin kendisi
///      1.1 kadar tasiyicidir, cunku buraya giren her sey KALICIDIR:
///      owner/onlyOwner yok, sweep/rescueTokens/emergencyWithdraw yok, pause
///      yok, `graduated`i temizleyen HICBIR yol yok; `graduateTo(address)` yok
///      (cagiranin sectigi hedef, fazladan adimla hirsizliktir); curve'de
///      `setGraduationTarget` yok (launch basina bir guven karari hicbir
///      trader'in denetleyemeyecegi seydir); `onGraduation(...)` callback'i yok
///      (izinsizligi bir seviye yukaridan bedavaya aliyoruz, karsiliginda Faz
///      2'nin selector'unu sonsuza kadar gommeye gerek yok); `sqrtPriceX96`,
///      `TickMath`, karekok yok (kapanis fiyati mevcut iki getter'dan TAM
///      okunur: `virtualQuoteReserves / virtualTokenReserves`, ve `graduate()`
///      ikisini de mutasyona ugratmaz); `pool`/`poolId`/`poolKey` yok; artigin
///      (`N - S - D`) ya da bagislarin sweep'i yok; graduation aninda rezerv
///      sifirlamasi yok (tamamlanma sonrasi okuma zaten ulasilamaz, ve
///      sifirlanmamis `realQuoteReserves` bir dogrulayicinin havuzla
///      karsilastirabilecegi TEK zincir kaydidir); `receive()`/`fallback()`
///      yok; `nonReentrant` yok (kati CEI'nin guard'i gereksiz kildigi bu
///      kontratin merkezi iddiasidir -- bir guard eklemek sirayi
///      guvenmediginizi soylerdi, ve spec 9'un tablosu `ReentrancyGuard`
///      listelese de curve bilerek uymaz).
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

    // ---------------------------------------------------------------
    // Immutable'lar
    // ---------------------------------------------------------------

    /// @notice Sanal token rezervi `T`.
    /// @dev SABIT DEGIL, factory'den gelir. Spec 5.3 iki profil tanimlar ve
    ///      ikisi yalnizca `V`'de ayrisir: testnet 4,292 USDC, uretim 4.292
    ///      USDC (tam 1000x). Sabit yazilsaydi arcpad testnet profilini hic
    ///      deploy edemezdi -- ve testnet'in kucuk esigi kozmetik degil
    ///      ZORUNLUDUR: Circle faucet'i istek basina 10 USDC verir, uretim
    ///      esigi olan 12.161 USDC ile hicbir token mezun edilemez, yani
    ///      graduation/hook/havuz kodunun hicbiri test edilemezdi.
    ///
    ///      Profili FACTORY kendi immutable'larinda tutar ve deploy ettigi her
    ///      curve'e gecirir: tek kod tabani, build catallanmasi yok, testnet
    ///      ile uretim yalnizca factory'nin deploy argumanlarinda ayrisir.
    ///      Task 3'un CREATE2 kurgusunu bozmaz -- parametreler factory basina
    ///      sabittir ve `isCanonical` adresi TOKEN'dan yeniden turetir.
    uint256 public immutable INITIAL_VIRTUAL_TOKEN_RESERVES;

    /// @notice Sanal quote rezervi `V`. Uretim degeri pump.fun'in canli
    ///         `Global` hesabindaki `initial_virtual_quote_reserves =
    ///         4_292_000_000` (6 decimal USDC) degerinin 18 decimal native
    ///         gorunumudur ve acilis FDV'sini tam 4.000 USDC'ye oturtur
    ///         (4292 / 1,073 = 4000).
    uint256 public immutable INITIAL_VIRTUAL_QUOTE_RESERVES;

    /// @notice Satis arzi `S`; ilk `realTokenReserves`. Curve TUM arzi custody
    ///         eder ama yalnizca bunu satar; `N - S` artigi graduation'da
    ///         havuza gider.
    uint256 public immutable INITIAL_REAL_TOKEN_RESERVES;

    /// @notice `bind`'i cagirabilecek tek adres: bu curve'u deploy eden.
    address public immutable factory;

    /// @notice Creator payinin alicisi. SIFIR OLABILIR -- o zaman creator payi
    ///         hic alinmaz.
    address public immutable creator;

    /// @notice Ucretlerin yatirildigi pull-based defter.
    /// @dev IMMUTABLE KALIR, `protocolTreasury`nin aksine, ve asimetri
    ///      bilinclidir: escrow BIRIKMIS alacaklari tutar. Onu dondurmek her
    ///      curve'un gecmis ucretlerini yeni bir deftere degil, ESKI defterde
    ///      talep edilebilir halde birakir -- yani rotasyon alacagi tasimaz,
    ///      yalnizca defteri catallar. Treasury'de boyle bir sey yoktur:
    ///      `owed[eski]` eski adresin talebi olarak aynen durur, rotasyon
    ///      YALNIZCA gelecekteki yatirimlarin alicisini degistirir.
    address public immutable escrow;

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

    /// @notice TERMINAL bayrak: `D` token ve `R` quote graduation hedefine
    ///         geri alinamaz sekilde teslim edildi; curve bir daha hicbir
    ///         varlik hareket ettirmez.
    ///
    /// @dev `complete`IN HEMEN ARDINDAN DECLARE EDILMEK ZORUNDA ve bu bir uslup
    ///      tercihi degil: boylece `complete` ile AYNI SLOT'a paketlenir
    ///      (olculdu: slot 5, offset 1), graduation zaten sifir olmayan bir
    ///      slota tek bir SSTORE yapar ve kontrat YENI SLOT KAZANMAZ. Deploy
    ///      edildikten sonra bu duzen her curve icin sonsuza kadar sabittir;
    ///      araya ya da oncesine bir alan eklemek onu sessizce kaydirir.
    ///      `BondingCurve.t.sol` slot ve offset'i derleme ciktisindan okuyup
    ///      pinler.
    ///
    /// @dev BAYRAK OLMAK ZORUNDA, cikarsanamaz. `complete` bunu TASIYAMAZ
    ///      (graduation'dan once de true'dur) ve HICBIR BAKIYE tasiyamaz:
    ///      Arc'ta ucuncu bir taraf curve'un iki bakiyesini de curve'de hicbir
    ///      kod calistirmadan artirabilir (bkz. `graduate()`), yani "bakiye
    ///      sifir" terminal olmanin gostergesi DEGILDIR. Solana portunda bu
    ///      hata sessizce dogrudur; burada degildir.
    ///
    /// @dev MONOTON: temizleyen bir yol YOKTUR -- owner yok, rescue yok,
    ///      reinitialiser yok. Ve `graduated => complete`, cunku
    ///      `graduate()`in ILK korumasi `!complete`tir. Tersi TUTMAZ ve
    ///      tutmamalidir.
    bool public graduated;

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

    /// @notice Curve terminal duruma gecti: `baseAmount` token ve
    ///         `quoteAmount` quote graduation hedefine odendi.
    ///
    /// @dev BU OLAY OLMADAN Faz 3'un indexer'i bir curve'un terminal oldugunu
    ///      ancak olay semasi HENUZ VAR OLMAYAN bir Faz 2 kontratini izleyerek
    ///      ogrenebilirdi -- yani bitmis katmandan yazilmamis katmana bir
    ///      bagimlilik. Bu yuzeyin varlik sebebi tam olarak o bagimliligi
    ///      onlemektir.
    ///
    /// @dev `to` INDEKSLIDIR cunku hedef yeniden isaretlenebilir (factory'nin
    ///      3 gunluk gecikmeli setter'i): "bu havuzu hangi hedef tohumladi"
    ///      indexer'in soracagi bir sorudur.
    ///
    /// @dev ISIM CARPISMASI UYARISI -- KAYDA GECIRILIYOR. Spec 5.6 adim 7
    ///      havuz/locker katmaninda da bir `Graduated` olayindan soz eder. Iki
    ///      kontratin FARKLI sekilli iki `Graduated` yayinlamasi indexer icin
    ///      bir tuzaktir: topic0 ayrisir, dolayisiyla birine gore yazilmis bir
    ///      filtre otekini SESSIZCE bos dondurur. Faz 2'nin olayi
    ///      `PoolSeeded` adini almalidir; bu satir o kararin kaydidir ve
    ///      `Surface.t.sol` topic0 esitsizligini ayrica olcer.
    event Graduated(address indexed token, address indexed to, uint256 baseAmount, uint256 quoteAmount);

    // ---------------------------------------------------------------
    // Hatalar
    // ---------------------------------------------------------------

    /// @dev SIFIR MIKTAR HATALARI GIRIS NOKTASI BASINA AYRIDIR ve hicbiri
    ///      `CurveMath`'inkilerle AYNI ADI TASIMAZ. Tek bir `ZeroAmount()`
    ///      kullanan onceki hali `CurveMath.ZeroAmount()` ile ayni selector'u
    ///      (0x1f2a2005) tasiyordu; korumayi tamamen silmek bile revert
    ///      verisini degistirmiyordu, cunku cagri `quoteBuyCost` /
    ///      `netQuoteInBeforeCorrection` / `quoteSellProceeds` icindeki ayni
    ///      isimli kontrole dusuyordu. Uc korumanin ucu de mutasyonla
    ///      OLDURULEMEZ durumdaydi (olculdu: 37/37 yesil). Ayri isimler bunu
    ///      duzeltir ve cagirana hangi KATMANIN reddettigini de soyler.
    error ZeroTokensOut();
    error ZeroQuoteIn();
    error ZeroTokensIn();
    /// @dev Satis geliri iki ucret parcasini karsilamiyor; satici sifir
    ///      alirdi. `ZeroTokensIn()`'den AYRIDIR: girdi gecerliydi, sonuc
    ///      degil.
    error ProceedsTooSmall();
    error CurveComplete();
    error NotEnoughTokensToBuy();
    error SlippageExceeded();
    error RefundFailed();
    error PayoutFailed();
    error TokenTransferFailed();
    error ZeroToken();
    error ZeroEscrow();
    error ZeroVirtualTokenReserves();
    error ZeroVirtualQuoteReserves();
    error ZeroSaleSupply();
    error SaleSupplyNotBelowTokenReserves();
    /// @dev Bagli token'in curve'de tuttugu bakiye, curve'un satmayi
    ///      planladigi (`S`) ve graduation'da havuza tohumlamayi planladigi
    ///      (`D`) miktarlarin TOPLAMINI karsilamiyor.
    error TokenBalanceBelowSaleAndSeed();
    error TokenDoesNotPointBack();
    error NotFactory();
    error AlreadyBound();
    error NotBound();

    /// @dev `CurveComplete()`TEN AYRI BIR HATA VE AYRI BIR SELECTOR, ve bu bir
    ///      yeniden kullanim reddi: ikisi ayni yuklemenin TERS yonleridir
    ///      (biri "tamamlandi, ticaret yok", oteki "henuz tamamlanmadi,
    ///      graduation yok"). Deponun `ZeroAmount` carpismasindan dogan kurali
    ///      revert verisinin HANGI KATMANIN, HANGI YONDE reddettigini
    ///      soylemesidir.
    error NotComplete();

    /// @dev IKINCI CAGRI SESSIZ BIR NO-OP DEGIL REVERT'TIR (D5), pump.fun'in
    ///      tersine. GEREKCE DUZELTILDI (inceleme, olculdu): "EVM'de cagiran
    ///      zorunlu olarak bir kontrattir" YANLISTIR -- hedef bir EOA olabilir
    ///      ve o EOA `graduate()`i dogrudan cagirip `R` ile `D`yi alir
    ///      (olculdu). Kalan ve DAHA GUCLU gerekce sudur: bes basarisizlik
    ///      modunun BESI DE AYRI SELECTOR tasir, dolayisiyla cagiran -- kontrat
    ///      da olsa EOA da olsa -- "zaten mezun oldu"yu baska hicbir
    ///      basarisizlikla karistiramaz. Sessiz bir `(0, 0)` ise BOS bir
    ///      curve'un gercek graduation'indan ayirt EDILEMEZ ve dogal devami
    ///      (havuzu `R/D` fiyatindan acmak) sifira bolerdi.
    /// @dev FAZ 2 YUKUMLULUGU: toplu bir keeper girisi (`graduateMany([...])`)
    ///      her curve'u `try/catch` ile sarmak ZORUNDADIR, aksi halde zaten
    ///      mezun olmus tek bir curve butun partiyi revert ettirir.
    error AlreadyGraduated();

    /// @dev SIRASI TASIYICIDIR: cagiran kontrolunden ONCE gelir. Sonra gelse
    ///      yalnizca `msg.sender == address(0)` iken ulasilabilir olurdu; once
    ///      gelince Faz 2 var olmadigi surece herkesin gorecegi hata BUDUR --
    ///      yani bu kontratin uretecegi en olasi gercek revert.
    /// @dev DURUST NOT: TASIYICI DEGILDIR. Olculdu -- OZ'un `ERC20.transfer`i
    ///      `address(0)`a revert eder ve spec 3.3 Arc'ta sifir adrese native
    ///      gonderimin yasak oldugunu kaydeder. Bu kontrol olmasa koruma
    ///      TAMAMEN bir bagimliligin ve bir zincir ozelliginin icinde ORTUK
    ///      kalirdi -- deponun adi konmus "kimsenin yazmadigi bir sebeple gecen
    ///      test" hatasi. Kontrol onu ACIK yapar.
    error GraduationTargetUnset();

    /// @dev D4: `graduate()`i YALNIZCA cozulmus hedef cagirabilir.
    ///      Izinsizlik hedefin KENDI girisine tasinir (pump.fun'in ozelligi
    ///      orada birebir yeniden uretilir), cunku deger transferi alicinin
    ///      kodunu CURVE'UN cagri cercevesinde calistirir -- `FeeEscrow` kisit
    ///      (2)'nin escrow'un icinden duzeltilemeyen hazirdi. Bu kontrol
    ///      ayrica UCUNCU BIR TARAFIN kurtarilamaz duruma (hedef kabul eder ama
    ///      havuzu tohumlayamaz) girmeye ZORLAMASINI imkansiz kilar.
    error NotGraduationTarget();

    /// @dev `PayoutFailed()` (satici odemesi) ve `RefundFailed()`ten AYRI, ayni
    ///      katman-kimligi gerekcesiyle. "Reddeden bir havuz bir launch'i
    ///      strand EDEMEZ" ozelligini CIKARSANABILIR degil GOZLENEBILIR yapan
    ///      sey budur.
    error GraduationPayoutFailed();

    /// @dev PROTOKOL TREASURY ARGUMANI YOKTUR ve olmamalidir; `protocolTreasury()`
    ///      her yatirimda factory'den okunur. Gerekcesi asagida, o
    ///      fonksiyonun basinda.
    constructor(
        address creator_,
        address escrow_,
        uint256 virtualTokenReserves_,
        uint256 virtualQuoteReserves_,
        uint256 saleSupply_
    ) {
        if (escrow_ == address(0)) revert ZeroEscrow();
        if (virtualTokenReserves_ == 0) revert ZeroVirtualTokenReserves();
        if (virtualQuoteReserves_ == 0) revert ZeroVirtualQuoteReserves();
        if (saleSupply_ == 0) revert ZeroSaleSupply();
        // `S < T` bu kontratin TASIYICI esitsizligidir, kozmetik bir kontrol
        // degil. Ondan cikan `realTokenReserves < virtualTokenReserves`
        // her zaman dogru olur (fark sabit `T - S`), ve `quoteBuyCost`'un
        // `tokensOut < tokenReserve` on kosulu -- kismanin rezervin TAMAMINI
        // satin aldigi durum dahil -- hicbir zaman ihlal edilemez. Ayrica
        // `poolSeedSupply` ve `graduationRaise` `S >= T`'de tanimsizdir.
        // Kontrol acikca burada durur, cunku aksi halde revert
        // `CurveMath.InsufficientTokenReserve()` olurdu ve hatanin hangi
        // katmandan geldigi kaybolurdu.
        if (saleSupply_ >= virtualTokenReserves_) revert SaleSupplyNotBelowTokenReserves();

        factory = msg.sender;
        creator = creator_;
        escrow = escrow_;

        INITIAL_VIRTUAL_TOKEN_RESERVES = virtualTokenReserves_;
        INITIAL_VIRTUAL_QUOTE_RESERVES = virtualQuoteReserves_;
        INITIAL_REAL_TOKEN_RESERVES = saleSupply_;
        poolSeedSupply = CurveMath.poolSeedSupply(saleSupply_, virtualTokenReserves_);

        virtualTokenReserves = virtualTokenReserves_;
        virtualQuoteReserves = virtualQuoteReserves_;
        realTokenReserves = saleSupply_;
    }

    // ---------------------------------------------------------------
    // Protokol payinin alicisi -- KOPYA DEGIL, CANLI OKUMA
    // ---------------------------------------------------------------

    /// @notice Protokol payinin alicisi; her yatirimda FACTORY'DEN okunur.
    ///
    /// @dev NICIN IMMUTABLE BIR KOPYA DEGIL. `FeeEscrow` kisit (4) sunu
    ///      soyluyor: bloklanmis bir alicinin bakiyesi kalici olarak donar, ve
    ///      "operasyonel karsilik: protokol ucret ALICI ADRESI dondurulebilir
    ///      olmalidir". Kopya tutan hal o karsiligi TASIMIYORDU ve iki
    ///      basarisizligi vardi:
    ///        (1) Arc treasury'yi bloklarsa ticaret calismaya DEVAM eder
    ///            (alacak pull-based'dir), `owed[treasury]` sinirsiz buyur,
    ///            `claim` revert eder ve HICBIR yol yeniden yonlendirmez --
    ///            ne gelecek launch'lar icin, ne CANLI curve'ler icin. Tek
    ///            care yeni bir factory'dir, o da canli curve'lerin
    ///            gelirinden vazgecmek demektir.
    ///        (2) Olculdu: `protocolTreasury == escrow` yapistirma hatasi tek
    ///            bir 100 USDC alimda 938_271_604_938_271_605 wei'yi kalici
    ///            olarak talep edilemez yapiyordu (escrow'un `receive()`i
    ///            yoktur, `claim(escrow)` `TransferFailed()` ile doner).
    ///      Factory tarafinda tek satirlik esitsizlik korumasi (2)'yi kapatir;
    ///      (1) icin gereken sey ROTASYONUN CANLI CURVE'LERE ULASMASIDIR ve o
    ///      ancak burada, okuma aninda cozulerek saglanir. Desen yeni degil:
    ///      D2 `graduationTarget` icin ayni seyi yapar.
    ///
    /// @dev MALIYET, DURUSTCE VE OLCULEREK. Sicak yola islem basina BIR
    ///      STATICCALL ekler. Gercek factory ile kurulan bir curve'de,
    ///      okumanin derleme zamani bir sabitle degistirildigi ikizine karsi
    ///      olculdu:
    ///        buyExactTokensOut  SOGUK  191.880 vs 186.366  ->  +5.514  (+%2,96)
    ///        buyExactTokensOut  SICAK   45.178 vs  44.164  ->  +1.014  (+%2,30)
    ///        sellExactTokensIn  SICAK   38.138 vs  37.124  ->  +1.014  (+%2,73)
    ///      Soguk bedelin ayrisimi: 2.600 (adres erisimi, solc'un EXTCODESIZE
    ///      kontrolu dahil) + 2.100 (factory'nin `protocolTreasury` SLOT'unun
    ///      SOGUK SLOAD'u -- dondurulebilir olmasi onu immutable olmaktan
    ///      cikardigi icin) + ~814 (cagri, dispatch, decode). Bir islemin ILK
    ///      ticareti her zaman soguk bedeli oder.
    ///      KARSILIGINDA ALINAN: canli curve'lerin gelirinin kurtarilabilir
    ///      olmasi. Arc'in ~0,01 USD'lik islem maliyetinde %3 ~ 0,0003 USD'dir;
    ///      alternatif ise bloklanmis bir treasury'de o curve'un GELECEKTEKI
    ///      TUM protokol payini kaybetmektir. Takas nettir ve tersi degildir.
    /// @dev `graduate()` bu okumayi YAPMAZ (D7: graduation ucret almaz), yani
    ///      terminal yol bu maliyeti hic odemez: olculdu, 37.613 gaz, F1
    ///      oncesiyle BIT BIT AYNI.
    ///
    /// @dev `view` VE STATICCALL BURADA DA TASIYICIDIR. Bu cagri ticaretin
    ///      ORTASINDA yapilir; non-`view` bir arayuz beyani solc'a CALL
    ///      urettirir ve kotu niyetli bir factory curve'e geri girebilirdi.
    ///      Defter o noktada zaten yazilmistir (kati CEI), yani zarar sinirli
    ///      olurdu -- ama kapanis ORTUK olurdu, olculmus degil.
    ///
    /// @dev SIFIR KONTROLU BURADA DEGIL, FACTORY'DE. `LaunchFactory` hem
    ///      constructor'da hem setter'da `!= address(0)` ve `!= escrow`
    ///      garanti eder. Buraya bir kontrol koymak, gercek factory ile
    ///      ULASILAMAZ bir dal -- yani mutasyonla oldurulemeyen olu kod --
    ///      olurdu. Kodsuz ya da bu uyeyi tasimayan bir "factory" ile deploy
    ///      edilmis bir curve'de HER ticaret revert eder: fail-closed, ve
    ///      boyle bir curve `isCanonical` altinda zaten sahtedir.
    function protocolTreasury() public view returns (address) {
        return ILaunchFactory(factory).protocolTreasury();
    }

    /// @notice Token adresini bir kez yazar.
    /// @dev Tek yonlu bir isaretci YETMEZ: token'in da bu curve'u isaret
    ///      ettigi dogrulanir. Aksi halde curve, arzi baska bir adreste duran
    ///      bir token'a baglanir ve hicbir alimi karsilayamaz.
    ///
    /// @dev PROFIL ILE ARZ ARASINDAKI BAG BURADA KURULUR ve baska yerde
    ///      kurulamaz. Constructor `S`'i yalnizca `S < T` ile sinirlar, cunku
    ///      o anda token -- dolayisiyla arz `N` -- HENUZ BILINMEZ. Profil
    ///      factory'den geldiginden beri argumanlar iki iliskiyi ihlal
    ///      edebilir ve ikisi de bu tek kontrolde toplanir:
    ///
    ///        (1) `S <= N`. Aksi halde curve mint'in tamamini satar ve
    ///            sonraki her alim ERC-20'nin icinde revert eder; `complete`
    ///            HICBIR ZAMAN cevrilemez ve biriken quote cikisi olmayan bir
    ///            curve'de kalir.
    ///        (2) `D <= N - S`. Aksi halde graduation YAPISAL OLARAK
    ///            fonlanamaz: satistan artan token, havuzu curve'un kapanis
    ///            fiyatindan acmaya yetmez. Ornek: `S = 900_000_000e18`
    ///            uretim `T`'siyle `D ~ 1,451e26` verir ama geriye yalnizca
    ///            `1e26` kalir.
    ///
    ///      Ikisi birden `bakiye >= S + D` demektir. `N` yerine fiili bakiye
    ///      okunur cunku curve'un ilgilendigi sey odur; `bind`den once curve
    ///      token hareket ettiremez (her ticaret giris noktasi `NotBound` ile
    ///      doner), yani okunan deger mint'in tamamidir.
    ///
    /// @dev Defter dis cagrilardan ONCE yazilir; kontratin geri kalaniyla ayni
    ///      CEI disiplini. Kotu niyetli bir token'in `curve()` ya da
    ///      `balanceOf` govdesinden geri girmesi `AlreadyBound`a carpar, ve
    ///      dogrulama duserse islemin tamami zaten geri alinir.
    function bind(address token_) external {
        if (msg.sender != factory) revert NotFactory();
        if (token != address(0)) revert AlreadyBound();
        if (token_ == address(0)) revert ZeroToken();

        token = token_;

        // Asagidaki iki cagri da `view`'dir (`ICurveBoundToken.curve()` ve
        // `IERC20.balanceOf`), dolayisiyla solc STATICCALL uretir. YENIDEN
        // GIRISI KAPATAN SEY BUDUR, `AlreadyBound` degil: bu kontrata geri
        // giren her yol depolamaya yazar ve STATICCALL altinda revert eder --
        // olculdu. `view` BURADA TASIYICIDIR. `ICurveBoundToken`'a ileride
        // mutasyona ugratan bir el sikisma eklenirse, dusman bir token
        // bakiyesi HENUZ DOGRULANMAMIS bir curve'e karsi islem yapabilir:
        // bu noktada `token` yazilmis, rezervler canli ve asagidaki bakiye
        // korumasi daha calismamistir. `AlreadyBound` bunu durdurmaz, cunku
        // yalnizca `bind`'i korur.
        if (ICurveBoundToken(token_).curve() != address(this)) revert TokenDoesNotPointBack();

        // `S + D`'nin tek seferde kapattigi iki iliski: `S <= N` ve
        // `D = S(T-S)/T <= N - S`. Ikincisi olmadan graduation yapisal olarak
        // fonlanamaz -- `S = 900_000_000e18` birinciyi saglar, ikincisini
        // bozar. Tasma imkansizdir: her `S < T` icin `S + D <= T`, cunku
        // `S(2T-S)/T <= T` ile `(T-S)^2 >= 0` denktir.
        //
        // BU BIR YAPILANDIRMA KONTROLUDUR, MULKIYET KANITI DEGIL. `bind`
        // yalnizca "curve'u geri isaret eden" bir token ister; ERC20
        // davranisini dogrulamaz. Sahip olmadigi bir bakiyeyi bildiren bir
        // token bu korumayi gecer -- olculdu. DOLAYISIYLA FACTORY YALNIZCA
        // KENDI BASTIGI TOKEN'LARI BIND ETMEK ZORUNDADIR; korumanin butun
        // gucu bu yukumlulugun tutulmasina baglidir.
        if (IERC20(token_).balanceOf(address(this)) < INITIAL_REAL_TOKEN_RESERVES + poolSeedSupply) {
            revert TokenBalanceBelowSaleAndSeed();
        }
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
        if (tokensOut == 0) revert ZeroTokensOut();
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
        if (msg.value == 0) revert ZeroQuoteIn();

        // Creator sifirsa creator bps'i de SIFIRDIR ve bu ternary'nin
        // dusmesi butun giris noktasini kalici olarak kirar:
        // `correctedNetQuoteIn` sifir olmayan bir creator payi dondurur,
        // `_settleBuy` onu `deposit{value: creatorFee}(address(0))` ile
        // yatirmaya calisir ve `FeeEscrow` `ZeroRecipient()` ile revert eder.
        // Yani sifir-creator'lu bir curve'de HER `buyExactQuoteIn` sonsuza
        // kadar revert ederdi. Diger iki yolda ayni ozellik testliydi, bu
        // yolda DEGILDI (olculdu: mutasyon 37/37 yesil birakiyordu).
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
        if (tokensIn == 0) revert ZeroTokensIn();

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensIn, virtualQuoteReserves, virtualTokenReserves);
        uint256 protocolFee = CurveMath.feeOn(proceeds, PROTOCOL_FEE_BPS);
        uint256 creatorFee = creator == address(0) ? 0 : CurveMath.feeOn(proceeds, CREATOR_FEE_BPS);

        // `quoteSellProceeds` tabana yuvarlar ve sifir verebilir; ustelik
        // proceeds 1 ya da 2 iken iki ucret parcasi (ikisi de tavana
        // yuvarlandigi icin en az 1) toplami proceeds'i yutar. Escrow'a
        // dokunmadan ONCE eleniyor: aksi halde ya satici sifir alir ya da
        // cikarma altan tasar. `FeeEscrow.deposit` sifir tutarda revert
        // ettigi icin bu ayni zamanda escrow kisiti 3'un geregidir.
        if (proceeds <= protocolFee + creatorFee) revert ProceedsTooSmall();
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
        // MUTASYONLA OLDURULEMEZ VE BU BEKLENIYOR: `LaunchToken` OZ'un
        // ERC20'sidir ve basarisizlikta REVERT eder, asla `false` DONMEZ --
        // yani `!ok` dali bu token ile ulasilamaz ve korumayi silmek
        // esdeger bir mutanttir. Yine de duruyor: `bind` yalnizca
        // "curve'u geri isaret eden" bir token ister, ERC20 davranisini
        // dogrulamaz, ve dondugunde sessizce basarisiz olan bir token
        // korumasiz halde arzi bedava dagitirdi.
        if (!IERC20(token_).transferFrom(msg.sender, address(this), tokensIn)) revert TokenTransferFailed();
        // ALICI YATIRIM ANINDA COZULUR, kurulumda degil (bkz.
        // `protocolTreasury()`). Okuma dis cagri bolumunun ICINDE durur:
        // defterin tamami ondan once yazilmistir, yani CEI'nin LAFZI da
        // korunur -- `bind`'inki gibi bir sapma yok.
        IFeeEscrow(escrow).deposit{value: protocolFee}(protocolTreasury());
        _settleCreatorFee(token_, creatorFee);

        (bool ok,) = msg.sender.call{value: netOut}("");
        if (!ok) revert PayoutFailed();
    }

    /**
     * @notice Creator ucretini oder; buyback aciksa bir kismini AYIRIR.
     *
     * @dev ============ PROTOKOL PAYINA HIC DOKUNULMAZ ============
     *
     *      Bu fonksiyon yalnizca `creatorFee` gorur. `protocolFee` kendi
     *      bps'inden hesaplanir ve buraya HIC GIRMEZ, dolayisiyla "buyback
     *      protokol gelirini azaltir" hatasi bir DIKKAT meselesi degil, bir
     *      IMKANSIZLIKTIR. Referans uygulamada ayni ozellik bir SIRALAMA
     *      disiplinidir (once protokol payini ayir, sonra kalani bol) cunku
     *      orada tek bir taban ucret vardir; bizde iki bagimsiz bps oldugu icin
     *      ayrim tipin kendisinde durur.
     *
     * @dev ============ ISARETLEME BURADA, SUPURMEDE DEGIL ============
     *
     *      Pay, ucretin KAZANILDIGI islemde ayrilir. Bir launch buyback'i
     *      sonradan kapatirsa ONCEDEN ayrilmis para hazinede kalir ve buyback
     *      olarak harcanir; kapaliyken biriken ucret de sonradan acilmakla
     *      buyback'e donusemez, cunku hic yatirilmamistir. Spec'in istedigi
     *      "eski ucretler eski politikayi izler" ozelligi bu satirdan gelir --
     *      ayri bir `pending` alanina gerek yoktur.
     *
     * @dev Hazineye yapilan cagri `payable`dir ve BIR DIS CAGRIDIR; defterin
     *      tamami bundan once yazilmistir (cagiran `_settleBuy`/satis yolunun
     *      dis cagri bolumu). Hazine yalnizca kendi depolamasina yazar ve
     *      curve'e geri girmez.
     */
    function _settleCreatorFee(address token_, uint256 creatorFee) private {
        if (creatorFee == 0) return;

        (address treasury, uint256 lockBps) = ILaunchFactory(factory).buybackPolicy(token_);
        // `treasury == 0` KAPALI demektir; carpim hic yapilmaz.
        uint256 buybackQuote = treasury == address(0) ? 0 : (creatorFee * lockBps) / 10_000;

        if (buybackQuote != 0) IBuybackTreasury(treasury).accrue{value: buybackQuote}(token_);

        uint256 creatorCash = creatorFee - buybackQuote;
        // Kosul KALMALIDIR: `FeeEscrow.deposit` sifir tutarda revert eder ve
        // `lockBps == 10_000` durumunda nakit pay TAM SIFIR olur.
        if (creatorCash != 0) IFeeEscrow(escrow).deposit{value: creatorCash}(creator);
    }

    // ---------------------------------------------------------------
    // Graduation -- curve'un TEK cikis yolu
    // ---------------------------------------------------------------

    /// @notice Tamamlanmis curve'un havuz tohumunu (`D` token) ve topladigi
    ///         quote'u (`R`) graduation hedefine oder ve terminal duruma gecer.
    /// @return baseAmount Odenen token: `poolSeedSupply`, IMMUTABLE.
    /// @return quoteAmount Odenen quote: `realQuoteReserves`, DEFTERDEN.
    ///
    /// @dev D1 -- TAMAMLAYICI ALIMIN ICINDE DEGIL, AYRI BIR CAGRI. Katlanmis
    ///      halin olculen sonucu (inceleme, `BondingCurveFolded`): reddeden bir
    ///      hedefle `S - 1` token alan alim BASARIR, arzin son 1 wei'sini alan
    ///      alim SONSUZA KADAR revert eder ve satislar CALISMAYA DEVAM EDER.
    ///      Yani bricklenen sey TICARET degil TAMAMLANMADIR: satis arzinin son
    ///      dilimi kalici olarak alinamaz hale gelir ve curve terminal duruma
    ///      hic ulasamaz. Ayrildiginda ayni basarisizlik bir YENIDEN DENEMEDIR.
    ///      (Bu cumle inceleme sonrasi duzeltilmistir; tasarimin ilk hali
    ///      "ticaret kalici olarak bricklenir" diyordu ve o OLCULEREK fazla
    ///      genis bulundu.)
    ///
    /// @dev D2 -- HEDEF CAGRI ANINDA COZULUR, launch aninda degil. Uc secenegin
    ///      yalnizca bu olani Faz 1'in Faz 2'den ONCE deploy edilip launch
    ///      etmesine izin verir, ve digerlerinin aksine curve'e ne bir slot ne
    ///      bir constructor argumani ekler. DAHA GUCLU GEREKCE (inceleme):
    ///      TAMAMLANMA ANINDA cozulseydi, hedef atanmadan once tamamlanan her
    ///      curve `address(0)`i latch eder ve KALICI OLARAK strand olurdu --
    ///      yani D3'un en kotu durumu, erken tamamlanan her launch icin
    ///      yapisal garanti haline gelirdi.
    ///      TAKAS KAYDA GECIRILIYOR: cagri aninda okumak, ZATEN TAMAMLANMIS
    ///      curve'lerin de yeniden yonlendirilebilmesi demektir, dolayisiyla
    ///      D3'un gecikmesi bir YARISTIR (bekleyen graduation'lari degisiklik
    ///      inmeden once bosaltmak). Tamamlanma aninda cozmek onlari bagisik
    ///      yapardi ama karsiliginda kalici strand sinifini geri getirirdi.
    ///
    /// @dev D4 -- YALNIZCA COZULMUS HEDEF CAGIRABILIR; izinsizlik hedefin kendi
    ///      girisine tasinir. Ucu de olculdu: deger transferi alicinin kodunu
    ///      curve'un cercevesinde calistirir (`FeeEscrow` kisit (2)); tek bir
    ///      hedef her launch'a hizmet ettigi icin push edilen bir odemede hedef
    ///      HANGI launch'in odedigini bakiye farkindan cikarmak zorunda kalirdi
    ///      -- Arc'ta bakiye disaridan degisebildigi icin guvenilmez bir olcum;
    ///      ve callback alternatifi Faz 2'nin selector'unu bu bytecode'a sonsuza
    ///      kadar gomerdi.
    ///      LIVENESS'I KOTULESTIRMEZ: bozuk-hedef yollarinin hepsi ya oldugu
    ///      gibi yeniden denenebilir ya da factory'de hedefi yeniden
    ///      isaretleyerek cozulur (olculdu).
    ///
    /// @dev DUZELTME -- BU KONTROL "KABUL ET SONRA TOHUMLAYAMA" DURUMUNU
    ///      IMKANSIZ KILMAZ, YALNIZCA KARARI TASIR. Onceki hali bunu
    ///      "ucuncu bir tarafin zorlamasi imkansiz" diye yaziyordu ve o
    ///      IFADE YANLISTI: kontrol, "ne zaman" kararini CURVE'DEN HEDEFE
    ///      tasir; kaldirmaz. Faz 2 tasarimin varsaydigi IZINSIZ seeder'i
    ///      gonderdigi anda -- ki gondermelidir, pump.fun'in ozelligi odur --
    ///      tamamlanmis bir curve'de o girisi herhangi bir yoldan gecen
    ///      cagirabilir, ve kabul YENIDEN zorlanabilir hale gelir.
    ///
    ///      Curve'un fiilen aldigi sey daha dar ve dogru soylenmelidir:
    ///      transferin ICINDE bulundugu cerceveyi HEDEFIN KENDI KODU secer,
    ///      dolayisiyla "kabul et sonra tohumlayama" ancak hedefin kendi
    ///      cercevesinde MUMKUN OLURSA mumkundur. Bu yuzden FAZ 2
    ///      YUKUMLULUGU (1) BIR IMA DEGIL, ACIK BIR SARTTIR: hedefin girisi
    ///      isin TAMAMINI tek islemde yapmali ve HERHANGI bir basarisizlikta
    ///      revert etmelidir. O tutuldugunda curve tarafindaki atomiklik havuz
    ///      olusumuna bedava genisler; tutulmadiginda kurtarilamaz durum
    ///      GERI GELIR ve curve'de onu engelleyecek hicbir sey YOKTUR.
    ///      Bir sonraki uygulayici "imkansiz" okuyup kurtarma yolunu
    ///      yazmayabilir; bedeli tam olarak budur.
    ///
    /// @dev D6 -- MIKTARLAR IMMUTABLE VE DEFTERDEN, HICBIR BAKIYEDEN DEGIL.
    ///      pump.fun havuzu curve'un KALAN TUM token bakiyesiyle tohumlar;
    ///      arcpad `D`yi kullanir ve bu bilincli bir sapmadir. Sebep fiyat
    ///      farkinin buyuklugu DEGILDIR (olculdu: `N - S` secimi havuzu
    ///      `P_final`in 67.611 ppb altinda acar, cikarilabilir arbitraj
    ///      graduation basina ~1,4e-5 USDC -- ekonomik olarak pump.fun'in
    ///      secimi savunulabilir). Sebep EPISTEMIKTIR: Arc'ta ucuncu bir taraf
    ///      curve'un IKI bakiyesini de curve'de hicbir kod calistirmadan
    ///      artirabilir (canli olcum, `FeeEscrow` kisit (1): 6 decimal ERC-20
    ///      gorunumunden yapilan `transfer` native bakiyeyi artirdi ve
    ///      `receive()` HIC calismadi). Bakiye okuyan bir hal, spec 10
    ///      invariant 6'yi "BAGIS OLMADIGI SURECE" gecerli bir iddiaya
    ///      cevirirdi -- kimsenin uygulayamayacagi bir on kosul ve hicbir
    ///      testin kazara ihlal etmeyecegi bir sessizlik.
    ///      Olculdu: +7 ether native ve +1000e18 token bagisi ile bile donen
    ///      degerler tam olarak `(D, R)`dir ve bagislar curve'de kalici olarak
    ///      kilitlenir.
    ///
    /// @dev D7 -- GRADUATION UCRETI YOK, "simdilik sifir" degil YAPISAL SIFIR.
    ///      Ucret yalnizca `R`den alinabilir, cunku `D` immutable'dir; `R - f`
    ///      degismemis bir `D`ye karsi havuzu `P_final`in `f/R` altinda acar.
    ///      Olceklendi: pump.fun'in 0,015 SOL'u kendi raise'inin 176,5 ppm'i,
    ///      arcpad'in yasakladigi `N - S` sureksizligi 67,6 ppm, 2 USDC'lik bir
    ///      ucret 164,5 ppm -- yani bir migration ucreti, spec'in ZATEN
    ///      yasakladigi kusurun 2,6 KATIDIR. Arc'ta rent yoktur, dolayisiyla
    ///      upstream'in ucretinin odedigi seyin karsiligi da yoktur.
    ///
    /// @dev SIRA BAGLAYICIDIR ve tam olarak UC dis cagri vardir:
    ///        1. DOGRULA   `!complete`               -> NotComplete
    ///                     `graduated`               -> AlreadyGraduated
    ///                     STATICCALL graduationTarget()   <-- dis #1, YAZAMAZ
    ///                     `target == 0`             -> GraduationTargetUnset
    ///                     `msg.sender != target`    -> NotGraduationTarget
    ///        2. DEFTER    `graduated = true`              <-- tek SSTORE
    ///        3. OLAY      `Graduated(...)`
    ///        4. CAGRILAR  token transferi                 <-- dis #2
    ///                     native odeme                    <-- dis #3
    ///      1. adimdaki okumanin yazimdan once olmasi CEI'nin LAFZINDAN bir
    ///      sapmadir ve `bind`'in ICERDIGI sapmanin aynisidir; guvenli olmasi
    ///      VARSAYIM DEGIL OLCUMDUR: `graduationTarget()`i SSTORE yapan bir
    ///      factory `view` arayuz uzerinden cagrildiginda `graduate()` revert
    ///      eder ve yazim sayaci 0 kalir; AYNI fonksiyon statik olmayan bir
    ///      cagriyla 1'e cikar (kontrol grubu -- o olmadan test "herhangi bir
    ///      sebeple revert eden" bir kontratta da gecerdi).
    ///
    /// @dev BAYRAK ODEMEDEN ONCE YAZILIR VE BU ATOMIKLIK SAYESINDE GUVENLIDIR.
    ///      Odeme basarisiz olursa islem revert eder ve SSTORE de her seyle
    ///      birlikte geri alinir: olculdu -- `receive()`i revert eden bir
    ///      hedefte `GraduationPayoutFailed()` doner, `graduated()` hala
    ///      `false`, token transferi geri alinmis ve curve `R`yi tutuyor;
    ///      hedef onarildiktan sonra ayni cagri BASARIR ve ayni `(D, R)`yi
    ///      dondurur. Yani ATOMIKLIK YENIDEN DENENEBILIRLIGI SAGLAR ve CEI
    ///      reentrancy guvenligini BEDAVA verir. Bayragi cagrilarin ARKASINA
    ///      almak (pump.fun'in Solana sirasi) geri girisin `NotComplete` ve
    ///      `AlreadyGraduated` korumalarini ASMASINA yol acar.
    ///      DUZELTME (reentrancy fuzzing kampanyasi, olculdu): koruma bypass'i
    ///      GERCEK ama `2D`/`2R` DEGIL. Geri giren cerceve TABAN BACAGINDA
    ///      olur -- OZ `ERC20InsufficientBalance` (`0xe450d38c`) -- cunku
    ///      curve'de kalan artik `N-S-D ~ 1.5e21`, ikinci bir `D ~ 2.07e26`nin
    ///      bes kat buyukluk altinda, ve taban bacagi quote bacagindan ONCE
    ///      siralanir. Obur taraftan da dogrulandi: bu mutasyon altinda
    ///      `nativeIsConserved` ve `everyCurveCoversItsOwnLedger` GECTI.
    ///      Asil sonuc miktar degil GORUNURLUK: graduation ortasindaki bir
    ///      curve, kontrolu verdigi her koda karsi GOZLEMLENEBILIR SEKILDE
    ///      ODEME GUCSUZ olur. Testler bu yuzden hem revert'i hem miktarlari
    ///      degil, ARA DURUMU iddia eder.
    ///
    /// @dev UC TICARET GIRIS NOKTASI `graduated` KONTROLU ICERMEZ ve icermemeli.
    ///      Cikarim zinciri: `graduated => complete` (1. koruma),
    ///      `complete` => geri alinmaz (mevcut invariant), `complete` => uc
    ///      giris noktasinin UCU DE `CurveComplete()` ile revert eder (mevcut,
    ///      giris noktasi BASINA olculur), `complete` => bound. Eklenecek bir
    ///      `graduated` kontrolu mutasyonla OLDURULEMEZ olu kod olurdu. Ama
    ///      zincir bir ON KOSULDUR ve bu depoda on kosullar pinlenir: her halka
    ///      icin graduation cercevesinden, giris noktasi basina ve REVERT
    ///      VERISI uzerinde iddia edilir -- "revert etti" demek yetmez, cunku
    ///      alim yollarinda `complete` korumasini silmek davranisi degistirmez.
    ///
    /// @dev IKI YENIDEN GIRIS PENCERESI DAHA VARDIR VE IKISI DE ULASILABILIR
    ///      (olculdu, inceleme):
    ///        (a) CAPRAZ CURVE: hedefin `receive()`i, curve A'nin odemesi
    ///            icinde curve B'nin `graduate()`ini cagirir; `msg.sender`
    ///            hedefin KENDISI oldugu icin kontrol gecer ve iki curve tek
    ///            islemde mezun olur (hedef `R1+R2` ve `D1+D2` ile kapatir).
    ///            Ucuncu bir tarafca somurulemez; Faz 2 yukumlulugu (2)'nin --
    ///            "hedefin `receive()`i CIPLAK bir kabul olmalidir" -- somut
    ///            icerigi tam olarak budur.
    ///        (b) TAMAMLAYICI ALIMIN ICINDE: hedef ayni zamanda tamamlayici
    ///            islemin alicisiysa, `_settleBuy`'un iadesi onun `receive()`ini
    ///            `complete = true` OLDUKTAN SONRA calistirir, dolayisiyla
    ///            `graduate()` bir ticaretin cercevesinden basarir. Zararsizdir
    ///            (cift harcama yok, bitis durumu olagan graduation sonrasi
    ///            durumdur) -- ama D1'in ayrimi bir SOZLESMEDIR, kodun
    ///            zorladigi bir invariant DEGIL.
    ///
    /// @dev BAZ BACAGINDA `TokenTransferFailed()` YENIDEN KULLANILIR ve bu
    ///      BILINCLIDIR (inceleme bunu isaretledi, kayit burasidir): `LaunchToken`
    ///      OZ ERC20'dur, basarisizlikta revert eder ve asla `false` DONMEZ --
    ///      yani `!ok` dali bu token ile ULASILAMAZ ve ayri bir hata adi
    ///      mutasyonla ayirt edilemeyecek bir selector daha eklemekten baska bir
    ///      sey yapmazdi. Quote bacagi FARKLIDIR: orada `!ok` gercekten
    ///      ulasilabilir, bu yuzden orada ayri bir hata (`GraduationPayoutFailed`)
    ///      vardir.
    function graduate() external returns (uint256 baseAmount, uint256 quoteAmount) {
        // --- 1. DOGRULA ---
        if (!complete) revert NotComplete();
        if (graduated) revert AlreadyGraduated();

        address target = ILaunchFactory(factory).graduationTarget();
        if (target == address(0)) revert GraduationTargetUnset();
        if (msg.sender != target) revert NotGraduationTarget();

        // DEFTERDEN VE IMMUTABLE'DAN, HICBIR BAKIYEDEN DEGIL.
        baseAmount = poolSeedSupply;
        quoteAmount = realQuoteReserves;

        // --- 2. DEFTERI YAZ (her dis cagridan ONCE) ---
        graduated = true;

        // --- 3. OLAY ---
        emit Graduated(token, target, baseAmount, quoteAmount);

        // --- 4. DIS CAGRILAR ---
        if (!IERC20(token).transfer(target, baseAmount)) revert TokenTransferFailed();
        (bool ok,) = target.call{value: quoteAmount}("");
        if (!ok) revert GraduationPayoutFailed();
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
        // Satis yolundakiyle ayni gerekce: OZ ERC20 `false` dondurmedigi icin
        // bu koruma esdeger bir mutanttir (oldurulemez) ama bilerek duruyor.
        if (!IERC20(token_).transfer(msg.sender, tokensOut)) revert TokenTransferFailed();

        // `protocolFee` sifir OLAMAZ (`quoteBuyCost` en az 1 doner ve `feeOn`
        // tavana yuvarlar), ama `creatorFee` creator sifirken sifirdir -- bu
        // yuzden kosullu. Kosulu kaldirmak, `FeeEscrow.deposit` sifir tutarda
        // revert ettigi icin HER islemi kirardi.
        //
        // ALICI YATIRIM ANINDA COZULUR; satis yolundaki ayni satirin notu
        // gecerlidir.
        IFeeEscrow(escrow).deposit{value: protocolFee}(protocolTreasury());
        _settleCreatorFee(token_, creatorFee);

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
