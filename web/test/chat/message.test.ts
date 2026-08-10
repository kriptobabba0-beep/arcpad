import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  CHAT_MESSAGE_HEADER,
  CHAT_SIGNATURE_SKEW_SECONDS,
  CHAT_SIGNATURE_TTL_SECONDS,
  type ChatPayload,
  chatMessageText,
  chatSignatureMatches,
  checkIssuedAt,
  recoverChatAuthor,
} from '@/lib/chatMessage'

/**
 * ==========================================================================
 *  KIMLIK DOGRULAMA, GERCEK ANAHTARLARLA
 * ==========================================================================
 *
 * Burada hicbir sey sahtelenmiyor: `viem`in kendi `privateKeyToAccount`i
 * gercek bir secp256k1 anahtari uretiyor, gercek bir EIP-191 imzasi atiyor ve
 * `recoverChatAuthor` onu gercekten kurtariyor. Bir sahte imzalayici, tam da
 * bu dosyanin olcmesi gereken seyi -- kurtarmanin metne BAGLI oldugunu --
 * olcemezdi.
 */

// Deterministik test anahtarlari. Zincirde hicbir sey tutmuyorlar.
const ALICE_KEY = `0x${'11'.repeat(32)}` as const
const MALLORY_KEY = `0x${'22'.repeat(32)}` as const
const alice = privateKeyToAccount(ALICE_KEY)
const mallory = privateKeyToAccount(MALLORY_KEY)

const TOKEN = '0x085c926e24ed64bb045e67d26d9e76e5730c21b3'
const NONCE = `0x${'ab'.repeat(32)}`
const ISSUED = '2026-08-10T00:00:00.000Z'

function payload(overrides: Partial<ChatPayload> = {}): ChatPayload {
  return {
    chainId: 5_042_001 + 1,
    token: TOKEN,
    author: alice.address.toLowerCase(),
    nonce: NONCE,
    issuedAt: ISSUED,
    body: 'gm',
    ...overrides,
  }
}

async function sign(p: ChatPayload, key = alice): Promise<string> {
  return key.signMessage({ message: chatMessageText(p) })
}

describe('imzalanan metin', () => {
  it('alanlarin hepsini ve `body`yi EN SONDA tasir', () => {
    const text = chatMessageText(payload())
    expect(text.split('\n')).toEqual([
      CHAT_MESSAGE_HEADER,
      'chain: 5042002',
      `token: ${TOKEN}`,
      `author: ${alice.address.toLowerCase()}`,
      `nonce: ${NONCE}`,
      `issued: ${ISSUED}`,
      'body:',
      'gm',
    ])
  })

  it('adresler KUCUK HARFE indirilir -- iki taraf ayni metni uretsin diye', () => {
    const upper = chatMessageText(payload({ author: alice.address.toUpperCase() }))
    expect(upper).toBe(chatMessageText(payload()))
  })

  /**
   * ==========================================================================
   *  ESLEME BIREBIR: IKI FARKLI ALAN KUMESI AYNI METNI URETEMEZ
   * ==========================================================================
   *
   * Sunucu metni ALANLARDAN kurar ve imzanin ondan `author`i verdigini
   * kontrol eder. Tehlike, iki farkli kumenin AYNI metni vermesidir -- o zaman
   * bir kumeye alinan imza otekine de gecerdi.
   *
   * `body` EN SONDA oldugu icin bu MUMKUN DEGILDIR: onceki alanlarin hepsi
   * sabit bicimlidir, yani govdeye ne yazilirsa yazilsin bir onceki alanin
   * sinirini kaydiramaz. Asagidaki test tam olarak o saldiriyi kurar: govdenin
   * ICINE sahte bir `nonce:`/`issued:` bloku yazar ve metinlerin AYRISTIGINI
   * gosterir.
   */
  it('govdeye baslik enjekte etmek AYNI metni URETEMEZ', () => {
    const honest = payload({ body: 'gm' })
    const attack = payload({
      nonce: `0x${'cd'.repeat(32)}`,
      body: `gm\nnonce: ${NONCE}\nissued: ${ISSUED}\nbody:\ngm`,
    })
    expect(chatMessageText(attack)).not.toBe(chatMessageText(honest))
  })

  it('her alanin degistirilmesi metni degistirir', () => {
    const base = chatMessageText(payload())
    const mutations: Partial<ChatPayload>[] = [
      { chainId: 1 },
      { token: `0x${'99'.repeat(20)}` },
      { author: mallory.address.toLowerCase() },
      { nonce: `0x${'cd'.repeat(32)}` },
      { issuedAt: '2026-08-10T00:00:01.000Z' },
      { body: 'gn' },
    ]
    for (const mutation of mutations) {
      expect(chatMessageText(payload(mutation)), JSON.stringify(mutation)).not.toBe(base)
    }
  })
})

