/**
 * CONTRACT ABI -- THE ONE COPY.
 *
 * EMITTED from the `forge build` artifact `contracts/out/LaunchFactory.sol/LaunchFactory.json` with
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
export const launchFactoryAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'escrow_',
        type: 'address',
      },
      {
        name: 'protocolTreasury_',
        type: 'address',
      },
      {
        name: 'governor_',
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
      {
        name: 'feeSchedule_',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'GRADUATION_TARGET_DELAY',
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
    name: 'MIN_GRADUATION_RAISE',
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
    name: 'MIN_OPENING_MARKET_CAP',
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
    name: 'MIN_SALE_AND_SEED',
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
    name: 'SALE_SUPPLY',
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
    name: 'VIRTUAL_QUOTE_RESERVES',
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
    name: 'VIRTUAL_TOKEN_RESERVES',
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
    name: 'applyGraduationTarget',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
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
    name: 'feeSchedule',
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
    name: 'feeScheduleOf',
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
    name: 'governor',
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
    name: 'graduationTarget',
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
    name: 'isCanonical',
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
    name: 'launch',
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
        name: 'uri_',
        type: 'string',
      },
    ],
    outputs: [
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'curve',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'launchCount',
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
    name: 'pendingGraduationTarget',
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
    name: 'pendingGraduationTargetEta',
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
    name: 'predictAddresses',
    inputs: [
      {
        name: 'creator_',
        type: 'address',
      },
      {
        name: 'name_',
        type: 'string',
      },
      {
        name: 'symbol_',
        type: 'string',
      },
      {
        name: 'uri_',
        type: 'string',
      },
      {
        name: 'nonce',
        type: 'uint256',
      },
    ],
    outputs: [
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'curve',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'proposeGraduationTarget',
    inputs: [
      {
        name: 'target_',
        type: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
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
    name: 'setProtocolTreasury',
    inputs: [
      {
        name: 'protocolTreasury_',
        type: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'FeeScheduleAssigned',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'schedule',
        type: 'address',
        indexed: true,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'GraduationTargetChanged',
    inputs: [
      {
        name: 'previous',
        type: 'address',
        indexed: true,
      },
      {
        name: 'current',
        type: 'address',
        indexed: true,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'GraduationTargetProposed',
    inputs: [
      {
        name: 'target',
        type: 'address',
        indexed: true,
      },
      {
        name: 'eta',
        type: 'uint256',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Launched',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
      },
      {
        name: 'curve',
        type: 'address',
        indexed: true,
      },
      {
        name: 'creator',
        type: 'address',
        indexed: true,
      },
      {
        name: 'name',
        type: 'string',
        indexed: false,
      },
      {
        name: 'symbol',
        type: 'string',
        indexed: false,
      },
      {
        name: 'uri',
        type: 'string',
        indexed: false,
      },
      {
        name: 'salt',
        type: 'bytes32',
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ProtocolTreasuryChanged',
    inputs: [
      {
        name: 'previous',
        type: 'address',
        indexed: true,
      },
      {
        name: 'current',
        type: 'address',
        indexed: true,
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'DegenerateProfile',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EmptyName',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EmptySymbol',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EscrowHasNoCode',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EscrowIsNotAFeeEscrow',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FeeScheduleHasNoCode',
    inputs: [],
  },
  {
    type: 'error',
    name: 'GovernorIsTheEscrow',
    inputs: [],
  },
  {
    type: 'error',
    name: 'GraduationRaiseTooSmall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'GraduationTargetDelayNotElapsed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'GraduationTargetProposalExpired',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InsufficientTokenReserve',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NoPendingGraduationTarget',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotGovernor',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ProfileNotSeedable',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SaleAndSeedExceedSupply',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SaleAndSeedStrandSupply',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TreasuryIsTheEscrow',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroEscrowAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroFeeSchedule',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroGovernorAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroGraduationTarget',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroReserve',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroTreasuryAddress',
    inputs: [],
  },
] as const
