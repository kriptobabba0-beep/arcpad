import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertAlertLogWritable, fileSink, SINK_COMPLAINT_INTERVAL_MS } from '../src/alert'

/**
 * ALARM YOLU IZLEYICIYI OLDUREMEZ.
 *
 * OLCULDU, runbook section 8'in KENDI komutuyla, canli zincire karsi:
 *
 *   $ KEEPER_ALERT_LOG=keeper/alerts.log pnpm --filter @arcpad/keeper start
 *   keeper ready chainId=5042002 pollIntervalMs=30000 dryRun=true
 *   HEARTBEAT keeper.graduationWindow at=2026-08-01T02:48:00.576Z
 *   Error: ENOENT: no such file or directory,
 *          open 'D:\pumpfunforarc\keeper\keeper\alerts.log'
 *   [exit 1]
 *
 * Tek bir kalp atisi, sonra olum -- cunku `heartbeat()` `runWatcher` icinde
 * her `try`in DISINDA cagrilir. Yani "tek savunma hatti", alarm dosyasinin
 * yolu yanlis oldugu icin oluyordu.
 */

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcpad-sink-'))
  scratch.push(dir)
  return dir
}

describe('assertAlertLogWritable', () => {
  it('yazilabilir bir yolu kabul eder ve DOSYAYI BOZMAZ', () => {
    const path = join(tempDir(), 'alerts.log')
    const sink = fileSink(path)
    sink({ kind: 'heartbeat', at: 0, state: 'current' })
    const before = readFileSync(path, 'utf8')
    expect(() => assertAlertLogWritable(path)).not.toThrow()
    // Bos dize ekler: var olan kaydi SILMEZ. Bir tatbikatin kanitini
    // acilisin silmesi, kapinin kendisini bosaltirdi.
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('OLMAYAN BIR DIZINDE yolu ADIYLA reddeder -- ilk kalp atisinda degil, ACILISTA', () => {
    const path = join(tempDir(), 'nope', 'alerts.log')
    expect(() => assertAlertLogWritable(path)).toThrow(/cannot write the alert sink at/)
    expect(() => assertAlertLogWritable(path)).toThrow(/KEEPER_ALERT_LOG/)
    expect(existsSync(path)).toBe(false)
  })
})

describe('fileSink yazma hatasi', () => {
  it('FIRLATMAZ: yazilamayan bir lavabo izleyiciyi olduremez', () => {
    const path = join(tempDir(), 'gone', 'alerts.log')
    const sink = fileSink(path)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Onceki hal burada ENOENT firlatirdi ve `heartbeat()` her `try`in
    // disinda oldugu icin poll'u reddettirip DONGUYU BITIRIRDI.
    expect(() => sink({ kind: 'heartbeat', at: 1_000, state: 'current' })).not.toThrow()
    expect(() => sink({ kind: 'alert', level: 'page', message: 'x', at: 1_001 })).not.toThrow()
  })

  it('SESSIZ DE KALMAZ: stderr"e `PAGE ` onekiyle sikayet eder', () => {
    const path = join(tempDir(), 'gone', 'alerts.log')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fileSink(path, { now: () => 1_000 })({ kind: 'heartbeat', at: 1_000, state: 'current' })
    expect(spy).toHaveBeenCalledTimes(1)
    const line = spy.mock.calls[0]?.[0] as string
    // Harici olu-adam anahtari `PAGE ` onekine gore filtreler, JSON
    // ayristirmaz; sikayet o filtreden GECMELIDIR.
    expect(line.startsWith('PAGE keeper.graduationWindow ')).toBe(true)
    expect(line).toContain('alert-sink-write-failed')
    expect(line).toContain(path)
  })

  it('sikayeti dakikada bire indirir -- bozuk bir disk konsolu doldurmamali', () => {
    const path = join(tempDir(), 'gone', 'alerts.log')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let clock = 1_000
    const sink = fileSink(path, { now: () => clock })
    sink({ kind: 'heartbeat', at: clock, state: 'current' })
    clock += SINK_COMPLAINT_INTERVAL_MS - 1
    sink({ kind: 'heartbeat', at: clock, state: 'current' })
    expect(spy).toHaveBeenCalledTimes(1)
    clock += 1
    sink({ kind: 'heartbeat', at: clock, state: 'current' })
    // Bastirilan sey TEKRARDIR, sikayetin KENDISI degil: kalici bir ariza
    // dakikada bir yeniden gorunur, yoksa sessizlige donerdi.
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
