# arcpad Phase 1d — Deploy to Arc Testnet

> **For agent implementers:** MANDATORY SUB-SKILL: use `superpowers:subagent-driven-development` to execute this
> plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** put the frozen contract set on Arc testnet, publicly, with an address book that the indexer, the keeper
and the frontend consume from configuration — so that when Arc mainnet opens, going live is a reviewed edit to
data plus one broadcast, not a build.

**Architecture:** two deployments and one governance topology. `FeeEscrow` (no constructor arguments, therefore
the same address on every chain that uses the same salt) and `LaunchFactory` (six constructor arguments, three of
which differ per chain, therefore a chain-specific address). Both go out through the canonical deterministic
CREATE2 deployer at `0x4e59b44847b379578588920cA78FbF26c0B4956C`, called explicitly by address rather than through
`new C{salt:}`, so that an in-EVM rehearsal and a live broadcast produce **the same address by construction**.
Above them sit two Gnosis Safes — one governor, one treasury — both created from Safe v1.4.1 singletons that are
already deployed on Arc testnet.

**Tech stack:** Solidity 0.8.26, EVM `cancun`, `via_ir`, `optimizer_runs = 800`, Foundry `v1.6.0-rc1`.
Chain: Arc L1 testnet, chain id `5042002`, native gas asset USDC (18-decimal native view).

---

## Out of scope for this phase

**No contract in `contracts/src/` changes. Not one byte.** `LaunchFactory` embeds
`type(BondingCurve).creationCode` and `type(LaunchToken).creationCode`, so any edit to either moves every curve
address, every token address and the factory's own address. Everything this phase needs lives in
`contracts/script/`, `contracts/deploy/`, `contracts/test/fork/`, the TypeScript packages and CI. If a task
appears to require a `src/` change, that is a finding to escalate, not a change to make.

**Arc mainnet.** Circle has published no mainnet chain id, no RPC and no predeploy addresses. This plan registers
the *production* profile and leaves its chain id deliberately unregistered, so that a mainnet deploy is impossible
until someone adds the chain id in a reviewed commit. That is the intended friction.

**Phase 2's graduation target.** No `graduationTarget` is proposed or applied in this phase. See §"What is
deliberately not deployed" below — this is a decision with a reason, not an omission.

**Phase 3's indexer and Phase 4's frontend.** This phase produces the address book those plans already expect and
nothing more.

---

## Global Constraints

Implicitly part of every task's requirements.

### Toolchain and gates

- Solidity `0.8.26`, `evm_version = "cancun"`, `via_ir = true`, `optimizer_runs = 800`, `bytecode_hash = "none"`.
- `forge fmt --check --root contracts` must be clean. **It covers `script/`** — the new files are formatted the
  same way `src/` is.
- `make lint` and `make slither` must stay clean. Note `contracts/slither.config.json` sets
  `filter_paths = "lib/,test/,script/"`, so **Slither will not analyse the deploy script at all**. That is
  defensible (nothing in `script/` is deployed) but it means the script's only automated defence is its own tests
  and mutants. Do not read a clean Slither run as coverage of `script/`.
- `contracts/foundry.toml` may be modified in exactly one way: adding `{ access = "read", path = "./deploy" }` to
  the `fs_permissions` list of **both** `[profile.default]` and `[profile.ci]`. See Task 1 Step 3 for why both,
  and for the executable gate that proves the existing `./out` entry survived.
- Tests must be green in **both** profiles — but see "Wall clock" below for when each profile runs.

### Wall clock — verification is fast by construction

Nearly all wall clock on this project goes to mutation matrices; each mutant re-runs a suite at roughly 100
seconds, so a 50-mutant matrix over the whole suite costs more than an hour. Phase 1d is designed so that most
verification never touches the curve arithmetic.

- **Every task names the suites its test step runs and why that set is sufficient.** A narrow run is exactly how
  a false "this passed" appears, so the scoping is written down and reviewable rather than assumed.
- **The `ci` profile (`FOUNDRY_PROFILE=ci`, 5000 fuzz runs, 1000 invariant runs) is reserved for the final green
  run of the phase**, in Task 8. 256 fuzz runs distinguish broken from working; 5000 exist to find rare
  counterexamples in code already believed correct. Iterating at 5000 buys nothing and costs everything.
- **Mutants are run against the narrowest suite that can see them**, and each mutant row in this plan names that
  suite. A mutant on `Profiles.sol` is scored against `test/script/Profiles.t.sol` alone — roughly 2 seconds per
  mutant instead of 100.
- **The dry run does the work.** `forge script --sig "plan()"` costs seconds, prints every transaction it would
  send, every derived address and the profile it resolved, and asserts everything assertable. The live run's job
  is to **confirm what the dry run predicted**, not to discover it.

**What the dry run cannot see, in full — the honest list is short:**

1. **The chain's actual id.** Without `--rpc-url` the script runs at chain id `31337`. With `--rpc-url` forge
   takes the id from the endpoint, so the id *is* real in a dry run against Arc — but a dry run against a local
   node is not. Task 2 Step 6 closes this by refusing to broadcast on an id the resolver did not register.
2. **Real gas.** Foundry's estimate is an estimate; Arc's fee market is live (measured today: base fee 20 gwei,
   priority 5 gwei, `eth_gasPrice` 25 gwei, block gas limit 30,000,000).
3. **Arc's runtime blocklist.** A `revm` fork does not enforce it; only the live chain does.
4. **EIP-7708 `Transfer` logs.** Every native USDC movement emits an 18-decimal `Transfer` from the system
   emitter. A local EVM does not produce them, so log-shape assertions are only meaningful live.

### Measured chain facts (all probed today, 2026-07-30, against `https://rpc.testnet.arc.io`)

| Fact | Method | Value |
|---|---|---|
| Chain id | `eth_chainId` | `0x4cef52` = **5042002** |
| Deterministic CREATE2 deployer | `eth_getCode 0x4e59b44847b379578588920cA78FbF26c0B4956C` | **69 bytes**, canonical Arachnid deployer |
| USDC 6-decimal ERC-20 view | `eth_getCode 0x3600…0000` | present (proxy) |
| Multicall3 | `eth_getCode 0xcA11bde05977b3631167028862bE2a173976CA11` | 3,808 bytes |
| Permit2 | `eth_getCode 0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 bytes |
| Safe 1.4.1 singleton | `eth_getCode 0x41675C099F32341bf84BFc5382aF534df5C7461a` | 23,579 bytes |
| SafeL2 1.4.1 singleton | `eth_getCode 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | 24,421 bytes |
| SafeProxyFactory 1.4.1 | `eth_getCode 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | 3,054 bytes |
| CompatibilityFallbackHandler 1.4.1 | `eth_getCode 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | 5,637 bytes |
| MultiSendCallOnly 1.4.1 | `eth_getCode 0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | 410 bytes |
| Explorer | `https://testnet.arcscan.app/api/v2/config/backend-version` | **Blockscout v11.2.3** |
| Explorer verifier | `/api/v2/smart-contracts/verification/config` | Rust microservice enabled; **`v0.8.26+commit.8a97fa7a` present** in 1,657 offered compilers |
| Explorer Etherscan-compat API | `GET /api?module=contract&action=getsourcecode&address=0x3600…` | HTTP 200, returns verified sources |
| Latest block | `eth_getBlockByNumber` | `0x33f3d70`, `gasLimit 0x1c9c380` = 30,000,000, `baseFeePerGas 0x4a817c800` = 20 gwei |

### The two profiles — exact values, each re-derived independently for this plan

```
N (LAUNCH_TOKEN_TOTAL_SUPPLY) = 1_000_000_000e18 = 1000000000000000000000000000
T (virtualTokenReserves)      = 1_073_000_000e18 = 1073000000000000000000000000   (both profiles)
S (saleSupply)                =   793_100_000e18 =  793100000000000000000000000   (both profiles)
V (virtualQuoteReserves)      testnet    = 4_292e15 =              4292000000000000000
                              production = 4_292e18 =           4292000000000000000000
```

Derived, recomputed here rather than transcribed (Python, exact integers, same floors as `CurveMath`):

```
D  = floor(S(T-S)/T)      = 206886011183597390493942218
S + D                     = 999986011183597390493942218   == LaunchFactory.MIN_SALE_AND_SEED   ✔
R_testnet = floor(V·S/(T-S)) =         12161433369060378706   == LaunchFactory.MIN_GRADUATION_RAISE ✔
R_prod                       =      12161433369060378706680
R_prod − 1000·R_testnet      =                          680   (two floors at two scales, not a clean 1000×)
M_testnet = floor(V·N/T)     =          4000000000000000000   == LaunchFactory.MIN_OPENING_MARKET_CAP ✔
M_prod                       =       4000000000000000000000
```

**Both floors that involve `V` sit exactly on the testnet profile's own score.** That is the fail-open this
phase exists to close: the testnet profile passes all seven constructor guards on any chain, and a binary search
in the hardening pass put the lowest deployable `V` at *exactly* the testnet `V`, 1000× below production with
zero margin.

Profile digests, `keccak256(abi.encode(T, V, S))`, computed here and to be re-derived by the implementer:

```
testnet    0xa67f784bd45f49baa48601d390ecafdb2fe44aadffd974b4b0bd582c10d6600d
production 0x7def5669fd9a5fd109bf35f1d1b04c651e124b6f0f22c37ced26fb77880a80e3
```

### Salts — derived, not chosen

```
FeeEscrow      keccak256("arcpad.FeeEscrow.v1")     = 0xc86ad978a80671d39d91fd5b65d5b29cc34a84fb29664012ce6de14effefa718
LaunchFactory  keccak256("arcpad.LaunchFactory.v1") = 0xbe555c18d58e8926d5c280a3e9cbc89e2f14c6032e597b69644113c7092390e4
```

### Smoke-sequence arithmetic, computed here so the live run confirms rather than discovers

At the **testnet** profile, from a fresh curve:

```
buyExactTokensOut(S)  cost (net into reserves) = floor(V·S/(T-S)) + 1 = 12161433369060378707   (= R_testnet + 1)
  protocolFee = ceil(cost·95/10000)            =   115533617006073598
  creatorFee  = ceil(cost·30/10000)            =    36484300107181137
  GROSS to buy the entire sale supply           = 12313451286173633442  ≈ 12.313451 USDC
buyExactQuoteIn(1e18) on a fresh curve:
  corrected net                                =   987654320987654320
  tokensOut                                    = 200723953120761740526324105  ≈ 200,723,953.12 tokens
```

So one curve completes for ≈ **12.32 USDC** of testnet gas asset. Circle's faucet gives 10 USDC per request, so
the whole phase — deploy plus a full smoke — needs **two to three faucet requests**. Estimated deploy cost at the
measured 25 gwei: `FeeEscrow` ≈ 0.0047 USDC, `LaunchFactory` ≈ 0.073 USDC (≈2.90M gas: 200 × 13,748 bytes of code
deposit, EIP-3860 initcode words, plus a constructor that runs seven guards and one external `try`).

### Rules carried from Phase 1c that this phase must not break

- **`fs_permissions` is conditional.** forge `1.6.0-rc1` grants an implicit read of the artifacts directory
  **only while `fs_permissions` is undefined**. The existing `{read, ./out}` entry exists precisely so that the
  first entry added for another purpose cannot silently remove that grant. Read the comment in
  `contracts/foundry.toml:22-40` before touching the key. A profile that declares its own list **replaces**
  `default`'s wholesale, which is why `[profile.ci]` repeats it.
- **A test that passes for a reason nobody wrote down is a defect.** Four named failure modes to design against:
  a property covered on one entrypoint reading as covered on all of them (eleven instances so far, eight inside
  code written to close a previous one); the gap being in mutant *selection* rather than coverage (three
  instances); a test that passes for an unwritten reason (four instances); and a property test whose reach was
  assumed rather than measured.
- **Every claimed measurement is re-derived by the implementer, never transcribed from this plan.** Every literal
  above was computed for this document; if one is wrong, the re-derivation is what catches it.

---

## The four decisions this phase takes

### D-1 — CREATE2, through the canonical deployer, called explicitly by address

**Ruling: CREATE2 for both `FeeEscrow` and `LaunchFactory`, via `0x4e59b44847b379578588920cA78FbF26c0B4956C`,
invoked as a raw `call(salt ++ initcode)` rather than through Solidity's `new C{salt:}`.**

**First, a correction to the rationale this decision inherited, and it is the important half.** The recorded
argument for CREATE2 was that it "gives the same factory address on testnet and mainnet, because the address is a
function of the factory's bytecode." **That is false for this factory, and it is false for an unavoidable
reason.** The CREATE2 address is `keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode ++ abi.encode(args)))`,
and `LaunchFactory`'s constructor takes six arguments of which **`virtualQuoteReserves` differs by exactly 1000×
between testnet and production**, and of which `governor` and `protocolTreasury` are chain-specific Safes. The
initcode hash therefore differs, so the factory address differs. No deployment mechanism can make it otherwise
while the profile is a constructor argument — and the profile *must* be a constructor argument, because that was
Task 2's ruling and it is baked into frozen bytecode. **Anyone planning around "one factory address on both
chains" is planning around something that cannot exist.** This costs nothing and requires no contract change; it
only removes a stated benefit from the ledger.

`FeeEscrow` is the exception that proves the rule: it has **no constructor** (verified — zero `constructor`
occurrences in `contracts/src/FeeEscrow.sol`), so its initcode is the creation code alone and its CREATE2 address
**is** identical on every chain that uses the same salt and the same compiler settings. That is a genuine
cross-chain invariant and Task 2 asserts it.

CREATE2 is still right, for four reasons that survive the correction:

1. **Reproducibility against operator state.** With plain `CREATE` the address is `keccak(rlp(deployer, nonce))`.
   The nonce is mutable state on the live chain: a failed transaction, a wallet's automatic approval, a second
   machine, or a key rotation all move it. The address book would then depend on a number nobody reviewed. With
   CREATE2 the address is a function of the repository's contents and the salt, both of which are in git.
2. **A double broadcast fails loudly.** The Arachnid deployer reverts when `CREATE2` returns zero, which is
   exactly the already-occupied case. Re-running `Deploy.s.sol` against a chain that already has the deployment
   **reverts**. Under `CREATE` it would silently mint a *second* factory at a *new* address, a second escrow, and
   a second address universe — and whichever `.env` was edited last would win. This is the single most valuable
   property here, because re-running a deploy script is the most common operational mistake there is.
3. **The address book is reviewable before it exists.** `plan()` prints the factory and escrow addresses, and
   `LaunchFactory.predictAddresses` then makes every future curve and token address computable from them. Under
   `CREATE` none of that can be printed until after the broadcast.
4. **Mainnet becomes a data edit.** The mainnet factory address will differ (see the correction), but the
   *procedure* is byte-identical: same salts, same script, same assertions, different profile and different
   Safes. That is what "the switch is configuration rather than a build" means concretely.

