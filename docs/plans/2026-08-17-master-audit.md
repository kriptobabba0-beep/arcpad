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
| C2 | `POST /api/metadata` | Kimliksiz pinning kotasi | baytdan tur karari + nginx `limit_req` | ⚠️ C-1 (kabul) |
| C3 | `GET /api/ipfs/*` | SSRF + depolanmis XSS | CID deseni, sabit host, baytdan tur, akista tavan | ✅ |
| C4 | `GET /api/search` | SQL enjeksiyonu, DoS | parametre baglama, `q`≤128, imlec deseni, `limit` sabit | ✅ |
| C5 | Server component okuma yolu | Veri sizintisi | `web/lib/read.ts` — yalnizca `token_overview` gorunumleri | ✅ |
| C6 | Indexer ingest | Sahte launch kabulu | `admit.ts` CREATE2 yeniden turetmesi + adres filtresi | ✅ |
| C7 | Keeper graduation | Anahtar, cift gonderim | `graduate/lock.ts`, `state.ts` | ✅ |
| C8 | Keeper buyback supurmesi | Anahtar, MEV | `sweep/decide.ts` + `minTokensOut` | ✅ |
| C9 | Keeper alarm/tatbikat | Sessiz ariza | `alert.ts`, `drill.ts` | ✅ |
| C10 | DB gocleri / yedek | Sema kaymasi | `migrate.ts` ozet defteri, `backup.ts` | ✅ |
| C11 | HTTP basliklari / TLS | MITM, XSS | `next.config.ts` + canli olcum | ✅ C-3 kapatildi; C-2 tarihe baglandi |

---

## D. BULGULAR

| Kod | Siddet | Bulgu | Durum |
|---|---|---|---|
| **C-8** | **YUKSEK** | **Buyback supurme anahtarcisinin SURECI YOKTU.** `src/sweep/decide.ts` karari 19 testle veriyordu ve `planSweep`in tek referansi kendi test dosyasiydi — hicbir sey onu cagirmiyordu. Para hazinede birikir, `SWEEP_GRACE` (7 gun) dolunca supurme izinsiz hale gelir ve cagiran `minTokensOut`u SECER (sifir gecebilir) → slipaj korumasi kapanir, supurme sandviclenebilir. Hicbir test kirmizi degildi. | ✅ **YAZILDI** — `src/sweep.ts` + `sweep/{pass,chain,config,store,abi}.ts`, 16 yeni test, canli Arc'ta dogrulandi (bkz. §I) |
| **C-10** | Orta | **CRLF slither'in kaynak eslemesini kaydiriyordu.** Bes kontrat dosyasi bir betikle CRLF'e cevrilmisti; crytic-compile satirlari diskten normalize okur, solc ise bayt ofseti verir → 3 satirlik kayma → HER `slither-disable-next-line` yonergesi ISKALIYORDU. Triyaj "calismiyor" gorunuyordu; sebep triyaj degildi. | ✅ LF'e cevrildi; 1 High + 13 Medium → **0 / 0** |
| **C-9** | Orta | **Migration ozeti satir sonuna duyarliydi.** `sha256Hex(readFile(...))` ham baytlardan hesaplaniyordu; `.gitattributes` `eol=lf` dese de bir editor/betik Windows'ta CRLF birakir (olculdu: `011_`, `013_` icin `i/lf w/crlf`). Sunucuda uygulanmis bir migration, Windows checkout'undan kosuldugunda "uygulandiktan SONRA degismis" ile dagitimi durdururdu. | ✅ `\r\n → \n` normalize; iki dosya LF'e cevrildi; 2 yeni test |
| **C-6** | Orta | `BuybackVestingVault` icin **fuzz/invariant yoktu**; yalnizca birim testi. Agirlikli ortalamanin `vestingEnd`i her kilitte yeniden kaydirmasi, tam olarak senaryo testinin goremedigi yer. | ✅ `BuybackVaultInvariants.t.sol` — 9 invariant × 16.384 cagri + 1 deterministik no-op kapisi |
| **C-7** | Orta | `make slither` kirmizi. | ✅ **Cikis kodu 0** (C-10'un sonucu + iki yonerge yerlestirmesi) |
| **C-3** | Bilgi | `X-Powered-By: Next.js` sizintisi (canli olcum). | ✅ `poweredByHeader: false` |
| **C-1** | Dusuk | `/api/metadata` kimlik istemez: herkes pinning kotamiza 5 MiB gorsel yazabilir. nginx `limit_req` (burst 5) tek fren. | ⚠️ KABUL — kota tukenirse rota 502 doner ve form URI yoluna duser. Kimlik eklemek cuzdan imzasi ister; launch AKISINDAN ONCE imza istemek donusumu kirar. |
| **C-2** | Dusuk | Canli sitede **HSTS yok**. `http://` → `https://` 301 var (olculdu), ama ilk ciplak istek strip edilebilir. | ✅ **KARARA BAGLANDI** — `--dry-run` zaten gecmis; HSTS **kademeli** (`max-age=300` → 1 gun → 2 yil) HEMEN acilabilir. Kalan tek sey sunucu erisimi. Bkz. J-1. |
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

### H-6. `local-db` SUITI SILINMIS BIR URL SOZLESMESINI TEST EDIYORDU

`e2e-local` bacagi bir kapi daha actı: `e2e/db/explore-and-search.spec.ts`,
Explore'un **eski** URL sozlesmesine gore yazilmisti.

Uc test `/?sort=oldest`, `/?age=1` ve `?after=` yazan bir `Next` baglantisini
suruyordu. **Ucu de yok.** `parseExploreParams` yalnizca `tab` ve `page` okur;
siralamayi ve yas penceresini `TABS`'tan TURETIR (bilerek: bir gorunumun tam
olarak bir kanonik adresi olsun diye), ve buradaki sayfalayici `?page=` yazan
`NumberedPager`'dir. Yani bes `?sort=` URL'i de VARSAYILAN sekmeyi ciziyordu.

| Ne | Eski (silinmis) sozlesme | Bugunku sozlesme |
|---|---|---|
| Siralama | `?sort=` (bes anahtar) | `?tab=` (dort gorunum), `TABS`'tan turetilir |
| Yas | `?age=all\|1\|7` | sekmenin kendi `ageDays`i |
| Sayfalama | `KeysetPager` → `?after=` | `NumberedPager` → `?page=`, `PAGE_SIZE` 48 |

**NEDEN BUGUNE KADAR GORUNMEDI:** suit `serial` ve ilk hatada duruyor, ve bu
satira ULASAN ilk CI kosusu onu dusuren kosu oldu. Bir suit, ustundeki bir sey
once durdugu surece silinmis bir sozlesmeyi suresiz tasiyabilir.

**VE GECEN YARISI DAHA OGRETICI.** Varsayilan sekme `trending`, yani
`search_key(volume_24h_wei, created_seq) DESC`. Fixture'in hacimleri
ESITTIR, dolayisiyla o ifade `created_seq DESC`'e yozlasir — tam olarak
`newest` iddiasinin aradigi sira. **Yesil bir iddia, baska bir siralamayi
olcuyordu.** (`widestSortInput`'un `Actual Rows`'u yanlis okumasiyla ayni
sinif: dogru gorunen bir olcum, yanlis sey uzerinde.)

