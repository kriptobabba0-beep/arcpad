import {
  type CurveProfile,
  type CurveState,
  type FeeBps,
  formatTokenAmount,
  parseUsdcAmount,
  type ProfileName,
  planBuyExactQuoteIn,
  planBuyExactTokensOut,
  planSellExactTokensIn,
  resolveSellForNet,
  type TradeAction,
  type TradePlan,
  TradePlanError,
  type TradePlanErrorName,
  USDC_VIEW_SCALE,
} from '@arcpad/shared/browser'
import type { ArcpadFailure } from '@/lib/decodeRevert'
import { chipFits } from './gas'

/**
 * PANELIN BUTUN KARARLARI, REACT'TAN AYRI.
 *
 * Burada tek bir egri aritmetigi YOK. Uc planlayici `@arcpad/shared/browser`'da
 * duruyor ve ~189.000 diferansiyel vakada zincirle sifir uyusmazlik verdi; bu
 * dosya onlarin dondurdugu sayilari TASIR, yeniden turetmez. Ozellikle UCRET:
 * zincir ucreti DUZELTME ONCESI net uzerinden alir ve 3. adimdan sonra yeniden
 * hesaplamaz, dolayisiyla ekranda gosterilen ucret `plan.protocolFee` ve
 * `plan.creatorFee`'dir -- bir yuzdenin girdiye uygulanmasiyla uretilen sayi
 * DEGILDIR ve o mutant burada olur.
 *
 * Ayri dosya olmasinin sebebi olculmus: bir buton metnini React agacini
 * cizerek test etmek, o metni ureten SIRAYI degil o siranin BIR yolunu test
 * eder. Sira bir tablo testiyle bastan sona yurunebilsin diye saf bir
 * fonksiyon.
 */

// --------------------------------------------------------------------------
// Sekmeler ve giris noktalari
// --------------------------------------------------------------------------

export type TradeTab = 'spend' | 'receive' | 'sell'

export const TRADE_TABS: readonly TradeTab[] = ['spend', 'receive', 'sell']

/**
 * SEKME -> GIRIS NOKTASI. Uc sekme, uc AYRI giris noktasi.
 *
 * `spend` VARSAYILANDIR ve gerekcesi tek cumle: rezervin tepesinde butce
 * KISILIR ve artan iade edilir, yani bayat bir kotadan dolayi basarisiz
 * OLAMAZ. `receive` ayni yerde `NotEnoughTokensToBuy()` ile revert eder.
 * Ikisini simetrik sunmak, farkli iki sinir davranisini ayni gorunmez kilar.
 */
export const TAB_ACTION: Readonly<Record<TradeTab, TradeAction>> = {
  spend: 'buyExactQuoteIn',
  receive: 'buyExactTokensOut',
  sell: 'sellExactTokensIn',
}

export const DEFAULT_TAB: TradeTab = 'spend'

export const TAB_LABEL: Readonly<Record<TradeTab, string>> = {
  spend: 'Buy · Spend USDC',
  receive: 'Buy · Receive tokens',
  sell: 'Sell',
}

/**
 * SINIR ETIKETI SEKMEYE BAGLIDIR, `boundKind`'a DEGIL.
 *
 * Iki alim da `boundKind: 'maxSpendIncludingFees'` tasir ama korudugu sey ayni
 * degil: `buyExactQuoteIn`'in argumani `minTokensOut`, `buyExactTokensOut`'un
 * ikinci argumani `maxQuoteIn`. Etiketi `boundKind`'dan turetmek ikisine ayni
 * cumleyi yazdirirdi ve kullanici korunan miktarin hangisi oldugunu bilemezdi.
 */
export const BOUND_LABEL: Readonly<Record<TradeAction, string>> = {
  buyExactQuoteIn: 'Minimum tokens you receive',
  buyExactTokensOut: 'Maximum you spend, fees included',
  sellExactTokensIn: 'Minimum you receive, after fees',
}

export const isBuyTab = (tab: TradeTab): boolean => tab !== 'sell'

// --------------------------------------------------------------------------
// Girdi
// --------------------------------------------------------------------------

