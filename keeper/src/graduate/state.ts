import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Address } from 'viem'
import type { Classification } from './outcome'

/**
 * ============ KARANTINA: SUREKLI SAYFA ILE KALICI KORLUK ARASI ============
 *
 * Yeniden denemenin ASLA basaramayacagi bir revert -- bloklanmis bir odeme
 * hedefi, kanonik olmayan bir curve -- her gecisde tekrar denenirse her
 * gecisde tekrar sayfa cikarir. Bes saniyelik bir aralikta bu gunde ~17.000
 * sayfadir ve sonucu OLCULMUSTUR: rota o sayfayi susturmayi ogrenir ve
 * kontrol, hala "calisiyor" gorunurken sifira duser.
 *
 * TERS YON DE AYNI DERECEDE KOTUDUR. Bir curve'u sonsuza kadar karantinaya
 * almak, gecici olarak yanlis siniflandirilmis tek bir arizanin o curve'u
 * KALICI OLARAK gorunmez yapmasi demektir -- ve gorunmez bir maruziyet, bu
 * deponun bes kez odedigi sekildir.
 *
 * BU YUZDEN KARANTINANIN BIR OMRU VAR. Girdi `until`e kadar denenmez, sonra
 * TEK bir kez daha denenir; hala bozuksa yeniden karantinaya girer ve YENIDEN
 * sayfa cikarir. Yani kalici bir ariza gunde bir kez duyulur, saniyede bir kez
 * degil, ve hicbir zaman TAMAMEN susmaz.
 *
 * KARANTINAYA ALINAN CURVE'LER YINE DE SAYILIR VE RAPOR EDILIR. Karantina
 * "denemeyi birak" demektir, "yok say" demek DEGIL: her gecisin ozeti onlari
 * ADIYLA tasir, yoksa maruziyet rakami sessizce kuculurdu.
 */

export const QUARANTINE_VERSION = 1

/** Varsayilan karantina omru. */
export const DEFAULT_QUARANTINE_MS = 24 * 60 * 60 * 1000

export type QuarantineEntry = {
  code: string
  errorName: string | null
  selector: string | null
  reason: string
  atMs: number
  untilMs: number
  attempts: number
}

export type GraduatorIdentity = { chainId: number; factory: Address; locker: Address }

export interface QuarantineStore {
  entry(curve: Address): QuarantineEntry | undefined
  /** `nowMs`te bu curve denenmemeli mi. */
  isHeld(curve: Address, nowMs: number): boolean
  /** Karantinaya al ya da mevcut girdiyi tazeleyip deneme sayisini artir. */
  hold(curve: Address, classification: Classification, nowMs: number): QuarantineEntry
  /** Curve mezun oldu ya da artik bizim isimiz degil. */
  clear(curve: Address): void
  /** Su an tutulan her curve. */
  held(nowMs: number): Address[]
  /** Bilinen her girdi -- suresi gecmisler dahil. */
  all(): ReadonlyMap<Address, QuarantineEntry>
}

type Persisted = {
  version: number
  chainId: number
  factory: Address
  locker: Address
  quarantine: Record<string, QuarantineEntry>
}

/**
 * @param onReset Kimlik uyusmazliginda ya da bozuk dosyada SESSIZ OLMAZ. Ayni
 *                kural `fileCursorStore`da olculdu: baslamayan bir surec,
 *                yanlis durumlu bir surecten kotudur, ama "durum neden bir
 *                anda bosaldi" sorusunun cevabi kayitli olmalidir.
 */
export function fileQuarantineStore(
  path: string,
  identity: GraduatorIdentity,
  opts?: { quarantineMs?: number; onReset?: (reason: string) => void },
): QuarantineStore {
  const quarantineMs = opts?.quarantineMs ?? DEFAULT_QUARANTINE_MS
  const entries = new Map<Address, QuarantineEntry>()

  const load = (): void => {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return
    }
    let parsed: Persisted
    try {
      parsed = JSON.parse(raw) as Persisted
    } catch (cause) {
      opts?.onReset?.(
        `${path} could not be parsed (${cause instanceof Error ? cause.message : String(cause)}); the quarantine list restarts empty, so a curve that was previously held will be retried once and re-page if it is still broken.`,
      )
      return
    }
    if (parsed.version !== QUARANTINE_VERSION) return
    if (
      parsed.chainId !== identity.chainId ||
      String(parsed.factory).toLowerCase() !== identity.factory.toLowerCase() ||
      String(parsed.locker).toLowerCase() !== identity.locker.toLowerCase()
    ) {
      opts?.onReset?.(
        `${path} was written for chainId ${parsed.chainId} factory ${parsed.factory} locker ${parsed.locker}, not ${identity.chainId}/${identity.factory}/${identity.locker}; it is being ignored. This is expected after a redeploy -- a quarantine decision about another deployment's curve says nothing about this one.`,
      )
      return
    }
    for (const [curve, entry] of Object.entries(parsed.quarantine ?? {})) {
      entries.set(curve as Address, entry)
    }
  }

  const flush = (): void => {
    const body: Persisted = {
      version: QUARANTINE_VERSION,
      chainId: identity.chainId,
      factory: identity.factory,
      locker: identity.locker,
      quarantine: Object.fromEntries(entries),
    }
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }

  load()

  return {
    entry(curve: Address): QuarantineEntry | undefined {
      return entries.get(curve)
    },
    isHeld(curve: Address, nowMs: number): boolean {
      const found = entries.get(curve)
      return found !== undefined && found.untilMs > nowMs
    },
    hold(curve: Address, classification: Classification, nowMs: number): QuarantineEntry {
      const previous = entries.get(curve)
      const entry: QuarantineEntry = {
        code: classification.code,
        errorName: classification.errorName,
        selector: classification.selector,
        reason: classification.reason,
        atMs: nowMs,
        untilMs: nowMs + quarantineMs,
        attempts: (previous?.attempts ?? 0) + 1,
      }
      entries.set(curve, entry)
      flush()
      return entry
    },
    clear(curve: Address): void {
      if (!entries.delete(curve)) return
      flush()
    },
    held(nowMs: number): Address[] {
      return [...entries.entries()].filter(([, e]) => e.untilMs > nowMs).map(([curve]) => curve)
    },
    all(): ReadonlyMap<Address, QuarantineEntry> {
      return entries
    },
  }
}

/** Diske hic dokunmayan magaza. Testler ve `--no-state` icin. */
export function memoryQuarantineStore(opts?: { quarantineMs?: number }): QuarantineStore {
  const quarantineMs = opts?.quarantineMs ?? DEFAULT_QUARANTINE_MS
  const entries = new Map<Address, QuarantineEntry>()
  return {
    entry: (curve) => entries.get(curve),
    isHeld: (curve, nowMs) => {
      const found = entries.get(curve)
      return found !== undefined && found.untilMs > nowMs
    },
    hold: (curve, classification, nowMs) => {
      const previous = entries.get(curve)
      const entry: QuarantineEntry = {
        code: classification.code,
        errorName: classification.errorName,
        selector: classification.selector,
        reason: classification.reason,
        atMs: nowMs,
        untilMs: nowMs + quarantineMs,
        attempts: (previous?.attempts ?? 0) + 1,
      }
      entries.set(curve, entry)
      return entry
    },
    clear: (curve) => {
      entries.delete(curve)
    },
    held: (nowMs) => [...entries.entries()].filter(([, e]) => e.untilMs > nowMs).map(([c]) => c),
    all: () => entries,
  }
}
