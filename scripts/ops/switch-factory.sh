#!/bin/bash
# =============================================================================
#  arcpad -- CANLIYI YENI FABRIKAYA GECIR  (2026-08-17, secenek B)
# =============================================================================
#
#  NE YAPAR
#  --------
#  Canli site `0x5CA156f1...6B47` fabrikasini servis ediyordu: 98 token, ve
#  `buybackTreasury()` REVERT ediyor (o fabrika surumu buyback ozelliginden
#  ESKI, fonksiyon hic yok). Bu betik defterdeki `0x7A02759a...56A3`
#  fabrikasina gecirir -- 27 token, buyback KURULU
#  (`buybackTreasury() = 0xeC111Bc3...e9DD`, zincirden olculdu).
#
#  BEDELI, OLCULEREK: iki fabrika AYNI escrow'u paylasir, dolayisiyla
#  `start_block` da aynidir (54661437). Yeniden tarama zincir basina kadar
#  ~2.840.000 blok yurur. Site o sure boyunca BOS gorunur, sonra yeni
#  fabrikanin tokenleri dolar. Kaybedilen geri getirilemez veri YOK:
#  `chat_messages` 0 satir (ve zaten yedeklenmis), gerisi zincirden turetilir.
#
#  KOSMADAN ONCE
#  -------------
#    * `/opt/arcpad` `buyback-v2` dalinda ve temiz olmali
#    * bir yedek alinmis olmali (`systemctl start arcpad-backup.service`)
#
#  KOSMA
#  -----
#    sudo bash /opt/arcpad/scripts/ops/switch-factory.sh
#
#  GERI ALMA
#  ---------
#  Kod: `git checkout phase-1d-deploy` + 6. adimdaki build zincirini yeniden
#  kostur. Env: `/root/web.env.bak.*` ve `/root/indexer.env.bak.*`.
#  SEMA GERI ALINMAZ -- migration'lar tek yonludur. Eski kod yeni semayla
#  calisir (sutun adlari ve tipleri degismedi, yalnizca iki view sutununun
#  KAYNAGI degisti), ama bu bir "calisir" degil bir "calismasi beklenir"dir.
#
#  NEDEN `DROP SCHEMA` DEGIL
#  -------------------------
#  `arcpad_web` rolunun yetkileri ELLE verilmis (runbook `web-vps.md` §2) ve
#  hicbir migration `GRANT` icermiyor. Semayi silmek yetkileri de silerdi, site
#  izin hatasiyla olurdu, ve hicbir migration onu geri getirmezdi. Bu yuzden
#  veri tablolari BOSALTILIR, sema korunur.
#
#  `schema_migrations` ve `schema_state` de KORUNUR: birincisi migration
#  defteri (bosaltilirsa 19 migration bastan kosar), ikincisi sema parmak izi.
# =============================================================================
set -uo pipefail
cd /opt/arcpad || exit 1
say() { printf '\n=== %s ===\n' "$1"; }

set -a
# shellcheck disable=SC1091
. /etc/arcpad/db.env
set +a
: "${DATABASE_URL:?db.env icinde DATABASE_URL yok}"

say "0. ON KOSULLAR"
git log --oneline -1
test -z "$(git status --short)" || { echo "calisma agaci KIRLI, duruyorum"; exit 1; }
psql "$DATABASE_URL" -tAc "SELECT 'kayitli fabrika: '||factory FROM deployment" || exit 1
test -f /etc/arcpad/web.env     || { echo "web.env YOK, duruyorum"; exit 1; }
test -f /etc/arcpad/indexer.env || { echo "indexer.env YOK, duruyorum"; exit 1; }

say "1. MIGRATION (15 -> 19)"
# `runMigrations` hep-ya-hic: bir dosya duserse HICBIRI uygulanmaz.
pnpm --filter @arcpad/db migrate || { echo "MIGRATION DUSTU -- sema DEGISMEDI, duruyorum"; exit 1; }
psql "$DATABASE_URL" -tAc \
  "SELECT 'uygulanmis: '||count(*)||', son: '||max(filename) FROM schema_migrations"

say "2. YAZMA YOLUNU KAPAT"
systemctl stop arcpad-indexer.service arcpad-keeper-graduate.service arcpad-keeper-window.service
systemctl is-active arcpad-indexer.service >/dev/null 2>&1 && { echo "indexer DURMADI"; exit 1; }
echo "indexer ve keeper durdu"

