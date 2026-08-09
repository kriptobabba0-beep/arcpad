# arcpad — Arc üzerinde pons/pump.fun tarzı token launchpad

**Tarih:** 2026-07-27
**Durum:** Tasarım onaylandı, uygulama planı bekliyor
**Kod adı:** `arcpad` (geçici — marka kararı UI fazında verilecek, `web/lib/brand.ts` içinde tek sabit)

---

## 1. Özet

Circle'ın Arc L1'i (chainId 5042002) üzerinde, [ponsfamily.com](https://www.ponsfamily.com/)'un birebir işlevsel karşılığı olan bir token launchpad'i. Kullanıcı sabit arzlı bir token başlatır; tüm arz bir bonding curve'de satışa çıkar; curve tükendiğinde launch, likiditesi kalıcı olarak kilitlenmiş bir Uniswap V4 havuzuna *graduate* olur.

**Birincil kaynak pump.fun'ın resmî dokümantasyonudur** (`github.com/pump-fun/pump-public-docs`). Ponsfamily'nin kendisi pump.fun'ı taklit ettiği için dokümanları ikinci elden bir anlatımdır; bu spec protokol mekaniğini pump.fun'dan, ürün/arayüz şeklini ponsfamily'den alır. Akış her ikisinde de aynıdır: bonding curve → graduation → kalıcı kilitli AMM havuzu. Karşı bacak SOL veya ETH değil, Arc'ın native para birimi olan **USDC**'dir — pump.fun da SOL dışı quote asset desteğini eklemiş durumda, yani bu bir sapma değil aynı yönde bir adımdır.

Hedef: Arc testnet'te gerçekten çalışan bir ürün. Arc mainnet açıldığında taşınabilir olmalı.

---

## 2. Kapsam

**Kapsam içi (ilk yayınlanabilir sürüm)**

- Token launch (create) akışı, geliştirici ilk alımı dahil
- Bonding curve üzerinden al/sat
- Graduation → Uniswap V4 havuzu, kalıcı likidite kilidi
- Graduation sonrası havuz üzerinden al/sat
- Explore sayfası (graduated + climbing bölümleri, filtreler, sayfalama)
- ⌘K arama
- Token detay sayfası: fiyat grafiği, son işlemler, holders, al-sat paneli
- Holder-gated token chat
- Analytics sayfası (protokol geneli metrikler)
- Profil sayfası + creator ücret talebi
- Limit emirler + Orders sekmesi
- Grafik heatmap katmanı ve dev buy/sell işaretleri (en son fazda)
- `BuybackVault` kontratı ve beş yıllık doğrusal serbest bırakma

**Kapsam dışı**

- Arc mainnet deploymentı (ağ henüz yok — 2026 yazı hedefleniyor)
- Harici audit (Faz 7 sonrası ayrı bir iş)
- Özel pairing asset desteği (pons v2'de var; burada yalnızca native USDC)
- Dexscreener / GeckoTerminal entegrasyonu — bu servisler yalnızca kanonik Uniswap deploymentlarını indexler, bizim kendi deploymentımızı tanımazlar

---

## 3. Doğrulanmış gerçekler

Tasarım bu bulgular üzerine kurulu. Her biri uygulama sırasında yeniden doğrulanmalı.

### 3.1 Arc ağı

| Alan | Değer |
|---|---|
| Chain ID | `5042002` (`0x4CEF52`) |
| RPC | `https://rpc.testnet.arc.io` |
| WebSocket | `wss://rpc.testnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` (Blockscout) |
| Faucet | `https://faucet.circle.com` — istek başına 10 USDC |
| Native gas | USDC |
| Finality | ~350ms, deterministik, reorg yok |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` (6 decimal) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

**Alan adı `arc.network`'ten `arc.io`'ya taşındı.** Circle'ın dokümanlarındaki her RPC ve explorer URL'i bugün `arc.io` altında; `docs.arc.network/llms.txt` `docs.arc.io/llms.txt`'ye 301 veriyor. Eski `rpc.testnet.arc.network` hâlâ cevap veriyor ama artık dokümante değil, dolayısıyla kullanımdan kalkmış sayılır. Depoda tek kaynak `packages/shared/src/chain.ts`'tir ve CI'ın Arc fork job'ı da aynı hostu kullanır.

### 3.2 Native USDC'nin çift görünümü

Arc'ta native varlık USDC'nin kendisidir. **İki ayrı varlık değil, tek havuzun iki görünümü:**

- **Native görünüm:** 18 decimal. Gas, `msg.value`, native transferler.
- **ERC-20 görünüm:** 6 decimal, `0x3600…0000` adresinde.

`USDC.balanceOf(a)` ile `a.balance` aynı değerin iki okumasıdır; asla toplanmaz. Bu projede **yalnızca native görünüm** kullanılır (18 decimal), çünkü curve fiyatlaması 6 decimal'de yuvarlama kaybeder ve `msg.value` ile ödeme approve adımını ortadan kaldırır.

### 3.3 Arc'ın EVM farkları (tasarımı etkileyenler)

- `PREVRANDAO` her zaman `0` — zincir üstü rastgelelik yok. Bu tasarımda rastgeleliğe ihtiyaç yok.
- **Sıfır adrese native transfer yasak** (`"Zero address not allowed"` ile revert). Native USDC yakılamaz.
- **Sözleşmelere native gönderimin başarılı olacağı garanti değil.** Bütün ödemeler pull-based olmalı.
- Blocklist runtime'da uygulanır; gas ödenmiş olsa bile transfer revert edebilir.
- **EIP-7708:** her native hareket, sistem adresinden 18 decimal'lik bir `Transfer` logu yayınlar. ERC-20 USDC kontratının kendi 6 decimal'lik logundan ayrıdır — indexer'da emitter adresine göre filtrelenmeli, yoksa çifte sayım olur.
- Blok timestamp'leri artmayan olabilir (sub-second bloklar aynı timestamp'i paylaşabilir). Zaman farkına bölen hiçbir mantık olmamalı.
- **`anvil` Arc'ı simüle edemez.** Native-coin precompile'ları, EIP-7708 logları ve blocklist yalnızca gerçek Arc RPC'sinde görünür.
- EIP-1153 (`TSTORE`/`TLOAD`) ve EIP-5656 (`MCOPY`) **destekleniyor** — `eth_call` ile bytecode probe edilerek doğrulandı. Uniswap V4 bu ikisi olmadan derlenmez.

### 3.4 Uniswap'ın Arc'taki durumu

Uniswap'ın resmî deployment listesinde Arc **yok**. `testnet.arcscan.app` üzerinde onlarca doğrulanmış `UniswapV3Factory`, `UniswapV2Factory`, `PoolManager`, `V4Quoter`, `StateView` kontratı var, ancak hepsinin işlem sayısı 0–2 — bunlar üçüncü tarafların kendi deploymentları.

Arc'ın resmî duyurusu (X, @arc) **"Uniswap is coming to Arc Mainnet"** diyor — gelecek zaman ve mainnet. Yani:

- **Testnet'te (bugün):** kanonik Uniswap yok. Kendi V4 `PoolManager`'ımızı deploy ediyoruz.
- **Mainnet'te (Arc mainnet ile birlikte):** Uniswap'ın kendi kanonik V4 deploymentı olacak.

**Bu ikisi arasında geçiş kod değişikliği gerektirmez.** V4 mimarisinde `PoolManager` tekildir ama **hook'lar herkese açıktır** — `ArcpadHook`, Uniswap'ın kanonik `PoolManager`'ı üzerinde de havuz açabilir. Bu yüzden kontratlar `PoolManager`'ı adresle enjekte edilen bir arayüz olarak görür: testnet'te bizimki, mainnet'te Uniswap'ınki, aynı kod.

> V3 olsaydı bu mümkün olmazdı; orada havuz davranışını değiştirmek için factory'nin kendisini forklamak gerekirdi. Hook modeli, üçüncü tarafın kanonik altyapısı üzerine özel mantık eklemeye izin verdiği için bu geçişi bedavaya getiriyor.

Mainnet'te kanonik `PoolManager` kullanılması, §2'de kapsam dışı bırakılan **Dexscreener / GeckoTerminal entegrasyonunu da kendiliğinden geri getirir** — o servisler kanonik V4 havuzlarını indexler.

Ponsfamily de benzer bir modeli kullanıyor: dokümanındaki V3 Factory adresi (`0x1f7d7550…`) Uniswap'ın kanonik adresi (`0x1F98431c…`) değil.

### 3.5 Referans kaynaklar

**Birincil kaynak pump.fun'dır.** Ponsfamily'nin kendisi pump.fun'ın bir taklidi, yani dokümanları ikinci elden bir anlatım. Protokol mekaniği için `github.com/pump-fun/pump-public-docs` esas alınır; ponsfamily yalnızca **ürün/arayüz şekli** için referanstır — ekran görüntülerinin yakaladığı şey de budur.

pump.fun'ın canlı `Global` hesabından okunan sabitler (2026-07-27):

| Parametre | pump.fun (canlı) |
|---|---|
| `initial_virtual_token_reserves` | 1.073.000.000.000.000 |
| `initial_virtual_sol_reserves` | 30.000.000.000 (30 SOL) |
| `initial_real_token_reserves` | 793.100.000.000.000 |
| `token_total_supply` | 1.000.000.000.000.000 (6 decimal ⇒ 1 milyar token) |
| Havuz tohumu | 206.900.000 token (%20,69) |
| Graduation | **85,005 SOL — türetilmiş, parametre değil** |
| Fiyat katı | 14,7× |
| İşlem ücreti | market cap'e göre kademeli, %1,25 → %0,30 |
| Migration ücreti | 15.000.001 lamports (tavan 15.000.000) |
| PumpSwap statik ücreti | 20 bps LP + 5 bps protokol |

Karşılaştırma için ponsfamily v1 (canlı): 1 milyar arz, %1 havuz ücreti, 0,0005 ETH launch ücreti, WETH eşleşmesi, havuzda 4,2 ETH graduation, %70/%30 sabit bölüşüm. Ponsfamily v1'de bonding curve **yoktur** — token doğrudan V3 havuzuna düşer; bu spec'in izlediği model pump.fun'ın curve → AMM akışıdır.

**pump.fun'ın ponsfamily dokümanlarında hiç geçmeyen özellikleri** — hepsi §5.8'de değerlendirilmiştir: SOL dışı quote asset desteği (USDC dahil), creator başına tek vault, izinsiz ücret süpürme, 10 paydaşa kadar creator fee sharing, işlem hacmine göre cashback, mayhem modu, ayrı buyback fee alıcısı.

---

## 4. Sistem mimarisi

Dört bağımsız çalışan parça, aralarında net sınırlar:

```
d:\pumpfunforarc\
├── contracts/        Foundry (solc 0.8.26, evm=cancun, via_ir=true)
│   ├── src/ test/ script/
│   └── lib/          v4-core, v4-periphery, forge-std, uniswap-hooks (git submodule) — openzeppelin ayrı submodule değil, v4-core/lib üzerinden çözülür
├── indexer/          TypeScript + viem + Postgres
├── web/              Next.js 16 App Router + React 19 + wagmi 3/viem + Tailwind 4
├── keeper/           TypeScript limit-order executor + graduation fallback
├── packages/shared/  Arc zincir tanımı + USDC çift-görünüm yardımcıları — tek kaynak (ABI'ler Faz 1'de gelecek)
├── docs/specs/       Tasarım dokümanları
├── docs/plans/       Faz faz uygulama planları
├── Makefile
└── .github/workflows/
```

- **contracts/** tek gerçek kaynağıdır. Curve fiyatlaması, graduation, ücret muhasebesi ve likidite kilidi burada yaşar; hiçbir üst katman bu kararları tekrar hesaplamaz.
- **indexer/** zinciri okuyup Postgres'e okuma modeli yazar. Yazma yetkisi yoktur, yalnızca olaylardan türetir.
- **web/** hem UI hem yazma API'leridir. Liste ve geçmiş Postgres'ten, işlem anındaki kota doğrudan zincirden okunur.
- **keeper/** limit emirlerini tetikler ve **tamamlanmış curve'leri graduate eder.**

> **DÜZELTME, 2026-08-09 — bu satırın ilk hâli imkânsız bir mimariyi tarif ediyordu.**
> Yazdığı şey "otomatik graduation başarısız olursa manuel iter" idi, yani keeper bir **yedek**ti ve
> ondan önce gelen otomatik bir yol vardı. Öyle bir yol **olamaz**: `BondingCurve.graduate()`
> `msg.sender == graduationTarget` şart koşar, dolayısıyla otomatik olması için curve'ün kendisinin
> locker'ı çağırması gerekirdi — ve `BondingCurve`'ün creation code'u **dondurulmuştur**, o çağrı
> oraya artık eklenemez.
>
> Doğru mimari terstir: **keeper BİRİNCİL yoldur**, ve *yedek* olan şey çağrının izinsizliğidir —
> `ArcpadLocker.graduate(address curve)` `external`dır, yani keeper düşerse tamamlanmış bir curve'ü
> herkes mezun edebilir (§429'un "izinsizlik bir seviye yukarı taşınır" kararı tam da bunu satın
> alır). Arayüzün `complete && !graduated && target != 0` durumunda bir **Graduate** düğmesi
> göstermesi bu yedeğin kullanıcıya açılan yüzüdür.

`packages/shared` ABI'yi tek kaynaktan dağıtır. Üç tüketicinin (indexer, web, keeper) her biri için `forge build` çıktısına karşı bir ABI-parity testi CI'da koşar; kontrat arayüzü değişip tüketici güncellenmezse CI kırılır.

**Neden ayrı repo (Limen Finance ile paylaşılmıyor):** Limen'in `foundry.toml`'u Uniswap V3 fork'u yüzünden `evm_version = "paris"` ve `via_ir = false`'a pinli. Uniswap V4 ise `cancun` ve `via_ir = true` gerektirir (aksi halde "stack too deep"). İki yapılandırma aynı workspace'te yaşayamaz.

> `C:\Users\iTopya\Desktop\arc-proje` (Limen Finance) bu proje için **salt-okunur referanstır**. Konvansiyonları kopyalanır, içine hiçbir şey yazılmaz.

---

## 5. Kontrat mimarisi

### 5.1 Kontratlar

| Kontrat | Sorumluluk |
|---|---|
| `LaunchFactory` | Giriş noktası. `launch(name, symbol, uri)` — **üç argüman, `payable` değil**. Aynı CREATE2 salt'ıyla önce `BondingCurve`'ü, sonra `LaunchToken`'ı deploy eder ve ikisini `bind` ile bağlar. Profil (`V`, `T`, `S`) factory'nin immutable'larıdır, launch argümanı değil. Graduation'ı **orkestre etmez**: iki döndürülebilir üye tutar — `graduationTarget()` ve `protocolTreasury()` — ve curve ikisini de çalışma anında buradan okur (§5.6). `isCanonical(token)` bir token'ın kimliğini kendi verisinden yeniden türetir. Oluşturma ücretsizdir. |
| `LaunchToken` | Sabit arzlı ERC-20, 18 decimal. `name`, `symbol`, `metadataURI`, `creator`, `curve`, `launchSalt` alanları token üzerinde — zincirden okunabilir, backend'e bağımlı değil; `launchSalt` `isCanonical`'ın türetmeyi tamamlaması için orada durur. **Tüm arz constructor'da tek seferde `BondingCurve`'e basılır.** Curve, satılabilir kısmı (`S`) kendi sayacıyla sınırlar; rezerve kalan (`D`) aynı bakiyede durur ve graduation'da havuza aktarılır. Sonradan mint fonksiyonu yoktur; **burn fonksiyonu da yoktur** (§7.1). |
| `BondingCurve` | **Launch başına tam bir `new BondingCurve{salt}` deploymentı** — proxy değil. Satış arzını tutar. Üç ticaret giriş noktası: `buyExactTokensOut(uint256,uint256)` (payable), `buyExactQuoteIn(uint256)` (payable, `msg.value` bütçedir), `sellExactTokensIn(uint256,uint256)`. Bir de tek çıkış yolu: `graduate()` (§5.6). **Zincirde kota (quote) fonksiyonu yoktur** — gerekçesi §6.3. |
| `ArcpadHook` | Uniswap V4 singleton hook. Havuzun kendi ücreti sıfırdır; ücreti hook alır ve `FeeEscrow`'a yazar. |
| `FeeEscrow` | Pull-based bakiyeler. Hiçbir ücret push edilmez. |
| `LaunchLocker` | Graduate olan V4 likidite pozisyonunu ve artan arzı **kalıcı** tutar. Çıkarma yolu yoktur. |
| `BuybackVault` | Geri alınan tokenları beş yıla yayarak doğrusal serbest bırakır. |
| `ArcpadRouter` | Graduation sonrası swap'ler için minimal V4 router. `PoolManager.unlock` geri çağrısı üzerinden `exactInputSingle` / `exactOutputSingle`. |
| `libraries/CurveMath` | Saf matematik, tamamı `internal`. Fuzz ve invariant testlerinin asıl hedefi. |

**Faz 1c sonunda `contracts/src` altında fiilen duran beş dosya:** `LaunchFactory`, `LaunchToken`, `BondingCurve`, `FeeEscrow`, `libraries/CurveMath` (artı `interfaces/IFeeEscrow`). Tablonun geri kalanı — `ArcpadHook`, `LaunchLocker`, `BuybackVault`, `ArcpadRouter` — Faz 2 ve sonrasıdır ve henüz yazılmamıştır. **`libraries/LaunchConfig` hiç yazılmayacaktır:** parametreleri taşıyacak bir struct'a ihtiyaç kalmadı, çünkü `V`, `T` ve `S` factory'nin immutable'larıdır ve doğrulamaları factory'nin constructor'ında, deploy başına bir kez yapılır (`DegenerateProfile`, `GraduationRaiseTooSmall`, `SaleAndSeedExceedSupply`, `SaleAndSeedStrandSupply`).

**`FeeSchedule` de yazılmadı, ve bu bilinçlidir.** Curve'ün ücreti kademeli değil düzdür (§5.5 Rejim 1), dolayısıyla curve'ün bir kademe tablosuna bakması gerekmiyor: oranlar `BondingCurve` üzerinde `PROTOCOL_FEE_BPS = 95` ve `CREATOR_FEE_BPS = 30` olarak `public constant`'tır ve kontratın bytecode'una gömülüdür — bir adres yazmaktan daha güçlü bir dondurma. Kademe tablosunun bir yere yazılması gereken tek yer graduation **sonrası** havuzdur (Rejim 2), yani Faz 2'nin problemidir; o fazda ayrı bir immutable kontrat mı yoksa hook'un kendi sabitleri mi olacağı orada karara bağlanır.

**Neden launch başına ayrı bir curve:** İzolasyon. Bir muhasebe hatasının yarıçapı tek bir launch olur, tüm protokol değil. Her curve yalnızca kendi tokenını ve kendi topladığı USDC'yi tutar. **Ucuzluk için proxy kullanılmadı; adres türetilebilirliği için tam deployment yapıldı.** pump.fun'da curve ile mint arasındaki eşleşme saf bir PDA türetmesidir, yani herkes doğrulayabilir; EVM'deki karşılığı CREATE2'dir. Factory önce curve'ü `salt` ile deploy eder (constructor argümanları token'ı içermez, dolayısıyla döngü yoktur), sonra token'ı **aynı** salt'la; `LaunchToken.launchSalt` sayesinde `isCanonical` token'ın adresini yalnızca token'ın kendi açıkladığı verilerden yeniden türetir. Bir EIP-1167 klonunda initcode sabit olduğu için bu türetme bu ayrımı yapamazdı. Deploy maliyeti bu yüzden kabul edilmiştir; Arc'ta gas zaten ~$0,01 hedefindedir.

**Neden ayrı bir NFT position manager yok:** V4'te likidite `PoolManager.modifyLiquidity` ile doğrudan yönetilir. `LaunchLocker` pozisyonun sahibi olur ve içinde likidite **çekme yolu bulunmaz**. Bu, bir NFT'yi kilitlemekten daha güçlü bir garantidir: kilitlenecek bir NFT yoktur, likiditeyi hareket ettirebilecek kod hiç yazılmamıştır.

### 5.2 Curve matematiği

Sanal rezervli sabit çarpım (`x·y = k`) — pump.fun ve pons v2 ile aynı aile.

**Durum:**

- `usdcReserve` — sanal USDC rezervi, `V`'den başlar
- `tokenReserve` — sanal token rezervi, `T`'den başlar
- `k = V · T`, değişmez

**İşlemler:**

```
buy(dx):   tokensOut = dx · tokenReserve / (usdcReserve + dx)
sell(dy):  usdcOut   = dy · usdcReserve  / (tokenReserve + dy)
```

> **Bu formların yazılışı önemlidir, sadeliği için değil.** `tokenReserve − k/(usdcReserve + dx)` yazımı cebirsel olarak denktir ama tamsayı bölmesiyle **kullanıcı lehine** yuvarlar — yani aşağıda uyarılan drain şeklinin tam kendisi. Ölçüldü: 20.000 rastgele `(V, T, dx)` üçlüsünün 20.000'inde `k`-çıkarmalı form alıcıya daha fazla token, satıcıya daha fazla quote verir. Somut örnek: `V=100, T=200, dy=1` → `k`-formu 1 öder, doğru form 0 öder. **Uygulamada yalnızca yukarıdaki çarpım formu kullanılır.**

**Parametrelendirme pump.fun ile aynıdır, ve dört sayıdır:** sanal quote rezervi `V`, sanal token rezervi `T`, curve'de satılacak gerçek arz `S`, ve toplam arz `N`. Geri kalanı türetilir. `N`, `S` ve `D`'den türetilen bir sonuç **değildir** — pump.fun `token_total_supply`'ı `Global` hesabında `V`, `T`, `S` ile birlikte ayrı bir alan olarak tutar; aşağıdaki `D` ile `N` arasındaki ilişki bir özdeşlik değildir, bir yaklaşıklıktır (bkz. bu bölümün sonu).

| Türetilen | Formül |
|---|---|
| Açılış fiyatı | `P₀ = V / T` |
| Graduation'da toplanan | `R = V · S / (T − S)` |
| Graduation fiyatı | `P_final = (V + R) / (T − S)` |
| **Havuz tohumu arzı** | **`D = S · (T − S) / T`** |

`D` serbest bir sayı değildir, **zorunludur**. Curve'ün kapanış fiyatı ile havuzun açılış fiyatı eşitlenmezse graduation anında anlık bir arbitraj boşluğu doğar ve ilk swap fiyatı uçurur. Yukarıdaki formül, `D = R / P_final` koşulunun sadeleştirilmiş halidir.

**`N = S + D` bir özdeşlik değildir — yalnızca yaklaşık olarak tutar.** pump.fun'ın canlı sabitleriyle `D` tam olarak **206.886.011,183597** token'dır, oysa `N − S` **206.900.000**'dır: pump.fun'ın kendi ayrı sabiti olan toplam arzdan satış arzını çıkardığımızda çıkan, yuvarlak rezerve rakamı. Aradaki **13.988,816403 token (`D`'nin %0,0068'i)** kalıcı olarak kilitlenir — ne curve'de satılır ne havuza tohum olarak gider; §5.1'de tüm arzın curve'e basıldığı tek bakiyede kalıcı bir artık olarak durur (§5.6). Faz 1a'nın `CurveMath.t.sol` testleri bu iki sayıyı ve aradaki farkı ayrı ayrı doğrular (`test_poolSeedSupplyMatchesPumpFunReservedSupply`, `test_reservedSupplyExceedsExactSeedAndDifferenceIsLocked`).

**Bu formülde ücret oranı yoktur, ve bu kasıtlıdır.** Ücret curve matematiğinin *dışında* alınır: kullanıcı `quoteIn` öder, ücret düşülür, rezervlere yalnızca `quoteIn − f` girer. Dolayısıyla sell-out anında curve'de biriken `R` ücret oranından bağımsızdır. §5.5'teki kademeli ücret modelini mümkün kılan şey budur — oran işlem başına değişse bile havuz tohumu sabit kalır.

> **Düzeltme.** Bu spec'in ilk sürümü `D = S(1−φ)/√m` yazıyor ve ücreti formülün içine koyuyordu. pump.fun'ın canlı sabitleriyle sınandığında yanlış olduğu görüldü. Karekök de gerekmediği için "`sqrtM`'i tamsayı seç" kısıtı tamamen düşmüştür.

**Doğrulama — pump.fun'ın kendi sabitleri bu formülleri sağlar:**

```
V = 30e9 lamports,  T = 1,073e15,  S = 7,931e14

R = 30e9 × 7,931e14 / 2,799e14 = 85,005e9      → meşhur 85 SOL eşiği
D = 7,931e14 × 2,799e14 / 1,073e15 = 2,069e14  → havuz tohumu `D`
(T/(T−S))² = 14,7×                              → fiyat katı
```

85 SOL bir parametre değildir; bu üç sayıdan çıkan bir sonuçtur.

**`R` bir alt sınırdır, tek bir sayı değildir — ve bu yolun kendisine bağlıdır.** `R = V·S/(T−S)` curve'ün *sürekli* karşılığıdır; curve'ün satış arzı tükendiğinde fiilen tuttuğu tutar `realQuoteReserves`'tir ve ondan **kesinlikle büyüktür**. Sebep `quoteBuyCost`'un koşulsuz `+1`'idir: her alım maliyete bir birim ekler, dolayısıyla fazlalık **alım başına** birikir. Ulaşılabilir en küçük değer `R + 1`'dir (satış arzının tamamını alan tek bir alım); ölçüldü — altı işlemlik bir dizi `R + 11` bıraktı, ve yukarı doğru bir sınır yoktur. Yani **iki alımla tamamlanan bir launch, tek alımla tamamlanan bir launch'tan kesinlikle daha yüksek bir fiyattan havuz açar.**

Bunun iki sonucu vardır ve ikisi de bağlayıcıdır:

- **Tek bir sabit açılış fiyatı ima eden hiçbir cümle doğru değildir.** Havuz `R_actual / D` fiyatından açar ve o oran işlem geçmişine bağlıdır. §10 invariant 6 bu yüzden bir eşitlik değil, yönü olan bir eşitsizliktir.
- **Yön her zaman protokol lehinedir ve bu bir teoremdir, bir yuvarlama tesadüfü değil.** `D` aşağı yuvarlandığı için `D < S(T−S)/T`; havuzu tam `P_final`'den açacak olan `R₀ = D·V/(T−S−D)` değeri bu durumda `R`'nin üzerindeki kesirli değerin altında kalır. Ulaşılabilir her `R_actual` için havuz `P_final`'in **üstünde** açar. Ölçüldü: her iki kutsanmış profilde de `R₀`, `R`'nin sırasıyla 0,957 ve 0,681 wei üzerinde, ulaşılabilir minimum ise `R + 1`. Genel hâli: **`D < S(T−S)/T` ⟹ havuz `P_final`'in üstünde açar**, profil değişse bile.

`LaunchFactory.MIN_GRADUATION_RAISE` bu yüzden `R`'yi, yani bir **alt sınırı** tabanlar; güvenli yön budur.

**Yuvarlama yönleri pump.fun'ın SDK kaynağından birebir alınmıştır** (`@pump-fun/pump-sdk@1.36.0`, `src/bondingCurve.ts` ve `src/fees.ts`). Dördü de protokol lehinedir ve tahmin değil, kopyadır:

```
alım, tam token çıkışı:   cost = amount·Vq / (Vt − amount) + 1        ← +1 ekle (yukarı)
ücret:                    ceilDiv(amount · bps, 10_000)                ← tavana (yukarı)
satış, tam token girişi:  out  = amount·Vq / (Vt + amount)             ← taban (aşağı)
alım, tam quote girişi:   in   = (amount − 1)·10_000 / (bps + 10_000)  ← −1, sonra taban
```

Alıcı lehine tek bir yuvarlama, saldırganın 1 wei'lik milyonlarca işlemle curve'ü kuruş kuruş boşaltmasına izin verir. Bu, `test/invariant` altında "gidiş-dönüş bir işlem curve'ün bakiyesini asla azaltamaz" invariant'ıyla kilitlenir.

**Rezervler her zaman ücret öncesi curve tutarı kadar hareket eder.** Alımda ücret curve maliyetinin *üstüne* eklenir, satışta curve çıktısından *düşülür*; her iki durumda da rezervlere giren/çıkan miktar ücret oranından etkilenmez. Kademeli ücretin mümkün olmasının sebebi budur.

**`D` aşağı yuvarlanır**; havuza ideal miktarın en fazla 1 wei altında token gider, oluşan toz `LaunchLocker`'da kalıcı kilitlenir. **Bu 1 wei, yukarıdaki `N − S − D` artığıyla karıştırılmamalıdır** — ikisi ayrı kaynaklardan gelir. Bu satırdaki kayıp `mulDiv`'in taban yuvarlamasıdır (ihmal edilebilir); yukarıdaki 13.988,82 token'lık artık ise `N`'in `D`'den bağımsız, ayrı bir sabit olarak seçilmiş olmasından gelir ve büyüklük mertebesi tamamen farklıdır.

**Yuvarlama yönü.** Her `mulDiv` çağrısının yuvarlama yönü açıkça seçilir ve **her zaman curve lehinedir**. Alıcı lehine yuvarlama, saldırganın 1 wei'lik milyonlarca işlemle curve'ü kuruş kuruş boşaltmasına izin verir. Bu, `test/invariant` altında "gidiş-dönüş bir işlem curve'ün bakiyesini asla azaltamaz" invariant'ıyla kilitlenir.

**Taşma payı.** `k = V · T` en büyük yapılandırmada ~1,4 × 10⁴⁸ mertebesindedir; `uint256` tavanı ~1,16 × 10⁷⁷. Rahat.

### 5.3 Parametreler

Birincil (konfigürasyondan gelen) parametreler dörttür: `V`, `T`, `S`, `N`. Geri kalanı (`P₀`, `R`, `P_final`, `D`) §5.2'deki formüllerle türetilir; `N` bunlardan biri değildir, pump.fun'da olduğu gibi ayrı bir sabittir.

**Arz oranları pump.fun'dan birebir alınmıştır.** Milyonlarca launch üzerinde çalışmış sayılar; tahmin etmek yerine kanıtlanmışı kullanıyoruz.

| Parametre | Testnet | Üretim |
|---|---|---|
| Sanal token rezervi `T` | 1.073.000.000 × 10¹⁸ | aynı |
| Satış arzı `S` | 793.100.000 × 10¹⁸ | aynı |
| Toplam arz `N` | 1.000.000.000 × 10¹⁸ | aynı |
| Sanal USDC rezervi `V` | 4,292 × 10¹⁸ | **4.292 × 10¹⁸** |
| → Havuz tohumu `D = S(T−S)/T` | `206_886_011_183_597_390_493_942_218` wei (arzın %20,69'u) | aynı |
| → `N − S` (pump.fun'ın rezerve rakamı, `D` değil) | 206.900.000 × 10¹⁸ (arzın %20,69'u) | aynı |
| → Graduation `R = V·S/(T−S)` | **≈ 12,16 USDC** — alt sınır, §5.2 | **≈ 12.161 USDC** — alt sınır |
| → Fiyat katı `(T/(T−S))²` | 14,7× | aynı |
| → Açılış FDV | 4,00 USDC | **4.000 USDC** |
| → Graduation FDV | ≈ 58,78 USDC | **≈ 58.783 USDC** |
| Launch ücreti | **yok** | **yok** |
| İşlem ücreti (curve) | düz %1,25 — §5.5 Rejim 1 | aynı |
| Geliştirici ilk alımı | zincirde yok — ayrı ikinci işlem | aynı |

`D` her iki profilde de aynıdır çünkü yalnızca `S` ve `T`'ye bağlıdır ve iki profil ikisini de paylaşır; tam değeri `LaunchFactory.MIN_SALE_AND_SEED`'in türetmesinde ve `BondingCurve.poolSeedSupply` immutable'ında birebir bu sayıdır. Havuz **`D` ile tohumlanır, `N − S` ile değil** — gerekçe §5.6'dadır.

`N − S`, `D`'nin yuvarlanmış bir görünümü değildir; ikisi ayrı sayılardır ve aradaki **13.988,82 token** kalıcı olarak kilitlenir — ayrıntı ve kanıt için §5.2.

**Geliştirici ilk alımı için zincirde ne atomik bir yol ne de bir tavan vardır.** `launch` üç argüman alır, `payable` değildir ve hiçbir şey satın almaz; değer gönderen bir çağrı revert eder. Dolayısıyla geliştiricinin ilk alımı **dürüstçe ikinci bir işlemdir**: aynı bloğa girebilir ama aynı işlem değildir, ve arada başkasının alım yapabileceği bir pencere vardır. Spec'in ilk sürümündeki "satış arzının %5'i" tavanı da **hiçbir kontratta yoktur**; arayüzde gösterilecek her tavan zincirde karşılığı olmayan bir vaat olurdu. Tavanı gerçekten isteyen bir tasarım onu `launch`'ın kendisine koymak zorundadır — o da `launch`'ı `payable` yapmak ve alım yolunu factory'den geçirmek demektir; Faz 1c bunu yapmamayı seçti, çünkü curve'ün tek ticaret yüzeyi olması ve `launch`'ın hiç değer taşımaması reentrancy yüzeyini sıfırda tutuyor.

**Token oluşturmak ücretsizdir.** pump.fun'ın modeli budur — `create_v2`'nin argümanlarında hiç ücret alanı yoktur ve protokol yalnızca işlem ücretlerinden kazanır. Ponsfamily 0,0005 ETH alıyor, ama düşük sürtünme daha çok launch, daha çok launch daha çok işlem hacmi demek; gelir oradan gelir. Arc'ta gas zaten ~$0,01 olduğu için spam engeli olarak da ayrı bir ücrete ihtiyaç yok.

İki profil arasında **yalnızca `V` değişir**, tam 1000× oranında; ölçeği belirleyen tek sayı sanal quote rezervidir. pump.fun'ın yaptığı da budur — SOL'lu ve USDC'li coinler aynı token rezervlerini, farklı `initial_virtual_*_reserves` değerlerini kullanır.

**Üretim `V`'si tahmin değil, pump.fun'ın canlı `Global` hesabından okunmuştur.** `initial_virtual_quote_reserves = 4_292_000_000` (6 decimal USDC ⇒ 4.292 USDC). Bu sayının seçimi kasıtlı: açılış FDV'sini tam **4.000 USDC**'ye oturtuyor (`4292 / 1,073 = 4000`), graduation FDV'si de **58.783 USDC** çıkıyor — ki bu, §5.5'teki `stable_fee_tiers` tablosunun ilk havuz eşiği olan **59.000 USDC**'nin hemen altındadır. Eşiğin *altında* olmak, o eşiğin **altındaki** kademede kalmak demektir: token mezun olduğu anda kademe henüz atlamaz, curve'deki aynı **%0,30** creator oranıyla havuza girer. Eşiği geçmek için yalnızca **+%0,3687**'lik (**≈216,74 USDC**) küçük bir hareket yeterlidir — mezuniyeti kademe atlamasına bu kadar yaklaştırmak, creator'ı curve'ü tamamlamaya iten teşviktir (bkz. §5.5).

`whitelisted_quote_mints` alanında bugün tek bir giriş var: USDC. pump.fun'ın SOL dışı tek quote varlığı da bizimkiyle aynı.

**Testnet rakamlarının küçüklüğü zorunludur, kozmetik değildir.** Circle faucet'i istek başına 10 USDC verir. 12.161 USDC'lik bir eşikle (üretim ölçeğindeki graduation raise `R`) hiçbir token mezun edilemez, yani graduation, hook, locker ve havuz kodunun hiçbiri test edilemez. 12,16 USDC'lik testnet eşiği iki faucet talebiyle karşılanır.

**Neden 100× değil de 14,7×?** Spec'in ilk sürümü fiyat katını 100× seçiyordu, bu da havuz tohumunu arzın yalnızca %9'una düşürüyordu. Yüksek kat daha çarpıcı bir curve grafiği verir ama graduation sonrası **sığ bir havuz** bırakır: aynı büyüklükteki emir çok daha fazla slipaj yaratır. pump.fun'ın %20,69'u, curve heyecanı ile mezuniyet sonrası piyasa sağlığı arasında canlı veriyle ayarlanmış bir dengedir.

Parametreler deploy anında immutable olarak verilir; testnet ve üretim profilleri `script/` altında ayrı dosyalardır.

### 5.4 Yaşam döngüsü

Curve'de **enum yoktur; iki bool vardır** ve ikisi de tek yönlüdür. Durum üçtür:

```
!complete ──realTokenReserves == 0──▶ complete ──graduate()──▶ graduated
 (aktif)          (tamamlayan alımın içinde)     (hedefin çağrısı, ayrı işlem)
```

- **`!complete`** — curve aktif, al/sat açık.
- **`complete`** — satış arzı tükendi. Üç ticaret giriş noktasının üçü de `CurveComplete()` ile revert eder. Bu bayrak tamamlayan alımın **içinde**, her dış çağrıdan önce yazılır ve `Completed(token, realQuoteReserves, poolSeedSupply)` olayı yayılır.
- **`graduated`** — terminal. `D` token ve `R` quote graduation hedefine geri alınamaz şekilde ödendi; curve bir daha hiçbir varlık hareket ettirmez. `graduated ⇒ complete`, tersi tutmaz.

**Dört fazlı `Swept`/`PoolCreated`/`Rescued` diyagramı yazılmadı, ve bu bilinçli bir sapmadır.** O diyagram graduation'ın tamamlayan alımın *içinde* atomik olduğunu varsayıyordu; o hâlde havuz kurulumundaki bir başarısızlık `complete`'in hiç çevrilememesi demek olurdu — yani Faz 2'deki bir hata Faz 1'in ticaretini bozardı. Ölçüldü: katlanmış hâlde, reddeden bir hedefle satış arzının son diliminin alımı **sonsuza kadar** revert eder, satışlar ise çalışmaya devam eder; bricklenen şey ticaret değil **tamamlanmadır**. Ayrıldığında aynı başarısızlık yalnızca bir yeniden denemedir (§5.6). Ayrıldığı andan itibaren `pushGraduation()` da hedefin kendi izinsiz girişinden ibarettir ve `Rescued`'ın bir karşılığı kalmaz — ne 7 günlük sayaç, ne `rescue()` valfi, ne başarısızlık damgası yazılmıştır.

**Kısmi doldurma yalnızca bir giriş noktasında vardır** ve bu ayrım bağlayıcıdır:

- `buyExactQuoteIn(minTokensOut)` — bütçe kalan rezervi aşarsa **kısar**: kalanın tamamı satılır, ücret yeni anapara üzerinden yeniden alınır ve artan `msg.value` iade edilir. Slipaj `minTokensOut` ile korunur.
- `buyExactTokensOut(tokensOut, maxQuoteIn)` — **kısmaz, revert eder**: `tokensOut > realTokenReserves` ise `NotEnoughTokensToBuy()`. pump.fun'ın `buy`'unun davranışı budur.

Arayüzdeki miktar girişi ikincisini, "X USDC ile al" kısayolları birincisini kullanır (§5.8). Her iki durumda da gerçekleşen miktarlar `Trade` olayından okunmalıdır, talepten değil.

### 5.5 Ücretler

- Ücret **her zaman pairing asset'te** (native USDC) alınır, asla launch tokenında.
- Alımda ücret `msg.value`'dan curve matematiğinden **önce** kesilir; satışta curve çıktısından **sonra** kesilir. Curve rezervlerine yalnızca ücret sonrası tutar girer — §5.2'deki havuz tohumu formülünün ücretten bağımsız olmasının sebebi budur.

Ücret yapısı **iki ayrı rejimden** oluşur ve bunları karıştırmamak kritiktir. Aşağıda önce ayrım, sonra her rejim tek tek anlatılıyor.

**Ücret yapısı iki farklı rejimden oluşur ve bunları karıştırmamak kritiktir.** pump.fun'ın `fee_config` PDA'sının seed'i `["fee_config", program_id]` — yani **program başına bir tane**. Solana mainnet'te iki hesap var ve ikisi farklı şeyi tarif ediyor (2026-07-27'de çözüldü):

| Hesap | Kademe sayısı | LP | Protokol | Creator | Ne olduğu |
|---|---|---|---|---|---|
| `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` | 1 (eşik 0) | %0 | %0,95 | %0,30 | **bonding curve** |
| `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | 25 | %0,20 | %0,05 | %0,95 → %0,05 | **AMM havuzu** |

Curve'de LP payı sıfırdır — çünkü curve'de likidite sağlayıcı yoktur. `fees.png`'nin ilk iki satırı da tam bunu ayırıyor: "Bonding curve → LP %0", "0–85k havuz → LP %0,02".

### Rejim 1 — bonding curve: düz %1,25

Curve üzerindeki her alım ve satımda sabit oran: **%0,95 protokol + %0,30 creator = %1,25**. Market cap'e bakılmaz, kademe taraması yapılmaz. Faz 1'in ihtiyacı yalnızca budur.

Zincirdeki karşılığı `BondingCurve.PROTOCOL_FEE_BPS = 95` ve `BondingCurve.CREATOR_FEE_BPS = 30`'dur — **`public constant`**, yani bir launch parametresi değil kontratın bytecode'una gömülü iki sayı. Creator adresi sıfırsa creator payı hiç alınmaz ve protokol payına da **katlanmaz**; işlem sadece 30 bps daha ucuz olur.

**Ücret parçalardan toplanır, toplamdan bölünmez.** pump.fun'ın yaptığı budur:

```
ucret = feeOn(tutar, protokolBps) + feeOn(tutar, creatorBps)
```

`feeOn(tutar, 125)` hesaplanıp sonra ikiye bölünmez. Fark önemli: her iki parça da tavana yuvarlandığı için parçaların toplamı, tek seferde hesaplanan toplamı aşabilir — ölçüldü, 40.000 miktarın 20.301'inde (yaklaşık yarısında) 1 wei fazla. "Önce toplam, sonra böl" yaklaşımında bu fark escrow'un her işlemde 1 wei eksik kalması demektir; parçalardan toplandığında ise kullanıcıdan alınan tutar zaten parçaların toplamının kendisidir ve uyuşmazlık kavramsal olarak var olamaz.

Tek istisna ters yöndedir: `netQuoteIn` gibi ücret-dahil bir tutarı tersine çevirirken tek bir oran gerekir; orada `protokolBps + creatorBps` toplamı kullanılır. Bu asimetri kasıtlıdır — ileri yönde iki bağımsız tahsilat, geri yönde tek bir birleşik oran.

### Rejim 2 — graduation sonrası havuz: kademeli

Havuzda oran market cap'e göre değişir; her swap'te market cap hesaplanır ve oran o anki kademeden okunur:

```
marketCap = quoteReserve × N / baseReserve
```

Kademe seçimi: `marketCap` ilk kademenin eşiğinin altındaysa ilk kademe; değilse kademeler tersten taranır ve eşiği aşılan ilk kademe alınır. `N` mint'in gerçek arzı değil sabit arz sabitidir (§5.5 sonundaki nota bakınız).

`FeeConfig` **iki tablo** taşır: `fee_tiers` SOL-quote'lu coinler için, **`stable_fee_tiers`** stablecoin-quote'lular için. Yüzdeler aynı, eşikler farklı. USDC ile eşleştiğimiz için **doğru referans `stable_fee_tiers`'dır**; eşikleri quote token'ın taban biriminde (USDC için 6 decimal), yuvarlak dolar rakamlarıdır:

| Eşik (USDC market cap) | LP | Protokol | Creator | Toplam |
|---|---|---|---|---|
| 0 | %0,02 | %0,93 | %0,30 | **%1,25** |
| 59.000 | %0,20 | %0,05 | %0,95 | %1,20 |
| 300.000 | %0,20 | %0,05 | %0,90 | %1,15 |
| 500.000 | %0,20 | %0,05 | %0,85 | %1,10 |
| 700.000 | %0,20 | %0,05 | %0,80 | %1,05 |
| 900.000 | %0,20 | %0,05 | %0,75 | %1,00 |
| 2M | %0,20 | %0,05 | %0,70 | %0,95 |
| 3M → 10M (1M adımlarla) | %0,20 | %0,05 | %0,65 → %0,30 | %0,90 → %0,55 |
| 11M → 20M (1M adımlarla) | %0,20 | %0,05 | %0,28 → %0,05 | %0,53 → %0,30 |
| 20M+ | %0,20 | %0,05 | %0,05 | **%0,30** |

25 kademe vardır; ara basamaklar milyon başına birer adımdır. **59.000 eşiği rastgele değildir:** pump.fun'ın USDC curve'ü ~58.783 USDC FDV'de mezun olur — ilk havuz eşiğinin **hemen altında**. Token mezun olduğunda kademe henüz atlamaz, curve'deki aynı %0,30 creator oranıyla devam eder; eşiği geçmek için yalnızca ~%0,37'lik (≈217 USDC) ek bir hareket yeterlidir. §5.3'teki `V` seçimimiz bu ilişkiyi koruyor — graduation'ı eşiğin hemen altına oturtarak kademe atlamasını creator için küçük, ulaşılabilir bir sonraki adım hâline getiriyor.

**Kademe tablosu launch anında dondurulur ve bir daha değişmez.** Burada pump.fun'dan bilinçli olarak ayrılıyoruz: onların `FeeConfig`'i `admin` alanı olan global bir hesap, yani yönetici tabloyu güncellediğinde **zaten yayınlanmış** launch'ların ücreti de değişir. Bizde değişmez — creator ve alıcılar tam olarak neye girdiklerini bilir.

Bu yalnızca Rejim 2'yi (havuz kademeleri) ilgilendirir; curve'ün düz oranı zaten kontratın `public constant`'ıdır ve deploy edilmiş bir curve'de değiştirilemez.

**Rejim 2'nin dondurma mekanizması Faz 2'ye aittir ve henüz yazılmamıştır.** Spec'in ilk sürümü bunun için `FeeSchedule` adlı immutable bir kontrat öngörüyor ve `LaunchFactory`'nin o anki adresi her launch'a yazmasını istiyordu. Faz 1c o kontratı yazmadı, çünkü Faz 1'de dondurulacak bir kademe tablosu yok: curve'ün oranı zaten bytecode'da sabit — bir adres yazmaktan daha güçlü bir garanti, ve launch başına 20 baytlık depolama maliyeti de yok. Karar Faz 2'ye devredilir: kademe tablosu ya ayrı bir immutable kontratta ya da doğrudan `ArcpadHook`'un sabitlerinde yaşar. **Bağlayıcı olan şey mekanizma değil özelliktir:** bir launch'ın havuz ücretleri yayınlandıktan sonra değişmemelidir. Burada pump.fun'dan bilinçli olarak ayrılıyoruz — onların `FeeConfig`'i `admin` alanı olan global bir hesap, yani yönetici tabloyu güncellediğinde zaten yayınlanmış launch'ların ücreti de değişir.

Bunun bedeli: hatalı bir tabloyla yayınlanan launch'lar düzeltilemez. Kabul ediyoruz — düzeltilebilir bir ücret, güvenilmesi gereken bir yetki noktası demektir ve bu ürünün en temel vaadiyle çelişir.

**Ücret oranının değişmezliği ile ücret *alıcısının* değişmezliği aynı şey değildir.** Protokol payının alıcısı (`LaunchFactory.protocolTreasury`) **döndürülebilirdir** ve curve onu her yatırımda factory'den okur; ayrıntı §5.6'nın yönetişim bölümünde.

**Ücret hesabındaki iki ince nokta** (pump.fun SDK kaynağından):

- Kademe seçimi için kullanılan market cap, mint'in **gerçek arzıyla değil sabit `1e15` (bizde `1e27` wei) arz sabitiyle** hesaplanır. Tüm launch'lar aynı arza sahip olduğu için bu, market cap'i saf bir fiyat fonksiyonuna indirger.
- Ücret her zaman **tavana yuvarlanır**: `ceilDiv(amount × bps, 10_000)`.

Bu tablonun üç özelliği tasarım açısından belirleyici:

1. **Toplam ücret token büyüdükçe düşer** (%1,25 → %0,30). Spekülatif faz pahalı, likit faz ucuz — çoğu ücret şemasının tersi.
2. **Protokol curve'de %0,95, havuzda %0,05 alır.** Protokol gelirinin neredeyse tamamı graduation öncesinde kazanılır.
3. **Küçülen pay creator'ınkidir.** 59.000 USDC eşiği aşıldıktan hemen sonra %0,95 ile zirve yapar, oradan %0,05'e iner. Zirveyi getiren graduation'ın kendisi değil, onu izleyen ilk eşik geçişidir — aşağıdaki paragrafa bakınız.

Graduation'ımız — raise `R` üretimde **≈12.161 USDC**, FDV ise **≈58.783 USDC** (ikisi farklı büyüklüktür, karıştırılmamalı) — tablonun ilk havuz kademesinin eşiği olan 59.000 USDC'nin kasıtlı olarak hemen altına düşer. Token mezun olduğu anda creator payı henüz %0,30'dan %0,95'e sıçramaz; eşiği geçecek küçük ek harekete kadar aynı oranda kalır. Creator'ı curve'ü tamamlamaya iten teşvik budur — mezuniyetin kendisi değil, mezuniyetin hemen ardından gelen o küçük ve ulaşılabilir sıçrama.

`BuybackVault` protokol payından beslenir; creator kendi payının bir dilimini oraya yönlendiren anahtarı isteğe bağlı açabilir. Varsayılan **kapalıdır**; creator açabilir ama tek başına geri kapatamaz (protokol devre dışı bırakabilir).
- Ücretler `FeeEscrow`'da birikir ve **çekilir, gönderilmez**. Bir alıcının native kabul etmemesi başkalarının ücretini kilitleyemez — Arc'ta sözleşmelere native gönderimin başarılı olacağı garanti olmadığı için bu bir tercih değil, zorunluluktur.
- Graduation sonrası hook, ücreti token cinsinden tahsil edebilir; dağıtımdan önce pairing asset'e çevrilir.

**Havuzun kendi ücreti sıfırdır, ücreti hook alır.** Sebep: V4'te havuz ücreti otomatik olarak LP'lere gider, ama bizim tek LP'miz kalıcı kilitli `LaunchLocker`'dır — ücret sonsuza kadar kilide akar ve kimse alamazdı. Hook'ta tahsil etmek, creator/protokol bölüşümünü graduation öncesiyle birebir aynı tutmayı sağlar.

### 5.6 Graduation ve havuz kurulumu

**Graduation tamamlayan alımın içinde değildir; ayrı bir çağrıdır.** Gerekçe §5.4'te: katlanmış hâlde Faz 2'deki bir başarısızlık Faz 1'in son alımını kalıcı olarak bozar, ayrılmış hâlde aynı başarısızlık bir yeniden denemedir.

**Curve tarafı — yazıldı ve donduruldu.** `graduate() external returns (uint256 baseAmount, uint256 quoteAmount)`, ve sırası bağlayıcıdır:

1. **Doğrula.** `!complete` → `NotComplete()`. `graduated` → `AlreadyGraduated()` (ikinci çağrı sessiz bir no-op **değildir**; pump.fun'ın tersine). Hedef `LaunchFactory.graduationTarget()`'tan **STATICCALL** ile okunur; `address(0)` → `GraduationTargetUnset()`; `msg.sender != target` → `NotGraduationTarget()`.
2. **Defteri yaz.** `graduated = true` — tek bir SSTORE, ve `complete` ile aynı slota paketlenir (ölçüldü: slot 5, offset 1), yani kontrat yeni bir slot kazanmaz.
3. **Olay.** `Graduated(token, to, baseAmount, quoteAmount)`; `to` indekslidir çünkü hedef yeniden işaretlenebilir.
4. **Dış çağrılar.** `IERC20(token).transfer(target, D)`, sonra `target.call{value: R}("")`; ikincisi başarısızsa `GraduationPayoutFailed()`.

**Miktarlar immutable'dan ve defterden okunur, hiçbir bakiyeden değil:** `baseAmount = poolSeedSupply` (`D`), `quoteAmount = realQuoteReserves` (`R`). Sebep ekonomik değil epistemiktir. Arc'ta üçüncü bir taraf curve'ün **iki** bakiyesini de curve'de hiçbir kod çalıştırmadan artırabilir — canlı ölçüm: 6 decimal ERC-20 görünümünden yapılan bir `transfer` hedefin native bakiyesini artırdı ve `receive()` hiç çalışmadı. Bakiye okuyan bir hâl, §10 invariant 6'yı "bağış olmadığı sürece" geçerli bir iddiaya çevirirdi: kimsenin uygulayamayacağı bir ön koşul ve hiçbir testin kazara ihlal etmeyeceği bir sessizlik. Ölçüldü: +7 ether native ve +1000e18 token bağışıyla bile dönen değerler tam olarak `(D, R)`'dir ve bağışlar curve'de kalıcı kilitlenir. **Bu aynı zamanda pump.fun'dan bilinçli bir sapmadır** — upstream havuzu curve'ün kalan tüm token bakiyesiyle (`N − S`) tohumlar; `N − S` ile havuz `P_final`'in %0,0068 **altında** açardı ve invariant 6 bir eşitlik olarak düşerdi.

**Bayrak ödemeden önce yazılır ve atomiklik yeniden denenebilirliği sağlar.** Ödeme başarısız olursa işlemin tamamı — SSTORE dahil — geri alınır. Ölçüldü: `receive()`'i revert eden bir hedefte `GraduationPayoutFailed()` döner, `graduated` hâlâ `false`, token transferi geri alınmış ve curve `R`'yi tutuyor; hedef onarıldıktan sonra **aynı çağrı başarır ve aynı `(D, R)`'yi döndürür**. Reddeden bir hedef bir launch'ı geciktirir, strand edemez. Bayrağı çağrıların arkasına almak (pump.fun'ın Solana sırası) hedefin `receive()`'inden yapılan geri girişin başarmasına ve hedefin `2D`/`2R` almasına yol açardı.

**`graduate()`'i yalnızca çözülmüş hedef çağırabilir.** İzinsizlik bir seviye yukarı, hedefin kendi girişine taşınır — pump.fun'ın özelliği orada birebir yeniden üretilir. Gerekçe: değer transferi alıcının kodunu **curve'ün çağrı çerçevesinde** çalıştırır, ve keyfi bir çağıran bunun *ne zaman* olacağını seçebilseydi bu `FeeEscrow` kısıt (2)'nin aynen tekrarı olurdu. Kontrol ayrıca üçüncü bir tarafın kurtarılamaz duruma (hedef kabul eder ama tohumlayamaz) zorlamasını imkânsız kılar. Ama kontrol kararı **yeniden konumlandırır, ortadan kaldırmaz**: Faz 2'nin seeder'ı izinsiz olacağı için o noktada herhangi biri tamamlanmış bir curve'e kabul ettirebilir; accept-then-fail'i yalnızca hedefin kendi çerçevesi engelleyebilir.

**Graduation ücreti yoktur — "şimdilik sıfır" değil, yapısal sıfır.** Ücret yalnızca `R`'den alınabilir çünkü `D` immutable'dır; `R − f` değişmemiş bir `D`'ye karşı havuzu `P_final`'in `f/R` altında açar. Ölçeklendi: 2 USDC'lik bir ücret 164,5 ppm'dir, yani bu spec'in `N − S` gerekçesiyle zaten yasakladığı 67,6 ppm'lik süreksizliğin **2,6 katı**.

> pump.fun'ın buradaki `pool_migration_fee`'si (15.000.001 lamports) Solana'nın hesap kirası içindir. Arc'ta böyle bir maliyet yoktur, dolayısıyla karşılığı da yoktur.

**Curve'de olmayan ve olmaması gereken şeyler** — liste kendisi taşıyıcıdır, çünkü buraya giren her şey kalıcıdır: `graduateTo(address)` yok (çağıranın seçtiği hedef, fazladan bir adımla hırsızlıktır); curve'de `setGraduationTarget` yok; `onGraduation(...)` callback'i yok (Faz 2'nin selector'ünü sonsuza kadar gömmeye gerek yok); `sqrtPriceX96`, `TickMath`, karekök yok — kapanış fiyatı mevcut iki getter'dan **tam** okunur (`virtualQuoteReserves / virtualTokenReserves`, ölçüldü: tamamlanmada sırasıyla `V + R_actual` ve `T − S`) ve `graduate()` ikisini de mutasyona uğratmaz; `pool`/`poolId`/`poolKey` yok; artığın (`N − S − D`) ya da bağışların sweep'i yok; owner, pause, `graduated`'ı temizleyen hiçbir yol yok.

**Hedef tarafı — Faz 2, henüz yazılmadı.** Hedefin izinsiz girişi curve'ün `graduate()`'ini çağırır, `(D, R)`'yi alır ve **aynı işlemde**: V4 havuzunu `initialize` eder (`sqrtPriceX96 = sqrt(R/D)`, `P_final`'den değil — §5.2, `R` yola bağlıdır); `LaunchLocker` `PoolManager.unlock` geri çağrısı içinde tam aralık (`MIN_TICK`–`MAX_TICK`) likidite ekler; likiditeye dönüşmeyen toz `LaunchLocker`'da kalıcı kilitlenir. Faz 2'nin borçları, her biri adıyla:

1. **`O-ATOMIC-SEED`** — hedefin girişi işi tek işlemde bitirmeli ve herhangi bir başarısızlıkta revert etmelidir. "Al" ile "tohumla"yı ayrı işlemlere bölen bir hedef, tek kurtarılamaz durumu (hedef kabul etti ama tohumlayamadı) **bilerek** yeniden yaratır.
2. **`O-BARE-RECEIVE`** — hedefin `receive()`'i çıplak bir kabul olmalıdır. Somut içeriği ölçülmüş çapraz-curve penceresidir: curve A'nın ödemesi sırasında hedefin `receive()`'i curve B'yi mezun edebilir ve çağıran kontrolü geçer, çünkü `msg.sender` hedefin kendisidir.
3. **`O-REPOINTABLE`** — hedef yeniden işaretlenebilir olmalıdır; factory tarafında karşılanmıştır (aşağıda).
4. **`O-BATCH-TRYCATCH`** — toplu bir keeper girişi (`graduateMany([...])`) her curve'ü `try/catch` ile sarmalıdır, aksi halde zaten mezun olmuş tek bir curve bütün partiyi revert ettirir.
5. **`O-TREASURY-PER-DEPOSIT`** — protokol ücreti yönlendiren her Faz 2 kontratı treasury'yi **her yatırımda** `LaunchFactory.protocolTreasury()`'den çözmelidir, asla kurulumda önbelleğe almamalıdır. Pool creation anında önbelleğe alan bir hook, ilk rotasyondan sonra **sonsuza kadar eski adrese ödemeye devam eder**.

**İsim çakışması — kayda geçiriliyor.** Curve `Graduated` yayınlar. Faz 2'nin havuz/locker katmanı **`Graduated` adını kullanamaz**: iki kontratın farklı şekilli iki olay yayması indexer için bir tuzaktır, çünkü topic0 ayrışır ve birine göre yazılmış bir filtre ötekini sessizce boş döndürür. Faz 2'nin olayının adı **`PoolSeeded`** olmalıdır.

#### Yönetişim — iki döndürülebilir üye

Factory'nin `governor`'ı **immutable**'dır ve yalnızca iki yetkisi vardır; launch edemez, duraklatamaz, bir curve'e dokunamaz. Bir Safe olması beklenir, anahtar rotasyonu orada yaşar.

| Üye | Kim değiştirir | Gecikme | Neden |
|---|---|---|---|
| `graduationTarget` | `proposeGraduationTarget` (governor) → `applyGraduationTarget` (**izinsiz**) | **3 gün** ihbar, ardından **3 günlük inme penceresi** — ikisi de kamuya açık | Hedef bir launch'ın **tüm** raise'ini alır, ve `graduate()` çağrı anında okuduğu için bir yeniden işaretleme zaten tamamlanmış curve'lerin ödemesini de yeni adrese yönlendirir. Üç günlük ihbarda herkes o curve'leri mevcut hedefe boşaltabilir. |
| `protocolTreasury` | `setProtocolTreasury` (governor) | **yok, anında** | Gecikmenin karşılığı olan çare burada yoktur: rotasyon birikmiş `owed[eski]`ye dokunmaz, eski adres onu aynen talep etmeye devam eder — kamunun "önce boşalt" diye yapacağı bir şey yok. Buna karşılık bedeli somuttur: bloklanmış bir treasury'de geçen her gün, hiçbir zaman talep edilemeyecek alacak olarak birikir. |

**Pencere iki taraftan da sınırlıdır: `[eta, eta + 3 gün]`.** Yalnızca alttan sınırlı bir pencere, süresi geçmiş ama indirilmemiş bir öneriyi **sonsuza kadar silahlı** bırakırdı — ve gecikmenin tek çaresi tam olarak öneri anında **boş** olan kümeyi korur. Ölçülen senaryo: gün 0'da, tamamlanmış hiç curve yokken bir hedef önerilir (kimse itiraz etmez, boşaltılacak bir şey yoktur), gün 3'te pencere açılır ve kimse indirmez, gün 368'de iki launch tamamlanmıştır ve tek bir işlem `applyGraduationTarget()` + iki `graduate()` yapar; hırsızlık anındaki ihbar süresi **sıfırdır**. Üst sınır bunu kapatır: ihbar ile inme arasındaki mesafe ihbar süresini aşamaz, yani toplam maruziyet en fazla **6 gündür**. Süresi geçen öneri `GraduationTargetProposalExpired()` ile reddedilir; çare yeniden önermek ve üç gün daha beklemektir. İkinci bir sabit yoktur — sınır `eta + GRADUATION_TARGET_DELAY` olarak yazılır, çünkü indirme adımı **izinsizdir** ve `eta` üç gün önceden bilinen public bir değişkendir: o adımın koordinasyon maliyeti yoktur, dolayısıyla pencere "bir Safe ne kadar sürede imzalar" ile değil "ihbar ne kadar bayatlayabilir" ile boyutlandırılır.

**Hedef atanana kadar `graduationTarget` `address(0)`dır** ve o hâlde her `graduate()` çağrısı `GraduationTargetUnset()` ile döner. Bu, Faz 1'in Faz 2'den **önce** deploy edilip launch etmesine izin veren şeydir; hedef çağrı anında çözüldüğü için curve'e ne bir slot ne bir constructor argümanı ekler. Tek seferlik bir latch riskli değil, geliştirme yoluyla bağdaşmaz olurdu: Arc'ın hiçbir yerinde Uniswap V4 yoktur — dört kanonik `PoolManager` adresi de 5042002 zincirinde kodsuzdur — yani ilk hedef kendi deploy ettiğimiz bir şey olacak ve mainnet'ten önce en az bir kez değişecektir.

**Protokol payının alıcısı curve'de kopyalanmaz, `protocolTreasury()` ile her yatırımda factory'den okunur.** `FeeEscrow` kısıt (4) Faz 1c'ye yazılı bir borç bırakmıştı — "protokol ücret alıcı adresi döndürülebilir olmalıdır" — ve o borcu ödeyen tek "döndürülebilir" tanımı budur: rotasyon **zaten canlı** curve'lere de ulaşır. Kopya tutan bir hâlde Arc treasury'yi bloklasa ticaret çalışmaya devam eder (alacak pull-based'dir), `owed[treasury]` sınırsız büyür, `claim` revert eder ve hiçbir yol yeniden yönlendirmez. Bedeli ölçüldü ve dürüstçe kaydedildi: bir işlemin **ilk** ticaretinde +5.514 gaz (+%2,96 — 2.600 adres erişimi + 2.100 soğuk SLOAD + ~814), sıcakta +1.014, `graduate()`'te **sıfır** (graduation ücret almaz, dolayısıyla bu okumayı hiç yapmaz). Arc'ın ~0,01 USD'lik işlem maliyetinde %3 ≈ 0,0003 USD'dir; alternatif, bloklanmış bir treasury'de o curve'ün gelecekteki tüm protokol payını kaybetmektir. **Birikmiş alacak taşınmaz:** `owed[eski]` escrow'da aynen kalır; rotasyon yalnızca bundan sonraki yatırımların alıcısını değiştirir.

`FeeEscrow` bu asimetrinin diğer ucudur ve **immutable kalır**: escrow birikmiş alacakları tutar, onu döndürmek geçmiş ücretleri yeni bir deftere taşımaz, yalnızca defteri çatallar.

**Hook adres madenciliği.** V4'te hook adresinin son bitleri hangi izinlere sahip olduğunu kodlar. `ArcpadHook` için gereken bayraklar: `BEFORE_INITIALIZE` (havuzun bize ait olduğunu doğrulamak), `BEFORE_SWAP` ve `BEFORE_SWAP_RETURNS_DELTA` (girdi üzerinden ücret kesmek). Deploy script'i, bu bayraklara uyan bir adres üretene kadar CREATE2 salt'ını arar. Sıradan bir `forge create` yeterli değildir.

### 5.7 Creator kontrolleri ve topluluk devri

Creator launch sonrası **yalnızca** şunları yapabilir:

- Ücret alıcı cüzdanını değiştirmek
- Buyback'i kapatmak (açmak protokol iznine tabidir)

Creator **yapamaz:** token basmak, ücret oranını değiştirmek, pairing asset'i değiştirmek, kilitli likiditeye dokunmak.

Creator projeyi terk ederse ücret akışı iki yolla devredilebilir:

- **Gönüllü:** creator alıcıyı doğrudan yeni cüzdana taşır.
- **Protokol önerili:** protokol yeni bir alıcı önerir, **3 gün** kamuya açık bekleme süresi işler, sonra uygulanır. Bu pencerede holder'lar çıkabilir veya örgütlenebilir.

**Bu bölümün tamamı Faz 1c'de henüz yazılmamıştır ve arayüz bugün bunlardan hiçbirini gösteremez.** Zincirdeki hâl: `BondingCurve.creator` **immutable**'dır, creator payı doğrudan o adrese yatırılır ve `FeeEscrow` alacakları alıcı adresine göre anahtarlar — ne curve'de ne escrow'da bir yeniden atama yolu vardır. Dolayısıyla creator launch sonrası **hiçbir şey yapamaz**; yapabildiği tek şey `FeeEscrow.claim(creator)`'dır, o da zaten izinsizdir ve alıcıyı değiştirmez. Faz 1c'de fiilen var olan 3 günlük gecikme bu değil, `graduationTarget`'ınkidir (§5.6); döndürülebilir olan tek ücret alıcısı da **protokolünküdür**, creator'ınki değil. Yukarıdaki iki yol Faz 5'in işidir ve §5.8'deki creator fee sharing ile aynı yere oturur — o faz geldiğinde alıcı adresi curve'ün immutable'ından bir registry'ye taşınmak zorundadır; bunu `BondingCurve`'ün mevcut bytecode'una eklemek mümkün değildir.

### 5.8 pump.fun'dan öğrenilen ek özellikler — karar

Aşağıdakiler ponsfamily dokümanlarında hiç geçmiyor; pump.fun'ın resmî dokümanlarından öğrenildi. Her biri için karar:

| Özellik | pump.fun'daki hali | arcpad kararı |
|---|---|---|
| **Kademeli ücret** | Market cap'e göre %1,25 → %0,30 | **Benimsendi** (§5.5). Düz %70/%30'un yerini aldı. |
| **Arz oranları** | 793,1M satış / 206,9M havuz | **Benimsendi** (§5.3). 909,9M/90,1M tahminimizin yerini aldı. |
| **Creator başına tek vault** | `["creator-vault", creator]` — bir creator'ın tüm coinlerinin ücreti tek yerde | **Benimsendi.** `FeeEscrow` zaten alıcı adresine göre anahtarlı (`mapping(address => uint256) public owed`; tek varlık native USDC, özel pairing asset kapsam dışı — §2); coin başına ayrı kova gerekmiyor ve claim maliyetini düşürüyor. |
| **İzinsiz ücret süpürme** | `collect_creator_fee_v2` permissionless; fon her hâlükârda creator'a gider | **Benimsendi.** Claim'i herkes tetikleyebilir, alıcı değişmez. Creator'ın gas'i yoksa bile ücreti kilitli kalmaz. |
| **Creator fee sharing** | ≤10 paydaş, `share_bps` toplamı 10.000, **bir kez** set edilir sonra admin iptal | **Faz 5'e alındı.** Ekip launch'ları için gerçek bir ihtiyaç ve §5.7'deki topluluk devri mekanizmasıyla aynı yere oturuyor. Tek seferlik olması kritik: aksi halde creator paydaşları sonradan tasfiye edebilir. |
| **Cashback** | Creator ücretini, işlem hacmine oranla trader'lara geri verir | **Kapsam dışı (Faz 7 sonrası).** Kullanıcı başına hacim biriktirici gerektiriyor — kontrat ve indexer tarafında ayrı bir alt sistem. Ürün olarak güçlü ama Faz 0-7'yi taşımaz. |
| **Mayhem modu** | Coin başına bayrak, ayrı ücret alıcı kümesi | **Kapsam dışı.** Resmî dokümanlar ne yaptığını açıklamıyor; anlamadığımız bir mekanizmayı kopyalamıyoruz. |
| **Ayrı buyback ücret alıcısı** | Her işlemde `feeRecipient` + `buybackFeeRecipient` | **Benimsendi**; `BuybackVault` bu rolü üstleniyor. |
| **Çoklu ücret alıcısı (8 adet)** | Solana'da hesap yazma çakışmasını dağıtmak için | **Reddedildi.** EVM'de böyle bir çakışma yok; tek escrow kontratı yeterli. |
| **Kısmi doldurma** | `buy`'da yok ama ayrı bir instruction var: `buy_exact_quote_in_v2(spendable_quote_in, min_tokens_out)` — "şu kadara kadar harca", kalan kadarını verir, slipaj `min_tokens_out` ile korunur | **Benimsendi, iki giriş noktası olarak.** İlk taslak `buy`'ı gevşetip kısmi doldurma yapacaktı; kaynağa bakınca daha temiz olanı görüldü. Zincirdeki isimler: **`buyExactTokensOut(tokensOut, maxQuoteIn)`** kalandan fazlası istenirse `NotEnoughTokensToBuy()` ile revert eder, **`buyExactQuoteIn(minTokensOut)`** — bütçe `msg.value`'dur, ayrı bir argüman değil — kalanı doldurup fazlayı iade eder. Arayüzdeki miktar girişi birincisini, "X USDC ile al" kısayolları ikincisini kullanır. |
| **Metadata sınırları** | isim ≤32, sembol ≤13, uri ≤200 | **Benimsendi** (ponsfamily'nin 10 karakterlik ticker sınırı yerine 13). |

---

## 6. Veri katmanı

### 6.1 Indexer

Tek bir TypeScript süreci. viem ile `eth_getLogs` çeker; imleç `sync_state` tablosunda tutulur ve her turda son işlenen bloktan `finalized` etiketine kadar okur.

Arc'ta reorg olmadığı için geri alma mantığı yazılmaz. Buna rağmen her satır `(tx_hash, log_index)` üzerinde **idempotent upsert** edilir, çünkü süreç yeniden başladığında aynı logları tekrar görmek normaldir. Blok grubu başına tek veritabanı transaction'ı: ya hepsi yazılır ya hiçbiri.

**Dinlenen olaylar — zincirdeki adlarıyla:** `LaunchFactory.Launched(token, curve, creator, name, symbol, uri, salt)`; `BondingCurve.Trade(...)` — **al ve sat tek olaydır**, yön `isBuy` alanındadır ve olay dört rezervin dördünü de taşır, böylece indexer her işlemden sonraki durumu zincire tekrar sormadan yeniden kurar; `BondingCurve.Completed(token, realQuoteReserves, poolSeedSupply)`; `BondingCurve.Graduated(token, to, baseAmount, quoteAmount)`; `FeeEscrow.Deposited`, `FeeEscrow.Claimed`; `LaunchToken.Transfer`; ve graduation sonrası Faz 2'nin `PoolSeeded`'ı ile `PoolManager.Swap`.

Yönetişim olayları da izlenmelidir, çünkü ikisi de para akışını değiştirir: `GraduationTargetProposed(target, eta)` — bir keeper yalnızca bunu izleyerek "üç gün içinde boşaltılması gereken curve'ler" listesini kurabilir (§5.6) — `GraduationTargetChanged` ve `ProtocolTreasuryChanged`.

Ayrı `LaunchCreated` / `Bought` / `Sold` olayları **yoktur**; spec'in ilk sürümündeki bu adlar zincirde karşılık bulmaz.

**EIP-7708 tuzağı:** Arc'ta her native transfer de sistem adresinden bir `Transfer` logu yayınlar. Holder tablosu doldurulurken emitter adresi mutlaka ilgili `LaunchToken` adresine göre filtrelenmelidir; aksi halde USDC hareketleri token bakiyesi sanılır.

### 6.2 Şema

| Tablo | İçerik |
|---|---|
| `sync_state` | Indexer imleci: son işlenen blok, son çalışma zamanı |
| `tokens` | Adres, curve, creator, metadata, `launchSalt`, arz parametreleri, `complete` / `graduated` bayrakları (§5.4 — enum yok), pool id, oluşturulma zamanı |
| `trades` | Her al/sat: taraf, miktarlar, fiyat, ücret, tx, blok, zaman, `source ∈ {curve, pool}`, `is_dev` |
| `holders` | `(token, holder) → balance`, `Transfer`'lardan türetilir |
| `candles` | 1 dakikalık OHLCV; 5M/1H/6H/1D/ALL görünümleri bunlardan toplanır |
| `token_stats` | Denormalize: market cap, likidite, 24s hacim, ATH, holder sayısı, `last_trade_at`, `last_buy_at` |
| `protocol_stats_daily` | Günlük hacim, launch sayısı, işlem sayısı, protokol geliri, creator kazancı, tekil dev sayısı |
| `chat_messages` | Token, yazar, gövde, zaman, gönderi anındaki bakiye |
| `limit_orders` | Token, sahip, taraf, tetik fiyatı, miktar, durum |
| `fee_balances` | `recipient → claimable`, `FeeEscrow.Deposited` / `FeeEscrow.Claimed` olaylarından türetilir (tek varlık: native USDC) |

`trades` tablosunda `source` alanı curve ve havuz işlemlerini **tek tabloda** birleştirir. Bir token graduate olduğunda fiyat geçmişi kopmaz; ayrı tablolar kullanılsaydı bu süreklilik sonradan birleştirilmek zorunda kalırdı.

`token_stats` denormalizasyonu zorunludur: Explore sayfası yüz binlerce token arasında "market cap'e göre sırala, son 24 saat" diyebilmelidir. Bu, her istekte `trades` üzerinden toplanarak yapılamaz — indexer yazarken bu tabloyu da günceller.

### 6.3 Okuma yolu

- **Liste ve geçmiş** — server component'lerden doğrudan Postgres sorgusu. Araya ayrı bir API katmanı konmaz.
- **API route'ları yalnızca yazma için** — chat mesajı gönderme, limit emir oluşturma.
- **İşlem anındaki kota indexer'dan değil, zincir durumundan hesaplanır.** Kullanıcının imzaladığı fiyat, indexer'ın kaç saniye geride olduğuna bağlı olamaz. Ama **kotanın kendisi zincirde hesaplanamaz:** `BondingCurve`'de `quoteBuy()`/`quoteSell()` diye bir üye yoktur, hiçbir view kota fonksiyonu yoktur, ve `CurveMath`'in tamamı `internal`'dır — yani `eth_call` ile çağrılabilecek bir yüzey mevcut değildir. Okunacak şey dört rezervdir (`virtualQuoteReserves`, `virtualTokenReserves`, `realTokenReserves`, `realQuoteReserves`) ve bunlar zaten `public` getter'lardır; tek bir Multicall3 çağrısı dördünü de bir blokta getirir.

  Bunun sonucu: **`CurveMath`'in bire bir TypeScript portu bir kolaylık değil, taşıyıcı bir bileşendir.** `packages/shared` altında yaşar ve zincirle aynı yuvarlamayı yapmak zorundadır — `quoteBuyCost`'un koşulsuz `+1`'i, `feeOn`'un tavana yuvarlaması, `quoteBuyTokensOut`'un curve teriminin **içindeki** `−1`'i, ve `correctedNetQuoteIn`'in ücretleri düzeltme **öncesi** net üzerinden alıp bir daha hesaplamaması dahil. pump.fun'ın kendi SDK'sının zincirden ayrıştığı yer tam olarak burasıdır: `getBuyTokenAmountFromSolAmount` 200.000 örneğin %51,16'sında zincirden **fazla** token vaat ediyor, ve sapmanın yönü her seferinde aynı. Portun doğruluğu bir tahmin değil, ABI-parity testiyle aynı sınıfta bir CI kapısıdır (§10).

  **Slipaj koruması kotadan gelmez, argümandan gelir.** Üç giriş noktasının üçü de kendi sınırını taşır — `buyExactTokensOut(tokensOut, maxQuoteIn)`, `buyExactQuoteIn(minTokensOut)`, `sellExactTokensIn(tokensIn, minQuoteOut)` — ve sınırlar kullanıcının fiilen ödediği/aldığı **net** tutara karşı tutulur, ücret öncesi curve tutarına karşı değil. Yerel hesaplama yanılsa bile zarar bu sınırlarla çevrilidir.

- **Graduation sonrası** kota V4 üzerinden okunur; o yol Faz 2'dedir.

**"Recent buys" sıralaması:** `token_stats.last_buy_at` üzerinde azalan sıra — yani en son alım işlemi gerçekleşen token en üstte. Etiketin harfi harfine karşılığı budur ve tek indeksli kolonla yüz binlerce satırda anlık çalışır. Momentum tabanlı bir sıralama daha "akıllı" olurdu ama kullanıcı "Recent buys" yazısına tıklarken yeniliği bekler, ivmeyi değil; etiket ile davranış ayrışmamalıdır.

---

## 7. Frontend

### 7.1 Sayfalar

| Rota | İçerik |
|---|---|
| `/` | Explore. Üstte "Graduated" bölümü (kart ızgarası + sayfalama), altta "Explore" bölümü: sıralama (Recent buys / Newest / Oldest / Market cap / Volume) + yaş (All / 24h / 7d) + ızgara + sayfalama |
| `/token/[address]` | About paneli (açıklama, token ve curve adresleri — ikisi de ArcScan'e) · sol al-sat paneli (Market / Limit / Orders, slippage, %25–100 kısayolları) · orta grafik (market cap, likidite, 24s hacim, ATH, zaman aralıkları) · sağ chat · altta Recent trades / Holders sekmeleri |
| `/create` | Launch formu (isim ≤32, ticker ≤13, açıklama, görsel + IPFS onayı, X, Telegram) + sağda canlı önizleme kartı |
| `/analytics` | 24h / All time geçişi, istatistik ızgarası, günlük hacim ve launch bar grafikleri |
| `/profile/[address]` | Launch'lar, pozisyonlar, işlem geçmişi, talep edilebilir ücretler |
| ⌘K modal | Tam ekran arama: sıralama + yaş filtresi + sonuç satırları + sayfalama |

**About panelinde "Burned" satırı yoktur, çünkü yakma yolu yoktur.** `LaunchToken` OpenZeppelin'in `ERC20`'sidir ve `burn` fonksiyonu taşımaz; `to == address(0)`'a yapılan bir transfer OZ'un içinde `ERC20InvalidReceiver` ile revert eder. Native tarafta da yakılamaz: Arc sıfır adrese native transferi yasaklar (§3.3). Gösterilecek bir sayı olmadığı için satırın kendisi kaldırıldı — sıfır göstermek "yakılabilir ama yakılmamış" der ve bu da yanlıştır.

**Havuz linki Faz 1'de yoktur** — henüz havuz yoktur. Faz 2'de eklenecek link ArcScan'e gider; Dexscreener ve GeckoTerminal §2'de kapsam dışıdır ve testnet'te zaten çalışmaz (§13). Faz 1'de About panelinin gösterdiği iki adres token ve curve'dür; curve adresi burada durmalıdır, çünkü kullanıcının fonu curve'dedir ve `isCanonical` ile doğrulanabilecek olan da odur.

**Create formunda "Advanced" bölümü yoktur, çünkü içine konacak bir şey yoktur.** `launch` üç argüman alır — `name`, `symbol`, `uri` — ve başka her parametre (`V`, `T`, `S`, escrow, treasury, governor) factory'nin immutable'ıdır; hiçbiri launch başına seçilemez. Formun geri kalan alanları (açıklama, görsel, X, Telegram) `uri`'nin arkasındaki IPFS metadata'sına gider, zincire ayrı ayrı değil. Geliştirici ilk alımı da formda değildir: `launch` `payable` olmadığı için o **ayrı bir ikinci işlemdir** (§5.3) ve arayüz onu launch başarıyla indikten *sonra* teklif etmelidir — form içinde tek bir "başlat ve al" düğmesi göstermek, kullanıcıya atomik olmayan bir şeyi atomik gibi sunmak olurdu.

### 7.2 Bileşenler

```
web/
├── app/
│   ├── layout.tsx                 header + footer + providers
│   ├── page.tsx                   Explore
│   ├── token/[address]/page.tsx
│   ├── create/page.tsx
│   ├── analytics/page.tsx
│   ├── profile/[address]/page.tsx
│   └── api/chat/route.ts, api/orders/route.ts
├── components/
│   ├── layout/     Header, Footer, ThemeToggle, WalletButton
│   ├── explore/    TokenCard, TokenGrid, FilterBar, Pagination, GraduatedSection
│   ├── search/     SearchModal, SearchResultRow
│   ├── token/      AboutPanel, TradePanel, PriceChart, ChatPanel, TradesTable, HoldersTable
│   ├── create/     LaunchForm, ImageUpload, TokenPreviewCard
│   ├── analytics/  StatGrid, DailyBarChart, RangeToggle
│   └── ui/         Button, Input, Tabs, Pill, Card, Skeleton
├── hooks/          useLaunch, useTrade, useTokenStats, useChat
└── lib/            db, chain, format, brand, abi (packages/shared'den),
                    curve (CurveMath portu — saf fonksiyon, hook değil)
```

**`useQuote` diye bir hook yoktur ve olmamalıdır.** Kota bir React durumu değil, dört rezervin saf bir fonksiyonudur (§6.3): aynı girdi her zaman aynı çıktıyı verir ve zamana, render'a ya da bir cache'e bağlı değildir. Bir hook'un arkasına konması iki kod yolu doğurur — biri ekranda gösterilen sayı, öteki `writeContract`'a giden calldata — ve bu ikisi ayrıştığında kullanıcı gördüğünden farklı bir işlem imzalar. Saf fonksiyon her ikisini de aynı çağrıdan besler; rezervleri getiren şey (`useReadContracts` / Multicall3) ayrı bir katmandır ve kotayı hesaplamaz, yalnızca girdisini taşır.

**wagmi 3'te `useAccount` kullanılmamalıdır.** Kurulu sürümde (`wagmi@3.7.4`) `useAccount`, `useConnection`'ın `@deprecated` işaretli bir takma adıdır — `exports/index.d.ts` onu `useConnection as useAccount` diye yeniden ihraç eder; aynısı `useAccountEffect` → `useConnectionEffect` için de geçerlidir. `WalletButton` ve cüzdana bakan her bileşen doğrudan `useConnection` kullanır.

### 7.3 Tasarım tokenları

Ekran görüntülerinden çıkarılmıştır:

```
bg          #0B0B0B      surface  #141414     border  rgba(255,255,255,.08)
text        #FAFAFA      muted    #8A8A8A
accent      #C6F24E      (lime — grafikler, vurgular, "Graduated" rozeti)
primary     #7E8F2E      (zeytin — birincil CTA butonları)
radius      kart 20px · pill 999px · input 14px
tipografi   henüz seçilmedi — bkz. aşağıdaki not
```

**Birincil CTA'nın metni koyudur, beyaz değil — ve bu ekran görüntülerinden bilinçli bir sapmadır.** Referans arayüz zeytin `#7E8F2E` zemin üzerine beyaz metin kullanıyor; ölçüldü, kontrast **3,59:1** ve WCAG AA'nın normal metin için istediği 4,5:1'in altında kalıyor. Aynı zeminde `#0B0B0B` metin **5,49:1** verir. Değişen tek şey metin rengidir; palet yukarıdaki paletin aynısıdır. Hover'da zemin `#C6F24E`'ye çıkar ve metin aynı kalır. Bu bir yorumda değil bir kapıda durmalıdır: `web/test/contrast.test.ts` `globals.css`'i okuyup token çiftlerini çözer ve her çiftin eşiğini iddia eder, yani bir token karardığında test kırılır.

**Tipografi henüz bir karar değil, bir boşluktur.** Spec'in ilk sürümü "serif wordmark + geometrik sans gövde" diyordu; iskelet **hiçbir font yüklemiyor** — `web/app/layout.tsx`'te `next/font` çağrısı, `globals.css`'te `@font-face` ya da `font-family` yok — dolayısıyla bugün render edilen şey tarayıcının sistem yığınıdır ve platformdan platforma değişir. İki sonuç: (1) tipografi kararı Faz 4'te açıkça verilmeli ve fontlar **kendi sunucumuzdan** servis edilmelidir; (2) o karar verilene kadar hiçbir ekran görüntüsü ya da tasarım incelemesi "spec'teki tipografi" diye bir şeye dayanamaz, çünkü öyle bir şey uygulamada yok.

**Locale açıkça sabitlenir: `en-US`, nokta ondalık.** Referans ekran görüntülerindeki `0,0005` ve `$57,53M` biçimleri pons'un tercihi değil, tarayıcının `tr-TR` locale'iydi — site `Intl.NumberFormat`'i locale sabitlemeden kullanıyor. Kripto arayüzünde `1,234` bir kullanıcı için "bin iki yüz otuz dört", diğeri için "bir virgül iki üç dört" demektir; para söz konusuyken bu belirsizlik kabul edilemez.

**İsim gösterimi:** Arc'ta ENS yoktur. Kullanıcılar kısaltılmış adresle gösterilir (`0x92FB…b4bA`). Arc kendi isim servisini çıkarırsa buraya bağlanır.

---

## 8. Keeper

Limen Finance'teki keeper deseniyle aynı: tek TypeScript süreci, viem, şifreli keystore ile imzalama.

**Görevleri:**

1. **Limit emir tetikleme** — `limit_orders` tablosunu ve güncel fiyatı izler; tetiklenen emirleri zincire gönderir.
2. **Graduation itme** — `complete` olup `graduated` olmamış curve'ler için **Faz 2 hedefinin izinsiz girişini** çağırır, curve'ün kendisini değil: `BondingCurve.graduate()`'i yalnızca çözülmüş hedef çağırabilir (§5.6), bir keeper doğrudan çağırırsa `NotGraduationTarget()` alır. Toplu bir giriş kullanılıyorsa her curve `try/catch` ile sarılmalıdır (`O-BATCH-TRYCATCH`) — zaten mezun olmuş tek bir curve `AlreadyGraduated()` ile bütün partiyi revert ettirir. `pushGraduation()` / `rescue()` diye üyeler yoktur ve yazılmayacaktır; başarısız bir graduation kalıcı bir faz değil, aynı `(D, R)`'yi döndüren bir yeniden denemedir.
3. **Hedef değişikliğini boşaltma** — `GraduationTargetProposed(target, eta)` görüldüğünde, `eta`'dan önce tamamlanmış her curve'ü **mevcut** hedefe boşaltır. Üç günlük gecikmenin tek pratik değeri budur (§5.6); onu kullanacak süreç keeper'dır.
4. **Ölü emir temizliği** — bakiyesi yetmeyen veya süresi geçmiş emirleri iptal eder.

Nonce yönetimi, gas yükseltme ve yeniden deneme mantığı keeper'ın sorumluluğundadır.

---

## 9. Hata yönetimi

| Katman | Politika |
|---|---|
| Kontrat | Custom error'lar, **katı CEI sırası**, pull-based ödemeler. Native çıkış transferi her zaman CEI'nin en sonunda, dönüş değeri kontrol edilerek. |
| Graduation | Başarısız bir ödeme işlemin tamamını geri alır: `graduated` `false` kalır, curve `R`'yi tutar, hedef onarıldıktan sonra **aynı çağrı aynı `(D, R)`'yi döndürür**. Reddeden bir hedef geciktirir, strand edemez. Kurtarılamayan tek durum "hedef kabul etti ama tohumlayamadı"dır ve karşılığı hedefin atomikliği (`O-ATOMIC-SEED`) ile hedefin yeniden işaretlenebilirliğidir (§5.6). |
| Ücret ödemesi | Push yok. Escrow'a yazılır, kullanıcı çeker. |
| Frontend | Revert'ler custom error selector'ından çözümlenip okunabilir metne çevrilir. Slippage kullanıcı kontrolündedir, kota zincir durumundan hesaplanır (§6.3). |
| Indexer | Idempotent upsert; süreç ölürse imleçten devam eder. Blok grubu başına atomik yazma. |
| Keeper | Nonce takibi, gas yükseltme, başarısız emirlerin karantinası. |

**`BondingCurve` bilerek `ReentrancyGuard` kullanmaz.** Spec'in ilk sürümü onu kontrat satırında listeliyordu; kontratın merkezî iddiası katı CEI'nin guard'ı gereksiz kıldığıdır ve bir guard eklemek sıraya güvenmediğinizi söylerdi. Sıra bağlayıcıdır: doğrula → defteri yaz → bayrağı çevir → olayı yay → token transferi → escrow'a yatır → iade. Her defter yazımı her dış çağrıdan **önce** biter, dolayısıyla reentrant bir çağrı asla bayat rezerv göremez. `bind` ve `graduate()`'in yazımdan önce yaptığı iki okuma bu sıradan sapar ama ikisi de `view` arayüzler üzerinden yapılır — solc `view` için STATICCALL üretir ve STATICCALL altında her yazım revert eder. **Bu yüzden `view` süsleme değil taşıyıcıdır:** o arayüz beyanlarından birini non-`view` yapmak, görünür hiçbir etkisi olmayan tek kelimelik bir değişiklikle reentrancy kapanışını sessizce kaldırır. Testler her ikisi için yazım sayacı **ve** kontrol grubuyla ölçer.

Bu, spec'in geri kalanı için bir muafiyet değildir: yeni yazılan kontratlar CEI'yi bu titizlikte yürütemiyorsa guard kullanır.

---

## 10. Test stratejisi

**İki katmanlı — çünkü `anvil` Arc'ı simüle edemez.**

| Katman | Nerede | Ne test edilir |
|---|---|---|
| Unit | Standart EVM | `CurveMath`, `LaunchToken`, `FeeEscrow` muhasebesi, faz geçişleri |
| Fuzz | Standart EVM | Buy/sell gidiş-dönüşü, yuvarlama yönü, kısmi doldurma, uç parametreler |
| Invariant | Standart EVM | `CurveHandler` ile aşağıdaki invariant'lar |
| Fork | Arc testnet fork | Gerçek native USDC ile alım, kendi V4 deploymentımıza karşı graduation, hook ücret akışı, EIP-7708 log davranışı |
| Servis | Vitest | indexer, keeper, web birimleri |
| E2E | Playwright | **Faz 1'de:** launch → al → sat → `buyExactQuoteIn` kısması → `complete`. Akış burada biter; graduation'ın havuz tarafı Faz 2'dir ve o gelene kadar E2E'de `graduate()` çağıracak bir hedef yoktur. **Faz 2'de** akış "→ graduate → havuzda al" ile uzatılır. |

**Invariant'lar:**

1. Curve'ün native bakiyesi ≥ `raised − claimedFees` (ödeme gücü)
2. `sold ≤ saleSupply` — curve olmayan token satamaz
3. Toplam arz sabit; graduation sonrası curve'de satılabilir token kalmaz
4. Escrow'un toplam borcu ≤ escrow bakiyesi
5. Gidiş-dönüş bir işlem curve'ün bakiyesini asla azaltamaz (yuvarlama yönü kilidi)
6. **Süreklilik:** havuz curve'ün kapanış fiyatının **altında açamaz** — `R_actual / D ≥ P_final`, her ulaşılabilir işlem yolu için.

6 numaralı invariant, §5.2'deki tüm parametre türetmesinin doğruluğunu tek bir assert ile yakalar. **Bir eşitlik değil, yönü olan bir eşitsizliktir**, ve bu bir gevşetme değil düzeltmedir: curve'ün tamamlanmada tuttuğu tutar `R = V·S/(T−S)` değil `realQuoteReserves`'tir ve ondan kesinlikle büyüktür (§5.2 — `quoteBuyCost`'un `+1`'i alım başına birikir), dolayısıyla tek bir açılış fiyatı yoktur. Yön teoremdir: `D` aşağı yuvarlandığı için `D < S(T−S)/T`, ve bu tek başına ulaşılabilir her `R_actual` için havuzun `P_final`'in üstünde açmasını verir. Ölçüldü — altı işlemlik bir yaşam döngüsünde `R_actual = R + 11` ve boşluk `+2,15 × 10⁻²²`; teorik `R` değerinde boşluk **negatiftir** ama o durum ulaşılamaz. Miktarların bakiyeden değil immutable'dan ve defterden okunması, invariant'ı "bağış olmadığı sürece" kaydından kurtaran şeydir (§5.6).

**ABI-parity testi:** indexer, web ve keeper'ın kullandığı ABI'ler `forge build` çıktısına karşı doğrulanır; kontrat arayüzü değişip tüketici güncellenmezse CI kırılır.

**`CurveMath` port-parity testi:** zincirde kota fonksiyonu olmadığı için arayüzün gösterdiği her sayı TypeScript portundan gelir (§6.3), yani portun zincirden ayrışması sessiz bir kullanıcı-zararı hatasıdır. Port, Solidity kütüphanesinin ürettiği vektörlere karşı — beş fonksiyonun her biri için, sıfır ve sınır girdileri dahil — doğrulanır. Bu, ABI-parity testiyle aynı sınıfta bir kapıdır: kontrat matematiği değişip port güncellenmezse CI kırılır.

---

## 11. Güvenlik ve CI

| Kapı | İçerik |
|---|---|
| `contracts-ci` | `forge fmt --check`, `forge build --sizes`, `forge test` (ci profili, yükseltilmiş fuzz bütçesi) |
| `static-analysis` | Slither yalnızca `src/**` üzerinde; HIGH/MEDIUM bulgular triage allowlist'inde değilse kapı kırılır. LOW/INFO raporlanır, engellemez. |
| `indexer-ci`, `keeper-ci`, `web-ci` | Typecheck + Vitest + ABI-parity |
| `e2e` | Playwright |

**Sır yönetimi:** Özel anahtarlar asla argv'de veya ortam değişkeninde taşınmaz; Foundry'nin şifreli keystore hesabı kullanılır. `.env*` gitignore'dadır.

---

## 12. Teslimat sırası

Çekirdek protokolde katman-katman disiplin (deploy sonrası değiştirilemez, önce doğru olmalı), sonrasında uçtan uca dikey dilimler.

| Faz | İçerik | Sonunda elde edilen |
|---|---|---|
| 0 | Repo iskeleti, Foundry yapılandırması (cancun/via_ir), V4 submodule'leri, CI kapıları | `forge test` yeşil, boş iskelet |
| 1 | `CurveMath`, `LaunchToken`, `BondingCurve`, `LaunchFactory`, `FeeEscrow` — tam test. Curve'ün graduation **yüzeyi** de buraya dahildir (`graduate()`, `graduated`, `Graduated`) ve factory'nin iki döndürülebilir üyesi de öyle | Kontratlar Arc testnet'te; `cast` ile launch/buy/sell yapılabiliyor; curve tamamlanabiliyor ve hedef atandığında mezun olabiliyor |
| 2 | V4 deploymentı, `ArcpadHook` (adres madenciliği), `LaunchLocker`, **graduation hedefi** (izinsiz giriş, atomik tohumlama, `PoolSeeded`), `ArcpadRouter` | Curve tükenince havuz açılıyor, likidite kalıcı kilitli |
| 3 | Indexer + Postgres + token detay sayfası | Tarayıcıda gerçek token alınıp satılabiliyor |
| 4 | Explore + ⌘K arama + create sayfası | Ürün "pons gibi" görünüyor |
| 5 | Analytics + profil + ücret talebi + `BuybackVault` | Creator kazancını çekebiliyor |
| 6 | Holder-gated chat | Topluluk katmanı |
| 7 | Limit emirler + Orders sekmesi + keeper + grafik heatmap ve dev işaretleri | Tam kapsam |

Her fazın kendi uygulama planı olacaktır; bu doküman hepsinin ortak sözleşmesidir.

---

## 13. Açık riskler

| Risk | Etki | Karşılık |
|---|---|---|
| Arc mainnet henüz yok (2026 yazı hedefi) | Ürün testnet'te kalır | Parametreler profil dosyalarında; mainnet çıkınca üretim profiliyle yeniden deploy |
| Uniswap mainnet'te kanonik V4 deploymentı yapacak (duyuruldu) | Testnet deploymentımız orada geçersiz olur | Risk değil, planlanan geçiş: `PoolManager` adresle enjekte edilen bir arayüzdür; mainnet factory'si kanonik adresle deploy edilir, kod aynı kalır |
| Harici DEX araçları (Dexscreener, GeckoTerminal) testnet'te bizi indexlemez | pons'taki o linkler testnet'te çalışmaz | Kendi analytics'imiz boşluğu doldurur; linkler ArcScan'e yönlendirilir. Mainnet'te kanonik `PoolManager` kullanılınca kendiliğinden çalışır hale gelir |
| Arc EVM davranışı testnet'te değişebilir | Fork testleri kırılır | Fork testleri CI'da koşar; kırılma erken yakalanır |
| Hook adres madenciliği deploy'u yavaşlatır | Deploy süresi uzar | Salt araması deterministiktir, bulunan salt script'e sabitlenir |
| Chat kötüye kullanımı (spam, link) | Ürün kalitesi | Holder-gate + link yasağı + gönderi anındaki bakiye kaydı |
