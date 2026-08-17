import { describe, expect, it } from 'vitest'
import {
  ARC_CHAINS,
  ARC_TESTNET_CHAIN_ID,
  arcTestnet,
  getArcChain,
  MULTICALL3_ADDRESS,
  USDC_ERC20_ADDRESS,
} from '../src/chain'

describe('arcTestnet zincir tanimi', () => {
  it('Arc testnet chain id kullanir', () => {
    expect(arcTestnet.id).toBe(5042002)
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002)
  })

  it('native para birimini 18 decimal USDC olarak bildirir', () => {
    expect(arcTestnet.nativeCurrency.symbol).toBe('USDC')
    expect(arcTestnet.nativeCurrency.decimals).toBe(18)
  })

  it('resmi RPC ve explorer adreslerini tasir', () => {
    expect(arcTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.io')
    expect(arcTestnet.rpcUrls.default.webSocket?.[0]).toBe('wss://rpc.testnet.arc.io')
    expect(arcTestnet.blockExplorers?.default.url).toBe('https://testnet.arcscan.app')
  })

  it('USDC ERC-20 gorunumunu sistem adresinde tutar', () => {
    expect(USDC_ERC20_ADDRESS).toBe('0x3600000000000000000000000000000000000000')
  })

  it('kanonik Multicall3 adresini tasir', () => {
    expect(MULTICALL3_ADDRESS).toBe('0xcA11bde05977b3631167028862bE2a173976CA11')
    expect(arcTestnet.contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS)
  })
})

describe('ARC_CHAINS registry lookup', () => {
  it('the registry contains the testnet under its own id', () => {
    expect(ARC_CHAINS[ARC_TESTNET_CHAIN_ID]).toBe(arcTestnet)
    expect(getArcChain(ARC_TESTNET_CHAIN_ID)).toBe(arcTestnet)
  })

  // A lookup that returns undefined for an unknown chain hands the caller a
  // chain-shaped hole; every later `chain.id` read is then `undefined` and the
  // first thing that notices is the RPC.
  it('fails closed on a chain that is not registered, and names the known ones', () => {
    expect(() => getArcChain(1)).toThrow(/chain 1 is not in ARC_CHAINS/)
    expect(() => getArcChain(1)).toThrow(/known: 5042002/)
  })

  // 31337 has a governance key (`local-rehearsal`) but no RPC profile: it is
  // an anvil chain. That asymmetry is intentional, so it is pinned here rather
  // than left for someone to "fix".
  it('does not invent a profile for the rehearsal chain', () => {
    expect(() => getArcChain(31337)).toThrow(/not in ARC_CHAINS/)
  })
})