Uc test dogru evlerine tasindi:

1. **Dort sekme dort gorunumdur** — ve fall-through mutantini olduren sey SIRA
   degil **SATIR SAYISI**: esitlik altinda iki sekme ayni SIRAYI paylasabilir,
   ama ayni SAYIYI paylasamaz (`new` yedi gunluk pencere tasir, `trending`
   tasimaz). `trending` = `SEEDED`, `new` = `SEEDED - OLD`. `PAGE_SIZE` ve
   `TAB_KEYS` artik **ice aktariliyor**, yazilmiyor — ikisi de bir kez zaten
   tasindi.
2. **`oldest` ve yas suzgeci arama rotasinda** — cunku orada YASIYORLAR:
   `oldest` ⌘K'nin bir pill'i ve `/api/search?sort=oldest`e gider; hicbir sekme
   `ageDays: 1` kullanmaz, `SEARCH_AGE_LABELS` kullanir.
3. **`?page=` OFFSET'e ulasir** — 30 satir 48'lik sayfaya sigdigi icin "ileri
   tekrar etmemeli" BU fixture'da ulasilamaz ve iddia EDILMEZ; onun yerine
   sonun otesindeki bir offset'in BOS olmasi olculur (yok sayilan bir `page`
   otuz satiri yeniden cizerdi). Genislik muhafizinin (`/^\d{1,6}$/`) yedi
   basamakta **birinci sayfaya** dusmesi de artik yazili.

**VE YAZARKEN AYNI TUZAGIN UCUNCUSUNU YAKALADIM.** Yas suzgeci icin ilk
yazdigim iddia `all.length - day.length === OLD` idi. `SEARCH_LIMIT` **20**:
`age=all` 30 satir eslesir, `age=1` 24 — **ikisi de 20'ye kirpilir**, yani
uzunluklar AYNIDIR. O iddia CALISAN bir suzgecte duserdi. Kirpmanin
saklayamadigi sey HANGI satirlarin geldigidir, bu yuzden iddia uzunluk degil
**uyelik**: ayni siralama, ayni ilk sayfa, eski satirlar pencereli olanda YOK.

### H-7. `volume` INDEKSI HAKSIZ YERE GERI ALINMISTI

H-6'nin dolaysiz sonucu. `017_sort_keys.sql` bir kez gonderilmis, sonra
**geri alinmisti** — sebep, `e2e/db/explore-and-search.spec.ts`in "`oldest`
yaratilis sirasina gore ARTMALI" diyerek dusmesiydi. H-6 o testin Explore'un
**okumadigi** bir `?sort=` parametresini surdugunu gosterdi: hata degisiklikten
**degil**, silinmis bir URL sozlesmesinden geliyordu. Ve bu, geri almadan sonra
ayni mesajla tekrar dusmesinden zaten belliydi.

**DERS: geri almadan once arizanin degisiklikten geldigini DOGRULA.** En ucuz
testi, geri almanin ardindan hayatta kalip kalmadigidir.

Dayandigi esitlik artik bir **kapi**: `packages/db/test/sort-keys.test.ts`
(6 test). Ve esitlik yapisaldir — `applyLaunch` iki sutunu **tek ifadede ayni
CTE'den** yazar, hicbir `UPDATE` `created_seq`e dokunmaz, view'in
`JOIN token_stats`i INNER'dir, ve `applyLaunch` tek yazma yoludur (indexer de
onu cagirir). Kapi bunu metin taramasiyla degil, **olaylari oynatarak** olcer:
launch + transfer + iki alim + `Completed`.

Sunucuda olculdu (`/root/arcpad-buyback`, 3.000 token, **421/421**, 91 s):

```
recentBuys       Sort=0        marketCap        Sort=2   <- D-14, urun karari
newest           Sort=0        volume           Sort=0   <- GERI GETIRILDI
oldest           Sort=0        nearGraduation   Sort=2   <- H-9'da KAPANDI
```

`volume` Explore'un **varsayilan** sekmesidir (`trending`), yani en cok okunan
siralama. Alti siralamanin **dordu** artik indeksten geliyor.

Ve bu tur bir **is akisi kazanci** da getirdi: db suitini sunucuda kosturmak
(415 -> 421 test, **92 saniye**) bir CI turunun yerini aliyor. Bu degisiklik
gonderilmeden once orada dogrulandi.

### H-8. SUIT ILERLEDIKCE IKI GERCEK URUN KUSURU DAHA CIKTI

H-6'nin duzeltmesi suiti 3. testten 9. teste tasidi, ve orada bekleyen sey test
kaymasi degil **urun kusuruydu**.

**1. Token sayfasinin islem/tutucu sayfalayicisi OLU idi.**
`<ActivityTabs>` sayfalari `<NumberedPager>`e cizdirir; o bilesen **`?page=N`
yazar**. `app/token/[address]/page.tsx` ise **`?p=` okuyordu**. Sonuc: sayfalayici
ciziliyor, baglantilar adresi degistiriyor, sunucu parametreyi bulamayip her
zaman 1. sayfayi veriyor.

> **25'ten fazla islemi ya da tutucusu olan HER token 25'te kilitliydi** — ve
> hicbir hata gorunmuyordu, cunku tablo aynen yeniden ciziliyordu.

`hrefFor` da hicbir zaman var olmayan bir parametreyi (`p`) siliyordu, yani
sekme degistirmek sayfa numarasini **tasiyordu**. Bu, bu sayfanin **ikinci** ayni
sinif kusuru (ilki grafik secicisiydi). Ad artik tek: `page`.

**2. Iki tablo erisilebilir adini kaybetmisti.** Bolum
`<TradesTable>`/`<HoldersTable>`den `<ActivityTabs>`e tasinirken `<caption>`lar
dusmus. Token sayfasi **uc** tablo cizer (ikisi grafiklerin sr-only metin
alternatifi), yani adsiz bir tablo ekran okuyucuda belirsiz ve seciciyle ayirt
edilemez. Specin kendi basligi tam bunu yakalamayi vaat ediyordu.

**Ucuncu bulgu, duzeltilmedi ama kayda gecti:** `CurveChart`in **gerceklesen
katmani artik uretimde ulasilamaz**. Tek cagirani `<TokenPriceChart>` ve o da
`trades` prop'unu gecmiyor. Yani bir zamanlar "prop gecilmiyor" olan kusur bugun
**olu kod**, ve bilesen testleri prop'u kendileri verdigi icin hala yesil.
Silmek bir urun karari.

**HEPSININ ORTAK SEBEBI AYNI:** kapilar VARDI, ama suit `serial` ve kendisinden
onceki bir test silinmis bir URL sozlesmesini surdugu icin o satirlara hic
ULASMAMISTI. Bir suitin yesil olmasi, "suitin o satira kadar gelip durdugu"
anlamina da gelebilir.

### CI'in kapi kapi durumu

`forge` **843/843** (41 suite, 37 dk), `fork` **29/29**, `slither`, `check`,
`release-gate`, `abi-parity`, `chain-differential` — hepsi PR #2'de yesil
gecti.

