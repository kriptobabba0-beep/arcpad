import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getDeployment, putDeployment } from '../src/deployment'
import { snapshot } from '../src/snapshot'
import { createPool, withTransaction } from '../src/pool'
import { MAX_SEQ } from '../src/seq'
import { pool, resetSchema } from './setup'
import { DEPLOYMENT } from './fixtures'

/**
 * BU DOSYA, BUTUN OTEKI IDDIALARIN UZERINDE DURDUGU AMA HICBIR YERDE
 * YAZILMAMIS OLAN VARSAYIMI YAZIYA DOKUYOR.
 *
 * node-postgres `bigint` (OID 20) ve `numeric` (OID 1700) degerlerini
 * varsayilan olarak STRING dondurur. Biri global bir `pg.types.setTypeParser`
 * kaydederse ikisi de JS `number` olur ve 2^53'un ustunde SESSIZCE hassasiyet
 * kaybeder. O anda:
 *   - `total_supply_tok = 1e27` yanlis okunur,
 *   - `snapshot()` esitligi iki FARKLI veritabanini ayni gosterebilir,
 *     yani butun idempotency testleri yanlis sebeple YESIL olur.
 * Bu, "yazilmamis bir gerekce yuzunden gecen test"in tam tanimi; burada
 * gerekce yaziya dokuluyor ve calistirilarak sabitleniyor.
 */
describe('sayisal hassasiyet -- yazilmamis varsayim burada yaziliyor', () => {
  beforeAll(resetSchema)

  it('bigint STRING gelir ve 2^53 ustunde tam kalir', async () => {
    const { rows } = await pool.query<{ v: unknown }>('SELECT $1::bigint AS v', [
      MAX_SEQ.toString(),
    ])
    expect(typeof rows[0]?.v).toBe('string')
    expect(rows[0]?.v).toBe('9223372036854775807')
    // Number'a dusseydi bu esitlik BOZULURDU -- kaybin gercek oldugunu
    // gostermek icin:
    expect(String(Number('9223372036854775807'))).not.toBe('9223372036854775807')
  })

  it('numeric(78,0) STRING gelir ve 1e27 tam kalir', async () => {
    const supply = (10n ** 27n).toString()
    const { rows } = await pool.query<{ v: unknown }>('SELECT $1::numeric(78,0) AS v', [supply])
    expect(typeof rows[0]?.v).toBe('string')
    expect(rows[0]?.v).toBe(supply)
  })

  it('78 hanenin TAMAMI korunur (kolon genisliginin ucu)', async () => {
    const huge = '9'.repeat(78)
    const { rows } = await pool.query<{ v: string }>('SELECT $1::numeric(78,0) AS v', [huge])
    expect(rows[0]?.v).toBe(huge)
    expect(BigInt(rows[0]!.v).toString()).toBe(huge)
  })
})

describe('deployment', () => {
  // HER TESTTEN once, cunku `putDeployment` ON CONFLICT DO NOTHING'dir: bir
  // onceki testin biraktigi satir bir sonrakinin yazimini sessizce yutar.
  // (Ilk kosuda tam olarak bu oldu ve son test kirmizi geldi.)
  beforeEach(resetSchema)

  it('yazilan dagitim BIT BIT geri okunur', async () => {
    expect(await getDeployment(pool)).toBeNull()
    await putDeployment(pool, DEPLOYMENT)
    expect(await getDeployment(pool)).toEqual(DEPLOYMENT)
  })

  it('ikinci bir yazim NO-OP tur, eskisini korur', async () => {
    await putDeployment(pool, DEPLOYMENT)
    const before = await snapshot(pool)
    await putDeployment(pool, { ...DEPLOYMENT, chainId: 999n, startBlock: 1n })
    expect(await snapshot(pool)).toEqual(before)
    expect((await getDeployment(pool))?.chainId).toBe(DEPLOYMENT.chainId)
  })

  it('checksum li adresler kucuk harfe indirilerek yazilir', async () => {
    await putDeployment(pool, {
      ...DEPLOYMENT,
      factory: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
    })
    expect((await getDeployment(pool))?.factory).toBe('0xabcdef0123456789abcdef0123456789abcdef01')
  })
})

describe('snapshot', () => {
  beforeAll(resetSchema)

  it('katalogdan turer -- her tabloyu kapsar, elle yazilmis liste yok', async () => {
    const snap = await snapshot(pool)
    expect(Object.keys(snap).sort()).toEqual([
      'buyback_events',
      'buyback_state',
      'chat_messages',
      'creator_history',
      'curve_state',
      'deployment',
      'fee_balances',
      'fee_events',
      'holders',
      'launches',
      'rejected_launches',
      'schema_migrations',
      'schema_state',
      'sync_state',
      'token_stats',
      'token_transfers',
      'trades',
    ])
  })

  it('birincil anahtari olmayan bir tabloda GURULTULU patlar', async () => {
    await withTransaction(pool, async (tx) => {
      await tx.query('CREATE TABLE no_pk (x int)')
      await expect(snapshot(tx)).rejects.toThrow(/no_pk/)
      // Islemi geri al.
      throw new Error('rollback')
    }).catch((error: unknown) => {
      expect((error as Error).message).toBe('rollback')
    })
  })
})

/**
 * ==========================================================================
 *  BOSTAKI BIR ISTEMCININ HATASI SURECI OLDURMEZ.
 * ==========================================================================
 *
 * `pg`de bir istemci BOSTAYKEN hata alirsa `Pool` bir `'error'` olayi yayar.
 * Node'da dinleyicisi olmayan bir `'error'` olayi YAKALANMAMIS ISTISNADIR --
 * surec aninda olur, ve hicbir `try/catch` bunu goremez cunku hata bir
 * cagrinin icinden degil, ISLEM YOKKEN gelir.
 *
 * URETIMDE OLCULDU (2026-08-11 06:35 UTC): Postgres'in rutin bir yeniden
 * baslatmasi butun baglantilari kopardi ("terminating connection due to
 * administrator command") ve indexer BES KEZ cokup yeniden basladi. Bir
 * veritabani yeniden baslatmasi rutin bir olaydir; uygulamanin ona olumle
 * cevap vermesi bir arizadir.
 *
 * Test olayi ELLE yayar: gercek bir Postgres yeniden baslatmasini bir birim
 * testinde uretmek mumkun degil, ama yayilan olay AYNI olaydir ve olduren
 * sey de tam olarak oydu.
 */
describe('createPool -- bostaki istemci hatasi', () => {
  it('havuz `error` olayini DINLER, yani yayilmasi sureci oldurmez', async () => {
    const url = process.env['DATABASE_URL']
    if (url === undefined) throw new Error('unreachable: setup asserts this')
    const p = createPool(url)
    try {
      // Dinleyici VAR MI: `pg` bir tane bagladiysa sayi sifirdan buyuktur.
      // Sifir olsaydi asagidaki `emit` sureci oldururdu.
      expect(p.listenerCount('error')).toBeGreaterThan(0)

      // Ve gercekten yayilinca FIRLATMAZ. Dinleyici olmasaydi bu satir
      // testi degil SURECI dusururdu.
      expect(() =>
        p.emit('error', new Error('terminating connection due to administrator command')),
      ).not.toThrow()

      // Havuz hala kullanilabilir: bozuk istemci atilir, yenisi acilir.
      const { rows } = await p.query<{ ok: number }>('SELECT 1 AS ok')
      expect(rows[0]?.ok).toBe(1)
    } finally {
      await p.end()
    }
  })
})
