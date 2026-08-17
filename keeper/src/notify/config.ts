import { isAbsolute, resolve } from 'node:path'
import { blankToUndefined, REPO_ROOT } from '../config'
import type { ForwarderConfig } from './forwarder'

export type NotifyConfig = ForwarderConfig & {
  logPath: string
  pollIntervalMs: number
}

const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_HEARTBEAT_MIN_INTERVAL_MS = 60_000
/** Yeniden baslatmada gecmisi yeniden yaymamak icin pencere. Runbook'un 10 dakikalik olu-adam kuralindan GENIS secildi ki bir yeniden baslatma, o pencerede yazilmis bir sayfayi KAYBETMESIN. */
const DEFAULT_MAX_AGE_MS = 900_000
const DEFAULT_MAX_OUTBOX = 200

/**
 * ============ IKI URL DE ZORUNLUDUR, VE BU BIR TERCIH DEGIL ============
 *
 * Yalnizca `PAGE` ileten bir surec, olu bir keeper'i HIC yakalamaz: olu bir
 * surec kendi hakkinda sayfa cikaramaz -- runbook §6'nin son satiri tam olarak
 * bunu soyluyor. Yalnizca kalp atisi pingleyen bir surec ise gercek bir
 * bulguyu kimseye ulastirmaz. Yarisiyla calisan bir yapilandirma, "kontrol
 * kuruldu" diye kaydedilir ve iki arizadan birinde sessiz kalir; bu yuzden
 * yarisi YOKSA surec BASLAMAZ.
 */
export function loadNotifyConfig(env: NodeJS.ProcessEnv): NotifyConfig {
  const logPath = blankToUndefined(env['KEEPER_NOTIFY_LOG'])
  if (logPath === undefined) {
    throw new Error(
      'KEEPER_NOTIFY_LOG is not set. Point it at the SAME file the keeper writes ($KEEPER_ALERT_LOG for the window watcher, $KEEPER_GRADUATE_ALERT_LOG for the graduation executor). Relative paths resolve against the repo root, not the working directory.',
    )
  }

  const pageUrl = blankToUndefined(env['KEEPER_NOTIFY_PAGE_URL'])
  const heartbeatUrl = blankToUndefined(env['KEEPER_NOTIFY_HEARTBEAT_URL'])
  const missing = [
    pageUrl === undefined ? 'KEEPER_NOTIFY_PAGE_URL' : undefined,
    heartbeatUrl === undefined ? 'KEEPER_NOTIFY_HEARTBEAT_URL' : undefined,
  ].filter((name): name is string => name !== undefined)
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. Both rules from docs/runbooks/graduation-window.md section 7 are required and neither substitutes for the other: (1) every PAGE line pages the on-call, (2) NO HEARTBEAT for 10 minutes pages the on-call. Rule (2) is the only thing that catches a killed process. Refusing to start a forwarder that implements half of a control.`,
    )
  }
  for (const [name, value] of [
    ['KEEPER_NOTIFY_PAGE_URL', pageUrl],
    ['KEEPER_NOTIFY_HEARTBEAT_URL', heartbeatUrl],
  ] as const) {
    if (!/^https?:\/\//.test(value as string)) {
      throw new Error(`${name} must be an http: or https: URL, got "${value as string}"`)
    }
  }

  return {
    logPath: isAbsolute(logPath) ? logPath : resolve(REPO_ROOT, logPath),
    label: blankToUndefined(env['KEEPER_NOTIFY_LABEL']) ?? 'keeper',
    pageUrl: pageUrl as string,
    heartbeatUrl: heartbeatUrl as string,
    pollIntervalMs: positive(env, 'KEEPER_NOTIFY_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    heartbeatMinIntervalMs: positive(
      env,
      'KEEPER_NOTIFY_HEARTBEAT_MIN_INTERVAL_MS',
      DEFAULT_HEARTBEAT_MIN_INTERVAL_MS,
    ),
    maxAgeMs: positive(env, 'KEEPER_NOTIFY_MAX_AGE_MS', DEFAULT_MAX_AGE_MS),
    maxOutbox: positive(env, 'KEEPER_NOTIFY_MAX_OUTBOX', DEFAULT_MAX_OUTBOX),
  }
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = blankToUndefined(env[name])
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }
  return value
}
