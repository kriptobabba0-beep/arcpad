import { beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from '../src/pool'
import { pool, resetSchema } from './setup'

/**
 * ADLANDIRMA KAPISI.
 *
 * Arc'in native varligi USDC'dir ve IKI GORUNUMU vardir: 18 decimal native ve
 * 0x3600000000000000000000000000000000000000 adresindeki 6 decimal ERC-20.
 * Ikisi AYNI bakiyenin iki gorunumudur ve ASLA toplanmaz. Bir sutunun hangi
 * gorunumu tasidigi ADINDAN anlasilmazsa, yanlis gorunumu yazmak sessiz kalir
 * ve hicbir CHECK onu yakalayamaz -- 1e12'lik bir carpan hatasi tamamen
 * gecerli bir sayidir.
 *
 * PLANDAKI IKI HATA BURADA DUZELTILDI (ikisi de planin KENDI semasini
 * reddediyordu):
 *   - `_time` soneki listede yoktu, ama plan `trades.block_time`,
 *     `token_transfers.block_time` ve `fee_events.block_time` sutunlarini
 *     tanimliyor.
 *   - `id` (duz, oneksiz) muafiyet listesinde yoktu, ama plan
 *     `deployment.id` ve `sync_state.id` sutunlarini tanimliyor. `_id$`
 *     deseni `id`nin kendisiyle eslesmez.
 */
const MONEYISH = /(_wei|_tok|_ppm|_bps|_seq|_at|_time|_count|_id|_block|_number|_index|_hash)$/
const FORBIDDEN = /(_usdc|_uusdc|_micro|_e6)$/

const EXEMPT = new Set([
  'token',
  'curve',
  'trader',
  'holder',
  'recipient',
  'creator',
  'launch_creator',
  'from_addr',
  'to_addr',
  'factory',
  'escrow',
  'protocol_treasury',
  'name',
  'symbol',
  'uri',
  'salt',
  'kind',
  'reason',
  'expected',
  'raw',
  'source',
  'complete',
  'is_buy',
  'filename',
  // Tekil satirli tablolarin (`deployment`, `sync_state`) sabit birincil
  // anahtari. Bir tutar DEGILDIR ve bir tutar olamaz: `CHECK (id = 1)`.
  'id',
])

interface Col {
  table_name: string
  column_name: string
}

const ALL_COLUMNS = `
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY 1, 2`

const WIDE_NUMERICS = `
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND data_type = 'numeric'
    AND numeric_precision = 78 AND numeric_scale = 0
  ORDER BY 1, 2`

/**
 * KAPININ KENDISI, tek bir yerde. Hem gercek semaya hem de asagidaki NEGATIF
 * KONTROLE AYNI kod uygulanir -- iki ayri kopya olsaydi, negatif kontrolun
 * gecmesi gercek kapinin calistigini gostermezdi.
 */
async function gateViolations(db: {
  query: (t: string) => Promise<{ rows: Col[] }>
}): Promise<{ wideNumericsChecked: number; badWidth: Col[]; forbidden: Col[]; unsuffixed: Col[] }> {
  const wide = (await db.query(WIDE_NUMERICS)).rows
  const all = (await db.query(ALL_COLUMNS)).rows
  return {
    wideNumericsChecked: wide.length,
    badWidth: wide.filter((r) => !/(_wei|_tok)$/.test(r.column_name)),
    forbidden: all.filter((r) => FORBIDDEN.test(r.column_name)),
    unsuffixed: all.filter((r) => !MONEYISH.test(r.column_name) && !EXEMPT.has(r.column_name)),
  }
}

describe('adlandirma kapisi', () => {
  beforeAll(resetSchema)

  it('her numeric(78,0) kolonu _wei veya _tok ile biter', async () => {
    const g = await gateViolations(pool)
    // Bos kumeyi gecmesini onler -- ve sayiyi da sabitler, cunku "hepsi
    // gecti" ifadesi sifir sutun uzerinde de dogrudur.
    expect(g.wideNumericsChecked).toBeGreaterThan(0)
    expect(g.wideNumericsChecked).toBe(27)
    expect(g.badWidth).toEqual([])
  })

  it('hicbir kolon 6 decimal gorunumu ima etmez', async () => {
    const g = await gateViolations(pool)
    expect(g.forbidden).toEqual([])
  })

  it('her kolon tanimli bir sonek tasir', async () => {
    const g = await gateViolations(pool)
    // Muafiyet listesi ACIKTIR: yeni bir sonekisiz kolon eklemek bu testi
    // kirar ve ekleyeni ya sonek koymaya ya listeyi buyutmeye ZORLAR. Sessiz
    // bir `amount` kolonu imkansiz.
    expect(g.unsuffixed).toEqual([])
  })

  it('muafiyet listesinde OLU giris yoktur', async () => {
    // Bir muafiyet, korudugu sutun silindikten sonra listede kalirsa, listeye
    // bakan biri o adin hala mesru oldugunu sanir. Liste semayla birlikte
    // yasar.
    const { rows } = await pool.query<Col>(ALL_COLUMNS)
    const live = new Set(rows.map((r) => r.column_name))
    const dead = [...EXEMPT].filter((name) => !live.has(name))
    expect(dead).toEqual([])
  })

  // ---------------------------------------------------------------
  // KAPININ DISLERI VAR MI? Yukaridaki uc test BOS bir kapiyla da yesildir.
  // Burada gercekten yasaklanmis bir sutun eklenir, AYNI kapi kodu
  // calistirilir, ve kapinin kirildigi GOSTERILIR. Sonra geri alinir.
  //
  // Planin teslim kriteri tam olarak buydu: "`amount_uusdc` eklenince
  // adlandirma kapisi iki testte kirilir". Iddia edilmiyor, calistiriliyor.
  // ---------------------------------------------------------------
  it('NEGATIF KONTROL: amount_uusdc eklenince kapi IKI testte birden kirilir', async () => {
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE trades ADD COLUMN amount_uusdc numeric(78,0)')

      const g = await gateViolations(client)
      // 1. numeric(78,0) kapisi: _wei/_tok ile bitmiyor.
      expect(g.badWidth).toEqual([{ table_name: 'trades', column_name: 'amount_uusdc' }])
      // 2. 6-decimal kapisi: yasak sonek.
      expect(g.forbidden).toEqual([{ table_name: 'trades', column_name: 'amount_uusdc' }])
      // Sonek kapisi bunu YAKALAMAZ (`_usdc` MONEYISH degil ama EXEMPT de
      // degil) -- yani aslinda UC testte birden kirilir.
      expect(g.unsuffixed).toEqual([{ table_name: 'trades', column_name: 'amount_uusdc' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    // Geri alma gercekten oldu mu?
    const after = await gateViolations(pool)
    expect(after.badWidth).toEqual([])
    expect(after.forbidden).toEqual([])
    expect(after.unsuffixed).toEqual([])
  })

  it('NEGATIF KONTROL: sonekisiz duz bir `amount` sutunu da gecemez', async () => {
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE trades ADD COLUMN amount numeric(78,0)')
      const g = await gateViolations(client)
      expect(g.unsuffixed).toEqual([{ table_name: 'trades', column_name: 'amount' }])
      expect(g.badWidth).toEqual([{ table_name: 'trades', column_name: 'amount' }])
      // `amount` yasak SONEK tasimaz, yani bu kapi onu gormez -- ucunun de
      // ayri isleri oldugunu gosteren nokta budur.
      expect(g.forbidden).toEqual([])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('NEGATIF KONTROL: dar bir numeric sutunu genis-numeric kapisindan KACAR', async () => {
    // Kapinin BILINEN sinirini kayda geciriyor: `numeric(20,6)` bir
    // numeric(78,0) DEGILDIR, yani birinci test onu gormez. Ucuncu test
    // (sonek) gorur. Bu bosluk bilerek burada duruyor ki biri "genis-numeric
    // kapisi butun tutarlari kapsiyor" sanmasin.
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE trades ADD COLUMN sneaky numeric(20,6)')
      const g = await gateViolations(client)
      expect(g.badWidth).toEqual([])
      expect(g.unsuffixed).toEqual([{ table_name: 'trades', column_name: 'sneaky' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
