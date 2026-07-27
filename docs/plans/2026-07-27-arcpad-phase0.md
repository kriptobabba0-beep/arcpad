# arcpad Faz 0 — İskelet ve Araç Zinciri Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arc testnet üzerinde Uniswap V4 tabanlı bir launchpad geliştirmek için gereken tüm araç zincirini kurmak ve her katmanın (Foundry, V4 bağımlılıkları, Arc bağlantısı, pnpm workspace, indexer, keeper, web, CI) çalıştığını test ile kanıtlamak. Faz 0 sonunda hiçbir protokol mantığı yazılmamış olacak, ama bir sonraki fazın ihtiyaç duyduğu her şey yeşil testlerle hazır olacak.

**Architecture:** Tek git deposu, dört bağımsız çalışan parça: `contracts/` (Foundry), `indexer/`, `keeper/`, `web/` (pnpm workspace) ve ortak `packages/shared/`. Foundry alt dizinde yaşar; bağımlılıklar `forge install` ile değil doğrudan `git submodule add` ile eklenir ve tüm forge komutları `--root contracts` ile çalıştırılır.

**Tech Stack:** Solidity 0.8.26 · Foundry 1.6 · Uniswap v4-core + v4-periphery + OpenZeppelin uniswap-hooks · Node 24 · pnpm 11 (corepack) · TypeScript 5.9.3 · viem 2.55.10 · wagmi 3.7.4 · Next.js 16.2.12 · React 19.2.8 · Tailwind CSS 4.3.3 · Vitest 4.1.10

## Global Constraints

Bu bölüm her görevin gereksinimlerine örtük olarak dahildir.

- **Solidity `0.8.26`, `evm_version = "cancun"`, `via_ir = true`.** Pazarlık konusu değil: Uniswap V4 transient storage (EIP-1153) kullanır ve Uniswap'ın kendi `v4-core/foundry.toml`'u tam olarak bu üçlüyü kullanır.
- **Ağ: Arc testnet, chainId `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`, faucet `https://faucet.circle.com`.**
- **Native USDC 18 decimal** (`msg.value`, gas, native transferler). **ERC-20 USDC 6 decimal**, adres `0x3600000000000000000000000000000000000000`. Bunlar **aynı varlığın iki görünümüdür** — asla toplanmaz, asla birbirine "swap" edilmez. Zincir üstündeki tüm pairing-asset miktarları 18 decimal native görünümdedir.
- **`C:\Users\iTopya\Desktop\arc-proje` (Limen Finance) salt-okunurdur.** Hiçbir görev oraya dosya yazmaz, taşımaz veya silmez.
- **Sayı biçimlendirme locale'i `en-US` olarak sabittir.** Hiçbir yerde locale'siz `toLocaleString` / `Intl` çağrısı yapılmaz.
- **Marka kod adı `arcpad`**, tek kaynak `web/lib/brand.ts`.
- **`forge install` KULLANILMAZ.** Depo kökü git deposu olduğu için `forge install` bağımlılıkları yanlış yere koyar ve `prefix not found` ile kırılır. Bağımlılıklar `git submodule add --depth 1 <url> contracts/lib/<ad>` ile depo kökünden eklenir; tüm forge komutları `--root contracts` alır.
- **Paket içi import'lar uzantısızdır** (`./chain`, `../src/usdc`). `moduleResolution: "bundler"` bunu açıkça destekler ve hem Vite hem Next aynı şekilde çözer.
- **Paket sürümleri tam sabittir** (aralık değil): `typescript@5.9.3`, `viem@2.55.10`, `wagmi@3.7.4`, `@tanstack/react-query@5.101.4`, `next@16.2.12`, `react@19.2.8`, `react-dom@19.2.8`, `tailwindcss@4.3.3`, `@tailwindcss/postcss@4.3.3`, `vitest@4.1.10`, `pg@8.22.0`, `tsx@4.23.1`, `dotenv@17.4.2`, `@types/node@26.1.1`, `@types/pg@8.20.0`, `@types/react@19.2.17`, `@types/react-dom@19.2.3`.
- Her görev kendi commit'iyle biter. Çalışma dalı: `phase-0-scaffold`.

---

### Task 1: Foundry çalışma alanı ve araç zinciri kanıtı

Bu görev, projedeki en riskli varsayımı en başta test eder: Solidity 0.8.26 + cancun + via_ir birleşiminin bu makinede gerçekten derlendiğini ve transient storage'ın çalıştığını.

**Files:**
- Create: `contracts/foundry.toml`
- Create: `contracts/remappings.txt`
- Create: `contracts/script/.gitkeep`
- Create: `contracts/test/Toolchain.t.sol`
- Create: `contracts/lib/forge-std` (git submodule)
- Modify: `.gitmodules` (git tarafından otomatik oluşturulur)

**Interfaces:**
- Consumes: hiçbir şey (ilk görev)
- Produces: `contracts/` altında çalışan bir Foundry çalışma alanı. Sonraki tüm Solidity görevleri `forge build --root contracts` ve `forge test --root contracts` komutlarına dayanır.

- [ ] **Step 1: Çalışma dalını oluştur**

```bash
git checkout -b phase-0-scaffold
```

- [ ] **Step 2: forge-std'yi submodule olarak ekle**

Depo kökünden çalıştır:

```bash
git submodule add --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std
mkdir -p contracts/script && touch contracts/script/.gitkeep
```

- [ ] **Step 3: Foundry yapılandırmasını yaz**

`contracts/foundry.toml`:

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"

# Uniswap V4 bu üçlüyü zorunlu kılar. v4-core'un kendi foundry.toml'u da
# tam olarak bunları kullanır; sapma "stack too deep" veya eksik TSTORE
# opcode'u olarak geri döner.
solc = "0.8.26"
evm_version = "cancun"
via_ir = true

optimizer = true
optimizer_runs = 800
bytecode_hash = "none"

# Bağımlılıkların kendi remappings.txt dosyalarını bağlamsal olarak okur.
auto_detect_remappings = true

[profile.default.fuzz]
runs = 256

[profile.default.invariant]
runs = 256
depth = 64
fail_on_revert = false

# CI profili: yerelden daha sert fuzz'lar. Foundry profilleri skaler build
# anahtarlarini miras ALMAZ, bu yuzden hepsi burada tekrarlanir.
[profile.ci]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"

solc = "0.8.26"
evm_version = "cancun"
via_ir = true

optimizer = true
optimizer_runs = 800
bytecode_hash = "none"
auto_detect_remappings = true

[profile.ci.fuzz]
runs = 5000

