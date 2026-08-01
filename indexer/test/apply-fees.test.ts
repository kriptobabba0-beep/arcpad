import { beforeEach, describe, expect, it } from 'vitest'
import { snapshot, withTransaction } from '@arcpad/db'
import { applyClaimedEvent, applyDepositedEvent, applyEvents, applyRange } from '../src/apply'
import type { ClaimedEvent, DepositedEvent } from '../src/logs'
import { createPacer, decodeAll } from '../src/logs'
import { FakeNode, LIVE, liveDecodedEvents, rawLogs } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

/** Canli escrow'un OLCULMUS `totalOwed`i (smoke sonrasi, zincirden). */
const LIVE_TOTAL_OWED = 152_069_146_725_900_635n

async function balances(): Promise<
  {
    recipient: string
    claimable_wei: string
    deposited_total_wei: string
    claimed_total_wei: string
  }[]
> {
  const { rows } = await pool.query<{
    recipient: string
    claimable_wei: string
    deposited_total_wei: string
    claimed_total_wei: string
  }>(
    `SELECT recipient, claimable_wei::text AS claimable_wei,
            deposited_total_wei::text AS deposited_total_wei,
            claimed_total_wei::text AS claimed_total_wei
       FROM fee_balances ORDER BY recipient`,
  )
  return rows
}

