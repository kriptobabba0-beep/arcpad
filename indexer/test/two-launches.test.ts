import { beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { deriveTokenAddress } from '../src/admit'
import { applyDecodedEvent, applyRange } from '../src/apply'
import { TOPIC0 } from '../src/arc'
import type { RawLog, WatchSet } from '../src/logs'
import { fetchRange } from '../src/logs'
import { assertRangeApplied } from '../src/verify'
import { FakeNode, LIVE, loadSmoke } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

/**
 * IKI LAUNCH ICEREN BIR ARALIK.
 *
 * NICIN AYRI BIR DOSYA: butun corpus'ta TEK bir launch var (canli smoke bir
 * kez kosturuldu), yani iki fazli uygulamanin COK LAUNCH'LI hali bugune kadar
 * yalnizca bir yorumda SAVUNULUYORDU, hicbir yerde KOSMUYORDU. Uretim bunu
 * IKINCI launch'ta gorur.
 *
 * SENTETIK OLAN NE, GERCEK OLAN NE -- acikca:
 *   GERCEK  butun log GOVDELERI (`data`), olay imzalari, ABI yerlesimi, mint
 *           tutari, ticaret rakamlari, ucret parcalari. Hepsi canli Arc
 *           makbuzlarindan AYNEN aliniyor.
 *   SENTETIK  ikinci launch'in `salt`i, curve adresi ve ondan CREATE2 ile
 *           TURETILEN token adresi; ve loglarin blok/logIndex yerlesimi.
 *
 * Token adresi uydurulmuyor, `deriveTokenAddress` ile hesaplaniyor -- yani bu
 * launch `admit`in kapisindan GERCEKTEN geciyor, bir istisna ile degil.
 */

const BLOCK_A = 54_900_000n
const BLOCK_B = 54_900_001n

const CURVE_B = '0x00000000000000000000000000000000000c02be' as Address
const SALT_B = `0x${'5b'.repeat(32)}` as Hex

function pad(address: string): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

function at(log: RawLog, block: bigint, logIndex: number): RawLog {
  return {
    ...log,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
  }
}

const smoke = loadSmoke()
const launchLogs = smoke.receipts.find((r) => r.scenario === 'launch')!.logs
const buyLogs = smoke.receipts
  .find((r) => r.scenario === 'buy_exact_tokens_out')!
  .logs.filter((l) => l.address.toLowerCase() !== smoke.nativeTransferEmitter.toLowerCase())

const realMint = launchLogs.find((l) => l.topics[0] === TOPIC0.transfer)!
const realLaunched = launchLogs.find((l) => l.topics[0] === TOPIC0.launched)!

/** Ikinci launch'in token adresi: GERCEK govdeden, GERCEK turetmeyle. */
function siblingToken(): Address {
  const data = realLaunched.data
  const word = (i: number): Hex => `0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`
  const dyn = (i: number): Hex => {
    const offset = Number(BigInt(word(i))) / 32
    const length = Number(BigInt(word(offset)))
    const start = 2 + (offset + 1) * 64
    return `0x${data.slice(start, start + length * 2)}`
  }
  return deriveTokenAddress({
    factory: LIVE_DEPLOYMENT.factory,
    salt: SALT_B,
    nameHex: dyn(0),
    symbolHex: dyn(1),
    uriHex: dyn(2),
    creator: `0x${realLaunched.topics[3]!.slice(26)}` as Address,
    curve: CURVE_B,
  })
}

const TOKEN_B = siblingToken()

/** `Launched`in govdesi AYNEN; yalnizca `salt` kelimesi degisiyor. */
function siblingLaunchedData(): Hex {
  const data = realLaunched.data
  return `0x${data.slice(2, 2 + 3 * 64)}${SALT_B.slice(2)}${data.slice(2 + 4 * 64)}`
}

function rangeLogs(): RawLog[] {
  const [trade, transfer, dep1, dep2] = buyLogs
  return [
    // BLOK A -- birinci launch (canli, aynen).
    at(realMint, BLOCK_A, 0),
    at(realLaunched, BLOCK_A, 1),

    // BLOK B -- ikinci launch'in mint'i ve `Launched`i, ARALARINDA birinci
    // launch'in ticareti. Mint yine `Launched`'DAN ONCE (logIndex 0 vs 1) ve
    // ticaret ikisinin ARDINDAN geliyor: katı `event_seq` sirasiyla yazan bir
    // dongu burada IKI KEZ tokezlerdi.
    {
      ...at(realMint, BLOCK_B, 0),
      address: TOKEN_B,
      topics: [realMint.topics[0]!, realMint.topics[1]!, pad(CURVE_B)],
    },
    {
      ...at(realLaunched, BLOCK_B, 1),
      topics: [realLaunched.topics[0]!, pad(TOKEN_B), pad(CURVE_B), realLaunched.topics[3]!],
      data: siblingLaunchedData(),
    },
    // Birinci launch'in ticareti (canli govde, aynen).
    at(trade!, BLOCK_B, 2),
    at(transfer!, BLOCK_B, 3),
    at(dep1!, BLOCK_B, 4),
    at(dep2!, BLOCK_B, 5),
    // Ikinci launch'in ticareti: AYNI govdeler, yayincilar B'nin.
    { ...at(trade!, BLOCK_B, 6), address: CURVE_B },
    // `from` da B'nin curve'u olmali: canli govdede `from` A'nin curve'udur ve
    // oldugu gibi birakmak, B'nin token'ini A'nin curve'unden dusurmeye
    // calisirdi. (`holders_balance_tok_check` bunu ilk kosuda GURULTULU
    // yakaladi -- semanin duvari, sentetik bir logu bile duzeltiyor.)
    {
      ...at(transfer!, BLOCK_B, 7),
      address: TOKEN_B,
      topics: [transfer!.topics[0]!, pad(CURVE_B), transfer!.topics[2]!],
    },
    { ...at(dep1!, BLOCK_B, 8), topics: [dep1!.topics[0]!, dep1!.topics[1]!, pad(CURVE_B)] },
    { ...at(dep2!, BLOCK_B, 9), topics: [dep2!.topics[0]!, dep2!.topics[1]!, pad(CURVE_B)] },
  ]
}

const WATCH: WatchSet = {
  factory: LIVE.factory,
  escrow: LIVE.escrow,
  curves: new Set(),
  tokens: new Set(),
  curveToToken: new Map(),
  pools: new Map(),
  buyback: null,
}

describe('iki launch iceren bir aralik', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  /**
   * FAZ 1.5 IKI launch'i da kumeye eklemeli. Yalnizca BIRINCISINI ekleyen bir
   * hal (dongu yerine `launched[0]`) burada gorunur: ikinci token'in mint'i ve
   * ikinci curve'un `Trade`'i hic cekilmezdi. Tek launch'li corpus'ta o hata
   * YESIL kalirdi.
   */
  it('faz 1.5 IKI token ve IKI curve i birden ogrenir', async () => {
    const node = new FakeNode(rangeLogs())
    const events = await fetchRange(node, WATCH, BLOCK_A, BLOCK_B)
    expect(events.filter((e) => e.kind === 'launched')).toHaveLength(2)
    expect(events.filter((e) => e.kind === 'transfer')).toHaveLength(4)
    expect(events.filter((e) => e.kind === 'trade')).toHaveLength(2)
    expect(events.filter((e) => e.kind === 'deposited')).toHaveLength(4)

    const tokens = new Set(
      events
        .filter((e) => e.kind === 'transfer')
        .map((e) => (e.kind === 'transfer' ? e.token : '')),
    )
    expect([...tokens].sort()).toEqual([LIVE.token, TOKEN_B].sort())
  })

  it('iki launch da kabul edilir ve aralik TEK islemde yazilir', async () => {
    const events = await fetchRange(new FakeNode(rangeLogs()), WATCH, BLOCK_A, BLOCK_B)
    const counts = await applyRange(pool, LIVE_DEPLOYMENT, events)
    expect(counts).toEqual({
      launches: 2,
      trades: 2,
      // HAVUZ ISLEMI YOK VE OLMAMALI: bu fixture mezuniyet ONCESI bir egridir.
      poolSwaps: 0,
      completed: 0,
      graduated: 0,
      transfers: 4,
      fees: 4,
      // BUYBACK YOK VE OLMAMALI: iki launch da ozelligi acmadi.
      buyback: 0,
      total: 12,
    })
    await expect(assertRangeApplied(pool, events)).resolves.toBeUndefined()
  })

  /**
   * BIR TICARETIN TOKEN'I, KENDI CURVE'UNDEN COZULMELI.
   *
   * `Trade` token adresi TASIMAZ; `tokenOfCurve` bir veritabani okumasidir.
   * TEK launch varken "tablodaki tek token'i dondur" diyen bir hata da yesil
   * kalirdi -- iki launch bunu ayirir.
   */
  it('her ticaret KENDI token una yazilir', async () => {
    const events = await fetchRange(new FakeNode(rangeLogs()), WATCH, BLOCK_A, BLOCK_B)
    await applyRange(pool, LIVE_DEPLOYMENT, events)
    const { rows } = await pool.query<{ token: string; curve: string }>(
      'SELECT token, curve FROM trades ORDER BY event_seq',
    )
    expect(rows).toEqual([
      { token: LIVE.token, curve: LIVE.curve },
      { token: TOKEN_B, curve: CURVE_B },
    ])
  })

  it('her token un bakiyeleri KENDI arziyla kapanir', async () => {
    const events = await fetchRange(new FakeNode(rangeLogs()), WATCH, BLOCK_A, BLOCK_B)
    await applyRange(pool, LIVE_DEPLOYMENT, events)
    const { rows } = await pool.query<{ token: string; total: string; n: string }>(
      `SELECT token, sum(balance_tok)::text AS total, count(*)::text AS n
         FROM holders GROUP BY token ORDER BY token`,
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.total).toBe((10n ** 27n).toString())
    const { rows: stats } = await pool.query<{ token: string; holder_count: number }>(
      'SELECT token, holder_count FROM token_stats ORDER BY token',
    )
    expect(stats.map((s) => s.holder_count)).toEqual([1, 1])
  })

  it('ucretler iki curve e AYRI AYRI dokulur', async () => {
    const events = await fetchRange(new FakeNode(rangeLogs()), WATCH, BLOCK_A, BLOCK_B)
    await applyRange(pool, LIVE_DEPLOYMENT, events)
    const { rows } = await pool.query<{ token: string; s: string }>(
      `SELECT l.token, sum(f.amount_wei)::text AS s
         FROM fee_events f
         JOIN curve_state c ON c.curve = f.from_addr
         JOIN launches l ON l.token = c.token
        WHERE f.kind = 'deposit'
        GROUP BY l.token ORDER BY l.token`,
    )
    expect(rows).toHaveLength(2)
    // Ayni ticaret govdesi iki kez kullanildi, yani iki launch'in ucreti
    // birebir ayni olmali -- ve TOPLANMAMIS olmali.
    expect(rows[0]!.s).toBe(rows[1]!.s)
  })

  /**
   * NEGATIF KONTROL: KATI `event_seq` SIRASI IKI LAUNCH'TA DA KIRILIR.
   *
   * Iki fazli uygulama bir yorum degil bir gereklilik; bu, onu bypass edip
   * olcuyor. `applyEvents` yerine `applyDecodedEvent` dogrudan cagriliyor,
   * yani test edilen kodun KENDI faz ayrimi devrede degil.
   */
  it('kati event_seq sirasi ILK mint te tokezler (iki fazliligin gerekcesi)', async () => {
    const events = await fetchRange(new FakeNode(rangeLogs()), WATCH, BLOCK_A, BLOCK_B)
    const strict = [...events].sort((a, b) => (a.seq < b.seq ? -1 : 1))
    expect(strict[0]?.kind).toBe('transfer')
    await expect(
      (async () => {
        for (const event of strict) await applyDecodedEvent(pool, LIVE_DEPLOYMENT, event)
      })(),
    ).rejects.toThrow(/token_transfers_token_fkey/)
  })

  it('ikinci launch in token adresi CREATE2 ile dogrulanmis, uydurulmamistir', async () => {
    const events = await fetchRange(new FakeNode(rangeLogs()), WATCH, BLOCK_A, BLOCK_B)
    await applyRange(pool, LIVE_DEPLOYMENT, events)
    const { rows } = await pool.query<{ token: string; salt: string }>(
      'SELECT token, salt FROM launches ORDER BY created_seq',
    )
    expect(rows.map((r) => r.token)).toEqual([LIVE.token, TOKEN_B])
    expect(rows[1]!.salt).toBe(SALT_B)
    // Ve iki launch AYRI curve'lere sahip (`launches.curve` UNIQUE).
    const { rows: curves } = await pool.query<{ n: string }>(
      'SELECT count(DISTINCT curve)::text AS n FROM launches',
    )
    expect(curves[0]!.n).toBe('2')
  })
})
