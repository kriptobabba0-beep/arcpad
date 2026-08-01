/**
 * CONTRACT ABI -- THE ONE COPY.
 *
 * EMITTED from the `forge build` artifact `contracts/out/CurveMath.sol/CurveMath.json` with
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
 *
 * ERROR ENTRIES ONLY: a library has no dispatchable functions, but its
 * errors bubble through every contract that links it, so the decoder needs
 * them and nothing else.
 */
export const curveMathErrorsAbi = [
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
    name: 'ZeroAmount',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroReserve',
    inputs: [],
  },
] as const
