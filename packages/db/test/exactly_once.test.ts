import { beforeEach, describe, expect, it } from 'vitest'
import { applyTrade, applyTransfer, getCursor, replayRange, setCursor } from '../src/apply'
import { ReorgDetected } from '../src/reorg'
import { putDeployment } from '../src/deployment'
import { snapshot } from '../src/snapshot'
import { pool, resetSchema } from './setup'
import {
  ALICE,
  BOB,
  BUY,
  CURVE,
  DEPLOYMENT,
  GENESIS,
  hash32,
  hashFor,
  RANGE,
  RANGE_TO,
  SELL_TRANSFER,
  TOKEN,
} from './fixtures'
import { toSeq } from '../src/seq'

interface PgError extends Error {
  code?: string
  constraint?: string
  column?: string
}

async function failure(fn: () => Promise<unknown>): Promise<PgError> {
  try {
    await fn()
  } catch (error) {
    return error as PgError
  }
  throw new Error('beklenen hata olusmadi')
}

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
    const first = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    expect(first).toEqual({
      launches: 1,
      trades: 3,
      poolSwaps: 0,
      completed: 1,
      // `RANGE` MEZUNIYET ICERMEZ ve icermemeli: zincirde `graduate()` ayri
      // bir islemdir ve arasinda sinirsiz zaman olabilir (canli smoke curve'u
      // su an tam olarak o araliktadir). Sifir burada bir BOSLUK degil, bir
      // IDDIA -- mezuniyetin kendi exactly-once olcumu `graduation.test.ts`te.
      graduated: 0,
      transfers: 4,
      fees: 3,
      cursorMoved: 1,
      total: 13,
    })

    const after = await snapshot(pool)

    const second = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    expect(second).toEqual({
      launches: 0,
      trades: 0,
      poolSwaps: 0,
      completed: 0,
      graduated: 0,
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
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    const after = await snapshot(pool)
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    const third = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    expect(third.total).toBe(0)
    expect(await snapshot(pool)).toEqual(after)
  })

  it('aralik PARCA PARCA oynatildiginda da ayni sonuca varir', async () => {
    // "Test secimindeki bosluk": yukaridaki testler araligi HEP tek parca
    // veriyor. Gercek ingest araligi bloklara boler ve bir tur ortasinda
    // yeniden baslayabilir. Ayni olaylar 12 ayri islemde uygulanip ayni
    // dokumun cikmasi bunu kapatiyor.
    const whole = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    expect(whole.total).toBe(13)
    const oneShot = await stableSnapshot()

    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    let written = 0
    for (const e of RANGE)
      written += (await replayRange(pool, [e], RANGE_TO, hashFor(RANGE_TO), await parentHash()))
        .total
    // Imlec YALNIZCA ilk parcada hareket eder; sonraki 11 kez ayni degere
    // yazmak bir no-op'tur.
    expect(written).toBe(13)

    expect(await stableSnapshot()).toEqual(oneShot)
  })

  it('UST USTE BINEN araliklar cift saymaz', async () => {
    // Bir yeniden baslatma imleci geriye alirsa (ya da bir tur iki kez
    // islenirse) araliklar ortusur. Ilk yedi olay, sonra HEPSI.
    const head = RANGE.slice(0, 7)
    const a = await replayRange(
      pool,
      head,
      RANGE_TO - 2n,
      hashFor(RANGE_TO - 2n),
      await parentHash(),
    )
    expect(a.total).toBe(8) // 7 olay + imlec

    const b = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    // Yalnizca yeni bes olay + imlec.
    expect(b.total).toBe(6)

    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    const clean = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    expect(clean.total).toBe(13)
    const cleanSnap = await stableSnapshot()

    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await replayRange(pool, head, RANGE_TO - 2n, hashFor(RANGE_TO - 2n), await parentHash())
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    // Ustuste binen iki gecis, tek temiz gecisle AYNI veritabanini birakir.
    expect(await stableSnapshot()).toEqual(cleanSnap)
  })

  // ---------------------------------------------------------------
  // ARTIMLI GUNCELLEMENIN neden ayri bir kanit istedigi
  // ---------------------------------------------------------------
  it('holders DELTA tasir: ikinci uygulama bakiyeyi ikiye KATLAMAZ', async () => {
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
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
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
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
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    const { rows } = await pool.query<{ deposited_total_wei: string; claimable_wei: string }>(
      'SELECT deposited_total_wei, claimable_wei FROM fee_balances ORDER BY recipient',
    )
    expect(rows).toHaveLength(2)
    const before = JSON.stringify(rows)

    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    const { rows: after } = await pool.query(
      'SELECT deposited_total_wei, claimable_wei FROM fee_balances ORDER BY recipient',
    )
    expect(JSON.stringify(after)).toBe(before)
  })

  // ---------------------------------------------------------------
  // SIRA MUHAFIZI: `ins` DEGIL, `last_seq` isini yapiyor mu?
  // ---------------------------------------------------------------
  it('hic gorulmemis ESKI bir trade YENI curve durumunu ezmez', async () => {
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
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
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    expect(await setCursor(pool, RANGE_TO - 100n, hashFor(RANGE_TO - 100n), RANGE_TO - 100n)).toBe(
      0,
    )
    expect(await setCursor(pool, RANGE_TO, hashFor(RANGE_TO), RANGE_TO)).toBe(0)
    expect(await setCursor(pool, RANGE_TO + 1n, hashFor(RANGE_TO + 1n), RANGE_TO + 1n)).toBe(1)
    const { rows } = await pool.query<{ last_block: string }>('SELECT last_block FROM sync_state')
    expect(rows[0]?.last_block).toBe((RANGE_TO + 1n).toString())
  })

  // ---------------------------------------------------------------
  // REORG TUTULMASI: imlec BLOK HASH'INI de tasir.
  //
  // Keeper `launchCount()`u biriktirdigi `Launched` loglariyla
  // karsilastiriyor; reorg'la disari dusmus bir kayit o kumeyi FAZLA
  // saydirir. Muhafiz `indexer/src/cursor.ts`teki `assertContinuous`, ve
  // besledigi deger BURADA saklanir.
  // ---------------------------------------------------------------
  it('imlec blok hash ini de tasir ve ileri giderken onu gunceller', async () => {
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    expect(await getCursor(pool)).toEqual({
      lastBlock: RANGE_TO,
      lastBlockHash: hashFor(RANGE_TO),
    })

    // Imlec ilerlerse hash da ilerler -- ikisi ATOMIK olarak birlikte yazilir,
    // yoksa muhafiz bir tur boyunca ESKI zincire karsi kontrol yapardi.
    expect(await setCursor(pool, RANGE_TO + 5n, hashFor(RANGE_TO + 5n), RANGE_TO + 5n)).toBe(1)
    expect(await getCursor(pool)).toEqual({
      lastBlock: RANGE_TO + 5n,
      lastBlockHash: hashFor(RANGE_TO + 5n),
    })

    // Geri giden bir yazim hic olmaz, yani hash de geri gitmez.
    expect(await setCursor(pool, RANGE_TO, hashFor(RANGE_TO), RANGE_TO)).toBe(0)
    expect((await getCursor(pool))?.lastBlockHash).toBe(hashFor(RANGE_TO + 5n))
  })

  it('imlec hash siz yazilamaz ve bicimi zorlanir', async () => {
    // Muhafizin besleyicisi NOT NULL: hash'siz bir imlec, bir sonraki turda
    // karsilastiracak bir sey OLMAMASI demektir ve o sessiz bir bosluktur.
    const e1 = await failure(() =>
      pool.query('INSERT INTO sync_state (id, last_block) VALUES (1, 5)'),
    )
    expect(e1.code).toBe('23502')
    expect(e1.column).toBe('last_block_hash')

    const e2 = await failure(() => setCursor(pool, 5n, '0xnothex', 5n))
    expect(e2).toBeInstanceOf(RangeError)

    const e3 = await failure(() =>
      pool.query('INSERT INTO sync_state (id, last_block, last_block_hash) VALUES (1, 5, $1)', [
        '0xABCDEF',
      ]),
    )
    expect(e3.code).toBe('23514')
    expect(e3.constraint).toBe('sync_state_last_block_hash_check')
  })

  // ---------------------------------------------------------------
  // ZINCIR BAGI ARTIK YAPISAL. Muhafiz `replayRange`'in ICINDE cagriliyor,
  // yani imleci ilerleten tek yolun uzerinde. Onceki hali TAVSIYE
  // NITELIGINDEYDI: `replayRange` onu hic cagirmiyordu ve tek cagirani sabit
  // kodlanmis bir `null` geciyordu, yani calisan hicbir yolda hicbir sey
  // karsilastirilmiyordu.
  // ---------------------------------------------------------------
  it('bag kopuksa replayRange HICBIR SEY yazmaz ve durur', async () => {
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), await parentHash())
    const before = await snapshot(pool)

    // Imlecin blogu icin kaydedilmis hash `hashFor(RANGE_TO)`; farkli bir
    // parent hash, uzerine insa ettigimiz zincirin degistigi anlamina gelir.
    await expect(
      replayRange(pool, RANGE, RANGE_TO + 10n, hashFor(RANGE_TO + 10n), hashFor(999_999n)),
    ).rejects.toBeInstanceOf(ReorgDetected)

    // Aralik ya butunuyle girer ya da hic girmez: imlec DE oynamadi.
    expect(await snapshot(pool)).toEqual(before)
    expect((await getCursor(pool))?.lastBlock).toBe(RANGE_TO)
  })

  it('muhafiz cagriyla degil YAPIYLA saglanir: cagiran onu atlayamaz', async () => {
    // `replayRange`in imzasinda parent hash ZORUNLU. Yanlis bir deger vermek
    // isi durdurur; dogru degeri vermek tek gecerli yoldur. Yani "kontrolu
    // cagirmayi unutmak" diye bir durum yok -- kontrol cagiranin elinde degil.
    await replayRange(pool, RANGE.slice(0, 7), RANGE_TO - 2n, hashFor(RANGE_TO - 2n), GENESIS)
    const cursor = await getCursor(pool)
    expect(cursor?.lastBlockHash).toBe(hashFor(RANGE_TO - 2n))

    // Dogru bag -> devam eder.
    const ok = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), cursor!.lastBlockHash)
    expect(ok.total).toBe(6)
  })

  it('ilk kosuda bag kontrolu YAPILMAZ ve bu dal gercekten kullanilir', async () => {
    // Bos imlecte karsilastirilacak bir sey yok, yani tamamen keyfi bir parent
    // hash bile gecer. Bu dalin var oldugunu ve ULASILDIGINI gosteriyor --
    // yoksa yukaridaki testler "ilk cagri neden reddedilmedi" sorusunu
    // yanitsiz birakirdi.
    expect(await getCursor(pool)).toBeNull()
    const r = await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), hashFor(424_242n))
    expect(r.total).toBe(13)
  })

  it('cursor okumasi bos veritabaninda null doner (ilk kosu)', async () => {
    // `assertContinuous`in `null` dali -- yani "uzerine insa edilmis bir sey
    // yok" durumu -- gercekten ulasilabilir; testte uydurulmus degil.
    expect(await getCursor(pool)).toBeNull()
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
    await expect(
      replayRange(pool, poisoned, RANGE_TO, hashFor(RANGE_TO), await parentHash()),
    ).rejects.toThrow(/token_transfers_token_fkey/)

    for (const table of ['launches', 'trades', 'token_transfers', 'fee_events', 'sync_state']) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`)
      expect(rows[0]?.n, table).toBe(0)
    }
  })
})

/**
 * IKI AYRI KURULUSU karsilastirmak icin. `now()` varsayilanli sutunlar iki
 * bagimsiz kurulusta ZORUNLU olarak farklidir (`applied_at`, `updated_at`,
 * `head_observed_at`, `seen_at`, `volume_24h_refreshed_at`) ve onlarin farki bir idempotency
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
    // `chat_messages.created_at` -- indexer'in YAZMADIGI tek tablo. Tekrar
    // oynatma bu tabloya hic dokunmaz, ama liste KATALOGDAN turedigi icin
    // yeni sutun burada da beyan edilmek zorunda; sessizce kacmasi tam olarak
    // bu iddianin onlemek icin var oldugu sey.
    'chat_messages.created_at',
    'rejected_launches.seen_at',
    'schema_migrations.applied_at',
    'schema_state.updated_at',
    'sync_state.head_observed_at',
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

/**
 * Isledigimiz araligin ILK blogunun `parentHash`'i. Dogru bir zincirde bu,
 * kayitli imlec hash'ine esittir; imlec bossa (ilk kosu) `GENESIS` gecilir ve
 * `assertContinuous` hicbir sey karsilastirmaz. Yanlis bir deger gecmenin ne
 * yaptigini asagidaki "zincir bagi" testleri gosteriyor.
 */
async function parentHash(): Promise<string> {
  return (await getCursor(pool))?.lastBlockHash ?? GENESIS
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
