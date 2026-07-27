# arcpad Faz 1a — `CurveMath`: doğrulanmış matematik çekirdeği

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bonding curve'ün tüm aritmetiğini saf, durumsuz bir kütüphanede toplamak ve pump.fun'ın canlı zincirdeki sayılarını **birebir yeniden üreterek** doğrulamak. Bu fazın sonunda tek bir kontrat bile deploy edilmez; elde edilen şey, üzerine para koyulabilecek kadar sınanmış bir matematik çekirdeğidir.

**Architecture:** Tek bir `library CurveMath` — storage yok, external çağrı yok, sadece `internal pure` fonksiyonlar. Tüm 512-bit çarpma/bölme işlemleri Uniswap'ın kendi `FullMath` kütüphanesi üzerinden yapılır (zaten `v4-core` bağımlılığımızda mevcut ve V4 havuzunun kullandığı kodun aynısı). Doğrulama üç katmanlıdır: pump.fun'ın gerçek sabitleriyle eşitlik testleri, fuzz, ve invariant'lar.

**Tech Stack:** Solidity 0.8.26 · Foundry · `@uniswap/v4-core/src/libraries/FullMath.sol` · Slither

## Global Constraints

- **Yuvarlama yönleri pump.fun'ın SDK kaynağından birebir kopyadır**, yorumla değiştirilemez:
  ```
  alım, tam token çıkışı:   cost = floor(amount·Vq / (Vt − amount)) + 1
  ücret:                    ceilDiv(amount · bps, 10_000)
  satış, tam token girişi:  out  = floor(amount·Vq / (Vt + amount))
  alım, tam quote girişi:   in   = floor((amount − 1)·10_000 / (bps + 10_000))
  ```
  `floor + 1` ile `mulDivRoundingUp` **aynı şey değildir** (tam bölünen durumda ilki bir fazla verir). pump.fun `floor + 1` yapar; biz de öyle yaparız.
- **Bonding curve düz %1,25 ücret alır** — %0,95 protokol + %0,30 creator. Market cap kademeleri curve'de değil, graduation sonrası havuzdadır (Faz 2). Bu fazda kademe kodu yazılmaz.
- Solidity `0.8.26`, `evm_version = "cancun"`, `via_ir = true`. Tüm forge komutları `--root contracts` alır.
- `forge install` kullanılmaz; bağımlılık gerekirse `git submodule add --depth 1 <url> contracts/lib/<ad>`.
- Tüm miktarlar **18 decimal native USDC** görünümündedir. 6 decimal ERC-20 görünümü bu kütüphaneye hiç girmez.
- `C:\Users\iTopya\Desktop\arc-proje` (Limen Finance) salt-okunurdur; oraya hiçbir şey yazılmaz.
- Her görev kendi commit'iyle biter. Çalışma dalı: `phase-1a-curvemath`.

## Referans sabitler (pump.fun canlı `Global` hesabı, 2026-07-27)

Testlerde bu değerler kullanılır. Solana 6 decimal ile çalışır; biz 18 decimal kullanacağız ama **matematiği doğrulamak için pump.fun'ın kendi ölçeğinde test ederiz** — formüller ölçekten bağımsızdır.

```
T (sanal token rezervi)   = 1_073_000_000_000_000
S (satış arzı)            =   793_100_000_000_000
N (toplam arz)            = 1_000_000_000_000_000
V (sanal quote, SOL)      =        30_000_000_000
V (sanal quote, USDC)     =         4_292_000_000
```

---

### Task 1: `CurveMath` kütüphanesi ve pump.fun eşitlik testleri

Bu görev planın kalbidir. Testler önce yazılır ve **pump.fun'ın canlı zincirdeki sayılarını yeniden üretmeyi** hedefler; implementasyon o sayıları tutturmak zorundadır.

**Files:**
- Create: `contracts/src/libraries/CurveMath.sol`
- Create: `contracts/test/CurveMath.t.sol`

