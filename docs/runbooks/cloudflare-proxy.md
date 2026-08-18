# Cloudflare proxy'sini acmak — sirali, her adimi geri alinabilir

> Durum: **FAZ 0–3 UYGULANDI VE DOGRULANDI (2026-08-17).** `A` kaydi
> `Proxied`, origin guvenlik duvari Cloudflare aralıklarina kisildi, sertifika
> yenilemesi o kisitin ARKASINDAN dogrulandi. **FAZ 4'un 1. kademesi de canli**
> (`max-age=300`). Kalan: FAZ 4'un 2-3. kademeleri (zaman gerektirir) ve istege
> bagli FAZ 5. Olculmus kanit: §10.

## 0. Neden acmak istiyoruz

| Kazanc | Neden onemli |
|---|---|
| DDoS emilimi | Kenar, hacmi origin'e hic ulastirmadan yutar |
| Origin IP'nin gizlenmesi | Dogrudan saldiri yuzeyi kaybolur — **ama tek basina yetmez, bkz. §5** |
| Statik varliklarin kenardan servisi | `/_next/static/` ve `/api/ipfs/` `immutable` gonderir; binlerce kullanicida bu ciddi bir yuk azalmasi |
| TLS'in kenarda yonetilmesi | Sertifika yenileme kritik yoldan cikar (bkz. §6) |

## 1. Neden BUGUN acilmiyor — olculmus tek sebep

`nginx` hiz sinirini ziyaretcinin IP'siyle anahtarliyor:

```
limit_req_zone $binary_remote_addr zone=arcpad_read:10m  rate=20r/s;
limit_req_zone $binary_remote_addr zone=arcpad_write:10m rate=1r/s;
```

ve konfigurasyonda **`set_real_ip_from` / `real_ip_header` HICBIR YERDE YOK**
(depoda arandi: sifir sonuc).

Proxy acilirsa nginx her ziyaretciyi Cloudflare'in cikis IP'siyle gorur, yani
**butun trafik tek bir kovaya duser**: `arcpad_read` icin 20r/s ve `burst=40`
saniyeler icinde dolar ve **gercek kullanicilar 429 yer**. Explore sayfasi tek
basina 48 gorsel istegi acar; bir kullanici bile kovayi zorlar.

Yani proxy'i once acmak, "binlerce kullanici" hedefinin TAM TERSINI uretir. Bu
tek satir, sirali planin var olma sebebi.

## 2. Proxy'nin BOZMADIGI seyler — ikisi de olculdu, varsayilmadi

**HTML onbellege ALINMAZ.** Canli olcum:

```
$ curl -sI https://outofmind.fun/
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
```

Bu, proxy'nin en korkutucu riskini (bir kullanicinin sayfasini baskasina
servis etmek) eler. Next zaten dogru basligi gonderiyor.

**Yukleme Cloudflare'in 100 saniyesine takilmaz.** `/api/metadata` iki pin
cagrisi yapar ve her birinin kendi tavani var
(`AbortSignal.timeout(20_000)`), yani **gercek tavan ~40 saniye**. Cloudflare
free/pro planinda origin'in yanit vermesi icin ~100 saniye vardir; 40 < 100.

> Yine de bir hijyen duzeltmesi var: nginx o rotada `proxy_read_timeout 120s`
> tasiyor, yani **Cloudflare'in sinirindan UZUN**. 100 ile 120 arasinda kalan
> bir istek, bizim okunur hatamiz yerine Cloudflare'in **524**'u olarak
> gorunur. §3'te 90s'ye indiriliyor: hatanin sahibi biz olalim.

**Mail etkilenmez.** Ekran goruntusundeki `MX` ve `TXT` kayitlari `DNS only`
KALIR — mail proxy'lenmez. Yalnizca `A` kaydi proxy'lenir.

## 3. FAZ 0 — sunucu hazirligi ✅ **UYGULANDI 2026-08-17**

