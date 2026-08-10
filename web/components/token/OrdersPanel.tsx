'use client'

import type { LimitOrderRow } from '@arcpad/db'
import { bondingCurveAbi, formatTokenAmount } from '@arcpad/shared/browser'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { HexAddress, Page, ReadResult } from '@/components/read/types'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Money } from '@/components/ui/Money'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { useApproval } from './useApproval'
import { useOrderPost } from './useOrderPost'
import { useTokenBalance } from './useTokenBalance'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'

/**
 * ==========================================================================
 *  ORDERS SEKMESI -- BIR EMIR DEFTERI DEGIL, BIR TAAHHUT LISTESI
 * ==========================================================================
 *
 * Ekranin en onemli isi bir listeyi cizmek DEGIL, uc durumu birbirinden
 * ayirmaktir, cunku ucu de kullanicidan FARKLI bir sey ister:
 *
 *   open       fiyat henuz gelmedi. Yapacak bir sey yok.
 *   triggered  keeper zincirde kabul edilebilir oldugunu OLCTU. "Fill" burada.
 *   fonu yok   emrin fiyati gelse bile islem dusecek -- ve bunu SOYLEMEK
 *              zorundayiz, cunku dolmayan bir emir sessiz kalirsa kullanici
 *              urunun bozuk oldugunu dusunur.
 *
 * UCUNCUSU VERITABANINDAN GELMEZ, BURADA CANLI OKUNUR. Keeper fonu yetmeyen
 * bir emri SILMEZ (spec §8'in "iptal et" cumlesinden bilincli bir sapma: bir
 * bakiye anliktir, bir emir degildir) ve bunu bir sutuna da yazmaz -- cunku
 * bu panel zaten bagli cuzdanin bakiyesini okuyor. Iki yerde iki kopya
 * olmasindansa, tek yerde CANLI olani.
 *
 * ==========================================================================
 *  "Fill" DUGMESI EMRIN KENDI SINIRINI GONDERIR
 * ==========================================================================
 *
 * `buyExactQuoteIn(order.minOut)` ve `sellExactTokensIn(order.amount,
 * order.minOut)`. Yeni bir kota HESAPLANMAZ ve hesaplanmamalidir: emrin
 * sakladigi sayi ZATEN zincirin argumanidir, ve o sayiyi burada yeniden
 * turetmek "kullanicinin imzaladigi sey" ile "zincire giden sey" arasinda
 * ikinci bir yol acardi.
 *
 * SONUCU BUDUR: keeper yanlislikla ya da kotu niyetle erken tetiklemis olsa
 * bile islem `SlippageExceeded` ile REVERT eder. Kullanici gaz oder, para
 * kaybetmez.
 */

export type OrdersPanelProps = {
  readonly token: HexAddress
  readonly curve: HexAddress
  readonly symbol: string
  /** Sunucudan gelen ilk sayfa; `null` -> cuzdan henuz baglanmadi. */
  readonly orders: ReadResult<Page<LimitOrderRow>> | null
  readonly onChanged?: () => void
}

export function OrdersPanel({ token, curve, symbol, orders, onChanged }: OrdersPanelProps) {
  const network = useArcNetwork()
  const owner = network.address as HexAddress | undefined
  const connected = network.status === 'connected' && owner !== undefined

  if (!connected) {
    return (
      <Card className="flex flex-col gap-3 px-4 py-4" data-testid="orders-panel">
        <p className="text-[12px] text-muted" data-testid="orders-disconnected">
          Connect a wallet to see your orders. Orders belong to an address, not to this browser.
        </p>
      </Card>
    )
  }

  return (
    <Card className="flex flex-col gap-3 px-4 py-4" data-testid="orders-panel">
      {/*
        GIZLILIK BEDELI EKRANDA. Okuma yolu imza istemez (bkz. `readOrders`),
        yani bir adresi bilen herkes o adresin acik emirlerini gorebilir.
        Kullaniciya soylenmeyen bir sizinti, sizintinin en kotusudur.
      */}
      <p className="text-[11px] text-muted" data-testid="orders-visibility-note">
        Your open orders are readable by anyone who knows your address. Nobody can fill, cancel or
        change them — those need your signature.
      </p>
      {orders === null || !orders.ok ? (
        <p className="text-[12px] text-muted" data-testid="orders-unavailable">
          Your orders could not be loaded.
        </p>
      ) : (
        <OrderList
          token={token}
          curve={curve}
          symbol={symbol}
          owner={owner}
          rows={orders.stale ? orders.staleData.rows : orders.data.rows}
          {...(onChanged === undefined ? {} : { onChanged })}
        />
      )}
    </Card>
  )
}