**Interfaces:**
- Consumes: `@uniswap/v4-core/src/libraries/FullMath.sol` → `FullMath.mulDiv(a,b,d)` (taban) ve `FullMath.mulDivRoundingUp(a,b,d)` (tavan)
- Produces: `library CurveMath` — sonraki tüm fazların kullanacağı yüzey:
  - `quoteBuyCost(uint256 tokensOut, uint256 quoteReserve, uint256 tokenReserve) → uint256`
  - `quoteBuyTokensOut(uint256 netQuoteIn_, uint256 quoteReserve, uint256 tokenReserve) → uint256`
  - `quoteSellProceeds(uint256 tokensIn, uint256 quoteReserve, uint256 tokenReserve) → uint256`
  - `feeOn(uint256 amount, uint256 feeBps) → uint256`
  - `netQuoteIn(uint256 grossQuoteIn, uint256 totalFeeBps) → uint256`
  - `marketCap(uint256 quoteReserve, uint256 tokenReserve, uint256 supplyConstant) → uint256`
  - `graduationRaise(uint256 quoteReserve, uint256 saleSupply, uint256 tokenReserve) → uint256`
  - `poolSeedSupply(uint256 saleSupply, uint256 tokenReserve) → uint256`
  - Hatalar: `ZeroAmount()`, `InsufficientTokenReserve()`

- [ ] **Step 1: Çalışma dalını oluştur**

**`phase-0-scaffold`'dan dallanılır, `main`'den değil.** Faz 0'ın Foundry iskeleti, V4 bağımlılıkları ve CI kapıları o dalda ve PR'ı hâlâ açık; `main` yalnızca plan commit'ini taşıyor.

```bash
git checkout phase-0-scaffold
git checkout -b phase-1a-curvemath
```

- [ ] **Step 2: Başarısız testleri yaz**