### H-10. CI COKTU, VE KAPILAR YINE KOSTURULDU (BASKA YERDE)

2026-08-17 aksami GitHub Actions bu depo icin **saatlerce coktu**: her is 2-4
saniyede, **adim kaydi olmadan**, log'lari `BlobNotFound` donerek oldu (oncesinde
API'de 503, `codeload`da 429, ve bir submodule cekiminde 500). Kodla ilgisi yok
ve yeniden tetikleme duzeltmedi.

**Bu, kapilari kosturmamak icin bir gerekce degil.** Her paket baska bir yerde
kosturuldu ve sonuclar burada:

| Kapi | Sonuc | Nerede |
|---|---|---|
| `@arcpad/db` | **423/423** | sunucu (92 s) |
| `@arcpad/indexer` | **333/333** | sunucu |
| `@arcpad/keeper` | **373/373** | yerel |
| `@arcpad/shared` | **308/308** | yerel |
| `@arcpad/scripts` | **19/19** | yerel |
| `web` birim | **1319/1319** | yerel |
| `web` `e2e:db` | **14/14** | yerel, **SSH tuneliyle** |
| `web` `e2e:local` / `e2e:audit` | 7/7 · 41/41 | CI (colmeden once) |
| `fmt:check` · `typecheck` | temiz | yerel |
| `forge` · `fork` | 843/843 · 29/29 | **contracts/ bu seansta HIC degismedi** (`git diff 783eeaf..HEAD -- contracts/` bos), yani sonuclar gecerli |

**VE BU, BIR BOSLUK ORTAYA CIKARDI.** `web` altinda iki dosya degistirilmisti
(`ActivityTabs.tsx` caption'lari, `page.tsx`'in `page` parametresi) ve web'in
**1319 birim testi hic kosturulmamisti** — CI cokuk oldugu icin o suit bu
degisiklikleri hic gormedi. Yerelde kosturuldu: **1319/1319**. Kapi cokunce
"kapatilan is" degil, "olculmeyen is" birikir; fark tam olarak budur.

## J. KALAN IS

### J-0. E2E AUDIT BACAGININ ACIGA CIKARDIGI DORT URUN BULGUSU

`pnpm --filter @arcpad/web e2e:audit` ILK KEZ kosuldu (2026-08-17, yerel):
**35 gecti, 6 dustu**. Dusenler seciciyle ilgili DEGIL — dordu de gercek urun
bulgusu, ve hicbiri bu turda yapilan degisikliklerden kaynaklanmiyor.

> **BENIM DEGISIKLIGIM SUCLU DEGIL, VE BU OLCULDU**: klavye testi 165.
> satirda (`3% slippage preset must be reachable`) dustu; bu turda EKLENEN
> iddia (`the Details disclosure must be reachable`) ondan ONCE gelir ve
> GECTI. Yani acilir klavyeyle acilabiliyor, 3% dugmesine Tab ile
> varilamiyor — ve bu, testin hic kosmamis olmasindan gizlenmis ONCEDEN VAR
> OLAN bir durum.

| # | Bulgu | Olculen | Durum |
|---|---|---|---|
| **E-1** | Token rotasi JS butcesini asiyor: **340,3 kB gz** / 300 kB | %13,4 asim | ✅ **286,9 kB** — grafik kutuphanesi tembel yuklendi |
| **E-2** | axe `color-contrast` (**serious**), `slippage-auto-badge`, 375/768/1440 px | 4,33:1 / esik 4,5 | ✅ yeni token + **kapinin kor noktasi kapatildi** |
| **E-3** | Arama modali `getByRole('dialog')`e cevap vermiyor | 15 sn zaman asimi | ✅ rol ZATEN vardi — **hidrasyon yarisi**; dort spec tek yardimciya baglandi |
| **E-4** | %3 slipaj on ayarina Tab ile ulasilamiyor | 30 basimda hic | ✅ o kontrol **hic var olmamis**; iddia gercek yola cevrildi ve **gercek bir kusur** cikardi |

### E-2 — bulunan sey bir renk degil, bir KOR NOKTAYDI

`--color-muted` HER token zemininde kapiyi geciyordu (sayfada 5,70, kartta
5,34, surface-2'de 4,94). Ama arayuzde bir **cip** deseni var (`bg-white/6`,
`bg-white/8`) ve cipin zemini bir token DEGIL bir **bilesiktir**. Kapi
(`contrast.test.ts`) yalnizca token-uzerine-token olcuyordu ve saydam bir
zemini acikca REDDEDIYORDU (`zemin saydam olamaz`), yani bu sinifi GOREMEZDI.

Olculdu — ve tek rozet degil, **dort yer**:

