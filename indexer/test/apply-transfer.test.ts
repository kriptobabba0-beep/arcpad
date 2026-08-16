import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { snapshot } from '@arcpad/db'
import { applyEvents, applyTransferEvent } from '../src/apply'
import type { DecodedEvent, TransferEvent } from '../src/logs'
import { fetchRange, ForbiddenEmitter } from '../src/logs'
import { assertRangeApplied, LedgerGap } from '../src/verify'
import { FakeNode, LIVE, liveDecodedEvents, loadSmoke, smokeLogs } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

const TOTAL_SUPPLY = 10n ** 27n

async function holders(): Promise<{ holder: string; balance_tok: string; last_seq: string }[]> {
  const { rows } = await pool.query<{ holder: string; balance_tok: string; last_seq: string }>(
    'SELECT holder, balance_tok::text AS balance_tok, last_seq::text AS last_seq FROM holders ORDER BY holder',
  )
  return rows
}

async function holderCount(): Promise<number> {
  const { rows } = await pool.query<{ holder_count: number }>(
    'SELECT holder_count FROM token_stats WHERE token = $1',
    [LIVE.token],
  )
  return rows[0]!.holder_count
}

async function balanceSum(): Promise<bigint> {
  const { rows } = await pool.query<{ total: string }>(
    'SELECT sum(balance_tok)::text AS total FROM holders WHERE token = $1',
    [LIVE.token],
  )
  return BigInt(rows[0]!.total)
}

/**
 * Canli olaylarin ilk `n` transfer'ine kadar olan on eki.
 *
 * `Launched` AYRICA eklenir cunku on ek `event_seq` sirasindadir ve mint
 * `Transfer`'i `Launched`'DAN ONCE gelir -- yani "ilk transfer'e kadar" diyen
 * duz bir dilim, launch'i DISARIDA birakirdi.
 */
function upTo(events: readonly DecodedEvent[], transfers: number): DecodedEvent[] {
  let seen = 0
  const out: DecodedEvent[] = []
  for (const e of events) {
    out.push(e)
    if (e.kind === 'transfer') {
      seen += 1
      if (seen === transfers) break
    }
  }
  const lastBlock = out[out.length - 1]!.blockNumber
  for (const e of events) {
    if (e.kind === 'launched' && e.blockNumber <= lastBlock && !out.includes(e)) out.push(e)
  }
  return out
}

