import type { Pool } from '@arcpad/db'
import { createPool, putDeployment, runMigrations } from '@arcpad/db'
import type { Deployment } from '@arcpad/db'
import type { Address } from 'viem'

/**
 * `DATABASE_URL` YOKSA BU DOSYA ATLAMAZ, COKER.
 *
 * `packages/db/test/setup.ts`'in ayni kararini bu paket icin tekrar ediyor ve
 * gerekce de ayni: atlayan bir veritabani testi YESIL gorunur ve hicbir sey
 * ispatlamaz. Indexer'in exactly-once iddiasi -- `holders.balance_tok` bir
 * DELTA'dir ve ikinci kez uygulanmasini engelleyen tek sey defter satirinin
 * GERCEKTEN eklenmis olmasidir -- gercek bir sunucu olmadan ISPATLANMAZ.
 *
 * Bu dosya YALNIZCA veritabanina dokunan test dosyalarindan ithal edilir, bir
 * `setupFiles` girisi DEGILDIR: `logs.test.ts` ve `cursor.test.ts` veritabani
 * istemez ve onlari da coketirmek gereksiz olurdu.
 */
const url = process.env['DATABASE_URL']
if (!url) {
  throw new Error(
    [
      '@arcpad/indexer veritabani testleri GERCEK bir Postgres ister ve DATABASE_URL ayarli degil.',
      'Bu test ATLANMAZ, cunku atlayan bir veritabani testi yesil gorunur.',
      '',
      'Ornek:',
      '  DATABASE_URL=postgres://arcpad:arcpad@127.0.0.1:5432/arcpad pnpm --filter @arcpad/indexer test',
    ].join('\n'),
  )
}

export const pool: Pool = createPool(url)

export async function resetSchema(): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await runMigrations(pool)
}

/**
 * CANLI Arc smoke dagitimi. Adresler makbuzlardan, egri parametreleri
 * `contracts/deploy/profiles.toml`'un `testnet` profilinden -- ikisi de
 * olculmus, hicbiri uydurulmus degil.
 */
export const LIVE_DEPLOYMENT: Deployment = {
  chainId: 5_042_002n,
  factory: '0x0d75a4ffb8cd6db4237557e9519591b94d6ab439' as Address,
  escrow: '0xeed4431ead3e27f16d97f677a9c4c1a963df8dc6' as Address,
  // ZINCIRDEN OKUNDU (canli, 2026-08-02: `factory.protocolTreasury()`).
  // ONCEKI DEGER YANLISTI -- buraya creator'in adresi yazilmisti ve hicbir
  // birim testi bunu goremezdi, cunku hicbiri zincire sormuyordu. Canli test
  // ilk kosusunda `DeploymentMismatch` ile patladi.
  protocolTreasury: '0xebbecfda308ea307e173c6ec19a9c48f53d4b10c' as Address,
  virtualTokenReservesTok: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReservesWei: 4_292n * 10n ** 15n,
  saleSupplyTok: 793_100_000n * 10n ** 18n,
  totalSupplyTok: 10n ** 27n,
  startBlock: 54_661_437n,
}

export async function seedDeployment(deployment: Deployment = LIVE_DEPLOYMENT): Promise<void> {
  await putDeployment(pool, deployment)
}
