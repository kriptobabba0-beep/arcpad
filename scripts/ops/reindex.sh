#!/bin/bash
# =============================================================================
#  arcpad -- TURETILMIS VERIYI SIFIRDAN YENIDEN INDEKSLE
# =============================================================================
#
#  NE ZAMAN KOSULUR
#  ----------------
#  Indexer'in bir araligi SESSIZCE atladigi olculdugunde. Ilk olgu 2026-08-18:
#  bir uc `eth_getLogs`e bos dizi dondu, viem hata gormedigi icin yedege gecmedi,
#  indexer "olay yok" kabul edip imleci ilerletti ve 36 escrow olayi kayboldu.
#
#  ONCE DUZELTME, SONRA KURTARMA
#  -----------------------------
#  Bu betik `empty-range-guard.ts` DAGITILMADAN kosulmamalidir: duzeltme
#  olmadan yeniden tarama ayni sinifta tekrar kaybeder ve iki saat bosa gider.
#  Asagidaki kapi bunu OLCER, hatirlatmaz.
#
#  NICIN KISMI DEGIL TAM
#  ---------------------
#  Sessiz bosluk YALNIZCA ucret olaylarini dusurmez -- ayni aralikta launch,
#  islem, transfer ve buyback olaylari da vardi. Yalnizca `fee_*` tablolarini
#  tazelemek, geri kalanini ESKI ve eksik birakirdi; ve o eksiklik bir daha
#  hicbir kisiti patlatmadigi icin SESSIZ kalirdi.
#
#  VERI KAYBI YOK: `launches`/`trades`/`holders`/`fee_*` tamamen zincirden
#  turetilir. Geri getirilemez tek sey `chat_messages`tir ve BU BETIK ONA
#  DOKUNMAZ (yedek yine de alinir).
#
#  KOSMA
#  -----
#    sudo bash /opt/arcpad/scripts/ops/reindex.sh
# =============================================================================
set -uo pipefail
cd /opt/arcpad || exit 1
say() { printf '\n=== %s ===\n' "$1"; }

set -a
# shellcheck disable=SC1091
. /etc/arcpad/db.env
set +a
: "${DATABASE_URL:?db.env icinde DATABASE_URL yok}"

say "0. ON KOSUL: DUZELTME DAGITILMIS OLMALI"
# Hatirlatma degil OLCUM: dosya yoksa yeniden tarama ayni yerde kaybeder.
test -f indexer/src/empty-range-guard.ts || {
  echo "empty-range-guard.ts YOK -- once `git pull`. Duzeltmesiz yeniden tarama BOSA GIDER."
  exit 1
}
git log --oneline -1

say "0b. TANIK YAPILANDIRILMIS MI"
# Muhafiz tanik olmadan KAPALIDIR ve o halde yeniden tarama korumasizdir.
if grep -qE '^ARC_RPC_FALLBACK_URLS=.+' /etc/arcpad/indexer.env; then
  echo "tanik uc yapilandirilmis -- muhafiz AKTIF olacak"
else
  echo "UYARI: ARC_RPC_FALLBACK_URLS bos. Muhafiz KAPALI kosar, yani bu yeniden"
  echo "tarama da sessiz bir bosluga acik. Devam ediliyor, ama bilerek."
fi

say "1. YEDEK (chat -- tek geri getirilemez veri)"
systemctl start arcpad-backup.service && sleep 8
journalctl -u arcpad-backup -n 3 --no-pager | tail -2

say "2. YAZMA YOLUNU KAPAT"
systemctl stop arcpad-indexer.service arcpad-keeper-graduate.service arcpad-keeper-window.service
systemctl is-active arcpad-indexer.service >/dev/null 2>&1 && { echo "indexer DURMADI"; exit 1; }
echo "durdu"

