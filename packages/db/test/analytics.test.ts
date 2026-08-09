import { beforeEach, describe, expect, it } from 'vitest'
import { applyEvent, applyPoolSwap, type PoolSwapEvent, replayRange } from '../src/apply'
import { putDeployment } from '../src/deployment'
import {
  encodePositionCursor,
  getCreatorEarnings,
  getProtocolStats,
  listProtocolDaily,
  listPositionsByHolder,
  listTradesByTrader,
  parsePositionCursor,
} from '../src/queries'
import { toSeq } from '../src/seq'
import type { PoolClient } from '../src/pool'
import {
  addr,
  ALICE,
  BOB,
  CREATOR,
  CURVE,
  DEPLOYMENT,
  GENESIS,
  hash32,
  hashFor,
  RANGE,
  RANGE_TO,
  TOKEN,
} from './fixtures'
import { pool, resetSchema } from './setup'

/**
 * ==========================================================================
 *  FAZ 5'IN OKUMA SORGULARI: /analytics VE /profile/[address]
 * ==========================================================================
 *
 * `protocol_stats_daily` YOKTUR ve bu dosya onu KURMAZ. Gerekce
 * `src/queries.ts`in Faz 5 bolumunun basindadir; burada olculen sey, o tablo
 * olmadan turetilen sayilarin DOGRU olmasidir -- ozellikle de gun kovalarinin,
 * cunku bir gun kovasi bir kere yanlis kurulunca hicbir sey sikayet etmez.
 */

/** RANGE'in UC curve islemi, ELLE toplandi -- kutuphaneyi cagirarak DEGIL. */
const RANGE_VOLUME_WEI = 939_000_000_000_000_000n // 28e15 + 11e15 + 900e15
const RANGE_PROTOCOL_FEE_WEI = 8_920_500_000_000_000n // 266e12 + 104,5e12 + 8550e12
const RANGE_CREATOR_FEE_WEI = 2_817_000_000_000_000n // 84e12 + 33e12 + 2700e12
const RANGE_TRADE_COUNT = 3

/** `CREATOR_FEE`in tutari. Tek launch'a atfedilebilen tek depozito. */
const ATTRIBUTED_CREATOR_WEI = 84_000_000_000_000n

/**
 * PAYLASILAN ESCROW'UN ONEKI, ZINCIRDE OLCULDU (2026-08-09).
 *
 * Faz 2 Faz 1'in escrow'unu YENIDEN KULLANDI. Escrow ALICIYA gore
 * anahtarlidir, yani defterde superseded factory'nin curve'lerinden gelmis
 * depozitolar var ve o curve'lerin `launches` satiri YOK. Bu sayi, tam olarak
 * `listCreatorEarningsByLaunch`in ICSEL JOIN'inden dusen tutardir.
 */
const PREFIX_DEPOSIT_WEI = 36_496_595_214_216_153n

/** Superseded fabrikanin bir curve'u: `curve_state`te satiri YOK. */
const PREFIX_CURVE = addr(0x0d75)
/** `ArcpadHook`. Havuz ucretlerinin `Deposited.from`u; bir curve DEGIL. */
const HOOK = addr(0xd951)

async function seedRange(): Promise<void> {
  await putDeployment(pool, DEPLOYMENT)
  await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), GENESIS)
}

/**
 * ZAMANI `now()`A GORE KURAR, SABIT BIR TARIHE GORE DEGIL.
 *
 * Fixture'lar 2026-07-30'u tasiyor. 30 gunluk bir pencereye gore sabit bir
 * tarih, takvim ilerledikce sessizce pencerenin DISINA cikar ve testler bir
 * gun kendiliginden yesilden kirmiziya -- ya da daha kotusu, bos bir seriyi
 * "dogru" sayarak yesilden yesile -- gecer. Zaman burada GORECELIDIR.
 */
async function ageTrades(offsets: readonly number[]): Promise<void> {
  const { rows } = await pool.query<{ event_seq: string }>(
    'SELECT event_seq::text AS event_seq FROM trades ORDER BY event_seq ASC',
  )
  expect(rows).toHaveLength(offsets.length)
  for (const [i, row] of rows.entries()) {
    await pool.query(
      `UPDATE trades SET block_time = date_trunc('day', now() AT TIME ZONE 'UTC')
                         + interval '12 hours' - make_interval(days => $2::int)
        WHERE event_seq = $1::bigint`,
      [row.event_seq, offsets[i] as number],
    )
  }
}

