import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { renderEvent } from '../src/alert'
import {
  DEFAULT_GRADUATE_CURSOR_PATH,
  GRADUATE_ALERT_COMPONENT,
  loadGraduatorConfig,
  ONCE_MAX_CHUNKS_PER_PASS,
} from '../src/graduate/config'
import { fileCurveLocks, isLockRefusal } from '../src/graduate/lock'
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
    expect(() =>
      loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_FACTORY: FACTORY }),
    ).toThrow(/must be set together/)
    expect(() =>
      loadGraduatorConfig({ ...BASE_ENV, KEEPER_GRADUATE_LOCKER: LOCKER }),
    ).toThrow(/must be set together/)
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
    ).toThrow(/KEEPER_GRADUATE_PRIVATE_KEY is not set/)
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
    expect(config.locker).toBe('0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8')
    expect(config.startBlock).toBe(55_870_261n)
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
      loadGraduatorConfig(
        { ...BASE_ENV, KEEPER_GRADUATE_CHUNKS_PER_PASS: '3' },
        { once: true },
      ).maxChunksPerPass,
    ).toBe(3)
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
      { ...identity, locker: '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8' as Address },
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
