import { createHash } from 'node:crypto'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  INVENTORY_KINDS,
  inventoryObjects,
  MIGRATIONS_DIR,
  migrationFiles,
  readInventory,
  runMigrations,
  schemaInventory,
} from '../src/migrate'
import type { PoolClient } from '../src/pool'
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

  // ===============================================================
  // ALANLARIN ERISIMI -- "on bir mutant tum suite'ten sagsalim gecti".
  //
  // Yukaridaki `fieldCases` her alani BIR KEZ hedefliyordu, ama hepsi nesneyi
  // EKLEYEREK ya da SILEREK. Gozden geciren bunun ne olctugunu ayirdi: bir
  // nesnenin VARLIGI olculuyordu, alanin ICERIGI degil. On alti yeni mutantin
  // ON BIRI 149 testin TAMAMINDAN sagsalim gecti -- `atttypmod`,
  // `pg_get_constraintdef`, `indexdef`, `pg_get_triggerdef`, `provolatile`,
  // `pg_get_function_identity_arguments`, sema bileseni, relkind erisimi ve
  // `public` disi sema erisimi. Canli kod hepsi icin DOGRUYDU (yedi pozitif
  // kontrol olculdu), yani bunlar delik degil "erisimi VARSAYILMIS" alanlar.
  // Ariza kipi 4'un bir seviye asagisi.
  //
  // Asagidaki testler nesnenin ADINI SABIT TUTAR ve yalnizca alani degistirir,
  // yani "yeni bir satir belirdi" ile gecemezler. Adin sabit kaldigi
  // IDDIA EDILMEZ, `inventoryObjects` ile OLCULUR.
  // ===============================================================
  const nameHolding: [string, string, string][] = [
    // [alan, hazirlik, DEGISIM -- nesnenin adi degismeden]
    [
      'col: atttypmod -- numeric(78,0) vs (78,6), yani PARANIN SEKLI',
      '',
      'ALTER TABLE token_stats ALTER COLUMN market_cap_wei TYPE numeric(78,6)',
    ],
    [
      'col: attidentity -- ALWAYS mi BY DEFAULT mi',
      'CREATE TABLE id_probe (k int GENERATED ALWAYS AS IDENTITY)',
      `DROP TABLE id_probe;;
       CREATE TABLE id_probe (k int GENERATED BY DEFAULT AS IDENTITY)`,
    ],
    [
      'con: tanim metni -- FK eylemi (ON DELETE CASCADE)',
      '',
      `ALTER TABLE trades DROP CONSTRAINT trades_token_fkey;;
       ALTER TABLE trades ADD CONSTRAINT trades_token_fkey
         FOREIGN KEY (token) REFERENCES launches(token) ON DELETE CASCADE`,
    ],
    [
      'con: tanim metni -- ertelenebilirlik',
      '',
      `ALTER TABLE trades DROP CONSTRAINT trades_curve_fkey;;
       ALTER TABLE trades ADD CONSTRAINT trades_curve_fkey
         FOREIGN KEY (curve) REFERENCES curve_state(curve) DEFERRABLE INITIALLY DEFERRED`,
    ],
    [
      'idx: tanim metni -- TEKILLIK',
      '',
      `DROP INDEX trades_token_seq_idx;;
       CREATE UNIQUE INDEX trades_token_seq_idx ON trades (token, event_seq DESC)`,
    ],
    [
      'idx: tanim metni -- KISMILIK',
      '',
      `DROP INDEX trades_trader_seq_idx;;
       CREATE INDEX trades_trader_seq_idx ON trades (trader, event_seq DESC) WHERE is_buy`,
    ],
    [
      'trg: tanim metni -- ZAMANLAMA (BEFORE vs AFTER)',
      `CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;;
       CREATE TRIGGER t_probe BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION noop()`,
      `DROP TRIGGER t_probe ON trades;;
       CREATE TRIGGER t_probe AFTER INSERT ON trades FOR EACH ROW EXECUTE FUNCTION noop()`,
    ],
    [
      'trg: tanim metni -- WHEN kosulu',
      `CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;;
       CREATE TRIGGER t_probe BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION noop()`,
      `DROP TRIGGER t_probe ON trades;;
       CREATE TRIGGER t_probe BEFORE INSERT ON trades FOR EACH ROW
         WHEN (NEW.is_buy) EXECUTE FUNCTION noop()`,
    ],
    [
      'fun: OYNAKLIK -- STABLE -> VOLATILE, govde ayni',
      '',
      'ALTER FUNCTION creator_at(text, bigint) VOLATILE',
    ],
    [
      'fun: DONUS TIPI -- govde ayni, RETURNS farkli',
      `CREATE FUNCTION rt_probe(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE
         AS $$ SELECT $1 $$`,
      `DROP FUNCTION rt_probe(numeric);;
       CREATE FUNCTION rt_probe(numeric) RETURNS bigint LANGUAGE sql IMMUTABLE
         AS $$ SELECT $1::bigint $$`,
    ],
    [
      'fun: SECURITY DEFINER',
      `CREATE FUNCTION sd_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
      'ALTER FUNCTION sd_probe() SECURITY DEFINER',
    ],
    [
      'fun: proconfig (`SET search_path` govdenin icinde)',
      `CREATE FUNCTION pc_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
      'ALTER FUNCTION pc_probe() SET search_path = pg_catalog',
    ],
    [
      'fun: KIMLIK ARGUMANLARI -- ayni ADIN asiri yuklemesi',
      `CREATE FUNCTION ov_probe(int) RETURNS int LANGUAGE sql AS $$ SELECT $1 $$`,
      `CREATE FUNCTION ov_probe(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$`,
    ],
    [
      'rel: relkind -- VIEW mi MATVIEW mi (sutunlar ve govde AYNI)',
      'CREATE VIEW rk_probe (q_wei) AS SELECT quote_amount_wei FROM trades',
      `DROP VIEW rk_probe;;
       CREATE MATERIALIZED VIEW rk_probe (q_wei) AS SELECT quote_amount_wei FROM trades`,
    ],
    [
      'rel: kalicilik -- UNLOGGED',
      'CREATE TABLE ul_probe (x int)',
      'ALTER TABLE ul_probe SET UNLOGGED',
    ],
    [
      'rel: BOLUNTU SINIRI -- ayni cocuk, farkli araligi',
      `CREATE TABLE pt_probe (k int) PARTITION BY RANGE (k);;
       CREATE TABLE pt_child PARTITION OF pt_probe FOR VALUES FROM (0) TO (10)`,
      `ALTER TABLE pt_probe DETACH PARTITION pt_child;;
       ALTER TABLE pt_probe ATTACH PARTITION pt_child FOR VALUES FROM (0) TO (20)`,
    ],
    [
      'seq: ARTIS -- 1 yerine 1e12',
      'CREATE SEQUENCE sq_probe INCREMENT 1',
      'ALTER SEQUENCE sq_probe INCREMENT 1000000000000',
    ],
    [
      'dom: ALAN KISITI -- ayni ad, farkli CHECK',
      `CREATE DOMAIN dm_probe AS numeric(78,0);;
       ALTER DOMAIN dm_probe ADD CONSTRAINT dm_probe_positive CHECK (VALUE >= 0)`,
      `ALTER DOMAIN dm_probe DROP CONSTRAINT dm_probe_positive;;
       ALTER DOMAIN dm_probe ADD CONSTRAINT dm_probe_positive CHECK (VALUE >= 1000)`,
    ],
    [
      'viw: GOVDE -- 1e12 kucultmesi, SUTUN TIPI AYNI TUTULARAK',
      'CREATE VIEW vb_probe (q_wei) AS SELECT quote_amount_wei::numeric(78,0) FROM trades',
      `CREATE OR REPLACE VIEW vb_probe (q_wei) AS
         SELECT (quote_amount_wei / 1000000000000)::numeric(78,0) FROM trades`,
    ],
    [
      'fun: BEGIN ATOMIC govdesi -- 1e12 kucultmesi',
      `CREATE FUNCTION view6(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE
         BEGIN ATOMIC SELECT $1; END`,
      `CREATE OR REPLACE FUNCTION view6(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE
         BEGIN ATOMIC SELECT $1 / 1000000000000; END`,
    ],
    [
      'fun: eski `AS $$ ... $$` govdesi -- ayni 1e12 kucultmesi',
      `CREATE FUNCTION view6(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE
         AS $$ SELECT $1 $$`,
      `CREATE OR REPLACE FUNCTION view6(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE
         AS $$ SELECT $1 / 1000000000000 $$`,
    ],
  ]

  for (const [field, setup, change] of nameHolding) {
    it(`parmak izi ALANI "${field}" -- nesnenin ADI SABITKEN kirilir`, async () => {
      await runMigrations(pool)
      await inTx(async (client) => {
        for (const s of stmts(setup)) await client.query(s)
        const before = await schemaInventory(client)
        for (const s of stmts(change)) await client.query(s)
        const after = await schemaInventory(client)
        // ADLAR SABIT KALDI -- iddia degil, olcum. Bu olmadan test "yeni bir
        // satir belirdi" ile de gecerdi, ki eski `fieldCases` tam olarak oydu.
        expect(inventoryObjects(after), field).toEqual(inventoryObjects(before))
        expect(after, field).not.toEqual(before)
      })
    })
  }

  it('MATVIEW GOVDESI -- Task 11 `volume_24h_wei`i tam olarak buraya koyacak', async () => {
    // `viw` satirlari eklenmeden once bu OLCULDU: sutun tipi ayni tutulunca
    // `sum(q)::numeric(78,0)` ile `(sum(q)/1e12)::numeric(78,0)` AYNI parmak
    // izini veriyordu ve `runMigrations` `ok=true` donuyordu. Matview'i EKLEMEK
    // goruluyordu (sutunlari beliriyordu); VAR OLANI DUZENLEMEK gorulmuyordu.
    await runMigrations(pool)
    await inTx(async (client) => {
      await client.query(`CREATE MATERIALIZED VIEW mv_probe (volume_24h_wei) AS
        SELECT sum(quote_amount_wei)::numeric(78,0) FROM trades`)
      const before = await schemaInventory(client)
      await client.query('DROP MATERIALIZED VIEW mv_probe')
      await client.query(`CREATE MATERIALIZED VIEW mv_probe (volume_24h_wei) AS
        SELECT (sum(quote_amount_wei) / 1000000000000)::numeric(78,0) FROM trades`)
      const after = await schemaInventory(client)
      expect(inventoryObjects(after)).toEqual(inventoryObjects(before))
      // Sutun satiri GERCEKTEN ayni -- fark yalnizca govdede.
      const cols = (inv: string[]) => inv.filter((l) => l.startsWith('col public.mv_probe'))
      expect(cols(after)).toEqual(cols(before))
      expect(after).not.toEqual(before)
    })
  })

  it('BEGIN ATOMIC 1e12 kucultmesi SERT DURUSTUR (uctan uca)', async () => {
    // `md5(COALESCE(prosrc,''))` bu sozdizimi icin HER ZAMAN
    // `d41d8cd98f00b204e9800998ecf8427e` uretiyordu, cunku `prosrc` BOS DIZE.
    // Yani parmak izi butun SQL-standardi govdeleri AYNI goruyordu.
    await runMigrations(pool)
    await pool.query(`CREATE FUNCTION view6(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE
      BEGIN ATOMIC SELECT $1; END`)
    await pool.query(`ALTER TABLE trades ADD COLUMN quote_number numeric
      GENERATED ALWAYS AS (view6(quote_amount_wei)) STORED`)
    // Bu ekleme zaten yakalanir; ONU kutsayip SONRAKI takasi olcuyoruz.
    await expect(runMigrations(pool)).rejects.toThrow(/FARKLI/)
    const inv = await readInventory(pool)
    await pool.query(
      'UPDATE schema_state SET fingerprint_hex = $1, inventory_json = $2 WHERE id = 1',
      [sha256Hex(inv.join('\n')), JSON.stringify(inv)],
    )
    await expect(runMigrations(pool)).resolves.toEqual([])

    // ISTE O KAPI: govde 1e12 kucultmesine cevriliyor, imza ve tip AYNI.
    await pool.query(`CREATE OR REPLACE FUNCTION view6(numeric) RETURNS numeric
      LANGUAGE sql IMMUTABLE BEGIN ATOMIC SELECT $1 / 1000000000000; END`)
    const err = await runMigrations(pool).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/sema, migration'larin urettiginden FARKLI/)
    expect((err as Error).message).toContain('view6')
    // `pg_get_expr` DEGISMEDI: uretilmis sutun hala `view6(quote_amount_wei)`.
    // Yani bu satiri tasiyan tek sey fonksiyon ozetidir.
    expect(
      (await readInventory(pool)).some((l) => l.startsWith('def public.trades.quote_number')),
    ).toBe(true)
  })

  it('SQL-standardi govdeler ARTIK BIRBIRINDEN AYIRT EDILIR', async () => {
    // Deligin sekli tam olarak buydu: `prosrc` bos oldugu icin butun
    // `BEGIN ATOMIC` fonksiyonlari AYNI ozeti tasiyordu. Uc farkli govde,
    // uc farkli ozet olmali.
    await runMigrations(pool)
    await inTx(async (client) => {
      const digests: string[] = []
      for (const expr of ['$1', '$1 / 1000000000000', '$1 * 2']) {
        await client.query(`CREATE OR REPLACE FUNCTION view6(numeric) RETURNS numeric
          LANGUAGE sql IMMUTABLE BEGIN ATOMIC SELECT ${expr}; END`)
        const line = (await schemaInventory(client)).find((l) => l.startsWith('fun public.view6'))
        expect(line, expr).toBeDefined()
        digests.push(line!)
      }
      expect(new Set(digests).size).toBe(3)
      // Ve hicbiri BOS DIZENIN md5'i degil.
      for (const d of digests) expect(d).not.toContain('d41d8cd98f00b204e9800998ecf8427e')
    })
  })

  it('AGREGAT bir fonksiyon envanteri PATLATMAZ (yanlis SERT DURUS olurdu)', async () => {
    // `pg_get_functiondef` `prokind='a'` uzerinde HATA ATAR (olculdu:
    // `"agg_sum" is an aggregate function`). Envanterin patlamasi, cozumu
    // `dropdb` diye basilan bir YANLIS sert durus demek olurdu -- bu proje onu
    // kacirandan kotu saydi. Agregatlar `pg_aggregate` alanlariyla ozetlenir.
    await runMigrations(pool)
    await inTx(async (client) => {
      await client.query(
        'CREATE AGGREGATE agg_probe (numeric) (SFUNC = numeric_add, STYPE = numeric)',
      )
      const before = await schemaInventory(client)
      expect(before.some((l) => l.startsWith('fun public.agg_probe'))).toBe(true)
      await client.query('DROP AGGREGATE agg_probe(numeric)')
      await client.query(`CREATE AGGREGATE agg_probe (numeric)
        (SFUNC = numeric_add, STYPE = numeric, FINALFUNC = numeric_uplus)`)
      const after = await schemaInventory(client)
      // Adi ayni, GECIS FONKSIYONU farkli -- ve gorulyor.
      expect(inventoryObjects(after)).toEqual(inventoryObjects(before))
      expect(after).not.toEqual(before)
    })
  })

  it('SEMA BILESENI bilgi tasir: ayni ad, baska bir semada', async () => {
    // `n.nspname` mutanti butun suite'ten sagsalim geciyordu, cunku hicbir test
    // AYNI ADI iki semaya koymuyordu. Adlandirma kapisinin bu kacis icin ADI
    // KONMUS bir testi vardi (`KACIS: baska bir SEMADAKI tablo`), parmak
    // izinin YOKTU -- ayni kacis bir savunma icin kapatilip komsusunda
    // olculmemis birakilmisti.
    await runMigrations(pool)
    await inTx(async (client) => {
      await client.query('CREATE TABLE ns_probe (x int)')
      const inPublic = await schemaInventory(client)
      await client.query('DROP TABLE ns_probe')
      await client.query('CREATE SCHEMA reporting')
      await client.query('CREATE TABLE reporting.ns_probe (x int)')
      const inReporting = await schemaInventory(client)
      expect(inReporting).not.toEqual(inPublic)
      expect(inPublic.some((l) => l === 'col public.ns_probe.x|integer|false||')).toBe(true)
      expect(inReporting.some((l) => l === 'col reporting.ns_probe.x|integer|false||')).toBe(true)
    })
  })

  it('`public` DISINDAKI bir sema muhafizi GERCEKTEN durdurur', async () => {
    // Sema suzgeci `= public` yapan mutant da sagsalim geciyordu.
    await runMigrations(pool)
    await pool.query('CREATE SCHEMA reporting')
    try {
      await pool.query(`CREATE TABLE reporting.rollup (
        token text, volume_24h_wei numeric(78,0))`)
      await pool.query(`CREATE FUNCTION reporting.scale(numeric) RETURNS numeric
        LANGUAGE sql IMMUTABLE AS $$ SELECT $1 / 1000000000000 $$`)
      const err = await runMigrations(pool).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/sema, migration'larin urettiginden FARKLI/)
      expect((err as Error).message).toContain('reporting.rollup')
      expect((err as Error).message).toContain('reporting.scale')
    } finally {
      await pool.query('DROP SCHEMA reporting CASCADE')
    }
  })

  it('RELKIND ERISIMI: view, matview ve bolumlenmis tablo SUTUNLARIYLA gorulur', async () => {
    // `relkind = ANY('{r,p,v,m,f}')` KODDA yaziliydi ve hicbir test onu
    // olcmuyordu; `r`ye daraltan mutant butun suite'ten sagsalim geciyordu.
    // Adlandirma kapisinin ayni erisim icin ADI KONMUS testleri vardi
    // (`KACIS: public icindeki bir MATERIALIZED VIEW`), parmak izinin yoktu.
    await runMigrations(pool)
    await inTx(async (client) => {
      const before = await schemaInventory(client)
      await client.query('CREATE VIEW rv (q_wei) AS SELECT quote_amount_wei FROM trades')
      await client.query(
        'CREATE MATERIALIZED VIEW rm (q_wei) AS SELECT quote_amount_wei FROM trades',
      )
      await client.query('CREATE TABLE rp (k int) PARTITION BY RANGE (k)')
      await client.query('CREATE TABLE rp1 PARTITION OF rp FOR VALUES FROM (0) TO (10)')
      const added = (await schemaInventory(client)).filter((l) => !before.includes(l))

      // SUTUN satirlari -- `relkind` erisimini tasiyan yer burasi.
      expect(added).toContain('col public.rv.q_wei|numeric(78,0)|false||')
      expect(added).toContain('col public.rm.q_wei|numeric(78,0)|false||')
      expect(added).toContain('col public.rp.k|integer|false||')
      expect(added).toContain('col public.rp1.k|integer|false||')

      // ILISKI satirlari -- her biri kendi relkind'iyla.
      for (const [rel, kind] of [
        ['rv', 'v'],
        ['rm', 'm'],
        ['rp', 'p'],
        ['rp1', 'r'],
      ] as const) {
        expect(
          added.some((l) => l.startsWith(`rel public.${rel}|${kind}|`)),
          rel,
        ).toBe(true)
      }
      // Ve view/matview GOVDELERI de orada.
      expect(added.some((l) => l.startsWith('viw public.rv|v|'))).toBe(true)
      expect(added.some((l) => l.startsWith('viw public.rm|m|'))).toBe(true)
    })
  })

  it('AD ALANLARI TANIMIN ICINDE DE VARDIR -- artiklik OLCULUR, iddia edilmez', async () => {
    // `idx: index name` ve `trg: trigger name` mutantlari sagsalim geciyordu ve
    // sebebi bir delik DEGIL: `indexdef` ve `pg_get_triggerdef` nesnenin adini
    // zaten tasir, yani ayri alan BILGI EKLEMEZ. Bunu SOYLEMEK yerine OLCUYORUZ
    // -- ve alan format olarak da sabitleniyor, yani "artik oldugu icin
    // silelim" kararini bu test tutar.
    await runMigrations(pool)
    await pool.query(`CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NEW; END $$`)
    await pool.query(
      'CREATE TRIGGER t_named BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION noop()',
    )
    try {
      const inv = await readInventory(pool)
      const three = (prefix: string) =>
        inv.filter((l) => l.startsWith(prefix)).map((l) => l.slice(4).split('|'))
      const idx = three('idx ')
      const trg = three('trg ')
      expect(idx.length).toBeGreaterThan(0)
      expect(trg.length).toBeGreaterThan(0)
      for (const parts of [...idx, ...trg]) {
        expect(parts).toHaveLength(3)
        // parts = [sema.iliski, ad, tanim] -- ad tanimin ICINDE.
        expect(parts[2]).toContain(parts[1]!)
      }
      // `fun` icin ayni sey: kimlik argumanlari `pg_get_functiondef`in ICINDE,
      // yani OZET icin artik. AMA MESAJ ICIN DEGIL: iki asiri yukleme, ozetleri
      // farkli olsa bile, okuyucuya AYNI adla gorunurdu. Bu yuzden basliktaki
      // `(argumanlar)` kismi da sabitleniyor -- ve OLCULUYOR ki dolu olsun,
      // yoksa `'()|'` yazan bir mutant sessizce gecerdi.
      const fun = inv.filter((l) => l.startsWith('fun ')).map((l) => l.slice(4).split('|'))
      expect(fun.length).toBeGreaterThan(0)
      for (const parts of fun) {
        expect(parts).toHaveLength(2)
        expect(parts[0]).toMatch(/^[^|]+\(.*\)$/)
      }
      // Argumanlar GERCEKTEN orada, ve `pg_get_function_identity_arguments`
      // parametre ADLARINI da render eder (olculdu).
      expect(fun.map((p) => p[0])).toContain('public.creator_at(p_token text, p_seq bigint)')
    } finally {
      await pool.query('DROP TRIGGER t_named ON trades')
      await pool.query('DROP FUNCTION noop()')
    }
  })

  // ===============================================================
  // BOS DEFTER KURALININ KAPSAMI parmak izinin kapsamiyla AYNI OLMALI.
  // Kural strayleri YALNIZCA `col ` satirlarindan turetiyordu, yani "bos bir
  // sema" degil "sutunu olan hicbir iliski" diyordu.
  // ===============================================================
  const leftovers: [string, string][] = [
    ['SUTUNU OLAN bir tablo', 'CREATE TABLE leftover (x int)'],
    ['SIFIR SUTUNLU bir tablo', 'CREATE TABLE leftover ()'],
    [
      'bir FONKSIYON -- ustelik /1e12 yapan',
      `CREATE FUNCTION leftover(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE
         AS $$ SELECT $1 / 1000000000000 $$`,
    ],
    ['bir DIZI', 'CREATE SEQUENCE leftover'],
    ['bir ALAN (DOMAIN)', 'CREATE DOMAIN leftover AS numeric(78,0)'],
    [
      'baska bir SEMADAKI tablo',
      'CREATE SCHEMA elsewhere;; CREATE TABLE elsewhere.leftover (x int)',
    ],
  ]
  for (const [what, ddl] of leftovers) {
    it(`BOS defter + ARTAKALAN ${what} = SERT DURUS`, async () => {
      for (const s of stmts(ddl)) await pool.query(s)
      try {
        const err = await runMigrations(pool).catch((e: Error) => e)
        expect(err, what).toBeInstanceOf(Error)
        expect((err as Error).message, what).toMatch(/defter BOS ama sema bos DEGIL/)
        expect((err as Error).message, what).toContain('leftover')
        // Ve BENIMSENMEDI: parmak izi yazilmadi, tablolar kurulmadi.
        const { rows } = await pool.query<{ ok: boolean }>(
          `SELECT to_regclass('public.schema_state') IS NOT NULL AS ok`,
        )
        expect(rows[0]?.ok, what).toBe(false)
      } finally {
        await pool.query('DROP SCHEMA IF EXISTS elsewhere CASCADE')
      }
    })
  }

  it('URETIMDEKI SEKLI: `public` icinde onceden kurulmus bir extension', async () => {
    // Bunun neden en kotu yari oldugunun olcumu: eski kod ILK KOSUDA gecip
    // 31 pgcrypto fonksiyon satirini parmak izine ALIYORDU, ve ARDINDAN
    // siradan bir extension bakimi muhafizi durduruyordu -- cozumu operatore
    // `dropdb` diye basilan bir YANLIS sert durus. Gozden geciren bunu
    // kacirmaktan kotu saydi ve haklidir. Simdi kurulum aninda, hicbir sey
    // yazilmadan once reddediliyor.
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public')
    const err = await runMigrations(pool).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/defter BOS ama sema bos DEGIL/)
    // Ve cozum yolu BU DURUMA uygun; yalnizca `dropdb` demiyor.
    expect((err as Error).message).toMatch(/extension'lari kendi semalarina kurun/)
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`,
    )
    expect(rows[0]?.ok).toBe(false)
  })

  it('BOS defter kuralinin kapsami parmak izinin kapsamiyla AYNIDIR', async () => {
    // Iki kapsam ayrisirsa yeniden ayni kusur olur. Zengin bir envanterdeki
    // HER TURUN `inventoryObjects` tarafindan TANINDIGI olculuyor -- bir tur
    // eklenip burasi guncellenmezse bu test kirilir.
    await runMigrations(pool)
    await inTx(async (client) => {
      await client.query('CREATE SEQUENCE k_seq')
      await client.query('CREATE DOMAIN k_dom AS numeric(78,0)')
      await client.query('CREATE VIEW k_view (q_wei) AS SELECT quote_amount_wei FROM trades')
      await client.query(
        'CREATE MATERIALIZED VIEW k_mv (q_wei) AS SELECT quote_amount_wei FROM trades',
      )
      await client.query('CREATE TABLE k_empty ()')
      // Migration'lar tetikleyici URETMEZ, yani `trg` ancak burada dogar.
      await client.query(`CREATE FUNCTION k_noop() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RETURN NEW; END $$`)
      await client.query(
        'CREATE TRIGGER k_trg BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION k_noop()',
      )
      const inv = await schemaInventory(client)
      const kinds = [...new Set(inv.map((l) => l.slice(0, 3)))].sort()
      // Envanterin URETTIGI her tur, `LINE_OBJECT`in BILDIGI turlerden biri.
      expect(kinds.filter((k) => !INVENTORY_KINDS.includes(k))).toEqual([])
      // Ve on turun hepsi gercekten uretiliyor -- yani liste olu giris degil.
      expect(kinds).toEqual(INVENTORY_KINDS)
      // Sifir sutunlu tablo ve dizi ADIYLA goruluyor.
      const objects = inventoryObjects(inv)
      expect(objects).toContain('public.k_empty')
      expect(objects).toContain('public.k_seq')
      expect(objects).toContain('public.k_dom')
      expect(objects).toContain('public.k_mv')
    })
  })

  it('UYUSMAZLIK VARSA HICBIR DDL CALISMAZ -- `ADD_CHECKSUM` dahil', async () => {
    // Olculdu, once ve sonra: eski kodda `ALTER TABLE ... ADD COLUMN IF NOT
    // EXISTS checksum_hex` muhafizdan ONCE kosuyordu ve reddedilen bir kosu
    // sutunu ARDINDA birakiyordu (`before=0, after=1`). Docstring'in
    // "hicbir DDL calismaz" cumlesi tam olarak bir durumda YANLISTI.
    await runMigrations(pool)
    await pool.query('ALTER TABLE schema_migrations DROP COLUMN checksum_hex')
    await pool.query('CREATE TABLE stray_here (x int)')
    const columnCount = async () => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_attribute
         WHERE attrelid = 'public.schema_migrations'::regclass
           AND attname = 'checksum_hex' AND NOT attisdropped`,
      )
      return rows[0]?.n ?? -1
    }
    expect(await columnCount()).toBe(0)
    await expect(runMigrations(pool)).rejects.toThrow(/defterde ozet YOK/)
    expect(await columnCount()).toBe(0)
  })

  // ===============================================================
  // SUTUN SIRASI KAPSAM DISIDIR -- ve gerekcesi BURADA SINANIR.
  // ===============================================================
  it('SUTUN SIRASI kapsam disi: konumsal `INSERT` bu depoda HIC YOK', async () => {
    // Envanter `.sort()`lidir, yani `attnum` gorunmez. Bunu "onemsiz" diye
    // gecmek yazilmamis bir on kosul olurdu (ariza kipi 3). Sutun sirasina
    // duyarli tek sey sutunlarini saymayan bir `INSERT ... VALUES`tir; iddia
    // "yok" degil, bu test onu OKUR. Yeni bir konumsal INSERT yazilirsa bu
    // test kirilir ve karar yeniden verilir.
    const roots = ['src', 'migrations']
    const files: string[] = []
    for (const root of roots) {
      const dir = join(MIGRATIONS_DIR, '..', root)
      for (const f of await readdir(dir)) {
        if (f.endsWith('.ts') || f.endsWith('.sql')) files.push(join(dir, f))
      }
    }
    expect(files.length).toBeGreaterThan(10)
    const positional: string[] = []
    for (const f of files) {
      const text = await readFile(f, 'utf8')
      // YORUMLAR ATILIR. Atilmadan once bu testin kendisi yanlis alarm
      // veriyordu: `src/hex.ts:54` bir docstring icinde `insert into t values
      // (chr(0))` ORNEGI tasiyor -- kod degil, anlatim.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|\n)[^\n]*?--[^\n]*/g, '$1 ')
        .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1 ')
      // `INSERT INTO <ad>` ardindan `(` gelmeden `VALUES`/`SELECT` geliyorsa
      // sutunlar sayilmamis demektir.
      for (const m of code.matchAll(/INSERT\s+INTO\s+[A-Za-z_."]+\s+(VALUES|SELECT)/gi)) {
        positional.push(`${f}: ${m[0]}`)
      }
    }
    expect(positional).toEqual([])
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

/**
 * `;;` ile ayrilmis ifadeler. TEK noktali virgul KULLANILMAZ: `BEGIN ATOMIC
 * SELECT $1; END` ve `$$ ... $$` govdeleri kendi icinde noktali virgul tasir
 * ve tek ayirac onlari ORTASINDAN keserdi (olculdu, "syntax error at end of
 * input" veriyordu).
 */
/** `migrate.ts` icindekinin ayni; parmak izini TESTIN kendisi hesaplar. */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function stmts(ddl: string): string[] {
  return ddl
    .split(';;')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Islem icinde calistirir ve HER ZAMAN geri alir -- sema kirlenmez. */
async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

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
