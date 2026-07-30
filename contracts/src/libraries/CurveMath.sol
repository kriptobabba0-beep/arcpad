// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title CurveMath
/// @notice Bonding curve'un tum aritmetigi. Sanal rezervli sabit carpim
///         (x·y=k) ailesinden; pump.fun'in kullandigi formullerin aynisi.
/// @dev Yuvarlama yonleri HEPSI protokol lehinedir. Alici lehine tek bir
///      yuvarlama, saldirganin 1 wei'lik milyonlarca islemle curve'u kurus
///      kurus bosaltmasina izin verir.
/// @dev Iki yolun IKI AYRI kaynagi vardir. Exact-tokens-out yolu
///      (`quoteBuyCost`, `quoteSellProceeds`, `feeOn`) pump.fun'in
///      pump-sdk surum 1.36.0 kaynagindan alinmistir. Exact-quote-in yolu
///      (`netQuoteInBeforeCorrection` -> `correctedNetQuoteIn` ->
///      `quoteBuyTokensOut`) ise SDK'dan DEGIL, IDL'de `buy_exact_sol_in`
///      uzerindeki doc-comment'te verilen ZINCIR algoritmasindan alinmistir.
///      Ikisi ayrisir: SDK'nin `getBuyTokenAmountFromSolAmount` yardimcisi
///      zincir disi bir tahmin edicidir ve 200.000 olculen ornegin
///      102.318'inde (%51,16) zincirden FAZLA token vaat eder; tersi hic
///      olmaz.
library CurveMath {
    /// @notice Baz puan paydasi.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    error ZeroAmount();
    error ZeroReserve();
    error InsufficientTokenReserve();
    error InvalidBps();
    /// @dev Duzeltilmis net anapara, curve terimindeki `net - 1`'i besleyemeyecek
    ///      kadar kucuk (`<= 1`). O durumda cikti sifir token olurdu; cagiran
    ///      para odeyip hicbir sey almamali.
    error NetTooSmall();

    /// @notice Tam `tokensOut` token almak icin curve'e odenecek quote miktari,
    ///         ucret HARIC.
    /// @dev floor(...) + 1. Bu, mulDivRoundingUp ile ayni DEGILDIR: tam bolunen
    ///      durumda bir birim fazla alir. pump.fun boyle yapar, biz de.
    /// @dev BU `+1` GRADUATION FIYATININ YONU ICIN TASIYICIDIR -- yalnizca
    ///      "pump.fun boyle yapiyor" gerekcesiyle durmuyor. Graduation'da havuz
    ///      `R = realQuoteReserves` ve `D = poolSeedSupply` ile tohumlanir;
    ///      spec §10 invariant 6 acilis fiyatinin curve'un kapanis fiyati
    ///      `P_final`'i asmasini (altina dusmemesini) ister.
    ///      TEOREM: `poolSeedSupply` tabana yuvarladigi icin `D < S(T-S)/T`, ve
    ///      buradaki `+1` her alimda birikerek `R_actual`'i tam `V*S/(T-S)`
    ///      degerinin UZERINDE tutar. Ikisi birlikte `R/D > P_final` verir --
    ///      yani havuz DAIMA `P_final`'in uzerinde acilir, profil degisse bile.
    ///      Olculdu: her iki kutsanmis profilde ulasilabilir en kucuk
    ///      `R_actual = R_theory + 1`.
    ///      Bu `+1` `mulDivRoundingUp`'a "sadelestirilirse" teoremin ikinci
    ///      yarisi duser ve isaret ters cevrilebilir hale gelir. Bagis testleri
    ///      bunu GORMEZ, cunku donen degerler yine tam `(D, R)`'dir; degisen sey
    ///      oranin kendisidir. Bu satiri degistirmeden once §10 invariant 6'yi
    ///      yeniden turet.
    ///      (Ilk surum bu notu "fark isaret degistirir ve havuz P_final'in
    ///      ALTINDA acilir" diye yaziyordu. Faz 1c nihai incelemesi olctu: o
    ///      durum ULASILAMAZ, cunku carpim invariant'i `R_actual`'i tam degerin
    ///      altina dusuremez. Sonuc ayni -- satir tasiyici -- ama sebep bir
    ///      olasilik degil bir teorem.)
    ///      `quoteReserve == 0` OLAMAZ: aksi halde `mulDiv(tokensOut, 0, ...) + 1`
    ///      her zaman `1` doner -- yani `tokenReserve - 1`'e kadar herhangi bir
    ///      miktar tek birimlik bir bedelle alinabilir. `quoteBuyTokensOut` ve
    ///      `quoteSellProceeds`'teki sifir-rezerv korumalariyla aynen tutarli
    ///      olacak sekilde `ZeroReserve()` ile reddedilir.
    function quoteBuyCost(uint256 tokensOut, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (tokensOut == 0) revert ZeroAmount();
        if (quoteReserve == 0) revert ZeroReserve();
        if (tokensOut >= tokenReserve) revert InsufficientTokenReserve();
        return FullMath.mulDiv(tokensOut, quoteReserve, tokenReserve - tokensOut) + 1;
    }

    /// @notice Zincirin exact-quote-in algoritmasinin 4. adimi: duzeltilmis net
    ///         anapara ile alinabilecek token miktari.
    /// @dev Tabana yuvarlar. `-1` curve teriminin ICINDEDIR: pay ve paydanin
    ///      IKISINDE birden `net - 1` kullanilir. SDK'nin
    ///      `getBuyTokenAmountFromSolAmount` tahmin edicisi bu `-1`'i bunun
    ///      yerine bolmeden ONCE GIRDIYE uyguluyor; ikisi ayni sayi degildir
    ///      ve fark daima kullanici lehinedir (bkz.
    ///      `netQuoteInBeforeCorrection`).
    ///
    ///      Her iki rezerv de sifir OLAMAZ: `quoteReserve == 0` payda'yi
    ///      `net`'e indirger ve `net * tokenReserve / net = tokenReserve`
    ///      sonucunu -- yani rezervin TAMAMINI -- herhangi bir (hatta 1
    ///      wei'lik) girdi icin dondurur. Bu bir drain deseni oldugundan
    ///      sessizce degil, `ZeroReserve()` ile reddedilir.
    function quoteBuyTokensOut(uint256 netQuoteIn_, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (netQuoteIn_ <= 1) revert NetTooSmall();
        if (quoteReserve == 0 || tokenReserve == 0) revert ZeroReserve();
        uint256 net = netQuoteIn_ - 1;
        return FullMath.mulDiv(net, tokenReserve, quoteReserve + net);
    }

    /// @notice Tam `tokensIn` token satmaktan curve'un verecegi quote, ucret HARIC.
    /// @dev Tabana yuvarlar. Her iki rezerv de sifir OLAMAZ: `tokenReserve == 0`
    ///      payda'yi `tokensIn`'e indirger ve `tokensIn * quoteReserve /
    ///      tokensIn = quoteReserve` sonucunu -- yani rezervin TAMAMINI --
    ///      herhangi bir (hatta 1 wei'lik) girdi icin dondurur. Bu bir drain
    ///      deseni oldugundan sessizce degil, `ZeroReserve()` ile reddedilir.
    function quoteSellProceeds(uint256 tokensIn, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (tokensIn == 0) revert ZeroAmount();
        if (quoteReserve == 0 || tokenReserve == 0) revert ZeroReserve();
        return FullMath.mulDiv(tokensIn, quoteReserve, tokenReserve + tokensIn);
    }

    /// @notice Bir miktar uzerinden ucret; ucret `amount`'in USTUNE eklenir
    ///         (EXCLUSIVE sozlesme -- `amount` net bir anaparadir).
    /// @dev Tavana yuvarlar. `feeBps > BPS_DENOMINATOR` (%100'u asan ucret)
    ///      `InvalidBps()` ile reddedilir.
    ///
    ///      DIKKAT -- bu, `netQuoteInBeforeCorrection`'in kullandigi INCLUSIVE
    ///      sozlesmenin (ucret gross miktarin ICINE gomulu) TERSI DEGILDIR.
    ///      Ayrica zincir ucreti IKI BAGIMSIZ parcadan toplar ve bu toplam
    ///      birlesik oranin tek tavan yuvarlamasiyla AYNI DEGILDIR:
    ///      `feeOn(n, p) + feeOn(n, c) != feeOn(n, p + c)` genel olarak dogrudur
    ///      ve aradaki fark tam olarak `correctedNetQuoteIn`'in kistigi
    ///      tasmadir (bkz.
    ///      CurveMathTest.test_splitCeilsChargeMoreThanTheCombinedRate).
    function feeOn(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        if (feeBps > BPS_DENOMINATOR) revert InvalidBps();
        return FullMath.mulDivRoundingUp(amount, feeBps, BPS_DENOMINATOR);
    }

    /// @notice Zincirin exact-quote-in algoritmasinin 1. adimi.
    /// @dev Girdiden 1 CIKARILMAZ. `@pump-fun/pump-sdk`'nin
    ///      `getBuyTokenAmountFromSolAmount` yardimcisi cikariyor ama o zincir
    ///      disi bir tahmin edicidir: 200.000 ornekte token ciktisi %51,16
    ///      ayrisiyor ve SDK her ayrismada zincirden FAZLA token vaat ediyor.
    ///
    ///      `totalFeeBps > BPS_DENOMINATOR` `InvalidBps()` ile reddedilir --
    ///      ANCAK bu sinir "%100'u asan bir ucret"i reddetmez. INCLUSIVE
    ///      sozlesmede fiili ucret orani `totalFeeBps / (totalFeeBps +
    ///      BPS_DENOMINATOR)`'dir; sinirin tam UZERINDE (totalFeeBps ==
    ///      BPS_DENOMINATOR) bile fiili ucret sadece %50'dir ve gecerli
    ///      girdi araliginda ucret hicbir zaman %100'e ulasamaz (bkz.
    ///      test_netBeforeCorrectionAllowsBpsEqualToDenominator: gross =
    ///      1_000_000 icin net = 500_000). Sinir yalnizca `totalFeeBps`'i
    ///      `feeOn`'un kullandigi EXCLUSIVE bps olcegiyle tutarli tutmak
    ///      icindir.
    function netQuoteInBeforeCorrection(uint256 grossQuoteIn, uint256 totalFeeBps) internal pure returns (uint256) {
        if (grossQuoteIn == 0) revert ZeroAmount();
        if (totalFeeBps > BPS_DENOMINATOR) revert InvalidBps();
        return FullMath.mulDiv(grossQuoteIn, BPS_DENOMINATOR, totalFeeBps + BPS_DENOMINATOR);
    }

    /// @notice 1'den 3'e: butceye sigan net anapara ve onunla birlikte tahsil
    ///         edilecek IKI ucret parcasi.
    /// @dev DIKKAT -- ucretler DUZELTME ONCESI net uzerinden hesaplanir ve
    ///      3. adimdan sonra YENIDEN HESAPLANMAZ. Zincir boyle yapar ve bu,
    ///      bu fonksiyonun en kolay yanlis anlasilan tarafidir: cagiran
    ///      donen `net` uzerinden `feeOn`'u kendisi cagirirsa FARKLI (daha
    ///      kucuk) bir ucret bulur ve kullanicinin odemesinin bir birimi ne
    ///      anapara ne ucret olarak muhasebelesir. Olculdu: (95, 30) bps'te
    ///      gross in [1, 1e6] araliginin 12.345'inde yeniden hesaplama
    ///      farkli sonuc verir (azami 2 birim eksik). Bu yuzden ucretler
    ///      DONDURULUR; cagiranin yeniden hesaplamasi icin bir sebep yoktur.
    ///
    ///      Ornek (gross = 1_000_013, 95 + 30 bps):
    ///        duzeltme oncesi net = 987_667
    ///        protocolFee = 9_383, creatorFee = 2_964  (toplam 12_347)
    ///        987_667 + 12_347 = 1_000_014 > gross -> tasma 1
    ///        duzeltilmis net = 987_666
    ///        987_666 + 9_383 + 2_964 = 1_000_013 = gross  (tam)
    ///      Ayni girdide donen net uzerinden yeniden hesaplama
    ///      9_383 + 2_963 = 12_346 verirdi -- creator 1 birim eksik alirdi.
    ///
    ///      Iki parca AYRI dondurulur, toplamlari degil: escrow iki bagimsiz
    ///      yatirim alir ve bu projenin kurali ucretin parcalardan TOPLANMASI,
    ///      bir toplamdan BOLUNMEMESIDIR.
    ///
    ///      Garanti: `net + protocolFee + creatorFee <= grossQuoteIn`, ve aradaki
    ///      fark en fazla 1'dir. Duzeltme tetiklendiginde TAM ESITLIK olusur
    ///      (tanim geregi: net'ten tam olarak tasma kadar dusulur). Esitlik
    ///      EVRENSEL DEGILDIR -- duzeltme tetiklenmediginde toplam 1 birim
    ///      eksik kalabilir; olculdu: (95, 30) bps'te gross in [1, 1e6]
    ///      araliginin %99,95'inde esit, 494'unde 1 eksik. Ucret payi
    ///      buyudukce esitsizlik siklasir: (5000, 5000) bps'te yalnizca %75.
    ///
    /// @dev 3. adim gercek bir tasmanin caresidir, optimizasyon degil. Protokol
    ///      ve creator paylari BAGIMSIZ olarak tavana yuvarlandigi icin toplam
    ///      butceyi asabilir; program revert etmek yerine net'i kisar. Bunu
    ///      atlayan bir uygulama, pump.fun'in kabul ettigi girdilerde revert eder.
    ///      Ucret parcalardan toplanir; birlesik oran ileri yonde kullanilmaz.
    ///
    ///      Tasma en fazla 1 birimdir ve bu ISPATLANABILIR: her tavan
    ///      yuvarlamasi icin `ceil(x) < x + 1` (kesin), yani
    ///      `fees < net*(p+c)/1e4 + 2`; ayrica `net = floor(gross*1e4/(1e4+p+c))`
    ///      oldugundan `net*(1e4+p+c)/1e4 <= gross`. Ikisi birlikte
    ///      `net + fees < gross + 2` verir; tamsayilarda bu `overshoot <= 1`
    ///      demektir. Dolayisiyla `overshoot >= net` dali YALNIZCA `net == 1`
    ///      iken tetiklenir ve `net -= overshoot` hicbir zaman alta tasamaz.
    ///      Dal olusuz degildir: (95, 30) bps ile `gross == 2` tam olarak bunu
    ///      uretir (duzeltmesiz net = 1, ucretler = 1 + 1 = 2, tasma = 1).
    function correctedNetQuoteIn(uint256 grossQuoteIn, uint256 protocolFeeBps, uint256 creatorFeeBps)
        internal
        pure
        returns (uint256 net, uint256 protocolFee, uint256 creatorFee)
    {
        net = netQuoteInBeforeCorrection(grossQuoteIn, protocolFeeBps + creatorFeeBps);
        protocolFee = feeOn(net, protocolFeeBps);
        creatorFee = feeOn(net, creatorFeeBps);
        uint256 total = net + protocolFee + creatorFee;
        if (total > grossQuoteIn) {
            uint256 overshoot = total - grossQuoteIn;
            if (overshoot >= net) revert NetTooSmall();
            net -= overshoot;
        }
    }

    /// @notice Market cap. `supplyConstant` sabit arz sabitidir, mint'in gercek
    ///         arzi DEGIL -- tum launch'lar ayni arza sahip oldugu icin bu,
    ///         market cap'i saf bir fiyat fonksiyonuna indirger.
    function marketCap(uint256 quoteReserve, uint256 tokenReserve, uint256 supplyConstant)
        internal
        pure
        returns (uint256)
    {
        if (tokenReserve == 0) revert ZeroReserve();
        return FullMath.mulDiv(quoteReserve, supplyConstant, tokenReserve);
    }

    /// @notice Satis arzi tukendiginde curve'de birikmis olacak quote miktari.
    /// @dev R = V·S/(T−S). Ucret oranindan BAGIMSIZDIR, cunku ucret curve'un
    ///      disinda alinir ve rezervlere hic girmez.
    function graduationRaise(uint256 saleSupply, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (saleSupply >= tokenReserve) revert InsufficientTokenReserve();
        return FullMath.mulDiv(quoteReserve, saleSupply, tokenReserve - saleSupply);
    }

    /// @notice Havuzun curve'un kapanis fiyatindan acilmasi icin gereken tohum arzi.
    /// @dev D = S·(T−S)/T. `D = R / P_final` kosulunun sadelestirilmis halidir.
    function poolSeedSupply(uint256 saleSupply, uint256 tokenReserve) internal pure returns (uint256) {
        if (saleSupply >= tokenReserve) revert InsufficientTokenReserve();
        return FullMath.mulDiv(saleSupply, tokenReserve - saleSupply, tokenReserve);
    }
}
