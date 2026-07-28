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
| RPC | `https://rpc.testnet.arc.network` |
| WebSocket | `wss://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` (Blockscout) |
| Faucet | `https://faucet.circle.com` — istek başına 10 USDC |
| Native gas | USDC |
| Finality | ~350ms, deterministik, reorg yok |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` (6 decimal) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

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
- **keeper/** limit emirlerini tetikler ve otomatik graduation başarısız olursa manuel iter.

`packages/shared` ABI'yi tek kaynaktan dağıtır. Üç tüketicinin (indexer, web, keeper) her biri için `forge build` çıktısına karşı bir ABI-parity testi CI'da koşar; kontrat arayüzü değişip tüketici güncellenmezse CI kırılır.

**Neden ayrı repo (Limen Finance ile paylaşılmıyor):** Limen'in `foundry.toml`'u Uniswap V3 fork'u yüzünden `evm_version = "paris"` ve `via_ir = false`'a pinli. Uniswap V4 ise `cancun` ve `via_ir = true` gerektirir (aksi halde "stack too deep"). İki yapılandırma aynı workspace'te yaşayamaz.

> `C:\Users\iTopya\Desktop\arc-proje` (Limen Finance) bu proje için **salt-okunur referanstır**. Konvansiyonları kopyalanır, içine hiçbir şey yazılmaz.

---

## 5. Kontrat mimarisi

### 5.1 Kontratlar

| Kontrat | Sorumluluk |
|---|---|
| `LaunchFactory` | Giriş noktası. `LaunchToken` + `BondingCurve` klonunu üretir, o anki `FeeSchedule` adresini launch'a yazar, geliştirici ilk alımını atomik yapar, graduation'ı orkestre eder. Launch kaydını tutar. Oluşturma ücretsizdir. |
| `FeeSchedule` | Market cap kademelerini taşıyan **immutable** kontrat. Bir kez deploy edilir, hiç değişmez; `LaunchFactory` adresini her launch'a yazar, böylece bir launch'ın ücretleri yayınlandıktan sonra değiştirilemez. Tabloyu güncellemek yeni bir deployment demektir ve yalnızca sonraki launch'ları etkiler. |
| `LaunchToken` | Sabit arzlı ERC-20, 18 decimal. `name`, `symbol`, `metadataURI`, `curve` alanları token üzerinde — zincirden okunabilir, backend'e bağımlı değil. **Tüm arz constructor'da tek seferde `BondingCurve`'e basılır.** Curve, satılabilir kısmı (`S`) kendi sayacıyla sınırlar; rezerve kalan (`D`) aynı bakiyede durur ve graduation'da havuza aktarılır. Sonradan mint fonksiyonu yoktur. |
| `BondingCurve` | **Launch başına bir EIP-1167 klonu.** Satış arzını tutar. `buy()` (payable), `sell()`, `quoteBuy()`, `quoteSell()`. |
| `ArcpadHook` | Uniswap V4 singleton hook. Havuzun kendi ücreti sıfırdır; ücreti hook alır ve `FeeEscrow`'a yazar. |
| `FeeEscrow` | Pull-based bakiyeler. Hiçbir ücret push edilmez. |
| `LaunchLocker` | Graduate olan V4 likidite pozisyonunu ve artan arzı **kalıcı** tutar. Çıkarma yolu yoktur. |
| `BuybackVault` | Geri alınan tokenları beş yıla yayarak doğrusal serbest bırakır. |
| `ArcpadRouter` | Graduation sonrası swap'ler için minimal V4 router. `PoolManager.unlock` geri çağrısı üzerinden `exactInputSingle` / `exactOutputSingle`. |
| `libraries/CurveMath` | Saf matematik. Fuzz ve invariant testlerinin asıl hedefi. |
| `libraries/LaunchConfig` | Parametre struct'ı ve doğrulaması. |

**Neden launch başına ayrı curve klonu:** İzolasyon. Bir muhasebe hatasının yarıçapı tek bir launch olur, tüm protokol değil. Her klon yalnızca kendi tokenını ve kendi topladığı USDC'yi tutar. EIP-1167 minimal proxy sayesinde deploy maliyeti düşüktür ve Arc'ta gas zaten ~$0,01 hedefindedir.

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

**Parametrelendirme pump.fun ile aynıdır:** üç sayı doğrudan konfigürasyondan gelir — sanal quote rezervi `V`, sanal token rezervi `T`, ve curve'de satılacak gerçek arz `S`. Geri kalan her şey türetilir.

| Türetilen | Formül |
|---|---|
| Açılış fiyatı | `P₀ = V / T` |
| Graduation'da toplanan | `R = V · S / (T − S)` |
| Graduation fiyatı | `P_final = (V + R) / (T − S)` |
| **Havuz tohumu arzı** | **`D = S · (T − S) / T`** |
| Toplam arz | `N = S + D = S · (2T − S) / T` |

`D` serbest bir sayı değildir, **zorunludur**. Curve'ün kapanış fiyatı ile havuzun açılış fiyatı eşitlenmezse graduation anında anlık bir arbitraj boşluğu doğar ve ilk swap fiyatı uçurur. Yukarıdaki formül, `D = R / P_final` koşulunun sadeleştirilmiş halidir.

**Bu formülde ücret oranı yoktur, ve bu kasıtlıdır.** Ücret curve matematiğinin *dışında* alınır: kullanıcı `quoteIn` öder, ücret düşülür, rezervlere yalnızca `quoteIn − f` girer. Dolayısıyla sell-out anında curve'de biriken `R` ücret oranından bağımsızdır. §5.5'teki kademeli ücret modelini mümkün kılan şey budur — oran işlem başına değişse bile havuz tohumu sabit kalır.

> **Düzeltme.** Bu spec'in ilk sürümü `D = S(1−φ)/√m` yazıyor ve ücreti formülün içine koyuyordu. pump.fun'ın canlı sabitleriyle sınandığında yanlış olduğu görüldü. Karekök de gerekmediği için "`sqrtM`'i tamsayı seç" kısıtı tamamen düşmüştür.

**Doğrulama — pump.fun'ın kendi sabitleri bu formülleri sağlar:**

```
V = 30e9 lamports,  T = 1,073e15,  S = 7,931e14

