// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "uniswap-hooks/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @dev Faz 2'de yazilacak ArcpadHook'un izin kumesi. Havuzun bize ait
///      oldugunu dogrulamak icin beforeInitialize; girdiden ucret kesmek
///      icin beforeSwap + beforeSwapReturnDelta. Deploy script'i CREATE2
///      salt'ini bu uc bayragi tasiyan bir adres bulana kadar arayacak.
library ArcpadHookPermissions {
    function permissions() internal pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}

/// @dev V4 bagimlilik kablolamasinin dogrulugunu kanitlayan fixture. Bu
///      kontrat deploy EDILMEZ: BaseHook'un constructor'i adresin izin
///      bitlerini dogrular, yani deploy etmek adres madenciligi gerektirir
///      ve o is Faz 2'ye aittir. Burada yalnizca derlendigini kanitliyoruz.
contract HookWiringMock is BaseHook {
    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return ArcpadHookPermissions.permissions();
    }
}
