import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, assertArcChain, createArcClient } from '@arcpad/shared'
import { loadKeeperConfig } from './config'

async function main(): Promise<void> {
  const config = loadKeeperConfig(process.env)
  const client = createArcClient(config.rpcUrl)
  await assertArcChain(client)

  // Faz 7'de burada limit emir tetikleme dongusu olacak. Faz 0'da yalnizca
  // yapilandirma ve baglantinin dogru oldugunu gosteriyoruz.
  console.log(
    `keeper ready chainId=${ARC_TESTNET_CHAIN_ID} pollIntervalMs=${config.pollIntervalMs} dryRun=${config.dryRun}`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