> **Sonuc:** `nginx -t` gecti, reload edildi, site DEGISMEDI (HTTP 200, CSP ve
> diger basliklar aynen). Uc olcum asagida.

Bu fazin tamami proxy kapaliyken **etkisizdir**: Cloudflare aralıklarindan
trafik gelmedigi icin `set_real_ip_from` hicbir istegi etkilemez. Bu yuzden
once yapilir — 4. fazi guvenli kilan sey budur.

**0a. Cloudflare aralıklarini bir DOSYAYA cek, ve TAZE TUT.**

Aralıklar DEGISIR. Bayat bir liste iki yonde de zarar verir: yeni bir CF IP
guvenilmezse o ziyaretcilerin gercek IP'si geri gelmez (ve tek kovaya
duserler); liste elle yazilirsa bir gun sessizce eksik kalir.

Sevkedilen hali (`/usr/local/bin/arcpad-cf-ranges`):

```sh
#!/bin/sh
set -eu
# NORMALIZASYON ZORUNLU: v4 listesinin SON satirinda newline YOKTUR, yani iki
# ciktiyi dogrudan birlestirmek v6'nin ilk satirini ona YAPISTIRIR. `nginx -t`
# bunu yakaladi (bkz. 0d-i). `tr` her bosluk turunu satir sonuna cevirerek
# sinifi kokunden kapatir: CRLF, bosluk, eksik newline -- hepsi ayni.
tmp_cidr="$(mktemp)"; tmp_conf="$(mktemp)"
{ curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4; printf '
'
  curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6; printf '
'
} | tr -s '[:space:]' '
' | awk 'NF' > "$tmp_cidr"

# HER SATIR BIR CIDR OLMAK ZORUNDA. Bicimi dogrulanmamis bir liste, `nginx -t`i
# her gun dusuren bir timer demektir -- ve o an eski konfig kalir, yani SESSIZ
# bir donma.
grep -qvE '^[0-9a-fA-F:.]+/[0-9]{1,3}$' "$tmp_cidr" && { echo "CIDR olmayan satir" >&2; exit 1; }
test "$(wc -l < "$tmp_cidr")" -ge 10

awk 'NF {print "set_real_ip_from " $0 ";"}' "$tmp_cidr" > "$tmp_conf"
# CEKME DUSERSE ESKI DOSYALAR KALIR: bos bir liste, butun ziyaretcilerin gercek
# IP'sini kaybetmek (ve hepsini tek kovaya dusurmek) demekti.
mv "$tmp_conf" /etc/nginx/cloudflare-ranges.conf
mv "$tmp_cidr" /etc/arcpad/cf-cidrs.txt
```

`arcpad-cf-ranges.timer` gunde bir kez kosar (`RandomizedDelaySec=1h`,
`Persistent=true`) ve `ExecStartPost` yalnizca `nginx -t` GECERSE reload eder --
bozuk bir konfigurasyonla reload siteyi dusururdu.

**0b. nginx'e gercek IP'yi geri ver.**

`server` blogunun icine:

```nginx
include /etc/nginx/cloudflare-ranges.conf;
real_ip_header CF-Connecting-IP;
```

`CF-Connecting-IP` secildi, `X-Forwarded-For` DEGIL. Sebep: `CF-Connecting-IP`
TEK bir degerdir ve Cloudflare onu her zaman kendisi yazar; `X-Forwarded-For`
bir LISTEDIR, `real_ip_recursive` gerektirir ve yanlis yapilandirmasi kolaydir.

**Sahtecilik mumkun degil, ve bunun nedeni sira DEGIL yapidir:** nginx bu
basligi ancak istek `set_real_ip_from` listesindeki bir adresten geldiginde
DIKKATE ALIR. Origin'e dogrudan vuran bir saldirgan o listede olmadigi icin
uydurdugu `CF-Connecting-IP` YOK SAYILIR. Bu yuzden 0b, guvenlik duvarindan
(§5) ONCE yapilabilir.

