import { env as processEnv, exit } from 'node:process'
import { createPool, listOrders, placeOrder } from '@arcpad/db'
import type { Address } from '@arcpad/db'

/**
 * ============ EMIR GECISININ CANLI SURUCUSU ============
 *
 * `DATABASE_URL=... npx tsx keeper/test/localchain/ordersLiveDriver.ts`
 *
 * NE ICIN VAR. Birim testleri gecisi SENTETIK bir okuyucuya karsi olcuyor. Bu
 * betik onu **canli Arc testnet'e ve gercek bir Postgres'e** karsi kosturur ve
 * bu deponun ogrendigi seyi kapatir: bir mekanizmanin yazilmis olmasi, bir
 * GIRIS NOKTASINDAN ULASILABILIR oldugunu soylemez (bkz. `ed5985b` -- keeper'in
 * graduation mekanizmasi izinsizdi, yazilmisti, ve HICBIR SEY onu cagirmiyordu).
 *
 * NE YAYINLAR: HICBIR SEY. Bu surec bir anahtar tasimaz, bir islem gondermez.
 * Yaptigi tek zincir islemi `eth_call`dir. Kullanilan curve, AGENT-CONTEXT'in
 * "acik tutun" dedigi e2e curve'udur ve ona YAZILMAZ.
 *
 * NE TOHUMLAR: uc emir, ucu de gercek e2e token'i uzerine --
 *   1. kucuk bir `minOut` ile bir alim  -> TETIKLENMELI
 *   2. sacma buyuk bir `minOut` ile bir alim -> TETIKLENMEMELI (`notYet`)
 *   3. suresi GECMIS bir alim -> `expired`
 * Ucuncusu tasiyicidir: sure asimi ZINCIRIN saatine gore yapiliyor, sunucunun
 * saatine gore degil, ve ikisi ayrisabilir.
 */

const TOKEN = '0x637af6afd61bb182c5843895d1e8e6fb5f56199a' as Address
const CURVE = '0x53bba88f1b9897a8b61c860e9e7413ca1a1644c9' as Address
/** Canli deployer -- 74 USDC tasiyor, yani bir alim emrinin FONU VAR. */
const OWNER = '0xe92c64c4f36216ea773f2622f6d5f8530ae92fd2' as Address

async function main(): Promise<number> {
  const url = processEnv['DATABASE_URL']
  if (url === undefined) throw new Error('DATABASE_URL is required')
  const pool = createPool(url)
  try {
    // `launches` satiri ELLE konur: indexer bu kosuda calismiyor ve emirlerin
    // yabanci anahtari onu istiyor. Degerler CANLI zincirin degerleridir.
    await pool.query(
      `INSERT INTO launches
         (token, curve, launch_creator, name, symbol, uri,
          name_hex, symbol_hex, uri_hex, salt, created_seq, created_at, tx_hash)
       VALUES ($1, $2, $3, 'e2e open', 'E2EOPEN', 'ipfs://e2e',
               $4, $5, $6, $7, 1, now(), $8)
       ON CONFLICT (token) DO NOTHING`,
      [
        TOKEN,
        CURVE,
        OWNER,
        `0x${Buffer.from('e2e open', 'utf8').toString('hex')}`,
        `0x${Buffer.from('E2EOPEN', 'utf8').toString('hex')}`,
        `0x${Buffer.from('ipfs://e2e', 'utf8').toString('hex')}`,
        `0x${'01'.repeat(32)}`,
        `0x${'02'.repeat(32)}`,
      ],
    )

    const nonce = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
    const seeds = [
      {
        label: 'SHOULD TRIGGER  (0.001 USDC, minOut 1 wei of token)',
        amount: 10n ** 15n,
        minOut: 1n,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        label: 'SHOULD NOT      (0.001 USDC, minOut 1e30 -- unreachable)',
        amount: 10n ** 15n,
        minOut: 10n ** 30n,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        label: 'SHOULD EXPIRE   (expiry in the past)',
        amount: 10n ** 15n,
        minOut: 1n,
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    ]

    for (const [index, seed] of seeds.entries()) {
      const outcome = await placeOrder(pool, {
        token: TOKEN,
        ownerAddr: OWNER,
        isBuy: true,
        amount: seed.amount,
        minOut: seed.minOut,
        expiresAt: seed.expiresAt,
        nonceHex: nonce(0xa000 + index),
        signatureHex: `0x${'ab'.repeat(65)}`,
        issuedAt: new Date(),
      })
      console.log(
        `  seeded [${outcome.ok ? `seq ${outcome.row.orderSeq}` : outcome.reason}] ${seed.label}`,
      )
    }

    console.log('\n  --- state BEFORE the pass ---')
    for (const row of await listOrders(pool, TOKEN, OWNER, { limit: 20 })) {
      console.log(`  seq=${row.orderSeq} status=${row.status} minOut=${row.minOut}`)
    }
    return 0
  } finally {
    await pool.end()
  }
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    console.error(error)
    exit(1)
  },
)
