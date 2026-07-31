import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, assertArcChain, createArcClient } from '@arcpad/shared'
import { assertContinuous, finalizedHead, nextRange } from './cursor'

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
  // Faz 3'te imlec Postgres'ten (`getCursor`) okunacak. Faz 0/1'de yalnizca
  // baglantinin ve aralik hesabinin calistigini gosteriyoruz.
  const cursor = head - 10n
  const range = nextRange(cursor, head, MAX_SPAN)

  // ZINCIR BAGI MUHAFIZI. Imlec veritabanindan geldiginde ikinci argüman
  // `(await getCursor(db))?.lastBlockHash ?? null` olur; burada imlec
  // uydurulmus oldugu icin kaydedilmis bir hash YOKTUR ve `null` gecilir --
  // yani muhafiz "ilk kosu" dalindan gecer. Bunu sessizce atlamak yerine
  // acikca cagirmak, Task 5/8'in dongusunu kurarken cagriyi EKLEMEYI
  // unutmasini zorlastirir.
  if (range !== null) {
    const first = await client.getBlock({ blockNumber: range.from })
    assertContinuous(cursor, null, first.parentHash)
  }

  console.log(`arc chainId=${ARC_TESTNET_CHAIN_ID} finalizedHead=${head} nextRange=`, range)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
