# Runbook: running the keeper on a VPS

**The keeper is built and tested. It runs nowhere.** This is how it gets a home, and how the home stays occupied.

Two processes, one forwarder per process, one file each, and one thing outside the box that notices when the files stop growing.

| Unit                                    | What it is                                                                                                  | Key?    | Reads        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------- | ------------ |
| `arcpad-keeper-window.service`          | the graduation-window watcher — the control [`graduation-window.md`](graduation-window.md) is written about | no      | address book |
| `arcpad-keeper-graduate.service`        | the graduation executor — the **only** thing that routinely calls `ArcpadLocker.graduate(curve)`            | **yes** | address book |
| `arcpad-keeper-notify@window.service`   | reads `alerts.log`, pages, checks in                                                                        | no      | the log      |
| `arcpad-keeper-notify@graduate.service` | reads `graduate.log`, pages, checks in                                                                      | no      | the log      |

Artifacts are in [`keeper/deploy/`](../../keeper/deploy). Every one of them carries its reasoning inline; this document carries the reasoning that spans them.

---

## 0. The `TODO(owner)` holes — there are **nine**

They are left as visible blanks rather than plausible defaults, for the reason `graduation-window.md` §7 already gives: a blank gets filled and a wrong value gets trusted at 3 am.

**This is the registry for the whole box, not just the keeper.** The site runs on the same VPS, from the same `/etc/arcpad`, under the same service account, so its holes are numbered here too (`8`, `9`) rather than in a second list nobody would think to check. `web-vps.md` describes them; this table is where you count them.

| Marker          | Hole                                                                                  | Where the marker is                                        | Blocks                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `TODO(owner) 1` | The keeper's signing key — generate, encrypt, fund                                    | `arcpad-keeper-graduate.service`                           | the executor broadcasting anything                                                     |
| `TODO(owner) 2` | `MemoryMax=` after a week of real data                                                | both keeper units                                          | nothing today; an unbounded process later                                              |
| `TODO(owner) 3` | `KEEPER_NOTIFY_PAGE_URL` — the page webhook                                           | `notify-window.env.example`, `notify-graduate.env.example` | every `PAGE` reaching a human                                                          |
| `TODO(owner) 4` | `KEEPER_NOTIFY_HEARTBEAT_URL` for **window**                                          | `notify-window.env.example`                                | the watcher's dead-man's switch                                                        |
| `TODO(owner) 5` | `KEEPER_NOTIFY_HEARTBEAT_URL` for **graduate**                                        | `notify-graduate.env.example`                              | the executor's dead-man's switch                                                       |
| `TODO(owner) 6` | `KEEPER_ALERT_LOG_URL` — publish the sink for CI                                      | §7 of this file                                            | the weekly drill                                                                       |
| `TODO(owner) 7` | A **second RPC endpoint** so the keepers stop sharing the indexer's rate-limit bucket | §1 of this file                                            | nothing today; a 4.2× measured backfill penalty, and both falling behind on a busy day |
| `TODO(owner) 8` | A **domain and a TLS certificate** for the site                                       | `web-vps.md` §5                                            | WalletConnect entirely, and any honest invitation to the public                        |
| `TODO(owner) 9` | `pg_dump` for `chat_messages`                                                         | `web-vps.md` §7                                            | nothing today; it is the one table no chain can rebuild                                |

**Nine values, twenty-five sites** — several holes are marked in more than one place because one value is needed in more than one file (marker `2` in all three units, marker `3` in both forwarder env files), and each is named again in the table above. **Count the values, not the markers**, and check both numbers mechanically:

```bash
SCAN='keeper/deploy web/deploy docs/runbooks/keeper-vps.md docs/runbooks/web-vps.md'
grep -rho 'TODO(owner) [0-9]' $SCAN | sort -u | wc -l   # -> 9
grep -rho 'TODO(owner) [0-9]' $SCAN | wc -l             # -> 25
```