R = 30e9 × 7,931e14 / 2,799e14 = 85,005e9      → meşhur 85 SOL eşiği
D = 7,931e14 × 2,799e14 / 1,073e15 = 2,069e14  → rezerve arzın kendisi
(T/(T−S))² = 14,7×                              → fiyat katı
```

85 SOL bir parametre değildir; bu üç sayıdan çıkan bir sonuçtur.

**Yuvarlama yönleri pump.fun'ın SDK kaynağından birebir alınmıştır** (`@pump-fun/pump-sdk@1.36.0`, `src/bondingCurve.ts` ve `src/fees.ts`). Dördü de protokol lehinedir ve tahmin değil, kopyadır:

```
alım, tam token çıkışı:   cost = amount·Vq / (Vt − amount) + 1        ← +1 ekle (yukarı)
ücret:                    ceilDiv(amount · bps, 10_000)                ← tavana (yukarı)
satış, tam token girişi:  out  = amount·Vq / (Vt + amount)             ← taban (aşağı)
alım, tam quote girişi:   in   = (amount − 1)·10_000 / (bps + 10_000)  ← −1, sonra taban
```

Alıcı lehine tek bir yuvarlama, saldırganın 1 wei'lik milyonlarca işlemle curve'ü kuruş kuruş boşaltmasına izin verir. Bu, `test/invariant` altında "gidiş-dönüş bir işlem curve'ün bakiyesini asla azaltamaz" invariant'ıyla kilitlenir.

**Rezervler her zaman ücret öncesi curve tutarı kadar hareket eder.** Alımda ücret curve maliyetinin *üstüne* eklenir, satışta curve çıktısından *düşülür*; her iki durumda da rezervlere giren/çıkan miktar ücret oranından etkilenmez. Kademeli ücretin mümkün olmasının sebebi budur.

**`D` aşağı yuvarlanır**; havuza ideal miktarın en fazla 1 wei altında token gider, oluşan toz `LaunchLocker`'da kalıcı kilitlenir.

**Yuvarlama yönü.** Her `mulDiv` çağrısının yuvarlama yönü açıkça seçilir ve **her zaman curve lehinedir**. Alıcı lehine yuvarlama, saldırganın 1 wei'lik milyonlarca işlemle curve'ü kuruş kuruş boşaltmasına izin verir. Bu, `test/invariant` altında "gidiş-dönüş bir işlem curve'ün bakiyesini asla azaltamaz" invariant'ıyla kilitlenir.

**Taşma payı.** `k = V · T` en büyük yapılandırmada ~1,4 × 10⁴⁸ mertebesindedir; `uint256` tavanı ~1,16 × 10⁷⁷. Rahat.

### 5.3 Parametreler

Birincil (konfigürasyondan gelen) parametreler yalnızca üçtür: `V`, `T`, `S`. Geri kalan her şey §5.2'deki formüllerle türetilir.

**Arz oranları pump.fun'dan birebir alınmıştır.** Milyonlarca launch üzerinde çalışmış sayılar; tahmin etmek yerine kanıtlanmışı kullanıyoruz.

| Parametre | Testnet | Üretim |
|---|---|---|
| Sanal token rezervi `T` | 1.073.000.000 × 10¹⁸ | aynı |
| Satış arzı `S` | 793.100.000 × 10¹⁸ | aynı |
| Sanal USDC rezervi `V` | 4,292 × 10¹⁸ | **4.292 × 10¹⁸** |
| → Havuz tohumu `D` | 206.900.000 (arzın %20,69'u) | aynı |
| → Toplam arz `N = S + D` | 1.000.000.000 | aynı |
| → Graduation `R = V·S/(T−S)` | **≈ 12,16 USDC** | **≈ 12.161 USDC** |
| → Fiyat katı `(T/(T−S))²` | 14,7× | aynı |
| → Açılış FDV | 4,00 USDC | **4.000 USDC** |
| → Graduation FDV | ≈ 58,78 USDC | **≈ 58.784 USDC** |
| Launch ücreti | **yok** | **yok** |
| İşlem ücreti | kademeli — §5.5 | aynı |
| Geliştirici ilk alım tavanı | satış arzının %5'i | aynı |

**Token oluşturmak ücretsizdir.** pump.fun'ın modeli budur — `create_v2`'nin argümanlarında hiç ücret alanı yoktur ve protokol yalnızca işlem ücretlerinden kazanır. Ponsfamily 0,0005 ETH alıyor, ama düşük sürtünme daha çok launch, daha çok launch daha çok işlem hacmi demek; gelir oradan gelir. Arc'ta gas zaten ~$0,01 olduğu için spam engeli olarak da ayrı bir ücrete ihtiyaç yok.

İki profil arasında **yalnızca `V` değişir**, tam 1000× oranında; ölçeği belirleyen tek sayı sanal quote rezervidir. pump.fun'ın yaptığı da budur — SOL'lu ve USDC'li coinler aynı token rezervlerini, farklı `initial_virtual_*_reserves` değerlerini kullanır.

**Üretim `V`'si tahmin değil, pump.fun'ın canlı `Global` hesabından okunmuştur.** `initial_virtual_quote_reserves = 4_292_000_000` (6 decimal USDC ⇒ 4.292 USDC). Bu sayının seçimi kasıtlı: açılış FDV'sini tam **4.000 USDC**'ye oturtuyor (`4292 / 1,073 = 4000`), graduation FDV'si de **58.784 USDC** çıkıyor — ki bu, §5.5'teki `stable_fee_tiers` tablosunun ilk havuz eşiği olan **59.000 USDC**'nin hemen altındadır. Yani bir token mezun olduğu anda creator lehine kademeye geçer.

`whitelisted_quote_mints` alanında bugün tek bir giriş var: USDC. pump.fun'ın SOL dışı tek quote varlığı da bizimkiyle aynı.

**Testnet rakamlarının küçüklüğü zorunludur, kozmetik değildir.** Circle faucet'i istek başına 10 USDC verir. 17.001 USDC'lik bir eşikle hiçbir token mezun edilemez, yani graduation, hook, locker ve havuz kodunun hiçbiri test edilemez. 17 USDC'lik eşik iki faucet talebiyle karşılanır.

**Neden 100× değil de 14,7×?** Spec'in ilk sürümü fiyat katını 100× seçiyordu, bu da havuz tohumunu arzın yalnızca %9'una düşürüyordu. Yüksek kat daha çarpıcı bir curve grafiği verir ama graduation sonrası **sığ bir havuz** bırakır: aynı büyüklükteki emir çok daha fazla slipaj yaratır. pump.fun'ın %20,69'u, curve heyecanı ile mezuniyet sonrası piyasa sağlığı arasında canlı veriyle ayarlanmış bir dengedir.

Parametreler deploy anında immutable olarak verilir; testnet ve üretim profilleri `script/` altında ayrı dosyalardır.

### 5.4 Yaşam döngüsü

```
NotGraduated(0) ──sold == S──▶ Swept(1) ──havuz kuruldu──▶ PoolCreated(2)
                                   │
                                   └──7 gün + rescue()──▶ Rescued(3)
