/**
 * ============================================================================
 *  SUPURME KARARI -- SAF, ZINCIRSIZ, TAM TEST EDILEBILIR
 * ============================================================================
 *
 * NICIN AYRI BIR MODUL. `graduate/executor.ts`in ogrettigi sey: zincire
 * dokunan kod ile KARAR VEREN kod ayrilmazsa, kararin testi bir RPC taklidine
 * baglanir ve o taklit gercekten sapabilir. Burada karar TAMAMEN saf bir
 * fonksiyondur: girdisi zincirden OKUNMUS sayilardir, ciktisi bir eylemdir.
 *
 * KARARIN UC BILESENI VAR VE UCU DE SPEC'TEN GELIR:
 *
 *   1. ESIK   -- `spendable < MIN_SWEEP_WEI` ise supurme gaz israfidir.
 *                Hazine zaten ayni kontrolu yapar ve parayi creator'a katlar;
 *                anahtarcinin onu tetiklemesi icin bir sebep YOKTUR.
 *
 *   2. SLIPAJ -- `minTokensOut` bir ALT SINIRDIR ve hazine onun altinda
 *                REVERT eder (geri katlamaz). Yani bu sayi "kotu bir fiyati
 *                kabul etmem" demektir; sifir gecmek korumayi kapatmaktir.
 *
 *   3. ZAMAN  -- supurmenin ANI ONGORULEBILIR OLMAMALIDIR (spec §sandwich).
 *                Sabit bir cron, bir on-kosucuya "su dakikada su tokende su
 *                kadar alim gelecek" bilgisini BEDAVA verir.
 */

/** Zincirden okunmus, karar icin gereken her sey. */
export type SweepInput = {
  readonly token: `0x${string}`
  /** `BuybackTreasury.spendable(token)` -- native wei. */
  readonly spendableWei: bigint
  /** `BuybackTreasury.MIN_SWEEP_WEI()`. Kontrattan okunur, kopyalanmaz. */
  readonly minSweepWei: bigint
  /**
   * Harcanacak tutar icin BEKLENEN token ciktisi (simulasyondan).
   * `null` ise simulasyon yapilamadi.
   */
  readonly quotedTokensOut: bigint | null
  /** `BuybackTreasury.sweepIsPermissionless(token)`. */
  readonly permissionless: boolean
  /** Bu anahtarci fabrikanin kayitli anahtarcisi mi. */
  readonly isDesignatedKeeper: boolean
}

export type SweepDecision =
  | { readonly action: 'skip'; readonly reason: SkipReason }
  | {
      readonly action: 'sweep'
      readonly minTokensOut: bigint
      readonly deadline: number
      readonly delayMs: number
    }

export type SkipReason = 'nothing-pending' | 'below-threshold' | 'no-quote' | 'not-authorised'

export type SweepPolicy = {
  /**
   * Kabul edilen azami slipaj. VARSAYILAN 100 bps (%1).
   *
   * @remarks HAZINENIN `MAX_PRICE_IMPACT_BPS`INDEN (300) KUCUK OLMALIDIR ve
   *          sebebi ikisinin FARKLI seyleri sinirlamasidir: hazineninki
   *          "fiyati ne kadar kaydirabilirim", bu ise "simulasyondan bu yana
   *          ne kadar sapma kabul ederim". Slipaj toleransi fiyat-etki
   *          sinirindan BUYUK olsaydi, koruma hicbir zaman baglamazdi --
   *          hazine zaten %3'te durur.
   */
  readonly maxSlippageBps: number
  /** Islem son kullanma suresi, saniye. */
  readonly deadlineSeconds: number
  /**
   * Gecikme penceresi, ms. Supurme `[0, jitterWindowMs)` araliginda rastgele
   * bir an sonra gonderilir.
   */
  readonly jitterWindowMs: number
}

export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  maxSlippageBps: 100,
  deadlineSeconds: 300,
  jitterWindowMs: 90_000,
}

const BPS = 10_000n

