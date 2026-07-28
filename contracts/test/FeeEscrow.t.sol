// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";

/// Native kabul etmeyen alici -- Arc'ta "sozlesmelere native gonderimin
/// basarili olacagi garanti degil" kuralinin somut hali.
contract RejectingRecipient {
    receive() external payable {
        revert("no");
    }
}

/// Ek test yardimcisi (brief disinda): claim() sirasinda kendi alacagini
/// tekrar claim etmeye calisan bir alici. CEI'nin (owed once sifirlanir,
/// sonra transfer edilir) reentrancy'i gercekten engelledigini dogrular.
contract ReentrantSelfClaimer {
    FeeEscrow public immutable escrow;
    bool public reentered;
    bool public reentrantCallSucceeded;

    constructor(FeeEscrow _escrow) {
        escrow = _escrow;
    }

    receive() external payable {
        reentered = true;
        (bool ok,) = address(escrow).call(abi.encodeWithSignature("claim(address)", address(this)));
        reentrantCallSucceeded = ok;
    }
}

/// Ek test yardimcisi (brief disinda): claim() sirasinda BASKA bir alicinin
/// alacagini claim etmeye calisan bir alici. Bu meru bir reentrancy'dir ve
/// basarili olmalidir -- CEI yalnizca AYNI alicinin ikinci claim'ini engeller.
contract ReentrantCrossClaimer {
    FeeEscrow public immutable escrow;
    address public immutable other;
    bool public otherClaimSucceeded;

    constructor(FeeEscrow _escrow, address _other) {
        escrow = _escrow;
        other = _other;
    }

    receive() external payable {
        (bool ok,) = address(escrow).call(abi.encodeWithSignature("claim(address)", other));
        otherClaimSucceeded = ok;
    }
}

