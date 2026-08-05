import type { Abi, AbiEvent } from 'viem'
import type { createArcClient } from '@arcpad/shared'
import type {
  ChainReader,
  HeadBlock,
  LogQuery,
  ObservedLog,
  ReadCall,
} from './watch/graduationWindow'

type ArcClient = ReturnType<typeof createArcClient>

/**
 * ARC'IN HIZ SINIRI VIEM'IN YENIDEN-DENEME LISTESINE DUSMEZ, ve bu izleyicinin
 * CANLI ZINCIRE KARSI ILK POLL'UNU BILE TAMAMLAYAMAMASINA yol aciyordu.
 *
 * OLCULDU (canli Arc testnet, https://rpc.testnet.arc.network):
 *
 *   HTTP/1.1 429
 *   {"jsonrpc":"2.0","id":7,"error":{"code":-32011,"message":"request limit reached"}}
 *
 * viem 2.55.8'de bu iki dosyadan gecer ve IKISI BIRDEN gerekir:
 *
 *   _esm/utils/rpc/http.js -- `!response.ok` dalinda, govde SAYISAL bir `code`
 *     ve DIZE bir `message` tasiyorsa govde OLDUGU GIBI DONDURULUR
 *     ("so it flows through the normal RPC error handling pipeline"). Yani hata
 *     `RpcRequestError(code -32011)` olur; `HttpRequestError(status 429)` OLMAZ.
 *
 *   _esm/utils/buildRequest.js `shouldRetry` -- `'code' in error` dali -1,
 *     -32005 (LimitExceeded), -32603 (Internal) ve 429 DISINDAKI her sey icin
 *     `false` doner, ve ERKEN doner. Altindaki `error.status === 429` dali bu
 *     hata icin ULASILAMAZDIR.
 *
 * Net etki: `retryCount: 3` varsayilani bu hataya HIC uygulanmaz. Sifir
 * yeniden deneme.
 *
 * OLCULEN SONUC, duzeltmeden once, uretim defteri ve canli factory ile:
 *   50 saniyede 3 PAGE, SIFIR HEARTBEAT. Ilk poll `watcher-state-read-failed`
 *   ile duser (`pendingGraduationTarget()` 429), sonra kanarya
 *   `watcher-heartbeat-missed` ve `chain-head-stale` cikarir. Yani tek
 *   savunma hatti, calisiyor gorunerek HICBIR SEY izlemiyordu.
 *
 * SINIRIN KENDISI DE OLCULDU ve BASIT BIR HIZ SINIRI DEGILDIR -- sabit bir
 * bekleme sabiti secmek bu yuzden YANLIS olurdu:
 *
 *   6 es zamanli eth_call   -> 2/6 basarili
 *   6 ardisik, beklemesiz   -> 2/6 basarili
 *   12 cagri, 100ms arayla  -> 12/12
 *   12 cagri, 200ms arayla  -> 4/12, 4/12, 4/12, 4/12, 12/12, 8/12 (alti tur)
 *
 * Ayni aralik ayni turda farkli sonuc veriyor, yani butce ISTEMCININ
 * TEMPOSUNDAN DEGIL, ucun genel yukundan geliyor. "Yeterince yavas ol" diye
 * bir sayi YOKTUR. Tek dogru care GERI CEKILEREK YENIDEN DENEMEKTIR.
 */
export const ARC_RATE_LIMIT_RPC_CODE = -32011

