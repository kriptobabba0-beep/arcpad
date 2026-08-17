# arcpad Faz 4 — Web arayüzü: launch, işlem ve keşif

> **Ajan çalışanlar için:** ZORUNLU ALT BECERİ: Bu planı görev görev uygulamak için `superpowers:subagent-driven-development` kullanın. Adımlar takip için checkbox (`- [ ]`) sözdizimi kullanır.

**Hedef:** Arc testnet üzerinde **gerçekten çalışan**, kamuya duyurulabilecek bir arayüz: cüzdan bağla, token launch et, curve üzerinde al ve sat, bir token'ın durumunu dürüst biçimde gör. Faz 1c'nin dört kontratı ve Faz 3'ün okuma modeli girdi; bu faz onların üstüne kullanıcının gördüğü tek yüzeyi koyar.

**Mimari:** Next 16 App Router. **Okumalar** Faz 3'ün `@arcpad/db` tipli sorgularından, server component'lerin içinden gelir (spec §6.3 araya API katmanı koymayı yasaklar). **Yazmalar** doğrudan zincire gider, kullanıcının cüzdanıyla; hiçbir yazma sunucudan geçmez. **İşlem anındaki kota her zaman zincirden okunan rezervlerden hesaplanır** — çünkü `BondingCurve`'ün `quoteBuy()`/`quoteSell()` view fonksiyonu **yoktur** (§Bayat spec ifadeleri, S1). Bunun sonucu: kota aritmetiği TypeScript'e taşınmak zorundadır ve bu fazın en riskli parçası odur; Task 4 onu yazar, Task 5 **derlenmiş gerçek bytecode'a karşı çalıştırarak** doğrular.

**Teknoloji yığını (iskeletten okundu, spec'ten değil):** Next `16.2.12`, React `19.2.8`, wagmi `3.7.4`, viem `2.55.8`, `@tanstack/react-query` `5.101.4`, Tailwind `4.3.3`, TypeScript `5.9.3`, Vitest `4.1.10`. Zincir: Arc testnet, chainId `5042002`, native gas varlığı USDC.

---

## Bu fazın kapsamı

**İçinde:** cüzdan ve ağ katmanı · `/` Explore · ⌘K arama · `/token/[address]` (about, istatistikler, ilerleme, kanoniklik, grafik, son işlemler, holders, al-sat paneli) · `/create` launch akışı · hata yüzeyi · erişilebilirlik ve duyarlılık · Vitest birim/bileşen testleri + Playwright E2E.

**Dışında, ve neden:**

- **Holder-gated chat** (spec §7.1, Faz 6) — `chat_messages` tablosunu indexer yazmaz, `web`'in API route'u yazar; kendi dikeyi.
- **Limit emirler / Orders sekmesi** (Faz 7) — keeper'a bağlı. Al-sat panelinde `Market | Limit | Orders` sekme şeridi ekran görüntülerinde var; bu fazda **yalnızca `Market` sekmesi render edilir**, diğer ikisi hiç çizilmez. Gerekçe: tıklandığında hiçbir şey yapmayan bir sekme, olmayan bir sekmeden kötüdür.
- **`/analytics` ve `/profile/[address]`** (Faz 5) — `protocol_stats_daily` Faz 3'te kapsam dışı bırakıldı; `getClaimableFees` / `listCreatorEarningsByLaunch` sorguları hazır ama ekranları Faz 5'in.
- **Grafik heatmap katmanı ve dev buy/sell işaretleri** (Faz 7).
- ~~**Graduation sonrası havuz üzerinden işlem** — Faz 2 teslim edilmedi.~~ **TESLİM EDİLDİ 2026-08-09, bu fazın dışında ama ondan sonra.** Faz 2 zincire indi, `ArcpadRouter` yayınlandı (`0x6D9f42706C7E7bF3D2Ad3123ca7397DA6F0bB7cd`) ve havuz al-sat paneli `web/`e girdi. Gerekçe kaydedilmeye değer: V4 bir EOA'ya swap girişi vermez — cüzdan `PoolManager.swap`'ta `ManagerLocked` yer, `unlock`'u da kullanamaz (geri çağrı adresi kodsuz) — ve Arc'ta Universal Router yoktur. Yani bu madde "arayüz yazılmadı" değil **"gönderilecek bir kapı yoktu"** demekti; kapı artık var. Bu faz yine de `complete`/`graduated` durumlarını dürüstçe göstermeye devam ediyor.
- **Açık/koyu tema geçişi.** Ekran görüntülerinde bir güneş ikonu var; bu fazda **yalnızca koyu tema** var ve `color-scheme: dark` açıkça bildirilir. Gerekçe: §7.3'ün token paleti koyu-doğumludur, ikinci bir palet ayrı bir görevdir ve yarısı yapılmış bir açık tema "şablondan çıkmış" görünür — bu ürünün kaçınmak zorunda olduğu tek izlenim.

---

## Global Kısıtlar

Bu bölüm her görevin gereksinimlerine **örtük olarak dâhildir**.

### K1 — Arc'ta USDC'nin iki görünümü tek bakiyedir

Bu, bu arayüzdeki **en yüksek riskli tek detaydır**.

| Kullanım | Görünüm | Ölçek |
|---|---|---|
| `msg.value`, gas, `address.balance`, wagmi `useBalance` | **native, 18 decimal** | 1 USDC = `1e18` |
| Gösterim, girdi, ERC-20 `transfer`/`approve`, `balanceOf` | **ERC-20, 6 decimal** (`0x3600000000000000000000000000000000000000`) | 1 USDC = `1e6` |

- İkisi **aynı fonun iki okumasıdır**. `USDC.balanceOf(a)` ile `a.balance` asla **toplanmaz**, asla iki satır olarak gösterilmez, aralarında "swap" yapılmaz.
- `USDC_VIEW_SCALE = 1e12`. Native → ERC-20 **aşağı** yuvarlar (var olmayan bakiye uydurmamak için); ERC-20 → native kayıpsızdır.
- wagmi'nin `useBalance`'ı native görünümü `symbol: 'USDC'`, `decimals: 18` ile döndürür — yani **doğru varlık, yanlış ölçek**. Ekrana gitmeden önce `nativeToErc20` uygulanır.
- **Uygulama, tavsiye değil:** `useBalance`'ı import etmeye izinli **tek** modül `web/lib/balance.ts`'tir ve bunu bir eslint kuralı kapatır (Task 2, Adım 5). İkinci bir bakiye kaynağı = çifte sayım.
- Gas da aynı bakiyeden ödenir. Dolayısıyla **"%100" kısayolu bakiyenin tamamını harcayamaz**; gas payı ayrılmak zorundadır (Task 12, Adım 4).

### K2 — Kota ve ücret aritmetiği

- Curve düz **%1,25** alır: `PROTOCOL_FEE_BPS = 95`, `CREATOR_FEE_BPS = 30`. Kademe taraması yoktur.
- **Ücret iki bağımsız tavan yuvarlamasından TOPLANIR, birleşik bir orandan BÖLÜNMEZ.** İleri yönde `125` literali hiçbir yerde görünmez. Tek istisna `netQuoteInBeforeCorrection`'ın paydasıdır (`totalFeeBps + 10_000`), yani **geri** yön.
- `creator == address(0)` ise creator payı **alınmaz ve protokol payına katlanmaz** — işlem 30 bps daha ucuzdur.
- Ücret curve'ün **dışında** alınır: alımda curve maliyetinin üstüne eklenir, satımda curve çıktısından düşülür.
- **Ekranda ücret hiçbir zaman bir yüzdenin girdiye uygulanmasıyla üretilmez.** Ölçüldü: 1,000000 USDC bütçeli bir `buyExactQuoteIn`'de toplam ücret `12_345_679_012_345_680` wei, yani bütçenin **%1,2345679'u**, %1,25'i değil (%1,25 *curve tutarının* üzerinedir). "Fee 1.25%" yazan bir satırın yanına mutlak sayıyı koymak aritmetiği tutarsız gösterir. Kural: **iki parça mutlak değer olarak ayrı ayrı gösterilir**, oran ise "curve tutarının %1,25'i" diye etiketlenir.

### K3 — Değişmez curve sayıları (yeniden türetilmez)

| Sembol | Değer |
|---|---|
| `N` toplam arz | `1_000_000_000e18` = `1e27` |
| `T` sanal token rezervi | `1_073_000_000e18` |
| `S` satış arzı | `793_100_000e18` |
| `V` testnet | `4_292e15` |
| `V` üretim | `4_292e18` |
| `D` havuz tohumu | `206_886_011_183_597_390_493_942_218` |
| `R` graduation raise (testnet) | `12_161_433_369_060_378_706` wei ≈ 12,161433 USDC |
| `R` graduation raise (üretim) | `12_161_433_369_060_378_706_680` wei |
| Açılış market cap | `4e18` wei (testnet) · `4e21` wei (üretim) |
| Açılış fiyatı (tam token başına wei) | `4_000_000_000` (testnet) · `4_000_000_000_000` (üretim) |
| Graduation FDV | `58_783_256_052_377_201_521` wei (testnet) · `58_783_256_052_377_201_524_401` (üretim) |
| Fiyat katı | 14,6958× |
| Metadata sınırları | isim ≤ **32 bayt**, sembol ≤ **13 bayt**, uri ≤ **200 bayt** |

`R_prod` `1000 × R_testnet` **değildir** — 1000 katı **artı 680**, çünkü taban iki farklı ölçekte alınır. Hiçbir yerde birinden diğerini üretmeyin.

### K4 — Gösterim kuralları

- Locale **`en-US`**, nokta ondalık. `Intl.NumberFormat`/`toLocaleString` locale'siz çağrılamaz — kök `eslint.config.js` bunu zaten reddediyor.
- **Para tutarları 6 ondalığa kuantalanır** ve yön açıkça seçilir: **bakiye/alacak aşağı** (asla var olmayan parayı gösterme), **maliyet/ödeme yukarı** (asla ödenecekten azını gösterme). Ölçüldü: `Intl` yarıyı yukarı yuvarlıyor ve `500_000_000_000` wei'yi `0.000001` USDC gösteriyor, oysa ERC-20 görünümü `0`'dır — yani mevcut `formatUsdc` bir bakiye için **olmayan parayı** gösterebilir. Task 2 ayrı bir kesme (truncate) yolu ekler ve bu ayrışmayı bir testle sabitler.
- **Fiyat bir para tutarı değil bir orandır** ve 6 ondalıkla gösterilemez (testnet açılış fiyatı `0,000000004` USDC). Fiyatlar anlamlı basamak + sıfır-serisi sıkıştırmasıyla gösterilir (`0.0₈4`), ve **hiçbir zaman girdi olarak kullanılmaz**.
- Adresler `0x92FB…b4bA` biçiminde kısaltılır. Arc'ta ENS yoktur; `useEnsName` çağrılmaz.
- Zaman kolonları (`*_at`) **yalnızca gösterim** ve pencere içindir, **asla sıralama** — Faz 3 ölçtü: 400 ardışık blok çiftinin 197'si aynı timestamp'i taşıyor.

### K5 — Kontrat gerçeği

- `contracts/` bu fazda **değişmez**. `contracts/out/**` salt-okunur girdidir ve gitignore'dadır: ona ihtiyaç duyan CI işi `forge build`'i kendisi koşar (Task 3, Task 5).
- Üç işlem giriş noktası ve anlamları:
  - `buyExactTokensOut(tokensOut, maxQuoteIn)` — `maxQuoteIn` **ücret DAHİL** ve `msg.value`'ya karşı tutulur. Sınırda **revert eder**, kısmi doldurmaz.
  - `buyExactQuoteIn(minTokensOut)` — bütçe `msg.value`'dur. Rezervi aşan bütçe **revert etmez, rezerve kısar** ve artanı iade eder. **Varsayılan bu olmalıdır**: bayat bir kotadan dolayı curve'ün tepesinde başarısız olamayan tek giriş noktasıdır.
  - `sellExactTokensIn(tokensIn, minQuoteOut)` — `minQuoteOut` **ücret DÜŞÜLDÜKTEN SONRA** satıcıya ödenen net tutara karşıdır (ücret-hariç anapara).
- `sellExactTokensIn` `transferFrom` kullanır → **satış iki işlemdir**: `approve` sonra `sell`. `LaunchToken` düz OZ ERC-20'dir, `permit` **yoktur**.
- `CurveMath` hataları curve'ün giriş noktalarından **dışarı sızar** ve yayınlanmış yüzey sayılır. `NetTooSmall()` ulaşılabilir olanıdır ve `BondingCurve`'ün kendi hata kümesinde **değildir**. Decoder kütüphane katmanını da çözmek zorundadır.
- `complete == true` olduğunda **üç giriş noktası da** `CurveComplete()` ile döner. `graduate()` ve `Graduated` olayı gelmek üzeredir ama bu dalda **yok**; arayüz iki durumu da bugünden taşır (Task 10, Adım 5).

### K6 — Kalite kapıları

- `pnpm -r test`, `pnpm -r typecheck`, `pnpm run lint`, `pnpm run fmt:check` temiz.
- `pnpm --filter @arcpad/web build` temiz (CI'da zaten var).
- Kod yorumları **Türkçe, diakritiksiz** (mevcut konvansiyon). Plan ve doküman metni diakritikli.
- Yeni bağımlılıklar `pnpm-workspace.yaml`'ın `minimumReleaseAge: 1440` kapısına tabidir; kurulum tarihinde en az 24 saatlik sürüm seçilir ve **tam sürüm** `package.json`'a yazılır (caret yok — depo konvansiyonu).
- Her görev sonunda: en az bir **mutasyon** kaydedilir (kasten bozulan bir satır ve onu kırmızıya çeviren testin adı). Bir mutasyon hiçbir testi kırmıyorsa bu bir **boşluktur** ve rapora yazılır.

---

## Bu plan spec §7'ye değil KONTRATLARA ve İSKELETE karşı yazıldı

Spec §7 kontratlar yazılmadan önce yazıldı. Aşağıdakiler **ölçülerek** bayat bulundu; her biri bu planda düzeltilmiş hâliyle geçer. Numaralar rapordan referans verilebilsin diye.

| # | Spec / iskelet ifadesi | Gerçek (kaynak) |
|---|---|---|
| **S1** | §6.3 "kota her zaman zincirden — `curve.quoteBuy()` / `quoteSell()`" | Bu fonksiyonlar **yok**. `BondingCurve`'ün ABI'sinde tek bir view kota fonksiyonu bulunmuyor; dışa açık okunabilir durum dört rezerv getter'ı + `complete`'tir. Kota **istemci tarafında** hesaplanmak zorundadır. |
| **S2** | §5.1 "`buy()` (payable), `sell()`, `quoteBuy()`, `quoteSell()`" | Gerçek küme: `buyExactTokensOut(uint256,uint256)`, `buyExactQuoteIn(uint256)`, `sellExactTokensIn(uint256,uint256)`. |
| **S3** | §5.1 "Launch başına bir **EIP-1167 klonu**" | Klon yok. `LaunchFactory` her launch için `new BondingCurve{salt: …}` ile **tam bir kontrat** deploy eder; ucuzluk değil, `isCanonical`'ın CREATE2 türetmesi amaçtır. |
| **S4** | §5.1 "geliştirici ilk alımını **atomik** yapar" · §7.1 create formunda "geliştirici alımı" · §5.3 "Geliştirici ilk alım tavanı satış arzının %5'i" | `launch(string,string,string)` **`payable` değildir** ve hiçbir alım yapmaz. Dev buy ancak **ikinci bir işlem** olabilir ve zincirde **%5 tavanı yoktur**. Arayüzün gösterdiği herhangi bir tavan yalan olurdu (Task 13, Adım 4). |
| **S5** | §5.1/§5.5 `FeeSchedule` kontratı, "launch'a yazılan adres" | `contracts/src/` tam olarak altı dosya; `FeeSchedule` yok. Curve'ün oranları `public constant`'tır (95/30). |
| **S6** | §5.4 dört fazlı yaşam döngüsü `NotGraduated/Swept/PoolCreated/Rescued`, `pushGraduation()`, `rescue()` | `BondingCurve`'ün tek durumu `bool complete`. `graduate()`/`graduated` gelmek üzere; `Swept`/`Rescued` hiç yok. Arayüz **üç** durum tanır: aktif · complete · graduated. |
| **S7** | §5.4 "Son alım kısmi doldurulabilir" (genel olarak) | Yalnızca `buyExactQuoteIn` kısar. `buyExactTokensOut` sınırda `NotEnoughTokensToBuy()` ile **revert eder** — ikisini simetrik sunmak kullanıcı-zararı bir hatadır. |
| **S8** | §7.1 `/token/[address]` panelinde "yakılan miktar" (Burned) | Yakma yolu **yok**: OZ ERC-20 `to == address(0)` için revert eder ve Arc sıfır adrese native transferi ayrıca yasaklar. "Burned 0" satırı her token için sabit sıfır olurdu; **kaldırıldı** (Task 10). |
| **S9** | §7.1 About panelinde "Dexscreener / GeckoTerminal / Pool" linkleri | Spec §2 bu servisleri zaten kapsam dışı bırakıyor ve testnet'te havuz yok. Link şeridi **yalnızca** Contract (ArcScan token) + Curve (ArcScan curve) taşır. |
| **S10** | §7.3 birincil CTA'nın zeytin `#7E8F2E` üzerine beyaz metin olduğu ekran görüntüsü düzeni | Ölçüldü: `#FFFFFF` üzerine `#7E8F2E` kontrastı **3,59:1** — WCAG AA normal metin (4,5:1) **başarısız**. `#0B0B0B` metinle aynı zemin **5,49:1** verir. Deviasyon: birincil butonun metni koyudur (Task 6). |
| **S11** | §3.1 RPC `https://rpc.testnet.arc.network` · `packages/shared/src/chain.ts:17-18` aynı host | Arc'ın dokümantasyonu `arc.io`'ya taşındı; `.env.example` ve CI zaten `https://rpc.testnet.arc.io` kullanıyor, `chain.ts` **kullanmıyor**. Tek repoda iki farklı host. Task 1 kapatır. |
| **S12** | §7.2 bileşen ağacında `hooks/useQuote` "kota hook'u" | Kota bir **hook değil saf fonksiyon** olmak zorundadır: aynı aritmetiği hem quote gösterimi hem calldata üretimi kullanır ve ikisi ayrışırsa kullanıcı gördüğünden farklı bir işlem imzalar. Hook yalnızca rezervleri çeker (`useCurveState`), aritmetik `packages/shared/src/trade.ts`'te durur. |
| **S13** | §10 test tablosu "E2E: Playwright — Launch → al → sat → graduate → havuzda al" | `graduate` ve havuz Faz 2'dir. Bu fazın E2E'si: launch → al (exact-quote-in) → al (exact-tokens-out) → sat (approve + sell) → sınır → tamamlanma. |
| **S14** | §7.3 "serif wordmark + geometrik sans gövde" — font dosyası yok | İskelet hiçbir font yüklemiyor; `layout.tsx` sistem yığınına düşüyor. Task 6 `next/font/local` ile iki yüz pinler, aksi hâlde "şablon" izlenimi tam olarak buradan gelir. |
| **S15** | wagmi kullanımında `useAccount` | wagmi `3.7.4`'te `useAccount`, `useConnection`'ın **deprecated** takma adıdır (kurulu paketin export barrel'ından ölçüldü); `useAccountEffect` de `useConnectionEffect`'in. Yeni kod `useConnection` kullanır. |
| **S16** | §7.1 create formunda "Advanced" katlanır bölüm | Launch'ın **üç** argümanı var (`name`, `symbol`, `uri`) ve geri kalan her parametre (`V`, `T`, `S`) factory'nin immutable'ıdır — creator'ın ayarlayabileceği hiçbir ileri düzey alan **yoktur**. Boş bir "Advanced" bölümü, olmayan bir kontrol vaat eder; **çizilmez** (Task 13). Faz 7'nin slipaj/priority ayarları geldiğinde geri gelebilir. |

**Bayat OLMAYAN, doğrulanan spec ifadeleri:** §7.3'ün tasarım tokenları (`globals.css`'te birebir duruyorlar) ve locale sabitleme gerekçesi; §7.1'in Explore sıralama/yaş filtreleri (Faz 3'ün `SORTS`'u onları birebir karşılıyor); §6.3'ün "araya API katmanı konmaz" kararı; §9'un "revert'ler custom error selector'ından çözümlenir" satırı; §5.3'ün "token oluşturmak ücretsizdir" ifadesi (`launch` gerçekten ücretsiz ve `payable` değil).

---

## Faz 3 ile hizalama: okuma sözleşmesi

Faz 3 (`docs/plans/2026-07-30-arcpad-phase3-indexer.md`) `@arcpad/db` paketini ve `token_overview` view'ini teslim ediyor. **Bu faz o sözleşmeyi tüketir, yeniden tanımlamaz.**

**Hazır gelenler** (`packages/db/src/queries.ts`): `SORTS` (`recentBuys` = `last_buy_seq DESC`, `newest`, `oldest`, `marketCap`, `volume`) · `listTokens(pool, {sort, ageDays, cursor, limit})` · `getTokenOverview(pool, token)` · `listTrades(pool, token, {cursor, limit})` · `listHolders(pool, token, {limit})` · `listLaunchesByCreator(pool, creator)` · `getClaimableFees(pool, recipient)` · `listCreatorEarningsByLaunch(pool, creator)`.

**`token_overview`'dan kullanılan alanlar:** `token, curve, name, symbol, uri, launch_creator, fee_creator, virtual_*_reserves_*, real_*_reserves_*, complete, completed_seq, pool_seed_supply_tok, market_cap_wei, price_wei_per_token, progress_ppm, graduation_raise_wei, holder_count, volume_total_wei, volume_24h_wei, ath_market_cap_wei, trade_count, buy_count, last_trade_seq, last_buy_seq, last_trade_at, last_buy_at, created_seq, created_at`.

**Sonek sözleşmesi bağlayıcıdır:** `_wei` = 18 decimal native USDC, `_tok` = 18 decimal token tabanı, `_ppm` = milyonda pay, `_seq` = `event_seq`, `_at` = yalnızca gösterim. `_wei` ve `_tok` ikisi de 1e18 ölçeklidir ama **toplanmaları kategori hatasıdır** — fiyat `wei/tok`'tur. Arayüzün tipleri bunu taşır: `bigint` yerine `WeiUsdc` ve `TokAmount` markalı (branded) tipler kullanılır (Task 2).

**Faz 3'ün SAĞLAMADIĞI, bu fazın kendi üstlendiği üç şey** (varsaymak yerine adlandırılıyor):

1. **Arama sorgusu.** `queries.ts`'te isim/sembol/adres arayan bir fonksiyon yok. ⌘K bunu gerektiriyor ve 159 bin satırda istemci tarafı filtreleme kabul edilemez. **Task 9 `searchTokens`'ı `packages/db`'ye ekler** — Faz 3'ün disiplini aynen: sıralama ifadesi `SORTS`'tan gelir, keyset sayfalama, `_at` üzerinde sıralama yok.
2. **`listHolders` sayfalama taşımıyor** (yalnızca `{limit}`). Token sayfasının Holders sekmesi sayfalıdır. **Task 11 `cursor` ekler** (keyset: `balance_tok DESC, holder ASC`, çünkü `balance_tok` tekil değil).
3. **`candles` / OHLCV yok** ve Faz 3 bunu açıkça Faz 4'e devretti. **Task 10 grafiği `trades`'ten üretir** ve kovayı **`event_seq`/blok** ekseninde tanımlar, timestamp'te değil — Faz 3'ün ölçtüğü "blokların yarısı aynı timestamp'i taşıyor" bulgusunun doğrudan sonucu.
4. **Metadata çözülmüyor.** `launches.uri` ham dizedir; açıklama, görsel ve sosyal linkler o URI'nin gösterdiği JSON'un içindedir ve indexer onu ne çeker ne saklar. **Task 7 bir çözücü yazar** (izin listesi, zaman aşımı, gövde tavanı, önbellek) — çünkü `uri` launch edenin yazdığı serbest bir dizedir ve sunucudan çekilmesi bir SSRF yüzeyidir. Kalıcı yeri indexer'dır (`image_url`, `description` kolonları); Faz 5'e devrediliyor.

**Faz 3'ün bu faza devrettiği yükümlülük:** kullanıcının adres yapıştırdığı yol `Launched`'dan başlamaz, dolayısıyla `isCanonical`'ı çağırmak **zorundadır** ve o çağrı **hem `try/catch` hem açık gaz tavanı** kullanmalıdır; yalnızca biri yetmez. Task 9 ve Task 10 bunu uygular.

**Bağımlılık yönü:** bu fazın hiçbir görevi Faz 3'ün *çalışmasını* beklemez. `@arcpad/db` sorguları bir arayüz olarak tüketilir ve testlerde sahte (fake) bir uygulama ile beslenir; canlı Postgres yalnızca Task 15'in E2E ayağında gerekir. **Al-sat paneli veritabanına hiç dokunmaz** — rezervleri zincirden okur — yani veritabanı düşse token sayfası bozulur ama **işlem yapılabilir kalır**. Bu bir yan etki değil, test edilen bir özelliktir (Task 12, Adım 6).

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `packages/shared/src/chain.ts` | **değişir** — `arc.io` hostu, zincir kaydı (`ARC_CHAINS`), mainnet'in yapılandırma olduğu yer |
| `packages/shared/test/chain.test.ts` | **değişir** — host iddiası |
| `packages/shared/src/usdc.ts` | **değişir** — kuantalama, yönlü biçimlendirme, markalı tipler |
| `packages/shared/src/text.ts` | **yeni** — UTF-8 bayt sayımı, NFC, güvenli gösterim |
| `packages/shared/src/abi/*.ts` | **yeni** — dört kontratın ABI'si + kütüphane hataları, tek kaynak |
| `packages/shared/src/curve.ts` | **yeni** — `CurveMath`'in TS portu |
| `packages/shared/src/trade.ts` | **yeni** — üç giriş noktasının planlayıcısı, `TRADE_ACTIONS` |
| `packages/shared/src/devchain.ts` | **yeni** — anvil + gerçek artifact deploy'u; `@arcpad/shared/devchain` alt-yolu, uygulama kodunda yasak |
| `packages/shared/test/*` | **yeni/değişir** — birim testler + ABI parity + diferansiyel test |
| `packages/db/src/queries.ts` | **değişir** — `searchTokens`, `listHolders` cursor'u (Faz 3'ün paketine ekleme) |
| `web/app/layout.tsx` | **değişir** — font, kabuk, tema, atlama linki |
| `web/app/page.tsx` | **değişir** — iskelet demosu Explore'a döner |
| `web/app/providers.tsx` | **değişir** — react-query varsayılanları, connector'lar |
| `web/app/globals.css` | **değişir** — token genişletme, odak halkası, `color-scheme` |
| `web/app/token/[address]/{page,loading,error,not-found}.tsx` | **yeni** |
| `web/app/create/page.tsx` | **yeni** |
| `web/app/api/metadata/route.ts` | **yeni** — isteğe bağlı pinning vekili (yalnızca yazma) |
| `web/app/api/search/route.ts` | **yeni** — ⌘K'nın okuma yolu; spec §6.3'e gerekçeli istisna (Task 9) |
| `web/components/{layout,explore,search,token,create,tx,ui}/*` | **yeni** |
| `web/hooks/*` | **yeni** — `useArcNetwork`, `useUsdcBalance`, `useCurveState`, `useTrade`, `useApproval`, `useGasReserve`, `useLaunch` |
| `web/lib/{addresses,profile,balance,db,read,canonical,metadata,decodeRevert,failureTable,gas,fonts}.ts` | **yeni** |
| `web/scripts/preflight.ts` | **yeni** — adres defteri doğrulaması, deploy öncesi |
| `packages/db/migrations/008_search.sql` | **yeni** — `pg_trgm` + iki trigram indeksi (Task 7) |
| `web/test/**` | **yeni** — Vitest birim (`*.test.ts`) + bileşen (`*.test.tsx`) |
| `web/e2e/**`, `web/playwright.config.ts` | **yeni** — Playwright, iki ayak |
| `web/vitest.config.ts` | **değişir** — jsdom, tsx, iki proje (unit / component) |
| `.github/workflows/node.yml` | **değişir** — ABI parity ve zincir diferansiyel işleri, E2E işi |
| `.env.example` | **değişir** — `NEXT_PUBLIC_*` anahtarları |

---

### Task 1: Zincir kaydı, adres defteri ve bağlantı katmanı

Mainnet'in "yalnızca yapılandırma" olması bu fazda **iddia edilmez, ölçülür**. Arc mainnet yoktur (Arc'ın kendi rollout tablosunda Public Testnet tek canlı faz, `rpc.mainnet.arc.io` JSON-RPC değil HTML hata sayfası döndürüyor) ve Circle bir mainnet chainId'si **yayınlamamıştır** — bu yüzden bu görev bir mainnet sabiti **uydurmaz**. Onun yerine zinciri bir *fonksiyona* çevirir ve "hiçbir yerde ikinci bir sabit yok" iddiasını çalıştırılabilir bir kapıya bağlar.

