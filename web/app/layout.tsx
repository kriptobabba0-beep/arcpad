import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { BRAND } from '@/lib/brand'
import { instrumentSerif, spaceGrotesk } from './fonts'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  // Marka adi TEK BIR SABITTEN. Sekme basligi, uygulama adi ve sablon --
  // ucu de `BRAND`'ten turer, hicbiri "arcpad" yazmaz.
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
  applicationName: BRAND.name,
}

/**
 * `colorScheme: 'dark'` burada da bildirilir.
 *
 * `globals.css`'teki `:root { color-scheme: dark }` stil yuklendikten SONRA
 * gecerli olur; meta etiket ilk boyadan once gecerlidir. Ikisi arasindaki
 * pencerede tarayici sayfayi acik varsayar ve bazi tarayicilarda beyaz bir
 * flas gorunur -- koyu bir uruntde en cok fark edilen tek gorsel hata.
 */
export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b0b0b',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col bg-bg text-text">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  )
}
