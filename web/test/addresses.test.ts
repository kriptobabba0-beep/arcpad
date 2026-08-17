import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared/browser'
import { describe, expect, it } from 'vitest'
import { readWebConfig, type WebEnv, WebConfigError, type WebEnvKey } from '../lib/addresses'

const FACTORY = '0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439'
const ESCROW = '0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6'

function goodEnv(): WebEnv {
  return {
    NEXT_PUBLIC_ARC_CHAIN_ID: String(ARC_TESTNET_CHAIN_ID),
    NEXT_PUBLIC_ARCPAD_FACTORY: FACTORY,
    NEXT_PUBLIC_ARCPAD_ESCROW: ESCROW,
  }
}

function expectConfigError(fn: () => unknown, key: WebEnvKey, kind: 'unset' | 'invalid') {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WebConfigError)
    expect((error as WebConfigError).key).toBe(key)
    expect((error as WebConfigError).kind).toBe(kind)
    return error as WebConfigError
  }
  throw new Error(`expected a WebConfigError(${key}, ${kind}), but nothing was thrown`)
}

describe('readWebConfig', () => {
  it('resolves the chain through the registry', () => {
    const config = readWebConfig(goodEnv())
    expect(config.chain.id).toBe(ARC_TESTNET_CHAIN_ID)
    expect(config.chain.nativeCurrency.decimals).toBe(18)
    expect(config.addresses.launchFactory).toBe(FACTORY)
    expect(config.addresses.feeEscrow).toBe(ESCROW)
  })

  it('defaults the RPC URL to the registry entry rather than demanding a copy', () => {
    const config = readWebConfig(goodEnv())
    expect(config.rpcUrl).toBe(config.chain.rpcUrls.default.http[0])
  })

  it('accepts an explicit RPC override', () => {
    const config = readWebConfig({ ...goodEnv(), NEXT_PUBLIC_ARC_RPC_URL: 'https://rpc.internal' })
    expect(config.rpcUrl).toBe('https://rpc.internal')
  })

  // BLANK IS "NOT CONFIGURED", NOT "WRONG". `.env.example` ships these blank
  // on purpose, so `cp .env.example .env` lands exactly here -- and the
  // preflight turns this kind into exit 2, not exit 1.
  it('treats a blank or whitespace value as unset, per variable', () => {
    for (const key of [
      'NEXT_PUBLIC_ARC_CHAIN_ID',
      'NEXT_PUBLIC_ARCPAD_FACTORY',
      'NEXT_PUBLIC_ARCPAD_ESCROW',
    ] as const) {
      for (const blank of ['', '   ']) {
        expectConfigError(() => readWebConfig({ ...goodEnv(), [key]: blank }), key, 'unset')
      }
      const without = goodEnv()
      delete without[key]
      expectConfigError(() => readWebConfig(without), key, 'unset')
    }
  })

  it('refuses a chain id that is not in the registry, and says so', () => {
    const error = expectConfigError(
      () => readWebConfig({ ...goodEnv(), NEXT_PUBLIC_ARC_CHAIN_ID: '1' }),
      'NEXT_PUBLIC_ARC_CHAIN_ID',
      'invalid',
    )
    expect(error.message).toContain('not in ARC_CHAINS')
  })

  it('refuses a non-numeric chain id', () => {
    expectConfigError(
      () => readWebConfig({ ...goodEnv(), NEXT_PUBLIC_ARC_CHAIN_ID: 'mainnet' }),
      'NEXT_PUBLIC_ARC_CHAIN_ID',
      'invalid',
    )
  })

  it('refuses a non-address in either address slot', () => {
    expectConfigError(
      () => readWebConfig({ ...goodEnv(), NEXT_PUBLIC_ARCPAD_FACTORY: '0xnope' }),
      'NEXT_PUBLIC_ARCPAD_FACTORY',
      'invalid',
    )
    expectConfigError(
      () => readWebConfig({ ...goodEnv(), NEXT_PUBLIC_ARCPAD_ESCROW: FACTORY.slice(0, 20) }),
      'NEXT_PUBLIC_ARCPAD_ESCROW',
      'invalid',
    )
  })

  it('normalises a lowercase address to EIP-55 so later comparisons are checksum-to-checksum', () => {
    const config = readWebConfig({
      ...goodEnv(),
      NEXT_PUBLIC_ARCPAD_FACTORY: FACTORY.toLowerCase(),
    })
    expect(config.addresses.launchFactory).toBe(FACTORY)
  })

  // A websocket URL in the HTTP transport slot connects to nothing and the
  // failure surfaces as an opaque fetch error much later.
  it('refuses an RPC URL whose scheme the HTTP transport cannot use', () => {
    expectConfigError(
      () => readWebConfig({ ...goodEnv(), NEXT_PUBLIC_ARC_RPC_URL: 'wss://rpc.internal' }),
      'NEXT_PUBLIC_ARC_RPC_URL',
      'invalid',
    )
    expectConfigError(
      () => readWebConfig({ ...goodEnv(), NEXT_PUBLIC_ARC_RPC_URL: 'not a url' }),
      'NEXT_PUBLIC_ARC_RPC_URL',
      'invalid',
    )
  })
})
