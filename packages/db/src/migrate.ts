import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

/** `packages/db/migrations` -- kaynak dosyaya GORE, calisma dizinine gore degil. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** Diskteki migration dosyalarinin ada gore sirali listesi. */
export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  return entries.filter((f) => f.endsWith('.sql')).sort()
}

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`

/**
 * `migrations/*.sql` dosyalarini ada gore sirali, TEK BIR ISLEM icinde
 * uygular ve `schema_migrations`'a yazar. Uygulanan dosya adlarini doner;
 * hicbir sey uygulanmadiysa bos dizi.
 *
 * @param files YALNIZCA TEST ENJEKSIYONU ICIN. Verilirse diskteki liste yerine
 *   bu kullanilir; ogeler `MIGRATIONS_DIR`'e gore cozulur.
 *
 * IKI TASARIM KARARI VE GEREKCELERI:
 *
 * 1. `schema_migrations` ISLEMIN DISINDA olusturulur. Icinde olusturulsaydi,
 *    bir migration patladiginda geri alma tablonun KENDISINI de silerdi ve
 *    "hicbiri uygulanmadi" iddiasi dogrulanamaz olurdu -- `SELECT count(*)`
 *    "relation does not exist" ile patlardi, yani testin gectigi sey baska bir
 *    sey olurdu.
 *
 * 2. Her dosya SIRAYLA okunur ve HEMEN uygulanir; liste bastan topluca
 *    okunmaz. Toplu okumak, "eksik dosya" arizasini BEGIN'den once patlatirdi
 *    ve o zaman `schema_migrations`'in bos kalmasi geri almayi degil, hicbir
 *    seyin denenmemis olmasini gosterirdi -- yani test yazilmamis bir gerekce
 *    yuzunden gecerdi. Boyle, altinci dosyada patlayan bir kosu ONCEKI BESINI
 *    GERI ALMAK zorundadir ve testin olctugu sey budur.
 */
export async function runMigrations(pool: Pool, files?: string[]): Promise<string[]> {
  const list = files ?? (await migrationFiles())

  await pool.query(CREATE_LEDGER)

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')
  const already = new Set(rows.map((r) => r.filename))
  const pending = list.filter((f) => !already.has(f))
  if (pending.length === 0) return []

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const filename of pending) {
      const path = isAbsolute(filename) ? filename : join(MIGRATIONS_DIR, filename)
      const sql = await readFile(path, 'utf8')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename])
    }
    await client.query('COMMIT')
    return pending
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
