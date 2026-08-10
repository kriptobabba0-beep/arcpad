'use client'

import {
  bondingCurveAbi,
  type CurveProfile,
  type CurveState,
  type FeeBps,
  formatTokenAmount,
  launchTokenAbi,
  planBuyExactQuoteIn,
  priceWeiPerToken,
  type ProfileName,
  type TradePlan,
} from '@arcpad/shared/browser'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { encodeFunctionData } from 'viem'
import { useReadContract, useSimulateContract } from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import { FailureNotice, readFailure } from '@/components/errors'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Money } from '@/components/ui/Money'
import { Tabs } from '@/components/ui/Tabs'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { getWebConfig } from '@/lib/addresses'
import type { ArcpadFailure } from '@/lib/decodeRevert'
import { decodeArcpadError } from '@/lib/decodeRevert'
import { AmountChips } from './AmountChips'
import { AmountInput } from './AmountInput'
import { ApproveStep } from './ApproveStep'
import { spendableFrom } from './gas'
import type { Lifecycle } from './lifecycle'
import { SpendableMaxButton } from './SpendableMaxButton'
import { QuoteBreakdown } from './QuoteBreakdown'
import { DEFAULT_SLIP_BPS, SlippageControl } from './SlippageControl'
import {
  type AmountChip,
  amountChipsFor,
  type ApprovalState,
  buttonFor,
  clampToReserve,
  type ConnectionState,
  DEFAULT_TAB,
  parseAmount,
  type Quote,
  quoteFor,
  shortcutBaseFor,
  type SimulationVerdict,
  TAB_LABEL,
  type TradePhase,
  type TradeTab,
  TRADE_TABS,
} from './tradeModel'
import { useApproval } from './useApproval'
import { useCurveState } from './useCurveState'
import { useGasReserve } from './useGasReserve'
import { type RealisedTrade, REFUND_DISPLAY_FLOOR, useTrade } from './useTrade'

/**
 * AL-SAT PANELI.
 *
 * UC EYLEM, UC AYRI GIRIS NOKTASI, UC FARKLI SINIR DAVRANISI -- ve hicbiri
 * digerinin testiyle kapanmaz:
 *
 *   Spend USDC     `buyExactQuoteIn(minTokensOut)`      rezerv tepesinde KISAR
 *   Receive tokens `buyExactTokensOut(tokensOut, max)`  rezerv tepesinde REVERT
 *   Sell           `sellExactTokensIn(tokensIn, min)`   ONCE `approve` ister
 *
 * VARSAYILAN `Spend USDC` ve gerekcesi ekranda da yazili: butce kisilir ve
 * artan iade edilir, yani BAYAT BIR KOTADAN DOLAYI BASARISIZ OLAMAZ. Ikisini
 * simetrik sunmak, farkli iki sinir davranisini ayni gorunmez kilardi.
 *
 * BU DOSYA `@arcpad/db`'YI HIC IMPORT ETMEZ. Rezervler zincirden okunur
 * (`useCurveState`), yani indexer dustugunde kullanici listeleri ve gecmisi
 * kaybeder, ISLEM YAPMA YETENEGINI DEGIL. `web/test/trade/db-independence.test.tsx`
 * bunu iki yoldan olcer: kaynak metninde import yoklugu, ve `getPool`'u atacak
 * sekilde sahtelenmis bir render.
 *
 * ADRESLER ADRES DEFTERINDEN. Tek bir kontrat adresi literal degil: `curve`
 * cagirandan gelir, gezgin adresi `getWebConfig()`'ten. Faz 2 `LaunchFactory`'yi
 * yeniden dagitiyor (yapicisi bir `feeSchedule` argumani aliyor), yani buraya
 * kopyalanmis bir adres sessizce olu bir kontrata bakardi.
 */

/** Gaz tahmini icin en kucuk anlamli cagri: bir mikro-USDC (alanin kuantasi). */
const GAS_PROBE_BUDGET_WEI = 1_000_000_000_000n

// --------------------------------------------------------------------------
// Saf gorunum
// --------------------------------------------------------------------------

export type QuoteReport = {
  readonly tab: TradeTab
  readonly plan: TradePlan | null
  /** Satista `tokensIn` -- onay miktari TAM OLARAK budur. */
  readonly amount: bigint | null
}

