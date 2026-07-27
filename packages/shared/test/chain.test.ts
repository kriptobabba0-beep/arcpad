import { describe, expect, it } from 'vitest'
import { ARC_TESTNET_CHAIN_ID, arcTestnet, USDC_ERC20_ADDRESS } from '../src/chain'

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
    expect(arcTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.network')
    expect(arcTestnet.blockExplorers?.default.url).toBe('https://testnet.arcscan.app')
  })

  it('USDC ERC-20 gorunumunu sistem adresinde tutar', () => {
    expect(USDC_ERC20_ADDRESS).toBe('0x3600000000000000000000000000000000000000')
  })
})
