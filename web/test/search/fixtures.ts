import type { HexAddress, TokenOverview } from '@/components/read/types'

/**
 * ⌘K TESTLERININ ORTAK FIXTURE'I.
 *
 * `TokenOverview` otuz alan tasiyor ve her testte elle yazilmasi, alan listesi
 * degistiginde otuz ayri yerde derleme hatasi demek olurdu.
 *
 * TIPLER FAZ 3'UN TIPLERIDIR: `bigint` ve `Date`. Daha once burada dize
 * yaziyordu ve o SEKIL YANLISTI -- `packages/db`'nin `toOverview`'u satiri
 * zaten donusturuyor, yani dizelerle yazilmis bir fixture hicbir zaman
 * olmayacak bir donusum adimini test ediyordu.
 *
 * `name_hex`/`symbol_hex`/`uri_hex`/`salt` ARTIK YOK: `token_overview` view'i
 * o sutunlari disari vermiyor, dolayisiyla kanoniklik istemcide ham baytlardan
 * yeniden turetilemez ve tek yol zincirdeki `isCanonical`'dir.
 */
export function overview(patch: Partial<TokenOverview> = {}): TokenOverview {
  return {
    token: '0x1111111111111111111111111111111111111111',
    curve: '0x2222222222222222222222222222222222222222',
    name: 'Doge Arc',
    symbol: 'DOGEARC',
    uri: 'ipfs://bafyexample/metadata.json',
    launchCreator: '0x3333333333333333333333333333333333333333',
    feeCreator: '0x3333333333333333333333333333333333333333',
    virtualTokenReservesTok: 1_073_000_000_000_000_000_000_000_000n,
    virtualQuoteReservesWei: 6_500_000_000_000_000_000n,
    realTokenReservesTok: 793_100_000_000_000_000_000_000_000n,
    realQuoteReservesWei: 500_000_000_000_000_000n,
    complete: false,
    completedSeq: null,
    poolSeedSupplyTok: null,
    // MEZUN DEGIL. `complete: false` bunu ZATEN ima eder (zincirde
    // `graduated => complete`), ama okuma modeli o cikarimi YAPMAZ ve
    // yapmamalidir: iki ayri olgu, iki ayri alan.
    graduated: false,
    graduatedSeq: null,
    // AYNI SINIF: buyback da AYRI bir olgudur ve baska hicbir alandan
    // cikarilmaz -- ozelligi acmis ama henuz islem gormemis bir tokenin butun
    // toplamlari sifirdir.
    buybackEnabled: false,
    buybackLockedTok: 0n,
    graduationTargetAddr: null,
    graduationBaseTok: null,
    graduationQuoteWei: null,
    marketCapWei: 6_052_733_351_875_009_052n,
    priceWeiPerTok: 6_052_733_351n,
    progressPpm: 253_087,
    graduationRaiseWei: 12_161_433_369_060_378_706n,
    holderCount: 12,
    volumeTotalWei: 900_000_000_000_000_000n,
    volume24hWei: 400_000_000_000_000_000n,
    athMarketCapWei: 7_052_733_351_875_009_052n,
    tradeCount: 4,
    buyCount: 3,
    lastTradeSeq: 42n,
    lastBuySeq: 41n,
    lastTradeAt: new Date('2026-07-30T10:00:00.000Z'),
    lastBuyAt: new Date('2026-07-30T09:59:00.000Z'),
    createdSeq: 7n,
    createdAt: new Date('2026-07-29T08:00:00.000Z'),
    ...patch,
  }
}

/** Sekli gecerli, defterde olmayan bir adres. Buyuk harfli: normalizasyon olculur. */
export const PASTED = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'
export const PASTED_LOWER = PASTED.toLowerCase() as HexAddress
