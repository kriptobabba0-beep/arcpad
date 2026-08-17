import type { Page } from '@playwright/test'
import {
  type Address,
  createWalletClient,
  type Hex,
  http,
  numberToHex,
  type Chain,
  publicActions,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * AN EIP-1193 PROVIDER INJECTED INTO THE PAGE. NO BROWSER EXTENSION.
 *
 * Extension automation is brittle -- it depends on a third party's popup DOM,
 * its release cadence and its onboarding flow -- and none of that is the thing
 * under test. What is under test is OUR flow: that wagmi's `injected()`
 * connector sees a normal wallet, that a rejection surfaces as "Cancelled."
 * rather than a red box, and that a wrong chain id produces the switch button.
 *
 * WHERE THE KEY LIVES, AND WHY IT IS NOT IN THE PAGE. The page gets a thin
 * shim; every request crosses into Node through `page.exposeFunction`, and the
 * signing happens there with viem. Two reasons, both load-bearing:
 *
 *   1. The Arc leg signs against a REAL chain. A private key pasted into a
 *      browser context is a key in a screenshot, a trace and a HAR file.
 *   2. `eth_sendTransaction` on anvil could be answered by the node's own
 *      unlocked accounts -- which would work locally and be UNIMPLEMENTABLE on
 *      Arc, so the local leg would be exercising a path the Arc leg cannot.
 *      One provider, one code path, both legs.
 *
 * REJECTION IS MODELLED, NOT MOCKED AT THE UI. `rejectNext()` makes the NEXT
 * `eth_sendTransaction` throw `{ code: 4001 }`, which is what a real wallet
 * does when the user presses Cancel. The application never learns that this is
 * a test: it decodes 4001 through the same `decodeArcpadError` path as a real
 * MetaMask rejection.
 */

/** Anvil's account #5. A devchain key, and only ever a devchain key. */
export const LOCAL_USER_KEY =
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const
export const LOCAL_USER_ADDRESS: Address = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'

export type WalletOptions = {
  /** The private key that signs. Devchain key locally; a funded key on Arc. */
  readonly privateKey: Hex
  readonly rpcUrl: string
  readonly chain: Chain
  /**
   * What the provider REPORTS to `eth_chainId`. Defaults to `chain.id`.
   * Setting it to anything else is how the wrong-network screen is reached
   * without touching the app's own configuration.
   */
  readonly reportedChainId?: number
  /**
   * Start ALREADY AUTHORISED, as a wallet does for a site the user connected
   * to before. Defaults to `false`.
   *
   * NOT A CONVENIENCE. `eth_accounts` on an unauthorised site returns an EMPTY
   * array -- that is the whole mechanism by which a dapp knows to show a
   * Connect button. A provider that answered with an account regardless made
   * wagmi auto-connect on mount, the Connect button vanished mid-click, and the
   * explicit connect flow was never exercised at all. The default is therefore
   * the unauthorised state, and a spec that wants the connected page says so.
   */
  readonly authorized?: boolean
  /**
   * The address the provider REPORTS, when it differs from the key's own.
   *
   * WHY THIS EXISTS, AND IT IS NOT A CONVENIENCE. The Arc leg's central claim
   * is a READ: that the 6-decimal ERC-20 view and the 18-decimal native view
   * are one balance, and that the screen shows the 6-decimal one. Measuring it
   * needs an account with a NON-ZERO balance -- on a zero balance both views
   * are zero and every relation between them holds vacuously -- but it does
   * NOT need that account's private key.
   *
   * The funded testnet account's key lives in an encrypted keystore and is not
   * available to this harness. So the provider signs with a throwaway key and
   * REPORTS the funded address, which is exactly enough for every read path.
   * Anything that signs will be rejected by the chain (the signature will not
   * match the reported sender), and that is the point: the write tests are
   * gated on a real key rather than silently passing against a mismatch.
   */
  readonly reportedAddress?: Address
}

type RpcRequest = { method: string; params?: unknown[] }
type Envelope =
  { ok: true; result: unknown } | { ok: false; code: number; message: string; data?: unknown }

export type InjectedWallet = {
  readonly address: Address
  /** The next `eth_sendTransaction` answers `4001`, exactly once. */
  rejectNext(): void
  /** Change what the provider reports and emit `chainChanged`, as a wallet would. */
  switchReportedChain(chainId: number): Promise<void>
  /** Every method the page asked for, in order. The switch assertion reads this. */
  methods(): readonly string[]
  /** Transaction hashes this provider actually broadcast. */
  sent(): readonly Hex[]
}

const BINDING = '__arcpadWalletRequest'

export async function injectedWallet(page: Page, options: WalletOptions): Promise<InjectedWallet> {
  const account = privateKeyToAccount(options.privateKey)
  const client = createWalletClient({
    account,
    chain: options.chain,
    transport: http(options.rpcUrl),
  }).extend(publicActions)

  let reported = options.reportedChainId ?? options.chain.id
  // The address the PAGE sees. Defaults to the signing key's own.
  const shown: Address = options.reportedAddress ?? account.address
  let authorized = options.authorized ?? false
  let rejectOnce = false
  const methods: string[] = []
  const sent: Hex[] = []

  const handle = async (request: RpcRequest): Promise<Envelope> => {
    methods.push(request.method)
    const params = request.params ?? []
    try {
      switch (request.method) {
        case 'eth_requestAccounts':
          authorized = true
          return { ok: true, result: [shown] }
        case 'eth_accounts':
          return { ok: true, result: authorized ? [shown] : [] }
        case 'eth_chainId':
          return { ok: true, result: numberToHex(reported) }
        case 'net_version':
          return { ok: true, result: String(reported) }
        case 'wallet_switchEthereumChain': {
          const target = (params[0] as { chainId?: Hex } | undefined)?.chainId
          if (typeof target !== 'string') {
            return {
              ok: false,
              code: -32602,
              message: 'wallet_switchEthereumChain needs a chainId',
            }
          }
          reported = Number(BigInt(target))
          return { ok: true, result: null }
        }
        case 'eth_sendTransaction': {
          if (rejectOnce) {
            rejectOnce = false
            // The literal shape a wallet returns. `4001` is EIP-1193's
            // "user rejected request"; the app must not print a red box for it.
            return { ok: false, code: 4001, message: 'User rejected the request.' }
          }
          const tx = params[0] as {
            to?: Address
            data?: Hex
            value?: Hex
            gas?: Hex
          }
          const hash = await client.sendTransaction({
            account,
            chain: options.chain,
            ...(tx.to === undefined ? {} : { to: tx.to }),
            ...(tx.data === undefined ? {} : { data: tx.data }),
            ...(tx.value === undefined ? {} : { value: BigInt(tx.value) }),
            ...(tx.gas === undefined ? {} : { gas: BigInt(tx.gas) }),
          })
          sent.push(hash)
          return { ok: true, result: hash }
        }
        default: {
          // Everything else is a READ, and reads go to the node untouched. A
          // provider that answered them from a fixture would be a double doing
          // the real code's job -- failure mode 5 in AGENT-CONTEXT.
          const result = await client.request({
            method: request.method as never,
            params: params as never,
          })
          return { ok: true, result }
        }
      }
    } catch (error) {
      const anyError = error as { code?: number; message?: string; data?: unknown }
      return {
        ok: false,
        code: typeof anyError.code === 'number' ? anyError.code : -32603,
        message: anyError.message ?? String(error),
        ...(anyError.data === undefined ? {} : { data: anyError.data }),
      }
    }
  }

  await page.exposeFunction(BINDING, handle)

  await page.addInitScript(
    ({ binding, address }: { binding: string; address: string }) => {
      type Listener = (...args: unknown[]) => void
      const listeners = new Map<string, Set<Listener>>()

      const emit = (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      }

      const provider = {
        isMetaMask: false,
        isArcpadTestWallet: true,
        async request(args: { method: string; params?: unknown[] }) {
          const call = (window as unknown as Record<string, unknown>)[binding] as (
            r: unknown,
          ) => Promise<{ ok: true; result: unknown } | { ok: false; code: number; message: string }>
          const envelope = await call({ method: args.method, params: args.params ?? [] })
          if (envelope.ok) return envelope.result
          // The CODE must survive the crossing. wagmi/viem classify on
          // `error.code`, and an Error whose code was lost would be
          // indistinguishable from an RPC failure -- which is exactly the
          // difference the rejection step is measuring.
          const error = new Error(envelope.message) as Error & { code: number }
          error.code = envelope.code
          throw error
        },
        on(event: string, listener: Listener) {
          const set = listeners.get(event) ?? new Set<Listener>()
          set.add(listener)
          listeners.set(event, set)
          return provider
        },
        removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener)
          return provider
        },
      }

      Object.defineProperty(window, 'ethereum', {
        value: provider,
        configurable: true,
        writable: true,
      })

      // EIP-6963. wagmi 3 discovers providers by announcement, and the
      // wallet dialog's list comes from `useConnectors()` -- a provider that
      // only set `window.ethereum` would show up under a generic name, or not
      // at all, depending on discovery order.
      const detail = Object.freeze({
        info: Object.freeze({
          uuid: '4f4c9c1e-2c92-4a44-8b3e-9e4d5c1f0a11',
          name: 'Arcpad E2E Wallet',
          icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
          rdns: 'dev.arcpad.e2e',
        }),
        provider,
      })
      const announce = () =>
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
      ;(window as unknown as Record<string, unknown>).__arcpadWallet = {
        address,
        emitChainChanged: (chainIdHex: string) => emit('chainChanged', chainIdHex),
        emitAccountsChanged: (accounts: string[]) => emit('accountsChanged', accounts),
      }
    },
    { binding: BINDING, address: shown },
  )

  return {
    address: shown,
    rejectNext: () => {
      rejectOnce = true
    },
    switchReportedChain: async (chainId: number) => {
      reported = chainId
      await page.evaluate((hex) => {
        const wallet = (window as unknown as Record<string, unknown>).__arcpadWallet as
          { emitChainChanged?: (h: string) => void } | undefined
        wallet?.emitChainChanged?.(hex)
      }, numberToHex(chainId))
    },
    methods: () => methods,
    sent: () => sent,
  }
}

/**
 * Clicks the SHELL's Connect button and picks the injected wallet.
 *
 * Scoped to the banner deliberately: `/create` also renders a disabled
 * "Connect wallet" submit button, and an unscoped locator matches both. That
 * is not a test detail -- it is the reason the trade panel delegates
 * connection to the shell instead of growing a second connector list.
 */
export async function connectWallet(page: Page): Promise<void> {
  const chip = page.getByRole('button', { name: /Your wallet/ })
  if ((await chip.count()) > 0) return
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Arcpad E2E Wallet' }).click()
  // The connected state is a DIFFERENT control: the address chip. Waiting on
  // the dialog closing would pass while the connection was still pending.
  await page.getByRole('button', { name: /Your wallet/ }).waitFor({ state: 'visible' })
}
