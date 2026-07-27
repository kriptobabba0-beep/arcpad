import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { BRAND } from '@/lib/brand'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
