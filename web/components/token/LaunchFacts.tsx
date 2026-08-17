import { formatTokenAmount } from '@arcpad/shared/browser'
import type { Canonicity, TokenOverview } from '@/components/read/types'
import { Address } from '@/components/ui/Address'
import { Card } from '@/components/ui/Card'
import { Money } from '@/components/ui/Money'
import { CanonicalBadge } from './CanonicalBadge'
import { TOTAL_SUPPLY_TOK } from './walletDelta'

/**
 * UCUNCU KOLON BOS BIRAKILMAZ -- DEVIASYON.
 *
 * Referans arayuzun uc kolonu: al-sat · grafik · CHAT. Chat Faz 6'dadir, yani
 * ucuncu kolon bu fazda bos kalirdi ve BOS BIR KOLON, OLMAYAN BIR KOLONDAN
 * KOTUDUR: kullanici orada bir sey oldugunu sanip bekler.
 *
 * Yerine sayfanin en cok sorulan sorulari geliyor ve HEPSI zincirden okunur --
 * yani indexer dustugunde de dogru kalirlar.
 */

/** K3. Turetilmez, yazilir: bunlar factory'nin immutable'lari. */
const SALE_SUPPLY_TOK = 793_100_000n * 10n ** 18n

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-[13px]">
      <dt className="shrink-0 text-muted">{label}</dt>
      {/*
        DEGER KUTUDAN TASAMAZ.
        `min-w-0` daralmaya IZIN verir ama bolunmeye izin vermez:
        `206,886,011.183597` bosluksuz tek bir parcadir ve sutundan genisse
        disari tasar -- ekran goruntusundeki hal tam olarak buydu.
        `overflow-wrap: anywhere` en kotu durumda satirin icinde bolerek
        tasmayi imkansiz kilar; normalde zaten bosluktan boluner ve yuzde alt
        satira iner.
      */}
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

export function LaunchFacts({
  overview,
  canonicity,
}: {
  overview: TokenOverview
  canonicity: Canonicity
}) {
  const poolSeed = overview.poolSeedSupplyTok

  return (
    <Card as="section" aria-label="Launch facts" className="divide-y divide-border">
      <Row label="Launched by">
        <Address value={overview.launchCreator} explorer label="Launch creator" />
      </Row>

      {/*
        `feeCreator` YALNIZCA `launchCreator`'dan FARKLIYSA cizilir.
        `LaunchToken.creator` "kim baslatti" kaydidir ve ucreti fiilen alan
        cuzdan DEGILDIR (spec §5.7 devir yollari tanimliyor). Ikisi ayni
        oldugunda ayri bir satir, olmayan bir ayrimi varmis gibi gosterirdi.
      */}
      {overview.feeCreator.toLowerCase() !== overview.launchCreator.toLowerCase() ? (
        <Row label="Fee recipient">
          <Address value={overview.feeCreator} explorer label="Fee recipient" />
        </Row>
      ) : null}

      <Row label="Token">
        <Address value={overview.token} copy explorer label="Token address" />
      </Row>
      <Row label="Curve">
        {/* Kullanicinin FONU curve'dedir; `isCanonical` ile dogrulanan da odur. */}
        <Address value={overview.curve} copy explorer label="Curve address" />
      </Row>
      <Row label="Provenance">
        <CanonicalBadge status={canonicity} />
      </Row>

      <Row label="Total supply">
        <span className="tabular-nums">{formatTokenAmount(TOTAL_SUPPLY_TOK)}</span>
      </Row>
      <Row label="On the curve">
        <span className="tabular-nums">{formatTokenAmount(SALE_SUPPLY_TOK)}</span>
        <span className="ml-1 text-muted">(79.31%)</span>
      </Row>
      {poolSeed === null ? null : (
        <Row label="Reserved for the pool">
          <span className="tabular-nums">{formatTokenAmount(BigInt(poolSeed))}</span>
          <span className="ml-1 text-muted">(20.69%)</span>
        </Row>
      )}

      {/*
        ORAN VE MUTLAK DEGER AYRI AYRI. K2: ucret iki BAGIMSIZ tavan
        yuvarlamasindan TOPLANIR, birlesik bir orandan bolunmez -- ileri yonde
        `125` literali hicbir yerde gorunmez. Ve oran CURVE tutarinin
        uzerindedir, girdinin degil: olculdu, 1 USDC butceli bir alimda toplam
        ucret butcenin %1,2345679'u.
      */}
      <Row label="Trading fee">
        <span className="tabular-nums">0.95%</span>
        <span className="text-muted"> protocol + </span>
        <span className="tabular-nums">0.30%</span>
        <span className="text-muted"> creator</span>
        <span className="block text-[11px] text-muted">charged on the curve amount</span>
      </Row>

      <Row label="Graduation">
        <Money native={overview.graduationRaiseWei} rounding="up" unit />
      </Row>
    </Card>
  )
}
