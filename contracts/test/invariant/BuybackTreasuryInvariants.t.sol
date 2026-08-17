// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BuybackTreasury} from "../../src/BuybackTreasury.sol";
import {BuybackTreasuryHandler} from "./BuybackTreasuryHandler.sol";

/**
 * ============================================================================
 *  BUYBACK HAZINESI -- DEGISMEZLER
 * ============================================================================
 *
 * Bu, CREATOR'IN PARASINI tutan kontrattir. Birim testleri (`BuybackTreasury.t.sol`)
 * bilinen yollari olcer: bir tahakkuk, bir supurme, bir geri katlama. Zor kisim
 * ise bilinen bir yolda DEGIL, sunlarin rastgele sirasindadir: iki ayri
 * launch'a tahakkuk, arada mezuniyet, arada zorla gonderilmis native, arada
 * yedinci gunu gecen bir saat, ve iki farkli cagirandan gelen supurmeler.
 *
 * Cevaplanan uc soru:
 *   1. Para KAYBOLABILIR mi (muhasebe kimligi + odeme gucu)?
 *   2. Bir launch'in butcesi BASKASINA gidebilir mi (izolasyon + yetki)?
 *   3. Para KILITLENEBILIR mi (yedinci gun penceresi)?
 */
contract BuybackTreasuryInvariantsTest is Test {
    BuybackTreasuryHandler internal handler;
    BuybackTreasury internal treasury;

    function setUp() public {
        handler = new BuybackTreasuryHandler();
        treasury = handler.treasury();
        targetContract(address(handler));
    }

    function _tokens() internal view returns (address[2] memory) {
        return [handler.tokens(0), handler.tokens(1)];
    }

    /**
     * DEFTER KIMLIGI, TOKEN BASINA.
     *
     * `pendingQuote[t]` her zaman "o token icin tahakkuk eden" eksi "o token
     * icin supurulen"dir. Ne bir wei fazla, ne bir wei eksik.
     *
     * BU AYNI ZAMANDA IZOLASYON IDDIASIDIR: A'ya yapilan bir tahakkuk B'nin
     * defterine dokunsaydi, B'nin kimligi kirilirdi. Ayri bir "cross" testi
     * gerekmez -- iki kimlik birlikte onu zaten ifade eder.
     */
    function invariant_perTokenLedgerIdentity() public view {
        address[2] memory ts = _tokens();
        for (uint256 i = 0; i < 2; i++) {
            assertEq(
                treasury.pendingQuote(ts[i]),
                handler.ghostAccrued(ts[i]) - handler.ghostRemoved(ts[i]),
                "pendingQuote ghost defterinden ayrildi"
            );
        }
    }

    /**
     * ODEME GUCU. Hazine, butun bekleyen butcelerin toplamini odeyebilmeli.
     *
     * `assertGe`: bagis yolu aciktir (Arc'ta tek bakiyenin ERC-20 gorunumune
     * yapilan duz bir transfer bakiyeyi HICBIR KOD CALISTIRMADAN artirir) ve
     * bagislar defterde gorunmez. Daha guclu esitlik zincirde YANLIS olurdu.
     */
    function invariant_treasuryCanPayEveryPendingBudget() public view {
        address[2] memory ts = _tokens();
        uint256 owed = treasury.pendingQuote(ts[0]) + treasury.pendingQuote(ts[1]);
        assertGe(address(treasury).balance, owed, "hazine bekleyen butceleri odeyemiyor");
    }

    /**
     * BAGIS HICBIR BUTCEYI BUYUTMEZ.
     *
     * Kontratin dosya basligi bunu ADIYLA soyluyor: "aksi halde bagis yap,
     * sonra fiyat etkisi sinirini asir gibi bir manipulasyon yuzeyi acilirdi".
     * Bu, o cumlenin OLCUMUDUR.
     *
     * Kirilma yolu: `pendingQuote` yerine `address(this).balance` okumak.
     */
    function invariant_forcedNativeIsInvisible() public view {
        assertEq(handler.donationMovedBudget(), 0, "zorla gonderilen native bir butceyi buyuttu");
    }

    /**
     * TAHAKKUK YETKISI. Yalnizca tokenin KENDI egrisi ve fabrikanin kayitli
     * hook'u. Ucuncu bir cagiran ASLA.
     *
     * Muhasebe invariant'larindan BAGIMSIZDIR ve olmasi gerekir: yabanci bir
     * tahakkuk defteri BOZMAZ (para gercekten gelir, deftere dogru yazilir) --
     * yalnizca BASKASININ butcesini sisirir. Kimlik iddiasi bunu goremez
     * cunku handler o parayi ghost'a da yazardi.
     */
    function invariant_onlyTheCurveOrTheHookMayAccrue() public view {
        assertEq(handler.strangerAccrued(), 0, "yabanci bir adres tahakkuk ettirebildi");
    }

    /**
     * SUPURME BUTCEYI HER ZAMAN SIFIRLAR.
     *
     * Alim yapilsin ya da para creator'a geri katlansin -- ikisi de bir
     * supurmedir ve ikisinden sonra da butce SIFIRDIR. Yarim kalmis bir
     * butce, ayni parayi ikinci kez harcatabilecek tek durumdur.
     *
     * `BuybackTreasury.sol:206` bunu ETKILER ONCE yazar; bu invariant o
     * satirin gercekten her dalda calistigini olcer.
     */
    function invariant_sweepAlwaysClearsTheBudget() public view {
        assertEq(handler.pendingSurvivedSweep(), 0, "supurmeden sonra butce sifirlanmadi");
    }

    /**
     * YEDINCI GUN PENCERESI -- IKI YONLU.
     *
     * ERKEN ACILMAZ: `SWEEP_GRACE` dolmadan izinsiz supurme, anahtarcinin
     * tekelini deler ve `minTokensOut`u yabancinin secmesine izin verirdi
     * (yani slipaj korumasini kapatirdi). Kaydedilen ariza gercektir: saat
     * `lastSweepAt == 0` iken ikinci dal HER ZAMAN dogruydu, yani HIC
     * supurulmemis bir token -- butcenin en buyuk oldugu an -- ANINDA izinsiz
     * supurulebiliyordu.
     *
     * GEC KAPANMAZ: pencere aciksa yabanci bir cagiri REDDEDILEMEZ. Aksi
     * halde anahtarci sustugunda fon kalici olarak erisilemez kalirdi
     * (spec §29). `strangerSwept` iki yonu de sayar.
     */
    function invariant_theSevenDayWindowIsExact() public view {
        assertEq(handler.earlyPermissionless(), 0, "pencere yedinci gunden ONCE acildi");
        assertEq(handler.strangerSwept(), 0, "izinsiz supurme penceresi yanlis tarafta");
    }

    /**
     * KULLANILABILIRLIK -- VE BU SATIR OLMADAN HEPSI ANLAMSIZ.
     *
     * Yukaridaki alti iddiayi HICBIR SEY YAPMAYAN bir hazine de saglar:
     * `accrue`i revert ettirin, defter hep bos kalir ve altisi da yesil doner.
     * `fail_on_revert = false` revert eden cagriyi yutar, ayni revert ghost
     * satirini da geri alir, ve iki taraf islem BASARISIZ OLDUGU ICIN tutarli
     * kalir.
     *
     * `assertGt` BURADA DEGIL, asagidaki DETERMINISTIK testte -- gerekcesi
     * `BuybackVaultInvariants`te yazili (baslangic durumu + kosu basina
     * sifirlanma = kararsiz kapi).
     */
    function invariant_theLedgerIsNotFrozenAtZero() public view {
        address[2] memory ts = _tokens();
        // Bir tahakkuk OLDUYSA defterde izi olmali. Sessizce hicbir sey
        // yazmayan bir `accrue` burada kirmizi olur.
        if (handler.accruals() > 0) {
            assertGt(
                handler.ghostAccrued(ts[0]) + handler.ghostAccrued(ts[1]), 0, "tahakkuk sayildi ama ghost defteri bos"
            );
            assertGt(
                treasury.pendingQuote(ts[0]) + treasury.pendingQuote(ts[1]) + handler.ghostRemoved(ts[0])
                    + handler.ghostRemoved(ts[1]),
                0,
                "tahakkuk sayildi ama kontrat defteri hicbir sey gormedi"
            );
        }
    }

    /**
     * AKSIYONLARIN NO-OP OLMADIGI -- DETERMINISTIK.
     *
     * Bir handler'in butun aksiyonlari erken donse, yedi invariant'in yedisi
     * de yesil kalirdi. Bu test o boslugu elle yurutulmus tek bir diziyle
     * kapatir.
     */
    function test_handlerActionsAreNotNoOps() public {
        address token = handler.tokens(0);

        handler.accrueFromCurve(0, 1e18);
        assertEq(treasury.pendingQuote(token), 1e18, "tahakkuk defteri hareket ettirmedi");

        handler.accrueFromHook(0, 5e17);
        assertEq(treasury.pendingQuote(token), 15e17, "hook tahakkuku gorunmedi");

        handler.accrueFromStranger(0, 1e18);
        assertEq(handler.strangerAccrued(), 0, "yabanci tahakkuk ettirebildi");
        assertEq(treasury.pendingQuote(token), 15e17, "yabanci butceyi buyuttu");

        handler.donateNative(3e18);
        assertEq(handler.donationMovedBudget(), 0, "bagis butceyi oynatti");
        assertEq(treasury.pendingQuote(token), 15e17, "bagis pendingQuote'u degistirdi");

        // Erken yabanci supurme reddedilmeli.
        handler.sweepAsStranger(0);
        assertEq(handler.strangerSwept(), 0, "yabanci yedinci gunden once supurebildi");
        assertEq(treasury.pendingQuote(token), 15e17, "reddedilen supurme butceyi dusurdu");

        handler.sweepAsKeeper(0);
        assertEq(treasury.pendingQuote(token), 0, "supurme butceyi sifirlamadi");
        assertGt(handler.sweeps(), 0, "sweepAsKeeper hicbir sey yapmadi");
        assertEq(handler.pendingSurvivedSweep(), 0, "butce supurmeden sagli cikti");

        // Yedinci gunden SONRA pencere acilir ve yabanci supurebilir.
        handler.accrueFromCurve(0, 1e18);
        handler.advanceTime(8 days);
        assertTrue(treasury.sweepIsPermissionless(token), "pencere yedinci gunden sonra acilmadi");
        handler.sweepAsStranger(0);
        assertEq(handler.strangerSwept(), 0, "acik pencerede yabanci supurme reddedildi");
        assertEq(treasury.pendingQuote(token), 0, "acik pencerede supurme butceyi sifirlamadi");
        assertEq(handler.earlyPermissionless(), 0, "pencere erken acildi");
    }
}
