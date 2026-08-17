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

### CI'in kapi kapi durumu

`forge` **843/843** (41 suite, 37 dk), `fork` **29/29**, `slither`, `check`
(db **406**, indexer **333**, shared 308, keeper 371, scripts 19, web 1311),
`release-gate`, `abi-parity`, `chain-differential` — **yedisi de yesil**.
Kalan tek kapi `e2e-local`.

`e2e-local`'in ic durumu: `e2e:local` **7/7**, `e2e:audit` **41/41**,
`e2e:db` H-6'dan sonra ilk kez 3. testin OTESINE geciyor.

### E2E'YI CI'A SORMAYI BIRAK — YERELDE KOSUYOR

Uc CI turu e2e uzerinde harcandiktan sonra olculdu: **Chromium ve `anvil` bu
makinede ZATEN kurulu**, yani `pnpm --filter @arcpad/web e2e:local` burada
kosuyor (~2,5 dk). Her tur icin CI'i beklemek gereksizdi.

Yerel kosu sirayla iki ariza daha cikardi ve **ikisi de ayni sinif**: bu suite
hic kosmadigi icin arayuzden SESSIZCE kopmus.

| Belirti | Gercek sebep |
|---|---|
| `locator('summary')` iki eleman buldu | `QuoteBreakdown` DA bir `<details>`tir ve `trade-details`in icinde durur; torun aramasi ikisini birden bulur. `> summary` (cocuk birlesticisi). `.first()` de calisirdi ve DOM sirasina gorunmez bir varsayim yuklerdi |
| `getByRole('tab', {name: 'Receive tokens'})` 90 sn bekleyip dustu | Panel UC durumlu kaldi ama arayuz onlari uc sekme olarak GOSTERMIYOR: sekmeler artik **Buy / Sell**, alim tarafinda birim `flip-unit` dugmesiyle ceviriliyor |

---

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

### C-12 (Cloudflare proxy) — PLANLANDI, SIRAYA KONDU

Proxy bugun KAPALI (`DNS only`) ve acilmasi bir guvenlik kazancidir (DDoS
emilimi, origin IP'nin gizlenmesi, statik varliklarin kenardan servisi). Ama
BUGUN acmak siteyi bozar, ve sebebi olculdu: nginx hiz sinirini
`$binary_remote_addr` ile anahtarliyor ve konfigurasyonda `set_real_ip_from`
**hicbir yerde yok**. Proxy acilirsa butun trafik tek kovaya duser ve gercek
kullanicilar 429 yer -- "binlerce kullanici" hedefinin tam tersi.

Iki risk ise OLCULEREK ELENDI:

* **HTML onbellege alinmaz** -- canli olcum
  `Cache-Control: private, no-cache, no-store`. Proxy'nin en korkutucu riski
  (bir kullanicinin sayfasini baskasina servis etmek) yok.
* **Yukleme 100 saniyeye takilmaz** -- `/api/metadata` iki pin cagrisi yapar,
  her birinin tavani `AbortSignal.timeout(20_000)`, yani gercek tavan ~40s.
  (Yine de nginx'in o rotadaki `120s`i Cloudflare'in sinirindan UZUN; 90s'ye
  inecek ki hata bizim mesajimiz olsun, onun 524'u degil.)

Tam sirali plan, her adimin geri alma yoluyla:
**`docs/runbooks/cloudflare-proxy.md`**. Ozet sira: sunucu hazirligi (gorunur
etkisi sifir) → panel ayarlari → proxy → guvenlik duvari (zamanlanmis otomatik
geri alma ile) → HSTS kademeli → istege bagli Origin CA.

Iki madde ayrica kayda deger:

* **Guvenlik duvari adimi OLMADAN proxy bir guvenlik onlemi DEGIL, yalnizca
  bir CDN'dir.** Origin IP'si bugun aciktadir ve gecmis DNS kayitlarinda
  arsivlenmistir; saldirgan Cloudflare'i atlayip dogrudan vurabilir.
* **Rocket Loader ve Auto Minify KAPALI kalmali.** Ikisi de gonderdigimiz
  JS/HTML'i yeniden yazar; CSP'miz `script-src 'self' 'unsafe-inline'` ve
  cuzdan enjeksiyonu sayfa yasam dongusune baglidir.

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
