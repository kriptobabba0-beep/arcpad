import { beforeEach, describe, expect, it } from 'vitest'
import { applyEvent, applyPoolSwap, replayRange, type PoolSwapEvent } from '../src/apply'
import { listTrades } from '../src/queries'
import { toSeq } from '../src/seq'
import { snapshot } from '../src/snapshot'
import { putDeployment } from '../src/deployment'
import {
  ALICE,
  CURVE,
  DEPLOYMENT,
  GENESIS,
  GRADUATED,
  hash32,
  hashFor,
  RANGE,
  RANGE_TO,
  TOKEN,
} from './fixtures'
import { pool, resetSchema } from './setup'

/**
 * ============ `source = 'pool'`: SEMA HAZIRDI, YAZAN YOKTU ============
 *
 * `003_trades_and_curve_state.sql:81` `source`u 2026-07-31'den beri tasiyor ve
 * gerekcesini de yaziyor: "Faz 2'nin havuz islemleri MIGRATION'SIZ girsin
 * diye". O tarihten bu yana HICBIR KOD `'pool'` yazmadi, yani sutun bir
 * niyetin kaydiydi, bir yolun degil.
 *
 * BU DOSYA YAZICI SOZLESMESINI OLCER, `indexer/test/pool-swaps.test.ts` ise
 * CEKME'den YAZIM'a butun yolu. Ayni ozelligi iki kez degil, IKI FARKLI GIRIS
 * NOKTASINDA -- bu deponun 1 numarali ariza sinifi tam olarak "bir giris
 * noktasinda kapsanan ozellik hepsinde kapsanmis okunur".
 */

const POOL_BLOCK = 54_325_600n

function poolSwap(over: Partial<PoolSwapEvent> = {}): PoolSwapEvent {
  const logIndex = over.logIndex ?? 0
  return {
    kind: 'poolSwap',
    eventSeq: toSeq(POOL_BLOCK, logIndex),
    blockNumber: POOL_BLOCK,
    logIndex,
    txHash: hash32(0x5 + logIndex),
    blockTime: new Date('2026-07-30T13:00:00.000Z'),
    token: TOKEN,
    curve: CURVE,
    trader: ALICE,
    isBuy: true,
    tokenAmountTok: 5n * 10n ** 18n,
    quoteAmountWei: 2n * 10n ** 18n,
    protocolFeeWei: 9_500n * 10n ** 12n,
    creatorFeeWei: 3_000n * 10n ** 12n,
    // TURETILMIS REZERVLER (havuzun `sqrtPriceX96`/`liquidity`sinden).
    // Turetme `indexer/src/pool.ts`tedir; bu paket bir YAZICIDIR.
    virtualTokenReservesTok: 200_000_000n * 10n ** 18n,
    virtualQuoteReservesWei: 12n * 10n ** 18n,
    realTokenReservesTok: 200_000_000n * 10n ** 18n,
    realQuoteReservesWei: 12n * 10n ** 18n,
    ...over,
  }
}

async function seedRange(): Promise<void> {
  await putDeployment(pool, DEPLOYMENT)
  await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), GENESIS)
}

async function curveState(): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM curve_state WHERE token = $1',
    [TOKEN],
  )
  return rows[0] as Record<string, unknown>
}

