import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { getTokenOverview, snapshot } from '@arcpad/db'
import { applyEvents, CurveTokenMismatch, UnknownCurve } from '../src/apply'
import type { DecodedEvent, GraduatedEvent } from '../src/logs'
import { createPacer, decodeAll, fetchRange } from '../src/logs'
import { constructedGraduatedLog, FakeNode, LIVE, liveDecodedEvents } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

/**
 * INDEXER TARAFI: CANLI SMOKE + BIR MEZUNIYET.
 *
 * `packages/db/test/graduation.test.ts` YAZIMI olcer. Burasi CEKME'den
 * YAZIM'a kadar butun yolu olcer -- ayni ozelligi iki kez degil, iki FARKLI
 * giris noktasinda: bu depoda "bir giris noktasinda kapsanan ozellik hepsinde
 * kapsanmis okunur" hatasi on bir kez tekrarlandi.
 *
 * MEZUNIYET LOGU KURULMUSTUR, YURUTULMUS DEGIL, ve bunun sebebi
 * `test/fixtures.ts`teki `AWAITING_FIXTURE`ta yazili. Kurulan sey yalnizca
 * YUK; onu cozen, siralayan, filtreleyen ve yazan her sey gercek koddur.
 * Onunde duran DORT olay -- launch, dort ticaret, `Completed`, ucretler --
 * canli Arc makbuzlarindan gelir.
 */

const GRAD_BLOCK = 54_700_000n
const TARGET = '0x000000000000000000000000000000000000dead' as Address

/** Canli smoke'un OLCULMUS mezuniyet yuku. */
const BASE = 206_886_011_183_597_390_493_942_218n
const QUOTE = 12_161_433_369_060_378_714n

function graduatedLog(over: { token?: Address; curve?: Address } = {}) {
  return constructedGraduatedLog({
    curve: over.curve ?? LIVE.curve,
    token: over.token ?? LIVE.token,
    to: TARGET,
    baseAmountTok: BASE,
    quoteAmountWei: QUOTE,
    block: GRAD_BLOCK,
    logIndex: 0,
  })
}

async function decodeGraduated(over: { token?: Address; curve?: Address } = {}) {
  const [event] = await decodeAll(
    new FakeNode([]),
    [graduatedLog(over)],
    GRAD_BLOCK,
    GRAD_BLOCK,
    createPacer(),
  )
  if (event?.kind !== 'graduated') throw new Error('graduated cozulmedi')
  return event
}

async function seedLive(): Promise<DecodedEvent[]> {
  const events = await liveDecodedEvents()
  await applyEvents(pool, LIVE_DEPLOYMENT, events)
  return events
}

