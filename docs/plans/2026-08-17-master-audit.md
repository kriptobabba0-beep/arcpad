# arcpad — ANA DENETIM PLANI

> Tarih: 2026-08-17 · Dal: `buyback-v2` · Hedef: production'a cikmadan once
> HER kullanici aksiyonunun ve HER platform aksiyonunun denetlenmis, test
> edilmis ve KANITLANMIS olmasi.

## 0. Yontem, ve neden bu sirada

Bu belge bir kontrol listesi degil, bir **kanit defteridir**. Her satirin
yaninda "hangi dosya bunu OLCUYOR" yazar. Bir satir ancak o dosya
gosterilebiliyorsa YESILDIR; "kodu okudum, dogru gorunuyor" YESIL DEGILDIR.

Dort test sinifi ayri seyleri yakalar ve hicbiri digerini kapsamaz:

| Sinif | Nerede | Neyi yakalar | Neyi YAKALAMAZ |
|---|---|---|---|
| **Birim** | `contracts/test/*.t.sol` | Bilinen bir yolun bilinen cevabi | Aklina gelmeyen girdi |
| **Fuzz / Invariant** | `contracts/test/invariant/`, `*Fuzz.t.sol` | Aklina gelmeyen girdi, durum makinesi | Gercek zincirin davranisi |
| **Canli kampanya** | `scripts/audit/phase-*.ts` | Gercek gaz, gercek RPC, gercek ucret | Nadir durum kombinasyonu |
| **Zincir disi** | `web/test`, `indexer/test`, `keeper/test`, `packages/db/test` | Sunucunun kendi hatalari | Zincirin hatalari |

**Sira baglayicidir**: statik analiz (slither) -> birim -> fuzz/invariant ->
canli kampanya -> zincir disi -> stres. Once ucuz olan, sonra pahali olan.

---

## A. KULLANICI AKSIYONLARI (zincir ustu)

Kullanicinin bir cuzdanla imzalayarak yapabilecegi HER SEY. Liste
`contracts/src/*.sol` icindeki `external`/`public` ve `view` OLMAYAN her
fonksiyondan turetildi; uydurma yok.

| # | Aksiyon | Giris noktasi | Birim | Fuzz/Inv | Canli | Durum |
|---|---|---|---|---|---|---|
| A1 | Token cikar | `LaunchFactory.launch` | `LaunchFactory.t.sol` | `GraduationHandler` | Faz A (15) | ✅ |
| A2 | Token cikar + buyback + ilk alim | `LaunchFactory.launchWithBuyback` | `LaunchFactory.t.sol`, `BuybackLifecycle.t.sol` | — | Faz A, Faz E | ✅ |
| A3 | Curve'den al (quote sabit) | `BondingCurve.buyExactQuoteIn` | `BondingCurve.t.sol` | `CurveTradingHandler` | Faz B (13) | ✅ |
| A4 | Curve'den al (token sabit) | `BondingCurve.buyExactTokensOut` | `BondingCurve.t.sol` | `CurveTradingHandler` | Faz B | ✅ |
| A5 | Curve'e sat | `BondingCurve.sellExactTokensIn` | `BondingCurve.t.sol` | `CurveTradingHandler` | Faz B | ✅ |
| A6 | Mezuniyeti itele (izinsiz) | `ArcpadLocker.graduate` | `ArcpadLocker.t.sol` | `PoolSeedInvariants` | Faz D (9) | ✅ |
| A7 | Havuzdan al (giris sabit) | `ArcpadRouter.buyExactIn` | `ArcpadRouter.t.sol` | — | Faz F (7) | ✅ |
| A8 | Havuzdan al (cikis sabit) | `ArcpadRouter.buyExactOut` | `ArcpadRouter.t.sol` | — | Faz F | ✅ |
| A9 | Havuza sat (giris sabit) | `ArcpadRouter.sellExactIn` | `ArcpadRouter.t.sol` | — | Faz F | ✅ |
| A10 | Havuza sat (cikis sabit) | `ArcpadRouter.sellExactOut` | `ArcpadRouter.t.sol` | — | Faz F | ✅ |
| A11 | Fiyat sorgula (revert kanali) | `ArcpadRouter.quote*` ×4 | `ArcpadRouter.t.sol` | — | Faz F | ✅ |
| A12 | Creator ucretini cek | `FeeEscrow.claim` | `FeeEscrow.t.sol` | `EscrowHandler` | Faz C (7) | ✅ |
| A13 | Buyback supurmesi (izinsiz, pencere sonrasi) | `BuybackTreasury.sweep` | `BuybackTreasury.t.sol` | — | Faz E (17) | ✅ |
| A14 | Kilitli tokeni serbest birak | `BuybackVestingVault.release` | `BuybackVestingVault.t.sol` | — | Faz E | ✅ |
| A15 | ERC-20 transfer / approve / transferFrom | `LaunchToken` | `LaunchToken.t.sol` | — | Faz G | ✅ |
| A16 | Curve'u tokene bagla (tek atislik) | `BondingCurve.bind` | `BondingCurve.t.sol` | — | Faz G | ✅ |

