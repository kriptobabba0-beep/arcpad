import { formatTokenAmount, formatUsdcAmount } from '@arcpad/shared/browser'
import type { ArcpadFailure } from '@/lib/decodeRevert'
import type { ArcpadAction, ArcpadFailureKind, FailureKey } from '@/lib/failureTable'
import { ERROR_SURFACE } from './reachableErrors'

/**
 * KULLANICININ OKUDUGU METIN.
 *
 * `FAILURE_TABLE` hucreye BIR SATIR verir; burasi ayni hucreye kullanicinin
 * gercekten okudugu ucluyu verir: ne oldu, ne yapabilir, ve tekrar denemenin
 * anlami var mi. Ayrilmasinin iki sebebi var ve ikisi de olcumlu:
 *
 *   1. METIN BAGLAM ISTER. `ERC20InsufficientAllowance` PARAMETRELI bir
 *      hatadir; eksik miktari YAZMAK icin `needed - allowance` hesaplanmali ve
 *      token sembolu bilinmelidir. Ayni sekilde `NotEnoughTokensToBuy` icin
 *      kalan rezerv, `SlippageExceeded` icin `maxQuoteIn` ve `msg.value`
 *      gerekir. Bunlarin hicbiri `(eylem, ad)` anahtarindan cikmaz.
 *
 *   2. AYNI SELECTOR IKI SEBEP OLABILIR. `buyExactTokensOut` icinde kontrat
 *      `total > maxQuoteIn || total > msg.value` der ve TEK bir
 *      `SlippageExceeded()` doner. Arayuz iki degeri de bildigi icin hangisi
 *      oldugunu YEREL OLARAK ayirt eder; zincirden gelen veri ayirt edemez.
 *      Ikisini tek metne indirmek, cuzdani eksik deger gonderen kullaniciya
 *      "toleransi yukselt" dedirtir ve tolerans hicbir sey duzeltmez.
 *
 * METIN INGILIZCE, yorumlar Turkce -- depo kurali.
 */

export type FailureTone = 'neutral' | 'warn' | 'error'

/** Metnin sayilari yazabilmesi icin cagiranin bildigi, zincirin bilmedigi seyler. */
export type FailureContext = {
  /** Launch token sembolu, ornek: `DIFF`. Yoksa "tokens" yazilir. */
  readonly symbol?: string
  /** `buyExactTokensOut` ucret DAHIL ust siniri. */
  readonly maxQuoteInWei?: bigint
  /** Cuzdanin gercekten gonderdigi `msg.value`. */
  readonly sentValueWei?: bigint
  /** Curve uzerinde kalan token (1e18 olcekli). */
  readonly realTokenReservesTok?: bigint
  /** Bu islemin kendi tutari -- fon yetersizliginde AYRI kalem olarak yazilir. */
  readonly tradeAmountWei?: bigint
  /** Gas icin ayrilmasi gereken tutar -- ikinci kalem. */
  readonly gasReserveWei?: bigint
}

export type ReadableFailure = {
  readonly kind: ArcpadFailureKind
  readonly action: ArcpadAction
  readonly name: string
  /**
   * `neutral` KUTU CIZDIRMEZ. Kullanici reddi bir hata degil bir karardir ve
   * kirmizi bir kutuya konarsa kullaniciya bilerek yaptigi seyin yanlis
   * oldugu soylenmis olur.
   */
  readonly tone: FailureTone
  readonly title: string
  readonly body: string
  /** Her zaman DOLU. Yapilabilecek bir sey yoksa bunu acikca yazar. */
  readonly remedy: string
  readonly retryable: boolean
  /** `unknown` dali: ham hata gosterilir ve kopyalanabilir. */
  readonly showRaw: boolean
  readonly raw: unknown
}

type Copy = {
  readonly title: string
  readonly body: string
  readonly remedy: string
  readonly retryable?: boolean
  readonly tone?: FailureTone
}

