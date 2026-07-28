// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title FeeEscrow
/// @notice Ucretlerin biriktigi ve CEKILDIGI defter. Hicbir ucret push
///         edilmez.
/// @dev Pull-based olmasi bir tercih degil zorunluluktur: Arc'ta sozlesmelere
///      native gonderimin basarili olacagi garanti degildir. Push-based bir
///      tasarimda native kabul etmeyen tek bir alici, ayni islemdeki diger
///      herkesin ucretini kilitlerdi.
/// @dev Bu fazda tek varlik native USDC'dir. Ozel pairing asset destegi
///      kapsam disidir (spec 2).
contract FeeEscrow {
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