**Dusmanca yol (Faz G, 13 vaka)**: sahte curve ile graduation, yabanci
factory'den `Launched`, izinsiz `accrue`, izinsiz `lock`, escrow'a ciplak
native gonderme, `bind` tekrari, blocklist precompile, `sweep` esik altinda,
`release` beneficiary olmadan, `setBuybackEnabled` acma yonunde.

---

## B. PLATFORM / YONETISIM AKSIYONLARI

Governor Safe'in ya da bir kontratin yapabilecegi her sey.

| # | Aksiyon | Giris noktasi | Yetki | Kanit | Durum |
|---|---|---|---|---|---|
| B1 | Buyback'i kapat | `LaunchFactory.setBuybackEnabled` | creator: acik→kapali; governor: acik→kapali | `LaunchFactory.t.sol`, `BuybackPermissions.t.sol` | ✅ |
| B2 | Buyback hazinesini yaz | `LaunchFactory.setBuybackTreasury` | governor, **BIR KEZ** | `LaunchFactory.t.sol` | ✅ |
| B3 | Graduation hook'unu yaz | `LaunchFactory.setGraduationHook` | governor | `LaunchFactory.t.sol` | ✅ |
| B4 | Buyback keeper'ini yaz | `LaunchFactory.setBuybackKeeper` | governor | `BuybackPermissions.t.sol` | ✅ |
| B5 | Graduation hedefini oner | `LaunchFactory.proposeGraduationTarget` | governor | `Governance.t.sol`, `Governance.fork.t.sol` | ✅ |
| B6 | Graduation hedefini uygula | `LaunchFactory.applyGraduationTarget` | **izinsiz**, zaman kilidi sonrasi | `Governance.t.sol` + canli (2026-08-16) | ✅ |
| B7 | Protokol hazinesini dondur | `LaunchFactory.setProtocolTreasury` | governor | `LaunchFactory.t.sol` | ✅ |
| B8 | Ucreti buyback'e tahakkuk ettir | `BuybackTreasury.accrue` | yalnizca curve/hook | `BuybackPermissions.t.sol` | ✅ |
| B9 | Alinan tokeni kilitle | `BuybackVestingVault.lock` | yalnizca `buybackTreasury` | `BuybackVestingVault.t.sol` | ✅ |
| B10 | Ucreti escrow'a yatir | `FeeEscrow.deposit` | herkes (bagis guvenli) | `FeeEscrow.t.sol` | ✅ |
| B11 | Havuz kancalari | `ArcpadHook._before/_afterSwap`, `_beforeInitialize` | yalnizca `PoolManager` | `ArcpadHook.t.sol` | ✅ |
| B12 | V4 kilit geri cagrilari | `ArcpadLocker/Router/BuybackTreasury.unlockCallback` | yalnizca `PoolManager` | ilgili `*.t.sol` | ✅ |

**Governor Safe'in YAPAMADIKLARI** — listenin kendisi bir guvenlik ozelligi:
tokeni durduramaz, ticareti duraklatamaz, kullanicinin bakiyesine dokunamaz,
curve'den para cekemez, kilitli tokeni erken serbest birakamaz, buyback'i
ACAMAZ, `buybackTreasury`yi ikinci kez yazamaz.

---

## C. ZINCIR DISI YUZEYLER