describe('imza -> yazar', () => {
  it('gercek bir imza gercek adresi verir', async () => {
    const p = payload()
    expect(await recoverChatAuthor(p, await sign(p))).toBe(alice.address.toLowerCase())
    expect(await chatSignatureMatches(p, await sign(p))).toBe(true)
  })

  /**
   * BASKASININ ADINA YAZMAK. Mallory kendi anahtariyla imzalar ama govdeye
   * `author: alice` yazar. Metin Alice'in adresini icerdigi icin imza
   * MALLORY'nin adresini verir ve esitlik tutmaz.
   */
  it('BASKASININ ADINA yazmak tutmaz', async () => {
    const p = payload({ author: alice.address.toLowerCase() })
    const forged = await sign(p, mallory)
    expect(await recoverChatAuthor(p, forged)).toBe(mallory.address.toLowerCase())
    expect(await chatSignatureMatches(p, forged)).toBe(false)
  })

  it('GOVDE degistirilirse imza dusUr -- yani "duzeltilmis" bir govde saklanamaz', async () => {
    const signed = payload({ body: 'buy at evil.com' })
    const signature = await sign(signed)
    const stripped = payload({ body: 'buy at ' })
    expect(await chatSignatureMatches(signed, signature)).toBe(true)
    expect(await chatSignatureMatches(stripped, signature)).toBe(false)
  })

  it('BASKA BIR TOKEN altina tasinmis imza tutmaz', async () => {
    const p = payload()
    const signature = await sign(p)
    expect(await chatSignatureMatches({ ...p, token: `0x${'77'.repeat(20)}` }, signature)).toBe(false)
  })

  it('BASKA BIR ZINCIRDE uretilmis imza tutmaz', async () => {
    const p = payload({ chainId: 1 })
    const signature = await sign(p)
    expect(await chatSignatureMatches({ ...p, chainId: 5_042_002 }, signature)).toBe(false)
  })

  it('bicimsiz imza ATMAZ, `null` doner', async () => {
    const p = payload()
    for (const bad of ['', '0x', 'not-a-signature', `0x${'ff'.repeat(64)}`]) {
      expect(await recoverChatAuthor(p, bad), bad).toBeNull()
    }
  })

  /**
   * KURTARMA AG GORMEZ, ve bu rotanin guvenlik iddiasinin tasiyicisi.
   *
   * `fetch` GLOBAL OLARAK atacak sekilde degistiriliyor: kurtarma bir HTTP
   * cagrisi yapsaydi test ATARDI. `verifyMessage` (viem'in client eylemi)
   * secilseydi EIP-1271 icin bir `eth_call` yapardi ve bu test kirilirdi --
   * yani secim burada OLCULUYOR, yorumda iddia edilmiyor.
   */
  it('kurtarma HICBIR ag cagrisi yapmaz', async () => {
    const original = globalThis.fetch
    let called = 0
    globalThis.fetch = (() => {
      called += 1
      throw new Error('recovery must not touch the network')
    }) as typeof fetch
    try {
      const p = payload()
      expect(await chatSignatureMatches(p, await sign(p))).toBe(true)
    } finally {
      globalThis.fetch = original
    }
    expect(called).toBe(0)
  })
})

describe('`issued` penceresi', () => {
  const NOW = Date.parse('2026-08-10T12:00:00.000Z')
  const at = (offsetSeconds: number) => new Date(NOW - offsetSeconds * 1000).toISOString()

  it('taze bir damga gecer', () => {
    expect(checkIssuedAt(at(0), NOW)).toBe('ok')
    expect(checkIssuedAt(at(CHAT_SIGNATURE_TTL_SECONDS), NOW)).toBe('ok')
  })

  it('TTL`in bir saniye otesi DUSER -- tekrar oynatmanin ust siniri budur', () => {
    expect(checkIssuedAt(at(CHAT_SIGNATURE_TTL_SECONDS + 1), NOW)).toBe('expired')
    // Bir yil once imzalanmis, mukemmel gecerli bir imza da duser.
    expect(checkIssuedAt('2025-08-10T12:00:00.000Z', NOW)).toBe('expired')
  })

  it('GELECEKTEN gelen bir damga sinirli bir toleransla kabul edilir', () => {
    expect(checkIssuedAt(at(-CHAT_SIGNATURE_SKEW_SECONDS), NOW)).toBe('ok')
    expect(checkIssuedAt(at(-CHAT_SIGNATURE_SKEW_SECONDS - 1), NOW)).toBe('fromTheFuture')
    // Cok ileri bir damga, imzayi sonsuza kadar gecerli kilmanin en kolay
    // yoludur; bu yuzden tolerans bir DAKIKADIR, bir gun degil.
    expect(checkIssuedAt('2030-01-01T00:00:00.000Z', NOW)).toBe('fromTheFuture')
  })

  it('TEK BICIM: milisaniyesiz ya da yerel saatli damga REDDEDILIR', () => {
    // Iki bicim iki METIN demektir ve imza metne baglidir; tek bicim
    // dayatmak, "gonderdim ama imza tutmadi" sinifini kokten kapatir.
    expect(checkIssuedAt('2026-08-10T12:00:00Z', NOW)).toBe('malformed')
    expect(checkIssuedAt('2026-08-10T12:00:00.000+03:00', NOW)).toBe('malformed')
    expect(checkIssuedAt('not a date', NOW)).toBe('malformed')
    expect(checkIssuedAt('', NOW)).toBe('malformed')
  })

  it('`toISOString()` tam olarak KABUL EDILEN bicimi uretir', () => {
    // Istemci bu cagriyi yapiyor (`useChatPost`). Bicimin ayrisamayacagini
    // olcmek, "yalnizca uretimde kirilan" bir bicim hatasini kapatir.
    expect(checkIssuedAt(new Date(NOW).toISOString(), NOW)).toBe('ok')
  })
})
