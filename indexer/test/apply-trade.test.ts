import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { snapshot, toSeq } from '@arcpad/db'
import { admit, deriveTokenAddress } from '../src/admit'
import { applyEvents, applyTradeEvent, UnknownCurve } from '../src/apply'
import type { DecodedEvent, LaunchedEvent, TradeEvent } from '../src/logs'
import { createPacer, decodeAll } from '../src/logs'
import { FakeNode, LIVE, liveDecodedEvents, rawLogs } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

const BLOCK = 54_700_000n

async function applyLive(): Promise<{
  events: DecodedEvent[]
  counts: Awaited<ReturnType<typeof applyEvents>>
}> {
  const events = await liveDecodedEvents()
  const counts = await applyEvents(pool, LIVE_DEPLOYMENT, events)
  return { events, counts }
}

async function row<T>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, values)
  return rows[0] as T
}

describe('apply/trade', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  it('CANLI smoke un butun olaylari uygulanir', async () => {
    const { counts } = await applyLive()
    expect(counts).toEqual({
      launches: 1,
      trades: 4,
      completed: 1,
      transfers: 5,
      fees: 8,
      total: 19,
    })
  })

  // DURUM MUTLAK YAZILIR: `Trade` dort rezervin dordunu de tasir.
  it('curve_state son Trade in dort rezervini AYNEN tasir', async () => {
    const { events } = await applyLive()
    const trades = events.filter((e): e is TradeEvent => e.kind === 'trade')
    const last = trades[trades.length - 1]!
    const state = await row<Record<string, string | boolean>>(
      'SELECT * FROM curve_state WHERE curve = $1',
      [LIVE.curve],
    )
    expect(state['virtual_token_reserves_tok']).toBe(last.virtualTokenReservesTok.toString())
    expect(state['virtual_quote_reserves_wei']).toBe(last.virtualQuoteReservesWei.toString())
    // `Completed` `real_token_reserves_tok`i SIFIRLAR ve `real_quote`u kendi
    // degeriyle yazar -- bu yuzden burada `Trade`in degeri DEGIL, olay
    // sirasinin sonucu okunur.
    expect(state['complete']).toBe(true)
    expect(state['real_token_reserves_tok']).toBe('0')
    expect(state['pool_seed_supply_tok']).toBe('206886011183597390493942218')
    expect(state['real_quote_reserves_wei']).toBe('12161433369060378714')
  })

  it('sayaclar ve hacim canli degerlerle ortusur', async () => {
    const { events } = await applyLive()
    const trades = events.filter((e): e is TradeEvent => e.kind === 'trade')
    const volume = trades.reduce((acc, t) => acc + t.quoteAmountWei, 0n)
    const stats = await row<Record<string, string | number>>(
      'SELECT * FROM token_stats WHERE token = $1',
      [LIVE.token],
    )
    expect(stats['trade_count']).toBe(4)
    // Dort ticaretin ucu ALIM. `Trade` TEK bir olaydir ve yon bayragi
    // indeksli olmadigi icin bu sayi ancak `data` cozulerek bilinebilir.
    expect(stats['buy_count']).toBe(3)
    expect(stats['volume_total_wei']).toBe(volume.toString())
    expect(stats['last_trade_seq']).toBe(trades[trades.length - 1]!.seq.toString())
  })

  // MARKET CAP: `CurveMath.marketCap` = mulDiv(Vq, N, Vt), TABANA yuvarlar.
  it('market cap son Trade in rezervlerinden TABANA yuvarlanarak yazilir', async () => {
    const { events } = await applyLive()
    const trades = events.filter((e): e is TradeEvent => e.kind === 'trade')
    const last = trades[trades.length - 1]!
    const expected =
      (last.virtualQuoteReservesWei * LIVE_DEPLOYMENT.totalSupplyTok) / last.virtualTokenReservesTok
    const stats = await row<Record<string, string>>(
      'SELECT market_cap_wei, ath_market_cap_wei FROM token_stats WHERE token = $1',
      [LIVE.token],
    )
    expect(stats['market_cap_wei']).toBe(expected.toString())
    // ATH monotondur: butun ticaretlerin en buyugu.
    const ath = trades.reduce((acc, t) => {
      const mc =
        (t.virtualQuoteReservesWei * LIVE_DEPLOYMENT.totalSupplyTok) / t.virtualTokenReservesTok
      return mc > acc ? mc : acc
    }, 0n)
    expect(stats['ath_market_cap_wei']).toBe(ath.toString())
  })

  // ACILIS market cap'i: testnet profilinde TAM 4 USDC (4e18 wei), yani
  // `LaunchFactory.MIN_OPENING_MARKET_CAP`'in ta kendisi. Sifir kalsaydi
  // Explore'un "market cap'e gore sirala" beslemesinde her yeni token en dibe
  // duserdi.
  it('hic ticaret gormemis bir launch acilis market cap ini tasir', async () => {
    const events = await liveDecodedEvents()
    const launched = events.find((e): e is LaunchedEvent => e.kind === 'launched')!
    await admit(pool, LIVE_DEPLOYMENT, launched)
    const stats = await row<Record<string, string>>(
      'SELECT market_cap_wei FROM token_stats WHERE token = $1',
      [LIVE.token],
    )
    expect(stats['market_cap_wei']).toBe('4000000000000000000')
  })

  // ---------------------------------------------------------------
  // Exactly-once
  // ---------------------------------------------------------------

  it('ayni araligi iki kez uygulamak veritabanini AYNI birakir', async () => {
    const { events } = await applyLive()
    const after = await snapshot(pool)

    const second = await applyEvents(pool, LIVE_DEPLOYMENT, events)
    expect(second).toEqual({
      launches: 0,
      trades: 0,
      completed: 0,
      transfers: 0,
      fees: 0,
      total: 0,
    })
    // Sayaclar "hicbir satir yazilmadi" der. Dokum "hicbir DEGER degismedi"
    // der -- artimli bir guncelleme ikinci kez uygulansaydi sayac yine 0
    // gorunurdu ama hacim iki katina cikardi.
    expect(await snapshot(pool)).toEqual(after)
  })

  it('UCUNCU gecis de bir no-op', async () => {
    const { events } = await applyLive()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const after = await snapshot(pool)
    expect((await applyEvents(pool, LIVE_DEPLOYMENT, events)).total).toBe(0)
    expect(await snapshot(pool)).toEqual(after)
  })

  /**
   * NEGATIF KONTROL -- `trades` defterinin GERCEKTEN kapi oldugu.
   *
   * Ikinci gecisin no-op olmasi, `ON CONFLICT DO NOTHING`in bir SAYACI
   * korudugu anlamina gelmez; koruyan sey artimin `ins`e BAGLI olmasidir.
   * Defter satiri silindiginde ayni cagri bu kez yazmali ve hacim TAM OLARAK
   * bir ticaret kadar artmali.
   */
  it('defter satiri silinince ayni Trade YENIDEN yazilir (negatif kontrol)', async () => {
    const { events } = await applyLive()
    const trade = events.find((e): e is TradeEvent => e.kind === 'trade')!
    const before = await row<{ volume_total_wei: string; trade_count: number }>(
      'SELECT volume_total_wei, trade_count FROM token_stats WHERE token = $1',
      [LIVE.token],
    )

    // Defter DURURKEN: hicbir sey olmaz.
    expect(await applyTradeEvent(pool, LIVE_DEPLOYMENT, trade)).toBe(0)
    const unchanged = await row<{ volume_total_wei: string; trade_count: number }>(
      'SELECT volume_total_wei, trade_count FROM token_stats WHERE token = $1',
      [LIVE.token],
    )
    expect(unchanged).toEqual(before)

    // Defter satiri SILINIR.
    await pool.query('DELETE FROM trades WHERE event_seq = $1', [trade.seq.toString()])
    expect(await applyTradeEvent(pool, LIVE_DEPLOYMENT, trade)).toBe(1)

    const after = await row<{ volume_total_wei: string; trade_count: number }>(
      'SELECT volume_total_wei, trade_count FROM token_stats WHERE token = $1',
      [LIVE.token],
    )
    expect(BigInt(after.volume_total_wei) - BigInt(before.volume_total_wei)).toBe(
      trade.quoteAmountWei,
    )
    expect(after.trade_count - before.trade_count).toBe(1)
  })

  /**
   * SIRA MUHAFIZI. Hic gorulmemis ama ESKI bir olay `ins`ten GECER (yeni bir
   * `event_seq`), yani onu durdurmanin tek yolu `event_seq > last_seq`
   * kosuludur.
   */
  it('yeniden oynatilan ESKI bir Trade YENI durumu ezmez', async () => {
    const { events } = await applyLive()
    const trades = events.filter((e): e is TradeEvent => e.kind === 'trade')
    const stateBefore = await row('SELECT * FROM curve_state WHERE curve = $1', [LIVE.curve])
    const capBefore = await row<{ market_cap_wei: string }>(
      'SELECT market_cap_wei FROM token_stats WHERE token = $1',
      [LIVE.token],
    )

    // Ilk ticaretin GERCEK degerleri, ama HIC GORULMEMIS bir `event_seq` ile
    // (ayni blok, kullanilmamis bir logIndex). Bu, "gec gelen eski olay"in ta
    // kendisidir.
    const first = trades[0]!
    const stale: TradeEvent = {
      ...first,
      logIndex: 999,
      seq: toSeq(first.blockNumber, 999),
    }
    expect(await applyTradeEvent(pool, LIVE_DEPLOYMENT, stale)).toBe(1)

    expect(await row('SELECT * FROM curve_state WHERE curve = $1', [LIVE.curve])).toEqual(
      stateBefore,
    )
    // Market cap da ezilmemeli: eski rezervlerle yazilsaydi kullaniciya
    // gecmisteki bir fiyat GUNCEL diye gosterilirdi.
    expect(
      await row<{ market_cap_wei: string }>(
        'SELECT market_cap_wei FROM token_stats WHERE token = $1',
        [LIVE.token],
      ),
    ).toEqual(capBefore)

    // Ama HACIM artar: toplamlar degismelidir ve gec gelen bir islem de
    // hacme katilir.
    const stats = await row<{ trade_count: number }>(
      'SELECT trade_count FROM token_stats WHERE token = $1',
      [LIVE.token],
    )
    expect(stats.trade_count).toBe(5)
  })

  it('bilinmeyen bir curve den gelen Trade DURDURUR', async () => {
    const events = await liveDecodedEvents()
    const trade = events.find((e): e is TradeEvent => e.kind === 'trade')!
    // Launch UYGULANMADAN once: curve_state satiri yok.
    await expect(applyTradeEvent(pool, LIVE_DEPLOYMENT, trade)).rejects.toThrow(UnknownCurve)
  })

  // ---------------------------------------------------------------
  // zero_creator: TEK Deposited, creator payi SIFIR
  // ---------------------------------------------------------------

  it('sifir-creator lu bir curve de creator_fee_wei = 0 kabul edilir', async () => {
    // `zero_creator.json`'un curve'u factory'den GELMEZ (test kontrati
    // dogrudan deploy eder), yani onu barindiran bir launch YOKTUR. Curve'u
    // veritabanina sokmak icin ayni curve'u tasiyan bir launch KURULUR ve
    // token adresi GERCEK turetmeyle hesaplanir -- uydurulmaz.
    const zeroLogs = rawLogs('zero_creator', { block: BLOCK })
    const zeroEvents = await decodeAll(new FakeNode([]), zeroLogs, BLOCK, BLOCK, createPacer())
    const trade = zeroEvents.find((e): e is TradeEvent => e.kind === 'trade')!

    const nameHex = '0x5a45524f'
    const symbolHex = '0x5a45524f'
    const uriHex = '0x697066733a2f2f7a65726f'
    const salt = `0x${'33'.repeat(32)}` as const
    const creator = '0x0000000000000000000000000000000000000000' as Address
    const token = deriveTokenAddress({
      factory: LIVE_DEPLOYMENT.factory,
      salt,
      nameHex,
      symbolHex,
      uriHex,
      creator,
      curve: trade.curve,
    })
    const launched: LaunchedEvent = {
      kind: 'launched',
      seq: toSeq(BLOCK - 1n, 0),
      blockNumber: BLOCK - 1n,
      logIndex: 0,
      txHash: `0x${'cd'.repeat(32)}`,
      blockTime: new Date(1_800_000_000_000),
      factory: LIVE_DEPLOYMENT.factory,
      token,
      curve: trade.curve,
      creator,
      name: 'ZERO',
      symbol: 'ZERO',
      uri: 'ipfs://zero',
      nameHex,
      symbolHex,
      uriHex,
      salt,
      rawTopics: [],
      rawData: '0x',
    }
    await admit(pool, LIVE_DEPLOYMENT, launched)
    // `Transfer` DISARIDA BIRAKILIYOR ve sebebi kayda geciyor: bu senaryonun
    // curve'u factory'den gelmedigi icin token'i da KANONIK DEGILDIR (Task
    // 4'un raporu bunu ayrica soyluyor), yani `launches`'a giremez ve
    // `token_transfers.token` yabanci anahtari onu -- DOGRU OLARAK --
    // reddeder. Senaryonun tasidigi tek ozellik `creatorFee = 0` ve TEK bir
    // `Deposited`tir; holder muhasebesi `apply-transfer.test.ts`in isidir.
    await applyEvents(
      pool,
      LIVE_DEPLOYMENT,
      zeroEvents.filter((e) => e.kind !== 'transfer'),
    )

    const t = await row<{ creator_fee_wei: string; protocol_fee_wei: string }>(
      'SELECT creator_fee_wei, protocol_fee_wei FROM trades WHERE event_seq = $1',
      [trade.seq.toString()],
    )
    expect(t.creator_fee_wei).toBe('0')
    expect(BigInt(t.protocol_fee_wei)).toBeGreaterThan(0n)
    // Ve TEK bir yatirim vardir: "her islem iki Deposited uretir" varsayan bir
    // yol burada kirilir.
    const fees = await row<{ n: string }>('SELECT count(*)::text AS n FROM fee_events')
    expect(fees.n).toBe('1')
  })

  // ---------------------------------------------------------------
  // creator_at -- BUGUNDEN test edilen yol
  // ---------------------------------------------------------------

  /**
   * `is_dev` NOKTASALDIR: bir ticaretin "creator tarafindan" yapilip
   * yapilmadigi, O ANDAKI creator'a gore belirlenir. Bugun creator
   * degistirilemez, ama devir yolu yarin gelecek ve o gun egzersiz edilmemis
   * bir kod yolu kalmasin diye SENTETIK bir devir satiri ile bugunden
   * olculuyor.
   */
  it('creator_at sentetik bir devir sonrasi is_dev i noktasal cevirir', async () => {
    const { events } = await applyLive()
    const trades = events.filter((e): e is TradeEvent => e.kind === 'trade')
    const launchCreator = (
      await row<{ launch_creator: string }>(
        'SELECT launch_creator FROM launches WHERE token = $1',
        [LIVE.token],
      )
    ).launch_creator

    // Canli smoke'ta butun ticaretleri creator yapti; duz bir JOIN de hepsine
    // `true` derdi. Devir satiri eklendiginde AYRISIRLAR.
    const handover = trades[2]!.seq
    const newCreator = '0x00000000000000000000000000000000000000b0' as Address
    await pool.query('INSERT INTO creator_history (token, from_seq, creator) VALUES ($1,$2,$3)', [
      LIVE.token,
      handover.toString(),
      newCreator,
    ])

    const { rows } = await pool.query<{ event_seq: string; is_dev: boolean }>(
      `SELECT event_seq::text AS event_seq, trader = creator_at(token, event_seq) AS is_dev
         FROM trades ORDER BY event_seq`,
    )
    expect(rows).toHaveLength(4)
    // Devirden ONCEKI ikisi hala creator'in; SONRAKI ikisi artik degil.
    expect(rows.map((r) => r.is_dev)).toEqual([true, true, false, false])
    // Ve guncel creator'a duz bir JOIN yanlis cevap verirdi:
    const flat = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM trades t
         JOIN launches l ON l.token = t.token WHERE t.trader = l.launch_creator`,
    )
    expect(flat.rows[0]!.n).toBe('4')
    expect(launchCreator).toBe(trades[0]!.trader)
  })
})
