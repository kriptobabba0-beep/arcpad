// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
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
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {UsdcMock} from "./ArcpadHook.t.sol";
import {ArcpadRouter} from "../src/ArcpadRouter.sol";
import {ArcpadHook} from "../src/ArcpadHook.sol";
import {ArcpadLocker} from "../src/ArcpadLocker.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {GraduationMath} from "../src/libraries/GraduationMath.sol";
import {DeployLib} from "../script/DeployLib.sol";
import {PoolDeployLib} from "../script/PoolDeployLib.sol";
import {RouterDeployLib, RouterPlan} from "../script/RouterDeployLib.sol";

/// @dev Router'in HICBIR ZAMAN CAGIRMAMASI gereken bir token. Her uyesi
///      sayaci artirir ve revert eder, yani router ona TEK BIR CAGRI bile
///      yaparsa test bunu GORUR -- "revert etti" ile "hic dokunulmadi"
///      arasindaki farki olcen sey budur.
contract HostileToken {
    uint256 public calls;

    fallback() external {
        ++calls;
        revert("hostile token was called");
    }
}

/// @dev `PoolManager.unlock`u KENDI adina cagiran saldirgan.
/// @dev OLCTUGU SEY YAPISALDIR: `unlock` geri cagriyi
///      `IUnlockCallback(msg.sender)` uzerine yapar, yani saldirganin
///      `unlock`u ROUTER'IN callback'ini HIC calistirmaz -- kendi
///      kontratininkini calistirir. Bu kontrat o cagriyi KAYDEDER.
contract ForgedUnlocker is IUnlockCallback {
    IPoolManager public immutable pm;
    uint256 public ownCallbackRuns;
    bytes public sawData;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function go(bytes memory data) external {
        pm.unlock(data);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "forged: not the manager");
        ++ownCallbackRuns;
        sawData = data;
        // Hicbir sey yapilmaz, dolayisiyla delta da yoktur ve `unlock`
        // `CurrencyNotSettled` vermeden doner.
        return "";
    }
}