const usdc = (wei: bigint): string => `${formatUsdcAmount(wei, { rounding: 'up' })} USDC`
const usdcDown = (wei: bigint): string => `${formatUsdcAmount(wei, { rounding: 'down' })} USDC`
const tok = (amount: bigint, symbol: string | undefined): string =>
  `${formatTokenAmount(amount)} ${symbol ?? 'tokens'}`

/** `ERC20Insufficient*` uclusunun ikinci ve ucuncu argumani, guvenli okunmus. */
function bigintArg(args: readonly unknown[] | undefined, index: number): bigint | undefined {
  const value = args?.[index]
  return typeof value === 'bigint' ? value : undefined
}

/**
 * SABIT METINLER. Yalnizca `user` ve `guarded` hucreleri burada durur --
 * `operator` sinifinin metni hucreye degil SINIFA aittir ve `operatorCopy`
 * uretir. Bir operator hucresine elle metin yazmak, o hucrenin gercekten
 * ulasildigi gun onu normal bir kullanici hatasi gibi gosterirdi.
 */
const CELL_COPY: Readonly<Partial<Record<FailureKey, Copy>>> = {
  // ---- launch -------------------------------------------------------------
  /**
   * `user` SINIFI, `operator` DEGIL -- VE AYRIM KULLANICININ EKRANINDA DURUR.
   *
   * Hazinenin bagli olmamasi bir kurulum durumudur, ama kullanicinin
   * yapabilecegi SOMUT bir sey vardir: kutuyu kaldirip launch etmek. Operator
   * metni ("bu launchpad yanlis kurulmus") dogru olmakla birlikte kullaniciyi
   * cikissiz birakirdi -- oysa cikis bir tik uzakta.
   */
  'launch:BuybackUnavailable': {
    title: 'Buyback is not available yet.',
    body: 'This launchpad has not finished wiring its buyback treasury, so a launch cannot reserve fees for it.',
    remedy: 'Uncheck buyback and launch now -- you can turn it on later from your token page.',
  },
  'launch:EmptyName': {
    title: 'Name is required.',
    body: 'The factory refuses a launch with an empty name.',
    remedy: 'Type a name and submit again.',
  },
  'launch:EmptySymbol': {
    title: 'Ticker is required.',
    body: 'The factory refuses a launch with an empty symbol.',
    remedy: 'Type a ticker and submit again.',
  },
  'launch:NameTooLong': {
    title: 'Name is over 32 bytes.',
    body: 'The limit is counted in BYTES, not characters, so emoji and accented letters cost more than one each.',
    remedy: 'Shorten the name until the counter turns black.',
  },
  'launch:SymbolTooLong': {
    title: 'Ticker is over 13 bytes.',
    body: 'The limit is counted in BYTES, not characters.',
    remedy: 'Shorten the ticker until the counter turns black.',
  },
  'launch:UriTooLong': {
    title: 'Metadata link is over 200 bytes.',
    body: 'The limit is counted in BYTES, not characters.',
    remedy: 'Use a shorter link.',
  },

  // ---- buyExactQuoteIn ----------------------------------------------------
  'buyExactQuoteIn:CurveComplete': {
    title: 'This curve sold out while you were trading.',
    body: 'The last tokens went to someone else between your quote and your transaction. Nothing was spent.',
    remedy: 'Refresh the page — the panel switches to the completed state.',
  },
  'buyExactQuoteIn:ZeroQuoteIn': {
    title: 'Enter an amount.',
    body: 'The curve refuses a buy with no value attached.',
    remedy: 'Type how much USDC you want to spend.',
  },
  'buyExactQuoteIn:NetTooSmall': {
    title: 'That amount is too small to buy any tokens.',
    body: 'After the protocol and creator fees are taken, nothing is left to put on the curve, and the curve will not take money for zero tokens.',
    remedy: 'Raise the amount and try again.',
  },
  'buyExactQuoteIn:SlippageExceeded': {
    title: 'Price moved past your slippage limit.',
    body: 'Someone traded between your quote and your transaction, so you would have received fewer tokens than your floor. Nothing was spent.',
    remedy: 'Raise the tolerance, or try again at the new price.',
    retryable: true,
  },
  'buyExactQuoteIn:RefundFailed': {
    title: 'Your wallet could not receive the refunded USDC.',
    body: 'The buy left change, and sending it back failed — so the whole transaction was rolled back. Contract wallets that reject plain transfers, and addresses blocked at the network level, both look like this.',
    remedy: 'Trade from an address that can receive native USDC.',
  },

  // ---- buyExactTokensOut --------------------------------------------------
  'buyExactTokensOut:CurveComplete': {
    title: 'This curve sold out while you were trading.',
    body: 'The last tokens went to someone else between your quote and your transaction. Nothing was spent.',
    remedy: 'Refresh the page — the panel switches to the completed state.',
  },
  'buyExactTokensOut:ZeroTokensOut': {
    title: 'Enter an amount.',
    body: 'The curve refuses a buy of zero tokens.',
    remedy: 'Type how many tokens you want.',
  },
  'buyExactTokensOut:NotEnoughTokensToBuy': {
    // Miktar `resolveCellCopy` icinde yazilir; bu, rezerv bilinmedigindeki hali.
    title: 'The curve does not hold that many tokens.',
    body: 'This entrypoint does not partially fill: asking for more than the remaining reserve is refused outright.',
    remedy: 'Switch to “Spend USDC” to buy the rest of the curve.',
  },
  'buyExactTokensOut:SlippageExceeded': {
    title: 'Price moved past your slippage limit.',
    body: 'Someone traded between your quote and your transaction, so the exact number of tokens you asked for now costs more than your cap. Nothing was spent.',
    remedy: 'Raise the tolerance, or try again at the new price.',
    retryable: true,
  },
  'buyExactTokensOut:RefundFailed': {
    title: 'Your wallet could not receive the refunded USDC.',
    body: 'This entrypoint sends the cap and refunds the difference; the refund failed, so the whole transaction was rolled back.',
    remedy: 'Trade from an address that can receive native USDC.',
  },

  // ---- sellExactTokensIn --------------------------------------------------
  'sellExactTokensIn:CurveComplete': {
    title: 'Trading on this curve is closed.',
    body: 'The curve completed, which closes all three entrypoints — selling included.',
    remedy: 'Refresh the page — the panel switches to the completed state.',
  },
  'sellExactTokensIn:ZeroTokensIn': {
    title: 'Enter an amount.',
    body: 'The curve refuses a sale of zero tokens.',
    remedy: 'Type how many tokens you want to sell.',
  },
  'sellExactTokensIn:ProceedsTooSmall': {
    // `ZeroTokensIn` DEGILDIR ve metni de ayridir: girdi gecerliydi, SONUC degil.
    title: 'That amount is too small to return any USDC after fees.',
    body: 'The sale is valid, but the protocol and creator fees round up and would swallow the whole payout, so the curve refuses rather than paying you nothing.',
    remedy: 'Sell a larger amount.',
  },
  'sellExactTokensIn:SlippageExceeded': {
    title: 'Price moved past your slippage limit.',
    body: 'Someone traded between your quote and your transaction, so the payout after fees fell below your floor. Your tokens were not sold.',
    remedy: 'Raise the tolerance, or try again at the new price.',
    retryable: true,
  },
  'sellExactTokensIn:PayoutFailed': {
    title: 'Your wallet could not receive USDC.',
    body: 'The sale went through the curve and the payout to your address failed, so the whole transaction was rolled back. Contract wallets that reject plain transfers, and addresses blocked at the network level, both look like this.',
    remedy: 'Sell from an address that can receive native USDC.',
  },
  'sellExactTokensIn:ERC20InsufficientAllowance': {
    // Eksik miktar `resolveCellCopy` icinde YAZILIR; bu, argumanlar yokken.
    title: 'The curve is not approved to move that many tokens.',
    body: 'Selling moves your tokens with transferFrom, which needs an allowance at least as large as the amount.',
    remedy: 'Approve the curve, then sell.',
  },
  'sellExactTokensIn:ERC20InsufficientBalance': {
    title: 'You do not hold that many tokens.',
    body: 'The sale asks for more than your balance.',
    remedy: 'Lower the amount to what you hold.',
  },

  // ---- claim --------------------------------------------------------------
  'claim:NothingToClaim': {
    title: 'There is nothing to claim.',
    body: 'This address has no fees waiting in the escrow — either they were claimed already, or none have accrued.',
    remedy: 'Come back after trades have happened on your launch.',
  },
  'claim:TransferFailed': {
    title: 'Your wallet could not receive the claimed USDC.',
    body: 'The escrow tried to pay out and the transfer failed, so the claim was rolled back and the balance is still yours.',
    remedy: 'Claim to an address that can receive native USDC.',
  },
}

