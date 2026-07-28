// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BondingCurve} from "./BondingCurve.sol";
import {LaunchToken, LAUNCH_TOKEN_TOTAL_SUPPLY} from "./LaunchToken.sol";
import {CurveMath} from "./libraries/CurveMath.sol";

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

    /// @notice Protokol payinin alicisi.
    address public immutable protocolTreasury;

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
    error EscrowHasNoCode();

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
    ///       SaleAndSeedStrandSupply, ZeroEscrowAddress, ZeroTreasuryAddress}.

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
    constructor(
        address escrow_,
        address protocolTreasury_,
        uint256 virtualTokenReserves_,
        uint256 virtualQuoteReserves_,
        uint256 saleSupply_
    ) {
        if (escrow_ == address(0)) revert ZeroEscrowAddress();
        if (escrow_.code.length == 0) revert EscrowHasNoCode();
        if (protocolTreasury_ == address(0)) revert ZeroTreasuryAddress();

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

        escrow = escrow_;
        protocolTreasury = protocolTreasury_;
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

        curve = address(
            new BondingCurve{salt: salt}(
                msg.sender, escrow, protocolTreasury, VIRTUAL_TOKEN_RESERVES, VIRTUAL_QUOTE_RESERVES, SALE_SUPPLY
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
        // Bugunku tek isaret slither'in `reentrancy-events` LOW bulgusudur ve
        // `make slither --fail-medium` onu kirmizi yapmaz; bir regresyon
        // yalnizca bulgu sayisinin 8'den 9'a cikmasi olarak gorunur. Raporda
        // ACIK HUCRE olarak yaziliyor: uydurma bir assertion, kapali olmayan
        // bir hucreyi kapali gosterirdi.
        emit Launched(token, curve, msg.sender, name_, symbol_, uri_, salt);

        BondingCurve(curve).bind(token);
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
    function _curveAddress(bytes32 salt, address creator_) private view returns (address) {
        return _create2(
            salt,
            keccak256(
                abi.encodePacked(
                    type(BondingCurve).creationCode,
                    abi.encode(
                        creator_, escrow, protocolTreasury, VIRTUAL_TOKEN_RESERVES, VIRTUAL_QUOTE_RESERVES, SALE_SUPPLY
                    )
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
