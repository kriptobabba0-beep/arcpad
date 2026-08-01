'use client'

import { useCallback, useState, type ReactNode } from 'react'
import type { Page, ReadResult } from '@/components/read/types'
import { Button } from '@/components/ui/Button'
import { cx } from '@/components/ui/cx'

/**
 * IKI TABLONUN ORTAK GOVDESI: SINIF RECETELERI, KEYSET "DAHA GETIR", BOS KUTU.
 *
 * Ayri bir dosya cunku iki tablo AYNI seyi iddia etmek zorunda: hicbir sarmalayici
 * yatay kaydirmaz, her sayisal hucre `text-right tabular-nums` tasir, ve dar
 * ekranda tablo satiri bir karta doner. Bunlari iki dosyaya elle kopyalamak,
 * birinde duzeltilen bir hizalamanin otekinde kalmasi demektir -- ve testin
 * yalnizca birini olctugu bir dunyada bu sessizce olur.
 */

// --------------------------------------------------------------------------
// Sinif receteleri
// --------------------------------------------------------------------------

/**
 * DAR EKRANDA TABLO BLOGA DONER, YATAY KAYDIRMAZ.
 *
 * `overflow-x-auto` BILEREK YOK. Bir para tablosunu yatay kaydirtmak, tutari
 * kolon basligindan koparir: kullanici sagda bir sayi gorur ama onun hangi
 * kolon oldugunu gormez ve "cuzdandan cikan tutar" ile "curve tutari" tam
 * olarak bu sekilde karisir. Bu yuzden < 640px'te satirlar kart olur ve her
 * hucre kendi etiketini yaninda tasir.
 */
export const TABLE_CLASS = 'w-full border-collapse text-[13px] max-sm:block'

/**
 * Dar ekranda baslik SATIRI gorsel olarak kalkar ama ERISILEBILIRLIK AGACINDAN
 * KALKMAZ (`sr-only` kirpar, `display:none` gizlerdi).
 *
 * `display:block` bir tablonun tablo semantigini tarayicida DUSURUR; bu yuzden
 * asagidaki her ogeye ACIK `role` yazilir. Rol yazilmadan yapilan bu duzen,
 * dar ekranda ekran okuyucuya bir tablo degil bir metin yigini birakir.
 */
export const THEAD_CLASS = 'max-sm:sr-only'
export const TBODY_CLASS = 'max-sm:block max-sm:space-y-2'

export const HEAD_ROW_CLASS = 'border-b border-border'

const HEAD_CELL_BASE = 'px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted'
export const HEAD_CELL_CLASS = `${HEAD_CELL_BASE} text-left`
/** Sayisal kolon basligi kolonun kendisiyle AYNI kenara yaslanir. */
export const HEAD_CELL_NUM_CLASS = `${HEAD_CELL_BASE} text-right`

export const BODY_ROW_CLASS = [
  'border-b border-border last:border-0',
  'max-sm:block max-sm:rounded-input max-sm:border max-sm:bg-surface-2 max-sm:p-3',
].join(' ')

const CELL_BASE = [
  'px-3 py-2.5 align-middle',
  'max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:px-0 max-sm:py-1',
].join(' ')

export const CELL_CLASS = CELL_BASE
/**
 * HER SAYISAL HUCRE. `tabular-nums` `<Money>`'de de var ama HUCREDE de olmak
 * zorunda: token miktari ve yuzde `<Money>`'den GECMEZ (biri `_tok`, oteki bir
 * oran) ve orantili rakamlarla cizilen bir kolon satir satir kayar.
 */
export const CELL_NUM_CLASS = `${CELL_BASE} text-right tabular-nums`

// --------------------------------------------------------------------------
// Hucre
// --------------------------------------------------------------------------

export function HeadCell({
  children,
  numeric = false,
  ...rest
}: {
  children: ReactNode
  numeric?: boolean
  title?: string
}) {
  return (
    <th
      role="columnheader"
      scope="col"
      className={numeric ? HEAD_CELL_NUM_CLASS : HEAD_CELL_CLASS}
      {...rest}
    >
      {children}
    </th>
  )
}

/**
 * `label` IKI KEZ tasinir ve bu bir tekrar degil, iki ayri kanaldir:
 *   - `<th scope="col">` erisilebilirlik agacindaki basliktir, her genislikte,
 *   - icerideki `sm:hidden` metin dar ekranda GORSEL etikettir ve
 *     `aria-hidden` oldugu icin ekran okuyucuda ikinci kez okunmaz.
 * Bir `::before content: attr(data-label)` de ayni isi gorurdu; DOM metni
 * secilebilir ve kopyalanabilir oldugu icin tercih edildi.
 */
export function Cell({
  label,
  numeric = false,
  className,
  children,
  ...rest
}: {
  label: string
  numeric?: boolean
  className?: string
  children: ReactNode
  title?: string
}) {
  return (
    <td
      role="cell"
      className={cx(numeric ? CELL_NUM_CLASS : CELL_CLASS, className)}
      data-label={label}
      {...rest}
    >
      <span aria-hidden="true" className="text-muted sm:hidden">
        {label}
      </span>
      {children}
    </td>
  )
}

// --------------------------------------------------------------------------
// Bos ve dusmus durumlar
// --------------------------------------------------------------------------

