// URETILMISTIR -- elle duzenlemeyin.
//   pnpm --filter @arcpad/indexer sync-pool-events
// Kaynak: contracts/out/PoolManager.sol/PoolManager.json,
//         contracts/out/ArcpadHook.sol/ArcpadHook.json
import type { AbiEvent } from 'viem'

/** `PoolManager`in `Swap` olayi, derlenmis ABI'den AYNEN. */
export const POOL_MANAGER_SWAP_EVENT = {
  type: 'event',
  name: 'Swap',
  inputs: [
    {
      name: 'id',
      type: 'bytes32',
      indexed: true,
    },
    {
      name: 'sender',
      type: 'address',
      indexed: true,
    },
    {
      name: 'amount0',
      type: 'int128',
      indexed: false,
    },
    {
      name: 'amount1',
      type: 'int128',
      indexed: false,
    },
    {
      name: 'sqrtPriceX96',
      type: 'uint160',
      indexed: false,
    },
    {
      name: 'liquidity',
      type: 'uint128',
      indexed: false,
    },
    {
      name: 'tick',
      type: 'int24',
      indexed: false,
    },
    {
      name: 'fee',
      type: 'uint24',
      indexed: false,
    },
  ],
  anonymous: false,
} as const satisfies AbiEvent

/** `PoolManager`in `Initialize` olayi, derlenmis ABI'den AYNEN. */
export const POOL_MANAGER_INITIALIZE_EVENT = {
  type: 'event',
  name: 'Initialize',
  inputs: [
    {
      name: 'id',
      type: 'bytes32',
      indexed: true,
    },
    {
      name: 'currency0',
      type: 'address',
      indexed: true,
    },
    {
      name: 'currency1',
      type: 'address',
      indexed: true,
    },
    {
      name: 'fee',
      type: 'uint24',
      indexed: false,
    },
    {
      name: 'tickSpacing',
      type: 'int24',
      indexed: false,
    },
    {
      name: 'hooks',
      type: 'address',
      indexed: false,
    },
    {
      name: 'sqrtPriceX96',
      type: 'uint160',
      indexed: false,
    },
    {
      name: 'tick',
      type: 'int24',
      indexed: false,
    },
  ],
  anonymous: false,
} as const satisfies AbiEvent

/** `ArcpadHook`in `SwapFeeCollected` olayi, derlenmis ABI'den AYNEN. */
export const ARCPAD_HOOK_SWAP_FEE_COLLECTED_EVENT = {
  type: 'event',
  name: 'SwapFeeCollected',
  inputs: [
    {
      name: 'id',
      type: 'bytes32',
      indexed: true,
    },
    {
      name: 'protocolFee',
      type: 'uint256',
      indexed: false,
    },
    {
      name: 'creatorFee',
      type: 'uint256',
      indexed: false,
    },
  ],
  anonymous: false,
} as const satisfies AbiEvent
