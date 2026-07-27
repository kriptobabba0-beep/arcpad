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

    function test_arcpadPermissionSetIsWhatPhase2Expects() public pure {
        Hooks.Permissions memory permissions = ArcpadHookPermissions.permissions();
        assertTrue(permissions.beforeInitialize);
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.beforeSwapReturnDelta);
        assertFalse(permissions.afterSwap);
        assertFalse(permissions.beforeAddLiquidity);
        assertFalse(permissions.beforeRemoveLiquidity);
    }

    /// BaseHook'u genisleten bir kontratin derlendigini kanitlar. Deploy
    /// etmeyiz: BaseHook constructor'i adres bitlerini dogrular.
    function test_baseHookWiringCompiles() public pure {
        assertGt(type(HookWiringMock).creationCode.length, 0, "BaseHook wiring failed to compile");
    }
}
