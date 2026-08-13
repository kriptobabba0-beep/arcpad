import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { renderEvent } from '../src/alert'
import {
  ADDRESS_OVERRIDE_VARS,
  DEFAULT_GRADUATE_CURSOR_PATH,
  GRADUATE_ALERT_COMPONENT,
  loadGraduatorConfig,
  ONCE_MAX_CHUNKS_PER_PASS,
} from '../src/graduate/config'
import { renderSummary } from '../src/graduate'
import { fileCurveLocks, isLockRefusal } from '../src/graduate/lock'
import { runPollLoop } from '../src/graduate/loop'
import { fileQuarantineStore } from '../src/graduate/state'
import { DEFAULT_CURSOR_PATH } from '../src/config'
import { classifyRevert } from '../src/graduate/outcome'

const roots: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcpad-keeper-graduate-'))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const FACTORY = '0xfE11Db901168B0B0f7474b72a2e39b3d805b4849' as Address
const LOCKER = '0x1AfD2eF32C445FAdC95f05Ed237ed4C9dAE9d33F' as Address
const CURVE = '0xAAaA000000000000000000000000000000000001' as Address

const BASE_ENV = {
  ARC_RPC_URL: 'http://127.0.0.1:58545',
  ARC_CHAIN_ID: '5042002',
} satisfies NodeJS.ProcessEnv

// ---------------------------------------------------------------
// Alarm bilesen adi
// ---------------------------------------------------------------

describe('yurutucunun alarm satirlari IZLEYICININ tatbikat kapisini gecemez', () => {
  /**
   * `drill.ts` bu kaliba gore ayristirir. Yurutucunun kalp atislari ona
   * uysaydi, tatbikat "izleyici bu pencerede calisiyordu" derdi -- izleyici
   * OLU olsa bile. Yani haftalik canlilik kapisi ICI BOS gecerdi.
   *
   * Kalip BURADA LITERAL YAZILIR, `drill.ts`ten import EDILMEZ: import
   * edilseydi, kalibi degistiren bir mutasyon testi de yaninda tasir ve iki
   * taraf birlikte kayardi.
   */
  const DRILL_LINE = /^(PAGE|OK|HEARTBEAT) keeper\.graduationWindow at=(\S+)/

  it('izleyicinin satirlari kapiyi GECER (kontrol grubu)', () => {
    const line = renderEvent({ kind: 'heartbeat', at: 0, state: 'current' })
    expect(DRILL_LINE.test(line)).toBe(true)
  })

  it('yurutucunun satirlari kapiyi GECMEZ', () => {
    for (const event of [
      { kind: 'heartbeat', at: 0, state: 'current' } as const,
      { kind: 'alert', level: 'page', message: 'x', at: 0 } as const,
      { kind: 'alert', level: 'ok', message: 'x', at: 0 } as const,
    ]) {
      const line = renderEvent(event, GRADUATE_ALERT_COMPONENT)
      expect(DRILL_LINE.test(line)).toBe(false)
      expect(line).toContain(GRADUATE_ALERT_COMPONENT)
    }
  })
})

// ---------------------------------------------------------------
// Yapilandirma
// ---------------------------------------------------------------

