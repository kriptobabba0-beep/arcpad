import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GraduationView, type GraduationViewProps } from '@/components/token/GraduationPanel'
import { LifecycleNotice } from '@/components/token/LifecycleNotice'
import type { GraduationState } from '@/components/token/useGraduation'
import type { HexAddress } from '@/components/read/types'
import { renderWithProviders } from '../ui/harness'

/**
 * ============ WHAT A COMPLETED CURVE OFFERS, AND WHAT IT MUST NOT ============
 *
 * The rule this file exists for: ON THE PRODUCTION FACTORY `graduationTarget`
 * IS `0x0` AND THAT IS DELIBERATE. A button in that state can do exactly one
 * thing -- take the user's gas and revert with `GraduationTargetUnset()` -- so
 * the screen has to EXPLAIN instead of offering it.
 *
 * The counts below are UNSCOPED over the rendered card, not `within(...)` a
 * sub-element. That is the lesson from the two "Switch to Arc Testnet" controls
 * found on 2026-08-09: each component's own test asserted its own button with a
 * scoped query and passed, and a scoped query passes just as happily with three
 * of them on screen. "How many actionable controls does this state put in front
 * of a user" is only answerable by counting all of them.
 */

const CURVE = '0xddb9e739a948c968eb4c7e1449b94c598b1cf27b' as HexAddress
const TARGET = '0x0e7771091a3471dc12cbfe38836badc7bf5a98e8' as HexAddress

const DEFAULTS: GraduationViewProps = {
  state: { kind: 'unarmed' },
  connection: 'connected',
  chainName: 'Arc Testnet',
  phase: 'idle',
  failure: null,
}

function view(overrides: Partial<GraduationViewProps> = {}) {
  const onGraduate = vi.fn()
  const onConnect = vi.fn()
  const onSwitch = vi.fn()
  const rendered = render(
    <GraduationView
      {...DEFAULTS}
      {...overrides}
      onGraduate={onGraduate}
      onConnect={onConnect}
      onSwitch={onSwitch}
    />,
  )
  return {
    q: within(rendered.container),
    onGraduate,
    onConnect,
    onSwitch,
    user: userEvent.setup(),
  }
}

