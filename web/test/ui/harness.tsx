import { arcTestnet } from '@arcpad/shared/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { ReactElement } from 'react'
import { vi } from 'vitest'
import { http } from 'viem'
import { mainnet } from 'viem/chains'
import { createConfig, WagmiProvider } from 'wagmi'
import { mock } from 'wagmi/connectors/mock'
import { ToastProvider } from '@/components/ui/Toast'

/**
 * BILESEN TESTLERININ CUZDANI, wagmi'nin KENDI `mock()` connector'i.
 *
 * Ayri bir sahte katman YAZILMADI ve bu bir tercihten fazlasi: elle yazilmis
 * bir cuzdan sahtesi, wagmi'nin durum makinesini degil BIZIM o makine hakkinda
 * ne dusundugumuzu test eder. `disconnected -> connecting -> reconnecting ->
 * connected` gecisleri ve `chainId`'nin baglanmadan once UNDEFINED olmasi
 * (Task 1'in butun mantigi bunun uzerinde duruyor) yalnizca gercek connector'la
 * dogru cikar.
 */

/** Zincirde gercekten duran bir adres: smoke token'in curve'u. */
export const TEST_ACCOUNT = '0x7938BE340A14A12f94a83AEa246d9d2566324c9C' as const

export type HarnessOptions = {
  /** `true` -> montajda bagli. `false` -> hic baglanmamis. */
  connected?: boolean
  /**
   * `true` -> cuzdan BASKA bir agda. Yanlis ag, config'in ILK zincirini
   * degistirerek kurulur: mock connector varsayilan olarak `chains[0]`'a
   * baglanir, env ise Arc testnet'i bekler.
   */
  wrongNetwork?: boolean
}

export function createTestConfig(options: HarnessOptions = {}) {
  const chains = options.wrongNetwork
    ? ([mainnet, arcTestnet] as const)
    : ([arcTestnet, mainnet] as const)

  return createConfig({
    chains,
    connectors: [
      mock({
        accounts: [TEST_ACCOUNT],
        features: { defaultConnected: options.connected ?? false, reconnect: true },
      }),
    ],
    transports: {
      [arcTestnet.id]: http('http://127.0.0.1:8545'),
      [mainnet.id]: http('http://127.0.0.1:8545'),
    },
  })
}

/**
 * UYGULAMA YONLENDIRICISI, SAHTELENMIS.
 *
 * `useRouter()` bir baglam olmadan "invariant expected app router to be
 * mounted" ile ATAR -- ve bu, kabuk testlerinin kirilma bicimiydi: arama
 * modali kabuga baglaninca `SearchDialog`'un `useRouter()`'i her render'da
 * kostu, modal KAPALI olsa bile.
 *
 * Sahte olmasi bilincli: bir test navigasyonun GERCEKTEN olmasini degil,
 * DOGRU adrese CAGRILDIGINI olcmelidir. `push`'un kendisi bir `vi.fn()`, yani
 * bir iddiaya konu olabilir.
 */
export function createStubRouter() {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }
}

export function renderWithProviders(ui: ReactElement, options: HarnessOptions = {}): RenderResult {
  const config = createTestConfig(options)
  const queryClient = new QueryClient({
    // Testte yeniden deneme YOK: bir hata yolunu olcerken uc kez sessizce
    // tekrarlamak testi yavaslatir ve hatayi gizler.
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <AppRouterContext.Provider value={createStubRouter() as never}>
      <WagmiProvider config={config} reconnectOnMount>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{ui}</ToastProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </AppRouterContext.Provider>,
  )
}
