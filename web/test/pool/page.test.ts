import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ==========================================================================
 *  THE COMPOSED PAGE, NOT THE COMPONENTS. THIS IS THE GATE THAT KEEPS FAILING.
 * ==========================================================================
 *
 * A COMPONENT THAT NOTHING RENDERS IS NOT A FEATURE, and this package has
 * shipped that exact shape six times with every component test green:
 * `TradePanel` written and drawn by no page, `CurveChart`'s realised layer, the
 * two missing `loadMore*` props, the `graduated` field the page did not pass,
 * two switch controls on one composed screen, and the same false sentence
 * living in two components -- the last two inside two days.
 *
 * So the assertions here are about the PAGE: how many call sites there are,
 * what each one passes, and -- the half that keeps being missed -- that the two
 * branches agree. The token page has TWO branches (the indexer row and the
 * chain-drawn fallback), and the chain-drawn one is what a user sees when the
 * indexer is DOWN, which is exactly when they most need trading to work.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')
const RAW = readFileSync(join(WEB, 'app', 'token', '[address]', 'page.tsx'), 'utf8')

/**
 * COMMENTS ARE STRIPPED, AND THAT IS NOT TIDINESS.
 *
 * MEASURED while writing this file: the page's own comment explains that
 * `TradeSurface` replaced a direct `<TradePanel>`, and the naive matcher counted
 * that sentence as a call site -- so "the page renders TradePanel never" failed
 * against a page that renders it never. A gate that reads prose as code reports
 * the opposite of the truth in whichever direction the prose happens to point.
 */