describe('loadGraduatorConfig', () => {
  it('FABRIKA VE LOCKER BIRLIKTE verilir; yarim cift REDDEDILIR', () => {
    // `resolveSmokePair`in dersi: yarim bir cift, kalan yariyi BASKA bir
    // deployment'tan alir ve sessizce yanlis kontrata yazar.
    expect(() => loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_FACTORY: FACTORY })).toThrow(
      /must be set together/,
    )
    expect(() => loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_LOCKER: LOCKER })).toThrow(
      /must be set together/,
    )
  })

  it('acik yigin START BLOCK olmadan kabul edilmez', () => {
    expect(() =>
      loadGraduatorConfig({
        ...BASE_ENV,
        KEEPER_GRADUATE_FACTORY: FACTORY,
        KEEPER_GRADUATE_LOCKER: LOCKER,
      }),
    ).toThrow(/KEEPER_GRADUATE_START_BLOCK/)
  })

  it('KEEPER_DRY_RUN=false + anahtar YOK => BASLAMAZ', () => {
    // Yayin yapmasi soylenmis ama imzalayani olmayan bir yurutucu, sonsuza
    // kadar yesil simule edip hicbir seyi mezun etmezdi.
    expect(() =>
      loadGraduatorConfig({
        ...BASE_ENV,
        KEEPER_DRY_RUN: 'false',
        KEEPER_GRADUATE_FACTORY: FACTORY,
        KEEPER_GRADUATE_LOCKER: LOCKER,
        KEEPER_GRADUATE_START_BLOCK: '10',
      }),
    ).toThrow(/neither KEEPER_GRADUATE_PRIVATE_KEY nor KEEPER_GRADUATE_PRIVATE_KEY_FILE is set/)
  })

  it('bozuk bir ozel anahtar SESSIZCE baska bir imzalayana donusmez', () => {
    expect(() =>
      loadGraduatorConfig({
        ...BASE_ENV,
        KEEPER_GRADUATE_PRIVATE_KEY: 'not-a-key',
        KEEPER_GRADUATE_FACTORY: FACTORY,
        KEEPER_GRADUATE_LOCKER: LOCKER,
        KEEPER_GRADUATE_START_BLOCK: '10',
      }),
    ).toThrow(/32-byte hex/)
  })

  it('KURU KOSU VARSAYILANDIR', () => {
    const config = loadGraduatorConfig({
      ...BASE_ENV,
      KEEPER_GRADUATE_FACTORY: FACTORY,
      KEEPER_GRADUATE_LOCKER: LOCKER,
      KEEPER_GRADUATE_START_BLOCK: '56016843',
    })
    expect(config.dryRun).toBe(true)
    expect(config.privateKey).toBeUndefined()
    expect(config.factory).toBe(FACTORY)
    expect(config.locker).toBe(LOCKER)
    expect(config.startBlock).toBe(56_016_843n)
    expect(config.overridden).toBe(true)
  })

  it('IMLEC DOSYASI IZLEYICININKINDEN FARKLIDIR', () => {
    // Iki AYRI surec ayni dosyaya `writeFileSync` + `renameSync` yapsaydi,
    // biri digerinin ilerlemesini geri alirdi.
    expect(DEFAULT_GRADUATE_CURSOR_PATH).not.toBe(DEFAULT_CURSOR_PATH)
  })

  it('defter yolunda adresler DEFTERDEN gelir', () => {
    const config = loadGraduatorConfig(BASE_ENV)
    expect(config.overridden).toBe(false)
    // Uretim defteri: locker VE fabrika, ve tarama fabrikanin blogundan.
    expect(config.factory).toBe('0x5CA156f1809aB784655410d0f4B0704d2b306B47')
    expect(config.locker).toBe('0xaEE2DA2D21B92AfCAccF9DAD3d72254eE1630158')
    expect(config.startBlock).toBe(55_870_261n)
  })

  it('`--book-only` ELLE YAZILMIS ADRESLERI REDDEDER', () => {
    // Indexer `ARC_FACTORY_ADDRESS`i env'den alir ve `env-from-book.ts` onu
    // deftere baglamak icin VAR. Keeper defteri dogrudan okur; bu bayrak, bir
    // deployment'in o zayifligi `KEEPER_GRADUATE_*` uzerinden GERI GETIRMESINI
    // engeller.
    for (const name of ADDRESS_OVERRIDE_VARS) {
      expect(() =>
        loadGraduatorConfig(
          {
            ...BASE_ENV,
            KEEPER_GRADUATE_FACTORY: FACTORY,
            KEEPER_GRADUATE_LOCKER: LOCKER,
            KEEPER_GRADUATE_START_BLOCK: '10',
          },
          { bookOnly: true },
        ),
      ).toThrow(new RegExp(name))
    }
    // START_BLOCK TEK BASINA da reddedilir: defterin fabrikasini tararken
    // ilk launch'in ilerisinden baslamak, o curve'leri HIC gormemektir.
    expect(() =>
      loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_START_BLOCK: '99' }, { bookOnly: true }),
    ).toThrow(/KEEPER_GRADUATE_START_BLOCK/)
  })

  it('`--book-only` TEMIZ bir env ile defteri kullanir', () => {
    const config = loadGraduatorConfig(BASE_ENV, { bookOnly: true })
    expect(config.overridden).toBe(false)
    expect(config.factory).toBe('0x5CA156f1809aB784655410d0f4B0704d2b306B47')
  })

  it('BAYRAK ENV DEGIL ARGV OLMALIDIR -- kendi kilidini acan bir kapi olmasin', () => {
    // Kapi bir env degiskeni olsaydi, servisin `EnvironmentFile`i hem kapiyi
    // hem de kapinin engelledigi adresleri tasiyabilirdi.
    expect(ADDRESS_OVERRIDE_VARS).not.toContain('KEEPER_GRADUATE_BOOK_ONLY')
    const withFakeGate = loadGraduatorConfig({
      ...BASE_ENV,
      KEEPER_GRADUATE_BOOK_ONLY: 'true',
      KEEPER_GRADUATE_FACTORY: FACTORY,
      KEEPER_GRADUATE_LOCKER: LOCKER,
      KEEPER_GRADUATE_START_BLOCK: '10',
    })
    expect(withFakeGate.overridden).toBe(true)
  })

  it('`--once` TARAMA BUTCESINI BUYUTUR, cunku bir sonraki gecisi yoktur', () => {
    // Rasyonlanmis butce ile tek bir gecis, uretim defterinin 160.000+
    // bloguna karsi `caughtUp: false` dondururdu -- yani hicbir sey OKUMAMIS
    // bir kosu, "temiz" gorunen bir ciktiyla.
    expect(loadGraduatorConfig(BASE_ENV).maxChunksPerPass).toBe(1)
    expect(loadGraduatorConfig(BASE_ENV, { once: true }).maxChunksPerPass).toBe(
      ONCE_MAX_CHUNKS_PER_PASS,
    )
    // ACIK AYAR HER IKI MODU DA EZER.
    expect(
      loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_CHUNKS_PER_PASS: '3' }, { once: true })
        .maxChunksPerPass,
    ).toBe(3)
  })
})

