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
   * Taramanin BASLADIGI blok (factory'nin deploy edildigi blok).
   *
   * DAHA GEC baslamak launch KAYBEDER ve bu GERI ALINAMAZ: kacirilan
   * launch'in token adresi hic ogrenilmez, yani onun `Transfer`'lari da hic
   * cekilmez. Daha erken baslamak yalnizca bos aralik tarar.
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

function number(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${key} pozitif bir sayi olmali`)
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
    minRequestIntervalMs: number(
      env,
      'INDEXER_MIN_REQUEST_INTERVAL_MS',
      DEFAULT_MIN_REQUEST_INTERVAL_MS,
    ),
  }
}