[profile.ci.invariant]
runs = 1000
depth = 128
fail_on_revert = false
```

- [ ] **Step 4: Remapping dosyasını yaz**

`contracts/remappings.txt` — şimdilik yalnızca forge-std; V4 satırları Task 2'de eklenecek:

```
forge-std/=lib/forge-std/src/
```

- [ ] **Step 5: Testi yaz**

`contracts/test/Toolchain.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/// @dev Uniswap V4 transient storage olmadan derlenmez. Bu test, derleyici
///      ve evm_version yapilandirmasinin EIP-1153'u gercekten destekledigini
///      kanitlar -- protokol kodu yazilmadan once.
contract ToolchainTest is Test {
    function test_transientStorageRoundTrip() public {
        uint256 readBack;
        assembly {
            tstore(0x42, 1153)
            readBack := tload(0x42)
        }
        assertEq(readBack, 1153, "EIP-1153 transient storage unavailable");
    }

    function test_mcopyIsAvailable() public pure {
        bytes memory source = hex"deadbeef";
        bytes memory destination = new bytes(4);
        assembly {
            mcopy(add(destination, 0x20), add(source, 0x20), 4)
        }
        assertEq(destination, hex"deadbeef", "EIP-5656 MCOPY unavailable");
    }
}
```

- [ ] **Step 6: Yapılandırmanın gerçekten bir şey doğruladığını kanıtla**

Testin anlamlı olduğunu göstermek için önce kırılmasını izle. `contracts/foundry.toml` içindeki `evm_version = "cancun"` satırını geçici olarak `evm_version = "paris"` yap ve çalıştır:

```bash
forge test --root contracts
```

Beklenen: derleme hatası — `"tstore" is not supported by the VM version`.

Sonra `cancun`'a geri al.

- [ ] **Step 7: Testi çalıştır ve geçtiğini doğrula**

```bash
forge test --root contracts -vv
```

Beklenen: `2 passed; 0 failed`.

- [ ] **Step 8: Formatla ve derle**

```bash
forge fmt --root contracts
forge fmt --check --root contracts
forge build --root contracts --sizes
```

Beklenen: `forge fmt` dosyaları düzenler, `--check` hatasız geçer, build başarılı.

- [ ] **Step 9: Commit**

```bash
git add .gitmodules contracts/lib/forge-std contracts/foundry.toml contracts/remappings.txt contracts/script/.gitkeep contracts/test/Toolchain.t.sol
git commit -m "build: foundry workspace on solc 0.8.26 / cancun / via_ir