say "3. VERI TABLOLARINI BOSALT (sema ve yetkiler KALIR)"
# Tablo listesi KATALOGDAN uretilir, elle yazilmaz: elle yazilmis bir liste yeni
# bir tablo eklendigi gun EKSIK kalir ve iki dagitimin verisi karisir -- ki
# `indexer/src/run.ts:ensureDeployment` yorumunun uyardigi sey tam olarak budur.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('%I', tablename), ', ') INTO t
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT IN ('schema_migrations', 'schema_state');
  IF t IS NULL THEN RAISE EXCEPTION 'bosaltilacak tablo bulunamadi -- duruyorum'; END IF;
  RAISE NOTICE 'bosaltiliyor: %', t;
  EXECUTE 'TRUNCATE TABLE ' || t || ' CASCADE';
END $$;
SQL
psql "$DATABASE_URL" -tAc \
  "SELECT 'launches: '||(SELECT count(*) FROM launches)||', deployment satiri: '||(SELECT count(*) FROM deployment)"

say "4. WEB ENV'INI DEFTERDEN YENIDEN URET (fabrika BURADA degisir)"
cp -a /etc/arcpad/web.env "/root/web.env.bak.$(date +%s)"
DB_LINE="$(grep '^DATABASE_URL=' /etc/arcpad/web.env)"
{ echo "$DB_LINE"
  pnpm addressbook --env-only
  echo "NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network"
} > /etc/arcpad/web.env.new
# URETILEN ENV BOSSA ESKISI KALIR: bos bir env ile build, adressiz bir site demek.
grep -q '^NEXT_PUBLIC_' /etc/arcpad/web.env.new \
  || { echo "uretilen env NEXT_PUBLIC tasimiyor -- eskisi KALIYOR"; rm -f /etc/arcpad/web.env.new; exit 1; }
mv /etc/arcpad/web.env.new /etc/arcpad/web.env
chown root:arcpad /etc/arcpad/web.env && chmod 0640 /etc/arcpad/web.env
echo "web.env yenilendi"

say "5. INDEXER ENV'INDEKI FABRIKAYI GUNCELLE"
# Indexer fabrikayi KENDI env'inden okur; web.env'i yenilemek onu etkilemez.
BOOK_FACTORY="$(pnpm addressbook --env-only | grep -iE '^[A-Z_]*FACTORY[A-Z_]*=' | head -1 | cut -d= -f2 | tr -d '"')"
case "$BOOK_FACTORY" in
  0x????????????????????????????????????????) : ;;
  *) echo "defterden gecerli bir fabrika adresi okunamadi: '$BOOK_FACTORY'"; exit 1 ;;
esac
cp -a /etc/arcpad/indexer.env "/root/indexer.env.bak.$(date +%s)"
sed -i -E "s|^(FACTORY_ADDRESS=).*|\1${BOOK_FACTORY}|" /etc/arcpad/indexer.env
grep -E '^FACTORY_ADDRESS=' /etc/arcpad/indexer.env

say "6. WEB'I YENIDEN DERLE -- \`&&\` ZINCIRI, YENI SATIR DEGIL"
# DUSEN BIR BUILD systemd'YE ULASMAMALI. Olculdu (bu makine, 2026-08-11): build
# dustu, restart yine kostu, `next start` yarim yazilmis bir `.next` bulup aninda
# cikti, ve `Restart=always` bunu DORT DAKIKADA 146 KEZ yaptı -- site hicbir sey
# dondurmedi. Aradaki tek fark iki komutun ayri satirlara yazilmasiydi.
set -a
# shellcheck disable=SC1091
. /etc/arcpad/web.env
set +a
pnpm --filter @arcpad/web release-gate \
  && chown -R arcpad:arcpad /opt/arcpad/web/.next/cache \
  && systemctl restart arcpad-web.service \
  && arcpad-stale-build \
  || { echo "BUILD YA DA RESTART DUSTU. env yedegi: /root/web.env.bak.*"; exit 1; }

say "7. SERVISLERI BASLAT (indexer yeni kimligi yazar, bastan tarar)"
systemctl start arcpad-indexer.service arcpad-keeper-graduate.service arcpad-keeper-window.service
sleep 10
journalctl -u arcpad-indexer -n 15 --no-pager | tail -10

say "8. DOGRULAMA"
psql "$DATABASE_URL" -tAc \
  "SELECT 'kayitli fabrika: '||factory||' | start_block: '||start_block FROM deployment"
curl -sS -o /dev/null -w "site: %{http_code}\n" --max-time 20 https://outofmind.fun/
echo "web restart sayisi: $(systemctl show arcpad-web -p NRestarts --value)  (artmiyor olmali)"

cat <<'DONE'

BITTI.

Indexer 54661437'den zincir basina kadar ~2.840.000 blok yuruyecek. Site o sure
boyunca BOS gorunur; bu BEKLENEN durumdur, ariza degil. Sonra yeni fabrikanin
tokenleri dolar.

Ilerlemeyi izlemek icin:
    journalctl -u arcpad-indexer -f
DONE
