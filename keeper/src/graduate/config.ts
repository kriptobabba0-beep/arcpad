import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARC_TESTNET_CHAIN_ID, loadAddressBook } from '@arcpad/shared'
import { type Address, getAddress, isAddress } from 'viem'
import { blankToUndefined, REPO_ROOT } from '../config'

/**
 * ============ YURUTUCUNUN YAPILANDIRMASI ============
 *
 * AYRI BIR YUKLEYICI, `loadWatcherConfig`e alan eklemek yerine, ve gerekce
 * `loadWatcherConfig`in kendi gerekcesinin AYNADAKI HALI: izleyici SALT
 * OKURDUR ve `KEEPER_DRY_RUN` onu kapatmaz; yurutucu ZINCIRE YAZAR ve
 * `KEEPER_DRY_RUN` onun ANA anahtaridir. Ikisini tek bir yapiya koymak, biri
 * digerinin kapisini tasiyan iki farkli guven seviyesini ayni yerde tutmak
 * olurdu.
 */

export type GraduatorConfig = {
  rpcUrl: string
  chainId: number
  factory: Address
  locker: Address
  startBlock: bigint
  dryRun: boolean
  /** `undefined` = imzalayan yok. Kuru kosu ZORUNLU olur. */
  privateKey: `0x${string}` | undefined
  cursorPath: string
  statePath: string
  lockDir: string
  alertLogPath: string | undefined
  pollIntervalMs: number
  maxPerPass: number
  logScanChunk: bigint
  maxChunksPerPass: number
  /** Defter yerine acik env ile kuruldu mu. Sayfada ve acilis satirinda gorunur. */
  overridden: boolean
}

export const GRADUATE_ALERT_COMPONENT = 'keeper.graduate'

export const DEFAULT_GRADUATE_CURSOR_PATH = fileURLToPath(
  new URL('../../.cursor-graduate', import.meta.url),
)
export const DEFAULT_GRADUATE_STATE_PATH = fileURLToPath(
  new URL('../../.graduate-state.json', import.meta.url),
)
export const DEFAULT_GRADUATE_LOCK_DIR = fileURLToPath(
  new URL('../../.graduate-locks', import.meta.url),
)

const DEFAULT_POLL_INTERVAL_MS = 15_000
const DEFAULT_MAX_PER_PASS = 4
const DEFAULT_LOG_SCAN_CHUNK = 10_000n

/**
 * DONGU MODUNDA gecis basina parca butcesi. `graduationWindow.ts`in C6
 * karariyla ayni: zinciri yurume isi indexer'indir, keeper kendini rasyonlar.
 * Bir soguk imlec birkac dakikada yetisir ve o sure boyunca durum
 * `catching-up` diye YAZILIR.
 */
const DEFAULT_MAX_CHUNKS_PER_PASS = 1

/**
 * `--once` MODUNDA GECIS BASINA butce, VE SAYI OLCULEREK SECILDI.
 *
 * `--once` bir SONRAKI POLL'a guvenemez, ama tek bir GECISE de sigdiramaz:
 * ilk hali 50 idi ve CANLI ARC ONU REDDETTI (2026-08-09, uretim defteri,
 * `startBlock` 55870261 -> head 56033742):
 *
 *   LogScanError over [56020261, 56030260]: Request exceeds defined limit
 *   ... Details: rate limit exceeded
 *
 * On altinci parcada dustu -- ve `withRateLimitRetry`in 14 denemesi de
 * tukendikten SONRA. Yani "ard arda 50 `eth_getLogs`" Arc'ta bir plan degil.
 * AGENT-CONTEXT'in kurali burada dogrudan gecerli: fan-out eden her sey
 * PACELENIR.
 *
 * Cozum ikili: gecis basina butce KUCUK kalir, ve `--once` gecisleri
 * ARALARINDA BEKLEYEREK tekrarlar (bkz. `graduate.ts`). Imlec parca basina
 * yazildigi icin her tur bir oncekinin kaldigi yerden devam eder.
 */
export const ONCE_MAX_CHUNKS_PER_PASS = 8

/** `--once` en fazla kac gecis dener. Butce x tur = 800.000 blokluk kapsama. */
export const ONCE_MAX_ROUNDS = 100

