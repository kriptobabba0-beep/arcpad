import { beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from '../src/pool'
import { pool, resetSchema } from './setup'

/**
 * ADLANDIRMA KAPISI.
 *
 * Arc'in native varligi USDC'dir ve IKI GORUNUMU vardir: 18 decimal native ve
 * 0x3600000000000000000000000000000000000000 adresindeki 6 decimal ERC-20
 * (canli testnette dogrulandi: symbol USDC, decimals 6, chainId 5042002).
 * Ikisi AYNI bakiyenin iki gorunumudur ve ASLA toplanmaz. Bir sutunun hangi
 * gorunumu tasidigi ADINDAN anlasilmazsa, yanlis gorunumu yazmak sessiz kalir
 * ve hicbir CHECK onu yakalayamaz -- 1e12'lik bir carpan hatasi tamamen
 * gecerli bir sayidir.
 *
 * ------------------------------------------------------------------
 * KAPININ ERISIMI OLCULDU, VARSAYILMADI -- ve ilk hali DARDI.
 *
 * Onceki kapi YALNIZCA `numeric(78,0)` sutunlarina bakiyordu. Gozden geciren
 * gercek kapi kodunu bir probe migration'iyla calistirdi ve UCU DE gecti:
 *   ALTER TABLE trades ADD COLUMN price_wei    numeric(78,6);  -- scale 6
 *   ALTER TABLE trades ADD COLUMN quote_number numeric;        -- precision NULL
 *   ALTER TABLE trades ADD COLUMN fill_count   bigint;         -- tipe bakilmiyor
 * `7 passed (7)`.
 *
 * Bu tam olarak kapinin tasiyici oldugu yere dusuyor: **6 decimal bir USDC
 * tutari en dogal olarak `bigint`tir** (100 USDC = 1e8, rahat sigar), 18
 * decimal gorunum ise 1e20'dir ve `bigint`i tasirir. Yani kapinin ayirmak icin
 * var oldugu gorunum, tam da kapinin hic bakmadigi tipte yasiyor.
 *
 * Istenen ozellik "her numeric(78,0) iyi adlandirilmis" DEGIL, **"hicbir sutun
 * gorunumunu bildirmeden bir USDC miktari tasiyamaz"**. Yeni kural:
 *   - her `numeric` TAM OLARAK numeric(78,0) olmali VE `_wei`/`_tok` ile bitmeli;
 *   - her tamsayi sutunu `_wei`/`_tok` ile BITMEMELI ve bildirilmis bir
 *     para-disi sonek tasimali;
 *   - `real`/`double precision`/`money` tamamen yasak;
 *   - ve TIP BOLUNTUSUNUN KENDISI katalogla karsilastirilir, boylece sonradan
 *     eklenen bir tip boluntunun disina SESSIZCE kacamaz.
 *
 * `fill_count bigint` BILEREK GECER: o bir sayacdir, bildirilmis `_count`
 * sonegini tasir, ve onu reddetmek semadaki her sayaci numeric(78,0)'a iterdi
 * -- guvenlik kazanci olmadan daha kotu bir sema. Yani gozden gecirenin uc
 * probe'undan IKISI kusur, ucuncusu degil.
 * ------------------------------------------------------------------
 */

/** Bildirilmis sonekler. Hicbiri para gorunumu BILDIRMEZ; para `_wei`/`_tok`tur. */
const NON_MONEY_SUFFIX =
  /(_ppm|_bps|_seq|_at|_time|_count|_id|_block|_number|_index|_hash|_hex|_addr)$/
const MONEY_SUFFIX = /(_wei|_tok)$/
const FORBIDDEN = /(_usdc|_uusdc|_micro|_e6)$/

/**
 * TIP BOLUNTUSU -- `information_schema.columns.data_type` degerleri.
 * Semada gecen her tip bu dort kumeden BIRINDE olmak ZORUNDA; degilse
 * `unclassified` dolar ve kapi kirilir.
 */
const NUMERIC_TYPES = new Set(['numeric', 'decimal'])
const INTEGER_TYPES = new Set(['smallint', 'integer', 'bigint'])
/** Para icin kayan nokta HER ZAMAN yanlistir; `money` ise locale'e bagimlidir. */
const BANNED_TYPES = new Set(['real', 'double precision', 'money'])
const NON_AMOUNT_TYPES = new Set([
  'text',
  'character varying',
  'character',
  'boolean',
  'timestamp with time zone',
  'timestamp without time zone',
  'date',
  'jsonb',
  'json',
  'bytea',
  'uuid',
])

const EXEMPT = new Set([
  'token',
  'curve',
  'trader',
  'holder',
  'recipient',
  'creator',
  'launch_creator',
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
  'source',
  'complete',
  'is_buy',
  'filename',
  // Tekil satirli tablolarin (`deployment`, `sync_state`) sabit birincil
  // anahtari. Bir tutar DEGILDIR ve olamaz: `CHECK (id = 1)`.
  'id',
])

interface Col {
  table_schema: string
  table_name: string
  relkind: string
  column_name: string
  data_type: string
  numeric_precision: number | null
  numeric_scale: number | null
}

type Ref = { table_name: string; column_name: string }

/**
 * Sutun tasiyan relkind'lar ve kapinin onlara ne yaptigi. Kume KATALOGLA
 * karsilastirilir: siniflandirilmamis bir relkind (ornegin bir MATVIEW ilk
 * kez eklendiginde) testi kirar ve ekleyeni karar vermeye zorlar.
 */
const EXAMINED_RELKINDS = new Set([
  'r', // ordinary table
  'p', // partitioned table
  'v', // view
  'm', // materialized view
  'f', // foreign table
])
/** Sutunu olan ama urun verisi TASIMAYAN relkind'lar. */
const IGNORED_RELKINDS = new Set([
  'c', // composite type
])

/**
 * SAYIMIN ERISIMI DE OLCULUR.
 *
 * Onceki hali `information_schema.columns WHERE table_schema='public'` idi ve
 * ERISIMI HIC OLCULMEMISTI -- yani I-1'in kapattigi ariza kipinin bir ust
 * kattaki hali. Iki tam kacis olculdu:
 *
 *   - `public` icindeki bir MATERIALIZED VIEW `examined`i SIFIR kadar
 *     oynatiyordu: information_schema matview'lari hic listelemez. Ve bu
 *     teorik degil: `volume_24h_wei` PENCERELI oldugu icin Task 11'e
 *     birakildi, ve onu bir matview olarak kurmak en bariz cozum.
 *   - `public` DISINDA bir semadaki tablo sifir bulgu uretiyordu -- `double
 *     precision` icin `banned` bile.
 *
 * Bu yuzden sayim `pg_class`/`pg_attribute`'tan gelir, SISTEM DISI HER
 * SEMADAN ve kullanici sutunu tasiyan HER relkind'dan. Ustelik relkind
 * kumesinin kendisi de -- tip boluntusu gibi -- iddia edilir.
 */
const ALL_COLUMNS = `
  SELECT n.nspname AS table_schema,
         c.relname AS table_name,
         c.relkind::text AS relkind,
         a.attname AS column_name,
         format_type(COALESCE(bt.oid, t.oid), NULL) AS data_type,
         CASE WHEN COALESCE(bt.typname, t.typname) = 'numeric' AND a.atttypmod <> -1
              THEN ((a.atttypmod - 4) >> 16) & 65535 END AS numeric_precision,
         CASE WHEN COALESCE(bt.typname, t.typname) = 'numeric' AND a.atttypmod <> -1
              THEN (a.atttypmod - 4) & 65535 END AS numeric_scale
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND c.relkind = ANY ('{r,p,v,m,f}')
  ORDER BY 1, 2, 4`

/** Kullanici sutunu tasiyan ve dolayisiyla kapinin bakmasi gereken relkind'lar. */
const DATA_RELKINDS = `
  SELECT DISTINCT c.relkind::text AS relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND c.relkind NOT IN ('i', 'I', 'S', 't')
  ORDER BY 1`

/** Sistem disi semalar. */
const SCHEMAS = `
  SELECT nspname AS name FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema')
    AND nspname NOT LIKE 'pg\\_%'
  ORDER BY 1`

const ref = (r: Col): Ref => ({ table_name: r.table_name, column_name: r.column_name })

interface Report {
  examined: number
  numerics: number
  integers: number
  /** Sistem disi semalar. `['public']` disina cikmasi bir bulgudur. */
  schemas: string[]
  /** Kataloga gore sutun tasiyan relkind'lardan siniflandirilmamis olanlar. */
  unclassifiedRelkinds: string[]
  /** Sayimin gercekten gordugu (sema, relkind) ciftleri -- erisimin kendisi. */
  reach: string[]
  /** Semada gecip de boluntude yeri olmayan tipler. */
  unclassified: string[]
  /** Kayan nokta / `money` tipli sutunlar. */
  banned: Ref[]
  /** `numeric` olup tam numeric(78,0) olmayan VEYA `_wei`/`_tok` ile bitmeyen. */
  badNumeric: Ref[]
  /** Tamsayi tipinde olup para adi tasiyan. */
  moneyNamedInteger: Ref[]
  /** Tamsayi tipinde olup bildirilmis bir para-disi sonek tasimayan. */
  undeclaredInteger: Ref[]
  /** 6 decimal gorunumu ima eden ad. */
  forbidden: Ref[]
  /** Tipten bagimsiz: hicbir bildirilmis sonek tasimayan ve muaf olmayan. */
  unsuffixed: Ref[]
}

/**
 * KAPININ KENDISI, tek bir yerde. Hem gercek semaya hem de asagidaki NEGATIF
 * KONTROLLERE AYNI kod uygulanir -- iki ayri kopya olsaydi, negatif kontrolun
 * gecmesi gercek kapinin calistigini gostermezdi.
 */
async function gate(db: {
  query: (t: string) => Promise<{ rows: Record<string, string>[] }>
}): Promise<Report> {
  const all = (await db.query(ALL_COLUMNS)).rows as unknown as Col[]
  const relkinds = (await db.query(DATA_RELKINDS)).rows.map((r) => r['relkind'] as string)
  const schemas = (await db.query(SCHEMAS)).rows.map((r) => r['name'] as string)
  const numerics = all.filter((r) => NUMERIC_TYPES.has(r.data_type))
  const integers = all.filter((r) => INTEGER_TYPES.has(r.data_type))

  const classified = (t: string) =>
    NUMERIC_TYPES.has(t) || INTEGER_TYPES.has(t) || BANNED_TYPES.has(t) || NON_AMOUNT_TYPES.has(t)

  return {
    examined: all.length,
    numerics: numerics.length,
    integers: integers.length,
    schemas,
    unclassifiedRelkinds: relkinds
      .filter((k) => !EXAMINED_RELKINDS.has(k) && !IGNORED_RELKINDS.has(k))
      .sort(),
    reach: [...new Set(all.map((r) => `${r.table_schema}:${r.relkind}`))].sort(),
    unclassified: [...new Set(all.map((r) => r.data_type))].filter((t) => !classified(t)).sort(),
    banned: all.filter((r) => BANNED_TYPES.has(r.data_type)).map(ref),
    badNumeric: numerics
      .filter(
        (r) =>
          r.numeric_precision !== 78 || r.numeric_scale !== 0 || !MONEY_SUFFIX.test(r.column_name),
      )
      .map(ref),
    moneyNamedInteger: integers.filter((r) => MONEY_SUFFIX.test(r.column_name)).map(ref),
    undeclaredInteger: integers
      .filter((r) => !NON_MONEY_SUFFIX.test(r.column_name) && !EXEMPT.has(r.column_name))
      .map(ref),
    forbidden: all.filter((r) => FORBIDDEN.test(r.column_name)).map(ref),
    unsuffixed: all
      .filter(
        (r) =>
          !MONEY_SUFFIX.test(r.column_name) &&
          !NON_MONEY_SUFFIX.test(r.column_name) &&
          !EXEMPT.has(r.column_name),
      )
      .map(ref),
  }
}

/** Gecici bir sutunla kapiyi calistirir ve HER ZAMAN geri alir. */
async function withColumn(ddl: string, check: (r: Report) => void): Promise<void> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(ddl)
    check(await gate(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

describe('adlandirma kapisi', () => {
  beforeAll(resetSchema)

  it('tip boluntusu semanin TAMAMINI kapsar', async () => {
    // Asagidaki butun kurallar "su tipteki sutunlar" diye baslar; hicbiri
    // boluntunun disinda kalan bir tipi goremez. Bu yuzden boluntunun kendisi
    // katalogla karsilastiriliyor.
    const g = await gate(pool)
    expect(g.unclassified).toEqual([])
  })

  // ---------------------------------------------------------------
  // SAYIMIN ERISIMI. Tip boluntusu dogru olsa bile, sayim bir iliskiyi hic
  // GORMUYORSA kural o iliskiye uygulanmaz. Onceki sayim iki seyi tamamen
  // kaciriyordu (olculdu): `public` icindeki matview'lar ve `public` disindaki
  // semalar. Asagidaki uc test erisimi OLCER.
  // ---------------------------------------------------------------

  it('SAYIM: incelenen sutun sayisi TAM olarak sabitlenir', async () => {
    // `> 0` yeterli DEGIL: sayim daralirsa (bir iliski tipi gorunmez olursa)
    // butun kurallar sessizce daha az sutuna uygulanir ve suite yesil kalir.
    const g = await gate(pool)
    expect(g.examined).toBe(112)
  })

  it('SAYIM: sistem disi tek sema `public`tir', async () => {
    // Kapsam iddiasi: baska bir semada tablo YOK. Olsaydi asagidaki erisim
    // testi onu gorurdu; bu test ise "bakmamiz gereken tek yer burasi"
    // ifadesini sabitler.
    expect((await gate(pool)).schemas).toEqual(['public'])
  })

  it('SAYIM: sutun tasiyan her relkind ya incelenir ya da acikca yok sayilir', async () => {
    // MATVIEW'LAR ICIN ONEMLI: `volume_24h_wei` PENCERELI oldugu icin Task
    // 11'e birakildi ve onu bir matview olarak kurmak en bariz cozum. Sayim
    // `pg_class`'tan geldigi icin boyle bir matview GORULUR; relkind kumesi de
    // burada sabitlenir ki yeni bir iliski tipi sessizce disarida kalmasin.
    const g = await gate(pool)
    expect(g.unclassifiedRelkinds).toEqual([])
    // Bugun semada yalnizca sirali tablolar var.
    expect(g.reach).toEqual(['public:r'])
  })

  it('her numeric TAM OLARAK numeric(78,0) ve _wei/_tok ile biter', async () => {
    const g = await gate(pool)
    // Bos kumeyi gecmesini onler -- "hepsi gecti" sifir sutun uzerinde de
    // dogrudur.
    expect(g.numerics).toBe(27)
    expect(g.badNumeric).toEqual([])
  })

  it('hicbir tamsayi sutunu para adi tasimaz', async () => {
    // Bir tutari `bigint`e koymak, 6 decimal gorunumu secmek demektir. Adi
    // `_wei`/`_tok` yapmak o secimi GIZLERDI; kural, parayi numeric(78,0)'a
    // mecbur birakir.
    const g = await gate(pool)
    expect(g.integers).toBeGreaterThan(0)
    expect(g.moneyNamedInteger).toEqual([])
  })

  it('her tamsayi sutunu bildirilmis bir para-disi sonek tasir', async () => {
    expect((await gate(pool)).undeclaredInteger).toEqual([])
  })

  it('kayan nokta ve money tipi semada hic yok', async () => {
    expect((await gate(pool)).banned).toEqual([])
  })

  it('hicbir kolon 6 decimal gorunumu ima etmez', async () => {
    expect((await gate(pool)).forbidden).toEqual([])
  })

  it('her kolon tanimli bir sonek tasir', async () => {
    // Muafiyet listesi ACIKTIR: yeni bir sonekisiz kolon eklemek bu testi
    // kirar ve ekleyeni ya sonek koymaya ya listeyi buyutmeye ZORLAR. Sessiz
    // bir `amount` kolonu imkansiz.
    expect((await gate(pool)).unsuffixed).toEqual([])
  })

  it('muafiyet listesinde OLU giris yoktur', async () => {
    // Bir muafiyet, korudugu sutun silindikten sonra listede kalirsa, listeye
    // bakan biri o adin hala mesru oldugunu sanir. Liste semayla birlikte
    // yasar.
    const { rows } = await pool.query<Col>(ALL_COLUMNS)
    const live = new Set(rows.map((r) => r.column_name))
    expect([...EXEMPT].filter((n) => !live.has(n))).toEqual([])
  })

  // ---------------------------------------------------------------
  // NEGATIF KONTROLLER -- TIP BASINA BIR TANE.
  //
  // Kural basina degil TIP basina, cunku kapinin kacirdigi sey bir kural
  // degil bir TIPTI. Her biri gecici bir sutun ekler, AYNI kapi kodunu
  // calistirir, kirildigini gosterir ve geri alir.
  // ---------------------------------------------------------------

  it("numeric(78,6): olcek yanlissa yakalanir (gozden gecirenin 1. probe'u)", async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN price_wei numeric(78,6)', (g) => {
      expect(g.badNumeric).toEqual([{ table_name: 'trades', column_name: 'price_wei' }])
      // Sonek kapisi bunu GORMEZ -- `_wei` bildirilmis bir sonektir. Yakalayan
      // sey tip+olcek kurali; ikisinin AYRI isleri oldugu boyle gorulur.
      expect(g.unsuffixed).toEqual([])
    })
  })

  it("ciplak numeric: precision NULL da kacamaz (gozden gecirenin 2. probe'u)", async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN quote_number numeric', (g) => {
      expect(g.badNumeric).toEqual([{ table_name: 'trades', column_name: 'quote_number' }])
    })
  })

  it('bigint: sonekisiz bir tutar yakalanir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN amount bigint', (g) => {
      expect(g.undeclaredInteger).toEqual([{ table_name: 'trades', column_name: 'amount' }])
      expect(g.unsuffixed).toEqual([{ table_name: 'trades', column_name: 'amount' }])
    })
  })

  it('bigint: para ADLI bir tamsayi yakalanir (6 decimal gorunumun dogal evi)', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN fee_wei bigint', (g) => {
      expect(g.moneyNamedInteger).toEqual([{ table_name: 'trades', column_name: 'fee_wei' }])
      // ESKI KAPININ IKI TESTI DE BUNU KACIRIRDI: numeric degil, ve `_wei`
      // bildirilmis bir sonek. Gozden gecirmenin isaret ettigi delik buydu.
      expect(g.badNumeric).toEqual([])
      expect(g.unsuffixed).toEqual([])
    })
  })

  it('integer ve smallint de ayni kurala tabidir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN fee_tok integer', (g) => {
      expect(g.moneyNamedInteger).toEqual([{ table_name: 'trades', column_name: 'fee_tok' }])
    })
    await withColumn('ALTER TABLE trades ADD COLUMN dust_tok smallint', (g) => {
      expect(g.moneyNamedInteger).toEqual([{ table_name: 'trades', column_name: 'dust_tok' }])
    })
  })

  it('double precision ve real yasaktir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN price_wei double precision', (g) => {
      expect(g.banned).toEqual([{ table_name: 'trades', column_name: 'price_wei' }])
    })
    await withColumn('ALTER TABLE trades ADD COLUMN rate_ppm real', (g) => {
      expect(g.banned).toEqual([{ table_name: 'trades', column_name: 'rate_ppm' }])
      // Adi kusursuz; yakalayan sey YALNIZCA tip.
      expect(g.unsuffixed).toEqual([])
    })
  })

  it('money tipi yasaktir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN fee_wei money', (g) => {
      expect(g.banned).toEqual([{ table_name: 'trades', column_name: 'fee_wei' }])
    })
  })

  it('BOLUNTUNUN DISINDAKI bir tip sessizce kacamaz', async () => {
    // Kapinin erisimini "olculmus" yapan sey budur. `interval` ve `inet` ne
    // sayisal ne de metinsel kumede; boluntu testi onlari YAKALAR ve ekleyeni
    // ya siniflandirmaya ya reddetmeye zorlar.
    await withColumn('ALTER TABLE trades ADD COLUMN nap interval', (g) => {
      expect(g.unclassified).toEqual(['interval'])
    })
    await withColumn('ALTER TABLE trades ADD COLUMN net inet', (g) => {
      expect(g.unclassified).toEqual(['inet'])
    })
  })

  // ---------------------------------------------------------------
  // ERISIM KACISLARI -- gozden gecirmenin olctugu iki tam kacis.
  // ---------------------------------------------------------------

  it('KACIS: `public` icindeki bir MATERIALIZED VIEW artik gorulur', async () => {
    // Olculen eski davranis: matview `examined`i SIFIR kadar oynatiyordu,
    // cunku information_schema matview'lari hic listelemez.
    const before = await gate(pool)
    await withColumn(
      `CREATE MATERIALIZED VIEW mv_window AS
         SELECT token, sum(quote_amount_wei)::numeric(78,6) AS price_wei,
                count(*)::bigint AS amount
         FROM trades GROUP BY token`,
      (g) => {
        // Sayim GERCEKTEN buyudu.
        expect(g.examined).toBe(before.examined + 3)
        expect(g.reach).toEqual(['public:m', 'public:r'])
        // Ve kurallar matview'a da uygulaniyor.
        expect(g.badNumeric).toEqual([{ table_name: 'mv_window', column_name: 'price_wei' }])
        expect(g.undeclaredInteger).toEqual([{ table_name: 'mv_window', column_name: 'amount' }])
      },
    )
    expect((await gate(pool)).examined).toBe(before.examined)
  })

  it('KACIS: baska bir SEMADAKI tablo artik gorulur', async () => {
    // Olculen eski davranis: `public` disindaki bir tablo sifir bulgu
    // uretiyordu -- `double precision` icin `banned` bile.
    const before = await gate(pool)
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE SCHEMA reporting')
      await client.query('CREATE TABLE reporting.rollup (price double precision, amount bigint)')
      const g = await gate(client)
      expect(g.examined).toBe(before.examined + 2)
      expect(g.schemas).toEqual(['public', 'reporting'])
      expect(g.reach).toEqual(['public:r', 'reporting:r'])
      expect(g.banned).toEqual([{ table_name: 'rollup', column_name: 'price' }])
      expect(g.undeclaredInteger).toEqual([{ table_name: 'rollup', column_name: 'amount' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect((await gate(pool)).schemas).toEqual(['public'])
  })

  it('KACIS: bir VIEW de kurallara tabidir', async () => {
    const before = await gate(pool)
    await withColumn(
      `CREATE VIEW v_leak AS SELECT event_seq, quote_amount_wei AS fee_usdc FROM trades`,
      (g) => {
        expect(g.examined).toBe(before.examined + 2)
        expect(g.forbidden).toEqual([{ table_name: 'v_leak', column_name: 'fee_usdc' }])
      },
    )
  })

  it('POZITIF KONTROL: fill_count bigint GECER (kapi fazla siki degil)', async () => {
    // Gozden gecirenin ucuncu probe'u. Bu bir KUSUR DEGILDIR ve reddetmek
    // semadaki her sayaci numeric(78,0)'a iterdi. Kapinin buradan gecmesi,
    // yukaridaki sertlestirmelerin fazla genis OLMADIGININ kanitidir.
    await withColumn('ALTER TABLE trades ADD COLUMN fill_count bigint', (g) => {
      expect(g.badNumeric).toEqual([])
      expect(g.moneyNamedInteger).toEqual([])
      expect(g.undeclaredInteger).toEqual([])
      expect(g.unsuffixed).toEqual([])
      expect(g.banned).toEqual([])
      expect(g.unclassified).toEqual([])
    })
  })

  it('NEGATIF KONTROL: amount_uusdc eklenince kapi UC testte birden kirilir', async () => {
    // Planin teslim kriteri: "`amount_uusdc` eklenince adlandirma kapisi iki
    // testte kirilir". Iddia edilmiyor, calistiriliyor -- ve aslinda uc.
    await withColumn('ALTER TABLE trades ADD COLUMN amount_uusdc numeric(78,0)', (g) => {
      const one = [{ table_name: 'trades', column_name: 'amount_uusdc' }]
      expect(g.badNumeric).toEqual(one)
      expect(g.forbidden).toEqual(one)
      expect(g.unsuffixed).toEqual(one)
    })
  })

  it('geri alma gercekten oldu: sema tertemiz', async () => {
    const g = await gate(pool)
    expect(g.unclassified).toEqual([])
    expect(g.banned).toEqual([])
    expect(g.badNumeric).toEqual([])
    expect(g.moneyNamedInteger).toEqual([])
    expect(g.undeclaredInteger).toEqual([])
    expect(g.forbidden).toEqual([])
    expect(g.unsuffixed).toEqual([])
  })
})