describe('apply/transfer', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  // ---------------------------------------------------------------
  // Kaybi GURULTULU yapan iddia
  // ---------------------------------------------------------------

  /**
   * BU TOPLAM BIR KAPI DEGILDIR. Yerine ne gectigi `src/verify.ts`'te yaziyor.
   *
   * Buraya not dusuluyor cunku planin metni onu "butun `Transfer`'larin
   * yakalandigini kanitlayan TEK kontrol" diye tarif ediyordu ve o cumle
   * OLCULEREK yanlislandi -- iki yonden birden:
   *
   *   1. Mint DISINDAKI bir `Transfer` dusurulurse toplam DEGISMEZ (asagidaki
   *      test). Transfer bir bakiyeden dusup digerine ekler.
   *   2. Bir delta IKI KEZ uygulanirsa da toplam DEGISMEZ (negatif kontrol
   *      testinin sonu). Yani ne kayip ne cift sayim gorunur.
   *
   * Toplamin GERCEKTEN gosterdigi sey dar ama degersiz degil: mint yakalandi,
   * hicbir bakiye uydurulmadi, ve `holders` ile arz arasinda bir kacak yok.
   * Bu isimle ve bu yorumla duruyor ki kimse onu bir kapi sanip yeniden
   * yuklemesin.
   *
   * KAPI: `assertRangeApplied` (olay kimliklerini deftere karsi tutar, bkz.
   * `src/verify.ts`) + `token_transfers.token` yabanci anahtari +
   * `balance_tok >= 0` CHECK'i.
   */
  it('bakiyeler toplami TOTAL_SUPPLY a esittir (bir KAPI degil -- src/verify.ts)', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    expect(await balanceSum()).toBe(TOTAL_SUPPLY)
  })

  // NEGATIF KONTROL: MINT dusurulurse toplam kirilir.
  it('mint Transfer i atlandiginda toplam TUTMAZ', async () => {
    const events = await liveDecodedEvents()
    const gapped = events.filter(
      (e) => !(e.kind === 'transfer' && e.from === '0x0000000000000000000000000000000000000000'),
    )
    expect(gapped).toHaveLength(events.length - 1)
    // Mint olmadan curve'un bakiyesi yok; ilk cikis bakiyeyi negatife
    // dusurur ve `holders_balance_tok_check` GURULTULU patlar. Sessiz kayip
    // yoktur.
    await expect(applyEvents(pool, LIVE_DEPLOYMENT, gapped)).rejects.toThrow(
      /holders_balance_tok_check/,
    )
  })

  /**
   * PLAN DUZELTMESI -- OLCULDU.
   *
   * Plan (Global Kisitlar, EIP-7708 maddesi 3) sunu soyluyor: "Butun
   * `Transfer`'larin yakalandigini kanitlayan TEK kontrol
   * `SUM(holders.balance_tok) = 1e27`'dir. Bir `Transfer` dusurulurse bu
   * esitlik kirilir."
   *
   * IKINCI CUMLE GENEL OLARAK YANLIS ve bu test onu olcuyor: mint DISINDAKI
   * her `Transfer` bir bakiyeyi azaltip digerini AYNI KADAR artirir, yani
   * TOPLAMI KORUR. Dusurulmesi toplamdan gorunmez. Ayni sebeple bir 7708
   * logunun YANLISLIKLA uygulanmasi da toplami bozmazdi (iki tarafi da
   * etkiler) -- yani toplam, o riskin kapanmasi degildir.
   *
   * Gercekten kapatan uc sey, siralamasiyla: (1) cekme katmanindaki adres
   * filtresi, (2) `token_transfers.token`in `launches`a yabanci anahtari,
   * (3) `holders.balance_tok >= 0` CHECK'i -- ki eksik bir cikis eninde
   * sonunda ona carpar. Toplam bunlarin USTUNE bir kontroldur, YERINE degil.
   */
  it('mint DISINDAKI bir Transfer atlandiginda toplam KORUNUR (planin iddiasi yanlis)', async () => {
    const events = await liveDecodedEvents()
    // Son transfer: curve -> alici (fill). Dusurmek sonraki hicbir cikisi
    // negatife dusurmez, yani tek gorunur etki toplam olurdu -- ve toplam
    // KORUNUYOR.
    const transfers = events.filter((e): e is TransferEvent => e.kind === 'transfer')
    const victim = transfers[transfers.length - 1]!
    const gapped = events.filter((e) => e !== victim)
    await applyEvents(pool, LIVE_DEPLOYMENT, gapped)
    expect(await balanceSum()).toBe(TOTAL_SUPPLY)
    // Kayip GERCEKTEN oldu: alicinin bakiyesi eksik.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM token_transfers',
    )
    expect(rows[0]!.n).toBe('4')

    // VE ISTE TOPLAMIN YERINI ALAN KONTROL: ayni kayip, defter kapsamiyla
    // BAKILDIGINDA gorunur. Dusurulen transfer bir holder'in SON transferiydi
    // (fill alicisi bir daha hic hareket etmedi), yani `balance_tok >= 0`
    // CHECK'i de onu goremezdi -- toplam demoted edildikten sonra ortada
    // kalan tam olarak bu bosluktu.
    await expect(assertRangeApplied(pool, events)).rejects.toThrow(LedgerGap)
    const gap = (await assertRangeApplied(pool, events).catch((e: unknown) => e)) as LedgerGap
    expect(gap.table).toBe('token_transfers')
    expect(gap.missing).toEqual([victim.seq])
  })

  it('eksiksiz bir aralikta kapsam kontrolu SESSIZDIR', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    await expect(assertRangeApplied(pool, events)).resolves.toBeUndefined()
  })

  // `Completed` bir defter satiri TASIMAZ; kapsam kontrolu onu atlar. Bunu
  // olcmek zorunlu, cunku atlamayi unutan bir hal her tamamlanan curve'de
  // yanlis alarm verirdi.
  it('kapsam kontrolu Completed i defter satiri saymaz', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    expect(events.some((e) => e.kind === 'completed')).toBe(true)
    await expect(assertRangeApplied(pool, events)).resolves.toBeUndefined()
  })

  // ---------------------------------------------------------------
  // holder_count -- curve HARIC
  // ---------------------------------------------------------------

  /**
   * `LaunchToken` TUM arzi constructor'da curve'e basar, yani launch aninda
   * curve TEK holder'dir. Curve sayilsaydi hicbir kullanicisi olmayan bir
   * token "1 holder" gosterirdi -- kullaniciya YANLIS BIR RAKAM.
   */
  it('launch aninda holder_count 0 dir ve butun arz curve tedir', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, upTo(events, 1))
    expect(await holderCount()).toBe(0)
    const rows = await holders()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ holder: LIVE.curve, balance_tok: TOTAL_SUPPLY.toString() })
  })

  it('ilk alimdan sonra holder_count 1 dir', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, upTo(events, 2))
    expect(await holderCount()).toBe(1)
    expect(await balanceSum()).toBe(TOTAL_SUPPLY)
  })

  it('sifir adres HICBIR ZAMAN holder olmaz', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const rows = await holders()
    expect(rows.map((r) => r.holder)).not.toContain('0x0000000000000000000000000000000000000000')
  })

  /**
   * Bakiyesi sifira dusen holder SAYILMAZ ama satiri KALIR: `last_seq`
   * bilgisi degerlidir ve satiri silmek onu kaybetmek olurdu.
   */
  it('bakiyesi sifira dusen holder sayilmaz ama satiri kalir', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)

    // Canli smoke'ta alici hicbir zaman tamamen satmadi; sifira dusen bir
    // holder'i olcmek icin kalan bakiyesinin TAMAMINI curve'e geri gonderen
    // bir `Transfer` uygulanir. Bu, zincirde `sell` ile aynen olan seydir.
    const trader = (await holders()).find((r) => r.holder !== LIVE.curve)!
    const last = events[events.length - 1]!
    const drain: TransferEvent = {
      kind: 'transfer',
      seq: last.seq + 1n,
      blockNumber: last.blockNumber,
      logIndex: last.logIndex + 1,
      txHash: last.txHash,
      blockTime: last.blockTime,
      token: LIVE.token,
      from: trader.holder as Address,
      to: LIVE.curve,
      amountTok: BigInt(trader.balance_tok),
    }
    expect(await applyTransferEvent(pool, drain)).toBe(1)

    expect(await holderCount()).toBe(0)
    const row = (await holders()).find((r) => r.holder === trader.holder)!
    expect(row.balance_tok).toBe('0')
    expect(BigInt(row.last_seq)).toBe(drain.seq)
    expect(await balanceSum()).toBe(TOTAL_SUPPLY)
  })

  // ---------------------------------------------------------------
  // Exactly-once -- NEGATIF KONTROLLE
  // ---------------------------------------------------------------

  it('ayni Transfer i iki kez uygulamak bakiyeyi DEGISTIRMEZ', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const before = await snapshot(pool)
    const transfer = events.find((e): e is TransferEvent => e.kind === 'transfer')!
    expect(await applyTransferEvent(pool, transfer)).toBe(0)
    expect(await snapshot(pool)).toEqual(before)
  })

  /**
   * ASIL KANIT.
   *
   * `holders.balance_tok` bir DELTA'dir, yani exactly-once BIR ANAHTAR
   * HAKKINDA AKIL YURUTEREK gosterilemez: `token_transfers`in birincil
   * anahtari ikinci INSERT'i engeller ama deltayi engelleyen sey o degil,
   * deltanin `ins`e BAGLI olmasidir. Ikisini ayirt eden tek deney: DEFTER
   * SATIRINI SIL, ayni cagriyi tekrarla, ve bakiyenin TAM OLARAK transfer
   * tutari kadar oynadigini gor.
   */
  it('defter satiri silinince delta YENIDEN uygulanir (negatif kontrol)', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)

    // Curve'den alicilara giden bir transfer sec (mint degil): iki tarafi da
    // olculebilir.
    const transfer = events.find(
      (e): e is TransferEvent =>
        e.kind === 'transfer' && e.from === LIVE.curve && e.to !== LIVE.curve,
    )!
    const before = await holders()
    const balanceOf = (rows: typeof before, who: string): bigint =>
      BigInt(rows.find((r) => r.holder === who)?.balance_tok ?? '0')

    // (1) Defter DURURKEN ikinci cagri: SIFIR yazim, bakiye SABIT.
    expect(await applyTransferEvent(pool, transfer)).toBe(0)
    expect(await holders()).toEqual(before)

    // (2) DEFTER SATIRI SILINIR -- baska HICBIR SEY degistirilmez.
    const { rowCount } = await pool.query('DELETE FROM token_transfers WHERE event_seq = $1', [
      transfer.seq.toString(),
    ])
    expect(rowCount).toBe(1)

    // (3) AYNI CAGRI, bu kez YAZAR.
    expect(await applyTransferEvent(pool, transfer)).toBe(1)

    const after = await holders()
    expect(balanceOf(after, transfer.to) - balanceOf(before, transfer.to)).toBe(transfer.amountTok)
    expect(balanceOf(before, transfer.from) - balanceOf(after, transfer.from)).toBe(
      transfer.amountTok,
    )
    // VE BAKIYELER ARTIK YANLIS OLDUGU HALDE TOPLAM HALA 1e27. Ustteki
    // "toplam her seyi yakalar" duzeltmesinin ikinci yuzu budur: cift
    // uygulanan bir delta da toplami korur. Yani exactly-once'i koruyan sey
    // toplam DEGIL, defterin ta kendisidir -- ve bu deney onu ayirt eden tek
    // olcumdur.
    expect(await balanceSum()).toBe(TOTAL_SUPPLY)
  })

  // ---------------------------------------------------------------
  // EIP-7708 -- uygulama tarafi
  // ---------------------------------------------------------------

  /**
   * Bir tek ticaret isleminde `LaunchToken` `Transfer`'i DISINDA hicbir sey
   * `holders`a dokunmaz. Canli makbuzlar 12 tane `0xfff...ffe` `Transfer`'i
   * TASIYOR, yani bu senaryo enjekte edilmis degil OLCULMUS.
   */
  it('adres filtresi dustugunde ingest ForbiddenEmitter ile DURUR', async () => {
    const logs = smokeLogs()
    const node = new FakeNode(logs, { ignoreAddressFilter: true })
    await expect(
      fetchRange(
        node,
        {
          factory: LIVE.factory,
          escrow: LIVE.escrow,
          curves: new Set(),
          tokens: new Set(),
          curveToToken: new Map(),
          pools: new Map(),
          buyback: null,
        },
        BigInt(logs[0]!.blockNumber),
        BigInt(logs[logs.length - 1]!.blockNumber),
      ),
    ).rejects.toThrow(ForbiddenEmitter)
  })

  it('uygulayici da yasakli bir token u reddeder (ikinci duvar)', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const transfer = events.find((e): e is TransferEvent => e.kind === 'transfer')!
    const smoke = loadSmoke()
    for (const emitter of [
      smoke.nativeTransferEmitter,
      '0x3600000000000000000000000000000000000000',
    ]) {
      await expect(
        applyTransferEvent(pool, {
          ...transfer,
          token: emitter as Address,
          seq: transfer.seq + 1n,
        }),
      ).rejects.toThrow(ForbiddenEmitter)
    }
    // Ve hicbir satir yazilmadi.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM token_transfers WHERE token <> $1',
      [LIVE.token],
    )
    expect(rows[0]!.n).toBe('0')
  })

  it('12 sistem logu ile 5 token logu ayni araliktadir -- ve yalnizca 5 i yazilir', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM token_transfers',
    )
    expect(rows[0]!.n).toBe('5')
    expect(smokeLogs().filter((l) => l.address === loadSmoke().nativeTransferEmitter)).toHaveLength(
      12,
    )
  })
})
