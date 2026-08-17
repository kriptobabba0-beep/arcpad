'use client'

import { useCallback, useState } from 'react'
import { getWebConfig } from '@/lib/addresses'
import { Button } from '@/components/ui/Button'
import { cx } from '@/components/ui/cx'
import type { ReadableFailure } from './failureCopy'
import { arcScanTxUrl } from './TxStatus'

/**
 * BIR BASARISIZLIGIN OKUNABILIR KARSILIGI.
 *
 * EN ONEMLI DAVRANIS: `tone === 'neutral'` OLAN BIR BASARISIZLIK KUTU CIZMEZ.
 * Kullanici reddi tek ornegidir ve bir hata degil bir karardir; kirmizi bir
 * kutuya konarsa kullaniciya bilerek yaptigi seyin yanlis oldugu soylenmis
 * olur. Form ve girdiler de KORUNUR -- bunu cagiran taraf yapar, bu bilesen
 * hicbir sey sifirlamaz.
 *
 * `showRaw` dali BOS BIRAKILMAZ. Taninmayan bir selector geldiginde ham hata
 * cizilir ve kopyalanabilir; yutmak, onu hic gormemis olmakla ayni sey.
 */
export function FailureNotice({
  failure,
  hash,
  onRetry,
  onSwitchNetwork,
  className,
}: {
  failure: ReadableFailure
  hash?: `0x${string}`
  onRetry?: () => void
  onSwitchNetwork?: () => void
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(describeRaw(failure)).then(() => setCopied(true))
  }, [failure])

  const neutral = failure.tone === 'neutral'

  return (
    <div
      data-testid="failure-notice"
      data-tone={failure.tone}
      data-name={failure.name}
      className={cx(
        'flex flex-col gap-2 text-[13px] leading-relaxed',
        // Nötr hal: SATIR, kutu degil. Cerceve, zemin ve kirmizi hicbiri yok.
        neutral
          ? 'text-muted'
          : cx(
              'rounded-card border px-4 py-3',
              failure.tone === 'warn'
                ? 'border-white/15 bg-surface-2 text-text'
                : 'border-negative/40 bg-negative/8 text-text',
            ),
        className,
      )}
    >
      <p className={cx('font-medium', neutral ? 'text-text' : undefined)}>{failure.title}</p>
      <p className="text-muted">{failure.body}</p>
      {/* CARE HER ZAMAN YAZILIR. Yapilabilecek bir sey yoksa metin bunu soyler. */}
      <p data-testid="failure-remedy">{failure.remedy}</p>

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {failure.retryable && onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}

        {/*
          YANLIS AG kendi kapimizdir ve carei bir dugmedir: kullaniciya
          cuzdanini elle degistirmesini anlatan bir metin, tek tiklik bir
          eylemin yerini tutmaz.
        */}
        {failure.name === 'WrongNetwork' && onSwitchNetwork ? (
          <Button size="sm" variant="primary" onClick={onSwitchNetwork}>
            {`Switch to ${getWebConfig().chain.name}`}
          </Button>
        ) : null}

        {hash ? (
          <a
            href={arcScanTxUrl(hash)}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-sm text-accent underline-offset-2 hover:underline"
          >
            View on ArcScan
          </a>
        ) : null}

        {failure.showRaw ? (
          <Button size="sm" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy details'}
          </Button>
        ) : null}
      </div>

      {failure.showRaw ? (
        <pre
          data-testid="failure-raw"
          className="max-h-40 overflow-auto rounded-input bg-surface-2 p-2 text-[11px] whitespace-pre-wrap text-muted"
        >
          {describeRaw(failure)}
        </pre>
      ) : null}
    </div>
  )
}

/** Kopyalanan metin: adin ve eylemin YANINDA ham hata. Ikisi de teshis icin gerekli. */
export function describeRaw(failure: ReadableFailure): string {
  const raw = failure.raw
  const rendered =
    raw instanceof Error
      ? `${raw.name}: ${raw.message}`
      : typeof raw === 'string'
        ? raw
        : safeJson(raw)
  return `${failure.action} / ${failure.name}\n${rendered}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))
  } catch {
    return String(value)
  }
}
