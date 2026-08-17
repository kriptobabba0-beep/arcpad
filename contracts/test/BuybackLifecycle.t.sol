// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {ArcpadHook} from "../src/ArcpadHook.sol";
import {ArcpadLocker} from "../src/ArcpadLocker.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../src/BuybackVestingVault.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {GraduationMath} from "../src/libraries/GraduationMath.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {UsdcMock} from "./helpers/ArcUsdcMock.sol";

/// @dev `unlock` sahibi swap sarmalayicisi -- ucuncu taraf islemleri uretir.
contract LifecycleSwapper is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) external returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountSpecified)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) = abi.decode(data, (PoolKey, bool, int256));
        BalanceDelta delta = pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _settle(Currency c, int128 amt) private {
        if (amt == 0) return;
        if (amt < 0) {
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(pm), uint256(int256(-amt)));
            pm.settle();
        } else {
            pm.take(c, address(this), uint256(int256(amt)));
        }
    }
}

/**
 * @title BuybackLifecycle
 * @notice UC TOKEN, ONLARCA ISLEM, TAM DONGU: launch -> alim/satim ->
 *         mezuniyet -> havuz swaplari -> supurme -> bes yillik vesting.
 *
 * @dev NICIN AYRI BIR PAKET. `BuybackTreasury.t.sol` mekanizmalari TEK TEK
 *      olcer; `BuybackPoolVenue.t.sol` havuz merciini olcer;
 *      `BuybackPermissions.t.sol` izin modelini. Hicbiri BIRLIKTE ne oldugunu
 *      olcmez -- ve bu ozellikte tehlike tam olarak orada: para dort kontrat
 *      arasinda dolasir (`BondingCurve` -> `BuybackTreasury` -> havuz ->
 *      `BuybackVestingVault` -> `FeeEscrow`) ve her sinirda bir yuvarlama
 *      vardir.
 *
 * @dev BU PAKETIN MERKEZI IDDIASI KORUNUMDUR: creator'in kazandigi her wei ya
 *      escrow'da ya hazinede ya kasada olmalidir. Hicbir wei bir kontratin
 *      icinde SIKISIP KALMAMALIDIR. Tek tek testler bunu goremez cunku her
 *      biri kendi kucuk dunyasinda baslar ve biter.
 */
