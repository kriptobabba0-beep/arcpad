import { createPublicClient, fallback, http } from 'viem'
import { ARC_TESTNET_CHAIN_ID, arcTestnet } from './chain'

/**
 * ===========================================================================
 *  BIR UC NOKTA, IKI SURECIN LOG BUTCESI -- OLCULDU, 2026-08-11
 * ===========================================================================
 *
 * Arc'in genel ucu `eth_getLogs`i METOT BAZINDA ve cok agir sinirliyor. Ayni
 * VPS'ten, ayni dakika icinde:
 *
 *   eth_getLogs, 5 sn arayla 12 cagri (patlama DEGIL)   2/12
 *   eth_getLogs, 1 sn arayla 10 cagri                   0/10
 *   eth_call + eth_blockNumber, 12 cagri               12/12
 *   TEK BLOKLUK eth_getLogs (fromBlock == toBlock)      yine -32005
 *
 * Son satir belirleyici: sinir ARALIK BUYUKLUGUNE bagli degil, dolayisiyla
 * "daha kucuk parcalar" diye bir care yok. Ve tuketen biziz: bir zincir
 * indexer'i ile bir factory izleyicisi ayni IP'den log tariyor.
 *
 * IKINCI UC NOKTA, VE NEDEN GUVENLI OLDUGU. `arc-testnet.drpc.org` olculdu:
 *
 *   eth_getLogs, 1 sn arayla 10 cagri            10/10   (birincil: 0/10)
 *   bas farki                                    1 blok
 *   indeksledigimiz bir tx'in makbuzu            AYNI blok, status 0x1,
 *                                                token adresimiz loglarinda
 *   o blogun hash'i                              IKI UCTA DA BIREBIR AYNI
 *
 * Son iki satir bir formalite degil, KABUL TESTIDIR: geride kalan ya da baska
 * bir zincir gorusu sunan bir uc nokta bir araligi "bos" gosterebilir ve o
 * SESSIZ VERI KAYBIDIR -- ariza turlerinin en kotusu. Blok hash'i esitse
 * ikisi ayni zinciri gormektedir.
 *
 * VE ZATEN BIR AGIMIZ VAR: indexer her araligin ilk blogunun `parentHash`ini
 * kayitli imlecin hash'iyle karsilastirir (`assertContinuous`). Farkli bir
 * gorus sunan bir uc nokta bu bagi KIRAR ve indexer ilerlemeyi reddeder --
 * yani failover'in en kotu hali "durur ve soyler", "yanlis veri yazar" degil.
 *
 * SIRA ONEMLI: birincil once. Ikincisi ucuncu bir taraftir ve `sendRawTransaction`
 * gibi yazma yollarinda resmi ucu tercih etmek isteriz; viem sirayla dener ve
 * birincil cevap verdigi surece ikincisine hic gitmez.
 */

/**
 * `ARC_RPC_URL` + `ARC_RPC_FALLBACK_URLS` -> denenecek uclar, SIRAYLA.
 *
 * TEK YERDE, cunku uc site bunu okuyor (indexer, keeper, drill) ve bu depoda
 * "bir host'un ikinci kopyasi" defalarca canli kusur uretti -- en son
 * `lib/ipfs.ts`te, dort kopyanin biri gozden kacip butun token gorsellerini
 * kendi CSP'mize reddettirerek.
 *
 * AYIRICI VIRGUL YA DA BOSLUK. Bir env dosyasinda insanlar ikisini de yazar;
 * birini reddetmek, sessizce TEK uca dusmek demek olurdu -- yani tam da
 * kapatmaya calistigimiz arizaya geri donmek, ve fark edilmeden.
 *
 * BIRINCIL HER ZAMAN BASTA ve tekrarlar atilir: yedek listesine birincili de
 * yazan bir operator, ayni uca iki kez soran bir istemci elde etmemeli.
 */
export function arcRpcUrls(primary: string, fallbacks?: string): readonly string[] {
  const extra = (fallbacks ?? '')
    .split(/[,\s]+/)
    .map((url) => url.trim())
    .filter((url) => url !== '')
  const seen = new Set<string>()
  return [primary, ...extra].filter((url) => {
    if (url === '' || seen.has(url)) return false
    seen.add(url)
    return true
  })
}

/**
 * Arc testnet'e baglanan bir viem public client olusturur.
 *
 * Donus tipi fonksiyondan CIKARILIR -- bare `PublicClient` olarak
 * daraltilmaz. `chain: arcTestnet` sabit gecildigi icin cikarilan tip
 * `client.chain`'i `arcTestnet`'e daraltilmis tutar; bare `PublicClient`
 * donus tipi bunu `Chain | undefined`'a genisletir ve her kullanimda
 * gereksiz bir null-check dogurur.
 *
 * `rpcUrl` BIR LISTE OLABILIR ve tek eleman verildiginde davranis
 * DEGISMEZ: tek url tek bir `http()` tasiyicisi uretir, yani bu degisiklik
 * yapilandirilmamis her dagitim icin bir no-op'tur.
 */
export function createArcClient(rpcUrl: string | readonly string[], options?: ArcClientOptions) {
  const urls = (typeof rpcUrl === 'string' ? [rpcUrl] : rpcUrl).filter((url) => url !== '')
  if (urls.length === 0) {
    // Bos bir liste sessizce viem'in varsayilan public ucuna DUSERDI -- yani
    // yanlis zincire. `assertArcChain` bunu yakalardi, ama hatanin dogru
    // yerde cikmasi teshisi saatlerce kisaltir.
    throw new Error('createArcClient: at least one RPC url is required')
  }
  const retry = options?.retryCount === undefined ? {} : { retryCount: options.retryCount }
  const transports = urls.map((url) => http(url, retry))
  return createPublicClient({
    chain: arcTestnet,
    /*
     * `rank: false` -- SIRA BIZIM, VIEM'IN OLCTUGU GECIKME DEGIL.
     *
     * Siralama acik olsaydi viem uclari periyodik olarak yoklayip hizliya
     * gore yeniden sirlardi; yani yazma yolunun hangi uca gidecegi olcum
     * gurultusune baglanir, ve ayni mantiksal is ortasinda uc degisebilirdi.
     * Bizim istedigimiz sey basit: birincil calisirken birincil, dustugunde
     * digeri.
     */
    transport:
      transports.length === 1 ? (transports[0] as ReturnType<typeof http>) : fallback(transports, { rank: false }),
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