function OrderList({
  token,
  curve,
  symbol,
  owner,
  rows,
  onChanged,
}: {
  token: HexAddress
  curve: HexAddress
  symbol: string
  owner: HexAddress
  rows: readonly LimitOrderRow[]
  onChanged?: () => void
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-muted" data-testid="orders-empty">
        No orders on this token yet.
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-3" data-testid="orders-list">
      {rows.map((row) => (
        <OrderRow
          key={row.orderSeq.toString()}
          row={row}
          token={token}
          curve={curve}
          symbol={symbol}
          owner={owner}
          {...(onChanged === undefined ? {} : { onChanged })}
        />
      ))}
    </ul>
  )
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  open: 'Waiting for the price',
  triggered: 'Ready to fill',
  filled: 'Filled',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

function OrderRow({
  row,
  token,
  curve,
  symbol,
  owner,
  onChanged,
}: {
  row: LimitOrderRow
  token: HexAddress
  curve: HexAddress
  symbol: string
  owner: HexAddress
  onChanged?: () => void
}) {
  const router = useRouter()
  const post = useOrderPost(owner)
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    query: { enabled: write.data !== undefined },
  })

  const usdc = useUsdcBalance()
  const tokenBalance = useTokenBalance(token, owner)
  // ONAY YALNIZCA SATISTA, ve yalnizca CANLI bir emir icin.
  const live = row.status === 'open' || row.status === 'triggered'
  const approval = useApproval(token, curve, owner, !row.isBuy && live ? row.amount : null)

  /** Fonu yetiyor mu -- CANLI, veritabanindan degil. `null` -> olculemedi. */
  const held = row.isBuy ? usdc.native.wei : tokenBalance
  const underfunded = held !== null && held < row.amount

  const [reported, setReported] = useState(false)
  const txHash = write.data

  /**
   * MAKBUZ GELDIGINDE EMRI KAPAT -- VE SUNUCU BUNU DOGRULASIN.
   *
   * Rota `eth_getTransactionReceipt` ile logu cozer ve `trader == owner`
   * olmadan `filled` YAZMAZ, yani buradaki cagri bir IDDIA, yazilan sey bir
   * OLCUMDUR.
   *
   * `reported` bir kez'lik muhafizdir: `useWaitForTransactionReceipt` her
   * render'da ayni makbuzu dondurur ve muhafizsiz bir efekt onu sonsuz kere
   * gonderirdi. Sunucu tarafi zaten idempotenttir (`markFilled` yalnizca
   * CANLI durumlardan gecirir), yani bu bir DOGRULUK degil bir MALIYET
   * korumasidir -- ve ikisinin ayrimi yazili olmali.
   */
  useEffect(() => {
    if (reported || txHash === undefined) return
    if (receipt.data?.status !== 'success') return
    setReported(true)
    void post
      .resolve({ token, orderSeq: row.orderSeq.toString(), intent: 'filled', txHash })
      .then((ok) => {
        if (!ok) return
        onChanged?.()
        router.refresh()
      })
    // Yalnizca MAKBUZ ANINDA kosar. `post` ve `router` her render'da kimlik
    // degistirir ve listeye konsalardi efekt sonsuz bir donguye girerdi.
  }, [receipt.data?.status, txHash, reported])

  const fill = useCallback(() => {
    if (row.isBuy) {
      write.writeContract({
        address: curve as `0x${string}`,
        abi: bondingCurveAbi,
        functionName: 'buyExactQuoteIn',
        args: [row.minOut],
        value: row.amount,
      })
      return
    }
    write.writeContract({
      address: curve as `0x${string}`,
      abi: bondingCurveAbi,
      functionName: 'sellExactTokensIn',
      args: [row.amount, row.minOut],
    })
  }, [row, curve, write])

  const cancel = useCallback(async () => {
    const ok = await post.resolve({ token, orderSeq: row.orderSeq.toString(), intent: 'cancel' })
    if (!ok) return
    onChanged?.()
    router.refresh()
  }, [post, token, row.orderSeq, onChanged, router])

  const busy = post.state.kind === 'signing' || post.state.kind === 'sending'
  const needsApproval = !row.isBuy && approval.state === 'required'

  return (
    <li className="flex flex-col gap-1 border-b border-border pb-3" data-testid="order-row">
      <p className="text-[13px]">
        <span className="font-medium">{row.isBuy ? 'Buy' : 'Sell'}</span>{' '}
        <span className="tabular-nums" data-testid="order-amount">
          {row.isBuy ? (
            <Money native={row.amount} rounding="up" unit />
          ) : (
            `${formatTokenAmount(row.amount)} ${symbol}`
          )}
        </span>{' '}
        <span className="text-muted">for at least</span>{' '}
        <span className="tabular-nums" data-testid="order-min-out">
          {row.isBuy ? (
            `${formatTokenAmount(row.minOut)} ${symbol}`
          ) : (
            <Money native={row.minOut} rounding="down" unit />
          )}
        </span>
      </p>

      <p className="text-[12px] text-muted" data-testid="order-status">
        {STATUS_LABEL[row.status] ?? row.status}
        {row.status === 'triggered' && row.triggerBlockNumber !== null ? (
          <span className="tabular-nums"> · since block {row.triggerBlockNumber.toString()}</span>
        ) : null}
      </p>

      {/*
        FONU YETMEYEN EMIR SESSIZ KALAMAZ. Bu satir olmasa kullanici, dolmayan
        bir emrin sebebini asla ogrenemezdi -- ve urun bozuk gorunurdu.
      */}
      {live && underfunded ? (
        <p className="text-[12px] text-negative" data-testid="order-underfunded">
          This order cannot fill: your balance is below the {row.isBuy ? 'USDC' : symbol} it
          commits.
        </p>
      ) : null}

      {live ? (
        <div className="flex items-center gap-2">
          {needsApproval ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={approval.approve}
              data-testid="order-approve"
            >
              Approve {symbol}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || write.isPending || underfunded}
              onClick={fill}
              data-testid="order-fill"
            >
              {write.isPending ? 'Confirm in wallet…' : 'Fill now'}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              void cancel()
            }}
            data-testid="order-cancel"
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <p
        role="status"
        className="text-[12px] leading-snug text-negative empty:hidden"
        data-testid="order-error"
      >
        {post.state.kind === 'error' ? post.state.message : ''}
      </p>
    </li>
  )
}
