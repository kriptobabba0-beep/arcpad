import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, assertArcChain, createArcClient } from '@arcpad/shared'
import { finalizedHead, nextRange } from './cursor'

const MAX_SPAN = 1_000n

async function main(): Promise<void> {
  const rpcUrl = process.env['ARC_RPC_URL']
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  const client = createArcClient(rpcUrl)
  await assertArcChain(client)

  // Head'in TEK kaynagi. `client.getBlock({blockTag:'finalized'})` burada
  // TEKRAR EDILMEZ: tekrar etmek, "tek kaynak" sozunu ikinci bir cagri
  // yerine yalnizca bir yorumla korurdu.
  const head = await finalizedHead(client)
  // Faz 3'te imlec Postgres'ten okunacak. Faz 0'da yalnizca baglantinin ve
  // aralik hesabinin calistigini gosteriyoruz.
  const range = nextRange(head - 10n, head, MAX_SPAN)

  console.log(`arc chainId=${ARC_TESTNET_CHAIN_ID} finalizedHead=${head} nextRange=`, range)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
