import { beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { toSeq } from '@arcpad/db'
import { applyClaimedEvent, applyRange } from '../src/apply'
import type { ClaimedEvent, DepositedEvent } from '../src/logs'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

/**
 * ================= PAYLASILAN ESCROW, IKI FACTORY =================
 *
 * Faz 2 `LaunchFactory`yi yeniden dagitti ve `FeeEscrow`u DEVRALDI, yani iki
 * factory'nin curve'leri AYNI escrow'a, AYNI alici slotlarina yatiriyor.
 * Bu dosyanin tek isi, "indexer'i factory'nin blogundan baslatalim"
 * optimizasyonunun ne yaptigini CALISTIRARAK gostermek.
 *
 * ASAGIDAKI ON ALTI OLAY UYDURULMADI. 2026-08-09'da canli Arc testnet'ten,
 * escrow adresine `Deposited`/`Claimed` topic'leriyle atilan 135
 * `eth_getLogs` ile cikarildi -- blok, logIndex, tx hash, tutar, alici,
 * yatiran curve ve `blockTimestamp` dahil. Zincirin kendi defteriyle
 * capraz kontrol edildi:
 *
 *   owed(0xebbecfda...) = 244123236093493081   = 115572551511684482 + 128550684581808599
 *   owed(0xe92c64c4...) =  77091548240050448   =  36496595214216153 +  40594953025834295
 *   totalOwed()         = 321214784333543529   = escrow'un `eth_getBalance`i
 *
 * Her satirin SOL tarafi zincirin cevabi, SAG tarafi bu dosyadaki olaylarin
 * toplami.
 */

const TREASURY = '0xebbecfda308ea307e173c6ec19a9c48f53d4b10c' as Address
const CREATOR = '0xe92c64c4f36216ea773f2622f6d5f8530ae92fd2' as Address
const ESCROW = '0xeed4431ead3e27f16d97f677a9c4c1a963df8dc6' as Address
/** Faz 1'in curve'u -- FACTORY YENIDEN DAGITILDI, curve KALDI. */
const CURVE_1 = '0x7938be340a14a12f94a83aea246d9d2566324c9c' as Address
/** Faz 2'nin curve'u (PHASE2SMOKE). */
const CURVE_2 = '0xddb9e739a948c968eb4c7e1449b94c598b1cf27b' as Address

/** Zincirin OKUNMUS cevaplari (2026-08-09, `eth_call` + `eth_getBalance`). */
const ON_CHAIN = {
  owedTreasury: 244_123_236_093_493_081n,
  owedCreator: 77_091_548_240_050_448n,
  totalOwed: 321_214_784_333_543_529n,
  /** `feeEscrowBlock` -- escrow'un yaratildigi blok. */
  escrowBlock: 54_661_437n,
  /** `launchFactoryBlock` -- CANLI factory'nin yaratildigi blok. */
  factoryBlock: 55_870_261n,
} as const

type Row = readonly [
  block: bigint,
  logIndex: number,
  tx: string,
  recipient: Address,
  amount: bigint,
]

/** `[feeEscrowBlock, launchFactoryBlock)` -- factory HENUZ YOKKEN. */
const BEFORE_THE_FACTORY: readonly Row[] = [
  [
    54_663_522n,
    82,
    '0x19b31cd0e018ccbd730d595c401f3a5b5399b28a565e6f5404baed7ad282da8d',
    TREASURY,
    469_135_802_469_136n,
  ],
  [
    54_663_522n,
    84,
    '0x19b31cd0e018ccbd730d595c401f3a5b5399b28a565e6f5404baed7ad282da8d',
    CREATOR,
    148_148_148_148_149n,
  ],
  [
    54_663_526n,
    9,
    '0x65bf2b3c8bd98721378a4c25d1b488037baab5f956fb0821a377346020b7c367',
    TREASURY,
    38_916_154_037_428n,
  ],
  [
    54_663_526n,
    11,
    '0x65bf2b3c8bd98721378a4c25d1b488037baab5f956fb0821a377346020b7c367',
    CREATOR,
    12_289_311_801_293n,
  ],
  [
    54_663_533n,
    64,
    '0xe8cf97528a52d290bfedd834cec651c818a9ac8609244de76f95a30d1cde45e1',
    TREASURY,
    19_467_252_805_442n,
  ],
  [
    54_663_533n,
    66,
    '0xe8cf97528a52d290bfedd834cec651c818a9ac8609244de76f95a30d1cde45e1',
    CREATOR,
    6_147_553_517_508n,
  ],
  [
    54_663_673n,
    30,
    '0x2d18eac2aceeceb8e3de65245400893fdaf6a588b32e144b1ff9407eb9361e27',
    TREASURY,
    115_045_032_302_372_476n,
  ],
  [
    54_663_673n,
    32,
    '0x2d18eac2aceeceb8e3de65245400893fdaf6a588b32e144b1ff9407eb9361e27',
    CREATOR,
    36_330_010_200_749_203n,
  ],
]

/** `[launchFactoryBlock, head]` -- Faz 2 smoke'unun dort ticareti. */
const AFTER_THE_FACTORY: readonly Row[] = [
  [
    55_872_663n,
    39,
    '0xe3819095b6aa789a225b4d700a592217f73c239292ca8b7488be4a1f6f75f59a',
    TREASURY,
    9_382_716_049_382_717n,
  ],
  [
    55_872_663n,
    41,
    '0xe3819095b6aa789a225b4d700a592217f73c239292ca8b7488be4a1f6f75f59a',
    CREATOR,
    2_962_962_962_962_963n,
  ],
  [
    55_872_731n,
    30,
    '0xd31544f754eb012720301d955c2bd16d925f5d3bb9331e2b546dcfb6d4afa828',
    TREASURY,
    6_494_661_624_177_732n,
  ],
  [
    55_872_731n,
    32,
    '0xd31544f754eb012720301d955c2bd16d925f5d3bb9331e2b546dcfb6d4afa828',
    CREATOR,
    2_050_945_776_056_126n,
  ],
  [
    55_872_809n,
    5,
    '0x863d5153f69cd79573042c94e4a41597c70e40d6c5d21910c2c99f08f9cb48aa',
    TREASURY,
    6_508_533_787_867_500n,
  ],
  [
    55_872_809n,
    7,
    '0x863d5153f69cd79573042c94e4a41597c70e40d6c5d21910c2c99f08f9cb48aa',
    CREATOR,
    2_055_326_459_326_579n,
  ],
  [
    55_872_867n,
    35,
    '0xb70713a22dad3e8103c3229a9f0655e21fcb315daa71a0ce35012824178924a8',
    TREASURY,
    106_164_773_120_380_650n,
  ],
  [
    55_872_867n,
    37,
    '0xb70713a22dad3e8103c3229a9f0655e21fcb315daa71a0ce35012824178924a8',
    CREATOR,
    33_525_717_827_488_627n,
  ],
]

function deposits(rows: readonly Row[], from: Address): DepositedEvent[] {
  return rows.map(([block, logIndex, tx, recipient, amount]) => ({
    kind: 'deposited',
    seq: toSeq(block, logIndex),
    blockNumber: block,
    logIndex,
    txHash: tx as Hex,
    // Zamanin bu testte HICBIR iddiaya girmedigi bilincli: olculen sey
    // defterin ARITMETIGI. Blok numarasindan turetilen bir damga, siralamayi
    // `event_seq`in tasidigini da yanlislikla gizlemez.
    blockTime: new Date(Number(block) * 1000),
    escrow: ESCROW,
    recipient,
    from,
    amountWei: amount,
  }))
}

const sum = (rows: readonly Row[], recipient?: Address): bigint =>
  rows
    .filter((r) => recipient === undefined || r[3] === recipient)
    .reduce((acc, r) => acc + r[4], 0n)

/**
 * ZINCIRIN YAYACAGI `Claimed`. `FeeEscrow.claim()` slotun TAMAMINI oder, yani
 * tutar `owed[recipient]`tir -- indexer'in ne kadarini gordugune BAKMAZ.
 * Zincirde henuz hic `claim()` cagrilmadi (olculdu: iki yarida da sifir
 * `Claimed`), yani asagidaki senaryo bugun GIZLI ve yarin kacinilmaz.
 */
function fullSlotClaim(recipient: Address, amount: bigint): ClaimedEvent {
  const block = 56_010_150n
  const logIndex = 0
  return {
    kind: 'claimed',
    seq: toSeq(block, logIndex),
    blockNumber: block,
    logIndex,
    // GELECEKTEKI bir islem: hash'i uydurulmus ve OYLE OLDUGU YAZILI. Testin
    // olctugu sey tutarin muhasebesi; hash yalnizca semanin bicim CHECK'ini
    // gecmek icin var.
    txHash: `0x${'11'.repeat(32)}` as Hex,
    blockTime: new Date(Number(block) * 1000),
    escrow: ESCROW,
    recipient,
    amountWei: amount,
  }
}

async function ledgerSum(): Promise<bigint> {
  const { rows } = await pool.query<{ total: string }>(
    'SELECT coalesce(sum(claimable_wei), 0)::text AS total FROM fee_balances',
  )
  return BigInt(rows[0]!.total)
}

async function claimable(recipient: Address): Promise<bigint> {
  const { rows } = await pool.query<{ c: string }>(
    'SELECT claimable_wei::text AS c FROM fee_balances WHERE recipient = $1',
    [recipient],
  )
  return rows[0] === undefined ? 0n : BigInt(rows[0].c)
}

describe('paylasilan escrow -- startBlock in ne kadarini kapsadigi', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  /**
   * ONCE ARITMETIK: bu dosyadaki olaylar zincirin kendi defterini yeniden
   * uretiyor mu. Uretmiyorlarsa asagidaki iki senaryonun hicbiri bir sey
   * ispatlamaz -- ve bu, "olculmus" diye yazilmis bir fixture'in sessizce
   * bayatlamasinin tek panzehiri.
   */
  it('on alti olay zincirin owed/totalOwed cevaplarini WEI WEI yeniden uretir', () => {
    const all = [...BEFORE_THE_FACTORY, ...AFTER_THE_FACTORY]
    expect(sum(all, TREASURY)).toBe(ON_CHAIN.owedTreasury)
    expect(sum(all, CREATOR)).toBe(ON_CHAIN.owedCreator)
    expect(sum(all)).toBe(ON_CHAIN.totalOwed)
    // On ekin AGIRLIGI: handoff'un rakami.
    expect(sum(BEFORE_THE_FACTORY)).toBe(152_069_146_725_900_635n)
    // VE ON EK IKI ALICIYA DA DOKUNUYOR -- mesele "eski bir creator" degil.
    expect(sum(BEFORE_THE_FACTORY, TREASURY)).toBeGreaterThan(0n)
    expect(sum(BEFORE_THE_FACTORY, CREATOR)).toBeGreaterThan(0n)
    // Ve on ek GERCEKTEN factory'den once: son on-ek olayi factory'nin
    // blogundan kucuk, ilk son-ek olayi buyuk.
    expect(BEFORE_THE_FACTORY[BEFORE_THE_FACTORY.length - 1]![0]).toBeLessThan(
      ON_CHAIN.factoryBlock,
    )
    expect(AFTER_THE_FACTORY[0]![0]).toBeGreaterThan(ON_CHAIN.factoryBlock)
    expect(BEFORE_THE_FACTORY[0]![0]).toBeGreaterThan(ON_CHAIN.escrowBlock)
  })

  /**
   * DOGRU HAL: `startBlock = min(feeEscrowBlock, launchFactoryBlock)`.
   *
   * Iki yari da girer, defter zincirin `totalOwed`ina ESITTIR, ve slotun
   * tamamini ceken `Claimed` SORUNSUZ uygulanir.
   */
  it('escrow un blogundan baslamak: defter totalOwed a esit ve claim GECER', async () => {
    await applyRange(pool, LIVE_DEPLOYMENT, [
      ...deposits(BEFORE_THE_FACTORY, CURVE_1),
      ...deposits(AFTER_THE_FACTORY, CURVE_2),
    ])
    expect(await ledgerSum()).toBe(ON_CHAIN.totalOwed)
    expect(await claimable(TREASURY)).toBe(ON_CHAIN.owedTreasury)
    expect(await claimable(CREATOR)).toBe(ON_CHAIN.owedCreator)

    expect(await applyClaimedEvent(pool, fullSlotClaim(TREASURY, ON_CHAIN.owedTreasury))).toBe(1)
    expect(await claimable(TREASURY)).toBe(0n)
    expect(await ledgerSum()).toBe(ON_CHAIN.owedCreator)
  })

  /**
   * ================== YANLIS HAL, CALISTIRILARAK ==================
   *
   * `startBlock = launchFactoryBlock` -- yani "1,2M bos blogu atlayalim".
   * Defter TAM OLARAK 152069146725900635 wei eksik kalir ve eksik IKI
   * ALICIYA da dagilmistir. Sonra zincir slotun TAMAMINI odeyen `Claimed`i
   * yayar ve defter PATLAR.
   *
   * KAYIP GERI ALINAMAZ: `applyRange` islemi geri sarar, yani aralik HIC
   * yazilmaz; imlec ilerlemez; surec `CHECK` hatasiyla oler (adi hicbir
   * kumede olmadigi icin `isTransient` KALICI der) ve her yeniden baslatma
   * AYNI araligi tekrar oynatip AYNI yerde oler.
   */
  it('factory nin blogundan baslamak: defter eksik ve ilk claim DEFTERI PATLATIR', async () => {
    await applyRange(pool, LIVE_DEPLOYMENT, deposits(AFTER_THE_FACTORY, CURVE_2))

    // (1) EKSIK, VE EKSIGIN TAM ADI VAR.
    expect(await ledgerSum()).toBe(ON_CHAIN.totalOwed - 152_069_146_725_900_635n)
    expect(ON_CHAIN.totalOwed - (await ledgerSum())).toBe(sum(BEFORE_THE_FACTORY))
    expect(await claimable(TREASURY)).toBeLessThan(ON_CHAIN.owedTreasury)
    expect(await claimable(CREATOR)).toBeLessThan(ON_CHAIN.owedCreator)

    // (2) ZINCIRIN YAYACAGI OLAY -- indexer'in gordugunden BUYUK.
    const claim = fullSlotClaim(TREASURY, ON_CHAIN.owedTreasury)
    await expect(applyRange(pool, LIVE_DEPLOYMENT, [claim])).rejects.toThrow(/claimable_wei/)

    // (3) VE BU BIR KILITLENMEDIR, GECICI BIR HATA DEGIL: islem geri sarildi,
    //     yani olay defterde YOK ve bir sonraki tur AYNI araligi tekrar
    //     oynatir -- ayni tutarla, ayni sonucla.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM fee_events WHERE event_seq = $1',
      [claim.seq.toString()],
    )
    expect(rows[0]!.n).toBe('0')
    await expect(applyRange(pool, LIVE_DEPLOYMENT, [claim])).rejects.toThrow(/claimable_wei/)

    // (4) AYIRT EDICI KONTROL: patlatan sey "claim" degil, EKSIK ON EK.
    //     Ayni claim, on ek de girdiginde GECIYOR.
    await resetSchema()
    await seedDeployment()
    await applyRange(pool, LIVE_DEPLOYMENT, [
      ...deposits(BEFORE_THE_FACTORY, CURVE_1),
      ...deposits(AFTER_THE_FACTORY, CURVE_2),
    ])
    await expect(applyRange(pool, LIVE_DEPLOYMENT, [claim])).resolves.toMatchObject({ fees: 1 })
  })

  /**
   * ON EKIN OLAYLARI DEFTERE GIRER AMA HICBIR `launches` SATIRINA BAGLANMAZ,
   * VE BU FARK OLCULEBILIR.
   *
   * `fee_events.from_addr` yatiran curve'dur, yani provenance TAM; eksik olan
   * sey `curve_state`/`launches` tarafidir -- Faz 1'in launch'i BU
   * dagitimin launch'i degildir ve hic cekilmez (`Launched` yalnizca
   * `watch.factory` adresinden gelir).
   *
   * SONUCU BIR SORGU FARKIDIR: `listCreatorEarningsByLaunch`in kullandigi
   * `fee_events -> curve_state -> launches` ic birlesimi bu satirlari SESSIZCE
   * duurur, yani "launch basina kazanc" dokumu `getClaimableFees`in verdigi
   * toplami TUTMAZ. Bu test farkin BUYUKLUGUNU yaziyor ki bir sonraki okuyan
   * onu bir kayip sanmasin: para defterde, birlesimde degil.
   */
  it('on ekin ucretleri defterdedir ama launch dokumune GIRMEZ (fark olculur)', async () => {
    await applyRange(pool, LIVE_DEPLOYMENT, [
      ...deposits(BEFORE_THE_FACTORY, CURVE_1),
      ...deposits(AFTER_THE_FACTORY, CURVE_2),
    ])

    // Defter tarafi: creator'in TAM alacagi.
    expect(await claimable(CREATOR)).toBe(ON_CHAIN.owedCreator)

    // Birlesim tarafi: `curve_state` bos oldugu icin HICBIR satir. (Gercek
    // kosuda Faz 2'nin curve'u vardir; burada olculen sey ic birlesimin
    // sessizligi, tam olarak o sessizlik.)
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM fee_events f
         JOIN curve_state c ON c.curve = f.from_addr
        WHERE f.kind = 'deposit' AND f.recipient = $1`,
      [CREATOR],
    )
    expect(rows[0]!.n).toBe('0')

    // Ve provenance KAYBOLMADI: her satirin yatiran curve'u yazili, iki
    // dagitimin curve'leri ADIYLA ayirt edilebiliyor.
    const { rows: byCurve } = await pool.query<{ from_addr: string; s: string }>(
      `SELECT from_addr, sum(amount_wei)::text AS s
         FROM fee_events WHERE kind = 'deposit' GROUP BY from_addr ORDER BY from_addr`,
      [],
    )
    expect(byCurve).toHaveLength(2)
    expect(new Map(byCurve.map((r) => [r.from_addr, BigInt(r.s)]))).toEqual(
      new Map([
        [CURVE_1, sum(BEFORE_THE_FACTORY)],
        [CURVE_2, sum(AFTER_THE_FACTORY)],
      ]),
    )
  })
})
