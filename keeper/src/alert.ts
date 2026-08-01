import { appendFileSync } from 'node:fs'

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
  const line = renderEvent(event)
  if (event.kind === 'alert' && event.level === 'page') console.error(line)
  else console.log(line)
}

/** `render`, hem `consoleSink`in hem `fileSink`in TEK bicimlendiricisidir. */
export function renderEvent(event: AlertEvent): string {
  if (event.kind === 'heartbeat') {
    return `HEARTBEAT keeper.graduationWindow at=${new Date(event.at).toISOString()}`
  }
  return `${event.level === 'page' ? 'PAGE' : 'OK'} keeper.graduationWindow at=${new Date(event.at).toISOString()} ${event.message}`
}

/**
 * TATBIKATIN OKUDUGU DOSYAYI YAZAN SEY.
 *
 * Bir onceki hal `KEEPER_ALERT_LOG`u OKUYORDU ama HICBIR SEY YAZMIYORDU:
 * `consoleSink` `PAGE`i stderr'e, `OK`/`HEARTBEAT`i stdout'a ayirir ve ikisini
 * birlestiren belgelenmis bir komut yoktu -- bariz yanlis olan (`> alerts.log`)
 * ise tam olarak tatbikatin aradigi `PAGE` satirlarini dusururdu. Yani haftalik
 * is ASLA GECEMEZDI, ve kalici kirmizi bir kapi, bosuna yesil olan kadar
 * guvenilir sekilde susturulur.
 *
 * Bu lavabo tek bir akisa, tek bir dosyaya, `renderEvent`in TEK bicimiyle
 * yazar. Boruyu birlestirme isi operatorden alinir.
 */
export function fileSink(path: string, opts?: { now?: () => number }): AlertSink {
  const now = opts?.now ?? Date.now
  let lastComplaintAt: number | null = null
  return (event) => {
    try {
      appendFileSync(path, `${renderEvent(event)}\n`, 'utf8')
    } catch (cause) {
      // ALARM YOLU IZLEYICIYI OLDUREMEZ. OLCULDU, ve runbook'un KENDI komutuydu:
      //
      //   $ KEEPER_ALERT_LOG=keeper/alerts.log pnpm --filter @arcpad/keeper start
      //   keeper ready ...
      //   HEARTBEAT keeper.graduationWindow at=2026-08-01T02:48:00.576Z
      //   Error: ENOENT: no such file or directory,
      //          open 'D:\pumpfunforarc\keeper\keeper\alerts.log'
      //   [surec olur, exit 1]
      //
      // Tek bir kalp atisi, sonra olum. `heartbeat()` `runWatcher` icinde HER
      // `try`in DISINDA cagrilir (graduationWindow.ts:1122), yani o dosyanin
      // "ASLA REJECT ETMEZ" sozu bu yol icin YANLISTI: yazma hatasi `poll`u
      // reddettirir, `main().catch` yakalar, ve DONGU BITER.
      //
      // Yolun kendisi ayrica duzeltildi (bkz. `config.ts`, artik depo kokune
      // gore cozulur) ve acilista denenir (`assertAlertLogWritable`). AMA
      // BUNLAR YETMEZ: disk dolabilir, izin degisebilir, log rotasyonu dizini
      // altimizdan alabilir. Alarm lavabosunun BIR SURE SONRA bozulmasi, tek
      // savunma hattinin olmesi anlamina GELMEMELIDIR.
      //
      // SESSIZCE YUTULMAZ. `consoleSink` hala calisiyor olabilir, ama bu
      // fonksiyon onu goremez; bu yuzden sikayet DOGRUDAN stderr'e ve `PAGE `
      // onekiyle yazilir -- harici olu-adam anahtarinin filtresi tam olarak o
      // onektir. Tekrari dakikada bire indirilir: her olayda bir satir, bozuk
      // bir diskte konsolu doldurup gercek sayfalari gorunmez yapardi.
      const at = now()
      if (lastComplaintAt === null || at - lastComplaintAt >= SINK_COMPLAINT_INTERVAL_MS) {
        lastComplaintAt = at
        console.error(
          `PAGE keeper.graduationWindow at=${new Date(at).toISOString()} alert-sink-write-failed: the file sink at ${path} cannot be written, so $KEEPER_ALERT_LOG is NOT a record of this run and the drill that reads it will report "there was no watcher". The watcher itself is still running and stdout/stderr still carry every event: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`,
        )
      }
    }
  }
}

