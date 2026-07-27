import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared'
import { createArcClient } from './client'
import { nextRange } from './cursor'

const MAX_SPAN = 1_000n

async function main(): Promise<void> {
  const rpcUrl = process.env['ARC_RPC_URL']
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  const client = createArcClient(rpcUrl)

  const chainId = await client.getChainId()
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`connected to chain ${chainId}, expected ${ARC_TESTNET_CHAIN_ID}`)
  }

  const head = await client.getBlock({ blockTag: 'finalized' })
  // Faz 3'te imlec Postgres'ten okunacak. Faz 0'da yalnizca baglantinin ve
  // aralik hesabinin calistigini gosteriyoruz.
  const range = nextRange(head.number - 10n, head.number, MAX_SPAN)

  console.log(`arc chainId=${chainId} finalizedHead=${head.number} nextRange=`, range)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