**0c. `/api/metadata` zaman asimini Cloudflare'in altina indir.**

```nginx
# 90s, 120s DEGIL: Cloudflare origin'e ~100 saniye verir ve gecen istek
# bizim hatamiz yerine onun 524'u olur. Gercek tavan ~40s (iki pin x 20s),
# yani 90s hala bol.
proxy_read_timeout 90s;
```

**0d. Dogrula.** Uc sey olculdu:

**(i) `nginx -t` GERCEK bir hata yakaladi, ve reload'dan ONCE.** Ilk cekim
betigi iki listeyi dogrudan birlestirdi; v4'un son satirinda newline olmadigi
icin v6'nin ilki ona yapisti:

```
[emerg] host not found in set_real_ip_from "131.0.72.0/222400:cb00::/32"
```

Site el DEGMEDI (reload kosmadi). Betik `tr` ile normalize
edildi ve **her satirin CIDR oldugu dogrulanir** -- bicimi kontrol edilmeyen
bir liste, `nginx -t`i her gun dusuren bir timer demekti. Simdi 22 aralik,
iki dosya birebir tutuyor.

**(ii) Site degismedi.** Reload sonrasi yerelde `200 200 200`, disaridan
`HTTP 200`, `ssl_verify_result 0`, ve CSP / `X-Frame-Options` / `Cache-Control`
aynen. Proxy kapali oldugu icin yeni satirlar beklendigi gibi ETKISIZ.

**(iii) SAHTECILIK KAPALI -- ve bu iddia OLCULDU, akil yurutulmedi.**
Disaridan uydurma basliklarla iki istek atildi:

```
curl -H 'CF-Connecting-IP: 203.0.113.99' https://outofmind.fun/?spooftest=1
curl -H 'X-Forwarded-For: 198.51.100.7'  https://outofmind.fun/?xfftest=1
```

Erisim logu ikisinde de **gercek istemci IP'sini** yazdi (`95.7.225.216`),
uydurulani DEGIL. nginx `CF-Connecting-IP`'yi ancak istek
`set_real_ip_from` listesindeki bir adresten geldiginde dikkate alir; benim
makinem o listede olmadigi icin baslik yok sayildi.

Bu, FAZ 0'in guvenlik duvarindan (FAZ 3) ONCE durmasinin neden guvenli
oldugunun kanitidir.

## 4. FAZ 1 — Cloudflare panel ayarlari (proxy'i ACMADAN once)

