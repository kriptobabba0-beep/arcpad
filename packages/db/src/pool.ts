import pg from 'pg'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

/**
 * `pg`'nin `Pool` ve `PoolClient`'inin ORTAK yuzeyi. Fonksiyonlar bunu ister,
 * `Pool`'u degil: boylece ayni cagri hem havuzdan hem ACIK BIR ISLEMIN
 * icinden yapilabilir. `putDeployment(tx, ...)` gibi imzalarin anlami budur.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>
}

/**
 * DEGERLERIN TIPI:
 *
 * node-postgres varsayilan olarak `bigint` (OID 20) ve `numeric` (OID 1700)
 * degerlerini STRING dondurur ve BU BILEREK BOYLE BIRAKILMISTIR. Ikisini de
 * JS `number`'a cevirmek 2^53'un ustunde sessizce hassasiyet kaybeder --
 * `total_supply_tok = 1e27` bunun cok otesindedir, ve bir `event_seq` de
 * 2^53'u blok 8.589.934.592'de asar. Global bir `pg.types.setTypeParser`
 * cagrisi bu paketin HER iddiasini sessizce yanlislar; `test/pool.test.ts`
 * bunu calistirarak sabitler.
 */
export function createPool(url: string): Pool {
  return new pg.Pool({ connectionString: url })
}

export type { Pool, PoolClient }

/** `fn`'i tek bir islemde kosturur; hata halinde geri alir. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
