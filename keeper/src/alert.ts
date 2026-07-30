/**
 * ALARM VE CANLILIK KANARYASI.
 *
 * Bu dosyanin varlik sebebi tek bir cumledir: SESSIZCE DURMUS BIR IZLEYICI,
 * HICBIR SEY GORMEYEN BIR IZLEYICIYLE AYNI GORUNUR. Bir izleyicinin ciktisi
 * yalnizca "alarm" ise, ciktinin yoklugu iki apayri duruma karsilik gelir --
 * "zincirde bir sey olmadi" ve "izleyici olmus". Bu projede tam olarak bu
 * sekil on bir kez isirdi.
 *
 * Bu yuzden izleyici iki sey yayar: ALARM (bir sey gordum) ve KALP ATISI
 * (bir poll'u BASTAN SONA tamamladim). Kalp atisi eksikligi de bir alarmdir.
 */

/** `page` insani uyandirir; `ok` yalnizca kayda gecer. */
export type AlertLevel = 'ok' | 'page'

/**
 * Siniflandirmanin ic derecesi. `level` yalnizca "uyandirir mi" sorusunu
 * yanitlar; `severity` rota'ya HANGI runbook adimina gidecegini soyler.
 * `critical` ile `page` ayni `level`i tasir ama ayni sey DEGILDIR: biri
 * "pencere acik, bosaltmak icin vaktin var", digeri "degisiklik indi".
 */
export type Severity = 'none' | 'notice' | 'page' | 'critical'

const SEVERITY_ORDER: Record<Severity, number> = {
  none: 0,
  notice: 1,
  page: 2,
  critical: 3,
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b
}

export function severityToLevel(severity: Severity): AlertLevel {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER.page ? 'page' : 'ok'
}

export type AlertEvent =
  | { kind: 'alert'; level: AlertLevel; message: string; at: number }
  | { kind: 'heartbeat'; at: number }

export type AlertSink = (event: AlertEvent) => void

/**
 * Varsayilan lavabo. `page` STDERR'e gider ve satir `PAGE ` ile baslar:
 * runbook'un adlandirdigi harici olu-adam anahtari (dead man's switch) bu iki
 * dizeye gore filtreler, JSON ayristirmaz -- bir alarm yolunun kendisinin
 * ayristirma hatasiyla sessizlesmesi, korunmaya calisilan seyin ta kendisidir.
 */
export const consoleSink: AlertSink = (event) => {
  if (event.kind === 'heartbeat') {
    console.log(`HEARTBEAT keeper.graduationWindow at=${new Date(event.at).toISOString()}`)
    return
  }
  const line = `${event.level === 'page' ? 'PAGE' : 'OK'} keeper.graduationWindow at=${new Date(event.at).toISOString()} ${event.message}`
  if (event.level === 'page') console.error(line)
  else console.log(line)
}

export function alert(
  level: AlertLevel,
  message: string,
  sink: AlertSink = consoleSink,
  now: () => number = Date.now,
): void {
  sink({ kind: 'alert', level, message, at: now() })
}

export function heartbeat(sink: AlertSink = consoleSink, now: () => number = Date.now): void {
  sink({ kind: 'heartbeat', at: now() })
}

// ---------------------------------------------------------------
// Canlilik
// ---------------------------------------------------------------

export type LivenessCode = 'watcher-heartbeat-missed' | 'chain-head-stale'

export type LivenessFinding = { code: LivenessCode; message: string }

export interface LivenessConfig {
  pollIntervalMs: number
  /** Kac poll araligi kalp atisi kacirilinca sayfa cikar. Varsayilan 2. */
  missedBeatsBeforePage?: number
  /** Kac poll araligi boyunca blok numarasi ayni kalirsa bayat sayilir. Varsayilan 2. */
  staleHeadIntervals?: number
}

export interface Liveness {
  /** Yalnizca BASTAN SONA tamamlanmis bir poll'dan sonra cagrilir. */
  pollSucceeded(atMs: number): void
  /** Her okunan zincir basligi. Ayni numara TEKRAR gorulurse sayac SIFIRLANMAZ. */
  observeHead(blockNumber: bigint, atMs: number): void
  check(atMs: number): LivenessFinding[]
}

/**
 * Iki sayac, ve ikisi de DOGUSTAN KURULUDUR.
 *
 * "Ilk basarili poll'a kadar kanaryayi kurma" tasarimi CAZIPTIR ve YANLISTIR:
 * hic basarili poll yapamayan bir izleyici -- yani ILK ANDAN ITIBAREN bozuk
 * olan -- sonsuza kadar sessiz kalirdi. Kanaryanin bosa dusebilecegi tek delik
 * tam olarak burasidir, o yuzden `lastPollOkAt` ve `lastHeadChangeAt`
 * yaratilma anindan baslar.
 *
 * BU KANARYA NEYI YAKALAMAZ: SIGKILL. Surec olduyse hicbir sey yayamaz.
 * O durumun mercii, kalp atisi AKISINI okuyan HARICI olu-adam anahtaridir
 * (bkz. docs/runbooks/graduation-window.md). Bu ayrim runbook'ta yazilidir,
 * cunku ic kanaryayi harici olanin yerine saymak tam olarak bu projenin
 * "bosalabilen mekanizma" hatasi olurdu.
 */
export function createLiveness(config: LivenessConfig, startedAtMs: number): Liveness {
  const missedBeats = config.missedBeatsBeforePage ?? 2
  const staleIntervals = config.staleHeadIntervals ?? 2

  let lastPollOkAt = startedAtMs
  let lastHeadChangeAt = startedAtMs
  let lastHead: bigint | null = null

  return {
    pollSucceeded(atMs: number): void {
      lastPollOkAt = atMs
    },
    observeHead(blockNumber: bigint, atMs: number): void {
      if (lastHead === null || blockNumber !== lastHead) {
        lastHead = blockNumber
        lastHeadChangeAt = atMs
      }
    },
    check(atMs: number): LivenessFinding[] {
      const findings: LivenessFinding[] = []

      const beatAge = atMs - lastPollOkAt
      const beatBudget = missedBeats * config.pollIntervalMs
      if (beatAge >= beatBudget) {
        findings.push({
          code: 'watcher-heartbeat-missed',
          message: `no completed poll for ${beatAge}ms (budget ${beatBudget}ms = ${missedBeats} x ${config.pollIntervalMs}ms); the watcher is not watching`,
        })
      }

      const headAge = atMs - lastHeadChangeAt
      const headBudget = staleIntervals * config.pollIntervalMs
      if (headAge >= headBudget) {
        findings.push({
          code: 'chain-head-stale',
          message: `chain head stuck at block ${lastHead === null ? 'none-observed' : lastHead.toString()} for ${headAge}ms (budget ${headBudget}ms); the RPC is serving a frozen view and the window clock cannot advance`,
        })
      }

      return findings
    },
  }
}