| # | Yuzey | Risk sinifi | Kanit | Durum |
|---|---|---|---|---|
| C1 | `POST /api/chat` | Tek kullanici-yazilabilir DB yolu | `web/test/chat/route.test.ts` | ✅ imza→I/O sirasi olculuyor |
| C2 | `POST /api/metadata` | Kimliksiz pinning kotasi | baytdan tur karari + nginx `limit_req` | ⚠️ C-1 |
| C3 | `GET /api/ipfs/*` | SSRF + depolanmis XSS | CID deseni, sabit host, baytdan tur, akista tavan | ✅ |
| C4 | `GET /api/search` | SQL enjeksiyonu, DoS | parametre baglama, `q`≤128, imlec deseni, `limit` sabit | ✅ |
| C5 | Server component okuma yolu | Veri sizintisi | `web/lib/read.ts` — yalnizca `token_overview` gorunumleri | ✅ |
| C6 | Indexer ingest | Sahte launch kabulu | `admit.ts` CREATE2 yeniden turetmesi + adres filtresi | ✅ |
| C7 | Keeper graduation | Anahtar, cift gonderim | `graduate/lock.ts`, `state.ts` | ✅ |
| C8 | Keeper buyback supurmesi | Anahtar, MEV | `sweep/decide.ts` + `minTokensOut` | ✅ |
| C9 | Keeper alarm/tatbikat | Sessiz ariza | `alert.ts`, `drill.ts` | ✅ |
| C10 | DB gocleri / yedek | Sema kaymasi | `migrate.ts` ozet defteri, `backup.ts` | ✅ |
| C11 | HTTP basliklari / TLS | MITM, XSS | `next.config.ts` + canli olcum | ⚠️ C-2, C-3 |

---

## D. BULGULAR

