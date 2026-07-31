# Runbook — arcpad governance ceremony (Arc testnet, chain 5042002)

**This file is written to be executed at 2 a.m. by someone who did not write it.** Every command is
copy-pasteable. Nothing here is derived at run time; if a value is missing, stop rather than invent one.

The deploy section (Task 6) is **not** in this file yet.

---

## 0. What exists, and why you cannot route around it

| | Address | Notes |
|---|---|---|
| Governor Safe | `0x970534698e4592932F31892759147f79EB0D2C22` | 2-of-3, SafeL2 v1.4.1 |
| Treasury Safe | `0xebBeCfDA308EA307e173C6eC19a9C48F53d4B10c` | 2-of-3, same owner set (testnet only) |
| Owners | `0x0a95f5F562183089f661577bc6B63D7A829cec88`<br>`0x0D646a725DAdc8ADcF209ac999B219EF2a69ad21`<br>`0xf5447724A9BEa99635c0456049169eaCa84EE65B` | **listed in ascending order — this order matters, see §3** |

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

## 4. Assemble the bundle — ordered by owner address, ascending

Concatenate the 65-byte signatures with **no separator and no repeated `0x`**, sorted by the *signing owner's
address*, ascending:

```
0x0a95f5F5…   <-- first
0x0D646a72…   <-- second
0xf5447724…   <-- third
```

So a bundle signed by owners 1 and 2 is `<sig-of-0x0a95><sig-of-0x0D64 without its 0x>`.

```bash
BUNDLE="${SIG_A}${SIG_B:2}"
```

---

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