Proves EIP-1153 transient storage and EIP-5656 MCOPY are available under
this config before any Uniswap V4 code depends on them."
```

---

### Task 2: Uniswap V4 bağımlılıkları ve hook derleme kanıtı

**Files:**
- Create: `contracts/lib/v4-core` (git submodule)
- Create: `contracts/lib/v4-periphery` (git submodule)
- Create: `contracts/lib/uniswap-hooks` (git submodule)
- Modify: `contracts/remappings.txt`
- Create: `contracts/test/mocks/HookWiringMock.sol`
- Create: `contracts/test/V4Wiring.t.sol`

**Interfaces:**
- Consumes: Task 1'in `contracts/foundry.toml` ve `forge test --root contracts` düzeni.
- Produces: `contracts/src/**` içinden şu import yollarının kullanılabilir olması —
  - `@uniswap/v4-core/src/interfaces/IPoolManager.sol` → `IPoolManager`
  - `@uniswap/v4-core/src/libraries/Hooks.sol` → `Hooks` (kütüphane ve `Hooks.Permissions` struct'ı)
  - `@uniswap/v4-core/src/types/PoolKey.sol` → `PoolKey`
  - `@uniswap/v4-core/src/types/Currency.sol` → `Currency`
  - `uniswap-hooks/base/BaseHook.sol` → `BaseHook`; constructor `BaseHook(IPoolManager)`, override edilmesi zorunlu tek fonksiyon `getHookPermissions() public pure returns (Hooks.Permissions memory)`
- Ayrıca `contracts/test/mocks/HookWiringMock.sol` içinden:
  - `library ArcpadHookPermissions { function permissions() internal pure returns (Hooks.Permissions memory) }` — Faz 2'deki `ArcpadHook` aynı izin kümesini buradan alacak.

  `BaseHook` **v4-periphery'de değildir** — OpenZeppelin'in `uniswap-hooks` deposuna taşınmıştır. v4-periphery yine de gereklidir çünkü `uniswap-hooks` onun `src/base/SafeCallback.sol` ve `src/base/ImmutableState.sol` dosyalarını kullanır.

- [ ] **Step 1: Üç submodule'ü ekle**

Depo kökünden:

```bash
git submodule add --depth 1 https://github.com/Uniswap/v4-core contracts/lib/v4-core
git submodule add --depth 1 https://github.com/Uniswap/v4-periphery contracts/lib/v4-periphery
git submodule add --depth 1 https://github.com/OpenZeppelin/uniswap-hooks contracts/lib/uniswap-hooks
git submodule update --init --recursive
```

Son komut şart: `v4-core` kendi `lib/openzeppelin-contracts` ve `lib/solmate` bağımlılıklarını, `v4-periphery` ise `lib/permit2` bağımlılığını submodule olarak taşır. Bunlar olmadan derleme `File not found` ile kırılır.

- [ ] **Step 2: Remapping'leri güncelle**

`contracts/remappings.txt` dosyasının **tam** içeriği:

```
forge-std/=lib/forge-std/src/
@uniswap/v4-core/=lib/v4-core/
@uniswap/v4-periphery/=lib/v4-periphery/
@openzeppelin/contracts/=lib/v4-core/lib/openzeppelin-contracts/contracts/
solmate/=lib/v4-core/lib/solmate/
permit2/=lib/v4-periphery/lib/permit2/
uniswap-hooks/=lib/uniswap-hooks/src/
```

OpenZeppelin ve solmate'in `v4-core/lib/` altından geldiğine dikkat et — ayrıca kurmuyoruz, çünkü V4'ün beklediği tam sürümler bunlar. İkinci bir kopya kurmak, aynı import yolunun farklı sürümlere çözülmesine yol açar.

- [ ] **Step 3: Test fixture'ını yaz**

`contracts/test/mocks/HookWiringMock.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "uniswap-hooks/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @dev Faz 2'de yazilacak ArcpadHook'un izin kumesi. Havuzun bize ait
///      oldugunu dogrulamak icin beforeInitialize; girdiden ucret kesmek
///      icin beforeSwap + beforeSwapReturnDelta. Deploy script'i CREATE2
///      salt'ini bu uc bayragi tasiyan bir adres bulana kadar arayacak.
library ArcpadHookPermissions {
    function permissions() internal pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}

/// @dev V4 bagimlilik kablolamasinin dogrulugunu kanitlayan fixture. Bu
///      kontrat deploy EDILMEZ: BaseHook'un constructor'i adresin izin
///      bitlerini dogrular, yani deploy etmek adres madenciligi gerektirir
///      ve o is Faz 2'ye aittir. Burada yalnizca derlendigini kanitliyoruz.
contract HookWiringMock is BaseHook {
    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return ArcpadHookPermissions.permissions();
    }
}
```

`contracts/test/V4Wiring.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {ArcpadHookPermissions, HookWiringMock} from "./mocks/HookWiringMock.sol";

contract V4WiringTest is Test {
    /// V4'te hook adresinin alt bitleri izinleri kodlar. Faz 2'deki deploy
    /// script'i CREATE2 salt'ini bu uc bayragin hepsini tasiyan bir adres
    /// bulana kadar arayacak; bayrak degerleri bu yuzden sabitlenmistir.
    function test_hookPermissionFlagValues() public pure {
        assertEq(Hooks.BEFORE_INITIALIZE_FLAG, 1 << 13);
        assertEq(Hooks.BEFORE_SWAP_FLAG, 1 << 7);
        assertEq(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG, 1 << 3);
    }

    function test_arcpadPermissionSetIsWhatPhase2Expects() public pure {
        Hooks.Permissions memory permissions = ArcpadHookPermissions.permissions();
        assertTrue(permissions.beforeInitialize);
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.beforeSwapReturnDelta);
        assertFalse(permissions.afterSwap);
        assertFalse(permissions.beforeAddLiquidity);
        assertFalse(permissions.beforeRemoveLiquidity);
    }

    /// BaseHook'u genisleten bir kontratin derlendigini kanitlar. Deploy
    /// etmeyiz: BaseHook constructor'i adres bitlerini dogrular.
    function test_baseHookWiringCompiles() public pure {
        assertGt(type(HookWiringMock).creationCode.length, 0, "BaseHook wiring failed to compile");
    }
}
```

- [ ] **Step 4: Testi çalıştır ve başarısız olduğunu gör**

Step 2'yi henüz uygulamadıysan:

```bash
forge test --root contracts --match-contract V4WiringTest
```

Beklenen hata: `Source "uniswap-hooks/base/BaseHook.sol" not found`.

- [ ] **Step 5: Derlemeyi çalıştır**

```bash
forge build --root contracts
```

Beklenen: `Compiler run successful!`. İlk derleme v4-core ve v4-periphery ağacının tamamını işlediği için birkaç dakika sürebilir.

- [ ] **Step 6: Testleri çalıştır ve geçtiklerini doğrula**

```bash
forge fmt --root contracts
forge test --root contracts -vv
```

Beklenen: `5 passed; 0 failed` (Task 1'den 2, bu görevden 3).

- [ ] **Step 7: Commit**

```bash
git add .gitmodules contracts/lib contracts/remappings.txt contracts/test
git commit -m "build: wire Uniswap v4-core, v4-periphery and OZ uniswap-hooks

BaseHook now lives in OpenZeppelin/uniswap-hooks, not v4-periphery. OZ and
solmate resolve through v4-core/lib so a single version serves the whole
graph. The permission set is extracted into a library so Phase 2's hook and
its CREATE2 address mining read the same three flags this test pins."
```

---

### Task 3: Arc ağ yapılandırması ve fork testi

Bu görevin değeri şudur: spec'in en sert kısıtı *"`anvil` Arc'ı simüle edemez"*. Arc'a özgü davranışın ancak gerçek RPC'ye karşı doğrulanabileceğini, protokol kodu yazılmadan önce çalışan bir fork testiyle kanıtlıyoruz.

**Files:**
- Modify: `contracts/foundry.toml` (`[rpc_endpoints]` bölümü ekle)
- Create: `.env.example`
- Create: `contracts/test/fork/ArcNetwork.fork.t.sol`

**Interfaces:**
- Consumes: Task 1 ve Task 2'nin Foundry düzeni.
- Produces: `contracts/test/fork/*.fork.t.sol` adlandırma deseni ve `arc_testnet` RPC takma adı. Faz 1'den itibaren tüm fork testleri bu dizinde yaşar ve normal test koşusundan `--no-match-path 'test/fork/*'` ile dışlanır.

- [ ] **Step 1: RPC uç noktasını foundry.toml'a ekle**

`contracts/foundry.toml` dosyasının **sonuna** ekle:

```toml
# Arc testnet (chainId 5042002). URL .env'den okunur, asla buraya yazilmaz.
# Arc mainnet henuz mevcut degildir.
[rpc_endpoints]
arc_testnet = "${ARC_RPC_URL}"
```

- [ ] **Step 2: Ortam değişkeni örneğini yaz**

`.env.example`:

```bash
# Arc testnet -- https://docs.arc.io/arc/references/connect-to-arc
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_CHAIN_ID=5042002
ARC_EXPLORER_URL=https://testnet.arcscan.app

# Deploy imzalama. Ozel anahtar ASLA buraya veya argv'ye yazilmaz;
# sifreli keystore hesabi kullanilir:
#   cast wallet import arcpad-deployer --interactive
ARC_KEYSTORE_ACCOUNT=arcpad-deployer

# Keeper
KEEPER_POLL_INTERVAL_MS=5000
KEEPER_DRY_RUN=true

# Postgres (Faz 3'te kullanilacak)
DATABASE_URL=postgres://arcpad:arcpad@localhost:5432/arcpad
```

- [ ] **Step 3: Fork testini yaz**

`contracts/test/fork/ArcNetwork.fork.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/// @dev Transient storage'i gercek Arc calistirma katmaninda deneyen yardimci.
///      Yerel EVM'de gecmesi Arc'ta gececegi anlamina gelmez; bu yuzden ayni
///      kontrol hem birim hem fork testinde var.
contract TransientProbe {
    function roundTrip(uint256 value) external returns (uint256 readBack) {
        assembly {
            tstore(0, value)
            readBack := tload(0)
        }
    }
}

contract ArcNetworkForkTest is Test {
    /// Arc'ta native varlik USDC'nin kendisidir. Bu adres ayni bakiyenin
    /// 6 decimal'lik ERC-20 gorunumudur -- ayri bir token DEGILDIR.
    address internal constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    function test_forkIsArcTestnet() public view {
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID, "fork is not Arc testnet");
    }

    function test_expectedSystemContractsArePresent() public view {
        assertGt(USDC_ERC20.code.length, 0, "USDC ERC-20 view missing");
        assertGt(MULTICALL3.code.length, 0, "Multicall3 missing");
        assertGt(PERMIT2.code.length, 0, "Permit2 missing");
    }

    /// Uniswap V4 icin hayati: Arc bu opcode'u desteklemezse V4 hic calismaz.
    function test_transientStorageWorksOnArc() public {
        TransientProbe probe = new TransientProbe();
        assertEq(probe.roundTrip(1153), 1153, "EIP-1153 unavailable on Arc");
    }

    /// Kanonik Uniswap deployment'i Arc testnet'te YOKTUR. Bu test bunu
    /// belgeler; bir gun gecmeye baslarsa Faz 2'nin kendi PoolManager'ini
    /// deploy etme karari yeniden degerlendirilmelidir.
    function test_noCanonicalUniswapDeploymentOnArcTestnet() public view {
        address canonicalV3Factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        assertEq(
            canonicalV3Factory.code.length,
            0,
            "canonical Uniswap appeared on Arc testnet - revisit Phase 2 plan"
        );
    }
}
```

- [ ] **Step 4: Fork testini çalıştır**

```bash
forge test --root contracts --match-path 'test/fork/*' --fork-url https://rpc.testnet.arc.network -vv
```

Beklenen: `4 passed; 0 failed`.

- [ ] **Step 5: Fork testlerinin normal koşuda atlandığını doğrula**

Fork testleri harici RPC'ye bağımlıdır; varsayılan koşuda çalışmamalı:

```bash
forge test --root contracts --no-match-path 'test/fork/*' -vv
```

Beklenen: `5 passed` (Task 1 ve 2'nin testleri), fork testleri listede yok.

- [ ] **Step 6: Commit**

```bash
forge fmt --root contracts
git add contracts/foundry.toml contracts/test/fork .env.example
git commit -m "test: prove Arc testnet fork works before writing protocol code

anvil cannot reproduce Arc's execution layer, so Arc-specific behaviour is
only observable against the real RPC. Pins chainId 5042002, the USDC ERC-20
view, Multicall3, Permit2 and EIP-1153 support. Also asserts no canonical
Uniswap deployment exists yet, which is what Phase 2's own-deployment
decision rests on."
```

---

### Task 4: pnpm workspace ve `packages/shared`

**Files:**
- Create: `package.json` (kök)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/chain.ts`
- Create: `packages/shared/src/usdc.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/test/usdc.test.ts`
- Create: `packages/shared/test/chain.test.ts`

**Interfaces:**
- Consumes: hiçbir Solidity çıktısı (Faz 0'da henüz ABI yok).
- Produces: `@arcpad/shared` paketinden —
  - `arcTestnet: Chain` — viem `defineChain` çıktısı, `id: 5042002`
  - `ARC_TESTNET_CHAIN_ID: 5042002`
  - `USDC_ERC20_ADDRESS: '0x3600000000000000000000000000000000000000'`
  - `NATIVE_USDC_DECIMALS: 18`, `ERC20_USDC_DECIMALS: 6`
  - `nativeToErc20(native: bigint): bigint` — 18 → 6 görünüm, aşağı yuvarlar
  - `erc20ToNative(erc20: bigint): bigint` — 6 → 18 görünüm, kayıpsız
  - `formatUsdc(native: bigint, opts?: { maxFractionDigits?: number }): string` — 18 decimal native değeri `en-US` biçiminde dizeye çevirir

- [ ] **Step 1: pnpm'i etkinleştir**

pnpm bu makinede kurulu değil; Node 24 ile gelen corepack üzerinden etkinleştir:

```bash
corepack enable pnpm
pnpm --version
```

Beklenen: bir sürüm numarası yazdırır.

- [ ] **Step 2: Workspace dosyalarını yaz**

Kök `package.json`:

```json
{
  "name": "arcpad",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r --if-present build"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "@types/node": "26.1.1"
  },
  "packageManager": "pnpm@11.17.0"
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - indexer
  - keeper
  - web
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 3: shared paketinin iskeletini yaz**

`packages/shared/package.json`:

```json
{
  "name": "@arcpad/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "viem": "2.55.10"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Bağımlılıkları kur**

```bash
pnpm install
```

- [ ] **Step 5: Başarısız testleri yaz**

`packages/shared/test/usdc.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { erc20ToNative, formatUsdc, nativeToErc20 } from '../src/usdc'

describe('USDC iki gorunum arasinda donusum', () => {
  it('18 decimal native degeri 6 decimal ERC-20 gorunumune indirir', () => {
    // 1 USDC = 1e18 native = 1e6 ERC-20
    expect(nativeToErc20(1_000_000_000_000_000_000n)).toBe(1_000_000n)
  })

  it('mikro-USDC altindaki kalintiyi asagi yuvarlar, yukari degil', () => {
    // 1.9999995 mikro-USDC: ERC-20 gorunumu 1 mikro-USDC gormelidir.
    expect(nativeToErc20(1_999_999_500_000n)).toBe(1n)
  })

  it('6 decimal ERC-20 degeri kayipsiz sekilde native gorunume cikarir', () => {
    expect(erc20ToNative(1_000_000n)).toBe(1_000_000_000_000_000_000n)
  })

  it('gidis-donus asla deger yaratmaz', () => {
    const native = 1_234_567_891_234_567_891n
    expect(erc20ToNative(nativeToErc20(native))).toBeLessThanOrEqual(native)
  })

  it('sifiri sifir olarak korur', () => {
    expect(nativeToErc20(0n)).toBe(0n)
    expect(erc20ToNative(0n)).toBe(0n)
  })
})

describe('formatUsdc', () => {
  it('locale bagimsiz olarak nokta ondalik kullanir', () => {
    // Makinenin locale'i tr-TR olsa bile virgul ondalik URETMEMELI.
    expect(formatUsdc(1_234_500_000_000_000_000_000n)).toBe('1,234.50')
  })

  it('varsayilan olarak iki ondalik basamak gosterir', () => {
    expect(formatUsdc(1_000_000_000_000_000_000n)).toBe('1.00')
  })

  it('istendiginde daha fazla ondalik basamak gosterir', () => {
    // 1.5e12 native = 0.0000015 USDC; 7 basamak istenmezse yuvarlanir.
    expect(formatUsdc(1_500_000_000_000n, { maxFractionDigits: 7 })).toBe('0.0000015')
  })
})
```

`packages/shared/test/chain.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ARC_TESTNET_CHAIN_ID, arcTestnet, USDC_ERC20_ADDRESS } from '../src/chain'

describe('arcTestnet zincir tanimi', () => {
  it('Arc testnet chain id kullanir', () => {
    expect(arcTestnet.id).toBe(5042002)
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002)
  })

  it('native para birimini 18 decimal USDC olarak bildirir', () => {
    expect(arcTestnet.nativeCurrency.symbol).toBe('USDC')
    expect(arcTestnet.nativeCurrency.decimals).toBe(18)
  })

  it('resmi RPC ve explorer adreslerini tasir', () => {
    expect(arcTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.network')
    expect(arcTestnet.blockExplorers?.default.url).toBe('https://testnet.arcscan.app')
  })

  it('USDC ERC-20 gorunumunu sistem adresinde tutar', () => {
    expect(USDC_ERC20_ADDRESS).toBe('0x3600000000000000000000000000000000000000')
  })
})
```

- [ ] **Step 6: Testleri çalıştır, başarısız olduklarını doğrula**

```bash
pnpm --filter @arcpad/shared test
```

Beklenen: `Failed to resolve import "../src/usdc"` benzeri hatalarla FAIL.

- [ ] **Step 7: Implementasyonu yaz**

`packages/shared/src/chain.ts`:

```ts
import { defineChain } from 'viem'

export const ARC_TESTNET_CHAIN_ID = 5042002 as const

/**
 * Arc'ta native varlik USDC'nin kendisidir; native gorunum 18 decimal'dir.
 * Zincir tanimini viem'den ice aktarmak yerine burada tanimliyoruz: viem'in
 * hangi surumde Arc'i tasidigina bagli kalmamak ve tek bir dogruluk kaynagi
 * birakmak icin.
 */
