# arcpad Faz 3 — Indexer ve okuma modeli

> **Ajan çalışanlar için:** ZORUNLU ALT BECERİ: Bu planı görev görev uygulamak için `superpowers:subagent-driven-development` kullanın. Adımlar takip için checkbox (`- [ ]`) sözdizimi kullanır.

**Hedef:** Faz 1c'nin teslim ettiği dört kontratın yayınladığı beş olayı, frontend'in ihtiyaç duyduğu okuma modeline çevirmek. Zincirden okunan her satır **kanonikliği doğrulanmış** bir launch'a ait olur; süreç her an ölebilir ve aynı yerden devam edebilir; aynı aralık iki kez işlendiğinde veritabanı **birebir aynı** kalır.

**Mimari:** Tek TypeScript süreci. `finalized` etiketinden blok aralığı çeker, aralık başına **tek** Postgres transaction'ı yazar, imleci aynı transaction içinde ilerletir. Şema iki tüketicilidir (indexer yazar, `web` okur — spec §6.3 arada API katmanı yasaklar), bu yüzden şema ve tipli sorgular yeni bir workspace paketinde (`@arcpad/db`) durur.

**Teknoloji yığını:** TypeScript 5.9.3, viem 2.55.8, `pg` 8.22.0, Vitest 4.1.10, Postgres 17. Zincir: Arc L1 (chainId 5042002), native gas varlığı USDC.

---

## Bu plan spec §6'ya değil KONTRATLARA karşı yazıldı

Spec §6.1 ve §6.2 kontratlar var olmadan önce yazıldı. Aşağıdakiler **ölçülerek** bayat bulundu; her biri bu planda düzeltilmiş hâliyle geçer.

