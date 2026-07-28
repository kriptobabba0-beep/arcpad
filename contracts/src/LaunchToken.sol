// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchToken
/// @notice arcpad uzerinde baslatilan sabit arzli token.
/// @dev Tum arz constructor'da TEK SEFERDE bonding curve adresine basilir.
///      Curve, satilabilir kismi kendi sayaciyla sinirlar; rezerve kalan ayni
///      bakiyede durur ve graduation'da havuza aktarilir. pump.fun'in yaptigi
///      da budur: token_total_supply'in tamami curve hesabina gider,
///      real_token_reserves yalnizca satilabilir kismi sinirlar.
/// @dev Sonradan mint yolu YOKTUR. Metadata token uzerinde durur, boylece
///      arayuz ve indexer zincirden okuyabilir ve bir backend'e bagimli olmaz.
contract LaunchToken is ERC20 {
    /// pump.fun ile ayni sinirlar.
    uint256 private constant MAX_NAME_LENGTH = 32;
    uint256 private constant MAX_SYMBOL_LENGTH = 13;
    uint256 private constant MAX_URI_LENGTH = 200;

    error NameTooLong();
    error SymbolTooLong();
    error UriTooLong();
    error ZeroCreator();
    error ZeroCurve();
    error ZeroSupply();

    /// @notice Ucretleri alacak creator. Launch'ta sabitlenir.
    address public immutable creator;

    /// @notice Arzin tamaminin basildigi bonding curve.
    address public immutable curve;

    /// @notice Logo ve aciklamayi tasiyan metadata isaretcisi (IPFS).
    string public metadataURI;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        address curve_,
        uint256 totalSupply_
    ) ERC20(name_, symbol_) {
        if (bytes(name_).length > MAX_NAME_LENGTH) revert NameTooLong();
        if (bytes(symbol_).length > MAX_SYMBOL_LENGTH) revert SymbolTooLong();
        if (bytes(metadataURI_).length > MAX_URI_LENGTH) revert UriTooLong();
        if (creator_ == address(0)) revert ZeroCreator();
        if (curve_ == address(0)) revert ZeroCurve();
        if (totalSupply_ == 0) revert ZeroSupply();

        creator = creator_;
        curve = curve_;
        metadataURI = metadataURI_;

        _mint(curve_, totalSupply_);
    }
}
