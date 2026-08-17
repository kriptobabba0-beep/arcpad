import { beforeAll, describe, expect, it } from 'vitest'
import { applyLaunch } from '../src/apply'
import { fromHexBytes, lower, lowerHash32, pgSafeText, toHexBytes } from '../src/hex'
import { pool, resetSchema } from './setup'
import { addr, hash32, LAUNCH } from './fixtures'
import { toSeq } from '../src/seq'

interface PgError extends Error {
  code?: string
  constraint?: string
}

async function failure(fn: () => Promise<unknown>): Promise<PgError> {
  try {
    await fn()
  } catch (error) {
    return error as PgError
  }
  throw new Error('beklenen hata olusmadi')
}

const NUL = '\u0000'
const LONE_HIGH = '\uD800'
const LONE_LOW = '\uDC00'
const FFFD = '\uFFFD'

/**
 * ZINCIR-MESRU AMA POSTGRES'E GIREMEYEN METIN.
 *
 * `LaunchFactory.launch` yalnizca "bos degil"e bakar, `LaunchToken`'in
 * constructor'i yalnizca uzunluk tavanina (32/13/200 BYTE, dogrulandi:
 * contracts/src/LaunchToken.sol @26ce330 satir 31-33, 103-105). ICERIGE
 * hicbiri bakmaz -- Solidity `string`'i dogrulanmamis bayttir.
 *
 * Postgres'in `text` tipi ise U+0000'i ve gecersiz UTF-8'i KABUL ETMEZ. Bu,
 * CHECK kisitlariyla yakalanamayan bir arizadir cunku deger sunucuya hic
 * ulasmaz; yakalanmazsa ingest islemi geri alinir ve indexer o blokta sonsuza
 * kadar takilir.
 */
