// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/// @dev Uniswap V4 transient storage olmadan derlenmez. Bu test, derleyici
///      ve evm_version yapilandirmasinin EIP-1153'u gercekten destekledigini
///      kanitlar -- protokol kodu yazilmadan once.
contract ToolchainTest is Test {
    function test_transientStorageRoundTrip() public {
        uint256 readBack;
        assembly {
            tstore(0x42, 1153)
            readBack := tload(0x42)
        }
        assertEq(readBack, 1153, "EIP-1153 transient storage unavailable");
    }

    function test_mcopyIsAvailable() public pure {
        bytes memory source = hex"deadbeef";
        bytes memory destination = new bytes(4);
        assembly {
            mcopy(add(destination, 0x20), add(source, 0x20), 4)
        }
        assertEq(destination, hex"deadbeef", "EIP-5656 MCOPY unavailable");
    }
}