const PAGE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function uses(tag: string): string[] {
  return [...PAGE.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?/>`, 'g'))].map((m) => m[0])
}

describe('the venue choice is made in ONE component, rendered by BOTH branches', () => {
  it('the page renders TradeSurface twice and TradePanel never', () => {
    /*
     * BEFORE THIS, a graduated token had NO trading surface at all: the curve
     * panel correctly renders nothing once the curve is complete, and no page
     * drew a pool panel. The first token to graduate would have had a live
     * Uniswap v4 pool that no wallet on earth could reach -- v4 gives an EOA no
     * swap entrypoint and Arc has no Universal Router.
     */
    expect(uses('TradeSurface')).toHaveLength(2)
    expect(uses('TradePanel')).toHaveLength(0)
    expect(uses('PoolTradePanel')).toHaveLength(0)
  })

  it('both call sites pass the lifecycle and the token', () => {
    for (const use of uses('TradeSurface')) {
      expect(use, `a TradeSurface without a lifecycle: ${use}`).toMatch(/lifecycle=\{/)
      expect(use, `a TradeSurface without a token: ${use}`).toMatch(/token=\{/)
      expect(use, `a TradeSurface without a symbol: ${use}`).toMatch(/symbol=\{/)
    }
  })

  it('the panel is no longer hidden when the CURVE profile read fails', () => {
    // `profile === null ? null : <TradePanel/>` cost a graduated token its only
    // trading surface for a read it does not use.
    expect(PAGE).not.toMatch(/profile === null \? null : \(?\s*<Trade/)
  })
})

describe('the chart: two branches, and the difference is DECLARED', () => {
  /*
   * ============ BURADA IKI DAL BILEREK AYRISIR ============
   *
   * Bu blok once "iki dal AYNI grafigi cizer" diyordu ve o kural, bir dalda
   * duzeltilip otekinde unutulan degisikliklere karsi yazilmisti. Kural hala
   * gecerli -- ama grafik degistiginde bu testin sordugu soru da degisti.
   *
   * Indexlenmis dal MUM cizer, cunku mumlar ISLEM GECMISINDEN gelir.
   * Zincirden cizilen dal, TANIMI GEREGI, o gecmise sahip degildir: indexer
   * dustugu icin oradadir. Ona bos bir mum grafigi cizdirmek, "hic islem
   * olmamis" demek olurdu -- oysa dogru cumle "islemleri okuyamiyoruz"dur, ve
   * bu dal zaten bunu bir uyari kutusunda soyluyor. Bu yuzden orada bagli
   * egri (`TokenPriceChart`) cizilir: o, PROFILDEN turer ve gecmis istemez.
   *
   * Yani ayrisma bir kayma degil bir KARAR, ve bu test onu KARAR olarak
   * tutuyor: her iki dal da grafigini cizmek ZORUNDA, ve hangisinin hangisi
   * oldugu burada YAZILI. Biri silinirse test duser.
   */
  it('indexlenmis dal MUM, zincir dali EGRI cizer -- ve ikisi de cizer', () => {
    expect(uses('CandleChart'), 'the indexed branch lost its candles').toHaveLength(1)
    expect(uses('TokenPriceChart'), 'the chain-drawn branch lost its curve').toHaveLength(1)
    // Eski bilesenler geri gelmemeli: ikisi de ayni isi iki farkli bicimde
    // yapardi ve hangisinin cizildigi sayfaya gore degisirdi.
    expect(uses('CurveChart')).toHaveLength(0)
    expect(uses('PriceHistoryChart')).toHaveLength(0)
  })

  it('mum grafigi SU ANKI degeri alir -- yoksa kesikli cizgi grafigin disinda kalir', () => {
    /*
     * `currentWei` gecilmezse kesikli cizgi ve sagdaki etiket cizilemez;
     * kullanici fiyati GRAFIKTE GORMEDEN islem yapar. Bileşen o degeri olcege
     * de katiyor, yani eksik gecilmesi yalnizca bir suslemeyi degil, olcegin
     * dogrulugunu da bozardi.
     */
    for (const use of uses('CandleChart')) {
      expect(use, `a CandleChart without currentWei: ${use}`).toMatch(/currentWei=\{/)
      expect(use, `a CandleChart without a metric: ${use}`).toMatch(/metric=\{/)
    }
  })

  it('egri grafigi hala yasam dongusunu alir -- onsuz mekani secemez', () => {
    for (const use of uses('TokenPriceChart')) {
      expect(use, `a TokenPriceChart without a lifecycle: ${use}`).toMatch(/lifecycle=\{/)
    }
  })

  it('MEKAN BIR PROP DEGIL -- satirin uzerinde geliyor', () => {
    /*
     * Bir sure mekan `graduatedSeq` prop'uyla tasindi ve iki hop'tan birinde
     * unutulabiliyordu. `listTrades` artik `source` seciyor: her satir kendi
     * mekanini soyluyor, yani hicbir cagri yeri onu unutamaz.
     */
    expect(
      PAGE,
      'the venue is back to being a prop -- see components/token/venue.ts for why it is not',
    ).not.toMatch(/graduatedSeq=\{/)
  })
})

describe('islem ve holder tablolari', () => {
  const use = (): string =>
    PAGE.slice(PAGE.indexOf('<ActivityTabs'), PAGE.indexOf('/>', PAGE.indexOf('<ActivityTabs')))

  it('sayfa satirlari VE TOPLAMLARI verir -- toplam olmadan numarali sayfa uydurulur', () => {
    /*
     * `NumberedPager` toplam olmadan HIC cizilmez: numara listesi toplamdan
     * turer ve uydurulmus bir "3 sayfa" kullaniciyi olmayan bir sayfaya
     * goturur. Sayfa bu yuzden dort seyi birden gecmek zorunda.
     */
    expect(use()).toMatch(/trades=\{/)
    expect(use()).toMatch(/holders=\{/)
    expect(use()).toMatch(/tradeCount=\{/)
    expect(use()).toMatch(/holderCount=\{/)
    expect(use()).toMatch(/page=\{/)
    expect(use()).toMatch(/pageSize=\{/)
  })

  it('curve, creator ve sembol GECER -- likidite satiri ve rozetler bunlara bagli', () => {
    /*
     * Holder tablosu curve'un KENDISINI de listeler ("Liquidity" rozetiyle):
     * curve'de duran arz gercekten oradadir ve gizlemek, ilk on cuzdanin
     * payini oldugundan buyuk gosterirdi. Rozet ancak curve adresi bilinirse
     * cizilebilir -- creator rozeti de oyle.
     */
    for (const field of ['curve=', 'creator=', 'symbol=']) {
      expect(use(), `ActivityTabs lost ${field}`).toContain(field)
    }
  })

  it('ESKI TABLO GERI GELMEDI', () => {
    // `TableTabs` istemci tarafli ve "daha fazla yukle" ile calisiyordu;
    // numarali sayfa sunucu tarafli. Ikisinin ayni sayfada bulunmasi, iki
    // farkli sayfalama garantisinin ayni ekranda karismasi demek olurdu.
    expect(uses('TableTabs')).toHaveLength(0)
  })
})

describe('ANTI-VACUITY: the scan really reads this page', () => {
  it('the matcher finds components that are certainly there', () => {
    // If `uses()` were broken every assertion above would pass by finding
    // nothing, which is the shape of a gate that measures itself.
    expect(uses('TokenStatStrip').length).toBeGreaterThanOrEqual(2)
    expect(uses('TokenIdentity').length).toBeGreaterThanOrEqual(2)
    expect(uses('LifecycleNotice').length).toBe(2)
    expect(PAGE).toContain('resolveLifecycle')
  })

  it('the page still resolves a lifecycle on BOTH branches', () => {
    expect([...PAGE.matchAll(/resolveLifecycle\(/g)]).toHaveLength(2)
    // And `graduated` is passed at both -- the field whose absence made the
    // whole graduated branch unreachable once already.
    expect([...PAGE.matchAll(/graduated:/g)].length).toBeGreaterThanOrEqual(2)
  })
})