**Files:**
- Modify: `packages/shared/src/chain.ts`, `packages/shared/src/index.ts`, `packages/shared/test/chain.test.ts`
- Create: `packages/shared/test/chain-registry.test.ts`
- Create: `web/lib/addresses.ts`, `web/lib/profile.ts`, `web/hooks/useArcNetwork.ts`, `web/scripts/preflight.ts`
- Modify: `web/lib/wagmi.ts`, `web/app/providers.tsx`, `web/package.json`, `.env.example`

**Interfaces:**
- Üretir: `buildArcChain(cfg: ArcChainConfig): Chain` · `ARC_CHAINS` (bugün tek giriş: `arcTestnet`) · `ARC_TESTNET_CHAIN_ID` · `USDC_ERC20_ADDRESS` · `MULTICALL3_ADDRESS` · `ADDRESSES` · `getCurveProfile()` · `useArcNetwork()`
- Tüketir: yok.

- [ ] **Adım 1: `chain.ts`'i bir kayda çevir, ve `arc.io` hostuna taşı**

```ts
export const ARC_TESTNET_CHAIN_ID = 5042002 as const

export interface ArcChainConfig {
  id: number
  name: string
  rpcHttp: string
  rpcWebSocket?: string
  explorerUrl: string
  testnet: boolean
}

/**
 * Arc'ta native varlik USDC'nin KENDISIDIR ve native gorunum 18 decimal'dir.
 * Bu fonksiyon zincire ait olan HER SEYI tek yerde tutar: mainnet acildiginda
 * degisen sey yeni bir ArcChainConfig'tir, kod degil.
 */
export function buildArcChain(cfg: ArcChainConfig) {
  return defineChain({
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
    rpcUrls: {
      default: {
        http: [cfg.rpcHttp],
        ...(cfg.rpcWebSocket ? { webSocket: [cfg.rpcWebSocket] } : {}),
      },
    },
    blockExplorers: { default: { name: 'ArcScan', url: cfg.explorerUrl } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    testnet: cfg.testnet,
  })
}

// Arc'in dokumantasyonu arc.network -> arc.io'ya tasindi. Eski host BUGUN
// hala cevap veriyor ama hicbir yerde dokumante degil; .env.example ve CI
// zaten yeni hostu kullaniyor, bu dosya kullanmiyordu.
export const arcTestnet = buildArcChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  rpcHttp: 'https://rpc.testnet.arc.io',
  rpcWebSocket: 'wss://rpc.testnet.arc.io',
  explorerUrl: 'https://testnet.arcscan.app',
  testnet: true,
})

/**
 * Desteklenen zincirler. BUGUN TEK GIRIS VAR ve bu kasitlidir: Arc mainnet
 * yoktur, Circle bir mainnet chainId'si yayinlamamistir, ve olmayan bir agin
 * kimligini uydurmak "yapilandirma" degil TAHMIN olurdu. Mainnet aciklandiginda
 * buraya bir satir eklenir; kayit disinda hicbir dosya degismez ve bunu
 * chain-registry testi kapatir.
 */
export const ARC_CHAINS = { [ARC_TESTNET_CHAIN_ID]: arcTestnet } as const
```

`MULTICALL3_ADDRESS` (`0xcA11bde05977b3631167028862bE2a173976CA11`) ve `USDC_ERC20_ADDRESS` (`0x3600000000000000000000000000000000000000`) aynı dosyadan export edilir; `index.ts` barrel'ına eklenir.

- [ ] **Adım 2: "Mainnet yalnızca yapılandırmadır" iddiasını kapıya çevir**

`packages/shared/test/chain-registry.test.ts`:

```ts
// (a) DAVRANIS: kayitta olmayan bir zincir de kurulabiliyor mu? Mainnet
//     acildiginda yapilacak isin TAMAMI bu cagridir.
it('bilinmeyen bir Arc profili tek bir cagriyla kurulabilir', () => {
  const hypothetical = buildArcChain({
    id: 424242, name: 'Arc Hypothetical', rpcHttp: 'https://rpc.example.invalid',
    explorerUrl: 'https://explorer.example.invalid', testnet: false,
  })
  expect(hypothetical.nativeCurrency).toEqual({ name: 'USD Coin', symbol: 'USDC', decimals: 18 })
  expect(hypothetical.contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS)
  expect(hypothetical.blockExplorers?.default.url).toBe('https://explorer.example.invalid')
})

// (b) KAPI: zincir kimligi ve hostlar kayit DISINDA hicbir yerde yazili
//     olmasin. Bu, (a)'nin kagit uzerinde kalmasini engelleyen sey.
it('chainId ve Arc hostlari yalnizca chain.ts icinde yazili', async () => {
  const files = await gitTrackedFiles(['*.ts', '*.tsx', '*.sql'])
  const allowed = new Set(['packages/shared/src/chain.ts', 'packages/shared/test/chain.test.ts'])
  for (const f of files) {
    if (allowed.has(f)) continue
    const src = await readFile(f, 'utf8')
    expect(src, `${f} chainId literalini icermemeli`).not.toMatch(/\b5042002\b/)
    expect(src, `${f} bir Arc hostunu icermemeli`).not.toMatch(/arc\.(io|network)|arcscan/)
  }
})
```

`gitTrackedFiles(globs)` aynı dosyadaki yerel bir yardımcıdır: `execFileSync('git', ['ls-files', ...globs])` çıktısını satırlara böler. `git ls-files` kullanılır, dizin taraması değil — `node_modules` ve `contracts/out` böylece kendiliğinden dışarıda kalır ve kapı, depoya **girmiş** dosyaları ölçer.

> Kapı `contracts/**` ve `.env.example`'ı **kapsamaz** (Solidity TypeScript'i import edemez; env dosyası tanımı gereği yapılandırmadır). Bu, Faz 0'ın devir listesindeki "diller arası sabit kontrolü" kaleminin TypeScript yarısıdır — Solidity yarısı Faz 3'ün ABI parity testinde.

- [ ] **Adım 3: Adres defteri — env'den, doğrulanmış, tek yerde**

`web/lib/addresses.ts`:

```ts
// NEXT_PUBLIC_* degiskenleri Next tarafindan BUILD ZAMANINDA gomulur. Yani
// "mainnet'e gecmek" = ayni kaynak agaci farkli env ile yeniden build etmek.
// Kod degisikligi degil; bu cumle S11'in kapatilmasidir.
function required(key: string, raw: string | undefined): string {
  if (!raw) throw new Error(`${key} tanimli degil (bkz. .env.example)`)
  return raw
}

function address(key: string, raw: string | undefined): Address {
  const value = required(key, raw)
  if (!isAddress(value)) throw new Error(`${key} gecerli bir adres degil: ${value}`)
  return getAddress(value) // checksum'a normalize; karsilastirmalar kucuk harfle yapilir
}

export const ARC_CHAIN =
  ARC_CHAINS[Number(required('NEXT_PUBLIC_ARC_CHAIN_ID', process.env.NEXT_PUBLIC_ARC_CHAIN_ID))] ??
  (() => {
    throw new Error('NEXT_PUBLIC_ARC_CHAIN_ID kayitta yok')
  })()

export const ADDRESSES = {
  launchFactory: address('NEXT_PUBLIC_ARCPAD_FACTORY', process.env.NEXT_PUBLIC_ARCPAD_FACTORY),
  feeEscrow: address('NEXT_PUBLIC_ARCPAD_ESCROW', process.env.NEXT_PUBLIC_ARCPAD_ESCROW),
} as const
```

`.env.example`'a eklenenler:

```
# web (NEXT_PUBLIC_* build zamaninda gomulur)
NEXT_PUBLIC_ARC_CHAIN_ID=5042002
NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.io
NEXT_PUBLIC_ARCPAD_FACTORY=
NEXT_PUBLIC_ARCPAD_ESCROW=
```

Adresler **boş bırakılır**: Faz 1d deploy'u henüz yapılmadı ve bir yer tutucu adres, "yapılandırılmamış" durumunu "yanlış yapılandırılmış" durumundan ayırt edilemez hâle getirir.

- [ ] **Adım 4: Profil zincirden okunur, env'den değil**

`web/lib/profile.ts` — `VIRTUAL_TOKEN_RESERVES`, `VIRTUAL_QUOTE_RESERVES`, `SALE_SUPPLY` factory'nin public immutable'larından tek bir multicall ile okunur ve React `cache()` ile istek başına bir kez çağrılır. Gerekçe Faz 3'ün aynısı: testnet ile üretim **yalnızca `V`'de** ayrışır (tam 1000×) ve yanlış bir `V` market cap'i 1000 kat kaydırır; başka hiçbir kontrol bunu görmez. Env'den kopyalamak o hatayı mümkün kılar, zincirden okumak kılmaz.

