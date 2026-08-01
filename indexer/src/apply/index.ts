import type { Deployment, Queryable } from '@arcpad/db'
import { admit } from '../admit'
import type { DecodedEvent } from '../logs'
import { applyClaimedEvent, applyDepositedEvent } from './fees'
import { applyCompletedEvent, applyTradeEvent } from './trade'
import { applyTransferEvent } from './transfer'

/**
 * COZULMUS OLAY -> YAZIM. Tek giris noktasi.
 *
 * `switch` TUKETICIDIR (`never` dali): `DecodedEvent`e yeni bir tur eklendigi
 * gun burasi DERLENMEZ. Bir olay turunu "sessizce atlamak" bu yuzden yazilamaz
 * hale gelir -- ve sessizce atlanan bir olay, eksik veriyi hicbir yerde
 * gostermeyen tam olarak o ariza sinifidir.
 */
export async function applyDecodedEvent(
  db: Queryable,
  deployment: Deployment,
  event: DecodedEvent,
): Promise<number> {
  switch (event.kind) {
    case 'launched':
      return admit(db, deployment, event)
    case 'trade':
      return applyTradeEvent(db, deployment, event)
    case 'completed':
      return applyCompletedEvent(db, event)
    case 'transfer':
      return applyTransferEvent(db, event)
    case 'deposited':
      return applyDepositedEvent(db, event)
    case 'claimed':
      return applyClaimedEvent(db, event)
    default: {
      const exhaustive: never = event
      throw new Error(`applyDecodedEvent: bilinmeyen olay ${JSON.stringify(exhaustive)}`)
    }
  }
}

export interface ApplyCounts {
  launches: number
  trades: number
  completed: number
  transfers: number
  fees: number
  total: number
}

/**
 * Bir araligin olaylarini uygular. IKI FAZLIDIR, ve bu FAZ 1.5'in ta
 * kendisidir -- cekme katmanindaki ile ayni sebep, yazma tarafinda.
 *
 * OLCULDU, TAHMIN EDILMEDI: `launch()` mint `Transfer`'ini `Launched`'DAN
 * ONCE yayar. `contracts/fixtures/launch.json`'da `Transfer` logIndex 0,
 * `Launched` logIndex 1; canli Arc makbuzunda da ayni (smoke-receipts.json,
 * launch tx 0x1b5ad264...). Yani KATI `event_seq` sirasiyla uygulayan bir
 * dongu, ilk launch'ta mint `Transfer`'ini `launches` satiri HENUZ YOKKEN
 * yazmaya calisir ve `token_transfers_token_fkey` ile patlar. Bu bir olasilik
 * degil, bu testlerin ilk kosusunda GERCEKLESEN sey:
 *
 *   insert or update on table "token_transfers" violates foreign key
 *   constraint "token_transfers_token_fkey"
 *
 * Cozum, sirayi BOZMAK degil, iki fazda uygulamaktir:
 *   FAZ 1  butun `Launched`lar, `event_seq` sirasinda.
 *   FAZ 2  geri kalan her sey, `event_seq` sirasinda.
 *
 * FAZ 2'NIN ICINDEKI SIRA HALA KATIDIR ve olmak zorundadir: `holders`
 * deltalari siraya bagimlidir. Fazlarin ayrilmasi guvenlidir cunku bir
 * launch'in `created_seq`'i, ayni curve'e ait HER olaydan kucuktur -- curve o
 * islemde YARATILIR. `curve_state`'in `event_seq > last_seq` muhafizi bu
 * yuzden ihlal edilmez.
 */
export async function applyEvents(
  db: Queryable,
  deployment: Deployment,
  events: readonly DecodedEvent[],
): Promise<ApplyCounts> {
  const counts: ApplyCounts = {
    launches: 0,
    trades: 0,
    completed: 0,
    transfers: 0,
    fees: 0,
    total: 0,
  }
  const ordered = [...events].sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1))
  const launches = ordered.filter((e) => e.kind === 'launched')
  const rest = ordered.filter((e) => e.kind !== 'launched')

  for (const event of [...launches, ...rest]) {
    const n = await applyDecodedEvent(db, deployment, event)
    if (event.kind === 'launched') counts.launches += n
    else if (event.kind === 'trade') counts.trades += n
    else if (event.kind === 'completed') counts.completed += n
    else if (event.kind === 'transfer') counts.transfers += n
    else counts.fees += n
    counts.total += n
  }
  return counts
}

export { applyClaimedEvent, applyDepositedEvent } from './fees'
export {
  applyCompletedEvent,
  applyTradeEvent,
  tokenOfCurve,
  UnknownCurve,
  writeMarketCap,
} from './trade'
export { applyTransferEvent } from './transfer'
