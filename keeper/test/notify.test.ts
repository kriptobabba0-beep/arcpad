import { describe, expect, it } from 'vitest'
import { renderEvent } from '../src/alert'
import { GRADUATE_ALERT_COMPONENT } from '../src/graduate/config'
import { loadNotifyConfig } from '../src/notify/config'
import { createForwarder, type ForwarderConfig, type ForwarderDeps } from '../src/notify/forwarder'
import { drainRecords } from '../src/notify/records'
import { redact } from '../src/notify'

// ---------------------------------------------------------------
// Kayit ayirma
// ---------------------------------------------------------------

describe('drainRecords', () => {
  it('COK SATIRLI bir PAGE tek bir kayittir', () => {
    // OLCULMUS SEKIL, uydurma degil: canli `keeper/graduate.log` icinde viem'in
    // hata metni kendi satir sonlarini tasiyor. `drill.ts` o devam satirlarini
    // duser -- bir ILETICI icin ayni davranis, pager'a sayfanin GOVDESINI degil
    // yalnizca ilk satirini gondermek olurdu.
    const buffer = [
      'PAGE keeper.graduate at=2026-08-09T01:00:00.000Z log-scan-failed: something broke.',
      '',
      'URL: https://rpc.testnet.arc.network',
      'Details: rate limit exceeded',
      'HEARTBEAT keeper.graduate at=2026-08-09T01:00:15.000Z state=current block=1',
      '',
    ].join('\n')

    const { records, rest } = drainRecords(buffer)
    expect(rest).toBe('')
    expect(records).toHaveLength(2)
    expect(records[0]?.kind).toBe('page')
    expect(records[0]?.text).toContain('Details: rate limit exceeded')
    expect(records[0]?.text.split('\n')).toHaveLength(4)
    expect(records[1]?.kind).toBe('heartbeat')
  })

  it('YARIM YAZILMIS son satir TUTULUR, ve ONUNDEKI KAYIT DA', () => {
    // Yarim satir, onceki kaydin bir DEVAMI olabilir -- ki cok satirli sayfalar
    // gercekten oyle. Dolayisiyla dosya satir sonuyla bitmiyorsa son TAM kayit
    // da tutulur ve bir sonraki tick'te yayilir. Bedeli tek bir poll'luk
    // gecikmedir ve yalnizca YAZMANIN ORTASINDA okundugunda odenir: `fileSink`
    // her olayi satir sonuyla bitirdigi icin kararli durumda `rest` bostur.
    const buffer =
      'HEARTBEAT keeper.graduate at=2026-08-09T01:00:00.000Z state=current\nPAGE keeper.gradu'
    const { records, rest } = drainRecords(buffer)
    expect(records).toHaveLength(0)
    expect(rest).toBe(buffer)

    // ...ve satir sonu gelince IKISI DE cikar.
    const done = drainRecords(`${rest}ate at=2026-08-09T01:00:01.000Z boom\n`)
    expect(done.records.map((r) => r.kind)).toEqual(['heartbeat', 'page'])
    expect(done.rest).toBe('')
  })

  it('BASLIGI YARIDA kesilmis bir sayfa KAYBOLMAZ', () => {
    // Bu testin oldurdugu mutant, "yarim satiri yalnizca bir KAYDIN icindeyse
    // tut" halidir: yarim yazilmis `PAGE keeper.gradu` bir baslik saymadigi
    // icin dusurulur, sonraki turda gelen kuyrugu da basliksiz kalip
    // dusurulurdu -- yani tek bir bolunmus okuma bir SAYFAYI sessizce yok
    // ederdi.
    const first = drainRecords('PAGE keeper.gradu')
    expect(first.records).toHaveLength(0)
    const second = drainRecords(`${first.rest}ate at=2026-08-09T01:00:00.000Z boom\n`)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]?.kind).toBe('page')
    expect(second.records[0]?.text).toContain('boom')
  })

  it('IKI BILESENI de tanir ve ADLARINI tasir', () => {
    const buffer = `${renderEvent({ kind: 'heartbeat', at: 0, state: 'current' })}\n${renderEvent(
      { kind: 'alert', level: 'page', message: 'x', at: 0 },
      GRADUATE_ALERT_COMPONENT,
    )}\n`
    const { records } = drainRecords(buffer)
    expect(records.map((r) => r.component)).toEqual([
      'keeper.graduationWindow',
      GRADUATE_ALERT_COMPONENT,
    ])
  })

  it('basliksiz onek DUSER ve tamponu buyutmez', () => {
    const { records, rest } = drainRecords('garbage line\nmore garbage\n')
    expect(records).toHaveLength(0)
    expect(rest).toBe('')
  })
})

