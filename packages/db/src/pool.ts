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
  const pool = new pg.Pool({ connectionString: url })

  /*
   * ==========================================================================
   *  BOSTAKI BIR ISTEMCININ HATASI SURECI OLDURMEZ -- VE ONCEDEN OLDURUYORDU.
   * ==========================================================================
   *
   * `pg` bunu belgesinde SART kosuyor: havuzdaki bir istemci BOSTAYKEN hata
   * alirsa `Pool` bir `'error'` olayi yayar, ve Node'da dinleyicisi olmayan
   * bir `'error'` olayi YAKALANMAMIS ISTISNADIR -- surec aninda olur. Hicbir
   * `try/catch` bunu goremez, cunku hata bir cagrinin icinden degil, ISLEM
   * YOKKEN gelir.
   *
   * URETIMDE OLCULDU (2026-08-11 06:35 UTC): Postgres'in rutin bir yeniden
   * baslatmasi (gece otomatik guvenlik guncellemesi) butun baglantilari
   * kopardi --
   *
   *     error: terminating connection due to administrator command
   *     Unhandled 'error' event ... on BoundPool instance
   *
   * -- ve indexer bes kez cokup yeniden basladi. Bir veritabani yeniden
   * baslatmasi RUTIN bir olaydir; ona uygulama katmaninin olumle cevap
   * vermesi bir arizadir.
   *
   * DOGRU DAVRANIS SURDURMEKTIR, KAPATMAK DEGIL. `Pool` bozuk istemciyi
   * kendisi atar ve bir sonraki sorguda yenisini acar; yapilmasi gereken tek
   * sey olayi DUYMAK ve gorunur kilmak. Sorgunun kendisi zaten hata verir ve
   * cagiran taraf onu kendi yolunda ele alir (indexer'in `isTransient`i bunu
   * gecici sayar ve yeniden dener).
   *
   * BU SATIR HER TUKETICIYE AYNI ANDA GECERLIDIR -- indexer, keeper'lar ve web
   * hepsi buradan havuz aliyor. Her birinde ayri ayri hatirlanmasi gereken bir
   * sey olsaydi, biri unutulurdu.
   */
  pool.on('error', (error) => {
    // Tek satir, sebebiyle. Her boşta kalan istemci icin ayri bir yigin izi
    // basmak, gercek bir kesintide loglari kullanilmaz hale getirir.
    console.error(`[db] idle client error (the pool will replace it): ${error.message}`)
  })

  return pool
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
