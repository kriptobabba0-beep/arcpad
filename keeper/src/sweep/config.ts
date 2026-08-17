import { fileURLToPath } from 'node:url'
import { ARC_TESTNET_CHAIN_ID, loadAddressBook } from '@arcpad/shared'
import { type Address, getAddress, isAddress } from 'viem'
import { blankToUndefined } from '../config'
import type { SweepPolicy } from './decide'
import { DEFAULT_SWEEP_POLICY } from './decide'

/**
 * ============ SUPURUCUNUN YAPILANDIRMASI ============
 *
 * `loadGraduatorConfig`in kardesi ve ayni gerekceyi tasir: zincire YAZAN bir
 * surecin anahtari, SALT OKUR bir izleyicininkiyle ayni yapida durmamali.
 *
 * ============ HAZINE ADRESI BURADA YOK, VE BU KASITLIDIR ============
 *
 * `BuybackTreasury`nin adresi adres defterinde DEGILDIR ve olmasi da
 * gerekmez: `LaunchFactory.setBuybackTreasury` **BIR KEZ** yazilir
 * (`LaunchFactory.sol:876`), yani fabrikanin `buybackTreasury()` gorunumu o
 * adresin DEGISTIRILEMEZ kaynagidir. Giris noktasi onu acilista fabrikadan
 * okur; defterde ikinci bir kopya tutmak, zincirden sapabilecek bir kopya
 * tutmak olurdu.
 *
 * Bir override YINE DE var (`KEEPER_SWEEP_TREASURY`) cunku bir prova ya da
 * bir olay mudahalesi baska bir yigina bakmak isteyebilir -- ve override
 * kullanildiginda acilis satirinda `src=env-override` yazar.
 */

export type SweeperConfig = {
  rpcUrl: string
  rpcFallbackUrls: string
  chainId: number
  factory: Address
  /** `undefined` = acilista fabrikadan okunacak. */
  treasuryOverride: Address | undefined
  startBlock: bigint
  dryRun: boolean
  /** `undefined` = imzalayan yok. Kuru kosu ZORUNLU olur. */
  privateKey: `0x${string}` | undefined
  cursorPath: string
  alertLogPath: string | undefined
  pollIntervalMs: number
  maxPerPass: number
  logScanChunk: bigint
  maxChunksPerPass: number
  policy: SweepPolicy
  overridden: boolean
}

export const SWEEP_ALERT_COMPONENT = 'keeper.sweep'

/**
 * IMLEC AYRI DOSYADIR. Ucuncu bir surec (`pnpm start`, `pnpm graduate`,
 * `pnpm sweep`) ve ucuncu bir imlec: `fileCursorStore` `writeFileSync` +
 * `renameSync` ile yazar, iki surec ayni dosyaya yazarsa biri digerinin
 * ilerlemesini geri alir.
 */
export const DEFAULT_SWEEP_CURSOR_PATH = fileURLToPath(
  new URL('../../.cursor-sweep', import.meta.url),
)

export const SWEEP_OVERRIDE_VARS = [
  'KEEPER_SWEEP_FACTORY',
  'KEEPER_SWEEP_TREASURY',
  'KEEPER_SWEEP_START_BLOCK',
] as const

/**
 * SUPURME SIK BIR IS DEGILDIR. Bir tokenin butcesi `MIN_SWEEP_WEI`e (0,05
 * USDC) ulasmasi icin gercek ticaret hacmi gerekir; her bes saniyede bir
 * yoklamak Arc'in paylasilan hiz sinirini bir hiclige yerdi. Bir dakika,
 * en kotu halde bir supurmeyi bir dakika geciktirir ve o gecikmenin bir
 * bedeli YOKTUR -- para hazinede durur ve kimse ona dokunamaz.
 */
