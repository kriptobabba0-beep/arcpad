import type { Metadata } from 'next'
import { pinningIsConfigured } from '@/app/api/metadata/pinning'
import { launchFactsFrom, type LaunchFacts } from '@/components/create/facts'
import { LaunchForm } from '@/components/create/LaunchForm'
import { getCurveProfile } from '@/lib/profile'

export const metadata: Metadata = {
  // Marka adi BURADA YAZILMAZ: `layout.tsx`in `template`i onu `BRAND`ten
  // ekler. Iki yerde yazmak, marka degistiginde birini unutmak demektir.
  title: 'Launch a token',
  description: 'Name it, give it a symbol, and put it on the curve. Creating a launch is free.',
}

/**
 * =========================================================================
 *  BU SAYFA `notFound()` DA `redirect()` DE CAGIRMAZ, ve bu bilincli.
 * =========================================================================
 *
 * Bu fazda olculdu: bir ust `loading.tsx` bir Suspense siniri acar, yanit
 * AKARAK gider ve HTTP durumu, `notFound()` ya da bir yonlendirme firlatildigi
 * anda coktan gonderilmis olur. `/token/<cop>` DOGRU bulunamadi sayfasini
 * HTTP 200 ile cizdi ve butun birim testleri yesildi -- cunku SAYFA dogruydu,
 * yalnizca DURUM yanlisti.
 *
 * `/create`in ne bir dinamik segmenti ne de bir yonlendirme dali var:
 * launch'tan sonraki gecis ISTEMCIDE, `<LaunchResult>`teki bir baglantiyla
 * olur -- sunucu tarafi bir `redirect()` ile degil. Yine de kesin olan tek sey
 * OLCULEN seydir: derlenmis sunucuda `curl -o /dev/null -w "%{http_code}"`
 * ile `/create` -> 200 ve `/create/<herhangi>` -> 404 olculdu.
 *
 * `force-dynamic`: profil ucusu (T, V, S) factory'den okunur. Statik
 * uretilseydi, build aninda DUSEN bir RPC okumasi "sayilar yok" hâlini
 * deployment'in omru boyunca dondurup saklardi. Uclu `immutable`dir ama okuma
 * degildir.
 */
export const dynamic = 'force-dynamic'

export default async function CreatePage() {
  /*
   * PROFILI OKUYAMAMAK BIR HATA EKRANI DEGILDIR.
   *
   * `launch(name, symbol, uri)` uc dizeden ibarettir ve profile HICBIR
   * ihtiyaci yoktur: okuma dustugunde form sonuna kadar calisir, yalnizca
   * onizleme kartinin dort satiri "—" gosterir. Sayfayi 500'e dusurmek,
   * calisabilecek bir islemi bir gosterim degeri yuzunden engellemek olurdu.
   *
   * Uydurulmus bir yedek profil de KONMAZ: testnet ile uretim yalnizca `V`de
   * ve tam 1000 kat ayrisir, yani yanlis bir yedek her sayiyi 1000 kat kaydirir
   * ve dogru gorunur.
   */
  let facts: LaunchFacts | null = null
  try {
    const { profile, graduationTarget } = await getCurveProfile()
    facts = launchFactsFrom(profile, graduationTarget)
  } catch (error) {
    console.error('curve profile unavailable; /create draws without the preview numbers', error)
  }

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-3xl leading-none">Launch a token</h1>
        <p className="max-w-[62ch] text-sm leading-relaxed text-muted">
          Creating a launch is free — you pay gas and nothing else. Every launch gets the same fixed
          supply and the same curve.
        </p>
      </header>

      {/*
        Pinning yapilandirmasi SUNUCUDA okunur ve istemciye yalnizca bir
        BOOLEAN gecer. `ARCPAD_PIN_TOKEN` istemciye hic ulasmaz; ulassaydi
        herkes bizim hesabimiza dosya pinleyebilirdi.
      */}
      <LaunchForm facts={facts} pinningConfigured={pinningIsConfigured()} />
    </div>
  )
}
