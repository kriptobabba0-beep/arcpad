import type { Hex } from 'viem'
import type { Deployment, Queryable } from '@arcpad/db'
import { applyPoolSwap } from '@arcpad/db'
import type { PoolSwapEvent } from '../logs'
import { impliedReserves, quoteUnitsToWei } from '../pool'
import { writeMarketCap } from './trade'

/**
 * `Swap` UYGULAYICISI -- MEZUNIYETTEN SONRAKI FIYAT GECMISI.
 *
 * BU DOSYANIN TEK ISI, IKI VENUE'NUN AYNI TABLOYA AYNI ANLAMLA YAZMASINI
 * SAGLAMAKTIR. `source = 'pool'` bir etikettir; etiket, sutunlarin ANLAMINI
 * degistirmez. Bir havuz satirinin fiyati egri satirlarindan BASKA bir kurala
 * gore hesaplanirsa, "fiyat gecmisi kopmaz" iddiasi kopmadan YALAN olur --
 * grafik kesintisiz cizilir ve yanlisi gosterir.
 *
 * UC ESLEME, VE UCU DE OLCULDU:
 *
 *   MIKTAR   Egri `Trade.quoteAmount`i EGRININ rezervlerine giren/cikan tutar
 *            olarak yayar: alista `curveIn` (UCRET HARIC -- kullanici
 *            `curveIn + fees` oder), satista `proceeds` (UCRET DAHIL --
 *            kullanici `proceeds - fees` alir). Yani her iki yonde de tanim
 *            "FIYATI HAREKET ETTIREN tutar"dir.
 *            V4'un `Swap.amount0/1`i TAM OLARAK ayni seyi verir: hook ucreti
 *            `beforeSwap`ta girdiyi KUCULTEREK (`amountToSwap += hookDelta`)
 *            ya da `afterSwap`ta ciktidan alarak tahsil eder, ve `Swap` logu
 *            `_swap`in ICINDE, `afterSwap` deltasindan ONCE yayilir --
 *            dolayisiyla tasidigi miktar havuza GIREN/CIKAN, yani ucretsiz,
 *            fiyati hareket ettiren tutardir. Iki tanim CAKISIR; donusum
 *            yalnizca 10^12'dir.
 *
 *   YON      Egride `isBuy` bir bayraktir. Havuzda ISARETTEN cikar: `Swap`
 *            deltalari CAGIRANIN deltalaridir (negatif = cagiran oder), yani
 *            "quote ODENDI" = alis. Bayragi `amount0`in isaretinden okuyan bir
 *            kod, token'in `currency1` oldugu havuzlarda -- olculdu: uretim
 *            factory'sinin iki curve'unden BIRI -- her alisi satis kaydeder.
 *
 *   REZERV   Egride olayin tasidigi dort sayi. Havuzda `sqrtPriceX96` ve
 *            `liquidity`den turetilir (`../pool.ts`, `impliedReserves`), ve
 *            dikis noktasinda egrinin kapanis fiyatiyla 2.2e-10 bagil farkla
 *            ortusur.
 */

/**
 * Izleme kumesinde olmayan bir havuzdan `Swap` geldi. HALT.
 *
 * `UnknownCurve`in havuz tarafindaki ikizi, AMA DAHA KESKIN BIR SEY SOYLER:
 * havuz sorgusu `topics[1]`de tam olarak bizim turettigimiz `PoolId`
 * listesiyle SUZULUR, yani listede olmayan bir kimligin donmesi RPC'nin topic
 * filtresini UYGULAMADIGI anlamina gelir. Bu, `ForbiddenEmitter`in adres
 * filtresi icin soyledigi seyin topic filtresi icin soylenmis hali; sessizce
 * atlamak, o an gelen HER seyi -- zincirdeki baska bir V4 havuzunun islemini
 * de -- bir arcpad tokeninin gecmisine yazma riskini acik birakirdi.
 */
export class UnknownPool extends Error {
  constructor(readonly poolId: Hex) {
    super(
      `UnknownPool: ${poolId} icin izleme kumesinde kayit yok. Havuz sorgusu topics[1] ` +
        `uzerinde turetilmis PoolId listesiyle suzuluyor, yani bu log ya filtre ` +
        `uygulanmadan geldi ya da izleme kumesi bozuk.`,
    )
    this.name = 'UnknownPool'
  }
}

/**
 * `Swap`in IKI BACAGI DA SIFIR. HALT.
 *
 * V4 `amountSpecified == 0`i reddeder (`SwapAmountCannotBeZero`) ve fiyat
 * limitine oturmus bir swap de revert eder (`PriceLimitAlreadyExceeded`), yani
 * "hicbir sey hareket etmedi" bir `Swap` logu URETEMEZ. TEK BACAGI sifir olan
 * bir swap ise MESRUDUR ve yazilir (1 wei token -> 0 quote birimi; 10^12'lik
 * decimal farkinin dogrudan sonucu) -- 012 numarali migration kisiti tam
 * bunun icin gevsetildi. Ikisinin birden sifir olmasi ise yonu de miktari da
 * belirsiz birakir; yazilabilecek her deger uydurma olurdu.
 */
export class DegeneratePoolSwap extends Error {
  constructor(readonly poolId: Hex) {
    super(
      `DegeneratePoolSwap: ${poolId} havuzunda iki bacagi da sifir olan bir Swap logu. ` +
        `V4 boyle bir swap'i uretemez; yon ve miktar belirsiz.`,
    )
    this.name = 'DegeneratePoolSwap'
  }
}