export type TradeFormProps = {
  readonly symbol: string
  readonly state: CurveState
  readonly profile: CurveProfile
  /** Hangi merdiven. `getCurveProfile()` fabrikanin immutable'larindan kimliklendirir. */
  readonly profileName: ProfileName
  readonly fees: FeeBps
  readonly connection: ConnectionState
  readonly chainName: string
  /** Gaz payi DUSULMUS USDC bakiyesi. `null` -> olculemedi. */
  readonly spendable: bigint | null
  readonly gasReason: string | null
  /** Ham USDC bakiyesi -- EKRANDA TEK figur olarak gosterilen sey. */
  readonly usdcBalance: bigint
  readonly tokenBalance: bigint | null
  readonly approval: ApprovalState
  readonly approvalPhase: TradePhase
  readonly simulation: SimulationVerdict
  readonly phase: TradePhase
  readonly hash?: `0x${string}` | undefined
  readonly failure: ArcpadFailure | null
  readonly realised: RealisedTrade | null
  readonly explorerUrl?: string | undefined
  readonly onConnect?: (() => void) | undefined
  readonly onSwitch?: (() => void) | undefined
  readonly onApprove?: (() => void) | undefined
  readonly onSubmit?: ((plan: TradePlan) => void) | undefined
  readonly onQuote?: ((report: QuoteReport) => void) | undefined
  readonly initialTab?: TradeTab
}