describe('metin: zincirden gelen sey Postgres text ine girebilmeli', () => {
  beforeAll(resetSchema)

  it('OLCUM: temizlenmemis U+0000 gercekten reddediliyor', async () => {
    await expect(pool.query('SELECT $1::text', [`a${NUL}b`])).rejects.toThrow()
  })

  it('OLCUM: yalniz kalan vekili SURUCU zaten U+FFFD ye ceviriyor', async () => {
    // VARSAYIM YANLIS CIKTI, olcum duzeltti. JS dizgeleri yarim vekil
    // tasiyabilir ve bunun gecersiz UTF-8 uretmesi BEKLENIYORDU; ama Node'un
    // UTF-8 kodlayicisi yalniz vekilleri kendisi U+FFFD ile degistiriyor, yani
    // Postgres'e gecersiz bayt HIC ULASMIYOR. Tek gercek tehlike U+0000.
    //
    // `pgSafeText` yine de vekilleri normalize eder ve BUNUN GEREKCESI
    // BASKADIR: temizlemezsek yazilan deger surucunun kodlayicisina BAGLI olur
    // ve `length()` CHECK'i istemci tarafinda hesaplananla ayrisabilir.
    // Temizlemek sonucu SURUCUDEN BAGIMSIZ ve ongorulebilir yapar.
    const { rows } = await pool.query<{ v: string }>('SELECT $1::text AS v', [`a${LONE_HIGH}b`])
    expect(rows[0]?.v).toBe(`a${FFFD}b`)
  })

  it('pgSafeText ikisini de yazilabilir hale getirir', async () => {
    expect(pgSafeText(`a${NUL}b`)).toBe(`a${FFFD}b`)
    expect(pgSafeText(`a${LONE_HIGH}b`)).toBe(`a${FFFD}b`)
    expect(pgSafeText(`a${LONE_LOW}b`)).toBe(`a${FFFD}b`)
    const { rows } = await pool.query<{ v: string }>('SELECT $1::text AS v', [
      pgSafeText(`a${NUL}b`),
    ])
    expect(rows[0]?.v).toBe(`a${FFFD}b`)
  })

  it('GECERLI metni bozmaz (temizleyici fazla temizlemiyor)', () => {
    expect(pgSafeText('Arc Pad')).toBe('Arc Pad')
    // Tam vekil CIFTI gecerlidir ve oldugu gibi kalir.
    expect(pgSafeText('\uD83D\uDE80')).toBe('\uD83D\uDE80')
    expect(pgSafeText(FFFD)).toBe(FFFD)
  })

  it('uzunluk DEGISMEZ, yani length() CHECK i temizlemeden etkilenmez', () => {
    const name = `x${NUL}${'y'.repeat(30)}`
    expect(name).toHaveLength(32)
    expect(pgSafeText(name)).toHaveLength(32)
  })

  it('applyLaunch dusman metni temizleyerek yazar (ingest kilitlenmez)', async () => {
    const hostile = {
      ...LAUNCH,
      eventSeq: toSeq(54_000_002n, 0),
      token: addr(0x7001),
      curve: addr(0xc001),
      txHash: hash32(0xaaa1),
      salt: hash32(0x5a18),
      name: pgSafeText(`bad${NUL}name`),
      symbol: pgSafeText(`B${LONE_HIGH}D`),
      uri: pgSafeText(`ipfs://${NUL}`),
      // ZINCIRDEKI HAM BAYTLAR -- temizlenmemis. Gercek ingest bunlari logun
      // COZULMEMIS `data` alanindan alir; burada dogrudan yaziliyorlar.
      nameHex: toHexBytes(`bad${NUL}name`),
      symbolHex: '0x42ffd80044',
      uriHex: toHexBytes(`ipfs://${NUL}`),
    }
    await expect(applyLaunch(pool, hostile)).resolves.toBe(1)
    const { rows } = await pool.query<{ name: string; symbol: string; uri: string }>(
      'SELECT name, symbol, uri FROM launches WHERE token = $1',
      [hostile.token],
    )
    expect(rows[0]).toEqual({
      name: `bad${FFFD}name`,
      symbol: `B${FFFD}D`,
      uri: `ipfs://${FFFD}`,
    })
  })

  // ---------------------------------------------------------------
  // PROVENANCE: `pgSafeText` COKA-BIRDIR, ham baytlar bu yuzden saklanir.
  // ---------------------------------------------------------------
  it('gosterim metni COKA-BIR duser ama ham baytlar AYRISIR', async () => {
    // Zincirdeki IKI AYRI isim ayni gosterim metnine duser. Token adresi
    // CREATE2 ile HAM baytlardan turetildigi icin, yalnizca gosterim metnini
    // saklayan bir veritabani bu iki launch'i BIRBIRINDEN AYIRAMAZ ve
    // hicbirinin canonicity'sini yeniden hesaplayamaz.
    const a = `x${NUL}y`
    const b = `x${FFFD}y`
    expect(a).not.toBe(b)
    expect(pgSafeText(a)).toBe(pgSafeText(b)) // <-- kaybin kendisi
    expect(toHexBytes(a)).not.toBe(toHexBytes(b)) // <-- kurtarilan sey

    for (const [i, raw] of [a, b].entries()) {
      await applyLaunch(pool, {
        ...LAUNCH,
        eventSeq: toSeq(54_000_010n + BigInt(i), 0),
        token: addr(0x7010 + i),
        curve: addr(0xc010 + i),
        txHash: hash32(0xbb00 + i),
        salt: hash32(0x5b00 + i),
        name: pgSafeText(raw),
        nameHex: toHexBytes(raw),
      })
    }

    const { rows } = await pool.query<{ name: string; name_hex: string }>(
      'SELECT name, name_hex FROM launches WHERE token IN ($1, $2) ORDER BY token',
      [addr(0x7010), addr(0x7011)],
    )
    expect(rows).toHaveLength(2)
    // Gosterim metinleri AYNI...
    expect(rows[0]?.name).toBe(rows[1]?.name)
    // ...ham baytlar FARKLI, ve her biri zincirdeki degeri TAM olarak verir.
    expect(rows[0]?.name_hex).not.toBe(rows[1]?.name_hex)
    expect(fromHexBytes(rows[0]!.name_hex)).toBe(a)
    expect(fromHexBytes(rows[1]!.name_hex)).toBe(b)
  })

  it('ham bayt sutunlari ZINCIRIN bayt tavanini zorlar (karakter degil BAYT)', async () => {
    // Gosterim sutunlari `length()` ile KARAKTER sayar; `*_hex` desenleri BAYT
    // sayar. Zincir de bayt sayar (LaunchToken.sol:103-105 @26ce330), yani
    // gercek kisit burada. 32 emoji = 32 karakter ama 128 bayt: gosterim
    // kontrolunden gecer, bayt kontrolunden GECMEZ -- ve zincir de onu
    // NameTooLong ile reddederdi.
    const emoji = '🚀'.repeat(32)
    expect(emoji).toHaveLength(64) // 32 kod noktasi, 64 kod birimi
    expect(toHexBytes(emoji)).toHaveLength(2 + 128 * 2)
    const e = await failure(() =>
      applyLaunch(pool, {
        ...LAUNCH,
        eventSeq: toSeq(54_000_020n, 0),
        token: addr(0x7020),
        curve: addr(0xc020),
        txHash: hash32(0xcc01),
        salt: hash32(0x5c01),
        name: '🚀'.repeat(16), // 16 kod noktasi -> length() 32, gecer
        nameHex: toHexBytes(emoji), // 128 bayt -> GECMEZ
      }),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('launches_name_hex_check')
  })

  it('bos ham bayt reddedilir (zincir bos isme izin vermez)', async () => {
    const e = await failure(() =>
      applyLaunch(pool, {
        ...LAUNCH,
        eventSeq: toSeq(54_000_021n, 0),
        token: addr(0x7021),
        curve: addr(0xc021),
        txHash: hash32(0xcc02),
        salt: hash32(0x5c02),
        nameHex: '0x',
      }),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('launches_name_hex_check')
  })

  it('bos URI KABUL edilir (zincir uri icin bos kontrolu yapmaz)', async () => {
    await expect(
      applyLaunch(pool, {
        ...LAUNCH,
        eventSeq: toSeq(54_000_022n, 0),
        token: addr(0x7022),
        curve: addr(0xc022),
        txHash: hash32(0xcc03),
        salt: hash32(0x5c03),
        uri: '',
        uriHex: '0x',
      }),
    ).resolves.toBe(1)
  })

  it('zincirin TAM TAVANINDAKI metin semaya sigar (CHECK bir liveness hatasi degil)', async () => {
    // 32 / 13 / 200: zincirin izin verdigi EN UZUN degerler. Bunlar
    // reddedilseydi mesru bir launch indexer'i kilitlerdi.
    const maxed = {
      ...LAUNCH,
      eventSeq: toSeq(54_000_003n, 0),
      token: addr(0x7002),
      curve: addr(0xc002),
      txHash: hash32(0xaaa2),
      salt: hash32(0x5a19),
      name: 'n'.repeat(32),
      symbol: 's'.repeat(13),
      uri: 'u'.repeat(200),
    }
    await expect(applyLaunch(pool, maxed)).resolves.toBe(1)
  })

  it('bir uzun metin reddedilir (CHECK gercekten bagli)', async () => {
    const tooLong = {
      ...LAUNCH,
      eventSeq: toSeq(54_000_004n, 0),
      token: addr(0x7003),
      curve: addr(0xc003),
      txHash: hash32(0xaaa3),
      salt: hash32(0x5a1a),
      name: 'n'.repeat(33),
    }
    await expect(applyLaunch(pool, tooLong)).rejects.toThrow()
  })
})

describe('lower / lowerHash32', () => {
  it('checksum li adresi kucuk harfe indirir', () => {
    expect(lower('0xAbCdEf0123456789AbCdEf0123456789AbCdEf01')).toBe(
      '0xabcdef0123456789abcdef0123456789abcdef01',
    )
  })

  it('adres olmayani reddeder -- kirpmaz, doldurmaz', () => {
    expect(() => lower('0x123')).toThrow(RangeError)
    expect(() => lower('abcdef0123456789abcdef0123456789abcdef01')).toThrow(RangeError)
    // 41 hane: bir karakter fazlasi da adres degildir.
    expect(() => lower('0xabcdef0123456789abcdef0123456789abcdef012')).toThrow(RangeError)
  })

  it('32 baytlik hash i kucuk harfe indirir ve uzunlugu zorlar', () => {
    expect(lowerHash32(`0x${'A'.repeat(64)}`)).toBe(`0x${'a'.repeat(64)}`)
    expect(() => lowerHash32(`0x${'a'.repeat(63)}`)).toThrow(RangeError)
    expect(() => lowerHash32(`0x${'a'.repeat(65)}`)).toThrow(RangeError)
  })
})