/**
 * ============ IMLEC AYRI DOSYADIR, VE BU ZORUNLUDUR ============
 *
 * Pencere izleyicisi ve yurutucu AYRI SUREÇLERDIR (`pnpm start` ve
 * `pnpm graduate`). `fileCursorStore` `writeFileSync` + `renameSync` ile
 * yazar; iki surec AYNI dosyaya yazarsa biri digerinin ilerlemesini geri
 * alir ve tarama araligi ikiye bolunur -- `index.ts`in `setInterval` yerine
 * kendini yeniden zamanlamasinin sebebiyle AYNI ariza, iki surec olcegine
 * tasinmis hali. Varsayilan yollar bu yuzden farklidir.
 */
export function loadGraduatorConfig(
  env: NodeJS.ProcessEnv,
  opts?: { bookDir?: string; once?: boolean },
): GraduatorConfig {
  const bookDir = opts?.bookDir
  const rpcUrl = blankToUndefined(env['ARC_RPC_URL'])
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  const rawChainId = blankToUndefined(env['ARC_CHAIN_ID'])
  const chainId = rawChainId === undefined ? ARC_TESTNET_CHAIN_ID : Number(rawChainId)
  if (!Number.isSafeInteger(chainId)) {
    throw new Error(`ARC_CHAIN_ID must be an integer, got "${env['ARC_CHAIN_ID'] ?? ''}"`)
  }

  // ============ IKI KAYNAK, VE IKINCISI ACIKCA SECILIR ============
  //
  // Uretim yolunda her sey DEFTERDEN gelir. Ama DISPOSABLE yigin deftere
  // GIREMEZ: `parseAddressBook` `launchFactory`nin `CREATE2(0x4e59..56C,
  // FACTORY_SALT, factoryInitcodeHash)`ten turedigini dogrular ve disposable
  // fabrika BASKA bir tuzla madenlendi -- olculdu, ayni kapi tatbikat
  // fabrikasini da reddetti. Yani "defteri yeniden yonlendir" yolu bu yigin
  // icin CALISMAZ ve calismamasi DOGRUDUR.
  //
  // Bu yuzden ikinci bir yol var ve o yol GURULTULUDUR: IKISI BIRDEN
  // verilmek zorundadir. `resolveSmokePair`in "yarim cift kabul etme" dersi
  // burada da gecerlidir -- tek basina bir fabrika, bir onceki yiginin
  // locker'iyla eslesip SESSIZCE yanlis seye yazardi. Guvence ZINCIRDEN
  // gelir: `assertLockerMatchesFactory` locker'in `factory()`sini okur.
  const factoryOverride = blankToUndefined(env['KEEPER_GRADUATE_FACTORY'])
  const lockerOverride = blankToUndefined(env['KEEPER_GRADUATE_LOCKER'])
  if ((factoryOverride === undefined) !== (lockerOverride === undefined)) {
    throw new Error(
      'KEEPER_GRADUATE_FACTORY and KEEPER_GRADUATE_LOCKER must be set together or not at all. A factory without its locker would silently pair with the address book\'s locker -- which belongs to a DIFFERENT deployment -- and the executor would send graduate() through the wrong contract.',
    )
  }

  let factory: Address
  let locker: Address
  let startBlock: bigint
  const overridden = factoryOverride !== undefined && lockerOverride !== undefined

  if (overridden) {
    factory = coerce(factoryOverride, 'KEEPER_GRADUATE_FACTORY')
    locker = coerce(lockerOverride, 'KEEPER_GRADUATE_LOCKER')
    const rawStart = blankToUndefined(env['KEEPER_GRADUATE_START_BLOCK'])
    if (rawStart === undefined || !/^\d+$/.test(rawStart)) {
      throw new Error(
        'KEEPER_GRADUATE_START_BLOCK must be set to the block the overridden factory was deployed in. Without it the Launched scan would start from the address book\'s startBlock, which for the production book is 1.2M blocks of a DIFFERENT factory\'s history -- every one of them scanned and none of them relevant.',
      )
    }
    startBlock = BigInt(rawStart)
  } else {
    const book = bookDir === undefined ? loadAddressBook(chainId) : loadAddressBook(chainId, bookDir)
    factory = book.launchFactory
    locker = book.arcpadLocker
    startBlock = book.launchFactoryBlock
  }

  const rawInterval = blankToUndefined(env['KEEPER_GRADUATE_POLL_INTERVAL_MS'])
  const pollIntervalMs = rawInterval === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(rawInterval)
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      `KEEPER_GRADUATE_POLL_INTERVAL_MS must be a positive integer, got "${rawInterval ?? ''}"`,
    )
  }

  const rawMax = blankToUndefined(env['KEEPER_GRADUATE_MAX_PER_PASS'])
  const maxPerPass = rawMax === undefined ? DEFAULT_MAX_PER_PASS : Number(rawMax)
  if (!Number.isInteger(maxPerPass) || maxPerPass <= 0) {
    throw new Error(`KEEPER_GRADUATE_MAX_PER_PASS must be a positive integer, got "${rawMax ?? ''}"`)
  }

  const rawChunk = blankToUndefined(env['KEEPER_LOG_SCAN_CHUNK'])
  if (rawChunk !== undefined && (!/^\d+$/.test(rawChunk) || BigInt(rawChunk) === 0n)) {
    throw new Error(`KEEPER_LOG_SCAN_CHUNK must be a positive integer, got "${rawChunk}"`)
  }
  const logScanChunk = rawChunk === undefined ? DEFAULT_LOG_SCAN_CHUNK : BigInt(rawChunk)

  const rawBudget = blankToUndefined(env['KEEPER_GRADUATE_CHUNKS_PER_PASS'])
  const budgetDefault =
    opts?.once === true ? ONCE_MAX_CHUNKS_PER_PASS : DEFAULT_MAX_CHUNKS_PER_PASS
  const maxChunksPerPass = rawBudget === undefined ? budgetDefault : Number(rawBudget)
  if (!Number.isInteger(maxChunksPerPass) || maxChunksPerPass <= 0) {
    throw new Error(
      `KEEPER_GRADUATE_CHUNKS_PER_PASS must be a positive integer, got "${rawBudget ?? ''}"`,
    )
  }

  // ============ ANAHTAR ARGV'DE DEGIL, DOSYADA DEGIL, ENV'DE ============
  //
  // `.env.example`in kendi kurali: "Ozel anahtar ASLA buraya veya argv'ye
  // yazilmaz." `.env.deployer` BU SUREC TARAFINDAN HIC OKUNMAZ; degisken
  // surece disaridan enjekte edilir. Kuru kosu VARSAYILANDIR, yani anahtarin
  // YOKLUGU bir hata degil sadece "yayin yapamam"dir.
  const privateKeyRaw = blankToUndefined(env['KEEPER_GRADUATE_PRIVATE_KEY'])
  if (privateKeyRaw !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(privateKeyRaw)) {
    throw new Error(
      'KEEPER_GRADUATE_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex string. Refusing to start rather than deriving a wrong signer.',
    )
  }

  const dryRun = env['KEEPER_DRY_RUN'] !== 'false'
  if (!dryRun && privateKeyRaw === undefined) {
    throw new Error(
      'KEEPER_DRY_RUN=false but KEEPER_GRADUATE_PRIVATE_KEY is not set. An executor told to broadcast with no signer would run forever, simulate green forever, and graduate nothing -- the exact "mechanism exists but its output goes nowhere" shape this project keeps paying for. Refusing to start.',
    )
  }

  return {
    rpcUrl,
    chainId,
    factory,
    locker,
    startBlock,
    dryRun,
    privateKey: privateKeyRaw as `0x${string}` | undefined,
    cursorPath:
      fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_CURSOR_FILE'])) ??
      DEFAULT_GRADUATE_CURSOR_PATH,
    statePath:
      fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_STATE_FILE'])) ??
      DEFAULT_GRADUATE_STATE_PATH,
    lockDir:
      fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_LOCK_DIR'])) ?? DEFAULT_GRADUATE_LOCK_DIR,
    alertLogPath: fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_ALERT_LOG'])),
    pollIntervalMs,
    maxPerPass,
    logScanChunk,
    maxChunksPerPass,
    overridden,
  }
}

function coerce(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${field} is "${value}", not an address`)
  }
  return getAddress(value)
}

/** `resolveFromRepoRoot` ile ayni kural; bkz. onun olculmus gerekcesi. */
function fromRepoRoot(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path)
}
