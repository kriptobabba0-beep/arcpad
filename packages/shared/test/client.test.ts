import { describe, expect, it } from 'vitest'
import { ARC_TESTNET_CHAIN_ID, arcTestnet } from '../src/chain'
import { arcRpcUrls, assertArcChain, createArcClient } from '../src/client'

describe('createArcClient', () => {
  it('Arc testnet zincirine baglanmis, chain alani daralmis bir client dondurur', () => {
    const client = createArcClient('https://rpc.testnet.arc.io')
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

/**
 * ============================================================================
 *  IKI UC NOKTA -- VE YAPILANDIRILMAMIS BIR DAGITIMDA HICBIR SEY DEGISMEZ
 * ============================================================================
 *
 * OLCULDU (2026-08-11, canli VPS'ten, ayni dakika icinde):
 *
 *   eth_getLogs, 1 sn arayla 10 cagri   birincil 0/10   ikincil 10/10
 *   eth_call + eth_blockNumber, 12      12/12
 *   TEK BLOKLUK eth_getLogs             yine -32005
 *
 * Ucuncu satir belirleyici: sinir aralik buyuklugune bagli degil, yani "daha
 * kucuk parca" bir care degildi. Ikinci bir uc gerekiyordu.
 *
 * Bu testlerin cogu SIRA ve TEKRAR hakkindadir, cunku failover'in tehlikesi
 * dusen bir uc degil, SESSIZCE FARKLI bir zincir gorusudur: geride kalan bir
 * uc bir araligi "bos" gosterirse o veri kaybidir. Sira bizim elimizde
 * kalmali (`rank: false`) ve birincil hep basta olmali.
 */
describe('arcRpcUrls', () => {
  const PRIMARY = 'https://rpc.testnet.arc.network'
  const SECOND = 'https://arc-testnet.drpc.org'

  it('yedek verilmezse liste TEK elemanlidir -- bu bir no-op olmalidir', () => {
    expect(arcRpcUrls(PRIMARY)).toEqual([PRIMARY])
    expect(arcRpcUrls(PRIMARY, '')).toEqual([PRIMARY])
    expect(arcRpcUrls(PRIMARY, '   ')).toEqual([PRIMARY])
  })

  it('BIRINCIL HER ZAMAN BASTA', () => {
    // Yazma yollarinda resmi ucu tercih ederiz; viem sirayla dener ve
    // birincil cevap verdigi surece ikincisine hic gitmez.
    expect(arcRpcUrls(PRIMARY, SECOND)[0]).toBe(PRIMARY)
  })

  it('virgul de bosluk da ayirir -- bir env dosyasinda insanlar ikisini de yazar', () => {
    const expected = [PRIMARY, SECOND, 'https://c.example']
    expect(arcRpcUrls(PRIMARY, `${SECOND},https://c.example`)).toEqual(expected)
    expect(arcRpcUrls(PRIMARY, `${SECOND} https://c.example`)).toEqual(expected)
    expect(arcRpcUrls(PRIMARY, `${SECOND}, https://c.example`)).toEqual(expected)
    expect(arcRpcUrls(PRIMARY, `\n${SECOND}\n`)).toEqual([PRIMARY, SECOND])
  })

  it('TEKRARLAR ATILIR -- ayni uca iki kez sormak bir care degil', () => {
    expect(arcRpcUrls(PRIMARY, `${PRIMARY},${SECOND}`)).toEqual([PRIMARY, SECOND])
    expect(arcRpcUrls(PRIMARY, `${SECOND},${SECOND}`)).toEqual([PRIMARY, SECOND])
  })
})

describe('createArcClient, birden fazla uc ile', () => {
  it('tek uc ile ZINCIR hala Arc testnet', () => {
    const client = createArcClient('http://127.0.0.1:8545')
    expect(client.chain.id).toBe(ARC_TESTNET_CHAIN_ID)
  })

  it('iki uc ile de ZINCIR degismez', () => {
    const client = createArcClient(['http://127.0.0.1:8545', 'http://127.0.0.1:8546'])
    expect(client.chain.id).toBe(ARC_TESTNET_CHAIN_ID)
  })

  it('BOS LISTE REDDEDILIR -- sessizce yanlis zincire dusmektense at', () => {
    // viem'in varsayilan tasiyicisi zincirin kendi public ucuna duser. Bu
    // durumda `assertArcChain` sonunda yakalardi, ama hatanin DOGRU yerde
    // cikmasi teshisi saatlerce kisaltir.
    expect(() => createArcClient([])).toThrow(/at least one RPC url/i)
    expect(() => createArcClient('')).toThrow(/at least one RPC url/i)
  })
})