```

- **NotGraduated** — curve aktif, al/sat açık.
- **Swept** — satış arzı tükendi, curve kapandı, varlıklar havuz kurulumu için ayrıldı. Normal akışta bu faz, tamamlayan alım işleminin içinde tek atomik adımda geçilir ve `PoolCreated`'a ulaşılır.
- **PoolCreated** — V4 havuzu açık, likidite `LaunchLocker`'da kalıcı kilitli, işlem havuzda devam eder.
- **Rescued** — otomatik graduation başarısız oldu ve 7 gün içinde kimse `pushGraduation()` ile ileri itemedi. Kalıcı olarak işaretlenir; bu bir başarısızlık damgasıdır, normal bir son değildir.

Son alım kısmi doldurulabilir: satış arzından kalan miktar talep edilenden azsa, alıcı kalanı alır ve fazla `msg.value` iade edilir. Gerçekleşen miktarlar olaydan okunmalıdır, talepten değil.

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

25 kademe vardır; ara basamaklar milyon başına birer adımdır. **59.000 eşiği rastgele değildir:** pump.fun'ın USDC curve'ü ~58.784 USDC FDV'de mezun olur, yani token mezun olur olmaz creator lehine kademeye geçer. §5.3'teki `V` seçimimiz bu ilişkiyi koruyor.

**Kademe tablosu launch anında dondurulur ve bir daha değişmez.** Burada pump.fun'dan bilinçli olarak ayrılıyoruz: onların `FeeConfig`'i `admin` alanı olan global bir hesap, yani yönetici tabloyu güncellediğinde **zaten yayınlanmış** launch'ların ücreti de değişir. Bizde değişmez — creator ve alıcılar tam olarak neye girdiklerini bilir.

Bu yalnızca Rejim 2'yi (havuz kademeleri) ilgilendirir; curve'ün düz oranı zaten launch'ın immutable parametresidir.

Uygulaması bir kilit mekanizmasıyla değil, **değişmezlikle** yapılır: kademe tablosu `FeeSchedule` adlı immutable bir kontrat olarak bir kez deploy edilir, `LaunchFactory` o anki `FeeSchedule` adresini her yeni launch'ın içine yazar. Launch başına maliyet tek bir adres (20 bayt); garanti ise kontrat bytecode'unun değiştirilemezliğinden gelir. Tabloyu güncellemek yeni bir `FeeSchedule` deploy etmek demektir ve **yalnızca sonraki launch'ları** etkiler.

Bunun bedeli: hatalı bir tabloyla yayınlanan launch'lar düzeltilemez. Kabul ediyoruz — düzeltilebilir bir ücret, güvenilmesi gereken bir yetki noktası demektir ve bu ürünün en temel vaadiyle çelişir.

**Ücret hesabındaki iki ince nokta** (pump.fun SDK kaynağından):

- Kademe seçimi için kullanılan market cap, mint'in **gerçek arzıyla değil sabit `1e15` (bizde `1e27` wei) arz sabitiyle** hesaplanır. Tüm launch'lar aynı arza sahip olduğu için bu, market cap'i saf bir fiyat fonksiyonuna indirger.
- Ücret her zaman **tavana yuvarlanır**: `ceilDiv(amount × bps, 10_000)`.

Bu tablonun üç özelliği tasarım açısından belirleyici:

1. **Toplam ücret token büyüdükçe düşer** (%1,25 → %0,30). Spekülatif faz pahalı, likit faz ucuz — çoğu ücret şemasının tersi.
2. **Protokol curve'de %0,95, havuzda %0,05 alır.** Protokol gelirinin neredeyse tamamı graduation öncesinde kazanılır.
3. **Küçülen pay creator'ınkidir.** Graduation'ın hemen ardından %0,95 ile zirve yapar, %0,05'e iner.

Graduation eşiğimiz (üretimde ~82.000 USDC) tablonun ilk havuz kademesinin sınırıyla kasıtlı olarak çakışır: bir token mezun olduğu anda creator payı %0,30'dan %0,95'e sıçrar. Creator'ı curve'ü tamamlamaya iten teşvik budur.

`BuybackVault` protokol payından beslenir; creator kendi payının bir dilimini oraya yönlendiren anahtarı isteğe bağlı açabilir. Varsayılan **kapalıdır**; creator açabilir ama tek başına geri kapatamaz (protokol devre dışı bırakabilir).
- Ücretler `FeeEscrow`'da birikir ve **çekilir, gönderilmez**. Bir alıcının native kabul etmemesi başkalarının ücretini kilitleyemez — Arc'ta sözleşmelere native gönderimin başarılı olacağı garanti olmadığı için bu bir tercih değil, zorunluluktur.
- Graduation sonrası hook, ücreti token cinsinden tahsil edebilir; dağıtımdan önce pairing asset'e çevrilir.

**Havuzun kendi ücreti sıfırdır, ücreti hook alır.** Sebep: V4'te havuz ücreti otomatik olarak LP'lere gider, ama bizim tek LP'miz kalıcı kilitli `LaunchLocker`'dır — ücret sonsuza kadar kilide akar ve kimse alamazdı. Hook'ta tahsil etmek, creator/protokol bölüşümünü graduation öncesiyle birebir aynı tutmayı sağlar.

### 5.6 Graduation ve havuz kurulumu

Satış arzı tükendiğinde, tamamlayan işlemin içinde:

1. Curve kapanır, `sold == S` doğrulanır.
2. Curve'de biriken `R` USDC'nin **tamamı** havuza gider. Ayrıca bir ücret kesilmez: ücretler zaten her işlem anında alınıp `FeeEscrow`'a yazılmıştır ve rezervlere hiç girmemiştir (§5.2, §5.5). Bu, §5.2'deki `D = R / P_final` süreklilik koşulunun tuttuğu tek senaryodur — `R`'den burada bir kesinti yapılsaydı havuz curve'ün kapanış fiyatının altında açardı.

   > pump.fun'ın buradaki `pool_migration_fee`'si (15.000.001 lamports) Solana'nın hesap kirası içindir. Arc'ta böyle bir maliyet yoktur, dolayısıyla karşılığı da yoktur.
3. `D` token zaten `LaunchLocker`'da beklemektedir (constructor'da oraya basılmıştı); havuz tohumu olarak kullanılır.
4. V4 havuzu `initialize` edilir; `sqrtPriceX96 = sqrt(P_final)`.
5. `LaunchLocker`, `PoolManager.unlock` geri çağrısı içinde tam aralık (`MIN_TICK`–`MAX_TICK`) likidite ekler.
6. Mevcut miktarların tamamı likiditeye dönüşmezse artan toz `LaunchLocker`'da kalıcı kilitlenir.
7. Faz `PoolCreated` olur, `Graduated` olayı yayınlanır.

Adım 4–5 başarısız olursa launch `Swept` fazında kalır ve **herkes** `pushGraduation()` çağırabilir. 7 gün boyunca kimse başaramazsa `rescue()` valfi açılır.

**Hook adres madenciliği.** V4'te hook adresinin son bitleri hangi izinlere sahip olduğunu kodlar. `ArcpadHook` için gereken bayraklar: `BEFORE_INITIALIZE` (havuzun bize ait olduğunu doğrulamak), `BEFORE_SWAP` ve `BEFORE_SWAP_RETURNS_DELTA` (girdi üzerinden ücret kesmek). Deploy script'i, bu bayraklara uyan bir adres üretene kadar CREATE2 salt'ını arar. Sıradan bir `forge create` yeterli değildir.

### 5.7 Creator kontrolleri ve topluluk devri

Creator launch sonrası **yalnızca** şunları yapabilir:

- Ücret alıcı cüzdanını değiştirmek
- Buyback'i kapatmak (açmak protokol iznine tabidir)

Creator **yapamaz:** token basmak, ücret oranını değiştirmek, pairing asset'i değiştirmek, kilitli likiditeye dokunmak.

Creator projeyi terk ederse ücret akışı iki yolla devredilebilir:

- **Gönüllü:** creator alıcıyı doğrudan yeni cüzdana taşır.
- **Protokol önerili:** protokol yeni bir alıcı önerir, **3 gün** kamuya açık bekleme süresi işler, sonra uygulanır. Bu pencerede holder'lar çıkabilir veya örgütlenebilir.

### 5.8 pump.fun'dan öğrenilen ek özellikler — karar

Aşağıdakiler ponsfamily dokümanlarında hiç geçmiyor; pump.fun'ın resmî dokümanlarından öğrenildi. Her biri için karar:

| Özellik | pump.fun'daki hali | arcpad kararı |
|---|---|---|
| **Kademeli ücret** | Market cap'e göre %1,25 → %0,30 | **Benimsendi** (§5.5). Düz %70/%30'un yerini aldı. |
| **Arz oranları** | 793,1M satış / 206,9M havuz | **Benimsendi** (§5.3). 909,9M/90,1M tahminimizin yerini aldı. |
| **Creator başına tek vault** | `["creator-vault", creator]` — bir creator'ın tüm coinlerinin ücreti tek yerde | **Benimsendi.** `FeeEscrow` zaten `(alıcı, varlık)` anahtarlı; coin başına ayrı kova gerekmiyor ve claim maliyetini düşürüyor. |
| **İzinsiz ücret süpürme** | `collect_creator_fee_v2` permissionless; fon her hâlükârda creator'a gider | **Benimsendi.** Claim'i herkes tetikleyebilir, alıcı değişmez. Creator'ın gas'i yoksa bile ücreti kilitli kalmaz. |
| **Creator fee sharing** | ≤10 paydaş, `share_bps` toplamı 10.000, **bir kez** set edilir sonra admin iptal | **Faz 5'e alındı.** Ekip launch'ları için gerçek bir ihtiyaç ve §5.7'deki topluluk devri mekanizmasıyla aynı yere oturuyor. Tek seferlik olması kritik: aksi halde creator paydaşları sonradan tasfiye edebilir. |
| **Cashback** | Creator ücretini, işlem hacmine oranla trader'lara geri verir | **Kapsam dışı (Faz 7 sonrası).** Kullanıcı başına hacim biriktirici gerektiriyor — kontrat ve indexer tarafında ayrı bir alt sistem. Ürün olarak güçlü ama Faz 0-7'yi taşımaz. |
| **Mayhem modu** | Coin başına bayrak, ayrı ücret alıcı kümesi | **Kapsam dışı.** Resmî dokümanlar ne yaptığını açıklamıyor; anlamadığımız bir mekanizmayı kopyalamıyoruz. |
| **Ayrı buyback ücret alıcısı** | Her işlemde `feeRecipient` + `buybackFeeRecipient` | **Benimsendi**; `BuybackVault` bu rolü üstleniyor. |
| **Çoklu ücret alıcısı (8 adet)** | Solana'da hesap yazma çakışmasını dağıtmak için | **Reddedildi.** EVM'de böyle bir çakışma yok; tek escrow kontratı yeterli. |
| **Kısmi doldurma** | `buy`'da yok ama ayrı bir instruction var: `buy_exact_quote_in_v2(spendable_quote_in, min_tokens_out)` — "şu kadara kadar harca", kalan kadarını verir, slipaj `min_tokens_out` ile korunur | **Benimsendi, iki giriş noktası olarak.** İlk taslak `buy`'ı gevşetip kısmi doldurma yapacaktı; kaynağa bakınca daha temiz olanı görüldü: `buy(tokensOut, maxQuoteIn)` kalandan fazlası istenirse revert eder, `buyExactQuoteIn(quoteIn, minTokensOut)` kalanı doldurup fazlayı iade eder. Arayüzdeki miktar girişi birincisini, "X USDC ile al" kısayolları ikincisini kullanır. |
| **Metadata sınırları** | isim ≤32, sembol ≤13, uri ≤200 | **Benimsendi** (ponsfamily'nin 10 karakterlik ticker sınırı yerine 13). |

---

## 6. Veri katmanı

### 6.1 Indexer

Tek bir TypeScript süreci. viem ile `eth_getLogs` çeker; imleç `sync_state` tablosunda tutulur ve her turda son işlenen bloktan `finalized` etiketine kadar okur.

Arc'ta reorg olmadığı için geri alma mantığı yazılmaz. Buna rağmen her satır `(tx_hash, log_index)` üzerinde **idempotent upsert** edilir, çünkü süreç yeniden başladığında aynı logları tekrar görmek normaldir. Blok grubu başına tek veritabanı transaction'ı: ya hepsi yazılır ya hiçbiri.

**Dinlenen olaylar:** `LaunchCreated`, `Bought`, `Sold`, `Graduated`, `FeeAccrued`, `FeeClaimed`, `LaunchToken.Transfer`, ve graduation sonrası `PoolManager.Swap`.

**EIP-7708 tuzağı:** Arc'ta her native transfer de sistem adresinden bir `Transfer` logu yayınlar. Holder tablosu doldurulurken emitter adresi mutlaka ilgili `LaunchToken` adresine göre filtrelenmelidir; aksi halde USDC hareketleri token bakiyesi sanılır.

### 6.2 Şema

| Tablo | İçerik |
|---|---|
| `sync_state` | Indexer imleci: son işlenen blok, son çalışma zamanı |
| `tokens` | Adres, curve, creator, metadata, arz parametreleri, faz, pool id, oluşturulma zamanı |
| `trades` | Her al/sat: taraf, miktarlar, fiyat, ücret, tx, blok, zaman, `source ∈ {curve, pool}`, `is_dev` |
| `holders` | `(token, holder) → balance`, `Transfer`'lardan türetilir |
| `candles` | 1 dakikalık OHLCV; 5M/1H/6H/1D/ALL görünümleri bunlardan toplanır |
| `token_stats` | Denormalize: market cap, likidite, 24s hacim, ATH, holder sayısı, `last_trade_at`, `last_buy_at` |
| `protocol_stats_daily` | Günlük hacim, launch sayısı, işlem sayısı, protokol geliri, creator kazancı, tekil dev sayısı |
| `chat_messages` | Token, yazar, gövde, zaman, gönderi anındaki bakiye |
| `limit_orders` | Token, sahip, taraf, tetik fiyatı, miktar, durum |
| `fee_balances` | `(recipient, asset) → claimable`, escrow olaylarından |

`trades` tablosunda `source` alanı curve ve havuz işlemlerini **tek tabloda** birleştirir. Bir token graduate olduğunda fiyat geçmişi kopmaz; ayrı tablolar kullanılsaydı bu süreklilik sonradan birleştirilmek zorunda kalırdı.

`token_stats` denormalizasyonu zorunludur: Explore sayfası yüz binlerce token arasında "market cap'e göre sırala, son 24 saat" diyebilmelidir. Bu, her istekte `trades` üzerinden toplanarak yapılamaz — indexer yazarken bu tabloyu da günceller.

### 6.3 Okuma yolu

- **Liste ve geçmiş** — server component'lerden doğrudan Postgres sorgusu. Araya ayrı bir API katmanı konmaz.
- **API route'ları yalnızca yazma için** — chat mesajı gönderme, limit emir oluşturma.
- **İşlem anındaki kota her zaman zincirden** — `curve.quoteBuy()` / `quoteSell()`, graduation sonrası V4 üzerinden. Kullanıcının imzaladığı fiyat, indexer'ın kaç saniye geride olduğuna bağlı olamaz.

**"Recent buys" sıralaması:** `token_stats.last_buy_at` üzerinde azalan sıra — yani en son alım işlemi gerçekleşen token en üstte. Etiketin harfi harfine karşılığı budur ve tek indeksli kolonla yüz binlerce satırda anlık çalışır. Momentum tabanlı bir sıralama daha "akıllı" olurdu ama kullanıcı "Recent buys" yazısına tıklarken yeniliği bekler, ivmeyi değil; etiket ile davranış ayrışmamalıdır.

---

## 7. Frontend

### 7.1 Sayfalar

| Rota | İçerik |
|---|---|
| `/` | Explore. Üstte "Graduated" bölümü (kart ızgarası + sayfalama), altta "Explore" bölümü: sıralama (Recent buys / Newest / Oldest / Market cap / Volume) + yaş (All / 24h / 7d) + ızgara + sayfalama |
| `/token/[address]` | About paneli (açıklama, yakılan miktar, kontrat ve havuz linkleri) · sol al-sat paneli (Market / Limit / Orders, slippage, %25–100 kısayolları) · orta grafik (market cap, likidite, 24s hacim, ATH, zaman aralıkları) · sağ chat · altta Recent trades / Holders sekmeleri |
| `/create` | Launch formu (isim, ticker, açıklama, görsel + IPFS onayı, X, Telegram, geliştirici alımı, Advanced) + sağda canlı önizleme kartı |
| `/analytics` | 24h / All time geçişi, istatistik ızgarası, günlük hacim ve launch bar grafikleri |
| `/profile/[address]` | Launch'lar, pozisyonlar, işlem geçmişi, talep edilebilir ücretler |
| ⌘K modal | Tam ekran arama: sıralama + yaş filtresi + sonuç satırları + sayfalama |

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
│   ├── create/     LaunchForm, ImageUpload, TokenPreviewCard, AdvancedSection
│   ├── analytics/  StatGrid, DailyBarChart, RangeToggle
│   └── ui/         Button, Input, Tabs, Pill, Card, Skeleton
├── hooks/          useQuote, useLaunch, useTrade, useTokenStats, useChat
└── lib/            db, chain, format, brand, abi (packages/shared'den)
```

