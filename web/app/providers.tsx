'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { ToastProvider } from '@/components/ui/Toast'
import { wagmiConfig } from '@/lib/wagmi'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {/*
          Bildirim bolgeleri WagmiProvider'in ICINDE duruyor cunku bildirimi
          uretecek seylerin cogu zincir olaylari: bir islem gonderildi, bir
          revert cozuldu, bir ag degistirildi. Disarida olsaydi her cagiran
          kendi kopyasini kurmak zorunda kalirdi.
        */}
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
