import { bondingCurveAbi } from '@arcpad/shared/browser'
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from 'viem'
import { describe, expect, it } from 'vitest'
import { LOG_INDEX_BITS } from '@/components/token/lifecycle'
import { quoteFor } from '@/components/token/tradeModel'
import { realisedFromReceipt } from '@/components/token/useTrade'
import type { HexAddress } from '@/components/read/types'
import {
  CLIMBED,
  CURVE,
  FEES,
  FRESH,
  ONE_USDC,
  ONE_USDC_TOKENS,
  TESTNET_PROFILE,
  TRADER,
} from './fixtures'

/**
 * GERCEKLESEN MIKTARLAR MAKBUZDAN, KOTADAN DEGIL.
 *
 * Bu dosya `Trade` olayini GERCEKTEN kodluyor ve geri cozuyor. Sahte bir
 * "olay nesnesi" uydurmak, `parseEventLogs`'un yaptigi isi test etmek yerine
 * onun ne yaptigi hakkindaki inancimizi test ederdi -- ve buradaki tuzak tam
 * olarak o inancta: `Trade.isBuy` `indexed` DEGIL, yani yon topic'te degil
 * VERIDEDIR. `args: { isBuy }` ile filtrelemeye calisan kod sessizce bos
 * doner.
 */

const TRADE_DATA_ABI = [
  { name: 'isBuy', type: 'bool' },
  { name: 'tokenAmount', type: 'uint256' },
  { name: 'quoteAmount', type: 'uint256' },
  { name: 'protocolFee', type: 'uint256' },
  { name: 'creatorFee', type: 'uint256' },
  { name: 'virtualTokenReserves', type: 'uint256' },
  { name: 'virtualQuoteReserves', type: 'uint256' },
  { name: 'realTokenReserves', type: 'uint256' },
  { name: 'realQuoteReserves', type: 'uint256' },
] as const

type TradeArgs = {
  isBuy: boolean
  tokenAmount: bigint
  quoteAmount: bigint
  protocolFee: bigint
  creatorFee: bigint
}

/**
 * BIR MAKBUZUN LOG'U `pending` DEGILDIR, VE TIP BUNU SOYLEMELI.
 *
 * `Log` (parametresiz) `pending extends boolean` demektir, yani `blockHash`
 * `0x… | null`. `TransactionReceipt.logs` ise `Log<bigint, number, false>[]`:
 * onaylanmis bir makbuzun her log'unun blogu VARDIR. Ikisi arasindaki fark
 * gercektir ve `as unknown as Log` ile ezilmisti -- cift cast, hem daralttigi
 * hem genislettigi icin, tipin soyledigi hicbir seyi kontrol etmeden gecer.
 * Burada `false` YAZILI: bu fixture onaylanmis bir makbuzun log'unu kuruyor.
 */
type ReceiptLog = Log<bigint, number, false>

/**
 * `encodeEventTopics` TIPI FILTRELER ICINDIR, LOG'LAR ICIN DEGIL.
 *
 * Bir filtrede indexed bir argüman bir LISTE (`[a, b]` = "ikisinden biri") ya
 * da `null` (= "her sey") olabilir, ve donus tipi bunu tasir. GERCEK bir log'un
 * topic'lerinde ikisi de yoktur: her slot tek bir 32 baytlik kelimedir. Filtre
 * sekli burada DUZLESTIRILIYOR -- cast ile degil, KONTROL ederek: bir `null`
 * slot, fixture'in hicbir zincirin yaymayacagi bir log kurdugu anlamina gelir.
 */
function logTopics(encoded: readonly (Hex | readonly Hex[] | null)[]): [Hex, ...Hex[]] {
  const flat = encoded.map((topic) => {
    if (typeof topic !== 'string') {
      throw new Error(`topic tek bir kelime degil: ${JSON.stringify(topic)}`)
    }
    return topic
  })
  const [signature, ...rest] = flat
  if (signature === undefined) throw new Error('olay imzasi topic`i yok')
  return [signature, ...rest]
}

