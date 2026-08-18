#!/usr/bin/env bash
#
# `verify-ledger.ts` icin sarmalayici: systemd'nin indexer'a verdigi ORTAMIN
# AYNISINI kurar ve betigi calistirir.
#
# NEDEN AYRI BIR SARMALAYICI. Sirlar KAYNAK ALINIR, GOSTERILMEZ -- ve iki ayri
# dosyadan gelirler: adresler `indexer.env`de, `DATABASE_URL` `db.env`de.
# Betigin kendisi bunu bilmek zorunda kalsaydi, dagitim duzeni degistiginde
# sessizce yanlis veritabanina baglanabilirdi.
#
# KULLANIM
#   scripts/ops/verify-ledger.sh                 # varsayilan kontrol noktalari
#   scripts/ops/verify-ledger.sh --self-test     # once araci sina, sonra dogrula
#   CHECKPOINTS="56900000 57185000" scripts/ops/verify-ledger.sh
#
set -euo pipefail

for f in /etc/arcpad/indexer.env /etc/arcpad/db.env; do
  [ -r "$f" ] || { echo "HATA: $f okunamiyor" >&2; exit 1; }
  set -a; . "$f"; set +a
done

cd "$(dirname "$0")/../../indexer"
exec node --import tsx ../scripts/ops/verify-ledger.ts "$@"