// ---------------------------------------------------------------
// Imzalayan anahtari
// ---------------------------------------------------------------

const KEY = `0x${'ab'.repeat(32)}`

describe('imzalayan anahtari DOSYADAN da okunabilir', () => {
  const withKeyFile = (contents: string): NodeJS.ProcessEnv => {
    const dir = scratch()
    const path = join(dir, 'graduate.key')
    writeFileSync(path, contents, 'utf8')
    return { ...BASE_ENV, KEEPER_GRADUATE_PRIVATE_KEY_FILE: path }
  }

  it('dosyadan okur ve SATIR SONUNU kirpar', () => {
    // systemd'nin `LoadCredentialEncrypted=`i, `echo` ve her editor satir sonu
    // birakir. Kirpmamak, hatayi dosyanin GORUNMEZ son baytindan uretirdi.
    expect(loadGraduatorConfig(withKeyFile(`${KEY}\n`)).privateKey).toBe(KEY)
  })

  it('IKISI BIRDEN verilirse REDDEDER', () => {
    // "Hangisi kazandi" sorusunun cevabi bir IMZALAYAN KIMLIGIDIR.
    const env = { ...withKeyFile(KEY), KEEPER_GRADUATE_PRIVATE_KEY: KEY }
    expect(() => loadGraduatorConfig(env)).toThrow(/both set/)
  })

  it('bos ya da bozuk bir dosya SESSIZCE baska bir imzalayana donusmez', () => {
    expect(() => loadGraduatorConfig(withKeyFile('   \n'))).toThrow(/is empty/)
    expect(() => loadGraduatorConfig(withKeyFile('deadbeef\n'))).toThrow(/32-byte hex/)
  })

  it('okunamayan bir dosya BASLAMAYI engeller', () => {
    expect(() =>
      loadGraduatorConfig({
        ...BASE_ENV,
        KEEPER_GRADUATE_PRIVATE_KEY_FILE: join(scratch(), 'does-not-exist'),
      }),
    ).toThrow(/cannot be read/)
  })

  it('HATA SATIRI ANAHTARIN ICERIGINI YAZMAZ, yalnizca kaynagini', () => {
    // journald'a basilan bir anahtar, oradan her log toplayicisina gider.
    const secret = `0x${'11'.repeat(31)}` // 62 hane: gecersiz, ama gizli
    let message = ''
    try {
      loadGraduatorConfig(withKeyFile(secret))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/32-byte hex/)
    expect(message).not.toContain(secret)
  })

  it('KEEPER_DRY_RUN=false, DOSYA yolu ile KABUL EDILIR', () => {
    const config = loadGraduatorConfig({ ...withKeyFile(KEY), KEEPER_DRY_RUN: 'false' })
    expect(config.dryRun).toBe(false)
    expect(config.privateKey).toBe(KEY)
  })
})

