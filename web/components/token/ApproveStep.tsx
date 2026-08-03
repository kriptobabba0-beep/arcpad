'use client'

import { formatTokenAmount } from '@arcpad/shared/browser'
import { cx } from '@/components/ui/cx'
import type { ApprovalState, TradePhase } from './tradeModel'

export type ApproveStepProps = {
  readonly symbol: string
  /** ONAYLANACAK TAM MIKTAR -- `tokensIn`, sinirsiz DEGIL. */
  readonly amountTok: bigint
  readonly approval: ApprovalState
  readonly phase: TradePhase
}

/**
 * SATIS IKI IMZADIR VE PANEL BUNU BASTAN YAZAR.
 *
 * `sellExactTokensIn` `transferFrom` kullanir ve `LaunchToken` duz OZ ERC-20:
 * `permit` YOK. Iki adimi tek bir "Sell" butonunun arkasina saklayan bir
 * arayuz, kullaniciya beklemedigi ikinci bir cuzdan penceresi acar -- ve
 * beklenmeyen bir imza istegi, kullanicinin reddetmeyi ogrendigi seydir.
 *
 * Adimlar `allowance` YETERLIYSE HIC GORUNMEZ: zaten onaylamis bir kullaniciya
 * "1. Approve" gostermek, yapilmis bir isi yeniden yapilacak gibi gosterir.
 */
export function ApproveStep({ symbol, amountTok, approval, phase }: ApproveStepProps) {
  if (approval !== 'required' && approval !== 'unknown' && phase !== 'confirmed') return null

  const approved = approval === 'sufficient'

  return (
    <ol className="flex flex-col gap-1 text-[12px] text-muted" data-testid="approve-steps">
      <li className={cx('flex gap-2', approved && 'line-through opacity-60')}>
        <span aria-hidden="true">1.</span>
        <span data-testid="approve-step-1">
          Approve {symbol}{' '}
          <span className="tabular-nums">
            (allowance: {formatTokenAmount(amountTok)} {symbol})
          </span>
        </span>
      </li>
      <li className={cx('flex gap-2', !approved && 'opacity-60')}>
        <span aria-hidden="true">2.</span>
        <span data-testid="approve-step-2">Sell</span>
      </li>
    </ol>
  )
}
