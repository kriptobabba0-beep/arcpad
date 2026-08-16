import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SWEEP_POLICY,
  emptySummary,
  foldDecision,
  jitterFrom,
  planSweep,
  type SweepInput,
} from '../src/sweep/decide'

const TOKEN = '0x0000000000000000000000000000000000000abc' as const

/** Supurulmeye HAZIR bir girdi; her test yalnizca ilgilendigi alani bozar. */
function ready(over: Partial<SweepInput> = {}): SweepInput {
  return {
    token: TOKEN,
    spendableWei: 10n ** 18n, // 1 USDC
    minSweepWei: 5n * 10n ** 16n, // 0,05 USDC -- kontrattaki MIN_SWEEP_WEI
    quotedTokensOut: 1_000_000n * 10n ** 18n,
    permissionless: false,
    isDesignatedKeeper: true,
    ...over,
  }
}

const NOW = 1_800_000_000

describe('planSweep', () => {
  it('hazir bir butceyi supurur', () => {
    const d = planSweep(ready(), NOW, 0)
    expect(d.action).toBe('sweep')
  })

  // ------------------------------------------------------------------
  // ESIK
  // ------------------------------------------------------------------

  it('esigin ALTINDA supurmez', () => {
    const d = planSweep(ready({ spendableWei: 4n * 10n ** 16n }), NOW, 0)
    expect(d).toEqual({ action: 'skip', reason: 'below-threshold' })
  })

  /**
   * SINIR KAPSAYICIDIR: tam esikte supurulur.
   *
   * Kontrat `spendable < MIN_SWEEP_WEI` ile geri katlar, yani ESITLIK
   * halinde supurme GECERLIDIR. Anahtarcinin daha kati olmasi, kontratin
   * kabul ettigi bir turu sonsuza kadar atlamasi demek olurdu.
   */
  it('tam esikte supurur -- sinir kontratla AYNI yonde', () => {
    const min = 5n * 10n ** 16n
    expect(planSweep(ready({ spendableWei: min }), NOW, 0).action).toBe('sweep')
    expect(planSweep(ready({ spendableWei: min - 1n }), NOW, 0).action).toBe('skip')
  })

  it('bos butceyi ayri bir sebeple atlar', () => {
    const d = planSweep(ready({ spendableWei: 0n }), NOW, 0)
    expect(d).toEqual({ action: 'skip', reason: 'nothing-pending' })
  })

  /**
   * ESIK KONTRATTAN GELIR, SABIT DEGIL.
   *
   * Ayni `spendable`, farkli `minSweepWei` -> farkli karar. Esigi keeper
   * tarafinda literal yazan bir surum bu testte duser.
   */
  it('esik girdiden okunur, keeper tarafinda sabit degildir', () => {
    const s = 10n ** 17n // 0,1 USDC
    expect(planSweep(ready({ spendableWei: s, minSweepWei: 5n * 10n ** 16n }), NOW, 0).action).toBe(
      'sweep',
    )
    expect(planSweep(ready({ spendableWei: s, minSweepWei: 5n * 10n ** 17n }), NOW, 0).action).toBe(
      'skip',
    )
  })

  // ------------------------------------------------------------------
  // SLIPAJ
  // ------------------------------------------------------------------

  it('minTokensOut kotayi slipaj kadar indirir', () => {
    const quoted = 1_000_000n * 10n ** 18n
    const d = planSweep(ready({ quotedTokensOut: quoted }), NOW, 0)
    if (d.action !== 'sweep') throw new Error('supurmeliydi')
    // %1 tolerans -> %99
    expect(d.minTokensOut).toBe((quoted * 9_900n) / 10_000n)
    expect(d.minTokensOut).toBeLessThan(quoted)
  })

  /**
   * KOTA YOKSA SUPURME YOK -- VE BU BIR KORUMADIR, BIR KOLAYLIK DEGIL.
   *
   * `minTokensOut: 0` ile gonderilen bir supurme BASARILI olur ama hazine
   * her fiyati kabul eder. "Fiyat kotu" ile "fiyati bilmiyorum" ayni sey
   * degildir; ikincisinde dogru hamle beklemektir.
   */
  it('simulasyon yoksa supurmez', () => {
    expect(planSweep(ready({ quotedTokensOut: null }), NOW, 0)).toEqual({
      action: 'skip',
      reason: 'no-quote',
    })
    expect(planSweep(ready({ quotedTokensOut: 0n }), NOW, 0)).toEqual({
      action: 'skip',
      reason: 'no-quote',
    })
  })

  it('slipaj toleransi hazinenin fiyat-etki sinirindan KUCUK olmali', () => {
    // Hazinede `MAX_PRICE_IMPACT_BPS = 300`. Varsayilan tolerans onun
    // altinda olmazsa koruma hicbir zaman baglamaz.
    expect(DEFAULT_SWEEP_POLICY.maxSlippageBps).toBeLessThan(300)
  })

  // ------------------------------------------------------------------
  // YETKI
  // ------------------------------------------------------------------

  it('yetkisiz ve izinsizlesmemisken supurmez', () => {
    const d = planSweep(ready({ isDesignatedKeeper: false, permissionless: false }), NOW, 0)
    expect(d).toEqual({ action: 'skip', reason: 'not-authorised' })
  })

  /**
   * ...AMA SURE DOLDUYSA HERKES SUPUREBILIR (spec §29).
   *
   * `SWEEP_GRACE` sonrasi supurme izinsizlesir; anahtarci sessiz kalsa bile
   * fonlar kilitlenmez. Bu dalin kapali kalmasi, korumanin var olma sebebini
   * ortadan kaldirirdi.
   */
  it('izinsizlestikten sonra yetkisiz cagiran da supurur', () => {
    const d = planSweep(ready({ isDesignatedKeeper: false, permissionless: true }), NOW, 0)
    expect(d.action).toBe('sweep')
  })

  /** SIRA: yetki kontrolu esikten ONCE gelir -- gaz harcanmadan duser. */
  it('yetkisizken esik sebebi DEGIL yetki sebebi doner', () => {
    const d = planSweep(
      ready({ isDesignatedKeeper: false, permissionless: false, spendableWei: 1n }),
      NOW,
      0,
    )
    expect(d).toEqual({ action: 'skip', reason: 'not-authorised' })
  })

  // ------------------------------------------------------------------
  // ZAMAN
  // ------------------------------------------------------------------

  it('deadline simdiden turetilir', () => {
    const d = planSweep(ready(), NOW, 0)
    if (d.action !== 'sweep') throw new Error('supurmeliydi')
    expect(d.deadline).toBe(NOW + DEFAULT_SWEEP_POLICY.deadlineSeconds)
  })

  /**
   * GECIKME TOHUMDAN GELIR VE DETERMINISTIKTIR.
   *
   * Rastgeleligi fonksiyonun ICINDE uretmek, anti-sandwich onlemini test
   * edilemez yapardi -- ve test edilmeyen bir onlem, olmayan bir onlemdir.
   */
  it('ayni tohum ayni gecikmeyi verir, farkli tohum farkli', () => {
    const a = planSweep(ready(), NOW, 12_345)
    const b = planSweep(ready(), NOW, 12_345)
    const c = planSweep(ready(), NOW, 54_321)
    if (a.action !== 'sweep' || b.action !== 'sweep' || c.action !== 'sweep') {
      throw new Error('supurmeliydi')
    }
    expect(a.delayMs).toBe(b.delayMs)
    expect(a.delayMs).not.toBe(c.delayMs)
  })

  it('gecikme pencerenin ICINDE kalir', () => {
    for (const seed of [0, 1, 89_999, 90_000, 1_000_000, 2 ** 31 - 1]) {
      const d = planSweep(ready(), NOW, seed)
      if (d.action !== 'sweep') throw new Error('supurmeliydi')
      expect(d.delayMs).toBeGreaterThanOrEqual(0)
      expect(d.delayMs).toBeLessThan(DEFAULT_SWEEP_POLICY.jitterWindowMs)
    }
  })
})

