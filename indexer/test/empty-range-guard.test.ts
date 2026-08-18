import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  createEmptyRangeGuard,
  EmptyRangeDisputed,
  WitnessUnavailable,
  witnessUrlFrom,
} from '../src/empty-range-guard'
import { fetchRange } from '../src/logs'
import { FakeNode, LIVE, smokeLogs } from './fixtures'

/**
 * ============================================================================
 *  BOS ARALIK MUHAFIZI -- VE MUHAFIZIN KENDISININ KANITI
 * ============================================================================
 *
 * Bu muhafiz, uretimde 36 escrow olayinin SESSIZCE kaybolmasindan sonra yazildi
 * (bkz. `src/empty-range-guard.ts` basligi). Bir muhafizin en tehlikeli hali
 * "hicbir sey bulmayan" degil, "hicbir sey ARAMAYAN"dir -- o yuzden asagidaki
 * testlerin yarisi muhafizin GERCEKTEN kostugunu olcer, buldugunu degil.
 */
describe('bos aralik muhafizi', () => {
  it('tanik YOKSA kapalidir, ve bunu SOYLER (sessiz no-op degil)', async () => {
    const guard = createEmptyRangeGuard({ witness: null })
    expect(guard.enabled, 'yapilandirilmamis dagitim: capraz kontrol MUMKUN DEGIL').toBe(false)
    for (let i = 0; i < 100; i += 1) await guard.onEmptyRange(1n, 10n)
    expect(guard.verifications(), 'tanik yokken hicbir dogrulama YAPILAMAZ').toBe(0)
    expect(guard.emptyRangesSeen()).toBe(100)
  })

  it('her N bos aralikta BIR kez dogrular -- maliyet sinirli', async () => {
    const asked: [bigint, bigint][] = []
    const guard = createEmptyRangeGuard({
      sampleEvery: 3,
      witness: async (from, to) => {
        asked.push([from, to])
        return 0
      },
    })
    expect(guard.enabled).toBe(true)
    for (let i = 0; i < 9; i += 1) await guard.onEmptyRange(BigInt(i), BigInt(i) + 1n)
    expect(asked.length, '9 bos aralik / 3 = 3 dogrulama').toBe(3)
    expect(asked).toEqual([
      [2n, 3n],
      [5n, 6n],
      [8n, 9n],
    ])
  })

  it('POZITIF KONTROL: tanik olay bulursa ATAR ve araligi ADIYLA soyler', async () => {
    const guard = createEmptyRangeGuard({ sampleEvery: 1, witness: async () => 36 })
    await expect(guard.onEmptyRange(57_180_976n, 57_181_241n)).rejects.toBeInstanceOf(
      EmptyRangeDisputed,
    )
    const err = await guard.onEmptyRange(57_180_976n, 57_181_241n).catch((e: unknown) => e)
    expect(String(err)).toContain('57180976')
    expect(String(err)).toContain('36')
  })

  it('tanik da BOS derse bu bir ONAY -- tarama devam eder', async () => {
    let calls = 0
    const guard = createEmptyRangeGuard({
      sampleEvery: 1,
      witness: async () => {
        calls += 1
        return 0
      },
    })
    for (let i = 0; i < 5; i += 1) await guard.onEmptyRange(1n, 2n)
    expect(calls).toBe(5)
    expect(guard.verifications(), 'bes dogrulama, hicbiri itiraz etmedi').toBe(5)
  })

  it('tek tuk tanik hatasi ingest i DURDURMAZ', async () => {
    const guard = createEmptyRangeGuard({
      sampleEvery: 1,
      maxWitnessFailures: 3,
      witness: async () => {
        throw new Error('gecici ag hatasi')
      },
    })
    await expect(guard.onEmptyRange(1n, 2n)).resolves.toBeUndefined()
    await expect(guard.onEmptyRange(1n, 2n)).resolves.toBeUndefined()
  })

  it('ama SUREKLI hata verirse DURUR -- kosamayan muhafiz guven veren no-op olurdu', async () => {
    const guard = createEmptyRangeGuard({
      sampleEvery: 1,
      maxWitnessFailures: 3,
      witness: async () => {
        throw new Error('tanik uc olu')
      },
    })
    await guard.onEmptyRange(1n, 2n)
    await guard.onEmptyRange(1n, 2n)
    await expect(guard.onEmptyRange(1n, 2n)).rejects.toBeInstanceOf(WitnessUnavailable)
  })

  it('hata sayaci BASARIDAN sonra sifirlanir -- aralikli arizalar yanlis alarm vermez', async () => {
    let n = 0
    const guard = createEmptyRangeGuard({
      sampleEvery: 1,
      maxWitnessFailures: 3,
      witness: async () => {
        n += 1
        if (n % 2 === 1) throw new Error('aralikli')
        return 0
      },
    })
    for (let i = 0; i < 20; i += 1) {
      await expect(guard.onEmptyRange(1n, 2n)).resolves.toBeUndefined()
    }
    expect(guard.verifications(), 'basarili olanlar sayilmali').toBe(10)
  })

  /**
   * ============ TANIGIN UFKU: SUSMAK, ARIZA DEGILDIR ============
   *
   * OLCULDU (uretim, 2026-08-18): tanik uc `pruned history unavailable`
   * donduruyor -- budanmis bir dugum eski bloklarin loglarini tutmaz. Ilk surum
   * bunu ariza sayip ard arda bes kez gorunce indexer'i DURDURUYORDU, geriye
   * donuk tarama boyunca her ~10 dakikada bir. Durmak koruma EKLEMIYORDU: o
   * aralikta zaten dogrulama yapilamaz.
   */
  it('UFUK: `pruned history` ariza sayilmaz, sayaci ARTIRMAZ', async () => {
    const guard = createEmptyRangeGuard({
      sampleEvery: 1,
      maxWitnessFailures: 3,
      witness: async () => {
        const e = new Error('RPC Request failed.') as Error & { details?: string }
        e.details = 'pruned history unavailable'
        throw e
      },
    })
    // Esikten COK daha fazlasi: hicbiri durdurmamali.
    for (let i = 0; i < 20; i += 1) {
      await expect(guard.onEmptyRange(1n, 2n)).resolves.toBeUndefined()
    }
    expect(guard.silencedByHorizon(), 'ufkun altinda kalan aralik sayisi').toBe(20)
    expect(guard.verifications(), 'susan bir tanik DOGRULAMA yapmis sayilmaz').toBe(0)
  })

  it('UFUK, GERCEK ARIZAYI MASKELEMEZ -- viem sarmalayicisinin ICINDEN de okunur', async () => {
    // Ayirt edici kontrol: ufuk kalibi TASIMAYAN bir hata hala sayilir ve
    // esikte durdurur. Bu olmadan, kalibi genis tutup her seyi yutmak testi
    // gecerdi -- ve muhafiz sessizce no-op olurdu.
    const guard = createEmptyRangeGuard({
      sampleEvery: 1,
      maxWitnessFailures: 3,
      witness: async () => {
        throw new Error('connection reset by peer')
      },
    })
    await guard.onEmptyRange(1n, 2n)
    await guard.onEmptyRange(1n, 2n)
    await expect(guard.onEmptyRange(1n, 2n)).rejects.toBeInstanceOf(WitnessUnavailable)
  })

  it('UFUK, viem`in `cause` zincirinden de taninir', async () => {
    const guard = createEmptyRangeGuard({
      sampleEvery: 1,
      maxWitnessFailures: 2,
      witness: async () => {
        const inner = new Error('RPC Request failed.') as Error & { details?: string }
        inner.details = 'pruned history unavailable'
        const outer = new Error('sarmalayici') as Error & { cause?: unknown }
        outer.cause = inner
        throw outer
      },
    })
    // Uretimde hata viem tarafindan SARILARAK geliyor; yalnizca ust seviyeye
    // bakan bir kalip onu kaciririr ve indexer yine dururdu.
    for (let i = 0; i < 5; i += 1) await guard.onEmptyRange(1n, 2n)
    expect(guard.silencedByHorizon()).toBe(5)
  })

  /**
   * ============ TANIK, VIEM'IN ILK DUSTUGU UC OLAMAZ ============
   *
   * OLCULDU (uretim, 2026-08-18): 36 escrow logu IKINCI kez kayboldu, ayni
   * araliktan. Zincir soyle: birincil uc `rate limit exceeded` verdi, viem
   * ILK YEDEGE dustu (`urls[1]` = blockdaemon), ve o uc 36 log iceren aralik
   * icin HATASIZ BOS DIZI dondu. viem bunu gecerli bir cevap saydi.
   *
   * Ve muhafiz bu yalani ONAYLADI: tanik da `urls[1]`di. Yani yalan soyleyen
   * uca kendi yalanini sorduk -- bu dosyanin ustunde "asla yapilmamali" diye
   * yazan seyin ta kendisi. Sonuc sessiz kayiptan KOTUYDU: sessiz kayip arti
   * SAHTE GUVEN.
   *
   * Tanik bu yuzden SON uctur: viem sirayla duser, yani sonuncusu birincil
   * arizada en az ugranan ve `urls[1]` ile CAKISMAYAN tek secimdir.
   */
  it('tanik SON uctur -- viem`in ilk dustugu uc ASLA secilmez', () => {
    // Ayirt edici kontrol: eski surum `urls[1]` dondururdu ve bu satirda olurdu.
    expect(witnessUrlFrom(['https://primary', 'https://first-fallback', 'https://last'])).toBe(
      'https://last',
    )
    expect(
      witnessUrlFrom(['https://p', 'https://blockdaemon', 'https://drpc', 'https://quicknode']),
      'uretimdeki dort uc: tanik quicknode olmali, blockdaemon DEGIL',
    ).toBe('https://quicknode')
  })

  it('tanik adresi: yedek yoksa null', () => {
    expect(witnessUrlFrom(['https://a'])).toBeNull()
    expect(witnessUrlFrom([])).toBeNull()
  })

  it('TEK yedek varsa tanik odur -- ve bu durum RISKLIDIR', () => {
    // Iki uc varken tanik ile viem'in ilk yedegi ZORUNLU olarak ayni olur;
    // baska secim yok. Test bunu bir iddia olarak yazar ki, birileri uctan
    // birini silmeye kalktiginda korumanin zayifladigi GORUNUR olsun.
    expect(witnessUrlFrom(['https://a', 'https://b'])).toBe('https://b')
  })
})

