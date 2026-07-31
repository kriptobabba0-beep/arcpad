# Runbook — arcpad deploy and governance ceremony (Arc testnet, chain 5042002)

**This file is written to be executed at 2 a.m. by someone who did not write it.** Every command is
copy-pasteable. Nothing here is derived at run time; if a value is missing, stop rather than invent one.

Two procedures live here: **§A the governance ceremony** (signing a Safe transaction) and **§B the deploy**
(putting `FeeEscrow` and `LaunchFactory` on chain). They are independent; do the one you came for.

---

## §A — The governance ceremony

## 0. What exists, and why you cannot route around it

| | Address | Notes |
|---|---|---|
| Governor Safe | `0x970534698e4592932F31892759147f79EB0D2C22` | 2-of-3, SafeL2 v1.4.1 |
| Treasury Safe | `0xebBeCfDA308EA307e173C6eC19a9C48F53d4B10c` | 2-of-3, same owner set (testnet only) |
| Owners, **declared order** | `0x0a95f5F562183089f661577bc6B63D7A829cec88`<br>`0xf5447724A9BEa99635c0456049169eaCa84EE65B`<br>`0x0D646a725DAdc8ADcF209ac999B219EF2a69ad21` | This is the order in `expected-governance.json` and the order `getOwners()` returns. **It is NOT ascending, and it must NEVER be re-sorted** — it sits inside the Safe initializer, so changing it changes the Safe addresses and therefore the factory address. |
| Owners, **ascending signing order** | `0x0a95f5F5…`<br>`0x0D646a72…`<br>`0xf5447724…` | A signature *bundle* must be in **this** order. It is a different order from the one above, and that is the trap. **You do not have to produce it by hand — see §4.** |

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

## 1. Before you start

```bash
cp .env.example .env          # then fill ARC_RPC_URL
cast chain-id --rpc-url "$ARC_RPC_URL"     # must print 5042002
```

Each owner needs their key in a keystore on their own machine:

```bash
cast wallet import arcpad-owner --interactive
```

---

## 2. Build the transaction and print its Safe hash

No signatures are needed for this step, and it broadcasts nothing.

**To point the curve at a pool (Phase 2):**

```bash
forge script script/Governance.s.sol:Governance \
  --sig "encodeProposeTarget(address,address)" <FACTORY> <TARGET> \
  --root contracts --rpc-url "$ARC_RPC_URL"
```

**To rotate the protocol treasury:**

```bash
forge script script/Governance.s.sol:Governance \
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

## 3. Each owner signs, independently, on their own machine

```bash
cast wallet sign --no-hash <SAFE_TX_HASH> --account arcpad-owner
```

`--no-hash` is **required**. Without it `cast` applies the `\x19Ethereum Signed Message:\n32` prefix and
produces a signature Safe will attribute to the wrong address, which surfaces as `GS026` — a confusing
failure with a correct-looking signature.

Each signature is 65 bytes (132 hex characters after `0x`). You need **2 of 3**.

---

## 4. Assemble the bundle — let the tool sort it

**Do not sort by hand.** `assembleBundle` recovers the signer from each signature, checks it really is an
owner, rejects duplicates, and sorts ascending for you:

```bash
forge script script/Governance.s.sol:Governance   --sig "executeFromGovernorSorted(address,bytes,bytes[])"   <FACTORY> <INNER_CALLDATA> "[<SIG_A>,<SIG_B>]"   --root contracts --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --broadcast
```

The signatures may be given in **any** order. If one of them was not produced by an owner you get
`NotAnOwner(<recovered address>)` — which names the problem, instead of Safe's `GS026`, which has three
possible causes and cannot tell you which one you hit.

If you must assemble it manually anyway, concatenate the 65-byte signatures with no separator and no repeated
`0x`, sorted by the **signing owner's address ascending** (§0, second owner row):

```bash
BUNDLE="${SIG_A}${SIG_B:2}"
```

## 5. Execute

```bash
forge script script/Governance.s.sol:Governance \
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

## 6. The two failures you will actually hit, and how to tell them apart

Both were **reproduced against the live governor Safe** during the Task 4 rehearsal, so these are measured,
not quoted from documentation.

| Code | Means | Fix |
|---|---|---|
| **`GS020`** | Signature data too short — fewer signatures than the threshold | You have 1 of 2. Get the second owner's signature. |
| **`GS026`** | Invalid owner provided — or the right owners in the **wrong order** | Sort the bundle by owner address ascending (§4). Also check `--no-hash` was used (§3) and that the nonce has not moved (§2). |

Verbatim, one signature against a threshold of 2:

```
execution reverted: GS020
```

Verbatim, both signatures in descending order:

```
execution reverted: GS026
```

---

## 7. Confirm it took effect

Never trust the transaction receipt alone; read the state back.

```bash
cast call <FACTORY> "protocolTreasury()(address)" --rpc-url "$ARC_RPC_URL"
cast call <FACTORY> "graduationTarget()(address)"  --rpc-url "$ARC_RPC_URL"
cast call <GOVERNOR_SAFE> "nonce()(uint256)"       --rpc-url "$ARC_RPC_URL"   # must have advanced by 1
```

---

## 8. The rehearsal that proved this procedure works

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

## 9. Mainnet gates — do not carry these testnet choices forward

- **The two Safes share one owner set on testnet. On mainnet they must not.** Governor is authority and
  treasury is revenue; a shared owner set means one compromise takes both.
- At least one owner key must be on offline hardware.
- Arc has published no mainnet chain id, and `Profiles.sol` deliberately does not register one.
  `nameForChain` reverts `UnregisteredChain` for everything except 5042002 and 31337, so a mainnet deploy
  requires a reviewed commit that adds it — which is the review that would notice a wrong profile.