Dönen tip `CurveProfile` (Task 4'te tanımlanır ve orada da aynı isimle kullanılır): `{ virtualTokenReserves: bigint; virtualQuoteReserves: bigint; saleSupply: bigint }`.

- [ ] **Adım 5: Bağlantı ve yanlış-ağ**

`web/lib/wagmi.ts`: `connectors: [injected()]` + wagmi'nin varsayılan EIP-6963 keşfi (`multiInjectedProviderDiscovery`), `transports: { [ARC_CHAIN.id]: http(process.env.NEXT_PUBLIC_ARC_RPC_URL) }`, `ssr: true`.

`web/hooks/useArcNetwork.ts`:

```ts
// wagmi 3.7.4'te `useAccount`, `useConnection`'in DEPRECATED takma adidir
// (kurulu paketin export barrel'inda oyle yaziyor). Yeni kod useConnection
// kullanir.
export function useArcNetwork() {
  const { status, address, chainId } = useConnection()
  const { switchChain, isPending } = useSwitchChain()
  // DIKKAT: baglanti yokken chainId UNDEFINED'dir (config'in varsayilani
  // DEGIL). "Yanlis ag" ancak BAGLIYKEN anlamlidir; aksi halde her ziyaretci
  // ilk saniyede yanlis-ag uyarisi gorurdu.
  const wrongNetwork = status === 'connected' && chainId !== ARC_CHAIN.id
  return { status, address, chainId, wrongNetwork, switchChain, isSwitching: isPending }
}
```

Yanlış ağdayken: **tüm yazma butonları** "Switch to Arc Testnet" hâline gelir ve `switchChain` çağırır; cüzdanda ağ yoksa wagmi `wallet_addEthereumChain`'i `ARC_CHAIN`'den türetir. Okuma yolları etkilenmez (RPC bizim transport'umuzdur, cüzdanın değil) — yani yanlış ağdaki bir kullanıcı siteyi gezebilir, yalnızca imzalayamaz.

Cüzdanın kendi arayüzü native bakiyeyi **18 decimal `USDC`** olarak gösterecektir ve bunu değiştiremeyiz. Bu bir çelişki değil aynı fonun ham okumasıdır; arayüzün işi kendi tarafında 6 decimal göstermek (K1) ve bunu bir yerde açıklamaktır — cüzdan ile site farklı basamak sayısı gösterdiğinde kullanıcının ilk varsayımı "iki ayrı bakiyem var" olur, ki tam olarak engellemek istediğimiz yanılgı budur. Wallet menüsüne tek satırlık bir açıklama konur.

- [ ] **Adım 6: Preflight — yanlış yapılandırmayı kullanıcıdan önce yakala**

`web/scripts/preflight.ts` (`pnpm --filter @arcpad/web preflight`), dört iddia, hepsi tek RPC turunda:

1. `eth_chainId` == `ARC_CHAIN.id` (aksi halde çıkış kodu 1, mesajda iki değer).
2. `getCode(ADDRESSES.launchFactory).length > 2` — kodsuz bir factory adresi tüm ürünü sessizce ölü bırakır.
3. `factory.escrow()` == `ADDRESSES.feeEscrow` — iki adresin **birbirini** doğrulaması; ayrı ayrı doğru ama eşleşmeyen bir çift, gerçekçi bir kopyala-yapıştır hatasıdır.
4. `factory.VIRTUAL_QUOTE_RESERVES()` ∈ {`4292e15`, `4292e18`} ve hangisi olduğu **stdout'a yazılır** ("testnet profile" / "production profile"). Bir üretim profilinin testnet'e, ya da tersinin, sessizce yayınlanmasını yakalar.

Preflight CI'da ve deploy öncesi koşar. Adresler boşsa **atlanmaz, açık bir "not configured" mesajıyla çıkış kodu 2 verir** — atlanan bir kontrol geçen bir kontrol gibi görünür.

- [ ] **Adım 7: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `ARC_TESTNET_CHAIN_ID` → `5042003` | `chain.test.ts` chainId iddiası + preflight (1) |
| `web/lib/wagmi.ts`'e `chainId: 5042002` literali yaz | `chain-registry` kapısı (b) |
| `buildArcChain`'de `decimals: 18` → `6` | `chain-registry` (a) — **ve bu mutant tam olarak K1'in ihlalidir** |
| `wrongNetwork`'ten `status === 'connected'` koşulunu kaldır | bağlanmamış kullanıcı için yanlış-ağ uyarısı testi |
| Preflight'ın (3) numaralı iddiasını sil | preflight'ın uyuşmayan-çift testi (sahte factory ile) |

- [ ] **Adım 8: Commit**

```bash
git commit -m "feat(web): make the Arc chain a registry entry and verify the address book before users do"
```

**Deliverable:** `pnpm -r test` yeşil; `chain-registry` kapısı depoda `5042002`/`arc.io` literalinin kayıt dışında **bulunmadığını** ölçüyor; `preflight` yapılandırılmamış adres defterinde çıkış kodu 2 veriyor.

---

### Task 2: Para katmanı — kuantalama, yönlü yuvarlama ve bayt sayımı

`packages/shared/src/usdc.ts` bugün iki şey yapıyor: iki görünüm arası ölçekleme ve `Intl` ile biçimlendirme. İkincisi **bir bakiye için yanlış yönde yuvarlıyor** ve bu ölçüldü. Bu görev para katmanını arayüzün ihtiyaç duyduğu üç şeye tamamlar: girdiyi kuantala, çıktıyı **yönü seçilmiş** biçimlendir, metni **bayt** olarak say.

**Files:**
- Modify: `packages/shared/src/usdc.ts`, `packages/shared/src/index.ts`, `packages/shared/test/usdc.test.ts`
- Create: `packages/shared/src/text.ts`, `packages/shared/test/text.test.ts`, `packages/shared/test/usdc-rounding.test.ts`
- Create: `web/lib/balance.ts`, `web/hooks/useUsdcBalance.ts`
- Modify: `eslint.config.js`

**Interfaces:**
- Üretir: `USDC_VIEW_SCALE` · `type ParseReason = 'empty' | 'negative' | 'notANumber' | 'exponent' | 'tooManyDecimals'` · `parseUsdcAmount(text): { ok: true; value: bigint } | { ok: false; reason: ParseReason }` · `formatUsdcAmount(native, {rounding, maxFractionDigits})` · `formatUsdcCompact(native)` · `formatTokenAmount(tok)` · `formatPriceWeiPerToken(weiPerWholeToken)` · `utf8ByteLength(s)` · `normaliseMetadataText(s)` · `truncateToBytes(s, maxBytes)` · `sanitiseForDisplay(s)` · `METADATA_LIMITS` · `useUsdcBalance()`
- Tüketir: Task 1'in `useArcNetwork()`'ü (yalnızca `useUsdcBalance` içinde, adres için).

- [ ] **Adım 1: Kuantalama — girdi 6 ondalıkla sınırlıdır**

```ts
export const USDC_VIEW_SCALE = 10n ** 12n // 1e18 native == 1e6 ERC-20

/**
 * Kullanicinin yazdigi metni native (18 decimal) wei'ye cevirir, AMA once
 * 6 ondaliga kuantalar: once parseUnits(text, 6), sonra erc20ToNative.
 *
 * NEDEN 6: ERC-20 gorunumu mikro-USDC altini TEMSIL EDEMEZ, yani 6 ondaligin
 * altindaki bir girdi ekrana geri yazilamaz -- kullanici yazdiginin
 * kaybolmasini gorur. Ikinci ve daha sert sebep: kuantalama iki revert
 * sinifini YAPISAL OLARAK erisilemez kilar (Task 14, S-tablosu). En kucuk
 * kabul edilen girdi 0.000001 USDC = 1e12 wei'dir; NetTooSmall'in ust siniri
 * 3 wei, ProceedsTooSmall'un ~4.96e8 token tabanidir -- ikisi de kuantumun
 * cok altinda.
 */
export function parseUsdcAmount(text: string): { ok: true; value: bigint } | { ok: false; reason: ParseReason }
```

Reddedilenler (her biri bir test): boş dize, `-1`, `1e3` (üstel gösterim), `1.2345678` (6'dan fazla ondalık), `1,5` (locale ayırıcısı), `NaN`, `Infinity`, `0x10`. Reddetme bir istisna **atmaz**, `{ ok: false, reason }` döner — form alanı bir istisnayı değil bir mesajı gösterir.

- [ ] **Adım 2: Yönlü biçimlendirme, ve mevcut `formatUsdc`'in ölçülmüş hatası**

```ts
export type Rounding = 'down' | 'up'

/**
 * 18 decimal native tutari 6 ondalikli bir dizeye cevirir. YON ZORUNLU
 * ARGUMANDIR, varsayilani YOKTUR:
 *   'down' -> bakiye, alacak, ELE GECEN tutar. Asla var olmayan parayi gostermez.
 *   'up'   -> maliyet, odenecek tutar, ust sinir. Asla odenecekten azini gostermez.
 * Tamamen bigint aritmetigi; Number yolu YOK.
 */
export function formatUsdcAmount(native: bigint, opts: { rounding: Rounding; maxFractionDigits?: number }): string
```

`usdc-rounding.test.ts`, **ölçülmüş ayrışmayı** sabitler — bu, ikinci bir biçimlendiricinin neden var olduğunun kanıtıdır:

```ts
// Intl yariyi YUKARI yuvarlar. 5e11 wei, ERC-20 gorunumunde SIFIRDIR
// (nativeToErc20(5e11) == 0n) ama mevcut formatUsdc onu 0.000001 USDC
// gosterir -- yani bir bakiye icin OLMAYAN parayi gosterir.
it('formatUsdc bir bakiye icin yukari yuvarliyor, formatUsdcAmount yuvarlamiyor', () => {
  expect(nativeToErc20(500_000_000_000n)).toBe(0n)
  expect(formatUsdc(500_000_000_000n, { maxFractionDigits: 6 })).toBe('0.000001')     // eski yol
  expect(formatUsdcAmount(500_000_000_000n, { rounding: 'down' })).toBe('0.000000')   // yeni yol
  expect(formatUsdcAmount(500_000_000_000n, { rounding: 'up' })).toBe('0.000001')     // maliyet yonu
})

// GOSTERIM ILE ERC-20 GORUNUMU AYNI SAYIYI SOYLEMEK ZORUNDA. Bu, K1'in
// tek satirlik olculebilir hali.
it('down yonu her zaman nativeToErc20 ile ayni degeri gosterir', () => {
  for (const v of [0n, 1n, 999_999_999_999n, 1_000_000_000_000n, 12_161_433_369_060_378_706n]) {
    const shown = formatUsdcAmount(v, { rounding: 'down' }).replace(/[,.]/g, '')
    expect(BigInt(shown)).toBe(nativeToErc20(v))
  }
})
```

Sabitlenmiş değerler (elle türetildi, fonksiyonu çağırarak değil):

| native wei | `down` | `up` | ne olduğu |
|---|---|---|---|
| `12_161_433_369_060_378_706` | `12.161433` | `12.161434` | testnet graduation raise `R` |
| `12_313_451_286_173_633_442` | `12.313451` | `12.313452` | `R` + ücretler (curve'ü tamamlayan toplam) |
| `975_308_641_975_308_639` | `0.975308` | `0.975309` | 1 USDC'lik gidiş-dönüş sonrası net |
| `9_382_716_049_382_717` | `0.009382` | `0.009383` | 1 USDC'lik alımın protokol payı |
| `2_962_962_962_962_963` | `0.002962` | `0.002963` | aynı alımın creator payı |

`formatUsdc` **silinmez**: `web/app/page.tsx` onu kullanıyor ve Faz 0'ın testleri onu pinliyor. NatSpec'ine "bakiye göstermek için kullanılmaz, `formatUsdcAmount(…, 'down')` kullanılır" notu eklenir; Task 8 `page.tsx`'i yeniden yazdığında çağrısı kalmaz ve fonksiyon yalnızca kendi testiyle yaşar.

`formatUsdcCompact` market cap içindir (`$57.53M`, `$4.00`): 4 anlamlı basamak, `K/M/B` eki, **aşağı** yuvarlama. `formatPriceWeiPerToken` sıfır-serisini sıkıştırır: `4_000_000_000` (tam token başına wei) → `0.0₈4`; `4_000_000_000_000` → `0.0₅4`. `formatTokenAmount` token tabanını (`_tok`) 6 ondalıkla, aşağı yuvarlayarak gösterir. Üçü de tamamen bigint üzerinde çalışır.

- [ ] **Adım 3: Bayt sayımı — `.length` bir tuzaktır**

`text.ts`:

```ts
export const METADATA_LIMITS = { name: 32, symbol: 13, uri: 200 } as const

/** UTF-8 BAYT sayisi. TextEncoder, JS string uzunlugu DEGIL. */
export function utf8ByteLength(s: string): number

/**
 * Zincire giden metin ile bayt sayilan metin AYNI OLMAK ZORUNDA, bu yuzden
 * NFC normalizasyonu sayimdan ONCE yapilir ve normalize edilmis dize
 * gonderilir. Olculdu: "e" + U+0301 (NFD) 3 bayt, NFC'si 2 bayt -- ayni
 * gorunen isim, iki farkli uzunluk.
 */
export function normaliseMetadataText(s: string): string

/** Bayt sinirina keser ama KOD NOKTASI sinirinda -- bir emoji'yi ortadan bolmez. */
export function truncateToBytes(s: string, maxBytes: number): string
```

Sabitlenmiş test vektörleri (hepsi ölçüldü):

| Girdi | `.length` | kod noktası | bayt | NFC bayt |
|---|---|---|---|---|
| `arcpad` | 6 | 6 | 6 | 6 |
| `é` (NFC, U+00E9) | 1 | 1 | 2 | 2 |
| `é` (NFD, `e`+U+0301) | 2 | 2 | **3** | **2** |
| `🚀` | 2 | 1 | **4** | 4 |
| `🚀` ×8 | 16 | 8 | **32** | 32 → isim sınırında **tam** |
| `🚀` ×9 | 18 | 9 | **36** | 36 → **reddedilir**, `.length` 18 der |
| `Görüşürüz` | 9 | 9 | **14** | 14 |
| `안녕하세요 토큰` | 8 | 8 | **22** | 22 |

`🚀`×9 satırı bu görevin varlık sebebidir: `.length` ile doğrulayan bir form onu kabul eder, `LaunchToken` constructor'ı `NameTooLong()` ile reddeder ve kullanıcı gas ödemiş olur.

- [ ] **Adım 4: Güvenli gösterim**

`sanitiseForDisplay(s)`: C0/C1 kontrol karakterlerini, bidi geçersiz kılmalarını (U+202A–202E, U+2066–2069) ve sıfır-genişlikli birleştiricileri **atar**; ardışık boşlukları tekleştirir. Zincir tarafında isim/sembol üzerinde **hiçbir karakter kısıtı yoktur** (yalnızca bayt uzunluğu — Faz 1c'nin incelemesi NUL'lu ve geçersiz UTF-8'li metadata ile launch etti ve kanoniklik bozulmadı), yani bir launch adı ekranda başka bir token'ın adı gibi görünecek şekilde hazırlanabilir. React kaçışı HTML enjeksiyonunu durdurur, **görsel taklidi durdurmaz**. Kural: isim/sembol **hiçbir zaman** bir anahtar, rota parçası veya URL olarak kullanılmaz — o iş adrese aittir.

- [ ] **Adım 5: Tek bakiye kaynağı, ve onu koruyan lint kuralı**

`web/lib/balance.ts` `useBalance`'ı import etmeye izinli **tek** modüldür:

```ts
export function useUsdcBalance() {
  const { address } = useArcNetwork()
  // wagmi'nin useBalance'i NATIVE gorunumu dondurur: symbol 'USDC',
  // decimals 18. Dogru varlik, yanlis olcek. Ekrana giden sey 6 decimal
  // gorunumdur; ERC-20 kontratindan IKINCI bir bakiye OKUNMAZ, cunku o ayni
  // fonun ayni okumasidir ve iki satir gostermek ayni parayi iki kez saymaktir.
  const { data, isPending, refetch } = useBalance({ address })
  const native = data?.value ?? 0n
  return { native, display: formatUsdcAmount(native, { rounding: 'down' }), isPending, refetch }
}
```

`eslint.config.js`'e eklenen kural (`web/**` dosyaları, `web/lib/balance.ts` hariç): `no-restricted-imports` ile `wagmi`'den `useBalance`, `useAccount` ve `useAccountEffect` import etmek **hata**. Mesajlar sırasıyla `web/lib/balance.ts`'e, `useConnection`'a ve `useConnectionEffect`'e yönlendirir. İlkinin gerekçesi tek cümleyle kuralın içinde durur: Arc'ta native ve ERC-20 görünüm aynı fondur, ikinci bir okuma çifte sayımdır.

- [ ] **Adım 6: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `formatUsdcAmount`'ta `rounding`'i yoksay, hep `up` | "down her zaman `nativeToErc20` ile aynı" testi |
| `parseUsdcAmount`'ta `parseUnits(text, 6)` → `parseUnits(text, 18)` | kuantalama testi (`1.2345678` artık kabul edilir) |
| `utf8ByteLength` → `s.length` | `🚀`×9 vektörü |
| `normaliseMetadataText`'ten NFC'yi kaldır | NFD `é` vektörü |
| `truncateToBytes`'ı bayt indeksiyle `slice` yap | emoji bölme testi (geçersiz UTF-16 çıktı) |
| `useUsdcBalance`'a ERC-20 `balanceOf` toplaması ekle | lint kuralı + bakiye bileşen testi (iki katı gösterir) |

- [ ] **Adım 7: Commit**

```bash
git commit -m "feat(shared): quantise USDC input to six decimals and make display rounding directional"
```

**Deliverable:** `Intl` ile kesme arasındaki ayrışma bir testte kayıtlı; `🚀`×9 formda reddedilirken `.length`'in 18 dediği ölçülü; `useBalance`'ı ikinci bir yerde import etmek lint'i kırıyor.

---

### Task 3: ABI dağıtımı ve revert sözlüğünün makinesi

Spec §4: `packages/shared` ABI'yi tek kaynaktan dağıtır ve `forge build` çıktısına karşı bir parity testi CI'da koşar. Bu görev o kaynağı kurar ve üstüne revert çözücüyü koyar. **Hata isimleri kontrattan okunur, spec'ten kopyalanmaz** — ve iki yönlü parity testi, kontrat arayüzü değişip arayüz güncellenmezse CI'yı kırar.

**Files:**
- Create: `packages/shared/src/abi/{launchFactory,bondingCurve,launchToken,feeEscrow,curveMath,index}.ts`
- Create: `packages/shared/test/abi-parity.test.ts`, `packages/shared/test/abi-selectors.test.ts`
- Create: `web/lib/decodeRevert.ts`, `web/lib/failureTable.ts`, `web/test/decodeRevert.test.ts`
- Modify: `packages/shared/package.json` (`test:abi` script), `.github/workflows/node.yml`

**Interfaces:**
- Üretir: `launchFactoryAbi` · `bondingCurveAbi` · `launchTokenAbi` · `feeEscrowAbi` · `curveMathErrorsAbi` · `ARCPAD_ERROR_ABI` · `type ArcpadAction` · `type ArcpadFailure` · `decodeArcpadError(error, ctx: { action: ArcpadAction }): ArcpadFailure` · `web/lib/failureTable.ts`'ten `FAILURE_TABLE` ve `UNREACHABLE_BY_CONSTRUCTION`
- Tüketir: yok.

> **İş bölümü, ki iki görev aynı dosyaya çakışmasın:** bu görev `failureTable.ts`'i **yapı** olarak kurar (anahtar biçimi `` `${action}:${errorName}` ``, `UNREACHABLE_BY_CONSTRUCTION` listesi ve her ulaşılabilir hata için tek satırlık geçici bir başlık). Task 14 aynı dosyaya **metni** ve `REACHABLE_BY_ACTION`'ı ekler. Tamlık kapısı bu görevde yazılır, iki boyutlu hücre kapısı Task 14'te.

- [ ] **Adım 1: ABI'leri `as const` olarak yaz**

Dört kontratın tam ABI'si + `CurveMath`'in **yalnızca hata girdileri**. `as const` zorunludur: viem'in tip çıkarımı ondan besleniyor, `Abi` olarak genişletilirse `useReadContract`'ın dönüş tipleri `unknown`'a düşer.

`bondingCurveAbi`'nin taşıması gereken üyeler (derlenmiş ABI'den, `methodIdentifiers` ile birlikte):

| Üye | Selector |
|---|---|
| `buyExactTokensOut(uint256,uint256)` payable | `0x35e35610` |
| `buyExactQuoteIn(uint256)` payable | `0x00ebfa4c` |
| `sellExactTokensIn(uint256,uint256)` nonpayable | `0x0cc2854a` |
| `virtualTokenReserves()` / `virtualQuoteReserves()` | `0x1655bc62` / `0xa0640c83` |
| `realTokenReserves()` / `realQuoteReserves()` | `0x5c25c6dd` / `0xc196c7c5` |
| `complete()` · `token()` · `creator()` · `poolSeedSupply()` | `0x522e1177` · `0xfc0c546a` · `0x02d05d3f` · `0x36c1386a` |
| `PROTOCOL_FEE_BPS()` / `CREATOR_FEE_BPS()` | `0xbe378228` / `0xcc3cbd2a` |
| `INITIAL_REAL_TOKEN_RESERVES()` / `INITIAL_VIRTUAL_*` | `0xad902a93` / `0xe0873234`, `0xc2e5f9f3` |

`launchFactoryAbi`: `launch(string,string,string)` `0x42a81515` · `isCanonical(address)` `0xb754bdfa` · `predictAddresses(address,string,string,string,uint256)` `0x6b500750` · `launchCount()` `0x27cca59f` · `escrow()` `0xe2fdcc17` · `protocolTreasury()` `0x803db96d` · `VIRTUAL_TOKEN_RESERVES()` `0x1b1158ab` · `VIRTUAL_QUOTE_RESERVES()` `0x1401cbca` · `SALE_SUPPLY()` `0xcbf6fff9` · `MIN_*` üçlüsü.

`launchTokenAbi`: OZ ERC-20 yüzeyi + `metadataURI()` `0x03ee438c` · `launchSalt()` `0xa64e41d3` · `curve()` `0x7165485d` · `creator()` `0x02d05d3f` · `TOTAL_SUPPLY()` `0x902d55a5`.

`feeEscrowAbi`: `deposit(address)` payable `0xf340fa01` · `claim(address)` `0x1e83409a` · `owed(address)` `0xdf18e047` · `totalOwed()` `0xe7fa9f7d`.

- [ ] **Adım 2: İki yönlü parity testi — ve eksik artifact ATLANMAZ**

```ts
// Beklenen kume ile derlenmis kume IKI YONLU karsilastirilir: eksik olan da
// hata, FAZLA olan da. Yalnizca "beklenenlerin hepsi duruyor mu" diye bakan
// bir test EKLENMIS bir fonksiyonu goremez ki butun mesele odur (Faz 1c
// Task 4'un ayni gerekcesi).
//
// stateMutability ve outputs DA karsilastirilir. Faz 1c'nin incelemesi olctu:
// `claim(address) external` -> `external payable` mutasyonu 245/245 yesil
// kaliyordu; isim kumesi bunu GORMEZ.
const ARTIFACTS = {
  LaunchFactory: 'contracts/out/LaunchFactory.sol/LaunchFactory.json',
  BondingCurve: 'contracts/out/BondingCurve.sol/BondingCurve.json',
  LaunchToken: 'contracts/out/LaunchToken.sol/LaunchToken.json',
  FeeEscrow: 'contracts/out/FeeEscrow.sol/FeeEscrow.json',
  CurveMath: 'contracts/out/CurveMath.sol/CurveMath.json',
}

// ARTIFACT YOKSA TEST BASARISIZ OLUR, ATLANMAZ. Atlanan bir kontrol gecen
// bir kontrol gibi gorunur; bu deponun standardi bir testin kimsenin
// yazmadigi bir sebeple gecmemesidir.
it.each(Object.entries(ARTIFACTS))('%s ABI si derlenmis cikti ile birebir', (name, path) => {
  if (!existsSync(path)) {
    throw new Error(`${path} yok. Once: forge build --root contracts`)
  }
  const compiled = normalise(JSON.parse(readFileSync(path, 'utf8')).abi)
  expect(normalise(HAND_WRITTEN[name])).toEqual(compiled)
})
```

`normalise`, girdileri `(type, name, inputs.map(type))` üçlüsüne göre sıralar ve `internalType`/`indexed` dışındaki alanları korur — `indexed` **korunur**, çünkü Faz 1c'nin incelemesi `Trade.trader`'dan `indexed`'i kaldıran tek kelimelik bir mutasyonun 245/245 yeşil kaldığını ölçtü ve o mutasyon her indexer filtresini sessizce boşaltıyor.

`packages/shared/package.json`'a `"test:abi": "vitest run test/abi-parity.test.ts"` eklenir ve **`test` script'ine dâhil edilmez** — `pnpm -r test` foundry'siz makinelerde de koşmalı. Bunun bedeli, testin hiç koşmaması riskidir; onu şu kapatır:

```ts
// SEÇİM BOŞLUĞU KAPISI: bu dosyanin bir yerde KOSTURULDUGUNU iddia et.
it('abi-parity testi bir CI isinde kosuyor', () => {
  const wf = readFileSync('.github/workflows/node.yml', 'utf8')
  expect(wf).toMatch(/test:abi/)
})
```

`node.yml`'a yeni bir iş: `abi-parity` — checkout (submodules) → foundry-toolchain `v1.6.0-rc1` → `forge build --root contracts` → node/pnpm → `pnpm --filter @arcpad/shared test:abi`.

- [ ] **Adım 3: Selector çakışması — aynı selector iki farklı anlam taşıyor**

```ts
// OLCULDU: CurveMath.ZeroAmount() ile FeeEscrow.ZeroAmount() AYNI SELECTOR'u
// tasir (0x1f2a2005), cunku selector yalnizca imzadan hesaplanir. Yani
// SELECTOR TEK BASINA KATMANI SOYLEMEZ. Faz 1c bunu curve icinde
// ZeroTokensOut/ZeroQuoteIn/ZeroTokensIn'e bolerek cozdu, ama kutuphane ile
// escrow arasindaki cakisma DURUYOR ve cozucunun bunu bilmesi gerekir.
it('cakisan selectorlar ENUMERE edilmis, kesfedilmemis', () => {
  const bySelector = groupBySelector(ARCPAD_ERROR_ABI)
  const collisions = [...bySelector].filter(([, names]) => new Set(names).size > 1)
  expect(collisions).toEqual([])                       // ayni selector, FARKLI isim: yok
  expect(bySelector.get(toFunctionSelector('ZeroAmount()'))).toEqual(['ZeroAmount']) // ayni isim: tek giris
})
```

`toFunctionSelector` viem'in kendi export'udur (hata selector'ları fonksiyon selector'larıyla **aynı** şekilde hesaplanır: imzanın keccak'ının ilk dört baytı); ayrı bir yardımcı yazılmaz. `groupBySelector` ve bir sonraki adımın `normalise`'ı aynı test dosyasındaki yerel yardımcılardır.

Sonuç: `ARCPAD_ERROR_ABI` selector'a göre tekilleştirilir ve **katman ataması çözücünün bağlamından gelir**, selector'dan değil. Bu, bir sonraki adımın iki boyutlu olmasının sebebidir.

- [ ] **Adım 4: Çözücü — anahtar (eylem, hata), yalnızca hata değil**

```ts
export type ArcpadAction =
  | 'launch' | 'approve' | 'buyExactQuoteIn' | 'buyExactTokensOut' | 'sellExactTokensIn' | 'claim'

export type ArcpadFailure = {
  kind: 'contract' | 'library' | 'token' | 'wallet' | 'network' | 'operator' | 'unknown'
  action: ArcpadAction
  name: string                 // 'CurveComplete', 'NetTooSmall', 'UserRejected', ...
  args?: readonly unknown[]    // ERC20InsufficientAllowance parametreleri gibi
  title: string                // kullaniciya gorunen bir satir
  detail: string               // ne olduğu
  remedy?: string              // ne yapabilecegi
  retryable: boolean
  raw: unknown                 // hic kaybedilmez; teshis icin
}

export function decodeArcpadError(error: unknown, ctx: { action: ArcpadAction }): ArcpadFailure
```

Çözme sırası **bağlayıcıdır** ve her adımın bir gerekçesi var:

1. **Cüzdan reddi** en başta: `UserRejectedRequestError` veya EIP-1193 `code === 4001`. Bir hata değildir, bir karardır — kırmızı bir kutu göstermek kullanıcıya yaptığı şeyin yanlış olduğunu söyler.
2. **`ContractFunctionRevertedError`** → `error.data` varsa `decodeErrorResult({ abi: ARCPAD_ERROR_ABI, data })`. Custom error yolu.
3. **Dize revert** (`reason` alanı): Arc'ın istemci seviyesindeki reddi `"Zero address not allowed"` gibi **string** döner, custom selector değil. Ayrıca çalışma zamanı blocklist reddi de buradan gelir. Bu dal olmadan Arc'a özgü iki reddin ikisi de "bilinmeyen hata" olur.
4. **Boş revert verisi** (`data === '0x'` veya yok): `payable` olmayan `launch`'a değer göndermek, CREATE2 çakışması ve out-of-gas hepsi burada. Mesaj bunu **tahmin etmez**, "işlem zincirde reddedildi, sebep bildirilmedi" der ve tx hash'i verir.
5. **Fon yetersizliği** (`InsufficientFundsError`): Arc'ta gas **işlemin kendi varlığıyla** ödendiği için mesaj iki kalemi ayrı yazar (Task 12, Adım 4'ün gas payı hesabı buraya bağlanır).
6. **Ağ/taşıma** (`HttpRequestError`, `TimeoutError`, hız sınırı): `retryable: true`.
7. **Bilinmeyen**: `kind: 'unknown'`, ham hata korunur ve arayüz "kopyala" düğmesi gösterir. Bu dal **boş kalmamalıdır** — sessizce yutmak, bilinmeyen bir selector'ı hiç görmemekle aynı şeydir.

`kind: 'operator'` sınıfı, kullanıcının yapabileceği hiçbir şey olmayan yapılandırma hatalarını toplar (`EscrowHasNoCode`, `DegenerateProfile`, `TokenBalanceBelowSaleAndSeed`, `NotBound`, `NotFactory`, `AlreadyBound`, `ZeroToken`, `SaleAndSeed*`, `GraduationRaiseTooSmall`, `Zero{Escrow,Treasury}Address`). Mesajı dürüsttür: "bu launch yanlış yapılandırılmış; işlem yapılamaz" + adres. Bunları "bilinmeyen"e bırakmak, ulaşılamaz sandığımız bir yolun gerçekten ulaşıldığı günü sessiz geçirmek olurdu.

- [ ] **Adım 5: Çözücünün tamlık kapısı**

```ts
// ABI'DEN TURETILEN TAMLIK: her hata girdisi ya sozlukte ya da ACIKCA
// "ulasilamaz" listesindedir. Kontrata yeni bir hata eklendiginde bu test
// kirilir -- yani sozluk ABI'nin arkasinda kalamaz.
it('ARCPAD_ERROR_ABI nin her hatasi siniflandirilmis', () => {
  const classified = new Set([...Object.keys(FAILURE_TABLE), ...UNREACHABLE_BY_CONSTRUCTION])
  for (const e of ARCPAD_ERROR_ABI) expect(classified, `${e.name} siniflandirilmamis`).toContain(e.name)
})
```

`UNREACHABLE_BY_CONSTRUCTION` bir **yorum değil bir liste**dir ve her üyesinin yanında tek satırlık gerekçesi durur (`TokenTransferFailed` → OZ ERC-20 `false` dönmez, revert eder; `ZeroCreator` → `launch` `msg.sender`'ı geçirir; `InsufficientTokenReserve` → `tokensOut > realTokenReserves` koruması önce döner; …). Task 14 bu listeyi kullanıcı metnine bağlar.

- [ ] **Adım 6: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `bondingCurveAbi`'den `buyExactQuoteIn`'i sil | parity (iki yönlü) |
| `Trade.trader`'dan `indexed: true`'yu kaldır | parity (`indexed` korunuyor) |
| `claim(address)`'i `payable` yap | parity (`stateMutability`) |
| `ARCPAD_ERROR_ABI`'den `NetTooSmall`'ı çıkar | tamlık kapısı + Task 14'ün küçük-alım testi |
| Çözücüde cüzdan-reddi dalını 2. sıraya al | "reddetme kırmızı kutu göstermez" testi |
| Dize-revert dalını sil | `"Zero address not allowed"` testi |
| `test:abi`'yi `node.yml`'dan çıkar | seçim boşluğu kapısı |

- [ ] **Adım 7: Commit**

```bash
git commit -m "feat(shared): distribute the ABI from one source and decode library-layer reverts too"
```

**Deliverable:** `abi-parity` CI işi yeşil ve `LaunchToken`'a bir fonksiyon eklendiğinde **kırıldığı ölçüldü**; `ZeroAmount()` selector çakışması enumere edilmiş; çözücünün tamlık kapısı ABI'nin her hatasını kapsıyor.

---

### Task 4: Kota motoru — `CurveMath`'in TS portu ve üç giriş noktasının planlayıcısı

`BondingCurve`'ün view kota fonksiyonu **yok** (S1). Dolayısıyla arayüz aritmetiği kendisi yapmak zorundadır ve **yuvarlama yönü yanlış olursa kullanıcı gördüğünden farklı bir işlem imzalar**: fazla ödemek, ya da hiç gerçekleşmeyecek bir işlemi imzalamak. Bu görev portu yazar; Task 5 onu gerçek bytecode'a karşı çalıştırır. İkisi ayrı görevdir çünkü **aritmetiğin doğru görünmesi ile doğru olması aynı şey değildir** ve bu depoda her ciddi kusur çalıştırmayla bulundu.

**Files:**
- Create: `packages/shared/src/curve.ts`, `packages/shared/src/trade.ts`
- Create: `packages/shared/test/curve.test.ts`, `packages/shared/test/trade.test.ts`, `packages/shared/test/trade-types.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Üretir (`curve.ts`): `feeOn(amount, feeBps)` · `quoteBuyCost(tokensOut, quoteReserve, tokenReserve)` · `quoteBuyTokensOut(net, quoteReserve, tokenReserve)` · `quoteSellProceeds(tokensIn, quoteReserve, tokenReserve)` · `netQuoteInBeforeCorrection(gross, totalFeeBps)` · `correctedNetQuoteIn(gross, protocolBps, creatorBps): {net, protocolFee, creatorFee}` · `marketCap(quoteReserve, tokenReserve, supplyConstant)` · `graduationRaise(saleSupply, quoteReserve, tokenReserve)` · `poolSeedSupply(saleSupply, tokenReserve)` · `priceWeiPerToken(quoteReserve, tokenReserve)` · `progressPpm(realTokenReserves, saleSupply): number` · `class CurveMathError` — **hepsi `bigint` alır ve `bigint` döner**, `number` yalnızca `progressPpm`'in dönüşünde.
- Üretir (`trade.ts`): `type WeiUsdc` · `type TokAmount` · `TRADE_ACTIONS` · `interface CurveProfile` · `interface CurveState` · `interface TradePlan` · ve üç planlayıcı, **hepsi aynı imza şeklinde**:
  - `planBuyExactQuoteIn(state: CurveState, profile: CurveProfile, grossValue: bigint, slipBps: number): TradePlan`
  - `planBuyExactTokensOut(state: CurveState, profile: CurveProfile, tokensOut: bigint, slipBps: number): TradePlan`
  - `planSellExactTokensIn(state: CurveState, profile: CurveProfile, tokensIn: bigint, slipBps: number): TradePlan`
- Tüketir: Task 2'nin biçimlendiricileri (yalnızca `trade.ts`'in gösterim alanlarında); Task 1'in `CurveProfile` şekli (`web/lib/profile.ts` aynı üç alanı döndürür).

- [ ] **Adım 1: `curve.ts` — birebir port, aynı yuvarlama, aynı revert'ler**

```ts
const BPS = 10_000n
const UINT256_MAX = 2n ** 256n - 1n

export class CurveMathError extends Error {
  constructor(readonly errorName: 'ZeroAmount' | 'ZeroReserve' | 'InsufficientTokenReserve' | 'InvalidBps' | 'NetTooSmall') {
    super(errorName)
  }
}

/**
 * FullMath.mulDiv'in TS karsiligi. bigint arbitrary precision oldugu icin
 * ARA CARPIM TASMAZ -- ama ZINCIRDE TASAR: FullMath.mulDiv sonuc uint256'ya
 * sigmazsa revert eder. Bu yuzden sinir ACIKCA kontrol edilir; aksi halde
 * TS "olur" derken zincir revert eder ve bu, kullanicinin imzaladigi ile
 * olanin ayrildigi en sessiz yoldur.
 */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  const q = (a * b) / d
  if (q > UINT256_MAX) throw new CurveMathError('InvalidBps') // zincirdeki panic'in karsiligi
  return q
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** floor(...) + 1. mulDivRoundingUp DEGIL: tam bolunen durumda bir birim fazla alir. */
export function quoteBuyCost(tokensOut: bigint, quoteReserve: bigint, tokenReserve: bigint): bigint {
  if (tokensOut === 0n) throw new CurveMathError('ZeroAmount')
  if (quoteReserve === 0n) throw new CurveMathError('ZeroReserve')
  if (tokensOut >= tokenReserve) throw new CurveMathError('InsufficientTokenReserve')
  return mulDiv(tokensOut, quoteReserve, tokenReserve - tokensOut) + 1n
}

/** Ucret amount'in USTUNE eklenir (EXCLUSIVE sozlesme) ve TAVANA yuvarlanir. */
export function feeOn(amount: bigint, feeBps: bigint): bigint {
  if (feeBps > BPS) throw new CurveMathError('InvalidBps')
  return ceilDiv(amount * feeBps, BPS)
}

/** 1-3. adim. IKI UCRET PARCASI DA DONER ve cagiran onlari YENIDEN HESAPLAMAZ. */
export function correctedNetQuoteIn(gross: bigint, protocolBps: bigint, creatorBps: bigint):
  { net: bigint; protocolFee: bigint; creatorFee: bigint }
```

**Portun dört kuralı, hepsi kontrattan:**

1. `quoteBuyCost` = `floor(...) + 1`, `quoteBuyTokensOut` içinde `-1` **curve teriminin içinde** (`net - 1` payda ve payda), `quoteSellProceeds` **tabana**, `feeOn` **tavana**. Dördü de protokol lehinedir.
2. `correctedNetQuoteIn` ücretleri **düzeltme öncesi** net üzerinden alır ve döndürür. Dönen net üzerinden yeniden hesaplamak (95,30) bps'te girdilerin %1,23'ünde 1 birim eksik tahsil eder — ve eksik alan taraf creator olur.
3. `net + protocolFee + creatorFee <= gross`, **eşitlik evrensel değil**: düzeltme tetiklenmediğinde toplam 1 birim eksik kalabilir. `== gross` diye kurulmuş hiçbir iddia yazılmaz.
4. `NetTooSmall`'ın **iki atış yeri** var ve ikisi de ulaşılabilir: `correctedNetQuoteIn` içinde (`overshoot >= net`) ve `quoteBuyTokensOut` içinde (`net <= 1`).

Sabitlenmiş vektörler — **elle türetildi, fonksiyonu çağırarak değil.** İlk üç satır pump.fun'ın kendi ölçeğindedir (`V = 4_292_000_000`, `T = 1_073_000_000_000_000`) ve bilerek: `contracts/test/CurveMath.t.sol`'ün aynı literalleriyle **karşılaştırılabilir** olmaları, portun yukarı akıştan da sapmadığını gösterir.

```ts
expect(netQuoteInBeforeCorrection(10_125n, 125n)).toBe(10_000n)               // girdiden 1 CIKARILMAZ
expect(correctedNetQuoteIn(1_000_013n, 95n, 30n))
  .toEqual({ net: 987_666n, protocolFee: 9_383n, creatorFee: 2_964n })        // tasma tam 1
expect(quoteBuyTokensOut(987_666n, 4_292_000_000n, 1_073_000_000_000_000n)).toBe(246_859_443_282n)
expect(() => correctedNetQuoteIn(2n, 95n, 30n)).toThrow('NetTooSmall')        // 3. adimdan
expect(() => quoteBuyTokensOut(1n, V_TESTNET, T)).toThrow('NetTooSmall')      // 4. adimdan
```

arcpad'in **kendi testnet ölçeğinde** sabitlenen vektör (elle türetildi; `V = 4_292e15`, `T = 1_073_000_000e18`, `S = 793_100_000e18`):

```ts
// 1,000000 USDC butceli buyExactQuoteIn, TAZE curve:
//   net       = floor(1e18 * 10_000 / 10_125) =   987_654_320_987_654_320
//   protocolFee = ceil(net * 95/1e4)          =     9_382_716_049_382_717
//   creatorFee  = ceil(net * 30/1e4)          =     2_962_962_962_962_963
//   toplam                                    = 1_000_000_000_000_000_000  -> TAM ESIT, iade 0
//   tokensOut = floor((net-1)*T/(V+net-1))    = 200_723_953_120_761_740_526_324_105
it('bir USDC lik alim testnet curve inde ceyregi alir', () => {
  const r = correctedNetQuoteIn(10n ** 18n, 95n, 30n)
  expect(r).toEqual({ net: 987_654_320_987_654_320n, protocolFee: 9_382_716_049_382_717n, creatorFee: 2_962_962_962_962_963n })
  expect(r.net + r.protocolFee + r.creatorFee).toBe(10n ** 18n)
  expect(quoteBuyTokensOut(r.net, V_TESTNET, T)).toBe(200_723_953_120_761_740_526_324_105n)
})
```

> `9_382_716_049_382_717` sayısı bağımsız bir doğrulamadır: Faz 1c'nin `LaunchFactory` incelemesi tam bu değeri ölçtü (`escrow.owed(TREASURY)` bir 1 USDC'lik alımdan sonra). İki farklı yoldan aynı literal.

`progressPpm` **Faz 3'ün tanımıyla birebir aynı** olmak zorundadır, aksi halde token kartı ile token sayfası farklı yüzde gösterir: `1_000_000 - ceil(realTokenReserves * 1_000_000 / S)`. Kalan **yukarı** yuvarlanır, yani bir wei token kaldığında değer `999_999`'dur, `1_000_000` değil. Sabitlenen dört kenar: `S` → `0`; `S/2` → `500_000`; `1` → `999_999`; `0` → `1_000_000`. Beşinci vektör yukarıdaki alımdan: kalan `592_376_046_879_238_259_473_675_895` → **`253_087`**.

- [ ] **Adım 2: `trade.ts` — üç giriş noktası, ve asimetri tipte görünür**

```ts
export type WeiUsdc = bigint & { readonly __view: 'nativeUsdcWei' }
export type TokAmount = bigint & { readonly __view: 'launchTokenBase' }

export const TRADE_ACTIONS = ['buyExactQuoteIn', 'buyExactTokensOut', 'sellExactTokensIn'] as const

export interface CurveProfile { virtualTokenReserves: bigint; virtualQuoteReserves: bigint; saleSupply: bigint }
export interface CurveState {
  virtualTokenReserves: bigint; virtualQuoteReserves: bigint
  realTokenReserves: TokAmount; realQuoteReserves: WeiUsdc
  complete: boolean; creator: Address
}

/** Bir alim/satim planinin TAMAMI: calldata argumanlari + ekranda gosterilecek dokum. */
export interface TradePlan {
  action: (typeof TRADE_ACTIONS)[number]
  /** Bu ikisi calldata'ya AYNEN gider; ekranda gosterilen dokum de bunlardan turer. */
  args: readonly [bigint] | readonly [bigint, bigint]
  value: WeiUsdc                 // msg.value; satista 0n
  curveAmount: WeiUsdc           // ucret HARIC curve tutari
  protocolFee: WeiUsdc
  creatorFee: WeiUsdc            // creator === 0x0 ise 0n, ve protokol payina KATLANMAZ
  tokens: TokAmount
  /** Ucret sinirinin hangi tarafi: alimda DAHIL, satista HARIC. Etiketi bu belirler. */
  boundKind: 'maxSpendIncludingFees' | 'minReceiveAfterFees'
  clamped: boolean               // yalnizca buyExactQuoteIn'de true olabilir
  refund: WeiUsdc                // value - (curveAmount + fees); <=1 wei olabilir, kismada buyuk
  priceAfterWeiPerToken: bigint
  progressPpmAfter: number
}
```

Üç planlayıcı ve haritalama:

| Kullanıcı eylemi | Giriş noktası | Koruma argümanı | Sınırda davranış |
|---|---|---|---|
| "X USDC harca" (**varsayılan**) | `buyExactQuoteIn(minTokensOut)`, `value = X` | `minTokensOut = floor(tokens * (10_000 - slipBps) / 10_000)` | rezerve **kısar**, artanı iade eder |
| "Y token al" | `buyExactTokensOut(tokensOut, maxQuoteIn)`, `value = maxQuoteIn` | `maxQuoteIn = ceil(total * (10_000 + slipBps) / 10_000)`, **ücret dâhil** | `NotEnoughTokensToBuy()` ile **revert** |
| "Y token sat" | `sellExactTokensIn(tokensIn, minQuoteOut)`, `value = 0` | `minQuoteOut = floor(netOut * (10_000 - slipBps) / 10_000)`, **ücret hariç net** | — |

**Varsayılan `buyExactQuoteIn`'dir** ve gerekçesi tek cümle: bayat bir kotadan dolayı curve'ün tepesinde başarısız **olamayan** tek giriş noktasıdır.

`value = maxQuoteIn` seçimi bilinçlidir: kontrat `total > msg.value` ise de `SlippageExceeded()` verir, yani `msg.value`'yu tavanın altında göndermek tavanı anlamsız kılar. İkisini eşitlemek, tek koruma noktası bırakır ve artan zaten iade edilir.

- [ ] **Adım 3: Tip kapısı — `_wei` ile `_tok` toplanamaz**

```ts
// Faz 3'un sonek sozlesmesi bir yorum degil bir TIP olmali: ikisi de 1e18
// olcekli oldugu icin toplanmalari DERLENIR ve bir kategori hatasi sessizce
// gecer. Vitest'in expectTypeOf'u bunu calistirilabilir kilar.
it('WeiUsdc ile TokAmount birbirine atanamaz', () => {
  expectTypeOf<WeiUsdc>().not.toEqualTypeOf<TokAmount>()
  expectTypeOf<TradePlan['tokens']>().toEqualTypeOf<TokAmount>()
  expectTypeOf<TradePlan['value']>().toEqualTypeOf<WeiUsdc>()
})
```

- [ ] **Adım 4: Sabitlenmiş plan vektörleri**

Hepsi taze testnet curve'ünde, `slipBps = 0`, `creator != 0`:

| Plan | Sonuç |
|---|---|
| `planBuyExactQuoteIn(1e18)` | `curveAmount 987_654_320_987_654_320` · `protocolFee 9_382_716_049_382_717` · `creatorFee 2_962_962_962_962_963` · `tokens 200_723_953_120_761_740_526_324_105` · `refund 0` · `clamped false` |
| `planBuyExactTokensOut(1e24)` (1.000.000 token) | `curveAmount 4_003_731_343_283_583` · `protocolFee 38_035_447_761_195` · `creatorFee 12_011_194_029_851` · `value = total = 4_053_777_985_074_629` |
| `planBuyExactQuoteIn(20e18)` | **`clamped true`** · `tokens = S` · `curveAmount 12_161_433_369_060_378_707` (= `R + 1`) · `protocolFee 115_533_617_006_073_598` · `creatorFee 36_484_300_107_181_137` · `refund 7_686_548_713_826_366_558` · toplam harcanan `12_313_451_286_173_633_442` |
| `planSellExactTokensIn(200_723_953_120_761_740_526_324_105)` (yukarıdaki alımdan sonra) | `curveAmount 987_654_320_987_654_319` · `protocolFee 9_382_716_049_382_717` · `creatorFee 2_962_962_962_962_963` · **net `975_308_641_975_308_639`** |

Son satır arayüzün en önemli dürüstlük vektörüdür: 1,000000 USDC ile alıp hemen geri satan kullanıcı **0,975308 USDC** alır — gidiş-dönüş kaybı `24_691_358_024_691_361` wei, yani **%2,4691**. İki bacaklı ücret gerçeği ekranda bu şekilde görünmek zorundadır (Task 12, Adım 3).

Ayrıca `clamped` vektörü curve'ü **tamamlar** (`tokens == S`): planlayıcı `progressPpmAfter === 1_000_000` ve "bu işlem curve'ü tamamlar" bayrağını döndürür.

- [ ] **Adım 5: Sıfır-creator dalı**

`creator === zeroAddress` olan bir `CurveState` için `creatorFee` **her üç planda da** `0n` olmalı ve protokol payı **değişmemeli**. Faz 1c'nin ölçtüğü şey burada tekrarlanıyor: `buyExactQuoteIn` × `creator == 0` hücresi kontratta **hiç yürünmemiş** bir hücreydi ve ternary'yi düşürmek giriş noktasını sonsuza dek kırıyordu. Portta karşılığı: `creatorBps`'i koşullamayı unutmak, `correctedNetQuoteIn`'in dönüşünü kaydırır ve **tüm kota yanlış olur**. Üç ayrı test, üç giriş noktası — biri diğerini kapsamaz.

- [ ] **Adım 6: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `quoteBuyCost`'tan `+ 1`'i kaldır | pump.fun ölçekli vektör + `clamped` vektörünün `R + 1`'i |
| `quoteBuyTokensOut`'ta `-1`'i girdiye taşı (SDK tahmin edicisi) | `246_859_443_282` vektörü |
| `feeOn`'u `mulDiv` (taban) yap | üç ücret vektörü |
| Ücreti `feeOn(x, 125)` ile tek seferde hesapla | 1 USDC vektörünün `net + fees == 1e18` eşitliği |
| `correctedNetQuoteIn`'in 3. adımını sil | `gross = 2` revert testi |
| Dönen net üzerinden ücreti yeniden hesapla | `1_000_013` vektörü (`creatorFee 2_964` → `2_963`) |
| `maxQuoteIn`'i ücret **hariç** hesapla | `planBuyExactTokensOut` `value == total` iddiası + Task 5'in sıfır-slipaj çalıştırması |
| `minQuoteOut`'u ücret **dâhil** (proceeds) hesapla | satış vektörünün `net` iddiası |
| `progressPpm`'de `ceil` → `floor` | "bir wei kaldı → 999_999" kenarı |
| `creatorBps` koşulunu düşür | üç sıfır-creator testinin **her biri** |

- [ ] **Adım 7: Commit**

```bash
git commit -m "feat(shared): port the curve arithmetic with the chain's rounding and plan all three entrypoints"
```

**Deliverable:** 20+ sabitlenmiş vektör yeşil; `progressPpm` Faz 3'ün view'iyle aynı dört kenarı veriyor; tip kapısı `_wei`/`_tok` karışımını reddediyor.

---

### Task 5: Kota motorunun gerçek bytecode'a karşı diferansiyel testi

Task 4'ün vektörleri **aritmetiği** doğrular. Bu görev **anlaşmayı** doğrular: motorun ürettiği calldata, derlenmiş `BondingCurve` tarafından gerçekten çalıştırıldığında beklenen sonucu veriyor mu? Bu deponun her ciddi kusuru çalıştırmayla bulundu; frontend'de karşılığı budur.

**Neden anvil meşru, ve neyi kapsamıyor.** Kota yolu Arc'a özgü **hiçbir** davranışa dokunmaz: native-coin precompile'ı, EIP-7708 logu, blocklist ve sıfır-adres yasağı bu yolda yer almaz; `msg.value` her iki zincirde de 18 decimal'dir. Dolayısıyla aritmetik ve giriş noktası anlaşması anvil'de **tam olarak** ölçülebilir. Anvil'de ölçülemeyen şey `0x3600…0000`'daki ERC-20 görünümüdür — orada o kontrat **yoktur**, yani iki-görünüm gösterimi burada test **edilemez** ve bir UI'ın iki bakiyeyi toplaması bu testte **yanlış görünmez**. O boşluk Task 15'in Arc ayağına aittir ve orada adıyla kapatılır. Bu paragraf, "fixture'ın örtük şekli yüzünden geçen test" sınıfının bu görevdeki adıdır.

**Files:**
- Create: `packages/shared/src/devchain.ts` (harness), `packages/shared/test/chain/curve-differential.test.ts`
- Modify: `packages/shared/package.json` (`test:chain` script + `./devchain` alt-yol export'u), `.github/workflows/node.yml`, `eslint.config.js`

**Interfaces:**
- Tüketir: Task 3'ün ABI'leri, Task 4'ün `curve.ts`/`trade.ts` yüzeyi, Task 2'nin `parseUsdcAmount`'ı.
- Üretir: `startAnvil(): Promise<{ rpcUrl: string; stop(): Promise<void> }>` · `deployArcpad(rpcUrl, profile: CurveProfile): Promise<{ factory: Address; escrow: Address; token: Address; curve: Address }>` · `deployZeroCreatorCurve(rpcUrl, profile): Promise<{ token: Address; curve: Address }>`.

> **Neden `src/` içinde, `test/` içinde değil:** Task 15 aynı iki yardımcıya ihtiyaç duyuyor ve başka bir paketin `test/` dizinine göreli import etmek kırılgan bir bağ olurdu. `@arcpad/shared/devchain` alt-yolu bunu açık bir sözleşmeye çevirir. Bedeli, uygulama kodunun onu import edebilmesidir; onu bir eslint kuralı kapatır: `web/app/**` ve `web/components/**` içinden `@arcpad/shared/devchain` import etmek **hata** (`anvil` alt süreci ve deploy yolları tarayıcı paketine girmemeli).

- [ ] **Adım 1: Harness — derlenmiş artifact'lardan gerçek deploy**

`anvil --port 0 --silent` alt süreç olarak açılır (port stdout'tan okunur), viem `walletClient`/`publicClient` ona bağlanır. Deploy sırası **kontratın kendi zorunluluğu**:

1. `FeeEscrow` — bytecode `contracts/out/FeeEscrow.sol/FeeEscrow.json` `.bytecode.object`'ten.
2. `LaunchFactory(escrow, treasury, T, V_testnet, S)` — **argüman sırası `T` ÖNCE, `V` SONRA**. Faz 1c'nin Task 3'ü bunu "derlenen ama yanlış olan bir hata" olarak kaydetti; testin kendisi de aynı tuzağa düşebilir, bu yüzden deploy'dan sonra `factory.VIRTUAL_QUOTE_RESERVES() === V_TESTNET` iddia edilir.
3. `factory.launch('Diff', 'DIFF', 'ipfs://diff')` → `Launched` olayı `parseEventLogs` ile ayrıştırılır, `curve` ve `token` oradan alınır. **Dönüş değerlerinden alınmaz** — bir işlem makbuzu dönüş değeri taşımaz ve bu, Task 13'ün de uyması gereken kuraldır.
4. `factory.isCanonical(token) === true` iddia edilir. Fixture'ın gerçekten factory'nin ürettiği bir launch olduğunun kanıtı; olmadığında testin ölçtüğü şey belirsizleşir.

Sıfır-creator dalı için ikinci bir fixture: curve **EOA'dan doğrudan** deploy edilir (`creator = 0x0`), `LaunchToken` o curve'ü işaret ederek deploy edilir (arzın tamamını curve'e basar), sonra `curve.bind(token)` **aynı EOA'dan** çağrılır — `bind`'in `msg.sender != factory` koruması sağlanır çünkü o EOA curve'ü deploy edendir. Bu, factory'nin asla üretemeyeceği (her zaman `msg.sender`'ı creator yapar) bir durumu ölçülebilir kılar.

- [ ] **Adım 2: Diferansiyel döngü**

Tohumlanmış (deterministik) bir üreteçle üç giriş noktası üzerinde ≥ 300 vaka. Her vakada:

- Motor `plan*` çağrılır → `args`, `value`.
- Zincirde aynı çağrı yapılır; makbuzdan `Trade` olayı ayrıştırılır.
- Karşılaştırılan alanlar: `quoteAmount == plan.curveAmount`, `protocolFee`, `creatorFee`, `tokenAmount == plan.tokens`, ve **dört rezerv alanı**.
- Ayrıca ölçülür: işlemcinin native bakiye deltası `== value - refund - gasCost` (iade yolunu doğrular), `escrow.owed(treasury)` artışı `== protocolFee`, `escrow.owed(creator)` artışı `== creatorFee`.
- `slipBps = 0` ile **hiçbir plan revert etmemelidir**. Bu, ücret-dâhil/hariç asimetrisinin tek gerçek testidir: `maxQuoteIn` ücret hariç hesaplanmış olsaydı `total > maxQuoteIn` olur ve `SlippageExceeded()` gelirdi.

- [ ] **Adım 3: Kapsam sayaçları — sıfır bir sayaç testi BAŞARISIZ yapar**

Faz 1c'nin invariant incelemesi ölçtü: bir dizi, sayaçları sıfır bırakarak yeşil geçebilir ve o zaman test hiçbir şeyi kısıtlamaz. Bu yüzden bu testin sonunda **her sayaç > 0 iddia edilir** ve başarısızlık mesajı tüm sayaçları basar:

| Sayaç | Neden gerekli |
|---|---|
| `clampedFills` | `buyExactQuoteIn`'in kısma dalı — pump.fun'da yok, arcpad'e özgü |
| `exactOutAtBoundary` | `tokensOut == realTokenReserves` tam sınırı (geçmeli) |
| `exactOutBeyondBoundary` | `realTokenReserves + 1` → `NotEnoughTokensToBuy` (revert etmeli) |
| `completions` | curve'ün `complete` olduğu vaka; sonrasında **üç** giriş noktasının da `CurveComplete()` verdiği ölçülür |
| `refundsNonZero` / `refundsZero` | iade yolunun iki tarafı |
| `zeroCreatorTrades` | `creatorFee == 0` ve protokol payı değişmemiş |
| `netTooSmallReverts` | `gross ∈ {1,2,3}` — **iki farklı atış yeri** ayrı ayrı |
| `proceedsTooSmallReverts` | satışta `proceeds <= fees` |
| `slippageReverts` | üç giriş noktasının **her birinde** ayrı sayaç |

`netTooSmallReverts` vektörleri ölçüldü ve sabitlenir: `gross = 1` → 4. adımdan, `gross = 2` → 3. adımdan, `gross = 3` → 4. adımdan, `gross = 4` → **geçer** ve `249_999_999` token verir. `proceedsTooSmall` sınırı da ölçüldü: 1 USDC'lik alım sonrası durumda son reddedilen `tokensIn` **`495_643_839`**, ilk kabul edilen **`495_643_840`**.

- [ ] **Adım 4: Kuantalamanın yapısal iddiası**

```ts
// Task 2'nin 6-ondalik kuantalamasi iki revert sinifini ERISILEMEZ kiliyor.
// Bu, bir yorum degil bir olcumdur -- ve kuantalama ileride gevsetilirse
// KIRILIR, ki amac tam olarak budur.
it('arayuzun uretebilecegi en kucuk girdi NetTooSmall vermez', async () => {
  const min = parseUsdcAmount('0.000001')            // 1e12 wei
  expect(min.ok && min.value).toBe(10n ** 12n)
  const plan = planBuyExactQuoteIn(freshState, profile, min.value, 0)
  await expect(execute(plan)).resolves.toMatchObject({ status: 'success' })
  expect(plan.tokens).toBe(246_913_523_427_951_928_356n)   // elle turetildi
})
```

- [ ] **Adım 5: Giriş noktası matrisi ABI'DEN türetilir**

```ts
// "Bir yolda kapatilan ozellik hepsinde kapatilmis gorunur" -- Faz 1c'de dokuz
// ornek, altisi onceki bir ornegi kapatmak icin yazilmis kodda. Frontend'deki
// karsiligi: bir islem yolunu kapsayan test hepsini kapsiyor gorunur.
// Cozum matrisi ELLE saymamak: giris noktasi kumesini ABI'DEN cikar ve
// matrisin onunla TAM ESIT oldugunu iddia et.
it('TRADE_ACTIONS derlenmis ABI nin islem giris noktalarina TAM ESIT', () => {
  const fromAbi = bondingCurveAbi
    .filter((e) => e.type === 'function' && e.stateMutability !== 'view' && !['bind'].includes(e.name))
    .map((e) => e.name)
    .sort()
  expect([...TRADE_ACTIONS].sort()).toEqual(fromAbi)
})

it('her giris noktasi icin her senaryo hucresi yurunmus', () => {
  for (const action of TRADE_ACTIONS) {
    for (const cell of ['happy', 'slippage', 'complete', 'zeroCreator']) {
      expect(walked[action][cell], `${action} x ${cell} yurunmedi`).toBeGreaterThan(0)
    }
  }
})
```

`bind` dışlanması **açık bir istisnadır ve gerekçesi yanında durur**: kullanıcı yolu değil, factory'nin iç adımıdır. Yeni bir işlem giriş noktası eklendiğinde bu test kırılır — istenen davranış tam olarak bu.

- [ ] **Adım 6: CI işi ve orphan koruması**

`node.yml`'a `chain-differential` işi: submodule'lü checkout → foundry `v1.6.0-rc1` → `forge build --root contracts` → pnpm → `pnpm --filter @arcpad/shared test:chain`. `anvil` foundry ile birlikte gelir, ek kurulum yok.

Task 3'ün "bu dosya bir CI işinde koşuyor" kapısı `test:chain`'i de kapsayacak şekilde genişletilir. Ayrıca: `test:chain` dosyaları varsayılan `vitest` `include` desenine **girmemelidir** (anvil'siz makinede kırmızı olurdu) ve bunun testi, `vitest.config.ts`'in `include`'unu okuyup `test/chain/**`'in dışarıda olduğunu iddia eder — iki yönlü: ne varsayılanda koşar, ne de hiçbir yerde koşmaz.

- [ ] **Adım 7: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `maxQuoteIn`'i ücret hariç yap | sıfır-slipaj döngüsü (`SlippageExceeded`) |
| `minQuoteOut`'u `proceeds` yap | satış vakalarının `minQuoteOut` iddiası |
| `planBuyExactQuoteIn`'i `buyExactTokensOut`'a haritala | `clampedFills` sayacı sıfırlanır → kapsam iddiası |
| Kısma dalında ücretleri yeniden hesaplamayı kaldır | `clamped` vakalarının ücret karşılaştırması |
| `TRADE_ACTIONS`'tan `sellExactTokensIn`'i çıkar | ABI-türetilmiş eşitlik testi |
| Sayaç iddialarını kaldır | (kontrol mutantı) — diğer mutantların bir kısmı **hayatta kalmalı**, bu da sayaçların taşıyıcı olduğunu gösterir |

Son satır bilinçli bir kontroldür: sayaç iddiaları olmadan hangi mutantların hayatta kaldığı **raporlanır**. "Sayaçlar işe yarıyor" cümlesi ancak böyle ölçülmüş olur.

- [ ] **Adım 8: Commit**

```bash
git commit -m "test(shared): validate the quote engine by executing the compiled curve, not by re-deriving it"
```

**Deliverable:** ≥300 vaka, üç giriş noktası, dokuz kapsam sayacının hepsi > 0; sıfır slipajla hiçbir plan revert etmiyor; `NetTooSmall`'ın iki atış yeri ayrı ayrı yürünmüş; matris ABI'den türetiliyor.

---

### Task 6: Tasarım sistemi, tipografi ve kabuk

Bu ürün duyurulacak; "şablondan çıkmış" görünmemesi bir gereksinimdir. Yön **pons/pump.fun'ın bilgi hiyerarşisidir** (projenin seçtiği referans) ve nerede ondan ayrıldığımızın **ölçülmüş** bir sebebi var. Mevcut `globals.css` tokenları §7.3'ten birebir alınmış; bu görev onları **değiştirmez, tamamlar**.

**Files:**
- Modify: `web/app/globals.css`, `web/app/layout.tsx`, `web/app/providers.tsx`
- Create: `web/components/ui/{Button,Input,Pill,Card,Tabs,Skeleton,Dialog,Toast,VisuallyHidden,Address,Money}.tsx`
- Create: `web/components/layout/{Header,Footer,WalletButton,NetworkBanner,TokenArtwork,SearchTrigger}.tsx`
- Create: `web/public/fonts/*.woff2`, `web/lib/fonts.ts`
- Create: `web/test/contrast.test.ts`, `web/test/ui/*.test.tsx`
- Modify: `web/vitest.config.ts`, `web/package.json`

**Interfaces:**
- Tüketir: Task 1'in `useArcNetwork()`'ü, Task 2'nin `useUsdcBalance()` ve biçimlendiricileri, `BRAND`.
- Üretir: `<Money native rounding="down"|"up" />` (her para hücresi bundan geçer ve `tabular-nums`'ı o taşır) · `<Address value shorten copy explorer />` · `<Dialog>` (odak tuzağı + Esc, Task 9 ve Task 12 onu kullanır) · `<SearchTrigger>` (butonu ve ⌘K dinleyicisi **burada**; Task 9 yalnızca `<SearchDialog>`'u ve açık/kapalı durumunu sağlar) · `<NetworkBanner>` · `<TokenArtwork address uri size>`.

- [ ] **Adım 1: Ölçülmüş kontrast, ve birincil butonun deviasyonu**

WCAG 2.2 göreli parlaklıkla hesaplandı (sRGB, 2,4 gama):

| Ön / arka | Oran | Karar |
|---|---|---|
| `#FAFAFA` / `#0B0B0B` | **18,9:1** | gövde metni ✓ |
| `#8A8A8A` / `#0B0B0B` | **5,70:1** | ikincil metin ✓ (AA normal) |
| `#8A8A8A` / `#141414` | **5,34:1** | kart içi ikincil ✓ |
| `#8A8A8A` / `#1C1C1C` | **4,94:1** | girdi içi yardımcı metin ✓ (sınırda) |
| `#C6F24E` / `#0B0B0B` | **15,2:1** | vurgu metni, odak halkası ✓ |
| `#FFFFFF` / `#7E8F2E` | **3,59:1** | ✗ **AA normal metin başarısız** |
| `#0B0B0B` / `#7E8F2E` | **5,49:1** | ✓ **birincil buton bu olur** |
| `#FF5A5A` / `#0B0B0B` | **6,4:1** | satış/negatif ✓ |
| `rgba(255,255,255,.08)` / `#0B0B0B` | 1,25:1 | yalnızca ince çizgi; **odak halkası olarak KULLANILAMAZ** |

**Deviasyon 1 (S10):** ekran görüntülerindeki birincil CTA zeytin zemin üzerine beyaz metin. Aynı zeminde koyu metin 3,59 → **5,49:1** yapar. arcpad'in birincil butonu `#7E8F2E` zemin + `#0B0B0B` metindir; hover'da zemin `#C6F24E`'ye çıkar (metin aynı kalır, 15,2:1). Değişen tek şey metin rengidir; palet §7.3'ün paletidir.

`web/test/contrast.test.ts` bunu **çalıştırılabilir** kılar: `globals.css`'i okur, token çiftlerini bir tabloya göre çözer ve her çiftin eşiğini iddia eder (`normal ≥ 4.5`, `large ≥ 3`, `nonText ≥ 3`). Bir token kararırsa test kırılır — kontrast bir yorumda değil bir kapıda durur.

- [ ] **Adım 2: Tipografi — §7.3'ün "serif wordmark + geometrik sans" tarifi (S14)**

`next/font/local` ile **kendi sunucumuzdan**: gövde için geometrik sans (Space Grotesk, OFL 1.1), wordmark için serif (Instrument Serif, OFL 1.1). Harici font hostu yok — üçüncü taraf isteği yok, CSP daralabilir, ve fontun gelmediği ağlarda ürün yine kendisi gibi görünür. `display: 'swap'`, `adjustFontFallback` ile metrik uyumu (CLS).

**Sayılar `tabular-nums`.** Para ve token miktarları oransal rakamlarla çizildiğinde tablo kolonları satır satır kayar; ekran görüntülerinde bu görünüyor. `--font-numeric: 'Space Grotesk', ui-monospace` yerine `font-variant-numeric: tabular-nums` bir yardımcı sınıfla verilir ve **her para hücresinde zorunludur** (bileşen testi bunu `Address`/`Money` bileşenlerinde iddia eder).

- [ ] **Adım 3: Token genişletmesi**

`@theme` bloğuna eklenenler — mevcut yedi token **aynen kalır**: `--color-surface-2: #1c1c1c` (girdi ve iç yüzey) · `--color-negative: #ff5a5a` · `--color-positive: var(--color-accent)` · `--radius-pill: 999px` · `--ring: 2px` · `--ring-offset: 2px`. Ayrıca `:root { color-scheme: dark }` — tarayıcının kendi form kontrolleri ve kaydırma çubukları aksi hâlde açık temada çizilir ve koyu bir sayfada beyaz bir `<select>` tam olarak "şablon" izlenimi verir.

`prefers-reduced-motion: reduce` altında **tüm** geçişler ve grafik animasyonları kapanır. Bu bir tercih değil bir erişilebilirlik gereğidir; testi bir bileşen testidir (`matchMedia` sahtelenir, `transition-duration: 0s` iddia edilir).

- [ ] **Adım 4: Kabuk**

`Header`: wordmark (serif, `BRAND.wordmark`) · `Explore` linki · arama tetikleyici (⌘K göstergeli **buton** — yalnızca klavye kısayolu keşfedilebilir değildir) · `+ Create` · `WalletButton`.

`WalletButton` üç durum: bağlı değil (`Connect wallet`, connector listesi bir `Dialog`'da; EIP-6963 ile keşfedilen cüzdanlar `useConnectors`'tan) · bağlı (kısaltılmış adres + 6 ondalıklı USDC bakiyesi, **tek satır**) · yanlış ağ (`NetworkBanner` + buton `Switch to Arc Testnet`).

**Bakiye tek satırdır ve bu bir tasarım kararı değil K1'dir.** Menüde tek cümlelik açıklama: *"USDC is Arc's gas asset. Your wallet may show 18 decimals; this is the same balance."*

`Footer`: `BRAND.tagline` · Explore / Create linkleri · risk notu (*"Transactions are submitted through your wallet and are irreversible. Tokens can be volatile or lose all value. arcpad does not custody assets."*) · **testnet uyarısı**: "Arc Testnet. Tokens here have no monetary value." Bu satır isteğe bağlı değil: ürün kamuya açık bir testnet'te duruyor ve Circle'ın faucet'inden gelen USDC gerçek para değil.

`Header`ın üstünde `<a href="#main" class="skip-link">`; `main` landmark; `Dialog` `role="dialog" aria-modal="true"` + odak tuzağı + Esc.

- [ ] **Adım 5: `TokenArtwork` — `next/image` KULLANILMAZ, ve gerekçesi**

Üç sebep, üçü de somut: (a) `pnpm-workspace.yaml` `sharp: false` diyor ve Faz 0 bunu "Faz 4'te tekrar bak" diye kaydetti — Next'in optimize ediciyi çalıştırması için sharp gerekir; (b) rastgele IPFS görsellerini **kendi origin'imizden** geçirmek bir kötüye kullanım yolu açar (ölçeklenmesi bize maliyet, içeriği bize itibar); (c) kart ızgarası 1:1 sabit kutudur, yani optimize edicinin çözdüğü sorun (bilinmeyen oran) bizde yok.

Bunun yerine: sabit oranlı kutu + `<img loading="lazy" decoding="async" referrerPolicy="no-referrer">`, izinli gateway listesi (`ipfs://` → yapılandırılmış tek gateway), ve **her zaman** deterministik bir yedek — token adresinden türetilen iki renkli CSS gradyanı. Yedek bir "kırık görsel" değildir; hiç görseli olmayan launch **yaygın durumdur**. `sharp: false` kararı `pnpm-workspace.yaml`'da gerekçesi güncellenerek kalır.

- [ ] **Adım 6: Vitest'i bileşenler için hazırla**

`web/vitest.config.ts` iki projeye ayrılır: `unit` (node ortamı, `test/**/*.test.ts`) ve `component` (jsdom, `test/**/*.test.tsx`, `@vitejs/plugin-react`). Eklenen geliştirme bağımlılıkları: `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`. `wagmi/connectors`'ın `mock()` connector'ı bileşen testlerinde cüzdanı sahteler — ayrı bir sahte katman yazılmaz.

- [ ] **Adım 7: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| Birincil butonun metnini `#FAFAFA` yap | `contrast.test.ts` |
| `--color-muted`'ı `#6A6A6A` yap | `contrast.test.ts` (4,5 altına düşer) |
| `tabular-nums` sınıfını `Money`'den kaldır | `Money` bileşen testi |
| `Dialog`'dan odak tuzağını kaldır | odak testi (Tab modalı terk eder) |
| `color-scheme: dark`'ı sil | `globals.css` iddiası |
| `skip-link`'i kaldır | kabuk erişilebilirlik testi |

- [ ] **Adım 8: Commit**

```bash
git commit -m "feat(web): fix the primary button's contrast and put the palette behind an executable gate"
```

**Deliverable:** kontrast kapısı dokuz çifti ölçüyor ve birincil butonun eski hâli **kırmızı**; iki font kendi sunucumuzdan; kabuk klavyeyle tam gezilebilir.

---

### Task 7: Okuma katmanı — `@arcpad/db` sözleşmesi, düşüşe dayanıklılık ve kanoniklik

**Files:**
- Create: `web/lib/db.ts`, `web/lib/read.ts`, `web/lib/canonical.ts`, `web/lib/metadata.ts`
- Create: `web/test/fixtures/readModel.ts`, `web/test/read.test.ts`, `web/test/canonical.test.ts`, `web/test/metadata.test.ts`
- Modify: `packages/db/src/queries.ts` (Faz 3'ün paketine iki ekleme), `packages/db/migrations/008_search.sql` (yeni), `.env.example`

**Interfaces:**
- Tüketir: Faz 3'ün `@arcpad/db`'sinden `SORTS`, `listTokens`, `getTokenOverview`, `listTrades`, `listHolders` ve **tipleri**: `TokenOverview`, `TradeRow`, `HolderRow`. Bu üç tip adı bu plan boyunca **bu isimlerle** kullanılır; Faz 3 başka bir isim verirse bu görev onları yeniden export ederek tek bir yerde eşler.
- Üretir: `type ReadResult<T>` · `guard<T>(fn: () => Promise<T>): Promise<ReadResult<T>>` (istisnayı `{ ok: false, reason: 'unavailable' }`'a çevirir ve loglar; `undefined`/boş sonucu `'notFound'`a) · `readTokenList` · `readTokenOverview` · `readTrades` · `readHolders` · `readSearch` · `verifyCanonical(token): Promise<'canonical' | 'forged' | 'unverifiable'>` · `resolveMetadata(uri): Promise<ResolvedMetadata | null>` ve `type ResolvedMetadata = { description?: string; image?: string; x?: string; telegram?: string }` · `searchTokens` ve cursor'lu `listHolders` (`packages/db`'ye eklenir).

- [ ] **Adım 1: Bağlantı ve tipli sarmalayıcılar**

`web/lib/db.ts`: `import 'server-only'` + tek bir `pg.Pool` (Next'in modül önbelleği süreç başına tekil tutar). `DATABASE_URL` yoksa **modül yüklenirken** değil **ilk sorguda** hata verir; aksi halde veritabanı olmayan bir ortamda **al-sat paneli de** çöker, ki o veritabanına hiç ihtiyaç duymaz.

`web/lib/read.ts` Faz 3'ün sorgularını sarar ve hepsi aynı sonucu döner:

```ts
export type ReadResult<T> = { ok: true; data: T } | { ok: false; reason: 'unavailable' | 'notFound' }

export const readTokenList = (p: ListParams) => guard(() => listTokens(getPool(), p))
export const readTokenOverview = (token: Address) => guard(() => getTokenOverview(getPool(), token))
export const readTrades = (token: Address, p: PageParams) => guard(() => listTrades(getPool(), token, p))
export const readHolders = (token: Address, p: PageParams) => guard(() => listHolders(getPool(), token, p))
export const readSearch = (p: SearchParams) => guard(() => searchTokens(getPool(), p))
```

`guard` bir istisnayı `{ ok: false, reason: 'unavailable' }`'a çevirir ve **loglar**. Gerekçe: veritabanı düştüğünde token sayfası **500 vermez**, eksik veriyle çizilir ve al-sat paneli çalışmaya devam eder — çünkü o rezervleri zincirden okur. Bu Task 12, Adım 1'de test edilen bir özelliktir.

- [ ] **Adım 2: Faz 3'ün paketine iki ekleme (kendi üstlendiğimiz iki bağımlılık)**

**(a) `searchTokens`** — Faz 3'ün `queries.ts`'inde arama yok; ⌘K onu gerektiriyor ve 159 bin satırda istemci tarafı filtreleme kabul edilemez.

```sql
-- pg_trgm; migration 008. Sıralama ifadesi PARAMETREDEN BIRLESTIRILMEZ:
-- relevance sabit bir ifadedir, yalnizca $1 baglanir (Faz 3'un SORTS kurali).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX launches_name_trgm  ON launches USING gin (lower(name) gin_trgm_ops);
CREATE INDEX launches_symbol_trgm ON launches USING gin (lower(symbol) gin_trgm_ops);
```

`SORTS`'a `relevance: 'similarity(lower(name), $q) DESC, created_seq DESC'` eklenir. **İkinci anahtar zorunludur**: `similarity` bağlanır ve bağlı satırlar keyset sayfalamada tekrarlar/atlar — Faz 3'ün timestamp gerekçesinin aynısı, başka bir kolonda. `relevance` yalnızca `q` boş değilken seçilebilir ve bunu bir test kapatır.

**(b) `listHolders`'a cursor** — bugün yalnızca `{limit}` alıyor. Anahtar `(balance_tok DESC, holder ASC)`; `balance_tok` **tekil değildir**, ikinci anahtar olmadan sayfalama satır tekrarlar. Curve adresi listeden **hariç** tutulur (arzın tamamı orada durur ve "en büyük holder curve" bilgi taşımaz) ve bu bir test olarak yazılır.

**(c) `candles` YOK ve bu bir bağımlılık olarak adlandırılıyor.** Faz 3 OHLCV'yi açıkça Faz 4'e devretti. Task 10 grafiği `listTrades`'ten üretir ve kovayı **`event_seq`/blok** ekseninde tanımlar. Gerekçe Faz 3'ün ölçümüdür: 400 ardışık blok çiftinin 197'si aynı timestamp'i taşıyor, yani "1 dakikalık kova" tanımı timestamp'e oturtulduğunda kovaların yarısı keyfi olur.

- [ ] **Adım 3: Fixture'lar SABİTLENMİŞ satırlardır, hesaplanmış değil**

`web/test/fixtures/readModel.ts` `TokenOverview` satırlarını **literal** olarak taşır. Hesaplanmış bir fixture, bileşenin kullandığı aritmetiğin aynısını kullanır ve o aritmetikteki bir hata **testi de kaydırır** — "assertion doğru ve onu doğru yapan şey örtük" sınıfının ta kendisi. Sabitlenen satır Task 4'ün vektörüdür:

```ts
export const TOKEN_AFTER_ONE_USDC_BUY: TokenOverview = {
  token: '0x…', curve: '0x…', name: 'Diff', symbol: 'DIFF', uri: 'ipfs://diff',
  virtual_quote_reserves_wei: '5279654320987654320',
  virtual_token_reserves_tok: '872276046879238259473675895',
  real_token_reserves_tok:    '592376046879238259473675895',
  real_quote_reserves_wei:    '987654320987654320',
  market_cap_wei:             '6052733351875009052',   // elle turetildi: mulDiv(Vq, 1e27, Vt)
  price_wei_per_token:        '6052733351',            // elle turetildi: mulDiv(Vq, 1e18, Vt)
  progress_ppm:               253087,                  // 1e6 - ceil(kalan*1e6/S)
  graduation_raise_wei:       '12161433369060378706',
  complete: false, holder_count: 1, trade_count: 1, buy_count: 1, /* … */
}
```

Ve fixture'ın kendisi pinlenir: `it('fixture in market cap i elle turetilen degerdir')` — literal, `marketCap()` çağrısı değil.

- [ ] **Adım 4: Kanoniklik — nerede kontrol edilir ve neye mal olur**

**Listeleme yolunda kontrol GEREKMEZ, ve bu yapısal bir gerçektir:** `Launched` olayı yalnızca `LaunchFactory`'nin kendisi tarafından yayılabilir, indexer de yalnızca o adresin loglarını okur ve Faz 3'ün Task 6'sı kabulde kanonikliği ayrıca doğrular. Yani veritabanındaki her satır kanoniktir.

**Yapıştırılan adres yolunda kontrol ZORUNLUDUR.** Kullanıcının `/token/0x…` ile geldiği ve veritabanında satır olmayan durumda tek ayırt edici `isCanonical`'dır:

```ts
// MALIYET: bir eth_call. Gas odenmez, ama DUGUM gas HARCAR ve dogrulanan
// token DUSMANDIR (alanlarini kendisi dondurur): megabaytlik bir name()
// cagriyi keyfi olarak pahalilastirir. Faz 1c olctu: dogrudan cagride
// 3.000.000 butcenin 2.958.151'i, try/catch ile saran bir cagirici icinde
// 8.000.000'un 7.757.318'i tukeniyor. try/catch KONTROLU geri verir, GAZI
// vermez. Bu yuzden IKISI birden gerekir: try/catch VE acik gaz tavani.
export async function verifyCanonical(token: Address): Promise<'canonical' | 'forged' | 'unverifiable'> {
  try {
    const ok = await client.readContract({
      address: ADDRESSES.launchFactory, abi: launchFactoryAbi,
      functionName: 'isCanonical', args: [token],
      gas: 2_000_000n,          // ACIK TAVAN. Yalnizca try/catch yetmez.
    })
    return ok ? 'canonical' : 'forged'
  } catch {
    // launchSalt() selector'u OLMAYAN bir kontrat icin cagri REVERT EDER,
    // false donmez -- fail-closed. Revert "kanonik degil" olarak okunur,
    // ama gaz tukenmesinden ayirt edilemedigi icin 'unverifiable' denir ve
    // arayuz onu ASLA bir launch gibi cizmez.
    return 'unverifiable'
  }
}
```

**Kural, istisnasız: `canonical` olmayan hiçbir adres bir launch gibi render edilmez.** `forged` ve `unverifiable` aynı ekrana gider: "This address is not an arcpad launch." Sebep Faz 1c'nin ölçtüğü şeydir — sahteci gerçek bir launch'ın creator'ını, curve'ünü, metadata'sını, salt'ını ve hatta gerçekleşen işlem fiyatını **birebir** taklit edebilir; ayıran tek şey adresin kendi verisinden yeniden türetilmesidir.

- [ ] **Adım 5: Metadata çözücü — `uri` SALDIRGAN KONTROLÜNDEDİR**

Açıklama, görsel ve sosyal linkler zincirde değil, `uri`'nin gösterdiği JSON'un içindedir (Task 13, Adım 1). Onu **sunucudan** çekmek gerekir ve `uri` **launch eden kişinin yazdığı serbest bir dizedir** — yani bu bir SSRF yüzeyidir. `web/lib/metadata.ts`:

```ts
// KISITLAR, hepsi zorunlu:
//  1. Yalnizca `ipfs://<cid>[/path]` ve yapilandirilmis gateway'in kendi
//     origin'i kabul edilir. Baska her sey (http://, file://, data:,
//     bir IP adresi, baska bir host) COZULMEZ -- fetch HIC yapilmaz.
//     Gerekce: uri'yi launch eden yazar; serbest bir sunucu-tarafi fetch,
//     ic aglara istek atma yetkisi demektir.
//  2. 2000 ms zaman asimi (AbortSignal.timeout) ve 64 kB govde tavani.
//     Tavan akis okunurken uygulanir, Content-Length'e GUVENILMEZ.
//  3. JSON semasi dogrulanir; bilinmeyen alanlar ATILIR. `image` yalnizca
//     ayni izin listesinden gecerse dondurulur.
//  4. Metin alanlari sanitiseForDisplay'den gecer ve kirpilir
//     (description <= 256 karakter, ekranda daha da kisalir).
//  5. Next `fetch` onbellegi: revalidate 300 sn. Explore sayfasi 24 kart
//     cizer; onbelleksiz bu 24 gateway istegi demek olurdu.
//  6. HER basarisizlik NORMAL bir sonuctur: { ok: false }. Cozulemeyen
//     metadata bir hata degil, YAYGIN durumdur (uri bos olabilir).
export async function resolveMetadata(uri: string): Promise<ResolvedMetadata | null>
```

Testler: `http://169.254.169.254/latest/meta-data` → fetch **hiç yapılmaz** (fetch sahtelenir, çağrı sayısı `0` iddia edilir); `data:application/json,{}` → aynı; 100 kB gövde → tavanda kesilir ve `null`; 3 sn geciken yanıt → `null`; `image` başka bir hosttaysa **düşürülür** ama `description` korunur; `<script>` içeren bir açıklama sanitize edilir.

**Çapraz plan bağımlılığı, adıyla:** Faz 3 metadata'yı **çözmüyor ve saklamıyor** (`launches.uri` ham dizedir). Bugün doğru yer burasıdır — istek başına, önbellekli. Kalıcı yer indexer'dır: `launches.image_url` + `launches.description` kolonları çözülmüş ve doğrulanmış hâlde saklanırsa Explore hiç gateway'e çıkmaz. Faz 5'e devir listesine yazılıyor; bu görev onu **varsaymıyor**.

- [ ] **Adım 6: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `guard`'ı kaldır (istisna yukarı sızsın) | veritabanı-düştü testi (sayfa 500 verir) |
| `resolveMetadata`'nın izin listesini kaldır | SSRF testi (fetch çağrı sayısı 0 olmalı) |
| Gövde tavanını `Content-Length`'e bağla | 100 kB gövde testi (başlık yalan söyler) |
| `revalidate`'i kaldır | Explore'da gateway istek sayısı testi |
| `verifyCanonical`'ın `gas` tavanını kaldır | gaz tavanı iddiası (sahte düşman token fixture'ı) |
| `catch` dalını `return 'canonical'` yap | `launchSalt`'ı olmayan kontrat testi |
| `unverifiable`'ı launch gibi çiz | "sahte token launch gibi render edilmez" testi |
| `listHolders`'ın ikinci sıralama anahtarını sil | eşit bakiyeli iki holder ile sayfalama testi (satır tekrarı) |
| `relevance`'ı `q` boşken de kabul et | arama parametre testi |

- [ ] **Adım 7: Commit**

```bash
git commit -m "feat(web): read through @arcpad/db, degrade when it is down, and never render an unverified token as a launch"
```

**Deliverable:** veritabanı kapalıyken token sayfası çiziliyor ve al-sat paneli çalışıyor; `searchTokens` ve `listHolders` cursor'u eklenmiş; `verifyCanonical` hem `try/catch` hem gaz tavanı kullanıyor ve bunu bir test ölçüyor.

---

### Task 8: Explore — `/`

Bilgi hiyerarşisi pons'un düzenidir: üstte bitmiş olanlar, altta tırmananlar, aralarında filtre şeridi, kartlar 1:1 görsel + isim + `$TICKER` + market cap + ilerleme.

**Files:**
- Modify: `web/app/page.tsx`
- Create: `web/app/loading.tsx`, `web/app/error.tsx`
- Create: `web/components/explore/{TokenCard,TokenGrid,FilterBar,KeysetPager,CompleteSection,EmptyState}.tsx`
- Create: `web/test/explore/*.test.tsx`

**Interfaces:**
- Tüketir: Task 7'nin `readTokenList` + `TokenOverview`'u ve `resolveMetadata`'sı (kart görselinin URL'si oradan gelir; çözülemezse `<TokenArtwork>` deterministik gradyanına düşer), Task 6'nın `<Money>`/`<TokenArtwork>`/`<Card>`'ı, Task 2'nin `formatUsdcCompact`/`sanitiseForDisplay`'i, Faz 3'ün `SORTS` anahtarları.
- Üretir: `type ExploreSearchParams = { sort?: string; age?: string; after?: string }` · `parseExploreParams(raw): { sort: keyof typeof SORTS; ageDays: number | null; cursor: string | null }` (beyaz liste; tanınmayan değer varsayılana düşer) · `<TokenCard overview>` · `<KeysetPager cursors nextCursor total>` — Task 9 ve Task 11 aynı `KeysetPager`'ı kullanır.

- [ ] **Adım 1: Sıralama ve yaş filtreleri URL'de**

`?sort=recentBuys|newest|oldest|marketCap|volume` + `?age=all|1|7` + `?after=<seq>`. Değerler `SORTS`'un anahtarlarıyla **sınırlıdır**; tanınmayan bir değer sessizce varsayılana düşer (`recentBuys`) ve bu bir testtir — URL'den gelen bir dize hiçbir zaman bir SQL ifadesine dönüşmez.

Sayfa bir **server component**; `searchParams`'ı okur, `readTokenList` çağırır, `TokenGrid`'i çizer. Filtre şeridi `<Link>`'lerden oluşur (JS'siz çalışır ve klavyeyle gezilir).

- [ ] **Adım 2: Keyset sayfalama — numaralı sayfalar YOK (deviasyon 2)**

pons numaralı sayfalar gösteriyor (`1 2 … 3137`). arcpad **Prev / Next + toplam sayı** gösterir. Gerekçe Faz 3'ün kararının doğrudan sonucudur: sıralama `last_buy_seq` gibi bir keyset anahtarı üzerindedir ve `OFFSET` tabanlı numaralı sayfalar, iki sorgu arasında yeni bir alım geldiğinde **satır tekrarlar veya atlar**. Numaralı bir sayfa listesi, veremeyeceğimiz bir kesinlik vaat eder. `KeysetPager` `after` cursor'unu ve geri gitmek için bir cursor yığınını URL'de taşır.

- [ ] **Adım 3: Kart**

Metrikler **üç**: market cap (`formatUsdcCompact`), graduation ilerlemesi (`progress_ppm / 10_000` → `%25,3`), yaş (`created_at`, **yalnızca gösterim**). Alt kenarda ilerleme çizgisi.

**Deviasyon 3:** pons kartta çıplak bir yüzde gösteriyor. arcpad'de graduation **tanımlı bir bitiş çizgisidir** (testnet'te `12.161433` USDC toplanır), bu yüzden yüzdenin altında neyin yüzdesi olduğu yazar: `25.3% to graduation`. Çıplak bir yüzde, neyin yüzdesi olduğunu saklar.

`is_dev`, `holder_count`, `volume_24h_wei` karta **konmaz** — kart yoğunluğu bir kaynaktır ve beş metrik hiçbirinin okunmaması demektir.

- [ ] **Adım 4: Üst bölüm veriye bağlıdır (S6)**

Ekran görüntüsündeki "Graduated" bölümü arcpad'de **"Curve complete"**tir ve `complete == true` olan tokenları listeler. Sebep: `graduated` bayrağı ve havuz Faz 2'dedir; bugün bir curve tükendiğinde olan şey **tamamlanmadır**, mezuniyet değil. Bölüm başlığının altında tek satır: *"Sale supply sold out. Pool creation lands with Phase 2."* Faz 2 geldiğinde bölüm ikiye ayrılır (`complete && !graduated` → "Graduating", `graduated` → "Graduated") ve bu ayrım bugünden `CompleteSection`'ın props'unda **isimlendirilir**, ki o gün bir yeniden yazım olmasın.

Bugün beklenen durum: **bölüm boş**. Bu bir hata değil ürünün ilk günüdür ve boş durumun kendisi bir bileşen testidir.

- [ ] **Adım 5: Boş / yükleniyor / hata — üçü de birinci sınıf**

- **Yükleniyor** (`loading.tsx`): kart ızgarasıyla **aynı geometride** iskelet. Farklı geometri = içerik gelince zıplama.
- **Hiç launch yok**: "No launches yet." + `Create` çağrısı. `159,123 launched` sayacı `0` iken gösterilmez.
- **Filtre sonuç vermedi**: filtreden ayırt edilir ("No launches in the last 24 hours" + filtreyi temizleme linki). İkisini aynı metne bağlamak kullanıcıya ürünün boş olduğunu söyler, oysa filtresi boştur.
- **Veritabanı düştü** (`ok: false, reason: 'unavailable'`): ızgara yerine açıklayıcı bir kutu + `Create` ve arama yine çalışır. `error.tsx` yalnızca beklenmeyen istisnalar için.

- [ ] **Adım 6: Duyarlılık ve erişilebilirlik**

Izgara: 1 kolon (< 480px) → 2 (≥ 480) → 3 (≥ 768) → 4 (≥ 1024) → 5 (≥ 1280, ekran görüntüsündeki yoğunluk). Kart tamamı tek bir `<a>`; içinde ikinci bir etkileşimli öğe yok (iç içe tıklanabilir öğe klavye ve ekran okuyucu için kırıktır). Kart erişilebilir adı: `"{name} ({symbol}), market cap {…}, {…}% to graduation"` — görsel yalnızca dekoratif (`alt=""`).

- [ ] **Adım 7: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `sort` parametresini doğrudan SQL'e geçir | parametre beyaz-liste testi |
| `progress_ppm`'i `/ 1_000` ile böl | `%25,3` iddiası |
| Boş-filtre metnini boş-ürün metniyle birleştir | iki ayrı boş durum testi |
| `loading.tsx`'i tek satırlık "Loading…" yap | iskelet geometri testi |
| Karta ikinci bir `<button>` koy | iç içe etkileşim erişilebilirlik testi |
| `unavailable` durumunda `throw` et | veritabanı-düştü testi |

- [ ] **Adım 8: Commit**

```bash
git commit -m "feat(web): explore with keyset paging and three honest empty states"
```

**Deliverable:** beş sıralama × üç yaş filtresi URL'den çalışıyor; dört boş/hata durumu ayrı ayrı test edilmiş; ızgara beş kırılma noktasında ölçülmüş.

---

### Task 9: ⌘K arama

**Files:**
- Create: `web/components/search/{SearchDialog,SearchResultRow}.tsx`, `web/app/api/search/route.ts`
- Create: `web/test/search/*.test.tsx`

**Interfaces:**
- Tüketir: Task 6'nın `<SearchTrigger>`'ı ve `<Dialog>`'u (tetikleyici ve ⌘K dinleyicisi orada, bu görev yalnızca içeriği sağlar), Task 7'nin `readSearch` + `verifyCanonical`'ı, Task 8'in `KeysetPager`'ı.
- Üretir: `GET /api/search?q=&sort=&age=&after=` → `{ rows: TokenOverview[]; nextCursor: string | null; total: number }` veya `{ error: 'unavailable' }` · `<SearchDialog open onClose>`.

- [ ] **Adım 1: Yol**

Modal bir client component olduğu için sorgu bir **route handler** üzerinden gider: `GET /api/search?q=&sort=&age=&after=`. Bu, spec §6.3'ün "API route'ları yalnızca yazma için" kuralına bir **istisnadır ve gerekçesi yazılır**: ⌘K sonuçları tuş vuruşuyla gelir, bir server component navigasyonu değildir. Alternatif (server action) aynı ağ turunu POST olarak yapar ve önbelleklenemez. Route handler `readSearch`'i çağırır, `q`'yu **parametre olarak** bağlar, `sort`'u beyaz listeden çözer.

- [ ] **Adım 2: Adres yapıştırma yolu — kanonikliğin göründüğü yer**

`q` bir adresse arama yapılmaz:

1. Veritabanında satır varsa → doğrudan o sonuç.
2. Satır yoksa → `verifyCanonical(q)`:
   - `canonical` → "Not indexed yet" etiketiyle sonuç satırı; token sayfası zincirden çizilir.
   - `forged` / `unverifiable` → **sonuç değil**, açık bir ret: *"This address is not an arcpad launch."* Adres kısaltılmış gösterilir, isim/sembol **hiç okunmaz** — okunsa ekranda gerçek bir launch'ın adı görünürdü, ki sahtekârlığın işleyiş biçimi tam olarak budur.

- [ ] **Adım 3: Erişilebilirlik — listbox deseni, tam**

`role="dialog" aria-modal="true"` + odak tuzağı + Esc + açılışta odak input'a + kapanışta tetikleyiciye geri. Sonuç listesi `role="listbox"`, satırlar `role="option"`, `aria-selected`, input'ta `aria-activedescendant`; ↑/↓ seçim taşır, Enter gider, Home/End uçlara. Sonuç sayısı `aria-live="polite"` ile duyurulur (`24 results`). ⌘K **ve** Ctrl+K; tetikleyici ayrıca görünür bir butondur.

Girdi 250 ms debounce edilir ve **uçuş hâlindeki istek iptal edilir** (`AbortController`) — aksi halde geç dönen bir yanıt yeni sorgunun sonuçlarını ezer. Bu bir test: iki sorgu, ilki geç döner, ekranda **ikincinin** sonuçları kalır.

- [ ] **Adım 4: Sıralama ve boş durumlar**

Pill'ler: `Relevance | Market cap | Volume | Newest | Oldest` + yaş `All | 24h | 7d`. `Relevance` yalnızca `q` doluyken etkin; boş `q` ile `recentBuys`'a düşer. Boş durumlar: `q` boş → "Type to search" (ve son bakılanlar **gösterilmez**; yerel bir geçmiş tutmak bu fazın kapsamı değil) · sonuç yok → `q`'yu tırnak içinde tekrarlayan mesaj · veritabanı düştü → açık mesaj, modal yine kapanabilir.

- [ ] **Adım 5: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| Adres yolunu kaldır (adresi metin gibi ara) | yapıştırılan-adres testi |
| `forged` durumunda satırı normal çiz | "sahte adres launch gibi görünmez" testi |
| `AbortController`'ı kaldır | yarış testi (geç yanıt ekranı ezer) |
| `aria-activedescendant`'ı kaldır | klavye gezinme testi |
| Esc dinleyicisini kaldır | odak/kapanma testi |
| `q`'yu SQL'e string olarak gömme | parametre bağlama testi (`'; DROP` girdisi) |

- [ ] **Adım 6: Commit**

```bash
git commit -m "feat(web): command-K search, and refuse to render a pasted address as a launch"
```

**Deliverable:** klavyeyle tam gezilebilir modal; yapıştırılan sahte adres açık bir retle karşılanıyor; geç dönen yanıt yenisini ezmiyor.

---

### Task 10: Token sayfası — kimlik, istatistikler, ilerleme, kanoniklik ve eğri grafiği

**Files:**
- Create: `web/app/token/[address]/{page,loading,error,not-found}.tsx`
- Create: `web/components/token/{TokenHeader,AboutPanel,StatRow,ProgressToGraduation,CanonicalBadge,LaunchFacts,CurveChart,LifecycleNotice}.tsx`
- Create: `web/test/token/*.test.tsx`

**Interfaces:**
- Tüketir: Task 7'nin `readTokenOverview`/`verifyCanonical`/`resolveMetadata`'sı, Task 1'in `getCurveProfile()`'ı, Task 4'ün `priceWeiPerToken`/`progressPpm`/`marketCap`'i, Task 6'nın primitifleri, Task 2'nin biçimlendiricileri. **Task 11 ve Task 12 bu sayfayı sonradan değiştirir** (tablolar ve panel); bu görev onların yerine `<TableTabs>` ve `<TradePanel>` için birer bölüm bırakır ve o bölümler bu görevde **hiç render edilmez** — boş bir kutu değil, hiç olmayan bir kutu.
- `AboutPanel`: açıklama ve sosyal linkler `resolveMetadata`'dan gelir. Çözülemediğinde metin **"No description yet."**'tir (referans ekran görüntüsündeki boş durumun aynısı) ve bu bir hata olarak gösterilmez — `uri` boş bırakılabilir (Task 13, Adım 3) ve boş bırakmak yaygın olacaktır.
- Üretir: `type Lifecycle` (üç dal) · `resolveLifecycle(source): Lifecycle` · `<CurveChart trades profile state>` · `<ProgressToGraduation ppm raisedWei targetWei>` · `<CanonicalBadge status>` · `BLOCKS_PER_SECOND` (grafik aralık pill'lerinin tek kaynağı). Task 12'nin paneli `Lifecycle`'ı **tüketir**: `trading` dışındaki dallarda hiç render edilmez.

- [ ] **Adım 1: Çözümleme sırası ve sahte adres reddi**

```
/token/0xABC
  ├─ adres gecerli mi? (isAddress)            -> degilse notFound()
  ├─ readTokenOverview(lowercase(adres))
  │    ├─ ok           -> normal sayfa (satir KANONIK, Faz 3 kabulde dogruladi)
  │    └─ notFound     -> verifyCanonical(adres)
  │         ├─ canonical     -> zincirden cizilen sayfa, "Not indexed yet" seridi
  │         └─ forged/unverifiable -> "This address is not an arcpad launch."
  └─ unavailable       -> zincirden cizilen sayfa, "Live data unavailable" seridi
```

Üçüncü dal ayrı bir sayfa değildir, aynı sayfanın **veri kaynağı değişmiş** hâlidir: `TokenHeader`, `StatRow`, `ProgressToGraduation` ve al-sat paneli zincirden okunan `CurveState` + `CurveProfile` ile de çizilebilir. Yalnızca hacim, holder sayısı, ATH ve işlem listesi indexer'a bağlıdır ve onlar "—" gösterir.

**Sahte adres dalında isim ve sembol hiç okunmaz.** Okunsaydı ekranda gerçek bir launch'ın adı görünürdü; sahtekârlığın işleyiş biçimi tam olarak budur.

- [ ] **Adım 2: Düzen — üçüncü kolon boş bırakılmaz (deviasyon)**

Ekran görüntüsündeki üç kolon: al-sat · grafik · **chat**. Chat Faz 6'dadır, yani üçüncü kolon bu fazda boş kalırdı. Boş bir kolon, olmayan bir kolondan kötüdür. Yerine **`LaunchFacts`** kartı gelir — sayfanın en çok sorulan sorularını taşır ve hepsi zincirden okunur:

| Satır | Kaynak |
|---|---|
| Launched by | `launch_creator`, kısaltılmış + ArcScan linki |
| Fee recipient | `fee_creator`; `launch_creator`'dan **farklıysa** ayrı satır, aynıysa gizli |
| Curve | curve adresi + ArcScan |
| Token | token adresi + ArcScan + kopyala |
| Provenance | `CanonicalBadge` |
| Total supply | `1,000,000,000` |
| On the curve | `793,100,000` (%79,31) |
| Reserved for the pool | `206,886,011.18` (%20,69) |
| Trading fee | `0.95%` protocol + `0.30%` creator, "charged on the curve amount" |
| Graduation | `graduation_raise_wei` → `12.161433 USDC` |

`launch_creator` ile `fee_creator`'ı ayırmak Faz 3'ün view'inin verdiği bir olanaktır ve **doğru olanı**: `LaunchToken.creator` "kim başlattı" kaydıdır, ücreti fiilen alan cüzdan değildir (spec §5.7 devir yolları tanımlıyor, Faz 1d yazacak).

- [ ] **Adım 3: İstatistik şeridi — "Liquidity" yerine "Raised" (deviasyon)**

Ekran görüntüsü: Market cap · Liquidity · 24h volume · ATH. arcpad'de **havuz yok**, yani "Liquidity" ya sıfır ya uydurma olurdu. Şerit: **Market cap** (`market_cap_wei`) · **Raised** (`real_quote_reserves_wei` / `graduation_raise_wei`) · **24h volume** (`volume_24h_wei`) · **ATH** (`ath_market_cap_wei`) · **Holders** (`holder_count`). Büyük başlık `market_cap_wei`'nin `formatUsdcCompact` hâli; altında fiyat (`formatPriceWeiPerToken`).

**"Burned" satırı yok (S8):** yakma yolu yoktur — OZ ERC-20 `to == address(0)` için revert eder ve Arc sıfır adrese native transferi ayrıca yasaklar. Her token için sabit sıfır gösteren bir satır, ürünün bir şeyi ölçtüğü izlenimi verir.

**Link şeridinde Dexscreener/GeckoTerminal/Pool yok (S9):** spec §2 o servisleri kapsam dışı bırakıyor ve testnet'te havuz yok. Şerit: `Contract` · `Curve` (ikisi de ArcScan).

- [ ] **Adım 4: İlerleme — payı da paydası da yazılı**

`progress_ppm`'i **Faz 3'ün formülüyle** gösterir; arayüz yeniden hesaplamaz, ama zincirden çizilen dalda Task 4'ün `progressPpm`'i kullanılır ve **ikisinin aynı sayıyı verdiği bir testle** sabitlenir (fixture: kalan `592_376_046_879_238_259_473_675_895` → `253_087`).

Etiket: `25.3% to graduation` + altında `0.987654 of 12.161433 USDC raised`. **Yüzde token satışı üzerindendir, toplanan quote üzerinden değil** ve gerekçesi Faz 3'ün türetmesidir: `quoteBuyCost` her alımda `floor(...) + 1` döner, yani biriken quote tamamlanmada `R`'yi **aşar** ve quote tabanlı bir yüzde %100'ü geçer. Token tabanlı olan tam sıfırda tam `1_000_000` verir. İki sayıyı **birlikte** göstermek, ilerlemenin neyin ilerlemesi olduğunu saklamadan bırakır.

- [ ] **Adım 5: Yaşam döngüsü — üç durum, bugünden (S6, K5)**

```tsx
type Lifecycle =
  | { kind: 'trading' }                       // complete === false
  | { kind: 'complete' }                      // complete === true, havuz henuz yok
  | { kind: 'graduated'; poolNote: string }   // Faz 2; BUGUN ULASILAMAZ ama tip ve ekran HAZIR
```

- `trading` → al-sat paneli açık.
- `complete` → panel yerine `LifecycleNotice`: *"Sale supply sold out. Trading on the curve is closed; pool creation lands with Phase 2."* Üç giriş noktası da `CurveComplete()` ile döner, yani panelin açık kalması kullanıcıya kesin başarısız olacak bir işlem imzalatırdı. İstatistikler son değerlerle donar, grafik tam eğriyi gösterir.
- `graduated` → aynı bileşenin ikinci dalı; `graduate()` ve `Graduated` olayı geldiğinde **yalnızca veri kaynağı** bağlanır. Bugün bu dalın testi fixture'la yazılır ki Faz 2 bir yeniden yazım olmasın.

Bileşen testi üç durumu **ayrı ayrı** yürür ve `complete` durumunda al-sat panelinin DOM'da **olmadığını** iddia eder (gizlenmiş değil, yok).

- [ ] **Adım 6: Grafik — kova ekseni bloktur, ve boş grafik eğrinin kendisidir**

Faz 3 `candles`'ı Faz 4'e devretti, gerekçesi ölçülmüş: blokların yarısı aynı timestamp'i taşır, yani "1 dakikalık kova" timestamp'e oturtulduğunda kovaların yarısı keyfi olur. Bu yüzden:

- **Seri `trades`'ten türetilir.** Her işlemin sakladığı rezerv anlık görüntüsünden fiyat: `priceWeiPerToken(virtual_quote_reserves_wei, virtual_token_reserves_tok)` — Task 4'ün aynı fonksiyonu, yani grafik ile panel **aynı fiyat tanımını** kullanır.
- **X ekseni `event_seq`'ten türetilen blok numarasıdır** (`event_seq >> 20`), duvar saati değil. Tooltip'te timestamp gösterilir (`_at` yalnızca gösterim — K4). Eksen etiketi "block" der; zamanmış gibi göstermek yanlış olur.
- Çok işlemli tokenlarda örnekleme: blok başına **son** işlem, sonra N blok başına son işlem. Ortalama alınmaz — ortalama, olmayan bir fiyatı çizer.
- **Deviasyon 3, ve bu fazın en belirgin ürün kararı:** işlemi olmayan (ya da iki işlemi olan) bir token'ın grafiği anlamsızdır — `resim3.png` bunu gösteriyor: iki işlem, neredeyse dikey bir çizgi. arcpad bunun yerine **bonding curve'ün kendisini** çizer: satılan token miktarına karşı fiyat, profil sabitlerinden (`V`, `T`, `S`) hesaplanmış, üzerinde mevcut konumu gösteren bir işaretçi. İşlem geldikçe gerçekleşen fiyatlar bu eğrinin **üstüne** çizilir ve eğri soluk bir referans olarak kalır. Hiç işlem görmemiş bir launch **yaygın durumdur**, kenar durum değil; ürünün ilk gününde her token böyledir.
- **Kütüphane yok:** el yazımı SVG `path`. Gerekçe: bir grafik kütüphanesi paket boyutu, CSP genişliği ve bir bağımlılık daha getirir; ihtiyacımız iki seri ve bir işaretçi. `bigint → number` dönüşümü **yalnızca son adımda**, piksel hesabında yapılır.
- Erişilebilirlik: `role="img"` + eğriyi özetleyen `aria-label` (*"Price from 0.000000004 to 0.000000006 USDC over 12 trades; 25.3% to graduation"*) ve görsel olarak gizli bir `<table>` (son 20 nokta). Bir çizgi grafiği ekran okuyucuya hiçbir şey söylemez; tablo söyler.
- Aralık pill'leri `5M | 1H | 6H | 1D | ALL` **blok pencerelerine** çevrilir (Arc ~350 ms: 5M ≈ 857 blok, 1H ≈ 10.286, 6H ≈ 61.714, 1D ≈ 246.857) ve bu dönüşüm tek bir sabitte (`BLOCKS_PER_SECOND = 1000/350`) durur, yorumunda "blok süresi değişirse burası değişir" notuyla.

- [ ] **Adım 7: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `notFound` dalında `verifyCanonical`'ı atla | sahte adres testi |
| Sahte dalda isim/sembol'ü çiz | "isim okunmaz" testi |
| `complete` durumunda paneli açık bırak | üç-durum testi (DOM'da panel yok) |
| İlerlemeyi `real_quote_reserves / graduation_raise` yap | `253_087` iddiası + "%100'ü aşar" testi |
| Grafik X eksenini `created_at`'e bağla | eksen testi (aynı timestamp'li iki blok üst üste düşer) |
| Boş grafikte eğriyi çizme | "hiç işlem yok" testi (SVG'de referans eğri yok) |
| `aria-label`'ı kaldır | grafik erişilebilirlik testi |

- [ ] **Adım 8: Commit**

```bash
git commit -m "feat(web): token page that draws the curve itself when there are no trades yet"
```

**Deliverable:** dört çözümleme dalı ayrı ayrı test edilmiş; üç yaşam döngüsü durumu render ediliyor; `progress_ppm` iki kaynaktan aynı sayıyı veriyor; işlemsiz token anlamlı bir grafik gösteriyor.

---

### Task 11: Son işlemler ve holders

**Files:**
- Create: `web/components/token/{TradesTable,HoldersTable,TableTabs}.tsx`
- Create: `web/test/token/tables.test.tsx`
- Modify: `web/app/token/[address]/page.tsx` — Task 10'un bıraktığı bölüme `<TableTabs>` bağlanır

**Interfaces:**
- Tüketir: Task 7'nin `readTrades`/`readHolders`'ı ve `TradeRow`/`HolderRow` tipleri, Task 8'in `KeysetPager`'ı, Task 6'nın `<Money>`/`<Address>`'i, Task 4'ün `priceWeiPerToken`'ı.
- Üretir: `<TradesTable rows nextCursor />` · `<HoldersTable rows nextCursor totalSupply />` · `walletDeltaWei(row: TradeRow): bigint` — bir işlem satırının **cüzdandan çıkan/giren** tutarı (alımda `quote + fees`, satımda `quote − fees`); Task 12'nin onay ekranı aynı fonksiyonu kullanır, iki yerde iki formül olmasın.

- [ ] **Adım 1: `TradesTable`**

Satır: yön (▲ `Buy` / ▼ `Sell`, **hem ok hem sözcük** — renk tek başına anlam taşımaz) · token miktarı (`formatTokenAmount`) · fiyat (`formatPriceWeiPerToken`, işlemin kendi rezervlerinden) · USDC tutarı — **hangi tutar?** Alımda kullanıcının ödediği `quote_amount_wei + protocolFee + creatorFee`, satımda aldığı `quote_amount_wei − fees`. Yani **cüzdanından çıkan/giren** tutar, curve tutarı değil; `Trade` olayı üç alanı ayrı taşıdığı için ikisi de hesaplanabilir ve doğru olan kullanıcının gördüğüdür. Tooltip curve tutarını ve iki ücret parçasını ayrı gösterir.

`is_dev` badge'i **indexer'ın türettiği** alandan gelir, arayüz `trader === creator` karşılaştırmasını **kendisi yapmaz**: creator değiştirilebilir olduğunda (Faz 1d) bugünün creator'ıyla eski bir işlemi karşılaştırmak geçmişi yanlış boyar. Faz 3 bunu `creator_at(token, seq)` ile noktasal olarak çözüyor.

Sayfalama keyset, `event_seq DESC`. Yaş `_at`'ten (**yalnızca gösterim**).

- [ ] **Adım 2: `HoldersTable`**

Satır: sıra · adres (kısaltılmış, `launch_creator` ise `dev` badge'i) · bakiye · **arzın yüzdesi** (`balance_tok * 100 / 1e27`, iki ondalık).

**Curve adresi listeden çıkarılır** ve bunun bir sebebi var: arzın %100'ü orada durur, yani "en büyük holder curve" her token için doğru ve hiçbir şey söylemeyen bir satırdır. Yüzdeler bu yüzden **toplamda %100 vermez** ve tablonun altında tek satır bunu söyler: *"Excludes the curve, which holds the unsold supply."* Söylenmezse kullanıcı eksik yüzdeyi bir hata sanır.

Sayfalama `(balance_tok DESC, holder ASC)` — ikinci anahtar Task 7'de eklendi çünkü `balance_tok` tekil değildir ve bağlı satırlar sayfalamada tekrarlar.

- [ ] **Adım 3: Boş durumlar — yaygın durum**

- **Hiç işlem yok:** *"No trades yet. Be the first."* + al-sat paneline odaklanan bir link. Bu ürünün ilk gününde **her** token böyledir; bir iskelet veya boş tablo göstermek onu bir hata gibi gösterir.
- **Tek holder:** launch'tan hemen sonra holder sayısı `0`'dır (arzın tamamı curve'de ve curve hariç tutulur). Tablo *"No holders yet — the curve holds the entire supply."* der. Bu, "curve hariç" kararının doğrudan sonucudur ve ayrı bir metin gerektirir.
- **Veritabanı düştü:** iki sekme de açıklayıcı kutu gösterir; sayfanın geri kalanı (zincirden gelen) çalışmaya devam eder.

- [ ] **Adım 4: Duyarlılık ve sayı hizalaması**

Geniş ekranda `<table>`; < 640px'te satır bazlı kart düzeni (yatay kaydırma yok — para tablosunda yatay kaydırma, kullanıcının tutarı kolon başlığından koparmasına yol açar). Bütün sayısal hücreler sağa hizalı ve `tabular-nums` (Task 6); bileşen testi bunu iddia eder.

`<table>` semantiği korunur: `<caption>` (görsel olarak gizli), `<th scope="col">`, sıralanabilir kolon yok (sıra zincir sırasıdır ve kullanıcı sıralaması onu bozar).

- [ ] **Adım 5: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| Alım satırında curve tutarını göster (ücretsiz) | "cüzdandan çıkan tutar" testi |
| `is_dev`'i `trader === overview.fee_creator` ile hesapla | creator-değişti fixture'ı |
| Holders'tan curve'ü çıkarmayı kaldır | "curve listede değil" testi |
| "curve hariç" dipnotunu sil | dipnot testi |
| İkinci sıralama anahtarını sil | eşit bakiyeli sayfalama testi |
| Boş-işlem metnini boş tabloyla değiştir | boş durum testi |

- [ ] **Adım 6: Commit**

```bash
git commit -m "feat(web): trades and holders tables that show what left the wallet, not the curve amount"
```

**Deliverable:** iki tablo sayfalanıyor; üç boş durum ayrı ayrı test edilmiş; alım satırındaki tutar ücret dâhil.

---

### Task 12: Al-sat paneli

Bu panel bu fazın **ürün merkezi** ve kullanıcı parasının geçtiği tek yer. Üç giriş noktası, üç farklı sınır davranışı, iki farklı ücret sözleşmesi — ve hiçbiri diğerinin testiyle kapanmaz.

**Files:**
- Create: `web/components/token/{TradePanel,AmountInput,SlippageControl,QuoteBreakdown,ApproveStep,MaxButton}.tsx`
- Create: `web/hooks/{useCurveState,useTrade,useApproval,useGasReserve}.ts`, `web/lib/gas.ts`
- Create: `web/test/trade/*.test.tsx`
- Modify: `web/app/token/[address]/page.tsx` — Task 10'un bıraktığı bölüme `<TradePanel>` bağlanır (`lifecycle.kind === 'trading'` iken)

**Interfaces:**
- Tüketir: Task 4'ün üç planlayıcısı ve `CurveState`/`CurveProfile`/`TradePlan`'ı, Task 3'ün `decodeArcpadError`'ı, Task 2'nin `parseUsdcAmount`/biçimlendiricileri ve `useUsdcBalance`'ı, Task 1'in `useArcNetwork`'ü, Task 10'un `Lifecycle`'ı, Task 11'in `walletDeltaWei`'ı.
- Üretir: `useCurveState(curve): { state: CurveState | undefined; refetch }` (2000 ms aralık) · `useGasReserve(request): { reserve: bigint | null }` ve saf `gasReserveFrom(gasEstimate, maxFeePerGas)` (`web/lib/gas.ts`, `×3/2` emniyet payı burada ve **yalnızca burada**) · `useApproval(token, spender, needed)` · `useTrade(): { submit(plan), status, failure, realised }` · `<TradePanel token curve lifecycle>`.

> **Hata metinleri:** bu görev `decodeArcpadError`'ın döndürdüğü `title`/`remedy`'yi doğrudan gösterir. Ortak `TxStatusRegion`/`FailureNotice` bileşenleri ve tam metin tablosu **Task 14**'te gelir ve o görev bu dosyayı ve `LaunchForm`'u o bileşenleri kullanacak şekilde **değiştirir**. Bu sıralama bilinçli: panel önce çalışır durumda olur, metin sonra tabloya çekilir.

- [ ] **Adım 1: Rezervleri oku — panel veritabanına DOKUNMAZ**

`useCurveState(curve)` tek bir multicall3 çağrısıyla altı alanı okur: dört rezerv + `complete` + `creator`. Yenileme: **2000 ms** aralık + pencere odağı + işlem onayı sonrası. Arc blok süresi ~350 ms olduğu için blok başına yenilemek saniyede ~3 istek demektir ve hiçbir şey kazandırmaz: kullanıcıyı bayat kotadan koruyan şey **slipaj argümanıdır**, yenileme sıklığı değil. `creator` da okunur çünkü `creator === 0x0` ücret dökümünü değiştirir (K2).

Panel `@arcpad/db`'yi **hiç import etmez** ve bu iki testle kapatılır: (a) `web/lib/db.ts`'in `getPool`'u her çağrıda hata fırlatacak şekilde sahtelenir, panel yine kota üretir ve `submit` çağrısı zincire gider; (b) bir kaynak-metni iddiası — `web/components/token/TradePanel.tsx` ve `web/hooks/useCurveState.ts` içinde `@arcpad/db` ya da `lib/db` import'u **yoktur** (Task 1'in `chain-registry` kapısıyla aynı şekil).

- [ ] **Adım 2: Üç eylem, üç sınır, tek motor**

| Sekme | Girdi | Giriş noktası | Sınır etiketi |
|---|---|---|---|
| **Buy · Spend USDC** (varsayılan) | USDC (6 ondalık) | `buyExactQuoteIn(minTokensOut)`, `value = spend` | *Minimum tokens you receive* |
| **Buy · Receive tokens** | token | `buyExactTokensOut(tokensOut, maxQuoteIn)`, `value = maxQuoteIn` | *Maximum you spend, fees included* |
| **Sell** | token | `sellExactTokensIn(tokensIn, minQuoteOut)`, `value = 0` | *Minimum you receive, after fees* |

**Varsayılan `Spend USDC`'dir** ve gerekçesi ekranda de yazılıdır: rezervin tepesinde bütçe kısılır ve artan iade edilir, yani **bayat bir kotadan dolayı başarısız olamaz**. `Receive tokens` sekmesi rezervin üstünde bir miktar istendiğinde `NotEnoughTokensToBuy()` ile revert eder; bu yüzden o sekmede girdi `realTokenReserves`'e **kelepçelenir** ve kelepçe görünür bir satır olarak söylenir (*"Only 592,376,046.879238 left on the curve"*), sessizce değil. İkisini simetrik sunmak S7'nin hatasıdır.

- [ ] **Adım 3: Döküm — ücret asimetrisi saklanmaz (K2)**

`QuoteBreakdown` **varsayılan olarak açıktır** (pons katlıyor). Gerekçe: arcpad'in ücreti iki parçadan toplanır ve alım/satım tarafında farklı yönde uygulanır; katlanmış bir döküm bu ikisini çıkarsanamaz kılar.

Alım (1,000000 USDC bütçe, taze testnet curve) — **sabitlenmiş satırlar**:

```
You spend                 1.000000 USDC          <- cuzdandan cikan
  Curve amount            0.987654 USDC          <- rezervlere giren
  Protocol fee (0.95%)    0.009382 USDC          <- curve tutarinin uzerine
  Creator fee (0.30%)     0.002962 USDC          <- curve tutarinin uzerine
You receive             ~200,723,953.120761 DIFF
Minimum received         198,716,713.589554 DIFF (slippage 1%)
Price impact                      +51.32%        <- 0.0(8)4 -> 0.0(8)6052
Progress after                      25.3%
```

Bu bloğun **her satırı** sabitlenmiş bir değerdir ve elle türetilmiştir: `minTokensOut = floor(200_723_953_120_761_740_526_324_105 × 9900 / 10_000) = 198_716_713_589_554_123_121_060_863` (6 ondalıkta `198,716,713.589554`), fiyat etkisi `6_052_733_351 / 4_000_000_000 − 1 = +51,3183%` (iki ondalıkta `+51.32%`), ilerleme `253_087 ppm`. Bileşen testi bu altı satırı **dize olarak** karşılaştırır — bir biçimlendirme yönü değiştiğinde kırılır.

Kurallar, hepsi ölçülmüş bir sebebe bağlı:

1. **Ücret satırları mutlak değerdir**, bir yüzdenin girdiye uygulanmasıyla üretilmez. Aynı işlemde toplam ücret bütçenin **%1,2345679'u**dur, %1,25'i değil; yüzde etiketi bu yüzden "of the curve amount" der.
2. **İki parça ayrı satır.** Toplanıp tek satır yazmak, iki tavan yuvarlamasının toplamı ile birleşik oranın tek yuvarlaması arasındaki farkı görünmez kılar — bu depoda `feeOn(x,125)`'in yasak olmasının aynı gerekçesi.
3. `creator === 0x0` ise creator satırı **yerine** tek satır: *"No creator fee on this launch."* Sıfır yazmak "alındı ama sıfır" gibi okunur; asıl gerçek alınmadığıdır ve protokol payına **katlanmadığıdır**.
4. Satış dökümü **ayrı bir metin şablonudur**, ortak bir bileşen değil: `You receive` net tutardır ve ücretler curve çıktısından **düşülür**. Bir test iki şablonun etiketlerinin farklı olduğunu iddia eder ve şablonları takas eden bir mutant kırmızıya döner.
5. **Gidiş-dönüş gerçeği** satış dökümünde bir kez söylenir: 1,000000 USDC ile alıp hemen satan kullanıcı **0,975308 USDC** alır (kayıp `24_691_358_024_691_361` wei = %2,4691). İki bacaklı ücret bir sürpriz olmamalı.
6. `Price impact` eşiği %10; üzerinde `--color-negative` ve bir uyarı satırı. **Bloklanmaz** — bonding curve'de yüksek etki normaldir, testnet profilinde 1 USDC satış arzının çeyreğini alır. Bloklamak ürünü yanlış tarif eder; söylememek kullanıcıyı şaşırtır.

- [ ] **Adım 4: MAX ve yüzde kısayolları — gas payı ZORUNLU (K1)**

Arc'ta gas **işlemin kendi varlığıyla** ödenir. Bakiyenin tamamını harcayan bir MAX her seferinde başarısız olur.

```ts
// gasReserve OLCULUR, varsayilmaz: bu cagri icin estimateGas x
// estimateFeesPerGas.maxFeePerGas x 1.5 emniyet payi.
// Tahmin BASARISIZ olursa MAX ve yuzde kisayollari DEVRE DISI kalir ve
// sebebi tooltip'te yazar. Sihirli bir sabit KONMAZ: Arc'in gas fiyati bu
// planin dogrulayamadigi bir sey (bkz. "Kurulamayanlar").
const spendable = balance > gasReserve ? balance - gasReserve : 0n
```

`25% · 50% · 75% · MAX` **`spendable` üzerinden** hesaplanır, `balance` üzerinden değil. `Receive tokens` sekmesindeki MAX iki tavanla kelepçelenir: `realTokenReserves` ve `spendable`'ın slipaj payı düşülmüş hâliyle alınabilecek miktar.

Test: bakiye tam olarak işlem maliyetine eşitken MAX **daha küçük** bir tutar üretir ve kurulan işlem `InsufficientFunds` almaz (anvil'de ölçülür, Task 15'in bir vakası).

- [ ] **Adım 5: Satış iki işlemdir — `approve` sonra `sell`**

`sellExactTokensIn` `transferFrom` kullanır ve `LaunchToken` düz OZ ERC-20'dir: `permit` **yok**. Yani satış **iki imza**dır ve panel bunu gizlemez:

```
1. Approve DIFF   (onay: 200,723,953.120761 DIFF)
2. Sell
```

- `allowance(user, curve)` okunur; yeterliyse birinci adım hiç görünmez.
- Onay miktarı **tam olarak `tokensIn`**, sınırsız değil. Gerekçe: sınırsız onay bir alışkanlıktır ve öğretmeye değmez; Arc'ta yeniden onay ~46k gas ve hedeflenen ~0,01 USD işlem maliyetinde ihmal edilebilir.
- `approve` onaylandıktan sonra **satış otomatik gönderilmez** — ikinci buton etkinleşir. Kullanıcının basmadığı bir işlem gönderilmez, istisnasız.
- `ERC20InsufficientAllowance(spender, allowance, needed)` parametreli bir hatadır; onay atlandığında mesaj **eksik miktarı yazar** (Task 14).

- [ ] **Adım 6: İşlem yaşam döngüsü — ve gerçekleşen miktar OLAYDAN okunur**

```
idle → simulating → awaitingSignature → pending(hash) → confirmed(realised) | failed(ArcpadFailure)
```

- **`simulating`:** `simulateContract` tam args ve `value` ile. Revert varsa cüzdan penceresi **hiç açılmaz** ve çözülmüş sebep gösterilir; gönderme devre dışı kalır. İstisna: hata `kind: 'network'` ise (RPC geride/hız sınırı) gönderme bir uyarıyla açık kalır — simülasyonun başarısızlığı işlemin başarısızlığı demek değildir.
- **`pending`:** hash + ArcScan linki hemen görünür. Arc'ın finality'si ~350 ms, yani bu durum kısa ömürlüdür ama **atlanmaz**: kullanıcı imzaladıktan sonra hiçbir ara durumun olmaması, işlemin kaybolduğu izlenimi verir.
- **`confirmed`:** gösterilen miktarlar makbuzun `Trade` olayından `parseEventLogs` ile okunur — **kotadan değil**. Kısma, iade ve son işlem kısmi doldurmasında talep ile gerçekleşen ayrışır; spec §5.4'ün "gerçekleşen miktarlar olaydan okunmalıdır" kuralının arayüz karşılığı budur. `clamped` bir alımda ek satır: *"Filled to the remaining supply; 7.686548 USDC refunded."*
- `Trade` olayı **`indexed` olmayan** `isBuy` alanı taşır, yani yön topic'ten değil veriden okunur — `parseEventLogs` bunu zaten yapar, ama filtreyi `isBuy` üzerine kurmaya çalışan bir kod sessizce boş döner (Faz 3'ün S-tablosunda aynı tuzak).
- İşlem onaylandığında: `useCurveState` yenilenir, bakiye yenilenir, `router.refresh()` ile server component verisi tazelenir. İndexer birkaç blok geride olabilir; işlem listesi hemen güncellenmezse bu bir hata değildir ve **iyimser bir satır uydurulmaz** — makbuzdan gelen gerçek işlem "Your trade" olarak listenin üstüne eklenir ve indexer'dan geldiğinde tekilleştirilir (`event_seq`).

- [ ] **Adım 7: Buton durumları — tek bir sıra**

`disconnected` → *Connect wallet* · `wrongNetwork` → *Switch to Arc Testnet* · `complete` → panel yok (Task 10) · girdi boş → *Enter an amount* (devre dışı) · girdi > spendable → *Insufficient USDC* · `Receive tokens`'ta girdi > rezerv → kelepçelenmiş + uyarı · onay gerekiyor → *Approve DIFF* · simülasyon başarısız → çözülmüş sebep (devre dışı) · hazır → *Buy DIFF* / *Sell DIFF*.

Sıra bağlayıcıdır ve bir tablo testi hepsini yürür: her durum için **tam olarak bir** buton metni.

- [ ] **Adım 8: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `Spend USDC` sekmesini `buyExactTokensOut`'a haritala | sekme→giriş noktası testi + kısma testi |
| `maxQuoteIn`'i ücret hariç hesapla | simülasyon testi (`SlippageExceeded`) |
| `minQuoteOut`'a `proceeds` ver | satış dökümü testi |
| Ücret satırlarını `feeOn(spend, 125)` ile üret | döküm sabitleri (0.009382 / 0.002962) |
| Alım ve satım için aynı etiket şablonunu kullan | "iki şablonun etiketleri farklı" testi |
| `spendable` yerine `balance` kullan | MAX gas payı testi |
| `allowance` kontrolünü kaldır | onay akışı testi (`ERC20InsufficientAllowance`) |
| `approve` onayından sonra satışı otomatik gönder | "kullanıcı basmadan işlem gitmez" testi |
| Onaylanan miktarı kotadan göster | kısma vakası (`clamped`) testi |
| `creator === 0x0` dalını kaldır | sıfır-creator döküm testi |
| Panele `@arcpad/db` import et | veritabanı-bağımsızlık testi |

- [ ] **Adım 9: Commit**

```bash
git commit -m "feat(web): trade panel with the fee asymmetry stated rather than hidden"
```

**Deliverable:** üç eylem üç ayrı giriş noktasına haritalanıyor ve **her biri kendi testine sahip**; döküm satırları Task 4'ün vektörleriyle birebir; MAX gas payı bırakıyor; satış iki adımlı; onaylanan miktarlar olaydan okunuyor.

---

### Task 13: `/create` — launch akışı

**Files:**
- Create: `web/app/create/page.tsx`, `web/app/api/metadata/route.ts`
- Create: `web/components/create/{LaunchForm,ByteCounter,MetadataUpload,TokenPreviewCard,LaunchResult}.tsx`
- Create: `web/hooks/useLaunch.ts`
- Create: `web/test/create/*.test.tsx`
- Modify: `.env.example`

**Interfaces:**
- Tüketir: Task 2'nin `utf8ByteLength`/`normaliseMetadataText`/`truncateToBytes`/`sanitiseForDisplay`/`METADATA_LIMITS`'i, Task 3'ün `launchFactoryAbi`/`decodeArcpadError`'ı, Task 4'ün `graduationRaise`/`poolSeedSupply`/`marketCap`'i, Task 1'in `ADDRESSES`/`getCurveProfile`'ı, Task 6'nın primitifleri.
- Üretir: `useLaunch(): { submit(fields), status, failure, result: { token, curve } | undefined }` · `<ByteCounter value maxBytes>` · `<TokenPreviewCard fields facts>` · `buildMetadataJson(fields): string` · `POST /api/metadata` → `{ uri: string }` | `501 { error: 'pinningNotConfigured' }`.

**"Advanced" bölümü çizilmez (S16).** Launch'ın üç argümanı var ve geri kalan her parametre factory'nin immutable'ıdır; creator'ın ayarlayabileceği ileri düzey bir alan **yoktur**. Katlanmış boş bir bölüm, olmayan bir kontrol vaat eder. Bunun yerine aynı yere tek satır konur: *"Curve parameters are fixed for every launch."* — bir bileşen testi bu satırın varlığını ve `Advanced` sözcüğünün **yokluğunu** iddia eder.

- [ ] **Adım 1: Zincire giden üç alan, gitmeyen dört alan**

`launch(string name, string symbol, string uri)` — **hepsi bu**. Açıklama, görsel, X ve Telegram **zincirde yoktur**; `uri`'nin gösterdiği metadata JSON'unun içindedir:

```json
{ "name": "…", "symbol": "…", "description": "…", "image": "ipfs://…", "x": "…", "telegram": "…" }
```

Form bunu ayırır ve **hangi alanın zincire gittiğini söyler**: isim, ticker ve metadata bağlantısı kalıcıdır ve değiştirilemez; geri kalanı metadata dosyasındadır. Sonradan mint yolu, isim değiştirme yolu yoktur.

- [ ] **Adım 2: Bayt doğrulaması, canlı (Task 2'nin motoruyla)**

Her alanın altında `27/32 bytes` sayacı; sınırda `--color-accent`, aşınca `--color-negative` ve gönderim engellenir. Sayım `utf8ByteLength(normaliseMetadataText(value))` — yani **kullanıcıya gösterilen sayı, zincire gidecek dizenin sayısıdır**.

Sabitlenmiş bileşen testleri: `🚀`×8 kabul (32/32), `🚀`×9 ret (36/32, `.length` 18 der), NFD `é` 2 bayt sayılır (3 değil), `Görüşürüz` 14 bayt. Sembol için `🚀`×3 = 12/13 kabul, ×4 = 16/13 ret.

**Karakter kısıtı yok, ve bu bilinçli:** zincir yalnızca bayt uzunluğu dayatır. pons "Letters, numbers, and spaces" diyor; arcpad yazılabilecek şeyi daraltmaz ama **gösterimde** `sanitiseForDisplay` uygular (Task 2) ve önizleme kartı temizlenmiş hâli gösterir — kullanıcı ekranda ne görünecekse onu görür.

- [ ] **Adım 3: Metadata — pinning isteğe bağlı, URI yolu her zaman çalışır**

`POST /api/metadata` (yalnızca yazma; spec §6.3'e uyar): görsel + alanları alır, bir pinning sağlayıcısına yükler, `ipfs://<cid>` döner. Sağlayıcı `ARCPAD_PIN_ENDPOINT` / `ARCPAD_PIN_TOKEN` ile yapılandırılır ve **yapılandırılmamışsa route 501 döner**; form o durumda ikinci yola düşer:

- **URI yolu:** kullanıcı kendi `ipfs://…` veya `https://…` URI'sini yapıştırır. 200 bayt sınırı burada da sayılır (`ipfs://` + CIDv1 base32 = 66 bayt, rahat; sorgu parametreli bir gateway URL'i sınırı aşabilir ve sayaç bunu gösterir).
- **URI'siz launch:** `uri` boş dize olabilir — kontrat yalnızca isim ve sembolün boş olmamasını ister (`EmptyName`/`EmptySymbol`). Form bunu açıkça sunar: *"Launch without artwork — you cannot add it later."* Bu bir kolaylık değil dürüstlük: `metadataURI` `immutable` değil ama **değiştirme fonksiyonu yoktur**.

Yükleme onayı kutusu korunur (pons'taki gibi): *"I understand the artwork is uploaded to public IPFS and cannot be removed."* Onaylanmadan dosya seçilemez.

- [ ] **Adım 4: Geliştirici alımı İKİNCİ BİR İŞLEMDİR (S4)**

Spec üç yerde atomik bir dev buy ve satış arzının %5'i tavanı tarif ediyor. **Kontratta ikisi de yok:** `launch` `payable` değil ve hiçbir alım yapmaz; zincirde bir tavan yoktur. Arayüzün göstereceği herhangi bir tavan **yalan** olurdu.

Bunun yerine: form üzerinde isteğe bağlı bir *"Buy after launch"* tutarı; launch onaylandıktan sonra kullanıcı token sayfasına yönlendirilir ve al-sat paneli o tutarla **önceden dolu** gelir. İkinci işlem kullanıcının kendi basışıyla gider. Metin bunu söyler: *"A separate transaction. Your launch is live either way."* Zincirde tavan olmadığı da tek satırla yazılır — söylenmezse kullanıcı bir koruma varsandığı için daha büyük bir ilk alım yapar.

- [ ] **Adım 5: Önizleme kartı — sayılar zincirden, metin sabit değil**

`TokenPreviewCard` (ekran görüntüsündeki sağ kart) satırları:

| Satır | Değer | Kaynak |
|---|---|---|
| Launch fee | **None** | `launch` `payable` değil — ücretsiz oluşturma spec §5.3'ün doğrulanmış ifadesi |
| Trading fee | `0.95%` protocol + `0.30%` creator | `PROTOCOL_FEE_BPS` / `CREATOR_FEE_BPS`, mevcut bir curve'den okunur; curve yoksa pinlenmiş 95/30 ve Task 5'in harness'ı bunların deploy edilmiş değerle **aynı olduğunu** ölçer |
| Total supply | `1,000,000,000` | `LaunchToken.TOTAL_SUPPLY` |
| On the curve | `793,100,000` (%79,31) | `factory.SALE_SUPPLY()` |
| Reserved for the pool | `206,886,011.183597` (%20,69) | `poolSeedSupply(S, T)` |
| Graduation at | `12.161433 USDC` raised | `graduationRaise(S, V, T)` |
| Opening market cap | `4.00 USDC` | `marketCap(V, T, N)` |
| Liquidity | *Locked at graduation — not live on testnet yet* | Faz 2 |

Son satır kritik: "Liquidity: Locked" yazmak, bugün var olmayan bir garantiyi vaat etmek olurdu. Havuz ve kalıcı kilit Faz 2'dedir ve kart bunu söyler.

`Reserved for the pool` tooltip'i tek gerçeği daha taşır: `N − S − D = 13,988.816402609506057782` token **hiçbir zaman hiçbir yere gitmez** ve curve'de kalır (spec §5.2'nin kalıcı artığı). Bir launchpad'de arzın nereye gittiği toplamda %100'ü tutmak zorundadır; tutmuyorsa sebebi yazılı olmalıdır.

- [ ] **Adım 6: İşlem yaşam döngüsü ve adres OLAYDAN alınır**

```
draft → validating → simulating → awaitingSignature → pending(hash) → launched(token, curve) | failed
```

- **`simulating`:** `simulateContract` ile `launch(name, symbol, uri)`. `EmptyName`, `EmptySymbol`, `NameTooLong`, `SymbolTooLong`, `UriTooLong` cüzdan penceresi açılmadan yakalanır. İstemci doğrulaması bunları zaten engeller; simülasyon **ikinci** kapıdır ve bir gün istemci doğrulaması ile kontrat ayrışırsa kullanıcı gas ödemeden öğrenir.
- **`launched`:** token ve curve adresleri makbuzun `Launched` olayından okunur. **`predictAddresses` ile tahmin edilen adrese ASLA yönlendirilmez:** salt `launchCount`'u içerir ve `launchCount` **globaldir**, yani araya giren başka bir launch tahmini geçersiz kılar. Launch ekranında yanlış bir adres göstermek, kopyalanıp paylaşıldığında doğrudan bir dolandırıcılık yoluna dönüşür. `predictAddresses` arayüzde **hiç kullanılmaz**; Task 5'in harness'ı onu makbuzdaki adresle karşılaştırmak için kullanır (yarışsız durumda eşit olmalıdır) ve bu, fonksiyonun tek tüketicisidir.
- **`launched`** ekranı: token adresi + kopyala + ArcScan + `View token` + (varsa) "Buy after launch" tutarıyla token sayfasına git.
- Değer göndermeye çalışan bir çağrı (`payable` değil) **veri taşımayan** bir revert verir; Task 14'ün boş-revert dalı bunu karşılar ve arayüz `launch`'a hiçbir zaman `value` koymaz.

- [ ] **Adım 7: Boş / hata durumları**

Bağlı değil → form doldurulabilir, gönderim butonu *Connect wallet* · yanlış ağ → *Switch to Arc Testnet* · pinning yapılandırılmamış → URI alanı + açıklama (bir hata gibi gösterilmez; ürünün o kurulumda çalışma biçimidir) · yükleme başarısız → alan korunur, dosya kaybolmaz, tekrar denenebilir · launch reddedildi (4001) → form **aynen durur** (en sık yaşanan durum ve formu sıfırlamak affedilmez).

- [ ] **Adım 8: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| Bayt sayacını `.length`'e çevir | `🚀`×9 testi |
| `normaliseMetadataText`'i sayaçtan çıkar | NFD `é` testi |
| Formda %5 dev-buy tavanı göster | "zincirde tavan yok" metin testi |
| `launch`'a `value` ekle | boş-revert testi |
| Adresi `predictAddresses`'ten al | yarış testi (araya bir launch girer, adres yanlış) |
| Önizlemede `Liquidity: Locked` yaz | metin testi (Faz 2 ibaresi zorunlu) |
| Cüzdan reddinde formu sıfırla | "form korunur" testi |
| Simülasyon adımını kaldır | uzun-isimle-gönderim testi (cüzdan açılır) |

- [ ] **Adım 9: Commit**

```bash
git commit -m "feat(web): launch flow with byte-accurate metadata limits and no invented dev-buy cap"
```

**Deliverable:** sekiz bayt vektörü formda yeşil; pinning yapılandırılmamışken launch yine mümkün; adres makbuzdaki olaydan geliyor; önizleme kartının sekiz satırı zincir kaynaklı.

---

### Task 14: Hata yüzeyi — her revert'in okunabilir bir karşılığı

Task 3 makineyi kurdu (ABI, çözücü, tamlık kapısı). Bu görev **metni** yazar ve tabloyu **kontratlardan sayarak** kapatır. Tablo `(eylem, hata)` çiftleriyle anahtarlıdır: `ZeroAmount()`'ın `CurveMath` ile `FeeEscrow`'da **aynı selector'u** taşıdığı ölçüldü, yani selector tek başına katmanı söylemez ve doğru anahtar çifttir.

**Files:**
- Modify: `web/lib/failureTable.ts` (Task 3 yapıyı kurdu; bu görev metni ve `REACHABLE_BY_ACTION`'ı ekler), `web/lib/decodeRevert.ts`
- Create: `web/components/tx/{TxStatus,TxStatusRegion,FailureNotice}.tsx`
- Create: `web/test/failures/*.test.ts(x)`
- Modify: `web/components/token/TradePanel.tsx`, `web/components/create/LaunchForm.tsx` — Task 12 ve Task 13'ün satır-içi durum gösterimleri bu üç bileşene taşınır

**Interfaces:**
- Tüketir: Task 3'ün `decodeArcpadError`/`ArcpadFailure`/`ArcpadAction`/`FAILURE_TABLE`/`UNREACHABLE_BY_CONSTRUCTION`'ı, Task 5'in kapsam sayaçları (`REACHABLE_BY_ACTION`'ı doğrulamak için), Task 12/13'ün `useTrade`/`useLaunch` durum makineleri.
- Üretir: `REACHABLE_BY_ACTION: Record<ArcpadAction, readonly string[]>` · `<TxStatusRegion>` (kabukta tek `aria-live` bölgesi) · `<TxStatus state hash>` · `<FailureNotice failure>`.

- [ ] **Adım 1: Tam sayım — `launch`**

| Hata | Kaynak | UI'dan ulaşılabilir? | Metin |
|---|---|---|---|
| `EmptyName()` | `LaunchFactory` | hayır (istemci engelliyor), simülasyonda | *"Name is required."* |
| `EmptySymbol()` | `LaunchFactory` | hayır, simülasyonda | *"Ticker is required."* |
| `NameTooLong()` | `LaunchToken` | hayır (bayt sayacı), simülasyonda | *"Name is over 32 bytes."* |
| `SymbolTooLong()` | `LaunchToken` | hayır, simülasyonda | *"Ticker is over 13 bytes."* |
| `UriTooLong()` | `LaunchToken` | hayır, simülasyonda | *"Metadata link is over 200 bytes."* |
| `ZeroCreator()` · `ZeroCurve()` | `LaunchToken` | **yapısal olarak hayır** — `launch` `msg.sender`'ı ve yeni curve'ü geçirir | operatör sınıfı |
| veri taşımayan revert | EVM | evet | *"The transaction was rejected on-chain without a reason."* + hash. Kaynakları: `payable` olmayan `launch`'a değer, CREATE2 çakışması, gas tükenmesi. **Tahmin edilmez** |

- [ ] **Adım 2: Tam sayım — `buyExactQuoteIn(minTokensOut)`**

| Hata | Kaynak | Ulaşılabilir? | Metin / çare |
|---|---|---|---|
| `CurveComplete()` | `BondingCurve` | **evet, ve yarışla** | *"This curve sold out while you were trading."* → sayfayı yenile; panel `complete` durumuna geçer |
| `ZeroQuoteIn()` | `BondingCurve` | hayır (boş girdi engelli) | *"Enter an amount."* |
| `SlippageExceeded()` | `BondingCurve` | **evet** | *"Price moved past your slippage limit."* → toleransı yükselt veya tekrar dene |
| **`NetTooSmall()`** | **`CurveMath` (kütüphane)** | kuantalamayla **hayır** | *"That amount is too small to buy any tokens."* — **`BondingCurve`'ün kendi hata kümesinde DEĞİL**; çözücü kütüphane katmanını da tanımazsa kullanıcı bilinmeyen bir selector görür |
| `RefundFailed()` | `BondingCurve` | evet (kontrat cüzdan / bloklanmış adres) | *"Your wallet could not receive the refunded USDC."* |
| `NotBound()` | `BondingCurve` | operatör | *"This launch is misconfigured."* |
| `ZeroAmount()`/`ZeroReserve()`/`InvalidBps()`/`InsufficientTokenReserve()` | `CurveMath` | hayır (korumalar önce döner) | operatör sınıfı; **listede durur** ki ulaşıldığı gün sessiz geçmesin |
| `ZeroRecipient()` · `ZeroAmount()` | `FeeEscrow` | hayır | operatör sınıfı |

`NetTooSmall`'ın **iki atış yeri** vardır ve ikisi de bu giriş noktasından çıkar: `gross = 2` → `correctedNetQuoteIn` (3. adım), `gross ∈ {1, 3}` → `quoteBuyTokensOut` (4. adım). `gross = 4` geçer. Metin aynıdır; tabloda ikisi ayrı satır **değildir** ama Task 5 ikisini ayrı sayaçla yürür.

- [ ] **Adım 3: Tam sayım — `buyExactTokensOut(tokensOut, maxQuoteIn)`**

| Hata | Ulaşılabilir? | Metin / çare |
|---|---|---|
| `CurveComplete()` | evet | yukarıdaki gibi |
| `ZeroTokensOut()` | hayır | *"Enter an amount."* |
| **`NotEnoughTokensToBuy()`** | **evet — bu giriş noktasına ÖZGÜ** | *"Only {realTokenReserves} left on the curve. Switch to “Spend USDC” to buy the rest."* — S7'nin arayüz karşılığı: bu yol **kısmi doldurmaz** |
| `SlippageExceeded()` | evet, **iki farklı sebeple** | `total > maxQuoteIn` → *"Price moved past your slippage limit."* · `total > msg.value` → *"Your wallet did not send enough USDC."* Aynı selector, iki sebep; arayüz `maxQuoteIn` ve `value`'yu bildiği için **hangisi olduğunu yerel olarak ayırt eder** ve doğru metni seçer |
| `RefundFailed()` | evet | yukarıdaki gibi |

- [ ] **Adım 4: Tam sayım — `approve` + `sellExactTokensIn(tokensIn, minQuoteOut)`**

| Hata | Kaynak | Ulaşılabilir? | Metin / çare |
|---|---|---|---|
| `ERC20InsufficientAllowance(spender, allowance, needed)` | `LaunchToken` (OZ) | **evet, en olası gerçek hata** | *"Approve {needed − allowance} more DIFF before selling."* — parametreli hata, eksik miktar **yazılır** |
| `ERC20InsufficientBalance(sender, balance, needed)` | `LaunchToken` (OZ) | evet | *"You hold {balance} DIFF."* |
| `CurveComplete()` | `BondingCurve` | evet | *"Trading on this curve is closed."* |
| `ZeroTokensIn()` | `BondingCurve` | hayır | *"Enter an amount."* |
| **`ProceedsTooSmall()`** | `BondingCurve` | kuantalamayla **hayır** | *"That amount is too small to return any USDC after fees."* — girdi geçerliydi, **sonuç** değil; `ZeroTokensIn`'den ayrı bir hatadır ve metni de ayrıdır |
| `SlippageExceeded()` | `BondingCurve` | evet | *"Price moved past your slippage limit."* |
| `PayoutFailed()` | `BondingCurve` | evet (kontrat cüzdan / bloklanmış adres) | *"Your wallet could not receive USDC."* |
| `TokenTransferFailed()` | `BondingCurve` | **yapısal olarak hayır** — OZ ERC-20 `false` dönmez, revert eder | operatör sınıfı |

`ProceedsTooSmall`'ın ölçülmüş sınırı (1 USDC'lik alım sonrası durumda): son reddedilen `tokensIn` = **`495_643_839`**, ilk kabul edilen = **`495_643_840`** (≈ `4.96e-10` token). Arayüzün kuantumu `1e12`, yani üç büyüklük mertebesi üstünde.

- [ ] **Adım 5: Kontrat dışı başarısızlıklar — birinci sınıf**

| Durum | Algılama | Metin / davranış |
|---|---|---|
| Kullanıcı reddi | `UserRejectedRequestError` / `code 4001` | **kırmızı kutu YOK.** Nötr satır: *"Cancelled."* Form ve girdiler **korunur** |
| Fon yetersizliği | `InsufficientFundsError` | *"You need {amount} USDC for this trade plus about {gasReserve} for gas — both come from the same balance on Arc."* İki kalem **ayrı** yazılır |
| Yanlış ağ | kendi kapımız (Task 1) | buton *Switch to Arc Testnet* |
| RPC / zaman aşımı / hız sınırı | `HttpRequestError`, `TimeoutError` | `retryable: true`, tekrar dene düğmesi |
| Makbuz gelmiyor | `waitForTransactionReceipt` zaman aşımı | *"Still pending."* + ArcScan linki; **başarısız denmez** — Arc'ta finality ~350 ms olduğu için bu neredeyse her zaman bir RPC sorunudur |
| Arc dize revert'i | `reason` içinde `"Zero address not allowed"` | *"Arc does not allow transfers to the zero address."* Bu bir **custom error değil**, dize revert'idir; dize dalı olmadan "bilinmeyen hata" olur |
| Arc blocklist reddi | özel selector'suz revert, gas ödenmiş | *"This transfer was rejected by the network."* Arc bloklamayı **çalışma zamanında** uygular; `FeeEscrow`'un NatSpec'i bunu kabul edilmiş bir risk olarak kaydediyor |
| Bilinmeyen | hiçbir dal tutmadı | `kind: 'unknown'`, ham hata + **kopyala** düğmesi. Bu dal **boş bırakılmaz** |

- [ ] **Adım 6: Duyuru bölgesi ve tamlık kapıları**

`TxStatusRegion` uygulama kabuğunda tek bir `aria-live="polite" role="status"` bölgesi tutar; başarısızlıklar `aria-live="assertive" role="alert"`. Durum metni **kısa ve eylem içerir**; ArcScan linki her durumda hash ile birlikte.

İki kapı:

```ts
// (1) IKI BOYUTLU TAMLIK. "Bir yolda kapatilan ozellik hepsinde kapatilmis
//     gorunur" -- bu tablo tam olarak o hatanin panzehiri: her EYLEM x her
//     ULASILABILIR HATA hucresi bir metne sahip olmak ZORUNDA.
it('her eylem x ulasilabilir hata hucresinin metni var', () => {
  for (const action of [...TRADE_ACTIONS, 'launch', 'approve'] as const) {
    for (const name of REACHABLE_BY_ACTION[action]) {
      const entry = FAILURE_TABLE[`${action}:${name}`]
      expect(entry, `${action} x ${name} metinsiz`).toBeDefined()
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.remedy ?? '', `${action} x ${name} caresiz`).not.toBe('')
    }
  }
})

// (2) ABI'DEN TURETILEN SAYIM: hicbir hata siniflandirilmamis kalmasin.
it('ARCPAD_ERROR_ABI nin her hatasi ya tabloda ya ulasilamaz listesinde', () => { /* Task 3, Adim 5 */ })
```

`REACHABLE_BY_ACTION` bir **liste**dir ve Task 5 onu **doğrular**: diferansiyel testin sayaçları, listede "ulaşılabilir" denen her hatanın gerçekten yürüdüğünü gösterir. Ulaşılabilir dediğimiz ama hiç yürümeyen bir hata, ya listede yanlıştır ya testte boşluktur — ikisi de rapora yazılır.

- [ ] **Adım 7: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| `NetTooSmall`'ı tablodan çıkar | tamlık kapısı (2) |
| `NotEnoughTokensToBuy` metnini genel bir slipaj metnine bağla | `buyExactTokensOut` hücre testi |
| `SlippageExceeded`'in iki sebebini tek metne indir | `value` yetersiz vakası testi |
| Kullanıcı reddini hata olarak göster | "reddetme kırmızı kutu değil" testi |
| `aria-live` bölgesini kaldır | ekran okuyucu duyuru testi |
| `ERC20InsufficientAllowance` parametrelerini yoksay | eksik miktar testi |
| `unknown` dalını sessizce yut | bilinmeyen selector testi |

- [ ] **Adım 8: Commit**

```bash
git commit -m "feat(web): decode every revert the user can hit, including the library-layer one"
```

**Deliverable:** iki boyutlu tamlık kapısı yeşil; `NetTooSmall` ve `ProceedsTooSmall` metinli; `SlippageExceeded`'in iki sebebi ayrı metinler; kullanıcı reddi bir hata gibi görünmüyor.

---

### Task 15: E2E — yerel zincir ve Arc testnet ayağı

İki ayak, ve **ikisi de kapıdır**. Ayrım keyfi değil: birinci ayak deterministik olduğu için her PR'da koşar, ikinci ayak Arc'a özgü olan **tek** şeyi ölçer ve o şey bu arayüzün en yüksek riskli detayıdır (K1).

**Files:**
- Create: `web/e2e/{fixtures/wallet.ts,fixtures/chain.ts,local/*.spec.ts,arc/*.spec.ts}`, `web/playwright.config.ts`
- Modify: `web/package.json`, `.github/workflows/node.yml`, `.env.example`

**Interfaces:**
- Tüketir: `@arcpad/shared/devchain`'in `startAnvil`/`deployArcpad`'i (Task 5 — **yeniden yazılmaz**), Task 4'ün vektörleri (beklenen ekran metinleri onlardan gelir), `@arcpad/db`'nin migration'ları ve Task 7'nin fixture satırları.
- Üretir: `injectedWallet(page, { account, chainId, rejectNext })` — sayfaya EIP-1193 sağlayıcısı enjekte eden Playwright fixture'ı; `e2e/fixtures/chain.ts` yalnızca `devchain`'i sarar ve `.env.e2e` yazar.

- [ ] **Adım 1: Cüzdan fixture'ı — tarayıcı eklentisi otomasyonu YOK**

`addInitScript` ile sayfaya bir EIP-1193 sağlayıcısı enjekte edilir; imzalar yerel bir viem `privateKeyToAccount` ile atılır ve `eth_sendTransaction` doğrudan RPC'ye gider. Gerekçe: eklenti otomasyonu kırılgandır ve test ettiğimiz şey MetaMask değil **bizim akışımızdır**. Sağlayıcı `eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain` ve `eth_sendTransaction`'ı destekler; wagmi'nin `injected()` connector'ı onu normal bir cüzdan olarak görür. Ayrıca **reddi de simüle eder** (`4001`) — kullanıcı reddi akışı böylece gerçek yoldan test edilir.

- [ ] **Adım 2: Yerel ayak — Postgres'e ihtiyaç DUYMAYAN yol (her PR'da)**

`globalSetup`: `anvil` başlat → `contracts/out`'tan `FeeEscrow` ve `LaunchFactory(escrow, treasury, T, V_testnet, S)` deploy et → adresleri `.env.e2e`'ye yaz → `next build && next start` (dev sunucusu değil: kullanıcının göreceği build test edilir).

**Bu ayak `DATABASE_URL` olmadan koşar ve bu bir kolaylık değil bir kanıttır.** İndexer koşmadığı için token sayfası zorunlu olarak `readTokenOverview → notFound → verifyCanonical → canonical → zincirden çiz` dalını alır — yani Task 7'nin düşüşe dayanıklılık özelliği ve Task 12'nin veritabanı-bağımsızlığı **aynı testte** ölçülür.

Senaryo dizisi (tek spec, sıralı — her adım öncekinin durumuna dayanır):

1. `/create` → isim `E2E 🚀` (bayt sayacı **10/32** göstermeli), ticker `E2E`, URI boş → launch.
2. Makbuzdan `Launched` ayrıştırılır; **sayfa o adrese gider** ve URL'deki adres olayla eşleşir (`predictAddresses` ile değil).
3. Token sayfası: `Verified launch` badge'i görünür, `progress 0%`, `Raised 0.000000 of 12.161433 USDC`, grafik **referans eğriyi** çiziyor (SVG'de iki `path` yerine bir `path` + işaretçi), `No trades yet` metni.
4. **Buy · Spend USDC** `1` → döküm satırları Task 4'ün vektörüyle **birebir** (`0.987654 / 0.009382 / 0.002962`, `~200,723,953.120761 DIFF`, `+51.32%`) → gönder → onaylanan miktarlar **olaydan**; `progress 25.3%`.
5. **Buy · Receive tokens** rezervden fazlasını iste → girdi kelepçelenir, uyarı satırı `Only 592,376,046.879238 left on the curve` (**önce** kalan rezervin bütçeden küçük olduğu iddia edilir — fixture'ın şekli iddiayı taşımasın).
6. **Sell**: `allowance == 0` iddia edilir → iki adımlı akış görünür → `Approve` → `Sell` → alınan net `0.975308` USDC (gidiş-dönüş kaybı %2,4691).
7. Kullanıcı reddi: `Buy` → sağlayıcı `4001` döner → *"Cancelled."*, **kırmızı kutu yok**, girdi korunmuş.
8. Kısma + tamamlanma: kalan rezervden büyük bir bütçeyle `Spend USDC` → `clamped` satırı, iade tutarı, `progress 100%`, sayfa `complete` durumuna geçer ve **al-sat paneli DOM'dan kaybolur**; üç giriş noktasının hepsi artık `CurveComplete()` verir (üçü de denenir).

- [ ] **Adım 3: Yerel ayak — Postgres'li yol (CI'da servis kabı)**

İkinci spec: `@arcpad/db`'nin migration'ları koşulur, Task 7'nin **sabitlenmiş** fixture satırları yazılır, sonra `/` Explore (beş sıralama, üç yaş filtresi, keyset ileri/geri), ⌘K (isim, ticker, adres, sahte adres reddi), token sayfasının işlem/holder tabloları ve dört boş durum yürünür.

`DATABASE_URL` yoksa bu spec **atlanmaz — başarısız olur**. Bir Postgres servisi CI'da bir satırdır; sessizce atlanan bir kapı, olmayan bir kapıdır.

- [ ] **Adım 4: Arc testnet ayağı — anvil'in ölçemediği şey**

Kapı mantığı, üç durum ve **hiçbiri sessiz değil**:

| Durum | Davranış |
|---|---|
| `E2E_ARC` tanımsız | spec atlanır **ve atlama rapora "açık hücre" olarak yazılır** |
| `E2E_ARC=1`, factory adresi kodsuz | **başarısız** (yapılandırma hatası, atlanacak bir şey değil) |
| `E2E_ARC=1`, factory canlı | koşar |

Ölçtüğü dört şey, hepsi Arc'a özgü:

1. **İKİ GÖRÜNÜM TEK BAKİYE (K1).** `0x3600…0000` üzerinde `balanceOf(user)` (6 decimal) okunur, `eth_getBalance` (18 decimal) okunur ve `balanceOf * 1e12 === nativeBalance` iddia edilir. Sonra sayfada **tam olarak bir** bakiye satırı olduğu ve değerinin 6 decimal görünüme eşit olduğu iddia edilir. **Bu iddia anvil'de yazılamaz** — orada `0x3600…0000` kontratı yoktur, yani iki bakiyeyi toplayan bir arayüz orada **yanlış görünmez**. Task 5'in adlandırdığı boşluk burada kapanır.
2. **Gas aynı bakiyeden ödenir.** Bir alım öncesi/sonrası native bakiye deltası `harcanan + gasUsed × effectiveGasPrice` ile eşitlenir; MAX kısayolu bakiyeyi **tam** harcamamış olur ve işlem `InsufficientFunds` almaz.
3. **Gerçek revert çözümü.** Kasten kuantum altı bir `value` ile (test yolu doğrudan `sendTransaction` kurar, arayüz üretemez) `NetTooSmall` alınır ve arayüzün onu **kütüphane katmanından** çözdüğü ölçülür.
4. **Yanlış ağ.** Sağlayıcı `eth_chainId`'yi başka bir zincire çevirir; arayüz `Switch to Arc Testnet` gösterir ve `wallet_switchEthereumChain` çağırır.

**Fonlama, ölçülmüş:** launch + bir alım + bir satış **1 USDC'nin altında** kalır ve tek bir faucet isteği (10 USDC) fazlasıyla yeter. Curve'ü **tamamlamak** `12.313451` USDC + gas gerektirir, yani **iki** faucet isteği; o senaryo `E2E_ARC_COMPLETE=1` ile ayrıca açılır ve varsayılan koşuda yoktur — sebebi kayıtlı: faucet hız sınırı bir CI kapısına bağlanamaz.

- [ ] **Adım 5: "Fixture'ın şekli yüzünden geçen test" kuralı**

Her E2E iddiası **dayandığı önkoşulu kendisi iddia eder**:

| İddia | Önce iddia edilen önkoşul |
|---|---|
| kısma satırı görünür | kalan rezerv < bütçe |
| iki adımlı satış akışı görünür | `allowance == 0` |
| `progress 25.3%` | işlemden önce `progress 0%` |
| grafik referans eğrisini çiziyor | `trade_count == 0` |
| `Verified launch` badge'i | `factory.isCanonical(token) === true` (zincirden, ayrı çağrı) |
| `complete` durumunda panel yok | işlemden önce panelin **var** olduğu |

Bu tablo bir üslup değil, bu depoda dört kez yaşanmış bir hatanın panzehiri: doğru bir assertion'ı doğru yapan şeyin örtük kalması.

- [ ] **Adım 6: CI**

`node.yml`'a iki iş: `e2e-local` (foundry + anvil + Postgres servis kabı; iki spec) ve `e2e-arc` (yalnızca `main`'e push'ta ve `E2E_ARC` secret'ı varsa; `continue-on-error` **YOK** — Faz 0'ın "iş seviyesinde `continue-on-error` başarısızlığı yeşil gösteriyor" bulgusu bu fazda tekrarlanmaz).

- [ ] **Adım 7: Mutasyonla doğrula**

| Mutant | Ölmesi gereken |
|---|---|
| Sayfayı `predictAddresses` adresine yönlendir | adım 2 (URL olayla eşleşmez) |
| Onaylanan miktarları kotadan göster | adım 4 ve 8 |
| Bakiyeye ERC-20 okumasını **ekle** (toplama) | **yalnızca Arc ayağı** — yerel ayak yeşil kalır ve bu, ayrımın neden var olduğunun kanıtıdır |
| `complete` durumunda paneli bırak | adım 8 |
| Onay miktarını sınırsız yap | adım 6 (onay tutarı iddiası) |
| `E2E_ARC` yokken spec'i sessizce geç | atlama-raporlama iddiası |

- [ ] **Adım 8: Commit**

```bash
git commit -m "test(web): end-to-end on a local chain, and the two-view balance only Arc can prove"
```

**Deliverable:** yerel ayak sekiz adımı Postgres'siz yürüyor; Postgres'li spec Explore/⌘K/tabloları kapsıyor; Arc ayağı iki-görünüm eşitliğini ölçüyor ve atlandığında bunu **söylüyor**.

---

### Task 16: Erişilebilirlik, performans ve yayın kapısı

**Files:**
- Create: `web/e2e/audit/{a11y,keyboard,perf,network}.spec.ts`, `web/test/budget.test.ts`
- Modify: `web/next.config.ts` (güvenlik başlıkları), `pnpm-workspace.yaml` (`sharp` gerekçesi güncellenir), `web/package.json`

**Interfaces:**
- Tüketir: Task 15'in `injectedWallet` fixture'ı ve yerel zincir kurulumu; Task 6'nın token'ları (kontrast kapısı orada, bu görev **çalışan sayfa** üzerinde ölçer).
- Üretir: yalnızca kapılar — yeni bir çalışma zamanı arayüzü yok. Eklenen geliştirme bağımlılıkları: `@axe-core/playwright`.

- [ ] **Adım 1: axe — dört rota, üç görünüm**

`@axe-core/playwright` ile `/`, `/token/[address]`, `/create` ve ⌘K modalı; 375×667, 768×1024, 1440×900. **Sıfır `serious`/`critical`** ihlal; `moderate` ihlaller listelenir ve her biri ya düzeltilir ya gerekçesiyle bir allowlist'e yazılır (contracts tarafındaki slither triage'ının aynı deseni).

- [ ] **Adım 2: Yalnızca klavye — launch akışının tamamı**

Tek bir spec: fareye hiç dokunmadan Tab/Shift+Tab/Enter/Esc ile ⌘K'yı aç, bir token'a git, al-sat panelini doldur, slipajı değiştir, `/create`'e git ve launch et. Odak her adımda **görünür** (`:focus-visible` halkası, `--color-accent`, 15,2:1) ve odak sırası DOM sırasıyla aynı. Modal açıkken Tab modalı **terk etmez**; kapanınca odak tetikleyiciye döner.

- [ ] **Adım 3: Performans bütçeleri — ölçülür, iddia edilmez**

| Bütçe | Değer | Ölçüm |
|---|---|---|
| Explore rota JS'i (gzip) | ≤ 250 kB | `.next/app-build-manifest.json` + gerçek dosya boyutları, `web/test/budget.test.ts` |
| Token rota JS'i (gzip) | ≤ 300 kB | aynı |
| CLS | < 0,05 | Playwright `PerformanceObserver`, iskeletten içeriğe geçişte |
| LCP (yavaşlatılmış CPU 4×) | < 2,5 s | Playwright, 100 kartlı Explore |
| Üçüncü taraf istek | **0** | ağ spec'i (aşağıda) |

Bütçe testi bir sayı **basar** ve aşıldığında mevcut değeri gösterir; sessiz bir eşik, ilk aşımda yükseltilen bir eşik olur.

- [ ] **Adım 4: Ağ yüzeyi — üçüncü taraf yok**

`network.spec.ts` tüm istekleri toplar ve host kümesinin **tam olarak** {kendi origin'imiz, yapılandırılmış RPC, yapılandırılmış IPFS gateway} olduğunu iddia eder. Font yok (kendi sunucumuzda, Task 6), analitik yok, CDN yok. Gerekçe iki katlı: bir launchpad'de üçüncü taraf script'i bir tedarik zinciri yüzeyidir, ve `next.config.ts`'e konan CSP'nin gerçekten tutup tutmadığı ancak böyle ölçülür.

CSP (`next.config.ts` `headers()`): `default-src 'self'`; `connect-src 'self' <RPC> <gateway>`; `img-src 'self' data: <gateway>`; `script-src 'self' 'unsafe-inline'` (Next'in bootstrap'ı için — `unsafe-eval` **gerekmez** ve konmaz; wagmi/viem eval kullanmaz); `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`. Ayrıca `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` ile kamera/mikrofon/geolocation kapalı. Spec: konsolda **sıfır** CSP ihlali.

- [ ] **Adım 5: Duyarlılık matrisi**

Üç görünümde ekran görüntüsü karşılaştırması değil, **davranış** iddiaları: 375px'te token sayfası tek kolon ve al-sat paneli **ilk** (grafikten önce — telefonda niyet işlem yapmaktır), tablolar kart düzenine döner, yatay kaydırma **yok** (`document.scrollingElement.scrollWidth === clientWidth` her rotada). 1440px'te Explore beş kolon.

- [ ] **Adım 6: Commit**

```bash
git commit -m "test(web): a11y, budget and third-party-request gates"
```

**Deliverable:** axe üç görünümde sıfır serious/critical; klavye-yalnız launch akışı yeşil; beş bütçe ölçülü; üçüncü taraf istek sayısı sıfır.

---

## Faz 4 tamamlanma ölçütü

- [ ] `pnpm -r test`, `pnpm -r typecheck`, `pnpm run lint`, `pnpm run fmt:check` temiz
- [ ] `pnpm --filter @arcpad/web build` temiz; `preflight` yapılandırılmış bir adres defterinde dört iddiayı geçiyor
- [ ] `abi-parity` işi yeşil **ve** `LaunchToken`'a bir fonksiyon eklendiğinde kırıldığı ölçüldü
- [ ] `chain-differential` işi: ≥300 vaka, üç giriş noktası, **dokuz kapsam sayacının hepsi > 0**
- [ ] `e2e-local`: sekiz adımlı zincir senaryosu Postgres'siz, Explore/⌘K senaryosu Postgres'li
- [ ] `e2e-arc`: iki-görünüm bakiye eşitliği ölçülü — **ya da** atlandığı rapora açık hücre olarak yazılı
- [ ] Kontrast kapısı dokuz çifti ölçüyor; birincil butonun eski (beyaz metinli) hâli kırmızı
- [ ] Hata tablosunun iki boyutlu tamlık kapısı yeşil; `NetTooSmall` **metinli**
- [ ] `useBalance` yalnızca `web/lib/balance.ts`'te; ikinci bir import lint'i kırıyor (ölçüldü)
- [ ] `resolveMetadata` izin listesi dışındaki bir `uri` için **hiç fetch yapmıyor** (çağrı sayısı `0` ölçüldü)
- [ ] Al-sat paneli `@arcpad/db`'yi import etmiyor ve veritabanı sahte-hata verirken işlem gönderiyor
- [ ] `5042002` ve Arc hostları yalnızca `packages/shared/src/chain.ts`'te (ölçüldü)
- [ ] Her görevin raporunda en az bir mutasyon ve onu öldüren testin adı; öldürmeyen mutasyonlar **boşluk** olarak yazılı
- [ ] `contracts/` **hiç değişmedi** (`git diff --stat main -- contracts` boş)

## Faz 5'e devreden

- **`/analytics` ve `/profile/[address]`** — `getClaimableFees` / `listCreatorEarningsByLaunch` Faz 3'te hazır; `protocol_stats_daily` hâlâ yok (aynı zaman-kovası kararı).
- **`FeeEscrow.claim` arayüzü** — çözücü hatalarını (`NothingToClaim`, `TransferFailed`) bugünden tanıyor, ekranı Faz 5'in. **Kısıt kaydı:** `claim` izinsizdir ve alıcının `receive()`'i üçüncü bir tarafın seçtiği anda çalışır (`FeeEscrow` kısıt 2); arayüz "claim" butonunu **başkası için** de göstermeye karar verirse bu kısıt tekrar okunmalıdır.
- **Havuz sonrası işlem** — Faz 2 `graduate()`/`Graduated` getirdiğinde: Task 10'un `Lifecycle` tipi üçüncü dalı **hazır** tutuyor, Explore'un `CompleteSection`'ı ikiye ayrılacak, `trades.source = 'pool'` satırları aynı tabloda görünecek (Faz 3 kolonu bugünden açtı).
- **Grafik kovası ve `candles`** — bu faz grafiği `trades`'ten blok ekseninde üretiyor. `candles` tablosu geldiğinde `CurveChart`'ın veri kaynağı değişir, çizimi değişmez.
- **Metadata'nın indexer'da çözülmesi** — `launches.image_url` + `launches.description` (çözülmüş, doğrulanmış, sanitize edilmiş). Bugün Task 7'nin çözücüsü istek başına ve önbellekli çalışıyor; kolonlar geldiğinde Explore hiç gateway'e çıkmaz ve SSRF yüzeyi tek bir sürece (indexer) daralır.
- **Chat (Faz 6), limit emirler + Orders sekmesi (Faz 7)** — `TradePanel`'in sekme şeridi bugün tek sekme çiziyor; ikisi eklendiğinde şerit görünür hâle gelir.
- **Açık tema** — `color-scheme: dark` bugünden bildirildi; ikinci palet ayrı bir görev.
- **`web/package.json`'da `"type": "module"` eksikliği** — Faz 0'dan devrediliyor, bu fazda da kapanmadı (Next için idiyomatik; tek paketler-arası sapma).

## Kurulamayanlar — bu plan yazılırken doğrulanamayan şeyler

Her biri bir görevin içinde "çalışma zamanında ölç" olarak ele alınıyor; hiçbiri bir sabite gömülmüyor.

1. **Arc'ta bir işlemin gas maliyeti.** `estimateGas` × `estimateFeesPerGas` çalışma zamanında okunur (Task 12, Adım 4); tahmin başarısız olursa MAX **devre dışı** kalır. Sihirli bir gas payı sabiti konmadı, çünkü ölçülemedi.
2. **Kontratların Arc testnet adresleri.** Deploy Faz 1d'dedir ve Faz 2'nin graduation yüzeyi `BondingCurve`'ün creation code'unu değiştireceği için **her curve ve token adresi** o gün kayar. Bu yüzden adres defteri env'den gelir ve boş bırakılır; `preflight` yapılandırılmamış durumu ayrı bir çıkış koduyla söyler. **Arc ayağının E2E'si bu deploy'a bağlıdır** ve bu plan onu bir kapı olarak değil, adı konmuş bir bağımlılık olarak taşır.
3. **`graduate()`'in nihai ABI'si.** Tasarım incelemeden geçti (`graduate()` `0xd3618cca`, `graduated()` `0xe7c2b772`, `Graduated` topic0 `0x18a5…5c9d`) ama bu dalda yok. Task 10 üçüncü yaşam döngüsü dalını fixture'la hazırlar; ABI geldiğinde parity testi onu **zorunlu** kılar.
4. **Arc'ın blocklist'inin sözleşme adreslerine uygulanıp uygulanmadığı.** Graduation tasarımı da bunu açık bırakmış. Arayüz açısından sonucu: `PayoutFailed`/`RefundFailed` metinleri "cüzdanınız alamadı" der ve sebebi **iddia etmez**.
5. **IPFS gateway seçimi ve pinning sağlayıcısı.** Kimlik bilgisi gerektirir; Task 13 sağlayıcıyı bir arayüzün arkasına koyar ve yapılandırılmamışken URI yolunu her zaman çalışır bırakır.
6. **Arc'ın gerçek blok süresinin sabitliği.** `BLOCKS_PER_SECOND = 1000/350` tek bir sabittedir ve yorumunda "blok süresi değişirse burası değişir" yazar; grafik aralık pill'leri ondan türer.
7. **Faz 3'ün `@arcpad/db` paketinin nihai imzaları.** Plan hizalandı (`SORTS`, yedi sorgu, `token_overview` alanları) ama paket henüz yazılmadı; Task 7 iki ekleme yapıyor ve imza kayarsa orası kırılır — bilinçli olarak, sessizce uyum sağlamak yerine.
