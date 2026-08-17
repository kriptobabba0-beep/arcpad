#!/usr/bin/env bash
# Integration harness: restart the indexer the way a production supervisor
# would, and COUNT the restarts.
#
# This exists because the shipped indexer exits 1 on Arc's `-32005 rate limit
# exceeded` after exhausting `INDEXER_MAX_ATTEMPTS` (5) worth of backoff, and
# the identical request succeeds when re-issued ~3s later. The restart count is
# the measurement; nothing here changes the indexer's own retry policy.
#
# The cursor advances inside the writing transaction, so a restart is safe:
# it re-scans at most the range that was in flight.
set -u
LOG="${1:?usage: supervise-indexer.sh <logfile>}"
restarts=0
while :; do
  cd "$(dirname "$0")/../../indexer" || exit 1
  npx tsx src/index.ts >>"$LOG" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[supervisor] indexer exited 0 after $restarts restart(s)" >>"$LOG"
    break
  fi
  restarts=$((restarts + 1))
  echo "[supervisor] restart #$restarts (exit $code)" >>"$LOG"
  sleep 5
done
