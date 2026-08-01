/**
 * The five `LaunchFactory` getters this track needs, and only those.
 *
 * A full ABI is not vendored here on purpose: the preflight and the curve
 * profile read immutables, and a hand-narrowed fragment cannot drift into
 * "the ABI we shipped" for anything else. When a generated ABI package
 * exists, this file is deleted rather than extended.
 */
export const LAUNCH_FACTORY_ABI = [
  {
    type: 'function',
    name: 'escrow',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'governor',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'VIRTUAL_TOKEN_RESERVES',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'VIRTUAL_QUOTE_RESERVES',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'SALE_SUPPLY',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const