// ---------------------------------------------------------------
// Yapilandirma
// ---------------------------------------------------------------

const NOTIFY_ENV = {
  KEEPER_NOTIFY_LOG: '/tmp/alerts.log',
  KEEPER_NOTIFY_PAGE_URL: 'https://example.invalid/page',
  KEEPER_NOTIFY_HEARTBEAT_URL: 'https://example.invalid/ping/abc',
} satisfies NodeJS.ProcessEnv

describe('loadNotifyConfig', () => {
  it('IKI URL DE ZORUNLUDUR -- yarisiyla calisan bir kontrol BASLAMAZ', () => {
    expect(() =>
      loadNotifyConfig({ ...NOTIFY_ENV, KEEPER_NOTIFY_HEARTBEAT_URL: '' }),
    ).toThrow(/KEEPER_NOTIFY_HEARTBEAT_URL/)
    expect(() => loadNotifyConfig({ ...NOTIFY_ENV, KEEPER_NOTIFY_PAGE_URL: '' })).toThrow(
      /KEEPER_NOTIFY_PAGE_URL/,
    )
    // Ve hata metni, EKSIK OLANIN NE ISE YARADIGINI soyler: runbook'un iki
    // kuralindan hangisinin kuruldugunu bilmeyen bir operator, yarim kurulmus
    // bir kontrolu "kuruldu" diye kaydeder.
    expect(() =>
      loadNotifyConfig({ ...NOTIFY_ENV, KEEPER_NOTIFY_HEARTBEAT_URL: '' }),
    ).toThrow(/killed process/)
  })

  it('log yolu YOKSA baslamaz', () => {
    expect(() => loadNotifyConfig({ ...NOTIFY_ENV, KEEPER_NOTIFY_LOG: '' })).toThrow(
      /KEEPER_NOTIFY_LOG/,
    )
  })

  it('http olmayan bir ucu REDDEDER', () => {
    expect(() =>
      loadNotifyConfig({ ...NOTIFY_ENV, KEEPER_NOTIFY_PAGE_URL: 'slack://team' }),
    ).toThrow(/http: or https:/)
  })

  it('varsayilanlar', () => {
    const config = loadNotifyConfig(NOTIFY_ENV)
    expect(config.pollIntervalMs).toBe(5_000)
    expect(config.heartbeatMinIntervalMs).toBe(60_000)
    // Olu-adam kurali 10 dakika; yeniden baslatma penceresi ondan GENIS olmali
    // ki bir restart, o pencerede yazilmis bir sayfayi kaybetmesin.
    expect(config.maxAgeMs).toBeGreaterThan(600_000)
  })

  it('URL kaydedilirken YOLU YAZILMAZ -- yol bir token olabilir', () => {
    expect(redact('https://hc.example.com/ping/2f9d-secret')).toBe('https://hc.example.com/…')
    expect(redact('not a url')).toBe('(unparseable url)')
  })
})

// ---------------------------------------------------------------
// Ileticinin durum makinesi
// ---------------------------------------------------------------

const CONFIG: ForwarderConfig = {
  label: 'test',
  pageUrl: 'https://example.invalid/page',
  heartbeatUrl: 'https://example.invalid/ping',
  maxAgeMs: 900_000,
  heartbeatMinIntervalMs: 0,
  maxOutbox: 3,
}

type Harness = {
  deps: ForwarderDeps
  append(text: string): void
  truncateTo(text: string): void
  remove(): void
  posts: { url: string; body: string }[]
  logs: string[]
  failWith: { page?: Error; heartbeat?: Error }
  setNow(ms: number): void
}

