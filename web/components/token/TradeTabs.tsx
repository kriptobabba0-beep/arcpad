import { isBuyTab, type TradeTab } from './tradeModel'

/**
 * ============================================================================
 *  BUY / SELL, VE ALIMIN ICINDE BIRIM SECIMI
 * ============================================================================
 *
 * MODEL UC DURUMLUDUR ve oyle KALIR: `spend` (`buyExactQuoteIn`), `receive`
 * (`buyExactTokensOut`), `sell` (`sellExactTokensIn`). Ucu de zincirde AYRI
 * giris noktalaridir ve birini kaldirmak bir yetenegi kaldirmak olurdu --
 * ozellikle `spend`i, cunku rezervin tepesinde revert etmeyen tek alim yolu
 * odur (butce kirpilir ve kalan AYNI islemde iade edilir).
 *
 * DEGISEN SEY YALNIZCA SUNUM. Uc sekmeli bir serit, kullaniciya once bir
 * MEKANIK sorusu sorar ("hangi giris noktasi?") -- oysa sorulmasi gereken ilk
 * sey niyettir: aliyor musun, satiyor musun. Ikinci soru ("hangi birimde
 * yaziyorsun") ancak alim icinde anlamlidir ve orada, tutarin yaninda durur.
 *
 * Bu dosya bir GORUNUM: hicbir karar vermez, `TradeTab` degerlerini oldugu
 * gibi yukari verir. Islem mantigi `tradeModel.ts`te, dokunulmadi.
 */
export function TradeSideTabs({
  tab,
  onChange,
  label = 'Trade side',
}: {
  tab: TradeTab
  onChange: (next: TradeTab) => void
  label?: string
}) {
  const buying = isBuyTab(tab)
  return (
    <div
      role="tablist"
      aria-label={label}
      className="grid grid-cols-2 gap-1 rounded-pill bg-surface-2 p-1"
      data-testid="trade-side-tabs"
    >
      <SideButton
        active={buying}
        onClick={() => {
          // ALIMA DONERKEN `spend`. Varsayilan bu, cunku rezervin tepesinde
          // revert etmeyen yol odur; kullanici birimi yaninda degistirebilir.
          if (!buying) onChange('spend')
        }}
      >
        Buy
      </SideButton>
      <SideButton
        active={!buying}
        onClick={() => {
          if (buying) onChange('sell')
        }}
      >
        Sell
      </SideButton>
    </div>
  )
}

function SideButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'rounded-pill px-4 py-2 text-[14px] font-medium leading-none transition-colors duration-150',
        active ? 'bg-white/10 text-text' : 'text-muted hover:text-text',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/**
 * ALIMDA BIRIM: harcanan USDC mi, alinan token mi.
 *
 * Referans tasarimda bu, tutar kutusunun sagindaki para birimi hapidir.
 * Burada da oyle duruyor ve ayni iki giris noktasini secer -- yani gorunum
 * degisti, davranis degil.
 *
 * SATISTA CIZILMEZ: satisin tek bir giris noktasi var
 * (`sellExactTokensIn`), dolayisiyla secilecek bir sey yok ve bos bir secim
 * kontrolu gostermek kullaniciyi olmayan bir karara davet ederdi.
 */
export function BuyUnitToggle({
  tab,
  symbol,
  onChange,
}: {
  tab: TradeTab
  symbol: string
  onChange: (next: TradeTab) => void
}) {
  if (!isBuyTab(tab)) return null
  const spending = tab === 'spend'
  return (
    <button
      type="button"
      onClick={() => onChange(spending ? 'receive' : 'spend')}
      aria-label={
        spending
          ? `Amount is in USDC. Switch to entering ${symbol}`
          : `Amount is in ${symbol}. Switch to entering USDC`
      }
      className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface-2 px-3 py-1.5 text-[13px] font-medium leading-none transition-colors duration-150 hover:border-white/20"
      data-testid="buy-unit-toggle"
    >
      {spending ? 'USDC' : symbol}
      <span aria-hidden="true" className="text-muted">
        ⇅
      </span>
    </button>
  )
}
