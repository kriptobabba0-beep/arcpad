# Runbook — arcpad deploy and governance ceremony (Arc testnet, chain 5042002)

**This file is written to be executed at 2 a.m. by someone who did not write it.** Every command is
copy-pasteable. Nothing here is derived at run time; if a value is missing, stop rather than invent one.

Three procedures live here:

| | What it does | Independent? |
|---|---|---|
| **§A** | The governance ceremony — signing and executing a Safe transaction | Yes |
| **§B** | Phase 2 core layer — `FeeSchedule` + `LaunchFactory`, reusing the live `FeeEscrow` | Do this first |
| **§C** | Phase 2 pool layer — `PoolManager` + `ArcpadHook` + `ArcpadLocker` | **Only after §B has landed** |

§B and §C together are **Task 7**. They put **five new permanent addresses** on chain and there is no
undo.

---

## §0 — THE TRAP THAT STOPS EVERY COMMAND IN THIS FILE

`forge script` resolves the script path against your **current directory**, not against `--root`.
Measured on forge 1.6.0-rc1: run from the repo root,

```bash
forge script script/Deploy.s.sol:Deploy --root contracts …      # <-- BROKEN
```

dies with

```
Error: The system cannot find the path specified. (os error 3)
```

and names nothing — not the file, not the flag. **Every command below therefore spells the path from
the repo root** (`contracts/script/…`) while still passing `--root contracts`. Run them **from the repo
root**, because that is where `.env` lives and where `forge` looks for `ARC_RPC_URL`.

```bash
cd /path/to/pumpfunforarc      # the repo root, NOT contracts/
set -a; . ./.env; set +a       # so "$ARC_RPC_URL" is actually set in your shell
cast chain-id --rpc-url "$ARC_RPC_URL"     # must print 5042002
```

`forge test --root contracts` is **not** affected — only `forge script`.

---

## §A — The governance ceremony

## A0. What exists, and why you cannot route around it

| | Address | Notes |
|---|---|---|
| Governor Safe | `0x970534698e4592932F31892759147f79EB0D2C22` | 2-of-3, SafeL2 v1.4.1 |
| Treasury Safe | `0xebBeCfDA308EA307e173C6eC19a9C48F53d4B10c` | 2-of-3, same owner set (testnet only) |
| Owners, **declared order** | `0x0a95f5F562183089f661577bc6B63D7A829cec88`<br>`0xf5447724A9BEa99635c0456049169eaCa84EE65B`<br>`0x0D646a725DAdc8ADcF209ac999B219EF2a69ad21` | This is the order in `expected-governance.json` and the order `getOwners()` returns. **It is NOT ascending, and it must NEVER be re-sorted** — it sits inside the Safe initializer, so changing it changes the Safe addresses and therefore the factory address. |
| Owners, **ascending signing order** | `0x0a95f5F5…`<br>`0x0D646a72…`<br>`0xf5447724…` | A signature *bundle* must be in **this** order. It is a different order from the one above, and that is the trap. **You do not have to produce it by hand — see §A4.** |

> **The two orders are different and confusing them is a real, measured failure.** The declared order fixes
> the addresses; the ascending order is only for assembling signatures. Every tool in this repo now prints
> **both**, labelled.

Once `LaunchFactory` is deployed, the governor Safe is the **only** way to reach
`proposeGraduationTarget` and `setProtocolTreasury`. There is no admin key, no pause, and no recovery path
that does not mean redeploying everything and abandoning the addresses. Phase 2 needs
`proposeGraduationTarget` to point the curve at the pool, so this ceremony is on the critical path.

The full cycle for a graduation target is **propose → wait 3 days → apply**, and the apply window then stays
open for only **3 more days**:

```
GRADUATION_TARGET_DELAY = 3 days
apply is valid in [eta, eta + 3 days]   where eta = proposal time + 3 days
```

Outside that window you get `GraduationTargetDelayNotElapsed()` (too early) or
`GraduationTargetProposalExpired()` (too late — re-propose). `applyGraduationTarget()` is **permissionless
by design** and needs no Safe.

---

## A1. Before you start

```bash
cp .env.example .env          # then fill ARC_RPC_URL
cast chain-id --rpc-url "$ARC_RPC_URL"     # must print 5042002
```

Each owner needs their key in a keystore on their own machine:

```bash
cast wallet import arcpad-owner --interactive
```

---

## A2. Build the transaction and print its Safe hash

No signatures are needed for this step, and it broadcasts nothing.

**To point the curve at a pool (Phase 2):**

```bash
forge script contracts/script/Governance.s.sol:Governance \
  --sig "encodeProposeTarget(address,address)" <FACTORY> <TARGET> \
  --root contracts --rpc-url "$ARC_RPC_URL"
```

