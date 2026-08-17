# arcpad Faz 2 — Graduation hedefi: V4 havuzu ve kalıcı likidite

> **Ajan çalışanlar için:** ZORUNLU ALT BECERİ: Bu planı görev görev uygulamak için `superpowers:subagent-driven-development` kullanın. Adımlar takip için checkbox (`- [ ]`) sözdizimi kullanır.

**Hedef:** Tamamlanmış bir bonding curve'ün ödemesini alıp, ERC-20 USDC ile eşleşmiş bir Uniswap V4 havuzu açmak, curve'ün kapanış fiyatında tohumlamak ve pozisyonu **çıkarılamaz** hâle getirmek — hepsi tek bir işlemde, ve Arc testnet'te fiilen çalışır durumda.

**Mimari:** Üç yeni kontrat ve bir kütüphane. `ArcpadLocker` graduation hedefidir: curve'den `(D, R)` çeker, `PoolKey`'i **launch başına** hesaplar, `sqrtPriceX96`'yı curve'ün kendi getter'larından türetir, `initialize` eder, `PoolManager.unlock` geri çağrısı içinde tam aralık likidite ekler ve pozisyonu **kod yazmayarak** yakar — çıkarma yolu hiç var olmaz. `ArcpadHook` havuzun kimliğini `beforeInitialize`'da korur ve swap ücretini `beforeSwap`/`afterSwap` deltalarıyla quote tarafında tahsil eder. `FeeSchedule` kademe tablosunu taşıyan immutable kontrattır. `GraduationMath` sıralama, 10¹² dönüşümü ve fiyat matematiğini **tek bir yerde** toplar.

**Teknoloji yığını:** Solidity 0.8.26, EVM `cancun`, `via_ir`, `optimizer_runs = 800`, Foundry. Zincir: Arc L1 (native gas varlığı USDC). Bağımlılıklar: `v4-core@46c6834`, `v4-periphery@3245c3c`, `uniswap-hooks@acbd604`, `openzeppelin-contracts@dbb6104`, `forge-std@v1.16.2`.

---

## Bu fazın kapsamı dışında

**`ArcpadRouter` Faz 2b'ye alındı.** Gerekçe yapısaldır, tercih değil: router hiçbir havuzun **kalıcı kimliğinin parçası değildir**. `PoolKey` yalnızca `(currency0, currency1, fee, tickSpacing, hooks)` taşır; router adresi orada geçmez, dolayısıyla sonradan yazılabilir, değiştirilebilir, hatta birden fazlası olabilir. Hook için bu **doğru değildir** (aşağıya bakınız) ve fark bu fazın kapsamını belirleyen tek ölçüttür.

**`BuybackVault`, creator fee sharing, cashback** — spec §5.8'in kendi kararıyla Faz 5 ve sonrası.

**Indexer'ın havuz tarafı (Faz 3).** Bu faz yalnızca `PoolSeeded` olayını yayınlar ve şemasını sabitler.

### Kapsam dışı BIRAKILAMAYAN şey, ve sebebi

**Hook'un ücret mantığı bu fazda tam olmak ZORUNDADIR.** `PoolKey.hooks` alanı `PoolId`'nin (`keccak256(abi.encode(key))`) girdisidir, yani **hook adresi her havuzun kalıcı kimliğinin parçasıdır**. V4'te hook adresinin alt 14 biti izin bayraklarını kodlar ve `BaseHook`'un constructor'ı bunu doğrular (`Hooks.validateHookPermissions`). Dolayısıyla:

> Hook'a sonradan bir izin bayrağı eklemek, hook'un **adresini** değiştirir; adresi değiştirmek **her `PoolKey`'i** değiştirir; bu da eski havuzların yeni hook tarafından yönetilmediği, yeni launch'ların eski havuzlarla aynı ailede olmadığı bir dünya demektir. **"Ücreti sonra ekleriz" diye bir yol yoktur.** İlk graduation, hook'un izin kümesini sonsuza kadar dondurur.

Bu yüzden Task 3 (`FeeSchedule`) ve Task 4 (`ArcpadHook`, ücret dâhil) bu fazda, ve **Task 5'ten (`ArcpadLocker`) önce** yer alır.

---

## Global Kısıtlar

Bu bölüm her görevin gereksinimlerine **örtük olarak dâhildir**.

### Araç zinciri

