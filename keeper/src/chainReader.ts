import type { Abi, AbiEvent } from 'viem'
import type { createArcClient } from '@arcpad/shared'
import type { ChainReader, HeadBlock, LogQuery, ReadCall } from './watch/graduationWindow'

type ArcClient = ReturnType<typeof createArcClient>

/**
 * `ChainReader`in TEK gercek uygulamasi ve SAF DELEGASYON.
 *
 * Icinde bir tane bile kosul yoktur (blok numarasinin null olmadigi kontrolu
 * disinda, ki o da viem'in tipini daraltmak icindir), ve bu bir tercih degil
 * bir gerekliliktir: birim testleri sentetik bir zincire karsi kosar, yani bu
 * dosya depodaki TEK test edilmeyen izleyici kodudur. Karar iceren her satir
 * `graduationWindow.ts`e tasinmistir; burada kalan sey yalnizca viem'in
 * imzalariyla bizim dar arayuzumuz arasindaki cevirdir. Canli dogrulamasi
 * `drill.ts`tir.
 */
export function viemChainReader(client: ArcClient): ChainReader {
  return {
    async getBlock(): Promise<HeadBlock> {
      const block = await client.getBlock({ blockTag: 'latest' })
      if (block.number === null) throw new Error('the latest block has no number')
      return { number: block.number, timestamp: block.timestamp }
    },
    readContract(call: ReadCall): Promise<unknown> {
      return client.readContract({
        address: call.address,
        abi: call.abi as Abi,
        functionName: call.functionName,
        args: call.args ?? [],
        blockNumber: call.blockNumber,
      })
    },
    async getLogs(query: LogQuery): Promise<ReadonlyArray<{ args?: Record<string, unknown> }>> {
      const logs = await client.getLogs({
        address: query.address,
        event: query.event as AbiEvent,
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
      })
      return logs as ReadonlyArray<{ args?: Record<string, unknown> }>
    },
  }
}
