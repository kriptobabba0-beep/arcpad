import {
  type CurveProfile,
  type CurveState,
  type FeeBps,
  netProceedsOf,
  planBuyExactQuoteIn,
  planSellExactTokensIn,
  TradePlanError,
} from '@arcpad/shared'

/**
 * ==========================================================================
 *  TETIK PREDIKATI -- VE NEDEN KEEPER'A FIYAT ICIN GUVENILMEZ
 * ==========================================================================
 *
 * Bir emrin "tetiklendi" olmasi TEK BIR SEY demektir:
 *
 *     ZINCIR, SU ANDA, BU EMRIN KENDI SLIPAJ SINIRIYLA GONDERILEN ISLEMI
 *     KABUL EDERDI.
 *
 * Bir "fiyat esigi" DEGIL. Fark, tam olarak bu deponun kacinmasi gereken
 * seydir: bir esik, saklanan sayi ile zincire giden argumanin AYRISABILECEGI
 * ikinci bir kod yolu dogurur. Burada boyle bir yol YOKTUR, cunku emrin
 * sakladigi sey ZATEN zincirin argumanidir (`min_out_tok` = `minTokensOut`,
 * `min_out_wei` = `minQuoteOut`) ve asagidaki karsilastirma zincirin KENDI
 * korumasinin birebir kopyasidir:
 *
 *     `buyExactQuoteIn`   ->  `if (tokensOut < minTokensOut) revert SlippageExceeded()`
 *     `sellExactTokensIn` ->  `if (netOut   < minQuoteOut)   revert SlippageExceeded()`
 *
 * SONUCU BIR GUVENLIK OZELLIGIDIR VE ACIKCA YAZILMALI: **KEEPER FIYAT ICIN
 * GUVENILMEZ.** Erken tetiklerse (hata, bayat okuma, ya da kotu niyet) emrin
 * doldurma islemi zincirde `SlippageExceeded` ile REVERT eder ve kullanici
 * PARA KAYBETMEZ -- yalnizca bir gaz ucreti oder, ve arayuz o islemi
 * gondermeden once kendi canli kotasini aldigi icin pratikte onu da odemez.
 * Keeper yalnizca CANLILIK icin guvenilir: "fark etmek".
 *
 * ==========================================================================
 *  HESABI YAPAN KOD, ARAYUZUN KULLANDIGI KODUN TA KENDISIDIR
 * ==========================================================================
 *
 * `planBuyExactQuoteIn` / `planSellExactTokensIn` -- `packages/shared`, yani
 * `CurveMath.sol`in port-parity kapisi altindaki port (spec §6.3, §10). Burada
 * ikinci bir aritmetik yazmak, ayni sorunun iki cevabini uretmek olurdu; ve bu
 * depoda ikilenen bir olgunun HANGI kopyasinin kaydigi sorusu defalarca
 * odendi.
 *
 * `slipBps = 0` VERILIR ve bu tasiyicidir: planlayicinin kendi slipaj payi
 * emrin sinirinin UZERINE binerdi ve emir, kullanicinin istediginden DAHA IYI
 * bir fiyat beklemeye baslardi -- yani hic dolmayabilirdi. Sinir emrin
 * kendisindedir; planlayici yalnizca "su anda ne alirim" sorusunu cevaplar.
 */

