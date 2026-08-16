# Buyback & Lock — oturum devri

> Bu belge YENI BIR OTURUMUN ilk okuyacagi seydir. Amaci tek: nerede
> kalindigini ve BIR SONRAKI KOMUTUN NE OLDUGUNU tahmine yer birakmadan
> soylemek.
>
> **16 Agustos, ucuncu oturum sonu.** §9'un birakti isi -- KALICILIK -- indi;
> bolumun basligi artik "BITEN". Geriye TEK is kaldi: havuz merciinin canli
> yayini (§14), ve o bir zamanlama meselesi.

## 1. Durum

| dal | test | ne ise yarar |
|---|---|---|
| `buyback-v2` | **822/822 forge**, 308 shared, 1294 web, 355 keeper, **404 db**, **318 indexer** | butun buyback isi burada |
| `phase-1d-deploy` | uretim dali | canli VPS bunu kosuyor; bu oturumda DOKUNULMADI |

Kapilar: `make frozen-hash` YESIL, `make deps-pin` YESIL, `pnpm run lint` temiz,
`tsc --project web` temiz.

**Bu makinede kosamayan:** `packages/db` (19 suite) ve `indexer`in db suite'leri
`DATABASE_URL` ister; ne Postgres ne docker var. Bu oturumda SUNUCUDA kosturuldu
(§9'un altindaki not yolu tarif ediyor); CI de bir Postgres servisiyle kosar
(`.github/workflows/node.yml`).

## 2. COZULEN TIKANMA — ve teshisin neden yanlis oldugu

Onceki devir belgesi soyle diyordu: *"iki turetme ayni girdilerle FARKLI sonuc
uretiyor"*. **Yanlisti.** Iki turetme ayni girdileri KULLANMIYORDU.

```
LaunchFactory constructor'i        7 arguman  (olculdu: out-frozen ABI)
DeployLib.factoryArgs kodluyordu   8 arguman  (fazladan address(0))
```

Sekizinci arguman `buybackTreasury`ydi ve **hic inmemis bir tasarimin
kalintisiydi**: buyback isi onu constructor'a eklemeyi denedi, sonra vazgecildi
(bugun governor'in BIR KEZ yazdigi bir storage degiskenidir, ve bu bilerek
oyle — `LaunchFactory.buybackTreasury` NatSpec'i uc kontratin birbirinin
initcode'una girmesini engelledigini anlatir). Constructor geri alindi, deploy
tarafi ALINMADI.

Bedeli 32 baytlik bir cop kuyruguydu. Solidity constructor cozucusu fazla
baytlari sessizce yoksayar, yani fabrika YINE DE deploy olurdu — ama BASKA BIR
ADRESTE (`0x7A02759a` → `0x3eE0Ff0a`). Kayma hook tuzuna, o da hook ve locker
adreslerine yayildi.

**Elle yazilan dump'in pin'i dogrulamasi tesaduf degildi:** ikisi de dogru olan
7 arguman formunu kullaniyordu. "Iki bagimsiz kaynak ayni seyi soyluyor" gibi
gorunen sey, aslinda tek bir dogru kaynagin iki kopyasiydi.

> **KAYIT:** `FACTORY_ARG_BYTES`, `factoryArgs`in arguman sayisi ve
> `_assertInitcodeEncodesThePlan`in decode imzasi UC AYRI YERDE ayni sayiyi
> soyler. Ucu birden constructor'a bakarak degistirilir.

## 3. BU OTURUMDA EKLENEN — havuz mercii

Devir belgesinde gorunmeyen bir eksik olculdu: `_spendableOnCurve` mezun bir
egride SIFIR doner, yani **mezuniyetten sonra her buyback payi supurmede
creator'a geri katlaniyordu**. Hicbir test kirmizi degildi — geri katlama mesru
bir sonuctur ve "alim yapacak yer yok" ile "piyasa ince" disaridan ayni gorunur.

Depo sahibi "havuz merciini tam kur" dedi. Yapilanlar:

| dosya | degisiklik |
|---|---|
| `ArcpadHook.sol` | `_settleCreatorFee` — havuz ucretinde de ayrim; `buybackPolicy` CANLI okunur |
| `ArcpadHook.sol` | buyback hazinesi UCRETTEN MUAF |
| `BuybackTreasury.sol` | `_buyOnPool` + `unlockCallback` — V4 uzerinden gercek alim |
| `BuybackTreasury.sol` | `spendable()` mezuniyet sonrasi `pending` doner (eskiden 0) |
| `BuybackDeployLib.sol` + `DeployBuyback.s.sol` | kasa + hazine deploy zinciri |

### Iki tasarim karari, ikisi de spec'ten SAPMA

1. **`PoolConfig`e `buybackEnabled` EKLENMEDI.** Spec tablosu oyle diyordu.
   `PoolConfig` havuz KAYIT aninda yazilir, yani oraya konan bir bayrak
   politikayi mezuniyet aninda DONDURURDU: creator sonrasinda ne acabilir ne
   kapatabilirdi. Bunun yerine `factory.buybackPolicy(token)` her islemde canli
   okunur — `protocolTreasury()`nin neden onbelleklenmedigi ile ayni gerekce.
   `buybackPolicy`nin kendi NatSpec'i onu zaten "curve **ve hook'un** okudugu
   tek karar noktasi" diye tanimliyordu.

2. **Fiyat etkisi siniri yeniden implemente EDILMEDI.** Egride kapali formda
   cozulur; V4'te yogunlastirilmis likidite yuzunden cozulemez. Bunun yerine
   `sqrtPriceLimitX96` havuza verilir: swap sinira varinca DURUR ve girdinin
   kalanina dokunmaz. Sinirin uygulanmasi havuzun kendi kodundadir.
   *Bedeli:* harcanan miktar onceden bilinmez, `delta`dan SONRADAN olculur.

### Ucret muafiyeti — neden ve ne kadar dar

Hazine kendi havuzumuzdan alim yaparken ucret odeseydi iki sey olurdu, ve
**ikisi de mutasyonla olculdu**:

* protokol, creator'in buyback butcesinden pay alirdi (`+1.124.000.000.000.000` wei);
* alimin creator payinin bir kismi supurme SIRASINDA hazineye geri yatilirdi
  (`pendingQuote` sifir kalmadi: `177.500.000.000.000` wei).

Muafiyetin tek kosulu `sender == factory.buybackTreasury()`, ve o adres governor
tarafindan **BIR KEZ** yazilir. Muafiyet LP ucretini KAPSAMAZ — `POOL_FEE`
likidite saglayicilarina aittir.

## 4. YENI ADRES PINLERI — hook UCUNCU kez madenlendi

```
ARC_HOOK_SALT                 0x33f6
ARC_HOOK                      0xba59e8738493e063fff12ab08443e36f3aCfA0CC
ARC_LOCKER                    0xBBE8EB43380d3572cF0F97BE5A9d6755Dd3c79Aa
ARC_HOOK_CREATION_CODE_HASH   0x4db05e93...5ea725
ARC_FACTORY                   0x7A02759adD7193AD11A0C51914398d366Bf256A3   <- KIMILDAMADI
ARC_POOL_MANAGER              0x617321A877e024C870516CD599A581dCDCa6c09b   <- KIMILDAMADI
```

Fabrikanin kimildamamasi bir tasarim sonucudur: buyback kablolamasi fabrikaya
hicbir constructor argumani eklemez. Bedeli sifirdir — hicbir sey mezun olmadi,
yani hicbir hook adresi bir `PoolKey`e girmedi.

## 5. YENI OLCULEN TUZAK — buyback kontratlari da IKI bytecode uretir

`BuybackTreasury` ve `BuybackVestingVault` `out/` icinde IKI ayri artifact
uretir (800 ve 44444444) cunku `BuybackPoolVenue.t.sol` `PoolManager`i ismiyle
import eder. `ArcpadHook`inkiyle ayni sinif, ama **daha sessiz**:
`setBuybackTreasury` BIR KEZ yazilir, yani yanlis birimden turetilmis bir adrese
yayin yapmak hazineyi KALICI olarak baglar ve hicbir sey kirmizi olmaz.

Kapatildi: ikisi de `frozen_bytecode_gate.py::FROZEN` tablosunda pinli,
`BuybackDeployLib` adresleri `out-frozen/`dan turetiyor, ve
`DeployBuyback.t.sol::test_bu_birim_dondurulmus_buyback_derlemesini_GORMEZ`
ayrismanin GERCEK oldugunu her kosuda olcuyor.

> **KAPININ HASH KURALI:** `frozen_bytecode_gate.py` HEX METNININ (+ sondaki
> newline) sha256'sini alir, decode edilmis baytlarin DEGIL. Ham baytlarin
> hash'ini pin diye yazmak kapiyi hakli olarak kirmizi yapar (olculdu).

## 6. BU DEPODA OGRENILEN TUZAKLAR — tekrar dusme

1. **`vm.warp(block.timestamp + X)` SESSIZCE CALISMAZ.** `via_ir = true` ile
   solc `TIMESTAMP`i bir islem icinde sabit kabul edebilir. Zamani SABIT bir
   baslangictan MUTLAK kur.

2. **`forge build` onbellekten "successful" doner.** Bir derleme iddiasi
   `--force` olmadan kanit degildir.

3. **`out-frozen/` YALNIZCA `make frozen-hash` ile tazelenir.** Kaynak
   degistiyse ONCE onu kos.

4. **YENI — sahte zamanlayici bir korumayi GORUNMEZ kilabilir.**
   `vi.useFakeTimers()` bir zamanlama testini deterministik yapar ama timer'in
   GEC atesmesini de yok eder. `createPacer`in `nextEarliest` ilerletmesi tam
   olarak gec atesmeye karsi yazilmisti; sahte saat altinda o satiri silmek
   **70 testin hepsini yesil biraktı**. Cozum: saati ENJEKTE et
   (`PacerClock`), gecikmeyi testin kendisi kursun.

5. **YENI — bir mock'un sadakati sahte yesil uretir.** `UsdcMock` Arc'in "tek
   bakiye, iki gorunum" ozelligini modellemek zorundadir; ayri bir ERC-20
   defteri tutan bir mock, her paketi KENDI dunyasinda tutarli birakir.
   Uc kopyaydi, `test/helpers/ArcUsdcMock.sol`a cikarildi.

## 7. Tamamlanan is

| kontrat/dosya | ne | test |
|---|---|---|
| `BuybackVestingVault.sol` | 5 yil dogrusal, O(1) agirlikli saat, %30/%70 | 20 |
| `BuybackTreasury.sol` | isaretleme, egri + **havuz** mercii, fiyat etkisi, geri katlama | 22 |
| `ArcpadHook.sol` | havuzda ucret ayrimi + hazine muafiyeti | 6 (`BuybackPoolVenue`) |
| `LaunchFactory.sol` | politika, izinler, `launchWithBuyback` | 16 (`BuybackPermissions`) |
| `BuybackDeployLib` + `DeployBuyback.s.sol` | deploy zinciri | 11 |
| `frozen_bytecode_gate.py` | V2 pinleri + buyback pinleri + `LEGACY_V1` | gate |
| `scripts/emit-abi.ts` | dagitilan ABI'yi artifact'ten URETIR | — |

### Alinan ekonomik kararlar (depo sahibi onayladi)

* **Vest bolusmesi sabit %30 protokol / %70 creator**, ucret kademesinden AYRI.
* **Timelock 3 gun → 1 GUN.** Mainnet'te yeniden degerlendirilmeli.
* **Tam V2 gecisi.** V1 yalnizca `LEGACY_V1_*` sabitlerinde kayit.
* **Havuz mercii tam kurulacak** (bu oturumda soruldu ve onaylandi).

### Izin modeli — `BuybackPermissions.t.sol` bunu YURUR

```
creator : kapali -> ACIK   ve   acik -> KAPALI
governor:                       acik -> KAPALI  YALNIZCA
```

## 8. BU OTURUMDA AYRICA BITEN: keeper + web

### keeper -- `src/sweep/decide.ts` (19 test)

Karar SAFTIR: girdisi zincirden okunmus sayilar, ciktisi bir eylem. Zincire
dokunan kod ayrilmadigi surece kararin testi bir RPC taklidine baglanir ve o
taklit sapabilir.

Uc bilesen: **esik** (`spendable < MIN_SWEEP_WEI` -> atla; esik KONTRATTAN
okunur, keeper tarafinda literal DEGIL), **slipaj** (`minTokensOut`;
simulasyon yoksa supurme YOK -- `minTokensOut: 0` gecmek korumayi kapatmaktir),
**zaman** (jitter; tohum DISARIDAN verilir, yoksa anti-sandwich onlemi test
edilemez ve test edilmeyen onlem yoktur).

> `maxSlippageBps` (100) hazinenin `MAX_PRICE_IMPACT_BPS`inden (300) KUCUK
> olmali; buyuk olsaydi koruma hicbir zaman baglamazdi.

### web -- buyback kutusu ve hata yuzeyi

* `LaunchFields`/`LaunchArgs` `buyback: boolean` tasir; VARSAYILAN KAPALI.
* `launchRequest` kutu isaretliyse `launchWithBuyback`, degilse `launch`
  cagirir. `launchWithBuyback(..., false)` zincirde ayni seyi yapar ama
  kullanilmaz: `launch` canli fabrikada zaten kullanilan imzadir.
* `CALL_PATH.launch` girisi ARTIK `launchWithBuyback` -- yol eylemin
  ULASABILECEGI EN GENIS yuzeyi tarif etmeli. Dar olani secmek
  `BuybackUnavailable`i turetilen kumeden dislar ve kullanici "bilinmeyen
  hata" gorurdu.
* `BuybackUnavailable` `UNREACHABLE_BY_CONSTRUCTION`dan CIKTI ve
  `FAILURE_TABLE`a girdi -- o listedeki yazili sure kosulu tam olarak bu
  commit'ti.

## 9. INDEXER -- COZME KATMANI BITTI, KALICILIK KALDI

### Biten (dogrulandi)

1. **Buyback ABI'leri dagitildi.** `BuybackTreasury` (36 girdi) ve
   `BuybackVestingVault` (27) `packages/shared/src/abi/` altina girdi,
   `scripts/emit-abi.ts` onlari uretiyor, `abi-parity` IKI YONDE karsilastiriyor.
2. **Bes olay kaydedildi ve cozuluyor:** `buybackAccrued`, `buybackExecuted`,
   `buybackSkipped`, `buybackLocked`, `vestingReleased`. Imzalar derlenmis
   ABI'den YENIDEN TURETILIYOR, yani bir yazim hatasi sessiz kalamaz.
3. **Fixture'lar uretildi** (`FixtureGen.t.sol`): `buyback` (tahakkuk ->
   supurme -> kilit -> dagitim) ve `buyback-skipped` (geri katlama). Ikisi ayri
   senaryodur cunku tek islemde ikisi birden olusamaz.
4. **Hata sozlugu 71 -> 90.** Hazine ve kasa hatalari eklendi; yirmi dordu de
   siniflandirildi ve `NothingToRelease`/`NotBeneficiary`/`VestNotOpen` icin
   YAZILI bir sure kosulu birakildi (creator vesting talebi ekleyen commit
   onlari `FAILURE_TABLE`a tasimak zorunda).

### BITEN: kalicilik (16 Agustos) -- UCU DE TEK COMMIT'TE

`packages/db/migrations/016_buyback.sql` (`buyback_events` defteri + token
basina `buyback_state` toplami), `indexer/src/apply/buyback.ts`, ve
`verify.ts::LEDGER_OF`taki bes `null` -> `'buyback_events'`.

**Kapinin disleri MUTASYONLA olculdu, IDDIA EDILMEDI:** `LEDGER_OF`taki
`buybackLocked` tekrar `null` yapilinca `apply-buyback` suite'inde TAM OLARAK
BIR test duser -- kapsam kontrolununki. O satirin bir susleme degil bir kapi
oldugu boylece calistirilarak gosterildi.

#### Olculdu ve TASARIMI DEGISTIRDI: fixture bir ISLEM DILIMIDIR

Ilk sema `CHECK (pending_quote_wei = accrued_total_wei - spent_total_wei -
returned_total_wei)` tasiyordu -- `fee_balances.claimable_is_the_difference`in
birebir karsiligi. **Kaldirildi, cunku MESRU bir log dilimini reddediyordu.**
`contracts/fixtures/buyback.json` TEK BIR islemin loglaridir: oradaki tahakkuk
94.672.977.389.008 wei, ayni islemdeki supurmenin harcadigi
63.904.259.737.580.596 wei. Aradaki fark daha onceki islemlerde birikti ve o
loglar dosyada YOK.

Yerine gecen kural daha dar ve bu yuzden daha guclu:

* `pending_quote_wei` her tahakkukta ZINCIRIN MUTLAK `pending` degerine
  KURULUR (toplanmaz), iki tahakkuk arasinda delta ile ilerler, ve
  `GREATEST(0, ...)` ile kirpilir. Dusen bir olay bu yuzden en fazla bir
  tahakkuk boyu yasar.
* Kirpma URETIMDE BAGLAYAMAZ (`deployment.start_block` fabrikanin dagitim
  blogudur, yani indexer hazine var olmadan once baslar) ve BAGLADIGI hal ayri
  bir testle olculur -- gizli bir davranis degil.
* Dusen olayin KENDISINI yakalayan sey bu tablo degil, kapsam kontroludur.

#### `reason`da desen kisiti YOKTUR -- ve bu bilincli

`rejected_launches.reason` BIZIM yazdigimiz bir etikettir; `buyback_events.reason`
ZINCIRDEN gelir (`below-threshold-or-unsafe` -- tire icerir). Zincirin mesru
olarak yayabilecegi bir degeri reddeden bir CHECK, ingest islemini geri alir ve
indexer'i o blokta SONSUZA KADAR kilitler; `002_launches.sql` ayni gerekceyi
uzunluk kisitlari icin yaziyor.

#### Semada bir tablo acmanin gercek maliyeti -- ALTI KAPI

Yeni tablo, elle yazilmis alti listeyi birden hareket ettirdi. Hepsi
GUNCELLENDI ve hicbiri gevsetilmedi:

| kapi | ne degisti |
|---|---|
| `migrate.test.ts::EXPECTED` | `016_buyback.sql`; ve "sona ekleme" probu `016_` -> `017_` (`016_appended` artik ONE siralanirdi) |
| `constraints.test.ts::ALL_TABLES` | iki tablo; ve bosluk muhafizi icin BES tohum satiri |
| `constraints.test.ts` adres taramasi | 19 -> 22 sutun, ve `caller_addr`/`venue_addr` icin YOLDAS alanlar |
| `naming.test.ts::EXPECTED_INVENTORY` | otuz bir sutun |
| `naming.test.ts` numeric sayisi | 43 -> 57 |
| `pool.test.ts::snapshot` | iki tablo |

> `caller_addr`/`venue_addr` YOLDAS ALANLARI istedi ve sebep ogreticidir:
> tarama bir satiri kopyalayip TEK bir kolonu bozar, ama `kind` bes degerden
> birini alir ve her deger BASKA bir kolon kumesini zorunlu/yasak yapar. Yoldas
> kumesi olmadan pozitif kontrol "desen calismiyor" diye degil "BASKA bir kisit
> dogru calisti" diye kirmizi olurdu.

> **BU ADIM POSTGRES ISTER.** Sunucuda calisiyor ve `/etc/arcpad/db-test.env`
> icinde ayrilmis bir test veritabani var (`arcpad_test`). SSH TUNELI PRATIK
> DEGIL (404 db testi on dakikada bitmedi). Kullanilan yol: `/opt/arcpad`
> (URETIM checkout'u) KAYNAK olarak klonlanip `/root/arcpad-buyback`
> worktree'si kuruldu, degisen dosyalar `scp` ile tasindi, testler SUNUCUDA
> kosturuldu. Uretim checkout'una DOKUNULMADI.
>
> **TEK VERITABANI, TEK KOSU.** Iki tam kosuyu ust uste bindirmek
> `migrate.test.ts`te 32 sahte dusus uretti: onceki kosunun indexer fazi ayni
> semayi dusuruyordu. Ariza kodda degil olcumdeydi.

## 10. ACIK KARAR -- OLCULDU, KAPATILMADI

**EGRI MERCII UCRET ODUYOR, HAVUZ MERCII ODEMIYOR.**

`BuybackLifecycle.t.sol::test_korunum_tahakkuk_eden_her_wei_hesapta` bunu her
kosuda olcer. Hazinenin EGRI uzerinden yaptigi alim normal bir islemdir:
protokol ~%0,95 alir (buyback butcesinden SIZINTI), creator ~%0,30 alir ve
onun yarisi YENIDEN tahakkuk eder. Havuzda ise hazine ucretten MUAFTIR.

Muafiyeti egriye de tasimak `BondingCurve` initcode'unu degistirir; curve
initcode'u `LaunchFactory`ye GOMULU oldugu icin fabrika adresi, o da hook tuzu
ve locker adresi kayar -- yani butun adres kumesi UCUNCU kez madenlenir.
Bedeli olcusunde bir karar oldugu icin sessizce alinmadi.

## 12. CANLI KANIT -- ARC TESTNET, 16 AGUSTOS

Simulasyon degil. Asagidakilerin hepsi Arc testnet'te GERCEKTEN kosturuldu.

### Yayinlanan adresler

```
LaunchFactory  (V2)     0x7A02759adD7193AD11A0C51914398d366Bf256A3
ArcpadHook     (V2)     0xba59e8738493e063fff12ab08443e36f3aCfA0CC
ArcpadLocker   (V2)     0xBBE8EB43380d3572cF0F97BE5A9d6755Dd3c79Aa
BuybackVestingVault     0x2FCfb857A058448Cd6387d48B40382e73B9E24aB
BuybackTreasury         0xeC111Bc3D210A09D9660ac628386a6613e69e9DD

yeniden kullanildi (DEGISMEDI):
FeeEscrow               0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6
FeeSchedule             0x47548C1ce996b24846E948B815459D98BB08dc84
PoolManager             0x617321A877e024C870516CD599A581dCDCa6c09b
```

Uc adres de deploy ONCESI pinlerle BIREBIR tuttu -- yani `out-frozen/`
turetmesi canli zincirde dogrulandi.

### Governor Safe adimlari -- dordu de yurutuldu

`setBuybackTreasury`, `setGraduationHook`, `setBuybackKeeper`,
`proposeGraduationTarget`. Her biri iki sahiple imzalandi (2-of-3), Safe
hash'i yerel EIP-712 ile zincirdeki `getTransactionHash` karsilastirilarak
uretildi.

> `Governance.s.sol`e uc encode fonksiyonu EKLENDI (`encodeSetBuybackTreasury`,
> `encodeSetGraduationHook`, `encodeSetBuybackKeeper`) -- buyback kablolamasi
> icin yoktu.

### Test tokeni: "Buyback Proof" (BBP)

```
token  0x5d29f2e569070d31f4aaf229ba7318b676ee850e
curve  0x398f2f3D546C6483E495A2726A15Ea465A559f6e
```

**UCRET AYRIMI, HER ISLEMDE TAM YARI YARIYA:**

| an | buyback butcesi | creator nakdi (artis) |
|---|---|---|
| baslangic | 0 | -- |
| 1. alim (2 USDC) | 0,002963 | +0,002963 |
| 2. alim | 0,005926 | +0,002963 |
| 3. alim | 0,008889 | +0,002963 |

Sonra 7 al-sat turu -> butce 0,059259 USDC. **Satislar da pay ayirdi.**

**SUPURME (gercek geri alim):**

```
harcanan          0,059259 USDC   (butcenin TAMAMI)
geri alinan       14.435.072,652524 BBP
kasada kilitli    14.435.072,652524 BBP   (birebir esit)
vesting           157.680.000 sn = 1825 gun = 5,0 yil
protokol payi     3000 bps = %30
```

**MUHASEBE:** `pendingQuote == hazine bakiyesi == 87.791.495.198.903 wei`.
Tek bir sahipsiz wei yok.

**DAGITIM:** `release()` -> creator %70,00 / protokol %30,00 (olculdu).

### §10'DAKI ASIMETRI ZINCIRDE DOGRULANDI

Supurmeden sonra `pendingQuote` SIFIR DEGIL, 0,000088 USDC kaldi. Bu, supurmenin
KENDI aliminin creator ucretinin yarisinin geri tahakkuk etmesidir --
`BuybackLifecycle.t.sol`un olctugu davranisin ta kendisi. Simulasyonda gorulen
sey zincirde birebir tekrarlandi.

### IZIN MODELI -- CANLI ZINCIRDE

| cagiran | eylem | sonuc |
|---|---|---|
| governor Safe | ACMAK | **REDDEDILDI** `GovernorCannotEnableBuyback()` (`0x85ebfa13`) |
| governor Safe | KAPATMAK | izin verildi |
| creator | ACMAK | izin verildi |
| creator | KAPATMAK | izin verildi |
| yabanci | ACMAK | **REDDEDILDI** `NotLaunchCreator()` (`0xf5349261`) |

Ozelligin guven cekirdegi canli zincirde dogrulandi.

### HENUZ KANITLANMAYAN TEK SEY: HAVUZ MERCII

`proposeGraduationTarget` yurutuldu ama `applyGraduationTarget` **24 saatlik
timelock** bekliyor (eta 1786914903). O inmeden hicbir curve mezun olamaz,
dolayisiyla havuzdan geri alim canli olarak henuz yurunmedi.

**SONRAKI KOMUT** (eta gectikten sonra, IZINSIZ -- herkes cagirabilir):

```bash
cast send 0x7A02759adD7193AD11A0C51914398d366Bf256A3 "applyGraduationTarget()"   --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
```

> PENCERE IKI TARAFLIDIR: eta'dan itibaren 24 saat ACIK kalir, sonra oneri
> DUSER ve bastan onerilmesi gerekir.

Sonra: yeni bir launch -> egriyi tamamla -> `locker.graduate(curve)` -> havuzda
swap -> `sweep` (bu kez HAVUZ mercii) -> kasaya kilit.

## 13. 16 AGUSTOS -- YAYININ EKSIK KALAN PARCALARI

Havuz kanitini hazirlarken uc ayri eksik ortaya cikti. **Ucu de dun gozden
kacmisti ve ucu de baska bir kapinin yan urunu olarak gorunur oldu** -- yani
hicbiri dogrudan kirmizi degildi.

### (1) ROUTER V1 HOOK'UNA BAGLI KALMIS

`ArcpadRouter`in `hook`u bir constructor argumanidir, yani yeni hook yeni bir
adres demektir. Dun fabrika/hook/locker/kasa/hazine yayinlandi, **router
yayinlanmadi**: canli router (`0x7496950E...`) hala V1 hook'unu (`0x89Afef...`)
bildiriyordu. Sonucu somut: V2'de mezun olan bir token router uzerinden ALINIP
SATILAMAZDI -- router'in kuracagi `PoolKey`e V2 havuzlari cevap vermez.

Yayinlandi: **`0x51Bb2Ce3f5347e5447beFf6B72801d75cCe79fD5`**. Runtime boyutu
degismedi (6679 bayt, olculdu) -- ayni kontrat, yeni adres.

### (2) TYPESCRIPT HOOK TUZU IKI NESIL BAYAT

`packages/shared/src/addresses.ts` `ARCPAD_HOOK_SALT`i **13** olarak
tasiyordu -- ILK madencilik turunun tuzu. Hook o gunden beri IKI KEZ yeniden
madenlendi (`0x1273`, sonra `0x33f6`) ve TypeScript tarafi ikisinde de yerinde
kaldi.

Yanindaki yorum "ayni sayi IKI ayri derleme biriminde; ayrisirlarsa biri
kirmizi olur" diyordu. **O bir dilekti, kapi degildi:**
`barrel-salts.test.ts` her tuzun barrel'dan DISARI VERILDIGINI olcuyordu,
DEGERINI degil -- yanlis ama tanimli bir tuz o testten sorunsuz gecer.

Bedeli olculdu: `scripts/addressbook.ts` hook adresini bu tuzdan turetir ve
bayat tuzla `0xd95198Cd...e0cC` uretti (ne V1 ne V2). Defter YANLIS bir hook
adresiyle yazilacakti; yalnizca `assertRouterMatchesBook` -- canli router'in
`hook()`unu okuyan BASKA bir kapi -- durdurdu.

Kapatildi: tuz `0x33f6` yapildi ve **`packages/shared/test/solidity-pin-parity.test.ts`**
eklendi. `.sol` kaynagini okuyup literalleri ayristirir; degeri olcer, varligini
degil. Mutasyonla dogrulandi: tuz 13'e dondurulunce iki test birden duser.

### (3) DEFTER URETICISI `RedeployPoolLayer`I GORMUYORDU

`scripts/addressbook.ts` havuz uclusunu YALNIZCA `DeployPool.s.sol` makbuzundan
okuyordu. Buyback nesli `RedeployPoolLayer.s.sol` ile indi (PoolManager
yerinde kaldigi icin), dolayisiyla jenerator yeni hook'u HIC gormedi ve onceki
defterden V1'i tasidi.

Kapatildi: `newestPoolReceipt()` iki makbuza da bakar ve **icerige gore** secer
-- hangisi `ARCPAD_HOOK_SALT` ile bir deploy TASIYORSA o, ikisi de tasiyorsa
daha YENI blok numarasi olan. Dosya tarihi bir `git checkout` ile degisir, blok
numarasi degismez.

### Defterin yeni hali

```
launchFactory  0x7A02759adD7193AD11A0C51914398d366Bf256A3
arcpadHook     0xba59e8738493e063fff12ab08443e36f3aCfA0CC
arcpadLocker   0xBBE8EB43380d3572cF0F97BE5A9d6755Dd3c79Aa
arcpadRouter   0x51Bb2Ce3f5347e5447beFf6B72801d75cCe79fD5   <- YENI
smokeToken     0x5D29F2E569070D31f4AAf229BA7318b676Ee850e   (buyback kanit tokeni)
```

Defter degisince canli adresi pinleyen alti test kirmizi oldu (shared, scripts,
keeper x3, web x3) -- **ve bu, o testlerin var olma sebebidir.** Hepsi
guncellendi; `web/test/pool/config.test.ts`in "MEASURED" blogu elle
duzenlenmedi, zincire karsi YENIDEN OLCULDU.

## 14. HAVUZ MERCII -- CANLI FORK KANITI

Uretim penceresi (mezuniyet timelock'u) bu satirlar yazilirken henuz acilmadi;
atilabilir bir yigin kursak onun saati de bir gun, yani DAHA GEC acilirdi.
Kisayol aramak, kanitlanmaya calisilan korumayi delmek olurdu.

Bu arada yapilabilecek en guclu sey yapildi:
`GraduationCycle.live.fork.t.sol`e buyback eklendi ve **CANLI `PoolManager`a
karsi** kosuyor -- taklit degil, Arc testnet'te deploy edilmis `0x617321A8...`.

* `test_buybackSweepsOnTheLivePoolAfterGraduation` -- mezuniyet sonrasi
  supurme gercek V4 havuzundan alim yapar, kasaya kilitler, fiyat etkisi
  sinirinda kalir, hazinede muhasebesiz wei birakmaz.
* `test_theTreasurysLivePoolBuyPaysNoProtocolFee` -- ucret muafiyeti canli
  `FeeSchedule` altinda da gecerli.

Uretim yigini HIC kullanilmaz: fabrika, hook, locker, kasa ve hazine testin
kendi atilabilir kopyalaridir.

**SONRAKI KOMUT** (pencere acilinca, IZINSIZ):

```bash
cast send 0x7A02759adD7193AD11A0C51914398d366Bf256A3 "applyGraduationTarget()"   --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
```

Sonra: `launchWithBuyback` -> egriyi tamamla -> `locker.graduate` -> havuzda
swap -> `sweep`. Bu kez BROADCAST ile.

## 15. Bu isle ILGISIZ ama bekleyen

* **16-19 Agustos penceresi V1 fabrikasina ait.** Tam V2'ye geciyorsak o
  pencereyi kullanmak GEREKMEYEBILIR — V2 kendi hedefini kendi 1 gunluk
  timelock'uyla kurar. **Hala netlesmedi.**
* Alan adi + TLS (`scripts/enable-tls.sh <domain>`), ve uc Safe anahtarinin uc
  ayri cihaza ayrilmasi. Ikisi de sahipte.