/**
 * TOKEN GIRDISI DE `parseUsdcAmount`'TAN GECER, ve bu bir kisayol degil.
 *
 * Iki gorunum de 1e18 olceklidir ve ekranda ALTI ondalikla yazilir
 * (`formatTokenAmount`). Token icin ayri bir ayristirici yazmak, ayni
 * kuantalama kuralinin ikinci bir kopyasi olurdu -- ve ikisi ayrildiginda
 * kullanicinin yazdigi sey ile ekrana donen sey ayrisirdi.
 */
export type AmountParse =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: string | null }

const PARSE_MESSAGE: Readonly<Record<string, string>> = {
  empty: '',
  negative: 'An amount cannot be negative.',
  exponent: 'Write the number out in full, for example 1000 rather than 1e3.',
  notANumber: 'Enter a plain number, for example 1.5.',
  tooManyDecimals: 'Six decimals is the finest amount this chain can settle.',
}

export function parseAmount(text: string): AmountParse {
  const parsed = parseUsdcAmount(text)
  if (parsed.ok) return { ok: true, value: parsed.value }
  const message = PARSE_MESSAGE[parsed.reason] ?? 'That is not an amount.'
  return { ok: false, reason: message === '' ? null : message }
}

export type ClampVerdict = {
  readonly value: bigint
  /** Kelepceleme GORUNUR bir satirdir; sessiz bir duzeltme degil. */
  readonly notice: string | null
}

/**
 * `Receive tokens` sekmesinin KELEPCESI.
 *
 * `buyExactTokensOut` rezervin ustunde bir miktar istendiginde
 * `NotEnoughTokensToBuy()` ile revert eder -- kismi doldurmaz. Panel bu yuzden
 * girdiyi `realTokenReserves`'e kelepceler VE bunu yazar. Sessiz bir kelepce,
 * kullanicinin yazdigi sayidan baska bir sey imzalatmak olurdu.
 */
export function clampToReserve(requested: bigint, realTokenReserves: bigint): ClampVerdict {
  if (requested <= realTokenReserves) return { value: requested, notice: null }
  return {
    value: realTokenReserves,
    notice: `Only ${formatTokenAmount(realTokenReserves)} left on the curve.`,
  }
}

// --------------------------------------------------------------------------
// Kota
// --------------------------------------------------------------------------

export type Quote =
  | { readonly ok: true; readonly plan: TradePlan }
  | { readonly ok: false; readonly errorName: TradePlanErrorName }

/**
 * PLANLAYICIYA GECIS, ve baska hicbir sey.
 *
 * `switch` uc dali da ACIKCA yazar; ortak bir "planner" tablosu kurmak, uc
 * giris noktasinin uc AYRI sinir davranisi oldugunu gizler ve bir gun birinin
 * argumani digerine gitmesine izin verirdi.
 *
 * `TAB_ACTION` BIR BELGE DEGIL SOZLESME: asagidaki son kontrol, beyan edilen
 * haritayi fiilen cagrilana bagliyor. Onsuz `TAB_ACTION` olu bir sabit olurdu
 * -- degistirilebilir, testi kirar, ve URUNDE hicbir sey degismezdi. Kontrolun
 * kendisi bir revert'ten cok daha ucuz: yanlis giris noktasina gitmis bir plan
 * cuzdana ULASMADAN once duser.
 */
export function quoteFor(input: {
  readonly tab: TradeTab
  readonly amount: bigint
  readonly state: CurveState
  readonly profile: CurveProfile
  readonly fees: FeeBps
  readonly slipBps: number
}): Quote {
  const { tab, amount, state, profile, fees, slipBps } = input
  try {
    let plan: TradePlan
    switch (tab) {
      case 'spend':
        plan = planBuyExactQuoteIn(state, profile, fees, amount, slipBps)
        break
      case 'receive':
        plan = planBuyExactTokensOut(state, profile, fees, amount, slipBps)
        break
      case 'sell':
        plan = planSellExactTokensIn(state, profile, fees, amount, slipBps)
        break
    }
    if (plan.action !== TAB_ACTION[tab]) {
      throw new Error(
        `tab "${tab}" produced ${plan.action}, but TAB_ACTION declares ${TAB_ACTION[tab]}`,
      )
    }
    return { ok: true, plan }
  } catch (error) {
    if (error instanceof TradePlanError) return { ok: false, errorName: error.errorName }
    throw error
  }
}

