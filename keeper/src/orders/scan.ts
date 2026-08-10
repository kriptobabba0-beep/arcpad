import { DEFAULT_CURVE_BATCH_SUBCALLS } from '../watch/graduationWindow'

/**
 * ==========================================================================
 *  BIR GECISIN MALIYETI, EMIR SAYISININ FONKSIYONU OLARAK
 * ==========================================================================
 *
 * Graduation izleyicisi curve slotlarini Multicall3 uzerinden 500 alt cagrilik
 * parcalar halinde okuyor ve o sayi OLCUMDEN geliyor (bkz.
 * `DEFAULT_CURVE_BATCH_SUBCALLS`: canli Arc'ta genislik 6400'e kadar kabul
 * ediliyor, 12800 `intrinsic gas too low` ile REDDEDILIYOR, ve 500 duvarin
 * 12.8 kati asagisinda duz bolgede ~117 ms). Emirler O EKSENE IKINCI BIR EKSEN
 * EKLER ve bu dosya o ekseni sayiya cevirir.
 *
 * ==========================================================================
 *  BIR GECISTE NE OKUNUR
 * ==========================================================================
 *
 * CURVE BASINA ALTI (mutable, her geciste yeniden):
 *   complete, graduated, virtualQuoteReserves, virtualTokenReserves,
 *   realTokenReserves, realQuoteReserves
 *
 * CURVE BASINA UC, YALNIZCA BIR KEZ (immutable, sonsuza kadar onbellege):
 *   creator            -- `address public immutable creator` (BondingCurve.sol:180)
 *   PROTOCOL_FEE_BPS   -- sabit
 *   CREATOR_FEE_BPS    -- sabit
 *
 * FONLAMA OKUMASI BASINA BIR:
 *   alim  -> `Multicall3.getEthBalance(owner)`   (18-decimal native USDC)
 *   satim -> `LaunchToken.balanceOf(owner)`
 *
 *   ALIM OKUMALARI SAHIP BASINA TEKILLESIR, TOKEN BASINA DEGIL: native bakiye
 *   token'a bagli degildir, yani ayni sahibin on farkli token'daki on alim
 *   emri TEK bir alt cagri harcar. Satim okumalari (token, sahip) ciftine
 *   baglidir. Bu ayrimi kaybetmek, maliyeti sahip basina degil emir basina
 *   yapardi.
 *
 * ARTI BIR JSON-RPC OBJESI: `eth_getBlockByNumber` (parcalarin uzerinde
 * anlasacagi blok). Toplu okumanin blok sabitlemesi ondan gelir.
 *
 * ==========================================================================
 *  HAVUZ EMIRLERI TOPLU OKUNAMAZ, VE BU BIR TERCIH DEGIL
 * ==========================================================================
 *
 * `ArcpadRouter.quote*` DEGERI BIR REVERT ILE dondurur (`QuoteResult`), ki bu
 * V4'te bir fiyati bilmenin tek dogru yoludur. `aggregate3` icinde revert eden
 * bir alt cagri bir BASARISIZLIKTIR ve `chainReader.readContractBatch` her
 * basarisizligi FIRLATIR -- bilerek, cunku bos donus verisi "sifir" gibi
 * okunur. Yani havuz emirleri her biri KENDI `eth_call`i olmak zorundadir.
 *
 * SONUCU MALIYET MODELINDE AYRI DURUR ve buyume sinifi FARKLIDIR: curve
 * emirleri O(N/500) istek, havuz emirleri O(N) istek. Bugun bu bir sorun
 * degil cunku uretim factory'sinin `graduationTarget`i `0x0`dir -- zincirde
 * TEK BIR arcpad havuzu yoktur ve hicbir emir havuz mekanina duşemez. Sinir
 * yine de burada yazili, cunku ilk mezuniyet o gun geldiginde bu sayilar
 * degisecek.
 */

/** Bir geciste okunacak islerin sekli. */
export type ScanShape = {
  /** Curve mekanindaki emir sayisi. */
  readonly curveOrders: number
  /** O emirlerin yayildigi FARKLI curve sayisi. */
  readonly curves: number
  /** Fonlama icin okunacak FARKLI (varlik, sahip) ciftinin sayisi. */
  readonly fundingReads: number
  /** Bu geciste ILK KEZ gorulen curve sayisi (immutable okumalari). */
  readonly coldCurves: number
  /** Havuz mekanindaki emir sayisi. Her biri kendi `eth_call`i. */
  readonly poolOrders: number
}

export type ScanCost = {
  /** Multicall3'e giden alt cagri sayisi. */
  readonly subcalls: number
  /** O alt cagrilari tasiyan `eth_call` sayisi. */
  readonly batchedCalls: number
  /** Havuz kotalari -- toplanamaz, her biri ayri. */
  readonly poolCalls: number
  /** Blok sabitlemesi dahil TOPLAM JSON-RPC objesi. */
  readonly rpcObjects: number
}

/** Curve basina her geciste okunan mutable slot sayisi. */
export const MUTABLE_SLOTS_PER_CURVE = 6
/** Curve basina yalnizca ILK geciste okunan immutable slot sayisi. */
export const IMMUTABLE_SLOTS_PER_CURVE = 3

