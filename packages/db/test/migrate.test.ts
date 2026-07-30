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
