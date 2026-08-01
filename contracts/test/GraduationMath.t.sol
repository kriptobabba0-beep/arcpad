// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {GraduationMath} from "../src/libraries/GraduationMath.sol";

/// @title GraduationMathTest
/// @notice BEKLENEN DEGERLER ELLE TURETILMISTIR ve kutuphaneyi cagirarak
///         URETILMEMISTIR. `FullMath`/`Math.sqrt` ile beklenen degeri
///         hesaplayan bir test kutuphaneyi KENDISIYLE karsilastirir -- bu
///         projenin defalarca yakaladigi totoloji sinifinin ta kendisi.
///         Asagidaki literaller bagimsiz bir tamsayi hesaplayicisiyla
///         (Python, `isqrt`/`//`) uretildi ve turetmeleri her testin
///         yorumunda yazili.
///
/// @dev `TickMath`, `LPFeeLibrary` ve `Pool` KUTUPHANEMIZ DEGILDIR -- onlar
///      vendor'lanmis Uniswap kodudur. Sabitlerimizi onlara karsi dogrulamak
///      totoloji DEGIL, tam tersine sabitin dogrulugunun TEK kanitidir.
contract GraduationMathTest is Test {
    /// Hook adresi ENJEKTE EDILIR. `poolKey` onu dogrulamaz ve
    /// dogrulamamalidir; bu testler icin herhangi bir adres yeterlidir.
    address internal constant HOOK = 0x00000000000000000000000000000000000000a8;

    /// D = S*(T-S)/T, uretim ve testnet profillerinde AYNIDIR (ikisi de
    /// T = 1_073_000_000e18, S = 793_100_000e18 tasir; yalnizca V ayrisir).
    ///   D = 793_100_000e18 * 279_900_000e18 / 1_073_000_000e18
    uint256 internal constant D = 206_886_011_183_597_390_493_942_218;

    /// Vt_final = T - S. Iki profilde de ayni.
    uint256 internal constant BASE_FINAL = 279_900_000_000_000_000_000_000_000;

    // ---------------------------------------------------------------
    // Sabitlerin kendisi
    // ---------------------------------------------------------------

    /// SQRT_LOWER/SQRT_UPPER SABIT YAZILIR (sabit gaz), ama SABITIN DOGRU
    /// OLDUGU burada KANITLANIR. Sabiti elle degistiren bir mutasyon bu testte
    /// olur; TickMath'i cagirmadan yazilmis bir sabit, cagirmayan bir testle
    /// birlikte hicbir sey ifade etmezdi.
    ///
    /// SINIRLAR `TICK_SPACING`IN KENDISINDEN TURETILIR, sabit `60`dan DEGIL.
    /// BU FARK OLCULEREK BULUNDU: ilk hal `minUsableTick(60)` yaziyordu ve
    /// `TICK_SPACING`i `1` yapan mutant HAYATTA KALDI -- cunku o haliyle
    /// HICBIR iddia `TICK_SPACING`e dokunmuyordu. Uc sabit ancak BIRLIKTE
    /// pinlenirse tutarli bir uclu olur; ayri ayri dogru olmalari yetmez.
    function test_fullRangeSqrtConstantsMatchTickMath() public pure {
        assertEq(GraduationMath.TICK_SPACING, 60);
        assertEq(GraduationMath.TICK_LOWER, TickMath.minUsableTick(GraduationMath.TICK_SPACING));
        assertEq(GraduationMath.TICK_UPPER, TickMath.maxUsableTick(GraduationMath.TICK_SPACING));
        assertEq(GraduationMath.TICK_LOWER, -887220);
        assertEq(GraduationMath.TICK_UPPER, 887220);
        assertEq(GraduationMath.SQRT_LOWER, TickMath.getSqrtPriceAtTick(-887220));
        assertEq(GraduationMath.SQRT_UPPER, TickMath.getSqrtPriceAtTick(887220));
        assertEq(GraduationMath.SQRT_LOWER, 4306310044);
        assertEq(GraduationMath.SQRT_UPPER, 1457652066949847389969617340386294118487833376468);
    }

    /// tickSpacing = 60 secimini tasiyan gerekce: sinirlar V4'un dogruladigi
    /// araligin KESINLIKLE icinde kalir. tickSpacing = 1 ile ust sinir TAM
    /// OLARAK MAX_SQRT_PRICE olurdu -- `getTickAtSqrtPrice`in KENDISININ
    /// reddettigi deger.
    function test_tickSpacingKeepsBothBoundsStrictlyInsideV4sValidatedRange() public pure {
        assertGt(GraduationMath.SQRT_LOWER, TickMath.MIN_SQRT_PRICE);
        assertLt(GraduationMath.SQRT_UPPER, TickMath.MAX_SQRT_PRICE);
        // ve tickSpacing = 1'in NEDEN secilmedigi:
        assertEq(TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(1)), TickMath.MAX_SQRT_PRICE);
    }

    /// V4 LP ucreti SIFIR ve dinamik bayrak DEGIL -- yani hic kimse, HOOK
    /// DAHIL, havuz ucretini degistiremez.
    function test_poolFeeIsZeroAndNotTheDynamicSentinel() public pure {
        assertEq(GraduationMath.POOL_FEE, 0);
        assertFalse(LPFeeLibrary.isDynamicFee(GraduationMath.POOL_FEE));
        assertEq(LPFeeLibrary.DYNAMIC_FEE_FLAG, 0x800000);
    }

    // ---------------------------------------------------------------
    // SIRALAMA
    // ---------------------------------------------------------------

    /// USDC 0x36...'da oturur. Token adresi 160-bit uzayda tekduzedir
    /// (factory'nin salt'i TURETILMIS, madenle bulunmamis), dolayisiyla
    /// 0x36/0x100 = %21,09375 USDC'nin ALTINA duser. "Token her zaman
    /// currency1'dir" diye yazilmis bir kod, launch'larin BESTE BIRINDE
    /// CurrenciesOutOfOrderOrEqual ile revert eder.
    function test_aTokenBelowUsdcBecomesCurrency0() public pure {
        (PoolKey memory key, bool baseIsCurrency0) =
            GraduationMath.poolKey(address(0x0000000000000000000000000000000000001234), IHooks(HOOK));
        assertTrue(baseIsCurrency0);
        assertEq(Currency.unwrap(key.currency0), address(0x1234));
        assertEq(Currency.unwrap(key.currency1), GraduationMath.QUOTE);
    }

    function test_aTokenAboveUsdcBecomesCurrency1() public pure {
        (PoolKey memory key, bool baseIsCurrency0) =
            GraduationMath.poolKey(address(0xfF00000000000000000000000000000000000000), IHooks(HOOK));
        assertFalse(baseIsCurrency0);
        assertEq(Currency.unwrap(key.currency0), GraduationMath.QUOTE);
        assertEq(Currency.unwrap(key.currency1), address(0xfF00000000000000000000000000000000000000));
    }

    /// currency0 < currency1 HER ZAMAN, ve esitlik ASLA. PoolManager `>=` ile
    /// reddeder, yani esitlik de reddedilir.
    function testFuzz_currenciesAreAlwaysStrictlyOrdered(address base) public pure {
        vm.assume(base != address(0) && base != GraduationMath.QUOTE);
        (PoolKey memory key,) = GraduationMath.poolKey(base, IHooks(HOOK));
        assertLt(uint256(uint160(Currency.unwrap(key.currency0))), uint256(uint160(Currency.unwrap(key.currency1))));
    }

    /// Havuz anahtari hook'u OLDUGU GIBI tasir. Hook adresi ENJEKTE EDILEN bir
    /// parametredir, sabit DEGIL -- ayni bytecode Uniswap'in kanonik mainnet
    /// deployment'ina karsi da kosabilsin diye.
    function testFuzz_theHookIsCarriedThroughUntouched(address hook) public pure {
        (PoolKey memory key,) = GraduationMath.poolKey(address(0x1234), IHooks(hook));
        assertEq(address(key.hooks), hook);
        assertEq(key.fee, GraduationMath.POOL_FEE);
        assertEq(key.tickSpacing, GraduationMath.TICK_SPACING);
    }

    /// address(0) ANAHTARA ASLA GIRMEZ. PoolManager bunu reddetmez:
    /// {address(0), 0x3600...} `currency0 < currency1`i GECER ve sessizce
    /// USDC'nin KENDISINE karsi bir havuz olur. Reddetmek arcpad'in isi.
    /// forge-config: default.allow_internal_expect_revert = true
    function test_zeroBaseIsRejected() public {
        vm.expectRevert(GraduationMath.ZeroBase.selector);
        GraduationMath.poolKey(address(0), IHooks(HOOK));
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_usdcAsBaseIsRejected() public {
        vm.expectRevert(GraduationMath.BaseIsQuote.selector);
        GraduationMath.poolKey(GraduationMath.QUOTE, IHooks(HOOK));
    }

    /// KANIT, kontrol degil: base sifir olmadigi ve QUOTE'a esit olmadigi
    /// surece iki bacaktan hangisi currency0 olursa olsun sifir OLAMAZ, cunku
    /// QUOTE sifir olmayan bir sabittir. Fuzz bunu tum uzayda tarar.
    function testFuzz_neitherCurrencyIsEverTheZeroAddress(address base) public pure {
        vm.assume(base != address(0) && base != GraduationMath.QUOTE);
        (PoolKey memory key,) = GraduationMath.poolKey(base, IHooks(HOOK));
        assertTrue(Currency.unwrap(key.currency0) != address(0));
        assertTrue(Currency.unwrap(key.currency1) != address(0));
    }

    // ---------------------------------------------------------------
    // 10^12 SINIRI, IKI UCTAN
    // ---------------------------------------------------------------

    /// MIKTAR ucu. Taban yuvarlar; kalan wei locker'da KALICI kalir.
    /// uretim : 12_161_433_369_060_378_706_681 / 1e12 = 12_161_433_369
    ///          kalan 60_378_706_681 wei
    /// testnet:     12_161_433_369_060_378_707 / 1e12 =     12_161_433
    ///          kalan 369_060_378_707 wei
    function test_quoteUnitsTruncatesAndTheResidueIsExact() public pure {
        assertEq(GraduationMath.quoteUnits(12_161_433_369_060_378_706_681), 12_161_433_369);
        assertEq(uint256(12_161_433_369_060_378_706_681 - 12_161_433_369 * 1e12), uint256(60_378_706_681));
        assertEq(GraduationMath.quoteUnits(12_161_433_369_060_378_707), 12_161_433);
        assertEq(uint256(12_161_433_369_060_378_707 - 12_161_433 * 1e12), uint256(369_060_378_707));
    }

    /// 1 ERC-20 biriminin ALTINDAKI her sey sifira duser. Arc'in kendi
    /// dokumani: "balanceOf'un 0 olmasi native bakiyenin 0 oldugunu ima ETMEZ."
    function test_quoteUnitsIsZeroBelowOneUnit() public pure {
        assertEq(GraduationMath.quoteUnits(999_999_999_999), 0);
        assertEq(GraduationMath.quoteUnits(1e12), 1);
    }

    /// `quoteWei` `quoteUnits`in TERSIDIR ve yon KARISTIRILAMAZ: birim ->
    /// wei YUKARI olceklendirmedir. `quoteUnits`i `quoteWei`ye ceviren bir
    /// mutasyon burada olur.
    function test_quoteWeiIsTheInverseDirection() public pure {
        assertEq(GraduationMath.quoteWei(1), 1e12);
        assertEq(GraduationMath.quoteWei(12_161_433_369), 12_161_433_369_000_000_000_000);
        assertEq(GraduationMath.quoteWei(0), 0);
    }

    /// TUR GIDIS-DONUS: wei -> birim -> wei, tam olarak ARTIGI kaybeder ve
    /// baska hicbir sey kaybetmez.
    function testFuzz_quoteWeiRecoversEverythingExceptTheResidue(uint256 weiAmount) public pure {
        weiAmount = bound(weiAmount, 0, type(uint128).max);
        uint256 units = GraduationMath.quoteUnits(weiAmount);
        assertEq(GraduationMath.quoteWei(units), weiAmount - (weiAmount % 1e12));
    }

    /// FIYAT ucu. Donusumu unutmak fiyati 10^6 katiyla kaydirir; sabitlenmis
    /// literal bunu yakalar. Turetme:
    ///   oran(X192) = floor(Vq_final * 2^192 / (Vt_final * 1e12))
    ///   sqrtPriceX96 = floor(sqrt(oran))
    function test_sqrtPriceProductionTokenIsCurrency0() public pure {
        assertEq(GraduationMath.sqrtPriceX96(16_453_433_369_060_378_706_681, BASE_FINAL, true), 607444218490929862364);
    }

    function test_sqrtPriceProductionUsdcIsCurrency0() public pure {
        assertEq(
            GraduationMath.sqrtPriceX96(16_453_433_369_060_378_706_681, BASE_FINAL, false),
            10333626601930376557517671504208461029
        );
    }

    function test_sqrtPriceTestnetTokenIsCurrency0() public pure {
        assertEq(GraduationMath.sqrtPriceX96(16_453_433_369_060_378_707, BASE_FINAL, true), 19209072819323074681);
    }

    function test_sqrtPriceTestnetUsdcIsCurrency0() public pure {
        assertEq(
            GraduationMath.sqrtPriceX96(16_453_433_369_060_378_707, BASE_FINAL, false),
            326777965518061118072680912817470217035
        );
    }

    /// Dort literalin tick'i de tam aralikta VE tam aralikin ICINDE.
    /// Tick'ler `getTickAtSqrtPrice`in tanimidir: en buyuk t oyle ki
    /// getSqrtPriceAtTick(t) <= sqrtPriceX96.
    function test_allFourPricesLandInsideTheFullRange() public pure {
        assertEq(TickMath.getTickAtSqrtPrice(607444218490929862364), -373746);
        assertEq(TickMath.getTickAtSqrtPrice(10333626601930376557517671504208461029), 373745);
        assertEq(TickMath.getTickAtSqrtPrice(19209072819323074681), -442827);
        assertEq(TickMath.getTickAtSqrtPrice(326777965518061118072680912817470217035), 442826);
        // Dordu de tam aralikin KESINLIKLE icinde: +-442.827 << +-887.220,
        // yani iki kat pay. tickSpacing = 60 secimini savunan olcum budur.
        assertGt(TickMath.getTickAtSqrtPrice(19209072819323074681), GraduationMath.TICK_LOWER);
        assertLt(TickMath.getTickAtSqrtPrice(326777965518061118072680912817470217035), GraduationMath.TICK_UPPER);
    }

    /// Iki profilin tick'leri simetrik DEGIL, bir birim kayiktir (-373746 vs
    /// 373745). Sebebi `getTickAtSqrtPrice`in TABAN tanimi ve iki
    /// sqrtPriceX96'nin ikisinin de asagi yuvarlanmis olmasidir -- yani kayma
    /// bir HATA DEGIL, asagi-yuvarlama yonunun gozlemlenebilir izidir.
    /// Simetri bekleyen bir uygulayici burada duracak.
    function test_theTwoOrientationsTicksDifferByOneBecauseBothRoundDown() public pure {
        assertEq(
            TickMath.getTickAtSqrtPrice(607444218490929862364)
                + TickMath.getTickAtSqrtPrice(10333626601930376557517671504208461029),
            -1
        );
    }

    /// SIRALAMA TERS CEVRILDIGINDE FIYAT DA TERSINE DONER, ve carpimlari
    /// 2^192'ye ESIT DEGIL YAKINDIR (ikisi de asagi yuvarlar). Bu test,
    /// `baseIsCurrency0` bayragini fiyat hesabina TASIMAYI unutan mutanti
    /// oldurur -- ki o mutant sqrtPriceX96'yi 10^17 kat yanlis yapar ve
    /// yalnizca literal esitligiyle gorulur.
    function test_theTwoOrientationsAreReciprocalToWithinOneUlp() public pure {
        uint256 a = 607444218490929862364;
        uint256 b = 10333626601930376557517671504208461029;
        // a * b <= 2^192 ve fark, b'nin bir ulp'sinden kucuk
        assertLe(a * b, 1 << 192);
        assertGt(a * b, (1 << 192) - a - b);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_zeroReservesAreRejectedOnBothLegs() public {
        vm.expectRevert(GraduationMath.ZeroReserves.selector);
        GraduationMath.sqrtPriceX96(0, BASE_FINAL, true);
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_zeroBaseReserveIsRejected() public {
        vm.expectRevert(GraduationMath.ZeroReserves.selector);
        GraduationMath.sqrtPriceX96(16_453_433_369_060_378_707, 0, true);
    }

    // ---------------------------------------------------------------
    // ASAGI YUVARLAMA YONU
    // ---------------------------------------------------------------

    /// Iki dalda da ASAGI yuvarlanir, yani havuz P_final'da ya da ondan en
    /// fazla bir Q64.96 ulp'si ASAGIDA acar -- ve yon IKI SIRALAMADA AYNIDIR.
    /// Bir dalda `2^192 / diger` ile hesaplayan (yani YUKARI yuvarlayan) bir
    /// uygulama bu testte olur.
    function testFuzz_sqrtPriceNeverExceedsTheTruePrice(uint256 quoteFinal) public pure {
        quoteFinal = bound(quoteFinal, 1e18, 1e24);
        uint160 s = GraduationMath.sqrtPriceX96(quoteFinal, BASE_FINAL, true);
        // s^2 <= oran(X192) < (s+1)^2  -- yani s tam olarak floor(sqrt(oran))
        uint256 ratio = FullMath.mulDiv(quoteFinal, 1 << 192, BASE_FINAL * 1e12);
        assertLe(uint256(s) * uint256(s), ratio);
        assertGt((uint256(s) + 1) * (uint256(s) + 1), ratio);
    }

    /// AYNI OLCUM, TERS SIRALAMADA. Yukaridaki fuzz YALNIZCA
    /// `baseIsCurrency0 == true` dalini yuruyor; bu depoda bir ozelligin bir
    /// giris noktasinda olculup hepsinde olculmus SAYILMASI adi konmus bir
    /// ariza kipidir. Ikinci dal kendi olcumunu alir.
    ///
    /// ALT SINIR TAM OLARAK UCURUMUN BIR USTUDUR VE BU OLCULEREK BULUNDU.
    /// Ilk yazimda sinir, ustteki fuzz'dan KOPYALANARAK `1e18` idi ve test
    /// `quoteFinal = 3` sayac-orneğiyle DUSTU: `USDC = currency0` dalinda
    /// pay `Vt*1e12 = 2,799e38`dir ve `FullMath.mulDiv(a, 2^192, d)` ancak
    /// `d > a >> 64 = 15_173_409_403_934_634_553` iken sigar. Yani `1e18`
    /// tabani ucurumun ALTINDA kaliyordu ve olcum, olcmeyi amacladigi
    /// yuvarlama yonu yerine bir TASMAYI yakaliyordu.
    ///
    /// Bu, ustteki fuzz'in tabanının bu dal icin GECERSIZ oldugunun da
    /// kanitidir: iki dalin guvenli araligi AYNI DEGILDIR, cunku pay ile
    /// payda yer degistirir. Bir dalda olculen erisim digerinde gecerli
    /// DEGILDIR.
    function testFuzz_sqrtPriceNeverExceedsTheTruePriceInTheOtherOrdering(uint256 quoteFinal) public pure {
        quoteFinal = bound(quoteFinal, 15_173_409_403_934_634_554, 1e24);
        uint160 s = GraduationMath.sqrtPriceX96(quoteFinal, BASE_FINAL, false);
        uint256 ratio = FullMath.mulDiv(BASE_FINAL * 1e12, 1 << 192, quoteFinal);
        assertLe(uint256(s) * uint256(s), ratio);
        assertGt((uint256(s) + 1) * (uint256(s) + 1), ratio);
    }

    // ---------------------------------------------------------------
    // 256-BIT UCURUMU
    // ---------------------------------------------------------------

    /// Faz 1c'nin piyasa degeri tabani, Faz 2'nin tasma guvenligini %8,4 payla
    /// tasiyor ve bunu simdiye kadar HIC KIMSE YAZMAMISTI. Turetme:
    ///   USDC = currency0 dalinda oran(X192) = Vt*1e12 * 2^192 / Vq
    ///   FullMath.mulDiv(a, 2^192, d) ancak `d > a >> 64` iken sigar
    ///   (prod1 = (a * 2^192) >> 256 = a >> 64, guard `require(d > prod1)`)
    ///   a = 279_900_000e18 * 1e12  ->  a >> 64 = 15_173_409_403_934_634_553
    function test_theOverflowCliffIsExactlyWhereTheDerivationSaysItIs() public pure {
        assertEq((BASE_FINAL * 1e12) >> 64, 15_173_409_403_934_634_553);
        assertFalse(GraduationMath.isSeedable(15_173_409_403_934_634_553, BASE_FINAL));
        assertTrue(GraduationMath.isSeedable(15_173_409_403_934_634_554, BASE_FINAL));
    }

    /// Ve iki kutsanmis profilin IKISI DE ucurumun ustunde.
    function test_bothBlessedProfilesAreSeedable() public pure {
        assertTrue(GraduationMath.isSeedable(16_453_433_369_060_378_706_681, BASE_FINAL)); // uretim
        assertTrue(GraduationMath.isSeedable(16_453_433_369_060_378_707, BASE_FINAL)); // testnet
    }

    /// `isSeedable` REVERT ETMEZ -- cagiran kendi hatasiyla reddedebilsin diye.
    /// Tasma sinirinda bile `false` doner, `FullMath`in revert'ini SIZDIRMAZ.
    function test_isSeedableReturnsFalseInsteadOfRevertingAtTheCliff() public pure {
        // dogrudan cagri; vm.expectRevert YOK, cunku revert OLMAMALI
        assertFalse(GraduationMath.isSeedable(1, BASE_FINAL));
        assertFalse(GraduationMath.isSeedable(0, 1));
        assertFalse(GraduationMath.isSeedable(1, 0));
    }

    /// `baseFinal * QUOTE_SCALE`in KENDISI tasarsa da revert olmaz. Bu dal,
    /// carpimin `uint256`e sigmadigi ve dolayisiyla ucurum aritmetiginin bile
    /// hesaplanamadigi hali kapatir.
    function test_isSeedableReturnsFalseWhenTheScalingItselfWouldOverflow() public pure {
        assertFalse(GraduationMath.isSeedable(1e24, type(uint256).max));
        assertFalse(GraduationMath.isSeedable(1e24, type(uint256).max / 1e12 + 1));
    }

    /// `isSeedable` DOGRUYU SOYLER: `true` dedigi her yerde `sqrtPriceX96` IKI
    /// SIRALAMADA DA revert etmez. Bu, ikisinin ayni sinirdan konustugunun tek
    /// kanitidir -- ayri turetilmis iki esik sessizce ayrisabilirdi.
    function testFuzz_isSeedableAgreesWithSqrtPriceX96(uint256 quoteFinal) public pure {
        quoteFinal = bound(quoteFinal, 1, type(uint128).max);
        if (!GraduationMath.isSeedable(quoteFinal, BASE_FINAL)) return;
        GraduationMath.sqrtPriceX96(quoteFinal, BASE_FINAL, true);
        GraduationMath.sqrtPriceX96(quoteFinal, BASE_FINAL, false);
    }

    // ---------------------------------------------------------------
    // TOHUM LIKIDITESI
    // ---------------------------------------------------------------

    /// L ASAGI yuvarlar (getLiquidityForAmounts), Pool.modifyLiquidity gerekli
    /// miktarlari YUKARI yuvarlar. Yonler zit oldugu icin bacak basina 1 wei
    /// tasma teorik olarak mumkundur; DORT KANONIK DURUMDA OLCULDU: yok.
    /// Baglayici bacak her zaman quote'tur, cunku R6 taban yuvarlamasiyla
    /// R'nin altindadir.
    function test_seedLiquidityProductionBothOrderings() public pure {
        assertEq(GraduationMath.seedLiquidity(607444218490929862364, D, 12_161_433_369), 1586199999999999999);
        assertEq(
            GraduationMath.seedLiquidity(10333626601930376557517671504208461029, 12_161_433_369, D), 1586200000000000000
        );
    }

    function test_seedLiquidityTestnetBothOrderings() public pure {
        assertEq(GraduationMath.seedLiquidity(19209072819323074681, D, 12_161_433), 50160046734639668);
        assertEq(
            GraduationMath.seedLiquidity(326777965518061118072680912817470217035, 12_161_433, D), 50160046734639668
        );
    }

    /// L, hem uint128'e hem de tickSpacing 60'in tick basina tavanina sigar.
    ///   minTick = floor(-887272/60) = -14788   (v4-core TABANA yuvarlar)
    ///   maxTick = trunc(887272/60)  =  14787
    ///   numTicks = 14787 - (-14788) + 1 = 29576
    ///   maxLiquidityPerTick = (2^128 - 1) / 29576
    ///                       = 11_505_354_575_363_080_317_263_139_282_924_270
    /// En buyuk L (uretim) tavanin 7,25e15'te biri; bu kontrol asla tetiklenmez
    /// ve NEDEN tetiklenmedigi burada yazili.
    function test_liquidityIsFarBelowTheMaxPerTick() public pure {
        assertEq(Pool.tickSpacingToMaxLiquidityPerTick(60), 11_505_354_575_363_080_317_263_139_282_924_270);
        assertLt(uint256(1586200000000000000), uint256(Pool.tickSpacingToMaxLiquidityPerTick(60)));
    }

    /// `D` YERINE `N - S` tohumlamak fiyati DEGISTIRMEZ (fiyat P_final'dan
    /// gelir, tohumlanan orandan DEGIL) -- yalnizca TOZU degistirir. Toz,
    /// verilen miktar eksi likiditenin FIILEN tukettigi miktardir
    /// (`SqrtPriceMath.getAmount0Delta`, YUKARI yuvarlar):
    ///   D    ile toz =            130_353_606 wei = 1,3e-10 token
    ///   N-S  ile toz = 13_988_815_963_088_900_903_466 wei = 13.988,8159 token
    /// yani 1,07e14 kat. pump.fun'in %0,00676 fiyat kopuklugu, arcpad'in
    /// dunyasinda bir FIYAT kopuklugu degil bir TOZ kalemidir, cunku arcpad
    /// initialize'a acik bir sqrtPriceX96 gecirir.
    function test_seedingNMinusSWouldNotMoveThePriceButWouldStrandFourteenThousandTokens() public pure {
        uint160 s = 607444218490929862364;
        uint128 withD = GraduationMath.seedLiquidity(s, D, 12_161_433_369);
        uint128 withNminusS = GraduationMath.seedLiquidity(s, 206_900_000_000_000_000_000_000_000, 12_161_433_369);
        assertEq(withD, 1586199999999999999);
        assertEq(withNminusS, 1586200000003369815);
        // ... ve iki durumda da havuza gecilen sqrtPriceX96 AYNIDIR: s
        assertEq(GraduationMath.sqrtPriceX96(16_453_433_369_060_378_706_681, BASE_FINAL, true), s);
    }
}
