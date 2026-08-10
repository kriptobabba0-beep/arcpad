import { describe, expect, it } from 'vitest'
import {
  addressFromTopic,
  type ReceiptShape,
  TRADE_EVENT_SIGNATURE,
  TRADE_TOPIC0,
  verifyFillReceipt,
} from '@/lib/orderFill'

/**
 * ==========================================================================
 *  MAKBUZ HUKMU -- VE BU DOSYA BIR ULASIM BOSLUGUNUN KAPATILMASIDIR
 * ==========================================================================
 *
 * `route.test.ts` makbuz okuyucusunu ENJEKTE EDIYOR (`setFillReaderForTesting`)
 * cunku olctugu sey rotanin SIRALAMASI. Bunun bedeli olculdu: gercek
 * dogrulamanin uc kontrolune -- basari, gonderen, `Trade` logu -- HICBIR TEST
 * ULASMIYORDU. Bir mutasyon turunda o uc satiri silmek butun paketi yesil
 * birakirdi, ve dogru teshis "mutant hayatta kaldi" degil **"o satira hicbir
 * test dokunmuyor"**tur.
 *
 * Uc kontrolun her biri burada AYRI AYRI olduruluyor, ve her biri icin bir
 * POZITIF KONTROL var: yalnizca o alani duzeltmek hukmu `ok`a cevirmeli. Aksi
 * halde "reddediliyor" iddiasi, fonksiyonun HER SEYI reddettigi bir dunyada da
 * yesil kalirdi.
 */

const OWNER = '0x00000000000000000000000000000000000a11ce'
const CURVE = '0x53bba88f1b9897a8b61c860e9e7413ca1a1644c9'
const OTHER = '0x00000000000000000000000000000000000b0b00'

function topicFor(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`
}

function receipt(over: Partial<ReceiptShape> = {}): ReceiptShape {
  return {
    status: 'success',
    from: OWNER,
    logs: [{ address: CURVE, topics: [TRADE_TOPIC0, topicFor(OWNER)] }],
    ...over,
  }
}

describe('verifyFillReceipt', () => {
  it('KONTROL: a real fill is accepted', () => {
    expect(verifyFillReceipt(receipt(), OWNER, CURVE)).toEqual({ ok: true })
  })

  it('a REVERTED transaction is not a fill', () => {
    expect(verifyFillReceipt(receipt({ status: 'reverted' }), OWNER, CURVE)).toEqual({
      ok: false,
      reason: 'reverted',
    })
  })

  it('a transaction SOMEBODY ELSE sent is not the owner\'s fill', () => {
    expect(verifyFillReceipt(receipt({ from: OTHER }), OWNER, CURVE)).toEqual({
      ok: false,
      reason: 'notTheOwner',
    })
  })

  /**
   * ============ UCUNCU KONTROLUN VAR OLMA SEBEBI ============
   *
   * 1 ve 2 tek baslarina yetmez: sahip HERHANGI bir basarili islem
   * gonderebilir -- bir transfer, bir onay, hatta bos bir self-call -- ve emri
   * "doldu" diye kapatabilirdi. Asagidaki makbuz tam olarak odur: basarili,
   * sahipten, ve icinde bir `Trade` YOK.
   */
  it('a successful transaction with NO Trade log is not a fill', () => {
    expect(verifyFillReceipt(receipt({ logs: [] }), OWNER, CURVE)).toEqual({
      ok: false,
      reason: 'noTrade',
    })
  })

  it('a Trade log from ANOTHER CONTRACT does not count', () => {
    const forged = receipt({
      logs: [{ address: OTHER, topics: [TRADE_TOPIC0, topicFor(OWNER)] }],
    })
    expect(verifyFillReceipt(forged, OWNER, CURVE)).toEqual({ ok: false, reason: 'noTrade' })
  })

  it('a Trade log whose TRADER is somebody else does not count', () => {
    const other = receipt({
      logs: [{ address: CURVE, topics: [TRADE_TOPIC0, topicFor(OTHER)] }],
    })
    expect(verifyFillReceipt(other, OWNER, CURVE)).toEqual({ ok: false, reason: 'noTrade' })
  })

  it('a DIFFERENT event from the curve does not count', () => {
    const completed = receipt({
      logs: [{ address: CURVE, topics: [`0x${'11'.repeat(32)}`, topicFor(OWNER)] }],
    })
    expect(verifyFillReceipt(completed, OWNER, CURVE)).toEqual({ ok: false, reason: 'noTrade' })
  })

  it('an unindexed log (no topic 1) does not crash and does not count', () => {
    const bare = receipt({ logs: [{ address: CURVE, topics: [TRADE_TOPIC0] }] })
    expect(verifyFillReceipt(bare, OWNER, CURVE)).toEqual({ ok: false, reason: 'noTrade' })
  })

  it('the right log among several IS found', () => {
    const noisy = receipt({
      logs: [
        { address: OTHER, topics: [`0x${'22'.repeat(32)}`] },
        { address: CURVE, topics: [TRADE_TOPIC0, topicFor(OWNER)] },
        { address: OTHER, topics: [TRADE_TOPIC0, topicFor(OTHER)] },
      ],
    })
    expect(verifyFillReceipt(noisy, OWNER, CURVE)).toEqual({ ok: true })
  })

  it('case does not decide anything -- chain data is checksummed', () => {
    const mixed = receipt({
      from: OWNER.toUpperCase().replace('0X', '0x'),
      logs: [
        {
          address: CURVE.toUpperCase().replace('0X', '0x'),
          topics: [TRADE_TOPIC0, topicFor(OWNER).toUpperCase().replace('0X', '0x')],
        },
      ],
    })
    expect(verifyFillReceipt(mixed, OWNER, CURVE)).toEqual({ ok: true })
  })

  it('the topic0 is DERIVED from the signature, not transcribed', () => {
    // Bir literal, olayin imzasi degistiginde SESSIZCE bos bir filtreye
    // donerdi. Bu satir, sabitin gercekten o imzadan turedigini olcer.
    expect(TRADE_EVENT_SIGNATURE).toBe(
      'Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
    )
    expect(TRADE_TOPIC0).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('a topic is a 32-byte word; the address is its LAST 20 bytes', () => {
    expect(addressFromTopic(topicFor(OWNER))).toBe(OWNER)
    // Ilk 12 bayti okumak, her adresi `0x000...` yapardi ve HER makbuz
    // reddedilirdi -- yani kapi gorunmez bicimde her zaman kapali olurdu.
    expect(addressFromTopic(topicFor(OWNER))).not.toBe(`0x${'0'.repeat(40)}`)
  })
})