| Spec ifadesi | Gerçek (derlenmiş ABI'den okundu) |
|---|---|
| §6.1 "Dinlenen olaylar: `LaunchCreated`" | `Launched(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string uri, bytes32 salt)` |
| §6.1 "`Bought`, `Sold`" — **iki** olay | **Tek** olay: `Trade(address indexed trader, bool isBuy, uint256 tokenAmount, uint256 quoteAmount, uint256 protocolFee, uint256 creatorFee, uint256 virtualTokenReserves, uint256 virtualQuoteReserves, uint256 realTokenReserves, uint256 realQuoteReserves)`. Yön `isBuy` alanındadır ve **indekssizdir** — yön topic'ten filtrelenemez. |
| §6.1 "`Graduated`" | `Completed(address indexed token, uint256 realQuoteReserves, uint256 poolSeedSupply)`. `Graduated` Faz 2'nin havuz olayıdır ve **henüz yoktur**. |
| §6.1 "graduation sonrası `PoolManager.Swap`" | Faz 2 teslim edilmedi; bu fazda dinlenecek havuz yoktur. Kapsam dışı. |
| §6.1 imleç "son işlenen bloktan `finalized`'e" | Doğru, ama `eth_getLogs`'un **10.000 blok** aralık ve **20.000 sonuç** sınırları spec'te hiç geçmiyor. Ölçüldü; §Global Kısıtlar'da. |
| §6.1 EIP-7708 tuzağı: "Holder tablosu doldurulurken emitter adresi filtrelenmeli" | Doğru ama **yetersiz**: filtre `eth_getLogs`'un `address` parametresinde olmalı, yanıt geldikten sonra değil. Aksi halde ölçülen 11.692 log/1.000 blok hacmi süreçten geçer. Ayrıca tuzak spec'in anlattığından **daha geniştir**: bir ERC-20 USDC `transfer()` çağrısı **iki** log üretir (ölçüldü, §Global Kısıtlar). |
| §6.2 `tokens` tablosu "arz parametreleri, faz, pool id" | `phase` makinesi (`NotGraduated/Swept/PoolCreated/Rescued`, §5.4) kontratta **yok**; `BondingCurve`'ün tek durumu `bool complete`. `pool id` Faz 2'dedir. Bu fazda `complete` + `completed_seq`. |
| §6.2 arz parametrelerinin **token başına** saklanması | Parametreler (`V`, `T`, `S`) **factory'nin immutable'larıdır** (`LaunchFactory.sol:171-179`), launch başına değil: factory ürettiği her curve'e aynısını geçirir. Token başına kopyalamak, aynı sayının launch sayısı kadar kaynağı olması demektir. Bu planda `deployment` tekil tablosunda durur ve **zincirden** okunur. |
| §6.2 `trades` tablosunda `fiyat` ve `is_dev` kolonları | İkisi de **türetilir, saklanmaz**. Gerekçe Task 7'de: fiyat `quote_amount_wei / token_amount_tok`'tur ve yazma anında yuvarlamak frontend'in geri alamayacağı bir karar verir; `is_dev` creator değiştirilebilir olursa **noktasal bir olgudur** ve saklanmış bir boolean o gün yanlış olur. |
| §6.2 `candles`, `protocol_stats_daily`, `chat_messages`, `limit_orders` | Kapsam dışı — gerekçeler §Kapsam dışı. |
| §6.2 `fee_balances` "`recipient → claimable`, tek varlık native USDC" | **Doğru ve güncel.** §5.8/§6.1'in eski `(recipient, asset)` anahtarlı, `FeeAccrued`/`FeeClaimed` yayan escrow tarifi zaten düzeltilmiş; teslim edilen kontrat `Deposited(address indexed recipient, address indexed from, uint256 amount)` / `Claimed(address indexed recipient, uint256 amount)` yayar. Bu satır bayat **değildir**. |
| §6.3 "Recent buys sıralaması: `last_buy_at` üzerinde azalan" | **Değiştirildi.** Blok timestamp'leri artmayabilir — ölçüldü: 400 ardışık blok çiftinin **197'si (%49,1)** aynı timestamp'i taşıyor. Zamana göre sıralama yarı yarıya keyfi ve **kararsızdır**; sayfalama sınırında satır tekrarı/kaybı verir. Karar ve gerekçe Task 10'da. |
| §6.1 provenance | Spec `isCanonical`'dan **hiç söz etmiyor**. Bu bir bayatlık değil, **boşluktur**: doğrulama olmadan sahte bir token gerçek bir launch gibi listelenir. Task 6 bunu kapatır. |

**Bayat OLMAYAN, ölçerek doğrulanan spec ifadeleri:** §3.1'in chainId'si ve USDC ERC-20 adresi; §3.3'ün "blok timestamp'leri artmayan olabilir" cümlesi; §3.3'ün EIP-7708 cümlesinin çekirdeği; §6.1'in "reorg yok, geri alma mantığı yazılmaz" kararı; §6.1'in "blok grubu başına tek transaction" kuralı.

---

## Kapsam dışı, ve neden

- **`candles` / OHLCV.** `trades` tablosu candle'ları sonradan geriye dönük üretmek için gereken her şeyi (blok, log index, miktarlar, rezervler) taşır, yani ertelemek veri kaybettirmez. Ertelenmesinin sebebi: dakika kovalarına ayırmak **zaman** ekseninde bir karar gerektirir ve Arc'ta blokların yarısı aynı timestamp'i taşır (ölçüldü) — "1 dakikalık kova" tanımı ya timestamp'e ya blok numarasına oturur ve ikisi farklı grafik verir. Bu kendi görevini hak eden bir tasarım kararıdır, indexer'ın ingest yoluna sıkıştırılamaz.
- **`protocol_stats_daily`.** Aynı zaman-kovası sorunu, artı günlük tekil dev sayısı için `launches` üzerinden ayrı bir toplama. `fee_events.from_addr` curve adresini taşıdığı için protokol geliri sonradan tam olarak türetilebilir (Task 9); bugün üretilmesi gereken bir ekran yok (§7.1'de `/analytics` Faz 5'tir).
- **`chat_messages`, `limit_orders`.** İkisi de indexer'ın **yazmadığı** tablolardır — biri `web`'in API route'undan, diğeri keeper'dan yazılır (spec §6.3, §8). Bu dikey onları içermez.
- **`PoolManager.Swap` ve graduation sonrası her şey.** Faz 2 teslim edilmedi; dinlenecek havuz yok. `trades.source` kolonu bugünden `CHECK (source IN ('curve','pool'))` ile açılır ki Faz 2 migration'sız girsin — spec §6.2'nin "fiyat geçmişi kopmasın" gerekçesi budur.
- **Frontend sayfaları.** Bu dikey veriyi ve tipli sorguları teslim eder; `web/app/token/[address]/page.tsx` Faz 3'ün öteki yarısıdır.
- **WebSocket / `eth_subscribe`.** Yalnızca polling. Gerekçe: 350ms blok süresinde 1 saniyelik poll en fazla ~3 blok geride kalır, ve bir abonelik yeniden bağlanma + boşluk kurtarma arızası ekler — ki imleç o sorunu **zaten** çözüyor. İki mekanizma tutmak, ikincisinin hiç test edilmemesi demektir.
- **Reorg / geri alma.** Arc'ta deterministik finality vardır. Bunun yerine `removed: true` taşıyan bir log **hata** sayılır ve süreci durdurur (Task 5) — çünkü Arc'ta imkânsız olan bir şeyi görmek, RPC'nin Arc olmadığının kanıtıdır.
- **Çok varlıklı ücret bakiyeleri.** `FeeEscrow` tek varlıklıdır (native USDC). `_uusdc` biçiminde 6 decimal bir kolon şemada **hiç yoktur** ve bunu bir test uygular (Task 3).

---

## Global Kısıtlar

Bu bölüm her görevin gereksinimlerine **örtük olarak dâhildir**. Buradaki her sayı ölçülmüştür; ölçüm komutu ve tarihi yanında yazılıdır (`https://rpc.testnet.arc.network`, 2026-07-30).

### Olayların tam kimliği (derlenmiş ABI'den, `contracts/out/**`)

`topic0` değerleri `cast keccak` ile üretildi, spec'ten kopyalanmadı:

| Olay | Yayan | `topic0` |
|---|---|---|
| `Launched(address,address,address,string,string,string,bytes32)` | `LaunchFactory` | `0x18335d7ceae0e8415362afcfc11b534b5bfbf6b27c59420bf3d8e783b39de1c7` |
| `Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)` | `BondingCurve` | `0x733bb99acb17010119efa3b694a341a4be53fb2e7ea4800188314660780de278` |
| `Completed(address,uint256,uint256)` | `BondingCurve` | `0x5f364ec8cbeb22a7121d682d8fbbf96032bfc28c76d26628d8562dfbb285b50a` |
| `Deposited(address,address,uint256)` | `FeeEscrow` | `0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7` |
| `Claimed(address,uint256)` | `FeeEscrow` | `0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a` |
| `Transfer(address,address,uint256)` | `LaunchToken` (ve Arc'ın sistem adresi — aşağı) | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |

**Bu yüzey `contracts/test/Surface.t.sol` tarafından iki yönlü tam eşitlikle sabitlenmiştir** ve indekslenmiş parametre **adları** da pinlidir (satır 402, 456-457, 575-577, 658). Yani `indexed` bir alanı indekssiz yapmak veya bir olayı yeniden adlandırmak kontrat tarafında kırmızıya döner. Indexer buna **güvenir** ama **bel bağlamaz**: Task 1 aynı kümeyi TypeScript tarafında da iki yönlü olarak sabitler.

**`Trade` token adresini TAŞIMAZ.** Kimlik `log.address` = curve adresidir. Curve→token eşlemesi yalnızca `Launched`'dan gelir. Bu, Task 5'in iki fazlı çekişini zorunlu kılan iki sebepten biridir.

**`Trade` dört rezervin dördünü de taşır.** Bilinçlidir (`BondingCurve.sol:133-135`) ve pump.fun'ın `TradeEvent`'i de aynısını yapar. Indexer işlem sonrası durumu **zincire tekrar sormadan** kurar: `curve_state` her `Trade`'de olaydaki dört değerle **mutlak olarak** yazılır, artımlı değil.

### Arc RPC'sinin ölçülmüş sınırları

```
eth_getLogs aralık sınırı  : 10.000 blok
  span 10.000  -> ok
  span 50.000  -> {"code":-32012,"message":"requested range too large"}
  span 100.000 -> {"code":-32614,"message":"eth_getLogs is limited to a 10,000 range"}
eth_getLogs sonuç sınırı   : 20.000 log
  filtresiz 1.000 blok -> {"code":-32602,
      "message":"query exceeds max results 20000, retry with the range 54325373-54326275"}
  ^ ONERILEN ARALIK YANITIN ICINDE. Bolme icin tahmin gerekmez.
address dizisi             : 1.000 giris kabul edildi (50, 500, 1.000 denendi, hepsi ok)
loglarda blockTimestamp    : VAR. eth_getLogs her log icin "blockTimestamp" dondurur
                             (ornek: "0x6a6a7f0a"). Blok basina ek cagri GEREKMEZ.
```

Üç ayrı hata kodu vardır ve **üçü de ele alınmalıdır** — `-32012`'nin mesajı sınırı söylemez, `-32602`'nin mesajı ise doğru aralığı söyler. Tek bir kodu yakalayan bir retry yolu, öbür ikisinde imleci ilerletmeden sonsuz döner.

`MAX_SPAN = 1_000`. Gerekçe: RPC'nin **kendi** önerdiği yeniden deneme aralığı filtresiz bir sorgu için 903 bloktu (yukarıdaki mesaj), yani 1.000 zincirin kendi log yoğunluğuyla aynı mertebede; bizim adres-filtreli sorgularımız bunun kesinlikle altındadır. Üst sınır `ARC_GETLOGS_MAX_RANGE = 10_000` ve başlangıçta iddia edilir.

### EIP-7708: ölçülmüş çifte sayım tuzağı

```
tx 0xc9004d69d332f9f46c5e67adc0a9e83adb17bb8b88ea0c9c959cf8cd16f74611  (blok 54.325.469)
  to    = 0x3600000000000000000000000000000000000000
  value = 0
  input = transfer(0x1208a3ba9632a96703639f1ac06a05e588c80e12, 1_768_280)
  -> logIndex 0  emitter 0xfffffffffffffffffffffffffffffffffffffffe
                 data 1_768_280_000_000_000_000        (18 decimal gorunum)
  -> logIndex 1  emitter 0x3600000000000000000000000000000000000000
                 data 1_768_280                        (6 decimal gorunum)
  AYNI HAREKET. IKI LOG. IKI GORUNUM. Toplamak 2x sayar.

tx 0xcdb86510ba3d32b819dfefda584335df80744cdd6ad6ee029b3dc70b0f8ae093  (blok 54.326.136)
  input = 0x   value = 85_615_523_834_970_299
  -> TEK log, emitter 0xfffffffffffffffffffffffffffffffffffffffe, 18 decimal
  0x3600... HIC LOG YAYMADI.
```

Yani `0xfff…ffe` **her** native hareketi yayar; `0x3600…0000` yalnızca ERC-20 giriş noktası kullanıldığında ek olarak yayar. Gaz ödemesi loglanmıyor (düz transfer tam olarak bir log üretti).

**arcpad için sonucu:** tek bir `buyExactTokensOut` işlemi native USDC'yi en az üç kez hareket ettirir (alıcı→curve, curve→escrow ×1–2, curve→alıcı iade), yani **her ticaret işlemi birden fazla `0xfff…ffe` `Transfer` logu içerir** — ve aynı işlemde `LaunchToken`'dan bir tane gerçek `Transfer` vardır. "Bu işlemdeki tüm `Transfer` logları" diye toplayan bir holder muhasebesi kesin olarak yanlış sayar.

**Kaçınma yolu, tam olarak:**
1. `Transfer` topic'i **asla** `address` filtresi olmadan sorulmaz. Filtre kabul edilmiş `launches.token` kümesidir, çağrı başına ≤500 adres (1.000 kabul edildiği ölçüldü, yarısında duruyoruz).
2. `packages/shared` iki yasaklı emitter sabiti verir: `EIP7708_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe'` ve mevcut `USDC_ERC20_ADDRESS`. Log çözme yolunda **sert bir iddia**: emitter bu ikisinden biriyse `throw`. Bu dala düşmek, (1)'in düştüğü anlamına gelir; sessizce atlamak tuzağı geri getirir.
3. Bütün `Transfer`'ların yakalandığını kanıtlayan **tek** kontrol: `SUM(holders.balance_tok) = 1e27` her token için. Bir `Transfer` düşürülürse bu eşitlik kırılır. Task 8 bunu her replay sonunda iddia eder.

### USDC'nin iki görünümü ve kolon adlandırması

Arc'ta native varlık USDC'nin **kendisidir**: 18 decimal native görünüm ve `0x3600…0000`'daki 6 decimal ERC-20 görünüm **tek havuzun iki okumasıdır**, asla iki varlık değil ve asla toplanmaz (spec §3.2). arcpad **yalnızca native görünümü** saklar.

Adlandırma bunu **uygular**, tavsiye etmez:

| Sonek | Anlam | Tip |
|---|---|---|
| `_wei` | 18 decimal native USDC | `numeric(78,0)` |
| `_tok` | 18 decimal `LaunchToken` taban birimi | `numeric(78,0)` |
| `_ppm` | milyonda pay (0–1.000.000) | `integer` |
| `_bps` | on binde pay | `integer` |
| `_seq` | `event_seq` (aşağı) | `bigint` |
| `_at` | zaman — **yalnızca gösterim ve pencere**, asla sıralama | `timestamptz` |

`_wei` ile `_tok` ikisi de 1e18 ölçekli olmasına rağmen **ayrıdır**, çünkü toplanmaları bir kategori hatasıdır (fiyat `wei/tok`'tur). Yasaklı: `_usdc`, `_uusdc`, ve sonekisiz `amount` / `balance` / `value` / `price`. Task 3 bunu `information_schema` üzerinden okuyan bir testle kapatır — 6 decimal bir kolon şemaya **giremez**.

### `event_seq` — tek anahtar, tek sıra

```
event_seq = block_number * 1048576 + log_index          (yani block_number << 20 | log_index)
```

- `log_index` blok kapsamındadır (ölçüldü: tek loglu işlemlerde `logIndex` 0x7 ve 0x22 çıktı — yani blok içi indeks).
- 20 bit genişliğin türetmesi: Arc blok gaz limiti ölçüldü, `gasLimit = 0x1c9c380 = 30.000.000`. En ucuz log opcode'u `LOG0` 375 gazdır, yani bir blokta **en fazla 80.000** log olabilir. `2^20 = 1.048.576`, tavanın 13 katı. Kodlamanın çakışması yapısal olarak imkânsızdır ve `CHECK (log_index < 1048576)` bunu sabitler.
- Taşma payı: `bigint` tavanı 9.223.372.036.854.775.807; `/ 1048576` = 8.796.093.022.207 blok. 350ms blokla ≈ **97.600 yıl**.
- Spec §6.1 idempotency anahtarını `(tx_hash, log_index)` diye yazıyor. **Yanlış değil, yetersiz**: tekildir ama bir **sıra** vermez. `event_seq` hem tekildir hem sıralanabilir, bu yüzden birincil anahtar odur; `(tx_hash, log_index)` üzerinde ayrı bir UNIQUE eklenmez (aynı bilgiyi ikinci kez indekslerdi).

### Diğerleri

- Postgres **17**. Tüm uint256 kolonları `numeric(78,0)` (`2^256 − 1` 78 hanelidir; `bigint` taşar).
- Adresler ve hash'ler `text`, **küçük harf**, `CHECK (col ~ '^0x[0-9a-f]{40}$')` / `{64}`. Gerekçe: `bytea` daha kompakt ama psql'de okunamaz hâle gelir; checksum-büyük/küçük harf belirsizliği bir **doğruluk** tehlikesidir ve onu kapatan şey CHECK'in kendisidir, tip değil.
- `prettier`: `semi: false`, `singleQuote: true`, `printWidth: 100`. `eslint` locale'siz `Intl.NumberFormat`'ı reddeder.
- Kod yorumları Türkçe, **diakritiksiz** (mevcut `src/` konvansiyonu). Plan ve doküman metni diakritikli.
- `pnpm -r test`, `pnpm -r typecheck`, `pnpm run lint`, `pnpm run fmt:check` temiz olmalı.
- **`contracts/src/` bu fazda DEĞİŞMEZ.** Tek istisna Task 4'ün `contracts/test/FixtureGen.t.sol`'ü ve `foundry.toml`'a **eklenen** tek bir yazma izni satırıdır.

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `packages/shared/src/arc.ts` | **yeni** — EIP-7708 sistem emitter'ı, `eth_getLogs` sınırları, yasaklı emitter kümesi |
| `packages/shared/src/artifacts.generated.ts` | **yeni** — üretilmiş: ABI'ler + `LaunchToken` creationCode |
| `packages/shared/scripts/sync-artifacts.ts` | **yeni** — `contracts/out/**`'tan üretici |
| `packages/shared/test/artifacts.test.ts` | **yeni** — ABI + bytecode parity kapısı, olay kümesi iki yönlü eşitlik |
| `packages/shared/src/index.ts` | **değişir** — yeni export'lar |
| `indexer/src/cursor.ts` | **değişir** — `maxSpan` koruması, üst sınır, tek kaynaklı head |
| `indexer/test/cursor.test.ts` | **değişir** |
| `packages/db/{package.json,tsconfig.json,vitest.config.ts}` | **yeni** — workspace paketi |
| `packages/db/migrations/00{1..6}_*.sql` | **yeni** — şema |
| `packages/db/src/{index,pool,migrate,seq,hex,queries}.ts` | **yeni** |
| `packages/db/test/{migrate,naming,seq,ordering,queries}.test.ts` | **yeni** |
| `contracts/test/FixtureGen.t.sol` | **yeni** — gerçek yürütmeden gerçek log üretir |
| `contracts/foundry.toml` | **değişir** — YALNIZCA `./fixtures` yazma izni, iki profile de |
| `contracts/fixtures/*.json` | **yeni** — üretilmiş, commit'lenir, drift kapısı |
| `indexer/src/logs.ts` | **yeni** — çekme katmanı, RPC hata taksonomisi, 7708 duvarı |
| `indexer/src/admit.ts` | **yeni** — launch kabulü, CREATE2 yeniden türetmesi |
| `indexer/src/apply/{trade,transfer,fees}.ts` | **yeni** — olay uygulayıcıları |
| `indexer/src/run.ts` | **yeni** — döngü, atomik aralık, hata politikası |
| `indexer/src/index.ts` | **değişir** — demo yolu yerine `run` |
| `indexer/test/*.test.ts` | **yeni** |
| `indexer/test/integration/live.test.ts` | **yeni** — canlı Arc testnet |
| `.github/workflows/node.yml` | **değişir** — Postgres servisi |
| `docs/plans/phase-3-carry-forward.md` | **yeni** — kapanışta |

---

### Task 1: `packages/shared` — zincir sabitleri ve tek artifact kaynağı

Faz 0'ın devir listesi (`docs/plans/phase-0-carry-forward.md`, satır 18 ve 20) iki borç bırakmış: EIP-7708 sistem emitter adresi `packages/shared`'a konmamış, ve ABI-parity testi hiç yazılmamış. İkisi de bu görevde kapanır, çünkü Task 5 ve Task 6 ikisine de bağımlıdır.

**Files:**
- Create: `packages/shared/src/arc.ts`
- Create: `packages/shared/scripts/sync-artifacts.ts`
- Create: `packages/shared/src/artifacts.generated.ts` (üretilir)
- Create: `packages/shared/test/artifacts.test.ts`
- Create: `packages/shared/test/arc.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json` (`"sync-artifacts"` script'i)

**Interfaces:**
- Tüketir: `contracts/out/{LaunchFactory,BondingCurve,FeeEscrow,LaunchToken}.sol/*.json` (yalnızca okuma).
- Üretir:
  - `EIP7708_SYSTEM_EMITTER: '0xfffffffffffffffffffffffffffffffffffffffe'`
  - `FORBIDDEN_TRANSFER_EMITTERS: ReadonlySet<Address>` — `{EIP7708_SYSTEM_EMITTER, USDC_ERC20_ADDRESS}`
  - `ARC_GETLOGS_MAX_RANGE = 10_000n`, `ARC_GETLOGS_MAX_RESULTS = 20_000`
  - `launchFactoryAbi`, `bondingCurveAbi`, `feeEscrowAbi`, `launchTokenAbi` — `as const`
  - `LAUNCH_TOKEN_CREATION_CODE: Hex`, `LAUNCH_TOKEN_CREATION_CODE_HASH: Hex`
  - `TOPIC0: { launched, trade, completed, deposited, claimed, transfer }`

- [ ] **Adım 1: `arc.ts`**

```ts
import type { Address } from 'viem'
import { USDC_ERC20_ADDRESS } from './chain'

/**
 * EIP-7708'in sistem adresi. Arc'ta NATIVE varligin her hareketi buradan
 * 18 decimal'lik bir `Transfer` logu yayar.
 *
 * OLCULDU (Arc testnet, 2026-07-30):
 *   tx 0xcdb86510...ae093 -- duz native transfer (input 0x, value 85615523834970299)
 *     -> TEK log, emitter 0xfff...ffe, 18 decimal. 0x3600... hic log yaymadi.
 *   tx 0xc9004d69...74611 -- USDC.transfer(0x1208...0e12, 1_768_280)
 *     -> logIndex 0: emitter 0xfff...ffe, data 1_768_280_000_000_000_000
 *     -> logIndex 1: emitter 0x3600...0000, data 1_768_280
 *     AYNI hareket, IKI log, IKI gorunum.
 *
 * Yani `0xfff...ffe` her native hareketi yayar; `0x3600...` yalnizca ERC-20
 * giris noktasi kullanildiginda EK OLARAK yayar. Ikisini toplamak tek bir
 * fonu iki kez saymaktir.
 */
export const EIP7708_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe' as const

/**
 * `Transfer` logu cozen hicbir yol bu emitterlardan gelen bir logu KABUL
 * ETMEZ. Kume halinde duruyor cunku kontrol bir `if` degil bir uyelik
 * sorgusudur: ileride Arc baska bir sistem emitter'i eklerse tek yer degisir.
 */
export const FORBIDDEN_TRANSFER_EMITTERS: ReadonlySet<Address> = new Set([
  EIP7708_SYSTEM_EMITTER,
  USDC_ERC20_ADDRESS,
])

/**
 * `eth_getLogs`'un OLCULMUS sinirlari (https://rpc.testnet.arc.network,
 * 2026-07-30). Ucu de gercek yanitlardan alindi:
 *   span 10_000  -> ok
 *   span 50_000  -> -32012 "requested range too large"
 *   span 100_000 -> -32614 "eth_getLogs is limited to a 10,000 range"
 *   filtresiz 1_000 blok -> -32602 "query exceeds max results 20000,
 *                                   retry with the range 54325373-54326275"
 */
export const ARC_GETLOGS_MAX_RANGE = 10_000n
export const ARC_GETLOGS_MAX_RESULTS = 20_000

/**
 * `eth_getLogs`'un `address` dizisinde tek cagrida gecirilecek adres sayisi.
 * 1.000 giris KABUL EDILDI (50/500/1.000 denendi, hepsi ok); yarisinda
 * duruyoruz cunku sinir belgelenmis degil, olculmustur ve degisebilir.
 */
export const ADDRESS_FILTER_CHUNK = 500
```

- [ ] **Adım 2: `sync-artifacts.ts`**

`contracts/out`'tan okur, `packages/shared/src/artifacts.generated.ts` yazar. Dosya başına `// URETILMISTIR -- elle duzenlemeyin. pnpm --filter @arcpad/shared sync-artifacts` yazar.

Kritik nokta: **yalnızca `abi` ve `LaunchToken`'ın `bytecode.object`'i** kopyalanır. `deployedBytecode` kopyalanmaz (CREATE2 türetmesi creationCode kullanır). `topic0` değerleri `viem`in `toEventSelector`'ı ile ABI'den **hesaplanır**, dosyaya literal yazılmaz — literal yazmak spec'ten kopyalamanın aynısı olurdu.

`LaunchToken` creationCode'unun sabit olmasının **ölçülmüş** ön koşulları, üretici tarafından iddia edilir ve tutmazsa üretici çöker:

```ts
// (1) Link referansi YOKTUR -> creationCode kendi kendine yeterlidir, harici
//     kutuphane adresi gomulmez. Olculdu: dort artifact'in dordunde de
//     `bytecode.linkReferences` bos.
// (2) `foundry.toml`'da `bytecode_hash = "none"` -> metadata hash'i EKLENMEZ,
//     yani creationCode makineden makineye ayni. Bu satir olmadan derleyici
//     kaynak yoluna bagli bir hash ekler ve zincir disi CREATE2 turetmesi
//     baska bir makinede sessizce yanlis adres uretir.
// (3) Immutable'lar creationCode'da DEGIL, constructor'in yazdigi DEPLOYED
//     bytecode'da durur. Olculdu: LaunchToken `deployedBytecode` 3 immutable
//     referansi tasir, `bytecode` ise 0.
if (Object.keys(artifact.bytecode.linkReferences ?? {}).length !== 0) {
  throw new Error('LaunchToken link referansi tasiyor: creationCode sabit degil')
}
```

Ölçülmüş boyutlar (üretici bunları da iddia eder, çünkü sessiz bir küçülme "yanlış artifact okundu" demektir):

| Kontrat | creationCode | deployed | `keccak256(creationCode)` |
|---|---|---|---|
| `LaunchToken` | 3.598 bayt | 2.017 | `0x3c7ca45505c038e707c0384e4c5861f15aace17f85486470a42737142f966fe4` |
| `BondingCurve` | 5.350 bayt | 4.658 | `0xb44f1933e5db5c955d32502bcca13a74469736f1a285fd3c4aeac5db0997c449` |
| `LaunchFactory` | 13.230 bayt | 12.310 | `0x3a97b1a103cfa42ef309c0a5453e66349dc03c16a410bf5544c5842065ea11f4` |
| `FeeEscrow` | 707 bayt | 681 | — |

- [ ] **Adım 3: Parity kapısı — `packages/shared/test/artifacts.test.ts`**

Üç ayrı iddia. Hiçbiri tek başına yetmez:

```ts
import { readFileSync } from 'node:fs'
import { keccak256, toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  bondingCurveAbi,
  feeEscrowAbi,
  launchFactoryAbi,
  launchTokenAbi,
  LAUNCH_TOKEN_CREATION_CODE,
  LAUNCH_TOKEN_CREATION_CODE_HASH,
  TOPIC0,
} from '../src/artifacts.generated'

const OUT = new URL('../../../contracts/out/', import.meta.url)
const read = (c: string) =>
  JSON.parse(readFileSync(new URL(`${c}.sol/${c}.json`, OUT), 'utf8'))

describe('artifact parity', () => {
  // (1) ABI ESITLIGI. Kontrat arayuzu degisip bu paket yenilenmezse CI kirilir.
  //     Spec 4'un "uc tuketici forge build ciktisina karsi dogrulanir"
  //     yukumlulugu tam olarak budur ve Faz 0'dan devretmisti.
  it.each([
    ['LaunchFactory', launchFactoryAbi],
    ['BondingCurve', bondingCurveAbi],
    ['FeeEscrow', feeEscrowAbi],
    ['LaunchToken', launchTokenAbi],
  ])('%s ABI derleme ciktisiyla birebir ayni', (name, abi) => {
    expect(abi).toEqual(read(name).abi)
  })

  // (2) BYTECODE ESITLIGI. ABI esitligi bunu KAPSAMAZ: LaunchToken'a
  //     `mint()` eklemek ABI'yi de degistirir, ama optimizer ayarini
  //     degistirmek YALNIZCA bytecode'u degistirir -- ve CREATE2 turetmesi
  //     bytecode'a bagli oldugu icin indexer o gun HER launch'i reddeder.
  it('LaunchToken creationCode derleme ciktisiyla birebir ayni', () => {
    expect(LAUNCH_TOKEN_CREATION_CODE).toBe(read('LaunchToken').bytecode.object)
    expect(LAUNCH_TOKEN_CREATION_CODE_HASH).toBe(keccak256(LAUNCH_TOKEN_CREATION_CODE))
    // Olculmus sabitler. Sessiz bir kucuIme "yanlis artifact" demektir.
    expect((LAUNCH_TOKEN_CREATION_CODE.length - 2) / 2).toBe(3598)
    expect(LAUNCH_TOKEN_CREATION_CODE_HASH).toBe(
      '0x3c7ca45505c038e707c0384e4c5861f15aace17f85486470a42737142f966fe4',
    )
  })

  // (3) OLAY KUMESI IKI YONLU TAM ESITLIK. Bu, Surface.t.sol'un dersinin
  //     TypeScript tarafina tasinmasidir: bir isim listesi yalnizca
  //     "bekledigim seyler duruyor mu" diye sorar; butun mesele EKLENMIS bir
  //     olayi gormektir. Yeni bir olay (ornegin `CreatorUpdated`) eklendigi
  //     gun bu test kirilir ve indexer'in onu ISLEMEYE zorlanmasi saglanir --
  //     sessizce yok saymasi degil. Task 6/7'nin creator kararinin
  //     CALISTIRILABILIR yarisi budur.
  it('dinlenen olay kumesi ABI ile iki yonlu ayni', () => {
    const eventsOf = (abi: readonly unknown[]) =>
      (abi as { type: string; name?: string }[])
        .filter((e) => e.type === 'event')
        .map((e) => e.name!)
        .sort()

    expect(eventsOf(launchFactoryAbi)).toEqual(['Launched'])
    expect(eventsOf(bondingCurveAbi)).toEqual(['Completed', 'Trade'])
    expect(eventsOf(feeEscrowAbi)).toEqual(['Claimed', 'Deposited'])
    expect(eventsOf(launchTokenAbi)).toEqual(['Approval', 'Transfer'])
  })

  // (4) topic0 degerleri ABI'den HESAPLANIR, literal degil. Yine de burada
  //     olculmus literallere karsi tutuluyor: hesaplama dogru ama YANLIS
  //     IMZAYI hesaplayabilir (ornegin bir parametre tipi degisirse), ve o
  //     zaman (1) de kirilir ama BU test hangi olayin kaydigini soyler.
  it('topic0 degerleri olculmus hash lerle ortusur', () => {
    expect(TOPIC0.launched).toBe(
      '0x18335d7ceae0e8415362afcfc11b534b5bfbf6b27c59420bf3d8e783b39de1c7',
    )
    expect(TOPIC0.trade).toBe('0x733bb99acb17010119efa3b694a341a4be53fb2e7ea4800188314660780de278')
    expect(TOPIC0.completed).toBe(
      '0x5f364ec8cbeb22a7121d682d8fbbf96032bfc28c76d26628d8562dfbb285b50a',
    )
    expect(TOPIC0.deposited).toBe(
      '0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7',
    )
    expect(TOPIC0.claimed).toBe('0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a')
    expect(TOPIC0.transfer).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
    // Uretimin kendisi de kontrol edilir: literal degil, ABI'den geliyor.
    expect(TOPIC0.trade).toBe(
      toEventSelector(
        'Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
      ),
    )
  })
})
```

`packages/shared/test/arc.test.ts`:

```ts
it('yasakli emitter kumesi tam olarak iki adres tasir', () => {
  expect([...FORBIDDEN_TRANSFER_EMITTERS].sort()).toEqual(
    ['0x3600000000000000000000000000000000000000', '0xfffffffffffffffffffffffffffffffffffffffe'].sort(),
  )
})

// Diller-arasi sabit kontrolu (Faz 0 devir listesi, satir 19): 5042002 ve
// 0x3600...0000 bu depoda dort ayri yerde yazili ve hicbiri digerini kontrol
// etmiyordu. Bu test ikisini .env.example'dan da okuyup esitligi iddia eder.
it('ARC_TESTNET_CHAIN_ID ile .env.example ortusur', () => {
  const env = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
  expect(env).toContain(`ARC_CHAIN_ID=${ARC_TESTNET_CHAIN_ID}`)
})
```

- [ ] **Adım 4: Barrel'ı gerçekten kullan**

Faz 0 devir listesi satır 35: `packages/shared/src/index.ts` barrel'ı hiçbir test tarafından kullanılmıyor, bir export düşse 14 test yeşil kalır. Bu görev yeni export ekliyor, yani boşluk büyüyor. Kapat:

```ts
// packages/shared/test/index.test.ts
import * as barrel from '../src/index'
it('barrel her public sembolu disari verir', () => {
  expect(Object.keys(barrel).sort()).toEqual([
    'ADDRESS_FILTER_CHUNK', 'ARC_GETLOGS_MAX_RANGE', 'ARC_GETLOGS_MAX_RESULTS',
    'ARC_TESTNET_CHAIN_ID', 'EIP7708_SYSTEM_EMITTER', 'ERC20_USDC_DECIMALS',
    'FORBIDDEN_TRANSFER_EMITTERS', 'LAUNCH_TOKEN_CREATION_CODE',
    'LAUNCH_TOKEN_CREATION_CODE_HASH', 'NATIVE_USDC_DECIMALS', 'TOPIC0',
    'USDC_ERC20_ADDRESS', 'arcTestnet', 'assertArcChain', 'bondingCurveAbi',
    'createArcClient', 'erc20ToNative', 'feeEscrowAbi', 'formatUsdc',
    'launchFactoryAbi', 'launchTokenAbi', 'nativeToErc20',
  ])
})
```

- [ ] **Adım 5: Commit**

```bash
pnpm --filter @arcpad/shared sync-artifacts
pnpm -r test && pnpm -r typecheck && pnpm run fmt:check && pnpm run lint
git add packages/shared
git commit -m "feat(shared): pin the contract surface and Arc's log-layer limits in one place"
```

**Deliverable:** `pnpm --filter @arcpad/shared test` yeşil. `contracts/src/LaunchToken.sol`'e bir fonksiyon eklenip `forge build` koşturulduğunda parity testi kırılır (Adım 3'ün ölçülmesi gereken kanıtı: raporda hangi iddianın kırıldığı yazılır).

---

### Task 2: `indexer/src/cursor.ts` — aralık ve head sertleştirmesi

Mevcut `nextRange` doğru ama iki açık hücresi var (Faz 0 devir listesi satır 33–34) ve ikisi de Faz 3'te zararlı hâle geliyor.

**Files:**
- Modify: `indexer/src/cursor.ts`
- Modify: `indexer/test/cursor.test.ts`

**Interfaces:**
- Tüketir: `ARC_GETLOGS_MAX_RANGE` (Task 1).
- Üretir:
  - `nextRange(cursor, head, maxSpan) → {from, to} | null` — imza aynı, gövde korumalı.
  - `finalizedHead(client) → Promise<bigint>` — head'in **tek** kaynağı.
  - `error InvalidMaxSpan` (düz `RangeError`).

- [ ] **Adım 1: `maxSpan` koruması ve üst sınır**

```ts
export function nextRange(
  cursor: bigint,
  head: bigint,
  maxSpan: bigint,
): { from: bigint; to: bigint } | null {
  // maxSpan <= 0 TERS bir aralik uretiyordu: nextRange(0n, 10n, 0n) ->
  // {from: 1n, to: 0n}. Faz 0'da zararsizdi (MAX_SPAN modul sabitiydi); Faz
  // 3'te konfigurasyondan geldigi icin bir sifir env degeri butun ingest'i
  // sessizce bos aralik dondurmeye cevirirdi.
  if (maxSpan <= 0n) throw new RangeError('nextRange: maxSpan pozitif olmali')
  // Arc'in eth_getLogs'u 10.000 blokla SINIRLI (olculdu: span 10_000 ok,
  // 50_000 -> -32012, 100_000 -> -32614). Sinirin USTUNDE bir maxSpan her
  // cagriyi hataya cevirir; burada reddetmek onu bir baslangic hatasi yapar,
  // her turda tekrarlanan bir calisma zamani hatasi degil.
  if (maxSpan > ARC_GETLOGS_MAX_RANGE) {
    throw new RangeError(`nextRange: maxSpan ${maxSpan} > ${ARC_GETLOGS_MAX_RANGE}`)
  }
  if (head <= cursor) return null
  const from = cursor + 1n
  const remaining = head - cursor
  return { from, to: remaining > maxSpan ? cursor + maxSpan : head }
}
```

- [ ] **Adım 2: `finalizedHead` — head'in tek kaynağı**

Bu, ölçülmüş bir RPC tutarsızlığına verilen cevaptır:

```
latest 54326388  finalized 54326388  safe 54326388
latest 54326390  finalized 54326391  safe 54326391   <-- finalized > latest
latest 54326393  finalized 54326393  safe 54326394
```

`finalized`, `eth_blockNumber`'ın **önünde** görülebildi. İkisi bağımsız gecikmeli görünümlerdir (yük dengeleyici arkasında farklı düğümler). Sonuç: **`eth_blockNumber` ile `finalized` asla karıştırılmaz.** Ayrıca `finalized` iki okuma arasında geriye de düşebilir; `nextRange`'in `head <= cursor → null` dalı bunu zaten yutar ve gerekçesi artık ölçülmüş bir olgudur, varsayım değil.

```ts
export async function finalizedHead(client: PublicClient): Promise<bigint> {
  // `finalized`, `latest` DEGIL. Arc'ta ikisi genelde ESIT (deterministik
  // finality, olculen gecikme 0 blok) ama AYNI KAYNAK DEGILLER: olculdu,
  // finalized 54326391 iken latest 54326390 idi. Karistirmak, ayni turda
  // gelecekten bir head ile gecmisten bir aralik hesaplamak olurdu.
  const block = await client.getBlock({ blockTag: 'finalized' })
  return block.number
}
```

- [ ] **Adım 3: Testler**

Mevcut beş test korunur; şunlar eklenir. En dar sınır Faz 0'da sabitlenmemişti (devir listesi satır 43):

```ts
it('maxSpan sifir ise reddeder (ters aralik uretmez)', () => {
  expect(() => nextRange(0n, 10n, 0n)).toThrow(RangeError)
})

it('maxSpan negatif ise reddeder', () => {
  expect(() => nextRange(0n, 10n, -1n)).toThrow(RangeError)
})

it("Arc'in 10.000 blok sinirinin uzerindeki maxSpan i reddeder", () => {
  expect(() => nextRange(0n, 100_000n, 10_001n)).toThrow(/10000/)
  expect(nextRange(0n, 100_000n, 10_000n)).toEqual({ from: 1n, to: 10_000n })
})

// EN DAR SINIR: head, maxSpan'in tam BIR fazlasi kadar ileride. Bu, kismalı
// dalin en kucuk halidir ve Faz 0'da hic sabitlenmemisti.
it('head == cursor + maxSpan + 1 iken tam maxSpan kadar isler', () => {
  expect(nextRange(100n, 601n, 500n)).toEqual({ from: 101n, to: 600n })
})

it('bir blok kaldiginda tek bloklu aralik dondurur', () => {
  expect(nextRange(100n, 101n, 500n)).toEqual({ from: 101n, to: 101n })
})
```

- [ ] **Adım 4: Commit**

```bash
git add indexer/src/cursor.ts indexer/test/cursor.test.ts
git commit -m "fix(indexer): reject a span that cannot be served, and read the head from one source"
```

**Deliverable:** `pnpm --filter @arcpad/indexer test` yeşil; `nextRange(0n, 10n, 0n)` artık ters aralık yerine hata veriyor.

---

### Task 3: `@arcpad/db` — şema, migration, ve adlandırma kapısı

Yeni bir workspace paketi. **Gerekçe (spec §4'ün dört paketlik listesinden sapma):** şemanın iki tüketicisi var — indexer yazar, `web` okur — ve spec §6.3 aralarına bir API katmanı koymayı **yasaklar**. Yani iki süreç arasındaki tek sözleşme şemanın kendisi ve tipli sorgulardır. Bunları yazıcının paketine koymak, okuyucuyu yazıcının süreç kodu (viem, dotenv, ingest döngüsü) üzerinden bağımlı yapardı. Ayrıca kolon-adı kapısı koruduğu şemanın **yanında** durur.

**Files:**
- Create: `packages/db/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/db/migrations/001_deployment_and_cursor.sql` … `006_token_stats.sql`
- Create: `packages/db/src/{index,pool,migrate,seq,hex}.ts`
- Create: `packages/db/test/{migrate,naming,seq}.test.ts`
- Create: `packages/db/test/setup.ts` — her dosya öncesi `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + `runMigrations`
- Modify: `.github/workflows/node.yml` (Postgres servisi)
- Modify: `indexer/package.json` — `"@arcpad/db": "workspace:*"` bağımlılığı (`toSeq` ve havuz oradan gelir)
- Modify: `web/package.json` — `"@arcpad/db": "workspace:*"` (Faz 3'ün öteki yarısı okuyacak; bağımlılık burada açılır ki paket yayınlandığı gün kullanıma hazır olsun)

**Interfaces:**
- Tüketir: yok (yalnızca `pg`).
- Üretir:
  - `runMigrations(pool: Pool, files?: string[]) → Promise<string[]>` — uygulanan dosya adları. `files` yalnızca test enjeksiyonu içindir.
  - `createPool(url: string) → Pool`
  - `toSeq(blockNumber: bigint, logIndex: number) → bigint`, `fromSeq(seq: bigint) → {blockNumber, logIndex}`
  - `LOG_INDEX_BITS = 20n`, `MAX_LOG_INDEX = 1_048_575`
  - `lower(addr: Address) → string` — `0x` + küçük harf; şemanın `CHECK` deseninin TypeScript tarafındaki karşılığı.
  - `getDeployment(pool) → Promise<Deployment | null>`, `putDeployment(tx, d: Deployment) → Promise<void>`
  - `type Deployment = { chainId: bigint; factory: Address; escrow: Address; protocolTreasury: Address; virtualTokenReservesTok: bigint; virtualQuoteReservesWei: bigint; saleSupplyTok: bigint; totalSupplyTok: bigint; startBlock: bigint }`
  - `snapshot(pool) → Promise<Record<string, unknown[]>>` — her tablonun birincil anahtara göre sıralanmış dökümü. **Test altyapısı değil ürün kodudur**: idempotency iddialarının tamamı buna dayanır ve `packages/db`'de durması onu tek bir yerde tutar.

- [ ] **Adım 1: `seq.ts`**

```ts
/**
 * Bir blogun tasiyabilecegi log sayisinin USTUNDEKI en kucuk iki kuvveti
 * secmenin turetmesi: Arc blok gaz limiti OLCULDU, gasLimit = 0x1c9c380 =
 * 30.000.000. En ucuz log opcode'u LOG0'dir ve taban maliyeti 375 gazdir,
 * yani bir blokta en fazla 30.000.000 / 375 = 80.000 log olabilir.
 * 2^20 = 1.048.576, bu tavanin 13 kati.
 *
 * Ust taraf: bigint tavani 9.223.372.036.854.775.807; 2^20'ye bolundugunde
 * 8.796.093.022.207 blok kalir. 350ms blok suresiyle ~97.600 yil.
 */
export const LOG_INDEX_BITS = 20n
export const MAX_LOG_INDEX = 1_048_575

export function toSeq(blockNumber: bigint, logIndex: number): bigint {
  if (blockNumber < 0n) throw new RangeError('toSeq: blockNumber negatif')
  if (!Number.isInteger(logIndex) || logIndex < 0 || logIndex > MAX_LOG_INDEX) {
    // SESSIZ CAKISMAYI onleyen tek kontrol bu. logIndex tavanı asarsa
    // kodlama BIR SONRAKI blogun alanina tasar ve iki ayri olay AYNI
    // event_seq'i alir -- yani ON CONFLICT DO NOTHING birini sessizce yutar.
    throw new RangeError(`toSeq: logIndex ${logIndex} araligin disinda`)
  }
  return (blockNumber << LOG_INDEX_BITS) | BigInt(logIndex)
}

export function fromSeq(seq: bigint): { blockNumber: bigint; logIndex: number } {
  return {
    blockNumber: seq >> LOG_INDEX_BITS,
    logIndex: Number(seq & ((1n << LOG_INDEX_BITS) - 1n)),
  }
}
```

Testler (gerçek sayılar, ölçülmüş blok numarasından):

```ts
it('olculmus bir logu tam olarak kodlar', () => {
  // Arc blok 54.325.469, logIndex 1 (0x3600...0000'in 6 decimal logu)
  expect(toSeq(54_325_469n, 1)).toBe(56_954_651_115_521n)
  expect(fromSeq(56_954_651_115_521n)).toEqual({ blockNumber: 54_325_469n, logIndex: 1 })
})

it('ardisik bloklarin alanlari cakismaz', () => {
  expect(toSeq(1n, MAX_LOG_INDEX)).toBe(2_097_151n)
  expect(toSeq(2n, 0)).toBe(2_097_152n)
  expect(toSeq(2n, 0)).toBeGreaterThan(toSeq(1n, MAX_LOG_INDEX))
})

it('tavani asan logIndex i reddeder', () => {
  expect(() => toSeq(1n, 1_048_576)).toThrow(RangeError)
})

it('sonsuz buyuk blok numarasi bigint tavanini asmaz', () => {
  // Arc 97.600 yil sonra bu sinira ulasir; kodlama o zamana kadar gecerli.
  expect(toSeq(8_796_093_022_207n, MAX_LOG_INDEX)).toBeLessThan(2n ** 63n - 1n)
})
```

- [ ] **Adım 2: `001_deployment_and_cursor.sql`**

```sql
-- Uygulanan migration'lar. runMigrations bunu kendisi olusturur.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Bu veritabaninin HANGI dagitimi indexledigi. Tekil satir.
--
-- NICIN AYRI BIR TABLO: `V` (sanal quote rezervi) testnet ile uretim
-- arasindaki TEK farktir (spec 5.3, tam 1000x). Ayni Postgres'e iki profilin
-- verisini karistirmak, market cap'i 1000 kat yanlis gosterir ve HICBIR
-- kontrol bunu yakalamaz. Bu yuzden acilista uyusmazlik HALT sebebidir.
CREATE TABLE deployment (
  id                          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chain_id                    bigint  NOT NULL,
  factory                     text    NOT NULL CHECK (factory  ~ '^0x[0-9a-f]{40}$'),
  escrow                      text    NOT NULL CHECK (escrow   ~ '^0x[0-9a-f]{40}$'),
  protocol_treasury           text    NOT NULL CHECK (protocol_treasury ~ '^0x[0-9a-f]{40}$'),
  -- Profil. Zincirden okunur (factory'nin public immutable'lari), ASLA
  -- .env'den veya spec'ten kopyalanmaz.
  virtual_token_reserves_tok  numeric(78,0) NOT NULL CHECK (virtual_token_reserves_tok > 0),
  virtual_quote_reserves_wei  numeric(78,0) NOT NULL CHECK (virtual_quote_reserves_wei > 0),
  sale_supply_tok             numeric(78,0) NOT NULL CHECK (sale_supply_tok > 0),
  -- Butun arz. LaunchToken.TOTAL_SUPPLY = 1e27 (1 milyar token, 18 decimal).
  total_supply_tok            numeric(78,0) NOT NULL,
  -- Factory'nin deploy edildigi blok. Ingest buradan baslar; daha erken bir
  -- bloktan baslamak yalnizca bos aralik tarar, daha GEC baslamak launch
  -- KAYBEDER ve bu geri alinamaz (kayip launch'in Transfer'lari da hic
  -- gelmez, cunku token adresi hic ogrenilmez).
  start_block                 bigint  NOT NULL,
  CONSTRAINT sale_supply_below_token_reserves
    CHECK (sale_supply_tok < virtual_token_reserves_tok)
);

-- Imlec. `deployment`'tan AYRI, cunku biri kurulum digeri ilerleme.
CREATE TABLE sync_state (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block   bigint      NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Adım 3: `002_launches.sql`**

```sql
-- KABUL EDILMIS launch'lar. Bu tabloya giren her satirin provenance'i
-- Task 6'da dogrulanmistir. Dogrulanmamis bir token BURAYA GIRMEZ.
CREATE TABLE launches (
  token           text PRIMARY KEY CHECK (token ~ '^0x[0-9a-f]{40}$'),
  curve           text NOT NULL UNIQUE CHECK (curve ~ '^0x[0-9a-f]{40}$'),
  -- LAUNCH ANINDAKI creator. Kalicidir: "kim baslatti" olgusu degismez.
  -- Ucreti fiilen ALAN cuzdan bu DEGILDIR; o `creator_history`'dedir.
  launch_creator  text NOT NULL CHECK (launch_creator ~ '^0x[0-9a-f]{40}$'),
  name            text NOT NULL CHECK (length(name)   BETWEEN 1 AND 32),
  symbol          text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 13),
  uri             text NOT NULL CHECK (length(uri)    <= 200),
  salt            text NOT NULL CHECK (salt ~ '^0x[0-9a-f]{64}$'),
  created_seq     bigint NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL,
  tx_hash         text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$')
);
CREATE INDEX launches_creator_created_idx ON launches (launch_creator, created_seq DESC);
CREATE INDEX launches_created_idx        ON launches (created_seq DESC);

-- REDDEDILEN launch'lar. Bos kalmasi BEKLENIR (asagi).
CREATE TABLE rejected_launches (
  created_seq  bigint PRIMARY KEY,
  token        text   NOT NULL,
  curve        text   NOT NULL,
  reason       text   NOT NULL,
  expected     text   NOT NULL,   -- yerel CREATE2 turetmesinin verdigi adres
  raw          jsonb  NOT NULL,   -- ham log, elle inceleme icin
  seen_at      timestamptz NOT NULL DEFAULT now()
);

-- Ucreti ALAN creator'in ZAMANA GORE tarihi.
--
-- NICIN BUGUN VAR, arcpad'in creator'i DEGISTIRILEMEZ oldugu halde:
-- `BondingCurve.creator` ve `LaunchToken.creator` `immutable`'dir ve iki
-- kontratta da atama YALNIZCA constructor'dadir (dogrulandi:
-- `grep -n "creator\s*=" contracts/src/*.sol` uc satir dondurur, ucu de
-- constructor icinde). Ayrica Surface.t.sol olay kumesini iki yonlu
-- sabitliyor, yani bir `CreatorUpdated` olayi BUGUN YOKTUR.
--
-- AMA pump.fun'da curve creator'i DORT ayri yetki yoluyla degisir
-- (`set_creator`, `admin_set_creator`, `set_metaplex_creator`,
-- `migrate_bonding_curve_creator`) ve her biri `SetCreatorEvent` yayar; spec
-- 5.7 arcpad'in creator'inin ucret alici cuzdanini degistirebilecegini
-- soyluyor ve Faz 1c'nin devir listesi bu yolu Faz 1d'ye birakiyor.
--
-- Bu tablo o gunun migration'ini VERI degisikligine indirir: sema, view ve
-- sorgular ayni kalir, yalnizca yeni satirlar gelir. Bugun her token icin
-- TAM BIR satir vardir (launch aninda) ve `creator_at` `launches.creator`'a
-- dejenere olur. Task 7 bu yolu SENTETIK bir satirla BUGUNDEN test eder --
-- yani "hicbir sey egzersiz etmeyen kod yolu" durumu bastan kapatilir.
CREATE TABLE creator_history (
  token     text   NOT NULL REFERENCES launches(token) ON DELETE CASCADE,
  from_seq  bigint NOT NULL,
  creator   text   NOT NULL CHECK (creator ~ '^0x[0-9a-f]{40}$'),
  PRIMARY KEY (token, from_seq)
);

-- `seq` anindaki ucret alicisi. Bugun tek satirlik, yarin cok satirlik.
CREATE FUNCTION creator_at(p_token text, p_seq bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT creator FROM creator_history
  WHERE token = p_token AND from_seq <= p_seq
  ORDER BY from_seq DESC LIMIT 1
$$;
```

- [ ] **Adım 4: `003_trades_and_curve_state.sql`**

```sql
-- Curve basina CANLI rezerv durumu. `Trade` olayinin dort rezervinden
-- MUTLAK olarak yazilir (artimli DEGIL) -- olay dorduncu de tasidigi icin
-- (BondingCurve.sol:133-149) indexer zincire hic sormaz.
CREATE TABLE curve_state (
  curve                       text PRIMARY KEY CHECK (curve ~ '^0x[0-9a-f]{40}$'),
  token                       text NOT NULL UNIQUE REFERENCES launches(token),
  virtual_token_reserves_tok  numeric(78,0) NOT NULL,
  virtual_quote_reserves_wei  numeric(78,0) NOT NULL,
  real_token_reserves_tok     numeric(78,0) NOT NULL,
  real_quote_reserves_wei     numeric(78,0) NOT NULL,
  complete                    boolean NOT NULL DEFAULT false,
  completed_seq               bigint,
  -- `Completed` olayindan gelir; Faz 2'nin havuz tohumu. Curve tamamlanana
  -- kadar NULL.
  pool_seed_supply_tok        numeric(78,0),
  -- SIRA MUHAFIZI. Her mutlak yazim yalnizca last_seq'ten BUYUK bir seq ile
  -- yapilir. Bu, yeniden oynatilan ESKI bir olayin YENI durumu ezmesini
  -- imkansiz kilar -- ki at-least-once teslimatta bu kacinilmaz bir vakadir.
  last_seq                    bigint NOT NULL,
  CONSTRAINT completed_iff_seq CHECK ((complete) = (completed_seq IS NOT NULL)),
  CONSTRAINT complete_means_empty CHECK (NOT complete OR real_token_reserves_tok = 0)
);

CREATE TABLE trades (
  event_seq                   bigint PRIMARY KEY,
  block_number                bigint NOT NULL,
  log_index                   integer NOT NULL CHECK (log_index BETWEEN 0 AND 1048575),
  tx_hash                     text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- YALNIZCA gosterim ve 24s penceresi. SIRALAMA ICIN KULLANILMAZ: Arc'ta
  -- ardisik 400 blok cifti olculdu, 197'si (%49,1) AYNI timestamp'i tasiyor.
  block_time                  timestamptz NOT NULL,
  token                       text NOT NULL REFERENCES launches(token),
  curve                       text NOT NULL REFERENCES curve_state(curve),
  trader                      text NOT NULL CHECK (trader ~ '^0x[0-9a-f]{40}$'),
  is_buy                      boolean NOT NULL,
  token_amount_tok            numeric(78,0) NOT NULL CHECK (token_amount_tok > 0),
  quote_amount_wei            numeric(78,0) NOT NULL CHECK (quote_amount_wei > 0),
  protocol_fee_wei            numeric(78,0) NOT NULL CHECK (protocol_fee_wei >= 0),
  -- SIFIR OLABILIR ve bu MESRUDUR: creator sifirsa creator payi hic alinmaz
  -- ve protokol payina KATLANMAZ (BondingCurve.sol:60-62). Bir
  -- `> 0` CHECK'i sifir-creator'lu her curve'un her islemini reddederdi.
  creator_fee_wei             numeric(78,0) NOT NULL CHECK (creator_fee_wei >= 0),
  virtual_token_reserves_tok  numeric(78,0) NOT NULL,
  virtual_quote_reserves_wei  numeric(78,0) NOT NULL,
  real_token_reserves_tok     numeric(78,0) NOT NULL,
  real_quote_reserves_wei     numeric(78,0) NOT NULL,
  -- Faz 2'nin havuz islemleri MIGRATION'SIZ girsin diye bugunden aciliyor.
  -- Spec 6.2'nin "bir token graduate oldugunda fiyat gecmisi kopmaz"
  -- gerekcesi budur.
  source                      text NOT NULL DEFAULT 'curve'
                              CHECK (source IN ('curve','pool'))
);
CREATE INDEX trades_token_seq_idx    ON trades (token, event_seq DESC);
CREATE INDEX trades_trader_seq_idx   ON trades (trader, event_seq DESC);
-- 24 saatlik hacim penceresi icin. block_time BURADA mesrudur: pencere
-- filtresidir, siralama degil -- esit timestamp'ler bir aralik filtresini
-- bozmaz.
CREATE INDEX trades_token_time_idx   ON trades (token, block_time DESC);
```

`price` ve `is_dev` kolonlarının **olmamasının** gerekçesi (spec §6.2'den sapma):
- `price`: `quote_amount_wei / token_amount_tok`. Yazma anında saklamak bir yuvarlama kararı verir ve frontend onu geri alamaz. Task 10 bunu view'da `numeric` bölmesiyle verir.
- `is_dev`: `trader = creator_at(token, event_seq)`. Creator değiştirilebilir olursa **noktasal** bir olgudur; saklanmış bir boolean geçmişe dönük yanlışlanamaz hâle gelir, güncel creator'a JOIN yapmak ise o gün geçmiş işlemleri yanlış etiketler. `creator_at` ikisini de doğru yapar.

- [ ] **Adım 5: `004_transfers_and_holders.sql`**

```sql
-- IDEMPOTENCY DEFTERI. `holders` artimli guncellenmek ZORUNDA (Transfer bir
-- delta tasir, mutlak bakiye tasimaz), ve artimli guncelleme ON CONFLICT DO
-- NOTHING ile idempotent OLMAZ. Cozum: delta yalnizca BU tabloya bir satir
-- GERCEKTEN eklendiginde uygulanir (Task 8'in CTE'si).
CREATE TABLE token_transfers (
  event_seq     bigint PRIMARY KEY,
  block_number  bigint NOT NULL,
  log_index     integer NOT NULL CHECK (log_index BETWEEN 0 AND 1048575),
  tx_hash       text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_time    timestamptz NOT NULL,
  token         text NOT NULL REFERENCES launches(token),
  from_addr     text NOT NULL CHECK (from_addr ~ '^0x[0-9a-f]{40}$'),
  to_addr       text NOT NULL CHECK (to_addr   ~ '^0x[0-9a-f]{40}$'),
  amount_tok    numeric(78,0) NOT NULL
);
CREATE INDEX token_transfers_token_seq_idx ON token_transfers (token, event_seq DESC);

CREATE TABLE holders (
  token        text NOT NULL REFERENCES launches(token),
  holder       text NOT NULL CHECK (holder ~ '^0x[0-9a-f]{40}$'),
  -- NEGATIF OLAMAZ. Bir Transfer atlanirsa (ornegin adres filtresi
  -- dusurulurse ve bir token'in loglari eksik gelirse) bu CHECK patlar ve
  -- transaction geri alinir. Sessiz veri kaybini GURULTULU bir hataya
  -- ceviren tek yer burasidir.
  balance_tok  numeric(78,0) NOT NULL CHECK (balance_tok >= 0),
  last_seq     bigint NOT NULL,
  PRIMARY KEY (token, holder)
);
-- Holder SAYISI icin. Sifir bakiyeli satirlar silinmez (last_seq bilgisi
-- degerli), bu yuzden kismi indeks.
CREATE INDEX holders_token_nonzero_idx ON holders (token) WHERE balance_tok > 0;
CREATE INDEX holders_holder_idx        ON holders (holder) WHERE balance_tok > 0;
```

- [ ] **Adım 6: `005_fees.sql`**

```sql
CREATE TABLE fee_events (
  event_seq     bigint PRIMARY KEY,
  block_number  bigint NOT NULL,
  log_index     integer NOT NULL CHECK (log_index BETWEEN 0 AND 1048575),
  tx_hash       text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_time    timestamptz NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('deposit','claim')),
  recipient     text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  -- `Deposited.from` yatiran adrestir, yani CURVE. Bu, ucretin hangi
  -- launch'tan geldigini verir ve creator kazancinin launch basina
  -- dokumunu MUMKUN kilar (Task 10). `Claimed`'da from YOKTUR -> NULL.
  from_addr     text CHECK (from_addr ~ '^0x[0-9a-f]{40}$'),
  amount_wei    numeric(78,0) NOT NULL CHECK (amount_wei > 0),
  CONSTRAINT deposit_has_from CHECK ((kind = 'deposit') = (from_addr IS NOT NULL))
);
CREATE INDEX fee_events_recipient_seq_idx ON fee_events (recipient, event_seq DESC);
CREATE INDEX fee_events_from_seq_idx      ON fee_events (from_addr, event_seq DESC);

CREATE TABLE fee_balances (
  recipient          text PRIMARY KEY CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  claimable_wei      numeric(78,0) NOT NULL CHECK (claimable_wei >= 0),
  deposited_total_wei numeric(78,0) NOT NULL CHECK (deposited_total_wei >= 0),
  claimed_total_wei  numeric(78,0) NOT NULL CHECK (claimed_total_wei >= 0),
  last_seq           bigint NOT NULL,
  -- Escrow'un kendi defter esitligi. Kirilirsa bir olay atlanmis demektir.
  CONSTRAINT claimable_is_the_difference
    CHECK (claimable_wei = deposited_total_wei - claimed_total_wei)
);
```

- [ ] **Adım 7: `006_token_stats.sql`**

```sql
-- DENORMALIZE. Spec 6.2 bunu zorunlu kilar: Explore sayfasi yuz binlerce
-- token arasinda "market cap'e gore sirala" diyebilmeli ve bu her istekte
-- `trades` uzerinden toplanamaz.
--
-- BURAYA YALNIZCA INDEKSLENEBILIR SIRALAMA ANAHTARLARI GIRER. Token detay
-- sayfasinin tek satirlik alanlari (fiyat, graduation ilerlemesi, rezervler)
-- `token_overview` VIEW'inda durur -- saklanmadiklari icin bayatlamazlar.
CREATE TABLE token_stats (
  token                    text PRIMARY KEY REFERENCES launches(token),
  market_cap_wei           numeric(78,0) NOT NULL,
  ath_market_cap_wei       numeric(78,0) NOT NULL,
  volume_total_wei         numeric(78,0) NOT NULL DEFAULT 0,
  volume_24h_wei           numeric(78,0) NOT NULL DEFAULT 0,
  -- 24s hacim PENCERELI bir toplamdir: girisler ZAMANLA DUSER, yani artimli
  -- olarak dogru tutulamaz. Bu kolon her dokunulan token icin yeniden
  -- HESAPLANIR, ve dokunulmayan tokenlar icin bir surgu adimi tazeler
  -- (Task 11). Tazelenme zamani BURADA duruyor cunku degerin ne kadar bayat
  -- oldugu okuyanin bilmesi gereken bir seydir.
  volume_24h_refreshed_at  timestamptz NOT NULL DEFAULT now(),
  trade_count              integer NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  buy_count                integer NOT NULL DEFAULT 0 CHECK (buy_count >= 0),
  holder_count             integer NOT NULL DEFAULT 0 CHECK (holder_count >= 0),
  last_trade_seq           bigint,
  -- "Recent buys" beslemesinin SIRALAMA anahtari. ZAMAN DEGIL SIRA.
  -- Gerekce Task 10'da; kisaca: Arc'ta ardisik bloklarin %49,1'i ayni
  -- timestamp'i tasir (olculdu), yani zamana gore siralama yari yariya
  -- keyfi ve sayfalama sinirinda KARARSIZDIR.
  last_buy_seq             bigint,
  last_trade_at            timestamptz,
  last_buy_at              timestamptz,
  created_seq              bigint NOT NULL,
  created_at               timestamptz NOT NULL
);

CREATE INDEX token_stats_mcap_idx    ON token_stats (market_cap_wei DESC);
CREATE INDEX token_stats_vol24_idx   ON token_stats (volume_24h_wei DESC);
CREATE INDEX token_stats_created_idx ON token_stats (created_seq DESC);
-- KISMI indeks: hic alim gormemis bir token "Recent buys" beslemesinde
-- GORUNMEZ. Bu bir optimizasyon degil URUN kararidir -- etiket "recent
-- buys"tur, "recently launched" degil.
CREATE INDEX token_stats_last_buy_idx ON token_stats (last_buy_seq DESC)
  WHERE last_buy_seq IS NOT NULL;
```

- [ ] **Adım 8: Adlandırma kapısı — `packages/db/test/naming.test.ts`**

Bu, "6 decimal görünüm veritabanına giremez" kuralını **uygulanabilir** kılan tek şeydir:

```ts
const MONEYISH = /(_wei|_tok|_ppm|_bps|_seq|_at|_count|_id|_block|_number|_index|_hash)$/
const FORBIDDEN = /(_usdc|_uusdc|_micro|_e6)$/

it('her numeric(78,0) kolonu _wei veya _tok ile biter', async () => {
  const { rows } = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'numeric'
      AND numeric_precision = 78 AND numeric_scale = 0
    ORDER BY 1, 2`)
  expect(rows.length).toBeGreaterThan(0)   // testin BOS kumeyi gecmesini onler
  const bad = rows.filter((r) => !/(_wei|_tok)$/.test(r.column_name))
  expect(bad).toEqual([])
})

it('hicbir kolon 6 decimal gorunumu ima etmez', async () => {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`,
  )
  expect(rows.filter((r) => FORBIDDEN.test(r.column_name))).toEqual([])
})

it('her kolon tanimli bir sonek tasir', async () => {
  const EXEMPT = new Set([
    'token','curve','trader','holder','recipient','creator','launch_creator',
    'from_addr','to_addr','factory','escrow','protocol_treasury','name','symbol',
    'uri','salt','kind','reason','expected','raw','source','complete','is_buy',
    'filename',
  ])
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`,
  )
  const bad = rows.filter((r) => !MONEYISH.test(r.column_name) && !EXEMPT.has(r.column_name))
  // Muafiyet listesi ACIKTIR: yeni bir sonekisiz kolon eklemek bu testi
  // kirar ve ekleyeni ya sonek koymaya ya listeyi buyutmeye ZORLAR. Sessiz
  // bir `amount` kolonu imkansiz.
  expect(bad).toEqual([])
})
```

- [ ] **Adım 9: `migrate.ts` ve `migrate.test.ts`**

`migrations/*.sql` dosyalarını ada göre sıralı, **tek transaction içinde**, `schema_migrations`'a yazarak uygular. İki test:

```ts
it('iki kez kosturmak ikinci kez hicbir sey uygulamaz', async () => {
  const first = await runMigrations(pool)
  expect(first).toHaveLength(6)
  const second = await runMigrations(pool)
  expect(second).toEqual([])
})

it('bir migration patlarsa hicbiri uygulanmaz', async () => {
  // Gecici olarak bozuk bir dosya enjekte et; schema_migrations BOS kalmali.
  await expect(runMigrations(pool, [...files, 'zzz_broken.sql'])).rejects.toThrow()
  const { rows } = await pool.query('SELECT count(*)::int n FROM schema_migrations')
  expect(rows[0].n).toBe(0)
})
```

- [ ] **Adım 10: CI'a Postgres servisi**

`.github/workflows/node.yml`'nin `check` job'ına:

```yaml
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: arcpad
          POSTGRES_PASSWORD: arcpad
          POSTGRES_DB: arcpad
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 5s
          --health-timeout 5s --health-retries 10
```
ve `Test` adımına `env: DATABASE_URL: postgres://arcpad:arcpad@localhost:5432/arcpad`.

**`DATABASE_URL` yoksa `@arcpad/db` testleri ATLAMAZ, ÇÖKER.** Gerekçe: atlayan bir test yeşil görünür ve Faz 0'ın devir listesi (satır 41–42) aynı arıza kipini `continue-on-error` üzerinden zaten kaydetti — "hiçbir CI iş akışı henüz çalışmadı, kapıların değeri sıfır". Bir veritabanı testinin veritabanı olmadan yeşil olması aynı sınıftır.

- [ ] **Adım 11: Commit**

```bash
git add packages/db pnpm-workspace.yaml .github/workflows/node.yml pnpm-lock.yaml
git commit -m "feat(db): a schema whose column names cannot express the 6-decimal view"
```

**Deliverable:** `DATABASE_URL=... pnpm --filter @arcpad/db test` yeşil; `migrations/007_x.sql` içine `ALTER TABLE trades ADD COLUMN amount_uusdc numeric(78,0)` eklenince adlandırma kapısı iki testte kırılır.

---

### Task 4: `contracts/test/FixtureGen.t.sol` — gerçek yürütmeden gerçek loglar

Bu görevin tek amacı, indexer testlerinin **elle yazılmış olay yükleriyle** çalışmasını imkânsız kılmak. Elle yazılan bir yük kontrattan **sapabilir** ve saptığı gün test yeşil kalır — bu deponun defalarca yakaladığı sınıf.

**Files:**
- Create: `contracts/test/FixtureGen.t.sol`
- Modify: `contracts/foundry.toml` (**yalnızca** yazma izni)
- Create: `contracts/fixtures/*.json` (üretilir, commit'lenir)
- Modify: `Makefile` (`fixtures` hedefi)
- Modify: `.github/workflows/contracts.yml` (drift kapısı)

- [ ] **Adım 1: `foundry.toml`'a tek satır — ve neden iki kez**

`foundry.toml`'un kendi yorumu iki şeyi **ölçerek** kaydetmiş ve ikisi de bu değişikliği kısıtlıyor:
1. `fs_permissions` bir kez tanımlandığında **örtük izin ortadan kalkar**; yalnızca listelenenler geçerli olur. Yani `./out` girişi **silinemez** (Surface.t.sol'un 25 iddiası ona bağlı).
2. Profiller listeyi **miras almaz, değiştirir**: bir profil kendi listesini tanımlarsa `default`'unkini tamamen değiştirir. `[profile.default]` ve `[profile.ci]` **ikisi de** kendi listesini tanımlıyor, dolayısıyla giriş **iki yere** eklenmelidir. Yalnızca birine eklemek, fixture üretimini öbür profilde sessizce kırar.

Her iki profilde:
```toml
fs_permissions = [
  { access = "read", path = "./out" },
  { access = "read-write", path = "./fixtures" },
]
```

**Çalıştırılabilir ön koşul:** değişiklikten sonra `forge test --root contracts --match-path 'test/Surface.t.sol'` **her iki profilde** 25/25 geçmelidir. Geçmezse `./out` izni düşmüştür.

- [ ] **Adım 2: Senaryolar — kapsamın SEÇIMI burada yapılır**

Tek bir `Trade` fixture'ı "bütün `Trade`'leri kapsıyor" gibi okunur. `Trade` **üç** giriş noktasından ve **dört** farklı yoldan yayılır. Fixture üreticisi senaryo başına ayrı bir dosya yazar ve Task 5'in kapsam testi bu **tam listeyi** iki yönlü olarak iddia eder:

| Senaryo dosyası | Ne üretir | Nicin ayri |
|---|---|---|
| `launch.json` | `Transfer`(mint) **sonra** `Launched` | Log SIRASI: `launch()` curve'u, sonra token'i (mint→`Transfer`) uretir, `Launched`'i **`bind`'den once** yayar ve `bind` hic log yaymaz. Yani launch isleminde `Transfer` `Launched`'DAN ONCE gelir. Task 5'in iki fazli cekisinin gerekcesi bu. |
| `buy_exact_tokens_out.json` | `Trade` + token `Transfer` + `Deposited`×2, **iade sıfır değil** | `maxQuoteIn` yolu; `msg.value − total > 0` dali |
| `buy_exact_quote_in.json` | `Trade` + `Transfer` + `Deposited`×2, kısma **yok** | `correctedNetQuoteIn` yolu; duzeltme tetiklenmemis |
| `buy_exact_quote_in_clamped.json` | `Trade` **ve** `Completed` aynı tx'te, `realTokenReserves = 0` | Kisma dali + tamamlanma; `Completed` YALNIZCA burada uretilebilir |
| `sell.json` | `Transfer`(trader→curve) + `Trade` + `Deposited`×2 + payout | Satista `Transfer` `Trade`'DEN SONRA gelir (CEI: defter→olay→dis cagri). Alimda TERSI. Ikisi ayni handler'a duser. |
| `zero_creator.json` | `Trade` + **tek** `Deposited` | `creatorFee == 0` -> escrow'a YALNIZCA BIR yatirim. "Her ticaret iki `Deposited` uretir" varsayan bir handler burada kirilir. |
| `claim.json` | `Claimed` | Tek `Claimed` yolu |
| `forged.json` | Rogue bir factory'nin `Launched`'i + degistirilmis bir `LaunchToken` | Task 6'nin reddetme yolu. Rogue token `LaunchToken`'in aynisi + `mint()` -> creationCode farkli -> CREATE2 turetmesi tutmaz. |

- [ ] **Adım 3: Üretici**

```solidity
function _dump(string memory name_, Vm.Log[] memory logs) private {
    string memory obj = "fixture";
    // Blok baglami da yazilir: indexer event_seq'i buradan kurar.
    vm.serializeUint(obj, "blockNumber", block.number);
    vm.serializeUint(obj, "blockTimestamp", block.timestamp);
    string memory arr = "[";
    for (uint256 i = 0; i < logs.length; ++i) {
        // logIndex `vm.getRecordedLogs()`ta YOKTUR; sirayi biz veriyoruz ve
        // bunun BIR VARSAYIM oldugu burada yaziyor: gercek zincirde logIndex
        // BLOK kapsamlidir, testte ise tx kapsamli bir sayaca dusuyor.
        // Indexer bu farka duyarli DEGILDIR (event_seq'i gercek log'dan
        // kurar), ama fixture'lardaki mutlak event_seq degerleri gercek
        // zincirdekilerle AYNI OLMAZ. Task 12 bunu canlida kapatir.
        ...
    }
    vm.writeJson(json, string.concat("./fixtures/", name_, ".json"));
}
```

Her senaryo `vm.recordLogs()` → gerçek çağrı → `vm.getRecordedLogs()` → `_dump`. Kontrat kaynağına **hiç** dokunulmaz; yalnızca çağrılır.

- [ ] **Adım 4: Drift kapısı**

`Makefile`:
```make
fixtures:
	forge test --root contracts --match-contract FixtureGen
```
`make test` bu testi zaten koşar, yani fixture'lar her koşuda yeniden üretilir. Kapı:
```yaml
      - name: Fixtures are not stale
        run: |
          forge test --root contracts --match-contract FixtureGen
          git diff --exit-code -- contracts/fixtures
```
Kontratların olay şekli veya değerleri değişirse fixture'lar değişir, `git diff` kirlenir, CI kırılır. **Bu, "fixture kontrattan sapamaz" iddiasının tek çalıştırılabilir hâlidir.**

- [ ] **Adım 5: Commit**

```bash
make fixtures
forge test --root contracts --match-path 'test/Surface.t.sol'   # 25/25 kalmali
git add contracts/test/FixtureGen.t.sol contracts/foundry.toml contracts/fixtures Makefile .github/workflows/contracts.yml
git commit -m "test(contracts): emit indexer fixtures from real execution, and fail CI when they drift"
```

**Deliverable:** `contracts/fixtures/` sekiz dosya; `forge test --match-path 'test/Surface.t.sol'` hâlâ 25/25; `contracts/src/BondingCurve.sol`'de `PROTOCOL_FEE_BPS`'i 95'ten 96'ya çevirip `make fixtures` koşulduğunda `git diff` kirlenir (bu ölçüm raporda gösterilir, sonra geri alınır).

---

### Task 5: `indexer/src/logs.ts` — çekme katmanı, RPC hata taksonomisi, EIP-7708 duvarı

**Files:**
- Create: `indexer/src/logs.ts`
- Create: `indexer/test/logs.test.ts`
- Create: `indexer/test/fixtures.ts` (yükleyici + kapsam testi)

**Interfaces:**
- Tüketir: `TOPIC0`, `FORBIDDEN_TRANSFER_EMITTERS`, `ADDRESS_FILTER_CHUNK`, `ARC_GETLOGS_MAX_RESULTS` (Task 1); `toSeq` (Task 3).
- Üretir:
  - `type WatchSet = { factory: Address; escrow: Address; curves: Set<Address>; tokens: Set<Address> }`
  - `fetchRange(client, watch, from, to) → Promise<DecodedEvent[]>` — **`event_seq`'e göre sıralı**.
  - `type DecodedEvent` — ayrık birleşim: `{kind:'launched'|'trade'|'completed'|'deposited'|'claimed'|'transfer', seq, blockNumber, logIndex, txHash, blockTime, ...alanlar}`
  - `error ForbiddenEmitter`, `error UnorderedLogs`, `error LogOutOfRange`, `error RemovedLog`, `error MissingTimestamp`

- [ ] **Adım 1: İki fazlı çekiş — ve bu tek fazlı bir tasarımın GERÇEK hatasını kapatır**

Bir tek fazlı çekiş şu hatayı yapar: `Transfer` sorgusu `address: knownTokens` ile filtrelenir; bir launch **aynı aralıkta** olduğunda token adresi henüz `knownTokens`'te değildir, dolayısıyla o launch'ın **mint `Transfer`'ı hiç çekilmez** — ve imleç ilerlediği için bir daha da çekilmez. Kayıp kalıcıdır ve `SUM(holders.balance_tok) = 1e27` iddiasını kalıcı olarak kırar.

```ts
export async function fetchRange(client, watch, from, to): Promise<DecodedEvent[]> {
  // FAZ 1: provenance koku. YALNIZCA factory adresinden.
  // Baska bir adresten gelen bir `Launched` HIC CEKILMEZ -- adres filtresi
  // ingest yolunun butun provenance kontrolunun BIRINCI yarisidir (ikincisi
  // Task 6'nin CREATE2 turetmesi).
  const launched = await getLogs(client, {
    address: watch.factory, topics: [TOPIC0.launched], from, to,
  })

  // FAZ 1.5: izleme kumesini AYNI ARALIK icinde buyut. Bu adim olmadan bu
  // aralikta acilan bir launch'in mint `Transfer`'i ve ilk `Trade`'i
  // duserdi -- ve `launch()` olay sirasi geregi `Transfer`'i `Launched`'DAN
  // ONCE yayar (LaunchFactory.sol:439-464: curve, sonra token(mint->
  // Transfer), sonra `Launched`, sonra olaysiz `bind`).
  const curves = new Set(watch.curves)
  const tokens = new Set(watch.tokens)
  for (const l of launched) { curves.add(l.curve); tokens.add(l.token) }

  // FAZ 2: geri kalan her sey, GUNCELLENMIS kumeyle.
  const [curveLogs, escrowLogs, transferLogs] = await Promise.all([
    // `Trade`/`Completed` topic0'lari arcpad'e ozgudur, AMA adres filtresi
    // yine de zorunludur: herkes ayni imzayi tasiyan bir olay YAYABILIR.
    // Filtre olmadan sahte bir `Trade` gercek bir islem gibi girerdi.
    getLogsChunked(client, [...curves], [[TOPIC0.trade, TOPIC0.completed]], from, to),
    getLogs(client, { address: watch.escrow, topics: [[TOPIC0.deposited, TOPIC0.claimed]], from, to }),
    // EIP-7708 DUVARI: `Transfer` ASLA adres filtresi olmadan sorulmaz.
    // Filtresiz sorgunun olculen hacmi 11.692 log / 1.000 blok ve icinde
    // her native hareket var.
    getLogsChunked(client, [...tokens], [TOPIC0.transfer], from, to),
  ])
  return decodeAll([...launched, ...curveLogs, ...escrowLogs, ...transferLogs], from, to)
}
```

`getLogsChunked` adres listesini `ADDRESS_FILTER_CHUNK = 500`'lük parçalara böler (1.000 kabul edildiği ölçüldü; yarısında duruyoruz).

- [ ] **Adım 2: RPC hata taksonomisi — üçü de**

```ts
/**
 * Arc'in eth_getLogs'unun UC ayri ret sekli vardir ve olculdu:
 *   -32012 "requested range too large"                    (span 50.000)
 *   -32614 "eth_getLogs is limited to a 10,000 range"     (span 100.000)
 *   -32602 "query exceeds max results 20000, retry with the range A-B"
 *
 * Tek bir kodu yakalayan bir retry, obur ikisinde imleci ilerletmeden
 * sonsuz doner. -32602 DOGRU ARALIGI KENDISI SOYLER, bu yuzden once o
 * ayristirilir; tahmine dusmek gerekmez.
 */
const SUGGESTED = /retry with the range (\d+)-(\d+)/

async function getLogs(client, params, depth = 0): Promise<RawLog[]> {
  try {
    return await client.request({ method: 'eth_getLogs', params: [toFilter(params)] })
  } catch (e) {
    const { code, message } = asRpcError(e)
    if (code === -32602) {
      const m = SUGGESTED.exec(message)
      if (m) return splitAt(client, params, BigInt(m[2]), depth)
    }
    if (code === -32602 || code === -32012 || code === -32614) {
      if (params.to === params.from) {
        // TEK BIR BLOK 20.000 sonucu asiyor. Blok bolme burada TUKENIR;
        // geriye adres filtresini bolmek kalir. Yol yazilmistir cunku
        // "burada duruyoruz" demek, bir gun sessizce sonsuz donmek demektir.
        throw new SingleBlockTooLarge(params.from)
      }
      return splitAt(client, params, params.from + (params.to - params.from) / 2n, depth + 1)
    }
    throw e
  }
}
```

- [ ] **Adım 3: Yanıt üzerindeki dört sert iddia**

Sessiz bir kısaltmayı tespit etmenin yolu yoktur — ama **varsayımları kontrole çevirmek** vardır. Dördü de indexer'ın davranışının bağlı olduğu, ölçülmüş ama hiçbir yerde yazılı olmayan olgulardır:

```ts
for (const log of raw) {
  // (1) Arc'ta reorg YOKTUR. `removed: true` gormek, RPC'nin Arc olmadiginin
  //     kanitidir -- yok saymak degil, DURMAK gerekir.
  if (log.removed) throw new RemovedLog(log)

  // (2) Log istenen araligin ICINDE olmali. Disinda bir log, ya filtrenin
  //     uygulanmadigini ya RPC'nin kendi finalized'inin onunde oldugunu
  //     gosterir; ikisi de imleci bozar.
  if (log.blockNumber < from || log.blockNumber > to) throw new LogOutOfRange(log, from, to)

  // (3) `blockTimestamp` her logda VAR (olculdu: "blockTimestamp":"0x6a6a7f0a").
  //     viem'in `Log` tipi onu TASIMAZ, yani calisma zamaninda var olan bir
  //     alani tip sistemi bilmiyor. Yoksa toplu bir blok cagrisina duseriz --
  //     ama SESSIZCE dusmeyiz, cunku o yol blok basina bir ek istek demektir
  //     ve sessiz bir performans ucurumu bir hatadan daha kotudur.
  if (log.blockTimestamp === undefined) missingTimestamp.push(log.blockNumber)

  // (4) SIRA. Yanit (blockNumber, logIndex)'e gore sirali GELIYOR (olculdu),
  //     ama holder deltalari sıraya BAGIMLIDIR ve sirayi varsaymak "kimsenin
  //     yazmadigi bir sebeple gecen test"in ta kendisidir.
  if (prevSeq !== undefined && seq <= prevSeq) throw new UnorderedLogs(prevSeq, seq)
}
```

- [ ] **Adım 4: EIP-7708 duvarının kendisi**

```ts
function decodeTransfer(log: RawLog): TransferEvent {
  // BU DALA DUSMEK, adres filtresinin dustugu anlamina gelir. Sessizce
  // atlamak tuzagi geri getirir: `0xfff...ffe` 18 decimal NATIVE USDC
  // hareketini, `0x3600...0000` ise AYNI hareketin 6 decimal gorunumunu
  // yayar (olculdu, ayni tx'te logIndex 0 ve 1). Ikisi de LaunchToken
  // bakiyesi DEGILDIR.
  if (FORBIDDEN_TRANSFER_EMITTERS.has(log.address)) throw new ForbiddenEmitter(log.address)
  ...
}
```

- [ ] **Adım 5: Kapsam testi — "bir olayı kapsamak hepsini kapsamış gibi okunmaz"**

```ts
// (a) ABI'deki her olayin bir handler'i VAR MI, ve fazlasi var mi.
it('handler kumesi ile dinlenen olay kumesi iki yonlu ayni', () => {
  expect(Object.keys(DECODERS).sort()).toEqual(
    ['claimed', 'completed', 'deposited', 'launched', 'trade', 'transfer'],
  )
})

// (b) Her handler'i egzersiz eden EN AZ BIR fixture var mi. (a) bunu
//     KAPSAMAZ: bir handler yazilip hic cagrilmadan da (a) yesil kalir.
it('her handler en az bir fixture tarafindan egzersiz edilir', () => {
  const seen = new Set(loadAllFixtures().flatMap((f) => f.events.map((e) => e.kind)))
  expect([...seen].sort()).toEqual(Object.keys(DECODERS).sort())
})

// (c) Senaryo kumesi. (a) ve (b) BUNU KAPSAMAZ: tek bir `Trade` fixture'i
//     ikisini de yesil yapar ama `Trade` UC giris noktasindan ve DORT
//     yoldan yayilir. Bu iddia, yeni bir giris noktasi eklenip fixture
//     yazilmadiginda kirilir -- yani "boslugu KAPSAMDA degil SECIMDE
//     aramak" burada calistirilabilir hale gelir.
it('fixture senaryo kumesi tam', () => {
  expect(fixtureNames().sort()).toEqual([
    'buy_exact_quote_in', 'buy_exact_quote_in_clamped', 'buy_exact_tokens_out',
    'claim', 'forged', 'launch', 'sell', 'zero_creator',
  ])
})
```

Ek testler: sentetik bir `0xfff…ffe` logu `ForbiddenEmitter` fırlatır (yük **ölçülmüş** tx'ten alınır: `from 0x3e65…db4c`, `to 0x1208…0e12`, `data 1_768_280_000_000_000_000`); `blockTimestamp` soyulmuş bir fixture yedek yolu **tetikler** (yolun gerçekten koştuğunu bir `eth_getBlockByNumber` sahtesinin çağrı sayısıyla iddia et); sırası bozulmuş bir yanıt `UnorderedLogs` fırlatır; `-32602`/`-32012`/`-32614` üçü için ayrı bölme testi.

- [ ] **Adım 6: Commit**

```bash
git commit -m "feat(indexer): fetch logs behind an address filter that EIP-7708 cannot get past"
```

**Deliverable:** `pnpm --filter @arcpad/indexer test` yeşil; `Transfer` sorgusundan `address` parametresi elle kaldırıldığında `ForbiddenEmitter` fırlar (ölçülür ve raporlanır).

---

### Task 6: `indexer/src/admit.ts` — launch kabulü ve reddedilen token

`isCanonical(token)` provenance kontrolünün **tamamıdır** (`LaunchFactory.sol:473-507`): herkes gerçek bir launch'ın creator'ını, curve'ünü ve URI'sini iddia eden bir `LaunchToken` deploy edebilir. **Indexer doğrulamadığı bir token'ı asla listelemez.**

**Files:**
- Create: `indexer/src/admit.ts`
- Create: `indexer/test/admit.test.ts`

**Interfaces:**
- Tüketir: `LAUNCH_TOKEN_CREATION_CODE` (Task 1); `launches`, `rejected_launches`, `creator_history`, `curve_state`, `token_stats` (Task 3).
- Üretir:
  - `deriveTokenAddress(factory, salt, name, symbol, uri, creator, curve) → Address`
  - `admit(tx, deployment, ev: LaunchedEvent) → 'admitted'`, aksi hâlde `throw new NonCanonicalLaunch(...)`

- [ ] **Adım 1: Doğrulama pipeline'daki YERİ ve MALİYETİ**

Üç bağımsız kapı. **Hiçbiri diğerini kapsamaz** ve bunu tek tek yazmak zorunludur:

| Kapı | Nerede | Neyi yakalar | Neyi YAKALAMAZ | Maliyet |
|---|---|---|---|---|
| **1. Adres filtresi** — `eth_getLogs({address: factory})` | Task 5 Faz 1, **çekme** anı | Yabancı bir emitter'ın uydurduğu `Launched`. Log **hiç çekilmez**. | Yapılandırılmış factory adresinin kendisi bir taklitse. | **Sıfır.** Filtre RPC tarafında. |
| **2. Yerel CREATE2 yeniden türetmesi** | `admit()`, **kabul** anı | (a) `LaunchToken` bytecode'u **bizim derlemediğimizden** farklı bir "factory" — örneğin `mint()` eklenmiş bir token. creationCode farklı → keccak farklı → adres tutmaz. (b) Yapılandırılmış factory adresinin yanlış olması (rogue factory kanonik token üretmiyorsa). | Doğru bytecode'u kullanan gerçek bir factory'nin yanlış konfigürasyonu (o Task 11'in `deployment` kontrolüdür). | **Sıfır RPC.** Launch başına bir `keccak256`: 3.598 bayt creationCode + `abi.encode(name, symbol, uri, creator, curve, salt)` (~200–500 bayt) ≈ **4,1 KB**, JS'te ~10 µs. |
| **3. `eth_call isCanonical(token)`** | **Yalnızca Task 12'nin entegrasyon testi** | Yerel türetmenin zincirin kendi cevabıyla **uyuştuğunu**. | — | Launch başına 1 RPC. Sıcak yolda **gereksizdir** ve gaz sınırsız bir griefing yüzeyidir (ölçüldü: hasım bir token 3.000.000 gaz bütçesinin 2.958.151'ini yiyor, `try/catch`'li bir çağıran 8.000.000'ın 7.757.318'ini). |

**`Launched`'ın `salt`'ı tam bu iş için taşınıyor** (`LaunchFactory.sol:188-190`: "`salt` de taşınır ki doğrulama zincir dışında da tekrarlanabilsin"). Olay altı constructor argümanının **hepsini** artı `salt`'ı artı beklenen `token` adresini taşır — yani yerel türetme için gereken her şey olayın içindedir ve **ek çağrı gerekmez**.

```ts
export function deriveTokenAddress(
  factory: Address, salt: Hex,
  name: string, symbol: string, uri: string, creator: Address, curve: Address,
): Address {
  // `LaunchFactory._tokenAddress` ile BIREBIR ayni: alanlarin SIRASI
  // LaunchToken'in constructor'iyla ayni olmak ZORUNDA (LaunchFactory.sol:
  // 542-544 -- "herhangi biri dusurulurse sahteci o alani serbestce
  // degistirip kanonik kalabilir"). Bu sirayi `Surface.t.sol`'un constructor
  // tanimlayicisi pinliyor ve Task 1'in ABI parity testi burada tutuyor.
  const initCodeHash = keccak256(
    concatHex([
      LAUNCH_TOKEN_CREATION_CODE,
      encodeAbiParameters(
        [{type:'string'},{type:'string'},{type:'string'},{type:'address'},{type:'address'},{type:'bytes32'}],
        [name, symbol, uri, creator, curve, salt],
      ),
    ]),
  )
  return getAddress(`0x${keccak256(concatHex(['0xff', factory, salt, initCodeHash])).slice(-40)}`)
}
```

- [ ] **Adım 2: Reddedilen token ne olur — HALT**

```ts
export async function admit(tx, deployment, ev) {
  const expected = deriveTokenAddress(deployment.factory, ev.salt, ev.name, ev.symbol, ev.uri, ev.creator, ev.curve)
  if (expected.toLowerCase() !== ev.token.toLowerCase()) {
    await tx.query(`INSERT INTO rejected_launches (...) VALUES (...)`, [...])
    // HALT, "log ve devam et" DEGIL.
    //
    // GEREKCE: Kapi 1 (adres filtresi) sayesinde bu olay YALNIZCA gercek
    // factory'den gelebilir, ve gercek factory yalnizca `new LaunchToken`
    // ile urettigi tokenlari duyurur (LaunchFactory.sol:437). Yani bir
    // uyusmazlik ADVERSARIAL OLAMAZ; yalnizca iki sey olabilir:
    //   (a) dagitilmis factory'nin LaunchToken bytecode'u bizim
    //       `forge build` ciktimizdan FARKLI (surum/derleyici kaymasi), ya da
    //       yapilandirilmis factory adresi yanlis;
    //   (b) `LAUNCH_TOKEN_CREATION_CODE` bayat.
    // Ikisi de operasyonel acil durumdur. Sessizce atlamak, o launch'in
    // TUM ticaret gecmisini kalici olarak dusurur ve kimse farketmez.
    throw new NonCanonicalLaunch(ev.token, expected)
  }
  await tx.query(`INSERT INTO launches (...) VALUES (...) ON CONFLICT (token) DO NOTHING`, [...])
  await tx.query(`INSERT INTO creator_history (token, from_seq, creator) VALUES ($1,$2,$3)
                  ON CONFLICT DO NOTHING`, [ev.token, ev.seq, ev.creator])
  // curve_state ACILIS DEGERLERIYLE kurulur. Degerler `deployment`'tan
  // gelir ve `deployment` ZINCIRDEN okunmustur (Task 11) -- spec'ten veya
  // .env'den DEGIL. Testnet ile uretim yalnizca `V`'de ayrisir (tam 1000x),
  // yani yanlis profil market cap'i 1000 kat kaydirir ve baska hicbir
  // kontrol bunu gormez.
  await tx.query(`INSERT INTO curve_state (curve, token, virtual_token_reserves_tok,
                    virtual_quote_reserves_wei, real_token_reserves_tok,
                    real_quote_reserves_wei, last_seq)
                  VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT (curve) DO NOTHING`, [...])
  await tx.query(`INSERT INTO token_stats (...) VALUES (...) ON CONFLICT (token) DO NOTHING`, [...])
}
```

- [ ] **Adım 3: Testler**

```ts
it('gercek launch fixture i kabul edilir', () => { /* launch.json */ })

it('degistirilmis LaunchToken bytecode u ile uretilen token REDDEDILIR', () => {
  // forged.json: rogue factory + `mint()` eklenmis LaunchToken. Ayni
  // salt, ayni alanlar, FARKLI creationCode.
  expect(() => admit(tx, deployment, forged.launched)).rejects.toThrow(NonCanonicalLaunch)
})

it('tek bir alan degistirildiginde adres kaymaz DEMEZ -- alti alanin ALTISI da tasiyici', () => {
  // Alan atlamanin en olasi hali: `uri` turetmeden dusmek. O zaman sahteci
  // URI'yi serbestce degistirip kanonik kalabilirdi (LaunchFactory.sol:542).
  for (const field of ['name','symbol','uri','creator','curve','salt'] as const) {
    const mutated = { ...launch.launched, [field]: mutate(launch.launched[field]) }
    expect(deriveTokenAddress(...args(mutated))).not.toBe(launch.launched.token)
  }
})

it('reddedilen launch launches a GIRMEZ ve rejected_launches a girer', async () => {
  await expect(applyRange(...)).rejects.toThrow(NonCanonicalLaunch)
  // Transaction geri alindigi icin IKISI DE bos: reddin kaydi ayri bir
  // baglantida yazilir (Task 11), yoksa rollback onu da yutar.
  expect(await count('launches')).toBe(0)
})

it('bayat creationCode gercek bir launch i reddeder -- ve bu operasyonel bir tuzaktir', () => {
  // Bir baytini degistir: TUM launch'lar reddedilir. Task 1'in bytecode
  // parity kapisinin nicin var oldugu budur.
})
```

- [ ] **Adım 4: Commit**

```bash
git commit -m "feat(indexer): admit a launch only when the factory's own CREATE2 derivation reproduces it"
```

**Deliverable:** `forged.json` reddedilir, `launch.json` kabul edilir; altı alanın altısı için de adres kayması ölçülüp raporlanır.

---

### Task 7: `indexer/src/apply/trade.ts` — `trades`, `curve_state`, ve exactly-once

**Files:** Create `indexer/src/apply/trade.ts`, `indexer/test/apply-trade.test.ts`

- [ ] **Adım 1: Mutlak durum + sıra muhafızı**

```sql
-- `Trade` dort rezervin dordunu de tasidigi icin durum MUTLAK yazilir.
-- `WHERE last_seq < $seq` SIRA MUHAFIZIDIR: at-least-once teslimatta
-- yeniden oynatilan ESKI bir olay YENI durumu ezemez.
UPDATE curve_state SET
  virtual_token_reserves_tok = $2, virtual_quote_reserves_wei = $3,
  real_token_reserves_tok = $4,   real_quote_reserves_wei  = $5,
  last_seq = $1
WHERE curve = $6 AND last_seq < $1;
```

- [ ] **Adım 2: Sayaçlar — artımlı, ama ekleme GERÇEKTEN olduğunda**

`ON CONFLICT DO NOTHING` bir satırı idempotent yapar; **bir sayacı yapmaz.** `volume_total_wei += x` yeniden oynatmada iki kez uygulanır. Çözüm: artım `trades`'e satır **gerçekten eklendiğinde** yapılır:

```sql
WITH ins AS (
  INSERT INTO trades (...) VALUES (...)
  ON CONFLICT (event_seq) DO NOTHING
  RETURNING token, event_seq, is_buy, quote_amount_wei, block_time
)
UPDATE token_stats s SET
  volume_total_wei = s.volume_total_wei + ins.quote_amount_wei,
  trade_count      = s.trade_count + 1,
  buy_count        = s.buy_count + (CASE WHEN ins.is_buy THEN 1 ELSE 0 END),
  last_trade_seq   = GREATEST(COALESCE(s.last_trade_seq, 0), ins.event_seq),
  last_trade_at    = ins.block_time,
  last_buy_seq     = CASE WHEN ins.is_buy
                       THEN GREATEST(COALESCE(s.last_buy_seq, 0), ins.event_seq)
                       ELSE s.last_buy_seq END,
  last_buy_at      = CASE WHEN ins.is_buy THEN ins.block_time ELSE s.last_buy_at END
FROM ins WHERE s.token = ins.token;
```

`market_cap_wei` ve `ath_market_cap_wei` **mutlak** yazılır (aşağı, Task 10'un formülüyle aynı `mulDiv` tabanı):

```sql
UPDATE token_stats s SET
  market_cap_wei     = div($2::numeric * $3::numeric, $4::numeric),
  ath_market_cap_wei = GREATEST(s.ath_market_cap_wei, div($2::numeric * $3::numeric, $4::numeric))
WHERE s.token = $1 AND COALESCE(s.last_trade_seq, 0) <= $5;
```

- [ ] **Adım 3: `Completed`**

```sql
UPDATE curve_state SET complete = true, completed_seq = $1, pool_seed_supply_tok = $2
WHERE curve = $3 AND NOT complete;
```
`Completed` **her zaman** aynı tx'te bir `Trade`'den **sonra** gelir (`_settleBuy`: defter → `Trade` → `Completed`). Test: `buy_exact_quote_in_clamped.json` uygulandıktan sonra `complete = true`, `real_token_reserves_tok = 0`, ve `pool_seed_supply_tok` olaydaki değer.

- [ ] **Adım 4: Testler — üç arıza kipi**

```ts
it('ayni araligi iki kez uygulamak veritabanini AYNI birakir', async () => {
  await applyAll(events); const a = await snapshot(pool)
  await applyAll(events); const b = await snapshot(pool)
  expect(b).toEqual(a)   // snapshot = her tablonun event_seq'e gore siralanmis dokumu
})

it('yeniden oynatilan ESKI bir Trade YENI durumu ezmez', async () => {
  await applyTrade(tradeAtSeq(100)); const after = await curveState()
  await applyTrade(tradeAtSeq(50))
  expect(await curveState()).toEqual(after)
})

it('sifir-creator lu bir curve de creator_fee_wei = 0 kabul edilir', async () => {
  // zero_creator.json: TEK Deposited. "Her islem iki Deposited uretir"
  // varsayan bir handler burada kirilir.
  await applyAll(zeroCreator.events)
  expect((await trade()).creator_fee_wei).toBe('0')
})

// is_dev'in noktasal olmasi BUGUNDEN test edilir -- creator degistirilebilir
// OLMADIGI halde. Boylece o gun geldiginde egzersiz edilmemis bir kod yolu
// kalmaz.
it('creator_at sentetik bir devir sonrasi is_dev i noktasal cevirir', async () => {
  await applyAll(launch.events)          // creator_history: (token, launchSeq, A)
  await applyTrade(tradeBy('A', 200n))
  await applyTrade(tradeBy('B', 400n))
  await pool.query(`INSERT INTO creator_history VALUES ($1, 300, $2)`, [token, B])
  const rows = await pool.query(
    `SELECT event_seq, trader = creator_at(token, event_seq) AS is_dev
     FROM trades ORDER BY event_seq`)
  expect(rows.rows).toEqual([
    { event_seq: '200', is_dev: true  },   // A, devirden ONCE
    { event_seq: '400', is_dev: true  },   // B, devirden SONRA
  ])
  // Guncel creator'a duz bir JOIN ikisinden BIRINI yanlis verirdi.
})
```

- [ ] **Adım 5: Commit**

```bash
git commit -m "feat(indexer): apply trades so that a replayed range cannot double-count"
```

**Deliverable:** aynı aralığın iki kez uygulanması sonrası `snapshot` eşit; sıra muhafızı testi yeşil.

---

### Task 8: `indexer/src/apply/transfer.ts` — `holders`

**Files:** Create `indexer/src/apply/transfer.ts`, `indexer/test/apply-transfer.test.ts`

- [ ] **Adım 1: Delta yalnızca yeni satır için**

```sql
WITH ins AS (
  INSERT INTO token_transfers (...) VALUES (...)
  ON CONFLICT (event_seq) DO NOTHING
  RETURNING token, event_seq, from_addr, to_addr, amount_tok
),
-- MINT: from = 0x0. Sifir adres icin holders satiri ACILMAZ -- acilsaydi
-- bakiyesi negatif olur ve CHECK patlardi. Mint yolu `LaunchToken`'in
-- constructor'inda BIR KEZ calisir (tum arz curve'e).
debit AS (
  INSERT INTO holders (token, holder, balance_tok, last_seq)
  SELECT token, from_addr, -amount_tok, event_seq FROM ins
  WHERE from_addr <> '0x0000000000000000000000000000000000000000'
  ON CONFLICT (token, holder) DO UPDATE
    SET balance_tok = holders.balance_tok - EXCLUDED.balance_tok * -1,
        last_seq = GREATEST(holders.last_seq, EXCLUDED.last_seq)
  RETURNING 1
)
INSERT INTO holders (token, holder, balance_tok, last_seq)
SELECT token, to_addr, amount_tok, event_seq FROM ins
-- YAKMA yolu (to = 0x0) BUGUN ULASILAMAZDIR: OZ'un ERC20'si `to ==
-- address(0)` icin `ERC20InvalidReceiver` ile revert eder, yani
-- `LaunchToken` yakilamaz. Koruma yine de duruyor ve ACIK HUCRE olarak
-- burada yaziyor: sentetik bir fixture ile test edilir, ama zincirde
-- tetiklenemez. Uydurma bir gerekce yazmak yerine ulasilamazligi kayda
-- geciyoruz.
WHERE to_addr <> '0x0000000000000000000000000000000000000000'
ON CONFLICT (token, holder) DO UPDATE
  SET balance_tok = holders.balance_tok + EXCLUDED.balance_tok,
      last_seq = GREATEST(holders.last_seq, EXCLUDED.last_seq);
```

`holder_count` **mutlak** yazılır ve **curve hariç tutulur**:

```sql
UPDATE token_stats s SET holder_count = (
  SELECT count(*) FROM holders h
  JOIN launches l ON l.token = h.token
  JOIN curve_state c ON c.token = h.token
  WHERE h.token = s.token AND h.balance_tok > 0 AND h.holder <> c.curve
) WHERE s.token = $1;
```

Curve'ün hariç tutulması **zorunludur**: `LaunchToken` tüm arzı (1e27) constructor'da curve'e basar, yani launch anında curve **tek** holder'dır ve `holder_count` **1 değil 0** olmalıdır.

- [ ] **Adım 2: Kaybı gürültülü yapan iddia**

```ts
// Bir `Transfer` DUSURULMUSSE bu esitlik kirilir. Adres filtresi/EIP-7708
// riskinin TEK calistirilabilir kapatmasi budur -- eksik veri baska hicbir
// yerde kendini gostermez.
it('her token icin bakiyeler toplami TOTAL_SUPPLY a esittir', async () => {
  const { rows } = await pool.query(`
    SELECT h.token, sum(h.balance_tok)::text AS total
    FROM holders h GROUP BY h.token`)
  for (const r of rows) expect(r.total).toBe('1000000000000000000000000000')
})

it('launch aninda holder_count 0 dir (curve haric tutulur)', async () => {
  await applyAll(launch.events)
  expect((await stats()).holder_count).toBe(0)
  expect((await holder(curve)).balance_tok).toBe('1000000000000000000000000000')
})

it('alim sonrasi holder_count 1 dir', async () => {
  await applyAll([...launch.events, ...buyExactTokensOut.events])
  expect((await stats()).holder_count).toBe(1)
})

it('bakiyesi sifira dusen holder sayilmaz ama satiri kalir', async () => {
  await applyAll([...launch.events, ...buy.events, ...sellAll.events])
  expect((await stats()).holder_count).toBe(0)
  expect((await holder(trader)).last_seq).toBeGreaterThan(0n)
})

it('bir tek ticaret isleminde LaunchToken Transfer i DISINDA hicbir sey holders a dokunmaz', async () => {
  // buy_exact_tokens_out.json fixture'i escrow yatirimlarini ve iadeyi de
  // icerir; bunlar canli zincirde `0xfff...ffe` Transfer'lari uretir.
  // Fixture'a olculmus 7708 loglari ENJEKTE edilir ve holder deltasinin
  // yalnizca token miktari kadar oldugu iddia edilir.
  expect(() => applyAll(withInjected7708Logs)).toThrow(ForbiddenEmitter)
})
```

- [ ] **Adım 3: Commit**

```bash
git commit -m "feat(indexer): derive holders from token transfers, with the sum pinned to total supply"
```

**Deliverable:** `SUM(balance_tok) = 1e27` her fixture senaryosunda; bir `Transfer` elle atlandığında test kırılır.

---

### Task 9: `indexer/src/apply/fees.ts` — `fee_balances`

**Files:** Create `indexer/src/apply/fees.ts`, `indexer/test/apply-fees.test.ts`

- [ ] **Adım 1: Uygulama**

Task 8'in kalıbı: `fee_events`'e `ON CONFLICT DO NOTHING ... RETURNING`, sonra `fee_balances` üzerinde artım. `deposit` → `deposited_total_wei += a`, `claimable_wei += a`. `claim` → `claimed_total_wei += a`, `claimable_wei -= a`. `claimable_is_the_difference` CHECK'i her yazımda escrow'un defter eşitliğini doğrular.

- [ ] **Adım 2: Escrow'un ölçülmüş kısıtını yansıt**

`FeeEscrow`'un NatSpec'i (kısıt 1) canlı Arc'ta **ölçülmüş** bir olguyu kaydediyor: escrow'un bakiyesi `deposit()` dışından da artabilir (`USDC.transfer(escrow, x)` başarılı olur, `receive()` hiç çalışmaz), ve o para **talep edilemez**. Yani:

- Doğru invariant `totalOwed <= balance`'dır, `==` değil.
- `SUM(fee_balances.claimable_wei)` escrow'un zincir üstü bakiyesinin bir **alt sınırıdır**.
- **Arayüz escrow'un bakiyesini "talep edilebilir ücret" diye göstermemelidir** (NatSpec aynen bunu söylüyor). Bu yüzden `queries.ts`'te escrow bakiyesini döndüren **hiçbir** fonksiyon yoktur ve bu bir eksiklik değil karardır.

```ts
it('claimable her zaman deposited - claimed', async () => { /* CHECK zaten uygular; bu iddia CHECK'in var oldugunu pinler */ })

it('claim sonrasi claimable sifir, deposited_total korunur', async () => {
  await applyAll([...buy.events, ...claim.events])
  const b = await feeBalance(creator)
  expect(b.claimable_wei).toBe('0')
  expect(b.deposited_total_wei).toBe(buy.events.find(e => e.kind==='deposited' && e.recipient===creator)!.amount.toString())
})

it('protokol ile creator paylari AYRI alicilardir', async () => {
  await applyAll(buy.events)
  expect(await count('fee_balances')).toBe(2)
})

it('Deposited.from curve adresidir -> ucret launch basina dokulebilir', async () => {
  const { rows } = await pool.query(
    `SELECT l.token, sum(f.amount_wei)::text s FROM fee_events f
     JOIN curve_state c ON c.curve = f.from_addr
     JOIN launches l ON l.token = c.token
     WHERE f.kind='deposit' AND f.recipient = $1 GROUP BY l.token`, [creator])
  expect(rows).toHaveLength(1)
})
```

- [ ] **Adım 3: Commit**

```bash
git commit -m "feat(indexer): track claimable fees as a lower bound, never as the escrow's balance"
```

---

### Task 10: `packages/db/src/queries.ts` — türetilmiş okuma modeli

**Files:** Create `packages/db/src/queries.ts`, `packages/db/migrations/007_views.sql`, `packages/db/test/{queries,ordering}.test.ts`

- [ ] **Adım 1: `token_overview` view'i — kontratla birebir aritmetik**

```sql
CREATE VIEW token_overview AS
SELECT
  l.token, l.curve, l.name, l.symbol, l.uri, l.launch_creator,
  creator_at(l.token, COALESCE(cs.last_seq, l.created_seq)) AS fee_creator,
  cs.virtual_token_reserves_tok, cs.virtual_quote_reserves_wei,
  cs.real_token_reserves_tok,    cs.real_quote_reserves_wei,
  cs.complete, cs.completed_seq, cs.pool_seed_supply_tok,

  -- MARKET CAP. `CurveMath.marketCap` = FullMath.mulDiv(Vq, N, Vt), yani
  -- TABANA yuvarlar. Postgres'in `div(numeric,numeric)` fonksiyonu sifira
  -- dogru keser; negatif olmayan girdide bu tam olarak floor'dur. Ayni
  -- aritmetik, ayni yon: indexer kontrattan SAPAMAZ.
  div(cs.virtual_quote_reserves_wei * d.total_supply_tok, cs.virtual_token_reserves_tok)
    AS market_cap_wei,

  -- FIYAT: TAM token basina wei. market_cap_wei / 1e9 ile birebir tutarli
  -- (N = 1e27, olcek 1e18).
  div(cs.virtual_quote_reserves_wei * 1000000000000000000::numeric,
      cs.virtual_token_reserves_tok) AS price_wei_per_token,

  -- GRADUATION ILERLEMESI, milyonda pay.
  --
  -- TANIM: SATILAN token orani, `sold/S`. Toplanan quote orani
  -- (`realQuoteReserves / R`) DEGIL, ve bu bir tercih degil bir turetme:
  -- `quoteBuyCost` her alimda `floor(...) + 1` doner (CurveMath.sol:52),
  -- yani biriken quote her alimda 1 wei FAZLA toplanir ve tamamlanma aninda
  -- `realQuoteReserves = R + (alim sayisi)` civaridir -- yani quote tabanli
  -- bir ilerleme %100'u ASAR. Token tabanli olan ise `realTokenReserves`
  -- tam sifirlandiginda tam 1.000.000 verir, ki `complete` de o an cevrilir
  -- (BondingCurve.sol:485).
  --
  -- KALAN YUKARI yuvarlanir (`ceil`), boylece bir wei token kaldiginda deger
  -- 999.999'dur, 1.000.000 DEGIL. Asagi yuvarlamak, curve kapanmadan
  -- %100 gostermek olurdu.
  1000000 - ceil(cs.real_token_reserves_tok * 1000000::numeric / d.sale_supply_tok)::int
    AS progress_ppm,

  -- GRADUATION RAISE. `CurveMath.graduationRaise` = mulDiv(V, S, T-S), floor.
  div(d.virtual_quote_reserves_wei * d.sale_supply_tok,
      d.virtual_token_reserves_tok - d.sale_supply_tok) AS graduation_raise_wei,

  ts.holder_count, ts.volume_total_wei, ts.volume_24h_wei,
  ts.ath_market_cap_wei, ts.trade_count, ts.buy_count,
  ts.last_trade_seq, ts.last_buy_seq, ts.last_trade_at, ts.last_buy_at,
  l.created_seq, l.created_at
FROM launches l
JOIN curve_state cs ON cs.token = l.token
JOIN token_stats  ts ON ts.token = l.token
CROSS JOIN deployment d;
```

Sabitlenmiş beklenen değerler (elle türetilmiş, **kütüphaneyi çağırarak değil**):

```ts
// URETIM profili: V = 4_292e18, T = 1_073e24 (= 1,073e27), N = 1e27
//   market_cap = floor(4292e18 * 1e27 / 1,073e27) = 4000e18 wei = 4.000 USDC
//   price      = floor(4292e18 * 1e18 / 1,073e27) = 4e12 wei = 0,000004 USDC/token
it('acilis market cap i uretim profilinde tam 4.000 USDC', async () => {
  expect((await overview(token)).market_cap_wei).toBe('4000000000000000000000')
  expect((await overview(token)).price_wei_per_token).toBe('4000000000000')
})

// TESTNET profili: V = 4_292e15 -> market_cap = 4e18 wei = 4 USDC.
// Bu ayni zamanda `LaunchFactory.MIN_OPENING_MARKET_CAP`'in TA KENDISIDIR
// (4e18) -- yani testnet profili tabanin TAM UZERINDE oturur.
it('acilis market cap i testnet profilinde tam 4 USDC', async () => {
  expect((await overview(token)).market_cap_wei).toBe('4000000000000000000')
})

// PROGRESS: S = 793_100_000e18 = 793100000000000000000000000
it('progress_ppm kenar degerleri', async () => {
  await setReserves({ real_token_reserves_tok: S })       // hic satilmadi
  expect((await overview(token)).progress_ppm).toBe(0)
  await setReserves({ real_token_reserves_tok: S / 2n })  // yarisi
  expect((await overview(token)).progress_ppm).toBe(500_000)
  await setReserves({ real_token_reserves_tok: 1n })      // BIR WEI kaldi
  expect((await overview(token)).progress_ppm).toBe(999_999)  // 1.000.000 DEGIL
  await setReserves({ real_token_reserves_tok: 0n })      // tukendi
  expect((await overview(token)).progress_ppm).toBe(1_000_000)
})

// GRADUATION RAISE: testnet profili `MIN_GRADUATION_RAISE`'in TAM UZERINDE.
it('graduation raise testnet profilinde 12_161_433_369_060_378_706 wei', async () => {
  expect((await overview(token)).graduation_raise_wei).toBe('12161433369060378706')
})
```

- [ ] **Adım 2: "Recent buys" sıralaması — KARAR**

**Karar: `ORDER BY token_stats.last_buy_seq DESC`, keyset sayfalama ile. Zaman kolonu sıralamada HİÇ kullanılmaz.**

Spec §6.3 `last_buy_at` üzerinde azalan sıra diyor. Değiştirildi, üç gerekçeyle — ilki ölçüm:

1. **Timestamp yarı yarıya bağlanır.** Ölçüldü (Arc testnet, blok 54.325.867–54.326.267): 400 ardışık blok çiftinin **197'si (%49,1)** aynı timestamp'i taşıyor, 203'ü artıyor, **0'ı azalıyor**. Yani `ORDER BY last_buy_at DESC` sıralamanın yarısını **tanımsız** bırakır. Postgres eşit anahtarlar için sıra garanti etmez ve plan değiştiğinde sıra da değişir.
2. **Kararsız sıra sayfalamayı bozar.** `LIMIT/OFFSET` veya keyset, iki sorgu arasında bağlı satırların yeri değiştiğinde **satır tekrarlar veya atlar**. Bu kullanıcıya görünen bir hatadır ve teşhisi zordur — "Explore'da aynı token iki kez çıkıyor".
3. **`last_buy_seq` zincirin kendi sırasıdır.** `event_seq = block_number << 20 | log_index` kesin bir **tam sıradır** ve "en son alım" ifadesinin zincirdeki tek doğru karşılığıdır. Blok içi iki alım arasında hangisinin daha yeni olduğu sorusunun cevabı log sırasıdır, timestamp değildir (ikisi aynıdır).

Spec'in gerekçesinin **korunan** yarısı: etiket ile davranış ayrışmamalı — kullanıcı yenilik bekler, ivme değil. `last_buy_seq` bunu **daha kesin** karşılar. `last_buy_at` kolonu kalır ve **yalnızca gösterime** ("3 dk önce") hizmet eder.

```sql
CREATE INDEX token_stats_last_buy_idx ON token_stats (last_buy_seq DESC)
  WHERE last_buy_seq IS NOT NULL;
```
Tek indeksli kolon, keyset sayfalama:
```sql
SELECT ... FROM token_overview
WHERE last_buy_seq IS NOT NULL AND ($1::bigint IS NULL OR last_buy_seq < $1)
ORDER BY last_buy_seq DESC LIMIT $2;
```
Kısmi indeks aynı zamanda bir **ürün** kararıdır: hiç alım görmemiş token "Recent buys" beslemesinde görünmez.

- [ ] **Adım 3: Zamana göre sıralamayı yasaklayan çalıştırılabilir kapı**

```ts
// Bu kural bir yorumda dursa unutulur. Kaynak metnini okuyup iddia etmek
// onu KAPIYA cevirir: `ORDER BY ... _at` yazan bir sorgu CI'da kirilir.
it('hicbir sorgu bir zaman kolonuna gore siralamaz', () => {
  const src = readFileSync(new URL('../src/queries.ts', import.meta.url), 'utf8')
  const orderBys = [...src.matchAll(/order\s+by\s+([^;`)]+)/gi)].map((m) => m[1])
  expect(orderBys.length).toBeGreaterThan(0)
  for (const clause of orderBys) expect(clause).not.toMatch(/_at\b/)
})
```

- [ ] **Adım 4: Kalan sorgular**

```ts
// Explore siralamalari. Spec 7.1: Recent buys / Newest / Oldest / Market cap / Volume
export const SORTS = {
  recentBuys: 'last_buy_seq DESC',
  newest:     'created_seq DESC',
  oldest:     'created_seq ASC',
  marketCap:  'market_cap_wei DESC',
  volume:     'volume_24h_wei DESC',
} as const

listTokens(pool, { sort, ageDays, cursor, limit })  // yas filtresi created_at uzerinde (PENCERE, siralama degil)
getTokenOverview(pool, token)
listTrades(pool, token, { cursor, limit })          // ORDER BY event_seq DESC; is_dev = trader = creator_at(...)
listHolders(pool, token, { limit })                 // curve HARIC, balance_tok DESC
listLaunchesByCreator(pool, creator)                // launches.launch_creator -- "kim baslatti"
getClaimableFees(pool, recipient)
listCreatorEarningsByLaunch(pool, creator)          // fee_events.from_addr -> curve -> token
```

`SORTS` bir sabit nesnedir ve `sort` parametresi onun anahtarlarıyla sınırlıdır — sıralama ifadesi **hiçbir zaman** kullanıcı girdisinden birleştirilmez.

- [ ] **Adım 5: Commit**

```bash
git commit -m "feat(db): order the recent-buys feed by chain sequence, not by a timestamp that ties half the time"
```

**Deliverable:** `token_overview`'ın beş sabitlenmiş değeri (4.000 USDC, 4 USDC, dört `progress_ppm` kenarı, graduation raise) yeşil; sıralama kapısı yeşil.

---

### Task 11: `indexer/src/run.ts` — döngü, atomik aralık, RPC hata politikası

**Files:** Create `indexer/src/run.ts`, `indexer/src/config.ts`, `indexer/test/run.test.ts`; Modify `indexer/src/index.ts`, `.env.example`

- [ ] **Adım 1: Açılış — `deployment`'ı ZİNCİRDEN oku ve uyuşmazlıkta DUR**

```ts
// Profil (V, T, S) factory'nin public immutable'larindan `eth_call` ile
// okunur; spec'ten veya .env'den KOPYALANMAZ. Gerekce: testnet ile uretim
// YALNIZCA `V`'de ayrisir (tam 1000x, spec 5.3) ve yanlis `V` market cap'i
// 1000 kat kaydirir -- baska hicbir kontrol bunu gormez.
const onChain = await readFactoryProfile(client, cfg.factory)
await assertArcChain(client)                       // chainId 5042002
const stored = await getDeployment(pool)
if (stored && !sameDeployment(stored, onChain, cfg)) {
  // HALT. Iki dagitimin verisini ayni veritabaninda karistirmak, market
  // cap'i, ilerlemeyi ve ucret muhasebesini sessizce bozar ve GERI
  // ALINAMAZ (hangi satirin hangi dagitimdan geldigi kaydedilmemistir).
  throw new DeploymentMismatch(stored, onChain)
}
```

- [ ] **Adım 2: Aralık başına TEK transaction**

```ts
const range = nextRange(cursor, await finalizedHead(client), cfg.maxSpan)
if (!range) { await sleep(cfg.pollMs); continue }

const events = await fetchRange(client, watch, range.from, range.to)

const tx = await pool.connect()
try {
  await tx.query('BEGIN')
  // SIRA BAGLAYICIDIR ve `fetchRange` zaten event_seq'e gore sirali
  // donduruyor: `launch()` mint `Transfer`'ini `Launched`'DAN ONCE yayar,
  // yani `Launched` gorulmeden gelen bir `Transfer` OLABILIR. Bu yuzden
  // once TUM `launched` olaylari kabul edilir, sonra geri kalani
  // event_seq sirasinda uygulanir.
  for (const e of events) if (e.kind === 'launched') await admit(tx, deployment, e)
  for (const e of events) if (e.kind !== 'launched') await applyEvent(tx, deployment, e)
  await refreshTouchedStats(tx, touchedTokens)
  await refreshStale24hVolume(tx, 500)
  // IMLEC AYNI TRANSACTION ICINDE ILERLER. Exactly-once semantiginin
  // TAMAMI bu satirdir: cokme -> rollback -> eski imlecten tekrar -> ayni
  // satirlar tekrar upsert -> AYNI son durum.
  await tx.query('UPDATE sync_state SET last_block = $1, updated_at = now() WHERE id = 1', [range.to])
  await tx.query('COMMIT')
} catch (e) {
  await tx.query('ROLLBACK')
  // Reddedilen launch AYRI bir baglantida kaydedilir, yoksa rollback onu
  // da yutar ve operator elinde hicbir iz olmadan durmus bir surec bulur.
  if (e instanceof NonCanonicalLaunch) await recordRejection(pool, e)
  throw e
} finally { tx.release() }
```

`refreshStale24hVolume(tx, 500)`: `volume_24h_wei` **pencereli** bir toplamdır — girişler zamanla düşer, yani artımlı tutulamaz. Dokunulan tokenlar aynı transaction'da yeniden hesaplanır; dokunulmayanlar için her turda `volume_24h_refreshed_at` en eski 500 token tazelenir. Bu, değerin **en kötü durumda** ne kadar bayat olabileceğini token sayısına ve poll aralığına bağlı, hesaplanabilir bir sayı yapar.

- [ ] **Adım 3: RPC yalan söylediğinde / geride kaldığında — on vaka**

| Vaka | Politika | Nerede kapanır |
|---|---|---|
| `finalized` geriye düşer (LB arkasında farklı düğüm) | `nextRange` `null`, no-op | Task 2 |
| `finalized > latest` (ölçüldü) | `latest` hiç okunmaz | Task 2 `finalizedHead` |
| Yanlış zincir | `assertArcChain` ile açılışta çök | mevcut `packages/shared` |
| Yanlış dağıtım / profil | `DeploymentMismatch`, HALT | bu görev Adım 1 |
| Aralık/sonuç sınırı (3 hata kodu) | `-32602`'nin önerdiği aralık, yoksa ikiye böl | Task 5 Adım 2 |
| Tek blok 20.000 sonucu aşıyor | `SingleBlockTooLarge`; adres filtresini bölmeye geç | Task 5 |
| Aralık dışı log | `LogOutOfRange`, HALT | Task 5 Adım 3 |
| `removed: true` | `RemovedLog`, HALT (Arc'ta imkânsız) | Task 5 Adım 3 |
| `blockTimestamp` yok | toplu `eth_getBlockByNumber` yedek yolu, **gürültülü** | Task 5 Adım 3 |
| 429 / geçici 5xx / soket | 5 denemeye kadar üstel geri çekilme + jitter; **imleç asla ilerlemez** | bu görev |

- [ ] **Adım 4: Testler**

```ts
it('commit oncesi cokme imleci ILERLETMEZ ve satir birakmaz', async () => {
  await expect(runOnce(clientThatFailsMidRange)).rejects.toThrow()
  expect(await lastBlock()).toBe(startBlock)
  expect(await count('trades')).toBe(0)
})

it('ayni araligi iki kez kosturmak veritabanini AYNI birakir', async () => {
  await runOnce(client); const a = await snapshot(pool)
  await pool.query('UPDATE sync_state SET last_block = $1', [startBlock])   // imleci geri al
  await runOnce(client); const b = await snapshot(pool)
  expect(b).toEqual(a)
})

it('head geriye duserse hicbir sey yapmaz', async () => {
  const before = await snapshot(pool)
  await runOnce(clientWithRegressingFinalized)
  expect(await snapshot(pool)).toEqual(before)
})

it('dagitim uyusmazliginda acilista durur', async () => {
  await expect(start({ ...cfg, factory: OTHER })).rejects.toThrow(DeploymentMismatch)
})

it('kanonik olmayan launch ta durur ama reddi KAYDEDER', async () => {
  await expect(runOnce(clientEmittingForged)).rejects.toThrow(NonCanonicalLaunch)
  expect(await count('rejected_launches')).toBe(1)   // rollback bunu yutmadi
  expect(await count('launches')).toBe(0)
})
```

- [ ] **Adım 5: Commit**

```bash
git commit -m "feat(indexer): advance the cursor inside the write, so a crash costs nothing but a replay"
```

**Deliverable:** aralık ortasında öldürülen bir süreç yeniden başlatıldığında `snapshot` hiç ölmemiş bir koşunun snapshot'ıyla eşit.

---

### Task 12: Canlı Arc testnet'e karşı entegrasyon testi

Bu depodaki her ciddi kusur **çalıştırılarak** bulundu. Fixture'lar gerçek yürütmeden gelir ama `anvil` Arc'ı simüle **edemez** (spec §3.3): EIP-7708 logları, native USDC davranışı ve blocklist yalnızca gerçek RPC'de görünür.

**Files:** Create `indexer/test/integration/live.test.ts`, `indexer/vitest.config.ts`'e ayrı proje; Modify `.github/workflows/node.yml`

**Ön koşul:** Faz 1d'nin Arc testnet deploymentı. `ARC_FACTORY_ADDRESS` yoksa test **atlamaz, çöker** — bir entegrasyon testinin sessizce atlanması Faz 0'ın `continue-on-error` dersinin aynısıdır. CI'da ayrı, **engellemeyen** bir job olarak koşar (fork job'ıyla aynı desen), ama **adım seviyesinde** `continue-on-error` ile — job seviyesinde değil, çünkü o hâlde başarısızlık yeşil görünür (devir listesi satır 41).

- [ ] **Adım 1: Senaryo**

Gerçek bir cüzdanla (şifreli keystore, `.env`'de anahtar yok) canlı Arc testnet'te:
1. `launch("ArcpadIT", "AIT", "ipfs://it")`
2. `buyExactTokensOut` bir miktarla, `maxQuoteIn` fazla ödemeli → **iade dalı**
3. `buyExactQuoteIn` küçük bir bütçeyle
4. `sellExactTokensIn` alınanın yarısı
5. `FeeEscrow.claim(creator)`

Sonra indexer'ı `start_block = launch bloğu`'ndan koştur ve iddia et.

- [ ] **Adım 2: İddialar — yalnızca canlıda ölçülebilenler**

```ts
// (1) EIP-7708: canli bir ALIM isleminde emitter'a gore log dokumu.
//     Bu iddia FIXTURE'LARDA YAZILAMAZ, cunku Foundry 7708 logu uretmez.
it('bir alim isleminde token Transfer i DISINDA holders a hicbir sey girmez', async () => {
  const receipt = await client.getTransactionReceipt({ hash: buyTx })
  const byEmitter = groupBy(receipt.logs.filter(isTransferTopic), (l) => l.address.toLowerCase())
  // Native hareketler: alici->curve, curve->escrow (x1-2), curve->alici iade
  expect(byEmitter[EIP7708_SYSTEM_EMITTER].length).toBeGreaterThanOrEqual(2)
  expect(byEmitter[token.toLowerCase()]).toHaveLength(1)          // TEK gercek token Transfer'i
  expect(byEmitter[USDC_ERC20_ADDRESS]).toBeUndefined()           // ERC-20 giris noktasi kullanilmadi
  // Ve indexer YALNIZCA token Transfer'ini gordu:
  expect(await count('token_transfers')).toBe(2)                  // mint + alim
  expect((await holder(trader)).balance_tok).toBe(tokensOut.toString())
})

// (2) YEREL TURETME ZINCIRIN CEVABIYLA UYUSUR. Task 6 sicak yolda
//     `isCanonical` cagirmiyor; bu testin isi o kararin dogru olduğunu
//     KANITLAMAK.
it('deriveTokenAddress ile isCanonical ayni cevabi verir', async () => {
  expect(deriveTokenAddress(factory, salt, name, symbol, uri, creator, curve)).toBe(token)
  expect(await client.readContract({ address: factory, abi: launchFactoryAbi,
    functionName: 'isCanonical', args: [token] })).toBe(true)
  // Ve sahte bir token icin ikisi de reddeder.
  expect(await client.readContract({ ..., args: [forgedToken] })).toBe(false)
})

// (3) `predictAddresses` ile turetmenin ORTUSMESI. `Launched` olayindaki
//     token adresini turetmek ile factory'nin kendi onizlemesi ayni
//     CREATE2'yi kullanir; ikisinin ayrisması creationCode kaymasi demektir.
it('predictAddresses launch oncesi ayni adresi verir', async () => { ... })

// (4) ESCROW ODEME GUCU. FeeEscrow'un `totalOwed <= balance` invariant'i.
//     `==` DEGIL: escrow'a dogrudan gonderilen USDC talep edilemez
//     (kontratin kisit 1'i, canlida olculmus).
it('claimable toplami escrow bakiyesini ASMAZ', async () => {
  const { rows } = await pool.query('SELECT COALESCE(sum(claimable_wei),0)::text s FROM fee_balances')
  expect(BigInt(rows[0].s)).toBeLessThanOrEqual(await client.getBalance({ address: escrow }))
  // ve kontratin kendi defteriyle ORTUSUR
  expect(BigInt(rows[0].s)).toBe(await client.readContract({ ..., functionName: 'totalOwed' }))
})

// (5) REZERV PARITESI. `curve_state` yalnizca olaylardan kuruldu; zincire
//     hic sorulmadi. Simdi soruluyor.
it('curve_state zincirin dort rezerviyle birebir ayni', async () => {
  const s = await curveState(curve)
  for (const f of ['virtualTokenReserves','virtualQuoteReserves','realTokenReserves','realQuoteReserves'])
    expect(BigInt(s[snake(f)])).toBe(await client.readContract({ address: curve, abi: bondingCurveAbi, functionName: f }))
})

// (6) TIMESTAMP TEKRARI CANLIDA. Olculmustu (%49,1); indexer'in sirasi
//     buna DUYARSIZ olmali.
it('ayni timestamp li iki alim event_seq e gore dogru siralanir', async () => {
  const rows = await listTrades(pool, token, { limit: 100 })
  const ties = rows.filter((r, i) => i > 0 && +r.block_time === +rows[i-1].block_time)
  // Ties BULUNMASI beklenir degil, ama bulundugunda sira event_seq'i izler.
  expect(rows.map(r => BigInt(r.event_seq))).toEqual([...rows.map(r => BigInt(r.event_seq))].sort((a,b) => (b>a?1:-1)))
})

// (7) IKINCI KOSU IDEMPOTENT -- GERCEK zincir verisiyle.
it('imleci geri alip yeniden kosturmak ayni veritabanini verir', async () => { ... })
```

- [ ] **Adım 3: Commit**

```bash
git commit -m "test(indexer): index a real Arc launch and prove EIP-7708 never reaches the holder ledger"
```

**Deliverable:** `pnpm --filter @arcpad/indexer test:live` yeşil; iddia (1)'in ölçülen emitter dökümü rapora yazılır.

---

## Faz 3 (indexer dikeyi) tamamlanma ölçütü

- [ ] `pnpm -r test`, `pnpm -r typecheck`, `pnpm run lint`, `pnpm run fmt:check` temiz
- [ ] `forge test --root contracts --no-match-path 'test/fork/*'` **her iki profilde** yeşil ve `Surface.t.sol` 25/25 (Task 4'ün `foundry.toml` değişikliği hiçbir izni düşürmedi)
- [ ] `git diff --exit-code -- contracts/fixtures` `make fixtures` sonrası temiz
- [ ] `contracts/src/` **hiç değişmedi** (`git diff --stat main -- contracts/src` boş)
- [ ] ABI parity kapısı: `LaunchToken`'a bir fonksiyon eklendiğinde kırıldığı **ölçüldü** ve raporda
- [ ] Adlandırma kapısı: `_uusdc` sonekli bir kolon eklendiğinde kırıldığı **ölçüldü**
- [ ] Fixture senaryo kümesi sekiz senaryonun **hepsini** kapsıyor ve kapsam testi iki yönlü
- [ ] `SUM(holders.balance_tok) = 1e27` sekiz senaryonun **her birinde**
- [ ] Aynı aralığı iki kez uygulamak `snapshot` eşitliği veriyor (Task 7, 11)
- [ ] Yeniden oynatılan eski bir olay yeni durumu ezmiyor (Task 7)
- [ ] `forged.json` reddedildi, süreç durdu, `rejected_launches` bir satır
- [ ] `token_overview`'ın beş sabitlenmiş değeri (4.000e18, 4e18, dört `progress_ppm` kenarı, 12.161.433.369.060.378.706) yeşil
- [ ] Canlı entegrasyon testinin yedi iddiası yeşil ve emitter dökümü raporda

## Faz 4'e devreden

- **`candles` / OHLCV** — kova ekseninin (timestamp mi blok mu) seçimi ayrı bir görev; `trades` geriye dönük üretim için yeterli.
- **`protocol_stats_daily`** — `fee_events.from_addr` üzerinden tam olarak türetilebilir; aynı kova sorunu.
- **`isCanonical` sıcak yolda** — kullanıcının adres yapıştırdığı yol (frontend/API) `Launched`'dan başlamaz, dolayısıyla yerel türetmeye veri bulamaz ve `isCanonical`'ı çağırmak **zorundadır**. O çağrı **hem `try/catch` hem açık gaz tavanı** kullanmalıdır; yalnızca biri yetmez (`LaunchFactory.sol:490-501`, ölçüldü).
- **Creator değiştirilebilirliği.** Faz 1d bu yolu tanımlayacak. Bu plan iki tarafı da doğru bırakıyor: `creator_history` + `creator_at()` bugün tek satırlıdır, o gün **yalnızca satır** ekler. **Kontrat tarafına yükümlülük:** creator değiştirilebilir olursa `Trade` olayı bir `creator` alanı **kazanmalıdır** — pump.fun'ın `TradeEvent`'i tam bu yüzden taşır. Aksi hâlde `is_dev`'in geçmişe dönük doğrusu, ayrı bir `CreatorUpdated` akışı ve tam bir yeniden oynatma olmadan kurulamaz. Ayrıca Task 1'in olay-kümesi iddiası o gün **kırılacaktır** ve bu kasıtlıdır: indexer'ı yeni olayı işlemeye zorlar.
- **`SingleBlockTooLarge` yolunda adres filtresi bölme** — kod yazıldı, ama Arc'ta bugün tetiklenemiyor (tek blokta 20.000 arcpad logu yok). Açık hücre.
- **`to_addr = 0x0` yakma dalı** — OZ ERC20 `to == address(0)` için revert ettiğinden zincirde ulaşılamaz; sentetik fixture ile test edilir. Açık hücre, kayda geçirildi.
- **Faz 0 devir listesinden kapanmayanlar:** `web/package.json`'da `"type": "module"` eksikliği; `@types/node`'un hayalet bağımlılığı; CI action'larının değişebilir tag'leri; fork testindeki zayıf sıfır-adres iddiası.
