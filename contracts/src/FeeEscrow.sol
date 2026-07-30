// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";

/// @title FeeEscrow
/// @notice Ucretlerin biriktigi ve CEKILDIGI defter. Hicbir ucret push
///         edilmez.
/// @dev Pull-based olmasi bir tercih degil zorunluluktur: Arc'ta sozlesmelere
///      native gonderimin basarili olacagi garanti degildir. Push-based bir
///      tasarimda native kabul etmeyen tek bir alici, ayni islemdeki diger
///      herkesin ucretini kilitlerdi.
/// @dev Bu fazda tek varlik native USDC'dir. Ozel pairing asset destegi
///      kapsam disidir (spec 2).
///
/// @dev ENTEGRASYON KISITLARI -- dordu de dagitilmis kontratin gercek
///      ozellikleridir ve baska hicbir yerde yazili degildir.
///
/// @dev (1) BAKIYE deposit() DISINDAN DA ARTABILIR VE O PARA GERI ALINAMAZ.
///      `receive()`/`fallback()` yoktur, yani duz bir native gonderim
///      basarisiz olur -- bu test edilmistir. ANCAK Arc'ta native varlik ile
///      0x3600000000000000000000000000000000000000 adresindeki ERC-20 gorunum
///      AYNI bakiyenin iki gorunumudur, iki ayri varlik degil. Canli Arc
///      testnet'te (blok 54019678) FeeEscrow'un derlenmis runtime bytecode'u
///      bir hedefe yerlestirilip olculdu: `USDC.transfer(target, 1_000_000)`
///      `true` dondu ve hedefin native bakiyesi 1e18 wei oldu; `receive()`
///      hic calismadi. Yani `balance == totalOwed` dagitim hedefinde KESIN
///      DEGILDIR; gecerli olan `totalOwed <= balance`'tir. Guvenli yon
///      korunur (escrow asla borcunu odeyemez hale gelmez) ama bu adrese
///      dogrudan gonderilen USDC talep edilemez; arayuz burayi "ucretlerin
///      biriktigi adres" diye gostermemelidir.
///
/// @dev (2) ALICILAR receive() ICINDE YALNIZCA TAHAKKUK ETMELIDIR.
///      `claim` izinsizdir: bir alicinin `receive()`'inin NE ZAMAN calisacagina
///      ucuncu bir taraf karar verir ve claim hep-ya-hic oldugu icin NE KADARLA
///      calisacagini da o secer. Ornegin ileride alinan ucretle piyasadan alim
///      yapan bir BuybackVault, saldirganin tokeni alip `claim(vault)` ile
///      alimi sisirilmis fiyattan tetikleyip ustune satmasina izin verir --
///      tek bir Arc isleminde, zamani ve buyuklugu saldirganin secimiyle.
///      Bu FeeEscrow icinde, spec'in bilerek sectigi izinsizlik ozelliginden
///      vazgecmeden duzeltilemez; dolayisiyla alici tarafinda bir kisittir.
///
/// @dev (3) CAGIRAN SIFIR PAYLARI ATLAMALIDIR. `deposit`, `msg.value == 0`
///      icin `ZeroAmount()` ile revert eder. Ucret modelinde sifir pay
///      MESRUDUR -- curve uzerinde LP payi %0'dir ve buyback payi varsayilan
///      olarak kapalidir -- ayrica satis yolunda `quoteSellProceeds` 0'a
///      yuvarlanabilir ve o zaman iki ucret parcasi da 0 olur. Yapilandirilmis
///      her payi kosulsuz yatiran bir cagiran HER islemi revert ettirir.
///      Revert bilerek korunmustur; sifiri atlamak cagiranin yukumlulugudur.
///
/// @dev (4) BLOKLANMIS BIR ALICININ BAKIYESI KALICI OLARAK DONAR. Arc
///      bloklama listesini calisma zamaninda uygular, yani gas odenmis olsa
///      bile native transfer revert edebilir. Bu kontratta owner, yeniden
///      atama ve kurtarma yolu YOKTUR; bu eksiklik urunun vaadidir, gozden
///      kacma degildir. Dolayisiyla kabul edilmis bir risktir. Operasyonel
///      karsilik Faz 1c'dedir: protokol ucret ALICI ADRESI dondurulebilir
///      olmalidir, boylece protokol payi yeni bir adrese yonlendirilebilir
///      (bloklanan adreste birikmis bakiye yine de kurtarilamaz).
///
///      DURUMU: ODENDI (Faz 1c2). `LaunchFactory.protocolTreasury` artik
///      IMMUTABLE DEGILDIR ve `setProtocolTreasury` ile dondurulebilir;
///      `BondingCurve.protocolTreasury()` onu HER YATIRIMDA factory'den okur,
///      dolayisiyla rotasyon YALNIZCA gelecek launch'lara degil ZATEN CANLI
///      curve'lere de ulasir -- bu cumlenin tamamiyla odenmesi icin gereken
///      sey tam olarak buydu. Kisitlarin geri kalani AYNEN GECERLIDIR:
///      birikmis `owed[bloklu]` hala kurtarilamaz, ve bu kontrata hala owner,
///      yeniden atama ve kurtarma yolu EKLENMEMISTIR.
/// @dev `IFeeEscrow`'u UYGULAR. Bag suslemede degil, derleyicidedir:
///      `deposit`'in imzasi degistiginde `BondingCurve`'un beklentisiyle
///      ayrisma derleme hatasi olur, sessiz bir calisma zamani sapmasi degil.
contract FeeEscrow is IFeeEscrow {
    error ZeroRecipient();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    event Deposited(address indexed recipient, address indexed from, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);

    /// @notice Alici basina cekilebilir bakiye.
    mapping(address => uint256) public owed;

    /// @notice Tum alicilarin toplam alacagi. Odeme gucu invariant'inin sol
    ///         tarafi; bakiyeyi asla asamaz.
    uint256 public totalOwed;

    /// @notice `recipient` adina ucret yatirir.
    /// @dev Protokol ve creator paylari AYRI AYRI yatirilir; escrow bir
    ///      bolusturme yapmaz. Ucret parcalardan toplanir (spec 5.5).
    /// @dev Sifir pay ile CAGIRMAYIN: revert eder (kisit 3). 1 wei gecerli ve
    ///      alacaga yazilabilir bir tutardir; alt sinir yoktur.
    function deposit(address recipient) external payable {
        if (recipient == address(0)) revert ZeroRecipient();
        if (msg.value == 0) revert ZeroAmount();

        owed[recipient] += msg.value;
        totalOwed += msg.value;

        emit Deposited(recipient, msg.sender, msg.value);
    }

    /// @notice `recipient`'in birikmis ucretini kendisine gonderir.
    /// @dev IZINSIZDIR: cagiran kim olursa olsun fon alicisina gider. Creator'in
    ///      gas'i olmasa bile ucreti kilitli kalmaz. Cagiran bundan kar edemez.
    function claim(address recipient) external {
        uint256 amount = owed[recipient];
        if (amount == 0) revert NothingToClaim();

        // CEI: once defter, sonra transfer.
        owed[recipient] = 0;
        totalOwed -= amount;

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Claimed(recipient, amount);
    }
}
