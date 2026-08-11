# Runbook: running the arcpad web app on a VPS

The keeper runbook (`keeper-vps.md`) covers the two chain-facing processes and the database. This one covers the third: the site itself. They share a box, a service account, and `/etc/arcpad`, so read §1 of that file first — it creates the account and directory this one assumes.

---

## 0. The one thing that will surprise you

**The contract addresses are compiled into the JavaScript, not read at runtime.**

Next inlines every `NEXT_PUBLIC_*` during `next build`. By the time `arcpad-web.service` starts, the factory, escrow and router addresses are already text inside the client bundle. So:

- editing `/etc/arcpad/web.env` and restarting the service **changes nothing on screen**;
- a redeployed contract needs a **rebuild**, and §3 is that procedure;
- the failure mode is silent — the site comes up, looks correct, and points at the previous deployment.

`DATABASE_URL` is the exception and is genuinely read at runtime, because the read layer opens its pool on the first query inside the server process.

There is a second surprise in §5, and it is the reason this deployment is not yet something to hand to the public.

---

## 1. Install

```bash
# The service account, /etc/arcpad and the database come from keeper-vps.md §1.

# 1. The web database user -- SEPARATE from the migrator. §2 says why.
#    (§2 also generates the password ON THE BOX. It is never transmitted.)

# 2. The unit.
install -m 0644 web/deploy/arcpad-web.service /etc/systemd/system/
systemctl daemon-reload

# 3. Build BEFORE first start -- there is no artefact until this runs.
cd /opt/arcpad
set -a; . /etc/arcpad/web.env; set +a
pnpm --filter @arcpad/web build

# 4. Start.
systemctl enable --now arcpad-web.service

# 5. The proxy (§4).
```

The unit binds `next start` to `127.0.0.1` with `-H`. That is not redundancy on top of the firewall: `next start` binds `0.0.0.0` by default, so a box whose firewall is reloaded, misconfigured, or fronted by a cloud security group would publish port 3000 with no TLS in front of it. Binding at the process makes the proxy the only way in even when the network layer is wrong.

---

## 2. The database user is not the migrator

`/etc/arcpad/db.env` carries a credential that **owns the schema**. The web process must never hold it. A single SQL injection in a read path — or one compromised dependency in a tree this size — would otherwise be able to drop `launches`.

The role the site uses is derived from the code rather than guessed. `web/app/api/chat/route.ts` is the only write path in the product, and `packages/db/src/chat.ts:251` shows it is a single `INSERT INTO chat_messages`. Everything else the site does is a read. So:

```sql
CREATE ROLE arcpad_web LOGIN PASSWORD '<generated on the box>';
ALTER ROLE arcpad_web NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL    ON DATABASE arcpad FROM arcpad_web;
GRANT CONNECT ON DATABASE arcpad TO   arcpad_web;
GRANT USAGE   ON SCHEMA public   TO   arcpad_web;
REVOKE CREATE ON SCHEMA public   FROM arcpad_web;
GRANT SELECT  ON ALL TABLES IN SCHEMA public TO arcpad_web;
GRANT INSERT  ON chat_messages TO arcpad_web;

-- A later migration's table must be readable without a human remembering to
-- grant it; a forgotten grant surfaces as "the indexer stopped writing".
ALTER DEFAULT PRIVILEGES FOR ROLE arcpad IN SCHEMA public
  GRANT SELECT ON TABLES TO arcpad_web;
```

`chat_messages.message_seq` is `GENERATED ALWAYS AS IDENTITY`. Its sequence is owned by the column and needs **no** separate `GRANT USAGE` — a grant added "just in case" here would widen the role for nothing.

### Prove it, do not assert it

Grants are the kind of thing that reads correct and is not. Attempt what the role must be unable to do, and read the error:

```bash
URL=$(grep '^DATABASE_URL=' /etc/arcpad/web.env | cut -d= -f2-)
psql "$URL" -tAc "update sync_state set last_block = 0"   # want: permission denied
psql "$URL" -tAc "drop table launches"                    # want: must be owner
psql "$URL" -tAc "select count(*) from launches"          # want: a number
```

Two traps this probe has already sprung, both in the harness rather than the grants:

- **`DROP` is refused as `must be owner of table launches`, not `permission denied`.** A checker matching only the second string reads a refusal as success.
- **A denied write and a rejected write look identical to a shell that only checks the exit code.** The `INSERT` probe must be judged on its message: `violates foreign key constraint` means the privilege was _granted_ and the schema stopped it, which is the passing result. Getting this wrong the first time produced a green report for SQL that never parsed.

Measured on 2026-08-10, 13 probes: four permitted operations allowed, nine forbidden ones refused, and zero rows written.

---

## 3. Rebuilding after a contract redeploy

```bash
cd /opt/arcpad
git pull                                    # if the code changed too

# Regenerate the env FROM THE BOOK. Do not hand-edit addresses, and do not
# filter the block down to `NEXT_PUBLIC_*` -- see the note below.
DB=$(grep '^DATABASE_URL=' /etc/arcpad/web.env)
{ echo "$DB"
  pnpm addressbook --env-only
  echo "NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network"
} > /etc/arcpad/web.env.new
mv /etc/arcpad/web.env.new /etc/arcpad/web.env
chown root:arcpad /etc/arcpad/web.env && chmod 0640 /etc/arcpad/web.env

set -a; . /etc/arcpad/web.env; set +a
pnpm --filter @arcpad/web release-gate      # §6 -- not just `build`
systemctl restart arcpad-web.service
```

`pnpm addressbook --env-only` derives the router by CREATE2 from `routerInitcodeHash` rather than copying a field, so a book that has been edited by hand produces a different address here and the mismatch is visible before it ships.

**Take the whole block. `WEB_ENV_BINDINGS` is seven variables, not four** — the four `NEXT_PUBLIC_*` the browser needs, plus `ARC_FACTORY_ADDRESS`, `ARC_ESCROW_ADDRESS` and `ARC_START_BLOCK`. The app itself never reads those three; `preflight` does, because they are what the indexer consumes and a deployment where the site and the indexer disagree about the factory is exactly the state this file exists to prevent. Writing this env with `| grep '^NEXT_PUBLIC_'` produces a site that serves correctly and a preflight that exits 2 — done on this box on 2026-08-10, and the preflight is the only reason it was noticed.

**`release-gate`, not `build`.** The gate is `format → lint → typecheck → test → build`, in that order so a formatting slip does not cost a four-minute build to discover. Two of those steps guard things a build cannot see: `lint` carries the `useBalance` seam, which is a lint rule because no runtime check can see a 1e12 error on Arc, and `typecheck` runs repository-wide because a gate scoped to one package reports green for a tree CI reports red on.

---

## 4. The proxy

`web/deploy/nginx-arcpad.conf` is the site. Two `limit_req_zone` directives must go in the `http` block instead, because nginx only accepts them there:

```nginx
# /etc/nginx/conf.d/arcpad-zones.conf
limit_req_zone $binary_remote_addr zone=arcpad_read:10m  rate=20r/s;
limit_req_zone $binary_remote_addr zone=arcpad_write:10m rate=1r/s;
```

Then:

```bash
install -m 0644 web/deploy/nginx-arcpad.conf /etc/nginx/sites-available/arcpad
ln -sf ../sites-available/arcpad /etc/nginx/sites-enabled/arcpad
rm -f /etc/nginx/sites-enabled/default          # do not skip: it shadows ours
nginx -t && systemctl reload nginx
ufw allow 80/tcp                                # and 443 once TLS exists
```

