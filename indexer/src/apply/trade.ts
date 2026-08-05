import type { Address } from 'viem'
import type { Deployment, Queryable } from '@arcpad/db'
import { applyCompleted, applyGraduated, applyTrade } from '@arcpad/db'
import type { CompletedEvent, GraduatedEvent, TradeEvent } from '../logs'

/**
 * `Trade` ve `Completed` UYGULAYICISI.
 *
 * BU DOSYA SQL'IN KENDISI DEGILDIR. Yazma ifadeleri `@arcpad/db`'de
 * (`applyTrade`, `applyCompleted`) cunku "ayni araligi iki kez oynatmak ikinci
 * seferde hicbir sey yapmaz" bir SEMA ozelligi degil, (sema + yazici) ciftinin
 * ozelligidir ve o cift orada test edilir. Burada duran sey, o cifte
 * GIRMEDEN once cozulmesi gereken iki sey:
 *
 *   1. `Trade` TOKEN ADRESINI TASIMAZ. Kimlik `log.address` = curve'dur ve
 *      curve->token eslemesi yalnizca `Launched`'dan gelir. Cozum bir
 *      VERITABANI OKUMASIDIR, bellek ici bir harita degil: indexer yeniden
 *      baslatildiginda haritanin bos olmasi, gecmisi olan bir curve'un
 *      ticaretlerini sessizce dusururdu.
 *   2. `token_stats.market_cap_wei` MUTLAK yazilir ve formulu kontratin
 *      kendisiyle ayni yone yuvarlar.
 */

/**
 * Bilinmeyen bir curve'den `Trade` geldi. HALT.
 *
 * Cekme katmani curve'leri `launches`'tan kurulan izleme kumesiyle suzer, yani
 * buraya bilinmeyen bir curve gelmesi ya izleme kumesinin ya da kabul yolunun
 * bozuldugunu gosterir. Sessizce atlamak, o curve'un TUM ticaret gecmisini
 * kalici olarak dusururdu -- ve `trades.curve` yabanci anahtari zaten ayni
 * satiri reddedecekti; fark, hatanin ANLASILIR olmasi.
 */
export class UnknownCurve extends Error {
  constructor(readonly curve: Address) {
    super(
      `UnknownCurve: ${curve} icin curve_state satiri yok. Bir Trade, kabul ` +
        `edilmemis bir curve'den geldi -- izleme kumesi ya da kabul yolu bozuk.`,
    )
    this.name = 'UnknownCurve'
  }
}

export async function tokenOfCurve(db: Queryable, curve: Address): Promise<Address> {
  const { rows } = await db.query<{ token: string }>(
    'SELECT token FROM curve_state WHERE curve = $1',
    [curve.toLowerCase()],
  )
  const row = rows[0]
  if (row === undefined) throw new UnknownCurve(curve)
  return row.token as Address
}

/**
 * MARKET CAP -- MUTLAK, ve kontratla AYNI ARITMETIK.
 *
 * `CurveMath.marketCap` = `FullMath.mulDiv(Vq, N, Vt)`, yani TABANA yuvarlar.
 * Postgres'in `div(numeric, numeric)`'i sifira dogru keser; negatif olmayan
 * girdide bu tam olarak floor'dur. Task 10'un `token_overview` view'i ayni
 * ifadeyi kullanir, yani saklanan siralama anahtari ile gosterilen deger
 * AYRISAMAZ.
 *
 * `guardSeq` SIRA MUHAFIZIDIR: gec gelen ESKI bir olay YENI durumu ezemez.
 * `token_stats.last_trade_seq` zaten en yeniyi tutar, bu yuzden kosul
 * "gordugum en yeni ticaret bundan yeni degilse yaz" seklindedir.
 */
