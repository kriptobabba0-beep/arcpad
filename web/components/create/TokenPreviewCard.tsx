import type { ReactNode } from 'react'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import { Card } from '@/components/ui/Card'
import { Money } from '@/components/ui/Money'
import {
  bpsPercent,
  formatTok,
  formatTokExact,
  type LaunchFacts,
  supplySharePercent,
} from './facts'
import { displayName, type LaunchFields } from './fields'

/**
 * ONIZLEME KARTI -- SAYILAR ZINCIRDEN, METIN SABIT DEGIL.
 *
 * `facts` `null` OLABILIR ve bu bir hata ekrani degildir: profil ucusu
 * factory'den okunur ve o okuma dusebilir. Dusunce kartin dort satiri "—"
 * gosterir, form CALISMAYA DEVAM EDER -- launch'in profile hicbir ihtiyaci
 * yoktur, `launch(name, symbol, uri)` uc dizeden ibarettir. Uydurulmus bir
 * yedek sayi gostermek ise bu kartin varlik sebebini yok ederdi.
 */
export type TokenPreviewCardProps = {
  fields: LaunchFields
  facts: LaunchFacts | null
}

export function TokenPreviewCard({ fields, facts }: TokenPreviewCardProps) {
  // GOSTERILEN AD TEMIZLENMIS HALIDIR. Gorunmez karakterler ve bidi
  // override'lari bir launchpad'de gercek bir taklit yoludur; kullanici
  // yazdigi seyin EKRANDA nasil gorunecegini imzalamadan once gormeli.
  const name = displayName(fields.name)
  const symbol = displayName(fields.symbol)

  return (
    <Card as="section" aria-labelledby="preview-heading" className="flex flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        {/*
          Adres HENUZ YOKTUR -- token deploy edilmemistir. `TokenArtwork`
          adresten deterministik bir yedek uretir, dolayisiyla burada bos dize
          gecilir ve yedek "adressiz" tohumla cizilir. Ayni gorsel launch'tan
          sonra DEGISIR ve bu durustce soylenmelidir; bu yuzden kart onu bir
          onizleme olarak degil, alanlarin ozeti olarak sunar.
        */}
        <TokenArtwork address="" uri={fields.image} size={40} symbol={symbol} />
        <div className="min-w-0">
          <h2 id="preview-heading" className="truncate text-base font-semibold">
            {name === '' ? 'Your token' : name}
          </h2>
          <p className="truncate text-[13px] text-muted">{symbol === '' ? '—' : `$${symbol}`}</p>
        </div>
      </div>

      <dl className="flex flex-col divide-y divide-border">
        {/*
          UCRETSIZ OLUSTURMA BIR SLOGAN DEGIL, DOGRULANMIS BIR IFADE:
          `LaunchFactory.launch` `payable` degildir, yani protokol launch
          aninda hicbir sey tahsil EDEMEZ. Bir `<Money native={0n}>` burada
          `0.000000` yazardi -- "sifir USDC ucret" ile "ucret yok" ayni sey
          degil ve ikincisi dogru olan.
        */}
        <Row label="Launch fee">
          <span className="font-medium">None</span>
          <Note>You pay gas, and nothing else.</Note>
        </Row>

        <Row label="Trading fee">
          <span className="tabular-nums">
            {bpsPercent(facts?.protocolFeeBps ?? 95n)}% protocol +{' '}
            {bpsPercent(facts?.creatorFeeBps ?? 30n)}% creator
          </span>
          <Note>The creator share is yours, on every buy and every sell.</Note>
        </Row>

        <Row label="Total supply">
          <span className="tabular-nums">
            {facts === null ? '—' : formatTok(facts.totalSupplyTok)}
          </span>
          <Note>Fixed. There is no mint function.</Note>
        </Row>

        <Row label="On the curve">
          <span className="tabular-nums">
            {facts === null ? '—' : formatTok(facts.saleSupplyTok)}
          </span>
          {facts === null ? null : (
            <Note>
              {supplySharePercent(facts.saleSupplyTok, facts.totalSupplyTok)}% of the supply, sold
              along the curve.
            </Note>
          )}
        </Row>

        <Row label="Reserved for the pool">
          <span className="tabular-nums">
            {facts === null ? '—' : formatTok(facts.poolSeedTok)}
          </span>
          {facts === null ? null : (
            <Note>
              {supplySharePercent(facts.poolSeedTok, facts.totalSupplyTok)}% of the supply.{' '}
              {/*
                BIR LAUNCHPAD'DE ARZIN NEREYE GITTIGI TOPLAMDA %100 TUTMAK
                ZORUNDADIR; tutmuyorsa sebebi YAZILI olmali. `N - S - D`
                curve'de kalir ve hicbir zaman hicbir yere gitmez (spec §5.2'nin
                kalici artigi). Tam deger kirpilmadan yazilir, cunku kirpilmis
                uc sayi toplamda `N` etmez.
              */}
              A further {formatTokExact(facts.strandedTok)} stays on the curve for good: it is the
              rounding remainder of the split and there is no path that moves it.
            </Note>
          )}
        </Row>

        <Row label="Graduation at">
          {facts === null ? (
            <span>—</span>
          ) : (
            // `rounding="up"`: bu bir esiktir, bir bakiye degil. Asagi
            // yuvarlamak "gerekenden az toplayinca mezun olur" demek olurdu.
            <span>
              <Money native={facts.graduationRaiseWei} rounding="up" unit /> raised
            </span>
          )}
          <Note>Trading on the curve stops there.</Note>
        </Row>

        <Row label="Opening market cap">
          {facts === null ? (
            // `rounding="down"`: bu var olan bir degeri anlatan bir figurdur.
            <span>—</span>
          ) : (
            <Money native={facts.openingMarketCapWei} rounding="down" maxFractionDigits={2} unit />
          )}
        </Row>

        {/*
          "Liquidity: Locked" YAZILMAZ.
          Havuz ve kalici kilit FAZ 2'dedir. Bugun var olmayan bir garantiyi
          vaat etmek, kullanicinin bir launch'a yatirim kararini olmayan bir
          korumaya dayandirmasi demektir.
        */}
        <Row label="Liquidity">
          <span className="text-muted">Locked at graduation — not live on testnet yet</span>
          <Note>The pool and its permanent lock ship in a later phase.</Note>
        </Row>
      </dl>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-3">
      <dt className="text-[12px] uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 text-[12px] leading-snug text-muted">{children}</p>
}