export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arc.network'],
      webSocket: ['wss://rpc.testnet.arc.network'],
    },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  testnet: true,
})

/**
 * USDC'nin 6 decimal'lik ERC-20 gorunumu. Native bakiyeyle AYNI fonu temsil
 * eder -- ayri bir token degildir. Ikisi asla toplanmaz.
 */
export const USDC_ERC20_ADDRESS = '0x3600000000000000000000000000000000000000' as const
```

`packages/shared/src/usdc.ts`:

```ts
export const NATIVE_USDC_DECIMALS = 18 as const
export const ERC20_USDC_DECIMALS = 6 as const

/** Iki gorunum arasindaki olcek farki: 1e18 native = 1e6 ERC-20. */
const VIEW_SCALE = 10n ** BigInt(NATIVE_USDC_DECIMALS - ERC20_USDC_DECIMALS)
const NATIVE_SCALE = 10n ** BigInt(NATIVE_USDC_DECIMALS)

/**
 * 18 decimal native gorunumu 6 decimal ERC-20 gorunumune indirir.
 * Asagi yuvarlar: ERC-20 arayuzu mikro-USDC altini gosteremez ve yukari
 * yuvarlamak var olmayan bakiye uydurmak olurdu.
 */
export function nativeToErc20(native: bigint): bigint {
  return native / VIEW_SCALE
}

