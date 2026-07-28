# arcpad Faz 1c — Bonding Curve ve Launch Factory

> **Ajan çalışanlar için:** ZORUNLU ALT BECERİ: Bu planı görev görev uygulamak için `superpowers:subagent-driven-development` kullanın. Adımlar takip için checkbox (`- [ ]`) sözdizimi kullanır.

**Hedef:** Bir launch'ın tüm ticaret hayatını zincirde çalışır hâle getirmek — token ve curve'ün sahteciliğe kapalı biçimde eşleştirilmesi, alım, satım, ücretlerin escrow'a akıtılması ve curve'ün tamamlanması.

**Mimari:** `LaunchFactory` her launch için bir `LaunchToken` ve bir `BondingCurve` üretir; ikisi CREATE2 ile birbirine bağlanır, öyle ki bir token'ın curve'ü **türetilebilir** olur ve saklanan bir işaretçiye güvenilmez. `BondingCurve` sanal rezervler üzerinde sabit çarpım işletir, ücreti curve'ün **dışında** alır ve `FeeEscrow`'a parça parça yatırır. Faz 1a'nın `CurveMath`'i bu fazın ilk görevinde düzeltilir: içindeki bir yuvarlama kuralı pump.fun'ın SDK **tahmin edicisinden** kopyalanmıştı, zincirdeki algoritmadan değil.

**Teknoloji yığını:** Solidity 0.8.26, EVM `cancun`, `via_ir`, Foundry. Zincir: Arc L1 (chainId 5042002), native gas varlığı USDC.

---

## Bu fazın kapsamı dışında

**Deploy script'i ve Arc testnet entegrasyonu Faz 1d'ye alındı.** Gerekçe: ikisi de operasyonel iştir ve bu fazın hiçbir açık kararına bağlı değildir; buraya konsaydı, dört göreve ek olarak gözden geçirilecek beşinci bir yüzey daha yaratır ve fazın ritmini bozardı. `LaunchFactory` ise `BondingCurve` ile **iç içedir** — curve, constructor'ında token'ın kendisini işaret ettiğini doğrulamak zorundadır — bu yüzden ayrılamaz ve burada kalır.

Graduation'ın havuz tarafı (Uniswap V4 hook'u, likidite tohumlama, LP token yakma) Faz 2'dir. Bu fazda curve yalnızca `complete` bayrağını çevirir ve ticareti durdurur.

---

## Global Kısıtlar

Bu bölüm her görevin gereksinimlerine **örtük olarak dâhildir**.

- Solidity `0.8.26`, `evm_version = "cancun"`, `via_ir = true`, `optimizer_runs = 800`.
- `contracts/foundry.toml` **yalnızca** Görev 4'ün ABI yüzey testi için `fs_permissions` eklemek üzere değiştirilebilir. Başka hiçbir değişiklik yapılmaz; yapılırsa rapora gerekçesiyle yazılır.
- `forge fmt --check --root contracts`, `make lint`, `make slither` temiz olmalı. HIGH/MEDIUM her Slither bulgusu ya düzeltilir ya `docs/audit/slither-triage.json`'a yazılı gerekçeyle işlenir.
- Testler **her iki profilde** (`default` ve `ci`) yeşil olmalı.
- **Ücret parçalardan toplanır, toplamdan bölünmez.** `feeOn(x, 95) + feeOn(x, 30)`. `125` ileri yönde (ücret hesaplarken) hiçbir yerde görünmez. Ölçüldü: iki parçanın toplamı, birleşik oranın tavan yuvarlamasını `x ∈ [1, 40000]` aralığının **20.220**'sinde aşar; toplamdan bölmek her seferinde protokolün aleyhinedir.
- **Rezervler ücret öncesi curve tutarıyla hareket eder.** Ücret curve'ün dışında alınır. Bu yüzden graduation raise'i ücret oranından bağımsızdır.
- **Katı CEI.** pump.fun'ın etki sırası `kontroller → ücret CPI → transferler → rezerv güncelleme → olaylar` şeklindedir; rezervler transferlerden **sonra** yazılır. Solana'da hesap kilitleme yüzünden güvenlidir, **EVM'de değildir**. arcpad bu sırayı ters çevirir: tüm defter yazımları her dış çağrıdan önce biter.
- **Curve'de kademe taraması yoktur.** arcpad ücret kademelerini launch anında dondurur (kullanıcı kararı), curve düz %1,25 alır. Not: pump.fun'ın curve'ünde **gerçekte bir kademe taraması vardır** — `computeFeesBps` her işlemde market cap hesaplar ve `calculateFeeTier` çağırır, canlı loglarda her curve işleminde `Instruction: GetFees` görünür. Düz görünmesinin sebebi curve'ün `FeeConfig`'inin tek bir kademe (eşik 0) taşımasıdır. Yani bu, pump.fun'ın mekanizmasının **bilinçli sadeleştirmesidir**, taklidi değil. `CurveMath.marketCap`'in Faz 1'de çağıranı olmaması da bu tercihin sonucudur.
- **Creator ücreti yalnızca creator sıfır değilse alınır ve alınmadığında yeniden dağıtılmaz** — işlem sadece 30 bps daha ucuz olur. Creator payını protokol payına katlamak yasaktır.

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `contracts/src/libraries/CurveMath.sol` | **değişir** — exact-quote-in algoritması zincirinkiyle değiştirilir |
| `contracts/src/LaunchToken.sol` | **değişir** — `launchSalt` immutable'ı eklenir (Görev 3'ün kimlik doğrulaması için) |
| `contracts/test/LaunchToken.t.sol` | **değişir** — constructor imzası değiştiği için |
| `contracts/src/BondingCurve.sol` | **yeni** — rezervler, alım, satım, ücret yönlendirme, tamamlanma |
| `contracts/src/LaunchFactory.sol` | **yeni** — CREATE2 ile token+curve üretimi, türetilebilir eşleşme |
| `contracts/test/CurveMath.t.sol` | **değişir** — sabitlenmiş değerler yeniden türetilir |
| `contracts/test/CurveMathFuzz.t.sol` | **değişir** — iki fuzz özelliği eski konvansiyonu kodluyor |
| `contracts/test/BondingCurve.t.sol` | **yeni** |
| `contracts/test/LaunchFactory.t.sol` | **yeni** |
| `contracts/test/invariant/CurveTradingHandler.sol` | **yeni** |
| `contracts/test/invariant/BondingCurveInvariants.t.sol` | **yeni** |
| `contracts/test/Surface.t.sol` | **yeni** — dört kontratın dış yüzeyini ABI ile sabitler |

---

## Görev 1: `CurveMath` — exact-quote-in algoritmasını zincirinkiyle değiştir

