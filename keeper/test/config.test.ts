import { describe, expect, it } from 'vitest'
import { loadKeeperConfig } from '../src/config'

describe('loadKeeperConfig', () => {
  it('gecerli ortamdan yapilandirma uretir', () => {
    const config = loadKeeperConfig({
      ARC_RPC_URL: 'https://rpc.testnet.arc.network',
      KEEPER_POLL_INTERVAL_MS: '2000',
      KEEPER_DRY_RUN: 'false',
    })
    expect(config).toEqual({
      rpcUrl: 'https://rpc.testnet.arc.network',
      pollIntervalMs: 2000,
      dryRun: false,
    })
  })

  it('ARC_RPC_URL yoksa hata firlatir', () => {
    expect(() => loadKeeperConfig({})).toThrow(/ARC_RPC_URL/)
  })

  it('poll araligi belirtilmezse 5000 ms varsayar', () => {
    const config = loadKeeperConfig({ ARC_RPC_URL: 'https://rpc.testnet.arc.network' })
    expect(config.pollIntervalMs).toBe(5000)
  })

  it('guvenli tarafta durur: dryRun varsayilan olarak aciktir', () => {
    const config = loadKeeperConfig({ ARC_RPC_URL: 'https://rpc.testnet.arc.network' })
    expect(config.dryRun).toBe(true)
  })

  it('poll araligi sayi degilse hata firlatir', () => {
    expect(() =>
      loadKeeperConfig({
        ARC_RPC_URL: 'https://rpc.testnet.arc.network',
        KEEPER_POLL_INTERVAL_MS: 'soon',
      }),
    ).toThrow(/KEEPER_POLL_INTERVAL_MS/)
  })
})
