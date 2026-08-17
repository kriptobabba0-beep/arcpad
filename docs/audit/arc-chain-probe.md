# Arc chain probe — is the target chain `5042` or `5042002`?

**Measured 2026-08-01.** Phase 2, Task 0. Every number below came from a command
that is named next to it; nothing here is quoted from documentation.

Two parallel investigations disagreed, and neither had closed:

- A preparation audit reported that Uniswap Labs deployed v2+v3+v4 to chain
  **`5042`** on 26–27 May 2026.
- A separate investigation measured that Arc's entire documentation corpus
  (1,263,917 bytes of `llms-full.txt`) contains **only `5042002`**, 42 times,
  and no other chain id — and rated the third-party `5042` claim unverifiable.

**This task was designed not to settle that disagreement, but to prove Phase 2
does not depend on the answer.** That proof is the deliverable; the measurement
below is the supporting evidence.

## Verdict: **Outcome A**

No reachable host returns `5042`. The claim is **unverified at the RPC layer**.
Phase 2 deploys its own `PoolManager` to Arc testnet. **No `src/` change follows
from this, and none of the three possible outcomes would have produced one.**

## The probe

`contracts/script/ProbeArcChain.s.sol`, re-runnable with:

```bash
forge script ProbeArcChain --root contracts -vvv
```

It uses `vm.rpc(url, method, params)` and **not** `vm.createSelectFork`. A fork
runs in local revm and hides the remote client's own answer — the lesson Phase 0
recorded when `test_nativeTransferToZeroAddressReverts` had to bypass the fork to
observe Arc's real revert. Every call here goes straight to the remote host.

### The positive controls are the point

Phase 0's fork test made exactly one mistake worth not repeating: a `vm.rpc`
wrapped in `try/catch` read a 429 as an "expected revert". So a host reporting
`0x` at the four canonical V4 addresses means nothing on its own — it is equally
consistent with the probe being rate-limited, DNS-poisoned, or pointed at a
host that answers nothing.

Two addresses that are **known to carry code on Arc testnet** are therefore
queried on every reachable host:

| Address | Role |
|---|---|
| `0x3600000000000000000000000000000000000000` | ERC-20 USDC view — positive control |
| `0x4e59b44847b379578588920cA78FbF26c0B4956C` | CREATE2 deterministic deployer — positive control |

If either returns empty, the run reports **"probe invalid"**, not "no V4". The
script computes this itself and `require`s it *before* printing any A/B/C
verdict, so a silently-empty run cannot be misread as a negative result.

RPC **errors** and **empty code** are counted in separate buckets for the same
reason; collapsing them is the Phase 0 defect restated.

Calls are paced at 250 ms (`vm.sleep`) because Arc rate-limits concurrent *and*
sequential `eth_call`s.

### The guard was mutation-tested, not assumed

Pointing both positive controls at empty addresses
(`0x…DeaDBeef`, `0x…DeADBEE1`) and re-running:

```
  eth_getCode 0x00000000000000000000000000000000DeaDBeef  [POZITIF KONTROL] 0
  eth_getCode 0x00000000000000000000000000000000DeADBEE1  [POZITIF KONTROL] 0
  pozitif kontroller: DUSTU -- bu hostun 0x sonuclari ANLAMSIZ (sonda gecersiz)
  === OZET ===
  cevap veren host sayisi: 2
  pozitif kontrolu GECEN host sayisi (gecerli sonda): 0
Error: script failed: SONDA GECERSIZ: hicbir host pozitif kontrolleri gecmedi; 0x sonuclari anlamsiz
```

The run aborts and **never reaches an A/B/C verdict**. The mutant is killed, and
the guard is therefore load-bearing rather than decorative. The mutation was
reverted; the file in the tree is the unmutated probe.

## Raw results — 2026-08-01

Client on both reachable hosts: `reth/v1.11.3-d6324d6/x86_64-unknown-linux-gnu`.

