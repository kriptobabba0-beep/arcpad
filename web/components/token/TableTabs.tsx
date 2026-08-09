'use client'

import { useState } from 'react'
import type { HolderRow, Page, ReadResult, TokenOverview, TradeRow } from '@/components/read/types'
import { cx } from '@/components/ui/cx'
import { Tabs } from '@/components/ui/Tabs'
import { HoldersTable, visibleHolders } from './HoldersTable'
import type { LoadMore } from './tableShell'
import { UnavailableNotice, useKeysetRows } from './tableShell'
import { TradesTable } from './TradesTable'
import { valueOf } from '@/components/read/result'

/**
 * Token sayfasinin bu bilesene verdigi tek sey; `TokenOverview`'un DORT alani.
 *
 * `graduatedSeq` DORDUNCU OLARAK EKLENDI ve bir gosterim tercihi degil: islem
 * listesi mezuniyetten sonra IKI MEKANI birden tasir ve satirin kendisi hangisi
 * oldugunu soylemiyor (`listTrades` `source` kolonunu secmiyor -- bkz.
 * `venue.ts`). Bu alan ayrimin ta kendisini tasir.
 */
export type TableTabsOverview = Pick<
  TokenOverview,
  'curve' | 'launchCreator' | 'symbol' | 'graduatedSeq'
>

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
 * SABIT BIR BOS DIZI, ve bu referansin sabit olmasi ZORUNLU.
 *
 * `useKeysetRows` `state.base !== rows` gordugunde RENDER SIRASINDA
 * `setState` cagirir -- biriken sayfalari atmanin dogru yolu budur. Her
 * render'da yeni bir `[]` verilseydi bu kosul HER SEFERINDE dogru olur ve
 * bileşen sonsuz dongude yeniden cizilirdi.
 */
const NO_ROWS: readonly never[] = []

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
  // Sayfadaki satir sayisi -- TOPLAM DEGIL. Faz 3'un `Page<T>`'si toplam
  // vermiyor ve sayfa boyutunu "toplam" diye yazmak uydurma bir kesinlik olur.
  const tradePage = valueOf(trades)
  const holderPage = valueOf(holders)

  /*
   * SAYFALAMA DURUMU BURADA, TABLONUN ICINDE DEGIL.
   *
   * Sebep dogrudan yukaridaki sayidir. "Load more" calisir hale geldiginde
   * tablo 50 satir cizerken sunucunun ilk sayfasindan okunan etiket hâlâ
   * "Trades (25)" derdi -- yani bir bosluğu kapatan degisiklik, KENDI ICINDE
   * yanlis bir sayi uretirdi. Durum ust bileşende oldugunda etiket ile tablo
   * AYNI diziyi sayar ve ayrisamazlar.
   *
   * Holders tarafinda ikinci bir sebep var: `page.rows.length` curve satirini
   * ve tekrarlanan bir holder'i SAYAR ama tablo onlari CIZMEZ. `visibleHolders`
   * tablonun kullandigi suzgecin ta kendisidir.
   */
  const tradeKeyset = useKeysetRows(
    tradePage?.rows ?? NO_ROWS,
    tradePage?.nextCursor ?? null,
    loadMoreTrades,
  )
  const holderKeyset = useKeysetRows(
    holderPage?.rows ?? NO_ROWS,
    holderPage?.nextCursor ?? null,
    loadMoreHolders,
  )

  const shownHolders = visibleHolders(holderKeyset.rows, overview?.curve)

  /**
   * Sayi YALNIZCA okuma basarili oldugunda yazilir -- ve o sayi EKRANDAKI
   * satir sayisidir, gelen sayfanin uzunlugu degil.
   */
  const count = (result: ReadResult<Page<unknown>>, shown: number): string =>
    valueOf(result) === undefined ? '' : ` (${shown})`

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <Tabs
        items={[
          { id: IDS.trades, label: `Trades${count(trades, tradeKeyset.rows.length)}` },
          { id: IDS.holders, label: `Holders${count(holders, shownHolders.length)}` },
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
        {tradePage !== undefined ? (
          <TradesTable
            rows={tradePage.rows}
            nextCursor={tradePage.nextCursor}
            keyset={tradeKeyset}
            tradePanelHref={tradePanelHref}
            {...(overview ? { symbol: overview.symbol, graduatedSeq: overview.graduatedSeq } : {})}
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
        {holderPage !== undefined ? (
          <HoldersTable
            rows={holderPage.rows}
            nextCursor={holderPage.nextCursor}
            keyset={holderKeyset}
            {...(overview
              ? {
                  curve: overview.curve,
                  launchCreator: overview.launchCreator,
                  symbol: overview.symbol,
                }
              : {})}
          />
        ) : (
          <UnavailableNotice what="Holder data" />
        )}
      </div>
    </div>
  )
}