/**
 * OPERATOR SINIFI. Hata adi metnin ICINDE durur -- "bir sey ters gitti"
 * demek, ulasilamaz sandigimiz bir yolun ulasildigi gun o gunu sessiz gecirir.
 */
function operatorCopy(action: ArcpadAction, name: string): Copy {
  const noun = action === 'launch' ? 'launchpad' : 'launch'
  return {
    title: `This ${noun} is misconfigured.`,
    body: `The contract refused with ${name}(), which is a fault in the deployment and not in what you did. Your funds were not moved.`,
    remedy: 'Nothing you can change will help — please report this with the transaction hash.',
  }
}

/**
 * Bir `(eylem, ad)` hucresinin metni, baglamla zenginlestirilmis.
 *
 * Yuzeyde OLMAYAN bir ad icin `undefined` doner ve cagiran onu `operator`
 * gibi gosterir: hucresiz gelen bir hata, sessizce genel bir metne
 * dusurulmemelidir.
 */
export function resolveCellCopy(
  action: ArcpadAction,
  name: string,
  args?: readonly unknown[],
  ctx: FailureContext = {},
): Copy | undefined {
  const spec = ERROR_SURFACE[action][name]
  if (spec === undefined) return undefined
  if (spec.reach === 'operator') return operatorCopy(action, name)

  const base = CELL_COPY[`${action}:${name}`]
  if (base === undefined) return undefined

  // IKI SEBEP, TEK SELECTOR. Kontrat `total > maxQuoteIn || total > msg.value`
  // der. Planlayici `value == maxQuoteIn` KURAR (bkz. `planBuyExactTokensOut`),
  // yani ikisi ancak cuzdan degeri degistirdiginde ayrilir -- ve o vakada
  // "toleransi yukselt" hicbir sey duzeltmez, dolayisiyla `retryable` da degil.
  if (action === 'buyExactTokensOut' && name === 'SlippageExceeded') {
    const { maxQuoteInWei, sentValueWei } = ctx
    if (maxQuoteInWei !== undefined && sentValueWei !== undefined && sentValueWei < maxQuoteInWei) {
      return {
        title: 'Your wallet did not send enough USDC.',
        body: `This buy needs up to ${usdc(maxQuoteInWei)} attached, and only ${usdcDown(sentValueWei)} arrived. The curve checks the fee-inclusive total against BOTH your cap and the value sent, and refuses on either.`,
        remedy: 'Submit again and let the panel set the amount your wallet sends.',
        retryable: false,
      }
    }
    return base
  }

  if (action === 'buyExactTokensOut' && name === 'NotEnoughTokensToBuy') {
    const remaining = ctx.realTokenReservesTok
    if (remaining !== undefined) {
      return {
        ...base,
        title: `Only ${tok(remaining, ctx.symbol)} left on the curve.`,
      }
    }
    return base
  }

  // PARAMETRELI HATA: eksik miktar YAZILIR. `needed - allowance`, elde olan
  // sayidan turetilir; "onayi artirin" demek kullaniciya ne kadar artiracagini
  // soylemez ve ikinci bir basarisiz islem urettirir.
  if (name === 'ERC20InsufficientAllowance') {
    const allowance = bigintArg(args, 1)
    const needed = bigintArg(args, 2)
    if (allowance !== undefined && needed !== undefined && needed > allowance) {
      return {
        ...base,
        title: `Approve ${tok(needed - allowance, ctx.symbol)} more before selling.`,
      }
    }
    return base
  }

  if (name === 'ERC20InsufficientBalance') {
    const balance = bigintArg(args, 1)
    if (balance !== undefined) {
      return { ...base, title: `You hold ${tok(balance, ctx.symbol)}.` }
    }
    return base
  }

  return base
}