describe('apply/fees', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  it('canli smoke un sekiz Deposited i uygulanir', async () => {
    const counts = await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    expect(counts.fees).toBe(8)
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM fee_events WHERE kind = 'deposit'",
    )
    expect(rows[0]!.n).toBe('8')
  })

  /**
   * TOPLAM, ESCROW'UN OLCULMUS `totalOwed`INA ESIT.
   *
   * Bu sayi zincirden okundu (`152069146725900635`) ve ucretin PARCALARDAN
   * toplandiginin -- 125 bps'ten BOLUNMEDIGININ -- kanitidir: bolunmus hesap
   * ticaret #1'de bir wei EKSIK verir ve toplam tutmazdi.
   */
  it('claimable toplami escrow un olculmus totalOwed una esittir', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const { rows } = await pool.query<{ total: string }>(
      'SELECT sum(claimable_wei)::text AS total FROM fee_balances',
    )
    expect(BigInt(rows[0]!.total)).toBe(LIVE_TOTAL_OWED)
  })

  // Protokol ve creator paylari AYRI ALICILARDIR; escrow bir bolusturme
  // yapmaz, `deposit()` iki kez cagrilir.
  it('protokol ile creator paylari AYRI alicilardir', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const rows = await balances()
    expect(rows).toHaveLength(2)
    // Ikisinin toplami yine escrow'un `totalOwed`i.
    expect(rows.reduce((acc, r) => acc + BigInt(r.claimable_wei), 0n)).toBe(LIVE_TOTAL_OWED)
  })

  /**
   * `Deposited.from` CURVE ADRESIDIR -- ucret LAUNCH BASINA dokulebilir.
   * Bu alan olmadan "creator'in hangi launch'tan ne kazandigi" sorusunun
   * cevabi HICBIR YERDE yazili olmazdi.
   */
  it('Deposited.from curve adresidir -> ucret launch basina dokulur', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const { rows } = await pool.query<{ token: string; s: string }>(
      `SELECT l.token, sum(f.amount_wei)::text AS s
         FROM fee_events f
         JOIN curve_state c ON c.curve = f.from_addr
         JOIN launches l ON l.token = c.token
        WHERE f.kind = 'deposit'
        GROUP BY l.token`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token).toBe(LIVE.token)
    expect(BigInt(rows[0]!.s)).toBe(LIVE_TOTAL_OWED)
  })

  it('claimable HER ZAMAN deposited - claimed (CHECK bunu uygular)', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    for (const row of await balances()) {
      expect(BigInt(row.claimable_wei)).toBe(
        BigInt(row.deposited_total_wei) - BigInt(row.claimed_total_wei),
      )
    }
    // Ve kisit GERCEKTEN vardir: elle bozmaya calismak SUNUCUDA patlar.
    await expect(
      pool.query('UPDATE fee_balances SET claimable_wei = claimable_wei + 1'),
    ).rejects.toThrow(/claimable_is_the_difference/)
  })

  it('claim sonrasi claimable sifir, deposited_total KORUNUR', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const before = (await balances())[0]!
    const events = await liveDecodedEvents()
    const last = events[events.length - 1]!

    // `Claimed`in COZME yolu `claim.json` fixture'iyla ayrica test ediliyor
    // (topics/logs testleri). Burada olculen sey DEFTERIN kendisi: alicinin
    // butun alacagini ceken bir `Claimed`.
    const claim: ClaimedEvent = {
      kind: 'claimed',
      seq: last.seq + 10n,
      blockNumber: last.blockNumber,
      logIndex: last.logIndex + 10,
      txHash: last.txHash,
      blockTime: last.blockTime,
      escrow: LIVE.escrow,
      recipient: before.recipient as `0x${string}`,
      amountWei: BigInt(before.claimable_wei),
    }
    expect(await applyClaimedEvent(pool, claim)).toBe(1)

    const after = (await balances()).find((r) => r.recipient === before.recipient)!
    expect(after.claimable_wei).toBe('0')
    expect(after.deposited_total_wei).toBe(before.deposited_total_wei)
    expect(after.claimed_total_wei).toBe(before.deposited_total_wei)
  })

  it('alacagindan FAZLASINI ceken bir claim SUNUCUDA patlar', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const before = (await balances())[0]!
    const events = await liveDecodedEvents()
    const last = events[events.length - 1]!
    const tooMuch: ClaimedEvent = {
      kind: 'claimed',
      seq: last.seq + 20n,
      blockNumber: last.blockNumber,
      logIndex: last.logIndex + 20,
      txHash: last.txHash,
      blockTime: last.blockTime,
      escrow: LIVE.escrow,
      recipient: before.recipient as `0x${string}`,
      amountWei: BigInt(before.claimable_wei) + 1n,
    }
    // Zincirde imkansizdir (`FeeEscrow` revert eder), ama indexer'in
    // muhasebesi de bunu SESSIZCE kabul etmemeli: negatif bir alacak
    // `claimable_wei >= 0` ile gurultulu biter.
    await expect(applyClaimedEvent(pool, tooMuch)).rejects.toThrow(/claimable_wei/)
  })

  // ---------------------------------------------------------------
  // Exactly-once -- NEGATIF KONTROLLE
  // ---------------------------------------------------------------

  it('ayni Deposited i iki kez uygulamak bakiyeyi DEGISTIRMEZ', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const before = await snapshot(pool)
    const deposit = events.find((e): e is DepositedEvent => e.kind === 'deposited')!
    expect(await applyDepositedEvent(pool, deposit)).toBe(0)
    expect(await snapshot(pool)).toEqual(before)
  })

  it('defter satiri silinince ayni Deposited YENIDEN uygulanir (negatif kontrol)', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const deposit = events.find((e): e is DepositedEvent => e.kind === 'deposited')!
    const before = (await balances()).find((r) => r.recipient === deposit.recipient)!

    await pool.query('DELETE FROM fee_events WHERE event_seq = $1', [deposit.seq.toString()])
    expect(await applyDepositedEvent(pool, deposit)).toBe(1)

    const after = (await balances()).find((r) => r.recipient === deposit.recipient)!
    expect(BigInt(after.claimable_wei) - BigInt(before.claimable_wei)).toBe(deposit.amountWei)
    expect(BigInt(after.deposited_total_wei) - BigInt(before.deposited_total_wei)).toBe(
      deposit.amountWei,
    )
    // Ve toplam ARTIK escrow'unkinden BUYUK: cift sayim burada GORUNUR --
    // `SUM(claimable)` escrow bakiyesinin ALT SINIRI olmaktan cikip onu
    // ASARDI, ki tam olarak bu yuzden defter kapisi vardir.
    const { rows } = await pool.query<{ total: string }>(
      'SELECT sum(claimable_wei)::text AS total FROM fee_balances',
    )
    expect(BigInt(rows[0]!.total)).toBe(LIVE_TOTAL_OWED + deposit.amountWei)
  })

  /**
   * ISLEMSIZ BIR CAGRI, BASARISIZ BIR YAZIMDAN SONRA DEFTERI KILITLER.
   *
   * OLCULMUS ARIZA (bu dosyanin ilk kosusunda gerceklesti): `applyFeeEvent`
   * IKI ifadedir -- `fee_events` INSERT'i, sonra `fee_balances` UPDATE'i.
   * Ikinci ifade patlarsa ve cagri bir islemin DISINDAYSA, birinci ifade
   * ISLENMIS olarak kalir. O andan sonra defter "bu olay zaten uygulandi" der
   * ve tutar BIR DAHA HIC uygulanmaz.
   *
   * Bu testin isi o davranisi SABITLEMEK degil, GORUNUR kilmak: aralik
   * `applyRange` ile TEK ISLEMDE uygulanmali, ve asagidaki ikinci yari onun
   * arizayi kapattigini olcuyor.
   */
  it('islemsiz bir basarisiz claim defteri kilitler; applyRange kilitlemez', async () => {
    const events = await liveDecodedEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const before = (await balances())[0]!
    const last = events[events.length - 1]!
    const tooMuch: ClaimedEvent = {
      kind: 'claimed',
      seq: last.seq + 30n,
      blockNumber: last.blockNumber,
      logIndex: last.logIndex + 30,
      txHash: last.txHash,
      blockTime: last.blockTime,
      escrow: LIVE.escrow,
      recipient: before.recipient as `0x${string}`,
      amountWei: BigInt(before.claimable_wei) + 1n,
    }
    // (1) ISLEMSIZ: patlar, ama defter satiri KALIR.
    await expect(applyClaimedEvent(pool, tooMuch)).rejects.toThrow(/claimable_wei/)
    const { rows: stuck } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM fee_events WHERE event_seq = $1',
      [tooMuch.seq.toString()],
    )
    expect(stuck[0]!.n).toBe('1')
    // Ve simdi gecerli bir tutarla bile YAZILAMAZ: defter onu "uygulanmis"
    // sayiyor.
    const valid: ClaimedEvent = { ...tooMuch, amountWei: 1n }
    expect(await applyClaimedEvent(pool, valid)).toBe(0)

    // (2) AYNI SENARYO `applyRange` ile: hicbir iz kalmaz.
    await pool.query('DELETE FROM fee_events WHERE event_seq = $1', [tooMuch.seq.toString()])
    await expect(applyRange(pool, LIVE_DEPLOYMENT, [tooMuch])).rejects.toThrow(/claimable_wei/)
    const { rows: clean } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM fee_events WHERE event_seq = $1',
      [tooMuch.seq.toString()],
    )
    expect(clean[0]!.n).toBe('0')
    // Ve ayni olay artik gecerli tutarla YAZILABILIR.
    expect(await applyRange(pool, LIVE_DEPLOYMENT, [valid])).toMatchObject({ fees: 1 })
  })

  // ---------------------------------------------------------------
  // Escrow bakiyesi -- KARAR
  // ---------------------------------------------------------------

  /**
   * `SUM(fee_balances.claimable_wei)` escrow'un zincir ustu bakiyesinin bir
   * ALT SINIRIDIR, esiti degil. `FeeEscrow`'un NatSpec'i (kisit 1) olculmus
   * bir olguyu kaydediyor: bakiye `deposit()` DISINDAN da artabilir
   * (`USDC.transfer(escrow, x)` basarili olur, `receive()` hic calismaz) ve o
   * para TALEP EDILEMEZ.
   *
   * Bu test o farki CALISTIRILABILIR yapiyor: defterin bilmedigi bir bagis,
   * defteri DEGISTIRMEZ -- yani arayuz escrow bakiyesini "talep edilebilir
   * ucret" diye gosterirse yanlis bir rakam gosterir.
   */
  it('defter bilmedigi bir bagisla DEGISMEZ -- toplam bir ALT SINIRDIR', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const before = await balances()
    // Zincirde escrow'a duz bir transfer: HICBIR `Deposited` yayilmaz, yani
    // indexer'in gorecegi hicbir olay yoktur ve defter oldugu gibi kalir.
    expect(await balances()).toEqual(before)
    const { rows } = await pool.query<{ total: string }>(
      'SELECT sum(claimable_wei)::text AS total FROM fee_balances',
    )
    expect(BigInt(rows[0]!.total)).toBe(LIVE_TOTAL_OWED)
  })

  // `claim.json` fixture'i: `Claimed`in COZME yolu gercek baytlarla.
  it('claim fixture i defterde bir claim satiri acar', async () => {
    const block = 54_800_000n
    const events = await decodeAll(
      new FakeNode([]),
      rawLogs('claim', { block }),
      block,
      block,
      createPacer(),
    )
    const claimed = events[0]
    if (claimed?.kind !== 'claimed') throw new Error('claim fixture Claimed tasimiyor')
    // Alacagi olmayan bir aliciya yapilan claim, defteri negatife dusurur ve
    // GURULTULU patlar -- yani "once yatirim, sonra cekme" sirasi
    // veritabaninda da zorunlu. ISLEMIN ICINDE cagriliyor: disarida
    // cagrilsaydi `fee_events` satiri islenmis olarak KALIRDI (asagidaki
    // teste bak).
    await expect(
      withTransaction(pool, async (tx) => applyClaimedEvent(tx, claimed)),
    ).rejects.toThrow(/claimable_wei/)

    // Ayni aliciya once yatirim yapilirsa cekme gecer.
    const deposit: DepositedEvent = {
      kind: 'deposited',
      seq: claimed.seq - 1n,
      blockNumber: claimed.blockNumber,
      logIndex: claimed.logIndex,
      txHash: claimed.txHash,
      blockTime: claimed.blockTime,
      escrow: claimed.escrow,
      recipient: claimed.recipient,
      from: LIVE.curve,
      amountWei: claimed.amountWei,
    }
    expect(await applyDepositedEvent(pool, deposit)).toBe(1)
    expect(await applyClaimedEvent(pool, claimed)).toBe(1)
    const row = (await balances()).find((r) => r.recipient === claimed.recipient)!
    expect(row.claimable_wei).toBe('0')
    expect(row.claimed_total_wei).toBe(claimed.amountWei.toString())
  })
})
