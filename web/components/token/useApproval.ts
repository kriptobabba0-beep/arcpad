'use client'

import { launchTokenAbi } from '@arcpad/shared/browser'
import { useCallback } from 'react'
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import { type ArcpadFailure, decodeArcpadError } from '@/lib/decodeRevert'
import type { ApprovalState, TradePhase } from './tradeModel'

/**
 * SATIS IKI ISLEMDIR, VE PANEL BUNU GIZLEMEZ.
 *
 * `sellExactTokensIn` tokenlari `transferFrom` ile alir ve `LaunchToken` DUZ
 * bir OZ ERC-20'dir: `permit` YOK. Yani once `approve`, sonra `sell` -- iki
 * imza. Tek bir "Sell" butonu gosterip arkada iki islem gondermek, kullaniciya
 * imzalamadigi bir sey imzalatmaktir.
 *
 * ONAY MIKTARI TAM OLARAK `tokensIn`, SINIRSIZ DEGIL. Sinirsiz onay bir
 * aliskanliktir ve ogretmeye degmez; Arc'ta yeniden onay ~46k gas ve hedeflenen
 * ~0,01 USD islem maliyetinde ihmal edilebilir. Kazanilan sey: kullanici
 * paneli terk ettiginde curve'un onun tokenlari uzerinde ACIK BIR YETKISI
 * kalmaz.
 *
 * ONAY ONAYLANDIKTAN SONRA SATIS OTOMATIK GONDERILMEZ. Ikinci buton
 * etkinlesir, o kadar. Kullanicinin basmadigi bir islem gonderilmez, istisnasiz
 * -- ve bu, iki imzayi tek akisa yapistiran her mutantin oldugu yerdir.
 */

export type ApprovalHandle = {
  readonly state: ApprovalState
  readonly allowance: bigint | undefined
  readonly approve: () => void
  readonly phase: TradePhase
  readonly failure: ArcpadFailure | null
  /**
   * HAM HATA, DECODE EDILMEMIS -- ve varligi bir tercih degil bir ZORUNLULUK.
   *
   * `failure` CURVE sozlugu (`decodeArcpadError`) ile cozulur. Havuz paneli ayni
   * kancayi kullanir ama KENDI sozlugu (`lib/poolOutcome.ts`) vardir ve
   * `poolOutcome.ts`'in kendi gerekcesi sudur: "bir kullanici bir curve islemi
   * icin bir kelime dagarcigi, bir havuz islemi icin baskasini ogrenmek zorunda
   * kalmamali". Ham hatayi vermek, iki panelin ayni onay arizasini kendi
   * dilinde anlatmasini saglar; `failure.raw`a uzanmak da ayni seyi yapardi ama
   * cagri yerinde bir hack gibi okunurdu.
   */
  readonly error: unknown
  readonly hash: `0x${string}` | undefined
  readonly refetch: () => void
  readonly reset: () => void
}

/**
 * Saf karar. `allowance` HENUZ BILINMIYORKEN `required` DONMEZ.
 *
 * Bilinmeyeni "gerekli" saymak, okuma inerken bir saniyeligine "Approve DIFF"
 * yazip sonra "Sell DIFF"e donmek demektir; kullanici o arada basarsa gereksiz
 * bir islem oder. `unknown` ayri bir durumdur ve butonu BEKLETIR.
 */
export function approvalStateOf(
  allowance: bigint | undefined,
  needed: bigint | null,
): ApprovalState {
  if (needed === null || needed === 0n) return 'notNeeded'
  if (allowance === undefined) return 'unknown'
  return allowance >= needed ? 'sufficient' : 'required'
}

export function useApproval(
  token: HexAddress | undefined,
  spender: HexAddress | undefined,
  owner: HexAddress | undefined,
  needed: bigint | null,
): ApprovalHandle {
  const enabled = token !== undefined && spender !== undefined && owner !== undefined

  const allowanceRead = useReadContract({
    address: token as `0x${string}`,
    abi: launchTokenAbi,
    functionName: 'allowance',
    args: [owner as `0x${string}`, spender as `0x${string}`],
    query: { enabled: enabled && needed !== null && needed > 0n },
  })

  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    query: { enabled: write.data !== undefined },
  })

  const approve = useCallback(() => {
    if (!enabled || needed === null || needed <= 0n) return
    write.writeContract({
      address: token as `0x${string}`,
      abi: launchTokenAbi,
      functionName: 'approve',
      // TAM OLARAK gereken miktar. `maxUint256` yazan bir mutant burada olur.
      args: [spender as `0x${string}`, needed],
    })
  }, [enabled, needed, spender, token, write])

  const phase: TradePhase = write.isPending
    ? 'awaitingSignature'
    : write.error
      ? 'failed'
      : write.data === undefined
        ? 'idle'
        : receipt.isSuccess
          ? 'confirmed'
          : receipt.isError
            ? 'failed'
            : 'pending'

  const rawError = write.error ?? receipt.error ?? null

  return {
    // Onay makbuzu geldiginde `allowance` okumasi henuz yenilenmemis olabilir;
    // `confirmed` dali o araligi kapatir. Kapatmasaydi kullanici onaydan sonra
    // yine "Approve" gorur ve ikinci kez onaylardi.
    state:
      phase === 'confirmed' && needed !== null && needed > 0n
        ? 'sufficient'
        : approvalStateOf(allowanceRead.data as bigint | undefined, needed),
    allowance: allowanceRead.data as bigint | undefined,
    approve,
    phase,
    failure: rawError === null ? null : decodeArcpadError(rawError, { action: 'approve' }),
    error: rawError,
    hash: write.data,
    refetch: useCallback(() => {
      void allowanceRead.refetch()
    }, [allowanceRead]),
    reset: useCallback(() => {
      write.reset()
    }, [write]),
  }
}