/**
 * viem `LimitExceededRpcError`.
 *
 * BURADA "ARC BUNU KULLANMAZ; TAMLIK ICIN KABUL EDILIR" YAZIYORDU. YANLIS, VE
 * DOGRU DAVRANIS SIRF SANSTI.
 *
 * Arc'in hiz sinirinin `-32011` OLDUGU, tek bir kosuda gorulen ORNEKLEMIN
 * tamamiydi; ayni depoda indexer izi 2026-08-02'de ayni ucu tekrar olctu ve
 * cevaplar KARISIK geldi -- id 5 `-32005`, id 6 `-32011`, id 7 `-32005`. Yani
 * Arc'in EN AZ IKI hiz siniri kodu var ve ikincisi tam olarak buradaki
 * "kullanilmaz" diye isaretlenen koddu.
 *
 * Ikisi de listede oldugu icin davranis dogru; kayit yanlisti, ve yanlis kayit
 * calisir haldeki bir korumayi "olu kod" gibi gosterip sildirir. `-32005`
 * silinseydi ikinci koddaki her hiz siniri YENIDEN DENENMEZ, poll duser,
 * KALP ATISI YAYILMAZ ve tatbikat "there was no watcher" derdi.
 */
export const LIMIT_EXCEEDED_RPC_CODE = -32005

/**
 * Hata zinciri boyunca hiz siniri izi arar.
 *
 * `error.cause` ZINCIRI YURUNUR cunku `readContract` hatayi
 * `ContractFunctionExecutionError` icine sarar; ust seviyede ne `code` ne
 * `status` vardir. Derinlik sinirlidir: dongusel bir `cause` -- kutuphane
 * hatalarinda gorulmustur -- izleyiciyi ASMAYA cevirirdi, ve asilmis bir
 * izleyici sessiz bir izleyicidir.
 *
 * DIZE ESLESMESI SON CARE OLARAK VARDIR, tek dayanak olarak degil. Saglayici
 * kodu degistirirse (ya da bir vekil sunucu araya girerse) sayisal kod kacar;
 * "request limit reached" metni ise ucun BUGUN dondurdugu metindir.
 */
export function isRateLimited(error: unknown): boolean {
  for (let node = error, depth = 0; node !== null && node !== undefined && depth < 12; depth += 1) {
    const o = node as { code?: unknown; status?: unknown; details?: unknown; message?: unknown }
    if (o.code === ARC_RATE_LIMIT_RPC_CODE || o.code === LIMIT_EXCEEDED_RPC_CODE) return true
    if (o.status === 429) return true
    for (const field of [o.details, o.message]) {
      if (typeof field === 'string' && /request limit reached|rate ?limit/i.test(field)) return true
    }
    node = (node as { cause?: unknown }).cause
  }
  return false
}

export type RetryOptions = {
  /** TOPLAM deneme sayisi (ilk deneme dahil). */
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** [0,1). Testler sabitler. */
  random?: () => number
}

/**
 * DENEME SAYISI OLCUMDEN TURETILDI, SECILMEDI.
 *
 * En kotu gozlenen rejimde ucun basari orani cagri basina ~1/3 idi
 * (200ms arayla 12 cagri, dort ayri turda 4/12; desen `.XX.XX.XXX.X`).
 * Bir poll, imlec kurulduktan sonra ~11 istek yayar: 1 `getBlock`, 6 slot
 * `eth_call`, 1 `getLogs`, ve tamamlanmis curve basina 3 `eth_call`.
 *
 *   n denemeden sonra bir islemin BASARISIZ kalma olasiligi  (2/3)^n
 *   poll'un ayakta kalmasi                                   (1-(2/3)^n)^11
 *
 * n=6  -> islem basina %8.8 ariza -> poll'un %64'u duser. OLCULDU: 95 saniyede
 *         5 kalp atisi ve 7 sayfa; yani hesap gozlemle tutuyor.
 * n=14 -> islem basina %0.34 ariza -> poll'un ~%96'si ayakta.
 *
 * Ust sinir bedeli SADECE kotu rejimde odenir: iyi rejimde ilk deneme tutar ve
 * hicbir bekleme yapilmaz. Patolojik durumda toplam bekleme tavani
 * 200+400+800+1600+2000*9 = 21 saniyedir (tam jitter ile beklenen degeri
 * bunun yarisi).
 */