// ---------------------------------------------------------------
// Dongu
// ---------------------------------------------------------------

describe('runPollLoop', () => {
  it('ILK GECISTEN SONRA COZULMEZ -- olculmus 13 saniyelik olumun testi', () => {
    // OLCULDU 2026-08-09: dongu modu tek bir gecisten sonra cikis kodu 0 ile
    // oldu, cunku `main` cozuluyordu ve `settle`in `unref`li 10 saniyelik
    // zamanlayicisi `exit()` cagiriyordu. `unref` bir zamanlayicinin sureci
    // ayakta TUTMASINI engeller, ATESLEMESINI degil.
    let passes = 0
    let settled = false
    const pending: (() => void)[] = []
    const done = runPollLoop({
      pass: () => {
        passes += 1
        return Promise.resolve()
      },
      stopped: () => false,
      pollIntervalMs: 15_000,
      schedule: (fn) => pending.push(fn),
    })
    void done.then(() => {
      settled = true
    })

    return Promise.resolve().then(() => {
      expect(passes).toBe(1)
      expect(settled).toBe(false)
      // ...ve zamanlayici atesleyince BIR SONRAKI gecis kosar.
      pending.shift()?.()
      return Promise.resolve().then(() => {
        expect(passes).toBe(2)
        expect(settled).toBe(false)
      })
    })
  })

  it('DURDURULUNCA, ELDEKI gecisi bitirip cozulur', async () => {
    let stopped = false
    let passes = 0
    const pending: (() => void)[] = []
    const done = runPollLoop({
      pass: () => {
        passes += 1
        // SIGTERM gecisin ORTASINDA gelir.
        stopped = true
        return Promise.resolve()
      },
      stopped: () => stopped,
      pollIntervalMs: 15_000,
      schedule: (fn) => pending.push(fn),
    })
    await done
    expect(passes).toBe(1)
    // Cozulduyse bir sonraki gecis ZAMANLANMAMIS olmali.
    expect(pending).toHaveLength(0)
  })

  it('REDDEDEN bir gecis donguyu REDDETTIRIR -- ariza yutulmaz', async () => {
    await expect(
      runPollLoop({
        pass: () => Promise.reject(new Error('rpc died')),
        stopped: () => false,
        pollIntervalMs: 1,
        schedule: (fn) => fn(),
      }),
    ).rejects.toThrow(/rpc died/)
  })
})

// ---------------------------------------------------------------
// Gecis ozeti
// ---------------------------------------------------------------

