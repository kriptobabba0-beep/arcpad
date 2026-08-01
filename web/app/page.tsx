import { formatUsdc } from '@arcpad/shared/browser'
import { getWebConfig } from '@/lib/addresses'
import { BRAND } from '@/lib/brand'

export default function Home() {
  const { chain, addresses } = getWebConfig()

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-semibold text-accent">{BRAND.wordmark}</h1>
      <p className="text-muted">{BRAND.tagline}</p>
      <dl className="rounded-card border border-border bg-surface p-6 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Network</dt>
          <dd>{chain.name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Chain ID</dt>
          <dd>{chain.id}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Factory</dt>
          <dd className="font-mono text-xs">{addresses.launchFactory}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Formatting check</dt>
          <dd>${formatUsdc(1_234_500_000_000_000_000_000n)}</dd>
        </div>
      </dl>
      {/*
        Your wallet shows this balance with 18 decimals because on Arc the
        native gas asset IS USDC. It is the SAME fund shown here with 6 -- two
        views of one balance, never two balances.
      */}
      <p className="text-xs text-muted">
        On Arc the native gas asset is USDC itself. Your wallet may show the balance with 18
        decimals; this site shows the same balance with 6. It is one balance, shown two ways.
      </p>
    </main>
  )
}
