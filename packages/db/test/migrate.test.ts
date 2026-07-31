import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, migrationFiles, runMigrations } from '../src/migrate'
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

    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM schema_migrations',
    )
    expect(rows[0]?.n).toBe(0)
    // Defter tablosu HAYATTA -- islemin DISINDA olusturuldugu icin. Yukaridaki
    // sorgunun "relation does not exist" ile patlamamasi bunun kanitidir.
    // Ama migration'larin urettigi tablolar YOK OLMALI:
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

      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int n FROM schema_migrations',
      )
      expect(rows[0]?.n).toBe(0)
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

  it('TEMIZ OLMAYAN bir veritabaninda da calisir (test tesadufen bos degil)', async () => {
    // "Bos oldugu icin gecen migration" bu projenin isimlendirdigi ariza
    // kiplerinden biri. Burada semada ALAKASIZ bir tablo varken kosuluyor:
    // gecmesi artik bosluga bagli degil.
    await pool.query('CREATE TABLE unrelated_table (x int PRIMARY KEY)')
    await expect(runMigrations(pool)).resolves.toEqual(EXPECTED)
    await expect(runMigrations(pool)).resolves.toEqual([])
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int n FROM unrelated_table')
    expect(rows[0]?.n).toBe(0)
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