**Why the raw call rather than `new C{salt:}`.** Inside `forge script --broadcast`, `new C{salt:}` is routed
through the deterministic deployer; inside `forge test` it compiles to a `CREATE2` opcode executed by the *calling
contract*. The two produce **different addresses**, so an in-EVM rehearsal of the script would verify an address
the live run will never produce. Calling `CREATE2_FACTORY` explicitly makes both worlds identical, at the cost of
one `vm.etch` in the test fixture (the deployer's 69 bytes, pinned in Task 2).

**Two consequences to write on the wall.**

- The **initial** `protocolTreasury` and the `governor` are inputs to the factory's address. `protocolTreasury` is
  rotatable afterwards, but its value *at deploy* is address-committing all the same. Both Safes must exist before
  the factory address can be computed. That ordering is why Task 5 comes before Task 7.
- Constructor arguments must be recorded verbatim for verification. Blockscout needs them ABI-encoded, and a
  wrong recording makes verification fail in a way that looks like a bytecode mismatch.

### D-2 — The chain↔profile assertion: three pieces, each doing one job

The hazard, restated exactly: a factory deployed with the testnet profile passes all seven constructor guards on
any chain. Two of the three degeneracy floors are calibrated at the testnet profile's own score, so they have
**zero margin** against a 1000× error. Nothing on the contract side can catch it and nothing should — the testnet
profile has to stay deployable, because Circle's faucet gives 10 USDC and nothing graduates at 12,161 USDC, so
graduation code would otherwise be untestable. `contracts/script/` was empty, so there was no home for a check.

**The assertion is three separate pieces, because one piece cannot do it:**

| Piece | Lives in | Catches |
|---|---|---|
| chain id → profile **name** | Solidity, `script/Profiles.sol`, a `pure` function of `block.chainid` with no parameters and no environment override | deploying the wrong *kind* of profile to a chain |
| profile name → **digest** `keccak256(abi.encode(T,V,S))` | Solidity, `script/Profiles.sol`, one constant per profile | a one-character edit to the numbers, e.g. `e18`→`e15` — **this is the piece that closes the fail-open** |
| profile name → **numbers** | data, `contracts/deploy/profiles.toml`, shared with TypeScript | drift between the chain-side and client-side definitions of the same profile |

**Why the split is load-bearing.** If the chain→name binding also lived in the TOML, an operator editing one data
file could deploy production numbers to a testnet chain without a code review — the check would be bypassable by
the very mechanism it is supposed to constrain. If the numbers lived in Solidity too, the TypeScript side would
have to duplicate them and could drift. And the chain→name binding **alone does not close the fail-open**: it
binds a chain to a *name*, and the name says nothing about magnitude — a slipped `V` in the testnet row still
resolves to "testnet" and still deploys. The digest is what turns a name into a value.

**Why it cannot be silently bypassed:**

- `Profiles.forChain` takes `block.chainid` and returns the profile. **There is no parameter, no `--profile`
  flag, and no `vm.envOr` fallback.** A caller cannot pass a profile in.
- `Deploy.run()` and `Deploy.plan()` both go through one private `_resolve()`. `run()` cannot broadcast without
  the assertions having run, because the plan struct it broadcasts is the one `_resolve()` returned.
- **The production chain id is deliberately unregistered.** `nameForChain` today maps `5042002` → `testnet` and
  `31337` → `testnet` (local rehearsal) and reverts `UnregisteredChain(chainId)` for everything else. Mainnet
  therefore requires a reviewed commit that adds a chain id — which is precisely the review that would notice a
  wrong profile.
- After the broadcast, the script **reads the profile back off the deployed factory** (`VIRTUAL_TOKEN_RESERVES`,
  `VIRTUAL_QUOTE_RESERVES`, `SALE_SUPPLY`) and compares against the resolved profile. This catches the one class
  the compile-time pieces cannot: an argument-order slip between the resolver and the constructor call. The
  constructor's order is `(escrow, treasury, governor, T, V, S)` — **T before V**, which the ledger already
  records as "a mistake that compiles."
- The same read-back is asserted **permanently**, on every CI run, by the fork test in Task 8 — so the check does
  not expire the moment the deploy transaction is mined.

### D-3 — The governor is a Safe, and the deploy script refuses to accept anything else

**Ruling:**

- **Governor:** a Gnosis Safe v1.4.1, **threshold ≥ 2**, at least 3 owners, on distinct hardware. Not an EOA.
  The `Deploy` script probes `getThreshold()` and `getOwners()` on the governor address and **reverts** if the
  call fails or the threshold is below 2. An EOA has no such members, so an EOA governor is not merely
  discouraged, it is undeployable. This is a script check, not a contract change — the frozen `LaunchFactory`
  keeps its deliberate permissiveness (an EOA governor is legitimate for a bare `BondingCurve` and for tests).
- **Treasury:** a **second, separate** Safe, same check, same threshold. Separate because the governor is
  *authority* and the treasury is *revenue*, and one compromise should not be both. Same check is applied even
  though `protocolTreasury` is rotatable, because it receives 0.95% of all volume and rotation does **not** move
  accrued `owed[old]`.
- **Deployer key:** an encrypted Foundry keystore account (`cast wallet import arcpad-deployer --interactive`),
  used with `--account`. Never in `argv`, never in an environment variable. **After the deploy it holds zero
  authority in the system** — it owns nothing, it is not the governor, it is not the treasury, and under CREATE2
  it does not even determine an address. Task 3 asserts this rather than stating it: the deployer address appears
  in no privileged slot of the deployed factory.

**This is available, measured, not hoped for.** The full Safe v1.4.1 deployment is live on Arc testnet: singleton
`0x41675C…` (23,579 bytes), `SafeL2` `0x29fcB4…` (24,421), proxy factory `0x4e1DCf…` (3,054),
`CompatibilityFallbackHandler` `0xfd0732…` (5,637), `MultiSendCallOnly` `0x9641d7…` (410). All probed today.

**The two facts a risk disclosure has to state in these words:**

1. **Governor key loss is unrecoverable.** `governor` is `immutable` and there is no `setGovernor`. Losing the
   Safe permanently freezes both levers: no graduation target can ever be set — so **no curve can ever graduate**
   — and the treasury can never be rotated. The recovery story is entirely off-chain, inside the Safe, which is
   exactly why the Safe's owners must not share a failure domain.
2. **A compromised governor can take the entire raise of every already-completed curve.** Propose a
   governor-controlled target, wait three days, apply, then `graduate()` each completed curve into it. Because
   `graduate()` resolves the target *at call time*, this reaches curves that completed long before the proposal
   existed. The only defence is the public draining pending graduations inside the window — which is D-4, and
   which **has no referent in Phase 1d**, because no target is set. See §"What is deliberately not deployed".

### D-4 — The 3-day window gets a rota, not a document

`GRADUATION_TARGET_DELAY = 3 days`, and the applicable window is `[eta, eta + 3 days]` — an armed proposal now
expires rather than staying armed forever. The watcher is specified in Task 6, and its scope is honest about the
phase it runs in:

- **What it watches:** `GraduationTargetProposed(address indexed target, uint256 eta)` and
  `GraduationTargetChanged(address indexed previous, address indexed current)` on the factory, plus
  `ProtocolTreasuryChanged`, plus the two pending storage slots read every poll (an event can be missed; a slot
  cannot lie). Also `Completed` on every known curve, because the set of completed curves *is* the set at risk.
- **What it does:** classifies every proposal against an in-repo allowlist of expected targets
  (`deploy/expected-governance.json`, committed and reviewed). An expected proposal is logged. An **unexpected**
  proposal, or any `GraduationTargetChanged` whose `current` is not on the allowlist, is a **page**. It also
  computes and prints the exposure — the number of completed-but-ungraduated curves and the sum of their
  `realQuoteReserves` — so the page carries the amount at risk, not just the fact.
- **Who is paged:** the two Safe signers on the on-call rota, via the alert sink configured in
  `KEEPER_ALERT_WEBHOOK`; the rota, the escalation path and the two response runbooks (`disarm` = governor
  re-proposes the correct target, which resets the clock; `drain` = graduate at-risk curves to the *current*
  target) are written into `docs/runbooks/graduation-window.md` as part of Task 6, not as a follow-up.
- **How the watcher itself is tested — this is the part that usually rots.** Three layers, and the third is the
  one that matters: (a) unit tests over a synthetic log stream, including a proposal, an expected apply, an
  unexpected apply, and a missed-event gap that the slot read must cover; (b) a **liveness canary** — the watcher
  emits a heartbeat every poll and the alerting treats *absence of heartbeat* for two intervals as a page, so a
  dead watcher is louder than a quiet chain; (c) a **scheduled live drill**, run in CI weekly against Arc
  testnet, that proposes a target from the governor Safe to a burn address, asserts the watcher paged within one
  poll interval, and then lets the proposal expire unapplied. A monitor that has never fired in anger is a
  monitor nobody knows is broken.

---

## Corrections to inherited statements

Two statements this phase inherits are wrong, and both are cheap to correct now and expensive later.

**C-1 — "CREATE2 gives the same factory address on testnet and mainnet" is false.** See D-1. The constructor
arguments differ; the address differs. `FeeEscrow`'s address *is* chain-independent, and that is the only member
of the address book for which the claim holds.

**C-2 — "Phase 2 moves every curve and token address" is stale, and it changes what may be announced.**
`docs/plans/2026-07-30-arcpad-phase4-frontend.md:2164` says the address book must stay empty because Phase 2's
graduation surface will change `BondingCurve`'s creation code. **That surface already landed** — `graduate()`,
`graduated`, the `Graduated` event and the five errors are in `BondingCurve` at commit `04a450f`, merged into
`0bae7e3`, which is the frozen bytecode this phase deploys. Phase 2 builds the *target* — an external locker and
hook that `graduationTarget` points at — and by design (D2) the curve reads the destination at `graduate()` time
and stores nothing. **Therefore Phase 1d's addresses survive Phase 2 and are permanent for the life of the
protocol on testnet, and may be published as such.** That is the whole point of the byte-identity work, and it is
what makes this phase publicly announceable. Task 8 corrects the sentence in the Phase 4 plan.

---

## File structure

| File | Responsibility |
|---|---|
| `contracts/deploy/profiles.toml` | **new** — the two profiles as data: `T`, `V`, `S` per profile name. Read by the deploy script and by TypeScript. |
| `contracts/deploy/expected-governance.json` | **new** — the reviewed allowlist of governor, treasury and permitted graduation targets per chain id. The watcher's ground truth. |
| `contracts/deploy/addresses.5042002.json` | **new**, written in Task 7 — the address book: factory, escrow, governor, treasury, deploy block, deploy tx. Committed. |
| `contracts/script/Profiles.sol` | **new** — chain id → profile name (`pure`), name → digest, name → numbers (TOML). The chain↔profile assertion. |
| `contracts/script/DeployLib.sol` | **new** — pure planning: salts, initcode, CREATE2 prediction, the `Plan` struct, the Safe probe. No broadcasting. |
| `contracts/script/Deploy.s.sol` | **new** — `plan()` (dry run, asserts, prints) and `run()` (same assertions, then broadcast, then read-back). |
| `contracts/script/Governance.s.sol` | **new** — create the two Safes; build, hash, sign and execute `proposeGraduationTarget` / `applyGraduationTarget` / `setProtocolTreasury` Safe transactions. |
| `contracts/script/Smoke.s.sol` | **new** — the live sequence: launch, buy, sell, clamped completing buy. |
| `contracts/test/script/Profiles.t.sol` | **new** — the chain↔profile assertion's own suite, incl. the `fs_permissions` no-widening gate. |
| `contracts/test/script/Deploy.t.sol` | **new** — the whole script rehearsed in-EVM against an etched CREATE2 deployer. |
| `contracts/test/fork/ArcpadDeployment.fork.t.sol` | **new** — reads the committed address book and asserts the live deployment: CREATE2 identity against this tree, live `isCanonical` reject paths, profile read-back, governance members. |
| `contracts/test/fork/ArcpadSmoke.fork.t.sol` | **new** — re-asserts the completed smoke curve's terminal state on every CI run. |
| `contracts/test/fork/Governance.fork.t.sol` | **new** — the Safe deployment set, the two Safes' thresholds, and the CREATE2/predeploy dependencies, as a permanent gate. |
| `contracts/deploy/addresses.schema.json`, `contracts/deploy/testdata/{addresses.31337.json,slipped-testnet.toml}` | **new** — the book's documented shape and the two negative/positive fixtures. |
| `contracts/foundry.toml` | **modify** — one `fs_permissions` entry per profile, `{read, ./deploy}`. |
| `packages/shared/src/profiles.ts` | **new** — reads `deploy/profiles.toml`, recomputes the digest, exports `CurveProfile`. One source of truth across languages. |
| `packages/shared/src/addresses.ts` | **new** — loads `deploy/addresses.<chainId>.json`, validates it, exports `Deployment`. |
| `scripts/addressbook.ts` | **new** — generates `deploy/addresses.<chainId>.json` from the broadcast receipt plus on-chain reads. Keeps `fs_permissions` read-only. |
| `keeper/src/watch/graduationWindow.ts` | **new** — the D-4 watcher. |
| `keeper/src/alert.ts` | **new** — the page sink plus heartbeat. |
| `docs/runbooks/graduation-window.md` | **new** — rota, escalation, `disarm` and `drain` runbooks. |
| `docs/runbooks/deploy.md` | **new** — the deploy runbook, including the Safe ceremony and the verification commands. |
| `.env.example` | **modify** — the address-book and governance variables the downstream plans already name. |
| `.github/workflows/contracts.yml` | **modify** — the fork job gains the deployment assertions; a new non-blocking-at-step-level live drill job. |

---

### Task 1: The profile as data, and the chain↔profile assertion that cannot be bypassed

This is decision **D-2** made executable, and it is deliberately first: nothing may deploy until the thing that
decides *what* gets deployed is under test.

**Files:**
- Create: `contracts/deploy/profiles.toml`
- Create: `contracts/deploy/testdata/slipped-testnet.toml`
- Create: `contracts/script/Profiles.sol`
- Create: `contracts/test/script/Profiles.t.sol`
- Modify: `contracts/foundry.toml` (one `fs_permissions` entry, both profiles)

**Interfaces:**
- Consumes: `forge-std/Vm.sol` only. **No `src/` import** — this file must not be able to move a contract address.
- Produces:
  - `struct Profile { string name; uint256 virtualTokenReserves; uint256 virtualQuoteReserves; uint256 saleSupply; }`
  - `Profiles.nameForChain(uint256 chainId) → string` (`pure`)
  - `Profiles.chainKeyFor(uint256 chainId) → string` (`pure`) — `"arc-testnet"` / `"local-rehearsal"`
  - `Profiles.digestFor(string name) → bytes32` (`pure`)
  - `Profiles.readFrom(string tomlPath, string name) → Profile` (`view`) — the mechanism
  - `Profiles.forChain(uint256 chainId) → Profile` (`view`) — the policy
  - Errors: `UnregisteredChain(uint256)`, `UnknownProfileName(string)`,
    `ProfileDigestMismatch(string name, bytes32 expected, bytes32 actual)`

- [ ] **Step 1: The data file**

`contracts/deploy/profiles.toml`:

```toml
# arcpad curve profiles -- spec SS5.3.
#
# THE NUMBERS LIVE HERE. The chain -> profile-name binding does NOT, and must
# never move into this file: if it did, an operator editing one data file could
# put production numbers on a testnet chain without a code review, which is the
# exact bypass the assertion exists to prevent. The binding is in
# script/Profiles.sol, compiled and mutation-tested.
#
# Values are decimal STRINGS, not TOML integers. TOML integers are i64
# (max 9_223_372_036_854_775_807) and T = 1.073e27 does not fit.
#
# keccak256(abi.encode(T, V, S)) is pinned per profile in script/Profiles.sol.
# An edit here that is not matched there fails the deploy with
# ProfileDigestMismatch, naming both digests.

[profiles.testnet]
# T = 1_073_000_000e18
virtualTokenReserves = "1073000000000000000000000000"
# V = 4_292e15. THIS IS THE ONLY FIELD THAT DIFFERS BETWEEN THE TWO PROFILES,
# and it differs by exactly 1000x. Both of LaunchFactory's V-dependent floors
# sit exactly on this value, so nothing on the contract side can catch a slip
# here -- only the digest can.
virtualQuoteReserves = "4292000000000000000"
# S = 793_100_000e18
saleSupply = "793100000000000000000000000"

[profiles.production]
virtualTokenReserves = "1073000000000000000000000000"
# V = 4_292e18
virtualQuoteReserves = "4292000000000000000000"
saleSupply = "793100000000000000000000000"
```

`contracts/deploy/testdata/slipped-testnet.toml` — the negative fixture, committed so a reader can see the exact
typo being caught. It is the testnet profile carrying production's `V`, i.e. the H3 slip verbatim:

```toml
# NOT A DEPLOYABLE PROFILE. Fixture for test_aSlippedExponentIsRejectedByTheDigest.
# Every one of LaunchFactory's seven guards accepts this triple. Only the digest
# does not.
[profiles.testnet]
virtualTokenReserves = "1073000000000000000000000000"
virtualQuoteReserves = "4292000000000000000000"
saleSupply = "793100000000000000000000000"
```

- [ ] **Step 2: `contracts/script/Profiles.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";

/// @notice Bir curve profili: ekonomiyi belirleyen ucu ve adi.
struct Profile {
    string name;
    uint256 virtualTokenReserves; // T
    uint256 virtualQuoteReserves; // V
    uint256 saleSupply;           // S
}

/// @title Profiles
/// @notice ZINCIR -> PROFIL bagi. Bu depodaki TEK fail-open degeri kapatan sey.
///
/// @dev SORUN. `LaunchFactory`in yedi korumasindan ikisi
///      (`MIN_OPENING_MARKET_CAP`, `MIN_GRADUATION_RAISE`) TESTNET profilinin
///      kendi degeri uzerine oturur. Yani testnet profili HER zincirde yediden
///      de gecer: olculdu, deploy edilebilir en kucuk `V` TAM OLARAK testnet
///      `V`sidir -- uretimin 1000 kati altinda, sifir paylik. Kontrat tarafinda
///      buna koruma konamaz ve konmamalidir: testnet profili ZORUNLUDUR (Circle
///      faucet'i istek basina 10 USDC verir; 12.161 USDC'lik uretim esiginde
///      graduation kodu hic test edilemezdi). Kontrol bu yuzden BURADA.
///
/// @dev UC PARCA, HER BIRI TEK BIR IS:
///        (1) zincir -> profil ADI   -- BURADA, `pure`, PARAMETRESIZ.
///        (2) profil adi -> DIGEST   -- BURADA, profil basina bir sabit.
///        (3) profil adi -> SAYILAR  -- `deploy/profiles.toml`, VERI.
///      (1) TEK BASINA YETMEZ: zinciri bir ADA baglar, ad ise BUYUKLUKTEN hic
///      soz etmez -- testnet satirinda kaymis bir `V` yine "testnet" diye
///      cozulur ve yine deploy olur. FAIL-OPEN'I KAPATAN PARCA (2)'DIR.
///      (3)'un veri olmasi TypeScript tarafiyla TEK KAYNAK paylasmak icindir.
///
/// @dev BAGI VERIYE TASIMAK YASAKTIR. `[chains.5042002].profile = "..."` gibi
///      bir satir, kontrolun engellemek icin var oldugu islemi -- bir veri
///      dosyasi duzenleyip baska bir profil deploy etmeyi -- MUMKUN kilardi.
///
/// @dev URETIM ZINCIR ID'SI BILEREK KAYITSIZDIR. Circle hicbir mainnet chain id
///      yayinlamadi; ucuncu taraflarin andigi `5042` dogrulanamadi ve Arc'in
///      kendi dokumaninda GECMEZ. `nameForChain(5042)` BUGUN revert eder ve
///      etmelidir: mainnet deploy'u chain id'yi ekleyen INCELENMIS bir commit
///      gerektirir -- yani yanlis profili farkedecek olan incelemeyi.
library Profiles {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant TESTNET = "testnet";
    string internal constant PRODUCTION = "production";

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    uint256 internal constant LOCAL_REHEARSAL_CHAIN_ID = 31337;

    /// @dev keccak256(abi.encode(T, V, S)). ELLE TURETILDI. Dosyadan okunan
    ///      ucluyu hash'leyip buraya karsilastiran bir test TOTOLOJIDIR; sabit
    ///      ELLE YAZILMIS literallere pinlenir (bkz.
    ///      test_digestIsTheHashOfTheHandWrittenTriple).
    ///        T = 1_073_000_000e18, V = 4_292e15, S = 793_100_000e18
    bytes32 internal constant TESTNET_DIGEST = 0xa67f784bd45f49baa48601d390ecafdb2fe44aadffd974b4b0bd582c10d6600d;
    ///        T = 1_073_000_000e18, V = 4_292e18, S = 793_100_000e18
    bytes32 internal constant PRODUCTION_DIGEST = 0x7def5669fd9a5fd109bf35f1d1b04c651e124b6f0f22c37ced26fb77880a80e3;

    string internal constant PROFILES_PATH = "deploy/profiles.toml";

    error UnregisteredChain(uint256 chainId);
    error UnknownProfileName(string name);
    error ProfileDigestMismatch(string name, bytes32 expected, bytes32 actual);

    /// @notice Bu zincire hangi profil aittir.
    /// @dev PARAMETRESIZ VE `pure`. Cagiran bir profil GECIREMEZ; "sessizce
    ///      atlanamaz" ozelligi tam olarak budur.
    function nameForChain(uint256 chainId) internal pure returns (string memory) {
        if (chainId == ARC_TESTNET_CHAIN_ID) return TESTNET;
        if (chainId == LOCAL_REHEARSAL_CHAIN_ID) return TESTNET;
        revert UnregisteredChain(chainId);
    }

    /// @notice Bu zincirin governance kaydindaki anahtari.
    /// @dev Profil adiyla AYNI DEGILDIR: iki zincir de "testnet" profilini
    ///      kullanir ama AYRI governance adresleri tasir.
    function chainKeyFor(uint256 chainId) internal pure returns (string memory) {
        if (chainId == ARC_TESTNET_CHAIN_ID) return "arc-testnet";
        if (chainId == LOCAL_REHEARSAL_CHAIN_ID) return "local-rehearsal";
        revert UnregisteredChain(chainId);
    }

    function digestFor(string memory name) internal pure returns (bytes32) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256(bytes(TESTNET))) return TESTNET_DIGEST;
        if (h == keccak256(bytes(PRODUCTION))) return PRODUCTION_DIGEST;
        revert UnknownProfileName(name);
    }

    /// @notice MEKANIZMA: verilen dosyadan verilen profili okur ve digest'ler.
    /// @dev Politikadan AYRI DURUR, cunku negatif testin GERCEK bir bozuk
    ///      dosyayi yurumesi gerekir.
    function readFrom(string memory tomlPath, string memory name) internal view returns (Profile memory p) {
        string memory toml = vm.readFile(tomlPath);
        p.name = name;
        p.virtualTokenReserves = _num(toml, name, "virtualTokenReserves");
        p.virtualQuoteReserves = _num(toml, name, "virtualQuoteReserves");
        p.saleSupply = _num(toml, name, "saleSupply");

        bytes32 expected = digestFor(name);
        bytes32 actual = keccak256(abi.encode(p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply));
        if (actual != expected) revert ProfileDigestMismatch(name, expected, actual);
    }

    /// @notice POLITIKA: bu zincire ait profil.
    function forChain(uint256 chainId) internal view returns (Profile memory) {
        return readFrom(PROFILES_PATH, nameForChain(chainId));
    }

    /// @dev Ondalik STRING olarak okunur; TOML tamsayilari i64'tur ve
    ///      T = 1.073e27 SIGMAZ.
    function _num(string memory toml, string memory name, string memory key) private pure returns (uint256) {
        return vm.parseUint(vm.parseTomlString(toml, string.concat(".profiles.", name, ".", key)));
    }
}
```

- [ ] **Step 3: `foundry.toml` — one entry per profile, and the reason it must be per profile**

Change **only** these two lines, and extend the existing comment rather than replacing it:

```toml
# [profile.default]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read", path = "./deploy" }]

# [profile.ci]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read", path = "./deploy" }]
```

Append to the existing comment block, in its voice:

```
# FAZ 1D EKI. `./deploy` girisi deploy script'inin profil dosyasini okumasi
# icindir. `./out` AYNEN KALIR ve kalmasi ZORUNLUDUR: yukaridaki olcum,
# `fs_permissions` bir kez tanimlandiginda ortuk artifact izninin kalktigini
# soyluyor. `./out`u default'tan dusurmek Surface.t.sol'u GURULTULU bicimde
# kirar; ama YALNIZCA [profile.ci]'den dusurmek sadece CI'da kirar -- liste
# MIRAS DEGIL, DEGISTIRME semantigiyle calisir. Iki liste de kendi kendine
# yeterli tutulur ve test/script/Profiles.t.sol UCUNU birden olcer: `out/`
# okunabilir, `deploy/` okunabilir, `src/` HALA REDDEDILIR. Ucuncusu, iznin
# GENISLEMEDIGINI olcen tek iddiadir.
```

**The rule, written down so nobody re-derives it:** the grant is *replace*, not *merge*. A profile that declares
its own list discards `default`'s entirely, so adding an entry to only one profile is a silent, profile-specific
removal of the other.

- [ ] **Step 4: `contracts/test/script/Profiles.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Profile, Profiles} from "../../script/Profiles.sol";

contract ProfilesTest is Test {
    // ELLE YAZILDI; dosyadan OKUNMAZ. Zincir: TOML <- sabit <- bu literaller.
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V_TESTNET = 4_292e15;
    uint256 internal constant V_PRODUCTION = 4_292e18;
    uint256 internal constant S = 793_100_000e18;

    function test_arcTestnetResolvesToTheTestnetProfile() public view {
        Profile memory p = Profiles.forChain(5042002);
        assertEq(p.name, "testnet");
        assertEq(p.virtualTokenReserves, 1_073_000_000_000_000_000_000_000_000);
        assertEq(p.virtualQuoteReserves, 4_292_000_000_000_000_000);
        assertEq(p.saleSupply, 793_100_000_000_000_000_000_000_000);
    }

    function test_localRehearsalResolvesToTheSameNumbersAsArcTestnet() public view {
        Profile memory a = Profiles.forChain(5042002);
        Profile memory b = Profiles.forChain(31337);
        assertEq(a.virtualQuoteReserves, b.virtualQuoteReserves);
        assertEq(keccak256(bytes(a.name)), keccak256(bytes(b.name)));
    }

    /// ULASIM OLCULDU, VARSAYILMADI: yakin ikizler TEK TEK yurunur. `5042`
    /// ucuncu taraflarin andigi mainnet id'sidir ve BUGUN REVERT ETMELIDIR --
    /// mainnet deploy'unu incelenmis bir commit'e baglayan satir budur.
    function test_everyNearMissChainIdReverts() public {
        uint256[9] memory ids = [uint256(0), 1, 5042, 5042001, 5042003, 8453, 31338, 42161, type(uint256).max];
        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(Profiles.UnregisteredChain.selector, ids[i]));
            this.nameFor(ids[i]);
        }
    }

    function testFuzz_onlyTheTwoRegisteredChainIdsResolve(uint256 chainId) public {
        vm.assume(chainId != 5042002 && chainId != 31337);
        vm.expectRevert(abi.encodeWithSelector(Profiles.UnregisteredChain.selector, chainId));
        this.nameFor(chainId);
    }

    /// URETIM PROFILI KAYITLI AMA HICBIR ZINCIRDEN ULASILAMAZ.
    function test_noChainIdResolvesToTheProductionProfile() public pure {
        assertEq(Profiles.digestFor("production"), Profiles.PRODUCTION_DIGEST);
        uint256[2] memory registered = [uint256(5042002), 31337];
        for (uint256 i = 0; i < registered.length; ++i) {
            assertTrue(
                keccak256(bytes(Profiles.nameForChain(registered[i]))) != keccak256("production"),
                "a registered chain resolved to the production profile"
            );
        }
    }

    /// TOTOLOJI KIRICI: digest dosyadan degil ELLE YAZILMIS ucluden turetilir.
    function test_digestIsTheHashOfTheHandWrittenTriple() public pure {
        assertEq(keccak256(abi.encode(T, V_TESTNET, S)), Profiles.TESTNET_DIGEST);
        assertEq(keccak256(abi.encode(T, V_PRODUCTION, S)), Profiles.PRODUCTION_DIGEST);
    }

    /// Digest'in AYIRDIGI SEY tam olarak korktugumuz hatadir.
    function test_theDigestSeparatesTheTwoMagnitudes() public pure {
        assertTrue(Profiles.TESTNET_DIGEST != Profiles.PRODUCTION_DIGEST);
        assertEq(V_PRODUCTION / V_TESTNET, 1000);
    }

    /// H3'un TA KENDISI, gercek bir dosyayla yurunur.
    function test_aSlippedExponentIsRejectedByTheDigest() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                Profiles.ProfileDigestMismatch.selector,
                "testnet",
                Profiles.TESTNET_DIGEST,
                keccak256(abi.encode(T, V_PRODUCTION, S))
            )
        );
        this.readFrom("deploy/testdata/slipped-testnet.toml", "testnet");
    }

    // --- fs_permissions kapisi: UC IDDIA, ucuncusu GENISLEME icin ---

    function test_theArtifactGrantSurvived() public view {
        assertGt(
            bytes(vm.readFile("out/FeeEscrow.sol/FeeEscrow.json")).length,
            0,
            "./out grant lost -- Surface.t.sol is the next thing to fall"
        );
    }

    function test_theDeployGrantExists() public view {
        assertGt(bytes(vm.readFile("deploy/profiles.toml")).length, 0, "./deploy grant missing");
    }

    function test_theGrantDidNotWiden() public {
        (bool ok,) = address(this).staticcall(abi.encodeCall(this.readSrc, ()));
        assertFalse(ok, "src/ became readable -- fs_permissions widened beyond {out, deploy}");
    }

    // Revert'i yakalayabilmek icin cagrilar DISARIDAN gider.
    function nameFor(uint256 chainId) external pure returns (string memory) {
        return Profiles.nameForChain(chainId);
    }

    function readFrom(string calldata p, string calldata n) external view returns (Profile memory) {
        return Profiles.readFrom(p, n);
    }

    function readSrc() external view returns (string memory) {
        return vm.readFile("src/FeeEscrow.sol");
    }
}
```

- [ ] **Step 5: Mutate — scored against `test/script/Profiles.t.sol` alone**

Roughly two seconds per mutant, not a hundred: this file imports nothing from `src/`.

| # | Mutant | Must die on |
|---|---|---|
| P1 | `nameForChain`: `5042002` → `5042003` | `test_arcTestnetResolvesToTheTestnetProfile` (+ the near-miss sweep at `5042003`) |
| P2 | `nameForChain`: add `if (chainId == 5042) return PRODUCTION;` | `test_everyNearMissChainIdReverts` and `testFuzz_onlyTheTwoRegisteredChainIdsResolve` |
| P3 | `readFrom`: delete the digest comparison | `test_aSlippedExponentIsRejectedByTheDigest` **only** — pin the count |
| P4 | `digestFor`: return `TESTNET_DIGEST` for both names | `test_digestIsTheHashOfTheHandWrittenTriple` |
| P5 | `TESTNET_DIGEST` ← `PRODUCTION_DIGEST`'s value | `test_digestIsTheHashOfTheHandWrittenTriple` + `test_theDigestSeparatesTheTwoMagnitudes` |
| P6 | `_num`: hard-code `".profiles.production."` | `test_arcTestnetResolves…` via digest mismatch |
| P7 | `_num` call sites: transpose the `virtualTokenReserves` / `virtualQuoteReserves` keys | **measure and record which tests redden.** The point is that the digest covers field *order*, not only values |
| P8 | `foundry.toml` default: drop `{read, ./out}` | `test_theArtifactGrantSurvived` **and** all of `Surface.t.sol` |
| P9 | `foundry.toml` **ci only**: drop `{read, ./out}` | `test_theArtifactGrantSurvived` under `FOUNDRY_PROFILE=ci` and **nothing** under `default` — the replace-not-merge trap, and the sole reason any mutant here is scored under both profiles |
| P10 | `foundry.toml`: add `{read, ./src}` | `test_theGrantDidNotWiden` only |
| P11 | `forChain`: pass `PRODUCTION` instead of `nameForChain(chainId)` | `test_arcTestnetResolves…` on the `V` literal |

Report the reddened-test **count** per mutant, not just "killed". P3 and P10 must each be sole; if either reddens
more than one test, name which and why.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(script): bind the curve profile to the chain, and pin its numbers with a digest"
```

**Deliverable:** `forge test --root contracts --match-path 'test/script/Profiles.t.sol' -vv` green (11 tests), and
`--match-path 'test/Surface.t.sol'` still green.
**Suites run, and why that set is sufficient:** exactly those two. `Profiles.sol` has no consumer yet and imports
nothing from `src/`, so no `src/` behaviour can have changed; the only other file in the repository whose
behaviour depends on `fs_permissions` is `Surface.t.sol`, which is run for exactly that reason. The `ci` profile
is invoked once, for mutant P9 alone, because P9 is the only finding that is profile-specific by construction.

---

### Task 2: The deploy script, and a dry run that proves what it would do

**Files:**
- Create: `contracts/script/DeployLib.sol`
- Create: `contracts/script/Deploy.s.sol`
- Create: `contracts/deploy/expected-governance.json`
- Create: `contracts/test/script/Deploy.t.sol`

**Interfaces:**
- Consumes: `Profiles`, `FeeEscrow`, `LaunchFactory`, `forge-std/Script.sol`.
- Produces:
  - `struct Plan { uint256 chainId; Profile profile; address deployer; address governor; address treasury; bytes32 escrowSalt; bytes32 factorySalt; bytes escrowInitcode; bytes factoryInitcode; address escrow; address factory; }`
  - `DeployLib.predict(bytes32 salt, bytes initcode) → address` (`pure`)
  - `DeployLib.build(uint256, Profile, address deployer, address governor, address treasury) → Plan` (`pure`)
  - `DeployLib.assertDeployable(Plan)` (`view`)
  - `DeployLib.deploy(bytes32 salt, bytes initcode) → address`
  - `DeployLib.assertAsDeployed(Plan)` (`view`)
  - `Deploy.plan() → Plan` — the dry run: asserts and prints, deploys nothing
  - `Deploy.run() → Plan` — the same assertions, then broadcast, then read-back

- [ ] **Step 1: `deploy/expected-governance.json`**

```json
{
  "arc-testnet": {
    "governor": "0x0000000000000000000000000000000000000000",
    "treasury": "0x0000000000000000000000000000000000000000",
    "owners": [],
    "allowedGraduationTargets": []
  },
  "local-rehearsal": {
    "governor": "0x0000000000000000000000000000000000000601",
    "treasury": "0x0000000000000000000000000000000000007EA5",
    "owners": [],
    "allowedGraduationTargets": []
  }
}
```

The `arc-testnet` entries stay zero until Task 4 creates the Safes. `assertDeployable`'s multisig probe makes a
zero address undeployable, so this file **cannot** be left half-filled by accident: the deploy fails
`NotAMultisig("governor", 0x0…0)` rather than proceeding with a hole. The two `local-rehearsal` addresses are
where `Deploy.t.sol` etches Safe stubs — real addresses, chosen to be legible in a trace, not magic.

- [ ] **Step 2: `contracts/script/DeployLib.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {Profile} from "./Profiles.sol";

/// @dev Safe'in yalnizca yoklamanin ihtiyac duydugu iki uyesi.
interface ISafeProbe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

struct Plan {
    uint256 chainId;
    Profile profile;
    address deployer;
    address governor;
    address treasury;
    bytes32 escrowSalt;
    bytes32 factorySalt;
    bytes escrowInitcode;
    bytes factoryInitcode;
    address escrow;
    address factory;
}

library DeployLib {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Kanonik deterministik deployer. Arc testnet'te OLCULDU: 69 bayt.
    address internal constant CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant CREATE2_FACTORY_CODE_LENGTH = 69;

    /// @dev Salt'lar SECILMEZ, TURETILIR.
    ///      keccak256("arcpad.FeeEscrow.v1")
    ///        = 0xc86ad978a80671d39d91fd5b65d5b29cc34a84fb29664012ce6de14effefa718
    ///      keccak256("arcpad.LaunchFactory.v1")
    ///        = 0xbe555c18d58e8926d5c280a3e9cbc89e2f14c6032e597b69644113c7092390e4
    bytes32 internal constant ESCROW_SALT = keccak256("arcpad.FeeEscrow.v1");
    bytes32 internal constant FACTORY_SALT = keccak256("arcpad.LaunchFactory.v1");

    uint256 internal constant MIN_SAFE_THRESHOLD = 2;
    uint256 internal constant MIN_SAFE_OWNERS = 3;

    /// @dev Tahmini deploy maliyetinin 5 kati. TURETME: olculen 25 gwei'de
    ///      escrow ~189k + factory ~2,90M ~= 3,1M gaz = 0,0775 USDC; 5 kati
    ///      0,39; yukari yuvarlanmis hali 0,5 USDC. SECILMEDI, olculen bir
    ///      buyuklukten okundu.
    uint256 internal constant MIN_DEPLOYER_BALANCE = 0.5e18;

    error Create2DeployerMissing(address expected, uint256 codeLength);
    error NotAMultisig(string role, address account);
    error MultisigThresholdTooLow(string role, address account, uint256 threshold);
    error MultisigTooFewOwners(string role, address account, uint256 owners);
    error AlreadyDeployed(string what, address at);
    error Create2Failed(bytes32 salt);
    error InsufficientDeployerBalance(address deployer, uint256 have, uint256 need);
    error ProfileNotAsDeployed(string field, uint256 expected, uint256 actual);
    error GovernanceNotAsDeployed(string field, address expected, address actual);

    function predict(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, keccak256(initcode)))))
        );
    }

    /// @dev ARGUMAN SIRASI: (escrow, treasury, governor, T, V, S).
    ///      **T, V'DEN ONCE GELIR.** Faz 1c'nin kayda gecirdigi "derlenen bir
    ///      hata": ikisi de uint256'dir, takas derleyiciden gecer. BUGUN
    ///      fail-closed'dir -- T = 4_292e15 ile `S >= T` olur ve constructor
    ///      `DegenerateProfile()` doner (olculdu) -- ama bu KAZA ESERI
    ///      dogrudur, tasarim geregi degil, cunku baska bir profil ciftinde
    ///      takas gecerli bir profil uretebilir. Kemer: `assertAsDeployed`
    ///      deploy edilmis factory'den GERI OKUR.
    function build(uint256 chainId, Profile memory p, address deployer, address governor, address treasury)
        internal
        pure
        returns (Plan memory plan)
    {
        plan.chainId = chainId;
        plan.profile = p;
        plan.deployer = deployer;
        plan.governor = governor;
        plan.treasury = treasury;

        plan.escrowSalt = ESCROW_SALT;
        plan.factorySalt = FACTORY_SALT;

        // FeeEscrow'un CONSTRUCTOR ARGUMANI YOKTUR (olculdu: kaynakta sifir
        // `constructor` gecisi), yani initcode'u salt creation code'dur ve
        // adresi ayni salt ile HER ZINCIRDE AYNIDIR. Adres defterinin bu
        // ozelligi tasiyan TEK uyesidir; factory tasimaz, cunku argumanlarinin
        // ucu zincire ozgudur.
        plan.escrowInitcode = type(FeeEscrow).creationCode;
        plan.escrow = predict(ESCROW_SALT, plan.escrowInitcode);

        plan.factoryInitcode = abi.encodePacked(
            type(LaunchFactory).creationCode,
            abi.encode(
                plan.escrow, treasury, governor, p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply
            )
        );
        plan.factory = predict(FACTORY_SALT, plan.factoryInitcode);
    }

    function assertDeployable(Plan memory plan) internal view {
        if (CREATE2_FACTORY.code.length != CREATE2_FACTORY_CODE_LENGTH) {
            revert Create2DeployerMissing(CREATE2_FACTORY, CREATE2_FACTORY.code.length);
        }
        if (plan.deployer.balance < MIN_DEPLOYER_BALANCE) {
            revert InsufficientDeployerBalance(plan.deployer, plan.deployer.balance, MIN_DEPLOYER_BALANCE);
        }
        _assertMultisig("governor", plan.governor);
        _assertMultisig("treasury", plan.treasury);
        if (plan.escrow.code.length != 0) revert AlreadyDeployed("FeeEscrow", plan.escrow);
        if (plan.factory.code.length != 0) revert AlreadyDeployed("LaunchFactory", plan.factory);
    }

    /// @dev EOA REDDEDILIR VE SEBEBI YAPISALDIR: bir EOA'nin `getThreshold()`
    ///      uyesi yoktur, solc'un extcodesize kontrolu cagriyi revert ettirir
    ///      ve `catch` `NotAMultisig` uretir. Yani "EOA governor onerilmez"
    ///      degil, DEPLOY EDILEMEZ. Kontrat DEGISMEZ: `LaunchFactory` bilerek
    ///      musamahali kalir (ciplak bir `BondingCurve` icin ve testlerde EOA
    ///      governor mesrudur); politika deploy katmanindadir.
    function _assertMultisig(string memory role, address account) private view {
        try ISafeProbe(account).getThreshold() returns (uint256 threshold) {
            if (threshold < MIN_SAFE_THRESHOLD) revert MultisigThresholdTooLow(role, account, threshold);
        } catch {
            revert NotAMultisig(role, account);
        }
        try ISafeProbe(account).getOwners() returns (address[] memory owners) {
            if (owners.length < MIN_SAFE_OWNERS) revert MultisigTooFewOwners(role, account, owners.length);
        } catch {
            revert NotAMultisig(role, account);
        }
    }

    /// @dev `new C{salt:}` DEGIL, DEPLOYER'A ACIK CAGRI. Sebep olculebilir:
    ///      `forge test` icinde `new C{salt:}` CREATE2 opcode'unu CAGIRAN
    ///      KONTRATTA calistirir, `forge script --broadcast` ise deterministik
    ///      deployer uzerinden gonderir -- IKI FARKLI ADRES. Acik cagri ikisini
    ///      AYNI yapar; bedeli test fixture'inda tek bir `vm.etch`tir. Aksi
    ///      halde prova, canli kosunun hic uretmeyecegi bir adresi dogrulardi.
    function deploy(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initcode));
        if (!ok || ret.length != 20) revert Create2Failed(salt);
        deployed = address(bytes20(ret));
    }

    /// @dev DERLEME ZAMANI KONTROLLERININ GOREMEDIGI TEK SINIF: cozulen profil
    ///      ile constructor'a GECIRILEN degerin ayrismasi. Yanlis BUYUKLUKTEKI
    ///      bir `V` yedi korumadan da gecer (olculdu), yani onu yakalayan TEK
    ///      SATIR budur.
    function assertAsDeployed(Plan memory plan) internal view {
        LaunchFactory f = LaunchFactory(plan.factory);
        if (f.VIRTUAL_TOKEN_RESERVES() != plan.profile.virtualTokenReserves) {
            revert ProfileNotAsDeployed("T", plan.profile.virtualTokenReserves, f.VIRTUAL_TOKEN_RESERVES());
        }
        if (f.VIRTUAL_QUOTE_RESERVES() != plan.profile.virtualQuoteReserves) {
            revert ProfileNotAsDeployed("V", plan.profile.virtualQuoteReserves, f.VIRTUAL_QUOTE_RESERVES());
        }
        if (f.SALE_SUPPLY() != plan.profile.saleSupply) {
            revert ProfileNotAsDeployed("S", plan.profile.saleSupply, f.SALE_SUPPLY());
        }
        if (f.escrow() != plan.escrow) revert GovernanceNotAsDeployed("escrow", plan.escrow, f.escrow());
        if (f.governor() != plan.governor) revert GovernanceNotAsDeployed("governor", plan.governor, f.governor());
        if (f.protocolTreasury() != plan.treasury) {
            revert GovernanceNotAsDeployed("treasury", plan.treasury, f.protocolTreasury());
        }
        if (f.graduationTarget() != address(0)) {
            revert GovernanceNotAsDeployed("graduationTarget", address(0), f.graduationTarget());
        }
        if (f.launchCount() != 0) revert ProfileNotAsDeployed("launchCount", 0, f.launchCount());
    }
}
```

- [ ] **Step 3: `contracts/script/Deploy.s.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DeployLib, Plan} from "./DeployLib.sol";
import {Profile, Profiles} from "./Profiles.sol";

