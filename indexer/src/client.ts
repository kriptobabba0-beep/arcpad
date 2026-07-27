import { arcTestnet } from '@arcpad/shared'
import { createPublicClient, http, type PublicClient } from 'viem'

export function createArcClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  })
}