**The proxy adds no security headers, deliberately.** `next.config.ts` already sets CSP, `Referrer-Policy`, `X-Frame-Options`, `X-Content-Type-Options` and `Permissions-Policy` on every response, and `e2e/audit/network.spec.ts` proves the CSP against a real browser by asserting the exact host set the page contacts. An `add_header Content-Security-Policy` here would not replace that one — it would add a second, and a browser given two CSP headers enforces the **intersection**. The result is a policy nobody wrote, failing closed on whatever the two disagree about, while the audit suite still passes because it tests the app rather than this proxy.

The write-path rate limit is a **second** control, not a duplicate of the application's. Chat is already limited to 5 messages per 60 seconds per `(token, author)` inside the insert transaction — that is the correctness boundary and rotating IPs does not move it. The nginx limit exists because an _invalid_ post never reaches that check: the route verifies an ECDSA signature first, and signature recovery costs real CPU. Two controls, two threat models.

**`/api/ipfs/` has its own location and a much larger burst, and that is measured rather than generous.** A cold explore page draws 48 cards; 48 concurrent image requests overran `location /`'s `burst=40` and three came back 429 — three tokens with no picture, on the first page a visitor sees. Raising the ceiling is safe exactly here because these are the cheapest requests on the box: the route answers from a local file in about 8 ms and sends `immutable`, so a browser asks for a CID once and never again. What it costs us upstream is bounded by the route's own single-flight, not by this number.

---

## 4b. Where artwork lives on disk

`arcpad-web.service` carries `CacheDirectory=arcpad`, and it is **required, not an optimisation**. The unit runs with `ProtectSystem=strict`, so the filesystem is read-only; without this line `/api/ipfs/` cannot write, silently falls back to fetching from a public gateway on every single request, and the site returns to the behaviour that was measured on 2026-08-11:

```
six sequential requests for one 7 kB png, public gateway:
  200 in 3.5s   200 in 5.2s   200 in 5.6s
  404 in 12.2s  404 in 18.2s  404 in 24.0s
```

With the cache: the first request pays that once, every later one answers in **8–15 ms**, and 48 simultaneous requests make **one** upstream fetch.

```bash
systemctl show arcpad-web -p CacheDirectory --value    # must print: arcpad
ls -ld /var/cache/arcpad                               # drwxr-x--- arcpad arcpad
```

Nothing in there ever goes stale — a CID *is* its bytes — so there is no expiry to configure and no invalidation to get wrong. If it ever needs emptying:

```bash
systemctl clean --what=cache arcpad-web
```

---

## 5. TLS, and what its absence costs today — `TODO(owner) 8`

**There is no domain, so there is no certificate, so the site is served over plain HTTP.** That is a staging posture. What it costs, specifically:

- **WalletConnect refuses non-secure origins outright.** Any visitor not using an injected browser extension cannot connect at all.
- Wallets that do connect show a warning — on a page whose entire purpose is asking people to sign transactions that move money.
- Every read and every posted chat signature crosses the network in clear text. The signature is not a credential and replay is stopped by the `nonce_hex` unique constraint, so this leaks activity rather than control. It is still not something to invite the public into.

The proxy config carries the TLS block, commented, with the redirect and the certbot command. Uncomment after `certbot --nginx -d <domain>`.

**HSTS stays commented even then, on purpose.** `max-age=63072000` tells every browser that has ever visited to refuse plain HTTP for two years, and removing the header does _not_ undo it — only serving `max-age=0` for long enough that every past visitor sees it. Turn it on after the certificate has renewed automatically at least once, not on the day it is issued.

---

## 6. Verifying a deploy

```bash
systemctl is-active arcpad-web.service
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/     # 200

# The headers the app -- not the proxy -- sets:
curl -sSI http://127.0.0.1:3000/ | grep -i 'content-security-policy\|x-frame-options'

# The chain-side check. Exit 2 means "not configured", which is a DIFFERENT
# failure from "configured wrong" and the script says which.
cd /opt/arcpad && set -a && . /etc/arcpad/web.env && set +a
pnpm --filter @arcpad/web preflight
```

