import type { Queryable } from '@arcpad/db'
import { applyTransfer } from '@arcpad/db'
import { isForbiddenEmitter, ZERO_ADDRESS } from '../arc'
import { ForbiddenEmitter, type TransferEvent } from '../logs'

/**
 * `Transfer` UYGULAYICISI -- `token_transfers` ve `holders`.
 *
 * EXACTLY-ONCE BURADA BIR ANAHTAR HAKKINDA AKIL YURUTMEYLE SAGLANMAZ.
 * `holders.balance_tok` bir DELTA'dir: ayni `Transfer` iki kez uygulanirsa
 * bakiye iki kat kayar ve HICBIR birincil anahtar bunu engellemez. Engelleyen
 * tek sey, deltanin `token_transfers`e bir satirin GERCEKTEN eklenmis olmasina
 * bagli olmasidir (`@arcpad/db`'nin CTE'si). Bu, `apply-transfer.test.ts`'te
 * NEGATIF KONTROLLE olculur: defter satiri SILINIR ve ayni cagrinin bu kez
 * yazdigi, bakiyeyi tam olarak transfer tutari kadar oynattigi gosterilir.
 */

/**
 * IKINCI DUVAR.
 *
 * Birincisi cozme yolundadir (`logs.ts`), yani zincirden gelen bir 7708 logu
 * buraya ZATEN ulasamaz. Bu kontrol, olayi elle kuran bir cagirani (Task 11'in
 * yeniden isleme yollari, testler, gelecekteki bir backfill script'i) kapsar --
 * ve maliyeti bir kume sorgusudur.
 *
 * `token_transfers.token` yabanci anahtari ucuncu duvardir. Uc kat, cunku
 * yanlis cevap SESSIZDIR: 6 decimal'lik bir tutar 18 decimal'lik bir bakiyeye
 * eklenirse kimse gurultu duymaz.
 */
export async function applyTransferEvent(db: Queryable, event: TransferEvent): Promise<number> {
  if (isForbiddenEmitter(event.token)) throw new ForbiddenEmitter(event.token)
  return applyTransfer(db, {
    kind: 'transfer',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    token: event.token,
    // MINT: `from` = 0x0. Sifir adres icin `holders` satiri ACILMAZ -- acilsa
    // bakiyesi negatif olur ve CHECK patlardi. Ayni kural `to` = 0x0 icin de
    // yazilidir ama o yol ZINCIRDE ULASILAMAZDIR: OZ'un ERC20'si sifir alicida
    // `ERC20InvalidReceiver` ile revert eder, yani `LaunchToken` YAKILAMAZ.
    // Ulasilamazligi kayda geciyoruz; uydurma bir gerekce yazmiyoruz.
    from: event.from,
    to: event.to,
    amountTok: event.amountTok,
  })
}

export { ZERO_ADDRESS }