/// @title Deploy
/// @notice `plan()` KURU KOSU, `run()` GERCEK. Ikisi de AYNI `_resolve()`den
///         gecer; `run()`un iddialari atlayabilecegi bir yol YOKTUR, cunku
///         yayinladigi Plan tam olarak `_resolve()`in dondurdugu Plan'dir.
contract Deploy is Script {
    string internal constant GOVERNANCE_PATH = "deploy/expected-governance.json";

    function plan() public view returns (Plan memory p) {
        p = _resolve();
        _print(p, "DRY RUN -- nothing was broadcast");
    }

    function run() public returns (Plan memory p) {
        p = _resolve();
        _print(p, "BROADCASTING");

        vm.startBroadcast();
        address escrowAddr = DeployLib.deploy(p.escrowSalt, p.escrowInitcode);
        address factoryAddr = DeployLib.deploy(p.factorySalt, p.factoryInitcode);
        vm.stopBroadcast();

        require(escrowAddr == p.escrow, "escrow address diverged from the plan");
        require(factoryAddr == p.factory, "factory address diverged from the plan");

        DeployLib.assertAsDeployed(p);
        console2.log("read-back OK: the deployed factory holds the resolved profile");
    }

    function _resolve() private view returns (Plan memory p) {
        Profile memory profile = Profiles.forChain(block.chainid);
        string memory key = Profiles.chainKeyFor(block.chainid);
        string memory json = vm.readFile(GOVERNANCE_PATH);
        address governor = vm.parseJsonAddress(json, string.concat(".", key, ".governor"));
        address treasury = vm.parseJsonAddress(json, string.concat(".", key, ".treasury"));

        p = DeployLib.build(block.chainid, profile, msg.sender, governor, treasury);
        DeployLib.assertDeployable(p);
    }

    function _print(Plan memory p, string memory banner) private view {
        console2.log("=== arcpad deploy ===");
        console2.log(banner);
        console2.log("chainId             ", p.chainId);
        console2.log("PROFILE             ", p.profile.name);
        console2.log("  T                 ", p.profile.virtualTokenReserves);
        console2.log("  V                 ", p.profile.virtualQuoteReserves);
        console2.log("  S                 ", p.profile.saleSupply);
        console2.log("deployer (gas only) ", p.deployer);
        console2.log("governor (Safe)     ", p.governor);
        console2.log("treasury (Safe)     ", p.treasury);
        console2.log("escrow  salt        ", vm.toString(p.escrowSalt));
        console2.log("escrow  initcodeHash", vm.toString(keccak256(p.escrowInitcode)));
        console2.log("escrow  ADDRESS     ", p.escrow);
        console2.log("factory salt        ", vm.toString(p.factorySalt));
        console2.log("factory initcodeHash", vm.toString(keccak256(p.factoryInitcode)));
        console2.log("factory ADDRESS     ", p.factory);
        console2.log("tx 1 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ FeeEscrow initcode");
        console2.log("tx 2 -> call", DeployLib.CREATE2_FACTORY, "with salt ++ LaunchFactory initcode");
    }
}
```

> `_print` is `view` because `vm.toString` is not `pure`. If a compiler upgrade lets it be `pure`, tighten it —
> but never relax the annotation to silence an error.

- [ ] **Step 4: `contracts/test/script/Deploy.t.sol` — the whole script rehearsed in-EVM**

The fixture etches the **measured** 69-byte deployer runtime so that the rehearsal and the broadcast derive the
same address, and etches two Safe stubs at the `local-rehearsal` addresses. `setUp` asserts the etched length so
the fixture cannot rot silently.

```solidity
bytes internal constant CREATE2_DEPLOYER_RUNTIME =
    hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0"
    hex"3601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