/** 6 decimal ERC-20 gorunumu 18 decimal native gorunume cikarir. Kayipsizdir. */
export function erc20ToNative(erc20: bigint): bigint {
  return erc20 * VIEW_SCALE
}

const FORMATTERS = new Map<number, Intl.NumberFormat>()

function formatterFor(maxFractionDigits: number): Intl.NumberFormat {
  let formatter = FORMATTERS.get(maxFractionDigits)
  if (!formatter) {
    // Locale ACIKCA sabitlenmistir. Sabitlenmezse ayni dize bir kullanici
    // icin "bin iki yuz otuz dort", digeri icin "bir virgul iki uc dort"
    // okunur; para soz konusuyken bu kabul edilemez.
    formatter = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: Math.min(2, maxFractionDigits),
      maximumFractionDigits: maxFractionDigits,
    })
    FORMATTERS.set(maxFractionDigits, formatter)
  }
  return formatter
}

/**
 * 18 decimal native USDC miktarini goruntulenebilir bir dizeye cevirir.
 * Number'a cevirmeden once bigint aritmetigiyle tam ve kesir kismina ayirir,
 * boylece buyuk miktarlarda hassasiyet kaybi olmaz.
 */
export function formatUsdc(native: bigint, opts?: { maxFractionDigits?: number }): string {
  const maxFractionDigits = opts?.maxFractionDigits ?? 2
  const whole = native / NATIVE_SCALE
  const fraction = native % NATIVE_SCALE

  const asNumber = Number(whole) + Number(fraction) / Number(NATIVE_SCALE)
  return formatterFor(maxFractionDigits).format(asNumber)
}
```

`packages/shared/src/index.ts`:

```ts
export { ARC_TESTNET_CHAIN_ID, arcTestnet, USDC_ERC20_ADDRESS } from './chain'
export {
  ERC20_USDC_DECIMALS,
  erc20ToNative,
  formatUsdc,
  NATIVE_USDC_DECIMALS,
  nativeToErc20,
} from './usdc'
```

- [ ] **Step 8: Testleri çalıştır ve geçtiklerini doğrula**

```bash
pnpm --filter @arcpad/shared test
pnpm --filter @arcpad/shared typecheck
```

Beklenen: `12 passed` ve typecheck hatasız.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json packages/shared
git commit -m "feat(shared): arc chain definition and USDC dual-view helpers

Arc's native asset is USDC itself: 18 decimals natively, 6 through the
ERC-20 view at 0x3600...0000. They are one balance seen two ways, so the
conversion helpers only ever narrow (rounding down) or widen losslessly,
never sum. Number formatting pins en-US so a decimal separator can never be
read two ways."
```

---

### Task 5: Indexer iskeleti

**Files:**
- Create: `indexer/package.json`
- Create: `indexer/tsconfig.json`
- Create: `indexer/vitest.config.ts`
- Create: `indexer/src/client.ts`
- Create: `indexer/src/cursor.ts`
- Create: `indexer/src/index.ts`
- Create: `indexer/test/cursor.test.ts`

**Interfaces:**
- Consumes: `@arcpad/shared` → `arcTestnet`, `ARC_TESTNET_CHAIN_ID`
- Produces:
  - `createArcClient(rpcUrl: string): PublicClient` — Arc'a bağlı viem public client
  - `nextRange(cursor: bigint, head: bigint, maxSpan: bigint): { from: bigint; to: bigint } | null` — işlenecek bir sonraki blok aralığı; işlenecek şey yoksa `null`

- [ ] **Step 1: Paket dosyalarını yaz**

`indexer/package.json`:

```json
{
  "name": "@arcpad/indexer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@arcpad/shared": "workspace:*",
    "dotenv": "17.4.2",
    "pg": "8.22.0",
    "viem": "2.55.10"
  },
  "devDependencies": {
    "@types/pg": "8.20.0",
    "tsx": "4.23.1",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

`indexer/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`indexer/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 2: Başarısız testi yaz**

`indexer/test/cursor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { nextRange } from '../src/cursor'

describe('nextRange', () => {
  it('imlec head ile ayniysa islenecek bir sey yoktur', () => {
    expect(nextRange(100n, 100n, 1000n)).toBeNull()
  })

  it('imlec head gerisindeyse imlecten sonraki bloktan baslar', () => {
    expect(nextRange(100n, 150n, 1000n)).toEqual({ from: 101n, to: 150n })
  })

  it('araligi maxSpan ile sinirlar', () => {
    expect(nextRange(0n, 10_000n, 500n)).toEqual({ from: 1n, to: 500n })
  })

  it('head imlecin gerisine duserse null doner (yeniden baglanma guvenligi)', () => {
    expect(nextRange(200n, 150n, 1000n)).toBeNull()
  })

  it('tam olarak maxSpan kadar blok kaldiginda tek aralikta bitirir', () => {
    expect(nextRange(0n, 500n, 500n)).toEqual({ from: 1n, to: 500n })
  })
})
```

- [ ] **Step 3: Testi çalıştır ve başarısız olduğunu doğrula**

```bash
pnpm install
pnpm --filter @arcpad/indexer test
```

Beklenen: `Failed to resolve import "../src/cursor"` ile FAIL.

- [ ] **Step 4: Implementasyonu yaz**

`indexer/src/cursor.ts`:

```ts
/**
 * Islenecek bir sonraki blok araligini hesaplar.
 *
 * Arc'ta deterministik finality vardir (~350ms, reorg yok), bu yuzden geri
 * alma mantigi yoktur. `head` her zaman `finalized` etiketinden okunur ve
 * imlecten geriye duserse -- ki bu yalnizca RPC degistirdigimizde veya bir
 * dugum geride kaldiginda olur -- hicbir sey islemeyiz.
 */
export function nextRange(
  cursor: bigint,
  head: bigint,
  maxSpan: bigint,
): { from: bigint; to: bigint } | null {
  if (head <= cursor) return null

  const from = cursor + 1n
  const remaining = head - cursor
  const to = remaining > maxSpan ? cursor + maxSpan : head

  return { from, to }
}
```

`indexer/src/client.ts`:

```ts
import { arcTestnet } from '@arcpad/shared'
import { createPublicClient, http, type PublicClient } from 'viem'

export function createArcClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  })
}
```

`indexer/src/index.ts`:

```ts
import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared'
import { createArcClient } from './client'
import { nextRange } from './cursor'

const MAX_SPAN = 1_000n

async function main(): Promise<void> {
  const rpcUrl = process.env['ARC_RPC_URL']
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  const client = createArcClient(rpcUrl)

  const chainId = await client.getChainId()
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`connected to chain ${chainId}, expected ${ARC_TESTNET_CHAIN_ID}`)
  }

  const head = await client.getBlock({ blockTag: 'finalized' })
  // Faz 3'te imlec Postgres'ten okunacak. Faz 0'da yalnizca baglantinin ve
  // aralik hesabinin calistigini gosteriyoruz.
  const range = nextRange(head.number - 10n, head.number, MAX_SPAN)

  console.log(`arc chainId=${chainId} finalizedHead=${head.number} nextRange=`, range)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
