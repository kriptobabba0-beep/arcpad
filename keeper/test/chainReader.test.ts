import { describe, expect, it } from 'vitest'
import {
  ARC_RATE_LIMIT_RPC_CODE,
  isRateLimited,
  LIMIT_EXCEEDED_RPC_CODE,
  withRateLimitRetry,
} from '../src/chainReader'

/**
 * BU DOSYA CANLI BIR OLCUMDEN DOGDU.
 *
 * Uretim defteri ve canli factory ile calistirilan izleyici 50 saniyede 3 PAGE
 * ve SIFIR HEARTBEAT uretti; ilk poll `pendingGraduationTarget()` uzerinde
 * duser. Ucun dondurdugu sey:
 *
 *   HTTP 429 + {"jsonrpc":"2.0","error":{"code":-32011,"message":"request limit reached"}}
 *
 * viem bunu `RpcRequestError(code -32011)` yapar ve kendi `shouldRetry`si
 * -32011'i TANIMAZ, dolayisiyla `retryCount: 3` varsayilani HIC uygulanmaz.
 * Asagidaki testler tam olarak o hatanin SEKLINI kullanir.
 */

/**
 * viem'in `ContractFunctionExecutionError` -> `RpcRequestError` sarmalamasi.
 *
 * KOD BURADA LITERAL YAZILIR, `ARC_RATE_LIMIT_RPC_CODE` SABITINDEN OKUNMAZ.
 * Ilk hali sabiti kullaniyordu ve olculdu: sabiti -99999 yapan mutant
 * HAYATTA KALDI, cunku fixture da onunla birlikte mutasyona ugruyordu --
 * test kendisinin sahtesiydi. Deponun besinci adlandirilmis hata sekli.
 * Sayi, canli Arc testnet'in 2026-08-01'de dondurdugu govdedendir:
 *
 *   {"jsonrpc":"2.0","id":7,"error":{"code":-32011,"message":"request limit reached"}}
 */
const OBSERVED_ARC_CODE = -32011

/** @param withText Metin eslesmesini de acar. Varsayilan KAPALI: kod yolu YALNIZ. */
function wrappedArcRateLimit(withText = false): Error {
  const inner = Object.assign(new Error('RPC Request failed.'), {
    name: 'RpcRequestError',
    code: OBSERVED_ARC_CODE,
    ...(withText ? { details: 'request limit reached' } : {}),
  })
  return Object.assign(new Error('...'), {
    name: 'ContractFunctionExecutionError',
    cause: inner,
  })
}

describe('isRateLimited', () => {
  it('sabit, canli ucun DONDURDUGU sayidir', () => {
    // Bagimsiz pin. Sabit kayarsa metin yolu arizayi ortebilir, o yuzden
    // sayinin kendisi ayrica dogrulanir.
    expect(ARC_RATE_LIMIT_RPC_CODE).toBe(OBSERVED_ARC_CODE)
    expect(LIMIT_EXCEEDED_RPC_CODE).toBe(-32005)
  })

  it("Arc'in -32011'ini SARMALANMIS halde, METIN OLMADAN tanir", () => {
    // `details` YOK: yalnizca sayisal kod yolu sinaniyor. Metin de olsaydi
    // sabiti bozan bir mutant yine gecerdi.
    expect(isRateLimited(wrappedArcRateLimit())).toBe(true)
  })

  it('ciplak -32011, -32005 ve HTTP 429 durumunu tanir', () => {
    expect(isRateLimited({ code: OBSERVED_ARC_CODE })).toBe(true)
    expect(isRateLimited({ code: -32005 })).toBe(true)
    expect(isRateLimited({ status: 429 })).toBe(true)
  })

  it('kod kaybolsa bile ucun METNINI yakalar', () => {
    expect(isRateLimited(new Error('request limit reached'))).toBe(true)
    // Ve kod yolu metinden BAGIMSIZ olarak calisir; ikisi ayri savunmadir.
    expect(isRateLimited({ code: OBSERVED_ARC_CODE, message: 'nothing familiar here' })).toBe(true)
  })

  it('BASKA HICBIR HATAYI hiz siniri saymaz', () => {
    expect(isRateLimited(new Error('execution reverted'))).toBe(false)
    // -32000 execution reverted, -32602 invalid params: ikisi de yeniden
    // denenirse gercek bir ariza GECIKMELI raporlanir.
    expect(isRateLimited({ code: -32000, message: 'execution reverted' })).toBe(false)
    expect(isRateLimited({ code: -32602 })).toBe(false)
    expect(isRateLimited(undefined)).toBe(false)
    expect(isRateLimited(null)).toBe(false)
  })

  it('DONGUSEL bir cause zincirinde ASILMAZ', () => {
    const a: { cause?: unknown; code?: number } = {}
    const b: { cause?: unknown } = { cause: a }
    a.cause = b
    expect(isRateLimited(a)).toBe(false)
  })
})