describe('jitterFrom', () => {
  /**
   * NEGATIF TOHUM SESSIZCE JITTER'I KAPATIRDI.
   *
   * `setTimeout(fn, -5)` ANINDA calisir ve hicbir hata vermez -- yani
   * anti-sandwich onlemi kapanir ve kimse fark etmez. Bu satir onu kapatir.
   */
  it('negatif tohumda bile pencere icinde kalir', () => {
    expect(jitterFrom(-12_345, 1_000)).toBeGreaterThanOrEqual(0)
    expect(jitterFrom(-12_345, 1_000)).toBeLessThan(1_000)
  })

  it('gecersiz girdilerde sifir doner', () => {
    expect(jitterFrom(Number.NaN, 1_000)).toBe(0)
    expect(jitterFrom(Number.POSITIVE_INFINITY, 1_000)).toBe(0)
    expect(jitterFrom(5, 0)).toBe(0)
    expect(jitterFrom(5, -1)).toBe(0)
  })

  it('pencere gercekten dagitir -- tek bir degere cokmez', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i += 1) seen.add(jitterFrom(i * 7919, 90_000))
    // ANTI-VAKUM: sabit donen bir surum burada duser.
    expect(seen.size).toBeGreaterThan(50)
  })
})

describe('ozet', () => {
  it('bos ozet her sebebi sifirla tasir', () => {
    const s = emptySummary()
    expect(s.considered).toBe(0)
    expect(Object.values(s.skipped).every((v) => v === 0)).toBe(true)
  })

  it('kararlar toplanir ve ozet DEGISMEZ kalir', () => {
    const s0 = emptySummary()
    const s1 = foldDecision(s0, planSweep(ready(), NOW, 0))
    const s2 = foldDecision(s1, planSweep(ready({ spendableWei: 0n }), NOW, 0))

    expect(s0.considered).toBe(0) // orijinal bozulmadi
    expect(s2.considered).toBe(2)
    expect(s2.swept).toBe(1)
    expect(s2.skipped['nothing-pending']).toBe(1)
    expect(s2.skipped['below-threshold']).toBe(0)
  })
})