**To rotate the protocol treasury:**

```bash
forge script contracts/script/Governance.s.sol:Governance \
  --sig "encodeRotateTreasury(address,address)" <FACTORY> <NEW_TREASURY> \
  --root contracts --rpc-url "$ARC_RPC_URL"
```

It prints `SAFE TX HASH` and `inner calldata`. **Write both down.** The script recomputes the EIP-712 hash
locally and compares it against the Safe's own `getTransactionHash`; if they disagree it reverts
`SafeTxHashDiverged(local, onchain)` and you must stop — that means the tooling and the Safe disagree about
what is being signed.

> The Safe **nonce** is printed too. It is part of the hash. If someone else executes a Safe transaction
> between your signing and your execution, the nonce moves and your signatures become invalid — you will see
> `GS026`. Re-run this step and re-sign.

---

## A3. Each owner signs, independently, on their own machine

```bash
cast wallet sign --no-hash <SAFE_TX_HASH> --account arcpad-owner
```

`--no-hash` is **required**. Without it `cast` applies the `\x19Ethereum Signed Message:\n32` prefix and
produces a signature Safe will attribute to the wrong address, which surfaces as `GS026` — a confusing
failure with a correct-looking signature.

Each signature is 65 bytes (132 hex characters after `0x`). You need **2 of 3**.

---

## A4. Assemble the bundle — let the tool sort it

**Do not sort by hand.** `assembleBundle` recovers the signer from each signature, checks it really is an
owner, rejects duplicates, and sorts ascending for you:

```bash
forge script contracts/script/Governance.s.sol:Governance   --sig "executeFromGovernorSorted(address,bytes,bytes[])"   <FACTORY> <INNER_CALLDATA> "[<SIG_A>,<SIG_B>]"   --root contracts --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --broadcast
```

The signatures may be given in **any** order. If one of them was not produced by an owner you get
`NotAnOwner(<recovered address>)` — which names the problem, instead of Safe's `GS026`, which has three
possible causes and cannot tell you which one you hit.

If you must assemble it manually anyway, concatenate the 65-byte signatures with no separator and no repeated
`0x`, sorted by the **signing owner's address ascending** (§A0, second owner row):

```bash
BUNDLE="${SIG_A}${SIG_B:2}"
```

## A5. Execute

```bash
forge script contracts/script/Governance.s.sol:Governance \
  --sig "executeFromGovernor(address,bytes,bytes)" <FACTORY> <INNER_CALLDATA> "$BUNDLE" \
  --root contracts --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --broadcast
```

The submitting account pays gas and holds **no authority** — it is not an owner and cannot reach the
threshold alone (`test_theDeployerIsNotAnOwnerAndCannotReachTheThresholdAlone` gates this).

**Simulate before broadcasting** if you want certainty without spending gas — this returns `true` or the
exact revert code:

```bash
cast call <GOVERNOR_SAFE> \
  'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)(bool)' \
  <FACTORY> 0 <INNER_CALLDATA> 0 0 0 0 \
  0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 \
  "$BUNDLE" --rpc-url "$ARC_RPC_URL"
```

---

## A6. The two failures you will actually hit, and how to tell them apart

Both were **reproduced against the live governor Safe** during the Task 4 rehearsal, so these are measured,
not quoted from documentation.

| Code | Means | Fix |
|---|---|---|
| **`GS020`** | Signature data too short — fewer signatures than the threshold | You have 1 of 2. Get the second owner's signature. |
| **`GS026`** | Invalid owner provided — or the right owners in the **wrong order** | Sort the bundle by owner address ascending (§A4). Also check `--no-hash` was used (§A3) and that the nonce has not moved (§A2). |

Verbatim, one signature against a threshold of 2:

```
execution reverted: GS020
```

Verbatim, both signatures in descending order:

```
execution reverted: GS026
```

---

## A7. Confirm it took effect

Never trust the transaction receipt alone; read the state back.

```bash
cast call <FACTORY> "protocolTreasury()(address)" --rpc-url "$ARC_RPC_URL"
cast call <FACTORY> "graduationTarget()(address)"  --rpc-url "$ARC_RPC_URL"
cast call <GOVERNOR_SAFE> "nonce()(uint256)"       --rpc-url "$ARC_RPC_URL"   # must have advanced by 1
```

---

## A8. The rehearsal that proved this procedure works

Run on Arc testnet on 2026-07-31 against a **disposable** stack that is deliberately **not** in the address
book and uses a **different salt** from the real deployment
(`keccak256("arcpad.LaunchFactory.rehearsal")`), so it can never be confused with or collide with it:

| | |
|---|---|
| Rehearsal escrow | `0x8b84c84F1479D220d5174Ca0931F9a9a9AcfcA11` |
| Rehearsal factory | `0xfed991C6B9AD7144Df3d670c6b9EcF3620ac6eA5` |
| Safe tx hash | `0xa19d432cb85f0b692c6a3a0fb3bcaa649f7ebe58b1a46fcf32702922a5aba578` |
| Execution tx | `0xaddf55735cbb48cac6020b0e11b77880058bbe7481ed0357d8c4ab0db646865e` (block 54519265, 92,409 gas) |
| Effect | `protocolTreasury` `0x9705…2C22` → `0xebBe…B10c`; Safe nonce `0` → `1` |

Both failure modes above were reproduced in the same session before the successful execution.

---

## A9. Mainnet gates — do not carry these testnet choices forward

- **The two Safes share one owner set on testnet. On mainnet they must not.** Governor is authority and
  treasury is revenue; a shared owner set means one compromise takes both.
- At least one owner key must be on offline hardware.
- Arc has published no mainnet chain id, and `Profiles.sol` deliberately does not register one.
  `nameForChain` reverts `UnregisteredChain` for everything except 5042002 and 31337, so a mainnet deploy
  requires a reviewed commit that adds it — which is the review that would notice a wrong profile.

---

# §B — Phase 2, the core layer (Task 7, step 1)

Puts **`FeeSchedule` and `LaunchFactory`** on chain at their reserved, already-computed addresses, and
**reuses the live `FeeEscrow`**. Read §0 (the path trap) and §A0 first: the governor Safe must already
exist, because it is a constructor argument.

> **The Phase-1 factory `0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439` is SUPERSEDED.** Phase 2's
> constructor gains a `feeSchedule` argument, which moves the address. Do not paste the old one anywhere.
> Read every address from `contracts/deploy/addresses.5042002.json` or from B1 — never from memory.

## B0. Run the frozen-bytecode gate first, or the broadcast will not start

```bash
make frozen-hash        # from the repo root
```

It must end with `DONDURULMUS BYTECODE KAPISI YESIL.` and print

```
ok    BondingCurve   8e2460fff48ee5b6c591d0c62041936a7c63099d2ae1d636fa3bd2b927b4982f
```

This is **not** advisory. `out-frozen/` is gitignored, so on a fresh clone it does not exist, and the
deploy's pre-flight reads from it. Without it you get `FrozenArtifactMissing("out-frozen/…")` and
**nothing is broadcast** — deliberately.

Three neighbouring errors that mean different things, and the difference is the whole point:

| Error | Means | Do |
|---|---|---|
| `FrozenArtifactMissing` | You never ran the gate | Run `make frozen-hash` |
| `NotTheFrozenBuild` | You ran it, and the bytes do not match | **Do not regenerate the pin.** Find out what moved. |
| `NotTheFrozenArtifactDirectory` | The reference was read from `out/`, not `out-frozen/` | A source change broke the gate's own plumbing. Stop. |

**`forge test` does not rebuild `out-frozen/`.** A bare `forge test` after you edited and reverted a
source gives dozens of `NotTheFrozenBuild` failures on a clean tree; they are about the stale reference,
not about your tree. `make test` runs the gate first, which is why it does not happen there.

## B1. The addresses this will produce, and why they are already known

| | Address | New? |
|---|---|---|
| `FeeEscrow` | `0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6` | **No — live and funded, REUSED** |
| `FeeSchedule` | `0x47548C1ce996b24846E948B815459D98BB08dc84` | new |
| `LaunchFactory` | `0x5CA156f1809aB784655410d0f4B0704d2b306B47` | new |

All three are CREATE2 through the canonical deterministic deployer
`0x4e59b44847b379578588920cA78FbF26c0B4956C`, so they are fixed before any transaction is sent. Re-derive
them yourself if you want:

```bash
cast create2 --deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C \
  --salt <SALT> --init-code-hash <INITCODE_HASH>
```

| | salt | initcode hash |
|---|---|---|
| `FeeEscrow` | `0xc86ad978a80671d39d91fd5b65d5b29cc34a84fb29664012ce6de14effefa718` | `0xd99a4f910483ee8e40e4898fee5ef732462b55888427cd00c89697b0bff435e8` |
| `FeeSchedule` | `0xbf857b6fb7e820fc19744014e441ae2c4334d32693a68e6df4fa25b381ae0732` | `0xefa4597fc8941fb91e51fd607ce9ab34120ab30f0171915f5a7ad8778a08d623` |
| `LaunchFactory` | `0xbe555c18d58e8926d5c280a3e9cbc89e2f14c6032e597b69644113c7092390e4` | `0xd9177cabe2f31945eb6a64ac14ca862cadbe52d401e1b4d27c7c4ba8c0ada0b4` |

Or print all of them offline, with no RPC and no chain:

```bash
forge script contracts/script/PredictPhase2.s.sol:PredictPhase2 --root contracts
```

