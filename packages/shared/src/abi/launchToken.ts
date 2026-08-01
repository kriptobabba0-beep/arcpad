/**
 * CONTRACT ABI -- THE ONE COPY.
 *
 * EMITTED from the `forge build` artifact `contracts/out/LaunchToken.sol/LaunchToken.json` with
 * `internalType` dropped and the entries sorted by (type, name, input
 * types). It is committed rather than generated at build time so that `web`
 * builds on a machine with no Solidity toolchain, and
 * `test/abi-parity.test.ts` compares it back against that artifact IN BOTH
 * DIRECTIONS -- a missing entry and an EXTRA entry are both failures.
 *
 * `stateMutability`, `outputs` and `indexed` are all compared. Faz 1c
 * measured that `claim(address) external -> external payable` and dropping
 * `indexed` from `Trade.trader` each left 245/245 green under a name-set
 * comparison; the second one silently empties every indexer filter.
 *
 * `as const` is REQUIRED: viem infers its return types from it, and widening
 * to `Abi` drops every `useReadContract` result to `unknown`.
 *
 * DO NOT hand-edit. Re-emit and let the parity test judge the result.
 */
export const launchTokenAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'name_',
        type: 'string',
      },
      {
        name: 'symbol_',
        type: 'string',
      },
      {
        name: 'metadataURI_',
        type: 'string',
      },
      {
        name: 'creator_',
        type: 'address',
      },
      {
        name: 'curve_',
        type: 'address',
      },
      {
        name: 'launchSalt_',
        type: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'TOTAL_SUPPLY',
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
    name: 'allowance',
    inputs: [
      {
        name: 'owner',
        type: 'address',
      },
      {
        name: 'spender',
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
    name: 'approve',
    inputs: [
      {
        name: 'spender',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [
      {
        name: 'account',
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
    name: 'creator',
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
    name: 'curve',
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
    name: 'decimals',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint8',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'launchSalt',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'metadataURI',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'name',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalSupply',
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
    name: 'transfer',
    inputs: [
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transferFrom',
    inputs: [
      {
        name: 'from',
        type: 'address',
      },
      {
        name: 'to',
        type: 'address',
      },
      {
        name: 'value',
        type: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        indexed: true,
      },
      {
        name: 'spender',
        type: 'address',
        indexed: true,
      },
      {
        name: 'value',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      {
        name: 'from',
        type: 'address',
        indexed: true,
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
      },
      {
        name: 'value',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      {
        name: 'spender',
        type: 'address',
      },
      {
        name: 'allowance',
        type: 'uint256',
      },
      {
        name: 'needed',
        type: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      {
        name: 'sender',
        type: 'address',
      },
      {
        name: 'balance',
        type: 'uint256',
      },
      {
        name: 'needed',
        type: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InvalidApprover',
    inputs: [
      {
        name: 'approver',
        type: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InvalidReceiver',
    inputs: [
      {
        name: 'receiver',
        type: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InvalidSender',
    inputs: [
      {
        name: 'sender',
        type: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InvalidSpender',
    inputs: [
      {
        name: 'spender',
        type: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'NameTooLong',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SymbolTooLong',
    inputs: [],
  },
  {
    type: 'error',
    name: 'UriTooLong',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroCreator',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroCurve',
    inputs: [],
  },
] as const