### 7.3 Tasarım tokenları

Ekran görüntülerinden çıkarılmıştır:

```
bg          #0B0B0B      surface  #141414     border  rgba(255,255,255,.08)
text        #FAFAFA      muted    #8A8A8A
accent      #C6F24E      (lime — grafikler, vurgular, "Graduated" rozeti)
primary     #7E8F2E      (zeytin — birincil CTA butonları)
radius      kart 20px · pill 999px · input 14px
tipografi   serif wordmark + geometrik sans gövde
```

**Locale açıkça sabitlenir: `en-US`, nokta ondalık.** Referans ekran görüntülerindeki `0,0005` ve `$57,53M` biçimleri pons'un tercihi değil, tarayıcının `tr-TR` locale'iydi — site `Intl.NumberFormat`'i locale sabitlemeden kullanıyor. Kripto arayüzünde `1,234` bir kullanıcı için "bin iki yüz otuz dört", diğeri için "bir virgül iki üç dört" demektir; para söz konusuyken bu belirsizlik kabul edilemez.

**İsim gösterimi:** Arc'ta ENS yoktur. Kullanıcılar kısaltılmış adresle gösterilir (`0x92FB…b4bA`). Arc kendi isim servisini çıkarırsa buraya bağlanır.

---

## 8. Keeper