export const DEFAULT_RETRY_ATTEMPTS = 14
export const DEFAULT_RETRY_BASE_DELAY_MS = 200
export const DEFAULT_RETRY_MAX_DELAY_MS = 2_000

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * YALNIZCA HIZ SINIRINDA yeniden dener. Baska HICBIR hata yeniden denenmez.
 *
 * Bu ayrim, duzeltmenin bir maskeye donusmemesi icin ZORUNLUDUR: `revert`,
 * kodu olmayan bir adres, bozuk bir ABI ya da yanlis zincir -- hepsi ANINDA
 * yukari cikmali ve `runWatcher` onlari sayfaya cevirmeli. Genel bir "her
 * seyi yeniden dene" sarmalayicisi tam da bu izleyicinin var olma sebebi olan
 * arizalari gecikmeli hale getirirdi.
 *
 * TAM JITTER (`random() * delay`), sabit gecikme DEGIL. `readWindowState` alti
 * cagriyi BIRLIKTE yayar; hepsi ayni anda sinira carpip ayni sure bekleseydi,
 * ayni anda geri donup ayni duvara TOPLU HALDE carparlardi. Jitter onlari
 * dagitir.
 *
 * BUTCE POLL ARALIGINI ASABILIR ve bu bilincli bir tercihtir: `index.ts`
 * dongusu KENDINI YENIDEN ZAMANLAR (`setInterval` degil), yani yavas bir poll
 * ust uste binmez, yalnizca seyrekletir. Israrli bir sinirlama halinde
 * denemeler tukenir, `watcher-state-read-failed` sayfasi cikar ve kalp atisi
 * YAYILMAZ -- yani durum GORUNUR kalir. Yeniden deneme, GECICI bir sinirin
 * sayfaya donusmesini engeller; KALICI olani gizlemez.
 */
export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const attempts = options?.attempts ?? DEFAULT_RETRY_ATTEMPTS
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
  const sleep = options?.sleep ?? defaultSleep
  const random = options?.random ?? Math.random

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      // SON DENEMEDE DE, HIZ SINIRI OLMAYAN HATADA DA, HATA OLDUGU GIBI CIKAR.
      // Sarmalanmis bir hata `runWatcher`in sayfasindaki teshisi bozardi.
      if (attempt >= attempts || !isRateLimited(error)) throw error
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      await sleep(Math.round(random() * ceiling))
    }
  }
}

/**
 * `ChainReader`in TEK gercek uygulamasi.
 *
 * Icinde KARAR yoktur: viem imzalarini bizim dar arayuzumuze cevirir ve her
 * cagriyi `withRateLimitRetry`den gecirir. Yeniden-deneme mantiginin kendisi
 * BU DOSYADA AMA AYRI VE SAF bir fonksiyondadir (`withRateLimitRetry`,
 * `isRateLimited`) -- cunku bu dosyanin geri kalani canli bir RPC olmadan test
 * edilemez ve test edilmeyen bir yere karar koymak, bu depoda defalarca
 * olculen hatadir. Iki fonksiyon da dogrudan test edilir.
 */
export function viemChainReader(client: ArcClient, retry?: RetryOptions): ChainReader {
  return {
    getBlock(): Promise<HeadBlock> {
      return withRateLimitRetry(async () => {
        const block = await client.getBlock({ blockTag: 'latest' })
        if (block.number === null) throw new Error('the latest block has no number')
        return { number: block.number, timestamp: block.timestamp }
      }, retry)
    },
    readContract(call: ReadCall): Promise<unknown> {
      return withRateLimitRetry(
        () =>
          client.readContract({
            address: call.address,
            abi: call.abi as Abi,
            functionName: call.functionName,
            args: call.args ?? [],
            blockNumber: call.blockNumber,
          }),
        retry,
      )
    },
    getLogs(query: LogQuery): Promise<ReadonlyArray<ObservedLog>> {
      return withRateLimitRetry(async () => {
        const logs = await client.getLogs({
          address: query.address,
          events: query.events as AbiEvent[],
          fromBlock: query.fromBlock,
          toBlock: query.toBlock,
        })
        return logs as ReadonlyArray<ObservedLog>
      }, retry)
    },
  }
}
