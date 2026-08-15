# Buyback & Lock — oturum devri

> Bu belge YENI BIR OTURUMUN ilk okuyacagi seydir. Amaci tek: nerede
> kalindigini ve BIR SONRAKI KOMUTUN NE OLDUGUNU tahmine yer birakmadan
> soylemek.

## 1. Iki dal, iki durum

| dal | son commit | test | ne ise yarar |
|---|---|---|---|
| `phase-1d-deploy` | `f0ac102` | **779/779 YESIL** | uretim dali. Canli VPS bunu kosuyor. |
| `buyback-v2` | `0b712e1` | 775/779 | butun buyback isi burada |

`phase-1d-deploy` buyback isinden ETKILENMEDI: iki yeni kontrat oraya da
commit'lendi ama mevcut sisteme baglanmadi, yani davranis degismedi.

## 2. TIKANDIGIM TEK NOKTA -- ilk is bu

`buyback-v2` dalinda 4 test kirmizi ve HEPSI ayni konuda: CREATE2 adres
turetmesi.

```
kaynaktaki sabit           PoolDeployLib.ARC_FACTORY = 0x7A02759adD7193AD11A0C51914398d366Bf256A3
calisma zamani turetmesi   DeployLib.frozenFactoryAddress() -> 0x3eE0Ff0ad744bDbb08fc65626067A2C3D4BCC2a6
```

Elle yazdigim ve `frozenFactoryAddress` ile **ayni formulu** kullanan bir dump
`0x7A02759a` verdi. Yani iki turetme ayni girdilerle FARKLI sonuc uretiyor.

**Sonraki komut (tahmin YOK, olcum):** iki formulu yan yana koyup hangi
girdinin ayristigini bas. Sirasiyla: `frozenEscrowAddress()`,
`frozenFeeScheduleAddress()`, `Profiles.forChain(chainId)` alanlari,
`Profiles.governanceForChain(chainId)`, ve `FACTORY_SALT`. Biri ayrisiyordur;
hangisi oldugu ölçülünce is bir satirlik.

Kirmizi dort test:
```
test_aFactoryThatIsNotTheDerivedOneIsRefused
test_anOccupiedHookAddressStopsTheDeploy
test_theArcPinStopsThePinnedSaltReproducingADifferentAddress
test_readBackCatchesANonZeroGraduationTarget      <- bu AYRI: 3 gun warp'i kaldi
```

## 3. BU DEPODA OGRENILEN UC TUZAK -- tekrar dusme

1. **`vm.warp(block.timestamp + X)` SESSIZCE CALISMAZ.** `via_ir = true` ile
   solc `TIMESTAMP`i bir islem icinde sabit kabul edip okumayi tek sefere
   indiriyor. Dongudeki ikinci ve sonraki warp'lar hicbir sey yapmaz ve test
   HATA VERMEDEN yanlis olani olcer. Zamani SABIT bir baslangictan MUTLAK kur.

2. **`forge build --contracts <tek dosya>` onbellekten "Compiler run
   successful" doner.** Atanmamis bir `immutable` boyle iki kez "derledi"
   gorundu. Bir derleme iddiasi `--force` olmadan kanit degildir.

3. **`out-frozen/` YALNIZCA `make frozen-hash` ile tazelenir.** `forge clean`
   onu siler, `forge build` geri getirmez, ve `forge test` bayat dizini okuyup
   eski adresleri uretir. Saatlerimi bu yedi. Kaynak degistiyse ONCE
   `make frozen-hash`.

## 4. Tamamlanan is (calisiyor, testli)

| kontrat/dosya | ne | test |
|---|---|---|
| `BuybackVestingVault.sol` | 5 yil dogrusal, O(1) agirlikli saat, %30/%70 | 20 |
| `BuybackTreasury.sol` | isaretleme, guvenli supurme, fiyat etkisi, geri katlama | 21 |
| `BondingCurve.sol` | `_settleCreatorFee` -- ucret ayrimi | mevcut paket |
| `LaunchFactory.sol` | politika, izinler, `launchWithBuyback` | mevcut paket |
| `frozen_bytecode_gate.py` | V2 pinleri + `LEGACY_V1` kaydi | gate |
| `Surface.t.sol` | 33 fonksiyon / 28 hata / 9 olay | 43 |

### Alinan ekonomik kararlar (depo sahibi onayladi)

* **Vest bolusmesi sabit %30 protokol / %70 creator**, ucret kademesinden
  AYRI. Kademeyi kullanmak egride %76 protokol ederdi ve ozelligi creator
  icin akildisi yapardi.
* **Timelock 3 gun -> 1 GUN.** Mainnet'te yeniden degerlendirilmeli.
* **Tam V2 gecisi.** Testnet oldugumuz icin eski token'lar tasinmiyor; V1
  yalnizca `LEGACY_V1_*` sabitlerinde kayit.

### Izin modeli (ozelligin guven cekirdegi)

```
creator : kapali -> ACIK   ve   acik -> KAPALI
governor:                       acik -> KAPALI  YALNIZCA
```

Governor acamaz cunku buyback'in parasi creator'in gelirinden cikar ama
ciktisinin %30'u protokole gider.

## 5. Kalan is sirasi

1. **§2'deki adres ayrismasini olc ve kapat** -> 779/779
2. `ArcpadHook` V2: `PoolConfig`e `buybackEnabled`, `_afterSwap`ta ayrim
3. Entegrasyon testleri: ucret bolunmesi, toggle yarisi, mezuniyet rezervi
4. Deploy zinciri: kasa -> hazine -> `setBuybackTreasury` -> `setGraduationHook`
5. indexer + web + keeper
6. Dokumantasyon ve final rapor

## 6. Bu isle ILGISIZ ama bekleyen

* **16-19 Agustos penceresi V1 fabrikasina ait.** Tam V2'ye geciyorsak o
  pencereyi kullanmak GEREKMEYEBILIR -- V2 kendi hedefini kendi 1 gunluk
  timelock'uyla kurar. Bir sonraki oturumda netlesmeli.
* Alan adi + TLS (`scripts/enable-tls.sh <domain>`), ve uc Safe anahtarinin
  uc ayri cihaza ayrilmasi. Ikisi de sahipte.