Faz 1a, `netQuoteIn`'i `@pump-fun/pump-sdk`'nin `getBuyTokenAmountFromSolAmount` yardımcısından aldı. O bir **zincir dışı tahmin edicidir**. Zincirdeki algoritma IDL'de `buy_exact_sol_in` üzerindeki doc-comment'te aynen verilmiştir ve farklıdır:

```
1. net    = floor(gross · 10_000 / (10_000 + totalFeeBps))          ← girdide −1 YOK
2. fees   = ceil(net·protocolBps/10_000) + ceil(net·creatorBps/10_000)
3. if net + fees > gross:  net = net − (net + fees − gross)          ← SDK bunu hiç yapmıyor
4. tokens = floor((net − 1)·Vt / (Vq + net − 1))                     ← −1 BURADA
```

**Ölçüldü:** canlı curve parametre aralığında 200.000 örnek, canlı 95+30 bps ile. `tokens_out` **102.318'inde (%51,16)** farklı çıkıyor ve SDK **102.318'in 102.318'inde** zincirden fazla token vaat ediyor — tersi hiç olmuyor. Bu, daha önce yakalanan `k`-çıkarma hatasının **aynı arıza kipidir**: kullanıcı lehine yuvarlayan bir formül. `ix_name`'i `buy_exact_sol_in` veya `buy_exact_quote_in` olan canlı işlemler 4. adım biçimiyle örtüşüyor, SDK biçimiyle değil.

**3. adım bir optimizasyon değil, gerçek bir taşmanın çaresidir.** Bağımsız iki tavan yuvarlaması bütçeyi aşabilir; program revert etmek yerine `net`'i **küçültür**. 3. adımı atlayan bir yeniden uygulama, pump.fun'ın kabul ettiği girdilerde revert eder. Bu aynı zamanda Faz 1b'nin "kısmi doldurmada iade taşabilir" açık kararının da cevabıdır: **`require` değil, kıs.**

**Files:**
- Modify: `contracts/src/libraries/CurveMath.sol`
- Modify: `contracts/test/CurveMath.t.sol`
- Modify: `contracts/test/CurveMathFuzz.t.sol`

**Interfaces:**
- Tüketir: yok.
- Üretir:
  - `netQuoteInBeforeCorrection(uint256 grossQuoteIn, uint256 totalFeeBps) → uint256` — yalnızca 1. adım.
  - `correctedNetQuoteIn(uint256 grossQuoteIn, uint256 protocolFeeBps, uint256 creatorFeeBps) → uint256` — 1'den 3'e; `BondingCurve`'ün exact-quote-in yolunda çağıracağı fonksiyon budur.
  - `quoteBuyTokensOut(uint256 correctedNet, uint256 quoteReserve, uint256 tokenReserve) → uint256` — 4. adım; **imzası aynı kalır, gövdesi `correctedNet − 1` kullanır.**
  - Yeni hata: `NetTooSmall()`.

- [ ] **Adım 1: Mevcut sabitlenmiş değerlerin hangilerinin değiştiğini ölç**

Kodu değiştirmeden önce, `CurveMath.t.sol` ve `CurveMathFuzz.t.sol` içinde eski konvansiyonu kodlayan her testi listele. Bilinenler:

- `test_netQuoteInSubtractsOneBeforeDividing` — adı bile eski kuralı ifade ediyor, düşecek.
- `test_netQuoteInAndFeeOnUseIncompatibleFeeConventions` — 3. adım tam olarak bu uyumsuzluğu kapattığı için anlamı değişiyor.
- `testFuzz_netQuoteInNeverExceedsGross` — hâlâ doğru olmalı.
- `testFuzz_netQuoteInPlusFeeOnOfNetNeverReachesGross` — **artık yanlış.** 3. adımdan sonra özellik `net + fees ≤ gross`'tur ve **eşitliğe izin verir**; "never reaches" eski, düzeltmesiz konvansiyonu kodluyor.

Bu listeyi rapora yaz. Bir testin neden düştüğünü yazmadan silme.

- [ ] **Adım 2: Başarısız testleri yaz**

`contracts/test/CurveMath.t.sol` içine ekle:

> **Beklenen değerler elle türetilmiştir ve kütüphaneyi çağırarak üretilmemelidir.** `FullMath.mulDiv` ile beklenen değeri hesaplayan bir test, kütüphaneyi kendisiyle karşılaştırır — bu projenin defalarca yakaladığı totoloji sınıfının ta kendisidir. Aşağıdaki literalleri olduğu gibi kullan. Ayrıca `CurveMath.t.sol`'de USDC sanal rezervinin adı **`V_USDC`**'dir (`V_TESTNET` diye bir sabit yoktur) ve `FullMath` bu dosyada import **edilmemiştir**; öyle kalmalı.