/** Ayni gerekce, launch tarafi: sabit bir tarih pencereden kayar. */
async function ageLaunches(days: number): Promise<void> {
  await pool.query(
    `UPDATE launches SET created_at = date_trunc('day', now() AT TIME ZONE 'UTC')
                          + interval '9 hours' - make_interval(days => $1::int)`,
    [days],
  )
}

/**
 * BIR SATIRI KOLON ADLARINDAN KOPYALAR, KONUMDAN DEGIL.
 *
 * Ilk hali kolonlari ELLE sayiyordu ve `token_stats`in bir kolonu daha oldugu
 * anda "volume_24h_refreshed_at is of type timestamptz but expression is of
 * type integer" ile patladi. Konumsal bir kopya, semanin BUGUNKU genisligine
 * bagli bir onkosuldur ve o onkosul hicbir yerde yazili degildir -- yani
 * kaydigi gun testin YANLIS seyi olcmesi de mumkundu. Katalogdan turetmek o
 * bagi tamamen keser.
 */
async function cloneRow(
  table: string,
  keyColumn: string,
  keyValue: string,
  overrides: Record<string, string>,
): Promise<void> {
  const { rows: cols } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  )
  expect(cols.length, `${table} has no columns`).toBeGreaterThan(0)
  const params: string[] = [keyValue]
  const projection = cols.map((c) => {
    const override = overrides[c.column_name]
    if (override === undefined) return `t.${c.column_name}`
    params.push(override)
    // TIP HEDEF KOLONDAN COZULUR: `INSERT ... SELECT` parametrenin tipini
    // hedef kolondan cikarir, yani burada elle bir cast YAZILMAZ (yazilsaydi
    // hedefin tipini ikinci kez, ve yanlis yerde, iddia etmis olurduk).
    return `$${params.length}`
  })
  await pool.query(
    `INSERT INTO ${table} SELECT ${projection.join(', ')} FROM ${table} t
      WHERE t.${keyColumn} = $1`,
    params,
  )
}

function poolSwap(over: Partial<PoolSwapEvent> = {}): PoolSwapEvent {
  const logIndex = over.logIndex ?? 0
  const block = 54_325_900n
  return {
    kind: 'poolSwap',
    eventSeq: toSeq(block, logIndex),
    blockNumber: block,
    logIndex,
    txHash: hash32(0x900 + logIndex),
    blockTime: new Date(),
    token: TOKEN,
    curve: CURVE,
    trader: ALICE,
    isBuy: true,
    tokenAmountTok: 5n * 10n ** 18n,
    quoteAmountWei: 2n * 10n ** 18n,
    protocolFeeWei: 9_500n * 10n ** 12n,
    creatorFeeWei: 3_000n * 10n ** 12n,
    virtualTokenReservesTok: 200_000_000n * 10n ** 18n,
    virtualQuoteReservesWei: 12n * 10n ** 18n,
    realTokenReservesTok: 200_000_000n * 10n ** 18n,
    realQuoteReservesWei: 12n * 10n ** 18n,
    ...over,
  }
}

// ===========================================================================
//  getProtocolStats
// ===========================================================================