`preflight` is the one that matters: it reads the deployed contracts and compares them against the env the app was built with. A site pointing at a superseded factory passes every other check on this page.

---

## 7. What is not here

- **TLS and a domain** — §5, `TODO(owner) 8`.
- **A second box.** One VPS runs the site, the indexer, the keepers and the database. Every one of them stops when it stops. This is a stated limitation rather than a numbered hole: it is an architecture decision with a price tag, not a blank waiting for a value.
- **Off-box copies of the backup.** §8 dumps to this disk, which survives a dropped table and a bad migration but not a lost droplet. Shipping the file somewhere else is the next thing worth buying after the domain.

---

## 8. The backup, and the restore it is for

Everything in this database except one table is derived from logs the chain still holds: reset the cursor and the indexer rebuilds it. That costs hours — an availability problem, not a data-loss one.

**`chat_messages` is the exception and the only one.** It exists nowhere but this disk. The signature in each row proves its author wrote it, but no signature can prove a deleted message ever existed. So that table, and nothing else, is dumped nightly.

```bash
install -m 0644 packages/db/deploy/arcpad-backup.service /etc/systemd/system/
install -m 0644 packages/db/deploy/arcpad-backup.timer   /etc/systemd/system/
install -d -o arcpad -g arcpad -m 0700 /var/lib/arcpad/backups
systemctl daemon-reload && systemctl enable --now arcpad-backup.timer
systemctl start arcpad-backup.service      # take one now, do not wait for 03:17
```

`arcpad_backup` is its own role, strictly narrower than the site's: `SELECT` on `chat_messages` **and on its identity sequence**, and nothing else — not the other fourteen tables, not `INSERT` anywhere. The credential lives in `/etc/arcpad/backup.env`.

**The sequence grant is not tidiness, and this unit first shipped without it.** `pg_dump` emits `setval(...)` so a restore does not hand out a key that already exists, which means it must read `last_value` — and `INSERT` on the table does not confer that. The first run failed loudly with `permission denied for sequence chat_messages_message_seq_seq`. Had it instead skipped the sequence quietly, the restored table would have restarted its keys at 1 and collided with a surviving row at the first message after recovery — a corruption discovered by users, days later.

Two properties of the job itself, each because the alternative fails silently:

- **It writes `.part` and renames.** A job killed mid-dump otherwise leaves a truncated file with a perfectly ordinary name, indistinguishable from a good one until the day it is restored. `rename(2)` is atomic within a directory, so a name that exists is a dump that finished.
- **Retention never empties the directory.** The newest file is kept however old it is. "Delete everything past the window" is correct only while backups keep arriving; stall the timer and that rule spends a fortnight deleting the evidence, emptying the directory at exactly the moment those files became the only copy. Stale must degrade to stale, never to nothing.

### Restoring

`chat_messages` has a foreign key to `launches`, so the order is fixed: **schema first, then let the indexer rebuild the chain-derived tables, and only then restore the chat.** Restoring into an empty database fails on the foreign key — correctly.

```bash
pnpm --filter @arcpad/db migrate                      # schema
systemctl start arcpad-indexer                        # let `launches` fill
gunzip -c /var/lib/arcpad/backups/arcpad-chat-<stamp>.sql.gz \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1           # then the chat
```

Use a credential that can write — `arcpad_backup` deliberately cannot, and `arcpad_web` cannot either. This is the schema owner's job.

**Rehearsed end to end on 2026-08-10** against `arcpad_test`: two messages inserted, dumped by the real CLI, `DROP TABLE chat_messages`, restored from the gzip alone. Both rows came back with their original keys, the restore printed `setval 2`, and the next insert was assigned `3` rather than colliding. That last line is the whole point of the drill — everything before it would have looked identical with a broken sequence.

The numbers above are `keeper-vps.md` §0's, which is the registry for this whole box — one list, mechanically counted by `keeper/test/graduateInfra.test.ts`. Do not start a second list here.