/**
 * BIR ISKELET DEGIL BIR CUMLE.
 *
 * Bu urunun ilk gununde HER token'in islem listesi bostur; orada bir iskelet
 * ya da bos bir tablo govdesi cizmek, dogru olan durumu bir hata gibi
 * gosterir. Bu yuzden bos durum bir metin ve (varsa) bir eylemdir.
 */
export function TableNotice({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-border bg-surface px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-[46ch] text-[13px] text-muted">{body}</p>
      {action}
    </div>
  )
}

/**
 * VERITABANI DUSTUGUNDE SAYFANIN GERI KALANI CALISIR, ve metin bunu SOYLER.
 *
 * `boundary.ts` bugun her okumaya `unavailable` donuyor -- yani bu, ileride
 * belki gorulecek bir dal degil, su anda CANLI olan yol. Kullaniciya "burasi
 * dustu, digerleri ayakta" demek, sayfanin geri kalanina guvenip guvenmemesi
 * gereken tek bilgidir; genel bir "bir seyler ters gitti" bunu saklar.
 */
export function UnavailableNotice({ what }: { what: string }) {
  return (
    <TableNotice
      title={`${what} is unavailable right now.`}
      body="The database that serves history is not answering. Prices, reserves and trading on this page read the chain directly and are unaffected."
    />
  )
}

// --------------------------------------------------------------------------
// Keyset sayfalama
// --------------------------------------------------------------------------

/** Bir imlecten SONRAKI sayfayi getirir. Task 7 indiginde bu bir server action olur. */
export type LoadMore<T> = (cursor: string) => Promise<ReadResult<Page<T>>>

export type KeysetRows<T> = {
  readonly rows: readonly T[]
  readonly canLoadMore: boolean
  readonly pending: boolean
  readonly failed: boolean
  readonly onLoadMore: () => void
}

/**
 * KEYSET SAYFALAMA, EKLEYEREK. Offset YOK ve olmamali: `eventSeq DESC` uzerinde
 * bir OFFSET, aradan yeni bir islem girdiginde okunmus bir satiri ikinci
 * sayfada TEKRAR gosterir. Imlec son satiri isaret ettigi icin araya giren
 * satir listeyi kaydirmaz.
 *
 * `loadMore` verilmezse dugme HIC cizilmez: tiklandiginda hicbir sey yapmayan
 * bir "Load more", olmayan bir dugmeden kotudur.
 *
 * Yeni bir `rows` referansi geldiginde (sunucu sayfayi tazeledi) biriken
 * sayfalar ATILIR -- eskimis bir kuyrugu taze bir basa eklemek, kullaniciya
 * iki farkli ana ait tek bir liste gostermek olurdu.
 */
export function useKeysetRows<T>(
  rows: readonly T[],
  nextCursor: string | null,
  loadMore: LoadMore<T> | undefined,
): KeysetRows<T> {
  const [state, setState] = useState(() => ({
    base: rows,
    rows,
    cursor: nextCursor,
    pending: false,
    failed: false,
  }))

  if (state.base !== rows) {
    setState({ base: rows, rows, cursor: nextCursor, pending: false, failed: false })
  }

  const cursor = state.base === rows ? state.cursor : nextCursor
  const shown = state.base === rows ? state.rows : rows

  const onLoadMore = useCallback(() => {
    if (!loadMore || cursor === null) return
    setState((s) => (s.pending ? s : { ...s, pending: true, failed: false }))
    void loadMore(cursor).then(
      (result) => {
        setState((s) =>
          result.ok
            ? {
                ...s,
                rows: [...s.rows, ...result.data.rows],
                cursor: result.data.nextCursor,
                pending: false,
                failed: false,
              }
            : { ...s, pending: false, failed: true },
        )
      },
      // Bir reddedilen promise'i yutmak DEGIL, gorunur kilmak: satirlar
      // yerinde kalir ve dugmenin altinda tek satirlik bir uyari cikar.
      () => setState((s) => ({ ...s, pending: false, failed: true })),
    )
  }, [loadMore, cursor])

  return {
    rows: shown,
    canLoadMore: loadMore !== undefined && cursor !== null,
    pending: state.pending,
    failed: state.failed,
    onLoadMore,
  }
}

export function LoadMoreFooter({
  state,
  label,
}: {
  state: Pick<KeysetRows<unknown>, 'canLoadMore' | 'pending' | 'failed' | 'onLoadMore'>
  label: string
}) {
  if (!state.canLoadMore) return null
  return (
    <div className="flex flex-col items-center gap-2 border-t border-border px-3 py-3">
      <Button variant="secondary" size="sm" onClick={state.onLoadMore} disabled={state.pending}>
        {state.pending ? 'Loading…' : label}
      </Button>
      {/*
        Canli bolge HER ZAMAN agacta durur, yalnizca icerigi degisir. Hata
        aninda DOM'a yeni bir `role="status"` eklemek, bircok ekran
        okuyucuda hic duyurulmayan bir bolge uretir.
      */}
      <p role="status" className="text-[12px] text-negative empty:hidden">
        {state.failed ? 'Could not load more rows — the rows above are still current.' : ''}
      </p>
    </div>
  )
}
