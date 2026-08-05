import type { Address, Hex } from 'viem'
import { toFunctionSelector } from 'viem'
import type { Deployment, Pool, PoolClient, Queryable } from '@arcpad/db'
import {
  assertContinuous,
  getCursor,
  getDeployment,
  noteHead,
  putDeployment,
  setCursor,
  withTransaction,
} from '@arcpad/db'
import { NonCanonicalLaunch, recordRejection, rejectionOf } from './admit'
import { applyEvents, type ApplyCounts } from './apply'
import type { IndexerConfig } from './config'
import { nextRange } from './cursor'
import type { DecodedEvent, Pacer, RpcClient, WatchSet } from './logs'
import { asRpcError, createPacer, fetchRange } from './logs'
import { assertRangeApplied } from './verify'

/**
 * INGEST DONGUSU.
 *
 * EXACTLY-ONCE SEMANTIGININ TAMAMI TEK BIR CUMLEDIR: imlec, veriyi yazan
 * TRANSACTION'IN ICINDE ilerler. Cokme -> rollback -> eski imlecten tekrar ->
 * ayni satirlar tekrar yazilir -> AYNI son durum. Imleci ayri yazan bir dongu,
 * iki yazim arasinda olen bir surecte ya veri kaybeder ya cift sayar; hangisi
 * oldugu da anlasilmaz.
 */

export class DeploymentMismatch extends Error {
  constructor(
    readonly stored: Deployment,
    readonly onChain: Deployment,
  ) {
    super(
      `DeploymentMismatch: veritabani ${stored.factory} / V=${stored.virtualQuoteReservesWei} ` +
        `tasiyor, zincir ${onChain.factory} / V=${onChain.virtualQuoteReservesWei} diyor. ` +
        `Iki dagitimin verisini ayni veritabaninda karistirmak market cap'i, ilerlemeyi ve ` +
        `ucret muhasebesini SESSIZCE bozar ve GERI ALINAMAZ -- hangi satirin hangi dagitimdan ` +
        `geldigi kaydedilmemistir.`,
    )
    this.name = 'DeploymentMismatch'
  }
}

/**
 * 4-bayt selector'lar. Argumansiz view'lar, yani cagri govdesi YOKTUR.
 *
 * HESAPLANIR, YAZILMAZ. Elle yazilmis bir selector, GECERLI ama BASKA bir
 * fonksiyonu cagirabilir ve donen sayi tamamen makul gorunur -- bu depoda
 * pinlenmis bir sabitin "gecerli ama farkli" bir logu cozdugu daha once
 * yasandi. Imzalar `contracts/out/LaunchFactory.sol`un ABI'sinden okundu;
 * dogrulugu Task 12'nin CANLI testinde olculur, cunku orada gercek factory'ye
 * gercek cagri yapilir ve donen degerler zincirin kendi profiliyle
 * karsilastirilir.
 */
const SELECTOR = {
  VIRTUAL_TOKEN_RESERVES: toFunctionSelector('VIRTUAL_TOKEN_RESERVES()'),
  VIRTUAL_QUOTE_RESERVES: toFunctionSelector('VIRTUAL_QUOTE_RESERVES()'),
  SALE_SUPPLY: toFunctionSelector('SALE_SUPPLY()'),
  escrow: toFunctionSelector('escrow()'),
  protocolTreasury: toFunctionSelector('protocolTreasury()'),
} as const

async function ethCall(
  client: RpcClient,
  to: Address,
  data: string,
  pacer: Pacer,
): Promise<bigint> {
  const result = (await pacer.run(() =>
    client.request({ method: 'eth_call', params: [{ to, data }, 'latest'] }),
  )) as Hex
  if (typeof result !== 'string' || result === '0x') {
    throw new Error(`eth_call bos dondu: ${to} ${data}`)
  }
  return BigInt(result)
}