```solidity
/// 1. adim: girdiden 1 CIKARILMAZ. SDK'nin tahmin edicisi cikariyordu; zincir
/// cikarmiyor. Bolme tam bolundugunde ikisi farkli sonuc verir.
function test_netBeforeCorrectionDoesNotSubtractOneFromInput() public pure {
    // 10_125 * 10_000 / 10_125 = 10_000 tam bolunur.
    // Eski SDK kurali (gross-1) ile 9_999 verirdi.
    assertEq(CurveMath.netQuoteInBeforeCorrection(10_125, CURVE_FEE_BPS), 10_000);
}

/// 3. adim: iki BAGIMSIZ tavan yuvarlamasi butceyi asabilir; program revert
/// ETMEZ, net'i kisar. Bu girdide tasma tam olarak 1 birimdir.
///   gross      = 1_000_013
///   duzeltmesiz= 1_000_013 * 10_000 / 10_125            = 987_667
///   ucretler   = ceil(987_667*95/1e4) + ceil(987_667*30/1e4)
///              = 9_383 + 2_964                          =  12_347
///   987_667 + 12_347 = 1_000_014 > 1_000_013            -> tasma 1
///   duzeltilmis                                         = 987_666
function test_correctionShrinksNetWhenTheTwoCeilsOvershootTheBudget() public pure {
    assertEq(CurveMath.netQuoteInBeforeCorrection(1_000_013, CURVE_FEE_BPS), 987_667);
    assertEq(CurveMath.correctedNetQuoteIn(1_000_013, 95, 30), 987_666);
    // Duzeltmeden SONRA butceye sigar.
    assertEq(987_666 + CurveMath.feeOn(987_666, 95) + CurveMath.feeOn(987_666, 30), 1_000_012);
}

/// Duzeltme nadir bir uc durum DEGILDIR: gross in [1, 40000] araliginin
/// 20.017'sinde devreye girer. 3. adimi atlayan bir uygulama, pump.fun'in
/// kabul ettigi girdilerin yaklasik yarisinda revert eder.
function test_correctionIsNotAnEdgeCase() public pure {
    uint256 triggered;
    for (uint256 g = 1; g <= 40_000; ++g) {
        uint256 n = CurveMath.netQuoteInBeforeCorrection(g, CURVE_FEE_BPS);
        if (n + CurveMath.feeOn(n, 95) + CurveMath.feeOn(n, 30) > g) ++triggered;
    }
    assertEq(triggered, 20_017);
}

/// 4. adim: -1 curve teriminin ICINDE. Elle turetilmis:
///   (987_666 - 1) * T / (V_USDC + 987_666 - 1)
///   = 987_665 * 1_073_000_000_000_000 / 4_292_987_665
///   = 246_859_443_282
function test_buyTokensOutSubtractsOneInsideTheCurveTerm() public pure {
    assertEq(CurveMath.quoteBuyTokensOut(987_666, V_USDC, T), 246_859_443_282);
}

/// Ayni girdide SDK tahmin edicisi 246_859_693_167 vaat ederdi -- zincirden
/// 249_885 birim FAZLA. Kullanici lehine yuvarlayan formulun geri sizmasini
/// yakalayan sabitlenmis deger budur.
function test_theSdkEstimatorWouldHaveOverQuotedThisInput() public pure {
    assertLt(CurveMath.quoteBuyTokensOut(987_666, V_USDC, T), 246_859_693_167);
}

/// Duzeltilmis net 1'e dustugunde (net-1)=0 olur ve sifir token verirdi.
/// Sessizce sifir dondurmek yerine revert: cagiran para odeyip hicbir sey
/// almamali. Kucuk tutarlarda duzeltme net'i gercekten 0'a indirir --
/// gross=2 icin duzeltmesiz net=1, ucretler=2, tasma=1.
function test_buyTokensOutRevertsWhenNetIsOne() public {
    vm.expectRevert(CurveMath.NetTooSmall.selector);
    CurveMath.quoteBuyTokensOut(1, V_USDC, T);
}

function test_correctedNetRevertsWhenTheCorrectionWouldEraseIt() public {
    vm.expectRevert(CurveMath.NetTooSmall.selector);
    CurveMath.correctedNetQuoteIn(2, 95, 30);
}
```

`contracts/test/CurveMathFuzz.t.sol` içindeki yanlış özelliği **değiştir** (silme, değiştir):

`CurveMathFuzz.t.sol`'de USDC sanal rezervinin adı **`V`**'dir ve `FullMath` burada da import edilmemiştir. SDK karşılaştırmasını `FullMath` çağırmadan yaz — muladd taşmaz, çünkü `gross ≤ 1e30` ve `T ≈ 1e15` sınırlıdır ve `unchecked` kullanılmaz.

```solidity
/// 3. adimdan SONRA gecerli olan ozellik: duzeltilmis net ile iki ucret
/// parcasinin toplami butceyi ASLA asmaz -- ama esit OLABILIR. Eski surum
/// "never reaches" diyordu; o, DUZELTMESIZ konvansiyonun ozelligiydi ve
/// 3. adim eklendikten sonra yanlistir.
function testFuzz_correctedNetPlusFeesNeverExceedsGross(uint256 gross) public pure {
    gross = bound(gross, 1_000, 1e30);
    uint256 net = CurveMath.correctedNetQuoteIn(gross, 95, 30);
    assertLe(net + CurveMath.feeOn(net, 95) + CurveMath.feeOn(net, 30), gross);
}

/// Zincir SDK tahmin edicisinden ASLA daha comert degildir. Kullanici lehine
/// yuvarlayan bir formulun geri sizmasini yakalayan bekci budur; 200.000
/// ornekte SDK 102.318'inde fazla vaat etti, tersi hic olmadi.
function testFuzz_chainNeverGivesMoreTokensThanTheSdkEstimator(uint256 gross) public pure {
    gross = bound(gross, 1_000, 1e24);
    uint256 sdkNet = ((gross - 1) * 10_000) / (CURVE_FEE_BPS + 10_000);
    uint256 sdkTokens = (sdkNet * T) / (V + sdkNet);
    uint256 chainTokens = CurveMath.quoteBuyTokensOut(CurveMath.correctedNetQuoteIn(gross, 95, 30), V, T);
    assertLe(chainTokens, sdkTokens);
}
```

- [ ] **Adım 3: Testleri çalıştır, doğru sebeple kırıldıklarını doğrula**

```bash
forge test --root contracts --match-contract CurveMath
```

Beklenen: yeni testler derlenmiyor (`netQuoteInBeforeCorrection`, `correctedNetQuoteIn`, `NetTooSmall` yok). **Bu bir derleme hatasıdır, kırmızı test değildir** — raporda böyle yaz, "test başarısız oldu" deme.

- [ ] **Adım 4: `CurveMath`'i değiştir**

```solidity
/// @notice Zincirin exact-quote-in algoritmasinin 1. adimi.
/// @dev Girdiden 1 CIKARILMAZ. `@pump-fun/pump-sdk`'nin
///      `getBuyTokenAmountFromSolAmount` yardimcisi cikariyor ama o zincir
///      disi bir tahmin edicidir: 200.000 ornekte token ciktisi %51,16
///      ayrisiyor ve SDK her ayrismada zincirden FAZLA token vaat ediyor.
function netQuoteInBeforeCorrection(uint256 grossQuoteIn, uint256 totalFeeBps)
    internal
    pure
    returns (uint256)
{
    if (grossQuoteIn == 0) revert ZeroAmount();
    if (totalFeeBps > BPS_DENOMINATOR) revert InvalidBps();
    return FullMath.mulDiv(grossQuoteIn, BPS_DENOMINATOR, totalFeeBps + BPS_DENOMINATOR);
}

/// @notice 1'den 3'e: butceye sigan net anapara.
/// @dev 3. adim gercek bir tasmanin caresidir, optimizasyon degil. Protokol
///      ve creator paylari BAGIMSIZ olarak tavana yuvarlandigi icin toplam
///      butceyi asabilir; program revert etmek yerine net'i kisar. Bunu
///      atlayan bir uygulama, pump.fun'in kabul ettigi girdilerde revert eder.
///      Ucret parcalardan toplanir; birlesik oran ileri yonde kullanilmaz.
function correctedNetQuoteIn(uint256 grossQuoteIn, uint256 protocolFeeBps, uint256 creatorFeeBps)
    internal
    pure
    returns (uint256)
{
    uint256 net = netQuoteInBeforeCorrection(grossQuoteIn, protocolFeeBps + creatorFeeBps);
    uint256 fees = feeOn(net, protocolFeeBps) + feeOn(net, creatorFeeBps);
    uint256 total = net + fees;
    if (total > grossQuoteIn) {
        uint256 overshoot = total - grossQuoteIn;
        if (overshoot >= net) revert NetTooSmall();
        net -= overshoot;
    }
    return net;
}
```

