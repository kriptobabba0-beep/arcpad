// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BuybackVestingVault} from "../../src/BuybackVestingVault.sol";
import {BuybackVaultHandler} from "./BuybackVaultHandler.sol";

/**
 * ============================================================================
 *  VESTING KASASI -- DEGISMEZLER
 * ============================================================================
 *
 * NEDEN VARLAR. Kasanin birim testleri (`BuybackVestingVault.t.sol`) BILINEN
 * yollari olcer: bir kilit, iki kilit, bes yil sonra bir cekim. Kasanin
 * matematiginin zor kismi ise bilinen bir yolda DEGIL, agirlikli ortalamanin
 * `vestingEnd`i her yeni kilitte YENIDEN KAYDIRMASINDA: her kilit takvimi
 * degistirir, her cekim defteri degistirir, ve ikisi rastgele sirayla gelir.
 * Bu, tam olarak bir invariant suite'inin gordugu, bir senaryo testinin
 * goremedigi seydir.
 *
 * BURADAKI HER IDDIA "PARA KAYBOLABILIR MI" ya da "TAKVIM GERILEBILIR MI"
 * sorusunun bir parcasidir; hicbiri "kod calisiyor mu" degildir.
 */
contract BuybackVaultInvariantsTest is Test {
    BuybackVaultHandler internal handler;
    BuybackVestingVault internal vault;

    function setUp() public {
        handler = new BuybackVaultHandler();
        vault = handler.vault();
        targetContract(address(handler));
    }

    function _tokens() internal view returns (address[2] memory) {
        return [handler.tokens(0), handler.tokens(1)];
    }

    /**
     * DEFTER KIMLIGI -- BU PAKETIN EN ONEMLI IDDIASI.
     *
     * Kasaya giren her token UC yerden BIRINDE olmak zorunda: odenmis,
     * cekilmeyi bekleyen, ya da hala vesting'de. Dorduncu bir yer YOKTUR.
     *
     * Kirilma yolu: `_checkpoint`te `unvestedAmount -= newlyVested` yapip
     * `vestedUnreleased += newlyVested` satirini dusurmek -- token bir yerden
     * cikar, hicbir yere girmez. Baska hicbir invariant bunu GORMEZ: bakiye
     * degismez, `totalReleased` degismez, `totalLocked` degismez.
     */
    function invariant_ledgerIdentityHolds() public view {
        address[2] memory tokens = _tokens();
        for (uint256 i = 0; i < 2; i++) {
            address t = tokens[i];
            assertEq(
                vault.totalLocked(t),
                vault.totalReleased(t) + vault.releasable(t) + vault.locked(t),
                "kilitlenen = odenen + cekilebilir + hala kilitli"
            );
        }
    }

    /**
     * ODEME GUCU. Kasa, henuz odemedigi her seyi odeyebilecek bakiyeye sahip
     * olmali.
     *
     * `assertGe`, `assertEq` DEGIL: bagis yolu aciktir (herkes kasaya token
     * gonderebilir) ve bagislar defterde GORUNMEZ. Daha guclu esitlik bu
     * yuzden ZINCIRDE yanlistir; bu ise olamaz.
     */
    function invariant_vaultCanPayWhatItStillOwes() public view {
        address[2] memory tokens = _tokens();
        for (uint256 i = 0; i < 2; i++) {
            address t = tokens[i];
            assertGe(
                IERC20(t).balanceOf(address(vault)),
                vault.totalLocked(t) - vault.totalReleased(t),
                "kasa borcunu odeyemiyor"
            );
        }
    }

    /**
     * BAGIS DEFTERI HAREKET ETTIRMEZ -- ve bu, ustteki `assertGe`nin OLCUM
     * ARACIDIR.
     *
     * Kasanin bakiyesi ile defteri arasindaki fark TAM OLARAK bagis kadar
     * olmali. Fazlasi "muhasebeye girmemis para", eksigi "defterin
     * kaydettigi ama olmayan para" demektir.
     *
     * Kirilma yolu: `lock`un `received`i `balanceOf` FARKI yerine dogrudan
     * `amount`tan almasi -- ya da herhangi bir yerde `balanceOf`a bakmasi.
     */
    function invariant_donationsAreInvisibleToTheLedger() public view {
        assertEq(handler.donationMovedLedger(), 0, "bagis defteri oynatti");

        address[2] memory tokens = _tokens();
        for (uint256 i = 0; i < 2; i++) {
            address t = tokens[i];
            uint256 outstanding = vault.totalLocked(t) - vault.totalReleased(t);
            assertEq(
                IERC20(t).balanceOf(address(vault)) - outstanding,
                handler.ghostDonated(t),
                "bakiye ile defter arasindaki fark bagistan baska bir sey"
            );
        }
    }

    /**
     * TOKENLER BIRBIRINE KARISMAZ.
     *
     * A'nin butcesi B'nin faydalanicisini odeyemez. Handler'in ghost defteri
     * token BASINA tutulur ve kontratin kendi defteriyle karsilastirilir.
     *
     * Kirilma yolu: `_vests`i token'a gore degil tek bir kayda gore tutmak;
     * ya da `release`in yanlis tokeni transfer etmesi.
     */
    function invariant_tokensDoNotCrossContaminate() public view {
        address[2] memory tokens = _tokens();
        for (uint256 i = 0; i < 2; i++) {
            address t = tokens[i];
            assertEq(vault.totalLocked(t), handler.ghostLocked(t), "totalLocked ghost'tan ayrildi");
            assertEq(
                vault.totalReleased(t), handler.ghostReleased(t), "totalReleased ghost'tan ayrildi"
            );
        }
    }

    /**
     * 70/30, VE HER ZAMAN. Yuvarlama artigi CREATOR'A gider (`creatorAmount =
     * released - protocolAmount`), yani protokol asla bir wei fazla almaz.
     *
     * Handler bunu BAKIYE DEGISIMINDEN olcer, kontratin dondurdugu sayidan
     * degil -- "dogru hesapladi ama BASKASINA gonderdi" mutantini yalnizca o
     * gorur.
     */
    function invariant_everyReleaseSplitSeventyThirty() public view {
        assertEq(handler.splitWrong(), 0, "70/30 boluntusu bozuldu");

        address[2] memory tokens = _tokens();
        for (uint256 i = 0; i < 2; i++) {
            address t = tokens[i];
            assertEq(
                handler.ghostCreatorPaid(t) + handler.ghostProtocolPaid(t),
                vault.totalReleased(t),
                "odenenlerin toplami deftere uymuyor"
            );
            // Protokol payi HER ZAMAN yarinin altinda: 3000 bps.
            assertLe(handler.ghostProtocolPaid(t) * 10_000, vault.totalReleased(t) * 3_000 + 10_000);
        }
    }

    /**
     * YETKI. `release` yalnizca IKI adresten cagrilabilir; ucuncusu asla.
     *
     * Bu, ustteki muhasebe iddialarindan BAGIMSIZDIR: bir yabancinin cekimi
     * defteri BOZMAZ (paralar yine dogru faydalanicilara gider, cunku
     * alicilar `msg.sender`dan degil kayittan okunur) -- yani muhasebe
     * invariant'larinin hicbiri onu goremez. Yakalayan tek sey budur.
     */
    function invariant_onlyBeneficiariesCanRelease() public view {
        assertEq(handler.strangerReleased(), 0, "yabanci bir adres cekim yapabildi");
    }

    /**
     * TOPLAM ODENEN, TOPLAM KILITLENENI ASAMAZ.
     *
     * Ustteki kimlikten TUREMEZ gorunur ama ayri bir seyi olcer: kimlik bir
     * ANLIK fotograftir ve `releasable`/`locked` gorunumleri uzerinden gecer;
     * bu ise KUMULATIF iki sayacin iliskisidir ve o gorunumlere hic bakmaz.
     * Ikisi ayri kod yolunda kirilir.
     */
    function invariant_releasedNeverExceedsLocked() public view {
        address[2] memory tokens = _tokens();
        for (uint256 i = 0; i < 2; i++) {
            assertLe(vault.totalReleased(tokens[i]), vault.totalLocked(tokens[i]));
        }
    }

    /**
     * KULLANILABILIRLIK -- VE BU SATIR OLMADAN HEPSI ANLAMSIZ.
     *
     * Yukaridaki her guvenlik iddiasini HICBIR SEY YAPMAYAN bir kasa da
     * saglar: `lock`u revert ettirin, defter hep bos kalir ve altisi da yesil
     * doner. `fail_on_revert = false` revert eden handler cagrisini yutar,
     * ayni revert ghost sayaci da geri alir, boylece iki taraf islem
     * BASARISIZ OLDUGU ICIN tutarli kalir. Bu, `FeeEscrowInvariants`in ayni
     * gerekceyle tasidigi bosluktur.
     *
     * @dev BURADA `assertGt(handler.locks(), 0)` YOKTUR VE OLMAMALIDIR. Iki
     *      sebep, ikisi de olculdu:
     *
     *      1. Foundry her `invariant_` fonksiyonunu BASLANGIC durumuna karsi
     *         da bir kez kosar; orada hicbir cagri yapilmamistir ve iddia
     *         "failed to set up invariant testing environment" ile duser.
     *      2. `afterInvariant`a tasimak da yanlis olurdu: durum KOSULAR
     *         ARASINDA sifirlanir, yani iddia KOSU BASINA olculur. Derinlik
     *         64 ve yedi hedef fonksiyonla bir kosunun hic `lockFor`
     *         cagirmama olasiligi (6/7)^64 ~ 5e-5'tir; 256 kosuda bu, ~%1,3
     *         yanlis kirmizi demektir. Kararsiz bir kapi, kapisizliktan
     *         KOTUDUR.
     *
     *      "Kasa gercekten calisiyor" iddiasi bu yuzden IKI YERE bolundu:
     *      revert etmedigi BURADA, defteri gercekten hareket ettirdigi
     *      `invariant_tokensDoNotCrossContaminate`te (ghost esitligi: sessizce
     *      hicbir sey yazmayan bir `lock` orada kirmizi olur), ve aksiyonlarin
     *      no-op OLMADIGI asagidaki DETERMINISTIK testte.
     */
    function invariant_theVaultActuallyWorks() public view {
        assertEq(handler.lockRevertedUnexpectedly(), 0, "gecerli bir lock revert etti");
    }

    /**
     * HANDLER'IN KENDISI BIR NO-OP DEGIL -- ve bu DETERMINISTIK olarak
     * olculur, fuzz'a birakilmaz.
     *
     * Bir handler'in butun aksiyonlari erken donse (`return`), yukaridaki
     * dokuz invariant'in DOKUZU da yesil kalirdi. Bu test o boslugu tek bir
     * elle yurutulmus dizi ile kapatir: kilitle -> zamani gecir -> cek, ve
     * her adimda defterin GERCEKTEN hareket ettigini iddia et.
     */
    function test_handlerActionsAreNotNoOps() public {
        address token = handler.tokens(0);

        handler.lockFor(0, 1_000e18);
        assertGt(handler.locks(), 0, "lockFor hicbir sey yapmadi");
        assertEq(vault.totalLocked(token), 1_000e18, "defter kilitlenen tutari gormedi");
        assertEq(vault.releasable(token), 0, "kilit aninda cekilebilir bir sey olmamali");

        // Bes yilin yarisi. Mutlak warp icin handler'in kendi saatini kullan.
        handler.advanceTime(365 days);
        assertGt(vault.releasable(token), 0, "zaman gecti ama hicbir sey vest etmedi");

        handler.releaseBy(0, true);
        assertGt(handler.releases(), 0, "releaseBy hicbir sey yapmadi");
        assertGt(vault.totalReleased(token), 0, "cekim defteri hareket ettirmedi");
        assertEq(handler.splitWrong(), 0, "70/30 boluntusu bozuldu");

        // Yabanci kapisi, ayni dizi icinde.
        handler.releaseByStranger(0);
        assertEq(handler.strangerReleased(), 0, "yabanci cekim yapabildi");

        // Bagis defteri oynatmamali.
        handler.donate(0, 500e18);
        assertEq(handler.donationMovedLedger(), 0, "bagis defteri oynatti");
        assertEq(vault.totalLocked(token), 1_000e18, "bagis totalLocked'i degistirdi");
    }

    /**
     * VESTING BITTIKTEN SONRA HICBIR SEY TAKILI KALMAZ.
     *
     * Agirlikli ortalama her kilitte `vestingEnd`i ileri kaydirir ve
     * `_previewNewlyVested` bir tam sayi bolmesidir; ikisi birlikte, sonsuza
     * kadar cekilemeyen bir artik uretebilirdi. `_previewNewlyVested`in
     * "bitis gecildiyse KALANIN TAMAMI" dali tam olarak bunu engeller ve bu
     * invariant onu olcer.
     */
    function invariant_nothingIsStrandedAfterVesting() public view {
        assertEq(handler.strandedAfterVesting(), 0, "vesting bittikten sonra takili bakiye kaldi");
    }
}