```

- [ ] **Step 5: Testleri ve typecheck'i çalıştır**

```bash
pnpm --filter @arcpad/indexer test
pnpm --filter @arcpad/indexer typecheck
```

Beklenen: `5 passed`, typecheck hatasız.

- [ ] **Step 6: Gerçek RPC'ye karşı bir kez elle çalıştır**

```bash
cp .env.example .env
pnpm --filter @arcpad/indexer start
```

Beklenen çıktı biçimi: `arc chainId=5042002 finalizedHead=<sayı> nextRange= { from: ..., to: ... }`.

`.env` `.gitignore` kapsamındadır; commit edilmez.

- [ ] **Step 7: Commit**

```bash
git add indexer pnpm-lock.yaml
git commit -m "feat(indexer): arc client and block-range cursor

Arc has deterministic finality and no reorgs, so the cursor only moves
forward from the finalized tag; reprocessing is handled by idempotent
writes later, not by rollback logic."
```

---

### Task 6: Keeper iskeleti

**Files:**
- Create: `keeper/package.json`
- Create: `keeper/tsconfig.json`
- Create: `keeper/vitest.config.ts`
- Create: `keeper/src/config.ts`
- Create: `keeper/src/index.ts`
- Create: `keeper/test/config.test.ts`

**Interfaces:**
- Consumes: `@arcpad/shared` → `arcTestnet`, `ARC_TESTNET_CHAIN_ID`
- Produces: `loadKeeperConfig(env: NodeJS.ProcessEnv): KeeperConfig` — `{ rpcUrl: string; pollIntervalMs: number; dryRun: boolean }`. Eksik veya geçersiz değerlerde `Error` fırlatır.

- [ ] **Step 1: Paket dosyalarını yaz**

`keeper/package.json`:

```json
{
  "name": "@arcpad/keeper",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@arcpad/shared": "workspace:*",
    "dotenv": "17.4.2",
    "viem": "2.55.10"
  },
  "devDependencies": {
    "tsx": "4.23.1",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

`keeper/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`keeper/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 2: Başarısız testi yaz**

`keeper/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadKeeperConfig } from '../src/config'

describe('loadKeeperConfig', () => {
  it('gecerli ortamdan yapilandirma uretir', () => {
    const config = loadKeeperConfig({
      ARC_RPC_URL: 'https://rpc.testnet.arc.network',
      KEEPER_POLL_INTERVAL_MS: '2000',
      KEEPER_DRY_RUN: 'false',
    })
    expect(config).toEqual({
      rpcUrl: 'https://rpc.testnet.arc.network',
      pollIntervalMs: 2000,
      dryRun: false,
    })
  })

  it('ARC_RPC_URL yoksa hata firlatir', () => {
    expect(() => loadKeeperConfig({})).toThrow(/ARC_RPC_URL/)
  })

  it('poll araligi belirtilmezse 5000 ms varsayar', () => {
    const config = loadKeeperConfig({ ARC_RPC_URL: 'https://rpc.testnet.arc.network' })
    expect(config.pollIntervalMs).toBe(5000)
  })

  it('guvenli tarafta durur: dryRun varsayilan olarak aciktir', () => {
    const config = loadKeeperConfig({ ARC_RPC_URL: 'https://rpc.testnet.arc.network' })
    expect(config.dryRun).toBe(true)
  })

  it('poll araligi sayi degilse hata firlatir', () => {
    expect(() =>
      loadKeeperConfig({
        ARC_RPC_URL: 'https://rpc.testnet.arc.network',
        KEEPER_POLL_INTERVAL_MS: 'soon',
      }),
    ).toThrow(/KEEPER_POLL_INTERVAL_MS/)
  })
})
```

- [ ] **Step 3: Testi çalıştır ve başarısız olduğunu doğrula**

```bash
pnpm install
pnpm --filter @arcpad/keeper test
```

Beklenen: import çözülemediği için FAIL.

- [ ] **Step 4: Implementasyonu yaz**

`keeper/src/config.ts`:

```ts
export interface KeeperConfig {
  rpcUrl: string
  pollIntervalMs: number
  dryRun: boolean
}

const DEFAULT_POLL_INTERVAL_MS = 5_000

/**
 * Keeper zincire islem gonderir, bu yuzden varsayilan davranisi GUVENLI
 * olmalidir: `KEEPER_DRY_RUN` acikca "false" yapilmadikca hicbir islem
 * yayinlanmaz. Yanlis yapilandirilmis bir keeper'in sessizce imzalamaya
 * baslamasi, hic calismamasindan cok daha pahalidir.
 */
export function loadKeeperConfig(env: NodeJS.ProcessEnv): KeeperConfig {
  const rpcUrl = env['ARC_RPC_URL']
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  const rawInterval = env['KEEPER_POLL_INTERVAL_MS']
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  if (rawInterval !== undefined) {
    pollIntervalMs = Number(rawInterval)
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error(`KEEPER_POLL_INTERVAL_MS must be a positive integer, got "${rawInterval}"`)
    }
  }

  return {
    rpcUrl,
    pollIntervalMs,
    dryRun: env['KEEPER_DRY_RUN'] !== 'false',
  }
}
```

`keeper/src/index.ts`:

```ts
import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, arcTestnet } from '@arcpad/shared'
import { createPublicClient, http } from 'viem'
import { loadKeeperConfig } from './config'

async function main(): Promise<void> {
  const config = loadKeeperConfig(process.env)
  const client = createPublicClient({ chain: arcTestnet, transport: http(config.rpcUrl) })

  const chainId = await client.getChainId()
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`connected to chain ${chainId}, expected ${ARC_TESTNET_CHAIN_ID}`)
  }

  // Faz 7'de burada limit emir tetikleme dongusu olacak. Faz 0'da yalnizca
  // yapilandirma ve baglantinin dogru oldugunu gosteriyoruz.
  console.log(
    `keeper ready chainId=${chainId} pollIntervalMs=${config.pollIntervalMs} dryRun=${config.dryRun}`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
```

- [ ] **Step 5: Testleri ve typecheck'i çalıştır**

```bash
pnpm --filter @arcpad/keeper test
pnpm --filter @arcpad/keeper typecheck
```

Beklenen: `5 passed`, typecheck hatasız.

- [ ] **Step 6: Commit**

```bash
git add keeper pnpm-lock.yaml
git commit -m "feat(keeper): config loader with dry-run by default

A misconfigured keeper that silently starts signing is far more expensive
than one that does nothing, so KEEPER_DRY_RUN must be explicitly set to
'false' before any transaction is broadcast."
```

---

### Task 7: Web iskeleti

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/next.config.ts`
- Create: `web/postcss.config.mjs`
- Create: `web/vitest.config.ts`
- Create: `web/lib/brand.ts`
- Create: `web/lib/wagmi.ts`
- Create: `web/app/globals.css`
- Create: `web/app/layout.tsx`
- Create: `web/app/page.tsx`
- Create: `web/app/providers.tsx`
- Create: `web/test/brand.test.ts`

**Interfaces:**
- Consumes: `@arcpad/shared` → `arcTestnet`, `formatUsdc`
- Produces:
  - `BRAND: { name: string; wordmark: string; tagline: string }` — `web/lib/brand.ts`, marka kararı geldiğinde değişecek tek yer
  - `wagmiConfig` — `web/lib/wagmi.ts`, Arc testnet'e bağlı wagmi yapılandırması

- [ ] **Step 1: Paket ve yapılandırma dosyalarını yaz**

`web/package.json`:

```json
{
  "name": "@arcpad/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@arcpad/shared": "workspace:*",
    "@tanstack/react-query": "5.101.4",
    "next": "16.2.12",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "viem": "2.55.10",
    "wagmi": "3.7.4"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "4.3.3",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "tailwindcss": "4.3.3",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

`web/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`web/next.config.ts`:

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@arcpad/shared'],
}

export default nextConfig
```

`web/postcss.config.mjs`:

```js
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
```

`web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 2: Başarısız testi yaz**

`web/test/brand.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BRAND } from '../lib/brand'

describe('BRAND', () => {
  it('marka adini tek bir yerden verir', () => {
    expect(BRAND.name).toBe('arcpad')
  })

  it('wordmark ile ad ayni kaynaktan turer', () => {
    expect(BRAND.wordmark).toBe(BRAND.name)
  })

  it('tagline zinciri adiyla anar', () => {
    expect(BRAND.tagline).toContain('Arc')
  })
})
```

- [ ] **Step 3: Testi çalıştır ve başarısız olduğunu doğrula**

```bash
pnpm install
pnpm --filter @arcpad/web test
```

Beklenen: import çözülemediği için FAIL.

- [ ] **Step 4: Marka ve wagmi yapılandırmasını yaz**

`web/lib/brand.ts`:

```ts
/**
 * Marka kimliginin TEK kaynagi. "arcpad" gecici bir kod adidir; nihai marka
 * karari verildiginde yalnizca bu dosya degisir.
 */
export const BRAND = {
  name: 'arcpad',
  wordmark: 'arcpad',
  tagline: 'Launch and explore fixed-supply tokens on Arc.',
} as const
```

`web/lib/wagmi.ts`:

```ts
import { arcTestnet } from '@arcpad/shared'
import { createConfig, http } from 'wagmi'

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http(),
  },
  ssr: true,
})
```

- [ ] **Step 5: Tailwind tokenlarını ve uygulama iskeletini yaz**

`web/app/globals.css` — spec §7.3'teki tasarım tokenları, Tailwind 4'ün CSS-first `@theme` bloğuyla. `--color-*` ve `--radius-*` isim uzayları `bg-surface`, `text-accent`, `border-border`, `rounded-card` gibi yardımcı sınıfları otomatik üretir:

```css
@import 'tailwindcss';