`quoteBuyTokensOut`'un gövdesini 4. adıma çevir:

```solidity
    if (netQuoteIn_ <= 1) revert NetTooSmall();
    if (quoteReserve == 0 || tokenReserve == 0) revert ZeroReserve();
    uint256 net = netQuoteIn_ - 1;
    return FullMath.mulDiv(net, tokenReserve, quoteReserve + net);
```

Eski `netQuoteIn` fonksiyonunu **sil**. Çağıranı yok (Faz 1b incelemesi bunu doğruladı) ve bırakılırsa yanlış olanın yanlışlıkla kullanılması için bir tuzak olur.

- [ ] **Adım 5: Testleri çalıştır ve düşenleri onar**

```bash
forge test --root contracts --match-contract CurveMath -vv
```

Adım 1'de listelediğin testleri, **neden değiştiklerini yazarak** güncelle. Sabitlenmiş bir değeri "testi geçirmek için" değiştirmek yasaktır; her yeni değer, zincir algoritmasından elle türetilip raporda gösterilmelidir.

- [ ] **Adım 6: Mutasyonla doğrula**

Scratchpad'e kopya al (depoya **dokunma**) ve şu üç mutasyonu tek tek uygula. Her biri için hangi testin kırıldığını raporla; kırılmıyorsa bu bir boşluktur ve **bildirilmelidir**:

