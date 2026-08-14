'use client'

import { useState } from 'react'
import { InfoTip } from '@/components/ui/InfoTip'
import { formatSlipBps } from './tradeModel'

/**
 * ============================================================================
 *  MAX SLIPPAGE -- TEK SATIR, "AUTO" ILE
 * ============================================================================
 *
 * Onceki hal uc hap ve bir "Custom" kutusuydu: dort kontrol, panelin en genis
 * satiri, ve kullanicilarin %99'unun hic dokunmadigi bir karar. Referans
 * tasarim onu tek bir satira indiriyor -- "Auto 2.5%" ve bir kalem -- ve
 * dogrusu da bu: varsayilan GORUNUR olmali, degistirmek ise MUMKUN.
 *
 * ============ "AUTO" NE DEMEK, VE NE DEMEK DEGIL ============
 *
 * Auto, `DEFAULT_SLIP_BPS`i kullanir. Piyasa kosuluna gore DEGISEN bir sey
 * DEGILDIR ve oyleymis gibi sunulmaz: rozet yalnizca "bu degeri sen
 * secmedin" der. Uydurulmus bir "akilli slipaj", kullaniciya olcmedigimiz bir
 * zeka atfetmek olurdu.
 *
 * SLIPAJ BAYAT KOTAYA KARSI TEK GERCEK KORUMA. Rezervler iki saniyede bir
 * yenilenir ve Arc'in blok suresi ~0.52 sn; kullanicinin gordugu kota
 * imzaladigi anda birkac blok eskimis olabilir. Onu koruyan sey yenileme
 * sikligi degil, zincire giden `minTokensOut` / `maxQuoteIn` / `minQuoteOut`
 * argumanidir.
 */
/**
 * VARSAYILAN %2.5.
 *
 * %1'di. Bir bonding curve'de fiyat HER islemle hareket eder ve rezervler iki
 * saniyede bir yenilenir; %1, kullanicinin gordugu kotayla imzaladigi an
 * arasinda gecen birkac blokta bile dar kalip islemi gereksiz yere
 * reddettiriyor. Referans tasarimin varsayilani da %2.5.
 */
export const DEFAULT_SLIP_BPS = 250
/**
 * IKI ESIK, IKI AYRI CUMLE -- VE NICIN TEK BIR UYARI YETMEDI.
 *
 * Onceden tek esik vardi (%5) ve tek bir kirmizi cumle: "A tolerance this wide
 * lets the trade settle far from the quote you can see." Iki sorunu vardi.
 * Birincisi, %5 ile %50 AYNI gorunuyordu -- oysa biri bir tercih, oteki bir
 * kaza. Ikincisi, cumle uzundu ve tam da acele eden bir kullanicinin okumadigi
 * yerde duruyordu; bir uyari once GORULMELI, sonra okunmali.
 *
 * Simdi: %5'ten itibaren KEHRIBAR "High slippage", %20'den itibaren KIRMIZI
 * "Very high slippage". Renk ve ikon bir bakista, ikinci satir isteyen icin.
 */
export const HIGH_SLIP_BPS = 500
export const VERY_HIGH_SLIP_BPS = 2_000

export type SlipSeverity = 'ok' | 'high' | 'very-high'

/** Tek yer: hem satir hem testler bunu okur. */
export function slipSeverity(bps: number): SlipSeverity {
  if (bps >= VERY_HIGH_SLIP_BPS) return 'very-high'
  if (bps >= HIGH_SLIP_BPS) return 'high'
  return 'ok'
}

export function SlippageRow({
  value,
  auto,
  onChange,
}: {
  value: number
  /** Kullanici hic dokunmadi mi. */
  auto: boolean
  onChange: (bps: number, auto: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const severity = slipSeverity(value)

  return (
    <div className="flex flex-col gap-1.5" data-testid="slippage-row">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
          Max slippage
          <InfoTip label="What is max slippage?">
            The furthest the price may move against you before the trade is refused. It is enforced
            on chain, not by this page.
          </InfoTip>
        </span>

        {editing ? (
          <span className="inline-flex items-center gap-1.5">
            <label className="sr-only" htmlFor="slippage-custom">
              Max slippage, percent
            </label>
            <input
              id="slippage-custom"
              autoFocus
              value={text}
              onChange={(event) => {
                const next = event.target.value
                setText(next)
                const percent = Number(next)
                if (!Number.isFinite(percent) || percent < 0 || percent > 100) return
                // TAM SAYIYA yuvarlanir: planlayici `slipBps`in tam sayi
                // olmasini sart kosar (`assertSlip`) ve `0.15%` gibi bir girdi
                // aksi halde paneli komple dusururdu.
                onChange(Math.round(percent * 100), false)
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') setEditing(false)
              }}
              inputMode="decimal"
              autoComplete="off"
              placeholder="2.5"
              className="h-7 w-16 rounded-pill border border-border bg-surface-2 px-2.5 text-right text-[13px] tabular-nums outline-none focus:border-white/25"
            />
            <span className="text-[13px] text-muted">%</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            {/*
              ============ AUTO'YA DONUS YOLU HEP EKRANDA ============

              Onceki hal: `auto` iken bir rozet, degilse HICBIR SEY. Yani
              kalemle bir sayi girildikten sonra Auto'ya donmenin bir yolu
              YOKTU -- kullanici sayfayi yenilemek zorunda kaliyordu. Bir
              modun cikisi, girisi kadar gorunur olmali.

              Auto'dayken bir ETIKET (basilacak bir sey yok, zaten oradasin),
              degilken bir DUGME.
            */}
            {auto ? (
              <span
                className="rounded-pill bg-white/8 px-2 py-0.5 text-[11px] leading-none text-muted"
                data-testid="slippage-auto-badge"
              >
                Auto
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onChange(DEFAULT_SLIP_BPS, true)}
                className="rounded-pill border border-border px-2 py-0.5 text-[11px] leading-none text-muted transition-colors hover:border-white/25 hover:text-text"
                data-testid="slippage-auto-reset"
              >
                Auto
              </button>
            )}
            {/*
              DEGERIN KENDISI DE RENKLENIR. Uyari cumlesi bir satir asagida
              duruyor; goz once SAYIYA gider. Sayi notr kalirsa uyari
              "ilgisiz bir dipnot" gibi okunur.
            */}
            <span
              className={['text-[13px] tabular-nums', severity === 'ok' ? '' : 'text-caution'].join(
                ' ',
              )}
              data-testid="slippage-value"
            >
              {formatSlipBps(value)}
            </span>
            <button
              type="button"
              onClick={() => {
                setText((value / 100).toString())
                setEditing(true)
              }}
              aria-label="Edit max slippage"
              className="text-muted transition-colors hover:text-text"
              data-testid="slippage-edit"
            >
              <span aria-hidden="true">✎</span>
            </button>
          </span>
        )}
      </div>

      {severity === 'ok' ? null : (
        <p
          role="status"
          className={[
            'inline-flex items-center gap-1.5 text-[12px] leading-snug',
            severity === 'very-high' ? 'text-negative' : 'text-caution',
          ].join(' ')}
          data-testid="slippage-warning"
        >
          {/*
            IKON `aria-hidden`: ekran okuyucu zaten metni okuyor ve "ucgen
            unlem isareti high slippage" iki kez uyarmak olurdu. Renk de tek
            basina tasiyici DEGIL -- WCAG 1.4.1 gereği anlam metinde duruyor.
          */}
          <span aria-hidden="true">⚠</span>
          {severity === 'very-high' ? 'Very high slippage' : 'High slippage'}
        </p>
      )}
    </div>
  )
}
