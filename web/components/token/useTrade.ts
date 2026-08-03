'use client'

import { bondingCurveAbi, USDC_VIEW_SCALE, type TradePlan } from '@arcpad/shared/browser'
import { useCallback, useRef } from 'react'
import { parseEventLogs, type Log, type TransactionReceipt } from 'viem'
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { HexAddress, TradeRow } from '@/components/read/types'
import { type ArcpadFailure, decodeArcpadError } from '@/lib/decodeRevert'
import { LOG_INDEX_BITS } from './lifecycle'
import type { TradePhase } from './tradeModel'
import { walletDeltaWei } from './walletDelta'

/**
 * GERCEKLESEN MIKTARLAR MAKBUZDAN OKUNUR, KOTADAN DEGIL.
 *
 * Uc yerde talep ile gerceklesen AYRISIR: kisma (`buyExactQuoteIn` rezervin
 * tepesinde butceyi kiser), iade (`buyExactTokensOut` `maxQuoteIn` gonderir ve
 * artani geri verir) ve curve'u kapatan son islem. Kotayi "onaylandi" diye
 * gostermek bu uc durumda kullaniciya OLMAYAN bir sayi gostermek olur --
 * spec §5.4'un "gerceklesen miktarlar olaydan okunmalidir" kuralinin arayuz
 * karsiligi budur.
 */

export type RealisedTrade = {
  /**
   * Makbuzdan kurulmus GERCEK islem satiri. Listenin tepesine "Your trade"
   * olarak konabilir ve indexer'dan geldiginde `eventSeq` ile tekillestirilir.
   */
  readonly row: TradeRow
  /** `walletDelta.ts`'in TEK formulu. Onay ekrani ile gecmis ayni sayiyi der. */
  readonly walletDeltaWei: bigint
  /** Alimda `value - (curve + ucretler)`. Satista `null`. */
  readonly refundWei: bigint | null
  /** Talep edilenden AZ token geldi ya da gosterilebilir bir iade var. */
  readonly clamped: boolean
}

/**
 * Iade satiri ancak GORULEBILIR oldugunda yazilir: bir mikro-USDC alti tutar
 * alti ondalikta `0.000000` olarak cizilir ve "0,000000 USDC refunded" cumlesi
 * kullaniciya bir sey soylemez. Normal bir alimin iadesi zaten bir wei'dir.
 */
export const REFUND_DISPLAY_FLOOR = USDC_VIEW_SCALE

/**
 * `Trade` OLAYI `isBuy`'I `indexed` TASIMAZ -- yon TOPIC'ten degil VERIDEN
 * okunur. `parseEventLogs` bunu zaten yapiyor; `args: { isBuy: true }` ile
 * filtrelemeye calisan kod SESSIZCE bos doner (Faz 3'un S-tablosunda ayni
 * tuzak). Bu yuzden filtre yalnizca olay adi ve ADRES uzerinedir.
 */
export function realisedFromReceipt(
  receipt: Pick<TransactionReceipt, 'logs' | 'transactionHash' | 'blockNumber'>,
  plan: TradePlan,
  curve: HexAddress,
  now: Date = new Date(),
): RealisedTrade | null {
  const events = parseEventLogs({
    abi: bondingCurveAbi,
    eventName: 'Trade',
    logs: receipt.logs as Log[],
  })
  const mine = events.find((event) => event.address.toLowerCase() === curve.toLowerCase())
  if (mine === undefined) return null

  const args = mine.args
  const row: TradeRow = {
    // Faz 3'un kodlamasi: `eventSeq = (block << 20) | logIndex`. Ayni
    // kodlamayi burada uretmek, indexer'in satiri geldiginde tekillestirmenin
    // ISE YARAMASININ sarti.
    eventSeq: (receipt.blockNumber << LOG_INDEX_BITS) | BigInt(mine.logIndex ?? 0),
    txHash: receipt.transactionHash,
    // Makbuz blok ZAMANINI tasimaz ve onun icin ikinci bir `eth_getBlockByNumber`
    // atmaya degmez: Arc'in finality'si ~350 ms, yani duvar saati bu satirin
    // TEK kullanimi olan "ne kadar once" sorusunda bir saniyeden fazla sapmaz.
    blockTime: now,
    trader: args.trader,
    isBuy: args.isBuy,
    tokenAmountTok: args.tokenAmount,
    quoteAmountWei: args.quoteAmount,
    protocolFeeWei: args.protocolFee,
    creatorFeeWei: args.creatorFee,
    virtualTokenReservesTok: args.virtualTokenReserves,
    virtualQuoteReservesWei: args.virtualQuoteReserves,
    realTokenReservesTok: args.realTokenReserves,
    realQuoteReservesWei: args.realQuoteReserves,
    // ARAYUZ `isDev`'I TURETMEZ. `trader === creator` karsilastirmasi
    // NOKTASAL olmali (creator degistirilebilir, Faz 1d) ve o bilgi
    // indexer'dadir. Iyimser satir rozet IDDIA ETMEZ; indexer'in satiri
    // geldiginde gercegi tasir.
    isDev: false,
  }

  const delta = walletDeltaWei(row)
  const spent = args.quoteAmount + args.protocolFee + args.creatorFee
  const refund = args.isBuy ? plan.value - spent : null

  return {
    row,
    // `walletDeltaWei` ucret kolonlari eksikken `null` doner; burada uc alan da
    // olaydan geldigi icin bu dal ulasilamaz, ama bir `!` yazmak yerine
    // toplami acikca kurmak, formulun tek kaynagini bozmadan tipi kapatir.
    walletDeltaWei:
      delta ?? (args.isBuy ? spent : args.quoteAmount - args.protocolFee - args.creatorFee),
    refundWei: refund,
    clamped: args.tokenAmount < plan.tokens || (refund !== null && refund >= REFUND_DISPLAY_FLOOR),
  }
}