function tradeLog(args: TradeArgs, opts: { address?: string; logIndex?: number } = {}): ReceiptLog {
  const topics = logTopics(
    encodeEventTopics({
      abi: bondingCurveAbi,
      eventName: 'Trade',
      args: { trader: TRADER as Hex },
    }),
  )
  const data = encodeAbiParameters(TRADE_DATA_ABI, [
    args.isBuy,
    args.tokenAmount,
    args.quoteAmount,
    args.protocolFee,
    args.creatorFee,
    CLIMBED.virtualTokenReserves,
    CLIMBED.virtualQuoteReserves,
    CLIMBED.realTokenReserves,
    CLIMBED.realQuoteReserves,
  ])
  return {
    address: (opts.address ?? CURVE) as Hex,
    topics,
    data,
    blockNumber: 4n,
    blockHash: `0x${'bb'.repeat(32)}`,
    logIndex: opts.logIndex ?? 3,
    transactionHash: `0x${'11'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  }
}

function receiptWith(logs: readonly ReceiptLog[]) {
  return {
    logs: [...logs],
    transactionHash: `0x${'11'.repeat(32)}` as Hex,
    blockNumber: 4n,
  }
}

const buyPlan = () => {
  const quote = quoteFor({
    tab: 'spend',
    amount: ONE_USDC,
    state: FRESH,
    profile: TESTNET_PROFILE,
    fees: FEES,
    slipBps: 100,
  })
  if (!quote.ok) throw new Error('expected a plan')
  return quote.plan
}

const sellPlan = () => {
  const quote = quoteFor({
    tab: 'sell',
    amount: ONE_USDC_TOKENS,
    state: CLIMBED,
    profile: TESTNET_PROFILE,
    fees: FEES,
    slipBps: 100,
  })
  if (!quote.ok) throw new Error('expected a plan')
  return quote.plan
}

const CLAMPED: TradeArgs = {
  isBuy: true,
  // Kotadan AZ token: rezerv bitti ve alim kisildi.
  tokenAmount: 100_000_000_000_000_000_000_000_000n,
  quoteAmount: 490_000_000_000_000_000n,
  protocolFee: 4_655_000_000_000_000n,
  creatorFee: 1_470_000_000_000_000n,
}

describe('realisedFromReceipt', () => {
  it('reads the amounts from the event, not from the plan', () => {
    const plan = buyPlan()
    const realised = realisedFromReceipt(
      receiptWith([tradeLog(CLAMPED)]),
      plan,
      CURVE as HexAddress,
    )
    expect(realised).not.toBeNull()
    if (realised === null) return
    // Kota 200,723,953… diyordu; GERCEKLESEN 100,000,000.
    expect(realised.row.tokenAmountTok).toBe(CLAMPED.tokenAmount)
    expect(realised.row.tokenAmountTok).not.toBe(plan.tokens)
    expect(realised.row.quoteAmountWei).toBe(CLAMPED.quoteAmount)
    expect(realised.row.protocolFeeWei).toBe(CLAMPED.protocolFee)
    expect(realised.row.creatorFeeWei).toBe(CLAMPED.creatorFee)
  })

  it('derives the refund from the plan value MINUS what the event says was spent', () => {
    const plan = buyPlan()
    const realised = realisedFromReceipt(
      receiptWith([tradeLog(CLAMPED)]),
      plan,
      CURVE as HexAddress,
    )
    if (realised === null) throw new Error('expected a realised trade')
    const spent = CLAMPED.quoteAmount + CLAMPED.protocolFee + CLAMPED.creatorFee
    expect(realised.refundWei).toBe(plan.value - spent)
    expect(realised.clamped).toBe(true)
  })

  it('uses the ONE wallet-delta formula: curve plus fees on a buy', () => {
    const realised = realisedFromReceipt(
      receiptWith([tradeLog(CLAMPED)]),
      buyPlan(),
      CURVE as HexAddress,
    )
    if (realised === null) throw new Error('expected a realised trade')
    expect(realised.walletDeltaWei).toBe(
      CLAMPED.quoteAmount + CLAMPED.protocolFee + CLAMPED.creatorFee,
    )
  })

  it('finds a SELL even though isBuy is not indexed', () => {
    // BU, "filtreyi isBuy uzerine kur" TUZAGININ OLDUGU YER. `isBuy` topic'te
    // olmadigi icin `args: { isBuy: false }` ile yapilan bir `parseEventLogs`
    // cagrisi bos doner ve panel "islem onaylandi" satirini HIC gostermez --
    // sessizce, hicbir hata olmadan.
    const sell: TradeArgs = {
      isBuy: false,
      tokenAmount: ONE_USDC_TOKENS,
      quoteAmount: 987_654_320_987_654_319n,
      protocolFee: 9_382_716_049_382_717n,
      creatorFee: 2_962_962_962_962_963n,
    }
    const realised = realisedFromReceipt(
      receiptWith([tradeLog(sell)]),
      sellPlan(),
      CURVE as HexAddress,
    )
    expect(realised).not.toBeNull()
    if (realised === null) return
    expect(realised.row.isBuy).toBe(false)
    // Satista ucret ciktidan DUSULUR.
    expect(realised.walletDeltaWei).toBe(975_308_641_975_308_639n)
    expect(realised.refundWei).toBeNull()
    expect(realised.clamped).toBe(false)
  })

  it('encodes eventSeq exactly as the indexer does, so the row can be deduplicated', () => {
    const realised = realisedFromReceipt(
      receiptWith([tradeLog(CLAMPED, { logIndex: 7 })]),
      buyPlan(),
      CURVE as HexAddress,
    )
    if (realised === null) throw new Error('expected a realised trade')
    expect(realised.row.eventSeq).toBe((4n << LOG_INDEX_BITS) | 7n)
  })

  it('ignores a Trade emitted by a DIFFERENT curve in the same transaction', () => {
    const other = tradeLog(CLAMPED, { address: '0x000000000000000000000000000000000000beef' })
    const mine = tradeLog({ ...CLAMPED, tokenAmount: 1n }, { address: CURVE, logIndex: 9 })
    const realised = realisedFromReceipt(receiptWith([other, mine]), buyPlan(), CURVE as HexAddress)
    if (realised === null) throw new Error('expected a realised trade')
    expect(realised.row.tokenAmountTok).toBe(1n)
  })

  it('matches the curve address case-insensitively', () => {
    const realised = realisedFromReceipt(
      receiptWith([tradeLog(CLAMPED, { address: CURVE.toUpperCase().replace('0X', '0x') })]),
      buyPlan(),
      CURVE as HexAddress,
    )
    expect(realised).not.toBeNull()
  })

  it('claims NOTHING when the receipt carries no Trade from this curve', () => {
    // Iyimser bir satir UYDURULMAZ: olay yoksa gerceklesen miktar da yoktur.
    expect(realisedFromReceipt(receiptWith([]), buyPlan(), CURVE as HexAddress)).toBeNull()
  })

  it('does not claim a dev badge it cannot prove point-in-time', () => {
    const realised = realisedFromReceipt(
      receiptWith([tradeLog(CLAMPED)]),
      buyPlan(),
      CURVE as HexAddress,
    )
    if (realised === null) throw new Error('expected a realised trade')
    // `trader === creator` NOKTASAL olmali (creator degistirilebilir, Faz 1d)
    // ve o bilgi indexer'dadir. Iyimser satir rozet IDDIA ETMEZ.
    expect(realised.row.isDev).toBe(false)
  })
})