export async function writeMarketCap(
  db: Queryable,
  token: Address,
  virtualQuoteReservesWei: bigint,
  virtualTokenReservesTok: bigint,
  totalSupplyTok: bigint,
  guardSeq: bigint,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE token_stats s SET
       market_cap_wei     = div($2::numeric * $3::numeric, $4::numeric),
       ath_market_cap_wei = GREATEST(
                              s.ath_market_cap_wei,
                              div($2::numeric * $3::numeric, $4::numeric))
     WHERE s.token = $1 AND COALESCE(s.last_trade_seq, 0) <= $5::bigint`,
    [
      token.toLowerCase(),
      virtualQuoteReservesWei.toString(),
      totalSupplyTok.toString(),
      virtualTokenReservesTok.toString(),
      guardSeq.toString(),
    ],
  )
  return rowCount ?? 0
}

/**
 * Bir `Trade`i uygular. Donen sayi `trades`e GERCEKTEN eklenen satir sayisidir
 * (0 ya da 1) -- ikinci oynatimda 0.
 *
 * Market cap yazimi o sayiya BAGLIDIR. Bagli olmasaydi ikinci oynatim ayni
 * degeri tekrar yazardi; deger ayni oldugu icin zarar gorunmezdi ama
 * "ikinci gecis HICBIR SEY yazmaz" iddiasi dokum esitligiyle degil yalnizca
 * akil yurutmeyle savunulabilirdi.
 */
export async function applyTradeEvent(
  db: Queryable,
  deployment: Deployment,
  event: TradeEvent,
): Promise<number> {
  const token = await tokenOfCurve(db, event.curve)
  const inserted = await applyTrade(db, {
    kind: 'trade',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    token,
    curve: event.curve,
    trader: event.trader,
    isBuy: event.isBuy,
    tokenAmountTok: event.tokenAmountTok,
    quoteAmountWei: event.quoteAmountWei,
    // UCRET PARCALARDAN GELIR: olay `protocolFee` ve `creatorFee`'yi AYRI
    // tasir ve toplam onlarin TOPLAMIDIR, 125 bps'ten bolunmus bir sayi
    // DEGIL. Canli smoke'ta fark ticaret #1'de bir wei'dir ve escrow toplanan
    // rakami tutar.
    protocolFeeWei: event.protocolFeeWei,
    creatorFeeWei: event.creatorFeeWei,
    // DURUM MUTLAK YAZILIR: `Trade` dort rezervin dordunu de tasir, yani
    // islem sonrasi durum zincire TEKRAR SORULMADAN kurulur.
    virtualTokenReservesTok: event.virtualTokenReservesTok,
    virtualQuoteReservesWei: event.virtualQuoteReservesWei,
    realTokenReservesTok: event.realTokenReservesTok,
    realQuoteReservesWei: event.realQuoteReservesWei,
  })
  if (inserted > 0) {
    await writeMarketCap(
      db,
      token,
      event.virtualQuoteReservesWei,
      event.virtualTokenReservesTok,
      deployment.totalSupplyTok,
      event.seq,
    )
  }
  return inserted
}

/**
 * `Completed`. `curve_state.complete` bir DURUM GECISIDIR, defter satiri
 * yoktur: `WHERE NOT complete` muhafizi ikinci oynatimda hicbir satir secmez.
 *
 * Olay HER ZAMAN ayni tx'te bir `Trade`den SONRA gelir (`_settleBuy`: defter
 * -> `Trade` -> `Completed`) ve canli smoke bunu dogruluyor: fill tx'inde
 * `Trade` logIndex 1, `Completed` logIndex 2.
 */
export async function applyCompletedEvent(db: Queryable, event: CompletedEvent): Promise<number> {
  return applyCompleted(db, {
    kind: 'completed',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    token: event.token,
    realQuoteReservesWei: event.realQuoteReservesWei,
    poolSeedSupplyTok: event.poolSeedSupplyTok,
  })
}

/**
 * Bir curve, KENDI TOKEN'I OLMAYAN bir token icin olay yaydi. HALT.
 *
 * Zincirde imkansizdir -- `BondingCurve.token` `bind()`ten sonra degismez ve
 * `graduate()` tam olarak onu yayar -- ama "bugun imkansiz" bir kontrol
 * DEGILDIR. Yazim `token` uzerinden anahtarlandigi icin, eslesmeyen bir cift
 * BASKA bir curve'un satirini terminal isaretlerdi: bir kullanicinin ekraninda
 * hala islem goren bir curve'un "mezun oldu" demesi. Bu, hicbir kisitin
 * yakalayamayacagi -- her iki satir da gecerli oldugu icin -- ve sessiz
 * kalacak bir hata sinifi.
 */
export class CurveTokenMismatch extends Error {
  constructor(
    readonly curve: Address,
    readonly claimed: Address,
    readonly bound: Address,
  ) {
    super(
      `CurveTokenMismatch: ${curve} bir olayda ${claimed} token'ini bildirdi ama ` +
        `curve_state'e gore bagli token ${bound}.`,
    )
    this.name = 'CurveTokenMismatch'
  }
}

/**
 * `Graduated`. TERMINAL GECIS.
 *
 * SQL `@arcpad/db`dedir (`applyGraduated`) -- `Completed` ile ayni gerekce.
 * Burada duran sey, o yazima GIRMEDEN once yapilmasi gereken TEK sey:
 * curve->token esleşmesinin dogrulanmasi.
 *
 * `Graduated` token'i `topic1`de TASIR (`Trade`in aksine), yani yazim icin bir
 * veritabani okumasi GEREKMEZ. Okuma yine de yapiliyor ve sebebi yazim degil
 * DOGRULAMA: `tokenOfCurve` bilinmeyen bir curve'de `UnknownCurve` atar
 * (izleme kumesinin ya da kabul yolunun bozuldugunun isareti) ve eslesmeyen
 * bir cift `CurveTokenMismatch` atar. Ikisi de, sessizce YANLIS BIR SATIRI
 * terminal isaretlemenin alternatifidir.
 */
export async function applyGraduatedEvent(db: Queryable, event: GraduatedEvent): Promise<number> {
  const bound = await tokenOfCurve(db, event.curve)
  if (bound.toLowerCase() !== event.token.toLowerCase()) {
    throw new CurveTokenMismatch(event.curve, event.token, bound)
  }
  return applyGraduated(db, {
    kind: 'graduated',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    token: event.token,
    target: event.to,
    baseAmountTok: event.baseAmountTok,
    quoteAmountWei: event.quoteAmountWei,
  })
}