describe('withRateLimitRetry', () => {
  const noSleep = (): Promise<void> => Promise.resolve()

  it('hiz siniri sonrasi BASARILI olan cagriyi dondurur', async () => {
    let calls = 0
    const value = await withRateLimitRetry(
      () => {
        calls += 1
        if (calls < 3) return Promise.reject(wrappedArcRateLimit())
        return Promise.resolve('ok')
      },
      { sleep: noSleep, random: () => 0.5 },
    )
    expect(value).toBe('ok')
    expect(calls).toBe(3)
  })

  it('HIZ SINIRI OLMAYAN hatayi ANINDA, SARMALAMADAN yukari verir', async () => {
    let calls = 0
    const boom = new Error('execution reverted')
    await expect(
      withRateLimitRetry(
        () => {
          calls += 1
          return Promise.reject(boom)
        },
        { sleep: noSleep },
      ),
    ).rejects.toBe(boom)
    // TEK deneme. Gercek bir ariza gecikmeli raporlanmamalidir.
    expect(calls).toBe(1)
  })

  it('denemeler tukenince SON hiz-siniri hatasini oldugu gibi firlatir', async () => {
    let calls = 0
    await expect(
      withRateLimitRetry(
        () => {
          calls += 1
          return Promise.reject(wrappedArcRateLimit())
        },
        { attempts: 4, sleep: noSleep, random: () => 0 },
      ),
    ).rejects.toMatchObject({ name: 'ContractFunctionExecutionError' })
    expect(calls).toBe(4)
    // Onemli: TUKENIR. Sonsuz yeniden deneme, poll'u hic bitmeyen ve
    // dolayisiyla hicbir sey raporlamayan bir izleyici yapardi.
  })

  it('geri cekilme USTEL ve TAM JITTERLIDIR, ve tavanla sinirlidir', async () => {
    const waits: number[] = []
    await expect(
      withRateLimitRetry(() => Promise.reject(wrappedArcRateLimit()), {
        attempts: 6,
        baseDelayMs: 100,
        maxDelayMs: 400,
        // random()=1 tavani verir; boylece gozlenen dizi USTEL siniri gosterir.
        random: () => 1,
        sleep: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
      }),
    ).rejects.toBeDefined()
    expect(waits).toEqual([100, 200, 400, 400, 400])
  })

  it('jitter GERCEKTEN uygulanir: random()=0 ile hicbir bekleme yapilmaz', async () => {
    const waits: number[] = []
    await expect(
      withRateLimitRetry(() => Promise.reject(wrappedArcRateLimit()), {
        attempts: 3,
        baseDelayMs: 1_000,
        random: () => 0,
        sleep: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
      }),
    ).rejects.toBeDefined()
    // Sabit gecikme olsaydi [1000, 2000] olurdu. Tam jitter [0, ceiling)
    // araligindan secer; alti cagrinin ayni duvara TOPLU HALDE geri donmesini
    // engelleyen sey budur.
    expect(waits).toEqual([0, 0])
  })

  it('ILK denemede basariliysa HIC beklemez', async () => {
    let slept = 0
    const value = await withRateLimitRetry(() => Promise.resolve(7), {
      sleep: () => {
        slept += 1
        return Promise.resolve()
      },
    })
    expect(value).toBe(7)
    expect(slept).toBe(0)
  })
})
