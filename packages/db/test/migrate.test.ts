import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MIGRATIONS_DIR,
  migrationFiles,
  readInventory,
  runMigrations,
  schemaInventory,
} from '../src/migrate'
import { snapshot } from '../src/snapshot'
import { dropSchema, pool } from './setup'

const EXPECTED = [
  '001_deployment_and_cursor.sql',
  '002_launches.sql',
  '003_trades_and_curve_state.sql',
  '004_transfers_and_holders.sql',
  '005_fees.sql',
  '006_token_stats.sql',
]

describe('runMigrations', () => {
  beforeEach(dropSchema)

  it('diskteki migration listesi tam olarak beklenen alti dosyadir', async () => {
    // Sirali ve TAM. Bir testin gecici olarak yazdigi bozuk dosya temizlenmemis
    // olsaydi burasi kirmizi olurdu -- yani sizinti sessiz kalamaz.
    await expect(migrationFiles()).resolves.toEqual(EXPECTED)
  })

  it('iki kez kosturmak ikinci kez hicbir sey uygulamaz', async () => {
    const first = await runMigrations(pool)
    expect(first).toEqual(EXPECTED)
    expect(first).toHaveLength(6)

    const second = await runMigrations(pool)
    expect(second).toEqual([])
  })

  it('IDEMPOTENCY IDDIA DEGIL: ikinci kosu semayi HIC degistirmez', async () => {
    // "Bos dizi dondu" yalnizca defterin bos oldugunu soyler. Asil iddia
    // semanin AYNI kalmasidir, ve o ancak katalogun kendisi karsilastirilarak
    // gosterilebilir.
    await runMigrations(pool)
    const before = await catalog()
    const rowsBefore = await snapshot(pool)

    const second = await runMigrations(pool)
    expect(second).toEqual([])

    expect(await catalog()).toEqual(before)
    expect(await snapshot(pool)).toEqual(rowsBefore)
  })

  it('UCUNCU kosu da hicbir sey yapmaz (idempotency bir kereye mahsus degil)', async () => {
    await runMigrations(pool)
    await runMigrations(pool)
    const before = await catalog()
    await expect(runMigrations(pool)).resolves.toEqual([])
    expect(await catalog()).toEqual(before)
  })

  it('bir migration EKSIKSE hicbiri uygulanmaz (alti dosya geri alinir)', async () => {
    const files = await migrationFiles()
    await expect(runMigrations(pool, [...files, 'zzz_missing.sql'])).rejects.toThrow()

    // DEFTERIN KENDISI DE YOK. Defter artik islemin ICINDE olusuyor (bir sert
    // durus arkasinda tablo birakmasin diye), yani basarisiz bir ILK kosudan
    // geriye HICBIR SEY kalmaz -- "sifir satir"dan daha guclu bir ifade.
    await expect(pool.query('SELECT 1 FROM schema_migrations')).rejects.toThrow(/schema_migrations/)
    await expect(pool.query('SELECT 1 FROM launches')).rejects.toThrow(/launches/)
  })

  it('bir migration BOZUK SQL ise hicbiri uygulanmaz', async () => {
    // Eksik dosya bir DOSYA hatasidir; bu test asil ilgilendigimiz seyi, bir
    // SQL hatasinin geri almasini olcer. Ikisi ayni yerden gecer ama ayni sey
    // DEGILDIR ve yalnizca birini test etmek "bir giris noktasinda kapsanan
    // ozellik hepsinde kapsanmis gibi okunur" arizasidir.
    const broken = '007_broken.tmp.sql'
    await writeFile(join(MIGRATIONS_DIR, broken), 'CREATE TABLE bad (x nonexistent_type);\n')
    try {
      const files = await migrationFiles()
      expect(files).toContain(broken)
      await expect(runMigrations(pool, files)).rejects.toThrow(/nonexistent_type/)

      await expect(pool.query('SELECT 1 FROM schema_migrations')).rejects.toThrow(
        /schema_migrations/,
      )
      await expect(pool.query('SELECT 1 FROM launches')).rejects.toThrow(/launches/)
    } finally {
      await unlink(join(MIGRATIONS_DIR, broken))
    }
    // Sizinti yok.
    await expect(migrationFiles()).resolves.toEqual(EXPECTED)
  })

  it('kismen uygulanmis bir veritabaninda YALNIZCA eksikleri uygular', async () => {
    // Bos veritabani ile tam veritabani arasindaki UCUNCU durum. Faz 0'in
    // devir listesi bu sinifi ("test secimindeki bosluk") ayrica isaretliyor.
    const files = await migrationFiles()
    const firstThree = files.slice(0, 3)
    await expect(runMigrations(pool, firstThree)).resolves.toEqual(firstThree)

    const rest = await runMigrations(pool)
    expect(rest).toEqual(files.slice(3))

    // Ve simdi hepsi orada.
    const { rows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    )
    expect(rows.map((r) => r.filename)).toEqual(EXPECTED)
  })

  // ---------------------------------------------------------------
  // UYGULANMIS BIR MIGRATION YERINDE DUZENLENIRSE.
  //
  // Bu proje 001-006'yi YERINDE duzenlemeyi secti (semanin uygulanmis bir
  // ornegi yok; ayni saatte yazilmis alti dosyayi yedinciyle yamalamak kalici
  // olarak daha kotu okunur). O secim ancak duzenleme GORULEBILIRSE guvenli:
  // aksi halde dosyayi bir kez uygulamis olan bir veritabani -- ornegin bir
  // gozden gecirenin kendi kumesi -- sonraki kosuda hicbir sey yapmadan yesil
  // doner ve semanin ESKI halini tasimaya devam eder.
  // ---------------------------------------------------------------
  it('uygulanan her dosyanin ozeti deftere yazilir', async () => {
    await runMigrations(pool)
    const { rows } = await pool.query<{ filename: string; checksum_hex: string | null }>(
      'SELECT filename, checksum_hex FROM schema_migrations ORDER BY filename',
    )
    expect(rows).toHaveLength(6)
    for (const r of rows) expect(r.checksum_hex).toMatch(/^[0-9a-f]{64}$/)
    // Ozetler DOSYAYA gore; iki farkli dosya ayni ozeti tasimaz.
    expect(new Set(rows.map((r) => r.checksum_hex)).size).toBe(6)
  })

  it('uygulanmis bir dosya DEGISTIYSE kosmayi reddeder', async () => {
    await runMigrations(pool)
    await pool.query('UPDATE schema_migrations SET checksum_hex = $2 WHERE filename = $1', [
      '002_launches.sql',
      'a'.repeat(64),
    ])
    await expect(runMigrations(pool)).rejects.toThrow(
      /002_launches\.sql: uygulandiktan SONRA degismis/,
    )
  })

  // ---------------------------------------------------------------
  // KARSILASTIRMA TAM MI? Ilk hali yalnizca "degismis" dosyayi ariyordu ve
  // uc kacis birakiyordu; ucu de gozden gecirmede olculdu. Hepsi burada.
  // ---------------------------------------------------------------

  it('OZETSIZ bir defter SERT DURUSTUR, benimseme DEGIL', async () => {
    // EN ONEMLISI. `6295651`in kurdugu HER veritabaninin defteri boyledir --
    // yani muhafizin gerekcesi olarak gosterilen durum tam da gecirdigi
    // durumdu. Olculen sonuc: `ok=true, result=[]`, uzerinde `last_block_hash`
    // yok, `name_hex` yok, sistem-adresi CHECK'leri yok, `raw jsonb` duruyor
    // -- ve bugunun ozetleri eski govdelerin uzerine yaziliyor, yani sapma bir
    // daha ASLA fark edilemiyor.
    //
    // BILINMEYEN DURUM SERT DURUSTUR: reddetmenin bedeli, uretimde hicbir
    // ornegi olmayan bir semada bir `dropdb`; benimsemenin bedeli, tespit
    // edilemeyen sessizce ayrik bir veritabani.
    await runMigrations(pool)
    await pool.query(
      "UPDATE schema_migrations SET checksum_hex = NULL WHERE filename = '005_fees.sql'",
    )
    await expect(runMigrations(pool)).rejects.toThrow(/005_fees\.sql: defterde ozet YOK/)
    // Cozum yolunu SOYLUYOR: yeniden kurun.
    await expect(runMigrations(pool)).rejects.toThrow(/yeniden kurmakti?r|DROP SCHEMA/)
  })

  it('ozetlerin TAMAMI NULL ise (eski surumun defteri) yine durur', async () => {
    await runMigrations(pool)
    await pool.query('UPDATE schema_migrations SET checksum_hex = NULL')
    const err = await runMigrations(pool).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    // ALTI dosyanin ALTISI da raporlanir; ilk bulunanda durup kalmaz.
    for (const f of EXPECTED) expect((err as Error).message).toContain(f)
  })

  it('SILINMIS bir applied dosya yakalanir', async () => {
    // Olculen eski davranis: hic bakilmiyordu, `runMigrations` `[]` donuyor ve
    // yesil rapor ediyordu.
    await runMigrations(pool)
    const files = await migrationFiles()
    const without = files.filter((f) => f !== '004_transfers_and_holders.sql')
    await expect(runMigrations(pool, without)).rejects.toThrow(
      /004_transfers_and_holders\.sql: UYGULANMIS ama diskte yok/,
    )
  })

  it('ARAYA EKLENMIS bir dosya yakalanir (sirasiz uygulama)', async () => {
    // Olculen eski davranis: sessizce, sirasiz uygulaniyordu.
    await runMigrations(pool)
    const inserted = '003a_between.tmp.sql'
    await writeFile(
      join(MIGRATIONS_DIR, inserted),
      'CREATE TABLE between_me (x int PRIMARY KEY);\n',
    )
    try {
      await expect(runMigrations(pool, await migrationFiles())).rejects.toThrow(
        /003a_between\.tmp\.sql: uygulanmamis, ama uygulanmis olan 006_token_stats\.sql/,
      )
    } finally {
      await unlink(join(MIGRATIONS_DIR, inserted))
    }
  })

  it('SONA eklenen bir dosya mesrudur ve gecer', async () => {
    // Kapinin fazla siki OLMADIGININ kaniti: normal evrim yolu -- `007_...` --
    // engellenmiyor.
    await runMigrations(pool)
    const appended = '007_appended.tmp.sql'
    await writeFile(
      join(MIGRATIONS_DIR, appended),
      'CREATE TABLE appended_ok (x int PRIMARY KEY);\n',
    )
    try {
      await expect(runMigrations(pool)).resolves.toEqual([appended])
      await expect(runMigrations(pool)).resolves.toEqual([])
    } finally {
      await unlink(join(MIGRATIONS_DIR, appended))
      await pool.query('DROP TABLE IF EXISTS appended_ok')
      await pool.query('DELETE FROM schema_migrations WHERE filename = $1', [appended])
    }
  })

  // ---------------------------------------------------------------
  // DEFTER DOSYALAR uzerinde tamdi, SEMA uzerinde degildi. Olculen sonuc:
  // kusursuz bir defter + `DROP TABLE token_stats` = `ok=true, result=[]`.
  // Bos/dusurulmus semalar yalnizca TESADUFEN yakalaniyordu (ilk CREATE
  // TABLE'in 42P07'si), yani bir `IF NOT EXISTS` sessizlige bir adim
  // uzaktaydi -- ve C-1'in butun meselesi muhafizin tesadufe dayanmamasiydi.
  // ---------------------------------------------------------------
  it('DUSURULMUS bir tablo yakalanir (defter kusursuz olsa bile)', async () => {
    await runMigrations(pool)
    await pool.query('DROP TABLE token_stats')

    // Defter hala kusursuz: alti dosya, alti dogru ozet.
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM schema_migrations WHERE checksum_hex IS NOT NULL',
    )
    expect(rows[0]?.n).toBe(6)

    const err = await runMigrations(pool).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/sema, migration'larin urettiginden FARKLI/)
    // Ve NE eksik oldugunu SOYLUYOR.
    expect((err as Error).message).toContain('token_stats')
  })

  it('DUSURULMUS bir sutun ve FAZLADAN bir tablo da yakalanir', async () => {
    await runMigrations(pool)
    await pool.query('ALTER TABLE trades DROP COLUMN source')
    await pool.query('CREATE TABLE stowaway (x int PRIMARY KEY)')
    const err = await runMigrations(pool).catch((e: Error) => e)
    expect((err as Error).message).toContain('trades.source')
    expect((err as Error).message).toContain('stowaway')
  })

  it('parmak izi YOKSA (bu surumden onceki bir kosu) sert durustur', async () => {
    await runMigrations(pool)
    await pool.query('DELETE FROM schema_state')
    await expect(runMigrations(pool)).rejects.toThrow(/sema parmak izi YOK/)
  })

  it('DOKUNULMAMIS bir sema tekrar tekrar gecer (parmak izi kararli)', async () => {
    // Parmak izi katalogdan turedigi icin, hicbir sey degismediginde ayni
    // kalmali; aksi halde muhafiz her kosuda yanlis alarm verirdi.
    await runMigrations(pool)
    const { rows: a } = await pool.query<{ fingerprint_hex: string }>(
      'SELECT fingerprint_hex FROM schema_state',
    )
    await expect(runMigrations(pool)).resolves.toEqual([])
    await expect(runMigrations(pool)).resolves.toEqual([])
    const { rows: b } = await pool.query<{ fingerprint_hex: string }>(
      'SELECT fingerprint_hex FROM schema_state',
    )
    expect(b[0]?.fingerprint_hex).toBe(a[0]?.fingerprint_hex)
    expect(a[0]?.fingerprint_hex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('SATIRLAR parmak izini degistirmez (yapinin izi, verinin degil)', async () => {
    await runMigrations(pool)
    const { rows: a } = await pool.query<{ fingerprint_hex: string }>(
      'SELECT fingerprint_hex FROM schema_state',
    )
    await pool.query('INSERT INTO sync_state (id, last_block, last_block_hash) VALUES (1, 7, $1)', [
      `0x${'a'.repeat(64)}`,
    ])
    await expect(runMigrations(pool)).resolves.toEqual([])
    const { rows: b } = await pool.query<{ fingerprint_hex: string }>(
      'SELECT fingerprint_hex FROM schema_state',
    )
    expect(b[0]?.fingerprint_hex).toBe(a[0]?.fingerprint_hex)
  })

  it('42P07 e DAYANMIYOR: `IF NOT EXISTS` ile bile sessiz kalmaz', async () => {
    // Eski davranisin tesadufi olan yani: bos bir sema yalnizca ilk
    // `CREATE TABLE` catistigi icin yakalaniyordu. Burada catisma OLMAYAN bir
    // durum kuruluyor -- tablo GERCEKTEN yok -- ve muhafiz yine de duruyor.
    await runMigrations(pool)
    await pool.query('DROP TABLE token_stats')
    await pool.query('CREATE TABLE IF NOT EXISTS token_stats (token text PRIMARY KEY)')
    // Artik bir tablo VAR, yani hicbir CREATE catismaz; tek fark sutunlari.
    const err = await runMigrations(pool).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/sema, migration'larin urettiginden FARKLI/)
    expect((err as Error).message).toContain('token_stats')
  })

  // ---------------------------------------------------------------
  // PARMAK IZININ ICERIGI. Yukaridaki testler muhafizin MANTIGINI olcuyor;
  // bunlar ICERIGINI olcuyor.
  //
  // Gozden geciren `schemaInventory`nin bes mutasyonunu -- kisitlari
  // dusurmek, indeksleri dusurmek, `attnotnull`i dusurmek, SUTUN TIPINI
  // dusurmek -- uyguladi ve BESI DE bu dosyanin 22 testinden sagsalim gecti.
  // Yani erisimi VARSAYILAN bir ozellik, tam da o ariza kipini kapatmak icin
  // yazilmis kodun icinde. Asagidaki her test bir ALANI hedefler: o alani
  // envanterden cikarmak testi OLDURUR.
  // ---------------------------------------------------------------
  const fieldCases: [string, string, string][] = [
    // [alan, semayi degistiren DDL, hata mesajinda gorunmesi gereken]
    ['col: tip', 'ALTER TABLE token_stats ALTER COLUMN trade_count TYPE bigint', 'trade_count'],
    [
      'col: NOT NULL',
      'ALTER TABLE token_stats ALTER COLUMN market_cap_wei DROP NOT NULL',
      'market_cap_wei',
    ],
    [
      'col: uretim',
      'ALTER TABLE trades ADD COLUMN gen_seq bigint GENERATED ALWAYS AS (event_seq + 1) STORED',
      'gen_seq',
    ],
    [
      'def: DEFAULT',
      'ALTER TABLE token_stats ALTER COLUMN trade_count SET DEFAULT 7',
      'trade_count',
    ],
    [
      'con: CHECK',
      'ALTER TABLE token_stats DROP CONSTRAINT token_stats_trade_count_check',
      'trade_count',
    ],
    ['con: FK', 'ALTER TABLE trades DROP CONSTRAINT trades_token_fkey', 'trades_token_fkey'],
    ['idx: indeks', 'DROP INDEX trades_token_seq_idx', 'trades_token_seq_idx'],
    [
      'trg: tetikleyici',
      `CREATE FUNCTION scale_down() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN NEW.quote_amount_wei := NEW.quote_amount_wei / 1000000000000; RETURN NEW; END $$;
       CREATE TRIGGER t_scale BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION scale_down()`,
      't_scale',
    ],
    [
      'fun: fonksiyon govdesi',
      `CREATE OR REPLACE FUNCTION creator_at(p_token text, p_seq bigint) RETURNS text
       LANGUAGE sql STABLE AS $$ SELECT 'wrong' $$`,
      'creator_at',
    ],
  ]

  for (const [field, ddl, needle] of fieldCases) {
    it(`parmak izi ALANI "${field}" degisince kirilir`, async () => {
      await runMigrations(pool)
      for (const stmt of ddl.split(/;\s*(?=CREATE|ALTER|DROP)/)) await pool.query(stmt)
      const err = await runMigrations(pool).catch((e: Error) => e)
      expect(err, field).toBeInstanceOf(Error)
      expect((err as Error).message, field).toMatch(/sema, migration'larin urettiginden FARKLI/)
      expect((err as Error).message, field).toContain(needle)
    })
  }

  it('parmak izi ALANI "col: uretim bayragi" TEK BASINA bilgi tasir', async () => {
    // MUTASYON MATRISI BU TESTI GEREKTIRDI. `attgenerated`i envanterden
    // cikaran mutant SAGSALIM GECIYORDU: `gen_seq` testi YENI BIR SUTUNU
    // goruyordu, sutunun URETILMIS olmasini degil. Yani o alanin kapsami
    // olculmemisti -- duzeltmenin icinde ayni ariza kipi.
    //
    // Alani izole etmenin tek yolu: ad AYNI, tip AYNI, ve `pg_attrdef`
    // ifadesi de AYNI olsun; tek fark `attgenerated` olsun. `DEFAULT (expr)`
    // ile `GENERATED ALWAYS AS (expr) STORED` tam olarak budur -- ve anlamlari
    // TAMAMEN farklidir (biri yazilmazsa doldurulur, oteki HER ZAMAN hesaplanir
    // ve yazilamaz).
    await runMigrations(pool)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE trades ADD COLUMN probe_seq bigint DEFAULT (1 + 1)')
      const withDefault = await schemaInventory(client)
      await client.query('ALTER TABLE trades DROP COLUMN probe_seq')
      await client.query(
        'ALTER TABLE trades ADD COLUMN probe_seq bigint GENERATED ALWAYS AS (1 + 1) STORED',
      )
      const withGenerated = await schemaInventory(client)

      // `col` satirlari ad ve tip bakimindan ayni; `def` satirlari ayni ifade.
      const defLine = (inv: string[]) => inv.filter((l) => l.includes('trades.probe_seq'))
      expect(defLine(withDefault).some((l) => l.startsWith('def '))).toBe(true)
      expect(defLine(withGenerated).some((l) => l.startsWith('def '))).toBe(true)
      // Ama envanterler AYRI -- farki tasiyan tek sey uretim bayragi.
      expect(withGenerated).not.toEqual(withDefault)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('TETIKLEYICI ORNEGI: 1e12 kucultmesi yapan bir trigger gorunmez DEGIL', async () => {
    // Bu, iki savunmanin da bakmadigi tek kapiydi: adlandirma kapisi bir
    // tetikleyici gormez, ve parmak izi de gormuyordu. Sonuc, bu paketin var
    // olma sebebi olan 1e12 hatasinin sessizce eklenebilmesiydi.
    await runMigrations(pool)
    await pool.query(`CREATE FUNCTION scale_down() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.quote_amount_wei := NEW.quote_amount_wei / 1000000000000; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER t_scale BEFORE INSERT ON trades
      FOR EACH ROW EXECUTE FUNCTION scale_down()`)
    const err = await runMigrations(pool).catch((e: Error) => e)
    expect((err as Error).message).toContain('t_scale')
    expect((err as Error).message).toContain('scale_down')
  })

  it('parmak izi `search_path`ten BAGIMSIZDIR', async () => {
    // `conrelid::regclass::text` `search_path`e baglidir: ayni sema farkli bir
    // ozet uretiyordu (olculdu: 235 satirin 88'i). Yanlis bir SERT DURUS,
    // kacirandan daha kotudur -- basilan cozum `dropdb`.
    await runMigrations(pool)
    const a = await readInventory(pool)
    await pool.query("SET search_path TO ''")
    const b = await readInventory(pool)
    await pool.query('SET search_path TO public')
    const c = await readInventory(pool)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    // Ve muhafiz de bu durumda YANLIS ALARM vermez.
    await pool.query("SET search_path TO ''")
    await expect(runMigrations(pool)).resolves.toEqual([])
    await pool.query('SET search_path TO public')
  })

  it('BOS defter + DOLU sema sert durustur', async () => {
    // Olculen eski davranis: bos defter + dusurulmus `creator_history` +
    // catismayan bir bekleyen dosya = `ok=true`, tablo hala yok, VE parmak izi
    // uzerine yazilarak sapma yeniden kutsaniyordu.
    await runMigrations(pool)
    await pool.query('DROP TABLE creator_history CASCADE')
    await pool.query('DELETE FROM schema_migrations')
    await pool.query('DELETE FROM schema_state')
    const err = await runMigrations(pool).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/defter BOS ama sema bos DEGIL/)
    // Ve sapma YENIDEN KUTSANMADI.
    await expect(pool.query('SELECT 1 FROM creator_history')).rejects.toThrow(/creator_history/)
  })

  it('SERT DURUS arkasinda tablo BIRAKMAZ', async () => {
    // Onceki hali defter ve durum tablolarini karsilastirmadan ONCE
    // olusturuyordu, yani reddedilen bir kosu bile iz birakiyordu.
    await dropSchema()
    await pool.query('CREATE TABLE stray (x int PRIMARY KEY)')
    await expect(runMigrations(pool)).rejects.toThrow(/defter BOS ama sema bos DEGIL/)
    const { rows } = await pool.query<{ n: number }>(`
      SELECT count(*)::int n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r' AND c.relname IN ('schema_migrations', 'schema_state')`)
    expect(rows[0]?.n).toBe(0)
  })

  it('uyusmazlik varsa HICBIR DDL calismaz', async () => {
    // Karsilastirma her seyden ONCE yapilir. Ledger bozukken bekleyen bir
    // dosya da varsa, o dosya UYGULANMAMALI.
    await runMigrations(pool)
    await pool.query(
      "UPDATE schema_migrations SET checksum_hex = NULL WHERE filename = '001_deployment_and_cursor.sql'",
    )
    const pendingFile = '008_should_not_apply.tmp.sql'
    await writeFile(
      join(MIGRATIONS_DIR, pendingFile),
      'CREATE TABLE should_not_exist (x int PRIMARY KEY);\n',
    )
    try {
      await expect(runMigrations(pool)).rejects.toThrow(/defterde ozet YOK/)
      await expect(pool.query('SELECT 1 FROM should_not_exist')).rejects.toThrow(/should_not_exist/)
    } finally {
      await unlink(join(MIGRATIONS_DIR, pendingFile))
    }
  })

  it('TEMIZ OLMAYAN bir veritabani da SERT DURUSTUR (kural degisti)', async () => {
    // Bu test eskiden alakasiz bir tablo varken migration'larin GECMESINI
    // istiyordu -- "bos oldugu icin gecen migration" ariza kipine karsi.
    // Yeni kural onu kapsiyor ve DAHA GENIS: bos bir defter yalnizca bos bir
    // semayla tutarlidir. Gerekce, gozden gecirenin olctugu sey: bos defter +
    // dusurulmus bir tablo + catismayan bir bekleyen dosya sessizce geciyor ve
    // sapmayi YENIDEN KUTSUYORDU. Alakasiz bir tabloyu gecirip bizim
    // tablomuzu gecirmemek icin, dosyalarin ne yarattigini SQL'den cikarmak
    // gerekirdi; o kirilgan, ve hukum zaten "bilinmeyen durum sert durustur".
    //
    // "Bos oldugu icin gecti" endisesini karsilayan sey artik KISMEN
    // uygulanmis veritabani testi: orada sema DOLU ve migration'lar calisiyor.
    await pool.query('CREATE TABLE unrelated_table (x int PRIMARY KEY)')
    await expect(runMigrations(pool)).rejects.toThrow(/defter BOS ama sema bos DEGIL/)
  })
})

/** Sutunlar, kisitlar ve indeksler -- semanin karsilastirilabilir tam hali. */
async function catalog(): Promise<unknown> {
  const columns = await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default,
           numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema = 'public'
    ORDER BY table_name, column_name`)
  const constraints = await pool.query(`
    SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    ORDER BY rel, conname`)
  const indexes = await pool.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' ORDER BY tablename, indexname`)
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows }
}