describe('renderSummary', () => {
  const SUMMARY = {
    head: 1n,
    target: '0x0000000000000000000000000000000000000000' as Address,
    armed: false,
    caughtUp: true,
    knownCurves: 2,
    pending: [],
    pendingQuoteWei: 0n,
    outcomes: [],
    broadcast: 0,
  }

  it('KAYNAK HER SATIRDA GORUNUR', () => {
    // Bu alan olmadan, defterden kurulmus bir yurutucu ile baska bir yigina
    // yonlendirilmis bir yurutucu pager'in gordugu akista AYNI gorunurdu.
    expect(renderSummary(SUMMARY, { source: 'book' })).toContain('src=book')
    expect(renderSummary(SUMMARY, { source: 'env-override' })).toContain('src=env-override')
  })

  it('alan `at=`den SONRA gelir, yani onek eslestiren okuyucular BOZULMAZ', () => {
    const line = renderEvent(
      { kind: 'heartbeat', at: 0, state: 'current', detail: renderSummary(SUMMARY) },
      GRADUATE_ALERT_COMPONENT,
    )
    // Harici olu-adam anahtari ve ileticinin ayristiricisi bu onegi eslestirir.
    expect(/^HEARTBEAT keeper\.graduate at=(\S+)/.test(line)).toBe(true)
    expect(line).toContain('src=book')
  })
})

// ---------------------------------------------------------------
// Kilit
// ---------------------------------------------------------------

describe('fileCurveLocks', () => {
  it('ikinci bir yurutucu AYNI curve icin kilidi ALAMAZ', () => {
    const dir = scratch()
    const first = fileCurveLocks(dir, 'exec-1')
    const second = fileCurveLocks(dir, 'exec-2')

    const a = first.acquire(CURVE, 1_000)
    expect(isLockRefusal(a)).toBe(false)
    const b = second.acquire(CURVE, 1_000)
    expect(isLockRefusal(b)).toBe(true)
    if (isLockRefusal(b)) expect(b.heldBy).toBe('exec-1')
  })

  it('birakildiktan sonra kilit yeniden alinabilir', () => {
    const dir = scratch()
    const locks = fileCurveLocks(dir, 'exec-1')
    const a = locks.acquire(CURVE, 1_000)
    if (isLockRefusal(a)) throw new Error('unreachable')
    a.release()
    expect(isLockRefusal(locks.acquire(CURVE, 1_000))).toBe(false)
  })

  it('BAYAT bir kilit calinir -- ve calindigi SOYLENIR', () => {
    // Kilidini birakmadan olen bir surec (SIGKILL) aksi halde o curve'u
    // SONSUZA KADAR bloklardi, ve "graduation hic olmuyor" arizasinin sebebi
    // bir dosya olurdu.
    const dir = scratch()
    const first = fileCurveLocks(dir, 'exec-1', { ttlMs: 100 })
    const second = fileCurveLocks(dir, 'exec-2', { ttlMs: 100 })
    first.acquire(CURVE, 1_000)
    const stolen = second.acquire(CURVE, 1_500)
    expect(isLockRefusal(stolen)).toBe(false)
    if (!isLockRefusal(stolen)) expect(stolen.stolen).toBe(true)
  })

  it('ESKI SAHIP calinmis bir kilidi SILEMEZ', () => {
    const dir = scratch()
    const first = fileCurveLocks(dir, 'exec-1', { ttlMs: 100 })
    const second = fileCurveLocks(dir, 'exec-2', { ttlMs: 100 })
    const a = first.acquire(CURVE, 1_000)
    const b = second.acquire(CURVE, 1_500)
    if (isLockRefusal(a) || isLockRefusal(b)) throw new Error('unreachable')
    a.release() // gec kalmis birakma
    // b HALA gecerli olmali.
    const third = fileCurveLocks(dir, 'exec-3', { ttlMs: 100 })
    expect(isLockRefusal(third.acquire(CURVE, 1_550))).toBe(true)
  })

  it('YIRTIK bir kilit dosyasi kalici bir kapi olmaz', () => {
    const dir = scratch()
    const locks = fileCurveLocks(dir, 'exec-1')
    writeFileSync(join(dir, `${CURVE.toLowerCase()}.lock`), '{ not json', 'utf8')
    expect(isLockRefusal(locks.acquire(CURVE, 1_000))).toBe(false)
  })
})

