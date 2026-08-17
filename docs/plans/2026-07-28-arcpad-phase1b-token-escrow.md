# arcpad Faz 1b — `LaunchToken` ve `FeeEscrow`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protokolün iki yaprak kontratını yazmak: launch edilen token ve ücret escrow'u. İkisi de birbirinden ve curve'den bağımsızdır, ikisi de para tutar, ve ikisinin de doğruluğu tek başına kanıtlanabilir. Faz 1c'nin (`BondingCurve` + `LaunchFactory`) üzerine kurulacağı taban budur.

**Architecture:** İki bağımsız kontrat. `LaunchToken` OpenZeppelin ERC-20 üzerine kurulu, sabit arzlı, mint fonksiyonsuz; tüm arz constructor'da tek seferde curve adresine basılır. `FeeEscrow` pull-based bir defter: ücret yatırılır, alıcı (veya onun adına herkes) çeker. Escrow'un tek gerçek invariant'ı ödeme gücüdür — borçlar toplamı bakiyeyi asla aşamaz.

**Tech Stack:** Solidity 0.8.26 · Foundry · `@openzeppelin/contracts` (5.0.2, `v4-core/lib` üzerinden) · Slither

## Global Constraints

- Solidity `0.8.26`, `evm_version = "cancun"`, `via_ir = true`. `contracts/foundry.toml` **değiştirilmez**.
- Tüm forge komutları `--root contracts` alır, depo kökünden çalıştırılır. `forge install` **kullanılmaz**.
- Tüm miktarlar **18 decimal native USDC** görünümündedir. 6 decimal ERC-20 görünümü bu kontratlara hiç girmez.
- **Arc'ta sıfır adrese native transfer yasaktır** ve **sözleşmelere native gönderimin başarılı olacağı garanti değildir.** Bu, escrow'un pull-based olmasının sebebidir; bir tercih değil zorunluluktur.
- **Ücret parçalardan toplanır, toplamdan bölünmez** (spec §5.5). Bu fazda ücret hesabı yapılmaz ama `FeeEscrow`'un API'si buna uygun olmalıdır: protokol ve creator payları **ayrı ayrı** yatırılır.
- Token metadata sınırları pump.fun ile aynıdır: isim ≤ 32, sembol ≤ 13, uri ≤ 200 karakter. Creator sıfır adres olamaz.
- `contracts/src/` bu fazın sonunda şunları içerir: `libraries/CurveMath.sol` (Faz 1a), `LaunchToken.sol`, `FeeEscrow.sol`. Başka hiçbir şey.
- Yeni HIGH/MEDIUM Slither bulgusu ya düzeltilir ya gerekçesiyle triage'a eklenir. Gerekçesiz susturma yok.
- `C:\Users\iTopya\Desktop\arc-proje` (Limen Finance) salt-okunurdur.
- Her görev kendi commit'iyle biter. Çalışma dalı: `phase-1b-token-escrow`, **`phase-0-scaffold`'dan** dallanır (Faz 1a oraya merge edildi; `main` hâlâ yalnızca plan commit'ini taşıyor).

## Faz 1a'dan gelen ve burada geçerli olan dersler

Bunlar tekrar öğrenilmesin diye yazılıyor:

- **Bir assertion'ın gerçekten kısıtlayıp kısıtlamadığını ölçün.** Faz 1a'da altı invariant'tan üçü hiçbir kütüphane değişikliğinden kırılamıyordu ve ikisi cebirsel totolojiydi. Yazdığınız her invariant için "bunu hangi kod değişikliği kırar?" sorusunu cevaplayın; cevaplayamıyorsanız o invariant hiçbir şey iddia etmiyordur.
- **Handler içinde `assertLe` / `assertEq` çağırmayın.** forge-std'nin assertion'ları revert eder, `fail_on_revert = false` da fuzz'lanan hedef çağrılardan gelen revert'leri sessizce yutar — assertion hiç çalışmamış gibi olur. Bunun yerine ghost sayaç artırıp `invariant_` fonksiyonunda sıfır olduğunu iddia edin.
- **Raporda komut başlığı ile çıktı eşleşmeli.** Bu projede üç görev uydurulmuş kanıt bloğu yüzünden geri döndü. Bir koşu yeniden üretilemiyorsa "üretemedim" yazın.

---

### Task 1: `LaunchToken`

> **Bu görevin arayüzü uygulandıktan sonra değişti (2026-07-28).** Aşağıdaki kod, plan yazıldığı andaki hâliyle korunmuştur — tarihsel kayıttır, güncel arayüz değildir. Faz 1b'nin dal geneli incelemesi, toplam arzın serbest bir constructor parametresi olmasının çalışma zamanında yakalanması **imkânsız** bir kuplaj yarattığını gösterdi: `CurveMath.marketCap`'in `supplyConstant`'ı ile eşleşmezse hiçbir şey revert etmez, sistem kendi içinde tutarlı ama 1e12 kat yanlış çalışır. Kullanıcı kararıyla `totalSupply_` parametresi tamamen kaldırıldı; yerini `uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;` aldı ve `ZeroSupply()` hatası ile `test_revertsOnZeroSupply` testi onunla birlikte silindi. Constructor artık **beş** argüman alır. Aşağıdaki altı argümanlı imza, `error ZeroSupply()`, `if (totalSupply_ == 0)` kontrolü, `_mint(curve_, totalSupply_)` satırı ve tüm `new LaunchToken(..., SUPPLY)` çağrıları bu nedenle geçersizdir. Gerçek arayüz için `contracts/src/LaunchToken.sol`'e bakın.

**Files:**
- Create: `contracts/src/LaunchToken.sol`
- Create: `contracts/test/LaunchToken.t.sol`

**Interfaces:**
- Consumes: `@openzeppelin/contracts/token/ERC20/ERC20.sol` → `ERC20(name_, symbol_)`, `_mint(to, amount)`
- Produces: `contract LaunchToken is ERC20` —
  - `constructor(string name_, string symbol_, string metadataURI_, address creator_, address curve_, uint256 totalSupply_)`
  - `metadataURI() → string` (immutable-ish, `string public`)
  - `creator() → address`, `curve() → address` (`immutable`)
  - Hatalar: `NameTooLong()`, `SymbolTooLong()`, `UriTooLong()`, `ZeroCreator()`, `ZeroCurve()`, `ZeroSupply()`

- [ ] **Step 1: Çalışma dalını oluştur**

```bash
git checkout phase-0-scaffold
git checkout -b phase-1b-token-escrow
```

- [ ] **Step 2: Başarısız testleri yaz**

`contracts/test/LaunchToken.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

contract LaunchTokenTest is Test {
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant CURVE = address(0xCC0E);
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function _deploy() internal returns (LaunchToken) {
        return new LaunchToken("Arc Test Coin", "ATC", "ipfs://cid", CREATOR, CURVE, SUPPLY);
    }

    function test_entireSupplyIsMintedToTheCurve() public {
        LaunchToken t = _deploy();
        assertEq(t.totalSupply(), SUPPLY);
        assertEq(t.balanceOf(CURVE), SUPPLY);
        assertEq(t.balanceOf(CREATOR), 0);
        assertEq(t.balanceOf(address(this)), 0);
    }

    function test_metadataIsReadableOnChain() public {
        LaunchToken t = _deploy();
        assertEq(t.name(), "Arc Test Coin");
        assertEq(t.symbol(), "ATC");
        assertEq(t.metadataURI(), "ipfs://cid");
        assertEq(t.creator(), CREATOR);
        assertEq(t.curve(), CURVE);
    }

    function test_decimalsAreEighteen() public {
        assertEq(_deploy().decimals(), 18);
    }

    /// Sonradan mint yolu olmamali: toplam arz sonsuza kadar sabit.
    /// Bu test, kontratin yuzeyinde `mint` adinda bir fonksiyon
    /// bulunmadigini derleme zamaninda degil, calisma zamaninda kanitlar.
    function test_noMintFunctionExists() public {
        LaunchToken t = _deploy();
        (bool ok,) = address(t).call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        assertFalse(ok, "a mint entrypoint exists");
        assertEq(t.totalSupply(), SUPPLY);
    }

    // --- metadata sinirlari (pump.fun ile ayni) ---

    function test_nameAtLimitIsAccepted() public {
        string memory n = "12345678901234567890123456789012"; // 32
        LaunchToken t = new LaunchToken(n, "ATC", "u", CREATOR, CURVE, SUPPLY);
        assertEq(t.name(), n);
    }

    function test_revertsWhenNameExceedsLimit() public {
        vm.expectRevert(LaunchToken.NameTooLong.selector);
        new LaunchToken("123456789012345678901234567890123", "ATC", "u", CREATOR, CURVE, SUPPLY); // 33
    }

    function test_symbolAtLimitIsAccepted() public {
        string memory s = "1234567890123"; // 13
        LaunchToken t = new LaunchToken("n", s, "u", CREATOR, CURVE, SUPPLY);
        assertEq(t.symbol(), s);
    }

    function test_revertsWhenSymbolExceedsLimit() public {
        vm.expectRevert(LaunchToken.SymbolTooLong.selector);
        new LaunchToken("n", "12345678901234", "u", CREATOR, CURVE, SUPPLY); // 14
    }

    function test_revertsWhenUriExceedsLimit() public {
        string memory long = new string(201);
        vm.expectRevert(LaunchToken.UriTooLong.selector);
        new LaunchToken("n", "s", long, CREATOR, CURVE, SUPPLY);
    }

    // --- sifir kontrolleri ---

    function test_revertsOnZeroCreator() public {
        vm.expectRevert(LaunchToken.ZeroCreator.selector);
        new LaunchToken("n", "s", "u", address(0), CURVE, SUPPLY);
    }

    function test_revertsOnZeroCurve() public {
        vm.expectRevert(LaunchToken.ZeroCurve.selector);
        new LaunchToken("n", "s", "u", CREATOR, address(0), SUPPLY);
    }

    function test_revertsOnZeroSupply() public {
        vm.expectRevert(LaunchToken.ZeroSupply.selector);
        new LaunchToken("n", "s", "u", CREATOR, CURVE, 0);
    }

    // --- transfer davranisi standart olmali ---

    function test_transfersBehaveLikeStandardErc20() public {
        LaunchToken t = _deploy();
        vm.prank(CURVE);
        t.transfer(address(this), 100e18);
        assertEq(t.balanceOf(address(this)), 100e18);
        assertEq(t.balanceOf(CURVE), SUPPLY - 100e18);
    }

    function testFuzz_totalSupplyIsInvariantUnderTransfers(uint256 amount) public {
        LaunchToken t = _deploy();
        amount = bound(amount, 0, SUPPLY);
        vm.prank(CURVE);
        t.transfer(address(this), amount);
        assertEq(t.totalSupply(), SUPPLY);
        assertEq(t.balanceOf(CURVE) + t.balanceOf(address(this)), SUPPLY);
    }
}
```

- [ ] **Step 3: Testi çalıştır, kırıldığını doğrula**

```bash
forge test --root contracts --match-contract LaunchTokenTest
```

Beklenen: `Source "../src/LaunchToken.sol" not found`. RED çıktısını raporuna birebir kaydet.

- [ ] **Step 4: Kontratı yaz**

`contracts/src/LaunchToken.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchToken
/// @notice arcpad uzerinde baslatilan sabit arzli token.
/// @dev Tum arz constructor'da TEK SEFERDE bonding curve adresine basilir.
///      Curve, satilabilir kismi kendi sayaciyla sinirlar; rezerve kalan ayni
///      bakiyede durur ve graduation'da havuza aktarilir. pump.fun'in yaptigi
///      da budur: token_total_supply'in tamami curve hesabina gider,
///      real_token_reserves yalnizca satilabilir kismi sinirlar.
/// @dev Sonradan mint yolu YOKTUR. Metadata token uzerinde durur, boylece
///      arayuz ve indexer zincirden okuyabilir ve bir backend'e bagimli olmaz.
contract LaunchToken is ERC20 {
    /// pump.fun ile ayni sinirlar.
    uint256 private constant MAX_NAME_LENGTH = 32;
    uint256 private constant MAX_SYMBOL_LENGTH = 13;
    uint256 private constant MAX_URI_LENGTH = 200;

    error NameTooLong();
    error SymbolTooLong();
    error UriTooLong();
    error ZeroCreator();
    error ZeroCurve();
    error ZeroSupply();

    /// @notice Ucretleri alacak creator. Launch'ta sabitlenir.
    address public immutable creator;

    /// @notice Arzin tamaminin basildigi bonding curve.
    address public immutable curve;

    /// @notice Logo ve aciklamayi tasiyan metadata isaretcisi (IPFS).
    string public metadataURI;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        address curve_,
        uint256 totalSupply_
    ) ERC20(name_, symbol_) {
        if (bytes(name_).length > MAX_NAME_LENGTH) revert NameTooLong();
        if (bytes(symbol_).length > MAX_SYMBOL_LENGTH) revert SymbolTooLong();
        if (bytes(metadataURI_).length > MAX_URI_LENGTH) revert UriTooLong();
        if (creator_ == address(0)) revert ZeroCreator();
        if (curve_ == address(0)) revert ZeroCurve();
        if (totalSupply_ == 0) revert ZeroSupply();

        creator = creator_;
        curve = curve_;
        metadataURI = metadataURI_;

        _mint(curve_, totalSupply_);
    }
}
```

- [ ] **Step 5: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --match-contract LaunchTokenTest -vv
```

Beklenen: hepsi geçer.

- [ ] **Step 6: Tüm paket + Slither**

```bash
forge test --root contracts --no-match-path 'test/fork/*'
make slither
```

Beklenen: Faz 1a'nın 52 testi + bu görevin testleri, hepsi yeşil. Slither yeni HIGH/MEDIUM bulgu vermemeli. Verirse **düzelt veya gerekçesiyle triage'a ekle** — gerekçesiz susturma yok.

`slither` PATH'te olmayabilir; `CONTRIBUTING.md`'nin "Statik analiz" bölümü nereden ekleneceğini yazıyor.

- [ ] **Step 7: Commit**

```bash
git add contracts/src/LaunchToken.sol contracts/test/LaunchToken.t.sol
git commit -m "feat(contracts): fixed-supply launch token

The entire supply is minted to the bonding curve in one transfer, which is
what pump.fun does: the whole token_total_supply sits in the curve account
and real_token_reserves gates only the sellable portion. The spec previously
called for minting the reserved share to a locker, which would have required
a contract that does not exist until Phase 2.

Metadata lives on the token so the interface and the indexer read it from
the chain rather than from a backend. Limits match pump.fun: 32 / 13 / 200."
```

---

### Task 2: `FeeEscrow`

**Files:**
- Create: `contracts/src/FeeEscrow.sol`
- Create: `contracts/test/FeeEscrow.t.sol`

**Interfaces:**
- Consumes: hiçbir şey (bağımsız kontrat)
- Produces: `contract FeeEscrow` —
  - `deposit(address recipient) external payable` — `msg.value`'yu `recipient` alacağına yazar
  - `owed(address recipient) → uint256` (`mapping public`)
  - `totalOwed() → uint256`
  - `claim(address recipient) external` — **izinsiz**; birikmiş tutarı `recipient`'a gönderir
  - Olaylar: `Deposited(address indexed recipient, address indexed from, uint256 amount)`, `Claimed(address indexed recipient, uint256 amount)`
  - Hatalar: `ZeroRecipient()`, `ZeroAmount()`, `NothingToClaim()`, `TransferFailed()`

- [ ] **Step 1: Başarısız testleri yaz**

`contracts/test/FeeEscrow.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";

/// Native kabul etmeyen alici -- Arc'ta "sozlesmelere native gonderimin
/// basarili olacagi garanti degil" kuralinin somut hali.
contract RejectingRecipient {
    receive() external payable {
        revert("no");
    }
}

contract FeeEscrowTest is Test {
    FeeEscrow internal escrow;
    address internal constant PROTOCOL = address(0xAAA1);
    address internal constant CREATOR = address(0xBBB2);

    function setUp() public {
        escrow = new FeeEscrow();
        vm.deal(address(this), 1_000 ether);
    }

    function test_depositCreditsTheNamedRecipient() public {
        escrow.deposit{value: 10}(PROTOCOL);
        assertEq(escrow.owed(PROTOCOL), 10);
        assertEq(escrow.owed(CREATOR), 0);
        assertEq(escrow.totalOwed(), 10);
        assertEq(address(escrow).balance, 10);
    }

    /// Ucret parcalardan toplanir: protokol ve creator paylari AYRI AYRI
    /// yatirilir ve escrow ikisini birbirine karistirmaz (spec 5.5).
    function test_protocolAndCreatorSharesAreTrackedSeparately() public {
        escrow.deposit{value: 95}(PROTOCOL);
        escrow.deposit{value: 30}(CREATOR);
        assertEq(escrow.owed(PROTOCOL), 95);
        assertEq(escrow.owed(CREATOR), 30);
        assertEq(escrow.totalOwed(), 125);
    }

    function test_depositsAccumulate() public {
        escrow.deposit{value: 10}(PROTOCOL);
        escrow.deposit{value: 5}(PROTOCOL);
        assertEq(escrow.owed(PROTOCOL), 15);
    }

    function test_claimPaysTheRecipientAndZeroesTheDebt() public {
        escrow.deposit{value: 100}(PROTOCOL);
        uint256 before = PROTOCOL.balance;

        escrow.claim(PROTOCOL);

        assertEq(PROTOCOL.balance - before, 100);
        assertEq(escrow.owed(PROTOCOL), 0);
        assertEq(escrow.totalOwed(), 0);
        assertEq(address(escrow).balance, 0);
    }

    /// Claim izinsizdir: creator'in gas'i olmasa bile ucreti kilitli kalmaz.
    /// Fon her halukarda alicisina gider, tetikleyene degil.
    function test_anyoneCanTriggerAClaimButFundsGoToTheRecipient() public {
        escrow.deposit{value: 100}(CREATOR);
        address stranger = address(0xDEAD);
        uint256 strangerBefore = stranger.balance;
        uint256 creatorBefore = CREATOR.balance;

        vm.prank(stranger);
        escrow.claim(CREATOR);

        assertEq(CREATOR.balance - creatorBefore, 100);
        assertEq(stranger.balance, strangerBefore);
    }

    /// Bir alicinin native kabul etmemesi digerlerinin parasini kilitleyemez.
    /// Push-based bir tasarimda bu mumkun olmazdi; pull-based olmasinin
    /// sebebi tam olarak budur.
    function test_oneRejectingRecipientCannotBlockOthers() public {
        RejectingRecipient bad = new RejectingRecipient();
        escrow.deposit{value: 50}(address(bad));
        escrow.deposit{value: 70}(CREATOR);

        vm.expectRevert(FeeEscrow.TransferFailed.selector);
        escrow.claim(address(bad));

        // Digerinin claim'i etkilenmez.
        escrow.claim(CREATOR);
        assertEq(escrow.owed(CREATOR), 0);
        // Reddedenin borcu durur, kaybolmaz.
        assertEq(escrow.owed(address(bad)), 50);
        assertEq(address(escrow).balance, 50);
    }

    function test_revertsOnZeroRecipient() public {
        vm.expectRevert(FeeEscrow.ZeroRecipient.selector);
        escrow.deposit{value: 1}(address(0));
    }

    function test_revertsOnZeroValueDeposit() public {
        vm.expectRevert(FeeEscrow.ZeroAmount.selector);
        escrow.deposit{value: 0}(PROTOCOL);
    }

    function test_revertsWhenThereIsNothingToClaim() public {
        vm.expectRevert(FeeEscrow.NothingToClaim.selector);
        escrow.claim(PROTOCOL);
    }

    function test_claimTwiceInARowRevertsTheSecondTime() public {
        escrow.deposit{value: 10}(PROTOCOL);
        escrow.claim(PROTOCOL);
        vm.expectRevert(FeeEscrow.NothingToClaim.selector);
        escrow.claim(PROTOCOL);
    }

    function test_eventsAreEmitted() public {
        vm.expectEmit(true, true, false, true);
        emit FeeEscrow.Deposited(PROTOCOL, address(this), 42);
        escrow.deposit{value: 42}(PROTOCOL);

        vm.expectEmit(true, false, false, true);
        emit FeeEscrow.Claimed(PROTOCOL, 42);
        escrow.claim(PROTOCOL);
    }
}
```

- [ ] **Step 2: Testi çalıştır, kırıldığını doğrula**

```bash
forge test --root contracts --match-contract FeeEscrowTest
```

Beklenen: `Source "../src/FeeEscrow.sol" not found`.

- [ ] **Step 3: Kontratı yaz**

`contracts/src/FeeEscrow.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title FeeEscrow
/// @notice Ucretlerin biriktigi ve CEKILDIGI defter. Hicbir ucret push
///         edilmez.
/// @dev Pull-based olmasi bir tercih degil zorunluluktur: Arc'ta sozlesmelere
///      native gonderimin basarili olacagi garanti degildir. Push-based bir
///      tasarimda native kabul etmeyen tek bir alici, ayni islemdeki diger
///      herkesin ucretini kilitlerdi.
/// @dev Bu fazda tek varlik native USDC'dir. Ozel pairing asset destegi
///      kapsam disidir (spec 2).
contract FeeEscrow {
    error ZeroRecipient();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    event Deposited(address indexed recipient, address indexed from, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);

    /// @notice Alici basina cekilebilir bakiye.
    mapping(address => uint256) public owed;

    /// @notice Tum alicilarin toplam alacagi. Odeme gucu invariant'inin sol
    ///         tarafi; bakiyeyi asla asamaz.
    uint256 public totalOwed;

    /// @notice `recipient` adina ucret yatirir.
    /// @dev Protokol ve creator paylari AYRI AYRI yatirilir; escrow bir
    ///      bolusturme yapmaz. Ucret parcalardan toplanir (spec 5.5).
    function deposit(address recipient) external payable {
        if (recipient == address(0)) revert ZeroRecipient();
        if (msg.value == 0) revert ZeroAmount();

        owed[recipient] += msg.value;
        totalOwed += msg.value;

        emit Deposited(recipient, msg.sender, msg.value);
    }

    /// @notice `recipient`'in birikmis ucretini kendisine gonderir.
    /// @dev IZINSIZDIR: cagiran kim olursa olsun fon alicisina gider. Creator'in
    ///      gas'i olmasa bile ucreti kilitli kalmaz. Cagiran bundan kar edemez.
    function claim(address recipient) external {
        uint256 amount = owed[recipient];
        if (amount == 0) revert NothingToClaim();

        // CEI: once defter, sonra transfer.
        owed[recipient] = 0;
        totalOwed -= amount;

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Claimed(recipient, amount);
    }
}
```

- [ ] **Step 4: Testleri çalıştır**

```bash
forge fmt --root contracts
forge test --root contracts --match-contract FeeEscrowTest -vv
```

Beklenen: hepsi geçer.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/FeeEscrow.sol contracts/test/FeeEscrow.t.sol
git commit -m "feat(contracts): pull-based fee escrow

Fees are never pushed. On Arc a native transfer to a contract is not
guaranteed to succeed, so a push-based design would let one recipient that
rejects native calls freeze everyone else's fee in the same transaction.

claim is permissionless and always pays the recipient, never the caller, so
a creator without gas still gets paid and nobody can profit by triggering it.
Protocol and creator shares are deposited separately: the escrow never splits
a total, because the fee is summed from its parts (spec 5.5)."
```

---

### Task 3: `FeeEscrow` invariant paketi

Birim testler her fonksiyonun tek başına doğru olduğunu gösterir; bu görev **hiçbir yatırma/çekme dizisinin** escrow'u borcunu ödeyemez hale getiremeyeceğini gösterir.

**Files:**
- Create: `contracts/test/invariant/EscrowHandler.sol`
- Create: `contracts/test/invariant/FeeEscrowInvariants.t.sol`

**Interfaces:**
- Consumes: Task 2'nin `FeeEscrow` yüzeyi.
- Produces: `EscrowHandler` — sabit bir alıcı kümesi üzerinde rastgele yatırma/çekme uygulayan ve ghost muhasebe tutan aracı.

- [ ] **Step 1: Handler'ı yaz**

`contracts/test/invariant/EscrowHandler.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdUtils} from "forge-std/StdUtils.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";

/// @dev Fuzz'un surdugu aktor. Sabit bir alici kumesi uzerinde calisir --
///      rastgele adresler yerine az sayida alici kullanmak, ayni alicinin
///      ust uste yatirma/cekme yasamasini saglar ve muhasebe hatalarini
///      ortaya cikarir.
/// @dev Handler icinde assertion CAGRILMAZ: forge-std'nin assert'leri revert
///      eder ve `fail_on_revert = false` bunlari sessizce yutar, yani
///      assertion hic calismamis gibi olur. Bunun yerine ghost sayaclar
///      artirilir ve `invariant_` fonksiyonlarinda sifir olduklari iddia
///      edilir.
contract EscrowHandler is StdUtils {
    FeeEscrow public immutable escrow;

    address[3] public recipients;

    /// Ghost muhasebe: kontrattan bagimsiz olarak tutulur.
    uint256 public ghostDeposited;
    uint256 public ghostClaimed;

    /// Ghost ihlal sayaclari.
    /// @dev `claimPaidWrongAmount` hem yanlis tutari hem yanlis tarafi
    ///      yakalar: fon baskasina giderse alicinin bakiye artisi 0 olur ve
    ///      beklenenle esitlenmez.
    uint256 public claimPaidWrongAmount;
    /// @dev Claim sonrasi borcun tam sifirlanmadigi durum. Bakiye ve totalOwed
    ///      birlikte hareket ettigi icin diger invariant'lar bunu goremez.
    uint256 public claimLeftResidualDebt;

    constructor(FeeEscrow escrow_) {
        escrow = escrow_;
        recipients[0] = address(0xA11CE);
        recipients[1] = address(0xB0B);
        recipients[2] = address(0xCAFE);
    }

    receive() external payable {}

    function depositTo(uint256 who, uint256 amount) external {
        address r = recipients[_bound(who, 0, 2)];
        amount = _bound(amount, 1, 10 ether);
        if (address(this).balance < amount) return;

        escrow.deposit{value: amount}(r);
        ghostDeposited += amount;
    }

    function claimFor(uint256 who) external {
        address r = recipients[_bound(who, 0, 2)];
        uint256 expected = escrow.owed(r);
        if (expected == 0) return;

        uint256 before = r.balance;
        escrow.claim(r);
        uint256 delta = r.balance - before;

        if (delta != expected) claimPaidWrongAmount++;
        if (escrow.owed(r) != 0) claimLeftResidualDebt++;

        ghostClaimed += expected;
    }
}
```

- [ ] **Step 2: Invariant testlerini yaz**

`contracts/test/invariant/FeeEscrowInvariants.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

contract FeeEscrowInvariantsTest is Test {
    FeeEscrow internal escrow;
    EscrowHandler internal handler;

    function setUp() public {
        escrow = new FeeEscrow();
        handler = new EscrowHandler(escrow);
        vm.deal(address(handler), 1_000_000 ether);
        targetContract(address(handler));
    }

    /// ODEME GUCU -- bu paketin tasiyici invariant'i. Escrow, borclarinin
    /// toplamini her zaman odeyebilecek bakiyeye sahip olmali.
    /// Kirilma yolu: claim'de defteri guncellemeden once transfer yapmak,
    /// veya deposit'te totalOwed'i owed'dan farkli artirmak.
    function invariant_escrowCanAlwaysPayWhatItOwes() public view {
        assertGe(address(escrow).balance, escrow.totalOwed());
    }

    /// Bakiye ile borc arasinda fark BIRIKMEMELI: escrow bir kasa degil,
    /// bir defter. Fazla bakiye, muhasebeye girmemis para demektir.
    /// Kirilma yolu: deposit'te owed'i artirip totalOwed'i unutmak.
    function invariant_escrowHoldsExactlyWhatItOwes() public view {
        assertEq(address(escrow).balance, escrow.totalOwed());
    }

    /// Ghost muhasebe ile kontratin defteri ortusmeli.
    /// Kirilma yolu: claim'in sildigi tutarla gonderdigi tutarin farkli olmasi.
    function invariant_ledgerMatchesGhostAccounting() public view {
        assertEq(escrow.totalOwed(), handler.ghostDeposited() - handler.ghostClaimed());
    }

    /// Her claim, tam olarak borcu kadar ve tam olarak alicisina odemeli,
    /// ve borcu tam sifirlamali. Handler bunu her cagrida olcup sayac artirir.
    /// Kirilma yolu: fonu msg.sender'a gondermek (alicinin bakiye artisi 0
    /// olur), veya borcu kismen silmek -- ikincisini diger uc invariant
    /// GOREMEZ, cunku bakiye ve totalOwed birlikte dusmeye devam eder.
    function invariant_everyClaimPaidTheRightAmountAndClearedTheDebt() public view {
        assertEq(handler.claimPaidWrongAmount(), 0);
        assertEq(handler.claimLeftResidualDebt(), 0);
    }
}
```

- [ ] **Step 3: Invariant testlerini çalıştır**

```bash
forge test --root contracts --match-contract FeeEscrowInvariantsTest -vv
```

Beklenen: dördü de geçer. Biri kırılırsa Foundry karşı-örnek dizisini basar — **onu raporuna aynen kopyala ve dur**.

- [ ] **Step 4: Invariant'ların gerçekten kısıtladığını mutasyonla kanıtla**

Faz 1a'nın en değerli dersi buydu: geçen bir invariant, kısıtlayan bir invariant demek değildir. `contracts/` dizininin bir kopyasını scratchpad'e al (depoya **dokunma**) ve `FeeEscrow.sol`'ü tek tek boz:

| Mutasyon | Hangi invariant kırılmalı |
|---|---|
| `claim`'de transferi defter güncellemesinden **önce** yap | ödeme gücü (reentrancy penceresi) |
| `deposit`'te `totalOwed += msg.value` satırını sil | `holdsExactlyWhatItOwes` ve `ledgerMatchesGhost` |
| `claim`'de `owed[recipient] = 0` yerine `owed[recipient] -= amount / 2` | yalnızca `everyClaimPaidTheRightAmountAndClearedTheDebt` — diğer üçü bunu göremez |
| `claim`'de fonu `msg.sender`'a gönder | `everyClaimPaidTheRightAmountAndClearedTheDebt` |

Her mutasyon için **hangi invariant'ın hangi koşuda kırıldığını** raporuna yaz. Bir mutasyon hiçbir invariant'ı kırmıyorsa, o invariant kümesinde bir boşluk var demektir — **bunu raporla, gizleme**.

> **Ölçüm sonrası düzeltme (2026-07-28).** Yukarıdaki tablo bir *tahmindir* ve ilk satırı ölçümle çürütüldü — burada bir kayıt olarak duruyor, doğru cevap olarak değil. Bu plandaki handler'ın üç sabit alıcısı kodsuz adreslerdir, dolayısıyla reentrancy penceresini kullanabilecek hiçbir aktör yoktur: ilk mutasyon iki farklı tohumla 256.000 çağrıda **dört invariant'ı da yeşil bıraktı**. Handler'a sınırlı, tek seferlik reentrant bir aktör eklendikten sonra mutasyonu yakalayanlar `everyClaimPaidTheRightAmountAndClearedTheDebt` ve `ledgerMatchesGhostAccounting` oldu — **ödeme gücü invariant'ı değil**. Dersin kendisi tam olarak budur: bir invariant'ın neyi yakalayacağını tahmin etmek, yakaladığını ölçmenin yerine geçmez.

- [ ] **Step 5: CI profilinde koştur**

```bash
FOUNDRY_PROFILE=ci forge test --root contracts --no-match-path 'test/fork/*'
```

- [ ] **Step 6: Commit**

```bash
forge fmt --root contracts
git add contracts/test/invariant
git commit -m "test(contracts): fee escrow invariants, verified by mutation

The unit tests show each function is correct alone; these show no sequence
of deposits and claims can leave the escrow unable to pay what it owes.

Each invariant was checked by breaking the contract on purpose and recording
which one caught it, because Phase 1a taught that an invariant which passes
is not the same as an invariant which constrains: three of that phase's six
could not fail under any change to the code they were meant to guard."
```

---

## Faz 1b tamamlanma ölçütü

- [ ] `forge test --root contracts --no-match-path 'test/fork/*'` yeşil, hem `default` hem `ci` profilinde
- [ ] `make slither` yeni HIGH/MEDIUM bulgu bırakmıyor; eklenen her triage girdisinin yazılı gerekçesi var
- [ ] `make fmt-check` ve `make lint` temiz
- [ ] Her invariant için, onu kıran en az bir mutasyon raporda kayıtlı — **4'te 3 karşılanıyor, 4'üncüsü kasıtlı olarak karşılanamıyor.** `invariant_escrowCanAlwaysPayWhatItOwes` (`balance >= totalOwed`) için böyle bir mutasyon yoktur ve olamaz: kardeş invariant `invariant_escrowHoldsExactlyWhatItOwes` aynı durumu `balance == totalOwed` ile iddia eder, birincisini ihlal eden her durum ikincisini de ihlal eder ve daha sıkı olan eşitlik her zaman önce kırılır. Task 3'ün mutasyon turunda 15 escrow mutantının 0'ında bu invariant tek başına tetiklenmedi. **Invariant silinmiyor** — Arc'ta native USDC'nin ERC-20 görünümü (spec §3.2) üzerinden `deposit()` dışından bakiyeye değer ulaşabilir; bu durumda `balance == totalOwed` deployment hedefinde YANLIŞ olur ama `balance >= totalOwed` (ödeme gücü) hâlâ tutar. Handler'ın kapalı dünyasında totoloji olması, kontratın Arc'taki gerçek garantisi olmasını değiştirmez.
- [ ] `contracts/src/` tam olarak şunları içeriyor: `libraries/CurveMath.sol`, `LaunchToken.sol`, `FeeEscrow.sol`

## Faz 1c'ye devreden

`BondingCurve` ve `LaunchFactory`, deploy script'i ve Arc testnet entegrasyonu. Faz 1c'nin planı, bu fazın yüzeyleri kesinleştikten sonra yazılır ve şu dört açık kararı taşır:

- **Kısmi doldurmada iade taşması.** Son alım kısmi dolduğunda `netQuoteIn` (ücret-dahil) ile `quoteBuyCost` (ücret-hariç) konvansiyonları arasında geçiş yapılır ve iade `gross − cost − feeOn(cost)` olur. Bu ancak `cost ≤ net` ise taşmaz. Üretim parametrelerinde tutuyor ama evrensel değil — küçük rezervlerde bozuluyor. Faz 1c bunu bir parametre özelliğine güvenmek yerine açık bir `require` ile korumalı.
- **`CurveMath.marketCap`'in Faz 1'de çağıranı yok.** Kademeli ücret graduation sonrası havuza aittir (spec §5.5, Rejim 2); curve düz %1,25 alır. `BondingCurve.buy()` içine kademe taraması **yazılmamalıdır**.
- **Ücret bölüşümü toplamdan değil parçalardan hesaplanmalı.** Depodaki tek ücret literali `CURVE_FEE_BPS = 125` (`test/CurveMath.t.sol`) — bu **birleşik** orandır, protokol ve creator paylarının toplamı. `buyExactQuoteIn` yolunda cazip kısayol, `netQuoteIn`'in ima ettiği toplam ücreti tek seferde çıkarıp ikiye bölmektir; bu tam olarak spec'in (§5.5) yasakladığı "toplamdan bölme" şeklidir. Ölçüldü: `feeOn(x, 95) + feeOn(x, 30) > feeOn(x, 125)`, `x ∈ [1, 40000]` tam sayı aralığının **20.220**'sinde (yaklaşık yarısında) — her iki parça da yukarı yuvarlandığı için. Faz 1c `PROTOCOL_FEE_BPS = 95` ve `CREATOR_FEE_BPS = 30`'u ayrı ayrı tanımlamalı, `125`'i ileri yönde (ücret hesaplarken) hiç açığa çıkarmamalı, her iki payı da aynı net anapara üzerinden ayrı ayrı hesaplamalı, ve escrow'a dokunmadan önce `proceeds > 0` korumalıdır: satış yolunda `quoteSellProceeds` tabana yuvarladığı için sıfıra taşabilir, ve `FeeEscrow.deposit` sıfır bir pay üzerinde `ZeroAmount()` ile revert eder — bu da korumasız bırakılırsa tüm işlemi geri alır.
- **Dış yüzeyi isim listesiyle değil, ABI'nin kendisiyle sabitle.** Faz 1b'nin yüzey testleri (`test_noMintPathExistsForAnyPlausibleSelectorOrCaller`, `test_noValueMovingEntrypointBeyondClaimExists`) sabit bir selector listesini sabit çağıranlarla dener. Bu, hedefledikleri mutasyonların hepsini öldürüyor — ölçüldü — ama bir **isim sayımıdır** ve tavanı vardır: yeniden inceleme, adı `issue(address,uint256)` olan bir minter'ın, iki adımlı `setMinter` + `mint`'in, listede olmayan bir adrese kilitlenmiş bir minter'ın, bir `burn(uint256)` yolunun ve escrow'da `sweep` yerine `collect(address)` adlı bir tahliye fonksiyonunun paketin tamamını yeşil bıraktığını ölçtü. `collect` uydurma bir isim değildir — pump.fun'ın kendi talimatı `collect_creator_fee_v2`'dir ve bu spec'te anılır. Kontratlar bugün doğrudur (Slither temiz, ulaşılabilir fonksiyonlar tek tek sayıldı, tek bir `_mint` var ve `_burn` açığa çıkmıyor); açık olan, ileride **eklenecek** bir fonksiyonun testlerce görülmemesidir. İsimden bağımsız tek kapanış, derleme çıktısındaki ABI'yi okuyup dış fonksiyon kümesinin beklenen kümeye tam eşit olduğunu iddia etmektir. Faz 1b'de yapılmadı çünkü `vm.readFile` `fs_permissions` ister ve bu fazın kısıtı `foundry.toml`'a dokunmamaktı. Faz 1c zaten `BondingCurve` ve `LaunchFactory`'yi eklerken bu izni bilinçli olarak açmalı ve **dört kontratı birden** kapsayan tek bir yüzey testi yazmalıdır. `LaunchToken`'ın "toplam arz sonsuza kadar sabit" iddiası da bugün yalnızca yukarıdan sabitlenmiştir; aynı test onu aşağıdan da sabitler.
