import { drainRecords, type NotifyRecord } from './records'

/**
 * ============ KALP ATISINI SAYAN SEY ============
 *
 * `docs/runbooks/graduation-window.md` §7 iki kural yaziyor ve ikincisi
 * SOZLESMENIN TAMAMI: "10 dakika `HEARTBEAT ` gelmezse on-call'i cagir."
 * Ayni belge bir cumle sonra kendi olcusunu koyuyor: **kimsenin saymadigi bir
 * kalp atisi dekordur.** Keeper o satirlari bir VPS'te bir dosyaya yaziyor;
 * bu modul o dosyayi KUTUNUN DISINA cikaran seydir.
 *
 * ============ NEDEN ILETICININ KENDISINI IZLEYEN BIR SEY YOK ============
 *
 * Cunku ILETICI, IZLENEN YOLUN ICINDEDIR. Olu-adam anahtarina giden tek yol
 * bu surectir; surec olurse ping durur ve anahtar ates eder. Kutu olurse ikisi
 * de olur ve anahtar yine ates eder. Ag olurse ping gitmez ve anahtar yine
 * ates eder. Bu, kendi izleyicisine ihtiyac duyan bir bilesen olmamasinin
 * yapisal sebebidir -- "izleyiciyi kim izler" zinciri burada BITER.
 *
 * ============ TESLIM EDILEMEYEN SAYFA, KALP ATISINI DURDURUR ============
 *
 * Sayfa kuyrugu bosalana kadar HICBIR ping gonderilmez. Bu kasitli: pager
 * ucu erisilemezse, sessizlik "her sey yolunda" diye okunmaz -- kalp atisi de
 * durur ve olu-adam anahtari on-call'i uyandirir. Aksi halde tam olarak
 * kacinilan sekil olusurdu: alarm yolu kirik, ama akista her sey yesil.
 */

export type PostFn = (url: string, body: string) => Promise<void>

export type ForwarderDeps = {
  /**
   * `offset`ten itibaren yeni baytlar. `undefined` = dosya YOK (keeper henuz
   * baslamadi ya da yol yanlis). `size` okuma SONRASI dosya boyudur.
   */
  readSlice(offset: number): { text: string; size: number } | undefined
  post: PostFn
  now(): number
  log(line: string): void
}

export type ForwarderConfig = {
  label: string
  pageUrl: string
  heartbeatUrl: string
  /** Bundan eski damgali kayitlar iletilmez. Yeniden baslatmada gecmisi yeniden yaymamak icin. */
  maxAgeMs: number
  /** Iki ping arasinda en az bu kadar beklenir; 15 s'lik bir poll her atisi gondermek zorunda degildir. */
  heartbeatMinIntervalMs: number
  /** Kuyruk bu kadar sayfayi asarsa EN ESKI dusurulur ve bu YUKSEK SESLE yazilir. */
  maxOutbox: number
}

export type TickResult = {
  pagesSent: number
  pagesQueued: number
  heartbeatsPinged: number
  recordsSeen: number
  /** Dosya kuculdugu icin imlec sifirlandi mi (rotasyon / truncate). */
  reset: boolean
}

