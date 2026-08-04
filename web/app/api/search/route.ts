import { verifyCanonical } from '@/lib/canonical'
import { readSearch, readTokenOverview, valueOf } from '@/lib/read'
import type { HexAddress } from '@/components/read/types'
import { toWire } from '@/components/read/wire'
import {
  asAddressQuery,
  parseSearchParams,
  SEARCH_LIMIT,
  type SearchPayload,
} from '@/components/search/params'

/**
 * =========================================================================
 *  §6.3'E GEREKCELI ISTISNA: BU BIR OKUMA ROTASIDIR.
 * =========================================================================
 *
 * Spec §6.3 "API route'lari yalnizca yazma icin" der ve kural dogrudur:
 * okuma yolunun tamami server component'lerden gecer, boylece veri getirme
 * ile render ayni turda olur ve istemci paketine bir veri katmani sizmaz.
 *
 * ⌘K bu kuralin disinda kalir, ve sebebi olculebilir bir sey: sonuclar TUS
 * VURUSUYLA gelir. Modal bir istemci bilesenidir, acik/kapali durumu URL'de
 * degildir ve her harfte bir server component navigasyonu yapmak (a) adres
 * cubugunu ve tarayici gecmisini her harfte kirletir, (b) iptal edilebilir
 * degildir -- oysa bu gorevin en somut hatasi tam olarak "gec donen yanit
 * yenisini eziyor".
 *
 * Alternatif bir SERVER ACTION'dir ve ayni ag turunu POST olarak yapar:
 * onbelleklenemez, `<link rel=prefetch>` alamaz, ve tarayicinin istek iptali
 * disinda hicbir sey kazandirmaz.
 *
 * YAZMA YOK: bu dosyada `POST` YOKTUR ve olmayacaktir. Istisna okuma yonunde
 * acildi; ters yone acilmasi §6.3'u anlamsiz kilardi.
 */

/**
 * Her istek tazedir. `q` her tus vurusunda degisir, yani rota zaten dinamik
 * kosar; bunu ACIKCA yazmak, ilerideki bir Next varsayilaninin arama
 * sonuclarini sessizce statiklestirmesini engeller.
 */
export const dynamic = 'force-dynamic'

/**
 * `verifyCanonical` bir `eth_call`, `readSearch` bir Postgres sorgusudur.
 * Ikisi de edge runtime'da kosmaz.
 */
export const runtime = 'nodejs'

const EMPTY = { rows: [], nextCursor: null, shown: 0 } as const

/**
 * ADRES YAPISTIRMA YOLU -- KANONIKLIGIN GORUNDUGU YER.
 *
 * Sira baglayicidir:
 *   1. Veritabaninda satir varsa dogrudan o sonuc. Kanoniklik SORULMAZ:
 *      `Launched` yalnizca `LaunchFactory` tarafindan yayilabilir, indexer
 *      yalnizca o adresin loglarini okur, ve Faz 3 kabulde ayrica dogrular.
 *   2. Satir yoksa zincire sorulur.
 *
 * Veritabani DUSTUGUNDE de 2. adima gidilir, ve bu bilincli: `verifyCanonical`
 * bir eth_call'dir, veritabanina hic ihtiyaci yoktur. Dusen bir veritabani
 * yuzunden kanoniklik hukmunu vermemek, yapistirilan bir adres hakkinda
 * soyleyebilecegimiz TEK guvenlik ifadesini dususle birlikte kaybetmek olurdu.
 *
 * `forged` ve `unverifiable` AYNI dala gider (bkz. `read/types.ts`): ikisi de
 * "bunu bir launch gibi cizme" demektir ve aralarindaki fark (false donen bir
 * cagri mi, gazi tukenen bir cagri mi) kullanicinin alacagi karari
 * degistirmez.
 */
async function resolvePastedAddress(address: HexAddress): Promise<SearchPayload> {
  const overview = await readTokenOverview(address)
  const overviewRow = valueOf(overview)
  if (overviewRow !== undefined) {
    return {
      rows: [toWire(overviewRow)],
      nextCursor: null,
      shown: 1,
      pasted: { kind: 'indexed', address },
    }
  }

  const canonicity = await verifyCanonical(address)
  if (canonicity === 'canonical') {
    return { ...EMPTY, pasted: { kind: 'notIndexed', address } }
  }

  /*
   * ISIM/SEMBOL BURADA OKUNMAZ, ve okunacak bir yer de birakilmadi.
   *
   * Sahte bir token `name()`/`symbol()`/`uri()` cagrilarindan gercek bir
   * launch'in degerlerini dondurebilir -- Faz 1c bunu olctu: bir sahteci
   * creator'i, curve'u, metadata'yi, salt'i ve gerceklesen islem fiyatini
   * birebir taklit edebilir. Ekrana o adi yazmak, sahtekarligin isini bizim
   * yapmamiz demektir. Bu yuzden yanitin bu dali YALNIZCA adresi tasir:
   * istemci hatali olsa bile cizecek bir isim bulamaz.
   */
  return { ...EMPTY, pasted: { kind: 'refused', address, canonicity } }
}

export async function GET(request: Request): Promise<Response> {
  const query = parseSearchParams(new URL(request.url).searchParams)

  const address = asAddressQuery(query.q)
  if (address !== null) {
    // ADRESSE METIN ARAMASI YAPILMAZ. Bir adres icin isim/sembol taramasi
    // (a) hicbir sey bulmazdi, (b) daha kotusu, adresi ADINDA gecen bir
    // taklidi bulabilirdi.
    return Response.json(await resolvePastedAddress(address))
  }

  const result = await readSearch({
    // `q` BIR PARAMETREDIR. Dizeye dokunulmaz: kacislanmaz, `%` ile
    // sarilmaz, tirnaklanmaz. Desen kurmak sorguyu YAZAN katmanin isi.
    q: query.q,
    sort: query.sort,
    ageDays: query.ageDays,
    cursor: query.cursor,
    limit: SEARCH_LIMIT,
  })

  if (!result.ok) {
    /*
     * `notFound` BIR HATA DEGILDIR: bir arama icin "hicbir sey bulunamadi"
     * bos bir sayfadir, dusmus bir veritabani degil. Ikisini ayni yanita
     * katlamak, kullaniciya "arama calismiyor" derdi -- oysa arama calisti.
     */
    if (result.reason === 'notFound') return Response.json({ ...EMPTY, pasted: null })

    // 503, 200 degil: bir ara katman ya da bir izleme, govdeyi okumadan da
    // bunun bir dusus oldugunu gorebilmeli. Istemci yine de govdeye bakar.
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }

  const page = valueOf(result)
  if (page === undefined) return Response.json({ error: 'unavailable' }, { status: 503 })
  return Response.json({
    rows: page.rows.map(toWire),
    nextCursor: page.nextCursor,
    shown: page.rows.length,
    pasted: null,
  })
}