const asAddress = (word: bigint): Address =>
  `0x${word.toString(16).padStart(64, '0').slice(24)}` as Address

/**
 * PROFILI ZINCIRDEN OKU.
 *
 * Bes `eth_call`, hepsi factory'nin public immutable'lari. Arc es zamanli VE
 * ardisik cagrilari sinirladigi icin hepsi ayni havuzdan gecer -- `Promise.all`
 * yazsak da paralel kosmazlar.
 */
export async function readFactoryProfile(
  client: RpcClient,
  factory: Address,
  chainId: bigint,
  startBlock: bigint,
  pacer: Pacer,
): Promise<Deployment> {
  const virtualTokenReservesTok = await ethCall(
    client,
    factory,
    SELECTOR.VIRTUAL_TOKEN_RESERVES,
    pacer,
  )
  const virtualQuoteReservesWei = await ethCall(
    client,
    factory,
    SELECTOR.VIRTUAL_QUOTE_RESERVES,
    pacer,
  )
  const saleSupplyTok = await ethCall(client, factory, SELECTOR.SALE_SUPPLY, pacer)
  const escrow = asAddress(await ethCall(client, factory, SELECTOR.escrow, pacer))
  const protocolTreasury = asAddress(
    await ethCall(client, factory, SELECTOR.protocolTreasury, pacer),
  )

  return {
    chainId,
    factory,
    escrow,
    protocolTreasury,
    virtualTokenReservesTok,
    virtualQuoteReservesWei,
    saleSupplyTok,
    // `LaunchToken.TOTAL_SUPPLY` bir SABITTIR (1e27) ve factory onu bir getter
    // olarak yaymaz; token basina ayri bir cagri yapmak, degismeyen bir sayi
    // icin launch basina bir RPC olurdu.
    totalSupplyTok: 10n ** 27n,
    startBlock,
  }
}

/**
 * IKI DAGITIM AYNI MI.
 *
 * KARSILASTIRMAYA GIRMEYEN IKI ALAN VAR ve ikisi de bilincli:
 *
 *   `startBlock`        bir KONFIGURASYON secimidir (nereden taramaya
 *                       basladik), dagitimin kimligi degil.
 *   `protocolTreasury`  DONDURULEBILIR. Factory onu deposit aninda CANLI
 *                       okur, boylece bir rotasyon dagitilmis curve'lere de
 *                       ulasir. Kimlige dahil etmek, MESRU bir hazine
 *                       rotasyonunu `DeploymentMismatch` ile indexer'i
 *                       durduran bir olaya cevirirdi -- ve indexer o adresi
 *                       zaten hicbir hesapta kullanmiyor; ucret alicisi
 *                       `Deposited.recipient`ten gelir.
 *
 * Kimlik: zincir, factory, escrow ve EGRI PROFILI (V/T/S). Profil degisirse
 * ayni veritabaninda iki dunyanin verisi karisir ve geri donusu yoktur.
 */
export function sameDeployment(a: Deployment, b: Deployment): boolean {
  return (
    a.chainId === b.chainId &&
    a.factory.toLowerCase() === b.factory.toLowerCase() &&
    a.escrow.toLowerCase() === b.escrow.toLowerCase() &&
    a.virtualTokenReservesTok === b.virtualTokenReservesTok &&
    a.virtualQuoteReservesWei === b.virtualQuoteReservesWei &&
    a.saleSupplyTok === b.saleSupplyTok &&
    a.totalSupplyTok === b.totalSupplyTok
  )
}

/**
 * Kayitli dagitimla zincirdekini karsilastirir; uyusmazlikta HALT.
 *
 * `startBlock` KARSILASTIRMAYA GIRMEZ: o bir konfigurasyon secimidir (nereden
 * taramaya basladik), dagitimin kimligi degil. Onu da karsilastirmak, ayni
 * dagitimi daha erken bir bloktan yeniden taramak isteyen bir operatoru
 * `DeploymentMismatch` ile karsilardi.
 */