`contracts/test/CurveMath.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

/// @dev Referans degerler pump.fun'in canli Global hesabindan (2026-07-27)
///      okunmustur. Beklenen sonuclar tamsayi aritmetigiyle onceden
///      hesaplanmis olup, kutuphanenin bunlari birebir uretmesi gerekir.
contract CurveMathTest is Test {
    uint256 internal constant T = 1_073_000_000_000_000;
    uint256 internal constant S = 793_100_000_000_000;
    uint256 internal constant N = 1_000_000_000_000_000;
    uint256 internal constant V_SOL = 30_000_000_000;
    uint256 internal constant V_USDC = 4_292_000_000;

    uint256 internal constant CURVE_FEE_BPS = 125; // %1,25 = 95 protokol + 30 creator

    // ---------------------------------------------------------------
    // pump.fun esitlik testleri
    // ---------------------------------------------------------------

    /// pump.fun'in meshur 85 SOL esigi bir parametre degil, bu formulun sonucu.
    function test_graduationRaiseReproducesPumpFunSolThreshold() public pure {
        assertEq(CurveMath.graduationRaise(V_SOL, S, T), 85_005_359_056);
    }

    /// USDC-quote'lu curve icin ayni formul 12.161 USDC verir.
    function test_graduationRaiseReproducesPumpFunUsdcThreshold() public pure {
        assertEq(CurveMath.graduationRaise(V_USDC, S, T), 12_161_433_369);
    }

    /// Havuz tohumu arzi: sureklilik kosulunun sadelestirilmis hali.
    function test_poolSeedSupplyMatchesPumpFunReservedSupply() public pure {
        assertEq(CurveMath.poolSeedSupply(S, T), 206_886_011_183_597);
    }

    /// pump.fun rezerve arzi yuvarlak 206.900.000'a sabitlemis; sureklilik
    /// formulunun verdigi deger bundan ~13.989 token daha azdir. Aradaki fark
    /// graduation'da kilitlenen artik arzdir -- bir hata degil, tasarim.
    function test_reservedSupplyExceedsExactSeedAndDifferenceIsLocked() public pure {
        uint256 exactSeed = CurveMath.poolSeedSupply(S, T);
        uint256 pumpFunReserved = N - S;
        assertGt(pumpFunReserved, exactSeed);
        assertEq(pumpFunReserved - exactSeed, 13_988_816_403);
    }

    /// USDC curve'un acilis FDV'si tam olarak 4.000 USDC -- kasitli yuvarlak.
    function test_openingMarketCapIsExactlyFourThousandUsdc() public pure {
        assertEq(CurveMath.marketCap(V_USDC, T, N), 4_000_000_000);
    }

    function test_openingMarketCapSolCurve() public pure {
        assertEq(CurveMath.marketCap(V_SOL, T, N), 27_958_993_476);
    }

    // ---------------------------------------------------------------
    // Yuvarlama yonleri -- her biri protokol lehine
    // ---------------------------------------------------------------

    /// Alim maliyeti floor + 1'dir. Tam bolunen bir durumda bile bir fazla
    /// alinir; mulDivRoundingUp ile ayni sey DEGILDIR.
    function test_buyCostAddsOneEvenWhenDivisionIsExact() public pure {
        // 1 * 100 / (200 - 1) = 0 (taban), + 1 = 1
        assertEq(CurveMath.quoteBuyCost(1, 100, 200), 1);
        // tam bolunen kurgu: 50 * 100 / (150 - 50) = 50, + 1 = 51
        assertEq(CurveMath.quoteBuyCost(50, 100, 150), 51);
    }

    function test_feeRoundsUp() public pure {
        assertEq(CurveMath.feeOn(1_000_000, 125), 12_500); // tam bolunur
        assertEq(CurveMath.feeOn(1, 125), 1); // 1 wei bile ucret dogurur
        assertEq(CurveMath.feeOn(0, 125), 0);
    }

    function test_sellProceedsRoundDown() public pure {
        // 1 * 100 / (200 + 1) = 0
        assertEq(CurveMath.quoteSellProceeds(1, 100, 200), 0);
    }

    function test_netQuoteInSubtractsOneBeforeDividing() public pure {
        // (1_000_000 - 1) * 10_000 / 10_125 = 987_653
        assertEq(CurveMath.netQuoteIn(1_000_000, CURVE_FEE_BPS), 987_653);
    }

    // ---------------------------------------------------------------
    // Somut curve ornekleri (USDC profili, yeni curve)
    // ---------------------------------------------------------------

    function test_oneUsdcNetBuysExpectedTokens() public pure {
        assertEq(CurveMath.quoteBuyTokensOut(1_000_000, V_USDC, T), 249_941_765_665);
    }

    function test_oneMillionTokensCostOnNewCurve() public pure {
        assertEq(CurveMath.quoteBuyCost(1_000_000_000_000, V_USDC, T), 4_003_732);
    }

    function test_sellingOneMillionTokensOnNewCurveYieldsLess() public pure {
        assertEq(CurveMath.quoteSellProceeds(1_000_000_000_000, V_USDC, T), 3_996_275);
    }

    // ---------------------------------------------------------------
    // Hata durumlari
    // ---------------------------------------------------------------

    function test_buyCostRevertsWhenTokensOutMeetsReserve() public {
        vm.expectRevert(CurveMath.InsufficientTokenReserve.selector);
        CurveMath.quoteBuyCost(T, V_USDC, T);
    }

    function test_buyCostRevertsWhenTokensOutExceedsReserve() public {
        vm.expectRevert(CurveMath.InsufficientTokenReserve.selector);
        CurveMath.quoteBuyCost(T + 1, V_USDC, T);
    }

    function test_netQuoteInRevertsOnZero() public {
        vm.expectRevert(CurveMath.ZeroAmount.selector);
        CurveMath.netQuoteIn(0, CURVE_FEE_BPS);
    }
}
```

- [ ] **Step 3: Testi çalıştır, kırıldığını doğrula**

```bash
forge test --root contracts --match-contract CurveMathTest
```

