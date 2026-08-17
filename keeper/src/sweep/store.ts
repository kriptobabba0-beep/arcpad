import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Address } from 'viem'
import { getAddress, isAddress } from 'viem'

/**
 * ============ SUPURUCUNUN KALICI DURUMU: IMLEC + ADAY KUMESI ============
 *
 * IKISI BIRLIKTE TEK BIR DOSYADA, ve bu bir kolaylik degil bir DOGRULUK
 * kararidir: ayri dosyalar olsaydi imlec ilerleyip kume yazilamadiginda,
 * aradaki tokenlar BIR DAHA HIC kesfedilmezdi -- yeniden taranacak blok
 * araligi zaten "gecildi" sayilirdi. Tek dosya, tek `rename`: ya ikisi de
 * ilerler ya hicbiri.
 *
 * `writeFileSync` + `renameSync`: `rename` ayni dosya sisteminde ATOMIKTIR,
 * dolayisiyla yazma sirasinda olen bir surec YARIM bir dosya birakmaz. Repoda
 * `fileCursorStore` ayni deseni kullanir.
 *
 * ZINCIR PINI DOSYANIN ICINDE. Baska bir hazineye (ya da baska bir zincire)
 * ait bir durum dosyasi SESSIZCE kullanilmaz: uyusmazlikta durum SIFIRLANIR
 * ve cagirana SOYLENIR. Faz 2 redeploy'unda bu beklenen ve kendini iyilestiren
 * bir olaydir, ama "maruziyet neden sifirdan yeniden kuruluyor" sorusunun
 * cevabi bir satir olarak gorunmeli.
 */

export type SweepState = {
  /** Bu bloga KADAR (dahil) tarandi. */
  readonly scannedTo: bigint
  /** Bir kez tahakkuk gormus her token. Kucuk harf. */
  readonly tokens: readonly Address[]
}

export interface SweepStore {
  read(): SweepState
  write(next: SweepState): void
}

type Persisted = {
  chainId?: number
  treasury?: string
  scannedTo?: string
  tokens?: unknown
}

export function fileSweepStore(
  path: string,
  pin: { chainId: number; treasury: Address; startBlock: bigint },
  onReset: (reason: string) => void,
): SweepStore {
  const fresh = (): SweepState => ({ scannedTo: pin.startBlock - 1n, tokens: [] })

  return {
    read(): SweepState {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return fresh()
      }

      let doc: Persisted
      try {
        doc = JSON.parse(raw) as Persisted
      } catch {
        onReset(`${path} is not JSON`)
        return fresh()
      }

      if (doc.chainId !== pin.chainId) {
        onReset(`${path} was written for chain ${String(doc.chainId)}, not ${pin.chainId}`)
        return fresh()
      }
      if (
        typeof doc.treasury !== 'string' ||
        !isAddress(doc.treasury) ||
        getAddress(doc.treasury) !== getAddress(pin.treasury)
      ) {
        onReset(`${path} was written for treasury ${String(doc.treasury)}, not ${pin.treasury}`)
        return fresh()
      }
      if (typeof doc.scannedTo !== 'string') {
        onReset(`${path} has no scannedTo`)
        return fresh()
      }

      const tokens: Address[] = []
      if (Array.isArray(doc.tokens)) {
        for (const t of doc.tokens) {
          if (typeof t === 'string' && isAddress(t)) tokens.push(t.toLowerCase() as Address)
        }
      }
      return { scannedTo: BigInt(doc.scannedTo), tokens }
    },

    write(next: SweepState): void {
      const body: Persisted = {
        chainId: pin.chainId,
        treasury: getAddress(pin.treasury),
        scannedTo: next.scannedTo.toString(),
        tokens: [...next.tokens],
      }
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.tmp`
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    },
  }
}
