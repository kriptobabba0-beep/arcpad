'use client'

import type { LimitOrderRow } from '@arcpad/db'
import type { CurveProfile } from '@arcpad/shared/browser'
import { useCallback, useEffect, useState } from 'react'
import type { HexAddress, Page, ReadResult } from '@/components/read/types'
import { Tabs } from '@/components/ui/Tabs'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { LimitPanel } from './LimitPanel'
import type { Lifecycle } from './lifecycle'
import { OrdersPanel } from './OrdersPanel'
import { PoolTradePanel } from './PoolTradePanel'
import { TradePanel } from './TradePanel'

/**
 * ==========================================================================
 *  ONE COMPONENT DECIDES WHICH VENUE A TOKEN TRADES ON. ONE, NOT TWO.
 * ==========================================================================
 *
 * `app/token/[address]/page.tsx` has TWO branches -- the indexer row and the
 * chain-drawn fallback -- and both of them must offer trading, because the
 * chain-drawn branch is what a user sees when the indexer is DOWN, which is
 * exactly when they most need the panel to keep working.
 *
 * This repository has shipped "fixed on one branch, forgotten on the other"
 * enough times to name it: `TradePanel` written and rendered by no page,
 * `CurveChart`'s realised layer, the two missing `loadMore*` props, the
 * `graduated` field the page did not pass, two switch controls on one composed
 * screen, and the same false sentence living in two components. Every one of
 * those had a green component test.
 *
 * So the venue choice is made HERE, once, and the page renders this component
 * on both branches. Forgetting the pool on one branch is no longer a thing that
 * can be done by omission -- it would take deleting a call site, which
 * `test/pool/page.test.ts` counts.
 *
 * ============ THE PROFILE IS OPTIONAL, AND THAT IS A REAL FIX ============
 *
 * The page used to write `profile === null ? null : <TradePanel …/>`. The pool
 * panel does not need a curve profile at all -- the curve is closed and the
 * pool's price comes from the router. Keeping that guard around both venues
 * would mean a graduated token loses its ONLY trading surface because a read it
 * does not use failed.
 *
 * ==========================================================================
 *  FAZ 7: `Market | Limit | Orders`, VE NEDEN ARTIK CIZILIYORLAR
 * ==========================================================================
 *
 * Faz 4 bu serit icin ADIYLA su karari verdi: *"bu fazda YALNIZCA `Market`
 * sekmesi render edilir, diger ikisi hic cizilmez. Gerekce: tiklandiginda
 * hicbir sey yapmayan bir sekme, olmayan bir sekmeden kotudur."* `Tabs.tsx`
 * bunu bir bilesen sozlesmesine cevirdi -- "devre disi sekme" degil,
 * "cizilmeyen sekme": gelmeyen sekme `items`a HIC KONMAZ.
 *
 * O kural burada da geceridir ve bu yuzden `Limit` ile `Orders` ancak ISLERI
 * OLDUGU IÇIN listeye giriyor. Ikisinin de yaptigi sey gercektir; yalnizca
 * `Limit`in verdigi soz, verilebilecek en genis soz DEGILDIR ve panelin
 * kendisi bunu iki cumleyle yaziyor.
 *
 * ==========================================================================
 *  BU DOSYA ARTIK BIR ISTEMCI BILESENI, VE BEDELI OLCULDU
 * ==========================================================================
 *
 * Sekme secimi bir tarayici durumudur; sunucu hangi sekmenin acik oldugunu
 * bilemez. Alternatif -- secimi URL'e koymak -- her sekme degisiminde bir
 * sunucu gidis donusu demekti ve panel zaten `'use client'`ti. Aldigi butun
 * proplar serilestirilebilir ve `TradePanel` ZATEN ayni proplari (bigint
 * tasiyan `profile` dahil) sunucu sinirindan geciriyordu.
 */
export type TradeSurfaceProps = {
  readonly token: HexAddress
  readonly curve: HexAddress
  readonly lifecycle: Lifecycle
  /** `null` -> `getCurveProfile()` failed. Only the curve panel needs it. */
  readonly profile: CurveProfile | null
  readonly symbol: string
  /**
   * Bagli cuzdanin emirlerini getirir. `undefined` -> "Orders" sekmesi hic
   * cizilmez, cunku okuyacagi bir sey yoktur.
   *
   * NEDEN BIR PROP: bu dosya bir istemci bileseni ve `@arcpad/db`ye ya da
   * `@/lib/read`e DOKUNAMAZ (`pg` tarayici paketine girerdi -- `next build`i
   * dusuren olculmus hata). Sayfa server action'i baglar ve gecer; ayni
   * `loadMoreChat` deseni.
   */
  readonly loadOrders?: (
    owner: string,
    cursor: string | null,
  ) => Promise<ReadResult<Page<LimitOrderRow>>>
}

