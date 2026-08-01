// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BondingCurve} from "./BondingCurve.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {LaunchToken, LAUNCH_TOKEN_TOTAL_SUPPLY} from "./LaunchToken.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {GraduationMath} from "./libraries/GraduationMath.sol";

/// @title LaunchFactory
/// @notice Token ve curve ureten TEK yol, ve bir token'in kimliginin
///         sahteciilige kapali kanidi.
///
/// @dev SORUN. pump.fun'da `BondingCurve` hesabinda `mint` alani YOKTUR;
///      eslesme saf bir PDA turetmesidir (`["bonding-curve", mint]`) ve bu
///      yuzden herkes bir mint'ten curve'u yeniden turetip dogrulayabilir.
///      Saklanan bir isaretci bu ozelligi TASIMAZ: Faz 1b'nin custody
///      incelemesi somut sonucu olctu -- herkes gercek bir launch'in
///      creator'ini, curve'unu ve metadata URI'sini iddia eden bir
///      `LaunchToken` deploy edip tum arzini gercek curve'un adresine
///      basabilir. Zincirden okuyan bir indexer sahteyi gercege baglar.
///
/// @dev EVM'DEKI KARSILIK CREATE2'DIR ama saf hali dongusel olurdu: token'in
///      constructor'i curve adresini ister (arzi oraya basacak), curve'un
///      salt'i token adresinden turetilse iki adres birbirini beklerdi.
///
///      DONGU, DOGRULAMANIN YONU CEVRILEREK KIRILIR. CREATE2'nin tasiyici
///      ozelligi `adres = f(deployer, salt, keccak(initcode))` esitligidir ve
///      factory'den tureyen bir adrese YALNIZCA factory deploy edebilir. O
///      halde curve'u token'dan turetmeye gerek yoktur; TOKEN'I KENDI
///      VERISINDEN YENIDEN TURETMEK YETER:
///
///        1. Once curve, `salt` ile. Constructor argumanlari token'i
///           ICERMEZ, dolayisiyla adresi token'a bagli degildir.
///        2. Sonra token, AYNI salt ile; constructor argumanlari
///           `(name, symbol, uri, creator, curve, salt)` ve arz dogrudan
///           curve'e basilir.
///        3. `LaunchToken.launchSalt` sayesinde dogrulayicinin ihtiyac
///           duydugu her sey token'in uzerindedir.
///
///      Sahteci istedigi `creator()`, `curve()` ve `metadataURI()` degerlerini
///      iddia edebilir -- ama o degerlerle birlikte KENDI ADRESI factory'den
///      tureyen adrese esit olamaz. `curve`'un initcode'a dahil olmasi,
///      sahtecinin gercek bir curve'u iddia edip yine de adresi tutturmasini
///      ayrica engeller.
///
/// @dev VARSAYIM (standart CREATE2 varsayimi, kayda gecirilir): `isCanonical`
///      160 bitlik adres esitligine dayanir. Sahtecinin hem kendi deploy
///      adresini hem de iddia ettigi alanlari serbestce degistirebilmesi bunu
///      klasik bir carpisma aramasina indirger; genel maliyet ~2^80'dir. Ayni
///      varsayim her CREATE2 factory deseninin altindadir.
///
/// @dev FACTORY YALNIZCA KENDI BASTIGI TOKEN'LARI BIND EDER. Task 2'nin
///      incelemesi olctu: `BondingCurve.bind`'in bakiye korumasi bir
///      YAPILANDIRMA kontroludur, mulkiyet kaniti degil -- sahip olmadigi bir
///      bakiyeyi bildiren bir token onu gecer. Korumanin butun gucu bu
///      yukumlulugun tutulmasina baglidir, ve burada YAPISAL olarak tutulur:
///      `bind`'in bu kontrattaki tek cagri yeri `launch`'tir, orada `token`
///      ayni islemde `new LaunchToken` ile uretilmis yerel bir degiskendir ve
///      cagiranin uzerinde hicbir etkisi yoktur. Baska hicbir giris noktasi
///      bir curve'e dokunmaz.
contract LaunchFactory {
    // ---------------------------------------------------------------
    // Profil sagligi
    // ---------------------------------------------------------------

    /// @notice Acilis piyasa degerinin (`V*N/T`) alt siniri.
    ///
    /// @dev SAYI KEYFI DEGIL, OLCULEREK SECILDI: spec 5.3'un iki kutsanmis
    ///      profilinden KUCUK OLANININ acilis degerine tam oturur.
    ///        uretim : V = 4_292e18, T = 1_073e24, N = 1e27 -> 4_000e18
    ///        testnet: V = 4_292e15, ayni T ve N            ->     4e18
    ///      Testnet profilinin varligi kozmetik degil ZORUNLUDUR (Circle
    ///      faucet'i istek basina 10 USDC verir; uretim esigi 12.161 USDC ile
    ///      hicbir token mezun edilemez, yani graduation kodu hic test
    ///      edilemezdi). Dolayisiyla taban 4e18'i GECEMEZ. arcpad'in
    ///      deploy etmesi ongorulen ucuncu bir profil yoktur, yani 4e18 ayni
    ///      zamanda spec'i bozmadan konabilecek EN YUKSEK tabandir --
    ///      "savunulabilir" olmasinin sebebi budur: bir yandan sinir bir
    ///      olcumden okunur, ote yandan aralikta baska secim yoktur.
    ///
    /// @dev TABAN NEDEN `V`'YE DEGIL UCLUYE KONUR: ekonomiyi `V/T` belirler ve
    ///      `T` de bir deploy argumanidir; `V >= x` seklindeki her taban `T`
    ///      buyutulerek asilir. `V*N/T` ise oranin kendisidir ve `N` sabit
    ///      oldugu icin olcek kaymasi mumkun degildir.
    uint256 public constant MIN_OPENING_MARKET_CAP = 4e18;

    /// @notice Graduation raise'in (`R = V*S/(T-S)`) alt siniri: satis arzi
    ///         tukendiginde curve'de birikmis olacak quote.
    ///
    /// @dev AYNI TUREVIN UCUNCU ORNEGI, dorduncu bir yargi degil.
    ///      `MIN_OPENING_MARKET_CAP` savunulabilirdi cunku serbest parametre
    ///      degildi: kutsanmis iki profilin KUCUGUNUN kendi degeriydi, testnet
    ///      profili zorunluydu ve ucuncu profil yoktu -- yani hem anlamli en
    ///      dusuk hem spec'i bozmayan en yuksek taban. Bu sayinin sekli
    ///      birebir aynidir; yalnizca olculen buyukluk degisir.
    ///
    ///      TURETME (elle, `CurveMath.graduationRaise`in tam yuvarlamasiyla):
    ///        R = floor(V * S / (T - S))
    ///        V = 4_292e15                        (testnet)
    ///        S = 793_100_000e18
    ///        T = 1_073_000_000e18,  T - S = 279_900_000e18
    ///        V * S           = 3_403_985_200 * 1e36
    ///        R = floor(...)  = 12_161_433_369_060_378_706 wei  (~12,1614 USDC)
    ///      Uretim profili ayni hesapla 12_161_433_369_060_378_706_680 verir
    ///      (testnet'in 1000 kati + 680; `floor` iki kez alindigi icin tam kat
    ///      degil). Ikisi de tabani gecer, testnet TAM UZERINDE oturur.
    ///
    /// @dev NICIN GEREKLI -- `M` bunu KAPSAMAZ. `M = V*N/T` icinde `S` HIC
    ///      GECMEZ, dolayisiyla satis arzi kucultulerek `M` hic bozulmadan
    ///      `R` sifira indirilebilir. Olculdu: `S = 2` her iki eski korumadan
    ///      da geciyordu (`D = 1 > 0`, `M = 4_000e18`) ve TUM satis arzi UC
    ///      WEI'ye satiliyordu -- brief'in `V = 1` tanigi, baska bir eksende
    ///      aynen yeniden uretilmis halde. Daha kotusu, en olasi operator
    ///      hatasi olan "S'den e18 dusmesi" (`793_100_000`) de geciyordu:
    ///      `D = 793_099_999`, `M = 4_000e18`, ve tum arz 3.214 wei'ye.
    ///      Ikisi de artik burada eleniyor (`R = 0` ve `R = 3_172`).
    ///
    ///      Ters yon de dogrudur: `R` de `M`'i kapsamaz -- `S ~ 0,9T` bir `R`
    ///      tabanini gecip `M` tabanina takilir. Iki kontrol BAGIMSIZDIR ve
    ///      ikisi birden durur.
    uint256 public constant MIN_GRADUATION_RAISE = 12_161_433_369_060_378_706;

    /// @notice `S + D`'nin alt siniri. UST siniri `N`'dir
    ///         (`SaleAndSeedExceedSupply`); ikisi birlikte TEK BIR OZELLIK
    ///         ifade eder: **profil mint'in tamamini tuketmek zorundadir.**
    ///
    /// @dev Curve arzin %100'unu custody eder ama yalnizca `S`'i satar ve
    ///      graduation'da `D`'yi havuza tohumlar. Geriye kalan `N - S - D`
    ///      hicbir zaman hicbir yere gitmez -- ve Task 2'nin kayda gecirdigi
    ///      gibi curve'un tamamlanma SONRASI cikis yolu YOKTUR. Yani `S + D`
    ///      ne kadar `N`'in altindaysa, o kadar token sonsuza kadar kilitlidir.
    ///      Ust sinir profili "launch edilemez" olmaktan korur; alt sinir
    ///      "arzi kilitler" olmaktan.
    ///
    ///      Alt sinirsiz halin olculen tanigi: `T = 1_000e18`,
    ///      `S = 739,1e18`, `V = 4_293e15`. Bes korumanin BESINI de geciyordu
    ///      (`D = 192,8e18 > 0`, `S + D = 931,9e18 <= N`,
    ///      `M = 4_293e24 >> 4e18`, `R = 12_161_580_298_965_120_735 >= taban`),
    ///      factory deploy oluyor, launch ediyor, token kanonik oluyor -- ve
    ///      tum satis arzi 12,16 USDC'ye alinirken mint'in **%99,9999'u**
    ///      curve'de kaliyordu. Raise tabani bunu GOREMEZ: `R` yalnizca `S/T`
    ///      oranina bakar ve `T` ile `S` birlikte kucultuldugunde oran
    ///      degismez.
    ///
    /// @dev SAYI YINE SERBEST DEGIL: iki kutsanmis profil ayni `S` ve `T`'yi
    ///      paylasir, dolayisiyla ikisinin de `S + D`'si AYNIDIR ve taban
    ///      odur. Ust sinirla birlikte `S + D`'yi 13.988,82 token genisliginde
    ///      bir banda (yani `N`'in %0,0014'u) hapseder.
    ///
    ///      TURETME (elle, `CurveMath.poolSeedSupply`in tam yuvarlamasiyla):
    ///        S = 793_100_000e18
    ///        D = floor(S(T-S)/T) = 206_886_011_183_597_390_493_942_218
    ///        S + D               = 999_986_011_183_597_390_493_942_218
    ///
    /// @dev SONUCU: `S + D <= T` her zaman dogru oldugundan bu taban
    ///      `T >= ~1e27` demektir. Bu bir yan etki DEGIL, ayni ozelligin
    ///      kendisidir: `T < N` olan bir profil mint'i tuketemez. Spec'in iki
    ///      profili de `T = 1_073_000_000e18` kullanir; ucuncu bir profil
    ///      yoktur.
    uint256 public constant MIN_SALE_AND_SEED = 999_986_011_183_597_390_493_942_218;

    // ---------------------------------------------------------------
    // Immutable'lar -- PROFIL BURADA DURUR
    // ---------------------------------------------------------------

    /// @notice Ucretlerin yatirildigi pull-based defter.
    address public immutable escrow;

    /// @notice IKI DONDURULEBILIR UYENIN YETKILISI: graduation hedefi ve
    ///         protokol treasury'si. Baska hicbir yetkisi YOKTUR -- launch
    ///         edemez, duraklatamaz, bir curve'e dokunamaz.
    ///
    /// @dev IMMUTABLE, ve bu bilincli: bir `setGovernor` bu factory'nin en
    ///      tehlikeli uyesi olurdu (tek yanlis atama D3'u sonsuza kadar
    ///      oldururdu) ve anahtar KAYBI durumunda hicbir sey de kurtarmazdi --
    ///      rotasyon icin de anahtar gerekir. Dolayisiyla governor'in bir
    ///      cok-imzali (Safe) olmasi BEKLENIR ve anahtar rotasyonu orada, bir
    ///      katman yukarida yasar. Bedeli kayda gecirilir: governance bir
    ///      DAO'ya ancak Safe'in imzacilari degistirilerek devredilebilir,
    ///      factory'de bir devir yolu yoktur.
    address public immutable governor;

    /// @notice Protokol payinin alicisi. IMMUTABLE DEGILDIR.
    ///
    /// @dev `FeeEscrow` kisit (4) bunu Faz 1c'ye YAZILI BIR BORC olarak
    ///      birakmisti: "protokol ucret ALICI ADRESI dondurulebilir olmalidir,
    ///      boylece protokol payi yeni bir adrese yonlendirilebilir". Kopya
    ///      tutan hal o borcu odemiyordu; `BondingCurve.protocolTreasury()`
    ///      artik bunu HER YATIRIMDA buradan okur, dolayisiyla rotasyon
    ///      CANLI curve'lere de ulasir -- borcun tamami ancak boyle odenir.
    ///
    /// @dev BIRIKMIS ALACAK TASINMAZ. `owed[eski]` escrow'da eski adresin
    ///      talebi olarak aynen kalir; rotasyon yalnizca BUNDAN SONRAKI
    ///      yatirimlarin alicisini degistirir. Bloklanmis bir adreste birikmis
    ///      bakiye hala kurtarilamaz (kisit (4) bunu zaten soyluyor) --
    ///      rotasyonun kapattigi sey KANAMANIN DEVAMIDIR.
    address public protocolTreasury;

    /// @notice Sanal token rezervi `T`; her curve'e aynen gecirilir.
    uint256 public immutable VIRTUAL_TOKEN_RESERVES;

    /// @notice Sanal quote rezervi `V`; uretim ile testnet YALNIZCA burada
    ///         ayrisir (tam 1000x).
    uint256 public immutable VIRTUAL_QUOTE_RESERVES;

    /// @notice Satis arzi `S`.
    uint256 public immutable SALE_SUPPLY;

    /// @notice Uretilen launch sayisi. Salt'in nonce'u da budur.
    uint256 public launchCount;

    // ---------------------------------------------------------------
    // Graduation hedefi -- YENIDEN ISARETLENEBILIR, KAMUYA ACIK GECIKMEYLE
    // ---------------------------------------------------------------

    /// @notice Bir hedef onerisinin inebilmesi icin gecmesi gereken sure.
    ///
    /// @dev UC GUN, ve gecikmenin OLDUGU yer ile OLMADIGI yer arasindaki
    ///      asimetri kasithdir; bkz. `setProtocolTreasury`. Buradaki gecikmenin
    ///      korudugu sey somuttur: hedef bir launch'in TUM raise'ini alir, ve
    ///      `graduate()` cagri aninda okuma yaptigi icin bir yeniden isaretleme
    ///      ZATEN TAMAMLANMIS curve'lerin odemesini de yeni adrese yonlendirir.
    ///      Uc gunluk kamuya acik pencerede herkes o curve'leri mevcut hedefe
    ///      bosaltabilir (`graduate()` izinsizdir hedefin girisinde). Degisiklik
    ///      indikten SONRA tamamlanan curve'ler icin bir care YOKTUR -- bu
    ///      kayda gecirilir, cozulmez: yetki gercektir ve `BondingCurve`in
    ///      "kimse bir launch'in varliklarini hareket ettiremez" vaadi CURVE
    ///      seviyesindedir, factory seviyesinde degil.
    ///
    /// @dev BU SABIT IKI KEZ KULLANILIR ve ikincisi tesadufi degildir: pencere
    ///      `[eta, eta + GRADUATION_TARGET_DELAY]` araligidir, yani ihbar
    ///      suresi ile INDIRME suresi AYNI sayidir. Gerekcesi
    ///      `applyGraduationTarget`in NatSpec'inde; ozeti, ihbarin azami
    ///      bayatliginin ihbar suresini asmamasi gerektigidir.
    uint256 public constant GRADUATION_TARGET_DELAY = 3 days;

    /// @notice `BondingCurve.graduate()`i cagirabilecek TEK adres, ve odemeyi
    ///         alan adres. Atanmadan once `address(0)`dir ve o halde her
    ///         `graduate()` cagrisi `GraduationTargetUnset()` ile doner.
    ///
    /// @dev CURVE'UN BYTECODE'U BU UYENIN SELECTOR'UNU (0xa4b20f13) VE BIR
    ///      STATICCALL'U ICERIR. Deploy edilmis bir factory icin degistirilemez
    ///      olmasi tam olarak istenen seydir: bu uyeyi yeniden adlandiran ya da
    ///      non-`view` yapan bir factory, deploy ettigi HER curve'un
    ///      graduation'ini kirar. `Surface.t.sol` hem imzayi hem mutabiliteyi
    ///      pinler.
    address public graduationTarget;

    /// @notice Onerilmis ama HENUZ INMEMIS hedef, ve inecegi an.
    /// @dev IKISI DE PUBLIC OLMAK ZORUNDA: gecikmenin tek degeri KAMUYA ACIK
    ///      olmasidir. Neyin bekledigi ve ne zaman inecegi zincirden
    ///      okunamiyorsa, "bekleyen graduation'lari once bosalt" caresi
    ///      uygulanamaz -- yani gecikme guvenlik degil sadece yavaslik olurdu.
    address public pendingGraduationTarget;
    uint256 public pendingGraduationTargetEta;

    /// @notice Bu factory'nin URETTIGI HER token'a atanacak ucret kademesi
    ///         tablosu. IMMUTABLE ve GECIKMESIZDIR.
    ///
    /// @dev GECIKMENIN OLMAMASI `graduationTarget` ile TUTARSIZLIK DEGILDIR.
    ///      Gecikme, GERIYE DONUK etkisi olan tek knob'da vardir: hedef, ZATEN
    ///      VAR OLAN ve henuz mezun olmamis curve'leri etkiler, cunku curve
    ///      hedefi `graduate()` ANINDA okur. Schedule oyle degildir -- her
    ///      launch kendi schedule'ini `feeScheduleOf`a ANINDA dondurur, yani
    ///      bu uyeyi tasiyan yeni bir factory yalnizca SONRAKI launch'lari
    ///      etkiler. Tabloyu guncellemek = yeni bir `FeeSchedule` (ve yeni bir
    ///      factory) deploy etmek; spec'in kendi yukseltme yolu budur.
    address public immutable feeSchedule;

    /// @notice token -> o token'in launch ANINDA dondurulmus ucret tablosu.
    ///
    /// @dev IKI IS YAPAR VE IKINCISI VARLIK SEBEBIDIR:
    ///        (1) Tabloyu launch aninda DONDURUR.
    ///        (2) HOOK'A SABIT GAZLI, SAHTECILIGE KAPALI BIR KANONIKLIK KANITI
    ///            VERIR: `feeScheduleOf[token] != address(0)` <=> bu factory o
    ///            token'i uretti.
    ///
    ///      (2) olmadan hook'un elindeki tek yol `isCanonical` cagirmakti, ve
    ///      bu kontratin kendi NatSpec'i o yolun SINIRSIZ GAZLI BIR GRIEFING
    ///      YUZEYI oldugunu OLCEREK kaydetti (3.000.000 gaz butcesiyle
    ///      dogrudan cagrida 2.958.151 tuketim). Tek bir `SLOAD` o sinifin
    ///      tamamini hook'un disinda birakir.
    ///
    /// @dev HOOK'A TASINAMAZ. Bir hook immutable'i tabloyu KALICI OLARAK
    ///      dondururdu, cunku hook adresi `PoolKey`in parcasidir -- tabloyu
    ///      degistirmek havuzun kimligini degistirmek olurdu. Ayrica anlik
    ///      goruntunun LAUNCH aninda alinmasi gerekir, ki o an yalnizca
    ///      factory kosar.
    mapping(address token => address) public feeScheduleOf;

    // ---------------------------------------------------------------
    // Olaylar ve hatalar
    // ---------------------------------------------------------------

    /// @notice Indexer'in bir launch'i yeniden kurmak icin ihtiyac duydugu
    ///         her alan. `salt` de tasinir ki dogrulama zincir disinda da
    ///         tekrarlanabilsin.
    event Launched(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol,
        string uri,
        bytes32 salt
    );

    /// @notice Bir token'a ucret tablosu atandi -- launch aninda, kalici olarak.
    /// @dev Indexer bu olayla, `feeScheduleOf`u okumadan, hangi token'in hangi
    ///      tabloya bagli oldugunu yeniden kurabilir. Tablo degistiginde (yeni
    ///      bir factory) eski token'lar ESKI tabloda kalir ve bu olay o
    ///      ayrimin zincirdeki kaydidir.
    event FeeScheduleAssigned(address indexed token, address indexed schedule);

    /// @notice Bir hedef onerildi ve `eta`da inebilir hale gelecek.
    /// @dev GECIKMENIN KAMUYA ACIK YARISI. Bir indexer/keeper yalnizca bunu
    ///      izleyerek "uc gun icinde bosaltilmasi gereken curve'ler" listesini
    ///      kurabilir.
    event GraduationTargetProposed(address indexed target, uint256 eta);

    /// @notice Hedef degisti.
    event GraduationTargetChanged(address indexed previous, address indexed current);

    /// @notice Protokol payinin alicisi degisti. GECIKMESIZDIR; bkz.
    ///         `setProtocolTreasury`.
    event ProtocolTreasuryChanged(address indexed previous, address indexed current);

    error EmptyName();
    error EmptySymbol();

    /// @dev Profil ucluse `(V, T, S)` olarak dejenere. TEK TEK parametrelere
    ///      konamayan iki sinifi birden kapsar; bkz. constructor.
    error DegenerateProfile();

    /// @dev Graduation raise tabanin altinda. AYRI BIR HATA OLMASI OLCULEREK
    ///      ZORUNLU CIKTI, uslup tercihi degil.
    ///
    ///      `R` ve `M`'in ikisi de `V`'de artandir, yani `V`'yi kucultmek
    ///      IKISINI BIRDEN dusurur. `DegenerateProfile()` paylasilsaydi, yeni
    ///      koruma eskisinin SINIR TESTINI MASKELERDI: piyasa degeri tabaninin
    ///      "bir wei asagisi reddedilir" testi `V_testnet - 1` kullaniyor ve
    ///      o girdi her iki korumayi da ihlal ediyor. Tabani bir wei
    ///      dusuren mutant (M12) o testte hala revert alir -- bu sefer raise
    ///      korumasindan -- ve HAYATTA KALIRDI. Olculdu.
    ///
    ///      Ayri hata ile sira su anlama gelir: piyasa degeri kontrolu ONCE
    ///      calisir, `V_testnet - 1` `DegenerateProfile()` ile doner; M12
    ///      altinda ayni girdi `GraduationRaiseTooSmall()` ile doner ve test
    ///      "Error != expected error" ile KIRILIR. Yani ayri isim, Task 2'nin
    ///      selector carpismasi dersinin bu gorevdeki tekrari.
    error GraduationRaiseTooSmall();

    /// @dev `S + D > N`: profil deploy edilebilir ama HICBIR SEY LAUNCH
    ///      EDEMEZ. `bind`'in `bakiye >= S + D` korumasi bunu zaten yakalar --
    ///      ama orada, yani ILK CREATOR'IN ISLEMINDE, ve `BondingCurve`'un
    ///      hatasiyla. Ikisi de yanlis: bu bir PROFIL hatasidir ve deploy
    ///      basina bir kez odenmelidir. Sifir escrow/treasury icin verilen
    ///      gerekcenin aynisi ("deploy basina bir kez odenen bir kontrolun
    ///      kullanici basina odenen bir hataya donusmesi icin sebep yok")
    ///      burada kelimesi kelimesine gecerlidir.
    ///
    ///      Kabul edilen en buyuk `S` (uretim `T` ve `N = 1e27` ile):
    ///        sMax     = 793_126_814_431_964_561_597_182_417
    ///        D(sMax)  = 206_873_185_568_035_438_402_817_583
    ///        toplam   = 1e27 TAM OLARAK; sMax + 1 ise 1e27 + 1 verir.
    ///      Uretim `S`'i bu tavanin yalnizca %0,0033 altindadir -- yani band
    ///      dar degil, uretim profili tavana YAPISIK.
    ///
    ///      AYRI HATA, `GraduationRaiseTooSmall`'daki gerekcenin aynisi:
    ///      `DegenerateProfile()`'a katlansaydi ayni ismi paylasan uc
    ///      korumayla sira-bagimli hale gelirdi ve hangisinin reddettigi
    ///      olculemezdi.
    error SaleAndSeedExceedSupply();

    /// @dev `S + D < MIN_SALE_AND_SEED`: profil mint'in tamamini tuketmiyor ve
    ///      aradaki fark curve'de SONSUZA KADAR kilitli kalir. Tavanin ayna
    ///      goruntusudur ve AYRI BIR HATADIR: operatorun yapmasi gereken sey
    ///      ters yonde ("daha az bagla" degil, "daha cok bagla"), ve
    ///      `SaleAndSeedExceedSupply` ile ayni ismi paylassaydi hangi yonde
    ///      hata yaptigi revert verisinden okunamazdi.
    error SaleAndSeedStrandSupply();

    /// @dev Sifir adresler. `BondingCurve`'un `ZeroEscrow()` /
    ///      `ZeroTreasury()`'siyle AYNI ADI TASIMAZLAR -- bu depoda iki
    ///      katmanin ayni hata adini paylasmamasi kuraldir (Task 2'nin
    ///      `ZeroAmount` carpismasi), boylece revert verisi hangi katmanin
    ///      reddettigini de soyler.
    error ZeroEscrowAddress();
    error ZeroTreasuryAddress();
    error ZeroGovernorAddress();
    error ZeroFeeSchedule();
    error FeeScheduleHasNoCode();

    /// @notice Profil, HER IKI para birimi siralamasinda temsil edilebilir bir
    ///         havuz acilis fiyati uretmiyor.
    /// @dev FAZ 2'NIN GETIRDIGI TEK YENI PROFIL KONTROLU, ve sihirli sayi
    ///      ICERMEZ: fiili fonksiyonu (`GraduationMath.isSeedable`) cagirir.
    ///      `Vq_final` ve `Vt_final` yalnizca profile baglidir (token adresine
    ///      DEGIL), dolayisiyla bu deploy aninda TAM olarak hesaplanabilir --
    ///      ve hesaplanmazsa ariza GRADUATION aninda, her denemede, o
    ///      profilden uretilmis HER curve icin ortaya cikardi.
    error ProfileNotSeedable();

    /// @dev `protocolTreasury == escrow`. OLCULDU VE BLOKLAMA LISTESI
    ///      GEREKTIRMEZ: iki adres argumani KOMSUDUR
    ///      (`new LaunchFactory(escrow_, protocolTreasury_, ...)`), yani
    ///      escrow'u ikisine de yapistirmak gercek bir operator hatasidir ve
    ///      eski tek koruma (`!= address(0)`) onu gecirirdi. Sonuc: factory
    ///      kurulur, `launch` basarir, `isCanonical` true doner, HER islem
    ///      basarir -- ve protokol payinin %100'u sonsuza kadar talep edilemez
    ///      hale gelir, cunku `FeeEscrow`un `receive()`i yoktur ve
    ///      `claim(escrow)` `TransferFailed()` ile doner. Tek bir 100 USDC
    ///      alimda olculen kayip: 938_271_604_938_271_605 wei.
    ///
    /// @dev NICIN ESITSIZLIK, NICIN KOD KONTROLU DEGIL. Bir Safe treasury
    ///      `receive()`i olan bir KONTRATTIR ve kabul edilmek ZORUNDADIR;
    ///      `protocolTreasury_.code.length == 0` seklinde bir koruma onu
    ///      dislardi ve escrow'daki alacagin pull-based olmasi sayesinde EOA
    ///      treasury'nin ticareti kirmamasi ozelligini de bozardi. Esitsizlik
    ///      ikisini de bozmadan tek gercek terminal durumu eler.
    ///      `protocolTreasury_ == address(this)` de ayni sinifta olurdu ama
    ///      factory'nin adresi constructor icinde henuz kimsenin YAPISTIRABILECEGI
    ///      bir sey degildir (CREATE2 ile onceden bilinebilir ama boyle bir
    ///      operator hatasi yoktur), dolayisiyla eklenmedi.
    error TreasuryIsTheEscrow();

    /// @dev Yalnizca `governor`.
    error NotGovernor();

    /// @dev Sifir hedef ONERILEMEZ. Bir "hedefi geri al" yolu bilerek yoktur:
    ///      graduation'i durdurmak bir pause'dur ve bu sistemde pause yoktur.
    error ZeroGraduationTarget();

    /// @dev `governor == escrow`. `TreasuryIsTheEscrow` ile AYNI SINIF ve ayni
    ///      gerekce: uc adres argumaninin ucu de komsudur ve escrow HICBIR
    ///      cagri yapamaz, dolayisiyla governor'a yapistirilmis bir escrow
    ///      governance'i sonsuza kadar oldurur -- hicbir hedef atanamaz (yani
    ///      HICBIR curve mezun olamaz) ve treasury dondurulemez. Deploy aninda
    ///      BILINEBILIR oldugu icin burada elenir.
    ///      `governor == protocolTreasury` KABUL EDILIR ve edilmelidir: ayni
    ///      Safe pekala ikisi de olabilir.
    error GovernorIsTheEscrow();

    /// @dev Bekleyen bir oneri yok.
    error NoPendingGraduationTarget();

    /// @dev Uc gun gecmedi.
    error GraduationTargetDelayNotElapsed();

    /// @dev Pencere KAPANDI: oneri `eta + GRADUATION_TARGET_DELAY`den sonra
    ///      indirilemez. `GraduationTargetDelayNotElapsed` ile AYNI PENCERENIN
    ///      IKI YUZUDUR ve isimleri bilerek kardestir; care de aynidir --
    ///      yeniden oner ve uc gun bekle. Bu hatanin varlik sebebi
    ///      `applyGraduationTarget`in NatSpec'inde olculmus haliyle duruyor:
    ///      ust sinirsiz halde, tamamlanmis hicbir curve yokken yapilmis bir
    ///      oneri sonsuza kadar silahli kalir ve varliklar geldiginde SIFIR
    ///      ihbarla inebilir.
    error GraduationTargetProposalExpired();

    /// @dev `escrow` KODSUZ bir adres. Sifir kontrolunden AYRIDIR ve ondan
    ///      SONRA gelir, cunku `address(0)` ikisini birden ihlal eder ve hangi
    ///      hatanin donecegi sabit olmalidir.
    ///
    ///      NICIN GEREKLI: bu, `SaleAndSeedExceedSupply`'in engelledigi
    ///      terminal durumun BIR ADIM SONRASI ve DAHA GEC farkedileni.
    ///      Kodsuz bir escrow ile factory deploy olur, `launch` BASARIR,
    ///      `bind` basarir, curve `N`'in tamamini tutar ve `isCanonical`
    ///      **true** doner -- yani indexer onu gercek bir launch olarak
    ///      listeler. Sonra HER iki alim giris noktasi da sonsuza kadar revert
    ///      eder, cunku `BondingCurve` her islemde
    ///      `IFeeEscrow(escrow).deposit{value: ...}` cagirir ve solc'un
    ///      extcodesize kontrolu patlar. Olculdu: mint'in %100'u cikisi
    ///      olmayan bir curve'de kilitli kalir.
    ///
    ///      `protocolTreasury` bu ozelligi TASIMAZ ve bu yuzden onun icin
    ///      boyle bir kontrol YOKTUR: escrow'daki alacak PULL-BASED'dir, yani
    ///      EOA bir treasury ile ticaret sorunsuz calisir (olculdu). Risk tam
    ///      olarak TEK bir argumandadir.
    ///
    ///      Bu bir YAPILANDIRMA kontroludur, `escrow`'un gercekten bir
    ///      `FeeEscrow` oldugunun kaniti DEGIL -- `bind`'in bakiye korumasiyla
    ///      ayni sinifta. Yakaladigi sey gercekci operator hatasidir (EOA
    ///      adresi, yanlis yapistirilmis adres).
    ///
    ///      YETMEDIGI OLCULDU, ve eksik kalan hucre `EscrowIsNotAFeeEscrow`
    ///      ile kapatildi: KODU OLAN ama YANLIS TURDE bir adres bu kontrolden
    ///      GECER ve tam olarak ayni terminal duruma goturur.
    error EscrowHasNoCode();

    /// @dev `escrow` KODLU ama BIR DEFTER GIBI CEVAP VERMIYOR.
    ///
    /// @dev NICIN `EscrowHasNoCode` YETMIYOR -- OLCULDU. Kodu olan ama yanlis
    ///      turde bir escrow ile: factory deploy olur, `launch` BASARIR, `bind`
    ///      BASARIR, `isCanonical` **true** doner -- yani indexer onu gercek bir
    ///      launch olarak listeler -- ve sonra HER alim sonsuza kadar revert
    ///      eder, cunku `BondingCurve` her islemde
    ///      `IFeeEscrow(escrow).deposit{value: ...}` cagirir. Mint'in %100'u
    ///      (`1e27`) cikisi olmayan bir curve'de kalir. Bu, kod kontrolunun
    ///      ENGELLEMEK ICIN YAZILDIGI durumun ta kendisidir, yalnizca bir adres
    ///      SEKLI oteden ulasilmis halidir -- ve kod UZUNLUGUNA bakan bir
    ///      kontrol onu GOREMEZ. Bu depoda "bir ozelligin bir giris noktasinda
    ///      kapatilmasi hepsinde kapatilmis gibi okunur" hatasinin bir baska
    ///      ornegi; kapatildigi yer, bir oncekini kapatmak icin yazilmis kodun
    ///      icidir.
    ///
    /// @dev YOKLAMA VE NICIN UC SEKILDE DE FAIL-CLOSED. Constructor
    ///      `IFeeEscrow(escrow_).owed(address(0))` cagirir ve SIFIR bekler:
    ///        (a) uye YOKSA -- cagri fallback'e duser ya da revert eder; ikisi
    ///            de `catch`e girer;
    ///        (b) uye REVERT ederse -- `catch`;
    ///        (c) YAPISAL OLARAK IMKANSIZ bir cevap donerse (sifirdan farkli)
    ///            -- acik kontrol.
    ///      Ucu de AYNI selector'u uretir; `try/catch` tam olarak bunun icin
    ///      var, cunku (a) ve (b) aksi halde CAGRILANIN revert verisini
    ///      yukari tasirdi ve hangi katmanin reddettigi kaybolurdu.
    ///
    /// @dev NICIN `owed(address(0))`, NICIN `totalOwed()` DEGIL. Bir yoklamanin
    ///      ise yaramasi icin cevabin ONCEDEN BILINMESI gerekir. `totalOwed()`
    ///      icin boyle bir cevap YOKTUR -- her deger mesrudur -- ve
    ///      `totalOwed() == 0` beklemek ZATEN KULLANIMDA olan bir escrow'u
    ///      reddederdi (treasury'ye kod kontrolu koymakla ayni sinifta bir
    ///      fazla-kisitlama). `owed[address(0)]` ise HER ZAMAN sifirdir ve bu
    ///      bir varsayim degil `deposit`'in `ZeroRecipient()` korumasinin
    ///      SONUCUDUR: o anahtara yatirim yapilamaz, dolayisiyla yazilamaz.
    ///      Escrow'un omrunun hangi aninda bakildigindan bagimsizdir.
    ///
    /// @dev VEKIL (PROXY) ARKASINDAKI MESRU BIR ESCROW REDDEDILMEZ: yoklama
    ///      DAVRANISI olcer, kod uzunlugunu ya da kod hash'ini degil.
    ///      `delegatecall` ile bir `FeeEscrow` uygulamasina giden bir vekil
    ///      sifir doner ve gecer -- testte olculuyor.
    ///
    /// @dev ACIK HUCRE, DURUSTCE: dolgun bir `fallback` ile 32 bayt sifir
    ///      donduren bir kontrat bu yoklamayi GECER. Kapatmak icin kod hash'i
    ///      ya da ERC-165 gerekirdi; ikisi de vekilleri ve yukseltmeleri
    ///      disarida birakir. Yakalanan sey GERCEKCI OPERATOR HATASIDIR (yanlis
    ///      yapistirilmis bir kontrat adresi: token, curve, factory, Safe --
    ///      hicbirinin `owed(address)` selector'u yoktur ve hicbiri boyle bir
    ///      fallback tasimaz), dusman bir deploy DEGIL. Zaten escrow'u secen
    ///      taraf protokolun kendisidir.
    ///
    /// @dev GAZ TAVANI YOK VE SEBEBI `isCanonical`INKINDEN FARKLI. Orada
    ///      cagrilan sey SALDIRGANIN sectigi bir token'dir, dolayisiyla her
    ///      zincir ustu cagiran hem `try/catch` hem acik bir gaz tavani
    ///      kullanmak zorundadir. Burada cagrilan adresi DEPLOY EDEN secer, ve
    ///      cagri deploy basina BIR KEZ, kendi islemimizde yapilir: ucuncu bir
    ///      tarafin bu bedeli birine odettirme yolu yoktur.
    error EscrowIsNotAFeeEscrow();

    /// @dev DERLENEN ABI'DE IKI KUTUPHANE HATASI DAHA GORUNUR --
    ///      `CurveMath.InsufficientTokenReserve()` ve `CurveMath.ZeroReserve()`
    ///      -- ama IKISI DE ULASILAMAZ. Birincisi `poolSeedSupply`'in
    ///      `S >= T` dalidir, ikincisi `marketCap`'in `T == 0` dali; her
    ///      ikisi de constructor'in ILK korumasi (`saleSupply_ >=
    ///      virtualTokenReserves_`) tarafindan onceden elenir -- `T == 0`
    ///      dahil, cunku `S >= 0` her zaman dogrudur. Task 2'nin
    ///      `BondingCurve`'de aldigi kararla ayni sekilde birakiliyorlar ve
    ///      Task 4'un yuzey testi ULASILABILIR kumeyi pinlemelidir:
    ///      {EmptyName, EmptySymbol, DegenerateProfile, EscrowHasNoCode,
    ///       GraduationRaiseTooSmall, SaleAndSeedExceedSupply,
    ///       SaleAndSeedStrandSupply, ZeroEscrowAddress, ZeroTreasuryAddress,
    ///       EscrowIsNotAFeeEscrow, ZeroGovernorAddress, TreasuryIsTheEscrow,
    ///       GovernorIsTheEscrow,
    ///       NotGovernor, ZeroGraduationTarget, NoPendingGraduationTarget,
    ///       GraduationTargetDelayNotElapsed, GraduationTargetProposalExpired}.

    // ---------------------------------------------------------------
    // Kurulum
    // ---------------------------------------------------------------

    /// @dev PROFIL SAGLIGI BURADA, DEPLOY BASINA BIR KEZ kontrol edilir ve her
    ///      curve'e bedava yayilir. Curve'un constructor'i `V > 0`, `T > 0`,
    ///      `S > 0`, `S < T`'yi; `bind` de `S + D <= N`'i zaten koruyor. Geriye
    ///      TEK TEK parametrelere konamayan UC dejenerelik kaliyor:
    ///
    ///        (1) `poolSeedSupply(S, T) == 0`. `S = 1` hem constructor'dan hem
    ///            `bind`'den geciyor ve ilk 1 wei'lik alim curve'u tamamlayip
    ///            havuz tohumu SIFIR olan bir `Completed` yayiyor; `T - S == 1`
    ///            ayni seklin ikinci hali. Curve'un hicbir invariant'i
    ///            bozulmadigi icin orada koruma yok -- ama Faz 2'ye sifir
    ///            tohumlu bir graduation devredilirdi.
    ///        (2) Acilis piyasa degerinde alt sinir yok. `V = 1` uretim
    ///            `T, S`'siyle tum satis arzini uc wei'ye satiyor.
    ///        (3) Graduation raise'de alt sinir yok. (2) BUNU KAPSAMAZ:
    ///            `M = V*N/T` icinde `S` hic gecmez, dolayisiyla `S`
    ///            kucultulerek `M` bozulmadan `R` sifirlanabilir. `S = 2` her
    ///            iki onceki korumadan da geciyordu ve tum satis arzi yine UC
    ///            WEI'ye gidiyordu; `S`'den `e18` dusuren operator hatasi da
    ///            geciyordu (3.214 wei). Olculdu.
    ///        (4) `S + D > N`. Profil deploy oluyor ama HER `launch` sonsuza
    ///            kadar `BondingCurve.bind` icinde `TokenBalanceBelowSaleAndSeed`
    ///            ile revert ediyordu. Bir PROFIL hatasinin bedelini ilk
    ///            creator odemis, hatayi da baska bir katman soylemis olurdu.
    ///        (5) `S + D < MIN_SALE_AND_SEED`. (4)'un AYNASI. Profil calisir,
    ///            launch eder, kanoniktir -- ve mint'in tuketilmeyen kismini
    ///            cikisi olmayan bir curve'de sonsuza kadar kilitler. Raise
    ///            tabani bunu goremez cunku `R` yalnizca `S/T` oranina bakar;
    ///            `T` ve `S` birlikte kucultuldugunde oran sabit kalir.
    ///
    ///      `S >= T` de burada, factory'nin KENDI hatasiyla elenir. Sebebi
    ///      teknik: `CurveMath.poolSeedSupply` o durumda
    ///      `InsufficientTokenReserve()` ile patlar ve deploy eden kisi
    ///      dejenere bir PROFIL verdigini degil bir kutuphane hatasini gorurdu.
    ///      Kontrol `T == 0` durumunu da kapsar (`S >= 0 == T` her zaman).
    ///
    /// @dev SIRA BAGLAYICIDIR VE HER KORUMANIN KENDI TANIGI VARDIR. Tek bir
    ///      girdi birden fazla korumayi ihlal edebilir, dolayisiyla "hangisi
    ///      reddetti" ancak SIRA sabitse anlamlidir. Ayri hata adlari bunu
    ///      OLCULEBILIR kilar: sirayi degistiren her mutasyon, cok-ihlalli bir
    ///      taniga farkli revert verisi dondurur ve testte gorunur.
    ///
    ///      Ozellikle: piyasa degeri raise'den ONCE gelir (ikisi de `V`'de
    ///      artandir, yani `V`'yi kucultmek ikisini birden ihlal eder), ve
    ///      `S + D` ciftinin IKISI DE her ikisinden once gelir (bir profil ayni
    ///      anda arzi asabilir VE dusuk bir piyasa degerine sahip olabilir).
    ///      Her koruma icin, YALNIZCA onu ihlal eden bir tanik testte durur --
    ///      boylece hicbir korumanin dogrulanmasi siraya bagimli kalmaz.
    ///
    /// @dev KODSUZ escrow da BURADA elenir. Bu, (4) ve (5)'in ayni ailesinden
    ///      UCUNCU bir terminal durumdur ve en gec farkedilenidir: profil
    ///      deploy olur, launch eder, KANONIK olur, ve ancak bir ALICININ
    ///      isleminde patlar -- o noktada mint'in tamami cikisi olmayan bir
    ///      curve'dedir. Bkz. `EscrowHasNoCode`.
    ///
    /// @dev Sifir escrow/treasury BURADA elenir, `launch`'ta degil. Curve'un
    ///      constructor'i da reddederdi (fail-closed), ama o zaman hata deploy
    ///      aninda degil ILK LAUNCH'ta gorunurdu -- yani yanlis yapilandirilmis
    ///      bir factory zincirde sessizce durur ve ilk creator'in islemini
    ///      patlatir. Deploy basina bir kez odenen bir kontrolun, kullanici
    ///      basina odenen bir hataya donusmesi icin sebep yok.
    /// @dev UC ADRES ARGUMANI KOMSUDUR ve her birinin "rolunu tasiyamaz"
    ///      hucresi ayri ayri yurunur -- Faz 1c'nin final incelemesi bu satiri
    ///      bir GRID olarak cizip treasury kolonunu BOS bulmustu (F1). Kolonlar
    ///      ve hucreleri:
    ///        escrow    : sifir (`ZeroEscrowAddress`), kodsuz (`EscrowHasNoCode`)
    ///        treasury  : sifir (`ZeroTreasuryAddress`), escrow (`TreasuryIsTheEscrow`)
    ///        governor  : sifir (`ZeroGovernorAddress`), escrow (`GovernorIsTheEscrow`)
    ///      Treasury ve governor icin KOD KONTROLU YOKTUR ve olmamalidir: EOA
    ///      bir treasury ile ticaret sorunsuz calisir (alacak pull-based'dir,
    ///      olculdu) ve EOA bir governor testnet'te mesrudur. Fazla siki bir
    ///      koruma bir Safe'i de dislardi.
    constructor(
        address escrow_,
        address protocolTreasury_,
        address governor_,
        uint256 virtualTokenReserves_,
        uint256 virtualQuoteReserves_,
        uint256 saleSupply_,
        address feeSchedule_
    ) {
        if (escrow_ == address(0)) revert ZeroEscrowAddress();
        if (escrow_.code.length == 0) revert EscrowHasNoCode();
        // KOD VARLIGI YETMEZ, DEFTER GIBI CEVAP VERMESI DE GEREKIR. Uc
        // basarisizlik sekli de (uye yok / uye revert ediyor / imkansiz cevap)
        // AYNI selector'e duser; bkz. `EscrowIsNotAFeeEscrow`.
        try IFeeEscrow(escrow_).owed(address(0)) returns (uint256 owedToZeroAddress) {
            if (owedToZeroAddress != 0) revert EscrowIsNotAFeeEscrow();
        } catch {
            revert EscrowIsNotAFeeEscrow();
        }
        if (protocolTreasury_ == address(0)) revert ZeroTreasuryAddress();
        if (protocolTreasury_ == escrow_) revert TreasuryIsTheEscrow();
        if (governor_ == address(0)) revert ZeroGovernorAddress();
        if (governor_ == escrow_) revert GovernorIsTheEscrow();

        if (saleSupply_ >= virtualTokenReserves_) revert DegenerateProfile();

        uint256 poolSeed = CurveMath.poolSeedSupply(saleSupply_, virtualTokenReserves_);
        if (poolSeed == 0) revert DegenerateProfile();

        // Tasma imkansiz: her `S < T` icin `S + D <= T` (bkz. `bind`'in
        // NatSpec'i), ve `T` bir uint256'dir.
        uint256 saleAndSeed = saleSupply_ + poolSeed;
        if (saleAndSeed > LAUNCH_TOKEN_TOTAL_SUPPLY) revert SaleAndSeedExceedSupply();
        if (saleAndSeed < MIN_SALE_AND_SEED) revert SaleAndSeedStrandSupply();

        if (
            CurveMath.marketCap(virtualQuoteReserves_, virtualTokenReserves_, LAUNCH_TOKEN_TOTAL_SUPPLY)
                < MIN_OPENING_MARKET_CAP
        ) revert DegenerateProfile();
        if (CurveMath.graduationRaise(saleSupply_, virtualQuoteReserves_, virtualTokenReserves_) < MIN_GRADUATION_RAISE)
        {
            revert GraduationRaiseTooSmall();
        }

        if (feeSchedule_ == address(0)) revert ZeroFeeSchedule();
        // KOD KONTROLU BURADA GEREKLIDIR, treasury/governor'da OLMADIGI HALDE:
        // `feeSchedule` bir odeme ALICISI degil, CAGRILAN bir kontrattir. Kodsuz
        // bir adres her `tierFor` cagrisinda bos donerdi ve hook ucreti sessizce
        // sifir hesaplardi -- EOA'nin mesru oldugu treasury durumunun tersi.
        if (feeSchedule_.code.length == 0) revert FeeScheduleHasNoCode();

        // SIRA BAGLAYICIDIR: bu kontrol piyasa degeri ve graduation raise
        // tabanlarindan SONRA gelir. Ucurumun kendi tanigi o tabanlari da
        // ihlal ettigi icin, once gelseydi hangi korumanin reddettigi
        // olculemezdi -- deponun `GraduationRaiseTooSmall` dersinin aynisi.
        //
        // ARGUMANLAR. Payda `virtualTokenReserves_ - saleSupply_`dir, yani
        // `vT0 - S`. TOPLAM ARZ DEGILDIR ve olamaz: curve'un kapanistaki
        // `virtualTokenReserves`i budur, ve `N - S` ondan 13.988 token
        // asagidadir. Pay ise `V + R_formula`dir; fiili `Vq_final` `+1`'ler
        // yuzunden HER ZAMAN bunun USTUNDEDIR ve tasma `Vq_final` KUCUKKEN
        // olur, dolayisiyla alt sinirla kontrol etmek gercek yolun kesinlikle
        // guvenli oldugunu verir.
        if (!GraduationMath.isSeedable(
                virtualQuoteReserves_
                    + CurveMath.graduationRaise(saleSupply_, virtualQuoteReserves_, virtualTokenReserves_),
                virtualTokenReserves_ - saleSupply_
            )) revert ProfileNotSeedable();

        feeSchedule = feeSchedule_;
        escrow = escrow_;
        protocolTreasury = protocolTreasury_;
        governor = governor_;
        VIRTUAL_TOKEN_RESERVES = virtualTokenReserves_;
        VIRTUAL_QUOTE_RESERVES = virtualQuoteReserves_;
        SALE_SUPPLY = saleSupply_;
    }

    // ---------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------

    /// @notice Bir curve ve bir token uretir, arzin tamamini curve'e basar ve
    ///         ikisini birbirine baglar.
    /// @dev UCRETSIZ ve `payable` DEGIL: kullanici karari. Deger gonderen bir
    ///      cagri revert eder.
    /// @dev Salt `msg.sender`'i ICERIR (ayni metadata ile iki farkli creator
    ///      carpismasin) ve `launchCount`'u ICERIR (ayni creator ayni metadata
    ///      ile ikinci kez launch edebilsin). Nonce dusurulurse ikinci launch
    ///      dolu bir adrese CREATE2 yapar ve revert eder.
    /// @dev Sira baglayicidir: sayac dis cagrilardan ONCE artar, curve
    ///      token'dan ONCE gelir (aksi halde dongusel bagimlilik), `bind`
    ///      en sonda. Uretilen iki kontratin constructor'i da hicbir dis cagri
    ///      yapmaz (OZ ERC20'nin `_mint`'i dahil), yani bu dizide yeniden
    ///      girilebilecek bir pencere yoktur.
    function launch(string calldata name_, string calldata symbol_, string calldata uri_)
        external
        returns (address token, address curve)
    {
        if (bytes(name_).length == 0) revert EmptyName();
        if (bytes(symbol_).length == 0) revert EmptySymbol();

        bytes32 salt = keccak256(abi.encode(msg.sender, name_, symbol_, uri_, launchCount++));

        // CURVE'UN CONSTRUCTOR ARGUMANLARINDA `protocolTreasury` YOKTUR ve
        // olmamasi TASIYICIDIR: bir mutable degeri initcode'a koymak, ilk
        // rotasyondan sonra `_curveAddress`in HER onceki curve icin yanlis
        // adres uretmesi demek olurdu -- `isCanonical` sessizce false donerdi.
        // Curve onu `protocolTreasury()` ile buradan okur.
        curve = address(
            new BondingCurve{salt: salt}(
                msg.sender, escrow, VIRTUAL_TOKEN_RESERVES, VIRTUAL_QUOTE_RESERVES, SALE_SUPPLY
            )
        );

        token = address(new LaunchToken{salt: salt}(name_, symbol_, uri_, msg.sender, curve, salt));

        // Olay `bind`'DEN ONCE yayilir. `BondingCurve`'un kati CEI sirasiyla
        // ayni disiplin: her yazim ve her olay, her dis cagridan once biter.
        //
        // BU SIRANIN CALISTIRILABILIR BIR KORUMASI YOKTUR, ve bu bir MAZERET
        // DEGIL ISPATTIR. Iki yarisi var:
        //   (1) BASARISIZLIK yolu: `bind` revert ederse islemin tamami geri
        //       alinir ve log da dusme sansi bulamaz.
        //   (2) BASARI yolu: `bind` HICBIR OLAY YAYMAZ. Yaptigi iki cagri da
        //       `view`'dir, yani STATICCALL'dur, ve STATICCALL altinda LOG
        //       opcode'lari yasaktir. Olculdu: bir launch isleminin TAMAMI
        //       tam olarak IKI log uretir -- token'dan `Transfer`,
        //       factory'den `Launched`.
        // Ikisi birlikte iki siranin GOZLEMSEL OLARAK AYIRT EDILEMEZ oldugunu
        // verir; yazilabilecek dogru bir assertion yoktur.
        //
        // KOSULLUDUR: (2) yarisi `bind`'in olaysiz kalmasina baglidir. Faz
        // 1d/2 `bind`'e bir `Bound` olayi eklerse siralar ANINDA ayrilir
        // (`vm.recordLogs()` sirayi dogrudan gorur) ve o noktada ucuz bir
        // koruma yazilabilir -- yazilmalidir da.
        //
        // DUZELTME (olculdu): bu siranin slither'da BIR ISARETI DE YOKTUR.
        // Onceki hali "tek isaret `reentrancy-events` LOW bulgusudur ve bir
        // regresyon bulgu sayisinin 8'den 9'a cikmasi olarak gorunur" diyordu;
        // ikisi de yanlisti. Temiz bir agacta slither'in TEK `reentrancy-events`
        // bulgusu `FeeEscrow.claim`e aittir (olay dis cagridan SONRA yayilir),
        // `LaunchFactory.launch`a DEGIL -- ve olmamasi beklenir: buradaki emit,
        // dedektorun dis cagri saydigi tek sey olan `bind`den ONCE gelir, iki
        // `new` ise CREATE'tir. Yani bu sira slither tarafindan hic
        // gozlenmiyor; "bulgu sayisi" ile izlenebilecegi fikri de gecersiz.
        // Hucre RAPORDA DEGIL BURADA acik yaziliyor: uydurma bir assertion,
        // kapali olmayan bir hucreyi kapali gosterirdi.
        // SCHEDULE'I LAUNCH ANINDA DONDUR. Yeri BAGLAYICIDIR: `Launched`
        // olayindan ONCE ve `bind`den ONCE, yani mevcut CEI disiplinine uyar --
        // her defter yazimi her dis cagridan once biter.
        feeScheduleOf[token] = feeSchedule;
        emit FeeScheduleAssigned(token, feeSchedule);

        emit Launched(token, curve, msg.sender, name_, symbol_, uri_, salt);

        BondingCurve(curve).bind(token);
    }

    // ---------------------------------------------------------------
    // Governance -- IKI DONDURULEBILIR UYE
    // ---------------------------------------------------------------

    /// @notice Yeni bir graduation hedefi onerir; `GRADUATION_TARGET_DELAY`
    ///         sonra inebilir.
    ///
    /// @dev D3 ONERILEN DEGIL ZORUNLUDUR ve uc bagimsiz sebebi vardir:
    ///        (1) D4 yalnizca hedefin `graduate()`i cagirmasina izin verir,
    ///            dolayisiyla girisi revert eden, kabul edip tohumlayamayan ya
    ///            da Arc tarafindan bloklanan bir hedef, tamamlanmis her
    ///            curve'u mezun edilemez birakir. BASKA CIKIS YOKTUR.
    ///        (2) Arc'in HICBIR YERINDE Uniswap V4 yoktur -- ne mainnet'te (ki
    ///            yok), ne testnet'te; dort kanonik `PoolManager` adresi de
    ///            5042002 zincirinde kodsuzdur. Yani ilk hedef kendi
    ///            deploy ettigimiz bir sey olacak ve mainnet'ten once EN AZ BIR
    ///            KEZ, muhtemelen birkac kez degisecektir. Tek seferlik bir
    ///            latch riskli degil, GELISTIRME YOLUYLA BAGDASMAZ olurdu.
    ///        (3) Arc'in calisma zamani bloklama listesinin bir KONTRAT adresine
    ///            uygulanip uygulanamayacagi belirlenemedi. Bu ucuncu sebebin
    ///            artik hicbir yuk tasimasi gerekmiyor -- ilk ikisi yeterlidir.
    ///
    /// @dev BEKLEYEN ONERININ UZERINE YAZMAK bilerek MUMKUNDUR ve ayri bir
    ///      "iptal" uyesi YOKTUR: yanlis bir oneriyi geri almak dogrusunu
    ///      (ya da mevcut hedefi) yeniden onermektir, ve her oneri sureyi
    ///      bastan baslatir. Bir `cancel` uyesi ayni sonucu veren ikinci bir
    ///      yol olurdu.
    function proposeGraduationTarget(address target_) external {
        if (msg.sender != governor) revert NotGovernor();
        if (target_ == address(0)) revert ZeroGraduationTarget();

        pendingGraduationTarget = target_;
        uint256 eta = block.timestamp + GRADUATION_TARGET_DELAY;
        pendingGraduationTargetEta = eta;

        emit GraduationTargetProposed(target_, eta);
    }

    /// @notice Suresi gelmis oneriyi indirir.
    ///
    /// @dev IZINSIZDIR ve bu bilincli: governor onerirken YETKISINI ZATEN
    ///      KULLANMISTIR, ikinci adim yalnizca surenin gectiginin
    ///      dogrulanmasidir. Izinsiz olmasi, governor'in ikinci islemi
    ///      yapamamasinin bir liveness bagimliligi olmasini engeller.
    ///
    /// @dev SIRA: once "bekleyen var mi", sonra "sure gecti mi". Tersi olsaydi
    ///      hicbir oneri yokken `block.timestamp < 0` yanlis oldugu icin cagri
    ///      basarir ve hedefi `address(0)`a CEVIRIRDI -- yani bos durum
    ///      graduation'i kapatan bir yola donusurdu.
    ///
    /// @dev SENTINEL `pendingGraduationTarget == address(0)`DIR, `eta == 0`
    ///      DEGIL, ve secim iki sebepten:
    ///        (1) Sifir bir hedef ONERILEMEZ (`ZeroGraduationTarget`), yani
    ///            adres sentinel'i yanlis pozitif veremez -- bekleyen bir oneri
    ///            varken bu alan asla sifir olamaz.
    ///        (2) `eta == 0` bir TIMESTAMP TUREVINDE KATI ESITLIKTIR ve
    ///            slither'in `incorrect-equality` dedektorunu (MEDIUM)
    ///            tetikler; olculdu, `make slither --fail-medium` kirmizi
    ///            oluyordu. Ayni ozellik adres uzerinden ifade edilince bulgu
    ///            kaybolur ve ifade de daha dogrudan olur.
    ///
    /// @dev PENCERE IKI TARAFTAN DA SINIRLIDIR, ve UST SINIR SONRADAN EKLENDI:
    ///      ilk hali yalnizca alttan siniryordu, yani suresi gecmis ama
    ///      indirilmemis bir oneri SONSUZA KADAR SILAHLI kaliyordu. Somut
    ///      sonucu olculdu: gun 0'da, HENUZ TAMAMLANMIS HIC CURVE YOKKEN bir
    ///      hedef onerilir; kimse itiraz etmez, cunku bosaltilacak bir sey
    ///      yoktur; gun 3'te pencere acilir, kimse indirmez ve izleyenler
    ///      onerinin dusuruldugunu sanir; gun 368'de iki launch tamamlanmistir
    ///      ve TEK BIR ISLEM `applyGraduationTarget()` + iki `graduate()`
    ///      cagrisini yapar. Hirsizlik anindaki IHBAR SURESI SIFIRDIR.
    ///
    ///      Kusurun kalbi sudur: gecikmenin verdigi ihbar ONERI ANINDAKI
    ///      ihbardir, korudugu varliklar ise DAHA SONRA gelir -- ve gecikmenin
    ///      tek yazili caresi ("uc gun icinde tamamlanmis curve'leri mevcut
    ///      hedefe bosalt") tam olarak oneri aninda BOS olan kumeyi korur.
    ///      "Oneriden itibaren uc gun ihbar" ile "varliklar hareket etmeden
    ///      once uc gun ihbar" ayni sey DEGILDIR ve tam olarak varliklar
    ///      pencereden SONRA geldiginde ayrisirlar.
    ///
    /// @dev SURE `eta + GRADUATION_TARGET_DELAY`DIR VE IKINCI BIR SABIT YOKTUR.
    ///      Bu, sayiyi SERBEST BIR PARAMETRE OLMAKTAN CIKARIR -- deponun diger
    ///      sabitlerinde (`MIN_OPENING_MARKET_CAP`, `MIN_SALE_AND_SEED`)
    ///      izlenen kural: sinir bir olcumden ya da zaten var olan bir
    ///      buyuklukten okunur, secilmez. Iki uctan da ayni sayiya varilir:
    ///
    ///        ALT UC (neden daha kisa olmasin): `applyGraduationTarget`
    ///        IZINSIZDIR ve `eta` UC GUN ONCEDEN bilinen PUBLIC bir
    ///        degiskendir. Yani indirme adiminin KOORDINASYON MALIYETI YOKTUR:
    ///        imza gerektirmez, governor'i gerektirmez, herhangi biri -- zaten
    ///        var olmasi gereken keeper dahil (spec 8) -- tek bir islemle
    ///        yapabilir. Cok-imzalinin imza toplama maliyeti ONERI aninda
    ///        ZATEN odenmistir. Dolayisiyla pencere "bir Safe ne kadar surede
    ///        imzalar" ile boyutlandirilmaz.
    ///
    ///        UST UC (neden daha uzun olmasin): pencere ihbar suresini ASARSA,
    ///        bekleyen durumu okuyup gecikmeyi bekleyen bir gozlemci, bilgisi
    ///        BAYATLADIKTAN sonra inen bir degisiklikle karsilasabilir --
    ///        yani duzeltilen kusurun kucuk olcekli hali geri gelir. Pencereyi
    ///        ihbar suresiyle sinirlamak, ihbarin azami bayatligini ihbar
    ///        suresinin KENDISIYLE sinirlar: toplam maruziyet en fazla
    ///        2 x GRADUATION_TARGET_DELAY, yani ALTI GUNDUR.
    ///
    ///      Iki uc TEK BIR sayida bulusur ve o sayi sistemde ZATEN VARDIR.
    ///      Ayri bir `GRADUATION_TARGET_GRACE` sabiti EKLENMEDI: ifadeyi
    ///      `eta + GRADUATION_TARGET_DELAY` olarak yazmak, iki ucun BIRLIKTE
    ///      degismesini zorunlu kilar ve yanlis ayarlanabilecek ikinci bir
    ///      literal birakmaz. Suresi disaridan hesaplanabilir:
    ///      `pendingGraduationTargetEta() + GRADUATION_TARGET_DELAY()`.
    ///
    /// @dev LIVENESS BEDELI BILINCLI VE SINIRLIDIR: suresi gecen bir oneri
    ///      YENIDEN ONERILIR ve uc gun daha beklenir. D3 bozuk bir hedeften tek
    ///      cikis oldugu icin bu bir gecikmedir -- ama alti gun boyunca IZINSIZ
    ///      tek bir islemin gonderilmemis olmasi, tam da "hedef bozuk ve her
    ///      sey sikismis" senaryosunda gercekci degildir: o senaryoda ihtiyaci
    ///      olanlar zaten izliyordur. Kaybi olan bir gecikme, sinirsiz silahli
    ///      bir yetkiye tercih edilir.
    ///
    /// @dev IKI SINIR DA KAPSAYICIDIR: `eta` aninda inebilir,
    ///      `eta + GRADUATION_TARGET_DELAY` aninda HALA inebilir, bir saniye
    ///      sonrasinda inemez. Ikisinin de iki tarafi testte yurunur.
    ///
    /// @dev SURESI GECMIS BIR ONERI TEMIZLENMEZ VE TEMIZLENMESI GEREKMEZ: bu
    ///      durumda `pendingGraduationTarget` okunabilir ama ATILDIR, cunku
    ///      inebilecegi tek fonksiyon artik reddeder. Bir "temizle" uyesi,
    ///      yeniden onermenin zaten yaptigi seyi yapan ikinci bir yol olurdu.
    function applyGraduationTarget() external {
        address next = pendingGraduationTarget;
        if (next == address(0)) revert NoPendingGraduationTarget();

        uint256 eta = pendingGraduationTargetEta;
        if (block.timestamp < eta) revert GraduationTargetDelayNotElapsed();
        if (block.timestamp > eta + GRADUATION_TARGET_DELAY) revert GraduationTargetProposalExpired();

        address previous = graduationTarget;

        graduationTarget = next;
        pendingGraduationTarget = address(0);
        pendingGraduationTargetEta = 0;

        emit GraduationTargetChanged(previous, next);
    }

    /// @notice Protokol payinin alicisini dondurur. ANINDA gecerli olur.
    ///
    /// @dev NICIN GECIKME YOK -- ASIMETRI KASITLI VE GEREKCESI SUDUR: bir
    ///      gecikmenin `graduationTarget` tarafinda somut bir caresi vardir
    ///      (uc gun icinde tamamlanmis curve'leri mevcut hedefe bosaltmak).
    ///      Treasury tarafinda O CARENIN KARSILIGI YOKTUR: rotasyon birikmis
    ///      `owed[eski]`ye DOKUNMAZ -- eski adres onu aynen talep etmeye devam
    ///      eder -- yani kamunun "once bosalt" diye yapacagi bir sey yoktur.
    ///      Buna karsilik gecikmenin BEDELI somuttur: kisit (4)'un bloklama
    ///      senaryosunda gecen her gun, hicbir zaman talep edilemeyecek
    ///      `owed[bloklanmis]` olarak birikir. Yani gecikme burada hicbir seyi
    ///      korumaz ve olcelebilir bir zarar verir.
    ///      Yetkinin buyuklugu de farklidir: bu setter protokolun KENDI
    ///      GELECEK gelirinin alicisini degistirir; hedef setter'i ise bir
    ///      launch'in TUM raise'ini yonlendirir.
    ///
    /// @dev KORUMALAR CONSTRUCTOR'DAKININ AYNISI, ve ayni olmalari zorunludur:
    ///      bir setter constructor'in korumalarini gevsetirse koruma yok
    ///      demektir. Curve tarafinda BIR KEZ DAHA kontrol edilmez, cunku
    ///      `BondingCurve` bu iki uyeyi dogrulamaz (bkz. `ILaunchFactory`);
    ///      sifir olmama garantisinin TEK yeri burasidir.
    function setProtocolTreasury(address protocolTreasury_) external {
        if (msg.sender != governor) revert NotGovernor();
        if (protocolTreasury_ == address(0)) revert ZeroTreasuryAddress();
        if (protocolTreasury_ == escrow) revert TreasuryIsTheEscrow();

        address previous = protocolTreasury;
        protocolTreasury = protocolTreasury_;

        emit ProtocolTreasuryChanged(previous, protocolTreasury_);
    }

    // ---------------------------------------------------------------
    // Dogrulama
    // ---------------------------------------------------------------

    /// @notice Bir token'in bu factory tarafindan uretilip uretilmedigi.
    ///         DOGRULAMANIN TAMAMI BUDUR.
    /// @dev Token'in KENDI adresini, yalnizca kendi acikladigi verilerden
    ///      yeniden turetir. Factory'den tureyen bir adrese yalnizca factory
    ///      deploy edebildigi icin, esitlik saglaniyorsa token kanoniktir --
    ///      ve o zaman `curve()` alani da factory'nin gecirdigi degerdir,
    ///      cunku `curve` initcode'un icindedir.
    /// @dev KODU OLMAYAN adres icin `false` doner. `launchSalt()` selector'u
    ///      OLMAYAN bir kontrat icin ise cagri REVERT EDER, `false` donmez.
    ///      Fail-closed'dur (hicbir sahte token kanonik SAYILMAZ) ve cagiran
    ///      taraf revert'i "kanonik degil" olarak okumalidir.
    ///
    ///      DUZELTME (inceleme, olculdu): DISARIDAN bir `try/catch` bu
    ///      revert'ten KONTROLU GERI ALIR -- bu fonksiyonun ICINDE
    ///      `abi.decode`'un revert'i yakalanamaz, ama disaridaki cagiran
    ///      pekala yakalayabilir. Geri ALINAMAYAN sey GAZ'dir.
    ///
    /// @dev GAZ SINIRSIZDIR VE BU BIR GRIEFING YOLUDUR. Dogrulanan token
    ///      dusmandir ve alanlarini kendisi dondurur; megabaytlik bir `name()`
    ///      cagriyi keyfi olarak pahalilastirir. Olculdu: 3.000.000 gaz
    ///      butcesiyle dogrudan cagride 2.958.151, `try/catch` ile saran bir
    ///      cagiranda 8.000.000 butcenin 7.757.318'i tuketiliyor -- yani
    ///      `try/catch` kontrolu geri veriyor ama gazi vermiyor (EIP-150'nin
    ///      63/64 kurali).
    ///
    ///      Bugun bunu zincir uzerinde tuketen bir cagiran YOKTUR; zincir disi
    ///      bir indexer kendi gaz tavanini zaten koyar. ZINCIR UZERINDEKI her
    ///      cagiran ISE HEM `try/catch` HEM DE ACIK BIR GAZ TAVANI kullanmak
    ///      zorundadir; yalnizca biri yetmez.
    function isCanonical(address token) external view returns (bool) {
        if (token.code.length == 0) return false;
        LaunchToken t = LaunchToken(token);
        bytes32 salt = t.launchSalt();
        return _tokenAddress(salt, t.name(), t.symbol(), t.metadataURI(), t.creator(), t.curve()) == token;
    }

    /// @notice `launch`'in uretecegi adresler; zincir disi onizleme icin.
    /// @dev `nonce` cagri anindaki `launchCount`'tur.
    function predictAddresses(
        address creator_,
        string calldata name_,
        string calldata symbol_,
        string calldata uri_,
        uint256 nonce
    ) external view returns (address token, address curve) {
        bytes32 salt = keccak256(abi.encode(creator_, name_, symbol_, uri_, nonce));
        curve = _curveAddress(salt, creator_);
        token = _tokenAddress(salt, name_, symbol_, uri_, creator_, curve);
    }

    // ---------------------------------------------------------------
    // Turetme
    // ---------------------------------------------------------------

    /// @dev Curve'un initcode'u token'i ICERMEZ; dongunun kirildigi yer burasi.
    /// @dev Arguman listesi `launch`'takiyle BIRE BIR ayni olmak zorundadir; bir
    ///      MUTABLE degerin buraya girmesi ise ayrica yasaktir (bkz. `launch`).
    function _curveAddress(bytes32 salt, address creator_) private view returns (address) {
        return _create2(
            salt,
            keccak256(
                abi.encodePacked(
                    type(BondingCurve).creationCode,
                    abi.encode(creator_, escrow, VIRTUAL_TOKEN_RESERVES, VIRTUAL_QUOTE_RESERVES, SALE_SUPPLY)
                )
            )
        );
    }

    /// @dev Alanlarin sirasi `LaunchToken`'in constructor'iyla BIRE BIR
    ///      ayni olmak zorundadir; herhangi biri dusurulurse sahteci o alani
    ///      serbestce degistirip kanonik kalabilir.
    function _tokenAddress(
        bytes32 salt,
        string memory name_,
        string memory symbol_,
        string memory uri_,
        address creator_,
        address curve_
    ) private view returns (address) {
        return _create2(
            salt,
            keccak256(
                abi.encodePacked(
                    type(LaunchToken).creationCode, abi.encode(name_, symbol_, uri_, creator_, curve_, salt)
                )
            )
        );
    }

    function _create2(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