/**
 * HAVUZUN KENDI LP UCRETI SIFIR OLMALI (spec §412) VE OLMADIGINDA DURMAYIZ.
 *
 * `ArcpadHook._beforeInitialize` `key.fee != 0`i reddeder ve `POOL_FEE` dinamik
 * bayrak DEGILDIR, yani hook bile havuz ucretini degistiremez. GERIYE BIR YOL
 * KALIYOR: `PoolManager`in SAHIBI (governor Safe) `setProtocolFee` ile
 * havuz basina bir PROTOKOL ucreti tanimlayabilir; o ucret girdiden kesilir,
 * `Swap.fee` alaninda gorunur ve NE hook'un olayina NE de `FeeEscrow`a ugrar.
 * Yani bu, `fee_events`in GORMEDIGI ucuncu bir ucret havuzudur.
 *
 * MESRU BIR YONETISIM EYLEMI OLDUGU ICIN HALT DEGIL UYARI: durmak, Safe'in
 * yetkisindeki bir karari indexer arizasina cevirirdi. Sessiz de kalamaz --
 * gorunmeyen bir ucret, muhasebenin sessizce eksilmesidir.
 */
export function defaultPoolFeeWarning(poolId: Hex, feeBps: number): void {
  console.warn(
    `[indexer] havuz ${poolId} icin Swap.fee = ${feeBps} (sifir bekleniyordu). ` +
      `PoolManager.setProtocolFee ile tanimlanmis bir V4 protokol ucreti, FeeEscrow'a ` +
      `UGRAMAZ ve fee_events'te GORUNMEZ.`,
  )
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value)

export interface ApplyPoolSwapOptions {
  onNonZeroPoolFee?: (poolId: Hex, feeBps: number) => void
}

export async function applyPoolSwapEvent(
  db: Queryable,
  deployment: Deployment,
  event: PoolSwapEvent,
  options: ApplyPoolSwapOptions = {},
): Promise<number> {
  const pool = event.pool
  if (pool === null) throw new UnknownPool(event.poolId)
  if (event.amount0 === 0n && event.amount1 === 0n) throw new DegeneratePoolSwap(event.poolId)
  if (event.poolFeeBps !== 0) {
    ;(options.onNonZeroPoolFee ?? defaultPoolFeeWarning)(event.poolId, event.poolFeeBps)
  }

  // SIRALAMA `PoolKey`TEN GELIR, ADRESTEN VARSAYILMAZ.
  const baseDelta = pool.tokenIsCurrency0 ? event.amount0 : event.amount1
  const quoteDelta = pool.tokenIsCurrency0 ? event.amount1 : event.amount0
  // QUOTE BACAGI ONCE: yon "para hangi yone aktı" sorusudur ve o soruya
  // cevap veren bacak quote'tur. Token bacagi yalnizca quote sifir
  // yuvarlandiginda -- yani fiyat bilgisi tasimayan toz islemlerde -- karari
  // verir.
  const isBuy = quoteDelta !== 0n ? quoteDelta < 0n : baseDelta > 0n

  const reserves = impliedReserves(event.sqrtPriceX96, event.liquidity, pool.tokenIsCurrency0)

  const inserted = await applyPoolSwap(db, {
    kind: 'poolSwap',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    token: pool.token,
    curve: pool.curve,
    trader: event.sender,
    isBuy,
    tokenAmountTok: abs(baseDelta),
    // 10^12: havuz quote'u 6 decimal ERC-20, sutun 18 decimal native wei.
    quoteAmountWei: quoteUnitsToWei(abs(quoteDelta)),
    // UCRET HAVUZDAN DEGIL HOOK'TAN GELIR ve `Swap.fee` DEGILDIR (o sifirdir).
    // `SwapFeeCollected` 6 decimal birimde yayar; escrow'a `quoteWei(...)` ile
    // 18 decimal yatirilir -- burada da AYNI donusum kullaniliyor, yani
    // `trades.protocol_fee_wei` toplamlari `fee_events`teki `Deposited`
    // tutarlariyla WEI WEI ortusur.
    protocolFeeWei: quoteUnitsToWei(event.protocolFeeUnits),
    creatorFeeWei: quoteUnitsToWei(event.creatorFeeUnits),
    ...reserves,
  })

  if (inserted > 0) {
    // ATH, MEZUNIYETTEN SONRA DA YASAR. `token_stats.ath_market_cap_wei`
    // `token_overview`in bir sutunudur; havuz islemlerinin disarida kalmasi,
    // mezuniyetten sonraki her zirveyi kaybetmek demekti. FORMUL AYNI
    // FONKSIYONDAN gecer -- ayri bir kopya, iki venue'nun market cap'ini
    // sessizce ayristirmanin en kolay yoluydu.
    await writeMarketCap(
      db,
      pool.token,
      reserves.virtualQuoteReservesWei,
      reserves.virtualTokenReservesTok,
      deployment.totalSupplyTok,
      event.seq,
    )
  }
  return inserted
}

/**
 * `PoolManager.Initialize` ve `ArcpadHook.SwapFeeCollected` icin DEFTER YOK.
 *
 * `Completed`/`Graduated` ile ayni sinif, farkli sebeplerle:
 *   `poolInitialize`  bir DOGRULAMADIR, bir olgu kaydi degil. Turetilen
 *                     `PoolKey`in bes alani cekme katmaninda zincirin kendi
 *                     ifadesine karsi tutulur (`assertDerivedPoolKey`); orada
 *                     gecen bir log burada yazilacak hicbir sey tasimaz.
 *   `poolFee`         ucret zaten `FeeEscrow.Deposited` olarak deftere girer.
 *                     Ikinci kez yazmak AYNI PARAYI iki kez saymak olurdu.
 *                     Bu olayin tek isi, ucreti dogru `trades` satirina
 *                     baglamaktir ve o is cekme katmaninda BITER.
 */
export const POOL_EVENTS_WITHOUT_LEDGER = Object.freeze(['poolInitialize', 'poolFee'] as const)
