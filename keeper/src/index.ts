import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, arcTestnet } from '@arcpad/shared'
import { createPublicClient, http } from 'viem'
import { loadKeeperConfig } from './config'

async function main(): Promise<void> {
  const config = loadKeeperConfig(process.env)
  const client = createPublicClient({ chain: arcTestnet, transport: http(config.rpcUrl) })

  const chainId = await client.getChainId()
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`connected to chain ${chainId}, expected ${ARC_TESTNET_CHAIN_ID}`)
  }

  // Faz 7'de burada limit emir tetikleme dongusu olacak. Faz 0'da yalnizca
  // yapilandirma ve baglantinin dogru oldugunu gosteriyoruz.
  console.log(
    `keeper ready chainId=${chainId} pollIntervalMs=${config.pollIntervalMs} dryRun=${config.dryRun}`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
