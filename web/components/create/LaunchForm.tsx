'use client'

import { METADATA_LIMITS, parseUsdcAmount } from '@arcpad/shared/browser'
import { useCallback, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Money } from '@/components/ui/Money'
import { UsdcMark } from '@/components/ui/UsdcMark'
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
        {/*
          AD VE SEMBOL YAN YANA, VE BOLUM BASLIGI YOK.

          Onceden her ikisi tam genislikte, ustlerinde bir baslik ve iki
          satirlik bir aciklama vardi. Iki kisa alan icin uc satirlik cerceve,
          formu okunmasi gereken bir DOKUMAN haline getiriyordu; oysa bir
          launch formu DOLDURULUR. Degismezlik uyarisi kalir ama tek satira
          iner ve alanlarin ALTINA gecer -- once ne yazacagini gor, sonra
          bunun kalici oldugunu ogren.
        */}
        <section aria-labelledby="onchain-heading" className="flex flex-col gap-3">
          <h2 id="onchain-heading" className="sr-only">
            Name and ticker
          </h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
            <div className="flex flex-col gap-1.5">
              <Input
                label="Name"
                placeholder="Token name"
                value={fields.name}
                onChange={(event) => patch({ name: event.target.value })}
                {...(launch.fieldErrors.name ? { error: launch.fieldErrors.name } : {})}
              />
              <ByteCounter value={fields.name} maxBytes={METADATA_LIMITS.name} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Input
                label="Ticker"
                placeholder="symbol"
                value={fields.symbol}
                onChange={(event) => patch({ symbol: event.target.value })}
                {...(launch.fieldErrors.symbol ? { error: launch.fieldErrors.symbol } : {})}
              />
              <ByteCounter value={fields.symbol} maxBytes={METADATA_LIMITS.symbol} />
            </div>
          </div>

          <p className="text-[13px] text-muted">Both go on chain and cannot be changed later.</p>
        </section>

        <section aria-labelledby="offchain-heading" className="flex flex-col gap-4">
          <h2 id="offchain-heading" className="sr-only">
            Description, artwork and links
          </h2>

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

          {/* Iki baglanti YAN YANA: ikisi de kisa ve ikisi de istege bagli. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/*
              SABIT KISIM EKRANDA, KULLANICI YALNIZCA KULLANICI ADINI YAZAR.
              Tam URL yazdirmak gereksiz bir is ve bir belirsizlik kaynagi:
              "https://x.com/ad" mi, "x.com/ad" mi, "@ad" mi? Onek bunu
              gosterir ve soruyu ortadan kaldirir.
            */}
            <Input
              label="X profile"
              prefix="x.com/"
              placeholder="handle"
              value={fields.x}
              onChange={(event) => patch({ x: event.target.value })}
            />
            <Input
              label="Telegram"
              prefix="t.me/"
              placeholder="community"
              value={fields.telegram}
              onChange={(event) => patch({ telegram: event.target.value })}
            />
          </div>

          {/*
            CREATOR-FUNDED BUYBACK.

            METIN, BEDELI ONCE SOYLER. Bu kutu creator'in KENDI ucret gelirinin
            yarisini baglar ve geri alinan tokenlarin %30'u bes yilin sonunda
            PROTOKOLE gider. Yalnizca faydayi anlatan bir etiket ("token'ini
            destekle") dogru ama EKSIK olurdu; kullanicinin isaretlemeden once
            bilmesi gereken sey bedeldir.

            VARSAYILAN KAPALI (`EMPTY_FIELDS`), ve geri alinabilir: creator
            launch'tan sonra token sayfasindan kapatabilir. Bunu yazmak,
            kutunun "geri donusu olmayan" gibi okunmasini engelliyor.
          */}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
            <input
              type="checkbox"
              checked={fields.buyback}
              disabled={busy}
              onChange={(event) => patch({ buyback: event.target.checked })}
              className="mt-0.5"
            />
            <span className="text-[13px] leading-relaxed">
              <span className="font-medium">Fund a buyback from my fees</span>
              <span className="block text-muted">
                Half of your creator fees buy your token back on the market and lock it for five
                years. 30% of what is bought goes to the protocol at the end. You can turn this off
                later.
              </span>
            </span>
          </label>

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
        <p data-testid="fixed-parameters" className="text-[13px] text-muted">
          Curve parameters are the same for every launch.
        </p>

        <section aria-labelledby="devbuy-heading" className="flex flex-col gap-3">
          <div>
            <h2 id="devbuy-heading" className="text-base font-semibold">
              Developer buy (optional)
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
            {/*
              UC PARAGRAF YERINE IKI CUMLE.

              Onceden burada uc ayri aciklama alt alta duruyordu: "ayri bir
              islem", "tavan yok", ve iade cumlesi. Ucu de DOGRUYDU ve ucu de
              ust uste okundugunda hicbiri okunmuyordu -- bir form alaninin
              ustundeki uc satirlik metin, alanin kendisini gozden siler.

              KALAN IKI OLGU, VE IKISI DE ATILAMAZ:
              (1) TAVAN YOK. `LaunchFactory.launch` `payable` degildir ve
                  hicbir yerde tavan kontrolu yoktur; arayuzun gosterecegi bir
                  tavan yalan olurdu, ve tavani SOYLEMEMEK daha kotudur --
                  kullanici olmayan bir korumaya guvenerek buyuk bir ilk alim
                  yapar.
              (2) FAZLASI IADE EDILIR. `buyExactQuoteIn` kalan rezervi satar ve
                  artani AYNI islemde geri oder; bunu imzadan once bilmeyen
                  biri 1000 harcadigini sanir.
            */}
            <p className="mt-1 text-[13px] leading-snug text-muted">
              A separate transaction, with no cap — you can buy the whole curve.
            </p>
            {facts === null ? null : (
              <p data-testid="refund-note" className="mt-1 text-[13px] leading-snug text-muted">
                The whole curve costs{' '}
                <span className="font-medium text-text">
                  <Money native={facts.fullCurveBudgetWei} rounding="up" unit />
                </span>
                . Anything above that is refunded in the same transaction.
              </p>
            )}
          </div>

          <Input
            label="Amount"
            hideLabel
            inputMode="decimal"
            placeholder="0.00"
            suffix={<UsdcMark size={16} />}
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
              {...(connected ? { type: 'submit' as const } : { type: 'button' as const })}
              variant="primary"
              size="lg"
              disabled={connected && (busy || buyInvalid)}
              className="w-full"
              {...(connected
                ? {}
                : {
                    onClick: () => {
                      /*
                       * TEK DUGME, TEK BAGLAYICI LISTESI.
                       *
                       * Onceki hal DEVRE DISI bir "Connect wallet" cizip
                       * altina "yukaridaki dugmeyi kullan" yaziyordu.
                       * Kullanici formu doldurmus, imzalamaya hazir, ve ona
                       * ekranin baska bir yerine gitmesi soyleniyordu.
                       *
                       * Ikinci bir `<WalletButton>` cizmek yerine ONUN
                       * dugmesine basiliyor: o bilesen `data-wallet-connect`
                       * tasiyor ve `TradePanel` de ayni yoldan geciyor.
                       * Iki ayri EIP-6963 listesi kurmak, o bilesenin kendi
                       * yorumunun yasakladigi sey.
                       */
                      document.querySelector<HTMLElement>('[data-wallet-connect]')?.click()
                    },
                  })}
            >
              {!connected ? 'Connect wallet' : busy ? SUBMIT_BUSY_LABEL[launch.status] : 'Launch'}
            </Button>
          )}

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
