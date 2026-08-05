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

/**
 * ================== UC DURUM, IKI DEGIL ==================
 *
 * "Kalp atisi var" ile "kalp atisi yok" IKI durumdur ve izleyicinin UC durumu
 * vardir. Uculuk olculdu, uydurulmadi -- canli factory'ye karsi 40 saniye:
 * **4 sayfa, 0 kalp atisi**, ve izleyici o sirada gayet iyi calisiyordu; 71
 * parcalik soguk taramanin dorduncu parcasindaydi.
 *
 * Eski model kalp atisini yalnizca BASTAN SONA tamamlanmis bir poll'a
 * veriyordu. Soguk tarama ise `2 x pollIntervalMs` icinde FIZIKSEL OLARAK
 * bitemez (709.413 blok / 10.000 = 71 ardisik `eth_getLogs`), yani DOGRU
 * yapilandirilmis bir izleyici her soguk baslangicta "izleyici izlemiyor"
 * diye sayfa cikariyordu. Ve tatbikat sifir kalp atisini "there was no
 * watcher" diye okuyor -- yani tek savunma hatti hem yanlis sayfa cikariyor
 * hem her yeniden baslatmada kendini YOK ilan ediyordu. Iki kez bunu goren
 * bir operator pager'i kapatir.
 *
 *   `current`      bir poll BASTAN SONA tamamlandi ve tarama BASA yetisti.
 *                  Maruziyet OLCULDU.
 *   `catching-up`  izleyici YASIYOR ve tarama ILERLIYOR, ama daha basa
 *                  yetismedi. Maruziyet HENUZ olculmedi ve bu SOYLENIR.
 *   (atis yok)     ucuncu durum, ve yaziya DOKULMEZ: onu gormenin tek yolu
 *                  atisin YOKLUGUDUR. Bu yuzden ilk ikisi ayni akisa,
 *                  AYIRT EDILEBILIR bicimde yazilir -- yoklugu ancak
 *                  varliginin iki bicimi de tanimliysa "olu" diye okunabilir.
 */
export type WatcherState = 'current' | 'catching-up'

export type AlertEvent =
  | { kind: 'alert'; level: AlertLevel; message: string; at: number }
  | { kind: 'heartbeat'; at: number; state: WatcherState; detail?: string }

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

/**
 * `render`, hem `consoleSink`in hem `fileSink`in TEK bicimlendiricisidir.
 *
 * `state=` ONEK BICIMINI BOZMADAN EKLENDI ve bu zorunluydu: harici olu-adam
 * anahtari ve `drill.ts` satiri `^(PAGE|OK|HEARTBEAT) keeper\.graduationWindow
 * at=(\S+)` ile ayristirir. Alan `at=`den SONRA geldigi icin eski okuyucu da
 * calismaya devam eder -- yalnizca yeni okuyucu hangi durumda oldugunu GORUR.
 */