/** Lavabo sikayetinin tekrar araligi. Bkz. `fileSink`. */
export const SINK_COMPLAINT_INTERVAL_MS = 60_000

/**
 * ACILISTA, BIR KEZ, YUKSEK SESLE. `parseGovernanceAllowlist`in doldurulmamis
 * bir governance dosyasini reddetmesiyle ayni gerekce: yapilandirma hatasi
 * calisma aninda sizmak yerine baslangicta patlamalidir.
 *
 * Bos bir dize ekler -- dosya varsa icerigini DEGISTIRMEZ, yoksa yaratir.
 * Boylece hem "dizin yok" hem "izin yok" hemen burada, YOLU ADIYLA duser.
 */
export function assertAlertLogWritable(path: string): void {
  try {
    appendFileSync(path, '', 'utf8')
  } catch (cause) {
    throw new Error(
      `cannot write the alert sink at ${path} (KEEPER_ALERT_LOG). The keeper writes every PAGE/OK/HEARTBEAT there and the weekly drill reads it; refusing to start rather than discovering this on the first heartbeat. Relative paths resolve against the repo root, not the working directory: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

export function multiSink(...sinks: readonly AlertSink[]): AlertSink {
  return (event) => {
    for (const sink of sinks) sink(event)
  }
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
// Tekrar bastirma
// ---------------------------------------------------------------

export interface AlertThrottle {
  /** Bu anahtar SIMDI yayilmali mi. */
  shouldEmit(key: string, atMs: number): boolean
  /** Bu poll'da AKTIF olmayan her anahtari unut, ki tekrar olustugunda ANINDA sayfa cikarsin. */
  sweep(activeKeys: Iterable<string>): void
}

export const DEFAULT_REPEAT_AFTER_MS = 3_600_000

/**
 * ILK SAYFA ASLA BASTIRILMAZ; tekrari bastirilir.
 *
 * Olculdu: `ARC_START_BLOCK` ilk launch'in ilerisine ayarlanmis bir keeper her
 * poll'da sayfa cikarir ve HIC kalp atisi vermez -- bes saniyelik varsayilan
 * aralikta gunde ~35.000 sayfa, tek bir yapilandirma hatasindan. 35.000 sayfa
 * alan bir rota, pager'i kapatan bir rotadir. `parseGovernanceAllowlist` zaten
 * bu gerekceyle doldurulmamis bir dosyayi reddediyor; ayni gerekce alarm
 * yolunun kendisine uygulanmamisti.
 *
 * ANAHTAR DURUMDAN TURETILIR, MESAJDAN DEGIL. Mesaj zaman damgasi tasir ve
 * hicbir zaman tekrar etmez; anahtar (bulgular + ilgili adresler) ise durum
 * degismedikce aynidir. Dolayisiyla FARKLI bir dusman hedef ANINDA yeni bir
 * sayfa cikarir -- bastirilan tek sey "ayni sey hala boyle".
 */
export function createThrottle(config?: { repeatAfterMs?: number | undefined }): AlertThrottle {
  const repeatAfterMs = config?.repeatAfterMs ?? DEFAULT_REPEAT_AFTER_MS
  const lastEmitted = new Map<string, number>()

  return {
    shouldEmit(key: string, atMs: number): boolean {
      const previous = lastEmitted.get(key)
      if (previous !== undefined && atMs - previous < repeatAfterMs) return false
      lastEmitted.set(key, atMs)
      return true
    },
    sweep(activeKeys: Iterable<string>): void {
      const active = new Set(activeKeys)
      for (const key of [...lastEmitted.keys()]) {
        if (!active.has(key)) lastEmitted.delete(key)
      }
    },
  }
}

// ---------------------------------------------------------------
// Canlilik
// ---------------------------------------------------------------

export type LivenessCode =
  'watcher-heartbeat-missed' | 'chain-head-stale' | 'chain-time-skewed' | 'chain-time-frozen'

export type LivenessFinding = { code: LivenessCode; message: string }

export interface LivenessConfig {
  pollIntervalMs: number
  /** Kac poll araligi kalp atisi kacirilinca sayfa cikar. Varsayilan 2. */
  missedBeatsBeforePage?: number
  /** Kac poll araligi boyunca blok numarasi ayni kalirsa bayat sayilir. Varsayilan 2. */
  staleHeadIntervals?: number
  /** Zincir saatiyle yerel saat arasinda tolere edilen fark. Varsayilan 15 dakika. */
  clockSkewToleranceMs?: number
  /** Zincir saatinin hic ilerlemedigi tolere edilen sure. Varsayilan 10 poll araligi, en az 60 sn. */
  chainTimeFrozenMs?: number
}

export interface Liveness {
  /** Yalnizca BASTAN SONA tamamlanmis bir poll'dan sonra cagrilir. */
  pollSucceeded(atMs: number): void
  /** Her okunan zincir basligi. Ayni numara TEKRAR gorulurse sayac SIFIRLANMAZ. */
  observeHead(blockNumber: bigint, atMs: number): void
  /** Her okunan blok ZAMAN DAMGASI. Blok numarasindan AYRI izlenir; bkz. asagisi. */
  observeChainTime(chainSeconds: bigint, atMs: number): void
  check(atMs: number): LivenessFinding[]
}

/**
 * DORT SAYAC, VE HEPSI DOGUSTAN KURULUDUR.
 *
 * UCUNCU VE DORDUNCU SONRADAN EKLENDI, ve gerekcesi olculdu. Ilk hal iki
 * dedektor tasiyordu ve IKISI DE `blockNumber`a bakiyordu. Pencere aritmetigi
 * ise YALNIZCA `timestamp`e bakar. Dolayisiyla blok numarasi normal ilerlerken
 * zaman damgasi one kaymis bir baslik su durumu uretiyordu:
 *
 *     phase=expired, pages=[], heartbeats akiyor, iki dedektor de sessiz.
 *
 * `phase === 'expired'` dusman bir hedef icin TEK sessiz daldir, ve ona zincirin
 * DOGRULANMAMIS iki sayisiyla varilir. Bu, deponun kendi adlandirdigi hata
 * seklinin ta kendisidir: bir ozellik bir giris noktasinda kapatilir ve
 * digerinde de kapali sanilir. Saati izleyen sey, blogu izleyen seyden AYRI
 * olmak ZORUNDADIR.
 *
 * `chain-time-frozen` BILEREK TOLERANSLIDIR (varsayilan 10 poll araligi):
 * Arc'in dokumani blok zaman damgalarinin ARTMAYABILECEGINI soyler, yani kisa
 * sureli duraklamalar NORMALDIR ve sayfa cikarmamalidir. Ileri/geri KAYMA
 * (`chain-time-skewed`) ise normal degildir ve toleransi cok daha dardir.
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
  // IKI TOLERANS ARASINDA 15 KAT FARK VAR VE SEBEBI SUDUR -- daha once
  // yalnizca "Arc'ta duraklamalar normaldir" yaziyordu, ki dogru ama EKSIK:
  //
  //   DONMUS ZAMAN `expired` URETEMEZ. `eta = block.timestamp +
  //   GRADUATION_TARGET_DELAY` ZINCIR USTUNDE hesaplanir, yani duran bir saat
  //   `now`u da `eta`yi da ayni anda dondurur; pencere ILERLEMEZ ama SESSIZ
  //   DALA DA GECMEZ. Kaybedilen sey ilerlemedir, koruma degil.
  //
  //   ILERI KAYMA `expired` URETIR. Taze bir oneri, `now` yeterince ileri
  //   kaydirilinca aninda "suresi gecmis" okunur -- ve `expired` dusman bir
  //   hedef icin TEK sessiz daldir. Bu yuzden kayma toleransi dar.
  //
  // Ucuncu bir sebep: uzun suren bir donma zaten kaymaya DONUSUR -- yerel saat
  // ilerlerken zincir saati durdugu icin fark buyur ve 900 sn'lik kontrol
  // devreye girer. Yani genis butce bir bosluk birakmaz, yalnizca gurultuyu
  // keser.
  //
  // OLCUM (canli Arc testnet, koordinator, 553 ardisik finalize edilmis cift):
  // ciftlerin %49.0'i (271) AYNI zaman damgasini paylasiyor, dagilim
  // {1 blok: 41, 2: 244, 3: 14}, ve SIFIR GERILEME. Yani "artmayabilir" ESIT
  // demek, GERI GITMEK degil; gercekci donma suresi bir ila uc bloktur, sinirsiz
  // bir durus degil. 60 sn'lik taban bunun cok uzerindedir ve bir gerileme
  // varsayimi uzerine kurulu DEGILDIR -- kayma kontrolu zaten iki yonlu
  // (`skew > tolerance || -skew > tolerance`), o yuzden gerilemeler olsaydi da
  // yakalanirdi.
  const skewToleranceMs = config.clockSkewToleranceMs ?? 900_000
  const frozenBudgetMs = config.chainTimeFrozenMs ?? Math.max(60_000, 10 * config.pollIntervalMs)

  let lastPollOkAt = startedAtMs
  let lastHeadChangeAt = startedAtMs
  let lastHead: bigint | null = null
  let lastChainTimeChangeAt = startedAtMs
  let lastChainSeconds: bigint | null = null
  let lastSkewMs: number | null = null

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
    observeChainTime(chainSeconds: bigint, atMs: number): void {
      // KAYMA HER GOZLEMDE OLCULUR; DONMUSLUK ise yalnizca DEGISIMDE sifirlanir.
      lastSkewMs = Number(chainSeconds * 1000n - BigInt(Math.trunc(atMs)))
      if (lastChainSeconds === null || chainSeconds !== lastChainSeconds) {
        lastChainSeconds = chainSeconds
        lastChainTimeChangeAt = atMs
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

      // KAYMA. Pencere aritmetiginin TAMAMI zincir saatinden turer, yani kaymis
      // bir saat kontrolu SESSIZCE devre disi birakabilir: yeterince ileri
      // kaymis bir zaman damgasi, taze bir dusman oneriyi `expired` gosterir ve
      // `expired` dusman bir hedef icin tek sessiz daldir.
      if (lastSkewMs !== null && Math.abs(lastSkewMs) > skewToleranceMs) {
        findings.push({
          code: 'chain-time-skewed',
          message: `chain time is ${lastSkewMs > 0 ? 'ahead of' : 'behind'} local time by ${Math.abs(lastSkewMs)}ms (tolerance ${skewToleranceMs}ms); the window phase is computed from chain time, so it cannot be trusted while this holds`,
        })
      }

      // DONMUS ZAMAN, TOLERANSLI. Arc'in dokumani blok zaman damgalarinin
      // artmayabilecegini soyler; kisa duraklamalar NORMALDIR.
      const chainTimeAge = atMs - lastChainTimeChangeAt
      if (chainTimeAge >= frozenBudgetMs) {
        findings.push({
          code: 'chain-time-frozen',
          message: `chain timestamp stuck at ${lastChainSeconds === null ? 'none-observed' : lastChainSeconds.toString()} for ${chainTimeAge}ms (budget ${frozenBudgetMs}ms, deliberately loose because Arc documents that block timestamps may not increase); the window clock has stopped`,
        })
      }

      return findings
    },
  }
}