/** Keeper'in bir emir hakkinda verebilecegi butun cevaplar. */
export type TriggerVerdict =
  /** Zincir su anda bu emri kabul ederdi. */
  | { kind: 'triggered' }
  /** Kabul etmezdi. `got` ile `want` arasindaki fark ne kadar kaldigini soyler. */
  | { kind: 'notYet'; got: bigint; want: bigint }
  /**
   * Curve KAPALI ama token HENUZ MEZUN DEGIL -- yani emrin gidebilecegi bir
   * mekan su an YOK. TERMINAL DEGIL: mezuniyet gerceklestiginde emir havuzda
   * yeniden degerlendirilebilir hale gelir. Bir "olu emir" gibi silmek,
   * kullanicinin emrini geciciligi olan bir durum yuzunden yok etmek olurdu.
   */
  | { kind: 'stalled'; reason: 'completeNotGraduated' }
  /**
   * Emir zincirde ASLA kabul edilemez -- planlayicinin kendi reddi. Ornegin
   * satista `ProceedsTooSmall`: iki ucret parcasi da tavana yuvarlandigi icin
   * cok kucuk bir satis hasilatini tamamen yutar.
   */
  | { kind: 'unfillable'; errorName: string }
  /** Sahibin fonu yetmiyor. TERMINAL DEGIL -- bkz. asagidaki not. */
  | { kind: 'underfunded'; held: bigint; needed: bigint }

/** Bir emrin degerlendirilmesi icin gereken her sey. */
export type TriggerInput = {
  readonly isBuy: boolean
  /** ALIMDA `msg.value`, SATIMDA `tokensIn`. */
  readonly amount: bigint
  /** ALIMDA `minTokensOut`, SATIMDA `minQuoteOut`. */
  readonly minOut: bigint
  /**
   * Sahibin ELINDEKI, emrin harcayacagi varlikta: alimda 18-decimal native
   * USDC bakiyesi, satimda token bakiyesi. `null` -> olculemedi ve bu bir
   * TETIKLEME SEBEBI DEGILDIR (asagiya bakin).
   */
  readonly held: bigint | null
}

/**
 * ============ FONU YETMEYEN EMIR: SPEC'TEN BILINCLI BIR SAPMA ============
 *
 * Spec §8'in 4. keeper gorevi "bakiyesi yetmeyen veya suresi gecmis emirleri
 * IPTAL EDER" diyor. Suresi gecmis kismi aynen uygulandi (`expireDueOrders`).
 * BAKIYE KISMI UYGULANMADI, ve gerekcesi su:
 *
 *   BIR BAKIYE ANLIKTIR, BIR EMIR DEGILDIR. Kullanici fonunu bir islem
 *   boyunca baska yere alip geri getirebilir; bir kopruden gecirebilir; gazi
 *   odedigi icin bir an icin esigin altina duşebilir. Keeper'in o anda emri
 *   SILMESI, kullanicinin bir daha geri getiremeyecegi bir seyi geri
 *   alinamaz bicimde yok etmek olurdu -- ve emrin durdugu yerde durmasinin
 *   HICBIR maliyeti yok: dolmayacagi zaten zincirde belli.
 *
 * ONUN YERINE: keeper boyle bir emri TETIKLEMEZ (yani "doldurulabilir" diye
 * isaretlemez) ve arayuz aciklamayi KENDI CANLI OKUMASINDAN yapar -- "Orders"
 * sekmesi zaten bagli cuzdanin bakiyesini okuyor. Boylece ekranda bir sey
 * eksik kalmaz ve veritabaninda o iddiayi tasiyan bir sutun da gerekmez.
 *
 * `held === null` (olculemedi) bir tetikleme SEBEBI DEGILDIR: bilinmeyen bir
 * bakiyeyle "doldurulabilir" demek, kullaniciya calismayacak bir dugme
 * gostermek olurdu. Olcum yoksa emir `open` kalir.
 */
