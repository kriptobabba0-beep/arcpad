import { describe, expect, it } from 'vitest'
import { arcTestnet } from '../src/chain'
import { assertArcChain, createArcClient } from '../src/client'

describe('createArcClient', () => {
  it('Arc testnet zincirine baglanmis, chain alani daralmis bir client dondurur', () => {
    const client = createArcClient('https://rpc.testnet.arc.network')
    // `client.chain` bare `PublicClient` donus tipiyle `Chain | undefined`
    // olurdu; burada opsiyonel zincirleme olmadan dogrudan okunabiliyor
    // olmasi donus tipinin dogru cikarildigini kanitlar.
    expect(client.chain.id).toBe(arcTestnet.id)
    expect(client.chain.name).toBe(arcTestnet.name)
  })
})

describe('assertArcChain', () => {
  it('client Arc testnet chainId dondururse hata firlatmaz', async () => {
    const stubClient = { getChainId: async () => 5042002 }
    await expect(assertArcChain(stubClient)).resolves.toBeUndefined()
  })

  it('client baska bir chainId dondururse aciklayici hata firlatir', async () => {
    const stubClient = { getChainId: async () => 1 }
    await expect(assertArcChain(stubClient)).rejects.toThrow(
      'connected to chain 1, expected 5042002',
    )
  })
})
