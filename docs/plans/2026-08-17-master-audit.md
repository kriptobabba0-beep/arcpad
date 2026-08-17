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
| **C-11** | **YUKSEK (surec)** | **CI bu kodun HICBIRINI gormemisti.** Son is akisi kosusu **2026-07-30**, Faz 0 PR'inda. O gunden beri **349 commit** birikti ve `contracts.yml`/`node.yml`/`slither.yml` yalnizca `push: [main]` ve `pull_request` ile tetikleniyor; `buyback-v2` icin acik bir PR yoktu. | ✅ **PR #2 ACILDI** — dort kapi ilk kez bu kod uzerinde kostu ve **bes ariza buldu**; hepsi duzeltildi. Bkz. §H. |

---

## E. STRES VE OLASILIK — FAZ H

`scripts/audit/phase-stress.ts`. Faz B'den **farki** ve neden ikisi de gerekli:

* **Faz B** SECILMIS islemleri planlayiciya karsi tutar. Iddiasi "bu islem
  dogru hesaplaniyor" — degerli, ama TEK islem hakkinda.
* **Faz H** RASTGELE bir DIZI kosar. Iddiasi "yuzlerce islemden sonra da
  zincir ile model AYNI yerde duruyor" — yani **birikimli** hata. Her adimda
  bir wei'lik yuvarlama sapmasi kirk adim sonra gorunur; tek islemlik hicbir
  test onu goremez.

Tutarlar **logaritmik** dagitilir (10⁻³ … 10⁻⁰·⁸ USDC): dogrusal bir dagilim
neredeyse hep orta buyuklukte islem uretir ve yuvarlamanin GERCEKTEN yasadigi
kucuk tutarlari hic ziyaret etmez. Tohum `ARC_STRESS_SEED` ile sabitlenir ve
her kosuda BASILIR — yeniden uretilemeyen bir kirmizi, bir gozlem degil bir
hikayedir.

Her adimdan sonra **dort degismez** canli zincirde olculur:

1. **Odeme gucu** — `balance(curve) >= realQuoteReserves` (`>=`, cunku Arc'ta
   ucuncu taraf bakiyeyi kod calistirmadan sisirebilir).
2. **Ucret defteri geri gitmez** — escrow'da borc yalnizca artar.
3. **Yon** — alim quote'u artirir/token rezervini azaltir; satim tersi.
4. **Sabit carpim kuculmez** — `k = vq·vt` yuvarlamayla BUYUYEBILIR (hep
   protokol lehine) ama KUCULMESI egriden deger sizmasi demektir. Bu, tek
   islemde gorunmeyecek kadar kucuk, kirk islemde gorunecek kadar birikimli
   olan tam olarak o seydir.

### Faz H'nin kendi urettigi iki yanlis kirmizi — ikisi de KOSUM hatasiydi

| # | Belirti | Gercek sebep |
|---|---|---|
| 1 | `sellExactTokensIn` `0xfb8f41b2` ile dustu; viem selector'u COZEMEDI (BondingCurve ABI'sinde yok) | `ERC20InsufficientAllowance`. Egride satis `transferFrom` yapar; kosum izin vermiyordu. **Urun kusuru degil**, satis yolunun gercek on kosulu. Duzeltme: donguden ONCE tek ve sinirsiz izin (satis basina dar izin dongu ortasinda tukenir — bu depoda havuz supurmesinde bir kez olculdu). |
| 2 | "planlayici 0 wei, zincir 179454853928888644" | `TradePlan.value` `msg.value`dir ve satimda **tanimi geregi sifirdir**. Net gelir `args[1]`dir (`slipDown(netOut, 0)` = tam `netOut`); `curveAmount` ise ucret ONCESI hasilat, o da yanlis alan. |

Ikisi de bu deponun tekrar odedigi ayni sinifin ornegidir: **dogrulanan seyi
dogrulayanin modeli kirik**. Ikisi de yorumda kayitli.

### Sonuc (tohum `20260817`, 30 dongu, canli Arc)

```
=== TOPLAM: 31 gecti, 0 dustu, 0 atlandi (harcanan 0.173504866473840103 USDC) ===
  H-ozet dizi boyunca SIFIR birikimli sapma -- 20 alim + 10 satim
```

**Otuz rastgele islemin otuzunda da planlayici ile zincir WEI'SI WEI'SINE
ayni**, ve dort degismez her adimda tuttu. Tutarlar 0,001 USDC'den 0,156
USDC'ye kadar bes buyukluk mertebesine yayildi; satimlar bakiyenin %10–%90'i
arasindaydi.

Bu, arayuz icin de bir ifadedir: `useTrade.ts` islemi `plan.args`tan
KELIMESI KELIMESINE kurar (`web/components/token/useTrade.ts:149-156`), yani
kullaniciya gosterilen sayi ile zincirin verdigi sayi ayni koddan gelir ve
otuz adim boyunca ayrismadi.

---

## G. BU TURDA YERELDE KOSULAN KAPILAR

CI bugunku kodu hic gormedigi icin (C-11) her kapi ELLE kosuldu ve sonucu
buraya yazildi. "Kosulmadi" satirlari da burada — kosulmamis bir kapiyi
kosulmus saymak, C-11'in kendisini tekrar etmek olurdu.