export async function ensureDeployment(pool: Pool, onChain: Deployment): Promise<Deployment> {
  const stored = await getDeployment(pool)
  if (stored === null) {
    await putDeployment(pool, onChain)
    return onChain
  }
  if (!sameDeployment(stored, onChain)) throw new DeploymentMismatch(stored, onChain)
  return stored
}

/** Izleme kumesi VERITABANINDAN kurulur, bellekten degil. */
export async function loadWatchSet(db: Queryable, deployment: Deployment): Promise<WatchSet> {
  const { rows } = await db.query<{ token: string; curve: string }>(
    'SELECT token, curve FROM launches',
  )
  return {
    factory: deployment.factory,
    escrow: deployment.escrow,
    curves: new Set(rows.map((r) => r.curve as Address)),
    tokens: new Set(rows.map((r) => r.token as Address)),
  }
}

/**
 * `volume_24h_wei` PENCERELI bir toplamdir: girisler ZAMANLA DUSER, yani
 * artimli tutulamaz. Iki tazeleme yolu vardir ve ikisi de gereklidir:
 *   - DOKUNULAN tokenlar, ayni transaction'da (yeni ticaret geldi);
 *   - DOKUNULMAYANLAR, her turda en bayat N tanesi (eski ticaretler pencereden
 *     dusuyor ve bunu tetikleyen hicbir olay YOK).
 *
 * `block_time` burada bir PENCEREDIR, bir SIRALAMA anahtari degil -- esit
 * timestamp'ler pencereyi bozmaz, siralamayi bozardi.
 */
export async function refreshVolume24h(db: Queryable, tokens: readonly string[]): Promise<number> {
  if (tokens.length === 0) return 0
  const { rowCount } = await db.query(
    `UPDATE token_stats s SET
       volume_24h_wei = COALESCE((
         SELECT sum(t.quote_amount_wei) FROM trades t
          WHERE t.token = s.token AND t.block_time >= now() - interval '24 hours'), 0),
       volume_24h_refreshed_at = now()
     WHERE s.token = ANY($1::text[])`,
    [tokens.map((t) => t.toLowerCase())],
  )
  return rowCount ?? 0
}

/** En bayat `limit` token. Dokunulmayanlarin pencereden dusmesini yakalar. */
export async function refreshStale24hVolume(db: Queryable, limit: number): Promise<number> {
  const { rows } = await db.query<{ token: string }>(
    `SELECT token FROM token_stats ORDER BY volume_24h_refreshed_at ASC LIMIT $1`,
    [limit],
  )
  return refreshVolume24h(
    db,
    rows.map((r) => r.token),
  )
}

/**
 * Bu araligin DOKUNDUGU tokenlar.
 *
 * `Trade` TOKEN ADRESINI TASIMAZ (kimlik curve'dur), yani yalnizca olaylara
 * bakan bir toplama, TICARET ALMIS ama transfer gormemis bir token'i
 * kacirirdi -- ve `volume_24h_wei` tam olarak ticaretten beslenir. Curve'ler
 * `curve_state` uzerinden tek sorguda cozulur.
 */
export async function touchedTokens(
  db: Queryable,
  events: readonly DecodedEvent[],
): Promise<string[]> {
  const tokens = new Set<string>()
  const curves = new Set<string>()
  for (const event of events) {
    if (
      event.kind === 'launched' ||
      event.kind === 'completed' ||
      event.kind === 'graduated' ||
      event.kind === 'transfer'
    ) {
      tokens.add(event.token.toLowerCase())
    }
    if (event.kind === 'trade') curves.add(event.curve.toLowerCase())
    if (event.kind === 'completed') curves.add(event.curve.toLowerCase())
    // `Graduated` token'i topic1'de TASIR, yani curve->token cozumune ihtiyaci
    // yoktur; curve yine de ekleniyor cunku bu kume `curve_state` uzerinden
    // cozulur ve iki yoldan gelen ayni token bir Set'te tek kalir.
    if (event.kind === 'graduated') curves.add(event.curve.toLowerCase())
  }
  if (curves.size > 0) {
    const { rows } = await db.query<{ token: string }>(
      'SELECT token FROM curve_state WHERE curve = ANY($1::text[])',
      [[...curves]],
    )
    for (const row of rows) tokens.add(row.token)
  }
  return [...tokens]
}

