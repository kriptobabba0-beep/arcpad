# Siradaki isler — 20 Agustos 2026

Bu dosya 19 Agustos gecesi, temiz bir durma noktasinda yazildi. Uretim
saglikli: indexer head'de (`restart=0`), iki keeper aktif, keeper 27 curve
goruyor, site 200. `main` = `d827cbe`, acik PR yok, calisma agaci temiz.

---

## Sira

### 1. ALARM ILETICI — public testnet icin TEK BASINA ENGEL

**Durum.** `arcpad-keeper-notify@.service` kurulu ama `disabled`, yapilandirmasi
hic yok. `/var/lib/arcpad/alerts.log` 671 PAGE tasiyor ve hicbiri kimseye
ulasmadi -- gece boyunca 538 cokme dahil.

**Neden ilk sirada.** Bugun bulunan dort arizanin dordu de ancak elle
bakildiginda gorundu. Gercek kullanicilar varken ayni ariza saatlerce sessiz
kalir. Tamamlanmis, testli, kurulu ve KAPALI bir alarm, olmayan bir alarmdan
kotudur: varligi guven verir.

**Gereken iki deger** (`keeper/src/notify/config.ts` ikisini de ZORUNLU tutar --
yarim bir kurulumu bilerek reddeder):

| degisken | ne ise yarar | en kolay kaynak |
|---|---|---|
| `KEEPER_NOTIFY_PAGE_URL` | her `PAGE` satirini nobetciye iletir | Discord/Slack webhook, ya da `ntfy.sh/<rastgele-konu>` |
| `KEEPER_NOTIFY_HEARTBEAT_URL` | 10 dk kalp atisi yoksa haber verir | healthchecks.io (ucretsiz) |

Ikincisi olmadan **oldurulmus bir sureci hicbir sey yakalayamaz** -- birincisi
yalnizca konusan bir sureci dinler.

**Adimlar.** Iki URL `/etc/arcpad/keeper-notify.env`e yazilir ->
`systemctl enable --now arcpad-keeper-notify@graduationWindow` ve
`@graduate` -> `alerts.log`a elle bir `PAGE` satiri yazilip **bildirimin
gercekten geldigi** dogrulanir. Kurulumun kendisi degil, o dogrulama kapatir
maddeyi.

---

### 2. `graduation-drill` — son engel

**Durum.** Bugun ilk kez kosturuldu ve fabrika adimini GECTI (adres artik
defterden okunuyor). Siradaki adim `KEEPER_ALERT_LOG_URL` istiyor: keeper'in
alarm dosyasinin HTTP'den okunabilir bir adresi.

**Karar gerekiyor** cunku bu dosyayi yayinlamak demek. Icerigi adresler,
tutarlar ve blok numaralari -- hepsi zaten zincirde public, ama yine de bilincli
bir secim.

**Secenekler.** (a) nginx'te tahmin edilemez bir yol altinda yayinla, (b) CI'a
SSH anahtari verip cektir, (c) tatbikati sunucuda kostur. En az yuzey (c),
en az is (a).

---

### 3. LAUNCH SPAM UCRETI

**Durum.** `LaunchFactory`de bir launch ucreti YOK. Kayitlarda "hala degerli"
diye isaretli ama uygulanmamis.

Testnet'te faucet ve gaz bir fren, ama TEK fren. Public bir testnette bir
betik dakikada onlarca token acabilir; maliyeti indexer, keeper ve Explore
uzerinde birikir.

**Not.** Sozlesme degisikligi = yeni deploy = adres defteri gocu. Bugun
`indexer-live`in eski fabrikayi izlemesinin sebebi tam olarak boyle bir gocun
takip edilmemesiydi; bu is o dersle birlikte planlanmali
(`scripts/ops/switch-factory.sh` var ve iki muhafiz tasiyor).

---

### 4. DIS DENETIM

Sozlesmeler kendi testleriyle, `forge`, `slither` ve dondurulmus bytecode
kapilariyla korunuyor. **Bagimsiz bir goz hic bakmadi.** Gercek para tasiyan bir
public testnet oncesi bu owner karari.

---

### 5. HSTS 3. KADEME — EKIM ORTASI, ERKEN DEGIL

`max-age` bugun **86400** (bir gun). Son kademe (63072000 = iki yil) yalnizca
GERCEK bir otomatik sertifika yenilemesi goruldukten sonra acilmali. Yenileme
bozuksa iki yil boyunca siteyi erisilemez kilar. Bkz.
`docs/runbooks/cloudflare-proxy.md`.

---

## Bugun kapananlar (referans)

* Ayni 36 escrow logu IKI KEZ kayboldu; kok neden muhafizin taniginin viem'in
  ILK DUSTUGU ucla ayni olmasiydi. Uc katmanda duzeltildi, defter 12/12 kontrol
  noktasinda zincirle esit.
* CI filtresi is akisindan ISE tasindi; `main` korumaya alindi ve
  kilitlenmedigi canli dogrulandi.
* Mezun tokenin islem paneli egri paneliyle ayni dile gecti; yolda olu bir
  `aria-labelledby` ve gecmeyen bir token gorseli cikti.
* Mum grafiginde hacim KENDI pane'ine tasindi.
* Iki zamanlanmis kapi hic is gormuyordu: `indexer-live` uc turda kalibre
  edilip **yesillendi**, `graduation-drill` ilk kez kosturuldu.
* Sunucu yeniden baslatildi (cekirdek + `libc6`), yedegin geri yuklenebilirligi
  fiilen test edildi.
