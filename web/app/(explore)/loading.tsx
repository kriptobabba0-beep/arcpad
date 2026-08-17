import { TokenGridSkeleton } from '@/components/explore/TokenGrid'
import { Skeleton } from '@/components/ui/Skeleton'

/**
 * IZGARAYLA AYNI GEOMETRI.
 *
 * Tek satirlik bir "Loading…" ya da farkli oranli bir iskelet, icerik
 * geldiginde sayfayi ZIPLATIR -- ve iskeletin var olma sebebi tam olarak o
 * ziplamayi onlemek. `TokenGridSkeleton` izgara siniflarini `TokenGrid` ile
 * PAYLASIR (`GRID_CLASS`), yani ikisi ayrisamaz.
 */
/*
 * ============================================================================
 *  ISKELETIN DE BIR `<h1>`I VAR -- VE YOKLUGU GERCEK BIR KUSURDU
 * ============================================================================
 *
 * OLCULDU (CI, 2026-08-18): axe `explore @1440px` icin `page-has-heading-one`
 * (moderate) bildirdi. Sebep bu dosyaydi: gercek sayfanin `<h1>`i
 * `ExploreHero`da ("Launch a token on Arc") ve iskelet onu TASIMIYORDU. Yani
 * yuklenme aninda gelen bir ekran okuyucu kullanicisi, ust duzey basligi
 * OLMAYAN bir sayfa buluyordu -- ve iskeletin gorunur oldugu sure kisa degil:
 * bu sayfa Suspense arkasinda AKISLA gelir.
 *
 * NEDEN AYLARCA GORUNMEDI: `a11y.spec.ts` `goto`dan sonra HICBIR SEY beklemeden
 * tarar, yani neyi taradigi akis zamanlamasina baglidir. Ayni commit 375px'te
 * gecti, 768px'te bir baska ihlal verdi, 1440px'te bunu verdi. Testin
 * belirsizligi de ayrica duzeltildi (bkz. `a11y.spec.ts`), ama ONCE urun:
 * iskelet KENDI BASINA gecerli olmali, cunku kullanici onu gercekten goruyor.
 *
 * `sr-only` DEGIL, GORUNUR bir baslik: gercek sayfada da gorunur bir `<h1>` var
 * ve iskeletin isi ayni geometriyi tutmaktir. Metin AYNIDIR -- iki yerde iki
 * farkli baslik, gecis aninda duyulan seyi degistirirdi.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h1 className="font-serif text-[40px] leading-[1.05]">Launch a token on Arc</h1>
        <Skeleton className="h-16 w-full" />
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-10 w-80" />
        </div>
        <TokenGridSkeleton />
      </section>
    </div>
  )
}