/**
 * KONTRAT DISI BASARISIZLIKLAR -- BIRINCI SINIF.
 *
 * Bunlar bir hucre degildir ve olmamalidir: bir selector tasimazlar. Ama
 * kullanicinin gorecegi basarisizliklarin cogunlugu bunlardir, ve bir hata
 * yuzeyinin "yalnizca revert cozer" hali tam olarak burada bos kalir.
 */
function offChainCopy(failure: ArcpadFailure, ctx: FailureContext): Copy {
  switch (failure.name) {
    case 'UserRejected':
      // KIRMIZI KUTU YOK. Nötr bir satir, ve form korunur.
      return {
        title: 'Cancelled.',
        body: 'You rejected the request in your wallet. Nothing was sent and nothing was spent.',
        remedy: 'Your amounts are still here — submit again when you are ready.',
        tone: 'neutral',
      }

    case 'InsufficientFunds': {
      // IKI KALEM AYRI YAZILIR. Arc'ta gas da USDC ile odenir, yani iki kalem
      // AYNI bakiyeden cikar ve "yetersiz bakiye" demek hangisinin eksik
      // oldugunu soylemez.
      const { tradeAmountWei, gasReserveWei } = ctx
      const body =
        tradeAmountWei !== undefined && gasReserveWei !== undefined
          ? `You need ${usdc(tradeAmountWei)} for this trade plus about ${usdc(gasReserveWei)} for gas — both come from the same balance on Arc.`
          : 'You need the trade amount plus gas — and on Arc both come from the same USDC balance, because USDC is the gas asset.'
      return {
        title: 'Not enough USDC for the trade and its gas.',
        body,
        remedy: 'Lower the amount, or top up, leaving room for gas.',
      }
    }

    case 'NetworkError':
      return {
        title: 'The network did not answer.',
        body: 'The request to the Arc RPC failed or timed out. The transaction may or may not have been sent.',
        remedy: 'Check ArcScan before retrying, then try again.',
        retryable: true,
      }

    case 'EmptyRevert':
      // TAHMIN ETMEZ. Degeri olmayan bir revert; `payable` olmayan bir
      // fonksiyona deger, CREATE2 carpismasi ve gas tukenmesi disaridan
      // BIREBIR ayni gorunur.
      return {
        title: 'The transaction was rejected on-chain without a reason.',
        body: 'The call reverted with no data at all. Sending value to a non-payable function, a CREATE2 address collision and running out of gas are indistinguishable from outside, so this message does not guess which one it was.',
        remedy: 'Open the transaction in ArcScan for the trace.',
      }

    case 'Revert': {
      // ARC DIZE REVERT'LERI. Bunlar CUSTOM ERROR DEGILDIR; dize dali olmadan
      // ikisi de "bilinmeyen hata" olurdu.
      const reason = failure.detail
      if (/zero address/i.test(reason)) {
        return {
          title: 'Arc does not allow transfers to the zero address.',
          body: `The network refused the transfer before the contract saw it: “${reason}”.`,
          remedy: 'Use a real destination address.',
        }
      }
      if (/block(ed|list)|denied|not permitted|not allowed|sanction/i.test(reason)) {
        return {
          title: 'This transfer was rejected by the network.',
          body: `Arc applies its address controls at RUNTIME, so the gas was spent before the refusal: “${reason}”.`,
          remedy: 'Trade from a different address.',
        }
      }
      return {
        title: 'The chain refused this transaction.',
        body: reason,
        remedy: 'Open the transaction in ArcScan for the trace.',
      }
    }

    default:
      // BU DAL BOS BIRAKILMAZ. Taninmayan bir selector'u yutmak, onu hic
      // gormemis olmakla ayni sey.
      return {
        title: 'Something went wrong.',
        body: failure.detail,
        remedy: 'Copy the details below and send them to us.',
        tone: 'error',
      }
  }
}