function harness(initial = ''): Harness {
  let file: string | undefined = initial
  let now = 1_000_000
  const posts: { url: string; body: string }[] = []
  const logs: string[] = []
  const failWith: { page?: Error; heartbeat?: Error } = {}

  return {
    posts,
    logs,
    failWith,
    append(text) {
      file = (file ?? '') + text
    },
    truncateTo(text) {
      file = text
    },
    remove() {
      file = undefined
    },
    setNow(ms) {
      now = ms
    },
    deps: {
      readSlice(offset) {
        if (file === undefined) return undefined
        const size = Buffer.byteLength(file, 'utf8')
        if (size <= offset) return { text: '', size }
        return { text: Buffer.from(file, 'utf8').subarray(offset).toString('utf8'), size }
      },
      post(url, body) {
        const failure = url === CONFIG.pageUrl ? failWith.page : failWith.heartbeat
        if (failure !== undefined) return Promise.reject(failure)
        posts.push({ url, body })
        return Promise.resolve()
      },
      now: () => now,
      log: (line) => logs.push(line),
    },
  }
}

const page = (at: string, text = 'boom') => `PAGE keeper.graduate at=${at} ${text}\n`
const beat = (at: string) => `HEARTBEAT keeper.graduate at=${at} state=current block=1\n`
const AT = '2026-08-09T01:00:00.000Z'
const NOW = Date.parse(AT)

