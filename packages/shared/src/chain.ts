import { defineChain } from 'viem'

export const ARC_TESTNET_CHAIN_ID = 5042002 as const

/**
 * Arc'ta native varlik USDC'nin kendisidir; native gorunum 18 decimal'dir.
 * Zincir tanimini viem'den ice aktarmak yerine burada tanimliyoruz: viem'in
 * hangi surumde Arc'i tasidigina bagli kalmamak ve tek bir dogruluk kaynagi
 * birakmak icin.
 */
export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arc.io'],
      webSocket: ['wss://rpc.testnet.arc.io'],
    },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  testnet: true,
})

/**
 * USDC'nin 6 decimal'lik ERC-20 gorunumu. Native bakiyeyle AYNI fonu temsil
 * eder -- ayri bir token degildir. Ikisi asla toplanmaz.
 */
export const USDC_ERC20_ADDRESS = '0x3600000000000000000000000000000000000000' as const
