// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

contract LaunchTokenTest is Test {
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant CURVE = address(0xCC0E);
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function _deploy() internal returns (LaunchToken) {
        return new LaunchToken("Arc Test Coin", "ATC", "ipfs://cid", CREATOR, CURVE, SUPPLY);
    }

    function test_entireSupplyIsMintedToTheCurve() public {
        LaunchToken t = _deploy();
        assertEq(t.totalSupply(), SUPPLY);
        assertEq(t.balanceOf(CURVE), SUPPLY);
        assertEq(t.balanceOf(CREATOR), 0);
        assertEq(t.balanceOf(address(this)), 0);
    }

    function test_metadataIsReadableOnChain() public {
        LaunchToken t = _deploy();
        assertEq(t.name(), "Arc Test Coin");
        assertEq(t.symbol(), "ATC");
        assertEq(t.metadataURI(), "ipfs://cid");
        assertEq(t.creator(), CREATOR);
        assertEq(t.curve(), CURVE);
    }

    function test_decimalsAreEighteen() public {
        assertEq(_deploy().decimals(), 18);
    }

    /// Sonradan mint yolu olmamali: toplam arz sonsuza kadar sabit.
    /// Bu test, kontratin yuzeyinde `mint` adinda bir fonksiyon
    /// bulunmadigini derleme zamaninda degil, calisma zamaninda kanitlar.
    function test_noMintFunctionExists() public {
        LaunchToken t = _deploy();
        (bool ok,) = address(t).call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        assertFalse(ok, "a mint entrypoint exists");
        assertEq(t.totalSupply(), SUPPLY);
    }

    // --- metadata sinirlari (pump.fun ile ayni) ---

    function test_nameAtLimitIsAccepted() public {
        string memory n = "12345678901234567890123456789012"; // 32
        LaunchToken t = new LaunchToken(n, "ATC", "u", CREATOR, CURVE, SUPPLY);
        assertEq(t.name(), n);
    }

    function test_revertsWhenNameExceedsLimit() public {
        vm.expectRevert(LaunchToken.NameTooLong.selector);
        new LaunchToken("123456789012345678901234567890123", "ATC", "u", CREATOR, CURVE, SUPPLY); // 33
    }

    function test_symbolAtLimitIsAccepted() public {
        string memory s = "1234567890123"; // 13
        LaunchToken t = new LaunchToken("n", s, "u", CREATOR, CURVE, SUPPLY);
        assertEq(t.symbol(), s);
    }

    function test_revertsWhenSymbolExceedsLimit() public {
        vm.expectRevert(LaunchToken.SymbolTooLong.selector);
        new LaunchToken("n", "12345678901234", "u", CREATOR, CURVE, SUPPLY); // 14
    }

    function test_revertsWhenUriExceedsLimit() public {
        string memory long = new string(201);
        vm.expectRevert(LaunchToken.UriTooLong.selector);
        new LaunchToken("n", "s", long, CREATOR, CURVE, SUPPLY);
    }

    // --- sifir kontrolleri ---

    function test_revertsOnZeroCreator() public {
        vm.expectRevert(LaunchToken.ZeroCreator.selector);
        new LaunchToken("n", "s", "u", address(0), CURVE, SUPPLY);
    }

    function test_revertsOnZeroCurve() public {
        vm.expectRevert(LaunchToken.ZeroCurve.selector);
        new LaunchToken("n", "s", "u", CREATOR, address(0), SUPPLY);
    }

    function test_revertsOnZeroSupply() public {
        vm.expectRevert(LaunchToken.ZeroSupply.selector);
        new LaunchToken("n", "s", "u", CREATOR, CURVE, 0);
    }

    // --- transfer davranisi standart olmali ---

    function test_transfersBehaveLikeStandardErc20() public {
        LaunchToken t = _deploy();
        vm.prank(CURVE);
        t.transfer(address(this), 100e18);
        assertEq(t.balanceOf(address(this)), 100e18);
        assertEq(t.balanceOf(CURVE), SUPPLY - 100e18);
    }

    function testFuzz_totalSupplyIsInvariantUnderTransfers(uint256 amount) public {
        LaunchToken t = _deploy();
        amount = bound(amount, 0, SUPPLY);
        vm.prank(CURVE);
        t.transfer(address(this), amount);
        assertEq(t.totalSupply(), SUPPLY);
        assertEq(t.balanceOf(CURVE) + t.balanceOf(address(this)), SUPPLY);
    }
}
