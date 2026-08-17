#!/usr/bin/env bash
#
# Install the pinning credential WITHOUT it passing through anybody's chat log,
# terminal scrollback, or shell history.
#
# WHY A SCRIPT AND NOT "edit the env file". Three ways a pasted secret leaks
# that are easy to miss, and this closes all three:
#   - `read -s` keeps it off the screen, so it is not in scrollback or a
#     screen share;
#   - it never appears as a command argument, so it is not in `~/.bash_history`
#     and not in `ps` while the script runs;
#   - the file is rewritten with `install -m 0640` rather than `>>`, so a
#     second run REPLACES the value instead of appending a second, shadowed
#     copy of the same variable.
#
# It also refuses a credential that does not work. A token typed with a
# trailing space installs cleanly, restarts cleanly, and then fails on the
# first upload a real user attempts -- which is the worst possible time to
# discover it.
#
# Usage:  ssh root@<box>  then:  bash /opt/arcpad/web/deploy/set-pinning.sh
set -euo pipefail

ENV_FILE=/etc/arcpad/web.env
ENDPOINT=${ARCPAD_PIN_ENDPOINT:-https://api.pinata.cloud/pinning/pinFileToIPFS}
AUTH_URL=https://api.pinata.cloud/data/testAuthentication

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root -- it writes ${ENV_FILE}" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "${ENV_FILE} does not exist. Deploy the site first (docs/runbooks/web-vps.md §1)." >&2
  exit 1
fi

echo "Paste the Pinata JWT. It will not be shown, and it is verified before anything is written."
echo "(Pinata dashboard -> API Keys -> New Key -> enable pinFileToIPFS -> copy the JWT, NOT the"
echo " API Key/Secret pair.)"
printf 'JWT: '
read -rs TOKEN
printf '\n'

TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
if [ -z "$TOKEN" ]; then
  echo "nothing entered; nothing written" >&2
  exit 1
fi

# VERIFY BEFORE WRITING. `testAuthentication` is a GET that costs no quota and
# pins nothing, so a bad token is refused here rather than by the first creator
# who tries to launch with artwork.
echo -n "verifying against Pinata... "
code=$(curl -sS -o /tmp/pin-auth.$$ -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" "$AUTH_URL" || echo 000)
if [ "$code" != "200" ]; then
  echo "REFUSED (HTTP ${code})"
  echo "Pinata said:" >&2
  head -c 400 "/tmp/pin-auth.$$" >&2 || true
  echo >&2
  rm -f "/tmp/pin-auth.$$"
  echo "Nothing was written. The most common causes are pasting the API Key instead of the" >&2
  echo "JWT, or a key created without the pinFileToIPFS permission." >&2
  exit 1
fi
rm -f "/tmp/pin-auth.$$"
echo "ok"

# Rewrite rather than append: a second `ARCPAD_PIN_TOKEN=` line would be read
# by systemd as the winner while the operator stares at the first one.
TMP=$(mktemp)
grep -vE '^(ARCPAD_PIN_TOKEN|ARCPAD_PIN_ENDPOINT)=' "$ENV_FILE" > "$TMP"
{
  echo "ARCPAD_PIN_ENDPOINT=${ENDPOINT}"
  echo "ARCPAD_PIN_TOKEN=${TOKEN}"
} >> "$TMP"
install -o root -g arcpad -m 0640 "$TMP" "$ENV_FILE"
rm -f "$TMP"
unset TOKEN

systemctl restart arcpad-web.service
sleep 4

# The env vars are NOT `NEXT_PUBLIC_*`, so they are read per request on the
# server -- no rebuild, only this restart. `/create` is `force-dynamic`, so the
# page below is rendered fresh and the string it prints is the real answer.
if curl -sS http://127.0.0.1:3000/create | grep -q 'Uploads are not set up'; then
  echo "STILL OFF -- the page still says uploads are not set up. Check:" >&2
  echo "  journalctl -u arcpad-web -n 30" >&2
  exit 1
fi
echo "pinning is live: the create form now takes a file from the visitor's computer."