`FeeEscrow` and `FeeSchedule` take **no constructor arguments**, so their addresses are the same on every
chain. `LaunchFactory`'s is not: it commits to `(escrow, treasury, governor, T, V, S, feeSchedule)`, so
changing any Safe address, any profile number, **or the `FeeSchedule` bytecode** moves it.

> **Why the escrow is reused rather than redeployed.** `0xEEd4431e…` already holds
> **152,069,146,725,900,635 wei** of `owed[]` claims from Phase 1. Deploying a second escrow would orphan
> every one of them, silently. The pre-flight therefore does not simply accept "there is code there" — it
> compares the **runtime codehash** against `out-frozen/`, and refuses with `OccupiedByAForeignBuild` if
> anything else is sitting at that address.

## B2. Dry run — this asserts everything and deploys nothing

```bash
forge script contracts/script/Deploy.s.sol:Deploy --sig "plan()" \
  --root contracts --rpc-url "$ARC_RPC_URL" --sender <DEPLOYER_ADDRESS>
```

`plan()` is `view`. There is no `vm.broadcast` on that path; it cannot send a transaction.

It must print `chainId 5042002`, `PROFILE testnet`, `V 4292000000000000000`, the three initcode hashes,
and the three addresses in B1. **Compare them against B1 by eye before continuing.** Before printing, it
runs:

- chain → profile, and the profile digest (`ProfileDigestMismatch` if `profiles.toml` was edited alone)
- the governance digest (`GovernanceDigestMismatch` if `expected-governance.json` was edited alone)
- the initcode ↔ plan pre-flight (`InitcodeDoesNotEncodeThePlan(<field>)`)
- the frozen-build comparison (`NotTheFrozenBuild`, `FrozenArtifactMissing`, `NotTheFrozenArtifactDirectory`)
- the CREATE2 deployer's **codehash** (`Create2DeployerNotCanonical`, `Create2DeployerMissing`)
- both Safes probed live as ≥2-of-3 (`NotAMultisig`, `MultisigThresholdTooLow`, `MultisigTooFewOwners`)
- deployer balance ≥ 0.5 USDC (`InsufficientDeployerBalance`)
- escrow and schedule **vacant or exactly our build** (`OccupiedByAForeignBuild`)
- the escrow agrees with the recorded address book (`AddressBookDisagrees`)
- the factory address unoccupied (`AlreadyDeployed`)

If any of those fires, **stop and read the error name** — every one of them is specific.

## B3. Broadcast

```bash
forge script contracts/script/Deploy.s.sol:Deploy --sig "run()" \
  --root contracts --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --broadcast --slow
```

`run()` re-runs every assertion from B2 through the **same** `_resolve()` — there is no path that skips
them — then sends **up to three** transactions to `0x4e59b448…`, in this order and no other:

1. `FeeEscrow` — **skipped**, because it is already there (`deployIfAbsent`)
2. `FeeSchedule`
3. `LaunchFactory`

**The order is load-bearing:** `LaunchFactory`'s constructor reads the `FeeSchedule`'s code and reverts
`FeeScheduleHasNoCode` if it is not there yet. Then it reads the deployed factory back and compares its
immutables against the plan (`ProfileNotAsDeployed`, `GovernanceNotAsDeployed`).

`forge script` simulates the whole script before sending, so a failed read-back aborts with nothing
broadcast.

> **A second run reverts `AlreadyDeployed("LaunchFactory", …)` rather than minting a second universe.**
> Note the name: it is the *factory*, not the escrow, because the escrow and the schedule are now
> legitimately reusable. If you see it, the deploy already happened — go to B4.

If the run is interrupted part-way, **§C7 applies here too** — the recovery is the same, and it was
rehearsed against `DeployPool`, whose shape is identical.

## B4. Verify on chain — do not trust the script's read-back

```bash
F=0x5CA156f1809aB784655410d0f4B0704d2b306B47
cast code 0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6 --rpc-url "$ARC_RPC_URL" | head -c 20
cast code 0x47548C1ce996b24846E948B815459D98BB08dc84 --rpc-url "$ARC_RPC_URL" | head -c 20
cast code $F                                          --rpc-url "$ARC_RPC_URL" | head -c 20

cast call $F "escrow()(address)"                 --rpc-url "$ARC_RPC_URL"   # 0xEEd4431e…
cast call $F "feeSchedule()(address)"            --rpc-url "$ARC_RPC_URL"   # 0x47548C1c…
cast call $F "governor()(address)"               --rpc-url "$ARC_RPC_URL"   # 0x97053469…
cast call $F "protocolTreasury()(address)"       --rpc-url "$ARC_RPC_URL"   # 0xebBeCfDA…
cast call $F "VIRTUAL_TOKEN_RESERVES()(uint256)" --rpc-url "$ARC_RPC_URL"   # 1073000000000000000000000000
cast call $F "VIRTUAL_QUOTE_RESERVES()(uint256)" --rpc-url "$ARC_RPC_URL"   # 4292000000000000000
cast call $F "SALE_SUPPLY()(uint256)"            --rpc-url "$ARC_RPC_URL"   # 793100000000000000000000000
cast call $F "graduationTarget()(address)"       --rpc-url "$ARC_RPC_URL"   # 0x0 — nothing set yet
cast call $F "launchCount()(uint256)"            --rpc-url "$ARC_RPC_URL"   # 0
```