---

# §B — The deploy (Task 6)

Puts `FeeEscrow` and `LaunchFactory` on chain at their **reserved, already-computed** addresses. Read §0
first: the governor Safe must exist before this runs, because it is a constructor argument.

## B1. The addresses this will produce, and why they are already known

| | Address |
|---|---|
| `FeeEscrow` | `0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6` |
| `LaunchFactory` | `0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439` |

Both are CREATE2 through the canonical deterministic deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`,
so they are fixed before any transaction is sent. Re-derive them yourself if you want:

```bash
cast create2 --deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C \
  --salt <SALT> --init-code-hash <INITCODE_HASH>
```

The escrow address is **chain-independent** (no constructor arguments). The factory address is **not**: it
commits to `(escrow, treasury, governor, T, V, S)`, so changing any Safe address or any profile number
changes it.

## B2. Dry run — this asserts everything and deploys nothing

```bash
forge script script/Deploy.s.sol:Deploy --sig "plan()" \
  --root contracts --rpc-url "$ARC_RPC_URL" --sender <DEPLOYER_ADDRESS>
```

`plan()` is `view`. There is no `vm.broadcast` on that path; it cannot send a transaction.

It must print `chainId 5042002`, `PROFILE testnet`, `V 4292000000000000000`, both initcode hashes, and the
two addresses in B1. **Compare them against B1 by eye before continuing.** Then it runs, before printing:

- chain → profile, and the profile digest (`ProfileDigestMismatch` if `profiles.toml` was edited alone)
- the governance digest (`GovernanceDigestMismatch` if `expected-governance.json` was edited alone)
- the initcode ↔ plan pre-flight (`InitcodeDoesNotEncodeThePlan(<field>)`)
- the CREATE2 deployer's **codehash** (`Create2DeployerNotCanonical`)
- both Safes probed live as ≥2-of-3 (`NotAMultisig`, `MultisigThresholdTooLow`, `MultisigTooFewOwners`)
- deployer balance ≥ 0.5 USDC (`InsufficientDeployerBalance`)
- both target addresses unoccupied (`AlreadyDeployed`)

If any of those fires, **stop and read the error name** — every one of them is specific.

## B3. Broadcast

```bash
forge script script/Deploy.s.sol:Deploy --sig "run()" \
  --root contracts --rpc-url "$ARC_RPC_URL" --account arcpad-deployer --broadcast
```

`run()` re-runs every assertion from B2 through the **same** `_resolve()` — there is no path that skips
them — then sends two transactions to `0x4e59b448…`, then reads the deployed factory back and compares its
immutables against the plan (`ProfileNotAsDeployed`, `GovernanceNotAsDeployed`).

`forge script` simulates the whole script before sending, so a failed read-back aborts with nothing
broadcast.

> **A second run reverts `AlreadyDeployed("FeeEscrow", …)` rather than minting a second universe.** That is
> the intended behaviour, not a problem. If you see it, the deploy already happened — go to B4.

## B4. Verify on chain — do not trust the script's read-back

```bash
cast code 0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6 --rpc-url "$ARC_RPC_URL" | head -c 20
cast code 0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439 --rpc-url "$ARC_RPC_URL" | head -c 20

F=0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439
cast call $F "escrow()(address)"                 --rpc-url "$ARC_RPC_URL"   # 0xEEd4431e…
cast call $F "governor()(address)"               --rpc-url "$ARC_RPC_URL"   # 0x97053469…
cast call $F "protocolTreasury()(address)"       --rpc-url "$ARC_RPC_URL"   # 0xebBeCfDA…
cast call $F "VIRTUAL_TOKEN_RESERVES()(uint256)" --rpc-url "$ARC_RPC_URL"   # 1073000000000000000000000000
cast call $F "VIRTUAL_QUOTE_RESERVES()(uint256)" --rpc-url "$ARC_RPC_URL"   # 4292000000000000000
cast call $F "SALE_SUPPLY()(uint256)"            --rpc-url "$ARC_RPC_URL"   # 793100000000000000000000000
cast call $F "graduationTarget()(address)"       --rpc-url "$ARC_RPC_URL"   # 0x0 — nothing set yet
cast call $F "launchCount()(uint256)"            --rpc-url "$ARC_RPC_URL"   # 0
```

`V` is the one to look at twice: `4292000000000000000` is **4292e15**, the testnet magnitude.
`4292000000000000000000` would be production — 1000× — and every guard in the contract accepts it.

## B5. Write the address book

```bash
pnpm addressbook --chain 5042002
```

It reads the broadcast receipt plus live `eth_call`s, re-derives both addresses from their initcode hashes,
and refuses to write a book its own loader would reject. It prints the `NEXT_PUBLIC_*` / `ARC_*` block for
`.env`.

`--smoke-token` is required for `totalSupply`, which is read off a token the deployment actually minted
rather than copied from a constant — so B5 comes after Task 7's smoke launch, not before it.

## B6. If something is wrong after broadcast

There is no upgrade path and no admin key. The factory is immutable except for `protocolTreasury` and
`graduationTarget`, both governor-only:

- **wrong treasury** → recoverable: `setProtocolTreasury` via §A, and it reaches live curves because
  `BondingCurve` reads `protocolTreasury()` at deposit time.
- **wrong profile numbers, wrong governor, or wrong escrow** → **not recoverable.** They are immutable and
  address-committing. The only remedy is a new salt and abandoning these addresses. This is why B2 exists and
  why the read-back in B3 is not optional.
