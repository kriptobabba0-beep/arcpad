import type { Address } from 'viem'
import { ARC_GETLOGS_MAX_RANGE } from './cursor'

/**
 * INDEXER KONFIGURASYONU.
 *
 * BURADA OLMAYAN SEY ONEMLI: egri profili (V, T, S) ve escrow adresi
 * `.env`den OKUNMAZ. Ikisi de ZINCIRDEN, factory'nin public immutable'
 * larindan gelir (`run.ts:readFactoryProfile`). Gerekce olculdu: testnet ile
 * uretim YALNIZCA `V`'de ayrisir (tam 1000x) ve yanlis bir `V` market cap'i
 * 1000 kat kaydirir -- hicbir CHECK, hicbir tip, hicbir test bunu goremez
 * cunku 1000x'lik bir sayi tamamen gecerlidir. Env'den okunabilen tek adres
 * FACTORY'dir, cunku o "hangi dagitim" sorusunun ta kendisidir.
 */
export interface IndexerConfig {
  rpcUrl: string
  databaseUrl: string
  factory: Address
  /**
   * Taramanin BASLADIGI blok. Defterin `startBlock`u, yani
   * `min(feeEscrowBlock, launchFactoryBlock)` -- FACTORY'NIN BLOGU DEGIL.
   *
   * DAHA GEC baslamak launch KAYBEDER ve bu GERI ALINAMAZ: kacirilan
   * launch'in token adresi hic ogrenilmez, yani onun `Transfer`'lari da hic
   * cekilmez. Daha erken baslamak yalnizca bos aralik tarar.
   *
   * FAZ 2 BU ASIMETRIYI AGIRLASTIRDI, VE SEMANIN GEREKCESINI ESKITTI.
   * `contracts/deploy/addresses.schema.json` `min(...)`i "bugun factory
   * blogundan baslamak hicbir sey kacirmaz; ILERIDE escrow-onceli bir olay
   * eklenirse kacirirdi" diye gerekcelendiriyor. O cumle 2026-08-06'dan beri
   * YANLIS: Faz 2 factory'yi yeniden dagitip escrow'u DEVRALDI, yani mesele
   * gelecekteki bir olay TURU degil, paylasilan escrow'un GECMISI.
   *
   * OLCULDU (canli, 2026-08-09): `[feeEscrowBlock, launchFactoryBlock)`
   * araliginda -- 1.208.824 blok -- tam SEKIZ `Deposited` var,
   * 152069146725900635 wei, ve alicilari Faz 2'nin odedigi IKI ALICININ TA
   * KENDISI. Yani `min(...)` artik ihtiyat degil ZORUNLULUKTUR; gerekcesi
   * degisti, karari degismedi. Ayrintisi ve kilitlenme mekanizmasi:
   * `run.ts`, `StartBlockAfterEscrow`. O kapi bu alani ACILISTA dogrular.
   *
   * BEDELI YAZILI OLSUN: bos on ek (1,21M blok) her SOGUK BASLANGICTA
   * yeniden yurunur. Olculdu -- 121 `eth_getLogs`, 600ms taban, 52 hiz
   * siniri geri cekilmesi, 482 saniye -- ve uretim dongusu aralik basina
   * DORT cagri yapar (factory `Launched`, escrow, `parentHash`, `to` hash'i;
   * `curves`/`tokens` bos oldugu icin bedava), yani ~32-35 dakika. Bu bir
   * KUSUR DEGIL, paylasilan escrow'un fiyatidir ve veritabani basina BIR KEZ
   * odenir; okuma katmani bu sure boyunca zaten `behind-head` der.
   */
  startBlock: bigint
  /** Bir turda taranacak en genis aralik. `ARC_GETLOGS_MAX_RANGE` ile sinirli. */
  maxSpan: bigint
  /** Head'e yetistigimizde beklenecek sure. */
  pollMs: number
  /** Her turda tazelenecek en bayat `volume_24h_wei` token sayisi. */
  volumeRefreshBatch: number
  /** Gecici RPC hatalarinda en fazla kac deneme. */
  maxAttempts: number
  /**
   * HIZ SINIRINDA en fazla kac deneme -- AYRI BIR BUTCE.
   *
   * `maxAttempts` ile paylasilmamasinin sebebi olculdu: Arc'in hiz siniri
   * GECER (bkz. `run.ts`in merdiven olcumu), bilinmeyen bir gecici hata ise
   * hakkinda hicbir sey bilmedigimiz seydir. Ikisini ayni sayaca baglamak, ya
   * hiz sinirinda erken pes etmek (olculdu: `exit 1`) ya da gercek bir kusuru
   * sekiz kez tekrarlayip gizlemek demekti.
   */
  rateLimitMaxAttempts: number
  /** Istekler arasindaki en kucuk bosluk (Arc ardisik istekleri de sinirlar). */
  minRequestIntervalMs: number
}