Also check that the escrow's money did not move and its books still balance:

```bash
E=0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6
cast balance $E --rpc-url "$ARC_RPC_URL"                      # 152069146725900635
cast call $E "totalOwed()(uint256)" --rpc-url "$ARC_RPC_URL"  # the same number, today
```

The contract's invariant is `totalOwed <= balance`, not equality — a direct transfer to the escrow would
raise the balance without raising `totalOwed`. Today the two are equal, so **a drop in either is the
alarm**; a rise in `balance` alone is not.

`V` is the one to look at twice: `4292000000000000000` is **4292e15**, the testnet magnitude.
`4292000000000000000000` would be production — 1000× — and every guard in the contract accepts it.

## B5. Write the address book

```bash
pnpm addressbook --chain 5042002 --smoke-token <SMOKE_TOKEN>
```

It reads the broadcast receipt plus live `eth_call`s, re-derives the addresses from their initcode
hashes, and refuses to write a book its own loader would reject. It prints the `NEXT_PUBLIC_*` / `ARC_*`
block for `.env`.

`--smoke-token` is required for `totalSupply`, which is read off a token the deployment actually minted
rather than copied from a constant — so B5 comes **after** a smoke launch against the new factory, not
before it.

> **KNOWN GAP — the address book has no fields for `feeSchedule`, `poolManager`, `arcpadHook` or
> `arcpadLocker`.** Regenerating it after Task 7 records the new `launchFactory` and nothing about the
> pool layer. Until `scripts/addressbook.ts` grows those fields, write the five new addresses into the
> commit message and into `.superpowers/sdd/AGENT-CONTEXT.md` **by hand**, and keep
> `contracts/broadcast/{Deploy,DeployPool}.s.sol/5042002/run-latest.json` **committed** — that directory
> is tracked, and it is the only machine-readable record of what was sent.

## B6. If something is wrong after broadcast

There is no upgrade path and no admin key. The factory is immutable except for `protocolTreasury` and
`graduationTarget`, both governor-only:

- **wrong treasury** → recoverable: `setProtocolTreasury` via §A, and it reaches live curves because
  `BondingCurve` reads `protocolTreasury()` at deposit time.
- **wrong profile numbers, wrong governor, wrong escrow, or wrong fee schedule** → **not recoverable.**
  They are immutable and address-committing. The only remedy is a new salt and abandoning these
  addresses. This is why B2 exists and why the read-back in B3 is not optional.

---

# §C — Phase 2, the pool layer (Task 7, step 2)

Puts **`PoolManager`, `ArcpadHook` and `ArcpadLocker`** on chain. This is the most irreversible thing in
the repository, and the reason is V4's design, not ours.

> **The hook's address IS its permission set.** Uniswap V4 encodes hook permissions in the **low 14 bits
> of the hook's address** (`Hooks.ALL_HOOK_MASK`), and that address is a **field of every `PoolKey`**. So
> the address fixes the permissions and the permissions fix the address — and after the first pool is
> initialised (Task 8), **neither can ever change.** Re-mining the salt stays available for the whole of
> §C; it stops being available at Task 8's first `initialize`.

**§C does NOT set the graduation target.** Pointing the curve at the locker is a separate, reviewed step
(Task 8) and it is `propose → wait 3 days → apply` through §A. Do not do it here.

## C0. Before you type anything

| Check | Command | Must be |
|---|---|---|
| chain | `cast chain-id --rpc-url "$ARC_RPC_URL"` | `5042002` |
| frozen gate | `make frozen-hash` | `… KAPISI YESIL.` |
| §B landed | `cast codesize 0x5CA156f1809aB784655410d0f4B0704d2b306B47 --rpc-url "$ARC_RPC_URL"` | non-zero |
| escrow | `cast codesize 0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6 --rpc-url "$ARC_RPC_URL"` | non-zero |
| gas money | `cast balance <DEPLOYER> --rpc-url "$ARC_RPC_URL"` | **≥ 1e18** (see C8) |