| Mutasyon | Ne olmalı |
|---|---|
| 1. adımda `grossQuoteIn` yerine `grossQuoteIn - 1` (SDK'ya geri dön) | `test_netBeforeCorrectionDoesNotSubtractOneFromInput` |
| 3. adımı tamamen kaldır | `test_correctionShrinksNetWhenTheTwoCeilsOvershootTheBudget` ve `testFuzz_correctedNetPlusFeesNeverExceedsGross` |
| 4. adımda `net - 1` yerine `net` | `test_buyTokensOutSubtractsOneInsideTheCurveTerm` |
| 3. adımda `feeOn(net,125)` kullan (toplamdan böl) | `testFuzz_correctedNetPlusFeesNeverExceedsGross` **veya hiçbiri** — hangisi olduğunu ölç |

- [ ] **Adım 7: Commit**

```bash
forge fmt --root contracts
git add contracts/src/libraries/CurveMath.sol contracts/test/CurveMath.t.sol contracts/test/CurveMathFuzz.t.sol
git commit -m "fix(contracts): use the chain's exact-quote-in algorithm, not the SDK's estimator"
```

---

## Görev 2: `BondingCurve`

**Files:**
- Create: `contracts/src/BondingCurve.sol`
- Create: `contracts/test/BondingCurve.t.sol`

**Interfaces:**
- Tüketir: `CurveMath` (Görev 1'in düzeltilmiş hâli), `LaunchToken`, `FeeEscrow`.
- Üretir: `contract BondingCurve` —
  - `constructor(address creator_, address escrow_, address protocolTreasury_)` — **token argümanı YOKTUR.** Gerekçesi Görev 3'tedir: curve token'dan önce deploy edilir, böylece curve adresi token'a bağlı olmaz ve iki adres birbirini bekleyen döngüsel bir bağımlılık doğmaz. Factory bu üçünü de sabit tuttuğu için curve adresi yalnızca salt'ın fonksiyonudur.
  - `bind(address token_) external` — token adresini **yalnızca factory, yalnızca bir kez** yazar. Bu, constructor'dan ayrılmak zorunda kalan tek alandır. `bind` çağrılmadan önce **her ticaret giriş noktası revert eder**, yani initialize edilmemiş bir pencerede işlem yapılamaz.
  - `buyExactTokensOut(uint256 tokensOut, uint256 maxQuoteIn) payable`
  - `buyExactQuoteIn(uint256 minTokensOut) payable` — rezerve **kısar**, revert etmez.
  - `sellExactTokensIn(uint256 tokensIn, uint256 minQuoteOut)`
  - Immutable'lar: `token`, `creator`, `escrow`, `protocolTreasury`
  - Sabitler: `PROTOCOL_FEE_BPS = 95`, `CREATOR_FEE_BPS = 30`. **Birleşik `125` sabiti tanımlanmaz** — ileri yönde kullanılabilecek bir literal bırakmamak için. Yalnızca `correctedNetQuoteIn`'in içinde toplam olarak geçer.
  - Durum: `virtualTokenReserves`, `virtualQuoteReserves`, `realTokenReserves`, `realQuoteReserves`, `complete` — hepsi `public`.
  - Olaylar: `Trade(address indexed trader, bool isBuy, uint256 tokenAmount, uint256 quoteAmount, uint256 protocolFee, uint256 creatorFee, uint256 virtualTokenReserves, uint256 virtualQuoteReserves, uint256 realTokenReserves, uint256 realQuoteReserves)`, `Completed(address indexed token, uint256 realQuoteReserves, uint256 poolSeedSupply)`
  - Hatalar: `ZeroAmount()`, `CurveComplete()`, `NotEnoughTokensToBuy()`, `SlippageExceeded()`, `RefundFailed()`, `ZeroToken()`, `ZeroEscrow()`, `ZeroTreasury()`, `TokenDoesNotPointBack()`

`Trade` olayı rezervlerin **dördünü de** taşır. Gerekçe: pump.fun'ın `TradeEvent`'i aynısını yapar ve Faz 3'ün indexer'ı böylece her işlemden sonraki durumu zincire tekrar sormadan yeniden kurabilir. Ayrıca `Completed`, havuz tohum arzını taşır ki Faz 2 onu yeniden hesaplamak zorunda kalmasın.

### Tasarım kararları ve gerekçeleri

**Durum alanları pump.fun'ın `BondingCurve` hesabını yansıtır** (canlı hesap düzeninden alındı): `virtualTokenReserves`, `virtualQuoteReserves`, `realTokenReserves`, `realQuoteReserves`, `complete`, `creator`. pump.fun'da ayrıca `token_total_supply` ve `quote_mint` var; arcpad'de birincisi `LaunchToken.TOTAL_SUPPLY` sabitidir, ikincisi tek varlık (native USDC) olduğu için gereksizdir.

**`buyExactTokensOut` sınırda revert eder, kısmi doldurmaz.** pump.fun'ın `buy`'unun davranışı budur; canlı bir curve'e karşı simüle edildi ve `reserves+1` için `NotEnoughTokensToBuy` (6021) döndü, tam-rezerv geçti. Sıfır miktar için **ayrı** bir hata ve rezerv kontrolünden **önce** bir kontrol vardır.

**`buyExactQuoteIn` rezerve kısar.** Bu bir sapma değildir: pump.fun bu semantiği `buy_exact_sol_in` / `buy_exact_quote_in_v2` altında zaten sunar ve SDK'nın yardımcısı `BN.min(tokensReceived, realTokenReserves)` ile biter. Planın önceki taslağı bunu "arcpad'in bilinçli sapması" diye anlatıyordu; yanlıştı — arcpad pump.fun'ın **öbür giriş noktasını** varsayılan yapmayı seçmiştir.

**Slippage her iki tarafta da ücret-dâhil kontrol edilir.** `maxQuoteIn`, `msg.value`'ya karşı; `minQuoteOut`, kullanıcıya gerçekten ödenen net tutara karşı. Bunu tersine kurmak sessiz bir kullanıcı-zararı hatasıdır.

**Katı CEI.** pump.fun rezervleri transferlerden sonra yazar; EVM'de bu sömürülebilir. Sıra: doğrula → defteri yaz → `complete`'i çevir → olayı yay → token transferi → escrow'a yatır → iade. **Her defter yazımı her dış çağrıdan önce biter.**

**Ücret escrow'a iki ayrı `deposit` ile gider.** `FeeEscrow.deposit` sıfır tutarda `ZeroAmount()` ile revert ettiği için, sıfır pay **atlanmalıdır** — creator sıfırsa creator payı hiç yatırılmaz ve protokol payına **katlanmaz**. Satış yolunda `quoteSellProceeds` tabana yuvarlayıp sıfır verebilir; escrow'a dokunmadan önce `proceeds > 0` korunur.

- [ ] **Adım 1: Başarısız testleri yaz**

`contracts/test/BondingCurve.t.sol` — en az şu davranışları kapsa. Her testin adı, kırıldığında hangi iddianın düştüğünü söylemeli:

```solidity
// --- alim, tam token cikisi ---
test_buyExactTokensOutChargesCurveCostPlusBothFeeParts()
test_buyExactTokensOutRevertsWhenTokensExceedRealReserves()   // NotEnoughTokensToBuy
test_buyExactTokensOutRevertsOnZeroAmountBeforeCheckingReserves()  // hata SIRASI onemli
test_buyExactTokensOutRevertsWhenCostExceedsMaxQuoteIn()      // SlippageExceeded
test_buyRefundsTheUnusedRemainderOfMsgValue()

// --- alim, tam quote girisi ---
test_buyExactQuoteInClampsToRealReservesInsteadOfReverting()
test_buyExactQuoteInUsesTheChainAlgorithmNotTheSdkEstimator()
test_buyExactQuoteInRevertsWhenTokensBelowMinTokensOut()

// --- satim ---
test_sellPaysCurveProceedsMinusBothFeeParts()
test_sellRevertsWhenProceedsWouldBeZero()
test_sellRevertsWhenProceedsBelowMinQuoteOut()

// --- ucretler ---
test_feeIsSummedFromPartsNotDividedFromTheTotal()
test_creatorFeeIsSkippedWhenCreatorIsZeroAndNotFoldedIntoProtocol()

// --- tamamlanma ---
test_completeFlipsInsideTheBuyThatDrainsRealTokenReserves()
test_completeIsIrreversibleAndSellCannotUndoIt()
test_everyEntrypointRevertsWithCurveCompleteAfterCompletion()
test_reservesLandExactlyOnZeroWithNoDustOnAnExactOutCompletion()

// --- CEI ---
test_ledgerIsFullyWrittenBeforeAnyExternalCall()   // reentrant alici ile
```

**Son test özel olarak önemlidir.** Faz 1b'de aynı sınıftan bir test, fixture'ı saldırıyı imkânsız kıldığı için hiçbir şey kanıtlamıyordu ve bunu ancak mutasyon ortaya çıkardı. Bu testi yazarken, kurgunun saldırıyı **gerçekten mümkün kıldığını** önce doğrula: CEI'yi bilerek ters çevir, testin kırmızıya döndüğünü gör, sonra geri al.

- [ ] **Adım 2: Testleri çalıştır, kırıldığını doğrula**

```bash
forge test --root contracts --match-contract BondingCurveTest
```

Beklenen: `Source "../src/BondingCurve.sol" not found`.

- [ ] **Adım 3: `BondingCurve`'ü yaz**

Sıra bağlayıcıdır. `buyExactTokensOut`'un gövdesi şu iskeleti izler:

```solidity
// 1. DOGRULA
if (complete) revert CurveComplete();
if (tokensOut == 0) revert ZeroAmount();               // rezerv kontrolunden ONCE
if (tokensOut > realTokenReserves) revert NotEnoughTokensToBuy();

uint256 cost = CurveMath.quoteBuyCost(tokensOut, virtualQuoteReserves, virtualTokenReserves);
uint256 protocolFee = CurveMath.feeOn(cost, PROTOCOL_FEE_BPS);
uint256 creatorFee  = creator == address(0) ? 0 : CurveMath.feeOn(cost, CREATOR_FEE_BPS);
uint256 total = cost + protocolFee + creatorFee;
if (total > maxQuoteIn || total > msg.value) revert SlippageExceeded();

// 2. DEFTERI YAZ  (her dis cagridan ONCE)
virtualQuoteReserves += cost;
virtualTokenReserves -= tokensOut;
realTokenReserves    -= tokensOut;
realQuoteReserves    += cost;
bool justCompleted = realTokenReserves == 0;
if (justCompleted) complete = true;

// 3. OLAYLARI YAY
emit Trade(...);
if (justCompleted) emit Completed(...);

// 4. DIS CAGRILAR
IERC20(token).transfer(msg.sender, tokensOut);
IFeeEscrow(escrow).deposit{value: protocolFee}(protocolTreasury);
if (creatorFee != 0) IFeeEscrow(escrow).deposit{value: creatorFee}(creator);
uint256 refund = msg.value - total;
if (refund != 0) {
    (bool ok,) = msg.sender.call{value: refund}("");
    if (!ok) revert RefundFailed();
}
```

**İade için düz `call` kullanılır ve başarısızlığında revert edilir.** Arc'ta sözleşmelere native gönderimin başarılı olacağı garanti değildir; sessizce yutmak kullanıcının parasını yakar. Bu, `FeeEscrow`'un pull-based olmasının **tersi** bir tercihtir ve bilinçlidir: escrow'da fon başka bir alıcının parasını kilitlemesin diye çekilir, burada ise iade zaten `msg.sender`'ın kendi işleminin parçasıdır — başarısızsa işlemin tamamı geri alınmalıdır, yoksa kullanıcı ödediğinden azını alır.

`protocolFee` sıfır olamaz (`quoteBuyCost` en az 1 döndürür ve `feeOn` tavana yuvarlar), ama `creatorFee` creator sıfırken sıfırdır — bu yüzden koşullu. `FeeEscrow.deposit` sıfır tutarda `ZeroAmount()` ile revert eder, dolayısıyla koşulu kaldırmak her işlemi kırar.

- [ ] **Adım 4: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --match-contract BondingCurveTest -vv
```

- [ ] **Adım 5: Commit**

```bash
git add contracts/src/BondingCurve.sol contracts/test/BondingCurve.t.sol
git commit -m "feat(contracts): bonding curve with strict CEI and pump.fun's rounding"
```

---

## Görev 3: `LaunchFactory` — sahteciliğe kapalı token↔curve eşleşmesi

**Files:**
- Create: `contracts/src/LaunchFactory.sol`
- Create: `contracts/test/LaunchFactory.t.sol`

### Çözülen sorun

pump.fun'da `BondingCurve` hesabında **`mint` alanı yoktur**. Eşleşme saf PDA türetmesidir: `["bonding-curve", mint]`. Bu, eşleşmeyi **sahteciliğe kapalı** yapar — herkes bir mint'ten curve adresini yeniden türetip doğrulayabilir.

arcpad'in spec'i factory'nin önce curve klonunu, sonra token'ı üretmesini söylüyordu. Bu, eşleşmeyi **saklanan bir işaretçiye** çevirir ve Faz 1b'nin custody incelemesi bunun somut sonucunu ölçtü: herkes, gerçek bir launch'ın creator'ını, curve'ünü ve metadata URI'sini iddia eden sahte bir `LaunchToken` deploy edebilir ve tüm arzını gerçek curve'ün adresine basabilir. Zincirden okuyan bir indexer sahteyi gerçeğe bağlar.

**EVM'de PDA türetmesinin karşılığı CREATE2'dir**, ama saf hâliyle döngüseldir ve bu tuzağa düşülmemelidir: token'ın constructor'ı curve adresini ister (arzı oraya basacak), curve'ün salt'ı ise token adresinden türetilirse, iki adres birbirini bekler.

**Döngü, doğrulamanın yönü çevrilerek kırılır.** CREATE2'nin taşıyıcı özelliği şudur: `adres = f(factory, salt, keccak(initcode))`, ve factory'den türeyen bir adrese **yalnızca factory** deploy edebilir. O hâlde curve'ü token'dan türetmeye gerek yoktur; **token'ı kendi verisinden yeniden türetmek yeter.**

1. Factory önce curve'ü `salt = keccak256(msg.sender, name, symbol, uri, nonce)` ile CREATE2'de üretir. Curve'ün constructor argümanları token'ı **içermez** — yalnızca `creator`, `escrow`, `protocolTreasury` — böylece adresi token'a bağlı değildir.
2. Sonra token'ı **aynı salt** ile üretir; constructor argümanları `(name, symbol, uri, creator, curve, salt)` olur ve arz doğrudan curve'e basılır.
3. `LaunchToken` yeni bir `bytes32 public immutable launchSalt` alanı kazanır. Doğrulayıcının ihtiyaç duyduğu her şey artık token'ın üzerindedir.

Doğrulama tek hesaptır:

```
beklenen = CREATE2(factory, token.launchSalt(),
                   keccak(LaunchToken.creationCode ++
                          abi.encode(name, symbol, uri, creator, curve, launchSalt)))
kanonik   = (beklenen == token)
```

Bir sahteci istediği `creator()`, `curve()` ve `metadataURI()` değerlerini iddia edebilir — ama o değerlerle birlikte kendi adresi factory'den türeyen adrese eşit **olamaz**, çünkü o adrese deploy etmek yalnızca factory'nin elindedir. İndexer tek bir `isCanonical` çağrısıyla eler. pump.fun'ın PDA türetmesinin taşıdığı özelliğin aynısıdır ve `curve`'ün constructor argümanlarına dâhil olması, sahtecinin gerçek bir curve'ü iddia edip yine de kendi adresini tutturmasını engeller.

**Bu, `LaunchToken`'ı değiştirir** — merge edilmiş bir kontrat. `launchSalt` immutable'ı eklenir, `LaunchToken.t.sol`'ün tüm kurulum çağrıları ve Görev 4'ün ABI yüzey testi buna göre güncellenir. Kapsam artışı gerçektir ve rapora yazılmalıdır.

**Interfaces:**
- Tüketir: `LaunchToken` (değiştirilmiş), `BondingCurve` (Görev 2).
- Üretir: `contract LaunchFactory` —
  - `launch(string name, string symbol, string uri) → (address token, address curve)`
  - `isCanonical(address token) → bool` — **doğrulamanın tamamı budur.**
  - `predictAddresses(address creator_, string name, string symbol, string uri, uint256 nonce) → (address token, address curve)` — görünüm, off-chain önizleme için.
  - `launchCount() → uint256`
  - Olay: `Launched(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string uri, bytes32 salt)`
  - Hatalar: `EmptyName()`, `EmptySymbol()`

- [ ] **Adım 1: Başarısız testleri yaz**

Taşıyıcı test, saldırıyı **açıkça kurandır**. Faz 1b'nin dersi burada bağlayıcıdır: kurgunun saldırıyı gerçekten mümkün kıldığını önce doğrula, yoksa test hiçbir şey kanıtlamaz.

```solidity
/// Sahteci, gercek bir launch'in her alanini iddia eden bir token deploy
/// eder ve arzini GERCEK curve'un adresine basar. Faz 1b'nin custody
/// incelemesi bunun mumkun oldugunu olcmustu; burada elenmesi gerekir.
function test_aForgedTokenClaimingARealCurveIsNotCanonical() public {
    (address realToken, address realCurve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

    LaunchToken forged = new LaunchToken(
        "Arc Coin", "ARC", "ipfs://cid", LaunchToken(realToken).creator(), realCurve, bytes32(0)
    );

    // Sahte token gercek gibi OKUNUR...
    assertEq(forged.creator(), LaunchToken(realToken).creator());
    assertEq(forged.curve(), realCurve);
    assertEq(forged.metadataURI(), "ipfs://cid");
    // ...ama kanonik DEGILDIR.
    assertTrue(factory.isCanonical(realToken));
    assertFalse(factory.isCanonical(address(forged)));
}

/// Sahteci dogru salt'i tahmin etse bile adresi tutturamaz: o adrese
/// deploy etmek yalnizca factory'nin elindedir.
function test_aForgedTokenCannotBecomeCanonicalByGuessingTheSalt() public {
    (address realToken,) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
    bytes32 realSalt = LaunchToken(realToken).launchSalt();
    LaunchToken forged = new LaunchToken(
        "Arc Coin", "ARC", "ipfs://cid",
        LaunchToken(realToken).creator(), LaunchToken(realToken).curve(), realSalt
    );
    assertFalse(factory.isCanonical(address(forged)));
}

function testFuzz_everyLaunchIsCanonical(string calldata n, string calldata s, string calldata u) public
function test_theEntireSupplyIsAtTheCurveAfterLaunch()
function test_twoLaunchesWithIdenticalMetadataProduceDifferentAddresses()
function test_predictAddressesMatchesWhatLaunchActuallyDeploys()
function test_launchIsFreeAndTakesNoFee()          // kullanici karari: ucretsiz
function test_launchRevertsOnEmptyNameOrSymbol()
```

- [ ] **Adım 2: Testi çalıştır, kırıldığını doğrula**

```bash
forge test --root contracts --match-contract LaunchFactoryTest
```

Beklenen: `Source "../src/LaunchFactory.sol" not found`.

- [ ] **Adım 3: `LaunchToken`'a `launchSalt` ekle ve `LaunchFactory`'yi yaz**

```solidity
contract LaunchFactory {
    address public immutable escrow;
    address public immutable protocolTreasury;
    uint256 public launchCount;

    function launch(string calldata name_, string calldata symbol_, string calldata uri_)
        external
        returns (address token, address curve)
    {
        if (bytes(name_).length == 0) revert EmptyName();
        if (bytes(symbol_).length == 0) revert EmptySymbol();

        bytes32 salt = keccak256(abi.encode(msg.sender, name_, symbol_, uri_, launchCount++));

        // Once curve: constructor argumanlari token'i ICERMEZ, bu yuzden
        // adresi token'a bagli degildir ve dongusellik dogmaz.
        curve = address(new BondingCurve{salt: salt}(msg.sender, escrow, protocolTreasury));

        // Sonra token: ayni salt, ve arz dogrudan curve'e basilir.
        token = address(new LaunchToken{salt: salt}(name_, symbol_, uri_, msg.sender, curve, salt));

        BondingCurve(curve).bind(token);
        emit Launched(token, curve, msg.sender, name_, symbol_, uri_, salt);
    }

    /// @notice Bir token'in bu factory tarafindan uretilip uretilmedigi.
    /// @dev Token'in KENDI adresini, kendi acikladigi verilerden yeniden
    ///      turetir. Factory'den tureyen bir adrese yalnizca factory deploy
    ///      edebildigi icin, esitlik saglaniyorsa token kanoniktir ve
    ///      `curve()` alani factory'nin gecirdigi degerdir.
    function isCanonical(address token) external view returns (bool) {
        if (token.code.length == 0) return false;
        LaunchToken t = LaunchToken(token);
        bytes32 salt = t.launchSalt();
        bytes memory initCode = abi.encodePacked(
            type(LaunchToken).creationCode,
            abi.encode(t.name(), t.symbol(), t.metadataURI(), t.creator(), t.curve(), salt)
        );
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode)))))
        );
        return expected == token;
    }
}
```

`BondingCurve.bind(address token_)`, Görev 2'nin constructor'ından ayrılan tek adımdır: curve, token'dan önce deploy edildiği için token adresini constructor'da alamaz. `bind` **yalnızca factory tarafından, yalnızca bir kez** çağrılabilir ve `token`'ı yazdıktan sonra bir daha yazılamaz. Görev 2'nin `Üretir` bloğu buna göre güncellenir: `token` artık `immutable` değil, `bind` ile bir kez yazılan bir alandır. Testleri: `test_bindRevertsWhenCalledByAnyoneButTheFactory`, `test_bindRevertsOnTheSecondCall`, `test_everyTradingEntrypointRevertsBeforeBind`.

- [ ] **Adım 4: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --match-contract "LaunchFactoryTest|LaunchTokenTest" -vv
```

