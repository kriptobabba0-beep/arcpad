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
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename      text PRIMARY KEY,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    checksum_hex  text
  )`

// Defteri, sutunu SONRADAN eklenmis eski bir veritabaninda da onarir. Defter
// zaten varsa okumadan ONCE, yoksa olusturmayla birlikte calisir.
const ADD_CHECKSUM = `ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum_hex text`

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
  CREATE TABLE IF NOT EXISTS public.schema_state (
    id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    fingerprint_hex  text NOT NULL CHECK (fingerprint_hex ~ '^[0-9a-f]{64}$'),
    inventory_json   text NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`

const NON_SYSTEM_SCHEMA = `
  n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`

/**
 * Semanin karsilastirilabilir envanteri. Satirlar DAHIL DEGILDIR -- bu, YAPININ
 * parmak izidir.
 *
 * KAPSAM ACIKCA YAZILI, cunku bir onceki hali kapsamini IDDIA ediyordu ve
 * hicbir test onu OLCMUYORDU. Gozden geciren bu fonksiyonun bes ayri
 * mutasyonunu -- kisitlari dusurmek, indeksleri dusurmek, `attnotnull`i
 * dusurmek, SUTUN TIPINI dusurmek -- uyguladi ve BESI DE `migrate.test.ts`in
 * 22 testinin TAMAMINDAN sagsalim gecti. Yani "failure mode 4"un (erisimi
 * olculmemis ozellik) dorduncu kez, ve tam da onu kapatmak icin yazilmis
 * kodun ICINDE tekrarlanmasiydi. Artik her alan icin bir test var: o alani
 * envanterden cikarmak en az bir testi OLDURUR.
 *
 * ICERIR (deger DEGISTIREBILEN her sey):
 *   col  sutun: sema.tablo.sutun | tip(+typmod) | NOT NULL | uretim ifadesi
 *   def  DEFAULT ve GENERATED ifadeleri
 *   con  kisitlar (CHECK / FK / UNIQUE / PK), tanimiyla
 *   idx  indeksler, tanimiyla
 *   trg  TETIKLEYICILER, tanimiyla
 *   fun  FONKSIYONLAR, govdesinin ozetiyle
 *
 * ICERMEZ, ve bu bir SINIRDIR, kusur degil:
 *   GRANT/REVOKE ve RLS politikalari -- kimin GORDUGUNU degistirir, degerin
 *   NE OLDUGUNU degil; tehdit modeli farklidir ve bu muhafiz deger butunlugu
 *   icindir. Collation ve extension surumleri -- siralamayi etkiler,
 *   saklanan degeri degil. Event trigger'lar -- veritabani genelidir, sema
 *   nesnesi degil.
 *
 * TETIKLEYICILER NEDEN ICERIDE: `BEFORE INSERT ... quote_amount_wei / 1e12`
 * yapan bir tetikleyici, hem adlandirma kapisina hem de eski parmak izine
 * TAMAMEN gorunmezdi -- yani bu paketin var olma sebebi olan 1e12 hatasi, iki
 * savunmanin da bakmadigi tek kapidan girebiliyordu. Fonksiyonlar ayni
 * gerekceyle iceride: tetikleyici govdesi bir fonksiyondur.
 *
 * `regclass` KULLANILMAZ: `conrelid::regclass::text` `search_path`e baglidir ve
 * ayni sema farkli bir ozet uretebilirdi (olculdu: 235 satirin 88'i degisiyor).
 * Yanlis bir SERT DURUS, kacirandan daha kotudur -- basilan cozum `dropdb`.
 */
