import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Address, getAddress, isAddress } from 'viem'
import { type Allowlist, ZERO_ADDRESS } from './watch/graduationWindow'

export interface KeeperConfig {
  rpcUrl: string
  pollIntervalMs: number
  dryRun: boolean
}

const DEFAULT_POLL_INTERVAL_MS = 5_000

/**
 * Keeper zincire islem gonderir, bu yuzden varsayilan davranisi GUVENLI
 * olmalidir: `KEEPER_DRY_RUN` acikca "false" yapilmadikca hicbir islem
 * yayinlanmaz. Yanlis yapilandirilmis bir keeper'in sessizce imzalamaya
 * baslamasi, hic calismamasindan cok daha pahalidir.
 */
export function loadKeeperConfig(env: NodeJS.ProcessEnv): KeeperConfig {
  const rpcUrl = env['ARC_RPC_URL']
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  const rawInterval = env['KEEPER_POLL_INTERVAL_MS']
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  if (rawInterval !== undefined) {
    pollIntervalMs = Number(rawInterval)
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error(`KEEPER_POLL_INTERVAL_MS must be a positive integer, got "${rawInterval}"`)
    }
  }

  return {
    rpcUrl,
    pollIntervalMs,
    dryRun: env['KEEPER_DRY_RUN'] !== 'false',
  }
}

// ---------------------------------------------------------------
// Graduation penceresi izleyicisi
// ---------------------------------------------------------------

/**
 * AYRI BIR YUKLEYICI, `KeeperConfig`e alan eklemek yerine. Izleyici SALT
 * OKURDUR -- hicbir islem yayinlamaz -- dolayisiyla `KEEPER_DRY_RUN` onu
 * KAPATMAZ ve kapatmamalidir: Safe'ler kurulmadan, hedef atanmadan, keeper
 * imzalamaya baslamadan once bile calisir. Gorev tanimindaki "bu, deploy'dan
 * ONCE iner ki factory hicbir an izlenmeden canli olmasin" cumlesinin kodda
 * karsiligi budur.
 */
export interface WatcherConfig {
  factory: Address
  startBlock: bigint
  chainKey: string
  governancePath: string
  cursorPath: string
  logScanChunk: bigint
  allowlist: Allowlist
}

const DEFAULT_LOG_SCAN_CHUNK = 10_000n

/** `keeper/.cursor` ve `contracts/deploy/expected-governance.json`, bu dosyaya gore. */
export const DEFAULT_CURSOR_PATH = fileURLToPath(new URL('../.cursor', import.meta.url))
export const DEFAULT_GOVERNANCE_PATH = fileURLToPath(
  new URL('../../contracts/deploy/expected-governance.json', import.meta.url),
)

export function loadWatcherConfig(env: NodeJS.ProcessEnv): WatcherConfig {
  const factory = requireAddressEnv(env, 'ARC_FACTORY_ADDRESS')
  const startBlock = requireBigintEnv(env, 'ARC_START_BLOCK')
  const chainKey = env['KEEPER_CHAIN_KEY'] ?? 'arc-testnet'
  const governancePath = env['KEEPER_GOVERNANCE_FILE'] ?? DEFAULT_GOVERNANCE_PATH
  const cursorPath = env['KEEPER_CURSOR_FILE'] ?? DEFAULT_CURSOR_PATH

  const rawChunk = env['KEEPER_LOG_SCAN_CHUNK']
  let logScanChunk = DEFAULT_LOG_SCAN_CHUNK
  if (rawChunk !== undefined) {
    if (!/^\d+$/.test(rawChunk) || BigInt(rawChunk) === 0n) {
      throw new Error(`KEEPER_LOG_SCAN_CHUNK must be a positive integer, got "${rawChunk}"`)
    }
    logScanChunk = BigInt(rawChunk)
  }

  let raw: string
  try {
    raw = readFileSync(governancePath, 'utf8')
  } catch {
    throw new Error(`cannot read the governance allowlist at ${governancePath}`)
  }

  return {
    factory,
    startBlock,
    chainKey,
    governancePath,
    cursorPath,
    logScanChunk,
    allowlist: parseGovernanceAllowlist(JSON.parse(raw) as unknown, chainKey),
  }
}

/**
 * DOLDURULMAMIS BIR DOSYAYLA BASLAMAYI REDDEDER, ve bu bir uslup tercihi
 * degil bir alarm-yorgunlugu karari:
 *
 *   `treasury` sifirken izin listesi bos olurdu, yani GERCEK hazine her
 *   poll'da (bes saniyede bir) sayfa cikarirdi. Bir gun icinde rota o sayfayi
 *   susturmayi ogrenir ve kontrol -- HALA "calisiyor" gorunurken -- sifira
 *   duser. Yapilandirma hatasi ACILISTA, bir kez, yuksek sesle patlar.
 *
 * `allowedGraduationTargets` BOS OLABILIR ve Faz 1d'de boyle OLMALIDIR:
 * hicbir hedef atanmamistir, dolayisiyla SIFIR OLMAYAN HER hedef sayfadir.
 * Bos liste "kontrol yok" degil, TAM OLARAK "hicbir sey mesru degil"
 * demektir.
 */
export function parseGovernanceAllowlist(input: unknown, chainKey: string): Allowlist {
  if (typeof input !== 'object' || input === null) {
    throw new Error('expected-governance.json: not an object')
  }
  const entry = (input as Record<string, unknown>)[chainKey]
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(
      `expected-governance.json: no entry for chainKey "${chainKey}" (known keys: ${Object.keys(input as object).join(', ')})`,
    )
  }
  const o = entry as Record<string, unknown>

  const treasury = coerceAddress(o['treasury'], `${chainKey}.treasury`)
  if (treasury === ZERO_ADDRESS) {
    throw new Error(
      `expected-governance.json: ${chainKey}.treasury is the zero address. The watcher refuses to start against an unfilled governance file -- it would page on every poll and the rota would learn to ignore it.`,
    )
  }
  const governor = coerceAddress(o['governor'], `${chainKey}.governor`)
  if (governor === ZERO_ADDRESS) {
    throw new Error(`expected-governance.json: ${chainKey}.governor is the zero address.`)
  }

  const rawTargets = o['allowedGraduationTargets']
  if (!Array.isArray(rawTargets)) {
    throw new Error(
      `expected-governance.json: ${chainKey}.allowedGraduationTargets is not an array`,
    )
  }
  const graduationTargets = rawTargets.map((value, i) => {
    const address = coerceAddress(value, `${chainKey}.allowedGraduationTargets[${i}]`)
    if (address === ZERO_ADDRESS) {
      throw new Error(
        `expected-governance.json: ${chainKey}.allowedGraduationTargets[${i}] is the zero address; proposeGraduationTarget rejects it (ZeroGraduationTarget), so allowlisting it can only hide a bug`,
      )
    }
    return address
  })

  return { graduationTargets, treasuries: [treasury] }
}

function coerceAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(`${field}: expected an address, got ${JSON.stringify(value)}`)
  }
  return getAddress(value)
}

function requireAddressEnv(env: NodeJS.ProcessEnv, name: string): Address {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set (see .env.example)`)
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is "${value}", not an address`)
  return getAddress(value)
}

function requireBigintEnv(env: NodeJS.ProcessEnv, name: string): bigint {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set (see .env.example)`)
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a decimal integer, got "${value}"`)
  return BigInt(value)
}