export function TradeForm({
  symbol,
  state,
  profile,
  profileName,
  fees,
  connection,
  chainName,
  spendable,
  gasReason,
  usdcBalance,
  tokenBalance,
  approval,
  approvalPhase,
  simulation,
  phase,
  hash,
  failure,
  realised,
  explorerUrl,
  onConnect,
  onSwitch,
  onApprove,
  onSubmit,
  onQuote,
  initialTab = DEFAULT_TAB,
}: TradeFormProps) {
  const [tab, setTab] = useState<TradeTab>(initialTab)
  const [text, setText] = useState('')
  const [slipBps, setSlipBps] = useState(DEFAULT_SLIP_BPS)

  const parsed = parseAmount(text)
  const requested = parsed.ok ? parsed.value : null

  // KELEPCE YALNIZCA `receive` SEKMESINDE ve GORUNUR bir satir olarak.
  // `buyExactQuoteIn` zaten kendi kelepcesini zincirde yapiyor ve artani iade
  // ediyor; girdiyi orada da kisitlamak, kullanicinin harcayabilecegi butceyi
  // sebepsiz kucultmek olurdu.
  const clamp =
    tab === 'receive' && requested !== null
      ? clampToReserve(requested, state.realTokenReserves)
      : null
  const amount = clamp === null ? requested : clamp.value

  const quote: Quote | null =
    amount === null || amount === 0n
      ? null
      : quoteFor({ tab, amount, state, profile, fees, slipBps })
  const plan = quote !== null && quote.ok ? quote.plan : null

  // Kotayi YUKARI bildirmek, simulasyon/onay/gaz kancalarinin ayni plani
  // gormesi icin. Anahtar uzerinden karsilastiriliyor: her render'da yeni bir
  // nesne uretiliyor ve nesne kimligiyle karsilastirmak sonsuz bir donguye
  // girerdi.
  const quoteKey =
    plan === null
      ? `${tab}|none|${amount ?? ''}`
      : `${tab}|${plan.action}|${plan.args.join(',')}|${plan.value}`
  const lastKey = useRef<string | null>(null)
  useEffect(() => {
    if (lastKey.current === quoteKey) return
    lastKey.current = quoteKey
    onQuote?.({ tab, plan, amount })
    // BAGIMLILIK LISTESI BILEREK YALNIZCA `quoteKey`. `plan` ve `amount`
    // anahtarin ICINDE tasiniyor; listeye konsalardi her render'da degisen
    // nesne kimligi efekti yeniden tetikler, o da `setReport` cagirir, o da
    // yeni bir render uretirdi -- sonsuz dongu. (Bu depoda `react-hooks`
    // eklentisi kurulu degil, yani bir `eslint-disable` yorumu bilinmeyen bir
    // kurala atif olur ve LINT HATASI verir; bunun yerine sebep yaziliyor.)
  }, [quoteKey])

  const shortcutBase = shortcutBaseFor({
    tab,
    spendable,
    tokenBalance,
    state,
    profile,
    fees,
    slipBps,
  })

  /**
   * A PICKED AMOUNT BECOMES FIELD TEXT IN EXACTLY ONE PLACE.
   *
   * MAX and the money chips write into the same field, and the field's unit
   * changes with the tab. Two copies of this ternary is two chances for a token
   * quantity to be written as a USDC figure -- both views are 1e18-scaled, so
   * that mistake is invisible on screen and only shows up in what gets signed.
   */
  const fieldText = useCallback(
    (amount: bigint): string =>
      tab === 'spend' ? formatUsdcInput(amount) : formatTokenAmount(amount).replace(/,/g, ''),
    [tab],
  )

  // Resolved through the planners, so this is the row of chips that can
  // actually be FILLED -- not the ladder. See `amountChipsFor`: on today's
  // profile it is empty, and the measurement behind that is recorded there.
  const chips = useMemo(
    () => amountChipsFor({ tab, spendable, tokenBalance, state, profile, fees, profileName }),
    [tab, spendable, tokenBalance, state, profile, fees, profileName],
  )

  const available = tab === 'sell' ? tokenBalance : spendable
  const button = buttonFor({
    connection,
    chainName,
    symbol,
    tab,
    amount,
    quote,
    available,
    approval,
    simulation,
    phase,
  })

  let priceBefore: bigint | null = null
  try {
    priceBefore = priceWeiPerToken(state.virtualQuoteReserves, state.virtualTokenReserves)
  } catch {
    // Sanal rezervler zincirde her zaman pozitif; yine de bir kota satiri
    // ugruna butun paneli dusurmeye degmez.
    priceBefore = null
  }

  const press = useCallback(() => {
    switch (button.intent) {
      case 'connect':
        onConnect?.()
        return
      case 'switch':
        onSwitch?.()
        return
      case 'approve':
        onApprove?.()
        return
      case 'ready':
        if (plan !== null) onSubmit?.(plan)
        return
      default:
        return
    }
  }, [button.intent, onApprove, onConnect, onSubmit, onSwitch, plan])

  const unit = tab === 'spend' ? 'USDC' : symbol
  const label =
    tab === 'spend' ? 'Amount to spend' : tab === 'receive' ? 'Tokens to buy' : 'Tokens to sell'

  return (
    <Card className="flex flex-col gap-3 px-4 py-4" data-testid="trade-panel">
      <Tabs
        items={TRADE_TABS.map((id) => ({ id, label: TAB_LABEL[id] }))}
        value={tab}
        onChange={(next) => {
          setTab(next as TradeTab)
          // Birimi degisen bir alanda eski METNI birakmak, "1.5" yazan bir
          // USDC tutarini 1,5 TOKEN'e cevirir ve kullanici bunu fark etmez.
          setText('')
        }}
        label="Trade action"
        idBase="trade"
      />

      {/*
        VARSAYILAN SEKMENIN GEREKCESI EKRANDA YAZILI. Kullanici neden
        "Spend USDC"nin varsayilan oldugunu bilmezse, rezervin tepesinde
        revert eden otekine gecmesi icin bir sebebi olur.
      */}
      {tab === 'spend' ? (
        <p className="text-[12px] leading-snug text-muted" data-testid="tab-rationale">
          Spending a budget cannot fail on a stale quote: at the top of the curve the budget is
          clamped and the remainder is refunded.
        </p>
      ) : null}

      <div
        role="tabpanel"
        id={`trade-panel-${tab}`}
        aria-labelledby={`trade-tab-${tab}`}
        className="flex flex-col gap-3"
      >
        <AmountInput
          label={label}
          unit={unit}
          value={text}
          onChange={setText}
          {...(parsed.ok || parsed.reason === null ? {} : { error: parsed.reason })}
        />

        {/*
          MONEY CHIPS. The user picks dollars on EVERY tab; the resolution into
          the field's own unit already happened in `amountChipsFor`, through the
          planner for this tab's entrypoint.
        */}
        <AmountChips chips={chips} onPick={(chip: AmountChip) => setText(fieldText(chip.fill))} />

        <div className="flex items-center justify-between gap-2">
          {/*
            TEK BIR USDC FIGURU. Ayni fonun iki gorunumunu (18 ondalikli
            native, 6 ondalikli ERC-20) iki satir olarak yazmak, 1e12'lik bir
            hatanin gorunmez oldugu tek yerdir -- `<Money>` bu yuzden native
            alir ve tek bir figur cizer.
          */}
          <p className="text-[12px] text-muted">
            Balance <Money native={usdcBalance} rounding="down" unit />
            {tokenBalance !== null && tab !== 'spend' ? (
              <span className="ml-2 tabular-nums">
                · {formatTokenAmount(tokenBalance)} {symbol}
              </span>
            ) : null}
          </p>
          <SpendableMaxButton
            spendable={shortcutBase}
            reason={gasReason}
            onPick={(picked: bigint) => setText(fieldText(picked))}
          />
        </div>

        {/*
          GAZ PAYI SESSIZ DEGIL. Arc'ta gaz harcanan varligin kendisiyle
          odenir; MAX'in bakiyeden kucuk olmasinin sebebi soylenmezse
          kullanici bunu bir hata sanar.
        */}
        {tab === 'spend' && spendable !== null && spendable < usdcBalance ? (
          <p className="text-[12px] text-muted" data-testid="gas-reserve-note">
            MAX leaves <Money native={usdcBalance - spendable} rounding="up" unit /> for gas. On Arc
            the gas asset is USDC too.
          </p>
        ) : null}

        {clamp?.notice !== undefined && clamp.notice !== null ? (
          <p role="status" className="text-[12px] text-negative" data-testid="clamp-notice">
            {clamp.notice} Your order was reduced to that.
          </p>
        ) : null}

        <SlippageControl value={slipBps} onChange={setSlipBps} />

        {plan !== null && priceBefore !== null ? (
          <QuoteBreakdown
            plan={plan}
            state={state}
            fees={fees}
            symbol={symbol}
            slipBps={slipBps}
            priceBeforeWei={priceBefore}
          />
        ) : null}

        {tab === 'sell' && amount !== null && amount > 0n ? (
          <ApproveStep
            symbol={symbol}
            amountTok={amount}
            approval={approval}
            phase={approvalPhase}
          />
        ) : null}

        {/*
          SIMULASYON REVERT ETTIYSE CUZDAN PENCERESI HIC ACILMAZ. Istisna
          `kind: 'network'`: RPC geride ya da hiz siniri yediyse gonderme bir
          UYARIYLA acik kalir -- simulasyonun basarisizligi islemin
          basarisizligi demek degildir.
        */}
        {simulation.kind === 'blocked' ? (
          <p
            role="alert"
            className="text-[12px] leading-snug text-negative"
            data-testid="sim-blocked"
          >
            {simulation.failure.detail}
            {simulation.failure.remedy === undefined ? null : ` ${simulation.failure.remedy}`}
          </p>
        ) : null}
        {simulation.kind === 'unverified' ? (
          <p
            role="status"
            className="text-[12px] leading-snug text-muted"
            data-testid="sim-unverified"
          >
            We could not check this trade against the chain: {simulation.failure.title}. You can
            still send it.
          </p>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          disabled={button.disabled}
          onClick={press}
          data-testid="trade-submit"
        >
          {button.label}
        </Button>

        {phase === 'pending' && hash !== undefined ? (
          <p role="status" className="text-[12px] text-muted" data-testid="tx-pending">
            Submitted.{' '}
            {explorerUrl === undefined ? (
              <span className="tabular-nums">{hash}</span>
            ) : (
              <a className="underline" href={`${explorerUrl}/tx/${hash}`} rel="noreferrer">
                View on the explorer
              </a>
            )}
          </p>
        ) : null}

        {realised !== null ? <Realised realised={realised} symbol={symbol} /> : null}

        {/*
          BASARISIZLIK METNI TASK 14'UN YUZEYINDEN GELIR, PANELIN KENDI
          KUTUSUNDAN DEGIL.

          BURASI OLCULEREK BULUNDU. Panel `decodeArcpadError`'un ham ciktisini
          KENDI kirmizi kutusuna basiyordu, ve o kutu KULLANICI REDDI icin de
          ciziliyordu: `role="alert"`, `text-negative`, "Transaction
          cancelled". Yani kullanicinin bilerek verdigi karar ona bir HATA
          olarak gosteriliyordu -- Task 14'un `tone: 'neutral'` dali tam olarak
          bunu engellemek icin yazilmisti ve HICBIR SAYFA `FailureNotice`'i
          cizmiyordu. Bileseninin testi vardi; ULASILABILIR degildi. Tarayici
          acilmadan gorunmedi (`web/e2e/local/launch-and-trade.spec.ts`, adim 7).

          `readFailure` cozucunun ciktisini metne cevirir ve tonu o belirler:
          `neutral` -> cerceve yok, zemin yok, kirmizi yok. Baglami da burasi
          verir; `symbol` olmadan metin "tokens" der, `gasReserveWei` olmadan
          fon yetersizligi tek kalem gorunur.
        */}
        {failure !== null ? (
          <FailureNotice
            failure={readFailure(failure, {
              symbol,
              realTokenReservesTok: state.realTokenReserves,
              ...(amount === null ? {} : { tradeAmountWei: amount }),
              ...(spendable === null ? {} : { gasReserveWei: usdcBalance - spendable }),
              ...(plan === null ? {} : { sentValueWei: plan.value }),
            })}
            {...(hash === undefined ? {} : { hash })}
            {...(onSwitch === undefined ? {} : { onSwitchNetwork: onSwitch })}
            className="text-[12px]"
          />
        ) : null}
      </div>
    </Card>
  )
}

/**
 * ONAYLANAN MIKTARLAR OLAYDAN. Kota DEGIL.
 *
 * Kisma, iade ve curve'u kapatan son islem -- uc durumda talep ile gerceklesen
 * ayrisir. Kotayi "onaylandi" diye yazan bir ekran, o uc durumda olmayan bir
 * sayi gosterir.
 */
function Realised({ realised, symbol }: { realised: RealisedTrade; symbol: string }) {
  const { row, walletDeltaWei, refundWei, clamped } = realised
  return (
    <div role="status" className="text-[12px] leading-snug" data-testid="tx-confirmed">
      <p className="font-medium text-positive">
        {row.isBuy ? 'Bought' : 'Sold'}{' '}
        <span className="tabular-nums" data-testid="realised-tokens">
          {formatTokenAmount(row.tokenAmountTok)} {symbol}
        </span>{' '}
        {row.isBuy ? 'for' : 'for'}{' '}
        <span data-testid="realised-usdc">
          <Money native={walletDeltaWei} rounding={row.isBuy ? 'up' : 'down'} unit />
        </span>
      </p>
      {clamped && refundWei !== null && refundWei >= REFUND_DISPLAY_FLOOR ? (
        <p className="text-muted" data-testid="realised-refund">
          Filled to the remaining supply; <Money native={refundWei} rounding="down" unit />{' '}
          refunded.
        </p>
      ) : null}
    </div>
  )
}

/** wei -> alanin kabul ettigi metin. Gruplama YOK: `parseUsdcAmount` virgul almaz. */
function formatUsdcInput(wei: bigint): string {
  const units = wei / 1_000_000_000_000n
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`
}

// --------------------------------------------------------------------------
// Baglanmis panel
// --------------------------------------------------------------------------

export type TradePanelProps = {
  /** `LaunchToken` adresi. `approve` bunun uzerine yazilir. */
  readonly token: HexAddress
  /** `BondingCurve` adresi. Butun okumalar ve uc giris noktasi buradadir. */
  readonly curve: HexAddress
  readonly lifecycle: Lifecycle
  /** Sunucudan: `getCurveProfile()`. `T`, `V`, `S` -- ilerleme ve fiyat bundan. */
  readonly profile: CurveProfile
  /**
   * AYNI OKUMANIN DIGER YARISI. `getCurveProfile()` uclugu fabrikadan okur VE
   * `PROFILE_DIGESTS`e karsi hash'leyerek adlandirir; sayfa bugune kadar adi
   * atiyordu. Para kisayollarinin merdiveni buna baglidir -- iki profil `V`de
   * 1000 kat ayrisir, yani ayni merdiven ikisinde birden dogru olamaz.
   */
  readonly profileName: ProfileName
  readonly symbol: string
}

export function TradePanel({
  token,
  curve,
  lifecycle,
  profile,
  profileName,
  symbol,
}: TradePanelProps) {
  const router = useRouter()
  const network = useArcNetwork()
  const { state, fees, refetch: refetchCurve } = useCurveState(curve)
  const balance = useUsdcBalance()
  const account = network.address as HexAddress | undefined

  const [report, setReport] = useState<QuoteReport>({ tab: DEFAULT_TAB, plan: null, amount: null })

  const tokenBalance = useReadContract({
    address: token as `0x${string}`,
    abi: launchTokenAbi,
    functionName: 'balanceOf',
    args: [account as `0x${string}`],
    query: { enabled: account !== undefined },
  })

  // ONAY YALNIZCA SATISTA. Alim tarafinda `allowance` diye bir sey yok --
  // `msg.value` ile odenir ve kontratin token'a dokunmasi gerekmez.
  const needsAllowance = report.tab === 'sell' ? report.amount : null
  const approval = useApproval(token, curve, account, needsAllowance)

  const plan = report.plan

  /**
   * GAZ TAHMINI ICIN BIR PLAN HER ZAMAN GEREKIR -- alan bosken bile.
   *
   * Aksi halde MAX ilk kullanimda hic calismaz: pay hesabi bir plana, plan ise
   * kullanicinin henuz yazmadigi tutara bagli olurdu. Sonda bir mikro-USDC'lik
   * bir `buyExactQuoteIn`: giris noktasi ayni, depo yazimlari ayni, degisen tek
   * sey aritmetigin islenenleri. ×3/2 marji bu farki fazlasiyla kapsar.
   */
  const probe = useMemo(() => {
    if (state === undefined || fees === undefined) return null
    try {
      return planBuyExactQuoteIn(state, profile, fees, GAS_PROBE_BUDGET_WEI, 0)
    } catch {
      return null
    }
  }, [state, fees, profile])

  const gasPlan = plan ?? probe
  const gasRequest =
    gasPlan === null || account === undefined
      ? null
      : {
          to: curve,
          data: encodeFunctionData({
            abi: bondingCurveAbi,
            functionName: gasPlan.action,
            args: gasPlan.args as never,
          }),
          value: gasPlan.value,
          account,
        }
  const gas = useGasReserve(gasRequest)

  /**
   * SIMULASYON, TAM ARGS VE `value` ILE.
   *
   * Onay hâlâ gerekiyorken calistirilmaz: `sellExactTokensIn` o durumda
   * `ERC20InsufficientAllowance` ile revert eder ve panel, kullanicinin
   * yapmasi gereken sey "Approve"a basmakken ona "bu islem revert ediyor"
   * derdi.
   */
  const simulate = useSimulateContract(
    plan === null || account === undefined || network.wrongNetwork || approval.state === 'required'
      ? { query: { enabled: false } }
      : {
          address: curve as `0x${string}`,
          abi: bondingCurveAbi,
          functionName: plan.action,
          args: plan.args as never,
          // Bkz. `useTrade.ts`: uc giris noktasinin ikisi `payable`, biri
          // degil; cast tipi yumusatir, sayiyi degil.
          value: plan.value as never,
          account,
          query: { enabled: true },
        },
  )

  const trade = useTrade(curve)

  // ONAY GELDIGINDE: rezervler, bakiyeler ve sunucu bileşeni verisi tazelenir.
  // Indexer birkac blok geride olabilir ve islem listesi hemen guncellenmezse
  // bu bir HATA DEGILDIR -- iyimser bir satir UYDURULMAZ; makbuzdan gelen
  // gercek satir `trade.realised.row` olarak disari verilir.
  const confirmedSeq = trade.realised?.row.eventSeq ?? null
  useEffect(() => {
    if (confirmedSeq === null) return
    refetchCurve()
    balance.refetch()
    void tokenBalance.refetch()
    approval.refetch()
    router.refresh()
    // Yalnizca ONAY ANINDA kosar. Diger bagimliliklar (`balance`, `approval`,
    // `router`) her render'da kimlik degistirir ve efekti sonsuz bir yenileme
    // dongusune sokardi.
  }, [confirmedSeq])

  /*
   * KAPALI BIR CURVE'DE FORM HIC CIZILMEZ -- AMA MAKBUZ KALIR.
   *
   * Uc giris noktasi da `CurveComplete()` ile revert eder, dolayisiyla form
   * gitmelidir. Zincirin `complete`'i veritabaninin `lifecycle`'indan ONCE
   * gelir, yani ikisi de kontrol edilir.
   *
   * MAKBUZUN KALMASI OLCULEREK EKLENDI. Onceden burasi `null` donuyordu ve
   * SONUCU suydu: curve'u KAPATAN islem -- bir kullanicinin yapacagi EN BUYUK
   * alim, ve tek IADE aldigi islem -- onaylandiktan hemen sonra
   * `router.refresh()` sunucuyu `complete` durumunda yeniden cizdiriyor, panel
   * DOM'dan kalkiyor ve makbuz onunla birlikte gidiyordu. Kullanici 12 USDC
   * harciyor, bir kismi iade ediliyor, ve iadeyi gosteren tek satir kayboluyor.
   *
   * Tarayici acilmadan gorunmedi: birim testleri paneli `complete` durumunda
   * `null` donduruyor diye YESILDI -- iddia edilen sey buydu.
   */
  const closedReceipt =
    trade.realised === null ? null : (
      <Card className="flex flex-col gap-3 px-4 py-4" data-testid="trade-receipt">
        <Realised realised={trade.realised} symbol={symbol} />
        <p className="text-[12px] text-muted">
          The curve is complete, so there is nothing left to buy or sell here. This is your receipt
          for the trade that closed it.
        </p>
      </Card>
    )

  if (lifecycle.kind !== 'trading') return closedReceipt
  if (state === undefined || fees === undefined) return null
  if (state.complete) return closedReceipt

  const connection: ConnectionState = network.wrongNetwork
    ? 'wrongNetwork'
    : network.status === 'connected'
      ? 'connected'
      : 'disconnected'

  const simulation = verdictOf(simulate.error, plan?.action ?? 'buyExactQuoteIn')

  return (
    <TradeForm
      symbol={symbol}
      state={state}
      profile={profile}
      profileName={profileName}
      fees={fees}
      connection={connection}
      chainName={chainNameOf()}
      spendable={spendableFrom(balance.native.wei, gas.reserve)}
      gasReason={gas.reason}
      usdcBalance={balance.native.wei}
      tokenBalance={(tokenBalance.data as bigint | undefined) ?? null}
      approval={approval.state}
      approvalPhase={approval.phase}
      simulation={simulation}
      phase={trade.phase}
      hash={trade.hash}
      failure={trade.failure ?? approval.failure}
      realised={trade.realised}
      explorerUrl={getWebConfig().chain.blockExplorers.default.url}
      onConnect={() => {
        // Baglanma kabuktaki cuzdan dugmesinindir; panel yalnizca oraya isaret
        // eder. Iki ayri baglanma akisi, iki ayri connector listesi demek olurdu.
        document.querySelector<HTMLElement>('[data-wallet-connect]')?.click()
      }}
      onSwitch={network.switchToArc}
      onApprove={approval.approve}
      onSubmit={trade.submit}
      onQuote={setReport}
    />
  )
}

/** Zincirin adi ADRES DEFTERINDEN. Bir literal olsaydi Faz 2'de eskirdi. */
function chainNameOf(): string {
  return getWebConfig().chain.name
}

/**
 * SIMULASYON HATASINI IKI SINIFA AYIRIR.
 *
 * `network` -> RPC geride ya da hiz siniri: gonderme ACIK kalir.
 * Digerleri   -> zincir bu islemi reddediyor: cuzdan penceresi HIC acilmaz.
 *
 * Ayrimi `decodeArcpadError` yapiyor; burada yalnizca hangi tarafa dustugu
 * okunuyor. Iki siniflandirma olsaydi biri "ag hatasi" derken oteki "revert"
 * der ve kullanici iki farkli tavsiye alirdi.
 */
export function verdictOf(
  error: unknown,
  action: Parameters<typeof decodeArcpadError>[1]['action'],
): SimulationVerdict {
  if (error === null || error === undefined) return { kind: 'ok' }
  const failure = decodeArcpadError(error, { action })
  return failure.kind === 'network' ? { kind: 'unverified', failure } : { kind: 'blocked', failure }
}
