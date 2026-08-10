import { loadAddressBook, PROFILE_DIGESTS, readProfiles } from '@arcpad/shared'
import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared/browser'
import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  CurveProfileError,
  identifyProfile,
  multicallCurveProfileReader,
  readCurveProfile,
} from '../lib/profile'

const PROFILES = readProfiles()
const BOOK = loadAddressBook(ARC_TESTNET_CHAIN_ID)
const FACTORY = BOOK.launchFactory as Address

describe('identifying the curve profile', () => {
  it('recognises both reviewed profiles', () => {
    expect(identifyProfile(PROFILES.testnet)).toBe('testnet')
    expect(identifyProfile(PROFILES.production)).toBe('production')
  })

  // The whole reason the profile is read from the chain: testnet and
  // production differ ONLY in V, by exactly 1000x, and V is the denominator of
  // every price the site prints.
  it('the two profiles differ only in V, by exactly 1000x', () => {
    expect(PROFILES.production.virtualTokenReserves).toBe(PROFILES.testnet.virtualTokenReserves)
    expect(PROFILES.production.saleSupply).toBe(PROFILES.testnet.saleSupply)
    expect(PROFILES.production.virtualQuoteReserves).toBe(
      PROFILES.testnet.virtualQuoteReserves * 1000n,
    )
  })

  it('refuses a triple that matches no reviewed digest, however plausible', () => {
    expect(() =>
      identifyProfile({
        ...PROFILES.testnet,
        virtualQuoteReserves: PROFILES.testnet.virtualQuoteReserves + 1n,
      }),
    ).toThrow(CurveProfileError)
  })

  it('names both reviewed profiles when it refuses', () => {
    try {
      identifyProfile({ virtualTokenReserves: 1n, virtualQuoteReserves: 2n, saleSupply: 3n })
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(CurveProfileError)
      const message = (error as Error).message
      for (const name of Object.keys(PROFILE_DIGESTS)) expect(message).toContain(name)
    }
  })
})

describe('reading the profile from the factory', () => {
  const UNSET = '0x0000000000000000000000000000000000000000'
  const LOCKER = '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8'

  it('returns the identified profile and the graduation target from ONE multicall', async () => {
    const calls: unknown[][] = []
    const reader = multicallCurveProfileReader({
      async multicall(args) {
        calls.push(args.contracts as unknown[])
        return [
          PROFILES.testnet.virtualTokenReserves,
          PROFILES.testnet.virtualQuoteReserves,
          PROFILES.testnet.saleSupply,
          UNSET,
        ]
      },
    })
    const result = await readCurveProfile(reader, FACTORY)
    expect(result.name).toBe('testnet')
    expect(result.profile).toEqual(PROFILES.testnet)
    expect(result.graduationTarget).toBe(UNSET)
    // ONE round trip. Arc rate-limits sequential eth_calls as well as
    // concurrent ones, so four separate reads is four chances to be throttled.
    // The target rides along with the three immutables rather than earning a
    // second trip: `getCurveProfile` is per-request cached, which is exactly
    // the lifetime a mutable read may share with immutable ones.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(4)
  })

  it('carries an ARMED target through unchanged', async () => {
    const reader = multicallCurveProfileReader({
      async multicall() {
        return [
          PROFILES.testnet.virtualTokenReserves,
          PROFILES.testnet.virtualQuoteReserves,
          PROFILES.testnet.saleSupply,
          LOCKER,
        ]
      },
    })
    expect((await readCurveProfile(reader, FACTORY)).graduationTarget).toBe(LOCKER)
  })

  it('refuses a factory whose immutables do not decode as three uint256s', async () => {
    const reader = multicallCurveProfileReader({
      async multicall() {
        return ['0x', 1n, 2n, UNSET]
      },
    })
    await expect(readCurveProfile(reader, FACTORY)).rejects.toThrow(CurveProfileError)
  })

  /*
   * A TARGET THAT DOES NOT DECODE IS NOT "UNSET", and the difference is the
   * whole point of reading it. `/create` states the liquidity guarantee from
   * this value; defaulting an undecodable answer to the zero address would
   * print "graduation is not armed on this deployment" for a factory that
   * never said so -- a specific, confident claim derived from nothing.
   */
  it.each([
    ['missing entirely', undefined],
    ['a number', 42n],
    ['a truncated address', '0xdeadbeef'],
    ['an address with a bad character', '0xzzzz771091a3471Dc12CbfE38836BaDC7bf5a98E8'],
  ])('refuses a graduationTarget that is %s rather than calling it unset', async (_l, bad) => {
    const reader = multicallCurveProfileReader({
      async multicall() {
        return [
          PROFILES.testnet.virtualTokenReserves,
          PROFILES.testnet.virtualQuoteReserves,
          PROFILES.testnet.saleSupply,
          bad,
        ]
      },
    })
    await expect(readCurveProfile(reader, FACTORY)).rejects.toThrow(CurveProfileError)
  })

  // If the chain answered with the production economy on a testnet
  // deployment, every market cap on the site would be off by 1000x and every
  // other invariant would still balance.
  it('reports production when that is what the chain says, rather than assuming', async () => {
    const reader = multicallCurveProfileReader({
      async multicall() {
        return [
          PROFILES.production.virtualTokenReserves,
          PROFILES.production.virtualQuoteReserves,
          PROFILES.production.saleSupply,
          '0x0000000000000000000000000000000000000000',
        ]
      },
    })
    expect((await readCurveProfile(reader, FACTORY)).name).toBe('production')
  })

  it('the committed book agrees with the profile it names', () => {
    expect(BOOK.virtualQuoteReserves).toBe(PROFILES[BOOK.profile].virtualQuoteReserves)
    expect(identifyProfile(PROFILES[BOOK.profile])).toBe(BOOK.profile)
  })
})