> **`DeployPool` has NO deployer-balance pre-flight.** `Deploy` checks `≥ 0.5 USDC`
> (`InsufficientDeployerBalance`); the pool layer does not, and it costs roughly four times as much.
> Check it yourself, from the row above. On Arc the native gas asset **is USDC** and there are two views
> of one balance — the 18-decimal native view (`cast balance`) and the 6-decimal ERC-20 at
> `0x3600000000000000000000000000000000000000`. **Never add them.** The relation is
> `units == floor(wei / 1e12)`.

## C1. The three addresses this will produce

| | Address |
|---|---|
| `PoolManager` | `0x617321A877e024C870516CD599A581dCDCa6c09b` |
| `ArcpadHook` | `0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC` |
| `ArcpadLocker` | `0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8` |

Print them offline, with no RPC and no chain, and compare **every character**:

```bash
forge script contracts/script/PredictPool.s.sol:PredictPool --root contracts
```

It must print these six lines (forge indents its log output; the values are what matter):

```
PoolManager   0x617321A877e024C870516CD599A581dCDCa6c09b
ArcpadHook    0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC
ArcpadLocker  0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8
hook salt (MINED)     0x000000000000000000000000000000000000000000000000000000000000000d
hook flags (low 14b)  8396
hook creationCodeHash 0x25a4e548d3b176f9150b6c5cef57098b1893d5b54c93e8fe0262e3305d78ffea
```

`8396` is `0x20CC` = `beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnsDelta |
afterSwapReturnsDelta`. **If any of these six lines differs, STOP.** A different hook salt means the
hook's initcode moved, which means the address moved, which means the pin in `PoolDeployLib.sol` is stale
— and the deploy will refuse anyway (`HookSaltIsNotThePinnedOne`). Fixing that is a reviewed source
change, not a 3 a.m. decision.

## C2. Dry run — asserts everything, deploys nothing

```bash
forge script contracts/script/DeployPool.s.sol:DeployPool --sig "plan()" \
  --root contracts --rpc-url "$ARC_RPC_URL" --sender <DEPLOYER_ADDRESS>
```

`plan()` is `view` — there is no `vm.broadcast` on that path. Its pre-flight runs **in this order, and
the order matters**:

| Check | Error | Why it sits here |
|---|---|---|
| CREATE2 deployer codehash | `Create2DeployerNotCanonical` | every predicted address depends on it |
| factory == the derived one | `FactoryIsNotTheDerivedOne` | the hook's salt is mined *from* this address |
| escrow == the derived one | `EscrowIsNotTheDerivedOne` | same |
| factory has code | `FactoryHasNoCode` | the hook `STATICCALL`s it on **every** `beforeInitialize`, forever |
| escrow has code | `EscrowHasNoCode` | same |
| hook address carries `0x20CC` | `HookAddressLacksTheArcpadFlags` | before `BaseHook`'s constructor would, i.e. before gas is spent |
| salt reproduces the address | `HookSaltDoesNotReproduceTheAddress` | computed independently of the miner, so it is not a tautology |
| **salt == the reviewed pin** | `HookSaltIsNotThePinnedOne` | mining runs every time; this says the result is the *reviewed* result |
| all three addresses vacant | `PoolContractAlreadyDeployed` | |

The flag check cannot catch a wrong factory on its own — a hook mined against the **wrong** factory still
carries `0x20CC` (measured). That is why the factory anchor comes first.

## C3. Broadcast

```bash
forge script contracts/script/DeployPool.s.sol:DeployPool --sig "run()" \
  --root contracts --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --broadcast --slow
```

Three transactions to `0x4e59b448…`, in this order, which is one-way:

| # | Contract | Why it cannot move | measured gas |
|---|---|---|---|
| 1 | `PoolManager` | the hook's constructor takes its address | 5,254,202 |
| 2 | `ArcpadHook` | the locker's constructor takes its address | 2,006,224 |
| 3 | `ArcpadLocker` | — | 1,616,996 |

`--slow` sends them one at a time and waits for each receipt. It is not required for correctness, but it
buys a **clean failure**: an interruption then leaves "N landed, one pending" instead of three
simultaneously-in-flight transactions.

Success looks like exactly this, and the first line is the one that matters:

```
read-back OK: the three pool contracts hold the resolved wiring
ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
Transactions saved to: .../contracts/broadcast/DeployPool.s.sol/5042002/run-latest.json
```

`read-back OK` means `assertAsDeployed` re-read all six wirings **from the chain** and confirmed the
`PoolManager`'s owner is the governor Safe. **If you do not see that line, the deploy did not complete —
go to C6**, no matter what else the output says.

## C4. Verify on chain — do not trust the script's read-back

