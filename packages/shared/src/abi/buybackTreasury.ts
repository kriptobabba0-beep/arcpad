/**
 * CONTRACT ABI -- THE ONE COPY.
 *
 * EMITTED from the `forge build` artifact `contracts/out/BuybackTreasury.sol/BuybackTreasury.json` with
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
export const buybackTreasuryAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'factory_',
        type: 'address',
      },
      {
        name: 'escrow_',
        type: 'address',
      },
      {
        name: 'vault_',
        type: 'address',
      },
      {
        name: 'poolManager_',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'receive',
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'MAX_PRICE_IMPACT_BPS',
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
    name: 'MIN_SWEEP_WEI',
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
    name: 'SWEEP_GRACE',
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
    name: 'accrue',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'cumulativeQuoteSpent',
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
    name: 'cumulativeTokensBought',
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
    name: 'escrow',
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
    name: 'lastSweepAt',
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
    name: 'pendingQuote',
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
    name: 'poolManager',
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
    name: 'spendable',
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
    name: 'sweep',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'minTokensOut',
        type: 'uint256',
      },
      {
        name: 'deadline',
        type: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'sweepIsPermissionless',
    inputs: [
      {
        name: 'token',
        type: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'unlockCallback',
    inputs: [
      {
        name: 'data',
        type: 'bytes',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'vault',
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
    type: 'event',
    name: 'BuybackAccrued',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'venue',
        type: 'address',
        indexed: true,
      },
      {
        name: 'quoteAmount',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'pending',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'BuybackExecuted',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'quoteSpent',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'tokensBought',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'BuybackSkipped',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'quoteReturnedToCreator',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'reason',
        type: 'string',
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
    name: 'BaseIsQuote',
    inputs: [],
  },
  {
    type: 'error',
    name: 'DeadlinePassed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FailedInnerCall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'MathOverflowedMulDiv',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotAccrualVenue',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotKeeper',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotPoolManager',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NothingPending',
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
    name: 'SlippageTooHigh',
    inputs: [
      {
        name: 'got',
        type: 'uint256',
      },
      {
        name: 'minTokensOut',
        type: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'UnexpectedPoolDelta',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroBase',
    inputs: [],
  },
] as const
