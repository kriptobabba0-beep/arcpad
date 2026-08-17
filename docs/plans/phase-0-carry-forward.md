# Faz 0'dan devreden kalemler

Faz 0'ın sekiz görevi, her görev sonrası incelemeler, bir bütün-dal incelemesi ve bir düzeltme dalgası sonunda kapandı. Aşağıdakiler bilinçli olarak ertelendi. Faz 1'in planı yazılırken bu dosya girdi olarak okunmalıdır.

## Birleşmeyi engellemeyen ama Faz 2'den önce çözülmesi gerekenler

**`v4-core` ve `v4-periphery` hâlâ dal ucunda (release tag'inde değil).**
`forge-std` (`v1.16.2`) ve `uniswap-hooks` (`v1.2.1`) tag'e taşındı. Diğer ikisi taşınamadı: `v4-periphery`'nin GitHub'da hiç tag'i yok, `v4-core`'un tek tag'i (`v4.0.0`, Ocak 2025) güncel `uniswap-hooks` ile derlenmiyor — `BaseHook`, `v4-core`'un yalnızca ana dal ucunda bulunan `PoolOperation.sol`'ünü import ediyor. Gerekçe test edilerek doğrulandı ve `CONTRIBUTING.md`'ye yazıldı.
**Faz 2, kullanıcı fonlarını tutan kod bu kütüphanelere dayanmadan önce yeniden değerlendirilmeli:** ya yeni bir tag çıkmış olur, ya da kabul edilen risk açıkça imzalanır.

**Fork testindeki sıfır-adres iddiası gerçekten kanıtlamıyor.**
`test_nativeTransferToZeroAddressReverts`, `vm.rpc` çağrısını çıplak bir `try {} catch {}` ile sarıyor ve yalnızca *bir şeyin* fırlatıldığını iddia ediyor; hata mesajını hiç incelemiyor. Kullandığımız halka açık RPC'den gelen bir 429 de bu testi geçirir. Mekanizma doğru — Foundry fork testleri yerel revm'de koştuğu için Arc'ın istemci seviyesindeki reddi ancak `vm.rpc` ile gözlemlenebiliyor — ama iddia gevşek.
**Düzeltme:** hata metninde `"Zero address not allowed"` alt dizesini ara, ve karşılaştırma için sıfır olmayan bir adrese kontrol çağrısı ekle.

## Faz 1'e devreden yapısal işler

- **Slither yapılandırması, triage allowlist'i ve CI kapısı.** Faz 0'da `contracts/src/` boş olduğu için analiz edilecek birinci taraf kontrat yoktu.
- **ABI-parity testi.** `packages/shared` ABI'yi dağıtacak; ilk ABI Faz 1'de üretilir. Üç tüketici (indexer, web, keeper) `forge build` çıktısına karşı doğrulanmalı.
- **Diller arası sabit kontrolü.** `5042002` şu an `packages/shared/src/chain.ts`, `ArcNetwork.fork.t.sol`, `.env.example` ve README'de ayrı ayrı yazılı; `0x3600…0000` iki yerde. Hiçbiri diğerini kontrol etmiyor. Solidity TypeScript'i import edemediği için pratik çözüm: iki taraftan da okuyup eşitliği iddia eden tek bir test — ABI-parity testiyle aynı şekil.
- **EIP-7708 sistem emitter adresi `packages/shared`'a.** Arc'ta her native hareket sistem adresinden 18 decimal'lik bir `Transfer` logu yayınlar. Indexer bunu emitter'a göre filtrelemezse USDC hareketlerini token bakiyesi sanar — spec §3.3'teki en tehlikeli tuzak, ve Faz 0 iskeletinde henüz izi yok. `USDC_ERC20_ADDRESS`'in yanına, aynı "bunlar tek bakiyenin iki görünümü" yorumuyla konmalı.
- **Fork testine kalan tasarım öncüllerini sabitle.** `block.prevrandao == 0` ve CREATE2 deployer eklendi; blok timestamp'lerinin artmayabilmesi henüz test edilmiyor.

## Faz 2'ye devreden

- **`ArcpadHookPermissions` tam-struct iddiası.** `V4Wiring.t.sol` 14 alanın yalnızca 6'sını kontrol ediyor. Kontrolsüz 8 alandan biri yanlışlıkla `true` olursa CREATE2 adres madenciliği sessizce yanlış bayrak kümesini arar. Kütüphane `src/` altına taşınırken tam struct karşılaştırması yazılmalı.

## Faz 5'e alınan ürün özelliği

- **Creator fee sharing** (pump.fun'dan). ≤10 paydaş, `share_bps` toplamı 10.000, bir kez set edilip admin yetkisi iptal edilir. Spec §5.8.

## Küçük, engellemeyen kalemler

- `nextRange`'de `maxSpan <= 0n` koruması yok; `nextRange(0n, 10n, 0n)` ters aralık döndürür. Bugün zararsız (`MAX_SPAN` modül sabiti), Faz 3'te konfigürasyondan gelince zararlı.
- `indexer/src/index.ts`'te `head.number - 10n` 10. bloğun altında taşar. Yalnızca demo yolu.
- `packages/shared/src/index.ts` barrel'ı hiçbir test tarafından kullanılmıyor; testler doğrudan `../src/usdc` import ediyor. Barrel'dan bir export düşse 14 test yeşil kalır.
- `web/package.json`'da `"type": "module"` yok, diğer üç pakette var. Next için idiyomatik ama tek paketler-arası sapma.
- `@types/node`, `indexer` ve `keeper`'da hayalet bağımlılık — kök workspace'ten çözülüyor.
- `contracts/src/` diskte yok ama `contracts/script/.gitkeep` var; asimetrik.
- `make fork-test ARC_RPC_URL=...` komut satırı geçersiz kılması artık çalışmıyor; RPC her zaman `.env`'den gelir.
- CI iş akışlarında `permissions:`, `concurrency:` ve pnpm store cache yok; action'lar değişebilir tag'lerle (`@v4`, `@v1`) referanslanıyor.
- Fork job'ındaki `continue-on-error` iş seviyesinde; başarısızlık yeşil görünüyor. Adım seviyesine taşınıp uyarı ek açıklaması eklenmeli.
- **Hiçbir CI iş akışı henüz çalışmadı.** Dal push edilmedi; ikisi de `pull_request` / `push: main` tetikleyicisinde. Kapılar bir kez yeşil koşana kadar değeri sıfır.
- `test_arcpadPermissionSetIsWhatPhase2Expects`, `formatUsdc`'in negatif `maxFractionDigits` koruması, `KEEPER_POLL_INTERVAL_MS` için yalnızca `'soon'`un test edilmesi, cursor testlerinin en dar sınırı (`head == cursor + maxSpan + 1`) sabitlememesi — hepsi kapsam boşluğu, davranış hatası değil.
