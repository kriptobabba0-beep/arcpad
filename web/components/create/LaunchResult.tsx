'use client'

import type { Address as HexAddress } from 'viem'
import { Address } from '@/components/ui/Address'
import { buttonClassName } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'

export type LaunchResultProps = {
  token: HexAddress
  curve: HexAddress
  /** Kullanicinin girdigi "Buy after launch" tutari (ondalik metin), varsa. */
  buyAmount?: string
}

/**
 * LAUNCH SONRASI EKRAN.
 *
 * Buradaki adres MAKBUZUN `Launched` OLAYINDAN gelir; `predictAddresses`
 * arayuzde hic cagrilmaz (gerekcesi `useLaunch.ts`'te). Bu ekranin tasidigi
 * adres kopyalanir, paylasilir ve baskalari ona para gonderir -- yanlis bir
 * adres burada bir gorunum hatasi degil, dogrudan bir dolandiricilik yoludur.
 *
 * GEZINME BAGLANTIDIR, BUTON DEGIL. `onClick={() => router.push(...)}` yazan
 * bir buton yeni sekmede acilamaz, adresi kopyalanamaz ve tarayicinin geri
 * dugmesiyle calismaz; `buttonClassName` gorunumu ayni tutar.
 */
export function LaunchResult({ token, curve, buyAmount }: LaunchResultProps) {
  const trimmed = buyAmount?.trim() ?? ''
  const href =
    trimmed === '' ? `/token/${token}` : `/token/${token}?buy=${encodeURIComponent(trimmed)}`

  return (
    <Card as="section" aria-labelledby="launched-heading" className="flex flex-col gap-4 px-5 py-5">
      <div className="flex items-center gap-3">
        <Pill tone="accent" dot>
          Live
        </Pill>
        <h2 id="launched-heading" className="text-base font-semibold">
          Your token is on Arc
        </h2>
      </div>

      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <dt className="text-[12px] uppercase tracking-[0.08em] text-muted">Token address</dt>
          <dd className="text-sm">
            <Address value={token} shorten={false} copy explorer label="Token address" />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-[12px] uppercase tracking-[0.08em] text-muted">Curve address</dt>
          <dd className="text-sm">
            <Address value={curve} shorten={false} copy explorer label="Curve address" />
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2">
        <a href={href} className={buttonClassName({ variant: 'primary' })}>
          {trimmed === '' ? 'View token' : `View token and buy ${trimmed} USDC`}
        </a>
      </div>

      {trimmed === '' ? null : (
        /*
          S4. Zincirde ATOMIK BIR DEV BUY YOKTUR: `launch` `payable` degildir ve
          hicbir alim yapmaz. Bu satir, tutarin henuz HARCANMADIGINI soyler --
          soylenmezse kullanici alimin launch ile birlikte gerceklestigini
          sanar ve token sayfasinda ikinci kez alir.
        */
        <p className="text-[12px] leading-snug text-muted">
          Nothing has been bought yet. {trimmed} USDC is carried over to the token page as a
          separate transaction, which you sign there. Your launch is live either way.
        </p>
      )}
    </Card>
  )
}