contract SafeStub {
    uint256 private immutable _threshold;
    address[] private _owners;

    constructor(uint256 threshold_, uint256 ownerCount) {
        _threshold = threshold_;
        for (uint256 i; i < ownerCount; ++i) _owners.push(address(uint160(i + 1)));
    }

    function getThreshold() external view returns (uint256) { return _threshold; }
    function getOwners() external view returns (address[] memory) { return _owners; }
}

function setUp() public {
    vm.etch(DeployLib.CREATE2_FACTORY, CREATE2_DEPLOYER_RUNTIME);
    assertEq(DeployLib.CREATE2_FACTORY.code.length, 69, "etched deployer is not the measured 69 bytes");
    // 2-of-3 stubs at the two local-rehearsal addresses
    vm.etch(GOVERNOR, address(new SafeStub(2, 3)).code);
    vm.etch(TREASURY, address(new SafeStub(2, 3)).code);
    // SafeStub keeps its owner array in storage, so the etched copy needs the
    // slots too -- copy them explicitly and ASSERT the copy worked, because a
    // silently empty owners array would make MIN_SAFE_OWNERS vacuous.
    // (This is the vm.etch-loses-dynamic-storage trap Phase 1c hit on the
    //  metadataURI slot; it is spelled out here so it is not re-discovered.)
}
```

> **The `vm.etch` storage trap is named here on purpose.** Phase 1c's cleanup round found a live latent version of
> it: an etched twin whose `metadataURI` came back empty left a mutant alive while the loop stayed green. A
> `SafeStub` whose `_owners` array does not survive the etch would make `MIN_SAFE_OWNERS` untested in exactly the
> same way. `setUp` must assert `ISafeProbe(GOVERNOR).getOwners().length == 3` before any test runs.
> Simplest correct alternative, and the recommended one: **`vm.etch` nothing** — deploy the stubs with
> `vm.etch`-free `new SafeStub{salt:}` at deterministic addresses, or use `deployCodeTo`. Choose one, and state
> which, rather than leaving the storage question implicit.

| Test | Asserts |
|---|---|
| `test_planOnArcTestnetResolvesTheTestnetProfile` | `vm.chainId(5042002)`; `plan()` returns `name == "testnet"` and `V == 4292000000000000000` |
| `test_planRevertsOnAnUnregisteredChain` | `vm.chainId(1)` → `UnregisteredChain(1)` |
| `test_runDeploysAtExactlyThePredictedAddresses` | after `run()`, both have code, and both equal `DeployLib.predict(...)` recomputed independently inside the test |
| `test_theDeployedFactoryHoldsTheResolvedProfile` | `VIRTUAL_TOKEN_RESERVES` / `VIRTUAL_QUOTE_RESERVES` / `SALE_SUPPLY` read off the deployed factory against the three literals |
| `test_aSecondRunRevertsRatherThanMintingASecondUniverse` | the second `run()` reverts **`AlreadyDeployed("FeeEscrow", escrow)`** — the error, not merely a revert, so that deleting the pre-flight occupancy check (which would leave `Create2Failed`) still fails |
| `test_theEscrowAddressIsChainIndependent` | `build` at 5042002 and at 31337 → identical `escrow`. The one member of the book for which this holds |
| `test_theFactoryAddressMovesWithTheProfile` | testnet vs production profile, same governance → **different** `factory`. Correction **C-1** made executable |
| `test_theFactoryAddressMovesWithTheTreasury` | same profile, different treasury → different `factory`. Pins "the initial treasury is address-committing" |
| `test_anEoaGovernorCannotBeDeployed` | governance JSON pointed at an EOA → **`run()`** reverts `NotAMultisig("governor", …)`. Exercised through `run()`, not through `assertDeployable`, so a mutant that bypasses the check inside `run()` dies here |
| `test_aOneOfNSafeCannotBeDeployed` | `SafeStub(1, 3)` → `MultisigThresholdTooLow("governor", …, 1)` |
| `test_aTwoOfTwoSafeCannotBeDeployed` | `SafeStub(2, 2)` → `MultisigTooFewOwners("governor", …, 2)` |
| `test_anUnderfundedDeployerCannotDeploy` | balance `0.5e18 - 1` → `InsufficientDeployerBalance`, and `0.5e18` succeeds. Both sides of the bound |
| `test_theDeployerHoldsNoAuthorityAfterwards` | after `run()`: `governor() != deployer`, `protocolTreasury() != deployer`, and `vm.prank(deployer)` on `proposeGraduationTarget` and on `setProtocolTreasury` both revert `NotGovernor()` |
| `test_swappingTandVFailsClosedToday` | `build` with `(V, T)` transposed → `run()` reverts `LaunchFactory.DegenerateProfile()` because `S >= T` at `T = 4_292e15`. Written **because the safety is accidental**, and the test name says so |
| `test_theCreate2DeployerIsRequired` | `vm.etch(CREATE2_FACTORY, "")` → `Create2DeployerMissing(…, 0)` |
| `test_theGraduationTargetStartsUnset` | `graduationTarget() == address(0)` and `launchCount() == 0` |

- [ ] **Step 5: Mutate — scored against `test/script/Deploy.t.sol` + `test/script/Profiles.t.sol`**

| # | Mutant | Must die on |
|---|---|---|
| D1 | `build`: transpose `virtualTokenReserves` / `virtualQuoteReserves` in `abi.encode` | `test_theDeployedFactoryHoldsTheResolvedProfile` (via the constructor's `DegenerateProfile`) |
| D2 | `build`: use `type(FeeEscrow).creationCode` for the factory initcode | `test_runDeploysAtExactlyThePredictedAddresses` |
| D3 | `predict`: drop `bytes1(0xff)` | `test_runDeploysAtExactlyThePredictedAddresses` |
| D4 | `predict`: `address(this)` instead of `CREATE2_FACTORY` | same |
| D5 | `deploy`: ignore `ok` | `test_aSecondRunReverts…` |
| D6 | `deploy`: `ret.length != 20` → `ret.length > 32` | needs a witness — etch a deployer stub that returns zero bytes. If no witness exists, **record it as an equivalent mutant with the argument written out**; do not leave it unlabelled |
| D7 | `assertDeployable`: delete `_assertMultisig("governor", …)` | `test_anEoaGovernorCannotBeDeployed` |
| D8 | `_assertMultisig`: `< MIN_SAFE_THRESHOLD` → `< 1` | `test_aOneOfNSafeCannotBeDeployed` |
| D9 | `_assertMultisig`: delete the `getOwners` half | `test_aTwoOfTwoSafeCannotBeDeployed` |
| D10 | `assertDeployable`: delete the escrow occupancy check | `test_aSecondRunReverts…` **on the error name** |
| D11 | `assertDeployable`: `balance <` → `balance <=` | `test_anUnderfundedDeployerCannotDeploy`'s accepting side |
| D12 | `run()`: call `DeployLib.build` directly instead of `_resolve()` | `test_anEoaGovernorCannotBeDeployed` **and** `test_planRevertsOnAnUnregisteredChain`. **This is the bypass mutant — the one that proves the assertion cannot be skipped** |
| D13 | `run()`: delete `DeployLib.assertAsDeployed(p)` | dies only in company with D14 — see below |
| D14 | `build`: hard-code `4_292e18` as `V`, ignoring the resolved profile | `test_theDeployedFactoryHoldsTheResolvedProfile`, **through `assertAsDeployed` and nothing else** — every one of the factory's seven guards accepts this value, which is H3 exactly. Run D13 and D14 together to prove D13's line is the sole defence |
| D15 | `_resolve()`: `msg.sender` → `address(this)` | report what actually reddens; the balance check is the likely one |

**D13 + D14 is the pair that matters.** Report the exact test set each reddens. If D14 dies on anything other
than the read-back, that is a finding about the suite, not a comfort.

- [ ] **Step 6: The dry run against the live chain, before anything is broadcast**

```bash
forge script script/Deploy.s.sol:Deploy --sig "plan()" --root contracts \
  --rpc-url arc_testnet --account arcpad-deployer --sender <deployer address>
