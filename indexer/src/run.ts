import type { Address, Hex } from 'viem'
import { toFunctionSelector } from 'viem'
import type { Deployment, Pool, PoolClient, Queryable } from '@arcpad/db'
import {
  assertContinuous,
  getCursor,
  getDeployment,
  noteAlive,
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

/**
 * BIR BLOK OKUNAMADI. GECICIDIR, VE BU BIR KARARDIR.
 *
 * Uc cagri yeri var (`finalized` head, `parentHash`, `to`nun hash'i) ve ucu de
 * ONCEDEN GORULMUS bir basi ya da onun altini sorar -- yani "gelecege bakmak"
 * degildir. Bir dugumun o blogu VERMEMESI iki bilinen sebepten olur ve ikisi
 * de kendiliginden gecer:
 *
 *   - `finalized` etiketi, HENUZ hicbir sey finalize etmemis bir dugumde
 *     `null` doner (yeniden baslamis / senkronize olan dugum);
 *   - bir yuk dengeleyicinin arkasindaki GERI KALMIS bir dugum, baska bir
 *     dugumde coktan final olan blok icin `null` ya da `-32001 block not
 *     found` doner.
 *
 * ONCESI: ucu de CIPLAK `new Error(...)` firlatiyordu. `name` `'Error'`di, yani
 * `PERMANENT`e girmezdi, bes metin sezgisinin hicbirine takilmazdi ve
 * `isTransient` SON SATIRINA -- "bilinmeyen KALICIDIR" -- duserdi. Sonuc: tek
 * bir bos yanit ingest'i TAMAMEN durduruyordu, ve `run.ts`in kendi yazili
 * asimetrisi ("gecici bir seyi kalici saymak sureci OLDURUR; kalici bir seyi
 * gecici saymak bes deneme + geri cekilmeye mal olur ve yine firlatir") tam
 * olarak bunun tersini soyluyordu.
 *
 * `-32001` ("block not found") BURADA cevrilir, `PERMANENT_RPC_CODES`te degil:
 * karar CAGRI YERINDE anlamlidir. Ayni kod `eth_call`/`eth_getBalance`
 * head'in USTUNDE sorulunca gercekten kalicidir (olculdu, 2026-08-05) ve o
 * yollar bundan etkilenmez.
 */
export class BlockUnavailable extends Error {
  constructor(
    readonly tag: string,
    readonly missing: string,
    cause?: unknown,
  ) {
    super(`BlockUnavailable: RPC ${tag} blogunu vermedi (${missing} yok)`)
    this.name = 'BlockUnavailable'
    if (cause !== undefined) this.cause = cause
  }
}

/** `-32001`: "block not found". Bkz. `BlockUnavailable`'in gerekcesi. */
const BLOCK_NOT_FOUND_RPC_CODE = -32001

/**
 * `eth_getBlockByNumber`, ve BOS YANIT ILE HATA AYNI OLGUYA CEVRILIR.
 *
 * Tek yer olmasi bilerek: uc cagirandan birinin ceviriyi unutmasi, o yolu
 * sessizce "bilinmeyen -> kalici" dalina geri koyardi.
 */
async function readBlock<T>(
  client: RpcClient,
  tag: string,
  field: string,
  pacer: Pacer,
): Promise<T> {
  let result: T | null
  try {
    result = (await pacer.run(() =>
      client.request({ method: 'eth_getBlockByNumber', params: [tag, false] }),
    )) as T | null
  } catch (error) {
    if (asRpcError(error).code === BLOCK_NOT_FOUND_RPC_CODE) {
      throw new BlockUnavailable(tag, field, error)
    }
    throw error
  }
  if (result === null || (result as Record<string, unknown>)[field] === undefined) {
    throw new BlockUnavailable(tag, field)
  }
  return result
}

async function blockHash(client: RpcClient, block: bigint, pacer: Pacer): Promise<Hex> {
  const result = await readBlock<{ hash: Hex }>(client, `0x${block.toString(16)}`, 'hash', pacer)
  return result.hash
}

async function parentHashOf(client: RpcClient, block: bigint, pacer: Pacer): Promise<Hex> {
  const result = await readBlock<{ parentHash: Hex }>(
    client,
    `0x${block.toString(16)}`,
    'parentHash',
    pacer,
  )
  return result.parentHash
}

export interface RunOnceOptions {
  pacer?: Pacer
  /** Head'i okuma yolu. Testler sabit bir head verir; uretimde `finalized`. */
  head?: (client: RpcClient) => Promise<bigint>
  volumeRefreshBatch?: number
}

async function finalizedHeadVia(client: RpcClient, pacer: Pacer): Promise<bigint> {
  const block = await readBlock<{ number: Hex }>(client, 'finalized', 'number', pacer)
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
 * ADI OLAN AMA KALICI OLMAYAN SINIFLAR -- VE KAPININ NEDEN IKI KUMEYE
 * IHTIYACI OLDUGU.
 *
 * Kaynak tarayan kapi (`rpc-errors.test.ts`) once "TANIMLANAN HER hata sinifi
 * ADIYLA kalicidir" diyordu. O cumle bir SINIFLANDIRMA degil, bir SAYIMDI: o
 * gune kadar yazilmis her sinifin kalici OLMASI dogruydu, ve kapi bunu bir
 * KURAL sanmisti. `BlockUnavailable` o kurali yanlislar -- bos bir blok yaniti
 * gercekten gecicidir -- ve kapinin korudugu sey aslinda "kimse siniflandirma
 * kararini ATLAYAMAZ"di, "her sey kalicidir" degil.
 *
 * Kapi bugun sunu olcuyor: TANIMLANAN HER ad, bu iki kumeden TAM OLARAK
 * BIRINDE. Kesisim bos. Yeni bir sinif yazan kisi hala karar vermek zorunda;
 * verecegi karar artik iki degerli.
 */
const RETRYABLE = new Set(['BlockUnavailable'])

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
  // ADI OLAN SINIFIN KARARI HER SEYIN ONUNDE, IKI YONE DE. `BlockUnavailable`
  // govdesi hicbir sezgiye TAKILMAZ ("blok ... vermedi" -- ne durum kodu ne
  // zaman asimi kelimesi) -- yani bu satir olmadan son satira, "bilinmeyen
  // KALICIDIR"a duserdi. `rpc-errors.test.ts` bunu adi DUSURULMUS ayni
  // nesneyle olcuyor.
  if (name !== undefined && RETRYABLE.has(name)) return true

  // `details`, `message` DEGIL. OLCULDU (2026-08-04): viem bicimlendirilmis
  // mesaja `URL: https://rpc.testnet.arc.network` ve `Request body: {...}`
  // koyar; eski `/network/i` deseni RPC ADRESININ KENDISINE tutuyordu ve
  // canliya atilan ON ALTI istegin HEPSI -- reddedilen `eth_call` ve
  // desteklenmeyen metod dahil -- GECICI cikiyordu. Yani bu fonksiyonun
  // yazili varsayilani ("bilinmeyen KALICIDIR") uretimde HIC gecerli
  // degildi. Bir alan adi degisikligi de aynisini ters yone cevirirdi.
  const { code, status, details } = asRpcError(error)

  // HIZ SINIRI EN ONCE. Arc'in BILINEN iki kodu var ve ikisi de HTTP 429 ile
  // geliyor; bilinmeyen bir ucuncusu de 429 ile gelirdi. Bu satiri kalici
  // kararin ONUNE almak, `-32011`de bir kez yasanmis olan "hiz siniri
  // yuzunden HALT"i bilinmeyen bir kodla tekrarlamayi yapisal olarak
  // imkansiz kilar.
  //
  // `isRateLimit` AYNI kararin tek kopyasidir ve geri cekilme merdivenini de o
  // secer -- iki yerde iki kopya, "gecici sayilan ama kisa butceyle yeniden
  // denenen" bir kodun yeniden dogmasi demekti.
  if (isRateLimit(error)) return true

  if (code !== undefined) {
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

/**
 * HIZ SINIRI MI. `isTransient`in ILK IKI SATIRIYLA AYNI KARAR, TEK YERDE.
 *
 * Ayri bir kopya yazmak, iki siniflandirmanin sessizce ayrismasi demekti --
 * ve bu dosya zaten "ayni olguya iki yerden bakan iki kod" arizasini bir kez
 * yasadi. `isTransient` bunu cagirir; geri cekilme merdivenini secen de bu.
 */
export function isRateLimit(error: unknown): boolean {
  const { code, status, details } = asRpcError(error)
  if (status === RATE_LIMIT_STATUS) return true
  if (RATE_LIMIT_TEXT.test(details)) return true
  return code !== undefined && TRANSIENT_RPC_CODES.has(code)
}

/** Genel gecici hata merdiveninin tabani. Degismedi. */
export const DEFAULT_BACKOFF_BASE_MS = 250

/**
 * ================== HIZ SINIRININ KENDI MERDIVENI ==================
 *
 * OLCULDU (2026-08-05, canli `rpc.testnet.arc.network`). Once limit tetiklendi
 * -- HER TURDA tam UC bosluksuz `eth_getLogs` yetti, bes turun besinde -- sonra
 * AYNI istek sabit araliklarla bes kez tekrar edildi:
 *
 *   after    0ms spacing: -32005 ok ok -32005 -32005
 *   after  250ms spacing: ok ok -32005 ok -32005
 *   after 1000ms spacing: ok ok ok ok ok
 *   after 3000ms spacing: ok ok ok ok -32005
 *   after 6000ms spacing: ok ok ok ok ok
 *
 * IKI SEY OKUNUYOR, ve ikincisi bir sabiti buyutmekten daha onemli:
 *
 *   1. 250ms'lik taban YETERSIZ: o aralikta bes denemenin ikisi reddedildi.
 *      Eski merdiven `min(30s, 250*2^a)`'nin YARISI + jitter'di ve
 *      `maxAttempts = 5` ile TOPLAM bekleme 1,9-3,75 saniyeydi. Yani indexer,
 *      limitin gectigi araliga VARMADAN pes ediyordu.
 *   2. "YETERINCE YAVAS" DIYE BIR SAYI YOK: 3000ms'de bir ret var, 1000ms'de
 *      hic yok. Esik sabit degil, ucun genel yukune bagli (`chainReader.ts`
 *      ayni sonucu bagimsiz olcmustu). Dolayisiyla dogru care "daha buyuk bir
 *      sabit" DEGIL, "yeterince cok deneme + jitter"dir; sabit yalnizca ilk
 *      denemenin bosa gitmemesini saglar.
 *
 * Taban 1 saniye, ve butce ayri (`rateLimitMaxAttempts`, varsayilan 8):
 * denemeler bagimsiz kabul edilirse (olculen ret orani ~%24) sekiz denemeden
 * sonra kalan ariza olasiligi ~1e-5, ve en kotu durumda toplam bekleme ~90
 * saniyedir. Bir indexer icin 90 saniyelik gecikme, `exit 1`den kiyaslanamaz
 * olcude ucuzdur.
 */
export const RATE_LIMIT_BACKOFF_BASE_MS = 1_000

/**
 * ============ GERI CEKILIRKEN SUSMAK, OLMEKLE AYNI GORUNUYORDU ============
 *
 * Merdiven buyudu (yukarisi) ve o buyume, TAZELIK SOZLESMESINI kirdi. Iki
 * duzeltme tek tek dogruydu ve BIRLIKTE yanlis oldu.
 *
 * OLCULDU, gercek merdiven ve gercek sunucu saatiyle (mock yok): sekiz
 * denemelik tam ladder 68,6 saniye surdu (514, 1167, 2742, 4638, 9289, 20685,
 * 29548 ms) ve 4 saniye arayla alinan 18 orneklemin 10'u `writes-stalled`
 * dedi -- yani "indexer durmus olabilir" -- indexer o sirada her denemeyi
 * loglayarak yasadigini kanitlarken. `blocksBehind: 767504` her orneklemde
 * yerindeydi ve hicbirinde kullanilmadi.
 *
 * Cozum esigi buyutmek DEGIL (o, gercek bir olumu de gizlerdi): uykunun
 * ICINDEN canlilik atmak. Bu sabit, iki atis arasindaki EN BUYUK bosluktur ve
 * `DEFAULT_STALE_AFTER_SECONDS`in (30 sn) UCTE BIRIDIR -- yani tek bir
 * kacirilmis atis bile esigi asamaz. Merdiven ne kadar buyurse buyusun bu
 * bosluk sabit kalir; iliski "esik > en uzun uyku" degil, "esik > atis
 * araligi"dir, ve ikincisi merdivenden BAGIMSIZDIR.
 */
export const LIVENESS_BEAT_MS = 10_000

/**
 * Uykuyu dilimler ve her dilimden ONCE canlilik atar; sonda bir kez daha atar
 * ki uyanma ile bir sonraki yazma arasinda uzun bir sessizlik kalmasin.
 *
 * `sleep` disaridan verilebilir (testler), ama `noteAlive` GERCEK veritabanina
 * gider: bu fonksiyonun butun anlami veritabanindaki damgayi tazelemektir ve
 * onu sahtelemek, olcmek istedigi seyi olcmemek olurdu.
 */
export async function sleepWithLiveness(
  pool: Pool,
  totalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  /**
   * CANLILIK YAZMASI GERI CEKILMEYI OLDUREMEZ.
   *
   * Bu satir bir duzeltmenin ICINE konan bir kusuru kapatiyor: `noteAlive`
   * ciplak birakilsaydi, veritabani da erisilemez oldugunda (RPC hiz siniri ve
   * DB kesintisi ayni anda gayet olabilir) bir HIZ SINIRI yeniden denemesi,
   * veritabani hatasiyla YUKARI kacardi -- `isTransient` onu bilmez, dongu
   * dusun. Yani "sessiz kalmayalim" diye eklenen sey, sureci oldururdu.
   *
   * Yutulmasi da sessiz degil: veritabani gercekten kapaliysa `runOnce` bir
   * sonraki denemede zaten kendi hatasini verir, ve o hata TESHIS EDICIDIR.
   */
  const beat = async (): Promise<void> => {
    try {
      await noteAlive(pool)
    } catch {
      /* bkz. yukarisi */
    }
  }
  let remaining = totalMs
  while (remaining > 0) {
    await beat()
    const slice = Math.min(remaining, LIVENESS_BEAT_MS)
    await sleep(slice)
    remaining -= slice
  }
  await beat()
}

export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs: number = DEFAULT_BACKOFF_BASE_MS,
): number {
  const base = Math.min(30_000, baseMs * 2 ** attempt)
  // JITTER: sabit gecikmeler, ayni anda geri cekilen iki indexer'i AYNI anda
  // geri getirir.
  return Math.floor(base / 2 + random() * (base / 2))
}

/**
 * IKI AYRI BUTCE, TEK DONGU.
 *
 * Hiz siniri ile "bilinmeyen gecici hata" ayni sey degildir ve ayni butceyi
 * paylasmamalari gerekir: birincisi GECER (olculdu), ikincisi hakkinda bir
 * sey bilmiyoruz ve onu sekiz kez tekrarlamak gercek bir kusuru gizler.
 * Sayaclar ayri oldugu icin, bir hiz siniri firtinasi genel butceyi TUKETMEZ.
 */
export async function runWithRetry(
  pool: Pool,
  client: RpcClient,
  deployment: Deployment,
  config: IndexerConfig,
  options: RunOnceOptions & {
    sleep?: (ms: number) => Promise<void>
    /**
     * HER GERI CEKILME GORUNURDUR.
     *
     * Eski hal her yeniden denemeyi SESSIZCE yutuyordu: operatorun gordugu tek
     * sey ya normal ilerleme ya da `exit 1`di. Yani "hiz sinirina carpiyorum
     * ama toparliyorum" -- yani duzeltmenin ta kendisinin CALISTIGI durum --
     * hicbir yerde gorunmuyordu, ve gorunmeyen bir toparlanma ile hic olmayan
     * bir sorun ayni loga sahiptir.
     */
    onRetry?: (info: {
      rateLimited: boolean
      attempt: number
      delayMs: number
      error: unknown
    }) => void
  } = {},
): Promise<RunResult | null> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const onRetry =
    options.onRetry ??
    ((info): void => {
      const { details } = asRpcError(info.error)
      console.warn(
        `[indexer] ${info.rateLimited ? 'RATE LIMITED' : 'transient RPC error'}, ` +
          `retrying in ${info.delayMs}ms (attempt ${info.attempt}/${
            info.rateLimited ? config.rateLimitMaxAttempts : config.maxAttempts
          }): ${details}`,
      )
    })
  let lastError: unknown
  let attempts = 0
  let rateLimited = 0
  for (;;) {
    try {
      return await runOnce(pool, client, deployment, config, options)
    } catch (error) {
      if (!isTransient(error)) throw error
      lastError = error
      const limited = isRateLimit(error)
      if (limited) {
        rateLimited += 1
        if (rateLimited >= config.rateLimitMaxAttempts) throw lastError
      } else {
        attempts += 1
        if (attempts >= config.maxAttempts) throw lastError
      }
      const attempt = limited ? rateLimited : attempts
      const delayMs = limited
        ? backoffMs(rateLimited - 1, Math.random, RATE_LIMIT_BACKOFF_BASE_MS)
        : backoffMs(attempts - 1)
      onRetry({ rateLimited: limited, attempt, delayMs, error })
      // UYURKEN DE CANLIYIZ, VE BUNU SOYLEMEK ZORUNDAYIZ. Duz bir
      // `await sleep(delayMs)` idi; o sessizlik okuma katmanina "surec durmus"
      // dedirtiyordu (bkz. `LIVENESS_BEAT_MS`).
      await sleepWithLiveness(pool, delayMs, sleep)
    }
  }
}