const DEFAULT_POLL_INTERVAL_MS = 60_000
const DEFAULT_MAX_PER_PASS = 4
const DEFAULT_LOG_SCAN_CHUNK = 10_000n
const DEFAULT_MAX_CHUNKS_PER_PASS = 1

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = blankToUndefined(raw)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function address(raw: string | undefined, name: string): Address | undefined {
  const value = blankToUndefined(raw)
  if (value === undefined) return undefined
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${JSON.stringify(value)}`)
  return getAddress(value)
}

export function loadSweeperConfig(env: NodeJS.ProcessEnv, bookDir?: string): SweeperConfig {
  const rpcUrl = blankToUndefined(env.ARC_RPC_URL)
  if (rpcUrl === undefined) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  const overridden = SWEEP_OVERRIDE_VARS.some((v) => blankToUndefined(env[v]) !== undefined)

  const book = loadAddressBook(ARC_TESTNET_CHAIN_ID, bookDir)
  const factory = address(env.KEEPER_SWEEP_FACTORY, 'KEEPER_SWEEP_FACTORY') ?? book.launchFactory

  const startRaw = blankToUndefined(env.KEEPER_SWEEP_START_BLOCK)
  const startBlock = startRaw === undefined ? book.startBlock : BigInt(startRaw)

  /*
   * KURU KOSU VARSAYILAN OLARAK ACIKTIR VE ANAHTAR YOKSA KAPATILAMAZ.
   *
   * `graduate`in ayni kurali: yayin yapabilen bir surecin varsayilani
   * "yayin yapma" olmali, ve `dryRun=false` bir anahtar OLMADAN sessizce
   * kabul edilirse surec her gecisde `send`de duser -- yani ariza gecis
   * basina bir kez, gurultuyle, ama GEC gorunur.
   */
  const key = blankToUndefined(env.KEEPER_SWEEP_PRIVATE_KEY)
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('KEEPER_SWEEP_PRIVATE_KEY must be 0x + 64 hex characters')
  }
  const dryRun = blankToUndefined(env.KEEPER_SWEEP_DRY_RUN) !== 'false'
  if (!dryRun && key === undefined) {
    throw new Error(
      'KEEPER_SWEEP_DRY_RUN=false but KEEPER_SWEEP_PRIVATE_KEY is not set. A sweeper that ' +
        'cannot sign cannot sweep, and starting it would look healthy while doing nothing.',
    )
  }

  const maxSlippageBps = positiveInt(
    env.KEEPER_SWEEP_MAX_SLIPPAGE_BPS,
    DEFAULT_SWEEP_POLICY.maxSlippageBps,
    'KEEPER_SWEEP_MAX_SLIPPAGE_BPS',
  )
  /*
   * SLIPAJ TOLERANSI, HAZINENIN FIYAT-ETKI SINIRININ ALTINDA KALMALI.
   *
   * `decide.ts` bunu NatSpec'te soyluyor ama HICBIR YERDE ZORLAMIYORDU:
   * `maxSlippageBps >= MAX_PRICE_IMPACT_BPS` (300) ise koruma hicbir zaman
   * baglamaz, cunku hazine zaten %3'te durur. Bir env degiskeniyle korumayi
   * sessizce kapatabilmek, korumayi olmamis saymaktir.
   */
  if (maxSlippageBps >= 300) {
    throw new Error(
      `KEEPER_SWEEP_MAX_SLIPPAGE_BPS=${maxSlippageBps} is at or above the treasury's ` +
        'MAX_PRICE_IMPACT_BPS (300). At that width the slippage bound can never bind -- the ' +
        'treasury stops at 3% first -- so the protection would be off while looking on.',
    )
  }

  return {
    rpcUrl,
    rpcFallbackUrls: blankToUndefined(env.ARC_RPC_FALLBACK_URLS) ?? '',
    chainId: ARC_TESTNET_CHAIN_ID,
    factory,
    treasuryOverride: address(env.KEEPER_SWEEP_TREASURY, 'KEEPER_SWEEP_TREASURY'),
    startBlock,
    dryRun,
    privateKey: key as `0x${string}` | undefined,
    cursorPath: blankToUndefined(env.KEEPER_SWEEP_CURSOR) ?? DEFAULT_SWEEP_CURSOR_PATH,
    alertLogPath: blankToUndefined(env.KEEPER_ALERT_LOG),
    pollIntervalMs: positiveInt(
      env.KEEPER_SWEEP_POLL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      'KEEPER_SWEEP_POLL_MS',
    ),
    maxPerPass: positiveInt(
      env.KEEPER_SWEEP_MAX_PER_PASS,
      DEFAULT_MAX_PER_PASS,
      'KEEPER_SWEEP_MAX_PER_PASS',
    ),
    logScanChunk: BigInt(
      positiveInt(
        env.KEEPER_SWEEP_LOG_CHUNK,
        Number(DEFAULT_LOG_SCAN_CHUNK),
        'KEEPER_SWEEP_LOG_CHUNK',
      ),
    ),
    maxChunksPerPass: positiveInt(
      env.KEEPER_SWEEP_CHUNKS_PER_PASS,
      DEFAULT_MAX_CHUNKS_PER_PASS,
      'KEEPER_SWEEP_CHUNKS_PER_PASS',
    ),
    policy: {
      maxSlippageBps,
      deadlineSeconds: positiveInt(
        env.KEEPER_SWEEP_DEADLINE_SECONDS,
        DEFAULT_SWEEP_POLICY.deadlineSeconds,
        'KEEPER_SWEEP_DEADLINE_SECONDS',
      ),
      jitterWindowMs: positiveInt(
        env.KEEPER_SWEEP_JITTER_MS,
        DEFAULT_SWEEP_POLICY.jitterWindowMs,
        'KEEPER_SWEEP_JITTER_MS',
      ),
    },
    overridden,
  }
}