| Zemin | `--color-muted` | Durum |
|---|---|---|
| `white/8` + surface | **4,33:1** | ✗ (axe'in yakaladigi) |
| `white/8` + surface-2 | **3,93:1** | ✗ daha kotu |
| `white/6` + surface-2 | **4,16:1** | ✗ |
| `white/6` + surface | 4,61:1 | ✓ kil payi |

Ucuncu satir varsayimsal degil: `Card` etkilesimliyse `hover:bg-surface-2`
uygular. Duzeltme `--color-muted-raised: #9a9a9a` (en kotu zeminde **4,83:1**)
ve dort cip sitesi ona cevrildi. **Ve kapi genisletildi**: `over(overlay,
surface)` ile alti bilesik cift tabloya girdi — ucu REDDEDILEN halleri
kaydediyor, cunku bir daha yazan biri karsisinda olculmus bir sayi bulmali.
Kapi kendi kosusunda benim aritmetigimi iki ondalikta duzeltti (4,82 → 4,83).

### E-4 — test var olmayan bir kontrolu ariyordu, ve GERCEK kusur baska yerdeydi

`aria-pressed` tasiyan bir `3%` on ayar dugmesi `SlippageRow`da **hic
olmadi**: `git log -S aria-pressed` bos doner, spec'te de yok. Test hayali bir
arayuze yazilmis ve hic kosulmadigi icin bu gorunmemis.

Iddia SILINMEDI, konusu duzeltildi — urunun gercek yolu bir kalem dugmesi + bir
metin alanidir. Ve o yola bakinca **gercek bir kusur** cikti: alan mevcut
degerle on dolu acilir ama metin SECILI DEGILDIR, yani ilk tus vurusu degeri
degistirmez **ONA EKLER**.

```
varsayilan %2,5 -> alan "2.5" ile acilir -> kullanici 3 yazar -> %2,53
```

Ikinci yol daha kotu: "%10'u %5 yapayim" diyen biri `105` uretir ve muhafiz
(`percent > 100`) SESSIZCE hicbir sey yazmaz — ekranda 105 durur, imzalanacak
deger eski deger kalir. **Ekran ile calldata ayrisir, ve burasi para yolu.**
Duzeltme `onFocus={e => e.currentTarget.select()}`.

Birim suiti bunu neden gormemisti: mevcut test yazmadan ONCE
`user.clear()` cagiriyordu — yani kullanicinin yapmadigi bir adimi varsayarak
geciyordu. Yeni test secim araligini olcer (`selectionStart`/`selectionEnd`);
"yazmak yerine koyar" iddiasi gercek klavye olaylari gerektirdigi icin e2e'de
durur (`userEvent.type` yazmadan once TIKLAR ve secimi dagitir — bu bir
kutuphane mekanigi, urun davranisi degil).

### E-1 — tahminle degil olcumle: en agir parca grafik kutuphanesiydi

Butce kirildiginda NEYIN kirdigini soylemiyordu; ilk is dokumu iddia mesajina
eklemek oldu. Sonuc:

```
[budget] token JS: 340.3 kB gz across 15 files (budget 300 kB)
  92.3 kB  1fi-xta05kw8s.js   <- lightweight-charts
  69.3 kB  3xwl9jkbryit_.js   <- react-dom
  39.5 kB  27w0yp-ahm5n_.js
  28.1 kB  0rim5q0tojopj.js   <- viem
  20.1 kB  0s68-8vxiszv8.js   <- wagmi
```

Parcalar `grep` ile parmak izlendi. En agiri **tek basina rotanin %27'si** ve
statik import ediliyordu. `next/dynamic` ile BUTUN bileseni sarmak yanlis
olurdu: `ssr: false` OHLCV basligini, `controls`u ve bos-durum kutusunu da
sunucu ciziminden cikarir, ve yer ayirmayan bir yer tutucu CLS uretir. Yerine
**yalnizca cizim motoru** `useEffect` icinde `await import(...)` ile alindi;
bilesenin iskeleti sunucuda kalir.

**Sonuc, olculdu:** token **340,3 → 286,9 kB gz** (−53,4), explore 226,6 kB,
**CLS 0,0000** iki rotada da, LCP 268 ms (4x CPU kisitli). Butce
YUKSELTILMEDI.

Bedeli: grafik artik asenkron kuruluyor, yani 10 birim testi senkron iddia
ediyordu. Paylasilan bir `renderChart` yardimcisi eklendi (30/30 yesil) —
testler artik gercekligi yansitiyor.

### J-1. Diger

### D-14 (`marketCap` siralamasi) — KARAR VERILDI: CANLI HAVUZ FIYATI

> **KARAR (sahibi, 2026-08-17):** mezun bir token'in market cap'i **havuzla
> hareket eder**. Uygulandi: `018_market_cap_source.sql` + bakim
> `packages/db/src/apply.ts`e tasindi. Olculdu: `marketCap Sort=2 -> 0`.

Uygulamanin uc parcasi ve her birinin sebebi:

| Yer | Ne yapar |
|---|---|
| `applyLaunch` | acilis market cap'ini yazar (eskiden **0** yaziyordu, ve o sifir bir siralama anahtariydi) |
| `applyTrade` | egri islemlerinde mutlak yazar, **sira ile korunmus** |
| `applyPoolSwap` | mezuniyetten sonra **havuz** fiyatindan yazar |

**Ucu de MEVCUT CTE'nin icinde.** Postgres tek ifadede ayni satiri iki kez
guncellemeyi desteklemez ve ikinci etki **sessizce** kaybolur — ayri bir
`mc AS (UPDATE token_stats …)` ya hacim sayaclarini ya da market cap'i
dusururdu, ve hangisini dusurdugu gorunmezdi.

**`LEFT JOIN deployment d ON true`, `CROSS JOIN` DEGIL.** `deployment` en fazla
bir satirdir (`CHECK (id = 1)`) ama **en az** bir satir degildir. `CROSS JOIN`
bos bir `deployment`ta hic satir uretir — yani market cap eklemek, onunla ilgisi
olmayan **hacim sayaclarini** sessizce durdururdu.

**Saklanan deger bayatlayamaz, ve bu olculdu:** sanal rezervleri (market cap'in
girdilerini) yazan yalnizca bu uc yoldur; `applyCompleted` yalnizca *gercek*
rezervleri, `applyGraduated` yalnizca bayraklari yazar; ve reorg **onarilmaz** —
`ReorgDetected` ingest'i durdurur, yani rezervleri islem olmadan geri saran bir
yol yok.

**Iki test dogru sekilde degisti, ve ikisi de zayiflatilmadi:**

* `queries.test.ts`'in "view saklamaz" testi **ikiye bolundu**: hesaplanan
  sutunlarin (`price_wei_per_tok`) hala aninda degistigi, ve bakilan sutunun
  elle yazilan bir `curve_state`ten etkilenmedigi — ikincisi ayrica acilis
  degerinin **sifir olmadigini** iddia eder, yoksa esitlik vakumda gecerdi.
* `migrate.test.ts`'in `atttypmod` mutanti **hedef degistirdi**: view artik
  `ts.market_cap_wei`e bagli oldugu icin Postgres o sutunun tipini degistirmeyi
  reddediyor, yani `ALTER`in kendisi patliyor ve test parmak izini **hic
  olcmuyordu**. Yeni hedef `fee_events.amount_wei` — ayni seyi olcer (bir para
  sutununun olcegi) ve hicbir view'in bagli olmadigi sutunlar **sorguyla**
  bulundu, tahmin edilmedi.

Indexer'in `writeMarketCap` cagrilari **kaldi**: ayni degeri, ayni ifadeyle,
ayni muhafizla yazarlar (idempotent). Kaldirmak temizlik olur ama indexer'in
kendi kapilariyla dogrulanacak ayri bir tur.

### D-14'UN ESKI HALI (karar oncesi gerekce, kayit icin)

Explore'un uc para siralamasindan `volume` artik indeksten geliyor
(`017_sort_keys.sql`, olculdu `Sort=2 -> 0`). `marketCap` gelmiyor, ve sebebi
bakim eksigi DEGIL.

`writeMarketCap` **uc** yerden cagrilir: `admit.ts` (acilis), `apply/trade.ts`
(egri islemleri) ve **`apply/pool.ts` — mezuniyetten SONRA, havuz fiyatindan**.
`token_overview` ise `market_cap_wei`i `curve_state`ten hesaplar, ve egri
mezuniyette **DONAR**. Yani mezun bir token icin:

| | Deger |
|---|---|
| `token_stats.market_cap_wei` | havuzun **canli** fiyati |
| view'in `market_cap_wei`'i | egrinin **donmus** son fiyati |

Ikisi bayatliktan degil **tasarimdan** ayrisir. View'i `ts`e baglamak bu yuzden
bir indeks degisikligi degil: mezun tokenlerin **gosterilen** market cap'ini ve
`marketCap` siralamasinin **anlamini** degistirir. (Denendi; dokuz test dustu ve
o testler bugunku anlami kodluyordu, yani hakliydilar.)

**KARAR SAHIBININ:**

* **A)** View egri turevli kalir. Indeks, egri ifadesini aynen yansitan — ve
  mezuniyette donan — **ayri** bir sakli sutun ister.
* **B)** View `ts.market_cap_wei`e gecer. Mezunlar **canli havuz** market cap'i
  gosterir; bu muhtemelen kullanici icin daha dogrudur ama gorunen degerleri ve
  siralamayi degistirir, ve dokuz testin beklentisi guncellenir.

Karar verilene kadar `scale.test.ts` bunu **olculmus borc** olarak kirmizi
tutar.

### H-9. `nearGraduation` DA KAPANDI -- VE MARKET CAP'TE OLMAYAN BIR TUZAK VARDI

