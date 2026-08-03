'use client'

import { useEstimateFeesPerGas, useEstimateGas } from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import { gasReserveFrom } from './gas'

/**
 * GAZ PAYI OLCULUR, VARSAYILMAZ.
 *
 * Iki okuma: BU CAGRI icin `estimateGas`, ve agin `maxFeePerGas`'i. Ikisinin
 * carpimi ×3/2 emniyet marjiyla `gas.ts`'te birlesir -- marj orada ve YALNIZCA
 * ORADA.
 *
 * TAHMIN BASARISIZ OLURSA `reserve` `null` DONER ve MAX ile yuzde kisayollari
 * devre disi kalir; sebep `reason`'da yazar ve tooltip'e girer. Sabit bir
 * varsayilan koymak kolay olurdu ve tam olarak yanlis olurdu: Arc'in gaz
 * fiyati bu planin dogrulayamadigi bir sey, uydurulmus bir sabit ise
 * kullanicinin parasi uzerinde denenen olculmemis bir sayidir.
 *
 * `estimateGas` REVERT EDEN bir cagri icin de basarisiz olur -- ve bu dogru
 * davranis: revert edecek bir islem icin ayrilacak pay diye bir sey yok.
 * Kullanici o durumda zaten cozulmus sebebi gorur (`simulation`), kisayollarin
 * sessizce calismasi ise ona her seyin yolunda oldugunu soylerdi.
 */

export type GasRequest = {
  readonly to: HexAddress
  readonly data: `0x${string}`
  readonly value: bigint
  readonly account: HexAddress
} | null

export type GasReserveHandle = {
  /** wei. `null` -> olculemedi; kisayollar kapali. */
  readonly reserve: bigint | null
  /** `reserve === null` oldugunda TEK cumlelik sebep, yoksa `null`. */
  readonly reason: string | null
}

const NO_REQUEST =
  'Enter an amount first: the gas reserve is measured for the transaction you are about to send, not guessed.'
const NO_ESTIMATE =
  'Gas could not be estimated right now, so the shortcuts cannot leave room for it. Type an amount instead.'

export function useGasReserve(request: GasRequest): GasReserveHandle {
  const enabled = request !== null

  const gas = useEstimateGas(
    request === null
      ? { query: { enabled: false } }
      : {
          to: request.to,
          data: request.data,
          value: request.value,
          account: request.account,
          query: { enabled: true },
        },
  )

  const fees = useEstimateFeesPerGas({ query: { enabled } })

  if (!enabled) return { reserve: null, reason: NO_REQUEST }

  const gasUnits = gas.data
  // `maxFeePerGas` EIP-1559 alanidir; legacy bir agda `gasPrice` gelir. Ikisi
  // de yoksa carpilacak bir fiyat YOKTUR ve sifir varsaymak rezervi sifir
  // yapardi -- yani gaz payini kaldirirdi.
  const feeData = fees.data as { maxFeePerGas?: bigint; gasPrice?: bigint } | undefined
  const price = feeData?.maxFeePerGas ?? feeData?.gasPrice
  if (typeof gasUnits !== 'bigint' || typeof price !== 'bigint') {
    return { reserve: null, reason: NO_ESTIMATE }
  }

  return { reserve: gasReserveFrom(gasUnits, price), reason: null }
}
