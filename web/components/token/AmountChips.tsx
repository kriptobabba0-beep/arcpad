'use client'

import { Button } from '@/components/ui/Button'
import type { AmountChip } from './tradeModel'

export type AmountChipsProps = {
  /** Already RESOLVED and already filtered -- see `amountChipsFor`. */
  readonly chips: readonly AmountChip[]
  readonly onPick: (chip: AmountChip) => void
  readonly disabled?: boolean
}

/**
 * `$25 · $100 · $500` -- MONEY ON BOTH SIDES, and only the ones that resolve.
 *
 * The user picks a figure in dollars; the panel turns it into whatever the
 * field underneath is denominated in. On `spend` that is the same number. On
 * `receive` and `sell` it is a token quantity that came out of the planner for
 * that tab's own entrypoint -- the sell side through the SELL direction, which
 * is the part that would look right and be wrong if it were done with buy-side
 * arithmetic.
 *
 * NOTHING IS RENDERED WHEN NOTHING RESOLVES, and that is not an edge case --
 * it is the invariant. The ladder is now chosen per profile (testnet
 * $1/$5/$10, production $25/$100/$500) so the common case has chips, but a
 * ladder being right for a PROFILE does not make it right at every point in a
 * CURVE's life: an early production curve has no depth for $500, and a curve
 * near the top cannot absorb any of them without clamping. `amountChipsFor`
 * resolves every chip through the planner and this component draws only what
 * came back.
 *
 * A DISABLED CHIP IS NOT AN OPTION HERE. `SpendableMaxButton` disables itself
 * and explains why in a `title`, because "MAX" is a promise about the user's
 * OWN balance and its absence needs accounting for. `$500` is a promise about
 * nothing but itself: a user who cannot afford it does not need a greyed-out
 * button telling them so, they need the button gone and the amount field they
 * already have. Rendering a permanently dead row is the defect this repository
 * deleted the `Market | Limit | Orders` strip to be rid of.
 */
export function AmountChips({ chips, onPick, disabled = false }: AmountChipsProps) {
  if (chips.length === 0) return null

  return (
    <div className="flex items-center gap-1.5" data-testid="amount-chips">
      {chips.map((chip) => (
        <Button
          key={String(chip.usdc)}
          size="sm"
          pill
          variant="ghost"
          disabled={disabled}
          data-testid={`chip-${chip.usdc}`}
          onClick={() => onPick(chip)}
        >
          ${String(chip.usdc)}
        </Button>
      ))}
    </div>
  )
}
