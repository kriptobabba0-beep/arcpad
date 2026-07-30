import { afterAll, beforeAll } from 'vitest'
import type { Pool } from '../src/pool'
import { createPool } from '../src/pool'
import { runMigrations } from '../src/migrate'

/**
 * `DATABASE_URL` YOKSA BU PAKET ATLAMAZ, COKER.
 *
 * Gerekce: atlayan bir test YESIL gorunur. Faz 0'in devir listesi (satir
 * 41-42) ayni ariza kipini `continue-on-error` uzerinden zaten kaydetti --
 * "hicbir CI is akisi henuz calismadi, kapilarin degeri sifir". Bir veritabani
 * testinin veritabani olmadan yesil olmasi ayni siniftir ve bu paketin
 * ISPATLADIGI her sey (idempotency, exactly-once, adlandirma kapisi) gercek
 * bir sunucu olmadan ISPATLANMAZ.
 *
 * Mesaj kasitli olarak calisan komutu iceriyor: bir gelistiricinin bunu
 * "atlanabilir bir test" sanmasindansa hemen calistirabilmesi daha iyidir.
 */
const url = process.env['DATABASE_URL']
if (!url) {
  throw new Error(
    [
      '@arcpad/db testleri GERCEK bir Postgres ister ve DATABASE_URL ayarli degil.',
      'Bu test ATLANMAZ, cunku atlayan bir veritabani testi yesil gorunur ve',
      'hicbir sey ispatlamaz.',
      '',
      'Ornek:',
      '  DATABASE_URL=postgres://arcpad:arcpad@127.0.0.1:5432/arcpad pnpm --filter @arcpad/db test',
    ].join('\n'),
  )
}

export const pool: Pool = createPool(url)

/**
 * HER TEST DOSYASINDAN once semayi sifirdan kurar. `setupFiles` her dosya icin
 * yeniden calistigi icin bu `beforeAll` dosya basina bir kez calisir.
 *
 * `DROP SCHEMA public CASCADE` -- bir onceki dosyadan kalan tablolar ya da
 * satirlar olmadigini GARANTI eder. Bunun olmadigi bir kurulumda
 * "migration'lar temiz bir veritabaninda calisiyor" testi, veritabaninin
 * TESADUFEN bos olmasi yuzunden gecerdi.
 */
export async function dropSchema(): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE')
  await pool.query('CREATE SCHEMA public')
}

/** Bos semadan tam migration'a. `migrate.test.ts` bunu kendi icinde tekrarlar. */
export async function resetSchema(): Promise<void> {
  await dropSchema()
  await runMigrations(pool)
}

beforeAll(resetSchema)

afterAll(async () => {
  await pool.end()
})
