# Runbook: the graduation-target window

**You were paged by `keeper.graduationWindow`. Read the box that matches your page. You do not need to read the contracts.**

This page exists because `LaunchFactory` has a governor that can re-point where every completed curve pays out, behind a three-day delay. A compromised governor can take **the entire raise of every already-completed curve**: propose a self-controlled target, wait out the delay, apply, then call `graduate()` on everything. `graduate()` resolves the target *at call time*, so every completed curve pays whoever is pointed at when the call lands.

The delay's only defence is the public draining pending graduations inside the window. That requires somebody watching. **You are the somebody.**

---

## 0. The thirty-second version

| Page you got | What it means | What you do | Deadline |
|---|---|---|---|
| `pendingGraduationTarget is 0x… NOT on the allowlist` | Someone proposed a target we did not authorise. It has **not** landed yet. | [§2 DISARM](#2-disarm), then [§3 DRAIN](#3-drain) | The `expiresAt` in the page. Typically 6 days from the proposal; **at minimum, act before `opensAt`.** |
| `graduationTarget is 0x… NOT on the allowlist … ALREADY LANDED` | **The change has landed.** The drain window is over. | [§4 IT LANDED](#4-it-landed) | Now. There is nothing to wait for. |
| `protocolTreasury is 0x… NOT on the allowlist` | The fee recipient was rotated. `setProtocolTreasury` has **no delay** — this is always after the fact. | [§5 TREASURY](#5-treasury) | Now, but there is no window to act inside. |
| `WINDOW INPUTS CANNOT BE TRUSTED` | The chain clock or the delay the factory reports is wrong, so the watcher **cannot tell an expired proposal from a live one**. It is deliberately erring loud. | [§6 THE WATCHER IS DOWN](#6-the-watcher-is-down), then re-read the window by hand | 30 minutes. Treat any target named in the same page as live. |
| `GraduationTargetChanged shows the pointer WAS held by …` | The slots read clean **now**, but a non-allowlisted address held the graduation pointer at some point in the past. | [§4 IT LANDED](#4-it-landed) — this is a past incident, not a live one | Investigate today. |
| `ProtocolTreasuryChanged shows the fee recipient WAS …` | Same, for the treasury. | [§5 TREASURY](#5-treasury) | Investigate today. |
| `watcher-heartbeat-missed` / `chain-head-stale` / `chain-time-skewed` / `chain-time-frozen` | The watcher itself is broken. **We are currently blind.** | [§6 THE WATCHER IS DOWN](#6-the-watcher-is-down) | 30 minutes. |
| `log-scan-failed` / `log-scan-incomplete` / `exposure-read-failed` / `classify-threw` | The watcher can still see the window but **cannot count what is at risk**. Any exposure number in a page right now is a lower bound or unknown. | [§6 THE WATCHER IS DOWN](#6-the-watcher-is-down) | 30 minutes. |

**Pages repeat at most once an hour** (`KEEPER_ALERT_REPEAT_MS`). A *first* page is never suppressed, and any change of state — a different target, a new finding — pages immediately. So a page arriving twice in five minutes means **two different things happened**, not that the watcher is chatty.

> **In Phase 1d, `drain` has no referent and this runbook says so in these words.** `graduationTarget` is `address(0)` for the whole phase, so `BondingCurve.graduate()` reverts `GraduationTargetUnset()` for every curve, completed or not. Under a governor compromise during Phase 1d there is **no on-chain remedy**: the mitigations are that the *first* target has never been set (so there is nothing already pointed at that an attacker displaces), and that the compromise is publicly visible for three days before it can land. The Phase 1d action is therefore: **page, publish, and do not let the proposal land — and if it lands anyway, the raise of every completed curve is gone.** Phase 2 turns `drain` from prose into a procedure; the Phase 2 plan's R-12 already requires a full launch→buy-out→graduate→pool-exists cycle against a locker before any `applyGraduationTarget`.

---

## 1. What is watched

The watcher polls every `KEEPER_POLL_INTERVAL_MS` (default 5s) and reads **both slots and logs on every poll**, never one alone.

**Slots** (all six pinned to a single block number, so they cannot straddle a block boundary and disagree with each other):

- `LaunchFactory.pendingGraduationTarget()`
- `LaunchFactory.pendingGraduationTargetEta()`
- `LaunchFactory.graduationTarget()`
- `LaunchFactory.protocolTreasury()`
- `LaunchFactory.GRADUATION_TARGET_DELAY()` — read from the chain, never hard-coded, so a factory deployed with a different delay cannot silently shorten the watcher's idea of the window
- `LaunchFactory.launchCount()`

**Logs**, from the address book's `startBlock`, paged, with a cursor in `keeper/.cursor` so a restart does not rescan from genesis:

- `Launched` — where the curve set comes from until Phase 3's indexer exists
- `GraduationTargetProposed`, `GraduationTargetChanged`, `ProtocolTreasuryChanged` — the history the slots cannot reconstruct

The page size is `KEEPER_LOG_SCAN_CHUNK` (default 10 000 blocks, which is what Arc serves today). **If the endpoint rejects that width, the scan halves it and retries rather than failing the poll** — a permanent range error would otherwise wedge the cursor at one chunk forever, and a wedged cursor means pages with no heartbeats, which §8's drill reads as *there was no watcher*. See §6.

`BondingCurve.Completed` is **deliberately not** queried, and the reason is worth knowing when you are reading a page: the watcher already reads `complete()` **from the slot, on every known curve, every poll**. For that one fact the slot is strictly better than the log — `complete` latches true and never goes back, so the log carries nothing newer. For the governance events the opposite holds, which is why those three *are* queried.

**Why both, and it is not belt-and-braces.** An RPC can drop a log range; a reorg can unsee one; the keeper can be restarted past a gap. The slot cannot lie about the *current* state, but it cannot tell you a proposal was made and overwritten either. The log stream gives *history*; the slot gives *truth*.

`launchCount` is the specific reason the pairing is executable rather than decorative: it increments exactly once per `launch()`, and each `launch()` emits exactly one `Launched`. So the slot is an **exact oracle for the number of logs**. A log stream that has silently died returns an empty list, which is otherwise indistinguishable from "no launches have happened". The slot is the only local thing that tells those two apart — and when they disagree the watcher pages `log-scan-incomplete`.

**The mismatch has two directions and the page names which one you have.** `UNDER-reporting` means the log path is missing launches and every exposure figure is a **LOWER BOUND**. `OVER-reporting` means the cursor is holding a curve the chain no longer has — a reorged-out `Launched`, or a `startBlock` that does not belong to this chain. The cursor only ever adds, so that state is **sticky**: it pages every poll and never emits a heartbeat until someone clears it. The remedy is in §6.

> **What makes "detected, not prevented" tolerable is the throttle.** This state is sticky — it recurs every poll until someone clears the cursor — so without repeat suppression it would be roughly 35 000 pages a day, and a rota that gets 35 000 pages turns the pager off. Detection alone would not have been an acceptable answer; detection *plus* an hourly repeat ceiling is.
>
> **The watcher DETECTS reorg-driven over-count; it does not PREVENT it, and that is deliberate.** Removing a reorged-out entry needs per-curve block numbers and a confirmation depth — i.e. a small reorg-aware indexer. Phase 3 replaces this cursor with a `@arcpad/db` query, and reorg handling belongs there once, for every event type, rather than being built twice and deleted here. What the keeper owes you in the meantime is that the condition is **loud, correctly labelled, and self-describing** — which the `OVER-reporting` page is. It is never silent, and it never under-states the amount at risk.

### The window arithmetic is only as good as the clock

Both `phase` and `expiresAt` come from **chain time** and from the delay the factory reports. Neither is taken on trust:

- `GRADUATION_TARGET_DELAY()` below **one hour** is rejected. A window nobody can act inside is not a window, and a delay of `0` would make every proposal expire one second after it opens — that is, go silent.
- Chain time more than **15 minutes** from the watcher's own clock is rejected.

When either fails, the page says `WINDOW INPUTS CANNOT BE TRUSTED` and the watcher **refuses to downgrade an expired proposal**. Every non-allowlisted target pages regardless of phase. This errs towards waking you up, on purpose: `expired` is the only state in which a hostile target does not page, and it is reached by two numbers the chain hands us.

The window:

```
opensAt   = pendingGraduationTargetEta
expiresAt = pendingGraduationTargetEta + GRADUATION_TARGET_DELAY()
phase     = none | armed (now < opensAt) | open (opensAt <= now <= expiresAt) | expired (now > expiresAt)
```

**Both bounds are inclusive.** `applyGraduationTarget()` still succeeds at exactly `eta` and still succeeds at exactly `eta + delay`; it fails one second later. Total exposure is bounded at `2 × GRADUATION_TARGET_DELAY` = **six days**. That bound is what makes a rota finite.

### A proposal made when nothing has completed is the dangerous one

The watcher alerts on a proposal **whether or not any curve has completed**. This is deliberate and it is the sharpest form of the attack:

> Propose on day 0, when no launch has completed. There is nothing to drain, so nobody objects. Let the window lapse — observers watching for the *landing* conclude the proposal was dropped. Return on day 368, when curves have completed, and apply-and-drain in one transaction. **The notice period at the moment of theft is zero.**

That was closed on the contract side by bounding the window at `[eta, eta + delay]`, so a lapsed proposal expires. **But the expiry only helps if somebody notices during the window** — which is what the watcher is for. If you get a page that says `0 completed-but-ungraduated curve(s), 0.00 USDC`, that is **not** a reason to deprioritise it. It is the textbook shape.

---

## 2. DISARM

**The governor Safe re-proposes the *correct* target.** This overwrites the pending one and restarts the three days. There is no separate `cancel` member — re-proposing *is* the cancel.

```
Contract: LaunchFactory at $ARC_FACTORY_ADDRESS
Call:     proposeGraduationTarget(address target_)
Arg:      the address in contracts/deploy/expected-governance.json ->
          <chainKey>.allowedGraduationTargets[0]
From:     the governor Safe (2-of-3)
```

One transaction. Confirm afterwards that `pendingGraduationTarget()` returns the address you passed and that the watcher's next poll classifies it `ok` (`pending-target-allowlisted`).

**When `allowedGraduationTargets` is empty (all of Phase 1d), there is no correct target to re-propose.** Do not invent one. In that case DISARM is unavailable; go straight to §4's disclosure step and keep the proposal from landing socially, not technically.

> **DISARM requires the governor keys, so it is unavailable under key compromise.** If you believe the keys are compromised, the attacker can re-propose immediately after you do, forever. DISARM buys three days per use; it does not resolve anything. Escalate.

---

## 3. DRAIN

**Graduate every completed curve to the *current* target, inside the window, so a re-point cannot reach them.**

```
For each curve C where C.complete() && !C.graduated():
    call C.graduate()
From: whatever entrypoint the CURRENT graduationTarget exposes -- graduate()
      requires msg.sender == LaunchFactory.graduationTarget()
```

The list of curves and the amount at risk are **already in your page**; you do not need to query for them.

> ### PHASE 1D: `DRAIN` HAS NO REFERENT.
>
> `graduationTarget` is `address(0)` for the whole of Phase 1d. `BondingCurve.graduate()` reverts `GraduationTargetUnset()` for every curve, completed or not. **There is no on-chain remedy.** Do not spend the window trying to find one. Go to §4.

---

## 4. IT LANDED (or you cannot stop it landing)

`applyGraduationTarget()` is **permissionless**. Anyone — including the attacker — can land an elapsed proposal. **Waiting it out is not a strategy.** The only thing that expiry gives you is that nobody has to land it *for* you to be safe after `expiresAt`; it does not stop the attacker landing it at `opensAt`.

1. **Stop the bleeding you can stop.** If DRAIN has a referent (Phase 2+), run it *now*, for every completed curve, before doing anything else. Curves that graduate to the old target are permanently out of reach.
2. **Publish.** Post the factory address, the offending target, `opensAt`, `expiresAt` and the exposure figure from the page to the project's public channel and to any integrator list. The delay's entire value is that it is public; a compromise nobody is told about converts a three-day notice into no notice.
3. **Freeze the front end.** Take `web` off the launch path so no new raise is added to the pile.
4. **Escalate** (§7).
5. If it has already landed: **the raise of every completed curve is gone.** Record the transaction hash, the block, and the amount. Do not attempt an on-chain recovery — there is none, and the contract's own NatSpec records this as accepted rather than solved.

---

## 5. TREASURY

`setProtocolTreasury` has **no delay by design**, and the asymmetry is deliberate: a delay on the target has a concrete remedy (drain inside the window); a delay on the treasury has none, because rotation does not touch accrued `owed[old]` — the old address keeps claiming it. So this page is **always post-hoc**. There is no window.

1. Confirm against `expected-governance.json` that the new address is genuinely not ours (a legitimate rotation that was not recorded in the file produces this page — fix the file, and record *why* in the commit).
2. If it is not ours: the governor is compromised. Assume the graduation target is next. Go to §4 step 2 and §7.
3. Accrued fees owed to the *previous* treasury are unaffected and still claimable by it.

---

## 6. THE WATCHER IS DOWN

**A dead watcher must be louder than a quiet chain**, because "we saw nothing" and "nothing happened" are otherwise the same observation. There are three ways it goes down and the watcher detects each one differently.

| Page | What actually broke | First check |
|---|---|---|
| `watcher-heartbeat-missed` | No poll has run to completion for two poll intervals. The process may be alive but wedged, or every poll is erroring. | `pnpm --filter @arcpad/keeper start` logs — look for the immediately-preceding `PAGE` line naming the failing step. |
| `chain-head-stale` | The RPC is serving a frozen view: the head block number has not moved for two poll intervals. Polls are "succeeding" and heartbeats are flowing — **only this detector sees it.** Because the window is computed from *chain* time, a frozen head means the window clock has stopped. | `curl -s -X POST $ARC_RPC_URL -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` twice, 30s apart. |
| `chain-time-skewed` | The chain timestamp is more than 15 minutes from local time. **The window phase is computed from chain time, so it cannot be trusted while this holds** — a timestamp skewed far enough forward makes a fresh hostile proposal read as `expired`, which is the one silent state. Blocks may be advancing normally, so `chain-head-stale` will not fire. | Check the node's clock and that `$ARC_RPC_URL` is not a fork/replay endpoint. Compare `eth_getBlockByNumber` `timestamp` with `date -u +%s`. |
| `chain-time-frozen` | The chain timestamp has not moved for ten poll intervals. The budget is deliberately loose because **Arc documents that block timestamps may not increase**, so short pauses are normal and do not page. | Same checks as `chain-head-stale`. |
| `log-scan-failed` / `log-scan-incomplete` | The log scan threw, or the slot and the logs disagree about how many launches exist. The window is still being classified correctly; **only the exposure number is untrustworthy.** | Read the direction in the page. `UNDER-reporting`: compare `launchCount()` on the explorer with the count in the page; the RPC's log index is behind or truncating. `OVER-reporting`: **stop the keeper, delete `keeper/.cursor`, restart.** The scan rebuilds from `startBlock`. Nothing is lost — the cursor is a cache, not a record. |
| `classify-threw` | The window could not be classified. The page carries the **raw slot values** instead; read them against §9 and act on those. | Report it: this is a watcher bug, not a chain event. |
| `alert-sink-write-failed` | `$KEEPER_ALERT_LOG` cannot be written — disk full, permissions, the directory rotated away. **The watcher is still running and stdout/stderr still carry everything**, but the file the drill reads is no longer a record of this run, so the next `observe` will report "there was no watcher". This line goes to stderr with the `PAGE ` prefix and repeats at most once a minute. | `df -h`, and `ls -ld "$(dirname "$KEEPER_ALERT_LOG")"`. Fix the path or the disk and restart; nothing is lost from the console stream. |
| Nothing at all, for hours | The process is **dead**. It cannot page about itself. | The external dead-man's switch — see below. |

**The in-process canary does not catch `SIGKILL`, and this is the one thing you must not assume it does.** A killed process emits nothing, including its own alarm. The mercy for that case is external: the alert sink receives a `HEARTBEAT keeper.graduationWindow` line every poll, and the sink's own "no heartbeat received in N minutes" rule is what fires. **Configure that rule when you configure the sink; a heartbeat nobody is counting is decoration.** The in-process canary covers *wedged but alive*, which is the more common and more insidious case.

**While the watcher is down, read the window by hand at least once an hour:**

```bash
cast call $ARC_FACTORY_ADDRESS "pendingGraduationTarget()(address)"    --rpc-url $ARC_RPC_URL
cast call $ARC_FACTORY_ADDRESS "pendingGraduationTargetEta()(uint256)" --rpc-url $ARC_RPC_URL
cast call $ARC_FACTORY_ADDRESS "graduationTarget()(address)"           --rpc-url $ARC_RPC_URL
cast call $ARC_FACTORY_ADDRESS "protocolTreasury()(address)"           --rpc-url $ARC_RPC_URL
```

A non-zero `pendingGraduationTarget` that is not in `expected-governance.json` is a §2.

### Arc's public RPC rate-limits reads, and the poll interval must respect it

**Measured 2026-08-01 against `https://rpc.testnet.arc.network` and the live factory `0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439`.** These are the numbers, not an estimate:

| What was sent | Result |
|---|---|
| 6 concurrent `eth_call` (exactly what one poll's slot read does) | 2 succeeded, 4 returned **HTTP 429 / `{"code":-32011,"message":"request limit reached"}`** |
| 6 sequential `eth_call`, no delay | 2 succeeded, 4 rate-limited |
| 12 `eth_call`, 100 ms apart | 12/12 succeeded |
| 12 `eth_call`, 200 ms apart, six repeats | 4/12, 4/12, 4/12, 4/12, 12/12, 8/12 |

**The last row is the important one: the same pacing gives different answers.** The budget is not a function of *our* request rate, so there is no "slow enough" constant to pick. Anyone tuning this by inserting sleeps is tuning against noise.

Two consequences, both of which are now handled in code — do not re-derive them, but do re-measure before relying on them:

1. **viem does not retry this error.** `viem@2.55.8` returns the JSON-RPC body when the HTTP status is not OK and the body carries a numeric `code` (`utils/rpc/http.js`), so Arc's 429 becomes `RpcRequestError(code -32011)`, never `HttpRequestError(status 429)`. `shouldRetry` (`utils/buildRequest.js`) then matches only `-1`, `-32005`, `-32603` and `429` and **returns early**, making the HTTP-429 branch below it unreachable. The default `retryCount: 3` never applies. `keeper/src/chainReader.ts` adds the retry that recognises `-32011`, with exponential backoff and full jitter. **It retries the rate limit and nothing else** — a revert or a wrong chain still surfaces immediately.

2. **`KEEPER_POLL_INTERVAL_MS=5000` does not work against this RPC, and its failure mode is a page storm, not silence.** With retries a poll costs 5.5–13 s of wall clock; the canary's budget is `2 × pollIntervalMs`, so at 5 s it pages `watcher-heartbeat-missed` and `chain-head-stale` continuously *while the watcher is healthy*. Measured over 173 s at 5 s: **22 heartbeats and 15 pages, all of them canary false positives.** Over 200 s at 30 s: **6 heartbeats, 0 pages.**

> **Run the watcher with `KEEPER_POLL_INTERVAL_MS=30000` against the public Arc endpoint.** A dedicated or paid endpoint may support less; prove it with the table above before lowering it. The drill workflow passes the same number (`vars.KEEPER_POLL_INTERVAL_MS`, default `30000`) because `drillObserve`'s wait is derived from it — if the two disagree, the drill declares a live watcher dead.

If you ever see `watcher-state-read-failed` naming `request limit reached`, the retry budget has been exhausted, not bypassed: the endpoint is degraded beyond what 14 attempts can ride out. That is a real page.

**Arc has at least two rate-limit codes, and the second was documented as "unused".** The first round measured `-32011` and `chainReader.ts` recorded that `-32005` "is not used by Arc; accepted for completeness". Re-measured against the same endpoint on 2026-08-02, the answers came back **mixed** — `-32005`, `-32011`, `-32005` on consecutive ids. Both are in the retry set so the behaviour was always right, but the *reason written down* was wrong, and a wrong reason is what gets a working guard deleted as dead code. **Do not trim either code.** If `-32005` were removed, every rate limit carrying it would go un-retried: the poll fails, **no heartbeat is emitted**, and the weekly drill reports "there was no watcher" for a watcher that is alive.

### A range error is not a rate limit, and only one of them is fixed by waiting

`withRateLimitRetry` retries **transient** errors. A **range/size** error (`-32012 requested range too large`, `-32614`, `-32602`, or a body saying `more than N results`) is permanent for that request: the same chunk fails identically on every poll, so the cursor can never advance past it. The measured consequence is the one that matters — **pages fire, heartbeats do not, forever**, and §8's drill reads zero heartbeats as *there was no watcher*. That is the same shape as the cold-scan failure fixed in round 7, but persisting the successful prefix does not help here, because there is no successful next attempt to make.

`scanFactoryLogs` therefore **halves the block span and retries the same range** on a range error, keeping the reduced span for the rest of that scan. It never grows back inside a call. Three properties, all tested:

- **It is bounded by construction** — each step halves and stops at 1, so at most `log2(chunk)` extra requests (14 at the default 10,000). There is no separate attempt counter: a counter would stop the shrink *above* the provider's real limit and reintroduce exactly the non-convergence it was meant to prevent.
- **It is not a blanket retry.** Any error that is not a range error still surfaces on the first attempt and becomes a `log-scan-failed` page. The narrowing exists so that the fix cannot become a mask for the failures the watcher is there to report.
- **Arc's rate-limit text is deliberately excluded from the match.** The live message is `Request exceeds defined limit ... rate limit exceeded`; a generic "exceeds limit" pattern would read a *transient* error as a *permanent* one and shrink the window for no reason.

If you see the scan converge only at a very small span, the endpoint's log limit has changed — record the new number here and set `KEEPER_LOG_SCAN_CHUNK` to it, so the watcher stops paying `log2` probe requests per poll to rediscover it.

### First live startup, for the record

Run 2026-08-01 against the production book `contracts/deploy/addresses.5042002.json` and chain 5042002 — **the first time anything loaded that book.** The whole chain passed with no changes to the book: `loadAddressBook(5042002)` → chainId/chainKey → book↔`expected-governance.json` → env agreement → `assertArcChain` → `assertFactoryMatchesGovernance` against the live factory. Then, steady state:

```
launchCount() slot                     1
Launched logs from block 54661437      1   (block 54663376, curve 0x7938BE34...324c9C)
cross-check                            AGREE -> exposure is EXACT
completed-but-ungraduated curves       1
realQuoteReserves                      12161433369060378714 wei
rendered on a page                     12.16 USDC
classification                         quiet (no-pending-target), zero pages
```

The `log-scan-incomplete` detector's basis — slot `launchCount` as an exact oracle for the `Launched` count — **held on a real chain for the first time here.**

---

## 7. The rota

**This is a rota, not a document.** A runbook with no named humans is a document that describes a control nobody operates.

> ### ⚠️ UNFILLED — THIS IS NOT YET A ROTA
>
> The three fields below marked **`TODO(owner)`** have no value yet, because the governor Safes do not exist until Task 4 creates them and no paging provider has been chosen. **Until they are filled, this document describes a control that nobody operates.** They are deliberately left as visible holes rather than plausible-looking defaults: an invented name is worse than a blank, because a blank gets filled and a wrong name gets trusted at 3 am.
>
> Filling them is a **release gate for the deploy**, alongside the first live drill (§8).

| Field | Value |
|---|---|
| **On-call** | **`TODO(owner)`** — two named governor-Safe signers, rotating weekly, handover Monday 09:00 UTC. Write the names and handles **here**, and mirror the current pair in the team channel topic. (The earlier version pointed only at the channel topic to avoid staleness; that is the wrong trade — at 3 am the on-call needs a name without needing channel access. Keep both, and let the weekly handover update both.) |
| **Why signers specifically** | DISARM (§2) needs 2-of-3 on the governor Safe. An on-call who cannot sign can only escalate, which costs the window. |
| **Acknowledge within** | 30 minutes for any `page`. This number is load-bearing elsewhere: the watcher rejects any `GRADUATION_TARGET_DELAY` under an hour on the grounds that a window shorter than the ack budget is not a window. |
| **Escalation** | **`TODO(owner)`** — names and contact order. Structurally: on-call → second signer → third signer → all Safe owners. Escalate immediately, in parallel with acting; do not serialise. |
| **Alert sink** | The keeper writes every event — `PAGE `, `OK `, `HEARTBEAT ` — to **one file**, `$KEEPER_ALERT_LOG`, as well as to stdout/stderr. Set that variable; **do not** produce the file with a shell redirect, because `PAGE` lines go to stderr and `pnpm start > alerts.log` drops exactly the lines that matter. The format is a line prefix and deliberately **not** JSON — an alert path that can go silent on a parse error is exactly the failure being defended against. |
| **Paging provider** | **`TODO(owner)`** — which provider, and the two rules it must have: (1) any line starting with `PAGE ` pages the on-call; (2) **no line starting with `HEARTBEAT ` for 10 minutes pages the on-call.** Rule (2) is the dead-man's switch and it is the only thing that catches a killed process — see §6. A heartbeat nobody counts is decoration. |
| **Drill transport** | **`TODO(owner)`** — publish `$KEEPER_ALERT_LOG` at a URL the CI drill can `curl`, and set the repository variable `KEEPER_ALERT_LOG_URL`. Until this is set the weekly `observe` job fails with that exact message rather than passing on an empty file. |
| **Time budget** | The window is bounded at six days total (`eta` + `eta + 3 days`), and that bound is what makes this rota finite. But **`applyGraduationTarget` is permissionless**, so the real budget is until `opensAt`, not `expiresAt`. Treat `opensAt` as the deadline. |

---

## 8. The drill

**A monitor that has never fired in anger is a monitor nobody knows is broken.** Every serious defect on this project was found by executing something.

Two scheduled CI jobs, `.github/workflows/graduation-drill.yml`:

**Weekly (`observe`)**

1. From the governor Safe, `proposeGraduationTarget(0x000000000000000000000000000000000000dEaD)`.
2. CI asserts the watcher paged within one poll interval. **The drill reads the alert sink; it does not simulate it** — the point is to prove the alarm *pipe* works, not the classifier, which unit tests already cover.

**Three days later (`expiry`), keyed off the recorded `eta`**

3. Do **not** apply. Let it lapse.
4. CI asserts `applyGraduationTarget()` reverts `GraduationTargetProposalExpired()`. Any other revert **fails the drill** — `NotGovernor` is also a revert and proves nothing about the bound.

Step 4 is the only executable proof, on the live chain, of the expiry bound. The unit test proves the arithmetic; the drill proves the chain agrees.

```bash
# The keeper must be running with KEEPER_ALERT_LOG set -- that is what
# produces the file the drill reads. Never make it with a shell redirect.
# 30000 is not a preference; see the measurements in section 6.
KEEPER_ALERT_LOG=keeper/alerts.log KEEPER_POLL_INTERVAL_MS=30000 \
  pnpm --filter @arcpad/keeper start

# Then, after the Safe has proposed:
KEEPER_DRILL_TARGET=0x000000000000000000000000000000000000dEaD \
KEEPER_ALERT_LOG=keeper/alerts.log \
KEEPER_POLL_INTERVAL_MS=30000 \
  pnpm --filter @arcpad/keeper drill observe

# Three days later:
pnpm --filter @arcpad/keeper drill expiry
```

**Both paths above are resolved for you, and until 2026-08-01 neither was.** `pnpm --filter <pkg>` runs in the *package* directory, so `.env` was looked for at `keeper/.env` (absent — the command died with `ARC_RPC_URL is not set`) and `keeper/alerts.log` resolved to `keeper/keeper/alerts.log` (absent — the keeper emitted exactly one heartbeat and then died with `ENOENT` from inside `heartbeat()`, which sits outside every `try` in `runWatcher`). Both are now resolved against the repo root, absolute paths are passed through untouched, the sink is probed once at startup, and a *later* sink failure pages instead of killing the process. Verified by running the block above against the live chain: 6 heartbeats, 0 pages, sink written to `keeper/alerts.log`.

`keeper/alerts.log` is already ignored by `.gitignore`'s `*.log`, so writing it inside the tree leaves nothing to clean up.

### You cannot point the shipped watcher at the rehearsal factory — but a harness can, and it was

There is a real proposal standing on the **rehearsal** factory `0xfed991C6B9AD7144Df3d670c6b9EcF3620ac6eA5` (`pendingGraduationTarget` `0x…dEaD`, `eta` 2026-08-03T22:26:20Z, expiring 2026-08-06T22:26:20Z — all four read off the chain on 2026-08-01 and re-read on 2026-08-03). It looks like a free live drill. **The shipped watcher cannot reach it**, and the reason is worth knowing:

- Redirecting with `KEEPER_ADDRESS_BOOK_DIR` fails in `packages/shared`, by field name: `launchFactory: is 0xfed991C6… but CREATE2(0x4e59…56C, <FACTORY_SALT>, <factoryInitcodeHash>) derives 0x0d75a4fF…`. The book must derive its own factory address, and no edit to a book can make a non-canonical address derive.
- **And no `factoryInitcodeHash` exists that would make it derive.** Measured from the deploy broadcast (`contracts/broadcast/Governance.s.sol/5042002/deployRehearsalStack-latest.json`): the rehearsal stack was deployed through the same CREATE2 factory but under **different salts** — `0x95d243550cbbe9c4f2479e433038d2b129eb6f7fbeb73ba581eb10fd1065ba2d` for the factory, `0xead6bc96d043a2953a53fce98af83d1f634ac5d1d4a83a6614eecbfb4015f40c` for the escrow — while `packages/shared` derives with the fixed `keccak("arcpad.LaunchFactory.v1")`/`keccak("arcpad.FeeEscrow.v1")`. A book can carry any hash it likes; the salt it is checked against is a constant. **See §9 — this is the one thing that can stop the watcher following a Phase 2 redeploy.**

So the drill was run **outside the config loader instead**: `.superpowers/sdd/2026-07-30-arcpad-phase1d-deploy/live-drill.mts` supplies the factory address directly and leaves everything else real — the real `viemChainReader` against `https://rpc.testnet.arc.network`, the real `runWatcher`, the real `fileSink`, and the allowlist parsed from the committed `expected-governance.json`. It contains no addresses; factory, start block and sink path are required env variables, so nothing committed redirects a book or a governance record. What it observed is in **Drill status** below.
- **`assertFactoryMatchesGovernance` would *not* have stopped it.** Measured: the rehearsal factory reports the *same* governor Safe, so the startup pin passes against it. The pin catches a wrong **governor**, not a wrong **factory**. Every sibling factory this Safe deploys walks straight through it — which is exactly the stale-drill-directory shape the pin was written for.

So the redirect hazard is closed harder than the keeper's own comments claimed, but it is closed by `packages/shared/src/addresses.ts`, not by the keeper. **If that CREATE2 check is ever relaxed, the keeper has no second line here.**

In CI the keeper runs elsewhere, so the workflow's `Fetch the keeper's alert sink` step `curl`s `$KEEPER_ALERT_LOG_URL` into place first. That variable is the drill's one unconfigured input; while it is unset the job fails and names it.

### The drill can only pass on evidence from *this* run

`KEEPER_DRILL_SINCE` (ISO-8601) opens the window — record it just before the Safe proposes. Two things must then be true inside that window, and **both** are required:

1. a `PAGE` naming the drill target, and
2. **at least one `HEARTBEAT`.**

Requirement 2 is the one that matters. Without it the gate survives the death of the thing it monitors: `fileSink` appends and nothing rotates, so one old page would keep the job green forever — passing whether or not the watcher fired that week, and continuing to pass after the watcher died. A liveness gate that outlives its subject is worse than no gate, because it actively reassures. The heartbeat is produced independently of any page, so demanding both makes the only way to pass "the watcher was alive **and** it fired".

The two failures are reported differently on purpose, because they go to different sections: **no heartbeat** means *there was no watcher* (§6), not *the alarm failed*. A line whose timestamp cannot be parsed is **not counted** — the window errs towards a false red rather than a false green. A `KEEPER_DRILL_SINCE` more than 48h old is rejected outright, so the window cannot be widened back into a vacuous pass.

> **The drill is a delivery gate, not tamper-evidence.** It proves the watcher was alive and that a page reached the sink; it does **not** prove the sink was not edited. `$KEEPER_ALERT_LOG` is an ordinary append-only file with no signature, hash chain, or write protection, and the drill reads it over plain `curl`. Anyone who can write that file — or stand between it and CI — can make the drill pass. That is an accepted limit: the drill's job is to catch *the pipe being broken*, which is the failure that actually happens, not *an insider forging evidence*. If you ever need the second property, the sink has to be signed or shipped somewhere append-only, and that is a change to make deliberately rather than to assume.

**Step 1 is not in the script and must not be.** The governor is a Safe, its signatures are collected by humans, and handing governor authority to a drill script would create the thing the drill exists to detect.

### Drill status

**The live drill HAS been run — 2026-08-04, against the live chain.** (This section said the opposite for several rounds after it stopped being true. If you are reading it during an incident, that is the failure mode this note exists to prevent: a status block that reassures by being stale.)

`observe`, against the standing `0x…dEaD` proposal on the rehearsal factory, through the harness described above:

```
PAGE keeper.graduationWindow at=2026-08-04T00:13:04.071Z pendingGraduationTarget is
0x000000000000000000000000000000000000dEaD, which is NOT on the allowlist.
opensAt=1785795980 expiresAt=1786055180 phase=open chainNow=1785802282
exposure=0 completed-but-ungraduated curve(s), 0.00 USDC (0 wei, exact) ...
DRILL PASS observe: paged on attempt 1/3, and the watcher was alive for it (13 heartbeat(s) inside the window)
```

**`phase=open` is the part to read.** At the moment of the page the three-day delay had already elapsed, so `applyGraduationTarget()` was landable by anyone. That is the state this watcher exists for, seen on a real chain.

`expiry`, against **production**, also real: `DRILL FAIL expiry: applyGraduationTarget() reverted with NoPendingGraduationTarget, not GraduationTargetProposalExpired.` Correct — production has no pending proposal, so there is nothing to expire, and the gate refuses to go green on the wrong revert. **The `expiry` phase has not been run against the rehearsal factory**, whose window is *open*; that branch has unit coverage only.

The first attempt **failed**, and the reason is §9 in miniature: a cold cursor over 660k blocks is 67 chunks, the retry budget died around chunk 15, nothing was persisted, and every poll restarted from chunk 1. Forty-five seconds gave two pages and **zero heartbeats** — which this drill reads as *there was no watcher*, for a watcher that was alive and paging correctly. Fixed by persisting the scanned prefix; see §6 for the sibling case (a *permanent* range error), which the same fix does **not** cover and which is handled by narrowing the span instead.

What the unit suite executes independently: the drill's own logic and its failure modes (an empty sink fails, an *unrelated* page fails, a revert that is not `GraduationTargetProposalExpired` fails), **and the sink pipe end to end** — `fileSink` writes a real page to a real file, `fileAlertSink` reads it back, and `drillObserve` decides. The same test asserts the negative: a file containing only `OK` and `HEARTBEAT` lines makes the drill fail.

**Still a release gate:** run `observe` against the *production* factory the first time a real proposal stands there, and record its page here.

---

## 9. When the factory is redeployed (Phase 2)

Phase 2 gives `LaunchFactory` a `feeSchedule` constructor argument. The initcode changes, so the CREATE2 address changes, so `0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439` is superseded and `contracts/deploy/addresses.5042002.json` is regenerated.

**The watcher needs no code change to follow it.** Factory address, start block, chain id and chain key all come from that book; `keeper/` contains no factory literal (the only occurrence of the live address in the package is inside a comment). Verified by running the real watcher against a *different* real factory on the live chain — see §8, Drill status.

Four things do need attention, in this order.

**1. The salt, and it is the only thing that can actually stop you.** `packages/shared/src/addresses.ts` pins the book's `launchFactory` to `CREATE2(0x4e59…56C, keccak("arcpad.LaunchFactory.v1"), factoryInitcodeHash)`. If Phase 2 keeps that salt, the new initcode gives a new hash, the new hash derives the new address, and the book is accepted with no change anywhere. **If Phase 2 bumps the salt — `…v1` to `…v2`, which is the natural thing to do for a redeploy — then no book can name the new factory, `parseAddressBook` rejects it by field name, and the keeper cannot start against it until `FACTORY_SALT` in `packages/shared` moves too.** This is not hypothetical: the rehearsal stack was deployed under non-canonical salts and is unreachable through a book for exactly this reason (§8).

**2. Clear the drill's repo variables — do not update them.** `.github/workflows/graduation-drill.yml` passes `vars.ARC_FACTORY_ADDRESS`, `vars.ARC_START_BLOCK` and `vars.KEEPER_CHAIN_KEY` into the keeper. The book is the *source*; those variables are only a cross-check, and a disagreement throws by field name. After the redeploy the old values disagree, so the drill goes red for a configuration reason rather than a monitoring one. Blank means unset means "take the book", so clearing them is the correct action; updating them is also correct, but only if it happens in the same change as the book.

**3. The cursor resets itself, and says so.** `keeper/.cursor` carries `chainId`, `factory` and `startBlock`. A cursor written for the old factory is ignored, the scan restarts from the new `startBlock`, and one `OK … cursor-reset:` line names both addresses. No operator action is required and none should be taken.

> Before this, the file was keyed only by its path. The old factory's curve set would have been counted into the new factory's exposure, the old governance history would have kept firing `historic-*` findings against it, and — the sharp one — if the new `startBlock` were *below* the stale `lastScannedBlock`, `from = lastScannedBlock + 1` would have skipped the intervening range outright. `launchCount` cannot see that: it is an oracle for `Launched` only, so a skipped range drops `GraduationTargetProposed`, `GraduationTargetChanged` and `ProtocolTreasuryChanged` in silence — the exact blind spot those three streams were added to close.

**4. Expect the first scan to take several polls, and expect `log-scan-failed` pages while it does.** A redeploy means a cold cursor, and a cold cursor means walking the whole range in 10,000-block chunks (Arc rejects wider `eth_getLogs` with `-32012 requested range too large`). **Measured 2026-08-03 against `https://rpc.testnet.arc.network`:** a cold scan of ~660,000 blocks exhausts the 14-attempt rate-limit budget at around chunk 15 (`Request exceeds defined limit` / `rate limit exceeded`). The scan now writes the successfully-scanned prefix before rethrowing, so every poll advances and the scan converges.

> Until 2026-08-04 it wrote nothing on failure, so each poll restarted at the first chunk and **the scan could never complete**. That is worse than it sounds: `runWatcher` does not emit a heartbeat for a poll that failed, so the watcher produced pages but **zero heartbeats** — and §8's drill reads zero heartbeats as *there was no watcher*. Measured: 45 s of live running, 2 pages, 0 heartbeats, no cursor file. The window classification was correct throughout; only the liveness evidence was missing. If you ever see a `log-scan-failed` page with no heartbeats behind it, this is the shape.

---

## 10. Definitions, so you do not have to open the contracts

| Term | Meaning |
|---|---|
| `graduationTarget` | The only address that may call `BondingCurve.graduate()`, and the address that receives the payout. `address(0)` until governance sets it; while it is zero, every `graduate()` reverts `GraduationTargetUnset()`. |
| `pendingGraduationTarget` / `…Eta` | A proposed target and the timestamp it becomes landable. Both public — the delay's only value is that they are readable. |
| `GRADUATION_TARGET_DELAY` | 3 days. Used **twice**: notice period *and* window length. Bounds total exposure at six days. |
| `proposeGraduationTarget` | Governor only. Overwrites any pending proposal and restarts the clock. There is no `cancel`. |
| `applyGraduationTarget` | **Permissionless.** Reverts `GraduationTargetDelayNotElapsed()` before `eta` and `GraduationTargetProposalExpired()` after `eta + 3 days`. |
| `setProtocolTreasury` | Governor only, **no delay**. Does not touch fees already owed to the previous treasury. |
| `complete` / `graduated` | Per-curve flags. "At risk" means `complete && !graduated`. |
| `realQuoteReserves` | The curve's raise, in native USDC wei (18 decimals on Arc). This is the number that moves. |