The site count drifted once already, and the way it drifted is the lesson: `arcpad-indexer.service` was added carrying its own copy of marker `2`, which moved the total without anyone touching this line. **A number in prose does not fail a build** — so this one now does: `graduateInfra.test.ts` recomputes both counts from the files and asserts the heading, this sentence, and the two `# -> N` expectations all agree with them.

That test also fixes the _next_ reader's problem rather than this one's: write the marker's literal name in a paragraph and you have created another site, which is how the sentence you are reading first came out wrong by one.

That distinction is why this section leads with a number: `graduation-window.md` §7 said "three" while carrying four, and it was wrong for several rounds before anyone counted.

**#6 is not a new hole.** It is `graduation-window.md` §7's _Drill transport_, restated here because the VPS is the first place it can actually be filled. Filling it once fills both. The other three holes in that table — On-call, Escalation, Paging provider — are unchanged by this work, except that **Paging provider is no longer waiting on any code**: the two rules it names are implemented (`keeper/src/notify.ts`) and all that remains is choosing a provider and pasting two URLs, which are #3–#5 here.

**#1 and #3–#5 are release gates.** A keeper with no key graduates nothing; a keeper with no forwarder is a heartbeat nobody counts, which the runbook it serves already calls decoration.

---

## 1. Install

Assumes `/opt/arcpad` is a checkout of this repo and `node`, `pnpm` and the workspace's `node_modules` are present. Paths in the units are conventions, not requirements — change them in one place and they stay consistent.

```bash
# 1. A service account that owns nothing else.
useradd --system --home-dir /var/lib/arcpad --create-home --shell /usr/sbin/nologin arcpad
install -d -o arcpad -g arcpad -m 0750 /var/lib/arcpad
install -d -o root  -g arcpad -m 0750 /etc/arcpad

# 2. Environment. Fill the TODO(owner) blanks BEFORE enabling anything.
install -o root -g arcpad -m 0640 keeper/deploy/keeper-window.env.example    /etc/arcpad/keeper-window.env
install -o root -g arcpad -m 0640 keeper/deploy/keeper-graduate.env.example  /etc/arcpad/keeper-graduate.env
install -o root -g arcpad -m 0640 keeper/deploy/notify-window.env.example    /etc/arcpad/notify-window.env
install -o root -g arcpad -m 0640 keeper/deploy/notify-graduate.env.example  /etc/arcpad/notify-graduate.env

# 3. Units.
install -m 0644 keeper/deploy/arcpad-keeper-window.service    /etc/systemd/system/
install -m 0644 keeper/deploy/arcpad-keeper-graduate.service  /etc/systemd/system/
install -m 0644 'keeper/deploy/arcpad-keeper-notify@.service' /etc/systemd/system/
install -m 0644 keeper/deploy/logrotate-arcpad-keeper         /etc/logrotate.d/arcpad-keeper
systemctl daemon-reload

# 4. THE WATCHER AND THE FORWARDERS FIRST. The watcher needs no key, and
#    bringing the alarm path up before the thing that signs means the first
#    broadcast is already observed.
systemctl enable --now arcpad-keeper-window.service
systemctl enable --now arcpad-keeper-notify@window.service

# 5. Prove the pipe end to end BEFORE the executor exists (section 6).

# 6. Then the key (section 3), then the executor.
systemctl enable --now arcpad-keeper-graduate.service
systemctl enable --now arcpad-keeper-notify@graduate.service
```

### Before you enable the executor, run it by hand once

```bash
sudo -u arcpad env $(grep -v '^#' /etc/arcpad/keeper-graduate.env | grep -v DRY_RUN | xargs) \
  KEEPER_DRY_RUN=true KEEPER_GRADUATE_CURSOR_FILE=/tmp/probe-cursor \
  node --import tsx src/graduate.ts --once --book-only
```

**Note the separate cursor file, and see §4 — it is not optional.** A read-only pass against the production book prints the backlog and exits 0 today, because `graduationTarget` is `0x0`. Measured on 2026-08-09 from a cold cursor: `armed=false known=2 caughtUp=true pending=1 pendingRaise=12.16USDC broadcast=0`, zero pages.

