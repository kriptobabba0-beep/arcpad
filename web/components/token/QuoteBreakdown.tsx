'use client'

import {
  type CurveState,
  type FeeBps,
  formatTokenAmount,
  netProceedsOf,
  type TradePlan,
  totalSpentOf,
} from '@arcpad/shared/browser'
import type { ReactNode } from 'react'
import { cx } from '@/components/ui/cx'
import { Money } from '@/components/ui/Money'
import {
  BOUND_LABEL,
  formatBps,
  formatProgressPercent,
  formatSignedPercent,
  formatSlipBps,
  priceImpactPpm,
  PRICE_IMPACT_NOTE,
  PRICE_IMPACT_WARN_PPM,
} from './tradeModel'

/**
 * DOKUM VARSAYILAN OLARAK ACIKTIR, ve bu pons'tan bilincli bir ayrilma.
 *
 * arcpad'in ucreti IKI PARCADAN toplanir (protokol 95 bps + creator 30 bps) ve
 * alim/satim tarafinda FARKLI YONDE uygulanir: alimda curve tutarinin USTUNE
 * eklenir, satimda curve ciktisindan DUSULUR. Katlanmis bir dokum bu ikisini
 * cikarsanamaz kilar -- kullanici tek bir "toplam" gorur ve hangi tarafta ne
 * odedigini bir daha bulamaz.
 *
 * UC KURAL, hepsi olculmus bir sebebe bagli:
 *
 * 1. UCRET SATIRLARI MUTLAK DEGERDIR ve `plan`'dan gelir; bir yuzdenin girdiye
 *    uygulanmasiyla URETILMEZ. Olculdu (K2): 1,000000 USDC butceli bir alimda
 *    toplam ucret butcenin %1,2345679'u, %1,25'i DEGIL -- cunku %1,25 CURVE
 *    tutarinin uzerinedir. Yuzde etiketi bu yuzden "of the curve amount" der.
 *    `feeOn(spend, 125)` yazan mutant burada olur.
 *
 * 2. IKI PARCA IKI SATIR. Toplayip tek satir yazmak, iki tavan yuvarlamasinin
 *    toplami ile birlesik oranin tek yuvarlamasi arasindaki farki gorunmez
 *    kilar -- canli zincirde olculdu, ticaret #1'de bir wei, ve escrow toplanmis
 *    olani tutuyor. Bu, `feeOn(q,125)`'in bu depoda yasak olmasinin ayni
 *    gerekcesi.
 *
 * 3. YUVARLAMA YONLERI ARITMETIGI EKRANDA TUTARLI KILAR. Curve tutari ASAGI,
 *    ucretler YUKARI (`walletDelta.ts`: "ucret bir maliyettir"), toplam YUKARI.
 *    Olculmus 1 USDC vektorunde bu ucu TAM OLARAK toplanir:
 *      0,987654 + 0,009383 + 0,002963 = 1,000000
 *    ve satista TAM OLARAK cikarilir:
 *      0,987654 - 0,009383 - 0,002963 = 0,975308
 *    Ucretleri ASAGI yuvarlayan bir dokum alimda 0,999998, satista 0,975310
 *    yazar; iki sayi da ekranin geri kalaniyla celisir.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type QuoteBreakdownProps = {
  readonly plan: TradePlan
  readonly state: CurveState
  readonly fees: FeeBps
  readonly symbol: string
  readonly slipBps: number
  /** Islemden ONCEKI fiyat. Etki bundan turetilir. */
  readonly priceBeforeWei: bigint
}

function Row({
  id,
  label,
  children,
  indent = false,
  tone,
}: {
  id: string
  label: string
  children: ReactNode
  indent?: boolean
  tone?: 'negative' | undefined
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px]">
      <dt className={cx('text-[13px] text-muted', indent && 'pl-3')} data-testid={`label-${id}`}>
        {label}
      </dt>
      <dd
        className={cx('text-[13px] tabular-nums', tone === 'negative' && 'text-negative')}
        data-testid={`quote-${id}`}
      >
        {children}
      </dd>
    </div>
  )
}

const Usdc = ({ native, rounding }: { native: bigint; rounding: 'up' | 'down' }) => (
  <>
    <Money native={native} rounding={rounding} /> <span className="text-muted">USDC</span>
  </>
)