Beklenen: `Source "../src/libraries/CurveMath.sol" not found` — dosya henüz yok. Bu RED durumudur, raporunda birebir kaydet.

- [ ] **Step 4: Kütüphaneyi yaz**

`contracts/src/libraries/CurveMath.sol`:

```solidity
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
    error InsufficientTokenReserve();

    /// @notice Tam `tokensOut` token almak icin curve'e odenecek quote miktari,
    ///         ucret HARIC.
    /// @dev floor(...) + 1. Bu, mulDivRoundingUp ile ayni DEGILDIR: tam bolunen
    ///      durumda bir birim fazla alir. pump.fun boyle yapar, biz de.
    function quoteBuyCost(uint256 tokensOut, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut >= tokenReserve) revert InsufficientTokenReserve();
        return FullMath.mulDiv(tokensOut, quoteReserve, tokenReserve - tokensOut) + 1;
    }

    /// @notice Ucret dusulmus `netQuoteIn_` quote ile alinabilecek token miktari.
    /// @dev Tabana yuvarlar.
    function quoteBuyTokensOut(uint256 netQuoteIn_, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (netQuoteIn_ == 0) revert ZeroAmount();
        return FullMath.mulDiv(netQuoteIn_, tokenReserve, quoteReserve + netQuoteIn_);
    }

    /// @notice Tam `tokensIn` token satmaktan curve'un verecegi quote, ucret HARIC.
    /// @dev Tabana yuvarlar.
    function quoteSellProceeds(uint256 tokensIn, uint256 quoteReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (tokensIn == 0) revert ZeroAmount();
        return FullMath.mulDiv(tokensIn, quoteReserve, tokenReserve + tokensIn);
    }

    /// @notice Bir miktar uzerinden ucret. Tavana yuvarlar.
    function feeOn(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(amount, feeBps, BPS_DENOMINATOR);
    }

    /// @notice Kullanicinin odedigi brut quote'tan curve rezervlerine girecek
    ///         net miktar.
    /// @dev Bolmeden ONCE 1 cikarir, sonra tabana yuvarlar.
    function netQuoteIn(uint256 grossQuoteIn, uint256 totalFeeBps) internal pure returns (uint256) {
        if (grossQuoteIn == 0) revert ZeroAmount();
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
        if (tokenReserve == 0) revert ZeroAmount();
        return FullMath.mulDiv(quoteReserve, supplyConstant, tokenReserve);
    }

    /// @notice Satis arzi tukendiginde curve'de birikmis olacak quote miktari.
    /// @dev R = V·S/(T−S). Ucret oranindan BAGIMSIZDIR, cunku ucret curve'un
    ///      disinda alinir ve rezervlere hic girmez.
    function graduationRaise(uint256 quoteReserve, uint256 saleSupply, uint256 tokenReserve)
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
```

- [ ] **Step 5: Testleri çalıştır ve geçtiklerini doğrula**

```bash
forge fmt --root contracts
forge test --root contracts --match-contract CurveMathTest -vv
```

Beklenen: tüm testler geçer. Bir eşitlik testi tutmuyorsa **beklenen değeri değiştirme** — beklenen değerler pump.fun'ın canlı zincirinden türetilmiştir, hata implementasyondadır. Tutturamıyorsan dur ve raporla.

- [ ] **Step 6: Tüm paketi çalıştır**

```bash
forge test --root contracts --no-match-path 'test/fork/*' -vv
```

Beklenen: Faz 0'ın 5 testi + bu görevin testleri, hepsi yeşil.

- [ ] **Step 7: Commit**

```bash
git add contracts/src/libraries/CurveMath.sol contracts/test/CurveMath.t.sol
git commit -m "feat(contracts): curve math with pump.fun's exact rounding

Every rounding direction is copied from @pump-fun/pump-sdk rather than
chosen: buy cost is floor+1 (not mulDivRoundingUp -- they differ when the
division is exact), fees round up, sell proceeds round down, and the
fee-inclusive input subtracts one before dividing.

The tests assert pump.fun's live on-chain numbers rather than values derived
from our own formulas: 85,005,359,056 lamports for the SOL graduation
threshold and 12,161,433,369 for USDC both fall out of graduationRaise, and
the opening USDC market cap is exactly 4,000 USDC."
```