Limen Finance'teki keeper deseniyle aynı: tek TypeScript süreci, viem, şifreli keystore ile imzalama.

**Görevleri:**

1. **Limit emir tetikleme** — `limit_orders` tablosunu ve güncel fiyatı izler; tetiklenen emirleri zincire gönderir.
2. **Graduation itme** — `Swept` fazında takılmış launch'lar için `pushGraduation()` çağırır.
3. **Ölü emir temizliği** — bakiyesi yetmeyen veya süresi geçmiş emirleri iptal eder.

Nonce yönetimi, gas yükseltme ve yeniden deneme mantığı keeper'ın sorumluluğundadır.

---

## 9. Hata yönetimi

| Katman | Politika |
|---|---|
| Kontrat | Custom error'lar, CEI sırası, `ReentrancyGuard`, pull-based ödemeler. Native çıkış transferi her zaman CEI'nin en sonunda, dönüş değeri kontrol edilerek. |
| Graduation | Başarısızlık `Swept` fazında bekler; izinsiz `pushGraduation()`; 7 gün sonra `rescue()` valfi, kalıcı `Rescued` işareti. |
| Ücret ödemesi | Push yok. Escrow'a yazılır, kullanıcı çeker. |
| Frontend | Revert'ler custom error selector'ından çözümlenip okunabilir metne çevrilir. Slippage kullanıcı kontrolündedir, kota zincirden okunur. |
| Indexer | Idempotent upsert; süreç ölürse imleçten devam eder. Blok grubu başına atomik yazma. |
| Keeper | Nonce takibi, gas yükseltme, başarısız emirlerin karantinası. |

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
| E2E | Playwright | Launch → al → sat → graduate → havuzda al akışı |

