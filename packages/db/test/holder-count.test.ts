import { beforeEach, describe, expect, it } from 'vitest'
import { applyLaunch, applyTransfer } from '../src/apply'
import { putDeployment } from '../src/deployment'
import { pool, resetSchema } from './setup'
import { ALICE, BUY_TRANSFER, CURVE, DEPLOYMENT, hash32, LAUNCH, MINT, TOKEN } from './fixtures'
import { toSeq } from '../src/seq'

/**
 * `token_stats.holder_count` -- BU PAKETIN YAZDIGI, KULLANICININ GORDUGU SAYI.
 *
 * BU DOSYA VAR CUNKU KURAL BURADA YAZILIYOR AMA BASKA BIR PAKETTEN OLCULUYORDU.
 *
 * `applyTransfer` (`src/apply.ts`) her transfer'den sonra `holder_count`'u
 * yeniden sayar ve sayarken CURVE'U HARIC TUTAR. Gerekce dogru ve kodun
 * yaninda yazili: `LaunchToken` tum arzi (1e27) constructor'da curve'e basar,
 * yani launch aninda curve TEK holder'dir; onu saymak hicbir kullanicisi
 * olmayan bir token'i "1 holder" diye gostermek olurdu.
 *
 * OLCULDU (2026-08-08): o HARIC TUTMA kaldirildiginda
 * `pnpm --filter @arcpad/db test` 284/284 YESIL kaliyordu. Tek iddia
 * `indexer/test/apply-transfer.test.ts`teydi, yani BASKA bir paketin
 * suitinde: `packages/db` uzerinde calisip kendi suitini kosan biri, yanlis
 * bir kullanici-gorunur sayi icin yesil isik aliyordu. Bu, bu depodaki
 * "bir ozellik bir giris noktasinda kapsanmis olmak, hepsinde kapsanmis gibi
 * okunur" kalibinin paket olcegindeki hali.
 *
 * Indexer'daki testler KALIYOR ve kopya degiller: onlar CANLI zincir
 * fixture'iyla ayni sayiyi olcuyor. Buradaki, kurali yazan pakete kendi
 * kapisini veriyor.
 */
describe('holder_count -- curve HARIC', () => {
  const countOf = async (): Promise<number> => {
    const { rows } = await pool.query<{ holder_count: number }>(
      'SELECT holder_count FROM token_stats WHERE token = $1',
      [TOKEN],
    )
    return rows[0]!.holder_count
  }

  const balances = async (): Promise<Record<string, string>> => {
    const { rows } = await pool.query<{ holder: string; balance_tok: string }>(
      'SELECT holder, balance_tok FROM holders WHERE token = $1 ORDER BY holder',
      [TOKEN],
    )
    return Object.fromEntries(rows.map((r) => [r.holder, r.balance_tok]))
  }

  beforeEach(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await applyLaunch(pool, LAUNCH)
  })

  it('mint sonrasi curve TEK bakiye sahibidir ama holder_count SIFIRDIR', async () => {
    expect(await applyTransfer(pool, MINT)).toBe(1)
    // Iki iddia birlikte AYIRT EDICI: `holders` satiri GERCEKTEN var, yani
    // sifir "hic kayit yok"tan degil, HARIC TUTMADAN geliyor.
    expect(await balances()).toEqual({ [CURVE]: DEPLOYMENT.totalSupplyTok.toString() })
    expect(await countOf()).toBe(0)
  })

  it('ilk alicidan sonra 1 -- curve hala bakiye tasiyor ve hala sayilmiyor', async () => {
    await applyTransfer(pool, MINT)
    await applyTransfer(pool, BUY_TRANSFER)
    const rows = await balances()
    // Curve'un bakiyesi POZITIF; yani sayim onu "bakiyesi yok" diye degil,
    // KIMLIGINDEN dolayi disliyor.
    expect(BigInt(rows[CURVE]!)).toBeGreaterThan(0n)
    expect(BigInt(rows[ALICE]!)).toBe(BUY_TRANSFER.amountTok)
    expect(await countOf()).toBe(1)
  })

  it('sifira dusen bir holder sayilmaz -- satir kalir, sayi duser', async () => {
    await applyTransfer(pool, MINT)
    await applyTransfer(pool, BUY_TRANSFER)
    expect(await countOf()).toBe(1)
    // ALICE her seyi curve'e geri satar.
    await applyTransfer(pool, {
      ...BUY_TRANSFER,
      eventSeq: toSeq(BUY_TRANSFER.blockNumber, BUY_TRANSFER.logIndex + 1),
      logIndex: BUY_TRANSFER.logIndex + 1,
      txHash: hash32(0xd7a1),
      from: ALICE,
      to: CURVE,
    })
    expect(BigInt((await balances())[ALICE]!)).toBe(0n)
    expect(await countOf()).toBe(0)
  })
})
