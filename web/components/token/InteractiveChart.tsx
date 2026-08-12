'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CandleRow } from '@/lib/read'
import { CandleChart, type ChartMetric } from './CandleChart'

/**
 * ============================================================================
 *  TEKERLEKLE YAKINLASTIR, SURUKLEYEREK KAYDIR
 * ============================================================================
 *
 * Grafigin KENDISI hala sunucuda cizilir (`CandleChart`, saf bir `<svg>`);
 * bu bilesen yalnizca GORUNEN PENCEREYI tutar ve o pencereyi kaydirir.
 * Ayrim bilincli ve bu depoda daha once odendi:
 *
 *   - Cizim sunucuda kalinca grafik ILK BOYAMADA dolu gelir. Bir fiyat
 *     grafiginin once bos cizilip sonra dolmasi, "veri yok" ile "henuz
 *     yuklenmedi"yi ayirt edilemez kilar.
 *   - Olcekleme `bigint` uzerinde kalir. Bir memecoin'in market cap'i 4e18 ile
 *     5e24 arasinda gezer ve `number`a cevrilmis bir olcek kucuk degerlerde
 *     mumlari ust uste bindirir.
 *
 * Yani burada tutulan sey bir GORUNTU DEGIL bir DILIM: `[start, end)`. Mumlar
 * ayni mumlar, yalnizca kacinin cizildigi degisiyor.
 *
 * ============ NEDEN `wheel` ICIN `useEffect` + `passive: false` ============
 *
 * React'in `onWheel`i PASIF bir dinleyici baglar ve pasif bir dinleyicide
 * `preventDefault()` CALISMAZ -- tarayici uyari basar ve sayfa grafigin
 * uzerinde kaydirilmaya devam eder. Yani "grafikte yakinlastirayim" derken
 * sayfa asagi kayar. Dinleyici bu yuzden elle, `{ passive: false }` ile
 * baglanir.
 */
export function InteractiveChart({
  candles,
  metric,
  currentWei,
  bucketSeconds,
}: {
  candles: readonly CandleRow[]
  metric: ChartMetric
  currentWei: bigint
  bucketSeconds: number
}) {
  const total = candles.length
  /** En az bu kadar mum gorunur -- daha azi bir grafik degil bir cubuk olur. */
  const MIN_SPAN = 8

  const [span, setSpan] = useState(total)
  const [end, setEnd] = useState(total)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; end: number } | null>(null)

  /*
   * VERI DEGISINCE PENCERE SONA YAPISIR.
   *
   * `LiveRefresh` sunucu bilesenlerini on saniyede bir yeniden calistiriyor,
   * yani yeni bir mum geldiginde bu bilesen yeni bir `candles` alir. Pencere
   * sonda duruyorsa sonda KALMALI (yeni mum gorunsun), ortada duruyorsa
   * kullanicinin baktigi yeri kaybetmemeli.
   */
  const previousTotal = useRef(total)
  useEffect(() => {
    const wasAtEnd = end >= previousTotal.current
    if (total !== previousTotal.current) {
      setSpan((s) => Math.min(s === previousTotal.current ? total : s, total))
      setEnd(wasAtEnd ? total : Math.min(end, total))
      previousTotal.current = total
    }
  }, [total, end])

  const clampWindow = useCallback(
    (nextSpan: number, nextEnd: number): { span: number; end: number } => {
      const s = Math.max(Math.min(MIN_SPAN, total), Math.min(nextSpan, total))
      const e = Math.max(s, Math.min(nextEnd, total))
      return { span: s, end: e }
    },
    [total],
  )

  useEffect(() => {
    const node = boxRef.current
    if (node === null) return

    const onWheel = (event: WheelEvent): void => {
      // Sayfa kaydirmasini DEVRALIR. Bkz. dosya basi: React'in `onWheel`i
      // pasiftir ve bunu yapamaz.
      event.preventDefault()
      /*
       * IMLECIN ALTINDAKI MUM SABIT KALIR -- TradingView'in davranisi.
       * Yalnizca sona gore yakinlastirmak, kullanicinin baktigi yeri ekrandan
       * kaydirir ve yakinlastirma bir arama isine donusur.
       */
      const rect = node.getBoundingClientRect()
      const ratio = rect.width === 0 ? 1 : (event.clientX - rect.left) / rect.width
      setSpan((currentSpan) => {
        const factor = event.deltaY > 0 ? 1.25 : 0.8
        const nextSpan = Math.round(currentSpan * factor)
        setEnd((currentEnd) => {
          const anchor = currentEnd - currentSpan * (1 - ratio)
          const next = clampWindow(nextSpan, Math.round(anchor + nextSpan * (1 - ratio)))
          return next.end
        })
        return clampWindow(nextSpan, end).span
      })
    }

    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [clampWindow, end])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = { x: event.clientX, end }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    if (start === null) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    // Bir piksel kac mum: pencere daraldikca surukleme HASSASLASIR, ki
    // yakinlastirilmis bir grafikte tek bir mumu hedeflemek mumkun olsun.
    const perPixel = span / rect.width
    const moved = (start.x - event.clientX) * perPixel
    setEnd(clampWindow(span, Math.round(start.end + moved)).end)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const visible = candles.slice(Math.max(0, end - span), end)
  const zoomed = span < total || end < total

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // `touch-action: none` -- dokunmatikte surukleme sayfayi degil grafigi
        // hareket ettirsin. Olmadan mobilde surukleme HIC calismaz.
        className="cursor-grab touch-none select-none active:cursor-grabbing"
        data-testid="interactive-chart"
      >
        <CandleChart
          candles={visible}
          metric={metric}
          currentWei={currentWei}
          bucketSeconds={bucketSeconds}
        />
      </div>

      {/*
        YAKINLASTIRMA GORUNUR VE GERI ALINABILIR OLMALI.
        Bir kullanici grafigi kaydirip kayboldugunda, cikis yolunun ekranda
        olmasi gerekir -- "hepsini goster" olmayan bir yakinlastirma, kullaniciyi
        sayfayi yenilemeye zorlar.
      */}
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          {zoomed ? `${visible.length} of ${total} candles` : 'Scroll to zoom, drag to pan'}
        </span>
        {zoomed ? (
          <button
            type="button"
            onClick={() => {
              setSpan(total)
              setEnd(total)
            }}
            className="rounded-pill border border-border px-2 py-0.5 transition-colors hover:border-white/25 hover:text-text"
            data-testid="chart-reset"
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  )
}
