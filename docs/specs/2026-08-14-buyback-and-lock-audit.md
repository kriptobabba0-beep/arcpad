# Creator-Funded Buyback & Lock — Faz 1 (denetim) ve Faz 2 (tasarim)

> Durum: **kod DEGISMEDI.** Bu belge spec'in Faz 1-3'udur. Faz 4 (uygulama)
> baslamadan once §18'deki TEK bir ekonomik karar kullanicidan beklenir.

Referans: Pons V2 (`ponsdotdev/ponsfamily`, `contractsV2/src/v2/`). Pons bir
REFERANSTIR, mimarimiz degil.

---

## 1. MEVCUT MIMARI — olculdu, tahmin edilmedi

### 1.1 Ucret modeli: bizimki Pons'unkiyle AYNI SEKILDE DEGIL

Bu, belgedeki en onemli bulgudur ve spec'in butun §4 formulunu etkiler.

**Pons:** tek bir taban ucret, bir PAY ile bolunur.

```
protocolAmount = baseFee * protocolFeeShareBps / 10_000
creatorBucket  = baseFee - protocolAmount          // kalan
```

**Biz:** IKI BAGIMSIZ bps, ikisi de islem tutarina AYRI AYRI uygulanir.

```solidity
// BondingCurve.sol:565-567  (mezuniyet ONCESI)
uint256 protocolFee = CurveMath.feeOn(cost, PROTOCOL_FEE_BPS); // 95
uint256 creatorFee  = CurveMath.feeOn(cost, CREATOR_FEE_BPS);  // 30
uint256 total       = cost + protocolFee + creatorFee;
```

```solidity
// ArcpadHook.sol:343-348  (mezuniyet SONRASI)
(uint256 protocolBps, uint256 creatorBps) = FeeSchedule(cfg.schedule).tierFor(mcap);
uint256 protocolFee = CurveMath.feeOn(amount, protocolBps);
uint256 creatorFee  = CurveMath.feeOn(amount, creatorBps);
```

**Sonuc:** bizde "creator bucket = baseFee - protocol" diye bir kavram YOK.
Creator kovasi dogrudan `creatorFee`dir. Yani §4 bizde sadelesir:

```
buybackQuote = creatorFee * buybackLockBps / 10_000
creatorCash  = creatorFee - buybackQuote
protocolFee  = DOKUNULMAZ
```

Ve bu, spec §34'un ("protokol ucreti bagimsiz kalmali") ihlal edilmesini
YAPISAL OLARAK IMKANSIZ kilar -- protokol ucreti kendi bps'inden hesaplanir ve
buyback koduna hic girmez. Pons'ta bu bir SIRALAMA disiplinidir; bizde bir
tip-duzeyi gercektir.

### 1.2 Ucret kademeleri (`FeeSchedule.sol`)

`tierFor(marketCapUnits) -> (protocolBps, creatorBps)`:

| market cap | protokol | creator | toplam |
|---|---|---|---|
| < 59K | 95 | 30 | 125 bps |
| 59K–300K | 25 | 95 | 120 bps |
| 300K–2M | 25 | 90 → 70 | |
| 3M–11M | 25 | 65 → 30 | |
| 11M–20M | 25 | 28 → 5 | |
| ≥ 20M | 25 | 5 | 30 bps |

Egri (mezuniyet oncesi) bu tabloyu KULLANMAZ: `PROTOCOL_FEE_BPS`/
`CREATOR_FEE_BPS` `constant`tir ve kademe 0 ile ayni degerdedir.

### 1.3 Ucret akisi -- BIZIM sistemimiz (§23 istenen diyagram)

```
                    ALIS / SATIS
                         |
        +----------------+----------------+
        |                                 |
   MEZUNIYET ONCESI                 MEZUNIYET SONRASI
   BondingCurve.sol                 ArcpadHook.sol (V4 afterSwap)
        |                                 |
   cost/proceeds                     swap amount
        |                                 |
   feeOn(x, 95)  feeOn(x, 30)        tierFor(mcap) -> feeOn x2
        |             |                   |        |
   protocolFee   creatorFee          protocolFee  creatorFee
        |             |                   |        |
        +------+------+                   +---+----+
               |                              |
               v                              v
        FeeEscrow.deposit{value:}(recipient)   (ayni escrow)
               |
        owed[recipient] += value      <-- NATIVE deger (Arc: native == USDC)
               |
        claim(recipient)  <-- izinsiz, alicisina oder
```

