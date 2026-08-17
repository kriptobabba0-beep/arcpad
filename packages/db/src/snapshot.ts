import type { Queryable } from './pool'

/**
 * Her tablonun BIRINCIL ANAHTARA GORE SIRALI dokumu.
 *
 * TEST ALTYAPISI DEGIL URUN KODUDUR ve `packages/db`'de durur, cunku bu
 * paketin butun idempotency iddialari buna dayanir: "ayni araligi iki kez
 * oynatmak ikinci seferde hicbir sey yapmaz" cumlesi ancak IKI DOKUMUN
 * ESITLIGIYLE ispatlanabilir. Birincil anahtar sirasi, esitligin satir
 * sirasindan bagimsiz olmasini saglar.
 *
 * Tablo listesi KATALOGDAN gelir, elle yazilmis bir listeden degil: yeni bir
 * migration yeni bir tablo ekledigi anda dokum onu KENDILIGINDEN kapsar. Elle
 * yazilmis bir liste, "bir tabloda test edilen kisit hepsinde test edilmis
 * gibi okunur" arizasinin tam olarak dokum tarafindaki karsiligi olurdu.
 */
export async function snapshot(db: Queryable): Promise<Record<string, unknown[]>> {
  const { rows: tables } = await db.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`)

  const out: Record<string, unknown[]> = {}
  for (const { table_name } of tables) {
    const { rows: keys } = await db.query<{ column_name: string }>(
      `
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ('public.' || quote_ident($1))::regclass AND i.indisprimary
      ORDER BY a.attname`,
      [table_name],
    )
    // Birincil anahtari olmayan bir tablo bu semada YOKTUR; olsaydi sirasi
    // belirsiz olurdu ve dokum karsilastirmasi yaniltici olurdu. Sessizce
    // butun sutunlara gore siralamak yerine GURULTULU patlar.
    if (keys.length === 0) {
      throw new Error(`snapshot: ${table_name} tablosunun birincil anahtari yok`)
    }
    const order = keys.map((k) => `"${k.column_name}"`).join(', ')
    const { rows } = await db.query(`SELECT * FROM "${table_name}" ORDER BY ${order}`)
    out[table_name] = rows
  }
  return out
}