export interface RunResult {
  from: bigint
  to: bigint
  events: number
  counts: ApplyCounts
}

async function blockHash(client: RpcClient, block: bigint, pacer: Pacer): Promise<Hex> {
  const result = (await pacer.run(() =>
    client.request({
      method: 'eth_getBlockByNumber',
      params: [`0x${block.toString(16)}`, false],
    }),
  )) as { hash?: Hex; parentHash?: Hex } | null
  if (result?.hash === undefined) throw new Error(`blok ${block} okunamadi`)
  return result.hash
}

async function parentHashOf(client: RpcClient, block: bigint, pacer: Pacer): Promise<Hex> {
  const result = (await pacer.run(() =>
    client.request({
      method: 'eth_getBlockByNumber',
      params: [`0x${block.toString(16)}`, false],
    }),
  )) as { parentHash?: Hex } | null
  if (result?.parentHash === undefined) throw new Error(`blok ${block} parentHash yok`)
  return result.parentHash
}

export interface RunOnceOptions {
  pacer?: Pacer
  /** Head'i okuma yolu. Testler sabit bir head verir; uretimde `finalized`. */
  head?: (client: RpcClient) => Promise<bigint>
  volumeRefreshBatch?: number
}

async function finalizedHeadVia(client: RpcClient, pacer: Pacer): Promise<bigint> {
  const block = (await pacer.run(() =>
    client.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] }),
  )) as { number?: Hex } | null
  if (block?.number === undefined) throw new Error('finalized blok okunamadi')
  return BigInt(block.number)
}

/**
 * BIR TUR: bir aralik cek, TEK transaction'da uygula, imleci AYNI
 * transaction'da ilerlet.
 *
 * Donen `null`, "yapacak is yok" demektir (head imlece yetismis).
 */
