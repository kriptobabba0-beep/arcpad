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
KEEPER_ALERT_LOG=keeper/alerts.log pnpm --filter @arcpad/keeper start

# Then, after the Safe has proposed:
KEEPER_DRILL_TARGET=0x000000000000000000000000000000000000dEaD \
KEEPER_ALERT_LOG=keeper/alerts.log \
  pnpm --filter @arcpad/keeper drill observe

# Three days later:
pnpm --filter @arcpad/keeper drill expiry
```

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

**The live drill has never been run, because there is no deployed factory yet.** Task 5 lands *before* the deploy, by design — so that the factory is never live without something watching it.

What *is* executed by the unit suite: the drill's own logic and its failure modes (an empty sink fails, an *unrelated* page fails, a revert that is not `GraduationTargetProposalExpired` fails), **and the sink pipe end to end** — `fileSink` writes a real page to a real file, `fileAlertSink` reads it back, and `drillObserve` decides. The same test asserts the negative: a file containing only `OK` and `HEARTBEAT` lines makes the drill fail. What remains unexecuted is only the network hop and the chain itself.

**The first live run is a release gate for the deploy, not an optional follow-up:** run `observe` the same day the factory goes live, and record its page here.

---

## 9. Definitions, so you do not have to open the contracts

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
