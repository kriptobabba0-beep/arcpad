'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * SAYFAYI KULLANICI YENILEMEDEN GUNCEL TUTAR.
 *
 * ============ NEDEN AYRI BIR API DEGIL, `router.refresh()` ============
 *
 * Bir "canli veri" ucu yazmak, sunucudaki her seyi ISTEMCIDE IKINCI KEZ
 * kurmak demektir: ayni sorgu, ayni siralama, ayni bayatlik hesabi, ayni
 * `fold` uc dali, ayni bicimlendirme. Iki uygulama olur ve ikisi sessizce
 * ayrisir -- bu depo o hatayi zaten bir kez odedi (gateway'in dort kopyasi,
 * `lib/ipfs.ts`'in basligi).
 *
 * `router.refresh()` SUNUCU BILEŞENLERINI yeniden calistirir ve React sonucu
 * mevcut agaca YAMAR. Yani:
 *   - sorgu, siralama ve bayatlik mantigi TEK yerde kalir (sayfanin kendisi);
 *   - istemci durumu KORUNUR -- acik bir bilgi balonu kapanmaz, seridin
 *     kaydirma konumu sifirlanmaz, arama modali kapanmaz;
 *   - degisen sayilar `LiveNumber`a YENI PROP olarak gelir ve animasyon
 *     kendiliginden calisir;
 *   - yeni bir launch geldiginde "New" sekmesinde basa gecmesi, listeyi
 *     zaten sunucunun siraladigi icin bedava olur.
 *
 * ============ GORUNMEYEN SEKME SORGULANMAZ ============
 *
 * `document.hidden` iken zamanlayici durur. Arka planda acik duran on sekme,
 * on saniyede bir on veritabani sorgusu demektir ve hicbiri ekranda degildir.
 * Sekme geri gorunur oldugunda ONCE bir kez hemen yenilenir: kullanicinin ilk
 * gordugu sey, bekleme suresi kadar eski bir liste olmamali.
 */
export function LiveRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter()

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }

    const start = (): void => {
      stop()
      timer = setInterval(() => router.refresh(), intervalMs)
    }

    const onVisibility = (): void => {
      if (document.hidden) {
        stop()
        return
      }
      router.refresh()
      start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [router, intervalMs])

  // Hicbir sey cizmez. Gorunur bir "canli" rozeti, sayfanin GUNCEL oldugunu
  // iddia eder; oysa bu bileşen yalnizca yenilemeyi TETIKLER ve verinin ne
  // kadar taze oldugunu soyleyen sey `<StaleNotice>`tir -- o da olculmus
  // gercegi soyler, bir zamanlayicinin varligini degil.
  return null
}