@theme {
  --color-bg: #0b0b0b;
  --color-surface: #141414;
  --color-border: rgb(255 255 255 / 8%);
  --color-text: #fafafa;
  --color-muted: #8a8a8a;
  --color-accent: #c6f24e;
  --color-primary: #7e8f2e;

  --radius-card: 20px;
  --radius-input: 14px;
}

body {
  background-color: var(--color-bg);
  color: var(--color-text);
}
```

`web/app/providers.tsx`:

```tsx
'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from '@/lib/wagmi'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
```

`web/app/layout.tsx`:

```tsx
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { BRAND } from '@/lib/brand'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

`web/app/page.tsx`:

```tsx
import { arcTestnet, formatUsdc } from '@arcpad/shared'
import { BRAND } from '@/lib/brand'

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-semibold text-accent">{BRAND.wordmark}</h1>
      <p className="text-muted">{BRAND.tagline}</p>
      <dl className="rounded-card border border-border bg-surface p-6 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Network</dt>
          <dd>{arcTestnet.name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Chain ID</dt>
          <dd>{arcTestnet.id}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Formatting check</dt>
          <dd>${formatUsdc(1_234_500_000_000_000_000_000n)}</dd>
        </div>
      </dl>
    </main>
  )
}
```

- [ ] **Step 6: Testi, typecheck'i ve build'i çalıştır**

```bash
pnpm --filter @arcpad/web test
pnpm --filter @arcpad/web typecheck
pnpm --filter @arcpad/web build
```

Beklenen: `3 passed`, typecheck hatasız, Next build başarılı.

- [ ] **Step 7: Sayfayı tarayıcıda bir kez doğrula**

```bash
pnpm --filter @arcpad/web dev
```

`http://localhost:3000` adresinde şunları gör: lime renkli `arcpad` başlığı, koyu arka plan ve `Formatting check` satırında **`$1,234.50`** — nokta ondalıklı. Virgül ondalık görürsen locale sabitlemesi çalışmıyor demektir.

- [ ] **Step 8: Commit**

```bash
git add web pnpm-lock.yaml
git commit -m "feat(web): next 16 shell with arc wagmi config and design tokens

Brand identity lives behind a single BRAND constant so the codename can be
replaced in one file. Tailwind 4 @theme carries the design tokens read off
the reference screenshots. The landing page renders a formatted USDC amount
so a locale regression is visible immediately."
```

---

### Task 8: Makefile, CI ve depo dokümantasyonu

**Files:**
- Create: `Makefile`
- Create: `.github/workflows/contracts.yml`
- Create: `.github/workflows/node.yml`
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Modify: `docs/specs/2026-07-27-arcpad-design.md` (repo düzenine `docs/plans/` satırını ekle)

**Interfaces:**
- Consumes: Task 1–7'nin tüm komutları.
- Produces: `make install`, `make build`, `make test`, `make fmt`, `make fmt-check`, `make fork-test`, `make dev`, `make clean` hedefleri ve iki CI kapısı.

Slither bu fazda **eklenmez**: `contracts/src/` henüz boştur, analiz edecek birinci taraf kontrat yoktur. Slither yapılandırması ve triage allowlist'i Faz 1'in planına aittir, ilk kontrat yazıldığında.

- [ ] **Step 1: Makefile'ı yaz**

`Makefile` (girintiler sekme karakteri olmalı, boşluk değil):

```makefile
.PHONY: install build test fmt fmt-check fork-test dev clean

install:
	corepack enable pnpm
	pnpm install
	git submodule update --init --recursive

build:
	forge build --root contracts --sizes
	pnpm -r --if-present build

test:
	forge test --root contracts --no-match-path 'test/fork/*' -vv
	pnpm -r test

fmt:
	forge fmt --root contracts

fmt-check:
	forge fmt --check --root contracts

# Arc'a ozgu davranis yalnizca gercek RPC'de gozlemlenebilir; anvil bunu
# yeniden uretemez.
fork-test:
	forge test --root contracts --match-path 'test/fork/*' --fork-url $(ARC_RPC_URL) -vv

dev:
	pnpm --filter @arcpad/web dev

clean:
	forge clean --root contracts
	rm -rf node_modules packages/*/node_modules indexer/node_modules keeper/node_modules web/node_modules web/.next
```

- [ ] **Step 2: Kontrat CI iş akışını yaz**

`.github/workflows/contracts.yml`:

