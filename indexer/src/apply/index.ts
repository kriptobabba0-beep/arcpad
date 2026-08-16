import type { Deployment, Pool, Queryable } from '@arcpad/db'
import { withTransaction } from '@arcpad/db'
import { admit } from '../admit'
import type { DecodedEvent } from '../logs'
import {
  applyBuybackAccruedEvent,
  applyBuybackExecutedEvent,
  applyBuybackLockedEvent,
  applyBuybackSkippedEvent,
  applyVestingReleasedEvent,
} from './buyback'
import { applyClaimedEvent, applyDepositedEvent } from './fees'
import { applyPoolSwapEvent } from './pool'
import { applyCompletedEvent, applyGraduatedEvent, applyTradeEvent } from './trade'
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
    case 'graduated':
      return applyGraduatedEvent(db, event)
    case 'transfer':
      return applyTransferEvent(db, event)
    case 'deposited':
      return applyDepositedEvent(db, event)
    case 'claimed':
      return applyClaimedEvent(db, event)
    case 'poolSwap':
      return applyPoolSwapEvent(db, deployment, event)
    // IKISI DE DEFTERSIZDIR VE SIFIR DONER -- bkz. `apply/pool.ts`,
    // `POOL_EVENTS_WITHOUT_LEDGER`. `Completed`/`Graduated` gibi bir durum
    // gecisi de DEGILLER: biri bir dogrulama (cekme katmaninda biter), oteki
    // bir ucretin `trades` satirina baglanmasi (o da orada biter). Burada
    // `return 0` yazmak, `switch`in tuketiciligini korurken "bu olayin
    // yazacagi bir sey yok" kararini GORUNUR kilar; `default`a dusurmek onu
    // gizlerdi.
    case 'poolInitialize':
    case 'poolFee':
      return 0
    /*
     * BUYBACK NESLI -- BESI DE `buyback_events`E YAZAR.
     *
     * Bes ayri dal, tek tablo: ture ozgu esleme `apply/buyback.ts`te, "hangi
     * kolon hangi turde dolu olmak zorunda" ise semadaki `*_iff_*`
     * kisitlarinda. Ayni bilginin iki yerde durmasi kasitlidir -- biri
     * cagrilmadan, oteki YAZILAMADAN gecemez.
     */
    case 'buybackAccrued':
      return applyBuybackAccruedEvent(db, event)
    case 'buybackExecuted':
      return applyBuybackExecutedEvent(db, event)
    case 'buybackSkipped':
      return applyBuybackSkippedEvent(db, event)
    case 'buybackLocked':
      return applyBuybackLockedEvent(db, event)
    case 'vestingReleased':
      return applyVestingReleasedEvent(db, event)
    default: {
      const exhaustive: never = event
      throw new Error(`applyDecodedEvent: bilinmeyen olay ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * `counts.buyback`a dusen olay turleri. Bir KUME, cunku `applyEvents`in sayac
 * zinciri `else if` merdivenidir ve bes turu tek tek yazmak, bir turu unutmayi
 * -- yani onu sessizce `fees`e dusurmeyi -- mumkun birakirdi.
 */
const BUYBACK_KINDS: ReadonlySet<DecodedEvent['kind']> = new Set([
  'buybackAccrued',
  'buybackExecuted',
  'buybackSkipped',
  'buybackLocked',
  'vestingReleased',
] as const)

export interface ApplyCounts {
  launches: number
  trades: number
  /**
   * `source = 'pool'` ile giren satirlar. `trades`TEN AYRI SAYILIR.
   *
   * Ayni tabloya yazarlar ve okuma tarafinda TEK BIR gecmis olustururlar --
   * bu tam olarak istenen sey. Ama OPERATORUN gordugu satirda ayrilmalari
   * gerekir: bugun beklenen deger SIFIRDIR (hicbir token mezun olmadi), yani
   * birlestirilmis bir sayac ilk havuz isleminin geldigi ani da, hic
   * gelmedigi gercegini de gizlerdi.
   */
  poolSwaps: number
  completed: number
  /** `Graduated`. `completed`TEN AYRI SAYILIR -- ayri bir olgudur. */
  graduated: number
  transfers: number
  fees: number
  /**
   * `buyback_events`e giren satirlar -- BES TURUN TOPLAMI, ve `fees`TEN AYRI.
   *
   * Ayrilmasinin gerekcesi `poolSwaps`inkiyle birebir ayni: bugun beklenen
   * deger tokenlerin cogunda SIFIRDIR (buyback varsayilan olarak KAPALIDIR ve
   * yalnizca creator acabilir), yani `fees`e katilmis bir sayac ilk buyback'in
   * geldigi ani da, hic gelmedigi gercegini de gizlerdi.
   */
  buyback: number
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
    poolSwaps: 0,
    completed: 0,
    graduated: 0,
    transfers: 0,
    fees: 0,
    buyback: 0,
    total: 0,
  }
  const ordered = [...events].sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1))
  const launches = ordered.filter((e) => e.kind === 'launched')
  const rest = ordered.filter((e) => e.kind !== 'launched')

  for (const event of [...launches, ...rest]) {
    const n = await applyDecodedEvent(db, deployment, event)
    if (event.kind === 'launched') counts.launches += n
    else if (event.kind === 'trade') counts.trades += n
    else if (event.kind === 'poolSwap') counts.poolSwaps += n
    else if (event.kind === 'completed') counts.completed += n
    else if (event.kind === 'graduated') counts.graduated += n
    else if (event.kind === 'transfer') counts.transfers += n
    else if (BUYBACK_KINDS.has(event.kind)) counts.buyback += n
    // `poolInitialize` ve `poolFee` HER ZAMAN 0 doner (bkz. yukarisi), yani
    // hangi sayaca dustukleri gozlemlenemez. `fees`e birakiliyor cunku
    // `poolFee` gercekten bir ucret olgusudur ve sifir eklemek bir sey
    // bozmaz; `poolInitialize` icin de aynisi gecerli.
    else counts.fees += n
    counts.total += n
  }
  return counts
}

/**
 * BIR ARALIGI TEK BIR ISLEMDE uygular. TASK 11'IN DONGUSU BUNU CAGIRMALI.
 *
 * NEDEN AYRI BIR GIRIS NOKTASI VAR -- OLCULDU, tahmin edilmedi:
 *
 * `applyTransfer` ve `applyFeeEvent` IKI ifadedir (defter INSERT'i + artimli
 * UPDATE) ve boyle olmak ZORUNDADIR: Postgres CHECK kisitlarini `ON CONFLICT
 * DO UPDATE`'in ONERILEN satirinda degerlendirir, yani negatif bir delta
 * catisma cozulmeden patlar. Sonucu sudur: bir islem DISINDA cagrildiklarinda
 * her ifade kendi islemidir ve ikinci ifade patlarsa BIRINCI ISLENMIS OLARAK
 * KALIR. O andan sonra defter satiri "bu olay zaten uygulandi" der ve delta
 * BIR DAHA HIC uygulanmaz -- sessiz, kalici bir muhasebe hatasi.
 *
 * Bu bir varsayim degil: `apply-fees.test.ts`'in ilk kosusunda gerceklesti
 * (basarisiz bir `Claimed`den sonra ayni olay bir daha yazilamadi) ve
 * "islemsiz bir cagri, basarisiz bir yazimdan sonra defteri kilitler" testi
 * onu kalici olarak olcuyor.
 *
 * `Queryable` alan `applyEvents` YERINDE DURUYOR cunku islemin ICINDEN
 * cagrilmasi gereken yer odur; bu sarmalayici, "islem acmayi unutmak" halini
 * bir SECIM olmaktan cikarir.
 */
export async function applyRange(
  pool: Pool,
  deployment: Deployment,
  events: readonly DecodedEvent[],
): Promise<ApplyCounts> {
  return withTransaction(pool, async (tx) => applyEvents(tx, deployment, events))
}

export {
  applyBuybackAccruedEvent,
  applyBuybackExecutedEvent,
  applyBuybackLockedEvent,
  applyBuybackSkippedEvent,
  applyVestingReleasedEvent,
  UnknownBuybackToken,
} from './buyback'
export { applyClaimedEvent, applyDepositedEvent } from './fees'
export {
  applyPoolSwapEvent,
  DegeneratePoolSwap,
  POOL_EVENTS_WITHOUT_LEDGER,
  UnknownPool,
} from './pool'
export {
  applyCompletedEvent,
  applyGraduatedEvent,
  applyTradeEvent,
  CurveTokenMismatch,
  tokenOfCurve,
  UnknownCurve,
  writeMarketCap,
} from './trade'
export { applyTransferEvent } from './transfer'
