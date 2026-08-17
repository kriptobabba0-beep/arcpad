import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address } from 'viem'

/**
 * ============ IKI YURUTUCU AYNI CURVE ICIN GAZ YAKMAMALI ============
 *
 * `ArcpadLocker.graduate` IZINSIZDIR, yani yaris KAYBEDEN taraf icin zararsiz
 * DEGIL, sadece UCUZDUR: kaybeden `AlreadyGraduated()` alir. Yurutucunun ilk
 * savunmasi bu yuzden kilit degil SIMULASYONDUR -- her yayindan hemen once bir
 * `eth_call`, ve kaybeden taraf SIFIR gaz harcar.
 *
 * KILIDIN KAPATTIGI SEY BASKA: iki surecin AYNI ANDA, AYNI BLOKTA simule
 * etmesi. Ikisi de gecer, ikisi de yayinlar, biri zincirde revert eder --
 * ve AYNI ANAHTARLA kosuyorlarsa nonce carpismasi gaz kaybindan daha kotu bir
 * seydir: iki islemden biri "replacement transaction underpriced" ile
 * DUSER ve o dusus surekli tekrarlanabilir.
 *
 * KILIT TAVSIYEDIR, GARANTI DEGIL, VE BU ACIKCA SOYLENIR. Paylasilan bir dosya
 * sisteminde `wx` bayragi atomiktir; agdaki bir dosya sisteminde olmayabilir.
 * Dogru operasyonel kural TEK BIR YURUTUCU KOSTURMAKTIR; kilit, ikincisinin
 * kazara ayaga kalkmasina karsi derinlemesine savunmadir.
 *
 * BAYAT KILIT CALINIR. Kilidini birakmadan olen bir surec (SIGKILL, OOM) aksi
 * halde o curve'u SONSUZA KADAR bloklardi -- ve "graduation hic olmuyor"
 * arizasinin sebebinin bir dosya olmasi, bu deponun tam olarak kacindigi
 * sessizlik sinifidir. Calma SESSIZ DEGILDIR: `stolen` bayragi cagirana doner.
 */

export type LockHandle = {
  readonly curve: Address
  readonly path: string
  readonly token: string
  /** Bayat bir kilidin uzerine alindi mi. Cagiran bunu KAYDA GECIRIR. */
  readonly stolen: boolean
  release(): void
}

export type LockRefusal = {
  readonly heldBy: string
  readonly expiresAt: number
  readonly detail: string
}

export interface CurveLocks {
  acquire(curve: Address, nowMs: number): LockHandle | LockRefusal
}

export function isLockRefusal(value: LockHandle | LockRefusal): value is LockRefusal {
  return (value as LockHandle).release === undefined
}

/** Varsayilan kilit omru. Bir graduation islemi bunun cok altinda iner. */
export const DEFAULT_LOCK_TTL_MS = 300_000

type LockFile = { owner: string; token: string; acquiredAt: number; expiresAt: number }

/**
 * @param dir     Kilit dosyalarinin dizini. Yurutucunun durum dosyasiyla ayni
 *                yerde durur; ayri bir knob bir daha unutulacak bir knobtur.
 * @param owner   Insan okuyabilir sahip kimligi. Sayfada gorunur.
 */
export function fileCurveLocks(dir: string, owner: string, opts?: { ttlMs?: number }): CurveLocks {
  const ttlMs = opts?.ttlMs ?? DEFAULT_LOCK_TTL_MS
  mkdirSync(dir, { recursive: true })

  const pathFor = (curve: Address): string => join(dir, `${curve.toLowerCase()}.lock`)

  const write = (path: string, body: LockFile): boolean => {
    try {
      writeFileSync(path, `${JSON.stringify(body)}\n`, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  return {
    acquire(curve: Address, nowMs: number): LockHandle | LockRefusal {
      const path = pathFor(curve)
      const token = randomBytes(12).toString('hex')
      const body: LockFile = { owner, token, acquiredAt: nowMs, expiresAt: nowMs + ttlMs }

      const handle = (stolen: boolean): LockHandle => ({
        curve,
        path,
        token,
        stolen,
        release(): void {
          // YALNIZCA HALA BIZIMSE SILINIR. Bayat sayilip calinmis bir kilidi
          // eski sahibinin silmesi, YENI sahibin kilidini silmek olurdu.
          let current: LockFile | null = null
          try {
            current = JSON.parse(readFileSync(path, 'utf8')) as LockFile
          } catch {
            return
          }
          if (current.token !== token) return
          try {
            rmSync(path, { force: true })
          } catch {
            /* bir sonraki gecis bayat sayip alir */
          }
        },
      })

      if (write(path, body)) return handle(false)

      let existing: LockFile | null = null
      try {
        existing = JSON.parse(readFileSync(path, 'utf8')) as LockFile
      } catch {
        // OKUNAMAYAN BIR KILIT BAYATTIR. Yirtik bir dosya, yazma ortasinda
        // olmus bir sureci temsil eder ve sonsuza kadar reddedecek bir kapiya
        // donusmemelidir.
        existing = null
      }

      if (existing !== null && existing.expiresAt > nowMs) {
        return {
          heldBy: existing.owner,
          expiresAt: existing.expiresAt,
          detail: `${curve} is locked by ${existing.owner} until ${new Date(existing.expiresAt).toISOString()}; this pass leaves it alone. Two executors on one curve would both simulate green in the same block and both broadcast.`,
        }
      }

      try {
        rmSync(path, { force: true })
      } catch {
        /* asagidaki yazma zaten karar verir */
      }
      if (write(path, body)) return handle(true)
      return {
        heldBy: existing?.owner ?? 'unknown',
        expiresAt: existing?.expiresAt ?? 0,
        detail: `${curve} could not be locked even after the stale lock at ${path} was cleared -- another executor took it in the same instant.`,
      }
    },
  }
}
