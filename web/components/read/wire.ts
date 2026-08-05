import type { TokenOverview } from './types'

/**
 * HTTP SINIRI: JSON'DA `bigint` DE `Date` DE YOKTUR.
 *
 * ⌘K arama sonuclari bir route handler'dan geciyor, yani tek yol JSON.
 * `Response.json()` bir `bigint` gorunce `TypeError: Do not know how to
 * serialize a BigInt` ATAR -- bu bir bicimlendirme tercihi degil, calisma
 * zamaninda 500 veren bir hata. (Faz 3'un satirlari `numeric(78,0)` tasidigi
 * icin `Number`'a cevirmek de secenek DEGIL: 78 basamak IEEE-754'e sigmaz ve
 * sessizce yuvarlanir.)
 *
 * Bu yuzden tel bicimi ACIKCA tanimli: her `bigint` ondalik bir DIZE, her
 * `Date` bir ISO dizesi. Donusum iki yonlu ve alan listeleri `keyof
 * TokenOverview` ile tipli -- yeni bir alan eklenip listeye yazilmadiginda
 * `fromWire` onu ham dize olarak birakir, ve asagidaki butunluk iddiasi
 * derlemede kirilir.
 */

/** Tel uzerindeki sekil: bigint -> string, Date -> string. */
export type WireTokenOverview = {
  [K in keyof TokenOverview]: TokenOverview[K] extends bigint
    ? string
    : TokenOverview[K] extends bigint | null
      ? string | null
      : TokenOverview[K] extends Date
        ? string
        : TokenOverview[K] extends Date | null
          ? string | null
          : TokenOverview[K]
}

const BIGINT_FIELDS = [
  'virtualTokenReservesTok',
  'virtualQuoteReservesWei',
  'realTokenReservesTok',
  'realQuoteReservesWei',
  'completedSeq',
  'poolSeedSupplyTok',
  // TERMINAL DURUMUN SAYILARI. `graduated` bir `boolean` oldugu icin bu
  // listede YOKTUR ve olmamali -- JSON `boolean` tasir; `bigint` tasimaz.
  'graduatedSeq',
  'graduationBaseTok',
  'graduationQuoteWei',
  'marketCapWei',
  'priceWeiPerTok',
  'graduationRaiseWei',
  'volumeTotalWei',
  'volume24hWei',
  'athMarketCapWei',
  'lastTradeSeq',
  'lastBuySeq',
  'createdSeq',
] as const satisfies readonly (keyof TokenOverview)[]

const DATE_FIELDS = [
  'lastTradeAt',
  'lastBuyAt',
  'createdAt',
] as const satisfies readonly (keyof TokenOverview)[]

/**
 * BUTUNLUK IDDIASI, DERLEME ZAMANINDA.
 *
 * `TokenOverview`'a yeni bir `bigint` alan eklenip yukaridaki listeye
 * yazilmazsa bu satir derlenmez: alan `never`e dusmez ve atama basarisiz olur.
 * Aksi hâlde eksik alan tel uzerinde dize olarak kalir ve istemcide sessizce
 * `"12161433369060378706" * 2n` gibi bir hataya doner.
 */
type BigintKeys = {
  [K in keyof TokenOverview]-?: bigint extends TokenOverview[K] ? K : never
}[keyof TokenOverview]
type DateKeys = {
  [K in keyof TokenOverview]-?: Date extends TokenOverview[K] ? K : never
}[keyof TokenOverview]

const _allBigintsListed: Exclude<BigintKeys, (typeof BIGINT_FIELDS)[number]> extends never
  ? true
  : never = true
const _allDatesListed: Exclude<DateKeys, (typeof DATE_FIELDS)[number]> extends never
  ? true
  : never = true
void _allBigintsListed
void _allDatesListed

export function toWire(row: TokenOverview): WireTokenOverview {
  const out: Record<string, unknown> = { ...row }
  for (const key of BIGINT_FIELDS) {
    const value = row[key]
    out[key] = value === null ? null : String(value)
  }
  for (const key of DATE_FIELDS) {
    const value = row[key]
    out[key] = value === null ? null : value.toISOString()
  }
  return out as unknown as WireTokenOverview
}

export function fromWire(row: WireTokenOverview): TokenOverview {
  const out: Record<string, unknown> = { ...row }
  for (const key of BIGINT_FIELDS) {
    const value = row[key]
    out[key] = value === null ? null : BigInt(value)
  }
  for (const key of DATE_FIELDS) {
    const value = row[key]
    out[key] = value === null ? null : new Date(value)
  }
  return out as unknown as TokenOverview
}