export async function runOnce(
  pool: Pool,
  client: RpcClient,
  deployment: Deployment,
  config: IndexerConfig,
  options: RunOnceOptions = {},
): Promise<RunResult | null> {
  const pacer = options.pacer ?? createPacer({ minIntervalMs: config.minRequestIntervalMs })
  const head = await (options.head?.(client) ?? finalizedHeadVia(client, pacer))
  const cursor = await getCursor(pool)
  // Imlec yoksa `startBlock`in BIR ONCESINDEN baslariz, cunku `nextRange`
  // `cursor + 1`den acar -- yani ilk taranan blok tam olarak `startBlock`
  // olur. `startBlock = 0` durumunda negatif imlec uretmemek icin taban 0'da
  // tutulur (`nextRange` negatif imleci reddeder).
  const from = cursor?.lastBlock ?? (deployment.startBlock > 0n ? deployment.startBlock - 1n : 0n)
  const range = nextRange(from, head, config.maxSpan)
  if (range === null) {
    // BASA YETISTIK -- VE BUNU SOYLEMEK ZORUNDAYIZ.
    //
    // Eski hal burada HICBIR SEY yazmadan donuyordu, yani "yapacak is yok"
    // ile "surec olmus" veritabaninda AYNI gorunuyordu: `updated_at` yerinde
    // sayiyor, 30 saniye sonra okuma katmani "yazma durdu" diyordu. `noteHead`
    // imleci ILERLETMEZ, yalnizca gordugumuz basi ve "hala buradayim"i yazar --
    // ve boylece `blocksBehind` bos turlarda da GUNCEL kalir.
    await noteHead(pool, head)
    return null
  }

  const watch = await loadWatchSet(pool, deployment)
  const events = await fetchRange(client, watch, range.from, range.to, { pacer })

  // ZINCIR BAGI: isledigimiz araligin ILK blogunun `parentHash`'i, kayitli
  // imlecin hash'iyle uyusmali. Iki ek cagri (parentHash + to'nun hash'i)
  // aralik BASINA yapilir, blok basina degil.
  const fromParent = await parentHashOf(client, range.from, pacer)
  const toHash = await blockHash(client, range.to, pacer)

  try {
    const counts = await withTransaction(pool, async (tx: PoolClient) => {
      const current = await getCursor(tx)
      assertContinuous(current?.lastBlock ?? 0n, current?.lastBlockHash ?? null, fromParent)

      const applied = await applyEvents(tx, deployment, events)

      // COZULMUS HER OLAY DEFTERDE MI. Toplam bir kapi DEGILDIR (bkz.
      // `verify.ts`); kapi budur ve URETIM YOLUNUN uzerindedir.
      await assertRangeApplied(tx, events)

      await refreshVolume24h(tx, await touchedTokens(tx, events))
      await refreshStale24hVolume(tx, options.volumeRefreshBatch ?? config.volumeRefreshBatch)

      // IMLEC AYNI TRANSACTION ICINDE ILERLER, ve YANINDA O TURUN BASI GIDER.
      // `head` bu turun basinda `finalized`den okundu; `range.to` ondan buyuk
      // olamaz (`nextRange` kelepceler). Ikisinin farki verinin BLOK cinsinden
      // yasidir ve okuma katmani "taze" diyebilmek icin ona muhtactir.
      await setCursor(tx, range.to, toHash, head)
      return applied
    })
    return { from: range.from, to: range.to, events: events.length, counts }
  } catch (error) {
    // REDDEDILEN LAUNCH AYRI BIR BAGLANTIDA KAYDEDILIR. Ayni transaction'a
    // yazmak, rollback'in onu da yutmasi demekti -- operator elinde HICBIR IZ
    // olmadan durmus bir surec bulurdu.
    if (error instanceof NonCanonicalLaunch) {
      const launched = events.find(
        (e) => e.kind === 'launched' && e.token.toLowerCase() === error.token.toLowerCase(),
      )
      if (launched?.kind === 'launched') {
        await recordRejection(pool, rejectionOf(launched, error.expected, error.reason))
      }
    }
    throw error
  }
}

/**
 * GECICI RPC HATALARINDA USTEL GERI CEKILME + JITTER.
 *
 * IMLEC ASLA ILERLEMEZ: bu sarmalayici yalnizca `runOnce`'i tekrar cagirir ve
 * `runOnce` imleci kendi transaction'inda tasir. Kalici hatalar (HALT sinifi)
 * TEKRAR DENENMEZ -- onlar operatorun mudahalesini isteyen olgulardir ve
 * tekrar denemek yalnizca gurultuyu gizler.
 *
 * BU KUME BU DEPONUN TANIMLADIGI HER HATA SINIFINI TASIMAK ZORUNDA, VE UCU
 * EKSIKTI. `UnorderedLogs`, `SingleBlockTooLarge` ve `SplitDepthExceeded`
 * burada YOKTU; yine de "kalici" cikiyorlardi -- ama ad kontroluyle degil,
 * asagidaki BES metin sezgisinin hepsinden dusrek. Yani kimsenin yazmadigi bir
 * sebeple dogru cevap.
 *
 * VE O SEBEP GERCEKTEN COKUYOR (olculdu, tahmin degil): son sezgi
 * `\b(408|425|429|502|503|504)\b`, ve HATANIN KENDI METNI blok numarasini
 * tasiyor.
 *
 *   isTransient(new SingleBlockTooLarge(429n))   -> TRUE
 *   isTransient(new SplitDepthExceeded(429n, 503n)) -> TRUE
 *   isTransient(new LogOutOfRange(429n, 1n, 2n)) -> false   <- adi kumede
 *
 * Ucuncu satir kanitin kendisidir: ayni rakam, ayni desen, farkli sonuc --
 * korumayi yapan sey ADIN KUMEDE OLMASI. Arc'ta blok 429 bugun ulasilamaz
 * (head ~55.000.000), yani bu bir uretim arizasi DEGIL; sinifi hangi seyin
 * tuttugu sorusunun cevabidir, ve cevap "sans"ti.
 *
 * `ordering.test.ts`in kaynak-tarayan kapisi gibi, `rpc-errors.test.ts` artik
 * `this.name = '...'` atamalarini KAYNAKTAN cikarip hepsinin burada oldugunu
 * olcuyor -- yani YARIN eklenen bir sinif da sessizce dusemez.
 */