export function triggerVerdict(
  order: TriggerInput,
  state: CurveState,
  profile: CurveProfile,
  fees: FeeBps,
): TriggerVerdict {
  /*
   * MEKAN SECIMI BURADA DEGIL, CAGIRANDA YAPILIR (`pass.ts`, `venueOf`).
   *
   * Ilk hali bu fonksiyona bir `graduated` bayragi aliyordu ve IKI DALI DA
   * ayni degeri donduruyordu -- yani bayrak hicbir sey yapmiyordu, ama bir
   * karar veriyormus GIBI duruyordu. Boyle bir parametre, ileride birinin
   * "graduated dali zaten var" diyip yanlis yere ikinci bir mekan karari
   * koymasinin davetidir. Bu fonksiyon ARTIK YALNIZCA CURVE MEKANIDIR ve
   * `complete` onun icin tek anlama gelir: burada islem yapilamaz.
   */
  if (state.complete) return { kind: 'stalled', reason: 'completeNotGraduated' }

  if (order.held !== null && order.held < order.amount) {
    return { kind: 'underfunded', held: order.held, needed: order.amount }
  }

  try {
    if (order.isBuy) {
      const plan = planBuyExactQuoteIn(state, profile, fees, order.amount, 0)
      return plan.tokens >= order.minOut
        ? { kind: 'triggered' }
        : { kind: 'notYet', got: plan.tokens, want: order.minOut }
    }
    const plan = planSellExactTokensIn(state, profile, fees, order.amount, 0)
    const net = netProceedsOf(plan)
    return net >= order.minOut
      ? { kind: 'triggered' }
      : { kind: 'notYet', got: net, want: order.minOut }
  } catch (error) {
    // PLANLAYICININ REDDI YUTULMAZ, SINIFLANDIRILIR. Bir emir zincirde asla
    // kabul edilemiyorsa bunu bilmek ISTERIZ; sessizce `notYet` demek, o emri
    // sonsuza kadar taratirdi.
    if (error instanceof TradePlanError) return { kind: 'unfillable', errorName: error.errorName }
    throw error
  }
}

/**
 * ============ HAVUZ MEKANI -- VE NE OLCULDU, NE OLCULMEDI ============
 *
 * Mezun olmus bir token curve'de degil havuzda islem gorur, ve havuzda bir
 * fiyat ANCAK TAKASI CALISTIRARAK bilinir: havuz ucreti SIFIRDIR ve `ArcpadHook`
 * payini `beforeSwap`/`afterSwap` deltalariyla alir, yani AMM matematigini
 * disarida yeniden uygulayan bir hesap hook'un payini GOREMEZ. Tek dogru kota
 * `ArcpadRouter.quote*`tir ve o `view` DEGILDIR (bilerek revert eder).
 *
 * MALIYET FARKI TASIYICIDIR VE MALIYET MODELINDE AYRI DURUR: curve emirleri
 * Multicall3 icinde TOPLU okunur (emir basina bir alt cagri), havuz emirleri
 * OKUNAMAZ -- her biri KENDI `eth_call`idir cunku revert eden bir cagri
 * `aggregate3` icinde `allowFailure` ile bir "basarisizlik" olur ve
 * `readContractBatch` her basarisizligi FIRLATIR (bkz. `chainReader.ts`).
 *
 * BU YOL CANLI BIR HAVUZA KARSI HIC CALISMADI VE CALISAMAZ: uretim
 * factory'sinin `graduationTarget`i `0x0`dir (adres defteri), yani BUGUN HICBIR
 * TOKEN MEZUN OLAMAZ ve zincirde tek bir arcpad havuzu yoktur. Burasi
 * yalnizca sentetik bir kota okuyucusuna karsi olculdu; olculmeyen sey
 * yazilidir ve bir "test edildi" iddiasi DEGILDIR.
 */
export type PoolQuoteReader = (input: {
  readonly token: string
  readonly isBuy: boolean
  readonly amountIn: bigint
}) => Promise<{ ok: true; amountOut: bigint } | { ok: false; reason: string }>

export async function poolTriggerVerdict(
  order: TriggerInput,
  token: string,
  quote: PoolQuoteReader,
): Promise<TriggerVerdict> {
  if (order.held !== null && order.held < order.amount) {
    return { kind: 'underfunded', held: order.held, needed: order.amount }
  }
  const result = await quote({ token, isBuy: order.isBuy, amountIn: order.amount })
  if (!result.ok) return { kind: 'unfillable', errorName: result.reason }
  return result.amountOut >= order.minOut
    ? { kind: 'triggered' }
    : { kind: 'notYet', got: result.amountOut, want: order.minOut }
}