| Kapi | Sonuc |
|---|---|
| `forge test` (fork disi) | **843 / 843**, 41 suite |
| `make slither` (`--fail-medium`) | **cikis kodu 0** — 0 High, 0 Medium |
| `@arcpad/shared` | **308 / 308** |
| `@arcpad/web` vitest | **1311 / 1311** |
| `@arcpad/web` typecheck | temiz |
| `@arcpad/keeper` | **371 / 371** (16'si yeni) |
| `@arcpad/keeper` typecheck | temiz |
| Canli kampanya (Faz A–G) | 81 vaka, hepsi yesil (onceki tur) |
| Canli Faz H (stres) | bkz. §E |
| `forge test test/fork/*` | **29 / 29** (canli Arc RPC) |
| `@arcpad/db` | ⏸ yerelde kosamaz (Postgres yok) → **CI'da 406 / 406** |
| `@arcpad/indexer` | ⏸ yerelde kosamaz → **CI'da 333 / 333** |
| Playwright e2e | ⏸ yerelde kosamaz (zincir + Postgres + tarayici) → CI, bkz. §H |

---

## H. CI'IN BULDUKLARI (PR #2, 2026-08-17)

Dort kapi ilk kez bu kod uzerinde kostu. `slither` **ilk denemede** yesil
gecti — C-10'un LF duzeltmesi Linux'ta da tutuyor. Gerisi bes ariza cikardi,
ve **ucu YALNIZCA CI kosunca gorunurdu**:

| # | Ariza | Neden yerelde gorunmezdi | Duzeltme |
|---|---|---|---|
| 1 | Bicim kapisi (benim dosyalarim + onceden bozuk dort dosya) | — | `forge fmt` + prettier |
| 2 | Iki fork testi `graduationTarget == 0` diyordu | Fork testleri elle kosulur; kimse kosmamisti | Iddia TERSINE cevrildi ve GUCLENDIRILDI: artik defterin locker'ina esitlik. `applyGraduationTarget` izinsiz oldugu icin yanlis adrese uygulanmis bir hedef ancak boyle gorunur |
| 3 | Defterin smoke cifti tamamlanmamis bir egriyi gosteriyordu | Ayni | Test hakliydi, DEFTER yanlisti. Elle duzeltilmedi — jenerator mezun ciftle yeniden kosuldu |
| 4 | `check` ve `release-gate` submodule cekmiyordu → `reconcile.test.ts` OpenZeppelin kaynagini bulamiyordu | **Her gelistirici checkout'unda o dizin ZATEN var** | `submodules: recursive`. Testi "dosya yoksa atla" yapmak yanlis olurdu: atlayan bir uzlastirma testi hicbir sey uzlastirmaz |
| 5 | Uc e2e secicisi arayuzden kopmustu | e2e yerelde kosulamiyor | `getByLabel('Name')` bolum basligiyla cakisiyordu (`exact: true`); alan adi `Symbol` degil `Ticker`; ve `quote-*` dokumleri artik kapali bir `<details>` icinde |

5'in son maddesi ayrica bir **iddia guclendirmesidir**: Playwright'in
`toContainText`i `textContent` okur ve GIZLI bir elemanda da gecer — yani
yalnizca `toBeVisible()` cagrilarini silmek suiti yesile cevirir ve geriye
"kullanicinin GORMEDIGI metni dogrulayan" iddialar birakirdi. Acilir artik
aciliyor; klavye testinde ise TIKLAMAYLA degil **Tab + Enter** ile, boylece
acilirin kendisinin klavyeyle ulasilabilir oldugu da olculuyor.

Acilirin kendisi bir tur daha aldi: `QuoteBreakdown` DA bir `<details>`tir ve
`trade-details`in ICINDE durur, yani `locator('summary')` -- bir TORUN
aramasi -- iki eleman buluyordu. `> summary` (cocuk birlesticisi) kullanildi;
`.first()` de calisirdi ama DOM sirasina guvenmek, ic ice iki acilirdan
hangisinin once geldigini gorunmez bir varsayim yapardi.

### CI'in kapi kapi durumu (3. kosu, 6fcae8e)

`forge` **843/843** (41 suite, 37 dk), `fork`, `slither`, `check`
(db **406**, indexer **333**, shared 308, keeper 371, scripts 19, web 1311),
`release-gate`, `abi-parity`, `chain-differential` — **yedisi de yesil**.
Kalan tek kapi `e2e-local`.

---

## F. KALAN IS

1. **C-2 (HSTS)** — operator karari. Sertifika yasi bu makineden OLCULEMEDI:
   yerel Kaspersky TLS'i araya giriyor (okunan sertifika
   `CN=Kaspersky Anti-Virus Personal Root Certificate`) ve `openssl` kurulu
   degil. Somut oneri: sunucuda `certbot certificates` ciktisindaki
   `Expiry Date` en az bir kez OTOMATIK yenilenmisse (yani ilk duzenlemeden
   >60 gun gecmisse), `nginx-arcpad.conf`taki `Strict-Transport-Security`
   satirini `max-age=63072000; includeSubDomains` ile ac. Geri alinamaz bir
   karardir; erken acmak riskli, gec acmak degil.

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