- [ ] **Adım 5: Mutasyonla doğrula**

Scratchpad kopyasında: `isCanonical`'ı `return true`'ya çevir; `launch`'tan `launchCount++`'ı kaldır (iki launch aynı adrese düşmeli, ikincisi revert etmeli); `initCode`'dan `t.curve()`'ü çıkar (sahteci farklı bir curve iddia edip kanonik kalabilmeli). Üçünün de bir testi kırması gerekir.

- [ ] **Adım 6: Commit**

```bash
git commit -m "feat(contracts): launch factory with an unforgeable token identity"
```

---

## Görev 4: Invariant paketi ve ABI yüzey testi

**Files:**
- Create: `contracts/test/invariant/CurveTradingHandler.sol`
- Create: `contracts/test/invariant/BondingCurveInvariants.t.sol`
- Create: `contracts/test/Surface.t.sol`
- Modify: `contracts/foundry.toml` — **yalnızca** `fs_permissions` eklemek için

### Invariant'lar

Handler, **kodlu ve kodsuz** aktörler karışımıyla rastgele alım/satım dizileri uygular. Faz 1b'nin dersi bağlayıcıdır: **handler'ın içinde assertion çağrılmaz** — forge-std'nin assertion'ları revert eder ve `fail_on_revert = false` bunları sessizce yutar. Ghost sayaç artırılır, `invariant_` içinde sıfır olduğu iddia edilir.