| Host | `eth_chainId` | `eth_blockNumber` | Probe valid? |
|---|---|---|---|
| `https://rpc.testnet.arc.io` | **5042002** (`0x4cef52`) | 54757386 | yes — both controls carry code |
| `https://rpc.testnet.arc.network` | **5042002** (`0x4cef52`) | 54757395 | yes — both controls carry code |
| `https://rpc.mainnet.arc.io` | no answer | — | n/a |
| `https://rpc.arc.io` | no answer | — | n/a |
| `https://rpc.mainnet.arc.network` | no answer | — | n/a |
| `https://arc.rpc.circle.com` | no answer | — | n/a |
| `https://rpc.arc.network` | no answer | — | n/a |

The five non-answering hosts were classified separately with `curl`, because
"no answer" from the cheatcode does not say *why*:

```
rpc.mainnet.arc.io           http=403 exitcode=0     # Cloudflare challenge page, not an RPC endpoint
rpc.arc.io                   http=000 exitcode=6     # DNS: could not resolve host
rpc.mainnet.arc.network      http=000 exitcode=6     # DNS: could not resolve host
arc.rpc.circle.com           http=000 exitcode=6     # DNS: could not resolve host
rpc.arc.network              http=000 exitcode=6     # DNS: could not resolve host
```

Only `rpc.mainnet.arc.io` exists as a name at all, and it serves an HTML
Cloudflare 403 rather than JSON-RPC. **Arc mainnet does not answer as a chain.**

### Code at the four canonical V4 `PoolManager` addresses

Identical on both reachable hosts — all four empty, on a run whose positive
controls returned 1798 and 69 bytes respectively:

| Address | Chain it is canonical on | Code length on 5042002 |
|---|---|---|
| `0x000000000004444c5dc75cB358380D2e3dE08A90` | Ethereum mainnet | 0 |
| `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32` | Arbitrum / X Layer / Ink / Soneium | 0 |
| `0x1F98400000000000000000000000000000000004` | Unichain | 0 |
| `0x498581fF718922c3f8e6A244956aF099B2652b2b` | Base | 0 |

This independently re-confirms the claim already written into
`src/LaunchFactory.sol`'s D3 rationale: **Uniswap V4 is nowhere on Arc.**

## No chain-id-dependent branch exists

```bash
grep -rn "5042" contracts/src/ packages/ indexer/src/ keeper/src/
```

- **`contracts/src/`** — one hit, and it is a **doc comment**, not a branch:
  `LaunchFactory.sol:728`, inside the D3 rationale, prose reading "…the four
  canonical `PoolManager` addresses are codeless on chain 5042002". No
  executable statement in `contracts/src/` reads, compares, or branches on a
  chain id. The brief predicted "zero hits"; the accurate statement is **zero
  code hits, one comment hit**, which satisfies the property the brief was
  actually testing.
- **`indexer/src/`, `keeper/src/`** — zero hits.
- **`packages/shared/src/chain.ts:3`** — `export const ARC_TESTNET_CHAIN_ID =
  5042002`, with a guard that rejects anything else. This confirms what the
  preparation audit recorded. **Recorded as a finding and deferred to Phase 3;
  it is deliberately not fixed here**, because the frontend's network selection
  depends on no decision made in this phase, and `packages/` is another track's
  file ownership.

## Why all three outcomes were inert

The contract-side design already assumes it must deploy and later *replace* its
own pool target. `LaunchFactory`'s two-step `graduationTarget` governance (D3,
"one-shot latch would be incompatible with development") exists precisely so the
destination can move. Consequently:

- **A** (measured) — deploy our own `PoolManager`. No code change.
- **B** — a canonical V4 exists on `5042`; add a second network entry to Task 7's
  address book. No *contract* change.
- **C** — chain exists, V4 does not; deploy our own `PoolManager`. No code change.

The address of the `PoolManager` is an **injected constructor parameter** of
`ArcpadHook`, never a constant, so the same hook bytecode runs against whatever
deployment is canonical later. That is what makes the chain id inert here.

## Reconciling the two claims

`5042` was not observed on any host that answers. `5042002` was returned by both
hosts that answer, and matches the value already embedded in
`packages/shared/src/chain.ts`, in `foundry.toml`'s comment, and in the live
deployment's own fork test. **`5042002` is the target chain id for Arc testnet.**

This does not disprove `5042` — a chain can exist without a public RPC under any
of the seven names tried, and the host list was fixed by the brief and not
expanded. The honest statement is: **`5042` is unverified, `5042002` is
measured**, and Phase 2 is correct under either.
