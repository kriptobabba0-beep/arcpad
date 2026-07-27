// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title CurveMath
/// @notice Bonding curve'un tum aritmetigi. Sanal rezervli sabit carpim
///         (x·y=k) ailesinden; pump.fun'in kullandigi formullerin aynisi.
/// @dev Yuvarlama yonleri pump.fun'in @pump-fun/pump-sdk@1.36.0 kaynagindan
///      birebir alinmistir ve HEPSI protokol lehinedir. Alici lehine tek bir
///      yuvarlama, saldirganin 1 wei'lik milyonlarca islemle curve'u kurus
///      kurus bosaltmasina izin verir.
library CurveMath {
    /// @notice Baz puan paydasi.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    error ZeroAmount();
    error ZeroReserve();
    error InsufficientTokenReserve();
    error InvalidBps();

    /// @notice Tam `tokensOut` token almak icin curve'e odenecek quote miktari,
    ///         ucret HARIC.
    /// @dev floor(...) + 1. Bu, mulDivRoundingUp ile ayni DEGILDIR: tam bolunen
    ///      durumda bir birim fazla alir. pump.fun boyle yapar, biz de.
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

    /// @notice Ucret dusulmus `netQuoteIn_` quote ile alinabilecek token miktari.
    /// @dev Tabana yuvarlar. Her iki rezerv de sifir OLAMAZ: `quoteReserve == 0`
    ///      payda'yi `netQuoteIn_`'e indirger ve `netQuoteIn_ * tokenReserve /
    ///      netQuoteIn_ = tokenReserve` sonucunu -- yani rezervin TAMAMINI --
    ///      herhangi bir (hatta 1 wei'lik) girdi icin dondurur. Bu bir drain
    ///      deseni oldugundan sessizce degil, `ZeroReserve()` ile reddedilir.
    function quoteBuyTokensOut(uint256 netQuoteIn_, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (netQuoteIn_ == 0) revert ZeroAmount();
        if (quoteReserve == 0 || tokenReserve == 0) revert ZeroReserve();
        return FullMath.mulDiv(netQuoteIn_, tokenReserve, quoteReserve + netQuoteIn_);
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
    ///      DIKKAT -- bu, `netQuoteIn`'in kullandigi INCLUSIVE sozlesmenin
    ///      (ucret gross miktarin ICINE gomulu) TERSI DEGILDIR. Ikisi ayri
    ///      sozlesmelerdir ve birbirinin tersiymis gibi zincirlenemez:
    ///      `feeOn(netQuoteIn(g, b), b) != g - netQuoteIn(g, b)` genel olarak
    ///      dogru degildir (bkz. CurveMathTest.test_netQuoteInAndFeeOnUseIncompatibleFeeConventions).
    function feeOn(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        if (feeBps > BPS_DENOMINATOR) revert InvalidBps();
        return FullMath.mulDivRoundingUp(amount, feeBps, BPS_DENOMINATOR);
    }

    /// @notice Kullanicinin odedigi brut quote'tan curve rezervlerine girecek
    ///         net miktar; ucret `grossQuoteIn`'in ICINE gomulu (INCLUSIVE
    ///         sozlesme -- `grossQuoteIn` zaten ucreti icerir).
    /// @dev Bolmeden ONCE 1 cikarir, sonra tabana yuvarlar.
    ///      `totalFeeBps > BPS_DENOMINATOR` `InvalidBps()` ile reddedilir --
    ///      ANCAK bu sinir "%100'u asan bir ucret"i reddetmez. INCLUSIVE
    ///      sozlesmede fiili ucret orani `totalFeeBps / (totalFeeBps +
    ///      BPS_DENOMINATOR)`'dir; sinirin tam UZERINDE (totalFeeBps ==
    ///      BPS_DENOMINATOR) bile fiili ucret sadece %50'dir ve gecerli
    ///      girdi araliginda ucret hicbir zaman %100'e ulasamaz (bkz.
    ///      test_netQuoteInAllowsBpsEqualToDenominator: gross = 1_000_000
    ///      icin net = 499_999). Sinir yalnizca `totalFeeBps`'i `feeOn`'un
    ///      kullandigi EXCLUSIVE bps olcegiyle tutarli tutmak icindir.
    ///
    ///      Ima edilen ucret `grossQuoteIn - netQuoteIn(grossQuoteIn, totalFeeBps)`
    ///      olarak tanimlanir ve bu, `feeOn`'un EXCLUSIVE sozlesmeyle uretecegi
    ///      degerle AYNI DEGILDIR -- karistirilmamalidir (yukaridaki `feeOn`
    ///      notuna bakin).
    function netQuoteIn(uint256 grossQuoteIn, uint256 totalFeeBps) internal pure returns (uint256) {
        if (grossQuoteIn == 0) revert ZeroAmount();
        if (totalFeeBps > BPS_DENOMINATOR) revert InvalidBps();
        return FullMath.mulDiv(grossQuoteIn - 1, BPS_DENOMINATOR, totalFeeBps + BPS_DENOMINATOR);
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
