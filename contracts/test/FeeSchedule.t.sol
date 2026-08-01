// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {BondingCurve} from "../src/BondingCurve.sol";

/// @title FeeScheduleTest
/// @notice Tablo CANLI HESAPTAN OKUNDU, uydurulmadi. Kaynak:
///         `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` (Solana mainnet,
///         owner `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`, 4073 bayt),
///         `getAccountInfo` ile iki bagimsiz RPC'den ayni yanit alindi.
///         Hesap IKI dizi tasir; kullanilan `stable_fee_tiers`tir (offset
///         1073), SOL dizisi (offset 69) DEGIL.
contract FeeScheduleTest is Test {
    FeeSchedule internal schedule;
    BondingCurve internal curve;

    /// D = S*(T-S)/T -- havuza tohumlanan taban arz.
    uint256 internal constant D = 206_886_011_183_597_390_493_942_218;

    function setUp() public {
        schedule = new FeeSchedule();
        // Ucret sabitleri DERLEME ZAMANI sabitleridir; gecerli HERHANGI bir
        // ornek onlari okumaya yeter. Profil yine de gercek testnet ucludur.
        curve = new BondingCurve(address(0xC0FFEE), address(0xE5C0), 1_073_000_000e18, 4_292e15, 793_100_000e18);
    }

    function _assertTier(uint256 mc, uint256 expectedProtocol, uint256 expectedCreator) internal view {
        (uint256 p, uint256 c) = schedule.tierFor(mc);
        assertEq(p, expectedProtocol, "protocolBps");
        assertEq(c, expectedCreator, "creatorBps");
    }

    // ---------------------------------------------------------------
    // Tablonun kendisi
    // ---------------------------------------------------------------

    /// 25 SATIRIN 25'I, ESIK VE IKI ORAN. TEK TEK. Bir dongude uretilen bir
    /// test, tabloyu KENDISIYLE karsilastirirdi.
    function test_allTwentyFiveTiersMatchTheLiveStableFeeTiers() public view {
        _assertTier(0, 95, 30);
        _assertTier(59_000_000_000, 25, 95);
        _assertTier(300_000_000_000, 25, 90);
        _assertTier(500_000_000_000, 25, 85);
        _assertTier(700_000_000_000, 25, 80);
        _assertTier(900_000_000_000, 25, 75);
        _assertTier(2_000_000_000_000, 25, 70);
        _assertTier(3_000_000_000_000, 25, 65);
        _assertTier(4_000_000_000_000, 25, 60);
        _assertTier(5_000_000_000_000, 25, 55);
        _assertTier(6_000_000_000_000, 25, 50);
        _assertTier(7_000_000_000_000, 25, 45);
        _assertTier(8_000_000_000_000, 25, 40);
        _assertTier(9_000_000_000_000, 25, 35);
        _assertTier(10_000_000_000_000, 25, 30);
        _assertTier(11_000_000_000_000, 25, 28);
        _assertTier(12_000_000_000_000, 25, 25);
        _assertTier(13_000_000_000_000, 25, 23);
        _assertTier(14_000_000_000_000, 25, 20);
        _assertTier(15_000_000_000_000, 25, 18);
        _assertTier(16_000_000_000_000, 25, 15);
        _assertTier(17_000_000_000_000, 25, 13);
        _assertTier(18_000_000_000_000, 25, 10);
        _assertTier(19_000_000_000_000, 25, 8);
        _assertTier(20_000_000_000_000, 25, 5);
    }

    /// KATLAMANIN DOGRULUGU: katlanmis toplam, canli tablonun Toplam kolonu.
    /// Esikler ve toplamlar BAGIMSIZ elle yazilmis literallerdir, dolayisiyla
    /// bu dongu tabloyu kendisiyle DEGIL, ikinci bir kayitla karsilastirir.
    function test_everyTierTotalMatchesTheLiveTotalColumn() public view {
        uint256[25] memory thresholds = [
            uint256(0),
            59_000_000_000,
            300_000_000_000,
            500_000_000_000,
            700_000_000_000,
            900_000_000_000,
            2_000_000_000_000,
            3_000_000_000_000,
            4_000_000_000_000,
            5_000_000_000_000,
            6_000_000_000_000,
            7_000_000_000_000,
            8_000_000_000_000,
            9_000_000_000_000,
            10_000_000_000_000,
            11_000_000_000_000,
            12_000_000_000_000,
            13_000_000_000_000,
            14_000_000_000_000,
            15_000_000_000_000,
            16_000_000_000_000,
            17_000_000_000_000,
            18_000_000_000_000,
            19_000_000_000_000,
            20_000_000_000_000
        ];
        uint256[25] memory totals = [
            uint256(125),
            120,
            115,
            110,
            105,
            100,
            95,
            90,
            85,
            80,
            75,
            70,
            65,
            60,
            55,
            53,
            50,
            48,
            45,
            43,
            40,
            38,
            35,
            33,
            30
        ];
        for (uint256 i = 0; i < 25; i++) {
            (uint256 p, uint256 c) = schedule.tierFor(thresholds[i]);
            assertEq(p + c, totals[i], "katlanmis toplam Toplam kolonundan sapti");
        }
        assertEq(schedule.TIER_COUNT(), 25);
    }

    /// KADEME 0, CURVE'UN ORANIYLA BIREBIR AYNI -- graduation ucret-notrdur.
    /// Sabitler `BondingCurve`'den OKUNUR, burada tekrar yazilmaz: iki yerde
    /// elle yazilmis bir 95, curve tarafinda degisirse sessizce ayrisirdi.
    function test_tierZeroReproducesTheCurveSplitExactly() public view {
        (uint256 p, uint256 c) = schedule.tierFor(0);
        assertEq(p, curve.PROTOCOL_FEE_BPS());
        assertEq(c, curve.CREATOR_FEE_BPS());
        assertEq(p, 95);
        assertEq(c, 30);
    }

    // ---------------------------------------------------------------
    // Sinir davranisi
    // ---------------------------------------------------------------

    /// ESIKLER KAPSAYICIDIR ve sinir DAVRANISI test edilir. Bir birim asagisi
    /// onceki kademe. `>=` -> `>` mutantini oldurur.
    function test_thresholdsAreInclusiveAtTheExactBoundary() public view {
        (, uint256 cBelow) = schedule.tierFor(58_999_999_999);
        (, uint256 cAt) = schedule.tierFor(59_000_000_000);
        assertEq(cBelow, 30);
        assertEq(cAt, 95);
    }

    /// AYNI SINIR OLCUMU, HER BANT SINIRINDA. Ust kademelerin dallari AYRI
    /// kod yollaridir (lane tablosu, dogrusal formul, sabit dallar) ve bir
    /// giris noktasinda olculen kapsayicilik digerlerinde olculmus SAYILMAZ.
    function test_everyBandBoundaryIsInclusiveOnItsOwnBranch() public view {
        // dogrusal formul bandinin girisi (3M)
        (, uint256 a) = schedule.tierFor(3_000_000_000_000 - 1);
        (, uint256 b) = schedule.tierFor(3_000_000_000_000);
        assertEq(a, 70);
        assertEq(b, 65);
        // lane tablosu bandinin girisi (11M)
        (, uint256 c) = schedule.tierFor(11_000_000_000_000 - 1);
        (, uint256 d) = schedule.tierFor(11_000_000_000_000);
        assertEq(c, 30);
        assertEq(d, 28);
        // son kademe girisi (20M)
        (, uint256 e) = schedule.tierFor(20_000_000_000_000 - 1);
        (, uint256 f) = schedule.tierFor(20_000_000_000_000);
        assertEq(e, 8);
        assertEq(f, 5);
    }

    /// SON KADEME TAVANDIR: 20M'nin ustunde oran ARTIK DUSMEZ.
    function testFuzz_theTopTierIsTerminal(uint256 mc) public view {
        mc = bound(mc, 20_000_000_000_000, type(uint128).max);
        (uint256 p, uint256 c) = schedule.tierFor(mc);
        assertEq(p, 25);
        assertEq(c, 5);
    }

    /// KATI AZALAN: creator payi ilk esigin ustunde hicbir yerde ARTMAZ.
    /// (Kademe 0 -> 1 ATLAMASI haric, ki o kasitlidir ve creator tesvikidir.)
    ///
    /// UST SINIR 21e12'DIR, `1e18` DEGIL, VE FARK OLCULDU. Task 3 briefi
    /// `1e18` yaziyordu; o sinirla araligin yalnizca %0,00199'u SON KADEMENIN
    /// ALTINDA kalir, yani 256 kosuda kademeli bolgeye beklenen ornek sayisi
    /// 0,0051'dir (CI'nin 5000 kosusunda 0,0997). Test o halde HER ZAMAN
    /// `assertLe(5, 5)` iddia ederek gecerdi -- monotonlugu HIC olcmeden.
    /// Olculdu: lane sirasini TERSINE ceviren mutant, `1e18` sinirli haliyle
    /// bu testi HAYATTA BIRAKIYORDU; 21e12 ile OLDURUYOR.
    /// Genis aralik kapsamasi ayri bir testte durur:
    /// `testFuzz_theTopTierIsTerminal`.
    function testFuzz_creatorBpsIsNonIncreasingAboveTheFirstThreshold(uint256 a, uint256 b) public view {
        a = bound(a, 59_000_000_000, 21_000_000_000_000);
        b = bound(b, a, 21_000_000_000_000);
        (, uint256 ca) = schedule.tierFor(a);
        (, uint256 cb) = schedule.tierFor(b);
        assertLe(cb, ca);
    }

    /// PROTOKOL PAYI ilk esigin ustunde SABITTIR (25) ve kademe 0'da 95'tir.
    /// Katlamayi yalnizca bir dalda geri alan bir mutant burada olur.
    function testFuzz_protocolBpsIsTwentyFiveEverywhereAboveTheFirstThreshold(uint256 mc) public view {
        mc = bound(mc, 59_000_000_000, 1e18);
        (uint256 p,) = schedule.tierFor(mc);
        assertEq(p, 25);
    }

    // ---------------------------------------------------------------
    // Market cap
    // ---------------------------------------------------------------

    /// Market cap SABIT arzla hesaplanir, mint'in GERCEK arziyla DEGIL. Tum
    /// launch'lar ayni arza sahip oldugu icin bu, market cap'i saf bir FIYAT
    /// fonksiyonuna indirger.
    ///   uretim graduation: quoteRaw = 12_161_433_369, baseRaw = D
    ///                      mc = 12_161_433_369 * 1e27 / D = 58_783_256_052
    ///                         = 58.783,256052 USDC   <- 59.000 esiginin ALTINDA
    ///   testnet          : quoteRaw = 12_161_433     -> mc = 58_783_254
    ///                         = 58,783254 USDC
    ///
    /// TESTNET DEGERI 58_783_254'TUR, 58_783_256 DEGIL. Task 3 briefi ikincisini
    /// yaziyordu; o sayi uretim degerinin 1000'e bolunmus hali gibi gorunuyor
    /// ama testnet quote'u (12_161_433) uretim quote'unun (12_161_433_369) tam
    /// binde biri DEGILDIR -- 12_161_433,369 tabana yuvarlanir. Fark iki birim.
    function test_graduationFdvSitsJustBelowTheFirstPoolThreshold() public view {
        assertEq(schedule.marketCap(12_161_433_369, D), 58_783_256_052);
        assertLt(schedule.marketCap(12_161_433_369, D), 59_000_000_000);
        assertEq(schedule.marketCap(12_161_433, D), 58_783_254);
        // ...ve mezuniyet aninda kademe HALA 0:
        (uint256 p, uint256 c) = schedule.tierFor(schedule.marketCap(12_161_433_369, D));
        assertEq(p, 95);
        assertEq(c, 30);
    }

    /// FDV ile RAISE AYRI BUYUKLUKLERDIR ve karistirmak sessiz bir hatadir.
    ///   uretim: raise R6 = 12_161_433_369 (12.161,43 USDC)
    ///           FDV       = 58_783_256_052 (58.783,26 USDC)  -> ~x4,83
    function test_fdvAndRaiseAreDifferentMagnitudes() public pure {
        assertEq(uint256(12_161_433_369) * 1000 / 58_783_256_052, 206);
    }

    /// Taban sifirsa market cap SIFIRDIR, revert DEGIL -- bolme hatasi
    /// hook'un icinde patlamasin diye.
    function test_marketCapIsZeroWhenBaseIsZero() public view {
        assertEq(schedule.marketCap(12_161_433_369, 0), 0);
    }

    /// `SUPPLY_CONSTANT` 1e27'dir ve bu 18-decimal'de 1 milyar tokendir --
    /// `LaunchToken`in toplam arziyla ayni. Sabiti `baseRaw` ile degistiren
    /// (yani gercek arzi kullanan) mutant burada ve FDV testinde olur.
    function test_supplyConstantIsTheWholeLaunchSupply() public view {
        assertEq(schedule.SUPPLY_CONSTANT(), 1e27);
        assertEq(schedule.SUPPLY_CONSTANT(), 1_000_000_000e18);
    }

    // ---------------------------------------------------------------
    // Degistirilemezlik
    // ---------------------------------------------------------------

    /// TABLO DEGISTIRILEMEZ, ve bu OLCULUR: calisma zamani bytecode'unda
    /// `SSTORE` (0x55), `DELEGATECALL` (0xF4) ve `SELFDESTRUCT` (0xFF)
    /// OPCODE'LARININ HICBIRI YOKTUR. Ucu de olmadan bu kontratin davranisini
    /// deploy sonrasi degistirmenin yolu YOKTUR.
    ///
    /// ILK HALI ZAYIFTI VE DEGISTIRILDI: slot 0..2'nin sifir oldugunu iddia
    /// ediyordu, ki bu HERHANGI bir kontrat icin -- storage'i olan ama henuz
    /// yazilmamis olan biri dahil -- gecerdi. Yani hicbir sey olcmuyordu.
    /// Tarama PUSH FARKINDADIR: PUSH1..PUSH32 (0x60..0x7F) immediate baytlari
    /// ATLANIR, aksi halde bir sabitin icindeki 0x55 baytini opcode sanip
    /// YANLIS ALARM verirdi.
    function test_theRuntimeCodeCannotWriteStorageOrBeReplaced() public view {
        bytes memory code = address(schedule).code;
        assertGt(code.length, 0, "kontrat deploy edilmemis -- tarama anlamsiz");

        uint256 i;
        uint256 scanned;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0x55, "SSTORE bulundu -- tablo degistirilebilir");
            assertTrue(op != 0xF4, "DELEGATECALL bulundu -- davranis disaridan gelebilir");
            assertTrue(op != 0xFF, "SELFDESTRUCT bulundu -- kontrat yok edilebilir");
            if (op >= 0x60 && op <= 0x7F) i += uint256(op) - 0x5F; // PUSH immediate'i atla
            i += 1;
            scanned += 1;
        }
        // KONTROL: tarama gercekten yurudu. Bu olmadan `code.length == 0` gibi
        // bir durumda dongu hic donmez ve test sessizce GECERDI.
        assertGt(scanned, 100, "tarama yurumedi -- test hicbir sey olcmuyor");
    }

    /// KONTROL GRUBU: ayni tarama, SSTORE'u KESINLIKLE olan bir kontratta
    /// SSTORE'u BULUR. Bu olmadan yukaridaki test, taramasi bozuk oldugu icin
    /// de gecebilirdi -- ve bozuk bir tarama her kontrati "temiz" ilan ederdi.
    function test_theOpcodeScanActuallyFindsSstoreWhenItIsThere() public {
        StorageWriter w = new StorageWriter();
        bytes memory code = address(w).code;
        bool found;
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0x55) {
                found = true;
                break;
            }
            if (op >= 0x60 && op <= 0x7F) i += uint256(op) - 0x5F;
            i += 1;
        }
        assertTrue(found, "tarama SSTORE'u kacirdi -- tarama bozuk");
    }
}

/// @dev Yalnizca kontrol grubu icin: SSTORE tasidigi KESIN olan bir kontrat.
contract StorageWriter {
    uint256 public x;

    function set(uint256 v) external {
        x = v;
    }
}
