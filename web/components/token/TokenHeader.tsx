import { TokenArtwork } from '@/components/layout/TokenArtwork'
import type { TokenOverview } from '@/components/read/types'
import { Card } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'

export function TokenHeader({
  overview,
  imageUrl,
}: {
  overview: TokenOverview
  imageUrl?: string | null
}) {
  return (
    <div className="flex items-center gap-4">
      <TokenArtwork
        address={overview.token}
        uri={imageUrl ?? null}
        size={64}
        symbol={overview.symbol}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="truncate font-serif text-3xl leading-none">{overview.name}</h1>
          <span className="text-base text-muted">${overview.symbol}</span>
          {overview.complete ? <Pill tone="accent">Curve complete</Pill> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * ACIKLAMA VE SOSYAL LINKLER `resolveMetadata`'DAN GELIR.
 *
 * Cozulemedigi durumda metin "No description yet." -- ve bu bir HATA olarak
 * gosterilmez. `uri` bos birakilabilir ve BOS BIRAKMAK YAYGIN OLACAKTIR;
 * cozulemeyen metadata bu urunde normal daldir, kenar durum degil.
 */
export function AboutPanel({
  description,
  links,
}: {
  description?: string | undefined
  links?: { x?: string | undefined; telegram?: string | undefined } | undefined
}) {
  const hasLinks = links?.x !== undefined || links?.telegram !== undefined

  return (
    <Card as="section" aria-label="About" className="flex flex-col gap-3 px-5 py-4">
      <p className="text-[13px] leading-relaxed text-muted">
        {description === undefined || description.trim() === ''
          ? 'No description yet.'
          : description}
      </p>
      {hasLinks ? (
        <div className="flex flex-wrap gap-3 text-[13px]">
          {links?.x === undefined ? null : (
            <a
              href={links.x}
              target="_blank"
              rel="noreferrer noopener"
              className="text-muted transition-colors hover:text-accent"
            >
              X
            </a>
          )}
          {links?.telegram === undefined ? null : (
            <a
              href={links.telegram}
              target="_blank"
              rel="noreferrer noopener"
              className="text-muted transition-colors hover:text-accent"
            >
              Telegram
            </a>
          )}
        </div>
      ) : null}
    </Card>
  )
}