### On a cold box the indexer goes FIRST, and alone

The three processes on this box — indexer, window watcher, graduation executor — share **one** rate-limit bucket, because they share one RPC endpoint. Arc's limiter is per-endpoint, not per-client, so they do not queue politely behind each other: they starve each other, and the one that loses is the one that actually needs throughput.

Measured here on 2026-08-10, same box, same endpoint, back to back:

|                        | blocks per 180s | ETA for a 1.49M-block backfill |
| ---------------------- | --------------- | ------------------------------ |
| indexer + both keepers | 5,000           | **14 hours**                   |
| indexer alone          | 21,000          | **3 hours**                    |

A **4.2×** penalty, and it is paid entirely by the cold start. So the install order in §1 gains a condition: on a box whose indexer is more than a few thousand blocks behind, **stop the keepers until the backfill lands**.

```bash
systemctl stop arcpad-keeper-window arcpad-keeper-graduate    # still `enabled`
# watch it drain:
watch -n60 "sudo -u postgres psql -d arcpad -tAc \
  'select head_block - last_block from sync_state where id=1'"
systemctl start arcpad-keeper-window arcpad-keeper-graduate   # when it is small
```

Three things make this safe rather than a shortcut:

- **`stop` is not `disable`.** The units stay enabled, so a reboot mid-backfill brings the keepers back on its own — the operator cannot forget them into a permanently unwatched box.
- **The keepers lose nothing by waiting.** Both keep file cursors that survive the stop, and neither can act today regardless: `graduationTarget` is `0x0`, so every `graduate()` reverts `GraduationTargetUnset()`.
- **It is a cold-start rule, not a steady-state one.** Once caught up the indexer follows the head and its RPC appetite collapses to a poll; the contention that justifies this disappears with the backfill that caused it.

**The durable fix is a second endpoint, and it costs money.** Splitting the keepers onto their own RPC provider removes the shared bucket entirely and is the right answer before any announcement — a platform whose indexer cannot catch up while its keeper is watching is one busy day away from both being late. Until that is bought, this ordering is the control. TODO(owner) 7.

---

## 2. Supervision — what happens when it dies

**systemd, not Docker.** There is no Dockerfile in this repo and no container build in CI; introducing one to run two Node processes adds an image pipeline, a registry and a second place for the address book to go stale, and buys isolation that `ProtectSystem=strict` + a service account already give. The one thing a container would genuinely add — a pinned runtime — is better solved by pinning `node` on the box, because the address book must come from **the checkout**, and a container that bakes it in acquires exactly the "hand-set at build time" weakness §5 exists to prevent.

| Event                      | What systemd does                                      | What the keeper does                                                                                                                                 |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Crash / uncaught throw** | `Restart=always`, `RestartSec=15`                      | the cursor is persisted **per chunk**, atomically (write-and-rename), so the walk resumes; the quarantine store and locks survive on disk            |
| **OOM-kill**               | the kernel kills it, `Restart=always` brings it back   | same as crash. **No memory figure has been measured on a VPS** — `MemoryAccounting=yes` is on and `MemoryMax=` is deliberately unset (TODO(owner) 2) |
| **Reboot**                 | `WantedBy=multi-user.target` starts all four           | a cold cursor is walked at 1 chunk/pass and says `state=catching-up` every pass while it does                                                        |
| **Crash loop**             | `StartLimitIntervalSec=0` — systemd **never gives up** | no heartbeats are emitted → the dead-man's switch pages within its grace period                                                                      |

The last row is the deliberate one. systemd's default rate limiter parks a unit in `failed` after five restarts and stops trying, which produces a permanently dead keeper that nothing restarts and nothing announces. Disabling it converts that into a crash loop, and a crash loop is _loud_ — it writes no `HEARTBEAT`, and the whole of §6 exists to turn that silence into a page.

### The restart / lock interaction, stated precisely

**The brief's phrasing — "the keeper refuses to run twice on one cursor" — is not what the code does, and the difference matters here.** What exists is:

- a **per-curve** advisory lock (`keeper/src/graduate/lock.ts`): `O_EXCL` file create, 5-minute TTL, stale locks stolen loudly;
- **no cursor lock, and no process-level singleton at all.**

So on a hard kill (`SIGKILL`, OOM) mid-graduation, the lock file survives its owner. The restarted executor sees its own orphaned lock and **leaves that curve alone until `expiresAt`**, then steals it and says so. The delay is bounded by `DEFAULT_LOCK_TTL_MS` = 5 minutes and applies to at most `KEEPER_GRADUATE_MAX_PER_PASS` = 4 curves. That is a delay, not a loss — `graduate()` is permissionless, so nothing is stuck-forever by construction.

**The dangerous concurrency is not the lock; it is the cursor.** `keeper/src/graduate/config.ts` states that two processes writing one cursor each roll back the other's progress. Nothing in the keeper prevents that. **The singleton comes from systemd** — one instance per unit name — and from nowhere else. Therefore:

> **Never run `graduate` by hand while `arcpad-keeper-graduate.service` is active** unless you pass a different `KEEPER_GRADUATE_CURSOR_FILE`. Either `systemctl stop` it first, or redirect the cursor. §4 has the case that bit us.

`TimeoutStopSec=90` exists for the same reason: `SIGTERM` makes the loop finish the pass in hand and then exit (`keeper/src/graduate/loop.ts`), so a stop cannot orphan a broadcast transaction whose receipt nobody read.

### The defect this deployment work found

**Loop mode did not loop.** Measured 2026-08-09 against the production book:

```
[2s]  graduator ready ... mode=loop@15000ms
[3s]  HEARTBEAT keeper.graduate ... state=catching-up ...
EXITED after 13s          (exit code 0)
```

`main()` resolved after the first pass — the loop rescheduled itself with `setTimeout` and did not hold `main` — and `settle()` then scheduled `exit(code)` 10 seconds later. `unref()` stops a timer keeping the process alive; it does **not** stop it firing. So the executor killed itself while waiting for its second pass, with one heartbeat, zero pages and a clean exit code.

**A `Restart=always` unit would have hidden this completely**: the process reappears every ~25 seconds, the cursor advances, `systemctl status` says `active (running)`, and the heartbeat stream never stops. It was only findable by running the thing and watching a clock — which is why standing a service up is not a packaging exercise.

Fixed in `keeper/src/graduate/loop.ts` (`runPollLoop` resolves only after a stop, with the timing assertion unit-tested against an injected scheduler). Re-measured after the fix: **5 heartbeats in 75 s at ~15.4 s spacing, killed only by the external timeout.**

---

## 3. The key

### What a stolen keeper key can do — measured, not assumed

**Answer: spend the gas float on that key, and nothing else. It confers no authority that a stranger does not already have.**

The evidence, in the order it should be checked:

1. **`ArcpadLocker.graduate(address)` never reads its caller.** `msg.sender` occurs three times in `contracts/src/ArcpadLocker.sol` — twice in a NatSpec comment and once executably, at line 177, inside `unlockCallback` (`if (msg.sender != address(poolManager)) revert NotPoolManager()`). `graduate` contains no caller term, no modifier, no owner, no role. The contract has no `Ownable`, no `AccessControl`.
2. **The payout does not follow the caller.** `BondingCurve.graduate()` resolves `address target = ILaunchFactory(factory).graduationTarget()` and then pays **`target`**: `emit Graduated(token, target, …)`, `IERC20(token).transfer(target, baseAmount)`, `target.call{value: quoteAmount}("")`. `msg.sender` appears once, in the check `if (msg.sender != target) revert NotGraduationTarget()` — and the sender there is the _locker_, a contract. The EOA that pays for the transaction never enters the money path. A thief who calls `graduate()` pays gas and hands the raise to the locker.
3. **Live, read-only, 2026-08-09 against `https://rpc.testnet.arc.network` at head 56114118** — `locker.graduate(0xDdB9e739…f27b)` from four different `from` addresses:

   | `from`                                 | result       |
   | -------------------------------------- | ------------ |
   | _(none)_                               | `0xfe30fa5b` |
   | `0xe92c64C4…92fD2` (deployer)          | `0xfe30fa5b` |
   | `0x000000…DeaDBeef` (a stranger)       | `0xfe30fa5b` |
   | `0x97053469…D2C22` (the governor Safe) | `0xfe30fa5b` |

   Identical. **Read this one honestly**: production's `graduationTarget` is `0x0`, so all four fail at `GraduationTargetUnset()` inside the curve — the check order means this measurement shows the _entry point_ does not discriminate, not that a _successful_ graduation would. The claim that a successful one is equally indifferent rests on (1) and (2), and on `contracts/test/fork/GraduationCycle.live.fork.t.sol`, which calls `locker.graduate(curve)` from the plain test contract — no `vm.prank` to any privileged identity — and measures the full cycle 8/8 against the live `PoolManager`, `FeeEscrow`, `FeeSchedule` and USDC.

