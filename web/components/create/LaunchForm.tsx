'use client'

import { METADATA_LIMITS, parseUsdcAmount } from '@arcpad/shared/browser'
import { useCallback, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Money } from '@/components/ui/Money'
import { getWebConfig } from '@/lib/addresses'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { ByteCounter } from './ByteCounter'
import type { LaunchFacts } from './facts'
import { descriptionState, EMPTY_FIELDS, type LaunchFields } from './fields'
import { LaunchResult } from './LaunchResult'
import { MetadataUpload } from './MetadataUpload'
import { TokenPreviewCard } from './TokenPreviewCard'
import { type LaunchDriver, useLaunch } from './useLaunch'

/**
 * LAUNCH FORMU.
 *
 * ZINCIRE GIDEN UC ALAN VE GITMEYEN DORT ALAN AYRI CIZILIR. Sebep gorsel
 * degil: isim, sembol ve metadata URI'si kalicidir -- sonradan mint yolu,
 * isim degistirme yolu, URI degistirme yolu YOKTUR. Aciklama, gorsel ve
 * sosyal baglantilar ise metadata dosyasinin icindedir ve o dosya
 * degisebilir. Iki grubu ayni kutuya koymak, ilkinin kaliciligini gizler.
 */

export type LaunchFormProps = {
  facts: LaunchFacts | null
  pinningConfigured: boolean
  /** Yalnizca testler icin: zincire dokunan uc islem. */
  driver?: LaunchDriver
}

