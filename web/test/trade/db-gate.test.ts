import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * PANEL VERITABANINA DOKUNMAZ -- KAYNAK METNI IDDIASI.
 *
 * Task 1'in `chain-registry` kapisiyla ayni sekil, ve ayni sebeple: bir
 * bagimliligin YOKLUGUNU davranisla olcmek zordur -- kod yolu calisan bir
 * testte hic yurunmemis olabilir. Kaynagi taramak, o yolun VAR OLMADIGINI
 * olcer.
 *
 * Neden onemli: indexer dustugunde kullanici listeleri ve gecmisi kaybeder,
 * ISLEM YAPMA YETENEGINI DEGIL. `web/lib/db.ts`'in kendi yorumu da bunu
 * soyluyor ("the trade panel ... reads reserves from the CHAIN"), ama bir
 * yorum bir kapi degildir.
 *
 * Ikinci ve daha sert sonuc: `@arcpad/db` `pg`'yi tasir ve `web/lib/read.ts`
 * `server-only`'dir. Bir istemci bileşeninden ikisine de ulasmak `next build`'i
 * bir `node:` builtin'i cozemedigi icin kirar -- yani bu kapi ayni zamanda
 * derlemenin kapisi.
 */

const PANEL_FILES = [
  'components/token/TradePanel.tsx',
  'components/token/useCurveState.ts',
  'components/token/useTrade.ts',
  'components/token/useApproval.ts',
  'components/token/useGasReserve.ts',
  'components/token/tradeModel.ts',
  'components/token/gas.ts',
  'components/token/QuoteBreakdown.tsx',
  'components/token/AmountInput.tsx',
  'components/token/MaxButton.tsx',
  'components/token/SlippageControl.tsx',
  'components/token/ApproveStep.tsx',
] as const

const WEB_ROOT = join(import.meta.dirname, '..', '..')

/**
 * `import ... from '<what>'` VE yan etkili `import '<what>'` -- ikincisi
 * bilerek: `web/lib/read.ts`'in `server-only`'si tam olarak o sekildedir ve
 * yalnizca `from`'a bakan bir dedektor onu GORMEZ, yani "server-only yok"
 * iddiasi hicbir zaman kirilmazdi.
 *
 * Yorumlarda gecen ada takilmaz.
 */
function importsFrom(source: string, what: string): boolean {
  const quoted = what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tail = `['"]${quoted}(?:/[^'"]*)?['"]`
  return (
    new RegExp(`from\\s+${tail}`).test(source) || new RegExp(`^import\\s+${tail}`, 'm').test(source)
  )
}

const read = (relative: string): string => readFileSync(join(WEB_ROOT, relative), 'utf8')

describe('the trade panel is database-independent, in source', () => {
  it.each(PANEL_FILES)('%s does not import the database layer', (relative) => {
    const source = read(relative)
    expect(importsFrom(source, '@arcpad/db')).toBe(false)
    expect(importsFrom(source, '@/lib/db')).toBe(false)
    expect(importsFrom(source, '@/lib/read')).toBe(false)
    expect(importsFrom(source, 'server-only')).toBe(false)
  })

  it('has a control: the detector DOES fire on files that legitimately import it', () => {
    // Kontrolsuz bir "yok" iddiasi, dedektorun bozuk olma ihtimalini kapatmaz.
    expect(importsFrom(read('lib/db.ts'), '@arcpad/db')).toBe(true)
    expect(importsFrom(read('lib/read.ts'), '@arcpad/db')).toBe(true)
    // Yan etkili bicimin kontrolu sentetik: `web/lib/read.ts` bugun
    // `server-only`'yi GERCEKTEN import etmiyor (paket kurulu degil, ve kendi
    // yorumu bunu yaziyor). Kuruldugu gun bu dedektorun onu gormesi gerekiyor.
    expect(importsFrom("import 'server-only'\n", 'server-only')).toBe(true)
    expect(importsFrom('// a comment mentioning server-only\n', 'server-only')).toBe(false)
  })

  it('does not count a mention inside a comment as an import', () => {
    // `TradePanel.tsx` yorumlarinda `@arcpad/db`'den ACIKCA soz ediyor ("bu
    // dosya onu import etmez"). Dedektor metin arasaydi, dogru yazilmis bir
    // yorum testi kirardi ve yorum silinirdi.
    expect(read('components/token/TradePanel.tsx')).toContain('@arcpad/db')
    expect(importsFrom(read('components/token/TradePanel.tsx'), '@arcpad/db')).toBe(false)
  })

  it('reaches the read model only through the type-only gate', () => {
    // `@/components/read/types` DEGERLERI `./result`'tan alir; `@arcpad/db`
    // oradan yalnizca `import type` ile gelir ve `verbatimModuleSyntax`
    // altinda calisma zamaninda tamamen silinir.
    const panel = read('components/token/TradePanel.tsx')
    expect(importsFrom(panel, '@/components/read/types')).toBe(true)
    expect(panel).toMatch(/import type \{[^}]*HexAddress[^}]*\} from '@\/components\/read\/types'/)
  })

  it('keeps the ONE gas margin in one file', () => {
    // ×3/2 yalnizca `gas.ts`'te. Ikinci bir kopya, biri degistiginde otekinin
    // sessizce eski kalmasi demek olurdu.
    const owners = PANEL_FILES.filter((relative) => /GAS_SAFETY_/.test(read(relative)))
    expect(owners).toEqual(['components/token/gas.ts'])
    // Ve `useGasReserve` yalnizca CAGIRIYOR, kendi carpanini yazmiyor.
    expect(read('components/token/useGasReserve.ts')).toContain('gasReserveFrom(')
    expect(read('components/token/useGasReserve.ts')).not.toMatch(/\*\s*3n|1\.5|\/\s*2n/)
  })
})