type Mode = 'market' | 'limit' | 'orders'

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  market: 'Market',
  limit: 'Limit',
  orders: 'Orders',
}

export function TradeSurface({
  token,
  curve,
  lifecycle,
  profile,
  symbol,
  loadOrders,
}: TradeSurfaceProps) {
  const [mode, setMode] = useState<Mode>('market')
  const network = useArcNetwork()
  const owner = network.address
  const [orders, setOrders] = useState<ReadResult<Page<LimitOrderRow>> | null>(null)

  const refresh = useCallback(() => {
    if (loadOrders === undefined || owner === undefined) {
      setOrders(null)
      return
    }
    void loadOrders(owner, null).then(setOrders, () => {
      setOrders({ ok: false, reason: 'unavailable', indexer: null })
    })
  }, [loadOrders, owner])

  useEffect(() => {
    // Cuzdan baglandiginda ya da DEGISTIGINDE yeniden okunur. Adres
    // bagimliligi tasiyicidir: cuzdan degistirip ayni listeyi gormek,
    // baskasinin emirlerini kendi emri sanmak demekti.
    refresh()
  }, [refresh])

  /*
   * GRADUATED FIRST. `resolveLifecycle` already orders `graduated` above
   * `complete` because on chain `graduated => complete` always holds and a
   * stale indexer row can show them apart for a moment -- when it does, the
   * FURTHER state is the true one. Repeating that order here rather than
   * checking `complete` keeps one rule in one place.
   */
  const graduated = lifecycle.kind === 'graduated'
  const market = graduated ? (
    <PoolTradePanel token={token} symbol={symbol} />
  ) : profile === null ? null : (
    <TradePanel token={token} curve={curve} lifecycle={lifecycle} profile={profile} symbol={symbol} />
  )

  /*
   * ============ HANGI SEKMELER CIZILIR -- `Tabs.tsx`IN KURALI ============
   *
   * `Limit` YALNIZCA curve mekaninda cizilir. Mezun olmus bir token'da bir
   * limit emrinin dolmasi HAVUZ kotasini ister ve keeper'in havuz yolu bugun
   * CANLI BIR HAVUZA KARSI HIC CALISMADI -- uretim factory'sinin
   * `graduationTarget`i `0x0`, yani zincirde tek bir arcpad havuzu yok.
   * Calistigini iddia edemedigimiz bir sekmeyi cizmek, tiklandiginda hicbir
   * sey yapmayan bir sekmeden farksiz olurdu.
   *
   * `Orders` HER IKI durumda da cizilir (emirler token'a asilidir ve mezun bir
   * token'da da GECMIS emirler gorunmelidir) -- ama yalnizca onlari
   * getirebilecek bir yol varsa.
   */
  const items: { id: Mode; label: string }[] = [{ id: 'market', label: MODE_LABEL.market }]
  if (!graduated && profile !== null) items.push({ id: 'limit', label: MODE_LABEL.limit })
  if (loadOrders !== undefined) items.push({ id: 'orders', label: MODE_LABEL.orders })

  // Tek sekme kaldiysa serit CIZILMEZ: bir sekme seridi bir SECIM vaat eder.
  const strip =
    items.length > 1 ? (
      <Tabs
        items={items}
        value={mode}
        onChange={(next) => {
          setMode(next as Mode)
        }}
        label="Trading mode"
        idBase="surface"
      />
    ) : null

  // Cizilmeyen bir sekme SECILI KALAMAZ. Curve mezun olurken `Limit` acik
  // olsaydi, panel bos bir govde cizerdi.
  const active: Mode = items.some((i) => i.id === mode) ? mode : 'market'

  return (
    <div className="flex flex-col gap-3" data-testid="trade-surface">
      {strip}
      <div
        role="tabpanel"
        id={`surface-panel-${active}`}
        aria-labelledby={`surface-tab-${active}`}
      >
        {active === 'market' ? market : null}
        {active === 'limit' && profile !== null ? (
          <LimitPanel token={token} curve={curve} symbol={symbol} profile={profile} />
        ) : null}
        {active === 'orders' ? (
          <OrdersPanel
            token={token}
            curve={curve}
            symbol={symbol}
            orders={orders}
            onChanged={refresh}
          />
        ) : null}
      </div>
    </div>
  )
}
