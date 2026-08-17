# Cloudflare proxy'sini acmak — sirali, her adimi geri alinabilir

> Durum: **FAZ 0 UYGULANDI VE DOGRULANDI (2026-08-17).** A kaydi hala
> `DNS only`; sirada FAZ 1-2 var ve ikisi de Cloudflare panelinde, yani
> depo sahibinin elinde.
>
> Olcumler 2026-08-17'de yapildi. "Sunucuda dogrula" diye isaretli satirlar bu
> makineden okunamadi (SSH bu oturumda kapali) ve uygulamadan ONCE
> dogrulanmalidir.

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

```bash
# /usr/local/bin/arcpad-cf-ranges
#!/bin/sh
set -eu
tmp="$(mktemp)"
{ curl -fsS https://www.cloudflare.com/ips-v4
  curl -fsS https://www.cloudflare.com/ips-v6
} | awk 'NF {print "set_real_ip_from " $0 ";"}' > "$tmp"
# CEKME DUSERSE ESKI DOSYA KALIR. Bos bir dosya yazmak, butun ziyaretcilerin
# gercek IP'sini kaybetmek demekti.
test -s "$tmp"
mv "$tmp" /etc/nginx/cloudflare-ranges.conf
nginx -t && systemctl reload nginx
```

Bir `systemd` timer'i gunde bir kez kostursun (`certbot.timer` ile ayni
desen). **Sunucuda dogrula:** ilk kosudan sonra dosya dolu olmali.

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

Site el DEGMEDI (reload kosmadi). Betik `tr -s '[:space:]' '
'` ile normalize
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
