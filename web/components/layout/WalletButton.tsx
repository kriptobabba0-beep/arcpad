'use client'

import { useState } from 'react'
import { useConnect, useConnectors, useDisconnect } from 'wagmi'
import { Address } from '@/components/ui/Address'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Money } from '@/components/ui/Money'
import { getWebConfig } from '@/lib/addresses'
import { BRAND } from '@/lib/brand'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { useUsdcBalance } from './useUsdcBalanceStub'

/**
 * K1'IN GORUNDUGU YER.
 *
 * Arc'ta native gaz varligi USDC'nin KENDISIDIR ve ayni fonun iki okumasi
 * vardir: 18 ondalikli native ve 6 ondalikli ERC-20. Bu dugme BIR SATIR cizer
 * ve o satir 6 ondalikli gorunumdur. Iki figur gostermek -- ya da daha kotusu
 * ikisini toplamak -- 1e12'lik bir hatadir ve hicbir calisma zamani kontrolu
 * onu goremez.
 *
 * Menudeki tek cumle bunu kullaniciya da soyler, cunku cuzdanin kendisi 18
 * ondalikli gorunumu gosterecek ve iki ekranin ayni fon icin farkli sayilar
 * yazmasi, aciklanmadigi surece, bir hata gibi okunur.
 */
const TWO_VIEWS_NOTE =
  "USDC is Arc's gas asset. Your wallet may show 18 decimals; this is the same balance."

export function WalletButton() {
  const { status, address, wrongNetwork, switchToArc, isSwitching } = useArcNetwork()
  const { balance } = useUsdcBalance()
  const connectors = useConnectors()
  // wagmi 3.7.4: `connect`/`connectors` ve `disconnect` @deprecated takma
  // adlar; sanctioned yol `mutate`. Ayni sinif S15'in `useAccount` bulgusuyla.
  const { mutate: connect, isPending: isConnecting } = useConnect()
  const { mutate: disconnect } = useDisconnect()
  const { chain } = getWebConfig()

  const [picking, setPicking] = useState(false)
  const [account, setAccount] = useState(false)

  if (status !== 'connected' || !address) {
    return (
      <>
        <Button variant="primary" onClick={() => setPicking(true)} disabled={isConnecting}>
          {isConnecting ? 'Connecting…' : 'Connect wallet'}
        </Button>
        <Dialog
          open={picking}
          onClose={() => setPicking(false)}
          title="Connect a wallet"
          description={`${BRAND.name} never holds your keys. You sign every transaction in your own wallet on ${chain.name}.`}
        >
          {/*
            Liste EIP-6963 ile KESFEDILIR (`useConnectors`), elle yazilmaz.
            Sabit bir cuzdan listesi, kurulu olmayan cuzdanlari onerir ve
            kurulu olan yenilerini gizler.
          */}
          {connectors.length === 0 ? (
            <p className="text-sm text-muted">
              No wallet found in this browser. Install a wallet extension, then reload this page.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {connectors.map((connector) => (
                <li key={connector.uid}>
                  <button
                    type="button"
                    onClick={() => {
                      connect({ connector })
                      setPicking(false)
                    }}
                    className="flex w-full items-center gap-3 rounded-input border border-border bg-surface-2 px-3 py-2.5 text-left text-sm transition-colors duration-150 hover:border-white/20"
                  >
                    {connector.icon ? (
                      <img
                        src={connector.icon}
                        alt=""
                        width={20}
                        height={20}
                        className="rounded-sm"
                      />
                    ) : (
                      <span className="size-5 rounded-sm bg-white/10" aria-hidden="true" />
                    )}
                    {connector.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Dialog>
      </>
    )
  }

  if (wrongNetwork) {
    return (
      <Button variant="primary" onClick={switchToArc} disabled={isSwitching}>
        {isSwitching ? 'Switching…' : `Switch to ${chain.name}`}
      </Button>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAccount(true)}
        // TEK SATIR. `whitespace-nowrap` bir susleme degil: adres ve bakiye
        // sarildiginda iki satir olur ve iki satir "iki bakiye" gibi okunur.
        className="inline-flex h-10 items-center gap-2.5 whitespace-nowrap rounded-input border border-border bg-surface px-3 text-sm transition-colors duration-150 hover:border-white/20"
      >
        <Address value={address} label="Your wallet" className="text-text" />
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        {balance ? (
          <Money native={balance.wei} rounding="down" unit className="text-muted" />
        ) : (
          <span className="tabular-nums text-muted">—</span>
        )}
      </button>

      <Dialog open={account} onClose={() => setAccount(false)} title="Wallet" size="md">
        <dl className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <dt className="text-[13px] text-muted">Address</dt>
            <dd className="text-sm">
              <Address value={address} shorten={false} copy explorer label="Your wallet" />
            </dd>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-[13px] text-muted">Balance</dt>
            <dd className="text-2xl font-medium">
              {balance ? (
                <Money native={balance.wei} rounding="down" unit />
              ) : (
                <span className="tabular-nums text-muted">—</span>
              )}
            </dd>
            <dd className="text-[12px] leading-snug text-muted">{TWO_VIEWS_NOTE}</dd>
          </div>
        </dl>

        <div className="mt-5 border-t border-border pt-4">
          <Button
            variant="danger"
            className="w-full"
            onClick={() => {
              disconnect({})
              setAccount(false)
            }}
          >
            Disconnect
          </Button>
        </div>
      </Dialog>
    </>
  )
}
