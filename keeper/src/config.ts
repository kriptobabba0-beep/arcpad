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
