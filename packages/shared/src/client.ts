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
export function createArcClient(rpcUrl: string, options?: ArcClientOptions) {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, {
      ...(options?.retryCount === undefined ? {} : { retryCount: options.retryCount }),
    }),
  })
}

/**
 * ================== `retryCount` NEDEN BURADA ==================
 *
 * viem'in `http()` VARSAYILANI `retryCount: 3`tur ve o denemeler CAGIRANIN
 * yeniden-deneme/pacing katmaninin ICINDE, ondan GORUNMEDEN olur. Indexer'in
 * `createPacer({ minIntervalMs: 600 })`i `client.request`i sarmalar; viem'in uc
 * ek HTTP istegi o TEK sarmalamanin icinde, ~150/300/600ms araliklarla gider.
 * Yani "600ms bosluk birak" sozlesmesi, tam da var olma sebebi olan durumda
 * bozulur -- cunku viem'in yeniden denemesini TETIKLEYEN sey zaten bir hiz
 * siniri yanitidir.
 *
 * OLCULDU (2026-08-05, canli `rpc.testnet.arc.network`, bes ayri tur):
 *
 *   [probe] provoked after 3 unpaced calls: HTTP 429 code=-32005
 *   [probe] provoked after 3 unpaced calls: HTTP 429 code=-32005   (5/5 ayni)
 *
 * UC bosluksuz `eth_getLogs` limiti tetikliyor. viem'in varsayilani tek bir
 * mantiksal istegi DORT bosluksuz HTTP istegine cevirir; yani varsayilan,
 * limiti kendi basina asmaya YETER. Indexer'in olumu (canli, ayni gun, `exit 1`
 * / `-32005`) bunun stack'inde aynen goruluyordu:
 *
 *   at withRetry.delay.count.count (viem/utils/buildRequest.ts:206)
 *
 * `retryCount: 0` gecen bir cagiran, yeniden denemenin TAMAMINA sahip olur ve
 * pacing yeniden anlamli hale gelir. Varsayilan DEGISMEDI: bu paketi kullanan
 * her yol (web, drill) aynen eskisi gibi davranir; degistirmek, olcmedigim
 * cagiranlarin davranisini sessizce degistirmek olurdu.
 */
export interface ArcClientOptions {
  /**
   * viem'in transport ici yeniden deneme sayisi. `0` = yeniden deneme YOK,
   * yani her HTTP istegi cagiranin pacing'inden ve butcesinden gecer.
   */
  retryCount?: number
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
