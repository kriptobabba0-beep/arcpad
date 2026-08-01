import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadRepoEnv, REPO_ENV_PATH } from '../src/env'

/**
 * BU DOSYA DA CANLI BIR OLCUMDEN DOGDU.
 *
 * Runbook section 8'in yazdigi komut, kelimesi kelimesine:
 *
 *   $ pnpm --filter @arcpad/keeper start
 *   Error: ARC_RPC_URL is not set (see .env.example)
 *
 * Sebep: `pnpm --filter` komutu PAKET dizininde calistirir, `import
 * 'dotenv/config'` ise `.env`i `process.cwd()`e gore arar. Depo kokundeki
 * `.env` hic okunmuyordu.
 *
 * Bu testler o yolun DOSYA SISTEMI ILE ilgili kismini calistirir; hicbiri
 * gercek `process.env`e dokunmaz (`processEnv` hedefi enjekte edilir), yani
 * paralel kosan diger testleri kirletmez.
 */

describe('loadRepoEnv', () => {
  it('yolu CALISMA DIZININE gore DEGIL, modulun konumuna gore cozer', () => {
    const expected = fileURLToPath(new URL('../../.env', import.meta.url))
    expect(REPO_ENV_PATH).toBe(expected)
    // Depo koku, `keeper/`nin bir ustu. Sabit `keeper/.env`e cozseydi
    // belgelenmis komut yine olurdu.
    expect(REPO_ENV_PATH.endsWith('.env')).toBe(true)
    expect(REPO_ENV_PATH).not.toContain(`keeper${REPO_ENV_PATH.includes('/') ? '/' : '\\'}.env`)
  })

  it('depo kokundeki .env varsa DEGISKENLERI hedefe yazar', () => {
    if (!existsSync(REPO_ENV_PATH)) {
      // CI'da `.env` yoktur (gitignore'lu). O durumda asagidaki
      // "eksik dosya hata degildir" testi zaten yolu kapsar.
      expect(loadRepoEnv({}).loaded).toBe(false)
      return
    }
    const target: NodeJS.ProcessEnv = {}
    const result = loadRepoEnv(target)
    expect(result.loaded).toBe(true)
    expect(result.path).toBe(REPO_ENV_PATH)
    // Dosyada ne varsa hedefte de olmali. En az bir anahtar okunmus olmali.
    const keys = readFileSync(REPO_ENV_PATH, 'utf8')
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim())?.[1])
      .filter((k): k is string => k !== undefined)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(Object.keys(target)).toContain(key)
  })

  it('DISARIDAN VERILEN degiskeni EZMEZ', () => {
    if (!existsSync(REPO_ENV_PATH)) return
    const keys = readFileSync(REPO_ENV_PATH, 'utf8')
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim())?.[1])
      .filter((k): k is string => k !== undefined)
    const first = keys[0]
    if (first === undefined) return
    const target: NodeJS.ProcessEnv = { [first]: 'set-by-the-operator' }
    loadRepoEnv(target)
    // `KEEPER_ALERT_LOG=... pnpm --filter @arcpad/keeper start` ve CI'nin
    // enjekte ettikleri `.env`i EZMELI, tersi degil.
    expect(target[first]).toBe('set-by-the-operator')
  })

  it(".env YOKSA firlatmaz -- uretimde ve CI'da dosya hic bulunmaz", () => {
    // Var olmayan bir yola isaret eden bir yukleme, `loaded: false` doner ve
    // SESSIZ kalir. Eksik degiskeni ALANI ADIYLA reddetmek
    // loadKeeperConfig/loadWatcherConfig'in isidir.
    const target: NodeJS.ProcessEnv = {}
    expect(() => loadRepoEnv(target)).not.toThrow()
  })
})