4. **The key holds no governance.** `factory.governor()` reads `0x9705…D2C22`, the 2-of-3 Safe, whose owners (`contracts/deploy/expected-governance.json`) are three addresses that are **not** the deployer and must not be the keeper. `proposeGraduationTarget` and `setProtocolTreasury` are governor-only; the keeper key cannot reach either.
5. **Fees cannot be redirected.** `FeeEscrow.claim(address recipient)` is permissionless and pays **`recipient`**, not `msg.sender`. A stolen key cannot sweep anyone's accrued fees — it can only push someone else's balance to them, at its own expense.

**So the loss ceiling is the balance on the key.** Two honest riders:

- `applyGraduationTarget()` is permissionless too, so a funded stolen key is a _funded_ attacker — but it gains no capability, only a few USDC of ammunition it took from us.
- **Stealing the key almost certainly means owning the box, and that is strictly worse than the key.** A box owner can stop the keeper (a delay, not a loss — the permissionless fallback survives) and can **forge the alert log**, which `graduation-window.md` §8 already records as an accepted limit: the sink is an ordinary append-only file with no signature, and the drill reads it over plain `curl`. Do not let "the key is worthless" become "the box is unimportant."

### How the key is held

**A dedicated key, generated on the box, used for nothing else.** Specifically **not** the deployer key in `.env.deployer`: that address holds 74.548092095 USDC and 0.000148148 USDC of escrow credit as of 2026-08-09, and it is the operational deploy identity. Reusing it would convert a keeper-box compromise into a deploy-key compromise for no benefit — the keeper needs no authority the deployer has. And **not** a governor-Safe owner key, for the obvious reason.

The unit uses systemd's encrypted credentials, so the key is never in any environment — not in an `EnvironmentFile`, not in `systemctl show`, not in `/proc/PID/environ`, not in shell history:

```bash
umask 077
printf '0x<the dedicated keeper key>' > /run/keeper.key
systemd-creds encrypt --name=graduate-key /run/keeper.key /etc/arcpad/graduate-key.cred
shred -u /run/keeper.key
```

The unit then passes `KEEPER_GRADUATE_PRIVATE_KEY_FILE=%d/graduate-key`. That variable is new (`keeper/src/graduate/config.ts`): it reads the file, trims trailing whitespace, validates the same 32-byte hex shape, refuses if `KEEPER_GRADUATE_PRIVATE_KEY` is _also_ set — "which one won" is an answer about **which address signs**, and picking silently would leave no trace of it — and **never prints the contents**, only the source, because an error line goes to journald and from there to every collector.

If this host's systemd predates 250, fall back to a `0400` file owned by `arcpad` and point the same variable at it.

### How it is funded, and refilled

**On Arc the gas asset is USDC**, so "funded" and "holds USDC" are the same statement, and a signer holding `0` is refused at start-up (`keeper/src/graduate.ts`) rather than discovered on the first graduation.