// ---------------------------------------------------------------
// Karantina
// ---------------------------------------------------------------

describe('fileQuarantineStore', () => {
  const identity = { chainId: 5_042_002, factory: FACTORY, locker: LOCKER }
  const payoutRejected = classifyRevert('0x1ee5f101')

  it('karar DISKTE yasar: yeniden baslatma yeniden sayfa cikarmaz', () => {
    const path = join(scratch(), 'state.json')
    const first = fileQuarantineStore(path, identity)
    first.hold(CURVE, payoutRejected, 1_000)

    const second = fileQuarantineStore(path, identity)
    expect(second.isHeld(CURVE, 1_500)).toBe(true)
    expect(second.entry(CURVE)?.selector).toBe('0x1ee5f101')
  })

  it('BASKA bir deployment icin yazilmis durum YOK SAYILIR ve bu SESSIZ DEGILDIR', () => {
    const path = join(scratch(), 'state.json')
    fileQuarantineStore(path, identity).hold(CURVE, payoutRejected, 1_000)

    const reasons: string[] = []
    const other = fileQuarantineStore(
      path,
      { ...identity, locker: '0xaEE2DA2D21B92AfCAccF9DAD3d72254eE1630158' as Address },
      { onReset: (reason) => reasons.push(reason) },
    )
    expect(other.isHeld(CURVE, 1_500)).toBe(false)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('redeploy')
  })

  it('deneme sayisi BIRIKIR -- kalici bir ariza gorunur kalir', () => {
    const path = join(scratch(), 'state.json')
    const store = fileQuarantineStore(path, identity)
    expect(store.hold(CURVE, payoutRejected, 1_000).attempts).toBe(1)
    expect(store.hold(CURVE, payoutRejected, 2_000).attempts).toBe(2)
    expect(JSON.parse(readFileSync(path, 'utf8')).quarantine[CURVE].attempts).toBe(2)
  })

  it('temizlenen bir curve diskten de DUSER', () => {
    const path = join(scratch(), 'state.json')
    const store = fileQuarantineStore(path, identity)
    store.hold(CURVE, payoutRejected, 1_000)
    store.clear(CURVE)
    expect(fileQuarantineStore(path, identity).entry(CURVE)).toBeUndefined()
  })
})

