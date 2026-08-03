import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FailureNotice } from '@/components/errors/FailureNotice'
import {
  readFailure,
  stillPendingFailure,
  wrongNetworkFailure,
  type ReadableFailure,
} from '@/components/errors/failureCopy'
import { TxStatus } from '@/components/errors/TxStatus'
import { TxStatusRegion } from '@/components/errors/TxStatusRegion'
import { decodeArcpadError } from '@/lib/decodeRevert'
import { getWebConfig } from '@/lib/addresses'

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as const

const rejection = (): ReadableFailure =>
  readFailure(
    decodeArcpadError({ code: 4001, message: 'User denied' }, { action: 'buyExactQuoteIn' }),
  )

const unknown = (): ReadableFailure =>
  readFailure(decodeArcpadError({ nobody: 'expected this' }, { action: 'approve' }))

describe('the announcement region', () => {
  it('holds ONE polite region and ONE assertive region, always mounted', () => {
    // Mutant: `aria-live` bolgesini kaldir. Ekran okuyucular canli bolgeyi
    // ONCEDEN kaydeder; metinle birlikte monte edilen bir bolge cogu zaman hic
    // duyurulmaz. Bu yuzden ikisi de BOSKEN de DOM'da durur.
    const { rerender } = render(<TxStatusRegion state="idle" />)
    const polite = screen.getByTestId('tx-status-polite')
    const assertive = screen.getByTestId('tx-status-assertive')
    expect(polite).toHaveAttribute('role', 'status')
    expect(polite).toHaveAttribute('aria-live', 'polite')
    expect(assertive).toHaveAttribute('role', 'alert')
    expect(assertive).toHaveAttribute('aria-live', 'assertive')
    expect(polite).toBeEmptyDOMElement()

    rerender(<TxStatusRegion state="broadcast" hash={HASH} />)
    // AYNI dugum, yeni icerik -- duyurunun sarti tam olarak budur.
    expect(screen.getByTestId('tx-status-polite')).toBe(polite)
    expect(polite).not.toBeEmptyDOMElement()
  })

  it('puts progress in the polite region and failure in the assertive one', () => {
    render(<TxStatusRegion state="failed" hash={HASH} failure={rejection()} />)
    expect(screen.getByTestId('tx-status-assertive')).toContainElement(
      screen.getByTestId('failure-notice'),
    )
    // Basarisizlik varken ilerleme satiri susar: iki bolge ayni anda konusmaz.
    expect(screen.getByTestId('tx-status-polite')).toBeEmptyDOMElement()
  })
})

describe('a rejection is not a red box', () => {
  it('renders neutral, with no error styling and no alarm words', () => {
    render(<FailureNotice failure={rejection()} />)
    const notice = screen.getByTestId('failure-notice')
    expect(notice).toHaveAttribute('data-tone', 'neutral')
    expect(notice.className).not.toMatch(/negative/)
    expect(notice.className).not.toMatch(/border/)
    expect(screen.getByText('Cancelled.')).toBeInTheDocument()
  })

  it('offers no retry button -- there is nothing to retry', () => {
    render(<FailureNotice failure={rejection()} onRetry={() => {}} />)
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('a real contract failure DOES get the red box', () => {
    const failure = readFailure(
      decodeArcpadError(new Error('execution reverted: sender is blocked'), {
        action: 'buyExactQuoteIn',
      }),
    )
    const notice = render(<FailureNotice failure={failure} />).getByTestId('failure-notice')
    expect(notice).toHaveAttribute('data-tone', 'error')
    expect(notice.className).toMatch(/negative/)
  })
})

describe('the notice carries its remedy and its escape hatches', () => {
  it('a retryable failure shows Try again and calls back', async () => {
    const user = userEvent.setup()
    let retried = 0
    const failure: ReadableFailure = { ...rejection(), retryable: true, tone: 'error' }
    render(<FailureNotice failure={failure} onRetry={() => (retried += 1)} />)
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(retried).toBe(1)
  })

  it('the unknown branch shows the raw error and copies it', async () => {
    // CASUS BURADA YENIDEN KURULUYOR ve bu sart: `userEvent.setup()` kendi
    // pano sahtesini kurar ve `test/setup.ts` icindeki `vi.fn()` casusunun
    // uzerine yazar. Ayni dosyadaki BASKA bir testin kurulumu bu testin
    // olcumunu sessizce kaybettiriyordu (olculdu: "is not a spy").
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    render(<FailureNotice failure={unknown()} />)
    expect(screen.getByTestId('failure-raw')).toHaveTextContent('expected this')
    fireEvent.click(screen.getByRole('button', { name: /copy details/i }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('expected this'))
    })
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument()
  })

  it('every notice writes a remedy, even when nothing can be done', () => {
    render(<FailureNotice failure={unknown()} />)
    expect(screen.getByTestId('failure-remedy').textContent ?? '').not.toBe('')
  })

  it('the wrong-network button names the chain from the registry, not a literal', () => {
    const chainName = getWebConfig().chain.name
    render(
      <FailureNotice
        failure={wrongNetworkFailure(chainName, 'launch')}
        onSwitchNetwork={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: `Switch to ${chainName}` })).toBeInTheDocument()
  })

  it('links to ArcScan with the explorer from the registry', () => {
    render(<FailureNotice failure={unknown()} hash={HASH} />)
    const link = screen.getByRole('link', { name: /ArcScan/i })
    expect(link).toHaveAttribute(
      'href',
      `${getWebConfig().chain.blockExplorers.default.url}/tx/${HASH}`,
    )
  })
})

describe('the status line', () => {
  it('draws nothing at all while idle', () => {
    const { container } = render(<TxStatus state="idle" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('carries the hash link on every phase that has one', () => {
    for (const phase of ['broadcast', 'confirmed', 'stillPending', 'failed'] as const) {
      const { unmount } = render(<TxStatus state={phase} hash={HASH} />)
      expect(screen.getByRole('link', { name: /ArcScan/i })).toBeInTheDocument()
      unmount()
    }
  })

  it('a missing receipt says pending, never failed', () => {
    render(<TxStatus state="stillPending" hash={HASH} />)
    const line = screen.getByTestId('tx-status-line')
    expect(line).toHaveTextContent('Still pending.')
    expect(line.textContent ?? '').not.toMatch(/fail/i)
    // ...ve karsiligi olan basarisizlik nesnesi de oyle.
    expect(stillPendingFailure('buyExactQuoteIn').tone).not.toBe('error')
  })
})