/// @title ArcpadRouterTest
/// @notice Mezuniyet sonrasi ticaretin TEK giris noktasi, GERCEK
///         `PoolManager` + GERCEK `ArcpadHook` + GERCEK `ArcpadLocker`
///         uzerinde.
///
/// @dev BU DOSYADA `LockerStub` YOKTUR VE BU BILINCLIDIR. Havuzu acan ve
///      tohumlayan sey uretimdeki `ArcpadLocker`in kendisidir; bir stub,
///      "sahte gercek kodun isini yapiyor" kipine girerdi. Yalnizca
///      `UsdcMock` bir yerine-gecendir ve o da Arc'in TEK BAKIYE / IKI
///      GORUNUM ozelligini modeller -- yerel EVM'de baska turlu var olmayan
///      tek sey odur. Ayni model `ArcpadHook.t.sol`dan IMPORT edilir,
///      KOPYALANMAZ: iki kopya ayrisabilirdi ve ayrisma sessiz olurdu.
///
/// @dev IKI PARA BIRIMI SIRALAMASI DA YURUNUR. Router'in `zeroForOne`
///      turetmesi `baseIsCurrency0`a baglidir; `zeroForOne = buy` diye
///      yazilmis bir mutant siralamalardan BIRINDE gecer. Tek siralamayla
///      kosan bir paket o mutanti goremezdi.
contract ArcpadRouterTest is Test {
    using StateLibrary for IPoolManager;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant ARCPAD_HOOK_FLAGS = 0x20CC;

    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant GOVERNOR = address(0x600D);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant TRADER = address(0x712ADE2);
    address internal constant THIRD_PARTY = address(0x3D1D);
    address internal constant ATTACKER = address(0xBAD);

    /// @notice Tek bir takasta kullanilan quote miktari, 6-decimal birim.
    /// @dev 1 USDC. Kademe gecisi UZAKTIR (ilk esik 59.000 USDC) ve
    ///      `test_theFeeIsTierZeroOnEveryShape` bunu ayrica iddia eder.
    uint256 internal constant ONE_USDC = 1_000_000;

    IPoolManager internal pm;
    UsdcMock internal usdc;
    FeeEscrow internal escrow;
    FeeSchedule internal schedule;
    LaunchFactory internal factory;
    ArcpadHook internal hook;
    ArcpadLocker internal locker;
    ArcpadRouter internal router;

    function setUp() public {
        pm = IPoolManager(address(new PoolManager(address(this))));

        usdc = new UsdcMock();
        vm.etch(GraduationMath.QUOTE, address(usdc).code);
        usdc = UsdcMock(GraduationMath.QUOTE);

        escrow = new FeeEscrow();
        schedule = new FeeSchedule();
        factory = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(schedule));

        bytes memory args = abi.encode(IPoolManager(address(pm)), address(factory), address(escrow));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, ARCPAD_HOOK_FLAGS, type(ArcpadHook).creationCode, args);
        vm.prank(CREATE2_DEPLOYER);
        hook = new ArcpadHook{salt: salt}(IPoolManager(address(pm)), address(factory), address(escrow));
        require(address(hook) == hookAddr, "mined hook address diverged");

        locker = new ArcpadLocker(pm, address(factory), IHooks(address(hook)));

        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(locker));
        vm.warp(block.timestamp + factory.GRADUATION_TARGET_DELAY());
        factory.applyGraduationTarget();

        router = new ArcpadRouter(pm, IHooks(address(hook)));
    }

    // ---------------------------------------------------------------
    // Kurulum yardimcilari
    // ---------------------------------------------------------------

    /// @dev Istenen SIRALAMAYA dusen bir aday adi arar; `skip` kadarini atlar
    ///      ki ayni siralamada IKI FARKLI token uretilebilsin. Bulamazsa
    ///      DUSER -- aksi halde test hicbir sey kanitlamadan gecerdi.
    function _nameForOrdering(bool wantBaseIsCurrency0, uint256 skipCount) internal view returns (string memory) {
        uint256 nonce = factory.launchCount();
        uint256 seen;
        for (uint256 i = 0; i < 512; ++i) {
            string memory candidate = string.concat("ARC", vm.toString(i));
            (address predicted,) = factory.predictAddresses(CREATOR, candidate, "ARC", "ipfs://x", nonce);
            if ((predicted < GraduationMath.QUOTE) == wantBaseIsCurrency0) {
                if (seen == skipCount) return candidate;
                ++seen;
            }
        }
        revert("no candidate name lands in the requested currency ordering");
    }

    /// @notice Launch -> satis arzini tuket -> graduate. GERCEK locker ile.
    function _graduatedToken(bool wantBaseIsCurrency0, uint256 skipCount)
        internal
        returns (address token, PoolKey memory key)
    {
        // AD PRANK'TEN ONCE HESAPLANIR VE BU BIR OLCUM SONUCUDUR:
        // `_nameForOrdering` `factory.predictAddresses`i cagirir, yani bir
        // DIS cagridir, ve `vm.prank` yalnizca BIR SONRAKI dis cagriya
        // uygulanir. Argumanin icinde birakildiginda prank'i O cagri yutuyor,
        // `launch` test kontratinin adiyla kosuyor, creator YANLIS oluyor ve
        // (a) creator ucreti 0xC0FFEE'ye HIC gitmiyor, (b) tahmin edilen
        // adres gerceklesenden ayrisip siralama taramasini bozuyordu.
        string memory name = _nameForOrdering(wantBaseIsCurrency0, skipCount);
        vm.prank(CREATOR);
        (address t, address c) = factory.launch(name, "ARC", "ipfs://x");
        token = t;

        vm.deal(address(0xB0FFEE), 1_000_000e18);
        vm.prank(address(0xB0FFEE));
        BondingCurve(payable(c)).buyExactTokensOut{value: 100_000e18}(S, type(uint256).max);
        require(BondingCurve(payable(c)).complete(), "curve did not complete");

        locker.graduate(c);

        bool baseIsCurrency0;
        (key, baseIsCurrency0) = GraduationMath.poolKey(token, IHooks(address(hook)));
        require(baseIsCurrency0 == wantBaseIsCurrency0, "the ordering scan picked the wrong candidate");
        (uint160 sp,,,) = pm.getSlot0(key.toId());
        require(sp != 0, "the pool did not open");
    }

    function _open(bool wantBaseIsCurrency0) internal returns (address token, PoolKey memory key) {
        return _graduatedToken(wantBaseIsCurrency0, 0);
    }

    /// @notice Trader'i HER IKI bacakta da fonlar ve router'a onay verir.
    /// @dev USDC ONAYI `0x3600...` UZERINDEN VERILIR VE SARMALAMA YOKTUR.
    ///      Arc'ta native bakiye ile ERC-20 gorunum AYNI BAKIYEDIR, yani
    ///      `vm.deal` ile verilen native miktar dogrudan `balanceOf`ta
    ///      gorunur ve `transferFrom` onu hareket ettirir.
    function _fund(address who, address token, uint256 tokenWei, uint256 quoteUnits) internal {
        vm.deal(who, quoteUnits * 1e12);
        if (tokenWei != 0) deal(token, who, tokenWei, true);
        vm.startPrank(who);
        IERC20(GraduationMath.QUOTE).approve(address(router), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _quoteUnitsOf(address who) internal view returns (uint256) {
        return IERC20(GraduationMath.QUOTE).balanceOf(who);
    }

    struct FeeSnapshot {
        uint256 protocolOwed;
        uint256 creatorOwed;
    }

    function _fees() internal view returns (FeeSnapshot memory) {
        return FeeSnapshot({protocolOwed: escrow.owed(TREASURY), creatorOwed: escrow.owed(CREATOR)});
    }

    /// @dev Router'in HICBIR SEY TUTMADIGINI iddia eder. Bir bagis bu
    ///      iddiayi bozmaz (bkz. `test_aDonationToTheRouterChangesNothing`);
    ///      burada olculen sey, TAKASIN kendisinin router'da bakiye
    ///      BIRAKMADIGIDIR.
    function _assertRouterIsEmpty(address token) internal view {
        assertEq(IERC20(token).balanceOf(address(router)), 0, "the router held launch tokens after a swap");
        assertEq(address(router).balance, 0, "the router held USDC after a swap");
    }

    // ---------------------------------------------------------------
    // 0. VAKUM BEKCISI -- ROUTER'IN VAR OLMA SEBEBI
    // ---------------------------------------------------------------

    /// @notice BIR EOA HAVUZDA TAKAS YAPAMAZ, VE BU OLCULUR.
    ///
    /// @dev BU TEST BU DOSYANIN GERI KALANININ GEREKCESIDIR. Iddia
    ///      "Uniswap V4 EOA'lara dogrudan bir swap girisi vermez" -- ve
    ///      OKUNARAK degil KOSTURULARAK dogrulanir:
    ///        (1) `swap` `onlyWhenUnlocked`tur; kilit disinda `ManagerLocked`.
    ///        (2) `unlock` geri cagriyi `msg.sender`e yapar; KODSUZ bir
    ///            EOA'da o cagri bos doner, `abi.decode` cakar.
    ///      Ikisi birlikte: callback'i tutan bir kontrat OLMADAN mezun olmus
    ///      bir token TICARET EDILEMEZ.
    function test_anEoaCannotSwapOrUnlockWithoutARouter() public {
        (address token, PoolKey memory key) = _open(false);
        assertGt(token.code.length, 0);

        vm.prank(TRADER);
        vm.expectRevert(IPoolManager.ManagerLocked.selector);
        pm.swap(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(ONE_USDC), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // ...VE `unlock` DA BIR CIKIS YOLU DEGILDIR: `PoolManager` geri
        // cagriyi cagirana yapar ve kodsuz bir adresin donusu bos gelir.
        vm.prank(TRADER);
        vm.expectRevert();
        pm.unlock("");
    }

    // ---------------------------------------------------------------
    // 1. DORT SEKIL x IKI SIRALAMA
    // ---------------------------------------------------------------

    function test_buyExactInSpendsExactlyTheInputAndDeliversToTheRecipient() public {
        _buyExactIn(false);
        _buyExactIn(true);
    }

    function _buyExactIn(bool baseIsCurrency0) internal {
        (address token,) = _open(baseIsCurrency0);
        _fund(TRADER, token, 0, 10 * ONE_USDC);

        uint256 quoted = router.quoteBuyExactIn(token, ONE_USDC);
        assertGt(quoted, 0, "the quote is zero -- the test would measure nothing");

        FeeSnapshot memory f0 = _fees();
        uint256 traderQuote0 = _quoteUnitsOf(TRADER);

        vm.prank(TRADER);
        uint256 got = router.buyExactIn(token, ONE_USDC, quoted, THIRD_PARTY, block.timestamp);

        assertEq(got, quoted, "the realized output is not the quoted output");
        assertEq(traderQuote0 - _quoteUnitsOf(TRADER), ONE_USDC, "exact-input did not spend exactly the input");
        assertEq(IERC20(token).balanceOf(THIRD_PARTY), got, "the recipient did not receive the output");
        assertEq(IERC20(token).balanceOf(TRADER), 0, "the payer received the output instead of the recipient");
        _assertFeeIsTierZeroOn(f0, ONE_USDC);
        _assertRouterIsEmpty(token);
    }

    function test_buyExactOutDeliversExactlyTheRequestedTokens() public {
        _buyExactOut(false);
        _buyExactOut(true);
    }

    function _buyExactOut(bool baseIsCurrency0) internal {
        (address token,) = _open(baseIsCurrency0);
        _fund(TRADER, token, 0, 100 * ONE_USDC);

        uint256 want = 5e24;
        uint256 quotedIn = router.quoteBuyExactOut(token, want);
        assertGt(quotedIn, 0, "the quote is zero -- the test would measure nothing");

        uint256 traderQuote0 = _quoteUnitsOf(TRADER);
        FeeSnapshot memory f0 = _fees();

        vm.prank(TRADER);
        uint256 paid = router.buyExactOut(token, want, quotedIn, TRADER, block.timestamp);

        assertEq(paid, quotedIn, "the realized input is not the quoted input");
        assertEq(IERC20(token).balanceOf(TRADER), want, "exact-output did not deliver exactly the requested tokens");
        assertEq(
            traderQuote0 - _quoteUnitsOf(TRADER), paid, "the payer's quote balance and the reported input disagree"
        );
        // Ucret quote uzerinden alinir ve `afterSwap`ta hesaplanir; net
        // girdi = havuza giden + ucret, dolayisiyla toplam ucret pozitiftir.
        assertGt(_fees().protocolOwed - f0.protocolOwed, 0, "no protocol fee on an exact-output buy");
        assertGt(_fees().creatorOwed - f0.creatorOwed, 0, "no creator fee on an exact-output buy");
        _assertRouterIsEmpty(token);
    }

    function test_sellExactInSpendsExactlyTheTokensAndPaysQuote() public {
        _sellExactIn(false);
        _sellExactIn(true);
    }

    function _sellExactIn(bool baseIsCurrency0) internal {
        (address token,) = _open(baseIsCurrency0);
        _fund(TRADER, token, 5e24, 0);

        uint256 quoted = router.quoteSellExactIn(token, 5e24);
        assertGt(quoted, 0, "the quote is zero -- the test would measure nothing");

        FeeSnapshot memory f0 = _fees();
        uint256 traderQuote0 = _quoteUnitsOf(TRADER);

        vm.prank(TRADER);
        uint256 got = router.sellExactIn(token, 5e24, quoted, TRADER, block.timestamp);

        assertEq(got, quoted, "the realized output is not the quoted output");
        assertEq(IERC20(token).balanceOf(TRADER), 0, "exact-input did not spend exactly the tokens");
        assertEq(_quoteUnitsOf(TRADER) - traderQuote0, got, "the payer's quote credit and the reported output disagree");

        // KULLANICIYA GOSTERILEN SAYI HOOK'UN PAYI DUSULMUS SAYIDIR, VE BU
        // BURADA ARITMETIK OLARAK KAPANIR: brut = net + ucret, ve ucret
        // BRUT'un 95+30 bps'i.
        uint256 feeUnits = (_fees().protocolOwed - f0.protocolOwed + _fees().creatorOwed - f0.creatorOwed) / 1e12;
        assertGt(feeUnits, 0, "no fee was taken -- the quote could not be net of anything");
        uint256 gross = got + feeUnits;
        assertEq(
            feeUnits,
            CurveMath.feeOn(gross, 95) + CurveMath.feeOn(gross, 30),
            "the fee is not 95+30 bps of the gross output"
        );
        _assertRouterIsEmpty(token);
    }

    function test_sellExactOutDeliversExactlyTheRequestedQuote() public {
        _sellExactOut(false);
        _sellExactOut(true);
    }

    function _sellExactOut(bool baseIsCurrency0) internal {
        (address token,) = _open(baseIsCurrency0);
        _fund(TRADER, token, 5e26, 0);

        uint256 want = ONE_USDC;
        uint256 quotedIn = router.quoteSellExactOut(token, want);
        assertGt(quotedIn, 0, "the quote is zero -- the test would measure nothing");

        uint256 tokens0 = IERC20(token).balanceOf(TRADER);
        uint256 third0 = _quoteUnitsOf(THIRD_PARTY);
        FeeSnapshot memory f0 = _fees();

        vm.prank(TRADER);
        uint256 paid = router.sellExactOut(token, want, quotedIn, THIRD_PARTY, block.timestamp);

        assertEq(paid, quotedIn, "the realized input is not the quoted input");
        assertEq(_quoteUnitsOf(THIRD_PARTY) - third0, want, "exact-output did not deliver exactly the requested quote");
        assertEq(
            tokens0 - IERC20(token).balanceOf(TRADER), paid, "the payer's token spend and the reported input disagree"
        );
        // quote SPECIFIED tarafta -> ucret `beforeSwap`ta, ISTENEN miktar
        // uzerinden. Kullanici tam istedigini alir ve ucreti FAZLADAN girdi
        // olarak oder.
        _assertFeeIsTierZeroOn(f0, want);
        _assertRouterIsEmpty(token);
    }

    /// @dev UCRET, TAM OLARAK KADEME 0'IN 95+30 BPS'I. Kademe gecisi
    ///      testnet buyuklugunde ULASILAMAZ (FDV ~58,78 USDC, ilk esik 59.000
    ///      USDC) ve bu ACIK HUCRE olarak kaydedilir.
    function _assertFeeIsTierZeroOn(FeeSnapshot memory before, uint256 amountUnits) internal view {
        assertEq(
            escrow.owed(TREASURY) - before.protocolOwed,
            CurveMath.feeOn(amountUnits, 95) * 1e12,
            "the protocol share is not 95 bps"
        );
        assertEq(
            escrow.owed(CREATOR) - before.creatorOwed,
            CurveMath.feeOn(amountUnits, 30) * 1e12,
            "the creator share is not 30 bps"
        );
    }

    /// @notice Ucret HICBIR seklinde launch tokeninde alinmaz.
    function test_noFeeIsEverTakenInTheLaunchToken() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        vm.startPrank(TRADER);
        router.buyExactIn(token, ONE_USDC, 0, TRADER, block.timestamp);
        router.buyExactOut(token, 1e24, type(uint128).max, TRADER, block.timestamp);
        router.sellExactIn(token, 1e24, 0, TRADER, block.timestamp);
        router.sellExactOut(token, ONE_USDC, type(uint128).max, TRADER, block.timestamp);
        vm.stopPrank();

        assertEq(IERC20(token).balanceOf(address(hook)), 0, "the hook holds launch tokens");
        assertEq(IERC20(token).balanceOf(address(escrow)), 0, "the escrow holds launch tokens");
        _assertRouterIsEmpty(token);
    }

    // ---------------------------------------------------------------
    // 2. QUOTE == FIILEN ALINAN, DORT SEKILDE DE
    // ---------------------------------------------------------------

    /// @notice KULLANICIYA GOSTERILEN SAYI, KULLANICININ FIILEN ALDIGI
    ///         SAYIDIR -- ve o sayi hook'un payi DUSULDUKTEN sonrakidir.
    ///
    /// @dev NICIN AYRI BIR TEST. Havuz ucreti SIFIRDIR; ucreti hook
    ///      `beforeSwap`/`afterSwap` deltalariyla alir. AMM matematigini
    ///      disarida yeniden uygulayan bir arayuz hook'un payini GOREMEZ ve
    ///      kullaniciya sistematik olarak FAZLA sayi gosterirdi. Quoter
    ///      gercek `PoolManager.swap`i gercek hook'la calistirir, settle
    ///      etmeden ONCE revert eder ve o revert'in icinden sayiyi okur.
    ///
    /// @dev KONTROL GRUBU DA BURADA: ucretin SIFIR OLMADIGI ayrica iddia
    ///      edilir. Ucret alinmasaydi "quote == gerceklesen" esitligi de
    ///      saglanirdi ve test hicbir sey olcmezdi.
    function test_everyQuoteEqualsTheRealizedAmountNetOfTheHookFee() public {
        _quoteMatchesRealized(false);
        _quoteMatchesRealized(true);
    }

    function _quoteMatchesRealized(bool baseIsCurrency0) internal {
        (address token,) = _open(baseIsCurrency0);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        uint256 snap = vm.snapshotState();

        uint256 qBuyIn = router.quoteBuyExactIn(token, ONE_USDC);
        uint256 qBuyOut = router.quoteBuyExactOut(token, 1e24);
        uint256 qSellIn = router.quoteSellExactIn(token, 1e24);
        uint256 qSellOut = router.quoteSellExactOut(token, ONE_USDC);

        // DORT GERCEKLESEN DEGER AYNI DURUMDAN OLCULUR. Aralarinda
        // `revertToState` vardir, cunku aksi halde ikinci swap birincinin
        // kaydirdigi fiyattan kosar ve esitlikler SIRAYA bagli olurdu --
        // yani quote'un dogru oldugunu degil, yalnizca ilk quote'un dogru
        // oldugunu olcerdik. (Quote'un kendisi durumu degistirmiyor;
        // `test_quotingLeavesNoTraceOnChain` onu ayrica olcer.)
        FeeSnapshot memory f0 = _fees();

        vm.prank(TRADER);
        assertEq(router.buyExactIn(token, ONE_USDC, 0, TRADER, block.timestamp), qBuyIn, "buyExactIn");
        vm.revertToState(snap);

        vm.prank(TRADER);
        assertEq(router.buyExactOut(token, 1e24, type(uint128).max, TRADER, block.timestamp), qBuyOut, "buyExactOut");
        vm.revertToState(snap);

        vm.prank(TRADER);
        assertEq(router.sellExactIn(token, 1e24, 0, TRADER, block.timestamp), qSellIn, "sellExactIn");
        vm.revertToState(snap);

        vm.prank(TRADER);
        assertEq(
            router.sellExactOut(token, ONE_USDC, type(uint128).max, TRADER, block.timestamp), qSellOut, "sellExactOut"
        );

        // KONTROL: ucret GERCEKTEN alindi, yani esitlikler "ucret yok" ile
        // saglanmiyor.
        assertGt(_fees().protocolOwed - f0.protocolOwed, 0, "no fee was charged -- the equalities measure nothing");
    }

    /// @notice Quote yolu ZINCIRI DEGISTIRMEZ.
    /// @dev `unlock` icinde gercek bir `swap` kosar; onu geri alan sey
    ///      `QuoteResult` revert'idir. Bir mutant `revert`i `return`a
    ///      cevirirse burasi kirmizi olur -- havuzun fiyati kayar.
    function test_quotingLeavesNoTraceOnChain() public {
        (address token, PoolKey memory key) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        (uint160 priceBefore,,,) = pm.getSlot0(key.toId());
        uint256 traderBefore = _quoteUnitsOf(TRADER);
        uint256 escrowBefore = escrow.owed(TREASURY);

        router.quoteBuyExactIn(token, ONE_USDC);
        router.quoteBuyExactOut(token, 1e24);
        router.quoteSellExactIn(token, 1e24);
        router.quoteSellExactOut(token, ONE_USDC);

        (uint160 priceAfter,,,) = pm.getSlot0(key.toId());
        assertEq(priceAfter, priceBefore, "quoting moved the pool price");
        assertEq(_quoteUnitsOf(TRADER), traderBefore, "quoting moved the trader's balance");
        assertEq(escrow.owed(TREASURY), escrowBefore, "quoting produced a fee");
    }

    /// @notice Quote yolundaki bir hata SESSIZCE YUTULMAZ, AYNEN kabartilir.
    /// @dev `try/catch` yazan her quoter'in tuzagi budur: `catch`in "0 al"
    ///      diye okunmasi. Mezun olmamis bir token icin quote,
    ///      `PoolNotInitialized` ile duser -- takasin dusecegi hatanin
    ///      TA KENDISIYLE.
    function test_aQuoteForAPoolThatDoesNotExistBubblesTheRealRevert() public {
        vm.prank(CREATOR);
        (address token,) = factory.launch("NOTGRAD", "ARC", "ipfs://x");

        vm.expectRevert(bytes4(keccak256("PoolNotInitialized()")));
        router.quoteBuyExactIn(token, ONE_USDC);

        vm.expectRevert(bytes4(keccak256("PoolNotInitialized()")));
        router.buyExactIn(token, ONE_USDC, 0, TRADER, block.timestamp);
    }

    // ---------------------------------------------------------------
    // 3. SLIPPAGE -- ROUTER'DA, ARAYUZDE DEGIL
    // ---------------------------------------------------------------

    /// @dev DORT SARMALAYICININ DORDU DE OLCULUR. Koruma `_swap`in icinde
    ///      TEK BIRER KOPYADIR, ama sarmalayicilarin `exactIn` argumani
    ///      HANGI kopyanin uygulanacagini secer: `buyExactIn`e `false`
    ///      gecen bir mutant, girdisi kadar cikti bekleyen bir sinir
    ///      uygulardi. Bu dort test o secimi olcer.
    function test_slippageBoundsAreEnforcedOnAllFourEntrypoints() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        uint256 qBuyIn = router.quoteBuyExactIn(token, ONE_USDC);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcpadRouter.TooLittleReceived.selector, qBuyIn, qBuyIn + 1));
        router.buyExactIn(token, ONE_USDC, qBuyIn + 1, TRADER, block.timestamp);

        uint256 qSellIn = router.quoteSellExactIn(token, 1e24);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcpadRouter.TooLittleReceived.selector, qSellIn, qSellIn + 1));
        router.sellExactIn(token, 1e24, qSellIn + 1, TRADER, block.timestamp);

        uint256 qBuyOut = router.quoteBuyExactOut(token, 1e24);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcpadRouter.TooMuchRequested.selector, qBuyOut, qBuyOut - 1));
        router.buyExactOut(token, 1e24, qBuyOut - 1, TRADER, block.timestamp);

        uint256 qSellOut = router.quoteSellExactOut(token, ONE_USDC);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcpadRouter.TooMuchRequested.selector, qSellOut, qSellOut - 1));
        router.sellExactOut(token, ONE_USDC, qSellOut - 1, TRADER, block.timestamp);

        // KONTROL: TAM SINIRDA hepsi GECER. Onsuz yukaridaki dort revert
        // "herhangi bir sebeple" olabilirdi.
        vm.startPrank(TRADER);
        router.buyExactIn(token, ONE_USDC, qBuyIn, TRADER, block.timestamp);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------
    // 4. DEADLINE -- VE ARC'IN ESIT ZAMAN DAMGALARI
    // ---------------------------------------------------------------

    /// @notice Gecmis bir deadline dort giriste de reddedilir; ESIT bir
    ///         deadline KABUL EDILIR.
    ///
    /// @dev IKINCI YARI ARC'A OZGUDUR VE BIR MUTANTI OLDURUR. Arc'ta blok
    ///      zaman damgalari ARTMAYABILIR -- olculdu: 553 ardisik finalize
    ///      ciftin 271'i (%49,0) AYNI damgayi tasiyor, sifir geri gidis.
    ///      `>=` yazilmis bir kontrol, kullanicinin "su anki blok" diye
    ///      hesapladigi bir deadline'i o bloklarin YARISINDA reddederdi.
    function test_aPassedDeadlineIsRejectedAndAnEqualOneIsAccepted() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        uint256 past = block.timestamp - 1;
        bytes memory expected = abi.encodeWithSelector(ArcpadRouter.DeadlinePassed.selector, past, block.timestamp);

        vm.startPrank(TRADER);
        vm.expectRevert(expected);
        router.buyExactIn(token, ONE_USDC, 0, TRADER, past);
        vm.expectRevert(expected);
        router.buyExactOut(token, 1e24, type(uint128).max, TRADER, past);
        vm.expectRevert(expected);
        router.sellExactIn(token, 1e24, 0, TRADER, past);
        vm.expectRevert(expected);
        router.sellExactOut(token, ONE_USDC, type(uint128).max, TRADER, past);

        // ...VE `deadline == block.timestamp` GECER.
        router.buyExactIn(token, ONE_USDC, 0, TRADER, block.timestamp);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------
    // 5. KISMI DOLULUK
    // ---------------------------------------------------------------

    /// @notice Havuzun dolduramayacagi bir exact-input KISMEN DOLDURULMAZ,
    ///         REVERT EDER.
    ///
    /// @dev V4 fiyat sinirina carptiginda EKSIK doldurur ve BUNU SESSIZCE
    ///      YAPAR: `swapDelta`nin specified bacagi `amountSpecified`den
    ///      kucuk gelir. Router bunu tek bir esitlikle reddeder. Onsuz
    ///      `sellExactIn` "verdiginin hepsi degil, alabildigi kadari"
    ///      anlamina gelirdi ve kullanicinin geri kalan tokeni ONA GERI
    ///      VERILMEZDI -- hic harcanmamis olurdu, ama kullanici bunu
    ///      goremezdi.
    ///
    /// @dev DORT SEKILDEN HANGILERININ BU KAPIYA ULASTIGI OLCULDU VE
    ///      RAPORDA YAZILI: exact-input SATIS ulasir (ucret `afterSwap`ta,
    ///      SINIRLI ciktidan alinir); obur ucu, hook'un `take`i
    ///      `PoolManager`in bakiyesini astigi icin DAHA ONCE duser. Yani bu
    ///      test ULASILABILIR olan yolu olcer, ulasilamayanlari degil.
    function test_anOversizedExactInputRevertsInsteadOfFillingPartially() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 1e36, 0);

        vm.prank(TRADER);
        vm.expectPartialRevert(ArcpadRouter.PartialFill.selector);
        router.sellExactIn(token, 1e36, 0, TRADER, block.timestamp);

        // KONTROL: ayni giristen makul bir miktar GECER.
        vm.prank(TRADER);
        assertGt(router.sellExactIn(token, 1e24, 0, TRADER, block.timestamp), 0, "the control sell produced nothing");
    }

    /// @notice DORT SEKLIN DORDU DE, HAVUZUN DOLDURAMAYACAGI BIR ISTEKTE
    ///         REVERT EDER -- ama HEPSI `PartialFill` ILE DEGIL, VE FARK
    ///         OLCULMUSTUR.
    ///
    /// @dev BU TEST BIR IDDIAYI DARALTIR. "Kismi doluluk `PartialFill` ile
    ///      reddedilir" cumlesi DORT SEKIL ICIN DE dogru okunurdu; olcum
    ///      soyle: yalnizca exact-input SATIS o kapiya ULASIR. Obur ucunde
    ///      hook'un ucreti `PoolManager`in bakiyesinden `take` edilir ve
    ///      asiri buyuk bir istekte o `take` ONCE duser -- yani revert eder,
    ///      ama BASKA bir katmandan. Router'in KULLANICIYA verdigi garanti
    ///      ("kismi doluluk YOKTUR") iki durumda da saglanir; degisen sey
    ///      HANGI katmanin reddettigidir, ve bunu yazmak ile varsaymak farkli
    ///      seylerdir.
    function test_everyOversizedRequestRevertsAndOnlyOneOfThemReachesPartialFill() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 1e36, 1e15 * ONE_USDC);

        uint256 huge = uint256(uint128(type(int128).max));

        vm.startPrank(TRADER);
        (bool a,) =
            address(router).call(abi.encodeCall(ArcpadRouter.buyExactIn, (token, huge, 0, TRADER, block.timestamp)));
        (bool b,) = address(router)
            .call(abi.encodeCall(ArcpadRouter.buyExactOut, (token, 1e30, type(uint256).max, TRADER, block.timestamp)));
        (bool c, bytes memory cErr) =
            address(router).call(abi.encodeCall(ArcpadRouter.sellExactIn, (token, 1e36, 0, TRADER, block.timestamp)));
        (bool d,) = address(router)
            .call(abi.encodeCall(ArcpadRouter.sellExactOut, (token, huge, type(uint256).max, TRADER, block.timestamp)));
        vm.stopPrank();

        assertFalse(a, "an oversized exact-input buy filled");
        assertFalse(b, "an oversized exact-output buy filled");
        assertFalse(c, "an oversized exact-input sell filled");
        assertFalse(d, "an oversized exact-output sell filled");
        assertEq(
            bytes4(cErr),
            ArcpadRouter.PartialFill.selector,
            "the one shape that reaches the router's own gate no longer does"
        );
    }

    // ---------------------------------------------------------------
    // 6. UCRETIN CIKTIYI ASTIGI TOZ TAKAS
    // ---------------------------------------------------------------

    /// @notice Hook'un ucreti TAVANA yuvarlandigi icin, cok kucuk bir
    ///         satista ucret brut ciktiyi ASABILIR. Router boyle bir takasi
    ///         YURUTMEZ.
    ///
    /// @dev BU BIR HOOK OZELLIGIDIR, BIR ROUTER KUSURU DEGIL, VE BURADA
    ///      OLCULMESININ SEBEBI SUDUR: ucret `feeOn(x,95) + feeOn(x,30)`
    ///      ile PARCALARDAN toplanir ve iki tavan yuvarlamasi 1 birimlik bir
    ///      brut cikti icin 2 birim ucret uretir. Router settle etseydi
    ///      kullanici HER IKI bacaktan da oderdi: tokenini verir, ustune
    ///      quote borclanirdi. `LegSignsUnexpected` tam olarak orada duser.
    ///      Bandin VAR OLDUGU aranarak bulunur; bulunamazsa test DUSER --
    ///      ulasilabilirlik iddia edilir, varsayilmaz.
    function test_aDustSellWhoseFeeExceedsItsOutputIsRefused() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 1e21, 0);

        // BANT KENDI KENDINI KALIBRE EDER, ELLE YAZILMIS BIR BUYUKLUK
        // KULLANMAZ. Ilk yazim `1e12`den basliyordu ve BOSTU: mezuniyet
        // fiyatinda bir quote BIRIMI ~1,7e19 token wei eder (D/R6 =
        // 206_886_011_183_597_390_493_942_218 / 12_161_433), yani 1e12-1e15
        // araligindaki her satis SIFIR uretiyordu ve test "bant yok" diye
        // dusuyordu. Olcek buradan TURETILIR.
        uint256 probe = 1e21;
        uint256 weiPerUnit = probe / router.quoteSellExactIn(token, probe);
        assertGt(weiPerUnit, 0, "the calibration probe produced no output");

        uint256 found;
        for (uint256 t = weiPerUnit; t < 2 * weiPerUnit; t += weiPerUnit / 8) {
            (bool ok, bytes memory err) =
                address(router).call(abi.encodeCall(ArcpadRouter.quoteSellExactIn, (token, t)));
            if (!ok && err.length >= 4 && bytes4(err) == ArcpadRouter.LegSignsUnexpected.selector) {
                found = t;
                break;
            }
        }
        assertGt(found, 0, "no dust size reached the fee-exceeds-output band -- the claim is unproven");

        vm.prank(TRADER);
        vm.expectPartialRevert(ArcpadRouter.LegSignsUnexpected.selector);
        router.sellExactIn(token, found, 0, TRADER, block.timestamp);
    }

    // ---------------------------------------------------------------
    // 7. ROUTER'IN YAPAMADIKLARI
    // ---------------------------------------------------------------

    /// @notice `unlockCallback` yalnizca `PoolManager`i dinler.
    function test_unlockCallbackRejectsEveryCallerButThePoolManager() public {
        vm.prank(ATTACKER);
        vm.expectRevert(ArcpadRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }

    /// @notice BIR SALDIRGANIN `unlock`U ROUTER'IN CALLBACK'INI HIC
    ///         CALISTIRMAZ -- VE BU OLCULUR, IDDIA EDILMEZ.
    ///
    /// @dev Katman (1) `msg.sender` kontroludur ve yukarida olculdu.
    ///      KATMAN (2) YAPISALDIR: `PoolManager.unlock` geri cagriyi
    ///      `IUnlockCallback(msg.sender)`e yapar. Saldirgan, `payer`i kurban
    ///      olarak kodlanmis bir `Call` gecirse bile, calisan callback KENDI
    ///      kontratininkidir. Bu test o cagriyi saldirganin kontratinda
    ///      SAYAR, ve kurbanin -- router'a SINIRSIZ onay vermis olmasina
    ///      ragmen -- hicbir sey kaybetmedigini iddia eder.
    function test_anAttackersUnlockRunsHisOwnCallbackNotTheRouters() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);
        assertEq(
            IERC20(GraduationMath.QUOTE).allowance(TRADER, address(router)),
            type(uint256).max,
            "the victim did not actually approve the router"
        );

        uint256 victimQuote = _quoteUnitsOf(TRADER);
        uint256 victimTokens = IERC20(token).balanceOf(TRADER);

        ForgedUnlocker forged = new ForgedUnlocker(pm);
        (PoolKey memory key,) = GraduationMath.poolKey(token, IHooks(address(hook)));
        bytes memory forgedData = abi.encode(
            ArcpadRouter.Call({
                payer: TRADER,
                recipient: ATTACKER,
                key: key,
                zeroForOne: true,
                amountSpecified: -int256(ONE_USDC),
                quoting: false
            })
        );

        vm.prank(ATTACKER);
        forged.go(forgedData);

        assertEq(forged.ownCallbackRuns(), 1, "the attacker's own callback did not run -- the test measures nothing");
        assertEq(keccak256(forged.sawData()), keccak256(forgedData), "the manager did not forward the forged data");
        assertEq(_quoteUnitsOf(TRADER), victimQuote, "the victim lost quote");
        assertEq(IERC20(token).balanceOf(TRADER), victimTokens, "the victim lost tokens");
        assertEq(IERC20(token).balanceOf(ATTACKER), 0, "the attacker received tokens");
    }

    /// @notice ROUTER YALNIZCA `msg.sender`DAN ODEME ALIR.
    /// @dev Kurban router'a SINIRSIZ onay vermistir ve iki bacakta da
    ///      fonludur. Saldirgan dort girisin dordunu de dener; hicbirinde
    ///      kurbanin bakiyesi kimildamaz ve saldirgan KENDI fonsuzlugundan
    ///      duser.
    function test_theRouterCanOnlyEverBePaidByMsgSender() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        uint256 victimQuote = _quoteUnitsOf(TRADER);
        uint256 victimTokens = IERC20(token).balanceOf(TRADER);

        vm.startPrank(ATTACKER);
        IERC20(GraduationMath.QUOTE).approve(address(router), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);

        (bool a,) = address(router)
            .call(abi.encodeCall(ArcpadRouter.buyExactIn, (token, ONE_USDC, 0, ATTACKER, block.timestamp)));
        (bool b,) = address(router)
            .call(abi.encodeCall(ArcpadRouter.buyExactOut, (token, 1e24, type(uint128).max, ATTACKER, block.timestamp)));
        (bool c,) =
            address(router).call(abi.encodeCall(ArcpadRouter.sellExactIn, (token, 1e24, 0, ATTACKER, block.timestamp)));
        (bool d,) = address(router)
            .call(
                abi.encodeCall(
                    ArcpadRouter.sellExactOut, (token, ONE_USDC, type(uint128).max, ATTACKER, block.timestamp)
                )
            );
        vm.stopPrank();

        assertFalse(a, "a funded-victim buy succeeded for an unfunded attacker");
        assertFalse(b, "a funded-victim buy succeeded for an unfunded attacker");
        assertFalse(c, "a funded-victim sell succeeded for an unfunded attacker");
        assertFalse(d, "a funded-victim sell succeeded for an unfunded attacker");
        assertEq(_quoteUnitsOf(TRADER), victimQuote, "the victim's quote moved");
        assertEq(IERC20(token).balanceOf(TRADER), victimTokens, "the victim's tokens moved");
    }

    /// @notice Router arcpad'e AIT OLMAYAN bir token'a HIC CAGRI YAPMAZ.
    ///
    /// @dev ANAHTAR KULLANICIDAN ALINMAZ, `hook` `immutable`INDEN
    ///      TURETILIR; o anahtardaki bir havuzu ancak `ArcpadHook`un
    ///      `beforeInitialize` kapisindan gecen biri acabilir. Dolayisiyla
    ///      dusman bir ERC-20 havuza HIC giremez ve router ona TEK BIR CAGRI
    ///      bile yapmaz -- `swap` `PoolNotInitialized` ile, TOKEN'A
    ///      DOKUNULMADAN duser. Sayac o iddiayi olcer.
    function test_aHostileTokenIsNeverEvenCalled() public {
        HostileToken hostile = new HostileToken();

        vm.prank(TRADER);
        vm.expectRevert(bytes4(keccak256("PoolNotInitialized()")));
        router.buyExactIn(address(hostile), ONE_USDC, 0, TRADER, block.timestamp);
        assertEq(hostile.calls(), 0, "the router called a token that is not in any arcpad pool");

        // ...ve kutuphanenin kendi iki kapisi da yerinde.
        vm.expectRevert(GraduationMath.ZeroBase.selector);
        router.buyExactIn(address(0), ONE_USDC, 0, TRADER, block.timestamp);
        vm.expectRevert(GraduationMath.BaseIsQuote.selector);
        router.buyExactIn(GraduationMath.QUOTE, ONE_USDC, 0, TRADER, block.timestamp);
    }

    /// @notice Router'in KODUNDA likidite, bagis ve ERC-6909 selector'leri
    ///         YOKTUR -- ve `swap` VARDIR.
    ///
    /// @dev YOKLUK TEST EDILEMEZ, YUZEY TEST EDILIR -- `ArcpadLocker`in
    ///      "pozisyonu yakmak, cikaran kodu HIC YAZMAMAKTIR" gerekcesiyle
    ///      ayni. Router bir `unlock` callback'i TUTAR, yani `PoolManager`in
    ///      kilit ici yuzeyinin TAMAMI ona aciktir; bu satirlar o yuzeyin
    ///      hangi parcasinin FIILEN derlendigini olcer.
    ///
    /// @dev KONTROL ZORUNLUDUR: `swap`in VAR oldugu ayrica iddia edilir.
    ///      Onsuz bozuk bir arama fonksiyonu her seyi "yok" diye raporlar ve
    ///      test bos gecerdi.
    function test_theRouterBytecodeCarriesNoLiquidityDonateOrClaimSelectors() public view {
        bytes memory code = address(router).code;
        assertGt(code.length, 0, "the router has no code");

        assertTrue(_contains(code, IPoolManager.swap.selector), "control: the router does not even call swap");
        assertTrue(_contains(code, IPoolManager.sync.selector), "control: the router does not call sync");
        assertTrue(_contains(code, IPoolManager.take.selector), "control: the router does not call take");

        assertFalse(_contains(code, IPoolManager.modifyLiquidity.selector), "the router can call modifyLiquidity");
        assertFalse(_contains(code, IPoolManager.donate.selector), "the router can call donate");
        assertFalse(_contains(code, IPoolManager.initialize.selector), "the router can call initialize");
        assertFalse(_contains(code, IPoolManager.mint.selector), "the router can mint ERC-6909 claims");
        assertFalse(_contains(code, IPoolManager.burn.selector), "the router can burn ERC-6909 claims");
        assertFalse(_contains(code, IPoolManager.clear.selector), "the router can clear a delta");
        assertFalse(_contains(code, IPoolManager.settleFor.selector), "the router can settle for a third party");
        assertFalse(_contains(code, IPoolManager.updateDynamicLPFee.selector), "the router can change the pool fee");
    }

    /// @notice 10^12 DONUSUMU ROUTER'DA YOKTUR -- VE HOOK'TA VARDIR.
    ///
    /// @dev IKI YARI DA GEREKLI. Ilk yari tek basina, arama fonksiyonu bozuk
    ///      olsa bile gecerdi; ikinci yari `QUOTE_SCALE`in bytecode'da NASIL
    ///      gorundugunu (PUSH5 `e8d4a51000`) o kutuphaneyi FIILEN kullanan
    ///      bir kontratta kanitlar. Router quote bacaginda yalnizca 6-decimal
    ///      ERC-20 birimleriyle calisir; bir donusum orada olsaydi fiyati
    ///      10^6 kat kaydirirdi ve HICBIR revert uretmezdi.
    function test_theRouterCarriesNoQuoteScaleConversionAndTheHookDoes() public view {
        bytes memory scale = hex"e8d4a51000"; // 1e12
        assertTrue(_containsBytes(address(hook).code, scale), "control: the hook does not carry 1e12 either");
        assertFalse(_containsBytes(address(router).code, scale), "the router carries the 1e12 conversion");
    }

    /// @notice Router `payable` DEGILDIR ve `receive()`i YOKTUR.
    function test_theRouterRefusesNativeValue() public {
        (address token,) = _open(false);
        vm.deal(ATTACKER, 10e18);

        vm.startPrank(ATTACKER);
        (bool bare,) = address(router).call{value: 1}("");
        (bool withCalldata,) = address(router).call{value: 1}(
            abi.encodeCall(ArcpadRouter.buyExactIn, (token, ONE_USDC, 0, ATTACKER, block.timestamp))
        );
        vm.stopPrank();

        assertFalse(bare, "the router accepted a bare native transfer");
        assertFalse(withCalldata, "a non-payable entrypoint accepted value");
    }

    /// @notice ROUTER'A YAPILAN BIR BAGIS HICBIR SEYI DEGISTIRMEZ.
    ///
    /// @dev ARC'A OZGU VE ONEMLI: `0x3600...` uzerinden yapilan bir ERC-20
    ///      transferi alicinin NATIVE bakiyesini kredilendirir ve `receive()`i
    ///      CALISTIRMAZ (canli olcum, blok 54019678). Yani "payable degil"
    ///      demek "bakiye tutamaz" demek DEGILDIR. Tasiyici ozellik sudur:
    ///      router kendi bakiyesini HIC OKUMAZ, dolayisiyla bagis ETKISIZDIR.
    ///      Iki kosu ayni anlik goruntuden baslar ve sonuclari BIREBIR ayni
    ///      olmalidir.
    function test_aDonationToTheRouterChangesNothingAndStaysStuck() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        uint256 snap = vm.snapshotState();

        vm.prank(TRADER);
        uint256 clean = router.buyExactIn(token, ONE_USDC, 0, TRADER, block.timestamp);

        vm.revertToState(snap);

        // BAGIS: hem 6-decimal quote hem launch tokeni.
        vm.deal(address(router), 7e18);
        deal(token, address(router), 1_000e18, true);
        assertGt(IERC20(GraduationMath.QUOTE).balanceOf(address(router)), 0, "the donation did not land");

        vm.prank(TRADER);
        uint256 donated = router.buyExactIn(token, ONE_USDC, 0, TRADER, block.timestamp);

        assertEq(donated, clean, "a donation changed the router's arithmetic");
        assertEq(address(router).balance, 7e18, "the donated quote moved");
        assertEq(IERC20(token).balanceOf(address(router)), 1_000e18, "the donated tokens moved");
    }

    // ---------------------------------------------------------------
    // 8. MIKTAR SINIRLARI VE ALICI
    // ---------------------------------------------------------------

    /// @dev UST SINIR SESSIZ BIR ISARET DEGISIMINI ONLER: `int256(amount)`
    ///      `2^255`in ustunde negatife sarar ve exact-INPUT bir istek
    ///      sessizce exact-OUTPUT olurdu.
    function test_zeroAndOversizedAmountsAreRejected() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        uint256 tooBig = uint256(uint128(type(int128).max)) + 1;

        vm.startPrank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcpadRouter.AmountOutOfRange.selector, uint256(0)));
        router.buyExactIn(token, 0, 0, TRADER, block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(ArcpadRouter.AmountOutOfRange.selector, tooBig));
        router.buyExactIn(token, tooBig, 0, TRADER, block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(ArcpadRouter.AmountOutOfRange.selector, tooBig));
        router.sellExactOut(token, tooBig, type(uint256).max, TRADER, block.timestamp);
        vm.stopPrank();
    }

    function test_theZeroRecipientIsRejected() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 5e26, 100 * ONE_USDC);

        vm.prank(TRADER);
        vm.expectRevert(ArcpadRouter.ZeroRecipient.selector);
        router.buyExactIn(token, ONE_USDC, 0, address(0), block.timestamp);
    }

    /// @notice `RouterSwap` yayilir ve alanlari gerceklesen miktarlardir.
    /// @dev NICIN GEREKLI: `PoolManager.Swap`in `sender`i ROUTER'dir, yani
    ///      havuz seviyesinde KULLANICI KIMLIGI KAYBOLUR. Indexer'in tek
    ///      kaynagi bu olay.
    function test_theRouterEmitsItsOwnSwapEventWithTheRealTrader() public {
        (address token,) = _open(false);
        _fund(TRADER, token, 0, 100 * ONE_USDC);

        uint256 expectedOut = router.quoteBuyExactIn(token, ONE_USDC);

        vm.expectEmit(true, true, true, true, address(router));
        emit ArcpadRouter.RouterSwap(token, TRADER, THIRD_PARTY, true, ONE_USDC, expectedOut);
        vm.prank(TRADER);
        router.buyExactIn(token, ONE_USDC, 0, THIRD_PARTY, block.timestamp);
    }

    // ---------------------------------------------------------------
    // 9. DEPLOY -- ADRES VE BYTECODE ANKRAJLARI
    // ---------------------------------------------------------------

    /// @notice BU PAKETIN SINADIGI BYTECODE, DEPLOY'UN YAYINLAYACAGI
    ///         BYTECODE'DUR.
    ///
    /// @dev AYRISMA TEORIK DEGILDIR: `out/` altinda `ArcpadRouter`in IKI
    ///      artifact'i olusur (`ArcpadRouter.json` 800 ve
    ///      `ArcpadRouter.v4core.json` 44444444) cunku `PoolManager`a ULASAN
    ///      her birim kisitla birlikte derlenir. `RouterDeployLib`
    ///      `PoolDeployLib`i, o da `PoolManager`i import eder; bu test
    ///      dosyasi da `PoolManager`i ismiyle import eder. Yani iki taraf da
    ///      44444444'tur -- ve bu satir onlarin AYRISMADIGINI iddia eder.
    function test_theTestedRouterBytecodeIsTheOneTheDeployWouldShip() public pure {
        assertEq(
            keccak256(type(ArcpadRouter).creationCode),
            RouterDeployLib.ARC_ROUTER_CREATION_CODE_HASH,
            "this unit's ArcpadRouter creation code is not the pinned one"
        );
        assertEq(
            RouterDeployLib.routerCreationCodeHash(),
            RouterDeployLib.ARC_ROUTER_CREATION_CODE_HASH,
            "RouterDeployLib's own view of the creation code diverged"
        );
    }

    /// @notice Tuz TURETILIR, SECILMEZ; ve adres TURETMEDEN gelir.
    function test_theRouterSaltAndInitcodeReproduceThePlannedAddress() public pure {
        RouterPlan memory p = RouterDeployLib.build(
            PoolDeployLib.ARC_TESTNET_CHAIN_ID, PoolDeployLib.ARC_POOL_MANAGER, PoolDeployLib.ARC_HOOK
        );

        assertEq(p.salt, keccak256("arcpad.ArcpadRouter.v1"), "the salt is not the derived one");
        assertEq(p.router, DeployLib.predict(p.salt, p.initcode), "the plan's address is not the CREATE2 derivation");

        // KONTROL: turetme GERCEKTEN initcode'a duyarli.
        assertTrue(
            DeployLib.predict(p.salt, abi.encodePacked(p.initcode, bytes1(0x00))) != p.router,
            "the derivation is insensitive to the initcode -- the assertion above is a coincidence"
        );
        // ...ve ARGUMANLARA da duyarli.
        RouterPlan memory other =
            RouterDeployLib.build(PoolDeployLib.ARC_TESTNET_CHAIN_ID, PoolDeployLib.ARC_POOL_MANAGER, address(0xBEEF));
        assertTrue(other.router != p.router, "the derivation ignores the hook argument");
    }

    /// @notice `assertDeployable` Arc'ta PINLENMIS `PoolManager` ve hook'tan
    ///         baskasini kabul etmez, ve ikisinin de ZINCIRDE olmasini ister.
    function test_theRouterPlanRefusesTheWrongWiring() public {
        vm.etch(DeployLib.CREATE2_FACTORY, _create2DeployerRuntime());

        uint256 chainId = PoolDeployLib.ARC_TESTNET_CHAIN_ID;
        RouterPlan memory p = RouterDeployLib.build(chainId, PoolDeployLib.ARC_POOL_MANAGER, PoolDeployLib.ARC_HOOK);

        // (a) Kod yok -> KIRMIZI.
        vm.expectRevert(
            abi.encodeWithSelector(RouterDeployLib.PoolManagerHasNoCode.selector, PoolDeployLib.ARC_POOL_MANAGER)
        );
        this.callAssertDeployable(p);

        vm.etch(PoolDeployLib.ARC_POOL_MANAGER, hex"6001600155");
        vm.expectRevert(abi.encodeWithSelector(RouterDeployLib.HookHasNoCode.selector, PoolDeployLib.ARC_HOOK));
        this.callAssertDeployable(p);

        vm.etch(PoolDeployLib.ARC_HOOK, hex"6001600155");
        // (b) Dogru kablolamada GECER -- KONTROL GRUBU.
        this.callAssertDeployable(p);

        // (c) Yanlis hook -> KIRMIZI.
        RouterPlan memory wrong = RouterDeployLib.build(chainId, PoolDeployLib.ARC_POOL_MANAGER, address(0xBEEF));
        vm.etch(address(0xBEEF), hex"6001600155");
        vm.expectRevert(
            abi.encodeWithSelector(
                RouterDeployLib.HookIsNotTheDeployedOne.selector, PoolDeployLib.ARC_HOOK, address(0xBEEF)
            )
        );
        this.callAssertDeployable(wrong);

        // (d) Zaten deploy edilmis -> KIRMIZI.
        vm.etch(p.router, hex"6001600155");
        vm.expectRevert(abi.encodeWithSelector(RouterDeployLib.RouterAlreadyDeployed.selector, p.router));
        this.callAssertDeployable(p);
    }

    function callAssertDeployable(RouterPlan memory p) external view {
        RouterDeployLib.assertDeployable(p);
    }

    /// @dev Olculen 69 baytlik kanonik deterministik deployer runtime'i --
    ///      `DeployPool.t.sol`daki literalin aynisi.
    function _create2DeployerRuntime() internal pure returns (bytes memory) {
        return hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0"
            hex"3601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    }

    // ---------------------------------------------------------------
    // Arama yardimcilari
    // ---------------------------------------------------------------

    function _contains(bytes memory haystack, bytes4 needle) internal pure returns (bool) {
        return _containsBytes(haystack, abi.encodePacked(needle));
    }

    function _containsBytes(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || haystack.length < needle.length) return false;
        for (uint256 i = 0; i + needle.length <= haystack.length; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}