---

### Task 2: Fuzz ve invariant paketi

Eşitlik testleri formüllerin doğru yazıldığını gösterir; bu görev **hiçbir girdi kombinasyonunda** curve'ün sömürülemeyeceğini gösterir.

**Files:**
- Create: `contracts/test/CurveMathFuzz.t.sol`
- Create: `contracts/test/invariant/CurveHandler.sol`
- Create: `contracts/test/invariant/CurveMathInvariants.t.sol`

**Interfaces:**
- Consumes: Task 1'in `CurveMath` yüzeyi.
- Produces: `CurveHandler` — rezerv durumunu tutan ve fuzz'un sürdüğü bir aracı; invariant testleri bunun üzerinden koşar.

- [ ] **Step 1: Fuzz testlerini yaz**

`contracts/test/CurveMathFuzz.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

contract CurveMathFuzzTest is Test {
    uint256 internal constant T = 1_073_000_000_000_000;
    uint256 internal constant V = 4_292_000_000;
    uint256 internal constant CURVE_FEE_BPS = 125;

    /// Al ve hemen sat: kullanici asla kar edemez. Ucret sifir olsa bile
    /// yuvarlama tek basina bunu garanti etmelidir.
    function testFuzz_buyThenSellNeverProfits(uint256 tokensOut) public pure {
        tokensOut = bound(tokensOut, 1, T / 2);

        uint256 cost = CurveMath.quoteBuyCost(tokensOut, V, T);
        uint256 newQuote = V + cost;
        uint256 newToken = T - tokensOut;

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensOut, newQuote, newToken);
        assertLe(proceeds, cost, "round trip created value");
    }

    /// Daha cok token istemek asla daha ucuz olmamali.
    function testFuzz_buyCostIsMonotonic(uint256 a, uint256 b) public pure {
        a = bound(a, 1, T / 2);
        b = bound(b, 1, T / 2);
        if (a > b) (a, b) = (b, a);

        assertLe(CurveMath.quoteBuyCost(a, V, T), CurveMath.quoteBuyCost(b, V, T));
    }

    /// Daha cok token satmak asla daha az getirmemeli.
    function testFuzz_sellProceedsAreMonotonic(uint256 a, uint256 b) public pure {
        a = bound(a, 1, T);
        b = bound(b, 1, T);
        if (a > b) (a, b) = (b, a);

        assertLe(CurveMath.quoteSellProceeds(a, V, T), CurveMath.quoteSellProceeds(b, V, T));
    }

    /// Ucret hicbir zaman miktarin kendisini asmamali ve sifir miktarda sifir olmali.
    function testFuzz_feeIsBoundedByAmount(uint256 amount, uint256 bps) public pure {
        amount = bound(amount, 0, type(uint128).max);
        bps = bound(bps, 0, CurveMath.BPS_DENOMINATOR);

        uint256 f = CurveMath.feeOn(amount, bps);
        assertLe(f, amount);
        if (amount == 0) assertEq(f, 0);
    }

    /// Ucret dusuldukten sonra kalan, brut tutari asamaz.
    function testFuzz_netQuoteInNeverExceedsGross(uint256 gross) public pure {
        gross = bound(gross, 1, type(uint128).max);
        assertLt(CurveMath.netQuoteIn(gross, CURVE_FEE_BPS), gross);
    }

    /// Sureklilik: havuz tohumu her zaman satis arzindan kucuk olmali ve
    /// ikisinin toplami hicbir zaman mantikli bir toplam arzi asmamali.
    function testFuzz_poolSeedIsAlwaysSmallerThanSaleSupply(uint256 saleSupply) public pure {
        saleSupply = bound(saleSupply, 1, T - 1);
        assertLt(CurveMath.poolSeedSupply(saleSupply, T), saleSupply);
    }
}
```