const TONE_BY_KIND: Readonly<Record<ArcpadFailureKind, FailureTone>> = {
  contract: 'error',
  library: 'error',
  token: 'error',
  wallet: 'error',
  network: 'warn',
  operator: 'error',
  unknown: 'error',
}

/**
 * Cozucunun kendi urettigi, bir selector KARSILIGI OLMAYAN adlar. Bir hucre
 * aramak anlamsizdir; dogrudan kontrat disi dala giderler.
 */
const OFF_CHAIN_NAMES: ReadonlySet<string> = new Set([
  'UserRejected',
  'InsufficientFunds',
  'NetworkError',
  'EmptyRevert',
  'Revert',
  'Unknown',
])

/**
 * Cozucunun ciktisini ekrana cikacak hale getirir.
 *
 * `retryable` HER ZAMAN metinle birlikte karar verilir, cozucunun tablosuyla
 * degil: `buyExactTokensOut` icindeki "deger yetersiz" sebebi ayni selector'u
 * tasir ama tekrar denemek onu duzeltmez.
 */
export function readFailure(failure: ArcpadFailure, ctx: FailureContext = {}): ReadableFailure {
  const copy = OFF_CHAIN_NAMES.has(failure.name)
    ? offChainCopy(failure, ctx)
    : // Bir selector geldi ama bu eylemde hucresi yok: `operator` metni ADI
      // yazar. Genel bir "bir sey ters gitti" metnine dusurmek, ulasilamaz
      // sandigimiz bir yolun ulasildigi gunu sessiz gecirirdi.
      (resolveCellCopy(failure.action, failure.name, failure.args, ctx) ??
      operatorCopy(failure.action, failure.name))

  return {
    kind: failure.kind,
    action: failure.action,
    name: failure.name,
    tone: copy.tone ?? TONE_BY_KIND[failure.kind],
    title: copy.title,
    body: copy.body,
    remedy: copy.remedy,
    retryable: copy.retryable ?? failure.retryable,
    showRaw: failure.kind === 'unknown',
    raw: failure.raw,
  }
}