| Kod | Siddet | Bulgu | Durum |
|---|---|---|---|
| **C-8** | **YUKSEK** | **Buyback supurme anahtarcisinin SURECI YOKTU.** `src/sweep/decide.ts` karari 19 testle veriyordu ve `planSweep`in tek referansi kendi test dosyasiydi — hicbir sey onu cagirmiyordu. Para hazinede birikir, `SWEEP_GRACE` (7 gun) dolunca supurme izinsiz hale gelir ve cagiran `minTokensOut`u SECER (sifir gecebilir) → slipaj korumasi kapanir, supurme sandviclenebilir. Hicbir test kirmizi degildi. | ✅ **YAZILDI** — `src/sweep.ts` + `sweep/{pass,chain,config,store,abi}.ts`, 16 yeni test, canli Arc'ta dogrulandi (bkz. §F) |
| **C-10** | Orta | **CRLF slither'in kaynak eslemesini kaydiriyordu.** Bes kontrat dosyasi bir betikle CRLF'e cevrilmisti; crytic-compile satirlari diskten normalize okur, solc ise bayt ofseti verir → 3 satirlik kayma → HER `slither-disable-next-line` yonergesi ISKALIYORDU. Triyaj "calismiyor" gorunuyordu; sebep triyaj degildi. | ✅ LF'e cevrildi; 1 High + 13 Medium → **0 / 0** |
| **C-9** | Orta | **Migration ozeti satir sonuna duyarliydi.** `sha256Hex(readFile(...))` ham baytlardan hesaplaniyordu; `.gitattributes` `eol=lf` dese de bir editor/betik Windows'ta CRLF birakir (olculdu: `011_`, `013_` icin `i/lf w/crlf`). Sunucuda uygulanmis bir migration, Windows checkout'undan kosuldugunda "uygulandiktan SONRA degismis" ile dagitimi durdururdu. | ✅ `\r\n → \n` normalize; iki dosya LF'e cevrildi; 2 yeni test |
| **C-6** | Orta | `BuybackVestingVault` icin **fuzz/invariant yoktu**; yalnizca birim testi. Agirlikli ortalamanin `vestingEnd`i her kilitte yeniden kaydirmasi, tam olarak senaryo testinin goremedigi yer. | ✅ `BuybackVaultInvariants.t.sol` — 9 invariant × 16.384 cagri + 1 deterministik no-op kapisi |
| **C-7** | Orta | `make slither` kirmizi. | ✅ **Cikis kodu 0** (C-10'un sonucu + iki yonerge yerlestirmesi) |
| **C-3** | Bilgi | `X-Powered-By: Next.js` sizintisi (canli olcum). | ✅ `poweredByHeader: false` |
| **C-1** | Dusuk | `/api/metadata` kimlik istemez: herkes pinning kotamiza 5 MiB gorsel yazabilir. nginx `limit_req` (burst 5) tek fren. | ⚠️ KABUL — kota tukenirse rota 502 doner ve form URI yoluna duser. Kimlik eklemek cuzdan imzasi ister; launch AKISINDAN ONCE imza istemek donusumu kirar. |
| **C-2** | Dusuk | Canli sitede **HSTS yok**. `http://` → `https://` 301 var (olculdu), ama ilk ciplak istek strip edilebilir. | ⚠️ ACIK — sertifika en az bir kez otomatik yenilendikten sonra ac; `nginx-arcpad.conf`taki gerekce gecerli. |
| **C-5** | Bilgi | Addressbook'ta `buybackTreasury`/`buybackVault` yok. | ✅ **TASARIM GEREGI** — `setBuybackTreasury` BIR KEZ yazilir, yani fabrikanin `buybackTreasury()` gorunumu degistirilemez kaynaktir. Supurucu onu oradan okur; defterde ikinci bir kopya, zincirden sapabilecek bir kopya olurdu. |
| **C-4** | Bilgi | `ArcpadLocker`ta toz: 6.23e18 token + 3.69e11 wei, supurme yolu yok. | ✅ KASITLI — bir `sweep` fonksiyonu "yakilmis pozisyon" garantisini delerdi. |

---

## E. KALAN IS

1. **Stres / olasilik** — canli zincirde: ardisik N alim/satim, ayni blokta
   cakisan islemler, curve tavanina dayanma, supurme yarisi.
2. **C-8'in havuz kolu canli kanit bekliyor** — bkz. §F.
3. **C-2** — sertifika yasi olculdukten sonra karar.

---

## F. CANLI KANIT — SUPURUCU (2026-08-17, Arc testnet)

`pnpm --filter @arcpad/keeper sweep -- --once`, uretim fabrikasina karsi,
kuru kosuda, iki kimlikle:

| Kimlik | Sonuc |
|---|---|
| imzalayansiz | `considered=5 skip.auth=5` — yetki kapisi dogru kapali |
| kayitli anahtarci (`0xe92c64C4…`) | `considered=5 skip.pending=3 skip.threshold=2 skip.auth=0` |

Bes token `BuybackAccrued` loglarindan KESFEDILDI (defterden degil, zincirden).
Ucunun butcesi sifir (Faz E kampanyasinda supuruldu), ikisi `MIN_SWEEP_WEI`in
(0,05 USDC) altinda — **ve bu, olculmus testnet tavaniyla birebir tutarli**:
bir launch'in egri boyunca uretebilecegi azami buyback tahakkuku 0,018242 USDC,
yani esigin 2,74 kati ALTINDA. Uretim profilinde ayni sayi 18,24 USDC'dir
(esigin 365 kati) — bu bir uretim kusuru DEGILDIR.

### HAVUZ KOLU — GERCEK BIR SUPURME, GERCEK ZINCIRDE

Esik testnette bir EGRI tokeni tarafindan asla gecilemez, ama MEZUN bir
tokenin havuz hacmiyle gecilebilir. Gecirildi: mezun `0xe721ef44…` tokeninin
havuzunda **14 gidis-donus takasi** (28 swap, 1 USDC'lik bacaklar — havuzun
quote derinligi ~12 USDC oldugu icin tek buyuk alim yerine gidis-donus)
`pendingQuote`i `0 → 0,0516 USDC`ye tasidi.

Sonra supurucu, `KEEPER_SWEEP_DRY_RUN=false` ile:

```
OK keeper.sweep swept token=0xe721ef44… minOut=14500355973970846149647190
   tx=0x0993a8562f337424611e24f46aca18485feac3748a0eab3bb3900d9a4a109d12
   status=success gas=262909
```

Zincirdeki sonuc, supurmeden SONRA okundu:

| Alan | Deger |
|---|---|
| `pendingQuote` | `0` — butce harcandi |
| `cumulativeQuoteSpent` | `9,026e16` wei = 0,0903 USDC (kumulatif) |
| `cumulativeTokensBought` | `1,6261761938939449935430446e25` |
| `vault.totalLocked` | `1,6261761938939449935430446e25` — **birebir esit** |
| `vault.vestingEnd` | `1944607099` (2031-08-17, tam bes yil) |

Son satir bu turda yazilan invariant'in canli karsiligidir: alinan her token
kasaya girdi, ne eksik ne fazla. Alinan miktar `minOut`un (14,5e24) USTUNDE —
slipaj siniri bagladi ve tutmadi degil, TUTTU.

**Teklif kanali da boylece yurudu**: mezun bir token icin miktar
`SlippageTooHigh(got, …)` donus kanalindan okundu (`minTokensOut =
type(uint256).max` ile yapilan bir `eth_call`), matematik hicbir yerde yeniden
yazilmadi.

### OLCULEREK EKLENEN BIR SAGLAMLIK

Ilk gercek kosu `eth_getLogs: Request exceeds defined limit` ile — hem de
`withRateLimitRetry`in 14 denemesi tukendikten sonra — DUSTU, ve GECISIN
TAMAMINI dusurdu: butcesi esigi gecmis, zaten BILINEN bir token, alakasiz bir
KESIF arizasi yuzunden supurulmeden kaldi. Kesif artik `try/catch` icinde:
duserse imlec ilerlemez, `discovery-failed` kaydedilir ve gecis bilinen kumeyle
DEVAM eder. Ikinci kosu (yukaridaki) bu duzeltmeden sonradir.