const PERMANENT = new Set([
  'DeploymentMismatch',
  'NonCanonicalLaunch',
  'RemovedLog',
  'LogOutOfRange',
  'ForbiddenEmitter',
  'MissingTimestamp',
  'MalformedLog',
  'LedgerGap',
  'ReorgDetected',
  'UnknownCurve',
  // Bir curve, bagli OLMADIGI bir token icin olay bildirdi. Yeniden denemek
  // ayni cevabi verir -- zincir degismez -- ve devam etmek BASKA bir token'in
  // satirini terminal isaretlerdi. Bu adi buraya EKLEMEYI unutmak mumkun
  // degildi: `rpc-errors.test.ts`in kaynak-tarayan kapisi sinifi yazildigi anda
  // kirildi ve siniflandirma kararini ZORLADI.
  'CurveTokenMismatch',
  'UnorderedLogs',
  'SingleBlockTooLarge',
  'SplitDepthExceeded',
])

/**
 * SINIFLANDIRMA KODA GORE YAPILIR, METNE GORE DEGIL -- CUNKU METIN BIZIM
 * ISTEGIMIZI DE TASIYOR.
 *
 * Asagidaki uc kume 2026-08-04'te CANLI Arc testnet'e (`rpc.testnet.arc.network`,
 * head 55.181.581) tek tek istek atilarak OLCULDU; hicbiri tahmin degil.
 *
 *   -32011  request limit reached      HTTP 429           GECICI
 *   -32005  rate limit exceeded        HTTP 429           GECICI
 *   -32601  method not supported                          KALICI
 *   -32602  invalid params / range too large (+oneri)     KALICI
 *   -32012  requested range too large                     KALICI
 *        3  execution reverted                            KALICI
 *
 * ARC'IN IKI AYRI HIZ SINIRI KODU VAR ve ikincisi (`-32005`) bu depoda hic
 * kayitli DEGILDI. On dort `eth_getLogs`lik olculu bir patlamada ikisi de
 * geldi, KARISIK: id 5 `-32005`, id 6 `-32011`, id 7 `-32005`... Yani ilk
 * turda "Arc'in hiz siniri kodu -32011'dir" diye yazilan sey, ULASILABILEN
 * ORNEKLEMIN tamamiydi, kumenin degil.
 *
 * BU YUZDEN SIRA ONEMLI: hiz siniri sinyali (HTTP 429 ve metin) HER TURLU
 * "kalici" kararindan ONCE okunur. Ucuncu bir hiz siniri kodu daha varsa --
 * ve yukaridaki olcum bunu dislamiyor -- kod kumesi onu tanimasa bile 429
 * yakalar. Kalici kumeyi one almak, `-32011`de yasanan HALT'in aynisini
 * bilinmeyen bir kodla tekrar etmenin acik kapisi olurdu.
 *
 * `-32614` gozlemlenmedi (bu kosuda da -32012 dondu) ama `logs.ts` onu
 * `RANGE_ERROR_CODES`te tasiyor ve ayni sinifa girer.
 *
 * SINIFLANDIRILMAYAN AMA ARTIK OLCULMUS IKI KOD (2026-08-05, ayni RPC, head
 * 55.339.691, uretim istemcisiyle -- `createArcClient`, yani viem `http()`):
 *
 *   -32603 internal error   gelecege dusen bir `eth_getLogs` araligi ve
 *                           `eth_newFilter`. UST USTE UC kez ayni yanit, yani
 *                           kendiliginden GECMIYOR. Kalici birakildi ve artik
 *                           bu bir olcum.
 *   -32001 block not found  head'in USTUNDEKI bir blokta `eth_getBalance` ve
 *                           `eth_call`. Kalici birakildi.
 *
 * IKISI DE DONGUDEN ULASILAMAZ ve gerekce yazili olmali: `runOnce` `finalized`
 * head'in otesini hic sormaz, filtre yaratmaz, `eth_getBalance` cagirmaz ve
 * `eth_call`i yalnizca `'latest'` etiketiyle yapar. Ulasilabilir olsalardi
 * yon sorusu simetrik DEGILDIR: gecici bir seyi kalici saymak sureci
 * OLDURUR (`-32011`in bir kez yaptigi sey), kalici bir seyi gecici saymak
 * bes deneme + ~3,75sn geri cekilmeye mal olur ve yine firlatir.
 *
 * OLCUMUN URETTIGI BIR YANLIS IZ, TEKRARLANMASIN DIYE YAZILIYOR: ilk kosuda
 * bozuk parametreli IKI `eth_getLogs` (gecersiz adres, gecersiz topic) ust
 * uste `-32005 rate limit exceeded` dondu ve "Arc bozuk istege hiz siniri
 * kodu veriyor" gibi gorundu. Kontrollu A/B -- gecerli/bozuk donusumlu, 1,5sn
 * arayla, uc tur -- BUNU YALANLADI: dokuz bozuk istegin dokuzu da
 * `-32602 "Invalid params"` dondu, aradaki gecerli istekler ise HEP basarili
 * oldu. Yani o `-32005` gercek bir hiz siniriydi ve sadece o ana denk geldi.
 * (Ayni kosuda 14 ES ZAMANLI `eth_getLogs`in HICBIRI reddedilmedi -- limitin
 * esigi sabit degil, ve bu da 600ms varsayilanini ve "hiz siniri sinyalini
 * kalici karardan ONCE oku" sirasini destekler.)
 *
 * `-32602` ARC'IN GENEL "gecersiz parametre" KODUDUR, yalnizca aralik kodu
 * degil: gecersiz adres, gecersiz topic, `fromBlock: 'banana'`, `from > to` ve
 * cozulemeyen bir imzali islem hepsi `-32602` doner. `logs.ts` onu
 * `RANGE_ERROR_CODES`te tutmaya DEVAM ediyor -- bolme, aralik problemi
 * olmayan bir `-32602`de yalnizca sol omurgadan asagi ~10 istek harcayip
 * `SingleBlockTooLarge` firlatir (`to === from` dalinda durur), yani sinirli;
 * ve bilinmeyen bir aralik metnini bolmeyi birakmak, calisan bir kurtarmayi
 * kaybetmek olurdu.
 */
