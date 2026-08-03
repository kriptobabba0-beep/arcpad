// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {ArcpadHookPermissions, HookWiringMock} from "./mocks/HookWiringMock.sol";

contract V4WiringTest is Test {
    /// V4'te hook adresinin alt bitleri izinleri kodlar. Faz 2'deki deploy
    /// script'i CREATE2 salt'ini bu uc bayragin hepsini tasiyan bir adres
    /// bulana kadar arayacak; bayrak degerleri bu yuzden sabitlenmistir.
    function test_hookPermissionFlagValues() public pure {
        assertEq(Hooks.BEFORE_INITIALIZE_FLAG, 1 << 13);
        assertEq(Hooks.BEFORE_SWAP_FLAG, 1 << 7);
        assertEq(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG, 1 << 3);
    }

    /// @dev `afterSwap` ARTIK TRUE. Faz 1d `assertFalse` yaziyordu; Faz 2
    ///      olctu ve degistirdi. Sabitlenmis bir degeri "testi gecirmek icin"
    ///      degistirmek yasaktir -- bu bir BULGUDUR: quote cinsinden ucret
    ///      dort swap seklinin IKISINDE `afterSwap` gerektirir, cunku o iki
    ///      sekilde quote miktari swap'ten ONCE bilinmez. Tam turetme
    ///      `HookWiringMock.sol`un NatSpec'inde, olcumu
    ///      `ArcpadHook.t.sol`un dort-sekil testlerinde.
    function test_arcpadPermissionSetIsWhatPhase2Expects() public pure {
        Hooks.Permissions memory permissions = ArcpadHookPermissions.permissions();
        assertTrue(permissions.beforeInitialize);
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.beforeSwapReturnDelta);
        assertTrue(permissions.afterSwap);
        assertTrue(permissions.afterSwapReturnDelta);
        assertFalse(permissions.beforeAddLiquidity);
        assertFalse(permissions.beforeRemoveLiquidity);
    }

    /// @dev BAYRAK KUMESI TEK BIR SAYIYA PINLENIR: 0x20CC. Bir bayrak eklemek
    ///      ya da cikarmak hook ADRESINI degistirir, yani her `PoolKey`i.
    function test_theArcpadFlagWordIs0x20CC() public pure {
        assertEq(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG,
            0x20CC
        );
        assertEq(Hooks.AFTER_SWAP_FLAG, 1 << 6);
        assertEq(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG, 1 << 2);
    }

    /// BaseHook'u genisleten bir kontratin derlendigini kanitlar. Deploy
    /// etmeyiz: BaseHook constructor'i adres bitlerini dogrular.
    function test_baseHookWiringCompiles() public pure {
        assertGt(type(HookWiringMock).creationCode.length, 0, "BaseHook wiring failed to compile");
    }
}
