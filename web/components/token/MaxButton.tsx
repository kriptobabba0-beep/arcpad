'use client'

import { Button } from '@/components/ui/Button'
import { shortcutAmount, SHORTCUT_PERCENTS, type ShortcutPercent } from './gas'

export type MaxButtonProps = {
  /** Gaz payi DUSULMUS bakiye. `null` -> tahmin yok, kisayollar kapali. */
  readonly spendable: bigint | null
  /** `spendable === null` oldugunda tooltip'e giren sebep. */
  readonly reason: string | null
  readonly onPick: (amount: bigint) => void
  readonly disabled?: boolean
}

const LABEL = (percent: ShortcutPercent): string => (percent === 100 ? 'MAX' : `${percent}%`)

/**
 * `25% · 50% · 75% · MAX` -- HEPSI `spendable` UZERINDEN, `balance` UZERINDEN
 * DEGIL.
 *
 * Arc'ta gaz, harcanan varligin KENDISIYLE odenir; bakiyenin tamamini harcayan
 * bir MAX her seferinde basarisiz olur. `spendable`'i `balance` ile degistiren
 * mutant `web/test/trade/gas.test.ts`'te olur -- ve orada oldugu icin bu
 * bilesen kendi aritmetigini HIC yazmaz, `gas.ts`'i cagirir.
 *
 * Tahmin basarisiz oldugunda dort dugme de DEVRE DISI ve sebep `title`'da
 * yazar. Kapali bir dugme sebepsiz kaldiginda kullanici onu bir hata sanar;
 * sebebi yazmak, kapaliligi bir karara cevirir.
 */
export function MaxButton({ spendable, reason, onPick, disabled = false }: MaxButtonProps) {
  const off = disabled || spendable === null
  const title = spendable === null && reason !== null ? reason : undefined

  return (
    <div className="flex items-center gap-1.5" data-testid="amount-shortcuts">
      {SHORTCUT_PERCENTS.map((percent) => (
        <Button
          key={percent}
          size="sm"
          pill
          variant="ghost"
          disabled={off}
          {...(title === undefined ? {} : { title })}
          data-testid={`shortcut-${percent}`}
          onClick={() => {
            const amount = shortcutAmount(spendable, percent)
            if (amount === null) return
            onPick(amount)
          }}
        >
          {LABEL(percent)}
        </Button>
      ))}
    </div>
  )
}