```bash
PM=0x617321A877e024C870516CD599A581dCDCa6c09b
HK=0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC
LK=0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8
F=0x5CA156f1809aB784655410d0f4B0704d2b306B47
E=0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6

cast codesize $PM --rpc-url "$ARC_RPC_URL"      # non-zero
cast codesize $HK --rpc-url "$ARC_RPC_URL"      # non-zero
cast codesize $LK --rpc-url "$ARC_RPC_URL"      # non-zero

cast call $HK "poolManager()(address)" --rpc-url "$ARC_RPC_URL"   # == $PM
cast call $HK "factory()(address)"     --rpc-url "$ARC_RPC_URL"   # == $F
cast call $HK "escrow()(address)"      --rpc-url "$ARC_RPC_URL"   # == $E
cast call $LK "poolManager()(address)" --rpc-url "$ARC_RPC_URL"   # == $PM
cast call $LK "factory()(address)"     --rpc-url "$ARC_RPC_URL"   # == $F
cast call $LK "hook()(address)"        --rpc-url "$ARC_RPC_URL"   # == $HK
cast call $PM "owner()(address)"       --rpc-url "$ARC_RPC_URL"   # 0x970534698e4592932F31892759147f79EB0D2C22
```

The last one is not cosmetic: `PoolManager`'s owner appoints the protocol-fee controller, so leaving it
on an EOA would bind every Phase-2 pool to that one key.

## C5. What a completed deploy leaves behind

```bash
python -c "import json; d=json.load(open('contracts/broadcast/DeployPool.s.sol/5042002/run-latest.json')); print('transactions', len(d['transactions']), 'receipts', len(d['receipts']), 'pending', d['pending'])"
```

A complete run reads `transactions 3 receipts 3 pending []`. **Commit that file** — the directory is
tracked, and until the address book carries the pool layer it is the only machine-readable record of
what was sent.

## C6. What a half-landed deploy looks like

Read the same file. It tells you the truth in three numbers:

| `transactions` / `receipts` / `pending` | Means |
|---|---|
| `3 / 3 / []` | done — go to C4 |
| `3 / 0 / []` | forge wrote the plan and then failed to send anything. **Nothing is on chain.** |
| `3 / 2 / ["0x…"]` | two landed; the third **was sent** and its receipt was never seen |
| `3 / 2 / []` | two landed; the third was never sent |

**The broadcast file is written BEFORE the first transaction is sent.** Measured: a run that could not
send transaction 1 at all still left a `run-latest.json` with three transactions, zero receipts and
`hash: null` on each. So the file's existence proves nothing about the chain. **Cross-check with
`cast codesize` on all three C4 addresses before you decide anything.**

## C7. Recovery — rehearsed 2026-08-08, in this order

Rehearsed against a throwaway `anvil` (chain 31337, `local-rehearsal` profile) driving the real
`DeployPool.s.sol`. `anvil` cannot reproduce Arc's chain behaviour, but this rehearsal is about
**forge's** behaviour, which is the same everywhere. A control run was taken first, and every recovery
below was compared against it by **runtime codehash on all three contracts plus `hook.poolManager`,
`hook.factory`, `locker.hook` and `poolManager.owner`** — a byte-for-byte diff, not an eyeball.

### First: a plain re-run is NOT a recovery path

```bash
# DO NOT DO THIS after a partial deploy
forge script contracts/script/DeployPool.s.sol:DeployPool --sig "run()" … --broadcast
```

Measured, it stops at

```
Error: script failed: PoolContractAlreadyDeployed("PoolManager", 0x…)
```

because the pre-flight re-runs and sees the occupied address. That is correct behaviour, and it is also
why `--resume` exists.

### Recovery 1 — `--resume`

```bash
forge script contracts/script/DeployPool.s.sol:DeployPool --sig "run()" \
  --root contracts --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --resume
```

**`--resume` does not re-run the script.** Measured: it prints only `No files changed, compilation
skipped` and then the send/receipt lines — no plan banner, no address list, **and no `read-back OK`**.
Two consequences, and both matter:

- the occupied-address pre-flight is **not** on this path, which is exactly why resume can work at all;
- **`assertAsDeployed` is not on this path either.** A resumed deploy is *never* read back by the script.
  **You must do C4 by hand.** This is the single most important sentence in §C.

Result from the rehearsal: resuming a file with `receipts 0, pending []` sent all three transactions and
produced a final state **byte-identical** to the uninterrupted control run.

### THE SURPRISE — `--resume` hangs forever on a stale `pending` entry

If `pending` is **not empty**, `--resume` waits for the receipt of *that exact transaction hash*. It does
**not** re-send it. Measured: with `pending: ["0x7a15…"]` and that transaction dropped from the mempool,
`forge` sat for **over ten minutes** printing nothing after `No files changed, compilation skipped`,
while the chain stayed at the same block, the mempool stayed empty and the sender's nonce never moved.
There is no timeout and no message.