describe('havuz islemleri ayni tabloya `source = pool` ile girer', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedRange()
  })

  it('satir YAZILIR ve `source` pool tur', async () => {
    expect(await applyPoolSwap(pool, poolSwap())).toBe(1)
    const { rows } = await pool.query<{ source: string; trader: string }>(
      'SELECT source, trader FROM trades WHERE event_seq = $1',
      [toSeq(POOL_BLOCK, 0).toString()],
    )
    expect(rows[0]?.source).toBe('pool')
    expect(rows[0]?.trader).toBe(ALICE)
    // VE EGRI SATIRLARI `curve` OLARAK KALIR -- varsayilan degismedi.
    const { rows: curveRows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM trades WHERE source = 'curve'",
    )
    expect(Number(curveRows[0]?.n)).toBeGreaterThan(0)
  })

  /**
   * ASIL AYRIM. `applyTrade` `curve_state`i MUTLAK yazar (`Trade` dort rezervi
   * de tasir). Bir havuz islemi o satira DOKUNMAMALIDIR: egrinin rezervleri
   * mezuniyette DONDU ve havuzun turetilmis rezervleri BASKA BIR VENUE'nun
   * durumudur. `applyTrade`in `cs` CTE'sini kopyalamak, tek bir satiri iki
   * venue'nun durumunu tasiyan bir seye cevirirdi.
   */
  it('curve_state e HIC DOKUNMAZ', async () => {
    const before = await curveState()
    await applyPoolSwap(pool, poolSwap())
    expect(await curveState()).toEqual(before)
  })

  it('hacim ve sayaclar ARTAR -- bunlar TOKEN in olgusudur, venue nun degil', async () => {
    const { rows: before } = await pool.query<{
      volume_total_wei: string
      trade_count: number
      buy_count: number
    }>('SELECT volume_total_wei, trade_count, buy_count FROM token_stats WHERE token = $1', [TOKEN])
    await applyPoolSwap(pool, poolSwap())
    const { rows: after } = await pool.query<{
      volume_total_wei: string
      trade_count: number
      buy_count: number
      last_trade_seq: string
    }>(
      'SELECT volume_total_wei, trade_count, buy_count, last_trade_seq::text FROM token_stats WHERE token = $1',
      [TOKEN],
    )
    expect(BigInt(after[0]!.volume_total_wei)).toBe(
      BigInt(before[0]!.volume_total_wei) + 2n * 10n ** 18n,
    )
    expect(after[0]!.trade_count).toBe(before[0]!.trade_count + 1)
    expect(after[0]!.buy_count).toBe(before[0]!.buy_count + 1)
    expect(after[0]!.last_trade_seq).toBe(toSeq(POOL_BLOCK, 0).toString())
  })

  it('ayni olayi iki kez uygulamak IKINCI seferde hicbir sey yazmaz', async () => {
    expect(await applyPoolSwap(pool, poolSwap())).toBe(1)
    const before = await snapshot(pool)
    expect(await applyPoolSwap(pool, poolSwap())).toBe(0)
    // SAYAC DEGIL DOKUM: "0 dondu" yalnizca defter satirini soyler; hacim
    // artimlidir ve ikinci kez uygulanmadigini ancak dokum gosterir.
    expect(await snapshot(pool)).toEqual(before)
  })

  it('applyEvent uzerinden de calisir (giris noktasi kapsami)', async () => {
    expect(await applyEvent(pool, poolSwap({ logIndex: 1 }))).toBe(1)
  })

  it('replayRange havuz islemlerini AYRI sayar', async () => {
    const result = await replayRange(
      pool,
      [poolSwap({ logIndex: 2 })],
      POOL_BLOCK,
      hashFor(POOL_BLOCK),
      hashFor(RANGE_TO),
    )
    expect(result.poolSwaps).toBe(1)
    expect(result.trades).toBe(0)
  })

  /**
   * TEK LISTE. `listTrades` iki venue'yu ayirt ETMEZ ve etmemeli: "fiyat
   * gecmisi mezuniyette kopmaz" cumlesinin somut karsiligi budur.
   */
  it('listTrades egri ve havuz satirlarini TEK listede, seq sirasinda dondurur', async () => {
    await applyPoolSwap(pool, poolSwap())
    const rows = await listTrades(pool, TOKEN, { limit: 50 })
    expect(rows.length).toBeGreaterThan(3)
    expect(rows[0]?.eventSeq).toBe(toSeq(POOL_BLOCK, 0))
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.eventSeq > rows[i]!.eventSeq).toBe(true)
    }
  })

  /**
   * TEK LISTE, AMA SATIR ARTIK MEKANINI SOYLUYOR.
   *
   * `listTrades` kolonu SECMIYORDU: sema 003'ten beri tasiyordu, yazici
   * 89acc4f'ten beri `'pool'` yaziyordu, ve okuma modeli ikisini de gormuyordu.
   * Sonuc, arayuzun mekani `event_seq > graduated_seq` ile TURETMESIYDI.
   */
  it('her satir kendi `source`unu TASIR -- turetilmis degil, yazilmis', async () => {
    await applyPoolSwap(pool, poolSwap())
    const rows = await listTrades(pool, TOKEN, { limit: 50 })
    const bySeq = new Map(rows.map((r) => [r.eventSeq, r.source]))
    expect(bySeq.get(toSeq(POOL_BLOCK, 0))).toBe('pool')
    // ANTI-VACUITY: liste iki mekani da tasiyor. Hepsi 'pool' olsaydi (ya da
    // hepsi 'curve') asagidaki mutabakat testi hicbir seyi ayirt etmezdi.
    expect(rows.filter((r) => r.source === 'pool').length).toBe(1)
    expect(rows.filter((r) => r.source === 'curve').length).toBeGreaterThan(2)
    // VE TIP DARALDI: `TradeSource` iki degerlidir, `string` degil.
    for (const row of rows) expect(['curve', 'pool']).toContain(row.source)
  })
})

