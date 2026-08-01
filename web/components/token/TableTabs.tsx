'use client'

import { useState } from 'react'
import type { HolderRow, Page, ReadResult, TokenOverview, TradeRow } from '@/components/read/types'
import { cx } from '@/components/ui/cx'
import { Tabs } from '@/components/ui/Tabs'
import { HoldersTable } from './HoldersTable'
import type { LoadMore } from './tableShell'
import { UnavailableNotice } from './tableShell'
import { TradesTable } from './TradesTable'

/** Token sayfasinin bu bilesene verdigi tek sey; `TokenOverview`'un uc alani. */
export type TableTabsOverview = Pick<TokenOverview, 'curve' | 'launchCreator' | 'symbol'>

export type TableTabsProps = {
  readonly trades: ReadResult<Page<TradeRow>>
  readonly holders: ReadResult<Page<HolderRow>>
  readonly overview?: TableTabsOverview
  readonly tradePanelHref?: string
  readonly loadMoreTrades?: LoadMore<TradeRow>
  readonly loadMoreHolders?: LoadMore<HolderRow>
  readonly now?: number
  readonly className?: string
}

const IDS = { trades: 'trades', holders: 'holders' } as const
type TableTabId = (typeof IDS)[keyof typeof IDS]

/**
 * IKI TABLO, IKI SEKME, VE IKI BAGIMSIZ DUSUS.
 *
 * `trades` ile `holders` AYRI `ReadResult`'lardir ve ayri ayri cizilir: biri
 * dustugunde oteki gorunmeye devam eder. Tek bir "veri yok" dali cizmek, iki
 * ayri sorgudan biri yavasladiginda calisan tarafi da karartirdi.
 *
 * IKI PANEL DE AGACTA DURUR, secili olmayan `hidden` ile gizlenir. Cizilmeyen
 * bir panel, sekmenin `aria-controls`'unu var olmayan bir id'ye baglar --
 * ekran okuyucu "kontrol ettigi sey yok" der. `hidden` ise hem gorunumden hem
 * erisilebilirlik agacindan cikarir, id ise yerinde kalir.
 */
export function TableTabs({
  trades,
  holders,
  overview,
  tradePanelHref = '#trade',
  loadMoreTrades,
  loadMoreHolders,
  now,
  className,
}: TableTabsProps) {
  const [tab, setTab] = useState<TableTabId>(IDS.trades)
  const idBase = 'token-tables'

  /**
   * Sayi YALNIZCA okuma basarili oldugunda yazilir. Dusmus bir okumada `(0)`
   * yazmak, "hic islem yok" ile "sayamiyoruz" arasindaki farki siler -- ve bu
   * fark, kullanicinin sayfaya guvenip guvenmeyeceginin tamami.
   */
  const count = (result: ReadResult<Page<unknown>>): string =>
    result.ok ? ` (${result.data.total})` : ''

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <Tabs
        items={[
          { id: IDS.trades, label: `Trades${count(trades)}` },
          { id: IDS.holders, label: `Holders${count(holders)}` },
        ]}
        value={tab}
        onChange={(id) => setTab(id === IDS.holders ? IDS.holders : IDS.trades)}
        label="Token activity"
        idBase={idBase}
      />

      <div
        role="tabpanel"
        id={`${idBase}-panel-${IDS.trades}`}
        aria-labelledby={`${idBase}-tab-${IDS.trades}`}
        hidden={tab !== IDS.trades}
        // Panelin kendisi odaklanabilir: icinde odaklanabilir bir sey
        // olmadiginda (bos durum metni) klavye kullanicisi seritten cikip
        // icerigi okuyabilmeli.
        tabIndex={0}
      >
        {trades.ok ? (
          <TradesTable
            rows={trades.data.rows}
            nextCursor={trades.data.nextCursor}
            tradePanelHref={tradePanelHref}
            {...(overview ? { symbol: overview.symbol } : {})}
            {...(loadMoreTrades ? { loadMore: loadMoreTrades } : {})}
            {...(now === undefined ? {} : { now })}
          />
        ) : (
          <UnavailableNotice what="Trade history" />
        )}
      </div>

      <div
        role="tabpanel"
        id={`${idBase}-panel-${IDS.holders}`}
        aria-labelledby={`${idBase}-tab-${IDS.holders}`}
        hidden={tab !== IDS.holders}
        tabIndex={0}
      >
        {holders.ok ? (
          <HoldersTable
            rows={holders.data.rows}
            nextCursor={holders.data.nextCursor}
            {...(overview
              ? {
                  curve: overview.curve,
                  launchCreator: overview.launchCreator,
                  symbol: overview.symbol,
                }
              : {})}
            {...(loadMoreHolders ? { loadMore: loadMoreHolders } : {})}
          />
        ) : (
          <UnavailableNotice what="Holder data" />
        )}
      </div>
    </div>
  )
}
