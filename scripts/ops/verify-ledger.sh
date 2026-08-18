#!/usr/bin/env bash
#
# =============================================================================
#  DEFTERI ZINCIRE KARSI DOGRULAR -- TOPLAMLA DEGIL, KONTROL NOKTASIYLA
# =============================================================================
#
# NEDEN TOPLAM YETMEZ. 2026-08-18'de bir uc `eth_getLogs` icin hata vermeden
# BOS DIZI dondu; indexer "olay yok" kabul edip imleci ilerletti ve 36 escrow
# logu sessizce kayboldu. Toplamlari karsilastirmak bunu bulamazdi: bir toplam
# kaybin NEREDE oldugunu soylemez, ve kayip yeterince kucukse yuvarlamaya
# benzer. Ayrisma ancak ARTAN bloklarda `owed()` okunarak yerellestirilebilir.
#
# `owed(recipient)` = o aliciya yapilan mevduatlar EKSI cekimler. Bizim
# karsiligimiz `fee_events` uzerinde ayni farkin `block_number <= N` ile
# kisitlanmis halidir. Ikisi her kontrol noktasinda esit olmak ZORUNDADIR.
#
# BU BETIK KENDI KENDINI SINAR. `--self-test` ile, bir alicinin SON olayindan
# bir onceki bloga kadarki toplamini zincirin GUNCEL degeriyle karsilastirir --
# yani tanim geregi AYRISMASI gereken bir sorgu. Ayrisma gormezse betik KIRMIZI
# doner. Sessizce "esit" diyen bir dogrulayici hicbir sey kanitlamaz, ve bu
# deponun en pahali arizalari tam olarak o siniftandi.
#
# KULLANIM
#   scripts/ops/verify-ledger.sh                 # varsayilan kontrol noktalari
#   scripts/ops/verify-ledger.sh --self-test     # once araci sina, sonra dogrula
#   CHECKPOINTS="56900000 57100000" scripts/ops/verify-ledger.sh
#
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/arcpad/indexer.env}"
[ -r "$ENV_FILE" ] || { echo "HATA: $ENV_FILE okunamiyor" >&2; exit 1; }
# Kaynak ALINIR, GOSTERILMEZ.
set -a; . "$ENV_FILE"; set +a

: "${ARC_ESCROW_ADDRESS:?indexer.env icinde ARC_ESCROW_ADDRESS yok}"
: "${DATABASE_URL:?indexer.env icinde DATABASE_URL yok}"
RPC="${ARC_RPC_URL:?indexer.env icinde ARC_RPC_URL yok}"

SELF_TEST=0
[ "${1:-}" = "--self-test" ] && SELF_TEST=1

q() { psql "$DATABASE_URL" -At -c "$1"; }

# Zincirdeki `owed`, belirtilen blokta. `cast` ondalik verir.
chain_owed() {  # $1=recipient $2=block
  cast call "$ARC_ESCROW_ADDRESS" "owed(address)(uint256)" "$1" \
    --block "$2" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'
}

# Defterdeki karsiligi: mevduat eksi cekim, o bloga KADAR.
ledger_owed() {  # $1=recipient $2=block
  q "SELECT COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount_wei ELSE -amount_wei END), 0)::text
       FROM fee_events
      WHERE recipient = '$1' AND block_number <= $2"
}

recipients() {
  q "SELECT DISTINCT recipient FROM fee_events ORDER BY 1"
}

# ---------------------------------------------------------------------------
#  ONCE ARACI SINA
# ---------------------------------------------------------------------------
if [ "$SELF_TEST" = "1" ]; then
  echo "=== POZITIF KONTROL: ayrismasi GEREKEN bir karsilastirma ==="
  # Ustunde en son olay bulunan alici; onun SON olayindan onceki blok.
  row="$(q "SELECT recipient, block_number FROM fee_events ORDER BY event_seq DESC LIMIT 1")"
  [ -n "$row" ] || { echo "HATA: fee_events BOS -- pozitif kontrol kosulamaz" >&2; exit 1; }
  r="${row%%|*}"; b="${row##*|}"
  before=$((b - 1))
  head_block="$(cast block-number --rpc-url "$RPC")"

  l="$(ledger_owed "$r" "$before")"
  c="$(chain_owed "$r" "$head_block")"
  echo "  alici      : $r"
  echo "  defter <= $before : $l"
  echo "  zincir @ $head_block : $c"
  if [ "$l" = "$c" ]; then
    echo "  KIRMIZI: son olaydan ONCEKI toplam, zincirin GUNCEL degerine esit cikti."
    echo "  Bu, karsilastirmanin farki GOREMEDIGI anlamina gelir -- arac bozuk."
    exit 1
  fi
  echo "  OK: arac farki goruyor. Dogrulama anlamli."
  echo
fi

# ---------------------------------------------------------------------------
#  KONTROL NOKTALARI
# ---------------------------------------------------------------------------
if [ -z "${CHECKPOINTS:-}" ]; then
  # Ilk olaydan head'e kadar esit araliklarla ALTI nokta. Sabit bir liste,
  # zincir ilerledikce anlamini yitirirdi.
  first="$(q "SELECT COALESCE(MIN(block_number), 0) FROM fee_events")"
  head_block="$(cast block-number --rpc-url "$RPC")"
  [ "$first" -gt 0 ] || { echo "HATA: fee_events bos" >&2; exit 1; }
  step=$(( (head_block - first) / 6 ))
  [ "$step" -gt 0 ] || step=1
  CHECKPOINTS="$(seq "$((first + step))" "$step" "$head_block") $head_block"
fi

fail=0
for r in $(recipients); do
  for b in $CHECKPOINTS; do
    l="$(ledger_owed "$r" "$b")"
    c="$(chain_owed "$r" "$b")"
    if [ -z "$c" ]; then
      # Bos cevap SESSIZCE GECILMEZ: `owed` okunamadiysa o nokta
      # DOGRULANMAMISTIR, ve dogrulanmamis bir noktayi yesil saymak tam olarak
      # bu betigin bulmak icin yazildigi seydir.
      echo "SORULAMADI $r @ $b -- zincir cevap vermedi"
      fail=1
      continue
    fi
    if [ "$l" != "$c" ]; then
      echo "AYRISMA   $r @ $b  defter=$l  zincir=$c"
      fail=1
    else
      echo "esit      $r @ $b  $c"
    fi
  done
done

if [ "$fail" = "1" ]; then
  echo
  echo "DEFTER ZINCIRLE UYUSMUYOR. Ayrismanin ILK gorundugu blok ile bir onceki"
  echo "esit blok arasinda ikili arama yapin; kayip o pencerededir."
  exit 1
fi
echo
echo "Butun kontrol noktalari esit."