**Invariant'lar:**

1. Curve'ün native bakiyesi ≥ `raised − claimedFees` (ödeme gücü)
2. `sold ≤ saleSupply` — curve olmayan token satamaz
3. Toplam arz sabit; graduation sonrası curve'de satılabilir token kalmaz
4. Escrow'un toplam borcu ≤ escrow bakiyesi
5. Gidiş-dönüş bir işlem curve'ün bakiyesini asla azaltamaz (yuvarlama yönü kilidi)
6. **Süreklilik:** graduation anında havuzun `sqrtPriceX96`'sı curve'ün kapanış fiyatının kareköküne eşittir

6 numaralı invariant, §5.2'deki tüm parametre türetmesinin doğruluğunu tek bir assert ile yakalar.

**ABI-parity testi:** indexer, web ve keeper'ın kullandığı ABI'ler `forge build` çıktısına karşı doğrulanır; kontrat arayüzü değişip tüketici güncellenmezse CI kırılır.

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
| 1 | `CurveMath`, `LaunchToken`, `BondingCurve`, `LaunchFactory`, `FeeEscrow` — tam test | Kontratlar Arc testnet'te; `cast` ile launch/buy/sell yapılabiliyor |
| 2 | V4 deploymentı, `ArcpadHook` (adres madenciliği), `LaunchLocker`, graduation, `ArcpadRouter` | Curve tükenince havuz açılıyor, likidite kalıcı kilitli |
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