```

Record the full output in the task report. It must show `chainId 5042002`, `PROFILE testnet`,
`V 4292000000000000000`, both initcode hashes, both predicted addresses, and two transactions — both to
`0x4e59b448…`. Nothing is broadcast: `plan()` is `view` and there is no `vm.broadcast` on that path.

**This step will fail until Task 4 fills in the Safe addresses**, with `NotAMultisig("governor", 0x0…0)`. That is
the correct order and the correct failure; the report should show it as evidence the gate is live rather than
skipping the step.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(script): deterministic deploy with a dry run that asserts before it prints"
```

**Deliverable:** `forge test --root contracts --match-path 'test/script/*' -vv` green; the mutant table filled in
with reddened-test counts; the dry-run output recorded.
**Suites run, and why sufficient:** `test/script/*` only. `DeployLib` and `Deploy.s.sol` import `src/` types and
call `src/` getters but change nothing in `src/`, and no pre-existing test imports either file — so no other
suite's behaviour can have moved. `forge build` covers the compile of the whole tree, which is the only global
effect this task has.

---

### Task 3: The address book — one file, four consumers, no transcription

Phase 3's plan already names `ARC_FACTORY_ADDRESS` and a `Deployment` record; Phase 4's plan already names
`NEXT_PUBLIC_ARCPAD_FACTORY` / `NEXT_PUBLIC_ARCPAD_ESCROW` and a `preflight` that **exits 2** when the book is
unconfigured. This task builds the artefact both expect, and it is built **before** the deploy so that Task 6 has
only to fill it in.

**Files:**
- Create: `contracts/deploy/addresses.schema.json` (documentation of the shape, not a validator dependency)
- Create: `contracts/deploy/testdata/addresses.31337.json` (fixture, a complete book with fake but well-formed
  addresses)
- Create: `scripts/addressbook.ts` — generator: broadcast receipt + on-chain reads → the book
- Create: `packages/shared/src/addresses.ts`, `packages/shared/src/profiles.ts`
- Create: `packages/shared/test/addresses.test.ts`, `packages/shared/test/profiles.test.ts`
- Modify: `packages/shared/src/index.ts`, `.env.example`

**Interfaces:**
- Produces (`@arcpad/shared`):
  - `type AddressBook = { chainId: number; chainKey: string; profile: 'testnet' | 'production'; virtualTokenReserves: bigint; virtualQuoteReserves: bigint; saleSupply: bigint; totalSupply: bigint; launchFactory: Address; feeEscrow: Address; governor: Address; protocolTreasury: Address; graduationTarget: Address; feeEscrowBlock: bigint; launchFactoryBlock: bigint; startBlock: bigint; deployTx: Hex; escrowInitcodeHash: Hex; factoryInitcodeHash: Hex; commit: string; smokeToken: Address | null; smokeCurve: Address | null }`
    — `smokeToken` / `smokeCurve` are `null` until Task 7 fills them; they are the permanent completed-curve
    fixture the CI fork gate reads. They are **in the type from the start** so that Task 7 is a value change, not
    a schema change, and so `loadAddressBook` validates them the same way as every other address.
  - `loadAddressBook(chainId: number): AddressBook` — reads `contracts/deploy/addresses.<chainId>.json`, validates,
    checksums, throws with the field name on any failure
  - `toDeployment(book: AddressBook): Deployment` — the **exact** record Phase 3's `packages/db` declares:
    `{ chainId, factory, escrow, protocolTreasury, virtualTokenReservesTok, virtualQuoteReservesWei, saleSupplyTok, totalSupplyTok, startBlock }`
  - `assertEnvMatchesBook(env: Record<string, string | undefined>, book: AddressBook): void` — throws naming the
    offending variable. **Phase 4's `preflight` calls this**, which discharges the obligation with code instead of
    a note in a plan.
  - `readProfiles(): { testnet: CurveProfile; production: CurveProfile }` and `profileDigest(p: CurveProfile): Hex`
  - `type CurveProfile = { virtualTokenReserves: bigint; virtualQuoteReserves: bigint; saleSupply: bigint }` —
    **the same name and the same three fields Phase 4's `web/lib/profile.ts` declares**, so the two never need a
    translation layer.

**How the addresses reach each consumer — the whole map, in one place:**

| Consumer | Route | Why that route |
|---|---|---|
| `contracts/test/fork/*` | `vm.readFile("deploy/addresses.5042002.json")` | needs no secrets, so the CI fork gate can assert the live deployment on every push |
| `indexer/` | `loadAddressBook(chainId)` → `toDeployment()` → `putDeployment()` | Phase 3 stores the deployment row in Postgres and reads `startBlock` as its `fromBlock`; the plan's `ARC_FACTORY_ADDRESS` remains as an **override** for local work and is cross-checked against the book at start-up |
| `keeper/` | `loadAddressBook(chainId)` | Task 5's watcher needs `launchFactory`, `governor`, `protocolTreasury` and `startBlock`; a keeper reading env for these could watch a different factory than the one CI asserts |
| `web/` | **env** — `NEXT_PUBLIC_ARCPAD_FACTORY` / `NEXT_PUBLIC_ARCPAD_ESCROW` | forced, not chosen: Next inlines `NEXT_PUBLIC_*` at build time, so a JSON read at request time never reaches the client bundle. Phase 4's `preflight` closes the resulting staleness by calling `assertEnvMatchesBook`, and keeps its documented **exit code 2** for the unconfigured case — which stays reachable because the book's addresses are never copied into `.env.example` |

- [ ] **Step 1: The book's shape, and why each field is in it**

```json
{
  "chainId": 5042002,
  "chainKey": "arc-testnet",
  "profile": "testnet",
  "virtualTokenReserves": "1073000000000000000000000000",
  "virtualQuoteReserves": "4292000000000000000",
  "saleSupply": "793100000000000000000000000",
  "totalSupply": "1000000000000000000000000000",
  "launchFactory": "0x…",
  "feeEscrow": "0x…",
  "governor": "0x…",
  "protocolTreasury": "0x…",
  "graduationTarget": "0x0000000000000000000000000000000000000000",
  "feeEscrowBlock": "0",
  "launchFactoryBlock": "0",
  "startBlock": "0",
  "deployTx": "0x…",
  "escrowInitcodeHash": "0x…",
  "factoryInitcodeHash": "0x…",
  "commit": "0bae7e3…"
}
```

| Field | Why it is here rather than derivable |
|---|---|
| `startBlock` | `min(feeEscrowBlock, launchFactoryBlock)`. The indexer's `fromBlock`. Both components are recorded separately because the escrow is deployed first and an indexer that starts at the *factory* block misses nothing today but would after any future escrow-first event. |
| `profile` + the three reserves | Duplicated from `profiles.toml` **deliberately**, and cross-checked: `loadAddressBook` recomputes the digest and compares against the profile the factory actually reports. A book that disagrees with its own chain is a loud failure, not a quiet one. |
| `graduationTarget` | Zero in this phase. Present so that Phase 2's change to it is a diff in a reviewed file. |
| `escrowInitcodeHash` / `factoryInitcodeHash` | Lets anyone re-derive both addresses from the book alone: `CREATE2(0x4e59b448…, salt, hash)`. Without them the book is a claim; with them it is a proof sketch. |
| `commit` | The tree the bytecode was built from. Without it, "the deployed bytecode matches what was built" has no referent. |

`totalSupply` is `LAUNCH_TOKEN_TOTAL_SUPPLY = 1e27`, verified in Task 6 by reading `TOTAL_SUPPLY()` off a token
the deployment actually minted, not copied from a constant.

- [ ] **Step 2: `packages/shared/src/profiles.ts` — the cross-language digest**

Reads `contracts/deploy/profiles.toml` and recomputes `keccak256(abi.encode(T,V,S))` with viem's
`encodeAbiParameters` + `keccak256`. Exports `PROFILE_DIGESTS` with the two literals **hand-written**, exactly as
`Profiles.sol` does:

```ts
export const PROFILE_DIGESTS = {
  testnet: '0xa67f784bd45f49baa48601d390ecafdb2fe44aadffd974b4b0bd582c10d6600d',
  production: '0x7def5669fd9a5fd109bf35f1d1b04c651e124b6f0f22c37ced26fb77880a80e3',
} as const
```

`packages/shared/test/profiles.test.ts`:

- `it('the TOML matches the pinned digest for both profiles')` — the cross-language gate. If Solidity and
  TypeScript ever disagree about what "testnet" means, this is the test that says so.
- `it('the two profiles differ in exactly one field, by exactly 1000x')` — asserts `T` and `S` equal, and
  `production.virtualQuoteReserves / testnet.virtualQuoteReserves === 1000n`.
- `it('production is 4292e18 and testnet is 4292e15')` — the literals, written out.

- [ ] **Step 3: `packages/shared/src/addresses.ts`**

Validation, each failure naming its field: every address `isAddress` and checksummed via `getAddress`; every
numeric field a decimal string parsed to `bigint` (never `number` — `1e27` is not representable); `chainId`
matching the filename; `profile` ∈ {`testnet`, `production`}; the three reserves matching
`readProfiles()[book.profile]`; `startBlock === min(feeEscrowBlock, launchFactoryBlock)`; and
`launchFactory !== feeEscrow !== governor !== protocolTreasury` pairwise distinct.

That last one is not decorative: Phase 1c's final review found that pasting the escrow into the treasury argument
passes every on-chain guard except one, and costs 938,271,604,938,271,605 wei of unclaimable protocol fees per
100-USDC buy. The factory now rejects `treasury == escrow`; the book rejects **every** aliasing pair, including
the ones the contract deliberately permits (`governor == protocolTreasury` is legal on-chain and is still a
mistake worth catching in a book that a human wrote).

> If the operator genuinely wants one Safe for both roles, that is a decision to record in
> `expected-governance.json` with an explicit `"governorIsTreasury": true`, not a silent pass.

- [ ] **Step 4: `scripts/addressbook.ts` — generate, never hand-write**

```
pnpm addressbook --chain 5042002
```

Reads `contracts/broadcast/Deploy.s.sol/5042002/run-latest.json` (forge writes it; `.gitignore` excludes only
`broadcast/*/dry-run/`, so the real receipt is committed) plus live `eth_call`s for `escrow()`, `governor()`,
`protocolTreasury()`, `graduationTarget()`, `VIRTUAL_TOKEN_RESERVES()`, `VIRTUAL_QUOTE_RESERVES()`,
`SALE_SUPPLY()`, and `git rev-parse HEAD`. Writes the book, then **re-loads it through `loadAddressBook` and
throws if validation fails** — a generator that can emit a file its own loader rejects is worse than no generator.

It also prints the env block:

```
NEXT_PUBLIC_ARC_CHAIN_ID=5042002
NEXT_PUBLIC_ARCPAD_FACTORY=0x…
NEXT_PUBLIC_ARCPAD_ESCROW=0x…
ARC_FACTORY_ADDRESS=0x…
ARC_ESCROW_ADDRESS=0x…
ARC_START_BLOCK=…
```