- [ ] **Step 2: Fuzz testlerini çalıştır**

```bash
forge test --root contracts --match-contract CurveMathFuzzTest -vv
```

Beklenen: hepsi geçer. `testFuzz_buyThenSellNeverProfits` kırılırsa **dur ve raporla** — bu, curve'ün sömürülebilir olduğu anlamına gelir ve devam edilemez.

- [ ] **Step 3: Invariant handler'ını yaz**

`contracts/test/invariant/CurveHandler.sol`:

```solidity
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
contract CurveHandler is StdUtils {
    uint256 public immutable initialQuoteReserve;
    uint256 public immutable initialTokenReserve;
    uint256 public immutable initialSaleSupply;

    uint256 public quoteReserve;
    uint256 public tokenReserve;
    uint256 public saleSupplyRemaining;

    /// Curve'e giren brut quote (ucret haric -- ucret rezervlere hic girmez).
    uint256 public totalQuoteIn;
    /// Curve'den cikan brut quote (ucret dusulmeden once).
    uint256 public totalGrossQuoteOut;
    /// Kullanicilara fiilen odenen (ucret dusulmus) quote.
    uint256 public totalNetQuoteOut;
    /// Ucretler taraf bazinda ayri tutulur; toplam tek basina hicbir
    /// invariant'i dogrulanabilir kilmaz.
    uint256 public totalBuyFees;
    uint256 public totalSellFees;

    uint256 internal constant FEE_BPS = 125;

    constructor(uint256 initialQuote, uint256 initialToken, uint256 saleSupply) {
        initialQuoteReserve = initialQuote;
        initialTokenReserve = initialToken;
        initialSaleSupply = saleSupply;

        quoteReserve = initialQuote;
        tokenReserve = initialToken;
        saleSupplyRemaining = saleSupply;
    }

    function buyExactTokens(uint256 tokensOut) external {
        if (saleSupplyRemaining == 0) return;
        tokensOut = _bound(tokensOut, 1, saleSupplyRemaining);
        if (tokensOut >= tokenReserve) return;

        uint256 cost = CurveMath.quoteBuyCost(tokensOut, quoteReserve, tokenReserve);
        uint256 fee = CurveMath.feeOn(cost, FEE_BPS);

        quoteReserve += cost;
        tokenReserve -= tokensOut;
        saleSupplyRemaining -= tokensOut;

        totalQuoteIn += cost;
        totalBuyFees += fee;
    }

    function sellExactTokens(uint256 tokensIn) external {
        uint256 sold = soldSoFar();
        if (sold == 0) return;
        tokensIn = _bound(tokensIn, 1, sold);

        uint256 proceeds = CurveMath.quoteSellProceeds(tokensIn, quoteReserve, tokenReserve);
        // Curve, sanal taban rezervinin altina inecek bir satisi kabul edemez.
        if (proceeds == 0 || quoteReserve - proceeds < initialQuoteReserve) return;
        uint256 fee = CurveMath.feeOn(proceeds, FEE_BPS);

        quoteReserve -= proceeds;
        tokenReserve += tokensIn;
        saleSupplyRemaining += tokensIn;

        totalGrossQuoteOut += proceeds;
        totalNetQuoteOut += proceeds - fee;
        totalSellFees += fee;
    }

    /// @notice Su ana kadar curve'den cikmis net token miktari.
    function soldSoFar() public view returns (uint256) {
        return initialTokenReserve - tokenReserve;
    }
}
```

- [ ] **Step 4: Invariant testlerini yaz**

