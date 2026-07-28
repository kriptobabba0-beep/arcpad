// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdUtils} from "forge-std/StdUtils.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";

/// @dev Fuzz'un surdugu durum makinesi. Gercek bir curve kontratinin yerine
///      gecer: rezervleri tutar, alim/satim uygular ve akislari izler. Amac,
///      uzun rastgele islem dizilerinden sonra bile muhasebenin tutup
///      tutmadigini gormek.
/// @dev StdUtils'ten miras alir, cunku forge-std'nin `_bound`'u kenar
///      degerlerde bizim yazacagimiz modulo'dan daha az yanli dagitir.
/// @dev BURADA `StdAssertions`/`assertLe` KULLANILMAZ. Ilk denemede
///      kullanildi ve bir mutasyonla test edildi: `vm.assertLe` cheatcode'u
///      basarisiz oldugunda `pure` bir fonksiyon icinden cagrilsa bile
///      cagrildigi CALL'u REVERT ETTIRIYOR (StdAssertions.sol'daki yorumun
///      aksine, "pure" olmasi calistiginda revert etmeyecegini garanti
///      etmez). `foundry.toml`'daki `fail_on_revert = false` TAM OLARAK bu
///      revert'i -- fuzzed hedef fonksiyona yapilan cagridaki herhangi bir
///      revert'i -- sessizce iskartaya cikarir; invariant testi yine de YESIL
///      kalir. Olculdu: `assertLe(fee, cost, ...)` yerine kasten
///      `assertLe(cost, fee, ...)` yazilip calistirildiginda test PASS
///      verdi, sadece call-summary'de "Reverts" sayaci arttı. Yani
///      handler icinden cagrilan bir cheatcode assertion, `return` ile
///      atlanan bir guard'dan DAHA GUVENILIR DEGIL -- ikisi de fail_on_revert
///      tarafindan yutulur.
///
///      Dogru desen (asagida `buyFeeViolations`/`sellFeeViolations` icin
///      kullanilan) su: handler SADECE bir tam sayi sayaci artirir (asla
///      revert etmeyen duz aritmetik), ve gercek `assertEq(..., 0)` kontrolu
///      CurveMathInvariants.t.sol'daki bir `invariant_` fonksiyonu icinde
///      yapilir. O fonksiyon fuzzed hedef cagrisi DEGILDIR -- Foundry'nin
///      invariant kosucusu tarafindan HER calistirmadan sonra ayrica
///      cagirilir ve oradaki bir basarisizlik `fail_on_revert`'ten
///      BAGIMSIZ olarak testi kirmizi yapar. `floorBreachAttempts` (asagida)
///      zaten bu deseni kullaniyordu; ucret kontrolleri de simdi ayni
///      deseni izliyor.
/// @dev FEE_BPS sabit ve BPS_DENOMINATOR'un altinda oldugundan `feeOn`'un
///      InvalidBps guard'i hicbir zaman tetiklenmez. quoteReserve ve
///      tokenReserve de hicbir zaman sifira inemez (asagidaki fonksiyon
///      yorumlarina bakin) -- bu yuzden `ZeroReserve` guard'i icin de ekstra
///      bound gerekmez.
contract CurveHandler is StdUtils {
    uint256 public immutable initialQuoteReserve;
    uint256 public immutable initialTokenReserve;
    uint256 public immutable initialSaleSupply;

    uint256 public quoteReserve;
    uint256 public tokenReserve;
    uint256 public saleSupplyRemaining;

    /// Curve'e giren brut quote (ucret haric -- ucret rezervlere hic girmez).
    /// Sadece `buyExactTokens`'in exact-tokens-out yolunu izler; `net`
    /// (INCLUSIVE sozlesme) ile `cost` (EXCLUSIVE sozlesme) farkli ucret
    /// modelleri oldugundan `buyExactQuoteIn`'in akislari buraya KARISTIRILMAZ
    /// (bkz. `buyExactQuoteIn` yorumu).
    uint256 public totalQuoteIn;
    /// Curve'den cikan brut quote (ucret dusulmeden once).
    uint256 public totalGrossQuoteOut;
    /// Ucretler taraf bazinda ayri tutulur; toplam tek basina hicbir
    /// invariant'i dogrulanabilir kilmaz.
    uint256 public totalBuyFees;
    uint256 public totalSellFees;

    /// `sellExactTokens` sanal taban rezervini ihlal edecek bir satisi
    /// SESSIZCE atladigi anlarin sayisi. Bu invariant dosyasinda ==0 olarak
    /// dogrulanir: guard'in tetiklenmesi, `quoteSellProceeds`'un
    /// `invariant_quoteReserveNeverFallsBelowVirtualFloor`'u ihlal edecek bir
    /// deger urettigi ve guard'in bunu ORTADAN KALDIRDIGI anlamina gelir --
    /// yani floor invariant'i yesil gorunse bile CurveMath tarafi kirilmis
    /// olabilir. Dogru kutuphaneyle bu sayac hep sifir kalmalidir: `sold`
    /// kadarinin TAMAMI tek seferde satilsa bile (tokenReserve tam
    /// initialTokenReserve'e doner), sabit carpimin asla kucalmadigi
    /// gercegi (`invariant_constantProductNeverDecreases`) sonuc
    /// quoteReserve'un >= initialQuoteReserve olmasini garanti eder.
    uint256 public floorBreachAttempts;

    /// `feeOn`'un kendi garantisi (`fee <= amount`) ihlal edildiginde artan
    /// sayaclar -- toplam uzerinden degil, CAGRI BASINA. Toplam bir invariant
    /// (`totalBuyFees <= totalQuoteIn` gibi) 125 bps'te ~80x pay birakir:
    /// olcum -- feeOn ciktisini x2, x10, x50, x80 ile carpmak SIFIR
    /// basarisizlik verdi, x81 64/64 verdi. `feeOn` 10 kat yanlis bir ucret
    /// dondurse bile toplam invariant hala gecerdi. Dogru kutuphaneyle bu
    /// sayaclar hep sifir kalmalidir (feeOn'un kendi garantisi geregi);
    /// invariant dosyasinda ==0 olarak dogrulanir.
    uint256 public buyFeeViolations;
    uint256 public sellFeeViolations;

    /// Her fonksiyonun kac kez cagrildigi ve bunlarin kacinin bir guard'a
    /// carpip devlet degistirmeden erken dondugu. `return` bir EVM revert
    /// DEGILDIR -- Foundry'nin invariant call-summary tablosundaki "Reverts"
    /// sutunu bu erken donusleri GOSTERMEZ (StdInvariant sadece gercek
    /// revert'leri sayar). Bu yuzden "etkin cagri orani"ni gercekten olcmek
    /// icin kendi sayaclarimiz gerekir.
    uint256 public buyExactTokensAttempts;
    uint256 public buyExactTokensSkipped;
    uint256 public sellExactTokensAttempts;
    uint256 public sellExactTokensSkipped;
    uint256 public buyExactQuoteInAttempts;
    uint256 public buyExactQuoteInSkipped;

    uint256 internal constant FEE_BPS = 125;
    /// Zincirin exact-quote-in yolu ucreti IKI BAGIMSIZ parcadan toplar; tek
    /// bir birlesik oran kullanmaz (bkz. CurveMath.correctedNetQuoteIn).
    /// 95 + 30 == FEE_BPS, yani exact-tokens-out yoluyla ayni ucret rejimi.
    uint256 internal constant PROTOCOL_FEE_BPS = 95;
    uint256 internal constant CREATOR_FEE_BPS = 30;

    constructor(uint256 initialQuote, uint256 initialToken, uint256 saleSupply) {
        initialQuoteReserve = initialQuote;
        initialTokenReserve = initialToken;
        initialSaleSupply = saleSupply;

        quoteReserve = initialQuote;
        tokenReserve = initialToken;
        saleSupplyRemaining = saleSupply;
    }

    /// @dev tokensOut, saleSupplyRemaining'e siniirlanir ve saleSupplyRemaining
    ///      = tokenReserve - (initialTokenReserve - initialSaleSupply) esitligi
    ///      her iki fonksiyonda da ayni miktarla korundugundan, tokensOut her
    ///      zaman tokenReserve'den KESIN kucuktur -- `tokensOut >= tokenReserve`
    ///      dali savunma amaclidir, gercek kurulumda hic tetiklenmez.
    function buyExactTokens(uint256 tokensOut) external {
        buyExactTokensAttempts++;
        if (saleSupplyRemaining == 0) {
            buyExactTokensSkipped++;
            return;
        }
        tokensOut = _bound(tokensOut, 1, saleSupplyRemaining);
        if (tokensOut >= tokenReserve) {
            buyExactTokensSkipped++;
            return;
        }

        uint256 cost = CurveMath.quoteBuyCost(tokensOut, quoteReserve, tokenReserve);
        uint256 fee = CurveMath.feeOn(cost, FEE_BPS);
        if (fee > cost) buyFeeViolations++;

        quoteReserve += cost;
        tokenReserve -= tokensOut;
        saleSupplyRemaining -= tokensOut;

        totalQuoteIn += cost;
        totalBuyFees += fee;
    }

    function sellExactTokens(uint256 tokensIn) external {
        sellExactTokensAttempts++;
        uint256 sold = soldSoFar();
        if (sold == 0) {
            sellExactTokensSkipped++;
            return;
        }
        tokensIn = _bound(tokensIn, 1, sold);

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensIn, quoteReserve, tokenReserve);
        if (proceeds == 0) {
            sellExactTokensSkipped++;
            return;
        }
        // Curve, sanal taban rezervinin altina inecek bir satisi kabul
        // edemez. Bu artik SESSIZCE atlanmiyor: `floorBreachAttempts` sayaci
        // artiyor, boylece guard'in ne siklikta (ideal olarak hic)
        // tetiklendigi invariant dosyasinda dogrulanabiliyor.
        if (quoteReserve - proceeds < initialQuoteReserve) {
            floorBreachAttempts++;
            sellExactTokensSkipped++;
            return;
        }
        uint256 fee = CurveMath.feeOn(proceeds, FEE_BPS);
        if (fee > proceeds) sellFeeViolations++;

        quoteReserve -= proceeds;
        tokenReserve += tokensIn;
        saleSupplyRemaining += tokensIn;

        totalGrossQuoteOut += proceeds;
        totalSellFees += fee;
    }

    /// @notice Tam quote girisiyle alim -- gercek bir launch'ta kullanicinin
    ///         asil yaptigi sey budur (ne kadar harcamak istedigini soyler,
    ///         karsiliginda ne kadar token aldigini gorur). `buyExactTokens`
    ///         `quoteBuyCost`+`feeOn` (EXCLUSIVE ucret: kullanici cost'un
    ///         USTUNE ucret oder) yolunu kapsarken, bu fonksiyon
    ///         `correctedNetQuoteIn`+`quoteBuyTokensOut` (INCLUSIVE ucret:
    ///         ucret `grossQuoteIn`'in ICINE gomulu) yolunu kapsar --
    ///         CurveMath.t.sol test_splitCeilsChargeMoreThanTheCombinedRate'in
    ///         gosterdigi gibi bu iki sozlesme birbirinin tersi degildir ve
    ///         zincirlenemez. Bu yuzden bu fonksiyonun akislari
    ///         totalQuoteIn/totalBuyFees ledger'ina KARISTIRILMAZ; tek amaci
    ///         quoteReserve/tokenReserve durumunu ilerletip
    ///         `invariant_constantProductNeverDecreases`'in exact-in yolunu
    ///         da kapsamasini saglamaktir.
    /// @dev Guvenlik kaniti (q=quoteReserve, r=tokenReserve, n=duzeltilmis net,
    ///      t=quoteBuyTokensOut(n,q,r)): 4. adim curve terimini n-1 ile
    ///      besledigi icin t <= (n-1)r/(q+n-1) <= nr/(q+n) (gercel), dolayisiyla
    ///      (q+n)(r-t) >= (q+n)r - n r = qr. Yani sabit carpim burada da asla
    ///      kucalmaz -- `-1` bu kaniti sadece GUCLENDIRIR.
    /// @dev Alt sinir 1 -> 4. `correctedNetQuoteIn` gross=2'de, ardindan gelen
    ///      `quoteBuyTokensOut` ise duzeltilmis net <= 1 iken (gross 1 ve 3)
    ///      `NetTooSmall` ile REVERT eder. Bu dosyanin bas yorumunun anlattigi
    ///      uzere `fail_on_revert = false` boyle bir revert'i sessizce
    ///      iskartaya cikarirdi -- yani sayaclara da yansimadan kaybolurdu.
    ///      Bu yuzden bunlar bir `if` ile degil, aralikla diskarda birakilir;
    ///      gross >= 4 icin duzeltilmis net ISPATEN >= 2'dir (bkz.
    ///      CurveMathFuzz.t.sol testFuzz_buyTokensOutThenSellNeverProfits'in
    ///      elle turetilmis siniri).
    function buyExactQuoteIn(uint256 grossQuoteIn) external {
        buyExactQuoteInAttempts++;
        if (saleSupplyRemaining == 0) {
            buyExactQuoteInSkipped++;
            return;
        }
        grossQuoteIn = _bound(grossQuoteIn, 4, type(uint128).max);

        (uint256 net,,) = CurveMath.correctedNetQuoteIn(grossQuoteIn, PROTOCOL_FEE_BPS, CREATOR_FEE_BPS);

        uint256 tokensOut = CurveMath.quoteBuyTokensOut(net, quoteReserve, tokenReserve);
        // saleSupplyRemaining sinirini asan bir alim reddedilir -- CurveMath
        // bu iş kuralini bilmez, sadece handler'in kendi muhasebesi bilir.
        // Bu ayni zamanda tokensOut < tokenReserve'i de garanti eder (bkz.
        // buyExactTokens'taki tokenReserve-saleSupplyRemaining=sabit notu).
        if (tokensOut == 0 || tokensOut >= saleSupplyRemaining) {
            buyExactQuoteInSkipped++;
            return;
        }

        quoteReserve += net;
        tokenReserve -= tokensOut;
        saleSupplyRemaining -= tokensOut;
    }

    /// @notice Su ana kadar curve'den cikmis net token miktari.
    function soldSoFar() public view returns (uint256) {
        return initialTokenReserve - tokenReserve;
    }
}
