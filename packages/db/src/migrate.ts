import { createHash } from 'node:crypto'
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
    filename      text PRIMARY KEY,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    checksum_hex  text
  )`

// Defteri, sutunu SONRADAN eklenmis eski bir veritabaninda da onarir. Islemin
// DISINDA, `CREATE_LEDGER` ile ayni gerekceyle.
const ADD_CHECKSUM = `ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_hex text`

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

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
  await pool.query(ADD_CHECKSUM)

  const { rows } = await pool.query<{ filename: string; checksum_hex: string | null }>(
    'SELECT filename, checksum_hex FROM schema_migrations',
  )
  const applied = new Map(rows.map((r) => [r.filename, r.checksum_hex]))

  // UYGULANMIS DOSYALARIN ICERIGI DEGISTI MI? Bu proje migration'lari yerinde
  // duzenlemeyi tercih ediyor (bu semanin henuz uygulanmis bir ornegi yok) ve
  // duzenleme SESSIZ kalirsa, dosyayi bir kez uygulamis olan her veritabani --
  // ornegin bir gozden gecirenin kendi kumesi -- sonraki kosuda hicbir sey
  // yapmadan yesil doner ve semanin ESKI halini tasimaya devam eder. Ozet
  // karsilastirmasi bunu gurultulu bir hataya cevirir.
  for (const filename of list) {
    if (!applied.has(filename)) continue
    const path = isAbsolute(filename) ? filename : join(MIGRATIONS_DIR, filename)
    const current = sha256Hex(await readFile(path, 'utf8'))
    const stored = applied.get(filename) ?? null
    if (stored === null) {
      // Ozet sutunundan ONCE uygulanmis satir. Ne oldugunu BILEMEYIZ; bildigimizi
      // varsaymak daha kotu olurdu. Bugunku icerigi benimseyip yaziya dokuyoruz,
      // boylece BUNDAN SONRAKI her degisiklik yakalanir.
      await pool.query('UPDATE schema_migrations SET checksum_hex = $2 WHERE filename = $1', [
        filename,
        current,
      ])
      continue
    }
    if (stored !== current) {
      throw new Error(
        `runMigrations: ${filename} uygulandiktan SONRA degisti ` +
          `(defter ${stored.slice(0, 12)}..., dosya ${current.slice(0, 12)}...). ` +
          `Bu veritabani semanin eski halini tasiyor; yeniden kurun.`,
      )
    }
  }

  const pending = list.filter((f) => !applied.has(f))
  if (pending.length === 0) return []

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const filename of pending) {
      const path = isAbsolute(filename) ? filename : join(MIGRATIONS_DIR, filename)
      const sql = await readFile(path, 'utf8')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (filename, checksum_hex) VALUES ($1, $2)', [
        filename,
        sha256Hex(sql),
      ])
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