describe('getProtocolStats', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedRange()
  })

  it('tum zaman toplamlari ELLE turetilen sayilarla birebir', async () => {
    const { rows } = await getProtocolStats(pool)
    expect(rows.windowHours).toBeNull()
    expect(rows.volumeWei).toBe(RANGE_VOLUME_WEI)
    expect(rows.tradeCount).toBe(RANGE_TRADE_COUNT)
    expect(rows.protocolFeeWei).toBe(RANGE_PROTOCOL_FEE_WEI)
    expect(rows.creatorFeeWei).toBe(RANGE_CREATOR_FEE_WEI)
    expect(rows.launchCount).toBe(1)
    expect(rows.creatorCount).toBe(1)
  })

  /**
   * `trades`TEN TURETILEN "PROTOKOL GELIRI" ESCROW DEFTERINDEN FARKLIDIR, VE
   * FARKIN YONU SABITTIR.
   *
   * Ikisi ayni parayi iki farkli kapsamda sayar: `trades` yalnizca
   * INDEKSLENEN launch'lari tasir, `fee_balances` ise escrow'a inen HER
   * depozitoyu. Asagida oneki ekliyoruz ve olcuyoruz: defter buyur, toplam
   * SABIT KALIR. Bu iki sayiyi toplayan ya da esit sanan bir ekran yanlistir.
   */
  it('escrow defteri buyurken trades tabanli gelir SABIT kalir', async () => {
    const ledger = async () => {
      const { rows } = await pool.query<{ d: string }>(
        'SELECT deposited_total_wei::text AS d FROM fee_balances WHERE recipient = $1',
        [DEPLOYMENT.protocolTreasury],
      )
      return BigInt(rows[0]!.d)
    }
    const feesBefore = (await getProtocolStats(pool)).rows.protocolFeeWei
    const ledgerBefore = await ledger()

    /*
     * IKI SAYI ZATEN AYRISMIS DURUMDA, VE BU FIXTURE'IN KUSURU DEGIL ZINCIRIN
     * SEKLI: `trades.protocol_fee_wei` her islemin ucretini tasir, escrow
     * defteri ise yalnizca GORULEN `Deposited` olaylarini. Ikisi ayni parayi
     * IKI FARKLI KAPSAMDA sayar ve esit olmalari icin hicbir sebep yoktur.
     */
    expect(ledgerBefore).not.toBe(feesBefore)

    await applyEvent(pool, {
      kind: 'fee',
      eventSeq: toSeq(54_325_700n, 0),
      blockNumber: 54_325_700n,
      logIndex: 0,
      txHash: hash32(0x7001),
      blockTime: new Date(),
      feeKind: 'deposit',
      recipient: DEPLOYMENT.protocolTreasury,
      from: PREFIX_CURVE,
      amountWei: PREFIX_DEPOSIT_WEI,
    })

    // DEFTER BUYUDU, TURETILEN GELIR KIMILDAMADI. Bir ekranin bu ikisini
    // toplamasi ya da esit sanmasi, iste tam olarak buradaki farki yutar.
    expect(await ledger()).toBe(ledgerBefore + PREFIX_DEPOSIT_WEI)
    expect((await getProtocolStats(pool)).rows.protocolFeeWei).toBe(feesBefore)
    expect(feesBefore).toBe(RANGE_PROTOCOL_FEE_WEI)
  })

  it('havuz islemleri toplam hacme GIRER ve mekan ayrimi da tasinir', async () => {
    expect((await getProtocolStats(pool)).rows.poolTradeCount).toBe(0)
    await applyPoolSwap(pool, poolSwap())
    const { rows } = await getProtocolStats(pool)
    expect(rows.poolTradeCount).toBe(1)
    expect(rows.poolVolumeWei).toBe(2n * 10n ** 18n)
    expect(rows.tradeCount).toBe(RANGE_TRADE_COUNT + 1)
    expect(rows.volumeWei).toBe(RANGE_VOLUME_WEI + 2n * 10n ** 18n)
  })

  /**
   * PENCERE `null`A KATLANMAZ.
   *
   * `windowHours: 0` "sifir saat" demektir ve dogru cevabi BOS kumedir; onu
   * "tum zaman"a cevirmek, bir hesaplama hatasinin butun gecmisi "son 24 saat"
   * diye gostermesi demek olurdu. Clamp `1`e ceker, `null`a DEGIL.
   */
  it('sifir/negatif pencere TUM ZAMAN olmaz', async () => {
    await ageTrades([10, 10, 10])
    for (const w of [0, -5]) {
      const { rows } = await getProtocolStats(pool, { windowHours: w })
      expect(rows.windowHours).toBe(1)
      expect(rows.tradeCount).toBe(0)
    }
    expect((await getProtocolStats(pool, { windowHours: null })).rows.tradeCount).toBe(
      RANGE_TRADE_COUNT,
    )
  })

  it('24 saatlik pencere eski islemleri DISARIDA birakir', async () => {
    // Ikisi bugun, biri on gun once.
    await ageTrades([0, 0, 10])
    expect((await getProtocolStats(pool, { windowHours: 24 })).rows.tradeCount).toBe(2)
    expect((await getProtocolStats(pool, { windowHours: null })).rows.tradeCount).toBe(3)
  })

  it('tazelik sayilarla BIRLIKTE doner (cagiran onu almayi unutamaz)', async () => {
    const result = await getProtocolStats(pool)
    expect(result.indexer).toHaveProperty('stale')
  })
})