export type TradeHandle = {
  readonly submit: (plan: TradePlan) => void
  readonly phase: TradePhase
  readonly hash: `0x${string}` | undefined
  readonly failure: ArcpadFailure | null
  readonly realised: RealisedTrade | null
  readonly reset: () => void
}

/**
 * ISLEM YASAM DONGUSU:
 *   idle -> awaitingSignature -> pending(hash) -> confirmed(realised) | failed
 *
 * `simulating` bu kancada DEGIL panelde durur: simulasyon plan degistikce
 * kendiliginden kosar, gonderme ise bir dugmeye basmakla baslar.
 *
 * `pending` ATLANMAZ. Arc'in finality'si ~350 ms, yani bu durum kisa omurludur
 * -- ama imzadan sonra hicbir ara durum gostermemek, kullaniciya islemin
 * kayboldugu izlenimini verir; hash ve gezgin linki HEMEN gorunur.
 */
export function useTrade(curve: HexAddress | undefined): TradeHandle {
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    query: { enabled: write.data !== undefined },
  })
  // Gonderilen plan SAKLANIR: iade ve kisma, olayin miktarlari ile PLANIN
  // `value`/`tokens`'i karsilastirilarak bulunur. Panelin o anki plani bu is
  // icin kullanilamaz -- kullanici islem beklerken alani degistirebilir.
  const submitted = useRef<TradePlan | null>(null)

  const submit = useCallback(
    (plan: TradePlan) => {
      if (curve === undefined) return
      submitted.current = plan
      write.writeContract({
        address: curve as `0x${string}`,
        abi: bondingCurveAbi,
        // Plan hangi giris noktasi ise O cagrilir. Sekmeden fonksiyona ikinci
        // bir haritalama YOK: haritalama `TAB_ACTION`'da bir kez yapilir ve
        // plan onu tasir.
        functionName: plan.action,
        args: plan.args as never,
        // `sellExactTokensIn` NONPAYABLE, iki alim PAYABLE. `functionName` uc
        // adin birlesimi oldugu icin TS `value`'yu tek bir dala gore daraltip
        // `payable` dallari dusuruyor. Cast YALNIZCA tipi yumusatiyor: planin
        // `value`'su satista zaten `0n`, yani zincire giden sayi degismiyor.
        value: plan.value as never,
      })
    },
    [curve, write],
  )

  const phase: TradePhase = write.isPending
    ? 'awaitingSignature'
    : write.error
      ? 'failed'
      : write.data === undefined
        ? 'idle'
        : receipt.isSuccess
          ? 'confirmed'
          : receipt.isError
            ? 'failed'
            : 'pending'

  const rawError = write.error ?? receipt.error ?? null
  const plan = submitted.current

  return {
    submit,
    phase,
    hash: write.data,
    failure:
      rawError === null
        ? null
        : decodeArcpadError(rawError, { action: plan?.action ?? 'buyExactQuoteIn' }),
    realised:
      receipt.isSuccess && receipt.data !== undefined && plan !== null && curve !== undefined
        ? realisedFromReceipt(receipt.data, plan, curve)
        : null,
    reset: useCallback(() => {
      submitted.current = null
      write.reset()
    }, [write]),
  }
}