const TRANSIENT_RPC_CODES = new Set([-32011, -32005])
const PERMANENT_RPC_CODES = new Set([-32601, -32602, -32012, -32614, 3])
const RATE_LIMIT_TEXT = /request limit reached|rate limit|too many requests/i
const RATE_LIMIT_STATUS = 429

/**
 * HTTP DURUM KODU, `status` ALANINDAN -- metinden ayiklanan rakamdan degil.
 * viem `HttpRequestError.status` tasir; OLCULDU: 429/500/502/503 icin dolu.
 *
 * 500 BURADA, ama asagidaki metin yedeginde DEGIL: "500" bir protokol
 * limitinde de gecebilir (adres filtresi 500'de parcalaniyor), ve orada
 * `status` yoktur.
 */
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export function isTransient(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  if (name !== undefined && PERMANENT.has(name)) return false

  // `details`, `message` DEGIL. OLCULDU (2026-08-04): viem bicimlendirilmis
  // mesaja `URL: https://rpc.testnet.arc.network` ve `Request body: {...}`
  // koyar; eski `/network/i` deseni RPC ADRESININ KENDISINE tutuyordu ve
  // canliya atilan ON ALTI istegin HEPSI -- reddedilen `eth_call` ve
  // desteklenmeyen metod dahil -- GECICI cikiyordu. Yani bu fonksiyonun
  // yazili varsayilani ("bilinmeyen KALICIDIR") uretimde HIC gecerli
  // degildi. Bir alan adi degisikligi de aynisini ters yone cevirirdi.
  const { code, status, details } = asRpcError(error)

  // HIZ SINIRI EN ONCE. Arc'in BILINEN iki kodu var ve ikisi de HTTP 429 ile
  // geliyor; bilinmeyen bir ucuncusu de 429 ile gelirdi. Bu iki satiri kalici
  // kararin ONUNE almak, `-32011`de bir kez yasanmis olan "hiz siniri
  // yuzunden HALT"i bilinmeyen bir kodla tekrarlamayi yapisal olarak
  // imkansiz kilar.
  if (status === RATE_LIMIT_STATUS) return true
  if (RATE_LIMIT_TEXT.test(details)) return true

  if (code !== undefined) {
    if (TRANSIENT_RPC_CODES.has(code)) return true
    if (PERMANENT_RPC_CODES.has(code)) return false
  }
  if (status !== undefined) return TRANSIENT_HTTP_STATUS.has(status)

  // ZAMAN ASIMI. OLCULDU: viem'in `TimeoutError`i "The request timed out." /
  // "The request took too long to respond." der -- ikisinde de "timeout"
  // KELIMESI GECMEZ, yani eski desen onu KALICI sayiyordu ve URETIM istemcisi
  // (`createArcClient`, viem varsayilani 10sn x 4 deneme = ~41sn, OLCULDU)
  // asili bir RPC'de dongoyu DURDURUYORDU. Bugun bu kusur gorunmuyordu cunku
  // yukaridaki `/network/i` kazasi onu ortuyordu: yanlis bir sebeple gecen
  // bir davranis.
  if (/timed out|timeout|took too long/i.test(details)) return true
  if (/fetch failed|socket|ECONN|EAI_AGAIN|ETIMEDOUT|EPIPE|network error/i.test(details)) {
    return true
  }
  // YEDEK: `status` tasimayan bir transport icin. `details` artik SUNUCUNUN
  // metni oldugu ve URL/istek govdesi ICERMEDIGI icin ciplak rakam aramak
  // burada guvenli; ayni desen `message` uzerinde D1'in ta kendisiydi.
  if (/\b(408|425|429|502|503|504)\b/.test(details)) return true

  // Bilinmeyen bir hata GECICI SAYILMAZ. Varsayilan yon onemli: gecici saymak,
  // gercek bir kusuru bes kez tekrarlayip sessizce gizlemek olurdu.
  return false
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 250 * 2 ** attempt)
  // JITTER: sabit gecikmeler, ayni anda geri cekilen iki indexer'i AYNI anda
  // geri getirir.
  return Math.floor(base / 2 + random() * (base / 2))
}

export async function runWithRetry(
  pool: Pool,
  client: RpcClient,
  deployment: Deployment,
  config: IndexerConfig,
  options: RunOnceOptions & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RunResult | null> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    try {
      return await runOnce(pool, client, deployment, config, options)
    } catch (error) {
      if (!isTransient(error)) throw error
      lastError = error
      if (attempt + 1 < config.maxAttempts) await sleep(backoffMs(attempt))
    }
  }
  throw lastError
}