export function renderEvent(event: AlertEvent): string {
  if (event.kind === 'heartbeat') {
    const detail = event.detail === undefined ? '' : ` ${event.detail}`
    return `HEARTBEAT keeper.graduationWindow at=${new Date(event.at).toISOString()} state=${event.state}${detail}`
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

/**
 * `state` ZORUNLUDUR, varsayilani YOKTUR.
 *
 * Varsayilan `'current'` vermek cazipti ve tam olarak duzeltilen arizayi geri
 * getirirdi: soguk taramanin ortasindaki bir atis, kendini "basa yetismis"
 * diye yazardi ve tatbikat maruziyeti OLCULMUS sanardi. Bir cagirani durumu
 * SOYLEMEYE zorlamak, unutmayi derleme hatasi yapar.
 */
export function heartbeat(
  sink: AlertSink = consoleSink,
  state: WatcherState = 'current',
  detail?: string,
  now: () => number = Date.now,
): void {
  const event: AlertEvent =
    detail === undefined
      ? { kind: 'heartbeat', at: now(), state }
      : { kind: 'heartbeat', at: now(), state, detail }
  sink(event)
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
  | 'watcher-heartbeat-missed'
  | 'watcher-catching-up'
  | 'chain-head-stale'
  | 'chain-time-skewed'
  | 'chain-time-frozen'

/**
 * `level` SONRADAN EKLENDI, ve eksikligi bir hataydi.
 *
 * Kanarya her bulguyu `page` olarak yayiyordu. Bir bulgu ("izleyici hala
 * yetisiyor") sayfa DEGILDIR -- kaydedilmesi gereken, ama kimseyi uyandirmamasi
 * gereken bir olgudur. Ayni akista, ayni throttle'da, ama `OK` satirinda.
 */
export type LivenessFinding = { code: LivenessCode; level: AlertLevel; message: string }

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
  /**
   * Yetisme MODUNDA ilerleme gormeden gecebilecek sure. Varsayilan 60 sn.
   *
   * OLCULMUS BIR TABANDIR, secilmis degil: `withRateLimitRetry`in patolojik
   * durumdaki toplam bekleme tavani 21 saniyedir (`chainReader.ts`), yani
   * bundan dar bir butce, MESRU bir yeniden denemenin ortasinda sayfa
   * cikarirdi -- duzeltilen arizanin aynisinin taze bir ornegi.
   */
  catchUpStallMs?: number
}

export interface Liveness {
  /** Yalnizca BASTAN SONA tamamlanmis bir poll'dan sonra cagrilir. */
  pollSucceeded(atMs: number): void
  /**
   * TARAMA BIR PARCA ILERLETTI -- poll bitmedi, ama izleyici YASIYOR.
   *
   * Ayri bir saat, `pollSucceeded`in saati DEGIL. Ikisini birlestirmek cazipti
   * ve yanlisti: sonsuza kadar yetisemeyen bir izleyici "guncel" gorunurdu, ki
   * bu duzeltilen arizanin ta kendisinin ters yonu olurdu.
   */
  scanProgressed(atMs: number): void
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
  const catchUpStallMs = config.catchUpStallMs ?? 60_000

  let lastPollOkAt = startedAtMs
  /**
   * `null` = HIC ILERLEME GORULMEDI, ve baslangicta `startedAtMs` OLAMAZ.
   *
   * Ilk hali `startedAtMs` ile tohumluyordu ve mevcut kanarya testleri onu
   * ANINDA yakaladi: bu tohumla, hic poll etmemis -- yani ILK ANDAN ITIBAREN
   * bozuk -- bir izleyici, ilk 60 saniye boyunca "yetisiyor" diye okunuyordu ve
   * `watcher-heartbeat-missed` CIKMIYORDU. Yani duzeltmenin kendisi,
   * duzeltmeye calistigi sinifin (bir arizanin baska bir ariza gibi
   * raporlanmasi) taze bir ornegini iceriyordu -- bu depoda alti kez olan sey.
   *
   * `lastPollOkAt`in dogustan kurulu olmasi DOGRU (bir sayaci gec baslatmak
   * kanaryayi bosaltir); ilerlemenin `null` baslamasi da ayni sebepten dogru:
   * "ilerleme gorulmedi" bir MAZERET degildir.
   */
  let lastProgressAt: number | null = null
  let lastHeadChangeAt = startedAtMs
  /**
   * BASI EN SON NE ZAMAN GORDUGUMUZ -- ne zaman DEGISTIGI degil.
   *
   * `chain-head-stale` bir sure `atMs - lastHeadChangeAt`e bakiyordu, yani
   * "en son bakisimdan bu yana gecen sure"yi "zincir durdu" diye raporluyordu.
   * OLCULDU (canli, 2026-08-05): iki sayfa cikti --
   *   "chain head stuck at block 55372283 for 14999ms"
   *   "chain head stuck at block 55372354 for 13970ms"
   * -- ve MESAJIN KENDI IKI SAYISI basin 71 blok ilerledigini kanitliyor. Donan
   * sey RPC degil, tek is parcacikli poll'un GOZLEMIYDI: taramanin icindeydi.
   *
   * Dedektorun cevaplamasi gereken soru "iki GOZLEM arasinda bas ayni mi
   * kaldi"dir. Hic bakmadigimiz sure onun sorusu degil -- o, kalp atisi
   * dedektorunun sorusudur, ve iki soruyu tek sayaca bagli birakmak birinin
   * digerinin adiyla raporlanmasi demekti.
   */
  let lastHeadSeenAt = startedAtMs
  let lastHead: bigint | null = null
  let lastChainTimeChangeAt = startedAtMs
  let lastChainSeconds: bigint | null = null
  let lastSkewMs: number | null = null

  return {
    pollSucceeded(atMs: number): void {
      // `lastProgressAt`E DOKUNMAZ, ve bu bir ihmal degil bir karar. Ilk hali
      // ikisini birlikte ilerletiyordu ve mevcut bir test onu ANINDA yakaladi:
      // poll'lari tamamlayip SONRA olen bir izleyici, olumden sonraki 60 saniye
      // boyunca "yetisiyor" diye okunuyordu. Ilerleme, TAMAMLANMAMIS bir
      // taramanin sinyalidir; tamamlanmis bir poll onun tersidir.
      lastPollOkAt = atMs
    },
    scanProgressed(atMs: number): void {
      lastProgressAt = atMs
    },
    observeHead(blockNumber: bigint, atMs: number): void {
      lastHeadSeenAt = atMs
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

      // ================== UC DURUM, IKI DEGIL ==================
      //
      // `beatAge >= budget` tek basina "izleyici izlemiyor" DEMEZ. Soguk bir
      // tarama mesru bir uzun islemdir ve `2 x pollIntervalMs` icinde bitemez;
      // olculen sonuc, DOGRU calisan bir izleyicinin her soguk baslangicta bu
      // sayfayi cikarmasiydi (40 saniyede 4 sayfa, 0 kalp atisi).
      //
      // Ayirt eden sey ILERLEMEDIR: tarama parca basina `scanProgressed`
      // cagirir. Ilerliyorsa durum "yetisiyor"dur -- KAYDA GECER, kimseyi
      // UYANDIRMAZ. Ilerleme de durduysa gercekten takilmistir ve SAYFADIR.
      const beatAge = atMs - lastPollOkAt
      const beatBudget = missedBeats * config.pollIntervalMs
      // "YETISIYOR" UC SART ISTER, ve ucuncusu kolayca atlanirdi:
      //   1. ilerleme GORULMUS olmali (`null` degil) -- yoksa hic kosmamis bir
      //      izleyici kendini yetisiyor sanardi;
      //   2. ilerleme TAZE olmali -- yoksa takilmis bir tarama mazeret olurdu;
      //   3. ilerleme SON TAMAMLANAN POLL'DAN SONRA olmali. Bu ucuncusu,
      //      "tamamlayip olen" izleyiciyi ayirir: onun son sinyali bir POLL'dur,
      //      bir parca degil, ve o izleyici YETISMIYOR -- OLMUS.
      const progressAge = lastProgressAt === null ? null : atMs - lastProgressAt
      const midScan = lastProgressAt !== null && lastProgressAt > lastPollOkAt
      if (beatAge >= beatBudget) {
        if (midScan && progressAge !== null && progressAge < catchUpStallMs) {
          findings.push({
            code: 'watcher-catching-up',
            level: 'ok',
            message: `no COMPLETED poll for ${beatAge}ms (budget ${beatBudget}ms), but the log scan advanced ${progressAge}ms ago: the watcher is ALIVE and still catching up. Exposure is not measured until the scan reaches the head.`,
          })
        } else {
          findings.push({
            code: 'watcher-heartbeat-missed',
            level: 'page',
            message: `no completed poll for ${beatAge}ms (budget ${beatBudget}ms = ${missedBeats} x ${config.pollIntervalMs}ms) AND ${progressAge === null ? 'NO scan progress has ever been reported' : `no scan progress for ${progressAge}ms`} (budget ${catchUpStallMs}ms); the watcher is not watching`,
          })
        }
      }

      // GOZLEMLER ARASI YAS. Bkz. `lastHeadSeenAt`: "bakmadim" ile "zincir
      // durdu" ayni sayaca bagliydi ve ikincisi birincinin adiyla
      // raporlaniyordu.
      const headAge = lastHeadSeenAt - lastHeadChangeAt
      const headBudget = staleIntervals * config.pollIntervalMs
      if (headAge >= headBudget) {
        findings.push({
          code: 'chain-head-stale',
          level: 'page',
          message: `chain head stuck at block ${lastHead === null ? 'none-observed' : lastHead.toString()} across observations spanning ${headAge}ms (budget ${headBudget}ms; last looked ${atMs - lastHeadSeenAt}ms ago); the RPC is serving a frozen view and the window clock cannot advance`,
        })
      }

      // KAYMA. Pencere aritmetiginin TAMAMI zincir saatinden turer, yani kaymis
      // bir saat kontrolu SESSIZCE devre disi birakabilir: yeterince ileri
      // kaymis bir zaman damgasi, taze bir dusman oneriyi `expired` gosterir ve
      // `expired` dusman bir hedef icin tek sessiz daldir.
      if (lastSkewMs !== null && Math.abs(lastSkewMs) > skewToleranceMs) {
        findings.push({
          code: 'chain-time-skewed',
          level: 'page',
          message: `chain time is ${lastSkewMs > 0 ? 'ahead of' : 'behind'} local time by ${Math.abs(lastSkewMs)}ms (tolerance ${skewToleranceMs}ms); the window phase is computed from chain time, so it cannot be trusted while this holds`,
        })
      }

      // DONMUS ZAMAN, TOLERANSLI. Arc'in dokumani blok zaman damgalarinin
      // artmayabilecegini soyler; kisa duraklamalar NORMALDIR.
      const chainTimeAge = atMs - lastChainTimeChangeAt
      if (chainTimeAge >= frozenBudgetMs) {
        findings.push({
          code: 'chain-time-frozen',
          level: 'page',
          message: `chain timestamp stuck at ${lastChainSeconds === null ? 'none-observed' : lastChainSeconds.toString()} for ${chainTimeAge}ms (budget ${frozenBudgetMs}ms, deliberately loose because Arc documents that block timestamps may not increase); the window clock has stopped`,
        })
      }

      return findings
    },
  }
}
