import { beforeEach, describe, expect, it } from 'vitest'
import { applyGraduated, getCursor, replayRange } from '../src/apply'
import { putDeployment } from '../src/deployment'
import { getTokenOverview } from '../src/queries'
import type { Address } from '../src/hex'
import { snapshot } from '../src/snapshot'
import { pool, resetSchema } from './setup'
import {
  COMPLETED,
  CURVE,
  DEPLOYMENT,
  GENESIS,
  GRADUATED,
  GRADUATION_TARGET,
  GRADUATION_TRANSFER,
  hashFor,
  PROFILE,
  RANGE,
  RANGE_TO,
  TOKEN,
} from './fixtures'

/**
 * GRADUATION -- TERMINAL DURUM.
 *
 * NE OLCULUR VE NEDEN BURADA:
 *
 *  1. EXACTLY-ONCE, DOKUMLE. Ayni araligi iki kez oynatmak ikinci gecisde
 *     hicbir SATIR yazmaz VE hicbir DEGER degistirmez.
 *  2. NEGATIF KONTROL. Muhafizi -- `NOT graduated` -- geri alip AYNI cagriyi
 *     tekrarlamak GERCEKTEN yazar. Bu olmadan (1), "cagri zaten hicbir sey
 *     yapmiyor olabilir" ile ayni gorunurdu; birincil anahtar hakkinda akil
 *     yurutmek kanit degildir, ve `Graduated`in bir defter tablosu YOKTUR --
 *     muhafiz sutunun KENDISIDIR, dolayisiyla negatif kontrol o sutunu geri
 *     almaktir.
 *  3. CIFT SAYIM YOK. Mezuniyet odemesi zincirde ayrica bir `Transfer` yayar
 *     ve holder muhasebesinin sahibi ODUR. `applyGraduated` bakiyelere
 *     DOKUNMAZ; ikisi birlikte oynatildiginda toplam arz korunur.
 *  4. YARIM YAZILMIS BIR MEZUNIYET SEMA DUZEYINDE IMKANSIZ.
 *  5. OKUMA MODELI terminal durumu SOYLER.
 */

const TARGET = GRADUATION_TARGET as Address
const GRAD_BLOCK = GRADUATED.blockNumber

async function seedThroughCompletion(): Promise<void> {
  await resetSchema()
  await putDeployment(pool, DEPLOYMENT)
  await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), GENESIS)
}

async function curveRow(): Promise<Record<string, unknown>> {
  const { rows } = await pool.query('SELECT * FROM curve_state WHERE token = $1', [TOKEN])
  const row = rows[0]
  if (row === undefined) throw new Error('curve_state satiri yok')
  return row as Record<string, unknown>
}