/**
 * ==========================================================================
 *  IKI OLGU, VE ARTIK CELISEBILIRLER -- BU YUZDEN MUTABAKAT KOSULUYOR.
 * ==========================================================================
 *
 * `source` gercek olunca ayni soruya iki cevap dogar:
 *
 *   1. `trades.source`      -- satiri UREten cozucu yazar. Satir basina olgu.
 *   2. `event_seq > graduated_seq` -- token basina bir sinirdan TURETILIR.
 *
 * Ikisi ZORUNLU olarak ayni bolumlemeyi vermeli: mezuniyetten sonra hicbir
 * egri islemi olamaz (`CurveComplete()`), mezuniyetten once hicbir havuz
 * islemi olamaz (`ArcpadLocker.graduate` havuzu AYNI islemde, `Graduated`
 * logundan SONRA acar) ve `event_seq = block << 20 | logIndex` o sirayi
 * korur.
 *
 * ARAYUZ ARTIK YALNIZCA (1)'I KULLANIYOR (`web/components/token/venue.ts`).
 * Yani (2) ile ayni cevabi verdigini ISPATLAYAN tek yer burasi -- ve burasi,
 * iki olgunun da GERCEK satirlar uzerinde birlikte bulundugu tek katman.
 * Fixture uzerinde degil, gercek bir Postgres'te kosuluyor.
 */
describe('`source` ile `graduated_seq` turetmesi AYNI bolumlemeyi verir', () => {
  const AFTER_GRADUATION = 54_325_600n

  async function graduatedSeq(): Promise<bigint> {
    const { rows } = await pool.query<{ s: string | null }>(
      'SELECT graduated_seq::text AS s FROM curve_state WHERE token = $1',
      [TOKEN],
    )
    const s = rows[0]?.s
    if (s == null) throw new Error('the fixture did not graduate -- this gate cannot run')
    return BigInt(s)
  }

  /** Bir satirin IKI cevabi ayrisiyor mu. Bos liste = mutabakat. */
  function disagreements(
    rows: readonly { eventSeq: bigint; source: 'curve' | 'pool' }[],
    seam: bigint,
  ): readonly { eventSeq: bigint; declared: string; derived: string }[] {
    return rows
      .map((r) => ({
        eventSeq: r.eventSeq,
        declared: r.source,
        derived: r.eventSeq > seam ? 'pool' : 'curve',
      }))
      .filter((r) => r.declared !== r.derived)
  }

  beforeEach(async () => {
    await resetSchema()
    await seedRange()
    // Mezuniyet `RANGE`e DAHIL DEGILDIR (fixtures.ts'in gerekcesi); mekan
    // sinirinin var olmasi icin burada ayrica uygulanir.
    await applyEvent(pool, GRADUATED)
    await applyPoolSwap(pool, poolSwap({ logIndex: 0 }))
    await applyPoolSwap(pool, poolSwap({ logIndex: 1 }))
  })

  it('gercek satirlarda ikisi TAM olarak ortusur', async () => {
    const seam = await graduatedSeq()
    const rows = await listTrades(pool, TOKEN, { limit: 200 })

    // ANTI-VACUITY, UC PARCA: sinirin IKI yaninda da satir var, iki mekan da
    // temsil ediliyor, ve sinir gercekten iceride. Bunlar olmadan "ayrisma
    // yok" iddiasi bos bir kumeden gelebilirdi.
    expect(rows.filter((r) => r.eventSeq < seam).length).toBeGreaterThan(0)
    expect(rows.filter((r) => r.eventSeq > seam).length).toBe(2)
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['curve', 'pool']))

    expect(disagreements(rows, seam)).toEqual([])
  })

  /**
   * KONTROL: KARSILASTIRMA GERCEKTEN AYRISMA GOREBILIYOR.
   *
   * Yukaridaki iddia, `disagreements` her zaman bos donse de gecerdi. Burada
   * mezuniyetten SONRAKI bir satir kasitli olarak `'curve'` yazilir -- zincirde
   * IMKANSIZ bir satir -- ve karsilastirma onu GORMEK zorundadir.
   */
  it('KONTROL: mezuniyetten sonraki bir `curve` satiri AYRISMA olarak gorunur', async () => {
    const seam = await graduatedSeq()
    const impossible = toSeq(AFTER_GRADUATION, 7)
    await pool.query(
      `INSERT INTO trades (event_seq, block_number, log_index, tx_hash, block_time, token, curve,
         trader, is_buy, token_amount_tok, quote_amount_wei, protocol_fee_wei, creator_fee_wei,
         virtual_token_reserves_tok, virtual_quote_reserves_wei, real_token_reserves_tok,
         real_quote_reserves_wei, source)
       VALUES ($1,$2,7,$3,now(),$4,$5,$6,true,1,1,0,0,1,1,1,1,'curve')`,
      [impossible.toString(), AFTER_GRADUATION.toString(), hash32(0x77), TOKEN, CURVE, ALICE],
    )
    const rows = await listTrades(pool, TOKEN, { limit: 200 })
    const found = disagreements(rows, seam)
    expect(found).toHaveLength(1)
    expect(found[0]?.eventSeq).toBe(impossible)
    expect(found[0]).toMatchObject({ declared: 'curve', derived: 'pool' })
  })
})