// ===========================================================================
//  listProtocolDaily
// ===========================================================================

describe('listProtocolDaily', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedRange()
  })

  it('istenen gun sayisi kadar satir doner, ARDISIK ve ARTAN', async () => {
    const { rows } = await listProtocolDaily(pool, { days: 7 })
    expect(rows).toHaveLength(7)
    const days = rows.map((r) => r.day)
    expect([...days].sort()).toEqual(days)
    for (let i = 1; i < days.length; i += 1) {
      const prev = Date.parse(`${days[i - 1] as string}T00:00:00Z`)
      const cur = Date.parse(`${days[i] as string}T00:00:00Z`)
      expect(cur - prev).toBe(86_400_000)
    }
  })

  /**
   * BOS GUNLER SIFIRLA DOLDURULUR.
   *
   * Doldurmayan bir seri, uc gun hicbir sey olmadiginda uc bitisik cubuk
   * cizdirir ve zaman eksenini SESSIZCE sikistirir. Asagidaki iddia
   * "toplam gun sayisi" degil, ISLEMSIZ gunlerin GERCEKTEN sifir tasidigidir.
   */
  it('islemsiz gunler seride SIFIRLA durur, atlanmaz', async () => {
    await ageTrades([3, 3, 3])
    const { rows } = await listProtocolDaily(pool, { days: 7 })
    const busy = rows.filter((r) => r.tradeCount > 0)
    expect(busy).toHaveLength(1)
    expect(busy[0]!.volumeWei).toBe(RANGE_VOLUME_WEI)
    expect(rows.filter((r) => r.tradeCount === 0)).toHaveLength(6)
    expect(rows.every((r) => r.tradeCount > 0 || r.volumeWei === 0n)).toBe(true)
  })

  it('gunluk toplamlar tum-zaman toplamiyla tutarli', async () => {
    await ageTrades([0, 1, 2])
    await ageLaunches(1)
    const { rows } = await listProtocolDaily(pool, { days: 30 })
    const sum = rows.reduce((acc, r) => acc + r.volumeWei, 0n)
    expect(sum).toBe(RANGE_VOLUME_WEI)
    expect(rows.reduce((acc, r) => acc + r.tradeCount, 0)).toBe(RANGE_TRADE_COUNT)
    expect(rows.reduce((acc, r) => acc + r.launchCount, 0)).toBe(1)
    // Uc islem UC AYRI gune dagildi -- yani toplam, tek bir kovada toplanmis
    // olmaktan gelmiyor.
    expect(rows.filter((r) => r.tradeCount > 0)).toHaveLength(3)
  })

  /**
   * ======================================================================
   *  GUN KOVASI OTURUMUN SAAT DILIMINDEN BAGIMSIZDIR -- VE OLCULUYOR.
   * ======================================================================
   *
   * `block_time` `timestamptz`tir. `date_trunc('day', block_time)` OTURUMUN
   * `TimeZone`unu kullanir, yani ayni satir UTC+14'te bir kovaya, UTC-12'de
   * BASKA bir kovaya duser ve hicbir taraf hata vermez. `pg` havuzu oturum
   * durumunu `release()`te SIFIRLAMAZ, dolayisiyla bir kez kacan `SET
   * TimeZone` butun bir surec boyunca yasar.
   *
   * IKI IDDIA VAR VE IKISI DE GEREKLI:
   *   1. GERCEK SORGU iki ucta AYNI kovalari verir.
   *   2. NEGATIF KONTROL: ayni veri uzerinde NAIF ifade (`date_trunc('day',
   *      block_time)`) iki ucta FARKLI kovalar verir. Bu olmadan (1), saat
   *      dilimlerinin hicbir seyi degistirmedigi bir dunyada da yesil kalirdi
   *      -- yani "yazilmamis bir onkosul yuzunden gecen test".
   */
  it('kovalar UTC+14 ile UTC-12 arasinda AYNIDIR (naif ifade degildir)', async () => {
    await ageTrades([0, 1, 2])
    const client: PoolClient = await pool.connect()
    try {
      const naive = async () => {
        const { rows } = await client.query<{ day: string }>(
          `SELECT DISTINCT to_char(date_trunc('day', block_time)::date, 'YYYY-MM-DD') AS day
             FROM trades ORDER BY 1`,
        )
        return rows.map((r) => r.day)
      }

      await client.query("SET TimeZone = 'Pacific/Kiritimati'") // UTC+14
      const eastReal = (await listProtocolDaily(client, { days: 10 })).rows
      const eastNaive = await naive()

      await client.query("SET TimeZone = 'Etc/GMT+12'") // UTC-12
      const westReal = (await listProtocolDaily(client, { days: 10 })).rows
      const westNaive = await naive()

      // (1) GERCEK SORGU: ayni gunler, ayni yerlestirme.
      expect(eastReal.map((r) => r.day)).toEqual(westReal.map((r) => r.day))
      expect(eastReal.map((r) => r.tradeCount)).toEqual(westReal.map((r) => r.tradeCount))
      expect(eastReal.map((r) => r.volumeWei)).toEqual(westReal.map((r) => r.volumeWei))
      expect(eastReal.reduce((a, r) => a + r.tradeCount, 0)).toBe(RANGE_TRADE_COUNT)

      // (2) NEGATIF KONTROL: naif ifade ayrisir. Fixture'in saati 12:00 UTC,
      // yani UTC+14'te ERTESI gun, UTC-12'de AYNI gun.
      expect(eastNaive).not.toEqual(westNaive)
    } finally {
      client.release()
    }
  })

  /**
   * `day` BIR METINDIR, BIR `Date` DEGIL.
   *
   * `pg`nin varsayilan `date` cozucusu YEREL gece yarisinda bir JS `Date`
   * uretir. Bu makinede (UTC+3) `toISOString().slice(0,10)` o `Date` icin BIR
   * ONCEKI gunu yazar -- yani grafik butun cubuklari bir gun kaydirirdi.
   * Sunucuda `to_char` ile metne cevirmek o donusumu tamamen ortadan
   * kaldirir. NEGATIF KONTROL: cevirmeyen bir sorgu GERCEKTEN `Date` verir.
   */
  it('gun alani metindir; ham bir date kolonu ise Date olarak gelir', async () => {
    const { rows } = await listProtocolDaily(pool, { days: 2 })
    for (const row of rows) {
      expect(typeof row.day).toBe('string')
      expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    const raw = await pool.query<{ d: unknown }>('SELECT current_date AS d')
    expect(raw.rows[0]!.d).toBeInstanceOf(Date)
  })

  it('gun sayisi [1, 365] araligina kelepcelenir', async () => {
    expect((await listProtocolDaily(pool, { days: 0 })).rows).toHaveLength(1)
    expect((await listProtocolDaily(pool, { days: -3 })).rows).toHaveLength(1)
    expect((await listProtocolDaily(pool, { days: 10_000 })).rows).toHaveLength(365)
  })

  it('launch da gunune duser', async () => {
    await pool.query(
      `UPDATE launches SET created_at = date_trunc('day', now() AT TIME ZONE 'UTC')
                            + interval '9 hours'`,
    )
    const { rows } = await listProtocolDaily(pool, { days: 3 })
    expect(rows.reduce((a, r) => a + r.launchCount, 0)).toBe(1)
    expect(rows[rows.length - 1]!.launchCount).toBe(1)
  })
})

