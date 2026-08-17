// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BuybackVestingVault} from "../src/BuybackVestingVault.sol";

/// Kasanin fabrikadan okudugu iki adresi veren en kucuk yuzey.
contract MockFactory {
    address public protocolTreasury;
    address public buybackTreasury;

    constructor(address treasury_, address buyback_) {
        protocolTreasury = treasury_;
        buybackTreasury = buyback_;
    }

    function setProtocolTreasury(address a) external {
        protocolTreasury = a;
    }
}

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * ============================================================================
 *  VESTING KASASI
 * ============================================================================
 *
 * Bu paketin cevapladigi soru "kod calisiyor mu" degil, "para kaybolabilir
 * mi" ve "takvim gerilebilir mi"dir. O yuzden testlerin cogu bir DEGISMEZ
 * iddia eder, bir senaryo degil.
 */
contract BuybackVestingVaultTest is Test {
    BuybackVestingVault internal vault;
    MockFactory internal factory;
    MockToken internal token;

    address internal constant TREASURY = address(0xB0B); // buyback hazinesi
    address internal constant PROTOCOL = address(0xDA0);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant STRANGER = address(0xBAD);

    uint256 internal constant YEAR = 365 days;
    uint256 internal constant FIVE_YEARS = 5 * 365 days;

    /**
     * ============ ZAMAN MUTLAK ILERLETILIR, GORELI DEGIL ============
     *
     * `vm.warp(block.timestamp + X)` BU DEPODA SESSIZCE CALISMAZ ve sebebi
     * olculdu: `foundry.toml` `via_ir = true` ile derliyor, solc bir islem
     * icinde `TIMESTAMP`i SABIT kabul edip okumayi ortak alt-ifade olarak
     * TEK SEFERE indiriyor. Gercek bir islemde bu varsayim dogrudur; `vm.warp`
     * onu ihlal eder. Sonuc: bir dongudeki ikinci ve sonraki `warp`lar hicbir
     * sey yapmaz, test de HATA VERMEDEN yanlis olani olcer.
     *
     * Olculdu: iki ardisik `vm.warp(block.timestamp + 365 days)` sonrasi
     * `block.timestamp` IKISINDE DE 1031536000 okundu.
     *
     * Bu yuzden zaman her yerde SABIT bir baslangictan MUTLAK olarak
     * kurulur.
     */
    uint256 internal constant START = 1_000_000_000;

    function _at(uint256 offset) internal {
        vm.warp(START + offset);
    }

    function setUp() public {
        factory = new MockFactory(PROTOCOL, TREASURY);
        vault = new BuybackVestingVault(address(factory));
        token = new MockToken();
        // Zaman 0'da baslamak `vestingStart`in altan tasmasina yol acar; gercek
        // bir zincirde de olmayan bir durum.
        vm.warp(START);
    }

    /// Hazineymis gibi kilitler.
    function _lock(uint256 amount) internal {
        token.mint(TREASURY, amount);
        vm.startPrank(TREASURY);
        token.approve(address(vault), amount);
        vault.lock(address(token), amount, CREATOR);
        vm.stopPrank();
    }

    // ================================================================
    // Yetki
    // ================================================================

    function test_yalnizca_hazine_kilitleyebilir() public {
        token.mint(STRANGER, 1e18);
        vm.startPrank(STRANGER);
        token.approve(address(vault), 1e18);
        vm.expectRevert(BuybackVestingVault.NotBuybackTreasury.selector);
        vault.lock(address(token), 1e18, CREATOR);
        vm.stopPrank();
    }

    /// SAHTE POZISYON SALDIRISI: yabanci biri bir tokenin takvimini
    /// sulandirmak icin kendi tokenini yatiramaz.
    function test_yabanci_sahte_vesting_pozisyonu_acamaz() public {
        _lock(1_000e18);
        uint256 endBefore = vault.vestingEnd(address(token));

        token.mint(STRANGER, 1_000_000e18);
        vm.startPrank(STRANGER);
        token.approve(address(vault), 1_000_000e18);
        vm.expectRevert(BuybackVestingVault.NotBuybackTreasury.selector);
        vault.lock(address(token), 1_000_000e18, STRANGER);
        vm.stopPrank();

        assertEq(vault.vestingEnd(address(token)), endBefore, "takvim disaridan oynatilamaz");
    }

    // ================================================================
    // Dogrusal vesting: 1, 2, 5 yil
    // ================================================================

    function test_bes_yila_dogrusal_yayilir() public {
        _lock(1_000e18);
        assertEq(vault.releasable(address(token)), 0, "t=0'da hicbir sey");

        _at(YEAR);
        assertApproxEqRel(vault.releasable(address(token)), 200e18, 1e12, "1. yil ~%20");

        _at(2 * YEAR);
        assertApproxEqRel(vault.releasable(address(token)), 400e18, 1e12, "2. yil ~%40");

        _at(3 * YEAR);
        assertApproxEqRel(vault.releasable(address(token)), 600e18, 1e12, "3. yil ~%60");

        _at(5 * YEAR);
        assertEq(vault.releasable(address(token)), 1_000e18, "5. yil TAM");
    }

    /// BES YILDAN SONRA ARTIK KALMAZ. Yuvarlama artiginin kasada takili
    /// kalmadigini kanitlar.
    function test_bitisten_sonra_artik_kalmaz() public {
        _lock(1_000e18 + 7); // kasitli olarak "cirkin" bir sayi
        _at(FIVE_YEARS + 1);
        assertEq(vault.releasable(address(token)), 1_000e18 + 7, "son wei'ye kadar");
        assertEq(vault.locked(address(token)), 0);
    }

    // ================================================================
    // §17: sik cagri takvimi GERMEMELI  -- Pons'tan sapmanin testi
    // ================================================================

    /**
     * PONS'UN HATASININ TESTI.
     *
     * Referans uygulama `lastUpdate`i vesting sifir ciksa da ilerletir. Cok
     * kucuk bir bakiyede her saniye `release` cagirmak, her seferinde tabana
     * yuvarlanan sifir uretir ve zamani YUTAR -- vesting bes yil boyunca hic
     * ilerlemez, sonunda topluca acilir.
     *
     * Bizim surumumuzde zaman devreder: 200 saniyelik tacizden sonra bile
     * bir yilin sonunda beklenen ~%20 yerinde olmalidir.
     */
    function test_sik_release_cagrisi_vestingi_durduramaz() public {
        /*
         * ILK YAZDIGIM TEST BU IDDIAYI KANITLAMIYORDU ve olcerek gordum:
         * `_checkpoint`i referans uygulamanin haline cevirdim, paket YINE
         * 20/20 gecti. Ikinci bir deneme (gunde bir cagri, 100 wei) de iki
         * surumde AYNI sonucu verdi.
         *
         * Gercek sebep su: cekilecek sey yokken `release` REVERT eder ve
         * revert, `_checkpoint`in yazdigi `lastUpdate`i de geri alir. Yani bu
         * yolu kapatan sey `_checkpoint` degil, REVERT TERCIHIDIR. Referans
         * uygulama orada `return 0` yapar ve durumu kalici kilar.
         *
         * Test bu yuzden `_checkpoint`i degil, ASIL KORUYAN OZELLIGI olcer:
         * bir faydalanici `release`i ne kadar sik cagirirsa cagirsin otekinin
         * vesting'ini geciktiremez.
         */
        _lock(1_000e18);

        for (uint256 i = 1; i <= 300; i++) {
            _at(i);
            vm.prank(PROTOCOL); // protokol, creator'i yavaslatmaya calisiyor
            try vault.release(address(token)) {} catch {}
        }

        _at(YEAR);
        assertApproxEqRel(
            vault.releasable(address(token)) + vault.totalReleased(address(token)),
            200e18,
            1e15,
            "taciz bir yillik vestingi geciktiremez"
        );
    }

    /// Ayni iddia, `release` yerine `lock` ile: sik kucuk yatirimlar da
    /// takvimi germemeli.
    function test_sik_kucuk_yatirim_takvimi_germez() public {
        _lock(1_000e18);
        for (uint256 i = 0; i < 50; i++) {
            _at(i + 1);
            _lock(1); // 1 wei
        }
        _at(YEAR + 50);
        assertApproxEqRel(vault.releasable(address(token)), 200e18, 1e15, "~%20 yerinde");
    }

    // ================================================================
    // §16: agirlikli ortalama saat
    // ================================================================

    /// BUYUK pozisyona KUCUK ekleme: takvim COK AZ oynar.
    function test_buyuk_veste_kucuk_ekleme_takvimi_az_oynatir() public {
        _lock(1_000_000e18);
        _at(YEAR);
        uint256 endBefore = vault.vestingEnd(address(token));

        _lock(10_000e18); // %1
        uint256 endAfter = vault.vestingEnd(address(token));

        uint256 shift = endAfter - endBefore;
        // Kalan sure 4 yil; yeni yatirim 5 yil ister. Kayma, agirligiyla
        // sinirli olmali: %1'lik bir ekleme bir yildan cok daha az kaydirir.
        assertLt(shift, 20 days, "kucuk ekleme takvimi az oynatir");
        assertGt(shift, 0, "ama biraz oynatir");
    }

    /// KUCUK pozisyona BUYUK ekleme: takvim neredeyse tamamen yeni saate gecer.
    function test_kucuk_veste_buyuk_ekleme_saati_tasir() public {
        _lock(10_000e18);
        _at(4 * YEAR); // neredeyse bitti
        _lock(1_000_000e18);

        uint256 remaining = vault.vestingEnd(address(token)) - block.timestamp;
        // Yeni yatirim baskin: kalan sure bes yila cok yakin olmali.
        assertGt(remaining, FIVE_YEARS - 30 days, "buyuk ekleme saati tasir");
        assertLe(remaining, FIVE_YEARS, "bes yili asamaz");
    }

    /// YENI YATIRIM, HAK EDILMIS VESTINGI GERIYE DONUK SEYRELTEMEZ.
    function test_yeni_yatirim_hak_edilmisi_seyreltmez() public {
        _lock(1_000e18);
        _at(YEAR);
        uint256 earned = vault.releasable(address(token)); // ~200e18

        _lock(1_000_000e18);

        assertGe(vault.releasable(address(token)), earned, "hak edilmis geri alinamaz");
    }

    // ================================================================
    // §18: %30 / %70 bolusme
    // ================================================================

    function test_release_otuz_yetmis_boler() public {
        _lock(1_000e18);
        _at(FIVE_YEARS);

        vm.prank(CREATOR);
        vault.release(address(token));

        assertEq(token.balanceOf(CREATOR), 700e18, "creator %70");
        assertEq(token.balanceOf(PROTOCOL), 300e18, "protokol %30");
        assertEq(token.balanceOf(address(vault)), 0, "kasada artik kalmaz");
    }

    function test_protokol_de_release_cagirabilir_ve_ikisi_de_odenir() public {
        _lock(1_000e18);
        _at(FIVE_YEARS);

        vm.prank(PROTOCOL);
        vault.release(address(token));

        assertEq(token.balanceOf(CREATOR), 700e18, "cagiran protokol olsa da creator odenir");
        assertEq(token.balanceOf(PROTOCOL), 300e18);
    }

    function test_yabanci_release_cagiramaz() public {
        _lock(1_000e18);
        _at(FIVE_YEARS);
        vm.prank(STRANGER);
        vm.expectRevert(BuybackVestingVault.NotBeneficiary.selector);
        vault.release(address(token));
    }

    /// PROTOKOL ALICISI ROTASYONU: pay SNAPSHOT'lidir, adres CANLIDIR.
    function test_treasury_rotasyonu_yeni_adresi_takip_eder() public {
        _lock(1_000e18);
        _at(FIVE_YEARS);

        address newTreasury = address(0xABCD);
        factory.setProtocolTreasury(newTreasury);

        vm.prank(CREATOR);
        vault.release(address(token));

        assertEq(token.balanceOf(newTreasury), 300e18, "yeni treasury alir");
        assertEq(token.balanceOf(PROTOCOL), 0, "eski treasury almaz");
    }

    // ================================================================
    // Muhasebe degismezleri
    // ================================================================

    /// TOPLAM ODENEN, HIC BIR ZAMAN TOPLAM VESTE ERMISI ASAMAZ.
    function test_odenen_veste_ermisi_asamaz() public {
        _lock(1_000e18);
        for (uint256 i = 0; i < 20; i++) {
            _at((i + 1) * 90 days);
            vm.prank(CREATOR);
            try vault.release(address(token)) {} catch {}
            assertLe(vault.totalReleased(address(token)), vault.vestedAmount(address(token)), "odenen <= veste ermis");
        }
    }

    /// PARCALI CEKIMLERIN TOPLAMI, TEK SEFERLIK CEKIME ESIT.
    function test_parcali_cekim_toplamda_kayip_vermez() public {
        _lock(1_000e18);
        for (uint256 i = 0; i < 10; i++) {
            _at((i + 1) * (FIVE_YEARS / 10));
            vm.prank(CREATOR);
            try vault.release(address(token)) {} catch {}
        }
        _at(FIVE_YEARS + 1);
        vm.prank(CREATOR);
        try vault.release(address(token)) {} catch {}

        assertEq(vault.totalReleased(address(token)), 1_000e18, "tek wei kaybolmaz");
        assertEq(token.balanceOf(CREATOR) + token.balanceOf(PROTOCOL), 1_000e18);
    }

    // ================================================================
    // §30: tokenler arasi bulasma
    // ================================================================

    function test_iki_token_defterleri_birbirine_karismaz() public {
        MockToken other = new MockToken();

        _lock(1_000e18);

        other.mint(TREASURY, 5_000e18);
        vm.startPrank(TREASURY);
        other.approve(address(vault), 5_000e18);
        vault.lock(address(other), 5_000e18, address(0xFEED));
        vm.stopPrank();

        _at(FIVE_YEARS);

        assertEq(vault.releasable(address(token)), 1_000e18);
        assertEq(vault.releasable(address(other)), 5_000e18);

        vm.prank(CREATOR);
        vault.release(address(token));

        assertEq(vault.totalReleased(address(other)), 0, "A'nin cekimi B'ye dokunmaz");
        assertEq(other.balanceOf(address(vault)), 5_000e18);
    }

    // ================================================================
    // Kenar durumlar
    // ================================================================

    function test_sifir_tutar_sessizce_gecer() public {
        vm.prank(TREASURY);
        vault.lock(address(token), 0, CREATOR);
        assertEq(vault.totalLocked(address(token)), 0);
    }

    function test_acilmamis_vestte_release_reddedilir() public {
        vm.prank(CREATOR);
        vm.expectRevert(BuybackVestingVault.VestNotOpen.selector);
        vault.release(address(token));
    }

    function test_cekilecek_sey_yokken_reddedilir() public {
        _lock(1_000e18);
        vm.prank(CREATOR);
        vm.expectRevert(BuybackVestingVault.NothingToRelease.selector);
        vault.release(address(token));
    }

    /// ARZ DEGISMEZ: kasa bir YAKMA adresi degildir (§32).
    function test_toplam_arz_degismez() public {
        uint256 before = token.totalSupply();
        _lock(1_000e18);
        assertEq(token.totalSupply(), before + 1_000e18, "mint disinda arz oynamaz");

        _at(FIVE_YEARS);
        vm.prank(CREATOR);
        vault.release(address(token));
        assertEq(token.totalSupply(), before + 1_000e18, "release arzi degistirmez");
    }
}
