/**
 * CONTRACT ABI -- THE ONE COPY.
 *
 * EMITTED from the `forge build` artifact `contracts/out/BuybackVestingVault.sol/BuybackVestingVault.json` with
 * `internalType` dropped and the entries sorted by (type, name, input types).
 * It is committed rather than generated at build time so that `web` builds on
 * a machine with no Solidity toolchain, and `test/abi-parity.test.ts` compares
 * it back against that artifact IN BOTH DIRECTIONS -- a missing entry and an
 * EXTRA entry are both failures.
 *
 * WHY THIS CONTRACT IS DISTRIBUTED. The indexer derives its event `topic0`
 * values from these ABIs (`indexer/src/arc.ts::EVENT_SIGNATURES`, re-derived
 * and compared in `topics.test.ts`), so a buyback event cannot be indexed
 * until its signature has a committed, gate-checked source. Hand-writing the
 * signature string instead would reintroduce exactly the class the parity
 * gate exists to close: a typo that compiles, runs, and silently matches no
 * log on chain.
 *
 * `as const` is REQUIRED: viem infers its return types from it, and widening
 * to `Abi` drops every `useReadContract` result to `unknown`.
 *
 * DO NOT hand-edit. Re-emit and let the parity test judge the result.
 */
export const buybackVestingVaultAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'factory_',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'PROTOCOL_VEST_BPS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint16',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'VESTING_DURATION',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'creatorBeneficiary',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'factory',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'lock',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
      },
      {
        name: 'creatorRecipient',
        type: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'locked',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'protocolBeneficiary',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'releasable',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'release',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: 'released',
        type: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'totalLocked',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalReleased',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'vestOf',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'totalLocked',
            type: 'uint256',
          },
          {
            name: 'totalReleased',
            type: 'uint256',
          },
          {
            name: 'vestedUnreleased',
            type: 'uint256',
          },
          {
            name: 'unvestedAmount',
            type: 'uint256',
          },
          {
            name: 'lastUpdate',
            type: 'uint256',
          },
          {
            name: 'vestingEnd',
            type: 'uint256',
          },
          {
            name: 'vestingStart',
            type: 'uint256',
          },
          {
            name: 'creatorRecipient',
            type: 'address',
          },
          {
            name: 'protocolVestBps',
            type: 'uint16',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'vestedAmount',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'vestingEnd',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'vestingStart',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'BuybackLocked',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'tokenAmount',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'vestingStart',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'vestingEnd',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'totalLocked',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'VestingReleased',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'caller',
        type: 'address',
        indexed: true,
      },
      {
        name: 'creatorAmount',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'protocolAmount',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'AddressEmptyCode',
    inputs: [
      {
        name: 'target',
        type: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'AddressInsufficientBalance',
    inputs: [
      {
        name: 'account',
        type: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'FailedInnerCall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotBeneficiary',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotBuybackTreasury',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NothingToRelease',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SafeERC20FailedOperation',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'VestNotOpen',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroAddress',
    inputs: [],
  },
] as const