export function scanCost(
  shape: ScanShape,
  batchSubcalls: number = DEFAULT_CURVE_BATCH_SUBCALLS,
): ScanCost {
  if (!Number.isInteger(batchSubcalls) || batchSubcalls < 1) {
    throw new Error(`the batch width must be a positive integer, got ${batchSubcalls}`)
  }
  const subcalls =
    shape.curves * MUTABLE_SLOTS_PER_CURVE +
    shape.coldCurves * IMMUTABLE_SLOTS_PER_CURVE +
    shape.fundingReads
  const batchedCalls = Math.ceil(subcalls / batchSubcalls)
  const poolCalls = shape.poolOrders
  return {
    subcalls,
    batchedCalls,
    poolCalls,
    // +1: blok sabitlemesi. Parcalar ARDISIK yayilir (Arc es zamanli
    // `eth_call`lari sinirlar -- olculdu, 6 es zamanli -> 2/6), yani bu sayi
    // ayni zamanda gecisin tur sayisidir.
    //
    // ILK HALI BURADA `shape.poolCalls` YAZIYORDU -- `ScanShape`te BOYLE BIR
    // ALAN YOK, o `poolOrders`. Sonuc `undefined` degil **NaN**ti, yani
    // "maliyet" alani sessizce bir sayi olmaktan cikiyordu ve `fitsPoll` de
    // onu kullanmadigi icin "sigar mi" cevabi DEGISMIYORDU. Bir birim testi
    // yakaladi; okuyarak yakalanmazdi, cunku iki isim de bu dosyada geciyor.
    rpcObjects: batchedCalls + poolCalls + 1,
  }
}

/**
 * BIR GECISIN, POLL ARALIGINA SIGIP SIGMADIGI.
 *
 * `msPerBatchedCall` OLCULMUS bir sabittir, tahmin degil: `scaleBench.ts --arc`
 * 500 genisligi uc kez kosturdu ve [119, 115, 117] ms verdi. Havuz kotalari
 * icin ayri bir sabit var cunku onlar bir takasi CALISTIRAN cagrilardir ve tek
 * bir slot okumasindan pahalidir; kullanilan deger `usePoolQuote`in 2 saniyelik
 * yenileme araliginin cok altinda, ihtiyatli bir tavandir.
 *
 * MARJ ACIKCA DONER. "Sigar" bir evet/hayir degildir; kac kat pay kaldigidir,
 * ve o sayi bir yapilandirmanin ne zaman bozulacagini soyler.
 */
export const MEASURED_MS_PER_BATCHED_CALL = 117
export const ASSUMED_MS_PER_POOL_QUOTE = 200

export function fitsPoll(
  cost: ScanCost,
  pollIntervalMs: number,
): { readonly estimatedMs: number; readonly fits: boolean; readonly headroom: number } {
  const estimatedMs =
    cost.batchedCalls * MEASURED_MS_PER_BATCHED_CALL + cost.poolCalls * ASSUMED_MS_PER_POOL_QUOTE
  return {
    estimatedMs,
    fits: estimatedMs < pollIntervalMs,
    headroom: estimatedMs === 0 ? Number.POSITIVE_INFINITY : pollIntervalMs / estimatedMs,
  }
}

/**
 * EMIRLERDEN SEKLI TURETIR -- ve tekillestirmeyi TEK YERDE yapar.
 *
 * Cagiran taraf bu sayilari kendi sayarsa, maliyet modeli ile GERCEK istek
 * sayisi ayrisir ve "sigiyor" iddiasi olculen seyle ilgisiz kalir. Bu yuzden
 * `runOrderPass` de okunacak kumeleri BURADAN alir.
 */
export type OrderShapeInput = {
  readonly token: string
  readonly curve: string
  readonly ownerAddr: string
  readonly isBuy: boolean
  readonly venue: 'curve' | 'pool'
}

export function shapeOf(
  orders: readonly OrderShapeInput[],
  knownCurves: ReadonlySet<string> = new Set(),
): ScanShape & {
  readonly curveList: readonly string[]
  readonly nativeOwners: readonly string[]
  readonly tokenHolders: readonly { readonly token: string; readonly owner: string }[]
} {
  const curveOrders = orders.filter((o) => o.venue === 'curve')
  const curveList = [...new Set(curveOrders.map((o) => o.curve))]
  // ALIM: sahip basina TEK okuma, token'dan bagimsiz.
  const nativeOwners = [...new Set(curveOrders.filter((o) => o.isBuy).map((o) => o.ownerAddr))]
  // SATIM: (token, sahip) basina tek okuma.
  const holderKeys = [
    ...new Set(curveOrders.filter((o) => !o.isBuy).map((o) => `${o.token}|${o.ownerAddr}`)),
  ]
  const tokenHolders = holderKeys.map((key) => {
    const [token = '', owner = ''] = key.split('|')
    return { token, owner }
  })
  return {
    curveOrders: curveOrders.length,
    curves: curveList.length,
    coldCurves: curveList.filter((c) => !knownCurves.has(c)).length,
    fundingReads: nativeOwners.length + tokenHolders.length,
    poolOrders: orders.length - curveOrders.length,
    curveList,
    nativeOwners,
    tokenHolders,
  }
}