| Ayar | Deger | Neden |
|---|---|---|
| SSL/TLS → encryption mode | **Full (strict)** | Varsayilan "Flexible" Cloudflare↔origin bacagini **SIFRESIZ** birakir. Sertifikamiz publicly-trusted (Let's Encrypt), yani strict'i zaten karsiliyor |
| Minimum TLS | 1.2 | — |
| Always Use HTTPS | on | Kenarda yonlendirme; nginx'teki 301 zararsizca kalir |
| **Rocket Loader** | **OFF** | JS'i yeniden yazar ve erteler. CSP'miz `script-src 'self' 'unsafe-inline'` ve cuzdan enjeksiyonu sayfa yasam dongusune baglidir — ikisini de bozabilir |
| **Auto Minify** | **OFF** | Ayni sinif: gonderdigimiz baytlari degistirir |
| Bot Fight Mode | OFF (baslangicta) | Mesru API isteklerine challenge basar |
| WAF managed rules | varsayilan | POST yollarini engelleyebilir; once gozlem |

Rocket Loader maddesi bu listenin en kolay atlananidir ve en pahalisidir.

## 5. FAZ 2 — A kaydini `Proxied` yap, sonra DOGRULA

Tek tiklama, ve **geri donusu de tek tiklama** (TTL `Auto`, saniyeler icinde
yayilir). Bu yuzden bu faz risksiz sayilir; risk 5. fazdadir.

Acildiktan sonra sirayla:

```bash
# 1) Gercek IP geri geldi mi -- bu fazin ASIL sorusu
tail -n 20 /var/log/nginx/arcpad.access.log      # CF IP'si DEGIL, ziyaretci IP'si gormeli

# 2) 429 firtinasi var mi
for i in $(seq 1 60); do curl -so /dev/null -w '%{http_code} ' https://outofmind.fun/; done

# 3) Kenar onbellegi calisiyor mu (asil kazanc)
curl -sI https://outofmind.fun/api/ipfs/<bilinen-cid> | grep -i cf-cache-status   # ikinci istekte HIT

# 4) Sertifika yenilemesi proxy ARDINDAN da calisiyor mu
certbot renew --dry-run

# 5) Gercek bir yukleme (40s tavani ve 524 yok)
#    /create uzerinden bir gorsel yukle
```

4. madde atlanamaz: ACME dogrulamasi artik Cloudflare uzerinden geliyor.
`--dry-run` gecmezse **proxy'i geri kapat** ve sebebini coz — yoksa 90 gun
sonra sertifika sessizce sona erer.

## 6. FAZ 3 — origin'i Cloudflare aralıklarina kapat (RISKLI ADIM)

**Bu adim olmadan proxy bir GUVENLIK ONLEMI DEGIL, yalnizca bir CDN'dir.**
Origin IP'si (`167.99.135.135`) bugun `DNS only` oldugu icin ZATEN acikta ve
gecmis DNS kayitlarinda arsivlenmis durumda; saldirgan Cloudflare'i atlayip
dogrudan IP'ye vurabilir. Gizlenmenin anlam kazanmasi icin origin yalnizca
Cloudflare'i kabul etmeli.

**Ayni dosya, iki tuketici.** Guvenlik duvari kurallari da
`/etc/nginx/cloudflare-ranges.conf`i besleyen AYNI cekimden turetilir. Iki ayri
liste bir gun ayrisir ve ayristigi gun ya kullanicilar 429 yer ya kapi acik
kalir.

**Kilitlenmeye karsi: ZAMANLANMIS OTOMATIK GERI ALMA.** Kural uygulanmadan
once geri alma zamanlanir; site dogrulandiktan SONRA iptal edilir.

```bash
# 1) Mevcut durumu kaydet
ufw status numbered > /root/ufw-before.txt

# 2) On dakika sonra KOSULSUZ geri alma zamanla (once bunu kur!)
echo 'ufw allow 80; ufw allow 443' | at now + 10 minutes

# 3) 80/443'u yalnizca Cloudflare'e ac. SSH'A DOKUNULMAZ.
ufw delete allow 80; ufw delete allow 443
for cidr in $(cat /etc/arcpad/cf-cidrs.txt); do
  ufw allow from "$cidr" to any port 80,443 proto tcp
done

# 4) Siteyi dogrula. CALISIYORSA zamanlanmis geri almayi IPTAL et:
atq          # is numarasini bul
atrm <n>
```

SSH (22) **acik kalir** — kendimizi kilitlememenin birinci kurali. Ikinci
kural: DigitalOcean'in web konsolu bant disi erisimdir; SSH kaybolursa oradan
girilir.

## 7. FAZ 4 — HSTS, kademeli

Cloudflare oturduktan SONRA yapilir ve o sira tesadufi degil: kenar sertifikasi
Cloudflare tarafindan otomatik yonetilir, yani "sertifika yenilenmedi → HSTS
siteyi tuglaya cevirdi" senaryosu buyuk olcude ortadan kalkar.

| Adim | `max-age` | Bozulursa toparlanma |
|---|---|---|
| 1 | `300` | **5 dakika** |
| 2 | `86400` | 1 gun |
| 3 | `63072000` + `includeSubDomains` | — |

Her adimda: `nginx -t && systemctl reload nginx`, sonra
`curl -sI https://outofmind.fun | grep -i strict-transport`.

## 8. FAZ 5 — istege bagli sertleştirme: Cloudflare Origin CA

Origin bacagi icin Let's Encrypt yerine Cloudflare'in **Origin CA** sertifikasi
(ucretsiz, 15 yil, `outofmind.fun` + `*.outofmind.fun`) kullanilabilir. Kazanc:
**90 gunluk yenileme bagimliligi kritik yoldan tamamen cikar.**

Bedeli: Origin CA tarayicilarda GUVENILMEZ, yani origin'e DOGRUDAN gelen bir
ziyaretci sertifika hatasi alir. 6. fazdan sonra dogrudan ziyaretci
kalmadigi icin bu bir bedel degildir — ama 6. fazdan ONCE yapilmamalidir.

Bu yuzden en sona konuyor: iki degisikligi (proxy + sertifika mekanizmasi) ayni
anda yapmak, bir sey bozuldugunda hangisinin bozdugunu bilinemez kilar.

## 9. Bu is akisinin YERI

Kod akisindan BAGIMSIZ ama ondan SONRA: kod hala degisirken altyapiyi
degistirmek, bir arizanin sahibini belirsiz kilar.

1. CI yesile donsun (PR #2) — kod tarafi
2. `nearGraduation` indeksi — kod tarafi
3. **FAZ 0** (sunucu hazirligi, gorunur etkisi sifir)
4. **FAZ 1–2** (panel + proxy; geri donusu tek tiklama)
5. **FAZ 3** (guvenlik duvari; zamanlanmis geri alma ile)
6. **FAZ 4** (HSTS kademeli)
7. **FAZ 5** (Origin CA — istege bagli)


---

## 10. UYGULAMA KANITI (2026-08-17)

Her satir bir OLCUMDUR; "yapildi" yazan hicbir satir yok.

### FAZ 1–2 — panel + proxy

| Kontrol | Sonuc |
|---|---|
| Cloudflare yolda | `Server: cloudflare`, `CF-RAY … -AMS`, DNS → `172.67.165.230` |
| **Gercek IP geri yukleniyor** | log'daki IP = istemcinin gercek IPv6'si, **birebir** |
| HTML onbelleklenmiyor | `cf-cache-status: DYNAMIC` (iki istekte de), `Cache-Control: private, no-cache, no-store` korunmus |
| Rocket Loader kapali | HTML'de **0** enjeksiyon (`/cdn-cgi/scripts`, `data-cf-settings` arandi) |
| `certbot renew --dry-run` | "all simulated renewals succeeded" |

**429 fırtinasi YOK.** Log'da 32 tane 429 vardi ve hepsi **cevirmeden ONCE**,
**tek bir IP'den**: `/.env`, `/db_backup.sql`, `/.git/description`,
`secret_token.rb` arayan bir kimlik bilgisi tarayicisi. Hız limiti onu
amaclandigi gibi kesmis. O yollarin servis EDILMEDIGI ayrica dogrulandi —
dordu de **404**.

### FAZ 3 — guvenlik duvari

Uygulama sirasi, ve her adimin gerekcesi:

1. **Geri alma ONCE kuruldu.** `at` bu makinede **YOK**; `systemd-run
   --on-active=600 --unit=arcpad-fw-revert --collect` kullanildi — gecici bir
   timer, oturumdan BAGIMSIZ yasar. Betik yarida olse, baglanti kopsa ya da
   kural yanlis olsa bile 10 dakikada 80/443 kosulsuz geri acilir.
2. **22 Cloudflare kurali eklendi** (15 v4 + 7 v6), aralıklar **nginx'in kendi
   dosyasindan** turetildi.
3. **Sonra** genis `80/tcp` ve `443/tcp` kurallari kaldirildi. Bu sira kapali
   bir pencere olusmamasini garanti eder.
4. SSH (22) hic dokunulmadi.

| Dogrulama | Sonuc |
|---|---|
| Cloudflare uzerinden site | **200** |
| **Origin IP'ye DOGRUDAN** | **zaman asimi** (443 ve 80) — asil kazanc |
| SSH | calisiyor, `22/tcp ALLOW Anywhere` |
| `certbot renew --dry-run` **kisitin arkasindan** | "all simulated renewals succeeded" |

Hepsi gectikten SONRA geri alma iptal edildi. Bir tanesi gecmeseydi hicbir sey
yapilmayacakti — sistem kendini geri acardi.

### FAZ 3b — SESSIZ BIR SURUKLENME KAPATILDI

Uygulama sirasinda bulundu: gunluk `arcpad-cf-ranges.timer` **nginx'in**
listesini guncelliyordu ama **ufw'yi guncellemiyordu**. Cloudflare yeni bir
aralik ekledigi gun nginx onu ogrenir, ufw ogrenmez — ve o kenardan gelen
kullanicilar **sert bir zaman asimi** alir. Cografi, kismi, ve rastgele gorunen
bir ariza; kimse sebebini baglamaz.

`arcpad-cf-ranges` artik ufw'yi de **ayni listeden uzlastiriyor**:

* `$3` alani ayristirilir — v6 kurallari da ayni bicimde gorunur (olculdu:
  `80,443/tcp  ALLOW  2c0f:f248::/32`), yani tek ayristirma ikisini kapsar;
* **once EKLE, sonra SIL** — tersi, iki adim arasinda bir kenari kapatir;
* **FAIL-OPEN MUHAFIZI**: uzlastirmadan sonra 10'dan az kural kalirsa kapi
  ACIK birakilir ve journal'a yuksek sesle yazilir. Yanlis bir **kilit**, yanlis
  bir **aciklıktan** pahalidir — siteyi tamamen erisilemez yapar, sebebi
  gorunmez, ve kimse bakmiyorsa gunlerce surer. Yanlis aciklik ise bizi bir saat
  oncesinin haline dondurur (CDN, ama kapi acik). Secim zorunluysa **servis
  kazanir**.

Kurulmadan once mantik **kuru** denendi: mevcut durumda eklenecek/silinecek
hicbir aralik onermedi (22 = 22), yani no-op oldugu OLCULDU. Sonra gercekten
kosturuldu: cikis 0, kural sayisi 22, fail-open tetiklenmedi, `nginx -t`
gecerli. Aslin yedegi `/root/arcpad-cf-ranges.bak.<ts>`.

### HALA ACIK OLAN

**Origin IP kamuya aciktir ve DNS gecmisinde arsivlidir.** Guvenlik duvari onu
artik erisilemez kiliyor, ama IP'nin kendisi sir degil. Bir saldirgan onu
biliyor; yalnizca kullanamiyor. FAZ 5 (Origin CA) bunu bir adim ileri tasir ama
zorunlu degil.

### FAZ 4 — 1. KADEME CANLI (`max-age=300`)

nginx'te HSTS **hic yapilandirilmamisti**: tek satir, YORUM icindeki bir sablon
blogundaydi (`max-age=63072000; includeSubDomains`). Yani "eklenmis ama
calismiyor" degil, hic yoktu.

**IKI YERE eklendi, ve ikincisi bir nginx tuzagi:** `location /_next/static/`
kendi `add_header`ini (Cache-Control) tasiyor, ve nginx bir blokta `add_header`
varsa `server` seviyesindeki basliklarin tamamini **degistirir** — eklemez.
Tekrar edilmeseydi statik varlik cevaplari HSTS tasimazdi ve fark yalnizca bir
tarayici denetiminde gorunurdu. Olculdu:

| Cevap | `Strict-Transport-Security` |
|---|---|
| `/` (HTML) | `max-age=300` ✅ |
| `/_next/static/chunks/*.js` | `max-age=300` ✅ (ve `Cache-Control` korundu) |

**HTTP (80) blogua EKLENMEDI**: HSTS bir HTTP cevabinda tarayici tarafindan yok
sayilir; oraya koymak yanlis bir guven verirdi.

**MERDIVENIN KALANI, VE HER KADEMENIN SARTI:**

| `max-age` | Ne zaman | Neden |
|---|---|---|
| **300** (5 dk) | ✅ **simdi** | bir hata 5 dakikada kendini siler |
| 86400 (1 gun) | 300 sorunsuz gozlendikten sonra | ilk kademe gercek trafikte dogrulanmis olur |
| 63072000 (2 yil) | **yenileme BIR KEZ otomatik dondukten** sonra | bugun yalnizca `--dry-run` gecti; gercek bir yenileme henuz olmadi |

`includeSubDomains` ve `preload` **bilerek yok**. Birincisi her alt alan adini
HTTPS'e zorlar (gecerli sertifikasi olmayan bir alt alan adi o anda erisilemez
olur — ve "yok sandigimiz" bir tanesi tam bu sinifin arizasidir). Ikincisi
pratikte **geri alinamaz**: preload listesinden cikma talebi aylar surer ve eski
tarayicilarda hic silinmez.

Aslin yedegi: `/root/arcpad.nginx.bak.<ts>`. `nginx -t` reload'dan ONCE gecti.

---

## 11. RPC DURUSTLUK KAPISI (gunluk timer)

**Neden var.** 2026-08-18: `rpc.blockdaemon.testnet.arc.network` 36 log iceren
bir aralik icin **hatasiz bos dizi** donduruyordu. viem'in `fallback`i yedege
yalnizca birincil uc REDDEDERSE gecer -- bos bir dizi red degil, cevaptir. Ayni
36 log iki kez kayboldu ve yalanci uc **elle** bulundu.

**Ne olcer.** Defterdeki en yeni ucret olayinin blogunu her uca sorar:

| sonuc | anlami | kapi |
|---|---|---|
| `DURUST` | dogru sayiyi dondurdu | yesil |
| `TANIKLIK YOK` | hata dondurdu (budanmis, aralik/oran siniri) | yesil -- "bilmiyorum" mesrudur |
| `YALANCI` | hatasiz YANLIS sayi (ozellikle sifir) | **KIRMIZI** |

Hicbir uc cevap veremezse de kirmizi: olculmemis bir durustlugu yesil saymak
"kosmayan bir kapi rapor vermez" arizasinin ta kendisidir.

**Nerede.** `arcpad-rpc-honesty.timer` (gunluk, `RandomizedDelaySec=1800`).
Elle: `bash scripts/ops/rpc-honesty.sh`.

**Kirmizi gorulurse.** O ucu `ARC_RPC_FALLBACK_URLS`ten CIKAR ve indexer'i
yeniden baslat. Yalanci bir uc, hata veren bir uctan **kotudur**: hata failover
tetikler, yalan tetiklemez ve veri sessizce kaybolur. Cikardiktan sonra
`scripts/ops/verify-ledger.sh --self-test` ile defteri kontrol noktalariyla
dogrula; kayip varsa imleci geri al (sekiz `apply*` fonksiyonu da idempotenttir,
yani kismi yeniden tarama guvenlidir -- tam reindex GEREKMEZ).

> Imleci geri alirken blok hex'ini **elle yazma**: `printf "0x%x"` ile hesapla ve
> yazdigin hash'i bir sonraki blogun `parentHash`i ile dogrula. Elle yazilmis
> bir hex sessizce baska bir blogu isaret eder (olculdu: `0x3661000` =
> 57.020.416, 57.000.000 degil).

<!-- Dal korumasinin KILITLENMEDIGINI kanitlamak icin acilan gecici PR. -->