say "3a. CHAT'I DISARI AL -- `CASCADE` LISTEDEN CIKARMAYI TANIMAZ"
# OLCULDU (ilk kosu, 2026-08-18): `chat_messages` bosaltma listesinden ACIKCA
# cikarilmisti ama log "truncate cascades to table chat_messages" dedi --
# `launches`a bagli yabanci anahtar uzerinden CASCADE ona da ulasti. O gun
# tablo bostu ve kayip olmadi; ama bir dahaki kosuda kullanicilarin yazdigi
# tek geri getirilemez veri SESSIZCE silinirdi.
#
# Bir tabloyu listeden cikarmak, onu korumaz. Korumanin tek yolu DISARI ALIP
# GERI KOYMAKTIR.
CHAT_DUMP="/root/chat-before-reindex-$(date +%s).sql"
pg_dump "$DATABASE_URL" --data-only --table=chat_messages --file="$CHAT_DUMP" || {
  echo "chat dokumu ALINAMADI -- bosaltma YAPILMIYOR"; exit 1
}
CHAT_ROWS=$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM chat_messages')
echo "chat satiri: $CHAT_ROWS -> $CHAT_DUMP"

say "3. TURETILMIS VERIYI BOSALT"
# Tablo listesi KATALOGDAN uretilir. `deployment` KORUNUR -- silinirse
# `ensureDeployment` yeni bir kimlik yazar ve `admit.ts` mevcut kimligi
# kaybeder; oysa burada fabrika DEGISMIYOR, yalnizca veri yeniden kuruluyor.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('%I', tablename), ', ') INTO t
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT IN ('schema_migrations', 'schema_state', 'deployment', 'chat_messages');
  IF t IS NULL THEN RAISE EXCEPTION 'bosaltilacak tablo bulunamadi -- duruyorum'; END IF;
  RAISE NOTICE 'bosaltiliyor: %', t;
  EXECUTE 'TRUNCATE TABLE ' || t || ' CASCADE';
END $$;
SQL
psql "$DATABASE_URL" -tAc \
  "SELECT 'launches='||(SELECT count(*) FROM launches)||' fee_events='||(SELECT count(*) FROM fee_events)||' imlec='||coalesce((SELECT last_block::text FROM sync_state WHERE id=1),'YOK')"

say "3b. CHAT'I GERI KOY"
# Dokum `--data-only`: sema zaten yerinde, yalnizca satirlar geri gelir.
if [ "${CHAT_ROWS:-0}" -gt 0 ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$CHAT_DUMP" >/dev/null || {
    echo "chat GERI YUKLENEMEDI. Dokum duruyor: $CHAT_DUMP"; exit 1
  }
fi
# SAYIYLA DOGRULA, "geri yukledim" ile degil.
BACK=$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM chat_messages')
echo "chat geri: $BACK (once $CHAT_ROWS)"
[ "$BACK" = "${CHAT_ROWS:-0}" ] || { echo "CHAT SAYISI UYUSMUYOR -- duruyorum"; exit 1; }

say "4. BASLAT"
systemctl start arcpad-indexer.service arcpad-keeper-graduate.service arcpad-keeper-window.service
sleep 10
journalctl -u arcpad-indexer -n 12 --no-pager | tail -8

say "5. MUHAFIZ AKTIF MI (baslangic uyarisi VAR MI)"
# Uyari GORUNUYORSA muhafiz KAPALI demektir -- yani bu tarama korumasiz.
if journalctl -u arcpad-indexer --since '2 min ago' --no-pager | grep -q 'BOS ARALIK DOGRULAMASI KAPALI'; then
  echo "DIKKAT: muhafiz KAPALI kosuyor (tanik yok)."
else
  echo "muhafiz aktif (kapali uyarisi yok)"
fi

cat <<'DONE'

BITTI. Tarama escrow'un blogundan (54661437) bastan yuruyecek; ~2 saat.

DOGRULAMA, VE TOPLAMLA DEGIL KONTROL NOKTALARIYLA: bir toplam, iki hatayi
birbirini goturerek gizleyebilir. Tarama ilerledikce birkaç blokta ayri ayri
karsilastir:

  cast call <escrow> "owed(address)(uint256)" <alici> --block <N> --rpc-url <rpc>
  psql "$DATABASE_URL" -tAc "SELECT sum(CASE WHEN kind='deposit' THEN amount_wei
    ELSE -amount_wei END) FROM fee_events
    WHERE recipient='<alici>' AND block_number <= <N>"

Ikisi HER kontrol noktasinda esit olmali.
DONE