**LP ucreti AYRI (§23):** V4 havuzunun kendi `key.fee`si
(`GraduationMath.POOL_FEE`) LP'lere gider ve hook'un tahsil ettigi protokol/
creator ucretinden BAGIMSIZDIR. Buyback fonu **yalnizca `creatorFee`**
kalemindendir. LP ucretine dokunulmaz.

### 1.4 Yasam dongusu ve kontrat haritasi

```
LaunchFactory.launch(name, symbol, uri)
   |-- CREATE2: LaunchToken   (ERC20, 1e27 sabit arz, `curve` immutable)
   |-- CREATE2: BondingCurve  (launch basina BIR TANE)
   |-- feeScheduleOf[token] = feeSchedule
   v
BondingCurve  buyExactQuoteIn / buyExactTokensOut / sellExactTokensIn
   |            fee -> FeeEscrow
   |            realTokenReserves tukenince -> complete = true (ALIS+SATIS KAPANIR)
   v
ArcpadLocker.graduate(curve)   <-- factory.graduationTarget olmali
   |-- curve `D` token + `R` quote oder, graduated = true
   |-- PoolManager.initialize(key)  -> ArcpadHook._beforeInitialize
   |-- likidite eker, LP pozisyonu KILITLI
   v
ArcpadHook  _afterSwap -> tierFor -> FeeEscrow
ArcpadRouter  kullanici swap'lari
```

### 1.5 Degistirilemezlik ve deploy modeli (§39) -- KRITIK KISIT

* `BondingCurve` ucretleri `constant`tir. Setter YOK.
* `contracts/tools/frozen_bytecode_gate.py` su bes initcode'u SABITLER:
  `BondingCurve`, `LaunchToken`, `FeeEscrow`, `FeeSchedule`, `LaunchFactory`.
* `LaunchFactory`nin initcode'u BIR ADRES BELIRLEYICISIDIR
  (`PoolDeployLib.sol` yorumu, olculmus): fabrika adresi degisirse
  `ArcpadHook`un madenlenmis CREATE2 tuzu de degisir, cunku hook'un izin
  bitleri adresin dusuk 14 bitindedir ve hook fabrikaya baglidir.
* Hook adresi `PoolKey`in bir ALANIDIR ve **ilk mezuniyetten sonra
  DEGISTIRILEMEZ**.

**Dolayisiyla:** egriye buyback eklemek -> yeni `BondingCurve` initcode ->
yeni `LaunchFactory` initcode -> yeni fabrika adresi -> hook tuzunun yeniden
madenlenmesi. Bu bugun MUMKUN (`graduationTarget == 0x0`, hicbir sey mezun
olmadi) ama 16 Agustos'ta silahlanacak mezuniyet hedefiyle ETKILESIR.

Bu, §38'in (C) secenegini zorunlu kilar: **fabrika surumlemesi, yalnizca yeni
launch'lar icin.** Mevcut launch'lar eski fabrikada kalir ve buyback'i
SONSUZA KADAR kapalidir -- sessiz bir ekonomi degisikligi olmaz.

### 1.6 Quote varligi (§24)

Arc'ta native gaz varligi USDC'nin KENDISIDIR. Egri `payable`dir ve ucretler
`deposit{value:}` ile NATIVE olarak akar (18 ondalik gorunum). ERC-20 USDC
(`0x3600...`, 6 ondalik) AYNI fonun ikinci gorunumudur; `GraduationMath.quoteWei`
donusumu yapar. Yani:

* Buyback BUTCESI native (18 dec) tutulur.
* Buyback CIKTISI `LaunchToken` (ERC-20, 18 dec) olur.
* `SafeERC20`, approve sifirlama, fee-on-transfer: `LaunchToken` bizim kendi
  standart OZ `ERC20`umuzdur, transfer ucreti YOKTUR ve rebase etmez. Yine de
  kasa `balanceBefore/After` farkiyla olcer (Pons de oyle yapar) -- ucuncu
  taraf bir token asla kilitlenmeyecek olsa bile, olcum ucuz ve kanit
  degerinde.

