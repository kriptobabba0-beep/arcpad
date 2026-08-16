import type { Address } from 'viem'
import type { BuybackLedgerEvent, Queryable } from '@arcpad/db'
import { applyBuybackEvent } from '@arcpad/db'
import type {
  BuybackAccruedEvent,
  BuybackExecutedEvent,
  BuybackLockedEvent,
  BuybackSkippedEvent,
  VestingReleasedEvent,
} from '../logs'

/**
 * BUYBACK UYGULAYICISI -- BES OLAY, IKI KONTRAT, TEK DEFTER.
 *
 * Bu dosyanin isi `apply/fees.ts`inkiyle ayni sinifta: cozulmus olayi
 * `@arcpad/db`nin defter yazicisina EVIRMEK. Ture ozgu bilgi -- hangi alan
 * hangi kolona gider, hangi kolon o turde BOS kalir -- BURADA yasar; semadaki
 * `*_iff_*` kisitlari ayni bilgiyi ikinci kez, ve ZORLAYARAK soyler.
 *
 * ================================================================
 * ZAMAN: ZINCIR SANIYE SAYAR, KOLON `timestamptz` TUTAR
 * ================================================================
 *
 * `vestingStart`/`vestingEnd` unix SANIYESIDIR. `timestamptz`e cevirmek bir
 * sadelik tercihi degil: vesting penceresi arayuzde bir SURE olarak okunur
 * ("5 yil, 3 ay kaldi") ve o hesabi ham bir tamsayidan yapmak, `_at` sonekinin
 * anlamini tasiyan tek yerin uygulama kodu olmasi demekti.
 */

/**
 * Buyback olayi, `launches`ta olmayan bir token icin geldi. HALT.
 *
 * `UnknownCurve`/`UnknownPool` ile ayni sinif, farkli bir sebeple: buyback
 * olaylari TOKEN kumesine gore degil, hazine ve kasa ADRESLERINE gore cekilir
 * -- yani izleme kumesinden bagimsizdirlar ve bir `Launched` gormeden
 * gelebilirler.
 *
 * URETIMDE OLAMAZ ve gerekcesi yapisaldir: `deployment.start_block` FABRIKANIN
 * dagitim blogudur, yani indexer hazine daha var olmadan once baslar. Bu hatayi
 * gormek bu yuzden ya izleme penceresinin elle daraltildigini ya da olayin BIZE
 * AIT OLMAYAN bir hazineden geldigini soyler; ikisi de sessizce gecilecek sey
 * degildir. Yabanci anahtar ayni hali bir satir sonra zaten yakalar -- bu
 * kontrol yalnizca SEBEBI soyler.
 */
export class UnknownBuybackToken extends Error {
  constructor(readonly token: Address) {
    super(
      `UnknownBuybackToken: ${token} icin launches satiri yok. Buyback olaylari hazine ve ` +
        `kasa ADRESLERINE gore cekilir, yani izleme kumesinden bagimsizdirlar; bu olay ya ` +
        `start_block'tan ONCE dogmus bir launch'a ya da bize ait olmayan bir hazineye ait.`,
    )
    this.name = 'UnknownBuybackToken'
  }
}

/** Zincirin unix saniyesi -> `timestamptz`. */
const at = (unixSeconds: bigint): Date => new Date(Number(unixSeconds) * 1000)

async function assertLaunched(db: Queryable, token: Address): Promise<void> {
  const { rows } = await db.query<{ ok: boolean }>(
    'SELECT true AS ok FROM launches WHERE token = $1',
    [token.toLowerCase()],
  )
  if (rows.length === 0) throw new UnknownBuybackToken(token)
}

/** Bes turun ORTAK govdesi. Ture ozgu alanlar cagiran tarafindan eklenir. */
type Specific = Omit<
  BuybackLedgerEvent,
  'kind' | 'eventSeq' | 'blockNumber' | 'logIndex' | 'txHash' | 'blockTime' | 'token' | 'emitter'
