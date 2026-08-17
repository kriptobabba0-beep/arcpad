'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { BRAND } from '@/lib/brand'

/**
 * YALNIZCA BEKLENMEYEN ISTISNALAR ICIN.
 *
 * Veritabaninin dusmesi BEKLENEN bir durumdur ve buraya GELMEZ:
 * `readTokenList` bir `ReadResult` dondurur, sayfa onu okur ve aciklayici bir
 * kutu cizer (`EmptyState.ReadUnavailable`). Bir dusus buraya dusuyorsa bu,
 * `guard`'in atlandigi anlamina gelir -- yani bu dosyanin gorunmesi kendi
 * basina bir bulgudur.
 *
 * Hata METNI kullaniciya gosterilmez. `error.message` bir sunucu istisnasindan
 * gelir ve baglanti dizesi, sorgu metni ya da dosya yolu tasiyabilir; Next
 * uretimde onu zaten sanitize eder ama buna GUVENMEK yanlis olur. Gosterilen
 * sey `digest`: sunucu loglarindaki satiri bulmaya yeter, hicbir sey
 * sizdirmaz.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Istemci konsoluna DA yaziliyor: sunucu logu olmayan bir ortamda
    // (ornegin bir onizleme dagitimi) hatanin izi tamamen kaybolmasin.
    console.error(`${BRAND.name}: unhandled render error`, error.digest ?? error.message)
  }, [error])

  return (
    <Card className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-14 text-center">
      <p className="font-serif text-2xl leading-tight">Something broke on our side.</p>
      <p className="text-sm text-muted">
        This is not your wallet and not the chain. Your funds are untouched — {BRAND.name} never
        holds them. Trading and creating tokens go straight to the chain and are unaffected.
      </p>
      {error.digest ? (
        <p className="text-[12px] tabular-nums text-muted">Reference: {error.digest}</p>
      ) : null}
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </Card>
  )
}