**Why env at all, given the book is committed:** Next.js inlines `NEXT_PUBLIC_*` at build time, so the web app
cannot read a JSON file at request time and still have the value in the client bundle. That is the Phase 4 plan's
design and it stands. The failure it creates — a stale env against a fresh book — is closed by
`assertEnvMatchesBook`, which Phase 4's `preflight` calls as its fifth assertion.

- [ ] **Step 5: Tests, against the committed fixture**

`packages/shared/test/addresses.test.ts` (vitest; no chain, no forge):

| Test | Asserts |
|---|---|
| `loads the fixture and checksums every address` | round-trip |
| `rejects a book whose chainId disagrees with its filename` | field-named throw |
| `rejects a book whose reserves disagree with the profile it names` | the H3 shape, one layer up |
| `rejects startBlock that is not the min of the two deploy blocks` | |
| `rejects any aliased pair among factory/escrow/governor/treasury` | five pairs, each its own case |
| `parses 1e27 without precision loss` | `totalSupply === 10n ** 27n` — a `number` would silently round |
| `toDeployment produces exactly the nine fields packages/db declares` | `expect(Object.keys(d).sort()).toEqual([...])` — two-way, so an added field fails too |
| `assertEnvMatchesBook throws naming the stale variable` | a case per variable |

**Two-way key equality, not "contains".** Phase 1b's surface tests counted names and five substitutions passed;
the lesson transfers verbatim to a record type shared across two packages.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(shared): an address book the indexer, keeper and web all read from one file"
```

**Deliverable:** `pnpm --filter @arcpad/shared test` green; `pnpm addressbook --chain 31337` regenerates the
fixture byte-identically from a checked-in fake receipt.
**Suites run, and why sufficient:** the two new vitest files plus the existing `@arcpad/shared` suite. No Solidity
changed, so no `forge` run is required at all — this is the cheapest task in the phase and should take under a
minute to verify.

---

### Task 4: Governance — two Safes on Arc testnet, and the ceremony to drive them

This is decision **D-3** made real, and it must land **before** Task 6, because `governor` is a constructor
argument and therefore determines the factory's CREATE2 address.

**Files:**
- Create: `contracts/script/Governance.s.sol`
- Create: `contracts/test/fork/Governance.fork.t.sol`
- Create: `docs/runbooks/deploy.md` (the Safe ceremony section; the deploy section lands in Task 6)
- Modify: `contracts/deploy/expected-governance.json` (fill in the two addresses)
- Modify: `.env.example`

**Interfaces:**
- Produces:
  - `Governance.createSafes()` — deploys the two Safes deterministically
  - `Governance.predictSafes() → (address governor, address treasury)` — dry run
  - `Governance.encodeProposeTarget(address target) → (bytes32 safeTxHash, bytes txData)`
  - `Governance.encodeRotateTreasury(address next) → (bytes32 safeTxHash, bytes txData)`
  - `Governance.execute(bytes txData, bytes signatures)` — submits to the governor Safe
  - `Governance.applyTarget()` — plain call, **no Safe** (`applyGraduationTarget` is permissionless by design)

- [ ] **Step 1: The Safe topology, decided**

| | Governor | Treasury |
|---|---|---|
| Contract | Safe **L2** v1.4.1 singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | same |
| Threshold / owners | **2 of 3** | **2 of 3** |
| Owners | three keys on three separate devices, at least one offline hardware | same key set is acceptable on testnet; **on mainnet they must differ** — recorded as a mainnet gate, not a testnet one |
| Powers | `proposeGraduationTarget`, `setProtocolTreasury`. Nothing else — it cannot launch, cannot pause, cannot touch a curve | receives 0.95% of volume, pull-based from `FeeEscrow.claim` |
| Address-committing? | **Yes** — a constructor argument | **Yes for the initial value**; rotatable afterwards, and rotation reaches live curves because `BondingCurve.protocolTreasury()` is a deposit-time read |

**Why `SafeL2` rather than `Safe`.** The L2 variant emits `SafeMultiSigTransaction` / `ExecutionSuccess` events
for every execution. Arc has no Safe transaction service that this plan could confirm, so **the chain's own logs
are the only record of governance activity** — which is exactly what the Task 5 watcher and Phase 3's indexer need
to reconstruct. Choosing the non-L2 singleton would make Safe activity invisible off-chain except by tracing.

**Why two Safes rather than one.** The governor is authority; the treasury is revenue. A single compromise should
not be both. The factory explicitly permits `governor == protocolTreasury`, so this is a policy choice, and it is
enforced by `addresses.ts`'s aliasing check rather than by the chain.

- [ ] **Step 2: Deterministic Safe creation**

```solidity
address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

uint256 internal constant GOVERNOR_SALT_NONCE = uint256(keccak256("arcpad.governor.v1"));
uint256 internal constant TREASURY_SALT_NONCE = uint256(keccak256("arcpad.treasury.v1"));
```

`initializer = abi.encodeCall(ISafeSetup.setup, (owners, 2, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0))))`,
then `SafeProxyFactory.createProxyWithNonce(SAFE_L2_SINGLETON, initializer, saltNonce)`.

`predictSafes()` reproduces the address without deploying:
`CREATE2(SAFE_PROXY_FACTORY, keccak256(abi.encodePacked(keccak256(initializer), saltNonce)), keccak256(abi.encodePacked(proxyCreationCode, uint256(uint160(SAFE_L2_SINGLETON)))))`
where `proxyCreationCode` is read from the live factory via `SafeProxyFactory.proxyCreationCode()`. **Read it, do
not hard-code it** — it is a property of the deployed factory, and hard-coding it is precisely the transcription
this project keeps catching.

The owner set is data: `deploy/expected-governance.json` gains an `owners` array per role, and the script hashes
it into the salt path via the initializer, so **a different owner set is a different Safe address**. That is the
right coupling — it makes the owner set part of the reviewed artefact.

- [ ] **Step 3: The signing ceremony, written out**

There is no Safe UI this plan could confirm covers chain 5042002, so the ceremony is CLI-only and must be in the
runbook verbatim:

```bash
# 1. Build the transaction and print its Safe hash (no signatures needed)
forge script script/Governance.s.sol:Governance --sig "encodeProposeTarget(address)" <target> \
  --root contracts --rpc-url arc_testnet

# 2. EACH owner, independently, on their own machine:
cast wallet sign --no-hash <safeTxHash> --account <their-keystore-account>

# 3. Concatenate the 65-byte signatures ORDERED BY OWNER ADDRESS ASCENDING
#    (Safe requires this; an out-of-order bundle reverts GS026)
forge script script/Governance.s.sol:Governance --sig "execute(bytes,bytes)" <txData> <sigs> \
  --root contracts --rpc-url arc_testnet --account arcpad-deployer --broadcast
```

The runbook states the two failure modes by their Safe error codes so an operator can tell them apart: `GS020`
(signature data too short — a missing signer), `GS026` (invalid owner or wrong order).

- [ ] **Step 4: `contracts/test/fork/Governance.fork.t.sol` — turn today's probes into a permanent gate**

| Test | Asserts |
|---|---|
| `test_theSafeDeploymentIsPresentOnArc` | code length > 0 at all four canonical Safe addresses used here. Today's measurements: singleton 23,579; SafeL2 24,421; proxy factory 3,054; fallback handler 5,637. **Assert `> 0`, not the exact length** — a Safe patch release would redden a length equality for no security reason, and a zero is the only failure that matters |
| `test_thePredictedSafeAddressesMatchTheDeployedOnes` | `predictSafes()` equals the two addresses in `expected-governance.json` |
| `test_bothSafesAreTwoOfThreeOrStricter` | `getThreshold() >= 2`, `getOwners().length >= 3`, for both |
| `test_theTwoSafesAreDistinct` | `governor != treasury` |
| `test_theGovernorIsNotTheDeployerAndNotAnOwnerAlone` | the deploying EOA is not a Safe owner **and** cannot reach the threshold alone |
| `test_theCreate2DeployerAndPredeploysArePresent` | `0x4e59b448…` (69 bytes), USDC `0x3600…`, Multicall3, Permit2 — folds the existing `ArcNetwork.fork.t.sol` probes forward so the deploy's dependencies are gated, not assumed |

- [ ] **Step 5: A live rehearsal of the ceremony, before any money exists**

Run the full propose→wait→apply cycle **against the factory that does not exist yet**? No. Instead rehearse the
*Safe mechanics* against a throwaway target: from the governor Safe, execute a no-op `setProtocolTreasury` to the
treasury Safe's own current address on a **disposable** `LaunchFactory` deployed with the local rehearsal key.

> **This is the one place a second, disposable factory is permitted**, and it must be deployed with a **different
> salt** — `keccak256("arcpad.LaunchFactory.rehearsal")` — so it can never be mistaken for the real one and can
> never collide with it. It is deployed by a `Governance.deployRehearsalFactory()` helper calling
> `DeployLib.deploy(salt, initcode)` **directly with that salt**, not by `Deploy.s.sol`, whose `FACTORY_SALT` is a
> constant and must stay one: a deploy script that accepts a salt argument is a deploy script that can be pointed
> anywhere. Record the rehearsal factory's address in the report and **do not** put it in the address book.
>
> The rehearsal factory needs a governor that is the governor Safe (that is the point) and a treasury; use the
> treasury Safe for both roles here, which the frozen contract permits, and which `addresses.ts`'s aliasing check
> never sees because this factory never enters the book.

What this proves that a unit test cannot: that three real keystores produce a signature bundle Safe accepts, in
the right order, on the real chain, at real gas — the thing that fails at 2 a.m. otherwise.

- [ ] **Step 6: Fill in `expected-governance.json` and commit**

```bash
git commit -m "feat(script): two Safes, deterministically addressed, and the ceremony that drives them"
```

**Deliverable:** both Safes live on Arc testnet at the predicted addresses; `expected-governance.json` filled;
`forge test --root contracts --match-path 'test/fork/Governance.fork.t.sol' --fork-url arc_testnet` green; the
rehearsal transaction hash recorded in the report.
**Suites run, and why sufficient:** the new fork file plus `test/script/*`. Nothing in `src/` or in the non-fork
suites can be affected by a Safe existing on a remote chain; the fork file is the only thing that can observe it.

---

### Task 5: The 3-day window gets a watcher, and the watcher gets a drill

Decision **D-4**. This lands before the deploy so that the factory is never live without something watching it.

**Files:**
- Create: `keeper/src/watch/graduationWindow.ts`
- Create: `keeper/src/alert.ts`
- Create: `keeper/test/graduationWindow.test.ts`
- Create: `docs/runbooks/graduation-window.md`
- Modify: `keeper/src/index.ts`, `keeper/src/config.ts`, `.env.example`

**Interfaces:**
- Produces:
  - `type WindowState = { pendingTarget: Address; pendingEta: bigint; currentTarget: Address; nowSeconds: bigint; opensAt: bigint; expiresAt: bigint; phase: 'none' | 'armed' | 'open' | 'expired' }`
  - `readWindowState(client, factory): Promise<WindowState>` — **reads the two storage-backed getters every poll**,
    it does not rely on having seen the event
  - `classify(state, allowlist): { level: 'ok' | 'page'; reason: string }`
  - `knownCurves(client, factory, startBlock): Promise<Address[]>` — **where the curve set comes from in Phase 1d,
    since no indexer exists yet:** `getLogs` for `Launched` from the address book's `startBlock`, paged, cursor
    persisted in `keeper/.cursor` so a restart does not re-scan from genesis. After Phase 3 lands this is replaced
    by a `@arcpad/db` query and the function keeps its signature. **A page that under-reports the exposure because
    the log scan silently truncated is worse than no page**, so `knownCurves` throws on any RPC range error rather
    than returning a short list, and `runWatcher` treats that throw as a page.
  - `exposure(client, curves): Promise<{ count: number; totalQuoteWei: bigint }>` — completed-but-ungraduated
    curves and the sum of their `realQuoteReserves`
  - `runWatcher(deps): Promise<void>` — one poll; the loop is `keeper/src/index.ts`'s
  - `alert(level, message)` and `heartbeat()`

- [ ] **Step 1: What it watches, and why both a log and a slot**

Logs: `GraduationTargetProposed(address indexed target, uint256 eta)`,
`GraduationTargetChanged(address indexed previous, address indexed current)`,
`ProtocolTreasuryChanged(address indexed previous, address indexed current)`, and `Completed` on every known curve.

Slots, every poll, regardless of logs: `pendingGraduationTarget()`, `pendingGraduationTargetEta()`,
`graduationTarget()`, `protocolTreasury()`.

**Both, and the reason is not belt-and-braces.** An RPC can drop a log range; a reorg can unsee one; the keeper can
be restarted past a gap. The slot cannot lie about the current state, but it cannot tell you a proposal was made
and overwritten either. The log stream gives *history*, the slot gives *truth*. Phase 1c already measured the cost
of trusting a topic: removing `indexed` from an event parameter is a one-word edit that leaves every `getLogs`
filter silently returning nothing.

The window, computed from the two constants the contract exposes rather than from a local `3 days`:

```
opensAt   = pendingGraduationTargetEta
expiresAt = pendingGraduationTargetEta + factory.GRADUATION_TARGET_DELAY()
phase     = none | armed (now < opensAt) | open (opensAt <= now <= expiresAt) | expired (now > expiresAt)
```

Reading `GRADUATION_TARGET_DELAY()` off the chain rather than hard-coding `259200` means a future factory with a
different delay does not silently shorten the watcher's idea of the window.

- [ ] **Step 2: What it does**

| Observation | Level | Action |
|---|---|---|
| `phase == none` | ok | heartbeat only |
| `pendingTarget` **on** the allowlist in `expected-governance.json` | ok | log with `opensAt`, `expiresAt`, and the exposure |
| `pendingTarget` **not** on the allowlist | **page** | message carries target, `opensAt`, `expiresAt`, and the exposure in USDC |
| `graduationTarget` changed to an address not on the allowlist | **page**, highest severity | the change has already landed; the drain window is over |
| `protocolTreasury` changed to an address not on the allowlist | **page** | the treasury setter has **no delay** by design, so this is always a post-hoc alert and the runbook says so |
| no heartbeat for two poll intervals | **page** | see Step 4 |

**Exposure is part of the page, not a follow-up query.** A page that says "an unexpected target was proposed"
prompts a scramble; a page that says "an unexpected target was proposed, 3 curves completed, 36.48 USDC at risk,
window opens 2026-08-02T14:11Z, expires 2026-08-05T14:11Z" prompts a decision.

- [ ] **Step 3: The two runbooks, in `docs/runbooks/graduation-window.md`**

**`disarm`** — the governor Safe re-proposes the *correct* target, which overwrites the pending one and restarts
the three days. Requires the governor keys, so it is unavailable under key compromise. One transaction, 2-of-3.

**`drain`** — graduate every completed curve to the **current** target inside the window, so a re-point cannot
reach them. Requires a current target whose entrypoint lets someone call `graduate()`.

> **In Phase 1d, `drain` has no referent and the runbook must say so in these words.** `graduationTarget` is
> `address(0)` for the whole phase, so `BondingCurve.graduate()` reverts `GraduationTargetUnset()` for every curve,
> completed or not. Under a governor compromise during Phase 1d there is **no on-chain remedy**: the mitigations
> are that the *first* target has never been set (so there is nothing already pointed at that an attacker
> displaces), and that the compromise is publicly visible for three days before it can land. The runbook's Phase 1d
> action is therefore: **page, publish, and do not let the proposal land — and if it lands anyway, the raise of
> every completed curve is gone.** Phase 2 turns `drain` from prose into a procedure, and the Phase 2 plan's R-12
> already requires a full launch→buy-out→graduate→pool-exists cycle against a locker before any
> `applyGraduationTarget`.

Also in the runbook: the on-call rota (two named Safe signers, weekly), the escalation path, the alert sink, and
the standing instruction that **`applyGraduationTarget` is permissionless** — so anyone, including the attacker,
can land an elapsed proposal, and waiting it out is not a strategy. The window now expires at
`eta + 3 days`, which bounds total exposure at six days; that bound is what makes a rota finite.

- [ ] **Step 4: How the watcher itself is tested — three layers, and the third is the point**

(a) **Unit**, `keeper/test/graduationWindow.test.ts`, against a synthetic client:

| Case | Asserts |
|---|---|
| no pending proposal | `phase === 'none'`, level `ok` |
| pending, allowlisted, `now < eta` | `phase === 'armed'`, level `ok` |
| pending, **not** allowlisted | level `page`, message contains the target and both timestamps |
| `now == eta` and `now == eta + delay` | `phase === 'open'` at **both** inclusive bounds — the contract's two boundaries are inclusive, and a watcher that is off by one at either end tells the rota the wrong thing |
| `now == eta + delay + 1` | `phase === 'expired'` |
| logs missing entirely, slots populated | still classifies — proves the slot path is not decorative |
| slots read, allowlist empty | every non-zero target pages |
| `graduationTarget` changed under the watcher's nose | highest severity, and the message says the window is over |
| exposure over 0, 1 and 3 completed curves | the number in the page is right, including `0` |

(b) **Liveness canary.** The watcher emits a heartbeat every poll; the alerting treats *two missed heartbeats* as
a page. A dead watcher must be louder than a quiet chain — otherwise the whole control degrades into "we saw
nothing", which is indistinguishable from "nothing happened". This is the same failure the project already named
about coverage counters: a mechanism that can go vacuous must assert it did not.

(c) **A scheduled live drill**, weekly in CI, against Arc testnet:

1. From the governor Safe, `proposeGraduationTarget(0x…dEaD)`.
2. Assert the watcher paged within one poll interval — the drill reads the alert sink, it does not simulate it.
3. Do **not** apply. Let it expire at `eta + 3 days`.
4. Assert `applyGraduationTarget()` then reverts `GraduationTargetProposalExpired()`.

Steps 1–2 run weekly; steps 3–4 run as a second scheduled job three days later, keyed off the recorded `eta`.
**A monitor that has never fired in anger is a monitor nobody knows is broken** — this project's own history is
that every serious defect was found by executing something.

> The drill's step 4 is also the only executable proof, on the live chain, of the expiry bound added in
> `f10f4a1`. Its unit test proves the arithmetic; the drill proves the chain agrees.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(keeper): watch the graduation window, and page with the amount at risk"
```

**Deliverable:** `pnpm --filter @arcpad/keeper test` green; `docs/runbooks/graduation-window.md` complete with the
rota; the drill job present in CI and **run once manually** with its page recorded in the report.
**Suites run, and why sufficient:** the keeper's vitest suite only. No Solidity changed; the watcher reads a
deployed factory through viem and nothing in `contracts/` can observe it.

---

### Task 6: The deploy, and the verification that it is what we built

The first irreversible task. Everything before it was rehearsal; this one writes an address that will be quoted
publicly and — per correction **C-2** — will not move again.

**Files:**
- Create: `contracts/deploy/addresses.5042002.json` (generated, then committed)
- Create: `contracts/test/fork/ArcpadDeployment.fork.t.sol`
- Modify: `docs/runbooks/deploy.md`

- [ ] **Step 1: The pre-flight, every item a hard gate**

| Gate | How it is checked |
|---|---|
| Tree is at the frozen commit and `contracts/src/` is untouched | `git status --porcelain contracts/src` empty; `git diff 0bae7e3 -- contracts/src` empty |
| Clean build from a clean artefact directory | `forge clean --root contracts && forge build --root contracts --sizes` |
| Both Safes live, 2-of-3, distinct | Task 4's fork test, re-run |
| `expected-governance.json` filled and committed | reviewed diff |
| Deployer funded | `cast balance` ≥ 0.5 USDC (the script's own `MIN_DEPLOYER_BALANCE`, derived as 5× the ≈0.078 USDC estimate at the measured 25 gwei) |
| Dry run recorded | Task 2 Step 6's output, pasted into the report, showing `PROFILE testnet` and `V 4292000000000000000` |

> **`bytecode_hash = "none"` is what makes any of this reproducible.** With a metadata hash appended, the initcode
> hash — and therefore the CREATE2 address — would depend on compilation details that differ between machines.
> It is already set in both profiles. Do not change it, and do not add `--optimize` flags on the command line
> that would diverge from `foundry.toml`.

- [ ] **Step 2: Broadcast**

```bash
forge script script/Deploy.s.sol:Deploy --sig "run()" --root contracts \
  --rpc-url arc_testnet --account arcpad-deployer --sender <deployer> --broadcast --slow
```

`--slow` because two dependent transactions in one script against a live sequencer should not race. Record, in the
report: both transaction hashes, both block numbers, `gasUsed`, `effectiveGasPrice`, and the total cost in USDC.
Compare against the plan's estimate (`FeeEscrow` ≈189k gas, `LaunchFactory` ≈2.90M gas, ≈0.078 USDC total at
25 gwei) and **state the delta**. A large delta is information about Arc, not a rounding error to absorb.

The script's own `assertAsDeployed` runs at the end of `run()`. If it reverts, the deployment has already
happened — that is unavoidable and is why `plan()` exists. The recovery is not a redeploy at the same salt (which
now reverts); it is a new salt in a reviewed commit, with the failed deployment recorded as abandoned.

- [ ] **Step 3: Generate and commit the address book**

```bash
pnpm addressbook --chain 5042002
git add contracts/deploy/addresses.5042002.json contracts/broadcast/Deploy.s.sol/5042002/run-latest.json
```

The broadcast receipt is committed alongside the book: `.gitignore` excludes only `broadcast/*/dry-run/`, so the
real receipt is tracked, and it is the provenance for every number in the book.

- [ ] **Step 4: Prove the deployed code is what was built — and prove it the strong way**

**The primary proof is the address, not a byte diff, and the reason is worth writing down.** Under CREATE2 the
address is `keccak256(0xff ++ 0x4e59b448… ++ salt ++ keccak256(initcode))`. So

```solidity
Plan memory p = DeployLib.build(
    5042002, Profiles.forChain(5042002), address(0), book.governor, book.protocolTreasury
);
assertEq(p.factory, book.launchFactory);   // and p.escrow == book.feeEscrow
```

(`deployer` is not part of the initcode, so passing `address(0)` for it is correct here and the test says so;
`DeployLib.build` is `pure` and performs no checks, which is why the fork test can call it without a funded
account.)

is a cryptographic statement that **the creation code compiled from this tree *and* the six constructor arguments
both matched**. A byte-wise comparison of runtime code is strictly weaker: it cannot see constructor arguments at
all, and the profile — the thing this whole phase is about — lives entirely in the constructor arguments.

`ArcpadDeployment.fork.t.sol`, run with `--fork-url arc_testnet`, reading the committed book via
`vm.readFile("deploy/addresses.5042002.json")`:

| Test | Asserts |
|---|---|
| `test_theFactoryAddressIsTheCreate2ImageOfThisTree` | the equality above. **This is the bytecode-identity test.** It fails the moment anyone edits `src/`, which is the alarm we want |
| `test_theEscrowAddressIsTheCreate2ImageOfThisTree` | same for `FeeEscrow`, whose initcode has no arguments |
| `test_theEscrowRuntimeCodeIsByteIdenticalToTheArtifact` | `keccak256(book.feeEscrow.code)` vs `out/FeeEscrow.sol/FeeEscrow.json .deployedBytecode.object`. **Exact**, because `FeeEscrow` has no immutables. This is the control that proves the artifact-reading harness works — the same `vm.parseJsonBytes` mechanism `Surface.t.sol` already uses |
| `test_theFactoryRuntimeCodeIsNotComparedByteWise` | a deliberately *empty* test body is forbidden; instead this asserts `book.launchFactory.code.length == out/LaunchFactory artifact deployedBytecode length` and carries a comment stating that a byte-wise compare would need an immutable mask and would be weaker than the address proof it duplicates. **The length check still catches a truncated or proxied deployment** |
| `test_theDeployedFactoryHoldsTheIntendedProfile` | `VIRTUAL_TOKEN_RESERVES == 1073000000000000000000000000`, `VIRTUAL_QUOTE_RESERVES == 4292000000000000000`, `SALE_SUPPLY == 793100000000000000000000000` — literals, not read from the book, so a corrupted book fails here rather than agreeing with itself |
| `test_theBookAgreesWithTheChain` | every address in the book equals the corresponding on-chain getter; `graduationTarget == address(0)`; `launchCount` recorded |
| `test_theGovernanceMembersAreTheSafes` | `governor()` and `protocolTreasury()` equal the two Safe addresses, and both still report `getThreshold() >= 2` |
| `test_theDeployerHasNoPowerOverTheDeployment` | the deploying EOA is neither `governor()` nor `protocolTreasury()`, is not a Safe owner, and `proposeGraduationTarget` from it reverts `NotGovernor()` (via `vm.prank` on the fork) |
| `test_isCanonicalRejectsAnAddressWithNoCode` | `isCanonical(0x…dEaD) == false` |
| `test_isCanonicalRevertsForAContractWithoutLaunchSalt` | calling it on `book.feeEscrow` **reverts** rather than returning false — the documented fail-closed behaviour, pinned so that a future change to "return false" is a deliberate diff and not a surprise for integrators |
| `test_theCreate2DeployerIsStillThere` | 69 bytes at `0x4e59b448…` — because everything above depends on it |

The accept side of `isCanonical`, and the forged-token reject, need a real launch and land in Task 7.

- [ ] **Step 5: Verify on the explorer**

Blockscout v11.2.3 with the Rust verifier microservice, `v0.8.26+commit.8a97fa7a` offered — both measured.

```bash
forge verify-contract <escrow> src/FeeEscrow.sol:FeeEscrow --root contracts \
  --chain-id 5042002 --verifier blockscout --verifier-url https://testnet.arcscan.app/api \
  --compiler-version v0.8.26+commit.8a97fa7a --num-of-optimizations 800 --watch