/**
 * YANLIS AG. Bir revert degil, kendi kapimiz (Task 1) -- ama kullanici icin
 * digerleriyle ayni yerde ve ayni bicimde gorunmelidir, yoksa iki farkli
 * "islem olmadi" dili olur.
 */
export function wrongNetworkFailure(chainName: string, action: ArcpadAction): ReadableFailure {
  return {
    kind: 'wallet',
    action,
    name: 'WrongNetwork',
    tone: 'warn',
    title: `Your wallet is not on ${chainName}.`,
    body: `arcpad only exists on ${chainName}. Nothing was sent.`,
    remedy: `Switch to ${chainName} and submit again.`,
    retryable: false,
    showRaw: false,
    raw: undefined,
  }
}

/**
 * MAKBUZ GELMEDI. BASARISIZ DENMEZ -- Arc'ta finality ~350 ms olculdu, yani
 * bekleme asimi neredeyse her zaman RPC tarafindadir, islem tarafinda degil.
 * "Basarisiz" demek kullaniciya ayni islemi ikinci kez yaptirtir.
 */
export function stillPendingFailure(action: ArcpadAction): ReadableFailure {
  return {
    kind: 'network',
    action,
    name: 'ReceiptTimeout',
    tone: 'warn',
    title: 'Still pending.',
    body: 'Your transaction was sent and the RPC has not returned its receipt yet. On Arc a block settles in well under a second, so this is almost always the RPC and not the transaction.',
    remedy: 'Open it in ArcScan — it is very likely already mined.',
    retryable: true,
    showRaw: false,
    raw: undefined,
  }
}