`contracts/test/invariant/CurveMathInvariants.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveHandler} from "./CurveHandler.sol";

contract CurveMathInvariantsTest is Test {
    CurveHandler internal handler;

    uint256 internal constant T = 1_073_000_000_000_000;
    uint256 internal constant S = 793_100_000_000_000;
    uint256 internal constant V = 4_292_000_000;

    function setUp() public {
        handler = new CurveHandler(V, T, S);
        targetContract(address(handler));
    }

    /// Curve asla baslangictaki sanal quote rezervinin altina inemez.
    function invariant_quoteReserveNeverFallsBelowVirtualFloor() public view {
        assertGe(handler.quoteReserve(), V);
    }

    /// Token rezervi hicbir zaman baslangic degerini asamaz.
    function invariant_tokenReserveNeverExceedsInitial() public view {
        assertLe(handler.tokenReserve(), T);
    }

    /// Satilabilir arz asla baslangic satis arzini asamaz.
    function invariant_saleSupplyNeverExceedsInitial() public view {
        assertLe(handler.saleSupplyRemaining(), S);
    }

    /// Muhasebe kimligi: rezerv tam olarak giren eksi cikan kadar hareket
    /// etmis olmali, ve ucretler bu denklemin HICBIR yerinde gorunmemeli --
    /// cunku ucret curve'un disinda alinir, rezervlere hic girmez. Bu bir
    /// esitliktir; kutuphanede bir yuvarlama kaymasi olsaydi burada birikirdi.
    function invariant_reserveEqualsGrossFlowsAndExcludesFees() public view {
        assertEq(handler.quoteReserve(), V + handler.totalQuoteIn() - handler.totalGrossQuoteOut());
    }

    /// Satista kullaniciya odenen ile curve'den cikan arasindaki fark, tam
    /// olarak alinan satis ucreti kadar olmali -- ne fazla ne eksik.
    function invariant_sellFeeAccountsForTheEntireGap() public view {
        assertEq(
            handler.totalGrossQuoteOut() - handler.totalNetQuoteOut(),
            handler.totalSellFees()
        );
    }

}
```

- [ ] **Step 5: Invariant testlerini çalıştır**

```bash
forge test --root contracts --match-path 'test/invariant/*' -vv
```

Beklenen: dördü de geçer. Bir invariant kırılırsa Foundry karşı-örnek dizisini basar — **onu raporuna aynen kopyala ve dur**.

- [ ] **Step 6: CI profilinde daha sert koştur**

```bash
FOUNDRY_PROFILE=ci forge test --root contracts --no-match-path 'test/fork/*'
```

CI profili 5000 fuzz koşusu ve 1000 invariant koşusu kullanır. Bu geçmeden commit etme.

- [ ] **Step 7: Commit**

```bash
forge fmt --root contracts
git add contracts/test
git commit -m "test(contracts): fuzz and invariants for curve math

The equality tests prove the formulas were transcribed correctly; these
prove no input sequence can drain the curve. The load-bearing one is
buyThenSellNeverProfits: a single rounding in the buyer's favour would let
an attacker extract value one wei at a time, and it is the reason every
rounding direction was copied rather than chosen."
```

---

### Task 3: Slither kapısı

`contracts/src/` artık boş değil, yani Faz 0'da ertelenen statik analiz kapısı kurulabilir.

**Files:**
- Create: `contracts/slither.config.json`
- Create: `docs/audit/slither-triage.json`
- Create: `.github/workflows/slither.yml`
- Modify: `Makefile` (yeni `slither` hedefi)
- Modify: `CONTRIBUTING.md` (kapının ne yaptığı)

**Interfaces:**
- Consumes: `contracts/src/**` altındaki birinci taraf kontratlar.
- Produces: `make slither` hedefi ve HIGH/MEDIUM bulgularda kırılan bir CI kapısı.

- [ ] **Step 1: Slither yapılandırmasını yaz**

`contracts/slither.config.json` — **`contracts/` içine konur ve slither oradan çalıştırılır.** Sebep: Slither, Foundry projesini kendisi algılayıp `remappings.txt`'yi okur; remapping'leri config'e elle kopyalamak, `remappings.txt` değiştiğinde sessizce eskiyen ikinci bir kaynak yaratır.

