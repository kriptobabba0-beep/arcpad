import { createPublicClient, http, keccak256, toHex } from 'viem'
import { getWebConfig } from './addresses'
import type { HexAddress } from '@/components/read/types'

/**
 * ==========================================================================
 *  "DOLDU" BIR IDDIA DEGIL, BIR MAKBUZ DOGRULAMASIDIR
 * ==========================================================================
 *
 * Bir emri kim doldurur? SAHIBI, kendi cuzdanindan -- cunku baska kimse
 * yapamaz (`keeper/test/localchain/custodyProof.ts`, 21/21, canli kontratlar).
 * Yani `filled` durumunu yazan sey bir istemcinin sozudur, ve bir istemcinin
 * sozu bu depoda hicbir zaman tek basina bir kayit olamaz.
 *
 * Bu dosya o sozu OLCUME cevirir. Istemci bir islem hash'i gonderir; biz
 * makbuzu okur ve UC seyi birden isteriz:
 *
 *   1. islem BASARILI olmali (`status === 'success'`),
 *   2. gonderen SAHIP olmali (`receipt.from === owner`),
 *   3. makbuzda, EMRIN CURVE'UNDEN cikan bir `Trade` logu olmali ve o logun
 *      `trader`i (topic 1, INDEKSLI) SAHIP olmali.
 *
 * 3. MADDE OLMADAN 1 VE 2 YETMEZ, ve neden yetmedigi somut: sahip herhangi
 * bir basarili islem gonderebilir -- bir transfer, bir onay, hatta bos bir
 * self-call -- ve emri "doldu" diye kapatabilirdi. Bu bir saldiri degil bir
 * KAYIT BOZULMASIDIR: emrin gecmisi, olmamis bir islemi gosterirdi.
 *
 * ==========================================================================
 *  NE DOGRULANMAZ, VE NEDEN
 * ==========================================================================
 *
 * MIKTARLAR DOGRULANMAZ. Logdaki `tokenAmount`in emrin `min_out_tok`una esit
 * ya da ondan buyuk oldugu KONTROL EDILMEZ, ve bunun sebebi kontrolun gereksiz
 * olmasi: doldurma islemi emrin KENDI slipaj sinirini calldata'da tasir, yani
 * daha kotu bir fiyattan dolmasi ZINCIRDE imkansizdir (`SlippageExceeded`).
 * Burada yeniden kontrol etmek, zincirin zaten uyguladigi bir kurali ikinci
 * kez -- ve bu sefer YANLIS OLABILECEK bicimde -- yazmak olurdu.
 *
 * Kullanicinin emri "doldu" diye isaretleyip aslinda DAHA KUCUK bir islem
 * yapmasi mumkundur. Bunun zarari kendisinedir ve emri de kapanir; koruma
 * altina alinmasi gereken bir baskasinin cikari yok.
 *
 * ==========================================================================
 *  MALIYET: ISTEK BASINA BIR JSON-RPC OBJESI
 * ==========================================================================
 *
 * `eth_getTransactionReceipt`, tek cagri, fan-out yok. Chat'in holder
 * okumasiyla ayni siniftadir ve Arc'in obje-sayan hiz sinirina (bir istekte
 * 20 obje `-32005`, 15 geciyor) tek basina yaklasamaz. Yeniden deneme
 * merdiveni YOK: kullaniciyi 9 saniye bekletip ayni hatayi vermek, hatayi
 * hemen vermekten kotudur.
 */

/**
 * `Trade(address indexed trader, bool, uint256, uint256, uint256, uint256,
 *        uint256, uint256, uint256, uint256)`
 *
 * SELECTOR ELLE DEGIL HESAPLANARAK. Bir literal, olayin imzasi degistiginde
 * SESSIZCE bos filtreye donerdi -- bu depoda `PoolSeeded`/`Graduated`
 * ayrimindan bilinen sekil. Imza dizesi burada duruyor ve `keccak256` onu her
 * yuklemede yeniden cozuyor.
 */
export const TRADE_EVENT_SIGNATURE =
  'Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)'
export const TRADE_TOPIC0 = keccak256(toHex(TRADE_EVENT_SIGNATURE))

export type FillReading =
  | { readonly ok: true }
  /** Makbuz okundu ve DOGRULAMADI. Kullaniciya soylenebilir bir sebep. */
  | { readonly ok: false; readonly reason: 'notFound' | 'reverted' | 'notTheOwner' | 'noTrade' }
  /** Okunamadi. Bu bir red DEGIL, bir bilinmezliktir -> 503. */
  | { readonly ok: false; readonly reason: 'unavailable' }

export interface FillReader {
  (input: {
    readonly txHash: string
    readonly owner: HexAddress
    readonly curve: HexAddress
  }): Promise<FillReading>
}

/** 32 baytlik bir adresi (log topic) 20 baytlik adrese indirir. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase()
}

export const readFillReceipt: FillReader = async ({ txHash, owner, curve }) => {
  const config = getWebConfig()
  const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
  let receipt
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
  } catch (error) {
    // viem bulunmayan bir makbuz icin FIRLATIR
    // (`TransactionReceiptNotFoundError`). "Henuz madenlenmedi" ile "RPC
    // dustu" AYNI SEY DEGILDIR ve ikisi ayri cevap almali: birincisi
    // kullanicinin biraz beklemesi gereken bir durum, ikincisi bizim
    // arizamiz.
    const name = error instanceof Error ? error.name : ''
    if (name === 'TransactionReceiptNotFoundError') return { ok: false, reason: 'notFound' }
    console.error('[orders] receipt read failed', error)
    return { ok: false, reason: 'unavailable' }
  }

  if (receipt.status !== 'success') return { ok: false, reason: 'reverted' }
  if (receipt.from.toLowerCase() !== owner.toLowerCase()) return { ok: false, reason: 'notTheOwner' }

  const traded = receipt.logs.some(
    (log) =>
      log.address.toLowerCase() === curve.toLowerCase() &&
      log.topics[0] === TRADE_TOPIC0 &&
      log.topics[1] !== undefined &&
      addressFromTopic(log.topics[1]) === owner.toLowerCase(),
  )
  if (!traded) return { ok: false, reason: 'noTrade' }
  return { ok: true }
}

/** Test dikisi -- `chatBalance.ts`in `setHolderReaderForTesting`i ile ayni sinifta. */
let override: FillReader | undefined

export function setFillReaderForTesting(replacement: FillReader | undefined): void {
  override = replacement
}

export function getFillReader(): FillReader {
  return override ?? readFillReceipt
}