// ===========================================================================
//  getCreatorEarnings -- DOKUM VE TOPLAM
// ===========================================================================

describe('getCreatorEarnings', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedRange()
  })

  async function depositFrom(from: string, amountWei: bigint, seq: number): Promise<void> {
    const block = 54_326_000n + BigInt(seq)
    await applyEvent(pool, {
      kind: 'fee',
      eventSeq: toSeq(block, 0),
      blockNumber: block,
      logIndex: 0,
      txHash: hash32(0xfee0 + seq),
      blockTime: new Date(),
      feeKind: 'deposit',
      recipient: CREATOR,
      from: from as `0x${string}`,
      amountWei,
    })
  }

  it('dokum ile defter AYNI olduklarinda atfedilmeyen SIFIRDIR', async () => {
    const { rows } = await getCreatorEarnings(pool, CREATOR)
    expect(rows.byLaunch).toHaveLength(1)
    expect(rows.byLaunch[0]!.token).toBe(TOKEN)
    expect(rows.attributedWei).toBe(ATTRIBUTED_CREATOR_WEI)
    expect(rows.depositedTotalWei).toBe(ATTRIBUTED_CREATOR_WEI)
    expect(rows.unattributedWei).toBe(0n)
    expect(rows.ledgerMissing).toBe(false)
  })

  /**
   * ======================================================================
   *  PAYLASILAN ESCROW'UN ONEKI: SATIRLARIN TOPLAMI DEFTERDEN KUCUKTUR.
   * ======================================================================
   *
   * `36496595214216153 wei` zincirde olculdu. Bir `curve_state` satiri
   * olmayan curve'den gelen depozito ICSEL JOIN'den duser -- dogru davranis,
   * cunku o paranin atfedilecek bir launch'i yok. YANLIS olan, satirlari
   * toplayip "kazanciniz" demektir; bu fonksiyon o toplami HIC uretmez.
   */
  it('atfedilemeyen onek DEFTERDE durur, dokumde DURMAZ, ve FARK olarak cikar', async () => {
    await depositFrom(PREFIX_CURVE, PREFIX_DEPOSIT_WEI, 1)
    const { rows } = await getCreatorEarnings(pool, CREATOR)

    expect(rows.byLaunch).toHaveLength(1)
    expect(rows.attributedWei).toBe(ATTRIBUTED_CREATOR_WEI)
    expect(rows.depositedTotalWei).toBe(ATTRIBUTED_CREATOR_WEI + PREFIX_DEPOSIT_WEI)
    expect(rows.unattributedWei).toBe(PREFIX_DEPOSIT_WEI)
    // DEFTER = ATFEDILEN + ATFEDILMEYEN. Sifirlanan, yutulan hicbir sey yok.
    expect(rows.attributedWei + rows.unattributedWei).toBe(rows.depositedTotalWei)
  })

  /**
   * HAVUZ UCRETI: `Deposited.from` HOOK'tur, bir curve DEGIL.
   *
   * `ArcpadHook` swap ucretini escrow'a yatirir, yani `curve_state` JOIN'i onu
   * da dusurur -- oneki dusurdugu gibi ve ayni sebeple. Bugun sifirdir
   * (hicbir token mezun olmadi); mezuniyetten sonra bu, atfedilmeyenin BUYUK
   * kismi olur.
   */
  it('havuz ucreti (hook kaynakli) de atfedilmeyene duser', async () => {
    const hookFee = 1_234_567_890_123_456n
    await depositFrom(HOOK, hookFee, 2)
    const { rows } = await getCreatorEarnings(pool, CREATOR)
    expect(rows.byLaunch).toHaveLength(1)
    expect(rows.attributedWei).toBe(ATTRIBUTED_CREATOR_WEI)
    expect(rows.unattributedWei).toBe(hookFee)
    expect(rows.attributedWei + rows.unattributedWei).toBe(rows.depositedTotalWei)
  })

  it('cekilebilir tutar defterin farkidir ve cekim onu dusurur', async () => {
    // RANGE zaten bir `Claimed` tasiyor: `CREATOR_CLAIM`.
    const { rows } = await getCreatorEarnings(pool, CREATOR)
    expect(rows.claimedTotalWei).toBe(ATTRIBUTED_CREATOR_WEI)
    expect(rows.claimableWei).toBe(rows.depositedTotalWei - rows.claimedTotalWei)
    expect(rows.claimableWei).toBe(0n)
  })

  it('hic ucret gormemis bir adres: defter YOK, dokum BOS, hepsi sifir', async () => {
    const { rows } = await getCreatorEarnings(pool, BOB)
    expect(rows.ledgerMissing).toBe(true)
    expect(rows.byLaunch).toEqual([])
    expect(rows.attributedWei).toBe(0n)
    expect(rows.unattributedWei).toBe(0n)
    expect(rows.claimableWei).toBe(0n)
    expect(rows.recipient).toBe(BOB)
  })

  /**
   * TEK IFADE, TEK SNAPSHOT -- VE BU DOGRULANIYOR.
   *
   * Iki ayri `query()` havuzdan iki ayri BAGLANTI alabilir, yani iki ayri
   * snapshot; arada inen bir `Deposited` `unattributedWei`i sisirir. Iddiayi
   * dogrudan olcmenin yolu: dokumu VE defteri ayni islemde okuyup, DISARIDAN
   * yapilan bir yazimin ikisini de etkilemedigini gormek.
   */
  it('dokum ve defter AYNI snapshot tan gelir', async () => {
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const first = await getCreatorEarnings(client, CREATOR)
      // Baska bir baglantidan bir depozito: defter buyur, ama bu islemin
      // snapshot'i onu GORMEZ -- iki yari da gormez, yani fark bozulmaz.
      await depositFrom(PREFIX_CURVE, PREFIX_DEPOSIT_WEI, 3)
      const second = await getCreatorEarnings(client, CREATOR)
      expect(second.rows.depositedTotalWei).toBe(first.rows.depositedTotalWei)
      expect(second.rows.attributedWei + second.rows.unattributedWei).toBe(
        second.rows.depositedTotalWei,
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    // Islem disinda depozito GORULUR -- yani yukaridaki test bosluga bakmadi.
    const after = await getCreatorEarnings(pool, CREATOR)
    expect(after.rows.unattributedWei).toBe(PREFIX_DEPOSIT_WEI)
  })

  it('dokum kirpildiginda attributedWei yine TAM toplamdir', async () => {
    await depositFrom(PREFIX_CURVE, PREFIX_DEPOSIT_WEI, 4)
    const { rows } = await getCreatorEarnings(pool, CREATOR, { limit: 1 })
    expect(rows.byLaunch).toHaveLength(1)
    expect(rows.byLaunchTruncated).toBe(false) // tek launch var
    expect(rows.attributedWei).toBe(ATTRIBUTED_CREATOR_WEI)
  })
})