/**
 * KARAR. Saf: ayni girdi + ayni `nowSeconds` + ayni `jitterSeed` -> ayni cikti.
 *
 * @param jitterSeed Testin belirleyebilmesi icin DISARIDAN verilir. Uretimde
 *        `crypto.randomInt` beslenir. Rastgeleligi fonksiyonun ICINDE uretmek,
 *        gecikmenin test edilebilir olmasini imkansiz kilardi -- ve test
 *        edilmeyen bir anti-sandwich onlemi, olmayan bir onlemdir.
 */
export function planSweep(
  input: SweepInput,
  nowSeconds: number,
  jitterSeed: number,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): SweepDecision {
  // YETKI ONCE. Yetkisiz bir cagri zincirde `NotKeeper` ile duser; gazi
  // harcamadan once burada durur.
  if (!input.isDesignatedKeeper && !input.permissionless) {
    return { action: 'skip', reason: 'not-authorised' }
  }

  if (input.spendableWei === 0n) return { action: 'skip', reason: 'nothing-pending' }

  // ESIK KONTRATTAN OKUNUR, BURAYA YAZILMAZ. Bir literal, `MIN_SWEEP_WEI`
  // degistiginde sessizce ayrisirdi.
  if (input.spendableWei < input.minSweepWei) {
    return { action: 'skip', reason: 'below-threshold' }
  }

  // SIMULASYON YOKSA SUPURME YOK. `minTokensOut: 0` gecmek islemi
  // BASARILI kilardi ama korumasiz: hazine her fiyati kabul ederdi. "Kotu
  // fiyat" ile "fiyat bilmiyorum" ayni sey degildir.
  if (input.quotedTokensOut === null || input.quotedTokensOut === 0n) {
    return { action: 'skip', reason: 'no-quote' }
  }

  const minTokensOut = (input.quotedTokensOut * (BPS - BigInt(policy.maxSlippageBps))) / BPS

  return {
    action: 'sweep',
    minTokensOut,
    deadline: nowSeconds + policy.deadlineSeconds,
    delayMs: jitterFrom(jitterSeed, policy.jitterWindowMs),
  }
}

/**
 * Tohumdan `[0, windowMs)` araliginda bir gecikme.
 *
 * @remarks MODULO YANLILIGI KABUL EDILDI VE NEDEN ONEMSIZ OLDUGU YAZILI:
 *          `seed % window` tam bolunmedigi surece kucuk degerlere cok hafif
 *          bir egilim verir. Burada onemsizdir cunku amac KRIPTOGRAFIK
 *          duzgunluk degil, ONGORULEMEZLIKTIR -- bir on-kosucunun bilmesi
 *          gereken sey "hangi saniyede", ve 90 saniyelik bir pencerede
 *          milyonda birlik bir egilim ona hicbir sey kazandirmaz.
 *
 *          NEGATIF VE ASIRI BUYUK TOHUMLAR EHLILESTIRILIR: `crypto.randomInt`
 *          bunlari uretmez ama bu fonksiyon disaridan cagrilabilir ve negatif
 *          bir `delayMs` `setTimeout`ta SESSIZCE sifir olurdu -- yani jitter
 *          kapanirdi ve hicbir sey bunu soylemezdi.
 */
export function jitterFrom(seed: number, windowMs: number): number {
  if (!Number.isFinite(seed) || windowMs <= 0) return 0
  const s = Math.abs(Math.trunc(seed))
  return s % windowMs
}

/**
 * Bir supurme turunun ozeti -- alarm katmani bunu okur.
 */
export type SweepPassSummary = {
  readonly considered: number
  readonly swept: number
  readonly skipped: Readonly<Record<SkipReason, number>>
}

export function emptySummary(): SweepPassSummary {
  return {
    considered: 0,
    swept: 0,
    skipped: {
      'nothing-pending': 0,
      'below-threshold': 0,
      'no-quote': 0,
      'not-authorised': 0,
    },
  }
}

/** Bir karari ozete katar. Ozet DEGISMEZDIR; yeni bir kopya doner. */
export function foldDecision(summary: SweepPassSummary, decision: SweepDecision): SweepPassSummary {
  if (decision.action === 'sweep') {
    return { ...summary, considered: summary.considered + 1, swept: summary.swept + 1 }
  }
  return {
    ...summary,
    considered: summary.considered + 1,
    skipped: { ...summary.skipped, [decision.reason]: summary.skipped[decision.reason] + 1 },
  }
}
