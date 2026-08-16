#!/usr/bin/env bash
# =============================================================================
#  TLS'I ACAR -- TEK KOMUT, BIR ALAN ADI GEREKIR
# =============================================================================
#
# NEDEN BIR BETIK. TLS bu kurulumdaki EN CIDDI acik maddedir ve sebebi
# `docs/runbooks/web-vps.md` §5'te yazili: duz HTTP uzerinde aktif bir ag
# saldirgani sayfadaki JavaScript'i degistirebilir ve cuzdana BASKA bir islem
# imzalatabilir -- hicbir sozlesme hatasi gerekmeden fon calinir. Bir
# `TODO(owner)` satiri olarak durdugu surece "yapilacak" kalir; tek komut
# olunca yapilir.
#
# HSTS ACILMAZ, VE BU BILINCLIDIR. `max-age=63072000` bu siteyi ziyaret etmis
# HER tarayiciya iki yil boyunca duz HTTP'yi reddettirir, ve basligi kaldirmak
# bunu GERI ALMAZ -- geri almanin tek yolu `max-age=0`i her eski ziyaretcinin
# gorecegi kadar uzun sunmaktir. Sertifika en az bir kez KENDILIGINDEN
# yenilendikten sonra acilir; o gun bu betik degil, bir insan karar verir.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "kullanim: $0 <alan-adi>    (ornek: $0 arcpad.xyz)" >&2
  exit 2
fi

echo "== 1. alan adi bu kutuyu mu gosteriyor =="
# ONCE BU. certbot'u yanlis DNS ile calistirmak, Let's Encrypt'in hiz
# sinirlarindan birini bosuna harcar (haftada 5 basarisiz dogrulama).
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
mine="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
if [[ -z "$resolved" ]]; then
  echo "  $DOMAIN cozulmuyor. A kaydini once ekle." >&2
  exit 1
fi
echo "  $DOMAIN -> $resolved (bu kutu: ${mine:-bilinmiyor})"
if [[ -n "$mine" && "$resolved" != "$mine" ]]; then
  echo "  A kaydi baska bir adrese gidiyor. certbot dogrulamayi gecemez." >&2
  exit 1
fi

echo "== 2. certbot =="
command -v certbot >/dev/null || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx; }

# ============================================================================
# 2b. NGINX'TE BU ALAN ADINA AIT BIR SERVER BLOGU VAR MI
# ============================================================================
#
# BU KONTROL CERTBOT'TAN ONCE GELMEK ZORUNDA, VE SEBEBI OLCULDU.
#
# `certbot --nginx` iki is yapar: sertifikayi ALIR, sonra nginx'e KURAR.
# Kurulum asamasi `server_name` ile eslesen bir blok arar; bulamazsa
# "Could not automatically find a matching server block" ile duser -- AMA
# SERTIFIKA ZATEN ALINMISTIR. Yani basarisiz kurulum, Let's Encrypt'in
# haftalik kotasindan bir sertifika HARCAR.
#
# `outofmind.fun` ilk kurulumunda tam olarak bu yasandi: depo ile gelen
# `sites-available/arcpad` `server_name _;` ile gelir (alan adi yokken
# dogru olan budur) ve certbot onu eslestiremedi.
#
# BURADA DUZELTILIR, SIKAYET EDILMEZ: tek etkin site `_` ise ona alan adi
# yazilir. Birden fazla site ya da beklenmedik bir yapilandirma varsa
# DOKUNULMAZ ve operator uyarilir -- tahmin ederek baska birinin
# yapilandirmasini bozmak, kotayi harcamaktan kotudur.
echo "== 2b. nginx server_name =="
SITE=/etc/nginx/sites-available/arcpad
if nginx -T 2>/dev/null | grep -qE "^[[:space:]]*server_name[[:space:]].*${DOMAIN}"; then
  echo "  $DOMAIN icin server blogu ZATEN var"
elif [[ -f "$SITE" ]] && grep -qE "^[[:space:]]*server_name[[:space:]]+_;" "$SITE"; then
  cp "$SITE" "${SITE}.bak.$(date +%s)"
  sed -i "s/^\( *\)server_name _;/server_name ${DOMAIN};/" "$SITE"
  echo "  server_name _ -> ${DOMAIN} (yedek: ${SITE}.bak.*)"
  nginx -t >/dev/null 2>&1 || { echo "  nginx testi dustu, geri aliniyor" >&2; cp "${SITE}.bak."* "$SITE"; exit 1; }
  systemctl reload nginx
else
  echo "  $DOMAIN icin eslesen bir server blogu YOK ve otomatik duzeltilemedi." >&2
  echo "  certbot sertifikayi ALIR ama KURAMAZ ve kota bosa gider." >&2
  echo "  Once nginx'te 'server_name ${DOMAIN};' ayarla, sonra tekrar kos." >&2
  exit 1
fi

echo "== 3. sertifika + nginx yonlendirmesi =="
# `--redirect`: 80 -> 443 kalici yonlendirme. `--agree-tos` ve `-m` olmadan
# certbot etkilesimli sorar ve bir betikte o soru bir kilitlenmedir.
certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos \
  -m "${CERTBOT_EMAIL:-admin@$DOMAIN}"

echo "== 4. otomatik yenileme =="
systemctl enable --now certbot.timer
certbot renew --dry-run

echo "== 5. dogrulama =="
nginx -t
systemctl reload nginx
code="$(curl -sS -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
echo "  https://$DOMAIN/ -> $code"
[[ "$code" == "200" ]] || { echo "  200 bekleniyordu" >&2; exit 1; }
redir="$(curl -sS -o /dev/null -w '%{http_code}' "http://$DOMAIN/")"
echo "  http -> $redir (301/308 olmali)"

cat <<'NOTE'

TLS ACIK.

SIRADAKI, VE HEMEN DEGIL:
  - `NEXT_PUBLIC_*` ve CSP'deki adresleri yeni alan adina gore gozden gecir.
  - HSTS'i SERTIFIKA EN AZ BIR KEZ KENDILIGINDEN YENILENDIKTEN SONRA ac.
    Erken acmak, bir yenileme arizasinda siteyi butun eski ziyaretcilere
    iki yil boyunca ULASILAMAZ yapar.
NOTE
