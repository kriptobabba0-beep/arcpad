// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BuybackTreasury} from "../../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../../src/BuybackVestingVault.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {MockCurve, MockFactory, MockLaunchToken, MockPoolManager} from "../BuybackTreasury.t.sol";

/**
 * @title BuybackTreasuryHandler
 * @notice Hazineyi fuzz'un surdugu aktor. IKI LAUNCH, ve bu kasitli: "A'nin
 *         butcesi B'yi odedi" sinifindan bir kayma tek tokenle OLCULEMEZ.
 *
 * @dev TAKLITLER `BuybackTreasury.t.sol`DAN IMPORT EDILIR, YENIDEN
 *      YAZILMAZ. Ikinci bir `MockCurve` yazmak, birim testinin olctugu
 *      davranistan SESSIZCE ayrilabilecek bir ikiz uretirdi -- ve o ikiz
 *      "invariant yesil, birim testi kirmizi" (ya da tersi) diye gorunurdu.
 *
 * @dev MERCI EGRIDIR. `MockPoolManager.extsload` sifir doner, yani mezun bir
 *      egri "pool-not-initialized" ile GERI KATLANIR. Bu bir kacamak degil,
 *      kontratin gercek bir dalidir -- ve geri katlama da bir supurmedir:
 *      butce sifirlanir, para creator'a doner. Muhasebe iddialarinin ikisini
 *      de kapsamasi gerekir, ve kapsar.
 *
 * @dev ZAMAN MUTLAK ILERLETILIR (`via_ir` + `TIMESTAMP` ortak alt-ifade
 *      indirgemesi). Bkz. `BuybackVaultHandler`in ayni notu.
 */
