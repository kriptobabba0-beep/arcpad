#!/usr/bin/env bash
#
# Her RPC ucunun BOS CEVAP davranisini olcer. Ayrinti: `indexer/scripts/rpc-honesty.ts`.
#
# `verify-ledger.sh` ile ayni sarmalayici kalibi: sirlar KAYNAK ALINIR,
# GOSTERILMEZ, ve betik bagimliliklarinin yasadigi pakette durur.
#
set -euo pipefail

for f in /etc/arcpad/indexer.env /etc/arcpad/db.env; do
  [ -r "$f" ] || { echo "HATA: $f okunamiyor" >&2; exit 1; }
  set -a; . "$f"; set +a
done

cd "$(dirname "$0")/../../indexer"
exec node --import tsx scripts/rpc-honesty.ts "$@"