export const PLAN_ERROR_TEXT: Readonly<Record<TradePlanErrorName, string>> = {
  CurveComplete: 'This curve has completed; it cannot be traded.',
  ZeroQuoteIn: 'Enter an amount above zero.',
  ZeroTokensOut: 'Enter an amount above zero.',
  ZeroTokensIn: 'Enter an amount above zero.',
  NotEnoughTokensToBuy: 'There are not that many tokens left on the curve.',
  ProceedsTooSmall: 'That is too small to sell: the fees would take all of it.',
  BudgetOverrun: 'The quote came out above your budget. Please report this.',
}

/**
 * `Receive tokens` SEKMESININ MAX'I IKI TAVANLA KELEPCELENIR.
 *
 * Birincisi `realTokenReserves` -- ustunde `NotEnoughTokensToBuy()`.
 * Ikincisi `spendable`'in SLIPAJ PAYI DUSULMUS hâliyle alinabilecek miktar:
 * `buyExactTokensOut` `msg.value = maxQuoteIn = ceil(total × (1 + slip))`
 * gonderir, yani slipaj payini da CUZDANDAN cikarir. Tavani `spendable`
 * uzerinden dogrudan hesaplamak, %1 slipajda bakiyenin %1'i kadar bir islemi
 * kurulamaz yapardi ve MAX her seferinde `Insufficient USDC` gosterirdi.
 *
 * Ikinci tavan PLANLAYICIYLA bulunur, elle bir egri formuluyle degil:
 * slipajsiz bir `buyExactQuoteIn` planinin `tokens`'i, o butcenin gercekten
 * aldigi miktardir -- ve o planlayici rezerv tepesinde zaten kelepceler, yani
 * birinci tavan da ayni cagridan gelir.
 */
export function maxTokensFromSpendable(input: {
  readonly state: CurveState
  readonly profile: CurveProfile
  readonly fees: FeeBps
  readonly spendable: bigint
  readonly slipBps: number
}): bigint {
  const { state, profile, fees, spendable, slipBps } = input
  if (spendable <= 0n) return 0n
  const budget = (spendable * 10_000n) / (10_000n + BigInt(slipBps))
  if (budget <= 0n) return 0n
  const quote = quoteFor({ tab: 'spend', amount: budget, state, profile, fees, slipBps: 0 })
  return quote.ok ? quote.plan.tokens : 0n
}

/**
 * Kisayollarin TABANI, sekmeye gore.
 *
 * Uc sekmenin uc farkli tabani var ve tek bir "bakiye" degeri uzerinden
 * yurumek ikisini birden yanlis yapardi: `sell` sekmesinde harcanan sey USDC
 * degil TOKEN'dir (gaz yine USDC ile odenir ama kisayolun bolduğu sey token
 * bakiyesidir), `receive` sekmesinde ise kullanicinin yazdigi sey token,
 * cuzdandan cikan sey USDC.
 */
export function shortcutBaseFor(input: {
  readonly tab: TradeTab
  readonly spendable: bigint | null
  readonly tokenBalance: bigint | null
  readonly state: CurveState
  readonly profile: CurveProfile
  readonly fees: FeeBps
  readonly slipBps: number
}): bigint | null {
  const { tab, spendable, tokenBalance } = input
  if (tab === 'sell') return tokenBalance
  if (spendable === null) return null
  if (tab === 'spend') return spendable
  return maxTokensFromSpendable({ ...input, spendable })
}

// --------------------------------------------------------------------------
// Mutlak para kisayollari
// --------------------------------------------------------------------------

