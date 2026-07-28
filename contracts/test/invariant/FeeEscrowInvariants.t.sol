// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

contract FeeEscrowInvariantsTest is Test {
    FeeEscrow internal escrow;
    EscrowHandler internal handler;

    function setUp() public {
        escrow = new FeeEscrow();
        handler = new EscrowHandler(escrow);
        vm.deal(address(handler), 1_000_000 ether);
        targetContract(address(handler));
    }

    /// ODEME GUCU -- KONTRATIN ARC UZERINDEKI GERCEK GARANTISI. Escrow,
    /// borclarinin toplamini her zaman odeyebilecek bakiyeye sahip olmali.
    /// `assertGe`, `assertEq` degil, cunku dagitim hedefinde bakiye deposit()
    /// disinda ARTABILIR: Arc'ta native varlik ile 0x3600...00 adresindeki
    /// ERC-20 gorunum ayni bakiyenin iki gorunumudur ve o adrese yapilan duz
    /// bir `transfer` `receive()` calistirmadan bakiyeyi artirir (canli
    /// testnet'te olculdu; bkz. FeeEscrow kisiti 1). Yani asagidaki daha guclu
    /// esitlik zincirde YANLIS olabilir, bu ise olamaz.
    /// Kirilma yolu: claim'de defteri guncellemeden once transfer yapmak,
    /// veya deposit'te totalOwed'i owed'dan farkli artirmak.
    function invariant_escrowCanAlwaysPayWhatItOwes() public view {
        assertGe(address(escrow).balance, escrow.totalOwed());
    }

    /// BU HANDLER'IN DUNYASINDA gecerli olan DAHA GUCLU ozellik: burada
    /// bagis yolu yoktur (kimse escrow'a deposit() disinda para gonderemez),
    /// dolayisiyla bakiye ile borc TAM esit olmalidir. Zincirdeki garanti bu
    /// degildir -- bu, muhasebe kaymasini yakalayan olcum aracidir: escrow bir
    /// kasa degil bir defterdir ve fazla bakiye "muhasebeye girmemis para"
    /// demektir. Iki invariant bilerek birlikte durur: ustteki NE'nin dogru
    /// oldugunu, bu NE'nin olculdugunu soyler.
    /// Kirilma yolu: deposit'te owed'i artirip totalOwed'i unutmak.
    function invariant_escrowHoldsExactlyWhatItOwes() public view {
        assertEq(address(escrow).balance, escrow.totalOwed());
    }

    /// KULLANILABILIRLIK. Yukaridakilerin hepsi guvenlik ozelligidir ve
    /// HICBIR SEY YAPMAYAN bir kontrat hepsini saglar: `fail_on_revert = false`
    /// revert eden handler cagrisini yutar ve ayni revert ghost sayaci da geri
    /// alir, boylece iki taraf islem BASARISIZ OLDUGU ICIN tutarli kalir.
    /// Olculdu: `deposit`'e toz filtresi (`msg.value < 2`) eklemek 4/4
    /// invariant'i yesil birakti, fuzzer bozuk yolu 164 kez tetikledigi halde.
    /// Bu invariant o bosluktur: gecerli her tutar icin deposit REVERT ETMEZ.
    /// 1 wei'lik bir pay kucuk bir islemde ulasilabilirdir ve revert eden bir
    /// deposit butun trade'i revert ettirir.
    function invariant_depositNeverRevertsForAValidAmount() public view {
        assertEq(handler.depositRevertedUnexpectedly(), 0);
    }

    /// Ghost muhasebe ile kontratin defteri ortusmeli.
    /// Kirilma yolu: claim'in sildigi tutarla gonderdigi tutarin farkli olmasi.
    function invariant_ledgerMatchesGhostAccounting() public view {
        assertEq(escrow.totalOwed(), handler.ghostDeposited() - handler.ghostClaimed());
    }

    /// Her claim, tam olarak borcu kadar ve tam olarak alicisina odemeli,
    /// ve borcu tam sifirlamali. Handler bunu her cagrida olcup sayac artirir.
    /// Kirilma yolu: fonu msg.sender'a gondermek (alicinin bakiye artisi 0
    /// olur), veya borcu kismen silmek -- ikincisini diger uc invariant
    /// GOREMEZ, cunku bakiye ve totalOwed birlikte dusmeye devam eder.
    function invariant_everyClaimPaidTheRightAmountAndClearedTheDebt() public view {
        assertEq(handler.claimPaidWrongAmount(), 0);
        assertEq(handler.claimLeftResidualDebt(), 0);
    }
}