### 1.7 Keeper ve indexer (§29, §28)

Mevcut: `arcpad-keeper-graduate` (mezuniyet yurutucusu, `ArcpadLocker.graduate`
cagirir) ve `arcpad-keeper-window` (salt okunur pencere izleyici), ikisi de
systemd birimi olarak VPS'te. `indexer/src/logs.ts` topic0 ile cekim yapar ve
`curveToToken` haritasi tutar. Yani **buyback supurgesi icin YENI bir keeper
altyapisi kurmaya gerek yok** -- ucuncu bir birim, mevcut kaliba (systemd +
`.env`, izinsiz cagri, idempotent) eklenir.

---

## 2. PONS'TAN OGRENILENLER

### 2.1 Agirlikli-ortalama vesting saati (§16) -- DOGRU VE ALINACAK

```solidity
existingUnvested  = v.unvestedAmount;
combinedAmount    = existingUnvested + amount;
remainingDuration = existingUnvested == 0 ? 0 : v.vestingEnd - nowTs;
combinedDuration  = (existingUnvested * remainingDuration
                     + amount * VESTING_DURATION) / combinedAmount;
v.unvestedAmount  = combinedAmount;
v.vestingEnd      = nowTs + combinedDuration;
v.vestingStart    = nowTs - (VESTING_DURATION - combinedDuration);
```

Buyuklukle agirliklandirilmis bir KALAN SURE harmani. O(1). Dizi yok.
`vestingStart` yalnizca GOSTERIM icindir (matematige girmez); `start..end`
araligini tam olarak `VESTING_DURATION` yapar.

### 2.2 Vesting olcumu

```solidity
newlyVested = unvestedAmount * (nowTs - lastUpdate) / (vestingEnd - lastUpdate);
```

"Kalanin oransal payi" formu. Kendini duzeltir: `vestingEnd` kaydiginda bile
toplam korunur.

### 2.3 PONS'TA BULDUGUM HATA -- ve bunu DUZELTECEGIZ (§17)

`_checkpoint` `lastUpdate`i **kosulsuz** ilerletir:

```solidity
function _checkpoint(LaunchVest storage v, uint256 nowTs) private {
    uint256 newlyVested = _previewNewlyVested(v, nowTs);
    if (newlyVested != 0) { ... }
    v.lastUpdate = nowTs;          // <-- newlyVested == 0 IKEN DE
}
```

`_previewNewlyVested` taban aldigi icin `unvestedAmount < remainingDuration`
oldugunda (saniye cinsinden) sonuc 0'a duser. O an `lastUpdate` yine de
ilerler, yani **o zaman dilimi KALICI OLARAK KAYBOLUR**. Yeterince sik
cagrilirsa vesting `vestingEnd`e kadar TAMAMEN durur ve orada topluca acilir
-- yani "5 yila yayilmis" ozelligi yikilir.

Ulasilabilirlik: 5 yil ~1.58e8 saniye. 18 ondalikli bir token icin
`unvestedAmount < 1.58e8` wei = 1.6e-10 token, yani gercek miktarlarda
pratikte erisilmez. AMA spec §17 tam olarak "cok kucuk bakiyeler" ve "her
saniye release" testini istiyor, ve bu bir GRIEFING yuzeyidir: iki
faydalanicidan biri (protokol ya da creator) digerinin vesting'ini
yavaslatabilir.

**Bizim duzeltmemiz:** `newlyVested == 0` iken `lastUpdate`i ILERLETME.

```solidity
if (newlyVested != 0) {
    v.unvestedAmount  -= newlyVested;
    v.vestedUnreleased += newlyVested;
    v.lastUpdate = nowTs;     // yalnizca ilerleme KAYDEDILDIYSE
}
```

Zaman birikmeye devam eder, bir sonraki cagri >= 1 wei uretir uretmez
kaydedilir. Kayip sifir; O(1) korunur. Bu, Pons'tan bilincli bir SAPMADIR ve
§17'nin istedigi ozelligi saglayan tek degisikliktir.