`019_progress_ppm.sql`. Olculdu: **`Sort=2 -> 0`**. Alti siralamanin **altisi**
da artik indeksten geliyor.

`progress_ppm` `token_stats`te saklanir ve **uc** yerde bakilir:

| Yer | Ne yapar |
|---|---|
| `applyLaunch` | acilis degeri **hesaplanir**, sifir yazilmaz -- satisa arzin bir kismini ayirmis bir profil sifirla yanlis baslardi |
| `applyTrade` | her egri islemi, **sira ile korunmus** |
| `applyCompleted` | **%100** -- ve bu, market cap'te olmayan madde |

**UCUNCUSUNUN ATLANMASI SESSIZ BIR KUSUR OLURDU.** `applyCompleted` sanal
rezervlere dokunmaz (o yuzden market cap'i etkilemez) ama
`real_token_reserves_tok = 0` yazar -- yani ilerlemeyi %100'e tasiyan yer tam
olarak orasidir. Bakilmasaydi tamamlanmis bir curve **son islemin biraktigi
yuzdede donar** ve "graduation'a en yakin" listesi kendi **en ust satirini**
kaybederdi. (`applyPoolSwap` bilerek disarida: ilerleme bir **egri** kavramidir
ve mezuniyette biter.)

`applyCompleted` bu yuzden tek bir `UPDATE`ten bir CTE'ye cevrildi. Burada
**ayri** bir CTE mesru: `token_stats`e dokunan baska bir CTE yok, yani
Postgres'in "ayni satiri iki kez guncelleme" kisiti devreye girmez --
`applyTrade`'ta girer, ve orada bakim mevcut CTE'nin **icindedir**.

Indeks ifadesi **birebir** `SORTS.nearGraduation`in anahtaridir
(`search_key(progress_ppm::numeric, created_seq)`, **acik** `::numeric` cast
dahil); farkli yazilsa planlayici indeksi kullanmaz ve olcum sessizce eski
haline donerdi.

**Iki kapi dogru sekilde degisti:**

* `queries.test.ts`'in kenar-deger testi (`0 / 500.000 / 999.999 / 1.000.000`)
  `curve_state`'e elle yaziyordu; artik **`applyTrade` uzerinden** suruluyor,
  yani hem formul hem **bakim yolu** olculuyor -- eski hali yalnizca view'in
  artik var olmayan ifadesini olcuyordu. Korunan asil ozellik yukari
  yuvarlamadir: bir wei kalmis bir curve **%99,9999** gostermeli, %100 degil.
* `scale.test.ts`'in "hala siraliyor" borc testi gorevini bitirdi ve yerine
  **daha guclu** bir iddia geldi: her `SORTS` anahtarinin indeks iddiasinin
  **kapsaminda** oldugu. Yarin yeni bir siralama eklenirse ya kapsama girer ya
  da kapi duser -- indekssiz bir siralama sessizce urune giremez.

**Sunucuda olculdu:** `@arcpad/db` **423/423**, `@arcpad/indexer` **333/333**.

### C-2 (HSTS) — HEMEN ACILABILIR, KADEMELI

Sertifika gercek haliyle okundu. Ilk deneme bir **olcum tuzagina** dustu:
.NET'in `HttpWebRequest`i `CN=Kaspersky Anti-Virus Personal Root Certificate`
donduruyordu (yerel antivirus TLS'i araya giriyor). **Python'un `ssl` modulu
araya girmiyor**:

| Alan | Deger |
|---|---|
| Ihracci | **Let's Encrypt (YE1)** |
| `notBefore` | **2026-08-15 22:33:04 UTC** |
| `notAfter` | 2026-11-13 22:33:03 UTC |

**ILK DEGERLENDIRME YANLISTI VE DUZELTILDI.** Bu belge once "ilk OTOMATIK
yenileme (~14 Ekim) beklenmeli" diyordu. Iki hata vardi:

1. **Yenilemenin calistigi ZATEN kanitli.** `certbot renew --dry-run` tam bu
   is icin vardir -- yenileme akisini bastan sona kosturur, yalnizca
   sertifikayi degistirmez. 2026-08-16'da GECTI ve `certbot.timer` acik
   (bkz. `server-and-domain` notu). `nginx-arcpad.conf`taki kuralin GEREKCESI
   "yenileme calisiyor mu" sorusudur; o soru cevaplanmis. Takvimi beklemek
   yeni bir bilgi URETMEZ.
2. **Geri alinamazlik HSTS'ten degil `max-age`den gelir.** Dogrudan
   `max-age=63072000` varsayildi; standart yol KADEMELI acmaktir.

**Dogru plan -- kademeli, ve her adim geri alinabilir:**

| Adim | `max-age` | Bozulursa kendini toparlama |
|---|---|---|
| 1 | `300` (5 dk) | **5 dakika** |
| 2 | `86400` (1 gun) | 1 gun |
| 3 | `63072000` (2 yil) + `includeSubDomains` | — |

`max-age=300` ile risk fiilen sifirdir: bir sey ters giderse bes dakikada
kendiliginden duzelir. Her adimda dogrulama: `nginx -t`, sonra
`curl -sI https://outofmind.fun | grep -i strict-transport`.

**Engel teknik degil erisim:** degisiklik sunucudaki nginx dosyasindadir ve
SSH anahtari (`~/.ssh/arcpad_keeper_ed25519`) PAROLA KORUMALIDIR; parola bu
oturumda yok. Karar verilmis ve adimlar yazili; kalan tek sey erisim.

### C-12 (Cloudflare proxy) — FAZ 0-3 UYGULANDI VE DOGRULANDI

Tam kanit: **`docs/runbooks/cloudflare-proxy.md` §10**. Ozet:

| Faz | Durum |
|---|---|
| 0 — sunucu hazirligi (real-IP) | ✅ uygulandi, sahtecilik testiyle olculdu |
| 1 — panel ayarlari | ✅ sahibi yapti (Full strict, TLS 1.2, Rocket Loader KAPALI) |
| 2 — `A` kaydi `Proxied` | ✅ bes kontrol gecti |
| 3 — origin'i CF aralıklarina kapat | ✅ zamanlanmis geri alma ile uygulandi |
| 4 — HSTS kademeli | ✅ **1. kademe canli** (`max-age=300`, HTML + statik); 2-3. kademe zaman gerektirir |
| 5 — Origin CA | ⬜ istege bagli, **sahibinin panelinde** sertifika uretmesini ister |

**En onemli iki olcum.** Gercek IP: proxy'den gecen bir istegin log'a dustugu IP,
istemcinin gercek IPv6'sinin **birebir aynisi** — yani hız limitleri kullanici
basina calisiyor, herkes tek kovaya dusmuyor. Origin: `--resolve` ile IP'ye
**doğrudan** gitmek artik **zaman asimina** ugruyor; tarayicilar Cloudflare'i
atlayamiyor. (Uygulamadan once log'da CensysInspect ve ham TLS sondalarinin
dogrudan origin'e vurdugu GORULDU.)

**Ve `certbot renew --dry-run` iki kez kosuldu** — bir kez proxy acildiktan
sonra, bir kez de guvenlik duvari kisildiktan sonra. Ikisi de gecti. Bu adim
zorunluydu: ACME artik Cloudflare'den geciyor ve buradaki bir hata sertifikayi
90 gun sonra **sessizce** oldururdu.

**FAZ 3b — uygulama sirasinda bulunan sessiz bir suruklenme kapatildi.** Gunluk
timer nginx'in aralik listesini guncelliyordu ama **ufw'yi guncellemiyordu**:
Cloudflare yeni bir aralik ekledigi gun nginx onu ogrenir, ufw ogrenmez, ve o
kenardan gelen kullanicilar sert bir zaman asimi alir — cografi, kismi, rastgele
gorunen bir ariza. `arcpad-cf-ranges` artik ufw'yi de ayni listeden uzlastiriyor,
**once ekleyip sonra silerek** (tersi bir kenari kapatir) ve bir **fail-open
muhafiziyla**: uzlastirmadan sonra 10'dan az kural kalirsa kapi acik birakilir ve
journal'a yazilir. Yanlis bir kilit, yanlis bir aciklıktan pahalidir.

Mantik kurulmadan **kuru** denendi (22 = 22, sifir degisiklik onerdi), sonra
gercekten kosturuldu: cikis 0, 22 kural, fail-open tetiklenmedi, `nginx -t`
gecerli.

### C-1 (`/api/metadata`) — KABUL, VE NEDEN

Rota kimlik istemez, yani internetteki herkes bizim pinning kotamiza 5 MiB'a
kadar GORSEL yazabilir. Uc sey bunu bir acik degil bir maliyet yapiyor:

* Tur **baytlardan** karara baglanir (`imageTypeOf`), yani keyfi icerik
  pinlenemez -- yalnizca gercek gorseller.
* nginx `limit_req zone=arcpad_write burst=5` ve `client_max_body_size 6m`.
* Kota tukendiginde rota 502 doner ve form URI yoluna duser; **launch akisi
  durmaz**.

Kimlik eklemenin bedeli daha yuksek: cuzdan imzasi istemek, launch formunu
DOLDURMADAN once imza istemek demektir ve donusumu kirar. Kayit altina alindi;
kota izlenmesi operasyonel bir istir, kod kusuru degil.

---

## I. CANLI KANIT — SUPURUCU (2026-08-17, Arc testnet)

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


---

## K. URETIM: YENI FABRIKAYA GECILDI (2026-08-17)

Bugune kadar bu daldaki **hicbir sey canlida degildi**: uretim
`phase-1d-deploy` dalinda, `c816be2`'de, `buyback-v2`'den **48 commit** geride --
187 dosya, ~24.000 satir. Buyback ozelliginin tamami, supurucu sureci, token
sayfasi yeniden tasarimi ve bugunun butun duzeltmeleri canlida yoktu.

### K-1. DAGITIM BIR SECIM CIKARDI, VE SECIM OLCULEREK SUNULDU

| | Canlinin fabrikasi | Defterin fabrikasi |
|---|---|---|
| Adres | `0x5CA1…6B47` | `0x7A02…56A3` |
| Token | **98** | 27 |
| `buybackTreasury()` | **revert** -- fonksiyon YOK, ozellikten eski surum | kurulu (`0xeC111Bc3…e9DD`) |

Runbook "env'i **defterden** yeniden uret" diyor -- ama defter YENI bir fabrikaya
tasinmis. O talimati harfiyen uygulamak, canli sitenin 98 tokenini gorunmez
kilardi. Eski fabrikaya buyback EKLENEMEZ de: `setBuybackTreasury` o surumde yok.

Sahibi **canli havuz fabrikasini** secti (secenek B). Bedeli olculerek sunuldu:
iki fabrika ayni escrow'u paylasir, dolayisiyla `start_block` da aynidir
(54661437), yani yeniden tarama ~2,84 milyon blok yurur ve site o sure boyunca
BOS gorunur. **Geri getirilemez veri kaybi yok**: `chat_messages` 0 satir (ve
yedeklendi), gerisi zincirden turetilir.

### K-2. UC TUZAK, UCU DE UYGULAMADAN ONCE OLCULDU

1. **`DROP SCHEMA` yapilmadi.** `arcpad_web` rolunun yetkileri **elle**
   verilmis (`web-vps.md` §2) ve **hicbir migration `GRANT` icermiyor**. Semayi
   silmek yetkileri de silerdi, site izin hatasiyla olurdu, ve hicbir migration
   onu geri getirmezdi. Veri tablolari bosaltildi; `schema_migrations` ve
   `schema_state` korundu.
2. **Tablo listesi katalogdan uretildi.** Elle yazilmis bir liste yeni bir tablo
   eklendigi gun eksik kalir ve iki dagitimin verisi karisir -- ki
   `ensureDeployment`'in yorumu tam bundan uyariyor.
3. **Build zinciri `&&` ile.** Bu makinede olculmus (2026-08-11): build dustu,
   restart yine kostu, `next start` yarim bir `.next` bulup cikti, ve
   `Restart=always` bunu **dort dakikada 146 kez** yaptı.

### K-3. VE BIR SESSIZ `sed` BETIGI YARIM BIRAKTI

Betik migration'lari (15 -> **19**), tablo bosaltmayi, `web.env` yenilemeyi ve
web build'ini **basariyla** yapti. 5. adim ise **hicbir sey yapmadi**:
`s|^(FACTORY_ADDRESS=).*|` ile eslesme araniyordu, oysa `indexer.env`'in anahtari
**`ARC_FACTORY_ADDRESS`**. Boyle bir satir olmadigi icin `sed` hicbir seyi
degistirmedi -- **ve `sed -i` yine 0 dondu.**

Sonuc: web yeni fabrikaya gecti, indexer **eskisinde kaldi**, ve hicbir sey
sikayet etmedi.

> **Bir `sed -i`'nin cikis kodu "degistirdim" demez, "patlamadim" der.**

Iki muhafiz eklendi: satirin **var oldugu** once dogrulanir, ve yazimdan **sonra**
beklenen deger geri okunur. Ikisi de duserse betik DURUR.

### K-4. NIHAI DOGRULAMA

| Kontrol | Sonuc |
|---|---|
| Kayitli fabrika | `0x7a02759a…bf256a3` -- **yeni olan** |
| Migration | **19** (`019_progress_ppm.sql`) |
| Servisler | web · indexer · keeper-graduate · keeper-window -- **dordu aktif** |
| Web derlemesi | `arcpad-stale-build`: calisan surec diskteki derlemeyi sunuyor; `NRestarts=0` |
| Site | **200** |
| Tarama | ilerliyor; log satirinda artik `buyback=` alani var (yeni kod), ve paylasilan escrow'un gecmisinden 8 ucret olayi bulundu |

**BEKLEYEN:** tarama zincir basina yetisene kadar site bos gorunur. Bu ariza
degil. Sunucu ayrica bir `System restart required` bildiriyor -- tarama bittikten
sonra yapilmali, once yapmak taramayi gereksizce geciktirir.

---

## L. BOS BIR CEVAP BIR CEVAPTIR -- VE 36 OLAY BOYLE KAYBOLDU

Taramanin **sirasinda** bulundu, taramayi dogrulamak icin degil, ilerlemesini
olcmek icin bakarken. En pahali sinif bu: kimse aramadigi icin degil, arayan
kimsenin **kirmizi gormedigi** icin gizli kalan ariza.

### L-1. ARIZA

Bir RPC ucu `eth_getLogs` icin **hata vermeden bos dizi** donuyor. viem'in
`fallback` tasiyicisi yedege yalnizca birincil uc **REDDEDERSE** gecer -- bos bir
dizi red degildir, **cevaptir**. Indexer "bu aralikta olay yok" kabul etti ve
**imleci ilerletti**. Geri donus yok: imlec ilerledi, aralik bir daha okunmadi.

> **Bir yedek, yalnizca birincil ucun HATA VERDIGINI varsayar. Yalan soyleyen bir
> uc hata vermez.**

### L-2. NASIL KANITLANDI -- TOPLAMLA DEGIL, KONTROL NOKTASIYLA

Zincirdeki `owed(recipient)` degeri, bizim o bloga kadarki kumulatif toplamimizla
**ikili arama** ile karsilastirildi:

| Blok | Zincir | Bizim defter |
|---|---|---|
| 56.900.000 | esit | esit |
| 57.179.323 | esit | esit |
| **57.185.000** | **ayristi** | — |

Ayrilan pencerede zincirde **36 escrow logu** var (57.180.976–57.181.241);
defterimizde **0**. Toplamlari karsilastirmak bunu gosteremezdi: toplam, kaybin
**nerede** oldugunu soylemez, ve kayip yeterince kucukse yuvarlamaya benzer.

### L-3. MUHAFIZ: TANIGA SORULUR, YALANCIYA DEGIL

`indexer/src/empty-range-guard.ts`: bos cevaplar **orneklemeyle** (varsayilan
her 25'te bir) **ikinci** bir uca sorulur. Tanik `client` OLAMAZ -- yalan
soyleyen uca kendi yalanini sormak dogrulama degil **tekrardir**.

Uc sessiz-ariza korumasi bilerek yazildi: muhafiz **kapaliysa** soyler; **kosamiyorsa**
kostugunu iddia etmez; tanik bosu **onaylarsa** bu bir teyittir, sayilir.

### L-4. VE MUHAFIZIN KENDISI KUSURLUYDU -- UC KEZ DURDURDU DIYE DEGIL, DOKUZ KEZ

Dagitimdan sonra servis **dokuz kez** yeniden basladi, her seferinde
`WitnessUnavailable`. Belirleyici ayrinti loglarin icindeydi:
`Details: pruned history unavailable`.

Tanik uc **budanmis** bir dugum: eski bloklarin loglarini tutmuyor, yani o
araliklar hakkinda **tanikligi yok**. Varsayimim yanlisti -- "ikinci bir uc ayni
tarihsel sorguyu cevaplayabilir".

Bunu ariza saymak **iki kez** yanlisti:

* **Olcu olarak:** tanigin susmasi, birincil ucun yalan soyledigi anlamina gelmez.
* **Sonuc olarak:** durmak **koruma eklemez** -- o aralikta zaten dogrulama
  yapilamiyordu -- yalnizca isi keser.

> **Muhafiz, korudugu isi imkansiz kiliyordu.**

Artik ucuncu bir sonuc var: *"tanik bu aralik hakkinda konusamaz."* Sayaci
artirmaz, ama **sessiz de gecilmez**: `silencedByHorizon` ana donguden raporlanir.
Sayilmayan **ve** soylenmeyen bir bosluk, bu muhafizin bulmak icin var oldugu
seyin ta kendisi olurdu.

Testlerden biri **ayirt edici**: kalip tasimayan bir hata (`connection reset`)
hala sayilir ve esikte durdurur. O kontrol olmadan kalibi genis tutup her seyi
yutmak testi **gecerdi** -- ve muhafiz sessizce no-op olurdu.

---

## M. AYNI 36 LOG IKINCI KEZ KAYBOLDU -- VE MUHAFIZ YALANI ONAYLADI

Gece boyunca servis **538 kez** yeniden basladi. Ariza kodu `23514`:

```
new row for relation "fee_balances" violates check constraint
  "fee_balances_claimable_wei_check"
Failing row contains (0xe92c64..., -59347050754458163, ...)
```

Yani bir `claim`, defterdeki bakiyeyi **negatife** dusuruyordu -- karsilik gelen
`deposit` defterde YOKTU. Kontrat sifir bakiyede `NothingToClaim` ile revert
eder, dolayisiyla bu yalnizca bizim defterimizin eksik olmasiyla aciklanabilir.
`claimable_wei >= 0` kisiti veri kaybini **yakalayan** sey oldu.

### M-1. KAYIP, KONTROL NOKTASIYLA YERELLESTIRILDI

`verify-ledger.sh` bes noktada **esit**, yalnizca head'de ayrisik dedi. Daraltma:

| pencere | yon | tutar |
|---|---|---|
| 57.125.497 – 57.200.000 | defter EKSIK | `59.347.050.754.458.163` |
| 57.360.000 – 57.440.000 | defter FAZLA | bir `claim` kacmis |

Ustteki sayi cokme satirindaki `-59347050754458163` ile **birebir ayni**.
Zincirde o pencerede **36 escrow logu** var (`57.175.497–57.185.496`),
defterimizde **0** -- yani DUNKU 36 log, ayni aralik, ikinci kez.

### M-2. KOK NEDEN: IKI UC, IKI FARKLI DURUMDA YALAN SOYLUYOR

Her uce ayni sorgu soruldu:

| uc | 10.000 ustu aralik | head otesi aralik | 36 logluk aralik |
|---|---|---|---|
| birincil | rate limit | rate limit | rate limit |
| **blockdaemon** | **"0 log"** | hata | **"0 log"** |
| **drpc** | hata | **"0 log"** | hata |
| quicknode | hata | hata | hata |

Zincir soyle tamamlandi:

1. birincil uc `rate limit exceeded` verdi
2. viem **ILK YEDEGE** dustu -- blockdaemon
3. blockdaemon 36 log iceren aralik icin **hatasiz bos dizi** dondu
4. viem bunu gecerli bir cevap saydi, imlec ilerledi
5. **ve muhafiz onayladi**, cunku `witnessUrlFrom` de `urls[1]`i seciyordu

> **Bes numara en kotusu: yalan soyleyen uca kendi yalanini sorduk.**
> `empty-range-guard.ts` bastan beri "bu yapilmamali" diye yaziyordu, ve tam
> olarak onu yapiyordu. Sonuc sessiz kayiptan kotu: sessiz kayip arti **sahte
> guven**.

### M-3. UC KATMANDA DUZELTILDI

* **Tanik artik SON uc.** viem yedeklere sirayla duser; sonuncusu `urls[1]` ile
  cakismayan tek secimdir.
* **Yalanci uc yedek zincirinden CIKARILDI.** Hata veren bir uctan kotudur:
  hata failover tetikler, yalan tetiklemez.
* **`rpc-honesty.ts`**: yalani artik bir kapi olcuyor. Uc sonuc -- DURUST,
  TANIKLIK YOK (hata), YALANCI (hatasiz yanlis sayi). Canli pozitif kontrol:
  blockdaemon listeye geri konunca kapi onu **yakaladi** ve 1 dondu.

### M-4. VE KISMI YENIDEN TARAMA GUVENLI CIKTI -- OLCULDU

Sekiz `apply*` fonksiyonunun **hepsi** idempotent: `ON CONFLICT (event_seq)
DO NOTHING`, `event_seq > coalesce(...)` seq-muhafizi, ya da
`WHERE ... AND NOT complete`. Yani imleci geri almak yeterli; 8 saatlik tam
reindex gerekmedi.

Ilk denemede imlec **degismedi**: `last_block_hash` NOT NULL ve `UPDATE`
patladi -- geri okuma bunu gosterdi. Ikinci denemede yazilan hash de yanlisti,
cunku hex **elle** yazilmisti (`0x3661000` = 57.020.416, 57.000.000 degil), ve
`ReorgDetected` onu yakaladi. Ucuncu deneme hash'i `printf` ile hesaplayip
**bir sonraki blogun `parentHash`i ile dogruladi**.

> **Elle yazilmis bir hex, sessizce baska bir blogu isaret eder.**

### M-5. VE CI KAPISININ KENDI ARACI OLU KODDU

`releaseGate` ve `abi-parity` kirmizilari **ayni** kusurdandi: is akisi
cikaricisinin cok satirli `run: |` dali. `node.yml`de bugune kadar hic `run: |`
YOKTU -- sayisi sifirdi -- yani o dal hic calismamisti. FAZ K'de eklenen ilk iki
blok onu ilk kez kosturdu: cikarici **31 komut yerine 402** topladi, **158'i
yorum**.

Sinir "en az iki bosluk girintili" diye yazilmisti, oysa YAML'de sonraki isin
basligi (`  b:`) da iki bosluktan fazla girintilidir. Govde sonraki ise
**tasiyordu**. Sinir artik `run:`in kendi girintisi. Kusur **iki kopyadaydi** ve
ikisi birden kirildi; ikisi de duzeltildi ve artik birbirine capraz referans
veriyor.

---

## N. DERIN DENETIM (18 Agustos) -- ALARM KAPALIYDI, DORT ARIZA SESSIZCE BIRIKTI

Kullanicinin "eksik/denetlenmemis/amatorce kalan ne var" sorusu uzerine yapildi.
Butun bulgularin ortak koku ayni cikti: **alarm sistemi kapaliydi**, dolayisiyla
uretim sessizce bozuluyordu.

### N-1. ALARM ILETICI HIC CALISMIYORDU

`arcpad-keeper-notify@.service` kurulu ama `disabled`, yapilandirmasi HIC yok.
`/var/lib/arcpad/alerts.log`: 21.654 satir, **671 PAGE**. Dosyanin kendi yorumu
bunu yaziyordu: *"Bir VPS'te o dosyayi KIMSE OKUMAZ."*

Gece boyunca 538 cokme oldu; hicbiri haber vermedi.

> **Tamamlanmis, testli, kurulu ve KAPALI bir alarm sistemi, olmayan bir alarm
> sisteminden kotudur: varligi guven verir.**

Kullanici bilincli olarak "simdilik kurma" dedi. Kabul edilmis risk olarak
buraya yazilir; iki URL (sayfa + olu-adam) verildigi an devreye alinabilir.

### N-2. ARALIK KALIBI TERS CALISIYORDU -- 245 SAYFA

`isRangeTooLarge`, canli olculen mesajlara karsi kosturuldu:

| uc | mesaj | taniniyor mu |
|---|---|---|
| drpc | `ranges over 10000 blocks are not supported` | **HAYIR** |
| quicknode | `eth_getLogs is limited to a 10,000 range` | **HAYIR** |
| blockdaemon | `block range extends beyond current head` | evet (!) |

Yani kucultmekle **cozulen** iki reddi kaciriyor, kucultmekle **cozulmeyen**
birini yakaliyordu. Kucultme hic tetiklenmedi, tarama ayni parcada kalici olarak
dustu, imlec onune gecemedi ve izleyici kalp atisi yayamadi -- 252
`watcher-heartbeat-missed` sayfasi da buradan. **245 -> 0.**

### N-3. IZIN LISTESI BOSTU -- 18 SAYFA

`allowedGraduationTargets: []`, oysa zincirde bir hedef coktan atanmisti: bizim
`arcpadLocker`imiz, governance ile. `graduationTarget()` zincirden okunarak
dogrulandi.

Bos liste Faz 1d'de DOGRUYDU. Yanlis olan, faz degisince guncellenmemesiydi --
ve `config.ts`in kendi yorumu bunu ongormustu: *"bir gun icinde rota o sayfayi
susturmayi ogrenir ve kontrol -- HALA calisiyor gorunurken -- sifira duser."*

Liste artik **adres defterine bagli**: bir test, defterdeki `graduationTarget`in
izin listesinde olmasini zorunlu kilar. Mutasyonla dogrulandi. **18 -> 0.**

### N-4. KEEPER YALANCI UCU HALA KULLANIYORDU

Bolum M'de blockdaemon indexer'dan cikarilmisti; keeper'in iki env dosyasinda
DURUYORDU. Sonucu olculdu: keeper 26 curve goruyordu, indexer ve zincir **27**.
Uc cikarildi, imlec sifirlandi, yeniden tarandi: **26 -> 27**, sifir sayfa.

### N-5. ARC E2E BACAGI "GECIYORDU" AMA HICBIR SEY OLCMUYORDU

`e2e-arc` isi 39 saniyede `success` donuyordu; loglar butun `E2E_ARC_*`
degiskenlerinin **bos** oldugunu gosterdi. Yani `node-gate` uzerinden dal
korumasina da "gecti" diye yansiyordu.

Elle kosturuldu (canli zincir + canli site): **6 gecti, 2 dustu**. Gecenler
arasinda suitin var olma sebebi vardi: `units === floor(wei / 1e12)` -- anvil'de
OLCULEMEYEN iliski. Gercek bir alim da yapildi ve muhasebesi tuttu.

Bulunan kusur: `getByRole('button', { name: 'MAX' })` ad eslesmesini ALT DIZGE
yapar ve ayni paneldeki iki slipaj dugmesini yakaliyordu. Test hic kosmadigi
icin secici hic denenmemisti.

**ACIK:** MAX dugmesi bulunuyor, `disabled` degil, ama tiklanamiyor (120 s
timeout, "olay alabilir" kontrolu gecmiyor). Arastirilmali.

### N-6. DOGRULANAN VE KAPANMIS OLANLAR

* `Graduated` fetch/decode ediliyor -- "mainnet engelleyici" listesinde acikti.
* `ArcpadHook` `protocolTreasury`'yi **asla** onbelleklemiyor.
* Yedekleme kapsami DOGRU (tek kullanici verisi `chat_messages`; gerisi zincirden
  yeniden uretilebilir -- bolum M bunu fiilen kanitladi) ve **geri yuklenebilir
  oldugu test edildi**: gecici bir veritabanina restore edilip silindi.
* **ACIK:** yedekler yalnizca sunucunun kendisinde; off-site kopya yok.
