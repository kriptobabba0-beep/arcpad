#!/bin/bash
# BAYAT SUREC KAPISI -- ve NICIN VAR OLDUGU OLCULDU (2026-08-14).
#
# ARIZA SU SEKILDE GORUNDU: token sayfalari tarayicida "Something broke on our
# side." veriyordu, ama sunucu HTTP 200 ve 78 KB'lik dogru HTML donuyordu.
# Konsolda tek gercek satir suydu:
#
#     /_next/static/chunks/1jzgmehwb41a2.js -> 500
#     ChunkLoadError: Failed to load chunk ... from module 73504
#
# SEBEP: 21:22'de `.next` yeniden derlendi, ama `arcpad-web` 15:53'ten beri
# ayaktaydi. Surec BELLEGINDEKI ESKI manifest'e gore HTML uretiyordu; o
# manifest'in isaret ettigi parcalari yeni derleme SILMISTI.
#
# BUNU HICBIR SEY YAKALAMIYORDU, ve yakalanmamasinin sebebi tehlikeli:
#   * HTTP durumu 200'dur, yani ayakta-mi kontrolleri YESIL kalir.
#   * SSR govdesinde hata YOKTUR -- kirilma hydration'da olur.
#   * YALNIZCA parcalari degismis sayfalar bozulur, digerleri calisir.
#   * Ve TEMBEL yuklenen bir parcaysa, ilk yuklemede bile gorunmez.
# Yani arizadan saatler sonra, rastgele bir on-yuz hatasi gibi gorunur.
#
# Runbook zaten `release-gate && systemctl restart` diyor. Kusur o satirda
# DEGIL: BASKA bir amacla kosulan herhangi bir `pnpm build` de `.next`i
# yeniden yazar ve kosan sureci sessizce zehirler. Bu kapi o durumu gorur.
#
# NICIN BU KONTROL: sunulan HTML, diskteki BUILD_ID metnini ICERIR (olculdu).
# Yani "surec diskteki derlemeyi mi sunuyor" sorusu tek bir grep'tir ve
# Next'in ic yapisina dair hicbir varsayim gerektirmez.
set -uo pipefail

BUILD_ID_PATH=/opt/arcpad/web/.next/BUILD_ID
ORIGIN=http://127.0.0.1:3000/

echo -n 'web: calisan surec diskteki derlemeyi mi sunuyor: '

if [ ! -r "$BUILD_ID_PATH" ]; then
  echo "BILINMIYOR -- $BUILD_ID_PATH okunamiyor"
  exit 2
fi
disk=$(cat "$BUILD_ID_PATH")

html=$(curl -sf --max-time 10 "$ORIGIN" 2>/dev/null) || {
  echo 'BILINMIYOR -- web yanit vermiyor'
  exit 2
}

if printf '%s' "$html" | grep -qF "$disk"; then
  echo "evet ($disk)"
  exit 0
fi

echo "HAYIR -- BAYAT SUREC"
echo "  diskteki derleme : $disk (yazildi: $(stat -c %y "$BUILD_ID_PATH"))"
echo "  surec baslangici : $(systemctl show arcpad-web -p ActiveEnterTimestamp --value)"
echo "  sonuc            : sunucu ARTIK VAR OLMAYAN parcalara atif yapan HTML"
echo "                     uretiyor. Tarayicida ChunkLoadError, sunucuda 200."
echo "  cozum            : systemctl restart arcpad-web"
exit 1