/**
 * ==========================================================================
 *  THE MONEY CHIPS. ONE LADDER, BOTH SIDES, AND THE PANEL SHOWS ONLY THE
 *  ONES THAT CAN ACTUALLY BE FILLED.
 * ==========================================================================
 *
 * The owner's decision, taken against Uniswap's meme-launch panel: the
 * shortcut is MONEY on both sides, never a fraction. A user picks "$25" and
 * means twenty-five dollars whether they are buying or selling; the panel does
 * the unit conversion, not the user.
 *
 * ------------------------------------------------------------------------
 *  MEASURED, AND THE MEASUREMENT MATTERS MORE THAN THE LADDER
 * ------------------------------------------------------------------------
 *
 * Read against the LIVE open curve `0x53Bba88F…44c9` on 2026-08-10 with the
 * shared port -- the same functions that quote the trade:
 *
 *   BUY   $25  -> clamped, spends 12.163451, refunds 12.836549, COMPLETES the curve
 *         $100 -> clamped, spends 12.163451, refunds 87.836549, COMPLETES the curve
 *         $500 -> clamped, spends 12.163451, refunds 487.836549, COMPLETES the curve
 *   SELL  $25 / $100 / $500 -> UNREACHABLE. Not "the user is short": no token
 *         quantity on this curve, up to the ENTIRE 793.1M sale supply, realises
 *         that much.
 *
 * Both are consequences of the frozen profile, not of this deployment's state:
 *   - a curve absorbs `V*S/(vT0-S) = 12.161433…` USDC IN TOTAL before it
 *     graduates, so every chip at $25 or above buys the whole curve out and
 *     refunds the rest, and all three do the IDENTICAL thing;
 *   - sell proceeds are `x*vQ/(vT+x)`, which approaches `virtualQuoteReserves`
 *     and never reaches it -- 4.44 USDC on this curve now, 16.45 USDC on a
 *     curve loaded all the way to graduation. That is a HARD CEILING on what
 *     any sell can ever return on any arcpad curve.
 *
 * ------------------------------------------------------------------------
 *  SO THE LADDER IS PER PROFILE, LIKE EVERY OTHER FIGURE OF THIS KIND
 * ------------------------------------------------------------------------
 *
 * `$25 / $100 / $500` is not wrong -- it is RIGHT FOR PRODUCTION and
 * unreachable on testnet, in exactly the proportion everything else on this
 * chain is. The two profiles differ in `V` by a factor of 1000, so they differ
 * in every quote-denominated quantity by 1000: `MIN_GRADUATION_RAISE` is
 * `12.161433` on testnet and `12_161.43` on production. A single hardcoded
 * ladder was the same category error as a hardcoded `V`.
 *
 * The key is the PROFILE NAME, and it arrives already identified. `getCurveProfile()`
 * reads the factory's own immutables and hashes them against `PROFILE_DIGESTS`
 * (`web/lib/profile.ts`), which are the same pinned digests
 * `assertBookMatchesProfile` validates the address book's `profile` field
 * against -- so this IS the book's field, reached by the one route that works
 * in a browser. `readProfiles()` cannot be that route: it opens `profiles.toml`
 * with `node:fs`, and this file is imported by a `'use client'` component.
 *
 * ------------------------------------------------------------------------
 *  THE SUPPRESSION IS THE INVARIANT; THE LADDER IS ONLY ITS INPUT
 * ------------------------------------------------------------------------
 *
 * `amountChipsFor` returns only chips it has RESOLVED through the planner for
 * the tab's own entrypoint. That does not become decorative now that the
 * numbers fit the profile -- it is what keeps the PRODUCTION ladder honest
 * against an EARLY production curve, which has barely any depth and cannot
 * absorb $500 until it has filled up. A chip that cannot be filled is not
 * rendered, on either profile, at every point in a curve's life.
 */
export const AMOUNT_CHIPS_BY_PROFILE: Readonly<Record<ProfileName, readonly bigint[]>> = {
  testnet: [1n, 5n, 10n],
  production: [25n, 100n, 500n],
}

const ONE_USDC_WEI = 1_000_000_000_000_000_000n