describe('createForwarder', () => {
  it('PAGE gider, HEARTBEAT pingler, OK GITMEZ', async () => {
    const h = harness()
    h.setNow(NOW)
    h.append(page(AT))
    h.append(`OK keeper.graduate at=${AT} nothing to do\n`)
    h.append(beat(AT))

    const result = await createForwarder(CONFIG, h.deps).tick()

    expect(result.recordsSeen).toBe(3)
    expect(result.pagesSent).toBe(1)
    expect(result.heartbeatsPinged).toBe(1)
    expect(h.posts.map((p) => p.url)).toEqual([CONFIG.pageUrl, CONFIG.heartbeatUrl])
    expect(JSON.parse(h.posts[0]?.body ?? '{}')).toMatchObject({ kind: 'page', label: 'test' })
  })

  it('TESLIM EDILEMEYEN BIR SAYFA, KALP ATISI PINGINI DURDURUR', async () => {
    // Bu, bu dosyadaki en onemli iddia. Pager ucu olur ve ping akmaya devam
    // ederse, olu-adam anahtari "her sey yolunda" der -- yani alarm yolu
    // kirikken akis YESIL kalir. Ping'i de durdurmak, o arizayi anahtarin
    // ates ettigi bir arizaya cevirir.
    const h = harness()
    h.setNow(NOW)
    h.failWith.page = new Error('502')
    h.append(page(AT))
    h.append(beat(AT))

    const forwarder = createForwarder(CONFIG, h.deps)
    const result = await forwarder.tick()

    expect(result.pagesSent).toBe(0)
    expect(result.pagesQueued).toBe(1)
    expect(result.heartbeatsPinged).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(h.logs.join(' ')).toMatch(/heartbeat pings are SUSPENDED/)

    // ...VE UC DUZELINCE IKISI DE GIDER. Kuyruk kaybolmaz.
    delete h.failWith.page
    const second = await forwarder.tick()
    expect(second.pagesSent).toBe(1)
    expect(second.heartbeatsPinged).toBe(1)
  })

  it('kalp atisi ping BASARISIZ olursa BEKLEYEN kalir ve yeniden denenir', async () => {
    const h = harness()
    h.setNow(NOW)
    h.failWith.heartbeat = new Error('timeout')
    h.append(beat(AT))

    const forwarder = createForwarder(CONFIG, h.deps)
    expect((await forwarder.tick()).heartbeatsPinged).toBe(0)
    expect(forwarder.state().heartbeatPending).toBe(true)

    delete h.failWith.heartbeat
    // Yeni bir kalp atisi satiri GELMEDEN, sadece yeniden deneyerek.
    expect((await forwarder.tick()).heartbeatsPinged).toBe(1)
  })

  it('ESKI kayitlar yeniden baslatmada YENIDEN YAYILMAZ', async () => {
    const h = harness()
    h.setNow(NOW)
    h.append(page('2026-08-08T00:00:00.000Z', 'yesterday'))
    h.append(page(AT, 'today'))

    const result = await createForwarder(CONFIG, h.deps).tick()
    expect(result.pagesSent).toBe(1)
    expect(h.posts[0]?.body).toContain('today')
  })

  it('DAMGASI OKUNAMAYAN bir sayfa YINE DE gider -- yon `drill.ts`in TERSIDIR', async () => {
    // `drill.ts` ayni girdiyi SAYMAZ, cunku onun riski sahte YESIL. Buranin
    // riski GONDERILMEYEN SAYFA, dolayisiyla karar ters yone dusmelidir.
    // Ikisini ayni kural yapmak, iki yerden birinde yanlis olurdu.
    const h = harness()
    h.setNow(NOW)
    h.append('PAGE keeper.graduate at=not-a-timestamp everything is on fire\n')

    const result = await createForwarder(CONFIG, h.deps).tick()
    expect(result.pagesSent).toBe(1)
    expect(h.posts[0]?.body).toContain('on fire')
  })

  it('dosya KUCULURSE bastan okur ama ESKI satirlari yeniden PAGE ETMEZ', async () => {
    const h = harness()
    h.setNow(NOW)
    // Once dosyayi BUYUT: kucultme ancak yeni boy imlecin ALTINDA kalirsa
    // algilanir, ve o durumu uretmek testin kendi isidir.
    h.append(page(AT, 'first'.padEnd(500, '.')))
    const forwarder = createForwarder(CONFIG, h.deps)
    expect((await forwarder.tick()).pagesSent).toBe(1)

    // logrotate: dosya yeniden olusur. Icinde ESKI bir sayfa ve YENI bir tane.
    h.truncateTo(page('2026-08-01T00:00:00.000Z', 'ancient') + page(AT, 'fresh'))
    const result = await forwarder.tick()
    expect(result.reset).toBe(true)
    expect(result.pagesSent).toBe(1)
    expect(h.posts[1]?.body).toContain('fresh')
  })

  it('dosya YOKSA sessizce bekler ve bunu BIR KEZ yazar', async () => {
    const h = harness()
    h.remove()
    const forwarder = createForwarder(CONFIG, h.deps)
    await forwarder.tick()
    await forwarder.tick()
    expect(h.logs).toHaveLength(1)
    expect(h.posts).toHaveLength(0)
  })

  it('kuyruk tavani asilirsa EN ESKI dusurulur ve bu YAZILIR', async () => {
    const h = harness()
    h.setNow(NOW)
    h.failWith.page = new Error('down')
    for (let i = 0; i < 5; i += 1) h.append(page(AT, `p${i}`))

    const result = await createForwarder(CONFIG, h.deps).tick()
    expect(result.pagesQueued).toBe(CONFIG.maxOutbox)
    expect(h.logs.filter((l) => l.includes('PAGE DELIVERY BACKLOG'))).toHaveLength(2)
  })

  it('ayni satir IKI KEZ gonderilmez', async () => {
    const h = harness()
    h.setNow(NOW)
    h.append(page(AT))
    const forwarder = createForwarder(CONFIG, h.deps)
    expect((await forwarder.tick()).pagesSent).toBe(1)
    expect((await forwarder.tick()).pagesSent).toBe(0)
    expect(h.posts.filter((p) => p.url === CONFIG.pageUrl)).toHaveLength(1)
  })

  it('ping ARALIGINA uyar: her kalp atisi bir ping DEGILDIR', async () => {
    const h = harness()
    h.setNow(NOW)
    const forwarder = createForwarder({ ...CONFIG, heartbeatMinIntervalMs: 60_000 }, h.deps)
    h.append(beat(AT))
    expect((await forwarder.tick()).heartbeatsPinged).toBe(1)

    h.setNow(NOW + 15_000)
    h.append(beat(new Date(NOW + 15_000).toISOString()))
    expect((await forwarder.tick()).heartbeatsPinged).toBe(0)

    h.setNow(NOW + 61_000)
    h.append(beat(new Date(NOW + 61_000).toISOString()))
    expect((await forwarder.tick()).heartbeatsPinged).toBe(1)
  })
})