| Invariant | Neyi korur |
|---|---|
| `invariant_curveHoldsAtLeastWhatItOwesTraders` | Ödeme gücü |
| `invariant_realTokenReservesEqualTokenBalanceMinusSold` | Defter ile gerçek bakiye |
| `invariant_constantProductNeverDecreases` | Curve matematiği |
| `invariant_completeIsNeverUnset` | Tamamlanma geri alınamaz |
| `invariant_noTradeEverSucceedsAfterCompletion` | Ghost sayaç |
| `invariant_feesAlwaysSummedFromPartsNeverDividedFromTotal` | Ghost sayaç |
| `invariant_exactOutCompletionLeavesNoDust` | **Aşağıya bak** |

**Toz invariant'ı özel olarak gereklidir.** pump.fun'da toz **yapısal olarak yoktur**: `buy` tam-çıkışlı olduğu için `real_token_reserves` tam olarak sıfıra iner — iki canlı tamamlanma ölçüldü, ikisi de tam sıfır ve `virtual_token_reserves` tam `T−S`. **Kısmi doldurma bu garantiyi kaybettirir.** arcpad `buyExactQuoteIn`'de rezerve kıstığı için, o garantiyi bir fuzz invariant'ı olarak **yeniden kurmak zorundadır**.

### ABI yüzey testi

Faz 1b'nin yüzey testleri isim sayıyordu ve tavanı ölçüldü: `issue(address,uint256)` adlı bir minter, iki adımlı `setMinter`+`mint`, listede olmayan bir adrese kilitli minter, `burn(uint256)`, ve escrow'da `sweep` yerine `collect(address)` — hepsi paketi yeşil bırakıyor. `collect` uydurma değildir; pump.fun'ın kendi talimatı `collect_creator_fee_v2`'dir.