- Solidity `0.8.26`, `evm_version = "cancun"`, `via_ir = true`, `optimizer_runs = 800`.
- Tüm forge komutları `--root contracts` alır, depo kökünden çalıştırılır. `forge install` **kullanılmaz**; bağımlılıklar submodule'dür.
- `forge fmt --check --root contracts`, `make lint`, `make slither` temiz olmalı. HIGH/MEDIUM her Slither bulgusu ya düzeltilir ya `docs/audit/slither-triage.json`'a yazılı gerekçeyle işlenir.
- Testler **her iki profilde** (`default` ve `ci`) yeşil olmalı.
- `contracts/foundry.toml`'a bu fazda **iki** değişiklik yapılır ve başka hiçbiri yapılmaz: (a) `[profile.default]` ve `[profile.ci]`'nin **ikisine de** `fs_permissions` listesine `{ access = "read", path = "./deployments" }` eklenir (Task 7'nin adres defterini testler okur); (b) `[rpc_endpoints]`'e hiçbir şey eklenmez — `arc_testnet` zaten vardır. **`fs_permissions` mirasının değiştirme (replace) semantiği vardır** ve `foundry.toml`'un kendi yorumu bunu ölçerek kaydetmiştir: bir profil kendi listesini tanımladığında default'unkini **tamamen** değiştirir. Yeni girdi bu yüzden **her iki** listeye de eklenmek zorundadır; yalnızca `[profile.default]`'a eklemek `ci` altında `./out` iznini düşürür ve `Surface.t.sol`'ü **yalnızca CI'da** kırar.

### Arc

| Değer | Sabit |
|---|---|
| RPC (dokümante) | `https://rpc.testnet.arc.io` — `arc.network` hostu hâlâ cevap veriyor ama **dokümante değil**, kullanılmaz |
| Chain id (dokümante) | `5042002` |
| Chain id (çözülmemiş) | `5042` — bkz. **Task 0**. Hiçbir kod bu değere dayanmaz |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000`, **6 decimal** |
| Native USDC | aynı bakiye, **18 decimal**. `1 ERC-20 birimi = 10¹² wei` |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` (Arc testnet'te 69 bayt kod, ölçüldü) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (9.152 bayt, ölçüldü) |
| Bloklu test adresi | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (Arc testnet'in tohumladığı adres; native transfer revert eder) |

**`address(0)` bir arcpad `PoolKey`'inde ASLA görünmez.** Bu bir üslup kuralı değil, bu fazın en sessiz hata sınıfıdır. `PoolManager`'ın "native" kavramının **tamamı** `currency.isAddressZero()`'dur (`v4-core/src/types/Currency.sol`); Arc'ta `address(0)` ile `0x3600…` **aynı bakiyedir** ama `PoolManager` bunu bilemez. `{address(0), 0x3600…0000}` anahtarı `currency0 < currency1` kontrolünü **geçer** (`0x0 < 0x36…`) ve sessizce **USDC'nin kendisine karşı bir havuz** olur. Zincirde bunu reddeden hiçbir şey yoktur. **arcpad reddetmek zorundadır** — ve iki katmanda birden reddeder (Task 4 hook, Task 5 locker), ayrı testlerle.

**WUSDC yoktur ve yazılmaz.** Arc dokümanı emir kipinde yasaklar. Havuzun iki bacağı da sıradan ERC-20'dir; native para birimi kod yolu **hiç yoktur**.

**`anvil` Arc'ı yeniden üretemez.** Arc'ın kendi dokümanı: native-coin precompile'ları, EIP-7708 `Transfer` olayları ve USDC bloklama listesi **yalnızca gerçek bir Arc RPC'sine karşı** görünür. Task 8 bu yüzden zorunlu bir görevdir, kozmetik bir ek değil.

### Curve profili — türetilmez, kopyalanır

Aşağıdaki hiçbir sayı bu fazda yeniden türetilmez. Faz 1a/1c'nin ölçülmüş değerleridir.

```
T  (sanal token rezervi)      = 1_073_000_000e18 = 1_073_000_000_000_000_000_000_000_000
S  (satis arzi)               =   793_100_000e18 =   793_100_000_000_000_000_000_000_000
N  (toplam arz)               = 1e27
T - S (tamamlanmada sanal tok)=   279_900_000e18 =   279_900_000_000_000_000_000_000_000
D  (havuz tohumu, immutable)  = 206_886_011_183_597_390_493_942_218
N - S                         = 206_900_000_000_000_000_000_000_000
N - S - D (kalici artik)      =      13_988_816_402_609_506_057_782
V  testnet                    = 4_292e15 = 4_292_000_000_000_000_000
V  uretim                     = 4_292e18 = 4_292_000_000_000_000_000_000
```

### `R` bir sabit DEĞİLDİR — yol bağımlıdır, ve bu tasarımı belirler

`graduate()` `realQuoteReserves`'i öder. `realQuoteReserves` her alımın `quoteBuyCost`'unu toplar ve **`quoteBuyCost` koşulsuz bir `+1` içerir** (`CurveMath.sol`, NatSpec'i bu `+1`'i **taşıyıcı** olarak işaretler). Dolayısıyla:

```
R = SUM over alimlar of ( floor(tokensOut * Vq / (Vt - tokensOut)) + 1 )
```

**İki alımlık bir yol, tek alımlık yoldan daha fazla `R` biriktirir.** `CurveMath.graduationRaise` = `floor(V·S/(T−S))` yalnızca **alt sınırdır** ve `LaunchFactory.MIN_GRADUATION_RAISE`'in profil kontrolünde kullandığı değerdir — **havuzun tohumlanacağı miktar değildir.**

**Sonuç, ve bu fazın en önemli tasarım kararı:** `ArcpadLocker` fiyatı **hiçbir sabitten okumaz**. `curve.virtualQuoteReserves()` ve `curve.virtualTokenReserves()`'i graduation anında okur. Sabit yazılmış bir `sqrtPriceX96`, iki alımla tamamlanan her curve'de yanlış olurdu — ve hiçbir tek-alım testi bunu görmez.

Aşağıdaki tablo **kanonik tek-alım tamamlanması** içindir (`buyExactTokensOut(S, type(uint256).max)`), yani testlerin sabitleyeceği yol:

```
R_formula = floor(V*S/(T-S))                      <- factory tabani, HAVUZ TOHUMU DEGIL
R         = R_formula + 1                          <- tek alimda gercekten biriken
Vq_final  = V + R = curve.virtualQuoteReserves()
Vt_final  = T - S = curve.virtualTokenReserves()
R6        = R / 1e12                               <- havuza giden ERC-20 miktari
```

| | testnet | üretim |
|---|---|---|
| `R_formula` | `12_161_433_369_060_378_706` | `12_161_433_369_060_378_706_680` |
| **`R` (tek alım)** | `12_161_433_369_060_378_707` | `12_161_433_369_060_378_706_681` |
| **`Vq_final`** | `16_453_433_369_060_378_707` | `16_453_433_369_060_378_706_681` |
| **`R6`** | `12_161_433` (12,161433 USDC) | `12_161_433_369` (12.161,433369 USDC) |
| `R − R6·10¹²` (kalıcı artık) | `369_060_378_707` wei | `60_378_706_681` wei |
| Graduation FDV (6 dec USDC) | `58_783_256` = 58,783256 USDC | `58_783_256_052` = 58.783,256052 USDC |

**Çapraz doğrulama (bağımsız iki ölçüm örtüşüyor):** testnet profili için `P_final·10³⁶ = 58_783_256_052_377_201_525_544_837_441` ve `R/D·10³⁶ = 58_783_256_052_377_201_525_947_110_211`. Bu iki sayı graduation yüzeyi incelemesinin §5.2'de bağımsız olarak ölçtüğü değerlerle **birebir aynıdır**. Bu planın tüm `TickMath`/`LiquidityAmounts` yeniden uygulaması bu eşleşmeyle doğrulanmıştır.

**`+1`'in yönü:** `R = R_formula + 1` ile `R/D` **`P_final`'ın ÜSTÜNDEDİR**; `R = R_formula` ile **ALTINDA** kalır (ölçüldü, iki profilde de). Yön protokolün lehinedir ve `quoteBuyCost`'un NatSpec'i bunu taşıyıcı olarak kaydetmiştir. **Bu fazın hiçbir adımı o `+1`'e dokunmaz** — ama Task 6, o `+1` kaldırıldığında kırılan bir test yazmak zorundadır, çünkü bugün öyle bir test **yoktur**.

### `PoolKey` — her alanı ve gerekçesi

```solidity
PoolKey({
    currency0: /* HESAPLANIR, bkz. asagi */,
    currency1: /* HESAPLANIR */,
    fee:       0,          // V4 LP ucreti. SIFIR, ve degistirilemez.
    tickSpacing: 60,
    hooks:     IHooks(ARCPAD_HOOK)
})
```

**`fee = 0`, ve bu geri alınamaz bir garantidir.** V4'te havuz ücreti pozisyonlara birikir; arcpad'in tek pozisyonunun çıkarma yolu **yoktur**, yani sıfır olmayan bir havuz ücreti sonsuza kadar yakılırdı. Ayrıca — ve bu ölçülmüş kısmı — `PoolManager.updateDynamicLPFee` gövdesi şudur:

```solidity
if (!key.fee.isDynamicFee() || msg.sender != address(key.hooks)) {
    UnauthorizedDynamicLPFeeUpdate.selector.revertWith();
}
```

`0`, `LPFeeLibrary.DYNAMIC_FEE_FLAG` (`0x800000`) **değildir**, dolayısıyla `isDynamicFee()` false döner ve **hook'un kendisi bile** havuz ücretini değiştiremez. `fee = 0` seçimi böylece "şimdilik sıfır" değil, **yapısal olarak sıfır** olur. Test edilebilir: hook'tan `updateDynamicLPFee` çağrısı `UnauthorizedDynamicLPFeeUpdate()` ile döner.

**`tickSpacing = 60`, ve seçim keyfi değil.** Arcpad'in havuzunda tek bir tam aralık pozisyon vardır, dolayısıyla tick yoğunluğunun gaz maliyeti yoktur ve `tickSpacing` ekonomik olarak **atıldır**. Seçimi belirleyen tek şey sınır davranışıdır:

```
TickMath.minUsableTick(60) = -887220     getSqrtPriceAtTick(-887220) = 4306310044
TickMath.maxUsableTick(60) =  887220     getSqrtPriceAtTick( 887220) = 1457652066949847389969617340386294118487833376468
TickMath.MIN_SQRT_PRICE                 = 4295128739
TickMath.MAX_SQRT_PRICE                 = 1461446703485210103287273052203988822378723970342
```

`tickSpacing = 1` olsaydı sınırlar `±887272` olurdu ve `getSqrtPriceAtTick(887272)` tam olarak `MAX_SQRT_PRICE` döner — `getTickAtSqrtPrice`'in **kendisinin reddettiği** değer. `tickSpacing > 1` seçmek, locker'ın dokunduğu her sqrt fiyatını V4'ün doğruladığı aralığın **kesinlikle içinde** tutar ve bir bütün sınır-durum sınıfını fazdan çıkarır. 60, ihtiyaç duyulan tick aralığına (`±442.827`) **iki kat** pay bırakır.

```
Pool.tickSpacingToMaxLiquidityPerTick(60):
  minTick = sdiv(-887272,60) - (smod(-887272,60) < 0) = -14787 - 1 = -14788
  maxTick = sdiv( 887272,60)                          =  14787
  numTicks = 14787 - (-14788) + 1 = 29576
  maxLiquidityPerTick = (2^128 - 1) / 29576 = 11_505_354_575_363_080_317_263_139_282_924_270
```

arcpad'in en büyük `L`'si `1_586_200_000_000_000_000` (üretim), yani tavanın **7,25 × 10¹⁵**'te biri. Bu kontrol asla tetiklenmez ve neden tetiklenmediği burada yazılıdır.

**Para birimi sıraması HESAPLANIR, varsayılmaz.** `PoolManager.initialize` katı `currency0 < currency1` uygular (`>=` reddedilir, yani eşitlik de reddedilir). USDC `0x36…`'da oturur ve `LaunchFactory`'nin salt'ı **türetilmiştir, madenle bulunmamıştır** (`keccak256(abi.encode(msg.sender, name, symbol, uri, launchCount++))`), dolayısıyla token adresleri 160-bit uzayda tekdüzedir:

```
USDC'nin ALTINA dusen token orani = 0x36 / 0x100 = 54/256 = %21,09375
```

**Yaklaşık her beş launch'tan biri.** "Token her zaman `currency1`'dir" diye yazılmış bir kod, launch'ların %21'inde `CurrenciesOutOfOrderOrEqual` ile revert eder — ve o curve `graduated = false` ile, ödemesi geri alınmış hâlde, **sonsuza kadar mezun olamaz** durumda kalır. Bu, fazın en olası sessiz hatasıdır ve Task 2 tam olarak bunu kapatmak için vardır.

### 18 → 6 decimal sınırı — TEK bir yerde

```solidity
uint256 internal constant QUOTE_SCALE = 1e12;   // 1 ERC-20 birimi = 10^12 wei
```

Bu sabit **yalnızca `GraduationMath.sol`'de** görünür. Başka hiçbir dosyada `1e12`, `10**12` veya `1_000_000_000_000` literali bulunmaz; Task 6 bunu bir grep testiyle sabitler. Dönüşüm iki yerde uygulanır ve **her iki uç da test edilir**:

1. **Miktar:** `R6 = R / QUOTE_SCALE` (taban). Kalan `R mod QUOTE_SCALE` wei locker'da **kalıcı olarak** kalır — 1 ERC-20 biriminin altında olduğu için ERC-20 arayüzüyle hareket ettirilemez ve locker'ın native gönderme yolu yoktur. Graduation başına en fazla `10¹² − 1` wei. **Bu bir kayıp değil, bir özelliğin bedelidir:** locker kendi bakiyesini **hiç okumadığı** için, biriken artık hiçbir zaman sonraki bir launch'a yanlışlıkla atanamaz. Curve tarafının D6 kararının (bakiye okuması yok) locker tarafındaki aynası budur.
2. **Fiyat:** `sqrtPriceX96` hesabında bölen `Vt_final · QUOTE_SCALE`'dır. Dönüşümü unutmak fiyatı `10⁶` katıyla kaydırır (tick'te ~138.000 birim) ve Task 2'nin sabitlenmiş literalleri bunu yakalar.

### `sqrtPriceX96`'nın tanımı — spec §10 invariant 6'nın tek yazılı hâli

`sqrtPriceX96`, `currency1_raw / currency0_raw` oranının kareköküdür (V4 tanımı). Tanım **bir kez** yazılır ve iki sıralamada da aynı biçimdedir:

```
oran(X192) = floor( pay * 2^192 / payda )
sqrtPriceX96 = floor( sqrt( oran(X192) ) )

token = currency0  ->  pay = Vq_final,               payda = Vt_final * QUOTE_SCALE
USDC  = currency0  ->  pay = Vt_final * QUOTE_SCALE, payda = Vq_final
```

Her iki dalda da **aşağı** yuvarlanır. Sonuç: **havuz her zaman `P_final`'da ya da ondan Q64.96'nın en fazla bir ulp'si kadar aşağıda açar**, ve yön iki sıralamada da aynıdır. Üretim profilinde bir ulp göreli olarak `1/6,07×10²⁰ = 1,6×10⁻²¹`; testnet profilinde `5,2×10⁻²⁰`. **İki farklı formül kullanmak yasaktır** (örneğin bir dalı `2^192 / sqrtDiger` ile hesaplamak): tek bir invariant için iki tanım, tam olarak bir tutarsızlığın plana sızma biçimidir.

**Kanonik tek-alım tamamlanmasının dört literali** (Task 2 bunları `assertEq` ile sabitler):

| profil | sıralama | `sqrtPriceX96` | `tick` |
|---|---|---|---|
| üretim | token = `currency0` | `607444218490929862364` | `-373746` |
| üretim | USDC = `currency0` | `10333626601930376557517671504208461029` | `373745` |
| testnet | token = `currency0` | `19209072819323074681` | `-442827` |
| testnet | USDC = `currency0` | `326777965518061118072680912817470217035` | `442826` |

Dördü de `(MIN_SQRT_PRICE, MAX_SQRT_PRICE)` aralığının ve `[-887220, 887220]` tick aralığının **kesinlikle içindedir**.

### 256-bit uçurumu — hiç yazılmamış, taşıyıcı bir bağlılık

`USDC = currency0` dalında `oran(X192) = Vt_final · 10¹² · 2¹⁹² / Vq_final` **256 bitin tamamını** tüketir. Testnet profilinde değer `1,0678×10⁷⁷`, `2²⁵⁶` ise `1,1579×10⁷⁷` — **%8,4 pay**. `FullMath.mulDiv` sonuç sığmadığında revert eder, yani arıza sessiz değildir; ama graduation anında olur ve o launch **her denemede** revert eder.

```
Tasma kosulu:  Vq_final <= (T - S) * 1e12 >> 64 = 15_173_409_403_934_634_553
Vq_final = V * T / (T - S)  oldugundan:
               V        <=  3_958_096_264_828_801_689
LaunchFactory.MIN_OPENING_MARKET_CAP = 4e18  =>  V >= 4e18 * T / N = 4_292_000_000_000_000_000
Pay: 4_292_000_000_000_000_000 / 3_958_096_264_828_801_689 = x1,0844
```

**Yani Faz 2'nin taşma güvenliği, Faz 1c'nin piyasa değeri tabanına — %8,4 payla — bağlıdır, ve bunu hiç kimse yazmamıştır.** Bu, deponun adlandırdığı üçüncü arıza kipidir: *doğru olan bir iddia ve onu doğru kılan örtük şey.* Task 1 bunu örtük olmaktan çıkarır: `LaunchFactory`'nin constructor'ı, deploy başına bir kez, profilin **her iki sıralamada** temsil edilebilir bir havuz açılış fiyatı ürettiğini doğrular (`ProfileNotSeedable()`). Kontrol sihirli sayı içermez — fiili fonksiyonu çağırır.

### Tohumlama miktarları ve toz — ölçülmüş, dördü de taşmıyor

`L`, `LiquidityAmounts.getLiquidityForAmounts` ile hesaplanır (**aşağı** yuvarlar); `Pool.modifyLiquidity` gerekli miktarları `SqrtPriceMath.getAmount*Delta(..., roundUp = true)` ile hesaplar (**yukarı**). Yönler zıt olduğu için bacak başına 1 wei'lik bir taşma **teorik olarak** mümkündür. Dört kanonik durumda **ölçüldü: taşma yok.**

| profil | sıralama | `L` | `currency0` tozu | `currency1` tozu |
|---|---|---|---|---|
| üretim | token = `currency0` | `1586199999999999999` | `130353606` wei token | `0` |
| üretim | USDC = `currency0` | `1586200000000000000` | `0` | `267` wei token |
| testnet | token = `currency0` | `50160046734639668` | `6231944955117343703` wei token | `0` |
| testnet | USDC = `currency0` | `50160046734639668` | `0` | `6231944955121217298` wei token |

**Quote bacağında toz sıfırdır, dördünde de** — bağlayıcı bacak her zaman quote'tur, çünkü `R6` taban yuvarlamasıyla `R`'nin altındadır. Token tarafındaki toz `D`'nin `R6/R` kadarlık göreli eksiğidir: üretimde `1,3×10⁻¹⁰` token, testnette `6,23` token (testnette göreli kesir `3,03×10⁻⁸` olduğu için daha büyük). Toz locker'ın ERC-20 bakiyesinde **kalıcı** kalır; spec §5.6 adım 6 bunu zaten kabul eder.

### Hook izin kümesi — `0x20CC`, ve mevcut pin YANLIŞ

`contracts/test/mocks/HookWiringMock.sol` bugün `{beforeInitialize, beforeSwap, beforeSwapReturnDelta}` pinler ve `contracts/test/V4Wiring.t.sol` `assertFalse(permissions.afterSwap)` iddia eder. **Bu küme spec §5.5'i uygulayamaz** ve gerekçe vendored kaynaktan türetilmiştir (§Task 4'te tam olarak). Kısaca: spec "ücret **her zaman pairing asset'te** alınır" der; `beforeSwap` yalnızca *specified* para birimini bilir; dört swap şeklinin ikisinde USDC *unspecified* taraftadır ve miktarı swap'ten önce bilinemez. `Hooks.afterSwap` (vendored, okundu) `beforeSwap`'in unspecified deltasını **`AFTER_SWAP_FLAG` olmadan da** muhasebeleştirir, ama miktarı üretebilecek tek yer `afterSwap`'in kendisidir.

```
BEFORE_INITIALIZE_FLAG          = 1 << 13 = 0x2000
AFTER_SWAP_FLAG                 = 1 << 6  = 0x0040
BEFORE_SWAP_FLAG                = 1 << 7  = 0x0080
BEFORE_SWAP_RETURNS_DELTA_FLAG  = 1 << 3  = 0x0008
AFTER_SWAP_RETURNS_DELTA_FLAG   = 1 << 2  = 0x0004
                                  ---------------
ARCPAD_HOOK_FLAGS               =          0x20CC = 8396
```

Madencilik olasılığı `1/2¹⁴ = 1/16384`; `HookMiner.MAX_LOOP = 160_444`, yani beklenen isabet sayısı ~9,8 ve başarısızlık olasılığı `e^{-9,8} ≈ 5,5×10⁻⁵`. `V4Wiring.t.sol` ve `HookWiringMock.sol` Task 4'te **değişir**, ve değişikliğin gerekçesi rapora yazılır.

### Süreklilik yalnızca `sqrtPriceX96` hakkında bir iddiadır

Curve tarafı `(D, R)`'yi **tam** verir ve bunu ölçmüştür; **fiyat hakkında hiçbir şey kanıtlamaz** (graduation yüzeyi §9 maddesi 3 bunu açıkça söyler). Spec §10 invariant 6 bu fazın iddiasıdır ve üç ayrı biçimde test edilir (Task 2 saf matematik, Task 5 zincirden geri okuma, Task 6 fuzz). **Hiçbiri diğerinin yerine geçemez** ve gerekçe Task 6'da yazılıdır.

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `contracts/src/BondingCurve.sol` | **değişir** — `graduate()`, `bool graduated`, `Graduated` olayı, beş yeni hata (Task 1) |
| `contracts/src/LaunchFactory.sol` | **değişir** — `graduationTarget()`, 3 günlük gecikmeli setter, `feeScheduleOf` anlık görüntüsü, `ProfileNotSeedable()` (Task 1) |
| `contracts/src/libraries/GraduationMath.sol` | **yeni** — sıralama, `QUOTE_SCALE`, `sqrtPriceX96`, tam aralık tick'leri, tohum miktarları |
| `contracts/src/FeeSchedule.sol` | **yeni** — immutable kademe tablosu (`stable_fee_tiers`) |
| `contracts/src/ArcpadHook.sol` | **yeni** — `beforeInitialize` kimlik koruması, `beforeSwap`/`afterSwap` quote ücreti |
| `contracts/src/ArcpadLocker.sol` | **yeni** — graduation hedefi; havuzu açar, tohumlar, pozisyonu yakar |
| `contracts/src/interfaces/IGraduatableCurve.sol` | **yeni** — locker'ın ve hook'un curve'den okuduğu dar yüzey |
| `contracts/src/interfaces/IArcpadFactoryView.sol` | **yeni** — hook'un ve locker'ın factory'den okuduğu iki üye |
| `contracts/src/interfaces/ILaunchTokenView.sol` | **yeni** — hook'un token'dan okuduğu `curve()` + `creator()` |
| `contracts/test/mocks/SwapHarness.sol` | **yeni** — `IUnlockCallback` uygulayan minimal swap sürücüsü (router Faz 2b'de) |
| `contracts/test/ConfigurationOnly.t.sol` | **yeni** — mainnet geçişinin yapılandırma-only olduğunun kanıtı |
| `contracts/test/fork/ArcNetwork.fork.t.sol` | **değişir** — Faz 0'ın gevşek sıfır-adres iddiası |
| `docs/audit/arc-chain-probe.md` | **yeni** — Task 0'ın bulgusu |
| `contracts/test/BondingCurveGraduation.t.sol` | **yeni** — Task 1'in 13 risk kaydı testi |
| `contracts/test/LaunchFactoryGovernance.t.sol` | **yeni** — gecikmeli setter, `feeScheduleOf`, `ProfileNotSeedable` |
| `contracts/test/GraduationMath.t.sol` | **yeni** — dört literal, sıralama, 10¹² sınırı |
| `contracts/test/FeeSchedule.t.sol` | **yeni** — kademe tablosu ve sınır davranışı |
| `contracts/test/ArcpadHook.t.sol` | **yeni** — izin bitleri, `beforeInitialize` reddi, dört swap şekli |
| `contracts/test/ArcpadLocker.t.sol` | **yeni** — uçtan uca graduation, arıza modeli |
| `contracts/test/invariant/GraduationHandler.sol` | **yeni** |
| `contracts/test/invariant/PoolSeedInvariants.t.sol` | **yeni** |
| `contracts/test/mocks/HookWiringMock.sol` | **değişir** — izin kümesi `0x20CC` |
| `contracts/test/V4Wiring.t.sol` | **değişir** — aynı sebep |
| `contracts/test/Surface.t.sol` | **değişir** — dört yeni kontratın ABI yüzeyi eklenir |
| `contracts/script/DeployV4.s.sol` | **yeni** — `PoolManager` (+ gereken periphery) Arc testnet'e |
| `contracts/script/DeployArcpad.s.sol` | **yeni** — `FeeSchedule`, `ArcpadHook` (madenli salt), `ArcpadLocker`, `setGraduationTarget` |
| `contracts/script/ProbeArcChain.s.sol` | **yeni** — Task 0'ın 5042/5042002 sondası |
| `deployments/arc-testnet.json` | **yeni** — adres defteri; testler okur |
| `contracts/test/fork/ArcV4.fork.t.sol` | **yeni** — canlı RPC katmanı |
| `contracts/foundry.toml` | **değişir** — yalnızca `fs_permissions`'a `./deployments` |

---

## Paylaşılan arayüzler — bir kez tanımlanır, üç görev tüketir

Task 1 bunları oluşturur; Task 4 ve Task 5 import eder. **Hepsi `view`**, ve bu taşıyıcıdır: solc STATICCALL üretir, STATICCALL altında her yazma revert eder, dolayısıyla bu okumaların hiçbiri yeniden giremez. `bind`'in ve `graduate()`'in zaten belgelediği disiplin.

```solidity
// contracts/src/interfaces/IArcpadFactoryView.sol
interface IArcpadFactoryView {
    function graduationTarget() external view returns (address);           // 0xa4b20f13
    function feeScheduleOf(address token) external view returns (address);
}

// contracts/src/interfaces/ILaunchTokenView.sol
interface ILaunchTokenView {
    function curve() external view returns (address);
    function creator() external view returns (address);
}

// contracts/src/interfaces/IGraduatableCurve.sol
interface IGraduatableCurve {
    function graduate() external returns (uint256 baseAmount, uint256 quoteAmount);
    function token() external view returns (address);
    function virtualQuoteReserves() external view returns (uint256);
    function virtualTokenReserves() external view returns (uint256);
    function poolSeedSupply() external view returns (uint256);
    function complete() external view returns (bool);
    function graduated() external view returns (bool);
}
```

> **`BondingCurve` bunların hiçbirini import ETMEZ ve bu bilinçlidir.** Curve kendi yerel `ILaunchFactoryGraduation`'ını taşımaya devam eder (yalnızca `graduationTarget()`), çünkü curve'ün derleme birimini factory'ninkine bağlamak CREATE2 döngüsünü doğuran bağımlılık yönüdür. `IArcpadFactoryView` **yalnızca** hook ve locker içindir. İki bildirimin `graduationTarget()` için **aynı selector'ü** (`0xa4b20f13`) ürettiği Task 6'nın yüzey testinde pinlenir.
>
> **`ICurveBoundToken` (mevcut, `BondingCurve.sol` içinde yerel) `creator()` TAŞIMAZ** — yalnızca `curve()`. Hook'un creator'a da ihtiyacı olduğu için `ILaunchTokenView` ayrı bir dosyadır; `ICurveBoundToken`'ı genişletmek curve'ün bytecode'unu değiştirirdi ve **donmuş yüzeye dokunmak yasaktır.**

**Task 4 ve Task 5'in gövdelerinde `ILaunchFactoryGraduation(...)`, `ILaunchFactoryFeeSchedule(...)` ve `ICurveBoundToken(...)` yazan her yer `IArcpadFactoryView(...)` / `ILaunchTokenView(...)` olarak okunur.** İki isim de aynı iki üyeye işaret eder; tek bildirim yukarıdakidir.

---

## Swap sürücüsü — `ArcpadRouter` olmadan havuzda swap

`ArcpadRouter` Faz 2b'dedir, ama Task 4'ün dört swap şekli testi ve Task 8'in kademe-0 testi bir swap yapmak zorundadır. **Test-only bir sürücü kullanılır** ve `src/`'ye girmez:

```solidity
// contracts/test/mocks/SwapHarness.sol
contract SwapHarness is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;
    constructor(IPoolManager pm) { poolManager = pm; }

    function swap(PoolKey memory key, SwapParams memory params) external returns (BalanceDelta) {
        return abi.decode(poolManager.unlock(abi.encode(key, params)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "not manager");
        (PoolKey memory key, SwapParams memory params) = abi.decode(data, (PoolKey, SwapParams));
        BalanceDelta delta = poolManager.swap(key, params, "");
        // Borclu bacagi ode, alacakli bacagi al. IKI BACAK DA ERC-20.
        if (delta.amount0() < 0) key.currency0.settle(poolManager, address(this), uint256(int256(-delta.amount0())), false);
        if (delta.amount1() < 0) key.currency1.settle(poolManager, address(this), uint256(int256(-delta.amount1())), false);
        if (delta.amount0() > 0) key.currency0.take(poolManager, address(this), uint256(int256(delta.amount0())), false);
        if (delta.amount1() > 0) key.currency1.take(poolManager, address(this), uint256(int256(delta.amount1())), false);
        return abi.encode(delta);
    }
}
```

Dört şekil, tam olarak şu argümanlarla sürülür (`sqrtPriceLimitX96` sınırları `TickMath`'in kendi sabitlerinden alınır, **±1 ile** çünkü `Pool.swap` katı eşitsizlik ister):

| şekil | `zeroForOne` | `amountSpecified` | `sqrtPriceLimitX96` |
|---|---|---|---|
| exact-input, `currency0`→`currency1` | `true` | `-1_000_000` | `TickMath.MIN_SQRT_PRICE + 1` |
| exact-output, `currency0`→`currency1` | `true` | `+1_000_000` | `TickMath.MIN_SQRT_PRICE + 1` |
| exact-input, `currency1`→`currency0` | `false` | `-1_000_000` | `TickMath.MAX_SQRT_PRICE - 1` |
| exact-output, `currency1`→`currency0` | `false` | `+1_000_000` | `TickMath.MAX_SQRT_PRICE - 1` |

`1_000_000` seçimi: quote bacağında 1 USDC (6 decimal), yani `feeOn(1_000_000, 95) = 9_500` ve `feeOn(1_000_000, 30) = 3_000` — **iki parça da sıfır olmayan ve tam bölünen** değerler, dolayısıyla ücret iddiaları tavan yuvarlamasına bağlı kalmaz ve testler kırılgan olmaz.

---

### Task 0: Hedef zinciri ölç — `5042` mi `5042002` mi

İki paralel araştırma çelişiyor ve **ikisi de kapanmadı**: bir hazırlık denetimi Uniswap Labs'in v2+v3+v4'ü **26–27 Mayıs 2026'da chain `5042`'ye** deploy ettiğini bildiriyor; ayrı bir araştırma Arc'ın **tüm** dokümantasyon külliyatında (1.263.917 bayt `llms-full.txt`) **yalnızca `5042002`**'nin geçtiğini, 42 kez, başka hiçbir chain id bulunmadığını ölçüyor ve üçüncü taraf `5042` iddiasını doğrulanamaz sayıyor.

**Bu görev çelişkiyi çözmez diye tasarlanmıştır — Faz 2'nin cevaba bağımlı OLMADIĞINI kanıtlar.** Çıktı iki parçadır: (a) yeniden çalıştırılabilir bir sonda ve onun bulgusu; (b) kod tabanında hiçbir chain id'ye bağlı dal olmadığının kanıtı.

**Files:**
- Create: `contracts/script/ProbeArcChain.s.sol`
- Create: `docs/audit/arc-chain-probe.md` (sondanın çıktısı, tarihli)

**Interfaces:** Üretmez, tüketmez. Hiçbir `src/` dosyası bu görevde değişmez.

- [ ] **Adım 1: Sondayı yaz**

`vm.rpc` kullanılır, `vm.createSelectFork` **değil**: fork yerel revm'de koşar ve uzak istemcinin kendi cevabını gizler (Faz 0'ın kayda geçirdiği ders). Aday host listesi tam olarak şudur ve genişletilmez:

```solidity
string[7] hosts = [
    "https://rpc.testnet.arc.io",        // dokumante, 5042002 bekleniyor
    "https://rpc.testnet.arc.network",   // eski alan adi, dokumante DEGIL
    "https://rpc.mainnet.arc.io",        // olculdu: Cloudflare 403 HTML
    "https://rpc.arc.io",
    "https://rpc.mainnet.arc.network",
    "https://arc.rpc.circle.com",
    "https://rpc.arc.network"
];
```

Her host için sırayla: `eth_chainId`, `eth_blockNumber`, `web3_clientVersion`. Cevap veren **her** host için ayrıca `eth_getCode` şu altı adreste:

```
0x000000000004444c5dc75cB358380D2e3dE08A90   V4 PoolManager (Ethereum mainnet)
0x360e68faccca8ca495c1b759fd9eee466db9fb32   V4 PoolManager (Arbitrum/X Layer/Ink/Soneium)
0x1f98400000000000000000000000000000000004   V4 PoolManager (Unichain)
0x498581fF718922c3f8e6a244956aF099B2652b2b   V4 PoolManager (Base)
0x3600000000000000000000000000000000000000   ERC-20 USDC  -- POZITIF KONTROL
0x4e59b44847b379578588920cA78FbF26c0B4956C   CREATE2 deployer -- POZITIF KONTROL
```

**İki pozitif kontrol zorunludur ve testin tamamının anlamı onlara bağlıdır.** Faz 0'ın fork testi tam bu hatayı yaptı: `try/catch` ile sarılmış bir `vm.rpc`, bir 429'u da "beklenen revert" olarak okuyordu. Pozitif kontrol kod döndürmüyorsa sonda **çalışmıyordur** ve `0x` sonuçları hiçbir şey ifade etmez — bu durumda görev "V4 yok" değil, **"sonda geçersiz"** raporlar.

- [ ] **Adım 2: Çalıştır ve bulguyu yaz**

```bash
forge script ProbeArcChain --root contracts -vvv
```

`docs/audit/arc-chain-probe.md`'ye tarih, her host için ham cevap, ve **üç sonuçtan tam olarak biri** yazılır:

| Sonuç | Koşul | Faz 2'ye etkisi |
|---|---|---|
| **A** | Hiçbir host `5042` döndürmüyor | `5042` doğrulanamadı. Faz 2 kendi `PoolManager`'ını deploy eder. **Hiçbir kod değişikliği yok.** |
| **B** | Bir host `5042` döndürüyor **ve** dört adresten biri kod taşıyor | Kanonik bir V4 var. Task 7'nin adres defterine ikinci bir ağ girdisi eklenir. **Hiçbir kontrat değişikliği yok.** |
| **C** | Bir host `5042` döndürüyor ama dört adresin hiçbiri kod taşımıyor | Chain var, V4 yok — hazırlık denetiminin iddiası adres düzeyinde yanlış. Faz 2 kendi `PoolManager`'ını deploy eder. |

**Üç sonucun da `src/` üzerinde etkisi yoktur.** Bu, görevin asıl teslimatıdır.

- [ ] **Adım 3: Chain id'ye bağlı dal olmadığını kanıtla**

```bash
grep -rn "5042" contracts/src/ packages/ indexer/src/ keeper/src/
```

Beklenen: `contracts/src/` içinde **sıfır** isabet. `packages/shared/src/chain.ts`'te isabet varsa (hazırlık denetimi `5042002`'nin oraya gömülü olduğunu ve guard'ın mainnet'i reddettiğini kaydetti), bu bir bulgu olarak raporlanır ve **Faz 3'e devredilir** — bu fazda düzeltilmez, çünkü frontend'in ağ seçimi bu fazın hiçbir kararına bağlı değildir.

- [ ] **Adım 4: Commit**

```bash
git add contracts/script/ProbeArcChain.s.sol docs/audit/arc-chain-probe.md
git commit -m "chore(contracts): probe Arc for chain 5042 and prove phase 2 does not depend on the answer"
```

---

### Task 1: Curve tarafı graduation yüzeyi ve factory yönetişimi

Graduation yüzeyi tasarımı **düşman incelemesinden geçti ve donduruldu**; bu görev onu birebir uygular. Tasarımın tamamı `.superpowers/sdd/graduation-surface-design.md`'dedir ve **çelişki hâlinde o doküman kazanır**. Buradaki iş üç parçadır: curve'ün `graduate()`'i, factory'nin hedef yönetişimi, ve Faz 2'nin factory'ye getirdiği **tek yeni profil kontrolü**.

**Ölçüldü ve bu görevin ön koşulu:** `graduate()` bugün `contracts/src/BondingCurve.sol`'de **yoktur** (`grep -n "graduate" src/BondingCurve.sol` → sıfır isabet, HEAD `03a3139`). `LaunchFactory`'de `graduationTarget` de yoktur. Yüzey "dondurulmuş" olması tasarımın kapandığı anlamına gelir, kodun indiği anlamına gelmez.

**Files:**
- Modify: `contracts/src/BondingCurve.sol`
- Modify: `contracts/src/LaunchFactory.sol`
- Modify: `contracts/test/LaunchFactory.t.sol` (constructor arity değişiyor)
- Modify: `contracts/test/invariant/BondingCurveInvariants.t.sol` (R-3, aşağıda)
- Modify: `contracts/test/invariant/CurveTradingHandler.sol` (R-3)
- Modify: `contracts/test/Surface.t.sol` (yeni üyeler)
- Create: `contracts/src/interfaces/IArcpadFactoryView.sol`
- Create: `contracts/src/interfaces/ILaunchTokenView.sol`
- Create: `contracts/src/interfaces/IGraduatableCurve.sol`
- Create: `contracts/test/BondingCurveGraduation.t.sol`
- Create: `contracts/test/LaunchFactoryGovernance.t.sol`

> **Üç arayüz burada oluşturulur** (gövdeleri "Paylaşılan arayüzler" bölümünde), Task 5'te değil — Task 1 zaten `LaunchFactory`'ye `graduationTarget()` ve `feeScheduleOf`'u eklediği için, onları okuyan arayüz aynı görevde donmalıdır. Task 5'in Files listesi bu yüzden `IGraduatableCurve.sol`'ü **oluşturmaz**, tüketir.

**Interfaces:**
- Tüketir: `CurveMath` (değişmez).
- Üretir, `BondingCurve` üzerinde:
  - `function graduate() external returns (uint256 baseAmount, uint256 quoteAmount)` — selector `0xd3618cca`
  - `bool public graduated` — selector `0xe7c2b772`
  - `event Graduated(address indexed token, address indexed to, uint256 baseAmount, uint256 quoteAmount)` — topic0 `0x18a56450d3c666e2bae9e0829fcada82a9ab0deef6e33c2496752c88d4155c9d`
  - `error NotComplete()` `0x0701727f`, `AlreadyGraduated()` `0xe6a0d45f`, `GraduationTargetUnset()` `0xfe30fa5b`, `NotGraduationTarget()` `0x7277e657`, `GraduationPayoutFailed()` `0x1ee5f101`
- Üretir, `LaunchFactory` üzerinde:
  - `function graduationTarget() external view returns (address)` — selector `0xa4b20f13`. **`view` ve bu selector, curve'ün bytecode'una gömülüdür; ikisi de dondurulmuştur.**
  - `address public immutable governor`
  - `address public immutable feeSchedule`
  - `mapping(address token => address) public feeScheduleOf`
  - `address public pendingGraduationTarget`, `uint256 public graduationTargetEta`
  - `function proposeGraduationTarget(address target) external`
  - `function applyGraduationTarget() external`
  - `uint256 public constant GRADUATION_TARGET_DELAY = 3 days`
  - `event GraduationTargetProposed(address indexed target, uint256 eta)`, `event GraduationTargetApplied(address indexed previous, address indexed target)`, `event FeeScheduleAssigned(address indexed token, address indexed schedule)`
  - `error NotGovernor()`, `ZeroGovernor()`, `ZeroFeeSchedule()`, `FeeScheduleHasNoCode()`, `NoPendingTarget()`, `TargetChangeNotReady()`, `ProfileNotSeedable()`

#### Neden hedef yeniden yönlendirilebilir olmak ZORUNDA

Karar "önerilen"den "zorunlu"ya yükseltildi ve gerekçe bu fazın kendi durumundan gelir: **Arc'ta hiçbir yerde Uniswap V4 yok, dolayısıyla ilk hedef bizim yazdığımız bir kontrattır ve geliştirme boyunca birden fazla kez değişecektir.** `graduate()`'i yalnızca hedef çağırabildiği için, bozuk bir hedeften **tek çıkış** yeniden yönlendirmedir. Tek seferlik bir latch, bir kötü seçimi *o factory'nin ürettiği ve henüz mezun olmamış her curve'ün sonsuza kadar kilitlenmesi*ne çevirir.

**Önceki bir hedefe bakarken tamamlanan bir curve'e ne olur?** Hiçbir şey — ve bunun sebebi tasarımın D2 kararıdır. Curve hedefi `graduate()` **çağrıldığı anda** okur, tamamlandığı anda değil. Yani:

- `complete = true`, `graduated = false` olan bir curve **hedefsizdir**; hangi hedef güncelse ona mezun olur.
- Hedef değiştiğinde bekleyen curve'ler otomatik olarak **yeni** hedefe geçer. Göç yoktur, migrasyon yoktur, kayıt yoktur.
- `graduated = true` olan bir curve terminaldir ve hedef değişikliği onu **etkilemez** — havuzu eski locker açmıştır, hook `beforeInitialize`'ı bir kez çalıştırmıştır ve o havuz çalışmaya devam eder (Task 4'te `beforeSwap`'in hedefe **bakmaması** bu yüzden bağlayıcıdır).
- 3 günlük gecikme bu yüzden bir güvenlik kilidi değil, **bir tahliye penceresidir**: değişiklik yürürlüğe girmeden önce herkes bekleyen graduation'ları mevcut hedefle bitirebilir.

`feeSchedule`'ın **gecikmesi yoktur ve bu tutarsızlık değil**: hedef, *zaten var olan* curve'leri etkiler; schedule etkilemez, çünkü her launch kendi schedule'ını `feeScheduleOf`'a **anında** dondurur. Gecikme tam olarak "geriye dönük etki" olan tek knob'da vardır.

- [ ] **Adım 1: Başarısız testleri yaz**

`contracts/test/BondingCurveGraduation.t.sol` — graduation yüzeyi tasarımının §8 risk kaydındaki **on üç** satırın her biri için en az bir test. Her testin adı, kırıldığında hangi mutantın hayatta kaldığını söylemeli:

```solidity
// R-1  depolama duzeni
test_graduatedPacksIntoTheSameSlotAsComplete()
// R-2  idempotent DEGIL
test_secondGraduateRevertsAlreadyGraduated()
test_reentrantGraduateFromReceiveRevertsAndAssetsMoveExactlyOnce()
// R-4  cagiran korumasi
test_nonTargetCallerRevertsNotGraduationTarget()
test_aSecondDeployedContractIsAlsoRejected()      // tx.origin / code.length mutantini oldurur
// R-5  STATICCALL kapanisi
test_aFactoryThatWritesInGraduationTargetReverts()
test_theSameFunctionCalledNonStaticallyDoesWrite() // KONTROL -- bkz. asagi
// R-6  tamamlanma korumasi
test_graduateBeforeCompletionRevertsNotComplete()
// R-7  bagis gecirmezligi
test_donationsDoNotChangeTheAmountsPaidOut()
// R-8  siralama
test_ledgerIsWrittenBeforeBothPayouts()
// R-9  odeme basarisizligi ve YENIDEN DENEME
test_aRevertingTargetLeavesTheCurveIntactAndRetrySucceeds()
// R-11 factory bagi
test_theDeployedPairWorksEndToEnd()
// R-13 tamamlanma zinciri, GIRIS NOKTASI BASINA
test_afterGraduationEachEntrypointRevertsWithCurveCompleteSelector()
```

**`test_theSameFunctionCalledNonStaticallyDoesWrite` kontrolü atlanamaz.** Onsuz, R-5 testi *herhangi bir sebeple* revert eden bir kontrata karşı da geçer ve STATICCALL'ı hiç ölçmemiş olur. Kontrol, aynı fonksiyonun statik olmayan çağrıda yazma sayacını `0` → `1` yaptığını iddia eder.

R-1'in testi artifact ayrıştırmadan yazılır ve doğrudan paketlenmeyi **ölçer**:

```solidity
/// `graduated` `complete`'ten HEMEN SONRA bildirilmek zorundadir. Bugunku
/// duzen: slot 0 `token`, 1..4 rezervler, 5 `complete`. `graduated` ayni
/// slot'a, offset 1'e paketlenir -- yani graduation, uzerinde `complete =
/// true` YAZAN bir slot'a tek bir SSTORE yapar ve kontrat yeni slot
/// KAZANMAZ. Ayri bir slot'a dusmesi deploy sonrasi DUZELTILEMEZ.
function test_graduatedPacksIntoTheSameSlotAsComplete() public {
    _completeTheCurve();
    assertEq(vm.load(address(curve), bytes32(uint256(5))), bytes32(uint256(0x01)));
    vm.prank(address(locker));
    curve.graduate();
    assertEq(vm.load(address(curve), bytes32(uint256(5))), bytes32(uint256(0x0101)));
}
```

`contracts/test/LaunchFactoryGovernance.t.sol`:

```solidity
test_graduationTargetIsZeroBeforeAnyProposal()
test_onlyGovernorCanPropose()                      // NotGovernor
test_applyBeforeEtaRevertsTargetChangeNotReady()
test_applyWithNoProposalRevertsNoPendingTarget()
test_applyExactlyAtEtaSucceeds()                   // >= degil > mutantini oldurur
test_aCurveThatCompletedUnderTheOldTargetGraduatesToTheNewOne()
test_aGraduatedCurveIsUnaffectedByARepoint()
test_feeScheduleOfIsWrittenForEveryLaunchAndZeroForAForgedToken()
test_profileThatCannotBeSeededIsRejectedAtDeploy()  // ProfileNotSeedable
```

`test_applyExactlyAtEtaSucceeds` **`vm.warp(eta)`** kullanır, `eta + 1` değil. `>=`'i `>` yapan mutant yalnızca tam sınırda görünür; `eta + 1` ile yazılmış bir test onu hayatta bırakır.

`test_profileThatCannotBeSeededIsRejectedAtDeploy`'un tanığı elle türetilmiştir ve **256-bit uçurumundan** gelir:

```solidity
/// Tanik: V, ucurumun BIR WEI ALTINDA. Ucurum
///   V <= (T-S)*1e12 >> 64 * (T-S) / T  ->  3_958_096_264_828_801_689
/// Bu V ile `USDC = currency0` dalinda oran(X192) 2^256'yi asar ve
/// `FullMath.mulDiv` revert eder -- yani GRADUATION aninda, her denemede.
/// Kontrol deploy aninda oldugu icin o profil hic launch edemez.
/// NOT: bu V ayni zamanda MIN_OPENING_MARKET_CAP'i de ihlal eder
/// (4e18 tabani V >= 4_292_000_000_000_000_000 ister), dolayisiyla SIRA
/// baglayicidir: `ProfileNotSeedable` kontrolu piyasa degeri kontrolunden
/// SONRA gelir ve bu tanik `DegenerateProfile()` alir. Ucurumun KENDI
/// tanigini gormek icin ikinci bir test, T'yi buyuterek piyasa degeri
/// tabanini saglayan ama ucurumun altinda kalan bir ucluyu kullanir.
```

**Bu iki testin ikisi de gereklidir ve gerekçe deponun `GraduationRaiseTooSmall` dersinin aynısıdır:** tek bir tanık iki korumayı birden ihlal ediyorsa, hangisinin reddettiği ölçülemez ve tabanı bir wei kaydıran mutant hayatta kalır.

- [ ] **Adım 2: Testleri çalıştır, doğru sebeple kırıldığını doğrula**

```bash
forge test --root contracts --match-path 'test/BondingCurveGraduation.t.sol'
```

Beklenen: **derleme hatası** (`graduate` yok). Raporda "derleme hatası" yaz, "test başarısız" **deme**.

- [ ] **Adım 3: `BondingCurve.graduate()`'i yaz**

Yerel arayüz. `view` **taşıyıcıdır** — solc'un STATICCALL üretmesini sağlayan şey odur, ve `bind`'in zaten belgelediği disiplinin aynısıdır:

```solidity
/// @notice Curve'un graduation aninda factory'den okudugu TEK uye.
/// @dev YEREL arayuz: `LaunchFactory`'yi import etmek curve'un derleme
///      birimini factory'ninkine bagimli kilardi -- CREATE2 dongusunu
///      doguran bagimlilik yonu tam olarak budur. `view` ise reentrancy'yi
///      KAPATAN sey: solc STATICCALL uretir ve STATICCALL altinda her yazma
///      revert eder. `bind`'in NatSpec'i ayni gerekceyi tasir.
interface ILaunchFactoryGraduation {
    function graduationTarget() external view returns (address);
}
```

Gövde. **Sıra bağlayıcıdır** ve tasarım dokümanının §1.2'siyle birebir aynıdır:

```solidity
function graduate() external returns (uint256 baseAmount, uint256 quoteAmount) {
    // --- 1. DOGRULA ---
    if (!complete) revert NotComplete();
    if (graduated) revert AlreadyGraduated();

    address target = ILaunchFactoryGraduation(factory).graduationTarget(); // STATICCALL
    // SIRA: `GraduationTargetUnset` cagiran kontrolunden ONCE. Ikinci
    // sirada olsaydi yalnizca `msg.sender == address(0)` iken ulasilabilir
    // olurdu; birinci sirada, Faz 2 var olmadigi surece HER cagiranin
    // gordugu hata olur -- yani bu kontratin uretecegi en olasi revert.
    if (target == address(0)) revert GraduationTargetUnset();
    if (msg.sender != target) revert NotGraduationTarget();

    // DEFTERDEN, ASLA BAKIYEDEN. Arc'ta ucuncu bir taraf curve'un IKI
    // bakiyesini de kontrat icinde hicbir kod calistirmadan sisirebilir.
    baseAmount = poolSeedSupply;     // immutable
    quoteAmount = realQuoteReserves; // defter

    // --- 2. DEFTERI YAZ (her dis cagridan ONCE) ---
    graduated = true;

    // --- 3. OLAY ---
    emit Graduated(token, target, baseAmount, quoteAmount);

    // --- 4. DIS CAGRILAR ---
    if (!IERC20(token).transfer(target, baseAmount)) revert TokenTransferFailed();
    (bool ok,) = target.call{value: quoteAmount}("");
    if (!ok) revert GraduationPayoutFailed();
}
```

`bool public graduated`, `complete`'in **hemen ardından** bildirilir. `graduate()` `payable` **değildir** ve `nonReentrant` **almaz** (kontratın merkezi belgelenmiş özelliği katı CEI'nin guard'ı gereksiz kılmasıdır; buradaki ilk guard, sıranın güvenilmediğini ima ederdi).

Üç ticaret giriş noktasına **hiçbir `graduated` kontrolü eklenmez.** Zincir: `graduated ⟹ complete` (guard 1) `⟹ her ticaret revert eder` (mevcut). Eklenen bir kontrol **öldürülemez bir mutant** olurdu. Ama zincir bir ön koşuldur ve ön koşullar bu depoda pinlenir — R-13'ün testi bunu **giriş noktası başına ve selector üzerinde** yapar, çünkü mevcut invariant dosyası `complete` guard'ını alım yollarından silmenin davranışı değiştirmediğini (çağrı `NotEnoughTokensToBuy`'a düştüğü için) kayda geçirmiştir.

- [ ] **Adım 4: `LaunchFactory`'yi yaz**

Constructor argümanları **sona eklenir**, araya sokulmaz. Gerekçe: mevcut çağrı yerlerinin anlamı korunur. Bu depo argüman sırasından bir kez yandı (`T` önce, `V` sonra) ve `BondingCurve`'ün constructor'ı o sırayı taşıyor.

```solidity
constructor(
    address escrow_,
    address protocolTreasury_,
    uint256 virtualTokenReserves_,
    uint256 virtualQuoteReserves_,
    uint256 saleSupply_,
    address feeSchedule_,      // YENI
    address governor_          // YENI
) {
    // ... mevcut dokuz kontrol aynen kalir, SIRASI DEGISMEZ ...

    if (feeSchedule_ == address(0)) revert ZeroFeeSchedule();
    if (feeSchedule_.code.length == 0) revert FeeScheduleHasNoCode();
    if (governor_ == address(0)) revert ZeroGovernor();

    // FAZ 2'NIN GETIRDIGI TEK YENI PROFIL KONTROLU. Sihirli sayi YOK:
    // profilin HER IKI para birimi siralamasinda temsil edilebilir bir
    // havuz acilis fiyati urettigini, fiili fonksiyonu cagirarak dogrular.
    // Vq_final ve Vt_final yalnizca profile baglidir (token adresine
    // bagli DEGIL), dolayisiyla bu deploy aninda TAM olarak hesaplanabilir.
    GraduationMath.validateProfileIsSeedable(
        virtualQuoteReserves_
            + CurveMath.graduationRaise(saleSupply_, virtualQuoteReserves_, virtualTokenReserves_),
        virtualTokenReserves_ - saleSupply_
    );

    feeSchedule = feeSchedule_;
    governor = governor_;
    // ... mevcut atamalar ...
}
```

> **Kontrolün `R_formula` kullanması bilinçlidir ve daha katıdır.** Fiili `Vq_final` her zaman `V + R_formula`'nın **üstündedir** (`+1`'ler yüzünden), ve taşma `Vq_final` **küçük** olduğunda olur. Alt sınırla kontrol etmek, gerçek yolun kesinlikle güvenli olduğunu verir.

`launch()`'a **tek satır** eklenir, ve yeri bağlayıcıdır — `Launched` olayından **önce**, `bind`'den önce, yani mevcut CEI disiplinine uyar:

```solidity
    feeScheduleOf[token] = feeSchedule;
    emit FeeScheduleAssigned(token, feeSchedule);
```

`feeScheduleOf` **iki iş** yapar ve ikinci iş varlık sebebidir:

1. Schedule'ı launch anında dondurur (spec §5.5: "kademe tablosu launch anında dondurulur").
2. **Hook'a sabit gazlı, sahteciliğe kapalı bir kanoniklik kanıtı verir.** `feeScheduleOf[token] != address(0)` ⟺ bu factory o token'ı üretti. Hook'un alternatifi `isCanonical` çağırmaktı — ve `LaunchFactory`'nin kendi NatSpec'i o yolun **sınırsız gazlı bir griefing yüzeyi** olduğunu ölçerek kaydetmiştir (3.000.000 gaz bütçesiyle doğrudan çağrıda 2.958.151 tüketim). Bir mapping okuması o sınıfın tamamını hook'un dışında bırakır.

Yönetişim. **Sahip yoktur, `governor` vardır ve tek yetkisi hedefi önermektir:**

```solidity
uint256 public constant GRADUATION_TARGET_DELAY = 3 days;

function proposeGraduationTarget(address target) external {
    if (msg.sender != governor) revert NotGovernor();
    // SIFIR HEDEF ONERILEBILIR ve bu bilinclidir: bozuk bir hedefi
    // geri cekmenin yolu, `address(0)`'a yonlendirip her graduation'i
    // `GraduationTargetUnset()` ile durdurmaktir. Bir "iptal" fonksiyonu
    // ayni seyi yapan ikinci bir uye olurdu.
    pendingGraduationTarget = target;
    graduationTargetEta = block.timestamp + GRADUATION_TARGET_DELAY;
    emit GraduationTargetProposed(target, graduationTargetEta);
}

function applyGraduationTarget() external {
    // IZINSIZ: gecikme dolduktan sonra uygulamayi HERKES tetikleyebilir.
    // Gerekce `collect_creator_fee_v2`'nin izinsizligiyle ayni: governor'un
    // gazi yoksa bile kararlastirilmis degisiklik kilitlenmemeli.
    uint256 eta = graduationTargetEta;
    if (eta == 0) revert NoPendingTarget();
    if (block.timestamp < eta) revert TargetChangeNotReady();
    address previous = graduationTarget;
    graduationTarget = pendingGraduationTarget;
    delete pendingGraduationTarget;
    delete graduationTargetEta;
    emit GraduationTargetApplied(previous, graduationTarget);
}
```

**`block.timestamp` burada kullanılır ve Arc'ta güvenlidir** — ama gerekçesi yazılmalıdır: Arc'ın zaman damgaları **azalmayan**, kesin artan değildir ve alt saniyelik bloklar aynı damgayı paylaşabilir. 3 günlük bir pencerede bu ayrım ölçülemez. Sıralamaya bağlı hiçbir mantık yoktur; yalnızca bir eşik vardır. (Keeper'ın `block.number` ile sıralaması ayrı bir kısıttır ve bu üyeyi etkilemez.)

- [ ] **Adım 5: Mevcut invariant paketini FAZ AYRIMINA çevir (R-3)**

**Bu adım bu görevin en yüksek olasılıklı hatasıdır** ve tehlike testlerin kırılması değil, **kırılmamasıdır**. `graduate()` çağrılır çağrılmaz iki mevcut invariant yanlış olur:

| Invariant | `!graduated` | `graduated` |
|---|---|---|
| `invariant_curveHoldsAtLeastWhatItOwesTraders` | `balance == realQuoteReserves` | `balance == 0` |
| `invariant_realTokenReservesEqualTokenBalanceMinusSold` | `balanceOf(curve) − realTokenReserves == N − S` | `== N − S − D` |

`graduate()`'i **hiç çağırmayan** bir handler ikisini de yeşil bırakır ve yeni giriş noktası **sıfır invariant kapsaması** alırken paket tam kapsama bildirir. Deponun ikinci arıza kipi budur: *boşluk mutant seçimindedir, kapsamada değil.* Bu yüzden:

- `CurveTradingHandler`'a bir `graduate()` eylemi eklenir.
- `graduatedWasUnset` ghost sayacı eklenir ve `== 0` iddia edilir (`completeWasUnset`'in aynası).
- **`graduate()`'e ulaşamayan bir handler geçen bir paket değil, BAŞARISIZ bir pakettir.** Handler'ın `graduate()`'i en az bir kez başarıyla çalıştırdığını kanıtlayan bir `graduationsPerformed > 0` iddiası eklenir. Onsuz, kısıtlı aktör kümesi yüzünden hiç ulaşılmayan bir eylem sessizce ölü kalır.

Handler'ın içinde **assertion çağrılmaz** (forge-std assertion'ları revert eder ve `fail_on_revert = false` bunları yutar) — ghost sayaç artırılır, `invariant_` içinde iddia edilir.

- [ ] **Adım 6: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --no-match-path 'test/fork/*'
FOUNDRY_PROFILE=ci forge test --root contracts --no-match-path 'test/fork/*'
```

- [ ] **Adım 7: Mutasyonla doğrula**

Scratchpad kopyasında (depoya **dokunma**). Her mutasyon için hangi testin kırıldığını raporla; kırılmıyorsa **boşluktur ve bildirilir**:

| Mutasyon | Ölmesi gereken test |
|---|---|
| `if (graduated) revert` kaldır | `test_secondGraduateRevertsAlreadyGraduated` **ve** reentrancy testi |
| `graduated = true`'yu dış çağrılardan **sonra**ya taşı | reentrancy testi — miktarları iddia eden hâli, yalnızca revert'i değil |
| `msg.sender != target` → `tx.origin != target` | `test_aSecondDeployedContractIsAlsoRejected` |
| `ILaunchFactoryGraduation`'dan `view`'i kaldır | R-5 testi **ve** kontrolü |
| `poolSeedSupply` → `IERC20(token).balanceOf(address(this))` | `test_donationsDoNotChangeTheAmountsPaidOut` |
| `realQuoteReserves` → `address(this).balance` | aynı test |
| `if (!ok) revert` → çıplak `call` | `test_aRevertingTargetLeavesTheCurveIntactAndRetrySucceeds` |
| `applyGraduationTarget`'ta `<` → `<=` | `test_applyExactlyAtEtaSucceeds` |
| `validateProfileIsSeedable` çağrısını kaldır | `test_profileThatCannotBeSeededIsRejectedAtDeploy` (ikinci tanık) |

- [ ] **Adım 8: Commit**

```bash
git commit -m "feat(contracts): graduation payout on the curve and a re-pointable target on the factory"
```

---

### Task 2: `GraduationMath` — sıralama, 10¹² sınırı ve `sqrtPriceX96`

**Fazın en önemli görevi, ve hiçbir altyapı gerektirmeden test edilebilir olanı.** Üç sessiz hatanın üçü de burada yaşar ve burada kapanır: `address(0)`'ın anahtara sızması, sıralamanın varsayılması, ve 10¹² dönüşümünün kaybolması. Saf `internal pure` kütüphane — depolama yok, dış çağrı yok, `PoolManager` yok.

**Files:**
- Create: `contracts/src/libraries/GraduationMath.sol`
- Create: `contracts/test/GraduationMath.t.sol`

**Interfaces:**
- Tüketir: `@uniswap/v4-core/src/types/PoolKey.sol`, `types/Currency.sol`, `libraries/TickMath.sol`, `libraries/FullMath.sol`, `interfaces/IHooks.sol`, `@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol`, `@openzeppelin/contracts/utils/math/Math.sol`.
- Üretir: `library GraduationMath` — sabitler `QUOTE`, `QUOTE_SCALE`, `POOL_FEE`, `TICK_SPACING`, `TICK_LOWER`, `TICK_UPPER`, `SQRT_LOWER`, `SQRT_UPPER`, `Q192`; fonksiyonlar `poolKey`, `sqrtPriceX96`, `isSeedable`, `quoteUnits`, **`quoteWei`**, `seedLiquidity`; hatalar `ZeroBase()`, `BaseIsQuote()`, `ZeroReserves()`, `PriceOutOfRange()`.
- **`quoteWei` Task 4 içindir** (hook ücreti 6-decimal birimden native wei'ye çevirip `FeeEscrow.deposit{value:}`e verir) ve `quoteUnits`'in tersidir. Burada tanımlanır çünkü `QUOTE_SCALE`'in **tek** bulunduğu yer bu dosyadır.

- [ ] **Adım 1: Başarısız testleri yaz**

> **Beklenen değerler ELLE türetilmiştir ve kütüphaneyi çağırarak üretilmemelidir.** `FullMath`/`Math.sqrt` ile beklenen değeri hesaplayan bir test, kütüphaneyi kendisiyle karşılaştırır — bu projenin defalarca yakaladığı totoloji sınıfının ta kendisi. Aşağıdaki literaller olduğu gibi kullanılır. Türetmeleri Global Kısıtlar'daki tabloda ve her testin yorumunda yazılıdır.

```solidity
// ---------- sabitlerin kendisi ----------

/// SQRT_LOWER/SQRT_UPPER sabit yazilir (sabit gaz), ama SABITIN DOGRU
/// OLDUGU burada KANITLANIR. Sabiti elle degistiren bir mutasyon bu testte
/// olur; TickMath'i cagirmadan yazilmis bir sabit, cagirmayan bir testle
/// birlikte hicbir sey ifade etmezdi.
function test_fullRangeSqrtConstantsMatchTickMath() public pure {
    assertEq(GraduationMath.TICK_LOWER, TickMath.minUsableTick(60));
    assertEq(GraduationMath.TICK_UPPER, TickMath.maxUsableTick(60));
    assertEq(GraduationMath.TICK_LOWER, -887220);
    assertEq(GraduationMath.TICK_UPPER, 887220);
    assertEq(GraduationMath.SQRT_LOWER, TickMath.getSqrtPriceAtTick(-887220));
    assertEq(GraduationMath.SQRT_UPPER, TickMath.getSqrtPriceAtTick(887220));
    assertEq(GraduationMath.SQRT_LOWER, 4306310044);
    assertEq(GraduationMath.SQRT_UPPER, 1457652066949847389969617340386294118487833376468);
}

/// tickSpacing = 60 secimini tasiyan gerekce: sinirlar V4'un dogruladigi
/// araligin KESINLIKLE icinde kalir. tickSpacing = 1 ile ust sinir tam
/// olarak MAX_SQRT_PRICE olurdu -- `getTickAtSqrtPrice`in KENDISININ
/// reddettigi deger.
function test_tickSpacingKeepsBothBoundsStrictlyInsideV4sValidatedRange() public pure {
    assertGt(GraduationMath.SQRT_LOWER, TickMath.MIN_SQRT_PRICE);
    assertLt(GraduationMath.SQRT_UPPER, TickMath.MAX_SQRT_PRICE);
    // ve tickSpacing = 1'in NEDEN secilmedigi:
    assertEq(TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(1)), TickMath.MAX_SQRT_PRICE);
}

/// V4 LP ucreti SIFIR ve dinamik bayrak DEGIL -- yani hic kimse, hook dahil,
/// havuz ucretini degistiremez.
function test_poolFeeIsZeroAndNotTheDynamicSentinel() public pure {
    assertEq(GraduationMath.POOL_FEE, 0);
    assertFalse(LPFeeLibrary.isDynamicFee(GraduationMath.POOL_FEE));
    assertEq(LPFeeLibrary.DYNAMIC_FEE_FLAG, 0x800000);
}

// ---------- SIRALAMA ----------

/// USDC 0x36...'da oturur. Token adresi 160-bit uzayda tekduzedir (factory'nin
/// salt'i TURETILMIS, madenle bulunmamis), dolayisiyla 0x36/0x100 = %21,09375
/// USDC'nin ALTINA duser. "Token her zaman currency1'dir" diye yazilmis bir
/// kod, launch'larin BESTE BIRINDE CurrenciesOutOfOrderOrEqual ile revert eder.
function test_aTokenBelowUsdcBecomesCurrency0() public pure {
    (PoolKey memory key, bool baseIsCurrency0) =
        GraduationMath.poolKey(address(0x0000000000000000000000000000000000001234), IHooks(HOOK));
    assertTrue(baseIsCurrency0);
    assertEq(Currency.unwrap(key.currency0), address(0x1234));
    assertEq(Currency.unwrap(key.currency1), GraduationMath.QUOTE);
}

function test_aTokenAboveUsdcBecomesCurrency1() public pure {
    (PoolKey memory key, bool baseIsCurrency0) =
        GraduationMath.poolKey(address(0xFF00000000000000000000000000000000000000), IHooks(HOOK));
    assertFalse(baseIsCurrency0);
    assertEq(Currency.unwrap(key.currency0), GraduationMath.QUOTE);
    assertEq(Currency.unwrap(key.currency1), address(0xFF00000000000000000000000000000000000000));
}

/// currency0 < currency1 HER ZAMAN, ve esitlik ASLA. PoolManager `>=` ile
/// reddeder, yani esitlik de reddedilir.
function testFuzz_currenciesAreAlwaysStrictlyOrdered(address base) public pure {
    vm.assume(base != address(0) && base != GraduationMath.QUOTE);
    (PoolKey memory key,) = GraduationMath.poolKey(base, IHooks(HOOK));
    assertLt(Currency.unwrap(key.currency0), Currency.unwrap(key.currency1));
}

/// address(0) ANAHTARA ASLA GIRMEZ. PoolManager bunu reddetmez:
/// {address(0), 0x3600...} `currency0 < currency1`i GECER ve sessizce
/// USDC'nin kendisine karsi bir havuz olur. Reddetmek arcpad'in isi.
function test_zeroBaseIsRejected() public {
    vm.expectRevert(GraduationMath.ZeroBase.selector);
    GraduationMath.poolKey(address(0), IHooks(HOOK));
}

function test_usdcAsBaseIsRejected() public {
    vm.expectRevert(GraduationMath.BaseIsQuote.selector);
    GraduationMath.poolKey(GraduationMath.QUOTE, IHooks(HOOK));
}

/// KANIT, kontrol degil: base sifir olmadigi ve QUOTE'a esit olmadigi surece
/// iki bacaktan hangisi currency0 olursa olsun sifir OLAMAZ, cunku QUOTE
/// sifir olmayan bir sabittir. Fuzz bunu tum uzayda tarar.
function testFuzz_neitherCurrencyIsEverTheZeroAddress(address base) public pure {
    vm.assume(base != address(0) && base != GraduationMath.QUOTE);
    (PoolKey memory key,) = GraduationMath.poolKey(base, IHooks(HOOK));
    assertTrue(Currency.unwrap(key.currency0) != address(0));
    assertTrue(Currency.unwrap(key.currency1) != address(0));
}

// ---------- 10^12 SINIRI, IKI UCTAN ----------

/// MIKTAR ucu. Taban yuvarlar; kalan wei locker'da KALICI kalir.
/// uretim : 12_161_433_369_060_378_706_681 / 1e12 = 12_161_433_369
///          kalan 60_378_706_681 wei
/// testnet:     12_161_433_369_060_378_707 / 1e12 =     12_161_433
///          kalan 369_060_378_707 wei
function test_quoteUnitsTruncatesAndTheResidueIsExact() public pure {
    assertEq(GraduationMath.quoteUnits(12_161_433_369_060_378_706_681), 12_161_433_369);
    assertEq(12_161_433_369_060_378_706_681 - 12_161_433_369 * 1e12, 60_378_706_681);
    assertEq(GraduationMath.quoteUnits(12_161_433_369_060_378_707), 12_161_433);
    assertEq(12_161_433_369_060_378_707 - 12_161_433 * 1e12, 369_060_378_707);
}

/// 1 ERC-20 biriminin ALTINDAKI her sey sifira duser. Arc'in kendi
/// dokumani: "balanceOf'un 0 olmasi native bakiyenin 0 oldugunu ima ETMEZ."
function test_quoteUnitsIsZeroBelowOneUnit() public pure {
    assertEq(GraduationMath.quoteUnits(999_999_999_999), 0);
    assertEq(GraduationMath.quoteUnits(1e12), 1);
}

/// FIYAT ucu. Donusumu unutmak fiyati 10^6 katiyla kaydirir; sabitlenmis
/// literal bunu yakalar. Turetme:
///   oran(X192) = floor(Vq_final * 2^192 / (Vt_final * 1e12))
///   sqrtPriceX96 = floor(sqrt(oran))
function test_sqrtPriceProductionTokenIsCurrency0() public pure {
    assertEq(
        GraduationMath.sqrtPriceX96(16_453_433_369_060_378_706_681, 279_900_000_000_000_000_000_000_000, true),
        607444218490929862364
    );
}

function test_sqrtPriceProductionUsdcIsCurrency0() public pure {
    assertEq(
        GraduationMath.sqrtPriceX96(16_453_433_369_060_378_706_681, 279_900_000_000_000_000_000_000_000, false),
        10333626601930376557517671504208461029
    );
}

function test_sqrtPriceTestnetTokenIsCurrency0() public pure {
    assertEq(
        GraduationMath.sqrtPriceX96(16_453_433_369_060_378_707, 279_900_000_000_000_000_000_000_000, true),
        19209072819323074681
    );
}

function test_sqrtPriceTestnetUsdcIsCurrency0() public pure {
    assertEq(
        GraduationMath.sqrtPriceX96(16_453_433_369_060_378_707, 279_900_000_000_000_000_000_000_000, false),
        326777965518061118072680912817470217035
    );
}

/// Dort literalin tick'i de tam aralikta VE tam aralikin ICINDE.
/// Tick'ler `getTickAtSqrtPrice`in tanimidir: en buyuk t oyle ki
/// getSqrtPriceAtTick(t) <= sqrtPriceX96.
function test_allFourPricesLandInsideTheFullRange() public pure {
    assertEq(TickMath.getTickAtSqrtPrice(607444218490929862364), -373746);
    assertEq(TickMath.getTickAtSqrtPrice(10333626601930376557517671504208461029), 373745);
    assertEq(TickMath.getTickAtSqrtPrice(19209072819323074681), -442827);
    assertEq(TickMath.getTickAtSqrtPrice(326777965518061118072680912817470217035), 442826);
    // Dordu de tam aralikin KESINLIKLE icinde: +-442.827 << +-887.220,
    // yani iki kat pay. tickSpacing = 60 secimini savunan olcum budur.
    assertGt(TickMath.getTickAtSqrtPrice(19209072819323074681), GraduationMath.TICK_LOWER);
    assertLt(TickMath.getTickAtSqrtPrice(326777965518061118072680912817470217035), GraduationMath.TICK_UPPER);
}

/// Iki profilin tick'leri simetrik DEGIL, bir birim kayiktir (-373746 vs
/// 373745). Sebebi `getTickAtSqrtPrice`in TABAN tanimi ve iki sqrtPriceX96'nin
/// ikisinin de asagi yuvarlanmis olmasidir -- yani kayma bir HATA DEGIL,
/// asagi-yuvarlama yonunun gozlemlenebilir izidir. Simetri bekleyen bir
/// uygulayici burada duracak.
function test_theTwoOrientationsTicksDifferByOneBecauseBothRoundDown() public pure {
    assertEq(
        TickMath.getTickAtSqrtPrice(607444218490929862364)
            + TickMath.getTickAtSqrtPrice(10333626601930376557517671504208461029),
        -1
    );
}

/// SIRALAMA TERS CEVRILDIGINDE FIYAT DA TERSINE DONER, ve carpimlari
/// 2^192'ye ESIT DEGIL YAKINDIR (ikisi de asagi yuvarlar). Bu test,
/// `baseIsCurrency0` bayragini fiyat hesabina TASIMAYI unutan mutanti
/// oldurur -- ki o mutant sqrtPriceX96'yi 10^17 kat yanlis yapar ve
/// yalnizca literal esitligiyle gorulur.
function test_theTwoOrientationsAreReciprocalToWithinOneUlp() public pure {
    uint256 a = 607444218490929862364;
    uint256 b = 10333626601930376557517671504208461029;
    // a * b <= 2^192 ve fark, b'nin bir ulp'sinden kucuk
    assertLe(a * b, 1 << 192);
    assertGt(a * b, (1 << 192) - a - b);
}

// ---------- ASAGI YUVARLAMA YONU ----------

/// Iki dalda da ASAGI yuvarlanir, yani havuz P_final'da ya da ondan en
/// fazla bir Q64.96 ulp'si ASAGIDA acar -- ve yon IKI SIRALAMADA AYNIDIR.
/// Bu, spec §10 invariant 6'nin yazili halidir. Bir dalda `2^192 / diger`
/// ile hesaplayan (yani YUKARI yuvarlayan) bir uygulama bu testte olur.
function testFuzz_sqrtPriceNeverExceedsTheTruePrice(uint256 quoteFinal) public pure {
    quoteFinal = bound(quoteFinal, 1e18, 1e24);
    uint256 baseFinal = 279_900_000_000_000_000_000_000_000;
    uint160 s = GraduationMath.sqrtPriceX96(quoteFinal, baseFinal, true);
    // s^2 <= oran(X192) < (s+1)^2  -- yani s tam olarak floor(sqrt(oran))
    uint256 ratio = FullMath.mulDiv(quoteFinal, 1 << 192, baseFinal * 1e12);
    assertLe(uint256(s) * uint256(s), ratio);
    assertGt((uint256(s) + 1) * (uint256(s) + 1), ratio);
}

// ---------- 256-BIT UCURUMU ----------

/// Faz 1c'nin piyasa degeri tabani, Faz 2'nin tasma guvenligini %8,4 payla
/// tasiyor ve bunu simdiye kadar HIC KIMSE YAZMAMISTI. Turetme:
///   USDC = currency0 dalinda oran(X192) = Vt*1e12 * 2^192 / Vq
///   FullMath.mulDiv(a, 2^192, d) ancak `d > a >> 64` iken sigar
///   (prod1 = (a * 2^192) >> 256 = a >> 64, guard `require(d > prod1)`)
///   a = 279_900_000e18 * 1e12  ->  a >> 64 = 15_173_409_403_934_634_553
///   Vq = V*T/(T-S)             ->  V_ucurum = 3_958_096_264_828_801_689
///   MIN_OPENING_MARKET_CAP = 4e18  ->  V >= 4_292_000_000_000_000_000
///   pay = 4_292_000_000_000_000_000 / 3_958_096_264_828_801_689 = x1,0844
function test_theOverflowCliffIsExactlyWhereTheDerivationSaysItIs() public pure {
    uint256 baseFinal = 279_900_000_000_000_000_000_000_000;
    assertEq((baseFinal * 1e12) >> 64, 15_173_409_403_934_634_553);
    assertFalse(GraduationMath.isSeedable(15_173_409_403_934_634_553, baseFinal));
    assertTrue(GraduationMath.isSeedable(15_173_409_403_934_634_554, baseFinal));
}

/// Ve iki kutsanmis profilin IKISI DE ucurumun ustunde.
function test_bothBlessedProfilesAreSeedable() public pure {
    uint256 baseFinal = 279_900_000_000_000_000_000_000_000;
    assertTrue(GraduationMath.isSeedable(16_453_433_369_060_378_706_681, baseFinal)); // uretim
    assertTrue(GraduationMath.isSeedable(16_453_433_369_060_378_707, baseFinal));     // testnet
}

/// `isSeedable` REVERT ETMEZ -- factory kendi hatasiyla reddedebilsin diye.
/// Tasma sinirinda bile `false` doner, `FullMath`in revert'ini sizdirmaz.
function test_isSeedableReturnsFalseInsteadOfRevertingAtTheCliff() public view {
    // dogrudan cagri; vm.expectRevert YOK, cunku revert OLMAMALI
    assertFalse(GraduationMath.isSeedable(1, 279_900_000_000_000_000_000_000_000));
    assertFalse(GraduationMath.isSeedable(0, 1));
    assertFalse(GraduationMath.isSeedable(1, 0));
}

// ---------- TOHUM LIKIDITESI ----------

/// L ASAGI yuvarlar (getLiquidityForAmounts), Pool.modifyLiquidity gerekli
/// miktarlari YUKARI yuvarlar. Yonler zit oldugu icin bacak basina 1 wei
/// tasma teorik olarak mumkundur; DORT KANONIK DURUMDA OLCULDU: yok.
/// Baglayici bacak her zaman quote'tur, cunku R6 taban yuvarlamasiyla
/// R'nin altindadir.
function test_seedLiquidityProductionBothOrderings() public pure {
    assertEq(
        GraduationMath.seedLiquidity(607444218490929862364, D, 12_161_433_369),
        1586199999999999999
    );
    assertEq(
        GraduationMath.seedLiquidity(10333626601930376557517671504208461029, 12_161_433_369, D),
        1586200000000000000
    );
}

function test_seedLiquidityTestnetBothOrderings() public pure {
    assertEq(GraduationMath.seedLiquidity(19209072819323074681, D, 12_161_433), 50160046734639668);
    assertEq(
        GraduationMath.seedLiquidity(326777965518061118072680912817470217035, 12_161_433, D),
        50160046734639668
    );
}

/// L, hem uint128'e hem de tickSpacing 60'in tick basina tavanina sigar.
///   numTicks = 14787 - (-14788) + 1 = 29576
///   maxLiquidityPerTick = (2^128 - 1) / 29576
///                       = 11_505_354_575_363_080_317_263_139_282_924_270
/// En buyuk L (uretim) tavanin 7,25e15'te biri; bu kontrol asla tetiklenmez
/// ve NEDEN tetiklenmedigi burada yazili.
function test_liquidityIsFarBelowTheMaxPerTick() public pure {
    assertEq(Pool.tickSpacingToMaxLiquidityPerTick(60), 11_505_354_575_363_080_317_263_139_282_924_270);
    assertLt(1586200000000000000, Pool.tickSpacingToMaxLiquidityPerTick(60));
}

/// `D` YERINE `N - S` tohumlamak fiyati DEGISTIRMEZ (fiyat P_final'dan
/// gelir, tohumlanan orandan DEGIL) -- yalnizca TOZU degistirir:
///   D    ile toz = 130_353_606 wei          = 1,3e-10 token
///   N-S  ile toz = 13_988_815_963_088_900_903_466 wei = 13.988,8159 token
/// yani 1,07e14 kat. pump.fun'in %0,00676 fiyat kopuklugu, arcpad'in
/// dunyasinda bir FIYAT kopuklugu degil bir TOZ kalemidir, cunku arcpad
/// initialize'a acik bir sqrtPriceX96 gecirir.
function test_seedingNMinusSWouldNotMovethePriceButWouldStrandFourteenThousandTokens() public pure {
    uint160 s = 607444218490929862364;
    uint128 withD = GraduationMath.seedLiquidity(s, D, 12_161_433_369);
    uint128 withNminusS = GraduationMath.seedLiquidity(s, 206_900_000_000_000_000_000_000_000, 12_161_433_369);
    assertEq(withD, 1586199999999999999);
    assertEq(withNminusS, 1586200000003369815);
    // ... ve iki durumda da havuza gecilen sqrtPriceX96 AYNIDIR: s
}
```

- [ ] **Adım 2: Çalıştır, kırıldığını doğrula**

```bash
forge test --root contracts --match-path 'test/GraduationMath.t.sol'
```

Beklenen: `Source "../src/libraries/GraduationMath.sol" not found`. **Derleme hatası**, kırmızı test değil.

- [ ] **Adım 3: `GraduationMath`'i yaz**

```solidity
library GraduationMath {
    /// @notice Arc'in ERC-20 USDC arayuzu. Havuzun quote bacagi BUDUR ve
    ///         `address(0)` DEGILDIR. Arc dokumani emir kipinde: "ERC-20 USDC
    ///         kontratini dogrudan cift tokeni olarak kullan", "WUSDC deploy
    ///         ETME", "native'i ERC-20 arayuzuyle eslestirme -- ikisi ayni
    ///         varliktir." `PoolManager` ikisini AYIRT EDEMEZ: "native"
    ///         kavraminin tamami `currency.isAddressZero()`dur.
    address internal constant QUOTE = 0x3600000000000000000000000000000000000000;

    /// @notice 1 ERC-20 birimi = 10^12 wei. BU SABIT SADECE BURADA GECER;
    ///         Task 6 bir grep testiyle baska hicbir dosyada 1e12 literali
    ///         olmadigini sabitler.
    uint256 internal constant QUOTE_SCALE = 1e12;

    uint256 internal constant Q192 = 1 << 192;

    /// @notice V4 LP ucreti. SIFIR, ve `LPFeeLibrary.DYNAMIC_FEE_FLAG`
    ///         (0x800000) DEGIL -- yani `PoolManager.updateDynamicLPFee`
    ///         `UnauthorizedDynamicLPFeeUpdate()` ile doner ve HOOK'UN KENDISI
    ///         BILE havuz ucretini degistiremez. Sifir olmasinin sebebi: V4'te
    ///         havuz ucreti pozisyonlara birikir, arcpad'in tek pozisyonunun
    ///         cikarma yolu yoktur, dolayisiyla sifir olmayan bir ucret
    ///         sonsuza kadar yakilirdi. Ucret hook'ta tahsil edilir (spec §5.5).
    uint24 internal constant POOL_FEE = 0;

    /// @notice Havuzda tek bir tam aralik pozisyon oldugu icin tick yogunlugu
    ///         EKONOMIK OLARAK ATILDIR. Secimi belirleyen tek sey sinir
    ///         davranisidir: tickSpacing = 1 ile ust sinir tam olarak
    ///         `MAX_SQRT_PRICE` olur -- `getTickAtSqrtPrice`in KENDISININ
    ///         reddettigi deger. 60, locker'in dokundugu her sqrt fiyatini
    ///         V4'un dogruladigi araligin KESINLIKLE icinde tutar ve gereken
    ///         tick araligina (+-442.827) iki kat pay birakir.
    int24 internal constant TICK_SPACING = 60;

    int24 internal constant TICK_LOWER = -887220; // TickMath.minUsableTick(60)
    int24 internal constant TICK_UPPER = 887220;  // TickMath.maxUsableTick(60)

    /// @dev Sabit gaz icin sabit yazilir; DOGRULUGU testte `TickMath`e karsi
    ///      kanitlanir. Sabiti degistiren bir mutasyon orada olur.
    uint160 internal constant SQRT_LOWER = 4306310044;
    uint160 internal constant SQRT_UPPER = 1457652066949847389969617340386294118487833376468;

    error ZeroBase();
    error BaseIsQuote();
    error ZeroReserves();
    error PriceOutOfRange();

    /// @notice Bir launch tokeni icin arcpad'in KANONIK havuz anahtari.
    /// @return baseIsCurrency0 Token'in `currency0` olup olmadigi. Cagiran bu
    ///         bayragi fiyat hesabina TASIMAK ZORUNDADIR; tasimamak fiyati
    ///         tersine cevirir ve hicbir revert uretmez.
    /// @dev SIRALAMA HESAPLANIR. `PoolManager` katı `currency0 < currency1`
    ///      uygular (`>=` reddedilir). USDC 0x36...'da oturur ve factory'nin
    ///      salt'i TURETILMISTIR, madenle bulunmamis; token adresleri 160-bit
    ///      uzayda tekdüzedir, dolayisiyla 0x36/0x100 = %21,09375'i USDC'nin
    ///      ALTINA duser. "Token her zaman currency1" varsayimi HER BES
    ///      LAUNCH'TAN BIRINI kirar.
    /// @dev `address(0)` ANAHTARA GIREMEZ ve bu bir KANITTIR: `QUOTE` sifir
    ///      olmayan bir sabit oldugu icin, `base != 0` saglandiginda iki
    ///      bacaktan hangisi `currency0` olursa olsun sifir olamaz.
    ///      `ZeroBase()` kontrolu, kaniti kanit yapan sey.
    function poolKey(address base, IHooks hooks)
        internal
        pure
        returns (PoolKey memory key, bool baseIsCurrency0)
    {
        if (base == address(0)) revert ZeroBase();
        if (base == QUOTE) revert BaseIsQuote();
        baseIsCurrency0 = base < QUOTE;
        key = PoolKey({
            currency0: Currency.wrap(baseIsCurrency0 ? base : QUOTE),
            currency1: Currency.wrap(baseIsCurrency0 ? QUOTE : base),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hooks
        });
    }

    /// @notice Native 18-decimal quote wei -> 6-decimal ERC-20 birimi.
    /// @dev TABAN, ve kalan `quoteWei % QUOTE_SCALE` wei cagiranda KALICI
    ///      olarak kalir (1 ERC-20 biriminin altinda oldugu icin ERC-20
    ///      arayuzuyle hareket ettirilemez). Graduation basina en fazla
    ///      10^12 - 1 wei. Bu bir kayip degil, bir OZELLIGIN BEDELI: locker
    ///      kendi bakiyesini hic okumadigi icin biriken artik hicbir zaman
    ///      sonraki bir launch'a atanamaz.
    function quoteUnits(uint256 quoteWeiAmount) internal pure returns (uint256) {
        return quoteWeiAmount / QUOTE_SCALE;
    }

    /// @notice `quoteUnits`'in tersi: 6-decimal ERC-20 birimi -> native wei.
    /// @dev Hook, ucreti `take` ile 6-decimal birimde alir ama
    ///      `FeeEscrow.deposit{value:}` native wei ister. Carpma KONTROLLUDUR
    ///      ve tasarsa revert eder; `units` bir swap miktarindan geldigi ve
    ///      uint128'e sigdigi icin pratikte ulasilamaz.
    /// @dev BU FONKSIYON BURADA DURUR, hook'ta DEGIL, cunku `QUOTE_SCALE`
    ///      yalnizca bu dosyada bulunabilir (Task 6 grep testi).
    function quoteWei(uint256 units) internal pure returns (uint256) {
        return units * QUOTE_SCALE;
    }

    /// @notice Curve'un kapanis fiyatinin karekoku, Q64.96.
    /// @param quoteFinal `curve.virtualQuoteReserves()` (18 decimal native wei)
    /// @param baseFinal  `curve.virtualTokenReserves()` (18 decimal token wei)
    /// @dev TANIM BIR KEZ YAZILIR ve iki sıralamada da AYNI BICIMDEDIR:
    ///        oran(X192)   = floor(pay * 2^192 / payda)
    ///        sqrtPriceX96 = floor(sqrt(oran(X192)))
    ///      Iki dalda da ASAGI yuvarlanir, dolayisiyla havuz `P_final`'da ya da
    ///      ondan en fazla bir ulp asagida acar ve YON IKI SIRALAMADA AYNIDIR.
    ///      Bir dali `2^192 / digerSqrt` ile hesaplamak YASAKTIR: o yon YUKARI
    ///      yuvarlar ve tek bir invariant icin iki farkli tanim, tam olarak bir
    ///      tutarsizligin plana sizma bicimidir.
    /// @dev `baseFinal * QUOTE_SCALE` KONTROLLU aritmetiktir ve tasarsa revert
    ///      eder; sessiz sarma yoktur. Sinir disi profiller deploy aninda
    ///      `isSeedable` ile elenir.
    function sqrtPriceX96(uint256 quoteFinal, uint256 baseFinal, bool baseIsCurrency0)
        internal
        pure
        returns (uint160)
    {
        if (quoteFinal == 0 || baseFinal == 0) revert ZeroReserves();
        uint256 scaled = baseFinal * QUOTE_SCALE;
        uint256 s = Math.sqrt(
            baseIsCurrency0
                ? FullMath.mulDiv(quoteFinal, Q192, scaled)
                : FullMath.mulDiv(scaled, Q192, quoteFinal)
        );
        if (s <= TickMath.MIN_SQRT_PRICE || s >= TickMath.MAX_SQRT_PRICE) revert PriceOutOfRange();
        return uint160(s);
    }

    /// @notice Bir profilin HER IKI siralamada temsil edilebilir bir havuz
    ///         acilis fiyati uretip uretmedigi. REVERT ETMEZ.
    /// @dev REVERT ETMEMESI TASIYICIDIR: `LaunchFactory` bunu constructor'da
    ///      cagirir ve kendi `ProfileNotSeedable()` hatasiyla reddeder. Revert
    ///      etseydi factory'nin kullanicisi `FullMath`in ya da bu
    ///      kutuphanenin hatasini gorurdu ve HANGI KATMANIN reddettigi
    ///      kaybolurdu -- deponun `ZeroAmount` carpismasi dersinin aynisi.
    /// @dev Tasma kosulu ARITMETIK olarak, `FullMath`i cagirmadan hesaplanir:
    ///      `FullMath.mulDiv(a, 2^192, d)` sonucu ancak `d > a >> 64` iken
    ///      256 bite siğar, cunku prod1 = (a * 2^192) >> 256 = a >> 64 ve
    ///      guard `require(d > prod1)`.
    function isSeedable(uint256 quoteFinal, uint256 baseFinal) internal pure returns (bool) {
        if (quoteFinal == 0 || baseFinal == 0) return false;
        if (baseFinal > type(uint256).max / QUOTE_SCALE) return false;
        uint256 scaled = baseFinal * QUOTE_SCALE;
        if (scaled <= (quoteFinal >> 64)) return false;  // token = currency0 dali
        if (quoteFinal <= (scaled >> 64)) return false;  // USDC  = currency0 dali
        uint256 a = Math.sqrt(FullMath.mulDiv(quoteFinal, Q192, scaled));
        uint256 b = Math.sqrt(FullMath.mulDiv(scaled, Q192, quoteFinal));
        return a > TickMath.MIN_SQRT_PRICE && a < TickMath.MAX_SQRT_PRICE && b > TickMath.MIN_SQRT_PRICE
            && b < TickMath.MAX_SQRT_PRICE;
    }

    /// @notice Tam aralik pozisyonun likiditesi.
    /// @dev ASAGI yuvarlar; `Pool.modifyLiquidity` gerekli miktarlari YUKARI
    ///      yuvarlar. Yonler zit oldugu icin bacak basina 1 wei tasma teorik
    ///      olarak mumkundur -- dort kanonik durumda OLCULDU: yok. Locker yine
    ///      de acik bir kontrol tasir (`SeedShortfall`), cunku aksi halde
    ///      arıza `SafeERC20`nin icinde, hangi katmanin yetersiz kaldigini
    ///      soylemeyen bir revert olarak gorunurdu.
    function seedLiquidity(uint160 sqrtPrice, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        return LiquidityAmounts.getLiquidityForAmounts(sqrtPrice, SQRT_LOWER, SQRT_UPPER, amount0, amount1);
    }
}
```

- [ ] **Adım 4: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --match-path 'test/GraduationMath.t.sol' -vv
FOUNDRY_PROFILE=ci forge test --root contracts --match-path 'test/GraduationMath.t.sol'
```

- [ ] **Adım 5: Mutasyonla doğrula**

| Mutasyon | Ölmesi gereken test |
|---|---|
| `baseIsCurrency0 = base < QUOTE` → `= false` (token her zaman `currency1`) | `test_aTokenBelowUsdcBecomesCurrency0` |
| `if (base == address(0)) revert` kaldır | `test_zeroBaseIsRejected` **ve** `testFuzz_neitherCurrencyIsEverTheZeroAddress` |
| `scaled = baseFinal * QUOTE_SCALE` → `= baseFinal` (10¹² unut) | dört `sqrtPrice*` literali |
| `quoteWei / QUOTE_SCALE` → `* QUOTE_SCALE` | `test_quoteUnitsTruncatesAndTheResidueIsExact` |
| `sqrtPriceX96`'da `baseIsCurrency0` dallanmasını kaldır (her zaman ilk dal) | üretim/testnet `UsdcIsCurrency0` literalleri |
| `USDC = currency0` dalını `Q192 / sqrtDiger` ile hesapla | `testFuzz_sqrtPriceNeverExceedsTheTruePrice` **veya hiçbiri** — **hangisi olduğunu ölç ve raporla** |
| `isSeedable`'ın iki taşma kontrolünü kaldır | `test_isSeedableReturnsFalseInsteadOfRevertingAtTheCliff` (artık `FullMath` revert'i sızar) |
| `isSeedable`'da `<=` → `<` (uçurumu bir wei kaydır) | `test_theOverflowCliffIsExactlyWhereTheDerivationSaysItIs` |
| `SQRT_UPPER` sabitini son basamağından değiştir | `test_fullRangeSqrtConstantsMatchTickMath` |
| `TICK_SPACING` → `1` | `test_tickSpacingKeepsBothBoundsStrictlyInsideV4sValidatedRange` |
| `POOL_FEE` → `3000` | `test_poolFeeIsZeroAndNotTheDynamicSentinel` |

**Altıncı satır özellikle ölçülmelidir.** İki tanımın da fiyatı `~10⁻²¹` içinde verdiği için fuzz'ın onu yakalayıp yakalamayacağı **belirsizdir**; yakalamıyorsa bu bir boşluktur ve o zaman `USDC = currency0` dalı için de sabitlenmiş bir literal **tek** koruma olur. Hangi olduğunu ölç ve rapora yaz.

- [ ] **Adım 6: Commit**

```bash
git commit -m "feat(contracts): per-launch currency ordering and the single 10^12 boundary"
```

---

### Task 3: `FeeSchedule` — havuz kademeleri, launch anında donmuş

**İki farklı "ücret kademesi" vardır ve karıştırmak bu görevin tek gerçek tuzağıdır.**

1. **`PoolKey.fee`** — V4'ün LP ücreti. arcpad'de **`0`**, ve Task 2'de kanıtlandığı gibi **değiştirilemez** (dinamik bayrak olmadığı için `updateDynamicLPFee` hook'a bile kapalı). Havuzun kalıcı kimliğinin parçasıdır.
2. **arcpad'in kademesi** — hook'un tahsil ettiği, market cap'e endeksli oran. Bu görev onu taşır.

**Not, ve bu bir düzeltmedir:** Faz 1c'nin Global Kısıtlar'ı "curve'de kademe taraması yoktur" derken pump.fun'ın curve'ünde **gerçekte bir tarama olduğunu** kaydetti — `computeFeesBps` her işlemde market cap hesaplar ve `calculateFeeTier` çağırır; canlı loglarda her curve işleminde `Instruction: GetFees` görünür. Düz görünmesinin sebebi curve'ün `FeeConfig`'inin **tek bir kademe** (eşik 0) taşımasıdır. Yani arcpad'in düz curve ücreti pump.fun'ın mekanizmasının **bilinçli sadeleştirmesidir, taklidi değil** — ve bu görev, havuz tarafında **taramanın gerçekten geri geldiği** yerdir.

**Files:**
- Create: `contracts/src/FeeSchedule.sol`
- Create: `contracts/test/FeeSchedule.t.sol`

**Interfaces:**
- Tüketir: yok (saf).
- Üretir: `contract FeeSchedule` — `function tierFor(uint256 marketCapUnits) external pure returns (uint256 protocolBps, uint256 creatorBps)`, `function marketCap(uint256 quoteRaw, uint256 baseRaw) external pure returns (uint256)`, `uint256 public constant SUPPLY_CONSTANT = 1e27`, `uint256 public constant TIER_COUNT = 25`.

#### LP payının katlanması — spec'in kendi toplam kolonuyla doğrulandı

Spec §5.5'in `stable_fee_tiers` tablosunda bir **LP kolonu** vardır (%0,02 → %0,20) ve **arcpad'de o payın alıcısı yoktur**: tek LP, çıkarma yolu olmayan kalıcı pozisyondur, dolayısıyla ona akan her şey yakılır. İki savunulabilir çözüm var ve seçilen birinci:

- **(seçilen) LP payı protokol payına katlanır.** Toplamlar spec'teki gibi kalır. Gerekçe bir windfall değil bir kurtarmadır: **arcpad'in protokolü LP'dir** (kalıcı pozisyonun sahibi), ve pump.fun'ın LP'sine gidecek pay arcpad'de yapısal olarak yakılır; hook'ta tahsil etmek onu geri kazanmaktır.
- (reddedilen) LP payı düşürülür. pump.fun'ın protokol/creator oranları korunur ama spec'in **her** toplamı değişir.

Katlamanın doğruluğu tahmin değil, **kontrol edilebilir**: katlanmış `protocolBps + creatorBps`, spec §5.5'in **Toplam** kolonuna 25 satırın 25'inde eşittir.

```
kademe 0     : LP 2  + protokol 93 -> protokol 95, creator 30 -> toplam 125  (spec: %1,25)
kademe >= 1  : LP 20 + protokol  5 -> protokol 25
  59.000     : creator 95 -> toplam 120   (spec: %1,20)
  300.000    : creator 90 -> toplam 115   (spec: %1,15)
  500.000    : creator 85 -> toplam 110   (spec: %1,10)
  700.000    : creator 80 -> toplam 105   (spec: %1,05)
  900.000    : creator 75 -> toplam 100   (spec: %1,00)
  2M         : creator 70 -> toplam  95   (spec: %0,95)
  3M..10M    : creator 65,60,55,50,45,40,35,30 -> toplam 90..55  (spec: %0,90 -> %0,55)
  11M..20M   : creator 28,25,23,20,18,15,13,10,8,5 -> toplam 53..30  (spec: %0,53 -> %0,30)
  20M+       : creator  5 -> toplam  30   (spec: %0,30)
```

**Kademe 0'ın protokol payı tam olarak `95`'tir — curve'ün `PROTOCOL_FEE_BPS`'iyle aynı sayı.** Bu bir tesadüf değil: spec §5.5 "creator/protokol bölüşümünü graduation öncesiyle birebir aynı tutmayı sağlar" der ve katlama o cümleyi aritmetiğe çevirir. **Sonuç: graduation, trader için ücret-nötrdür** — mezuniyetin kendisi hiçbir oranı değiştirmez, ilk eşik geçişi değiştirir (spec'in creator teşvik argümanı tam olarak budur).

#### Bilinmeyen sekiz satır — uydurulmadı, işaretlendi

Spec 11M–20M bandının **uç noktalarını** verir (creator %0,28 ve %0,05; toplam %0,53 ve %0,30) ama **aradaki sekiz satırı vermez** ve bu planın atıfta bulunabileceği hiçbir kaynak vermez. Bu yüzden:

- [ ] **Adım 1 (ÖLÇÜM, kod değil): canlı tabloyu çözmeyi dene**

pump.fun'ın AMM `FeeConfig` hesabı `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`'tir ve `stable_fee_tiers` alanını taşır (spec §5.5, `.superpowers/sdd/pumpfun-official-docs-audit.md`). Hesabı çöz, 25 satırın **tamamını** rapora yaz. Foundry'den Solana sorgulanamaz; bu bir zincir dışı adımdır.

**Çözülemezse** aşağıdaki enterpolasyon kullanılır ve **rapora sapma olarak yazılır**. Enterpolasyon keyfi değildir: spec'in verdiği **iki uç noktayı da** ve **iki toplamı da** birebir üretir ve katı azalandır.

```
i = 0..9  icin  creator_bps(i) = round(28 - 23*i/9)
        = 28, 25, 23, 20, 18, 15, 13, 10, 8, 5
uc noktalar: i=0 -> 28 (spec), i=9 -> 5 (spec)
toplamlar  : 53, 50, 48, 45, 43, 40, 38, 35, 33, 30
             i=0 -> 53 (spec), i=9 -> 30 (spec)
```

Spec §5.5'in tablosunu **düzeltmek bu görevin işi değildir**; sapma kaydedilir ve tablo güncellendiğinde yeni bir `FeeSchedule` deploy edilir — spec'in kendi yükseltme yolu budur ("Tabloyu güncellemek yeni bir `FeeSchedule` deploy etmek demektir ve **yalnızca sonraki launch'ları** etkiler").

- [ ] **Adım 2: Başarısız testleri yaz**

```solidity
/// 25 satirin 25'i, ESIK VE IKI ORAN. Tek tek. Bir dongude uretilen bir
/// test, tabloyu kendisiyle karsilastirirdi.
function test_allTwentyFiveTiersMatchTheSpecTable() public pure {
    _assertTier(0,                 95, 30);
    _assertTier(59_000_000_000,    25, 95);
    _assertTier(300_000_000_000,   25, 90);
    _assertTier(500_000_000_000,   25, 85);
    _assertTier(700_000_000_000,   25, 80);
    _assertTier(900_000_000_000,   25, 75);
    _assertTier(2_000_000_000_000, 25, 70);
    _assertTier(3_000_000_000_000, 25, 65);
    // ... 4M..10M: 60,55,50,45,40,35,30
    _assertTier(11_000_000_000_000, 25, 28);
    // ... 12M..19M: 25,23,20,18,15,13,10,8
    _assertTier(20_000_000_000_000, 25, 5);
}

/// KATLAMANIN DOGRULUGU: 25 satirin toplami spec §5.5'in Toplam kolonu.
function test_everyTierTotalMatchesTheSpecTotalColumn() public pure {
    uint256[25] memory totals =
        [125, 120, 115, 110, 105, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 53, 50, 48, 45, 43, 40, 38, 35, 33, 30];
    // ... her esik icin protocolBps + creatorBps == totals[i]
}

/// Kademe 0, curve'un oraniyla BIREBIR AYNI. Graduation ucret-notrdur.
function test_tierZeroReproducesTheCurveSplitExactly() public pure {
    (uint256 p, uint256 c) = schedule.tierFor(0);
    assertEq(p, BondingCurve(curveImpl).PROTOCOL_FEE_BPS());  // 95
    assertEq(c, BondingCurve(curveImpl).CREATOR_FEE_BPS());   // 30
}

/// ESIKLER KAPSAYICIDIR ve sinir DAVRANISI test edilir. Bir wei asagisi
/// onceki kademe. `>=` -> `>` mutantini oldurur.
function test_thresholdsAreInclusiveAtTheExactBoundary() public pure {
    (, uint256 cBelow) = schedule.tierFor(58_999_999_999);
    (, uint256 cAt) = schedule.tierFor(59_000_000_000);
    assertEq(cBelow, 30);
    assertEq(cAt, 95);
}

/// KATI AZALAN: creator payi hicbir esikte artmaz (kademe 0 -> 1 ATLAMASI
/// haric, ki o kasitlidir ve spec'in creator tesvikidir).
function testFuzz_creatorBpsIsNonIncreasingAboveTheFirstThreshold(uint256 a, uint256 b) public pure {
    a = bound(a, 59_000_000_000, 1e18);
    b = bound(b, a, 1e18);
    (, uint256 ca) = schedule.tierFor(a);
    (, uint256 cb) = schedule.tierFor(b);
    assertLe(cb, ca);
}

/// Market cap SABIT arzla hesaplanir, mint'in gercek arziyla DEGIL. Tum
/// launch'lar ayni arza sahip oldugu icin bu, market cap'i saf bir FIYAT
/// fonksiyonuna indirger.
///   uretim graduation: quoteRaw = 12_161_433_369, baseRaw = D
///                      mc = 12_161_433_369 * 1e27 / D = 58_783_256_052
///                         = 58.783,256052 USDC   <- 59.000 esiginin ALTINDA
///   testnet          : quoteRaw = 12_161_433     -> mc = 58_783_256
///                         = 58,783256 USDC
function test_graduationFdvSitsJustBelowTheFirstPoolThreshold() public pure {
    assertEq(schedule.marketCap(12_161_433_369, D), 58_783_256_052);
    assertLt(schedule.marketCap(12_161_433_369, D), 59_000_000_000);
    assertEq(schedule.marketCap(12_161_433, D), 58_783_256);
    // ...ve mezuniyet aninda kademe hala 0:
    (uint256 p, uint256 c) = schedule.tierFor(schedule.marketCap(12_161_433_369, D));
    assertEq(p, 95);
    assertEq(c, 30);
}

/// FDV ile RAISE ayri buyukluklerdir ve karistirmak sessiz bir hatadir.
///   uretim: raise R6 = 12_161_433_369 (12.161,43 USDC)
///           FDV       = 58_783_256_052 (58.783,26 USDC)
function test_fdvAndRaiseAreDifferentMagnitudes() public pure {
    assertEq(12_161_433_369 * 1000 / 58_783_256_052, 206); // ~x4,83 fark
}

/// SETTER YOKTUR. Yuzey testi (Task 6) bunu iki yonlu kume esitligiyle
/// sabitler; buradaki test okunabilirlik icin.
function test_thereIsNoWayToChangeTheTable() public pure {
    // FeeSchedule'in TUM dis yuzeyi: tierFor, marketCap, SUPPLY_CONSTANT,
    // TIER_COUNT. Depolama YOKTUR -- tablo bytecode'dur.
}
```

- [ ] **Adım 3: `FeeSchedule`'ı yaz**

**Depolama yoktur.** Tablo `pure` fonksiyonun içindedir, yani garanti spec'in istediği yerden gelir: **bytecode'un değiştirilemezliği.** Constructor'da yazılan bir storage dizisi de setter'sız değiştirilemez olurdu ama bytecode daha güçlüdür ve daha ucuzdur.

```solidity
contract FeeSchedule {
    /// @notice Kademe secimi mint'in GERCEK arziyla degil bu sabitle yapilir.
    ///         Tum launch'lar ayni arza sahip oldugu icin market cap saf bir
    ///         fiyat fonksiyonuna iner (spec §5.5, pump.fun SDK kaynagi).
    uint256 public constant SUPPLY_CONSTANT = 1e27;

    uint256 public constant TIER_COUNT = 25;

    /// @dev 11M..20M bandinin creator bps'i, 8-bit lane'lerde, i = 0..9.
    ///      i = 0 -> en dusuk bayt. Degerler: 28,25,23,20,18,15,13,10,8,5.
    ///      Bkz. Adim 1: sekiz ara satir spec'te YOKTUR ve enterpolasyondur;
    ///      uc noktalar (28, 5) ve toplamlar (53, 30) spec'ten birebir.
    uint256 private constant CREATOR_BPS_11M_20M = 0x05080A0D0F121417191C;

    uint256 private constant UNIT = 1e6;         // 1 USDC, 6 decimal
    uint256 private constant MILLION = 1e6 * UNIT;

    /// @notice Market cap, quote'un taban biriminde (USDC icin 6 decimal).
    /// @dev `quoteRaw` ve `baseRaw` HAVUZUN ham miktarlaridir; quote 6,
    ///      base 18 decimal. Donusum YOKTUR ve olmamalidir: oran zaten
    ///      6-decimal quote biriminde bir sonuc verir.
    function marketCap(uint256 quoteRaw, uint256 baseRaw) external pure returns (uint256) {
        if (baseRaw == 0) return 0;
        return FullMath.mulDiv(quoteRaw, SUPPLY_CONSTANT, baseRaw);
    }

    /// @notice Verilen market cap icin protokol ve creator bps'i.
    /// @dev ESIKLER KAPSAYICIDIR (`>=`). Tarama YUKARIDAN asagiyadir, spec
    ///      §5.5'in "kademeler tersten taranir" kuralinin aynisi.
    /// @dev LP payi PROTOKOLE KATLANMISTIR (kademe 0'da 2, ustunde 20 bps).
    ///      Windfall degil kurtarmadir: arcpad'in protokolu LP'dir ve
    ///      pump.fun'in LP'sine gidecek pay burada yapisal olarak yakilirdi.
    ///      Katlamanin dogrulugu spec §5.5'in Toplam kolonuyla 25/25 eslesir.
    function tierFor(uint256 marketCapUnits)
        external
        pure
        returns (uint256 protocolBps, uint256 creatorBps)
    {
        if (marketCapUnits < 59_000 * UNIT) return (95, 30);   // kademe 0
        protocolBps = 25;                                       // 5 + 20 (LP)
        if (marketCapUnits >= 20 * MILLION) return (protocolBps, 5);
        if (marketCapUnits >= 11 * MILLION) {
            uint256 i = marketCapUnits / MILLION - 11;           // 0..8
            return (protocolBps, (CREATOR_BPS_11M_20M >> (8 * i)) & 0xFF);
        }
        if (marketCapUnits >= 3 * MILLION) {
            uint256 i = marketCapUnits / MILLION - 3;            // 0..7
            return (protocolBps, 65 - 5 * i);
        }
        if (marketCapUnits >= 2 * MILLION) return (protocolBps, 70);
        if (marketCapUnits >= 900_000 * UNIT) return (protocolBps, 75);
        if (marketCapUnits >= 700_000 * UNIT) return (protocolBps, 80);
        if (marketCapUnits >= 500_000 * UNIT) return (protocolBps, 85);
        if (marketCapUnits >= 300_000 * UNIT) return (protocolBps, 90);
        return (protocolBps, 95);                               // 59.000..300.000
    }
}
```

- [ ] **Adım 4: Test edilemeyen kısmı kayda geç**

**Testnet profilinde graduation FDV'si `58_783_256` = 58,78 USDC'dir ve ilk havuz eşiği 59.000 USDC'dir.** Yani **testnet'te kademe 0'ın üstüne hiç çıkılamaz** — 59.000 USDC'lik bir market cap'e ulaşmak, testnet havuzunun fiyatını ~1000 kat yukarı taşımayı gerektirir ve Circle faucet'i istek başına 10 USDC verir. Sonuç:

> **Kademe geçişlerinin hiçbiri Arc testnet'te gerçek büyüklüklerde çalıştırılamaz.** Task 8'in fork testi kademe 0'ı doğrular ve **yalnızca onu**. Geçişler birim testlerinde sentetik market cap değerleriyle doğrulanır. Bu bir boşluktur, kapatılamaz, ve rapora **açık hücre** olarak yazılır — uydurma bir fork iddiası, kapalı olmayan bir hücreyi kapalı gösterirdi.

- [ ] **Adım 5: Mutasyonla doğrula**

| Mutasyon | Ölmesi gereken test |
|---|---|
| Kademe 0'ın protokol payı `95` → `93` (katlamayı geri al) | `test_tierZeroReproducesTheCurveSplitExactly` **ve** toplam kolonu testi |
| `protocolBps = 25` → `5` (üst kademelerde katlamayı geri al) | `test_everyTierTotalMatchesTheSpecTotalColumn` |
| `>=` → `>` ilk eşikte | `test_thresholdsAreInclusiveAtTheExactBoundary` |
| `59_000 * UNIT` → `59_000` (decimal unut) | `test_graduationFdvSitsJustBelowTheFirstPoolThreshold` |
| `CREATOR_BPS_11M_20M` lane sırasını tersine çevir | `test_allTwentyFiveTiersMatchTheSpecTable` **ve** monotonluk fuzz'ı |
| `65 - 5 * i` → `65 - 4 * i` | 4M..10M satırları |
| `marketCap`'te `SUPPLY_CONSTANT` → `baseRaw` (gerçek arz) | `test_graduationFdvSitsJustBelowTheFirstPoolThreshold` |

- [ ] **Adım 6: Commit**

```bash
git commit -m "feat(contracts): immutable post-graduation fee tiers with the LP share folded into protocol"
```

---

### Task 4: `ArcpadHook` — havuzun kimliği ve quote cinsinden ücret

Hook, Task 5'ten **önce** gelir çünkü locker hook'un **adresini** constructor argümanı olarak alır ve o adres izin bitlerinden türer.

**Files:**
- Create: `contracts/src/ArcpadHook.sol`
- Create: `contracts/test/ArcpadHook.t.sol`
- Modify: `contracts/test/mocks/HookWiringMock.sol`
- Modify: `contracts/test/V4Wiring.t.sol`

**Interfaces:**
- Tüketir: `uniswap-hooks/base/BaseHook.sol`, `uniswap-hooks/utils/CurrencySettler.sol`, `@uniswap/v4-core/src/libraries/Hooks.sol`, `types/BeforeSwapDelta.sol`, `types/BalanceDelta.sol`, `types/PoolOperation.sol`, `GraduationMath`, `FeeSchedule`, `IFeeEscrow`.
- Üretir: `contract ArcpadHook is BaseHook` — `constructor(IPoolManager poolManager_, address factory_, address escrow_, address protocolTreasury_)`; `mapping(PoolId => PoolConfig) public configOf`; `event PoolRegistered(PoolId indexed id, address indexed base, address indexed creator)`, `event SwapFeeCollected(PoolId indexed id, uint256 protocolFee, uint256 creatorFee)`; hatalar `NotGraduationTarget()`, `QuoteLegMissing()`, `ZeroCurrency()`, `WrongPoolFee()`, `WrongTickSpacing()`, `TokenNotFromFactory()`, `PriceIsNotTheCurveClosingPrice()`.

#### İzin kümesi: `0x20CC` — ve mevcut pin YANLIŞ

`HookWiringMock.sol` bugün `{beforeInitialize, beforeSwap, beforeSwapReturnDelta}` (`0x2088`) pinler, `V4Wiring.t.sol` `assertFalse(permissions.afterSwap)` iddia eder. **Bu küme spec §5.5'i uygulayamaz** ve gerekçe vendored kaynaktan türetilmiştir.

Spec §5.5: *"Ücret **her zaman pairing asset'te** (native USDC) alınır, asla launch tokenında."* V4'te `beforeSwap` yalnızca **specified** para birimini ve miktarını bilir; `SwapParams.amountSpecified < 0` ise exact-input, `> 0` ise exact-output, ve specified para birimi ilkinde girdi ikincisinde çıktıdır. `Hooks.afterSwap`'in vendored gövdesi eşlemeyi şöyle yapar:

```solidity
hookDelta = (params.amountSpecified < 0 == params.zeroForOne)
    ? toBalanceDelta(hookDeltaSpecified, hookDeltaUnspecified)
    : toBalanceDelta(hookDeltaUnspecified, hookDeltaSpecified);
```

Yani **specified para birimi**, `(exactInput == zeroForOne)` iken `currency0`, aksi hâlde `currency1`'dir. Quote `currency1` olduğunda (launch'ların ~%79'u) dört swap şekli şöyle dağılır:

| şekil | `zeroForOne` | specified | quote nerede | ücret nerede kesilir |
|---|---|---|---|---|
| exact-input, base→quote (**sat**) | `true` | base | **unspecified** | `afterSwap` |
| exact-input, quote→base (**al**) | `false` | quote | specified | `beforeSwap` |
| exact-output, base→quote | `true` | quote | specified | `beforeSwap` |
| exact-output, quote→base (**tam token al**) | `false` | base | **unspecified** | `afterSwap` |

Quote `currency0` olduğunda tablo aynadır ama **dağılım aynıdır: ikisi `beforeSwap`, ikisi `afterSwap`.** Kural tek cümlede: **quote miktarı swap'ten *önce* biliniyorsa `beforeSwap`, yalnızca *sonra* biliniyorsa `afterSwap`.** İkinci grup için miktarı üretebilecek tek yer `afterSwap`'in kendisidir — `swapDelta` orada vardır.

```
BEFORE_INITIALIZE_FLAG         = 1 << 13 = 0x2000    havuz kimligi
BEFORE_SWAP_FLAG               = 1 << 7  = 0x0080    quote specified oldugunda
BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3  = 0x0008
AFTER_SWAP_FLAG                = 1 << 6  = 0x0040    quote unspecified oldugunda
AFTER_SWAP_RETURNS_DELTA_FLAG  = 1 << 2  = 0x0004
                                 ---------------
ARCPAD_HOOK_FLAGS              =          0x20CC = 8396
```

`BEFORE_SWAP_RETURNS_DELTA` `BEFORE_SWAP`'i gerektirir, `AFTER_SWAP_RETURNS_DELTA` `AFTER_SWAP`'i — ikisi de sağlanıyor, dolayısıyla `Hooks.isValidHookAddress` geçer. **`0x2088` ile kalmak, dört şeklin ikisinde ücreti launch tokenında tahsil etmek demekti** — spec'in "asla launch tokenında" cümlesinin ihlali.

> **Bu değişikliğin geri dönüşü yoktur ve zamanlaması bu yüzden bağlayıcıdır.** İlk graduation'dan sonra bayrak eklemek hook'un **adresini**, dolayısıyla her `PoolKey`'i ve her `PoolId`'yi değiştirir. Kapsam bölümünün argümanı burada somutlaşır.

**Ölçüm zorunluluğu:** yukarıdaki tablo vendored kaynaktan **türetilmiştir, çalıştırılarak doğrulanmamıştır.** Adım 2, hook madenlenip deploy edilmeden **önce** dört şeklin dördünü de gerçek bir `PoolManager`'a karşı koşmak ve ücretin her dördünde de USDC cinsinden geldiğini ölçmek zorundadır. Tablo yanlışsa, yanlışlığın öğrenilmesi gereken an budur — sonrası yok.

- [ ] **Adım 1: Başarısız testleri yaz**

```solidity
// ---------- IZIN BITLERI ----------

function test_permissionFlagsAreExactlyTheArcpadSet() public pure {
    assertEq(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG,
        0x20CC
    );
}

/// Madenlenmis adresin ALT 14 BITI tam olarak 0x20CC. BaseHook'un
/// constructor'i bunu dogrular, yani yanlis adrese deploy IMKANSIZDIR --
/// ama madencinin dogru bayragi aradigi ayrica test edilir, cunku yanlis
/// bayrakla madencilik SESSIZCE calisan ama YANLIS bir hook uretir.
function test_theMinedAddressCarriesExactlyTheArcpadFlags() public view {
    assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, 0x20CC);
}

function test_everyOtherPermissionIsFalse() public view {
    Hooks.Permissions memory p = hook.getHookPermissions();
    assertTrue(p.beforeInitialize);  assertFalse(p.afterInitialize);
    assertFalse(p.beforeAddLiquidity); assertFalse(p.afterAddLiquidity);
    assertFalse(p.beforeRemoveLiquidity); assertFalse(p.afterRemoveLiquidity);
    assertTrue(p.beforeSwap); assertTrue(p.afterSwap);
    assertFalse(p.beforeDonate); assertFalse(p.afterDonate);
    assertTrue(p.beforeSwapReturnDelta); assertTrue(p.afterSwapReturnDelta);
    assertFalse(p.afterAddLiquidityReturnDelta); assertFalse(p.afterRemoveLiquidityReturnDelta);
}

/// LIKIDITE EKLEME/CIKARMA BAYRAKLARI YOKTUR ve bu BILINCLIDIR: ucuncu bir
/// taraf arcpad havuzuna likidite ekleyebilir ve cikarabilir. "Likidite
/// kalicidir" iddiasi ARCPAD'IN POZISYONU hakkindadir, havuzun tamami
/// hakkinda degil. Havuz ucreti sifir oldugu icin bir LP'nin kazanci da
/// sifirdir, yani pratikte kimse eklemez -- ama iddia dogru yazilmalidir.
function test_thirdPartyLiquidityIsPermittedAndDoesNotTouchArcpadsPosition() public { ... }

// ---------- beforeInitialize: FAZIN EN KESKIN SALDIRISI ----------

/// ONCELIK SIRASI: HERKES, graduation'dan ONCE, arcpad'in PoolKey'ini
/// COP BIR FIYATLA initialize edebilirdi. Sonra locker'in `initialize`i
/// `PoolAlreadyInitialized` ile SONSUZA KADAR revert ederdi -- curve
/// `graduated = false` ile, fonlari elinde, ama HICBIR ZAMAN mezun
/// olamayacak durumda kalirdi. Tek bir launch'i kalici olarak
/// tuglalastirmanin maliyeti bir initialize cagrisinin gazi olurdu.
/// BEFORE_INITIALIZE BAYRAGINI TASIYICI YAPAN SEY BUDUR.
function test_anyoneOtherThanTheGraduationTargetCannotInitializeAnArcpadKey() public {
    (PoolKey memory key,) = GraduationMath.poolKey(base, IHooks(address(hook)));
    vm.prank(attacker);
    vm.expectRevert();  // Hooks.HookCallFailed sarar; ic selector ayrica iddia edilir
    poolManager.initialize(key, 79228162514264337593543950336);
    // ve hedef AYNI anahtari acabilir:
    vm.prank(address(locker));
    poolManager.initialize(key, expectedSqrtPrice);
}

/// address(0) IKINCI KATMANDA da reddedilir. PoolManager reddetmez:
/// {address(0), 0x3600...} `currency0 < currency1`i GECER.
function test_aKeyWithTheZeroAddressIsRejectedByTheHook() public {
    PoolKey memory key = PoolKey({
        currency0: Currency.wrap(address(0)),
        currency1: Currency.wrap(GraduationMath.QUOTE),
        fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
    });
    vm.prank(address(locker));
    vm.expectRevert();   // ZeroCurrency
    poolManager.initialize(key, 79228162514264337593543950336);
}

function test_aKeyWithoutTheUsdcLegIsRejected() public { ... }        // QuoteLegMissing
function test_aKeyWithNonZeroFeeIsRejected() public { ... }           // WrongPoolFee
function test_aKeyWithTheWrongTickSpacingIsRejected() public { ... }  // WrongTickSpacing
function test_aForgedTokenIsRejectedByTheFeeScheduleLookup() public { ... } // TokenNotFromFactory

/// INVARIANT 6, IKINCI KATMAN: hook, gecirilen sqrtPriceX96'yi curve'un
/// CANLI durumundan yeniden hesaplar ve esit olmasini ISTER. Bu, kutuphaneden
/// BAGIMSIZ bir turetme DEGILDIR (ayni kutuphaneyi cagirir) -- oldurdugu
/// mutant "dogru hesapladi, baskasini gecirdi"dir, ki o mutant tek katmanda
/// gorunmez.
function test_aPriceThatIsNotTheCurveClosingPriceIsRejected() public {
    (PoolKey memory key,) = GraduationMath.poolKey(base, IHooks(address(hook)));
    vm.prank(address(locker));
    vm.expectRevert();   // PriceIsNotTheCurveClosingPrice
    poolManager.initialize(key, expectedSqrtPrice + 1);
}

/// beforeSwap HEDEFE BAKMAZ. Hedef yeniden yonlendirildiginde ESKI
/// locker'in actigi havuzlar CALISMAYA DEVAM ETMEK ZORUNDADIR; hedefe bakan
/// bir swap yolu, her yeniden yonlendirmede tum eski havuzlari kilitlerdi.
function test_swapsKeepWorkingAfterTheGraduationTargetIsRepointed() public { ... }

// ---------- UCRET: DORT SEKLIN DORDU DE ----------

/// Dordunde de ucret USDC cinsinden gelir ve iki parca escrow'a yazilir.
/// TABLO VENDORED KAYNAKTAN TURETILDI, CALISTIRILARAK DOGRULANMADI --
/// bu dort test o turetmenin olcumudur.
function test_exactInputBuyChargesTheFeeInUsdcViaBeforeSwap() public { ... }
function test_exactOutputSellChargesTheFeeInUsdcViaBeforeSwap() public { ... }
function test_exactInputSellChargesTheFeeInUsdcViaAfterSwap() public { ... }
function test_exactOutputBuyChargesTheFeeInUsdcViaAfterSwap() public { ... }

/// ...ve HER DORDU ICIN, token cinsinden HICBIR ucret alinmadigi ayrica
/// iddia edilir. "USDC alindi" iddiasi, yanlisligina token'dan da alinmis
/// olmasi durumunda bile gecerdi.
function test_noFeeIsEverTakenInTheLaunchToken() public { ... }

/// Ucret PARCALARDAN toplanir, toplamdan BOLUNMEZ -- curve'un kuralinin
/// aynisi, ve ayni sebeple: iki tavan yuvarlamasinin toplami, birlesik
/// oranin tavanini asabilir ve fark her seferinde protokolun aleyhinedir.
function test_feeIsSummedFromPartsNotDividedFromTheTotal() public { ... }

/// Creator sifirsa creator payi ALINMAZ ve protokol payina KATLANMAZ --
/// islem sadece daha ucuz olur. Curve'un kuralinin aynisi.
function test_creatorFeeIsSkippedWhenCreatorIsZeroAndNotFoldedIntoProtocol() public { ... }

/// Mezuniyet aninda kademe 0'dir ve oranlar curve'unkiyle AYNIDIR: 95/30.
/// Yani graduation trader icin UCRET-NOTRDUR.
function test_theFirstPoolSwapPaysExactlyWhatTheLastCurveTradePaid() public { ... }

/// PoolManager'in kendi ucreti hicbir kosulda degistirilemez.
function test_evenTheHookCannotChangeThePoolFee() public {
    vm.prank(address(hook));
    vm.expectRevert(IProtocolFees.UnauthorizedDynamicLPFeeUpdate.selector);
    poolManager.updateDynamicLPFee(key, 3000);
}
```

**Gövdesi yukarıda açılmayan her testin iddia sözleşmesi. Bunlar özet değil, yazılacak `assert`'lerin tam listesidir** — `SwapHarness` ve yukarıdaki dört-şekil argüman tablosu fixture'ı tamamlar:

| test | tam iddia |
|---|---|
| `..UsdcLegMissing..` | `currency0 = 0x…11`, `currency1 = 0x…22` anahtarı; `initialize` revert eder, iç selector `QuoteLegMissing()` |
| `..NonZeroFee..` | kanonik anahtar, `fee = 3000`; iç selector `WrongPoolFee()` |
| `..WrongTickSpacing..` | kanonik anahtar, `tickSpacing = 10`; iç selector `WrongTickSpacing()` |
| `..ForgedToken..` | Faz 1c'nin sahte `LaunchToken`'ı (gerçek curve'ü iddia eden); `factory.feeScheduleOf(forged) == address(0)` **ve** iç selector `TokenNotFromFactory()` |
| `..thirdPartyLiquidity..` | `SwapHarness`'e benzer bir LP sürücüsü `[-600, 600]` aralığına `1e12` likidite ekler → başarır; sonra `getPositionInfo(locker, ±887220, 0)` **değişmemiştir**; sonra LP kendi pozisyonunu çeker → başarır; locker'ın pozisyonu **yine değişmemiştir** |
| `..RepointedTarget..` | graduate; `propose(newLocker)`; `warp(+3 days)`; `apply`; sonra `SwapHarness` ile exact-input buy → **başarır** ve escrow bakiyesi artar |
| `..exactInputBuy..` (beforeSwap) | quote→base, `amountSpecified = -1_000_000`; `escrow.owed(treasury)` `+9_500 · 1e12` wei, `escrow.owed(creator)` `+3_000 · 1e12` wei; alıcının aldığı base, ücretsiz swap'in `1_000_000 − 12_500` girdisine karşılık gelen miktar |
| `..exactOutputSell..` (beforeSwap) | base→quote, `amountSpecified = +1_000_000`; aynı iki escrow artışı; satıcı **tam** `1_000_000` quote alır |
| `..exactInputSell..` (afterSwap) | base→quote, `amountSpecified = -1_000_000` (base cinsinden); escrow artışı = `feeOn(çıkan quote, 95) + feeOn(çıkan quote, 30)`, quote miktarı `swapDelta`dan okunur |
| `..exactOutputBuy..` (afterSwap) | quote→base, `amountSpecified = +1_000_000` (base cinsinden); alıcı **tam** `1_000_000` base alır, escrow artışı girilen quote üzerinden |
| `..noFeeEverInTheLaunchToken..` | dört şeklin **dördünde de**: `IERC20(token).balanceOf(address(hook)) == 0` ve `escrow.owed(...)` yalnızca native (USDC) artmış |
| `..summedFromParts..` | `1_000_001` girdisiyle: `feeOn(1_000_001,95) + feeOn(1_000_001,30) == 9_501 + 3_001 == 12_502`, `feeOn(1_000_001,125) == 12_501`; escrow toplamı **12_502** olmalı, 12_501 **olmamalı** |
| `..creatorZero..` | `creator = address(0)` ile launch edilmiş bir curve; `escrow.owed(treasury)` `+9_500·1e12`, `escrow.owed(address(0))` **çağrılmamış** (escrow `ZeroRecipient()` ile revert ederdi), toplam ücret `12_500` değil **`9_500`** |
| `..feeNeutralGraduation..` | curve'ün son alımının ödediği `(protocolFee, creatorFee)` oranları `(95, 30)`; havuzun ilk swap'inin oranları da `(95, 30)` — `schedule.tierFor(marketCap)` mezuniyet anında kademe 0 |
| `..marketCapCrossCheck..` | `_marketCap` (slot0'dan) `== schedule.marketCap(12_161_433_369, D) == 58_783_256_052`; **iki bağımsız yol aynı literale varır** |

- [ ] **Adım 2: `ArcpadHook`'u yaz**

`configOf`, `beforeInitialize`'da **bir kez** yazılır ve swap yolunu **sabit gazlı** yapar: tek `mapping` okuması, hiç dış `view` çağrısı yok.

```solidity
struct PoolConfig {
    address base;              // launch tokeni
    address creator;           // creator payinin alicisi; SIFIR OLABILIR
    address schedule;          // launch aninda donmus FeeSchedule
    bool quoteIsCurrency0;     // USDC hangi bacak
}

/// @dev `sender`, `PoolManager.initialize`i CAGIRAN adrestir -- yani
///      locker. Guncel hedefi factory'den okur, `graduationTarget`in
///      yeniden yonlendirilebilir olmasiyla tutarli.
function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
    internal
    override
    returns (bytes4)
{
    // 1. EN UCUZ KONTROL ONCE, ve bu sira TASIYICIDIR: asagidaki iki
    //    harici okuma yalnizca hedefin sectigi bir anahtar icin yapilir,
    //    dolayisiyla dusman bir token uzerinden griefing yolu YOKTUR.
    if (sender != ILaunchFactoryGraduation(factory).graduationTarget()) revert NotGraduationTarget();

    address c0 = Currency.unwrap(key.currency0);
    address c1 = Currency.unwrap(key.currency1);
    // 2. address(0) IKINCI KATMAN. PoolManager bunu GECIRIR.
    if (c0 == address(0) || c1 == address(0)) revert ZeroCurrency();
    // 3. Bir bacak TAM OLARAK USDC.
    bool quoteIsCurrency0 = c0 == GraduationMath.QUOTE;
    if (!quoteIsCurrency0 && c1 != GraduationMath.QUOTE) revert QuoteLegMissing();
    if (key.fee != GraduationMath.POOL_FEE) revert WrongPoolFee();
    if (key.tickSpacing != GraduationMath.TICK_SPACING) revert WrongTickSpacing();

    address base = quoteIsCurrency0 ? c1 : c0;
    // 4. KANONIKLIK, SABIT GAZLI. `isCanonical` cagirmak sinirsiz gazli bir
    //    griefing yuzeyi olurdu (LaunchFactory'nin NatSpec'i olcerek
    //    kaydetti: 3.000.000 gaz butcesiyle 2.958.151 tuketim). Factory'nin
    //    mapping'i ayni kaniti tek SLOAD ile verir.
    address schedule = ILaunchFactoryFeeSchedule(factory).feeScheduleOf(base);
    if (schedule == address(0)) revert TokenNotFromFactory();

    // 5. INVARIANT 6, IKINCI KATMAN. Curve'un CANLI durumundan yeniden
    //    hesaplar. Kutuphaneden bagimsiz bir turetme DEGILDIR; oldurdugu
    //    mutant "dogru hesapladi, baskasini gecirdi"dir.
    address curve = ICurveBoundToken(base).curve();
    uint160 expected = GraduationMath.sqrtPriceX96(
        IGraduatableCurve(curve).virtualQuoteReserves(),
        IGraduatableCurve(curve).virtualTokenReserves(),
        !quoteIsCurrency0
    );
    if (sqrtPriceX96 != expected) revert PriceIsNotTheCurveClosingPrice();

    PoolId id = key.toId();
    configOf[id] = PoolConfig({
        base: base,
        creator: ICurveBoundToken(base).creator(),
        schedule: schedule,
        quoteIsCurrency0: quoteIsCurrency0
    });
    emit PoolRegistered(id, base, configOf[id].creator);
    return IHooks.beforeInitialize.selector;
}
```

Ücret. **Hook, kredisini almak için `take`'i deltayı döndürmeden ÖNCE yapar** ve bu V4'ün standart deseni: `take` bir borç yaratır, `_accountPoolBalanceDelta` `afterSwap`'ten **sonra** krediyi kaydeder, ikisi net sıfırda buluşur. Ters sırayla yapmak imkânsızdır — kredi henüz yoktur.

```solidity
/// @dev quote SPECIFIED tarafta oldugunda: miktar `amountSpecified`ten
///      bilinir, ucret specified slot'tan alinir.
///      exact-input : amountToSwap kuculur, ucret GIRDIDEN kesilir.
///      exact-output: amountToSwap buyur, havuz `amountSpecified + fee`
///                    uretir, kullanici tam istedigini alir, ucret
///                    fazladan girdi olarak odenir.
function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
    internal
    override
    returns (bytes4, BeforeSwapDelta, uint24)
{
    PoolConfig memory cfg = configOf[key.toId()];
    bool exactInput = params.amountSpecified < 0;
    bool specifiedIsCurrency0 = (exactInput == params.zeroForOne);
    if (specifiedIsCurrency0 != cfg.quoteIsCurrency0) {
        // quote UNSPECIFIED tarafta -> `afterSwap` halleder.
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
    uint256 amount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
    uint256 fee = _collect(key, cfg, amount);
    return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
}

/// @dev quote UNSPECIFIED tarafta oldugunda: miktar ancak swap'ten SONRA
///      bilinir. `Hooks.afterSwap` bu donusu unspecified slot'a yazar ve
///      dogru para birimine kendisi esler.
function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
    internal
    override
    returns (bytes4, int128)
{
    PoolConfig memory cfg = configOf[key.toId()];
    bool exactInput = params.amountSpecified < 0;
    bool specifiedIsCurrency0 = (exactInput == params.zeroForOne);
    if (specifiedIsCurrency0 == cfg.quoteIsCurrency0) return (IHooks.afterSwap.selector, 0);
    int128 quoteDelta = cfg.quoteIsCurrency0 ? delta.amount0() : delta.amount1();
    uint256 amount = quoteDelta < 0 ? uint256(int256(-quoteDelta)) : uint256(int256(quoteDelta));
    uint256 fee = _collect(key, cfg, amount);
    return (IHooks.afterSwap.selector, int128(int256(fee)));
}

/// @dev UCRET PARCALARDAN TOPLANIR, toplamdan BOLUNMEZ -- curve'un
///      kuralinin aynisi ve ayni sebeple. `take` krediyi kaydetmeden ONCE
///      yapilir; V4'un standart deseni budur ve tersi imkansizdir.
/// @dev 10^12 donusumu `GraduationMath.quoteWei` uzerinden gecer; bu
///      dosyada `1e12` literali YOKTUR.
function _collect(PoolKey calldata key, PoolConfig memory cfg, uint256 amount)
    private
    returns (uint256 fee)
{
    (uint256 protocolBps, uint256 creatorBps) =
        FeeSchedule(cfg.schedule).tierFor(_marketCap(key, cfg));
    uint256 protocolFee = CurveMath.feeOn(amount, protocolBps);
    // Creator sifirsa creator payi ALINMAZ ve protokol payina KATLANMAZ.
    uint256 creatorFee = cfg.creator == address(0) ? 0 : CurveMath.feeOn(amount, creatorBps);
    fee = protocolFee + creatorFee;
    if (fee == 0) return 0;

    Currency quote = cfg.quoteIsCurrency0 ? key.currency0 : key.currency1;
    quote.take(poolManager, address(this), fee, false);   // CurrencySettler

    IFeeEscrow(escrow).deposit{value: GraduationMath.quoteWei(protocolFee)}(protocolTreasury);
    if (creatorFee != 0) {
        IFeeEscrow(escrow).deposit{value: GraduationMath.quoteWei(creatorFee)}(cfg.creator);
    }
    emit SwapFeeCollected(key.toId(), protocolFee, creatorFee);
}
```

> **`take` USDC'yi hook'un native bakiyesine yazar, ve `escrow.deposit{value:}` onu oradan harcar.** Arc'ta ERC-20 transferi alıcının **native** bakiyesini kredilendirir ve `receive()`'i **çalıştırmaz** (`FeeEscrow` kısıtı (1), canlı Arc ölçümü, blok 54019678). Yani hook'un `receive()`'e ihtiyacı **yoktur** — ve olmaması gerekir. Yüzey testi bunu sabitler.

> **`GraduationMath.quoteWei` Task 2'de tanımlıdır** ve bu dosyada `1e12` literali **yoktur**; Task 6'nın grep testi bunu sabitler.

`_marketCap`, havuzun **anlık fiyatından** hesaplar. Ham rezervleri okumak `PoolManager`'ın tek bakiyesi tüm havuzlara ait olduğu için **imkânsızdır** — bu, V4'ün tekil mimarisinin doğrudan sonucu ve V3'ten en önemli ayrımı. Kullanılabilir tek kaynak `slot0`'ın `sqrtPriceX96`'sıdır:

```solidity
/// @dev marketCap = fiyat * N, quote'un taban biriminde (6 decimal).
///      Fiyat `sqrtPriceX96`ten gelir: p = (sqrtP / 2^96)^2 ve p,
///      currency1_raw / currency0_raw'dir. USDC hangi bacaksa oran ona gore
///      cevrilir.
/// @dev DONUSUM YOKTUR VE OLMAMALIDIR: quote bacagi zaten 6 decimal'dir,
///      dolayisiyla oran dogrudan 6-decimal bir market cap verir. Buraya bir
///      `QUOTE_SCALE` koymak degeri 10^12 kat sisirir ve kademeyi HER ZAMAN
///      en uste tasir -- yani ucret %1,25 yerine %0,30 olur ve hicbir revert
///      uretmez. Task 3'un kademe-0 testi bu mutanti oldurur.
/// @dev HAM REZERV OKUNAMAZ: `PoolManager`in USDC bakiyesi TUM havuzlarin
///      toplamidir. V4'un tekil mimarisi bunu yapisal olarak imkansiz kilar.
function _marketCap(PoolKey calldata key, PoolConfig memory cfg) private view returns (uint256) {
    (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
    // p1over0 = sqrtP^2 / 2^192, Q96 asamali hesaplanir ki tasma olmasin.
    uint256 priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
    return cfg.quoteIsCurrency0
        // USDC = currency0: quote/base = 2^96 / priceX96
        ? FullMath.mulDiv(FeeSchedule(cfg.schedule).SUPPLY_CONSTANT(), 1 << 96, priceX96)
        // token = currency0: quote/base = priceX96 / 2^96
        : FullMath.mulDiv(FeeSchedule(cfg.schedule).SUPPLY_CONSTANT(), priceX96, 1 << 96);
}
```

**Doğrulama, mezuniyet anında, üretim profili:** `sqrtPriceX96 = 10333626601930376557517671504208461029` (USDC = `currency0`), `priceX96 = sqrtP²/2⁹⁶`, ve `N · 2⁹⁶ / priceX96 = 58_783_256_052` — Task 3'ün `marketCap(12_161_433_369, D)` ile hesapladığı **aynı sayı**. **İki bağımsız yol aynı literale varır** ve Task 4'ün bir testi bu eşitliği iddia eder; ayrışırlarsa biri yanlıştır ve hangisi olduğu ölçülmelidir.

> **`FeeSchedule.marketCap(quoteRaw, baseRaw)` bu yüzden hook tarafından ÇAĞRILMAZ** — imzası ham rezerv ister ve hook'un ham rezervi yoktur. `FeeSchedule`'ın yüzeyinde durmaya devam eder çünkü Faz 3'ün indexer'ı (ham rezervleri kendi defterinden bilir) ve birim testleri onu kullanır. **Aynı büyüklüğü iki farklı imzayla hesaplayan iki fonksiyon bir tutarsızlık riskidir** ve yukarıdaki çapraz doğrulama testi tam olarak o riski kapatır.

- [ ] **Adım 3: Adres madenciliğini yaz ve salt'ı sabitle**

`HookMiner`, `@uniswap/v4-periphery/test/shared/HookMiner.sol`'de durur (**`src/` altında değil** — test ağacında; import yolu bu yüzden `test/shared/`'dir ve bu doğrulanmıştır).

```solidity
(address hookAddress, bytes32 salt) = HookMiner.find(
    0x4e59b44847b379578588920cA78FbF26c0B4956C,   // Arc testnet'te 69 bayt kod, olculdu
    0x20CC,
    type(ArcpadHook).creationCode,
    abi.encode(poolManager, factory, escrow, protocolTreasury)
);
```

Olasılık `1/2¹⁴ = 1/16384`; `HookMiner.MAX_LOOP = 160_444`, yani beklenen isabet ~9,8 ve başarısızlık olasılığı `e^{-9,8} ≈ 5,5×10⁻⁵`. **Bulunan salt Task 7'nin script'ine sabitlenir** (spec §13: "salt araması deterministiktir, bulunan salt script'e sabitlenir") ve bir test onu yeniden üretir.

**`ArcpadHook`'un `creationCode`'u değişirse salt geçersizdir** ve bu, fazın en kolay unutulan bağımlılığıdır. Bir test bunu yakalar: sabitlenmiş salt + güncel `creationCode` ile CREATE2 adresi yeniden türetilir ve deploy edilmiş hook'un adresine eşit olması iddia edilir. Eşit değilse hook **yeniden madenlenmelidir** ve o noktada **hiçbir mevcut havuz o hook'a ait değildir** — yani bu test, geri dönüşü olmayan bir hatanın erken alarmıdır.

`LaunchFactory`'nin CREATE2'siyle **çakışma yoktur**: factory token/curve için *kendisi* deployer'dır (`new X{salt:}`), hook ise deterministik deployer üzerinden tek seferlik bir deployment'tır. Farklı `deployer` girdileri, farklı initcode, ayrık adres türetmeleri.

- [ ] **Adım 4: `HookWiringMock.sol` ve `V4Wiring.t.sol`'ü güncelle**

`ArcpadHookPermissions.permissions()` `afterSwap: true` ve `afterSwapReturnDelta: true` olur. `V4Wiring.t.sol`'ün `assertFalse(permissions.afterSwap)` satırı `assertTrue` olur ve **değişikliğin gerekçesi test yorumuna yazılır** — "Faz 2 ölçtü: quote cinsinden ücret dört swap şeklinin ikisinde `afterSwap` gerektirir". Sabitlenmiş bir değeri "testi geçirmek için" değiştirmek yasaktır; buradaki değişiklik bir **bulgudur** ve türetmesi yukarıdadır.

- [ ] **Adım 5: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --match-path 'test/ArcpadHook.t.sol' -vv
forge test --root contracts --match-contract V4WiringTest
FOUNDRY_PROFILE=ci forge test --root contracts --no-match-path 'test/fork/*'
```

- [ ] **Adım 6: Mutasyonla doğrula**

| Mutasyon | Ölmesi gereken test |
|---|---|
| `sender != graduationTarget()` kontrolünü kaldır | `test_anyoneOtherThanTheGraduationTargetCannotInitializeAnArcpadKey` |
| `c0 == address(0) \|\| c1 == address(0)` kaldır | `test_aKeyWithTheZeroAddressIsRejectedByTheHook` |
| `feeScheduleOf` kontrolünü kaldır | `test_aForgedTokenIsRejectedByTheFeeScheduleLookup` |
| `sqrtPriceX96 != expected` kontrolünü kaldır | `test_aPriceThatIsNotTheCurveClosingPriceIsRejected` |
| `_beforeSwap`'te `specifiedIsCurrency0 != cfg.quoteIsCurrency0` → `==` | dört şekil testinden **en az ikisi** — hangileri olduğunu ölç |
| `_afterSwap`'in tamamını `return (selector, 0)` yap | exact-input-sell ve exact-output-buy testleri |
| `feeOn(amount, protocolBps + creatorBps)` (toplamdan böl) | `test_feeIsSummedFromPartsNotDividedFromTheTotal` |
| `cfg.creator == address(0)` ternary'sini kaldır | `test_creatorFeeIsSkippedWhenCreatorIsZeroAndNotFoldedIntoProtocol` |
| `quoteWei(protocolFee)` → `protocolFee` (10¹² unut) | escrow bakiyesini iddia eden her ücret testi |
| İzin kümesinden `AFTER_SWAP_FLAG`'i çıkar | `test_permissionFlagsAreExactlyTheArcpadSet` **ve** hook deploy edilemez (`BaseHook` constructor'ı) |

- [ ] **Adım 7: Commit**

```bash
git commit -m "feat(contracts): arcpad hook guards pool identity and charges the fee in USDC on all four swap shapes"
```

---

### Task 5: `ArcpadLocker` — graduation hedefi ve kalıcı pozisyon

**Files:**
- Create: `contracts/src/ArcpadLocker.sol`
- Create: `contracts/src/interfaces/IGraduatableCurve.sol`
- Create: `contracts/test/ArcpadLocker.t.sol`

**Interfaces:**
- Tüketir: `IPoolManager`, `IUnlockCallback`, `PoolKey`, `ModifyLiquidityParams`, `BalanceDelta`, `StateLibrary`, `Position`, `CurrencySettler`, `GraduationMath`, `IGraduatableCurve`.
- Üretir: `contract ArcpadLocker is IUnlockCallback` — `function graduate(address curve) external`, `function unlockCallback(bytes calldata data) external returns (bytes memory)`, `receive() external payable`, immutable'lar `poolManager`, `factory`, `hook`; `event PoolSeeded(...)`; hatalar `NotPoolManager()`, `CurveNotFromFactory()`, `UnexpectedCredit()`, `SeedShortfall()`, `ZeroLiquidity()`, `PoolPriceMismatch()`, `PositionNotSeeded()`.
- Üretir: `interface IGraduatableCurve` — `graduate()`, `token()`, `virtualQuoteReserves()`, `virtualTokenReserves()`, `poolSeedSupply()`, `complete()`, `graduated()`.

#### `initialize` ve `modifyLiquidity` tek `unlock`'ta olmak zorunda DEĞİL — tek İŞLEMDE olmak zorunda

Graduation yüzeyi tasarımının §9 maddesi 2 bunu açık bırakmıştı. **Cevap:** `PoolManager.initialize`'ın modifier'ları vendored kaynakta `noDelegateCall`'dır ve **`onlyWhenUnlocked` YOKTUR**; `modifyLiquidity` ise `onlyWhenUnlocked`'tır. Dolayısıyla:

- `initialize` kilidin **dışında** çağrılabilir (arcpad böyle yapar), ve
- kilidin **içinde** de çağrılabilir (hiçbir şey yasaklamıyor), yani seçim serbesttir.

**Atomiklik `unlock` sınırından değil işlem sınırından gelir.** §4.2'nin birinci yükümlülüğü ("hedefin giriş noktası işi tek işlemde bitirmeli ve her başarısızlıkta revert etmeli") bu yüzden **karşılanabilir** ve stranding yolu **yapısal değil, yalnızca kazara** kalır. Bu, o maddenin talep ettiği kanıttır.

#### Pozisyon nasıl "yakılır"

**V4'te LP tokeni yoktur.** Likidite, `PoolManager`'ın içinde `(owner, tickLower, tickUpper, salt)` ile anahtarlanmış bir pozisyondur. Sahip locker'dır. "Yakmak", `modifyLiquidity`'yi negatif `liquidityDelta` ile çağıran **kodun hiç yazılmaması**dır — spec §5.1'in dediği gibi: *"kilitlenecek bir NFT yoktur, likiditeyi hareket ettirebilecek kod hiç yazılmamıştır."*

**Bu, bir NFT kilitlemekten daha güçlü bir garantidir, ama test edilmesi daha zordur — yokluk test edilemez, yüzey test edilir.** Üç katman:

1. **ABI yüzey testi (Task 6), iki yönlü küme eşitliği.** Locker'ın dış fonksiyon kümesi tam olarak `{graduate, unlockCallback, poolManager, factory, hook}` + `receive`. Bir `withdraw()` eklemek testi kırar. Faz 1c'nin Task 4'ünde beş hayatta kalan mutant bu teknikle öldü; aynı teknik.
2. **`unlockCallback`'e ulaşılamazlığı.** `PoolManager.unlock(data)` `IUnlockCallback(msg.sender).unlockCallback(data)` çağırır — yani **locker'ın callback'ini yalnızca locker'ın kendi `unlock` çağrısı tetikleyebilir.** Saldırganın `locker.unlockCallback(...)`'ı doğrudan çağırması `NotPoolManager()` alır; saldırganın `poolManager.unlock`'u locker'ın callback'ini **hiç çağırmaz**. İki yol da test edilir.
3. **Geri okuma.** Graduation'dan sonra `StateLibrary.getPositionInfo` ile likidite okunur ve **her aktörden, her kaldırma denemesinden sonra değişmediği** iddia edilir.

**Ve bir dördüncü, dürüstlük gereği:** havuz ücreti sıfır olduğu için pozisyona ücret **birikmez** — ama `PoolManager.donate` izinsizdir ve hook'un `beforeDonate` bayrağı yoktur, yani **arcpad havuzuna yapılan bir bağış aralıktaki likiditeye kredilenir ve tahsil edilemez, yani yakılır.** Bu bir açık hücredir, kaydedilir, ve kapatılmaz (kapatmak `BEFORE_DONATE_FLAG` demekti, o da hook adresini değiştirmek demekti).

- [ ] **Adım 1: Başarısız testleri yaz**

```solidity
// ---------- MUTLU YOL, IKI SIRALAMADA ----------

/// Testnet profili, tek alimla tamamlanma, token USDC'nin USTUNDE (%79 hal).
function test_graduationSeedsThePoolAtTheCurveClosingPrice() public {
    (address token, address curve) = _launchAndBuyOut();
    locker.graduate(curve);
    (PoolKey memory key, bool baseIsCurrency0) = GraduationMath.poolKey(token, IHooks(address(hook)));
    (uint160 sqrtPrice,,,) = StateLibrary.getSlot0(poolManager, key.toId());
    assertFalse(baseIsCurrency0);
    assertEq(sqrtPrice, 326777965518061118072680912817470217035);
}

/// %21 hal. Token'i USDC'nin ALTINA dusurmek icin `predictAddresses` ile
/// aday metadata TARANIR. DONGU SINIRLI VE BULAMAZSA TEST BASARISIZ OLUR --
/// aksi halde test hicbir sey kanitlamadan gecerdi.
function test_graduationWorksWhenTheTokenSortsBelowUsdc() public {
    string memory name;
    bool found;
    for (uint256 i = 0; i < 64; ++i) {
        name = string.concat("ARC", vm.toString(i));
        (address predicted,) = factory.predictAddresses(creator, name, "ARC", "ipfs://cid", factory.launchCount());
        if (predicted < GraduationMath.QUOTE) { found = true; break; }
    }
    assertTrue(found, "no candidate sorted below USDC in 64 tries -- test proves nothing");
    // ...launch, buy out, graduate, ve
    assertEq(sqrtPrice, 19209072819323074681);
}

/// %21 orani BIR OLCUMDUR, bir tahmin degil: 0x36/0x100 = %21,09375.
/// 512 launch'ta 108 +- makul bir sapma beklenir; test yalnizca IKI
/// SIRALAMANIN DA GERCEKLESTIGINI iddia eder -- kesin sayi degil, cunku
/// kesin sayi keccak'a baglidir ve kirilgan bir test olurdu.
function test_bothOrderingsOccurAcrossManyLaunches() public {
    uint256 below;
    for (uint256 i = 0; i < 512; ++i) { /* predictAddresses, say */ }
    assertGt(below, 0);
    assertLt(below, 512);
    // ve orani rapora yaz: beklenen ~108
}

/// Havuza giden miktarlar TAM OLARAK curve'un odedigi (D, R6). Toz iddiasi
/// ELLE TURETILMIS literaldir (Global Kisitlar tablosu).
function test_theSeededAmountsAndTheDustAreExact() public {
    // testnet, USDC = currency0:
    //   L      = 50160046734639668
    //   need0  = 12_161_433                       (quote, TAM)
    //   need1  = 206886004951652435372724920      (base)
    //   dust1  = 6_231_944_955_121_217_298 wei    (= 6,2319 token)
    assertEq(liquidity, 50160046734639668);
    assertEq(IERC20(token).balanceOf(address(locker)), 6_231_944_955_121_217_298);
}

/// QUOTE ARTIGI: R - R6*1e12 wei locker'da KALICI kalir, cunku 1 ERC-20
/// biriminin altindadir ve locker'in native gonderme yolu YOKTUR.
///   testnet: 12_161_433_369_060_378_707 - 12_161_433 * 1e12 = 369_060_378_707
function test_theSubUnitQuoteResidueStaysInTheLockerForever() public {
    assertEq(address(locker).balance, 369_060_378_707);
}

/// Ve artik BIRIKIR ama hicbir zaman sonraki bir launch'a ATANAMAZ, cunku
/// locker kendi bakiyesini HIC OKUMAZ. Iki graduation ust uste:
function test_theResidueAccumulatesAndNeverLeaksIntoALaterLaunch() public {
    // ikinci launch'in tohumu yine TAM OLARAK (D, R6) olmali
}

// ---------- INVARIANT 6, ZINCIRDEN GERI OKUMA ----------

/// Yerel bir degiskenden DEGIL, PoolManager'in kendi durumundan okunur.
/// Oldurdugu mutant: "dogru hesapladi, initialize'a baskasini gecirdi".
function test_theOnChainSqrtPriceEqualsTheValueDerivedFromTheCurvesOwnGetters() public {
    (address token, address curve) = _launchAndBuyOut();
    uint256 vq = IGraduatableCurve(curve).virtualQuoteReserves();
    uint256 vt = IGraduatableCurve(curve).virtualTokenReserves();
    locker.graduate(curve);
    (, bool baseIsCurrency0) = GraduationMath.poolKey(token, IHooks(address(hook)));
    (uint160 onChain,,,) = StateLibrary.getSlot0(poolManager, poolId);
    assertEq(onChain, GraduationMath.sqrtPriceX96(vq, vt, baseIsCurrency0));
}

/// IKI ALIMLA tamamlanan bir curve DAHA YUKSEK bir fiyatta acar, cunku
/// quoteBuyCost'un +1'i her alimda birikir. SABIT YAZILMIS BIR
/// sqrtPriceX96 BU TESTTE OLUR -- ve tek-alim testleri onu GORMEZ.
function test_aTwoBuyCompletionOpensAtAStrictlyHigherPrice() public {
    uint160 oneBuy = _graduateWithOneBuy();
    uint160 twoBuys = _graduateWithTwoBuys();
    assertGt(twoBuys, oneBuy);   // USDC = currency0 siralamasinda
}

/// +1 TASIYICI. Bugun bu testi YAPAN BIR SEY YOK; buraya yaziliyor.
/// `quoteBuyCost`taki `+1` `mulDivRoundingUp`a sadelestirilirse tam bolunen
/// durumda R bir birim AZALIR ve R/D ile P_final arasindaki farkin YONU
/// TERSINE DONER (olculdu, iki profilde de). Havuzun acilis fiyati
/// P_final'in ALTINA duser -- protokolun aleyhine.
function test_theUnconditionalPlusOneKeepsTheSeededRatioAboveTheClosingPrice() public {
    // testnet: R/D * 1e36 = 58_783_256_052_377_201_525_947_110_211
    //          P_final*1e36 = 58_783_256_052_377_201_525_544_837_441
    assertGt(_ratioX36(R, D), _pFinalX36(Vq, Vt));
}

// ---------- POZISYON KALICILIGI ----------

function test_callingUnlockCallbackDirectlyRevertsNotPoolManager() public {
    vm.prank(attacker);
    vm.expectRevert(ArcpadLocker.NotPoolManager.selector);
    locker.unlockCallback("");
}

/// Saldirganin kendi `unlock`u locker'in callback'ini HIC CAGIRMAZ:
/// PoolManager `IUnlockCallback(msg.sender)` cagirir.
function test_anAttackersUnlockCannotReachTheLockersCallback() public { ... }

/// Likidite, her aktorun her kaldirma denemesinden SONRA degismez.
function test_theSeededLiquidityIsUnchangedAfterEveryRemovalAttempt() public { ... }

/// Bagis aralikta likiditeye kredilenir ve TAHSIL EDILEMEZ -- yani yakilir.
/// ACIK HUCRE olarak kaydedilir; kapatmak BEFORE_DONATE_FLAG demekti, o da
/// hook adresini degistirmek demekti.
function test_aDonationToThePoolIsCreditedAndCanNeverBeCollected() public { ... }

// ---------- ARIZA MODELI ----------

function test_aSecondGraduateOnTheSameCurveRevertsAlreadyGraduated() public { ... }
function test_graduateOnAnIncompleteCurveRevertsNotComplete() public { ... }
function test_graduateOnACurveFromAnotherFactoryReverts() public { ... }

/// initialize revert ederse ISLEMIN TAMAMI geri alinir: curve `graduated`
/// FALSE, `R` ve `D` curve'de, ve duzeltmeden sonra YENIDEN DENEME BASARIR.
/// Bu, "bozuk hedef bir launch'i strand edemez" iddiasinin YARISI; obur
/// yarisi yeniden denemenin BASARMASIDIR ve o da burada iddia edilir.
function test_ifInitializeRevertsTheCurveIsUntouchedAndARetrySucceeds() public { ... }

/// Havuz ONCEDEN VARSA. Hook bunu engelledigi icin YAPISAL OLARAK
/// ULASILAMAZ -- ama hook'un korumasi silinirse ulasilir hale gelir, ve o
/// zaman launch `graduated = false` ile SONSUZA KADAR mezun olamaz.
/// Test, hook korumasi kaldirilmis bir kurguyla o durumu KURAR ve
/// gorunur oldugunu kanitlar.
function test_aPreExistingPoolBricksTheLaunchAndOnlyTheHookPreventsIt() public { ... }

/// Locker BLOKLU bir adres olsa curve'un native push'u revert ederdi.
/// Arc testnet'in tohumladigi adres: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
/// Yerel EVM'de bloklama YOKTUR, dolayisiyla bu test Task 8'e aittir ve
/// burada YALNIZCA `receive()`in ciplak oldugu iddia edilir.
function test_receiveIsABareAcceptAndDoesNothingElse() public { ... }
```

**Gövdesi yukarıda açılmayan her testin iddia sözleşmesi — yazılacak `assert`'lerin tam listesi:**

| test | tam iddia |
|---|---|
| `..ResidueAccumulates..` | İki launch üst üste mezun edilir. İkinci graduation'dan sonra `PoolSeeded.quoteSeeded == 12_161_433_369_060_378_707` (**birinciyle aynı**), ikinci havuzun `L`'si `50160046734639668` (**birinciyle aynı**), ve `address(locker).balance == 2 · 369_060_378_707 = 738_120_757_414` |
| `..AttackersUnlock..` | Saldırganın `IUnlockCallback` uygulayan kontratı `poolManager.unlock(data)` çağırır; `vm.recordLogs()` ile locker'dan **hiçbir log çıkmadığı** ve locker'ın pozisyon likiditesinin **değişmediği** iddia edilir |
| `..LiquidityUnchanged..` | `getPositionInfo(id, locker, ±887220, 0)` başlangıç değeri kaydedilir; sonra sırayla: creator, rastgele bir EOA, `SwapHarness`, ve locker'ın **kendisi** `poolManager.modifyLiquidity(key, {…, liquidityDelta: -int256(uint256(L))}, "")` dener → **dördü de revert eder** (`ManagerLocked` ya da `CurrencyNotSettled`); her denemeden sonra likidite **aynı** |
| `..DonationBurned..` | `poolManager.unlock` içinden `donate(key, 1_000_000, 0)`; `getPositionInfo`'nun `feeGrowthInside0LastX128`'i **artar**; sonra locker'ın hiçbir dış fonksiyonu o krediyi tahsil edemez (ABI'de `modifyLiquidity`'ye erişen yol yok) → **yakıldı**. Açık hücre olarak raporlanır |
| `..SecondGraduate..` | `locker.graduate(curve)` iki kez; ikinci çağrı iç selector `AlreadyGraduated()` |
| `..IncompleteCurve..` | Satış arzının yarısı alınmış bir curve; iç selector `NotComplete()` |
| `..CurveFromAnotherFactory..` | İkinci bir `LaunchFactory` ile launch edilmiş curve; `CurveNotFromFactory()` |
| `..InitializeRevertsRetrySucceeds..` | Hook'un `_beforeInitialize`'ı ilk çağrıda revert edecek şekilde `vm.mockCallRevert` ile kurulur. `graduate` revert eder; sonra `curve.graduated() == false`, `curve.realQuoteReserves() == R`, `IERC20(token).balanceOf(curve) == N − S`, `address(locker).balance == 0`, `IERC20(token).balanceOf(locker) == 0`. `vm.clearMockedCalls()`; `graduate` yeniden çağrılır → **başarır** ve `PoolSeeded` yayınlanır |
| `..PreExistingPoolBricks..` | Hook'un hedef kontrolü `vm.mockCall` ile saldırgana da izin verecek şekilde kurulur; saldırgan anahtarı `sqrtPrice + 1000` ile açar; sonra `graduate` `PoolAlreadyInitialized` ile revert eder; **ve yeniden deneme de revert eder** (`curve.graduated() == false` kalır ama ilerleme imkânsızdır). Mock kaldırıldığında saldırganın açılışı **reddedilir** — yani hook tek korumadır |
| `..ReceiveIsBare..` | `address(locker).call{value: 1}("")` başarır; `vm.recordLogs()` **sıfır** log; ve locker'ın hiçbir storage slot'u değişmez (`vm.load` ile slot 0–3 karşılaştırması) |

- [ ] **Adım 2: `ArcpadLocker`'ı yaz**

```solidity
/// @title ArcpadLocker
/// @notice Graduation hedefi. Curve'un odemesini alir, havuzu curve'un
///         kapanis fiyatinda acar, tam aralik likidite ekler ve pozisyonu
///         KALICI kilar -- cikarma yolu YAZILMAMISTIR.
///
/// @dev BU KONTRAT KENDI BAKIYESINI HIC OKUMAZ. Arc'ta ucuncu bir taraf
///      hem native hem ERC-20 bakiyesini, bu kontratta hicbir kod
///      calistirmadan sisirebilir (`FeeEscrow` kisiti (1), canli olcum).
///      Tohumlanan miktarlar YALNIZCA `curve.graduate()`in donus
///      degerlerinden gelir. Curve tarafinin D6 karari ile ayni disiplin.
contract ArcpadLocker is IUnlockCallback {
    using StateLibrary for IPoolManager;
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;
    address public immutable factory;
    IHooks public immutable hook;

    /// @dev SPEC §5.6 ADIM 7'DEKI OLAY `Graduated` DEGIL `PoolSeeded`'DIR.
    ///      Curve zaten `Graduated(address,address,uint256,uint256)` yayiyor;
    ///      ayni isimde iki olay bir INDEXER TUZAGIDIR -- topic0'lar farkli
    ///      oldugu icin birine gore yazilmis bir filtre oburu icin sessizce
    ///      BOS doner. Graduation yuzeyi tasarimi bu ismi ayrica kayda gecti.
    event PoolSeeded(
        address indexed token,
        address indexed curve,
        PoolId indexed poolId,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        uint256 baseSeeded,
        uint256 quoteSeeded
    );

    error NotPoolManager();
    error CurveNotFromFactory();
    error UnexpectedCredit();
    error SeedShortfall();
    error ZeroLiquidity();
    error PoolPriceMismatch();
    error PositionNotSeeded();

    /// @notice CIPLAK KABUL, ve baska hicbir sey.
    /// @dev Curve `target.call{value: R}("")` ile oder, yani bu gereklidir.
    ///      Govdesi BOS OLMAK ZORUNDA: bu fonksiyon curve'un cagri
    ///      cercevesinde, locker'in kendi durum makinesi ORTA YERDEYKEN
    ///      calisir. `FeeEscrow` kisiti (2) tam olarak bu tehlikeyi
    ///      kaydetmisti ve escrow onu icinden duzeltemedi; curve de
    ///      duzeltemez. Tek koruma bu govdenin bos olmasidir.
    receive() external payable {}

    /// @notice Tamamlanmis bir curve'u mezun eder. IZINSIZ.
    /// @dev pump.fun'in `migrate_v2`si izinsizdir ve arcpad o ozelligi
    ///      BURADA yeniden uretir: curve tarafinda yalnizca hedef
    ///      cagirabilir, ama hedefin kendi giris noktasi herkese aciktir.
    ///      Ucten uca graduation izinsiz kalir.
    /// @dev BU FONKSIYON ISI TEK ISLEMDE BITIRIR VE HER BASARISIZLIKTA
    ///      REVERT EDER. Graduation yuzeyi §4.2'nin birinci yukumlulugu
    ///      budur ve karsilanmasi, curve tarafi atomikligini havuz
    ///      olusturmaya kadar BEDAVA genisletir: ya havuz vardir ya hicbir
    ///      sey hareket etmemistir. try/catch YOKTUR ve olmamalidir.
    function graduate(address curve) external {
        address token = IGraduatableCurve(curve).token();
        // Curve'un bu factory'den geldigi, TOKEN uzerinden dogrulanir --
        // hook'un kullandigi ayni sabit-gazli kanit.
        if (ILaunchFactoryFeeSchedule(factory).feeScheduleOf(token) == address(0)) {
            revert CurveNotFromFactory();
        }

        // --- 1. ODEMEYI CEK. Curve `graduated`i BUNUN ICINDE latch eder. ---
        (uint256 baseAmount, uint256 quoteAmount) = IGraduatableCurve(curve).graduate();

        // --- 2. FIYAT. Curve'un getter'larindan, SABITTEN DEGIL. `graduate()`
        //        sanal rezervleri MUTASYONA UGRATMAZ (yuzey tasarimi §1.3). ---
        (PoolKey memory key, bool baseIsCurrency0) = GraduationMath.poolKey(token, hook);
        uint160 sqrtPriceX96 = GraduationMath.sqrtPriceX96(
            IGraduatableCurve(curve).virtualQuoteReserves(),
            IGraduatableCurve(curve).virtualTokenReserves(),
            baseIsCurrency0
        );

        // --- 3. 10^12 SINIRI, TEK GECIS. ---
        uint256 quoteUnits = GraduationMath.quoteUnits(quoteAmount);
        (uint256 have0, uint256 have1) =
            baseIsCurrency0 ? (baseAmount, quoteUnits) : (quoteUnits, baseAmount);

        // --- 4. HAVUZ. `initialize` kilidin DISINDA: modifier'lari
        //        `noDelegateCall`dir, `onlyWhenUnlocked` DEGIL. Kilidin
        //        icinde de calisirdi; atomiklik ISLEM sinirindan gelir. ---
        poolManager.initialize(key, sqrtPriceX96);

        uint128 liquidity = GraduationMath.seedLiquidity(sqrtPriceX96, have0, have1);
        if (liquidity == 0) revert ZeroLiquidity();

        poolManager.unlock(abi.encode(key, liquidity, have0, have1));

        // --- 5. GERI OKUMA. YEREL DEGISKENDEN DEGIL, PoolManager'IN KENDI
        //        DURUMUNDAN. "Odemeyi aldi ama havuz yok" durumunu
        //        TEMSIL EDILEMEZ kilan sey budur: bu cerceveden basariyla
        //        cikmanin tek yolu canli ve fonlanmis bir havuzdur. ---
        PoolId id = key.toId();
        (uint160 actual,,,) = poolManager.getSlot0(id);
        if (actual != sqrtPriceX96) revert PoolPriceMismatch();
        (uint128 seeded,,) = poolManager.getPositionInfo(
            id, address(this), GraduationMath.TICK_LOWER, GraduationMath.TICK_UPPER, bytes32(0)
        );
        if (seeded != liquidity) revert PositionNotSeeded();

        emit PoolSeeded(token, curve, id, sqrtPriceX96, liquidity, baseAmount, quoteAmount);
    }

    /// @dev Yalnizca `PoolManager` cagirabilir, VE yalnizca bu kontratin
    ///      kendi `unlock` cagrisi tetikleyebilir: `PoolManager.unlock`
    ///      `IUnlockCallback(msg.sender).unlockCallback(data)` cagirir, yani
    ///      bir saldirganin `unlock`u BU callback'i hic calistirmaz.
    ///      `msg.sender` kontrolu ve o yapisal olgu birlikte, negatif
    ///      likiditeye giden HICBIR yol olmadigini verir.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint128 liquidity, uint256 have0, uint256 have1) =
            abi.decode(data, (PoolKey, uint128, uint256, uint256));

        // `salt: bytes32(0)`: pozisyon zaten `poolId` ile ad alanina
        // alinmistir, salt hicbir sey eklemez. `hookData: ""`: hook'un
        // likidite bayragi YOKTUR, dolayisiyla hic cagrilmaz.
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: GraduationMath.TICK_LOWER,
                tickUpper: GraduationMath.TICK_UPPER,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Likidite EKLERKEN iki bacak da NEGATIF olmak zorunda. Pozitif bir
        // delta, havuzun beklenmedik bir durumda oldugu anlamina gelir.
        if (delta.amount0() > 0 || delta.amount1() > 0) revert UnexpectedCredit();
        uint256 owed0 = uint256(int256(-delta.amount0()));
        uint256 owed1 = uint256(int256(-delta.amount1()));

        // ACIK KONTROL, ve gerekcesi TESHIS: `getLiquidityForAmounts` ASAGI,
        // `Pool.modifyLiquidity` YUKARI yuvarlar, yani bacak basina 1 wei
        // tasma teorik olarak mumkundur (dort kanonik durumda OLCULDU: yok).
        // Bu kontrol olmasa ariza `SafeERC20`nin icinde, hangi katmanin
        // yetersiz kaldigini soylemeyen bir revert olarak gorunurdu.
        if (owed0 > have0 || owed1 > have1) revert SeedShortfall();

        // sync -> transfer -> settle, ikisi de ERC-20. NATIVE KOD YOLU YOK.
        key.currency0.settle(poolManager, address(this), owed0, false);
        key.currency1.settle(poolManager, address(this), owed1, false);
        return "";
    }
}
```

> **`SeedShortfall` bugün öldürülemez bir mutant olabilir** ve bu beklenen bir sonuçtur. Adım 4, factory'nin kabul ettiği `V` bandında fuzz ile onu tetikleyen bir girdi **aramak** zorundadır. 5000 koşuda bulunamazsa, `BondingCurve`'ün `!ok` dallarıyla **aynı sınıfta** eşdeğer bir mutant olarak, gerekçesiyle rapora yazılır.

> **`CurrencySettler.settle` (`uniswap-hooks/utils/`) `SafeERC20` kullanır ve native bacak için `sync` + `settle{value:}` yapar.** arcpad'in iki bacağı da ERC-20 olduğu için native dal **hiç çalışmaz** — ve bu, `address(0)`'ın anahtara girmemesinin somut karşılığıdır. Bir test, graduation işleminin tamamında `settle{value:}` yolunun hiç kullanılmadığını (hook'un `NonzeroNativeValue` hatası hiç görünmediğini) iddia eder.

- [ ] **Adım 3: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --match-path 'test/ArcpadLocker.t.sol' -vv
FOUNDRY_PROFILE=ci forge test --root contracts --no-match-path 'test/fork/*'
```

- [ ] **Adım 4: Mutasyonla doğrula**

| Mutasyon | Ölmesi gereken test |
|---|---|
| `sqrtPriceX96`'yı sabit literal yap (tek-alım değeri) | `test_aTwoBuyCompletionOpensAtAStrictlyHigherPrice` |
| `baseIsCurrency0`'ı `seedLiquidity`'ye taşımayı unut (`have0`/`have1` takas) | tohum miktarı ve toz testleri |
| `quoteUnits(quoteAmount)` → `quoteAmount` | `test_theSeededAmountsAndTheDustAreExact` |
| Geri okuma kontrollerini kaldır (`PoolPriceMismatch`, `PositionNotSeeded`) | **ölç ve raporla** — bugün öldürülemez olabilirler; öyleyse gerekçesi §Arıza modelindedir |
| `if (msg.sender != address(poolManager))` kaldır | `test_callingUnlockCallbackDirectlyRevertsNotPoolManager` |
| `liquidityDelta` işaretini ters çevir | `test_theSeededLiquidityIsUnchangedAfterEveryRemovalAttempt` (ve `modifyLiquidity` revert eder) |
| `TICK_LOWER`/`TICK_UPPER` → `±887272` (tickSpacing 60 ile geçersiz) | `modifyLiquidity` `TickMisaligned` ile revert eder |
| `salt: bytes32(0)` → `bytes32(uint256(1))` | geri okuma (`getPositionInfo` sıfır döner) → `PositionNotSeeded` |
| `graduate()` çağrısını havuz kurulumundan **sonra**ya taşı | derlenmez (`baseAmount` yok) — mutasyon **geçersiz**, raporla |
| `unlock` çağrısını `try/catch` ile sar | `test_ifInitializeRevertsTheCurveIsUntouchedAndARetrySucceeds` — **bu, accept-then-fail'i geri getiren mutasyondur ve ölmesi ZORUNLUDUR** |
| Bir `withdraw()` fonksiyonu ekle | Task 6'nın ABI yüzey testi |

- [ ] **Adım 5: Commit**

```bash
git commit -m "feat(contracts): seed the graduation pool at the curve's closing price and never write a withdraw path"
```

---

### Task 6: Arıza modeli, invariant paketi ve ABI yüzeyi

**Files:**
- Create: `contracts/test/invariant/GraduationHandler.sol`
- Create: `contracts/test/invariant/PoolSeedInvariants.t.sol`
- Modify: `contracts/test/Surface.t.sol`

#### Arıza modeli — her satırın bir testi var, ve bir satırın yok

| # | Arıza | Ne olur | Kurtarma | Test |
|---|---|---|---|---|
| F1 | `initialize` revert eder | İşlemin tamamı geri alınır. `graduated` **false**, `R` ve `D` curve'de, hiçbir şey hareket etmemiş | **Yeniden deneme.** Hatayı düzelt, yeni locker deploy et, `propose`+`apply`, `graduate` yeniden çağrılır ve **başarır** | `test_ifInitializeRevertsTheCurveIsUntouchedAndARetrySucceeds` |
| F2 | Havuz **önceden var** | `PoolAlreadyInitialized`. F1 ile aynı unwind — ama yeniden deneme **hiçbir zaman başarmaz**: launch kalıcı olarak tuğlalaşır, curve fonları elinde tutar | **Yok.** Tek koruma hook'un `beforeInitialize`'ıdır | `test_aPreExistingPoolBricksTheLaunchAndOnlyTheHookPreventsIt` |
| F3 | `modifyLiquidity` revert eder (tick hizası, likidite tavanı, `SeedShortfall`) | F1 ile aynı | Yeniden deneme | mutasyon tablosu, Task 5 |
| F4 | `settle` yetersiz bakiye yüzünden revert eder | F1 ile aynı; `SeedShortfall` bunu **önce** ve **adıyla** yakalar | Yeniden deneme | `SeedShortfall` fuzz'ı |
| F5 | Hedef **uçuş sırasında** yeniden yönlendirilir | **İmkânsız.** Curve hedefi `graduate()` **anında** okur ve hook aynı işlemde aynı factory'den okur; tek işlem içinde değişemez | — | `test_swapsKeepWorkingAfterTheGraduationTargetIsRepointed` |
| F6 | Hedef, tamamlanmış ama mezun olmamış bir curve varken değişir | Curve **yeni** hedefe mezun olur. Göç yok, kayıt yok, kayıp yok | Otomatik | `test_aCurveThatCompletedUnderTheOldTargetGraduatesToTheNewOne` |
| F7 | Hedef, **mezun olmuş** bir curve varken değişir | Hiçbir şey. O havuz eski locker'ın pozisyonunu taşır ve çalışmaya devam eder (`beforeSwap` hedefe **bakmaz**) | Gerekmez | `test_aGraduatedCurveIsUnaffectedByARepoint` |
| F8 | **LP yakması başarısız olur** | **Böyle bir çağrı yoktur.** "Yakma", negatif `liquidityDelta` çağıran kodun **hiç yazılmamış** olmasıdır; başarısız olabilecek bir adım mevcut değil | Kavramsal olarak yok | ABI yüzey testi + üç katman, Task 5 |
| F9 | Locker **bloklu** bir adres olur | Curve'ün native push'u revert eder, gaz yine tüketilir. Curve sağlam kalır | **Yeniden yönlendirme.** D3'ün üçüncü, bağımsız gerekçesi | Task 8 (yerel EVM'de bloklama yok) |
| F10 | Ücret alıcısı (treasury/creator) bloklu olur | Escrow **pull-based** olduğu için swap'i etkilemez; yalnızca o alıcının çekmesi revert eder | Escrow'un mevcut tasarımı | Task 8 |
| F11 | `poolManager` adresi **yanlış veya düşman** | Geri okuma yalan söyler. Locker "başarılı" döner, havuz yoktur, `graduated` latch'lidir | **Yok.** Bkz. aşağıda | prosedür, test değil |
| F12 | **Accept-then-fail** — locker ödemeyi alır, havuzu açamaz, ve yine de başarıyla döner | Curve ödemiş, havuz yok, `graduated` monoton | **Yok — ve bu yüzden TEMSIL EDILEMEZ kılınmıştır** | aşağıdaki üç mekanizma |

#### Accept-then-fail: cevap

Bu fazın en keskin sorusu, ve cevabı bir kurtarma mekanizması **değil**, bir imkânsızlık argümanıdır. Üç mekanizma, artan güçte:

1. **`graduate(address curve)` işi tek işlemde bitirir ve `try/catch` içermez.** Herhangi bir adım revert ederse `graduated = true` yazımı da, token transferi de, native push da aynı unwind'de geri alınır. Curve tarafı atomikliği böylece **havuz oluşturmaya kadar bedava genişler**: ya havuz vardır ya hiçbir şey hareket etmemiştir. Task 5'in mutasyon tablosundaki `unlock`'u `try/catch` ile sarma mutasyonu **tam olarak accept-then-fail'i geri getirir ve ölmesi zorunludur.**
2. **Fonksiyon, `PoolManager`'ın KENDİ durumundan geri okumayla biter** — yerel bir değişkenden değil. `getSlot0(id).sqrtPriceX96 == sqrtPriceX96` ve `getPositionInfo(...) == liquidity`. Bu, "ödemeyi aldı ama havuz yok" durumunu **temsil edilemez** kılar: bu çerçeveden **başarıyla çıkmanın tek yolu** canlı ve fonlanmış bir havuzdur. Bir hata bile o iki okumayı geçemez, çünkü okumalar hesaplanan değeri değil **kaydedilen** değeri sorgular.
3. **Bir `retrySeed(curve)` / `seedFromHeld(curve)` giriş noktası DELİBERE OLARAK YOKTUR.** Yazmak çekiciydi ve tasarımı savunulabilirdi (parametresi yok — `PoolKey`'in tamamı curve'den türetilir, yani saldırgan düşman bir havuz seçemez). **Reddedilme sebebi:** (1) ve (2) verildiğinde **ulaşılamazdır** — yani bu deponun açıkça yasakladığı **öldürülemez bir mutant**, mutasyon koşusunun "kapsandı" diye raporladığı ölü kod. Ve daha kötüsü: atomikliği bozan bir gelecek değişiklik karşısında **yanlış çare** olurdu. Doğru çare atomikliği geri getirmektir; `retrySeed` onun yerine geçerek arızayı **kalıcı hâle getirirdi**.

**Ve şimdi kapanmayan kısım, açıkça:** yukarıdakiler *bu* locker'ın accept-then-fail'e girmesini engeller. **Zaten mezun olmuş bir curve'ü kurtaran hiçbir şey yoktur.** `graduated` monotondur, varlıklar eski locker'dadır, ve yeniden yönlendirme **yalnızca gelecekteki** curve'leri kurtarır. Bu yüzden:

> **R-12 bir prosedürdür, bir test değil, ve test onun yerine geçemez.** `applyGraduationTarget`, bir locker'a **yalnızca** şu döngü Arc testnet'te o locker'a karşı fiilen çalıştırıldıktan sonra çağrılabilir: launch → satış arzını tüket → `graduate` → havuz var ve pozisyon fonlanmış (Task 8). 3 günlük gecikme bu prosedürü **gözlemlenebilir** kılar: `GraduationTargetProposed` yayınlanır, ve `apply`'a kadar geçen 3 gün, prosedürün yapıldığını herkesin doğrulayabileceği penceredir. F11 de aynı prosedürle kapanır — düşman bir `poolManager` adresi, tam bir döngüden geçemez.

#### Invariant'lar

Handler, rastgele `launch → alım dizisi → graduate → havuzda swap` dizileri koşar. **Handler'ın içinde assertion çağrılmaz** — forge-std'nin assertion'ları revert eder ve `fail_on_revert = false` bunları sessizce yutar. Ghost sayaç artırılır, `invariant_` içinde sıfır olduğu iddia edilir. **Aktör kümesi hem kodlu hem kodsuz adres içermek zorundadır** (Faz 1b'nin dersi).

| Invariant | Neyi korur | Onu kıran mutasyon |
|---|---|---|
| `invariant_poolPriceAlwaysEqualsTheCurveClosingPrice` | **Spec §10 invariant 6.** Her mezun curve için, zincirdeki `sqrtPriceX96` o curve'ün getter'larından türetilen değere eşit | sabit `sqrtPriceX96` |
| `invariant_noPoolKeyEverContainsTheZeroAddress` | Sessiz USDC-vs-USDC havuzu | `ZeroBase` kontrolünü kaldır |
| `invariant_currenciesAreAlwaysStrictlyOrdered` | %21 hatası | `baseIsCurrency0 = false` |
| `invariant_seededLiquidityNeverDecreases` | Kalıcılık | negatif `liquidityDelta` yolu ekle |
| `invariant_lockerNeverHoldsMoreQuoteThanTheAccumulatedResidue` | 10¹² artığının sızmadığı | `quoteUnits` → kimlik |
| `invariant_everyGraduatedCurveHasExactlyOnePool` | Çift tohumlama | `graduated` kontrolünü kaldır |
| `invariant_graduatedWasNeverUnset` | Ghost sayaç | — |
| `invariant_hookFeeIsAlwaysDenominatedInQuote` | Ghost sayaç: token cinsinden ücret alındıysa artar | `_afterSwap`'i sıfırla |
| `invariant_graduationsPerformed > 0` | **Handler'ın `graduate()`'e gerçekten ulaştığı** | — |

**Son satır bir invariant gibi görünmüyor ve öyle olması gerekiyor.** Faz 1c'nin R-3'ü şunu kaydetti: `graduate()`'e ulaşamayan bir handler tüm graduation invariant'larını **yeşil** bırakır ve paket tam kapsama bildirir. **Ulaşamayan bir handler geçen bir paket değil, başarısız bir pakettir.**

- [ ] **Adım 1: Handler ve invariant'ları yaz, sonra HER BIRINI mutasyonla kanıtla**

Geçen bir invariant, kısıtlayan bir invariant demek değildir. **Her invariant için onu kıran en az bir mutasyon kaydedilmeli.** Bir mutasyon hiçbirini kırmıyorsa bu bir boşluktur ve **bildirilir**.

- [ ] **Adım 2: Mutant SEÇİMİ boşluğunu ara — kapsama boşluğunu değil**

Deponun ikinci adlandırılmış arıza kipi: *boşluk mutant seçimindedir.* Sorulacak soru "hangi hücreden test geçmiyor" değil, **"hangi SATIRI hiçbir mutant hedeflemiyor"**dur. Bu fazın en olası cevapsız satırları, ve her biri için zorunlu bir mutasyon:

| Hiçbir mutantın hedeflemediği satır | Zorunlu mutasyon |
|---|---|
| `GraduationMath.SQRT_UPPER` sabiti | son basamağı değiştir |
| `PoolKey.tickSpacing` alanı | `60` → `10` |
| `ModifyLiquidityParams.salt` alanı | `bytes32(0)` → `bytes32(uint256(1))` |
| `CurrencySettler.settle`'ın `burn = false` argümanı | `true` |
| `getPositionInfo`'nun `owner` argümanı | `address(this)` → `msg.sender` |
| `_beforeInitialize`'ın **dönüş selector'ü** | `IHooks.beforeInitialize.selector` → `bytes4(0)` |
| `FeeSchedule`'ın `CREATOR_BPS_11M_20M` lane sırası | tersine çevir |
| `quoteBuyCost`'un `+1`'i (**`CurveMath`, bu fazda değişmez**) | `mulDivRoundingUp`'a sadeleştir |

**Son satır özel olarak önemlidir.** `+1` `CurveMath`'in NatSpec'inde **taşıyıcı** olarak işaretlidir ama **bugün onu koruyan bir test yoktur** — bağış testleri görmez (dönen değerler yine tam `(D, R)`'dir; değişen şey **oranın kendisidir**). Task 5'in `test_theUnconditionalPlusOneKeepsTheSeededRatioAboveTheClosingPrice`'ı o boşluğu kapatan tek şeydir ve bu mutasyon onun ölçümüdür.

- [ ] **Adım 3: ABI yüzey testini genişlet**

`Surface.t.sol`, `GraduationMath` hariç dört yeni kontratı kapsar (kütüphane `internal`dır, ABI yüzeyi yoktur). **İki yönlü küme eşitliği zorunludur** — yalnızca "beklenenlerin hepsi duruyor mu" diye bakan bir test **eklenmiş** bir fonksiyonu göremez, ki bütün mesele odur.

Pinlenecekler:

- `ArcpadLocker`: dış fonksiyonlar tam olarak `{graduate, unlockCallback, poolManager, factory, hook}`; ABI girdi türleri tam olarak **bir `receive`, sıfır `fallback`**; ve **`int256`/`int128` parametresi alan hiçbir dış fonksiyon yok** (negatif likiditeye giden bir yolun en ucuz negatif göstergesi).
- `ArcpadHook`: `{beforeInitialize, beforeSwap, afterSwap, configOf, poolManager, factory, escrow, protocolTreasury, getHookPermissions}` + `IHooks`'un `BaseHook` tarafından zorunlu kılınan geri kalanı (hepsi `HookNotImplemented` ile revert eder). **Sıfır `receive`, sıfır `fallback`** — Arc'ta ERC-20 transferi native bakiyeyi `receive()` çalıştırmadan kredilendirdiği için hook'a gerek yoktur.
- `FeeSchedule`: `{tierFor, marketCap, SUPPLY_CONSTANT, TIER_COUNT}`. **Setter yok, `receive` yok, depolama yok.**
- `BondingCurve`: mevcut kümeye `graduate`, `graduated` eklenir; `Graduated(address,address,uint256,uint256)` olayı `indexed:(token,to)` ile pinlenir. **`receive`/`fallback` yokluğu pini (5) DURMAYA DEVAM EDER.**
- `LaunchFactory`: `graduationTarget` **`view returns (address)`** olarak pinlenir, ve ayrıca **curve'ün runtime bytecode'unda `0xa4b20f13` selector'ünün göründüğü** iddia edilir. Gerekçe R-11'dir: factory o üyeyi yeniden adlandırırsa ya da `view`'den çıkarırsa, o factory'nin ürettiği **her** curve'ün graduation'ı bozulur — ve bu deploy sonrası düzeltilemez.
- **Olay adı çakışması:** `PoolSeeded`'in topic0'ının `Graduated`'in topic0'ına **eşit olmadığı** iddia edilir. Ucuz, kalıcı, ve graduation yüzeyi tasarımı bu testi R-10'da açıkça istedi.

- [ ] **Adım 4: `1e12`'nin tek yerde olduğunu kanıtla**

```bash
grep -rn "1e12\|10\*\*12\|1_000_000_000_000" contracts/src/
```

Beklenen: **tam olarak bir dosya**, `contracts/src/libraries/GraduationMath.sol`, ve orada **tam olarak bir tanım** (`QUOTE_SCALE`). Başka her isabet bir bulgudur.

- [ ] **Adım 5: Commit**

```bash
git commit -m "test(contracts): pin the graduation failure model, the seed invariants and the four new surfaces"
```

---

### Task 7: Arc testnet'e V4 ve arcpad deploy; mainnet geçişinin yapılandırma-only olduğunun kanıtı

**Files:**
- Create: `contracts/script/DeployV4.s.sol`
- Create: `contracts/script/DeployArcpad.s.sol`
- Create: `deployments/arc-testnet.json`
- Create: `contracts/test/ConfigurationOnly.t.sol`
- Modify: `contracts/foundry.toml` (yalnızca `fs_permissions`'a `./deployments`, **her iki profile de**)

#### Ne deploy edilmesi gerekiyor — ölçüldü, listeden kısa

**Yalnızca `PoolManager`.** Faz 2'nin tükettiği geri kalan her şey `internal` kütüphanedir ve arcpad'in kendi bytecode'una gömülür:

| Bağımlılık | Deploy gerekli mi | Neden |
|---|---|---|
| `PoolManager` | **Evet** | Tekil, durum tutar |
| `StateLibrary` | Hayır | `internal`, çağıranın içine gömülür |
| `LiquidityAmounts` | Hayır | `internal` |
| `CurrencySettler` | Hayır | `internal` |
| `TickMath`, `FullMath`, `SqrtPriceMath`, `Position`, `LPFeeLibrary`, `Hooks` | Hayır | `internal` |
| `HookMiner` | Hayır | **test ağacında** (`v4-periphery/test/shared/`), zincire hiç gitmez |
| `Permit2` | Hayır | Arc testnet'te **zaten var** (`0x000000000022D473030F116dDEE9F6B43aC78BA3`, 9.152 bayt, ölçüldü) |
| `PositionManager`, `UniversalRouter`, `StateView`, `V4Quoter` | **Hayır, bu fazda** | Hiçbiri graduation yolunda değil. `StateView` ve `V4Quoter` Faz 3'ün indexer'ı/frontend'i için **isteğe bağlı kolaylıktır** ve o fazda değerlendirilir |

`PoolManager`'ın constructor'ı `constructor(address initialOwner)`'dır ve owner **yalnızca protokol ücretini** kontrol eder (`ProtocolFees`). Varsayılan protokol ücreti **sıfırdır** ve arcpad onu sıfır bırakır; owner `governor`'a verilir. **Bir test bunu pinler:** deploy'dan sonra `poolManager.protocolFeesAccrued(...)` sıfır ve `PoolKey`'in protokol ücreti hiç ayarlanmamış.

#### Pinlenmiş ve yeniden üretilebilir

Deploy, **deterministik CREATE2 deployer** üzerinden yapılır (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, Arc testnet'te 69 bayt kod, ölçüldü; Arc dokümanı `CREATE2`'nin EIP-7610 dâhil "Ethereum'daki gibi" davrandığını söyler). Böylece adres `(initcode hash, salt)`'tan yeniden türetilebilir ve adres defteri **doğrulanabilir**, sadece bildirilmiş olmaz.

`deployments/arc-testnet.json`:

```json
{
  "chainId": 5042002,
  "rpc": "https://rpc.testnet.arc.io",
  "deployedAtBlock": 0,
  "arcpadCommit": "",
  "toolchain": { "solc": "0.8.26", "evmVersion": "cancun", "viaIr": true,
                 "optimizerRuns": 800, "bytecodeHash": "none" },
  "submodules": {
    "v4-core": "46c6834698c48bc4a463a86d8420f4eb1d7f3b75",
    "v4-periphery": "3245c3cb99c48fa1dc2459c3b60abc37d4294aba",
    "uniswap-hooks": "acbd604c409a827f7f98c9517236da860c4fca1a",
    "openzeppelin-contracts": "dbb6104ce834628e473d2173bbc9d47f81a9eec3",
    "forge-std": "bf647bd6046f2f7da30d0c2bf435e5c76a780c1b"
  },
  "contracts": {
    "usdc":        "0x3600000000000000000000000000000000000000",
    "permit2":     "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "create2":     "0x4e59b44847b379578588920cA78FbF26c0B4956C",
    "poolManager": { "address": "", "salt": "", "initCodeHash": "" },
    "feeSchedule": { "address": "", "salt": "", "initCodeHash": "" },
    "arcpadHook":  { "address": "", "salt": "", "initCodeHash": "", "flags": "0x20CC" },
    "arcpadLocker":{ "address": "", "salt": "", "initCodeHash": "" },
    "feeEscrow":   { "address": "" },
    "launchFactory":{ "address": "", "profile": "testnet" }
  }
}
```

**Deploy sırası bağlayıcıdır ve bir döngü içerir:**

```
1. PoolManager
2. FeeEscrow                     (Faz 1b)
3. FeeSchedule
4. LaunchFactory(escrow, treasury, T, V_testnet, S, feeSchedule, governor)
5. ArcpadHook  -- constructor'i (poolManager, factory, escrow, treasury) alir,
                  yani 1 ve 4'ten SONRA; salt burada MADENLENIR
6. ArcpadLocker(poolManager, factory, hook)
7. factory.proposeGraduationTarget(locker)
8. --- TASK 8'IN TAM DONGUSU, locker'a karsi ---
9. 3 gun sonra: factory.applyGraduationTarget()
```

**Adım 8, adım 9'un ön koşuludur ve bu R-12'nin prosedürüdür.** `applyGraduationTarget` çağrılmadan önce tam bir launch → satış arzını tüket → `graduate` → havuz var ve pozisyon fonlanmış döngüsü **o locker'a karşı** çalıştırılmış olmalıdır. Ama adım 7'den önce `graduationTarget` sıfırdır ve `graduate()` `GraduationTargetUnset()` ile döner — yani döngü *nasıl* çalıştırılır?

**Cevap: ikinci, atılabilir bir factory ile.** Adım 8, testnet profilinin aynısıyla deploy edilmiş **geçici bir `LaunchFactory`** kullanır, hedefi anında (kendi 3 gününü bekleyerek) locker'a yönlendirir, ve döngüyü orada koşar. Locker factory'ye bağlı **değildir** — `feeScheduleOf` kontrolünü *hangi* factory'ye sorduğu bir immutable'dır, dolayısıyla geçici factory için ikinci bir locker gerekir. **Bu, deploy prosedürünü iki locker'lı yapar** ve maliyeti gerçektir; alternatif, üretim factory'sini kanıtlanmamış bir locker'a yönlendirmektir ve o kabul edilemez. Prosedür rapora yazılır.

- [ ] **Adım 1: `DeployV4.s.sol`'ü yaz**

`PoolManager` adresi **hiçbir yere literal olarak yazılmaz**; script onu deploy eder ve JSON'a yazar. `DeployArcpad.s.sol` onu JSON'dan (`vm.readFile` + `vm.parseJson`) ya da `--sig` argümanından okur.

- [ ] **Adım 2: `ConfigurationOnly.t.sol`'ü yaz — mainnet geçişinin KANITI**

Bu testin varlık sebebi, spec §13'ün "risk değil, planlanan geçiş" iddiasını **iddia olmaktan çıkarıp ölçüme çevirmektir.**

```solidity
/// AYNI BYTECODE, IKI FARKLI PoolManager, IKI TAM GRADUATION. Kaynak
/// degisikligi SIFIR. Mainnet'te kanonik singleton'a gecmenin kod
/// degisikligi gerektirmedigi iddiasi BUDUR ve baska hicbir sey degildir.
function test_theSameLockerBytecodeWorksAgainstTwoDifferentPoolManagers() public {
    PoolManager pmA = new PoolManager(governor);
    PoolManager pmB = new PoolManager(governor);
    assertTrue(address(pmA) != address(pmB));

    (ArcpadHook hookA, ArcpadLocker lockerA) = _deployArcpadAgainst(pmA);
    (ArcpadHook hookB, ArcpadLocker lockerB) = _deployArcpadAgainst(pmB);

    // AYNI creationCode, farkli constructor argumanlari:
    assertEq(keccak256(type(ArcpadLocker).creationCode), keccak256(type(ArcpadLocker).creationCode));

    _fullGraduationCycle(lockerA, pmA);   // ikisi de BASARIR
    _fullGraduationCycle(lockerB, pmB);
}

/// src/ icinde SABIT YAZILMIS TEK adres USDC'dir. Bir PoolManager adresi
/// sizarsa bu test onu gorur.
function test_theOnlyHardCodedAddressInSrcIsUsdc() public view {
    // GraduationMath.QUOTE disinda hicbir 20-baytlik adres literali yok;
    // olcum grep ile Adim 4'te, burada sabitin kendisi pinlenir:
    assertEq(GraduationMath.QUOTE, 0x3600000000000000000000000000000000000000);
}

/// VE ISIN DURUST YARISI: "yapilandirma-only" KAYNAK DEGISIKLIGI YOK
/// demektir, ADRES AYNILIGI DEMEZ. Hook'un adresi creationCode + constructor
/// argumanlarindan turer ve argumanlar poolManager'i ICERIR, dolayisiyla
/// FARKLI BIR PoolManager ZORUNLU OLARAK FARKLI BIR HOOK ADRESI verir --
/// ve farkli bir hook adresi farkli bir PoolKey ailesi, yani farkli
/// PoolId'ler demektir. Mainnet havuzlari testnet havuzlariyla AYNI
/// PoolId'ye sahip OLMAYACAK. Bunu varsayan biri olacagi icin yazili.
function test_adifferentPoolManagerNecessarilyYieldsADifferentHookAddress() public {
    assertTrue(address(hookA) != address(hookB));
    // ...ve her ikisinin de alt 14 biti 0x20CC
    assertEq(uint160(address(hookA)) & Hooks.ALL_HOOK_MASK, 0x20CC);
    assertEq(uint160(address(hookB)) & Hooks.ALL_HOOK_MASK, 0x20CC);
}

/// Madenlenmis salt, guncel creationCode ile ADRESI YENIDEN URETMELI.
/// ArcpadHook'un kodu degisirse salt GECERSIZDIR ve bu, fazin en kolay
/// unutulan bagimliligidir. Esitlik bozulursa hook YENIDEN MADENLENMELIDIR
/// -- ve o noktada hicbir mevcut havuz o hook'a ait DEGILDIR.
function test_thePinnedSaltStillReproducesTheDeployedHookAddress() public view {
    address expected = vm.computeCreate2Address(
        PINNED_HOOK_SALT,
        keccak256(abi.encodePacked(type(ArcpadHook).creationCode,
                  abi.encode(poolManager, factory, escrow, protocolTreasury))),
        0x4e59b44847b379578588920cA78FbF26c0B4956C
    );
    assertEq(expected, addressBook.arcpadHook);
}

/// Protokol ucreti SIFIR ve oyle kalir.
function test_theProtocolFeeIsZeroOnTheDeployedSingleton() public view { ... }

/// Adres defteri BILDIRILMIS degil DOGRULANMIS: her girdi icin
/// CREATE2(deployer, salt, initCodeHash) == address.
function test_everyAddressBookEntryIsReproducibleFromItsSaltAndInitCodeHash() public view { ... }
```

- [ ] **Adım 3: Deploy et ve adres defterini doldur**

```bash
forge script DeployV4 --root contracts --rpc-url arc_testnet --broadcast --verify
forge script DeployArcpad --root contracts --rpc-url arc_testnet --broadcast --verify
```

**Özel anahtar argv'de veya ortam değişkeninde taşınmaz** (spec §11): Foundry'nin şifreli keystore hesabı kullanılır (`--account`).

- [ ] **Adım 4: `src/`'de sabit adres olmadığını ölç**

```bash
grep -rnE "0x[0-9a-fA-F]{40}" contracts/src/
```

Beklenen: **tam olarak bir isabet**, `GraduationMath.QUOTE`. Başka her isabet bir bulgudur ve mainnet geçişinin yapılandırma-only olduğu iddiasını **çürütür**.

- [ ] **Adım 5: Commit**

```bash
git commit -m "chore(contracts): deploy V4 and arcpad to Arc testnet with a verifiable address book"
```

---

### Task 8: Canlı RPC katmanı

**Files:**
- Create: `contracts/test/fork/ArcV4.fork.t.sol`
- Modify: `contracts/test/fork/ArcNetwork.fork.t.sol` (Faz 0'ın gevşek iddiası)

Arc'ın kendi dokümanı: `anvil` "Arc'ın precompile'larını, EIP-7708 `Transfer` olaylarını ve USDC bloklama listesi uygulamasını yeniden üretemez" ve bunlar "**yalnızca bir Arc RPC uç noktasına karşı test edildiğinde ortaya çıkar**". Bu görev **zorunludur**, kozmetik bir ek değil.

**HEAD `3d6cb09` fork işini gerçek bir kapı yaptı**, dolayısıyla buraya eklenen her test CI'ı kırabilir. Katman bu yüzden **ikiye ayrılır**:

| Alt katman | Ne yapar | CI'ı kapatır mı |
|---|---|---|
| **A — salt okuma sondaları** | Deterministik, ücretsiz, idempotent: kod varlığı, chain id, opcode'lar, çift görünüm aritmetiği | **Evet**, her PR'da |
| **B — tam graduation döngüsü** | Fonlu bir anahtar gerektirir, faucet USDC harcar, **idempotent değildir** (her koşu bir launch tüketir) | **Hayır**, elle tetiklenir |

**B'nin CI'ı kapatmaması bir taviz değil bir doğruluk gereğidir:** her koşuda yeni bir launch üreten bir test, kapı olarak kullanıldığında kapıyı akıtır ve başarısızlığı RPC gürültüsünden ayırt edilemez hâle getirir.

#### Testnet profili B'yi mümkün kılan tek şeydir

```
testnet R6 = 12_161_433 = 12,161433 USDC   <- Circle faucet: istek basina 10 USDC
uretim  R6 = 12_161_433_369 = 12.161,43 USDC
```

**İki faucet isteğiyle bir testnet launch'ı sonuna kadar satın alınabilir; üretim profilinde 1.217 istek gerekir.** `BondingCurve`'ün NatSpec'i testnet profilinin "kozmetik değil ZORUNLU" olduğunu zaten yazmıştı; bu görev o cümlenin ödemesidir.

- [ ] **Adım 1: Alt katman A'yı yaz**

```solidity
/// Adres defterindeki PoolManager gercekten orada.
function test_theDeployedPoolManagerHasCode() public view {
    assertGt(addressBook.poolManager.code.length, 0);
}

/// Hook'un adresi izin bitlerini tasiyor -- CANLI zincirde.
function test_theDeployedHookAddressCarriesTheArcpadFlags() public view {
    assertEq(uint160(addressBook.arcpadHook) & 0x3FFF, 0x20CC);
}

/// CIFT GORUNUM ARITMETIGI, canli USDC kontratina karsi. 10^12 sinirinin
/// UZAK ucu budur ve yerel EVM'de HIC gorunmez.
function test_theSixDecimalViewTruncatesExactlyAsTheLibraryAssumes() public {
    // locker'in artigi 1 ERC-20 biriminin ALTINDA, yani ERC-20 gorunumu 0
    // okur ama native bakiye sifir DEGIL:
    //   testnet artik = 369_060_378_707 wei
    assertEq(IERC20(USDC_ERC20).balanceOf(addressBook.arcpadLocker) % 1, 0);
    // ...ve dogrudan olcum: 1 birimin altina 1 wei ekle, balanceOf DEGISMEZ
}

/// Faz 0'in DEVREDEN kalemi: sifir-adres iddiasi CIPLAK bir try/catch ile
/// sarilmisti ve yalnizca "bir sey firlatildi" diyordu -- bir 429 da
/// geciriyordu. DUZELTME: hata metninde "Zero address not allowed" alt
/// dizesi aranir VE sifir olmayan bir adrese kontrol cagrisi eklenir.
function test_nativeTransferToZeroAddressRevertsWithArcsOwnMessage() public { ... }
```

- [ ] **Adım 2: Alt katman B'yi yaz — tam döngü**

```solidity
/// LAUNCH -> SATIS ARZINI TUKET -> GRADUATE -> HAVUZ VAR.
/// R-12'nin prosedurunun calistirilabilir hali; Task 7 adim 9'un on kosulu.
function test_fullGraduationCycleAgainstTheDeployedContracts() public { ... }

/// EIP-7708 CIFT SAYIM TUZAGI, olculur. Graduation IKI ayri `Transfer`
/// uretir ve ikisi AYNI hareketi anlatir:
///   - curve'un `target.call{value: R}("")`'i -> SISTEM EMITTER'INDAN,
///     18 decimal
///   - locker'in `USDC.transfer(poolManager, R6)`'si -> ERC-20 USDC
///     KONTRATINDAN, 6 decimal
/// Faz 3'un indexer'i EMITTER ADRESINE gore eslemek zorundadir. Spec §6.1
/// bunu en tehlikeli indexer tuzagi olarak adlandiriyor; bu test onun
/// gozlemlenebilir kanitidir.
function test_graduationEmitsBothTransferFlavoursAndTheyMustNotBeDoubleCounted() public {
    vm.recordLogs();
    locker.graduate(curve);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    // sistem emitter'indan 18-decimal Transfer VE
    // 0x3600...'dan 6-decimal Transfer, ikisi de var, emitter'lari FARKLI
}

/// BLOKLAMA. Arc testnet'in tohumladigi adres:
///   0x70997970C51812dc3A010C7d01b50e0d17dc79C8
/// Hedefi o adrese yonlendirilmis GECICI bir factory ile: `graduate()`
/// `GraduationPayoutFailed()` ile doner, curve SAGLAM kalir, ve GAZ
/// TUKETILIR. F9'un olcumu budur ve D3'un ucuncu bagimsiz gerekcesi.
function test_aBlocklistedTargetMakesGraduationRevertWhileConsumingGas() public { ... }

/// Kademe 0, canli. Gecisler testnet'te ULASILAMAZ (FDV 58,78 USDC, ilk
/// esik 59.000 USDC) ve bu ACIK HUCRE olarak kaydedilir.
function test_theFirstPoolSwapChargesTierZeroOnTheLiveChain() public { ... }
```

**Alt katman B'nin iddia sözleşmesi — yazılacak `assert`'lerin tam listesi:**

| test | tam iddia |
|---|---|
| `..fullGraduationCycle..` | Geçici factory ile launch; iki faucet isteğiyle fonlanmış anahtardan `buyExactTokensOut(S, type(uint256).max)`; `curve.complete() == true`, `curve.realQuoteReserves() == 12_161_433_369_060_378_707`; `locker.graduate(curve)`; `getSlot0(id).sqrtPriceX96` **dört literalden birine** eşit (sıralamaya göre `19209072819323074681` ya da `326777965518061118072680912817470217035`); `getPositionInfo(...).liquidity == 50160046734639668` |
| `..bothTransferFlavours..` | `vm.getRecordedLogs()` içinde `Transfer` topic0'lı **en az iki** log; birinin `emitter != 0x3600…0000` (sistem emitter, 18 decimal, `data == 12_161_433_369_060_378_707`), diğerinin `emitter == 0x3600…0000` (6 decimal, `data == 12_161_433`). İkisinin **aynı hareketi** anlattığı, `data₁ / data₂` oranının `10¹²`ye eşit olmasıyla iddia edilir — **indexer'ın çift saymaması gerektiğinin ölçülebilir kanıtı budur** |
| `..blocklistedTarget..` | Geçici factory'nin hedefi `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`'e yönlendirilir; `graduate` çağrısı revert eder ve dönen selector `GraduationPayoutFailed()`; `curve.graduated() == false`; ve `gasleft()` farkı **sıfırdan büyük** (gaz tüketildi) |
| `..tierZeroLive..` | `SwapHarness` ile exact-input buy `1_000_000`; `escrow.owed(treasury)` `+9_500·1e12` wei, `escrow.owed(creator)` `+3_000·1e12` wei — **curve'ün son alımının ödediği oranların aynısı** |
| `..sixDecimalTruncation..` | Graduation'dan sonra `IERC20(USDC).balanceOf(locker) == 0` **ama** `address(locker).balance == 369_060_378_707`. Arc dokümanının *"bir `balanceOf` değeri `0` native bakiyenin `0` olduğunu ima etmez"* cümlesinin canlı ölçümü, ve 10¹² sınırının **uzak ucu** — yerel EVM'de bu test hiçbir şey ifade etmez |

- [ ] **Adım 3: Çalıştır**

```bash
make fork-test                                    # alt katman A + B
forge test --root contracts --match-path 'test/fork/ArcV4.fork.t.sol' \
  --match-test 'Probe' --fork-url arc_testnet     # yalnizca A, CI'in kosacagi
```

- [ ] **Adım 4: Commit**

```bash
git commit -m "test(contracts): exercise graduation against live Arc testnet and pin the EIP-7708 double-count trap"
```

---

## Faz 2 tamamlanma ölçütü

- [ ] `forge test --root contracts --no-match-path 'test/fork/*'` **her iki profilde** yeşil
- [ ] `make fmt-check`, `make lint`, `make slither` temiz; yeni HIGH/MEDIUM yok
- [ ] Her invariant için onu kıran **en az bir mutasyon** raporda kayıtlı
- [ ] Task 6 Adım 2'nin sekiz "hiçbir mutantın hedeflemediği satır" mutasyonunun **hepsi** koşturulmuş; ölmeyen her biri gerekçesiyle raporlanmış
- [ ] `grep -rnE "0x[0-9a-fA-F]{40}" contracts/src/` → **tam olarak bir** isabet (`GraduationMath.QUOTE`)
- [ ] `grep -rn "1e12\|10\*\*12\|1_000_000_000_000" contracts/src/` → **tam olarak bir** dosya
- [ ] Dört `sqrtPriceX96` literali, iki `L` değeri ve dört toz değeri `assertEq` ile sabitlenmiş
- [ ] Her iki para birimi sıralaması için tam bir graduation döngüsü yeşil
- [ ] `ArcpadLocker`'ın ABI'sinde `int256`/`int128` parametresi alan **hiçbir** dış fonksiyon yok
- [ ] `PoolSeeded`'in topic0'ı `Graduated`'in topic0'ına **eşit değil**
- [ ] Adres defterinin **her** girdisi salt + initcode hash'ten yeniden türetilebilir
- [ ] Aynı bytecode, **iki farklı** `PoolManager`'a karşı tam graduation yapıyor
- [ ] Arc testnet'te tam döngü **fiilen çalıştırılmış** ve `applyGraduationTarget` **ancak ondan sonra** çağrılmış
- [ ] `contracts/src/` tam olarak: `libraries/{CurveMath,GraduationMath}.sol`, `interfaces/{IFeeEscrow,IGraduatableCurve,IArcpadFactoryView,ILaunchTokenView}.sol`, `{LaunchToken,FeeEscrow,BondingCurve,LaunchFactory,FeeSchedule,ArcpadHook,ArcpadLocker}.sol`
- [ ] Task 8 alt katman A CI kapısında yeşil; alt katman B **elle** en az bir kez tam döngüyü tamamlamış ve `deployments/arc-testnet.json`'daki `deployedAtBlock` gerçek bir blok numarası
- [ ] Task 3 Adım 1'in canlı `stable_fee_tiers` çözümü **denenmiş**; çözülemediyse enterpolasyon sapma olarak raporlanmış

## Faz 2b/3'e devreden

- **`ArcpadRouter`.** Havuzda swap yapmak için bir router gerekir ve Arc'ta Universal Router yoktur. Kapsam dışı bırakılmasının gerekçesi yapısaldır: router hiçbir havuzun kalıcı kimliğinin parçası değildir.
- **`FeeSchedule`'ın sekiz ara satırı.** 11M–20M bandının ara creator oranları spec'te yoktur ve enterpolasyondur. Canlı `stable_fee_tiers` çözüldüğünde **yeni bir `FeeSchedule` deploy edilir** — spec'in kendi yükseltme yolu.
- **Kademe geçişleri testnet'te ulaşılamaz.** FDV 58,78 USDC, ilk eşik 59.000 USDC. Açık hücre.
- **Havuza yapılan bağışlar yakılır.** `PoolManager.donate` izinsizdir, hook'un `beforeDonate` bayrağı yoktur, ve aralıktaki tek likidite tahsil edilemez. Kapatmak hook adresini değiştirmek demekti. Açık hücre.
- **Locker'ın biriken quote artığı.** Graduation başına en fazla `10¹² − 1` wei, kalıcı. Bir sweep yolu **eklenmemelidir**: locker'ın kendi bakiyesini hiç okumaması, artığın sonraki bir launch'a atanamamasının **tek** sebebidir.
- **`packages/shared/src/chain.ts` testnet'e sabitlenmiş** ve guard'ı mainnet'i reddediyor (hazırlık denetiminin bulgusu). Task 0 bunu raporlar, Faz 3 düzeltir.
- **`creator` `BondingCurve`'de immutable** ve spec §5.7 değiştirilebilir olmasını istiyor. Hook `configOf`'ta creator'ı **önbelleğe alır**, yani bu çelişki çözüldüğünde hook'un önbelleği de geçersizleşir — ve o noktada `configOf`'un creator alanı kaldırılıp her swap'te okunmalıdır. **Bu bağımlılık burada yazılı olduğu için sessiz kalmayacak.**
- **Faz 3 indexer'ı `PoolSeeded`'i dinler**, `Graduated`'i değil — ikisi ayrı olaylardır ve ikisi de gerekir: `Graduated` curve'ün terminal olduğunu, `PoolSeeded` havuzun var olduğunu söyler.
