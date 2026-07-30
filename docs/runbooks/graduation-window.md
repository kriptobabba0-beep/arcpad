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
| `watcher-heartbeat-missed` / `chain-head-stale` | The watcher itself is broken. **We are currently blind.** | [§6 THE WATCHER IS DOWN](#6-the-watcher-is-down) | 30 minutes. |
| `log-scan-failed` / `log-scan-incomplete` / `exposure-read-failed` | The watcher can still see the window but **cannot count what is at risk**. Any exposure number in a page right now is a lower bound or unknown. | [§6 THE WATCHER IS DOWN](#6-the-watcher-is-down) | 30 minutes. |

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

**Logs**: `Launched` from the address book's `startBlock`, paged, with a cursor in `keeper/.cursor` so a restart does not rescan from genesis.

**Why both, and it is not belt-and-braces.** An RPC can drop a log range; a reorg can unsee one; the keeper can be restarted past a gap. The slot cannot lie about the *current* state, but it cannot tell you a proposal was made and overwritten either. The log stream gives *history*; the slot gives *truth*.

`launchCount` is the specific reason the pairing is executable rather than decorative: it increments exactly once per `launch()`, and each `launch()` emits exactly one `Launched`. So the slot is an **exact oracle for the number of logs**. A log stream that has silently died returns an empty list, which is otherwise indistinguishable from "no launches have happened". The slot is the only local thing that tells those two apart — and when they disagree the watcher pages `log-scan-incomplete` and labels every exposure figure a **LOWER BOUND**.

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
| `log-scan-failed` / `log-scan-incomplete` | The `Launched` scan threw, or the slot and the logs disagree about how many launches exist. The window is still being classified correctly; **only the exposure number is untrustworthy.** | Compare `launchCount()` on the explorer with the count in the page. If they differ, the RPC's log index is behind or truncating. |
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

| Field | Value |
|---|---|
| **On-call** | Two named governor-Safe signers, rotating **weekly**, handover Monday 09:00 UTC. The current pair is recorded in the team channel topic — **not here**, so that this file does not go stale silently. |
| **Why signers specifically** | DISARM (§2) needs 2-of-3 on the governor Safe. An on-call who cannot sign can only escalate, which costs the window. |
| **Acknowledge within** | 30 minutes for any `page`. |
| **Escalation** | On-call → the second signer → the third signer → all Safe owners. Escalate immediately, in parallel with acting; do not serialise. |
| **Alert sink** | The keeper's stdout/stderr. `PAGE ` lines are pages; `HEARTBEAT ` lines feed the dead-man's switch. Route both to the paging provider. The format is a line prefix and deliberately **not** JSON — an alert path that can go silent on a parse error is exactly the failure being defended against. |
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
# Manually, against a deployed factory:
KEEPER_DRILL_TARGET=0x000000000000000000000000000000000000dEaD \
KEEPER_ALERT_LOG=keeper/alerts.log \
  pnpm --filter @arcpad/keeper drill observe

pnpm --filter @arcpad/keeper drill expiry
```

**Step 1 is not in the script and must not be.** The governor is a Safe, its signatures are collected by humans, and handing governor authority to a drill script would create the thing the drill exists to detect.

### Drill status

**The live drill has never been run, because there is no deployed factory yet.** Task 5 lands *before* the deploy, by design — so that the factory is never live without something watching it. The drill's own logic is executed by the unit suite (`drill: observe`, `drill: expiry`), including its failure modes: an empty sink fails, an unrelated page fails, and a revert that is not `GraduationTargetProposalExpired` fails. **The first live run is a release gate for the deploy, not an optional follow-up:** run `observe` the same day the factory goes live, and record its page here.

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