// ===========================================================================
//  listPositionsByHolder
// ===========================================================================

describe('listPositionsByHolder', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedRange()
  })

  it('tutulan token, bakiyesi ve MARJINAL degeriyle doner', async () => {
    const { rows } = await listPositionsByHolder(pool, ALICE)
    expect(rows).toHaveLength(1)
    const p = rows[0]!
    expect(p.token).toBe(TOKEN)
    expect(p.symbol).toBe('APT')
    // ALICE 1.000.000 aldi, 400.000 satti.
    expect(p.balanceTok).toBe(600_000n * 10n ** 18n)
    // DEGER = floor(bakiye * fiyat / 1e18). Ifade ELLE tekrar edilmiyor;
    // view'in verdigi fiyattan turetiliyor, yani iki taraf ayrisamaz.
    expect(p.valueWei).toBe((p.balanceTok * p.priceWeiPerTok) / 10n ** 18n)
    expect(p.complete).toBe(true)
  })

  it('SIFIR bakiye bir pozisyon DEGILDIR', async () => {
    await pool.query('UPDATE holders SET balance_tok = 0 WHERE holder = $1', [ALICE])
    expect((await listPositionsByHolder(pool, ALICE)).rows).toEqual([])
    // Satir DURUYOR -- yani filtre calisti, veri kaybolmadi.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM holders WHERE holder = $1',
      [ALICE],
    )
    expect(rows[0]!.n).toBe('1')
  })

  it('hic tutmayan adres BOS liste alir', async () => {
    expect((await listPositionsByHolder(pool, addr(0xdead1))).rows).toEqual([])
  })

  /**
   * IMLEC IKI PARCALIDIR VE OLMAK ZORUNDADIR.
   *
   * Degerler ESITLENIR: fiyat token basina aynidir, yani ayni miktari tutan
   * iki farkli token AYNI `value_wei`i verir. Tek anahtarli bir keyset o
   * noktada satir TEKRARLATIR VE ATLATIR.
   */
  it('esit degerli iki pozisyonda sayfalama tekrar da atlama da yapmaz', async () => {
    const other = addr(0x7001)
    const otherCurve = addr(0xc001)
    // Ikinci bir launch + curve + ayni bakiye. Ayni rezervler => AYNI fiyat.
    await cloneRow('launches', 'token', TOKEN, {
      token: other,
      curve: otherCurve,
      symbol: 'APT2',
      created_seq: '4194400',
    })
    await cloneRow('creator_history', 'token', TOKEN, { token: other, from_seq: '4194400' })
    await cloneRow('curve_state', 'token', TOKEN, {
      curve: otherCurve,
      token: other,
      last_seq: '4194400',
    })
    await cloneRow('token_stats', 'token', TOKEN, { token: other })
    await pool.query(
      `INSERT INTO holders (token, holder, balance_tok, last_seq)
       SELECT $1, holder, balance_tok, last_seq FROM holders WHERE token = $2 AND holder = $3`,
      [other, TOKEN, ALICE],
    )

    const all = await listPositionsByHolder(pool, ALICE)
    expect(all.rows).toHaveLength(2)
    expect(all.rows[0]!.valueWei).toBe(all.rows[1]!.valueWei) // ESITLER

    const first = await listPositionsByHolder(pool, ALICE, { limit: 1 })
    const second = await listPositionsByHolder(pool, ALICE, {
      limit: 1,
      after: parsePositionCursor(encodePositionCursor(first.rows[0]!)),
    })
    expect(second.rows).toHaveLength(1)
    expect(second.rows[0]!.token).not.toBe(first.rows[0]!.token)
    expect([first.rows[0]!.token, second.rows[0]!.token].sort()).toEqual(
      all.rows.map((r) => r.token).sort(),
    )
  })

  it('bicimsiz imlec ILK SAYFADIR, hata degil', () => {
    expect(parsePositionCursor('nonsense')).toBeNull()
    expect(parsePositionCursor('')).toBeNull()
    expect(parsePositionCursor(null)).toBeNull()
    expect(parsePositionCursor('12:0xNOTHEX')).toBeNull()
    expect(parsePositionCursor(`5:${TOKEN}`)).toEqual({ valueWei: 5n, token: TOKEN })
  })
})

