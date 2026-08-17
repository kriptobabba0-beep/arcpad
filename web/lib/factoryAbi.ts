/**
 * The six `LaunchFactory` getters this track needs, and only those.
 *
 * A full ABI is not vendored here on purpose: the preflight and the curve
 * profile read immutables, and a hand-narrowed fragment cannot drift into
 * "the ABI we shipped" for anything else. When a generated ABI package
 * exists, this file is deleted rather than extended.
 *
 * `graduationTarget` IS THE ODD ONE OUT AND THE COMMENT IS FOR IT. Every other
 * entry here reads an `immutable`; this one reads governance state that can
 * change under a live deployment. It is here because the create page's
 * liquidity line used to be a fixed sentence -- "the pool and its permanent
 * lock ship in a later phase" -- written when that was true, and a fixed
 * sentence about mutable state is a lie with a start date.
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
  {
    type: 'function',
    name: 'graduationTarget',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
] as const