forge verify-contract <factory> src/LaunchFactory.sol:LaunchFactory --root contracts \
  --chain-id 5042002 --verifier blockscout --verifier-url https://testnet.arcscan.app/api \
  --compiler-version v0.8.26+commit.8a97fa7a --num-of-optimizations 800 --watch \
  --constructor-args $(cast abi-encode \
    "constructor(address,address,address,uint256,uint256,uint256)" \
    <escrow> <treasury> <governor> \
    1073000000000000000000000000 4292000000000000000 793100000000000000000000000)
```

Note the argument order in that `cast abi-encode` line: **`T` before `V`**. It is the same trap as everywhere
else, and here it produces a verification failure that looks like a bytecode mismatch rather than like an argument
mistake. If verification fails, check this first.

`via_ir = true` means single-file verification will not match; use standard-JSON input
(`forge verify-contract --show-standard-json-input > factory.std.json` and submit through
`POST /api/v2/smart-contracts/{address}/verification/via/standard-input`). Record which route worked.

Confirm afterwards via the Etherscan-compatible endpoint that both report verified sources:
`GET https://testnet.arcscan.app/api?module=contract&action=getsourcecode&address=<addr>`.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(deploy): arcpad is live on Arc testnet, and its address is derivable from this tree"
```

**Deliverable:** the address book committed; `forge test --root contracts --match-path 'test/fork/*' --fork-url arc_testnet` green;
both contracts verified on ArcScan with links in the report.
**Suites run, and why sufficient:** `test/fork/*` plus `test/script/*`. The non-fork Solidity suites cannot observe
a remote deployment and nothing in `src/` changed, so re-running them proves nothing new — they are run once at
the end of the phase, in Task 8, under the `ci` profile.

---

### Task 7: The live smoke — launch, buy, sell, and a clamped buy that completes a curve

Every number below was computed for this plan by exact integer arithmetic against `CurveMath`'s formulas. The live
run's job is to **confirm them**. A divergence anywhere is a finding about Arc, not a number to adjust.

**Files:**
- Create: `contracts/script/Smoke.s.sol`
- Create: `contracts/test/fork/ArcpadSmoke.fork.t.sol`
- Modify: `contracts/deploy/addresses.5042002.json` (record the smoke launch's token/curve for the permanent gate)

**Budget:** peak balance ≈ **13.7 USDC** (the clamped buy alone sends 12.603258769415142436) plus gas. Circle's
faucet gives 10 USDC per request, so **two requests** suffice; take a third for headroom before starting, because
a smoke that stalls halfway leaves a half-filled curve that is awkward to describe publicly.

- [ ] **Step 1: Launch**

`launch("arcpad smoke", "SMOKE", "ipfs://<the real pinned CID>")` from the deployer.

| Assertion | Expected |
|---|---|
| returned `(token, curve)` | equal to `predictAddresses(deployer, name, symbol, uri, 0)` computed **before** the call — the derivation, proven live |
| `factory.isCanonical(token)` | `true` — the accept side |
| `token.totalSupply()` and `token.balanceOf(curve)` | `1000000000000000000000000000` (1e27), both |
| `curve.token()`, `token.curve()`, `token.creator()`, `token.launchSalt()` | mutually consistent with the salt the factory emitted |
| `factory.launchCount()` | `1` |
| logs emitted **by the token and the factory** | exactly two: `Transfer` (mint) and `Launched`. Phase 1c measured this on a local EVM; this is its first live confirmation |
| **all** logs in the transaction, recorded verbatim | including any 18-decimal `Transfer` from the EIP-7708 system emitter. **This is the first measurement of that behaviour on a real arcpad transaction**, and the indexer's double-count trap (spec §3.3) depends on it. Record the emitter address and whether a log appears for the *gas payment* itself — if it does, every transaction carries one and Phase 3's filter must be by emitter, not by shape |

- [ ] **Step 2: A 1 USDC buy — every value pinned**

`buyExactQuoteIn{value: 1e18}(minTokensOut = 200723953120761740526324105)`.

Passing the exact expected value as `minTokensOut` rather than `0` is deliberate: the hardening pass found that
all three slippage arguments accept zero and nothing enforces a floor, and a smoke that passes zero would model
the exact frontend behaviour the risk disclosure warns about.

| Quantity | Expected, exactly |
|---|---|
| corrected net | `987654320987654320` |
| protocol fee | `9382716049382717` |
| creator fee | `2962962962962963` |
| net + both fees | `1000000000000000000` — **exactly `msg.value`, so the refund is zero** |
| `token.balanceOf(buyer)` | `200723953120761740526324105` (≈200,723,953.12 tokens) |
| `escrow.owed(treasury)` | `9382716049382717` — independently corroborated: the graduation review measured this same value for a 1 USDC buy |
| `escrow.owed(creator)` | `2962962962962963` |
| `curve.realQuoteReserves()` | `987654320987654320` |
| `curve.realTokenReserves()` | `592376046879238259473675895` |
| `curve.virtualTokenReserves()` | `872276046879238259473675895` |
| `curve.virtualQuoteReserves()` | `5279654320987654320` |
| `curve.complete()` | `false` |

- [ ] **Step 3: A sell of 50,000,000 tokens**

`token.approve(curve, 50000000e18)` then `curve.sellExactTokensIn(50000000e18, minQuoteOut = 282651742914558148)`.

| Quantity | Expected, exactly |
|---|---|
| gross proceeds | `286229613078033568` |
| protocol fee | `2719181324241319` |
| creator fee | `858688839234101` |
| net paid to the seller | `282651742914558148` |
| `curve.realQuoteReserves()` after | `701424707909620752` |
| `curve.realTokenReserves()` after | `642376046879238259473675895` |
| `curve.virtualQuoteReserves()` after | `4993424707909620752` |
| `escrow.owed(treasury)` cumulative | `12101897373624036` |
| `escrow.owed(creator)` cumulative | `3821651802197064` |

The sell is a **push** payment to `msg.sender`, which is one of the two paths that deviate from the spec's
pull-only mandate. On Arc this is the one to watch: a blocklisted or contract-wallet seller cannot exit. The
deployer is a plain EOA, so this run proves the happy path only — **record that limit explicitly** rather than
letting a green sell read as "selling works for everyone."

- [ ] **Step 4: The clamped buy that completes the curve**

`buyExactQuoteIn{value: 12603258769415142436}(minTokensOut = 642376046879238259473675895)`.

That is the exact-out cost of the entire remaining reserve plus its two fees, **plus exactly 1 USDC of
overshoot**, so the clamp is guaranteed to fire with a bounded, pinned excess.

| Quantity | Expected, exactly |
|---|---|
| tokens received | `642376046879238259473675895` — the whole remaining reserve, i.e. the clamp fired |
| charged (net into reserves) | `11460008661150757961` |
| protocol fee | `108870082280932201` |
| creator fee | `34380025983452274` |
| total charged (net + both fees) | `11603258769415142436` |
| `escrow.owed(treasury)` cumulative | `120971979654556237` |
| `escrow.owed(creator)` cumulative | `38201677785649338` |
| **refund** | **exactly `1000000000000000000`** — the clamped fill falls bit-identically onto the exact-out path, so the overshoot comes back whole. A refund of anything else means the clamp is not the fallback Phase 1c proved it to be |
| `curve.realTokenReserves()` | `0` — exactly zero, reachable only by a buy |
| `curve.complete()` | `true` |
| `curve.realQuoteReserves()` | `12161433369060378713` |
| `Completed` event's `poolSeedSupply` | `206886011183597390493942218` (= `D`) |

> **`12161433369060378713` is `R_testnet + 7`, not `R_testnet + 1`, and that is the point.** The raise is
> **path-dependent**: `quoteBuyCost`'s unconditional `+1` accumulates per buy, so a curve filled in three
> transactions ends above one filled in a single transaction. The Phase 2 plan derived this and warned that any
> hard-coded `sqrtPriceX96` is wrong for four launches in five. **This run is its first live confirmation**, and
> the exact figure belongs in the Phase 2 plan's evidence.

- [ ] **Step 5: The terminal state, asserted rather than assumed**

| Assertion | Expected |
|---|---|
| `buyExactTokensOut`, `buyExactQuoteIn`, `sellExactTokensIn` | **all three** revert `CurveComplete()`. Not one of them — all three, because "closed on one entrypoint reads as closed on all" is this project's dominant failure mode |
| `curve.graduate()` | reverts `GraduationTargetUnset()` |
| `curve.graduated()` | `false` |
| the curve's balances | `12161433369060378713` wei native and `206886011183597390493942218` tokens still held. **Present, not lost** — see §"What is deliberately not deployed" |
| `factory.isCanonical(token)` | still `true` after completion |

- [ ] **Step 6: The forgery, on the live chain**

Deploy a `Forger` that builds its own `BondingCurve` from the factory's own profile getters, mints and binds its
own `LaunchToken`, and copies the real launch's salt — the shape Phase 1c proved is the only forgery worth
testing, because the naive one is distinguishable anyway. Assert:

- every one of the token's seven fields and both back-pointers match the real token's;
- `factory.isCanonical(forged) == false`.

This is the one property the whole CREATE2 identity scheme exists for, and it has never run against a live chain.
Record the forger's address in the report; **do not** put it in the address book.

- [ ] **Step 7: Fold the results into the permanent fork gate**

`ArcpadSmoke.fork.t.sol` reads the smoke token and curve addresses from the address book and re-asserts the
terminal state on **every CI run**: complete, not graduated, all three entrypoints reverting `CurveComplete()`,
`graduate()` reverting `GraduationTargetUnset()`, `isCanonical` still true, and the two balances still present.
A completed curve is a permanent, free fixture; using it is cheaper and stricter than rebuilding one.

- [ ] **Step 8: Commit**

```bash
git commit -m "test(fork): a real launch, a real fill, and a completed curve that is waiting for Phase 2"
```

**Deliverable:** every literal above confirmed live, or a written finding where it was not; the transaction hashes
recorded; `test/fork/*` green against `--fork-url arc_testnet`.
**Suites run, and why sufficient:** `test/fork/*` only. The arithmetic being confirmed is already covered
exhaustively by the local suites; what this task adds is the *chain*, and only the fork suite can see it.

---

### Task 8: CI, the corrections this phase owes, and the phase's one full green run

**Files:**
- Modify: `.github/workflows/contracts.yml`
- Modify: `.github/workflows/node.yml`
- Modify: `docs/plans/2026-07-30-arcpad-phase4-frontend.md` (correction **C-2**)
- Modify: `docs/plans/2026-07-30-arcpad-phase2-pool.md` (the path-dependent raise, measured live in Task 7)
- Modify: `docs/specs/2026-07-27-arcpad-design.md` (§3.1's heading and the address table)
- Create: `docs/announcement-testnet.md`
- Create: `docs/known-limitations.md`

- [ ] **Step 1: The fork job becomes a deployment gate**

`continue-on-error` was removed in `3d6cb09`, so the fork job is already a real gate. It now also runs
`test/fork/ArcpadDeployment.fork.t.sol`, `ArcpadSmoke.fork.t.sol` and `Governance.fork.t.sol`, all of which read
the **committed** address book and need no secrets. That is the point of committing the book: the live deployment
is asserted on every push, by anyone, forever.

The existing `run_fork || retry once` shape stays. Do not add a second `continue-on-error` anywhere; the ledger
records that a silently green Arc check is worth less than none.

- [ ] **Step 2: The governance drill, as its own scheduled job**

`schedule: cron` weekly. It **broadcasts** (a proposal from the governor Safe to a burn address), so it needs a
signing secret and must not run on pull requests from forks. Follow Phase 3's pattern exactly: a separate job,
with `continue-on-error` at the **step** level and never at the job level — a job-level flag makes failure look
green, which is the thing the fork job was fixed to stop doing.

- [ ] **Step 3: The corrections this phase owes to other documents**

| Document | Correction |
|---|---|
| `docs/plans/…phase4-frontend.md:2164` | **C-2.** "Phase 2 will move every curve and token address" is stale — `graduate()` landed in `04a450f`, inside the frozen bytecode. Phase 1d's addresses are permanent. The address book stays env-driven for the Next.js build-time reason, and `preflight` keeps its exit code 2, but the *reason* changes and the "addresses will shift" sentence must go |
| `docs/plans/…phase2-pool.md` | the live, measured raise from Task 7 — `12161433369060378713` = `R_testnet + 7` for a three-transaction fill — as evidence for the path-dependence finding, which until now was derived and not observed |
| `docs/specs/…design.md:50-64` | §3.1 is headed "Arc ağı" and lists chain id `5042002` and four system addresses **with no testnet qualifier**, and `:11` calls `5042002` *the* Arc L1 chain id. Retitle to Arc **testnet** and state that mainnet parameters are unpublished. This is the spec-level twin of the fail-open this phase spent a whole task closing |
| `docs/audit/slither-triage.json` | unchanged — nothing new is waived. Say so explicitly; an empty triage file with no note reads as "not run" |

- [ ] **Step 4: `docs/known-limitations.md` — the honest list, published with the announcement**

Written for a reader who will trade on this, not for us:

1. **A curve that completes cannot graduate yet.** No graduation target exists. The raise and the pool seed stay
   in the curve, visible on-chain, and trading stops. They are **not lost** — `graduate()` reads the destination
   at call time, so a curve that completes today graduates once Phase 2 lands. What is real is that a holder
   cannot sell after completion.
2. **Holders cannot sell after completion.** All three trading entrypoints revert `CurveComplete()`. This is by
   design and it is the same on pump.fun; it lasts until the pool exists.
3. **Slippage is entirely the caller's.** `minTokensOut`, `minQuoteOut` and `maxQuoteIn` all accept `0` and
   nothing enforces a floor. A front-end that passes `0` leaves users fully exposed to sandwiching.
4. **Payments to the seller and the buyer's refund are pushed, not pulled.** A smart-contract wallet that rejects
   native value, or an address Arc has blocklisted at runtime, **cannot sell**. Fee payments are pull-based and
   unaffected.
5. **The governor Safe is a real authority, in these words:** it can re-point the graduation target behind a
   three-day public delay, and because `graduate()` resolves the target at call time, a re-point reaches curves
   that completed long before it was proposed. It cannot launch, cannot pause, and cannot touch a curve
   otherwise. Losing the Safe permanently freezes graduation for every curve.
6. **No external audit, no bug bounty, no formal verification of the compiled artefact.** Testnet USDC only.
   Do not treat this as a mainnet-ready system.
7. **`isCanonical` is unbounded in gas and quadratic in a hostile token's metadata size** (measured: 768,221,231
   gas at 1.6 MB). Any on-chain caller must use `try/catch` **and** an explicit gas cap; off-chain callers must
   set an RPC gas ceiling.

- [ ] **Step 5: `docs/announcement-testnet.md`**

The factory address, the escrow address, the two Safes, the ArcScan links, the chain id, the profile
(`testnet`, `V = 4292e15`, i.e. **a curve graduates at ≈12.16 USDC here, not 12,161**), the smoke token as a
worked example, and a link to `known-limitations.md` above the fold rather than below it.

State plainly that the addresses are permanent: they were produced by CREATE2 from a frozen tree, they do not
move at Phase 2, and the initcode hashes in the address book let anyone re-derive them.

- [ ] **Step 6: The phase's one full green run**

This is the only place the `ci` profile runs:

```bash
forge fmt --check --root contracts
FOUNDRY_PROFILE=ci forge test --root contracts --no-match-path 'test/fork/*'
forge test --root contracts --match-path 'test/fork/*' --fork-url arc_testnet
make lint
make slither
pnpm -r test
```

Record the test count in both profiles against the phase's starting baseline, and record the Slither finding count
against the measured baseline of 11 (none HIGH/MEDIUM). `script/` is outside Slither's `filter_paths`, so a
changed count would mean something in `src/` or `test/` moved — which nothing in this phase should have.

- [ ] **Step 7: Commit and close**

```bash
git commit -m "docs: publish the testnet deployment, its limits, and the corrections it forced"
```

**Deliverable:** CI green on all jobs including the fork gate; both profiles green; the announcement and the
limitations document written; the three plan/spec corrections landed.

---

## What is deliberately not deployed yet, and what that means operationally

**Nothing points at a graduation target, and nothing will during this phase.** `graduationTarget` is
`address(0)` from the moment the factory is constructed, so `BondingCurve.graduate()` reverts
`GraduationTargetUnset()` for every curve. This is a decision, and it has three parts.

**Why not point it at a stub.** A stub receiver would be a real, applied target. A curve that completed and
graduated into it would be **unrecoverable** — `graduated` is monotone, the assets would be in the stub, and
re-pointing would save only future curves. The Phase 2 plan already states this as its R-12 procedure:
`applyGraduationTarget` may be called only after a full launch → buy-out → `graduate()` → pool-exists cycle has
actually run against that locker on Arc testnet. A Phase 1d stub would consume the one-way door for nothing.

**What a completed curve therefore is, stated precisely because the earlier framing was wrong.** The mainnet
readiness audit called completion "a fund-loss event with a countdown timer." That was written against commit
`32cfd83`, **before `graduate()` existed**. It no longer holds. Since `04a450f` the curve reads its destination at
call time (design decision D2, taken exactly so Phase 1 could ship before Phase 2), so a curve that completes
today is **deferred, not destroyed**: the raise and the pool seed sit in the curve, publicly readable, and become
withdrawable the moment a target is applied. The loss is permanent only if Phase 2 never lands.

**Should any launch be allowed to complete before Phase 2? Yes — and Task 7 makes one complete on purpose.**
The reasoning, and its limits:

- The assets are testnet USDC, which is free. The measured cost of completing a curve at the testnet profile is
  **12.313451286173633442 USDC** for a single-transaction fill; nobody is out of pocket.
- Completion is the **only** way to exercise the terminal state, and this project's entire history is that
  defects are found by executing, not reading. A public testnet where no curve has ever completed would be
  hiding the one state Phase 2 has to interoperate with.
- A completed curve is a **free permanent fixture**: Task 7 Step 7 turns it into a CI gate that re-asserts the
  terminal state on every push, forever, at no cost.
- What is genuinely bad about a completed curve is **not the raise** — it is that holders cannot sell. That is
  the same on pump.fun between fill and migration, but there the gap is minutes and here it is a phase. So the
  limitation is published above the fold, and the announcement says which token has completed and why.

**The consequence for the announcement, and it is not cosmetic:** a public testnet launchpad where curves are
cheap to fill will have curves filled by strangers, and each one will strand its holders until Phase 2. That is
acceptable for testnet play money and unacceptable to leave unstated. `docs/known-limitations.md` items 1 and 2
exist for exactly this, and the frontend must show the state on the token page rather than letting a user
discover it by having a sell revert.

**The one thing that would change this ruling:** if Phase 2 slips far enough that a completed curve's holders are
stranded for months, the right response is not to disable completion (which cannot be done without changing
frozen bytecode) but to stop promoting the testnet as tradeable. That is a communications decision, and naming it
here means it is a decision rather than a drift.

---

## Appendix A — what was measured for this plan, and what could not be established

### Measured, with the method, on 2026-07-30

Live against `https://rpc.testnet.arc.io` and `https://testnet.arcscan.app`: the chain id (`0x4cef52` = 5042002);
the CREATE2 deployer's presence and its exact 69-byte runtime; the USDC ERC-20 view, Multicall3 and Permit2; the
full Safe v1.4.1 set (singleton, SafeL2, proxy factory, fallback handler, MultiSend, MultiSendCallOnly, CreateCall);
the fee market (base 20 gwei, priority 5 gwei, `eth_gasPrice` 25 gwei) and the 30,000,000 block gas limit; the
explorer's Blockscout version, its Rust verifier and the presence of `v0.8.26+commit.8a97fa7a` among 1,657 offered
compilers; and that the Etherscan-compatible `/api` returns verified sources.

Computed by exact integer arithmetic and cross-checked against the contracts' own constants: `D`, `S+D`
(reproduces `MIN_SALE_AND_SEED` exactly), `R_testnet` (reproduces `MIN_GRADUATION_RAISE` exactly), `R_prod`, the
`R_prod − 1000·R_testnet = 680` discrepancy, `M` for both profiles (reproduces `MIN_OPENING_MARKET_CAP`), both
profile digests, both salts, the full smoke sequence (every reserve, fee and balance at every step), and the
`escrow.owed(treasury) = 9382716049382717` figure for a 1 USDC buy — which independently reproduces a value the
graduation review measured by a completely different route.

Read from the tree: `FeeEscrow` has **no** constructor (zero occurrences); `slither.config.json` filters
`script/`; `.gitignore` excludes only `broadcast/*/dry-run/`; `contracts/script/` contains only `.gitkeep`; the
`fs_permissions` comment and its four measured configurations; `graduate()` and `graduationTarget()` are present
in the frozen `BondingCurve` and `LaunchFactory`.

### Could not be established

1. **Whether `app.safe.global` or any Safe transaction service covers chain 5042002.** The Safe client gateway
   returned HTTP 403 from this environment, twice. The plan therefore specifies a **CLI-only** ceremony that needs
   no hosted service. If a UI turns out to exist, it is a convenience, not a dependency — but the runbook should
   be re-tested against it before anyone relies on it.
2. **Whether Arc's runtime blocklist applies to contract addresses.** Still open from the graduation design. It
   decides whether a blocklisted graduation target is a third independent argument for the re-pointable design.
   Task 7 cannot test it without a blocklisted address to test against, and this plan has none.
3. **Whether EIP-7708 emits a `Transfer` for the gas payment itself**, and therefore whether every arcpad
   transaction carries one. Task 7 Step 1 records the answer; the plan does not assume it. Phase 3's filter must
   be by emitter address regardless.
4. **Arc mainnet's chain id, RPC, predeploys and whether Safe is deployed there.** Circle has published nothing;
   `5042` appears only in third-party sources and never in Arc's own documentation. The plan's response is to
   leave the production chain id unregistered so that adding it is a reviewed act.
5. **The real gas cost of `launch()` on Arc.** The ≈3M estimate is a local measurement scaled by the measured
   price; `launch` deploys two contracts and its live cost is a Task 7 output, not an input.
6. **Whether `forge verify-contract`'s single-file route works against Blockscout v11.2.3 with `via_ir`.** The
   plan specifies the standard-JSON fallback and requires the report to record which route was used.
7. **Whether the `--slow` flag is necessary on Arc.** Sub-second finality suggests it may not be, but two
   dependent transactions in one script against an unfamiliar sequencer is not the place to find out.

### Appendix B — the one thing that would invalidate this plan

If it turns out that `contracts/src/` must change — for any reason, including a defect found during the smoke —
then **every address in this plan is void**: the factory's address, the escrow's, and via `predictAddresses` every
curve and token address the factory would ever produce. The address book, the announcement and the committed fork
gates all become claims about a deployment that no longer exists. The correct response is to stop, land the
change through the normal review pipeline, and re-run Tasks 6 through 8 from a new commit with the **same** salts
(the old deployment is abandoned, not overwritten — CREATE2 at an occupied address reverts, which is why a new
salt would be required and why that requires a reviewed commit).

This is why Task 1 exists before Task 6, why the dry run is a separate entrypoint, and why the pre-flight's first
gate is `git diff 0bae7e3 -- contracts/src` being empty.