/**
 * ============ 012: MIKTAR KISITLARI VENUE'YA GORE ============
 *
 * Kisit gevsetilmeseydi 1 wei'lik bir toz satisi (`0` quote birimi getirir --
 * 18 ve 6 decimal arasindaki 10^12'lik fark) INSERT'i patlatir, araligi geri
 * alir ve indexer'i KALICI olarak durdururdu.
 */
describe('miktar kisitlari venue ya gore', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedRange()
  })

  it('havuz satirinda quote SIFIR olabilir', async () => {
    expect(await applyPoolSwap(pool, poolSwap({ quoteAmountWei: 0n }))).toBe(1)
  })

  it('havuz satirinda token SIFIR olabilir', async () => {
    expect(await applyPoolSwap(pool, poolSwap({ tokenAmountTok: 0n }))).toBe(1)
  })

  /**
   * VE EGRI ICIN ESKI, DAHA GUCLU KISIT AYNEN DURUYOR. Zincir garantisi
   * (`ZeroTokensOut`/`ZeroTokensIn`/`NetTooSmall`) semadan SILINMEDI --
   * silinmesi, gevsetmenin icine gizlenmis bir gerileme olurdu.
   */
  it('EGRI satirinda sifir miktar hala REDDEDILIR', async () => {
    await expect(
      pool.query(
        `INSERT INTO trades (event_seq, block_number, log_index, tx_hash, block_time, token, curve,
           trader, is_buy, token_amount_tok, quote_amount_wei, protocol_fee_wei, creator_fee_wei,
           virtual_token_reserves_tok, virtual_quote_reserves_wei, real_token_reserves_tok,
           real_quote_reserves_wei, source)
         VALUES ($1,$2,0,$3,now(),$4,$5,$6,true,0,1,0,0,1,1,1,1,'curve')`,
        [toSeq(POOL_BLOCK, 9).toString(), POOL_BLOCK.toString(), hash32(0x9), TOKEN, CURVE, ALICE],
      ),
    ).rejects.toThrow(/trades_curve_amounts_are_positive/)
  })

  it('NEGATIF miktar HER IKI venue da REDDEDILIR', async () => {
    for (const source of ['curve', 'pool']) {
      await expect(
        pool.query(
          `INSERT INTO trades (event_seq, block_number, log_index, tx_hash, block_time, token, curve,
             trader, is_buy, token_amount_tok, quote_amount_wei, protocol_fee_wei, creator_fee_wei,
             virtual_token_reserves_tok, virtual_quote_reserves_wei, real_token_reserves_tok,
             real_quote_reserves_wei, source)
           VALUES ($1,$2,0,$3,now(),$4,$5,$6,true,-1,1,0,0,1,1,1,1,$7)`,
          [
            toSeq(POOL_BLOCK, source === 'curve' ? 10 : 11).toString(),
            POOL_BLOCK.toString(),
            hash32(0xa),
            TOKEN,
            CURVE,
            ALICE,
            source,
          ],
        ),
      ).rejects.toThrow(/trades_amounts_are_not_negative/)
    }
  })
})
