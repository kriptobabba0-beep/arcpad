# Dependency pinning and provenance

Why each `contracts/lib/*` submodule is at the commit it is at, and what would
have to change for it to move. Written in Phase 1c; every number below was
measured, and the command that produced it is named.

`contracts/remappings.txt` cannot carry this, because Foundry rejects comments
in that file:

```
$ forge remappings
Error: failed to extract foundry config:
foundry config error: invalid remapping format, found `# provenance comment test`,
expected `<key>=<value>` in Remapping Provider
```

So the rationale lives here instead. Anyone changing a pin should update both.

## The rule

Every remapping that an arcpad source file imports through must resolve into a
submodule that `.gitmodules` names directly. A remapping that tunnels into
another dependency's nested submodule makes that dependency's version part of
our compiled output with nothing in our tree to show it.

## openzeppelin-contracts — v5.0.2 (`dbb6104c`)

`src/LaunchToken.sol` inherits `ERC20` from here. Until Phase 1c the remapping
read

```
@openzeppelin/contracts/=lib/v4-core/lib/openzeppelin-contracts/contracts/
```

so the base class of every token the protocol will ever launch was whatever
OpenZeppelin `v4-core` happened to vendor. A `v4-core` bump would have changed
`LaunchToken`'s base class with no diff anywhere in arcpad and no entry in
`.gitmodules`. That is why this is now a direct submodule.

Pinned at the same version that was already in use, so the change is provably
inert. The two trees are the same object:

```
$ git -C contracts/lib/v4-core/lib/openzeppelin-contracts rev-parse HEAD:contracts
2b239a9435095a8e4586dfebcd452c99a7d0c4c9
$ git -C contracts/lib/openzeppelin-contracts rev-parse HEAD:contracts
2b239a9435095a8e4586dfebcd452c99a7d0c4c9
```

and `LaunchToken`'s runtime and creation bytecode are byte-identical across the
change (`461e26aa…` and `e0bd8e5d…`; see the Phase 1c report).

`git submodule status` describes this commit as `v5.0.0-12-gdbb6104c`, which
looks like it is twelve commits past v5.0.0. It is not — it is exactly v5.0.2.
`v5.0.2` is a *lightweight* tag and `git describe` without `--tags` only
considers annotated ones:

```
$ git -C contracts/lib/openzeppelin-contracts cat-file -t v5.0.2
commit
$ git -C contracts/lib/openzeppelin-contracts cat-file -t v5.0.0
tag
$ git -C contracts/lib/openzeppelin-contracts describe --tags
v5.0.2
```

Use `git describe --tags` when checking this pin.

## v4-core — `46c68346` (no tag exists)

`src/libraries/CurveMath.sol` imports `FullMath`; the tests import `Hooks` and
`IPoolManager`; `uniswap-hooks`' `BaseHook` compiles against this copy too.

Left exactly where it was. Two alternatives were built and measured:

**`v4.0.0` (`e50237c4`, the only tag upstream) does not compile.** It predates
the refactor that moved `SwapParams`/`ModifyLiquidityParams` out of
`IPoolManager`, and `BaseHook` imports the file it created:

```
Error (6275): Source "lib/v4-core/src/types/PoolOperation.sol" not found
  --> lib/uniswap-hooks/src/base/BaseHook.sol:13:1
```

Pinning "down to the release" would be a downgrade onto an incompatible API,
not a conservative choice.

**`d153b048`, the commit `uniswap-hooks` vendors, is a no-op.** Its `src/` tree
is the same object as ours, so nothing the compiler sees would change:

```
$ git -C contracts/lib/v4-core rev-parse HEAD:src
4b17fce83dad60db46161b953becd6d3d529ec24
$ git -C contracts/lib/uniswap-hooks/lib/v4-core rev-parse HEAD:src
4b17fce83dad60db46161b953becd6d3d529ec24
```

The entire distance between the two commits is one line of GitHub Actions YAML
in a repository whose CI we do not run:

```
$ git -C contracts/lib/v4-core diff --stat d153b048..HEAD
 .github/workflows/tests-merge.yml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

Built and tested at `d153b048` anyway: 90/90 passing, `LaunchToken` bytecode
identical. Moving would buy nothing and cost a diff.

There is no tagged release to move to. Upstream has published exactly one tag
in the repository's history:

```
$ git ls-remote --tags https://github.com/Uniswap/v4-core
e50237c43811bd9b526eff40f26772152a42daba	refs/tags/v4.0.0
```

Our commit is the current tip of `refs/heads/main`. `.gitmodules` records no
`branch =` key, so this is a fixed SHA — `git submodule update` checks out
`46c68346` and nothing drifts. What is genuinely absent is upstream provenance,
and no pin available to us supplies it.

## v4-periphery — `3245c3cb` (no tag exists upstream)

Imported by nothing in `contracts/src/` or `contracts/test/` today. Kept
anyway, deliberately.

Phase 2 adds `ArcpadHook`. Deploying any Uniswap V4 hook requires mining a
CREATE2 salt whose resulting address encodes the hook's permission bits, and
`HookMiner` lives here (`test/shared/HookMiner.sol`). That is a concrete,
imminent need, and re-adding a submodule later costs more than leaving one in
place.

Note it is *not* needed to compile `uniswap-hooks`: the only file there that
imports `@uniswap/v4-periphery` is `src/mocks/base/BaseCustomAccountingMock.sol`,
and `uniswap-hooks`' own `foundry.toml` excludes `src/mocks/**` from
compilation. Neither `BaseCustomAccounting` nor `BaseCustomCurve` — the
plausible Phase 2 bases for a bonding-curve hook — touches it.

Upstream has published no tags at all, so unlike `v4-core` there is not even a
release to argue about:

```
$ git ls-remote --tags https://github.com/Uniswap/v4-periphery
(no output)
```

If Phase 2 ends up not importing it, delete it then, together with the
`permit2/` remapping that resolves through it.

## uniswap-hooks — v1.2.1 (`acbd604c`)

Already at a real reviewed release; nothing to change. This was not visible
before Phase 1c because the local clone was shallow and lacked the tag, so
`git submodule status` reported the misleading `v1.2.0-rc.0-21-gacbd604`. After
`git fetch --unshallow --tags`:

```
$ git -C contracts/lib/uniswap-hooks describe --tags
v1.2.1
$ git -C contracts/lib/uniswap-hooks rev-parse v1.2.1
acbd604c409a827f7f98c9517236da860c4fca1a
```

Shallowness is a property of a local checkout, not of the pin: `.gitmodules`
carries no `shallow = true`, so `make install` on a fresh clone fetches full
history and the tag resolves without help.

## Knowingly accepted, not fixed

`solmate/` and `permit2/` still tunnel into nested submodules of `v4-core` and
`v4-periphery` respectively, which is the same shape of hazard fixed above for
OpenZeppelin. They are left alone because nothing in `contracts/src/` or
`contracts/test/` imports through either — verified by `grep`, and confirmed by
the compiler: no `solmate` or `permit2` source appears in
`contracts/out/build-info/*.json`.

The trigger to revisit is narrow and worth writing down: **if any arcpad source
file ever imports through `solmate/` or `permit2/`, give that dependency its own
`.gitmodules` entry in the same commit.** The OpenZeppelin case only became
dangerous because a contract we deploy inherited from it.
