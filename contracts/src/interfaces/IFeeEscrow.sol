// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IFeeEscrow
/// @notice `FeeEscrow`'un ucret YATIRMA yuzeyi.
/// @dev BILEREK DAR. Yalnizca `BondingCurve`'un cagirdigi fonksiyonu tasir;
///      `claim` burada yoktur cunku curve onu hic cagirmaz ve kullanilmayan
///      bir bildirim, degistiginde hicbir seyi kirmayan sahte bir sozlesme
///      olurdu.
/// @dev AYRI BIR DOSYADA OLMASININ SEBEBI DERLEME ZAMANI KONTROLUDUR.
///      Onceki hali `BondingCurve.sol` icinde yerel bir `interface`
///      bildirimiydi ve `FeeEscrow` ona karsi HIC kontrol edilmiyordu: iki
///      taraf birbirinden sessizce ayrisabilirdi. `FeeEscrow`'un bunu
///      `is IFeeEscrow` ile uygulamasi, imza degisikligini derleme hatasina
///      cevirir. (Ayrisma bugun fail-closed'dir -- escrow'un `fallback`'i
///      olmadigi icin sapmis bir selector ucreti kaybetmez, ticareti
///      durdurur -- ama sessiz kalmasi icin bir sebep yoktur.)
interface IFeeEscrow {
    /// @notice `recipient` adina ucret yatirir.
    /// @dev Sifir tutarda `ZeroAmount()`, sifir alicida `ZeroRecipient()` ile
    ///      revert eder; sifir paylari atlamak CAGIRANIN yukumlulugudur.
    function deposit(address recipient) external payable;
}
