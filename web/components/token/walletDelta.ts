import type { TradeRow } from '@/components/read/types'

/**
 * BIR ISLEM SATIRININ CUZDANDAN CIKAN / GIREN TUTARI.
 *
 * `Trade` olayi uc alani AYRI tasir (`quoteAmountWei`, `protocolFeeWei`,
 * `creatorFeeWei`), dolayisiyla iki farkli sayi hesaplanabilir:
 *
 *   - CURVE tutari  -- egrinin defterine giren/cikan
 *   - CUZDAN tutari -- kullanicinin fiilen odedigi/aldigi
 *
 * Ekranda dogru olan IKINCISIDIR. Ucret curve'un DISINDA alinir: alimda curve
 * maliyetinin USTUNE eklenir, satimda curve ciktisindan DUSULUR. Yani curve
 * tutarini gostermek, kullaniciya banka ekstresiyle uyusmayan bir rakam
 * vermek olur.
 *
 * TEK FORMUL, IKI EKRAN: Task 12'nin islem onayi da bunu cagirir. Iki yerde
 * iki formul olsaydi, kullanicinin imzalamadan once gordugu tutar ile
 * sonradan gecmiste gordugu tutar ayrisirdi.
 *
 * `creatorFeeWei` SIFIR OLABILIR ve bu mesrudur: `creator == address(0)`
 * ise creator payi hic alinmaz ve protokol payina KATLANMAZ -- islem 30 bps
 * daha ucuzdur. Toplama zaten bunu dogru tasir.
 */
export function walletDeltaWei(row: TradeRow): bigint | null {
  // `listTrades` ucret kolonlarini HENUZ SECMIYOR. Onlarsiz cuzdan tutari
  // hesaplanamaz -- ve `quoteAmountWei`'ye dusmek CURVE tutarini "cuzdandan
  // cikan" diye etiketlemek olurdu: eksik bir sayi degil, YANLIS bir sayi.
  const { protocolFeeWei, creatorFeeWei } = row
  if (protocolFeeWei === undefined || creatorFeeWei === undefined) return null
  const fees = protocolFeeWei + creatorFeeWei
  return row.isBuy ? row.quoteAmountWei + fees : row.quoteAmountWei - fees
}

/**
 * Ayni satirin ucret dokumu -- tooltip icin.
 *
 * Oran DEGIL mutlak degerler donuyor. Olculdu (K2): 1,000000 USDC butceli bir
 * `buyExactQuoteIn`'de toplam ucret butcenin %1,2345679'u, %1,25'i degil --
 * cunku %1,25 CURVE tutarinin uzerinedir, butcenin degil. "Fee 1.25%" yazan
 * bir satirin yanina mutlak sayiyi koymak aritmetigi tutarsiz gosterir.
 */
export function feeBreakdown(row: TradeRow): {
  readonly curveWei: bigint
  readonly protocolWei: bigint
  readonly creatorWei: bigint
  readonly totalFeeWei: bigint
} | null {
  const { protocolFeeWei, creatorFeeWei } = row
  if (protocolFeeWei === undefined || creatorFeeWei === undefined) return null
  return {
    curveWei: row.quoteAmountWei,
    protocolWei: protocolFeeWei,
    creatorWei: creatorFeeWei,
    totalFeeWei: protocolFeeWei + creatorFeeWei,
  }
}

/** Toplam arz. K3: `N = 1_000_000_000e18 = 1e27`, sabittir ve turetilmez. */
export const TOTAL_SUPPLY_TOK = 10n ** 27n

/**
 * Bir holder'in arzdaki payi, iki ondalikla, YUZDE olarak.
 *
 * Tamamen bigint: `Number(balance) / Number(1e27)` ifadesi IEEE-754'te
 * anlamli basamaklarin cogunu atar ve iki farkli holder ayni yuzdeyi
 * gosterebilir.
 */
export function supplyPercent(balanceTok: bigint): string {
  const basisPoints = (balanceTok * 10_000n) / TOTAL_SUPPLY_TOK
  const whole = basisPoints / 100n
  const fraction = basisPoints % 100n
  return `${whole}.${fraction.toString().padStart(2, '0')}`
}