describe('apply/graduated', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  it('canli smoke MEZUN DEGILDIR -- ve olmamali', async () => {
    // `Completed` VAR, `Graduated` YOK. Bu bir fixture eksigi degil, zincirin
    // su anki durumu: uretim factory'sinde `graduationTarget` sifir oldugu
    // icin `graduate()` `0xfe30fa5b` ile revert eder.
    const events = await seedLive()
    expect(events.some((e) => e.kind === 'completed')).toBe(true)
    expect(events.some((e) => e.kind === 'graduated')).toBe(false)

    const { rows } = await getTokenOverview(pool, LIVE.token)
    expect(rows?.complete).toBe(true)
    expect(rows?.graduated).toBe(false)
  })

  it('mezuniyet uygulanir ve okuma modeli terminal durumu SOYLER', async () => {
    await seedLive()
    const event = await decodeGraduated()
    const counts = await applyEvents(pool, LIVE_DEPLOYMENT, [event])
    expect(counts).toEqual({
      launches: 0,
      trades: 0,
      // MEZUNIYET VAR, HAVUZ ISLEMI YOK -- ve bu bir eksiklik degil bir
      // AYRIM: `graduate()` havuzu ACAR (`initialize` + likidite, ayni
      // islemde) ama ilk `Swap` BASKA bir islemdir. Ikisini ayni sayacta
      // beklemek, mezuniyeti bir islem gibi saymak olurdu.
      poolSwaps: 0,
      completed: 0,
      graduated: 1,
      transfers: 0,
      fees: 0,
      // BUYBACK YOK VE OLMAMALI: bu fixture'in tokeninde ozellik acilmadi.
      buyback: 0,
      total: 1,
    })

    const { rows } = await getTokenOverview(pool, LIVE.token)
    expect(rows?.graduated).toBe(true)
    expect(rows?.graduatedSeq).toBe(event.seq)
    expect(rows?.graduationTargetAddr).toBe(TARGET)
    expect(rows?.graduationBaseTok).toBe(BASE)
    expect(rows?.graduationQuoteWei).toBe(QUOTE)
  })

  it('odenen tutarlar CANLI Completed in tasidiklariyla ortusur', async () => {
    // Fixture'in uydurulmus sayilar tasimadiginin kaniti: `poolSeedSupply` ve
    // `realQuoteReserves` bu testte ZINCIRDEN (`Completed` logundan) okunur ve
    // mezuniyet yukuyle karsilastirilir. Esitlik zincirin kendi kodundan gelir
    // (`BondingCurve.sol:892-893`), bu testin varsayimindan degil.
    const events = await seedLive()
    const completed = events.find((e) => e.kind === 'completed')
    if (completed?.kind !== 'completed') throw new Error('canli Completed yok')
    expect(completed.poolSeedSupplyTok).toBe(BASE)
    expect(completed.realQuoteReservesWei).toBe(QUOTE)
  })

  it('ikinci uygulama SIFIR yazar ve dokum DEGISMEZ', async () => {
    await seedLive()
    const event = await decodeGraduated()
    expect((await applyEvents(pool, LIVE_DEPLOYMENT, [event])).graduated).toBe(1)
    const after = await snapshot(pool)

    expect((await applyEvents(pool, LIVE_DEPLOYMENT, [event])).graduated).toBe(0)
    expect(await snapshot(pool)).toEqual(after)
  })

  it('NEGATIF KONTROL: muhafizi geri al, AYNI cagri yeniden YAZAR', async () => {
    await seedLive()
    const event = await decodeGraduated()
    expect((await applyEvents(pool, LIVE_DEPLOYMENT, [event])).graduated).toBe(1)
    expect((await applyEvents(pool, LIVE_DEPLOYMENT, [event])).graduated).toBe(0)

    await pool.query(
      `UPDATE curve_state SET graduated = false, graduated_seq = NULL,
         graduation_target_addr = NULL, graduation_base_tok = NULL,
         graduation_quote_wei = NULL
       WHERE token = $1`,
      [LIVE.token],
    )

    // Cagri AYNI, davranis FARKLI: yukaridaki sifiri ureten sey muhafizdir.
    expect((await applyEvents(pool, LIVE_DEPLOYMENT, [event])).graduated).toBe(1)
  })

  // -----------------------------------------------------------------
  // PROVENANCE: curve->token esleşmesi dogrulanir.
  // -----------------------------------------------------------------
  it('bilinmeyen bir curve ten gelen Graduated DURDURUR', async () => {
    await seedLive()
    const event = await decodeGraduated({
      curve: '0x00000000000000000000000000000000deadbe01' as Address,
    })
    await expect(applyEvents(pool, LIVE_DEPLOYMENT, [event])).rejects.toThrow(UnknownCurve)
  })

  it('BASKA bir token bildiren bir Graduated DURDURUR (yanlis satir mezun edilmez)', async () => {
    await seedLive()
    const event = await decodeGraduated({
      token: '0x00000000000000000000000000000000deadbe02' as Address,
    })
    await expect(applyEvents(pool, LIVE_DEPLOYMENT, [event])).rejects.toThrow(CurveTokenMismatch)
    // VE HICBIR SEY YAZILMADI: kontrol yazimdan ONCE.
    const { rows } = await getTokenOverview(pool, LIVE.token)
    expect(rows?.graduated).toBe(false)
  })

  // -----------------------------------------------------------------
  // CEKME + YAZMA, TEK YOLDA.
  // -----------------------------------------------------------------
  it('fetchRange ten applyEvents e: uctan uca bir mezuniyet', async () => {
    await seedLive()
    const node = new FakeNode([graduatedLog()])
    const events = await fetchRange(
      node,
      {
        factory: LIVE.factory,
        escrow: LIVE.escrow,
        curves: new Set([LIVE.curve]),
        tokens: new Set([LIVE.token]),
        curveToToken: new Map(),
        pools: new Map(),
        buyback: null,
      },
      GRAD_BLOCK,
      GRAD_BLOCK,
    )
    expect(events.map((e) => e.kind)).toEqual(['graduated'])
    const counts = await applyEvents(pool, LIVE_DEPLOYMENT, events)
    expect(counts.graduated).toBe(1)

    const g = events[0] as GraduatedEvent
    expect(g.curve).toBe(LIVE.curve)
    expect(g.token).toBe(LIVE.token)
  })
})
