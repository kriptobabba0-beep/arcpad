// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StdUtils} from "forge-std/StdUtils.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";

/// @dev Fuzz'un surdugu aktor. Sabit bir alici kumesi uzerinde calisir --
///      rastgele adresler yerine az sayida alici kullanmak, ayni alicinin
///      ust uste yatirma/cekme yasamasini saglar ve muhasebe hatalarini
///      ortaya cikarir.
/// @dev Handler icinde assertion CAGRILMAZ: forge-std'nin assert'leri revert
///      eder ve `fail_on_revert = false` bunlari sessizce yutar, yani
///      assertion hic calismamis gibi olur. Bunun yerine ghost sayaclar
///      artirilir ve `invariant_` fonksiyonlarinda sifir olduklari iddia
///      edilir.
contract EscrowHandler is StdUtils {
    FeeEscrow public immutable escrow;

    address[3] public recipients;

    /// Ghost muhasebe: kontrattan bagimsiz olarak tutulur.
    uint256 public ghostDeposited;
    uint256 public ghostClaimed;

    /// Ghost ihlal sayaclari.
    /// @dev `claimPaidWrongAmount` hem yanlis tutari hem yanlis tarafi
    ///      yakalar: fon baskasina giderse alicinin bakiye artisi 0 olur ve
    ///      beklenenle esitlenmez.
    uint256 public claimPaidWrongAmount;
    /// @dev Claim sonrasi borcun tam sifirlanmadigi durum. Bakiye ve totalOwed
    ///      birlikte hareket ettigi icin diger invariant'lar bunu goremez.
    uint256 public claimLeftResidualDebt;

    /// @dev KULLANILABILIRLIK sayaci. Yukaridaki iki sayac GUVENLIK
    ///      ozelliklerini olcer; bu, kontratin isini YAPTIGINI olcer.
    ///      Gerekcesi olculdu: `deposit`'e bir toz filtresi eklemek
    ///      (`msg.value == 0` yerine `msg.value < 2`) dort invariant'i da
    ///      yesil biraktu, ustelik fuzzer bozuk yolu FIILEN calistirdigi halde
    ///      (`depositTo ... Reverts 164`). Mekanizma geneldir ve bu paketin
    ///      disinda da gecerlidir: `fail_on_revert = false` revert eden
    ///      handler cagrisini yutar, revert ayni anda `ghostDeposited += amount`
    ///      satirini da geri alir, boylece kontrat durumu ile ghost durumu
    ///      TAM OLARAK islem basarisiz oldugu ICIN tutarli kalir. Hicbir sey
    ///      yapmayan bir kontrat her guvenlik invariant'ini saglar. Bu yuzden
    ///      revert `try/catch` ile burada YAKALANIR ve sayilir; yutulmaz.
    uint256 public depositRevertedUnexpectedly;

    constructor(FeeEscrow escrow_) {
        escrow = escrow_;
        recipients[0] = address(0xA11CE);
        recipients[1] = address(0xB0B);
        recipients[2] = address(0xCAFE);
    }

    receive() external payable {}

    /// @dev `amount` [1, 10 ether] araligina baglanir, alici sifir degildir ve
    ///      bakiye yeterlidir -- yani BU CAGRI ICIN deposit'in revert etmesi
    ///      icin gecerli hicbir sebep yoktur. Revert ederse bu bir
    ///      kullanilabilirlik kusurudur ve sayilir.
    function depositTo(uint256 who, uint256 amount) external {
        address r = recipients[_bound(who, 0, 2)];
        amount = _bound(amount, 1, 10 ether);
        if (address(this).balance < amount) return;

        try escrow.deposit{value: amount}(r) {
            ghostDeposited += amount;
        } catch {
            depositRevertedUnexpectedly++;
        }
    }

    function claimFor(uint256 who) external {
        address r = recipients[_bound(who, 0, 2)];
        uint256 expected = escrow.owed(r);
        if (expected == 0) return;

        uint256 before = r.balance;
        escrow.claim(r);
        uint256 delta = r.balance - before;

        if (delta != expected) claimPaidWrongAmount++;
        if (escrow.owed(r) != 0) claimLeftResidualDebt++;

        ghostClaimed += expected;
    }

    /// =======================================================================
    /// EXTENSION (brief disinda, gorev talimatinin yetkilendirdigi olcumle
    /// bulunan bosluk kapatmasi): sabit `recipients` kumesindeki uc adres
    /// (0xA11CE/0xB0B/0xCAFE) kod icermez, yani `claim()`'in yaptigi
    /// `.call{value:...}("")` bunlar icin HER ZAMAN trivial olarak basarili
    /// doner -- reentrancy bu uc aliciyla IMKANSIZDIR. Olcum: claim()'de
    /// transferi defter guncellemesinden once yapan bir mutasyon, 128.000
    /// cagri x 2 farkli fuzz-seed'de DORT invariant'i de yesil birakti
    /// (task-3-report.md, Mutasyon 1). Asagidaki aktor, receive() icinde
    /// kendini tekrar claim etmeye calisan GERCEK bir reentrant alici ekler.
    /// Mevcut `recipients` dizisi ve yukaridaki iki fonksiyon DEGISTIRILMEDI;
    /// bu sadece bir eklemedir.
    /// =======================================================================
    ReentrantClaimant public reentrantActor;

    function depositToReentrantActor(uint256 amount) external {
        if (address(reentrantActor) == address(0)) {
            reentrantActor = new ReentrantClaimant(escrow);
        }
        amount = _bound(amount, 1, 10 ether);
        if (address(this).balance < amount) return;

        try escrow.deposit{value: amount}(address(reentrantActor)) {
            ghostDeposited += amount;
        } catch {
            depositRevertedUnexpectedly++;
        }
    }

    /// @dev Ayni ghost sayaclarini (ghostClaimed, claimPaidWrongAmount,
    ///      claimLeftResidualDebt) kullanir -- mevcut
    ///      `invariant_ledgerMatchesGhostAccounting` ve
    ///      `invariant_everyClaimPaidTheRightAmountAndClearedTheDebt` bu
    ///      aktoru otomatik kapsar, yeni bir invariant fonksiyonu gerekmez.
    function claimReentrantActor() external {
        if (address(reentrantActor) == address(0)) return;
        address r = address(reentrantActor);
        uint256 expected = escrow.owed(r);
        if (expected == 0) return;

        uint256 before = r.balance;
        escrow.claim(r);
        uint256 delta = r.balance - before;

        if (delta != expected) claimPaidWrongAmount++;
        if (escrow.owed(r) != 0) claimLeftResidualDebt++;

        ghostClaimed += expected;
    }
}