describe('a state that cannot succeed offers no control', () => {
  it('unarmed: it EXPLAINS, and the card carries ZERO buttons', () => {
    const { q } = view({ state: { kind: 'unarmed' } })
    expect(q.getByTestId('graduation-unarmed')).toBeInTheDocument()
    expect(q.getByText(/waiting on the launchpad/i)).toBeInTheDocument()
    expect(q.getByText(/anyone may send/i)).toBeInTheDocument()
    // The reassurance is the part users actually want, and it is a property of
    // the contract rather than of anyone's diligence.
    expect(q.getByText(/nothing is at risk/i)).toBeInTheDocument()
    expect(q.queryAllByRole('button')).toHaveLength(0)
  })

  it('loading and unavailable also offer nothing', () => {
    for (const kind of ['loading', 'unavailable'] as const) {
      const { q } = view({ state: { kind } })
      expect(q.queryAllByRole('button'), `${kind} rendered a control`).toHaveLength(0)
    }
  })

  it('unavailable does NOT say the launchpad is unarmed', () => {
    // "We could not read it" and "it is not set" are different sentences and
    // conflating them would blame the platform for our own failed RPC call.
    const { q } = view({ state: { kind: 'unavailable' } })
    expect(q.getByTestId('graduation-unavailable')).toBeInTheDocument()
    expect(q.queryByText(/waiting on the launchpad/i)).not.toBeInTheDocument()
  })

  it('graduated: the pool is open, and there is still nothing to press', () => {
    const { q } = view({ state: { kind: 'graduated' } })
    expect(q.getByTestId('graduation-graduated')).toBeInTheDocument()
    expect(q.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('when it CAN succeed, exactly one control appears', () => {
  const READY: GraduationState = { kind: 'ready', target: TARGET }

  it('ready: ONE button, labelled Graduate, and it calls through', async () => {
    const { q, user, onGraduate } = view({ state: READY })
    const buttons = q.queryAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(q.getByTestId('graduate-submit')).toHaveAccessibleName('Graduate')
    await user.click(q.getByTestId('graduate-submit'))
    expect(onGraduate).toHaveBeenCalledTimes(1)
  })

  it('it says the sender pays and receives nothing', () => {
    // Otherwise the button reads like a claim, and someone races the keeper for
    // a reward that does not exist.
    const { q } = view({ state: READY })
    expect(q.getByText(/you pay the gas and receive nothing/i)).toBeInTheDocument()
  })

  it('disconnected and wrong-network turn the SAME control into the right step', async () => {
    const disconnected = view({ state: READY, connection: 'disconnected' })
    expect(disconnected.q.queryAllByRole('button')).toHaveLength(1)
    await disconnected.user.click(disconnected.q.getByTestId('graduate-submit'))
    expect(disconnected.onConnect).toHaveBeenCalledTimes(1)
    expect(disconnected.onGraduate).not.toHaveBeenCalled()

    const wrong = view({ state: READY, connection: 'wrongNetwork' })
    expect(wrong.q.getByTestId('graduate-submit')).toHaveAccessibleName('Switch to Arc Testnet')
    await wrong.user.click(wrong.q.getByTestId('graduate-submit'))
    expect(wrong.onSwitch).toHaveBeenCalledTimes(1)
    expect(wrong.onGraduate).not.toHaveBeenCalled()
  })

  it('while a graduation is in flight the button cannot be pressed twice', async () => {
    const { q, user, onGraduate } = view({ state: READY, phase: 'pending', hash: '0xabc' })
    expect(q.getByTestId('graduate-submit')).toBeDisabled()
    await user.click(q.getByTestId('graduate-submit'))
    expect(onGraduate).not.toHaveBeenCalled()
    expect(q.getByTestId('graduation-pending')).toBeInTheDocument()
  })

  it('a benign failure is NOT red; a broken one is', () => {
    const benign = view({
      state: READY,
      failure: {
        code: 'already-graduated',
        name: 'AlreadyGraduated',
        tone: 'neutral',
        title: 'Already graduated.',
        body: 'Someone else sent this first.',
        remedy: 'Reload the page.',
        retryable: false,
        showRaw: false,
        raw: null,
      },
    })
    const note = benign.q.getByTestId('graduation-failure')
    expect(note).toHaveAttribute('role', 'status')
    expect(note.className).not.toMatch(/text-negative/)

    const broken = view({
      state: READY,
      failure: {
        code: 'pool-step-failed',
        name: 'ZeroLiquidity',
        tone: 'error',
        title: 'The pool could not be opened.',
        body: 'ZeroLiquidity()',
        remedy: 'Please report this.',
        retryable: false,
        showRaw: false,
        raw: null,
      },
    })
    const alert = broken.q.getByTestId('graduation-failure')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.className).toMatch(/text-negative/)
  })
})

/**
 * ============ THE COMPOSED SCREEN ============
 *
 * Everything above renders `GraduationView` ALONE, which says nothing about
 * whether a completed token page reaches it. The composition is where this
 * repository's defects live, so it is asserted here too: `LifecycleNotice` is
 * what both page branches render, and the chain read is stubbed at the HOOK
 * boundary so the wiring below it is real.
 *
 * The stub is not doing the tested code's job: `useGraduation`'s decision is
 * measured purely (`graduationStateFrom`, in `graduation.test.ts`) and its live
 * reads are measured in a real browser against the real chain
 * (`e2e/arc/two-view-balance.spec.ts`). What is measured HERE is that the page's
 * notice component renders the panel at all -- the property that was false for
 * `TradePanel`, for `CurveChart`'s realised layer and for `loadMore*`.
 */
const chain = vi.hoisted(() => ({ state: { kind: 'unarmed' } as GraduationState }))

vi.mock('@/components/token/useGraduation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/token/useGraduation')>()
  return {
    ...actual,
    useGraduation: () => ({
      state: chain.state,
      phase: 'idle' as const,
      hash: undefined,
      failure: null,
      graduate: () => {},
      refetch: () => {},
    }),
  }
})

describe('the completed card carries the panel, and the trading one carries nothing', () => {
  beforeEach(() => {
    chain.state = { kind: 'unarmed' }
  })

  it('complete + curve -> the card explains graduation and offers no control', () => {
    renderWithProviders(<LifecycleNotice lifecycle={{ kind: 'complete' }} curve={CURVE} />)
    const card = screen.getByTestId('lifecycle-notice')
    // The static half (committed earlier) and the live half, read as one.
    expect(card).toHaveTextContent(/trading on the curve is closed/i)
    expect(card).toHaveTextContent(/does not happen automatically/i)
    expect(within(card).getByTestId('graduation-unarmed')).toBeInTheDocument()
    // UNSCOPED over the whole render: this is the count that would have caught
    // the duplicate switch controls, and it is the count that matters here.
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('complete + curve + an ARMED factory -> exactly one control on the whole screen', async () => {
    chain.state = { kind: 'ready', target: TARGET }
    // CONNECTED, because the label is the connection's next step and this case
    // is about the graduation step. Disconnected renders "Connect wallet" on the
    // same control, which the isolated view tests above cover.
    renderWithProviders(<LifecycleNotice lifecycle={{ kind: 'complete' }} curve={CURVE} />, {
      connected: true,
    })
    // The mock connector reconnects asynchronously, so the label settles a tick
    // after mount. A one-shot read here would assert the disconnected label.
    await screen.findByRole('button', { name: 'Graduate' })
    expect(screen.queryAllByRole('button')).toHaveLength(1)
  })

  it('trading -> no card at all, so no graduation surface either', () => {
    renderWithProviders(<LifecycleNotice lifecycle={{ kind: 'trading' }} curve={CURVE} />)
    // NOT `toBeEmptyDOMElement` on the container: the harness mounts a toast
    // region of its own, so that assertion would be about the harness. The
    // claim is that the NOTICE is absent -- not hidden, absent, because a
    // hidden panel is still reachable by keyboard and screen reader.
    expect(screen.queryByTestId('lifecycle-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('graduation-unarmed')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('graduated -> the pool note, and the panel is not rendered for it', () => {
    renderWithProviders(
      <LifecycleNotice
        lifecycle={{ kind: 'graduated', poolNote: 'Trading has moved to the pool.' }}
        curve={CURVE}
      />,
    )
    expect(screen.getByText('Graduated')).toBeInTheDocument()
    // The card's own note covers it; a second "this has graduated" block below
    // it would be the same sentence twice.
    expect(screen.queryByTestId('graduation-unarmed')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
