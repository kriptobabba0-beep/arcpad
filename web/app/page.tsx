import { arcTestnet, formatUsdc } from '@arcpad/shared'
import { BRAND } from '@/lib/brand'

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-semibold text-accent">{BRAND.wordmark}</h1>
      <p className="text-muted">{BRAND.tagline}</p>
      <dl className="rounded-card border border-border bg-surface p-6 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Network</dt>
          <dd>{arcTestnet.name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Chain ID</dt>
          <dd>{arcTestnet.id}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Formatting check</dt>
          <dd>${formatUsdc(1_234_500_000_000_000_000_000n)}</dd>
        </div>
      </dl>
    </main>
  )
}