### 2.4 Escrow: Pons'un `creditToken`i BIZDE YOK -- ve gerekmiyor (§21)

Pons vested tokenlari `feeEscrow.creditToken(...)` ile bir ERC-20 defterine
yazar. Bizim `FeeEscrow`umuz **yalnizca native**dir (`deposit` `payable`,
`owed` tek boyutlu). §21 acikca "sirf Pons'a benzemek icin escrow ekleme"
diyor. Karar: kasa vested tokenlari `SafeERC20.safeTransfer` ile DOGRUDAN
faydalaniciya gonderir. Native ucret akisi mevcut escrow'da kalir.

---

## 3. ONERILEN TASARIM (Faz 2)

### 3.1 Akis

```
ISLEM (egri ya da havuz)
   |
   +-- protocolFee ---------------------> FeeEscrow (DEGISMEDI)
   |
   +-- creatorFee
         |
         +-- buybackEnabled ?  HAYIR --> FeeEscrow(creator)   (DEGISMEDI)
         |
         EVET
         |
         +-- buybackQuote = creatorFee * buybackLockBps / 1e4
         |     -> BuybackTreasury.accrue{value:}(token)     [ISARETLEME BURADA]
         |
         +-- creatorCash = creatorFee - buybackQuote
               -> FeeEscrow(creator)

...zaman gecer, ucretler birikir...

KEEPER: BuybackTreasury.sweep(token, minTokensOut, deadline)
   |
   +-- guvenli miktari hesapla (fiyat etkisi siniri + satilabilir envanter)
   |
   +-- executable == 0 ?  --> pending'i FeeEscrow(creator)'a GERI KATLA
   |                          event BuybackSkipped
   |
   +-- executable > 0  --> egri ya da havuzdan GERCEK ALIM
                           kalan (varsa) -> FeeEscrow(creator)
                           alinan token -> BuybackVestingVault.lock(...)
                           event BuybackExecuted + BuybackLocked
```

### 3.2 Yeni kontratlar (2 adet)

| kontrat | sorumluluk | neden ayri |
|---|---|---|
| `BuybackTreasury` | token basina `pendingBuybackQuote`, supurme, fiyat-etkisi siniri, geri katlama | Ucret ISARETLEMESI ile YURUTME'yi ayirir. Escrow `deposit(recipient)` token kimligi TASIMAZ, dolayisiyla escrow bu isi yapamaz. |
| `BuybackVestingVault` | token basina `LaunchVest`, agirlikli saat, release | §14: TEK paylasilan dagitim, token basina durum |

Token basina kontrat deploy edilmez (§14).

### 3.3 Degisen mevcut kontratlar

| dosya | degisiklik | zorunlu mu |
|---|---|---|
| `BondingCurve.sol` | `creatorFee`yi bolme + `buybackEnabled` okuma | EVET -> yeni initcode |
| `LaunchFactory.sol` | `launch(..., bool buybackEnabled)`, `buybackEnabledOf` mapping, `setBuybackEnabled` izinleri | EVET -> yeni initcode -> **YENI FABRIKA ADRESI** |
| `ArcpadHook.sol` | `PoolConfig`e `buybackEnabled`, `_afterSwap`ta bolme | EVET -> yeni hook -> **TUZ YENIDEN MADENLENIR** |
| `ArcpadRouter.sol` | degisiklik beklenmiyor | hayir |
| `ArcpadLocker.sol` | mezuniyet aninda bekleyen buyback'in tasinmasi | muhtemel |
| `FeeEscrow.sol` | DEGISMEZ | hayir |
| `FeeSchedule.sol` | DEGISMEZ | hayir |

### 3.4 Izin modeli (§6)

| eylem | creator | governor Safe | keeper | herkes |
|---|---|---|---|---|
| kapali -> ACIK | EVET | **HAYIR** | hayir | hayir |
| acik -> KAPALI | EVET | EVET | hayir | hayir |
| `sweep` | - | - | EVET | tartisilacak (§13) |
| `release` | EVET | EVET | - | hayir |

