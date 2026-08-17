/**
 * CONTRACT ABI -- THE ONE COPY.
 *
 * EMITTED from the `forge build` artifact `contracts/out/FeeEscrow.sol/FeeEscrow.json` with
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
export const feeEscrowAbi = [
  {
    type: 'function',
    name: 'claim',
    inputs: [
      {
        name: 'recipient',
        type: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      {
        name: 'recipient',
        type: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'owed',
    inputs: [
      {
        name: '',
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
    name: 'totalOwed',
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
    type: 'event',
    name: 'Claimed',
    inputs: [
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
      },
      {
        name: 'from',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'NothingToClaim',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferFailed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroAmount',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroRecipient',
    inputs: [],
  },
] as const