export type AmountChip = {
  /** Whole USDC. THE LABEL -- `$25`. */
  readonly usdc: bigint
  /** The label as money, in native wei. */
  readonly wei: bigint
  /**
   * WHAT GOES INTO THE FIELD, in the field's own unit: USDC wei on `spend`,
   * token base units on `receive` and `sell`. Resolved through the planner for
   * the tab's own entrypoint -- never converted with a price.
   */
  readonly fill: bigint
}

export type AmountChipInput = {
  readonly tab: TradeTab
  /** Gas-reserve-adjusted USDC. `null` -> no estimate, no chips. */
  readonly spendable: bigint | null
  readonly tokenBalance: bigint | null
  readonly state: CurveState
  readonly profile: CurveProfile
  readonly fees: FeeBps
  /**
   * WHICH LADDER. Identified from the factory's own immutables by
   * `getCurveProfile()`, not guessed from the chain id -- a chain could carry
   * either profile and the digest is what actually settles it.
   */
  readonly profileName: ProfileName
}

/**
 * The chips this tab can actually fill, in ladder order.
 *
 * EVERY CHIP IS RESOLVED, NOT ESTIMATED. A chip survives only if the planner
 * for THIS TAB'S entrypoint returns a plan for it, which is why the three tabs
 * read so differently below -- they are three entrypoints with three boundary
 * behaviours, and this repository has been burned by treating them as one.
 *
 * A CLAMPING BUY IS NOT OFFERED. `buyExactQuoteIn` clamps at the top of the
 * curve and refunds the difference, which is the right CHAIN behaviour and the
 * wrong thing to hide behind a button: a chip that says `$25` and spends
 * `$12.16` -- while completing the curve -- has filled a different amount than
 * it promised. The user can still type it, see the breakdown, and choose it.
 */
export function amountChipsFor(input: AmountChipInput): readonly AmountChip[] {
  const { tab, spendable, tokenBalance, state, profile, fees, profileName } = input
  if (state.complete) return []

  const out: AmountChip[] = []
  for (const usdc of AMOUNT_CHIPS_BY_PROFILE[profileName]) {
    const wei = usdc * ONE_USDC_WEI
    const fill = resolveChip(tab, wei, { spendable, tokenBalance, state, profile, fees })
    if (fill !== null) out.push({ usdc, wei, fill })
  }
  return out
}

function resolveChip(
  tab: TradeTab,
  wei: bigint,
  // `profileName` chose the ladder; it has no say in whether a given amount
  // resolves. Excluding it keeps that boundary visible rather than implied.
  ctx: Omit<AmountChipInput, 'tab' | 'profileName'>,
): bigint | null {
  const { spendable, tokenBalance, state, profile, fees } = ctx

  if (tab === 'sell') {
    // SELL DIRECTION, and it has to be: `resolveSellForNet` searches
    // `planSellExactTokensIn`'s own output. Resolving this with buy-side
    // arithmetic gives a number of the right magnitude and the wrong value.
    if (tokenBalance === null || tokenBalance <= 0n) return null
    // THE FIELD'S QUANTUM IS PART OF THE QUESTION. The amount field carries six
    // decimals and quantises DOWN, so a quantity resolved at full precision
    // arrives at the chain worth less than the chip promised -- measured at
    // 3.25e-6 USDC short on a $25 chip before this argument existed. Searching
    // on the quantum makes the resolved number and the displayed number the
    // same number.
    const found = resolveSellForNet(state, profile, fees, wei, tokenBalance, USDC_VIEW_SCALE)
    return found.ok ? found.tokensIn : null
  }

  // BOTH BUY TABS SPEND USDC, so both are bound by the gas reserve -- the same
  // `spendable` MAX is computed from, compared by the same function.
  if (!chipFits(spendable, wei)) return null

  // Zero slippage: this is asking "what does this budget BUY", not building the
  // transaction. The tolerance is applied later, to the plan the user submits.
  const quote = quoteFor({ tab: 'spend', amount: wei, state, profile, fees, slipBps: 0 })
  if (!quote.ok || quote.plan.clamped) return null

  if (tab === 'spend') return wei
  // `receive` takes TOKENS. The tokens this budget buys is the planner's own
  // `tokens`, not a price multiplication.
  return quote.plan.tokens
}