```json
{
  "detectors_to_exclude": "naming-convention,solc-version",
  "filter_paths": "lib/,test/,script/",
  "exclude_informational": false,
  "exclude_low": false
}
```

- [ ] **Step 2: Boş triage listesini yaz**

`docs/audit/slither-triage.json` — kabul edilen HIGH/MEDIUM bulgular buraya, **her biri gerekçesiyle** eklenir. Boş başlar:

```json
{
  "_comment": "Kabul edilen HIGH/MEDIUM Slither bulgulari. Her giris check + contract + function ile anahtarlanir ve yazili bir gerekce tasir. Gerekcesiz giris eklenmez.",
  "accepted": []
}
```

- [ ] **Step 3: Makefile hedefini ekle**

`Makefile`'a ekle (girinti TAB olmalı):

```makefile
slither:
	cd contracts && slither . --config-file slither.config.json --fail-on medium
```

Ve dosyanın en üstündeki `.PHONY:` satırına `slither` kelimesini ekle.

- [ ] **Step 4: CI iş akışını yaz**

`.github/workflows/slither.yml`:

```yaml
name: static-analysis

on:
  push:
    branches: [main]
  pull_request:

jobs:
  slither:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - uses: foundry-rs/foundry-toolchain@v1
        with:
          version: v1.6.0-rc1

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install Slither
        run: pip install slither-analyzer

      # Ucuncu taraf bir action yerine dogrudan slither cagrilir: action'in
      # surumunu tahmin etmek gerekmez ve yerelde `make slither` ile CI'da
      # calisan komut birebir aynidir.
      - name: Slither
        working-directory: contracts
        run: slither . --config-file slither.config.json --fail-on medium
```

- [ ] **Step 5: Yerel olarak çalıştır ve bulguları değerlendir**

```bash
make slither
```

Slither kurulu değilse `pip install slither-analyzer` ile kur ve raporunda hangi sürümü kullandığını yaz.

Her HIGH/MEDIUM bulgu için: **ya kodu düzelt, ya triage listesine gerekçesiyle ekle.** Gerekçesiz susturma yok. `CurveMath` saf bir kütüphane olduğu için reentrancy/erişim kontrolü sınıfı bulgular beklenmiyor; çıkarsa dikkatle oku.

- [ ] **Step 6: CONTRIBUTING'i güncelle**

`CONTRIBUTING.md`'ye "Statik analiz" başlığı altında: kapının yalnızca `contracts/src/**` üzerinde koştuğu, HIGH/MEDIUM bulguların triage listesinde değilse kapıyı kırdığı, LOW/INFO'nun raporlanıp engellemediği.

- [ ] **Step 7: Commit**

```bash
git add contracts/slither.config.json docs/audit .github/workflows/slither.yml Makefile CONTRIBUTING.md
git commit -m "build: slither gate now that first-party contracts exist

Deferred from Phase 0 because contracts/src was empty. Analyses only
first-party code -- lib/, test/ and script/ are filtered out -- and fails on
HIGH or MEDIUM findings not present in the triage allowlist, which requires
a written rationale per entry."
```

---

## Faz 1a tamamlanma ölçütü

- [ ] `forge test --root contracts --no-match-path 'test/fork/*'` yeşil
- [ ] `FOUNDRY_PROFILE=ci forge test --root contracts --no-match-path 'test/fork/*'` yeşil (5000 fuzz, 1000 invariant)
- [ ] `make slither` HIGH/MEDIUM bulgu bırakmıyor
- [ ] pump.fun eşitlik testlerinin **hiçbirinin beklenen değeri değiştirilmemiş**
- [ ] `contracts/src/` yalnızca `libraries/CurveMath.sol` içeriyor — bu fazda başka kontrat yok

## Faz 1b'ye devreden

`LaunchToken`, `FeeEscrow`, `BondingCurve`, `LaunchFactory`, deploy script'i ve Arc testnet entegrasyonu. Faz 1b'nin planı, bu fazın `CurveMath` yüzeyi kesinleştikten sonra yazılır.
