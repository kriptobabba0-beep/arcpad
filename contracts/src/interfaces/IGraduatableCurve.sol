// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IGraduatableCurve
/// @notice `BondingCurve`'un graduation hedefinin GORDUGU yuzeyi.
///
/// @dev BILEREK DAR, ve `IFeeEscrow`in kuraliyla ayni kural: yalnizca
///      `ArcpadLocker`in FIILEN cagirdigi uyeler burada durur. Kullanilmayan
///      bir bildirim, degistiginde hicbir seyi kirmayan sahte bir
///      sozlesmedir.
///
/// @dev `BondingCurve` BU ARAYUZU `is` ILE UYGULAMAZ ve UYGULAYAMAZ: curve
///      Faz 1d'de deploy edilmis, bytecode'u DONDURULMUS bir kontrattir
///      (`8e2460ff...`) ve `is IGraduatableCurve` eklemek o hash'i
///      hareket ettirirdi. Dolayisiyla `IFeeEscrow`in derleme-zamani
///      kontrolu BURADA YOKTUR ve olamaz.
///
///      YERINE GECEN KONTROL BIR TESTTIR, ve o test bu dosyanin varlik
///      sebebidir: `ArcpadLocker.t.sol` her uyenin selector'unu
///      `BondingCurve`in ABI'sindekiyle karsilastirir. Ayrisma boylece
///      derleme hatasi degil ama TEST hatasi olur -- sessiz kalmaz.
interface IGraduatableCurve {
    /// @notice Curve'u mezun eder ve `(poolSeedSupply, realQuoteReserves)`
    ///         doner. YALNIZCA `graduationTarget` cagirabilir.
    /// @dev Sanal rezervleri MUTASYONA UGRATMAZ -- havuzun acilis fiyati
    ///      bu cagridan SONRA da `virtualQuoteReserves`/`virtualTokenReserves`
    ///      uzerinden okunabilir. Locker tam olarak buna dayanir.
    function graduate() external returns (uint256 baseAmount, uint256 quoteAmount);

    function token() external view returns (address);
    function virtualQuoteReserves() external view returns (uint256);
    function virtualTokenReserves() external view returns (uint256);
    function poolSeedSupply() external view returns (uint256);
    function complete() external view returns (bool);
    function graduated() external view returns (bool);
}
