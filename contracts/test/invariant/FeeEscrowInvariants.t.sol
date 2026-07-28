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

    /// ODEME GUCU -- bu paketin tasiyici invariant'i. Escrow, borclarinin
    /// toplamini her zaman odeyebilecek bakiyeye sahip olmali.
    /// Kirilma yolu: claim'de defteri guncellemeden once transfer yapmak,
    /// veya deposit'te totalOwed'i owed'dan farkli artirmak.
    function invariant_escrowCanAlwaysPayWhatItOwes() public view {
        assertGe(address(escrow).balance, escrow.totalOwed());
    }

    /// Bakiye ile borc arasinda fark BIRIKMEMELI: escrow bir kasa degil,
    /// bir defter. Fazla bakiye, muhasebeye girmemis para demektir.
    /// Kirilma yolu: deposit'te owed'i artirip totalOwed'i unutmak.
    function invariant_escrowHoldsExactlyWhatItOwes() public view {
        assertEq(address(escrow).balance, escrow.totalOwed());
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