/**
 * ============================================================================
 *  KABLOLAMA: `fetchRange` MUHAFIZI GERCEKTEN CAGIRIYOR MU
 * ============================================================================
 *
 * Yukaridaki testler muhafizin DOGRU calistigini gosterir, CAGRILDIGINI degil.
 * Bu ayrim bu deponun tekrar tekrar odedigi arizadir: tamamlanmis, kapili ve
 * HIC CAGRILMAYAN bir katman (buyback cozucusu boyleydi -- `fetchRange` hazine
 * adresini hic sormuyordu ve dort kapi yesildi).
 *
 * Bu yuzden asagidakiler uretim yolunu surer: gercek `fetchRange`, bos cevap
 * veren gercek bir `RpcClient` (uretimdeki patolojinin ta kendisi).
 */
describe('fetchRange -> muhafiz kablolamasi', () => {
  const watch = {
    factory: LIVE.factory,
    escrow: LIVE.escrow,
    curves: new Set<Address>(),
    tokens: new Set<Address>(),
    curveToToken: new Map<Address, Address>(),
    pools: new Map(),
    buyback: null,
  }

  it('BOS bir aralikta kancayi ARALIGIYLA cagirir', async () => {
    const seen: [bigint, bigint][] = []
    const events = await fetchRange(new FakeNode([]), watch, 100n, 199n, {
      onEmptyRange: async (from, to) => {
        seen.push([from, to])
      },
    })
    expect(events, 'bos node, bos aralik').toEqual([])
    expect(seen, 'kanca CAGRILMALI ve TAM aralik gelmeli').toEqual([[100n, 199n]])
  })

  it('KONTROL: olay VARSA kanca cagrilmaz', async () => {
    let calls = 0
    const logs = smokeLogs()
    const first = BigInt(logs[0]!.blockNumber)
    const last = BigInt(logs[logs.length - 1]!.blockNumber)
    const events = await fetchRange(new FakeNode(logs), watch, first, last, {
      onEmptyRange: async () => {
        calls += 1
      },
    })
    // Bu kontrol olmadan "kanca hep cagriliyor" da testi gecerdi.
    expect(events.length, 'on kosul: bu aralikta GERCEKTEN olay var').toBeGreaterThan(0)
    expect(calls, 'dolu bir aralikta dogrulamaya gerek YOK').toBe(0)
  })

  it('muhafiz ITIRAZ ederse hata `fetchRange`ten DISARI cikar -- imlec ilerlemez', async () => {
    const guard = createEmptyRangeGuard({ sampleEvery: 1, witness: async () => 36 })
    await expect(
      fetchRange(new FakeNode([]), watch, 57_180_976n, 57_181_241n, {
        onEmptyRange: guard.onEmptyRange,
      }),
    ).rejects.toBeInstanceOf(EmptyRangeDisputed)
  })
})