**How to tell the two cases apart before you wait:**

```bash
# take the hash out of `pending` in run-latest.json, then:
cast tx <PENDING_HASH> --rpc-url "$ARC_RPC_URL" 2>&1 | head -3
```

- The transaction comes back → it is still in flight. **Wait**; `--resume` will pick it up. Arc's blocks
  are ~350 ms, so "still in flight" a minute later means it is gone.
- It prints, verbatim and immediately, `Error: tx not found: 0x…` → it was dropped or replaced.
  `--resume` will hang. Go to Recovery 2.

Do **not** use `cast receipt <HASH>` for this probe: it blocks waiting for the receipt, which is the same
hang you are trying to diagnose.

### Recovery 2 — clear the stale hash, then resume

```bash
python - <<'PY'
import json
p = 'contracts/broadcast/DeployPool.s.sol/5042002/run-latest.json'
d = json.load(open(p))
stale = set(d['pending'])
print('clearing', stale)
d['pending'] = []
for t in d['transactions']:
    if t.get('hash') in stale:
        t['hash'] = None
json.dump(d, open(p, 'w'), indent=2)
PY
```

Then re-run the `--resume` command above. Measured: it sent the missing transaction and the final state
was **byte-identical to the control run**.

> Only ever null a hash you have just confirmed does **not** exist on chain. Clearing the hash of a
> transaction that later confirms would send the same CREATE2 twice; the second one reverts inside the
> deterministic deployer, which is loud rather than dangerous, but it costs gas and burns a nonce.

### Recovery 3 — hand-send the remaining CREATE2 calls

The fallback that needs no forge state at all. Every entry in the broadcast file is a plain call to
`0x4e59b448…` whose calldata is exactly `salt ++ initcode`:

```bash
python - <<'PY'
import json
d = json.load(open('contracts/broadcast/DeployPool.s.sol/5042002/run-latest.json'))
t = [x for x in d['transactions'] if x['contractName'].startswith('ArcpadLocker')][0]
print('to  ', t['transaction']['to'])          # must be 0x4e59b448…
print('salt', t['transaction']['input'][:66])
open('/tmp/locker.hex', 'w').write(t['transaction']['input'])
PY

cast send 0x4e59b44847b379578588920cA78FbF26c0B4956C "$(cat /tmp/locker.hex)" \
  --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --gas-limit 3000000
```

Measured in the rehearsal: `status 1`, `gasUsed 1,616,996`, and the resulting address and every wiring
**identical to the control run**. Then do C4 by hand.

> This works because a **CREATE2 address is the initcode-hash preimage**. The address commits to the
> bytes, so replaying the same calldata can only ever produce the same contract at the same address, or
> revert. Constructor arguments do not weaken this — they are part of the initcode.

### Recovery 4 — re-mine

If the hook's bytecode genuinely moved (a solc bump, a v4-core update, a `compilation_restrictions`
change), the pinned salt no longer reproduces the pinned address and C2 refuses with
`HookSaltIsNotThePinnedOne`. That is a **source change plus a review**, not a runbook step: re-run
`PredictPool`, update the four pins in `contracts/script/PoolDeployLib.sol`, and get it reviewed.

**Re-mining stays available for the whole of §C** — a hook that is on chain but has never been named in a
`PoolKey` can simply be abandoned. It stops being available at **Task 8's first pool initialisation**,
because from that moment the address is published in every pool's key.

## C8. Cost, and the one number to check first

Measured gas for the three transactions: **5,254,202 + 2,006,224 + 1,616,996 = 8,877,422**. At the 25 gwei
observed on Arc that is about **0.222 USDC**; `forge`'s own up-front estimate, which applies a 2× fee
buffer and rounds up, prints roughly `0.025` of the native asset. Arc's block gas limit is 30M, so the
5.25M `PoolManager` deployment fits with room to spare.

Hold **at least 1 USDC** on the deployer before starting. Nothing in `DeployPool` will tell you if you do
not, and running out between transaction 2 and transaction 3 puts you in C6.

## C9. What is not recoverable

- **A hook bound to the wrong factory or the wrong escrow.** Both are immutable constructor arguments and
  both are baked into the address. `_beforeInitialize` `STATICCALL`s the factory on every pool creation,
  so a codeless or wrong factory means no pool can ever be opened through that hook. The C2 anchors exist
  for exactly this, and they exist because a **semantically neutral reorder of four constructor
  assignments** in `LaunchFactory` once moved the factory address while leaving the hook's salt and
  address untouched — with the gate green and 607/607 passing.
- **A hook address that already appears in a live `PoolKey`.** After Task 8 there is no re-mining.
- **`PoolManager` ownership.** It is set in the constructor from the profile's governor and is part of
  the initcode, so a wrong owner means a different address entirely.