İsimden bağımsız tek kapanış: derleme çıktısındaki ABI'yi okuyup **dış fonksiyon kümesinin beklenen kümeye tam eşit** olduğunu iddia etmek. `vm.readFile` `fs_permissions` ister; bu fazda o izin bilinçli olarak açılır. Test **dört kontratı birden** kapsar: `LaunchToken`, `FeeEscrow`, `BondingCurve`, `LaunchFactory`. `LaunchToken`'ın "toplam arz sonsuza kadar sabit" iddiasını aşağıdan da sabitler.

- [ ] **Adım 1: Handler ve invariant'ları yaz**

Handler'ın iskeleti. **Aktör kümesi hem kodlu hem kodsuz adresler içermek zorundadır** — Faz 1b'de handler'ın üç alıcısı da kodsuz olduğu için paket, korumak için yazıldığı reentrancy penceresine yapısal olarak kördü ve bunu ancak mutasyon ortaya çıkardı.

```solidity
contract CurveTradingHandler is StdUtils {
    BondingCurve public immutable curve;
    address[4] public actors;   // 3 EOA + 1 reentrant kontrat

    // Ghost muhasebe
    uint256 public ghostQuoteIn;
    uint256 public ghostQuoteOut;
    uint256 public ghostTokensOut;

    // Ghost ihlal sayaclari -- HANDLER ICINDE ASSERTION YOK
    uint256 public tradeSucceededAfterCompletion;
    uint256 public feeWasDividedFromTotal;
    uint256 public completionLeftDust;

    function buyExactTokensOut(uint256 who, uint256 amount) external { ... }
    function buyExactQuoteIn(uint256 who, uint256 gross) external { ... }
    function sell(uint256 who, uint256 amount) external { ... }
}
```

`feeWasDividedFromTotal`, her işlemde yatırılan iki payın toplamının `feeOn(cost, 95) + feeOn(cost, 30)`'a eşit olduğunu ölçer ve `feeOn(cost, 125)`'e eşitse artar — toplamdan bölmenin geri sızmasını yakalayan sayaç budur.

`completionLeftDust`, `complete` çevrildiği işlemde `realTokenReserves != 0` ise artar.

- [ ] **Adım 2: Çalıştır, hepsinin geçtiğini doğrula**

```bash
forge test --root contracts --match-contract BondingCurveInvariantsTest -vv
FOUNDRY_PROFILE=ci forge test --root contracts --match-contract BondingCurveInvariantsTest
```

Biri kırılırsa Foundry karşı-örnek dizisini basar — **onu raporuna aynen kopyala ve dur.**

- [ ] **Adım 3: Mutasyonla kanıtla**

Faz 1b'nin dersi: geçen bir invariant, kısıtlayan bir invariant demek değildir. Her invariant için onu kıran **en az bir mutasyon** kaydedilmeli. Bir mutasyon hiçbirini kırmıyorsa bu bir boşluktur ve **bildirilmelidir**. Özellikle sına: CEI'yi ters çevir; `complete` kontrolünü kaldır; ücreti toplamdan böl; `buyExactQuoteIn`'in kısmasını kaldır.

- [ ] **Adım 4: ABI yüzey testini yaz ve `fs_permissions` ekle**

`contracts/foundry.toml`'a **yalnızca** şu satır eklenir, her iki profile de. Bu, planın `foundry.toml`'a izin verdiği tek değişikliktir; salt okuma, yalnızca `out/` altına:

```toml
fs_permissions = [{ access = "read", path = "./out" }]
```

`_assertSurface(contractName, expectedSelectors)`, artifact'ı okur, dış fonksiyonların selector kümesini çıkarır ve beklenen kümeyle **iki yönlü** karşılaştırır — eksik olan da hata, fazla olan da. İki yönlülük şarttır: yalnızca "beklenenlerin hepsi duruyor mu" diye bakan bir test, **eklenmiş** bir fonksiyonu göremez ki bütün mesele odur.

**Çıkarma mekanizmasını uygulayıcı belirler ve çalıştığını kanıtlar.** İki aday: (a) `vm.parseJson` ile `.abi` üzerinde jsonpath filtresi; (b) artifact'ın `methodIdentifiers` alanı — `out/<C>.sol/<C>.json` içinde selector→imza eşlemesi olarak zaten hazır bekler ve muhtemelen daha sağlamdır, çünkü ABI'yi yeniden ayrıştırmaz. **Hangisini seçtiğini ve diğerini neden seçmediğini rapora yaz.** Bu Foundry sürümünde birinin çalıştığını varsayma — dene.

- [ ] **Adım 5: Yüzey testini mutasyonla doğrula**

Faz 1b'nin hayatta kalan beş mutantını bu teste karşı çalıştır: `issue()`, `setMinter`+`mint`, prank edilmeyen adrese kilitli minter, `burn()`, `collect()`. **Beşinin de ölmesi gerekir.** Ölmeyeni raporla.

- [ ] **Adım 6: Commit**

---

## Faz 1c tamamlanma ölçütü

- [ ] `forge test --root contracts --no-match-path 'test/fork/*'` her iki profilde yeşil
- [ ] `make fmt-check`, `make lint`, `make slither` temiz; yeni HIGH/MEDIUM yok
- [ ] Her invariant için onu kıran en az bir mutasyon raporda kayıtlı
- [ ] Faz 1b'nin hayatta kalan beş yüzey mutantının **beşi de** ABI testiyle ölüyor
- [ ] `CurveMath`'in exact-quote-in yolu zincir algoritmasıyla örtüşüyor; SDK tahmin edicisi kodda kalmadı
- [ ] `contracts/src/` tam olarak: `libraries/CurveMath.sol`, `LaunchToken.sol`, `FeeEscrow.sol`, `BondingCurve.sol`, `LaunchFactory.sol`

## Faz 1d'ye devreden

Deploy script'i, Arc testnet entegrasyonu, ve şunlar:

- **Creator değiştirilebilirliği.** pump.fun'da curve creator'ı **dört ayrı yetki yoluyla değişebilir** ve her biri `SetCreatorEvent` yayar. arcpad'in spec §5.7'si creator'ın ücret alıcı cüzdanını değiştirebileceğini söylüyor. Faz 3'ün indexer'ı `Launched` olayındaki değeri **önbelleğe alırsa yanlış olur** — değişim olayına abone olmak zorundadır. Faz 1d bu yolu ve olayını tanımlamalı.
- **`LaunchToken` provenance.** `factory` alanı ve `curve_.code.length` kontrolü Görev 3'ün CREATE2 kurgusunu tamamlar; kurgu oturduktan sonra eklenmeli.
- **`v4-periphery` bağımlılığı** hâlâ hiçbir şey tarafından import edilmiyor; Faz 2'nin `HookMiner` ihtiyacı doğrulanana kadar tutuluyor.