export function LaunchForm({ facts, pinningConfigured, driver }: LaunchFormProps) {
  const [fields, setFields] = useState<LaunchFields>(EMPTY_FIELDS)
  const [buyAmount, setBuyAmount] = useState('')
  const { status: connection, wrongNetwork, switchToArc, isSwitching } = useArcNetwork()
  const launch = useLaunch(driver === undefined ? {} : { driver })
  const descriptionId = useId()
  const { chain } = getWebConfig()

  const patch = useCallback((next: Partial<LaunchFields>) => {
    setFields((current) => ({ ...current, ...next }))
  }, [])

  const description = descriptionState(fields.description)
  const buy = buyAmount.trim() === '' ? null : parseUsdcAmount(buyAmount)
  const buyInvalid = buy !== null && !buy.ok

  const connected = connection === 'connected'
  const busy =
    launch.status === 'validating' ||
    launch.status === 'simulating' ||
    launch.status === 'awaitingSignature' ||
    launch.status === 'pending'

  if (launch.status === 'launched' && launch.result) {
    return (
      <LaunchResult
        token={launch.result.token}
        curve={launch.result.curve}
        {...(buyAmount.trim() === '' ? {} : { buyAmount: buyAmount.trim() })}
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!connected || wrongNetwork || busy || buyInvalid) return
          void launch.submit(fields)
        }}
        className="flex flex-col gap-6"
      >
        <section aria-labelledby="onchain-heading" className="flex flex-col gap-4">
          <div>
            <h2 id="onchain-heading" className="text-base font-semibold">
              On chain, forever
            </h2>
            <p className="mt-1 text-[13px] leading-snug text-muted">
              These three go into the transaction and cannot be changed afterwards. There is no
              rename, and there is no second mint.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Input
              label="Name"
              placeholder="Diffusion"
              value={fields.name}
              onChange={(event) => patch({ name: event.target.value })}
              {...(launch.fieldErrors.name ? { error: launch.fieldErrors.name } : {})}
            />
            <ByteCounter value={fields.name} maxBytes={METADATA_LIMITS.name} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Input
              label="Symbol"
              placeholder="DIFF"
              value={fields.symbol}
              onChange={(event) => patch({ symbol: event.target.value })}
              {...(launch.fieldErrors.symbol ? { error: launch.fieldErrors.symbol } : {})}
            />
            <ByteCounter value={fields.symbol} maxBytes={METADATA_LIMITS.symbol} />
          </div>
        </section>

        <section aria-labelledby="offchain-heading" className="flex flex-col gap-4">
          <div>
            <h2 id="offchain-heading" className="text-base font-semibold">
              In the metadata file
            </h2>
            <p className="mt-1 text-[13px] leading-snug text-muted">
              The description, the artwork and the links are not on chain. They live in the JSON
              your metadata URI points at.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={descriptionId} className="text-[13px] font-medium text-muted">
              Description
            </label>
            <textarea
              id={descriptionId}
              rows={3}
              value={fields.description}
              onChange={(event) => patch({ description: event.target.value })}
              className="rounded-input border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none transition-colors duration-150 placeholder:text-muted focus:border-white/25"
            />
            {/*
              BURADA BAYT DEGIL KARAKTER SAYILIR, ve bu bir tutarsizlik degil
              bir eslesmedir: aciklama zincire hic gitmez, onu kirpacak olan
              OKUYUCUDUR ve `web/lib/metadata.ts` bunu `.slice(0, 256)` ile
              yapar -- `.slice` UTF-16 kod birimi sayar. Bayt gostermek,
              kullaniciya token sayfasinda gorecegi sayidan baska bir sayi
              vermek olurdu.
            */}
            <span
              className={`tabular-nums text-[12px] ${description.over ? 'text-negative' : 'text-muted'}`}
            >
              {description.used}/{description.limit} characters
            </span>
          </div>

          <Input
            label="X"
            placeholder="https://x.com/…"
            value={fields.x}
            onChange={(event) => patch({ x: event.target.value })}
          />
          <Input
            label="Telegram"
            placeholder="https://t.me/…"
            value={fields.telegram}
            onChange={(event) => patch({ telegram: event.target.value })}
          />

          <MetadataUpload
            pinningConfigured={pinningConfigured}
            fields={fields}
            onPatch={patch}
            disabled={busy}
          />
        </section>

        {/*
          =====================================================================
          S16: "ADVANCED" BOLUMU CIZILMEZ.
          =====================================================================
          `launch`in UC argumani vardir ve geri kalan her parametre factory'nin
          `immutable`idir: T, V, S deploy aninda sabitlenmistir, ucretler
          `constant`tir. Creator'in ayarlayabilecegi ILERI DUZEY BIR ALAN YOKTUR.
          Katlanmis bos bir "Advanced" bolumu, olmayan bir kontrol vaat eder --
          ve bir kullaniciyi acip icinde bir sey aramaya gonderir. Ayni yere tek
          satir konur.
        */}
        <p
          data-testid="fixed-parameters"
          className="rounded-card border border-border bg-surface-2 px-4 py-3 text-[13px] text-muted"
        >
          Curve parameters are fixed for every launch.
        </p>

        <section aria-labelledby="devbuy-heading" className="flex flex-col gap-3">
          <div>
            <h2 id="devbuy-heading" className="text-base font-semibold">
              Buy after launch (optional)
            </h2>
            {/*
              =================================================================
              S4: GELISTIRICI ALIMI IKINCI BIR ISLEMDIR VE ZINCIRDE TAVAN YOKTUR.
              =================================================================
              Spec uc yerde atomik bir dev buy ve satis arzinin %5'i tavani
              tarif ediyor. KONTRATTA IKISI DE YOK: `LaunchFactory.launch`
              `payable` degildir ve hicbir alim yapmaz; hicbir yerde bir tavan
              kontrolu yoktur. Arayuzun gosterecegi herhangi bir tavan YALAN
              olurdu -- ve tavan olmadigini SOYLEMEMEK daha kotusudur:
              kullanici bir koruma varsayarak daha buyuk bir ilk alim yapar.
            */}
            <p className="mt-1 text-[13px] leading-snug text-muted">
              A separate transaction. Your launch is live either way.
            </p>
            <p data-testid="no-cap-note" className="mt-1 text-[13px] leading-snug text-muted">
              There is no cap on a creator&apos;s first buy: nothing in the contract limits it, so
              nothing here can promise one.
            </p>
            {/*
              TAVANSIZ ILE SESSIZ AYNI SEY DEGIL.

              Ustteki cumle dogru ve kalir: kontratta tavan yok, arayuzun
              uyduracagi bir tavan yalan olurdu. Ama tavani olmayan bir kutuya
              1000 yazan biri 1000 harcayacagini SANIR -- ve harcamaz:
              `buyExactQuoteIn` kalan rezervin tamamini satar, ucreti o kisilmis
              anapara uzerinden alir ve GERI KALANI AYNI ISLEMDE iade eder
              (`BondingCurve._settleBuy`; iade duserse islem komple geri doner,
              yani "iade edemedik ama tuttuk" hali yok).

              Kullanicinin bunu ISLEMI IMZALAMADAN once bilmesi gerekir. Sayi
              `graduationRaiseWei` DEGIL: o curve'e giren tutardir, bu ise
              gonderilen tutardir ve aradaki fark ucrettir (95 + 30 bps).
            */}
            {facts === null ? null : (
              <p data-testid="refund-note" className="mt-1 text-[13px] leading-snug text-muted">
                The whole curve costs{' '}
                <span className="font-medium text-text">
                  <Money native={facts.fullCurveBudgetWei} rounding="up" unit />
                </span>
                . Send more than that and the extra comes straight back in the same transaction —
                the curve sells what is left and refunds the rest.
              </p>
            )}
          </div>

          <Input
            label="Amount"
            hideLabel
            inputMode="decimal"
            placeholder="0.00"
            suffix="USDC"
            value={buyAmount}
            onChange={(event) => setBuyAmount(event.target.value)}
            {...(buyInvalid ? { error: 'Enter an amount like 12.50, or leave this empty.' } : {})}
          />
        </section>

        <div className="flex flex-col gap-2">
          {wrongNetwork ? (
            <Button
              variant="primary"
              size="lg"
              onClick={switchToArc}
              disabled={isSwitching}
              className="w-full"
            >
              {isSwitching ? 'Switching…' : `Switch to ${chain.name}`}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!connected || busy || buyInvalid}
              className="w-full"
            >
              {!connected ? 'Connect wallet' : busy ? SUBMIT_BUSY_LABEL[launch.status] : 'Launch'}
            </Button>
          )}

          {!connected && !wrongNetwork ? (
            // Devre disi bir buton klavye kullanicisi icin cikmaz sokaktir;
            // nereye gidecegi YAZILI olmali.
            <p className="text-[12px] text-muted">
              Use the Connect wallet button at the top of the page. The form keeps everything you
              have typed.
            </p>
          ) : null}

          {launch.status === 'pending' && launch.hash ? (
            <p role="status" className="text-[12px] text-muted">
              Sent. Waiting for the chain to confirm it.
            </p>
          ) : null}

          {/*
            CUZDAN REDDINDE FORM AYNEN DURUR: `fields` bu bilesenin
            state'indedir ve hicbir hata dali ona dokunmaz. En sik yasanan
            durum budur ve formu sifirlamak affedilmez.
          */}
          {launch.status === 'failed' && launch.failure ? (
            <div
              role="alert"
              data-testid="launch-failure"
              className="rounded-card border border-negative/40 bg-surface px-4 py-3"
            >
              <p className="text-sm font-medium">{launch.failure.title}</p>
              <p className="mt-1 text-[12px] leading-snug text-muted">{launch.failure.detail}</p>
              {launch.failure.remedy ? (
                <p className="mt-1 text-[12px] leading-snug text-muted">{launch.failure.remedy}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </form>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <TokenPreviewCard fields={fields} facts={facts} />
      </div>
    </div>
  )
}

/**
 * DORT BEKLEME DURUMU, DORT AYRI METIN. Tek bir "Loading…" bunlarin hepsini
 * ayni gosterirdi; oysa `Simulating` sirasinda hicbir sey imzalanmamistir ve
 * iptal bedavadir, `Confirming` sirasinda islem zincirdedir ve geri alinamaz.
 */
const SUBMIT_BUSY_LABEL: Record<string, string> = {
  validating: 'Checking…',
  simulating: 'Simulating…',
  awaitingSignature: 'Confirm in your wallet…',
  pending: 'Confirming…',
}
