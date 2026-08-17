// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";

/// @title FeeScheduleProvenanceTest
/// @notice `FeeSchedule`in tablosunun GERCEKTEN `stable_fee_tiers`ten geldigini
///         DEPO ICINDEN kanitlar.
///
/// @dev NEDEN AYRI BIR DOSYA VE NEDEN HAM BAYTLAR. `FeeSchedule.t.sol`
///      yalnizca "kaynak ile testler birbirine uyuyor"u kanitlar. Bu YETMEZ:
///      pump.fun'in `FeeConfig` hesabi IKI kademe dizisi tasir ve ikisinin
///      lp/protokol/creator KOLONLARI BIREBIR AYNIDIR -- yalnizca ESIKLER
///      ayrisir. Dolayisiyla yanlis diziyi yazan biri, hem `FeeSchedule.sol`u
///      hem `FeeSchedule.t.sol`u ayni yanlis esiklerle doldurur ve o paket
///      TAMAMEN YESIL kalir. Bu, gercek bir yazim hatasinin uretecegi seyin
///      TA KENDISIDIR ve o testler onu goremez.
///
///      Bu yuzden hesabin HAM BAYTLARI depoya konur. Iddia artik "kaynagim
///      testlerimle uyusuyor" degil, "kaynagim ZINCIRDEKI HESABIN 1073.
///      OFFSET'INDEKI DIZIYLE uyusuyor" olur -- ve o dizi burada, agactaki
///      baytlardan, HER KOSUDA yeniden cozulur. Kanit artik depo disinda
///      yasayan bir tanikliga dayanmiyor.
///
/// @dev KAYNAK VE COZUM.
///        hesap  : 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx (Solana mainnet)
///        owner  : pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
///        boyut  : 4073 bayt
///        cekim  : 2026-08-01, `getAccountInfo` ile IKI BAGIMSIZ RPC'den
///                 (api.mainnet-beta.solana.com ve solana-rpc.publicnode.com)
///                 BAYT BAYT AYNI yanit alindi.
///        sha256 : 0xe1c4647573d8caacc33b267781272c4fa0ad30a70900dddbaab512db670d3af2
///
///      YERLESIM (bu testte iddia edilir, varsayilmaz):
///        0..8       Anchor discriminator  8f3492bbdb7b4c9b
///        8..40      admin: Pubkey
///        40         bump: u8
///        41..65     flat_fees { lp: u64=25, protocol: u64=5, creator: u64=0 }
///        65..69     u32 = 25                  <- Vec uzunluk oneki
///        69..1069   fee_tiers[25]             <- SOL. KULLANILMAZ.
///        1069..1073 u32 = 25                  <- Vec uzunluk oneki
///        1073..2073 stable_fee_tiers[25]      <- USDC. KULLANILAN BUDUR.
///        2073..4073 sifir dolgusu
///
///      Her `FeeTier` 40 bayttir: threshold u128 (LE), sonra lp/protocol/
///      creator u64 (LE).
///
/// @dev HANGISININ HANGISI OLDUGU UC BAGIMSIZ SEYLE SABITLENIR, ve ucu de
///      bu dosyada YURUTULUR:
///        (1) SIRA -- iki `Vec` bildirim sirasindadir; `stable_fee_tiers`
///            sonradan eklenen, ozel adli olandir, yani IKINCIDIR.
///        (2) ESIKLERIN AYRISMASI -- iki dizinin esik kolonlari 24 satirin
///            24'unde farklidir, yani ayirt EDILEBILIRLER. (Denenip
///            OLDURULEN bir iddia: "stable esikleri yuvarlak, SOL'unkiler
///            degil". Yanlis -- ikisi de 1e9'un tam kati.)
///        (3) ARCPAD'IN KENDI EKONOMISI -- graduation FDV'si 58.783,26 USDC
///            olup 59.000'in %0,37 ALTINDADIR. Bu, spec'in "graduation
///            ucret-notrdur, orani degistiren ILK ESIK GECISIDIR" cumlesinin
///            sayisal karsiligidir. 420.000'lik bir ilk esikte FDV esigin
///            7,1 KATI altinda kalir ve o cumle anlamsizlasir.
contract FeeScheduleProvenanceTest is Test {
    FeeSchedule internal schedule;

    string internal constant ACCOUNT_PATH = "./fixtures/pumpfun-feeconfig.bin";

    bytes32 internal constant ACCOUNT_SHA256 = 0xe1c4647573d8caacc33b267781272c4fa0ad30a70900dddbaab512db670d3af2;

    uint256 internal constant STABLE_TIERS_OFFSET = 1073;
    uint256 internal constant SOL_TIERS_OFFSET = 69;
    uint256 internal constant TIER_STRIDE = 40;

    bytes internal account;

    function setUp() public {
        schedule = new FeeSchedule();
        account = vm.readFileBinary(ACCOUNT_PATH);
    }

    // ---------------------------------------------------------------
    // Baytlarin kendisi
    // ---------------------------------------------------------------

    /// Agactaki baytlar TAM OLARAK zincirden cekilenlerdir. Bu iddia olmadan
    /// asagidaki her sey, duzenlenebilir bir dosyaya dayanirdi.
    function test_theCommittedAccountBytesAreExactlyWhatTheChainReturned() public view {
        assertEq(account.length, 4073, "hesap boyutu degismis");
        assertEq(sha256(account), ACCOUNT_SHA256, "hesap baytlari agacta degistirilmis");
    }

    /// YERLESIM IDDIA EDILIR. Discriminator ve iki `Vec` uzunluk oneki, dizi
    /// offsetlerinin TAHMIN olmadigini gosterir.
    function test_theAccountLayoutIsWhatTheDecodeAssumes() public view {
        assertEq(bytes8(_slice(account, 0, 8)), bytes8(0x8f3492bbdb7b4c9b), "Anchor discriminator degismis");
        assertEq(_u64(41), 25, "flat_fees.lp");
        assertEq(_u64(49), 5, "flat_fees.protocol");
        assertEq(_u64(57), 0, "flat_fees.creator");
        // Iki Vec uzunluk oneki: dizilerin BASLADIGI yerler bunlarla sabitlenir.
        assertEq(_u32(SOL_TIERS_OFFSET - 4), 25, "birinci Vec uzunlugu 25 degil");
        assertEq(_u32(STABLE_TIERS_OFFSET - 4), 25, "ikinci Vec uzunlugu 25 degil");
        // Ikinci dizi biter bitmez hesap sifir dolgusuna gecer.
        assertEq(_u64(STABLE_TIERS_OFFSET + 25 * TIER_STRIDE), 0, "ikinci dizinin ardi sifir degil");
    }

    // ---------------------------------------------------------------
    // Kanit: kaynak, 1073'teki diziden gelir
    // ---------------------------------------------------------------

    /// HER 25 SATIR, AGACTAKI BAYTLARDAN COZULUR VE `FeeSchedule`E SORULUR.
    /// Kaynagi ve testleri BIRLIKTE duzenleyen bir yanlis transkripsiyon
    /// burada olur, cunku bu testin "beklenen"i yazilmis bir literal degil,
    /// COZULMUS hesabin kendisidir.
    function test_everyShippedTierComesFromTheStableArrayAtOffset1073() public view {
        for (uint256 i = 0; i < 25; i++) {
            uint256 o = STABLE_TIERS_OFFSET + i * TIER_STRIDE;
            uint256 threshold = _u128(o);
            uint256 lp = _u64(o + 16);
            uint256 protocol = _u64(o + 24);
            uint256 creator = _u64(o + 32);

            (uint256 gotProtocol, uint256 gotCreator) = schedule.tierFor(threshold);

            // LP payi PROTOKOLE KATLANIR -- katlamanin tanimi da boylece
            // canli baytlara karsi dogrulanmis olur.
            assertEq(gotProtocol, lp + protocol, "protokol payi (LP katlanmis) canli satirdan sapti");
            assertEq(gotCreator, creator, "creator payi canli satirdan sapti");
        }
        assertEq(schedule.TIER_COUNT(), 25);
    }

    /// VE KAYNAK, 69'DAKI SOL DIZISINDEN GELMEZ. Bu, iki incelemenin de
    /// kapatamadigi TEK hucredir: iki dizinin oran kolonlari AYNI oldugu icin
    /// yanlis diziyi okumak hicbir toplami bozmaz. Ayirt eden sey ESIKLERDIR,
    /// ve burada tam olarak onlar karsilastirilir.
    function test_theShippedTableIsNotTheSolArrayAtOffset69() public view {
        uint256 mismatches;
        for (uint256 i = 1; i < 25; i++) {
            uint256 solThreshold = _u128(SOL_TIERS_OFFSET + i * TIER_STRIDE);
            uint256 stableThreshold = _u128(STABLE_TIERS_OFFSET + i * TIER_STRIDE);
            if (solThreshold != stableThreshold) mismatches++;
        }
        // Iki dizinin esikleri 24 satirin 24'unde AYRISIR -- yani ayirt
        // edilebilirler, ve asagidaki iddia bos degildir.
        assertEq(mismatches, 24, "iki dizi ayirt edilemiyor -- bu test hicbir sey olcmuyor");

        // Ilk gecis esigi: stable 59.000, SOL 420.000. `FeeSchedule` ilkini
        // kullanir. SOL dizisi kullanilsaydi 59.000'de HALA kademe 0 olurdu.
        assertEq(_u128(STABLE_TIERS_OFFSET + TIER_STRIDE), 59_000_000_000);
        assertEq(_u128(SOL_TIERS_OFFSET + TIER_STRIDE), 420_000_000_000);
        (uint256 p, uint256 c) = schedule.tierFor(59_000_000_000);
        assertEq(p, 25, "59.000'de hala kademe 0 -- SOL dizisi yazilmis olabilir");
        assertEq(c, 95);
    }

    /// ARCPAD'IN KENDI EKONOMISI IKI DIZIYI AYIRT EDER, VE BU OLCULEN TEK
    /// AYIRT EDICIDIR.
    ///
    /// ONCE YANLIS BIR AYIRT EDICI DENENDI VE BU TEST ONU OLDURDU: "stable
    /// esikleri 1.000 USDC'nin kati, SOL esikleri degil" diye yazilmisti.
    /// YANLIS -- olculdu, SOL esikleri de 1e9'un tam kati (420.000.000.000,
    /// 1.470.000.000.000, ... 98.240.000.000.000 hepsi kalansiz). Yuvarlaklik
    /// iki diziyi AYIRT ETMEZ ve o iddia kaldirildi.
    ///
    /// AYIRT EDEN SEY, GRADUATION FDV'SININ ILK ESIGE ORANIDIR:
    ///   uretim FDV = 58_783_256_052 (58.783,26 USDC), ve `D` uzerinden
    ///   zincire baglidir -- iki dosyayi birlikte duzenleyerek kaydirilamaz.
    ///     stable ilk esik 59.000     -> oran 0,99632  (esigin HEMEN altinda)
    ///     SOL    ilk esik 420.000    -> oran 0,13996  (esigin 7,1 KATI alti)
    /// Spec'in "graduation ucret-notrdur; orani degistiren ILK ESIK
    /// GECISIDIR" cumlesi yalnizca birincisiyle anlamlidir. Yanlis dizi
    /// yazilsaydi hicbir launch birinci kademeye YAKIN bile olmazdi.
    function test_onlyTheStableArrayPutsGraduationJustBelowTheFirstThreshold() public view {
        uint256 productionFdv = 58_783_256_052;

        uint256 stableFirst = _u128(STABLE_TIERS_OFFSET + TIER_STRIDE);
        uint256 solFirst = _u128(SOL_TIERS_OFFSET + TIER_STRIDE);

        uint256 stableRatio = (productionFdv * 100_000) / stableFirst;
        uint256 solRatio = (productionFdv * 100_000) / solFirst;

        assertEq(stableRatio, 99_632, "stable ilk esigine oran degismis");
        assertEq(solRatio, 13_996, "SOL ilk esigine oran degismis");

        // "HEMEN ALTINDA" ve "COK ALTINDA" ayrimi sayiya dokulur.
        assertGt(stableRatio, 99_000, "graduation artik ilk esigin hemen altinda degil");
        assertLt(stableRatio, 100_000, "graduation ilk esigi GECIYOR -- ucret-notrluk bozuldu");
        assertLt(solRatio, 20_000, "SOL dizisi de esigin hemen altinda -- ayirt edici cokmus");
    }

    // ---------------------------------------------------------------
    // Little-endian okuyucular
    // ---------------------------------------------------------------

    function _u32(uint256 o) internal view returns (uint256 v) {
        for (uint256 i = 0; i < 4; i++) {
            v |= uint256(uint8(account[o + i])) << (8 * i);
        }
    }

    function _u64(uint256 o) internal view returns (uint256 v) {
        for (uint256 i = 0; i < 8; i++) {
            v |= uint256(uint8(account[o + i])) << (8 * i);
        }
    }

    function _u128(uint256 o) internal view returns (uint256 v) {
        for (uint256 i = 0; i < 16; i++) {
            v |= uint256(uint8(account[o + i])) << (8 * i);
        }
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = b[start + i];
        }
    }
}