describe('graduation', () => {
  beforeEach(seedThroughCompletion)

  // -----------------------------------------------------------------
  // Once: TAMAMLANMIS ama MEZUN OLMAMIS. Bu bir ara adim degil, canli
  // zincirin SU ANKI durumu -- smoke curve'u tam olarak burada duruyor.
  // -----------------------------------------------------------------
  it('Completed bir curve MEZUN DEGILDIR (iki durum ayni sey degil)', async () => {
    const row = await curveRow()
    expect(row['complete']).toBe(true)
    expect(row['graduated']).toBe(false)
    expect(row['graduated_seq']).toBeNull()
    expect(row['graduation_target_addr']).toBeNull()
    expect(row['graduation_base_tok']).toBeNull()
    expect(row['graduation_quote_wei']).toBeNull()
  })

  it('Graduated dort alani birden yazar ve last_seq i ilerletir', async () => {
    const before = await curveRow()
    expect(await applyGraduated(pool, GRADUATED)).toBe(1)
    const row = await curveRow()
    expect(row['graduated']).toBe(true)
    expect(row['graduated_seq']).toBe(GRADUATED.eventSeq.toString())
    expect(row['graduation_target_addr']).toBe(TARGET)
    expect(row['graduation_base_tok']).toBe(GRADUATED.baseAmountTok.toString())
    expect(row['graduation_quote_wei']).toBe(GRADUATED.quoteAmountWei.toString())
    // `last_seq` ONCEKINDEN buyuk: gec gelen bir olay onu geri cekemez.
    expect(BigInt(row['last_seq'] as string)).toBeGreaterThan(BigInt(before['last_seq'] as string))
    expect(row['last_seq']).toBe(GRADUATED.eventSeq.toString())
  })

  // -----------------------------------------------------------------
  // (1) EXACTLY-ONCE, ve (2) ONU KANIT YAPAN NEGATIF KONTROL.
  // -----------------------------------------------------------------
  it('ikinci uygulama SIFIR satir yazar ve dokum DEGISMEZ', async () => {
    expect(await applyGraduated(pool, GRADUATED)).toBe(1)
    const after = await snapshot(pool)

    expect(await applyGraduated(pool, GRADUATED)).toBe(0)
    // Sayac "hicbir satir yazilmadi" der; dokum "hicbir DEGER degismedi" der.
    expect(await snapshot(pool)).toEqual(after)
  })

  it('NEGATIF KONTROL: muhafizi geri al, AYNI cagri yeniden YAZAR', async () => {
    expect(await applyGraduated(pool, GRADUATED)).toBe(1)
    expect(await applyGraduated(pool, GRADUATED)).toBe(0)

    // Muhafizin KENDISI geri aliniyor -- `Graduated`in defter satiri yoktur,
    // idempotency'yi saglayan tek sey `WHERE ... AND NOT graduated`tir.
    // `graduated_iff_*` kisitlari yuzunden dordu birden temizlenmeli; bu da
    // ayrica gosterir ki geri alma GERCEKTEN mezun-olmamis bir satir uretir,
    // yarim bir sey degil.
    await pool.query(
      `UPDATE curve_state SET graduated = false, graduated_seq = NULL,
         graduation_target_addr = NULL, graduation_base_tok = NULL,
         graduation_quote_wei = NULL
       WHERE token = $1`,
      [TOKEN],
    )

    // ISTE KANIT: cagri degismedi, DAVRANIS degisti. Yani ilk testin
    // gordugu sifir, "bu cagri hicbir sey yapmiyor"dan degil, MUHAFIZDAN
    // geliyor.
    expect(await applyGraduated(pool, GRADUATED)).toBe(1)
    expect((await curveRow())['graduated']).toBe(true)
  })

  it('replayRange uzerinden de exactly-once (ayni ozellik, gercek giris noktasi)', async () => {
    // Yukaridaki iki test `applyGraduated`i DOGRUDAN cagiriyor. Bu depoda
    // "bir giris noktasinda kanitlanan ozellik hepsinde kanitlanmis okunur"
    // hatasi on bir kez tekrarlandi; ingest dongusunun gercekten kullandigi
    // yol `replayRange`tir ve ayni iddia orada da olculur.
    const events = [GRADUATED, GRADUATION_TRANSFER]
    // `fromParentHash` HER ZAMAN O ANDAKI imlecten okunur, sabit yazilmaz:
    // ikinci oynatimda imlec artik `GRAD_BLOCK`tadir ve `hashFor(RANGE_TO)`
    // gecmek `ReorgDetected` verirdi -- yani test, olcmek istedigi seyi degil
    // zincir bagi muhafizini sinardi. (Olculdu: ilk yazimda tam olarak bu
    // oldu.)
    const first = await replayRange(
      pool,
      events,
      GRAD_BLOCK,
      hashFor(GRAD_BLOCK),
      await cursorHash(),
    )
    expect(first.graduated).toBe(1)
    expect(first.transfers).toBe(1)

    const after = await snapshot(pool)
    const second = await replayRange(
      pool,
      events,
      GRAD_BLOCK,
      hashFor(GRAD_BLOCK),
      await cursorHash(),
    )
    expect(second).toEqual({
      launches: 0,
      trades: 0,
      completed: 0,
      graduated: 0,
      transfers: 0,
      fees: 0,
      cursorMoved: 0,
      total: 0,
    })
    expect(await snapshot(pool)).toEqual(after)
  })

  // -----------------------------------------------------------------
  // (3) CIFT SAYIM YOK.
  // -----------------------------------------------------------------
  it('Graduated TEK BASINA hicbir holder bakiyesine dokunmaz', async () => {
    const balancesBefore = await balances()
    expect(await applyGraduated(pool, GRADUATED)).toBe(1)
    expect(await balances()).toEqual(balancesBefore)
  })

  it('token bacagini tasiyan sey `Transfer`dir ve arz korunur', async () => {
    await replayRange(
      pool,
      [GRADUATED, GRADUATION_TRANSFER],
      GRAD_BLOCK,
      hashFor(GRAD_BLOCK),
      await cursorHash(),
    )
    const after = await balances()
    // Curve bosaldi, hedef `poolSeedSupply` kadar aldi.
    expect(after[CURVE.toLowerCase()] ?? 0n).toBe(0n)
    expect(after[TARGET.toLowerCase()]).toBe(COMPLETED.poolSeedSupplyTok)
    // Ve TOPLAM ARZ hala 1e27: mezuniyet token yaratmaz, yer degistirir.
    const total = Object.values(after).reduce((a, b) => a + b, 0n)
    expect(total).toBe(PROFILE.totalSupplyTok)
  })

  // -----------------------------------------------------------------
  // (4) YARIM YAZILMIS BIR MEZUNIYET SEMA DUZEYINDE IMKANSIZ.
  //
  // Her biri TEK bir alani bozar ve KISITIN ADINI iddia eder -- "bir sey
  // patladi" degil, "BU muhafiz patladi".
  // -----------------------------------------------------------------
  // HER SATIR TAM OLARAK BIR KISITI IHLAL EDER. Ilk yazimda birincisi IKISINI
  // birden ihlal ediyordu ve Postgres `graduated_iff_payout`i once
  // degerlendirdi -- yani test, olcmeyi iddia ettiginden BASKA bir muhafizin
  // adini gorup kirmizi oldu. Iddia bir kisitin ADI uzerindeyse, mutasyon o
  // kisittan BASKASINI tetiklememelidir.
  const brokenRows: [string, string][] = [
    [
      "graduated = true, graduated_seq = NULL, graduation_target_addr = '0x00000000000000000000000000000000deadbeef', graduation_base_tok = 1, graduation_quote_wei = 1",
      'graduated_iff_seq',
    ],
    ['graduated_seq = 1', 'graduated_iff_seq'],
    [
      'graduated = true, graduated_seq = 1, graduation_base_tok = 1, graduation_quote_wei = 1, graduation_target_addr = NULL',
      'graduated_iff_payout',
    ],
    [
      "graduated = true, graduated_seq = 1, graduation_target_addr = '0x00000000000000000000000000000000deadbeef', graduation_quote_wei = 1",
      'graduated_iff_payout',
    ],
    [
      "graduation_target_addr = '0x00000000000000000000000000000000deadbeef'",
      'graduated_iff_payout',
    ],
  ]

  it.each(brokenRows)('yarim mezuniyet reddedilir: %s', async (set, constraint) => {
    try {
      await pool.query(`UPDATE curve_state SET ${set} WHERE token = $1`, [TOKEN])
      throw new Error(`beklenen kisit ihlali olmadi: ${constraint}`)
    } catch (error) {
      const e = error as { code?: string; constraint?: string }
      expect(e.code).toBe('23514')
      expect(e.constraint).toBe(constraint)
    }
  })

  it('MEZUN AMA TAMAMLANMAMIS bir satir yazilamaz (zincirin on kosulu)', async () => {
    // `graduate()` ilk isi olarak `if (!complete) revert NotComplete()` yapar.
    // Uygulama yolu `Completed`i kacirsaydi burasi SESSIZ bir "mezun ama
    // tamamlanmamis" satir uretirdi; kisit onu gurultulu yapar.
    await pool.query(
      `UPDATE curve_state SET complete = false, completed_seq = NULL,
         real_token_reserves_tok = 1 WHERE token = $1`,
      [TOKEN],
    )
    try {
      await applyGraduated(pool, GRADUATED)
      throw new Error('beklenen kisit ihlali olmadi: graduated_implies_complete')
    } catch (error) {
      const e = error as { code?: string; constraint?: string }
      expect(e.code).toBe('23514')
      expect(e.constraint).toBe('graduated_implies_complete')
    }
  })

  // -----------------------------------------------------------------
  // (5) OKUMA MODELI.
  // -----------------------------------------------------------------
  it('token_overview terminal durumu SOYLER, fiyati susturmadan', async () => {
    const beforeRead = await getTokenOverview(pool, TOKEN)
    const before = beforeRead.rows
    if (before === null) throw new Error('token_overview satiri yok')
    expect(before.complete).toBe(true)
    expect(before.graduated).toBe(false)
    expect(before.graduatedSeq).toBeNull()
    expect(before.graduationTargetAddr).toBeNull()
    expect(before.graduationBaseTok).toBeNull()
    expect(before.graduationQuoteWei).toBeNull()

    await applyGraduated(pool, GRADUATED)

    const afterRead = await getTokenOverview(pool, TOKEN)
    const after = afterRead.rows
    if (after === null) throw new Error('token_overview satiri yok')
    expect(after.graduated).toBe(true)
    expect(after.graduatedSeq).toBe(GRADUATED.eventSeq)
    expect(after.graduationTargetAddr).toBe(TARGET)
    expect(after.graduationBaseTok).toBe(GRADUATED.baseAmountTok)
    expect(after.graduationQuoteWei).toBe(GRADUATED.quoteAmountWei)

    // FIYAT SILINMEZ VE BU BILINCLIDIR: mezuniyet fiyat gecmisini KOPARMAZ
    // (spec 6.2) ve bu deger o gecmisin son noktasidir. Degismemis olmasi
    // ise tam olarak tehlikenin kendisidir -- ayni sayi, artik canli degil --
    // ve `graduated` onu ETIKETLEYEN alandir.
    expect(after.marketCapWei).toBe(before.marketCapWei)
    expect(after.priceWeiPerTok).toBe(before.priceWeiPerTok)
    expect(after.progressPpm).toBe(1_000_000)
  })

  it('odenen tutarlar Completed in tasidiklarina esittir -- ama TURETILMEZ', async () => {
    // Zincirde `graduate()` `poolSeedSupply` ve `realQuoteReserves` oder, yani
    // esitlik BEKLENIR. Yine de ayri sutunlarda saklaniyorlar: esitligi
    // VARSAYIP `Completed`den turetmek, odemenin gercekten o degerler uzerinde
    // oldugunu bir daha hicbir yerde OLCEMEZ hale getirirdi. Test esitligi
    // IDDIA eder; sema onu ZORLAMAZ.
    await applyGraduated(pool, GRADUATED)
    const row = await curveRow()
    expect(row['graduation_base_tok']).toBe(row['pool_seed_supply_tok'])
    expect(row['graduation_quote_wei']).toBe(row['real_quote_reserves_wei'])
  })
})

async function balances(): Promise<Record<string, bigint>> {
  const { rows } = await pool.query<{ holder: string; balance_tok: string }>(
    'SELECT holder, balance_tok FROM holders WHERE token = $1 ORDER BY holder',
    [TOKEN],
  )
  const out: Record<string, bigint> = {}
  for (const r of rows) out[r.holder] = BigInt(r.balance_tok)
  return out
}

/** O ANDAKI imlecin hash'i. Sabit bir deger, ikinci oynatimda YANLIS olurdu. */
async function cursorHash(): Promise<string> {
  return (await getCursor(pool))?.lastBlockHash ?? GENESIS
}
