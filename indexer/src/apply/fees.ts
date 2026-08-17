import type { Queryable } from '@arcpad/db'
import { applyFeeEvent } from '@arcpad/db'
import type { ClaimedEvent, DepositedEvent } from '../logs'

/**
 * UCRET DEFTERI -- `fee_events` ve `fee_balances`.
 *
 * `fee_balances` de artimlidir ve `holders` ile AYNI kurala tabidir: artim,
 * `fee_events`e bir satirin GERCEKTEN eklenmis olmasina baglidir.
 * `CHECK (claimable_wei = deposited_total_wei - claimed_total_wei)` her
 * yazimda defter esitligini dogrular.
 *
 * ESCROW'UN BAKIYESI BURADA HIC GORUNMEZ, ve bu bir eksiklik degil KARARDIR.
 * `FeeEscrow`'un NatSpec'i (kisit 1) olculmus bir olguyu kaydediyor: escrow'un
 * bakiyesi `deposit()` DISINDAN da artabilir (`USDC.transfer(escrow, x)`
 * basarili olur, `receive()` hic calismaz) ve o para TALEP EDILEMEZ. Yani
 *   dogru invariant  totalOwed <= balance   ("==" DEGIL),
 *   ve `SUM(fee_balances.claimable_wei)` zincir ustu bakiyenin bir ALT
 *   SINIRIDIR.
 * Arayuz escrow bakiyesini "talep edilebilir ucret" diye gosterirse yanlis bir
 * rakam gosterir; bu yuzden bakiyeyi donduren bir fonksiyon YOKTUR.
 */

/**
 * `Deposited(recipient, from, amount)`.
 *
 * `from` YATIRAN CURVE'dur ve tasinmasinin sebebi tam olarak sudur: ucretin
 * hangi launch'tan geldigi BASKA hicbir yerde yazili degildir. "Creator'in
 * launch basina kazanci" sorgusu (`fee_events.from_addr -> curve_state.curve
 * -> launches.token`) yalnizca bu alanla mumkundur.
 *
 * BIR ISLEMDE IKI `Deposited` OLABILIR AMA ZORUNLU DEGILDIR: creator'i sifir
 * olan bir curve TEK bir tane yayar (`zero_creator.json`). "Her islem iki
 * yatirim uretir" varsayan bir yol orada kirilir.
 */
export async function applyDepositedEvent(db: Queryable, event: DepositedEvent): Promise<number> {
  return applyFeeEvent(db, {
    kind: 'fee',
    feeKind: 'deposit',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    recipient: event.recipient,
    from: event.from,
    amountWei: event.amountWei,
  })
}

/** `Claimed(recipient, amount)`. `from` YOKTUR -- olay tasimaz, uydurulmaz. */
export async function applyClaimedEvent(db: Queryable, event: ClaimedEvent): Promise<number> {
  return applyFeeEvent(db, {
    kind: 'fee',
    feeKind: 'claim',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    recipient: event.recipient,
    from: null,
    amountWei: event.amountWei,
  })
}