>

const EMPTY: Specific = {
  buybackKind: 'accrued',
  venue: null,
  caller: null,
  reason: null,
  quoteWei: null,
  pendingWei: null,
  tokenAmountTok: null,
  totalLockedTok: null,
  creatorAmountTok: null,
  protocolAmountTok: null,
  vestingStart: null,
  vestingEnd: null,
}

async function write(
  db: Queryable,
  ref: {
    seq: bigint
    blockNumber: bigint
    logIndex: number
    txHash: string
    blockTime: Date
    token: Address
    emitter: Address
  },
  specific: Specific,
): Promise<number> {
  await assertLaunched(db, ref.token)
  return applyBuybackEvent(db, {
    kind: 'buyback',
    eventSeq: ref.seq,
    blockNumber: ref.blockNumber,
    logIndex: ref.logIndex,
    txHash: ref.txHash,
    blockTime: ref.blockTime,
    token: ref.token,
    emitter: ref.emitter,
    ...specific,
  })
}

/**
 * `BuybackAccrued(token, venue, quoteAmount, pending)`.
 *
 * `pending` MUTLAKTIR ve tasinmasinin sebebi tam olarak budur: toplam tablosu
 * her tahakkukta ona SIFIRLANIR, yani iki tahakkuk arasinda birikmis bir sapma
 * bir sonraki tahakkukta silinir.
 */
export async function applyBuybackAccruedEvent(
  db: Queryable,
  event: BuybackAccruedEvent,
): Promise<number> {
  return write(
    db,
    { ...event, emitter: event.treasury },
    {
      ...EMPTY,
      buybackKind: 'accrued',
      venue: event.venue,
      quoteWei: event.quoteAmount,
      pendingWei: event.pending,
    },
  )
}

/** `BuybackExecuted(token, quoteSpent, tokensBought)`. */
export async function applyBuybackExecutedEvent(
  db: Queryable,
  event: BuybackExecutedEvent,
): Promise<number> {
  return write(
    db,
    { ...event, emitter: event.treasury },
    {
      ...EMPTY,
      buybackKind: 'executed',
      quoteWei: event.quoteSpent,
      tokenAmountTok: event.tokensBought,
    },
  )
}

/**
 * `BuybackSkipped(token, quoteReturnedToCreator, reason)`.
 *
 * `reason` ZINCIRDEN gelen bir dizedir ve bu yuzden `pgSafeText`ten gecer
 * (yazicida); desen kisiti YOKTUR -- gerekce migration 016'da.
 */
export async function applyBuybackSkippedEvent(
  db: Queryable,
  event: BuybackSkippedEvent,
): Promise<number> {
  return write(
    db,
    { ...event, emitter: event.treasury },
    {
      ...EMPTY,
      buybackKind: 'skipped',
      quoteWei: event.quoteReturnedToCreator,
      reason: event.reason,
    },
  )
}

/** `BuybackLocked(token, tokenAmount, vestingStart, vestingEnd, totalLocked)`. */
export async function applyBuybackLockedEvent(
  db: Queryable,
  event: BuybackLockedEvent,
): Promise<number> {
  return write(
    db,
    { ...event, emitter: event.vault },
    {
      ...EMPTY,
      buybackKind: 'locked',
      tokenAmountTok: event.tokenAmount,
      totalLockedTok: event.totalLocked,
      vestingStart: at(event.vestingStart),
      vestingEnd: at(event.vestingEnd),
    },
  )
}

/** `VestingReleased(token, caller, creatorAmount, protocolAmount)`. */
export async function applyVestingReleasedEvent(
  db: Queryable,
  event: VestingReleasedEvent,
): Promise<number> {
  return write(
    db,
    { ...event, emitter: event.vault },
    {
      ...EMPTY,
      buybackKind: 'released',
      caller: event.caller,
      creatorAmountTok: event.creatorAmount,
      protocolAmountTok: event.protocolAmount,
    },
  )
}