contract BuybackTreasuryHandler is CommonBase, StdUtils {
    uint256 public constant START = 1_000_000_000;
    uint256 internal constant MAX_STEP = 10 days;

    BuybackTreasury public immutable treasury;
    BuybackVestingVault public immutable vault;
    FeeEscrow public immutable escrow;
    MockFactory public immutable factory;
    MockPoolManager public immutable poolManager;

    MockCurve public immutable curveA;
    MockCurve public immutable curveB;
    MockLaunchToken public immutable tokenA;
    MockLaunchToken public immutable tokenB;

    address public constant PROTOCOL = address(0xDA0);
    address public constant CREATOR_A = address(0xC0FFEE);
    address public constant CREATOR_B = address(0xDECAF);
    address public constant HOOK = address(0x400C);
    address public constant KEEPER = address(0x4EE9);
    address public constant STRANGER = address(0xBAD);

    uint256 public clock;

    /// Ghost defter, token basina.
    mapping(address => uint256) public ghostAccrued;
    /// Supurmenin butceden DUSURDUGU toplam (harcanan + geri katlanan).
    mapping(address => uint256) public ghostRemoved;
    /// Zorla gonderilen native -- hicbir butceye yazilmamali.
    uint256 public ghostDonated;
    /// Bir tokenin ILK parayi gordugu an. `SWEEP_GRACE` bunun uzerine biner.
    mapping(address => uint256) public firstAccrualAt;

    /// Ghost ihlal sayaclari.
    uint256 public strangerAccrued;
    uint256 public strangerSwept;
    uint256 public pendingSurvivedSweep;
    uint256 public donationMovedBudget;
    uint256 public earlyPermissionless;

    uint256 public accruals;
    uint256 public sweeps;

    constructor() {
        escrow = new FeeEscrow();
        factory = new MockFactory();
        vault = new BuybackVestingVault(address(factory));
        poolManager = new MockPoolManager();
        treasury = new BuybackTreasury(address(factory), address(escrow), vault, IPoolManager(address(poolManager)));
        factory.set(PROTOCOL, address(treasury), HOOK, KEEPER);

        curveA = new MockCurve();
        tokenA = new MockLaunchToken(address(curveA));
        curveA.setToken(address(tokenA));
        curveA.setCreator(CREATOR_A);

        curveB = new MockCurve();
        tokenB = new MockLaunchToken(address(curveB));
        curveB.setToken(address(tokenB));
        curveB.setCreator(CREATOR_B);

        clock = START;
        vm.warp(START);
    }

    function _pick(uint256 which) internal view returns (MockCurve c, MockLaunchToken t) {
        if (which % 2 == 0) return (curveA, tokenA);
        return (curveB, tokenB);
    }

    function tokens(uint256 i) external view returns (address) {
        return i == 0 ? address(tokenA) : address(tokenB);
    }

    // ------------------------------------------------------------------
    // Tahakkuk
    // ------------------------------------------------------------------

    function _accrueFrom(address venue, uint256 which, uint256 amount) internal {
        (, MockLaunchToken t) = _pick(which);
        amount = _bound(amount, 1, 5e18);
        vm.deal(venue, amount);
        vm.prank(venue);
        treasury.accrue{value: amount}(address(t));

        if (firstAccrualAt[address(t)] == 0) firstAccrualAt[address(t)] = block.timestamp;
        ghostAccrued[address(t)] += amount;
        accruals++;
    }

    function accrueFromCurve(uint256 which, uint256 amount) external {
        (MockCurve c,) = _pick(which);
        _accrueFrom(address(c), which, amount);
    }

    function accrueFromHook(uint256 which, uint256 amount) external {
        _accrueFrom(HOOK, which, amount);
    }

    /// Yabanci tahakkuk. BASARILI OLMAMALI -- baska bir launch'in butcesini
    /// sisirmek tam olarak buradan gecerdi.
    function accrueFromStranger(uint256 which, uint256 amount) external {
        (, MockLaunchToken t) = _pick(which);
        amount = _bound(amount, 1, 5e18);
        vm.deal(STRANGER, amount);
        vm.prank(STRANGER);
        try treasury.accrue{value: amount}(address(t)) {
            // `msg.value == 0` erken doner ve bu MESRUDUR; bagladigimiz alt
            // sinir 1 oldugu icin buraya dusen her basari GERCEK bir ihlaldir.
            strangerAccrued++;
        } catch {
            // Beklenen yol.
        }
    }

    // ------------------------------------------------------------------
    // Supurme
    // ------------------------------------------------------------------

    function sweepAsKeeper(uint256 which) external {
        (, MockLaunchToken t) = _pick(which);
        address token = address(t);
        uint256 pending = treasury.pendingQuote(token);
        if (pending == 0) return;

        vm.prank(KEEPER);
        treasury.sweep(token, 0, block.timestamp + 60);

        // SUPURME BUTCEYI HER ZAMAN SIFIRLAR -- alim yapilsa da yapilmasa da.
        // Geri katlama da bir supurmedir.
        if (treasury.pendingQuote(token) != 0) pendingSurvivedSweep++;
        ghostRemoved[token] += pending;
        sweeps++;
    }

    /**
     * Yabanci supurme. Yedinci gunden ONCE reddedilmeli, SONRA kabul.
     *
     * IKI IHLAL AYRI SAYILIR: erken bir basari `strangerSwept`, gec bir
     * REDDEDIS ise fon kilitlenmesi demektir ve `sweepIsPermissionless` ile
     * karsilastirilarak yakalanir.
     */
    function sweepAsStranger(uint256 which) external {
        (, MockLaunchToken t) = _pick(which);
        address token = address(t);
        uint256 pending = treasury.pendingQuote(token);
        if (pending == 0) return;

        bool open = treasury.sweepIsPermissionless(token);
        vm.prank(STRANGER);
        try treasury.sweep(token, 0, block.timestamp + 60) {
            if (!open) strangerSwept++;
            if (treasury.pendingQuote(token) != 0) pendingSurvivedSweep++;
            ghostRemoved[token] += pending;
            sweeps++;
        } catch {
            // Kapali pencerede reddedilmek DOGRUDUR. Acikken reddedilmek
            // fon kilitlemektir ve ayni sayacta gorunur.
            if (open) strangerSwept++;
        }
    }

    // ------------------------------------------------------------------
    // Cevre
    // ------------------------------------------------------------------

    /**
     * ZORLA GONDERILEN NATIVE -- ARC'IN SALDIRI YUZEYI.
     *
     * Hazinenin `receive()`i yoktur, ama Arc'ta tek bakiyenin ERC-20
     * gorunumune yapilan duz bir `transfer` HICBIR KOD CALISTIRMADAN bakiyeyi
     * artirir. `vm.deal` o etkiyi birebir taklit eder. Hicbir butce
     * buyumemeli: hazine `balanceOf` OKUMAZ, `pendingQuote`u ACIK izler.
     */
    function donateNative(uint256 amount) external {
        amount = _bound(amount, 1, 10e18);
        uint256 a = treasury.pendingQuote(address(tokenA));
        uint256 b = treasury.pendingQuote(address(tokenB));

        vm.deal(address(treasury), address(treasury).balance + amount);
        ghostDonated += amount;

        if (treasury.pendingQuote(address(tokenA)) != a) donationMovedBudget++;
        if (treasury.pendingQuote(address(tokenB)) != b) donationMovedBudget++;
    }

    function advanceTime(uint256 step) external {
        step = _bound(step, 1, MAX_STEP);
        clock += step;
        vm.warp(clock);

        // SAAT ILERLEDIKTEN SONRA PENCEREYI OLC. `SWEEP_GRACE` dolmadan
        // izinsiz olan bir token, anahtarcinin yedi gunluk tekelini delerdi.
        address[2] memory ts = [address(tokenA), address(tokenB)];
        for (uint256 i = 0; i < 2; i++) {
            uint256 first = firstAccrualAt[ts[i]];
            if (first == 0) continue;
            if (
                treasury.sweepIsPermissionless(ts[i])
                    && block.timestamp <= treasury.lastSweepAt(ts[i]) + treasury.SWEEP_GRACE()
            ) {
                earlyPermissionless++;
            }
        }
    }

    /// Egriyi mezun yapar: merci havuza gecer ve taklit havuz "acilmamis"
    /// dedigi icin supurme GERI KATLAMAYA duser. Ayri bir kod yolu.
    function graduateCurve(uint256 which) external {
        (MockCurve c,) = _pick(which);
        c.setComplete(true);
        c.setGraduated(true);
    }
}