// --------------------------------------------------------------------------
// Fiyat etkisi ve ilerleme
// --------------------------------------------------------------------------

/** %10. Uzerinde uyarilir, ASLA bloklanmaz -- bkz. `PRICE_IMPACT_NOTE`. */
export const PRICE_IMPACT_WARN_PPM = 100_000

export const PRICE_IMPACT_NOTE =
  'High price impact is normal on a bonding curve: on this profile a 1 USDC buy takes about a quarter of the sale supply. Nothing is blocked.'

/** `(after - before) / before`, milyonda pay. Isaretli. */
export function priceImpactPpm(beforeWei: bigint, afterWei: bigint): number {
  if (beforeWei <= 0n)
    throw new RangeError(`priceImpactPpm: before must be positive (${beforeWei})`)
  return Number(((afterWei - beforeWei) * 1_000_000n) / beforeWei)
}

/**
 * `+51.32%`. Isaret HER ZAMAN yazilir.
 *
 * Yuvarlama yariyi YUKARI ve MUTLAK deger uzerinde: `-0.005` icin once
 * buyuklugu yuvarlayip sonra isareti koymak, `Math.round`'un negatif tarafta
 * sifira dogru degil `+Infinity`'ye dogru yuvarlamasindan dogan asimetriyi
 * kaldirir. Iki ondalik cunku +51,3183% ile +51,32% arasindaki fark hicbir
 * karari degistirmez, ama sutun genisligi degistirir.
 */
export function formatSignedPercent(ppm: number): string {
  const sign = ppm < 0 ? '-' : '+'
  const hundredths = Math.round(Math.abs(ppm) / 100)
  const whole = Math.floor(hundredths / 100)
  const fraction = hundredths % 100
  return `${sign}${whole.toLocaleString('en-US')}.${String(fraction).padStart(2, '0')}%`
}

/**
 * `25.3%`. Sayfanin ust seridiyle AYNI formul (`app/token/[address]/page.tsx`):
 * ayni ilerleme iki yerde iki farkli basamakla yazilirsa kullanici hangisinin
 * dogru oldugunu sorar.
 */
export function formatProgressPercent(ppm: number): string {
  return `${(Math.round(ppm / 1_000) / 10).toFixed(1)}%`
}

/** `95n` -> `0.95%`. Iki ondalik: 30 bps `0.30%`'tur, `0.3%` degil. */
export function formatBps(bps: bigint): string {
  const whole = bps / 100n
  const fraction = bps % 100n
  return `${whole}.${fraction.toString().padStart(2, '0')}%`
}

/** `100` -> `1%`, `50` -> `0.5%`. Slipaj etiketi; sondaki sifirlar atilir. */
export function formatSlipBps(slipBps: number): string {
  const text = (slipBps / 100).toFixed(2).replace(/\.?0+$/, '')
  return `${text}%`
}

// --------------------------------------------------------------------------
// Buton sirasi
// --------------------------------------------------------------------------

export type ConnectionState = 'disconnected' | 'wrongNetwork' | 'connected'

export type ApprovalState = 'notNeeded' | 'unknown' | 'required' | 'sufficient'

export type SimulationVerdict =
  /** Simulasyon gecti, ya da hic calistirilmadi. */
  | { readonly kind: 'ok' }
  /** Revert etti: cuzdan penceresi HIC acilmaz. */
  | { readonly kind: 'blocked'; readonly failure: ArcpadFailure }
  /**
   * Simulasyon AGDAN dolayi yapilamadi. Gonderme ACIK kalir: simulasyonun
   * basarisizligi islemin basarisizligi demek degildir ve RPC'nin geride
   * olmasi kullanicinin islem yapamamasi icin bir sebep degil.
   */
  | { readonly kind: 'unverified'; readonly failure: ArcpadFailure }

export type TradePhase =
  'idle' | 'simulating' | 'awaitingSignature' | 'pending' | 'confirmed' | 'failed'

export type ButtonIntent =
  | 'connect'
  | 'switch'
  | 'empty'
  | 'insufficient'
  | 'planError'
  | 'approve'
  | 'blocked'
  | 'busy'
  | 'ready'

