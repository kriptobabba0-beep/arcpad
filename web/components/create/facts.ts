import {
  type CurveProfile,
  graduationRaise,
  marketCap,
  poolSeedSupply,
} from '@arcpad/shared/browser'

/**
 * ONIZLEME KARTININ SEKIZ SATIRI, UCU DE ZINCIR KAYNAKLI UCLUDEN TURETILIR.
 *
 * Girdi `CurveProfile` (T, V, S) ve o uclu `web/lib/profile.ts` tarafindan
 * FACTORY'DEN okunur -- env'den ya da bir sabitten degil. Sebep olculdu:
 * testnet ile uretim profilleri TEK bir alanda, `V`'de ve tam 1000 kat
 * ayrisir; kopyalanmis bayat bir `V` her market cap'i 1000 kat kaydirir ve
 * BASKA HICBIR SEY fark etmez -- rezervler yine dengelenir, toplamlar yine
 * tutar.
 *
 * `N` (toplam arz) turetilmez: `LaunchToken.TOTAL_SUPPLY` bir dosya duzeyi
 * `constant`tir (`contracts/src/LaunchToken.sol:18`, `1_000_000_000e18`) ve
 * her launch icin aynidir.
 */
export const TOTAL_SUPPLY_TOK = 10n ** 27n

/**
 * ISLEM UCRETLERI, PINLENMIS.
 *
 * `BondingCurve.PROTOCOL_FEE_BPS = 95` ve `CREATOR_FEE_BPS = 30`
 * (`contracts/src/BondingCurve.sol:116,120`) `constant`tir: ne immutable ne
 * ayarlanabilir, yani deploy edilmis her curve'de aynidir ve bir curve
 * adresine sormak icin bir `eth_call` harcamak ayni sayiyi ikinci kez
 * ogrenmek olurdu. Task 5'in harness'i bu ikisini CANLI curve'den okuyup
 * buradaki degerlerle karsilastirir; ayrisma orada gorunur.
 *
 * TODO(faz-2): `FeeSchedule.tierFor` (contracts/src/FeeSchedule.sol) market
 * cap kademelerine gore 95/30'u degistiriyor -- kademe 0 (< 59.000 USDC)
 * 95/30, ustu 25/95..5. Her launch 4,00 USDC market cap ile ACILIR, yani
 * kademe 0 launch aninda dogrudur; FeeSchedule deploy edildiginde bu satir
 * "acilis ucreti" olarak nitelenmelidir.
 */
export const PROTOCOL_FEE_BPS = 95n
export const CREATOR_FEE_BPS = 30n

export type LaunchFacts = {
  readonly totalSupplyTok: bigint
  readonly saleSupplyTok: bigint
  readonly poolSeedTok: bigint
  /** `N - S - D`. Curve'de KALAN ve hicbir yere gitmeyen artik. */
  readonly strandedTok: bigint
  readonly graduationRaiseWei: bigint
  readonly openingMarketCapWei: bigint
  readonly protocolFeeBps: bigint
  readonly creatorFeeBps: bigint
  /**
   * Has governance armed `LaunchFactory.graduationTarget`?
   *
   * DERIVED FROM THE CHAIN, NOT DECLARED. Every other field here comes from
   * the curve profile and cannot change; this one is governance state. It is
   * on `LaunchFacts` so it shares their fate: when the factory cannot be read
   * the whole object is `null` and the card prints "—" rather than a claim
   * about liquidity that nothing verified.
   */
  readonly graduationArmed: boolean
}

/** The zero address — `graduationTarget` before governance arms it. */
const UNSET_TARGET = '0x0000000000000000000000000000000000000000'

export function launchFactsFrom(profile: CurveProfile, graduationTarget: string): LaunchFacts {
  const { virtualTokenReserves: t, virtualQuoteReserves: v, saleSupply: s } = profile
  const poolSeedTok = poolSeedSupply(s, t)
  return {
    totalSupplyTok: TOTAL_SUPPLY_TOK,
    saleSupplyTok: s,
    poolSeedTok,
    // Toplamin %100'u tutmak ZORUNDA. Tutmuyorsa sebebi yazili olmali:
    // `N - S - D` curve'de kalir ve hicbir yere gitmez (spec §5.2'nin kalici
    // artigi). Testnet profilinde bu 13.988,816402609506057782 token'dir.
    strandedTok: TOTAL_SUPPLY_TOK - s - poolSeedTok,
    graduationRaiseWei: graduationRaise(s, v, t),
    openingMarketCapWei: marketCap(v, t, TOTAL_SUPPLY_TOK),
    protocolFeeBps: PROTOCOL_FEE_BPS,
    creatorFeeBps: CREATOR_FEE_BPS,
    // Case-insensitive: the chain answers checksummed, and a `!==` against a
    // lowercase literal would report every unset factory as armed.
    graduationArmed: graduationTarget.toLowerCase() !== UNSET_TARGET,
  }
}

const TOK_SCALE = 10n ** 18n

function group(whole: bigint): string {
  // `toLocaleString` bir bigint uzerinde tam sayidir -- IEEE-754'e hic
  // ugramaz. Locale ACIKCA verilir (CONTRIBUTING.md + eslint kurali).
  return whole.toLocaleString('en-US')
}

function withFraction(tok: bigint, decimals: number): string {
  const whole = tok / TOK_SCALE
  const fraction = (tok % TOK_SCALE)
    .toString()
    .padStart(18, '0')
    .slice(0, decimals)
    .replace(/0+$/, '')
  return fraction === '' ? group(whole) : `${group(whole)}.${fraction}`
}

/**
 * Kart satirlarinin token bicimi: gruplu, en fazla ALTI ondalik, sondaki
 * sifirlar atilmis. `1,000,000,000` · `793,100,000` · `206,886,011.183597`.
 *
 * Alti, cunku ayni fonun ERC-20 gorunumu alti ondaliklidir ve yedinci ondalik
 * YALNIZCA native gorunumde vardir (`packages/shared/src/usdc.ts`). Bir
 * kolonda yedi basamak gostermek, cuzdanin ve gezginin katilmadigi bir rakam
 * yazmak olur.
 */
export function formatTok(tok: bigint): string {
  return withFraction(tok, 6)
}

/**
 * TAM deger, 18 ondalik: `13988816402609506057782n` ->
 * `13,988.816402609506057782`.
 *
 * Yalnizca "geri kalani nereye gitti" satiri icin. Bir launchpad'de arzin
 * nereye gittigi TOPLAMDA `N` etmek zorundadir; kirpilmis uc sayi etmez
 * (13.988,816402 + 206.886.011,183597 + 793.100.000 < N) ve kart kendi
 * iddiasini curuturdu. Artigin kendisi kirpilmadan yazilinca toplam kapanir.
 */
export function formatTokExact(tok: bigint): string {
  return withFraction(tok, 18)
}

/**
 * Arzdaki pay, iki ondalikla ve EN YAKINA yuvarlanarak.
 *
 * Asagi yuvarlamak havuz payini %20,68 gosterirdi; gercek deger
 * %20,6886011...'dir ve bu bir bakiye degil SABIT bir orandir -- yani "var
 * olmayan parayi gosterme" kurali burada gecerli degil, en yakin okuma dogru
 * olan. Tam deger zaten ayni satirda, token cinsinden duruyor.
 */
export function supplySharePercent(part: bigint, total: bigint): string {
  const hundredths = (part * 20_000n + total) / (total * 2n)
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`
}

/** `95n` -> `0.95`. Bps'i yuzdeye cevirmek iki ondalik demektir, daha az degil. */
export function bpsPercent(bps: bigint): string {
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, '0')}`
}