export function QuoteBreakdown({
  plan,
  state,
  fees,
  symbol,
  slipBps,
  priceBeforeWei,
}: QuoteBreakdownProps) {
  const isSell = plan.action === 'sellExactTokensIn'
  const noCreator = state.creator.toLowerCase() === ZERO_ADDRESS
  const impactPpm = priceImpactPpm(priceBeforeWei, plan.priceAfterWeiPerToken)
  const highImpact = Math.abs(impactPpm) >= PRICE_IMPACT_WARN_PPM
  const protocolLabel = `Protocol fee (${formatBps(fees.protocolFeeBps)})`
  const creatorLabel = `Creator fee (${formatBps(fees.creatorFeeBps)})`
  const slip = formatSlipBps(slipBps)
  // SINIR ARGUMANI PLANDAN OKUNUR, YENIDEN TURETILMEZ: `minQuoteOut` zincire
  // giden sayinin ta kendisi, ve ekranda baska bir sey yazmak kullaniciya
  // imzalamadigi bir taban gostermek olurdu. `args` uzunluga gore
  // daraltiliyor -- `sellExactTokensIn` iki argumanli, digerleri degil.
  const minQuoteOut = plan.args.length === 2 ? plan.args[1] : 0n

  return (
    <details open data-testid="quote-breakdown" className="rounded-input bg-surface-2 px-3 py-2">
      <summary className="cursor-pointer list-none text-[13px] font-medium">
        Breakdown
        <span className="ml-2 font-normal text-muted">
          {isSell ? 'fees come out of the proceeds' : 'fees are added on top of the curve amount'}
        </span>
      </summary>

      <dl className="mt-2">
        {isSell ? (
          <>
            {/*
              SATIS DOKUMU AYRI BIR METIN SABLONUDUR, ortak bir bilesen degil.
              Etiketler alim sablonununkilerden FARKLIDIR ve bir test bunu
              iddia eder: iki sablonu takas eden bir mutant, ayni sayilari
              ters yonde anlatan bir ekran uretir -- ucretlerin "eklendigini"
              soyleyen bir satis dokumu, kullanicinin eline gececek tutari
              oldugundan buyuk gosterir.
            */}
            <Row id="principal" label="You sell">
              {formatTokenAmount(plan.tokens)} {symbol}
            </Row>
            <Row id="curve" label="Curve amount, out of the reserves" indent>
              <Usdc native={plan.curveAmount} rounding="down" />
            </Row>
            <Row id="protocolFee" label={`${protocolLabel}, deducted`} indent>
              <Usdc native={plan.protocolFee} rounding="up" />
            </Row>
            {noCreator ? null : (
              <Row id="creatorFee" label={`${creatorLabel}, deducted`} indent>
                <Usdc native={plan.creatorFee} rounding="up" />
              </Row>
            )}
            <Row id="result" label="You receive">
              <Usdc native={netProceedsOf(plan)} rounding="down" />
            </Row>
            <Row id="bound" label={BOUND_LABEL[plan.action]}>
              <Usdc native={minQuoteOut} rounding="down" />{' '}
              <span className="text-muted">(slippage {slip})</span>
            </Row>
          </>
        ) : (
          <>
            <Row id="principal" label="You spend">
              <Usdc native={totalSpentOf(plan)} rounding="up" />
            </Row>
            <Row id="curve" label="Curve amount, into the reserves" indent>
              <Usdc native={plan.curveAmount} rounding="down" />
            </Row>
            <Row id="protocolFee" label={`${protocolLabel}, added on top`} indent>
              <Usdc native={plan.protocolFee} rounding="up" />
            </Row>
            {noCreator ? null : (
              <Row id="creatorFee" label={`${creatorLabel}, added on top`} indent>
                <Usdc native={plan.creatorFee} rounding="up" />
              </Row>
            )}
            <Row id="result" label="You receive">
              ~{formatTokenAmount(plan.tokens)} {symbol}
            </Row>
            <Row id="bound" label={BOUND_LABEL[plan.action]}>
              {plan.action === 'buyExactQuoteIn' ? (
                <>
                  {formatTokenAmount(plan.args[0])} {symbol}
                </>
              ) : (
                <Usdc native={plan.value} rounding="up" />
              )}{' '}
              <span className="text-muted">(slippage {slip})</span>
            </Row>
          </>
        )}

        <Row id="impact" label="Price impact" tone={highImpact ? 'negative' : undefined}>
          {formatSignedPercent(impactPpm)}
        </Row>
        <Row id="progress" label="Progress after">
          {formatProgressPercent(plan.progressPpmAfter)}
        </Row>
      </dl>

      {/*
        SIFIR YAZMAK "ALINDI AMA SIFIR" GIBI OKUNUR. Asil gercek alinmadigi ve
        protokol payina KATLANMADIGIDIR: `creator == address(0)` olan bir
        launch'ta islem 30 bps DAHA UCUZDUR. Bir satir olarak soylenmezse
        kullanici bunu hicbir yerden ogrenemez.
      */}
      {noCreator ? (
        <p className="mt-1 text-[12px] text-muted" data-testid="quote-noCreatorFee">
          No creator fee on this launch.
        </p>
      ) : null}

      {highImpact ? (
        <p role="status" className="mt-1 text-[12px] leading-snug text-negative">
          {PRICE_IMPACT_NOTE}
        </p>
      ) : null}

      {/*
        GIDIS-DONUS GERCEGI, BIR KEZ VE SATIS TARAFINDA. Olculdu: 1,000000 USDC
        ile alip hemen satan kullanici 0,975308 USDC alir -- kayip
        24_691_358_024_691_361 wei, yani %2,4691. Ucret iki bacakta da alinir
        ve bu bir surpriz olmamali; alim tarafinda soylemek ise kullaniciyi
        henuz yapmadigi bir islem hakkinda uyarmak olurdu.
      */}
      {isSell ? (
        <p className="mt-1 text-[12px] leading-snug text-muted" data-testid="quote-roundTrip">
          Round trip: buying with 1.000000 USDC and selling straight back leaves 0.975308 USDC. The
          fee is charged on both legs, so a round trip costs 2.4691%.
        </p>
      ) : null}
    </details>
  )
}