```yaml
name: contracts

on:
  push:
    branches: [main]
  pull_request:

jobs:
  forge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - uses: foundry-rs/foundry-toolchain@v1

      - name: Formatting
        run: forge fmt --check --root contracts

      - name: Build
        run: forge build --root contracts --sizes

      - name: Test
        run: forge test --root contracts --no-match-path 'test/fork/*' -vv
        env:
          FOUNDRY_PROFILE: ci

  fork:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - uses: foundry-rs/foundry-toolchain@v1

      # Fork testleri harici bir RPC'ye baglidir; kesintisi PR'lari
      # bloklamamali, ama Arc davranisindaki bir degisikligi erken gormeliyiz.
      - name: Arc fork test
        run: forge test --root contracts --match-path 'test/fork/*' --fork-url https://rpc.testnet.arc.network -vv
```

- [ ] **Step 3: Node CI iş akışını yaz**

`.github/workflows/node.yml`:

```yaml
name: node

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Enable pnpm
        run: corepack enable pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm -r typecheck

      - name: Test
        run: pnpm -r test

      - name: Build web
        run: pnpm --filter @arcpad/web build
```

- [ ] **Step 4: README'yi yaz**

`README.md`:

~~~markdown
# arcpad

Circle'ın Arc L1'i üzerinde sabit arzlı token launchpad'i. Tüm arz bir bonding
curve'de satışa çıkar; curve tükendiğinde launch, likiditesi kalıcı olarak
kilitlenmiş bir Uniswap V4 havuzuna graduate olur. Karşı bacak Arc'ın native
para birimi olan USDC'dir.

> `arcpad` geçici bir kod adıdır.

## Düzen

| Dizin | İçerik |
|---|---|
| `contracts/` | Foundry çalışma alanı (solc 0.8.26, cancun, via_ir) |
| `indexer/` | Zinciri okuyup Postgres'e yazan TypeScript servisi |
| `keeper/` | Limit emir tetikleyici ve graduation itici |
| `web/` | Next.js arayüzü |
| `packages/shared/` | Zincir tanımı, USDC yardımcıları — tek kaynak |
| `docs/specs/` | Tasarım dokümanları |
| `docs/plans/` | Faz faz uygulama planları |

## Başlangıç

```bash
make install
cp .env.example .env
make test
```

## Ağ

Arc testnet, chainId `5042002`. Native gas token USDC'dir: native görünüm 18
decimal, ERC-20 görünümü 6 decimal (`0x3600000000000000000000000000000000000000`).
**Bunlar aynı bakiyenin iki görünümüdür, iki ayrı varlık değil.**

Test USDC'si: https://faucet.circle.com

## Komutlar

| Komut | Ne yapar |
|---|---|
| `make build` | Kontratları ve TypeScript paketlerini derler |
| `make test` | Birim testleri (fork testleri hariç) |
| `make fork-test` | Arc testnet fork'una karşı davranış testleri |
| `make fmt` | Solidity formatlar |
| `make dev` | Web arayüzünü geliştirme modunda başlatır |
~~~

- [ ] **Step 5: CONTRIBUTING'i yaz**

`CONTRIBUTING.md`:

```markdown
# Katkı rehberi

## Kırılmaz kurallar

- **`C:\Users\iTopya\Desktop\arc-proje` (Limen Finance) salt-okunurdur.** Oradan
  desen kopyalanır, oraya hiçbir şey yazılmaz.
- **Özel anahtarlar asla argv'de veya `.env`'de taşınmaz.** Şifreli keystore
  kullanılır: `cast wallet import arcpad-deployer --interactive`
- **`forge install` kullanılmaz.** Depo kökü git deposu olduğu için bağımlılıklar
  yanlış yere kurulur ve komut `prefix not found` ile kırılır. Bunun yerine:
  `git submodule add --depth 1 <url> contracts/lib/<ad>`
- **Tüm forge komutları `--root contracts` alır.**
- **Native USDC (18 decimal) ile ERC-20 USDC (6 decimal) aynı varlıktır.**
  Asla toplanmaz, asla birbirine çevrilerek "swap" edilmez.
- **Sayı biçimlendirmede locale her zaman `en-US` olarak verilir.**
- **TypeScript import'ları uzantısızdır** (`./chain`, `../src/usdc`).

## Build yapılandırması

`solc 0.8.26`, `evm_version = "cancun"`, `via_ir = true`. Üçü de Uniswap V4'ün
gereğidir ve v4-core'un kendi yapılandırmasıyla aynıdır. Değiştirme.

## Test katmanları

| Katman | Komut | Nerede koşar |
|---|---|---|
| Birim / fuzz / invariant | `make test` | Standart EVM |
| Fork | `make fork-test` | Gerçek Arc testnet |

`anvil` Arc'ı simüle **edemez** — native USDC davranışı, EIP-7708 `Transfer`
logları ve blocklist yalnızca gerçek RPC'de görünür. Arc'a özgü her iddia bir
fork testiyle desteklenmelidir.

## Commit

Her görev kendi commit'iyle biter. Commit mesajları neden'i anlatır, ne'yi değil.
```

- [ ] **Step 6: Spec'teki repo düzenini güncelle**

`docs/specs/2026-07-27-arcpad-design.md` içinde şu satırı bul:

```
├── docs/specs/       Bu doküman ve uygulama planları
```

ve şununla değiştir:

```
├── docs/specs/       Tasarım dokümanları
├── docs/plans/       Faz faz uygulama planları
```

- [ ] **Step 7: Her şeyi baştan sona çalıştır**

```bash
make fmt-check
make build
make test
ARC_RPC_URL=https://rpc.testnet.arc.network make fork-test
```

Beklenen: dördü de hatasız. `make test` çıktısında **5 Solidity testi** ve **25 TypeScript testi** (shared 12, indexer 5, keeper 5, web 3) görünmeli.

- [ ] **Step 8: Commit ve dalı birleştir**

```bash
git add Makefile .github README.md CONTRIBUTING.md docs/specs/2026-07-27-arcpad-design.md
git commit -m "build: makefile, CI gates and repo documentation

Fork tests run in a separate continue-on-error job: they depend on an
external RPC, so an outage must not block PRs, but a change in Arc's
behaviour should still be visible. Slither lands in Phase 1, when the first
first-party contract exists for it to analyse."

git checkout main
git merge --no-ff phase-0-scaffold -m "Merge phase 0: toolchain scaffolding"
```

---

## Faz 0 tamamlanma ölçütü

Aşağıdakilerin hepsi doğruysa Faz 0 bitmiştir:

- [ ] `make test` yeşil: 5 Solidity testi + 25 TypeScript testi
- [ ] `ARC_RPC_URL=... make fork-test` yeşil: Arc testnet'e karşı 4 test
- [ ] `make build` hatasız: kontratlar derleniyor, `web` build alıyor
- [ ] `make fmt-check` hatasız
- [ ] `pnpm --filter @arcpad/web dev` ile açılan sayfada `$1,234.50` **nokta ondalıkla** görünüyor
- [ ] `contracts/src/` boş — Faz 0 hiçbir protokol mantığı içermez

## Faz 1'e devredilenler

- Slither yapılandırması, triage allowlist'i ve CI kapısı (ilk birinci taraf kontratla birlikte)
- ABI-parity testi (ilk ABI üretildiğinde)
- Postgres şeması ve Docker Compose (Faz 3)
- Playwright e2e (Faz 3)
