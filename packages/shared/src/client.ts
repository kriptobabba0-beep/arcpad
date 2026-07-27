import { createPublicClient, http } from 'viem'
import { ARC_TESTNET_CHAIN_ID, arcTestnet } from './chain'

/**
 * Arc testnet'e baglanan bir viem public client olusturur.
 *
 * Donus tipi fonksiyondan CIKARILIR -- bare `PublicClient` olarak
 * daraltilmaz. `chain: arcTestnet` sabit gecildigi icin cikarilan tip
 * `client.chain`'i `arcTestnet`'e daraltilmis tutar; bare `PublicClient`
 * donus tipi bunu `Chain | undefined`'a genisletir ve her kullanimda
 * gereksiz bir null-check dogurur.
 */
export function createArcClient(rpcUrl: string) {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  })
}

/**
 * `getChainId()` sahibi herhangi bir nesne. `assertArcChain`'i gercek bir
 * viem `PublicClient`'a degil bu dar arayuze baglamak, canli bir RPC
 * olmadan sahte (stub) bir nesneyle test edilebilmesini saglar.
 */
export interface ChainIdSource {
  getChainId(): Promise<number>
}

/**
 * Baglanilan RPC'nin gercekten Arc testnet (chainId 5042002) oldugunu
 * dogrular. indexer ve keeper baslangicta bunu cagirir: yanlis
 * yapilandirilmis bir RPC URL'i (ör. baska bir agin node'u) sessizce kabul
 * edilmez, erken ve acik bir hatayla durur.
 */
export async function assertArcChain(client: ChainIdSource): Promise<void> {
  const chainId = await client.getChainId()
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`connected to chain ${chainId}, expected ${ARC_TESTNET_CHAIN_ID}`)
  }
}
