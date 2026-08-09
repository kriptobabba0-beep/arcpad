'use client'

import { formatTokenAmount, formatUsdcAmount } from '@arcpad/shared/browser'
import { cx } from '@/components/ui/cx'
import { quoteWeiFromUnits } from '@/lib/quoteUnits'
import type { ApprovalState, TradePhase } from './tradeModel'

export type ApproveStepProps = {
  readonly symbol: string
  /** ONAYLANACAK TAM MIKTAR -- `tokensIn`, sinirsiz DEGIL. */
  readonly amountTok: bigint
  readonly approval: ApprovalState
  readonly phase: TradePhase
  /**
   * ONAYLANAN VARLIGIN ONDALIGI. Varsayilan 18 -- curve tarafinin tek durumu.
   *
   * HAVUZ TARAFI IKI VARLIK ONAYLAR: satista 18 ondalikli launch token, ALIMDA
   * 6 ondalikli USDC (`0x3600…0000`). Ayni bileşen iki yerde cizilir cunku
   * ikinci bir "approve adimlari" bileşeni yazmak, bu depoda on bir kez olculen
   * "bir giris noktasinda kapatilan ozellik hepsinde kapatilmis gorunur"
   * sinifinin yeni bir ornegi olurdu. Farkli olan tek sey BICIMLENDIRICI.
   */
  readonly decimals?: 6 | 18
  /** Ikinci adimin etiketi. Varsayilan "Sell" -- curve tarafinin tek durumu. */
  readonly actionLabel?: string
  /**
   * ONAYIN ISLEMDEN ARTAN KISMI, onaylanan varligin kendi biriminde.
   *
   * `buyExactOut` `maxQuoteIn` kadar onay ister ama yalnizca gerceklesen tutari
   * ceker; aradaki fark router'da ACIK BIR YETKI olarak kalir. Panelin
   * "harcadigin kadar onaylarsin" sozu bu tek sekilde tutulamaz, o yuzden
   * SOYLENIR.
   */
  readonly residual?: bigint
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
export function ApproveStep({
  symbol,
  amountTok,
  approval,
  phase,
  decimals = 18,
  actionLabel = 'Sell',
  residual = 0n,
}: ApproveStepProps) {
  if (approval !== 'required' && approval !== 'unknown' && phase !== 'confirmed') return null

  const approved = approval === 'sufficient'

  return (
    <ol className="flex flex-col gap-1 text-[12px] text-muted" data-testid="approve-steps">
      <li className={cx('flex gap-2', approved && 'line-through opacity-60')}>
        <span aria-hidden="true">1.</span>
        <span data-testid="approve-step-1">
          Approve {symbol}{' '}
          <span className="tabular-nums">
            (allowance: {formatApprovalAmount(amountTok, decimals)} {symbol})
          </span>
        </span>
      </li>
      <li className={cx('flex gap-2', !approved && 'opacity-60')}>
        <span aria-hidden="true">2.</span>
        <span data-testid="approve-step-2">{actionLabel}</span>
      </li>
      {residual > 0n ? (
        <li className="pl-5 text-[11px]" data-testid="approve-residual">
          This shape approves your slippage cap, so{' '}
          <span className="tabular-nums">
            {formatApprovalAmount(residual, decimals)} {symbol}
          </span>{' '}
          may stay approved afterwards. Buying an exact USDC amount instead approves exactly what it
          spends.
        </li>
      ) : null}
    </ol>
  )
}

/**
 * The 6-decimal branch goes through `lib/quoteUnits.ts`, never through an
 * inline `1e12`. `formatUsdcAmount` takes the NATIVE view by contract, so the
 * units have to be raised into it first -- exactly and losslessly.
 */
function formatApprovalAmount(amount: bigint, decimals: 6 | 18): string {
  return decimals === 6
    ? formatUsdcAmount(quoteWeiFromUnits(amount), { rounding: 'up' })
    : formatTokenAmount(amount)
}