// ===========================================================================
//  listTradesByTrader
// ===========================================================================

describe('listTradesByTrader', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedRange()
  })

  it('cuzdanin islemleri, EN YENI once, sembolüyle birlikte', async () => {
    const { rows } = await listTradesByTrader(pool, ALICE)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.isBuy)).toEqual([false, true]) // once SELL (daha yeni)
    expect(rows.every((r) => r.symbol === 'APT')).toBe(true)
    expect(rows.every((r) => r.token === TOKEN)).toBe(true)
    const seqs = rows.map((r) => r.eventSeq)
    expect(seqs[0]!).toBeGreaterThan(seqs[1]!)
  })

  it('baska bir cuzdanin islemleri KARISMAZ', async () => {
    expect((await listTradesByTrader(pool, BOB)).rows).toHaveLength(1)
    expect((await listTradesByTrader(pool, addr(0xdead2))).rows).toEqual([])
  })

  it('imlec ile ikinci sayfa ilkini TEKRAR ETMEZ', async () => {
    const first = await listTradesByTrader(pool, ALICE, { limit: 1 })
    expect(first.rows).toHaveLength(1)
    const second = await listTradesByTrader(pool, ALICE, {
      limit: 1,
      cursor: first.rows[0]!.eventSeq,
    })
    expect(second.rows).toHaveLength(1)
    expect(second.rows[0]!.eventSeq).toBeLessThan(first.rows[0]!.eventSeq)
  })

  /**
   * `source` HER SATIRIN KENDI ALANIDIR.
   *
   * Token sayfasi bu dersi zaten odedi: mekan bir SAYFA prop'u olarak tasindigi
   * surece iki cagri yerinden birinde unutulabiliyordu. Burada satirin
   * kendisinde.
   */
  it('havuz islemi `source: pool` ile ayni listede gorunur', async () => {
    await applyPoolSwap(pool, poolSwap())
    const { rows } = await listTradesByTrader(pool, ALICE)
    expect(rows).toHaveLength(3)
    expect(rows[0]!.source).toBe('pool')
    expect(rows.slice(1).every((r) => r.source === 'curve')).toBe(true)
  })

  it('ucret parcalari AYRI AYRI tasinir, birlestirilmez', async () => {
    const { rows } = await listTradesByTrader(pool, BOB)
    const t = rows[0]!
    expect(t.protocolFeeWei).toBe(8_550_000_000_000_000n)
    expect(t.creatorFeeWei).toBe(2_700_000_000_000_000n)
  })
})