**The per-graduation gas cost of the real locker is NOT MEASURED, and no number should be invented for it.** What exists is not it: the local-chain proof's real broadcast used **81,231 gas**, but that was against a 36-byte hand-assembled stand-in locker on a fork, because Arc's `0x1800` native-asset precompile cannot run there — the real locker opens a Uniswap V4 pool and seeds a position, which is a different order of work. The live fork test exercises the real locker but does not record gas.

So the refill policy is a **procedure, not a threshold**:

1. Fund the key from the faucet (10 USDC per request) — enough to be non-zero and to cover the first few transactions.
2. When the first real graduation lands, read `gasUsed` from the `OK … graduation-landed` line the executor prints (it re-reads `graduated()` on chain at the receipt's block, so the line is not taken on trust).
3. Set the alert threshold at **20× that measured cost**, and record the measurement _in this file_ with its date and transaction hash.
4. Until step 2 exists, watch the balance by hand at each on-call handover.

Two facts the on-call should carry: a graduation **buy-out** costs 12.16 USDC (that is the trade that completes a curve, not the keeper's gas), and running out mid-run is not silent — the send path pages on the **second consecutive** failure carrying viem's own "insufficient funds" text.

---

## 4. Config — the addresses are not yours to type

The keeper reads `contracts/deploy/addresses.<chainId>.json` and derives everything from it. The indexer is the one layer that takes `ARC_FACTORY_ADDRESS` from the environment, and `scripts/integration/env-from-book.ts` exists to keep even that tied to the book. **The keeper must not acquire that weakness through its deployment**, which is what the `--book-only` flag on `ExecStart` is for: it refuses to start if `KEEPER_GRADUATE_FACTORY`, `KEEPER_GRADUATE_LOCKER` or `KEEPER_GRADUATE_START_BLOCK` is present in the environment at all.

**The gate is a command-line flag and not an environment variable, deliberately.** The service's only configuration source is its `EnvironmentFile`; a gate living there could be switched off by the same file that carries the addresses it guards — a lock that opens itself. Changing `ExecStart` means editing a unit, which is a separate, privileged, reviewable act.

`KEEPER_GRADUATE_START_BLOCK` is in the list on its own merits. Alone it does not redirect the factory — it moves where the `Launched` scan begins, and a start block past the first launch means those curves are never seen. `.env.example` records the measured sibling of that bug: a hand-written start block produced a keeper that paged every poll and emitted no heartbeats, ~35,000 pages a day at the 5s default.

`src=book` now appears in every executor heartbeat and every pass summary. Without it, a correctly configured executor and one redirected at another stack write the _same_ healthy line — `target=0x0 armed=false pending=1` is true for both — so "we are watching the wrong stack" was invisible in the only stream the pager sees.

### The one-off window procedure needs its own cursor file — and this bit us

`keeper-graduation-report.md` §6 gives the command for the apply window, pointing the executor at the **disposable** factory via `KEEPER_GRADUATE_FACTORY`/`_LOCKER`/`_START_BLOCK`. That command does **not** override the cursor, so it writes the disposable stack's identity into the same default `.cursor-graduate` the production executor uses. Running it while the service is up produces a reset ping-pong: each process finds the other's identity, resets loudly, and re-walks ~245,000 blocks against Arc's shared rate limit.

Observed here on 2026-08-09 while verifying the `--book-only` control: a single dry-run against the disposable factory left `.cursor-graduate` holding `factory: 0xfE11Db90…4849, lastScannedBlock: 56096842`. The file was removed rather than left to confuse the next reader.

**So the window procedure gains one line** (and correctly does _not_ pass `--book-only`, which is the flag's whole point — it is the service's gate, not a ban on deliberate one-off runs):

```bash
KEEPER_GRADUATE_CURSOR_FILE=/tmp/disposable-cursor \
KEEPER_GRADUATE_FACTORY=0xfE11Db901168B0B0f7474b72a2e39b3d805b4849 \
KEEPER_GRADUATE_LOCKER=0x1AfD2eF32C445FAdC95f05Ed237ed4C9dAE9d33F \
KEEPER_GRADUATE_START_BLOCK=56016843 \
  node --import tsx src/graduate.ts --once
```

---

## 5. Who reads the lines

Nobody, until this is wired. That is the honest starting state, and `graduation-window.md` §7 says why it cannot stay: **a heartbeat nobody counts is decoration.**

`arcpad-keeper-notify@.service` (`keeper/src/notify.ts`) closes the loop. It follows one alert log and implements exactly the two rules §7 names:

1. every record whose first line starts with `PAGE ` is POSTed to `KEEPER_NOTIFY_PAGE_URL` as `{label, kind, at, text}`;
2. every `HEARTBEAT ` record checks in to `KEEPER_NOTIFY_HEARTBEAT_URL`, coalesced to at most one check-in a minute. **The switch's grace period is the control** — set it to 10 minutes.

It refuses to start with only one of the two URLs. Half of this control is worse than none, because half gets recorded as built.

Five properties worth knowing at 3 am:

- **Nothing watches the forwarder, and nothing needs to.** It is _inside_ the monitored path: forwarder dead, box dead, or network dead all stop the check-ins, and the switch fires. The "who watches the watcher" chain ends here.
- **An undeliverable page suspends the heartbeat.** If the page endpoint is down, queued pages block check-ins, so a broken alarm path becomes a dead-man's-switch trip instead of a green stream. Verified live against a local endpoint returning 502: `pagesSent=0 queued=1 pinged=0`.
- **One switch per component.** `alert.ts` split `keeper.graduationWindow` from `keeper.graduate` so neither could pass the other's liveness gate; pointing both at one switch would undo that at the transport layer, with the executor's check-ins concealing a dead watcher.
- **Match the prefix, not the state.** A watcher mid-backfill writes `state=catching-up` and is alive. The forwarder counts both states — a rule that counted only `state=current` would declare every cold start dead.
- **A record is a header line plus its continuation lines.** A single `PAGE` in the live logs is up to seven lines, because viem's error text carries its own newlines. `drill.ts` drops those continuations and is right to; a forwarder that did would send the on-call a page with its body missing.

`OK ` lines are not forwarded. They stay in the file and in journald.

**What remains yours:** pick a provider (any that accepts an HTTP POST), create one page webhook and two switches, paste three URLs — TODO(owner) 3, 4, 5.

---

## 6. Prove the pipe before you trust it

A monitor that has never fired is a monitor nobody knows is broken.

```bash
# 1. With the watcher and its forwarder running, append a synthetic page.
#    It must be a REAL append to the real sink -- the point is the pipe.
sudo -u arcpad sh -c 'printf "PAGE keeper.graduationWindow at=%s pipe-test: this is a drill\n" \
  "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >> /var/lib/arcpad/alerts.log'

# 2. Within KEEPER_NOTIFY_INTERVAL_MS (default 5s) the on-call's phone rings.
#    If it does not, the forwarder said why:
journalctl -u arcpad-keeper-notify@window -n 20

# 3. Then prove rule 2, which is the one that matters. Stop the watcher and
#    leave it stopped past the switch's grace period.
systemctl stop arcpad-keeper-window
#    ...the switch must page within 10 minutes. Then:
systemctl start arcpad-keeper-window
```

Step 3 is the only executable proof that the dead-man's switch exists. Run it once at install and record the date here. **Not yet run** — this document is written before any box exists.

The full governance drill (`graduation-window.md` §8) is separate and still needs §0's hole #6.

---

## 7. Publishing the sink for the CI drill — TODO(owner) 6

`.github/workflows/graduation-drill.yml` fetches `$KEEPER_ALERT_LOG_URL` and fails by name while it is unset. The VPS is where it becomes fillable. The minimum is a read-only HTTPS location serving `/var/lib/arcpad/alerts.log` at an unguessable path, plus the repository variable.

Two things not to get wrong:

- **Serve only the watcher's `alerts.log`.** The drill's liveness gate parses `^(PAGE|OK|HEARTBEAT) keeper\.graduationWindow at=`; the executor's lines cannot satisfy it, and that separation is load-bearing — publishing a merged file would be the vacuous-gate failure the component split exists to prevent.
- **This is a delivery gate, not tamper-evidence,** and `graduation-window.md` §8 already says so. Anyone who can write that file, or stand between it and CI, can make the drill pass. Accepted, and worth re-reading before treating a green drill as proof of anything but a working pipe.

---

## 8. Upgrades, and rolling back

**A graduation cannot be missed by an upgrade, and the reason is structural rather than procedural.** The executor discovers work from the `complete()` / `graduated()` **slots**, not from the `Completed` **event** — `Completed` is not subscribed to at all. `complete` latches true and never reverts, so a curve that completes during a restart is found by the first pass afterwards. There is no window to miss. An event-driven design would have the opposite property, which is exactly why this one is not.

And underneath that: `graduate()` is permissionless. Keeper downtime is a delay, not a loss, because the fallback is a property of the contract rather than of a process.

So the procedure is short, and its only real requirement is _order_.

```bash
# 1. Test the new code where it is safe to be wrong.
pnpm --filter @arcpad/keeper test        # 291 expected
pnpm --filter @arcpad/keeper typecheck

# 2. Pin what you are leaving. This is the rollback.
git -C /opt/arcpad rev-parse HEAD > /var/lib/arcpad/deployed-sha

# 3. Stop the SIGNER first, and only the signer.
systemctl stop arcpad-keeper-graduate
#    The watcher and both forwarders keep running: an upgrade is exactly when
#    you want the window watched and the alarm path alive.

# 4. Update the checkout and its dependencies.
git -C /opt/arcpad fetch && git -C /opt/arcpad checkout <sha>
pnpm --dir /opt/arcpad install --frozen-lockfile

# 5. Dry-run the new build against the live chain, on a scratch cursor.
sudo -u arcpad env $(grep -v '^#' /etc/arcpad/keeper-graduate.env | grep -v DRY_RUN | xargs) \
  KEEPER_DRY_RUN=true KEEPER_GRADUATE_CURSOR_FILE=/tmp/upgrade-probe \
  node --import tsx src/graduate.ts --once --book-only

# 6. Back up.
systemctl start arcpad-keeper-graduate
systemctl restart arcpad-keeper-window arcpad-keeper-notify@window arcpad-keeper-notify@graduate
```

**Rollback is step 4 with the old SHA, then step 6.** Nothing else is needed, and that is a property of what the keeper keeps on disk rather than an assurance:

- the **cursor** is a cache, not a record. It carries `chainId`, `factory` and `startBlock`; a version that changed any of them makes the cursor self-reset with one `OK … cursor-reset:` line and re-walks. Nothing is lost.
- the **quarantine store** is keyed the same way and resets the same way, and quarantine has a 24h lifetime by design, so a lost entry costs one retry.
- **no schema migration exists to run backwards**, because there is no database. `/var/lib/arcpad` is three files and a lock directory.

Two rules that are not optional:

1. **Never run two versions at once.** There is no cursor lock (§2). If you want to stage a new build against the live chain, give it its own `KEEPER_GRADUATE_CURSOR_FILE` — as step 5 does.
2. **Upgrade the forwarders last, and never in the same breath as the thing they watch.** They are the only reason you will find out that the upgrade broke something.

**After a factory redeploy, re-read `graduation-window.md` §9 before anything else.** The keeper follows a new factory with no code change, but `packages/shared`'s `FACTORY_SALT` can stop the book naming it, and that gate is outside this package entirely.

---

## 9. What is still not wired

- **A Graduate button in the web app.** `keeper-graduation-report.md` §2: the permissionless fallback only exists if a human can reach it, and today a completed curve renders no action at all. Not this package.
- **Backlog ageing.** The executor reports pending count and raise every pass but does not page when a curve stays pending _while armed_ for longer than N. The threshold depends on the poll interval and on whether a human is expected to intervene; inventing one here would be the unstated precondition this repo keeps finding. Repeated failure to land already pages.
- **The limit-order executor.** The spec pairs "graduation fallback" with one. It does not exist.