Protokolun ACAMAMASI, spec §6'nin cekirdegidir: acabilseydi creator'in kendi
gelirini, ciktisindan protokolun pay aldigi bir kasaya zorla yonlendirebilirdi.

### 3.5 Tehdit modeli ozeti (Faz 3)

| tehdit | savunma |
|---|---|
| Supurme oncesi spot fiyat manipulasyonu | Keeper-operasyonlu + `maxBuybackPriceImpactBps` + `minTokensOut`. Egride manipulasyon ATAKCIYA PAHALIDIR (ayni egriden geri satmak zorunda ve %1.25 ucret oder). |
| Sandwich/MEV | Supurme miktari ve zamani ONGORULEBILIR olmamali: keeper esik + rastgele gecikme; `minTokensOut` zaten ust sinir koyar. |
| Reentrancy | `nonReentrant` + checks-effects-interactions; `pending` DUSULDUKTEN sonra disari cagri. |
| Muhasebe sapmasi | `pendingBuybackQuote` ACIK olarak izlenir; `balanceOf` ile hesap YAPILMAZ (§24). Zorla gonderilen native fazlalik `pending`e KARISMAZ. |
| Mezuniyet rezervi (§9) | Supurme, kullanici alimlarinin kullandigi AYNI `realTokenReserves` kontrolunden gecer; asla clamp'i asamaz. Test: bekleyen buyback + mezuniyet ayni blokta. |
| Basarisiz buyback fonu (§33) | `pending` -> `FeeEscrow(creator)`. Protokole GITMEZ, kontratta KALMAZ. |
| Toggle yarisi (§7) | Isaretleme ISLEM ANINDA yapilir, supurmede degil. Bizde sweep-penceresi yarisi YAPISAL OLARAK YOK. |
| Creator adres rotasyonu (§20) | Kasa `creatorRecipient`i fabrikadan SENKRONLAR; eski adres hak kaybeder. |
| Yuvarlama (§17) | §2.3'teki `lastUpdate` duzeltmesi. |
| Cross-token bulasma (§30) | Butun defterler `mapping(address token => ...)`; testte iki token paralel yurutulur. |

---

## 4. TEK ACIK EKONOMIK KARAR (§18) -- KULLANICIDAN BEKLENIYOR

Pons vested tokenlari `protocolFeeShareBps` ile boler: protokol %30, creator %70.

Bizde **tek bir "protokol payi" yok** (§1.1). En yakin karsilik
`protocolBps / (protocolBps + creatorBps)`:

| kademe | protokol | creator | Pons kuralini uygularsak protokol ALIR |
|---|---|---|---|
| < 59K (ve egri) | 95 | 30 | **%76** |
| 59K–300K | 25 | 95 | %21 |
| ≥ 20M | 25 | 5 | **%83** |

Yani egride ve dusuk kademelerde, **tamamen creator parasiyla** alinmis
tokenlarin %76'si protokole giderdi. Pons'ta bu oran %30. Bu haliyle ozellik
creator icin ekonomik olarak AKILDISI olur; hic kimse acmaz.

Secenekler:

* **(A) Sabit vest payi.** Pons'un RUHUNU korur (protokol uzun vadede pay
  alir) ama oranı kademeden AYIRIR; ornegin sabit %30/%70, launch aninda
  snapshot'lanir. *Onerim bu.*
* **(B) Kademe oranini aynen kullan.** Pons'un HARFINE sadik; ekonomik olarak
  creator aleyhine, ozellik olu dogar.
* **(C) Vest'in %100'u creator'a.** En creator-dostu; ama §18'in acikca
  korumak istedigi Pons davranisini kaldirir.

Spec §18 bu kurali sessizce degistirmeyi YASAKLIYOR, o yuzden burada duruyorum.

---

## 5. SIRADAKI ADIMLAR

1. §4'teki karar. (BLOKE EDIYOR)
2. Faz 4: `BuybackVestingVault` + `BuybackTreasury`, sonra fabrika/egri/hook V2.
3. Faz 5: Foundry testleri (§40 listesi).
4. Faz 6: indexer + web + keeper.
5. Faz 7: deploy betikleri, yeni fabrika nesli, frozen gate literalleri.