export async function schemaInventory(db: Queryable): Promise<string[]> {
  // SEARCH_PATH SABITLENIR. Kendi birlestirmelerimizi sema-nitelemek YETMEDI:
  // `pg_get_constraintdef`, `pg_get_expr`, `indexdef` ve `pg_get_triggerdef`in
  // KENDI ciktilari da `search_path`e gore degisir (`text` mi
  // `pg_catalog.text` mi). Olculdu: `SET search_path TO ''` ile 251 satirin
  // buyuk kismi degisiyordu. Cagiran bir islem icinde oldugu icin `SET LOCAL`
  // yalnizca o islemi etkiler ve havuzu KIRLETMEZ -- `pg` `release()`te oturum
  // durumunu sifirlamadigi icin bu ayrim onemli.
  await db.query(`SET LOCAL search_path = pg_catalog, public`)
  const columns = await db.query<{ line: string }>(`
    SELECT n.nspname || '.' || c.relname || '.' || a.attname || '|' ||
           format_type(a.atttypid, a.atttypmod) || '|' ||
           a.attnotnull::text || '|' || COALESCE(a.attgenerated::text, '') AS line
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE ${NON_SYSTEM_SCHEMA} AND c.relkind = ANY ('{r,p,v,m,f}')`)
  const defaults = await db.query<{ line: string }>(`
    SELECT n.nspname || '.' || c.relname || '.' || a.attname || '|' ||
           pg_get_expr(d.adbin, d.adrelid) AS line
    FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE ${NON_SYSTEM_SCHEMA}`)
  const constraints = await db.query<{ line: string }>(`
    SELECT n.nspname || '.' || c.relname || '|' || k.conname || '|' ||
           pg_get_constraintdef(k.oid) AS line
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${NON_SYSTEM_SCHEMA}`)
  const indexes = await db.query<{ line: string }>(`
    SELECT schemaname || '.' || tablename || '|' || indexname || '|' || indexdef AS line
    FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      AND schemaname NOT LIKE 'pg\\_%'`)
  const triggers = await db.query<{ line: string }>(`
    SELECT n.nspname || '.' || c.relname || '|' || t.tgname || '|' ||
           pg_get_triggerdef(t.oid) AS line
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${NON_SYSTEM_SCHEMA} AND NOT t.tgisinternal`)
  const functions = await db.query<{ line: string }>(`
    SELECT n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')|' ||
           md5(COALESCE(p.prosrc, '')) || '|' || p.provolatile::text AS line
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE ${NON_SYSTEM_SCHEMA}`)
  return [
    ...columns.rows.map((r) => `col ${r.line}`),
    ...defaults.rows.map((r) => `def ${r.line}`),
    ...constraints.rows.map((r) => `con ${r.line}`),
    ...indexes.rows.map((r) => `idx ${r.line}`),
    ...triggers.rows.map((r) => `trg ${r.line}`),
    ...functions.rows.map((r) => `fun ${r.line}`),
  ].sort()
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Envanteri kendi islemi icinde okur (bkz. `schemaInventory`'nin SET LOCAL'i). */
export async function readInventory(pool: Pool): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    return await schemaInventory(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

/** Var mi? DDL calistirmadan sorar. */
async function relationExists(db: Queryable, name: string): Promise<boolean> {
  const { rows } = await db.query<{ oid: string | null }>(
    `SELECT to_regclass('public.' || quote_ident($1))::text AS oid`,
    [name],
  )
  return rows[0]?.oid != null
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
 * 1. `schema_migrations` ve `schema_state` ISLEMIN ICINDE olusturulur ve
 *    varliklari `to_regclass` ile SORULUR. Onceki hali onlari en basta
 *    `CREATE TABLE IF NOT EXISTS` ile kuruyordu, yani REDDEDILEN bir kosu bile
 *    arkasinda tablo birakiyordu -- "hicbir DDL calismaz" sozu harfiyen dogru
 *    degildi. Simdi basarisiz bir ILK kosudan geriye hicbir sey kalmaz, ki bu
 *    "defter var ama bos"tan daha guclu bir ifadedir.
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

  // AYNI ANDA IKI KOSU. Kilit olmadan iki surec ayni migration'i uygulamaya
  // calisiyor ve ikincisi `pg_type_typname_nsp_index` ihlali gibi ham bir
  // hatayla oluyordu -- okuyana hicbir sey anlatmayan bir mesaj.
  await pool.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
  try {
    return await runLocked(pool, list)
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
  }
}

/** `@arcpad/db` migration kilidi; sabit ve keyfi. */
const ADVISORY_LOCK_KEY = '7723941155003001'

async function runLocked(pool: Pool, list: string[]): Promise<string[]> {
  // HICBIR DDL, KARSILASTIRMADAN ONCE CALISMAZ. Onceki hali defter ve durum
  // tablolarini bastan `CREATE TABLE IF NOT EXISTS` ile kuruyordu, yani sert
  // durusla biten bir kosu bile arkasinda tablo birakiyordu. Varlik `to_regclass`
  // ile SORULUYOR; olusturma, gercekten yazacagimiz ana ertelendi.
  const ledgerExists = await relationExists(pool, 'schema_migrations')
  const applied = new Map<string, string | null>()
  if (ledgerExists) {
    await pool.query(ADD_CHECKSUM)
    const { rows } = await pool.query<{ filename: string; checksum_hex: string | null }>(
      'SELECT filename, checksum_hex FROM public.schema_migrations',
    )
    for (const r of rows) applied.set(r.filename, r.checksum_hex)
  }

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

  // Envanter KENDI ISLEMINDE okunur: `SET LOCAL search_path` ancak bir islem
  // icinde etkilidir, ve islem havuzdaki baglantiyi kalici olarak
  // degistirmemeyi garanti eder.
  const current = await readInventory(pool)

  // BOS DEFTER, DOLU SEMA. Kontrol `applied.size > 0` ile korunuyordu, yani
  // defter bosken HIC calismiyordu. Olculen sonuc: bos defter + dusurulmus
  // `creator_history` + catismayan bir bekleyen dosya = `ok=true`, tablo hala
  // yok, VE parmak izi uzerine yazilarak sapma yeniden kutsanmis oluyordu.
  // C-1'in sekli, C-1'in duzeltmesinin icinde. Ayni hukum: BILINMEYEN DURUM
  // SERT DURUSTUR.
  //
  // Bos bir defter yalnizca BOS bir semayla tutarlidir. Kendi defter/durum
  // tablolarimiz sayilmaz -- onlari biz kuruyoruz.
  if (applied.size === 0) {
    const OURS = new Set(['schema_migrations', 'schema_state'])
    const strays = [
      ...new Set(
        current
          .filter((l) => l.startsWith('col '))
          .map((l) => l.slice(4).split('|')[0]!.split('.').slice(0, 2).join('.'))
          .filter((rel) => !OURS.has(rel.replace(/^public\./, ''))),
      ),
    ].sort()
    if (strays.length > 0) {
      problems.push(
        `defter BOS ama sema bos DEGIL (${strays.slice(0, 8).join(', ')}` +
          `${strays.length > 8 ? ` ... (+${strays.length - 8})` : ''}). ` +
          `Bu iliskilerin nereden geldigi bilinemez.`,
      )
    }
  }

  // SEMANIN KENDISI DEFTERE UYUYOR MU? Dosyalar uzerindeki karsilastirma
  // tamdi, sema uzerindeki degildi.
  if (applied.size > 0) {
    const stateExists = await relationExists(pool, 'schema_state')
    const { rows: stateRows } = stateExists
      ? await pool.query<{ fingerprint_hex: string; inventory_json: string }>(
          'SELECT fingerprint_hex, inventory_json FROM public.schema_state WHERE id = 1',
        )
      : { rows: [] as { fingerprint_hex: string; inventory_json: string }[] }
    const state = stateRows[0]
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
  // Buraya STABIL DURUMDA da gelinir (alti dosya uygulanmis, bekleyen yok) --
  // onceki yorum "yalnizca `applied` bos oldugunda" diyordu ve BU YANLISTI.
  // Yapilacak bir sey yok: butun kontroller yukarida gecti.
  if (pending.length === 0) return []

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Migration govdeleri niteliksiz ad kullanir; `search_path` bozuksa
    // uygulama deterministik olmaz. Islem boyunca sabitleniyor.
    await client.query('SET LOCAL search_path = public, pg_catalog')
    // Defter ve durum tablolari ANCAK BURADA olusur: bir sert durus artik
    // arkasinda hicbir sey birakmaz.
    await client.query(CREATE_LEDGER)
    await client.query(ADD_CHECKSUM)
    await client.query(CREATE_STATE)
    for (const filename of pending) {
      const path = isAbsolute(filename) ? filename : join(MIGRATIONS_DIR, filename)
      const sql = await readFile(path, 'utf8')
      await client.query(sql)
      await client.query(
        'INSERT INTO public.schema_migrations (filename, checksum_hex) VALUES ($1, $2)',
        [filename, sha256Hex(sql)],
      )
    }
    // Parmak izi ISLEMIN ICINDE yazilir: migration'lar uygulandi ama kayit
    // yazilamadi diye bir ara durum olmamali.
    const inventory = await schemaInventory(client)
    await client.query(
      `INSERT INTO public.schema_state (id, fingerprint_hex, inventory_json, updated_at)
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