export type ButtonPlan = {
  readonly intent: ButtonIntent
  readonly label: string
  readonly disabled: boolean
}

export type ButtonInput = {
  readonly connection: ConnectionState
  readonly chainName: string
  readonly symbol: string
  readonly tab: TradeTab
  /** Ayristirilmis girdi. `null` -> alan bos ya da okunamaz. */
  readonly amount: bigint | null
  readonly quote: Quote | null
  /** Alim sekmelerinde `spendable`, satista token bakiyesi. `null` -> bilinmiyor. */
  readonly available: bigint | null
  readonly approval: ApprovalState
  readonly simulation: SimulationVerdict
  readonly phase: TradePhase
}

const BUSY_LABEL: Partial<Record<TradePhase, string>> = {
  simulating: 'Checking…',
  awaitingSignature: 'Confirm in your wallet',
  pending: 'Submitting…',
}

/**
 * TEK BIR SIRA, VE HER DURUM ICIN TAM OLARAK BIR METIN.
 *
 * Sira baglayicidir cunku iki kosul ayni anda dogru oldugunda hangisinin
 * yazildigi kullanicinin ATACAGI ADIMI belirler: bagli olmayan bir kullaniciya
 * "Insufficient USDC" yazmak, olmayan bir cuzdanin bakiyesi hakkinda bir sey
 * soylemektir.
 *
 * BRIEF'IN SIRASINA IKI RUNG EKLENDI ve ikisi de olculmus bir bosluktu:
 *   - `planError`: planlayici reddettiginde ("kalan token bu kadar degil")
 *     sebep yazilir. Brief'in sirasinda bu durum yok; bugun cogu dali
 *     kelepce/kuantalama kapatiyor ama kapali OLDUGUNU varsaymak, kapandigini
 *     bilmekten farklidir.
 *   - `busy`: `simulating/awaitingSignature/pending`. Bu durumlarda "Buy DIFF"
 *     yazmaya devam eden bir buton, ikinci bir kez basilmaya davet eder.
 */
export function buttonFor(input: ButtonInput): ButtonPlan {
  const { connection, chainName, symbol, tab, amount, quote, available, approval } = input

  if (connection === 'disconnected') {
    return { intent: 'connect', label: 'Connect wallet', disabled: false }
  }
  if (connection === 'wrongNetwork') {
    return { intent: 'switch', label: `Switch to ${chainName}`, disabled: false }
  }

  const busy = BUSY_LABEL[input.phase]
  if (busy !== undefined) return { intent: 'busy', label: busy, disabled: true }

  if (amount === null || amount === 0n) {
    return { intent: 'empty', label: 'Enter an amount', disabled: true }
  }

  if (quote !== null && !quote.ok) {
    return { intent: 'planError', label: PLAN_ERROR_TEXT[quote.errorName], disabled: true }
  }

  // Alimda karsilastirilan sey GIRDI DEGIL, planin `value`'sudur: `receive`
  // sekmesinde kullanicinin yazdigi sey token, cuzdandan cikan sey ise
  // `maxQuoteIn`. Girdiyle karsilastiran bir kontrol o sekmede iki farkli
  // birimi karsilastirirdi.
  const needed = isBuyTab(tab) ? (quote?.ok ? quote.plan.value : null) : amount
  if (needed !== null && available !== null && needed > available) {
    return {
      intent: 'insufficient',
      label: isBuyTab(tab) ? 'Insufficient USDC' : `Insufficient ${symbol}`,
      disabled: true,
    }
  }

  if (approval === 'required') {
    return { intent: 'approve', label: `Approve ${symbol}`, disabled: false }
  }
  if (approval === 'unknown') {
    return { intent: 'busy', label: 'Checking allowance…', disabled: true }
  }

  if (input.simulation.kind === 'blocked') {
    return { intent: 'blocked', label: input.simulation.failure.title, disabled: true }
  }

  return {
    intent: 'ready',
    label: `${isBuyTab(tab) ? 'Buy' : 'Sell'} ${symbol}`,
    disabled: false,
  }
}
