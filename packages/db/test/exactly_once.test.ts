import { beforeEach, describe, expect, it } from 'vitest'
import { applyTrade, applyTransfer, replayRange, setCursor } from '../src/apply'
import { putDeployment } from '../src/deployment'
import { snapshot } from '../src/snapshot'
import { pool, resetSchema } from './setup'
import {
  ALICE,
  BOB,
  BUY,
  CURVE,
  DEPLOYMENT,
  hash32,
  RANGE,
  RANGE_TO,
  SELL_TRANSFER,
  TOKEN,
} from './fixtures'
import { toSeq } from '../src/seq'

describe('exactly-once ingestion', () => {
  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
  })

  // ---------------------------------------------------------------
  // ASIL IDDIA. "Birincil anahtar bunu kapsar" diye AKIL YURUTULMUYOR; ayni
  // aralik iki kez oynatiliyor ve ikinci gecisin HICBIR SEY yazmadigi hem
  // sayaclarla hem de veritabaninin TAM DOKUMUYLE gosteriliyor.
  // ---------------------------------------------------------------
  it('ayni araligi iki kez oynatmak ikinci seferde hicbir sey yazmaz', async () => {
    const first = await replayRange(pool, RANGE, RANGE_TO)
    expect(first).toEqual({
      launches: 1,
      trades: 3,
      completed: 1,
      transfers: 4,
      fees: 3,
      cursorMoved: 1,
      total: 13,
    })

    const after = await snapshot(pool)

    const second = await replayRange(pool, RANGE, RANGE_TO)
    expect(second).toEqual({
      launches: 0,
      trades: 0,
      completed: 0,
      transfers: 0,
      fees: 0,
      cursorMoved: 0,
      total: 0,
    })

    // Sayaclar "hicbir satir yazilmadi" der. Dokum "hicbir DEGER degismedi"
    // der, ki asil istenen budur: artimli bir guncelleme ikinci kez
    // uygulansaydi sayac yine 0 gorunurdu ama bakiye iki katina cikardi.
    expect(await snapshot(pool)).toEqual(after)
  })

  it('UCUNCU oynatim da bir no-op (idempotency bir kereye mahsus degil)', async () => {
    await replayRange(pool, RANGE, RANGE_TO)
    const after = await snapshot(pool)
    await replayRange(pool, RANGE, RANGE_TO)
    const third = await replayRange(pool, RANGE, RANGE_TO)
    expect(third.total).toBe(0)
    expect(await snapshot(pool)).toEqual(after)
  })

  it('aralik PARCA PARCA oynatildiginda da ayni sonuca varir', async () => {
    // "Test secimindeki bosluk": yukaridaki testler araligi HEP tek parca
    // veriyor. Gercek ingest araligi bloklara boler ve bir tur ortasinda
    // yeniden baslayabilir. Ayni olaylar 12 ayri islemde uygulanip ayni
    // dokumun cikmasi bunu kapatiyor.
    const whole = await replayRange(pool, RANGE, RANGE_TO)
    expect(whole.total).toBe(13)
    const oneShot = await stableSnapshot()

    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    let written = 0
    for (const e of RANGE) written += (await replayRange(pool, [e], RANGE_TO)).total
    // Imlec YALNIZCA ilk parcada hareket eder; sonraki 11 kez ayni degere
    // yazmak bir no-op'tur.
    expect(written).toBe(13)

    expect(await stableSnapshot()).toEqual(oneShot)
  })

  it('UST USTE BINEN araliklar cift saymaz', async () => {
    // Bir yeniden baslatma imleci geriye alirsa (ya da bir tur iki kez
    // islenirse) araliklar ortusur. Ilk yedi olay, sonra HEPSI.
    const head = RANGE.slice(0, 7)
    const a = await replayRange(pool, head, RANGE_TO - 2n)
    expect(a.total).toBe(8) // 7 olay + imlec

    const b = await replayRange(pool, RANGE, RANGE_TO)
    // Yalnizca yeni bes olay + imlec.
    expect(b.total).toBe(6)

    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    const clean = await replayRange(pool, RANGE, RANGE_TO)
    expect(clean.total).toBe(13)
    const cleanSnap = await stableSnapshot()

    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await replayRange(pool, head, RANGE_TO - 2n)
    await replayRange(pool, RANGE, RANGE_TO)
    // Ustuste binen iki gecis, tek temiz gecisle AYNI veritabanini birakir.
    expect(await stableSnapshot()).toEqual(cleanSnap)
  })

  // ---------------------------------------------------------------
  // ARTIMLI GUNCELLEMENIN neden ayri bir kanit istedigi
  // ---------------------------------------------------------------
  it('holders DELTA tasir: ikinci uygulama bakiyeyi ikiye KATLAMAZ', async () => {
    await replayRange(pool, RANGE, RANGE_TO)
    const before = await balance(ALICE)
    expect(before).toBeGreaterThan(0n)

    // Ayni transfer'i DOGRUDAN, aralik disindan tekrar uygula.
    const n = await applyTransfer(pool, SELL_TRANSFER)
    expect(n).toBe(0)
    expect(await balance(ALICE)).toBe(before)
  })

  it('token_transfers satiri elle silinirse delta TEKRAR uygulanir (defterin rolu)', async () => {
    // NEGATIF KONTROL. Yukaridaki testin gectigi sebep "defter satiri zaten
    // vardi" olmali. Defter satirini kaldirinca AYNI cagri bu kez YAZMALI --
    // yoksa idempotency baska, adi konmamis bir sebepten geliyor demektir.
    await replayRange(pool, RANGE, RANGE_TO)
    const before = await balance(ALICE)

    await pool.query('DELETE FROM token_transfers WHERE event_seq = $1', [
      SELL_TRANSFER.eventSeq.toString(),
    ])
    const n = await applyTransfer(pool, SELL_TRANSFER)
    expect(n).toBe(1)
    // Delta GERCEKTEN yeniden uygulandi: ALICE bir kez daha gonderdi.
    expect(await balance(ALICE)).toBe(before - SELL_TRANSFER.amountTok)
  })

  it('fee_balances de artimlidir ve ayni sekilde korunur', async () => {
    await replayRange(pool, RANGE, RANGE_TO)
    const { rows } = await pool.query<{ deposited_total_wei: string; claimable_wei: string }>(
      'SELECT deposited_total_wei, claimable_wei FROM fee_balances ORDER BY recipient',
    )
    expect(rows).toHaveLength(2)
    const before = JSON.stringify(rows)

    await replayRange(pool, RANGE, RANGE_TO)
    const { rows: after } = await pool.query(
      'SELECT deposited_total_wei, claimable_wei FROM fee_balances ORDER BY recipient',
    )
    expect(JSON.stringify(after)).toBe(before)
  })

  // ---------------------------------------------------------------
  // SIRA MUHAFIZI: `ins` DEGIL, `last_seq` isini yapiyor mu?
  // ---------------------------------------------------------------
  it('hic gorulmemis ESKI bir trade YENI curve durumunu ezmez', async () => {
    await replayRange(pool, RANGE, RANGE_TO)
    const stateBefore = await curveState()

    // Daha ONCEKI bir blokta, HENUZ YAZILMAMIS bir islem. `ins` onu KABUL
    // eder (event_seq yeni), yani onu durdurabilecek tek sey `last_seq`
    // muhafizidir.
    const late = {
      ...BUY,
      eventSeq: toSeq(BUY.blockNumber, BUY.logIndex + 1),
      logIndex: BUY.logIndex + 1,
      txHash: hash32(0xbeef),
      trader: BOB,
    }
    expect(late.eventSeq).toBeLessThan(BigInt(String(stateBefore['last_seq'])))

    const n = await applyTrade(pool, late)
    expect(n).toBe(1) // defter satiri YAZILDI
    // ...ama mutlak durum DEGISMEDI.
    expect(await curveState()).toEqual(stateBefore)

    // Buna karsilik ARTIMLI toplamlar dogru sekilde ARTTI: gec gelen bir
    // islem hacme katilir. Iki davranisin AYRI olmasi kasitlidir.
    const { rows } = await pool.query<{ trade_count: number }>(
      'SELECT trade_count FROM token_stats WHERE token = $1',
      [TOKEN],
    )
    expect(rows[0]?.trade_count).toBe(4)
  })

  it('imlec geri gitmez', async () => {
    await replayRange(pool, RANGE, RANGE_TO)
    expect(await setCursor(pool, RANGE_TO - 100n)).toBe(0)
    expect(await setCursor(pool, RANGE_TO)).toBe(0)
    expect(await setCursor(pool, RANGE_TO + 1n)).toBe(1)
    const { rows } = await pool.query<{ last_block: string }>('SELECT last_block FROM sync_state')
    expect(rows[0]?.last_block).toBe((RANGE_TO + 1n).toString())
  })

  it('aralik ya butunuyle girer ya da hic girmez', async () => {
    // Araligin SONUNA, hic launch edilmemis bir token'in transfer'i eklenir:
    // yabanci anahtar patlar ve ARALIGIN TAMAMI geri alinir. Yarim aralik +
    // ilerlemis imlec, veri kaybinin geri alinamaz bicimidir.
    //
    // ILK DENEME BOYLE DEGILDI ve YANLIS SEBEPTEN gecmisti: `Completed`
    // olayinin token'ini bozmak hata VERMEZ, cunku `applyCompleted` bir
    // UPDATE'tir ve eslesmeyen WHERE sifir satir gunceller. Testin cakmasi
    // bunu gosterdi.
    const poisoned = [...RANGE, { ...SELL_TRANSFER, eventSeq: toSeq(99_000_000n, 0), token: BOB }]
    await expect(replayRange(pool, poisoned, RANGE_TO)).rejects.toThrow(
      /token_transfers_token_fkey/,
    )

    for (const table of ['launches', 'trades', 'token_transfers', 'fee_events', 'sync_state']) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`)
      expect(rows[0]?.n, table).toBe(0)
    }
  })
})

/**
 * IKI AYRI KURULUSU karsilastirmak icin. `now()` varsayilanli sutunlar iki
 * bagimsiz kurulusta ZORUNLU olarak farklidir (`applied_at`, `updated_at`,
 * `seen_at`, `volume_24h_refreshed_at`) ve onlarin farki bir idempotency
 * ihlali DEGILDIR.
 *
 * Liste KATALOGDAN turer, elle yazilmaz -- ve asagida iceriginin ne oldugu
 * ayrica IDDIA EDILIR, ki bir gun birinin ekleyecegi `now()` varsayilanli yeni
 * bir sutun sessizce karsilastirmanin disina kacmasin. AYNI veritabani
 * uzerindeki tekrar-oynatim testleri bu yumusatmayi KULLANMAZ; onlar ham
 * `snapshot()` ile, sutunlarin TAMAMI dahil karsilastirilir.
 */
async function stableSnapshot(): Promise<Record<string, unknown[]>> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_default LIKE '%now()%'
    ORDER BY 1, 2`)
  expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
    'rejected_launches.seen_at',
    'schema_migrations.applied_at',
    'sync_state.updated_at',
    'token_stats.volume_24h_refreshed_at',
  ])
  const snap = await snapshot(pool)
  for (const { table_name, column_name } of rows) {
    for (const row of snap[table_name] ?? []) {
      delete (row as Record<string, unknown>)[column_name]
    }
  }
  return snap
}

async function balance(holder: string): Promise<bigint> {
  const { rows } = await pool.query<{ balance_tok: string }>(
    'SELECT balance_tok FROM holders WHERE token = $1 AND holder = $2',
    [TOKEN, holder],
  )
  return BigInt(rows[0]?.balance_tok ?? '0')
}

async function curveState(): Promise<Record<string, unknown>> {
  const { rows } = await pool.query('SELECT * FROM curve_state WHERE curve = $1', [CURVE])
  return rows[0] as Record<string, unknown>
}
