// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "uniswap-hooks/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @dev `ArcpadHook`in izin kumesi: `0x20CC`.
///
/// @dev FAZ 1D BURAYA `0x2088` YAZIYORDU (`beforeInitialize` + `beforeSwap` +
///      `beforeSwapReturnDelta`) VE O KUME YETERSIZDI. Bu bir "testi gecirmek
///      icin" degisiklik DEGIL, olculmus bir BULGUDUR ve turetmesi sudur:
///
///      Spec §5.5 ucretin HER ZAMAN pairing asset'te (USDC) alinmasini ister.
///      V4'te `beforeSwap` yalnizca SPECIFIED para birimini bilir, ve
///      specified taraf `(exactInput == zeroForOne)` iken `currency0`dir.
///      Dort swap sekli boylece IKIYE ayrilir:
///        quote SPECIFIED   -> miktar swap'ten ONCE bilinir -> `beforeSwap`
///        quote UNSPECIFIED -> miktar ancak SONRA bilinir   -> `afterSwap`
///      Ikinci grup icin miktari uretebilecek TEK yer `afterSwap`tir; delta
///      orada vardir. `0x2088` ile kalmak, dort seklin IKISINDE ucreti LAUNCH
///      TOKENINDA tahsil etmek demekti -- spec'in "asla launch tokeninda"
///      cumlesinin dogrudan ihlali.
///
///      TURETME CALISTIRILARAK DOGRULANDI: `ArcpadHook.t.sol` dort seklin
///      dordunu de gercek bir `PoolManager`a karsi kosar ve dordunde de
///      ucretin USDC cinsinden geldigini, hook'un token bakiyesinin SIFIR
///      kaldigini olcer.
///
///      DEGISIKLIGIN GERI DONUSU YOKTUR: bayrak eklemek hook'un ADRESINI,
///      dolayisiyla her `PoolKey`i ve her `PoolId`yi degistirir. Ilk
///      graduation'dan sonra yapilamaz -- zamanlamasi bu yuzden baglayicidir.
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
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
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
