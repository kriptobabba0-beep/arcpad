// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BuybackVestingVault} from "../../src/BuybackVestingVault.sol";

/// Kasanin fabrikadan okudugu IKI adres, ve baska hicbir sey.
/// @dev `BuybackVestingVault.t.sol`daki ikizinin AYNISI degil: orada
///      `buybackTreasury` sabit, burada HANDLER'in kendisidir -- kasa
///      `lock`u yalnizca ondan kabul eder ve fuzz'un surdugu aktor odur.
contract VaultFactoryMock {
    address public protocolTreasury;
    address public buybackTreasury;

    constructor(address protocol_, address buyback_) {
        protocolTreasury = protocol_;
        buybackTreasury = buyback_;
    }

    function setProtocolTreasury(address a) external {
        protocolTreasury = a;
    }
}

contract VaultTokenMock is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title BuybackVaultHandler
 * @notice Kasayi fuzz'un surdugu aktor. HANDLER'IN KENDISI `buybackTreasury`DIR.
 *
 * @dev IKI TOKEN, VE BU KASITLIDIR. Tek tokenle "A'nin butcesi B'yi odedi"
 *      sinifindan bir muhasebe kaymasi OLCULEMEZ: her sey tek bir defterde
 *      toplanir ve toplam yine tutar. Iki token, izolasyonu bir iddia haline
 *      getirir.
 *
 * @dev ZAMAN MUTLAK ILERLETILIR. `foundry.toml` `via_ir = true` ile derliyor
 *      ve solc `TIMESTAMP`i bir islem icinde SABIT kabul edip okumayi ortak
 *      alt-ifadeye indiriyor; `vm.warp(block.timestamp + X)` bu yuzden bir
 *      dongude SESSIZCE calismaz (`BuybackVestingVault.t.sol`da olculdu: iki
 *      ardisik goreli warp'tan sonra `block.timestamp` IKISINDE DE ayni).
 *      Saat burada bir ghost degiskende tutulur ve her warp MUTLAKTIR.
 *
 * @dev HANDLER ICINDE ASSERTION YOKTUR. `fail_on_revert = false` revert eden
 *      bir handler cagrisini yutar, ve forge-std'nin assert'leri revert eder
 *      -- yani bir assertion hic calismamis gibi olurdu. Ihlaller ghost
 *      sayaclara yazilir; iddia `invariant_` fonksiyonlarinda.
 */
contract BuybackVaultHandler is CommonBase, StdUtils {
    /// Zaman burada baslar. Sifirdan baslamak `vestingStart`i altan tasirir
    /// (`nowTs - (VESTING_DURATION - combinedDuration)`) ve bu, gercek bir
    /// zincirde bulunmayan bir durumdur.
    uint256 public constant START = 1_000_000_000;

    /// Tek adimda ilerlenebilecek en uzun sure. Bes yildan uzun tutulur ki
    /// fuzz `vestingEnd`in OTESINE de gecebilsin -- "her sey vest etti"
    /// dali yalnizca orada calisir.
    uint256 internal constant MAX_STEP = 400 days;

    uint16 internal constant PROTOCOL_VEST_BPS = 3_000;
    uint256 internal constant BPS = 10_000;

    BuybackVestingVault public immutable vault;
    VaultFactoryMock public immutable factory;
    VaultTokenMock public immutable tokenA;
    VaultTokenMock public immutable tokenB;

    address public constant PROTOCOL = address(0xDA0);
    address public constant CREATOR_A = address(0xC0FFEE);
    address public constant CREATOR_B = address(0xDECAF);
    /// Ne creator ne protokol. `release` bunu REDDETMEK zorunda.
    address public constant STRANGER = address(0xBAD);

    /// Ghost saat. `block.timestamp`i BURADAN kurariz.
    uint256 public clock;

    /// Ghost defter -- kontrattan BAGIMSIZ tutulur.
    mapping(address => uint256) public ghostLocked;
    mapping(address => uint256) public ghostReleased;
    mapping(address => uint256) public ghostCreatorPaid;
    mapping(address => uint256) public ghostProtocolPaid;
    /// Bagislar: kasaya defter DISINDAN giren tokenlar.
    mapping(address => uint256) public ghostDonated;

    /// Ghost ihlal sayaclari.
    /// @dev 70/30 boluntusu bozuldu (ya da artik yanlis tarafa gitti).
    uint256 public splitWrong;
    /// @dev `release` bir yabanciya odeme yapti -- yani yetki kapisi dustu.
    uint256 public strangerReleased;
    /// @dev Bagis defteri hareket ettirdi. Kasanin `balanceOf` OKUMAMASI
    ///      gerektiginin olcumu.
    uint256 public donationMovedLedger;
    /// @dev Vesting suresi DOLDUKTAN sonra hala cekilemeyen bir bakiye kaldi.
    ///      Kullanilabilirlik: yuvarlama artiginin kasada takili kalmasi tam
    ///      olarak bu sayacin gordugu seydir.
    uint256 public strandedAfterVesting;
    /// @dev Gecerli bir `lock` revert etti. Guvenlik degil KULLANILABILIRLIK:
    ///      hicbir sey yapmayan bir kasa butun guvenlik invariant'larini
    ///      saglar.
    uint256 public lockRevertedUnexpectedly;

    /// Cagri sayaclari -- fuzz'un yolu GERCEKTEN yuruduunu gormek icin.
    uint256 public locks;
    uint256 public releases;

    constructor() {
        factory = new VaultFactoryMock(PROTOCOL, address(this));
        vault = new BuybackVestingVault(address(factory));
        tokenA = new VaultTokenMock("Alpha", "ALPHA");
        tokenB = new VaultTokenMock("Beta", "BETA");
        clock = START;
        vm.warp(START);
    }

    function _pick(uint256 which) internal view returns (VaultTokenMock t, address creator) {
        if (which % 2 == 0) return (tokenA, CREATOR_A);
        return (tokenB, CREATOR_B);
    }

    // ------------------------------------------------------------------
    // Aksiyonlar
    // ------------------------------------------------------------------

    /**
     * Hazine (yani bu kontrat) piyasadan aldigini kasaya kilitler.
     *
     * @dev Tutar [1, 1e24] araligina baglanir ve token BASILIR, yani BU CAGRI
     *      ICIN `lock`un revert etmesi icin gecerli hicbir sebep yoktur.
     *      Revert ederse sayilir.
     */
    function lockFor(uint256 which, uint256 amount) external {
        (VaultTokenMock t, address creator) = _pick(which);
        amount = _bound(amount, 1, 1e24);

        t.mint(address(this), amount);
        t.approve(address(vault), amount);

        try vault.lock(address(t), amount, creator) {
            ghostLocked[address(t)] += amount;
            locks++;
        } catch {
            lockRevertedUnexpectedly++;
        }
    }

    /**
     * Faydalanicilardan biri cekim yapar.
     *
     * @dev `NothingToRelease` MESRU BIR REVERTTIR ve sayilmaz: henuz vest
     *      etmis bir sey olmayabilir. O yuzden once `releasable` sorulur ve
     *      sifirsa cagri hic yapilmaz -- boylece `try/catch` mesru olani
     *      gayrimesru olandan ayirmak zorunda kalmaz.
     */
    function releaseBy(uint256 which, bool asCreator) external {
        (VaultTokenMock t, address creator) = _pick(which);
        address token = address(t);
        if (vault.creatorBeneficiary(token) == address(0)) return;
        uint256 expected = vault.releasable(token);
        if (expected == 0) return;

        address caller = asCreator ? creator : PROTOCOL;
        uint256 creatorBefore = t.balanceOf(creator);
        uint256 protocolBefore = t.balanceOf(PROTOCOL);

        vm.prank(caller);
        uint256 released = vault.release(token);

        uint256 creatorGot = t.balanceOf(creator) - creatorBefore;
        uint256 protocolGot = t.balanceOf(PROTOCOL) - protocolBefore;

        // BOLUNTU, ODENEN MIKTARDAN OLCULUR -- kontratin soyledigi degil,
        // BAKIYELERIN gosterdigi. Yanlis tarafa giden bir odeme ancak boyle
        // gorunur.
        uint256 wantProtocol = (released * PROTOCOL_VEST_BPS) / BPS;
        uint256 wantCreator = released - wantProtocol;
        if (creatorGot != wantCreator || protocolGot != wantProtocol) splitWrong++;
        if (creatorGot + protocolGot != released) splitWrong++;

        ghostReleased[token] += released;
        ghostCreatorPaid[token] += creatorGot;
        ghostProtocolPaid[token] += protocolGot;
        releases++;
    }

    /// Yabanci bir adres cekmeye calisir. BASARILI OLMAMALI.
    function releaseByStranger(uint256 which) external {
        (VaultTokenMock t,) = _pick(which);
        address token = address(t);
        if (vault.creatorBeneficiary(token) == address(0)) return;
        if (vault.releasable(token) == 0) return;

        vm.prank(STRANGER);
        try vault.release(token) {
            strangerReleased++;
        } catch {
            // Beklenen yol.
        }
    }

    /**
     * BAGIS -- ARC'IN SALDIRI YUZEYI.
     *
     * Kasaya defterin disindan token gonderir. Hicbir seyi degistirmemeli:
     * kasa `balanceOf` OKUMAZ, defterini kendi tutar. Okusaydi, bir bagisci
     * bir launch'in takvimini disaridan sulandirabilirdi.
     */
    function donate(uint256 which, uint256 amount) external {
        (VaultTokenMock t,) = _pick(which);
        amount = _bound(amount, 1, 1e22);

        uint256 lockedBefore = vault.totalLocked(address(t));
        uint256 releasableBefore = vault.releasable(address(t));

        t.mint(address(vault), amount);
        ghostDonated[address(t)] += amount;

        if (vault.totalLocked(address(t)) != lockedBefore) donationMovedLedger++;
        if (vault.releasable(address(t)) != releasableBefore) donationMovedLedger++;
    }

    /// Saati MUTLAK olarak ilerletir. Bkz. baslikaki `via_ir` notu.
    function advanceTime(uint256 step) external {
        step = _bound(step, 1, MAX_STEP);
        clock += step;
        vm.warp(clock);
    }

    /**
     * Governor protokol hazinesini dondurur.
     *
     * @dev Kasa `protocolTreasury`yi CANLI okur, o yuzden rotasyon SONRAKI
     *      odemeleri yeni adrese goturur. Burada eski adrese geri donulur --
     *      aksi halde ghost bakiye takibi ikinci bir adresi izlemek zorunda
     *      kalir ve olculen sey bulaniklasirdi. Rotasyonun kendisi bir yol
     *      olarak yurutulmus olur.
     */
    function rotateProtocolTreasuryAndBack(uint256 seed) external {
        address temp = address(uint160(uint256(keccak256(abi.encode(seed))) | 1));
        if (temp == PROTOCOL) return;
        factory.setProtocolTreasury(temp);
        factory.setProtocolTreasury(PROTOCOL);
    }

    /**
     * VESTING BITTIKTEN SONRA HICBIR SEY TAKILI KALMAMALI.
     *
     * Saati her iki tokenin `vestingEnd`inin otesine tasir ve defteri okur:
     * o noktada `locked` SIFIR, `releasable` ise `totalLocked - totalReleased`
     * olmak zorundadir. Bir yuvarlama artigi burada gorunur.
     */
    function settleEverything() external {
        uint256 furthest = clock;
        address[2] memory tokens = [address(tokenA), address(tokenB)];
        for (uint256 i = 0; i < 2; i++) {
            uint256 end = vault.vestingEnd(tokens[i]);
            if (end + 1 > furthest) furthest = end + 1;
        }
        clock = furthest;
        vm.warp(furthest);

        for (uint256 i = 0; i < 2; i++) {
            address token = tokens[i];
            if (vault.creatorBeneficiary(token) == address(0)) continue;
            uint256 outstanding = vault.totalLocked(token) - vault.totalReleased(token);
            if (vault.locked(token) != 0) strandedAfterVesting++;
            if (vault.releasable(token) != outstanding) strandedAfterVesting++;
        }
    }

    /// Testin okudugu token listesi.
    function tokens(uint256 i) external view returns (address) {
        return i == 0 ? address(tokenA) : address(tokenB);
    }
}