export function createForwarder(config: ForwarderConfig, deps: ForwarderDeps) {
  let offset = 0
  let buffer = ''
  const outbox: NotifyRecord[] = []
  let heartbeatPending = false
  let lastPingAt = Number.NEGATIVE_INFINITY
  let missingLogged = false

  const body = (record: NotifyRecord): string =>
    JSON.stringify({
      label: config.label,
      kind: record.kind,
      at: record.atMs === null ? null : new Date(record.atMs).toISOString(),
      text: record.text,
    })

  async function tick(): Promise<TickResult> {
    const result: TickResult = {
      pagesSent: 0,
      pagesQueued: 0,
      heartbeatsPinged: 0,
      recordsSeen: 0,
      reset: false,
    }

    let slice = deps.readSlice(offset)
    if (slice === undefined) {
      if (!missingLogged) {
        deps.log(
          `the alert log is not there yet; nothing to forward. This is normal before the keeper's first write and a REAL fault if it persists -- the dead-man's switch will fire on its own, which is the correct outcome.`,
        )
        missingLogged = true
      }
      return result
    }
    missingLogged = false

    // ============ DOSYA KUCULDUYSE BASA DON ============
    // `logrotate` (hem `create` hem `copytruncate`) ve elle bir `truncate`
    // ayni sekli uretir. Bastan okumak ESKI kayitlari yeniden gorur; onlari
    // tazelik suzgeci duser, dolayisiyla rotasyon bir sayfa firtinasina
    // donusmez. `maxAgeMs`in ikinci var olma sebebi budur.
    if (slice.size < offset) {
      deps.log(
        `the alert log shrank (${slice.size} < ${offset}); re-reading from the start. Records older than ${config.maxAgeMs} ms are dropped rather than re-paged.`,
      )
      offset = 0
      buffer = ''
      result.reset = true
      slice = deps.readSlice(0)
      if (slice === undefined) return result
    }

    offset = slice.size
    buffer += slice.text
    const drained = drainRecords(buffer)
    buffer = drained.rest
    result.recordsSeen = drained.records.length

    const now = deps.now()
    for (const record of drained.records) {
      // DAMGASI OKUNAMAYAN BIR KAYIT ILETILIR, DUSURULMEZ -- ve bu, `drill.ts`in
      // AYNI durumda verdigi kararin TERSIDIR, bilerek. Tatbikat icin risk
      // "sahte yesil"dir, dolayisiyla o SAYMAZ. Burada risk "gonderilmeyen
      // sayfa"dir, dolayisiyla burasi GONDERIR. Ayni girdi, ters yonde iki
      // dogru karar.
      if (record.atMs !== null && record.atMs < now - config.maxAgeMs) continue
      if (record.kind === 'page') {
        outbox.push(record)
        continue
      }
      if (record.kind === 'heartbeat') heartbeatPending = true
      // `OK` satirlari ILETILMEZ. Onlar journald'da ve dosyada durur; pager'a
      // gitmeleri, gurultuyu on-call'a tasimak olurdu ve runbook'un iki
      // kuralinda yoklar.
    }

    while (outbox.length > config.maxOutbox) {
      const dropped = outbox.shift()
      deps.log(
        `PAGE DELIVERY BACKLOG: dropped the oldest queued page (${outbox.length + 1} > ${config.maxOutbox}) because the page endpoint has not accepted anything. The dropped line was: ${dropped?.text.split('\n')[0] ?? ''}`,
      )
    }

    while (outbox.length > 0) {
      const next = outbox[0] as NotifyRecord
      try {
        await deps.post(config.pageUrl, body(next))
        outbox.shift()
        result.pagesSent += 1
      } catch (error) {
        deps.log(
          `could not deliver a page to KEEPER_NOTIFY_PAGE_URL (${outbox.length} queued); heartbeat pings are SUSPENDED until it lands, so the dead-man's switch fires instead of this going quiet: ${describe(error)}`,
        )
        break
      }
    }
    result.pagesQueued = outbox.length

    if (
      outbox.length === 0 &&
      heartbeatPending &&
      now - lastPingAt >= config.heartbeatMinIntervalMs
    ) {
      try {
        await deps.post(
          config.heartbeatUrl,
          JSON.stringify({ label: config.label, kind: 'heartbeat', at: new Date(now).toISOString() }),
        )
        heartbeatPending = false
        lastPingAt = now
        result.heartbeatsPinged = 1
      } catch (error) {
        deps.log(
          `could not ping KEEPER_NOTIFY_HEARTBEAT_URL; the switch will fire if this persists, which is the intended behaviour: ${describe(error)}`,
        )
      }
    }

    return result
  }

  return {
    tick,
    /** Yalnizca testler ve teshis icin. */
    state: () => ({ offset, buffered: buffer.length, queued: outbox.length, heartbeatPending }),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