/**
 * ISTEKLER ARASI EN KUCUK BOSLUK -- VARSAYILANI 0 OLAMAZ.
 *
 * Arc ES ZAMANLI VE ARDISIK istekleri sinirlar. OLCULEN IKI NOKTA:
 *   250ms araliklarla alti `eth_call` -> IKISI `-32011 request limit reached`
 *                                        (2026-08-02)
 *   900ms araliklarla on alti karisik istek -> HICBIRI reddedilmedi
 *                                        (2026-08-04)
 * Canli entegrasyon testi 600ms kullaniyor ve temiz kosuyor; varsayilan o.
 *
 * Onceki varsayilan 0'di, yani URETIM hic beklemeden istek atiyordu -- pacing
 * mekanizma olarak test edilmisti ama DEGERI hicbir olcume dayanmiyordu.
 * Maliyet ihmal edilebilir: bir aralik dort sorgudur (2,4sn) ve zincir ayni
 * 1.000 blogu ~350sn'de uretir.
 */
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 600

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (value === undefined || value === '') {
    throw new Error(`${key} ayarli degil (bkz. .env.example)`)
  }
  return value
}

/**
 * TABAN ANAHTAR BASINA, CUNKU SIFIR HER ANAHTARDA AYNI SEY DEGIL.
 *
 * Onceki hal her sayisal alani `value <= 0` ile reddediyordu ve bu, BIR
 * ANAHTARDA yanlisti: `INDEXER_MIN_REQUEST_INTERVAL_MS=0` MESRU bir degerdir
 * ("pacing yok") ve `createPacer` onu zaten destekliyor -- `minIntervalMs`in
 * KENDI varsayilani 0 ve fonksiyon `Math.max(0, ...)` ile kelepceliyor. Yani
 * kutuphane kabul ediyor, konfigurasyon yuzeyi ETMIYORDU: kendi RPC'sini
 * kosturan ya da testte pacing'i kapatmak isteyen bir operator degeri
 * geciremez, `0` verirse surec ACILISTA olur.
 *
 * Otekilerin tabani 1 KALIR ve bu da anlamli: `INDEXER_POLL_MS=0` mesgul
 * dongu, `INDEXER_MAX_ATTEMPTS=0` "hic deneme", `INDEXER_VOLUME_REFRESH_BATCH=0`
 * hicbir zaman tazelenmeyen 24s hacmi demektir. Ucu de sessiz arizadir.
 *
 * `min` ayrica (0,1) araligindaki kesirleri de reddeder; eskiden gecerlerdi ve
 * hicbiri anlamli degildi (`INDEXER_MAX_SPAN=0.5` zaten `BigInt()`te patliyordu,
 * ama ACILIS hatasi degil CALISMA ZAMANI hatasi olarak).
 */
function number(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) {
    throw new RangeError(`${key} en az ${min} olan bir sayi olmali (verilen: ${raw})`)
  }
  return value
}

/**
 * `MAX_SPAN` VARSAYILANI 1.000 ve bu OLCULMUS bir sayidir: RPC'nin KENDI
 * onerdigi yeniden deneme araligi filtresiz bir sorgu icin 903 bloktu, yani
 * 1.000 zincirin kendi log yogunluguyla ayni mertebede. Adres filtreli
 * sorgularimiz kesinlikle bunun altindadir.
 *
 * Ust sinir `ARC_GETLOGS_MAX_RANGE`tir (10.000, olculdu) ve ACILISTA iddia
 * edilir: sinirin ustunde bir deger HER cagriyi hataya cevirirdi ve bunu bir
 * baslangic hatasi yapmak, her turda tekrarlanan bir calisma zamani
 * hatasindan iyidir.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const factory = required(env, 'ARC_FACTORY_ADDRESS')
  if (!ADDRESS.test(factory)) throw new RangeError(`ARC_FACTORY_ADDRESS adres degil: ${factory}`)

  const maxSpan = BigInt(number(env, 'INDEXER_MAX_SPAN', 1_000))
  if (maxSpan > ARC_GETLOGS_MAX_RANGE) {
    throw new RangeError(`INDEXER_MAX_SPAN ${maxSpan} > ${ARC_GETLOGS_MAX_RANGE}`)
  }

  const startBlock = BigInt(required(env, 'ARC_START_BLOCK'))
  if (startBlock < 0n) throw new RangeError('ARC_START_BLOCK negatif olamaz')

  return {
    rpcUrl: required(env, 'ARC_RPC_URL'),
    databaseUrl: required(env, 'DATABASE_URL'),
    factory: factory.toLowerCase() as Address,
    startBlock,
    maxSpan,
    pollMs: number(env, 'INDEXER_POLL_MS', 500),
    volumeRefreshBatch: number(env, 'INDEXER_VOLUME_REFRESH_BATCH', 500),
    maxAttempts: number(env, 'INDEXER_MAX_ATTEMPTS', 5),
    // 8: olculen ret orani ~%24 ise sekiz bagimsiz denemeden sonra kalan
    // ariza olasiligi ~1e-5. Bkz. `run.ts`, `RATE_LIMIT_BACKOFF_BASE_MS`.
    rateLimitMaxAttempts: number(env, 'INDEXER_RATE_LIMIT_MAX_ATTEMPTS', 8),
    // TABAN 0: bkz. `number`. Varsayilan 600 kalir; SIFIR ancak ACIKCA
    // yazildiginda gecer ve "pacing yok" demektir.
    minRequestIntervalMs: number(
      env,
      'INDEXER_MIN_REQUEST_INTERVAL_MS',
      DEFAULT_MIN_REQUEST_INTERVAL_MS,
      0,
    ),
  }
}