// ---------------------------------------------------------------
// Runbook §0, `TODO(owner)` sayaci.
//
// NEDEN BIR TEST. §0 devredilmemis her deleigi sayar ve ikisi de PROSE
// icinde yazili: baslikta bir sayi, ozet cumlesinde iki sayi, ve altinda
// operatorun elle kosacagi iki `grep`. Prose bir build DUSURMEZ.
//
// Ve tam olarak bu sekilde surukleniyor: `arcpad-indexer.service` kendi
// `TODO(owner) 2` isaretiyle eklendi, toplam degisti, bu satira kimse
// dokunmadi. Belge 17 diyordu, gercek 18'di -- ve §0'in kendisi ayni
// arizanin daha eskisini anlatiyor (`graduation-window.md` §7 "uc" derken
// dordunu tasiyordu). Bir belge kendi uyardigi hataya iki kere dustuyse,
// sayaci artik makine tutmalidir.
// ---------------------------------------------------------------
describe('runbook §0 sayaci GERCEKLE ayni kalir', () => {
  const RUNBOOK = fileURLToPath(new URL('../../docs/runbooks/keeper-vps.md', import.meta.url))

  /**
   * KUTUNUN TAMAMI, yalnizca keeper degil. Site ayni VPS'te, ayni
   * `/etc/arcpad`ten, ayni servis hesabiyla kosuyor; delikleri de ayni
   * defterde. Bu liste `keeper-vps.md` §0'in "whole box" cumlesinin
   * MAKINE tarafi -- ikisi ayrilirsa bu suite soyler.
   */
  const SCANNED = [
    RUNBOOK,
    fileURLToPath(new URL('../../docs/runbooks/web-vps.md', import.meta.url)),
    fileURLToPath(new URL('../deploy', import.meta.url)),
    fileURLToPath(new URL('../../web/deploy', import.meta.url)),
    fileURLToPath(new URL('../../packages/db/deploy', import.meta.url)),
  ]

  /** `grep -rho 'TODO(owner) [0-9]' <the four paths above>` */
  function markers(): string[] {
    const files = SCANNED.flatMap((p) =>
      statSync(p).isDirectory() ? readdirSync(p).map((f) => join(p, f)) : [p],
    )
    return files
      .filter((f) => statSync(f).isFile())
      .flatMap((f) => readFileSync(f, 'utf8').match(/TODO\(owner\) \d+/g) ?? [])
  }

  const WORDS = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
    'twenty-one',
    'twenty-two',
    'twenty-three',
    'twenty-four',
    'twenty-five',
    'twenty-six',
    'twenty-seven',
    'twenty-eight',
    'twenty-nine',
    'thirty',
  ]

  const runbook = readFileSync(RUNBOOK, 'utf8')
  const found = markers()
  const values = new Set(found).size
  const sites = found.length

  it('BASLIK dogru DEGER sayisini soyler', () => {
    const heading = /## 0\. The `TODO\(owner\)` holes — there are \*\*([a-z]+)\*\*/.exec(runbook)
    expect(heading, 'runbook §0 basligi bulunamadi -- basligi mi degistirdiniz?').not.toBeNull()
    expect(WORDS.indexOf(heading![1]!)).toBe(values)
  })

  it('OZET CUMLESI hem degeri hem SITE sayisini dogru soyler', () => {
    // `[a-z-]+`: yirmiyi gecince sayilar TIRELI yazilir (`twenty-five`) ve
    // tireyi disarida birakan bir regex, dogru bir cumleyi "bulunamadi"
    // diye reddeder -- kirmizi, ama yanlis sebeple.
    const summary = /\*\*([A-Z][a-z-]+) values, ([a-z-]+) sites\*\*/.exec(runbook)
    expect(summary, 'runbook §0 ozet cumlesi bulunamadi').not.toBeNull()
    expect(WORDS.indexOf(summary![1]!.toLowerCase())).toBe(values)
    expect(WORDS.indexOf(summary![2]!)).toBe(sites)
  })

  it('OPERATORUN KOSACAGI iki grep, yazili beklentileriyle ayni sonucu verir', () => {
    // `# -> N` yorumlari §0'daki bash blogunun ta kendisi. Bir operator bu
    // iki komutu 3'te kosar; ciktilarinin yaninda yazan sayilar yanlissa
    // dogru davranisi ariza sanip aramaya baslar.
    const expectations = [...runbook.matchAll(/# -> (\d+)/g)].map((m) => Number(m[1]))
    expect(expectations, 'iki `# -> N` beklentisi olmali').toEqual([values, sites])
  })

  it('HICBIR isaret 9u GECMEZ -- yoksa runbook`un kendi grep`i yanlis sayar', () => {
    // Belgelenen komut `[0-9]` kullanir, yani TEK hane eslestirir:
    // `TODO(owner) 10` onun icin `TODO(owner) 1`dir ve sessizce yanlis
    // sayar. Onuncu delige kadar bu dogru; onuncuyu ekleyen bu testi
    // kirar ve grep`i duzeltmesi gerektigini ogrenir.
    const highest = Math.max(...found.map((m) => Number(m.slice('TODO(owner) '.length))))
    expect(highest).toBeLessThanOrEqual(9)
  })
})