contract BuybackLifecycleTest is Test {
    using StateLibrary for IPoolManager;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant ARCPAD_HOOK_FLAGS = 0x20CC;

    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;

    address internal constant PROTOCOL = address(0x7EA5);
    address internal constant GOVERNOR = address(0x600D);
    address internal constant ALICE = address(0xA11CE); // creator A
    address internal constant BOB = address(0xB0B); //    creator B
    address internal constant KEEPER = address(0x4EE9);

    /// @dev Alim/satim yapan uc bagimsiz tuccar. Tek bir cuzdanla yapilan
    ///      testler, `msg.sender`e bagli bir hatayi goremez.
    ///
    /// @dev `makeAddr`, ELLE SECILEN KUCUK LITERALLER DEGIL -- VE FARK
    ///      OLCULDU. Ilk hal `address(0x71)` kullaniyordu ve `BondingCurve`in
    ///      iade `call`i O ADRESE BASARISIZ oluyordu (`RefundFailed()`),
    ///      yani test kontratta olmayan bir hatayi bildiriyordu. Kucuk
    ///      adresler precompile araligina komsudur ve o aralik EVM
    ///      surumleriyle GENISLER; bir test cuzdaninin oraya dusmesi icin
    ///      hicbir sebep yok.
    address internal T1;
    address internal T2;
    address internal T3;

    IPoolManager internal pm;
    FeeEscrow internal escrow;
    FeeSchedule internal schedule;
    LaunchFactory internal factory;
    ArcpadHook internal hook;
    ArcpadLocker internal locker;
    BuybackVestingVault internal vault;
    BuybackTreasury internal treasury;
    LifecycleSwapper internal swapper;

    uint256 internal t0;

    function setUp() public {
        // MUTLAK ZAMAN TABANI. Bu paket bes YILLIK bir vesting yurur, yani
        // `block.timestamp + X` zincirleri kacinilmaz olurdu -- ve bu depoda
        // `via_ir` altinda goreli warp'larin SESSIZCE etkisiz kaldigi
        // olculdu. Her warp asagida `t0`dan MUTLAK kurulur.
        T1 = makeAddr("trader1");
        T2 = makeAddr("trader2");
        T3 = makeAddr("trader3");

        t0 = 1_800_000_000;
        vm.warp(t0);

        pm = IPoolManager(address(new PoolManager(address(this))));
        UsdcMock usdc = new UsdcMock();
        vm.etch(GraduationMath.QUOTE, address(usdc).code);

        escrow = new FeeEscrow();
        schedule = new FeeSchedule();
        factory = new LaunchFactory(address(escrow), PROTOCOL, GOVERNOR, T, V, S, address(schedule));

        bytes memory args = abi.encode(IPoolManager(address(pm)), address(factory), address(escrow));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, ARCPAD_HOOK_FLAGS, type(ArcpadHook).creationCode, args);
        vm.prank(CREATE2_DEPLOYER);
        hook = new ArcpadHook{salt: salt}(IPoolManager(address(pm)), address(factory), address(escrow));
        require(address(hook) == hookAddr, "mined address diverged");

        locker = new ArcpadLocker(pm, address(factory), IHooks(address(hook)));
        vault = new BuybackVestingVault(address(factory));
        treasury = new BuybackTreasury(address(factory), address(escrow), vault, pm);

        vm.startPrank(GOVERNOR);
        factory.setBuybackTreasury(address(treasury));
        factory.setGraduationHook(address(hook));
        factory.setBuybackKeeper(KEEPER);
        factory.proposeGraduationTarget(address(locker));
        vm.stopPrank();
        vm.warp(t0 + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();

        swapper = new LifecycleSwapper(pm);
    }

    // ---------------------------------------------------------------
    // Yardimcilar
    // ---------------------------------------------------------------

    function _launch(address creator, string memory name, bool buyback)
        internal
        returns (address token, address payable curve)
    {
        vm.prank(creator);
        (address tk, address cv) =
            buyback ? factory.launchWithBuyback(name, "ARC", "ipfs://x", true) : factory.launch(name, "ARC", "ipfs://x");
        return (tk, payable(cv));
    }

    function _buy(address who, address payable curve, uint256 weiIn) internal {
        vm.deal(who, who.balance + weiIn);
        vm.prank(who);
        BondingCurve(curve).buyExactQuoteIn{value: weiIn}(0);
    }

    function _sell(address who, address token, address payable curve, uint256 amount) internal {
        vm.startPrank(who);
        IERC20(token).approve(curve, amount);
        BondingCurve(curve).sellExactTokensIn(amount, 0);
        vm.stopPrank();
    }

    /**
     * @dev AL-SAT DONGUSU: ucret biriktirir ama egriyi TAMAMLAMAZ.
     *
     *      NICIN GEREKLI. Testnet profilinin mezuniyet raise'i ~12,16
     *      USDC'dir, yani tek yonlu alimla toplanabilecek creator ucreti
     *      ~0,036 USDC ile sinirlidir -- `MIN_SWEEP_WEI` (0,05) esiginin
     *      ALTINDA. Ilk hal bunu gormemisti ve alti test "butce esigin
     *      altinda" ile kirmizi oldu.
     *
     *      Her tur IKI ucret uretir (alimda ve satista), ve satis yolu
     *      `_settleCreatorFee`in ikinci cagri yeridir -- yani bu yardimci
     *      esigi asmakla kalmaz, olculen yuzeyi de GENISLETIR.
     */
    function _churn(address token, address payable curve, address who, uint256 rounds, uint256 weiPerBuy) internal {
        for (uint256 i = 0; i < rounds; ++i) {
            _buy(who, curve, weiPerBuy);
            uint256 held = IERC20(token).balanceOf(who);
            if (held != 0) _sell(who, token, curve, held);
        }
    }

    /// @dev Egriyi tamamlayip mezun eder ve havuzu acar.
    function _graduate(address token, address payable curve) internal returns (PoolKey memory key) {
        // ARGUMAN, PRANK'TEN ONCE OKUNUR -- VE BU ZORUNLUDUR.
        //
        // `vm.prank` YALNIZCA BIR SONRAKI CAGRIYI etkiler, ve arguman
        // ifadeleri o cagridan ONCE degerlendirilir. Ilk hal
        // `buyExactTokensOut(BondingCurve(curve).realTokenReserves(), ...)`
        // yaziyordu: ic okuma prank'i TUKETTI, alimi TEST KONTRATI yapti, ve
        // egrinin iade `call`i test kontratinin `receive()`i olmadigi icin
        // `RefundFailed()` ile dustu. Test, kontratta OLMAYAN bir hatayi
        // bildiriyordu.
        uint256 remaining = BondingCurve(curve).realTokenReserves();
        vm.deal(T1, T1.balance + 1_000_000e18);
        vm.prank(T1);
        BondingCurve(curve).buyExactTokensOut{value: 100_000e18}(remaining, type(uint256).max);
        require(BondingCurve(curve).complete(), "curve not complete");
        locker.graduate(curve);
        (key,) = GraduationMath.poolKey(token, IHooks(address(hook)));
    }

    function _poolTrade(PoolKey memory key, uint256 quoteIn) internal {
        vm.deal(address(swapper), address(swapper).balance + quoteIn * 2 * 1e12);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == GraduationMath.QUOTE;
        swapper.swap(key, quoteIsCurrency0, -int256(quoteIn));
    }

    // ---------------------------------------------------------------
    // 1. UC TOKEN PARALEL -- BUTCELER KARISMAZ
    // ---------------------------------------------------------------

    /**
     * UC LAUNCH, ONLARCA ISLEM, UC AYRI SONUC.
     *
     * @dev CROSS-TOKEN BULASMA (spec §30) ancak boyle olculur: butun defterler
     *      `mapping(address token => ...)`tir, ama bir `token` parametresini
     *      unutmak DERLEYICIDEN GECER ve tek tokenli bir testte GORUNMEZ.
     */
    function test_uc_token_paralel_butceler_karismaz() public {
        (address a, address payable ca) = _launch(ALICE, "A", true); // buyback ACIK
        (address b, address payable cb) = _launch(BOB, "B", false); // buyback KAPALI
        (address c, address payable cc) = _launch(ALICE, "C", true); // buyback ACIK

        // ONLARCA ISLEM, uc ayri tuccar, degisen buyuklukler.
        for (uint256 i = 0; i < 12; ++i) {
            _buy(T1, ca, 0.5e18 + i * 1e17);
            _buy(T2, cb, 0.5e18 + i * 1e17);
            _buy(T3, cc, 0.25e18 + i * 5e16);
        }

        uint256 pa = treasury.pendingQuote(a);
        uint256 pb = treasury.pendingQuote(b);
        uint256 pc = treasury.pendingQuote(c);

        assertGt(pa, 0, "A buyback acikti ama butce olusmadi");
        assertEq(pb, 0, "B buyback KAPALI ama butce olustu -- cross-token bulasma");
        assertGt(pc, 0, "C buyback acikti ama butce olusmadi");
        assertTrue(pa != pc, "A ve C ayni butceyi uretti -- hacimler farkliydi, defter TEK olabilir");

        // B'nin creator'i ucretin TAMAMINI nakit almis olmali.
        assertGt(escrow.owed(BOB), 0, "B creator'i hic nakit almadi");
    }

    /**
     * SATISLAR DA AYRILIR -- alim ile satim ayni yoldan gecer.
     *
     * @dev `_settleCreatorFee` hem `_settleBuy` hem satis yolundan cagrilir.
     *      Yalnizca alim yurutten bir test, satis yolundaki eksik bir cagriyi
     *      GORMEZ.
     */
    function test_satislar_da_buyback_payi_ayirir() public {
        (address a, address payable ca) = _launch(ALICE, "A", true);

        _buy(T1, ca, 5e18);
        uint256 afterBuys = treasury.pendingQuote(a);
        assertGt(afterBuys, 0, "alimlar pay ayirmadi");

        uint256 held = IERC20(a).balanceOf(T1);
        assertGt(held, 0, "tuccarin tokeni yok -- satis olculemez");
        _sell(T1, a, ca, held / 2);

        assertGt(treasury.pendingQuote(a), afterBuys, "satis buyback payi AYIRMADI");
    }

    // ---------------------------------------------------------------
    // 2. KORUNUM -- HICBIR WEI KAYBOLMAZ
    // ---------------------------------------------------------------

    /**
     * TAHAKKUK EDEN HER WEI YA HARCANIR YA IADE EDILIR -- VE HICBIRI SIKISMAZ.
     *
     * @dev ============ OLCULEN ASIMETRI: EGRI MERCII UCRET ODER ============
     *
     *      Bu testin ILK hali `spent + escrowDelta == accrued` yaziyordu ve
     *      94.672.977.389.009 wei FAZLA olctu. Sebep bir hata degil, KAYDA
     *      GECIRILMEMIS bir davranistir: hazinenin EGRI uzerinden yaptigi alim
     *      normal bir islemdir ve UCRETE TABIDIR. O ucretin creator payi
     *      ALICE'in escrow bakiyesine geri doner, yani `escrow.owed(ALICE)`
     *      iki AYRI sebeple buyur:
     *        (1) supurmenin harcayamadigi kismin IADESI,
     *        (2) supurmenin KENDI aliminin creator ucreti.
     *
     *      HAVUZ MERCIINDE BOYLE DEGIL: `ArcpadHook._collect` hazineyi ucretten
     *      MUAF tutar. Yani iki merci ayni ekonomiyi uretmiyor:
     *        egri : buyback butcesinin ~%0,95'i PROTOKOLE sizar,
     *                creator payi (~%0,30) creator'a geri doner,
     *                ve o payin yarisi YENIDEN tahakkuk eder.
     *        havuz: sizinti YOK (yalnizca LP ucreti odenir).
     *
     *      BU BIR KARAR NOKTASIDIR VE DEPO SAHIBINE BILDIRILDI. Egriyi de muaf
     *      tutmak `BondingCurve`in initcode'unu degistirir, o da
     *      `LaunchFactory`ninkini (curve initcode'u fabrikaya GOMULUDUR), o da
     *      FABRIKA ADRESINI, o da hook tuzunu -- yani butun adres kumesi
     *      yeniden madenlenir. Bedeli olcusunde bir karar oldugu icin sessizce
     *      alinmadi.
     *
     *      TEST BU YUZDEN OLAYLARDAN OLCER: escrow'un `Deposited` olayindaki
     *      `from` alani, paranin HAZINEDEN mi (iade) yoksa EGRIDEN mi (ucret)
     *      geldigini ayirir. Iki kaynagi toplayip tek bir esitlik yazmak,
     *      yukaridaki asimetriyi tam da gormemesi gereken yerde gizlerdi.
     */
    function test_korunum_tahakkuk_eden_her_wei_hesapta() public {
        (address a, address payable ca) = _launch(ALICE, "A", true);
        _churn(a, ca, T1, 10, 5e18);

        uint256 accrued = treasury.pendingQuote(a);
        assertGt(accrued, treasury.MIN_SWEEP_WEI(), "butce esigin altinda");

        vm.recordLogs();
        vm.prank(KEEPER);
        treasury.sweep(a, 0, block.timestamp + 1);

        // LOGLAR BIR KEZ ALINIR: `vm.getRecordedLogs()` KUYRUGU BOSALTIR, yani
        // iki ayri cagri ikinci toplami SIFIR olarak olcerdi -- ve sifir, bu
        // testte "asimetri yok" anlamina gelen bir SAHTE YESIL olurdu.
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 spent = treasury.cumulativeQuoteSpent(a);
        uint256 refundedByTreasury = _depositsFrom(logs, address(treasury), ALICE);
        uint256 feeFromBuybackTrade = _depositsFrom(logs, ca, ALICE);

        // (1) BUTCE TAM OLARAK KAPANIR: harcanan + hazinenin iadesi.
        assertEq(spent + refundedByTreasury, accrued, "butce kapanmadi -- fark SIKISTI");

        // (2) HAZINEDE ORFAN WEI YOK: kalan bakiye NE ISE bekleyen O'dur.
        assertEq(address(treasury).balance, treasury.pendingQuote(a), "hazinede muhasebesiz bakiye var");

        // (3) ...VE ASIMETRI GERCEKTEN VAR. Sifir olsaydi ustteki NatSpec
        //     bayat olurdu; bu satir onu her kosuda dogrular.
        assertGt(feeFromBuybackTrade, 0, "egri mercii ucret odemedi -- asimetri kapanmis olabilir");
        assertGt(treasury.pendingQuote(a), 0, "yeniden tahakkuk olusmadi -- NatSpec bayat");
    }

    /// @dev VERILEN log dizisinden, BELIRLI bir gonderenden BELIRLI bir
    ///      aliciya yapilan escrow yatirimlarinin toplami. Diziyi PARAMETRE
    ///      alir, `vm.getRecordedLogs()`u kendi CAGIRMAZ -- o cagri kuyrugu
    ///      bosaltir ve yardimciyi iki kez kullanmak imkansiz olurdu.
    function _depositsFrom(Vm.Log[] memory logs, address from, address recipient)
        internal
        view
        returns (uint256 total)
    {
        bytes32 topic = keccak256("Deposited(address,address,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow) || logs[i].topics[0] != topic) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != recipient) continue;
            if (address(uint160(uint256(logs[i].topics[2]))) != from) continue;
            total += abi.decode(logs[i].data, (uint256));
        }
    }

    /// @dev ...VE MEZUNIYETTEN SONRA DA. Havuz yolu ayri bir kod yolu, ayni
    ///      korunum iddiasi.
    function test_korunum_mezuniyetten_sonra_da_gecerli() public {
        (address a, address payable ca) = _launch(ALICE, "A", true);
        PoolKey memory key = _graduate(a, ca);

        for (uint256 i = 0; i < 6; ++i) {
            _poolTrade(key, 1e6);
        }

        // Butceyi mesru mercii uzerinden anlamli bir seviyeye tasi.
        vm.deal(address(hook), address(hook).balance + 0.2e18);
        vm.prank(address(hook));
        treasury.accrue{value: 0.2e18}(a);

        uint256 accrued = treasury.pendingQuote(a);
        uint256 creatorBefore = escrow.owed(ALICE);

        vm.prank(KEEPER);
        treasury.sweep(a, 0, block.timestamp + 1);

        uint256 spent = treasury.cumulativeQuoteSpent(a);
        uint256 refunded = escrow.owed(ALICE) - creatorBefore;
        assertEq(spent + refunded, accrued, "havuz yolunda korunum bozuldu");
        assertEq(address(treasury).balance, 0, "hazinede bakiye kaldi");
    }

    // ---------------------------------------------------------------
    // 3. TAM DONGU -- LAUNCH'TAN VESTING SONUNA
    // ---------------------------------------------------------------

    /**
     * BES YILIN SONUNDA: %70 CREATOR, %30 PROTOKOL.
     *
     * @dev Ekonomik kararin TEK yurutulebilir kanit noktasi. Oran ucret
     *      kademesinden AYRIDIR ve o ayrim burada olculur: kademe %95/%30'dur,
     *      vest bolusmesi %30/%70.
     */
    function test_tam_dongu_bes_yil_sonunda_bolusme() public {
        (address a, address payable ca) = _launch(ALICE, "A", true);
        _churn(a, ca, T1, 10, 5e18);

        vm.prank(KEEPER);
        treasury.sweep(a, 0, block.timestamp + 1);

        uint256 locked = vault.totalLocked(a);
        assertGt(locked, 0, "kasaya hicbir sey kilitlenmedi");

        // BES YIL, MUTLAK OLARAK KURULDU.
        vm.warp(t0 + factory.GRADUATION_TARGET_DELAY() + vault.VESTING_DURATION() + 1);

        uint256 creatorBefore = IERC20(a).balanceOf(ALICE);
        uint256 protocolBefore = IERC20(a).balanceOf(PROTOCOL);

        vm.prank(ALICE);
        uint256 released = vault.release(a);

        assertEq(released, locked, "bes yil sonunda tamami hak edilmis olmali");

        uint256 toCreator = IERC20(a).balanceOf(ALICE) - creatorBefore;
        uint256 toProtocol = IERC20(a).balanceOf(PROTOCOL) - protocolBefore;

        assertEq(toCreator + toProtocol, released, "dagitim toplami serbest birakilandan farkli");
        // %30 protokol -- tabana yuvarlama creator'in lehinedir.
        assertEq(toProtocol, (released * 3_000) / 10_000, "protokol payi %30 degil");
        assertEq(toCreator, released - toProtocol, "creator payi kalan degil");
    }

    /// @dev YARIM YOLDA hak edilen, dogrusal olmali.
    function test_vesting_yarida_yaklasik_yarisi() public {
        (address a, address payable ca) = _launch(ALICE, "A", true);
        _churn(a, ca, T1, 10, 5e18);
        uint256 sweepAt = t0 + factory.GRADUATION_TARGET_DELAY();
        vm.prank(KEEPER);
        treasury.sweep(a, 0, block.timestamp + 1);
        uint256 locked = vault.totalLocked(a);

        vm.warp(sweepAt + vault.VESTING_DURATION() / 2);
        uint256 half = vault.releasable(a);

        // Tek bir yatirim var, yani agirlikli saat = yatirim ani; yarida
        // hak edilen, toplamin yarisina COK yakin olmali (blok granuluitesi).
        assertApproxEqRel(half, locked / 2, 0.01e18, "yarida hak edilen dogrusal degil");
        assertLt(half, locked, "yarida tamami hak edilmis gorunuyor");
    }

    // ---------------------------------------------------------------
    // 4. TOGGLE, TAM DONGU ICINDE
    // ---------------------------------------------------------------

    /**
     * ORTADA KAPATMAK: ONCESI BUYBACK, SONRASI NAKIT.
     *
     * @dev `BuybackPermissions.t.sol` bunu tek bir islemle olcer; burada
     *      ONLARCA islem ve GERCEK bir supurme ile yurunur -- yani kapatmanin
     *      birikmis butceyi harcamayi da engellemedigi gosterilir.
     */
    function test_ortada_kapatmak_birikmisi_harcamayi_engellemez() public {
        (address a, address payable ca) = _launch(ALICE, "A", true);
        _churn(a, ca, T1, 10, 5e18);
        uint256 accrued = treasury.pendingQuote(a);
        assertGt(accrued, treasury.MIN_SWEEP_WEI(), "butce esigin altinda");

        vm.prank(ALICE);
        factory.setBuybackEnabled(a, false);

        // Kapatmak butceyi KIMILDATMAZ.
        assertEq(treasury.pendingQuote(a), accrued, "kapatmak butceyi geri aldi");

        // Sonraki islemler NAKIT gider.
        uint256 pendingBefore = treasury.pendingQuote(a);
        _buy(T2, ca, 2e18);
        assertEq(treasury.pendingQuote(a), pendingBefore, "kapaliyken pay ayrildi");

        // ...ve birikmis butce YINE DE harcanir.
        vm.prank(KEEPER);
        treasury.sweep(a, 0, block.timestamp + 1);
        assertGt(treasury.cumulativeTokensBought(a), 0, "kapatmak birikmis butceyi harcanamaz kildi");
        assertGt(vault.totalLocked(a), 0, "kasaya kilitlenmedi");
    }

    // ---------------------------------------------------------------
    // 5. FUZZ -- ORAN HER BUYUKLUKTE KORUNUR
    // ---------------------------------------------------------------

    /**
     * @dev Elle secilen buyuklukler bir sinifi kacirabilir. Burada tek iddia
     *      ORANDIR: ayrilan pay, creator ucretinin `BUYBACK_LOCK_BPS`i olmali
     *      -- alim buyuklugu ne olursa olsun.
     *
     *      TABANA YUVARLAMA BEKLENIR VE SINIRLANIR: `(x * bps) / 10_000` bir
     *      tam sayi bolmesidir, yani nakit pay 1 wei'ye kadar FAZLA olabilir.
     *      Iddia esitlik degil, TOPLAMIN korunmasi ve oranin 1 wei icinde
     *      tutmasidir.
     */
    function testFuzz_oran_her_buyuklukte_korunur(uint96 raw) public {
        uint256 weiIn = uint256(raw);
        vm.assume(weiIn >= 1e15 && weiIn <= 50e18);

        (address a, address payable ca) = _launch(ALICE, "A", true);

        uint256 cash0 = escrow.owed(ALICE);
        _buy(T1, ca, weiIn);

        uint256 buyback = treasury.pendingQuote(a);
        uint256 cash = escrow.owed(ALICE) - cash0;
        uint256 total = buyback + cash;
        vm.assume(total > 0);

        uint256 expected = (total * factory.BUYBACK_LOCK_BPS()) / 10_000;
        assertApproxEqAbs(buyback, expected, 1, "oran 1 wei'den fazla saptI");
        assertEq(buyback + cash, total, "toplam korunmadi");
    }

    /// @dev ...VE PROTOKOL PAYI HIC ETKILENMEZ, hangi buyuklukte olursa olsun.
    function testFuzz_protokol_payi_buybacktan_etkilenmez(uint96 raw) public {
        uint256 weiIn = uint256(raw);
        vm.assume(weiIn >= 1e15 && weiIn <= 50e18);

        (, address payable withBuyback) = _launch(ALICE, "A", true);
        (, address payable without) = _launch(BOB, "B", false);

        uint256 p0 = escrow.owed(PROTOCOL);
        _buy(T1, withBuyback, weiIn);
        uint256 gainOn = escrow.owed(PROTOCOL) - p0;

        uint256 p1 = escrow.owed(PROTOCOL);
        _buy(T2, without, weiIn);
        uint256 gainOff = escrow.owed(PROTOCOL) - p1;

        assertEq(gainOn, gainOff, "buyback protokol payini degistirdi");
    }
}
