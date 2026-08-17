/**
 * CONTRACT ABI -- THE ONE COPY.
 *
 * EMITTED from the `forge build` artifact `contracts/out/BondingCurve.sol/BondingCurve.json` with
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
export const bondingCurveAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'creator_',
        type: 'address',
      },
      {
        name: 'escrow_',
        type: 'address',
      },
      {
        name: 'virtualTokenReserves_',
        type: 'uint256',
      },
      {
        name: 'virtualQuoteReserves_',
        type: 'uint256',
      },
      {
        name: 'saleSupply_',
        type: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'CREATOR_FEE_BPS',
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
    name: 'INITIAL_REAL_TOKEN_RESERVES',
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
    name: 'INITIAL_VIRTUAL_QUOTE_RESERVES',
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
    name: 'INITIAL_VIRTUAL_TOKEN_RESERVES',
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
    name: 'PROTOCOL_FEE_BPS',
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
    name: 'bind',
    inputs: [
      {
        name: 'token_',
        type: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'buyExactQuoteIn',
    inputs: [
      {
        name: 'minTokensOut',
        type: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'buyExactTokensOut',
    inputs: [
      {
        name: 'tokensOut',
        type: 'uint256',
      },
      {
        name: 'maxQuoteIn',
        type: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'complete',
    inputs: [],
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
    name: 'graduate',
    inputs: [],
    outputs: [
      {
        name: 'baseAmount',
        type: 'uint256',
      },
      {
        name: 'quoteAmount',
        type: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'graduated',
    inputs: [],
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
    name: 'poolSeedSupply',
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
    name: 'protocolTreasury',
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
    name: 'realQuoteReserves',
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
    name: 'realTokenReserves',
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
    name: 'sellExactTokensIn',
    inputs: [
      {
        name: 'tokensIn',
        type: 'uint256',
      },
      {
        name: 'minQuoteOut',
        type: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'token',
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
    name: 'virtualQuoteReserves',
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
    name: 'virtualTokenReserves',
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
    name: 'Completed',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'realQuoteReserves',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'poolSeedSupply',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Graduated',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
      },
      {
        name: 'baseAmount',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'quoteAmount',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Trade',
    inputs: [
      {
        name: 'trader',
        type: 'address',
        indexed: true,
      },
      {
        name: 'isBuy',
        type: 'bool',
        indexed: false,
      },
      {
        name: 'tokenAmount',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'quoteAmount',
        type: 'uint256',
        indexed: false,
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
      {
        name: 'virtualTokenReserves',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'virtualQuoteReserves',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'realTokenReserves',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'realQuoteReserves',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'AlreadyBound',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AlreadyGraduated',
    inputs: [],
  },
  {
    type: 'error',
    name: 'CurveComplete',
    inputs: [],
  },
  {
    type: 'error',
    name: 'GraduationPayoutFailed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'GraduationTargetUnset',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InsufficientTokenReserve',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidBps',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NetTooSmall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotBound',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotComplete',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotEnoughTokensToBuy',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotFactory',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotGraduationTarget',
    inputs: [],
  },
  {
    type: 'error',
    name: 'PayoutFailed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ProceedsTooSmall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'RefundFailed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SaleSupplyNotBelowTokenReserves',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SlippageExceeded',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TokenBalanceBelowSaleAndSeed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TokenDoesNotPointBack',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TokenTransferFailed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroAmount',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroEscrow',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroQuoteIn',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroReserve',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroSaleSupply',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroToken',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroTokensIn',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroTokensOut',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroVirtualQuoteReserves',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroVirtualTokenReserves',
    inputs: [],
  },
] as const