/// @dev Kendi claim'i sirasinda kendini tekrar claim etmeye calisan alici.
///      `reentered` bayragi tek seviyeli bir reentry'ye izin verir: sinirsiz
///      recursion (receive() her tetiklendiginde tekrar claim() cagirmak)
///      cagri yigitini tuketip TUM disaridaki claim'i REVERT ettirir -- bu
///      durumda fail_on_revert=false onu sessizce yutar ve saldiri hic
///      GOZLENEMEZ olur (bu yuzden tek seviyeli). Orijinal (dogru)
///      sozlesmeye karsi FeeEscrow.t.sol'daki ReentrantSelfClaimer ile AYNI
///      sekilde zararsizdir: ic claim() NothingToClaim ile revert eder, ama
///      duz `.call` bu revert'i yutar, disaridaki claim yine de basarili olur.
contract ReentrantClaimant {
    FeeEscrow public immutable escrow;
    bool public reentered;
    /// @dev Yalnizca gozlem icin tutulur; disaridaki claim'in kendi
    ///      basarisini etkilemez (duz `.call` kullanildigi icin bir ic
    ///      revert burada durur, yukari tasinmaz).
    bool public reentrantCallSucceeded;

    constructor(FeeEscrow escrow_) {
        escrow = escrow_;
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            (bool ok,) = address(escrow).call(abi.encodeWithSignature("claim(address)", address(this)));
            reentrantCallSucceeded = ok;
        }
    }
}