contract FeeEscrowTest is Test {
    FeeEscrow internal escrow;
    address internal constant PROTOCOL = address(0xAAA1);
    address internal constant CREATOR = address(0xBBB2);

    function setUp() public {
        escrow = new FeeEscrow();
        vm.deal(address(this), 1_000 ether);
    }

    function test_depositCreditsTheNamedRecipient() public {
        escrow.deposit{value: 10}(PROTOCOL);
        assertEq(escrow.owed(PROTOCOL), 10);
        assertEq(escrow.owed(CREATOR), 0);
        assertEq(escrow.totalOwed(), 10);
        assertEq(address(escrow).balance, 10);
    }

    /// Ucret parcalardan toplanir: protokol ve creator paylari AYRI AYRI
    /// yatirilir ve escrow ikisini birbirine karistirmaz (spec 5.5).
    function test_protocolAndCreatorSharesAreTrackedSeparately() public {
        escrow.deposit{value: 95}(PROTOCOL);
        escrow.deposit{value: 30}(CREATOR);
        assertEq(escrow.owed(PROTOCOL), 95);
        assertEq(escrow.owed(CREATOR), 30);
        assertEq(escrow.totalOwed(), 125);
    }

    function test_depositsAccumulate() public {
        escrow.deposit{value: 10}(PROTOCOL);
        escrow.deposit{value: 5}(PROTOCOL);
        assertEq(escrow.owed(PROTOCOL), 15);
    }

    function test_claimPaysTheRecipientAndZeroesTheDebt() public {
        escrow.deposit{value: 100}(PROTOCOL);
        uint256 before = PROTOCOL.balance;

        escrow.claim(PROTOCOL);

        assertEq(PROTOCOL.balance - before, 100);
        assertEq(escrow.owed(PROTOCOL), 0);
        assertEq(escrow.totalOwed(), 0);
        assertEq(address(escrow).balance, 0);
    }

    /// Claim izinsizdir: creator'in gas'i olmasa bile ucreti kilitli kalmaz.
    /// Fon her halukarda alicisina gider, tetikleyene degil.
    function test_anyoneCanTriggerAClaimButFundsGoToTheRecipient() public {
        escrow.deposit{value: 100}(CREATOR);
        address stranger = address(0xDEAD);
        uint256 strangerBefore = stranger.balance;
        uint256 creatorBefore = CREATOR.balance;

        vm.prank(stranger);
        escrow.claim(CREATOR);

        assertEq(CREATOR.balance - creatorBefore, 100);
        assertEq(stranger.balance, strangerBefore);
    }

    /// Bir alicinin native kabul etmemesi digerlerinin parasini kilitleyemez.
    /// Push-based bir tasarimda bu mumkun olmazdi; pull-based olmasinin
    /// sebebi tam olarak budur.
    function test_oneRejectingRecipientCannotBlockOthers() public {
        RejectingRecipient bad = new RejectingRecipient();
        escrow.deposit{value: 50}(address(bad));
        escrow.deposit{value: 70}(CREATOR);

        vm.expectRevert(FeeEscrow.TransferFailed.selector);
        escrow.claim(address(bad));

        // Digerinin claim'i etkilenmez.
        escrow.claim(CREATOR);
        assertEq(escrow.owed(CREATOR), 0);
        // Reddedenin borcu durur, kaybolmaz.
        assertEq(escrow.owed(address(bad)), 50);
        assertEq(address(escrow).balance, 50);
    }

    function test_revertsOnZeroRecipient() public {
        vm.expectRevert(FeeEscrow.ZeroRecipient.selector);
        escrow.deposit{value: 1}(address(0));
    }

    function test_revertsOnZeroValueDeposit() public {
        vm.expectRevert(FeeEscrow.ZeroAmount.selector);
        escrow.deposit{value: 0}(PROTOCOL);
    }

    function test_revertsWhenThereIsNothingToClaim() public {
        vm.expectRevert(FeeEscrow.NothingToClaim.selector);
        escrow.claim(PROTOCOL);
    }

    function test_claimTwiceInARowRevertsTheSecondTime() public {
        escrow.deposit{value: 10}(PROTOCOL);
        escrow.claim(PROTOCOL);
        vm.expectRevert(FeeEscrow.NothingToClaim.selector);
        escrow.claim(PROTOCOL);
    }

    function test_eventsAreEmitted() public {
        vm.expectEmit(true, true, false, true);
        emit FeeEscrow.Deposited(PROTOCOL, address(this), 42);
        escrow.deposit{value: 42}(PROTOCOL);

        vm.expectEmit(true, false, false, true);
        emit FeeEscrow.Claimed(PROTOCOL, 42);
        escrow.claim(PROTOCOL);
    }

    // -- Asagidaki testler brief'in disindadir; belirsizlik notu 2'nin
    // yetkilendirdigi ek kapsam: mutasyona duyarli sinirlar. --

    /// totalOwed, tum bakiyelerin ham toplami degil; SADECE tahsil
    /// edilmemis bakiyelerin toplamidir. Bir claim yalnizca kendi payini
    /// dusmeli, digerinin payini etkilememelidir.
    function test_totalOwedTracksOnlyUnclaimedAmountAcrossMultipleRecipients() public {
        escrow.deposit{value: 40}(PROTOCOL);
        escrow.deposit{value: 60}(CREATOR);

        escrow.claim(PROTOCOL);

        assertEq(escrow.totalOwed(), 60);
        assertEq(escrow.owed(CREATOR), 60);
        assertEq(escrow.owed(PROTOCOL), 0);
    }

    /// Escrow'un receive()/fallback() fonksiyonu yoktur: deposit()'i atlayip
    /// DUZ NATIVE gonderim yapmak basarisiz olmali.
    ///
    /// DIKKAT -- bu testin kanitladigi sey sinirlidir. Bakiyenin deposit()
    /// disinda ARTAMAYACAGINI kanitlamaz, cunku Arc'ta bu YANLIS: native
    /// varlik ile 0x3600...00 adresindeki ERC-20 gorunum ayni bakiyenin iki
    /// gorunumudur. Canli Arc testnet'te (blok 54019678) FeeEscrow'un
    /// derlenmis runtime bytecode'u bir hedefe yerlestirilip olculdu:
    /// `USDC.transfer(target, 1_000_000)` `true` dondu ve hedefin native
    /// bakiyesi 1e18 wei oldu -- `receive()` hic calismadan. Dolayisiyla
    /// dagitim hedefinde gecerli olan `totalOwed <= balance`'tir, esitlik
    /// degil (bkz. FeeEscrow kisiti 1). Burada olculen yalnizca EVM'in duz
    /// `call{value:}` yolunun kapali oldugudur.
    function test_plainNativeTransferWithoutDepositReverts() public {
        (bool ok,) = address(escrow).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(escrow).balance, 0);
    }

    /// CEI'nin somut kaniti: claim() owed[recipient]'i external call'dan ONCE
    /// sifirlar. Bir alici kendi claim'i icinde tekrar kendini claim etmeye
    /// calisirsa NothingToClaim ile karsilasir -- reentrancy guard olmadan.
    ///
    /// IKINCI ALICININ 1000 WEI'SI TESTIN KENDISIDIR, dekor degil. Onceki
    /// hali escrow'da SADECE saldirganin kendi 40 wei'sini tutuyordu; o
    /// kurulumda `recipient.call`'i defter guncellemesinden ONCE yapan
    /// mutasyon altinda ic claim bos bakiyede transfer hatasina dusuyor ve
    /// disaridaki claim masum gorunerek tamamlaniyordu -- yani test kendi
    /// belgeledigi sebeple BASARISIZ OLAMIYORDU (olculdu: 15 passed,
    /// 0 failed). Escrow'da baskasinin parasi varken ayni saldirgan, tek
    /// baytini degistirmeden, her seyi bosaltir.
    function test_reentrantClaimOnSameRecipientFailsBecauseDebtIsZeroedBeforeTransfer() public {
        ReentrantSelfClaimer attacker = new ReentrantSelfClaimer(escrow);
        escrow.deposit{value: 40}(address(attacker));
        escrow.deposit{value: 1000}(CREATOR);

        escrow.claim(address(attacker));

        assertTrue(attacker.reentered());
        // Once para, sonra bayrak: ihlalde en bilgilendirici mesaj budur
        // (mutasyon altinda "1040 != 40" -- olculdu).
        assertEq(address(attacker).balance, 40);
        assertFalse(attacker.reentrantCallSucceeded());
        assertEq(escrow.owed(address(attacker)), 0);

        // Baskasinin parasina dokunulmadi ve escrow onu hala odeyebilir.
        assertEq(escrow.owed(CREATOR), 1000);
        assertEq(escrow.totalOwed(), 1000);
        assertGe(address(escrow).balance, escrow.owed(CREATOR));
    }

    /// 1 wei yatirilabilir olmali: alt sinir YOKTUR. Ucret modelinde kucuk bir
    /// islemde 1 wei'lik pay ulasilabilir bir degerdir ve revert eden bir
    /// deposit butun islemi revert ettirir. Dosyadaki diger her deposit >= 5
    /// wei oldugu icin bu sinir hicbir yerde altindan pinlenmiyordu: bir
    /// "toz filtresi" (`msg.value < 2`) 15/15 unit ve 4/4 invariant'i yesil
    /// birakiyordu.
    function test_oneWeiDepositIsCreditable() public {
        escrow.deposit{value: 1}(PROTOCOL);
        assertEq(escrow.owed(PROTOCOL), 1);
        assertEq(escrow.totalOwed(), 1);
        assertEq(address(escrow).balance, 1);

        uint256 before = PROTOCOL.balance;
        escrow.claim(PROTOCOL);
        assertEq(PROTOCOL.balance - before, 1);
    }

    /// YUZEY TESTI: claim() disinda deger hareket ettiren HICBIR giris noktasi
    /// olmamali.
    ///
    /// Bunun ayri bir test olmasinin sebebi olculdu: FeeEscrow'a
    /// `sweep(address)` eklemek 15/15 unit ve 4/4 invariant'i yesil birakti.
    /// Invariant'lar bunu YAPISAL OLARAK goremez -- `targetContract` handler'dir
    /// ve handler yalnizca deposit/claim sarar, dolayisiyla fuzz'lanan hicbir
    /// dizi handler'in cagirmadigi bir fonksiyona ulasamaz. "Sikisan fonlari
    /// kurtaralim" eklemeleri (sweep/rescue/withdraw/emergencyWithdraw) tam da
    /// bu yuzden yalnizca boyle bir yuzey taramasiyla yakalanabilir.
    ///
    /// Hedef NATIVE KABUL EDEN BIR EOA'dir. Test kontratinin kendisi hedef
    /// olarak kullanilamaz: forge-std'nin `Test`'inde `receive()` yoktur, o
    /// yuzden sweep zaten basarisiz olur ve test YANLIS SEBEPLE gecerdi --
    /// bu incelemenin kaldirmak icin var oldugu hatanin ta kendisi.
    function test_noValueMovingEntrypointBeyondClaimExists() public {
        escrow.deposit{value: 100}(CREATOR);

        address thief = address(0xBEE7); // kodsuz EOA: native'i kosulsuz kabul eder
        uint256 thiefBefore = thief.balance;

        bytes[6] memory payloads = [
            abi.encodeWithSignature("sweep(address)", thief),
            abi.encodeWithSignature("sweep()"),
            abi.encodeWithSignature("rescue(address)", thief),
            abi.encodeWithSignature("rescue(address,uint256)", thief, uint256(100)),
            abi.encodeWithSignature("withdraw()"),
            abi.encodeWithSignature("emergencyWithdraw(address)", thief)
        ];

        for (uint256 i = 0; i < payloads.length; i++) {
            (bool ok,) = address(escrow).call(payloads[i]);
            ok; // sonuc onemli degil: onemli olan paranin yerinde durmasi.
            assertEq(address(escrow).balance, 100, "an entrypoint moved escrow funds");
            assertEq(thief.balance, thiefBefore, "an entrypoint paid an arbitrary address");
            assertEq(escrow.owed(CREATOR), 100, "an entrypoint stranded a debt");
            assertEq(escrow.totalOwed(), 100);
        }

        // Tek mesru cikis yolu hala calisiyor.
        escrow.claim(CREATOR);
        assertEq(CREATOR.balance, 100);
        assertEq(address(escrow).balance, 0);
    }

    /// Farkli bir alicinin claim'ini reentrant olarak tetiklemek mesrudur ve
    /// basarili olmalidir -- CEI yalnizca AYNI alicinin defterini korur,
    /// izinsizlik ilkesini ihlal etmez.
    function test_reentrantClaimOnADifferentRecipientSucceeds() public {
        ReentrantCrossClaimer attacker = new ReentrantCrossClaimer(escrow, CREATOR);
        escrow.deposit{value: 40}(address(attacker));
        escrow.deposit{value: 60}(CREATOR);
        uint256 creatorBefore = CREATOR.balance;

        escrow.claim(address(attacker));

        assertTrue(attacker.otherClaimSucceeded());
        assertEq(CREATOR.balance - creatorBefore, 60);
        assertEq(escrow.owed(CREATOR), 0);
        assertEq(escrow.owed(address(attacker)), 0);
        assertEq(escrow.totalOwed(), 0);
    }
}
