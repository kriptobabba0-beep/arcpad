import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import type { Queryable } from './pool'

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

/**
 * Uygulanan migration'larin URETTIGI semanin kaydi.
 *
 * NICIN VAR: defter karsilastirmasi DOSYALAR uzerinde tamdi, SEMA uzerinde
 * degil. Olculen sonuc: kusursuz bir defter + `DROP TABLE token_stats` =
 * `ok=true, result=[]`. Bos ve dusurulmus semalar yalnizca TESADUFEN
 * yakalaniyordu -- ilk `CREATE TABLE` 42P07 verdigi icin -- yani bir
 * `CREATE TABLE IF NOT EXISTS` sessizlige bir adim uzaktaydi. C-1'in butun
 * meselesi muhafizin tesadufi bir seye dayanmamasiydi.
 */
const CREATE_STATE = `
  CREATE TABLE IF NOT EXISTS schema_state (
    id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    fingerprint_hex  text NOT NULL CHECK (fingerprint_hex ~ '^[0-9a-f]{64}$'),
    inventory_json   text NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`

/**
 * Semanin karsilastirilabilir tam envanteri: her iliski, her sutun, her kisit,
 * her indeks. Satirlar DAHIL DEGILDIR -- bu yapinin parmak izidir.
 */
export async function schemaInventory(db: Queryable): Promise<string[]> {
  const columns = await db.query<{ line: string }>(`
    SELECT n.nspname || '.' || c.relname || '.' || a.attname || '|' ||
           format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text AS line
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_%'
      AND c.relkind = ANY ('{r,p,v,m,f}')`)
  const constraints = await db.query<{ line: string }>(`
    SELECT conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) AS line
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace`)
  const indexes = await db.query<{ line: string }>(`
    SELECT schemaname || '.' || tablename || '|' || indexname || '|' || indexdef AS line
    FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`)
  return [
    ...columns.rows.map((r) => `col ${r.line}`),
    ...constraints.rows.map((r) => `con ${r.line}`),
    ...indexes.rows.map((r) => `idx ${r.line}`),
  ].sort()
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * DEFTER ILE DISK ARASINDAKI TAM KARSILASTIRMA.
 *
 * Bu, migration'lari YERINDE duzenleme kararinin bedelidir; o karari mesru
 * kilan tek sey duzenlemenin GORULEBILIR olmasidir. Ilk hali yalnizca
 * "degismis" dosyayi ariyordu ve uc kacis birakiyordu; ucu de olculdu:
 *
 *   - SILINMIS bir dosya hic bakilmadigi icin sessiz kaliyordu;
 *   - ARAYA EKLENMIS bir dosya sirasiz uygulaniyordu;
 *   - ve en kotusu, `checksum_hex` sutunu NULL olan bir defter "benimseniyor"
 *     ve BUGUNKU ozetler eski govdelerin uzerine yaziliyordu. `6295651`
 *     tarafindan kurulmus HER veritabaninin defteri boyledir, yani muhafizin
 *     kendi gerekcesi olarak gosterilen durum tam da gecirdigi durumdu:
 *     `last_block_hash` yok, `name_hex` yok, sistem-adresi CHECK'leri yok,
 *     `raw jsonb` duruyor -- ve `ok=true, result=[]`. Sapma o andan sonra bir
 *     daha ASLA fark edilemezdi.
 *
 * KURAL: BILINMEYEN BIR DURUM SERT DURUSTUR, BENIMSEME DEGIL. Reddetmenin
 * bedeli, uretimde hicbir ornegi olmayan bir semada bir `dropdb`; benimsemenin
 * bedeli, bir daha tespit edilemeyecek sessizce ayrik bir veritabani. Eski
 * yorum "varsaymak daha kotu olurdu" diyip tam da varsayiyordu.
 *
 * @param applied defterdeki (dosya adi -> ozet) esleme; ozet NULL olabilir.
 * @param list    diskteki (ya da enjekte edilmis) sirali dosya listesi.
 * @param onDisk  o listedeki OKUNABILEN dosyalarin ozetleri.
 */
export function ledgerProblems(
  applied: ReadonlyMap<string, string | null>,
  list: readonly string[],
  onDisk: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = []
  const known = new Set(list)

  for (const [filename, stored] of [...applied].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (stored === null) {
      problems.push(
        `${filename}: defterde ozet YOK (ozet sutunundan onceki bir kosudan kalma). ` +
          `Hangi govdenin uygulandigi bilinemez.`,
      )
      continue
    }
    if (!known.has(filename)) {
      problems.push(
        `${filename}: UYGULANMIS ama diskte yok (silinmis ya da yeniden adlandirilmis).`,
      )
      continue
    }
    const current = onDisk.get(filename)
    if (current === undefined) {
      problems.push(`${filename}: UYGULANMIS ama dosya okunamiyor.`)
      continue
    }
    if (current !== stored) {
      problems.push(
        `${filename}: uygulandiktan SONRA degismis ` +
          `(defter ${stored.slice(0, 12)}..., dosya ${current.slice(0, 12)}...).`,
      )
    }
  }

  // ARAYA EKLEME. Uygulanmis en son dosyadan ONCE siralanan bekleyen bir dosya,
  // sirasiz uygulanirdi -- yani sema, dosyalarin adiyla ima ettigi sirada
  // kurulmamis olurdu. Sona EKLEMEK (`007_...`) mesrudur ve buradan gecer.
  const lastApplied = [...applied.keys()].sort().at(-1)
  if (lastApplied !== undefined) {
    for (const filename of list) {
      if (applied.has(filename)) continue
      if (filename < lastApplied) {
        problems.push(
          `${filename}: uygulanmamis, ama uygulanmis olan ${lastApplied} dosyasindan ONCE ` +
            `siralaniyor (araya ekleme).`,
        )
      }
    }
  }

  return problems
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
 * 2. Bekleyen dosyalar SIRAYLA okunup HEMEN uygulanir. Var olmayan bir dosya
 *    BEGIN'den once patlasaydi, `schema_migrations`'in bos kalmasi geri almayi
 *    degil hicbir seyin denenmemis olmasini gosterirdi -- test yazilmamis bir
 *    gerekce yuzunden gecerdi. Boyle, altinci dosyada patlayan bir kosu ONCEKI
 *    BESINI GERI ALMAK zorundadir ve testin olctugu sey budur.
 *
 * 3. Defter/disk karsilastirmasi TAMDIR ve HER SEYDEN ONCE yapilir; bkz.
 *    `ledgerProblems`. Uyusmazlik varsa hicbir DDL calismaz.
 */
export async function runMigrations(pool: Pool, files?: string[]): Promise<string[]> {
  const list = files ?? (await migrationFiles())

  await pool.query(CREATE_LEDGER)
  await pool.query(ADD_CHECKSUM)
  await pool.query(CREATE_STATE)

  const { rows } = await pool.query<{ filename: string; checksum_hex: string | null }>(
    'SELECT filename, checksum_hex FROM schema_migrations',
  )
  const applied = new Map(rows.map((r) => [r.filename, r.checksum_hex]))

  // Diskteki icerikler. HERHANGI BIR DDL'DEN ONCE okunur, cunku asagidaki
  // karsilastirma da her seyden once yapilmali.
  const onDisk = new Map<string, string>()
  for (const filename of list) {
    const path = isAbsolute(filename) ? filename : join(MIGRATIONS_DIR, filename)
    // Var olmayan bir dosya BURADA patlamaz: `pending` dongusu onu islemin
    // ICINDE okur ve boylece geri alma gercek bir geri alma olur.
    try {
      onDisk.set(filename, sha256Hex(await readFile(path, 'utf8')))
    } catch {
      /* islemin icinde ele alinir */
    }
  }

  const problems = ledgerProblems(applied, list, onDisk)

  // SEMANIN KENDISI DEFTERE UYUYOR MU? Dosyalar uzerindeki karsilastirma
  // tamdi, sema uzerindeki degildi.
  if (applied.size > 0) {
    const { rows: stateRows } = await pool.query<{
      fingerprint_hex: string
      inventory_json: string
    }>('SELECT fingerprint_hex, inventory_json FROM schema_state WHERE id = 1')
    const state = stateRows[0]
    const current = await schemaInventory(pool)
    const currentHex = sha256Hex(current.join('\n'))
    if (state === undefined) {
      problems.push(
        `sema parmak izi YOK ama defterde ${applied.size} uygulanmis migration var ` +
          `(parmak izi sutunundan onceki bir kosudan kalma). Semanin defterle ` +
          `ayni sey olup olmadigi bilinemez.`,
      )
    } else if (state.fingerprint_hex !== currentHex) {
      const before = new Set(JSON.parse(state.inventory_json) as string[])
      const after = new Set(current)
      const missing = [...before].filter((x) => !after.has(x)).sort()
      const extra = [...after].filter((x) => !before.has(x)).sort()
      const show = (xs: string[]) =>
        xs.length <= 8 ? xs.join('; ') : `${xs.slice(0, 8).join('; ')} ... (+${xs.length - 8})`
      problems.push(
        `sema, migration'larin urettiginden FARKLI. ` +
          (missing.length > 0 ? `EKSIK: ${show(missing)}. ` : '') +
          (extra.length > 0 ? `FAZLA: ${show(extra)}. ` : ''),
      )
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `runMigrations: defter ile diskteki migration'lar UYUSMUYOR.\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nBu veritabani semanin hangi halini tasidigi BILINMEYEN bir durumda. ` +
        `Bu sema henuz hicbir yerde uretimde degil; dogru cozum onu yeniden kurmaktir ` +
        `(dropdb/createdb ya da DROP SCHEMA public CASCADE; CREATE SCHEMA public).`,
    )
  }

  const pending = list.filter((f) => !applied.has(f))
  if (pending.length === 0) {
    // Defter dolu ama parmak izi henuz yoksa (bu surumun ilk kosusu), semayi
    // OLDUGU GIBI kaydet. Bu bir "benimseme" DEGILDIR: yukaridaki kontrol
    // parmak izi eksikken zaten HATA verir, yani buraya ancak `applied` bos
    // oldugunda -- yani kaydedilecek bir sema olmadiginda -- gelinir.
    return []
  }

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
    // Parmak izi ISLEMIN ICINDE yazilir: migration'lar uygulandi ama kayit
    // yazilamadi diye bir ara durum olmamali.
    const inventory = await schemaInventory(client)
    await client.query(
      `INSERT INTO schema_state (id, fingerprint_hex, inventory_json, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET fingerprint_hex = EXCLUDED.fingerprint_hex,
             inventory_json = EXCLUDED.inventory_json,
             updated_at = now()`,
      [sha256Hex(inventory.join('\n')), JSON.stringify(inventory)],
    )
    await client.query('COMMIT')
    return pending
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
